/* =============================================================
   CYRIL'S FOODS â BACKEND VERIFICATION & AUTOMATION ENGINE (server.js)
   Responsibilities:
     â¢ Serve the static site
     â¢ Initialise Paystack transactions (card + dynamic bank transfer)
     â¢ Receive & HMAC-SHA512 verify Paystack webhooks (charge.success)
       â zero human verification.
     â¢ Persist verified orders
     â¢ Dispatch an instant WhatsApp alert to 08081988184
       (Twilio WhatsApp / Green API / wa.me fallback)
     â¢ Stream verified orders to the admin panel via SSE (+ chime client-side)
   Run:  node server.js   (see .env.example for configuration)
   ============================================================= */
"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

/* ---------------- Load .env if present (zero dependencies) ---------------- */
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .forEach(function (line) {
        line = line.trim();
        if (!line || line[0] === "#") return;
        const eq = line.indexOf("=");
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (
          (val[0] === '"' && val[val.length - 1] === '"') ||
          (val[0] === "'" && val[val.length - 1] === "'")
        )
          val = val.slice(1, -1);
        if (key && process.env[key] === undefined) process.env[key] = val;
      });
  } catch (e) {
    /* .env is optional */
  }
})();

/* ---------------- Configuration (env-driven) ---------------- */
const config = {
  port: process.env.PORT || 3000,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || "",
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || "",
  // WhatsApp dispatch â choose whichever provider creds are present.
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
  // Restaurant fixed origin (Point A) â 26 College Rd, Ifako-Ijaiye, Lagos.
  originAddress:
    process.env.REST_ADDRESS || "26 College Rd, Ifako-Ijaiye, Lagos, Nigeria",
  originLat: parseFloat(process.env.REST_LAT || "6.6427"),
  originLng: parseFloat(process.env.REST_LNG || "3.3288"),
  ratePerKm: parseInt(process.env.RATE_PER_KM || "1100", 10),
  ordersFile: path.join(__dirname, "orders.json"),
};

const app = express();
// Render/Heroku-style hosts terminate TLS at a proxy. Trust the first proxy hop
// so req.protocol is https and generated links/emails use the correct scheme.
app.set("trust proxy", 1);

/* ---- Kitchen portal security (passwordless magic-link) ----
   Staff enter an authorized email; the server emails a single-use link (valid
   10 min). Clicking it mints an HMAC-signed session token that lasts exactly
   24 hours (86,400 s). The old PIN endpoint remains as a private break-glass. */
const KITCHEN_PIN = process.env.KITCHEN_PIN || "8818";
const TOKEN_SECRET =
  process.env.TOKEN_SECRET ||
  process.env.PAYSTACK_SECRET_KEY ||
  "cyrils-kitchen-" + KITCHEN_PIN;
const SESSION_TTL_SEC = 86400; // 24 hours
const SESSION_TTL_MS = SESSION_TTL_SEC * 1000;
const MAGIC_TTL_SEC = 600; // 10 minutes
const MAGIC_TTL_MS = MAGIC_TTL_SEC * 1000;
// Authorized staff inbox(es). Comma-separate in KITCHEN_EMAILS to add more.
const KITCHEN_EMAILS = (
  process.env.KITCHEN_EMAILS ||
  "kitchen@cyrilfoods.com.ng,michaelnwankwo186@gmail.com"
)
  .split(",")
  .map(function (s) {
    return s.trim().toLowerCase();
  })
  .filter(Boolean);
// 👉 To add/remove staff emails, edit the KITCHEN_EMAILS value in render.yaml
//    (comma-separated) and push — Render auto-deploys with the new list.
// Single-use magic codes, keyed by token: { email, exp }
const magicCodes = new Map();

