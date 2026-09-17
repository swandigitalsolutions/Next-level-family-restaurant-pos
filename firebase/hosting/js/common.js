/*
   NEXT LEVEL FAMILY RESTAURANT — Shared runtime (Firebase edition)

   Strangler migration: the per-page scripts (billing.js, menu.js, …) are the
   original Flask-era code, unchanged. This module wires the api-shim (which
   translates `apiFetch("/api/...")` to Firestore + Cloud Functions) and provides
   the UI helpers the page scripts rely on.
*/
import {
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import {
  collection, doc, getDoc, getDocs, getCountFromServer,
  query, where, orderBy, limit, updateDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, functions, db } from "./firebase-init.js";
import { makeApiFetch, orderAlertDecision, websiteOrderAlertDecision } from "./api-shim.js";

const OPTIMIZED_MENU_FALLBACK = "../assets/optimized/menu-reference.webp";
const OPTIMIZED_DESSERT_FALLBACK = "../assets/optimized/menu-desserts.webp";
const OPTIMIZED_BEVERAGE_FALLBACK = "../assets/optimized/menu-beverages.webp";
const OPTIMIZED_BIRYANI_FALLBACK = "../assets/optimized/menu-biryani.webp";
const OPTIMIZED_STARTER_FALLBACK = "../assets/optimized/menu-starters.webp";
const OPTIMIZED_BAR_FALLBACK = "../assets/optimized/menu-cocktails.webp";
window.API_BASE = "/api";
window.RESTAURANT_GSTIN = "22AAAAA0000A1Z5";

document.addEventListener("error", (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || image.dataset.fallbackApplied === "true") return;
  image.dataset.fallbackApplied = "true";
  image.src = OPTIMIZED_MENU_FALLBACK;
  image.classList.add("image-fallback");
}, true);

/* ---- auth state ---- */
let _authUser = null;
const _authReady = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, async (fb) => { unsub(); _authUser = await toSessionUser(fb); resolve(_authUser); });
});
onAuthStateChanged(auth, async (fb) => { _authUser = await toSessionUser(fb); });

async function toSessionUser(fb) {
  if (!fb) return null;
  const res = await fb.getIdTokenResult();
  return { id: fb.uid, uid: fb.uid, username: fb.displayName || String(res.claims.username || ""), full_name: fb.displayName || "", role: String(res.claims.role || "staff") };
}
async function currentUser() { return _authUser !== null ? _authUser : _authReady; }

const call = (name, data) => httpsCallable(functions, name)(data || {}).then((r) => r.data);

const apiFetch = makeApiFetch({
  db, call, auth, signInWithCustomToken, signOut,
  fs: { collection, doc, getDoc, getDocs, getCountFromServer, query, where, orderBy, limit, updateDoc },
  setUser: (u) => { _authUser = u; },
  getUser: currentUser,
});

/* ---- CSV export (orders.js downloadCsv is patched to call this) ---- */
async function downloadReportCsv(path) {
  const fb = auth.currentUser;
  if (!fb) throw new Error("Not signed in");
  const token = await fb.getIdToken();
  const url = "/api" + (path.startsWith("/") ? path : "/" + path);
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const dl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = dl;
  const disp = res.headers.get("Content-Disposition") || "";
  a.download = (disp.match(/filename="?([^"]+)"?/) || [, "sales-report.csv"])[1];
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(dl);
}

/* ---- current page name, cleanUrls-safe ("/pages/login" -> "login.html") ---- */
function _currentPage() {
  const last = (location.pathname.split("/").pop() || "").toLowerCase();
  return last && last.indexOf(".") === -1 ? last + ".html" : last;
}

/* ---- requireAuth (page gating identical to the Flask app) ---- */
async function requireAuth() {
  const user = await currentUser();
  const page = _currentPage();
  const gate = (window.PageGate && window.PageGate.pageGate)(user ? user.role : null, page);
  if (gate.action === "redirect") { window.location.href = gate.to; return null; }
  if (user) watchDeactivation(user.uid);
  return user;
}
let _deactWatch = null;
function watchDeactivation(uid) {
  if (_deactWatch) return;
  _deactWatch = onSnapshot(doc(db, "users", uid), (s) => {
    const st = s.exists() ? s.data().status : "inactive";
    if (st && st !== "active") signOut(auth).finally(() => (window.location.href = "login.html"));
  }, () => {});
}

/* =========================================================
   UI helpers (verbatim from the Flask-era common.js)
   ========================================================= */
