/** Built-in classify bake-off fixtures from inbox-organizer + Hermes cases. */

import type { ParsedMail } from "./preclassify";
import type { InboundCategory } from "./labels";

export type CompareFixture = {
  id: string;
  expected?: InboundCategory;
  ownerEmail?: string;
  mail: ParsedMail;
  notes?: string;
};

const OWNER = "owner@example.com";

/** Subset (~14) covering To Respond / FYI / Marketing / Notification / Meeting. */
export const COMPARE_FIXTURES: CompareFixture[] = [
  {
    id: "direct_ask_to_respond",
    expected: "To Respond",
    ownerEmail: OWNER,
    notes: "live-style direct ask",
    mail: {
      from: "Alex Kim <alex@example.com>",
      to: OWNER,
      subject: "Quick question on the customs demo",
      body: "Hey Matthew — can you send me the latest Northbound deck before Thursday? Thanks, Alex",
    },
  },
  {
    id: "proposal_questions_to_respond",
    expected: "To Respond",
    ownerEmail: OWNER,
    notes: "inbox-organizer to-respond.eml",
    mail: {
      from: "alice.johnson@clientco.com",
      to: OWNER,
      subject: "Re: Proposal for Q3 engagement — need your response by Friday",
      body:
        "Thanks for sending over the proposal. Can you confirm the timeline for discovery? Please clarify pricing. We need a response by Friday. Are you available Thursday morning?",
    },
  },
  {
    id: "cc_only_fyi",
    expected: "FYI",
    ownerEmail: OWNER,
    notes: "live-style CC-only; request is for To recipient",
    mail: {
      from: "Jordan Lee <jordan@partner.com>",
      to: "sam@partner.com",
      cc: OWNER,
      subject: "Need Sam to approve the invoice",
      body: "Sam — please approve invoice #4412 today. Matthew is only CC'd for visibility.",
    },
  },
  {
    id: "fyi_no_action",
    expected: "FYI",
    ownerEmail: OWNER,
    notes: "inbox-organizer fyi.eml",
    mail: {
      from: "bob.martinez@internal.example.com",
      to: "team-leads@example.com",
      cc: OWNER,
      subject: "FYI: Production deployment completed successfully — no action needed",
      body: "Just a heads-up that the v2.4.1 production deployment completed. No action is required from anyone. This is informational only.",
    },
  },
  {
    id: "marketing_unsubscribe",
    expected: "Marketing",
    ownerEmail: OWNER,
    notes: "live-style marketing with unsubscribe + one-click",
    mail: {
      from: "Deals <noreply@retail.example>",
      to: OWNER,
      subject: "48-hour flash sale — 40% off",
      body: "Shop now. Click here to unsubscribe from future emails.",
      list_unsubscribe: true,
      one_click_unsubscribe: true,
      precedence: "bulk",
    },
  },
  {
    id: "saas_promo_marketing",
    expected: "Marketing",
    ownerEmail: OWNER,
    notes: "inbox-organizer marketing.eml",
    mail: {
      from: "promotions@saasvendor.com",
      to: OWNER,
      subject: "Exclusive offer for you: 40% off annual plan — today only!",
      body: "Spring sale! CLAIM YOUR DISCOUNT. If you no longer want promotional emails, unsubscribe: https://saasvendor.com/unsubscribe",
      list_unsubscribe: true,
      precedence: "bulk",
    },
  },
  {
    id: "dataforseo_bulk_marketing",
    expected: "Marketing",
    ownerEmail: OWNER,
    notes: "Hermes unsubscribe.eml regression — bulk headers beat reply bait",
    mail: {
      from: "DataForSEO Team <team@dataforseo.com>",
      to: OWNER,
      subject: "You asked, we built: New updates to our API docs!",
      body: "Just reply directly to this email with a quick rating from 1 to 5. Unsubscribe here",
      list_unsubscribe: true,
      one_click_unsubscribe: true,
      precedence: "bulk",
    },
  },
  {
    id: "newsletter_bulk",
    expected: "Marketing",
    ownerEmail: OWNER,
    notes: "inbox-organizer newsletter.eml (bulk → Marketing via preclassify)",
    mail: {
      from: "digest@techweekly.io",
      to: OWNER,
      subject: "Tech Weekly Digest — Issue #214",
      body: "AI tooling round-up. To unsubscribe: https://techweekly.io/unsubscribe",
      list_unsubscribe: true,
      precedence: "bulk",
    },
  },
  {
    id: "github_noreply_notification",
    expected: "Notification",
    ownerEmail: OWNER,
    notes: "inbox-organizer notification.eml + Hermes noreply rule",
    mail: {
      from: "noreply@github.com",
      to: OWNER,
      subject: "[GitHub] Your pull request #482 was merged",
      body: "Your pull request was merged. Manage preferences: https://github.com/settings/notifications",
    },
  },
    {
    id: "felix_renewal_notification",
    expected: "Notification",
    ownerEmail: OWNER,
    notes: "2026-09-11 mis-wake: notify.* host + in-app counselling/ship CTAs, not email reply",
    mail: {
      from: "felix@notify.felixforyou.ca",
      to: OWNER,
      subject: "Your renewal is approved!",
      body:
        "Do you need medication counselling? Your renewal is approved. Before we send your order, would you like to speak to a pharmacist about your medication? No, just ship my order. Yes, have a pharmacist call me. Note: If we don't hear back from you in 24 hours, we'll ship your order.",
    },
  },
  {
    id: "vast_terms_notification",
    expected: "Notification",
    ownerEmail: OWNER,
    notes: "2026-09-15 mis-wake: contact@ + ToS broadcast, not an email ask",
    mail: {
      from: "contact@vast.ai",
      to: OWNER,
      subject: "Important: Vast.ai Terms Updated",
      body:
        "Hello, We updated the Vast.ai Terms of Service. The new version is live at vast.ai/terms and replaces the November 10, 2025 version. What changed: Marketplace data. Need data access beyond this? Email data@vast.ai. Sincerely, The Vast.ai Team",
    },
  },
{
    id: "stripe_receipt_notification",
    expected: "Notification",
    ownerEmail: OWNER,
    notes: "receipts@stripe often preclassifies as Notification via noreply-ish from",
    mail: {
      from: "receipts@stripe.com",
      to: OWNER,
      subject: "Your receipt from Acme Cloud Services — $142.50",
      body: "Amount charged: $142.50 USD. Invoice INV-2026-04-00091. Thank you for your business.",
    },
  },
  {
    id: "password_changed_notification",
    expected: "Notification",
    ownerEmail: OWNER,
    notes: "headers/notification.eml",
    mail: {
      from: "noreply@service.com",
      to: OWNER,
      subject: "Your account password was changed",
      body: "Your password was changed. If you did not make this change, secure your account. Do not reply.",
    },
  },
  {
    id: "calendar_meeting_update",
    expected: "Meeting Update",
    ownerEmail: OWNER,
    notes: "inbox-organizer meeting.eml",
    mail: {
      from: "calendar-noreply@google.com",
      to: OWNER,
      subject: "Invitation: Q2 Planning Kickoff @ Mon Apr 14, 2026 2pm - 3pm (PDT)",
      body: "You have been invited. RSVP: Accept | Decline | Maybe. Please review the Q1 retrospective doc before joining.",
    },
  },
  {
    id: "human_meeting_ask",
    expected: "To Respond",
    ownerEmail: OWNER,
    notes: "ambiguous/meeting-without-ics.eml — human scheduling ask",
    mail: {
      from: "carol.west@advisorgroup.com",
      to: OWNER,
      subject: "Catching up next week — does Thursday work?",
      body: "Matt, would love to reconnect. Any chance you have 45 minutes free Thursday? Let me know if Thursday works.",
    },
  },
  {
    id: "newsletter_with_question_marketing",
    expected: "Marketing",
    ownerEmail: OWNER,
    notes: "ambiguous/newsletter-with-question — bulk still Marketing",
    mail: {
      from: "digest@foundersweekly.co",
      to: OWNER,
      subject: "Founders Weekly #88 — LP relations + quick question for you",
      body: "Would you be willing to share 2-3 sentences? Just reply to this email. Unsubscribe: https://foundersweekly.co/unsubscribe",
      list_unsubscribe: true,
      precedence: "bulk",
    },
  },
  {
    id: "personal_review_ask",
    expected: "To Respond",
    ownerEmail: OWNER,
    notes: "Hermes personal mail / no unsubscribe hint",
    mail: {
      from: "alice@x.com",
      to: OWNER,
      subject: "Question",
      body: "Can you review the doc?",
    },
  },
  {
    id: "cc_boss_ask_for_bob",
    expected: "FYI",
    ownerEmail: OWNER,
    notes: "Hermes cc-only hint case",
    mail: {
      from: "boss@x.com",
      to: "bob@x.com",
      cc: OWNER,
      subject: "Please handle",
      body: "Bob, can you send the report?",
    },
  },
];
