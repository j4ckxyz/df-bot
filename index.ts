import { BskyAgent } from "@atproto/api";
import type { AppBskyEmbedExternal, $Typed } from "@atproto/api";
import { BlobRef } from "@atproto/lexicon";
import { Database } from "bun:sqlite";

// ── Environment ────────────────────────────────────────────────────────────────

const BSKY_IDENTIFIER = process.env.BSKY_IDENTIFIER ?? "";
const BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD ?? "";
const BSKY_PDS_URL = process.env.BSKY_PDS_URL ?? "https://bsky.social";

if (!BSKY_IDENTIFIER || !BSKY_APP_PASSWORD) {
  console.error(
    "Missing required env vars: BSKY_IDENTIFIER and BSKY_APP_PASSWORD"
  );
  process.exit(1);
}

const FEED_URL = "https://daringfireball.net/feeds/json";
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const BACKFILL_COUNT = 5; // number of recent posts to backfill on first run
const BACKFILL_DELAY_MS = 10 * 1000; // 10 seconds between backfill posts

// ── SQLite ─────────────────────────────────────────────────────────────────────

const db = new Database("seen.db");
db.run(
  "CREATE TABLE IF NOT EXISTS seen_items (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)"
);

function hasSeen(id: string): boolean {
  return !!db.query("SELECT 1 FROM seen_items WHERE id = ?").get(id);
}

function markSeen(id: string): void {
  db.run("INSERT OR IGNORE INTO seen_items (id, seen_at) VALUES (?, ?)", [
    id,
    Date.now(),
  ]);
}

function isDbEmpty(): boolean {
  return !db.query("SELECT 1 FROM seen_items LIMIT 1").get();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── JSON Feed types ────────────────────────────────────────────────────────────

interface FeedItem {
  id: string;
  title?: string;
  url?: string;
  external_url?: string;
}

interface JsonFeed {
  items: FeedItem[];
}

// ── Feed fetching ──────────────────────────────────────────────────────────────

async function fetchFeed(): Promise<FeedItem[]> {
  const res = await fetch(FEED_URL);
  if (!res.ok) {
    throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  }
  const feed = (await res.json()) as JsonFeed;
  return feed.items ?? [];
}

// ── OG tag scraping ────────────────────────────────────────────────────────────

interface OgTags {
  title: string;
  description: string;
  image: string;
  url: string;
}

async function fetchOgTags(pageUrl: string): Promise<OgTags> {
  const tags: Partial<OgTags> = {};

  const res = await fetch(pageUrl, {
    headers: { "User-Agent": "df-bot/1.0 (Bluesky feed bot)" },
  });
  if (!res.ok) {
    throw new Error(`OG fetch failed: ${res.status} for ${pageUrl}`);
  }

  const rewriter = new HTMLRewriter();
  rewriter.on('meta[property="og:title"]', {
    element(el) {
      tags.title = el.getAttribute("content") ?? "";
    },
  });
  rewriter.on('meta[property="og:description"]', {
    element(el) {
      tags.description = el.getAttribute("content") ?? "";
    },
  });
  rewriter.on('meta[property="og:image"]', {
    element(el) {
      tags.image = el.getAttribute("content") ?? "";
    },
  });
  rewriter.on('meta[property="og:url"]', {
    element(el) {
      tags.url = el.getAttribute("content") ?? "";
    },
  });

  // Consume the response through HTMLRewriter (we don't need the transformed output)
  await rewriter.transform(res).text();

  return {
    title: tags.title ?? "",
    description: tags.description ?? "",
    image: tags.image ?? "",
    url: tags.url || pageUrl,
  };
}

// ── MIME type helper ───────────────────────────────────────────────────────────

function mimeFromExtension(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return map[ext] ?? "image/jpeg";
}

// ── Image upload ───────────────────────────────────────────────────────────────

async function uploadImage(
  agent: BskyAgent,
  imageUrl: string
): Promise<BlobRef | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "df-bot/1.0 (Bluesky feed bot)" },
    });
    if (!res.ok) {
      throw new Error(`Image fetch failed: ${res.status}`);
    }
    const contentType =
      res.headers.get("content-type")?.split(";")[0].trim() ||
      mimeFromExtension(imageUrl);
    const buf = await res.arrayBuffer();
    const data = new Uint8Array(buf);
    const result = await agent.uploadBlob(data, { encoding: contentType });
    return result.data.blob;
  } catch (err) {
    console.error("Image upload failed, posting without thumbnail:", err);
    return null;
  }
}

