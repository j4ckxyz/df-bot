# df-bot

Unofficial Daring Fireball bot that monitors the [Daring Fireball JSON Feed](https://daringfireball.net/feeds/json) and posts new entries to [Bluesky](https://bsky.app).

## Features

- Polls the Daring Fireball JSON feed every 3 minutes
- Posts new entries as Bluesky card embeds (with OG image, title, and description)
- Deduplicates posts using SQLite — no duplicate posts across restarts
- On first startup, seeds the database with all current items so only _genuinely new_ items are posted
- Supports custom AT Protocol PDS instances

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later

## Setup

1. **Clone and install dependencies:**

   ```bash
   git clone https://github.com/j4ckxyz/df-bot.git
   cd df-bot
   bun install
   ```

2. **Create a `.env` file** (copy from `.env.example`):

   ```bash
   cp .env.example .env
   ```

   Fill in your credentials:

   ```env
   # Your Bluesky handle (e.g. you.bsky.social or a custom domain)
   BSKY_IDENTIFIER=you.bsky.social

   # An App Password created at https://bsky.app/settings/app-passwords
   BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

   # The PDS (Personal Data Server) URL.
   # Use https://bsky.social for the default Bluesky network.
   # Change to your self-hosted PDS URL if applicable (e.g. https://pds.example.com).
   BSKY_PDS_URL=https://bsky.social
   ```

   | Variable           | Description                                                        |
   | ------------------ | ------------------------------------------------------------------ |
   | `BSKY_IDENTIFIER`  | Your Bluesky handle or DID                                         |
   | `BSKY_APP_PASSWORD`| An App Password from your Bluesky account settings                 |
   | `BSKY_PDS_URL`     | The AT Protocol PDS base URL (default `https://bsky.social`)       |

## Running

```bash
bun run index.ts
```

The bot will:
1. Log in to Bluesky
2. Seed the database with all current Daring Fireball items (no posts yet)
3. Poll every 3 minutes and post any new items it hasn't seen before

## Running persistently with PM2

Install PM2 globally if you haven't already:

```bash
npm install -g pm2
```

Start the bot:

```bash
pm2 start index.ts --interpreter bun --name df-bot
```

Useful PM2 commands:

```bash
pm2 logs df-bot       # tail logs
pm2 status            # check process status
pm2 restart df-bot    # restart the bot
pm2 stop df-bot       # stop the bot
pm2 startup           # configure PM2 to start on system boot
pm2 save              # save current process list
```

## How it works

1. The bot fetches `https://daringfireball.net/feeds/json` (JSON Feed format).
2. For each item, the **embed URL** is determined:
   - If the item has an `external_url` (link posts), that outbound URL is used.
   - Otherwise the DF article URL (`url` / `id`) is used.
3. OG tags (`og:title`, `og:description`, `og:image`, `og:url`) are scraped from the embed URL using Bun's built-in `HTMLRewriter`.
4. If an OG image is found, it is uploaded to Bluesky via `agent.uploadBlob()`.
5. A post is created with the item title as text and an `app.bsky.embed.external` card containing the link, title, description, and thumbnail.
6. The item `id` (canonical DF URL) is recorded in a local SQLite database (`seen.db`) to prevent re-posting.

## License

MIT

