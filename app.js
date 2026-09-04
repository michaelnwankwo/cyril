/* =============================================================
   CYRIL'S FOODS — SHARED CORE ENGINE (app.js)
   Powers both index.html (home) and menu.html (full menu).
   Responsibilities:
     • Operating-hours engine (9 AM – 7 PM WAT)
     • Distance / maps engine (Google -> OSRM/OpenStreetMap fallback)
     • Cart drawer + item customisation (persisted across pages)
     • Checkout + Paystack (card & dynamic transfer)
     • Admin live-order panel (SSE + chime)
     • Shared overlay injection, scroll-reveal, host-badge suppression
   Exposes window.CF for page controllers (see menu.js).
   ============================================================= */
(function () {
  "use strict";

  var D = window.CYRIL;
  var BRAND = D.BRAND, CATS = D.CATEGORIES, MENU = D.MENU, FEATURED = D.FEATURED, money = D.money;
  var PAGE = (document.body.getAttribute("data-page") || "home");

  /* ---------------- Config & state ---------------- */
  var CONFIG = {
    // Backend origin. On a Node host this is the same site; on static hosting
    // (e.g. Netlify) set window.CYRIL_API_BASE to the deployed server URL.
    apiBase: window.CYRIL_API_BASE
      || (window.location.origin && window.location.origin.indexOf("http") === 0 ? window.location.origin : ""),
    // Optional Supabase Auth for fully-static magic links (set both to enable).
    supabaseUrl: window.CYRIL_SUPABASE_URL || "",
    supabaseAnonKey: window.CYRIL_SUPABASE_ANON_KEY || "",
    paystackKey: window.CYRIL_PAYSTACK_PK || "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    googleMapsKey: window.CYRIL_GOOGLE_MAPS_KEY || "",
    ratePerKm: BRAND.ratePerKm,
    originLat: BRAND.originLat,
    originLng: BRAND.originLng,
    originAddress: BRAND.originAddress || "",
    lagosBounds: BRAND.lagosBounds || { southwest: { lat: 6.35, lng: 3.05 }, northeast: { lat: 6.80, lng: 3.75 }, center: { lat: 6.60, lng: 3.38 } },
  };

  var state = {
    cart: [],
    open: true,
    checkoutAddress: null,
    gridRenderer: null,
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /* ---------------- Toast ---------------- */
  function toast(msg, type) {
    var wrap = $("#toastWrap");
    if (!wrap) return;
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

  /* ---------------- Operating-hours engine ---------------- */
  function getNowInLagos() {
    var now = new Date();
    try {
      var parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(now);
      var out = {};
      parts.forEach(function (p) { out[p.type] = p.value; });
      return { hour: parseInt(out.hour, 10), minute: parseInt(out.minute, 10) };
    } catch (e) {
      return { hour: (now.getUTCHours() + 1) % 24, minute: now.getUTCMinutes() };
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
  // Renders the announcement bar + ordering controls based on state.open.
  // state.open is true ONLY during business hours (9 AM – 7 PM WAT) AND when
  // staff haven't force-closed the kitchen. The closed banner therefore shows
  // exclusively outside opening hours (7:01 PM – 8:59 AM) or on a staff closure.
  function applyHoursUI() {
    var bar = $("#statusBar"), txt = $("#statusText"), hrs = $("#statusHours");
    if (state.open) {
      // Declutter: hide the announcement bar entirely during open hours.
      if (bar) bar.hidden = true;
      $$(".dish__add, #checkoutBtn, #addCartBtn").forEach(function (b) { b.disabled = false; });
    } else {
      // Closed: either before 9 AM / after 7 PM, or staff force-closed.
      if (bar) {
        bar.hidden = false;
        bar.classList.remove("statusbar--open");
        bar.classList.add("statusbar--closed");
      }
      if (txt) txt.textContent = "Yes, we are closed! But we'd be back by opening time (9:00 AM).";
      if (hrs) hrs.textContent = "";
      $$(".dish__add, #checkoutBtn, #addCartBtn").forEach(function (b) { b.disabled = true; });
    }
    if (typeof state.gridRenderer === "function") state.gridRenderer();
  }
  function applyHours() {
    state.open = isOpenNow();          // clock-based opening (9 AM – 7 PM WAT)
    applyHoursUI();
  }

  /* ---------------- Distance / maps engine ---------------- */
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
        s.src = "https://maps.googleapis.com/maps/api/js?key=" + CONFIG.googleMapsKey + "&libraries=places&callback=" + cbName;
        s.onerror = function () { reject(new Error("google-load-failed")); };
        document.head.appendChild(s);
      });
      return this.googleLoading;
    },
    suggest: function (query) {
      var q = query.trim();
      if (q.length < 2) return Promise.resolve([]);
      var self = this;
      return this.ensureGoogle().then(function () { return []; }).catch(function () {
        // Bias search to the entire Lagos metropolis (bbox + proximity to origin).
        var b = CONFIG.lagosBounds;
        var photonUrl = "https://photon.komoot.io/api/?limit=8&lang=en" +
          "&q=" + encodeURIComponent(q) +
          "&lat=" + CONFIG.originLat + "&lon=" + CONFIG.originLng +
          "&bbox=" + [b.southwest.lng, b.southwest.lat, b.northeast.lng, b.northeast.lat].join(",");
        return fetch(photonUrl).then(function (r) { return r.json(); }).then(function (data) {
          var results = (data.features || []).map(function (f) {
            var p = f.properties, c = f.geometry.coordinates;
            var parts = [p.housenumber, p.street, p.district || p.suburb || p.name, p.city || p.county, "Lagos", "Nigeria"].filter(Boolean);
            var label = parts.filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ");
            return { label: label || (p.name || q), lat: c[1], lng: c[0], secondary: p.name && parts.indexOf(p.name) === -1 ? p.name : "" };
          }).filter(function (x) { return x.label; });
          if (results.length) return results;
          return self.nominatim(q);
        }).catch(function () { return self.nominatim(q); });
      });
    },
    // Secondary free geocoder (OpenStreetMap Nominatim) for obscure streets/landmarks.
    nominatim: function (q) {
      var b = CONFIG.lagosBounds;
      var viewbox = b.southwest.lng + "," + b.northeast.lat + "," + b.northeast.lng + "," + b.southwest.lat;
      var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=ng" +
        "&viewbox=" + viewbox + "&bounded=0&addressdetails=1&q=" + encodeURIComponent(q + ", Lagos, Nigeria");
      return fetch(url, { headers: { "Accept-Language": "en" } })
        .then(function (r) { return r.json(); })
        .then(function (arr) {
          return (arr || []).map(function (x) {
            return { label: x.display_name, lat: parseFloat(x.lat), lng: parseFloat(x.lon), secondary: x.type || "" };
          }).filter(function (x) { return x.label; });
        }).catch(function () { return []; });
    },
    attachGoogleAutocomplete: function (inputEl, onPlace) {
      this.ensureGoogle().then(function () {
        // Expand search bounds to the entire Lagos metropolis, no artificial limits.
        var b = CONFIG.lagosBounds;
        var lagosBounds = new google.maps.LatLngBounds(
          new google.maps.LatLng(b.southwest.lat, b.southwest.lng),
          new google.maps.LatLng(b.northeast.lat, b.northeast.lng));
        var ac = new google.maps.places.Autocomplete(inputEl, {
          componentRestrictions: { country: "ng" },
          bounds: lagosBounds,
          strictBounds: false, // allow (but bias to) the whole Lagos area
          fields: ["formatted_address", "geometry", "name"],
        });
        // Also enable Geocoding fallback for free-typed obscure addresses.
        var geocoder = new google.maps.Geocoder();
        inputEl.addEventListener("blur", function () {
          if (inputEl.dataset.placeSet === "1") return;
          var v = inputEl.value.trim();
          if (v.length < 3) return;
          geocoder.geocode({ address: v + ", Lagos, Nigeria", region: "ng", bounds: lagosBounds }, function (res, status) {
            if (status === "OK" && res && res[0] && res[0].geometry) {
              var loc = res[0].geometry.location;
              onPlace({ label: res[0].formatted_address, lat: loc.lat(), lng: loc.lng(), source: "geocoder" });
            }
          });
        });
        ac.addListener("place_changed", function () {
          var place = ac.getPlace();
          if (place && place.geometry && place.geometry.location) {
            inputEl.dataset.placeSet = "1";
            var loc = place.geometry.location;
            onPlace({ label: place.formatted_address || inputEl.value, lat: loc.lat(), lng: loc.lng(),
                      secondary: place.name || "", source: "google" });
          }
        });
      }).catch(function () {});
    },
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
            if (status === "OK" && resp.rows[0] && resp.rows[0].elements[0] && resp.rows[0].elements[0].status === "OK") {
              var e = resp.rows[0].elements[0];
              resolve({ km: e.distance.value / 1000, minutes: Math.round(e.duration.value / 60), source: "google" });
            } else reject(new Error("matrix-failed"));
          });
        });
      }).catch(function () {
        var url = "https://router.project-osrm.org/route/v1/driving/" +
          CONFIG.originLng + "," + CONFIG.originLat + ";" + lng + "," + lat + "?overview=false";
        return fetch(url).then(function (r) { return r.json(); }).then(function (data) {
          if (data.code === "Ok" && data.routes && data.routes[0]) {
            return { km: data.routes[0].distance / 1000, minutes: Math.round(data.routes[0].duration / 60), source: "osrm" };
          }
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

  function resolveRoute(place, target) {
    target = target || "checkout";
    var note = target === "estimate" ? $("#calcNote") : null;
    if (note) note.textContent = "Calculating driving route…";
    return geo.routeDistance(place.lat, place.lng).then(function (r) {
      var fee = computeFee(r.km);
      var result = { km: r.km, minutes: r.minutes, fee: fee, address: place.label,
                     lat: place.lat, lng: place.lng, source: r.source };
      // The verified address + fee is the SAME whether entered on the homepage
      // calculator or at checkout — persist once and reuse everywhere.
      state.checkoutAddress = result;
      try { localStorage.setItem("cyrils_addr", JSON.stringify(result)); } catch (e) {}
      updateCheckoutTotals();

      if (target === "estimate") {
        var distEl = $("#calcDistance"), feeEl = $("#calcFee");
        if (distEl) distEl.textContent = r.km.toFixed(1) + " km" + (r.minutes ? " · ~" + r.minutes + " min" : "");
        if (feeEl) feeEl.textContent = money(fee);
        if (note) note.textContent = "Exact fee " + money(fee) +
          (r.source === "estimate" ? " (straight-line estimate)" : " based on live driving distance.") +
          " Saved — it carries over to checkout.";
        showSavedAddressChip("calc", result);
      } else {
        showSavedAddressChip("co", result);
      }
      return result;
    }).catch(function () {
      if (note) note.textContent = "Could not calculate route. Please pick a clearer address.";
      toast("Distance calculation failed — check your address.", "error");
      return null;
    });
  }

  function initAutocomplete(inputEl, listEl, onSelect) {
    if (!inputEl) return;
    var googleMode = !!CONFIG.googleMapsKey;
    var activeIdx = -1, items = [];
    geo.attachGoogleAutocomplete(inputEl, function (place) { listEl && listEl.classList.remove("is-open"); onSelect(place); });
    var t;
    inputEl.addEventListener("input", function () {
      if (googleMode) return;
      clearTimeout(t);
      var v = inputEl.value;
      t = setTimeout(function () {
        geo.suggest(v).then(function (results) {
          items = results; activeIdx = -1;
          if (!listEl || !results.length) { listEl && listEl.classList.remove("is-open"); return; }
          listEl.innerHTML = results.map(function (r, i) {
            return '<li role="option" data-i="' + i + '">' + esc(r.label) +
              (r.secondary ? '<span class="autocomplete__secondary">' + esc(r.secondary) + "</span>" : "") + "</li>";
          }).join("");
          listEl.classList.add("is-open");
        });
      }, 250);
    });
    if (listEl) {
      listEl.addEventListener("click", function (e) {
        var li = e.target.closest("li"); if (!li) return;
        var p = items[parseInt(li.getAttribute("data-i"), 10)];
        if (p) { inputEl.value = p.label; listEl.classList.remove("is-open"); onSelect(p); }
      });
    }
    inputEl.addEventListener("keydown", function (e) {
      if (googleMode || !items.length || !listEl) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx += (e.key === "ArrowDown" ? 1 : -1);
        activeIdx = Math.max(0, Math.min(items.length - 1, activeIdx));
        $$("li", listEl).forEach(function (li, i) { li.classList.toggle("is-active", i === activeIdx); });
      } else if (e.key === "Enter" && activeIdx >= 0) {
        e.preventDefault();
        var p = items[activeIdx]; inputEl.value = p.label; listEl.classList.remove("is-open"); onSelect(p);
      } else if (e.key === "Escape") { listEl.classList.remove("is-open"); }
    });
    document.addEventListener("click", function (e) {
      if (listEl && !listEl.contains(e.target) && e.target !== inputEl) listEl.classList.remove("is-open");
    });
    // Typing a new address invalidates a previously geocoded place.
    inputEl.addEventListener("input", function () { inputEl.dataset.placeSet = ""; });
  }

  /* ---- Saved delivery address: display chip + edit/clear ---- */
  function showSavedAddressChip(kind, result) {
    var wrapId = kind === "calc" ? "#calcSaved" : "#coSaved";
    var wrap = $(wrapId);
    if (!wrap || !result) return;
    wrap.innerHTML =
      '<div class="saved-addr">' +
        '<span class="saved-addr__icon">📍</span>' +
        '<div class="saved-addr__txt"><strong>' + esc(result.address) + '</strong>' +
        '<small>' + result.km.toFixed(1) + " km · ~" + result.minutes + " min · delivery " + money(result.fee) + '</small></div>' +
        '<button type="button" class="saved-addr__edit" data-edit="' + kind + '">Edit</button>' +
      "</div>";
    wrap.style.display = "block";
    wrap.querySelector("[data-edit]").addEventListener("click", function () {
      wrap.style.display = "none";
      var inp = $(kind === "calc" ? "#calcAddress" : "#coAddress");
      if (inp) { inp.value = ""; inp.focus(); }
      state.checkoutAddress = null;
      try { localStorage.removeItem("cyrils_addr"); } catch (e) {}
      updateCheckoutTotals();
    });
  }

  function restoreSavedAddress() {
    var saved = state.checkoutAddress;
    if (!saved) return;
    var coInp = $("#coAddress"); if (coInp && !coInp.value) { coInp.value = saved.address; }
    var calcInp = $("#calcAddress"); if (calcInp && !calcInp.value) { calcInp.value = saved.address; }
    var dEl = $("#calcDistance"), fEl = $("#calcFee"), nEl = $("#calcNote");
    if (dEl) dEl.textContent = saved.km.toFixed(1) + " km · ~" + saved.minutes + " min";
    if (fEl) fEl.textContent = money(saved.fee);
    if (nEl) nEl.textContent = "Your saved delivery address — fee " + money(saved.fee) + ".";
    showSavedAddressChip("calc", saved);
    showSavedAddressChip("co", saved);
    updateCheckoutTotals();
  }

  /* ---------------- Menu cards (shared template) ---------------- */
  function catLabel(id) { var c = CATS.find(function (x) { return x.id === id; }); return c ? c.label : id; }
  function findItem(id) { return MENU.find(function (m) { return m.id === id; }); }

  function cardHTML(m) {
    var itemOos = state.oosIds && state.oosIds.indexOf(m.id) !== -1;
    var unavailable = !state.open || itemOos;
    var hasMods = m.modifiers && m.modifiers.length;
    return '<article class="dish' + (unavailable ? " dish--oos" : "") + '" data-id="' + m.id + '">' +
      '<div class="dish__img">' +
        '<img src="' + m.image + '" alt="' + esc(m.name) + '" loading="lazy" />' +
        (m.popular ? '<span class="dish__tag' + (m.id.indexOf("combo") === 0 ? " dish__tag--combo" : "") + '">⭐ Popular</span>' : "") +
        (unavailable ? '<span class="dish__oos">' + (itemOos ? "Sold Out" : "Out of Stock") + "</span>"
                : '<button class="dish__add" data-id="' + m.id + '" aria-label="Add ' + esc(m.name) + '">+</button>') +
      "</div>" +
      '<div class="dish__body">' +
        '<span class="dish__cat">' + esc(catLabel(m.category)) + "</span>" +
        '<h3 class="dish__name">' + esc(m.name) + "</h3>" +
        '<p class="dish__desc">' + esc(m.desc || "") + "</p>" +
        '<div class="dish__foot">' +
          '<span class="dish__price">' + money(m.price) + "</span>" +
          (hasMods ? '<button class="dish__custom" data-id="' + m.id + '">Customise &rarr;</button>' : "") +
        "</div>" +
      "</div></article>";
  }

  function mountGrid(container, items) {
    if (!container) return;
    container.innerHTML = items.map(cardHTML).join("");
    $$(".dish", container).forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (e.target.closest(".dish__add") || e.target.closest(".dish__custom")) return;
        openItem(card.getAttribute("data-id"));
      });
    });
    $$(".dish__add", container).forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var item = findItem(btn.getAttribute("data-id"));
        if (item && item.modifiers && item.modifiers.length) openItem(item.id);
        else quickAdd(item);
      });
    });
    $$(".dish__custom", container).forEach(function (btn) {
      btn.addEventListener("click", function (e) { e.stopPropagation(); openItem(btn.getAttribute("data-id")); });
    });
    var empty = container.nextElementSibling;
    if (empty && empty.classList.contains("menu__empty")) empty.hidden = items.length > 0;
  }

  /* ---------------- Cart + customisation ---------------- */
  var modalItem = null, modalQty = 1, modalSelections = [];

  function openItem(id) {
    if (!state.open) { toast("We're closed right now — orders reopen at 9:00 AM. 🌙", "info"); return; }
    var item = findItem(id);
    if (!item) return;
    modalItem = item; modalQty = 1; modalSelections = [];
    $("#imImg").src = item.image; $("#imImg").alt = item.name;
    $("#imCat").textContent = catLabel(item.category);
    $("#itemModalTitle").textContent = item.name;
    $("#imDesc").textContent = item.desc || "";
    $("#qtyValue").textContent = "1";
    $("#imModifiers").innerHTML = (item.modifiers || []).map(function (g, gi) {
      var type = g.allowMultiple ? "checkbox" : "radio";
      var opts = g.options.map(function (o, oi) {
        return '<div class="mod-opt" data-gi="' + gi + '" data-oi="' + oi + '">' +
          '<input type="' + type + '" name="mod-' + gi + '" id="mod-' + gi + "-" + oi + '" data-gi="' + gi + '" data-oi="' + oi + '"' +
            (g.required && oi === 0 ? " checked" : "") + " />" +
          '<label for="mod-' + gi + "-" + oi + '"><span>' + esc(o.label) + "</span>" +
            '<span class="mod-opt__price">' + (o.price > 0 ? "+" + money(o.price) : "Included") + "</span></label></div>";
      }).join("");
      return '<div class="mod-group"><div class="mod-group__title">' + esc(g.name) +
        (g.required ? ' <small>(required)</small>' : "") + "</div>" + opts + "</div>";
    }).join("");
    (item.modifiers || []).forEach(function (g, gi) { if (g.required) selectOption(gi, 0, !g.allowMultiple); });
    $$(".mod-opt", $("#imModifiers")).forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target.tagName !== "INPUT") {
          var inp = el.querySelector("input");
          if (inp.type === "radio") inp.checked = true; else inp.checked = !inp.checked;
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
      if (exists) modalSelections = modalSelections.filter(function (s) { return !(s.gi === gi && s.label === o.label); });
      else modalSelections.push({ gi: gi, group: g.name, label: o.label, price: o.price });
      var el = $$('.mod-opt[data-gi="' + gi + '"]')[oi];
      if (el) el.classList.toggle("is-sel", !exists);
    }
  }
  function syncSelections() {
    modalSelections = [];
    $$("#imModifiers input").forEach(function (inp) {
      if (inp.checked) {
        var gi = parseInt(inp.getAttribute("data-gi"), 10), oi = parseInt(inp.getAttribute("data-oi"), 10);
        var g = modalItem.modifiers[gi], o = g.options[oi];
        modalSelections.push({ gi: gi, group: g.name, label: o.label, price: o.price });
      }
    });
    updateModalTotal();
  }
  function modalUnitPrice() { var b = modalItem.price; modalSelections.forEach(function (s) { b += s.price; }); return b; }
  function updateModalTotal() { $("#imTotal").textContent = money(modalUnitPrice() * modalQty); }

  function addCurrentToCart() {
    if (!modalItem) return;
    var missing = (modalItem.modifiers || []).filter(function (g) {
      return g.required && !modalSelections.some(function (s) { return s.gi === modalItem.modifiers.indexOf(g); });
    });
    if (missing.length) { toast("Please choose: " + missing.map(function (g) { return g.name; }).join(", "), "error"); return; }
    var lineId = modalItem.id + "|" + modalSelections.map(function (s) { return s.label; }).join("+");
    var existing = state.cart.find(function (l) { return l.lineId === lineId; });
    if (existing) existing.qty += modalQty;
    else state.cart.push({ lineId: lineId, item: modalItem, qty: modalQty, selections: modalSelections.slice(),
                           unitPrice: modalUnitPrice(), name: modalItem.name });
    closeModal("#itemModal");
    saveCart(); renderCart(); bumpBadge();
    toast(modalQty + " × " + modalItem.name + " added to cart 🛒", "success");
  }

  function quickAdd(item) {
    if (!item) return;
    var lineId = item.id + "|";
    var existing = state.cart.find(function (l) { return l.lineId === lineId; });
    if (existing) existing.qty++;
    else state.cart.push({ lineId: lineId, item: item, qty: 1, selections: [], unitPrice: item.price, name: item.name });
    saveCart(); renderCart(); bumpBadge();
    toast(item.name + " added 🛒", "success");
  }

  function cartSubtotal() { return state.cart.reduce(function (s, l) { return s + l.unitPrice * l.qty; }, 0); }
  function cartCount() { return state.cart.reduce(function (n, l) { return n + l.qty; }, 0); }
  function bumpBadge() {
    var badge = $("#cartCount"); if (!badge) return;
    badge.textContent = cartCount();
    if (badge.animate) badge.animate([{ transform: "scale(1)" }, { transform: "scale(1.4)" }, { transform: "scale(1)" }], { duration: 300, easing: "ease-out" });
  }

  function renderCart() {
    var body = $("#cartItems"), foot = $("#cartFoot");
    if (!body) return;
    var dc = $("#drawerCount"); if (dc) dc.textContent = cartCount();
    if (!state.cart.length) {
      if (foot) foot.hidden = true;
      body.innerHTML = '<div class="cart-empty" style="display:flex;flex-direction:column;align-items:center;gap:.8rem">' +
        "<span>🍽️</span><p>Your plate is empty.</p>" +
        '<a href="' + (PAGE === "menu" ? "menu.html" : "index.html#categories") + '" class="btn btn--primary btn--sm cart-empty__cta">Browse the menu</a></div>';
      var cta = body.querySelector(".cart-empty__cta");
      if (cta) cta.addEventListener("click", function () { closeDrawer(); });
      updateFabCart();
      return;
    }
    if (foot) foot.hidden = false;
    body.innerHTML = state.cart.map(function (l) {
      var mods = l.selections.length ? '<div class="cart-line__mods">' + l.selections.map(function (s) {
        return "<em>" + esc(s.label) + (s.price ? " (+" + money(s.price) + ")" : "") + "</em>"; }).join(" · ") + "</div>" : "";
      return '<div class="cart-line"><img class="cart-line__img" src="' + l.item.image + '" alt="" />' +
        '<div class="cart-line__info"><div class="cart-line__name">' + esc(l.name) + "</div>" + mods +
        '<div class="cart-line__ctrl"><div class="qty-mini">' +
          '<button data-act="dec" data-id="' + l.lineId + '" aria-label="Decrease">−</button><span>' + l.qty + "</span>" +
          '<button data-act="inc" data-id="' + l.lineId + '" aria-label="Increase">+</button></div>' +
          '<span class="cart-line__price">' + money(l.unitPrice * l.qty) + "</span></div>" +
          '<button class="cart-line__remove" data-act="rm" data-id="' + l.lineId + '">Remove</button></div></div>';
    }).join("");
    $$("[data-act]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id"), act = btn.getAttribute("data-act");
        var line = state.cart.find(function (x) { return x.lineId === id; });
        if (!line) return;
        if (act === "inc") line.qty++;
        else if (act === "dec") { line.qty--; if (line.qty <= 0) state.cart = state.cart.filter(function (x) { return x.lineId !== id; }); }
        else if (act === "rm") state.cart = state.cart.filter(function (x) { return x.lineId !== id; });
        saveCart(); renderCart(); bumpBadge();
      });
    });
    var st = $("#cartSubtotal"); if (st) st.textContent = money(cartSubtotal());
    updateFabCart();
  }

  /* Compact floating cart FAB (icon + count badge only; total lives in the drawer) */
  function updateFabCart() {
    var fab = $("#fabCart");
    if (!fab) return;
    var n = cartCount();
    fab.classList.add("is-shown");
    fab.classList.toggle("has-items", n > 0);
    fab.setAttribute("aria-label", n ? "View cart — " + n + " item" + (n === 1 ? "" : "s") : "View cart");
    var cEl = $("#fabCartCount"); if (cEl) cEl.textContent = n > 99 ? "99+" : n;
  }

  function saveCart() { try { localStorage.setItem("cyrils_cart", JSON.stringify(state.cart)); } catch (e) {} }
  function loadCart() {
    try {
      var raw = localStorage.getItem("cyrils_cart");
      if (raw) {
        state.cart = JSON.parse(raw).map(function (l) {
          var item = findItem(l.item && l.item.id);
          return item ? Object.assign({}, l, { item: item }) : null;
        }).filter(Boolean);
      }
    } catch (e) {}
    // Delivery address is independent of the cart and must restore on every load.
    try {
      var addr = localStorage.getItem("cyrils_addr");
      if (addr) state.checkoutAddress = JSON.parse(addr);
    } catch (e) {}
  }

  function openDrawer() {
    $("#cartDrawer").classList.add("is-open"); $("#drawerBackdrop").classList.add("is-open");
    $("#cartDrawer").setAttribute("aria-hidden", "false"); document.body.classList.add("no-scroll"); renderCart();
  }
  function closeDrawer() {
    $("#cartDrawer").classList.remove("is-open"); $("#drawerBackdrop").classList.remove("is-open");
    $("#cartDrawer").setAttribute("aria-hidden", "true");
    if (!$$(".modal.is-open").length) document.body.classList.remove("no-scroll");
  }

  /* ---------------- Modals ---------------- */
  function openModal(sel) { $(sel).classList.add("is-open"); $(sel).setAttribute("aria-hidden", "false"); document.body.classList.add("no-scroll"); }
  function closeModal(sel) {
    $(sel).classList.remove("is-open"); $(sel).setAttribute("aria-hidden", "true");
    if (!$$(".modal.is-open").length && !$("#cartDrawer").classList.contains("is-open")) document.body.classList.remove("no-scroll");
  }

  function updateCheckoutTotals() {
    var sub = cartSubtotal();
    var fee = state.checkoutAddress ? state.checkoutAddress.fee : 0;
    setText("#coSubtotal", money(sub)); setText("#coFee", money(fee));
    if (state.checkoutAddress) setText("#coDistance", state.checkoutAddress.km.toFixed(1) + " km · ~" + state.checkoutAddress.minutes + " min");
    else setText("#coDistance", "— set address —");
    setText("#coTotal", money(sub + fee));
    var pa = $("#payAmount"); if (pa) pa.textContent = money(sub + fee);
    var pb = $("#payBtn"); if (pb) pb.disabled = !state.open;
  }
  function setText(sel, v) { var el = $(sel); if (el) el.textContent = v; }

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
        name: $("#coName").value.trim(), phone: $("#coPhone").value.trim(),
        email: ($("#coName").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".") || "guest") + "@order.cyrilsfood.com.ng",
      },
      address: state.checkoutAddress ? {
        description: state.checkoutAddress.address, lat: state.checkoutAddress.lat, lng: state.checkoutAddress.lng,
        distanceKm: Number(state.checkoutAddress.km.toFixed(2)), minutes: state.checkoutAddress.minutes, fee: state.checkoutAddress.fee,
      } : null,
      note: $("#coNote").value.trim(), method: method,
      items: state.cart.map(function (l) {
        return { name: l.name, qty: l.qty, unitPrice: l.unitPrice,
          options: l.selections.map(function (s) { return s.label + (s.price ? " (+" + s.price + ")" : ""); }),
          lineTotal: l.unitPrice * l.qty };
      }),
      subtotal: cartSubtotal(), deliveryFee: state.checkoutAddress ? state.checkoutAddress.fee : 0,
      total: cartSubtotal() + (state.checkoutAddress ? state.checkoutAddress.fee : 0),
    };
  }
  function payWithPaystack(order) {
    return loadPaystack().then(function () {
      return new Promise(function (resolve, reject) {
        var fields = order.items.map(function (i) { return i.qty + "x " + i.name; }).join(", ");
        var handler = PaystackPop.setup({
          key: CONFIG.paystackKey, email: order.customer.email, amount: Math.round(order.total * 100),
          currency: "NGN", ref: order.reference,
          metadata: { custom_fields: [
            { display_name: "Customer Name", variable_name: "customer_name", value: order.customer.name },
            { display_name: "Phone", variable_name: "phone", value: order.customer.phone },
            { display_name: "Delivery Address", variable_name: "address", value: order.address ? order.address.description : "N/A" },
            { display_name: "Distance", variable_name: "distance_km", value: order.address ? order.address.distanceKm : 0 },
            { display_name: "Order", variable_name: "items", value: fields },
            { display_name: "Note", variable_name: "note", value: order.note || "" },
          ] },
          channels: ["card", "bank_transfer"],
          onClose: function () { reject(new Error("cancelled")); },
          callback: function (resp) {
            verifyPayment(resp.reference).then(function (ok) { ok ? resolve(resp) : reject(new Error("verify-failed")); })
              .catch(function () { resolve(resp); });
          },
        });
        handler.openIframe();
      });
    });
  }
  function initializeOrder(order) {
    return fetch(CONFIG.apiBase + "/api/order/init", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order),
    }).then(function (r) { if (!r.ok) throw new Error("init-failed"); return r.json(); })
      .catch(function () { order.reference = order.reference || ("CFD" + Date.now() + Math.floor(Math.random() * 1000)); return { reference: order.reference, offline: true }; });
  }
  function verifyPayment(reference) {
    return fetch(CONFIG.apiBase + "/api/order/verify?reference=" + encodeURIComponent(reference))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.data && d.data.status === "success"; })
      .catch(function () { return false; });
  }

  /* ---------------- Public kitchen status (overrides only) ----------------
     Live orders are NEVER exposed publicly. The kitchen portal (secret page +
     PIN) owns the authenticated order stream. Here we only fetch a public
     status snapshot (manual closed toggle + out-of-stock item ids) so the
     storefront reflects staff overrides. */
  function fetchKitchenStatus() {
    if (!CONFIG.apiBase) return Promise.resolve(null);
    return fetch(CONFIG.apiBase + "/api/status", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return null;
        state.kitchen = s;
        state.oosIds = Array.isArray(s.outOfStock) ? s.outOfStock : [];
        // Staff force-closure overrides the clock; otherwise fall back to the
        // real Lagos business-hours clock (9 AM – 7 PM) so an override being
        // lifted correctly re-opens ordering without a page refresh.
        state.open = s.manualClosed === true ? false : isOpenNow();
        applyHoursUI();
        return s;
      })
      .catch(function () { return null; });
  }

  /* ---------------- Shared overlay injection ---------------- */
  function injectSharedUI() {
    if (document.getElementById("sharedOverlays")) return;
    var holder = document.createElement("div");
    holder.id = "sharedOverlays";
    holder.innerHTML =
      '<a class="fab-wa" href="https://wa.me/2348081988184?text=Hello%20Cyril%27s%20Foods!%20I%20want%20to%20order." target="_blank" rel="noopener" aria-label="Chat on WhatsApp">' +
        '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 001.512 5.26l-.999 3.648 3.976-1.607zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg></a>' +

      // Compact floating cart FAB — every public page (icon + count badge only).
      '<button class="fab-cart" id="fabCart" aria-label="View cart">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>' +
        '<span class="fab-cart__count" id="fabCartCount">0</span>' +
      "</button>" +

      '<div class="drawer-backdrop" id="drawerBackdrop"></div>' +
      '<aside class="drawer" id="cartDrawer" aria-label="Shopping cart" aria-hidden="true">' +
        '<div class="drawer__head"><h3>Your Order <span class="drawer__count" id="drawerCount">0</span></h3>' +
        '<button class="drawer__close" id="drawerClose" aria-label="Close cart">&times;</button></div>' +
        '<div class="drawer__body" id="cartItems"></div>' +
        '<div class="drawer__foot" id="cartFoot" hidden>' +
          '<div class="drawer__totals"><div class="drawer__row"><span>Subtotal</span><strong id="cartSubtotal">₦0</strong></div>' +
          '<div class="drawer__row drawer__row--muted"><span>Delivery</span><span>calculated at checkout</span></div></div>' +
          '<button class="btn btn--primary btn--lg" id="checkoutBtn" style="width:100%;justify-content:center">Checkout ' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>' +
          '<button class="btn btn--link" id="bulkWaBtn" style="width:100%">Need a bulk order? Chat us</button>' +
        "</div></aside>" +

      '<div class="modal" id="itemModal" aria-hidden="true"><div class="modal__backdrop" data-close-modal></div>' +
        '<div class="modal__box modal__box--item" role="dialog" aria-modal="true" aria-labelledby="itemModalTitle">' +
        '<button class="modal__close" data-close-modal aria-label="Close">&times;</button>' +
        '<div class="item-modal"><div class="item-modal__img"><img id="imImg" src="" alt="Selected dish" /></div>' +
        '<div class="item-modal__body"><span class="item-modal__cat" id="imCat"></span>' +
        '<h3 id="itemModalTitle"></h3><p class="item-modal__desc" id="imDesc"></p>' +
        '<div id="imModifiers"></div>' +
        '<div class="item-modal__foot"><div class="qty">' +
          '<button id="qtyMinus" aria-label="Decrease quantity">−</button><span id="qtyValue">1</span><button id="qtyPlus" aria-label="Increase quantity">+</button></div>' +
        '<button class="btn btn--primary" id="addCartBtn">Add to cart · <span id="imTotal">₦0</span></button>' +
        "</div></div></div></div></div>" +

      '<div class="modal" id="checkoutModal" aria-hidden="true"><div class="modal__backdrop" data-close-modal></div>' +
        '<div class="modal__box" role="dialog" aria-modal="true" aria-labelledby="checkoutTitle">' +
        '<button class="modal__close" data-close-modal aria-label="Close">&times;</button>' +
        '<h3 class="checkout__title" id="checkoutTitle">Checkout</h3>' +
        '<form id="checkoutForm" class="checkout"><div class="checkout__grid">' +
          '<div class="field"><label for="coName">Full name *</label><input type="text" id="coName" required placeholder="Your name" /></div>' +
          '<div class="field"><label for="coPhone">Phone / WhatsApp *</label><input type="tel" id="coPhone" required placeholder="080…" /></div></div>' +
          '<div class="field"><label for="coAddress">Delivery address * <span class="field__hint">(pick from the list)</span></label>' +
            '<div class="autocomplete"><input type="text" id="coAddress" autocomplete="off" placeholder="e.g. College Rd, Ifako-Ijaiye, Lagos" />' +
            '<ul class="autocomplete__list" id="coSuggestions" role="listbox"></ul></div>' +
            '<div class="saved-addr-wrap" id="coSaved" style="display:none"></div></div>' +
          '<div class="field"><label for="coNote">Order note <span class="field__hint">(optional)</span></label>' +
            '<input type="text" id="coNote" placeholder="e.g. ring the gate bell, extra pepper" /></div>' +
          '<div class="checkout__summary"><div class="drawer__row"><span>Items subtotal</span><strong id="coSubtotal">₦0</strong></div>' +
            '<div class="drawer__row"><span>Delivery distance</span><span id="coDistance">—</span></div>' +
            '<div class="drawer__row drawer__row--fee"><span>Delivery fee <small>(km × ₦1,100)</small></span><strong id="coFee">₦0</strong></div>' +
            '<div class="drawer__row drawer__row--total"><span>Total</span><strong id="coTotal">₦0</strong></div></div>' +
          '<div class="pay-methods"><label class="pay-method"><input type="radio" name="payMethod" value="card" checked /><span>💳<strong>Card</strong></span></label>' +
            '<label class="pay-method"><input type="radio" name="payMethod" value="bank_transfer" /><span>🏦<strong>Bank Transfer</strong></span></label></div>' +
          '<p class="checkout__secure">🔒 Secured by Paystack · Card &amp; dynamic transfer accounts · auto-verified</p>' +
          '<button type="submit" class="btn btn--primary btn--lg" id="payBtn" style="width:100%;justify-content:center">Pay <span id="payAmount">₦0</span></button>' +
        "</form></div></div>" +

      '<div class="modal" id="successModal" aria-hidden="true"><div class="modal__backdrop"></div>' +
        '<div class="modal__box modal__box--success"><div class="success"><div class="success__check">✓</div>' +
        "<h3>Order confirmed!</h3><p id=\"successText\">Payment received. Our kitchen is on it — we'll WhatsApp you updates shortly.</p>" +
        '<div class="success__ref">Ref: <strong id="successRef"></strong></div>' +
        '<button class="btn btn--primary" id="successClose">Back to menu</button></div></div></div>' +

      '<div class="modal" id="deliveryInfoModal" aria-hidden="true"><div class="modal__backdrop" data-close-modal></div>' +
        '<div class="modal__box" role="dialog" aria-modal="true" aria-labelledby="deliveryInfoTitle">' +
        '<button class="modal__close" data-close-modal aria-label="Close">&times;</button>' +
        '<div class="info-modal">' +
          '<span class="info-modal__icon">🗺️</span>' +
          '<h3 id="deliveryInfoTitle">How your delivery fee is calculated</h3>' +
          '<p>Your fee is a flat <strong>₦1,100 per kilometre</strong>, measured straight from our kitchen to your drop-off using live route mapping — no flat-rate guesswork.</p>' +
          '<div class="info-modal__route"><span class="info-modal__pin pin-a">A</span>' +
            '<div class="info-modal__line"><span class="info-modal__truck">🛵</span></div>' +
            '<span class="info-modal__pin pin-b">B</span></div>' +
          '<div class="info-modal__points">' +
            '<div><strong>A · Cyril\'s Kitchen</strong><small>' + esc(CONFIG.originAddress || "26 College Rd, Ifako-Ijaiye, Lagos") + '</small></div>' +
            '<div><strong>B · Your delivery location</strong><small>You enter your address; we map the exact driving distance.</small></div>' +
          '</div>' +
          '<div class="info-modal__formula">Distance (km) × ₦1,100 = <strong>your delivery fee</strong></div>' +
          '<p class="info-modal__eg">e.g. a 7&nbsp;km route → 7 × ₦1,100 = <strong>₦7,700</strong>, added to your order at checkout.</p>' +
          '<button class="btn btn--primary" data-close-modal style="width:100%;justify-content:center">Got it</button>' +
        "</div></div></div>" +

      // Hidden staff (kitchen) access modal — only reachable via the triple-tap gesture.
      '<div class="modal" id="staffModal" aria-hidden="true"><div class="modal__backdrop" data-close-modal></div>' +
        '<div class="modal__box" role="dialog" aria-modal="true" aria-labelledby="staffTitle">' +
        '<button class="modal__close" data-close-modal aria-label="Close">&times;</button>' +
        '<form id="staffForm" class="staff-auth">' +
          '<span class="staff-auth__icon">🔐</span>' +
          '<h3 id="staffTitle">Staff Access</h3>' +
          '<p class="staff-auth__sub">Enter your authorized staff email and we\'ll send a one-time sign-in link. The link expires in 10 minutes and keeps this device signed in for 24 hours.</p>' +
          '<div class="field"><label for="staffEmail">Staff email</label>' +
            '<input type="email" id="staffEmail" autocomplete="email" placeholder="kitchen@cyrilfoods.com.ng" required /></div>' +
          '<button type="submit" class="btn btn--primary" id="staffSubmit" style="width:100%;justify-content:center">Email me a sign-in link</button>' +
          '<p class="staff-auth__note" id="staffNote" hidden></p>' +
        '</form>' +
        '</div></div>' +

      '<div class="toast-wrap" id="toastWrap" aria-live="polite"></div>';
    document.body.appendChild(holder);
  }

  /* ---------------- Host badge suppression (Netlify) ---------------- */
  function killHostBadges() {
    var sel = ".netlify-badge, [id^='netlify-badge'], [class*='netlify-badge'], iframe[src*='netlify'], a[href*='app.netlify.com/drop'], [id^='netlify']";
    $$(sel).forEach(function (el) { el.remove(); });
    try {
      var mo = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) {
              if (n.matches && n.matches(sel)) n.remove();
              if (n.querySelectorAll) n.querySelectorAll(sel).forEach(function (x) { x.remove(); });
            }
          });
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  /* ---------------- Scroll reveal ---------------- */
  function initReveal() {
    var els = $$(".reveal");
    if (!("IntersectionObserver" in window) || !els.length) { els.forEach(function (e) { e.classList.add("is-visible"); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("is-visible"); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ---------------- Nav ---------------- */
  function initNav() {
    var nav = $(".nav");
    if (nav) window.addEventListener("scroll", function () { nav.classList.toggle("is-scrolled", window.scrollY > 10); });
    var burger = $("#navBurger"), links = $("#navLinks");
    if (burger && links) {
      burger.addEventListener("click", function () {
        var open = links.classList.toggle("is-open");
        burger.classList.toggle("is-open", open);
        burger.setAttribute("aria-expanded", open ? "true" : "false");
      });
      $$("a", links).forEach(function (a) {
        a.addEventListener("click", function () {
          links.classList.remove("is-open"); burger.classList.remove("is-open");
          burger.setAttribute("aria-expanded", "false");
        });
      });
    }
  }

  /* ---------------- Secret kitchen entry: 3 quick taps on the logo ----------------
     Customers never see a link. Staff tap the header logo (or footer logo) three
     times within 1.5s to open the hidden Staff Access (magic-link) modal. A normal
     single tap on the header logo still navigates home as usual. */
  function initSecretTap() {
    var taps = 0, timer = null;
    var WINDOW = 1500; // 1.5 seconds
    function hit(e) {
      taps++;
      if (timer) clearTimeout(timer);
      if (taps >= 3) {
        taps = 0; clearTimeout(timer);
        e.preventDefault(); e.stopPropagation();
        openModal("#staffModal");
        var em = $("#staffEmail"); if (em) setTimeout(function () { em.focus(); }, 250);
        return;
      }
      // Header logo is a home link: briefly hold its normal navigation so three
      // fast taps can be detected; a lone tap still goes home after the wait.
      if (e.currentTarget && e.currentTarget.tagName === "A") {
        e.preventDefault();
        timer = setTimeout(function () { taps = 0; location.href = "index.html"; }, 450);
      } else {
        timer = setTimeout(function () { taps = 0; }, WINDOW);
      }
    }
    var header = $(".nav__brand");
    if (header) header.addEventListener("click", hit);
    var footer = $(".footer__brand img, .footer__brand");
    if (footer) {
      footer.style.cursor = "pointer";
      footer.addEventListener("click", hit);
    }
  }

  /* Staff magic-link request.
     - If Supabase keys are configured (static hosting), use signInWithOtp directly.
     - Otherwise POST to the Node backend, with clear success/error UI states. */
  function setStaffNote(kind, msg) {
    var note = $("#staffNote"); if (!note) return;
    note.hidden = false;
    note.classList.remove("is-ok", "is-err");
    if (kind) note.classList.add(kind === "ok" ? "is-ok" : "is-err");
    note.textContent = msg;
  }
  function requestViaSupabase(email) {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    // Load the Supabase JS SDK on demand, then create the client.
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
      s.onload = resolve; s.onerror = function () { reject(new Error("sdk")); };
      document.head.appendChild(s);
    }).then(function () {
      window.__sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
    });
  }
  function initStaffAuth() {
    var form = $("#staffForm"); if (!form) return;
    var btn = $("#staffSubmit");
    var DEFAULT_BTN = btn ? btn.textContent : "Email me a sign-in link";
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = ($("#staffEmail").value || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setStaffNote("err", "Please enter a valid email address."); return;
      }
      if (btn) { btn.disabled = true; btn.textContent = "Sending magic link…"; }
      setStaffNote("", "Sending magic link…");

      var useSupabase = !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
      var p;
      if (useSupabase) {
        p = requestViaSupabase(email).then(function () {
          return window.__sb.auth.signInWithOtp({
            email: email,
            options: { emailRedirectTo: window.location.origin + "/kitchen.html" }
          });
        }).then(function (resp) {
          if (resp && resp.error) throw new Error(resp.error.message || "auth error");
          return { ok: true };
        });
      } else {
        p = fetch(CONFIG.apiBase + "/api/kitchen/magic-request", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ email: email })
        }).then(function (r) {
          var ct = r.headers.get("content-type") || "";
          if (ct.indexOf("application/json") === -1) {
            // Backend not reachable (static host returning HTML) — not a crash.
            var err = new Error("no-backend"); err.status = r.status; throw err;
          }
          return r.json().then(function (d) { return { ok: r.ok, d: d }; });
        });
      }

      p.then(function () {
        setStaffNote("ok", "✓ Check your email inbox! We've sent a sign-in link — tap it on this device to open the kitchen.");
      }).catch(function (err) {
        if (err && err.message === "no-backend") {
          setStaffNote("err", "Staff login is configured for the hosted backend. Contact the administrator to enable it on this site, or visit the kitchen directly if you have a link.");
        } else if (err && /sdk|failed to fetch|network/i.test(String(err && err.message))) {
          setStaffNote("err", "Couldn't reach the login service. Check your connection and try again.");
        } else {
          setStaffNote("err", (err && err.message) ? err.message : "That email isn't authorized for staff access.");
        }
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = DEFAULT_BTN; }
      });
    });
  }

  /* ---------------- Wire shared controls ---------------- */
  function initSharedControls() {
    var cartBtn = $("#cartBtn"); if (cartBtn) cartBtn.addEventListener("click", openDrawer);
    var fabCart = $("#fabCart"); if (fabCart) fabCart.addEventListener("click", openDrawer);
    var dc = $("#drawerClose"); if (dc) dc.addEventListener("click", closeDrawer);
    var bd = $("#drawerBackdrop"); if (bd) bd.addEventListener("click", closeDrawer);
    var cb = $("#checkoutBtn"); if (cb) cb.addEventListener("click", function () { closeDrawer(); openCheckout(); });
    var bw = $("#bulkWaBtn"); if (bw) bw.addEventListener("click", function () {
      window.open("https://wa.me/2348081988184?text=" + encodeURIComponent("Hello Cyril's Foods! I'd like to arrange a bulk order."), "_blank");
    });
    $$("[data-close-modal]").forEach(function (el) {
      el.addEventListener("click", function () { var m = el.closest(".modal"); if (m) closeModal("#" + m.id); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeDrawer(); $$(".modal.is-open").forEach(function (m) { closeModal("#" + m.id); }); }
    });
    $("#qtyMinus").addEventListener("click", function () { modalQty = Math.max(1, modalQty - 1); $("#qtyValue").textContent = modalQty; updateModalTotal(); });
    $("#qtyPlus").addEventListener("click", function () { modalQty++; $("#qtyValue").textContent = modalQty; updateModalTotal(); });
    $("#addCartBtn").addEventListener("click", addCurrentToCart);

    $("#checkoutForm").addEventListener("submit", function (e) {
      e.preventDefault();
      if (!state.open) { toast("We're closed right now. 🌙", "error"); return; }
      if (!state.checkoutAddress) { toast("Please select a delivery address from the list.", "error"); return; }
      var reference = "CFD" + Date.now() + Math.floor(Math.random() * 1000);
      var order = buildOrderPayload(reference);
      var payBtn = $("#payBtn");
      payBtn.disabled = true; payBtn.textContent = "Initialising secure payment…";
      initializeOrder(order).then(function (init) {
        order.reference = (init && init.reference) || reference;
        return payWithPaystack(order).then(function () {
          closeModal("#checkoutModal");
          $("#successRef").textContent = order.reference;
          $("#successText").textContent = "Payment of " + money(order.total) + " received. Our kitchen is on it — we'll WhatsApp " +
            order.customer.phone + " with updates shortly.";
          openModal("#successModal");
          state.cart = []; state.checkoutAddress = null;
          try { localStorage.removeItem("cyrils_addr"); } catch (er) {}
          saveCart(); renderCart(); bumpBadge();
          $("#checkoutForm").reset();
          payBtn.disabled = false; payBtn.innerHTML = 'Pay <span id="payAmount">' + money(0) + "</span>";
        });
      }).catch(function (err) {
        payBtn.disabled = false; updateCheckoutTotals();
        if (err.message === "cancelled") toast("Payment cancelled.", "info");
        else toast("Payment could not be completed. You can also order on WhatsApp.", "error");
      });
    });
    $("#successClose").addEventListener("click", function () { closeModal("#successModal"); });

    // Autocompletes
    initAutocomplete($("#coAddress"), $("#coSuggestions"), function (p) { resolveRoute(p, "checkout"); });
    initAutocomplete($("#calcAddress"), $("#calcSuggestions"), function (p) { resolveRoute(p, "estimate"); });
  }

  /* ---------------- Public API for page controllers ---------------- */
  window.CF = {
    D: D, BRAND: BRAND, CATS: CATS, MENU: MENU, FEATURED: FEATURED, money: money,
    state: state,
    isOpen: function () { return state.open; },
    cardHTML: cardHTML, mountGrid: mountGrid,
    openItem: openItem, quickAdd: quickAdd,
    cartCount: cartCount, cartSubtotal: cartSubtotal, bumpBadge: bumpBadge, renderCart: renderCart,
    setGridRenderer: function (fn) { state.gridRenderer = fn; },
    toast: toast,
    esc: esc, $: $, $$: $$,
  };

  /* ---------------- Init ---------------- */
  function init() {
    injectSharedUI();
    killHostBadges();
    loadCart();
    renderCart();
    bumpBadge();
    initNav();
    initSecretTap();
    initStaffAuth();
    initSharedControls();
    fetchKitchenStatus();
    setInterval(fetchKitchenStatus, 45 * 1000); // pick up staff closed / sold-out overrides
    initReveal();
    restoreSavedAddress();
    // Delivery-fee transparency link -> explanation modal.
    var infoLink = $("#deliveryInfoLink");
    if (infoLink) infoLink.addEventListener("click", function (e) { e.preventDefault(); openModal("#deliveryInfoModal"); });
    applyHours();

    var yearEl = $("#year"); if (yearEl) yearEl.textContent = new Date().getFullYear();

    // Home-page featured grid
    var featuredGrid = $("#featuredGrid");
    if (featuredGrid) {
      var renderFeatured = function () { mountGrid(featuredGrid, FEATURED); };
      state.gridRenderer = renderFeatured;
      renderFeatured();
    }

    // Home category rail -> menu page deep link
    var catRail = $("#catRail");
    if (catRail) {
      catRail.innerHTML = CATS.map(function (c) {
        return '<button class="cat-card" data-cat="' + c.id + '" aria-label="Browse ' + esc(c.label) + '">' +
          '<img src="' + c.img + '" alt="' + esc(c.label) + '" loading="lazy" />' +
          '<span class="cat-card__label"><span class="cat-card__emoji">' + c.emoji + "</span>" +
          '<span class="cat-card__name">' + esc(c.label) + "</span></span></button>";
      }).join("");
      catRail.addEventListener("click", function (e) {
        var card = e.target.closest(".cat-card");
        if (card) location.href = "menu.html?cat=" + encodeURIComponent(card.getAttribute("data-cat"));
      });
    }

    // Home stat counter
    var statEl = $("[data-stat]");
    if (statEl) {
      var target = parseInt(statEl.getAttribute("data-stat"), 10), cur = 0, step = Math.ceil(target / 40);
      var t = setInterval(function () { cur += step; if (cur >= target) { cur = target; clearInterval(t); } statEl.textContent = cur + "+"; }, 25);
    }

    setInterval(applyHours, 60 * 1000);
    window.addEventListener("load", function () { setTimeout(hideLoader, 600); });
    setTimeout(hideLoader, 2500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
