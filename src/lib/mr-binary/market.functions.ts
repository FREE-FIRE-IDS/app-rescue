// Server function: fetches REAL market data from Yahoo Finance and runs a
// 16-phase technical confluence engine. Only CALL / PUT (no WAIT).
// Honesty: indicators describe recent price behavior — they do not guarantee
// future outcomes on binary options. Trade at your own risk.

import { createServerFn } from "@tanstack/react-start";
import type { MarketPriceData, SignalResponse, PhaseCheck, TimeFrameOption } from "./types";

const YAHOO_SYMBOL: Record<string, string> = {
  "XAU/USD": "GC=F",
  "BTC/USD": "BTC-USD",
  "USD/JPY": "JPY=X",
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
};

function decimals(pair: string) {
  return pair.includes("EUR") || pair.includes("GBP") ? 5 : 2;
}

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

async function fetchYahoo(pair: string, interval: string, range: string) {
  const sym = YAHOO_SYMBOL[pair] ?? "GC=F";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MR-BINARY/1.0; +https://lovable.dev)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const json = (await res.json()) as YahooChart;
  const r = json.chart.result?.[0];
  if (!r) throw new Error("Yahoo Finance: empty result");
  return r;
}

export const fetchMarketDataFn = createServerFn({ method: "GET" })
  .inputValidator((input: { pair: string }) => input)
  .handler(async ({ data }): Promise<MarketPriceData> => {
    const pair = data.pair;
    const r = await fetchYahoo(pair, "1m", "1d");
    const d = decimals(pair);
    const closes = (r.indicators.quote[0]?.close ?? []).filter((v): v is number => typeof v === "number");
    const highs = (r.indicators.quote[0]?.high ?? []).filter((v): v is number => typeof v === "number");
    const lows = (r.indicators.quote[0]?.low ?? []).filter((v): v is number => typeof v === "number");
    const price = r.meta.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
    const prevClose = r.meta.previousClose ?? r.meta.chartPreviousClose ?? price;
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return {
      success: true,
      source: "yahoo-finance",
      pair,
      price: parseFloat(price.toFixed(d)),
      change: parseFloat(change.toFixed(4)),
      high: parseFloat((highs.length ? Math.max(...highs) : price).toFixed(d)),
      low: parseFloat((lows.length ? Math.min(...lows) : price).toFixed(d)),
      timestamp: Date.now(),
    };
  });

