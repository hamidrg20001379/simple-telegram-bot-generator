# Simple Telegram Bot Generator

This command creates a small TypeScript Cloudflare Worker, a secure Telegram webhook endpoint, and a GitHub Actions deployment workflow. With `--deploy`, it also does the first deployment and connects Telegram to the Worker.

With `--deploy`, the command asks for any missing Cloudflare account ID, Cloudflare API token, and Telegram bot token. It saves them, along with the webhook secret and URL, in the generated project's ignored `.env` file.

## Central Telegram Bot Manager

The repository also includes a persistent, owner-only Telegram control bot that replaces the normal CLI for day-to-day use. From Telegram it can:

- create and deploy a generated bot;
- list every managed bot and open its details;
- check Worker health and Telegram webhook errors;
- redeploy source changes;
- pause, resume, or repair a webhook;
- rotate a BotFather token and redeploy;
- undeploy a Worker while preserving its private GitHub repository for later redeployment.

Every generated bot gets its own private GitHub repository. Creation happens in a temporary directory, the source is pushed to GitHub, the Worker is deployed, and the temporary directory is removed. Redeploy performs a fresh temporary clone. No generated bot project is stored as a subfolder of this repository. The manager configures each repository's GitHub Actions secrets and `TELEGRAM_WEBHOOK_URL` variable before pushing the generated deployment workflow.

### One-time bootstrap / راه‌اندازی اولیه

The manager can request Cloudflare and GitHub credentials inside Telegram, but it cannot contact you until its own Telegram identity exists. Configure only these bootstrap values on the server:

1. Open `@BotFather`, send `/newbot`, choose a display name, and choose a unique username ending in `bot`.
2. Copy `.env.example` to `.env` and put BotFather's token in `MANAGER_TELEGRAM_BOT_TOKEN`.
3. Put your numeric Telegram user ID in `MANAGER_TELEGRAM_OWNER_IDS`. Multiple owners may be comma-separated.
4. If this server cannot contact `api.telegram.org`, set `TELEGRAM_API_BASE_URL` to the proxy prefix ending in `/bot`. The manager appends the token and method.
5. Set the file mode to `0600`, then start the manager service.
6. Send `/start` to the manager, choose English or Persian, and follow its guided instructions for every missing Cloudflare or GitHub value.

مدیر می‌تواند اطلاعات Cloudflare و GitHub را داخل تلگرام مرحله‌به‌مرحله دریافت کند، اما برای شروع ارتباط باید ابتدا هویت تلگرامی خودش ساخته شود:

۱. در `@BotFather` دستور `/newbot` را بفرستید، نام نمایشی و یک نام کاربری یکتا که به `bot` ختم می‌شود انتخاب کنید.
۲. فایل `.env.example` را با نام `.env` کپی کرده و توکن BotFather را در `MANAGER_TELEGRAM_BOT_TOKEN` قرار دهید.
۳. شناسه عددی تلگرام خود را در `MANAGER_TELEGRAM_OWNER_IDS` وارد کنید. برای چند مدیر، شناسه‌ها را با ویرگول جدا کنید.
۴. اگر سرور به `api.telegram.org` دسترسی ندارد، مقدار `TELEGRAM_API_BASE_URL` را روی آدرس پراکسی که به `/bot` ختم می‌شود تنظیم کنید.
۵. سطح دسترسی فایل را `0600` کرده و سرویس مدیر را اجرا کنید.
۶. دستور `/start` را برای ربات مدیر بفرستید، زبان فارسی یا انگلیسی را انتخاب کنید و مراحل دریافت اطلاعات ناقص Cloudflare و GitHub را ادامه دهید.

Deployment credentials are never committed to source. They are stored locally and encrypted into each generated private repository's GitHub Actions secrets. Secret-bearing Telegram messages are deleted after processing when Telegram permits it.

Start it with:

```bash
npm run manager
```

For an always-on server installation, copy `deploy/simple-telegram-bot-manager.service` to `~/.config/systemd/user/`, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now simple-telegram-bot-manager.service
loginctl enable-linger "$USER"
```

The service restarts after failures and starts again after a server reboot.

Use a dedicated BotFather bot for the manager. Do not reuse a managed bot token or another polling service will conflict with it. The local registry contains deployment metadata and bot credentials in an ignored owner-only file; generated source lives in each bot's private GitHub repository.

## Create a bot project

```powershell
npm run create -- init my-first-bot
```

This creates `./my-first-bot`. Change `src/index.ts` to give the bot its actual behavior.

## Create and connect the first deployment

Run the command and enter any missing credentials when asked. Existing shell or generator `.env` values are still used. `TELEGRAM_WEBHOOK_SECRET` remains optional; the generator creates it when absent.

```powershell
npm run create -- init my-first-bot --deploy --workers-subdomain your-workers-subdomain
```

`your-workers-subdomain` is the part before `.workers.dev`. If the Cloudflare account already has a Workers subdomain, you can omit that option and the generator will read it through Cloudflare's API. For a custom domain, use `--webhook-url https://bot.example.com/webhook` instead.

The `--deploy` path performs this sequence:

1. Creates the Worker project and installs its dependencies.
2. Deploys the Worker to Cloudflare.
3. Stores the Telegram bot token and webhook secret in Cloudflare as Worker secrets.
4. Determines the public `/webhook` URL.
5. Calls Telegram `setWebhook` with that URL and the matching secret.
6. Saves all deployment credentials and that URL in the created project's ignored `.env`.

Future changes can be deployed with the generated GitHub Actions workflow. Add the four values above as repository secrets and set the non-secret `TELEGRAM_WEBHOOK_URL` repository variable to the final URL ending in `/webhook`.

## First Cloudflare account caveat

A Worker needs a `workers.dev` subdomain or a custom domain before Telegram can reach it. The generator safely reads an existing `workers.dev` subdomain; it deliberately does not invent and permanently claim an account-wide subdomain. Choose one once in Cloudflare, or pass a custom webhook URL.
