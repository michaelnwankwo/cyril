# Deploying Cyril's Foods — Frontend (Netlify) + Backend (Render)

The site is static HTML/JS; `server.js` is the Express backend that handles
staff magic-link login, the kitchen order stream, Paystack init/verify,
open/closed status, and WhatsApp alerts. Netlify only serves the static files,
so the backend must run somewhere reachable — Render (free) is the default.

## Step 1 — Push the repo to GitHub
All files (server.js, config.js, app.js, kitchen.js, *.html, styles.css,
assets/, render.yaml) must be in the repo Netlify and Render both point at.

## Step 2 — Deploy the backend on Render
1. Go to https://dashboard.render.com → **New → Blueprint**.
2. Connect your GitHub repo. Render reads `render.yaml` and creates a web
   service named `cyrils-foods` (free plan).
3. Set the **secret** env vars when prompted (these are marked `sync: false`
   in render.yaml, so they are NOT committed):
   - `TOKEN_SECRET` — long random string. Generate with `openssl rand -hex 32`.
   - `PAYSTACK_SECRET_KEY` — `sk_live_…` (or `sk_test_…` while testing).
   - `PAYSTACK_PUBLIC_KEY` — `pk_live_…` / `pk_test_…`.
   - `EMAIL_WEBHOOK_URL` / `EMAIL_WEBHOOK_KEY` — (optional) Resend/Brevo/Mailgun
     webhook so magic links are emailed. If unset, the link is printed to the
     **Render Logs** — open the log after requesting a link to copy it.
   - WhatsApp vars (optional): `WHATSAPP_ALERT_TO`, `TWILIO_*`.
4. Create the service. When live it has a URL like
   `https://cyrils-foods.onrender.com`.
5. Verify: `https://<your-service>.onrender.com/api/status` returns JSON
   `{"manualClosed":...,"outOfStock":...}`.

> Free tier sleeps after ~15 min idle; the first request then takes ~30–50s.
> Also note Render's free filesystem is ephemeral — `orders.json` resets on
> redeploy/restart. Orders are also pushed to WhatsApp and kept in Paystack;
> for durable history, upgrade to a paid instance or add a database later.

## Step 3 — Point the static site at the backend
Open **config.js** and set the production URL (no trailing slash):

```js
return "https://cyrils-foods.onrender.com";   // your Render service URL
```

Local development is unaffected — on localhost it automatically uses `:3000`.

Commit and push (Netlify auto-deploys). After deploy, staff login, the kitchen
portal, payments, and status all run through Render.

## Step 4 — Paystack webhook (auto-confirm orders)
In the Paystack dashboard → Settings → API Keys & Webhooks, set Webhook URL to:

```
https://cyrils-foods.onrender.com/api/paystack/webhook
```

(Paystack calls your backend, not Netlify, so this must be the Render URL.)

## Step 5 — Authorize staff
`KITCHEN_EMAILS` in render.yaml lists emails allowed to receive magic links
(comma-separated, case-insensitive). Add/remove staff there or in the Render
dashboard, then the app picks it up on next deploy/restart. Non-listed emails
get a generic "if that email is authorized…" message (anti-enumeration).

## How staff log in (production)
1. Triple-tap the logo (3 taps within 1.5s) on the live Netlify site.
2. Enter an authorized email → **Email me a sign-in link**.
3. Open the link from email (or from Render Logs if `EMAIL_WEBHOOK_URL` unset).
4. It redirects to `https://cyrilfoods.netlify.app/kitchen.html#authed=…`,
   stores the 24h token under the Netlify origin, and opens the dashboard.

## Troubleshooting
- **"Staff login isn't connected on this preview"** — config.js still points at
  the wrong/blank API base, or the Render service is asleep. Hit
  `https://<service>.onrender.com/api/status` to wake it.
- **CORS error in console** — the site origin isn't in `CORS_ORIGIN`. Add your
  exact Netlify/custom domain to that var and redeploy.
- **Magic link lands on the wrong domain** — set `FRONTEND_URL` to your Netlify
  URL so redirects return to the static site.
