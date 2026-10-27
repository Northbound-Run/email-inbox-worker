# email-inbox-worker

Cloudflare Worker companion for the **Email** Grok Bot (Hermes-style inbox organizer).

**Worker** does cheap triage (pre-classify, OpenRouter Jev classify, CC→FYI, 2FA/shipping, Pub/Sub Push, history drain).  
**Email bot** wakes only for `To Respond` and writes **unsent** Gmail drafts.

## Install

Prereqs: Node 20+, [gcloud](https://cloud.google.com/sdk/docs/install) (`gcloud auth login`), Cloudflare account (Wrangler will open a browser login if needed), and an [OpenRouter](https://openrouter.ai/keys) API key for classify.

```bash
git clone git@github.com:Northbound-Run/email-inbox-worker.git
cd email-inbox-worker
npm install
npm run setup
```

`npm run setup` automates GCP + Cloudflare. After deploy it **auto-detects** your `https://….workers.dev` URL (from deploy stdout, then Cloudflare workers subdomain API). Pass `--worker-url` only to override.

Default OAuth is **link-in-browser**: setup prints `/oauth/start` — open it, approve Gmail in the browser, then arm watch.

### What setup does

1. Enable Gmail + Pub/Sub APIs on your GCP project  
2. Create topic + grant `gmail-api-push` Publisher  
3. Create a push-auth service account + token-creator binding  
4. Set `CLASSIFIER_MODEL` to `~typesafe/jev-latest` and collect `OPENROUTER_API_KEY`  
5. `wrangler deploy` the Worker (KV) and detect the workers.dev URL  
6. Set secrets (OpenRouter key, Grok webhook URL/key, OAuth client, topic, push audience)  
7. Create/update the **Push** subscription → Worker `/pubsub` (OIDC)  
8. Print the OAuth redirect URI + `/oauth/start` link  

Then you only:

1. Add the printed redirect URI to your Google OAuth **Web** client  
2. Open `/oauth/start` in the browser and approve Gmail  
3. `npm run setup -- --watch-only` (URL auto-detected; or `--worker-url https://…workers.dev`)

### Non-interactive

```bash
OPENROUTER_API_KEY='sk-or-…' npm run setup -- \
  --project my-gcp-project \
  --topic email-inbox-notifications \
  --webhook-url 'https://…' \
  --webhook-key '…' \
  --client-id '….apps.googleusercontent.com' \
  --client-secret '…' \
  --worker-url 'https://email-webhook-spike.<subdomain>.workers.dev' \
  --yes
```

`--worker-url` is optional when auto-detect succeeds.

## Cost (Cloudflare + OpenRouter)

Rough monthly estimate for Workers + KV + OpenRouter classify: see [docs/COST.md](docs/COST.md).  
Typical 1–2 mailboxes: about **a few dollars / month** (Workers Free often enough; classify is OpenRouter Jev).

## Architecture

| Layer | Owns |
|---|---|
| Worker | Pub/Sub Push (OIDC), history drain, pre-classify, OpenRouter Jev classify, CC→FYI, detects, KV cursor |
| Email bot | Webhook wake only for To Respond → unsent draft |

## Label Management

The Worker applies **managed labels** to categorize incoming mail:

- `1: To Respond`
- `2: FYI`
- `3: Comment`
- `4: Notification`
- `5: Meeting Update`
- `8: Marketing`

**Enforced rule:** Any message modified by the Worker ends up with **at most one** managed label.

- When applying a new managed label, all other managed labels are removed in the same Gmail API call
- Non-managed labels (user labels, Gmail system labels like `INBOX`/`UNREAD`/`STARRED`) are preserved
- Labels are created lazily on first use per account
- Multi-account: label IDs are resolved independently per mailbox email

See `src/lib/labels.ts` for the centralized enforcement logic.

## Status

- [x] Draft wake + OpenRouter Jev triage + CC hard gate  
- [x] OAuth capture on Worker (`/oauth/start`)  
- [x] Pub/Sub OIDC + history drain + `/watch`  
- [x] CLI installer (`npm run setup`) with workers.dev URL auto-detect  
- [x] Label apply / archive on Worker  
- [x] Single managed label enforcement  
- [x] Watch Cron renew (`0 14 * * *` UTC + `POST /cron/renew-watches`)  
- [x] Multi-account (per-email KV + migrate legacy oauth:* keys)  
- [x] Gofobo screening pass fast-path forwarding (optional)  
- [ ] Grok Bot marketplace template export  

## Multi-account + watch renew

KV scheme:

| Key | Value |
|---|---|
| `mailbox:<email>:refresh_token` | OAuth refresh token |
| `mailbox:<email>:cursor` | Gmail history cursor |
| `mailbox:<email>:watch_expiration` | users.watch expiry (ms string) |
| `mailboxes` | JSON array of emails |

Legacy `oauth:refresh_token` / `oauth:email` / `cursor:<email>` migrate on read.

Add a second mailbox: open `/oauth/start` signed into that Google account (optional `?account=work`).  
Map wake account via secrets/vars `OWNER_EMAIL` / `WORK_EMAIL`.  
Cron renews watch daily; does **not** advance cursors past unprocessed mail.

## Optional: Gofobo Screening Pass Forwarding

The Worker can detect and immediately forward Gofobo screening pass emails to a separate webhook endpoint, before any LLM classification. This is a fast-path for personal mailbox messages only.

### Setup

Set two Worker secrets (both are required for forwarding to activate):

```bash
wrangler secret put MOVIES_WEBHOOK_URL
# Enter: https://your-endpoint.example.com/gofobo

wrangler secret put MOVIES_WEBHOOK_AUTH
# Enter: your-bearer-token
```

### Detection

Messages are forwarded when:
- From address is `no-reply@gofobo.com`, OR
- Subject contains `"Sign Up for Passes for"`

AND the message is in the **personal** mailbox (not work).

### Forwarding

On match, the Worker immediately POSTs JSON to `MOVIES_WEBHOOK_URL` with header `Authorization: Bearer ${MOVIES_WEBHOOK_AUTH}`:

```json
{
  "messageId": "msg-id",
  "threadId": "thread-id",
  "subject": "Sign Up for Passes for Gladiator II",
  "from": "no-reply@gofobo.com",
  "date": null,
  "snippet": "...",
  "claimLink": "https://gofobo.com/claim/abc123"
}
```

- `claimLink` is the first `gofobo.com` URL found in the message body (text or HTML, decoded), or `null` if none.
- Dedupe: the same `messageId` is never forwarded twice (KV with 30-day TTL).
- Failures are logged but do **not** block normal labeling.
- If either secret is missing, forwarding is silently skipped.
