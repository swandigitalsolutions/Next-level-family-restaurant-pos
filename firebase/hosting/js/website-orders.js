/* Website Orders — POS board. Realtime via a Firestore listener; every mutation
   goes through a Cloud Function (apiFetch shim). Shows the full ordered items,
   total, advance paid and remaining balance. Add Items uses current catalog
   prices; Settle Bill reuses the existing POS billing/stock machinery.

   Money on the doc is integer PAISE — the board formats ₹ from *_paise.
   `ref` (WEB-000123) is the permanent human Order ID. An order only reaches the
   board once Razorpay has verified the 50% advance (status CONFIRMED). */
import { db } from "./firebase-init.js";
import {
  collection, query, orderBy, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const NEXT = { CONFIRMED: "PREPARING", PREPARING: "READY" };
const TERMINAL = ["COMPLETED", "CANCELLED", "PAYMENT_FAILED"];
const MODIFIABLE = ["CONFIRMED", "PREPARING", "READY"];

let ORDERS = [];          // live board (recent, from the listener)
let SEARCH_HITS = null;    // one-shot exact Order-ID lookup result, or null
let MENU = [];
let addTarget = null;
let addCart = [];
let searchTimer = null;

const rupees = (paise) => formatMoney((Number(paise) || 0) / 100);

(async function boot() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("website-orders", user);

  loadSoundBtn();
  document.getElementById("soundToggle").addEventListener("click", toggleSound);
  document.getElementById("statusFilter").addEventListener("change", render);
  document.getElementById("searchBox").addEventListener("input", onSearch);
  document.getElementById("addModalClose").addEventListener("click", closeAdd);
  document.getElementById("addCancel").addEventListener("click", closeAdd);
  document.getElementById("addModal").addEventListener("click", (e) => { if (e.target.id === "addModal") closeAdd(); });
  document.getElementById("addSearch").addEventListener("input", renderPicker);
  document.getElementById("addConfirm").addEventListener("click", confirmAdd);

  try {
    const [food, alcohol] = await Promise.all([apiFetch("/food/items"), apiFetch("/alcohol/items")]);
    MENU = [...food.map((i) => ({ ...i, kind: "food" })), ...alcohol.map((i) => ({ ...i, kind: "alcohol" }))];
  } catch (e) { /* picker just stays empty */ }

  onSnapshot(query(collection(db, "websiteOrders"), orderBy("createdAt", "desc")), (snap) => {
    ORDERS = snap.docs.map((d) => rowOf(d.id, d.data()));
    render();
  });
})();

function rowOf(id, d) {
  const iso = (v) => (v && v.toDate ? v.toDate() : v instanceof Date ? v : null);
  return {
    id,
    ref: d.ref,
    status: d.status,
    payment_status: d.paymentStatus,
    customer_name: d.customer?.name || "",
    customer_phone: d.customer?.phone || "",
    customer_email: d.customer?.email || "",
    fulfillment_type: d.fulfillment?.type || "pickup",
    pickup_at: iso(d.fulfillment?.pickupAt),
    notes: d.fulfillment?.notes || "",
    items: (d.items || []).map((it) => ({
      item_name: it.name, kind: it.kind, brand: it.brand || "", bottle_size: it.bottleSize || "",
      unit_price_paise: Number(it.unitPricePaise) || 0, qty: Number(it.qty) || 0,
      tax_rate: Number(it.taxRatePct) || 0, line_total_paise: Number(it.lineTotalPaise) || 0,
    })),
    subtotal_paise: Number(d.subtotalPaise) || 0,
    tax_paise: Number(d.taxPaise) || 0,
    total_paise: Number(d.totalPaise) || 0,
    advance_paise: Number(d.advancePaise) || 0,
    balance_paise: Number(d.balancePaise) || 0,
    paid_paise: Number(d.paidPaise) || 0,
    settled_bill_nos: d.settledBillNos || [],
    bill_status: (d.settledBillNos || []).length ? "billed" : "unbilled",
    kitchen_ticket_id: d.kitchenTicketId || null,
    kitchen_status: d.kitchenStatus || null,
    created_at: iso(d.createdAt),
  };
}

function onSearch() {
  clearTimeout(searchTimer);
  const raw = document.getElementById("searchBox").value.trim();
  if (!raw) { SEARCH_HITS = null; render(); return; }
  searchTimer = setTimeout(async () => {
    if (/^web-?\d+/i.test(raw)) {
      // exact human Order-ID lookup — the primary reference staff use
      try {
        const { orders } = await apiFetch(`/website-orders?order_no=${encodeURIComponent(raw)}`);
        SEARCH_HITS = orders || [];
      } catch (e) { SEARCH_HITS = []; showToast(e.message, true); }
    } else {
      const q = raw.toLowerCase();
      SEARCH_HITS = ORDERS.filter((o) => `${o.ref} ${o.customer_name} ${o.customer_phone} ${o.customer_email}`.toLowerCase().includes(q));
    }
    render();
  }, 250);
}

