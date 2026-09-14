#!/usr/bin/env node

import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const REQUIRED_DEPLOYMENT_VALUES = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
];

const usage = `
Create and optionally deploy a Telegram bot on Cloudflare Workers.

Usage:
  npm run create -- init <worker-name> [options]

Options:
  --dir <path>                 Where to create the Worker (default: ./<worker-name>)
  --deploy                     Install, deploy, add secrets, and register Telegram's webhook
  --webhook-url <https URL>    Public webhook URL, ending in /webhook (for a custom domain)
  --workers-subdomain <name>   Your existing <name>.workers.dev subdomain
  --help                       Show this help

For --deploy, provide these environment variables without putting them in a file:
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
  TELEGRAM_BOT_TOKEN

TELEGRAM_WEBHOOK_SECRET is optional. When omitted, a secure value is generated
for this bot and displayed once after its first deployment.
`.trim();

function stop(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help")) return { help: true };
  const [command, workerName, ...rest] = argv;
  if (command !== "init" || !workerName) throw new Error("Expected: init <worker-name>");

  const options = { workerName, directory: null, deploy: false, webhookUrl: null, workersSubdomain: null };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--deploy") options.deploy = true;
    else if (["--dir", "--webhook-url", "--workers-subdomain"].includes(flag)) {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
      if (flag === "--dir") options.directory = value;
      if (flag === "--webhook-url") options.webhookUrl = value;
      if (flag === "--workers-subdomain") options.workersSubdomain = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

function validate(options) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.workerName)) {
    throw new Error("Worker names must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.");
  }
  if (options.webhookUrl) {
    const url = new URL(options.webhookUrl);
    if (url.protocol !== "https:" || url.pathname !== "/webhook") {
      throw new Error("--webhook-url must be an HTTPS URL ending exactly in /webhook.");
    }
  }
  if (options.workersSubdomain && !/^[a-z0-9-]+$/i.test(options.workersSubdomain)) {
    throw new Error("--workers-subdomain may contain only letters, numbers, and hyphens.");
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function packageJson(name) {
  return JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { deploy: "wrangler deploy", dev: "wrangler dev", start: "wrangler dev" },
    devDependencies: { wrangler: "^4.0.0" },
  }, null, 2) + "\n";
}

function wranglerConfig(name) {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-14",
  "workers_dev": true,
  "observability": {
    "enabled": true
  }
}
`;
}

const workerSource = `interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

type TelegramUpdate = {
  message?: { chat: { id: number }; text?: string };
};

