import express from “express”;
import fetch from “node-fetch”;
import crypto from “crypto”;
import pkg from “pg”;

const { Pool } = pkg;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
res.header(“Access-Control-Allow-Origin”, “*”);
res.header(“Access-Control-Allow-Headers”, “*”);
next();
});

const PORT = process.env.PORT || 3000;
const KEY = process.env.KRAKEN_KEY;
const SECRET = process.env.KRAKEN_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN || “cipher2024”;
const DATABASE_URL = process.env.DATABASE_URL;
const API = “https://api.kraken.com”;

// ═══════════════════════════════════════
// DB
// ═══════════════════════════════════════
const pool = DATABASE_URL ? new Pool({
connectionString: DATABASE_URL,
ssl: { rejectUnauthorized: false }
}) : null;

async function initDB() {
if (!pool) return console.log(“⚠️  No DATABASE_URL — running without persistence”);
await pool.query(`CREATE TABLE IF NOT EXISTS trades ( id SERIAL PRIMARY KEY, pair TEXT, side TEXT, entry FLOAT, exit_price FLOAT, profit FLOAT, confidence FLOAT, features JSONB, signal TEXT, timestamp TIMESTAMPTZ DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS equity_log ( id SERIAL PRIMARY KEY, equity FLOAT, timestamp TIMESTAMPTZ DEFAULT NOW() );`);
console.log(“✅ DB ready”);
}