function paymentPill(ps) {
  const map = {
    ADVANCE_PAID: "#e6f6ea;color:#1c6b34", UNPAID: "#eef;color:#334",
    FAILED: "#fdeaea;color:#a11", REFUNDED: "#f3e8ff;color:#6b21a8",
  };
  return `<span class="oc-status-pill" style="background:${map[ps] || "#eef;color:#334"};">${escapeHtml(String(ps || "").replace(/_/g, " "))}</span>`;
}

function render() {
  const board = document.getElementById("ordersBoard");
  const filter = document.getElementById("statusFilter").value;
  let list;
  if (SEARCH_HITS !== null) {
    list = SEARCH_HITS.map((o) => (o.ref ? shimToRow(o) : o)); // search hits come from the shim
  } else {
    list = ORDERS;
    if (filter === "active") list = list.filter((o) => MODIFIABLE.includes(o.status));
    else if (filter) list = list.filter((o) => o.status === filter);
    else list = list.filter((o) => o.status !== "PENDING_PAYMENT"); // "All recent" still hides unpaid drafts
  }
  document.getElementById("ordersEmpty").style.display = list.length ? "none" : "block";
  document.getElementById("ordersEmpty").textContent =
    SEARCH_HITS !== null && !list.length ? "No website order matches that search" : "No website orders yet";

  board.innerHTML = list.map((o) => {
    const advance = NEXT[o.status];
    const canModify = MODIFIABLE.includes(o.status);
    const lines = o.items.map((it) => `
      <li><span>${escapeHtml(it.item_name)}${it.brand ? " · " + escapeHtml(it.brand) : ""} × ${it.qty}</span>
          <span>${rupees(it.line_total_paise)}</span></li>`).join("");
    const billed = (o.settled_bill_nos || []).length
      ? `<div class="oc-sub"><strong>Billed:</strong> ${o.settled_bill_nos.map(escapeHtml).join(", ")}</div>` : "";
    return `
      <div class="order-card" data-status="${o.status}">
        <div class="oc-head">
          <span class="oc-no" style="font-size:1.05rem;font-weight:800;">${escapeHtml(o.ref)}</span>
          <span class="oc-table">${escapeHtml(o.customer_name || "Website customer")}</span>
        </div>
        <span class="oc-status-pill">${escapeHtml(o.status.replace(/_/g, " "))}</span>
        ${paymentPill(o.payment_status)}
        <span class="oc-status-pill" style="background:${o.bill_status === "billed" ? "#e6f6ea;color:#1c6b34" : "#fdeee6;color:#8a4b1c"};">${o.bill_status}</span>
        <div class="oc-sub">${escapeHtml(o.fulfillment_type || "pickup")}${o.customer_phone && o.customer_phone !== "-" ? " · " + escapeHtml(o.customer_phone) : ""}${o.customer_email ? " · " + escapeHtml(o.customer_email) : ""}</div>
        ${o.pickup_at ? `<div class="oc-sub">Pickup: ${escapeHtml(new Date(o.pickup_at).toLocaleString())}</div>` : ""}
        ${billed}
        <ul class="oc-lines">${lines}</ul>
        <div class="oc-lines">
          <li><span>Subtotal</span><span>${rupees(o.subtotal_paise)}</span></li>
          ${o.tax_paise ? `<li><span>Tax</span><span>${rupees(o.tax_paise)}</span></li>` : ""}
          <li><span><strong>Total</strong></span><span><strong>${rupees(o.total_paise)}</strong></span></li>
          <li><span>Advance paid</span><span>${rupees(o.paid_paise || o.advance_paise)}</span></li>
          <li><span><strong>Balance due</strong></span><span><strong>${rupees(o.balance_paise)}</strong></span></li>
        </div>
        ${o.notes ? `<div class="oc-note">Note: ${escapeHtml(o.notes)}</div>` : ""}
        <div class="oc-actions">
          ${advance ? `<button class="btn btn-primary btn-sm" data-advance="${o.id}" data-to="${advance}">Mark ${advance}</button>` : ""}
          ${canModify && !o.kitchen_ticket_id ? `<button class="btn btn-outline btn-sm" data-accept="${o.id}">Accept → Kitchen</button>` : ""}
          ${o.kitchen_ticket_id ? `<span class="oc-status-pill" style="background:#e6f6ea;color:#1c6b34;">kitchen: ${escapeHtml((o.kitchen_status || "queued").toLowerCase())}</span>` : ""}
          ${canModify ? `<button class="btn btn-outline btn-sm" data-add="${o.id}">Add items</button>` : ""}
          ${canModify ? `<button class="btn btn-primary btn-sm" data-settle="${o.id}">Settle Bill</button>` : ""}
          ${canModify ? `<button class="btn btn-outline btn-sm" data-cancel="${o.id}">Cancel</button>` : ""}
        </div>
      </div>`;
  }).join("");

  board.querySelectorAll("[data-advance]").forEach((b) =>
    b.addEventListener("click", () => setStatus(b.dataset.advance, b.dataset.to)));
  board.querySelectorAll("[data-cancel]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (await confirmAction({ title: "Cancel this website order?", body: "The kitchen will stop seeing it. Any advance refund is handled outside the POS.", confirmLabel: "Cancel order", cancelLabel: "Keep", danger: true })) {
        setStatus(b.dataset.cancel, "CANCELLED");
      }
    }));
  board.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => openAdd(b.dataset.add)));
  board.querySelectorAll("[data-settle]").forEach((b) => b.addEventListener("click", () => settle(b.dataset.settle)));
  board.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", async () => {
    try { await apiFetch(`/website-orders/${b.dataset.accept}/accept`, { method: "POST" }); showToast("Sent to the kitchen screen"); }
    catch (e) { showToast(e.message, true); }
  }));
}

