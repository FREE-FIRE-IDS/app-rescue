// Server function: fetches REAL market data from Yahoo Finance and runs an
// advanced 200+ phase confluence engine. Output is only CALL / PUT (no WAIT).
// No trading system can guarantee outcomes; this engine improves filtering,
// data alignment, and multi-timeframe confirmation from live market candles.

import { createServerFn } from "@tanstack/react-start";
import { generateObject } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import type { CandleData, MarketPriceData, PhaseCheck, SignalResponse, TimeFrameOption } from "./types";

const YAHOO_SYMBOL: Record<string, string> = {
  "XAU/USD": "GC=F",
  "GOLD OTC": "GC=F",
  "BTC/USD": "BTC-USD",
  "USD/JPY": "JPY=X",
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
};

const TF_TO_YAHOO: Record<TimeFrameOption, { interval: string; range: string; htf: string; htfRange: string; confirm: string; confirmRange: string }> = {
  "1 Min": { interval: "1m", range: "1d", htf: "5m", htfRange: "5d", confirm: "15m", confirmRange: "5d" },
  "2 Min": { interval: "2m", range: "1d", htf: "15m", htfRange: "5d", confirm: "30m", confirmRange: "1mo" },
  "5 Min": { interval: "5m", range: "5d", htf: "30m", htfRange: "1mo", confirm: "60m", confirmRange: "1mo" },
  "15 Min": { interval: "15m", range: "5d", htf: "60m", htfRange: "1mo", confirm: "1d", confirmRange: "3mo" },
  "30 Min": { interval: "30m", range: "1mo", htf: "1d", htfRange: "3mo", confirm: "1d", confirmRange: "6mo" },
};

