/**
 * XRPUSDT 5m backtest — old strategy vs new (5m-tuned) strategy
 *
 * OLD: EMA8 trend, RSI3<45 entry, RSI3>60 immediate exit, TP+4%, SL-2%, $100 size
 * NEW: EMA20/50 trend, ATR filter, RSI3<45 entry, min 30-min hold, RSI rollover
 *      exit (68→64), TP+1%, SL-0.55%, 20-min cooldown, $1000 size (~£1000)
 */

const SYMBOL      = "XRPUSDT";
const GRANULARITY = "5min";
const DAYS        = 30;
const BATCH       = 200;
const DELAY_MS    = 150;

// ─── Strategy configs ─────────────────────────────────────────────────────────

const OLD = {
  label:          "OLD (1H-style rules on 5m)",
  tradeSize:      100,
  takeProfitPct:  4,
  stopLossPct:    2,
  vwapDist:       1.5,
  rsiEntry:       45,
  useEMA50:       false,
  useATR:         false,
  atrMinPct:      0,
  minHoldBars:    0,     // no minimum hold — exits immediately
  cooldownBars:   0,
  rsiExitMode:    "immediate",
  rsiExitThreshold: 60,
};

const NEW = {
  label:           "NEW (5m-tuned, £1000 paper)",
  tradeSize:       1000,
  takeProfitPct:   1.0,   // tune range: 0.9–1.2
  stopLossPct:     0.55,  // tune range: 0.45–0.65
  vwapDist:        0.75,
  rsiEntry:        45,
  useEMA50:        true,
  useATR:          true,
  atrMinPct:       0.25,
  minHoldBars:     6,     // 6 × 5m = 30 min
  cooldownBars:    4,     // 4 × 5m = 20 min
  rsiExitMode:     "rollover",
  rsiOverbought:   68,
  rsiExitRollover: 64,
};

// ─── Fetch ────────────────────────────────────────────────────────────────────

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

  const seen = new Set();
  return all
    .filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

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

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i], prev = candles[i - 1];
    sum += Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close),
    );
  }
  return sum / period;
}

// ─── Backtest loop (works for both configs) ───────────────────────────────────

