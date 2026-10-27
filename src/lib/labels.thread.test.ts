import { describe, it, expect } from "vitest";
import { computeThreadLabelsToRemove } from "./labels";

describe("computeThreadLabelsToRemove", () => {
  const managedLabelIds = new Map<string, string>([
    ["1: To Respond", "Label_ToRespond"],
    ["2: FYI", "Label_FYI"],
    ["3: Comment", "Label_Comment"],
    ["4: Notification", "Label_Notification"],
    ["5: Meeting Update", "Label_MeetingUpdate"],
    ["8: Marketing", "Label_Marketing"],
  ]);

  it("removes all managed labels except the one we're keeping", () => {
    const threadMessages = [
      {
        id: "msg1",
        labelIds: ["INBOX", "UNREAD", "Label_ToRespond"],
      },
      {
        id: "msg2",
        labelIds: ["Label_FYI", "Label_UserCustom"],
      },
      {
        id: "msg3",
        labelIds: ["Label_Marketing", "INBOX"],
      },
    ];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    expect(result).toContain("Label_FYI");
    expect(result).toContain("Label_Marketing");
    expect(result).not.toContain("Label_ToRespond");
    expect(result).not.toContain("INBOX");
    expect(result).not.toContain("Label_UserCustom");
    expect(result).toHaveLength(2);
  });

  it("returns empty array if only one managed label exists in thread", () => {
    const threadMessages = [
      {
        id: "msg1",
        labelIds: ["INBOX", "UNREAD", "Label_ToRespond"],
      },
      {
        id: "msg2",
        labelIds: ["Label_ToRespond", "Label_UserCustom"],
      },
      {
        id: "msg3",
        labelIds: ["INBOX"],
      },
    ];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    expect(result).toEqual([]);
  });

  it("handles thread with no managed labels", () => {
    const threadMessages = [
      {
        id: "msg1",
        labelIds: ["INBOX", "UNREAD", "Label_UserCustom"],
      },
      {
        id: "msg2",
        labelIds: ["Label_AnotherCustom"],
      },
    ];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    expect(result).toEqual([]);
  });

  it("handles thread with all managed labels", () => {
    const threadMessages = [
      {
        id: "msg1",
        labelIds: ["Label_ToRespond", "Label_FYI"],
      },
      {
        id: "msg2",
        labelIds: ["Label_Comment", "Label_Notification"],
      },
      {
        id: "msg3",
        labelIds: ["Label_MeetingUpdate", "Label_Marketing"],
      },
    ];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    // Should remove all except To Respond
    expect(result).toContain("Label_FYI");
    expect(result).toContain("Label_Comment");
    expect(result).toContain("Label_Notification");
    expect(result).toContain("Label_MeetingUpdate");
    expect(result).toContain("Label_Marketing");
    expect(result).not.toContain("Label_ToRespond");
    expect(result).toHaveLength(5);
  });

  it("preserves non-managed labels", () => {
    const threadMessages = [
      {
        id: "msg1",
        labelIds: [
          "INBOX",
          "UNREAD",
          "STARRED",
          "IMPORTANT",
          "Label_ToRespond",
          "Label_UserProject",
        ],
      },
      {
        id: "msg2",
        labelIds: [
          "Label_FYI",
          "Label_Marketing",
          "Label_Custom1",
          "Label_Custom2",
          "CATEGORY_PERSONAL",
        ],
      },
    ];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    // Should only return managed labels to remove
    expect(result).toContain("Label_FYI");
    expect(result).toContain("Label_Marketing");
    expect(result).not.toContain("INBOX");
    expect(result).not.toContain("STARRED");
    expect(result).not.toContain("Label_UserProject");
    expect(result).not.toContain("Label_Custom1");
    expect(result).toHaveLength(2);
  });

  it("handles empty thread", () => {
    const threadMessages: Array<{ id: string; labelIds: string[] }> = [];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    expect(result).toEqual([]);
  });

  it("handles messages with no labels", () => {
    const threadMessages = [
      {
        id: "msg1",
        labelIds: [],
      },
      {
        id: "msg2",
        labelIds: ["Label_ToRespond"],
      },
      {
        id: "msg3",
        labelIds: [],
      },
    ];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    expect(result).toEqual([]);
  });

  it("deduplicates labels across messages", () => {
    const threadMessages = [
      {
        id: "msg1",
        labelIds: ["Label_FYI", "Label_Marketing"],
      },
      {
        id: "msg2",
        labelIds: ["Label_FYI", "Label_Marketing"], // Same labels repeated
      },
      {
        id: "msg3",
        labelIds: ["Label_ToRespond"],
      },
    ];

    const result = computeThreadLabelsToRemove(
      "Label_ToRespond",
      threadMessages,
      managedLabelIds,
    );

    // Should only list each label once
    expect(result).toContain("Label_FYI");
    expect(result).toContain("Label_Marketing");
    expect(result).toHaveLength(2);
    
    // Verify no duplicates
    expect(new Set(result).size).toBe(result.length);
  });
});
