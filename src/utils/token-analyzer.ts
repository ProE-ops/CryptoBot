/**
 * Detect contract addresses (CA) dropped in KOL posts, then fetch
 * on-chain / DEX data via Dexscreener (FREE, no API key).
 *
 * Supports: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche,
 *           Solana, TRON, and any chain Dexscreener indexes.
 */

import { logger } from "./logger.js";

// ===== ADDRESS DETECTION =====

const EVM_ADDR_RE   = /\b(0x[a-fA-F0-9]{40})\b/g;
// Solana base58: 32–44 chars, excludes 0/O/I/l. Greedy match.
const SOL_ADDR_RE   = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
// TRON: starts with 'T', 34 chars total
const TRON_ADDR_RE  = /\b(T[1-9A-HJ-NP-Za-km-z]{33})\b/g;

// Common base58 tokens that aren't contract addresses (false positives)
const SOL_FP_BLACKLIST = new Set<string>([
  "So11111111111111111111111111111111111111112", // wrapped SOL — usually mentioned generically
]);

export interface DetectedAddress {
  address: string;
  chainHint: "evm" | "solana" | "tron";
}

/**
 * Extract candidate contract addresses from raw KOL text.
 * Dedupes within a single text, preserves first occurrence order.
 */
export function extractContractAddresses(text: string): DetectedAddress[] {
  const seen = new Set<string>();
  const out: DetectedAddress[] = [];

  // 1) EVM addresses (most specific — match first)
  for (const m of text.matchAll(EVM_ADDR_RE)) {
    const addr = m[1];
    if (seen.has(addr.toLowerCase())) continue;
    seen.add(addr.toLowerCase());
    out.push({ address: addr, chainHint: "evm" });
  }

  // 2) TRON
  for (const m of text.matchAll(TRON_ADDR_RE)) {
    const addr = m[1];
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push({ address: addr, chainHint: "tron" });
  }

  // 3) Solana (after EVM/TRON to avoid double-matching prefixes)
  for (const m of text.matchAll(SOL_ADDR_RE)) {
    const addr = m[1];
    if (seen.has(addr)) continue;
    if (SOL_FP_BLACKLIST.has(addr)) continue;
    // Filter false positives: must not look like a hash, must include some uppercase variance
    if (addr.length < 32) continue;
    // Skip if it could be confused with an EVM address (rare but defensive)
    if (/^0x/.test(addr)) continue;
    seen.add(addr);
    out.push({ address: addr, chainHint: "solana" });
  }

  return out;
}

// ===== TOKEN ANALYSIS via DEXSCREENER =====

export interface TokenAnalysis {
  address: string;
  chain: string;            // dexscreener chainId (e.g., "solana", "ethereum", "base")
  name: string;
  symbol: string;
  priceUsd: number;
  marketCap: number;
  fdv: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange1h: number;
  priceChange24h: number;
  ageHours: number;
  dexUrl: string;
  pairAddress: string;
  risks: string[];
  signals: string[];
  riskScore: "high" | "medium" | "low";  // overall verdict
}

interface DexscreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h6?: number; h1?: number };
  priceChange?: { h1?: number; h24?: number };
  pairCreatedAt?: number;  // unix ms
}

/**
 * Fetch token data from Dexscreener and compute risk flags.
 * Returns null if not found (token doesn't exist on-DEX yet, or invalid address).
 */
