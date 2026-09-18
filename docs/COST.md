# Rough monthly cost (Cloudflare + OpenRouter)

Estimates for running this Worker companion: Cloudflare (Workers + KV) plus **OpenRouter** for classify.  
**As of September 2026** — re-check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [OpenRouter](https://openrouter.ai/models) before budgeting.

These are **order-of-magnitude** figures for a personal / small-team inbox (1–2 mailboxes), not a quote.

## What gets billed

| Component | Role in this app |
| --- | --- |
| Workers (Free or Paid) | Pub/Sub push handler, history drain, label/archive, cron renew + reconcile, OAuth callbacks |
| Workers KV | Refresh tokens, history cursors, `woken:*` idempotency keys |
| OpenRouter Decisions | Classifier when pre-classify does not decide (`CLASSIFIER_MODEL`, default `~typesafe/jev-latest`) |

**Not** in this estimate: GCP Pub/Sub (usually free at this volume), Gmail API, or Grok Bot / Email draft wakes.  
Workers AI is **no longer** required for classify.

## Cloudflare floor

This Worker no longer needs Workers Paid for a specific AI model. **Workers Free** is enough for light personal volume; **Workers Paid ($5 / month)** is still fine if you already use it for other Workers.

Cron alone is tiny (`0 14 * * *` watch renew + `20 */4 * * *` reconcile ≈ 7 invocations/day) plus Pub/Sub pushes. Treat **Worker + KV ≈ $0–5 / mo** depending on Free vs Paid.

## OpenRouter classify (the variable)

Default model: **`~typesafe/jev-latest`** via the OpenRouter Decisions API (TypeSafe Jev).  
Published list price is on the order of **~$0.042 / M input tokens** and **$0 / M output** (confirm on the [model page](https://openrouter.ai/~typesafe/jev-latest)).

Many messages never call the model (pre-classify Marketing / Notification, CC→FYI, 2FA / shipping detects). Cost scales with **LLM classify volume**, not raw inbox volume.

### Per-call assumption

Rough tokens per classify: **~2,000–4,000 input** (structured state: from/to/cc/subject/body excerpt + notes). Output is decision probabilities (billed as ~0 on Jev’s published output rate).

| | Ballpark |
| --- | --- |
| ≈ $ / LLM classify | **well under $0.001** at published Jev rates |
| 3,000 LLM calls / mo | **pennies to ~$1** (order-of-magnitude) |

## Monthly scenarios (Cloudflare + OpenRouter)

| Scenario | LLM calls (order of) | Cloudflare | OpenRouter | **Rough total** |
| --- | --- | --- | --- | --- |
| **Light** — 1 mailbox, ~40 LLM/day | ~1,200 / mo | $0–5 | << $1 | **~$0–6** |
| **Dual mailbox (typical)** — ~100 LLM/day | ~3,000 / mo | $0–5 | << $1 | **~$0–6** |
| **Heavy** — ~300 LLM/day | ~9,000 / mo | $0–5 | ~$1–3 | **~$1–8** |

## Cost drivers (priority)

1. **How many messages need the model** (pre-classify hit rate)  
2. Body excerpt size in the Decisions `state`  
3. OpenRouter model / pricing changes for `~typesafe/jev-latest`  
4. Worker requests / KV — usually irrelevant at personal scale  

## Bottom line

For 1–2 mailboxes with default **OpenRouter Jev**, expect **low single-digit dollars / month** total — often dominated by whether you pay the optional Workers Paid $5 base, not by classify.

Re-check OpenRouter and Cloudflare pricing when models or allotments change.
