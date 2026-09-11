/** Gmail REST helpers for the Worker (token refresh + history + message parse). */

export type GmailEnv = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
};

export type ParsedMail = {
  id?: string;
  thread_id?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  snippet?: string;
  list_unsubscribe?: boolean;
  one_click_unsubscribe?: boolean;
  precedence?: string;
  label_ids?: string[];
};

function b64urlDecode(data: string): string {
  const pad = "=".repeat((4 - (data.length % 4)) % 4);
  const b64 = (data + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function header(headers: Array<{ name?: string; value?: string }>, name: string): string {
  for (const h of headers || []) {
    if ((h.name || "").toLowerCase() === name.toLowerCase()) return h.value || "";
  }
  return "";
}

function extractPlain(payload: Record<string, unknown>, limit = 4000): string {
  if (payload.mimeType === "text/plain") {
    const body = payload.body as { data?: string } | undefined;
    if (body?.data) return b64urlDecode(body.data).slice(0, limit);
  }
  for (const part of (payload.parts as Record<string, unknown>[] | undefined) || []) {
    const found = extractPlain(part, limit);
    if (found) return found;
  }
  return "";
}

export function parseMessage(msg: Record<string, unknown>): ParsedMail {
  const payload = (msg.payload as Record<string, unknown>) || {};
  const headers = (payload.headers as Array<{ name?: string; value?: string }>) || [];
  return {
    id: String(msg.id || ""),
    thread_id: String(msg.threadId || ""),
    from: header(headers, "from"),
    to: header(headers, "to"),
    cc: header(headers, "cc"),
    subject: header(headers, "subject"),
    snippet: String(msg.snippet || ""),
    body: extractPlain(payload),
    list_unsubscribe: Boolean(header(headers, "list-unsubscribe")),
    one_click_unsubscribe: Boolean(header(headers, "list-unsubscribe-post")),
    precedence: header(headers, "precedence").trim().toLowerCase(),
    label_ids: Array.isArray(msg.labelIds) ? (msg.labelIds as string[]) : [],
  };
}

/** Extract bare emails from a header value. */
export function extractAddrs(value: string): string[] {
  const out: string[] = [];
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value || ""))) out.push(m[0].toLowerCase());
  return [...new Set(out)];
}

/** Hermes recipient_role: direct | cc | "" */
export function recipientRole(parsed: ParsedMail, ownerAddr: string): "direct" | "cc" | "" {
  const owner = (ownerAddr || "").trim().toLowerCase();
  if (!owner) return "";
  const to = extractAddrs(parsed.to || "");
  if (to.includes(owner)) return "direct";
  const cc = extractAddrs(parsed.cc || "");
  if (cc.includes(owner)) return "cc";
  return "";
}

export async function getAccessToken(env: GmailEnv): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("token refresh: no access_token");
  return data.access_token;
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });
}

export async function getMessage(
  accessToken: string,
  messageId: string,
  format: "full" | "metadata" = "full",
): Promise<Record<string, unknown>> {
  const res = await gmailFetch(
    accessToken,
    `messages/${encodeURIComponent(messageId)}?format=${format}`,
  );
  if (!res.ok) throw new Error(`getMessage ${messageId}: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export class StaleCursor extends Error {
  constructor() {
    super("Gmail history cursor stale (404)");
    this.name = "StaleCursor";
  }
}

export type HistoryDrainResult = {
  newHistoryId: string;
  inboxMessageIds: string[];
  sentMessageIds: string[];
};

/** Port of hermes drain_history — messageAdded since startHistoryId. */
export async function drainHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<HistoryDrainResult> {
  const inboxIds: string[] = [];
  const sentIds: string[] = [];
  let maxHid = startHistoryId;
  let pageToken: string | undefined;
  let pages = 0;
  const MAX_PAGES = 25;

  while (pages < MAX_PAGES) {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await gmailFetch(accessToken, `history?${params}`);
    if (res.status === 404) throw new StaleCursor();
    if (!res.ok) throw new Error(`history.list: ${res.status} ${await res.text()}`);
    const resp = (await res.json()) as {
      historyId?: string;
      history?: Array<{
        messagesAdded?: Array<{ message?: { id?: string; labelIds?: string[] } }>;
      }>;
      nextPageToken?: string;
    };
    if (resp.historyId) maxHid = resp.historyId;
    for (const entry of resp.history || []) {
      for (const added of entry.messagesAdded || []) {
        const m = added.message || {};
        const mid = m.id;
        if (!mid) continue;
        const labels = m.labelIds || [];
        if (labels.includes("SENT") && !labels.includes("INBOX")) {
          sentIds.push(mid);
        } else if (labels.length > 0 && !labels.includes("INBOX")) {
          // Filter Skip-Inbox / label-only adds — do not triage.
          continue;
        } else {
          // INBOX present, or empty labelIds (history often incomplete) —
          // processInboxMessage requires INBOX on the full message.
          inboxIds.push(mid);
        }
      }
    }
    pageToken = resp.nextPageToken;
    pages += 1;
    if (!pageToken) break;
  }

  return {
    newHistoryId: maxHid,
    inboxMessageIds: [...new Set(inboxIds)],
    sentMessageIds: [...new Set(sentIds)],
  };
}

/** Arm Gmail watch toward a Pub/Sub topic. */
export async function watchMailbox(
  accessToken: string,
  topicName: string,
): Promise<{ historyId: string; expiration?: string }> {
  const res = await gmailFetch(accessToken, "watch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topicName,
      labelIds: ["INBOX", "SENT"],
      labelFilterBehavior: "include",
    }),
  });
  if (!res.ok) throw new Error(`watch failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { historyId?: string; expiration?: string };
  if (!data.historyId) throw new Error("watch: no historyId");
  return { historyId: data.historyId, expiration: data.expiration };
}

export async function getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await gmailFetch(accessToken, "profile");
  if (!res.ok) throw new Error(`profile: ${res.status}`);
  const data = (await res.json()) as { emailAddress?: string; historyId?: string };
  return {
    emailAddress: String(data.emailAddress || ""),
    historyId: String(data.historyId || ""),
  };
}

export async function listUserLabels(
  accessToken: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await gmailFetch(accessToken, "labels");
  if (!res.ok) throw new Error(`labels.list: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    labels?: Array<{ id?: string; name?: string; type?: string }>;
  };
  return (data.labels || [])
    .filter((l) => l.id && l.name)
    .map((l) => ({ id: String(l.id), name: String(l.name) }));
}

export async function ensureLabelId(
  accessToken: string,
  name: string,
  cache: Map<string, string>,
): Promise<string> {
  const hit = cache.get(name);
  if (hit) return hit;
  const labels = await listUserLabels(accessToken);
  for (const l of labels) cache.set(l.name, l.id);
  const existing = cache.get(name);
  if (existing) return existing;
  const res = await gmailFetch(accessToken, "labels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
  if (!res.ok) throw new Error(`labels.create ${name}: ${res.status} ${await res.text()}`);
  const created = (await res.json()) as { id?: string };
  if (!created.id) throw new Error(`labels.create ${name}: no id`);
  cache.set(name, created.id);
  return created.id;
}

export async function modifyMessageLabels(
  accessToken: string,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  const res = await gmailFetch(
    accessToken,
    `messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    },
  );
  if (!res.ok) {
    throw new Error(`messages.modify ${messageId}: ${res.status} ${await res.text()}`);
  }
}