function showToast(message, isError = false) {
  let toast = document.getElementById("globalToast");
  if (!toast) { toast = document.createElement("div"); toast.id = "globalToast"; toast.className = "toast"; document.body.appendChild(toast); }
  toast.textContent = message;
  toast.className = "toast" + (isError ? " error" : "") + " show";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function navIcon(name) {
  const icons = {
    dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"/></svg>',
    billing: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a2 2 0 0 1 2 2v14l-3-1.7L14 19l-2-1.7L10 19l-3-1.7L4 19V5a2 2 0 0 1 2-2Zm2 5v2h8V8H8Zm0 4v2h6v-2H8Z"/></svg>',
    drinks: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12l-1 5a5 5 0 0 1-3.8 3.8V19H16v2H8v-2h2.8v-7.2A5 5 0 0 1 7 8L6 3Zm2.4 2 .4 2h6.4l.4-2H8.4Z"/></svg>',
    orders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 4v2h8V7H8Zm0 4v2h8v-2H8Zm0 4v2h5v-2H8Z"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v2H4V5Zm0 6h16v2H4v-2Zm0 6h10v2H4v-2Z"/></svg>',
    qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm2 2v4h4V5h-4ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm2-2h2v2h-2v-2Zm2 2h2v2h-2v-2Z"/></svg>',
    staff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.3 0-8 1.66-8 5v2h16v-2c0-3.34-4.7-5-8-5Zm8.2-4.4a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Zm.65 1.9c-.42-.06-.85-.1-1.28-.06 1.36 1 2.23 2.38 2.23 4.16v2H23v-1.6c0-2.4-2.98-3.96-5.15-4.5Z"/></svg>',
    audit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 13h8v1.6H8V13Zm0 3.4h8V18H8v-1.6ZM8 9.6h5v1.6H8V9.6Z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4h8a2 2 0 0 1 2 2v3h-2V6h-8v12h8v-3h2v3a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm1 7h6.2l-2.1-2.1L16.5 7l4 4-4 4-1.4-1.4 2.1-2.1H11v-2Z"/></svg>',
  };
  return icons[name] || icons.dashboard;
}

function renderSidebar(activeKey, user) {
  const mount = document.getElementById("sidebarMount");
  if (!mount) return;
  const item = (key, href, label, icon) => `
    <a href="${href}" class="${activeKey === key ? "active" : ""}" title="${label}">
      <span class="icon">${navIcon(icon)}</span><span class="label">${label}</span>
    </a>`;
  const roleRaw = user ? String(user.role || "").toLowerCase() : "";
  const role = roleRaw === "staff" ? "billing" : roleRaw === "cafe" ? "cafe_billing" : roleRaw;
  const isOwner = role === "owner";
  const isAdmin = role === "admin";
  const isKitchen = role === "kitchen";
  const isCafe = role === "cafe_billing";
  const canManageCatalog = role === "admin" || role === "manager";
  const canSeeAudit = role === "admin" || role === "owner"; // manager excluded
  const canSeeKitchen = role === "admin" || role === "manager" || role === "kitchen";
  const canSeeCafe = role === "admin" || role === "manager" || role === "cafe_billing";
  const fullNav = `
      <div class="nav-section">Overview</div>
      ${item("dashboard", "dashboard.html", "Dashboard", "dashboard")}
      <div class="nav-section">Billing</div>
      ${item("billing", "billing.html", "Food Billing", "billing")}
      ${item("alcohol-billing", "alcohol-billing.html", "Bar Billing", "drinks")}
      ${canSeeCafe ? item("cafe-billing", "cafe-billing.html", "Cafe Billing", "billing") : ""}
      <div class="nav-section">Manage</div>
      ${item("orders", "orders.html", "Orders & Bills", "orders")}
      ${canManageCatalog ? item("menu", "menu.html", "Menu Studio", "menu") : ""}
      ${isAdmin ? item("staff", "staff.html", "Staff", "staff") : ""}
      ${canSeeAudit ? item("audit", "audit.html", "Audit Log", "audit") : ""}
      <div class="nav-section">QR Ordering</div>
      ${canManageCatalog ? item("qr-tables", "qr-tables.html", "Tables & QR Codes", "qr") : ""}
      <a href="qr-orders.html" class="${activeKey === "qr-orders" ? "active" : ""}" title="Live Orders">
        <span class="icon">${navIcon("orders")}</span><span class="label">Live Orders</span>
        <span class="nav-badge" id="qrOrdersBadge" hidden></span>
      </a>
      <a href="website-orders.html" class="${activeKey === "website-orders" ? "active" : ""}" title="Website Orders">
        <span class="icon">${navIcon("orders")}</span><span class="label">Website Orders</span>
        <span class="nav-badge" id="websiteOrdersBadge" hidden></span>
      </a>
      ${canSeeKitchen ? `<a href="kitchen.html" class="${activeKey === "kitchen" ? "active" : ""}" title="Kitchen">
        <span class="icon">${navIcon("orders")}</span><span class="label">Kitchen</span>
        <span class="nav-badge" id="kitchenBadge" hidden></span>
      </a>` : ""}`;
  const ownerNav = `<div class="nav-section">Overview</div>
      ${item("dashboard", "dashboard.html", "Dashboard", "dashboard")}
      ${item("audit", "audit.html", "Audit Log", "audit")}`;
  const kitchenNav = `<div class="nav-section">Kitchen</div>
      <a href="kitchen.html" class="active" title="Kitchen">
        <span class="icon">${navIcon("orders")}</span><span class="label">Kitchen Screen</span>
        <span class="nav-badge" id="kitchenBadge" hidden></span>
      </a>`;
  const cafeNav = `<div class="nav-section">Cafe</div>${item("cafe-billing", "cafe-billing.html", "Cafe Billing", "billing")}`;
  const nav = isOwner ? ownerNav : isKitchen ? kitchenNav : isCafe ? cafeNav : fullNav;
  mount.innerHTML = `
    <div class="brand">
      <div class="brand-mark"><img src="../assets/brand/next-level-logo.jpeg" alt="Next Level Family Restaurant" /></div>
      <div class="brand-copy"><div class="b1">NEXT LEVEL</div><div class="b2">FAMILY RESTAURANT</div></div>
    </div>
    <nav>
      ${nav}
      <div class="nav-section nav-section-bottom">System</div>
      <div class="nav-item" id="logoutBtn" title="Logout"><span class="icon">${navIcon("logout")}</span><span class="label">Logout</span></div>
    </nav>
    <div class="sidebar-footer"><span class="status-dot"></span><span class="label">Live workspace</span></div>`;
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    confirmLogout(async () => { try { await signOut(auth); } catch (e) {} window.location.href = "login.html"; });
  });
  const chip = document.getElementById("userChip");
  if (chip && user) {
    const initial = String(user.username || "A").slice(0, 1).toUpperCase();
    chip.innerHTML = `<span class="avatar">${escapeHtml(initial)}</span><span><strong>${escapeHtml(user.username)}</strong><small>${escapeHtml(user.role || "Owner")}</small></span>`;
  }
  startOrderAlerts(user);
  initSearchShortcut();
}

