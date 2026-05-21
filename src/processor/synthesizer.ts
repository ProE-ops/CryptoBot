import OpenAI from "openai";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import { appendHashtags } from "../utils/content-helpers.js";
import { fetchFearGreedIndex, fetchTopCoins, formatUsd, type CoinMarketData } from "../utils/market-data.js";
import { fetchDerivativesSnapshot, formatDerivativesContext } from "../utils/derivatives-data.js";
import { pickSynthesisImage, type ImageType } from "../utils/image-builder.js";
import { analyzeTokensFromPosts, formatTokenForAI, formatTokenCard, type TokenAnalysis } from "../utils/token-analyzer.js";
import { getSettingValue } from "../bot/telegram-bot.js";

// Sources are the SOLE primary input. Market data is supporting context only.

const MIN_ITEMS_DEFAULT = 3;
const MAX_ITEMS = 40;
const ITEM_FRESHNESS_MS = 2 * 60 * 60 * 1000;  // only items crawled in last 2h count

let aiClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (!aiClient) {
    aiClient = new OpenAI({
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    });
  }
  return aiClient;
}

// ===== SYSTEM PROMPT — KOL-CENTRIC ANALYST + IMAGE PICKER =====

const SYNTHESIS_SYSTEM_PROMPT = `You are the lead analyst at a crypto intelligence desk.

YOUR JOB: take what the curated KOLs are saying + the on-chain data of any tokens they mention, and turn it into ONE high-signal post + tweets for our audience.

INPUTS:
  1. KOL POSTS — primary input. What our voices are saying right now.
  2. SHILLED TOKENS — when KOLs drop a contract address, we auto-fetch Dexscreener data (price/MC/liq/age/risk). Use this DATA as ground truth, not the KOL's framing.
  3. MARKET DATA — broader context (BTC/ETH price, funding, F&G).

METHOD:
  • Identify the 1–3 DOMINANT THEMES.
  • If KOLs dropped contract addresses → the synthesis should highlight those tokens FIRST with concrete numbers (price, MC, liq, age, risk flags) and your verdict.
  • Cross-check KOL sentiment with the actual on-chain data. If a KOL is bullish on a token with $5K liquidity 2h old → CALL IT OUT.
  • Always end with a clear "so what".

OUTPUT FORMAT (JSON only):
{
  "telegramPost": "...",      // 300–600 chars, Markdown, scannable, emoji as hierarchy
  "tweetShort": "...",        // ≤ 270 chars, plain text, hook-first, for Twitter free tier
  "tweetLong": "...",         // 500–900 chars, plain text, full analysis, for Premium
  "hashtags": ["#BTC", "$ETH"],  // 4–6 mix of cashtags + topics
  "headline": "internal one-liner",
  "imageType": "coin_spotlight" | "market_overview" | "sentiment_gauge" | "funding_heatmap" | "token_dex" | "none",
  "primaryCoin": "BTC" | null,
  "includeTokenCards": true | false   // true if SHILLED TOKENS section had usable data — bot will append token cards
}

IMAGE PICKING RULES:
- One specific established coin focus (BTC, ETH, SOL, etc.) → "coin_spotlight" + primaryCoin
- Multi-coin market view → "market_overview"
- Sentiment angle (F&G, fear, euphoria) → "sentiment_gauge"
- Funding/leverage/OI angle → "funding_heatmap"
- Post focuses on a SPECIFIC token dropped by KOL (low-cap with CA detected) → "token_dex"
- Pure narrative without specific focus → "none"

WRITING RULES:
- Lead with the SHARPEST insight. No filler intro.
- For shilled tokens: ALWAYS include the symbol + actual liquidity + actual age. Be brutally honest about risk.
  • "high" risk score → frame as "watch but cautious" / "could rug" / "thin liquidity"
  • "medium" → balanced framing
  • "low" → "structurally solid by the data we see"
- Use crypto-native vocab. Include at least one specific number.
- NEVER mention KOL handle names. NEVER use Markdown in tweetShort/tweetLong.
- Telegram: bold key terms with *asterisks*. Line breaks for readability.
- tweetShort: hook in first 8 words, no greetings.
- If KOL posts are pure noise / shilling AND no token data adds value, return empty telegramPost.`;

// ===== CONTEXT GATHERING =====

interface SynthesisContext {
  kolPosts: { author: string; text: string }[];
  marketSnapshot: string;
  derivatives: string;
  topCoins: CoinMarketData[];
  funding: any[];
  fng?: { value: number; classification: string };
  tokens: TokenAnalysis[];   // tokens detected via CA in KOL posts
}