function b64url(s) {
  return Buffer.from(s)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(body)
    .digest("hex")
    .slice(0, 32);
  return body + "." + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1)
    return null;
  const dot = token.lastIndexOf(".");
  const body = token.slice(0, dot),
    sig = token.slice(dot + 1);
  const expect = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(body)
    .digest("hex")
    .slice(0, 32);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)))
      return null;
    const payload = JSON.parse(
      Buffer.from(
        body.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    );
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function extractToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.indexOf("Bearer ") === 0) return auth.slice(7);
  const q = new URL(req.url, "http://x").searchParams.get("token"); // SSE can't set headers via EventSource
  return q || null;
}
// Auth middleware â blocks all unauthorized kitchen requests with 401.
function requireKitchen(req, res, next) {
  const payload = verifyToken(extractToken(req));
  if (!payload)
    return res
      .status(401)
      .json({
        status: "error",
        message: "Unauthorized â valid kitchen session required.",
      });
  req.kitchen = payload;
  next();
}

/* Raw body is required for Paystack signature verification â BEFORE json parser. */
app.use("/api/paystack/webhook", express.raw({ type: "*/*" }));
/* ---- CORS: default to KNOWN production origins (override with CORS_ORIGIN) ----
   Never ship a wide-open "*" against public order/auth endpoints. Local dev
   origins are allowed automatically. */
const KNOWN_ORIGINS = [
  "https://cyrilfoods.netlify.app",
  "https://cyrilsfood.com.ng",
  "https://www.cyrilsfood.com.ng",
];
const CORS_WHITELIST = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(function (s) {
    return s.trim();
  })
  .filter(Boolean)
  .concat(KNOWN_ORIGINS);
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / curl / server-to-server
  if (CORS_WHITELIST.indexOf(origin) !== -1) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true; // local dev
  return false;
}
app.use(function (req, res, next) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin))
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS")
    return res.sendStatus(isAllowedOrigin(origin) ? 204 : 403);
  next();
});

/* ---- Simple in-memory IP rate limiter (no external deps) ----
   Usage: rateLimit(maxHits, windowMs) â middleware. */
function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}
function rateLimit(maxHits, windowMs) {
  const hits = new Map();
  // periodic cleanup
  setInterval(function () {
    const now = Date.now();
    hits.forEach(function (v, k) {
      if (v.reset < now) hits.delete(k);
    });
  }, windowMs).unref && setInterval(function () {}, 1000).unref();
  return function (req, res, next) {
    const key = clientIp(req) + "|" + req.path;
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.reset < now) {
      rec = { count: 0, reset: now + windowMs };
      hits.set(key, rec);
    }
    rec.count++;
    if (rec.count > maxHits) {
      res.setHeader("Retry-After", Math.ceil((rec.reset - now) / 1000));
      return res
        .status(429)
        .json({
          status: "error",
          message: "Too many requests. Please try again shortly.",
        });
    }
    next();
  };
}

/* ---- Input sanitization: strip control chars & angle brackets from user text ----
   Defense in depth â the client also renders via textContent/esc(). */
function cleanStr(v, max) {
  if (v == null) return "";
  return String(v)
    .replace(/[<>"'`]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || 200);
}

/* ---- Baseline security response headers ---- */
app.use(function (req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(self), microphone=(), camera=()",
  );
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname, { dotfiles: "deny" })); // never serve .env, .git, etc.
// Belt-and-suspenders: hard 404 for any dotfile request (.env, .git/*, â¦) so the
// SPA fallback can never mask them with a 200.
app.use(function (req, res, next) {
  if (/\/\.[^/]*/.test(new URL(req.url, "http://x").pathname))
    return res.status(404).send("Not found");
  next();
});

/* ---- Staff overrides state (manual closed / sold-out items) ---- */
const kitchenStatusFile = path.join(__dirname, "kitchen-status.json");
let kitchenStatus = { manualClosed: false, outOfStock: [] };
try {
  if (fs.existsSync(kitchenStatusFile))
    kitchenStatus = JSON.parse(fs.readFileSync(kitchenStatusFile, "utf8"));
} catch (e) {}
function saveKitchenStatus() {
  try {
    fs.writeFileSync(kitchenStatusFile, JSON.stringify(kitchenStatus, null, 2));
  } catch (e) {}
}

/* PUBLIC status snapshot (no order data) â storefront uses this for overrides. */
app.get("/api/status", function (req, res) {
  res.json({
    manualClosed: !!kitchenStatus.manualClosed,
    outOfStock: kitchenStatus.outOfStock || [],
    time: new Date().toISOString(),
  });
});

/* ---- Kitchen auth ---- */
function handlePinLogin(req, res) {
  const pin = String((req.body && req.body.pin) || "").trim();
  const expected = String(KITCHEN_PIN);
  let ok = false;
  if (pin.length === expected.length) {
    try {
      ok = crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(expected));
    } catch (e) {
      ok = false;
    }
  }
  if (!ok)
    return res
      .status(401)
      .json({ status: "error", message: "Incorrect kitchen passcode." });
  const token = signToken({
    role: "kitchen",
    exp: Date.now() + SESSION_TTL_MS,
  });
  res.json({ status: "ok", token: token, expiresIn: SESSION_TTL_SEC });
}
app.post("/api/kitchen/login", rateLimit(10, 15 * 60 * 1000), handlePinLogin);

