/** Email classify via OpenRouter Decisions API + TypeSafe Jev when preClassify returns null. */
import type { InboundCategory } from "./labels";
import { INBOUND_CATEGORIES } from "./labels";
import type { ParsedMail } from "./preclassify";
import {
  hasUnsubscribeSignal,
  isAutomatedSender,
  looksLikePolicyBroadcast,
  looksLikeTransactionalCta,
} from "./preclassify";

/** @deprecated Workers AI binding — kept optional for transitional deploys. */
export type AiBinding = {
  run: (
    model: string,
    inputs: Record<string, unknown>,
  ) => Promise<unknown>;
};

export const DEFAULT_CLASSIFIER_MODEL = "~typesafe/jev-latest";
/** @deprecated Workers AI models — no longer used for production classify. */
export const GLM_CLASSIFIER_MODEL = DEFAULT_CLASSIFIER_MODEL;
export const COMPARE_MODELS = [DEFAULT_CLASSIFIER_MODEL] as const;

const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/v1/api/alpha/decisions";
const OPENROUTER_DECISIONS_URL_ALT = "https://openrouter.ai/api/alpha/decisions";

/** Slug keys for Jev Choice (no spaces) → display category. */
const CATEGORY_SLUGS: Record<string, InboundCategory> = {
  to_respond: "To Respond",
  fyi: "FYI",
  comment: "Comment",
  notification: "Notification",
  meeting_update: "Meeting Update",
  marketing: "Marketing",
};

const CATEGORY_CRITERIA: Record<string, string> = {
  to_respond:
    "A real person expects an EMAIL REPLY or personal action from the mailbox owner. Not in-app buttons, ship/renew CTAs, or ToS broadcasts.",
  fyi:
    "Informational mail addressed to the owner that needs no reply — status updates, announcements, or the owner is only Cc'd while someone else is To.",
  comment:
    "Comment or mention activity on a shared doc/PR/thread where no direct email reply is expected.",
  notification:
    "Automated system/app/transactional alerts: orders, renewals, receipts, shipping, account/security, Terms of Service / privacy broadcasts — no email reply expected.",
  meeting_update:
    "Calendar invitations, reschedules, cancellations, or RSVPs.",
  marketing:
    "Promotional or bulk mail: newsletters, product announcements, sales outreach, cold pitches.",
};

export type ClassifyResult = {
  category: InboundCategory;
  directed_at_owner: boolean;
  reason: string;
  source: "preclassify" | "llm" | "jev" | "fallback";
  /** Model that produced the result (when source=jev/llm). */
  model?: string;
  confidence?: number;
};

export type ClassifyEnv = {
  OPENROUTER_API_KEY?: string;
  CLASSIFIER_MODEL?: string;
  OWNER_EMAIL?: string;
  /** @deprecated unused when OpenRouter is configured */
  AI?: AiBinding;
};

export function buildClassifyState(
  parsed: ParsedMail,
  ownerEmail: string,
): Record<string, unknown> {
  const notes: string[] = [];
  if (hasUnsubscribeSignal(parsed)) {
    notes.push(
      "Unsubscribe signals present — weigh toward Marketing if promotional; boilerplate reply-to-this-email in bulk is NOT To Respond.",
    );
  }
  if (
    isAutomatedSender(parsed.from) ||
    looksLikeTransactionalCta(parsed) ||
    looksLikePolicyBroadcast(parsed)
  ) {
    notes.push(
      "Automated/transactional sender, CTA (ship/renew/confirm in-app), or Terms/privacy legal broadcast — default Notification, not To Respond, unless a human clearly asks for an email reply.",
    );
  }
  const owner = ownerEmail.toLowerCase();
  const to = (parsed.to || "").toLowerCase();
  const cc = (parsed.cc || "").toLowerCase();
  if (owner && cc.includes(owner) && to && !to.includes(owner)) {
    notes.push(
      "Owner appears in Cc but not To — default FYI unless body clearly asks the owner by name for a reply.",
    );
  }
  return {
    mailbox_owner: ownerEmail,
    from: parsed.from || "",
    to: parsed.to || "",
    cc: parsed.cc || "",
    subject: parsed.subject || "",
    body: (parsed.body || parsed.snippet || "").slice(0, 4000),
    notes,
  };
}

/** @deprecated alias — bake-off / older call sites */
export function buildClassifyUserContent(
  parsed: ParsedMail,
  ownerEmail: string,
): string {
  return JSON.stringify(buildClassifyState(parsed, ownerEmail));
}