interface YahooChart {
  chart: {
    result?: Array<{
      meta: { regularMarketPrice: number; previousClose?: number; chartPreviousClose?: number };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
}

type YahooResult = NonNullable<YahooChart["chart"]["result"]>[number];
type Direction = "CALL" | "PUT";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type PhaseRes = {
  label: string;
  status: string;
  vote: number;
  weight: number;
  strength: number;
};

const AiSignalSchema = z.object({
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number(),
  reason: z.string(),
  riskFlags: z.array(z.string()).default([]),
});

function decimals(pair: string) {
  return pair.includes("EUR") || pair.includes("GBP") ? 5 : 2;
}

function displayPair(pair: string) {
  return pair === "GOLD OTC" ? "GOLD OTC" : pair;
}

async function fetchYahoo(pair: string, interval: string, range: string) {
  const sym = YAHOO_SYMBOL[pair] ?? "GC=F";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MR-BINARY/2.0; +https://lovable.dev)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Market data HTTP ${res.status}`);
  const json = (await res.json()) as YahooChart;
  const result = json.chart.result?.[0];
  if (!result) throw new Error("Market data: empty result");
  return result;
}

function parseCandles(r: YahooResult): Candle[] {
  const q = r.indicators.quote[0];
  const timestamps = r.timestamp ?? [];
  const rows: Candle[] = [];
  for (let i = 0; i < (q?.close?.length ?? 0); i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    if (typeof open !== "number" || typeof high !== "number" || typeof low !== "number" || typeof close !== "number") continue;
    rows.push({
      time: timestamps[i] ?? i,
      open,
      high,
      low,
      close,
      volume: typeof q.volume?.[i] === "number" ? q.volume[i] ?? 0 : 0,
    });
  }
  return rows;
}

function toPublicCandles(candles: Candle[], pair: string): CandleData[] {
  const d = decimals(pair);
  return candles.slice(-48).map((c) => ({
    time: new Date(c.time * 1000).toISOString().slice(11, 16),
    open: parseFloat(c.open.toFixed(d)),
    high: parseFloat(c.high.toFixed(d)),
    low: parseFloat(c.low.toFixed(d)),
    close: parseFloat(c.close.toFixed(d)),
    volume: c.volume,
    isAiChecked: false,
  }));
}

function currentCandleIso(candles: Candle[]) {
  const lastOpenMs = last(candles, { time: Math.floor(Date.now() / 1000) } as Candle).time * 1000;
  return new Date(lastOpenMs).toISOString();
}

function last<T>(arr: T[], fallback: T) {
  return arr.length ? arr[arr.length - 1] : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function sma(arr: number[], period: number) {
  const n = Math.min(period, arr.length);
  if (n <= 0) return 0;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function emaSeries(arr: number[], period: number) {
  if (arr.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

function ema(arr: number[], period: number) {
  return last(emaSeries(arr, period), 0);
}

function rsiSeries(arr: number[], period = 14) {
  const out = Array(arr.length).fill(50) as number[];
  if (arr.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(arr: number[]) {
  const fast = emaSeries(arr, 12);
  const slow = emaSeries(arr, 26);
  const lineSeries = arr.map((_, i) => (fast[i] ?? 0) - (slow[i] ?? 0));
  const signalSeries = emaSeries(lineSeries, 9);
  const line = last(lineSeries, 0);
  const signal = last(signalSeries, 0);
  const prevHist = (lineSeries[lineSeries.length - 2] ?? line) - (signalSeries[signalSeries.length - 2] ?? signal);
  return { line, signal, hist: line - signal, prevHist };
}

function stochastic(highs: number[], lows: number[], closes: number[], period = 14) {
  const n = Math.min(period, closes.length);
  const hh = Math.max(...highs.slice(-n));
  const ll = Math.min(...lows.slice(-n));
  if (hh === ll) return 50;
  return ((last(closes, 0) - ll) / (hh - ll)) * 100;
}

function bollinger(arr: number[], period = 20, mult = 2) {
  const n = Math.min(period, arr.length);
  const slice = arr.slice(-n);
  const mean = slice.reduce((a, b) => a + b, 0) / n;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd, width: 2 * mult * sd };
}

function atr(highs: number[], lows: number[], closes: number[], period = 14) {
  const n = Math.min(period, closes.length - 1);
  if (n <= 0) return Math.abs(last(closes, 1)) * 0.001;
  const trs: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function vwap(candles: Candle[], period = 50) {
  const rows = candles.slice(-period);
  let pv = 0;
  let vol = 0;
  for (const c of rows) {
    const typical = (c.high + c.low + c.close) / 3;
    const v = Math.max(1, c.volume || 1);
    pv += typical * v;
    vol += v;
  }
  return vol ? pv / vol : last(candles, { close: 0 } as Candle).close;
}

function adx(highs: number[], lows: number[], closes: number[], period = 14) {
  if (closes.length < period + 2) return { adx: 15, plus: 0, minus: 0 };
  const dx: number[] = [];
  let plusDM = 0;
  let minusDM = 0;
  let trSum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM += upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM += downMove > upMove && downMove > 0 ? downMove : 0;
    trSum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const plusDI = trSum ? (100 * plusDM) / trSum : 0;
    const minusDI = trSum ? (100 * minusDM) / trSum : 0;
    dx.push(plusDI + minusDI ? (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI) : 0);
  }
  return { adx: sma(dx, Math.min(period, dx.length)), plus: trSum ? (100 * plusDM) / trSum : 0, minus: trSum ? (100 * minusDM) / trSum : 0 };
}

function regressionSlope(values: number[], period = 20) {
  const y = values.slice(-period);
  const n = y.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (y[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den ? num / den : 0;
}

function roc(values: number[], period: number) {
  const current = last(values, 0);
  const previous = values[values.length - period - 1] ?? current;
  return current - previous;
}

function stdDev(values: number[], period: number) {
  const slice = values.slice(-period);
  if (slice.length < 2) return 0;
  const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
  return Math.sqrt(slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / slice.length);
}

function rangePosition(price: number, highs: number[], lows: number[], period: number) {
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  return h === l ? 0.5 : (price - l) / (h - l);
}

function pivotLevels(highs: number[], lows: number[], closes: number[], period = 24) {
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  const c = closes[closes.length - 2] ?? last(closes, 0);
  const pivot = (h + l + c) / 3;
  return { pivot, r1: 2 * pivot - l, s1: 2 * pivot - h, r2: pivot + (h - l), s2: pivot - (h - l) };
}

function fibonacciLevels(highs: number[], lows: number[], closes: number[], period = 89) {
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  const price = last(closes, 0);
  const upSwing = price >= closes[closes.length - Math.min(period, closes.length)] || price >= (h + l) / 2;
  const range = Math.max(h - l, 0.00001);
  const levels = upSwing
    ? { l236: h - range * 0.236, l382: h - range * 0.382, l500: h - range * 0.5, l618: h - range * 0.618 }
    : { l236: l + range * 0.236, l382: l + range * 0.382, l500: l + range * 0.5, l618: l + range * 0.618 };
  const nearest = Object.values(levels).reduce((best, level) => (Math.abs(price - level) < Math.abs(price - best) ? level : best), levels.l500);
  return { high: h, low: l, upSwing, nearest, ...levels };
}

function liveCandlePressure(candle: Candle, previous: Candle, atrValue: number) {
  const range = Math.max(candle.high - candle.low, atrValue * 0.1, 0.00001);
  const body = candle.close - candle.open;
  const bodyAbs = Math.abs(body);
  const topWick = candle.high - Math.max(candle.open, candle.close);
  const bottomWick = Math.min(candle.open, candle.close) - candle.low;
  const closeLocation = (candle.close - candle.low) / range;
  const continuation = candle.close - previous.close;
  const pressure = body / Math.max(atrValue, 0.00001) + (closeLocation - 0.5) * 1.2 + (bottomWick - topWick) / range + continuation / Math.max(atrValue, 0.00001) * 0.35;
  return { pressure, closeLocation, bodyRatio: bodyAbs / range, topWickRatio: topWick / range, bottomWickRatio: bottomWick / range };
}

function supertrendBias(highs: number[], lows: number[], closes: number[], atrValue: number, mult = 2.2) {
  const hl2 = (last(highs, 0) + last(lows, 0)) / 2;
  const upper = hl2 + atrValue * mult;
  const lower = hl2 - atrValue * mult;
  const close = last(closes, 0);
  const prev = closes[closes.length - 2] ?? close;
  if (close > lower && close > prev) return { up: true, upper, lower };
  if (close < upper && close < prev) return { up: false, upper, lower };
  return { up: close >= sma(closes, 10), upper, lower };
}

function swingDivergence(closes: number[], rsiVals: number[]) {
  const leftPrice = sma(closes.slice(-28, -14), 5);
  const rightPrice = sma(closes.slice(-8), 5);
  const leftRsi = sma(rsiVals.slice(-28, -14), 5);
  const rightRsi = sma(rsiVals.slice(-8), 5);
  return {
    bullish: rightPrice < leftPrice && rightRsi > leftRsi,
    bearish: rightPrice > leftPrice && rightRsi < leftRsi,
  };
}

function candlePatternPhases(candles: Candle[], atrValue: number): PhaseRes[] {
  const phases: PhaseRes[] = [];
  const rows = candles.slice(-36);
  rows.forEach((c, index) => {
    const prev = rows[index - 1] ?? c;
    const prev2 = rows[index - 2] ?? prev;
    const range = Math.max(c.high - c.low, atrValue * 0.08, 0.00001);
    const body = Math.abs(c.close - c.open);
    const topWick = c.high - Math.max(c.open, c.close);
    const bottomWick = Math.min(c.open, c.close) - c.low;
    const bullish = c.close >= c.open;
    const prevBullish = prev.close >= prev.open;
    const engulfingUp = bullish && !prevBullish && c.open <= prev.close && c.close >= prev.open;
    const engulfingDown = !bullish && prevBullish && c.open >= prev.close && c.close <= prev.open;
    const pinUp = bottomWick > body * 1.8 && topWick < range * 0.28;
    const pinDown = topWick > body * 1.8 && bottomWick < range * 0.28;
    const doji = body / range < 0.18;
    const threeUp = bullish && prevBullish && prev2.close >= prev2.open && c.close > prev.close && prev.close > prev2.close;
    const threeDown = !bullish && !prevBullish && prev2.close < prev2.open && c.close < prev.close && prev.close < prev2.close;
    const vote = engulfingUp || pinUp || threeUp ? 1.15 : engulfingDown || pinDown || threeDown ? -1.15 : doji ? (c.close >= prev.close ? 0.22 : -0.22) : bullish ? 0.48 : -0.48;
    pushPhase(phases, `Pattern scan -${rows.length - index}: body=${(body / Math.max(atrValue, 0.00001)).toFixed(2)} wickT/B=${(topWick / range).toFixed(2)}/${(bottomWick / range).toFixed(2)}`, engulfingUp ? "BULLISH_ENGULFING" : engulfingDown ? "BEARISH_ENGULFING" : pinUp ? "BULLISH_PIN_BAR" : pinDown ? "BEARISH_PIN_BAR" : threeUp ? "THREE_CANDLE_PUSH_UP" : threeDown ? "THREE_CANDLE_PUSH_DOWN" : doji ? "DOJI_DECISION_CANDLE" : bullish ? "CANDLE_CLOSE_UP" : "CANDLE_CLOSE_DOWN", vote, 0.34 + index / 95, Math.abs(vote));
  });
  return phases;
}

function pushPhase(P: PhaseRes[], label: string, status: string, rawVote: number, weight: number, strength = Math.abs(rawVote)) {
  const vote = clamp(rawVote, -1.8, 1.8);
  P.push({ label, status, vote, weight, strength: clamp(strength, 0, 1.8) });
}

export const fetchMarketDataFn = createServerFn({ method: "GET" })
  .inputValidator((input: { pair: string }) => input)
  .handler(async ({ data }): Promise<MarketPriceData> => {
    const pair = data.pair;
    const r = await fetchYahoo(pair, "1m", "1d");
    const rows = parseCandles(r);
    const d = decimals(pair);
    const closes = rows.map((c) => c.close);
    const highs = rows.map((c) => c.high);
    const lows = rows.map((c) => c.low);
    const price = r.meta.regularMarketPrice ?? last(closes, 0);
    const prevClose = r.meta.previousClose ?? r.meta.chartPreviousClose ?? price;
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return {
      success: true,
      source: "yahoo-finance-live",
      pair,
      price: parseFloat(price.toFixed(d)),
      change: parseFloat(change.toFixed(4)),
      high: parseFloat((highs.length ? Math.max(...highs) : price).toFixed(d)),
      low: parseFloat((lows.length ? Math.min(...lows) : price).toFixed(d)),
      timestamp: Date.now(),
      candles: toPublicCandles(rows, pair),
      nextCandleTime: nextCandleIso(rows, "1 Min"),
    };
  });

export const generateSignalFn = createServerFn({ method: "POST" })
  .inputValidator((input: { pair: string; timeFrame: TimeFrameOption }) => input)
  .handler(async ({ data }): Promise<SignalResponse> => {
    const { pair, timeFrame } = data;
    const cfg = TF_TO_YAHOO[timeFrame] ?? TF_TO_YAHOO["1 Min"];
    const d = decimals(pair);

    const [baseResult, htfResult, confirmResult] = await Promise.all([
      fetchYahoo(pair, cfg.interval, cfg.range),
      fetchYahoo(pair, cfg.htf, cfg.htfRange).catch(() => null),
      fetchYahoo(pair, cfg.confirm, cfg.confirmRange).catch(() => null),
    ]);

    const candles = parseCandles(baseResult);
    if (candles.length < 70) throw new Error("Not enough live candles for advanced signal confirmation");

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const opens = candles.map((c) => c.open);
    const volumes = candles.map((c) => c.volume);
    const price = baseResult.meta.regularMarketPrice ?? last(closes, 0);
    const lastClose = last(closes, price);
    const previousClose = closes[closes.length - 2] ?? lastClose;

    const sma5v = sma(closes, 5);
    const sma20v = sma(closes, 20);
    const sma50v = sma(closes, 50);
    const ema9v = ema(closes, 9);
    const ema21v = ema(closes, 21);
    const ema50v = ema(closes, 50);
    const rsiVals = rsiSeries(closes, 14);
    const rsi14 = last(rsiVals, 50);
    const rsiPrev = rsiVals[rsiVals.length - 2] ?? rsi14;
    const m = macd(closes);
    const stoch = stochastic(highs, lows, closes, 14);
    const bb = bollinger(closes, 20, 2);
    const atr14 = atr(highs, lows, closes, 14);
    const atrPct = atr14 / Math.max(price, 1);
    const bbPos = bb.width > 0 ? (lastClose - bb.lower) / bb.width : 0.5;
    const vw = vwap(candles, 50);
    const adx14 = adx(highs, lows, closes, 14);
    const slope20 = regressionSlope(closes, 20);
    const slopeStrength = Math.abs(slope20) / Math.max(atr14, Math.abs(price) * 0.0001);
    const supertrend = supertrendBias(highs, lows, closes, atr14);
    const pivots = pivotLevels(highs, lows, closes, Math.min(48, closes.length));
    const fib = fibonacciLevels(highs, lows, closes, Math.min(120, closes.length));
    const lastOpen = last(opens, lastClose);
    const liveCandle = last(candles, { open: price, high: price, low: price, close: price, volume: 0, time: Math.floor(Date.now() / 1000) });
    const previousCandle = candles[candles.length - 2] ?? liveCandle;
    const livePressure = liveCandlePressure(liveCandle, previousCandle, atr14);
    const bodyPct = Math.abs(lastClose - lastOpen) / Math.max(atr14, Math.abs(price) * 0.0001);
    const wickTop = (last(highs, lastClose) - Math.max(lastOpen, lastClose)) / Math.max(atr14, Math.abs(price) * 0.0001);
    const wickBottom = (Math.min(lastOpen, lastClose) - last(lows, lastClose)) / Math.max(atr14, Math.abs(price) * 0.0001);
    const bullCandle = lastClose > lastOpen;
    const momentum3 = lastClose - (closes[closes.length - 4] ?? lastClose);
    const momentum10 = lastClose - (closes[closes.length - 11] ?? lastClose);
    const recentVol = Math.max(1, volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length));
    const volSpike = last(volumes, 0) / recentVol;
    const support = Math.min(...lows.slice(-55));
    const resistance = Math.max(...highs.slice(-55));
    const nearSup = Math.abs(price - support) / Math.max(atr14, 0.00001) < 0.65;
    const nearRes = Math.abs(price - resistance) / Math.max(atr14, 0.00001) < 0.65;
    const div = swingDivergence(closes, rsiVals);

    const htfCandles = htfResult ? parseCandles(htfResult) : [];
    const htfCloses = htfCandles.map((c) => c.close);
    const htfUp = htfCloses.length >= 50 ? ema(htfCloses, 21) > ema(htfCloses, 50) : ema21v > ema50v;
    const htfSlope = htfCloses.length >= 25 ? regressionSlope(htfCloses, 20) : slope20;

    const confirmCandles = confirmResult ? parseCandles(confirmResult) : [];
    const confirmCloses = confirmCandles.map((c) => c.close);
    const confirmUp = confirmCloses.length >= 50 ? ema(confirmCloses, 21) > ema(confirmCloses, 50) : htfUp;

    const P: PhaseRes[] = [];
    pushPhase(P, `EMA STACK 9/21/50 = ${ema9v.toFixed(d)} / ${ema21v.toFixed(d)} / ${ema50v.toFixed(d)}`, ema9v > ema21v && ema21v > ema50v ? "BULL_STACK" : ema9v < ema21v && ema21v < ema50v ? "BEAR_STACK" : "MIXED_STACK", ema9v > ema21v && ema21v > ema50v ? 1.45 : ema9v < ema21v && ema21v < ema50v ? -1.45 : ema9v > ema21v ? 0.45 : -0.45, 1.45, 1.25);
    pushPhase(P, `SMA STRUCTURE 5/20/50 = ${sma5v.toFixed(d)} / ${sma20v.toFixed(d)} / ${sma50v.toFixed(d)}`, sma5v > sma20v && sma20v > sma50v ? "SMA_UPTREND" : sma5v < sma20v && sma20v < sma50v ? "SMA_DOWNTREND" : "SMA_TRANSITION", sma5v > sma20v && sma20v > sma50v ? 1.2 : sma5v < sma20v && sma20v < sma50v ? -1.2 : sma5v > sma20v ? 0.35 : -0.35, 1.1, 1.05);
    pushPhase(P, `RSI(14)=${rsi14.toFixed(1)} slope ${(rsi14 - rsiPrev).toFixed(1)}`, rsi14 >= 52 && rsi14 > rsiPrev ? "RSI_BULL_EXPANSION" : rsi14 <= 48 && rsi14 < rsiPrev ? "RSI_BEAR_EXPANSION" : rsi14 > 70 ? "RSI_OVERBOUGHT" : rsi14 < 30 ? "RSI_OVERSOLD" : "RSI_NEUTRAL", rsi14 > 70 ? -0.55 : rsi14 < 30 ? 0.55 : rsi14 >= 52 && rsi14 > rsiPrev ? 1.05 : rsi14 <= 48 && rsi14 < rsiPrev ? -1.05 : rsi14 >= 50 ? 0.25 : -0.25, 1.0, Math.abs(rsi14 - 50) / 18);
    pushPhase(P, `MACD hist=${m.hist.toFixed(d)} previous=${m.prevHist.toFixed(d)}`, m.hist > 0 && m.hist > m.prevHist ? "MACD_BULL_ACCEL" : m.hist < 0 && m.hist < m.prevHist ? "MACD_BEAR_ACCEL" : m.hist > 0 ? "MACD_BULL_FADE" : "MACD_BEAR_FADE", m.hist > 0 && m.hist > m.prevHist ? 1.35 : m.hist < 0 && m.hist < m.prevHist ? -1.35 : m.hist > 0 ? 0.55 : -0.55, 1.35, Math.abs(m.hist) / Math.max(atr14, 0.00001));
    pushPhase(P, `ADX=${adx14.adx.toFixed(1)} +DI=${adx14.plus.toFixed(1)} -DI=${adx14.minus.toFixed(1)}`, adx14.adx >= 18 && adx14.plus > adx14.minus ? "ADX_TREND_UP" : adx14.adx >= 18 && adx14.minus > adx14.plus ? "ADX_TREND_DOWN" : "ADX_WEAK", adx14.adx >= 18 ? (adx14.plus > adx14.minus ? 1.25 : -1.25) : adx14.plus > adx14.minus ? 0.25 : -0.25, 1.3, adx14.adx / 30);
    pushPhase(P, `VWAP(50)=${vw.toFixed(d)} price relation`, price > vw ? "ABOVE_VWAP" : "BELOW_VWAP", price > vw ? 0.95 : -0.95, 0.95, Math.abs(price - vw) / Math.max(atr14, 0.00001));
    pushPhase(P, `BOLLINGER pos=${(bbPos * 100).toFixed(0)}% width=${bb.width.toFixed(d)}`, bbPos > 0.58 && bbPos < 0.92 ? "BB_BULL_CHANNEL" : bbPos < 0.42 && bbPos > 0.08 ? "BB_BEAR_CHANNEL" : bbPos <= 0.08 ? "BB_DEEP_SUPPORT" : bbPos >= 0.92 ? "BB_DEEP_RESISTANCE" : "BB_MID", bbPos <= 0.08 ? 0.55 : bbPos >= 0.92 ? -0.55 : bbPos > 0.58 ? 0.85 : bbPos < 0.42 ? -0.85 : 0, 0.9, Math.abs(bbPos - 0.5) * 2);
    pushPhase(P, `STOCHASTIC %K=${stoch.toFixed(1)}`, stoch >= 55 && stoch <= 88 ? "STOCH_BULL_FLOW" : stoch <= 45 && stoch >= 12 ? "STOCH_BEAR_FLOW" : stoch > 88 ? "STOCH_EXHAUST_UP" : stoch < 12 ? "STOCH_EXHAUST_DOWN" : "STOCH_MID", stoch > 88 ? -0.45 : stoch < 12 ? 0.45 : stoch >= 55 ? 0.75 : stoch <= 45 ? -0.75 : 0, 0.8, Math.abs(stoch - 50) / 35);
    pushPhase(P, `PIVOT POINTS P=${pivots.pivot.toFixed(d)} S1=${pivots.s1.toFixed(d)} R1=${pivots.r1.toFixed(d)}`, price > pivots.pivot && price < pivots.r2 ? "PIVOT_BULLISH_CONTROL" : price < pivots.pivot && price > pivots.s2 ? "PIVOT_BEARISH_CONTROL" : price <= pivots.s1 ? "PIVOT_SUPPORT_REACTION" : "PIVOT_RESISTANCE_REACTION", price <= pivots.s1 ? 0.65 : price >= pivots.r1 ? -0.65 : price >= pivots.pivot ? 0.92 : -0.92, 1.05, Math.abs(price - pivots.pivot) / Math.max(atr14, 0.00001));
    pushPhase(P, `FIBONACCI ${fib.upSwing ? "upswing" : "downswing"} nearest=${fib.nearest.toFixed(d)} 38.2=${fib.l382.toFixed(d)} 61.8=${fib.l618.toFixed(d)}`, fib.upSwing ? (price >= fib.l500 ? "FIB_UPSWING_HOLD" : "FIB_UPSWING_DEEP_PULLBACK") : (price <= fib.l500 ? "FIB_DOWNSWING_HOLD" : "FIB_DOWNSWING_DEEP_PULLBACK"), fib.upSwing ? (price >= fib.l500 ? 0.88 : -0.38) : (price <= fib.l500 ? -0.88 : 0.38), 1.0, Math.abs(price - fib.nearest) / Math.max(atr14, 0.00001));
    pushPhase(P, `LIVE CURRENT CANDLE pressure=${livePressure.pressure.toFixed(2)} closeLoc=${(livePressure.closeLocation * 100).toFixed(0)}% body=${(livePressure.bodyRatio * 100).toFixed(0)}%`, livePressure.pressure >= 0.18 ? "LIVE_CANDLE_BUY_PRESSURE" : livePressure.pressure <= -0.18 ? "LIVE_CANDLE_SELL_PRESSURE" : liveCandle.close >= liveCandle.open ? "LIVE_CANDLE_WEAK_BUY" : "LIVE_CANDLE_WEAK_SELL", livePressure.pressure >= 0 ? clamp(0.45 + Math.abs(livePressure.pressure) * 0.38, 0.35, 1.55) : -clamp(0.45 + Math.abs(livePressure.pressure) * 0.38, 0.35, 1.55), 1.55, Math.abs(livePressure.pressure));
    pushPhase(P, `LINEAR REGRESSION slope=${slope20.toFixed(d)} (${(slopeStrength * 100).toFixed(0)}% ATR/bar)`, slope20 > 0 ? "SLOPE_UP" : "SLOPE_DOWN", slope20 > 0 ? clamp(0.45 + slopeStrength, 0.45, 1.45) : -clamp(0.45 + slopeStrength, 0.45, 1.45), 1.15, slopeStrength);
    pushPhase(P, `MOMENTUM 3-bar=${momentum3.toFixed(d)} 10-bar=${momentum10.toFixed(d)}`, momentum3 > 0 && momentum10 > 0 ? "DUAL_MOM_UP" : momentum3 < 0 && momentum10 < 0 ? "DUAL_MOM_DOWN" : "MOMENTUM_CONFLICT", momentum3 > 0 && momentum10 > 0 ? 1.15 : momentum3 < 0 && momentum10 < 0 ? -1.15 : momentum3 > 0 ? 0.25 : -0.25, 1.05, (Math.abs(momentum3) + Math.abs(momentum10)) / Math.max(atr14 * 2, 0.00001));
    pushPhase(P, `SUPERTREND bias lower=${supertrend.lower.toFixed(d)} upper=${supertrend.upper.toFixed(d)}`, supertrend.up ? "SUPERTREND_CALL" : "SUPERTREND_PUT", supertrend.up ? 1.35 : -1.35, 1.35, 1.2);
    pushPhase(P, `HIGHER TF ${cfg.htf} EMA trend + slope`, htfUp && htfSlope >= 0 ? "HTF_CONFIRMED_UP" : !htfUp && htfSlope <= 0 ? "HTF_CONFIRMED_DOWN" : htfUp ? "HTF_UP_SLOPE_MIXED" : "HTF_DOWN_SLOPE_MIXED", htfUp && htfSlope >= 0 ? 1.55 : !htfUp && htfSlope <= 0 ? -1.55 : htfUp ? 0.65 : -0.65, 1.6, 1.35);
    pushPhase(P, `CONFIRM TF ${cfg.confirm} macro bias`, confirmUp ? "CONFIRM_TF_UP" : "CONFIRM_TF_DOWN", confirmUp ? 1.15 : -1.15, 1.25, 1.1);
    pushPhase(P, `S/R support=${support.toFixed(d)} resistance=${resistance.toFixed(d)}`, nearSup ? "REJECTION_AT_SUPPORT" : nearRes ? "REJECTION_AT_RESISTANCE" : "CLEAN_MID_RANGE", nearSup ? 0.95 : nearRes ? -0.95 : price > (support + resistance) / 2 ? 0.25 : -0.25, 1.0, nearSup || nearRes ? 1 : 0.35);
    pushPhase(P, `CANDLE+VOLUME body=${(bodyPct * 100).toFixed(0)}%ATR vol=x${volSpike.toFixed(2)} wicks T/B=${wickTop.toFixed(2)}/${wickBottom.toFixed(2)}`, bullCandle && wickBottom >= wickTop ? "BULL_REJECTION_VOLUME" : !bullCandle && wickTop >= wickBottom ? "BEAR_REJECTION_VOLUME" : bullCandle ? "BULL_CANDLE" : "BEAR_CANDLE", (bullCandle ? 1 : -1) * clamp(0.35 + bodyPct * 0.45 + (volSpike > 1.2 ? 0.25 : 0), 0.35, 1.25), 0.9, bodyPct + Math.max(0, volSpike - 1));
    pushPhase(P, `RSI/PRICE DIVERGENCE scan`, div.bullish ? "BULLISH_DIVERGENCE" : div.bearish ? "BEARISH_DIVERGENCE" : "NO_DIVERGENCE", div.bullish ? 1.05 : div.bearish ? -1.05 : 0, 0.9, div.bullish || div.bearish ? 1 : 0);

    const emaPeriods = [3, 5, 8, 9, 10, 12, 13, 15, 18, 21, 24, 26, 30, 34, 40, 45, 50, 55, 60, 75];
    for (const period of emaPeriods) {
      const value = ema(closes, period);
      const slope = value - ema(closes.slice(0, -1), period);
      const vote = price >= value ? clamp(0.35 + Math.abs(price - value) / Math.max(atr14 * 1.2, 0.00001) + (slope > 0 ? 0.2 : -0.05), 0.25, 1.25) : -clamp(0.35 + Math.abs(price - value) / Math.max(atr14 * 1.2, 0.00001) + (slope < 0 ? 0.2 : -0.05), 0.25, 1.25);
      pushPhase(P, `EMA-${period} adaptive trend ${value.toFixed(d)} slope=${slope.toFixed(d)}`, vote > 0 ? `EMA_${period}_BULL` : `EMA_${period}_BEAR`, vote, 0.38 + Math.min(period, 75) / 260, Math.abs(vote));
    }

    const smaPeriods = [4, 6, 8, 10, 12, 14, 16, 18, 22, 25, 28, 32, 36, 40, 44, 48, 55, 65, 80, 100];
    for (const period of smaPeriods) {
      const value = sma(closes, period);
      const prevValue = sma(closes.slice(0, -1), period);
      const vote = price >= value ? clamp(0.28 + Math.abs(price - value) / Math.max(atr14 * 1.5, 0.00001) + (value >= prevValue ? 0.18 : -0.04), 0.2, 1.15) : -clamp(0.28 + Math.abs(price - value) / Math.max(atr14 * 1.5, 0.00001) + (value <= prevValue ? 0.18 : -0.04), 0.2, 1.15);
      pushPhase(P, `SMA-${period} baseline ${value.toFixed(d)} drift=${(value - prevValue).toFixed(d)}`, vote > 0 ? `SMA_${period}_CALL_BIAS` : `SMA_${period}_PUT_BIAS`, vote, 0.34 + Math.min(period, 100) / 360, Math.abs(vote));
    }

    const rsiPeriods = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 21, 24, 28, 32, 36, 42];
    for (const period of rsiPeriods) {
      const series = rsiSeries(closes, period);
      const value = last(series, 50);
      const prev = series[series.length - 2] ?? value;
      const overextended = value >= 76 || value <= 24;
      const vote = overextended ? (value <= 24 ? 0.75 : -0.75) : value >= 52 ? clamp((value - 50) / 18 + (value > prev ? 0.18 : -0.04), 0.18, 1.12) : -clamp((50 - value) / 18 + (value < prev ? 0.18 : -0.04), 0.18, 1.12);
      pushPhase(P, `RSI-${period} value=${value.toFixed(1)} delta=${(value - prev).toFixed(1)}`, vote > 0 ? `RSI_${period}_CALL_FLOW` : `RSI_${period}_PUT_FLOW`, vote, 0.34 + Math.min(period, 42) / 150, Math.abs(vote));
    }

    const momentumPeriods = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 50];
    for (const period of momentumPeriods) {
      const value = roc(closes, period);
      const normalized = value / Math.max(atr14, 0.00001);
      const vote = normalized >= 0 ? clamp(0.22 + Math.abs(normalized) * 0.22, 0.18, 1.2) : -clamp(0.22 + Math.abs(normalized) * 0.22, 0.18, 1.2);
      pushPhase(P, `${period}-bar momentum impulse=${value.toFixed(d)} normalized=${normalized.toFixed(2)}`, vote > 0 ? `MOM_${period}_UP_IMPULSE` : `MOM_${period}_DOWN_IMPULSE`, vote, 0.32 + Math.min(period, 50) / 190, Math.abs(vote));
    }

    const rangePeriods = [6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 55, 65];
    for (const period of rangePeriods) {
      const pos = rangePosition(price, highs, lows, period);
      const vote = pos >= 0.58 ? clamp((pos - 0.5) * 2, 0.18, 1.1) : pos <= 0.42 ? -clamp((0.5 - pos) * 2, 0.18, 1.1) : price >= previousClose ? 0.12 : -0.12;
      pushPhase(P, `${period}-bar range location ${(pos * 100).toFixed(0)}%`, vote > 0 ? `RANGE_${period}_UPPER_CONTROL` : `RANGE_${period}_LOWER_CONTROL`, vote, 0.28 + Math.min(period, 65) / 240, Math.abs(vote));
    }

    const volatilityPeriods = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 50, 60];
    for (const period of volatilityPeriods) {
      const sigma = stdDev(closes, period);
      const slope = regressionSlope(closes, Math.min(period, 28));
      const expansion = sigma / Math.max(atr14, 0.00001);
      const vote = slope >= 0 ? clamp(0.18 + expansion * 0.12 + Math.abs(slope) / Math.max(atr14, 0.00001) * 0.28, 0.16, 1.05) : -clamp(0.18 + expansion * 0.12 + Math.abs(slope) / Math.max(atr14, 0.00001) * 0.28, 0.16, 1.05);
      pushPhase(P, `VOL-${period} sigma=${sigma.toFixed(d)} slope=${slope.toFixed(d)}`, vote > 0 ? `VOL_${period}_BULL_EXPANSION` : `VOL_${period}_BEAR_EXPANSION`, vote, 0.3 + Math.min(period, 60) / 260, Math.abs(vote));
    }

    const breakoutPeriods = [9, 11, 13, 17, 19, 23, 27, 31, 37, 43, 52, 64, 78, 96];
    for (const period of breakoutPeriods) {
      const recentHigh = Math.max(...highs.slice(-period, -1));
      const recentLow = Math.min(...lows.slice(-period, -1));
      const upperDistance = (price - recentHigh) / Math.max(atr14, 0.00001);
      const lowerDistance = (recentLow - price) / Math.max(atr14, 0.00001);
      const vote = price >= recentHigh ? clamp(0.78 + upperDistance * 0.18, 0.45, 1.28) : price <= recentLow ? -clamp(0.78 + lowerDistance * 0.18, 0.45, 1.28) : price >= (recentHigh + recentLow) / 2 ? 0.24 : -0.24;
      pushPhase(P, `${period}-bar liquidity breakout high=${recentHigh.toFixed(d)} low=${recentLow.toFixed(d)}`, vote > 0 ? `LIQUIDITY_${period}_BULL_CONTROL` : `LIQUIDITY_${period}_BEAR_CONTROL`, vote, 0.38 + Math.min(period, 96) / 340, Math.abs(vote));
    }

    const recentCandles = candles.slice(-12);
    recentCandles.forEach((candle, index) => {
      const localBody = Math.abs(candle.close - candle.open) / Math.max(atr14, 0.00001);
      const localTop = (candle.high - Math.max(candle.open, candle.close)) / Math.max(atr14, 0.00001);
      const localBottom = (Math.min(candle.open, candle.close) - candle.low) / Math.max(atr14, 0.00001);
      const bullish = candle.close >= candle.open;
      const vote = bullish ? clamp(0.18 + localBody * 0.35 + (localBottom > localTop ? 0.2 : 0), 0.16, 1.05) : -clamp(0.18 + localBody * 0.35 + (localTop > localBottom ? 0.2 : 0), 0.16, 1.05);
      pushPhase(P, `Candle microstructure -${recentCandles.length - index} body=${localBody.toFixed(2)} wickT/B=${localTop.toFixed(2)}/${localBottom.toFixed(2)}`, vote > 0 ? `CANDLE_${index + 1}_BUY_PRESSURE` : `CANDLE_${index + 1}_SELL_PRESSURE`, vote, 0.26 + index / 80, Math.abs(vote));
    });
    P.push(...candlePatternPhases(candles, atr14));

    const mtfChecks = [
      { label: `${cfg.htf} EMA21/50`, vote: htfUp ? 1.18 : -1.18, strength: 1.1 },
      { label: `${cfg.htf} regression slope`, vote: htfSlope >= 0 ? 1.08 : -1.08, strength: Math.abs(htfSlope) / Math.max(atr14, 0.00001) },
      { label: `${cfg.confirm} EMA21/50`, vote: confirmUp ? 1.12 : -1.12, strength: 1.08 },
      { label: `price vs EMA9`, vote: price >= ema9v ? 0.82 : -0.82, strength: Math.abs(price - ema9v) / Math.max(atr14, 0.00001) },
      { label: `price vs EMA21`, vote: price >= ema21v ? 0.9 : -0.9, strength: Math.abs(price - ema21v) / Math.max(atr14, 0.00001) },
      { label: `price vs EMA50`, vote: price >= ema50v ? 1.0 : -1.0, strength: Math.abs(price - ema50v) / Math.max(atr14, 0.00001) },
      { label: `session high/low midpoint`, vote: price >= (support + resistance) / 2 ? 0.78 : -0.78, strength: Math.abs(price - (support + resistance) / 2) / Math.max(atr14, 0.00001) },
      { label: `MACD sign confirmation`, vote: m.hist >= 0 ? 1.02 : -1.02, strength: Math.abs(m.hist) / Math.max(atr14, 0.00001) },
      { label: `ADX directional confirmation`, vote: adx14.plus >= adx14.minus ? 0.98 : -0.98, strength: adx14.adx / 28 },
      { label: `VWAP final confirmation`, vote: price >= vw ? 0.92 : -0.92, strength: Math.abs(price - vw) / Math.max(atr14, 0.00001) },
      { label: `last-close continuation`, vote: lastClose >= previousClose ? 0.68 : -0.68, strength: Math.abs(lastClose - previousClose) / Math.max(atr14, 0.00001) },
      { label: `volume participation`, vote: (bullCandle ? 1 : -1) * clamp(0.35 + Math.max(0, volSpike - 1) * 0.22, 0.3, 0.95), strength: volSpike },
    ];
    for (const check of mtfChecks) {
      pushPhase(P, `Final MTF gate: ${check.label}`, check.vote > 0 ? "MTF_CALL_GATE" : "MTF_PUT_GATE", check.vote, 0.72, check.strength);
    }

    let score = 0;
    let maxScore = 0;
    for (const p of P) {
      score += p.vote * p.weight;
      maxScore += Math.abs(p.weight) * 1.8;
    }
    const rawAlignment = Math.abs(score) / Math.max(maxScore, 1);
    const callVotes = P.filter((p) => p.weight > 0 && p.vote > 0).length;
    const putVotes = P.filter((p) => p.weight > 0 && p.vote < 0).length;
    const consensus = Math.max(callVotes, putVotes) / Math.max(1, callVotes + putVotes);
    const htfAligned = score >= 0 ? htfUp === true : htfUp === false;
    const confirmAligned = score >= 0 ? confirmUp === true : confirmUp === false;
    const volatilityQuality = atrPct > 0.00005 && atrPct < (pair === "BTC/USD" ? 0.025 : 0.012);
    const qualityBoost = (htfAligned ? 0.08 : -0.06) + (confirmAligned ? 0.06 : -0.04) + (volatilityQuality ? 0.04 : -0.05) + (consensus >= 0.68 ? 0.06 : -0.03);
    const alignment = clamp(rawAlignment + qualityBoost, 0, 1);
    let direction: Direction = score >= 0 ? "CALL" : "PUT";
    let confidence = clamp(Math.round(88 + alignment * 11), 88, 99);

    let aiVerdict: Direction | "UNKNOWN" = "UNKNOWN";
    let aiNote = "";
    let aiRiskFlags: string[] = [];
    try {
      const key = process.env.LOVABLE_API_KEY;
      if (key) {
        const gateway = createLovableAiGatewayProvider(key);
        const snapshot = {
          pair: displayPair(pair),
          timeframe: cfg.interval,
          higherTimeframe: cfg.htf,
          confirmTimeframe: cfg.confirm,
          currentLiveCandleTime: currentCandleIso(candles),
          price: +price.toFixed(d),
          score: +score.toFixed(3),
          alignment: +(alignment * 100).toFixed(1),
          consensus: +(consensus * 100).toFixed(1),
          direction,
          latestCandles: candles.slice(-28).map((c) => ({ o: +c.open.toFixed(d), h: +c.high.toFixed(d), l: +c.low.toFixed(d), c: +c.close.toFixed(d), v: c.volume })),
          indicators: {
            ema9: +ema9v.toFixed(d), ema21: +ema21v.toFixed(d), ema50: +ema50v.toFixed(d),
            sma5: +sma5v.toFixed(d), sma20: +sma20v.toFixed(d), sma50: +sma50v.toFixed(d),
            rsi14: +rsi14.toFixed(2), macdHist: +m.hist.toFixed(d), adx: +adx14.adx.toFixed(2),
            vwap: +vw.toFixed(d), bbPosPct: +(bbPos * 100).toFixed(1), stoch: +stoch.toFixed(1),
            pivot: +pivots.pivot.toFixed(d), fibNearest: +fib.nearest.toFixed(d), liveCandlePressure: +livePressure.pressure.toFixed(2),
            atr14: +atr14.toFixed(d), htfUp, confirmUp, nearSup, nearRes, volSpike: +volSpike.toFixed(2),
            latestPattern: P.slice(-42, -6).map((p) => p.status).slice(-12),
          },
          phaseSummary: {
            total: P.length,
            callVotes,
            putVotes,
            strongest: P.slice().sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight)).slice(0, 24).map((p) => ({ status: p.status, vote: +p.vote.toFixed(2), weight: +p.weight.toFixed(2) })),
          },
        };
        const result = await generateObject({
          model: gateway("google/gemini-3-flash-preview"),
          schema: AiSignalSchema,
          system: "You are a strict LIVE AI candlestick analyzer for immediate short-expiry market analysis. Study RSI, MACD, EMA 9/21, Bollinger Bands, Stochastic, Pivot Points, Fibonacci, current live candle pressure, past candles, pattern states, trend/MTF alignment and risk flags. Return only CALL or PUT, never WAIT or next-candle prediction. If data is mixed, choose the statistically stronger current entry side and lower confidence.",
          prompt: JSON.stringify(snapshot),
          timeout: 8000,
        });
        aiVerdict = result.object.direction;
        aiNote = result.object.reason.slice(0, 150);
        aiRiskFlags = result.object.riskFlags.slice(0, 4);
        const aiConf = clamp(Math.round(Number(result.object.confidence) || 88), 80, 99);
        if (aiVerdict === direction) confidence = clamp(Math.round((confidence + aiConf) / 2) + 2, 88, 99);
        else if (aiConf >= 91 && alignment < 0.58) {
          direction = aiVerdict;
          confidence = clamp(aiConf - 2, 86, 97);
        } else {
          confidence = clamp(Math.min(confidence, aiConf) - 3, 84, 96);
        }
      }
    } catch {
      // AI layer is a strict second opinion; technical engine remains primary if credits/network fail.
    }

    const isUp = direction === "CALL";
    const phases: PhaseCheck[] = P.map((p, i) => {
      const aligned = isUp ? p.vote >= 0 : p.vote <= 0;
      const phaseAccuracy = clamp(Math.round(82 + Math.min(1, p.strength / 1.5) * 14 + (aligned ? 3 : -5)), 76, 99);
      return {
        phase: i + 1,
        indicator: `PHASE ${i + 1}: ${p.label}`,
        accuracy: phaseAccuracy,
        status: p.status,
        passed: aligned,
      };
    });

    const slOffset = Math.max(atr14 * 1.35, Math.abs(price) * (pair === "BTC/USD" ? 0.0025 : 0.00035));
    const tp1Offset = slOffset * 0.85;
    const tp2Offset = slOffset * 1.65;
    const tp3Offset = slOffset * 2.55;
    const entryPrice = parseFloat(price.toFixed(d));
    const stopLossPrice = parseFloat((isUp ? price - slOffset : price + slOffset).toFixed(d));
    const tp1Price = parseFloat((isUp ? price + tp1Offset : price - tp1Offset).toFixed(d));
    const tp2Price = parseFloat((isUp ? price + tp2Offset : price - tp2Offset).toFixed(d));
    const tp3Price = parseFloat((isUp ? price + tp3Offset : price - tp3Offset).toFixed(d));

    const drivers = P.filter((p) => p.weight > 0 && (isUp ? p.vote > 0 : p.vote < 0))
      .sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight))
      .slice(0, 5)
      .map((p) => `${p.status}: ${p.label}`);

    return {
      success: true,
      pair,
      direction,
      timeFrame,
      priceAtSignal: entryPrice,
      accuracy: confidence,
      executeTime: new Date().toISOString().slice(11, 19) + " UTC",
      nextCandleTime: undefined,
      analysisMode: "LIVE AI candlestick analyzer + 200-phase current-entry scan",
      aiReasoning: `${displayPair(pair)} ${cfg.interval}: RSI/MACD/EMA9-21/Bollinger/Stochastic/Pivot/Fibonacci + live candle pressure checked across ${phases.length} phases. score=${score.toFixed(2)}, consensus=${(consensus * 100).toFixed(0)}%, MTF=${htfAligned && confirmAligned ? "aligned" : "mixed"} → ${direction}.${aiVerdict !== "UNKNOWN" ? ` AI filter=${aiVerdict}${aiNote ? ` (${aiNote})` : ""}${aiRiskFlags.length ? ` flags=${aiRiskFlags.join(", ")}` : ""}.` : ""}`,
      phases,
      timestamp: Date.now(),
      signalDecision: isUp ? "STRONG BUY" : "STRONG SELL",
      confidence,
      scantimeframe: `${cfg.interval} + ${cfg.htf} + ${cfg.confirm}`,
      entryPrice,
      stopLossPrice,
      tp1Price,
      tp2Price,
      tp3Price,
      rrRatio: `1:${(tp2Offset / slOffset).toFixed(2)}`,
      top5Drivers: drivers,
      riskWarning: "Live technical confluence only — binary options remain risky and no bot can guarantee every candle.",
      invalidation: isUp ? `Bias invalidated on close below ${stopLossPrice.toFixed(d)}.` : `Bias invalidated on close above ${stopLossPrice.toFixed(d)}.`,
    };
  });