/* ---- Passwordless magic-link auth ---- */
function publicBaseUrl(req) {
  return (
    process.env.PUBLIC_URL ||
    (req && req.protocol && req.get
      ? req.protocol + "://" + req.get("host")
      : "http://localhost:3000")
  );
}
// Where the customer-facing site lives. When the static site is hosted separately
// (e.g. Netlify) and the API on Render, magic-link redirects must land on the
// FRONTEND so the 24h token is stored under the site origin. Same-origin deploys
// can leave this unset (falls back to the backend origin).
function frontendBaseUrl(req) {
  return process.env.FRONTEND_URL || publicBaseUrl(req);
}
// Best-effort email delivery. Configure one provider; otherwise the link is
// printed to the server console (fine for local/dev / VPS logs).
function sendStaffEmail(to, link) {
  const subject = "Cyril's Foods kitchen â sign-in link";
  const text =
    "Your Cyril's Foods kitchen sign-in link (valid 10 minutes, single use):\n\n" +
    link +
    "\n\nIf you didn't request this, ignore this email.";
  // 1) Generic email webhook (e.g. Resend, Brevo, Mailgun, Zapier) â POST JSON.
  const hook = process.env.EMAIL_WEBHOOK_URL;
  if (hook) {
    return new Promise(function (resolve) {
      const u = new URL(hook);
      const payload = JSON.stringify({
        to: to,
        subject: subject,
        text: text,
        html: text.replace(/\n/g, "<br>"),
      });
      const reqMod = u.protocol === "https:" ? https : require("http");
      const r = reqMod.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            ...(process.env.EMAIL_WEBHOOK_KEY
              ? { Authorization: "Bearer " + process.env.EMAIL_WEBHOOK_KEY }
              : {}),
          },
        },
        function (resp) {
          resp.resume();
          resp.on("end", function () {
            resolve(resp.statusCode < 300);
          });
        },
      );
      r.on("error", function () {
        resolve(false);
      });
      r.write(payload);
      r.end();
    });
  }
  // 2) Fallback: surface the link in the server log.
  console.log("\nð KITCHEN MAGIC LINK â " + to + "\n   " + link + "\n");
  return Promise.resolve(true);
}

