# Label Cleanup Guide

## Background

Prior to the single-label enforcement update, messages could accumulate multiple managed labels (e.g., both "1: To Respond" and "2: FYI"). The Worker now enforces that any message it touches has **at most one** managed label.

**Thread-level enforcement:** Since Gmail shows labels at the thread level as the union of all messages' labels, the Worker also cleans up the entire thread when processing a message. This ensures that the thread only shows one managed label in the Gmail UI.

This document describes how to perform a one-off cleanup of existing multi-labeled threads.

## Managed Labels

The system manages these labels:

- `1: To Respond`
- `2: FYI`
- `3: Comment`
- `4: Notification`
- `5: Meeting Update`
- `8: Marketing`

## Admin Cleanup Endpoint

The easiest way to clean up existing multi-labeled threads is to use the built-in admin endpoint:

```bash
# Clean up the work account
curl -X POST "https://your-worker.workers.dev/admin/cleanup-threads?account=work&maxThreads=100" \
  -H "Content-Type: application/json"

# Clean up the personal account
curl -X POST "https://your-worker.workers.dev/admin/cleanup-threads?account=personal&maxThreads=100" \
  -H "Content-Type: application/json"

# Continue from a previous incomplete run using the returned nextPageToken
curl -X POST "https://your-worker.workers.dev/admin/cleanup-threads?account=personal&pageToken=eyJsYWJlbEluZGV4IjoxfQ" \
  -H "Content-Type: application/json"
```

**Requirements:**
- Must set `ALLOW_DEBUG=1` environment variable (same gate as `/debug` routes)
- Specify `account=work` or `account=personal` (or a specific email address)
- Returns a 400 error if `WORK_EMAIL` is not set when using `account=work`, or `OWNER_EMAIL` when using `account=personal`

**Parameters:**
- `account` (required): `work`, `personal`, or a specific email address
- `pageSize` (optional): Messages per page, max 100, default 50
- `maxThreads` (optional): Max threads to scan per call, max 500, default 100
- `pageToken` (optional): Resume token from a previous response to continue scanning

**Response:**
```json
{
  "ok": true,
  "account": "matt@northbound.run",
  "scannedThreads": 47,
  "threadsWithMultipleLabels": 3,
  "cleanedThreads": 3,
  "threads": [
    {
      "threadId": "1a1410a47c724a08",
      "kept": "1: To Respond",
      "removed": ["2: FYI"]
    }
  ],
  "done": true,
  "nextPageToken": null
}
```

**Response fields:**
- `done`: `true` if all threads have been scanned, `false` if more remain
- `nextPageToken`: Present when `done=false`; pass it back as `?pageToken=...` to continue scanning
- `scannedThreads`: Total threads examined in this call (deduped across all managed labels)
- `threadsWithMultipleLabels`: How many had conflicts
- `cleanedThreads`: How many were actually modified

**How it works:**
1. Iterates over ALL managed label IDs (not just the first one) using the `labelIds` query parameter
2. Scans messages with each managed label, deduplicating threads across labels
3. Identifies threads where multiple managed labels exist across messages
4. Keeps the label on the newest labeled message in each thread (by `internalDate`)
5. Removes all other managed labels thread-wide using `threads.modify`
6. Returns `nextPageToken` when `maxThreads` is reached mid-scan, allowing pagination
7. Idempotent: safe to run multiple times

**Pagination:** When you hit the `maxThreads` limit mid-scan, the response includes `nextPageToken` and `done: false`. Call again with `?pageToken=<token>` to continue from where you left off. The token encodes which label you were scanning and the Gmail API page token, so you can resume across Worker invocations without re-scanning threads.

**CPU limits:** The endpoint is paginated to stay within Worker CPU limits. For large mailboxes:
1. Call with `maxThreads=100` (or higher)
2. If `done: false`, call again with the returned `nextPageToken`
3. Repeat until `done: true`

