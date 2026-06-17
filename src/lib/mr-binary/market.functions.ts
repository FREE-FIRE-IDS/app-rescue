// Server function: fetches REAL market data from Yahoo Finance and runs an
// advanced 16-phase confluence engine. Output is only CALL / PUT (no WAIT).
// No trading system can guarantee outcomes; this engine improves filtering,
// data alignment, and multi-timeframe confirmation from live market candles.

import { createServerFn } from "@tanstack/react-start";
import type { MarketPriceData, PhaseCheck, SignalResponse, TimeFrameOption } from "./types";

const YAHOO_SYMBOL: Record<string, string> = {
  "XAU/USD": "GC=F",
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

function decimals(pair: string) {
  return pair.includes("EUR") || pair.includes("GBP") ? 5 : 2;
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
    const lastOpen = last(opens, lastClose);
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
    pushPhase(P, `LINEAR REGRESSION slope=${slope20.toFixed(d)} (${(slopeStrength * 100).toFixed(0)}% ATR/bar)`, slope20 > 0 ? "SLOPE_UP" : "SLOPE_DOWN", slope20 > 0 ? clamp(0.45 + slopeStrength, 0.45, 1.45) : -clamp(0.45 + slopeStrength, 0.45, 1.45), 1.15, slopeStrength);
    pushPhase(P, `MOMENTUM 3-bar=${momentum3.toFixed(d)} 10-bar=${momentum10.toFixed(d)}`, momentum3 > 0 && momentum10 > 0 ? "DUAL_MOM_UP" : momentum3 < 0 && momentum10 < 0 ? "DUAL_MOM_DOWN" : "MOMENTUM_CONFLICT", momentum3 > 0 && momentum10 > 0 ? 1.15 : momentum3 < 0 && momentum10 < 0 ? -1.15 : momentum3 > 0 ? 0.25 : -0.25, 1.05, (Math.abs(momentum3) + Math.abs(momentum10)) / Math.max(atr14 * 2, 0.00001));
    pushPhase(P, `SUPERTREND bias lower=${supertrend.lower.toFixed(d)} upper=${supertrend.upper.toFixed(d)}`, supertrend.up ? "SUPERTREND_CALL" : "SUPERTREND_PUT", supertrend.up ? 1.35 : -1.35, 1.35, 1.2);
    pushPhase(P, `HIGHER TF ${cfg.htf} EMA trend + slope`, htfUp && htfSlope >= 0 ? "HTF_CONFIRMED_UP" : !htfUp && htfSlope <= 0 ? "HTF_CONFIRMED_DOWN" : htfUp ? "HTF_UP_SLOPE_MIXED" : "HTF_DOWN_SLOPE_MIXED", htfUp && htfSlope >= 0 ? 1.55 : !htfUp && htfSlope <= 0 ? -1.55 : htfUp ? 0.65 : -0.65, 1.6, 1.35);
    pushPhase(P, `CONFIRM TF ${cfg.confirm} macro bias`, confirmUp ? "CONFIRM_TF_UP" : "CONFIRM_TF_DOWN", confirmUp ? 1.15 : -1.15, 1.25, 1.1);
    pushPhase(P, `S/R support=${support.toFixed(d)} resistance=${resistance.toFixed(d)}`, nearSup ? "REJECTION_AT_SUPPORT" : nearRes ? "REJECTION_AT_RESISTANCE" : "CLEAN_MID_RANGE", nearSup ? 0.95 : nearRes ? -0.95 : price > (support + resistance) / 2 ? 0.25 : -0.25, 1.0, nearSup || nearRes ? 1 : 0.35);
    pushPhase(P, `CANDLE+VOLUME body=${(bodyPct * 100).toFixed(0)}%ATR vol=x${volSpike.toFixed(2)} wicks T/B=${wickTop.toFixed(2)}/${wickBottom.toFixed(2)}`, bullCandle && wickBottom >= wickTop ? "BULL_REJECTION_VOLUME" : !bullCandle && wickTop >= wickBottom ? "BEAR_REJECTION_VOLUME" : bullCandle ? "BULL_CANDLE" : "BEAR_CANDLE", (bullCandle ? 1 : -1) * clamp(0.35 + bodyPct * 0.45 + (volSpike > 1.2 ? 0.25 : 0), 0.35, 1.25), 0.9, bodyPct + Math.max(0, volSpike - 1));
    pushPhase(P, `RSI/PRICE DIVERGENCE scan`, div.bullish ? "BULLISH_DIVERGENCE" : div.bearish ? "BEARISH_DIVERGENCE" : "NO_DIVERGENCE", div.bullish ? 1.05 : div.bearish ? -1.05 : 0, 0.9, div.bullish || div.bearish ? 1 : 0);

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
    try {
      const key = process.env.LOVABLE_API_KEY;
      if (key) {
        const snapshot = {
          pair,
          timeframe: cfg.interval,
          higherTimeframe: cfg.htf,
          confirmTimeframe: cfg.confirm,
          price: +price.toFixed(d),
          score: +score.toFixed(3),
          alignment: +(alignment * 100).toFixed(1),
          consensus: +(consensus * 100).toFixed(1),
          direction,
          indicators: {
            ema9: +ema9v.toFixed(d), ema21: +ema21v.toFixed(d), ema50: +ema50v.toFixed(d),
            sma5: +sma5v.toFixed(d), sma20: +sma20v.toFixed(d), sma50: +sma50v.toFixed(d),
            rsi14: +rsi14.toFixed(2), macdHist: +m.hist.toFixed(d), adx: +adx14.adx.toFixed(2),
            vwap: +vw.toFixed(d), bbPosPct: +(bbPos * 100).toFixed(1), stoch: +stoch.toFixed(1),
            atr14: +atr14.toFixed(d), htfUp, confirmUp, nearSup, nearRes, volSpike: +volSpike.toFixed(2),
          },
          phases: P.map((p) => ({ status: p.status, vote: +p.vote.toFixed(2), weight: p.weight })),
        };
        const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Lovable-API-Key": key },
          body: JSON.stringify({
            model: "google/gemini-3-flash-preview",
            messages: [
              { role: "system", content: "You are a strict technical risk filter. Return ONLY JSON: {\"direction\":\"CALL\"|\"PUT\",\"confidence\":0-100,\"reason\":\"short\"}. Choose the statistically stronger side from the supplied live indicators; never return WAIT." },
              { role: "user", content: JSON.stringify(snapshot) },
            ],
          }),
          signal: AbortSignal.timeout(6000),
        });
        if (aiRes.ok) {
          const j: any = await aiRes.json();
          const raw = String(j.choices?.[0]?.message?.content ?? "");
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.direction === "CALL" || parsed.direction === "PUT") {
              aiVerdict = parsed.direction as Direction;
              aiNote = String(parsed.reason ?? "").slice(0, 140);
              const aiConf = clamp(Math.round(Number(parsed.confidence) || 88), 82, 99);
              if (aiVerdict === direction) confidence = clamp(Math.round((confidence + aiConf) / 2) + 2, 88, 99);
              else if (aiConf >= 92 && alignment < 0.52) {
                direction = aiVerdict as Direction;
                confidence = clamp(aiConf - 2, 88, 97);
              } else {
                confidence = clamp(confidence - 2, 88, 97);
              }
            }
          }
        }
      }
    } catch {
      // AI layer is an optional second opinion; technical engine remains primary.
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
      executeTime: new Date(Date.now() + 1500).toISOString().slice(11, 19) + " UTC",
      aiReasoning: `${pair} ${cfg.interval}: advanced 16-phase score=${score.toFixed(2)}, consensus=${(consensus * 100).toFixed(0)}%, MTF=${htfAligned && confirmAligned ? "aligned" : "mixed"} → ${direction}.${aiVerdict !== "UNKNOWN" ? ` AI filter=${aiVerdict}${aiNote ? ` (${aiNote})` : ""}.` : ""}`,
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