import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import { getBot, getSettingValue } from "../bot/telegram-bot.js";
import { publishToTwitter } from "./twitter-publisher.js";
import fs from "fs";

// In-memory state to randomize gap per cycle without rewriting setting on each post.
let nextAllowedPublishAt: number = 0;

// Settings cache — reduce DB reads per publish cycle (refreshed every 60s).
const settingsCache = new Map<string, { value: string; exp: number }>();
async function getCachedSetting(key: string, def: string): Promise<string> {
  const now = Date.now();
  const cached = settingsCache.get(key);
  if (cached && now < cached.exp) return cached.value;
  const value = await getSettingValue(key, def);
  settingsCache.set(key, { value, exp: now + 60_000 });
  return value;
}

function rollNextGapMs(minMin: number, maxMin: number): number {
  const min = Math.max(1, minMin);
  const max = Math.max(min, maxMin);
  const minutes = min + Math.random() * (max - min);
  return Math.floor(minutes * 60 * 1000);
}

export async function publishNextReady(): Promise<boolean> {
  // Check auto-publish setting
  const autoPub = await getCachedSetting("auto_publish", config.AUTO_PUBLISH ? "true" : "false");
  if (autoPub !== "true") return false;

  // ===== Education / scheduled items: publish exactly at scheduledFor (no gap enforced) =====
  const dueScheduled = await db.contentItem.findFirst({
    where: {
      status: "rewritten",
      approvalRequired: true,
      approvedAt: { not: null },
      scheduledFor: { lte: new Date() },
    },
    orderBy: { scheduledFor: "asc" },
  });
  if (dueScheduled) {
    return await publishItem(dueScheduled, { isScheduled: true });
  }

  // ===== Daily cap check =====
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayPublishedCount = await db.contentItem.count({
    where: { status: "published", publishedAt: { gte: startOfDay } },
  });
  const dailyLimit = parseInt(await getCachedSetting("daily_tg_limit", "50"), 10);
  if (todayPublishedCount >= dailyLimit) {
    return false;
  }

  // ===== Rate limit (gap between posts) =====
  const minGap = parseInt(await getCachedSetting("min_gap_minutes", "15"), 10);
  const maxGap = parseInt(await getCachedSetting("max_gap_minutes", "30"), 10);
  const now = Date.now();
  if (now < nextAllowedPublishAt) {
    return false;
  }

  // Auto-skip stale items (>2h old still "rewritten")
  const staleCutoff = new Date(now - 2 * 60 * 60 * 1000);
  await db.contentItem.updateMany({
    where: {
      status: "rewritten",
      contentType: "news",
      approvalRequired: false,
      crawledAt: { lt: staleCutoff },
    },
    data: { status: "skipped", failReason: "Stale (>2h in queue)" },
  });

  // ===== Pick highest-value news in last hour =====
  // High-priority breaking news (score >= 9) bypass the gap entirely
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  let item = await db.contentItem.findFirst({
    where: {
      status: "rewritten",
      contentType: "news",
      approvalRequired: false,
      valueScore: { gte: 9 },
      crawledAt: { gte: oneHourAgo },
    },
    orderBy: [{ valueScore: "desc" }, { crawledAt: "desc" }],
  });

  if (!item) {
    // Normal pick: best item in last 1h that beats the threshold
    const threshold = parseInt(await getCachedSetting("value_threshold", "5"), 10);
    item = await db.contentItem.findFirst({
      where: {
        status: "rewritten",
        contentType: "news",
        approvalRequired: false,
        valueScore: { gte: threshold },
        crawledAt: { gte: oneHourAgo },
      },
      orderBy: [{ valueScore: "desc" }, { crawledAt: "desc" }],
    });
  }

  if (!item) return false;

  const result = await publishItem(item, { isScheduled: false });
  if (result) {
    // For breaking news (score >= 9), shrink gap to 5 min
    const gapMs = (item.valueScore >= 9)
      ? rollNextGapMs(3, 7)
      : rollNextGapMs(minGap, maxGap);
    nextAllowedPublishAt = Date.now() + gapMs;
    logger.info("publisher", `Next publish allowed at ${new Date(nextAllowedPublishAt).toISOString()} (gap ${(gapMs / 60000).toFixed(1)}min)`);
  }
  return result;
}

interface PublishOptions {
  isScheduled?: boolean;
}

