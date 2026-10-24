import { describe, it, expect } from "vitest";
import {
  getManagedLabelNames,
  resolveManagedLabelIds,
  enforceOneManagedLabel,
  labelName,
  type InboundCategory,
} from "./labels";

describe("getManagedLabelNames", () => {
  it("returns all managed label names with correct prefixes", () => {
    const names = getManagedLabelNames();
    expect(names).toEqual([
      "1: To Respond",
      "2: FYI",
      "3: Comment",
      "4: Notification",
      "5: Meeting Update",
      "8: Marketing",
    ]);
  });

  it("returns a new array each time (not a shared reference)", () => {
    const names1 = getManagedLabelNames();
    const names2 = getManagedLabelNames();
    expect(names1).toEqual(names2);
    expect(names1).not.toBe(names2);
  });
});

describe("resolveManagedLabelIds", () => {
  it("resolves managed label IDs from cache", () => {
    const cache = new Map<string, string>([
      ["1: To Respond", "Label_123"],
      ["2: FYI", "Label_456"],
      ["Some User Label", "Label_999"],
      ["4: Notification", "Label_789"],
    ]);

    const managed = resolveManagedLabelIds(cache);

    expect(managed.size).toBe(3);
    expect(managed.get("1: To Respond")).toBe("Label_123");
    expect(managed.get("2: FYI")).toBe("Label_456");
    expect(managed.get("4: Notification")).toBe("Label_789");
    expect(managed.has("Some User Label")).toBe(false);
  });

  it("returns empty map when no managed labels exist in cache", () => {
    const cache = new Map<string, string>([
      ["Some User Label", "Label_999"],
      ["Another Label", "Label_888"],
    ]);

    const managed = resolveManagedLabelIds(cache);

    expect(managed.size).toBe(0);
  });

  it("handles empty cache", () => {
    const cache = new Map<string, string>();
    const managed = resolveManagedLabelIds(cache);
    expect(managed.size).toBe(0);
  });
});

describe("enforceOneManagedLabel", () => {
  const managedLabelIds = new Map<string, string>([
    ["1: To Respond", "Label_ToRespond"],
    ["2: FYI", "Label_FYI"],
    ["3: Comment", "Label_Comment"],
    ["4: Notification", "Label_Notification"],
    ["5: Meeting Update", "Label_MeetingUpdate"],
    ["8: Marketing", "Label_Marketing"],
  ]);

  it("applies new label and removes existing managed label", () => {
    const currentLabels = [
      "INBOX",
      "UNREAD",
      "Label_FYI", // existing managed label
      "Label_UserCustom",
    ];

    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
    );

    expect(result.addLabelIds).toEqual(["Label_ToRespond"]);
    expect(result.removeLabelIds).toEqual(["Label_FYI"]);
  });

  it("removes multiple existing managed labels", () => {
    const currentLabels = [
      "INBOX",
      "Label_FYI",
      "Label_Marketing",
      "Label_UserCustom",
    ];

    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
    );

    expect(result.addLabelIds).toEqual(["Label_ToRespond"]);
    expect(result.removeLabelIds).toContain("Label_FYI");
    expect(result.removeLabelIds).toContain("Label_Marketing");
    expect(result.removeLabelIds).toHaveLength(2);
  });

  it("preserves non-managed labels", () => {
    const currentLabels = [
      "INBOX",
      "UNREAD",
      "IMPORTANT",
      "CATEGORY_PERSONAL",
      "Label_UserCustom",
      "Label_AnotherCustom",
      "Label_FYI", // only managed label
    ];

    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
    );

    // Should only remove the FYI managed label, not any of the others
    expect(result.removeLabelIds).toEqual(["Label_FYI"]);
  });

  it("includes additionalRemove labels", () => {
    const currentLabels = [
      "INBOX",
      "Label_Marketing",
    ];

    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
      ["INBOX"], // archive
    );

    expect(result.addLabelIds).toEqual(["Label_ToRespond"]);
    expect(result.removeLabelIds).toContain("INBOX");
    expect(result.removeLabelIds).toContain("Label_Marketing");
    expect(result.removeLabelIds).toHaveLength(2);
  });

  it("does not remove the label being added", () => {
    const currentLabels = [
      "INBOX",
      "Label_ToRespond", // same as what we're adding
    ];

    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
    );

    expect(result.addLabelIds).toEqual(["Label_ToRespond"]);
    expect(result.removeLabelIds).toEqual([]);
  });

  it("handles message with no existing managed labels", () => {
    const currentLabels = [
      "INBOX",
      "UNREAD",
      "Label_UserCustom",
    ];

    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
    );

    expect(result.addLabelIds).toEqual(["Label_ToRespond"]);
    expect(result.removeLabelIds).toEqual([]);
  });

  it("handles message with no labels at all", () => {
    const currentLabels: string[] = [];

    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
    );

    expect(result.addLabelIds).toEqual(["Label_ToRespond"]);
    expect(result.removeLabelIds).toEqual([]);
  });

  it("complex scenario: multiple managed labels + archive + preserve user labels", () => {
    const currentLabels = [
      "INBOX",
      "UNREAD",
      "STARRED",
      "Label_ToRespond",
      "Label_FYI",
      "Label_Marketing",
      "Label_UserProject",
      "Label_Important",
      "CATEGORY_UPDATES",
    ];

    const result = enforceOneManagedLabel(
      "Label_Comment",
      currentLabels,
      managedLabelIds,
      ["INBOX"], // archive this Marketing message
    );

    expect(result.addLabelIds).toEqual(["Label_Comment"]);
    // Should remove INBOX + 3 other managed labels, but preserve all others
    expect(result.removeLabelIds).toContain("INBOX");
    expect(result.removeLabelIds).toContain("Label_ToRespond");
    expect(result.removeLabelIds).toContain("Label_FYI");
    expect(result.removeLabelIds).toContain("Label_Marketing");
    expect(result.removeLabelIds).toHaveLength(4);
  });

  it("deduplicates removeLabelIds", () => {
    const currentLabels = [
      "INBOX",
      "Label_FYI",
    ];

    // Pass INBOX in both currentLabels and additionalRemove
    const result = enforceOneManagedLabel(
      "Label_ToRespond",
      currentLabels,
      managedLabelIds,
      ["INBOX", "INBOX"], // duplicate INBOX
    );

    expect(result.addLabelIds).toEqual(["Label_ToRespond"]);
    const inboxCount = result.removeLabelIds.filter(id => id === "INBOX").length;
    expect(inboxCount).toBe(1); // should only appear once
  });
});

describe("labelName integration", () => {
  it("generates correct label names for all categories", () => {
    const categories: InboundCategory[] = [
      "To Respond",
      "FYI",
      "Comment",
      "Notification",
      "Meeting Update",
      "Marketing",
    ];

    const expected = [
      "1: To Respond",
      "2: FYI",
      "3: Comment",
      "4: Notification",
      "5: Meeting Update",
      "8: Marketing",
    ];

    categories.forEach((cat, i) => {
      expect(labelName(cat)).toBe(expected[i]);
    });
  });
});