// ---------- Indicator helpers ----------
function sma(arr: number[], period: number) {
  const n = Math.min(period, arr.length);
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}
function ema(arr: number[], period: number) {
  if (arr.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function rsi(arr: number[], period = 14) {
  if (arr.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}
function macd(arr: number[]) {
  const fast = ema(arr, 12);
  const slow = ema(arr, 26);
  const line = fast - slow;
  // signal = EMA9 of MACD line (approx using last 35 bars)
  const macdSeries: number[] = [];
  for (let i = 26; i <= arr.length; i++) {
    const slice = arr.slice(0, i);
    macdSeries.push(ema(slice, 12) - ema(slice, 26));
  }
  const signal = ema(macdSeries.slice(-9), 9);
  return { line, signal, hist: line - signal };
}
function stochastic(highs: number[], lows: number[], closes: number[], period = 14) {
  const n = Math.min(period, closes.length);
  const hh = Math.max(...highs.slice(-n));
  const ll = Math.min(...lows.slice(-n));
  if (hh === ll) return 50;
  return ((closes[closes.length - 1] - ll) / (hh - ll)) * 100;
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
  if (n <= 0) return Math.abs(closes[closes.length - 1] ?? 1) * 0.001;
  const trs: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

const TF_TO_YAHOO: Record<TimeFrameOption, { interval: string; range: string; htf: string; htfRange: string }> = {
  "1 Min": { interval: "1m", range: "1d", htf: "5m", htfRange: "5d" },
  "2 Min": { interval: "2m", range: "1d", htf: "15m", htfRange: "5d" },
  "5 Min": { interval: "5m", range: "5d", htf: "30m", htfRange: "1mo" },
  "15 Min": { interval: "15m", range: "5d", htf: "60m", htfRange: "1mo" },
  "30 Min": { interval: "30m", range: "1mo", htf: "1d", htfRange: "3mo" },
};

export const generateSignalFn = createServerFn({ method: "POST" })
  .inputValidator((input: { pair: string; timeFrame: TimeFrameOption }) => input)
  .handler(async ({ data }): Promise<SignalResponse> => {
    const { pair, timeFrame } = data;
    const cfg = TF_TO_YAHOO[timeFrame] ?? TF_TO_YAHOO["1 Min"];
    const d = decimals(pair);

    const [r, rHtf] = await Promise.all([
      fetchYahoo(pair, cfg.interval, cfg.range),
      fetchYahoo(pair, cfg.htf, cfg.htfRange).catch(() => null),
    ]);

    const q = r.indicators.quote[0];
    const closes = (q?.close ?? []).filter((v): v is number => typeof v === "number");
    const highs = (q?.high ?? []).filter((v): v is number => typeof v === "number");
    const lows = (q?.low ?? []).filter((v): v is number => typeof v === "number");
    const opens = (q?.open ?? []).filter((v): v is number => typeof v === "number");
    const volumes = (q?.volume ?? []).map((v) => (typeof v === "number" ? v : 0));
    if (closes.length < 30) throw new Error("Not enough market data to compute indicators");

    const price = r.meta.regularMarketPrice ?? closes[closes.length - 1];
    const last = closes[closes.length - 1];
    const prev3 = closes[closes.length - 4] ?? last;
    const prev10 = closes[closes.length - 11] ?? last;

    // Indicators
    const sma5v = sma(closes, 5);
    const sma20v = sma(closes, 20);
    const sma50v = sma(closes, 50);
    const ema9v = ema(closes.slice(-50), 9);
    const ema21v = ema(closes.slice(-80), 21);
    const rsi14 = rsi(closes, 14);
    const m = macd(closes.slice(-60));
    const stoch = stochastic(highs, lows, closes, 14);
    const bb = bollinger(closes, 20, 2);
    const atr14 = atr(highs, lows, closes, 14);
    const bbPos = bb.width > 0 ? (last - bb.lower) / bb.width : 0.5; // 0..1
    const recentVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const lastVol = volumes[volumes.length - 1] ?? 0;
    const volSpike = recentVol > 0 ? lastVol / recentVol : 1;
    const lastOpen = opens[opens.length - 1] ?? last;
    const bullCandle = last > lastOpen;
    const bodyPct = Math.abs(last - lastOpen) / (atr14 || 1);

    // Support / resistance from last 50 bars
    const sr = closes.slice(-50);
    const resistance = Math.max(...sr);
    const support = Math.min(...sr);
    const nearRes = Math.abs(price - resistance) / atr14 < 0.5;
    const nearSup = Math.abs(price - support) / atr14 < 0.5;

    // Higher-timeframe trend
    let htfTrendUp = sma5v > sma20v;
    if (rHtf) {
      const hc = (rHtf.indicators.quote[0]?.close ?? []).filter((v): v is number => typeof v === "number");
      if (hc.length >= 20) htfTrendUp = sma(hc, 5) > sma(hc, 20);
    }

    // RSI divergence (simple): compare last swing
    const halfA = closes.slice(-20, -10);
    const halfB = closes.slice(-10);
    const priceUpRecent = (halfB[halfB.length - 1] ?? last) > (halfA[halfA.length - 1] ?? last);
    const rsiA = rsi(closes.slice(0, -10), 14);
    const rsiUpRecent = rsi14 > rsiA;
    const bullishDiv = !priceUpRecent && rsiUpRecent;
    const bearishDiv = priceUpRecent && !rsiUpRecent;

    // ---------- 16-phase scoring ----------
    type PhaseRes = { label: string; status: string; vote: number; weight: number };
    const P: PhaseRes[] = [];

    P.push({ label: `LIVE PRICE FEED ${pair} @ ${price.toFixed(d)}`, status: "FEED_LOCKED", vote: 0, weight: 0 });
    P.push({ label: `SMA(5)=${sma5v.toFixed(d)} vs SMA(20)=${sma20v.toFixed(d)}`, status: sma5v > sma20v ? "BULL_CROSS" : "BEAR_CROSS", vote: sma5v > sma20v ? 1 : -1, weight: 1.2 });
    P.push({ label: `SMA(20)=${sma20v.toFixed(d)} vs SMA(50)=${sma50v.toFixed(d)}`, status: sma20v > sma50v ? "UPTREND" : "DOWNTREND", vote: sma20v > sma50v ? 1 : -1, weight: 1.0 });
    P.push({ label: `EMA(9)=${ema9v.toFixed(d)} vs EMA(21)=${ema21v.toFixed(d)}`, status: ema9v > ema21v ? "EMA_BULL" : "EMA_BEAR", vote: ema9v > ema21v ? 1 : -1, weight: 1.2 });
    P.push({ label: `RSI(14)=${rsi14.toFixed(1)}`, status: rsi14 < 30 ? "OVERSOLD" : rsi14 > 70 ? "OVERBOUGHT" : rsi14 > 50 ? "RSI_BULL" : "RSI_BEAR", vote: rsi14 < 30 ? 1.5 : rsi14 > 70 ? -1.5 : rsi14 > 55 ? 0.6 : rsi14 < 45 ? -0.6 : 0, weight: 1.0 });
    P.push({ label: `MACD line=${m.line.toFixed(d)} signal=${m.signal.toFixed(d)} hist=${m.hist.toFixed(d)}`, status: m.hist > 0 ? "MACD_BULL" : "MACD_BEAR", vote: m.hist > 0 ? 1 : -1, weight: 1.3 });
    P.push({ label: `STOCHASTIC %K=${stoch.toFixed(1)}`, status: stoch < 20 ? "STOCH_OVERSOLD" : stoch > 80 ? "STOCH_OVERBOUGHT" : "STOCH_MID", vote: stoch < 20 ? 1.2 : stoch > 80 ? -1.2 : stoch > 50 ? 0.3 : -0.3, weight: 1.0 });
    P.push({ label: `BBANDS upper=${bb.upper.toFixed(d)} lower=${bb.lower.toFixed(d)} pos=${(bbPos * 100).toFixed(0)}%`, status: bbPos < 0.2 ? "BB_LOWER_TAG" : bbPos > 0.8 ? "BB_UPPER_TAG" : "BB_MID", vote: bbPos < 0.2 ? 1.0 : bbPos > 0.8 ? -1.0 : 0, weight: 0.9 });
    P.push({ label: `ATR(14)=${atr14.toFixed(d)} (volatility regime)`, status: atr14 > 0 ? "ATR_OK" : "ATR_LOW", vote: 0, weight: 0 });
    P.push({ label: `SHORT MOMENTUM last vs 3 bars ago`, status: last > prev3 ? "MOM_UP" : "MOM_DOWN", vote: last > prev3 ? 1 : -1, weight: 0.9 });
    P.push({ label: `MID MOMENTUM last vs 10 bars ago`, status: last > prev10 ? "MOM_UP" : "MOM_DOWN", vote: last > prev10 ? 1 : -1, weight: 0.7 });
    P.push({ label: `HIGHER TF (${cfg.htf}) trend`, status: htfTrendUp ? "HTF_BULL" : "HTF_BEAR", vote: htfTrendUp ? 1 : -1, weight: 1.5 });
    P.push({ label: `S/R support=${support.toFixed(d)} resistance=${resistance.toFixed(d)}`, status: nearSup ? "AT_SUPPORT" : nearRes ? "AT_RESISTANCE" : "MID_RANGE", vote: nearSup ? 1.0 : nearRes ? -1.0 : 0, weight: 1.1 });
    P.push({ label: `VOLUME spike x${volSpike.toFixed(2)} vs 20-avg`, status: volSpike > 1.5 ? "VOL_SURGE" : volSpike < 0.6 ? "VOL_DRY" : "VOL_NORMAL", vote: volSpike > 1.3 ? (bullCandle ? 0.8 : -0.8) : 0, weight: 0.8 });
    P.push({ label: `CANDLE body ${(bodyPct * 100).toFixed(0)}% of ATR`, status: bullCandle ? "BULL_CANDLE" : "BEAR_CANDLE", vote: bodyPct > 0.5 ? (bullCandle ? 0.7 : -0.7) : 0, weight: 0.7 });
    P.push({ label: `RSI DIVERGENCE check`, status: bullishDiv ? "BULL_DIV" : bearishDiv ? "BEAR_DIV" : "NO_DIV", vote: bullishDiv ? 1.2 : bearishDiv ? -1.2 : 0, weight: 1.1 });

    // Score
    let score = 0;
    let maxScore = 0;
    for (const p of P) {
      score += p.vote * p.weight;
      maxScore += Math.abs(p.weight) * 1.5; // assume max |vote| ~1.5
    }
    const alignment = Math.abs(score) / (maxScore || 1); // 0..1
    const direction: "CALL" | "PUT" = score >= 0 ? "CALL" : "PUT";
    const isUp = direction === "CALL";
    const confidence = Math.min(96, Math.max(55, Math.round(55 + alignment * 45)));

    const phases: PhaseCheck[] = P.map((p, i) => ({
      phase: i + 1,
      indicator: `PHASE ${i + 1}: ${p.label}`,
      accuracy: 100,
      status: p.status,
      passed: i === 0 ? true : (isUp ? p.vote >= 0 : p.vote <= 0),
    }));

    // Risk levels
    const slOffset = atr14 * 1.5;
    const tp1Offset = atr14 * 1.0;
    const tp2Offset = atr14 * 2.2;
    const tp3Offset = atr14 * 3.6;
    const entryPrice = parseFloat(price.toFixed(d));
    const stopLossPrice = parseFloat((isUp ? price - slOffset : price + slOffset).toFixed(d));
    const tp1Price = parseFloat((isUp ? price + tp1Offset : price - tp1Offset).toFixed(d));
    const tp2Price = parseFloat((isUp ? price + tp2Offset : price - tp2Offset).toFixed(d));
    const tp3Price = parseFloat((isUp ? price + tp3Offset : price - tp3Offset).toFixed(d));

    const drivers = [
      `HTF (${cfg.htf}) trend ${htfTrendUp ? "bullish" : "bearish"} — aligned with ${direction}.`,
      `MACD hist=${m.hist.toFixed(d)} (${m.hist > 0 ? "bull" : "bear"}), EMA9 ${ema9v > ema21v ? ">" : "<"} EMA21.`,
      `RSI(14)=${rsi14.toFixed(1)}, Stoch %K=${stoch.toFixed(1)}.`,
      `Bollinger position ${(bbPos * 100).toFixed(0)}% — ${nearSup ? "near support" : nearRes ? "near resistance" : "mid-range"}.`,
      `Volume x${volSpike.toFixed(2)} avg, candle body ${(bodyPct * 100).toFixed(0)}% of ATR (${bullCandle ? "bull" : "bear"}).`,
    ];

    return {
      success: true,
      pair,
      direction,
      timeFrame,
      priceAtSignal: entryPrice,
      accuracy: confidence,
      executeTime: new Date(Date.now() + 1500).toISOString().slice(11, 19) + " UTC",
      aiReasoning: `${pair} (${cfg.interval}): 16-phase confluence score=${score.toFixed(2)}, alignment=${(alignment * 100).toFixed(0)}% → ${direction}.`,
      phases,
      timestamp: Date.now(),
      signalDecision: isUp ? (confidence >= 75 ? "STRONG BUY" : "BUY") : (confidence >= 75 ? "STRONG SELL" : "SELL"),
      confidence,
      scantimeframe: cfg.interval,
      entryPrice,
      stopLossPrice,
      tp1Price,
      tp2Price,
      tp3Price,
      rrRatio: `1:${(tp2Offset / slOffset).toFixed(2)}`,
      top5Drivers: drivers,
      riskWarning: "Technical confluence only — no system guarantees binary option outcomes. Manage risk.",
      invalidation: isUp
        ? `Bias invalidated on close below ${(price - slOffset).toFixed(d)}.`
        : `Bias invalidated on close above ${(price + slOffset).toFixed(d)}.`,
    };
  });