async function publishItem(item: any, opts: PublishOptions): Promise<boolean> {
  const bot = getBot();
  if (!bot) {
    logger.error("publisher", "Bot not initialized, cannot publish");
    return false;
  }

  // Khóa item lại ngay lập tức để tránh cycle tiếp theo lấy trùng khi đang upload media
  await db.contentItem.update({
    where: { id: item.id },
    data: { status: "publishing" },
  });

  try {
    // Only publish rewritten content, never original
    if (!item.rewrittenText) {
      logger.warn("publisher", `Item ${item.id.slice(0, 8)} has no rewritten text, skipping`);
      return false;
    }

    // For education content, do NOT strip source info aggressively (it's our own content)
    const isEducation = item.contentType && item.contentType !== "news";
    const textVI = isEducation ? item.rewrittenText : stripAllSourceInfo(item.rewrittenText);

    // Skip if after stripping, content is too short
    if (textVI.length < 20) {
      logger.warn("publisher", `Item ${item.id.slice(0, 8)} too short after strip, skipping`);
      await db.contentItem.update({
        where: { id: item.id },
        data: { status: "skipped", failReason: "Content too short after stripping sources" },
      });
      return false;
    }

    // Cắt caption nếu quá dài (Telegram giới hạn 1024 ký tự cho caption media)
    const MAX_CAPTION_LENGTH = 1000;
    const isLongText = textVI.length > MAX_CAPTION_LENGTH;

    // === 1. Publish to Telegram Channel ===
    let sent;
    try {
      // Check for media (local files)
      let mediaPaths: string[] = [];
      if (item.mediaFiles) {
        try {
          mediaPaths = JSON.parse(item.mediaFiles);
          mediaPaths = mediaPaths.filter((p) => fs.existsSync(p));
        } catch (e) { }
      }

      // External image URL (for education content — quickchart.io etc.)
      const externalImageUrl: string | null = item.imageUrl || null;

      const baseOpts: any = { parse_mode: "Markdown" };

      if (externalImageUrl && mediaPaths.length === 0) {
        // Send photo from URL (education chart)
        const photoOpts: any = { ...baseOpts };
        photoOpts.caption = isLongText ? textVI.slice(0, MAX_CAPTION_LENGTH) + "..." : textVI;
        sent = await bot.sendPhoto(config.TARGET_CHANNEL, externalImageUrl, photoOpts);
      } else if (mediaPaths.length === 1) {
        const mediaPath = mediaPaths[0];
        const photoOpts: any = { ...baseOpts };
        photoOpts.caption = isLongText ? textVI.slice(0, MAX_CAPTION_LENGTH) + "..." : textVI;
        if (mediaPath.endsWith(".mp4")) {
          sent = await bot.sendVideo(config.TARGET_CHANNEL, mediaPath, photoOpts);
        } else {
          sent = await bot.sendPhoto(config.TARGET_CHANNEL, mediaPath, photoOpts);
        }
      } else if (mediaPaths.length > 1) {
        const mediaGroup = mediaPaths.map((p, index) => {
          const type = p.endsWith(".mp4") ? "video" : "photo";
          const mediaItem: any = { type, media: p };
          if (index === 0) {
            mediaItem.caption = isLongText ? textVI.slice(0, MAX_CAPTION_LENGTH) + "..." : textVI;
            mediaItem.parse_mode = "Markdown";
          }
          return mediaItem;
        });
        const sentGroup = await bot.sendMediaGroup(config.TARGET_CHANNEL, mediaGroup);
        sent = sentGroup[0];
      } else {
        // No media at all, just send text
        const textOpts: any = { ...baseOpts, disable_web_page_preview: true };
        sent = await bot.sendMessage(config.TARGET_CHANNEL, textVI, textOpts);
      }

      // Nếu có media và text quá dài, gửi thêm text còn lại vào message riêng
      if ((mediaPaths.length > 0 || externalImageUrl) && isLongText) {
        await bot.sendMessage(config.TARGET_CHANNEL, textVI, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_to_message_id: sent.message_id
        });
      }

      // Cleanup local media files
      if (!config.hasTwitterPublishEN) {
        for (const p of mediaPaths) {
          try { fs.unlinkSync(p); } catch (e) { }
        }
      }

    } catch (mdErr: any) {
      if (mdErr.message?.includes("parse entities") || mdErr.message?.includes("Bad Request")) {
        const plainText = textVI.replace(/[*_`\[\]]/g, "");
        sent = await bot.sendMessage(config.TARGET_CHANNEL, plainText, {
          disable_web_page_preview: true,
        });
        logger.warn("publisher", `Item ${item.id.slice(0, 8)} sent as plain text (Markdown error)`);
      } else {
        throw mdErr;
      }
    }

    await db.contentItem.update({
      where: { id: item.id },
      data: {
        status: "published",
        publishedAt: new Date(),
        publishedMsgId: sent.message_id.toString(),
      },
    });

    logger.info(
      "publisher",
      `Published ${item.id.slice(0, 8)} → [TG]${opts.isScheduled ? " (scheduled)" : ""}` +
        (item.contentType && item.contentType !== "news" ? ` [${item.contentType}]` : ` [score ${item.valueScore}/10]`)
    );
    return true;
  } catch (err: any) {
    await db.contentItem.update({
      where: { id: item.id },
      data: {
        status: "failed",
        failReason: `Publish error: ${err.message}`,
      },
    });
    logger.error("publisher", `Failed to publish ${item.id.slice(0, 8)}: ${err.message}`);
    return false;
  }
}

// === Twitter publish — English only ===
export async function publishNextToTwitter(): Promise<boolean> {
  if (!config.hasTwitterPublishEN) return false;

  const BASE_QUERY = {
    status: "published" as const,
    tweetEnId: null,
    rewrittenText: { not: null },
    twitterStatus: { in: ["breaking"] as string[] },
  };

  // Prioritise items with media
  let item = await db.contentItem.findFirst({
    where: { ...BASE_QUERY, mediaFiles: { not: null } },
    orderBy: { publishedAt: "asc" },
  });
  if (!item) {
    item = await db.contentItem.findFirst({ where: BASE_QUERY, orderBy: { publishedAt: "asc" } });
  }
  if (!item) return false;

  try {
    let mediaPaths: string[] = [];
    if (item.mediaFiles) {
      try { mediaPaths = JSON.parse(item.mediaFiles).filter((p: string) => fs.existsSync(p)); } catch {}
    }

    // Daily cap check
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await db.contentItem.count({
      where: {
        publishedAt: { gte: startOfDay },
        tweetEnId: { notIn: ["skipped", "skipped_daily_limit", "failed"], not: null },
      },
    });
    const currentLimit = parseInt(await getSettingValue("twitter_daily_limit", "10"), 10);
    if (todayCount >= currentLimit) {
      await db.contentItem.update({ where: { id: item.id }, data: { tweetEnId: "skipped_daily_limit" } });
      logger.info("twitter", `Daily limit ${currentLimit} reached — skipping`);
      return true;
    }

    // Pick best text: EN-specific > fallback to rewritten
    const rawText = item.tweetTextEN || item.rewrittenTextEn || item.rewrittenText!;
    const tweetText = stripAllSourceInfo(rawText);

    let tweetEnId: string | null = null;
    if (tweetText.length >= 20) {
      tweetEnId = await publishToTwitter(tweetText, mediaPaths);
    }

    for (const p of mediaPaths) { try { fs.unlinkSync(p); } catch {} }

    await db.contentItem.update({
      where: { id: item.id },
      data: { tweetEnId: tweetEnId || "skipped" },
    });

    if (tweetEnId) logger.info("twitter", `Tweeted ${item.id.slice(0, 8)} → [X]`);
    return true;
  } catch (err: any) {
    logger.error("twitter", `Tweet failed ${item.id.slice(0, 8)}: ${err.message}`);
    await db.contentItem.update({ where: { id: item.id }, data: { tweetEnId: "failed" } });
    return false;
  }
}

// Lọc triệt để mọi link, nguồn, attribution khỏi bài viết
function stripAllSourceInfo(text: string): string {
  let cleaned = text;

  // 1. Loại bỏ Markdown link [text](url) → giữ text
  cleaned = cleaned.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 2. Loại bỏ mọi URL dạng http/https
  cleaned = cleaned.replace(/https?:\/\/[^\s)>\]]+/gi, "");

  // 3. Loại bỏ mọi link t.me, bit.ly, discord.gg, tinyurl...
  cleaned = cleaned.replace(/(t\.me|bit\.ly|discord\.gg|tinyurl\.com|goo\.gl)\/[^\s)>\]]+/gi, "");

  // 4. Loại bỏ @username handles
  cleaned = cleaned.replace(/@\w+/g, "");

  // 5. Loại bỏ dòng chứa từ khóa nguồn
  cleaned = cleaned.replace(/^.*?(Nguồn|Source|Theo|Via|Từ|Credit|Tham khảo|Xem thêm|Chi tiết tại|Đọc thêm)\s*[:：].*/gim, "");

  // 6. Loại bỏ dòng chỉ là tên nguồn phổ biến
  const sourceNames = [
    "VN Wallstreet", "UG Wallstreet", "Wu Blockchain", "Shauotat Official", "Clash Report",
    "CoinDesk", "CoinTelegraph", "The Block", "Bloomberg", "Reuters",
    "VN Wall Street", "Sha ướt át",
  ];
  for (const name of sourceNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`^.*${escaped}.*$`, "gim"), "");
  }

  // 7. Loại bỏ dòng bắt đầu bằng emoji phổ biến dùng cho nguồn/ghi chú
  cleaned = cleaned.replace(/^[\s]*[\u{1F4CC}\u{1F4CE}\u{1F517}\u{1F4A1}\u{1F4F0}\u{1F4E2}\u{1F50D}\u{2139}\u{26A0}\u{270F}].*$/gmu, "");

  // 8. Loại bỏ dòng "Thông tin dựa trên...", "Lưu ý:...", "Khuyến nghị..."
  cleaned = cleaned.replace(/^.*?(Thông tin dựa trên|Lưu ý|Khuyến nghị|Disclaimer|Note|Cần lưu ý|Khuyến cáo).*$/gim, "");

  // 9. Loại bỏ dòng Telegram link preview (chứa "Telegram" + tên channel)
  cleaned = cleaned.replace(/^.*?Telegram\s*\n.*?$/gim, "");

  // 10. Loại bỏ "VIEW MESSAGE" text
  cleaned = cleaned.replace(/VIEW MESSAGE/gi, "");

  // 11. Dọn dẹp: dòng trống liên tiếp, khoảng trắng thừa
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/[ \t]+$/gm, "");

  return cleaned.trim();
}
