import { describe, it, expect, beforeEach } from "vitest";
import {
  isGofoboEmail,
  extractGofoboClaimLink,
  extractDate,
  wasAlreadyForwarded,
  markForwarded,
  forwardGofoboEmail,
  type GofoboEnv,
} from "./gofobo";
import type { ParsedMail } from "./gmail";

describe("isGofoboEmail", () => {
  it("detects email from no-reply@gofobo.com", () => {
    expect(isGofoboEmail("no-reply@gofobo.com", "Any subject", "personal")).toBe(true);
    expect(isGofoboEmail("No-Reply@Gofobo.com", "Any subject", "personal")).toBe(true);
    expect(isGofoboEmail("<no-reply@gofobo.com>", "Any subject", "personal")).toBe(true);
  });

  it("detects email with subject containing 'Sign Up for Passes for'", () => {
    expect(isGofoboEmail("other@example.com", "Sign Up for Passes for Gladiator II", "personal")).toBe(true);
    expect(isGofoboEmail("other@example.com", "Sign Up for Passes for: Movie Title", "personal")).toBe(true);
  });

  it("rejects non-gofobo emails", () => {
    expect(isGofoboEmail("someone@example.com", "Regular email", "personal")).toBe(false);
    expect(isGofoboEmail("noreply@other.com", "Different subject", "personal")).toBe(false);
  });

  it("only checks personal mailbox", () => {
    expect(isGofoboEmail("no-reply@gofobo.com", "Any subject", "work")).toBe(false);
    expect(isGofoboEmail("no-reply@gofobo.com", "Sign Up for Passes for Movie", "work")).toBe(false);
  });
});

describe("extractGofoboClaimLink", () => {
  it("extracts http gofobo.com URL", () => {
    const body = "Click here to claim: http://gofobo.com/claim/abc123 to get your passes.";
    expect(extractGofoboClaimLink(body)).toBe("http://gofobo.com/claim/abc123");
  });

  it("extracts https gofobo.com URL", () => {
    const body = "Visit https://gofobo.com/screening/xyz789 for details.";
    expect(extractGofoboClaimLink(body)).toBe("https://gofobo.com/screening/xyz789");
  });

  it("extracts www.gofobo.com URL", () => {
    const body = "Go to https://www.gofobo.com/event/test123 to register.";
    expect(extractGofoboClaimLink(body)).toBe("https://www.gofobo.com/event/test123");
  });

  it("extracts first URL when multiple exist", () => {
    const body = "First: https://gofobo.com/first Second: https://gofobo.com/second";
    expect(extractGofoboClaimLink(body)).toBe("https://gofobo.com/first");
  });

  it("decodes HTML entities", () => {
    const body = "Link: https://gofobo.com/claim?id=123&amp;token=abc&quot;test&quot;";
    const result = extractGofoboClaimLink(body);
    expect(result).toBe('https://gofobo.com/claim?id=123&token=abc"test"');
  });

  it("handles URL with query parameters", () => {
    const body = "Visit https://gofobo.com/screening?event=123&user=456&promo=xyz";
    expect(extractGofoboClaimLink(body)).toBe("https://gofobo.com/screening?event=123&user=456&promo=xyz");
  });

  it("returns null when no gofobo URL found", () => {
    expect(extractGofoboClaimLink("No URLs here")).toBe(null);
    expect(extractGofoboClaimLink("https://example.com/other")).toBe(null);
    expect(extractGofoboClaimLink("")).toBe(null);
  });

  it("handles URLs in HTML content", () => {
    const html = '<a href="https://gofobo.com/claim/abc123">Claim Passes</a>';
    expect(extractGofoboClaimLink(html)).toBe("https://gofobo.com/claim/abc123");
  });
});

describe("extractDate", () => {
  it("extracts and formats Date header as ISO string", () => {
    const parsed: ParsedMail = {
      date: "Tue, 27 Oct 2026 19:30:00 +0000",
    };
    const result = extractDate(parsed);
    expect(result).toBe("2026-10-27T19:30:00.000Z");
  });

  it("falls back to internalDate when Date header is missing", () => {
    const parsed: ParsedMail = {
      internal_date: "1793129400000", // Tue, 27 Oct 2026 19:30:00 UTC
    };
    const result = extractDate(parsed);
    expect(result).toBe("2026-10-27T19:30:00.000Z");
  });

  it("prefers Date header over internalDate", () => {
    const parsed: ParsedMail = {
      date: "Tue, 27 Oct 2026 19:30:00 +0000",
      internal_date: "1730059900000", // Different time
    };
    const result = extractDate(parsed);
    expect(result).toBe("2026-10-27T19:30:00.000Z");
  });

  it("falls back to internalDate when Date header is invalid", () => {
    const parsed: ParsedMail = {
      date: "Invalid Date String",
      internal_date: "1793129400000",
    };
    const result = extractDate(parsed);
    expect(result).toBe("2026-10-27T19:30:00.000Z");
  });

  it("returns null when both are missing", () => {
    const parsed: ParsedMail = {};
    const result = extractDate(parsed);
    expect(result).toBe(null);
  });

  it("returns null when both are invalid", () => {
    const parsed: ParsedMail = {
      date: "Not a date",
      internal_date: "not a number",
    };
    const result = extractDate(parsed);
    expect(result).toBe(null);
  });

  it("handles various RFC 2822 date formats", () => {
    const formats = [
      { input: "Mon, 26 Oct 2026 12:00:00 -0700", expected: "2026-10-26T19:00:00.000Z" },
      { input: "26 Oct 2026 12:00:00 +0000", expected: "2026-10-26T12:00:00.000Z" },
      { input: "Mon, 26 Oct 26 12:00:00 GMT", expected: "2026-10-26T12:00:00.000Z" },
    ];

    formats.forEach(({ input, expected }) => {
      const parsed: ParsedMail = { date: input };
      const result = extractDate(parsed);
      expect(result).toBe(expected);
    });
  });
});

