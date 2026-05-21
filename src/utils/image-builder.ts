/**
 * Build branded chart/image URLs for synthesis posts.
 * Backend: QuickChart.io (free, URL-based, no API key needed).
 *
 * Image types:
 *   - coin_spotlight  → single coin price chart with 7d sparkline
 *   - market_overview → top movers bar chart (gainers/losers)
 *   - sentiment_gauge → Fear & Greed donut
 *   - funding_heatmap → funding rates per coin
 *   - none            → skip image
 */

import type { CoinMarketData } from "./market-data.js";
import type { FundingRateData } from "./derivatives-data.js";
import { buildTradingViewChart, buildDexscreenerScreenshot, isMajorSymbol, hasChartImg } from "./chart-screenshot.js";
import type { TokenAnalysis } from "./token-analyzer.js";

const QC_BASE = "https://quickchart.io/chart";
const BRAND_GREEN = "#16C784";
const BRAND_RED   = "#EA3943";
const BRAND_BG    = "#0E1525";
const BRAND_FG    = "#F8FAFC";
const BRAND_ACCENT = "#FFC83D";

function quickChartUrl(config: any, opts: { w?: number; h?: number; bg?: string } = {}): string {
  const { w = 800, h = 450, bg = BRAND_BG } = opts;
  const c = encodeURIComponent(JSON.stringify(config));
  return `${QC_BASE}?width=${w}&height=${h}&backgroundColor=${encodeURIComponent(bg)}&c=${c}`;
}

// ===== TYPE 1: COIN SPOTLIGHT =====
// Single coin sparkline chart with current price + 24h change annotated in title

export function buildCoinSpotlight(coin: CoinMarketData): string {
  const change = coin.priceChangePercentage24h;
  const lineColor = change >= 0 ? BRAND_GREEN : BRAND_RED;
  const arrow = change >= 0 ? "▲" : "▼";
  const sign = change >= 0 ? "+" : "";
  const price = coin.currentPrice >= 1
    ? `$${coin.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : `$${coin.currentPrice.toFixed(6)}`;

  const config = {
    type: "line",
    data: {
      labels: coin.sparkline7d.map((_, i) => i),
      datasets: [{
        data: coin.sparkline7d,
        borderColor: lineColor,
        backgroundColor: lineColor + "33",  // 20% opacity
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 3,
      }],
    },
    options: {
      title: {
        display: true,
        text: [
          `${coin.symbol.toUpperCase()} · ${price}`,
          `${arrow} ${sign}${change.toFixed(2)}% (24h)  ·  7d trend`,
        ],
        fontColor: BRAND_FG,
        fontSize: 22,
        fontStyle: "bold",
        padding: 20,
      },
      legend: { display: false },
      scales: {
        xAxes: [{ display: false, gridLines: { display: false } }],
        yAxes: [{ display: false, gridLines: { display: false } }],
      },
      layout: { padding: { top: 20, bottom: 20, left: 20, right: 20 } },
    },
  };
  return quickChartUrl(config);
}

// ===== TYPE 2: MARKET OVERVIEW =====
// Bar chart showing top movers (gainers + losers)

export function buildMarketOverview(coins: CoinMarketData[]): string {
  const filtered = coins.filter(c => !["usdt", "usdc", "dai", "busd"].includes(c.symbol.toLowerCase()));
  const sorted = [...filtered].sort((a, b) => b.priceChangePercentage24h - a.priceChangePercentage24h);
  const top4 = sorted.slice(0, 4);
  const bot4 = sorted.slice(-4).reverse();
  const display = [...top4, ...bot4];

  const config = {
    type: "horizontalBar",
    data: {
      labels: display.map(c => c.symbol.toUpperCase()),
      datasets: [{
        data: display.map(c => c.priceChangePercentage24h),
        backgroundColor: display.map(c => c.priceChangePercentage24h >= 0 ? BRAND_GREEN : BRAND_RED),
        borderWidth: 0,
      }],
    },
    options: {
      title: {
        display: true,
        text: "Top Movers · 24h Change",
        fontColor: BRAND_FG,
        fontSize: 22,
        fontStyle: "bold",
        padding: 16,
      },
      legend: { display: false },
      plugins: {
        datalabels: {
          color: BRAND_FG,
          font: { weight: "bold", size: 12 },
          formatter: (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`,
          anchor: "end",
          align: "end",
        },
      },
      scales: {
        xAxes: [{ ticks: { fontColor: BRAND_FG + "AA" }, gridLines: { color: "#FFFFFF11" } }],
        yAxes: [{ ticks: { fontColor: BRAND_FG, fontStyle: "bold", fontSize: 13 }, gridLines: { display: false } }],
      },
    },
  };
  return quickChartUrl(config);
}

// ===== TYPE 3: SENTIMENT GAUGE =====
// Doughnut chart visualising Fear & Greed Index

