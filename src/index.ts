/**
 * Email inbox Worker — Hermes replacement companion (cheap path).
 *
 * Worker: pre-classify + cheap LLM classify + 2FA/shipping detect
 * Email bot webhook: ONLY woken for To Respond drafts
 *
 * POST /triage     — classify a parsed mail; wake Email iff To Respond
 * POST /pubsub     — Gmail Pub/Sub Push receiver (OIDC + history drain: stubbed)
 * POST /spike/*    — legacy spike fixtures (kept for regression)
 * POST /suite      — spike suite
 * GET  /health
 */

import {
  classifyMail,
  COMPARE_MODELS,
  DEFAULT_CLASSIFIER_MODEL,
  probeClassifierModel,
} from "./lib/classify";
import { COMPARE_FIXTURES, type CompareFixture } from "./lib/compare-fixtures";
import { preClassify, type ParsedMail } from "./lib/preclassify";
import {
  clearPendingWake,
  flushPendingWakes,
  queuePendingWake,
  wakeEmailDraftIdempotent,
  type WakeResult,
} from "./lib/wake";
import { detect2fa } from "./detect/twofa";
import { detectShipping } from "./detect/shipping";
import { decodeGmailNotification, verifyPubSubOidc } from "./lib/pubsub";
import {
  drainHistory,
  ensureLabelId,
  getAccessToken,
  getMessage,
  getProfile,
  modifyMessageLabels,
  parseMessage,
  recipientRole,
  StaleCursor,
  watchMailbox,
  type GmailEnv,
} from "./lib/gmail";
import { labelName, skipInbox } from "./lib/labels";
import {
  buildAuthUrl,
  exchangeCode,
  htmlPage,
  oauthRedirectUri,
} from "./lib/oauth";
import {
  accountForEmail,
  listMailboxes,
  migrateLegacyIfNeeded,
  readCursor,
  readWatchExpiration,
  registerMailbox,
  resolveRefreshToken as resolveMailboxToken,
  writeCursor,
  writeWatchExpiration,
} from "./lib/mailboxes";

export interface Env {
  GROK_WEBHOOK_URL: string;
  GROK_WEBHOOK_KEY: string;
  AI: import("./lib/classify").AiBinding;
  CLASSIFIER_MODEL?: string;
  OWNER_EMAIL?: string;
  WORK_EMAIL?: string;
  ALLOW_INSECURE_PUSH?: string;
  PUBLIC_PUSH_URL?: string;
  // Gmail OAuth (multi-mailbox; refresh tokens live in KV)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string; // optional legacy single-mailbox secret
  GMAIL_PUBSUB_TOPIC?: string; // projects/…/topics/…
  // KV: per-mailbox tokens, cursors, watch expiration, mailboxes[]
  INBOX_STATE?: KVNamespace;
}

type ScenarioPayload = Record<string, unknown>;

const FIXTURES: Record<string, ScenarioPayload> = {
  classify_to_respond: {
    scenario: "classify",
    from: "Alex Kim <alex@example.com>",
    to: "matthall28@gmail.com",
    subject: "Quick question on the customs demo",
    body: "Hey Matthew — can you send me the latest Northbound deck before Thursday? Thanks, Alex",
  },
  classify_cc_not_directed: {
    scenario: "classify",
    from: "Jordan Lee <jordan@partner.com>",
    to: "sam@partner.com",
    cc: "matthall28@gmail.com",
    subject: "Need Sam to approve the invoice",
    body: "Sam — please approve invoice #4412 today. Matthew is only CC'd for visibility.",
  },
  classify_marketing: {
    scenario: "classify",
    from: "Deals <noreply@retail.example>",
    to: "matthall28@gmail.com",
    subject: "48-hour flash sale — 40% off",
    body: "Shop now. Click here to unsubscribe from future emails.",
    list_unsubscribe: true,
    one_click_unsubscribe: true,
  },
  draft: {
    scenario: "draft",
    account: "personal",
    from: "Alex Kim <alex@example.com>",
    subject: "Quick question on the customs demo",
    body: "Hey Matthew — can you send me the latest Northbound deck before Thursday?",
  },
  detect_2fa: {
    scenario: "detect_2fa",
    from: "Google <noreply@google.com>",
    subject: "Your verification code",
    body: "Your Google verification code is 847291. It expires in 10 minutes.",
  },
  detect_shipping: {
    scenario: "detect_shipping",
    from: "UPS <mcinfo@ups.com>",
    subject: "Your package is out for delivery",
    body: "Tracking number: 1Z999AA10123456784 is out for delivery today.",
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function asParsed(body: ScenarioPayload): ParsedMail {
  return {
    from: String(body.from || ""),
    to: String(body.to || ""),
    cc: String(body.cc || ""),
    subject: String(body.subject || ""),
    body: String(body.body || body.context || ""),
    snippet: String(body.snippet || ""),
    list_unsubscribe: Boolean(body.list_unsubscribe),
    one_click_unsubscribe: Boolean(body.one_click_unsubscribe),
    precedence: body.precedence ? String(body.precedence) : undefined,
  };
}

async function wakeGrokLegacy(env: Env, payload: ScenarioPayload) {
  const url = env.GROK_WEBHOOK_URL?.trim();
  const key = env.GROK_WEBHOOK_KEY?.trim();
  if (!url || !key) throw new Error("Missing GROK_WEBHOOK_URL or GROK_WEBHOOK_KEY");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      ...payload,
      spike: true,
      source: "cloudflare-worker-email-webhook-spike",
      at: new Date().toISOString(),
    }),
  });
  const text = await res.text();
  let runUuid: string | undefined;
  try {
    runUuid = JSON.parse(text)?.runUuid;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, body: text.slice(0, 2000), runUuid };
}