/* ---- QR new-order alerts via a Firestore listener (replaces the 12s poll) ---- */
let _alertsStarted = false, _seenSuffix = 0, _alertAudio = null;
const suffix = (s) => parseInt(String(s || "").match(/(\d+)\s*$/)?.[1] || "0", 10);
function _soundOn() { try { return localStorage.getItem("kf_qr_sound") !== "off"; } catch (e) { return true; } }
function _unlockAudio() { try { if (!_alertAudio) _alertAudio = new (window.AudioContext || window.webkitAudioContext)(); if (_alertAudio.state === "suspended") _alertAudio.resume(); } catch (e) {} }
function _chime() {
  if (!_soundOn()) return; _unlockAudio(); if (!_alertAudio) return;
  const t0 = _alertAudio.currentTime;
  [[880, 0], [1174, 0.13], [1568, 0.26]].forEach(([f, at]) => {
    const o = _alertAudio.createOscillator(); const g = _alertAudio.createGain();
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.4, t0 + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4);
    o.connect(g); g.connect(_alertAudio.destination); o.start(t0 + at); o.stop(t0 + at + 0.42);
  });
}
function _setBadge(n, id = "qrOrdersBadge") { const el = document.getElementById(id); if (!el) return; if (n > 0) { el.textContent = n > 99 ? "99+" : String(n); el.hidden = false; } else el.hidden = true; }
function _showPrompt(msg, href = "qr-orders.html") {
  let bar = document.getElementById("kfOrderPrompt");
  if (!bar) { bar = document.createElement("div"); bar.id = "kfOrderPrompt"; bar.className = "kf-order-prompt"; document.body.appendChild(bar); }
  bar.onclick = () => (window.location.href = href);
  bar.innerHTML = `<span class="kf-op-bell">🔔</span><span>${escapeHtml(msg)}</span><span class="kf-op-go">View →</span>`;
  bar.classList.add("show"); clearTimeout(bar._t); bar._t = setTimeout(() => bar.classList.remove("show"), 9000);
}
let _webSeen = 0;
function startOrderAlerts(user) {
  // QR + Website new-order alerts are for the billing desk (billing/manager/admin).
  // owner is view-only; kitchen + cafe run their own screens/alerts.
  const r = user ? String(user.role || "").toLowerCase().replace(/^staff$/, "billing").replace(/^cafe$/, "cafe_billing") : "";
  if (_alertsStarted || !user || ["owner", "kitchen", "cafe_billing"].includes(r)) return;
  const page = _currentPage();
  if (page === "login.html") return;
  _alertsStarted = true;
  const onLiveOrdersPage = page === "qr-orders.html";
  const onWebsiteOrdersPage = page === "website-orders.html";
  // migration-specific keys (the Flask build stored a row-id in kf_qr_seen_id)
  try { _seenSuffix = Number(localStorage.getItem("kf_qr_seen_ord") || 0); } catch (e) { _seenSuffix = 0; }
  try { _webSeen = Number(localStorage.getItem("kf_web_seen_ord") || 0); } catch (e) { _webSeen = 0; }
  const persist = (n) => { try { localStorage.setItem("kf_qr_seen_ord", String(n)); } catch (e) {} };
  const persistWeb = (n) => { try { localStorage.setItem("kf_web_seen_ord", String(n)); } catch (e) {} };
  document.addEventListener("click", _unlockAudio, { once: true });

  onSnapshot(query(collection(db, "qrOrders"), where("status", "==", "NEW")), (snap) => {
    const d = orderAlertDecision(_seenSuffix, snap.docs.map((x) => x.data()));
    _setBadge(d.badge, "qrOrdersBadge");
    if (d.seed != null) { _seenSuffix = d.seed; persist(d.seed); return; }
    if (d.chime && !onLiveOrdersPage) { _chime(); if (d.prompt) _showPrompt(d.prompt, "qr-orders.html"); }
    if (d.nextSeen !== _seenSuffix) { _seenSuffix = d.nextSeen; persist(d.nextSeen); }
  });

  // A website order becomes CONFIRMED only after Razorpay verifies the 50% advance.
  onSnapshot(query(collection(db, "websiteOrders"), where("status", "==", "CONFIRMED")), (snap) => {
    const d = websiteOrderAlertDecision(_webSeen, snap.docs.map((x) => x.data()));
    _setBadge(d.badge, "websiteOrdersBadge");
    if (d.seed != null) { _webSeen = d.seed; persistWeb(d.seed); return; }
    if (d.chime && !onWebsiteOrdersPage) { _chime(); if (d.prompt) _showPrompt(d.prompt, "website-orders.html"); }
    if (d.nextSeen !== _webSeen) { _webSeen = d.nextSeen; persistWeb(d.nextSeen); }
  });
}