export async function analyzeToken(address: string): Promise<TokenAnalysis | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json() as { pairs?: DexscreenerPair[] };
    if (!data.pairs || data.pairs.length === 0) return null;

    // Pick the most liquid pair (best representation of token)
    const pair = [...data.pairs].sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];

    const liq    = pair.liquidity?.usd ?? 0;
    const mcap   = pair.marketCap ?? 0;
    const fdv    = pair.fdv ?? 0;
    const vol24  = pair.volume?.h24 ?? 0;
    const chg1   = pair.priceChange?.h1 ?? 0;
    const chg24  = pair.priceChange?.h24 ?? 0;
    const ageMs  = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
    const ageHours = ageMs > 0 ? ageMs / 3600_000 : 0;

    const risks: string[]   = [];
    const signals: string[] = [];

    // Liquidity tiers
    if (liq < 5_000)        risks.push(`💀 Liq cực thấp ($${(liq/1000).toFixed(1)}K)`);
    else if (liq < 25_000)  risks.push(`⚠️ Liq thấp ($${(liq/1000).toFixed(1)}K)`);
    else if (liq > 250_000) signals.push(`✅ Liq tốt ($${(liq/1000).toFixed(0)}K)`);

    // Age
    if (ageHours > 0 && ageHours < 1)       risks.push(`🆕 Mới ${(ageHours*60).toFixed(0)} phút (rug risk cao)`);
    else if (ageHours < 24)                 risks.push(`🆕 < 24h tuổi (${ageHours.toFixed(1)}h)`);
    else if (ageHours < 24 * 7)             signals.push(`🌱 ${(ageHours/24).toFixed(1)} ngày tuổi`);
    else if (ageHours > 24 * 30)            signals.push(`🏛 > 30 ngày tuổi`);

    // FDV vs MC — unlock pressure
    if (fdv > 0 && mcap > 0 && fdv > mcap * 5) {
      risks.push(`📉 FDV ${(fdv/mcap).toFixed(1)}x MC (unlock pressure)`);
    }

    // Wash trading sniff test
    if (liq > 0 && vol24 > liq * 5) {
      risks.push(`🚨 Volume > 5x liq (wash trading?)`);
    }

    // Momentum signals
    if (chg24 > 100)       signals.push(`🚀 +${chg24.toFixed(0)}% 24h`);
    else if (chg24 > 30)   signals.push(`📈 +${chg24.toFixed(1)}% 24h`);
    if (chg24 < -50)       risks.push(`📉 ${chg24.toFixed(1)}% 24h (đổ mạnh)`);

    if (vol24 > 500_000)   signals.push(`💸 Vol $${(vol24/1000).toFixed(0)}K (24h)`);

    // Overall verdict
    let riskScore: TokenAnalysis["riskScore"] = "medium";
    if (risks.length >= 3 || liq < 10_000 || ageHours < 2)        riskScore = "high";
    else if (risks.length === 0 && signals.length >= 2)           riskScore = "low";

    return {
      address,
      chain: pair.chainId,
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      priceUsd: parseFloat(pair.priceUsd || "0"),
      marketCap: mcap,
      fdv,
      liquidityUsd: liq,
      volume24hUsd: vol24,
      priceChange1h: chg1,
      priceChange24h: chg24,
      ageHours,
      dexUrl: pair.url,
      pairAddress: pair.pairAddress,
      risks,
      signals,
      riskScore,
    };
  } catch (err: any) {
    logger.warn("token", `analyzeToken failed for ${address.slice(0, 10)}...: ${err.message}`);
    return null;
  }
}

// ===== BATCH HELPERS =====

/**
 * Scan multiple KOL posts → return unique token analyses.
 * Concurrency-limited so we don't hammer the API.
 */
export async function analyzeTokensFromPosts(
  posts: { text: string }[],
  maxTokens = 8
): Promise<TokenAnalysis[]> {
  const allAddrs: DetectedAddress[] = [];
  const seen = new Set<string>();

  for (const p of posts) {
    for (const a of extractContractAddresses(p.text)) {
      const key = a.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      allAddrs.push(a);
      if (allAddrs.length >= maxTokens) break;
    }
    if (allAddrs.length >= maxTokens) break;
  }

  if (allAddrs.length === 0) return [];

  const results = await Promise.all(allAddrs.map(a => analyzeToken(a.address)));
  return results.filter(Boolean) as TokenAnalysis[];
}

// ===== FORMATTERS =====

function formatUsdShort(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function formatPrice(v: number): string {
  if (v >= 1)       return `$${v.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  if (v >= 0.0001)  return `$${v.toFixed(6)}`;
  return `$${v.toExponential(3)}`;
}

/** Compact one-line summary for AI context. */
export function formatTokenForAI(t: TokenAnalysis): string {
  const lines = [
    `${t.symbol} (${t.name}) on ${t.chain}`,
    `  Price ${formatPrice(t.priceUsd)} · MC ${formatUsdShort(t.marketCap)} · Liq ${formatUsdShort(t.liquidityUsd)} · Vol24h ${formatUsdShort(t.volume24hUsd)}`,
    `  24h ${t.priceChange24h >= 0 ? "+" : ""}${t.priceChange24h.toFixed(2)}% · Age ${t.ageHours < 24 ? `${t.ageHours.toFixed(1)}h` : `${(t.ageHours/24).toFixed(1)}d`}`,
    `  Risk: ${t.riskScore.toUpperCase()}`,
  ];
  if (t.risks.length > 0)   lines.push(`  Risks: ${t.risks.join("; ")}`);
  if (t.signals.length > 0) lines.push(`  Signals: ${t.signals.join("; ")}`);
  return lines.join("\n");
}

/** Markdown summary suitable for direct embedding in a Telegram post. */
export function formatTokenCard(t: TokenAnalysis): string {
  const riskEmoji = t.riskScore === "high" ? "🔴" : t.riskScore === "medium" ? "🟡" : "🟢";
  const chg = t.priceChange24h >= 0 ? `+${t.priceChange24h.toFixed(2)}%` : `${t.priceChange24h.toFixed(2)}%`;
  return [
    `${riskEmoji} *$${t.symbol}* — ${t.name}`,
    `📊 ${formatPrice(t.priceUsd)} · ${chg} (24h) · MC ${formatUsdShort(t.marketCap)} · Liq ${formatUsdShort(t.liquidityUsd)}`,
    t.risks.length > 0   ? `⚠️ ${t.risks.join(" · ")}` : "",
    t.signals.length > 0 ? `✅ ${t.signals.join(" · ")}` : "",
    `🔗 ${t.dexUrl}`,
  ].filter(Boolean).join("\n");
}
