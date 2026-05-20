import OpenAI from "openai";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import { appendHashtags } from "../utils/content-helpers.js";
import {
  pickTrendingCoin,
  fetchTopCoins,
  fetchGlobalMarket,
  fetchFearGreedIndex,
  buildPriceChartUrl,
  buildMarketRecapChartUrl,
  buildPatternIllustrationUrl,
  formatUsd,
} from "../utils/market-data.js";
import { fetchFundingRates, fetchOpenInterest } from "../utils/derivatives-data.js";

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

// ===== TOPIC ROTATION =====
// 3 slots/day (9AM, 3PM, 9PM VN). 7 days × 3 = 21 slots/week.
// Topic categories rotate to keep content fresh.
type SlotType = "coin_analysis" | "chart_pattern" | "market_recap" | "concept" | "trading_tip" | "weekly_recap" | "setup_of_day";

interface ScheduleSlot {
  hour: number;        // VN hour (0–23)
  type: SlotType;
}

// Daily rhythm: morning Setup of the Day, afternoon rotating educational, evening market recap.
const S = (h: number, t: SlotType): ScheduleSlot => ({ hour: h, type: t });
const AM_SETUP  = S(8,  "setup_of_day");
const PM_RECAP  = S(21, "market_recap");

// Weekly schedule (day of week: 0=Sun … 6=Sat)
const WEEKLY_SCHEDULE: Record<number, ScheduleSlot[]> = {
  0: [AM_SETUP, S(15, "trading_tip"),   S(21, "weekly_recap")], // Sun → weekly recap
  1: [AM_SETUP, S(15, "chart_pattern"), PM_RECAP],              // Mon
  2: [AM_SETUP, S(15, "concept"),       PM_RECAP],              // Tue
  3: [AM_SETUP, S(15, "coin_analysis"), PM_RECAP],              // Wed
  4: [AM_SETUP, S(15, "trading_tip"),   PM_RECAP],              // Thu
  5: [AM_SETUP, S(15, "chart_pattern"), PM_RECAP],              // Fri
  6: [AM_SETUP, S(15, "concept"),       PM_RECAP],              // Sat
};

// ===== CHART PATTERN POOL =====
const CHART_PATTERNS = [
  { name: "Bull Flag", desc: "Continuation pattern signalling bullish momentum after consolidation", sample: [10, 11, 12, 13, 14, 15, 14.8, 14.6, 14.5, 14.4, 14.6, 14.8, 15.2, 16, 17, 18] },
  { name: "Head and Shoulders", desc: "Classic reversal pattern indicating a bullish-to-bearish trend change", sample: [10, 11, 12, 13, 12, 13, 14, 15, 14, 13, 12, 13, 12, 11, 10, 9] },
  { name: "Double Bottom", desc: "Bullish reversal pattern at end of a downtrend", sample: [15, 14, 13, 12, 11, 10, 11, 12, 11, 10, 11, 12, 13, 14, 15, 16] },
  { name: "Cup and Handle", desc: "Bullish continuation pattern resembling a teacup shape", sample: [15, 14, 13, 12, 11, 10, 10.5, 11, 12, 13, 14, 15, 14.5, 14, 14.5, 15.5, 17] },
  { name: "Ascending Triangle", desc: "Bullish continuation: rising lows hitting a horizontal resistance", sample: [10, 12, 11, 13, 11.5, 13.5, 12, 13.5, 12.5, 13.5, 13, 13.8, 14.5, 15, 16] },
  { name: "Descending Triangle", desc: "Bearish continuation: falling highs hitting a horizontal support", sample: [15, 13, 14, 12.5, 14, 12, 14, 11.5, 13.5, 11.5, 12.5, 11, 11.5, 10, 9] },
  { name: "Falling Wedge", desc: "Bullish reversal pattern with converging downward trendlines", sample: [15, 13, 14, 12, 13, 11.5, 12.5, 11.3, 12.2, 11.5, 12.3, 12.8, 13.8, 15, 16.5] },
];

// ===== CONCEPT POOL =====
const CONCEPTS = [
  "DeFi 101: How Decentralized Finance Works",
  "Layer 2 Scaling: Optimistic vs ZK Rollups",
  "Liquidity Pools and Impermanent Loss",
  "What is MEV (Maximum Extractable Value)?",
  "Staking vs Yield Farming: Key Differences",
  "Understanding On-Chain Metrics: TVL, MAU, Active Addresses",
  "Real World Assets (RWA): The Bridge to TradFi",
  "Cross-chain Bridges: How They Work and Their Risks",
  "DAOs and On-Chain Governance Explained",
  "Stablecoins: USDT, USDC, DAI and the Mechanics Behind Them",
  "Order Book vs AMM: Two Worlds of Crypto Trading",
  "What is Restaking? EigenLayer and the Modular Thesis",
];