async function sendMessage(env: Env, chatId: number, text: string) {
  const response = await fetch(\`https://api.telegram.org/bot\${env.TELEGRAM_BOT_TOKEN}/sendMessage\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error(\`Telegram sendMessage failed: \${response.status}\`);
}

async function handleUpdate(env: Env, update: TelegramUpdate) {
  const message = update.message;
  if (!message?.text) return;

  if (message.text === "/start") {
    await sendMessage(env, message.chat.id, "Hello! Your Cloudflare Telegram bot is ready.");
    return;
  }

  await sendMessage(env, message.chat.id, \`You said: \${message.text}\`);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram bot is running.");
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    ctx.waitUntil(handleUpdate(env, update).catch((error) => console.error("Telegram update failed", error)));
    return new Response("OK");
  },
} satisfies ExportedHandler<Env>;
`;

const workflow = `name: Deploy Telegram Worker

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: telegram-worker-production
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      TELEGRAM_WEBHOOK_URL: \${{ vars.TELEGRAM_WEBHOOK_URL }}
      TELEGRAM_BOT_TOKEN: \${{ secrets.TELEGRAM_BOT_TOKEN }}
      TELEGRAM_WEBHOOK_SECRET: \${{ secrets.TELEGRAM_WEBHOOK_SECRET }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Check deployment configuration
        shell: bash
        run: |
          test -n "$TELEGRAM_WEBHOOK_URL" || { echo "Set the TELEGRAM_WEBHOOK_URL repository variable."; exit 1; }
          test -n "$TELEGRAM_BOT_TOKEN" || { echo "Set the TELEGRAM_BOT_TOKEN repository secret."; exit 1; }
          test -n "$TELEGRAM_WEBHOOK_SECRET" || { echo "Set the TELEGRAM_WEBHOOK_SECRET repository secret."; exit 1; }
      - name: Deploy Worker and sync Worker secrets
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          secrets: |
            TELEGRAM_BOT_TOKEN
            TELEGRAM_WEBHOOK_SECRET
        env:
          TELEGRAM_BOT_TOKEN: \${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_WEBHOOK_SECRET: \${{ secrets.TELEGRAM_WEBHOOK_SECRET }}
      - name: Register Telegram webhook
        shell: bash
        run: |
          test -n "$TELEGRAM_WEBHOOK_URL" || { echo "Set TELEGRAM_WEBHOOK_URL."; exit 1; }
          curl --fail-with-body --silent --show-error --request POST \\
            --form "url=$TELEGRAM_WEBHOOK_URL" \\
            --form "secret_token=$TELEGRAM_WEBHOOK_SECRET" \\
            --form 'allowed_updates=["message","callback_query"]' \\
            "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/setWebhook"
`;

const readme = `# Generated Telegram Worker

This Worker accepts Telegram webhooks at \`/webhook\`, validates Telegram's secret header, and echoes received text.

## Local development

Copy \`.dev.vars.example\` to \`.dev.vars\`, add development-only values, then run \`npm run dev\`.

## Automated first deployment

Run this from the generator with the four credentials in environment variables. The generator deploys this Worker, saves both Telegram values as Cloudflare Worker secrets, discovers the existing \`workers.dev\` subdomain, and registers \`https://<worker>.<subdomain>.workers.dev/webhook\` with Telegram.

For a custom domain, use \`--webhook-url https://bot.example.com/webhook\` when generating.

## GitHub Actions

The included workflow deploys future commits. Before its first run, add repository secrets \`CLOUDFLARE_ACCOUNT_ID\`, \`CLOUDFLARE_API_TOKEN\`, \`TELEGRAM_BOT_TOKEN\`, and \`TELEGRAM_WEBHOOK_SECRET\`. If the generator created the webhook secret, it displayed that value at the end of the first deployment. Add the non-secret repository variable \`TELEGRAM_WEBHOOK_URL\` with this Worker's final URL ending in \`/webhook\`.
`;

async function scaffold(options) {
  const destination = resolve(options.directory ?? options.workerName);
  if (await pathExists(destination)) throw new Error(`Destination already exists: ${destination}`);
  await mkdir(resolve(destination, "src"), { recursive: true });
  await mkdir(resolve(destination, ".github", "workflows"), { recursive: true });
  await Promise.all([
    writeFile(resolve(destination, "package.json"), packageJson(options.workerName)),
    writeFile(resolve(destination, "wrangler.jsonc"), wranglerConfig(options.workerName)),
    writeFile(resolve(destination, "src", "index.ts"), workerSource),
    writeFile(resolve(destination, ".github", "workflows", "deploy.yml"), workflow),
    writeFile(resolve(destination, ".gitignore"), ".dev.vars\n.wrangler\nnode_modules\n"),
    writeFile(resolve(destination, ".dev.vars.example"), "TELEGRAM_BOT_TOKEN=replace-for-local-development\nTELEGRAM_WEBHOOK_SECRET=replace-for-local-development\n"),
    writeFile(resolve(destination, "README.md"), readme),
  ]);
  return destination;
}

function run(command, args, { cwd, env, input } = {}) {
  const executable = process.platform === "win32" ? `${command}.cmd` : command;
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", rejectProcess);
    child.on("close", (code) => code === 0 ? resolveProcess() : rejectProcess(new Error(`${command} exited with code ${code}.`)));
    child.stdin.end(input);
  });
}

async function localEnvironment() {
  try {
    const source = await readFile(resolve(process.cwd(), ".env"), "utf8");
    return Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      const equals = trimmed.indexOf("=");
      if (!trimmed || trimmed.startsWith("#") || equals < 1) return [];
      const name = trimmed.slice(0, equals).trim();
      let value = trimmed.slice(equals + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return [[name, value]];
    }));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return {};
    throw error;
  }
}

