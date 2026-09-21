# Simple Telegram Bot Generator

This command creates a small TypeScript Cloudflare Worker, a secure Telegram webhook endpoint, and a GitHub Actions deployment workflow. With `--deploy`, it also does the first deployment and connects Telegram to the Worker.

With `--deploy`, the command asks for any missing Cloudflare account ID, Cloudflare API token, and Telegram bot token. It saves them, along with the webhook secret and URL, in the generated project's ignored `.env` file.

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
