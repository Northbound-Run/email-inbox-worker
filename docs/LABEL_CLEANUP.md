# Label Cleanup Guide

## Background

Prior to the single-label enforcement update, messages could accumulate multiple managed labels (e.g., both "1: To Respond" and "2: FYI"). The Worker now enforces that any message it touches has **at most one** managed label.

This document describes how to perform a one-off cleanup of existing multi-labeled messages.

## Managed Labels

The system manages these labels:

- `1: To Respond`
- `2: FYI`
- `3: Comment`
- `4: Notification`
- `5: Meeting Update`
- `8: Marketing`

## Strategy

A one-off cleanup script should:

1. **List all managed labels** and resolve their IDs for each account
2. **Search for messages** with multiple managed labels using Gmail API
3. **Apply a resolution policy** to determine which label to keep
4. **Batch update** messages to enforce single-label state

## Implementation Approach

### 1. Search Query

Use Gmail's `users.messages.list` with a query to find messages with multiple managed labels:

```
label:"1: To Respond" AND (label:"2: FYI" OR label:"3: Comment" OR label:"4: Notification" OR label:"5: Meeting Update" OR label:"8: Marketing")
```

You'll need to construct similar queries for each combination, or fetch all messages with any managed label and filter programmatically.

### 2. Resolution Policy

**Recommended policy: Keep the highest-priority label**

Priority order (highest to lowest):
1. `To Respond` (most actionable)
2. `FYI` (needs review)
3. `Comment` (lower urgency)
4. `Meeting Update` (informational)
5. `Notification` (automated)
6. `Marketing` (lowest priority)

For a message with both "To Respond" and "FYI", keep "To Respond" and remove "FYI".

### 3. Batch Processing

Use Gmail's `users.messages.batchModify` (up to 1000 message IDs per call):

```typescript
POST https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify
{
  "ids": ["msg1", "msg2", ...],
  "removeLabelIds": ["Label_FYI", "Label_Comment"]
}
```

**Important:** Do NOT use `addLabelIds` — we're only removing labels, keeping the highest-priority one that's already present.

### 4. Example Cleanup Script

```typescript
// Pseudocode - not production ready
import { getAccessToken, listUserLabels } from "./src/lib/gmail";
import { getManagedLabelNames } from "./src/lib/labels";

async function cleanupMultiLabeled(accessToken: string) {
  // 1. Build label name → ID map
  const labels = await listUserLabels(accessToken);
  const cache = new Map(labels.map(l => [l.name, l.id]));
  
  const managedNames = getManagedLabelNames();
  const managedIds = new Map<string, string>();
  for (const name of managedNames) {
    const id = cache.get(name);
    if (id) managedIds.set(name, id);
  }
  
  // 2. Priority order (highest to lowest)
  const priority = [
    "1: To Respond",
    "2: FYI",
    "3: Comment",
    "5: Meeting Update",
    "4: Notification",
    "8: Marketing",
  ];
  
  // 3. For each managed label, search messages
  const affectedMessages = new Map<string, string[]>(); // messageId → labelIds
  
  for (const labelName of managedNames) {
    const labelId = managedIds.get(labelName);
    if (!labelId) continue;
    
    // Search: label:<labelName>
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=label:${encodeURIComponent(labelName)}&maxResults=500`,
      { headers: { authorization: `Bearer ${accessToken}` } }
    );
    const data = await resp.json();
    
    for (const msg of data.messages || []) {
      const fullMsg = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      );
      const msgData = await fullMsg.json();
      const currentLabels = msgData.labelIds || [];
      
      // Count how many managed labels this message has
      const managedOnMsg = currentLabels.filter(id => 
        Array.from(managedIds.values()).includes(id)
      );
      
      if (managedOnMsg.length > 1) {
        affectedMessages.set(msg.id, managedOnMsg);
      }
    }
  }
  
  // 4. Resolve which label to keep for each message
  const batches = new Map<string, string[]>(); // removeLabelIds → messageIds[]
  
  for (const [messageId, labelIds] of affectedMessages.entries()) {
    // Find highest-priority label
    let keepLabel: string | null = null;
    for (const labelName of priority) {
      const labelId = managedIds.get(labelName);
      if (labelId && labelIds.includes(labelId)) {
        keepLabel = labelId;
        break;
      }
    }
    
    // Remove all others
    const toRemove = labelIds.filter(id => id !== keepLabel);
    if (toRemove.length === 0) continue;
    
    const key = toRemove.sort().join(",");
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key)!.push(messageId);
  }
  
  // 5. Execute batch updates
  for (const [removeKey, messageIds] of batches.entries()) {
    const removeLabelIds = removeKey.split(",");
    
    // Process in chunks of 1000
    for (let i = 0; i < messageIds.length; i += 1000) {
      const chunk = messageIds.slice(i, i + 1000);
      
      await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ids: chunk,
            removeLabelIds,
          }),
        }
      );
      
      console.log(`Cleaned ${chunk.length} messages (removed ${removeLabelIds.length} labels)`);
    }
  }
  
  console.log(`Total messages cleaned: ${affectedMessages.size}`);
}
```

## Safety Considerations

1. **Test on a small batch first** — modify the script to process only 10-20 messages initially
2. **Backup approach** — Gmail doesn't offer easy label rollback, but you can export affected message IDs and their label states before cleanup
3. **Rate limits** — Gmail API has quota limits; add delays between batch calls if processing thousands of messages
4. **Dry run mode** — Log what would be changed without actually calling `batchModify`
5. **Multi-account** — Run the cleanup separately for each mailbox email

## When to Run

- **After deploying the Worker update** — the enforcement now happens on all new/processed messages
- **One-time only** — once cleaned up, the Worker prevents multi-labeling going forward
- **Optional** — existing multi-labeled messages don't break anything; they'll be cleaned up automatically when the Worker re-processes them (e.g., during reconciliation)

## Alternative: Reconciler-Driven Cleanup

Instead of a separate script, you could rely on the **reconciler cron** (`/cron/reconcile`) to gradually clean up messages as it re-processes the inbox. This is slower but requires no additional code — the reconciler will naturally apply the single-label enforcement to all messages it touches.

To trigger a full reconcile:

```bash
curl -X POST https://your-worker.workers.dev/cron/reconcile
```

This drains history for all mailboxes and re-processes inbox messages, enforcing single-label state as it goes.
