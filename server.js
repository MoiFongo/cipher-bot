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

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      pair TEXT,
      side TEXT DEFAULT 'sell',
      entry FLOAT,
      exit FLOAT,
      profit FLOAT,
      confidence FLOAT,
      features JSONB,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
      change24h: (parseFloat(data.result[key].p[1]) > 0
        ? (parseFloat(data.result[key].c[0]) - parseFloat(data.result[key].p[1])) / parseFloat(data.result[key].p[1])
        : 0)
    };
    i++;
  }
  return out;
}

function updateHistory(pair, price, volume) {
  if (!history[pair]) history[pair] = { prices: [], volumes: [] };
  history[pair].prices.push(price);
  history[pair].volumes.push(volume);
  if (history[pair].prices.length > MAX_HISTORY) {
    history[pair].prices.shift();
    history[pair].volumes.shift();
  }
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
  let score = 0;
  let total = 0;
  for (const row of res.rows) {
    const tf = row.features || {};
    const sim = 1 - Math.abs((f.shortTrend || 0) - (tf.shortTrend || 0)) - Math.abs((f.longTrend || 0) - (tf.longTrend || 0));
    if (sim > 0.5) {
      score += Number(row.profit || 0);
      total++;
    }
  }
  if (!total) return 0.5;
  return Math.max(0, Math.min(1, 0.5 + score / total));
}

function calcPositionSize(confidence) {
  let risk = BASE_RISK * confidence;
  if (losingStreak >= 3) risk *= 0.5;
  const dd = equity / peakEquity;
  if (dd < 0.9) risk *= 0.5;
  return Math.max(0.0025, Math.min(0.03, risk));
}

async function buy(pair, conf, f) {
  if (!tradingEnabled || positions.length >= MAX_POSITIONS) return false;
  const price = history[pair]?.prices?.at(-1);
  if (!price) return false;
  const risk = calcPositionSize(conf);
  const capital = equity * risk;
  const volume = (capital / price).toFixed(8);
  await privateCall("/0/private/AddOrder", { pair, type: "buy", ordertype: "market", volume });
  positions.push({ pair, entry: price, volume, peak: price, confidence: conf, features: f, capital, openedAt: Date.now() });
  return true;
}

async function close(pos, price) {
  await privateCall("/0/private/AddOrder", { pair: pos.pair, type: "sell", ordertype: "market", volume: pos.volume });
  const profit = (price - pos.entry) / pos.entry;
  equity *= 1 + profit;
  if (equity > peakEquity) peakEquity = equity;
  if (profit < 0) losingStreak++;
  else losingStreak = 0;
  await pool.query(
    "INSERT INTO trades (pair, side, entry, exit, profit, confidence, features) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [pos.pair, "sell", pos.entry, price, profit, pos.confidence, pos.features]
  );
}

setInterval(async () => {
  try {
    const market = await getMarket();
    for (const pair of PAIRS) updateHistory(pair, market[pair].price, market[pair].volume);
    const btc = features("BTC/USD");
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const price = history[pos.pair]?.prices?.at(-1);
      if (!price) continue;
      if (price > pos.peak) pos.peak = price;
      const dd = price / pos.peak;
      const ageMs = Date.now() - pos.openedAt;
      if (dd < 0.985 || price < pos.entry * 0.99 || ageMs > 30 * 60 * 1000) {
        await close(pos, price);
        positions.splice(i, 1);
      }
    }
    if (!tradingEnabled) return;
    for (const pair of PAIRS) {
      const f = features(pair);
      if (!f) continue;
      if (btc && btc.shortTrend < 0) continue;
      if (!f.whale) continue;
      if (f.shortTrend < 0.002 || f.longTrend < 0) continue;
      const prob = await predict(f);
      if (prob > 0.65) {
        const opened = await buy(pair, prob, f);
        if (opened) break;
      }
    }
  } catch (err) {
    console.log("loop error:", err.message);
  }
}, TRADE_INTERVAL);

app.get("/", (req, res) => res.send("FUND BOT LIVE"));

app.get("/api/status", auth, async (req, res) => {
  const trades = await pool.query("SELECT * FROM trades ORDER BY id DESC LIMIT 50");
  const pnl = trades.rows.reduce((a, b) => a + Number(b.profit || 0), 0);
  const wins = trades.rows.filter((t) => Number(t.profit) > 0).length;
  const total = trades.rows.length || 1;
  const market = {};
  for (const pair of PAIRS) {
    market[pair] = {
      price: history[pair]?.prices?.at(-1) ?? null,
      prices: history[pair]?.prices?.slice(-40) ?? []
    };
  }
  res.json({ tradingEnabled, equity, peakEquity, drawdownPct: peakEquity > 0 ? ((1 - equity / peakEquity) * 100) : 0, losingStreak, positions, pnlPct: pnl * 100, winRate: (wins / total) * 100, trades: trades.rows, market });
});