// Dev/staging mode: expose the magic link in the API response so it can be tested
// from the browser console without waiting for email. NEVER enabled in production.
function isDevAuth(req) {
  if (process.env.DEV_AUTH === "true") return true;
  if (process.env.NODE_ENV === "production") return false;
  const host = (req.get && req.get("host")) || "";
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}
function handleMagicRequest(req, res) {
  const email = String((req.body && req.body.email) || "")
    .trim()
    .toLowerCase();
  const authorized = KITCHEN_EMAILS.indexOf(email) !== -1;
  const dev = isDevAuth(req);
  // Always return a generic success to avoid revealing which emails are valid.
  if (authorized) {
    const code = crypto.randomBytes(24).toString("hex");
    magicCodes.set(code, { email: email, exp: Date.now() + MAGIC_TTL_MS });
    // sweep expired
    const now = Date.now();
    magicCodes.forEach(function (v, k) {
      if (v.exp < now) magicCodes.delete(k);
    });
    const link = publicBaseUrl(req) + "/api/kitchen/magic-verify?code=" + code;
    sendStaffEmail(email, link);
    const payload = {
      status: "ok",
      message: "If that email is authorized, a sign-in link is on its way.",
    };
    if (dev) payload.devLink = link; // local/staging console testing only
    return res.json(payload);
  }
  res.json({
    status: "ok",
    message: "If that email is authorized, a sign-in link is on its way.",
  });
}
// Limit magic-link requests: 3 per IP per 15 minutes (anti-spam / brute force).
const magicLimiter = rateLimit(3, 15 * 60 * 1000);
app.post("/api/kitchen/magic-request", magicLimiter, handleMagicRequest);
app.post("/api/auth/magic-link", magicLimiter, handleMagicRequest); // canonical alias

// Magic-link landing: verify the single-use code, mint a 24h session, redirect.
app.get("/api/kitchen/magic-verify", function (req, res) {
  const code = String(req.query.code || "");
  const rec = magicCodes.get(code);
  if (!rec || rec.exp < Date.now()) {
    magicCodes.delete(code);
    return res.redirect(frontendBaseUrl(req) + "/kitchen.html?auth=denied");
  }
  magicCodes.delete(code); // single use
  const token = signToken({
    role: "kitchen",
    email: rec.email,
    exp: Date.now() + SESSION_TTL_MS,
  });
  res.redirect(
    frontendBaseUrl(req) + "/kitchen.html#authed=" + encodeURIComponent(token),
  );
});

/* Authenticated kitchen endpoints */
app.get("/api/kitchen/orders", requireKitchen, function (req, res) {
  res.json(
    orders
      .filter(function (o) {
        return o.status === "paid";
      })
      .slice(-50)
      .reverse(),
  );
});

app.post("/api/kitchen/control", requireKitchen, function (req, res) {
  const body = req.body || {};
  if (typeof body.manualClosed === "boolean")
    kitchenStatus.manualClosed = body.manualClosed;
  if (Array.isArray(body.outOfStock))
    kitchenStatus.outOfStock = body.outOfStock.map(String).slice(0, 500);
  if (Array.isArray(body.toggleItem)) {
    const id = String(body.toggleItem[0]);
    const on = !!body.toggleItem[1];
    const set = new Set(kitchenStatus.outOfStock);
    if (on) set.add(id);
    else set.delete(id);
    kitchenStatus.outOfStock = Array.from(set);
  }
  kitchenStatus.updatedAt = new Date().toISOString();
  saveKitchenStatus();
  res.json({ status: "ok", kitchenStatus: kitchenStatus });
});

/* Authenticated live-order SSE stream for the kitchen portal. */
app.get("/api/kitchen/stream", requireKitchen, function (req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders && res.flushHeaders();
  res.write("retry: 5000\n\n");
  orders
    .filter(function (o) {
      return o.status === "paid";
    })
    .slice(-15)
    .reverse()
    .forEach(function (o) {
      res.write("data: " + JSON.stringify(o) + "\n\n");
    });
  sseClients.add(res);
  const ka = setInterval(function () {
    try {
      res.write(":ka\n\n");
    } catch (e) {}
  }, 25000);
  req.on("close", function () {
    clearInterval(ka);
    sseClients.delete(res);
  });
});

/* ---------------- Tiny in-memory + file order store ---------------- */
let orders = [];
try {
  if (fs.existsSync(config.ordersFile))
    orders = JSON.parse(fs.readFileSync(config.ordersFile, "utf8"));
} catch (e) {
  orders = [];
}
function saveOrders() {
  try {
    fs.writeFileSync(config.ordersFile, JSON.stringify(orders, null, 2));
  } catch (e) {}
}

/* SSE client pool â only authenticated kitchen portal streams subscribe. */
const sseClients = new Set();
function broadcast(order) {
  const payload = JSON.stringify(order);
  sseClients.forEach(function (res) {
    try {
      res.write("data: " + payload + "\n\n");
    } catch (e) {}
  });
}

