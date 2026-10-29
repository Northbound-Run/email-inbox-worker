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

/**
 * Returns all managed label names (source of truth).
 * These are the labels this system creates and controls.
 */
export function getManagedLabelNames(): string[] {
  return INBOUND_CATEGORIES.map((cat) => labelName(cat));
}

/**
 * Resolve managed label IDs from the label cache.
 * Returns a Map of label name → label ID for all managed labels that exist.
 */
export function resolveManagedLabelIds(
  cache: Map<string, string>,
): Map<string, string> {
  const managed = new Map<string, string>();
  for (const name of getManagedLabelNames()) {
    const id = cache.get(name);
    if (id) managed.set(name, id);
  }
  return managed;
}

/**
 * Enforce "at most one managed label" rule.
 * 
 * Given a label to add and the message's current labels, returns:
 * - addLabelIds: [labelIdToAdd]
 * - removeLabelIds: [all other managed label IDs present on the message] + [any additional remove IDs]
 * 
 * This ensures the message ends up with AT MOST ONE managed label.
 * Non-managed labels (user labels, Gmail system labels) are left untouched.
 * 
 * @param labelIdToAdd - The managed label ID to apply
 * @param currentLabelIds - The message's current label IDs
 * @param managedLabelIds - Map of managed label name → ID
 * @param additionalRemove - Optional additional label IDs to remove (e.g., INBOX)
 * @returns { addLabelIds, removeLabelIds } for Gmail messages.modify
 */
export function enforceOneManagedLabel(
  labelIdToAdd: string,
  currentLabelIds: string[],
  managedLabelIds: Map<string, string>,
  additionalRemove: string[] = [],
): { addLabelIds: string[]; removeLabelIds: string[] } {
  const removeLabelIds = new Set<string>(additionalRemove);
  
  // Find all managed labels currently on the message
  const allManagedIds = new Set(managedLabelIds.values());
  for (const currentId of currentLabelIds) {
    if (allManagedIds.has(currentId) && currentId !== labelIdToAdd) {
      removeLabelIds.add(currentId);
    }
  }
  
  return {
    addLabelIds: [labelIdToAdd],
    removeLabelIds: Array.from(removeLabelIds),
  };
}

/**
 * Compute thread-level managed labels to remove.
 * 
 * Given the label we're keeping (on the newest message) and all messages in the thread,
 * returns the set of managed label IDs to remove thread-wide.
 * 
 * @param keepLabelId - The managed label ID we're keeping (on the newest message)
 * @param threadMessages - All messages in the thread with their label IDs
 * @param managedLabelIds - Map of managed label name → ID
 * @returns Array of managed label IDs to remove from the thread
 */
export function computeThreadLabelsToRemove(
  keepLabelId: string,
  threadMessages: Array<{ id: string; labelIds: string[] }>,
  managedLabelIds: Map<string, string>,
): string[] {
  const allManagedIds = new Set(managedLabelIds.values());
  const labelsToRemove = new Set<string>();
  
  // Find all managed labels across all messages in the thread
  for (const msg of threadMessages) {
    for (const labelId of msg.labelIds) {
      if (allManagedIds.has(labelId) && labelId !== keepLabelId) {
        labelsToRemove.add(labelId);
      }
    }
  }
  
  return Array.from(labelsToRemove);
}
