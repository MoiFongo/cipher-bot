import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const KEY = process.env.KRAKEN_KEY;
const SECRET = process.env.KRAKEN_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const API = "https://api.kraken.com";

// ===== DB =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      pair TEXT,
      entry FLOAT,
      exit FLOAT,
      profit FLOAT,
      features JSONB,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ===== CONFIG =====
const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const BASE_RISK = 0.01; // 1% base risk
const MAX_POSITIONS = 4;
const TRADE_INTERVAL = 7000;

// ===== STATE =====
let history = {};
let positions = [];
let tradingEnabled = true;

let equity = 100; // virtual growth tracker
let peakEquity = 100;
let losingStreak = 0;

// ===== AUTH =====
function auth(req, res, next) {
  if (req.query.token !== BOT_TOKEN) return res.status(401).send("Unauthorized");
  next();
}

// ===== SIGN =====
function sign(path, request, secret) {
  const secretBuffer = Buffer.from(secret, "base64");
  const nonce = request.nonce;
  const postData = new URLSearchParams(request).toString();

  const hash = crypto.createHash("sha256")
    .update(nonce + postData)
    .digest();

  return crypto.createHmac("sha512", secretBuffer)
    .update(path)
    .update(hash)
    .digest("base64");
}

// ===== PRIVATE =====
async function privateCall(path, params = {}) {
  const nonce = Date.now().toString();
  const body = { nonce, ...params };
  const sig = sign(path, body, SECRET);

  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      "API-Key": KEY,
      "API-Sign": sig,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });

  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(", "));
  return data.result;
}

// ===== MARKET =====
async function getMarket() {
  const pairs = PAIRS.map(p => p.replace("/", "")).join(",");
  const res = await fetch(`${API}/0/public/Ticker?pair=${pairs}`);
  const data = await res.json();

  let out = {};
  let i = 0;

  for (const key in data.result) {
    out[PAIRS[i]] = {
      price: parseFloat(data.result[key].c[0]),
      volume: parseFloat(data.result[key].v[1])
    };
    i++;
  }

  return out;
}

// ===== HISTORY =====
function updateHistory(pair, price, volume) {
  if (!history[pair]) history[pair] = { prices: [], volumes: [] };

  history[pair].prices.push(price);
  history[pair].volumes.push(volume);

  if (history[pair].prices.length > 60) {
    history[pair].prices.shift();
    history[pair].volumes.shift();
  }
}

// ===== FEATURES =====
function features(pair) {
  const h = history[pair];
  if (!h || h.prices.length < 20) return null;

  const prices = h.prices;
  const volumes = h.volumes;

  const shortTrend = (prices.slice(-5)[4] - prices.slice(-5)[0]) / prices.slice(-5)[0];
  const longTrend = (prices.slice(-20)[19] - prices.slice(-20)[0]) / prices.slice(-20)[0];

  const volAvg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const whale = volumes.slice(-1)[0] > volAvg * 1.8;

  return { shortTrend, longTrend, whale };
}

// ===== ML =====
async function predict(f) {
  const res = await pool.query("SELECT * FROM trades");

  if (res.rows.length < 15) return 0.6;

  let score = 0;
  let total = 0;

  for (const t of res.rows) {
    const tf = t.features;

    const sim =
      1 -
      Math.abs(f.shortTrend - tf.shortTrend) -
      Math.abs(f.longTrend - tf.longTrend);

    if (sim > 0.5) {
      score += t.profit;
      total++;
    }
  }

  if (total === 0) return 0.5;

  return Math.max(0, Math.min(1, 0.5 + score / total));
}

// ===== RISK ENGINE =====
function calcPositionSize(confidence) {
  let risk = BASE_RISK;

  // scale with confidence
  risk *= confidence;

  // reduce risk on losing streak
  if (losingStreak >= 3) risk *= 0.5;

  // drawdown protection
  const dd = equity / peakEquity;
  if (dd < 0.9) risk *= 0.5;

  return risk;
}

