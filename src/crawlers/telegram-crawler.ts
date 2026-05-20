import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import { setSetting, getSettingValue } from "../bot/telegram-bot.js";
import { filterKolContent } from "../utils/content-filter.js";
import fs from "fs";
import path from "path";

if (!fs.existsSync("data/media")) {
  fs.mkdirSync("data/media", { recursive: true });
}

let client: TelegramClient | null = null;
let connectingPromise: Promise<TelegramClient> | null = null;
let eventHandlerRegistered = false;

// ===== BUFFER: Gộp tin từ nguồn đăng nhiều (VN Wallstreet) =====
const MERGE_SOURCES = ["@vnwallstreet", "vnwallstreet"]; // Các handle cần gộp
const MERGE_WINDOW_MS = 5 * 60 * 1000; // 5 phút

interface BufferedMessage {
  texts: string[];
  sourceId: string;
  sourceName: string;
  firstMsgId: string;
  lastMsgId: string;
  mediaPaths: string[];
  idleTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout; // Force flush sau MAX time
  createdAt: number;
}

const mergeBuffers = new Map<string, BufferedMessage>(); // key = sourceId
const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 phút không có tin mới → flush
const MAX_BUFFER_MS = 5 * 60 * 1000; // Tối đa 5 phút → bắt buộc flush

function shouldMerge(handle: string): boolean {
  const clean = handle.replace("@", "").toLowerCase();
  return MERGE_SOURCES.some((s) => s.replace("@", "").toLowerCase() === clean);
}

async function flushBuffer(sourceId: string) {
  const buf = mergeBuffers.get(sourceId);
  if (!buf || buf.texts.length === 0) {
    mergeBuffers.delete(sourceId);
    return;
  }

  // Clear cả 2 timer
  clearTimeout(buf.idleTimer);
  clearTimeout(buf.maxTimer);
  mergeBuffers.delete(sourceId);

  // Gộp tất cả tin thành 1 bài tổng hợp
  const validTexts = buf.texts.filter((t) => t.length > 0);
  if (validTexts.length === 0 && buf.mediaPaths.length === 0) {
    mergeBuffers.delete(sourceId);
    return;
  }
  const mergedText = validTexts.join("\n\n---\n\n");
  const externalId = `merged_${buf.firstMsgId}_${buf.lastMsgId}_${Date.now()}`;

  try {
    await db.contentItem.create({
      data: {
        sourceId: buf.sourceId,
        externalId,
        originalText: mergedText,
        authorName: buf.sourceName,
        status: "pending",
        mediaFiles: buf.mediaPaths.length > 0 ? JSON.stringify(buf.mediaPaths) : null,
      },
    });
    logger.info("tg-crawler", `[MERGE] ${buf.sourceName}: gộp ${buf.texts.length} tin → 1 item (${Math.round((Date.now() - buf.createdAt) / 1000)}s)`);
  } catch (err: any) {
    if (err.code !== "P2002") {
      logger.error("tg-crawler", `[MERGE] DB error: ${err.message}`);
    }
  }
}

function addToBuffer(sourceId: string, sourceName: string, text: string, msgId: string, mediaPath: string | null) {
  const existing = mergeBuffers.get(sourceId);

  if (existing) {
    existing.texts.push(text);
    existing.lastMsgId = msgId;
    if (mediaPath) existing.mediaPaths.push(mediaPath);
    // Reset idle timer — đợi thêm 2 phút từ tin cuối
    clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(() => flushBuffer(sourceId), IDLE_TIMEOUT_MS);
    // maxTimer KHÔNG reset — giữ nguyên deadline 5 phút từ tin đầu
    logger.info("tg-crawler", `[BUFFER] ${sourceName}: +1 tin (total: ${existing.texts.length})`);
  } else {
    const idleTimer = setTimeout(() => flushBuffer(sourceId), IDLE_TIMEOUT_MS);
    const maxTimer = setTimeout(() => flushBuffer(sourceId), MAX_BUFFER_MS);
    mergeBuffers.set(sourceId, {
      texts: [text],
      sourceId,
      sourceName,
      firstMsgId: msgId,
      lastMsgId: msgId,
      mediaPaths: mediaPath ? [mediaPath] : [],
      idleTimer,
      maxTimer,
      createdAt: Date.now(),
    });
    logger.info("tg-crawler", `[BUFFER] ${sourceName}: bắt đầu gộp (flush sau 2-5 phút)`);
  }
}

