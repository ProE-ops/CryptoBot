import TelegramBot from "node-telegram-bot-api";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";

let bot: TelegramBot;

// Session maps with TTL so stale sessions don't leak memory.
class TTLMap<K, V> {
  private readonly map = new Map<K, { value: V; exp: number }>();
  constructor(private readonly ttlMs: number) {}
  set(key: K, value: V): void {
    this.map.set(key, { value, exp: Date.now() + this.ttlMs });
  }
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) { this.map.delete(key); return undefined; }
    return entry.value;
  }
  delete(key: K): void { this.map.delete(key); }
}

const SESSION_TTL = 10 * 60 * 1000; // 10 min
const addSourceSessions = new TTLMap<number, string>(SESSION_TTL);
const editCaptionSessions = new TTLMap<number, string>(SESSION_TTL);

export function getBot(): TelegramBot {
  return bot;
}

function isAdmin(userId: number): boolean {
  if (config.ADMIN_IDS.length === 0) return true;
  return config.ADMIN_IDS.includes(userId);
}

/**
 * Parse user input (URL, @handle, or plain handle) into a clean handle for the given source type.
 * Twitter:
 *   https://x.com/elonmusk           → "elonmusk"
 *   https://twitter.com/foo/status/1 → "foo"
 *   @elonmusk                        → "elonmusk"
 *   elonmusk                         → "elonmusk"
 * Telegram:
 *   https://t.me/durov               → "@durov"
 *   https://t.me/+abc123             → "+abc123"  (invite link — kept verbatim)
 *   t.me/durov                       → "@durov"
 *   @durov                           → "@durov"
 *   durov                            → "@durov"
 * Returns null if the input can't be parsed.
 */
export function parseSourceInput(raw: string, type: "telegram" | "twitter"): string | null {
  const input = raw.trim();
  if (!input) return null;

  if (type === "twitter") {
    // URL form
    const m = input.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
    if (m) return m[1];
    // @handle or plain
    const clean = input.replace(/^@/, "");
    if (/^[A-Za-z0-9_]{1,15}$/.test(clean)) return clean;
    return null;
  }

  // telegram
  // t.me/joinchat/... or t.me/+abc → keep the trailing segment with "+" or "joinchat"
  const inviteMatch = input.match(/t\.me\/(?:joinchat\/|joinchat\?|\+)([A-Za-z0-9_-]+)/i);
  if (inviteMatch) return "+" + inviteMatch[1];
  // public t.me link
  const pubMatch = input.match(/t\.me\/([A-Za-z0-9_]{3,})/i);
  if (pubMatch) return "@" + pubMatch[1];
  // @username or plain
  if (input.startsWith("@") && /^@[A-Za-z0-9_]{3,}$/.test(input)) return input;
  if (/^[A-Za-z0-9_]{3,}$/.test(input)) return "@" + input;
  return null;
}

// Silently update an inline keyboard (message may be stale — ignore errors)
async function safeEditMarkup(
  text: string,
  chatId: number,
  messageId: number
): Promise<void> {
  await bot.editMessageReplyMarkup(
    { inline_keyboard: [[{ text, callback_data: "noop" }]] },
    { chat_id: chatId, message_id: messageId }
  ).catch(() => {});
}