/** Normalise a shim `/website-orders` row (already snake_case + *_paise) to the board row. */
function shimToRow(o) {
  return {
    id: o.id, ref: o.ref, status: o.status, payment_status: o.payment_status,
    customer_name: o.customer_name || o.customer?.name || "",
    customer_phone: o.customer_phone || o.customer?.phone || "",
    customer_email: o.customer_email || o.customer?.email || "",
    fulfillment_type: o.fulfillment?.type || "pickup",
    pickup_at: o.fulfillment?.pickup_at || null,
    notes: o.fulfillment?.notes || "",
    items: (o.items || []).map((it) => ({
      item_name: it.item_name, kind: it.kind, brand: it.brand || "", bottle_size: it.bottle_size || "",
      unit_price_paise: Number(it.unit_price_paise) || 0, qty: Number(it.qty) || 0,
      tax_rate: Number(it.tax_rate) || 0, line_total_paise: Number(it.line_total_paise) || 0,
    })),
    subtotal_paise: Number(o.subtotal_paise) || 0, tax_paise: Number(o.tax_paise) || 0,
    total_paise: Number(o.total_paise) || 0, advance_paise: Number(o.advance_paise) || 0,
    balance_paise: Number(o.balance_paise) || 0, paid_paise: Number(o.paid_paise) || 0,
    settled_bill_nos: o.settled_bill_nos || [], bill_status: o.bill_status || "unbilled",
    created_at: o.created_at || null,
  };
}

async function setStatus(id, status) {
  try {
    await apiFetch(`/website-orders/${id}/status`, { method: "POST", body: { status } });
  } catch (e) { showToast(e.message, true); }
}

/* ---------- Add Items ---------- */
function openAdd(id) {
  addTarget = ORDERS.find((o) => o.id === id);
  addCart = [];
  document.getElementById("addModalTitle").textContent = `Add items · ${addTarget.ref}`;
  document.getElementById("addSearch").value = "";
  renderPicker();
  renderAddCart();
  document.getElementById("addModal").classList.add("show");
}
function closeAdd() { document.getElementById("addModal").classList.remove("show"); addTarget = null; }
function renderPicker() {
  const q = (document.getElementById("addSearch").value || "").toLowerCase().trim();
  const rows = MENU.filter((i) => i.status === "active" && (!q || (i.name + " " + (i.category_name || "")).toLowerCase().includes(q))).slice(0, 60);
  document.getElementById("addPicker").innerHTML = rows.map((i) => {
    const soldOut = i.stock_qty !== null && i.stock_qty !== undefined && Number(i.stock_qty) <= 0;
    return `<button class="add-pick ${soldOut ? "is-out" : ""}" data-id="${i.id}" data-kind="${i.kind}" ${soldOut ? "disabled" : ""}>
      <span>${escapeHtml(i.name)}</span><span>${formatMoney(i.price)}${soldOut ? " · sold out" : ""}</span></button>`;
  }).join("") || `<div class="empty-state">No matches</div>`;
  document.getElementById("addPicker").querySelectorAll(".add-pick:not([disabled])").forEach((b) =>
    b.addEventListener("click", () => {
      const ex = addCart.find((c) => c.id === b.dataset.id);
      if (ex) ex.qty += 1; else addCart.push({ id: b.dataset.id, kind: b.dataset.kind, name: b.querySelector("span").textContent, qty: 1 });
      renderAddCart();
    }));
}
function renderAddCart() {
  document.getElementById("addCart").innerHTML = addCart.length
    ? addCart.map((c, idx) => `<div class="add-cart-row"><span>${escapeHtml(c.name)}</span>
        <span class="qty-ctrl"><button data-dec="${idx}">−</button><span>${c.qty}</span><button data-inc="${idx}">+</button></span>
        <span class="c-remove" data-rm="${idx}">&times;</span></div>`).join("")
    : `<div class="empty-state">Pick items above</div>`;
  const el = document.getElementById("addCart");
  el.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => { addCart[b.dataset.inc].qty += 1; renderAddCart(); }));
  el.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => { const i = b.dataset.dec; addCart[i].qty -= 1; if (addCart[i].qty <= 0) addCart.splice(i, 1); renderAddCart(); }));
  el.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { addCart.splice(b.dataset.rm, 1); renderAddCart(); }));
  document.getElementById("addConfirm").disabled = addCart.length === 0;
}
async function confirmAdd() {
  if (!addTarget || !addCart.length) return;
  const btn = document.getElementById("addConfirm");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    await apiFetch(`/website-orders/${addTarget.id}/add-items`, {
      method: "POST",
      body: { items: addCart.map((c) => ({ id: c.id, kind: c.kind, qty: c.qty })) },
    });
    showToast("Items added — balance updated at current prices");
    closeAdd();
  } catch (e) {
    showToast(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "Add to order";
  }
}

