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

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS trades (id SERIAL PRIMARY KEY, pair TEXT, side TEXT DEFAULT 'sell', entry FLOAT, exit FLOAT, profit FLOAT, confidence FLOAT, features JSONB, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const BASE_RISK = 0.01;
const MAX_POSITIONS = 4;
const TRADE_INTERVAL = 7000;
const MAX_HISTORY = 80;

let history = {};
let positions = [];
let tradingEnabled = true;
let equity = 100;
let peakEquity = 100;
let losingStreak = 0;

function auth(req, res, next) {
  const token = req.query.token || req.headers["x-bot-token"];
  if (token !== BOT_TOKEN) return res.status(401).send("Unauthorized");
  next();
}

function sign(path, request, secret) {
  const secretBuffer = Buffer.from(secret, "base64");
  const nonce = request.nonce;
  const postData = new URLSearchParams(request).toString();
  const hash = crypto.createHash("sha256").update(nonce + postData).digest();
  return crypto.createHmac("sha512", secretBuffer).update(path).update(hash).digest("base64");
}

async function privateCall(path, params = {}) {
  const nonce = Date.now().toString();
  const body = { nonce, ...params };
  const sig = sign(path, body, SECRET);
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "API-Key": KEY, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(", "));
  return data.result;
}

async function getMarket() {
  const pairs = PAIRS.map((p) => p.replace("/", "")).join(",");
  const res = await fetch(`${API}/0/public/Ticker?pair=${pairs}`);
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(", "));
  const out = {};
  let i = 0;
  for (const key in data.result) {
    out[PAIRS[i]] = {
      price: parseFloat(data.result[key].c[0]),
      volume: parseFloat(data.result[key].v[1]),
      change24h: (parseFloat(data.result[key].p[1]) > 0 ? (parseFloat(data.result[key].c[0]) - parseFloat(data.result[key].p[1])) / parseFloat(data.result[key].p[1]) : 0)
    };
    i++;
  }
  return out;
}

function updateHistory(pair, price, volume) {
  if (!history[pair]) history[pair] = { prices: [], volumes: [] };
  history[pair].prices.push(price);
  history[pair].volumes.push(volume);
  if (history[pair].prices.length > MAX_HISTORY) { history[pair].prices.shift(); history[pair].volumes.shift(); }
}

function features(pair) {
  const h = history[pair];
  if (!h || h.prices.length < 20) return null;
  const short = h.prices.slice(-5);
  const long = h.prices.slice(-20);
  const vols = h.volumes.slice(-20);
  const shortTrend = (short[short.length - 1] - short[0]) / short[0];
  const longTrend = (long[long.length - 1] - long[0]) / long[0];
  const volAvg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const whale = h.volumes[h.volumes.length - 1] > volAvg * 1.8;
  return { shortTrend, longTrend, whale };
}

async function predict(f) {
  const res = await pool.query("SELECT profit, features FROM trades ORDER BY id DESC LIMIT 200");
  if (res.rows.length < 15) return 0.6;
  let score = 0, total = 0;
  for (const row of res.rows) {
    const tf = row.features || {};
    const sim = 1 - Math.abs((f.shortTrend || 0) - (tf.shortTrend || 0)) - Math.abs((f.longTrend || 0) - (tf.longTrend || 0));
    if (sim > 0.5) { score += Number(row.profit || 0); total++; }
  }
  if (!total) return 0.5;
  return Math.max(0, Math.min(1, 0.5 + score / total));
}

function calcPositionSize(confidence) {
  let risk = BASE_RISK * confidence;
  if (losingStreak >= 3) risk