async function downloadMessageMedia(msg: any, tgClient: TelegramClient): Promise<string | null> {
  if (!msg.media) return null;
  try {
    const buffer = await tgClient.downloadMedia(msg, {});
    if (buffer) {
      const ext = msg.video ? ".mp4" : msg.photo ? ".jpg" : msg.document ? ".mp4" : ".unknown";
      if (ext === ".unknown") return null;
      const filePath = path.join("data", "media", `${msg.id}_${Date.now()}${ext}`);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    }
  } catch (err: any) {
    logger.error("tg-crawler", `Download media failed: ${err.message}`);
  }
  return null;
}

// Lọc link khỏi text
function cleanText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(/(t\.me|bit\.ly|discord\.gg|tinyurl\.com)\/[^\s]+/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getClient(): Promise<TelegramClient> {
  if (client?.connected) return client;

  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    if (client) {
      try { await client.disconnect(); } catch {}
    }

    client = new TelegramClient(
      new StringSession(config.TG_SESSION),
      parseInt(config.TG_API_ID),
      config.TG_API_HASH,
      { connectionRetries: 5 }
    );
    client.setLogLevel("none" as any);

    await client.connect();
    logger.info("tg-crawler", "GramJS client connected");
    return client;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

// ===== REALTIME: Lắng nghe tin nhắn mới từ tất cả channel đã đăng ký =====
async function handleNewMessage(event: NewMessageEvent) {
  const message = event.message;
  const isAlbum = !!message.groupedId;
  const hasText = message.text && message.text.trim().length >= 10;

  if (!hasText && !isAlbum) return;

  // Lấy chat ID / username
  const chat = await message.getChat();
  if (!chat) return;

  const chatId = chat.id?.toString();
  const chatUsername = (chat as any).username;

  // Tìm source phù hợp
  const sources = await db.source.findMany({
    where: { type: "telegram", isActive: true },
  });

  const matchedSource = sources.find((s) => {
    const handle = s.handle.replace("@", "").toLowerCase();
    return (
      handle === chatUsername?.toLowerCase() ||
      handle === chatId ||
      s.handle === chatId
    );
  });

  if (!matchedSource) return; // Không phải channel đã đăng ký

  const cleaned = hasText ? cleanText(message.text) : "";
  if (hasText && cleaned.length < 10) return;

  const msgId = message.id.toString();

  // Cập nhật mốc
  const settingKey = `tg_last_id_${matchedSource.handle}`;
  await setSetting(settingKey, msgId);

  const tgClient = await getClient();
  const mediaPath = await downloadMessageMedia(message, tgClient);

  // Nếu là nguồn cần gộp HOẶC là 1 album (nhiều media) → đưa vào buffer
  if (shouldMerge(matchedSource.handle) || isAlbum) {
    if (cleaned || mediaPath) {
      addToBuffer(matchedSource.id, matchedSource.name, cleaned, msgId, mediaPath);
      logger.info("tg-crawler", `[REALTIME] ${matchedSource.name}: buffered #${msgId} (album/merge)`);
    }
    return;
  }

  if (!cleaned) return; // Nguồn bình thường bắt buộc phải có text

  // Quality filter — skip shilling, link spam, 1-line emoji, etc.
  const filter = filterKolContent(cleaned);
  if (!filter.pass) {
    logger.info("tg-crawler", `[REALTIME] ${matchedSource.name}: skipped (${filter.reason})`);
    return;
  }

  // Nguồn bình thường → tạo item ngay
  try {
    await db.contentItem.create({
      data: {
        sourceId: matchedSource.id,
        externalId: msgId,
        originalText: cleaned,
        authorName: matchedSource.name,
        status: "pending",
        mediaFiles: mediaPath ? JSON.stringify([mediaPath]) : null,
      },
    });
    logger.info("tg-crawler", `[REALTIME] ${matchedSource.name}: new message #${msgId}`);
  } catch (err: any) {
    if (err.code !== "P2002") {
      logger.error("tg-crawler", `[REALTIME] DB error: ${err.message}`);
    }
  }
}

export async function startRealtimeListener() {
  if (!config.hasTelegramCrawler || eventHandlerRegistered) return;

  try {
    const tgClient = await getClient();
    tgClient.addEventHandler(handleNewMessage, new NewMessage({}));
    eventHandlerRegistered = true;
    logger.info("tg-crawler", "Realtime listener started - sẽ nhận tin mới ngay lập tức");
  } catch (err: any) {
    logger.error("tg-crawler", `Failed to start realtime listener: ${err.message}`);
  }
}

// ===== POLLING: Backup crawl định kỳ (bắt tin bị miss) =====
export async function crawlTelegramSources(): Promise<number> {
  if (!config.hasTelegramCrawler) {
    return 0;
  }

  const sources = await db.source.findMany({
    where: { type: "telegram", isActive: true },
  });

  if (sources.length === 0) return 0;

  let totalNew = 0;
  const tgClient = await getClient();

  for (const source of sources) {
    try {
      const count = await crawlOneChannel(tgClient, source);
      totalNew += count;
    } catch (err: any) {
      logger.error("tg-crawler", `Error crawling ${source.handle}: ${err.message}`);
    }
  }

  if (totalNew > 0) {
    logger.info("tg-crawler", `[POLL] Crawled ${totalNew} new messages total`);
  }

  return totalNew;
}

async function crawlOneChannel(
  tgClient: TelegramClient,
  source: { id: string; handle: string; name: string }
): Promise<number> {
  const settingKey = `tg_last_id_${source.handle}`;
  const lastIdStr = await getSettingValue(settingKey, "0");
  const lastId = parseInt(lastIdStr);

  let entity;
  try {
    entity = await tgClient.getEntity(source.handle);
  } catch {
    try {
      entity = await tgClient.getEntity(parseInt(source.handle));
    } catch {
      // Auto-deactivate invalid sources to stop spam errors on every cycle
      logger.warn("tg-crawler", `Cannot find entity: ${source.handle} — auto-deactivating source`);
      await db.source.update({
        where: { id: source.id },
        data: { isActive: false },
      });
      return 0;
    }
  }

  // Lần đầu crawl source mới: lấy tin mới nhất làm mốc
  if (lastId === 0) {
    const latest = await tgClient.getMessages(entity, { limit: 1 });
    if (latest.length > 0) {
      await setSetting(settingKey, latest[0].id.toString());
      logger.info("tg-crawler", `${source.name}: initialized at message #${latest[0].id} (skip old)`);
    }
    return 0;
  }

  const messages = await tgClient.getMessages(entity, {
    limit: 50,
    minId: lastId,
  });

  let newCount = 0;
  let maxId = lastId;

  for (const msg of messages) {
    const isAlbum = !!msg.groupedId;
    const hasText = msg.text && msg.text.trim().length >= 10;

    if (!hasText && !isAlbum) continue;

    const cleaned = hasText ? cleanText(msg.text) : "";
    if (hasText && cleaned.length < 10) continue;

    const msgId = msg.id.toString();
    if (msg.id > maxId) maxId = msg.id;

    const mediaPath = await downloadMessageMedia(msg, tgClient);

    // Nếu là nguồn cần gộp HOẶC là 1 album (nhiều media) → đưa vào buffer
    if (shouldMerge(source.handle) || isAlbum) {
      if (cleaned || mediaPath) {
        addToBuffer(source.id, source.name, cleaned, msgId, mediaPath);
        newCount++;
      }
      continue;
    }

    if (!cleaned) continue;

    // Quality filter
    if (!filterKolContent(cleaned).pass) continue;

    try {
      await db.contentItem.create({
        data: {
          sourceId: source.id,
          externalId: msgId,
          originalText: cleaned,
          authorName: source.name,
          status: "pending",
          mediaFiles: mediaPath ? JSON.stringify([mediaPath]) : null,
        },
      });
      newCount++;
    } catch (err: any) {
      if (err.code !== "P2002") {
        logger.error("tg-crawler", `DB error: ${err.message}`);
      }
    }
  }

  if (maxId > lastId) {
    await setSetting(settingKey, maxId.toString());
  }

  if (newCount > 0) {
    logger.info("tg-crawler", `[POLL] ${source.name}: ${newCount} new messages`);
  }

  return newCount;
}

export async function disconnectTelegramCrawler() {
  if (client?.connected) {
    await client.disconnect();
    logger.info("tg-crawler", "GramJS disconnected");
  }
}
