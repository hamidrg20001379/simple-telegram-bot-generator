#!/usr/bin/env node

import { readFile, writeFile, access, chmod, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers");

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(projectRoot, ".telegram-bots.json");
const envPath = resolve(projectRoot, ".env");
const managerStatePath = resolve(projectRoot, ".telegram-manager-state.json");
const conversations = new Map();
const callbacks = new Map();
const operations = new Set();
let managerState = { languages: {} };

const DEPLOYMENT_CREDENTIALS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN"];

function tr(language, english, persian) {
  return language === "fa" ? persian : english;
}

function languageFor(userId) {
  return managerState.languages[String(userId)] || null;
}

async function loadManagerState() {
  try {
    const value = JSON.parse(await readFile(managerStatePath, "utf8"));
    if (value?.languages && typeof value.languages === "object") managerState = value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function saveManagerState() {
  await writeFile(managerStatePath, `${JSON.stringify(managerState, null, 2)}\n`, { mode: 0o600 });
  await chmod(managerStatePath, 0o600);
}

export function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    const equals = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || equals < 1) return [];
    const name = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    return [[name, value]];
  }));
}

export function validateWorkerName(name) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    throw new Error("Use 1–40 lowercase letters, numbers, or hyphens, beginning with a letter.");
  }
  return name;
}

export function validateBotToken(token) {
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("That does not look like a Telegram bot token.");
  return token;
}