/* ---------------- Helpers ---------------- */
const money = (n) => "â¦" + Number(n).toLocaleString("en-NG");

function httpsJson(options, body) {
  return new Promise(function (resolve, reject) {
    const req = https.request(options, function (res) {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", function () {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
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
      const basic = Buffer.from(
        config.twilio.sid + ":" + config.twilio.auth,
      ).toString("base64");
      const form = new URLSearchParams({
        From: config.twilio.from,
        To: config.twilio.to,
        Body: message,
      }).toString();
      const r = await httpsJson(
        {
          hostname: "api.twilio.com",
          path: "/2010-04-01/Accounts/" + config.twilio.sid + "/Messages.json",
          method: "POST",
          headers: {
            Authorization: "Basic " + basic,
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(form),
          },
        },
        form,
      );
      results.push({
        provider: "twilio",
        ok: r.status >= 200 && r.status < 300,
        detail: r.body,
      });
    } catch (e) {
      results.push({ provider: "twilio", ok: false, error: e.message });
    }
  }

  // 2) Green API (WhatsApp Business gateway)
  if (config.greenApi.instance && config.greenApi.token) {
    try {
      const body = JSON.stringify({
        chatId: config.greenApi.chatId,
        message: message,
      });
      const r = await httpsJson(
        {
          hostname: "api.green-api.com",
          path:
            "/waInstance" +
            config.greenApi.instance +
            "/sendMessage/" +
            config.greenApi.token,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        body,
      );
      results.push({
        provider: "greenapi",
        ok: r.status >= 200 && r.status < 300,
        detail: r.body,
      });
    } catch (e) {
      results.push({ provider: "greenapi", ok: false, error: e.message });
    }
  }

  // 3) Fallback: build a wa.me deep-link (logged for a human/operator or cron)
  if (!results.some((x) => x.ok)) {
    const link =
      "https://wa.me/2348081988184?text=" + encodeURIComponent(message);
    results.push({ provider: "wame-link", ok: true, link: link });
    console.log(
      "\nð² [WhatsApp alert â open this link to deliver]:\n" + link + "\n",
    );
  }
  return results;
}

function formatOrderMessage(o) {
  const lines = [];
  lines.push("ðï¸ *NEW PAID ORDER â Cyril's Foods*");
  lines.push("Ref: " + o.reference);
  lines.push("Customer: " + (o.customer && o.customer.name));
  lines.push("Phone: " + (o.customer && o.customer.phone));
  lines.push("");
  lines.push("*Items:*");
  (o.items || []).forEach(function (i) {
    lines.push(
      "â¢ " +
        i.qty +
        "x " +
        i.name +
        (i.options && i.options.length
          ? " (" + i.options.join(", ") + ")"
          : "") +
        " â " +
        money(i.lineTotal),
    );
  });
  lines.push("");
  if (o.address && o.address.description) {
    lines.push("ð Delivery: " + o.address.description);
    if (o.address.distanceKm) {
      lines.push(
        "Distance: " +
          o.address.distanceKm +
          " km" +
          (o.address.minutes ? " (~" + o.address.minutes + " min)" : ""),
      );
    }
    if (o.address.fee) lines.push("Delivery fee: " + money(o.address.fee));
  }
  if (o.deliveryFee) lines.push("Delivery fee: " + money(o.deliveryFee));
  if (o.note) lines.push("ð Note: " + o.note);
  lines.push("Method: " + o.method);
  lines.push("");
  lines.push("*TOTAL: " + money(o.total) + "*");
  lines.push("Status: PAID â (auto-verified)");
  return lines.join("\n");
}

/* ---------------- Paystack: initialise transaction ---------------- */
app.post(
  "/api/order/init",
  rateLimit(20, 10 * 60 * 1000),
  async function (req, res) {
    const raw = req.body || {};
    // Sanitize all free-text user fields server-side (defense in depth; the client
    // also renders with textContent). Numeric fields are coerced, never trusted.
    const order = {
      reference:
        cleanStr(raw.reference, 60) ||
        "CFD" + Date.now() + Math.floor(Math.random() * 1000),
      status: "pending",
      createdAt: new Date().toISOString(),
      note: cleanStr(raw.note, 300),
      method:
        ["card", "bank_transfer"].indexOf(raw.method) !== -1
          ? raw.method
          : "card",
      customer: {
        name: cleanStr(raw.customer && raw.customer.name, 80),
        phone: cleanStr(raw.customer && raw.customer.phone, 30),
        email: cleanStr(raw.customer && raw.customer.email, 120),
      },
      address:
        raw.address && raw.address.description
          ? {
              description: cleanStr(raw.address.description, 200),
              lat: Number(raw.address.lat) || config.originLat,
              lng: Number(raw.address.lng) || config.originLng,
              distanceKm: Math.min(
                120,
                Math.max(0, Number(raw.address.distanceKm) || 0),
              ),
              minutes: Number(raw.address.minutes) || 0,
              fee: Math.max(0, Math.round(Number(raw.address.fee) || 0)),
            }
          : null,
      items: Array.isArray(raw.items)
        ? raw.items.slice(0, 40).map(function (i) {
            return {
              name: cleanStr(i.name, 120),
              qty: Math.min(50, Math.max(1, parseInt(i.qty, 10) || 1)),
              unitPrice: Math.max(0, Math.round(Number(i.unitPrice) || 0)),
              options: Array.isArray(i.options)
                ? i.options.slice(0, 12).map(function (o) {
                    return cleanStr(o, 60);
                  })
                : [],
            };
          })
        : [],
    };
    // Recompute totals server-side from sanitized line items + fee (never trust client total).
    order.subtotal = order.items.reduce(function (s, i) {
      return s + i.unitPrice * i.qty;
    }, 0);
    order.deliveryFee = order.address ? order.address.fee : 0;
    order.total = order.subtotal + order.deliveryFee;
    if (
      !order.customer.name ||
      !/^[0-9+()\s-]{7,20}$/.test(order.customer.phone)
    ) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Valid name and phone number are required.",
        });
    }
    if (order.total <= 0)
      return res
        .status(400)
        .json({ status: "error", message: "Your cart is empty." });
    if (!order.customer.email)
      order.customer.email = "guest@order.cyrilsfood.com.ng";

    // Persist a pending order snapshot.
    order.status = "pending";
    order.createdAt = new Date().toISOString();
    orders.push(order);
    saveOrders();

    if (!config.paystackSecretKey) {
      // No key configured (local/demo): return ref; webhook flow documented in README.
      return res.json({
        status: "ok",
        reference: order.reference,
        mode: "demo",
        message: "Paystack secret not set â running in demo mode.",
      });
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
          items: (order.items || [])
            .map((i) => i.qty + "x " + i.name)
            .join(", "),
          note: order.note || "",
        },
      });
      const r = await httpsJson(
        {
          hostname: "api.paystack.co",
          path: "/transaction/initialize",
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.paystackSecretKey,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(initBody),
          },
        },
        initBody,
      );

      if (r.body && r.body.status)
        return res.json({
          status: "ok",
          reference: order.reference,
          data: r.body.data,
        });
      return res
        .status(400)
        .json({
          status: "error",
          message: "Paystack init failed",
          detail: r.body,
        });
    } catch (e) {
      return res.status(500).json({ status: "error", message: e.message });
    }
  },
);

