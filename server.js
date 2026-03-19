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

// ===== STATE =====
let history = {};
let openPosition = null;
let lastTradeTime = 0;
let tradingEnabled = true;

// ===== ML MODEL =====
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

// ===== KRAKEN SIGN =====
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

// ===== PRIVATE API =====
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

// ===== PRICE =====
async function getPrice(pair) {
  const res = await fetch(`${API}/0/public/Ticker?pair=${pair.replace("/", "")}`);
  const data = await res.json();
  const key = Object.keys(data.result)[0];
  return parseFloat(data.result[key].c[0]);
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

// ===== MARKET CORRELATION =====
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
  if (!tradingEnabled) throw new Error("Trading disabled");
  if (openPosition) throw new Error("Position exists");

  const now = Date.now();
  if (now - lastTradeTime < COOLDOWN_MS) throw new Error("Cooldown");

  const price = await getPrice(pair);
  const volume = (MAX_TRADE_USD / price).toFixed(8);

  const result = await privateCall("/0/private/AddOrder", {
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
  return result;
}

// ===== SELL =====
async function sell() {
  if (!openPosition) throw new Error("No position");

  const { pair, volume, entry, features, corr } = openPosition;
  const exitPrice = await getPrice(pair);

  const result = await privateCall("/0/private/AddOrder", {
    pair,
    type: "sell",
    ordertype: "market",
    volume
  });

  const profit = (exitPrice - entry) / entry;
  const lr = 0.05;

  // ===== LEARNING =====
  weights.momentum += lr * profit * features.momentum;
  weights.volatility += lr * profit * features.volatility;
  weights.correlation += lr * profit * corr;

  console.log("Updated weights:", weights);

  openPosition = null;
  return result;
}

// ===== AUTO MONITOR =====
setInterval(async () => {
  try {
    if (!openPosition) return;

    const price = await getPrice(openPosition.pair);

    if (price >= openPosition.entry * TAKE_PROFIT) {
      console.log("TP hit");
      await sell();
    }

    if (price <= openPosition.entry * STOP_LOSS) {
      console.log("SL hit");
      await sell();
    }

  } catch (e) {
    console.log("Monitor error:", e.message);
  }
}, 5000);

// ===== AUTO SCAN =====
setInterval(async () => {
  try {
    for (const pair of PAIRS) {
      const price = await getPrice(pair);
      updateHistory(pair, price);
    }

    if (openPosition) return;

    const corr = marketCorrelation();

    for (const pair of PAIRS) {
      const features = extractFeatures(pair);
      if (!features) continue;

      const s = score(features, corr);

      if (s > 0.5) {
        console.log("ML BUY:", pair, s);
        await buy(pair);
        break;
      }
    }

  } catch (e) {
    console.log("Scan error:", e.message);
  }
}, 10000);

// ===== ROUTES =====

app.get("/", (req, res) => res.send("BOT LIVE"));

app.get("/control", auth, (req, res) => {
  res.send(`
    <h2>CIPHER CONTROL</h2>
    <p>Status: ${tradingEnabled ? "ON" : "OFF"}</p>
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
  try {
    const r = await sell();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/toggle", auth, (req, res) => {
  tradingEnabled = !tradingEnabled;
  res.send("Trading: " + tradingEnabled);
});

app.listen(PORT, () => console.log("BOT RUNNING"));