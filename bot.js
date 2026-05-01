/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * BitGet (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (ON_RAILWAY) {
    if (missing.length > 0) {
      console.error(`\n❌ Missing Railway environment variables: ${missing.join(", ")}`);
      console.error("   Add them in Railway → your service → Variables tab, then redeploy.\n");
      process.exit(1);
    }
    return;
  }

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — opening it for you to fill in...\n");
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
        "",
        "# Risk management",
        "TAKE_PROFIT_PCT=4",
        "STOP_LOSS_PCT=2",
        "",
        "# Email report (optional — sign up free at resend.com)",
        "RESEND_API_KEY=",
        "REPORT_EMAIL=",
        "REPORT_HOUR=7",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    console.log("Fill in your BitGet credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try { execSync("open .env"); } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "4"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "2"),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY,
    reportTo: process.env.REPORT_EMAIL,
    reportFrom: process.env.REPORT_FROM || "onboarding@resend.dev",
    reportHour: parseInt(process.env.REPORT_HOUR || "7"),
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [], openPosition: null, lastReportDate: null };
  const data = JSON.parse(readFileSync(LOG_FILE, "utf8"));
  if (!("openPosition" in data)) data.openPosition = null;
  if (!("lastReportDate" in data)) data.lastReportDate = null;
  return data;
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.type === "ENTRY").length;
}

// ─── Market Data (BitGet public API — free, no auth, no geo-blocking) ──────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1min",
    "3m": "3min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1H": "1h",
    "4H": "4h",
    "1D": "1D",
    "1W": "1W",
  };
  const granularity = intervalMap[interval] || "1h";

  const url = `https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=${limit}&_t=${Date.now()}`;
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" } });
  if (!res.ok) throw new Error(`BitGet market data error: ${res.status}`);
  const json = await res.json();
  if (json.code !== "00000") throw new Error(`BitGet market data error: ${json.msg}`);

  // BitGet returns newest-first — reverse to oldest-first for indicator calcs
  return json.data.reverse().map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    check("Price above VWAP (buyers in control)", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(8) (uptrend confirmed)", `> ${ema8.toFixed(2)}`, price.toFixed(2), price > ema8);
    check("RSI(3) below 30 (snap-back setup in uptrend)", "< 30", rsi3.toFixed(2), rsi3 < 30);
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 1.5);
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    check("Price below VWAP (sellers in control)", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    check("Price below EMA(8) (downtrend confirmed)", `< ${ema8.toFixed(2)}`, price.toFixed(2), price < ema8);
    check("RSI(3) above 70 (reversal setup in downtrend)", "> 70", rsi3.toFixed(2), rsi3 > 70);
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 1.5);
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(`🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`);
    return false;
  }
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`);
  return true;
}

// ─── Position Management ─────────────────────────────────────────────────────

function checkExitConditions(price, ema8, vwap, openPosition) {
  const { entryPrice, quantity } = openPosition;
  const tpPrice = entryPrice * (1 + CONFIG.takeProfitPct / 100);
  const slPrice = entryPrice * (1 - CONFIG.stopLossPct / 100);
  const bearishBias = price < vwap && price < ema8;

  const unrealisedPnl = (price - entryPrice) * quantity;
  const unrealisedPct = ((price - entryPrice) / entryPrice) * 100;

  console.log("\n── Open Position ─────────────────────────────────────────\n");
  console.log(`  Entry:          $${entryPrice.toFixed(2)} (${openPosition.entryTime.slice(0, 16)} UTC)`);
  console.log(`  Current:        $${price.toFixed(2)}`);
  console.log(`  Unrealised P&L: ${unrealisedPnl >= 0 ? "+" : ""}$${unrealisedPnl.toFixed(2)} (${unrealisedPct.toFixed(2)}%)`);
  console.log(`  Take profit:    $${tpPrice.toFixed(2)} (+${CONFIG.takeProfitPct}%)`);
  console.log(`  Stop loss:      $${slPrice.toFixed(2)} (-${CONFIG.stopLossPct}%)`);

  if (price >= tpPrice) { console.log("  ✅ TAKE PROFIT hit"); return "TAKE_PROFIT"; }
  if (price <= slPrice) { console.log("  🚫 STOP LOSS hit"); return "STOP_LOSS"; }
  if (bearishBias)      { console.log("  🔄 Signal reversal — bearish bias detected"); return "SIGNAL_REVERSAL"; }

  console.log("  ⏳ Holding — no exit condition met");
  return null;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey).update(message).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path = CONFIG.tradeMode === "spot"
    ? "/api/v2/spot/trade/placeOrder"
    : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol, side, orderType: "market", quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES", marginMode: "isolated", marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet order failed: ${data.msg}`);
  return data.data;
}