// ===== TRADING TIPS POOL =====
const TRADING_TIPS = [
  "Position Sizing: The 1-2% Rule",
  "Stop Loss Strategies for Volatile Markets",
  "How to Read Order Book Depth",
  "Risk-to-Reward Ratios: Why 1:3 Beats Lucky Wins",
  "Funding Rates: What They Tell You About Market Sentiment",
  "Avoiding FOMO: Mechanical Entry Rules",
  "Trading Journals: Why Pros Keep One",
  "Open Interest vs Volume: Reading the Real Action",
  "Liquidation Heatmaps: Where Whales Are Trapped",
  "Dollar-Cost Averaging vs Lump Sum Investing",
];

// ===== PROMPT BUILDERS =====

interface GenerationContext {
  type: SlotType;
  imageUrl: string;
  marketContext: string;  // Data passed to AI
  topicHint: string;       // Topic name / coin name for storage
  educationTopic: string;
}

async function buildCoinAnalysisContext(): Promise<GenerationContext | null> {
  const [coin, fng] = await Promise.all([pickTrendingCoin(), fetchFearGreedIndex()]);
  if (!coin) return null;
  const imageUrl = buildPriceChartUrl(`${coin.name} (${coin.symbol.toUpperCase()})`, coin.sparkline7d);

  const change7d = coin.priceChangePercentage7d !== null
    ? `${coin.priceChangePercentage7d.toFixed(2)}%`
    : "N/A";

  const marketContext = [
    `Coin: ${coin.name} (${coin.symbol.toUpperCase()})`,
    `Rank: #${coin.marketCapRank} by market cap`,
    `Current Price: ${formatUsd(coin.currentPrice)}`,
    `24h Change: ${coin.priceChangePercentage24h.toFixed(2)}%`,
    `7d Change: ${change7d}`,
    `Market Cap: ${formatUsd(coin.marketCap)}`,
    `24h Volume: ${formatUsd(coin.totalVolume)}`,
    fng ? `Market Fear & Greed Index: ${fng.value}/100 (${fng.classification})` : "",
  ].filter(Boolean).join("\n");

  return {
    type: "coin_analysis",
    imageUrl,
    marketContext,
    topicHint: `${coin.name} (${coin.symbol.toUpperCase()})`,
    educationTopic: `coin_analysis:${coin.symbol}`,
  };
}

async function buildMarketRecapContext(): Promise<GenerationContext | null> {
  const [coins, global, fng] = await Promise.all([fetchTopCoins(15), fetchGlobalMarket(), fetchFearGreedIndex()]);
  if (coins.length === 0) return null;

  const filtered = coins.filter(c => !["usdt", "usdc", "dai"].includes(c.symbol.toLowerCase()));
  const imageUrl = buildMarketRecapChartUrl(filtered);

  const topGainers = [...filtered].sort((a, b) => b.priceChangePercentage24h - a.priceChangePercentage24h).slice(0, 3);
  const topLosers = [...filtered].sort((a, b) => a.priceChangePercentage24h - b.priceChangePercentage24h).slice(0, 3);

  const marketContext = [
    global ? `Global Market Cap: ${formatUsd(global.totalMarketCap)} (${global.marketCapChangePercentage24h.toFixed(2)}% 24h)` : "",
    global ? `24h Volume: ${formatUsd(global.totalVolume24h)}` : "",
    global ? `BTC Dominance: ${global.btcDominance.toFixed(2)}% | ETH Dominance: ${global.ethDominance.toFixed(2)}%` : "",
    fng ? `Fear & Greed: ${fng.value}/100 (${fng.classification})` : "",
    "",
    "TOP GAINERS (24h):",
    ...topGainers.map(c => `  ${c.symbol.toUpperCase()}: ${c.priceChangePercentage24h.toFixed(2)}% @ ${formatUsd(c.currentPrice)}`),
    "",
    "TOP LOSERS (24h):",
    ...topLosers.map(c => `  ${c.symbol.toUpperCase()}: ${c.priceChangePercentage24h.toFixed(2)}% @ ${formatUsd(c.currentPrice)}`),
    "",
    "TOP 8 BY MARKET CAP:",
    ...filtered.slice(0, 8).map(c => `  ${c.symbol.toUpperCase()}: ${formatUsd(c.currentPrice)} (${c.priceChangePercentage24h.toFixed(2)}%)`),
  ].filter(Boolean).join("\n");

  return {
    type: "market_recap",
    imageUrl,
    marketContext,
    topicHint: "Crypto Market Recap",
    educationTopic: "market_recap",
  };
}

