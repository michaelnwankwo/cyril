# 🍲 Cyril's Foods — Ordering Platform

A production-ready, multi-page restaurant ordering platform for **Cyril's Foods** —
smoky party jollof, swallow, soups, peppered protein, pastries and fresh drinks,
delivered across Lagos with honest distance-based pricing, Paystack card/transfer
payments, automatic webhook verification and instant WhatsApp order alerts.

## 📄 Pages

- **`index.html`** — Homepage: evergreen food hero, category rail, **12 featured meals** (capped), delivery calculator, about, footer.
- **`menu.html`** — Dedicated **full menu** (all 140 items) with category filters, live search, deep-linking (`menu.html?cat=PROTEIN`) and a food loading transition.

## 📁 Source files

| File | Purpose |
|------|---------|
| `index.html` | Homepage markup |
| `menu.html` | Full-menu page markup |
| `styles.css` | Global design system (green/orange), shared by both pages |
| `menu.css` | Menu-page-specific layout |
| `app.js` | **Shared core engine** (loaded on both pages): hours engine, maps/distance, cart, modifiers, checkout/Paystack, admin SSE, injected overlays (cart drawer, modals, FAB), scroll-reveal, host-badge suppression. Exposes `window.CF`. |
| `menu.js` | Menu-page controller: filter chips, search, `?cat=` deep-link, food loading transition. |
| `catalog.js` | Shared data (browser + Node): brand constants, 9 categories, 4 combos, 140-item menu, **12 featured items**, modifiers. Exposes `window.CYRIL`. |
| `server.js` | Express backend: static hosting, Paystack init, **HMAC-SHA512 webhook verification**, order persistence, WhatsApp dispatch, SSE admin stream. |
| `assets/` | Official logo, brand photography, AI-generated category art, evergreen hero food shots. |

## 🚀 Run

```bash
npm install
npm start          # → http://localhost:3000  (and /menu.html)
```

No keys required to preview: runs in **demo mode** with free **OpenStreetMap
(Photon + OSRM)** routing so the distance calculator works out of the box.

## ⚙️ Go-live config

Copy `.env.example` → `.env` (or set env vars):

```bash
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_PUBLIC_KEY=pk_live_...
TWILIO_ACCOUNT_SID=...  TWILIO_AUTH_TOKEN=...   # optional WhatsApp provider
GREEN_API_INSTANCE=... GREEN_API_TOKEN=...       # alternative WhatsApp provider
REST_LAT=6.5244  REST_LNG=3.3792  RATE_PER_KM=1100
```

Set the **public** browser keys at the top of each HTML page:
```js
window.CYRIL_PAYSTACK_PK = "pk_live_xxx";
window.CYRIL_GOOGLE_MAPS_KEY = "AIza...";   // enables Google Places + Distance Matrix
```
Point the Paystack dashboard webhook to `https://your-domain.com/api/paystack/webhook`.

## 🧠 Key behaviour

- **Hours:** 9:00 AM – 7:00 PM WAT. After 7 PM every item shows *Out of Stock*, the
  banner shows the closed message, and add-to-cart/checkout are locked (re-checks every minute).
  QA override: `?hours=closed` | `?hours=open`.
- **Cross-page cart & fee:** cart contents and the resolved delivery address
  (`km × ₦1,100`) persist in `localStorage` across `index.html` ↔ `menu.html`.
- **Distance engine:** Google Places + Distance Matrix (if key set) → free OSRM/Photon
  fallback → haversine estimate. Fee is always derived from a real route, never hardcoded.
- **Modifiers:** protein/extras (e.g. Grilled Chicken **+₦1,000**) update price live.
- **Payments:** Paystack Inline, `card` + `bank_transfer` (dynamic virtual accounts).
  The `charge.success` webhook is HMAC-SHA512 verified (forged events rejected, dupes
  ignored) → order marked paid → admin panel chime (🔔, SSE) → WhatsApp alert to 0808 198 8184.
- **Footer:** slides into view on scroll (IntersectionObserver `translateY`), refined
  high-contrast typography and a redesigned CTA button.
- **Netlify badge:** any injected "Build/Powered by Netlify" badge is suppressed via CSS + DOM removal.

## 📞 Contact (built in)

- 🛵 Delivery / WhatsApp: **0808 198 8184** — https://wa.me/2348081988184
- 📦 Bulk orders: **0805 354 0206**
- ✉️ **cyrilsfood@gmail.com** · socials **@Cyrilsfoods**

## ✅ QA

All suites green: 27 two-page browser tests, 22 link/asset/integrity checks,
7 closed-hours (multi-page) tests, plus Paystack webhook signature tests
(valid→paid, forged→rejected, duplicate→ignored) and unit tests for hours, fees and menu data.