// Safe send — nếu Markdown lỗi thì gửi plain text
async function safeSend(chatId: number, text: string, markdown = false): Promise<void> {
  try {
    if (markdown) {
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", disable_web_page_preview: true });
    } else {
      await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
    }
  } catch (err: any) {
    if (err.message?.includes("parse entities") || err.message?.includes("Bad Request")) {
      // Retry without Markdown
      const plain = text.replace(/[*_`\[\]]/g, "");
      await bot.sendMessage(chatId, plain, { disable_web_page_preview: true });
    } else {
      logger.error("bot", `Send message failed: ${err.message}`);
    }
  }
}

export function startBot(): TelegramBot {
  bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

  // Catch polling errors to prevent crash — log full detail to diagnose root cause
  let lastPollErr = "";
  bot.on("polling_error", (err: any) => {
    const detail = err.response?.body?.description
      || err.response?.statusMessage
      || err.message
      || err.code;
    // Common: 401 = token sai, 409 = bot đang chạy ở chỗ khác (conflict)
    const hint = /401/.test(detail) ? " → BOT_TOKEN sai. Check .env"
               : /409/.test(detail) ? " → Bot đang chạy ở instance khác. Dừng instance kia trước"
               : "";
    const msg = `Polling error: ${detail}${hint}`;
    if (msg !== lastPollErr) {        // dedupe spam — only log when reason changes
      logger.error("bot", msg);
      lastPollErr = msg;
    }
  });

  // Set bot commands menu
  bot.setMyCommands([
    { command: "/guide", description: "📖 Hướng dẫn toàn bộ chức năng" },
    { command: "/status", description: "Xem tổng quan hệ thống" },
    { command: "/stats", description: "Thống kê bài đăng hôm nay" },
    { command: "/add", description: "Thêm nội dung thủ công" },
    { command: "/queue", description: "Xem hàng đợi" },
    { command: "/recent", description: "Bài đã đăng gần đây" },
    { command: "/sources", description: "Quản lý nguồn" },
    { command: "/addsource", description: "Thêm nguồn mới" },
    { command: "/removesource", description: "Xóa 1 hoặc nhiều nguồn (hoặc bulk UI)" },
    { command: "/retry", description: "Thử lại các bài bị lỗi" },
    { command: "/pause", description: "Tạm dừng auto-publish" },
    { command: "/resume", description: "Bật lại auto-publish" },
    { command: "/crawlnow", description: "Chạy crawl ngay lập tức" },
    { command: "/logs", description: "Xem logs" },
    { command: "/threshold", description: "Đặt ngưỡng điểm bài news (0-10)" },
    { command: "/gap", description: "Đặt khoảng cách post (min max phút)" },
    { command: "/minposts", description: "Số bài KOL tối thiểu để tổng hợp" },
    { command: "/educationnow", description: "Tạo bài education ngay (test)" },
    { command: "/synthesisnow", description: "Tổng hợp KOL posts ngay (test)" },
    { command: "/checkca", description: "Phân tích token theo contract address" },
    { command: "/pending_approval", description: "Xem bài chờ duyệt" },
    { command: "/stopbot", description: "Dừng bot + xóa toàn bộ queue" },
  ]).catch((err: any) => logger.error("bot", `Failed to set commands: ${err.message}`));

  logger.info("bot", "Telegram bot started");

  // /start
  bot.onText(/\/start/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const sourceCount = await db.source.count({ where: { isActive: true } });
      const setupHint = sourceCount === 0
        ? `\n\n⚠️ *BƯỚC ĐẦU TIÊN:* Thêm sources từ Telegram/Twitter\n` +
          `→ Dùng /addsource để chọn KOL channels/accounts.`
        : `\n\n✅ Đang theo dõi *${sourceCount}* sources.`;

      await bot.sendMessage(msg.chat.id,
        `🤖 *Crypto Content Bot*\n\n` +
        `📊 LUỒNG HOẠT ĐỘNG:\n` +
        `  Sources (KOL TG + Twitter)\n` +
        `   ↓ crawl liên tục\n` +
        `  Pending items + Token CA detection\n` +
        `   ↓ tổng hợp mỗi 15-30 phút\n` +
        `  Bài analysis + chart + token cards\n` +
        `   ↓ đăng Telegram + X` +
        setupHint,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📖 Guideline — Toàn bộ chức năng", callback_data: "guide:menu" }],
            ],
          },
        }
      );
    } catch (err: any) {
      logger.error("bot", `Start cmd error: ${err.message}`);
    }
  });

  // /guide — comprehensive guideline with section navigation
  bot.onText(/\/guide/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      await sendGuideMenu(msg.chat.id);
    } catch (err: any) {
      logger.error("bot", `Guide cmd error: ${err.message}`);
    }
  });

  // /status
  bot.onText(/\/status/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [pendingKOL, rewritten, published, todayPublished, tgSources, twSources, autoPub, minItems] =
        await Promise.all([
          db.contentItem.count({ where: { status: "pending", contentType: "news" } }),
          db.contentItem.count({ where: { status: "rewritten" } }),
          db.contentItem.count({ where: { status: "published" } }),
          db.contentItem.count({ where: { status: "published", publishedAt: { gte: today } } }),
          db.source.count({ where: { isActive: true, type: "telegram" } }),
          db.source.count({ where: { isActive: true, type: "twitter" } }),
          getSettingValue("auto_publish", "true"),
          getSettingValue("synthesis_min_items", "3"),
        ]);

      const totalSources = tgSources + twSources;
      const sourcesWarn = totalSources === 0
        ? "\n\n⚠️ *Chưa có source nào!* Dùng /addsource để thêm KOL từ Telegram hoặc Twitter."
        : "";

      await safeSend(
        msg.chat.id,
        `📊 *Tổng Quan*\n\n` +
        `🎯 *Sources:* ${totalSources} (TG: ${tgSources} | X: ${twSources})\n` +
        `📥 KOL posts chờ tổng hợp: ${pendingKOL} / ${minItems}\n` +
        `✍️ Đã tổng hợp, chờ đăng: ${rewritten}\n` +
        `✅ Đã đăng: ${published} (hôm nay: ${todayPublished})\n\n` +
        `📡 Auto-publish: ${autoPub === "true" ? "BẬT ✅" : "TẮT ⏸"}\n` +
        `🤖 DeepSeek: ${config.hasDeepSeek ? "OK ✅" : "❌"}\n` +
        `📱 TG Crawler: ${config.hasTelegramCrawler ? "OK ✅" : "❌"}\n` +
        `🐦 Twitter Crawl: ${config.hasTwitter ? "OK ✅" : "❌"}` +
        sourcesWarn,
        true
      );
    } catch (err: any) {
      logger.error("bot", `Status cmd error: ${err.message}`);
    }
  });

  // /stats
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const telegramToday = await db.contentItem.count({
        where: { status: "published", publishedAt: { gte: today } },
      });

      const twitterToday = await db.contentItem.count({
        where: {
          publishedAt: { gte: today },
          tweetEnId: { notIn: ["skipped", "skipped_low_engagement", "skipped_daily_limit", "failed"], not: null },
        },
      });

      const currentLimit = parseInt(await getSettingValue("twitter_daily_limit", "10"), 10);

      const opts = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➕ Tăng giới hạn Twitter (+5 bài)", callback_data: "increase_twitter_limit" }
            ]
          ]
        }
      };

      await bot.sendMessage(
        msg.chat.id,
        `📈 Thống kê bài đăng hôm nay:\n\n` +
        `📱 Telegram đã đăng: ${telegramToday} bài\n` +
        `🐦 Twitter đã đăng: ${twitterToday} bài (Giới hạn: ${currentLimit})`,
        opts
      );
    } catch (err: any) {
      logger.error("bot", `Stats cmd error: ${err.message}`);
    }
  });

  // /add <text>
  bot.onText(/\/add (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const text = match![1].trim();
      if (!text) {
        await safeSend(msg.chat.id, "⚠️ Vui lòng nhập nội dung: /add <text>");
        return;
      }

      await db.contentItem.create({
        data: {
          originalText: text,
          externalId: `manual_${Date.now()}_${msg.message_id}`,
          authorName: msg.from?.first_name || "Manual",
          status: "pending",
        },
      });

      await safeSend(msg.chat.id, `✅ Đã thêm vào Rổ Content!\n📝 "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
      logger.info("bot", `Manual content added by ${msg.from?.first_name}`);
    } catch (err: any) {
      logger.error("bot", `Add cmd error: ${err.message}`);
    }
  });

  // /sources — list with 24h activity per source
  bot.onText(/\/sources/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const sources = await db.source.findMany({ orderBy: { createdAt: "desc" } });

      if (sources.length === 0) {
        await safeSend(msg.chat.id,
          "📭 *Chưa có nguồn nào.*\n\n" +
          "Bot KHÔNG thể tổng hợp khi không có sources.\n" +
          "Thêm KOL từ Telegram / Twitter: /addsource",
          true
        );
        return;
      }

      // Count items crawled per source in last 24h
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const counts = await db.contentItem.groupBy({
        by: ["sourceId"],
        where: { crawledAt: { gte: dayAgo }, sourceId: { not: null } },
        _count: { sourceId: true },
      });
      const countMap = new Map(counts.map(c => [c.sourceId!, c._count.sourceId]));

      const fmt = (s: any, i: number) => {
        const recent = countMap.get(s.id) ?? 0;
        const dot = s.isActive ? "🟢" : "🔴";
        const activity = recent === 0 ? " (no posts 24h)" : ` (${recent} posts)`;
        return `${i + 1}. ${dot} ${s.handle}${activity}`;
      };

      const tg = sources.filter(s => s.type === "telegram");
      const tw = sources.filter(s => s.type === "twitter");

      let response = `🔗 *Sources* — bot tổng hợp content từ những nguồn này\n\n`;
      if (tg.length > 0) response += `📱 *TELEGRAM (${tg.length})*\n${tg.map(fmt).join("\n")}\n\n`;
      if (tw.length > 0) response += `🐦 *TWITTER (${tw.length})*\n${tw.map(fmt).join("\n")}`;

      await safeSend(msg.chat.id, response.trim(), true);
    } catch (err: any) {
      logger.error("bot", `Sources cmd error: ${err.message}`);
    }
  });

  // /addsource
  bot.onText(/\/addsource$/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;

    const opts = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📱 Telegram", callback_data: "add_source_telegram" },
            { text: "🐦 Twitter", callback_data: "add_source_twitter" }
          ]
        ]
      }
    };

    await bot.sendMessage(msg.chat.id, "Vui lòng chọn loại nguồn bạn muốn thêm:", opts);
  });

  bot.on("callback_query", async (query) => {
    if (!query.message || !query.data) return;
    if (!isAdmin(query.from.id)) return;

    if (query.data === "increase_twitter_limit") {
      try {
        const currentLimit = parseInt(await getSettingValue("twitter_daily_limit", "10"), 10);
        const newLimit = currentLimit + 5;
        await setSetting("twitter_daily_limit", newLimit.toString());

        await bot.answerCallbackQuery(query.id, { text: `Đã tăng giới hạn lên ${newLimit} bài!` });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const telegramToday = await db.contentItem.count({
          where: { status: "published", publishedAt: { gte: today } },
        });

        const twitterToday = await db.contentItem.count({
          where: {
            publishedAt: { gte: today },
            tweetEnId: { notIn: ["skipped", "skipped_low_engagement", "skipped_daily_limit", "failed"], not: null },
          },
        });

        const opts = {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [
                { text: `➕ Tăng giới hạn Twitter (+5 bài)`, callback_data: "increase_twitter_limit" }
              ]
            ]
          }
        };

        await bot.editMessageText(
          `📈 Thống kê bài đăng hôm nay:\n\n` +
          `📱 Telegram đã đăng: ${telegramToday} bài\n` +
          `🐦 Twitter đã đăng: ${twitterToday} bài (Giới hạn: ${newLimit})`,
          opts
        );
      } catch (e: any) {
        logger.error("bot", `Increase limit error: ${e.message}`);
      }
      return;
    }

    if (query.data.startsWith("add_source_")) {
      const type = query.data.replace("add_source_", ""); // "telegram" or "twitter"
      addSourceSessions.set(query.from.id, type);

      await bot.answerCallbackQuery(query.id);
      const hint = type === "twitter"
        ? "Ví dụ:\n  `https://x.com/elonmusk`\n  `@VitalikButerin`\n  `cz_binance`"
        : "Ví dụ:\n  `https://t.me/durov`\n  `@WuBlockchain`\n  `https://t.me/+invite_hash`";
      await bot.editMessageText(
        `Đã chọn: *${type.toUpperCase()}*\n\n` +
        `Dán handle hoặc link (mỗi nguồn 1 dòng) — bot tự parse:\n\n${hint}`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "Markdown",
        }
      );
      return;
    }

    // ===== BULK REMOVE SOURCE CALLBACKS =====

    // Step 1: Show confirm dialog
    if (query.data.startsWith("rmsrc_confirm_")) {
      const target = query.data.replace("rmsrc_confirm_", "") as "telegram" | "twitter" | "all";
      const where = target === "all" ? {} : { type: target };
      const sources = await db.source.findMany({ where: { ...where, isActive: true }, select: { handle: true } });

      if (sources.length === 0) {
        await bot.answerCallbackQuery(query.id, { text: "Không có nguồn nào để xóa!" });
        return;
      }

      const label = target === "all" ? "TẤT CẢ" : target.toUpperCase();
      const preview = sources.slice(0, 10).map(s => `• ${s.handle}`).join("\n");
      const more = sources.length > 10 ? `\n...và ${sources.length - 10} nguồn khác` : "";

      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `⚠️ *Xác nhận xóa ${sources.length} nguồn ${label}?*\n\n${preview}${more}\n\nHành động này không thể hoàn tác!`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: `✅ Xác nhận xóa ${sources.length} nguồn`, callback_data: `rmsrc_exec_${target}` },
              { text: "❌ Hủy", callback_data: "rmsrc_cancel" },
            ]],
          },
        }
      );
      return;
    }

    // Step 2: Execute bulk delete
    if (query.data.startsWith("rmsrc_exec_")) {
      const target = query.data.replace("rmsrc_exec_", "") as "telegram" | "twitter" | "all";
      const where = target === "all" ? {} : { type: target };
      try {
        const result = await db.source.updateMany({
          where: { ...where, isActive: true },
          data: { isActive: false },
        });
        await bot.answerCallbackQuery(query.id, { text: `✅ Đã xóa ${result.count} nguồn!` });
        await bot.editMessageText(
          `✅ Đã xóa thành công *${result.count}* nguồn.`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
        );
        logger.info("bot", `Bulk removed ${result.count} sources (type: ${target})`);
      } catch (err: any) {
        logger.error("bot", `Bulk remove exec error: ${err.message}`);
      }
      return;
    }

    // Manual selection: list each source as a button — click to delete one
    if (query.data === "rmsrc_manual" || query.data.startsWith("rmsrc_page:")) {
      const page = query.data.startsWith("rmsrc_page:")
        ? parseInt(query.data.split(":")[1], 10) || 0
        : 0;
      try {
        const view = await buildManualRemoveView(page);
        await bot.answerCallbackQuery(query.id);
        await bot.editMessageText(view.text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: view.keyboard },
        });
      } catch (err: any) {
        logger.error("bot", `Manual list error: ${err.message}`);
      }
      return;
    }

    // Delete one source by id (from manual list)
    if (query.data.startsWith("rmsrc_one:")) {
      const sourceId = query.data.slice("rmsrc_one:".length);
      try {
        const src = await db.source.findUnique({ where: { id: sourceId } });
        if (!src || !src.isActive) {
          await bot.answerCallbackQuery(query.id, { text: "Đã được xóa từ trước" });
        } else {
          await db.source.update({ where: { id: sourceId }, data: { isActive: false } });
          await bot.answerCallbackQuery(query.id, { text: `🔴 Đã xóa ${src.handle}` });
          logger.info("bot", `Source deactivated via button: ${src.handle}`);
        }

        // Refresh list — show first page (or "all done" state)
        const view = await buildManualRemoveView(0);
        await bot.editMessageText(view.text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: view.keyboard },
        }).catch(() => {});
      } catch (err: any) {
        logger.error("bot", `rmsrc_one error: ${err.message}`);
      }
      return;
    }

    // Back to main bulk UI from manual view
    if (query.data === "rmsrc_back") {
      try {
        const tgCount = await db.source.count({ where: { type: "telegram", isActive: true } });
        const twCount = await db.source.count({ where: { type: "twitter", isActive: true } });
        const total = tgCount + twCount;
        await bot.answerCallbackQuery(query.id);
        await bot.editMessageText(
          `🗑️ *Xóa nguồn*\n\nHiện có:\n📱 Telegram: ${tgCount} | 🐦 Twitter: ${twCount}`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: `📱 Xóa Telegram (${tgCount})`, callback_data: "rmsrc_confirm_telegram" },
                  { text: `🐦 Xóa Twitter (${twCount})`, callback_data: "rmsrc_confirm_twitter" },
                ],
                [
                  { text: `🗑️ Xóa tất cả (${total})`, callback_data: "rmsrc_confirm_all" },
                  { text: `✏️ Chọn thủ công`, callback_data: "rmsrc_manual" },
                ],
              ],
            },
          }
        );
      } catch (err: any) {
        logger.error("bot", `rmsrc_back error: ${err.message}`);
      }
      return;
    }

    // Cancel
    if (query.data === "rmsrc_cancel") {
      await bot.answerCallbackQuery(query.id, { text: "Đã hủy." });
      await bot.editMessageText("❌ Đã hủy thao tác xóa.", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
      return;
    }

    // ===== APPROVAL WORKFLOW CALLBACKS =====
    if (query.data.startsWith("appr:")) {
      const [, action, itemId] = query.data.split(":");
      const item = await db.contentItem.findUnique({ where: { id: itemId } });
      if (!item) {
        await bot.answerCallbackQuery(query.id, { text: "Item không tồn tại!" });
        return;
      }

      if (action === "approve" || action === "approve_tg") {
        await db.contentItem.update({
          where: { id: itemId },
          data: {
            status: "rewritten",
            approvedAt: new Date(),
            approvedBy: query.from.first_name || query.from.username || String(query.from.id),
            twitterStatus: action === "approve_tg" ? "ignore" : (item.twitterStatus || "general"),
          },
        });
        const scheduledMsg = item.scheduledFor
          ? `\n\n⏰ Đã lên lịch đăng lúc ${item.scheduledFor.toLocaleString("vi-VN")}`
          : "\n\n🚀 Đăng ngay khi có slot trống.";
        const label = action === "approve_tg" ? "✅ Approved (TG only)" : "✅ Approved (TG + Twitter)";
        await bot.answerCallbackQuery(query.id, { text: label });
        await safeEditMarkup(label + scheduledMsg, query.message.chat.id, query.message.message_id);
        logger.info("approval", `Item ${itemId.slice(0, 8)} ${action} by ${query.from.username || query.from.id}`);
        return;
      }

      if (action === "reject") {
        await db.contentItem.update({
          where: { id: itemId },
          data: { status: "skipped", failReason: "Rejected by admin" },
        });
        await bot.answerCallbackQuery(query.id, { text: "❌ Đã từ chối" });
        await safeEditMarkup("❌ Rejected", query.message.chat.id, query.message.message_id);
        return;
      }

      if (action === "regen") {
        await bot.answerCallbackQuery(query.id, { text: "🔄 Đang gen lại..." });
        try {
          await db.contentItem.update({
            where: { id: itemId },
            data: { status: "skipped", failReason: "Replaced by regen" },
          });
          const { generateEducationContent } = await import("../processor/education-generator.js");
          const slotType = (item.contentType || "concept") as any;
          const newId = await generateEducationContent(slotType, item.scheduledFor || new Date(Date.now() + 60 * 60 * 1000));
          if (newId) {
            await sendApprovalCard(newId);
            await safeEditMarkup("🔄 Regenerated — new card sent", query.message.chat.id, query.message.message_id);
          } else {
            await safeSend(query.message.chat.id, "⚠️ Gen lại thất bại.");
          }
        } catch (err: any) {
          logger.error("approval", `Regen error: ${err.message}`);
          await safeSend(query.message.chat.id, `❌ Lỗi regen: ${err.message}`);
        }
        return;
      }

      if (action === "edit") {
        editCaptionSessions.set(query.from.id, itemId);
        await bot.answerCallbackQuery(query.id, { text: "✏️ Reply với caption mới..." });
        await bot.sendMessage(
          query.message.chat.id,
          `✏️ Reply tin nhắn này với caption MỚI cho item ${itemId.slice(0, 8)}.\nGửi /cancel để hủy.`,
          { reply_to_message_id: query.message.message_id }
        );
        return;
      }
    }

    // ===== STOPBOT CALLBACKS =====
    if (query.data === "stopbot_confirm") {
      try {
        await setSetting("auto_publish", "false");
        const result = await db.contentItem.updateMany({
          where: { status: { in: ["pending", "rewritten", "awaiting_approval"] } },
          data: { status: "skipped", failReason: "Cleared by /stopbot" },
        });
        await bot.answerCallbackQuery(query.id, { text: `Đã xóa ${result.count} items` });
        await bot.editMessageText(
          `⏸ *Bot đã dừng*\n\n` +
          `• Auto-publish: TẮT\n` +
          `• Đã xóa: *${result.count}* items khỏi queue\n\n` +
          `Dùng /resume để bật lại auto-publish.`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
        );
        logger.info("bot", `Stopbot: paused + cleared ${result.count} items`);
      } catch (err: any) {
        logger.error("bot", `Stopbot confirm error: ${err.message}`);
      }
      return;
    }

    if (query.data === "stopbot_cancel") {
      await bot.answerCallbackQuery(query.id, { text: "Đã hủy" });
      await bot.editMessageText("❌ Đã hủy. Bot vẫn chạy bình thường.", {
        chat_id: query.message.chat.id, message_id: query.message.message_id,
      });
      return;
    }

    // ===== GUIDE NAVIGATION =====
    if (query.data.startsWith("guide:")) {
      const section = query.data.slice("guide:".length);
      try {
        await bot.answerCallbackQuery(query.id);

        if (section === "menu") {
          const view = buildGuideMenu();
          await bot.editMessageText(view.text, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: view.keyboard },
          });
        } else {
          const view = buildGuideSection(section);
          await bot.editMessageText(view.text, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: view.keyboard },
          });
        }
      } catch (err: any) {
        logger.error("bot", `Guide nav error: ${err.message}`);
      }
      return;
    }

    if (query.data === "noop") {
      await bot.answerCallbackQuery(query.id);
      return;
    }
  });

  // /removesource — unified single + bulk removal
  //   /removesource                          → open bulk UI (TG/Twitter/All/Manual)
  //   /removesource <h1> <h2> ... <hn>       → batch remove specified handles/URLs
  bot.onText(/^\/removesources?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const argString = (match?.[1] || "").trim();

    // ----- No args: show bulk UI -----
    if (!argString) {
      try {
        const tgCount = await db.source.count({ where: { type: "telegram", isActive: true } });
        const twCount = await db.source.count({ where: { type: "twitter", isActive: true } });
        const total = tgCount + twCount;

        if (total === 0) {
          await safeSend(msg.chat.id, "📭 Không có nguồn nào đang hoạt động để xóa.");
          return;
        }

        await bot.sendMessage(msg.chat.id,
          `🗑️ *Xóa nguồn*\n\n` +
          `Hiện có:\n📱 Telegram: ${tgCount} | 🐦 Twitter: ${twCount}\n\n` +
          `💡 *Tip:* Bạn cũng có thể xóa nhanh bằng cách:\n` +
          `\`/removesource @handle1 @handle2 https://x.com/foo\``,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: `📱 Xóa Telegram (${tgCount})`, callback_data: "rmsrc_confirm_telegram" },
                  { text: `🐦 Xóa Twitter (${twCount})`, callback_data: "rmsrc_confirm_twitter" },
                ],
                [
                  { text: `🗑️ Xóa tất cả (${total})`, callback_data: "rmsrc_confirm_all" },
                  { text: `✏️ Chọn thủ công`, callback_data: "rmsrc_manual" },
                ],
              ],
            },
          }
        );
      } catch (err: any) {
        logger.error("bot", `Removesource UI error: ${err.message}`);
      }
      return;
    }

    // ----- With args: batch remove inline -----
    try {
      const tokens = argString.split(/\s+/).filter(t => t.length > 0);
      const removed: string[] = [];
      const notFound: string[] = [];

      for (const raw of tokens) {
        const candidates = new Set<string>([raw, raw.replace(/^@/, "")]);
        const tg = parseSourceInput(raw, "telegram"); if (tg) candidates.add(tg);
        const tw = parseSourceInput(raw, "twitter");  if (tw) candidates.add(tw);

        const source = await db.source.findFirst({
          where: { OR: Array.from(candidates).flatMap(c => [{ handle: c }, { handle: `@${c}` }]) },
        });
        if (!source) { notFound.push(raw); continue; }
        await db.source.update({ where: { id: source.id }, data: { isActive: false } });
        removed.push(source.handle);
      }

      let reply = `🔴 Đã tắt *${removed.length}/${tokens.length}* nguồn.`;
      if (removed.length > 0)   reply += `\n\n*Đã xóa:*\n${removed.map(h => `• ${h}`).join("\n")}`;
      if (notFound.length > 0)  reply += `\n\n⚠️ *Không tìm thấy:*\n${notFound.map(h => `• ${h}`).join("\n")}`;
      await safeSend(msg.chat.id, reply, true);
      logger.info("bot", `Removed ${removed.length} source(s) via inline command`);
    } catch (err: any) {
      logger.error("bot", `Removesource batch error: ${err.message}`);
    }
  });

  // /queue
  bot.onText(/\/queue/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const items = await db.contentItem.findMany({
        where: { status: "pending" },
        orderBy: { crawledAt: "desc" },
        take: 10,
        include: { source: true },
      });

      if (items.length === 0) {
        await safeSend(msg.chat.id, "📭 Không có item nào trong hàng đợi.");
        return;
      }

      // Escape nội dung gốc để tránh lỗi Markdown
      const lines = items.map(
        (item, i) => {
          const preview = item.originalText.slice(0, 80).replace(/[*_`\[\]]/g, "");
          return `${i + 1}. ${preview}...\n   📌 ${item.source?.name || "Manual"} | ${item.id.slice(0, 8)}`;
        }
      );

      await safeSend(msg.chat.id, `📋 Hàng đợi (${items.length}):\n\n${lines.join("\n\n")}`);
    } catch (err: any) {
      logger.error("bot", `Queue cmd error: ${err.message}`);
    }
  });

  // /recent
  bot.onText(/\/recent/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const items = await db.contentItem.findMany({
        where: { status: "published" },
        orderBy: { publishedAt: "desc" },
        take: 10,
      });

      if (items.length === 0) {
        await safeSend(msg.chat.id, "📭 Chưa có bài nào được đăng.");
        return;
      }

      const lines = items.map(
        (item, i) => {
          const preview = (item.rewrittenText || item.originalText).slice(0, 80).replace(/[*_`\[\]]/g, "");
          return `${i + 1}. ${preview}...\n   🕐 ${item.publishedAt?.toLocaleString("vi-VN")}`;
        }
      );

      await safeSend(msg.chat.id, `📰 Đã đăng gần đây:\n\n${lines.join("\n\n")}`);
    } catch (err: any) {
      logger.error("bot", `Recent cmd error: ${err.message}`);
    }
  });

  // /retry
  bot.onText(/\/retry/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const result = await db.contentItem.updateMany({
        where: { status: "failed" },
        data: { status: "pending", failReason: null },
      });

      await safeSend(msg.chat.id, `🔄 Đã retry ${result.count} items.`);
      logger.info("bot", `Retried ${result.count} failed items`);
    } catch (err: any) {
      logger.error("bot", `Retry cmd error: ${err.message}`);
    }
  });

  // /pause
  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      await setSetting("auto_publish", "false");
      await safeSend(msg.chat.id, "⏸ Auto-publish đã TẮT. Nội dung sẽ dừng ở trạng thái 'rewritten'.");
      logger.info("bot", "Auto-publish paused");
    } catch (err: any) {
      logger.error("bot", `Pause cmd error: ${err.message}`);
    }
  });

  // /resume
  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      await setSetting("auto_publish", "true");
      await safeSend(msg.chat.id, "▶️ Auto-publish đã BẬT.");
      logger.info("bot", "Auto-publish resumed");
    } catch (err: any) {
      logger.error("bot", `Resume cmd error: ${err.message}`);
    }
  });

  // /logs
  bot.onText(/\/logs/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const logs = await db.log.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      if (logs.length === 0) {
        await safeSend(msg.chat.id, "📭 Chưa có log.");
        return;
      }

      const lines = logs.map(
        (l) => `[${l.level.toUpperCase()}] ${l.module}: ${l.message.slice(0, 60)}`
      );

      await safeSend(msg.chat.id, `📝 Logs:\n\n${lines.join("\n")}`);
    } catch (err: any) {
      logger.error("bot", `Logs cmd error: ${err.message}`);
    }
  });

  // /threshold <n>
  bot.onText(/\/threshold(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      if (!match![1]) {
        const cur = await getSettingValue("value_threshold", "5");
        await safeSend(msg.chat.id,
          `📊 Ngưỡng điểm hiện tại: *${cur}*/10\nDùng: \`/threshold <0-10>\` để đổi.\n` +
          `Bài có điểm dưới ngưỡng sẽ bị auto-skip.`,
          true
        );
        return;
      }
      const val = parseInt(match![1], 10);
      if (val < 0 || val > 10) {
        await safeSend(msg.chat.id, "⚠️ Giá trị phải từ 0–10.");
        return;
      }
      await setSetting("value_threshold", val.toString());
      await safeSend(msg.chat.id, `✅ Đã đặt ngưỡng điểm = ${val}/10`);
    } catch (err: any) {
      logger.error("bot", `Threshold cmd error: ${err.message}`);
    }
  });

  // /gap <min> <max>
  bot.onText(/\/gap(?:\s+(\d+)\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      if (!match![1]) {
        const min = await getSettingValue("min_gap_minutes", "15");
        const max = await getSettingValue("max_gap_minutes", "30");
        await safeSend(msg.chat.id,
          `⏱ Khoảng cách post hiện tại: *${min}–${max}* phút (random)\nDùng: \`/gap <min> <max>\``,
          true
        );
        return;
      }
      const minV = parseInt(match![1], 10);
      const maxV = parseInt(match![2], 10);
      if (minV < 1 || maxV < minV || maxV > 240) {
        await safeSend(msg.chat.id, "⚠️ min ≥ 1, max ≥ min, max ≤ 240.");
        return;
      }
      await setSetting("min_gap_minutes", minV.toString());
      await setSetting("max_gap_minutes", maxV.toString());
      await safeSend(msg.chat.id, `✅ Đã đặt gap = ${minV}–${maxV} phút (random)`);
    } catch (err: any) {
      logger.error("bot", `Gap cmd error: ${err.message}`);
    }
  });

  // /minposts [n] — set minimum KOL items needed before synthesis
  bot.onText(/\/minposts(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      if (!match![1]) {
        const cur = await getSettingValue("synthesis_min_items", "3");
        await safeSend(msg.chat.id,
          `🔢 Số bài KOL tối thiểu để tổng hợp: *${cur}*\nDùng: \`/minposts <số>\` để đổi.`,
          true
        );
        return;
      }
      const val = parseInt(match![1], 10);
      if (val < 1 || val > 50) {
        await safeSend(msg.chat.id, "⚠️ Giá trị phải từ 1–50.");
        return;
      }
      await setSetting("synthesis_min_items", val.toString());
      await safeSend(msg.chat.id, `✅ Cần tối thiểu *${val}* bài KOL mới tổng hợp.`, true);
    } catch (err: any) {
      logger.error("bot", `Minposts cmd error: ${err.message}`);
    }
  });

  // /educationnow [type] — generate education content immediately for testing
  bot.onText(/\/educationnow(?:\s+(\w+))?/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const requestedType = (match![1] || "").toLowerCase();
      const validTypes = ["coin_analysis", "chart_pattern", "market_recap", "concept", "trading_tip", "weekly_recap", "setup_of_day"];
      const type = validTypes.includes(requestedType) ? requestedType : "coin_analysis";

      await safeSend(msg.chat.id, `⏳ Đang tạo bài education (${type})...`);
      const { generateEducationContent } = await import("../processor/education-generator.js");
      const id = await generateEducationContent(type as any, new Date(Date.now() + 60 * 60 * 1000));
      if (id) {
        await sendApprovalCard(id);
      } else {
        await safeSend(msg.chat.id, "⚠️ Không thể tạo bài (xem logs).");
      }
    } catch (err: any) {
      logger.error("bot", `Educationnow cmd error: ${err.message}`);
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // /checkca <address> — analyze a token contract address
  bot.onText(/\/checkca\s+(\S+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const raw = match![1].trim();
      await safeSend(msg.chat.id, `🔍 Đang fetch data cho \`${raw.slice(0, 20)}...\``, true);

      const { analyzeToken, formatTokenCard } = await import("../utils/token-analyzer.js");
      const token = await analyzeToken(raw);
      if (!token) {
        await safeSend(msg.chat.id, `❌ Không tìm thấy token trên Dexscreener.\nKiểm tra lại address hoặc token chưa có pool DEX.`);
        return;
      }
      await safeSend(msg.chat.id, formatTokenCard(token), true);
    } catch (err: any) {
      logger.error("bot", `Checkca cmd error: ${err.message}`);
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // /synthesisnow — trigger synthesis immediately (for testing)
  bot.onText(/\/synthesisnow/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const pending = await db.contentItem.count({ where: { status: "pending", contentType: "news" } });
      await safeSend(msg.chat.id, `⏳ Đang tổng hợp ${pending} KOL posts...`);
      const { synthesizeCycle } = await import("../processor/synthesizer.js");
      const id = await synthesizeCycle();
      if (id) {
        await safeSend(msg.chat.id, `✅ Đã tổng hợp xong! Item ${id.slice(0, 8)} sẽ được đăng tiếp theo.`);
      } else {
        await safeSend(msg.chat.id, `⚠️ Không tổng hợp được — cần ít nhất 3 bài KOL trong queue (hiện có ${pending}).`);
      }
    } catch (err: any) {
      logger.error("bot", `Synthesisnow cmd error: ${err.message}`);
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // /pending_approval — list items awaiting approval
  bot.onText(/\/pending_approval/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const items = await db.contentItem.findMany({
        where: { status: "awaiting_approval" },
        orderBy: { scheduledFor: "asc" },
        take: 10,
      });
      if (items.length === 0) {
        await safeSend(msg.chat.id, "📭 Không có bài nào chờ duyệt.");
        return;
      }
      for (const item of items) {
        await sendApprovalCard(item.id, msg.chat.id);
      }
    } catch (err: any) {
      logger.error("bot", `Pending approval cmd error: ${err.message}`);
    }
  });

  // /cancel — clear any open editing session
  bot.onText(/\/cancel/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    editCaptionSessions.delete(msg.from!.id);
    addSourceSessions.delete(msg.from!.id);
    await safeSend(msg.chat.id, "✅ Đã hủy session đang mở.");
  });

  // /skip <id>
  bot.onText(/\/skip (\S+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const idPrefix = match![1];

      const item = await db.contentItem.findFirst({
        where: { id: { startsWith: idPrefix } },
      });

      if (!item) {
        await safeSend(msg.chat.id, `⚠️ Không tìm thấy item: ${idPrefix}`);
        return;
      }

      await db.contentItem.update({
        where: { id: item.id },
        data: { status: "skipped" },
      });

      await safeSend(msg.chat.id, `⏭ Đã bỏ qua item ${item.id.slice(0, 8)}`);
    } catch (err: any) {
      logger.error("bot", `Skip cmd error: ${err.message}`);
    }
  });

  // /crawlnow
  bot.onText(/\/crawlnow/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      await safeSend(msg.chat.id, "🚀 Đang crawl...");
      bot.emit("crawl_now", msg.chat.id);
    } catch (err: any) {
      logger.error("bot", `Crawlnow cmd error: ${err.message}`);
    }
  });

  // /stopbot — pause auto-publish + clear pending queue (with confirm)
  bot.onText(/\/stopbot/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const [pending, rewritten, awaiting] = await Promise.all([
        db.contentItem.count({ where: { status: "pending" } }),
        db.contentItem.count({ where: { status: "rewritten" } }),
        db.contentItem.count({ where: { status: "awaiting_approval" } }),
      ]);
      const total = pending + rewritten + awaiting;

      await bot.sendMessage(msg.chat.id,
        `⚠️ *Dừng bot + xóa queue?*\n\n` +
        `Sẽ thực hiện:\n` +
        `  • Tạm dừng auto-publish\n` +
        `  • Xóa *${pending}* pending KOL items\n` +
        `  • Xóa *${rewritten}* bài đã tổng hợp, chưa đăng\n` +
        `  • Xóa *${awaiting}* bài chờ duyệt\n` +
        `  • Tổng: *${total}* items\n\n` +
        `Bài đã đăng KHÔNG bị ảnh hưởng.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: `✅ Xác nhận dừng (${total})`, callback_data: "stopbot_confirm" },
              { text: "❌ Hủy", callback_data: "stopbot_cancel" },
            ]],
          },
        }
      );
    } catch (err: any) {
      logger.error("bot", `Stopbot cmd error: ${err.message}`);
    }
  });

  // Default: any text without command prefix → manual input
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!isAdmin(msg.from!.id)) return;

    // Check if editing caption for an awaiting-approval item
    const editingItemId = editCaptionSessions.get(msg.from!.id);
    if (editingItemId) {
      editCaptionSessions.delete(msg.from!.id);
      try {
        const item = await db.contentItem.findUnique({ where: { id: editingItemId } });
        if (!item) {
          await safeSend(msg.chat.id, "⚠️ Item không tồn tại nữa.");
          return;
        }
        await db.contentItem.update({
          where: { id: editingItemId },
          data: {
            rewrittenText: msg.text,
            status: "rewritten",
            approvedAt: new Date(),
            approvedBy: (msg.from!.first_name || String(msg.from!.id)) + " (edited)",
          },
        });
        await safeSend(msg.chat.id, `✅ Đã cập nhật caption + duyệt item ${editingItemId.slice(0, 8)}.`);
        logger.info("approval", `Item ${editingItemId.slice(0, 8)} caption edited & approved`);
      } catch (err: any) {
        logger.error("approval", `Edit caption error: ${err.message}`);
      }
      return;
    }


    // Check if in addSource session
    const sessionType = addSourceSessions.get(msg.from!.id);
    if (sessionType) {
      try {
        const lines = msg.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let successCount = 0;
        let errorMsgs = [];

        for (const line of lines) {
          const raw = line.split(/\s+/)[0];
          if (!raw) continue;

          const handle = parseSourceInput(raw, sessionType as "telegram" | "twitter");
          if (!handle) {
            errorMsgs.push(`⚠️ Không hợp lệ: ${raw}`);
            continue;
          }

          try {
            await db.source.create({
              data: { type: sessionType, handle, name: handle },
            });
            successCount++;
          } catch (e: any) {
            if (e.code === "P2002") {
              errorMsgs.push(`⚠️ Đã tồn tại: ${handle}`);
            } else {
              errorMsgs.push(`❌ Lỗi ${handle}: ${e.message}`);
            }
          }
        }

        let response = `✅ Đã thêm thành công ${successCount} nguồn ${sessionType.toUpperCase()}!`;
        if (errorMsgs.length > 0) {
          response += `\n\nCác lỗi xảy ra:\n${errorMsgs.join('\n')}`;
        }
        await safeSend(msg.chat.id, response);
        if (successCount > 0) logger.info("bot", `Added ${successCount} new sources`);

        // Clear session
        addSourceSessions.delete(msg.from!.id);
      } catch (err: any) {
        logger.error("bot", `Addsource session error: ${err.message}`);
      }
      return;
    }

    try {
      await db.contentItem.create({
        data: {
          originalText: msg.text,
          externalId: `manual_${Date.now()}_${msg.message_id}`,
          authorName: msg.from?.first_name || "Manual",
          status: "pending",
        },
      });

      await safeSend(
        msg.chat.id,
        `✅ Đã thêm vào Rổ Content!\n📝 "${msg.text.slice(0, 80)}${msg.text.length > 80 ? "..." : ""}"`
      );
    } catch (err: any) {
      logger.error("bot", `Message handler error: ${err.message}`);
    }
  });

  return bot;
}

/**
 * Build the manual-remove view (one button per active source + pagination + back).
 * Telegram inline keyboards support up to 100 buttons; we paginate at 20 per page for readability.
 */
const PAGE_SIZE = 20;
type InlineButton = { text: string; callback_data: string };
// ===== GUIDE BUILDERS =====

function buildGuideMenu(): { text: string; keyboard: InlineButton[][] } {
  const text =
    `📖 *HƯỚNG DẪN SỬ DỤNG BOT*\n\n` +
    `Chọn nhóm chức năng để xem chi tiết:\n\n` +
    `🔹 *Cách bot hoạt động:* Crawl KOL → Filter noise → Synthesize mỗi 15-30p → Đăng kèm chart + token cards.\n\n` +
    `🔹 *Lưu ý quan trọng:*\n` +
    `  • Bot CẦN sources để hoạt động (/addsource)\n` +
    `  • Cần ≥ 3 KOL items fresh để tổng hợp\n` +
    `  • Education bài cần admin duyệt trước khi đăng`;
  const keyboard: InlineButton[][] = [
    [{ text: "🔗 Quản lý Sources",     callback_data: "guide:sources" }],
    [{ text: "🤖 Synthesis & Content", callback_data: "guide:synth" }],
    [{ text: "🪙 Token Analysis (CA)", callback_data: "guide:token" }],
    [{ text: "🎓 Education Pipeline",  callback_data: "guide:edu" }],
    [{ text: "⚙️ Tinh chỉnh tốc độ",   callback_data: "guide:tune" }],
    [{ text: "📊 Monitor & Stats",     callback_data: "guide:monitor" }],
    [{ text: "🛠 Bảo trì & Reset",     callback_data: "guide:maint" }],
    [{ text: "❓ FAQ — Hỏi đáp",       callback_data: "guide:faq" }],
  ];
  return { text, keyboard };
}

function backButton(): InlineButton[] {
  return [{ text: "« Về menu hướng dẫn", callback_data: "guide:menu" }];
}

function buildGuideSection(section: string): { text: string; keyboard: InlineButton[][] } {
  switch (section) {
    case "sources":
      return {
        text:
          `🔗 *QUẢN LÝ SOURCES*\n\n` +
          `Sources là input DUY NHẤT của bot — là KOL channels/accounts bạn chọn.\n\n` +
          `*📝 Lệnh:*\n\n` +
          `\`/sources\`\n` +
          `→ Xem danh sách KOL đang theo dõi (kèm số bài crawl được 24h).\n\n` +
          `\`/addsource\`\n` +
          `→ Mở UI chọn Telegram / Twitter, paste handle hoặc URL.\n` +
          `→ Hỗ trợ: \`@handle\`, \`https://x.com/foo\`, \`https://t.me/abc\`, hoặc plain text.\n\n` +
          `\`/removesource\`\n` +
          `→ Không tham số: mở UI xóa (chọn Telegram/Twitter/All/Manual).\n` +
          `→ Với args: \`/removesource @h1 @h2 url3\` xóa nhiều cùng lúc.\n` +
          `→ Click \"✏️ Chọn thủ công\" để xóa từng KOL bằng button.\n\n` +
          `💡 *Tips:*\n` +
          `• Chọn 10-30 KOL chất lượng tốt hơn 100 KOL random\n` +
          `• Nên có mix Telegram + Twitter để diverse signal\n` +
          `• Source nào 7 ngày không có bài → nên xóa`,
        keyboard: [backButton()],
      };

    case "synth":
      return {
        text:
          `🤖 *SYNTHESIS & CONTENT*\n\n` +
          `Bot tổng hợp KOL posts thành 1 bài analysis chất lượng mỗi 15-30 phút.\n\n` +
          `*📝 Lệnh:*\n\n` +
          `\`/synthesisnow\`\n` +
          `→ Tổng hợp NGAY không chờ timer (test).\n` +
          `→ Yêu cầu: ≥ 3 KOL items fresh trong queue.\n\n` +
          `\`/minposts [n]\`\n` +
          `→ Đặt số bài KOL tối thiểu để synthesize (default: 3).\n` +
          `→ Tăng (5-10) = bài hiếm nhưng chất hơn.\n` +
          `→ Giảm (2) = bài nhiều hơn.\n\n` +
          `\`/queue\`\n` +
          `→ Xem các KOL items đang chờ xử lý.\n\n` +
          `\`/recent\`\n` +
          `→ Xem 10 bài đã đăng gần nhất.\n\n` +
          `*🎯 AI Output mỗi cycle:*\n` +
          `• Telegram post (300-600 chars, Markdown)\n` +
          `• Tweet ngắn (≤270 chars, hook-first)\n` +
          `• Tweet dài (cho Premium)\n` +
          `• Chart image phù hợp context\n` +
          `• Token cards nếu có CA\n` +
          `• 4-6 hashtags + cashtags`,
        keyboard: [backButton()],
      };

    case "token":
      return {
        text:
          `🪙 *TOKEN ANALYSIS (Contract Address)*\n\n` +
          `Khi KOL post contract address, bot tự động:\n` +
          `1. Extract CA (EVM/Solana/TRON)\n` +
          `2. Fetch data từ Dexscreener (miễn phí)\n` +
          `3. Tính risk flags + verdict\n` +
          `4. Inject vào synthesis context\n\n` +
          `*📝 Lệnh:*\n\n` +
          `\`/checkca <address>\`\n` +
          `→ Test manual 1 address bất kỳ.\n` +
          `→ VD: \`/checkca 0x1234abc...\` hoặc \`/checkca AbCd...\`\n\n` +
          `*🎯 Bot phân tích:*\n` +
          `• Price, MarketCap, FDV, Liquidity\n` +
          `• Volume 24h, Price change 1h/24h\n` +
          `• Age (giờ kể từ pair tạo)\n` +
          `• FDV/MC ratio (unlock pressure)\n` +
          `• Vol/Liq ratio (wash detection)\n\n` +
          `*⚠️ Risk verdict:*\n` +
          `🔴 *High* — liq <$10K hoặc < 2h tuổi\n` +
          `🟡 *Medium* — mặc định\n` +
          `🟢 *Low* — solid metrics`,
        keyboard: [backButton()],
      };

    case "edu":
      return {
        text:
          `🎓 *EDUCATION PIPELINE*\n\n` +
          `Bot tự gen 3 bài education/ngày theo lịch tuần. Mọi bài CẦN admin duyệt.\n\n` +
          `*📅 Lịch tuần (giờ VN):*\n` +
          `• T2/T4/T6: 9h Coin · 15h Chart Pattern · 21h Recap\n` +
          `• T3/T5: 9h Coin · 15h Concept · 21h Trading Tip\n` +
          `• T7: 9h Pattern · 15h Concept · 21h Recap\n` +
          `• CN: 9h Coin · 15h Tip · 21h Weekly Recap\n\n` +
          `*📝 Lệnh:*\n\n` +
          `\`/educationnow [type]\`\n` +
          `→ Tạo bài education ngay để test.\n` +
          `→ type: \`coin_analysis\`, \`chart_pattern\`, \`market_recap\`, \`concept\`, \`trading_tip\`, \`weekly_recap\`.\n\n` +
          `\`/pending_approval\`\n` +
          `→ Xem các bài đang chờ duyệt.\n\n` +
          `*🔘 Approval card có 5 buttons:*\n` +
          `✅ Approve (All)   → Đăng TG + Twitter\n` +
          `📱 Only TG         → Đăng chỉ Telegram\n` +
          `🔄 Regenerate      → Gen lại nội dung\n` +
          `✏️ Edit            → Sửa caption thủ công\n` +
          `❌ Reject          → Bỏ qua\n\n` +
          `Bài không duyệt sau 3h → auto-skip.`,
        keyboard: [backButton()],
      };

    case "tune":
      return {
        text:
          `⚙️ *TINH CHỈNH TỐC ĐỘ ĐĂNG*\n\n` +
          `*📝 Lệnh:*\n\n` +
          `\`/gap [min] [max]\`\n` +
          `→ Khoảng cách giữa 2 bài (phút random).\n` +
          `→ Default: 15-30 phút.\n` +
          `→ VD: \`/gap 20 40\` (chậm hơn) hoặc \`/gap 10 20\` (nhanh hơn).\n\n` +
          `\`/threshold [0-10]\`\n` +
          `→ Điểm tối thiểu để 1 bài được đăng.\n` +
          `→ Default: 5. Tăng (7-8) = bài chất hơn, ít hơn.\n\n` +
          `\`/minposts [n]\`\n` +
          `→ Số KOL items tối thiểu mới synthesize.\n` +
          `→ Default: 3.\n\n` +
          `\`/pause\` — Tạm dừng auto-publish\n` +
          `\`/resume\` — Bật lại\n\n` +
          `*🎯 Setup gợi ý theo mục tiêu:*\n\n` +
          `*Brand mới, build trust:*\n` +
          `\`/gap 30 60\` + \`/minposts 5\` → 1-2 bài/giờ chất lượng\n\n` +
          `*Channel active, KOLs nhiều:*\n` +
          `Default → 2-4 bài/giờ\n\n` +
          `*Daily cap cứng:* 50 bài Telegram, 10 tweets X.`,
        keyboard: [backButton()],
      };

    case "monitor":
      return {
        text:
          `📊 *MONITOR & STATS*\n\n` +
          `*📝 Lệnh:*\n\n` +
          `\`/status\`\n` +
          `→ Tổng quan: sources, KOL pending, rewritten, published, config flags.\n\n` +
          `\`/stats\`\n` +
          `→ Số bài đăng Telegram + Twitter hôm nay.\n` +
          `→ Có nút \"➕ Tăng giới hạn Twitter (+5)\" nếu cần.\n\n` +
          `\`/queue\`\n` +
          `→ 10 KOL items đang trong queue.\n\n` +
          `\`/recent\`\n` +
          `→ 10 bài đã đăng gần nhất.\n\n` +
          `\`/logs\`\n` +
          `→ 20 log lines gần nhất (info/warn/error).\n\n` +
          `\`/crawlnow\`\n` +
          `→ Force crawl ngay (không chờ 60s timer).`,
        keyboard: [backButton()],
      };

    case "maint":
      return {
        text:
          `🛠 *BẢO TRÌ & RESET*\n\n` +
          `*📝 Lệnh:*\n\n` +
          `\`/retry\`\n` +
          `→ Retry tất cả items \`status="failed"\` → đưa về \`pending\`.\n\n` +
          `\`/skip <id>\`\n` +
          `→ Skip 1 item cụ thể bằng id prefix.\n` +
          `→ VD: \`/skip a1b2c3d4\`\n\n` +
          `\`/cancel\`\n` +
          `→ Hủy session đang mở (edit caption, add source...).\n\n` +
          `\`/stopbot\`\n` +
          `→ ⚠️ Dừng auto-publish + xóa toàn bộ queue.\n` +
          `→ Có confirm dialog. Bài đã đăng KHÔNG ảnh hưởng.\n\n` +
          `\`/add <text>\`\n` +
          `→ Thêm content thủ công (cho test hoặc bài 1 lần).\n` +
          `→ Hoặc gửi tin nhắn bất kỳ cho bot (không có /).`,
        keyboard: [backButton()],
      };

    case "faq":
      return {
        text:
          `❓ *FAQ — Hỏi đáp thường gặp*\n\n` +
          `*Q: Tại sao bot chưa đăng bài nào?*\n` +
          `A: Check 3 điều:\n` +
          `1. \`/sources\` có active sources không?\n` +
          `2. \`/status\` → KOL pending có ≥ 3 không?\n` +
          `3. \`/status\` → Auto-publish có BẬT không?\n\n` +
          `*Q: Bot đăng quá nhiều bài, có giới hạn không?*\n` +
          `A: Tăng \`/gap 20 40\` hoặc \`/minposts 5\`. Hard cap 50/ngày.\n\n` +
          `*Q: Tweet bị reject vì quá dài?*\n` +
          `A: Đảm bảo \`TWITTER_PREMIUM=false\` trong .env nếu dùng free tier — bot sẽ auto-truncate 280 chars.\n\n` +
          `*Q: KOL post CA của token, bot có phân tích không?*\n` +
          `A: CÓ. Bot tự fetch từ Dexscreener, append token cards vào post + risk verdict.\n\n` +
          `*Q: Education bài không được đăng?*\n` +
          `A: Vì cần admin duyệt qua nút trên approval card. Check \`/pending_approval\`.\n\n` +
          `*Q: Làm sao reset hết queue?*\n` +
          `A: \`/stopbot\` → xác nhận → \`/resume\` để bật lại auto-publish.`,
        keyboard: [backButton()],
      };

    default:
      return {
        text: `⚠️ Section không tồn tại: ${section}`,
        keyboard: [backButton()],
      };
  }
}