async function saveTrade(trade) {
if (!pool) return;
await pool.query(
`INSERT INTO trades (pair, side, entry, exit_price, profit, confidence, features, signal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
[trade.pair, trade.side, trade.entry, trade.exit, trade.profit,
trade.confidence, JSON.stringify(trade.features), trade.signal]
);
}

async function logEquity(eq) {
if (!pool) return;
await pool.query(“INSERT INTO equity_log (equity) VALUES ($1)”, [eq]);
}

async function getTrades(limit = 100) {
if (!pool) return inMemoryTrades.slice(-limit);
const r = await pool.query(“SELECT * FROM trades ORDER BY id DESC LIMIT $1”, [limit]);
return r.rows;
}

async function getEquityHistory(limit = 100) {
if (!pool) return equityHistory.slice(-limit);
const r = await pool.query(“SELECT equity FROM equity_log ORDER BY id DESC LIMIT $1”, [limit]);
return r.rows.map(r => r.equity).reverse();
}

// ═══════════════════════════════════════
// KRAKEN PAIRS — FIX: correct Kraken pair names
// ═══════════════════════════════════════
const PAIRS = [“XBT/USD”, “ETH/USD”, “SOL/USD”];
const KRAKEN_MAP = {
“XBT/USD”: “XBTUSD”,
“ETH/USD”: “ETHUSD”,
“SOL/USD”: “SOLUSD”
};
const DISPLAY_MAP = {
“XBT/USD”: “BTC”,
“ETH/USD”: “ETH”,
“SOL/USD”: “SOL”
};

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const CFG = {
BASE_RISK: 0.015,         // 1.5% risk per trade
MAX_POSITIONS: 3,
TRADE_INTERVAL_MS: 8000,
MAX_HISTORY: 100,
STOP_LOSS: 0.985,         // -1.5% stop
TAKE_PROFIT: 1.035,       // +3.5% target
TRAILING_STOP: 0.988,     // trail from peak
MAX_TRADE_AGE_MS: 45 * 60 * 1000,
MIN_CONFIDENCE: 0.62,
BTC_CONFIRMATION: true,   // only trade when BTC trend is up
WHALE_REQUIRED: true,     // require whale volume signal
FAKE_BREAKOUT_FILTER: true,
DRAWDOWN_HALT: 0.85,      // halt trading at 15% drawdown
LOSING_STREAK_REDUCE: 3,  // reduce size after 3 losses
COMPOUND: true            // compound profits
};

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
let history = {};
let positions = [];
let tradingEnabled = true;
let equity = 0;         // will be loaded from real balance
let peakEquity = 0;
let losingStreak = 0;
let totalTrades = 0;
let totalWins = 0;
let inMemoryTrades = [];
let equityHistory = [];
let lastPrices = {};
let botStartTime = Date.now();
let loopCount = 0;

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════
function auth(req, res, next) {
const token = req.query.token || req.headers[“x-bot-token”];
if (token !== BOT_TOKEN) return res.status(401).json({ error: “Unauthorized” });
next();
}

// ═══════════════════════════════════════
// KRAKEN SIGNING — FIX: was computing hash incorrectly
// ═══════════════════════════════════════
function sign(path, params, secret) {
const nonce = params.nonce.toString();
const postData = new URLSearchParams(params).toString();
const message = nonce + postData;
const secretBuffer = Buffer.from(secret, “base64”);
const pathBuffer = Buffer.from(path);
const sha256 = crypto.createHash(“sha256”).update(message).digest();
const combined = Buffer.concat([pathBuffer, sha256]);
return crypto.createHmac(“sha512”, secretBuffer).update(combined).digest(“base64”);
}

async function privateCall(path, params = {}) {
if (!KEY || !SECRET) throw new Error(“No API keys configured”);
const nonce = Date.now().toString();
const body = { nonce, …params };
const sig = sign(path, body, SECRET);
const res = await fetch(API + path, {
method: “POST”,
headers: {
“API-Key”: KEY,
“API-Sign”: sig,
“Content-Type”: “application/x-www-form-urlencoded”
},
body: new URLSearchParams(body).toString()
});
const data = await res.json();
if (data.error?.length) throw new Error(data.error.join(”, “));
return data.result;
}

// ═══════════════════════════════════════
// MARKET DATA — FIX: proper pair mapping
// ═══════════════════════════════════════
async function getMarket() {
const krakenPairs = PAIRS.map(p => KRAKEN_MAP[p]).join(”,”);
const res = await fetch(`${API}/0/public/Ticker?pair=${krakenPairs}`);
const data = await res.json();
if (data.error?.length) throw new Error(data.error.join(”, “));

const out = {};
// FIX: match by Kraken response key, not by index
for (const [pair] of Object.entries(KRAKEN_MAP)) {
const krakenKey = KRAKEN_MAP[pair];
// Kraken sometimes returns slightly different key names
const resultKey = Object.keys(data.result).find(k =>
k.includes(krakenKey.replace(“XBT”, “XBT”).replace(“USD”, “USD”)) ||
k.toUpperCase().includes(DISPLAY_MAP[pair])
);
if (!resultKey) continue;
const v = data.result[resultKey];
const price = parseFloat(v.c[0]);
const vwap24 = parseFloat(v.p[1]);
const volume24 = parseFloat(v.v[1]);
out[pair] = {
price,
volume: volume24,
vwap: vwap24,
high24: parseFloat(v.h[1]),
low24: parseFloat(v.l[1]),
trades24: parseInt(v.t[1]),
change24h: vwap24 > 0 ? (price - vwap24) / vwap24 : 0
};
lastPrices[pair] = price;
}
return out;
}

// ═══════════════════════════════════════
// BALANCE — load real USD balance
// ═══════════════════════════════════════
async function loadBalance() {
try {
const bal = await privateCall(”/0/private/Balance”);
const usd = parseFloat(bal.ZUSD || bal.USD || 0);
if (usd > 0 && equity === 0) {
equity = usd;
peakEquity = usd;
console.log(`💰 Balance loaded: $${usd.toFixed(2)}`);
}
return bal;
} catch (e) {
console.log(“Balance error:”, e.message);
return {};
}
}

// ═══════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════
function updateHistory(pair, price, volume) {
if (!history[pair]) history[pair] = { prices: [], volumes: [], highs: [], lows: [] };
history[pair].prices.push(price);
history[pair].volumes.push(volume);
if (history[pair].prices.length > CFG.MAX_HISTORY) {
history[pair].prices.shift();
history[pair].volumes.shift();
}
}

// ═══════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════
function calcRSI(prices, period = 14) {
if (prices.length < period + 1) return 50;
let gains = 0, losses = 0;
for (let i = prices.length - period; i < prices.length; i++) {
const diff = prices[i] - prices[i - 1];
if (diff > 0) gains += diff;
else losses -= diff;
}
const avgGain = gains / period;
const avgLoss = losses / period;
if (avgLoss === 0) return 100;
const rs = avgGain / avgLoss;
return 100 - 100 / (1 + rs);
}

function calcEMA(prices, period) {
if (prices.length < period) return prices[prices.length - 1];
const k = 2 / (period + 1);
let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
for (let i = period; i < prices.length; i++) {
ema = prices[i] * k + ema * (1 - k);
}
return ema;
}

function calcMACD(prices) {
if (prices.length < 26) return { macd: 0, signal: 0, hist: 0 };
const ema12 = calcEMA(prices, 12);
const ema26 = calcEMA(prices, 26);
const macd = ema12 - ema26;
// simplified signal
const signal = macd * 0.9;
return { macd, signal, hist: macd - signal };
}

function calcBollingerBands(prices, period = 20) {
if (prices.length < period) return { upper: 0, mid: 0, lower: 0 };
const slice = prices.slice(-period);
const mid = slice.reduce((a, b) => a + b) / period;
const variance = slice.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period;
const std = Math.sqrt(variance);
return { upper: mid + 2 * std, mid, lower: mid - 2 * std, std };
}

// ═══════════════════════════════════════
// STRATEGY LAYERS (from screenshot)
// ═══════════════════════════════════════

// STRATEGY LAYER: ML prediction + pattern recognition + whale detection
function strategyLayer(pair) {
const h = history[pair];
if (!h || h.prices.length < 30) return null;
const prices = h.prices;
const volumes = h.volumes;
const price = prices[prices.length - 1];

const rsi = calcRSI(prices);
const macd = calcMACD(prices);
const bb = calcBollingerBands(prices);
const ema9 = calcEMA(prices, 9);
const ema21 = calcEMA(prices, 21);

// Momentum score
const rsiScore = rsi < 35 ? 1 : rsi < 45 ? 0.7 : rsi > 70 ? -1 : 0.3;
const macdScore = macd.hist > 0 ? 0.8 : -0.5;
const emaScore = ema9 > ema21 ? 0.7 : -0.4;

// Pattern recognition: higher lows
const recentLows = prices.slice(-5);
const higherLows = recentLows.every((v, i) => i === 0 || v >= recentLows[i - 1] * 0.998);

// Whale detection: volume spike
const volAvg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
const lastVol = volumes[volumes.length - 1];
const whale = lastVol > volAvg * 1.8;
const whaleBig = lastVol > volAvg * 2.5;

// Support/resistance
const nearSupport = price <= bb.lower * 1.005;
const nearResistance = price >= bb.upper * 0.995;

// Short and long trends
const short5 = prices.slice(-5);
const long20 = prices.slice(-20);
const shortTrend = (short5[short5.length - 1] - short5[0]) / short5[0];
const longTrend = (long20[long20.length - 1] - long20[0]) / long20[0];

return {
rsi, macd, bb, ema9, ema21,
rsiScore, macdScore, emaScore,
whale, whaleBig, higherLows,
nearSupport, nearResistance,
shortTrend, longTrend,
price, volRatio: lastVol / (volAvg || 1)
};
}

// MARKET LAYER: multi-timeframe + BTC confirmation + fake breakout filter
function marketLayer(pair, f) {
if (!f) return false;
const btcF = strategyLayer(“XBT/USD”);

// BTC confirmation: only trade alts when BTC is bullish
if (CFG.BTC_CONFIRMATION && pair !== “XBT/USD” && btcF) {
if (btcF.shortTrend < -0.005) return false; // BTC dropping — skip
if (btcF.rsi < 30) return false; // BTC oversold panic
}

// Fake breakout filter: price must close above breakout level
if (CFG.FAKE_BREAKOUT_FILTER) {
// Require at least 2 candles confirming upward move
const prices = history[pair]?.prices || [];
if (prices.length >= 3) {
const last3 = prices.slice(-3);
const confirmedMove = last3[2] > last3[1] && last3[1] > last3[0];
if (!confirmedMove && f.shortTrend > 0.01) return false;
}
}

// Multi-timeframe: short and long trend must align
if (f.shortTrend < 0 && f.longTrend < 0) return false;

return true;
}

// FUND LAYER: compounding + adaptive sizing + drawdown control + losing streak protection
function fundLayer(confidence) {
let risk = CFG.BASE_RISK;

// Adaptive sizing: scale with confidence
risk *= confidence;

// Losing streak protection
if (losingStreak >= CFG.LOSING_STREAK_REDUCE) {
risk *= Math.max(0.3, 1 - losingStreak * 0.15);
}

// Drawdown control
if (peakEquity > 0) {
const dd = equity / peakEquity;
if (dd < CFG.DRAWDOWN_HALT) { tradingEnabled = false; return 0; }
if (dd < 0.92) risk *= 0.4;
else if (dd < 0.96) risk *= 0.7;
}

// Compounding: use actual current equity
const positionUSD = (CFG.COMPOUND ? equity : peakEquity * 0.5) * risk;
return Math.max(5, Math.min(200, positionUSD)); // $5 min, $200 max per trade
}

// ═══════════════════════════════════════
// ML CONFIDENCE (pattern-based)
// ═══════════════════════════════════════
async function mlConfidence(pair, f) {
if (!f) return 0.5;

// Score from technical indicators
let score = 0.5;
score += f.rsiScore * 0.15;
score += f.macdScore * 0.15;
score += f.emaScore * 0.1;
if (f.whale) score += 0.1;
if (f.whaleBig) score += 0.05;
if (f.higherLows) score += 0.08;
if (f.nearSupport) score += 0.1;
if (f.shortTrend > 0.003) score += 0.08;
if (f.longTrend > 0.005) score += 0.05;

// Historical pattern similarity from DB
try {
const trades = await getTrades(200);
if (trades.length >= 20) {
let simScore = 0, simCount = 0;
for (const t of trades) {
const tf = t.features || {};
const sim = 1 -
Math.abs((f.shortTrend || 0) - (tf.shortTrend || 0)) * 10 -
Math.abs((f.rsi - 50) / 50 - ((tf.rsi - 50) / 50 || 0));
if (sim > 0.6) {
simScore += parseFloat(t.profit || 0);
simCount++;
}
}
if (simCount > 5) {
const histAdj = Math.max(-0.1, Math.min(0.1, simScore / simCount * 2));
score += histAdj;
}
}
} catch (e) {}

return Math.max(0, Math.min(1, score));
}

// ═══════════════════════════════════════
// EXECUTE BUY
// ═══════════════════════════════════════
async function executeBuy(pair, confidence, f) {
if (!tradingEnabled) return false;
if (positions.length >= CFG.MAX_POSITIONS) return false;
if (positions.find(p => p.pair === pair)) return false;

const price = history[pair]?.prices?.at(-1);
if (!price) return false;

const capitalUSD = fundLayer(confidence);
if (capitalUSD <= 0) return false;

const volume = (capitalUSD / price).toFixed(8);
const minVol = pair === “XBT/USD” ? 0.0001 : pair === “ETH/USD” ? 0.002 : 0.1;
if (parseFloat(volume) < minVol) {
console.log(`⚠️  Volume ${volume} below Kraken minimum for ${pair}`);
return false;
}

try {
const krakenPair = KRAKEN_MAP[pair];
const result = await privateCall(”/0/private/AddOrder”, {
pair: krakenPair,
type: “buy”,
ordertype: “market”,
volume
});

```
const txid = result.txid?.[0] || "unknown";
positions.push({
  pair, entry: price, volume: parseFloat(volume),
  peak: price, confidence, features: f,
  capital: capitalUSD, openedAt: Date.now(), txid
});

console.log(`✅ BUY ${DISPLAY_MAP[pair]} @ $${price.toFixed(2)} | Vol: ${volume} | Conf: ${(confidence * 100).toFixed(0)}% | TX: ${txid}`);
return true;
```

} catch (e) {
console.log(`❌ BUY failed ${pair}:`, e.message);
return false;
}
}

// ═══════════════════════════════════════
// EXECUTE SELL
// ═══════════════════════════════════════
async function executeSell(pos, price, reason = “signal”) {
try {
const krakenPair = KRAKEN_MAP[pos.pair];
await privateCall(”/0/private/AddOrder”, {
pair: krakenPair,
type: “sell”,
ordertype: “market”,
volume: pos.volume.toFixed(8)
});

```
const profit = (price - pos.entry) / pos.entry;
const pnlUSD = pos.capital * profit;

// Update equity
equity += pnlUSD;
if (equity > peakEquity) peakEquity = equity;
if (profit < 0) losingStreak++;
else { losingStreak = 0; totalWins++; }
totalTrades++;

equityHistory.push(equity);
if (equityHistory.length > 500) equityHistory.shift();
logEquity(equity).catch(() => {});

const trade = {
  pair: pos.pair, side: "sell", entry: pos.entry, exit: price,
  profit, pnlUSD, confidence: pos.confidence, features: pos.features, signal: reason
};
inMemoryTrades.unshift(trade);
if (inMemoryTrades.length > 200) inMemoryTrades.pop();
saveTrade(trade).catch(() => {});

console.log(`${profit >= 0 ? "✅" : "❌"} SELL ${DISPLAY_MAP[pos.pair]} @ $${price.toFixed(2)} | P&L: ${profit >= 0 ? "+" : ""}${(profit * 100).toFixed(2)}% ($${pnlUSD.toFixed(2)}) | ${reason}`);
```

} catch (e) {
console.log(`❌ SELL failed ${pos.pair}:`, e.message);
}
}

// ═══════════════════════════════════════
// MAIN TRADING LOOP
// ═══════════════════════════════════════
setInterval(async () => {
loopCount++;
try {
// 1. Fetch market data
const market = await getMarket();
for (const [pair, data] of Object.entries(market)) {
updateHistory(pair, data.price, data.volume);
}

```
// 2. Load balance every 10 loops
if (loopCount % 10 === 1) await loadBalance();

// 3. Manage open positions
for (let i = positions.length - 1; i >= 0; i--) {
  const pos = positions[i];
  const price = history[pos.pair]?.prices?.at(-1);
  if (!price) continue;

  if (price > pos.peak) pos.peak = price;

  const ageMs = Date.now() - pos.openedAt;
  const stopHit = price < pos.entry * CFG.STOP_LOSS;
  const targetHit = price > pos.entry * CFG.TAKE_PROFIT;
  const trailingHit = price < pos.peak * CFG.TRAILING_STOP;
  const tooOld = ageMs > CFG.MAX_TRADE_AGE_MS;

  let reason = null;
  if (stopHit) reason = "stop_loss";
  else if (targetHit) reason = "take_profit";
  else if (trailingHit && price > pos.entry) reason = "trailing_stop";
  else if (tooOld) reason = "timeout";

  if (reason) {
    await executeSell(pos, price, reason);
    positions.splice(i, 1);
  }
}

if (!tradingEnabled) return;

// 4. Look for new trades
for (const pair of PAIRS) {
  const f = strategyLayer(pair);
  if (!f) continue;

  // Market layer gates
  if (!marketLayer(pair, f)) continue;

  // Whale required
  if (CFG.WHALE_REQUIRED && !f.whale) continue;

  // Must have upward signals
  if (f.shortTrend < 0.001) continue;
  if (f.rsi > 72) continue; // overbought

  const confidence = await mlConfidence(pair, f);
  if (confidence < CFG.MIN_CONFIDENCE) continue;

  const opened = await executeBuy(pair, confidence, {
    shortTrend: f.shortTrend, longTrend: f.longTrend,
    rsi: f.rsi, whale: f.whale, volRatio: f.volRatio
  });
  if (opened) break; // one trade per loop
}
```

} catch (e) {
console.log(“🔄 Loop error:”, e.message);
}
}, CFG.TRADE_INTERVAL_MS);

// ═══════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════
app.get(”/”, (req, res) => res.json({ status: “CIPHER BOT LIVE”, uptime: Math.floor((Date.now() - botStartTime) / 1000) }));

app.get(”/api/status”, auth, async (req, res) => {
const trades = await getTrades(50);
const eqHistory = await getEquityHistory(60);
const pnlPct = trades.reduce((a, b) => a + parseFloat(b.profit || 0), 0) * 100;
const wins = trades.filter(t => parseFloat(t.profit) > 0).length;

const marketData = {};
for (const pair of PAIRS) {
marketData[DISPLAY_MAP[pair]] = {
price: lastPrices[pair] || null,
prices: (history[pair]?.prices || []).slice(-50)
};
}

res.json({
tradingEnabled, equity, peakEquity,
drawdownPct: peakEquity > 0 ? (1 - equity / peakEquity) * 100 : 0,
losingStreak, totalTrades, winRate: totalTrades ? (totalWins / totalTrades * 100) : 0,
positions: positions.map(p => ({
…p,
currentPrice: lastPrices[p.pair] || p.entry,
unrealizedPnl: lastPrices[p.pair] ? (lastPrices[p.pair] - p.entry) / p.entry * 100 : 0,
display: DISPLAY_MAP[p.pair]
})),
pnlPct, trades, market: marketData,
equityHistory: eqHistory,
uptime: Math.floor((Date.now() - botStartTime) / 1000),
loopCount
});
});

app.get(”/api/balance”, auth, async (req, res) => {
try { res.json(await privateCall(”/0/private/Balance”)); }
catch (e) { res.status(500).json({ error: e.message }); }
});

app.get(”/toggle”, auth, (req, res) => {
tradingEnabled = !tradingEnabled;
if (tradingEnabled && equity / peakEquity < CFG.DRAWDOWN_HALT) {
tradingEnabled = false;
return res.json({ trading: false, reason: “Drawdown limit reached” });
}
res.json({ trading: tradingEnabled });
});

app.post(”/sellall”, auth, async (req, res) => {
const closed = [];
for (const pos of […positions]) {
const price = lastPrices[pos.pair] || pos.entry;
await executeSell(pos, price, “manual_close”);
closed.push(pos.pair);
}
positions = [];
res.json({ closed });
});

app.post(”/config”, auth, (req, res) => {
const allowed = [“BASE_RISK”,“MAX_POSITIONS”,“STOP_LOSS”,“TAKE_PROFIT”,“MIN_CONFIDENCE”,“BTC_CONFIRMATION”,“WHALE_REQUIRED”];
for (const key of allowed) {
if (req.body[key] !== undefined) CFG[key] = req.body[key];
}
res.json({ updated: CFG });
});

// ═══════════════════════════════════════
// MOBILE CONTROL PANEL
// ═══════════════════════════════════════
app.get(”/control”, auth, (req, res) => {
res.send(`<!DOCTYPE html>

<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>CIPHER BOT</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=Fira+Code:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#000;--s1:#0a0a0a;--s2:#111;--border:#222;--acc:#f7931a;--green:#00e676;--red:#ff3355;--text:#f0f0f0;--muted:#555}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;padding-bottom:20px}
.hdr{padding:16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.logo{font-size:1.2rem;font-weight:800;letter-spacing:4px;color:var(--acc)}
.live{font-size:0.65rem;font-weight:700;padding:4px 10px;border-radius:20px;letter-spacing:2px}
.live.on{background:rgba(0,230,118,0.1);color:var(--green);border:1px solid rgba(0,230,118,0.3)}
.live.off{background:rgba(255,51,85,0.1);color:var(--red);border:1px solid rgba(255,51,85,0.3)}
.wrap{padding:12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.card{background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:14px}
.cl{font-size:0.6rem;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
.cv{font-family:'Fira Code',monospace;font-size:1.2rem;font-weight:700}
.pos{color:var(--green)}.neg{color:var(--red)}
canvas{width:100%;height:100px;display:block}
.btns{display:flex;gap:8px;margin-bottom:12px}
.btn{flex:1;border:none;border-radius:10px;padding:14px;font-family:'Syne',sans-serif;font-size:0.8rem;font-weight:800;letter-spacing:2px;cursor:pointer}
.btn-g{background:rgba(0,230,118,0.15);color:var(--green);border:1px solid rgba(0,230,118,0.3)}
.btn-r{background:rgba(255,51,85,0.12);color:var(--red);border:1px solid rgba(255,51,85,0.3)}
.btn-o{background:rgba(247,147,26,0.12);color:var(--acc);border:1px solid rgba(247,147,26,0.3)}
.sec{margin-bottom:12px}
.st{font-size:0.6rem;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}
.pos-item,.tl-item{background:var(--s1);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:6px;font-size:0.82rem}
.row{display:flex;justify-content:space-between;align-items:center}
.muted{color:var(--muted);font-size:0.7rem}
pre{font-family:'Fira Code',monospace;font-size:0.72rem;color:#aaa;line-height:1.5;white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body>
<div class="hdr">
  <div class="logo">CIPHER</div>
  <div class="live off" id="liveBadge">LOADING</div>
</div>
<div class="wrap">
  <div class="grid2">
    <div class="card"><div class="cl">Equity</div><div class="cv" id="eq">--</div></div>
    <div class="card"><div class="cl">P&L</div><div class="cv" id="pnl">--</div></div>
    <div class="card"><div class="cl">Win Rate</div><div class="cv" id="wr">--</div></div>
    <div class="card"><div class="cl">Positions</div><div class="cv" id="pc">0</div></div>
  </div>
  <div class="card" style="margin-bottom:10px">
    <div class="cl" style="margin-bottom:8px">Equity Curve</div>
    <canvas id="chart"></canvas>
  </div>
  <div class="btns">
    <button class="btn btn-g" id="toggleBtn">⏯ TOGGLE</button>
    <button class="btn btn-r" id="sellBtn">⏹ CLOSE ALL</button>
    <button class="btn btn-o" id="balBtn">💰 BALANCE</button>
  </div>
  <div class="sec"><div class="st">Open Positions</div><div id="posWrap"></div></div>
  <div class="sec"><div class="st">Trade History</div><div id="tlWrap"></div></div>
  <div class="card"><div class="cl" style="margin-bottom:8px">Balance</div><pre id="balView">Tap BALANCE to load</pre></div>
</div>
<script>
const TOKEN="${BOT_TOKEN}";
const api=(p,o={})=>fetch(p+(p.includes("?")?"&":"?")+"token="+encodeURIComponent(TOKEN),o).then(r=>r.json());
function pct(v){const n=+v||0;return(n>=0?"+":"")+n.toFixed(2)+"%"}
function drawChart(id,data){
  const c=document.getElementById(id);
  if(!c)return;
  const ctx=c.getContext("2d");
  const W=c.offsetWidth||300,H=100;
  c.width=W;c.height=H;
  if(!data||data.length<2){ctx.fillStyle="#111";ctx.fillRect(0,0,W,H);return}
  const min=Math.min(...data),max=Math.max(...data,min+0.01),range=max-min;
  const pts=data.map((v,i)=>({x:i/(data.length-1)*W,y:H-4-(v-min)/range*(H-12)}));
  ctx.fillStyle="#0a0a0a";ctx.fillRect(0,0,W,H);
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,"rgba(247,147,26,0.15)");g.addColorStop(1,"transparent");
  ctx.beginPath();ctx.moveTo(0,H);pts.forEach(p=>ctx.lineTo(p.x,p.y));ctx.lineTo(W,H);ctx.closePath();
  ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
  ctx.strokeStyle="#f7931a";ctx.lineWidth=1.5;ctx.stroke();
}
async function refresh(){
  const d=await api("/api/status");
  document.getElementById("liveBadge").textContent=d.tradingEnabled?"LIVE":"PAUSED";
  document.getElementById("liveBadge").className="live "+(d.tradingEnabled?"on":"off");
  document.getElementById("eq").textContent="$"+(+d.equity||0).toFixed(2);
  const pnlEl=document.getElementById("pnl");
  pnlEl.textContent=pct(d.pnlPct);
  pnlEl.className="cv "+(d.pnlPct>=0?"pos":"neg");
  document.getElementById("wr").textContent=(+d.winRate||0).toFixed(0)+"%";
  document.getElementById("pc").textContent=d.positions.length;
  drawChart("chart",d.equityHistory);
  const pw=document.getElementById("posWrap");
  pw.innerHTML=d.positions.length?d.positions.map(p=>\`
    <div class="pos-item">
      <div class="row"><strong>\${p.display}/USD</strong><span class="\${p.unrealizedPnl>=0?"pos":"neg"}">\${pct(p.unrealizedPnl)}</span></div>
      <div class="muted">Entry: $\${(+p.entry).toFixed(2)} | Conf: \${((+p.confidence||0)*100).toFixed(0)}%</div>
    </div>\`).join(""):'<div style="color:#555;font-size:0.78rem;padding:10px">No open positions</div>';
  const tw=document.getElementById("tlWrap");
  tw.innerHTML=(d.trades||[]).slice(0,15).map(t=>\`
    <div class="tl-item">
      <div class="row"><strong>\${t.pair?.replace("/USD","")}</strong><span class="\${+t.profit>=0?"pos":"neg"}">\${pct((+t.profit||0)*100)}</span></div>
      <div class="muted">\${t.signal||"exit"} · \${new Date(t.timestamp||Date.now()).toLocaleTimeString()}</div>
    </div>\`).join("")||'<div style="color:#555;font-size:0.78rem;padding:10px">No trades yet</div>';
}
document.getElementById("toggleBtn").onclick=()=>fetch("/toggle?token="+TOKEN).then(r=>r.json()).then(d=>{alert("Trading: "+(d.trading?"ON":"OFF"));refresh()});
document.getElementById("sellBtn").onclick=()=>fetch("/sellall?token="+TOKEN,{method:"POST"}).then(r=>r.json()).then(d=>{alert("Closed: "+JSON.stringify(d.closed));refresh()});
document.getElementById("balBtn").onclick=()=>api("/api/balance").then(d=>{document.getElementById("balView").textContent=JSON.stringify(d,null,2)});
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`);
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
initDB().then(async () => {
await loadBalance();
app.listen(PORT, () => {
console.log(`🚀 CIPHER BOT running on port ${PORT}`);
console.log(`📱 Mobile dashboard: http://localhost:${PORT}/control?token=${BOT_TOKEN}`);
});
});