import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const KEY = process.env.KRAKEN_KEY;
const SECRET = process.env.KRAKEN_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;

const API = "https://api.kraken.com";

// ===== CONFIG =====
const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const MAX_TRADE_USD = 5;
const STOP_LOSS = 0.98;
const TAKE_PROFIT = 1.02;
const COOLDOWN_MS = 2 * 60 * 1000;

// ===== LOOP SPEEDS =====
const DATA_INTERVAL = 2500;   // 2.5 sec (price updates)
const TRADE_INTERVAL = 10000; // 10 sec (decision making)

// ===== STATE =====
let history = {};
let openPosition = null;
let lastTradeTime = 0;
let tradingEnabled = true;

// ===== ML =====
let weights = {
  momentum: 0.4,
  volatility: -0.2,
  correlation: 0.3,
  bias: 0.1
};

// ===== AUTH =====
function auth(req, res, next) {
  const token = req.query.token || req.headers["x-bot-token"];
  if (token !== BOT_TOKEN) return res.status(401).send("Unauthorized");
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

// ===== GET ALL PRICES (OPTIMIZED) =====
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
  if (history[pair].length > 20) history[pair].shift();
}

// ===== FEATURES =====
function extractFeatures(pair) {
  const h = history[pair];
  if (!h || h.length < 5) return null;

  const momentum = (h[h.length - 1] - h[0]) / h[0];

  const volatility = h.reduce((acc, p, i) => {
    if (i === 0) return acc;
    return acc + Math.abs((p - h[i - 1]) / h[i - 1]);
  }, 0) / h.length;

  return { momentum, volatility };
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
function score(features, corr) {
  return (
    weights.momentum * features.momentum +
    weights.volatility * features.volatility +
    weights.correlation * corr +
    weights.bias
  );
}

// ===== BUY =====
async function buy(pair) {
  if (!tradingEnabled) return;
  if (openPosition) return;

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

  openPosition = {
    pair,
    entry: price,
    volume,
    features: extractFeatures(pair),
    corr: marketCorrelation()
  };

  lastTradeTime = now;
  console.log("BOUGHT:", pair);
}

// ===== SELL =====
async function sell() {
  if (!openPosition) return;

  const { pair, volume, entry, features, corr } = openPosition;
  const price = history[pair].slice(-1)[0];

  await privateCall("/0/private/AddOrder", {
    pair,
    type: "sell",
    ordertype: "market",
    volume
  });

  const profit = (price - entry) / entry;
  const lr = 0.05;

  weights.momentum += lr * profit * features.momentum;
  weights.volatility += lr * profit * features.volatility;
  weights.correlation += lr * profit * corr;

  console.log("SOLD:", pair, "profit:", profit);
  console.log("New weights:", weights);

  openPosition = null;
}

// ===== FAST DATA LOOP (2.5s) =====
setInterval(async () => {
  try {
    const prices = await getAllPrices();

    for (const pair of PAIRS) {
      updateHistory(pair, prices[pair]);
    }

  } catch (e) {
    console.log("Data error:", e.message);
  }
}, DATA_INTERVAL);

// ===== TRADE LOOP (10s) =====
setInterval(async () => {
  try {
    if (openPosition) {
      const price = history[openPosition.pair].slice(-1)[0];

      if (price >= openPosition.entry * TAKE_PROFIT) {
        console.log("TP hit");
        await sell();
      }

      if (price <= openPosition.entry * STOP_LOSS) {
        console.log("SL hit");
        await sell();
      }

      return;
    }

    const corr = marketCorrelation();

    for (const pair of PAIRS) {
      const features = extractFeatures(pair);
      if (!features) continue;

      const s = score(features, corr);

      if (s > 0.4) { // slightly aggressive for learning
        console.log("BUY SIGNAL:", pair, s);
        await buy(pair);
        break;
      }
    }

  } catch (e) {
    console.log("Trade error:", e.message);
  }
}, TRADE_INTERVAL);

// ===== ROUTES =====
app.get("/", (req, res) => res.send("BOT LIVE"));

app.get("/control", auth, (req, res) => {
  res.send(`
    <h2>BOT CONTROL</h2>
    <p>Status: ${tradingEnabled}</p>
    <p>Position: ${openPosition ? openPosition.pair : "None"}</p>

    <button onclick="fetch('/balance?token=${BOT_TOKEN}').then(r=>r.json()).then(alert)">Balance</button>
    <button onclick="fetch('/toggle?token=${BOT_TOKEN}').then(r=>r.text()).then(alert)">Toggle</button>
    <button onclick="fetch('/sell?token=${BOT_TOKEN}',{method:'POST'}).then(r=>r.json()).then(alert)">SELL</button>
  `);
});

app.get("/balance", auth, async (req, res) => {
  try {
    const bal = await privateCall("/0/private/Balance");
    res.json(bal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/sell", auth, async (req, res) => {
  await sell();
  res.send("Sold");
});

app.get("/toggle", auth, (req, res) => {
  tradingEnabled = !tradingEnabled;
  res.send("Trading: " + tradingEnabled);
});

app.listen(PORT, () => console.log("BOT RUNNING"));