describe("dedupe KV operations", () => {
  // Mock KV namespace
  const mockKV = () => {
    const store = new Map<string, string>();
    return {
      get: async (key: string) => store.get(key) || null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    } as unknown as KVNamespace;
  };

  it("wasAlreadyForwarded returns false for new message", async () => {
    const kv = mockKV();
    expect(await wasAlreadyForwarded(kv, "msg123")).toBe(false);
  });

  it("wasAlreadyForwarded returns true after marking", async () => {
    const kv = mockKV();
    await markForwarded(kv, "msg123");
    expect(await wasAlreadyForwarded(kv, "msg123")).toBe(true);
  });

  it("handles undefined KV gracefully", async () => {
    expect(await wasAlreadyForwarded(undefined, "msg123")).toBe(false);
    await markForwarded(undefined, "msg123"); // should not throw
  });
});

describe("forwardGofoboEmail", () => {
  const mockParsed: ParsedMail = {
    id: "msg123",
    thread_id: "thread456",
    from: "no-reply@gofobo.com",
    subject: "Sign Up for Passes for Test Movie",
    body: "Visit https://gofobo.com/claim/abc123 to claim.",
    snippet: "Visit https://gofobo.com/claim/abc123 to claim.",
    date: "Tue, 27 Oct 2026 19:30:00 +0000",
    internal_date: "1793129400000",
  };

  it("skips when MOVIES_WEBHOOK_URL is missing", async () => {
    const env: GofoboEnv = {
      MOVIES_WEBHOOK_AUTH: "test-token",
    };
    const result = await forwardGofoboEmail(env, mockParsed);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("skips when MOVIES_WEBHOOK_AUTH is missing", async () => {
    const env: GofoboEnv = {
      MOVIES_WEBHOOK_URL: "https://example.com/webhook",
    };
    const result = await forwardGofoboEmail(env, mockParsed);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("returns error when messageId is missing", async () => {
    const env: GofoboEnv = {
      MOVIES_WEBHOOK_URL: "https://example.com/webhook",
      MOVIES_WEBHOOK_AUTH: "test-token",
    };
    const parsed = { ...mockParsed, id: undefined };
    const result = await forwardGofoboEmail(env, parsed);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing messageId");
  });

  it("builds correct payload with claimLink", async () => {
    let capturedPayload: any = null;
    let capturedHeaders: any = null;

    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      capturedPayload = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const mockKV = {
      get: async () => null,
      put: async () => {},
    } as unknown as KVNamespace;

    const env: GofoboEnv = {
      MOVIES_WEBHOOK_URL: "https://example.com/webhook",
      MOVIES_WEBHOOK_AUTH: "test-token",
      INBOX_STATE: mockKV,
    };

    const result = await forwardGofoboEmail(env, mockParsed);

    // Restore fetch
    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    expect(capturedPayload).toEqual({
      messageId: "msg123",
      threadId: "thread456",
      subject: "Sign Up for Passes for Test Movie",
      from: "no-reply@gofobo.com",
      date: "2026-10-27T19:30:00.000Z",
      snippet: "Visit https://gofobo.com/claim/abc123 to claim.",
      claimLink: "https://gofobo.com/claim/abc123",
    });
    expect(capturedHeaders).toEqual({
      "content-type": "application/json",
      authorization: "Bearer test-token",
    });
  });

  it("builds payload with null claimLink when no URL found", async () => {
    let capturedPayload: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedPayload = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const mockKV = {
      get: async () => null,
      put: async () => {},
    } as unknown as KVNamespace;

    const env: GofoboEnv = {
      MOVIES_WEBHOOK_URL: "https://example.com/webhook",
      MOVIES_WEBHOOK_AUTH: "test-token",
      INBOX_STATE: mockKV,
    };

    const parsed = { ...mockParsed, body: "No URLs here" };
    await forwardGofoboEmail(env, parsed);

    globalThis.fetch = originalFetch;

    expect(capturedPayload.claimLink).toBe(null);
    expect(capturedPayload.date).toBe("2026-10-27T19:30:00.000Z");
  });

  it("includes date from internalDate when Date header is missing", async () => {
    let capturedPayload: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedPayload = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const mockKV = {
      get: async () => null,
      put: async () => {},
    } as unknown as KVNamespace;

    const env: GofoboEnv = {
      MOVIES_WEBHOOK_URL: "https://example.com/webhook",
      MOVIES_WEBHOOK_AUTH: "test-token",
      INBOX_STATE: mockKV,
    };

    const parsed = { ...mockParsed, date: undefined };
    await forwardGofoboEmail(env, parsed);

    globalThis.fetch = originalFetch;

    expect(capturedPayload.date).toBe("2026-10-27T19:30:00.000Z");
  });

  it("includes null date when both Date header and internalDate are missing", async () => {
    let capturedPayload: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedPayload = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const mockKV = {
      get: async () => null,
      put: async () => {},
    } as unknown as KVNamespace;

    const env: GofoboEnv = {
      MOVIES_WEBHOOK_URL: "https://example.com/webhook",
      MOVIES_WEBHOOK_AUTH: "test-token",
      INBOX_STATE: mockKV,
    };

    const parsed = { ...mockParsed, date: undefined, internal_date: undefined };
    await forwardGofoboEmail(env, parsed);

    globalThis.fetch = originalFetch;

    expect(capturedPayload.date).toBe(null);
  });
});