/* ---------- Settle ---------- */
async function settle(id) {
  const o = ORDERS.find((x) => x.id === id);
  if (!o) return;
  const yes = await confirmAction({
    title: `Settle ${o.ref}?`,
    body: `Collect the remaining balance of ${rupees(o.balance_paise)} and create the bill. This cannot be undone.`,
    confirmLabel: "Settle & bill",
  });
  if (!yes) return;
  try {
    const res = await apiFetch(`/website-orders/${id}/settle`, { method: "POST", body: { payment_method: "Cash" } });
    showToast(`Settled · ${res.bills.map((b) => b.bill_no).join(", ")} · collected ${rupees(res.balance_collected_paise)}`);
    printReceipt(o, res);
  } catch (e) {
    showToast(e.message, true);
  }
}
function printReceipt(order, res) {
  const area = document.getElementById("printArea");
  area.innerHTML = `
    <div style="text-align:center;border-bottom:1px dashed #000;padding-bottom:6px;margin-bottom:6px;">
      <strong style="font-size:15px;">NEXT LEVEL FAMILY RESTAURANT</strong><br/>
      <span style="font-size:9px;">GSTIN: ${escapeHtml(window.RESTAURANT_GSTIN)}</span><br/>
      <span style="font-size:11px;">WEBSITE ORDER · ${escapeHtml(order.ref)}</span><br/>
      <span style="font-size:10px;">${new Date().toLocaleString()}</span>
    </div>
    <div style="font-size:11px;margin-bottom:6px;">Customer: ${escapeHtml(order.customer_name)}<br/>${escapeHtml(order.fulfillment_type)}</div>
    <div style="border-top:1px dashed #000;padding-top:6px;font-size:11px;">
      ${order.items.map((i) => `<div style="display:flex;justify-content:space-between;"><span>${escapeHtml(i.item_name)} x${i.qty}</span><span>${rupees(i.line_total_paise)}</span></div>`).join("")}
    </div>
    <div style="border-top:1px dashed #000;margin-top:6px;padding-top:6px;font-size:11px;">
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${rupees(order.subtotal_paise)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Tax</span><span>${rupees(order.tax_paise)}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:bold;"><span>GRAND TOTAL</span><span>${rupees(res.grand_total_paise)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Advance paid</span><span>${rupees(order.paid_paise || order.advance_paise)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Balance collected</span><span>${rupees(res.balance_collected_paise)}</span></div>
    </div>
    <div style="text-align:center;margin-top:10px;font-size:10px;">Thank you!</div>`;
  window.print();
}

/* ---------- sound toggle (shared pref key with the QR board) ---------- */
let soundOn = true;
function loadSoundBtn() {
  try { soundOn = localStorage.getItem("kf_qr_sound") !== "off"; } catch (e) {}
  updateSoundBtn();
}
function toggleSound() {
  soundOn = !soundOn;
  try { localStorage.setItem("kf_qr_sound", soundOn ? "on" : "off"); } catch (e) {}
  updateSoundBtn();
}
function updateSoundBtn() {
  const b = document.getElementById("soundToggle");
  if (b) { b.textContent = soundOn ? "🔔 Sound on" : "🔕 Sound off"; b.classList.toggle("btn-outline", !soundOn); b.classList.toggle("btn-primary", soundOn); }
}
