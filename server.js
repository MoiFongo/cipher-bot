import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
res.header("Access-Control-Allow-Origin", "*");
res.header("Access-Control-Allow-Headers", "*");
next();
});

const PORT = process.env.PORT || 3000;
const KEY = process.env.KRAKEN_KEY;
const SECRET = process.env.KRAKEN_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN || "cipher2024";
const DATABASE_URL = process.env.DATABASE_URL;
const API = "https://api.kraken.com";

const pool = DATABASE_URL ? new Pool({
connectionString: DATABASE_URL,
ssl: { rejectUnauthorized: false }
}) : null;

async function initDB() {
if (!pool) return console.log("⚠️  No DATABASE_URL — running without persistence");
await pool.query(`CREATE TABLE IF NOT EXISTS trades ( id SERIAL PRIMARY KEY, pair TEXT, side TEXT, entry FLOAT, exit_price FLOAT, profit FLOAT, confidence FLOAT, features JSONB, signal TEXT, timestamp TIMESTAMPTZ DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS equity_log ( id SERIAL PRIMARY KEY, equity FLOAT, timestamp TIMESTAMPTZ DEFAULT NOW() );`);
console.log("✅ DB ready");
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
await pool.query("INSERT INTO equity_log (equity) VALUES ($1)", [eq]);
}

async function getTrades(limit = 100) {
if (!pool) return inMemoryTrades.slice(-limit);
const r = await pool.query("SELECT * FROM trades ORDER BY id DESC LIMIT $1", [limit]);
return r.rows;
}

async function getEquityHistory(limit = 100) {
if (!pool) return equityHistory.slice(-limit);
const r = await pool.query("SELECT equity FROM equity_log ORDER BY id DESC LIMIT $1", [limit]);
return r.rows.map(r => r.equity).reverse();
}

const PAIRS = ["XBT/USD", "ETH/USD", "SOL/USD"];
const KRAKEN_MAP = {
"XBT/USD": "XBTUSD",
"ETH/USD": "ETHUSD",
"SOL/USD": "SOLUSD"
};
const DISPLAY_MAP = {
"XBT/USD": "BTC",
"ETH/USD": "ETH",
"SOL/USD": "SOL"
};

const CFG = {
BASE_RISK: 0.015,
MAX_POSITIONS: 3,
TRADE_INTERVAL_MS: 8000,
MAX_HISTORY: 100,
STOP_LOSS: 0.985,
TAKE_PROFIT: 1.035,
TRAILING_STOP: 0.988,
MAX_TRADE_AGE_MS: 45 * 60 * 1000,
MIN_CONFIDENCE: 0.62,
BTC_CONFIRMATION: true,
WHALE_REQUIRED: true,
FAKE_BREAKOUT_FILTER: true,
DRAWDOWN_HALT: 0.85,
LOSING_STREAK_REDUCE: 3,
COMPOUND: true
};

let history = {};
let positions = [];
let tradingEnabled = true;
let equity = 0;
let peakEquity = 0;
let losingStreak = 0;
let totalTrades = 0;
let totalWins = 0;
let inMemoryTrades = [];
let equityHistory = [];
let lastPrices = {};
let botStartTime = Date.now();
let loopCount = 0;

function auth(req, res, next) {
const token = req.query.token || req.headers["x-bot-token"];
if (token !== BOT_TOKEN) return res.status(401).json({ error: "Unauthorized" });
next();
}

function sign(path, params, secret) {
const nonce = params.nonce.toString();
const postData = new URLSearchParams(params).toString();
const message = nonce + postData;
const secretBuffer = Buffer.from(secret, "base64");
const pathBuffer = Buffer.from(path);
const sha256 = crypto.createHash("sha256").update(message).digest();
const combined = Buffer.concat([pathBuffer, sha256]);
return crypto.createHmac("sha512", secretBuffer).update(combined).digest("base64");
}

async function privateCall(path, params = {}) {
if (!KEY || !SECRET) throw new Error("No API keys configured");
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
body: new URLSearchParams(body).toString()
});
const data = await res.json();
if (data.error?.length) throw new Error(data.error.join(", "));
return data.result;
}

async function getMarket() {
const krakenPairs = PAIRS.map(p => KRAKEN_MAP[p]).join(",");
const res = await fetch(`${API}/0/p