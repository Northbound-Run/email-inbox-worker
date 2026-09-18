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

## Status

- [x] Draft wake + OpenRouter Jev triage + CC hard gate  
- [x] OAuth capture on Worker (`/oauth/start`)  
- [x] Pub/Sub OIDC + history drain + `/watch`  
- [x] CLI installer (`npm run setup`) with workers.dev URL auto-detect  
- [x] Label apply / archive on Worker  
- [x] Watch Cron renew (`0 14 * * *` UTC + `POST /cron/renew-watches`)  
- [x] Multi-account (per-email KV + migrate legacy oauth:* keys)  
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
