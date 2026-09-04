/* =============================================================
   CYRIL'S FOODS — BACKEND VERIFICATION & AUTOMATION ENGINE (server.js)
   Responsibilities:
     • Serve the static site
     • Initialise Paystack transactions (card + dynamic bank transfer)
     • Receive & HMAC-SHA512 verify Paystack webhooks (charge.success)
       — zero human verification.
     • Persist verified orders
     • Dispatch an instant WhatsApp alert to 08081988184
       (Twilio WhatsApp / Green API / wa.me fallback)
     • Stream verified orders to the admin panel via SSE (+ chime client-side)
   Run:  node server.js   (see .env.example for configuration)
   ============================================================= */
"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

/* ---------------- Configuration (env-driven) ---------------- */
const config = {
  port: process.env.PORT || 3000,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || "",
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || "",
  // WhatsApp dispatch — choose whichever provider creds are present.
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || "",
    auth: process.env.TWILIO_AUTH_TOKEN || "",
    from: process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886",
    to: process.env.WHATSAPP_ALERT_TO || "whatsapp:+2348081988184",
  },
  greenApi: {
    instance: process.env.GREEN_API_INSTANCE || "",
    token: process.env.GREEN_API_TOKEN || "",
    chatId: process.env.GREEN_API_CHAT_ID || "2348081988184@c.us",
  },
  // Restaurant fixed origin (Point A) — 26 College Rd, Ifako-Ijaiye, Lagos.
  originAddress: process.env.REST_ADDRESS || "26 College Rd, Ifako-Ijaiye, Lagos, Nigeria",
  originLat: parseFloat(process.env.REST_LAT || "6.6427"),
  originLng: parseFloat(process.env.REST_LNG || "3.3288"),
  ratePerKm: parseInt(process.env.RATE_PER_KM || "1100", 10),
  ordersFile: path.join(__dirname, "orders.json"),
};

const app = express();

/* ---- Kitchen portal security ----
   PIN is verified server-side against KITCHEN_PIN (default 8818 — CHANGE in prod).
   A successful login mints an HMAC-signed session token (no JWT dependency). */
const KITCHEN_PIN = process.env.KITCHEN_PIN || "8818";
const TOKEN_SECRET = process.env.TOKEN_SECRET || process.env.PAYSTACK_SECRET_KEY || ("cyrils-kitchen-" + KITCHEN_PIN);
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function b64url(s) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("hex").slice(0, 32);
  return body + "." + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1) return null;
  const dot = token.lastIndexOf(".");
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("hex").slice(0, 32);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}
function extractToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.indexOf("Bearer ") === 0) return auth.slice(7);
  const q = new URL(req.url, "http://x").searchParams.get("token"); // SSE can't set headers via EventSource
  return q || null;
}
// Auth middleware — blocks all unauthorized kitchen requests with 401.
function requireKitchen(req, res, next) {
  const payload = verifyToken(extractToken(req));
  if (!payload) return res.status(401).json({ status: "error", message: "Unauthorized — valid kitchen session required." });
  req.kitchen = payload;
  next();
}

