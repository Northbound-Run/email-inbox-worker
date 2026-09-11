/** Wake Email bot only for To Respond drafts (with retries). */

export type WakeEnv = {
  GROK_WEBHOOK_URL: string;
  GROK_WEBHOOK_KEY: string;
};

export type DraftWakePayload = {
  scenario?: "draft";
  account?: "personal" | "work";
  category: "To Respond";
  threadId?: string;
  messageId?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  voice_notes?: string;
  lessons?: unknown;
  gold_examples?: unknown;
};

export type WakeResult = {
  ok: boolean;
  status: number;
  runUuid?: string;
  body: string;
  attempts: number;
  error?: string;
  /** True when KV showed this message/thread was already woken recently. */
  skipped?: boolean;
  skip_reason?: "already_woken_message" | "already_woken_thread";
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [200, 500, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True only on HTTP 2xx with parseable JSON that has success and/or runUuid. */
export function wakeResponseOk(status: number, bodyText: string): {
  ok: boolean;
  runUuid?: string;
  success?: boolean;
} {
  if (status < 200 || status >= 300) return { ok: false };
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const runUuid =
      typeof parsed.runUuid === "string"
        ? parsed.runUuid
        : typeof parsed.run_uuid === "string"
          ? parsed.run_uuid
          : undefined;
    const success = parsed.success === true || parsed.ok === true;
    if (runUuid || success) {
      return { ok: true, runUuid, success: success || Boolean(runUuid) };
    }
    return { ok: false, runUuid, success: false };
  } catch {
    return { ok: false };
  }
}

export async function wakeEmailDraft(
  env: WakeEnv,
  payload: DraftWakePayload,
): Promise<WakeResult> {
  return wakeEmailDraftWithRetry(env, payload, MAX_ATTEMPTS);
}

export async function wakeEmailDraftWithRetry(
  env: WakeEnv,
  payload: DraftWakePayload,
  maxAttempts = MAX_ATTEMPTS,
): Promise<WakeResult> {
  const url = env.GROK_WEBHOOK_URL?.trim();
  const key = env.GROK_WEBHOOK_KEY?.trim();
  if (!url || !key) throw new Error("Missing GROK_WEBHOOK_URL or GROK_WEBHOOK_KEY");

  let last: WakeResult = {
    ok: false,
    status: 0,
    body: "",
    attempts: 0,
    error: "no attempts",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          ...payload,
          scenario: "draft",
          category: "To Respond",
          source: "email-inbox-worker",
          at: new Date().toISOString(),
        }),
      });
      const body = await res.text();
      const check = wakeResponseOk(res.status, body);
      last = {
        ok: check.ok,
        status: res.status,
        body: body.slice(0, 2000),
        runUuid: check.runUuid,
        attempts: attempt,
        error: check.ok
          ? undefined
          : `wake not confirmed (status=${res.status}, hasRunUuid=${Boolean(check.runUuid)})`,
      };
      if (check.ok) return last;
    } catch (err) {
      last = {
        ok: false,
        status: 0,
        body: "",
        attempts: attempt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (attempt < maxAttempts) {
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }
  return last;
}


const WOKEN_TTL_SEC = 60 * 60 * 24 * 7; // 7 days
const WOKEN_MSG_PREFIX = "woken:";
const WOKEN_THREAD_PREFIX = "woken:thread:";

export async function wasAlreadyWoken(
  kv: KVNamespace,
  messageId?: string,
  threadId?: string,
): Promise<{ woken: boolean; reason?: WakeResult["skip_reason"] }> {
  if (messageId) {
    const hit = await kv.get(`${WOKEN_MSG_PREFIX}${messageId}`);
    if (hit) return { woken: true, reason: "already_woken_message" };
  }
  if (threadId) {
    const hit = await kv.get(`${WOKEN_THREAD_PREFIX}${threadId}`);
    if (hit) return { woken: true, reason: "already_woken_thread" };
  }
  return { woken: false };
}

export async function markWoken(
  kv: KVNamespace,
  messageId?: string,
  threadId?: string,
): Promise<void> {
  const opts = { expirationTtl: WOKEN_TTL_SEC };
  if (messageId) {
    await kv.put(`${WOKEN_MSG_PREFIX}${messageId}`, "1", opts);
  }
  if (threadId) {
    await kv.put(`${WOKEN_THREAD_PREFIX}${threadId}`, messageId || "1", opts);
  }
}

/**
 * Idempotent wake: skip if woken:<messageId> or woken:thread:<threadId> is set.
 * On success, mark both keys (TTL ~7d). Skips count as ok for label gating.
 */
export async function wakeEmailDraftIdempotent(
  env: WakeEnv & { INBOX_STATE?: KVNamespace },
  payload: DraftWakePayload,
): Promise<WakeResult> {
  const kv = env.INBOX_STATE;
  if (kv) {
    const prior = await wasAlreadyWoken(kv, payload.messageId, payload.threadId);
    if (prior.woken) {
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({ skipped: true, reason: prior.reason }),
        attempts: 0,
        skipped: true,
        skip_reason: prior.reason,
        runUuid: undefined,
      };
    }
  }

  const wake = await wakeEmailDraftWithRetry(env, payload);
  if (wake.ok && kv) {
    await markWoken(kv, payload.messageId, payload.threadId);
  }
  return wake;
}

