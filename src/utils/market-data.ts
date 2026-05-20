import { logger } from "./logger.js";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const QUICKCHART_BASE = "https://quickchart.io/chart";

// Stablecoins & wrapped tokens to exclude from trending picks
const EXCLUDED_SYMBOLS = new Set([
  "usdt", "usdc", "dai", "busd", "tusd", "usdd", "frax", "fdusd", "pyusd",
  "wbtc", "weth", "steth", "wsteth", "reth", "cbeth",
]);

export interface CoinMarketData {
  id: string;
  symbol: string;
  name: string;
  currentPrice: number;
  marketCap: number;
  marketCapRank: number;
  priceChange24h: number;
  priceChangePercentage24h: number;
  priceChangePercentage7d: number | null;
  totalVolume: number;
  sparkline7d: number[];
}

export interface GlobalMarketData {
  totalMarketCap: number;
  totalVolume24h: number;
  marketCapChangePercentage24h: number;
  btcDominance: number;
  ethDominance: number;
}

/** Fetch top coins by market cap, with 7d sparkline data */
export async function fetchTopCoins(limit = 20): Promise<CoinMarketData[]> {
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=true&price_change_percentage=24h,7d`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json() as any[];
    return data.map(c => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      currentPrice: c.current_price,
      marketCap: c.market_cap,
      marketCapRank: c.market_cap_rank,
      priceChange24h: c.price_change_24h,
      priceChangePercentage24h: c.price_change_percentage_24h ?? 0,
      priceChangePercentage7d: c.price_change_percentage_7d_in_currency ?? null,
      totalVolume: c.total_volume,
      sparkline7d: c.sparkline_in_7d?.price ?? [],
    }));
  } catch (err: any) {
    logger.error("market-data", `fetchTopCoins error: ${err.message}`);
    return [];
  }
}

/** Pick a trending coin from top 50, exclude stablecoins/wrapped */
export async function pickTrendingCoin(): Promise<CoinMarketData | null> {
  const coins = await fetchTopCoins(50);
  const eligible = coins.filter(c => !EXCLUDED_SYMBOLS.has(c.symbol.toLowerCase()));
  if (eligible.length === 0) return null;

  // Weight: higher absolute 24h change = more likely to pick (trending = high volatility)
  // But always keep BTC/ETH in the rotation as safe picks
  const weighted: { coin: CoinMarketData; weight: number }[] = eligible.map(c => {
    const absChange = Math.abs(c.priceChangePercentage24h);
    let weight = 1 + absChange; // base weight from volatility
    if (c.symbol === "btc" || c.symbol === "eth") weight += 5; // always-eligible bias
    return { coin: c, weight };
  });

  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const w of weighted) {
    rand -= w.weight;
    if (rand <= 0) return w.coin;
  }
  return eligible[0];
}

/** Fetch global crypto market overview */
export async function fetchGlobalMarket(): Promise<GlobalMarketData | null> {
  try {
    const res = await fetch(`${COINGECKO_BASE}/global`);
    if (!res.ok) throw new Error(`CoinGecko global ${res.status}`);
    const data = await res.json() as any;
    const d = data.data;
    return {
      totalMarketCap: d.total_market_cap?.usd ?? 0,
      totalVolume24h: d.total_volume?.usd ?? 0,
      marketCapChangePercentage24h: d.market_cap_change_percentage_24h_usd ?? 0,
      btcDominance: d.market_cap_percentage?.btc ?? 0,
      ethDominance: d.market_cap_percentage?.eth ?? 0,
    };
  } catch (err: any) {
    logger.error("market-data", `fetchGlobalMarket error: ${err.message}`);
    return null;
  }
}

/** Fetch Fear & Greed Index (alternative.me, free, no key) */
export async function fetchFearGreedIndex(): Promise<{ value: number; classification: string } | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!res.ok) return null;
    const data = await res.json() as any;
    const item = data?.data?.[0];
    if (!item) return null;
    return {
      value: parseInt(item.value, 10),
      classification: item.value_classification,
    };
  } catch (err: any) {
    logger.error("market-data", `fetchFearGreedIndex error: ${err.message}`);
    return null;
  }
}

/** Generate a price chart image URL via QuickChart (free, no key) */
export function buildPriceChartUrl(
  coinName: string,
  prices: number[],
  options: { width?: number; height?: number; bgColor?: string } = {}
): string {
  const { width = 800, height = 400, bgColor = "white" } = options;
  if (!prices || prices.length === 0) return "";

  // Downsample if too many points
  const maxPoints = 100;
  let series = prices;
  if (prices.length > maxPoints) {
    const step = Math.ceil(prices.length / maxPoints);
    series = prices.filter((_, i) => i % step === 0);
  }

  const labels = series.map((_, i) => i.toString());
  const isUp = series[series.length - 1] >= series[0];
  const lineColor = isUp ? "rgb(34,197,94)" : "rgb(239,68,68)";
  const fillColor = isUp ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)";

  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `${coinName} — 7D Price (USD)`,
        data: series,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.3,
      }],
    },
    options: {
      plugins: {
        legend: { display: true, labels: { font: { size: 14, weight: "bold" } } },
        title: {
          display: true,
          text: `${coinName} 7-Day Price Action`,
          font: { size: 18, weight: "bold" },
        },
      },
      scales: {
        x: { display: false },
        y: { ticks: { font: { size: 12 } } },
      },
    },
  };

  const params = new URLSearchParams({
    c: JSON.stringify(chartConfig),
    w: width.toString(),
    h: height.toString(),
    bkg: bgColor,
    f: "png",
  });
  return `${QUICKCHART_BASE}?${params.toString()}`;
}

/** Build a multi-coin comparison bar chart (used for market recap) */
export function buildMarketRecapChartUrl(coins: CoinMarketData[]): string {
  const top = coins.slice(0, 8);
  const labels = top.map(c => c.symbol.toUpperCase());
  const data = top.map(c => Number(c.priceChangePercentage24h.toFixed(2)));
  const colors = data.map(v => v >= 0 ? "rgba(34,197,94,0.85)" : "rgba(239,68,68,0.85)");

  const chartConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: "24h Change (%)", data, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: "Top Crypto — 24h Performance", font: { size: 18, weight: "bold" } },
      },
      scales: {
        y: { ticks: { font: { size: 12 }, callback: "function(v){return v+'%';}" } },
        x: { ticks: { font: { size: 13, weight: "bold" } } },
      },
    },
  };

  const params = new URLSearchParams({
    c: JSON.stringify(chartConfig),
    w: "800",
    h: "450",
    bkg: "white",
    f: "png",
  });
  return `${QUICKCHART_BASE}?${params.toString()}`;
}

/** Build a chart-pattern educational illustration (synthetic OHLC) */
export function buildPatternIllustrationUrl(patternName: string, prices: number[]): string {
  const labels = prices.map((_, i) => i.toString());

  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: patternName,
        data: prices,
        borderColor: "rgb(59,130,246)",
        backgroundColor: "rgba(59,130,246,0.1)",
        fill: true,
        pointRadius: 0,
        borderWidth: 2.5,
        tension: 0.4,
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: patternName, font: { size: 20, weight: "bold" } },
      },
      scales: { x: { display: false }, y: { display: false } },
    },
  };

  const params = new URLSearchParams({
    c: JSON.stringify(chartConfig),
    w: "800",
    h: "400",
    bkg: "white",
    f: "png",
  });
  return `${QUICKCHART_BASE}?${params.toString()}`;
}

export function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(6)}`;
}