async function buildChartPatternContext(): Promise<GenerationContext | null> {
  const pattern = CHART_PATTERNS[Math.floor(Math.random() * CHART_PATTERNS.length)];
  const imageUrl = buildPatternIllustrationUrl(pattern.name, pattern.sample);
  return {
    type: "chart_pattern",
    imageUrl,
    marketContext: `Chart Pattern: ${pattern.name}\nDescription: ${pattern.desc}`,
    topicHint: pattern.name,
    educationTopic: `chart_pattern:${pattern.name}`,
  };
}

async function buildConceptContext(): Promise<GenerationContext | null> {
  const concept = CONCEPTS[Math.floor(Math.random() * CONCEPTS.length)];
  return {
    type: "concept",
    imageUrl: "",
    marketContext: `Topic: ${concept}`,
    topicHint: concept,
    educationTopic: `concept:${concept}`,
  };
}

async function buildTradingTipContext(): Promise<GenerationContext | null> {
  const tip = TRADING_TIPS[Math.floor(Math.random() * TRADING_TIPS.length)];
  return {
    type: "trading_tip",
    imageUrl: "",
    marketContext: `Trading Tip Topic: ${tip}`,
    topicHint: tip,
    educationTopic: `trading_tip:${tip}`,
  };
}

async function buildWeeklyRecapContext(): Promise<GenerationContext | null> {
  // Same as market recap but framed as weekly
  const ctx = await buildMarketRecapContext();
  if (!ctx) return null;
  return { ...ctx, type: "weekly_recap", topicHint: "Weekly Crypto Recap", educationTopic: "weekly_recap" };
}

/**
 * Setup of the Day — the flagship daily content.
 * Picks a high-momentum / interesting coin, gathers price + derivatives context,
 * and asks AI for a structured trade idea (entry / invalidation / target / thesis).
 */
async function buildSetupOfDayContext(): Promise<GenerationContext | null> {
  const [coin, fng, funding, oi] = await Promise.all([
    pickTrendingCoin(),
    fetchFearGreedIndex(),
    fetchFundingRates(),
    fetchOpenInterest(),
  ]);
  if (!coin) return null;

  const imageUrl = buildPriceChartUrl(`${coin.name} (${coin.symbol.toUpperCase()})`, coin.sparkline7d);

  // Lookup funding / OI for this coin if we have it
  const symbol = coin.symbol.toUpperCase();
  const coinFunding = funding.find(f => f.symbol === symbol);
  const coinOi = oi.find(o => o.symbol === symbol);

  const change7d = coin.priceChangePercentage7d !== null
    ? `${coin.priceChangePercentage7d.toFixed(2)}%`
    : "N/A";

  const marketContext = [
    `=== SETUP COIN ===`,
    `Coin: ${coin.name} (${symbol})`,
    `Rank: #${coin.marketCapRank}`,
    `Current Price: ${formatUsd(coin.currentPrice)}`,
    `24h Change: ${coin.priceChangePercentage24h.toFixed(2)}%`,
    `7d Change: ${change7d}`,
    `Market Cap: ${formatUsd(coin.marketCap)}`,
    `24h Volume: ${formatUsd(coin.totalVolume)}`,
    "",
    "=== DERIVATIVES CONTEXT ===",
    coinFunding ? `Funding Rate: ${coinFunding.fundingRatePercent >= 0 ? "+" : ""}${coinFunding.fundingRatePercent.toFixed(4)}% (${coinFunding.fundingRatePercent > 0.05 ? "longs overpaying — caution" : coinFunding.fundingRatePercent < -0.05 ? "shorts overpaying — squeeze possible" : "neutral"})` : "Funding: N/A",
    coinOi ? `Open Interest: $${(coinOi.openInterestUsd / 1e9).toFixed(2)}B` : "OI: N/A",
    "",
    "=== MARKET MOOD ===",
    fng ? `Fear & Greed: ${fng.value}/100 (${fng.classification})` : "F&G: N/A",
  ].join("\n");

  return {
    type: "setup_of_day",
    imageUrl,
    marketContext,
    topicHint: `Setup of the Day: ${symbol}`,
    educationTopic: `setup_of_day:${coin.symbol}`,
  };
}

