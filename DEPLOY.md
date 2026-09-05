# Deploying Cyril's Foods — Frontend (Netlify) + Backend (Render)

The site is static HTML/JS; `server.js` is the Express backend that handles
the kitchen PIN login + order stream, Paystack init/verify, and open/closed
status. Netlify only serves the static files, so the backend runs on Render.

## Step 1 — Push the repo to GitHub
All files (server.js, config.js, app.js, kitchen.js, *.html, styles.css,
assets/, render.yaml) must be in the repo Netlify and Render both point at.

## Step 2 — Deploy the backend on Render
1. Go to https://dashboard.render.com → **New → Blueprint**.
2. Connect your GitHub repo. Render reads `render.yaml` and creates a web
   service named `cyrils-foods` (free plan).
3. Set the **secret** env vars when prompted (marked `sync: false`):
   - `TOKEN_SECRET` — long random string. Generate with `openssl rand -hex 32`.
   - `PAYSTACK_SECRET_KEY` — `sk_live_…` (or `sk_test_…` while testing).
   - `PAYSTACK_PUBLIC_KEY` — `pk_live_…` / `pk_test_…`.
   - WhatsApp vars (optional): `WHATSAPP_ALERT_TO`, `TWILIO_*`.
4. Create the service. When live it has a URL like
   `https://cyril-ab8l.onrender.com`.
5. Verify: `https://<your-service>.onrender.com/api/status` returns JSON
   `{"manualClosed":...,"outOfStock":...}`.

> Free tier sleeps after ~15 min idle; the first request then takes ~30–50s.
> Render's free filesystem is ephemeral — `orders.json` resets on redeploy.
> Orders also go to WhatsApp and Paystack; upgrade later for durable history.

## Step 3 — Point the static site at the backend
Open **config.js** and set the production URL (no trailing slash):

```js
return "https://cyril-ab8l.onrender.com";   // your Render service URL
```

Local development is unaffected — on localhost it automatically uses `:3000`.
Commit and push (Netlify auto-deploys).

## Step 4 — Paystack webhook (auto-confirm orders)
In the Paystack dashboard → Settings → API Keys & Webhooks, set Webhook URL to:

```
https://cyril-ab8l.onrender.com/api/paystack/webhook
```

## Step 5 — Set the kitchen PIN
Staff access is a single **4-digit PIN** (`KITCHEN_PIN` in `render.yaml`,
default `8818`). To change it:
- Edit `KITCHEN_PIN` in `render.yaml` (e.g. `value: "4729"`) and push, **or**
- Set `KITCHEN_PIN` in the Render dashboard → Environment → Save.

Anyone with the PIN can open the order dashboard, so share it only with staff.
There is no email/magic-link step — the PIN is the whole login.

## How staff log in (production)
1. On the live site, **triple-tap the logo** (3 taps within 1.5s).
2. Enter the 4-digit kitchen PIN → **Unlock kitchen**.
3. The dashboard opens (`kitchen.html`) and stays signed in for 24 hours on
   that device. Use **Lock** to sign out.

## Troubleshooting
- **"Kitchen login isn't reachable"** — the Render service is asleep or
  config.js points at the wrong URL. Hit `https://<service>.onrender.com/api/status`
  to wake it, and double-check `config.js`.
- **"Incorrect PIN"** — the PIN entered doesn't match `KITCHEN_PIN`. Verify the
  value in render.yaml / the Render dashboard and that the latest deploy is live.
- **CORS error in console** — the site origin isn't in `CORS_ORIGIN`. Add your
  exact Netlify/custom domain and redeploy.
