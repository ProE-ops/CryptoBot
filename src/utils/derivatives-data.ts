/**
 * Crypto derivatives & on-chain context data.
 * Uses Binance public futures API (no key required) + Coinglass (optional, with key).
 * All endpoints used here are FREE.
 */

import { config } from "../config.js";
import { logger } from "./logger.js";

// ===== TYPES =====

export interface FundingRateData {
  symbol: string;
  fundingRate: number;       // current funding rate (e.g. 0.0001 = 0.01%)
  fundingRatePercent: number; // already in % (e.g. 0.01)
  markPrice: number;
  nextFundingTime: number;   // unix ms
}

export interface OpenInterestData {
  symbol: string;
  openInterest: number;      // contracts
  openInterestUsd: number;   // approx USD value
  timestamp: number;
}

export interface LiquidationSnapshot {
  symbol: string;
  longLiq24h: number;       // USD liquidated longs in last 24h
  shortLiq24h: number;
  totalLiq24h: number;
}

export interface DerivativesSnapshot {
  funding: FundingRateData[];
  oi: OpenInterestData[];
  topLongLiq: LiquidationSnapshot[];
  topShortLiq: LiquidationSnapshot[];
}

// ===== BINANCE PUBLIC API (no key) =====

const BINANCE_FAPI = "https://fapi.binance.com";

const TOP_PERPS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];

/** Pull current funding rates for top perp pairs. */
export async function fetchFundingRates(): Promise<FundingRateData[]> {
  try {
    const url = `${BINANCE_FAPI}/fapi/v1/premiumIndex`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance funding ${res.status}`);
    const data = await res.json() as any[];

    return data
      .filter(d => TOP_PERPS.includes(d.symbol))
      .map(d => ({
        symbol: d.symbol.replace("USDT", ""),
        fundingRate: parseFloat(d.lastFundingRate),
        fundingRatePercent: parseFloat(d.lastFundingRate) * 100,
        markPrice: parseFloat(d.markPrice),
        nextFundingTime: d.nextFundingTime,
      }));
  } catch (err: any) {
    logger.warn("derivatives", `fetchFundingRates failed: ${err.message}`);
    return [];
  }
}

/** Pull open interest snapshot for top perps. */
export async function fetchOpenInterest(): Promise<OpenInterestData[]> {
  try {
    const results = await Promise.all(
      TOP_PERPS.slice(0, 5).map(async (symbol) => {
        try {
          const [oiRes, priceRes] = await Promise.all([
            fetch(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${symbol}`),
            fetch(`${BINANCE_FAPI}/fapi/v1/ticker/price?symbol=${symbol}`),
          ]);
          if (!oiRes.ok || !priceRes.ok) return null;
          const oi = await oiRes.json() as any;
          const price = await priceRes.json() as any;
          const oiAmount = parseFloat(oi.openInterest);
          const priceVal = parseFloat(price.price);
          return {
            symbol: symbol.replace("USDT", ""),
            openInterest: oiAmount,
            openInterestUsd: oiAmount * priceVal,
            timestamp: oi.time || Date.now(),
          };
        } catch { return null; }
      })
    );
    return results.filter(Boolean) as OpenInterestData[];
  } catch (err: any) {
    logger.warn("derivatives", `fetchOpenInterest failed: ${err.message}`);
    return [];
  }
}

// ===== COINGLASS (optional, needs key) =====

/** Fetch 24h liquidation breakdown across major coins. Requires COINGLASS_API_KEY. */
export async function fetchLiquidations24h(): Promise<LiquidationSnapshot[]> {
  if (!config.COINGLASS_API_KEY) return [];

  try {
    const url = "https://open-api-v3.coinglass.com/api/futures/liquidation/v2?timeType=h24&exchange=Binance";
    const res = await fetch(url, {
      headers: { "CG-API-KEY": config.COINGLASS_API_KEY },
    });
    if (!res.ok) throw new Error(`Coinglass ${res.status}`);
    const data = await res.json() as any;
    if (data.code !== "0" || !Array.isArray(data.data)) return [];

    return data.data
      .slice(0, 10)
      .map((d: any) => ({
        symbol: d.symbol || "",
        longLiq24h: parseFloat(d.longVolUsd || 0),
        shortLiq24h: parseFloat(d.shortVolUsd || 0),
        totalLiq24h: parseFloat(d.longVolUsd || 0) + parseFloat(d.shortVolUsd || 0),
      }));
  } catch (err: any) {
    logger.warn("derivatives", `fetchLiquidations failed: ${err.message}`);
    return [];
  }
}

// ===== AGGREGATE =====

export async function fetchDerivativesSnapshot(): Promise<DerivativesSnapshot> {
  const [funding, oi, liquidations] = await Promise.all([
    fetchFundingRates(),
    fetchOpenInterest(),
    fetchLiquidations24h(),
  ]);

  const topLongLiq = [...liquidations]
    .sort((a, b) => b.longLiq24h - a.longLiq24h)
    .slice(0, 5);
  const topShortLiq = [...liquidations]
    .sort((a, b) => b.shortLiq24h - a.shortLiq24h)
    .slice(0, 5);

  return { funding, oi, topLongLiq, topShortLiq };
}

// ===== FORMATTERS =====

export function formatFundingSummary(rates: FundingRateData[]): string {
  if (rates.length === 0) return "";
  const sorted = [...rates].sort((a, b) => Math.abs(b.fundingRatePercent) - Math.abs(a.fundingRatePercent));
  const lines = sorted.slice(0, 5).map(r => {
    const sign = r.fundingRatePercent >= 0 ? "+" : "";
    const flag = r.fundingRatePercent > 0.05 ? " 🔥(overheated long)"
               : r.fundingRatePercent < -0.05 ? " ❄️(overheated short)"
               : "";
    return `  ${r.symbol}: ${sign}${r.fundingRatePercent.toFixed(4)}%${flag}`;
  });
  return "Funding rates (1h):\n" + lines.join("\n");
}

export function formatOiSummary(ois: OpenInterestData[]): string {
  if (ois.length === 0) return "";
  const lines = ois.map(o =>
    `  ${o.symbol}: $${(o.openInterestUsd / 1e9).toFixed(2)}B OI`
  );
  return "Open Interest:\n" + lines.join("\n");
}

export function formatLiquidationSummary(snap: DerivativesSnapshot): string {
  if (snap.topLongLiq.length === 0) return "";
  const totalLong = snap.topLongLiq.reduce((s, x) => s + x.longLiq24h, 0);
  const totalShort = snap.topShortLiq.reduce((s, x) => s + x.shortLiq24h, 0);
  return `Liquidations 24h: Longs $${(totalLong / 1e6).toFixed(1)}M | Shorts $${(totalShort / 1e6).toFixed(1)}M`;
}

export function formatDerivativesContext(snap: DerivativesSnapshot): string {
  return [
    formatFundingSummary(snap.funding),
    formatOiSummary(snap.oi),
    formatLiquidationSummary(snap),
  ].filter(Boolean).join("\n\n");
}
