/* =============================================================
   CYRIL'S FOODS — RUNTIME CONFIG  (loaded first on every page)
   -------------------------------------------------------------
   This is the ONLY file you edit to point the static site at its
   backend. It is read by app.js (customer pages) and kitchen.js
   (staff portal).

   • Local development (localhost / 127.0.0.1, incl. Live Server
     :5500): the backend is auto-detected on :3000 — leave as-is.
   • Production (Netlify static hosting): set API_BASE to your
     deployed Render service URL, e.g. "https://cyril-ab8l.onrender.com"
   • If you instead serve the whole site FROM the backend (same
     origin), an empty string "" is correct and keeps everything
     same-origin.
   ============================================================= */
window.CYRIL_API_BASE = (function () {
  // If a host already set it explicitly, respect that.
  if (window.CYRIL_API_BASE) return window.CYRIL_API_BASE;

  var host = window.location.hostname || "";
  var isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (isLocal) return window.location.protocol + "//" + host + ":3000";

  // ┏━━ PRODUCTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
  // ┃ Your deployed Render backend (no trailing slash).   ┃
  // ┃ localhost is auto-detected above and uses :3000.    ┃
  // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
  return "https://cyril-ab8l.onrender.com";
})();

/* Optional: Supabase Auth for fully-static magic links.
   Leave blank — the deployed Node backend handles staff login.
window.CYRIL_SUPABASE_URL = "";
window.CYRIL_SUPABASE_ANON_KEY = "";
*/