// ── Post a single feed item ────────────────────────────────────────────────────

async function postItem(agent: BskyAgent, item: FeedItem): Promise<void> {
  const embedUrl = item.external_url ?? item.url ?? item.id;
  const title = item.title ?? "";

  // Validate that we have a usable URL before attempting to post
  if (!embedUrl) {
    console.error(`Skipping item with no usable URL: ${JSON.stringify(item)}`);
    return;
  }
  if (!/^https?:\/\//i.test(embedUrl)) {
    console.error(`Skipping item with non-HTTP URL: ${embedUrl}`);
    return;
  }

  let ogTitle = "";
  let ogDescription = "";
  let ogImageUrl = "";
  let cardUri = embedUrl;

  try {
    const og = await fetchOgTags(embedUrl);
    ogTitle = og.title;
    ogDescription = og.description;
    ogImageUrl = og.image;
    cardUri = og.url || embedUrl;
  } catch (err) {
    console.error(`OG scraping failed for ${embedUrl}:`, err);
    // Fall back: post with empty title/description, raw embedUrl as uri
  }

  let thumb: BlobRef | undefined;
  if (ogImageUrl) {
    const uploaded = await uploadImage(agent, ogImageUrl);
    if (uploaded) {
      thumb = uploaded;
    }
  }

  const external: AppBskyEmbedExternal.External = {
    uri: cardUri,
    title: ogTitle,
    description: ogDescription,
    ...(thumb ? { thumb } : {}),
  };

  const embed: $Typed<AppBskyEmbedExternal.Main> = {
    $type: "app.bsky.embed.external",
    external,
  };

  await agent.post({
    text: title,
    embed,
  });

  console.log(`Posted: ${title} → ${cardUri}`);
}

// ── Main polling loop ──────────────────────────────────────────────────────────

async function poll(agent: BskyAgent): Promise<void> {
  let items: FeedItem[];
  try {
    items = await fetchFeed();
  } catch (err) {
    console.error("Failed to fetch feed:", err);
    return;
  }

  const firstRun = isDbEmpty();

  if (firstRun) {
    // True first run: backfill the N most recent items, then seed the rest
    // Feed items are newest-first; post oldest-first so they appear in order
    const toPost = items.slice(0, BACKFILL_COUNT).reverse();
    const toSeed = items.slice(BACKFILL_COUNT);

    console.log(
      `First run: backfilling ${toPost.length} post(s), seeding ${toSeed.length} older item(s)...`
    );

    for (let i = 0; i < toPost.length; i++) {
      const item = toPost[i];
      const itemId = item.id;
      if (!itemId) continue;
      try {
        await postItem(agent, item);
        markSeen(itemId);
      } catch (err) {
        console.error(`Failed to post item ${itemId}:`, err);
        markSeen(itemId); // still mark seen to avoid retrying indefinitely
      }
      // Space out posts, but skip the delay after the last one
      if (i < toPost.length - 1) {
        await sleep(BACKFILL_DELAY_MS);
      }
    }

    // Seed the remaining older items without posting
    for (const item of toSeed) {
      const itemId = item.id;
      if (!itemId) continue;
      markSeen(itemId);
    }

    console.log("Backfill complete.");
    return;
  }

  // Normal poll: post any items not yet seen
  for (const item of items) {
    const itemId = item.id;
    if (!itemId) continue;
    if (hasSeen(itemId)) continue;

    try {
      await postItem(agent, item);
      markSeen(itemId);
    } catch (err) {
      console.error(`Failed to post item ${itemId}:`, err);
    }
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────

const agent = new BskyAgent({ service: BSKY_PDS_URL });

console.log(`Logging in to ${BSKY_PDS_URL} as ${BSKY_IDENTIFIER}...`);
await agent.login({
  identifier: BSKY_IDENTIFIER,
  password: BSKY_APP_PASSWORD,
});
console.log("Logged in.");

// Initial poll: backfills on true first run, or catches up on restart
await poll(agent);
console.log("Initial poll complete. Polling for new items every 3 minutes...");

// Subsequent polls
setInterval(async () => {
  await poll(agent);
}, POLL_INTERVAL_MS);
