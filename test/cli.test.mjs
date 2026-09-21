import assert from "node:assert/strict";
import test from "node:test";
import { cloudflareTokenHelp, commandInvocation, maskTerminalInput, projectEnvironment } from "../src/cli.mjs";

test("Cloudflare token help states the minimum account permissions", () => {
  assert.match(cloudflareTokenHelp, /Workers → Admin/);
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
