/**
 * Multi-mailbox KV helpers + legacy single-token migration.
 *
 * New scheme:
 *   mailbox:<email>:refresh_token
 *   mailbox:<email>:cursor
 *   mailbox:<email>:watch_expiration
 *   mailboxes → JSON string[]
 *
 * Legacy (migrated on read):
 *   oauth:refresh_token, oauth:email, cursor:<email>
 */

export type MailboxKv = KVNamespace;

function norm(email: string): string {
  return email.trim().toLowerCase();
}

export function refreshKey(email: string): string {
  return `mailbox:${norm(email)}:refresh_token`;
}
export function cursorKey(email: string): string {
  return `mailbox:${norm(email)}:cursor`;
}
export function watchExpKey(email: string): string {
  return `mailbox:${norm(email)}:watch_expiration`;
}

/** Migrate legacy single-mailbox keys into the new scheme (idempotent). */
export async function migrateLegacyIfNeeded(kv: MailboxKv): Promise<{
  migrated: boolean;
  email?: string;
}> {
  const listRaw = await kv.get("mailboxes");
  const legacyEmail = (await kv.get("oauth:email"))?.trim();
  const legacyToken = await kv.get("oauth:refresh_token");
  if (!legacyEmail || !legacyToken) {
    return { migrated: false };
  }
  const email = norm(legacyEmail);

  const existingToken = await kv.get(refreshKey(email));
  if (!existingToken) {
    await kv.put(refreshKey(email), legacyToken);
  }

  const newCursor = await kv.get(cursorKey(email));
  if (!newCursor) {
    const oldCursor = await kv.get(`cursor:${email}`);
    if (oldCursor) await kv.put(cursorKey(email), oldCursor);
  }

  let list: string[] = [];
  try {
    list = listRaw ? (JSON.parse(listRaw) as string[]) : [];
  } catch {
    list = [];
  }
  if (!list.map(norm).includes(email)) {
    list.push(email);
    await kv.put("mailboxes", JSON.stringify(list));
  }

  return { migrated: true, email };
}

export async function listMailboxes(kv: MailboxKv): Promise<string[]> {
  await migrateLegacyIfNeeded(kv);
  const raw = await kv.get("mailboxes");
  if (!raw) {
    // Fallback: discover from legacy oauth:email only
    const legacy = (await kv.get("oauth:email"))?.trim();
    return legacy ? [norm(legacy)] : [];
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.map((e) => norm(String(e))).filter(Boolean))];
  } catch {
    return [];
  }
}

export async function registerMailbox(
  kv: MailboxKv,
  email: string,
  refreshToken: string,
  opts?: { cursor?: string; scope?: string },
): Promise<void> {
  const e = norm(email);
  await kv.put(refreshKey(e), refreshToken);
  if (opts?.cursor) await kv.put(cursorKey(e), opts.cursor);
  if (opts?.scope) await kv.put("oauth:scope", opts.scope);

  const list = await listMailboxes(kv);
  if (!list.includes(e)) {
    list.push(e);
    await kv.put("mailboxes", JSON.stringify(list));
  }

  // Keep legacy keys in sync for the first/primary mailbox so older tools keep working.
  const primary = list[0] || e;
  if (e === primary || list.length === 1) {
    await kv.put("oauth:refresh_token", refreshToken);
    await kv.put("oauth:email", e);
    if (opts?.cursor) await kv.put(`cursor:${e}`, opts.cursor);
  }
}

/**
 * Resolve refresh token for a mailbox.
 * Falls back: mailbox key → legacy oauth:refresh_token (if email matches oauth:email or email omitted).
 */
