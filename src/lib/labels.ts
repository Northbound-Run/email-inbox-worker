/** Fyxer-style categories — mirror hermes_inbox_organizer.labels */
export type InboundCategory =
  | "To Respond"
  | "FYI"
  | "Comment"
  | "Notification"
  | "Meeting Update"
  | "Marketing";

export const INBOUND_CATEGORIES: InboundCategory[] = [
  "To Respond",
  "FYI",
  "Comment",
  "Notification",
  "Meeting Update",
  "Marketing",
];

export function skipInbox(category: InboundCategory): boolean {
  return category !== "To Respond" && category !== "FYI";
}

export function labelName(category: InboundCategory): string {
  const order: Record<InboundCategory, number> = {
    "To Respond": 1,
    FYI: 2,
    Comment: 3,
    Notification: 4,
    "Meeting Update": 5,
    Marketing: 8,
  };
  return `${order[category]}: ${category}`;
}
