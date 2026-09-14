# Simple Telegram Bot Generator

This command creates a small TypeScript Cloudflare Worker, a secure Telegram webhook endpoint, and a GitHub Actions deployment workflow. With `--deploy`, it also does the first deployment and connects Telegram to the Worker.

It never writes credentials into the generated Worker project. Cloudflare account credentials stay in local `.env`; each bot's Telegram credentials and webhook details are kept in local `.telegram-bots.json`. Both files are ignored by Git.

## Create a bot project

```powershell
npm run create -- init my-first-bot
```

This creates `./my-first-bot`. Change `src/index.ts` to give the bot its actual behavior.

## Create and connect the first deployment

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in local `.env`. Provide the new bot's `TELEGRAM_BOT_TOKEN` as a temporary shell environment variable. `TELEGRAM_WEBHOOK_SECRET` is optional; if you omit it, the generator creates a secure value. After deployment, the generator saves the bot token, webhook secret, Worker name, and webhook URL in local `.telegram-bots.json`.

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

Future changes can be deployed with the generated GitHub Actions workflow. Add the four values above as repository secrets and set the non-secret `TELEGRAM_WEBHOOK_URL` repository variable to the final URL ending in `/webhook`.

## First Cloudflare account caveat

A Worker needs a `workers.dev` subdomain or a custom domain before Telegram can reach it. The generator safely reads an existing `workers.dev` subdomain; it deliberately does not invent and permanently claim an account-wide subdomain. Choose one once in Cloudflare, or pass a custom webhook URL.
