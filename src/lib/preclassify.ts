/** Deterministic fast-path — port of hermes pre_classifier.py */

export type ParsedMail = {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  snippet?: string;
  list_unsubscribe?: boolean;
  one_click_unsubscribe?: boolean;
  precedence?: string;
};

const NOREPLY_RE = /no[-_.]?reply|donotreply|do-not-reply|mailer-daemon/i;
const UNSUB_BODY_RE =
  /unsubscribe|opt[ -]out|email preferences|manage (?:your )?preferences/i;
const BULK_PRECEDENCE = new Set(["bulk", "junk"]);

export function isBulkMarketing(parsed: ParsedMail): boolean {
  if (parsed.one_click_unsubscribe) return true;
  return Boolean(parsed.list_unsubscribe) &&
    BULK_PRECEDENCE.has(String(parsed.precedence || "").toLowerCase());
}

export function hasUnsubscribeSignal(parsed: ParsedMail): boolean {
  if (parsed.list_unsubscribe || parsed.one_click_unsubscribe) return true;
  return UNSUB_BODY_RE.test(parsed.body || parsed.snippet || "");
}

/** Return a category if a rule matches, else null → LLM / ambiguous path. */
export function preClassify(parsed: ParsedMail): "Marketing" | "Notification" | null {
  if (isBulkMarketing(parsed)) return "Marketing";
  if (NOREPLY_RE.test(parsed.from || "")) return "Notification";
  return null;
}