// ─── CSV Logging ─────────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol",
  "Type", "Side", "Quantity", "Price", "Entry Price",
  "Total USD", "Fee (est.)", "Net Amount",
  "P&L USD", "P&L %", "Exit Reason",
  "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    // 17 leading commas puts this note in the Notes column (index 17)
    const funnyNote = `,,,,,,,,,,,,,,,,,,"NOTE: Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(`📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`);
  }
}

function writeTradeCsv(entry) {
  const now = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let type, side, quantity, price, entryPriceCol, totalUSD, fee, netAmount,
      pnlUSD, pnlPct, exitReason, orderId, mode, notes;

  if (entry.type === "EXIT") {
    type = "EXIT";
    side = "SELL";
    quantity = entry.quantity.toFixed(6);
    price = entry.exitPrice.toFixed(2);
    entryPriceCol = entry.entryPrice.toFixed(2);
    totalUSD = (entry.exitPrice * entry.quantity).toFixed(2);
    fee = (entry.exitPrice * entry.quantity * 0.001).toFixed(4);
    netAmount = ((entry.exitPrice * entry.quantity) - parseFloat(fee)).toFixed(2);
    pnlUSD = entry.pnlUSD.toFixed(2);
    pnlPct = entry.pnlPct.toFixed(2);
    exitReason = entry.exitReason;
    orderId = entry.orderId || "";
    mode = entry.paperTrading ? "PAPER" : "LIVE";
    notes = `Entered ${entry.entryTime.slice(0, 16)} UTC`;
  } else if (entry.type === "ENTRY") {
    type = "ENTRY";
    side = "BUY";
    quantity = entry.quantity.toFixed(6);
    price = entry.entryPrice.toFixed(2);
    entryPriceCol = "";
    totalUSD = entry.tradeSize.toFixed(2);
    fee = (entry.tradeSize * 0.001).toFixed(4);
    netAmount = (entry.tradeSize - parseFloat(fee)).toFixed(2);
    pnlUSD = "";
    pnlPct = "";
    exitReason = "";
    orderId = entry.orderId || "";
    mode = entry.paperTrading ? "PAPER" : "LIVE";
    notes = "Position opened";
  } else {
    type = "BLOCKED";
    side = "";
    quantity = "";
    price = entry.price.toFixed(2);
    entryPriceCol = "";
    totalUSD = "";
    fee = "";
    netAmount = "";
    pnlUSD = "";
    pnlPct = "";
    exitReason = "";
    orderId = "BLOCKED";
    mode = "BLOCKED";
    const failed = (entry.conditions || []).filter((c) => !c.pass).map((c) => c.label).join("; ");
    notes = failed ? `Failed: ${failed}` : (entry.error || "No signal");
  }

  const row = [
    date, time, "BitGet", entry.symbol,
    type, side, quantity, price, entryPriceCol,
    totalUSD, fee, netAmount,
    pnlUSD, pnlPct, exitReason,
    orderId, mode, `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Trade record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  // Column indices: Type=4, Total USD=9, Fee=10, P&L USD=12, Mode=16
  const live    = rows.filter((r) => r[16] === "LIVE");
  const paper   = rows.filter((r) => r[16] === "PAPER");
  const blocked = rows.filter((r) => r[16] === "BLOCKED");
  const exits   = rows.filter((r) => r[4] === "EXIT");
  const wins    = exits.filter((r) => parseFloat(r[12] || 0) > 0);
  const losses  = exits.filter((r) => parseFloat(r[12] || 0) <= 0);
  const totalPnl    = exits.reduce((sum, r) => sum + parseFloat(r[12] || 0), 0);
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[9] || 0), 0);
  const totalFees   = live.reduce((sum, r) => sum + parseFloat(r[10] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total records          : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked signals        : ${blocked.length}`);
  console.log(`  Closed positions       : ${exits.length}`);
  console.log(`  Wins / Losses          : ${wins.length} / ${losses.length}`);
  console.log(`  Total realised P&L     : $${totalPnl.toFixed(2)}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Daily Email Report ──────────────────────────────────────────────────────

function buildReportHtml(log) {
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = log.trades.filter((t) => t.timestamp.startsWith(today));

  const exits   = todayTrades.filter((t) => t.type === "EXIT");
  const entries = todayTrades.filter((t) => t.type === "ENTRY");
  const blocked = todayTrades.filter((t) => t.type === "BLOCKED");
  const wins    = exits.filter((t) => t.pnlUSD > 0);
  const losses  = exits.filter((t) => t.pnlUSD <= 0);
  const totalPnl = exits.reduce((sum, t) => sum + t.pnlUSD, 0);
  const pos = log.openPosition;

  const tr = (label, value, color = "#e0e0e0") =>
    `<tr><td style="padding:4px 16px 4px 0;color:#888">${label}</td><td style="color:${color}"><strong>${value}</strong></td></tr>`;

  return `<html><body style="font-family:monospace;background:#0f0f0f;color:#e0e0e0;padding:24px;max-width:600px">
<h2 style="color:#00d4aa;margin-top:0">📊 Daily Trading Report — ${today}</h2>
<table style="border-collapse:collapse;width:100%">
  ${tr("Symbol", `${CONFIG.symbol} (${CONFIG.paperTrading ? "PAPER" : "LIVE"})`)}
  ${tr("Completed trades", exits.length)}
  ${tr("Wins", wins.length, "#00d4aa")}
  ${tr("Losses", losses.length, losses.length > 0 ? "#ff4d4d" : "#e0e0e0")}
  ${tr("New positions opened", entries.length)}
  ${tr("Blocked signals", blocked.length)}
  ${tr("Total P&L today", `$${totalPnl.toFixed(2)}`, totalPnl >= 0 ? "#00d4aa" : "#ff4d4d")}
</table>

${pos ? `<h3 style="color:#f0c040;margin-top:24px">⏳ Open Position</h3>
<table style="border-collapse:collapse">
  ${tr("Symbol", pos.symbol)}
  ${tr("Entry price", `$${pos.entryPrice.toFixed(2)}`)}
  ${tr("Entered at", `${pos.entryTime.slice(0, 16)} UTC`)}
  ${tr("Size", `$${pos.tradeSize.toFixed(2)}`)}
  ${tr("Take profit / Stop loss", `$${(pos.entryPrice * (1 + CONFIG.takeProfitPct / 100)).toFixed(2)} / $${(pos.entryPrice * (1 - CONFIG.stopLossPct / 100)).toFixed(2)}`)}
</table>` : `<p style="color:#555;margin-top:16px">No open position.</p>`}

${exits.length > 0 ? `<h3 style="color:#e0e0e0;margin-top:24px">Closed Trades</h3>
<table style="border-collapse:collapse;width:100%;font-size:13px">
  <tr style="color:#555;border-bottom:1px solid #222">
    <th style="text-align:left;padding:4px 12px 4px 0">Time</th>
    <th style="text-align:right;padding:4px 12px 4px 0">Entry</th>
    <th style="text-align:right;padding:4px 12px 4px 0">Exit</th>
    <th style="text-align:right;padding:4px 12px 4px 0">P&amp;L</th>
    <th style="text-align:left;padding:4px 0">Reason</th>
  </tr>
  ${exits.map((t) => `<tr>
    <td style="padding:4px 12px 4px 0">${t.timestamp.slice(11, 16)}</td>
    <td style="text-align:right;padding:4px 12px 4px 0">$${t.entryPrice.toFixed(2)}</td>
    <td style="text-align:right;padding:4px 12px 4px 0">$${t.exitPrice.toFixed(2)}</td>
    <td style="text-align:right;padding:4px 12px 4px 0;color:${t.pnlUSD >= 0 ? "#00d4aa" : "#ff4d4d"}">${t.pnlUSD >= 0 ? "+" : ""}$${t.pnlUSD.toFixed(2)} (${t.pnlPct.toFixed(2)}%)</td>
    <td style="padding:4px 0">${t.exitReason}</td>
  </tr>`).join("")}
</table>` : ""}

<p style="color:#333;margin-top:32px;font-size:11px">Sent by Claude Trading Bot • ${new Date().toISOString()}</p>
</body></html>`;
}

function printCsvToLog() {
  if (!existsSync(CSV_FILE)) {
    console.log("📄 No trades.csv found — no trades recorded yet.");
    return;
  }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recent = lines.slice(1).filter((l) => l && !l.startsWith(",") && l.split(",")[0] >= cutoff);

  console.log("\n─── trades.csv — last 24 hours ─────────────────────────────────────────────");
  if (recent.length === 0) {
    console.log("  (no trades in the last 24 hours)");
  } else {
    const h = (s, w) => s.padEnd(w);
    console.log("  " + [h("Date",12), h("Time",10), h("Type",8), h("Side",6), h("Qty",12), h("Price",10), h("P&L USD",10), h("P&L %",9), "Exit Reason"].join(""));
    console.log("  " + "─".repeat(90));
    for (const line of recent) {
      const c = line.split(",");
      const [date, time, , , type, side, qty, price, , , , , pnlUSD, pnlPct, exitReason] = c;
      const pnlStr  = pnlUSD  ? `${parseFloat(pnlUSD)  >= 0 ? "+" : ""}${pnlUSD}`        : "—";
      const pnlPctStr = pnlPct ? `${parseFloat(pnlPct) >= 0 ? "+" : ""}${pnlPct}%`       : "—";
      console.log("  " + [h(date,12), h(time,10), h(type,8), h(side,6), h(qty,12), h(price,10), h(pnlStr,10), h(pnlPctStr,9), exitReason || "—"].join(""));
    }
  }
  console.log("─".repeat(79));
}

async function sendDailyReport(log) {
  if (!CONFIG.email.resendApiKey || !CONFIG.email.reportTo) {
    console.log("⚠️  Email report skipped — set RESEND_API_KEY and REPORT_EMAIL in Railway Variables.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.email.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: CONFIG.email.reportFrom,
        to: [CONFIG.email.reportTo],
        subject: `Trading Report ${today} — ${CONFIG.symbol}`,
        html: buildReportHtml(log),
      }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`📧 Daily report sent → ${CONFIG.email.reportTo}`);
    } else {
      console.log(`⚠️  Email failed: ${data.message || JSON.stringify(data)}`);
    }
  } catch (err) {
    console.log(`⚠️  Email error: ${err.message}`);
  }
}