function runBacktest(allCandles, cfg) {
  const trades          = [];
  let   openPos         = null;
  let   cooldownUntilIdx = -1;

  // EMA(50) needs 50 bars; add buffer for ATR and initial RSI
  const WARMUP = cfg.useEMA50 ? 60 : 20;

  for (let i = WARMUP; i < allCandles.length; i++) {
    const bar    = allCandles[i];
    const slice  = allCandles.slice(0, i + 1);
    const closes = slice.map((c) => c.close);
    const price  = bar.close;

    const rsi3  = calcRSI(closes, 3);
    const vwap  = sessionVWAP(slice, bar.time);
    if (!rsi3 || !vwap) continue;

    // Trend indicators (new strategy only)
    let ema8 = calcEMA(closes, 8);
    let ema20 = null, ema50 = null;
    if (cfg.useEMA50) {
      ema20 = calcEMA(closes, 20);
      ema50 = calcEMA(closes, 50);
      if (!ema20 || !ema50) continue;
    } else {
      if (!ema8) continue;
    }

    // Volatility filter (new strategy only)
    let atrPct = null;
    if (cfg.useATR) {
      const atr = calcATR(slice, 14);
      if (!atr) continue;
      atrPct = (atr / price) * 100;
    }

    const distVWAP = Math.abs((price - vwap) / vwap) * 100;

    // ── Exit ────────────────────────────────────────────────────────────────
    if (openPos) {
      openPos.barsHeld++;
      openPos.rsiPeak = Math.max(openPos.rsiPeak, rsi3);

      const slPrice = openPos.entry * (1 - cfg.stopLossPct  / 100);
      const tpPrice = openPos.entry * (1 + cfg.takeProfitPct / 100);

      let exitReason = null, exitPrice = price;

      if (cfg.minHoldBars === 0) {
        // Old strategy: all exits are immediate using bar high/low/close
        if      (bar.high >= tpPrice)              { exitReason = "TAKE_PROFIT";   exitPrice = tpPrice; }
        else if (bar.low  <= slPrice)              { exitReason = "STOP_LOSS";     exitPrice = slPrice; }
        else if (rsi3 > cfg.rsiExitThreshold)      { exitReason = "RSI_ABOVE_60";               }
      } else {
        // New strategy: hard SL anytime; TP + RSI rollover only after minHoldBars
        if (bar.low <= slPrice) {
          exitReason = "STOP_LOSS"; exitPrice = slPrice;
        } else if (openPos.barsHeld >= cfg.minHoldBars) {
          if (bar.high >= tpPrice) {
            exitReason = "TAKE_PROFIT"; exitPrice = tpPrice;
          } else if (openPos.rsiPeak >= cfg.rsiOverbought && rsi3 < cfg.rsiExitRollover) {
            exitReason = "RSI_ROLLOVER";
          }
        }
      }

      if (exitReason) {
        const pnlUSD = (exitPrice - openPos.entry) * openPos.qty;
        const pnlPct = ((exitPrice - openPos.entry) / openPos.entry) * 100;
        trades.push({
          entryTime:   openPos.isoTime,
          exitTime:    new Date(bar.time).toISOString().slice(0, 19),
          entryMs:     openPos.entryMs,
          exitMs:      bar.time,
          entry:       openPos.entry,
          exit:        exitPrice,
          qty:         openPos.qty,
          pnlUSD,      pnlPct,
          reason:      exitReason,
          barsHeld:    openPos.barsHeld,
          durationMin: Math.round((bar.time - openPos.entryMs) / 60000),
        });
        openPos = null;
        if (cfg.cooldownBars > 0) cooldownUntilIdx = i + cfg.cooldownBars;
      }
      continue;
    }

    // ── Cooldown ─────────────────────────────────────────────────────────────
    if (i <= cooldownUntilIdx) continue;

    // ── Entry ────────────────────────────────────────────────────────────────
    const bullishBase = cfg.useEMA50 ? (price > ema50 && ema20 > ema50) : (price > ema8);
    const atrOk       = !cfg.useATR  || (atrPct >= cfg.atrMinPct);
    const vwapOk      = distVWAP < cfg.vwapDist;
    const rsiOk       = rsi3 < cfg.rsiEntry;

    if (bullishBase && atrOk && vwapOk && rsiOk) {
      openPos = {
        entry:   price,
        qty:     cfg.tradeSize / price,
        isoTime: new Date(bar.time).toISOString().slice(0, 19),
        entryMs: bar.time,
        barsHeld: 0,
        rsiPeak:  rsi3,
      };
    }
  }

  // Force-close any position still open at end of data
  if (openPos) {
    const last    = allCandles[allCandles.length - 1];
    const pnlUSD  = (last.close - openPos.entry) * openPos.qty;
    const pnlPct  = ((last.close - openPos.entry) / openPos.entry) * 100;
    trades.push({
      entryTime:   openPos.isoTime,
      exitTime:    new Date(last.time).toISOString().slice(0, 19),
      entryMs:     openPos.entryMs,
      exitMs:      last.time,
      entry:       openPos.entry, exit: last.close, qty: openPos.qty,
      pnlUSD,      pnlPct, reason: "END_OF_DATA",
      barsHeld:    openPos.barsHeld,
      durationMin: Math.round((last.time - openPos.entryMs) / 60000),
    });
  }

  return trades;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function calcStats(trades) {
  if (!trades.length) return null;

  const wins    = trades.filter((t) => t.pnlUSD > 0);
  const losses  = trades.filter((t) => t.pnlUSD <= 0);
  const total   = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const wr      = (wins.length / trades.length) * 100;
  const avgWpct = wins.length   ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLpct = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const avgPnl  = total / trades.length;
  const gW      = wins.reduce((s, t)   => s + t.pnlUSD, 0);
  const gL      = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const pf      = gL > 0 ? gW / gL : Infinity;

  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.pnlUSD;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const avgDuration   = trades.reduce((s, t) => s + (t.durationMin || 0), 0) / trades.length;
  const tradesPerWeek = trades.length / (DAYS / 7);
  const tradesPerDay  = trades.length / DAYS;
  const pnlPerHour    = total / (DAYS * 24);

  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const byWeek = {};
  for (const t of trades) {
    const d    = new Date(t.exitTime);
    const yr   = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(yr, 0, 4));
    const wk   = Math.ceil(((d - jan4) / 86400000 + jan4.getUTCDay() + 1) / 7);
    const key  = `${yr}-W${String(wk).padStart(2, "0")}`;
    if (!byWeek[key]) byWeek[key] = { pnl: 0, w: 0, l: 0 };
    byWeek[key].pnl += t.pnlUSD;
    if (t.pnlUSD > 0) byWeek[key].w++; else byWeek[key].l++;
  }

  return {
    count: trades.length,
    wins: wins.length, losses: losses.length,
    total, wr, avgWpct, avgLpct, avgPnl,
    pf, maxDD, avgDuration,
    tradesPerWeek, tradesPerDay, pnlPerHour,
    byReason, byWeek,
  };
}

