import { TwitterApi } from "twitter-api-v2";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import { setSetting, getSettingValue } from "../bot/telegram-bot.js";
import { filterKolContent } from "../utils/content-filter.js";

let twitterClient: TwitterApi | null = null;
// Session-level flag: set true when Twitter API returns 402 (Free tier can't read).
// All subsequent crawl cycles short-circuit until process restart.
let twitterReadDisabled = false;

function getTwitterClient(): TwitterApi {
  if (!twitterClient) {
    twitterClient = new TwitterApi(config.TWITTER_BEARER);
  }
  return twitterClient;
}

function isPaymentRequired(err: any): boolean {
  return err?.code === 402 || err?.status === 402 || /\b402\b/.test(err?.message || "");
}

export async function crawlTwitterSources(): Promise<number> {
  if (!config.hasTwitter) return 0;
  if (twitterReadDisabled) return 0;  // Free tier — read endpoints permanently disabled this session

  const sources = await db.source.findMany({
    where: { type: "twitter", isActive: true },
  });

  if (sources.length === 0) return 0;

  let totalNew = 0;
  const client = getTwitterClient();

  for (const source of sources) {
    try {
      const count = await crawlOneAccount(client, source);
      totalNew += count;
    } catch (err: any) {
      if (isPaymentRequired(err)) {
        twitterReadDisabled = true;
        logger.error("twitter",
          "❌ Twitter API trả 402 Payment Required.\n" +
          "    Free tier KHÔNG cho phép đọc tweets (chỉ post được).\n" +
          "    → Đã tắt Twitter crawl cho session này.\n" +
          "    → Để bật lại: upgrade lên Basic tier ($100/mo) hoặc disable Twitter sources.\n" +
          "    → Hiện tại chỉ dùng Telegram sources sẽ hoạt động bình thường."
        );
        break;
      }
      if (err.code === 429) {
        logger.warn("twitter", `Rate limited. Skipping cycle.`);
        break;
      }
      logger.error("twitter", `Error crawling ${source.handle}: ${err.message}`);
    }
  }

  if (totalNew > 0) {
    logger.info("twitter", `Crawled ${totalNew} new tweets total`);
  }

  return totalNew;
}

function cleanTwitterHandle(raw: string): string | null {
  // Strip URL prefix if present, then "@", then validate
  const m = raw.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
  const candidate = m ? m[1] : raw.replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(candidate) ? candidate : null;
}

async function crawlOneAccount(
  client: TwitterApi,
  source: { id: string; handle: string; name: string }
): Promise<number> {
  const handle = cleanTwitterHandle(source.handle);
  if (!handle) {
    logger.warn("twitter", `Source has invalid handle: "${source.handle}" — skipping. Use /removesource to clean up.`);
    return 0;
  }
  const settingKey = `tw_since_${handle}`;
  const sinceId = await getSettingValue(settingKey, "");

  // Get user ID from username
  const userIdKey = `tw_uid_${handle}`;
  let userId = await getSettingValue(userIdKey, "");

  if (!userId) {
    try {
      const user = await client.v2.userByUsername(handle);
      userId = user.data.id;
      await setSetting(userIdKey, userId);
    } catch (err: any) {
      logger.error("twitter", `Cannot find user @${handle}: ${err.message}`);
      return 0;
    }
  }

  // Lần đầu crawl: lấy tweet mới nhất làm mốc, KHÔNG lấy tin cũ
  if (!sinceId) {
    const firstFetch = await client.v2.userTimeline(userId, {
      max_results: 5,
      "tweet.fields": ["created_at"],
      exclude: ["retweets", "replies"],
    });
    const firstTweet = firstFetch.data?.data?.[0];
    if (firstTweet) {
      await setSetting(settingKey, firstTweet.id);
      logger.info("twitter", `@${handle}: initialized at tweet #${firstTweet.id} (skip old tweets)`);
    }
    return 0;
  }

  // Fetch tweets since last known
  const params: any = {
    max_results: 10,
    "tweet.fields": ["created_at", "author_id", "text"],
    exclude: ["retweets", "replies"],
    since_id: sinceId,
  };

  const tweets = await client.v2.userTimeline(userId, params);

  let newCount = 0;
  let newestId = sinceId;

  let filteredCount = 0;
  for (const tweet of tweets.data?.data || []) {
    if (!tweet.text) continue;

    // Track newest BEFORE filtering, so we don't re-fetch the same tweets next cycle
    if (!newestId || BigInt(tweet.id) > BigInt(newestId)) {
      newestId = tweet.id;
    }

    // Quality filter — skip shilling, link spam, 1-line emoji, etc.
    const filter = filterKolContent(tweet.text);
    if (!filter.pass) { filteredCount++; continue; }

    try {
      await db.contentItem.create({
        data: {
          sourceId: source.id,
          externalId: tweet.id,
          originalText: tweet.text,
          authorName: `@${handle}`,
          sourceUrl: `https://x.com/${handle}/status/${tweet.id}`,
          status: "pending",
        },
      });
      newCount++;
    } catch (err: any) {
      if (err.code !== "P2002") {
        logger.error("twitter", `DB error: ${err.message}`);
      }
    }
  }
  if (filteredCount > 0) {
    logger.info("twitter", `@${handle}: filtered ${filteredCount} low-quality posts`);
  }

  if (newestId && newestId !== sinceId) {
    await setSetting(settingKey, newestId);
  }

  if (newCount > 0) {
    logger.info("twitter", `@${handle}: ${newCount} new tweets`);
  }

  return newCount;
}