/* Raw body is required for Paystack signature verification — BEFORE json parser. */
app.use("/api/paystack/webhook", express.raw({ type: "*/*" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

/* ---- Staff overrides state (manual closed / sold-out items) ---- */
const kitchenStatusFile = path.join(__dirname, "kitchen-status.json");
let kitchenStatus = { manualClosed: false, outOfStock: [] };
try { if (fs.existsSync(kitchenStatusFile)) kitchenStatus = JSON.parse(fs.readFileSync(kitchenStatusFile, "utf8")); } catch (e) {}
function saveKitchenStatus() { try { fs.writeFileSync(kitchenStatusFile, JSON.stringify(kitchenStatus, null, 2)); } catch (e) {} }

/* PUBLIC status snapshot (no order data) — storefront uses this for overrides. */
app.get("/api/status", function (req, res) {
  res.json({ manualClosed: !!kitchenStatus.manualClosed, outOfStock: kitchenStatus.outOfStock || [], time: new Date().toISOString() });
});

/* ---- Kitchen auth ---- */
app.post("/api/kitchen/login", function (req, res) {
  const pin = String((req.body && req.body.pin) || "").trim();
  const expected = String(KITCHEN_PIN);
  let ok = false;
  if (pin.length === expected.length) {
    try { ok = crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(expected)); } catch (e) { ok = false; }
  }
  if (!ok) return res.status(401).json({ status: "error", message: "Incorrect kitchen passcode." });
  const token = signToken({ role: "kitchen", exp: Date.now() + TOKEN_TTL_MS });
  res.json({ status: "ok", token: token, expiresIn: TOKEN_TTL_MS / 1000 });
});

/* Authenticated kitchen endpoints */
app.get("/api/kitchen/orders", requireKitchen, function (req, res) {
  res.json(orders.filter(function (o) { return o.status === "paid"; }).slice(-50).reverse());
});

app.post("/api/kitchen/control", requireKitchen, function (req, res) {
  const body = req.body || {};
  if (typeof body.manualClosed === "boolean") kitchenStatus.manualClosed = body.manualClosed;
  if (Array.isArray(body.outOfStock)) kitchenStatus.outOfStock = body.outOfStock.map(String).slice(0, 500);
  if (Array.isArray(body.toggleItem)) {
    const id = String(body.toggleItem[0]);
    const on = !!body.toggleItem[1];
    const set = new Set(kitchenStatus.outOfStock);
    if (on) set.add(id); else set.delete(id);
    kitchenStatus.outOfStock = Array.from(set);
  }
  kitchenStatus.updatedAt = new Date().toISOString();
  saveKitchenStatus();
  res.json({ status: "ok", kitchenStatus: kitchenStatus });
});

/* Authenticated live-order SSE stream for the kitchen portal. */
app.get("/api/kitchen/stream", requireKitchen, function (req, res) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders && res.flushHeaders();
  res.write("retry: 5000\n\n");
  orders.filter(function (o) { return o.status === "paid"; }).slice(-15).reverse().forEach(function (o) {
    res.write("data: " + JSON.stringify(o) + "\n\n");
  });
  sseClients.add(res);
  const ka = setInterval(function () { try { res.write(":ka\n\n"); } catch (e) {} }, 25000);
  req.on("close", function () { clearInterval(ka); sseClients.delete(res); });
});

/* ---------------- Tiny in-memory + file order store ---------------- */
let orders = [];
try {
  if (fs.existsSync(config.ordersFile)) orders = JSON.parse(fs.readFileSync(config.ordersFile, "utf8"));
} catch (e) { orders = []; }
function saveOrders() {
  try { fs.writeFileSync(config.ordersFile, JSON.stringify(orders, null, 2)); } catch (e) {}
}

/* SSE client pool — only authenticated kitchen portal streams subscribe. */
const sseClients = new Set();
function broadcast(order) {
  const payload = JSON.stringify(order);
  sseClients.forEach(function (res) { try { res.write("data: " + payload + "\n\n"); } catch (e) {} });
}

/* ---------------- Helpers ---------------- */
const money = (n) => "₦" + Number(n).toLocaleString("en-NG");

function httpsJson(options, body) {
  return new Promise(function (resolve, reject) {
    const req = https.request(options, function (res) {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------------- WhatsApp dispatch (multi-provider) ---------------- */
async function dispatchWhatsApp(message) {
  const results = [];

  // 1) Twilio WhatsApp channel
  if (config.twilio.sid && config.twilio.auth) {
    try {
      const basic = Buffer.from(config.twilio.sid + ":" + config.twilio.auth).toString("base64");
      const form = new URLSearchParams({
        From: config.twilio.from,
        To: config.twilio.to,
        Body: message,
      }).toString();
      const r = await httpsJson({
        hostname: "api.twilio.com",
        path: "/2010-04-01/Accounts/" + config.twilio.sid + "/Messages.json",
        method: "POST",
        headers: {
          Authorization: "Basic " + basic,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
        },
      }, form);
      results.push({ provider: "twilio", ok: r.status >= 200 && r.status < 300, detail: r.body });
    } catch (e) { results.push({ provider: "twilio", ok: false, error: e.message }); }
  }

  // 2) Green API (WhatsApp Business gateway)
  if (config.greenApi.instance && config.greenApi.token) {
    try {
      const body = JSON.stringify({ chatId: config.greenApi.chatId, message: message });
      const r = await httpsJson({
        hostname: "api.green-api.com",
        path: "/waInstance" + config.greenApi.instance + "/sendMessage/" + config.greenApi.token,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, body);
      results.push({ provider: "greenapi", ok: r.status >= 200 && r.status < 300, detail: r.body });
    } catch (e) { results.push({ provider: "greenapi", ok: false, error: e.message }); }
  }

  // 3) Fallback: build a wa.me deep-link (logged for a human/operator or cron)
  if (!results.some((x) => x.ok)) {
    const link = "https://wa.me/2348081988184?text=" + encodeURIComponent(message);
    results.push({ provider: "wame-link", ok: true, link: link });
    console.log("\n📲 [WhatsApp alert — open this link to deliver]:\n" + link + "\n");
  }
  return results;
}

function formatOrderMessage(o) {
  const lines = [];
  lines.push("🛎️ *NEW PAID ORDER — Cyril's Foods*");
  lines.push("Ref: " + o.reference);
  lines.push("Customer: " + (o.customer && o.customer.name));
  lines.push("Phone: " + (o.customer && o.customer.phone));
  lines.push("");
  lines.push("*Items:*");
  (o.items || []).forEach(function (i) {
    lines.push("• " + i.qty + "x " + i.name +
      (i.options && i.options.length ? " (" + i.options.join(", ") + ")" : "") +
      " — " + money(i.lineTotal));
  });
  lines.push("");
  if (o.address && o.address.description) {
    lines.push("📍 Delivery: " + o.address.description);
    if (o.address.distanceKm) {
      lines.push("Distance: " + o.address.distanceKm + " km" + (o.address.minutes ? " (~" + o.address.minutes + " min)" : ""));
    }
    if (o.address.fee) lines.push("Delivery fee: " + money(o.address.fee));
  }
  if (o.deliveryFee) lines.push("Delivery fee: " + money(o.deliveryFee));
  if (o.note) lines.push("📝 Note: " + o.note);
  lines.push("Method: " + o.method);
  lines.push("");
  lines.push("*TOTAL: " + money(o.total) + "*");
  lines.push("Status: PAID ✅ (auto-verified)");
  return lines.join("\n");
}

/* ---------------- Paystack: initialise transaction ---------------- */
app.post("/api/order/init", async function (req, res) {
  const order = req.body || {};
  if (!order.reference) order.reference = "CFD" + Date.now() + Math.floor(Math.random() * 1000);

  // Persist a pending order snapshot.
  order.status = "pending";
  order.createdAt = new Date().toISOString();
  orders.push(order);
  saveOrders();

  if (!config.paystackSecretKey) {
    // No key configured (local/demo): return ref; webhook flow documented in README.
    return res.json({ status: "ok", reference: order.reference, mode: "demo",
                      message: "Paystack secret not set — running in demo mode." });
  }

  try {
    const initBody = JSON.stringify({
      email: order.customer && order.customer.email,
      amount: Math.round((order.total || 0) * 100),
      currency: "NGN",
      reference: order.reference,
      channels: ["card", "bank_transfer"], // card + dynamic virtual account
      metadata: {
        customer_name: order.customer && order.customer.name,
        phone: order.customer && order.customer.phone,
        address: order.address && order.address.description,
        distance_km: order.address && order.address.distanceKm,
        items: (order.items || []).map((i) => i.qty + "x " + i.name).join(", "),
        note: order.note || "",
      },
    });
    const r = await httpsJson({
      hostname: "api.paystack.co",
      path: "/transaction/initialize",
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.paystackSecretKey,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(initBody),
      },
    }, initBody);

    if (r.body && r.body.status) return res.json({ status: "ok", reference: order.reference, data: r.body.data });
    return res.status(400).json({ status: "error", message: "Paystack init failed", detail: r.body });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
});

/* ---------------- Paystack: verify (client callback safety net) ---------------- */
app.get("/api/order/verify", async function (req, res) {
  const reference = req.query.reference;
  if (!reference) return res.status(400).json({ status: "error", message: "reference required" });
  if (!config.paystackSecretKey) return res.json({ status: "ok", data: { status: "success", reference: reference, mode: "demo" } });
  try {
    const r = await httpsJson({
      hostname: "api.paystack.co",
      path: "/transaction/verify/" + encodeURIComponent(reference),
      method: "GET",
      headers: { Authorization: "Bearer " + config.paystackSecretKey },
    });
    return res.status(r.status).json(r.body);
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
});

/* ---------------- Paystack WEBHOOK — HMAC-SHA512 verification ---------------- */
app.post("/api/paystack/webhook", async function (req, res) {
  const signature = req.headers["x-paystack-signature"];
  const raw = req.body; // Buffer (raw body parser)

  // 1) Verify the signature against the secret key.
  let valid = false;
  if (signature && config.paystackSecretKey) {
    const hash = crypto.createHmac("sha512", config.paystackSecretKey).update(raw).digest("hex");
    try { valid = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature)); }
    catch (e) { valid = false; }
  }

  // Always 200 quickly so Paystack doesn't retry; process asynchronously.
  res.sendStatus(200);

  if (!valid) {
    console.warn("⚠️  Webhook received with INVALID signature — ignored.");
    return;
  }

  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch (e) { return; }
  console.log("🔔 Webhook event:", event.event);

  if (event.event !== "charge.success") return;

  const p = event.data || {};
  const reference = p.reference;

  // Find the matching order snapshot (or construct from Paystack metadata).
  let order = orders.find((o) => o.reference === reference);
  if (!order) {
    const md = p.metadata || {};
    order = {
      reference: reference,
      customer: { name: md.customer_name || "Customer", phone: md.phone || "", email: p.customer && p.customer.email },
      address: md.address ? { description: md.address, distanceKm: md.distance_km || 0, fee: 0 } : null,
      note: md.note || "",
      method: (p.authorization && p.authorization.channel) || p.channel || "card",
      items: [{ name: md.items || "Order", qty: 1, unitPrice: p.amount / 100, lineTotal: p.amount / 100, options: [] }],
      total: (p.amount || 0) / 100,
      subtotal: (p.amount || 0) / 100,
      deliveryFee: 0,
    };
    orders.push(order);
  }

  // Guard against double-processing the same reference.
  if (order.status === "paid") { console.log("↩️  Duplicate webhook for", reference, "— ignored."); return; }

  order.status = "paid";
  order.paidAt = new Date().toISOString();
  order.paystack = {
    reference: reference,
    amount: p.amount,
    channel: p.authorization && p.authorization.channel,
    paidAt: p.paid_at,
  };
  saveOrders();

  // 2) Broadcast to admin panel (chime plays client-side).
  broadcast(order);

  // 3) Dispatch instant WhatsApp alert.
  const message = formatOrderMessage(order);
  const dispatch = await dispatchWhatsApp(message);
  console.log("✅ Order " + reference + " verified & paid — total " + money(order.total));
  console.log("   WhatsApp dispatch:", JSON.stringify(dispatch));
});

/* ---------------- Health (no sensitive data) ---------------- */
app.get("/api/health", function (req, res) {
  res.json({
    ok: true,
    service: "Cyril's Foods API",
    paystackConfigured: !!config.paystackSecretKey,
    origin: { lat: config.originLat, lng: config.originLng, address: config.originAddress },
    ratePerKm: config.ratePerKm,
    time: new Date().toISOString(),
  });
});

/* ---------------- SECRET KITCHEN PORTAL ROUTE ----------------
   Staff-only page (no link anywhere on the public site). Served at a
   non-obvious URL; the dashboard itself is still PIN-gated client+server side.
   Tip: rename kitchen.html / the path to something even more secret. */
app.get("/kitchen-portal", function (req, res) { res.sendFile(path.join(__dirname, "kitchen.html")); });
app.get("/cyril-kitchen-9082", function (req, res) { res.sendFile(path.join(__dirname, "kitchen.html")); });

/* SPA fallback for any non-API route. */
app.get("*", function (req, res) { res.sendFile(path.join(__dirname, "index.html")); });

app.listen(config.port, "0.0.0.0", function () {
  console.log("🍲 Cyril's Foods server running → http://localhost:" + config.port);
  console.log("   Paystack:", config.paystackSecretKey ? "configured ✓" : "DEMO mode (set PAYSTACK_SECRET_KEY)");
  console.log("   WhatsApp: Twilio=" + (!!(config.twilio.sid && config.twilio.auth)) +
              " GreenAPI=" + (!!(config.greenApi.instance && config.greenApi.token)) +
              " (wa.me fallback always on)");
});