function html(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function readEnvironment() {
  let fileValues = {};
  try { fileValues = parseEnv(await readFile(envPath, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  return { ...fileValues, ...process.env };
}

async function saveEnvironmentValue(configuration, name, value) {
  let source = "";
  try { source = await readFile(envPath, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const line = `${name}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  source = pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.trimEnd()}${source.trim() ? "\n" : ""}${line}\n`;
  await writeFile(envPath, source, { mode: 0o600 });
  await chmod(envPath, 0o600);
  configuration[name] = value;
}

function missingDeploymentCredentials(configuration) {
  return DEPLOYMENT_CREDENTIALS.filter((name) => !configuration[name]);
}

function credentialIsSecret(name) {
  return ["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN"].includes(name);
}

export function validateCredential(name, value) {
  if (name === "CLOUDFLARE_ACCOUNT_ID" && !/^[a-f0-9]{32}$/i.test(value)) {
    throw new Error("Cloudflare Account ID must be the 32-character hexadecimal ID shown in the dashboard.");
  }
  if (name === "CLOUDFLARE_API_TOKEN" && !/^[A-Za-z0-9_-]{20,}$/.test(value)) {
    throw new Error("That does not look like a Cloudflare API token.");
  }
  if (name === "GITHUB_TOKEN" && !/^(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(value)) {
    throw new Error("Use a GitHub classic or fine-grained personal access token.");
  }
  return value;
}

export function credentialInstructions(name, language) {
  if (name === "CLOUDFLARE_ACCOUNT_ID") return tr(language,
    `<b>Cloudflare Account ID is required</b>\n\n1. Open <a href="https://dash.cloudflare.com/">Cloudflare Dashboard</a>.\n2. Select the account that will own the bots.\n3. Open <b>Workers &amp; Pages</b>.\n4. Copy the 32-character <b>Account ID</b> shown in the account/Workers overview.\n5. Send only that Account ID here.\n\nSend /cancel to stop setup.`,
    `<b>شناسه حساب Cloudflare لازم است</b>\n\n۱. <a href="https://dash.cloudflare.com/">داشبورد Cloudflare</a> را باز کنید.\n۲. حسابی را که ربات‌ها در آن ساخته می‌شوند انتخاب کنید.\n۳. بخش <b>Workers &amp; Pages</b> را باز کنید.\n۴. مقدار ۳۲ کاراکتری <b>Account ID</b> را از صفحه حساب یا Workers کپی کنید.\n۵. فقط همان Account ID را اینجا بفرستید.\n\nبرای توقف /cancel را بفرستید.`);
  if (name === "CLOUDFLARE_API_TOKEN") return tr(language,
    `<b>Cloudflare API token is required</b>\n\n1. Open Cloudflare → <b>My Profile</b> → <b>API Tokens</b>.\n2. Choose <b>Create Token</b> → <b>Create Custom Token</b>.\n3. Add <b>Account → Workers Scripts → Edit</b> (or the Workers product-level <b>Admin</b> role if shown).\n4. Add <b>Account → D1 → Edit</b>. In the newer permissions UI this may be named <b>D1 Write</b>.\n5. Add <b>Account → Account Settings → Read</b>.\n6. Under Account Resources choose <b>Include → Specific account</b> and select your account.\n7. Create the token and copy it immediately; Cloudflare shows it once.\n8. Send only the token here. This message will be deleted after it is read.`,
    `<b>توکن API کلادفلر لازم است</b>\n\n۱. در Cloudflare وارد <b>My Profile</b> و سپس <b>API Tokens</b> شوید.\n۲. <b>Create Token</b> و بعد <b>Create Custom Token</b> را بزنید.\n۳. دسترسی <b>Account → Workers Scripts → Edit</b> را اضافه کنید. اگر نقش‌های جدید نمایش داده می‌شوند، نقش <b>Admin</b> در سطح محصول Workers را انتخاب کنید.\n۴. دسترسی <b>Account → D1 → Edit</b> را اضافه کنید. در رابط جدید ممکن است نام آن <b>D1 Write</b> باشد.\n۵. دسترسی <b>Account → Account Settings → Read</b> را اضافه کنید.\n۶. در Account Resources گزینه <b>Include → Specific account</b> را انتخاب کرده و حساب خود را مشخص کنید.\n۷. توکن را بسازید و همان لحظه کپی کنید؛ Cloudflare آن را فقط یک بار نشان می‌دهد.\n۸. فقط توکن را اینجا بفرستید. پیام پس از خواندن حذف می‌شود.`);
  return tr(language,
    `<b>GitHub token is required</b>\n\n1. Open <a href="https://github.com/settings/tokens/new">GitHub → Personal access tokens (classic)</a>.\n2. Set a name such as <code>telegram-bot-manager</code> and choose an expiration.\n3. Select <b>repo</b> so the manager can create private repositories and configure their Actions secrets and variables.\n4. Select <b>workflow</b> so it can push the generated deployment workflow.\n5. Do not select <b>delete_repo</b>.\n6. Generate and copy the token.\n7. Send only the token here. It is saved once and reused for every bot; this message will be deleted after it is read.`,
    `<b>توکن GitHub لازم است</b>\n\n۱. صفحه <a href="https://github.com/settings/tokens/new">Personal access tokens (classic)</a> در GitHub را باز کنید.\n۲. نامی مانند <code>telegram-bot-manager</code> و یک تاریخ انقضا انتخاب کنید.\n۳. دسترسی <b>repo</b> را فعال کنید تا مدیر بتواند مخزن خصوصی بسازد و Secrets و Variables مربوط به Actions را تنظیم کند.\n۴. دسترسی <b>workflow</b> را فعال کنید تا فایل استقرار GitHub Actions قابل ارسال باشد.\n۵. گزینه <b>delete_repo</b> را فعال نکنید.\n۶. توکن را بسازید و کپی کنید.\n۷. فقط توکن را اینجا بفرستید. این مقدار یک بار ذخیره و برای همه ربات‌ها استفاده می‌شود؛ پیام پس از خواندن حذف می‌شود.`);
}

async function readRegistry() {
  try {
    const value = JSON.parse(await readFile(registryPath, "utf8"));
    if (!value?.bots || typeof value.bots !== "object" || Array.isArray(value.bots)) throw new Error("Registry must contain a bots object.");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return { bots: {} };
    throw error;
  }
}

async function writeRegistry(registry) {
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await chmod(registryPath, 0o600);
}

function telegramApiBaseUrl(configuration) {
  return (configuration.TELEGRAM_API_BASE_URL || "https://api.telegram.org/bot").replace(/\/$/, "");
}

async function telegram(configuration, token, method, body = {}) {
  const response = await fetch(`${telegramApiBaseUrl(configuration)}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
  return result.result;
}

function callback(action, name = "") {
  const id = randomBytes(6).toString("base64url");
  callbacks.set(id, { action, name, expires: Date.now() + 3_600_000 });
  return id;
}

function cleanupCallbacks() {
  for (const [id, value] of callbacks) if (value.expires < Date.now()) callbacks.delete(id);
}

function languageKeyboard() {
  return { inline_keyboard: [[
    { text: "🇬🇧 English", callback_data: callback("language", "en") },
    { text: "🇮🇷 فارسی", callback_data: callback("language", "fa") },
  ]] };
}

function mainKeyboard(language = "en") {
  return {
    inline_keyboard: [
      [{ text: tr(language, "➕ Create & deploy", "➕ ساخت و استقرار"), callback_data: callback("create") }],
      [{ text: tr(language, "🤖 My bots", "🤖 ربات‌های من"), callback_data: callback("bots") }, { text: tr(language, "🔄 Refresh", "🔄 تازه‌سازی"), callback_data: callback("bots") }],
      [{ text: tr(language, "🌐 Language", "🌐 زبان"), callback_data: callback("choose-language") }, { text: tr(language, "❓ Help", "❓ راهنما"), callback_data: callback("help") }],
    ],
  };
}

function botKeyboard(name, bot, language = "en") {
  const paused = bot.paused === true;
  return {
    inline_keyboard: [
      [{ text: tr(language, "📊 Status", "📊 وضعیت"), callback_data: callback("status", name) }, { text: tr(language, "🚀 Redeploy", "🚀 استقرار مجدد"), callback_data: callback("redeploy", name) }],
      [{ text: paused ? tr(language, "▶️ Resume webhook", "▶️ فعال‌کردن وب‌هوک") : tr(language, "⏸ Pause webhook", "⏸ توقف وب‌هوک"), callback_data: callback(paused ? "resume" : "pause", name) }],
      [{ text: tr(language, "🔑 Rotate bot token", "🔑 تعویض توکن ربات"), callback_data: callback("rotate", name) }, { text: tr(language, "🔗 Repair webhook", "🔗 تعمیر وب‌هوک"), callback_data: callback("resume", name) }],
      [{ text: tr(language, "🗑 Undeploy", "🗑 حذف استقرار"), callback_data: callback("confirm-undeploy", name) }],
      [{ text: tr(language, "← All bots", "← همه ربات‌ها"), callback_data: callback("bots") }, { text: tr(language, "🏠 Home", "🏠 خانه"), callback_data: callback("home") }],
    ],
  };
}

async function send(configuration, chatId, text, extra = {}) {
  return telegram(configuration, configuration.MANAGER_TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function edit(configuration, chatId, messageId, text, extra = {}) {
  return telegram(configuration, configuration.MANAGER_TELEGRAM_BOT_TOKEN, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function safeDeleteMessage(configuration, chatId, messageId) {
  try { await telegram(configuration, configuration.MANAGER_TELEGRAM_BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: messageId }); }
  catch { /* Token-bearing user messages are best-effort deleted. */ }
}

async function verifyCredential(configuration, name, value) {
  if (name === "CLOUDFLARE_API_TOKEN") {
    const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${value}` },
      signal: AbortSignal.timeout(35_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error("Cloudflare rejected this API token. Check the token value and permissions.");
    if (configuration.CLOUDFLARE_ACCOUNT_ID) {
      const accountResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${configuration.CLOUDFLARE_ACCOUNT_ID}`, {
        headers: { Authorization: `Bearer ${value}` },
        signal: AbortSignal.timeout(35_000),
      });
      const accountResult = await accountResponse.json().catch(() => ({}));
      if (!accountResponse.ok || !accountResult.success) {
        throw new Error("The token cannot access that Cloudflare account. Check the Account ID, token permissions, and selected account resource.");
      }
    }
  }
  if (name === "GITHUB_TOKEN") {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${value}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
      signal: AbortSignal.timeout(35_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`GitHub rejected this token: ${result.message || response.status}`);
    const scopes = response.headers.get("x-oauth-scopes") || "";
    const granted = scopes.split(",").map((scope) => scope.trim());
    if (value.startsWith("ghp_") && (!granted.includes("repo") || !granted.includes("workflow"))) {
      throw new Error("This classic GitHub token must include both repo and workflow scopes.");
    }
  }
}

async function promptForNextCredential(configuration, chatId, language, resume = "home", messageId) {
  const next = missingDeploymentCredentials(configuration)[0];
  if (!next) {
    conversations.delete(chatId);
    if (resume === "create") return promptForCreateName(configuration, chatId, language, messageId);
    return showHome(configuration, chatId, messageId, language);
  }
  conversations.set(chatId, { stage: "setup-credential", credential: next, language, resume });
  const text = credentialInstructions(next, language);
  if (messageId) return edit(configuration, chatId, messageId, text);
  return send(configuration, chatId, text);
}

async function promptForCreateName(configuration, chatId, language, messageId) {
  conversations.set(chatId, { stage: "create-name", language });
  const text = tr(language,
    "<b>Step 1 of 2 — Project name</b>\n\nSend the new Worker and private GitHub repository name. Use lowercase letters, numbers, and hyphens, beginning with a letter (maximum 40 characters).\n\nSend /cancel to stop.",
    "<b>مرحله ۱ از ۲ — نام پروژه</b>\n\nنام Worker و مخزن خصوصی GitHub را بفرستید. فقط از حروف کوچک انگلیسی، عدد و خط تیره استفاده کنید؛ نام باید با حرف شروع شود و حداکثر ۴۰ کاراکتر باشد.\n\nبرای توقف /cancel را بفرستید.");
  if (messageId) return edit(configuration, chatId, messageId, text);
  return send(configuration, chatId, text);
}

function botTokenInstructions(name, language, replacement = false) {
  if (replacement) return tr(language,
    `<b>Replacement token for ${html(name)}</b>\n\n1. Open @BotFather.\n2. Use /mybots and choose this bot.\n3. Open <b>API Token</b> and choose <b>Revoke current token</b> if rotation is required.\n4. Copy the new token and send only the token here.\n\nThe token message will be deleted after it is read. Send /cancel to stop.`,
    `<b>توکن جایگزین برای ${html(name)}</b>\n\n۱. @BotFather را باز کنید.\n۲. دستور /mybots را بفرستید و این ربات را انتخاب کنید.\n۳. وارد <b>API Token</b> شوید و در صورت نیاز <b>Revoke current token</b> را انتخاب کنید.\n۴. توکن جدید را کپی کرده و فقط همان را اینجا بفرستید.\n\nپیام توکن پس از خواندن حذف می‌شود. برای توقف /cancel را بفرستید.`);
  return tr(language,
    `<b>Step 2 of 2 — Telegram bot token for ${html(name)}</b>\n\n1. Open @BotFather in Telegram.\n2. Send /newbot.\n3. Enter the bot's display name.\n4. Enter a unique username ending in <code>bot</code>.\n5. BotFather will send an HTTP API token. Copy it.\n6. Send only that token here.\n\nThe token message will be deleted after it is read. Send /cancel to stop.`,
    `<b>مرحله ۲ از ۲ — توکن تلگرام برای ${html(name)}</b>\n\n۱. @BotFather را در تلگرام باز کنید.\n۲. دستور /newbot را بفرستید.\n۳. نام نمایشی ربات را وارد کنید.\n۴. یک نام کاربری یکتا که به <code>bot</code> ختم می‌شود وارد کنید.\n۵. BotFather توکن HTTP API را می‌فرستد؛ آن را کپی کنید.\n۶. فقط همان توکن را اینجا بفرستید.\n\nپیام توکن پس از خواندن حذف می‌شود. برای توقف /cancel را بفرستید.`);
}

function redactor(values) {
  const secrets = values.filter(Boolean).sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((result, secret) => result.replaceAll(secret, "<redacted>"), String(text));
}

async function github(configuration, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${configuration.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(35_000),
  });
  const result = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: ${result?.message || response.status}`);
  return result;
}

function gitAuthentication(token) {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
    },
    secrets: [token, encoded],
  };
}

async function runGit(configuration, args, cwd) {
  return run("git", args, { cwd, ...gitAuthentication(configuration.GITHUB_TOKEN) });
}

async function createPrivateRepository(configuration, name) {
  return github(configuration, "/user/repos", {
    method: "POST",
    body: {
      name,
      description: "Telegram bot generated by the centralized bot manager",
      private: true,
      auto_init: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    },
  });
}

async function setRepositorySecret(configuration, fullName, publicKey, name, value) {
  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(String(value)),
    sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
  );
  await github(configuration, `/repos/${fullName}/actions/secrets/${name}`, {
    method: "PUT",
    body: {
      encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
      key_id: publicKey.key_id,
    },
  });
}

async function syncRepositoryAutomation(configuration, repository, bot) {
  const fullName = repository.fullName;
  const publicKey = await github(configuration, `/repos/${fullName}/actions/secrets/public-key`);
  const secrets = {
    CLOUDFLARE_ACCOUNT_ID: configuration.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: configuration.CLOUDFLARE_API_TOKEN,
    TELEGRAM_BOT_TOKEN: bot.telegramBotToken,
    TELEGRAM_WEBHOOK_SECRET: bot.telegramWebhookSecret,
  };
  for (const [name, value] of Object.entries(secrets)) {
    await setRepositorySecret(configuration, fullName, publicKey, name, value);
  }

  const variables = await github(configuration, `/repos/${fullName}/actions/variables?per_page=100`);
  const exists = variables.variables?.some((variable) => variable.name === "TELEGRAM_WEBHOOK_URL");
  if (exists) {
    await github(configuration, `/repos/${fullName}/actions/variables/TELEGRAM_WEBHOOK_URL`, {
      method: "PATCH",
      body: { name: "TELEGRAM_WEBHOOK_URL", value: bot.webhookUrl },
    });
  } else {
    await github(configuration, `/repos/${fullName}/actions/variables`, {
      method: "POST",
      body: { name: "TELEGRAM_WEBHOOK_URL", value: bot.webhookUrl },
    });
  }
}

async function cloneRepository(configuration, repository, destination) {
  await runGit(configuration, ["clone", repository.cloneUrl, destination], projectRoot);
}

function repositoryRecord(repository) {
  return {
    fullName: repository.full_name,
    htmlUrl: repository.html_url,
    cloneUrl: repository.clone_url,
  };
}

function repositoryFromBot(bot) {
  if (!bot.githubRepository || !bot.githubUrl || !bot.githubCloneUrl) {
    throw new Error("This bot has no GitHub repository metadata.");
  }
  return { fullName: bot.githubRepository, htmlUrl: bot.githubUrl, cloneUrl: bot.githubCloneUrl };
}

async function commitAndPush(configuration, repository, destination, message) {
  await runGit(configuration, ["config", "user.name", "Telegram Bot Manager"], destination);
  await runGit(configuration, ["config", "user.email", "bot-manager@users.noreply.github.com"], destination);
  await runGit(configuration, ["add", "--all"], destination);
  let changed = true;
  try {
    await runGit(configuration, ["diff", "--cached", "--quiet"], destination);
    changed = false;
  } catch { /* A non-zero exit means staged changes exist. */ }
  if (changed) await runGit(configuration, ["commit", "-m", message], destination);
  await runGit(configuration, ["branch", "-M", "main"], destination);
  const remotes = await runGit(configuration, ["remote"], destination);
  if (!remotes.split(/\s+/).includes("origin")) {
    await runGit(configuration, ["remote", "add", "origin", repository.cloneUrl], destination);
  }
  await runGit(configuration, ["push", "--set-upstream", "origin", "main"], destination);
}

function run(command, args, { cwd = projectRoot, env = {}, secrets = [], timeout = 15 * 60_000 } = {}) {
  const redact = redactor(secrets);
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => { output = `${output}${chunk}`.slice(-24_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", (error) => { clearTimeout(timer); rejectProcess(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveProcess(redact(output));
      else rejectProcess(new Error(redact(output || `${command} exited with code ${code}.`)));
    });
  });
}

async function botExists(name) {
  const registry = await readRegistry();
  return Boolean(registry.bots[name]);
}

async function withOperation(name, operation) {
  if (operations.has(name)) throw new Error(`${name} already has an operation in progress.`);
  operations.add(name);
  try { return await operation(); }
  finally { operations.delete(name); }
}

async function deployBot(configuration, name, token, { create = false } = {}) {
  return withOperation(name, async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "telegram-bot-manager-"));
    const destination = resolve(temporaryRoot, "source");
    let repository;
    let existingBot;
    try {
      if (create) {
        await run(process.execPath, [resolve(projectRoot, "src", "cli.mjs"), "init", name, "--dir", destination]);
        repository = repositoryRecord(await createPrivateRepository(configuration, name));
        await runGit(configuration, ["init", "-b", "main"], destination);
      } else {
        const existingRegistry = await readRegistry();
        existingBot = existingRegistry.bots[name];
        if (!existingBot) throw new Error(`Unknown bot: ${name}`);
        repository = repositoryFromBot(existingBot);
        await cloneRepository(configuration, repository, destination);
      }

      const deploymentEnv = {
        CLOUDFLARE_ACCOUNT_ID: configuration.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: configuration.CLOUDFLARE_API_TOKEN,
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_API_BASE_URL: telegramApiBaseUrl(configuration),
        ...(existingBot?.telegramWebhookSecret ? { TELEGRAM_WEBHOOK_SECRET: existingBot.telegramWebhookSecret } : {}),
      };
      const args = [resolve(projectRoot, "src", "cli.mjs"), "init", name, "--dir", destination, "--deploy"];
      await run(process.execPath, args, {
        env: deploymentEnv,
        secrets: [token, configuration.CLOUDFLARE_API_TOKEN],
      });

      const registry = await readRegistry();
      const bot = registry.bots[name];
      if (!bot) throw new Error("Deployment completed without creating a registry entry.");
      bot.paused = false;
      bot.deployed = true;
      bot.githubRepository = repository.fullName;
      bot.githubUrl = repository.htmlUrl;
      bot.githubCloneUrl = repository.cloneUrl;
      await writeRegistry(registry);
      await syncRepositoryAutomation(configuration, repository, bot);
      await commitAndPush(configuration, repository, destination, create ? "Create generated Telegram bot" : "Refresh generated deployment files");
      return bot;
    } catch (error) {
      if (create && repository?.htmlUrl) {
        throw new Error(`${error.message}\nPrivate source repository: ${repository.htmlUrl}`);
      }
      throw error;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

async function setWebhook(configuration, name, enabled) {
  const registry = await readRegistry();
  const bot = registry.bots[name];
  if (!bot) throw new Error(`Unknown bot: ${name}`);
  const method = enabled ? "setWebhook" : "deleteWebhook";
  const body = enabled ? {
    url: bot.webhookUrl,
    secret_token: bot.telegramWebhookSecret,
    allowed_updates: ["message", "callback_query"],
  } : { drop_pending_updates: false };
  await telegram(configuration, bot.telegramBotToken, method, body);
  bot.paused = !enabled;
  bot.updatedAt = new Date().toISOString();
  await writeRegistry(registry);
  return bot;
}

async function botStatus(configuration, name) {
  const registry = await readRegistry();
  const bot = registry.bots[name];
  if (!bot) throw new Error(`Unknown bot: ${name}`);
  const webhook = await telegram(configuration, bot.telegramBotToken, "getWebhookInfo");
  let workerStatus = "unreachable";
  try {
    const url = new URL(bot.webhookUrl);
    url.pathname = "/";
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    workerStatus = response.ok ? `healthy (${response.status})` : `HTTP ${response.status}`;
  } catch { /* Report unreachable. */ }
  return { bot, webhook, workerStatus };
}

async function undeployBot(configuration, name) {
  return withOperation(name, async () => {
    const registry = await readRegistry();
    const bot = registry.bots[name];
    if (!bot) throw new Error(`Unknown bot: ${name}`);
    await telegram(configuration, bot.telegramBotToken, "deleteWebhook", { drop_pending_updates: false });
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${configuration.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${configuration.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(35_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) throw new Error(`Cloudflare undeploy failed: ${result.errors?.[0]?.message || response.status}`);
    bot.paused = true;
    bot.deployed = false;
    bot.updatedAt = new Date().toISOString();
    await writeRegistry(registry);
    return bot;
  });
}

async function rotateToken(configuration, name, token) {
  const registry = await readRegistry();
  if (!registry.bots[name]) throw new Error(`Unknown bot: ${name}`);
  return deployBot(configuration, name, token);
}

async function showHome(configuration, chatId, messageId, language = "en") {
  const text = tr(language,
    "<b>Telegram Bot Manager</b>\n\nCreate, deploy, inspect, repair, pause, and redeploy Cloudflare Worker bots from one place.",
    "<b>مدیریت ربات‌های تلگرام</b>\n\nساخت، استقرار، بررسی، تعمیر، توقف و استقرار مجدد ربات‌های Cloudflare Worker از یک محل.");
  if (messageId) return edit(configuration, chatId, messageId, text, { reply_markup: mainKeyboard(language) });
  return send(configuration, chatId, text, { reply_markup: mainKeyboard(language) });
}

async function showBots(configuration, chatId, messageId, language = "en") {
  const registry = await readRegistry();
  const entries = Object.entries(registry.bots).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    const text = tr(language, "<b>No managed bots yet.</b>\n\nChoose Create &amp; deploy to add the first one.", "<b>هنوز رباتی مدیریت نمی‌شود.</b>\n\nبرای افزودن اولین ربات، ساخت و استقرار را انتخاب کنید.");
    const keyboard = { inline_keyboard: [[{ text: tr(language, "➕ Create & deploy", "➕ ساخت و استقرار"), callback_data: callback("create") }], [{ text: tr(language, "🏠 Home", "🏠 خانه"), callback_data: callback("home") }]] };
    return messageId ? edit(configuration, chatId, messageId, text, { reply_markup: keyboard }) : send(configuration, chatId, text, { reply_markup: keyboard });
  }
  const buttons = entries.map(([name, bot]) => [{
    text: `${bot.deployed === false ? "⚫" : bot.paused ? "🟡" : "🟢"} ${name}`,
    callback_data: callback("bot", name),
  }]);
  buttons.push([{ text: tr(language, "➕ Create", "➕ ساخت"), callback_data: callback("create") }, { text: tr(language, "🏠 Home", "🏠 خانه"), callback_data: callback("home") }]);
  const text = tr(language, `<b>Managed bots (${entries.length})</b>\n\n🟢 active   🟡 webhook paused   ⚫ undeployed`, `<b>ربات‌های مدیریت‌شده (${entries.length})</b>\n\n🟢 فعال   🟡 وب‌هوک متوقف   ⚫ استقرار حذف‌شده`);
  return messageId ? edit(configuration, chatId, messageId, text, { reply_markup: { inline_keyboard: buttons } }) : send(configuration, chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function showBot(configuration, chatId, messageId, name, language = "en") {
  const registry = await readRegistry();
  const bot = registry.bots[name];
  if (!bot) throw new Error(`Unknown bot: ${name}`);
  const state = bot.deployed === false ? tr(language, "Undeployed", "استقرار حذف شده") : bot.paused ? tr(language, "Webhook paused", "وب‌هوک متوقف") : tr(language, "Active", "فعال");
  const repository = bot.githubUrl ? `<a href="${html(bot.githubUrl)}">${html(bot.githubRepository)}</a>` : tr(language, "not linked", "متصل نیست");
  const text = tr(language,
    `<b>${html(name)}</b>\n\nState: ${state}\nPrivate repository: ${repository}\nWebhook: <code>${html(bot.webhookUrl)}</code>\nUpdated: ${html(bot.updatedAt || "unknown")}\n\nRedeploy always clones a fresh temporary copy from GitHub.`,
    `<b>${html(name)}</b>\n\nوضعیت: ${state}\nمخزن خصوصی: ${repository}\nوب‌هوک: <code>${html(bot.webhookUrl)}</code>\nآخرین تغییر: ${html(bot.updatedAt || "نامشخص")}\n\nبرای هر استقرار مجدد، یک نسخه موقت تازه از GitHub دریافت می‌شود.`);
  return edit(configuration, chatId, messageId, text, { reply_markup: botKeyboard(name, bot, language) });
}

async function showStatus(configuration, chatId, messageId, name, language = "en") {
  await edit(configuration, chatId, messageId, tr(language, `<b>${html(name)}</b>\n\nChecking Worker and Telegram webhook…`, `<b>${html(name)}</b>\n\nدر حال بررسی Worker و وب‌هوک تلگرام…`));
  const { bot, webhook, workerStatus } = await botStatus(configuration, name);
  const lines = language === "fa" ? [
    `<b>وضعیت ${html(name)}</b>`,
    "",
    `Worker: ${html(workerStatus)}`,
    `وب‌هوک تنظیم شده: ${webhook.url ? "بله" : "خیر"}`,
    `پیام‌های در انتظار: ${Number(webhook.pending_update_count || 0)}`,
    `آخرین خطا: ${html(webhook.last_error_message || "ندارد")}`,
    `نشانی: <code>${html(bot.webhookUrl)}</code>`,
  ] : [
    `<b>${html(name)} status</b>`,
    "",
    `Worker: ${html(workerStatus)}`,
    `Webhook configured: ${webhook.url ? "yes" : "no"}`,
    `Pending updates: ${Number(webhook.pending_update_count || 0)}`,
    `Last error: ${html(webhook.last_error_message || "none")}`,
    `Endpoint: <code>${html(bot.webhookUrl)}</code>`,
  ];
  return edit(configuration, chatId, messageId, lines.join("\n"), { reply_markup: botKeyboard(name, bot, language) });
}

async function handleText(configuration, message) {
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const selectedLanguage = languageFor(userId);
  const language = selectedLanguage || "en";
  const text = (message.text || "").trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/cancel") {
    conversations.delete(chatId);
    return send(configuration, chatId, tr(language, "Cancelled.", "لغو شد."), { reply_markup: mainKeyboard(language) });
  }
  if (command === "/language" || (!selectedLanguage && ["/start", "/menu"].includes(command))) {
    conversations.delete(chatId);
    return send(configuration, chatId, "Choose your language.\nزبان خود را انتخاب کنید.", { reply_markup: languageKeyboard() });
  }
  if (["/start", "/menu"].includes(command)) {
    conversations.delete(chatId);
    if (missingDeploymentCredentials(configuration).length) return promptForNextCredential(configuration, chatId, language, "home");
    return showHome(configuration, chatId, undefined, language);
  }
  if (!selectedLanguage) return send(configuration, chatId, "Choose your language.\nزبان خود را انتخاب کنید.", { reply_markup: languageKeyboard() });
  if (command === "/bots") return showBots(configuration, chatId, undefined, language);
  if (command === "/setup") return promptForNextCredential(configuration, chatId, language, "home");
  if (command === "/create") {
    if (missingDeploymentCredentials(configuration).length) return promptForNextCredential(configuration, chatId, language, "create");
    return promptForCreateName(configuration, chatId, language);
  }
  if (command === "/help") {
    const help = tr(language,
      "<b>Commands</b>\n\n/create — guided bot creation and deployment\n/bots — list and manage bots\n/setup — continue missing credential setup\n/language — switch English/Persian\n/menu — main menu\n/cancel — cancel the current step\n\nSecret-bearing messages are deleted after receipt when Telegram permits it.",
      "<b>دستورها</b>\n\n/create — ساخت و استقرار مرحله‌به‌مرحله ربات\n/bots — نمایش و مدیریت ربات‌ها\n/setup — ادامه تنظیم اطلاعات ناقص\n/language — تغییر زبان فارسی/انگلیسی\n/menu — منوی اصلی\n/cancel — لغو مرحله فعلی\n\nپیام‌های حاوی اطلاعات محرمانه پس از دریافت، در صورت امکان از تلگرام حذف می‌شوند.");
    return send(configuration, chatId, help, { reply_markup: mainKeyboard(language) });
  }

  const conversation = conversations.get(chatId);
  if (!conversation) return showHome(configuration, chatId, undefined, language);
  if (conversation.stage === "setup-credential") {
    const { credential, resume } = conversation;
    if (credentialIsSecret(credential)) await safeDeleteMessage(configuration, chatId, message.message_id);
    try {
      const value = validateCredential(credential, text);
      await verifyCredential(configuration, credential, value);
      await saveEnvironmentValue(configuration, credential, value);
      await send(configuration, chatId, tr(language, `✅ ${html(credential)} saved and verified.`, `✅ مقدار ${html(credential)} ذخیره و تأیید شد.`));
      return promptForNextCredential(configuration, chatId, language, resume);
    } catch (error) {
      await send(configuration, chatId, `${tr(language, "The value was not accepted:", "این مقدار پذیرفته نشد:")}\n${html(error.message)}\n\n${tr(language, "Please try again.", "لطفاً دوباره تلاش کنید.")}`);
      return send(configuration, chatId, credentialInstructions(credential, language));
    }
  }
  if (conversation.stage === "create-name") {
    try {
      const name = validateWorkerName(text);
      if (await botExists(name)) throw new Error("A managed bot with that name already exists.");
      conversations.set(chatId, { stage: "create-token", name, language });
      return send(configuration, chatId, botTokenInstructions(name, language));
    } catch (error) { return send(configuration, chatId, html(error.message)); }
  }
  if (["create-token", "rotate-token"].includes(conversation.stage)) {
    let token;
    try { token = validateBotToken(text); }
    catch (error) { return send(configuration, chatId, html(error.message)); }
    await safeDeleteMessage(configuration, chatId, message.message_id);
    conversations.delete(chatId);
    const progressText = conversation.stage === "create-token"
      ? tr(language, `<b>Creating and deploying ${html(conversation.name)}…</b>\n\nThe private GitHub repository and Cloudflare Worker are being created. This can take a few minutes.`, `<b>در حال ساخت و استقرار ${html(conversation.name)}…</b>\n\nمخزن خصوصی GitHub و Cloudflare Worker در حال ساخت هستند. این کار ممکن است چند دقیقه طول بکشد.`)
      : tr(language, `<b>Rotating token and redeploying ${html(conversation.name)}…</b>`, `<b>در حال تعویض توکن و استقرار مجدد ${html(conversation.name)}…</b>`);
    const progress = await send(configuration, chatId, progressText);
    try {
      const bot = conversation.stage === "create-token"
        ? await deployBot(configuration, conversation.name, token, { create: true })
        : await rotateToken(configuration, conversation.name, token);
      const completed = tr(language,
        `<b>${html(conversation.name)} is deployed.</b>\n\nPrivate GitHub repository:\n<a href="${html(bot.githubUrl)}">${html(bot.githubUrl)}</a>\n\nTelegram webhook: <code>${html(bot.webhookUrl)}</code>`,
        `<b>${html(conversation.name)} با موفقیت مستقر شد.</b>\n\nمخزن خصوصی GitHub:\n<a href="${html(bot.githubUrl)}">${html(bot.githubUrl)}</a>\n\nوب‌هوک تلگرام: <code>${html(bot.webhookUrl)}</code>`);
      return edit(configuration, chatId, progress.message_id, completed, { reply_markup: botKeyboard(conversation.name, bot, language) });
    } catch (error) {
      console.error("Deployment failed", error);
      return edit(configuration, chatId, progress.message_id, `${tr(language, "<b>Deployment failed.</b>", "<b>استقرار ناموفق بود.</b>")}\n\n${html(error.message).slice(0, 3000)}`, { reply_markup: mainKeyboard(language) });
    }
  }
}

async function handleCallback(configuration, query) {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  let language = languageFor(userId) || "en";
  const messageId = query.message.message_id;
  const item = callbacks.get(query.data);
  await telegram(configuration, configuration.MANAGER_TELEGRAM_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
  if (!item || item.expires < Date.now()) return edit(configuration, chatId, messageId, tr(language, "This menu expired. Open a fresh menu.", "این منو منقضی شده است. یک منوی جدید باز کنید."), { reply_markup: mainKeyboard(language) });
  callbacks.delete(query.data);
  const { action, name } = item;
  if (action === "choose-language") return edit(configuration, chatId, messageId, "Choose your language.\nزبان خود را انتخاب کنید.", { reply_markup: languageKeyboard() });
  if (action === "language") {
    language = name === "fa" ? "fa" : "en";
    managerState.languages[userId] = language;
    await saveManagerState();
    if (missingDeploymentCredentials(configuration).length) return promptForNextCredential(configuration, chatId, language, "home", messageId);
    return showHome(configuration, chatId, messageId, language);
  }
  if (action === "home") return showHome(configuration, chatId, messageId, language);
  if (action === "help") {
    const help = tr(language,
      "<b>Telegram Bot Manager</b>\n\nCreate and deploy guides you through every missing credential, then asks for a project name and BotFather token. My bots provides status, GitHub-backed redeploy, webhook repair, pause, token rotation, and undeploy controls.",
      "<b>مدیریت ربات‌های تلگرام</b>\n\nبخش ساخت و استقرار، تمام اطلاعات ناقص را مرحله‌به‌مرحله دریافت می‌کند و سپس نام پروژه و توکن BotFather را می‌پرسد. بخش ربات‌های من شامل وضعیت، استقرار مجدد از GitHub، تعمیر یا توقف وب‌هوک، تعویض توکن و حذف استقرار است.");
    return edit(configuration, chatId, messageId, help, { reply_markup: mainKeyboard(language) });
  }
  if (action === "bots") return showBots(configuration, chatId, messageId, language);
  if (action === "create") {
    if (missingDeploymentCredentials(configuration).length) return promptForNextCredential(configuration, chatId, language, "create", messageId);
    return promptForCreateName(configuration, chatId, language, messageId);
  }
  if (action === "bot") return showBot(configuration, chatId, messageId, name, language);
  if (action === "status") return showStatus(configuration, chatId, messageId, name, language);
  if (action === "rotate") {
    if (missingDeploymentCredentials(configuration).length) return promptForNextCredential(configuration, chatId, language, "home", messageId);
    conversations.set(chatId, { stage: "rotate-token", name, language });
    return edit(configuration, chatId, messageId, botTokenInstructions(name, language, true));
  }
  if (["pause", "resume"].includes(action)) {
    await edit(configuration, chatId, messageId, tr(language, `<b>${html(name)}</b>\n\n${action === "pause" ? "Pausing" : "Registering"} webhook…`, `<b>${html(name)}</b>\n\nدر حال ${action === "pause" ? "توقف" : "ثبت"} وب‌هوک…`));
    const bot = await setWebhook(configuration, name, action === "resume");
    return edit(configuration, chatId, messageId, tr(language, `<b>${html(name)}</b>\n\nWebhook ${action === "pause" ? "paused" : "active"}.`, `<b>${html(name)}</b>\n\nوب‌هوک ${action === "pause" ? "متوقف شد" : "فعال شد"}.`), { reply_markup: botKeyboard(name, bot, language) });
  }
  if (action === "redeploy") {
    if (missingDeploymentCredentials(configuration).length) return promptForNextCredential(configuration, chatId, language, "home", messageId);
    const registry = await readRegistry();
    const bot = registry.bots[name];
    await edit(configuration, chatId, messageId, tr(language, `<b>Redeploying ${html(name)}…</b>\n\nA fresh temporary clone is being pulled from GitHub. This can take a few minutes.`, `<b>در حال استقرار مجدد ${html(name)}…</b>\n\nیک نسخه موقت تازه از GitHub دریافت می‌شود. این کار ممکن است چند دقیقه طول بکشد.`));
    try {
      const deployed = await deployBot(configuration, name, bot.telegramBotToken);
      return edit(configuration, chatId, messageId, tr(language, `<b>${html(name)} redeployed successfully.</b>`, `<b>${html(name)} با موفقیت دوباره مستقر شد.</b>`), { reply_markup: botKeyboard(name, deployed, language) });
    } catch (error) {
      console.error("Redeploy failed", error);
      return edit(configuration, chatId, messageId, `${tr(language, "<b>Redeploy failed.</b>", "<b>استقرار مجدد ناموفق بود.</b>")}\n\n${html(error.message).slice(0, 3000)}`, { reply_markup: botKeyboard(name, bot, language) });
    }
  }
  if (action === "confirm-undeploy") {
    const keyboard = { inline_keyboard: [[
      { text: tr(language, "Yes, undeploy", "بله، حذف استقرار"), callback_data: callback("undeploy", name) },
      { text: tr(language, "Cancel", "لغو"), callback_data: callback("bot", name) },
    ]] };
    return edit(configuration, chatId, messageId, tr(language, `<b>Undeploy ${html(name)}?</b>\n\nThe Cloudflare Worker and webhook will be removed. Its private GitHub repository remains so you can redeploy later.`, `<b>استقرار ${html(name)} حذف شود؟</b>\n\nCloudflare Worker و وب‌هوک حذف می‌شوند، اما مخزن خصوصی GitHub برای استقرار مجدد باقی می‌ماند.`), { reply_markup: keyboard });
  }
  if (action === "undeploy") {
    await edit(configuration, chatId, messageId, tr(language, `<b>Undeploying ${html(name)}…</b>`, `<b>در حال حذف استقرار ${html(name)}…</b>`));
    const bot = await undeployBot(configuration, name);
    return edit(configuration, chatId, messageId, tr(language, `<b>${html(name)} is undeployed.</b>\n\nThe private GitHub repository was preserved. Use Redeploy to restore it.`, `<b>استقرار ${html(name)} حذف شد.</b>\n\nمخزن خصوصی GitHub حفظ شد. برای بازگردانی از استقرار مجدد استفاده کنید.`), { reply_markup: botKeyboard(name, bot, language) });
  }
}

async function processUpdate(configuration, ownerIds, update) {
  const message = update.message;
  const query = update.callback_query;
  const userId = String(message?.from?.id ?? query?.from?.id ?? "");
  if (!ownerIds.has(userId)) {
    console.warn(`Rejected Telegram user ${userId || "unknown"}`);
    return;
  }
  try {
    if (message) await handleText(configuration, message);
    else if (query?.message) await handleCallback(configuration, query);
  } catch (error) {
    console.error("Update failed", error);
    const chatId = message?.chat?.id ?? query?.message?.chat?.id;
    const language = languageFor(userId) || "en";
    if (chatId) await send(configuration, chatId, `${tr(language, "<b>Operation failed.</b>", "<b>عملیات ناموفق بود.</b>")}\n\n${html(error.message).slice(0, 3000)}`, { reply_markup: mainKeyboard(language) }).catch(() => {});
  }
}

export async function startManager() {
  const configuration = await readEnvironment();
  const required = ["MANAGER_TELEGRAM_BOT_TOKEN", "MANAGER_TELEGRAM_OWNER_IDS"];
  const missing = required.filter((name) => !configuration[name]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
  validateBotToken(configuration.MANAGER_TELEGRAM_BOT_TOKEN);
  await loadManagerState();
  const ownerIds = new Set(configuration.MANAGER_TELEGRAM_OWNER_IDS.split(",").map((value) => value.trim()).filter(Boolean));
  await access(projectRoot, constants.R_OK | constants.W_OK);
  await telegram(configuration, configuration.MANAGER_TELEGRAM_BOT_TOKEN, "deleteWebhook", { drop_pending_updates: false });
  await telegram(configuration, configuration.MANAGER_TELEGRAM_BOT_TOKEN, "setMyCommands", { commands: [
    { command: "menu", description: "Open the bot manager" },
    { command: "create", description: "Create and deploy a bot" },
    { command: "bots", description: "List and manage bots" },
    { command: "setup", description: "Configure missing credentials" },
    { command: "language", description: "English / فارسی" },
    { command: "help", description: "Show help" },
    { command: "cancel", description: "Cancel the current operation" },
  ] });
  console.log(`Telegram Bot Manager started for ${ownerIds.size} owner(s).`);
  let offset = 0;
  while (true) {
    cleanupCallbacks();
    try {
      const updates = await telegram(configuration, configuration.MANAGER_TELEGRAM_BOT_TOKEN, "getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        await processUpdate(configuration, ownerIds, update);
      }
    } catch (error) {
      console.error("Polling failed", error.message);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startManager().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
