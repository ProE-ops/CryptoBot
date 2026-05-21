/**
 * Real chart screenshots via chart-img.com (TradingView wrapper).
 * Falls back gracefully when CHARTIMG_API_KEY is not configured.
 *
 * Pricing (chart-img.com):
 *   - Free:  100 requests/month  (~3 posts/day)
 *   - Basic: $9/month → 5,000 requests
 *
 * Endpoints used:
 *   - /v2/tradingview/advanced-chart  → TradingView quality chart for known symbols
 *   - /v2/url/screenshot               → screenshot ANY URL (used for Dexscreener tokens)
 */

import { config } from "../config.js";

const CHARTIMG_TV   = "https://api.chart-img.com/v2/tradingview/advanced-chart";
const CHARTIMG_URL  = "https://api.chart-img.com/v2/url/screenshot";

// Symbols known to be on Binance — chart-img TradingView works perfectly with `BINANCE:` prefix.
// Anything else we route to Dexscreener.
const BINANCE_SYMBOLS = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "TRX", "DOT",
  "MATIC", "LINK", "ATOM", "LTC", "BCH", "ETC", "NEAR", "FIL", "APT", "ARB",
  "OP", "SUI", "INJ", "TIA", "STX", "FET", "RNDR", "RUNE", "AAVE", "MKR",
  "UNI", "CRV", "LDO", "FTM", "ALGO", "ICP", "HBAR", "VET", "XLM", "EOS",
  "AXS", "SAND", "MANA", "GMX", "DYDX", "PEPE", "SHIB", "WIF", "BONK", "FLOKI",
  "JUP", "PYTH", "JTO", "ORDI", "SEI", "BLUR", "ENA", "ETHFI", "STRK", "W",
  "ZRO", "NOT", "MEME", "TON", "TAO",
]);

/** Convert "BTC" or "$btc" or "BTCUSDT" → "BTCUSDT" suitable for TradingView. */
function normalizeSymbol(raw: string): string {
  const upper = raw.toUpperCase().replace(/[\$#@]/g, "").trim();
  if (upper.endsWith("USDT") || upper.endsWith("USD")) return upper;
  return `${upper}USDT`;
}

/** Returns true if the coin is liquid enough on Binance for TradingView chart to look populated. */
export function isMajorSymbol(coin: string): boolean {
  const upper = coin.toUpperCase().replace(/[\$#@]/g, "").trim();
  const base = upper.replace(/USDT?$/, "");
  return BINANCE_SYMBOLS.has(base);
}

// ===== TRADINGVIEW ADVANCED CHART =====

export interface TVChartOptions {
  symbol: string;                 // "BTC", "ETHUSDT", etc.
  exchange?: string;              // default "BINANCE"
  interval?: "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1D" | "1W";
  theme?: "light" | "dark";
  studies?: string[];             // e.g. ["RSI", "MACD"]
  width?: number;
  height?: number;
}

/**
 * Build a TradingView chart screenshot URL. Returns null when CHARTIMG_API_KEY is missing.
 * The caller should fall back to QuickChart in that case.
 */
export function buildTradingViewChart(opts: TVChartOptions): string | null {
  if (!config.CHARTIMG_API_KEY) return null;

  const symbol = `${opts.exchange || "BINANCE"}:${normalizeSymbol(opts.symbol)}`;
  const params = new URLSearchParams({
    symbol,
    interval: opts.interval || "4h",
    theme:    opts.theme    || "dark",
    width:    String(opts.width  || 1280),
    height:   String(opts.height || 720),
  });
  for (const study of opts.studies || ["RSI", "MACD"]) {
    params.append("studies", study);
  }

  // chart-img accepts API key as query OR header. Query is simpler for image URL embedding.
  params.set("key", config.CHARTIMG_API_KEY);
  return `${CHARTIMG_TV}?${params.toString()}`;
}

// ===== URL SCREENSHOT (for Dexscreener tokens) =====

/**
 * Build a screenshot URL for Dexscreener token page. Returns null if no API key.
 * Dexscreener page rendered headlessly → real chart + liquidity data visible.
 */
export function buildDexscreenerScreenshot(chain: string, pairAddress: string): string | null {
  if (!config.CHARTIMG_API_KEY) return null;

  const target = `https://dexscreener.com/${chain}/${pairAddress}?embed=1&theme=dark&trades=0&info=0`;
  const params = new URLSearchParams({
    key:    config.CHARTIMG_API_KEY,
    url:    target,
    width:  "1280",
    height: "720",
    full_page: "false",
    delay:  "3",  // wait 3s for chart to render
  });
  return `${CHARTIMG_URL}?${params.toString()}`;
}

// ===== HEALTH CHECK =====

export function hasChartImg(): boolean {
  return !!config.CHARTIMG_API_KEY;
}