/* ---------------- Paystack: verify (client callback safety net) ---------------- */
app.get("/api/order/verify", async function (req, res) {
  const reference = req.query.reference;
  if (!reference)
    return res
      .status(400)
      .json({ status: "error", message: "reference required" });
  if (!config.paystackSecretKey)
    return res.json({
      status: "ok",
      data: { status: "success", reference: reference, mode: "demo" },
    });
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

/* ---------------- Paystack WEBHOOK â HMAC-SHA512 verification ---------------- */
app.post("/api/paystack/webhook", async function (req, res) {
  const signature = req.headers["x-paystack-signature"];
  const raw = req.body; // Buffer (raw body parser)

  // 1) Verify the signature against the secret key.
  let valid = false;
  if (signature && config.paystackSecretKey) {
    const hash = crypto
      .createHmac("sha512", config.paystackSecretKey)
      .update(raw)
      .digest("hex");
    try {
      valid = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
    } catch (e) {
      valid = false;
    }
  }

  // Always 200 quickly so Paystack doesn't retry; process asynchronously.
  res.sendStatus(200);

  if (!valid) {
    console.warn("â ï¸  Webhook received with INVALID signature â ignored.");
    return;
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    return;
  }
  console.log("ð Webhook event:", event.event);

  if (event.event !== "charge.success") return;

  const p = event.data || {};
  const reference = p.reference;

  // Find the matching order snapshot (or construct from Paystack metadata).
  let order = orders.find((o) => o.reference === reference);
  if (!order) {
    const md = p.metadata || {};
    order = {
      reference: reference,
      customer: {
        name: md.customer_name || "Customer",
        phone: md.phone || "",
        email: p.customer && p.customer.email,
      },
      address: md.address
        ? { description: md.address, distanceKm: md.distance_km || 0, fee: 0 }
        : null,
      note: md.note || "",
      method:
        (p.authorization && p.authorization.channel) || p.channel || "card",
      items: [
        {
          name: md.items || "Order",
          qty: 1,
          unitPrice: p.amount / 100,
          lineTotal: p.amount / 100,
          options: [],
        },
      ],
      total: (p.amount || 0) / 100,
      subtotal: (p.amount || 0) / 100,
      deliveryFee: 0,
    };
    orders.push(order);
  }

  // Guard against double-processing the same reference.
  if (order.status === "paid") {
    console.log("â©ï¸  Duplicate webhook for", reference, "â ignored.");
    return;
  }

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
  console.log(
    "â Order " + reference + " verified & paid â total " + money(order.total),
  );
  console.log("   WhatsApp dispatch:", JSON.stringify(dispatch));
});

/* ---------------- Health (no sensitive data) ---------------- */
app.get("/api/health", function (req, res) {
  res.json({
    ok: true,
    service: "Cyril's Foods API",
    paystackConfigured: !!config.paystackSecretKey,
    origin: {
      lat: config.originLat,
      lng: config.originLng,
      address: config.originAddress,
    },
    ratePerKm: config.ratePerKm,
    time: new Date().toISOString(),
  });
});

/* ---------------- SECRET KITCHEN PORTAL ROUTE ----------------
   Staff-only page (no link anywhere on the public site). Served at a
   non-obvious URL; the dashboard itself is still PIN-gated client+server side.
   Tip: rename kitchen.html / the path to something even more secret. */
app.get("/kitchen-portal", function (req, res) {
  res.sendFile(path.join(__dirname, "kitchen.html"));
});
app.get("/cyril-kitchen-9082", function (req, res) {
  res.sendFile(path.join(__dirname, "kitchen.html"));
});

/* Fallback: branded 404 for unknown routes; JSON 404 for unknown API calls. */
app.use(function (req, res) {
  if (req.path.indexOf("/api/") === 0)
    return res.status(404).json({ status: "error", message: "Not found" });
  res.status(404).sendFile(path.join(__dirname, "404.html"), function (err) {
    if (err) res.status(404).send("Not found");
  });
});

app.listen(config.port, "0.0.0.0", function () {
  console.log(
    "ð² Cyril's Foods server running â http://localhost:" + config.port,
  );
  console.log(
    "   Paystack:",
    config.paystackSecretKey
      ? "configured â"
      : "DEMO mode (set PAYSTACK_SECRET_KEY)",
  );
  console.log(
    "   WhatsApp: Twilio=" +
      !!(config.twilio.sid && config.twilio.auth) +
      " GreenAPI=" +
      !!(config.greenApi.instance && config.greenApi.token) +
      " (wa.me fallback always on)",
  );
});
