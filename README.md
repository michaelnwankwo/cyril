# 🍲 Cyril's Foods — Ordering Platform

A complete, production-ready redesign and automation engine for **Cyril's Foods** —
party jollof, swallow, soups, protein, pastries, fresh drinks & ice cream, delivered
across Lagos with honest distance-based pricing, Paystack card/transfer payments,
automatic webhook verification and instant WhatsApp order alerts.

> **Easter Jollof is Calling!** No Easter is complete without a loaded plate.
> From Party Jollof to the best Swallow, let's feed your celebration today!

---

## 📁 Files

| File | Purpose |
|------|---------|
| `index.html` | Full page structure — hero, categories, menu, delivery calculator, about, footer, cart drawer, item modal, checkout modal, admin panel. |
| `styles.css` | Brand design system (green `#2f7d32/#50a050`, orange `#f07000`), responsive layout, food loader, micro-interactions. |
| `menu.js` | Shared data: brand constants, 9 categories, **4 signature combos** and **136 scraped à-la-carte items (140 total)** with modifiers. Works in browser & Node. |
| `app.js` | Frontend engine: hours engine, maps/distance, autocomplete, menu render, cart, modifiers, Paystack checkout, admin SSE. |
| `server.js` | Express backend: static hosting, Paystack init, **HMAC-SHA512 webhook verification**, order persistence, WhatsApp dispatch, SSE admin stream. |
| `assets/` | Official logo + brand photography (from the GitHub repo) + 9 AI-generated category food photos. |

---

## 🚀 Run it

```bash
npm install
npm start          # → http://localhost:3000
```

No keys required to preview: the site runs in **demo mode** with free
**OpenStreetMap (Photon + OSRM)** routing so the distance calculator works out of the box.

---

## ⚙️ Configuration (go-live)

Copy `.env.example` → `.env` (or set environment variables on your host):

```bash
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_PUBLIC_KEY=pk_live_...
TWILIO_ACCOUNT_SID=...          # optional WhatsApp provider
TWILIO_AUTH_TOKEN=...
GREEN_API_INSTANCE=...          # alternative WhatsApp provider
GREEN_API_TOKEN=...
REST_LAT=6.5244                 # fixed kitchen origin
REST_LNG=3.3792
RATE_PER_KM=1100
```

Set the **public** browser keys in `index.html`:
```js
window.CYRIL_PAYSTACK_PK = "pk_live_xxx";
window.CYRIL_GOOGLE_MAPS_KEY = "AIza...";   // enables Google Places + Distance Matrix
```

**Paystack webhook:** in the Paystack dashboard set the webhook URL to
`https://your-domain.com/api/paystack/webhook`. The server verifies the
`x-paystack-signature` header with HMAC-SHA512 — invalid/forged events are rejected.

---

## 🧠 Operating logic

- **Hours:** Open 9:00 AM – 7:00 PM WAT (`Africa/Lagos`). After 7:00 PM every item
  shows **"Out of Stock"**, the banner reads *"Yes, we are closed! But we'd be back by
  opening time (9:00 AM)"*, and add-to-cart/checkout are disabled. Re-checks every minute.
  - QA override: append `?hours=closed` or `?hours=open` to force a state.
- **Distance engine:** address selected via Google Places Autocomplete (or OSM Photon
  fallback) → driving distance from the fixed kitchen origin via Google Distance Matrix
  (or OSRM/haversine fallback) → **fee = kilometres × ₦1,100**, added at checkout. Never hardcoded.
- **Modifiers:** combos & rice meals support protein choices
  (e.g. Grilled Chicken **+₦1,000**, Fried Fish/Beef ₦0) and extras; prices update live.
- **Payments:** Paystack Inline with `card` + `bank_transfer` (dynamic virtual accounts).
  The `charge.success` webhook auto-verifies payment — zero human verification — then:
  1. marks the order **paid**, 2. streams it to the admin panel (🔔 chime),
  3. sends a formatted **WhatsApp alert to 0808 198 8184** via Twilio/Green API
     (falls back to a logged `wa.me` deep-link).

**Admin panel:** click the 🔔 button (bottom-right). Live paid orders stream in over SSE
with a chime, customer call/WhatsApp shortcuts, items, distance and total.

---

## 📞 Contact (built into the site)

- 🛵 Delivery / WhatsApp: **0808 198 8184** — https://wa.me/2348081988184
- 📦 Bulk orders: **0805 354 0206**
- ✉️ Email: **cyrilsfood@gmail.com**
- 📱 Socials: **@Cyrilsfoods** (Facebook, Instagram, X)

---

## ✅ QA summary

Automated verification (all passing):
- 12/12 HTTP/integration · 8/8 webhook (valid→paid, forged→rejected, duplicate→ignored)
- 20/20 unit (menu integrity, hours states, fee math) · 17/17 browser smoke · 7/7 closed-hours
- DOM id integrity, all internal anchors, WhatsApp numbers, tel/mailto, and asset paths verified.