// ─── Print comparison ─────────────────────────────────────────────────────────

function printComparison(oldTrades, newTrades, fromDt, toDt, totalCandles) {
  const o = calcStats(oldTrades);
  const n = calcStats(newTrades);
  // Normalise old P&L to $1000 trade size for a like-for-like view
  const oldNorm = o ? o.total * (NEW.tradeSize / OLD.tradeSize) : 0;

  const p  = (s, w) => String(s).padEnd(w);
  const pR = (s, w) => String(s).padStart(w);
  const pm = (n)    => (n >= 0 ? "+" : "") + n.toFixed(2);

  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  STRATEGY COMPARISON — XRPUSDT 5M  |  30-day backtest");
  console.log(`  Period: ${fromDt} → ${toDt}  (${totalCandles.toLocaleString()} candles)`);
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(`\n  ${"Metric".padEnd(34)} ${"OLD ($100 size)".padStart(16)}  ${"NEW ($1000 size)".padStart(16)}`);
  console.log("  " + "─".repeat(70));

  if (!o || !n) {
    console.log("  (one or both strategies produced no trades)");
    return;
  }

  const row = (label, ov, nv) =>
    console.log(`  ${p(label, 34)} ${pR(ov, 16)}  ${pR(nv, 16)}`);

  row("Total trades",               o.count,                       n.count);
  row("Win rate",                   o.wr.toFixed(1) + "%",         n.wr.toFixed(1) + "%");
  row("Total P&L (at trade size)",  "$" + pm(o.total),             "$" + pm(n.total));
  row("Total P&L (norm. to $1000)", "$" + pm(oldNorm),             "$" + pm(n.total));
  row("Avg P&L per trade",          "$" + pm(o.avgPnl),            "$" + pm(n.avgPnl));
  row("Avg win",                    "+" + o.avgWpct.toFixed(2) + "%", "+" + n.avgWpct.toFixed(2) + "%");
  row("Avg loss",                   o.avgLpct.toFixed(2) + "%",    n.avgLpct.toFixed(2) + "%");
  row("Profit factor",              isFinite(o.pf) ? o.pf.toFixed(2) : "∞", isFinite(n.pf) ? n.pf.toFixed(2) : "∞");
  row("Max drawdown (at size)",     "$" + o.maxDD.toFixed(2),      "$" + n.maxDD.toFixed(2));
  row("Avg hold time",              o.avgDuration.toFixed(0) + " min",  n.avgDuration.toFixed(0) + " min");
  row("Trades / week",              o.tradesPerWeek.toFixed(1),    n.tradesPerWeek.toFixed(1));
  row("Trades / day",               o.tradesPerDay.toFixed(1),     n.tradesPerDay.toFixed(1));
  row("Est. P&L / hour (at size)",  "$" + o.pnlPerHour.toFixed(3), "$" + n.pnlPerHour.toFixed(3));

  console.log("  " + "─".repeat(70));
  console.log(`\n  Note: 'norm. to $1000' scales old P&L × ${NEW.tradeSize / OLD.tradeSize} so both strategies are comparable.\n`);
}

// ─── Print detailed results for new strategy ──────────────────────────────────

