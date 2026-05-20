import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing required env: ${key}`);
    process.exit(1);
  }
  return val;
}

function optional(key: string, fallback: string = ""): string {
  return process.env[key] || fallback;
}

export const config = {
  // Telegram Bot
  BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
  TARGET_CHANNEL: required("TELEGRAM_TARGET_CHANNEL"),
  ADMIN_IDS: optional("ADMIN_USER_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n)),

  // Telegram Crawler (GramJS)
  TG_API_ID: optional("TELEGRAM_API_ID"),
  TG_API_HASH: optional("TELEGRAM_API_HASH"),
  TG_SESSION: optional("TELEGRAM_SESSION"),

  // Twitter Crawl
  TWITTER_BEARER: optional("TWITTER_BEARER_TOKEN"),

  // Twitter Publish
  TWITTER_EN_API_KEY: optional("TWITTER_EN_API_KEY"),
  TWITTER_EN_API_SECRET: optional("TWITTER_EN_API_SECRET"),
  TWITTER_EN_ACCESS_TOKEN: optional("TWITTER_EN_ACCESS_TOKEN"),
  TWITTER_EN_ACCESS_SECRET: optional("TWITTER_EN_ACCESS_SECRET"),

  // DeepSeek
  DEEPSEEK_API_KEY: optional("DEEPSEEK_API_KEY"),
  DEEPSEEK_MODEL: optional("DEEPSEEK_MODEL", "deepseek-chat"),

  // Crypto data providers
  CRYPTOPANIC_API_KEY: optional("CRYPTOPANIC_API_KEY"),
  COINGLASS_API_KEY: optional("COINGLASS_API_KEY"),

  // Intervals (seconds)
  CRAWL_INTERVAL: parseInt(optional("CRAWL_INTERVAL", "300")),
  PROCESS_INTERVAL: parseInt(optional("PROCESS_INTERVAL", "30")),
  PUBLISH_INTERVAL: parseInt(optional("PUBLISH_INTERVAL", "10")),
  TWITTER_PUBLISH_INTERVAL: parseInt(optional("TWITTER_PUBLISH_INTERVAL", "20")),

  // Options
  AUTO_PUBLISH: optional("AUTO_PUBLISH", "true") === "true",
  TWITTER_PREMIUM: optional("TWITTER_PREMIUM", "false") === "true",
  LOG_LEVEL: optional("LOG_LEVEL", "info"),

  // Feature checks
  get hasTelegramCrawler() {
    return !!(this.TG_API_ID && this.TG_API_HASH && this.TG_SESSION);
  },
  get hasTwitter() {
    return !!this.TWITTER_BEARER;
  },
  get hasTwitterPublishEN() {
    return !!(this.TWITTER_EN_API_KEY && this.TWITTER_EN_API_SECRET && this.TWITTER_EN_ACCESS_TOKEN && this.TWITTER_EN_ACCESS_SECRET);
  },
  get hasDeepSeek() {
    return !!this.DEEPSEEK_API_KEY;
  },
  get hasCryptoPanic() {
    return !!this.CRYPTOPANIC_API_KEY;
  },
  get hasCoinglass() {
    return !!this.COINGLASS_API_KEY;
  },
};
