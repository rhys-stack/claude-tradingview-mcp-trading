/**
 * 30-day XRPUSDT 5m backtest — current strategy
 * Entry:  price > EMA(8)  AND  RSI(3) < 45  AND  distVWAP < 1.5%
 * Exit:   RSI(3) > 60  OR  TP +4%  OR  SL -2%
 */

const SYMBOL      = "XRPUSDT";
const GRANULARITY = "5min";
const DAYS        = 30;
const TP_PCT      = 4;
const SL_PCT      = 2;
const RSI_ENTRY   = 45;
const RSI_EXIT    = 60;
const VWAP_DIST   = 1.5;
const TRADE_SIZE  = 100;
const BATCH       = 200;   // BitGet history-candles max per request
const DELAY_MS    = 150;   // polite delay between requests

// ─── Fetch ───────────────────────────────────────────────────────────────────

async function fetchBatch(endTime) {
  const url =
    `https://api.bitget.com/api/v2/spot/market/history-candles` +
    `?symbol=${SYMBOL}&granularity=${GRANULARITY}&endTime=${endTime}&limit=${BATCH}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.code !== "00000" || !json.data) {
    throw new Error(`BitGet error: ${json.msg || JSON.stringify(json)}`);
  }
  return json.data.map((k) => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchAllCandles() {
  const startMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const all     = [];
  let   endMs   = Date.now();
  let   batches = 0;

  process.stdout.write("  Downloading");

  while (endMs > startMs) {
    const batch = await fetchBatch(endMs);
    if (!batch.length) break;

    // BitGet returns newest-first for history endpoint
    batch.sort((a, b) => a.time - b.time);

    const inRange = batch.filter((c) => c.time >= startMs);
    all.push(...inRange);

    const oldest = batch[0].time;
    if (oldest <= startMs) break;
    endMs = oldest - 1;

    batches++;
    if (batches % 10 === 0) process.stdout.write(".");
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  process.stdout.write(` done (${batches} requests)\n`);

  // Deduplicate and sort ascending
  const seen = new Set();
  return all
    .filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time);
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function sessionVWAP(candles, barTime) {
  const midnight = new Date(barTime);
  midnight.setUTCHours(0, 0, 0, 0);
  const t   = midnight.getTime();
  const ses = candles.filter((c) => c.time >= t && c.time <= barTime);
  if (!ses.length) return null;
  const tpv = ses.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = ses.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

// ─── Backtest loop ────────────────────────────────────────────────────────────

function runBacktest(candles) {
  const trades  = [];
  let   openPos = null;

  const WARMUP = 20;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar    = candles[i];
    const slice  = candles.slice(0, i + 1);
    const closes = slice.map((c) => c.close);
    const price  = bar.close;
    const ema8   = calcEMA(closes, 8);
    const rsi3   = calcRSI(closes, 3);
    const vwap   = sessionVWAP(slice, bar.time);

    if (!ema8 || !rsi3 || !vwap) continue;

    // ── Exit ──────────────────────────────────────────────────────────────
    if (openPos) {
      const tpPrice = openPos.entry * (1 + TP_PCT / 100);
      const slPrice = openPos.entry * (1 - SL_PCT / 100);
      let exitReason = null, exitPrice = price;

      if      (bar.high >= tpPrice) { exitReason = "TAKE_PROFIT";  exitPrice = tpPrice; }
      else if (bar.low  <= slPrice) { exitReason = "STOP_LOSS";    exitPrice = slPrice; }
      else if (rsi3 > RSI_EXIT)     { exitReason = "RSI_ABOVE_60"; exitPrice = price;   }

      if (exitReason) {
        const pnlUSD = (exitPrice - openPos.entry) * openPos.qty;
        const pnlPct = ((exitPrice - openPos.entry) / openPos.entry) * 100;
        trades.push({
          entryTime: openPos.time, exitTime: new Date(bar.time).toISOString().slice(0, 19),
          entry: openPos.entry, exit: exitPrice, qty: openPos.qty,
          pnlUSD, pnlPct, reason: exitReason,
        });
        openPos = null;
      }
      continue;
    }

    // ── Entry ─────────────────────────────────────────────────────────────
    const bullish  = price > ema8;
    const distVWAP = Math.abs((price - vwap) / vwap) * 100;
    if (bullish && rsi3 < RSI_ENTRY && distVWAP < VWAP_DIST) {
      openPos = { entry: price, qty: TRADE_SIZE / price, time: new Date(bar.time).toISOString().slice(0, 19) };
    }
  }

  // Close any open position at end of data
  if (openPos) {
    const last   = candles[candles.length - 1];
    const pnlUSD = (last.close - openPos.entry) * openPos.qty;
    const pnlPct = ((last.close - openPos.entry) / openPos.entry) * 100;
    trades.push({
      entryTime: openPos.time, exitTime: new Date(last.time).toISOString().slice(0, 19),
      entry: openPos.entry, exit: last.close, qty: openPos.qty,
      pnlUSD, pnlPct, reason: "END_OF_DATA",
    });
  }

  return trades;
}

// ─── Stats & display ─────────────────────────────────────────────────────────

function printResults(trades, from, to, totalCandles) {
  if (!trades.length) {
    console.log("\nNo trades triggered in this period.");
    return;
  }

  const wins   = trades.filter((t) => t.pnlUSD > 0);
  const losses = trades.filter((t) => t.pnlUSD <= 0);
  const total  = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const wr     = (wins.length / trades.length) * 100;
  const avgW   = wins.length   ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgL   = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const avgPnl = trades.reduce((s, t) => s + t.pnlUSD, 0) / trades.length;
  const gW     = wins.reduce((s, t)   => s + t.pnlUSD, 0);
  const gL     = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const pf     = gL > 0 ? gW / gL : Infinity;

  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.pnlUSD;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Weekly breakdown (30-day window fits neatly in weeks)
  const byWeek = {};
  for (const t of trades) {
    const d  = new Date(t.exitTime);
    const yr = d.getUTCFullYear();
    // ISO week number
    const jan4 = new Date(Date.UTC(yr, 0, 4));
    const wk   = Math.ceil(((d - jan4) / 86400000 + jan4.getUTCDay() + 1) / 7);
    const key  = `${yr}-W${String(wk).padStart(2, "0")}`;
    if (!byWeek[key]) byWeek[key] = { pnl: 0, w: 0, l: 0 };
    byWeek[key].pnl += t.pnlUSD;
    if (t.pnlUSD > 0) byWeek[key].w++; else byWeek[key].l++;
  }

  // Exit reason breakdown
  const byReason = {};
  for (const t of trades) {
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  }

  const p    = (s, w) => String(s).padEnd(w);
  const sign = (n)    => (n >= 0 ? "+" : "") + n.toFixed(2);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST RESULTS — XRPUSDT 5M  |  Current Strategy");
  console.log(`  Period: ${from} → ${to}  (${DAYS} days, ${totalCandles.toLocaleString()} candles)`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("── Summary ─────────────────────────────────────────────────────");
  console.log(`  ${p("Total trades",        24)}: ${trades.length}`);
  console.log(`  ${p("Win rate",            24)}: ${wr.toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  ${p("Total P&L",           24)}: $${sign(total)}`);
  console.log(`  ${p("Avg profit per trade",24)}: $${sign(avgPnl)}`);
  console.log(`  ${p("Avg win",             24)}: +${avgW.toFixed(2)}%`);
  console.log(`  ${p("Avg loss",            24)}: ${avgL.toFixed(2)}%`);
  console.log(`  ${p("Profit factor",       24)}: ${isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  console.log(`  ${p("Max drawdown",        24)}: $${maxDD.toFixed(2)}`);
  console.log(`  ${p("Trades / week (avg)", 24)}: ${(trades.length / (DAYS / 7)).toFixed(1)}`);
  console.log(`  ${p("Trade size",          24)}: $${TRADE_SIZE}`);
  console.log(`  ${p("Strategy",            24)}: RSI<${RSI_ENTRY} entry | RSI>${RSI_EXIT} exit | TP ${TP_PCT}% | SL ${SL_PCT}%`);

  console.log("\n── Exit reasons ────────────────────────────────────────────────");
  for (const [r, n] of Object.entries(byReason)) {
    console.log(`  ${p(r, 20)}: ${n}`);
  }

  console.log("\n── Weekly P&L ──────────────────────────────────────────────────");
  for (const [wk, d] of Object.entries(byWeek)) {
    const bar = d.pnl >= 0
      ? "▓".repeat(Math.min(Math.round(Math.abs(d.pnl) * 2), 30))
      : "░".repeat(Math.min(Math.round(Math.abs(d.pnl) * 2), 30));
    console.log(`  ${wk}  ${((d.pnl >= 0 ? "+" : "") + d.pnl.toFixed(2)).padStart(8)}  ${bar}  (${d.w}W/${d.l}L)`);
  }

  console.log("\n── All trades ──────────────────────────────────────────────────");
  const h = (s, w) => String(s).padEnd(w);
  console.log("  " + [h("Entry",19), h("Exit",19), h("Entry$",8), h("Exit$",8), h("P&L USD",9), h("P&L%",7), "Reason"].join(""));
  console.log("  " + "─".repeat(90));
  for (const t of trades) {
    const row = [
      h(t.entryTime, 19), h(t.exitTime, 19),
      h("$" + t.entry.toFixed(4), 8), h("$" + t.exit.toFixed(4), 8),
      h((t.pnlUSD >= 0 ? "+" : "") + "$" + t.pnlUSD.toFixed(2), 9),
      h((t.pnlPct >= 0 ? "+" : "") + t.pnlPct.toFixed(2) + "%", 7),
      t.reason,
    ];
    console.log("  " + row.join(""));
  }
  console.log("  " + "─".repeat(90));
  console.log(`  NET P&L: ${total >= 0 ? "+" : ""}$${total.toFixed(2)}  on $${TRADE_SIZE} trade size\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");
console.log(`  XRPUSDT 5M  |  ${DAYS}-day backtest  |  $${TRADE_SIZE} per trade`);
console.log("═══════════════════════════════════════════════════════════════\n");

const candles = await fetchAllCandles();
console.log(`  ${candles.length.toLocaleString()} candles loaded\n`);

if (candles.length < 50) {
  console.error("Not enough candles — check API response");
  process.exit(1);
}

const from   = candles[0].time;
const to     = candles[candles.length - 1].time;
const fromDt = new Date(from).toISOString().slice(0, 10);
const toDt   = new Date(to).toISOString().slice(0, 10);

const trades = runBacktest(candles);
printResults(trades, fromDt, toDt, candles.length);
