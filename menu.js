/* =============================================================
   CYRIL'S FOODS — MENU PAGE CONTROLLER (menu.js)
   Drives menu.html: category filters, live search, deep-linked
   category (?cat=), and the food loading transition.
   Depends on the shared core (app.js -> window.CF) + catalog.js.
   ============================================================= */
(function () {
  "use strict";

  function initMenuPage() {
    var CF = window.CF;
    if (!CF) return;
    var MENU = CF.MENU, CATS = CF.CATS, $ = CF.$, $$ = CF.$$, esc = CF.esc, money = CF.money;

    var grid = $("#menuGrid");
    var chipsWrap = $("#filterChips");
    var search = $("#menuSearch");
    var emptyEl = $("#menuEmpty");

    var params = new URLSearchParams(location.search);
    var state = { filter: CATS.some(function (c) { return c.id === params.get("cat"); }) ? params.get("cat") : "ALL", q: "" };

    /* Build filter chips with live counts */
    function counts() {
      var out = { ALL: MENU.length };
      CATS.forEach(function (c) { out[c.id] = MENU.filter(function (m) { return m.category === c.id; }).length; });
      return out;
    }
    function renderChips() {
      var c = counts();
      var chips = ['<button class="chip' + (state.filter === "ALL" ? " is-active" : "") + '" data-cat="ALL">All<span class="chip__count">' + c.ALL + "</span></button>"]
        .concat(CATS.map(function (cat) {
          return '<button class="chip' + (state.filter === cat.id ? " is-active" : "") + '" data-cat="' + cat.id + '">' +
            cat.emoji + " " + esc(cat.label) + '<span class="chip__count">' + c[cat.id] + "</span></button>";
        }));
      chipsWrap.innerHTML = chips.join("");
    }

    function applyFilter() {
      var list = MENU;
      if (state.filter !== "ALL") list = list.filter(function (m) { return m.category === state.filter; });
      if (state.q) {
        var q = state.q.toLowerCase();
        list = list.filter(function (m) { return m.name.toLowerCase().indexOf(q) > -1; });
      }
      // Mount via shared engine (handles closed-hours OOS state + card wiring).
      CF.mountGrid(grid, list);
      if (emptyEl) emptyEl.hidden = list.length > 0;
    }

    /* Register with the hours engine so closed/open re-renders the grid. */
    CF.setGridRenderer(applyFilter);

    /* Events */
    chipsWrap.addEventListener("click", function (e) {
      var chip = e.target.closest(".chip");
      if (!chip) return;
      state.filter = chip.getAttribute("data-cat");
      $$(".chip", chipsWrap).forEach(function (x) { x.classList.toggle("is-active", x === chip); });
      applyFilter();
    });
    search.addEventListener("input", function (e) { state.q = e.target.value.trim(); applyFilter(); });

    /* Food-themed loading transition for the menu page. */
    function menuLoadingTransition() {
      var l = $("#loader");
      if (!l) return;
      l.style.transition = "opacity .55s cubic-bezier(.22,1,.36,1), visibility .55s, transform .55s";
      l.style.transform = "translateY(0)";
      requestAnimationFrame(function () {
        setTimeout(function () {
          l.style.opacity = "0"; l.style.transform = "translateY(-100%)";
          l.style.visibility = "hidden";
          setTimeout(function () { l.remove(); }, 650);
        }, 450);
      });
    }

    /* Boot */
    renderChips();
    applyFilter();

    // If deep-linked to a category, scroll the active chip into view.
    if (state.filter !== "ALL") {
      var active = $('.chip.is-active', chipsWrap);
      if (active && active.scrollIntoView) active.scrollIntoView({ inline: "center", block: "nearest" });
    }

    window.addEventListener("load", menuLoadingTransition);
    setTimeout(menuLoadingTransition, 2200); // safety
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initMenuPage);
  else initMenuPage();
})();