function coerceCategoryFromSlug(raw: string): InboundCategory {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (CATEGORY_SLUGS[key]) return CATEGORY_SLUGS[key];
  const hit = INBOUND_CATEGORIES.find((c) => c.toLowerCase() === raw.trim().toLowerCase());
  return hit ?? "FYI";
}

function coerceCategory(raw: string): InboundCategory {
  return coerceCategoryFromSlug(raw);
}

/** When OpenRouter fails, prefer waking Email for clear direct asks over silent FYI. */
function fallbackOnAiFailure(
  parsed: ParsedMail,
  ownerEmail: string,
  err: unknown,
): ClassifyResult {
  const owner = ownerEmail.toLowerCase();
  const to = (parsed.to || "").toLowerCase();
  const cc = (parsed.cc || "").toLowerCase();
  const direct = Boolean(owner && to.includes(owner));
  const onlyCc = Boolean(owner && cc.includes(owner) && to && !to.includes(owner));
  const blob = `${parsed.subject || ""}\n${parsed.body || parsed.snippet || ""}`;
  const looksLikeAsk =
    /\?/.test(blob) ||
    /\b(can you|could you|please|let me know|reply|respond|what(?:'s| is) your)\b/i.test(
      blob,
    );
  const automated =
    isAutomatedSender(parsed.from) ||
    looksLikeTransactionalCta(parsed) ||
    looksLikePolicyBroadcast(parsed);
  const reason = `openrouter failed: ${err instanceof Error ? err.message : String(err)}`;
  if (automated) {
    return {
      category: "Notification",
      directed_at_owner: false,
      reason: `${reason}; heuristic:automated-or-cta`,
      source: "fallback",
    };
  }
  if (direct && !onlyCc && looksLikeAsk) {
    return {
      category: "To Respond",
      directed_at_owner: true,
      reason: `${reason}; heuristic:direct-ask`,
      source: "fallback",
    };
  }
  return {
    category: "FYI",
    directed_at_owner: false,
    reason,
    source: "fallback",
  };
}

function applyOwnerGuards(
  parsed: ParsedMail,
  owner: string,
  category: InboundCategory,
  directed: boolean,
  reason: string,
): { category: InboundCategory; directed: boolean } {
  const to = (parsed.to || "").toLowerCase();
  const cc = (parsed.cc || "").toLowerCase();
  const o = owner.toLowerCase();
  let cat = category;
  let dir = directed;
  if (
    cat === "FYI" &&
    o &&
    to.includes(o) &&
    !(cc.includes(o) && !to.includes(o)) &&
    /\b(cc|carbon)\b/i.test(reason)
  ) {
    cat = "To Respond";
    dir = true;
  }
  if (
    cat === "To Respond" &&
    (isAutomatedSender(parsed.from) ||
      looksLikeTransactionalCta(parsed) ||
      looksLikePolicyBroadcast(parsed))
  ) {
    cat = "Notification";
    dir = false;
  }
  return { category: cat, directed: dir };
}

function buildQuestions() {
  return {
    category: {
      type: "choice" as const,
      instructions:
        "Pick the single best inbox triage category for this inbound email for the mailbox_owner. To Respond only when a human individually wants an email reply. In-app CTAs, Terms/privacy broadcasts, noreply/notify senders → notification. Owner only on Cc → usually fyi.",
      criteria: CATEGORY_CRITERIA,
    },
    directed_at_owner: {
      type: "noul" as const,
      instructions:
        "Is a human asking the mailbox_owner for an email reply or personal offline action (not an in-app button click)?",
      criteria: {
        true: "A person expects a reply or action from the mailbox owner",
        false: "No personal email reply expected (automated, FYI, marketing, etc.)",
      },
    },
  };
}

async function postDecisions(
  apiKey: string,
  model: string,
  state: Record<string, unknown>,
): Promise<{ answers: Record<string, unknown>; model: string }> {
  const body = JSON.stringify({
    model,
    state,
    questions: buildQuestions(),
    provider: { allow_fallbacks: true },
  });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/Northbound-Run/email-inbox-worker",
    "X-OpenRouter-Title": "email-inbox-worker",
  };

  let res = await fetch(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    headers,
    body,
  });
  if (res.status === 404) {
    res = await fetch(OPENROUTER_DECISIONS_URL_ALT, {
      method: "POST",
      headers,
      body,
    });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`openrouter decisions ${res.status}: ${text.slice(0, 400)}`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`openrouter decisions bad JSON: ${text.slice(0, 200)}`);
  }
  const answers = json.answers;
  if (!answers || typeof answers !== "object") {
    throw new Error(`openrouter decisions missing answers: ${text.slice(0, 300)}`);
  }
  return {
    answers: answers as Record<string, unknown>,
    model: String(json.model || model),
  };
}