// ===== AI PROMPT =====

const EDUCATION_SYSTEM_PROMPT = `You are a senior crypto markets analyst and educator producing content for a global crypto-native channel.
Audience: crypto traders, DeFi users, Web3 enthusiasts — beginner to advanced.

For each piece of content, produce:
1. A Telegram caption (200–400 words, Markdown, image-attached post). Punchy, scannable, uses emojis.
2. A long-form Twitter/X post in English (300–600 words, plain text).
3. Hashtags / cashtags relevant to the content.

KEY RULES:
- HIGH-SIGNAL, accurate, and pedagogically sharp. No fluff.
- Use crypto-native language (TVL, liquidity, on-chain, AMM, perps, OI...) but explain when first used in a beginner-friendly piece.
- For coin analysis: include technical view (support/resistance/trend), fundamental context (recent news), and "what to watch."
- For chart pattern / concept / trading tip: lead with the definition, follow with WHY it matters, then HOW to use it. End with a practical takeaway.
- For market recap: lead with the headline (overall direction), then highlight movers, sentiment, dominance shifts, and what's ahead.
- DO NOT give financial advice. Frame as analysis / education.
- DO NOT use referral links or shilling language.
- Use line breaks for readability. NO Markdown in tweetEN.
- Hashtags 3–6 items. Mix cashtags ($BTC, $ETH...) and topic tags (#DeFi, #TA, #CryptoEducation).

Respond in JSON:
{
  "telegramCaption": "...",
  "tweetEN": "...",
  "hashtags": ["#Tag1", "$BTC"],
  "title": "Short content title for internal reference"
}`;

interface EducationOutput {
  telegramCaption: string;
  tweetEN: string;
  hashtags: string[];
  title: string;
}

async function callEducationAI(type: SlotType, ctx: GenerationContext): Promise<EducationOutput> {
  const typeBrief: Record<SlotType, string> = {
    coin_analysis: "Produce a focused **coin analysis** for the coin below. Include trend assessment, key levels, sentiment context, and what to watch next 24–72h.",
    chart_pattern: "Produce a **chart pattern educational post** explaining the pattern below: what it looks like, why it forms, how to trade it (entry/stop/target), and one historical crypto example.",
    market_recap: "Produce a **daily crypto market recap** with the data below. Lead with overall sentiment, highlight key movers, dominance dynamics, and the read-through for traders.",
    concept: "Produce an **educational explainer** on the topic below. Lead with a clear definition, explain why it matters in crypto, give 1–2 concrete examples or protocols, and a practical takeaway.",
    trading_tip: "Produce a **trading education** post on the tip below. Define the concept, show why traders fail without it, give a clear actionable rule, and a real-world scenario.",
    weekly_recap: "Produce a **weekly crypto market recap** with the data below. Cover the week's narrative, dominant trends, major movers, sector rotations, and the coming week's catalysts to watch.",
    setup_of_day:
      "Produce **SETUP OF THE DAY** — a high-conviction trade idea for ONE coin using the data below. STRICT structure:\n" +
      "1) Hook line — one sharp observation that justifies the setup\n" +
      "2) The Thesis — 2–3 sentences combining technicals + derivatives data (funding/OI/sentiment)\n" +
      "3) Key Levels — specific numbers: ENTRY ZONE / INVALIDATION / TARGET 1 / TARGET 2 (use the current price as anchor, propose realistic levels)\n" +
      "4) Risk Note — what would invalidate the thesis (1 line)\n" +
      "5) Bias — Long / Short / Wait, with confidence (low/medium/high)\n" +
      "Frame as EDUCATIONAL analysis, NOT financial advice. End with: 'NFA. DYOR.'",
  };

  const userMsg = `${typeBrief[type]}\n\n=== CONTEXT DATA ===\n${ctx.marketContext}\n\nIMPORTANT: For the Telegram caption, keep it under 1000 characters and image-friendly (since an illustrative chart will be attached). For tweetEN, write the full long-form analysis.`;

  const client = getClient();
  const res = await client.chat.completions.create({
    model: config.DEEPSEEK_MODEL,
    messages: [
      { role: "system", content: EDUCATION_SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ],
    temperature: 0.75,
    max_tokens: 3000,
    response_format: { type: "json_object" },
  });

  const text = res.choices[0]?.message?.content || "";
  const parse = (): any => {
    try { return JSON.parse(text); } catch { }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Cannot parse education AI response");
  };
  const parsed = parse();

  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.filter((t: any) => typeof t === "string" && (t.startsWith("#") || t.startsWith("$")))
    : [];

  return {
    telegramCaption: parsed.telegramCaption || "",
    tweetEN: parsed.tweetEN || "",
    hashtags,
    title: parsed.title || ctx.topicHint,
  };
}

// ===== MAIN ENTRY POINT =====

/** Determine the next scheduled education slot in the future (within 24h). */
export function getNextScheduledSlot(): { scheduledFor: Date; type: SlotType } | null {
  const now = new Date();
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    const dayOfWeek = day.getDay();
    const slots = WEEKLY_SCHEDULE[dayOfWeek] || [];
    for (const slot of slots) {
      const slotDate = new Date(day);
      slotDate.setHours(slot.hour, 0, 0, 0);
      if (slotDate.getTime() > now.getTime() + 60 * 1000) { // strictly in the future
        return { scheduledFor: slotDate, type: slot.type };
      }
    }
  }
  return null;
}