**Example full scan:**
```bash
# First call
RESPONSE=$(curl -X POST "https://your-worker.workers.dev/admin/cleanup-threads?account=personal&maxThreads=100")
TOKEN=$(echo $RESPONSE | jq -r '.nextPageToken')

# Continue while nextPageToken is present
while [ "$TOKEN" != "null" ]; do
  RESPONSE=$(curl -X POST "https://your-worker.workers.dev/admin/cleanup-threads?account=personal&pageToken=$TOKEN")
  TOKEN=$(echo $RESPONSE | jq -r '.nextPageToken')
  echo "Cleaned $(echo $RESPONSE | jq -r '.cleanedThreads') threads"
done
```

## Manual Implementation Approach

If you prefer a custom script instead of the admin endpoint:

### 1. Search Query

Use Gmail's `users.messages.list` with the `labelIds` parameter (NOT the `q` search query) to find messages with managed labels:

```typescript
// For each managed label ID
const params = new URLSearchParams({
  labelIds: labelId,  // Use label ID, not name
  maxResults: "100",
});

const response = await fetch(
  `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
  { headers: { authorization: `Bearer ${accessToken}` } }
);
```

**Why labelIds instead of q?**
- Label names may contain spaces or special characters (e.g., "1: To Respond")
- Nested labels use "/" separators in display names (e.g., "Parent/To Respond")
- Gmail's search syntax with `q=label:"name"` can fail on these patterns
- Using `labelIds` is more reliable and avoids search syntax issues

**You must iterate over ALL managed label IDs**, not just the first one, and deduplicate threads across labels to get accurate results.

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
  
  // 3. For each managed label, search messages using labelIds parameter
  const affectedThreads = new Map<string, string[]>(); // threadId → labelIds
  const seenThreads = new Set<string>();
  
  const allManagedIds = Array.from(managedIds.values());
  
  for (const labelId of allManagedIds) {
    // Use labelIds parameter, not q search
    const params = new URLSearchParams({
      labelIds: labelId,
      maxResults: "500",
    });
    
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } }
    );
    const data = await resp.json();
    
    for (const msg of data.messages || []) {
      const threadId = msg.threadId;
      if (seenThreads.has(threadId)) continue; // Dedupe across labels
      seenThreads.add(threadId);
      
      // Get all messages in thread
      const threadResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      );
      const threadData = await threadResp.json();
      
      // Find all managed labels across thread
      const labelsInThread = new Set<string>();
      for (const threadMsg of threadData.messages || []) {
        const currentLabels = threadMsg.labelIds || [];
        for (const labelId of currentLabels) {
          if (allManagedIds.includes(labelId)) {
            labelsInThread.add(labelId);
          }
        }
      }
      
      // Only process if thread has multiple managed labels
      if (labelsInThread.size > 1) {
        affectedThreads.set(threadId, Array.from(labelsInThread));
      }
    }
  }
  
  // 4. For each affected thread, find newest message and determine which label to keep
  for (const [threadId, labelIds] of affectedThreads.entries()) {
    const threadResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata`,
      { headers: { authorization: `Bearer ${accessToken}` } }
    );
    const threadData = await threadResp.json();
    
    // Find newest message with a managed label
    let newestMsg: any = null;
    let newestLabelId: string | null = null;
    
    for (const msg of threadData.messages || []) {
      const managedLabelsOnMsg = (msg.labelIds || []).filter((id: string) => 
        allManagedIds.includes(id)
      );
      if (managedLabelsOnMsg.length > 0) {
        if (!newestMsg || parseInt(msg.internalDate, 10) > parseInt(newestMsg.internalDate, 10)) {
          newestMsg = msg;
          newestLabelId = managedLabelsOnMsg[0];
        }
      }
    }
    
    if (!newestLabelId) continue;
    
    // Remove all other managed labels from thread
    const toRemove = labelIds.filter(id => id !== newestLabelId);
    if (toRemove.length === 0) continue;
    
    await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          removeLabelIds: toRemove,
        }),
      }
    );
    
    console.log(`Cleaned thread ${threadId}: kept ${newestLabelId}, removed ${toRemove.length} labels`);
  }
  
  console.log(`Total threads cleaned: ${affectedThreads.size}`);
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
