// Server function: fetches REAL market data from Yahoo Finance (no API key required).
// Computes SMA + RSI on real recent closes and returns a CALL/PUT bias.
// Honesty note: technical indicators describe recent price behavior; they do not
// guarantee future direction on binary options. Use at your own risk.

import { createServerFn } from "@tanstack/react-start";
import type { MarketPriceData, SignalResponse, PhaseCheck, TimeFrameOption } from "./types";

// Map app pair symbols to Yahoo Finance tickers
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
      // Yahoo blocks empty UA from edge runtimes
      "User-Agent":
        "Mozilla/5.0 (compatible; MR-BINARY/1.0; +https://lovable.dev)",
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
    const closes = (r.indicators.quote[0]?.close ?? []).filter(
      (v): v is number => typeof v === "number",
    );
    const highs = (r.indicators.quote[0]?.high ?? []).filter(
      (v): v is number => typeof v === "number",
    );
    const lows = (r.indicators.quote[0]?.low ?? []).filter(
      (v): v is number => typeof v === "number",
    );
    const price = r.meta.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
    const prevClose = r.meta.previousClose ?? r.meta.chartPreviousClose ?? price;
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const sessionHigh = highs.length ? Math.max(...highs) : price;
    const sessionLow = lows.length ? Math.min(...lows) : price;
    return {
      success: true,
      source: "yahoo-finance",
      pair,
      price: parseFloat(price.toFixed(d)),
      change: parseFloat(change.toFixed(4)),
      high: parseFloat(sessionHigh.toFixed(d)),
      low: parseFloat(sessionLow.toFixed(d)),
      timestamp: Date.now(),
    };
  });