async function buildContext(type: SlotType): Promise<GenerationContext | null> {
  switch (type) {
    case "coin_analysis":  return buildCoinAnalysisContext();
    case "market_recap":   return buildMarketRecapContext();
    case "chart_pattern":  return buildChartPatternContext();
    case "concept":        return buildConceptContext();
    case "trading_tip":    return buildTradingTipContext();
    case "weekly_recap":   return buildWeeklyRecapContext();
    case "setup_of_day":   return buildSetupOfDayContext();
  }
}

/**
 * Generate an education item for the given slot, saved with status=awaiting_approval.
 * The bot will then send the approval card to admins.
 * Returns the created item ID, or null if skipped.
 */
export async function generateEducationContent(
  type: SlotType,
  scheduledFor: Date
): Promise<string | null> {
  if (!config.hasDeepSeek) {
    logger.warn("education", "DeepSeek not configured, skipping education generation");
    return null;
  }

  // Don't double-generate for the same slot
  const existing = await db.contentItem.findFirst({
    where: {
      contentType: { not: "news" },
      scheduledFor: scheduledFor,
      status: { notIn: ["skipped", "failed"] },
    },
  });
  if (existing) {
    logger.info("education", `Slot ${scheduledFor.toISOString()} already has item ${existing.id.slice(0, 8)}`);
    return null;
  }

  const ctx = await buildContext(type);
  if (!ctx) {
    logger.warn("education", `Failed to build context for ${type}`);
    return null;
  }

  let ai: EducationOutput;
  try {
    ai = await callEducationAI(type, ctx);
  } catch (err: any) {
    logger.error("education", `AI gen failed for ${type}: ${err.message}`);
    return null;
  }

  if (!ai.telegramCaption || ai.telegramCaption.length < 50) {
    logger.warn("education", `Education AI produced too short caption for ${type}`);
    return null;
  }

  const tweetEN = ai.tweetEN ? appendHashtags(ai.tweetEN, ai.hashtags) : null;

  const item = await db.contentItem.create({
    data: {
      externalId: `edu_${type}_${scheduledFor.getTime()}`,
      originalText: ctx.marketContext,
      authorName: "Education Bot",
      contentType: type,
      educationTopic: ctx.educationTopic,
      imageUrl: ctx.imageUrl || null,
      rewrittenText: ai.telegramCaption,
      tweetTextEN: tweetEN,
      twitterStatus: "breaking", // education always eligible for Twitter
      status: "awaiting_approval",
      approvalRequired: true,
      scheduledFor,
      valueScore: 10, // education is curated, max score
    },
  });

  logger.info("education", `Generated ${type} (${ai.title}) → item ${item.id.slice(0, 8)}, scheduled ${scheduledFor.toISOString()}`);
  return item.id;
}

/**
 * Background cycle: pre-generate education content ~1h before each scheduled slot
 * so admins have time to approve.
 */
export async function educationGenerationCycle(): Promise<void> {
  const next = getNextScheduledSlot();
  if (!next) return;

  const now = Date.now();
  const slotTime = next.scheduledFor.getTime();
  const leadTime = 60 * 60 * 1000; // generate 1h before slot

  // Only generate when slot is between [now, now+leadTime+buffer]
  if (slotTime - now > leadTime + 10 * 60 * 1000) return;
  if (slotTime - now < -5 * 60 * 1000) return; // skip stale (>5min past)

  await generateEducationContent(next.type, next.scheduledFor);
}