export function buildSentimentGauge(value: number, classification: string): string {
  // F&G color zones: 0-25 red (extreme fear), 25-45 orange, 45-55 yellow, 55-75 lightgreen, 75-100 green
  const color = value < 25 ? "#EA3943"
              : value < 45 ? "#F4982A"
              : value < 55 ? BRAND_ACCENT
              : value < 75 ? "#7FBA00"
              :              BRAND_GREEN;

  const config = {
    type: "doughnut",
    data: {
      datasets: [{
        data: [value, 100 - value],
        backgroundColor: [color, "#FFFFFF11"],
        borderWidth: 0,
      }],
    },
    options: {
      cutoutPercentage: 75,
      circumference: Math.PI,
      rotation: -Math.PI,
      legend: { display: false },
      title: {
        display: true,
        text: [`Fear & Greed Index`, `${value} / 100 — ${classification}`],
        fontColor: BRAND_FG,
        fontSize: 22,
        fontStyle: "bold",
        padding: 16,
      },
      plugins: {
        doughnutlabel: {
          labels: [{ text: String(value), font: { size: 60, weight: "bold" }, color: BRAND_FG }],
        },
      },
    },
  };
  return quickChartUrl(config, { h: 400 });
}

// ===== TYPE 4: FUNDING HEATMAP =====

export function buildFundingHeatmap(funding: FundingRateData[]): string {
  if (funding.length === 0) return "";
  const sorted = [...funding].sort((a, b) => b.fundingRatePercent - a.fundingRatePercent);

  const config = {
    type: "horizontalBar",
    data: {
      labels: sorted.map(f => f.symbol),
      datasets: [{
        data: sorted.map(f => f.fundingRatePercent),
        backgroundColor: sorted.map(f =>
          f.fundingRatePercent > 0.05  ? "#FF4D4D"          // hot longs
          : f.fundingRatePercent > 0   ? BRAND_GREEN
          : f.fundingRatePercent > -0.05 ? "#5BC0F8"        // mild shorts
          :                                BRAND_RED        // hot shorts
        ),
        borderWidth: 0,
      }],
    },
    options: {
      title: {
        display: true,
        text: "Funding Rates (1h) · 🔴 longs pay  🔵 shorts pay",
        fontColor: BRAND_FG,
        fontSize: 20,
        fontStyle: "bold",
        padding: 16,
      },
      legend: { display: false },
      plugins: {
        datalabels: {
          color: BRAND_FG,
          font: { weight: "bold", size: 11 },
          formatter: (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}%`,
          anchor: "end",
          align: "end",
        },
      },
      scales: {
        xAxes: [{ ticks: { fontColor: BRAND_FG + "AA" }, gridLines: { color: "#FFFFFF11" } }],
        yAxes: [{ ticks: { fontColor: BRAND_FG, fontStyle: "bold" }, gridLines: { display: false } }],
      },
    },
  };
  return quickChartUrl(config);
}

// ===== DISPATCHER =====
// Decide which image to build based on AI hint + available data

export type ImageType = "coin_spotlight" | "market_overview" | "sentiment_gauge" | "funding_heatmap" | "token_dex" | "none";

export interface ImageBuildContext {
  imageType: ImageType;
  primaryCoin: string | null;
  topCoins: CoinMarketData[];
  funding: FundingRateData[];
  fng?: { value: number; classification: string };
  tokens?: TokenAnalysis[];  // for token_dex type — uses highest-liquidity token
}

/**
 * Picks the best image URL for a synthesis post.
 * Priority: real chart screenshots (chart-img.com) → QuickChart fallback.
 */
export function pickSynthesisImage(ctx: ImageBuildContext): string {
  switch (ctx.imageType) {
    case "coin_spotlight": {
      const primary = ctx.primaryCoin || "";

      // Tier 1: chart-img TradingView for major Binance-listed coins
      if (hasChartImg() && primary && isMajorSymbol(primary)) {
        const url = buildTradingViewChart({ symbol: primary, interval: "4h", studies: ["RSI"] });
        if (url) return url;
      }

      // Tier 2: QuickChart sparkline from CoinGecko 7d data
      const coin = ctx.topCoins.find(c => c.symbol.toUpperCase() === primary.toUpperCase());
      if (coin && coin.sparkline7d.length > 0) return buildCoinSpotlight(coin);

      // Tier 3: fallback to market overview
      return buildMarketOverview(ctx.topCoins);
    }

    case "token_dex": {
      // For tokens dropped by KOLs — screenshot the Dexscreener page directly
      const top = (ctx.tokens || [])
        .slice()
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
      if (top && hasChartImg()) {
        const url = buildDexscreenerScreenshot(top.chain, top.pairAddress);
        if (url) return url;
      }
      // Fallback: market overview if no chart-img key
      return ctx.topCoins.length > 0 ? buildMarketOverview(ctx.topCoins) : "";
    }

    case "market_overview":
      return ctx.topCoins.length > 0 ? buildMarketOverview(ctx.topCoins) : "";
    case "sentiment_gauge":
      return ctx.fng ? buildSentimentGauge(ctx.fng.value, ctx.fng.classification) : "";
    case "funding_heatmap":
      return ctx.funding.length > 0 ? buildFundingHeatmap(ctx.funding) : "";
    case "none":
    default:
      return "";
  }
}