function parseAnswers(
  answers: Record<string, unknown>,
  parsed: ParsedMail,
  owner: string,
  model: string,
): ClassifyResult {
  const catAns = answers.category as Record<string, unknown> | undefined;
  const dirAns = answers.directed_at_owner as Record<string, unknown> | undefined;
  const slug = String(catAns?.choice || "fyi");
  let category = coerceCategory(slug);
  const noul = typeof dirAns?.noul === "number" ? dirAns.noul : null;
  let directed = noul != null ? noul >= 0.5 : category === "To Respond";
  const conf =
    typeof catAns?.confidence === "number" ? (catAns.confidence as number) : undefined;
  let reason = `jev:${slug}`;
  if (noul != null) reason += `; directed_noul=${noul.toFixed(3)}`;
  if (conf != null) reason += `; conf=${conf.toFixed(3)}`;

  const guarded = applyOwnerGuards(parsed, owner, category, directed, reason);
  return {
    category: guarded.category,
    directed_at_owner: guarded.directed,
    reason,
    source: "jev",
    model,
    confidence: conf,
  };
}

export type RawClassifyProbe = {
  model: string;
  raw_text: string;
  raw_text_truncated: string;
  json_ok: boolean;
  json_error?: string;
  category?: InboundCategory;
  directed_at_owner?: boolean;
  reason?: string;
  latency_ms: number;
  expected_match?: boolean | null;
};

/** Probe OpenRouter Jev for bake-off / debug. */
export async function probeClassifierModel(
  parsed: ParsedMail,
  env: ClassifyEnv,
  model: string,
  ownerEmail: string,
  expected?: InboundCategory,
): Promise<RawClassifyProbe> {
  const owner = (ownerEmail || "").trim() || env.OWNER_EMAIL?.trim() || "";
  const state = buildClassifyState(parsed, owner);
  const t0 = Date.now();
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    return {
      model,
      raw_text: "",
      raw_text_truncated: "[missing OPENROUTER_API_KEY]",
      json_ok: false,
      json_error: "missing OPENROUTER_API_KEY",
      latency_ms: Date.now() - t0,
      expected_match: expected ? false : null,
    };
  }
  try {
    const { answers, model: used } = await postDecisions(key, model, state);
    const result = parseAnswers(answers, parsed, owner, used);
    const raw = JSON.stringify(answers);
    return {
      model: used,
      raw_text: raw,
      raw_text_truncated: raw.slice(0, 400),
      json_ok: true,
      category: result.category,
      directed_at_owner: result.directed_at_owner,
      reason: result.reason,
      latency_ms: Date.now() - t0,
      expected_match: expected ? result.category === expected : null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      model,
      raw_text: "",
      raw_text_truncated: msg.slice(0, 400),
      json_ok: false,
      json_error: msg,
      latency_ms: Date.now() - t0,
      expected_match: expected ? false : null,
    };
  }
}

export async function classifyMail(
  parsed: ParsedMail,
  env: ClassifyEnv,
  pre: "Marketing" | "Notification" | null,
  ownerEmail = "",
): Promise<ClassifyResult> {
  if (pre) {
    return {
      category: pre,
      directed_at_owner: false,
      reason: `preclassify:${pre}`,
      source: "preclassify",
    };
  }

  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    return {
      category: "FYI",
      directed_at_owner: false,
      reason: "OPENROUTER_API_KEY missing; safe fallback FYI",
      source: "fallback",
    };
  }

  const model = env.CLASSIFIER_MODEL?.trim() || DEFAULT_CLASSIFIER_MODEL;
  const owner = (ownerEmail || "").trim() || env.OWNER_EMAIL?.trim() || "";
  const state = buildClassifyState(parsed, owner);
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { answers, model: used } = await postDecisions(key, model, state);
      return parseAnswers(answers, parsed, owner, used);
    } catch (err) {
      lastErr = err;
    }
  }
  return fallbackOnAiFailure(parsed, owner, lastErr);
}

/** Legacy helpers kept so older debug code that imported them still typechecks. */
export function extractJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return {};
  }
}

export function contentFromAiResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result ?? "");
}
