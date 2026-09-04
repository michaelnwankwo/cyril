/* =============================================================
   CYRIL'S FOODS — SHARED MENU CATALOG
   Scraped & refined from https://www.cyrilsfood.com.ng/
   Works in both the browser (window.CYRIL) and Node (module.exports).
   All prices in Nigerian Naira (₦).
   ============================================================= */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CYRIL = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- Brand constants ---------- */
  const BRAND = {
    name: "Cyril's Foods",
    tagline: "Best Food In Town",
    email: "cyrilsfood@gmail.com",
    whatsapp: "2348081988184",          // E.164, used for wa.me
    whatsappDisplay: "0808 198 8184",
    bulk: "0805 354 0206",
    socialHandle: "@Cyrilsfoods",
    // Fixed restaurant origin (Lagos). Override with REST_LAT / REST_LNG env on server.
    originLat: 6.5244,
    originLng: 3.3792,
    // Delivery economics
    ratePerKm: 1100,                     // ₦1,100 per driving km
    baseFee: 0,
    minOrderForDelivery: 0,
    // Trading window (WAT, UTC+1) — 9:00 AM to 7:00 PM
    openHour: 9,
    closeHour: 19,
    tz: "Africa/Lagos",
    marketing: {
      headline: "Easter Jollof is Calling!",
      sub: "No Easter is complete without a loaded plate.",
      cta: "From Party Jollof to the best Swallow, let's feed your celebration today!",
    },
  };

  /* ---------- Category metadata (with AI-generated category art) ---------- */
  const CATEGORIES = [
    { id: "FOOD",      label: "Rice & Meals", emoji: "🍛", img: "assets/cat-food.jpg",     blurb: "Party jollof, fried rice, ofada & hearty local staples." },
    { id: "PROTEIN",   label: "Protein",      emoji: "🍗", img: "assets/cat-protein.jpg",  blurb: "Grilled & peppered chicken, turkey, fish, goat meat & more." },
    { id: "SOUP",      label: "Soup",         emoji: "🍲", img: "assets/cat-soup.jpg",     blurb: "Egusi, efo riro, afang, edikaikong & rich banga." },
    { id: "SWALLOW",   label: "Swallow",      emoji: "🥘", img: "assets/cat-swallow.jpg",  blurb: "Pounded yam, eba, amala, semo & starch." },
    { id: "SIDE",      label: "Sides",        emoji: "🍌", img: "assets/cat-side.jpg",     blurb: "Moi moi, fried plantain & fresh macaroni salad." },
    { id: "DRINK",     label: "Drinks",       emoji: "🥤", img: "assets/cat-drink.jpg",    blurb: "Fresh smoothies, zobo, glow drink, juices & chillers." },
    { id: "PASTRY",    label: "Pastries",     emoji: "🥟", img: "assets/cat-pastry.jpg",   blurb: "Meat pie, chicken pie, sausage rolls & doughnuts." },
    { id: "ICE CREAM", label: "Ice Cream",    emoji: "🍨", img: "assets/cat-icecream.jpg", blurb: "Premium ice cream tubs, cups & fantasy bars." },
    { id: "PACK",      label: "Packs",        emoji: "🥡", img: "assets/cat-pack.jpg",     blurb: "Take-away plates & packs for events and bulk orders." },
  ];

  /* ---------- Reusable modifier groups ---------- */
  // Protein add-on group attached to rice / combo meals (per the spec example).
  const PROTEIN_MOD = {
    name: "Choose Protein",
    required: true,
    allowMultiple: false,
    options: [
      { label: "Fried Fish",        price: 0 },
      { label: "Beef",              price: 0 },
      { label: "Boiled Egg",        price: 0 },
      { label: "Grilled Chicken",   price: 1000 },
      { label: "Peppered Gizzard",  price: 1400 },
    ],
  };
  const PLANTAIN_MOD = {
    name: "Extras",
    required: false,
    allowMultiple: true,
    options: [
      { label: "Extra Fried Plantain", price: 720 },
      { label: "Extra Moi Moi",        price: 1440 },
      { label: "Side Salad",           price: 1200 },
    ],
  };

  /* ---------- Signature combos (curated, with full modifiers) ---------- */
  const COMBOS = [
    {
      id: "combo-jollof",
      name: "Party Jollof Combo",
      category: "FOOD",
      price: 1500,
      image: "assets/cat-food.jpg",
      popular: true,
      desc: "Smoky party-style jollof rice loaded with a protein of your choice, fried plantain and a cool drink option. Festive, generous and unforgettable.",
      modifiers: [
        PROTEIN_MOD,
        {
          name: "Add a Drink", required: false, allowMultiple: false,
          options: [
            { label: "No drink", price: 0 },
            { label: "Bottled Soft Drink", price: 840 },
            { label: "Cyril's Zobo", price: 3000 },
          ],
        },
        PLANTAIN_MOD,
      ],
    },
    {
      id: "combo-fried-rice",
      name: "Special Fried Rice Combo",
      category: "FOOD",
      price: 1800,
      image: "assets/cat-food.jpg",
      popular: true,
      desc: "Veggie-packed special fried rice with your pick of protein, golden plantain and an optional chilled drink.",
      modifiers: [PROTEIN_MOD, PLANTAIN_MOD],
    },
    {
      id: "combo-ofada",
      name: "Ofada Deluxe Combo",
      category: "FOOD",
      price: 2200,
      image: "assets/cat-food.jpg",
      desc: "Locally-fermented ofada rice served with rich ayamase-style ofada sauce and a hearty protein. A true local favourite.",
      modifiers: [
        {
          name: "Choose Protein", required: true, allowMultiple: false,
          options: [
            { label: "Assorted Meat", price: 0 },
            { label: "Beef", price: 0 },
            { label: "Grilled Chicken", price: 1000 },
            { label: "Goat Meat", price: 2000 },
          ],
        },
        PLANTAIN_MOD,
      ],
    },
    {
      id: "combo-swallow",
      name: "Swallow & Soup Combo",
      category: "SWALLOW",
      price: 2000,
      image: "assets/cat-swallow.jpg",
      popular: true,
      desc: "Freshly made swallow with a big bowl of rich Nigerian soup and assorted meat or fish. Comfort in every wrap.",
      modifiers: [
        {
          name: "Pick Your Swallow", required: true, allowMultiple: false,
          options: [
            { label: "Pounded Yam", price: 0 },
            { label: "Eba", price: 0 },
            { label: "Amala", price: 0 },
            { label: "Semo", price: 0 },
          ],
        },
        {
          name: "Pick Your Soup", required: true, allowMultiple: false,
          options: [
            { label: "Egusi", price: 0 },
            { label: "Efo Riro", price: 0 },
            { label: "Edikaikong", price: 300 },
            { label: "Afang", price: 400 },
          ],
        },
        {
          name: "Protein", required: true, allowMultiple: false,
          options: [
            { label: "Assorted Meat", price: 0 },
            { label: "Beef", price: 0 },
            { label: "Goat Meat", price: 2000 },
            { label: "Fried Fish", price: 1500 },
          ],
        },
      ],
    },
  ];

  /* ---------- Full a-la-carte catalog (scraped live from cyrilsfood.com.ng) ---------- */
  const RAW = [
    // FOOD
    ["FOOD","Cyril's Fried Rice-FG",840],["FOOD","Cyril's Jollof Rice-FG",840],
    ["FOOD","Special Fried Rice",1200],["FOOD","Yam Pottage",840],["FOOD","Boiled Yam",840],
    ["FOOD","Jollof Spaghetti",960],["FOOD","Pottage Beans",720],["FOOD","Plain Beans",600],
    ["FOOD","Native Jollof Rice",900],["FOOD","Coconut Rice",900],["FOOD","Asun Rice",1680],
    ["FOOD","Ofada Rice",840],["FOOD","Special Jollof Rice",900],["FOOD","Basmati Fried Rice",1200],
    ["FOOD","Basmati Jollof Rice",960],["FOOD","Native Rice",900],["FOOD","White Rice",600],
    ["FOOD","Cyril's Spaghetti",960],["FOOD","Wanke",840],["FOOD","Yamarita",600],
    ["FOOD","Small Boiled Yam",600],["FOOD","Big Boiled Yam",1200],["FOOD","Plain Spaghetti",600],
    // PROTEIN
    ["PROTEIN","Fried Pepper Chicken (Big)",4800],["PROTEIN","Beef",1080],["PROTEIN","Ponmo",600],
    ["PROTEIN","Boiled Egg",480],["PROTEIN","Assorted Meat",1080],["PROTEIN","Grilled Chicken (Big)",4800],
    ["PROTEIN","Grilled Turkey",7200],["PROTEIN","Egg Sauce",1440],["PROTEIN","Bokoto",3000],
    ["PROTEIN","Asun",3600],["PROTEIN","Grilled Chicken (Small)",4200],["PROTEIN","Hake Fish",4200],
    ["PROTEIN","Owere Fish",3600],["PROTEIN","Titus Fish",4800],["PROTEIN","Goat Meat",4200],
    ["PROTEIN","Peppered Gizzard",2400],["PROTEIN","Pepper Turkey (Big)",7200],["PROTEIN","Pepper Turkey (Small)",4800],
    ["PROTEIN","Titus Fish (Small)",3600],["PROTEIN","Medium Turkey",6600],["PROTEIN","Medium Chicken",3600],
    ["PROTEIN","Chicken (Small)",2400],["PROTEIN","Bokoto (Small)",2400],["PROTEIN","Fish Sauce",1200],
    ["PROTEIN","Hake Fish (Small)",4200],["PROTEIN","Gizzard (Small)",1800],["PROTEIN","Owere (Big)",4200],
    ["PROTEIN","Drum Stick",1800],["PROTEIN","Drum Stick (Big)",2400],["PROTEIN","Gizz Dodo",1020],
    // SOUP
    ["SOUP","Ofada Sauce",1800],["SOUP","Efo Riro",1200],["SOUP","Egusi",1200],["SOUP","Okro Soup",1200],
    ["SOUP","Ugu Sauce",1440],["SOUP","Edikaikong",1560],["SOUP","Afang",1800],
    ["SOUP","Banga Soup (with Fish)",4200],["SOUP","Banga (No Fish)",1200],
    // SWALLOW
    ["SWALLOW","Eba",360],["SWALLOW","Semo",360],["SWALLOW","Pounded Yam",600],
    ["SWALLOW","Amala",600],["SWALLOW","Starch",600],
    // SIDE
    ["SIDE","Cyril's Macaroni Salad",1200],["SIDE","Moi Moi",1440],["SIDE","Fried Plantain",720],
    // DRINK (softs & water)
    ["DRINK","Coke",840],["DRINK","Can Coke",960],["DRINK","Pepsi",720],["DRINK","Fanta",840],
    ["DRINK","Can Fanta",960],["DRINK","Sprite",840],["DRINK","Can Sprite",960],
    ["DRINK","Malt Guinness (Bottle)",1440],["DRINK","Malt Guinness (Can)",1200],
    ["DRINK","Schweppes (Can)",960],["DRINK","Schweppes (Plastic)",840],["DRINK","La Casera",600],
    ["DRINK","Amstel Malt",1200],["DRINK","Monster Energy",1440],["DRINK","Predator Energy",1200],
    ["DRINK","Water",360],["DRINK","Eva Water",480],
    // DRINK (Cyril's fresh bar)
    ["DRINK","Cyril's Parfait",5400],["DRINK","Cyril's Tigernut Drink",3600],
    ["DRINK","Cyril's Sweetened Yogurt",3600],["DRINK","Cyril's Protein Shake",4200],
    ["DRINK","Watermelon, Pineapple & Beetroot Juice",3600],["DRINK","Cyril's Smoothie",4200],
    ["DRINK","Orange Fruit Mix",3000],["DRINK","Fruity Zobo Drink",3000],["DRINK","Glow Drink",3600],
    ["DRINK","Parfait Pineapple Squash",3000],["DRINK","Chivita Exotic",3000],["DRINK","Chivita 100%",4200],
    ["DRINK","Chivita Active",3240],["DRINK","Chivita Active (Small)",1560],["DRINK","Chivita Exotic (Small)",1440],
    ["DRINK","Stute Juice",10200],["DRINK","Vita Milk Choco",3000],
    ["DRINK","Zayith Yogurt Vanilla (500ml)",6000],["DRINK","Zayith Yogurt Strawberry (500ml)",6000],
    ["DRINK","Zayith Yogurt Mango (500ml)",6000],["DRINK","Zayith Yogurt Mixed Berry (500ml)",6000],
    ["DRINK","Zayith Yogurt Vanilla (250ml)",3360],["DRINK","Zayith Yogurt Strawberry (250ml)",3360],
    ["DRINK","Zayith Yogurt Mango (250ml)",3360],["DRINK","Zayith Yogurt Mixed Berry (250ml)",3360],
    // PASTRY
    ["PASTRY","Meat Pie",1440],["PASTRY","Chicken Pie",1680],["PASTRY","Doughnut",840],
    ["PASTRY","Sausage Roll",840],["PASTRY","Hot Dog",1440],["PASTRY","Cyril's Special",1440],
    ["PASTRY","Milky Doughnut",1200],
    // ICE CREAM
    ["ICE CREAM","Vanilla / Strawberry (900ml)",5280],["ICE CREAM","Vanilla / Chocolate (450ml)",3240],
    ["ICE CREAM","Ice-Cream Banana (250ml)",1680],["ICE CREAM","Sachet Ice-Cream (150ml)",900],
    ["ICE CREAM","Ice-Cream Cup (120ml)",1200],["ICE CREAM","Fantasy Vanilla (70g)",2040],
    ["ICE CREAM","Fantasy Strawberry (70g)",2040],["ICE CREAM","Fantasy Peanut (80g)",2160],
    ["ICE CREAM","Fantasy Salted Caramel",3600],["ICE CREAM","Fantasy Chocolate (70g)",2040],
    ["ICE CREAM","Vanilla Ice-Cream (250ml)",2400],["ICE CREAM","Strawberry Ice-Cream (250ml)",2400],
    ["ICE CREAM","Chocolate Ice-Cream (250ml)",2400],
    // PACK
    ["PACK","Big Takeaway Pack",480],["PACK","Small Takeaway Pack",360],
    ["PACK","Salad Plate",240],["PACK","2.4L Take-Away Pack",1800],
  ];

  /* ---------- Helpers to enrich a-la-carte items ---------- */
  const DESC = {
    FOOD: "Freshly cooked in small batches and served hot — Cyril's kitchen style.",
    PROTEIN: "Generously portioned, well-spiced and cooked to order. Pairs perfectly with any meal.",
    SOUP: "Rich, deep-flavoured Nigerian soup made fresh daily with quality ingredients.",
    SWALLOW: "Soft, smooth swallow made fresh — the perfect partner for any soup.",
    SIDE: "The little extras that make a Cyril's plate complete.",
    DRINK: "Chilled and refreshing. Our fresh juices & smoothies are made in-house.",
    PASTRY: "Freshly baked, golden and satisfying — great on the go.",
    "ICE CREAM": "Creamy, premium ice cream in tubs, cups and hand-held bars.",
    PACK: "Sturdy take-away packs and plates for bulk orders and events.",
  };
  // Attach protein/extras modifiers to rice meals so guests can build a plate.
  const RICE_MEAL_RE = /rice|spaghetti|ofada|jollof|beans|yam|wanke|yamarita/i;

  const MENU = RAW.map(function (r, i) {
    const cat = r[0], name = r[1], price = r[2];
    const item = {
      id: "itm-" + (i + 1),
      name: name,
      category: cat,
      price: price,
      image: catImage(cat),
      desc: DESC[cat],
      popular: /Cyril's (Jollof|Fried Rice)|Asun|Special Jollof/i.test(name),
      modifiers: [],
    };
    if (cat === "FOOD" && RICE_MEAL_RE.test(name)) {
      item.modifiers = [PROTEIN_MOD, PLANTAIN_MOD];
    }
    return item;
  });

  // Signature combos are listed first within their category.
  const ALL_ITEMS = COMBOS.concat(MENU);

  function catImage(cat) {
    const c = CATEGORIES.find(function (x) { return x.id === cat; });
    return c ? c.img : "assets/cat-food.jpg";
  }

  function money(n) {
    return "₦" + Number(n).toLocaleString("en-NG");
  }

  return {
    BRAND: BRAND,
    CATEGORIES: CATEGORIES,
    COMBOS: COMBOS,
    MENU: ALL_ITEMS,
    money: money,
  };
});