async function deploymentEnvironment() {
  const localValues = await localEnvironment();
  const valueFor = (name) => process.env[name] || localValues[name] || undefined;
  const missing = REQUIRED_DEPLOYMENT_VALUES.filter((name) => !valueFor(name));
  if (missing.length) throw new Error(`--deploy needs: ${missing.join(", ")}`);
  const webhookSecret = valueFor("TELEGRAM_WEBHOOK_SECRET") ?? randomBytes(32).toString("base64url");
  return {
    credentials: {
      ...Object.fromEntries(REQUIRED_DEPLOYMENT_VALUES.map((name) => [name, valueFor(name)])),
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    },
    generatedWebhookSecret: !valueFor("TELEGRAM_WEBHOOK_SECRET"),
  };
}

async function saveBotCredentials(workerName, webhookUrl, credentials) {
  const registryPath = resolve(process.cwd(), ".telegram-bots.json");
  let registry = { bots: {} };
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
    if (!registry || typeof registry !== "object" || Array.isArray(registry) || !registry.bots || typeof registry.bots !== "object" || Array.isArray(registry.bots)) {
      throw new Error("Registry must contain a bots object.");
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code !== "ENOENT") throw new Error(`Could not read .telegram-bots.json: ${error.message ?? error}`);
  }
  registry.bots[workerName] = {
    telegramBotToken: credentials.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: credentials.TELEGRAM_WEBHOOK_SECRET,
    workerName,
    webhookUrl,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

async function workerUrl(options, credentials) {
  if (options.webhookUrl) return options.webhookUrl;
  let subdomain = options.workersSubdomain;
  if (!subdomain) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${credentials.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`, {
      headers: { Authorization: `Bearer ${credentials.CLOUDFLARE_API_TOKEN}` },
    });
    const result = await response.json();
    if (!response.ok || !result.success || !result.result?.subdomain) {
      throw new Error("Cloudflare has no readable workers.dev subdomain. Set one in Cloudflare first, or rerun with --webhook-url for a custom domain.");
    }
    subdomain = result.result.subdomain;
  }
  return `https://${options.workerName}.${subdomain}.workers.dev/webhook`;
}

async function registerWebhook(url, credentials) {
  const response = await fetch(`https://api.telegram.org/bot${credentials.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      url,
      secret_token: credentials.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: JSON.stringify(["message", "callback_query"]),
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram setWebhook failed: ${result.description ?? response.status}`);
}

async function deploy(options, destination, deployment) {
  const { credentials, generatedWebhookSecret } = deployment;
  console.log("Installing the generated Worker's dependencies...");
  await run("npm", ["install"], { cwd: destination });
  console.log("Deploying the Worker...");
  await run("npx", ["wrangler", "deploy"], { cwd: destination, env: credentials });
  console.log("Saving Telegram credentials as Cloudflare Worker secrets...");
  await run("npx", ["wrangler", "secret", "bulk"], {
    cwd: destination,
    env: credentials,
    input: JSON.stringify({
      TELEGRAM_BOT_TOKEN: credentials.TELEGRAM_BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: credentials.TELEGRAM_WEBHOOK_SECRET,
    }),
  });
  const url = await workerUrl(options, credentials);
  console.log("Registering Telegram's webhook...");
  await registerWebhook(url, credentials);
  await saveBotCredentials(options.workerName, url, credentials);
  console.log(`Done. Telegram now delivers updates to ${url}`);
  if (generatedWebhookSecret) {
    console.log(`Save this value as the TELEGRAM_WEBHOOK_SECRET GitHub repository secret before enabling future deployments:\n${credentials.TELEGRAM_WEBHOOK_SECRET}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return console.log(usage);
  validate(options);
  const credentials = options.deploy ? await deploymentEnvironment() : null;
  const destination = await scaffold(options);
  console.log(`Created ${destination}`);
  if (options.deploy) await deploy(options, destination, credentials);
  else console.log("Run npm install inside the new directory, or rerun with --deploy and your credentials.");
}

main().catch((error) => stop(error instanceof Error ? error.message : String(error)));