function printNewDetail(trades, cfg) {
  const s = calcStats(trades);
  if (!s) { console.log("No trades triggered for new strategy.\n"); return; }

  const p    = (v, w) => String(v).padEnd(w);
  const sign = (n)    => (n >= 0 ? "+" : "") + n.toFixed(2);

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(`  NEW STRATEGY DETAIL — ${cfg.label}`);
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  console.log("── Summary ─────────────────────────────────────────────────────────────");
  console.log(`  ${"Total trades".padEnd(28)}: ${s.count}`);
  console.log(`  ${"Win rate".padEnd(28)}: ${s.wr.toFixed(1)}%  (${s.wins}W / ${s.losses}L)`);
  console.log(`  ${"Total P&L".padEnd(28)}: $${sign(s.total)}`);
  console.log(`  ${"Avg P&L per trade".padEnd(28)}: $${sign(s.avgPnl)}`);
  console.log(`  ${"Avg win".padEnd(28)}: +${s.avgWpct.toFixed(2)}%  ($${(s.avgWpct / 100 * cfg.tradeSize).toFixed(2)})`);
  console.log(`  ${"Avg loss".padEnd(28)}: ${s.avgLpct.toFixed(2)}%  ($${(s.avgLpct / 100 * cfg.tradeSize).toFixed(2)})`);
  console.log(`  ${"Profit factor".padEnd(28)}: ${isFinite(s.pf) ? s.pf.toFixed(2) : "∞"}`);
  console.log(`  ${"Max drawdown".padEnd(28)}: $${s.maxDD.toFixed(2)}`);
  console.log(`  ${"Avg hold time".padEnd(28)}: ${s.avgDuration.toFixed(0)} min`);
  console.log(`  ${"Trades / week".padEnd(28)}: ${s.tradesPerWeek.toFixed(1)}`);
  console.log(`  ${"Trades / day".padEnd(28)}: ${s.tradesPerDay.toFixed(1)}`);
  console.log(`  ${"Est. P&L / hour".padEnd(28)}: $${s.pnlPerHour.toFixed(3)}`);
  console.log(`  ${"Trade size".padEnd(28)}: $${cfg.tradeSize} (approx. £${Math.round(cfg.tradeSize * 0.79)})`);
  console.log(`  ${"TP / SL".padEnd(28)}: +${cfg.takeProfitPct}% / -${cfg.stopLossPct}%`);
  console.log(`  ${"Min hold / cooldown".padEnd(28)}: ${cfg.minHoldBars} bars (${cfg.minHoldBars * 5} min) / ${cfg.cooldownBars} bars (${cfg.cooldownBars * 5} min)`);
  console.log(`  ${"ATR filter / VWAP dist".padEnd(28)}: >=${cfg.atrMinPct}% / <${cfg.vwapDist}%`);
  console.log(`  ${"RSI exit (rollover)".padEnd(28)}: peak>=${cfg.rsiOverbought} then drops<${cfg.rsiExitRollover}`);

  console.log("\n── Exit reason breakdown ───────────────────────────────────────────────");
  for (const [r, n] of Object.entries(s.byReason)) {
    const pct = (n / s.count * 100).toFixed(0);
    console.log(`  ${r.padEnd(20)}: ${String(n).padEnd(4)} (${pct}%)`);
  }

  console.log("\n── Weekly P&L ──────────────────────────────────────────────────────────");
  for (const [wk, d] of Object.entries(s.byWeek)) {
    const bar = d.pnl >= 0
      ? "▓".repeat(Math.min(Math.ceil(Math.abs(d.pnl) / 5), 30))
      : "░".repeat(Math.min(Math.ceil(Math.abs(d.pnl) / 5), 30));
    const pnlStr = ((d.pnl >= 0 ? "+" : "") + d.pnl.toFixed(2)).padStart(9);
    console.log(`  ${wk}  ${pnlStr}  ${bar}  (${d.w}W/${d.l}L)`);
  }

  console.log("\n── All trades ──────────────────────────────────────────────────────────");
  const h = (s, w) => String(s).padEnd(w);
  console.log("  " + [h("Entry",19), h("Exit",19), h("Entry$",8), h("Exit$",8), h("Hold",6), h("P&L",9), h("P&L%",7), "Reason"].join(""));
  console.log("  " + "─".repeat(99));
  for (const t of trades) {
    const row = [
      h(t.entryTime, 19), h(t.exitTime, 19),
      h("$" + t.entry.toFixed(4), 8), h("$" + t.exit.toFixed(4), 8),
      h(t.durationMin + "m", 6),
      h((t.pnlUSD >= 0 ? "+" : "") + "$" + t.pnlUSD.toFixed(2), 9),
      h((t.pnlPct  >= 0 ? "+" : "") + t.pnlPct.toFixed(2) + "%", 7),
      t.reason,
    ];
    console.log("  " + row.join(""));
  }
  console.log("  " + "─".repeat(99));
  console.log(`  NET P&L: ${s.total >= 0 ? "+" : ""}$${s.total.toFixed(2)}  |  ${s.count} trades  |  ${s.avgDuration.toFixed(0)} min avg hold\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════════");
console.log(`  XRPUSDT 5M  |  ${DAYS}-day backtest  |  OLD vs NEW strategy comparison`);
console.log("═══════════════════════════════════════════════════════════════════════\n");

const candles = await fetchAllCandles();
console.log(`  ${candles.length.toLocaleString()} candles loaded\n`);

if (candles.length < 100) {
  console.error("Not enough candles — check API response");
  process.exit(1);
}

const fromDt = new Date(candles[0].time).toISOString().slice(0, 10);
const toDt   = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);

process.stdout.write("  Running OLD strategy...");
const oldTrades = runBacktest(candles, OLD);
console.log(` ${oldTrades.length} trades`);

process.stdout.write("  Running NEW strategy...");
const newTrades = runBacktest(candles, NEW);
console.log(` ${newTrades.length} trades\n`);

printComparison(oldTrades, newTrades, fromDt, toDt, candles.length);
printNewDetail(newTrades, NEW);