app.get("/api/balance", auth, async (req, res) => {
  try {
    const bal = await privateCall("/0/private/Balance");
    res.json(bal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/toggle", auth, (req, res) => {
  tradingEnabled = !tradingEnabled;
  res.send(`Trading: ${tradingEnabled ? "ON" : "OFF"}`);
});

app.post("/sellall", auth, async (req, res) => {
  try {
    for (const pos of [...positions]) {
      const price = history[pos.pair]?.prices?.at(-1);
      if (!price) continue;
      await close(pos, price);
    }
    positions = [];
    res.send("Closed all positions");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/control", auth, (req, res) => {
  const token = BOT_TOKEN;
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
<title>Fund Mode Bot</title>
<style>
:root{--bg:#0b0d12;--card:#141923;--card2:#0f131b;--text:#f3f6fb;--muted:#9aa4b2;--green:#17c964;--red:#f31260;--blue:#3b82f6;--orange:#f59e0b;--border:#242b38}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{padding:14px 14px 28px;max-width:900px;margin:0 auto}
.h1{font-size:28px;font-weight:800;margin:4px 0 14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:700px){.grid{grid-template-columns:1fr}}
.card{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:16px;padding:14px}
.kpi{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.val{font-size:28px;font-weight:800;margin-top:6px}
.small{font-size:14px;color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap}
.btn{appearance:none;border:0;border-radius:12px;padding:14px 16px;font-weight:700;font-size:16px;cursor:pointer}
.btn-primary{background:var(--blue);color:white}
.btn-danger{background:var(--red);color:white}
.btn-ghost{background:#1a2030;color:var(--text);border:1px solid var(--border)}
.section{margin-top:12px}
.section h3{margin:0 0 10px;font-size:18px}
.list{display:flex;flex-direction:column;gap:8px}
.item{background:#0f131b;border:1px solid var(--border);border-radius:12px;padding:10px 12px}
.muted{color:var(--muted)}
.pos{color:var(--green)}.neg{color:var(--red)}
.canvasBox{height:180px}
canvas{width:100%;height:180px;background:#0d1118;border-radius:12px;border:1px solid var(--border)}
.badge{display:inline-block;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:700}
.live{background:rgba(23,201,100,.14);color:var(--green)}
.off{background:rgba(243,18,96,.14);color:var(--red)}
.tradeHeader{display:flex;justify-content:space-between;align-items:center;gap:8px}
.scroll{max-height:300px;overflow:auto}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#d4dae4}
</style>
</head>
<body>
<div class="wrap">
  <div class="tradeHeader">
    <div class="h1">💰 Fund Mode Bot</div>
    <div id="liveBadge" class="badge live">LIVE</div>
  </div>
  <div class="grid">
    <div class="card"><div class="kpi">Equity</div><div class="val" id="equity">--</div><div class="small">Drawdown: <span id="drawdown">--</span></div></div>
    <div class="card"><div class="kpi">Performance</div><div class="val" id="pnl">--</div><div class="small">Win Rate: <span id="winRate">--</span></div></div>
    <div class="card"><div class="kpi">Open Positions</div><div class="val" id="openCount">0</div><div class="small">Losing Streak: <span id="streak">0</span></div></div>
    <div class="card"><div class="kpi">Controls</div><div class="row" style="margin-top:10px"><button class="btn btn-primary" id="toggleBtn">Toggle Bot</button><button class="btn btn-danger" id="sellBtn">Sell All</button><button class="btn btn-ghost" id="balanceBtn">Balance</button></div></div>
  </div>
  <div class="section grid">
    <div class="card"><h3>📈 Equity Curve</h3><div class="canvasBox"><canvas id="equityChart"></canvas></div></div>
    <div class="card"><h3>₿ BTC / ⟠ ETH / ◎ SOL</h3><div class="canvasBox"><canvas id="priceChart"></canvas></div></div>
  </div>
  <div class="section grid">
    <div class="card"><h3>📍 Active Positions</h3><div id="positions" class="list"></div></div>
    <div class="card"><h3>🪟 Live Trading Window</h3><div id="trades" class="list scroll"></div></div>
  </div>
  <div class="section"><div class="card"><h3>💼 Balance</h3><pre id="balanceView">Tap Balance to load account balances.</pre></div></div>
</div>
<script>
const token = ${JSON.stringify(token)};
const api = (path, opts={}) => fetch(path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token), opts);
function fmtPct(v){const n=Number(v||0);return(n>=0?"+":"")+n.toFixed(2)+"%"}
function fmtNum(v){return Number(v||0).toFixed(2)}
function colorFor(v){return Number(v)>=0?"pos":"neg"}
function drawLine(canvasId,series,stroke){const c=document.getElementById(canvasId);const ctx=c.getContext("2d");const dpr=window.devicePixelRatio||1;const w=c.clientWidth||320;const h=c.clientHeight||180;c.width=w*dpr;c.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle="#0d1118";ctx.fillRect(0,0,w,h);if(!series||series.length<2){ctx.fillStyle="#9aa4b2";ctx.font="14px sans-serif";ctx.fillText("Waiting for data...",14,24);return}const min=Math.min(...series);const max=Math.max(...series);const pad=14;const range=Math.max(max-min,0.00001);ctx.strokeStyle="#1f2633";ctx.lineWidth=1;for(let i=0;i<4;i++){const y=pad+(i*(h-pad*2)/3);ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke()}ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.beginPath();series.forEach((v,i)=>{const x=pad+(i*(w-pad*2)/(series.length-1));const y=h-pad-((v-min)/range)*(h-pad*2);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke()}
function drawMulti(canvasId,datasets){const c=document.getElementById(canvasId);const ctx=c.getContext("2d");const dpr=window.devicePixelRatio||1;const w=c.clientWidth||320;const h=c.clientHeight||180;c.width=w*dpr;c.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle="#0d1118";ctx.fillRect(0,0,w,h);const colors=["#f59e0b","#3b82f6","#17c964"];const all=datasets.flatMap(d=>d.series||[]);if(all.length<2){ctx.fillStyle="#9aa4b2";ctx.font="14px sans-serif";ctx.fillText("Waiting for data...",14,24);return}const min=Math.min(...all);const max=Math.max(...all);const pad=14;const range=Math.max(max-min,0.00001);datasets.forEach((d,idx)=>{const s=d.series;if(!s||s.length<2)return;ctx.strokeStyle=colors[idx%colors.length];ctx.lineWidth=2;ctx.beginPath();s.forEach((v,i)=>{const x=pad+(i*(w-pad*2)/(s.length-1));const y=h-pad-((v-min)/range)*(h-pad*2);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke()})}
async function refreshStatus(){
  const res=await api("/api/status");const data=await res.json();
  document.getElementById("equity").textContent=fmtNum(data.equity);
  document.getElementById("drawdown").textContent=fmtPct(-Math.abs(data.drawdownPct||0));
  document.getElementById("pnl").innerHTML='<span class="'+colorFor(data.pnlPct)+'">'+fmtPct(data.pnlPct)+'</span>';
  document.getElementById("winRate").textContent=fmtNum(data.winRate)+"%";
  document.getElementById("openCount").textContent=data.positions.length;
  document.getElementById("streak").textContent=data.losingStreak;
  const live=document.getElementById("liveBadge");live.textContent=data.tradingEnabled?"LIVE":"STOPPED";live.className="badge "+(data.tradingEnabled?"live":"off");
  const posWrap=document.getElementById("positions");posWrap.innerHTML=data.positions.length?data.positions.map(p=>'<div class="item"><div><strong>'+p.pair+'</strong></div><div class="muted">Entry: '+fmtNum(p.entry)+' | Peak: '+fmtNum(p.peak)+' | Conf: '+fmtNum((p.confidence||0)*100)+'%</div></div>').join(""):'<div class="item muted">No open positions</div>';
  const tradeWrap=document.getElementById("trades");tradeWrap.innerHTML=data.trades.length?data.trades.map(t=>'<div class="item"><div><strong>'+t.pair+'</strong> <span class="'+(Number(t.profit)>=0?'pos':'neg')+'">'+fmtPct(Number(t.profit)*100)+'</span></div><div class="muted">Entry: '+fmtNum(t.entry)+' | Exit: '+fmtNum(t.exit)+' | Conf: '+fmtNum((t.confidence||0)*100)+'%</div></div>').join(""):'<div class="item muted">No trades yet</div>';
  const eqSeries=data.trades.length?data.trades.slice().reverse().reduce((arr,t)=>{arr.push(arr[arr.length-1]*(1+Number(t.profit||0)));return arr},[100]):[100];
  drawLine("equityChart",eqSeries,"#3b82f6");
  drawMulti("priceChart",[{name:"BTC",series:data.market["BTC/USD"]?.prices||[]},{name:"ETH",series:data.market["ETH/USD"]?.prices||[]},{name:"SOL",series:data.market["SOL/USD"]?.prices||[]}]);
}
document.getElementById("toggleBtn").onclick=async()=>{const r=await api("/toggle");alert(await r.text());refreshStatus()};
document.getElementById("sellBtn").onclick=async()=>{const r=await api("/sellall",{method:"POST"});alert(await r.text());refreshStatus()};
document.getElementById("balanceBtn").onclick=async()=>{const r=await api("/api/balance");const data=await r.json();document.getElementById("balanceView").textContent=JSON.stringify(data,null,2)};
refreshStatus();setInterval(refreshStatus,5000);
</script>
</body>
</html>`);
});

initDB().then(() => {
  app.listen(PORT, () => console.log("💰 FUND BOT RUNNING"));
});