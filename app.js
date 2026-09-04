/* =============================================================
   CYRIL'S FOODS — FRONTEND ENGINE (app.js)
   Sections:
     1. Config & state
     2. Operating-hours engine (9 AM – 7 PM WAT)
     3. Distance / maps engine (Google -> OSRM fallback)
     4. Menu render + filters + search
     5. Cart drawer + item customisation modal
     6. Checkout + Paystack (card & dynamic transfer)
     7. Admin live-order panel (SSE)
     8. Utilities (toast, loader, etc.)
   ============================================================= */
(function () {
  "use strict";

  var D = window.CYRIL;
  var BRAND = D.BRAND, CATS = D.CATEGORIES, MENU = D.MENU;
  var money = D.money;

  /* =========================================================
     1. CONFIG & RUNTIME STATE
     ========================================================= */
  var CONFIG = {
    // Server base (same origin by default; override per deploy).
    apiBase: window.location.origin.startsWith("http") ? window.location.origin : "",
    // Paystack public key (pk_...). Falls back to sandbox test key if unset.
    paystackKey: window.CYRIL_PAYSTACK_PK || "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    googleMapsKey: window.CYRIL_GOOGLE_MAPS_KEY || "",
    ratePerKm: BRAND.ratePerKm,
    originLat: BRAND.originLat,
    originLng: BRAND.originLng,
  };

  var state = {
    cart: [],                 // { lineId, item, qty, selections:[{group,label,price}], unitPrice, name }
    activeFilter: "ALL",
    search: "",
    open: true,
    distance: null,           // { km, minutes, address, lat, lng, fee }
    checkoutAddress: null,    // resolved place for checkout
    estimateAddress: null,
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /* =========================================================
     8. UTILITIES
     ========================================================= */
  function toast(msg, type) {
    var wrap = $("#toastWrap");
    var el = document.createElement("div");
    el.className = "toast" + (type ? " toast--" + type : "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.classList.add("is-leaving"); setTimeout(function () { el.remove(); }, 320); }, 3200);
  }

  function hideLoader() {
    var l = $("#loader");
    if (l) { l.classList.add("is-hidden"); setTimeout(function () { l.remove(); }, 600); }
  }

  /* =========================================================
     2. OPERATING-HOURS ENGINE
     =========================================================
     Window: 9:00–19:00 in Africa/Lagos (WAT, UTC+1, no DST).
     Accepts ?hours=closed|open for QA testing of each state.
     ========================================================= */
  function getNowInLagos() {
    var now = new Date();
    try {
      var parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit",
        hour12: false, weekday: "long",
      }).formatToParts(now);
      var out = {};
      parts.forEach(function (p) { out[p.type] = p.value; });
      return { hour: parseInt(out.hour, 10), minute: parseInt(out.minute, 10), weekday: out.weekday, date: now };
    } catch (e) {
      // Fallback: fixed UTC+1 offset.
      var h = (now.getUTCHours() + 1) % 24;
      return { hour: h, minute: now.getUTCMinutes(), weekday: "Today", date: now };
    }
  }

  function isOpenNow() {
    var q = new URLSearchParams(location.search).get("hours");
    if (q === "closed") return false;
    if (q === "open") return true;
    var t = getNowInLagos();
    var mins = t.hour * 60 + t.minute;
    return mins >= BRAND.openHour * 60 && mins < BRAND.closeHour * 60;
  }

  function applyHours() {
    state.open = isOpenNow();
    var bar = $("#statusBar"), txt = $("#statusText"), hrs = $("#statusHours");
    hrs.textContent = "· Open daily " + (BRAND.openHour) + ":00 AM – " + (BRAND.closeHour - 12) + ":00 PM WAT";

    if (state.open) {
      bar.classList.remove("statusbar--closed");
      bar.classList.add("statusbar--open");
      txt.textContent = "Yes, we're open! Fresh food cooking now 🍳";
    } else {
      bar.classList.remove("statusbar--open");
      bar.classList.add("statusbar--closed");
      txt.textContent = "Yes, we are closed! But we'd be back by opening time (9:00 AM).";
      // Disable all add-to-cart triggers.
      $$(".dish__add, #checkoutBtn, #addCartBtn").forEach(function (b) { b.disabled = true; });
    }
    // Re-render menu cards so they show Out of Stock when closed.
    renderMenu();
  }

  /* =========================================================
     3. DISTANCE / MAPS ENGINE
     Prevents hardcoded fraud: fee derives from a real route.
     Providers: Google Places+Distance Matrix (if key) -> OSRM/Photon.
     ========================================================= */
  var geo = {
    googleLoading: null,
    ensureGoogle: function () {
      if (window.google && window.google.maps && window.google.maps.places) return Promise.resolve();
      if (!CONFIG.googleMapsKey) return Promise.reject(new Error("no-google-key"));
      if (this.googleLoading) return this.googleLoading;
      var cbName = "__gmapCb" + Date.now();
      this.googleLoading = new Promise(function (resolve, reject) {
        window[cbName] = function () { resolve(); };
        var s = document.createElement("script");
        s.src = "https://maps.googleapis.com/maps/api/js?key=" + CONFIG.googleMapsKey +
               "&libraries=places&callback=" + cbName;
        s.onerror = function () { reject(new Error("google-load-failed")); };
        document.head.appendChild(s);
      });
      return this.googleLoading;
    },

    // Free-text suggestions: Google Places autocomplete, else Photon (OSM).
    suggest: function (query) {
      var q = query.trim();
      if (q.length < 3) return Promise.resolve([]);
      return this.ensureGoogle()
        .then(function () { return []; }) // handled by Google widget externally; here use photon fallback
        .catch(function () {
          // Photon geocoding (OpenStreetMap-based), biased to Nigeria.
          var url = "https://photon.komoot.io/api/?limit=6&lang=en&q=" +
                    encodeURIComponent(q + ", Lagos, Nigeria");
          return fetch(url).then(function (r) { return r.json(); }).then(function (data) {
            return (data.features || []).map(function (f) {
              var p = f.properties, c = f.geometry.coordinates; // [lng,lat]
              var parts = [p.housenumber, p.street, p.district || p.suburb, p.city || p.county, "Nigeria"]
                .filter(Boolean);
              var label = parts.filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ");
              return { label: label || (p.name || q), lat: c[1], lng: c[0], secondary: (p.name || "") };
            }).filter(function (x) { return x.label; });
          }).catch(function () { return []; });
        });
    },

    // Attach a Google Places Autocomplete widget to an input (when key present).
    attachGoogleAutocomplete: function (inputEl, onPlace) {
      var self = this;
      this.ensureGoogle().then(function () {
        var ac = new google.maps.places.Autocomplete(inputEl, {
          componentRestrictions: { country: "ng" },
          fields: ["formatted_address", "geometry", "name"],
        });
        ac.addListener("place_changed", function () {
          var place = ac.getPlace();
          if (place && place.geometry && place.geometry.location) {
            var loc = place.geometry.location;
            onPlace({
              label: place.formatted_address || inputEl.value,
              lat: loc.lat(), lng: loc.lng(),
              secondary: place.name || "",
              source: "google",
            });
          }
        });
      }).catch(function () { /* use Photon fallback UI */ });
    },

    // Driving distance: Google Distance Matrix -> OSRM driving route.
    routeDistance: function (lat, lng) {
      var self = this;
      return this.ensureGoogle().then(function () {
        return new Promise(function (resolve, reject) {
          var svc = new google.maps.DistanceMatrixService();
          svc.getDistanceMatrix({
            origins: [new google.maps.LatLng(CONFIG.originLat, CONFIG.originLng)],
            destinations: [new google.maps.LatLng(lat, lng)],
            travelMode: google.maps.TravelMode.DRIVING,
          }, function (resp, status) {
            if (status === "OK" && resp.rows[0] && resp.rows[0].elements[0] &&
                resp.rows[0].elements[0].status === "OK") {
              var e = resp.rows[0].elements[0];
              resolve({ km: e.distance.value / 1000, minutes: Math.round(e.duration.value / 60), source: "google" });
            } else reject(new Error("matrix-failed"));
          });
        });
      }).catch(function () {
        // OSRM public demo server, driving profile.
        var url = "https://router.project-osrm.org/route/v1/driving/" +
          CONFIG.originLng + "," + CONFIG.originLat + ";" + lng + "," + lat +
          "?overview=false";
        return fetch(url).then(function (r) { return r.json(); }).then(function (data) {
          if (data.code === "Ok" && data.routes && data.routes[0]) {
            return { km: data.routes[0].distance / 1000, minutes: Math.round(data.routes[0].duration / 60), source: "osrm" };
          }
          // Last-resort: haversine straight-line × 1.4 road factor (flagged as estimate).
          var straight = self.haversine(CONFIG.originLat, CONFIG.originLng, lat, lng);
          return { km: straight * 1.4, minutes: Math.round(straight * 1.4 / 25 * 60), source: "estimate" };
        });
      });
    },

    haversine: function (la1, lo1, la2, lo2) {
      var R = 6371, rad = Math.PI / 180;
      var dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
      var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
              Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },
  };

  function computeFee(km) { return Math.round(km * CONFIG.ratePerKm); }

  /* Resolve a chosen place -> route distance -> fee, then update a target UI. */
  function resolveRoute(place, target) {
    target = target || "checkout";
    var note = target === "checkout" ? null : $("#calcNote");
    if (note) { note.textContent = "Calculating driving route…"; }
    return geo.routeDistance(place.lat, place.lng).then(function (r) {
      var fee = computeFee(r.km);
      var result = { km: r.km, minutes: r.minutes, fee: fee, address: place.label,
                     lat: place.lat, lng: place.lng, source: r.source };
      if (target === "checkout") {
        state.checkoutAddress = result;
        updateCheckoutTotals();
      } else {
        state.estimateAddress = result;
        $("#calcDistance").textContent = r.km.toFixed(1) + " km" + (r.minutes ? " · ~" + r.minutes + " min" : "");
        $("#calcFee").textContent = money(fee);
        if (note) note.textContent = "Exact fee " + money(fee) +
          (r.source === "estimate" ? " (straight-line estimate)" : " based on live driving distance.") +
          " Added automatically at checkout.";
      }
      return result;
    }).catch(function (e) {
      if (note) note.textContent = "Could not calculate route. Please pick a clearer address.";
      toast("Distance calculation failed — check your address.", "error");
      return null;
    });
  }

  /* Autocomplete controller: wires an input + suggestion list,
     using Google Places when available, else Photon + custom list. */
  function initAutocomplete(inputEl, listEl, onSelect) {
    var googleMode = !!CONFIG.googleMapsKey;
    var activeIdx = -1, items = [];

    geo.attachGoogleAutocomplete(inputEl, function (place) {
      listEl.classList.remove("is-open");
      onSelect(place);
    });

    var debounceTimer;
    inputEl.addEventListener("input", function () {
      if (googleMode) return; // Google renders its own dropdown
      clearTimeout(debounceTimer);
      var v = inputEl.value;
      debounceTimer = setTimeout(function () {
        geo.suggest(v).then(function (results) {
          items = results;
          activeIdx = -1;
          if (!results.length) { listEl.classList.remove("is-open"); return; }
          listEl.innerHTML = results.map(function (r, i) {
            return '<li role="option" data-i="' + i + '">' + esc(r.label) +
                   (r.secondary ? '<span class="autocomplete__secondary">' + esc(r.secondary) + "</span>" : "") + "</li>";
          }).join("");
          listEl.classList.add("is-open");
        });
      }, 250);
    });

    listEl.addEventListener("click", function (e) {
      var li = e.target.closest("li");
      if (!li) return;
      var idx = parseInt(li.getAttribute("data-i"), 10);
      var place = items[idx];
      if (place) {
        inputEl.value = place.label;
        listEl.classList.remove("is-open");
        onSelect(place);
      }
    });

    inputEl.addEventListener("keydown", function (e) {
      if (googleMode || !items.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx += (e.key === "ArrowDown" ? 1 : -1);
        activeIdx = Math.max(0, Math.min(items.length - 1, activeIdx));
        $$("li", listEl).forEach(function (li, i) { li.classList.toggle("is-active", i === activeIdx); });
      } else if (e.key === "Enter" && activeIdx >= 0) {
        e.preventDefault();
        var p = items[activeIdx];
        inputEl.value = p.label; listEl.classList.remove("is-open"); onSelect(p);
      } else if (e.key === "Escape") {
        listEl.classList.remove("is-open");
      }
    });

    document.addEventListener("click", function (e) {
      if (!listEl.contains(e.target) && e.target !== inputEl) listEl.classList.remove("is-open");
    });
  }

  /* =========================================================
     4. MENU RENDER
     ========================================================= */
  function renderCategories() {
    $("#catRail").innerHTML = CATS.map(function (c) {
      return '<button class="cat-card" data-cat="' + c.id + '" aria-label="Browse ' + esc(c.label) + '">' +
        '<img src="' + c.img + '" alt="' + esc(c.label) + '" loading="lazy" />' +
        '<span class="cat-card__label"><span class="cat-card__emoji">' + c.emoji + "</span>" +
        '<span class="cat-card__name">' + esc(c.label) + "</span></span></button>";
    }).join("");
  }

  function renderFilters() {
    var counts = { ALL: MENU.length };
    CATS.forEach(function (c) {
      counts[c.id] = MENU.filter(function (m) { return m.category === c.id; }).length;
    });
    var chips = ['<button class="chip is-active" data-cat="ALL">All<span class="chip__count">' + counts.ALL + "</span></button>"]
      .concat(CATS.map(function (c) {
        return '<button class="chip" data-cat="' + c.id + '">' + c.emoji + " " + esc(c.label) +
               '<span class="chip__count">' + counts[c.id] + "</span></button>";
      }));
    $("#filterChips").innerHTML = chips.join("");
  }

  function filteredMenu() {
    var list = MENU;
    if (state.activeFilter !== "ALL") list = list.filter(function (m) { return m.category === state.activeFilter; });
    if (state.search) {
      var q = state.search.toLowerCase();
      list = list.filter(function (m) { return m.name.toLowerCase().indexOf(q) > -1; });
    }
    return list;
  }

  function renderMenu() {
    var grid = $("#menuGrid");
    var list = filteredMenu();
    $("#menuEmpty").hidden = list.length > 0;

    grid.innerHTML = list.map(function (m) {
      var closed = !state.open;
      var hasMods = m.modifiers && m.modifiers.length;
      return '<article class="dish' + (closed ? " dish--oos" : "") + '" data-id="' + m.id + '">' +
        '<div class="dish__img">' +
          '<img src="' + m.image + '" alt="' + esc(m.name) + '" loading="lazy" />' +
          (m.popular ? '<span class="dish__tag' + (m.id.indexOf("combo") === 0 ? " dish__tag--combo" : "") + '">⭐ Popular</span>' : "") +
          (closed ? '<span class="dish__oos">Out of Stock</span>'
                  : '<button class="dish__add" data-id="' + m.id + '" aria-label="Add ' + esc(m.name) + '">+</button>') +
        "</div>" +
        '<div class="dish__body">' +
          '<span class="dish__cat">' + (catLabel(m.category)) + "</span>" +
          '<h3 class="dish__name">' + esc(m.name) + "</h3>" +
          '<p class="dish__desc">' + esc(m.desc || "") + "</p>" +
          '<div class="dish__foot">' +
            '<span class="dish__price">' + money(m.price) + "</span>" +
            (hasMods ? '<button class="dish__custom" data-id="' + m.id + '">Customise &rarr;</button>' : "") +
          "</div>" +
        "</div>" +
      "</article>";
    }).join("");

    // Card click -> customise / quick add
    $$(".dish", grid).forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (e.target.closest(".dish__add") || e.target.closest(".dish__custom")) return;
        var id = card.getAttribute("data-id");
        openItem(id);
      });
    });
    $$(".dish__add", grid).forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var item = findItem(btn.getAttribute("data-id"));
        if (item && item.modifiers && item.modifiers.length) openItem(item.id);
        else quickAdd(item);
      });
    });
    $$(".dish__custom", grid).forEach(function (btn) {
      btn.addEventListener("click", function (e) { e.stopPropagation(); openItem(btn.getAttribute("data-id")); });
    });
  }

  function catLabel(id) { var c = CATS.find(function (x) { return x.id === id; }); return c ? c.label : id; }
  function findItem(id) { return MENU.find(function (m) { return m.id === id; }); }

  /* =========================================================
     5. CART + ITEM CUSTOMISATION
     ========================================================= */
  var modalItem = null, modalQty = 1, modalSelections = [];

  function openItem(id) {
    if (!state.open) { toast("We're closed right now — orders reopen at 9:00 AM. 🌙", "info"); return; }
    var item = findItem(id);
    if (!item) return;
    modalItem = item; modalQty = 1; modalSelections = [];

    $("#imImg").src = item.image;
    $("#imImg").alt = item.name;
    $("#imCat").textContent = catLabel(item.category);
    $("#itemModalTitle").textContent = item.name;
    $("#imDesc").textContent = item.desc || "";
    $("#qtyValue").textContent = "1";

    // Build modifier groups
    $("#imModifiers").innerHTML = (item.modifiers || []).map(function (g, gi) {
      var type = g.allowMultiple ? "checkbox" : "radio";
      var opts = g.options.map(function (o, oi) {
        return '<div class="mod-opt" data-gi="' + gi + '" data-oi="' + oi + '">' +
          '<input type="' + type + '" name="mod-' + gi + '" id="mod-' + gi + "-" + oi + '" data-gi="' + gi + '" data-oi="' + oi + '"' +
            (g.required && oi === 0 ? " checked" : "") + " />" +
          '<label for="mod-' + gi + "-" + oi + '"><span>' + esc(o.label) + "</span>" +
            '<span class="mod-opt__price">' + (o.price > 0 ? "+" + money(o.price) : "Included") + "</span></label>" +
        "</div>";
      }).join("");
      return '<div class="mod-group"><div class="mod-group__title">' + esc(g.name) +
        (g.required ? ' <small>(required)</small>' : "") + "</div>" + opts + "</div>";
    }).join("");

    // Pre-select required defaults
    (item.modifiers || []).forEach(function (g, gi) {
      if (g.required) selectOption(gi, 0, !g.allowMultiple);
    });

    $$(".mod-opt", $("#imModifiers")).forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target.tagName !== "INPUT") {
          var inp = el.querySelector("input");
          if (inp.type === "radio") inp.checked = true;
          else inp.checked = !inp.checked;
        }
        syncSelections();
      });
    });

    updateModalTotal();
    openModal("#itemModal");
  }

  function selectOption(gi, oi, isRadio) {
    var g = modalItem.modifiers[gi], o = g.options[oi];
    if (isRadio) {
      modalSelections = modalSelections.filter(function (s) { return s.gi !== gi; });
      modalSelections.push({ gi: gi, group: g.name, label: o.label, price: o.price });
      $$('.mod-opt[data-gi="' + gi + '"]').forEach(function (el) {
        el.classList.toggle("is-sel", parseInt(el.getAttribute("data-oi"), 10) === oi);
      });
    } else {
      var exists = modalSelections.some(function (s) { return s.gi === gi && s.label === o.label; });
      if (exists) {
        modalSelections = modalSelections.filter(function (s) { return !(s.gi === gi && s.label === o.label); });
      } else {
        modalSelections.push({ gi: gi, group: g.name, label: o.label, price: o.price });
      }
      var el = $$('.mod-opt[data-gi="' + gi + '"]')[oi];
      if (el) el.classList.toggle("is-sel", !exists);
    }
  }

  function syncSelections() {
    modalSelections = [];
    $$("#imModifiers input").forEach(function (inp) {
      if (inp.checked) {
        var gi = parseInt(inp.getAttribute("data-gi"), 10);
        var oi = parseInt(inp.getAttribute("data-oi"), 10);
        var g = modalItem.modifiers[gi], o = g.options[oi];
        modalSelections.push({ gi: gi, group: g.name, label: o.label, price: o.price });
      }
    });
    updateModalTotal();
  }

  function modalUnitPrice() {
    var base = modalItem.price;
    modalSelections.forEach(function (s) { base += s.price; });
    return base;
  }
  function updateModalTotal() { $("#imTotal").textContent = money(modalUnitPrice() * modalQty); }

  $("#qtyMinus").addEventListener("click", function () { modalQty = Math.max(1, modalQty - 1); $("#qtyValue").textContent = modalQty; updateModalTotal(); });
  $("#qtyPlus").addEventListener("click", function () { modalQty++; $("#qtyValue").textContent = modalQty; updateModalTotal(); });

  $("#addCartBtn").addEventListener("click", function () {
    if (!modalItem) return;
    // Validate required groups
    var missing = (modalItem.modifiers || []).filter(function (g) {
      return g.required && !modalSelections.some(function (s) { return s.gi === modalItem.modifiers.indexOf(g); });
    });
    if (missing.length) { toast("Please choose: " + missing.map(function (g) { return g.name; }).join(", "), "error"); return; }

    var lineId = modalItem.id + "|" + modalSelections.map(function (s) { return s.label; }).join("+");
    var existing = state.cart.find(function (l) { return l.lineId === lineId; });
    if (existing) { existing.qty += modalQty; }
    else {
      state.cart.push({
        lineId: lineId, item: modalItem, qty: modalQty,
        selections: modalSelections.slice(),
        unitPrice: modalUnitPrice(),
        name: modalItem.name,
      });
    }
    closeModal("#itemModal");
    saveCart();
    renderCart();
    bumpCartCount();
    toast(modalQty + " × " + modalItem.name + " added to cart 🛒", "success");
  });

  function quickAdd(item) {
    if (!item) return;
    var lineId = item.id + "|";
    var existing = state.cart.find(function (l) { return l.lineId === lineId; });
    if (existing) existing.qty++;
    else state.cart.push({ lineId: lineId, item: item, qty: 1, selections: [], unitPrice: item.price, name: item.name });
    saveCart(); renderCart(); bumpCartCount();
    toast(item.name + " added 🛒", "success");
  }

  function cartSubtotal() {
    return state.cart.reduce(function (sum, l) { return sum + l.unitPrice * l.qty; }, 0);
  }
  function cartCount() { return state.cart.reduce(function (n, l) { return n + l.qty; }, 0); }

  function bumpCartCount() {
    var n = cartCount();
    var badge = $("#cartCount");
    badge.textContent = n;
    if (badge.animate) {
      badge.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.4)" }, { transform: "scale(1)" }],
        { duration: 300, easing: "ease-out" });
    }
  }

  function renderCart() {
    var body = $("#cartItems"), foot = $("#cartFoot");
    $("#drawerCount").textContent = cartCount();
    if (!state.cart.length) {
      foot.hidden = true;
      body.innerHTML =
        '<div class="cart-empty" style="display:flex;flex-direction:column;align-items:center;gap:.8rem">' +
          "<span>🍽️</span><p>Your plate is empty.</p>" +
          '<a href="#menu" class="btn btn--primary btn--sm cart-empty__cta">Browse the menu</a>' +
        "</div>";
      var cta = body.querySelector(".cart-empty__cta");
      if (cta) cta.addEventListener("click", closeDrawer);
      return;
    }
    foot.hidden = false;
    body.innerHTML = state.cart.map(function (l) {
      var mods = l.selections.length
        ? '<div class="cart-line__mods">' + l.selections.map(function (s) {
            return "<em>" + esc(s.label) + (s.price ? " (+" + money(s.price) + ")" : "") + "</em>";
          }).join(" · ") + "</div>" : "";
      return '<div class="cart-line">' +
        '<img class="cart-line__img" src="' + l.item.image + '" alt="" />' +
        '<div class="cart-line__info">' +
          '<div class="cart-line__name">' + esc(l.name) + "</div>" + mods +
          '<div class="cart-line__ctrl">' +
            '<div class="qty-mini">' +
              '<button data-act="dec" data-id="' + l.lineId + '" aria-label="Decrease">−</button>' +
              "<span>" + l.qty + "</span>" +
              '<button data-act="inc" data-id="' + l.lineId + '" aria-label="Increase">+</button>' +
            "</div>" +
            '<span class="cart-line__price">' + money(l.unitPrice * l.qty) + "</span>" +
          "</div>" +
          '<button class="cart-line__remove" data-act="rm" data-id="' + l.lineId + '">Remove</button>' +
        "</div>" +
      "</div>";
    }).join("");

    $$("[data-act]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id"), act = btn.getAttribute("data-act");
        var line = state.cart.find(function (x) { return x.lineId === id; });
        if (!line) return;
        if (act === "inc") line.qty++;
        else if (act === "dec") { line.qty--; if (line.qty <= 0) state.cart = state.cart.filter(function (x) { return x.lineId !== id; }); }
        else if (act === "rm") state.cart = state.cart.filter(function (x) { return x.lineId !== id; });
        saveCart(); renderCart(); bumpCartCount();
      });
    });
    $("#cartSubtotal").textContent = money(cartSubtotal());
  }

  function saveCart() { try { localStorage.setItem("cyrils_cart", JSON.stringify(state.cart)); } catch (e) {} }
  function loadCart() {
    try {
      var raw = localStorage.getItem("cyrils_cart");
      if (!raw) return;
      var saved = JSON.parse(raw);
      // Rehydrate against current menu (drop stale lines).
      state.cart = saved.map(function (l) {
        var item = findItem(l.item && l.item.id);
        return item ? Object.assign({}, l, { item: item }) : null;
      }).filter(Boolean);
    } catch (e) {}
  }

  /* Drawer open/close */
  function openDrawer() { $("#cartDrawer").classList.add("is-open"); $("#drawerBackdrop").classList.add("is-open"); $("#cartDrawer").setAttribute("aria-hidden", "false"); document.body.classList.add("no-scroll"); renderCart(); }
  function closeDrawer() { $("#cartDrawer").classList.remove("is-open"); $("#drawerBackdrop").classList.remove("is-open"); $("#cartDrawer").setAttribute("aria-hidden", "true"); document.body.classList.remove("no-scroll"); }

  /* =========================================================
     6. CHECKOUT + PAYSTACK
     ========================================================= */
  function openModal(sel) { $(sel).classList.add("is-open"); $(sel).setAttribute("aria-hidden", "false"); document.body.classList.add("no-scroll"); }
  function closeModal(sel) { $(sel).classList.remove("is-open"); $(sel).setAttribute("aria-hidden", "true"); if (!$$(".modal.is-open").length) document.body.classList.remove("no-scroll"); }

  function updateCheckoutTotals() {
    var sub = cartSubtotal();
    var fee = state.checkoutAddress ? state.checkoutAddress.fee : 0;
    $("#coSubtotal").textContent = money(sub);
    $("#coFee").textContent = money(fee);
    if (state.checkoutAddress) {
      $("#coDistance").textContent = state.checkoutAddress.km.toFixed(1) + " km · ~" + state.checkoutAddress.minutes + " min";
    } else {
      $("#coDistance").textContent = "— set address —";
    }
    $("#coTotal").textContent = money(sub + fee);
    $("#payAmount").textContent = money(sub + fee);
    // toggle pay button
    $("#payBtn").disabled = !state.open;
  }

  function openCheckout() {
    if (!state.cart.length) { toast("Your cart is empty 🍽️", "info"); return; }
    if (!state.open) { toast("We're closed — orders reopen at 9:00 AM. 🌙", "info"); return; }
    updateCheckoutTotals();
    openModal("#checkoutModal");
  }

  function loadPaystack() {
    if (window.PaystackPop) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://js.paystack.co/v1/inline.js";
      s.onload = resolve; s.onerror = function () { reject(new Error("paystack-load-failed")); };
      document.head.appendChild(s);
    });
  }

  function buildOrderPayload(reference) {
    var method = ($$('input[name="payMethod"]').find(function (r) { return r.checked; }) || {}).value || "card";
    return {
      reference: reference,
      customer: {
        name: $("#coName").value.trim(),
        phone: $("#coPhone").value.trim(),
        email: ($("#coName").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".") || "guest") + "@order.cyrilsfood.com.ng",
      },
      address: state.checkoutAddress ? {
        description: state.checkoutAddress.address,
        lat: state.checkoutAddress.lat, lng: state.checkoutAddress.lng,
        distanceKm: Number(state.checkoutAddress.km.toFixed(2)),
        minutes: state.checkoutAddress.minutes,
        fee: state.checkoutAddress.fee,
      } : null,
      note: $("#coNote").value.trim(),
      method: method,
      items: state.cart.map(function (l) {
        return {
          name: l.name,
          qty: l.qty,
          unitPrice: l.unitPrice,
          options: l.selections.map(function (s) { return s.label + (s.price ? " (+" + s.price + ")" : ""); }),
          lineTotal: l.unitPrice * l.qty,
        };
      }),
      subtotal: cartSubtotal(),
      deliveryFee: state.checkoutAddress ? state.checkoutAddress.fee : 0,
      total: cartSubtotal() + (state.checkoutAddress ? state.checkoutAddress.fee : 0),
    };
  }

  function payWithPaystack(order) {
    return loadPaystack().then(function () {
      return new Promise(function (resolve, reject) {
        var fields = order.items.map(function (i) { return i.qty + "x " + i.name; }).join(", ");
        var handler = PaystackPop.setup({
          key: CONFIG.paystackKey,
          email: order.customer.email,
          amount: Math.round(order.total * 100), // kobo
          currency: "NGN",
          ref: order.reference,
          metadata: {
            custom_fields: [
              { display_name: "Customer Name", variable_name: "customer_name", value: order.customer.name },
              { display_name: "Phone", variable_name: "phone", value: order.customer.phone },
              { display_name: "Delivery Address", variable_name: "address", value: order.address ? order.address.description : "N/A" },
              { display_name: "Distance", variable_name: "distance_km", value: order.address ? order.address.distanceKm : 0 },
              { display_name: "Order", variable_name: "items", value: fields },
              { display_name: "Note", variable_name: "note", value: order.note || "" },
            ],
          },
          channels: ["card", "bank_transfer"], // card + dynamic virtual account transfer
          onClose: function () { reject(new Error("cancelled")); },
          callback: function (resp) {
            // resp.reference -> verify server-side (webhook + verify endpoint).
            verifyPayment(resp.reference).then(function (ok) { ok ? resolve(resp) : reject(new Error("verify-failed")); })
              .catch(function () { resolve(resp); }); // webhook still verifies authoritatively
          },
        });
        handler.openIframe();
      });
    });
  }

  // Tell server to initialize + we also POST the order for records.
  function initializeOrder(order) {
    return fetch(CONFIG.apiBase + "/api/order/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(order),
    }).then(function (r) {
      if (!r.ok) throw new Error("init-failed");
      return r.json();
    }).catch(function () {
      // Server unreachable (static preview) — generate a client-side reference.
      order.reference = order.reference || ("CFD" + Date.now() + Math.floor(Math.random() * 1000));
      return { reference: order.reference, offline: true };
    });
  }

  function verifyPayment(reference) {
    return fetch(CONFIG.apiBase + "/api/order/verify?reference=" + encodeURIComponent(reference))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.data && d.data.status === "success"; })
      .catch(function () { return false; });
  }

  $("#checkoutForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!state.open) { toast("We're closed right now. 🌙", "error"); return; }
    if (!state.checkoutAddress) { toast("Please select a delivery address from the list.", "error"); return; }

    var reference = "CFD" + Date.now() + Math.floor(Math.random() * 1000);
    var order = buildOrderPayload(reference);
    var payBtn = $("#payBtn");
    payBtn.disabled = true;
    payBtn.textContent = "Initialising secure payment…";

    initializeOrder(order).then(function (init) {
      order.reference = init.reference || reference;
      return payWithPaystack(order).then(function (resp) {
        // Success path.
        closeModal("#checkoutModal");
        $("#successRef").textContent = order.reference;
        $("#successText").textContent =
          "Payment of " + money(order.total) + " received. Our kitchen is on it — we'll WhatsApp " +
          order.customer.phone + " with updates shortly.";
        openModal("#successModal");
        // Clear cart.
        state.cart = []; state.checkoutAddress = null; saveCart(); renderCart(); bumpCartCount();
        $("#checkoutForm").reset();
        payBtn.disabled = false; payBtn.innerHTML = 'Pay <span id="payAmount">' + money(0) + "</span>";
      });
    }).catch(function (err) {
      payBtn.disabled = false;
      updateCheckoutTotals();
      if (err.message === "cancelled") toast("Payment cancelled.", "info");
      else if (err.message && err.message.indexOf("paystack") > -1)
        toast("Payment service unavailable. Please try again or WhatsApp us.", "error");
      else toast("Payment could not be completed. You can also order on WhatsApp.", "error");
    });
  });

  $("#successClose").addEventListener("click", function () { closeModal("#successModal"); });

  /* =========================================================
     7. ADMIN LIVE-ORDER PANEL (SSE + chime)
     ========================================================= */
  var adminSound = true;
  var audioCtx = null;
  function playChime() {
    if (!adminSound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var notes = [880, 1108, 1318];
      notes.forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = f;
        o.connect(g); g.connect(audioCtx.destination);
        var t = audioCtx.currentTime + i * 0.16;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.start(t); o.stop(t + 0.4);
      });
    } catch (e) {}
  }

  function addAdminOrder(order) {
    var panel = $("#adminOrders");
    var empty = panel.querySelector(".admin__empty");
    if (empty) empty.remove();
    var el = document.createElement("div");
    el.className = "admin-order";
    var items = order.items.map(function (i) {
      return i.qty + "× " + i.name + (i.options && i.options.length ? " (" + i.options.join(", ") + ")" : "");
    }).join("<br>");
    var wa = "https://wa.me/" + BRAND.whatsapp + "?text=" + encodeURIComponent(
      "New paid order " + order.reference + " from " + order.customer.name +
      ". Total " + money(order.total) + ". Address: " + (order.address ? order.address.description : "n/a"));
    el.innerHTML =
      '<div class="admin-order__head"><span class="admin-order__id">#' + esc(order.reference) + '</span>' +
      '<span class="admin-order__amt">' + money(order.total) + '</span></div>' +
      '<div class="admin-order__meta">' +
        "<strong>" + esc(order.customer.name) + "</strong> · " + esc(order.customer.phone || "") + "<br>" +
        "📍 " + esc(order.address ? order.address.description : "—") +
        (order.address ? " <em>(" + order.address.distanceKm + " km, fee " + money(order.address.fee) + ")</em>" : "") +
        (order.note ? "<br>📝 " + esc(order.note) : "") +
      "</div>" +
      '<div class="admin-order__items">' + items + "</div>" +
      '<div class="admin-order__actions">' +
        '<a class="admin-order__wa" href="' + wa + '" target="_blank" rel="noopener">WhatsApp customer</a>' +
        '<a class="admin-order__call" href="tel:' + esc((order.customer.phone || "").replace(/\s/g, "")) + '">Call</a>' +
      "</div>";
    panel.prepend(el);
    playChime();
    $("#adminFab").classList.add("has-new");
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  function connectAdmin() {
    var status = $("#adminStatus");
    try {
      var es = new EventSource(CONFIG.apiBase + "/api/orders/stream");
      es.onopen = function () { status.textContent = "live"; status.classList.add("is-live"); };
      es.onmessage = function (ev) {
        try { addAdminOrder(JSON.parse(ev.data)); } catch (e) {}
      };
      es.onerror = function () { status.textContent = "offline (static preview)"; status.classList.remove("is-live"); };
    } catch (e) { status.textContent = "offline"; }
  }

  $("#adminFab").addEventListener("click", function () {
    $("#adminPanel").classList.add("is-open");
    $("#adminPanel").setAttribute("aria-hidden", "false");
    $("#adminFab").classList.remove("has-new");
    document.body.classList.add("no-scroll");
  });
  $("#adminClose").addEventListener("click", function () {
    $("#adminPanel").classList.remove("is-open");
    $("#adminPanel").setAttribute("aria-hidden", "true");
    document.body.classList.remove("no-scroll");
  });
  $("#adminSound").addEventListener("click", function () {
    adminSound = !adminSound;
    $("#adminSound").textContent = adminSound ? "🔊" : "🔇";
  });

  /* =========================================================
     WIRE-UP & INIT
     ========================================================= */
  function initNav() {
    var nav = $(".nav");
    window.addEventListener("scroll", function () { nav.classList.toggle("is-scrolled", window.scrollY > 10); });
    var burger = $("#navBurger"), links = $("#navLinks");
    burger.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $$("a", links).forEach(function (a) { a.addEventListener("click", function () { links.classList.remove("is-open"); burger.setAttribute("aria-expanded", "false"); }); });
  }

  function initMenuControls() {
    $("#filterChips").addEventListener("click", function (e) {
      var chip = e.target.closest(".chip");
      if (!chip) return;
      state.activeFilter = chip.getAttribute("data-cat");
      $$(".chip", this).forEach(function (c) { c.classList.toggle("is-active", c === chip); });
      renderMenu();
    });
    $("#catRail").addEventListener("click", function (e) {
      var card = e.target.closest(".cat-card");
      if (!card) return;
      state.activeFilter = card.getAttribute("data-cat");
      $$(".chip", $("#filterChips")).forEach(function (c) {
        c.classList.toggle("is-active", c.getAttribute("data-cat") === state.activeFilter);
      });
      renderMenu();
      document.getElementById("menu").scrollIntoView({ behavior: "smooth" });
    });
    $("#menuSearch").addEventListener("input", function (e) {
      state.search = e.target.value;
      renderMenu();
    });
  }

  function initCartControls() {
    $("#cartBtn").addEventListener("click", openDrawer);
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerBackdrop").addEventListener("click", closeDrawer);
    var emptyCta = $("#cartEmptyCta");
    if (emptyCta) emptyCta.addEventListener("click", closeDrawer);
    $("#checkoutBtn").addEventListener("click", function () { closeDrawer(); openCheckout(); });
    $("#bulkWaBtn").addEventListener("click", function () {
      window.open("https://wa.me/2348081988184?text=" + encodeURIComponent(
        "Hello Cyril's Foods! I'd like to arrange a bulk order."), "_blank");
    });
    $$("[data-close-modal]").forEach(function (el) {
      el.addEventListener("click", function () {
        var modal = el.closest(".modal");
        if (modal) closeModal("#" + modal.id);
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeDrawer();
        $$(".modal.is-open").forEach(function (m) { closeModal("#" + m.id); });
      }
    });
  }

  function initAutocompletes() {
    initAutocomplete($("#calcAddress"), $("#calcSuggestions"), function (place) {
      resolveRoute(place, "estimate");
    });
    initAutocomplete($("#coAddress"), $("#coSuggestions"), function (place) {
      resolveRoute(place, "checkout");
    });
  }

  function animateStats() {
    var el = $('[data-stat]');
    if (!el) return;
    var target = parseInt(el.getAttribute("data-stat"), 10), cur = 0;
    var step = Math.ceil(target / 40);
    var t = setInterval(function () {
      cur += step;
      if (cur >= target) { cur = target; clearInterval(t); }
      el.textContent = cur + "+";
    }, 25);
  }

  function init() {
    $("#year").textContent = new Date().getFullYear();
    renderCategories();
    renderFilters();
    loadCart();
    renderCart();
    bumpCartCount();
    applyHours();
    initNav();
    initMenuControls();
    initCartControls();
    initAutocompletes();
    connectAdmin();
    animateStats();
    // Re-evaluate hours every minute (flips open/closed on the boundary).
    setInterval(applyHours, 60 * 1000);
    // Reveal loader.
    window.addEventListener("load", function () { setTimeout(hideLoader, 700); });
    setTimeout(hideLoader, 2500); // safety
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