async function handleTriage(request: Request, env: Env): Promise<Response> {
  let body: ScenarioPayload;
  try {
    body = (await request.json()) as ScenarioPayload;
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const parsed = asParsed(body);
  const text = `${parsed.subject}\n${parsed.body}`;
  const twofa = detect2fa(text);
  const shipping = detectShipping(text);
  const ownerEmail = String(body.ownerEmail || body.owner || env.OWNER_EMAIL || "matthall28@gmail.com");
  const role = recipientRole(parsed, ownerEmail);
  let pre = preClassify(parsed);
  // Hermes recipient_role: owner only in Cc → FYI without LLM (and never wake Email)
  let classification;
  if (!pre && role === "cc") {
    classification = {
      category: "FYI" as const,
      directed_at_owner: false,
      reason: "recipient_role:cc",
      source: "preclassify" as const,
    };
  } else {
    classification = await classifyMail(parsed, env, pre, ownerEmail);
  }

  let wake: WakeResult | null = null;
  if (classification.category === "To Respond") {
    wake = await wakeEmailDraftIdempotent(env, {
      account: body.account === "work" ? "work" : "personal",
      category: "To Respond",
      threadId: body.threadId ? String(body.threadId) : undefined,
      messageId: body.messageId ? String(body.messageId) : undefined,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      body: parsed.body,
      voice_notes: body.voice_notes ? String(body.voice_notes) : undefined,
      lessons: body.lessons,
      gold_examples: body.gold_examples,
    });
  }

  const emailWoken = Boolean(wake?.ok) && !wake?.skipped;
  const wakeSkipped = Boolean(wake?.skipped);
  const wakeFailed = classification.category === "To Respond" && !wake?.ok;
  return json({
    ok: true,
    classification,
    label: labelName(classification.category),
    skip_inbox: skipInbox(classification.category),
    detects: { twofa, shipping },
    email_woken: emailWoken,
    wake_skipped: wakeSkipped || undefined,
    wake_failed: wakeFailed || undefined,
    wake,
    note: wakeFailed
      ? "To Respond classified but Email wake failed — no Gmail write from triage."
      : wakeSkipped
        ? "Already woken recently (KV idempotency) — skipped duplicate draft wake."
        : classification.category === "To Respond"
          ? "Woke Email for unsent draft only."
          : "No Email wake — Worker handled cheap path.",
  });
}


/* gmailEnvOrThrow replaced below as async */



async function resolveRefreshToken(
  env: Env,
  email?: string | null,
): Promise<{ token: string | null; email: string | null; source: string }> {
  return resolveMailboxToken(env.INBOX_STATE, email, env.GMAIL_REFRESH_TOKEN);
}

async function gmailEnvOrThrow(env: Env, email?: string | null): Promise<GmailEnv & { email: string | null }> {
  const client_id = env.GOOGLE_CLIENT_ID?.trim();
  const client_secret = env.GOOGLE_CLIENT_SECRET?.trim();
  const resolved = await resolveRefreshToken(env, email);
  if (!client_id || !client_secret || !resolved.token) {
    throw new Error(
      `Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / refresh token for ${email || "default mailbox"} (KV mailbox:<email>:refresh_token or legacy oauth:refresh_token). Visit /oauth/start`,
    );
  }
  return {
    GOOGLE_CLIENT_ID: client_id,
    GOOGLE_CLIENT_SECRET: client_secret,
    GMAIL_REFRESH_TOKEN: resolved.token,
    email: resolved.email,
  };
}

async function handleOAuthStart(request: Request, env: Env): Promise<Response> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return htmlPage(
      "OAuth not configured",
      "<p>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> Worker secrets first.</p>",
    );
  }
  const url = new URL(request.url);
  const redirectUri = oauthRedirectUri(url.origin);
  const state = crypto.randomUUID();
  // Optional ?account= hint (personal|work|email) stored with state for callback UX only.
  const accountHint = (url.searchParams.get("account") || "").trim().slice(0, 200);
  if (env.INBOX_STATE) {
    await env.INBOX_STATE.put(
      `oauth:state:${state}`,
      accountHint || "1",
      { expirationTtl: 600 },
    );
  }
  const authUrl = buildAuthUrl({ clientId, redirectUri, state });
  return Response.redirect(authUrl, 302);
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) {
    return htmlPage("OAuth error", `<p><code>${err}</code></p><p>${url.searchParams.get("error_description") || ""}</p>`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlPage("OAuth error", "<p>Missing code/state.</p>");
  }
  if (env.INBOX_STATE) {
    const ok = await env.INBOX_STATE.get(`oauth:state:${state}`);
    if (!ok) {
      return htmlPage("OAuth error", "<p>Invalid or expired state. <a href=\"/oauth/start\">Try again</a>.</p>");
    }
    await env.INBOX_STATE.delete(`oauth:state:${state}`);
  }
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return htmlPage("OAuth error", "<p>Client secrets missing on Worker.</p>");
  }
  const redirectUri = oauthRedirectUri(url.origin);
  try {
    const tokens = await exchangeCode({ clientId, clientSecret, redirectUri, code });
    if (!tokens.refresh_token) {
      return htmlPage(
        "Connected, but no refresh token",
        "<p>Google did not return a <code>refresh_token</code>. Revoke prior access at <a href=\"https://myaccount.google.com/permissions\">Google Account permissions</a>, then <a href=\"/oauth/start\">retry</a> (we request <code>prompt=consent</code>).</p>",
      );
    }
    // Identify mailbox then register under multi-account KV scheme
    let email = "";
    let historyId = "";
    try {
      const access = tokens.access_token;
      if (access) {
        const pr = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { authorization: `Bearer ${access}` },
        });
        if (pr.ok) {
          const pj = (await pr.json()) as { emailAddress?: string; historyId?: string };
          email = pj.emailAddress || "";
          historyId = pj.historyId ? String(pj.historyId) : "";
        }
      }
    } catch {
      /* ignore */
    }
    if (!email) {
      return htmlPage(
        "Connected, but email unknown",
        "<p>Refresh token received but profile email missing. Retry <a href=\"/oauth/start\">/oauth/start</a>.</p>",
      );
    }
    if (env.INBOX_STATE) {
      await registerMailbox(env.INBOX_STATE, email, tokens.refresh_token, {
        cursor: historyId || undefined,
        scope: tokens.scope ? String(tokens.scope) : undefined,
      });
    }
    const boxes = env.INBOX_STATE ? await listMailboxes(env.INBOX_STATE) : [email];
    const acct = accountForEmail(email, env);
    return htmlPage(
      "Gmail connected",
      `<p>Refresh token stored under <code>mailbox:${email.toLowerCase()}:refresh_token</code>.</p>
       <p>Mailbox: <code>${email}</code> (wake account: <code>${acct}</code>)</p>
       <p>Registered mailboxes (${boxes.length}): <code>${boxes.join(", ")}</code></p>
       <p>Next: <code>POST /watch</code> (or wait for daily cron). Add another account via <a href=\"/oauth/start\">/oauth/start</a>.</p>
       <p><a href="/health">/health</a></p>`,
    );
  } catch (e) {
    return htmlPage("OAuth exchange failed", `<pre>${e instanceof Error ? e.message : String(e)}</pre>`);
  }
}