async function sendGuideMenu(chatId: number): Promise<void> {
  const view = buildGuideMenu();
  await bot.sendMessage(chatId, view.text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: view.keyboard },
  });
}

async function buildManualRemoveView(page: number): Promise<{ text: string; keyboard: InlineButton[][] }> {
  const sources = await db.source.findMany({
    where: { isActive: true },
    orderBy: [{ type: "asc" }, { handle: "asc" }],
  });

  if (sources.length === 0) {
    return {
      text: "✅ *Đã xóa hết các nguồn.*\n\nKhông còn nguồn nào đang hoạt động.",
      keyboard: [[{ text: "« Quay lại", callback_data: "rmsrc_back" }]],
    };
  }

  const totalPages = Math.ceil(sources.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = sources.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const keyboard: InlineButton[][] = slice.map(s => {
    const emoji = s.type === "telegram" ? "📱" : "🐦";
    return [{ text: `🗑 ${emoji} ${s.handle}`, callback_data: `rmsrc_one:${s.id}` }];
  });

  // Pagination row (only if needed)
  if (totalPages > 1) {
    const navRow: InlineButton[] = [];
    if (safePage > 0)               navRow.push({ text: "« Prev", callback_data: `rmsrc_page:${safePage - 1}` });
    navRow.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "noop" });
    if (safePage < totalPages - 1)  navRow.push({ text: "Next »", callback_data: `rmsrc_page:${safePage + 1}` });
    keyboard.push(navRow);
  }

  keyboard.push([{ text: "« Quay lại menu xóa", callback_data: "rmsrc_back" }]);

  return {
    text: `✏️ *Chọn nguồn cần xóa* — click vào nguồn để xóa ngay.\n\nTổng: *${sources.length}* nguồn đang hoạt động.`,
    keyboard,
  };
}