// ===== BUY =====
async function buy(pair, conf, f) {
  if (!tradingEnabled || positions.length >= MAX_POSITIONS) return;

  const price = history[pair].prices.slice(-1)[0];

  const risk = calcPositionSize(conf);
  const capital = equity * risk;

  const volume = (capital / price).toFixed(8);

  await privateCall("/0/private/AddOrder", {
    pair,
    type: "buy",
    ordertype: "market",
    volume
  });

  positions.push({
    pair,
    entry: price,
    volume,
    peak: price,
    features: f,
    confidence: conf,
    capital
  });
}

// ===== CLOSE =====
async function close(pos, price) {
  await privateCall("/0/private/AddOrder", {
    pair: pos.pair,
    type: "sell",
    ordertype: "market",
    volume: pos.volume
  });

  const profit = (price - pos.entry) / pos.entry;

  equity *= (1 + profit);

  if (equity > peakEquity) peakEquity = equity;

  if (profit < 0) losingStreak++;
  else losingStreak = 0;

  await pool.query(
    "INSERT INTO trades (pair, entry, exit, profit, features) VALUES ($1,$2,$3,$4,$5)",
    [pos.pair, pos.entry, price, profit, pos.features]
  );
}

// ===== LOOP =====
setInterval(async () => {
  const market = await getMarket();

  for (const pair of PAIRS) {
    updateHistory(pair, market[pair].price, market[pair].volume);
  }

  const btc = features("BTC/USD");

  // manage positions
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    const price = history[pos.pair].prices.slice(-1)[0];

    if (price > pos.peak) pos.peak = price;

    const dd = price / pos.peak;

    if (dd < 0.985 || price < pos.entry * 0.99) {
      await close(pos, price);
      positions.splice(i, 1);
    }
  }

  // entries
  for (const pair of PAIRS) {
    const f = features(pair);
    if (!f) continue;

    if (btc && btc.shortTrend < 0) continue;
    if (!f.whale) continue;
    if (f.shortTrend < 0.002 || f.longTrend < 0) continue;

    const prob = await predict(f);

    if (prob > 0.65) {
      await buy(pair, prob, f);
      break;
    }
  }

}, TRADE_INTERVAL);

// ===== CONTROL =====
app.get("/control", auth, async (req, res) => {
  const trades = await pool.query("SELECT * FROM trades ORDER BY id DESC LIMIT 20");

  const pnl = trades.rows.reduce((a, b) => a + b.profit, 0);

  res.send(`
    <h1>💰 FUND MODE BOT</h1>

    <p>Status: ${tradingEnabled ? "🟢 LIVE" : "🔴 OFF"}</p>
    <p>Equity: ${equity.toFixed(2)}</p>
    <p>Drawdown: ${(100 - (equity/peakEquity)*100).toFixed(2)}%</p>
    <p>Losing Streak: ${losingStreak}</p>

    <h3>Positions</h3>
    ${positions.map(p => `<p>${p.pair} ${(p.confidence*100).toFixed(0)}%</p>`).join("")}

    <h3>Recent Trades</h3>
    ${trades.rows.map(t => `<p>${t.pair} ${(t.profit*100).toFixed(2)}%</p>`).join("")}

    <br>
    <button onclick="fetch('/toggle?token=${BOT_TOKEN}')">Toggle</button>
    <button onclick="fetch('/sellall?token=${BOT_TOKEN}',{method:'POST'})">Sell All</button>
  `);
});

// ===== ROUTES =====
app.get("/", (req, res) => res.send("FUND BOT LIVE"));

app.get("/toggle", auth, (req, res) => {
  tradingEnabled = !tradingEnabled;
  res.send("Trading: " + tradingEnabled);
});

app.post("/sellall", auth, async (req, res) => {
  for (const pos of positions) {
    const price = history[pos.pair].prices.slice(-1)[0];
    await close(pos, price);
  }
  positions = [];
  res.send("Closed");
});

// ===== START =====
initDB();
app.listen(PORT, () => console.log("💰 FUND BOT RUNNING"));