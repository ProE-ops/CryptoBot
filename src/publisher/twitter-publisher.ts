import { TwitterApi } from "twitter-api-v2";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let twitterClient: TwitterApi | null = null;

function getClient(): TwitterApi | null {
  if (!config.hasTwitterPublishEN) return null;
  if (!twitterClient) {
    twitterClient = new TwitterApi({
      appKey: config.TWITTER_EN_API_KEY,
      appSecret: config.TWITTER_EN_API_SECRET,
      accessToken: config.TWITTER_EN_ACCESS_TOKEN,
      accessSecret: config.TWITTER_EN_ACCESS_SECRET,
    });
  }
  return twitterClient;
}

// Strip Markdown; if not Premium, truncate cleanly to 280 chars on a word/sentence boundary.
function cleanForTweet(text: string): string {
  let clean = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Free tier: hard cap at 280 chars. Premium accounts can exceed it.
  if (!config.TWITTER_PREMIUM && clean.length > 280) {
    // Truncate at last sentence break or word break within limit
    const slice = clean.slice(0, 277);
    const lastBreak = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    clean = (lastBreak > 200 ? slice.slice(0, lastBreak) : slice).trimEnd() + "…";
  }
  return clean;
}

export async function publishToTwitter(text: string, mediaPaths: string[] = []): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const tweetText = cleanForTweet(text);

    let mediaIds: string[] = [];
    if (mediaPaths.length > 0) {
      const videos = mediaPaths.filter(p => p.endsWith(".mp4"));
      const photos = mediaPaths.filter(p => !p.endsWith(".mp4"));
      const toUpload = videos.length > 0 ? [videos[0]] : photos.slice(0, 4);

      for (const p of toUpload) {
        try {
          mediaIds.push(await client.v1.uploadMedia(p));
        } catch (e: any) {
          logger.error("twitter", `Media upload error: ${e.message}`);
        }
      }
    }

    const payload: any = { text: tweetText };
    if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };

    const result = await client.v2.tweet(payload);
    logger.info("twitter", `Tweeted: ${result.data.id}`);
    return result.data.id;
  } catch (err: any) {
    const detail = err.data ? JSON.stringify(err.data) : err.message;
    logger.error("twitter", `Tweet failed: ${detail}`);
    return null;
  }
}