function confirmAction({ title, body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const lastFocused = document.activeElement;
    let overlay = document.getElementById("appConfirm");
    if (!overlay) {
      overlay = document.createElement("div"); overlay.id = "appConfirm"; overlay.className = "modal-overlay";
      overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-labelledby", "appConfirmTitle");
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="modal-box confirm-box">
        <div class="modal-header"><h2 id="appConfirmTitle">${escapeHtml(title)}</h2>
          <button class="close-x" type="button" data-confirm-cancel aria-label="Close">&times;</button></div>
        ${body ? `<div class="modal-body">${escapeHtml(body)}</div>` : ""}
        <div class="modal-footer">
          <button class="btn btn-outline" type="button" data-confirm-cancel>${escapeHtml(cancelLabel)}</button>
          <button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" type="button" data-confirm-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const finish = (result) => {
      overlay.classList.remove("show");
      document.removeEventListener("keydown", onKey, true);
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
    };
    overlay.querySelectorAll("[data-confirm-cancel]").forEach((el) => (el.onclick = () => finish(false)));
    overlay.querySelector("[data-confirm-ok]").onclick = () => finish(true);
    overlay.onclick = (e) => { if (e.target === overlay) finish(false); };
    document.addEventListener("keydown", onKey, true);
    overlay.classList.add("show");
    overlay.querySelector("[data-confirm-ok]").focus();
  });
}
function confirmLogout(onConfirm) {
  confirmAction({ title: "Log out?", body: "You will be returned to the login screen.", confirmLabel: "Log out" }).then((yes) => { if (yes) onConfirm(); });
}