// ─── Backtest ────────────────────────────────────────────────────────────────

async function runBacktest() {
  const symbol = CONFIG.symbol;
  const tf     = CONFIG.timeframe;
  const tp     = CONFIG.takeProfitPct;
  const sl     = CONFIG.stopLossPct;
  const tSize  = CONFIG.maxTradeSizeUSD;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Backtest Mode");
  console.log(`  Symbol: ${symbol} | Timeframe: ${tf} | TP: ${tp}% | SL: ${sl}%`);
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log("Fetching historical candles from BitGet...");
  const candles = await fetchCandles(symbol, tf, 1000);
  const from = new Date(candles[0].time).toISOString().slice(0, 10);
  const to   = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
  console.log(`  ${candles.length} candles  •  ${from} → ${to}\n`);

  const trades = [];
  let openPos  = null;

  for (let i = 20; i < candles.length; i++) {
    const bar    = candles[i];
    const slice  = candles.slice(0, i + 1);
    const closes = slice.map((c) => c.close);
    const price  = closes[closes.length - 1];
    const ema8   = calcEMA(closes, 8);
    const rsi3   = calcRSI(closes, 3);

    // Session VWAP — only candles from midnight UTC of this bar's day
    const midnight = new Date(bar.time);
    midnight.setUTCHours(0, 0, 0, 0);
    const session = slice.filter((c) => c.time >= midnight.getTime());
    const cumTPV  = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
    const cumVol  = session.reduce((s, c) => s + c.volume, 0);
    const vwap    = cumVol === 0 ? null : cumTPV / cumVol;

    if (!vwap || !rsi3) continue;

    const ts = new Date(bar.time).toISOString();

    // ── Exit check ──────────────────────────────────────────────────────
    if (openPos) {
      const tpPrice = openPos.entryPrice * (1 + tp / 100);
      const slPrice = openPos.entryPrice * (1 - sl / 100);
      let exitReason = null;
      let exitPrice  = price;

      if (bar.high >= tpPrice)          { exitReason = "TAKE_PROFIT";     exitPrice = tpPrice; }
      else if (bar.low <= slPrice)       { exitReason = "STOP_LOSS";       exitPrice = slPrice; }
      else if (price < vwap && price < ema8) { exitReason = "SIGNAL_REVERSAL"; exitPrice = price; }

      if (exitReason) {
        const pnlUSD = (exitPrice - openPos.entryPrice) * openPos.quantity;
        const pnlPct = ((exitPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
        trades.push({ entryTime: openPos.entryTime, exitTime: ts,
                      entryPrice: openPos.entryPrice, exitPrice,
                      quantity: openPos.quantity, pnlUSD, pnlPct, exitReason });
        openPos = null;
      }
      continue;
    }

    // ── Entry check (long only — consistent with live bot) ──────────────
    const bullish  = price > vwap && price > ema8;
    const distVWAP = Math.abs((price - vwap) / vwap) * 100;
    if (bullish && rsi3 < 30 && distVWAP < 1.5) {
      openPos = { entryPrice: price, quantity: tSize / price, entryTime: ts };
    }
  }

  // Close any still-open position at end of data
  if (openPos) {
    const last      = candles[candles.length - 1];
    const exitPrice = last.close;
    const pnlUSD    = (exitPrice - openPos.entryPrice) * openPos.quantity;
    const pnlPct    = ((exitPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
    trades.push({ entryTime: openPos.entryTime, exitTime: new Date(last.time).toISOString(),
                  entryPrice: openPos.entryPrice, exitPrice,
                  quantity: openPos.quantity, pnlUSD, pnlPct, exitReason: "END_OF_DATA" });
  }

  if (trades.length === 0) {
    console.log("No trades triggered. Try a shorter timeframe (e.g. TIMEFRAME=1H) or wider TP/SL.\n");
    return;
  }

  // ── Summary stats ────────────────────────────────────────────────────
  const wins      = trades.filter((t) => t.pnlUSD > 0);
  const losses    = trades.filter((t) => t.pnlUSD <= 0);
  const totalPnl  = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const winRate   = (wins.length / trades.length) * 100;
  const avgWin    = wins.length   ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLoss   = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const grossWin  = wins.reduce((s, t)   => s + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const pf        = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.pnlUSD;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const p = (s, w) => String(s).padEnd(w);
  console.log("─── Backtest Results ─────────────────────────────────────────────────");
  console.log(`  ${p("Total trades",22)}: ${trades.length}`);
  console.log(`  ${p("Win rate",22)}: ${winRate.toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  ${p("Total P&L",22)}: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`  ${p("Avg win",22)}: +${avgWin.toFixed(2)}%`);
  console.log(`  ${p("Avg loss",22)}: ${avgLoss.toFixed(2)}%`);
  console.log(`  ${p("Profit factor",22)}: ${isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  console.log(`  ${p("Max drawdown",22)}: $${maxDD.toFixed(2)}`);
  console.log("──────────────────────────────────────────────────────────────────────\n");

  // Per-trade table
  console.log(`  ${p("Entry Time",22)}${p("Exit Time",22)}${p("Entry $",10)}${p("Exit $",10)}${p("P&L USD",10)}${p("P&L %",8)}Reason`);
  console.log("  " + "─".repeat(95));
  for (const t of trades) {
    const pnlStr    = `${t.pnlUSD >= 0 ? "+" : ""}$${t.pnlUSD.toFixed(2)}`;
    const pnlPctStr = `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`;
    console.log(`  ${p(t.entryTime.slice(0,19),22)}${p(t.exitTime.slice(0,19),22)}$${p(t.entryPrice.toFixed(2),9)}$${p(t.exitPrice.toFixed(2),9)}${p(pnlStr,10)}${p(pnlPctStr,8)}${t.exitReason}`);
  }

  // Save CSV
  const BT_CSV = "backtest-results.csv";
  const header = "Entry Time,Exit Time,Entry Price,Exit Price,Quantity,Trade Size USD,P&L USD,P&L %,Exit Reason\n";
  const rows = trades.map((t) => [
    t.entryTime.slice(0, 19), t.exitTime.slice(0, 19),
    t.entryPrice.toFixed(2),  t.exitPrice.toFixed(2),
    t.quantity.toFixed(6),    (t.quantity * t.entryPrice).toFixed(2),
    t.pnlUSD.toFixed(2),      t.pnlPct.toFixed(2),
    t.exitReason,
  ].join(",")).join("\n");
  writeFileSync(BT_CSV, header + rows + "\n");
  console.log(`\n📄 Saved → ${BT_CSV}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();

  // Fetch market data and calculate indicators
  console.log("\n── Fetching market data from BitGet ────────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);
  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Send daily report once at the configured UTC hour
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = new Date().getUTCHours();
  if (currentHour === CONFIG.email.reportHour && log.lastReportDate !== today) {
    printCsvToLog();
    await sendDailyReport(log);
    log.lastReportDate = today;
    saveLog(log);
  }

  // ── If there's an open position, check exit conditions only ──────────────

  if (log.openPosition) {
    const exitReason = checkExitConditions(price, ema8, vwap, log.openPosition);

    if (exitReason) {
      const pos = log.openPosition;
      const pnlUSD = (price - pos.entryPrice) * pos.quantity;
      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

      let exitOrderId = CONFIG.paperTrading ? `PAPER-EXIT-${Date.now()}` : null;

      if (!CONFIG.paperTrading) {
        try {
          const order = await placeBitGetOrder(CONFIG.symbol, "sell", pos.tradeSize, price);
          exitOrderId = order.orderId;
          console.log(`\n🔴 SELL ORDER PLACED — ${order.orderId}`);
        } catch (err) {
          console.log(`\n❌ SELL ORDER FAILED — ${err.message}`);
        }
      } else {
        const sign = pnlUSD >= 0 ? "+" : "";
        console.log(`\n📋 PAPER EXIT — ${sign}$${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%) — ${exitReason}`);
      }

      const exitEntry = {
        timestamp: new Date().toISOString(),
        type: "EXIT",
        symbol: CONFIG.symbol,
        exitPrice: price,
        entryPrice: pos.entryPrice,
        entryTime: pos.entryTime,
        quantity: pos.quantity,
        tradeSize: pos.tradeSize,
        pnlUSD,
        pnlPct,
        exitReason,
        orderId: exitOrderId,
        paperTrading: CONFIG.paperTrading,
      };

      log.trades.push(exitEntry);
      log.openPosition = null;
      saveLog(log);
      writeTradeCsv(exitEntry);
    }

    // Whether we just exited or are still holding, don't look for a new entry this run
    console.log("\n═══════════════════════════════════════════════════════════\n");
    return;
  }

  // ── No open position — look for entry ────────────────────────────────────

  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log("🚫 TRADE BLOCKED");
    console.log("   Failed conditions:");
    failed.forEach((f) => console.log(`   - ${f}`));

    const blockedEntry = {
      timestamp: new Date().toISOString(),
      type: "BLOCKED",
      symbol: CONFIG.symbol,
      price,
      conditions: results,
    };
    log.trades.push(blockedEntry);
    saveLog(log);
    writeTradeCsv(blockedEntry);
  } else {
    console.log("✅ ALL CONDITIONS MET");

    const quantity = tradeSize / price;
    let orderId = CONFIG.paperTrading ? `PAPER-${Date.now()}` : null;

    if (!CONFIG.paperTrading) {
      try {
        const order = await placeBitGetOrder(CONFIG.symbol, "buy", tradeSize, price);
        orderId = order.orderId;
        console.log(`\n🔴 LIVE BUY ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`\n❌ BUY ORDER FAILED — ${err.message}`);
        const failedEntry = {
          timestamp: new Date().toISOString(),
          type: "BLOCKED",
          symbol: CONFIG.symbol,
          price,
          conditions: results,
          error: err.message,
        };
        log.trades.push(failedEntry);
        saveLog(log);
        writeTradeCsv(failedEntry);
        console.log("\n═══════════════════════════════════════════════════════════\n");
        return;
      }
    } else {
      console.log(`\n📋 PAPER BUY — $${tradeSize.toFixed(2)} of ${CONFIG.symbol} at $${price.toFixed(2)}`);
      console.log(`   Take profit: $${(price * (1 + CONFIG.takeProfitPct / 100)).toFixed(2)} | Stop loss: $${(price * (1 - CONFIG.stopLossPct / 100)).toFixed(2)}`);
    }

    const entryEntry = {
      timestamp: new Date().toISOString(),
      type: "ENTRY",
      symbol: CONFIG.symbol,
      entryPrice: price,
      quantity,
      tradeSize,
      orderId,
      paperTrading: CONFIG.paperTrading,
    };

    log.openPosition = {
      symbol: CONFIG.symbol,
      entryPrice: price,
      quantity,
      tradeSize,
      entryTime: entryEntry.timestamp,
      entryOrderId: orderId,
    };

    log.trades.push(entryEntry);
    saveLog(log);
    writeTradeCsv(entryEntry);
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.argv.includes("--backtest")) {
  runBacktest().catch((err) => {
    console.error("Backtest error:", err);
    process.exit(1);
  });
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
