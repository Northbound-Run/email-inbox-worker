# Rough Cloudflare monthly cost

Estimates for running this Worker companion on Cloudflare (Workers + KV + Workers AI).  
**As of September 2026** — re-check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) before budgeting.

These are **order-of-magnitude** figures for a personal / small-team inbox (1–2 mailboxes), not a quote.

## What Cloudflare bills

| Component | Role in this app |
| --- | --- |
| Workers (Paid) | Pub/Sub push handler, history drain, label/archive, cron renew + reconcile, OAuth callbacks |
| Workers KV | Refresh tokens, history cursors, `woken:*` idempotency keys |
| Workers AI | Classifier when pre-classify does not decide (`CLASSIFIER_MODEL`, default `@cf/zai-org/glm-5.3-flash`) |

**Not** in this estimate: GCP Pub/Sub (usually free at this volume), Gmail API, or Grok Bot / Email draft wakes.

## Plan floor

Default model **`glm-5.3-flash` requires Workers Paid** (or prepaid AI Gateway credits). Paid is **$5 / month** per Cloudflare account and includes far more Workers requests, CPU-ms, and KV ops than a dual-mailbox inbox uses.

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Monthly base | $0 | **$5** |
| `glm-5.3-flash` | No | Yes |
| Llama fp8 classify | Yes (within daily Neurons) | Yes |
| Practical for this repo | Only with Free setup path (llama) + hard Neuron cap | Recommended |

Included Paid allotments (then cheap overages) that this app will almost never hit for 1–2 mailboxes:

- 10M Worker requests / mo  
- 30M CPU-ms / mo  
- KV: 10M reads, 1M writes/deletes/lists, 1 GB storage  

Cron alone is tiny (`0 14 * * *` watch renew + `20 */4 * * *` reconcile ≈ 7 invocations/day) plus Pub/Sub pushes. Treat **Worker + KV ≈ $5/mo floor** unless you run a large multi-tenant fleet.

## Workers AI (the real variable)

Free allocation: **10,000 Neurons / day** (Free and Paid). Paid overage: **$0.011 / 1,000 Neurons**. Cloudflare also publishes per-token list prices (same economics, easier to reason about):

| Model | Input | Output | Notes |
| --- | --- | --- | --- |
| `@cf/zai-org/glm-5.3-flash` (default) | $0.150 / M | $0.500 / M | Requires Paid |
| `@cf/meta/llama-3.1-8b-instruct-fp8` (fallback / Free setup) | $0.152 / M | $0.287 / M | OK on Free within Neuron cap |

Many messages never call the model (pre-classify Marketing / Notification, CC→FYI, 2FA / shipping detects). Cost scales with **LLM classify volume**, not raw inbox volume.

### Per-call assumption

Rough tokens per classify: **~3,000 input + ~200 output** (system prompt + subject/snippet/body excerpt → small JSON).

| Model | ≈ $ / call (list price) |
| --- | --- |
| glm-5.3-flash | ~$0.00055 |
| llama-3.1-8b-fp8 | ~$0.00051 |

Neuron ballpark for glm-5.3-flash ≈ **~50 Neurons / call** → daily free 10k Neurons ≈ **~200 free LLM calls / day** before Paid AI overage. Light and typical dual-mailbox days often stay inside that free pool.

## Monthly scenarios (Cloudflare only)

LLM classify calls only (not total inbound mail). AI column assumes list-price after free Neurons; many days may be $0 AI.

| Scenario | LLM calls (order of) | Workers Paid | Workers AI | **Rough total** |
| --- | --- | --- | --- | --- |
| **Light** — 1 mailbox, ~40 LLM/day | ~1,200 / mo | $5 | ~$0 (under free Neurons) | **~$5** |
| **Dual mailbox (typical)** — ~100 LLM/day | ~3,000 / mo | $5 | ~$0–2 (some days over free) | **~$5–7** |
| **Heavy** — ~300 LLM/day | ~9,000 / mo | $5 | ~$2–5 if much of volume bills | **~$7–10** |
| **Free + llama only** | capped by 10k Neurons/day | $0 | $0 until daily cap fails requests | **$0**, capped, no glm |

If every heavy call billed at list price with no free Neurons (worst-case math, not realistic): 9,000 × $0.00055 ≈ **$5** AI on top of the $5 Paid base → still about **~$10/mo**.

## Cost drivers (priority)

1. **How many messages need Workers AI** (pre-classify hit rate)  
2. **Model** (glm-5.3-flash vs llama fp8 — similar $/call; glm needs Paid)  
3. Prompt/body size (longer excerpts → more input tokens)  
4. Worker requests / KV — usually irrelevant at personal scale  

## Bottom line

For 1–2 mailboxes with default **glm-5.3-flash** on **Workers Paid**, expect about **$5–10 / month** on Cloudflare, most of which is the **$5 Paid base**. AI is usually a small adder because of the daily Neuron free allocation and because most mail never reaches the model.

Re-check Cloudflare’s pricing pages when models or Neuron allotments change.
