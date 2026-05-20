import { config } from "./config.js";
import { db } from "./db.js";
import { logger } from "./utils/logger.js";
import { startBot } from "./bot/telegram-bot.js";
import { startScheduler, stopScheduler, triggerCrawl } from "./scheduler.js";
import { disconnectTelegramCrawler, startRealtimeListener } from "./crawlers/telegram-crawler.js";

async function main() {
  console.log("================================================");
  console.log("   CONTENT BOT - Auto Crawl → Rewrite → Publish ");
  console.log("================================================\n");

  // Test DB connection
  try {
    await db.$connect();
    logger.info("main", "Database connected (SQLite)");
  } catch (err: any) {
    console.error("❌ Database connection failed:", err.message);
    console.error("Run: pnpm db:push");
    process.exit(1);
  }

  // Start Telegram Bot
  const bot = startBot();
  logger.info("main", "Telegram Bot started");

  // Handle /crawlnow from bot
  bot.on("crawl_now" as any, async (chatId: number) => {
    try {
      await triggerCrawl();
      await bot.sendMessage(chatId, "✅ Crawl hoàn tất!");
    } catch (err: any) {
      await bot.sendMessage(chatId, `❌ Crawl lỗi: ${err.message}`);
    }
  });

  // Log feature status
  if (!config.hasDeepSeek) {
    logger.warn("main", "DeepSeek NOT configured - synthesis disabled");
  }
  if (!config.hasTelegramCrawler) {
    logger.warn("main", "Telegram Crawler NOT configured - TG sources won't be crawled");
  }
  if (!config.hasTwitter) {
    logger.warn("main", "Twitter Crawler NOT configured - Twitter sources won't be crawled");
  }

  // Check active sources — the bot is useless without them
  const activeSources = await db.source.count({ where: { isActive: true } });
  if (activeSources === 0) {
    logger.warn("main", "⚠️ NO ACTIVE SOURCES — add KOLs via /addsource in the bot");
  } else {
    logger.info("main", `📡 Watching ${activeSources} active source(s)`);
  }
  if (config.hasTwitterPublishEN) {
    logger.info("main", "Twitter Publish: OK");
  } else {
    logger.warn("main", "Twitter Publish: NOT configured (optional)");
  }

  // Start realtime Telegram listener (nhận tin ngay lập tức)
  await startRealtimeListener();

  // Start scheduler (backup polling + process + publish)
  startScheduler();

  logger.info("main", "Bot is running! Send /start to your bot on Telegram.");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("main", "Shutting down...");
    stopScheduler();
    bot.stopPolling();
    await disconnectTelegramCrawler();
    await db.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
