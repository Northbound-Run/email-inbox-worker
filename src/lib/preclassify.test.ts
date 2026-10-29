import { describe, it, expect } from "vitest";
import {
  isGeminiMeetingNotes,
  preClassify,
  isAutomatedSender,
  isBulkMarketing,
  looksLikeTransactionalCta,
  looksLikePolicyBroadcast,
  type ParsedMail,
} from "./preclassify";

describe("isGeminiMeetingNotes", () => {
  it("detects email from gemini-notes@google.com", () => {
    expect(isGeminiMeetingNotes("gemini-notes@google.com")).toBe(true);
    expect(isGeminiMeetingNotes("Gemini-Notes@google.com")).toBe(true);
    expect(isGeminiMeetingNotes("GEMINI-NOTES@GOOGLE.COM")).toBe(true);
  });

  it("detects email with angle brackets", () => {
    expect(isGeminiMeetingNotes("<gemini-notes@google.com>")).toBe(true);
    expect(isGeminiMeetingNotes("Gemini <gemini-notes@google.com>")).toBe(true);
  });

  it("rejects non-Gemini emails", () => {
    expect(isGeminiMeetingNotes("someone@example.com")).toBe(false);
    expect(isGeminiMeetingNotes("notes@google.com")).toBe(false);
    expect(isGeminiMeetingNotes("gemini@google.com")).toBe(false);
    expect(isGeminiMeetingNotes("")).toBe(false);
    expect(isGeminiMeetingNotes(undefined)).toBe(false);
  });
});

describe("preClassify with Gemini notes", () => {
  it("classifies Gemini meeting notes as FYI", () => {
    const parsed: ParsedMail = {
      from: "gemini-notes@google.com",
      subject: 'Notes: "Igloo / Northbound" Oct 29, 2026',
      body: "Meeting notes content here",
    };
    expect(preClassify(parsed)).toBe("FYI");
  });

  it("classifies Gemini notes with display name as FYI", () => {
    const parsed: ParsedMail = {
      from: "Gemini <gemini-notes@google.com>",
      subject: 'Notes: "Weekly Sync" Oct 29, 2026',
      body: "Meeting notes content here",
    };
    expect(preClassify(parsed)).toBe("FYI");
  });

  it("prioritizes Gemini notes over other rules", () => {
    // Even if it has unsubscribe signals (shouldn't happen, but test priority)
    const parsed: ParsedMail = {
      from: "gemini-notes@google.com",
      subject: 'Notes: "Meeting" Oct 29, 2026',
      body: "Notes here. Click to unsubscribe.",
      list_unsubscribe: true,
    };
    expect(preClassify(parsed)).toBe("FYI");
  });

  it("prioritizes Gemini notes over noreply detection", () => {
    const parsed: ParsedMail = {
      from: "gemini-notes@google.com",
      subject: 'Notes: "Meeting" Oct 29, 2026',
      body: "Notes here",
    };
    // If Gemini notes wasn't checked first, this might hit the noreply rule
    expect(preClassify(parsed)).toBe("FYI");
  });
});

describe("preClassify existing rules", () => {
  it("returns Marketing for bulk marketing", () => {
    const parsed: ParsedMail = {
      from: "deals@example.com",
      subject: "Sale!",
      body: "Buy now",
      list_unsubscribe: true,
      one_click_unsubscribe: true,
    };
    expect(preClassify(parsed)).toBe("Marketing");
  });

  it("returns Notification for automated sender", () => {
    const parsed: ParsedMail = {
      from: "noreply@example.com",
      subject: "Your order has shipped",
      body: "Tracking: 123456",
    };
    expect(preClassify(parsed)).toBe("Notification");
  });

  it("returns null for ambiguous mail", () => {
    const parsed: ParsedMail = {
      from: "person@example.com",
      subject: "Hello",
      body: "How are you?",
    };
    expect(preClassify(parsed)).toBe(null);
  });
});

describe("isAutomatedSender", () => {
  it("detects noreply addresses", () => {
    expect(isAutomatedSender("noreply@example.com")).toBe(true);
    expect(isAutomatedSender("no-reply@example.com")).toBe(true);
    expect(isAutomatedSender("no_reply@example.com")).toBe(true);
    expect(isAutomatedSender("donotreply@example.com")).toBe(true);
  });

  it("detects automated from patterns", () => {
    expect(isAutomatedSender("notifications@example.com")).toBe(true);
    expect(isAutomatedSender("alerts@example.com")).toBe(true);
    expect(isAutomatedSender("orders@example.com")).toBe(true);
  });

  it("detects automated host patterns", () => {
    expect(isAutomatedSender("user@notify.example.com")).toBe(true);
    expect(isAutomatedSender("user@notifications.example.com")).toBe(true);
    expect(isAutomatedSender("user@alerts.example.com")).toBe(true);
  });

  it("rejects normal email addresses", () => {
    expect(isAutomatedSender("john@example.com")).toBe(false);
    expect(isAutomatedSender("hello@example.com")).toBe(false);
    expect(isAutomatedSender("")).toBe(false);
    expect(isAutomatedSender(undefined)).toBe(false);
  });
});

describe("isBulkMarketing", () => {
  it("detects one-click unsubscribe", () => {
    const parsed: ParsedMail = {
      one_click_unsubscribe: true,
    };
    expect(isBulkMarketing(parsed)).toBe(true);
  });

  it("detects bulk precedence with list-unsubscribe", () => {
    const parsed: ParsedMail = {
      list_unsubscribe: true,
      precedence: "bulk",
    };
    expect(isBulkMarketing(parsed)).toBe(true);
  });

  it("rejects list-unsubscribe without bulk precedence", () => {
    const parsed: ParsedMail = {
      list_unsubscribe: true,
      precedence: "normal",
    };
    expect(isBulkMarketing(parsed)).toBe(false);
  });
});

describe("looksLikeTransactionalCta", () => {
  it("detects strong shipping CTAs", () => {
    const parsed: ParsedMail = {
      subject: "Ship your order",
      body: "Click here to ship your order",
    };
    expect(looksLikeTransactionalCta(parsed)).toBe(true);
  });

  it("detects renewal CTAs", () => {
    const parsed: ParsedMail = {
      subject: "Prescription renewal",
      body: "Your renewal is approved. Click to confirm.",
    };
    expect(looksLikeTransactionalCta(parsed)).toBe(true);
  });

  it("requires automated sender for soft CTAs", () => {
    const parsed: ParsedMail = {
      from: "support@example.com",
      subject: "Update preferences",
      body: "Click here to manage your preferences",
    };
    // Soft CTA without noreply From should not match
    expect(looksLikeTransactionalCta(parsed)).toBe(false);
  });
});

describe("looksLikePolicyBroadcast", () => {
  it("detects ToS update announcements", () => {
    const parsed: ParsedMail = {
      from: "legal@example.com",
      subject: "Terms of Service Updated",
      body: "We have updated our Terms of Service. The new version is live at...",
    };
    expect(looksLikePolicyBroadcast(parsed)).toBe(true);
  });

  it("rejects reply threads", () => {
    const parsed: ParsedMail = {
      from: "legal@example.com",
      subject: "Re: Terms of Service Updated",
      body: "We have updated our Terms of Service.",
    };
    expect(looksLikePolicyBroadcast(parsed)).toBe(false);
  });

  it("requires policy language", () => {
    const parsed: ParsedMail = {
      from: "legal@example.com",
      subject: "Updated",
      body: "We have updated something",
    };
    expect(looksLikePolicyBroadcast(parsed)).toBe(false);
  });
});
