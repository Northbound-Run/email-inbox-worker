#!/usr/bin/env node
/**
 * One-shot installer for marketplace users.
 * Automates Cloudflare (wrangler) + GCP (gcloud) setup for the Email inbox Worker.
 *
 * Usage:
 *   npm run setup
 *   npm run setup -- --project northbound-run --webhook-url URL --webhook-key KEY
 *   npm run setup -- --plan paid|free   # skip detect; pick CLASSIFIER_MODEL
 *   npm run setup -- --watch-only       # after OAuth success page
 *   npm run setup -- --worker-url URL   # override auto-detected workers.dev URL
 *
 * Requires: node 20+, gcloud (authenticated), wrangler (via npx), Cloudflare login.
 * CLASSIFIER_MODEL: Paid → @cf/zai-org/glm-5.3-flash; Free → @cf/meta/llama-3.1-8b-instruct-fp8
 * Plan detect: GET /accounts/{id}/subscriptions (needs #billing:read). Wrangler OAuth
 * usually 403s → we prompt Free vs Paid. Optional: CLOUDFLARE_API_TOKEN with billing read.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
process.chdir(ROOT);

const args = parseArgs(process.argv.slice(2));
const rl = createInterface({ input, output });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--watch-only") out.watchOnly = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || guessPython() },
  });
  if (res.status !== 0 && !opts.allowFail) {
    const err = (res.stderr || res.stdout || "").toString().slice(-800);
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed\n${err}`);
  }
  return res;
}

function runCapture(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    env: { ...process.env, CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || guessPython() },
  });
  return {
    status: res.status ?? 1,
    out: `${res.stdout || ""}${res.stderr || ""}`.trim(),
  };
}

function guessPython() {
  for (const p of [
    process.env.CLOUDSDK_PYTHON,
    "/Users/matt/.local/bin/python3.11",
    "/opt/homebrew/bin/python3.11",
    "/usr/bin/python3",
  ]) {
    if (p && existsSync(p)) return p;
  }
  return "python3";
}

async function ask(prompt, fallback = "") {
  if (args.yes && fallback) return fallback;
  const hint = fallback ? ` [${fallback}]` : "";
  const ans = (await rl.question(`${prompt}${hint}: `)).trim();
  return ans || fallback;
}

function need(bin, installHint) {
  const r = runCapture(bin, ["--version"]);
  if (r.status !== 0) {
    throw new Error(`Missing ${bin}. ${installHint}`);
  }
  console.log(`✓ ${bin}: ${r.out.split("\n")[0]}`);
}

function wrangler(argsList, opts) {
  return run("npx", ["wrangler", ...argsList], opts);
}

function gcloud(argsList, opts) {
  return run("gcloud", argsList, opts);
}

function secretPut(name, value) {
  const res = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    encoding: "utf8",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`Failed to put secret ${name}: ${res.stderr || res.stdout}`);
  }
  console.log(`✓ secret ${name}`);
}

const MODEL_PAID = "@cf/zai-org/glm-5.3-flash";
const MODEL_FREE = "@cf/meta/llama-3.1-8b-instruct-fp8";

function wranglerAccountId() {
  const who = runCapture("npx", ["wrangler", "whoami"]);
  const ids = [...who.out.matchAll(/\b([a-f0-9]{32})\b/gi)].map((m) => m[1].toLowerCase());
  if (ids.length) return ids[0];
  return process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || null;
}

function readCloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN?.trim()) return process.env.CLOUDFLARE_API_TOKEN.trim();
  const homes = [
    join(process.env.HOME || "", "Library/Preferences/.wrangler/config/default.toml"),
    join(process.env.HOME || "", ".wrangler/config/default.toml"),
    join(process.env.HOME || "", ".config/.wrangler/config/default.toml"),
  ];
  for (const p of homes) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    const m = raw.match(/oauth_token\s*=\s*"([^"]+)"/) || raw.match(/oauth_token\s*=\s*'([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

/** @returns {Promise<{plan: "paid"|"free"|"unknown", source: string, model: string}>} */
async function resolveClassifierPlan() {
  if (args.classifierModel) {
    return { plan: "unknown", source: "flag --classifier-model", model: String(args.classifierModel) };
  }
  if (args.plan === "paid" || args.plan === "free") {
    return {
      plan: args.plan,
      source: "flag --plan",
      model: args.plan === "paid" ? MODEL_PAID : MODEL_FREE,
    };
  }

  const accountId = wranglerAccountId();
  const token = readCloudflareToken();
  if (accountId && token) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (res.status === 403 || res.status === 401) {
        console.log("⚠ Cloudflare subscriptions API needs Account Settings: Read (#billing:read).");
        console.log("  Wrangler OAuth usually lacks it — prompting instead.");
      } else if (res.ok) {
        const data = await res.json();
        const subs = data.result || [];
        const paid = subs.some((s) => (s.rate_plan || {}).id === "workers_paid");
        const plan = paid ? "paid" : "free";
        console.log(`✓ Workers plan detected via API: ${plan}`);
        return {
          plan,
          source: "subscriptions API",
          model: paid ? MODEL_PAID : MODEL_FREE,
        };
      } else {
        console.log(`⚠ subscriptions API HTTP ${res.status} — prompting for plan.`);
      }
    } catch (err) {
      console.log(`⚠ plan detect failed (${err instanceof Error ? err.message : err}) — prompting.`);
    }
  } else {
    console.log("⚠ No Cloudflare token/account for plan detect — prompting.");
  }

  console.log(`
Classifier model depends on your Cloudflare Workers plan:
  • Free  → ${MODEL_FREE}
      (cheaper neurons; ~88% label accuracy in our bake-off)
  • Paid  → ${MODEL_PAID}  (~$5/mo Workers Paid)
      (best accuracy in our bake-off: 16/16)
`);
  const ans = (await ask("Workers plan? (free / paid)", "paid")).toLowerCase();
  const plan = ans.startsWith("f") ? "free" : "paid";
  return {
    plan,
    source: "prompt",
    model: plan === "paid" ? MODEL_PAID : MODEL_FREE,
  };
}