function sma(arr: number[], period: number) {
  if (arr.length < period) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(arr: number[], period = 14) {
  if (arr.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

const TF_TO_YAHOO: Record<TimeFrameOption, { interval: string; range: string }> = {
  "1 Min": { interval: "1m", range: "1d" },
  "2 Min": { interval: "2m", range: "1d" },
  "5 Min": { interval: "5m", range: "5d" },
  "15 Min": { interval: "15m", range: "5d" },
  "30 Min": { interval: "30m", range: "1mo" },
};

export const generateSignalFn = createServerFn({ method: "POST" })
  .inputValidator((input: { pair: string; timeFrame: TimeFrameOption }) => input)
  .handler(async ({ data }): Promise<SignalResponse> => {
    const { pair, timeFrame } = data;
    const cfg = TF_TO_YAHOO[timeFrame] ?? TF_TO_YAHOO["1 Min"];
    const r = await fetchYahoo(pair, cfg.interval, cfg.range);
    const d = decimals(pair);
    const closes = (r.indicators.quote[0]?.close ?? []).filter(
      (v): v is number => typeof v === "number",
    );
    if (closes.length < 20) throw new Error("Not enough market data to compute indicators");

    const price = r.meta.regularMarketPrice ?? closes[closes.length - 1];
    const sma5 = sma(closes, 5);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, Math.min(50, closes.length));
    const rsi14 = rsi(closes, 14);
    const last = closes[closes.length - 1];
    const prev3 = closes[closes.length - 4] ?? last;
    const prev10 = closes[closes.length - 11] ?? last;

    // Indicator votes — pure technical alignment. No WAIT option (forced binary).
    let score = 0;
    if (sma5 > sma20) score += 1.2; else score -= 1.2;
    if (sma20 > sma50) score += 0.8; else score -= 0.8;
    if (last > prev3) score += 1.0; else score -= 1.0;
    if (last > prev10) score += 0.6; else score -= 0.6;
    if (rsi14 < 30) score += 1.5;       // oversold → CALL bias
    else if (rsi14 > 70) score -= 1.5;  // overbought → PUT bias
    else if (rsi14 < 45) score += 0.4;
    else if (rsi14 > 55) score -= 0.4;

    const direction: "CALL" | "PUT" = score >= 0 ? "CALL" : "PUT";
    const isUp = direction === "CALL";

    // Confidence reflects how aligned the indicators are (max ~6.5 score).
    const confidence = Math.min(95, Math.max(52, Math.round(50 + Math.abs(score) * 7)));

    // Risk levels from recent volatility (ATR-ish using last 14 candles)
    const tail = closes.slice(-14);
    const ranges = tail.slice(1).map((c, i) => Math.abs(c - tail[i]));
    const atr = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : Math.abs(price) * 0.001;
    const slOffset = atr * 1.5;
    const tp1Offset = atr * 1.0;
    const tp2Offset = atr * 2.2;
    const tp3Offset = atr * 3.6;

    const entryPrice = parseFloat(price.toFixed(d));
    const stopLossPrice = parseFloat((isUp ? price - slOffset : price + slOffset).toFixed(d));
    const tp1Price = parseFloat((isUp ? price + tp1Offset : price - tp1Offset).toFixed(d));
    const tp2Price = parseFloat((isUp ? price + tp2Offset : price - tp2Offset).toFixed(d));
    const tp3Price = parseFloat((isUp ? price + tp3Offset : price - tp3Offset).toFixed(d));

    const phases: PhaseCheck[] = [
      { phase: 1, indicator: `PHASE 1: FETCHING LIVE ${pair} PRICE FROM YAHOO FINANCE...`, accuracy: 100, status: "LIVE_FEED_OK", passed: true },
      { phase: 2, indicator: `PHASE 2: SMA(5)=${sma5.toFixed(d)} vs SMA(20)=${sma20.toFixed(d)}...`, accuracy: 100, status: sma5 > sma20 ? "BULL_CROSS" : "BEAR_CROSS", passed: true },
      { phase: 3, indicator: `PHASE 3: SMA(20)=${sma20.toFixed(d)} vs SMA(50)=${sma50.toFixed(d)}...`, accuracy: 100, status: sma20 > sma50 ? "UPTREND" : "DOWNTREND", passed: true },
      { phase: 4, indicator: `PHASE 4: RSI(14) = ${rsi14.toFixed(2)}...`, accuracy: 100, status: rsi14 < 30 ? "OVERSOLD" : rsi14 > 70 ? "OVERBOUGHT" : "NEUTRAL", passed: true },
      { phase: 5, indicator: `PHASE 5: MOMENTUM CHECK vs LAST 3 / 10 BARS...`, accuracy: 100, status: last > prev3 ? "MOMENTUM_UP" : "MOMENTUM_DOWN", passed: true },
      { phase: 6, indicator: `PHASE 6: VOLATILITY ATR(14) = ${atr.toFixed(d)}, SCORE = ${score.toFixed(2)}...`, accuracy: 100, status: "CONFLUENCE_LOCKED", passed: true },
    ];

    const drivers = isUp
      ? [
          `SMA(5) ${sma5 > sma20 ? "above" : "below"} SMA(20) on ${pair} ${cfg.interval} chart.`,
          `RSI(14) reading at ${rsi14.toFixed(1)} — ${rsi14 < 30 ? "oversold bounce zone" : rsi14 < 50 ? "below midline, recovering" : "above midline"}.`,
          `Price ${last > prev3 ? "above" : "below"} close of 3 bars ago (short momentum).`,
          `Price ${last > prev10 ? "above" : "below"} close of 10 bars ago (mid momentum).`,
          `ATR(14) volatility = ${atr.toFixed(d)} — risk levels sized to current range.`,
        ]
      : [
          `SMA(5) ${sma5 > sma20 ? "above" : "below"} SMA(20) on ${pair} ${cfg.interval} chart.`,
          `RSI(14) reading at ${rsi14.toFixed(1)} — ${rsi14 > 70 ? "overbought exhaustion zone" : rsi14 > 50 ? "above midline, weakening" : "below midline"}.`,
          `Price ${last > prev3 ? "above" : "below"} close of 3 bars ago (short momentum).`,
          `Price ${last > prev10 ? "above" : "below"} close of 10 bars ago (mid momentum).`,
          `ATR(14) volatility = ${atr.toFixed(d)} — risk levels sized to current range.`,
        ];

    return {
      success: true,
      pair,
      direction,
      timeFrame,
      priceAtSignal: entryPrice,
      accuracy: confidence,
      executeTime: new Date(Date.now() + 1500).toISOString().slice(11, 19) + " UTC",
      aiReasoning: `${pair} (${cfg.interval}): SMA cross ${sma5 > sma20 ? "bullish" : "bearish"}, RSI ${rsi14.toFixed(1)}, momentum score ${score.toFixed(2)} → ${direction}.`,
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
      riskWarning: "Technical indicators only — no system guarantees binary option outcomes. Manage risk.",
      invalidation: isUp
        ? `Bias invalidated on close below ${(price - slOffset).toFixed(d)}.`
        : `Bias invalidated on close above ${(price + slOffset).toFixed(d)}.`,
    };
  });
