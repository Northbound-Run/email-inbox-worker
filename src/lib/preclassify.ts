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

/** Automated transactional / alert senders that should not wake To Respond. */
const AUTOMATED_FROM_RE =
  /(?:^|[\s<])(?:notifications?|alerts?|orders?|shipping|ship-?confirm|receipts?|updates?|status|automated|bounces?)@/i;

/** notify.example.com / alerts.brand.com style hostnames (e.g. felix@notify.felixforyou.ca). */
const AUTOMATED_HOST_RE =
  /@(?:notify|notification|notifications|alerts?|mailer|email|e)\./i;

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

/** True when From looks like an automated system/app sender. */
export function isAutomatedSender(from: string | undefined): boolean {
  const frm = from || "";
  if (NOREPLY_RE.test(frm)) return true;
  if (AUTOMATED_FROM_RE.test(frm)) return true;
  if (AUTOMATED_HOST_RE.test(frm)) return true;
  return false;
}

/**
 * In-app / button CTAs that look like questions but do not expect an email reply
 * (pharmacy renewals, ship confirmations, manage-preferences, etc.).
 */
export function looksLikeTransactionalCta(parsed: ParsedMail): boolean {
  const blob = `${parsed.subject || ""}\n${parsed.body || parsed.snippet || ""}`;
  const strong =
    /\b(no,? just ship|just ship (?:my )?order|auto[- ]?ship|ship your order)\b/i.test(
      blob,
    ) ||
    /\b(renewal (?:is )?approved|medication counselling|pharmacist (?:call|about)|counselling-confirmation)\b/i.test(
      blob,
    ) ||
    (/\bif we (?:don(?:'|’)t|do not) hear back\b/i.test(blob) &&
      /\b(ship|order|renewal|delivery)\b/i.test(blob));
  const soft =
    /\b(click (?:here|below|the button)|tap (?:here|below)|view (?:and update )?your (?:delivery )?preferences|download the app)\b/i.test(
      blob,
    );
  // Soft CTAs alone are weak; require automated From. Strong ship/renewal CTAs
  // can stand alone (brands that send from hello@ / support@).
  if (strong) return true;
  if (soft && isAutomatedSender(parsed.from)) return true;
  return false;
}

/**
 * Broadcast Terms-of-Service / privacy / legal *product* updates
 * (e.g. contact@vast.ai "Terms Updated"). Must NOT match human deal threads
 * like "Re: Updated Terms & Conditions".
 */
export function looksLikePolicyBroadcast(parsed: ParsedMail): boolean {
  const subject = (parsed.subject || "").trim();
  const body = parsed.body || parsed.snippet || "";
  const blob = `${subject}\n${body}`;

  // Reply / forward threads are almost always human negotiation, not a ToS blast.
  if (/^(?:(?:re|fw|fwd)\s*:\s*)+/i.test(subject)) return false;

  // Require product/legal-policy language — bare "Terms & Conditions" is too common
  // in commercial negotiation subjects.
  const policyTopic =
    /\bterms\s+of\s+(?:service|use)\b|\bprivacy\s+policy\b|\blegal\s+(?:update|notice)\b|\b(?:our|the)\s+tos\b/i.test(
      blob,
    );
  if (!policyTopic) return false;

  const announce =
    /we (?:have )?updated (?:our |the )?(?:terms|privacy|tos)\b/i.test(blob) ||
    /terms of (?:service|use).{0,100}(?:updated|new version|live at|replaces)/i.test(
      blob,
    ) ||
    /privacy policy.{0,80}(?:updated|new version|live at|replaces)/i.test(blob) ||
    (/\bterms\s+of\s+(?:service|use)\b/i.test(subject) &&
      /\b(?:updated?|update|changes?)\b/i.test(subject));

  if (!announce) return false;

  // Prefer broadcast senders / team sign-off; still allow strong announce phrasing
  // from contact@-style mailboxes without a personal first-name reply tone.
  if (isAutomatedSender(parsed.from)) return true;
  if (/\bthe\s+[\w .&-]{2,40}\s+team\b/i.test(body)) return true;
  if (
    /(?:^|[\s<])(?:contact|hello|info|team|support|legal|noreply)@/i.test(
      parsed.from || "",
    )
  ) {
    return true;
  }
  // Strong "we updated the Terms of Service … live at" without needing From heuristics.
  if (
    /we (?:have )?updated (?:our |the )?terms of (?:service|use)\b/i.test(blob) &&
    /\b(?:live at|new version|replaces the)\b/i.test(blob)
  ) {
    return true;
  }
  return false;
}

/** Return a category if a rule matches, else null → LLM / ambiguous path. */
export function preClassify(parsed: ParsedMail): "Marketing" | "Notification" | null {
  if (isBulkMarketing(parsed)) return "Marketing";
  if (isAutomatedSender(parsed.from)) return "Notification";
  // Strong transactional CTA without noreply From (hello@/support@ brands).
  if (looksLikeTransactionalCta(parsed)) return "Notification";
  // ToS / privacy / legal broadcasts (e.g. contact@vast.ai "Terms Updated").
  if (looksLikePolicyBroadcast(parsed)) return "Notification";
  return null;
}