function setClassifierModelVar(model) {
  const tomlPath = join(ROOT, "wrangler.toml");
  let toml = readFileSync(tomlPath, "utf8");
  if (/^CLASSIFIER_MODEL\s*=/m.test(toml)) {
    toml = toml.replace(
      /^CLASSIFIER_MODEL\s*=\s*".*"/m,
      `CLASSIFIER_MODEL = "${model}"`,
    );
  } else if (/^\[vars\]/m.test(toml)) {
    toml = toml.replace(/^\[vars\]\s*$/m, `[vars]\nCLASSIFIER_MODEL = "${model}"`);
  } else {
    toml += `\n[vars]\nCLASSIFIER_MODEL = "${model}"\n`;
  }
  writeFileSync(tomlPath, toml);
  console.log(`✓ wrangler.toml CLASSIFIER_MODEL = ${model}`);
}


function ensureKvBinding(projectSlug) {
  const tomlPath = join(ROOT, "wrangler.toml");
  let toml = readFileSync(tomlPath, "utf8");
  if (toml.includes('binding = "INBOX_STATE"') && /id = "[a-f0-9]+"/.test(toml)) {
    console.log("✓ KV INBOX_STATE already in wrangler.toml");
    return;
  }
  console.log("Creating KV namespace INBOX_STATE…");
  const created = runCapture("npx", ["wrangler", "kv", "namespace", "create", "INBOX_STATE"]);
  const m = created.out.match(/id\s*=\s*"([^"]+)"/);
  if (!m) throw new Error(`Could not parse KV id from:\n${created.out}`);
  const id = m[1];
  if (!toml.includes("[ai]")) {
    toml += `\n[ai]\nbinding = "AI"\n`;
  }
  toml += `\n[[kv_namespaces]]\nbinding = "INBOX_STATE"\nid = "${id}"\n`;
  writeFileSync(tomlPath, toml);
  console.log(`✓ KV INBOX_STATE ${id}`);
}