function initSearchShortcut() {
  const box = document.querySelector('input[type="search"]');
  if (!box) return;
  if (!box.getAttribute("aria-label")) box.setAttribute("aria-label", box.placeholder || "Search");
  if (box.placeholder && !box.placeholder.includes("press /")) box.placeholder = box.placeholder.replace(/[\s.…]*$/, "") + "  ·  press /";
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
    if (document.querySelector(".modal-overlay.show")) return;
    if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); box.focus(); box.select(); return; }
    if (e.key === "Escape" && document.activeElement === box) {
      if (box.value) { box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); } else box.blur();
    }
  });
}

function formatMoney(n) { const num = Number(n) || 0; return "₹" + num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function computeDiscountAmount(subtotal) {
  const raw = Number(document.getElementById("discountInput")?.value) || 0;
  const mode = document.getElementById("discountMode")?.value || "rupee";
  let amt = mode === "percent" ? (subtotal * raw) / 100 : raw;
  amt = Math.max(0, Math.min(Number(subtotal) || 0, amt));
  return Math.round(amt * 100) / 100;
}
function discountRowLabel() {
  const raw = Number(document.getElementById("discountInput")?.value) || 0;
  const mode = document.getElementById("discountMode")?.value || "rupee";
  return mode === "percent" && raw ? `Discount (${raw}%)` : "Discount";
}
function setupDiscountMode(onChange) {
  const sel = document.getElementById("discountMode");
  if (!sel) return;
  try { const m = localStorage.getItem("kf_discount_mode"); if (m) sel.value = m; } catch (e) {}
  sel.addEventListener("change", () => { try { localStorage.setItem("kf_discount_mode", sel.value); } catch (e) {} if (onChange) onChange(); });
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function menuImage(itemOrName, kind = "food") {
  const item = typeof itemOrName === "string" ? { name: itemOrName } : itemOrName || {};
  const normalizedKind = kind === "alcohol" ? "alcohol" : "food";
  const name = String(item.name || "").trim().toLowerCase();
  const category = String(item.category_name || item.category || "").toLowerCase();
  const exactCorrected = normalizedKind === "food" ? window.CORRECT_FOOD_IMAGE_MAP?.[`food:${name}`] : null;
  if (exactCorrected) return exactCorrected;
  const exact = window.MENU_IMAGE_MAP?.[`${normalizedKind}:${name}`];
  if (exact) return exact;
  const joined = category + name;
  if (normalizedKind === "alcohol" || /beer|whisky|vodka|rum|wine|brandy|gin|tequila|cocktail|mixer|mojito|margarita/.test(joined)) return OPTIMIZED_BAR_FALLBACK;
  if (/dessert|gulab|rasmalai|ice cream|gajar|kheer|jalebi|kulfi/.test(joined)) return OPTIMIZED_DESSERT_FALLBACK;
  if (/beverage|chai|coffee|lassi|soda|buttermilk|juice|water|drink/.test(joined)) return OPTIMIZED_BEVERAGE_FALLBACK;
  if (/rice|biryani|fried rice|jeera rice|curd rice/.test(joined)) return OPTIMIZED_BIRYANI_FALLBACK;
  if (/starter|soup|spring roll|tikka|65|manchurian|fingers|lollipop|balls|koliwada|kebab/.test(joined)) return OPTIMIZED_STARTER_FALLBACK;
  return OPTIMIZED_MENU_FALLBACK;
}
function categoryImage(category, kind = "food") { return menuImage({ category_name: category }, kind); }
function animatePress(element) {
  if (!element) return;
  element.classList.remove("is-pressed");
  requestAnimationFrame(() => element.classList.add("is-pressed"));
  setTimeout(() => element.classList.remove("is-pressed"), 180);
}

Object.assign(window, {
  apiFetch, requireAuth, currentUser,
  showToast, confirmAction, confirmLogout, renderSidebar, navIcon,
  formatMoney, computeDiscountAmount, discountRowLabel, setupDiscountMode,
  escapeHtml, menuImage, categoryImage, animatePress,
  startOrderAlerts, initSearchShortcut, downloadReportCsv,
});
