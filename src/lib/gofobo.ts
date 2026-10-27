/** Gofobo screening pass fast-path forwarding. */

import type { ParsedMail } from "./gmail";

export type GofoboEnv = {
  MOVIES_WEBHOOK_URL?: string;
  MOVIES_WEBHOOK_AUTH?: string;
  INBOX_STATE?: KVNamespace;
};

export type GofoboForwardPayload = {
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
  date: string | null;
  snippet?: string;
  claimLink: string | null;
};

const GOFOBO_FORWARDED_PREFIX = "gofobo:forwarded:";
const GOFOBO_FORWARDED_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

/**
 * Detect if the message is a Gofobo screening pass email.
 * Match either:
 * - From address is no-reply@gofobo.com
 * - Subject contains "Sign Up for Passes for"
 */
export function isGofoboEmail(from: string, subject: string, account: string): boolean {
  // Only check personal mailbox messages
  if (account !== "personal") return false;
  
  const fromLower = from.toLowerCase();
  if (fromLower.includes("no-reply@gofobo.com")) return true;
  
  if (subject.includes("Sign Up for Passes for")) return true;
  
  return false;
}

/**
 * Extract the first gofobo.com URL from message body.
 * Handles both text and HTML, decodes HTML entities.
 */
export function extractGofoboClaimLink(body: string): string | null {
  if (!body) return null;
  
  // Match gofobo.com URLs (http or https)
  const urlPattern = /https?:\/\/(?:www\.)?gofobo\.com\/[^\s<>"']+/gi;
  const match = body.match(urlPattern);
  
  if (!match || match.length === 0) return null;
  
  let url = match[0];
  
  // Decode common HTML entities
  url = url
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
  
  return url;
}

/**
 * Extract and format date as ISO string.
 * Uses Date header if available, falls back to internalDate (Gmail's timestamp in ms).
 */
export function extractDate(parsed: ParsedMail): string | null {
  // Try Date header first
  if (parsed.date) {
    try {
      const dateObj = new Date(parsed.date);
      if (!isNaN(dateObj.getTime())) {
        return dateObj.toISOString();
      }
    } catch {
      // Invalid date header, fall through to internalDate
    }
  }
  
  // Fall back to internalDate (Gmail's timestamp in milliseconds as string)
  if (parsed.internal_date) {
    try {
      const timestamp = parseInt(parsed.internal_date, 10);
      if (!isNaN(timestamp)) {
        return new Date(timestamp).toISOString();
      }
    } catch {
      // Invalid internalDate
    }
  }
  
  return null;
}

/**
 * Check if this message was already forwarded (KV dedupe).
 */
export async function wasAlreadyForwarded(
  kv: KVNamespace | undefined,
  messageId: string,
): Promise<boolean> {
  if (!kv) return false;
  const hit = await kv.get(`${GOFOBO_FORWARDED_PREFIX}${messageId}`);
  return hit !== null;
}

/**
 * Mark this message as forwarded (KV dedupe).
 */
export async function markForwarded(
  kv: KVNamespace | undefined,
  messageId: string,
): Promise<void> {
  if (!kv) return;
  await kv.put(`${GOFOBO_FORWARDED_PREFIX}${messageId}`, "1", {
    expirationTtl: GOFOBO_FORWARDED_TTL_SEC,
  });
}

/**
 * Forward Gofobo email to movies webhook.
 * Returns { ok: boolean, error?: string }.
 * Never throws; logs failures.
 */
export async function forwardGofoboEmail(
  env: GofoboEnv,
  parsed: ParsedMail,
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const url = env.MOVIES_WEBHOOK_URL?.trim();
  const auth = env.MOVIES_WEBHOOK_AUTH?.trim();
  
  // Skip if either env var is missing
  if (!url || !auth) {
    return { ok: true, skipped: true };
  }
  
  const messageId = parsed.id || "";
  if (!messageId) {
    return { ok: false, error: "missing messageId" };
  }
  
  // Dedupe: check if already forwarded
  if (await wasAlreadyForwarded(env.INBOX_STATE, messageId)) {
    return { ok: true, skipped: true };
  }
  
  const claimLink = extractGofoboClaimLink(parsed.body || "");
  const date = extractDate(parsed);
  
  const payload: GofoboForwardPayload = {
    messageId,
    threadId: parsed.thread_id,
    subject: parsed.subject || "",
    from: parsed.from || "",
    date,
    snippet: parsed.snippet,
    claimLink,
  };
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth}`,
      },
      body: JSON.stringify(payload),
    });
    
    if (!res.ok) {
      const bodyText = await res.text();
      const error = `movies webhook failed: ${res.status} ${bodyText.slice(0, 200)}`;
      console.error(error);
      return { ok: false, error };
    }
    
    // Mark as forwarded on success
    await markForwarded(env.INBOX_STATE, messageId);
    
    return { ok: true };
  } catch (err) {
    const error = `movies webhook error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(error);
    return { ok: false, error };
  }
}