export async function resolveRefreshToken(
  kv: MailboxKv | undefined,
  email: string | null | undefined,
  secretFallback?: string | null,
): Promise<{ token: string | null; email: string | null; source: string }> {
  if (secretFallback?.trim() && !email) {
    // Global secret only when no mailbox specified (legacy single-mailbox).
    return { token: secretFallback.trim(), email: null, source: "secret:GMAIL_REFRESH_TOKEN" };
  }

  if (!kv) {
    if (secretFallback?.trim()) {
      return { token: secretFallback.trim(), email: email ? norm(email) : null, source: "secret:GMAIL_REFRESH_TOKEN" };
    }
    return { token: null, email: email ? norm(email) : null, source: "none" };
  }

  await migrateLegacyIfNeeded(kv);

  if (email) {
    const e = norm(email);
    const fromNew = await kv.get(refreshKey(e));
    if (fromNew) return { token: fromNew, email: e, source: refreshKey(e) };

    const legacyEmail = (await kv.get("oauth:email"))?.trim();
    const legacyToken = await kv.get("oauth:refresh_token");
    if (legacyToken && legacyEmail && norm(legacyEmail) === e) {
      await kv.put(refreshKey(e), legacyToken);
      return { token: legacyToken, email: e, source: "oauth:refresh_token→migrated" };
    }
    if (secretFallback?.trim()) {
      return { token: secretFallback.trim(), email: e, source: "secret:GMAIL_REFRESH_TOKEN" };
    }
    return { token: null, email: e, source: "none" };
  }

  // No email: prefer first registered mailbox, then legacy, then secret.
  const boxes = await listMailboxes(kv);
  if (boxes.length) {
    const e = boxes[0];
    const t = await kv.get(refreshKey(e));
    if (t) return { token: t, email: e, source: refreshKey(e) };
  }
  const legacyToken = await kv.get("oauth:refresh_token");
  const legacyEmail = (await kv.get("oauth:email"))?.trim();
  if (legacyToken) {
    const e = legacyEmail ? norm(legacyEmail) : null;
    if (e) await kv.put(refreshKey(e), legacyToken);
    return {
      token: legacyToken,
      email: e,
      source: e ? "oauth:refresh_token→migrated" : "oauth:refresh_token",
    };
  }
  if (secretFallback?.trim()) {
    return { token: secretFallback.trim(), email: null, source: "secret:GMAIL_REFRESH_TOKEN" };
  }
  return { token: null, email: null, source: "none" };
}

export async function readCursor(kv: MailboxKv | undefined, email: string): Promise<string | null> {
  if (!kv) return null;
  const e = norm(email);
  await migrateLegacyIfNeeded(kv);
  return (await kv.get(cursorKey(e))) || (await kv.get(`cursor:${e}`));
}

/**
 * Advance cursor carefully. Never jump backward.
 * Compare as BigInt when possible (Gmail historyIds are decimal strings).
 */
export async function writeCursor(
  kv: MailboxKv | undefined,
  email: string,
  historyId: string,
  opts?: { onlyIfMissing?: boolean; onlyIfNewerOrEqual?: boolean },
): Promise<{ wrote: boolean; previous: string | null }> {
  if (!kv) return { wrote: false, previous: null };
  const e = norm(email);
  const previous = await readCursor(kv, email);
  if (opts?.onlyIfMissing && previous) {
    return { wrote: false, previous };
  }
  if (opts?.onlyIfNewerOrEqual && previous) {
    try {
      if (BigInt(historyId) < BigInt(previous)) {
        return { wrote: false, previous };
      }
    } catch {
      /* non-numeric — fall through and write */
    }
  }
  await kv.put(cursorKey(e), historyId);
  // Mirror legacy key for compat
  await kv.put(`cursor:${e}`, historyId);
  return { wrote: true, previous };
}

export async function writeWatchExpiration(
  kv: MailboxKv | undefined,
  email: string,
  expiration: string | undefined,
): Promise<void> {
  if (!kv || !expiration) return;
  await kv.put(watchExpKey(email), expiration);
}

export async function readWatchExpiration(
  kv: MailboxKv | undefined,
  email: string,
): Promise<string | null> {
  if (!kv) return null;
  return kv.get(watchExpKey(email));
}

/** Map mailbox email → wake account personal|work. */
export function accountForEmail(
  email: string,
  env: { OWNER_EMAIL?: string; WORK_EMAIL?: string },
): "personal" | "work" {
  const e = norm(email);
  const work = env.WORK_EMAIL?.trim().toLowerCase();
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  if (work && e === work) return "work";
  if (owner && e === owner) return "personal";
  // Heuristic: non-gmail / custom domain often work; gmail often personal.
  if (work) return e === work ? "work" : "personal";
  if (e.endsWith("@gmail.com") || e.endsWith("@googlemail.com")) return "personal";
  // Unknown custom domain with WORK_EMAIL unset — default personal (safer for spike).
  return "personal";
}
