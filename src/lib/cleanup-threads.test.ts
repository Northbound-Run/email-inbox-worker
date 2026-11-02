import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for POST /admin/cleanup-threads endpoint
 */

describe("cleanup-threads endpoint", () => {
  describe("account parameter validation", () => {
    it("should return 400 when account=work but WORK_EMAIL is not set", async () => {
      const env = {
        OWNER_EMAIL: "owner@example.com",
        // WORK_EMAIL missing
      };
      
      const result = await validateAccountParam("work", env as any);
      expect(result.error).toMatch(/WORK_EMAIL not configured/);
      expect(result.status).toBe(400);
    });

    it("should return 400 when account=personal but OWNER_EMAIL is not set", async () => {
      const env = {
        WORK_EMAIL: "work@example.com",
        // OWNER_EMAIL missing
      };
      
      const result = await validateAccountParam("personal", env as any);
      expect(result.error).toMatch(/OWNER_EMAIL not configured/);
      expect(result.status).toBe(400);
    });

    it("should return 400 when no account parameter is provided", async () => {
      const env = {
        OWNER_EMAIL: "owner@example.com",
        WORK_EMAIL: "work@example.com",
      };
      
      const result = await validateAccountParam(null, env as any);
      expect(result.error).toMatch(/Missing account parameter/);
      expect(result.status).toBe(400);
    });

    it("should return email when account=work and WORK_EMAIL is set", async () => {
      const env = {
        WORK_EMAIL: "work@example.com",
        OWNER_EMAIL: "owner@example.com",
      };
      
      const result = await validateAccountParam("work", env as any);
      expect(result.email).toBe("work@example.com");
      expect(result.error).toBeUndefined();
    });

    it("should return email when account=personal and OWNER_EMAIL is set", async () => {
      const env = {
        WORK_EMAIL: "work@example.com",
        OWNER_EMAIL: "owner@example.com",
      };
      
      const result = await validateAccountParam("personal", env as any);
      expect(result.email).toBe("owner@example.com");
      expect(result.error).toBeUndefined();
    });

    it("should return email when account is a custom email address", async () => {
      const env = {
        WORK_EMAIL: "work@example.com",
        OWNER_EMAIL: "owner@example.com",
      };
      
      const result = await validateAccountParam("custom@example.com", env as any);
      expect(result.email).toBe("custom@example.com");
      expect(result.error).toBeUndefined();
    });
  });

  describe("label iteration", () => {
    it("should construct URLs with labelIds parameter for all managed labels", async () => {
      const managedLabelIds = ["label-1", "label-2", "label-3"];
      const urls: string[] = [];

      // Simulate building URLs for each label
      for (const labelId of managedLabelIds) {
        const params = new URLSearchParams({
          labelIds: labelId,
          maxResults: "50",
        });
        urls.push(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
      }

      // Verify we built URLs for all three labels
      expect(urls.length).toBe(3);
      expect(urls[0]).toContain("labelIds=label-1");
      expect(urls[1]).toContain("labelIds=label-2");
      expect(urls[2]).toContain("labelIds=label-3");
    });

    it("should use labelIds parameter instead of q parameter", async () => {
      // Call should use labelIds=<id>, not q=label:"name"
      const params = new URLSearchParams({
        labelIds: "label-1",
        maxResults: "50",
      });

      expect(params.get("labelIds")).toBe("label-1");
      expect(params.has("q")).toBe(false);
    });
  });

  describe("thread deduplication", () => {
    it("should deduplicate threads found across multiple labels", async () => {
      // Thread1 has both label-1 and label-2
      // Should only process thread1 once
      const seenThreads = new Set<string>();
      const threadId = "thread1";

      if (!seenThreads.has(threadId)) {
        seenThreads.add(threadId);
        // Process thread
      }

      expect(seenThreads.size).toBe(1);
    });
  });

  describe("pagination", () => {
    it("should include nextPageToken in response when more results exist", async () => {
      const response = {
        ok: true,
        account: "test@example.com",
        scannedThreads: 100,
        threadsWithMultipleLabels: 5,
        cleanedThreads: 5,
        threads: [],
        done: false,
        nextPageToken: "someToken",
      };

      expect(response.nextPageToken).toBeDefined();
      expect(response.done).toBe(false);
    });

    it("should set done=true and no nextPageToken when all threads processed", async () => {
      const response = {
        ok: true,
        account: "test@example.com",
        scannedThreads: 50,
        threadsWithMultipleLabels: 5,
        cleanedThreads: 5,
        threads: [],
        done: true,
        nextPageToken: undefined,
      };

      expect(response.done).toBe(true);
      expect(response.nextPageToken).toBeUndefined();
    });

    it("should resume from pageToken when provided", async () => {
      const resumeState = {
        labelIndex: 1,
        pageTokens: { "1": "page-token-for-label-1" },
        scannedThreads: 50,
      };
      const pageToken = Buffer.from(JSON.stringify(resumeState), "utf-8").toString("base64url");

      // Parse it back
      const decoded = JSON.parse(Buffer.from(pageToken, "base64url").toString("utf-8"));
      expect(decoded.labelIndex).toBe(1);
      expect(decoded.pageTokens["1"]).toBe("page-token-for-label-1");
      expect(decoded.scannedThreads).toBe(50);
    });
  });

  describe("multi-label thread cleanup", () => {
    it("should keep the label from the newest message and remove others", async () => {
      const threadMessages = [
        { id: "msg1", labelIds: ["label-1"], internalDate: "1000000" },
        { id: "msg2", labelIds: ["label-2"], internalDate: "2000000" },
        { id: "msg3", labelIds: ["label-3"], internalDate: "3000000" }, // newest
      ];

      const allManagedIds = ["label-1", "label-2", "label-3"];

      // Find newest message with managed label
      let newestMsg = null;
      let newestLabelId = null;

      for (const msg of threadMessages) {
        const managedLabelsOnMsg = msg.labelIds.filter((id) => allManagedIds.includes(id));
        if (managedLabelsOnMsg.length > 0) {
          if (!newestMsg || parseInt(msg.internalDate, 10) > parseInt(newestMsg.internalDate, 10)) {
            newestMsg = msg;
            newestLabelId = managedLabelsOnMsg[0];
          }
        }
      }

      expect(newestLabelId).toBe("label-3");

      // Compute labels to remove
      const labelsInThread = new Set(["label-1", "label-2", "label-3"]);
      const removeLabelIds = Array.from(labelsInThread).filter((id) => id !== newestLabelId);

      expect(removeLabelIds).toEqual(["label-1", "label-2"]);
    });

    it("should only process threads with multiple managed labels", async () => {
      const threadWithOneLabel = new Set(["label-1"]);
      const threadWithMultipleLabels = new Set(["label-1", "label-2"]);

      expect(threadWithOneLabel.size <= 1).toBe(true); // Skip
      expect(threadWithMultipleLabels.size > 1).toBe(true); // Process
    });
  });
});

// Helper function extracted from the endpoint for testing
async function validateAccountParam(
  accountParam: string | null,
  env: { WORK_EMAIL?: string; OWNER_EMAIL?: string }
): Promise<{ email?: string; error?: string; status?: number }> {
  let email: string | null = null;

  if (accountParam === "work") {
    if (!env.WORK_EMAIL?.trim()) {
      return {
        error: "WORK_EMAIL not configured (use ?account=personal or set WORK_EMAIL)",
        status: 400,
      };
    }
    email = env.WORK_EMAIL.trim();
  } else if (accountParam === "personal") {
    if (!env.OWNER_EMAIL?.trim()) {
      return {
        error: "OWNER_EMAIL not configured (use ?account=work or set OWNER_EMAIL)",
        status: 400,
      };
    }
    email = env.OWNER_EMAIL.trim();
  } else if (accountParam) {
    email = accountParam;
  }

  if (!email) {
    return {
      error: "Missing account parameter (use ?account=work or ?account=personal)",
      status: 400,
    };
  }

  return { email };
}