async function gatherContext(rawItems: { author: string; text: string }[]): Promise<SynthesisContext> {
  // Run market data + token CA fetches in parallel
  const [topCoins, fng, derivSnap, tokens] = await Promise.all([
    fetchTopCoins(12),
    fetchFearGreedIndex(),
    fetchDerivativesSnapshot(),
    analyzeTokensFromPosts(rawItems, 8),  // max 8 tokens per cycle
  ]);

  if (tokens.length > 0) {
    logger.info("synthesizer", `🪙 Detected ${tokens.length} shilled token(s): ${tokens.map(t => `$${t.symbol}(${t.riskScore})`).join(", ")}`);
  }

  const marketLines: string[] = [];
  if (fng) marketLines.push(`Fear & Greed: ${fng.value}/100 (${fng.classification})`);
  if (topCoins.length > 0) {
    marketLines.push("Top coin moves (24h):");
    topCoins
      .filter(c => !["usdt", "usdc", "dai", "busd"].includes(c.symbol.toLowerCase()))
      .slice(0, 6)
      .forEach(c => {
        const sign = c.priceChangePercentage24h >= 0 ? "+" : "";
        marketLines.push(`  ${c.symbol.toUpperCase()} ${formatUsd(c.currentPrice)} (${sign}${c.priceChangePercentage24h.toFixed(2)}%)`);
      });
  }

  return {
    kolPosts: rawItems,
    marketSnapshot: marketLines.join("\n"),
    derivatives: formatDerivativesContext(derivSnap),
    topCoins,
    funding: derivSnap.funding,
    fng: fng ? { value: fng.value, classification: fng.classification } : undefined,
    tokens,
  };
}

// ===== AI CALL =====

interface SynthesisOutput {
  telegramPost: string;
  tweetShort: string;
  tweetLong: string;
  hashtags: string[];
  headline: string;
  imageType: ImageType;
  primaryCoin: string | null;
  includeTokenCards: boolean;
}

