import { config } from "./config.js";
import { db } from "./db.js";
import { logger } from "./utils/logger.js";
import { crawlTelegramSources } from "./crawlers/telegram-crawler.js";
import { crawlTwitterSources } from "./crawlers/twitter-crawler.js";
import { synthesizeCycle } from "./processor/synthesizer.js";
import { publishNextReady, publishNextToTwitter } from "./publisher/telegram-publisher.js";
import { educationGenerationCycle } from "./processor/education-generator.js";
import { sendApprovalCard } from "./bot/telegram-bot.js";

// ===== TIMER HANDLES =====
let crawlTimer: NodeJS.Timeout | null = null;
let synthesisTimer: NodeJS.Timeout | null = null;
let publishTimer: NodeJS.Timeout | null = null;
let twitterTimer: NodeJS.Timeout | null = null;
let educationTimer: NodeJS.Timeout | null = null;
let approvalNotifyTimer: NodeJS.Timeout | null = null;
let approvalExpiryTimer: NodeJS.Timeout | null = null;

// ===== CYCLE WRAPPERS =====

async function crawlCycle() {
  try { await crawlTelegramSources(); } catch (err: any) {
    logger.error("scheduler", `TG crawl error: ${err.message}`);
  }
  try { await crawlTwitterSources(); } catch (err: any) {
    logger.error("scheduler", `Twitter crawl error: ${err.message}`);
  }
}

async function publishCycle() {
  try { await publishNextReady(); } catch (err: any) {
    logger.error("scheduler", `Publish error: ${err.message}`);
  }
}

async function twitterCycle() {
  try { await publishNextToTwitter(); } catch (err: any) {
    logger.error("scheduler", `Twitter publish error: ${err.message}`);
  }
}

async function educationCycle() {
  try { await educationGenerationCycle(); } catch (err: any) {
    logger.error("scheduler", `Education gen error: ${err.message}`);
  }
}

async function approvalNotifyCycle() {
  try {
    const pending = await db.contentItem.findMany({
      where: { status: "awaiting_approval", approvalMsgId: null },
      take: 5,
    });
    for (const item of pending) {
      await sendApprovalCard(item.id);
    }
  } catch (err: any) {
    logger.error("scheduler", `Approval notify error: ${err.message}`);
  }
}

async function approvalExpiryCycle() {
  try {
    // Expire items that have been sitting in approval queue for >3h since creation
    // (handles both past-scheduled items AND items still waiting on a future slot).
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const expired = await db.contentItem.updateMany({
      where: { status: "awaiting_approval", crawledAt: { lt: cutoff } },
      data: { status: "skipped", failReason: "Approval timeout (3h since creation)" },
    });
    if (expired.count > 0) {
      logger.info("scheduler", `Expired ${expired.count} un-approved items`);
    }
  } catch (err: any) {
    logger.error("scheduler", `Approval expiry error: ${err.message}`);
  }
}

// ===== SYNTHESIS — RANDOM 15–30 MIN INTERVAL =====
// Uses recursive setTimeout so the gap is re-rolled after each run.

const SYNTHESIS_MIN_MS = 15 * 60 * 1000;
const SYNTHESIS_MAX_MS = 30 * 60 * 1000;

function rollSynthesisGap(): number {
  return SYNTHESIS_MIN_MS + Math.random() * (SYNTHESIS_MAX_MS - SYNTHESIS_MIN_MS);
}

function scheduleNextSynthesis() {
  const gap = rollSynthesisGap();
  logger.info("scheduler", `Next synthesis in ${(gap / 60000).toFixed(1)} min`);
  synthesisTimer = setTimeout(async () => {
    try { await synthesizeCycle(); } catch (err: any) {
      logger.error("scheduler", `Synthesis error: ${err.message}`);
    }
    scheduleNextSynthesis(); // re-schedule with a new random gap
  }, gap);
}

// ===== START / STOP =====

export function startScheduler() {
  logger.info("scheduler", "Starting scheduler:");
  logger.info("scheduler", `  Crawl:   every ${config.CRAWL_INTERVAL}s`);
  logger.info("scheduler", `  Publish: every ${config.PUBLISH_INTERVAL}s`);
  logger.info("scheduler", `  Twitter: every ${config.TWITTER_PUBLISH_INTERVAL}s`);
  logger.info("scheduler", `  Synthesis: random 15–30 min`);

  // First crawl after 10s (let bot initialize)
  setTimeout(crawlCycle, 10_000);

  // First synthesis runs after first crawl has had time to collect items
  setTimeout(() => {
    synthesizeCycle().catch((err: any) =>
      logger.error("scheduler", `Initial synthesis error: ${err.message}`)
    );
    scheduleNextSynthesis();
  }, 5 * 60 * 1000); // first synthesis 5 min after start

  crawlTimer       = setInterval(crawlCycle,    config.CRAWL_INTERVAL * 1000);
  publishTimer     = setInterval(publishCycle,  config.PUBLISH_INTERVAL * 1000);
  twitterTimer     = setInterval(twitterCycle,  config.TWITTER_PUBLISH_INTERVAL * 1000);
  educationTimer   = setInterval(educationCycle,     5 * 60 * 1000); // education check every 5 min
  approvalNotifyTimer = setInterval(approvalNotifyCycle, 2 * 60 * 1000);
  approvalExpiryTimer = setInterval(approvalExpiryCycle, 5 * 60 * 1000);

  setTimeout(educationCycle, 30_000); // first education check after 30s
}

export function stopScheduler() {
  if (crawlTimer)        clearInterval(crawlTimer);
  if (synthesisTimer)    clearTimeout(synthesisTimer);
  if (publishTimer)      clearInterval(publishTimer);
  if (twitterTimer)      clearInterval(twitterTimer);
  if (educationTimer)    clearInterval(educationTimer);
  if (approvalNotifyTimer) clearInterval(approvalNotifyTimer);
  if (approvalExpiryTimer) clearInterval(approvalExpiryTimer);
  crawlTimer = synthesisTimer = publishTimer = twitterTimer =
    educationTimer = approvalNotifyTimer = approvalExpiryTimer = null;
  logger.info("scheduler", "Scheduler stopped");
}

export { crawlCycle as triggerCrawl };
