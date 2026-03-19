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

// ===== INIT DB =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weights (
      id SERIAL PRIMARY KEY,
      data JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      pair TEXT,
      entry FLOAT,
      exit FLOAT,
      profit FLOAT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await pool.query("SELECT * FROM weights LIMIT 1");

  if (res.rows.length === 0) {
    await pool.query("INSERT INTO weights (data) VALUES ($1)", [{
      momentum: 0.4,
      volatility: -0.2,
      correlation: 0.3,
      bias: 0.1
    }]);
  }
}

// ===== CONFIG =====
const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const MAX_TRADE_USD = 5;
const MAX_POSITIONS = 3;

const STOP_LOSS = 0.985;
const TAKE_PROFIT = 1.02;
const SCALE_IN_THRESHOLD = 1.01;

const COOLDOWN_MS = 60 * 1000;

const DATA_INTERVAL = 2500;
const TRADE_INTERVAL = 10000;

// ===== STATE =====
let history = {};
let positions = [];
let lastTradeTime = 0;
let tradingEnabled = true;
let weights = {};

// ===== LOAD WEIGHTS =====
async function loadWeights() {
  const res = await pool.query("SELECT * FROM weights LIMIT 1");
  weights = res.rows[0].data;
  console.log("Loaded weights:", weights);
}

// ===== SAVE WEIGHTS =====
async function saveWeights() {
  await pool.query("UPDATE weights SET data=$1 WHERE id=1", [weights]);
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
  const postData = new URLSearchParams(body).toString();
  const sig = sign(path, body, SECRET);

  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      "API-Key": KEY,
      "API-Sign": sig,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: postData
  });

  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(", "));
  return data.result;
}

// ===== GET PRICES =====
async function getAllPrices() {
  const pairs = PAIRS.map(p => p.replace("/", "")).join(",");
  const res = await fetch(`${API}/0/public/Ticker?pair=${pairs}`);
  const data = await res.json();

  let prices = {};
  let i = 0;

  for (const key in data.result) {
    prices[PAIRS[i]] = parseFloat(data.result[key].c[0]);
    i++;
  }

  return prices;
}

// ===== HISTORY =====
function updateHistory(pair, price) {
  if (!history[pair]) history[pair] = [];
  history[pair].push(price);
  if (history[pair].length > 30) history[pair].shift();
}

// ===== FEATURES =====
function extractFeatures(pair) {
  const h = history[pair];
  if (!h || h.length < 6) return null;

  const returns = [];

  for (let i = 1; i < h.length; i++) {
    returns.push((h[i] - h[i - 1]) / h[i - 1]);
  }

  const momentum = (h[h.length - 1] - h[0]) / h[0];
  const volatility = returns.reduce((a, b) => a + Math.abs(b), 0) / returns.length;

  const trend = returns.filter(r => r > 0).length / returns.length;
  const accel = returns.slice(-3).reduce((a, b) => a + b, 0);

  return { momentum, volatility, trend, accel };
}

// ===== CORRELATION =====
function correlation(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 5) return 0;

  const avgA = a.reduce((x, y) => x + y) / a.length;
  const avgB = b.reduce((x, y) => x + y) / b.length;

  let num = 0, denA = 0, denB = 0;

  for (let i = 0; i < a.length; i++) {
    num += (a[i] - avgA) * (b[i] - avgB);
    denA += (a[i] - avgA) ** 2;
    denB += (b[i] - avgB) ** 2;
  }

  return num / Math.sqrt(denA * denB + 1e-8);
}

function marketCorrelation() {
  return (
    correlation(history["BTC/USD"], history["ETH/USD"]) +
    correlation(history["BTC/USD"], history["SOL/USD"])
  ) / 2;
}

// ===== SCORE =====
function score(f, corr) {
  return (
    weights.momentum * f.momentum +
    weights.volatility * f.volatility +
    weights.correlation * corr +
    weights.bias +
    0.4 * f.trend +
    0.3 * f.accel
  );
}

// ===== BUY =====
async function buy(pair) {
  if (!tradingEnabled) return;
  if (positions.length >= MAX_POSITIONS) return;

  const now = Date.now();
  if (now - lastTradeTime < COOLDOWN_MS) return;

  const price = history[pair].slice(-1)[0];
  const volume = (MAX_TRADE_USD / price).toFixed(8);

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
    features: extractFeatures(pair),
    corr: marketCorrelation(),
    scaled: false
  });

  lastTradeTime = now;
  console.log("BOUGHT:", pair);
}

