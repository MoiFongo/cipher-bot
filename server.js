import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const KEY = process.env.KRAKEN_KEY;
const SECRET = process.env.KRAKEN_SECRET;

const API = "https://api.kraken.com";

function sign(path, request, secret) {
  const secret_buffer = Buffer.from(secret, "base64");
  const nonce = request.nonce;
  const postData = new URLSearchParams(request).toString();

  const hash = crypto
    .createHash("sha256")
    .update(nonce + postData)
    .digest();

  return crypto
    .createHmac("sha512", secret_buffer)
    .update(path)
    .update(hash)
    .digest("base64");
}

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

async function getPrice(pair) {
  const res = await fetch(`${API}/0/public/Ticker?pair=${pair.replace("/", "")}`);
  const data = await res.json();
  const key = Object.keys(data.result)[0];
  return parseFloat(data.result[key].c[0]);
}

app.get("/", (req, res) => {
  res.send("CIPHER BOT LIVE 🚀");
});

app.get("/balance", async (req, res) => {
  try {
    const bal = await privateCall("/0/private/Balance");
    res.json(bal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/buy", async (req, res) => {
  try {
    const { pair, usd } = req.body;
    const price = await getPrice(pair);
    const volume = (usd / price).toFixed(8);

    const result = await privateCall("/0/private/AddOrder", {
      pair,
      type: "buy",
      ordertype: "market",
      volume
    });

    res.json({ ok: true, price, volume, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/sell", async (req, res) => {
  try {
    const { pair, volume } = req.body;

    const result = await privateCall("/0/private/AddOrder", {
      pair,
      type: "sell",
      ordertype: "market",
      volume
    });

    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/cancel-all", async (req, res) => {
  try {
    const result = await privateCall("/0/private/CancelAll");
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("BOT RUNNING ON PORT " + PORT);
});