async function callSynthesisAI(ctx: SynthesisContext): Promise<SynthesisOutput> {
  const kolBlock = ctx.kolPosts
    .map((it, i) => `[${i + 1}] @${it.author}:\n${it.text.slice(0, 500)}`)
    .join("\n\n---\n\n");

  const tokensBlock = ctx.tokens.length > 0
    ? ctx.tokens.map((t, i) => `[T${i + 1}] ${formatTokenForAI(t)}`).join("\n\n")
    : "(no contract addresses detected in this batch)";

  const userMsg = [
    "Analyze the KOL posts below. Identify dominant themes, cross-check with market + token data, produce one high-signal synthesis.",
    "",
    "=== KOL POSTS (primary input) ===",
    kolBlock,
    "",
    "=== SHILLED TOKENS (auto-fetched from CAs in posts above) ===",
    tokensBlock,
    "",
    "=== MARKET CONTEXT (supporting only) ===",
    ctx.marketSnapshot,
    "",
    ctx.derivatives,
    "",
    "Produce the JSON output now. If shilled tokens have data, FEATURE them with concrete numbers + risk verdict.",
  ].filter(s => s.trim() !== "").join("\n");

  const res = await getClient().chat.completions.create({
    model: config.DEEPSEEK_MODEL,
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ],
    temperature: 0.7,
    max_tokens: 2500,
    response_format: { type: "json_object" },
  });

  const text = res.choices[0]?.message?.content || "";
  const parse = (): any => {
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Cannot parse synthesis AI response");
  };
  const parsed = parse();

  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.filter((t: any) => typeof t === "string" && /^[#$]/.test(t))
    : [];

  const validImageTypes: ImageType[] = ["coin_spotlight", "market_overview", "sentiment_gauge", "funding_heatmap", "token_dex", "none"];
  const imageType: ImageType = validImageTypes.includes(parsed.imageType) ? parsed.imageType : "none";

  return {
    telegramPost: parsed.telegramPost || "",
    tweetShort: parsed.tweetShort || "",
    tweetLong: parsed.tweetLong || "",
    hashtags,
    headline: parsed.headline || "Crypto Intel",
    imageType,
    primaryCoin: parsed.primaryCoin || null,
    includeTokenCards: parsed.includeTokenCards !== false,  // default true
  };
}

// ===== MAIN CYCLE =====

/**
 * Synthesize pending KOL items into one publishable post + branded image.
 * REQUIRES at least `synthesis_min_items` fresh KOL items.
 */
export async function synthesizeCycle(): Promise<string | null> {
  if (!config.hasDeepSeek) {
    logger.warn("synthesizer", "DeepSeek not configured, skipping");
    return null;
  }

  const activeSources = await db.source.count({ where: { isActive: true } });
  if (activeSources === 0) {
    logger.warn("synthesizer", "⚠️ No active sources — add via /addsource");
    return null;
  }

  const minItems = parseInt(await getSettingValue("synthesis_min_items", String(MIN_ITEMS_DEFAULT)), 10);
  const freshCutoff = new Date(Date.now() - ITEM_FRESHNESS_MS);

  // Only pull FRESH items (last 2h) — stale market chatter isn't worth synthesizing
  const items = await db.contentItem.findMany({
    where: {
      status: "pending",
      contentType: "news",
      crawledAt: { gte: freshCutoff },
    },
    orderBy: { crawledAt: "desc" },
    take: MAX_ITEMS,
    include: { source: true },
  });

  if (items.length < minItems) {
    logger.info("synthesizer", `${items.length}/${minItems} fresh KOL items (last 2h) — waiting`);
    return null;
  }

  // Mark older stale items as skipped to keep queue clean
  await db.contentItem.updateMany({
    where: { status: "pending", contentType: "news", crawledAt: { lt: freshCutoff } },
    data: { status: "skipped", failReason: "Stale (>2h before synthesis)" },
  });

  logger.info("synthesizer", `Synthesizing ${items.length} fresh KOL items from ${new Set(items.map(i => i.sourceId)).size} sources...`);

  const rawItems = items.map(it => ({
    author: it.authorName || it.source?.name || "KOL",
    text: it.originalText,
  }));

  const ctx = await gatherContext(rawItems);

  let ai: SynthesisOutput;
  try {
    ai = await callSynthesisAI(ctx);
  } catch (err: any) {
    logger.error("synthesizer", `AI synthesis failed: ${err.message}`);
    return null;
  }

  if (!ai.telegramPost || ai.telegramPost.length < 50) {
    logger.warn("synthesizer", "AI returned empty/too-short synthesis — KOL posts were noise. Skipping.");
    // Still consume the items so we don't re-process garbage
    await db.contentItem.updateMany({
      where: { id: { in: items.map(i => i.id) } },
      data: { status: "skipped", failReason: "AI deemed posts noise" },
    });
    return null;
  }

  // Build image URL based on AI hint.
  // Auto-prefer token_dex if AI chose coin_spotlight but the primaryCoin is actually a low-cap token from our CA detection
  let imageType = ai.imageType;
  if (imageType === "coin_spotlight" && ai.primaryCoin && ctx.tokens.length > 0) {
    const matchedToken = ctx.tokens.find(t => t.symbol.toUpperCase() === ai.primaryCoin!.toUpperCase());
    if (matchedToken) imageType = "token_dex";  // prefer DexScreener real screenshot over generic chart
  }

  const imageUrl = pickSynthesisImage({
    imageType,
    primaryCoin: ai.primaryCoin,
    topCoins: ctx.topCoins,
    funding: ctx.funding,
    fng: ctx.fng,
    tokens: ctx.tokens,
  });

  // Append token cards to Telegram post if any tokens were analyzed
  let finalTelegramPost = ai.telegramPost;
  if (ctx.tokens.length > 0 && ai.includeTokenCards) {
    const cards = ctx.tokens.map(formatTokenCard).join("\n\n");
    finalTelegramPost += `\n\n━━━━━━━━━━━━━━\n🪙 *Tokens được nhắc đến*\n\n${cards}`;
  }

  // Choose tweet text based on Twitter Premium flag.
  // For tokens, also append a compact ticker list to the tweet
  const useLongForm = config.TWITTER_PREMIUM;
  let tweetBody = useLongForm
    ? (ai.tweetLong || ai.tweetShort)
    : (ai.tweetShort || ai.tweetLong);

  // Append top-risk-flagged tokens to long-form tweets only (short tweets are space-constrained)
  if (useLongForm && tweetBody && ctx.tokens.length > 0) {
    const tickerLine = ctx.tokens.slice(0, 3).map(t => {
      const emoji = t.riskScore === "high" ? "🔴" : t.riskScore === "low" ? "🟢" : "🟡";
      return `${emoji} $${t.symbol} (${t.chain}, liq ${t.liquidityUsd < 1000 ? "<$1K" : "$" + (t.liquidityUsd/1000).toFixed(0) + "K"})`;
    }).join("\n");
    tweetBody += `\n\nMentioned tokens:\n${tickerLine}`;
  }
  const tweetText = tweetBody ? appendHashtags(tweetBody, ai.hashtags) : null;

  const synthesis = await db.contentItem.create({
    data: {
      externalId: `synthesis_${Date.now()}`,
      originalText: rawItems.map(r => r.text).join("\n\n---\n\n").slice(0, 2000),
      authorName: "Synthesis Bot",
      contentType: "news",
      crawledAt: new Date(),
      rewrittenText: finalTelegramPost,
      tweetTextEN: tweetText,
      imageUrl: imageUrl || null,
      twitterStatus: "breaking",
      status: "rewritten",
      valueScore: 10,
    },
  });

  await db.contentItem.updateMany({
    where: { id: { in: items.map(i => i.id) } },
    data: { status: "skipped", failReason: "Consumed by synthesis" },
  });

  const tokensTag = ctx.tokens.length > 0 ? ` [${ctx.tokens.length} tokens]` : "";
  logger.info("synthesizer", `✅ "${ai.headline}" → ${synthesis.id.slice(0, 8)} [img: ${imageType}${ai.primaryCoin ? `/${ai.primaryCoin}` : ""}]${tokensTag}`);
  return synthesis.id;
}