async function processInboxMessage(
  env: Env,
  accessToken: string,
  messageId: string,
  ownerEmail: string,
  account: "personal" | "work" = "personal",
): Promise<Record<string, unknown>> {
  const raw = await getMessage(accessToken, messageId, "full");
  const parsed = parseMessage(raw);
  const labels = parsed.label_ids || [];
  if (labels.includes("TRASH") || labels.includes("SPAM")) {
    return { messageId, skipped: "trash-or-spam", subject: parsed.subject };
  }
  if (labels.includes("SENT") && !labels.includes("INBOX")) {
    return { messageId, skipped: "sent-only", subject: parsed.subject };
  }
  // Do NOT require INBOX — Gmail category tabs / filters often omit it on history rows.
  const textBody = `${parsed.subject || ""}\n${parsed.body || ""}`;
  const twofa = detect2fa(textBody);
  const shipping = detectShipping(textBody);
  const role = recipientRole(parsed, ownerEmail);
  const pre = preClassify(parsed);
  let classification;
  if (!pre && role === "cc") {
    classification = {
      category: "FYI" as const,
      directed_at_owner: false,
      reason: "recipient_role:cc",
      source: "preclassify" as const,
    };
  } else {
    classification = await classifyMail(parsed, env, pre, ownerEmail);
  }

  let wake: WakeResult | null = null;
  let labelDeferred = false;
  let wakeFailed = false;

  if (classification.category === "To Respond") {
    // Wake FIRST (idempotent + retries). Only apply "1: To Respond" if wake.ok
    // (including already-woken skips — those still allow labeling).
    wake = await wakeEmailDraftIdempotent(env, {
      account,
      category: "To Respond",
      threadId: parsed.thread_id,
      messageId: parsed.id,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      body: parsed.body,
    });
    if (!wake.ok) {
      wakeFailed = true;
      labelDeferred = true;
      if (env.INBOX_STATE) {
        await queuePendingWake(env.INBOX_STATE, {
          messageId,
          threadId: parsed.thread_id,
          from: parsed.from,
          to: parsed.to,
          subject: parsed.subject,
          body: parsed.body,
          account,
          queuedAt: new Date().toISOString(),
          lastError: wake.error || `status=${wake.status}`,
        });
      }
      return {
        messageId,
        threadId: parsed.thread_id,
        subject: parsed.subject,
        classification,
        label: labelName("To Respond"),
        skip_inbox: false,
        labels_applied: { deferred: true },
        label_deferred: true,
        wake_failed: true,
        detects: { twofa, shipping },
        email_woken: false,
        account,
        wake,
        status: "wake_failed",
      };
    }
    // Successful wake or idempotent skip — clear any prior pending entry
    if (env.INBOX_STATE) {
      await clearPendingWake(env.INBOX_STATE, messageId);
    }
  }

  const label = labelName(classification.category);
  const shouldSkipInbox = skipInbox(classification.category);
  let labelsApplied: {
    add?: string;
    removeInbox?: boolean;
    deferred?: boolean;
    error?: string;
  } = {};
  try {
    const cache = new Map<string, string>();
    const labelId = await ensureLabelId(accessToken, label, cache);
    const remove: string[] = [];
    if (shouldSkipInbox && labels.includes("INBOX")) remove.push("INBOX");
    // Apply category label (To Respond only reached here if wake.ok).
    // Archive Marketing/Notification/etc. Do NOT archive To Respond.
    await modifyMessageLabels(accessToken, messageId, [labelId], remove);
    labelsApplied = { add: label, removeInbox: remove.includes("INBOX") };
  } catch (err) {
    labelsApplied = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    messageId,
    threadId: parsed.thread_id,
    subject: parsed.subject,
    classification,
    label,
    skip_inbox: shouldSkipInbox,
    labels_applied: labelsApplied,
    label_deferred: labelDeferred || undefined,
    wake_failed: wakeFailed || undefined,
    detects: { twofa, shipping },
    email_woken: Boolean(wake?.ok) && !wake?.skipped,
    wake_skipped: wake?.skipped || undefined,
    account,
    wake,
  };
}