// Settings helpers
export async function getSettingValue(key: string, defaultValue: string): Promise<string> {
  const setting = await db.setting.findUnique({ where: { key } });
  return setting?.value ?? defaultValue;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/**
 * Send an approval card to admin(s) for an awaiting_approval item.
 * If chatId is provided, send only there; otherwise broadcast to all ADMIN_IDS.
 */
export async function sendApprovalCard(itemId: string, chatId?: number): Promise<void> {
  if (!bot) return;
  const item = await db.contentItem.findUnique({ where: { id: itemId } });
  if (!item) return;

  const caption = (item.rewrittenText || "").slice(0, 800);
  const scheduledStr = item.scheduledFor
    ? `\n📅 *Schedule:* ${item.scheduledFor.toLocaleString("vi-VN")}`
    : "";
  const typeStr = item.contentType !== "news" ? `\n🎯 *Type:* ${item.contentType}` : "";
  const topicStr = item.educationTopic ? `\n💡 *Topic:* ${item.educationTopic}` : "";

  const header = `🔔 *BÀI CHỜ DUYỆT*${typeStr}${topicStr}${scheduledStr}\n\n${caption}`;
  const truncated = header.length > 950 ? header.slice(0, 950) + "..." : header;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve (All)", callback_data: `appr:approve:${itemId}` },
        { text: "📱 Only TG", callback_data: `appr:approve_tg:${itemId}` },
      ],
      [
        { text: "🔄 Regenerate", callback_data: `appr:regen:${itemId}` },
        { text: "✏️ Edit", callback_data: `appr:edit:${itemId}` },
      ],
      [{ text: "❌ Reject", callback_data: `appr:reject:${itemId}` }],
    ],
  };

  const targets = chatId ? [chatId] : (config.ADMIN_IDS.length > 0 ? config.ADMIN_IDS : []);
  if (targets.length === 0) {
    logger.warn("approval", "No ADMIN_IDS configured; skipping approval card.");
    return;
  }

  const sendToOne = async (tid: number): Promise<number | null> => {
    try {
      let sent;
      if (item.imageUrl) {
        try {
          sent = await bot.sendPhoto(tid, item.imageUrl, {
            caption: truncated.length > 1000 ? truncated.slice(0, 1000) : truncated,
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
        } catch {
          sent = await bot.sendMessage(tid, truncated, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: keyboard,
          });
        }
      } else {
        sent = await bot.sendMessage(tid, truncated, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: keyboard,
        });
      }
      return sent?.message_id ?? null;
    } catch (err: any) {
      logger.error("approval", `sendApprovalCard to ${tid} failed: ${err.message}`);
      return null;
    }
  };

  const results = await Promise.all(targets.map(sendToOne));
  const firstMsgId = results.find(id => id !== null);
  if (firstMsgId && !item.approvalMsgId) {
    await db.contentItem.update({
      where: { id: itemId },
      data: { approvalMsgId: String(firstMsgId) },
    });
  }
}
