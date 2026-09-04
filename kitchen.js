/* =============================================================
   CYRIL'S FOODS — KITCHEN PORTAL CONTROLLER  (kitchen.html)
   SECURE: PIN → server-signed token (localStorage) → authed SSE.
   No order data is ever reachable without a valid token.
   ============================================================= */
(function () {
  "use strict";

  var TOKEN_KEY = "cyrils_kitchen_token";
  var api = function (path) { return path; };
  var token = localStorage.getItem(TOKEN_KEY) || null;

  var els = {};
  function $(id) { return document.getElementById(id); }

  var state = {
    orders: [],        // rendered orders (paid), newest first
    unacked: new Set(), // refs not yet acknowledged
    soundOn: true,
    status: { manualClosed: false, outOfStock: [] },
    evt: null
  };

  /* ---------- Audio chime (WebAudio, no asset needed) ---------- */
  var actx = null;
  function ensureCtx() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } return actx; }
  var chimeTimer = null;
  function ping() {
    var ctx = ensureCtx(); if (!ctx) return;
    var now = ctx.currentTime;
    [0, 0.22, 0.44].forEach(function (off, i) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = [880, 1108, 1318][i];
      g.gain.setValueAtTime(0.0001, now + off);
      g.gain.exponentialRampToValueAtTime(0.35, now + off + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + off + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start(now + off); o.stop(now + off + 0.55);
    });
  }
  function startChime() {
    if (!state.soundOn) return;
    stopChime();
    ping();
    chimeTimer = setInterval(ping, 2600); // CONTINUOUS until acknowledged
  }
  function stopChime() { if (chimeTimer) { clearInterval(chimeTimer); chimeTimer = null; } }

  /* ---------- Auth (passwordless magic link, 24-hour session) ---------- */
  async function requestMagicLink(email) {
    var res;
    try {
      res = await fetch("/api/kitchen/magic-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ email: email })
      });
    } catch (e) {
      throw new Error("Couldn't reach the login service. Check your connection and try again.");
    }
    var ct = res.headers.get("content-type") || "";
    if (ct.indexOf("application/json") === -1) {
      throw new Error("The kitchen service isn't running here. Open this page from the correct server address.");
    }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || "Request failed. Please try again.");
    return data;
  }
  function storeToken(t) {
    token = t;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
  }
  // Pull a session token off the magic-link redirect hash (#authed=...), validate it.
  function consumeHashToken() {
    var h = (location.hash || "").replace(/^#/, "");
    var m = h.match(/(?:^|&)authed=([^&]+)/);
    if (m && m[1]) {
      storeToken(decodeURIComponent(m[1]));
      history.replaceState(null, "", location.pathname); // scrub token from the URL
      return true;
    }
    return false;
  }
  function logout() {
    token = null; try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    if (state.evt) { try { state.evt.close(); } catch (e) {} state.evt = null; }
    stopChime();
    $("dash").hidden = true; $("dash").classList.remove("is-auth");
    $("pinGate").style.display = "grid";
    var em = $("magicEmail"); if (em) em.value = "";
    var note = $("magicNote"); if (note) note.hidden = true;
  }

  /* ---------- Data helpers ---------- */
  function money(n) { return "₦" + Number(n || 0).toLocaleString("en-NG"); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function when(iso) { try { return new Date(iso).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }

  function menu() { return (window.CYRIL && window.CYRIL.MENU) || []; }
  function itemName(id) {
    var m = menu().find(function (x) { return x.id === id; });
    return m ? m.name : id;
  }

  /* ---------- Orders ---------- */
  function orderEl(o) {
    var items = (o.items || []).map(function (it) {
      return "<div>" + esc(it.qty || 1) + "× " + esc(itemName(it.id)) +
        (it.sizeName ? ' <em style="color:var(--ink-300)">(' + esc(it.sizeName) + ")</em>" : "") + "</div>";
    }).join("");
    var delivery = o.delivery || {};
    var phone = String(o.phone || o.customerPhone || "").replace(/\D/g, "");
    var wa = "https://wa.me/234808198814?text=" + encodeURIComponent(
      "New order " + o.reference + "\nCustomer: " + (o.customer || "") + "\nPhone: " + (o.phone || "") +
      "\nAddress: " + (delivery.address || o.address || "—") + "\nTotal: " + money(o.amountPaid || o.total));
    return '<article class="korder' + (state.unacked.has(o.reference) ? " korder--unacked" : " is-acked") + '" data-ref="' + esc(o.reference) + '">' +
      '<div class="korder__head"><div><div class="korder__id">' + esc(o.reference) + '</div>' +
      '<div class="korder__time">' + esc(when(o.paidAt || o.createdAt)) + "</div></div>" +
      '<div class="korder__amt">' + money(o.amountPaid || o.total) + "</div></div>" +
      '<div class="korder__meta"><strong>' + esc(o.customer || "Customer") + "</strong> · " + esc(o.phone || "") + "<br>" +
      esc(delivery.address || o.address || "Pickup") + (delivery.km ? " · " + delivery.km + " km · fee " + money(delivery.fee) : "") +
      (delivery.eta ? " · ETA " + Math.round(delivery.eta) + " min" : "") + "</div>" +
      '<div class="korder__items">' + items + "</div>" +
      '<div class="korder__acts">' +
        '<a class="korder__wa" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' +
        (phone ? '<a class="korder__call" href="tel:' + esc(phone) + '">Call</a>' : "") +
        '<button class="korder__ack" data-ack="' + esc(o.reference) + '">Acknowledge Order ✓</button>' +
      "</div></article>";
  }

  function renderOrders() {
    var wrap = $("kOrders");
    $("orderCount").textContent = state.orders.length;
    var pending = state.unacked.size;
    $("ackNote").textContent = pending ? "🔔 " + pending + " new order" + (pending > 1 ? "s" : "") + " to acknowledge" : "";
    if (!state.orders.length) {
      wrap.innerHTML = '<p class="korders__empty">Waiting for paid orders… verified payments appear here instantly and chime until acknowledged.</p>';
      return;
    }
    wrap.innerHTML = state.orders.map(orderEl).join("");
  }

  function addOrder(o) {
    if (!o || (o.status && o.status !== "paid")) return;
    if (state.orders.some(function (x) { return x.reference === o.reference; })) return;
    state.orders.unshift(o);
    state.orders = state.orders.slice(0, 100);
    state.unacked.add(o.reference);
    renderOrders();
    startChime(); // loop until ack
  }

  function acknowledge(ref) {
    state.unacked.delete(ref);
    var sel = '.korder[data-ref="' + (window.CSS && CSS.escape ? CSS.escape(ref) : ref) + '"]';
    var card = document.querySelector(sel);
    if (card) { card.classList.remove("korder--unacked"); card.classList.add("is-acked"); }
    if (!state.unacked.size) stopChime();
    renderOrders();
  }

  /* ---------- Live SSE ---------- */
  function setLive(mode, txt) {
    var el = $("kLive"); el.className = "kdash__live " + (mode || ""); el.textContent = "";
    var dot = document.createElement("span"); dot.className = "kdash__dot"; el.appendChild(dot);
    el.appendChild(document.createTextNode(" " + txt));
  }
  function connect() {
    if (state.evt) try { state.evt.close(); } catch (e) {}
    var url = "/api/kitchen/stream?token=" + encodeURIComponent(token);
    var evt = new EventSource(url);
    state.evt = evt;
    evt.onopen = function () { setLive("is-live", "Live — listening for orders"); };
    evt.onmessage = function (ev) {
      try { var o = JSON.parse(ev.data); if (o && o.reference) addOrder(o); } catch (e) {}
    };
    evt.onerror = function () {
      setLive("is-err", "Reconnecting… (or session expired)");
      // If token rejected the server closes the stream → force re-login.
      // We proactively verify with a fetch after a moment.
    };
    // Backstop: confirm token is still valid; on 401 drop to PIN gate.
    fetch("/api/kitchen/orders", { headers: { Authorization: "Bearer " + token } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { logout(); return; }
        return r.json();
      })
      .then(function (list) {
        if (Array.isArray(list)) { list.forEach(function (o) { addOrder(o); }); renderOrders(); }
      })
      .catch(function () {});
  }

  /* ---------- Status controls (closed / sold out) ---------- */
  async function postControl(body) {
    var res = await fetch("/api/kitchen/control", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body)
    });
    if (res.status === 401 || res.status === 403) { logout(); return null; }
    var data = await res.json().catch(function () { return {}; });
    if (data.kitchenStatus) state.status = data.kitchenStatus;
    syncControls();
    return data;
  }

  function syncControls() {
    var closed = !!state.status.manualClosed;
    $("closedToggle").checked = closed;
    $("closedLabel").textContent = closed ? "Force Closed" : "Open";
    renderStock();
  }

  function renderStock() {
    var q = ($("stockSearch").value || "").toLowerCase().trim();
    var oos = new Set(state.status.outOfStock || []);
    var list = $("stockList");
    var shown = menu().filter(function (m) { return !q || m.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 60);
    if (!shown.length) { list.innerHTML = '<div class="kstock__empty">No items match.</div>'; return; }
    list.innerHTML = shown.map(function (m) {
      var isOos = oos.has(m.id);
      return '<div class="kstock__item"><span>' + esc(m.name) + '</span>' +
        '<button type="button" class="' + (isOos ? "on" : "off") + '" data-stock="' + esc(m.id) + '" data-on="' + (isOos ? "0" : "1") + '">' +
        (isOos ? "Sold Out ✓" : "Mark Sold Out") + "</button></div>";
    }).join("");
  }

  /* ---------- Dashboard boot ---------- */
  function showDashboard() {
    $("pinGate").style.display = "none";
    $("dash").hidden = false; $("dash").classList.add("is-auth");
    // Load current overrides then connect live.
    fetch("/api/status").then(function (r) { return r.json(); }).then(function (s) {
      state.status = { manualClosed: !!s.manualClosed, outOfStock: s.outOfStock || [] };
      syncControls();
    }).catch(function () {});
    connect();
  }

  async function tryEnter() {
    var note = $("magicNote");
    // Arriving from an email link carries the fresh 24h token in the hash.
    consumeHashToken();
    if (!token) { $("pinGate").style.display = "grid"; return; }
    // Validate the stored/arrived token against the server.
    try {
      var r = await fetch("/api/kitchen/orders", { headers: { Authorization: "Bearer " + token } });
      if (r.status === 401 || r.status === 403) { logout(); return; }
      showDashboard();
    } catch (e) {
      // Offline / blip: still show the dashboard; SSE retries on its own.
      showDashboard();
    }
    // Surface an explicit message if verification denied.
    if (/auth=denied/.test(location.search) && note) { note.hidden = false; note.textContent = "That link was invalid or expired. Request a new one."; }
  }

  /* ---------- Events ---------- */
  function init() {
    $("magicForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = ($("magicEmail").value || "").trim().toLowerCase();
      var note = $("magicNote"), btn = $("magicSubmit");
      note.hidden = true;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        note.hidden = false; note.textContent = "Please enter a valid email address."; return;
      }
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        await requestMagicLink(email);
        note.hidden = false; note.classList.add("is-ok");
        note.textContent = "✓ If that's an authorized staff email, a sign-in link is on its way. Open it on this device to enter the kitchen.";
      } catch (err) {
        note.hidden = false; note.classList.remove("is-ok"); note.textContent = "Network error — try again.";
      } finally {
        btn.disabled = false; btn.textContent = "Email me a sign-in link";
      }
    });

    $("logoutBtn").addEventListener("click", logout);

    $("soundToggle").addEventListener("click", function () {
      state.soundOn = !state.soundOn;
      $("soundToggle").textContent = state.soundOn ? "🔔 Chime: On" : "🔕 Chime: Off";
      if (!state.soundOn) stopChime();
    });

    $("closedToggle").addEventListener("change", function () {
      postControl({ manualClosed: this.checked });
    });

    $("stockSearch").addEventListener("input", renderStock);
    $("stockList").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-stock]"); if (!btn) return;
      var id = btn.getAttribute("data-stock");
      var on = btn.getAttribute("data-on") === "1";
      // update locally optimistic
      var set = new Set(state.status.outOfStock || []);
      if (on) set.add(id); else set.delete(id);
      state.status.outOfStock = Array.from(set);
      postControl({ toggleItem: [id, on] });
    });

    $("kOrders").addEventListener("click", function (e) {
      var ack = e.target.closest("[data-ack]");
      if (ack) acknowledge(ack.getAttribute("data-ack"));
    });

    // Auto-enter if a valid token is stored.
    tryEnter();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