/** Drain one mailbox from its stored cursor (or optional startHistoryId). */
async function drainOneMailbox(
  env: Env,
  email: string,
  startHistoryId?: string | null,
): Promise<Record<string, unknown>> {
  const gmail = await gmailEnvOrThrow(env, email);
  const accessToken = await getAccessToken(gmail);
  const profile = await getProfile(accessToken);
  const ownerEmail = profile.emailAddress || email;
  const acct = accountForEmail(ownerEmail, env);

  const start =
    startHistoryId ||
    (await readCursor(env.INBOX_STATE, ownerEmail)) ||
    profile.historyId;
  if (!start) {
    return { ok: false, email: ownerEmail, error: "no startHistoryId" };
  }

  let drained;
  try {
    drained = await drainHistory(accessToken, start);
  } catch (err) {
    if (err instanceof StaleCursor) {
      await writeCursor(env.INBOX_STATE, ownerEmail, profile.historyId);
      return {
        ok: false,
        email: ownerEmail,
        stale: true,
        resetCursor: profile.historyId,
        error: "cursor stale; reset to profile historyId — next push will catch new mail only",
      };
    }
    throw err;
  }

  const results = [];
  for (const mid of drained.inboxMessageIds) {
    try {
      results.push(await processInboxMessage(env, accessToken, mid, ownerEmail, acct));
    } catch (err) {
      results.push({
        messageId: mid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await writeCursor(env.INBOX_STATE, ownerEmail, drained.newHistoryId);
  const pending_wake_retries = await flushPendingWakes(env, 5);
  return {
    ok: true,
    email: ownerEmail,
    account: acct,
    startHistoryId: start,
    newHistoryId: drained.newHistoryId,
    inbox: drained.inboxMessageIds.length,
    sent: drained.sentMessageIds.length,
    results,
    pending_wake_retries,
  };
}

async function handleDrain(request: Request, env: Env): Promise<Response> {
  try {
    if (env.INBOX_STATE) await migrateLegacyIfNeeded(env.INBOX_STATE);

    let body: { startHistoryId?: string; email?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    const wantEmail = body.email?.trim().toLowerCase();
    if (wantEmail) {
      const one = await drainOneMailbox(env, wantEmail, body.startHistoryId || null);
      const status = one.ok ? 200 : one.stale ? 409 : 500;
      return json(one, status);
    }

    // No email → drain all registered mailboxes (or legacy single).
    const boxes = env.INBOX_STATE
      ? await listMailboxes(env.INBOX_STATE)
      : [];
    if (!boxes.length) {
      // Fall back to whatever token we can resolve
      const resolved = await resolveRefreshToken(env);
      if (!resolved.token) {
        return json({ ok: false, error: "no mailboxes; visit /oauth/start" }, 400);
      }
      const email = resolved.email || env.OWNER_EMAIL?.trim() || "matthall28@gmail.com";
      const one = await drainOneMailbox(env, email, body.startHistoryId || null);
      return json(one, one.ok ? 200 : one.stale ? 409 : 500);
    }

    const results = [];
    for (const email of boxes) {
      try {
        results.push(await drainOneMailbox(env, email, body.startHistoryId || null));
      } catch (err) {
        results.push({
          ok: false,
          email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return json({
      ok: results.every((r) => r.ok),
      mailboxes: boxes,
      results,
    });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}


async function handleDebugHistory(request: Request, env: Env): Promise<Response> {
  try {
    let body: { startHistoryId?: string; email?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    const gmail = await gmailEnvOrThrow(env, body.email);
    const accessToken = await getAccessToken(gmail);
    const start = body.startHistoryId || "1";
    const params = new URLSearchParams({ startHistoryId: start, historyTypes: "messageAdded" });
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const text = await res.text();
    return json({ status: res.status, email: gmail.email, body: JSON.parse(text) });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * Call users.watch for one mailbox. Stores watch expiration separately.
 * Does NOT advance cursor past existing drain point — only seeds cursor if missing.
 */
async function renewWatchForMailbox(
  env: Env,
  email: string,
  topic: string,
): Promise<Record<string, unknown>> {
  const gmail = await gmailEnvOrThrow(env, email);
  const accessToken = await getAccessToken(gmail);
  const profile = await getProfile(accessToken);
  const ownerEmail = profile.emailAddress || email;
  const watched = await watchMailbox(accessToken, topic);

  await writeWatchExpiration(env.INBOX_STATE, ownerEmail, watched.expiration);

  // Seed cursor only if we have none; never jump past unprocessed mail on renew.
  const cursorWrite = await writeCursor(env.INBOX_STATE, ownerEmail, watched.historyId, {
    onlyIfMissing: true,
  });

  const existingCursor = await readCursor(env.INBOX_STATE, ownerEmail);
  return {
    ok: true,
    email: ownerEmail,
    historyId: watched.historyId,
    expiration: watched.expiration,
    cursor: existingCursor,
    cursorSeeded: cursorWrite.wrote,
    topic,
  };
}

async function renewAllWatches(env: Env): Promise<{
  ok: boolean;
  topic?: string;
  results: Array<Record<string, unknown>>;
}> {
  const topic = env.GMAIL_PUBSUB_TOPIC?.trim();
  if (!topic) {
    return { ok: false, results: [{ ok: false, error: "Missing GMAIL_PUBSUB_TOPIC" }] };
  }
  if (env.INBOX_STATE) await migrateLegacyIfNeeded(env.INBOX_STATE);
  const boxes = env.INBOX_STATE ? await listMailboxes(env.INBOX_STATE) : [];
  if (!boxes.length) {
    const resolved = await resolveRefreshToken(env);
    if (!resolved.token) {
      return { ok: false, topic, results: [{ ok: false, error: "no mailboxes" }] };
    }
    const email = resolved.email || env.OWNER_EMAIL?.trim();
    if (!email) {
      return { ok: false, topic, results: [{ ok: false, error: "no mailbox email" }] };
    }
    try {
      const one = await renewWatchForMailbox(env, email, topic);
      return { ok: true, topic, results: [one] };
    } catch (err) {
      return {
        ok: false,
        topic,
        results: [{ ok: false, email, error: err instanceof Error ? err.message : String(err) }],
      };
    }
  }

  const results: Array<Record<string, unknown>> = [];
  for (const email of boxes) {
    try {
      results.push(await renewWatchForMailbox(env, email, topic));
    } catch (err) {
      results.push({
        ok: false,
        email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: results.every((r) => r.ok), topic, results };
}

async function handleWatch(request: Request, env: Env): Promise<Response> {
  try {
    let body: { email?: string } = {};
    try {
      if (request.headers.get("content-type")?.includes("application/json")) {
        const raw = await request.text();
        if (raw.trim()) body = JSON.parse(raw) as typeof body;
      }
    } catch {
      body = {};
    }
    const topic = env.GMAIL_PUBSUB_TOPIC?.trim();
    if (!topic) return json({ ok: false, error: "Missing GMAIL_PUBSUB_TOPIC" }, 400);

    if (body.email?.trim()) {
      const one = await renewWatchForMailbox(env, body.email.trim(), topic);
      return json(one);
    }
    const all = await renewAllWatches(env);
    return json(all, all.ok ? 200 : 500);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handlePubSub(request: Request, env: Env): Promise<Response> {
  const audience = env.PUBLIC_PUSH_URL || new URL(request.url).origin + "/pubsub";
  const auth = request.headers.get("authorization");
  const insecure = env.ALLOW_INSECURE_PUSH === "1";
  let verified = false;
  try {
    verified = await verifyPubSubOidc(auth, audience);
  } catch {
    verified = false;
  }
  if (!verified && !insecure) {
    return json({
      ok: false,
      error: "OIDC verification failed",
      audience,
    }, 401);
  }

  let notification = null;
  try {
    const pushBody = (await request.json()) as { message?: { data?: string } };
    if (pushBody.message?.data) {
      notification = decodeGmailNotification(pushBody.message.data);
    }
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }

  // Pub/Sub payload includes emailAddress — drain THAT mailbox.
  try {
    if (env.INBOX_STATE) await migrateLegacyIfNeeded(env.INBOX_STATE);

    const notifyEmail = notification?.emailAddress?.trim().toLowerCase() || null;
    const resolved = await resolveRefreshToken(env, notifyEmail);
    if (!resolved.token) {
      return json({
        ok: true,
        ack: true,
        verified,
        insecure,
        notification,
        drained: false,
        note: "Visit /oauth/start (or set GMAIL_REFRESH_TOKEN) to enable history drain",
      });
    }

    const mailboxEmail = notifyEmail || resolved.email;
    if (!mailboxEmail) {
      return json({
        ok: true,
        ack: true,
        verified,
        notification,
        drained: false,
        note: "notification missing emailAddress and no registered mailbox",
      });
    }

    const gmail = await gmailEnvOrThrow(env, mailboxEmail);
    const accessToken = await getAccessToken(gmail);
    const profile = await getProfile(accessToken);
    const ownerEmail = profile.emailAddress || mailboxEmail;
    const acct = accountForEmail(ownerEmail, env);

    // Important: Gmail notify historyId is the NEW id; drain from stored cursor
    const cursor = (await readCursor(env.INBOX_STATE, ownerEmail)) || profile.historyId;
    let drained;
    try {
      drained = await drainHistory(accessToken, cursor);
    } catch (err) {
      if (err instanceof StaleCursor) {
        await writeCursor(env.INBOX_STATE, ownerEmail, profile.historyId);
        return json({
          ok: true,
          ack: true,
          stale: true,
          email: ownerEmail,
          resetCursor: profile.historyId,
        });
      }
      throw err;
    }

    const results = [];
    for (const mid of drained.inboxMessageIds) {
      try {
        results.push(await processInboxMessage(env, accessToken, mid, ownerEmail, acct));
      } catch (err) {
        results.push({
          messageId: mid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await writeCursor(env.INBOX_STATE, ownerEmail, drained.newHistoryId);
    const pending_wake_retries = await flushPendingWakes(env, 5);
    return json({
      ok: true,
      ack: true,
      verified,
      notification,
      email: ownerEmail,
      account: acct,
      startHistoryId: cursor,
      newHistoryId: drained.newHistoryId,
      results,
      pending_wake_retries,
    });
  } catch (err) {
    // Return 200 sparingly — Pub/Sub retries on non-2xx. For auth/config errors use 500.
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}



async function handleClassifyCompare(request: Request, env: Env): Promise<Response> {
  if (!env.AI) {
    return json({ ok: false, error: "Workers AI binding missing" }, 500);
  }
  let body: {
    fixtures?: CompareFixture[];
    models?: string[];
    ownerEmail?: string;
  } = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const raw = await request.text();
      if (raw.trim()) body = JSON.parse(raw) as typeof body;
    }
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const models =
    Array.isArray(body.models) && body.models.length > 0
      ? body.models
      : [...COMPARE_MODELS];
  const fixtures =
    Array.isArray(body.fixtures) && body.fixtures.length > 0
      ? body.fixtures
      : COMPARE_FIXTURES;
  const ownerDefault =
    body.ownerEmail?.trim() || env.OWNER_EMAIL?.trim() || "matthall28@gmail.com";

  const results: Array<Record<string, unknown>> = [];
  for (const fix of fixtures) {
    const owner = fix.ownerEmail || ownerDefault;
    const perModel: Record<string, unknown> = {};
    for (const model of models) {
      perModel[model] = await probeClassifierModel(
        fix.mail,
        env.AI,
        model,
        owner,
        fix.expected,
      );
    }
    results.push({
      id: fix.id,
      expected: fix.expected ?? null,
      notes: fix.notes,
      models: perModel,
    });
  }

  const summary: Record<string, {
    n: number;
    json_ok: number;
    json_rate: number;
    expected_hits: number;
    expected_n: number;
    label_rate: number | null;
    avg_latency_ms: number;
  }> = {};
  for (const model of models) {
    let n = 0;
    let jsonOk = 0;
    let expectedHits = 0;
    let expectedN = 0;
    let latSum = 0;
    for (const row of results) {
      const m = (row.models as Record<string, Record<string, unknown>>)[model];
      if (!m) continue;
      n++;
      if (m.json_ok) jsonOk++;
      latSum += Number(m.latency_ms || 0);
      if (row.expected) {
        expectedN++;
        if (m.expected_match) expectedHits++;
      }
    }
    summary[model] = {
      n,
      json_ok: jsonOk,
      json_rate: n ? jsonOk / n : 0,
      expected_hits: expectedHits,
      expected_n: expectedN,
      label_rate: expectedN ? expectedHits / expectedN : null,
      avg_latency_ms: n ? Math.round(latSum / n) : 0,
    };
  }

  return json({
    ok: true,
    models,
    fixture_count: fixtures.length,
    summary,
    results,
  });
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const result = await renewAllWatches(env);
    console.log("cron renew-watches", JSON.stringify(result));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
      if (env.INBOX_STATE) await migrateLegacyIfNeeded(env.INBOX_STATE);
      const boxes = env.INBOX_STATE ? await listMailboxes(env.INBOX_STATE) : [];
      const watchMeta: Record<string, string | null> = {};
      for (const e of boxes) {
        watchMeta[e] = await readWatchExpiration(env.INBOX_STATE, e);
      }
      return json({
        ok: true,
        service: "email-inbox-worker",
        architecture: "worker-cheap-path + Email drafts-only",
        endpoints: [
          "GET /health",
          "POST /triage",
          "GET /oauth/start",
          "GET /oauth/callback",
          "POST /pubsub",
          "POST /drain",
          "POST /watch",
          "POST /cron/renew-watches",
          "POST /debug/classify-compare",
          "POST /spike",
          "POST /spike/:fixture",
          "POST /suite",
        ],
        classifier_model: env.CLASSIFIER_MODEL || DEFAULT_CLASSIFIER_MODEL,
        mailboxes: boxes,
        watch_expiration: watchMeta,
        cron: "0 14 * * *",
        fixtures: Object.keys(FIXTURES),
      });
    }

    if (request.method === "POST" && pathname === "/triage") {
      try {
        return await handleTriage(request, env);
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    if (request.method === "GET" && pathname === "/oauth/start") {
      return handleOAuthStart(request, env);
    }

    if (request.method === "GET" && pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    if (request.method === "POST" && pathname === "/pubsub") {
      return handlePubSub(request, env);
    }

    if (request.method === "POST" && pathname === "/drain") {
      return handleDrain(request, env);
    }

    if (request.method === "POST" && pathname === "/watch") {
      return handleWatch(request, env);
    }

    if (request.method === "POST" && pathname === "/cron/renew-watches") {
      // Spike debug route — same logic as scheduled cron.
      try {
        const result = await renewAllWatches(env);
        return json(result, result.ok ? 200 : 500);
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/debug/history") {
      return handleDebugHistory(request, env);
    }

    if (request.method === "POST" && pathname === "/debug/classify-compare") {
      try {
        return await handleClassifyCompare(request, env);
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    if (request.method === "GET" && pathname === "/fixtures") {
      return json({ fixtures: Object.keys(FIXTURES) });
    }

    const fixtureMatch = pathname.match(/^\/spike\/([a-z0-9_]+)$/);
    if (request.method === "POST" && fixtureMatch) {
      const name = fixtureMatch[1];
      const base = FIXTURES[name];
      if (!base) return json({ ok: false, error: `unknown fixture ${name}` }, 404);
      try {
        const result = await wakeGrokLegacy(env, { ...base, fixture: name });
        return json({ ok: result.ok, fixture: name, grok: result }, result.ok ? 200 : 502);
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/spike") {
      let body: ScenarioPayload = {};
      try {
        if (request.headers.get("content-type")?.includes("application/json")) {
          body = (await request.json()) as ScenarioPayload;
        }
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }
      const fixtureName = typeof body.fixture === "string" ? body.fixture : undefined;
      const base = fixtureName && FIXTURES[fixtureName] ? FIXTURES[fixtureName] : {};
      const payload = {
        scenario: "draft",
        subject: "Email spike: Worker → Grok wake",
        account: "personal",
        ...base,
        ...body,
      };
      try {
        const result = await wakeGrokLegacy(env, payload);
        return json({ ok: result.ok, forwarded: payload, grok: result }, result.ok ? 200 : 502);
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/suite") {
      let only: string[] | null = null;
      try {
        if (request.headers.get("content-type")?.includes("application/json")) {
          const b = (await request.json()) as { only?: string[] };
          if (Array.isArray(b.only)) only = b.only;
        }
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }
      const names = only ?? Object.keys(FIXTURES);
      const results: Array<Record<string, unknown>> = [];
      for (const name of names) {
        const base = FIXTURES[name];
        if (!base) {
          results.push({ fixture: name, ok: false, error: "unknown" });
          continue;
        }
        try {
          const result = await wakeGrokLegacy(env, { ...base, fixture: name });
          results.push({
            fixture: name,
            scenario: base.scenario,
            ok: result.ok,
            runUuid: result.runUuid,
            status: result.status,
          });
          await new Promise((r) => setTimeout(r, 250));
        } catch (err) {
          results.push({
            fixture: name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return json({ ok: results.every((r) => r.ok), count: results.length, results });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