const PENDING_PREFIX = "wake:pending:";
const PENDING_LIST_KEY = "wake:pending:list";

export type PendingWake = {
  messageId: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  account?: "personal" | "work";
  queuedAt: string;
  lastError?: string;
};

export async function queuePendingWake(
  kv: KVNamespace,
  pending: PendingWake,
): Promise<void> {
  await kv.put(`${PENDING_PREFIX}${pending.messageId}`, JSON.stringify(pending), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
  });
  const raw = (await kv.get(PENDING_LIST_KEY)) || "[]";
  let list: string[] = [];
  try {
    list = JSON.parse(raw) as string[];
  } catch {
    list = [];
  }
  if (!list.includes(pending.messageId)) {
    list.push(pending.messageId);
    // Cap list size
    if (list.length > 200) list = list.slice(-200);
    await kv.put(PENDING_LIST_KEY, JSON.stringify(list));
  }
}

export async function clearPendingWake(
  kv: KVNamespace,
  messageId: string,
): Promise<void> {
  await kv.delete(`${PENDING_PREFIX}${messageId}`);
  const raw = (await kv.get(PENDING_LIST_KEY)) || "[]";
  let list: string[] = [];
  try {
    list = JSON.parse(raw) as string[];
  } catch {
    list = [];
  }
  const next = list.filter((id) => id !== messageId);
  await kv.put(PENDING_LIST_KEY, JSON.stringify(next));
}

/** Retry a few queued wakes (simple flush for /drain and /pubsub). */
export async function flushPendingWakes(
  env: WakeEnv & { INBOX_STATE?: KVNamespace },
  limit = 5,
): Promise<Array<Record<string, unknown>>> {
  const kv = env.INBOX_STATE;
  if (!kv) return [];
  const raw = (await kv.get(PENDING_LIST_KEY)) || "[]";
  let list: string[] = [];
  try {
    list = JSON.parse(raw) as string[];
  } catch {
    return [];
  }
  const results: Array<Record<string, unknown>> = [];
  const batch = list.slice(0, limit);
  for (const messageId of batch) {
    const stored = await kv.get(`${PENDING_PREFIX}${messageId}`);
    if (!stored) {
      await clearPendingWake(kv, messageId);
      results.push({ messageId, skipped: "missing-payload" });
      continue;
    }
    let pending: PendingWake;
    try {
      pending = JSON.parse(stored) as PendingWake;
    } catch {
      await clearPendingWake(kv, messageId);
      results.push({ messageId, skipped: "bad-payload" });
      continue;
    }
    try {
      const prior = await wasAlreadyWoken(kv, pending.messageId, pending.threadId);
      if (prior.woken) {
        await clearPendingWake(kv, messageId);
        results.push({
          messageId,
          ok: true,
          skipped: true,
          reason: prior.reason,
        });
        continue;
      }
      const wake = await wakeEmailDraftWithRetry(env, {
        account: pending.account || "personal",
        category: "To Respond",
        threadId: pending.threadId,
        messageId: pending.messageId,
        from: pending.from,
        to: pending.to,
        subject: pending.subject,
        body: pending.body,
      });
      if (wake.ok) {
        await markWoken(kv, pending.messageId, pending.threadId);
        await clearPendingWake(kv, messageId);
        results.push({
          messageId,
          ok: true,
          runUuid: wake.runUuid,
          attempts: wake.attempts,
        });
      } else {
        pending.lastError = wake.error || `status=${wake.status}`;
        pending.queuedAt = pending.queuedAt || new Date().toISOString();
        await kv.put(`${PENDING_PREFIX}${messageId}`, JSON.stringify(pending), {
          expirationTtl: 60 * 60 * 24 * 7,
        });
        results.push({
          messageId,
          ok: false,
          status: wake.status,
          error: wake.error,
          attempts: wake.attempts,
        });
      }
    } catch (err) {
      results.push({
        messageId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
