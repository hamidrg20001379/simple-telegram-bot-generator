import assert from "node:assert/strict";
import test from "node:test";
import { cloudflareTokenHelp, commandInvocation, maskTerminalInput, projectEnvironment, wranglerConfig } from "../src/cli.mjs";
import { credentialInstructions, parseEnv, validateBotToken, validateCredential, validateWorkerName } from "../src/manager.mjs";

test("Cloudflare token help states the minimum account permissions", () => {
  assert.match(cloudflareTokenHelp, /Workers → Admin/);
  assert.match(cloudflareTokenHelp, /D1 → Edit/);
  assert.match(cloudflareTokenHelp, /Account Settings → Read/);
  assert.match(cloudflareTokenHelp, /only the account/);
});

test("Windows runs npm through cmd instead of spawning npm.cmd", () => {
  const invocation = commandInvocation("npm", ["install"]);
  if (process.platform === "win32") {
    assert.match(invocation.executable, /cmd\.exe$/i);
    assert.deepEqual(invocation.args, ["/d", "/s", "/c", "npm install"]);
  } else {
    assert.deepEqual(invocation, { executable: "npm", args: ["install"] });
  }
});

test("credential input is masked without removing line endings", () => {
  assert.equal(maskTerminalInput("secret-token\r\n"), "************\r\n");
});

test("deployment credentials are written to the generated project's ignored env file", () => {
  const env = projectEnvironment({
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "api token",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
  }, "https://bot.example.com/webhook");
  assert.match(env, /^CLOUDFLARE_ACCOUNT_ID="account"$/m);
  assert.match(env, /^TELEGRAM_BOT_TOKEN="bot:token"$/m);
  assert.match(env, /^TELEGRAM_WEBHOOK_URL="https:\/\/bot\.example\.com\/webhook"$/m);
});

test("generated Wrangler config includes a D1 database binding by default", () => {
  const config = wranglerConfig("my-first-bot");
  assert.match(config, /\"d1_databases\"/);
  assert.match(config, /\"binding\": \"DB\"/);
  assert.match(config, /\"database_name\": \"my-first-bot-db\"/);
});

test("generated Wrangler config uses the provisioned D1 database ID", () => {
  const config = wranglerConfig("my-first-bot", "01234567-89ab-cdef-0123-456789abcdef");
  assert.match(config, /\"database_id\": \"01234567-89ab-cdef-0123-456789abcdef\"/);
});

test("manager parses quoted environment values", () => {
  assert.deepEqual(parseEnv('A=plain\nB="two words"\n# ignored\n'), { A: "plain", B: "two words" });
});

test("manager accepts safe worker names and rejects paths", () => {
  assert.equal(validateWorkerName("my-first-bot"), "my-first-bot");
  assert.throws(() => validateWorkerName("../escape"), /lowercase/);
});

test("manager validates Telegram token shape", () => {
  assert.equal(validateBotToken("123456789:abcdefghijklmnopqrstuvwxyz_ABC"), "123456789:abcdefghijklmnopqrstuvwxyz_ABC");
  assert.throws(() => validateBotToken("not-a-token"), /does not look/);
});

test("manager validates deployment credentials before saving them", () => {
  assert.equal(validateCredential("CLOUDFLARE_ACCOUNT_ID", "0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
  assert.throws(() => validateCredential("CLOUDFLARE_ACCOUNT_ID", "short"), /32-character/);
  assert.equal(validateCredential("GITHUB_TOKEN", `ghp_${"a".repeat(36)}`), `ghp_${"a".repeat(36)}`);
});

test("credential guidance is available in English and Persian", () => {
  assert.match(credentialInstructions("GITHUB_TOKEN", "en"), /Personal access tokens/);
  assert.match(credentialInstructions("GITHUB_TOKEN", "fa"), /توکن GitHub/);
  assert.match(credentialInstructions("CLOUDFLARE_API_TOKEN", "fa"), /Workers Scripts/);
});