function workerNameFromToml() {
  const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  return (toml.match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || "email-inbox-worker";
}

/** Pull first https://….workers.dev from wrangler/CLI text (strip trailing slash). */
function parseWorkersDevUrl(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\u001b\[[0-9;]*m/g, "");
  const m = cleaned.match(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.workers\.dev/i);
  return m ? m[0].replace(/\/$/, "") : null;
}

function workersDevSubdomainViaApi() {
  const accountId = wranglerAccountId();
  const token = readCloudflareToken();
  if (!accountId || !token) return null;
  const r = runCapture("curl", [
    "-sS",
    "-H",
    `Authorization: Bearer ${token}`,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
  ]);
  try {
    const data = JSON.parse(r.out);
    const sub = data?.result?.subdomain;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Resolve workers.dev base URL without asking the user when possible.
 * Order: deploy stdout → deployments list → CF workers/subdomain + toml name.
 * Caller should already prefer args.workerUrl (--worker-url).
 */
function discoverWorkerBaseUrl(deployOut = "") {
  let url = parseWorkersDevUrl(deployOut);
  if (url) {
    console.log(`✓ Worker URL from deploy output: ${url}`);
    return url;
  }

  const dep = runCapture("npx", ["wrangler", "deployments", "list"]);
  url = parseWorkersDevUrl(dep.out);
  if (url) {
    console.log(`✓ Worker URL from deployments list: ${url}`);
    return url;
  }

  const name = workerNameFromToml();
  const sub = workersDevSubdomainViaApi();
  if (sub && name) {
    url = `https://${name}.${sub}.workers.dev`;
    console.log(`✓ Worker URL from account subdomain (${sub}): ${url}`);
    return url;
  }

  // whoami email → rough subdomain guess (e.g. matthew@hall.vc → matthewhall-ca style is unreliable)
  const who = runCapture("npx", ["wrangler", "whoami"]);
  const email = (who.out.match(/associated with the email\s+(\S+)/i) || [])[1];
  if (email && name) {
    const local = email.split("@")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (local) {
      const guess = `https://${name}.${local}.workers.dev`;
      console.log(`⚠ Could not confirm subdomain via API; guessed ${guess}`);
      return guess;
    }
  }

  return null;
}

/** Deploy and return combined stdout/stderr for URL parsing (also echoed to the terminal). */
function wranglerDeployCapture() {
  const res = spawnSync("npx", ["wrangler", "deploy"], {
    encoding: "utf8",
    env: process.env,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  if (res.status !== 0) {
    throw new Error(`wrangler deploy failed\n${out.slice(-800)}`);
  }
  return out;
}

async function resolveWorkerBaseUrl(deployOut = "") {
  if (args.workerUrl) {
    const u = String(args.workerUrl).replace(/\/$/, "");
    console.log(`✓ Worker URL from --worker-url: ${u}`);
    return u;
  }
  const discovered = discoverWorkerBaseUrl(deployOut);
  if (discovered && !discovered.includes("<")) return discovered.replace(/\/$/, "");

  const pasted = await ask(
    "Could not auto-detect workers.dev URL — paste Worker base URL (no trailing slash)",
  );
  if (!pasted || pasted.includes("<")) {
    throw new Error("Worker base URL required (or pass --worker-url)");
  }
  return pasted.replace(/\/$/, "");
}

async function watchOnly() {
  console.log("\nArming Gmail users.watch…");
  const base = await resolveWorkerBaseUrl();
  const w = runCapture("curl", ["-sS", "-X", "POST", `${base}/watch`]);
  console.log(w.out);
}

async function main() {
  console.log("\nEmail inbox Worker setup (gcloud + wrangler)\n");

  need("node", "Install Node 20+ from https://nodejs.org");
  need("gcloud", "Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install");
  const auth = runCapture("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
  if (!auth.out) throw new Error("Not logged into gcloud. Run: gcloud auth login");
  console.log(`✓ gcloud account: ${auth.out.split("\n")[0]}`);

  // wrangler whoami
  const who = runCapture("npx", ["wrangler", "whoami"]);
  if (who.status !== 0 || /not logged in|Unauthenticated/i.test(who.out)) {
    console.log("Logging into Cloudflare (wrangler login)…");
    wrangler(["login"]);
  } else {
    console.log("✓ wrangler logged in");
  }

  if (args.watchOnly) {
    await watchOnly();
    rl.close();
    return;
  }

  const project =
    args.project ||
    (await ask("GCP project id", runCapture("gcloud", ["config", "get-value", "project"]).out || ""));
  if (!project) throw new Error("GCP project id required");
  gcloud(["config", "set", "project", project], { silent: true });

  const topicShort = args.topic || (await ask("Pub/Sub topic name", "email-inbox-notifications"));
  const topic = topicShort.startsWith("projects/")
    ? topicShort
    : `projects/${project}/topics/${topicShort}`;
  const topicName = topic.split("/").pop();

  const subName = args.subscription || (await ask("Push subscription name", "email-inbox-push"));
  const saName = args.sa || "email-inbox-push";
  const saEmail = `${saName}@${project}.iam.gserviceaccount.com`;

  const webhookUrl =
    args.webhookUrl ||
    (await ask("Grok Bot Email webhook URL (from To Respond draft wake routine)"));
  const webhookKey =
    args.webhookKey || (await ask("Grok Bot Email webhook sender key"));
  if (!webhookUrl || !webhookKey) throw new Error("Webhook URL and key are required");

  const oauthClientId =
    args.clientId || (await ask("Google OAuth client ID (Web application)"));
  const oauthClientSecret =
    args.clientSecret || (await ask("Google OAuth client secret"));
  if (!oauthClientId || !oauthClientSecret) throw new Error("OAuth client id/secret required");

  // Enable APIs
  console.log("\nEnabling Gmail + Pub/Sub APIs…");
  gcloud(["services", "enable", "gmail.googleapis.com", "pubsub.googleapis.com", "--project", project]);

  // Topic
  console.log("\nEnsuring Pub/Sub topic…");
  const topicExists = runCapture("gcloud", [
    "pubsub",
    "topics",
    "describe",
    topicName,
    "--project",
    project,
  ]);
  if (topicExists.status !== 0) {
    gcloud(["pubsub", "topics", "create", topicName, "--project", project]);
  } else console.log(`✓ topic ${topicName}`);

  // Gmail publisher
  gcloud([
    "pubsub",
    "topics",
    "add-iam-policy-binding",
    topicName,
    "--project",
    project,
    "--member",
    "serviceAccount:gmail-api-push@system.gserviceaccount.com",
    "--role",
    "roles/pubsub.publisher",
  ]);

  // Push SA
  console.log("\nEnsuring push auth service account…");
  const saExists = runCapture("gcloud", [
    "iam",
    "service-accounts",
    "describe",
    saEmail,
    "--project",
    project,
  ]);
  if (saExists.status !== 0) {
    gcloud([
      "iam",
      "service-accounts",
      "create",
      saName,
      "--project",
      project,
      "--display-name",
      "Email inbox Worker Pub/Sub push OIDC",
    ]);
  } else console.log(`✓ SA ${saEmail}`);

  const projectNumber = runCapture("gcloud", [
    "projects",
    "describe",
    project,
    "--format=value(projectNumber)",
  ]).out.trim();
  if (!projectNumber) throw new Error("Could not resolve project number");
  const pubsubAgent = `serviceAccount:service-${projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;
  gcloud([
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    saEmail,
    "--project",
    project,
    "--member",
    pubsubAgent,
    "--role",
    "roles/iam.serviceAccountTokenCreator",
  ]);

  // Classifier model from Workers Free vs Paid
  console.log("\nChoosing Workers AI classifier…");
  const chosen = await resolveClassifierPlan();
  console.log(`→ plan=${chosen.plan} (${chosen.source}) → ${chosen.model}`);
  setClassifierModelVar(chosen.model);

  // Cloudflare
  console.log("\nCloudflare: KV + deploy…");
  ensureKvBinding();
  const deployOut = wranglerDeployCapture();

  // Auto-detect workers.dev URL (deploy stdout → deployments list → CF subdomain API).
  // Override anytime with --worker-url. Prompt only if parse/heuristics fail.
  const workerBase = await resolveWorkerBaseUrl(deployOut);
  const pushEndpoint = `${workerBase}/pubsub`;
  const oauthCallback = `${workerBase}/oauth/callback`;

  console.log("\nWriting Worker secrets…");
  secretPut("GROK_WEBHOOK_URL", webhookUrl);
  secretPut("GROK_WEBHOOK_KEY", webhookKey);
  secretPut("GOOGLE_CLIENT_ID", oauthClientId);
  secretPut("GOOGLE_CLIENT_SECRET", oauthClientSecret);
  secretPut("GMAIL_PUBSUB_TOPIC", topic);
  secretPut("PUBLIC_PUSH_URL", pushEndpoint);

  // Push subscription
  console.log("\nEnsuring Push subscription…");
  const subExists = runCapture("gcloud", [
    "pubsub",
    "subscriptions",
    "describe",
    subName,
    "--project",
    project,
  ]);
  if (subExists.status !== 0) {
    gcloud([
      "pubsub",
      "subscriptions",
      "create",
      subName,
      "--project",
      project,
      "--topic",
      topicName,
      "--push-endpoint",
      pushEndpoint,
      "--push-auth-service-account",
      saEmail,
      "--push-auth-token-audience",
      pushEndpoint,
    ]);
  } else {
    console.log(`✓ subscription ${subName} exists — updating push endpoint`);
    gcloud([
      "pubsub",
      "subscriptions",
      "modify-push-config",
      subName,
      "--project",
      project,
      "--push-endpoint",
      pushEndpoint,
      "--push-auth-service-account",
      saEmail,
      "--push-auth-token-audience",
      pushEndpoint,
    ]);
  }

  console.log(`
────────────────────────────────────────
Almost done — connect Gmail (browser step)

1. In Google Cloud Console → OAuth client → Authorized redirect URIs, add:
   ${oauthCallback}

2. Open this URL and approve access for the first mailbox:
   ${workerBase}/oauth/start

3. When you see "Gmail connected", run:
   npm run setup -- --watch-only --worker-url ${workerBase}

4. Multi-account: visit /oauth/start again while signed into the second Google
   account (or use an Incognito window). Optional hint:
   ${workerBase}/oauth/start?account=work
   Tokens are stored per-email in KV (mailbox:<email>:refresh_token).
   Set Worker vars/secrets OWNER_EMAIL / WORK_EMAIL so wakes map to personal|work.
   Cron (0 14 * * * UTC) renews users.watch for every registered mailbox.
   Manual renew: POST ${workerBase}/cron/renew-watches  or  POST /watch

Classifier: wrangler.toml [vars] CLASSIFIER_MODEL (Free=llama fp8, Paid=glm-5.3-flash).

Then send a test "can you reply?" email.
────────────────────────────────────────
`);

  const doWatch = args.yes
    ? false
    : (await ask("Open oauth/start in your browser now and type 'done' when finished (or skip)", "skip")) ===
      "done";
  if (doWatch) {
    const w = runCapture("curl", ["-sS", "-X", "POST", `${workerBase}/watch`]);
    console.log(w.out);
  }

  rl.close();
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message || err);
  rl.close();
  process.exit(1);
});