// ===== SELL =====
async function closePosition(pos, price) {
  await privateCall("/0/private/AddOrder", {
    pair: pos.pair,
    type: "sell",
    ordertype: "market",
    volume: pos.volume
  });

  const profit = (price - pos.entry) / pos.entry;
  const lr = 0.05;

  weights.momentum += lr * profit * pos.features.momentum;
  weights.volatility += lr * profit * pos.features.volatility;
  weights.correlation += lr * profit * pos.corr;

  await saveWeights();

  await pool.query(
    "INSERT INTO trades (pair, entry, exit, profit) VALUES ($1,$2,$3,$4)",
    [pos.pair, pos.entry, price, profit]
  );

  console.log("SOLD:", pos.pair, profit);
}

// ===== LOOPS =====

// FAST DATA
setInterval(async () => {
  try {
    const prices = await getAllPrices();
    for (const pair of PAIRS) updateHistory(pair, prices[pair]);
  } catch (e) {
    console.log("Data error:", e.message);
  }
}, DATA_INTERVAL);

// TRADE LOOP
setInterval(async () => {
  try {
    const corr = marketCorrelation();

    // ===== MANAGE POSITIONS =====
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const price = history[pos.pair].slice(-1)[0];

      // SCALE IN
      if (!pos.scaled && price >= pos.entry * SCALE_IN_THRESHOLD) {
        console.log("Scaling into", pos.pair);
        await buy(pos.pair);
        pos.scaled = true;
      }

      // EXIT
      if (
        price >= pos.entry * TAKE_PROFIT ||
        price <= pos.entry * STOP_LOSS
      ) {
        await closePosition(pos, price);
        positions.splice(i, 1);
      }
    }

    // ===== NEW ENTRIES =====
    for (const pair of PAIRS) {
      const f = extractFeatures(pair);
      if (!f) continue;

      const s = score(f, corr);

      if (
        s > 0.45 &&
        f.trend > 0.6 &&
        f.accel > 0 &&
        corr > 0
      ) {
        await buy(pair);
        break;
      }
    }

  } catch (e) {
    console.log("Trade error:", e.message);
  }
}, TRADE_INTERVAL);

// ===== START =====
initDB().then(loadWeights);

app.get("/", (req, res) => {
  res.send("BOT LIVE");
});

// ===== AUTH =====
function auth(req, res, next) {
  const token = req.query.token || req.headers["x-bot-token"];
  if (token !== process.env.BOT_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

// ===== CONTROL PANEL =====
app.get("/control", auth, (req, res) => {
  res.send(`
    <h2>🤖 BOT CONTROL</h2>
    <p>Status: ${tradingEnabled ? "ON" : "OFF"}</p>
    <p>Open Positions: ${positions.length}</p>

    <button onclick="fetch('/balance?token=${process.env.BOT_TOKEN}').then(r=>r.json()).then(alert)">
      Check Balance
    </button><br><br>

    <button onclick="fetch('/toggle?token=${process.env.BOT_TOKEN}').then(r=>r.text()).then(alert)">
      Toggle Trading
    </button><br><br>

    <button onclick="fetch('/sellall?token=${process.env.BOT_TOKEN}', {method:'POST'}).then(r=>r.text()).then(alert)">
      SELL ALL
    </button>
  `);
});

// ===== BALANCE =====
app.get("/balance", auth, async (req, res) => {
  try {
    const result = await privateCall("/0/private/Balance");
    res.json(result);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ===== TOGGLE =====
app.get("/toggle", auth, (req, res) => {
  tradingEnabled = !tradingEnabled;
  res.send("Trading: " + tradingEnabled);
});

// ===== SELL ALL =====
app.post("/sellall", auth, async (req, res) => {
  try {
    for (const pos of positions) {
      const price = history[pos.pair].slice(-1)[0];
      await closePosition(pos, price);
    }
    positions = [];
    res.send("All positions closed");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => console.log("BOT RUNNING"));

// ===== ROOT =====
app.get("/", (req, res) => {
  res.send("BOT LIVE");
});