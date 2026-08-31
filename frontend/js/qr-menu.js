/* Customer-facing QR menu. Served at /menu/<token>. No login. */

const TOKEN = decodeURIComponent(location.pathname.replace(/^\/menu\//, "").replace(/\/+$/, ""));
const FALLBACK_IMG = "../assets/optimized/menu-reference.webp";

const state = {
  restaurant: "",
  table: null,
  categories: [],
  cart: {},            // key `${kind}:${id}` -> { id, kind, name, price, tax_rate, brand, bottle_size, qty }
  activeCat: null,
  placedRef: localStorage.getItem("qm_ref_" + TOKEN) || null,
  statusTimer: null,
};

/* ---------- helpers ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]
  ));
}
function money(n) {
  return "₹" + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function imageFor(item) {
  const name = String(item.name || "").trim().toLowerCase();
  const kind = item.kind === "alcohol" ? "alcohol" : "food";
  const corrected = kind === "food" && window.CORRECT_FOOD_IMAGE_MAP ? window.CORRECT_FOOD_IMAGE_MAP["food:" + name] : null;
  if (corrected) return corrected;
  const exact = window.MENU_IMAGE_MAP ? window.MENU_IMAGE_MAP[kind + ":" + name] : null;
  return exact || FALLBACK_IMG;
}
async function api(path, options = {}) {
  const opts = { credentials: "include", headers: { "Content-Type": "application/json" }, ...options };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const res = await fetch("/api" + path, opts);
  let json;
  try { json = await res.json(); } catch (e) { throw new Error("The server returned an unexpected response."); }
  if (!json.success) throw new Error(json.error || "Request failed");
  return json.data;
}
function toast(msg, isError) {
  const t = document.getElementById("qmToast");
  t.textContent = msg;
  t.className = "qm-toast show" + (isError ? " error" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
}
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.dataset.fb !== "1") {
    img.dataset.fb = "1";
    img.src = FALLBACK_IMG;
  }
}, true);

/* ---------- boot ---------- */
async function boot() {
  if (!TOKEN) return showMessage("Invalid link", "Please scan the QR code on your table again.");
  try {
    const data = await api("/qr/menu/" + encodeURIComponent(TOKEN));
    state.restaurant = data.restaurant;
    state.table = data.table;
    state.categories = data.categories.filter((c) => c.items.length);
    state.activeCat = state.categories[0] ? state.categories[0].category : null;
  } catch (e) {
    return showMessage("Table not found", e.message);
  }
  renderMenu();
  document.getElementById("viewCartBtn").addEventListener("click", openCart);
  document.getElementById("sheetOverlay").addEventListener("click", (e) => {
    if (e.target.id === "sheetOverlay") closeSheet();
  });
  if (state.placedRef) startStatusPolling();
}

function showMessage(title, body) {
  document.getElementById("app").innerHTML =
    `<div class="qm-message"><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`;
  document.getElementById("cartBar").classList.remove("show");
}

/* ---------- menu ---------- */
function renderMenu() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <header class="qm-header">
      <img class="qm-logo" src="../assets/brand/next-level-logo.jpeg" alt="${esc(state.restaurant)}" />
      <div class="qm-eyebrow">Scan · Order · Relax</div>
      <h1>${esc(state.restaurant)}</h1>
      <span class="qm-table">${esc(state.table.label)}</span>
    </header>
    <nav class="qm-cats" id="cats"></nav>
    <div id="sections"></div>
    ${state.placedRef ? `<div class="qm-section"><button class="qm-btn-ghost" id="trackBtn">Track my order</button></div>` : ""}`;

  document.getElementById("cats").innerHTML = state.categories.map((c) =>
    `<button class="qm-chip ${c.category === state.activeCat ? "active" : ""}" data-cat="${esc(c.category)}">${esc(c.category)}</button>`
  ).join("");
  document.querySelectorAll("#cats .qm-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      // Chips are jump links, not a filter, so just move the highlight and
      // scroll. Re-rendering the menu here discarded the smooth scroll target.
      state.activeCat = chip.dataset.cat;
      document.querySelectorAll("#cats .qm-chip").forEach((c) =>
        c.classList.toggle("active", c.dataset.cat === state.activeCat));
      const sec = document.getElementById("sec-" + cssId(state.activeCat));
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    }));

  document.getElementById("sections").innerHTML = state.categories.map(renderSection).join("");
  wireItemButtons();
  const trackBtn = document.getElementById("trackBtn");
  if (trackBtn) trackBtn.addEventListener("click", openStatus);
  updateCartBar();
  observeSections();
}

/* Keep the sticky category chips in step with what the customer is actually
   looking at. Without this the highlight only moved when a chip was tapped, so
   after any scrolling it pointed at the wrong course. */
let _sectionObserver = null;
function observeSections() {
  if (_sectionObserver) _sectionObserver.disconnect();
  if (!("IntersectionObserver" in window)) return;

  const setActive = (cat) => {
    if (!cat || cat === state.activeCat) return;
    state.activeCat = cat;
    document.querySelectorAll("#cats .qm-chip").forEach((c) => {
      const on = c.dataset.cat === cat;
      c.classList.toggle("active", on);
      // Drag the active chip back into view in the horizontal strip.
      if (on) c.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
  };

  _sectionObserver = new IntersectionObserver((entries) => {
    // Pick the visible section nearest the top of the viewport.
    const visible = entries
      .filter((e) => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) setActive(visible.target.dataset.cat);
  }, { rootMargin: "-88px 0px -65% 0px", threshold: 0 });

  document.querySelectorAll(".qm-section[data-cat]").forEach((sec) => _sectionObserver.observe(sec));
}

function cssId(s) { return String(s).replace(/[^a-z0-9]+/gi, "-").toLowerCase(); }

function renderSection(cat) {
  return `<section class="qm-section" id="sec-${cssId(cat.category)}" data-cat="${esc(cat.category)}">
    <h2>${esc(cat.category)}</h2>
    ${cat.items.map(renderItem).join("")}
  </section>`;
}

function renderItem(item) {
  const key = item.kind + ":" + item.id;
  const inCart = state.cart[key];
  const meta = [item.brand, item.bottle_size].filter(Boolean).join(" · ");
  return `<div class="qm-item">
    <img class="qm-item-img" src="${esc(imageFor(item))}" alt="${esc(item.name)}" loading="lazy" />
    <div class="qm-item-body">
      <div class="qm-item-name">${esc(item.name)}</div>
      ${meta ? `<div class="qm-item-meta">${esc(meta)}</div>` : ""}
      <div class="qm-item-price">${money(item.price)}</div>
      ${!item.available ? `<div class="qm-unavail">Currently unavailable</div>` : ""}
    </div>
    <div class="qm-item-act" data-act="${key}">${renderItemControl(item)}</div>
  </div>`;
}

/* The add / stepper control for one item. Kept separate from renderItem so a
   quantity change can repaint just this node instead of the whole menu. */
function renderItemControl(item) {
  const key = item.kind + ":" + item.id;
  const inCart = state.cart[key];
  if (!item.available) return "";
  if (!inCart) return `<button class="qm-add" data-add="${key}">Add</button>`;
  return `<div class="qm-stepper" data-key="${key}">
      <button data-step="-1" aria-label="Remove one ${esc(item.name)}">−</button>
      <span aria-live="polite">${inCart.qty}</span>
      <button data-step="1" aria-label="Add one ${esc(item.name)}">+</button>
    </div>`;
}

function findItem(key) {
  for (const cat of state.categories) {
    for (const it of cat.items) {
      if (it.kind + ":" + it.id === key) return it;
    }
  }
  return null;
}

function wireItemButtons(root = document) {
  root.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", () => { changeQty(b.dataset.add, 1); }));
  root.querySelectorAll(".qm-stepper").forEach((st) =>
    st.querySelectorAll("[data-step]").forEach((b) =>
      b.addEventListener("click", () => changeQty(st.dataset.key, Number(b.dataset.step)))));
}

function changeQty(key, delta) {
  const item = findItem(key);
  if (!item) return;
  const cur = state.cart[key];
  const qty = (cur ? cur.qty : 0) + delta;
  if (qty <= 0) {
    delete state.cart[key];
  } else if (qty > 50) {
    toast("Max 50 per item", true);
    return;
  } else {
    state.cart[key] = {
      id: item.id, kind: item.kind, name: item.name, price: item.price,
      tax_rate: item.tax_rate, brand: item.brand, bottle_size: item.bottle_size, qty,
    };
  }
  // Repaint only this item's control. Re-rendering the whole menu here made
  // every tap rebuild all sections and re-decode every image, which flickered
  // and could throw away the customer's scroll position mid-order.
  const cell = document.querySelector(`.qm-item-act[data-act="${key}"]`);
  if (cell) {
    cell.innerHTML = renderItemControl(item);
    wireItemButtons(cell);
  }
  updateCartBar();
  if (document.getElementById("sheetOverlay").classList.contains("show")) openCart();
}

/* ---------- cart totals ---------- */
function cartLines() { return Object.values(state.cart); }
function cartCount() { return cartLines().reduce((n, l) => n + l.qty, 0); }
function cartTotals() {
  let subtotal = 0, tax = 0;
  for (const l of cartLines()) {
    const line = l.price * l.qty;
    subtotal += line;
    tax += line * (Number(l.tax_rate) || 0) / 100;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  tax = Math.round(tax * 100) / 100;
  return { subtotal, tax, grand: Math.round((subtotal + tax) * 100) / 100 };
}
function updateCartBar() {
  const bar = document.getElementById("cartBar");
  const n = cartCount();
  bar.classList.toggle("show", n > 0);
  document.getElementById("cartCount").textContent = n + (n === 1 ? " item" : " items");
  document.getElementById("cartTotal").textContent = money(cartTotals().grand);
}

/* ---------- sheet: cart / review ---------- */
function openSheet(html) {
  document.getElementById("sheet").innerHTML = `<div class="qm-sheet-handle"></div>` + html;
  document.getElementById("sheetOverlay").classList.add("show");
}
function closeSheet() { document.getElementById("sheetOverlay").classList.remove("show"); }

function openCart() {
  const lines = cartLines();
  if (!lines.length) { closeSheet(); return; }
  const t = cartTotals();
  openSheet(`
    <h2>Your order · ${esc(state.table.label)}</h2>
    ${lines.map((l) => {
      const key = l.kind + ":" + l.id;
      return `<div class="qm-cart-line">
        <div>
          <div class="ql-name">${esc(l.name)}</div>
          <div class="ql-sub">${money(l.price)} each${l.brand ? " · " + esc(l.brand) : ""}</div>
        </div>
        <div class="qm-stepper" data-key="${key}">
          <button data-step="-1">−</button><span>${l.qty}</span><button data-step="1">+</button>
        </div>
        <div style="min-width:74px;text-align:right;font-weight:700">${money(l.price * l.qty)}</div>
      </div>`;
    }).join("")}
    <div class="qm-totals">
      <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
      ${t.tax ? `<div><span>Taxes</span><span>${money(t.tax)}</span></div>` : ""}
      <div class="qm-grand"><span>Grand total</span><span>${money(t.grand)}</span></div>
    </div>
    <input class="qm-field" id="custName" placeholder="Your name (optional)" maxlength="60" />
    <input class="qm-field" id="custNote" placeholder="Note for the kitchen (optional)" maxlength="280" />
    <button class="qm-btn-primary" id="placeBtn">Place order · ${money(t.grand)}</button>
    <button class="qm-btn-ghost" id="closeSheetBtn">Keep browsing</button>
  `);
  document.querySelectorAll("#sheet .qm-stepper").forEach((st) =>
    st.querySelectorAll("[data-step]").forEach((b) =>
      b.addEventListener("click", () => changeQty(st.dataset.key, Number(b.dataset.step)))));
  document.getElementById("closeSheetBtn").addEventListener("click", closeSheet);
  document.getElementById("placeBtn").addEventListener("click", placeOrder);
}

async function placeOrder() {
  const btn = document.getElementById("placeBtn");
  btn.disabled = true;
  btn.textContent = "Placing…";
  const payload = {
    token: TOKEN,
    customer_name: document.getElementById("custName").value.trim(),
    note: document.getElementById("custNote").value.trim(),
    items: cartLines().map((l) => ({ id: l.id, kind: l.kind, qty: l.qty })),
  };
  try {
    const order = await api("/qr/orders", { method: "POST", body: payload });
    state.cart = {};
    state.placedRef = order.public_ref;
    localStorage.setItem("qm_ref_" + TOKEN, order.public_ref);
    renderMenu();
    openStatus();
    startStatusPolling();
    toast("Order placed!");
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

/* ---------- order status ---------- */
const STATUS_LABELS = {
  NEW: "Order received", ACCEPTED: "Accepted", PREPARING: "Preparing",
  READY: "Ready to serve", SERVED: "Served", CANCELLED: "Cancelled",
};
const STATUS_ORDER = ["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED"];

async function openStatus() {
  openSheet(`<h2>Order status</h2><div id="statusBody">Loading…</div>
    <button class="qm-btn-ghost" id="closeSheetBtn2">Close</button>`);
  document.getElementById("closeSheetBtn2").addEventListener("click", closeSheet);
  await refreshStatus();
}

async function refreshStatus() {
  if (!state.placedRef) return;
  let order, visit;
  try {
    order = await api("/qr/orders/" + state.placedRef);
    visit = await api("/qr/tables/" + encodeURIComponent(TOKEN) + "/orders");
  } catch (e) {
    return;
  }
  const body = document.getElementById("statusBody");
  if (!body) return;

  const cancelled = order.status === "CANCELLED";
  const curIdx = STATUS_ORDER.indexOf(order.status);
  const steps = STATUS_ORDER.map((s, i) => {
    const cls = cancelled ? "" : (i < curIdx ? "done" : i === curIdx ? "current" : "");
    const mark = (!cancelled && i < curIdx) ? "✓" : (!cancelled && i === curIdx ? "●" : "○");
    return `<li class="${cls}"><span class="dot">${mark}</span>${STATUS_LABELS[s]}</li>`;
  }).join("");

  const others = (visit.orders || []).filter((o) => o.public_ref !== order.public_ref);
  body.innerHTML = `
    <p style="margin:.2rem 0 0;color:var(--qm-muted)">${esc(order.table_label)} · ${esc(order.order_no)}</p>
    <h2 style="margin:.4rem 0 0">${cancelled ? "Order cancelled" : "Order confirmed ✓"}</h2>
    <ul class="qm-track">${steps}</ul>
    <div class="qm-totals">
      ${order.items.map((it) => `<div><span>${esc(it.item_name)} × ${it.qty}</span><span>${money(it.line_total)}</span></div>`).join("")}
      <div class="qm-grand"><span>Total</span><span>${money(order.grand_total)}</span></div>
    </div>
    ${others.length ? `<h2 style="font-size:1rem;margin-top:18px">Earlier this visit</h2>
      ${others.map((o) => `<div class="qm-visit-order">
        <div class="vo-head"><span>${esc(o.order_no)}</span><span>${esc(o.status)}</span></div>
        <div class="vo-body">${o.items.map((it) => esc(it.item_name) + " × " + it.qty).join(", ")} — ${money(o.grand_total)}</div>
      </div>`).join("")}` : ""}
    <button class="qm-btn-primary" id="newOrderBtn">Order more items</button>`;
  document.getElementById("newOrderBtn").addEventListener("click", () => {
    closeSheet();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  if (order.status === "SERVED" || cancelled) stopStatusPolling();
}

function startStatusPolling() {
  stopStatusPolling();
  state.statusTimer = setInterval(refreshStatus, 8000);
}
function stopStatusPolling() {
  if (state.statusTimer) clearInterval(state.statusTimer);
  state.statusTimer = null;
}

boot();
