/*
   NEXT LEVEL FAMILY RESTAURANT — Shared runtime
   API helper, auth guard, navigation, visual helpers and toast utility.
*/

const API_BASE = "/api";
const OPTIMIZED_MENU_FALLBACK = "../assets/optimized/menu-reference.webp";
const OPTIMIZED_DESSERT_FALLBACK = "../assets/optimized/menu-desserts.webp";
const OPTIMIZED_BEVERAGE_FALLBACK = "../assets/optimized/menu-beverages.webp";
const OPTIMIZED_BIRYANI_FALLBACK = "../assets/optimized/menu-biryani.webp";
const OPTIMIZED_STARTER_FALLBACK = "../assets/optimized/menu-starters.webp";
const OPTIMIZED_BAR_FALLBACK = "../assets/optimized/menu-cocktails.webp";

// A missing remote/local asset should never leave a blank card in production.
document.addEventListener("error", (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || image.dataset.fallbackApplied === "true") return;
  image.dataset.fallbackApplied = "true";
  image.src = OPTIMIZED_MENU_FALLBACK;
  image.classList.add("image-fallback");
}, true);

async function apiFetch(path, options = {}) {
  const opts = {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);

  let res;
  try {
    res = await fetch(API_BASE + path, opts);
  } catch (networkErr) {
    throw new Error("Cannot reach the server. Is the Flask backend running?");
  }

  let json = null;
  try {
    json = await res.json();
  } catch (parseErr) {
    throw new Error("Server returned an invalid response.");
  }

  if (res.status === 401) {
    if (!location.pathname.endsWith("login.html")) window.location.href = "login.html";
    throw new Error(json.error || "Unauthorized");
  }
  if (!json.success) throw new Error(json.error || `Request failed (${res.status})`);
  return json.data;
}

function showToast(message, isError = false) {
  let toast = document.getElementById("globalToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "globalToast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = "toast" + (isError ? " error" : "") + " show";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

async function requireAuth() {
  try {
    const user = await apiFetch("/me");
    // The "owner" role is view-only: keep it on the dashboard.
    if (user && user.role === "owner") {
      const page = location.pathname.split("/").pop() || "";
      if (page !== "dashboard.html" && page !== "login.html") {
        window.location.href = "dashboard.html";
        return null;
      }
    }
    return user;
  } catch (e) {
    window.location.href = "login.html";
    return null;
  }
}

function navIcon(name) {
  const icons = {
    dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"/></svg>',
    billing: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a2 2 0 0 1 2 2v14l-3-1.7L14 19l-2-1.7L10 19l-3-1.7L4 19V5a2 2 0 0 1 2-2Zm2 5v2h8V8H8Zm0 4v2h6v-2H8Z"/></svg>',
    drinks: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12l-1 5a5 5 0 0 1-3.8 3.8V19H16v2H8v-2h2.8v-7.2A5 5 0 0 1 7 8L6 3Zm2.4 2 .4 2h6.4l.4-2H8.4Z"/></svg>',
    orders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 4v2h8V7H8Zm0 4v2h8v-2H8Zm0 4v2h5v-2H8Z"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v2H4V5Zm0 6h16v2H4v-2Zm0 6h10v2H4v-2Z"/></svg>',
    qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm2 2v4h4V5h-4ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm2-2h2v2h-2v-2Zm2 2h2v2h-2v-2Z"/></svg>',
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

  const isOwner = user && user.role === "owner";

  const fullNav = `
      <div class="nav-section">Overview</div>
      ${item("dashboard", "dashboard.html", "Dashboard", "dashboard")}
      <div class="nav-section">Billing</div>
      ${item("billing", "billing.html", "Food Billing", "billing")}
      ${item("alcohol-billing", "alcohol-billing.html", "Bar Billing", "drinks")}
      <div class="nav-section">Manage</div>
      ${item("orders", "orders.html", "Orders & Bills", "orders")}
      ${item("menu", "menu.html", "Menu Studio", "menu")}
      <div class="nav-section">QR Ordering</div>
      ${item("qr-tables", "qr-tables.html", "Tables & QR Codes", "qr")}
      <a href="qr-orders.html" class="${activeKey === "qr-orders" ? "active" : ""}" title="Live Orders">
        <span class="icon">${navIcon("orders")}</span><span class="label">Live Orders</span>
        <span class="nav-badge" id="qrOrdersBadge" hidden></span>
      </a>`;

  const ownerNav = `
      <div class="nav-section">Overview</div>
      ${item("dashboard", "dashboard.html", "Dashboard", "dashboard")}`;

  mount.innerHTML = `
    <div class="brand">
      <div class="brand-mark"><img src="../assets/brand/next-level-logo.jpeg" alt="Next Level Family Restaurant" /></div>
      <div class="brand-copy"><div class="b1">NEXT LEVEL</div><div class="b2">FAMILY RESTAURANT</div></div>
    </div>
    <nav>
      ${isOwner ? ownerNav : fullNav}
      <div class="nav-section nav-section-bottom">System</div>
      <div class="nav-item" id="logoutBtn" title="Logout">
        <span class="icon">${navIcon("logout")}</span><span class="label">Logout</span>
      </div>
    </nav>
    <div class="sidebar-footer"><span class="status-dot"></span><span class="label">Live workspace</span></div>
  `;

  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    confirmLogout(async () => {
      try { await apiFetch("/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      window.location.href = "login.html";
    });
  });

  const chip = document.getElementById("userChip");
  if (chip && user) {
    const initial = String(user.username || "A").slice(0, 1).toUpperCase();
    chip.innerHTML = `<span class="avatar">${escapeHtml(initial)}</span><span><strong>${escapeHtml(user.username)}</strong><small>${escapeHtml(user.role || "Owner")}</small></span>`;
  }

  startOrderAlerts(user);
  initSearchShortcut();
}

/* =========================================================
   Global QR new-order alerts — chime + on-screen prompt on ANY page,
   plus a live count badge on the sidebar "Live Orders" item.
   ========================================================= */

let _kfAlertsStarted = false;
let _kfSeenOrderId = 0;
let _kfAlertAudio = null;
let _kfAlertTimer = null;

function _kfSoundOn() {
  try { return localStorage.getItem("kf_qr_sound") !== "off"; } catch (e) { return true; }
}
function _kfUnlockAudio() {
  try {
    if (!_kfAlertAudio) _kfAlertAudio = new (window.AudioContext || window.webkitAudioContext)();
    if (_kfAlertAudio.state === "suspended") _kfAlertAudio.resume();
  } catch (e) { /* no audio */ }
}
function _kfChime() {
  if (!_kfSoundOn()) return;
  _kfUnlockAudio();
  if (!_kfAlertAudio) return;
  const t0 = _kfAlertAudio.currentTime;
  [[880, 0], [1174, 0.13], [1568, 0.26]].forEach(([f, at]) => {
    const o = _kfAlertAudio.createOscillator();
    const g = _kfAlertAudio.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4);
    o.connect(g); g.connect(_kfAlertAudio.destination);
    o.start(t0 + at); o.stop(t0 + at + 0.42);
  });
}

function _kfSetOrdersBadge(n) {
  const el = document.getElementById("qrOrdersBadge");
  if (!el) return;
  if (n > 0) { el.textContent = n > 99 ? "99+" : String(n); el.hidden = false; }
  else { el.hidden = true; }
}

function _kfShowOrderPrompt(message) {
  let bar = document.getElementById("kfOrderPrompt");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "kfOrderPrompt";
    bar.className = "kf-order-prompt";
    bar.addEventListener("click", () => { window.location.href = "qr-orders.html"; });
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span class="kf-op-bell">🔔</span><span>${escapeHtml(message)}</span><span class="kf-op-go">View →</span>`;
  bar.classList.add("show");
  clearTimeout(bar._t);
  bar._t = setTimeout(() => bar.classList.remove("show"), 9000);
}

function startOrderAlerts(user) {
  if (_kfAlertsStarted) return;
  if (!user || user.role === "owner") return;                     // owner is view-only
  if (location.pathname.endsWith("login.html")) return;
  _kfAlertsStarted = true;

  const onLiveOrdersPage = location.pathname.endsWith("qr-orders.html");
  try { _kfSeenOrderId = Number(localStorage.getItem("kf_qr_seen_id") || 0); } catch (e) { _kfSeenOrderId = 0; }
  document.addEventListener("click", _kfUnlockAudio, { once: true });

  const tick = async () => {
    if (document.hidden) return;
    let data;
    try {
      data = await apiFetch("/qr-ordering/pulse?after=" + (_kfSeenOrderId || 0));
    } catch (e) { return; }

    _kfSetOrdersBadge(data.new_count || 0);

    const fresh = data.new || [];
    if (!_kfSeenOrderId) {                    // first run on this device — seed silently
      _kfSeenOrderId = data.latest_id || 0;
      try { localStorage.setItem("kf_qr_seen_id", String(_kfSeenOrderId)); } catch (e) { /* ignore */ }
      return;
    }
    if (fresh.length && !onLiveOrdersPage) {  // the Live Orders page runs its own richer alert
      _kfChime();
      if (fresh.length === 1) {
        const o = fresh[0];
        _kfShowOrderPrompt(`Order received · ${o.table_label} · ${o.order_no} · ${formatMoney(o.grand_total)}`);
      } else {
        _kfShowOrderPrompt(`${fresh.length} new orders received`);
      }
    }
    if (data.latest_id && data.latest_id !== _kfSeenOrderId) {
      _kfSeenOrderId = data.latest_id;
      try { localStorage.setItem("kf_qr_seen_id", String(_kfSeenOrderId)); } catch (e) { /* ignore */ }
    }
  };

  tick();
  _kfAlertTimer = setInterval(tick, 12000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

/* Styled replacement for window.confirm(). Native confirm() freezes the tab,
   ignores our design system, and on a busy service screen it is easy to dismiss
   by reflex. This returns a promise, supports Escape/Enter, restores focus to
   whatever the user was on, and marks destructive actions in red. */
function confirmAction({ title, body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const lastFocused = document.activeElement;
    let overlay = document.getElementById("appConfirm");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "appConfirm";
      overlay.className = "modal-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "appConfirmTitle");
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="modal-box confirm-box">
        <div class="modal-header">
          <h2 id="appConfirmTitle">${escapeHtml(title)}</h2>
          <button class="close-x" type="button" data-confirm-cancel aria-label="Close">&times;</button>
        </div>
        ${body ? `<div class="modal-body">${escapeHtml(body)}</div>` : ""}
        <div class="modal-footer">
          <button class="btn btn-outline" type="button" data-confirm-cancel>${escapeHtml(cancelLabel)}</button>
          <button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" type="button" data-confirm-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;

    const finish = (result) => {
      overlay.classList.remove("show");
      document.removeEventListener("keydown", onKey, true);
      // Put the user back where they were so the next keystroke still lands.
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
    };

    overlay.querySelectorAll("[data-confirm-cancel]").forEach((el) => { el.onclick = () => finish(false); });
    overlay.querySelector("[data-confirm-ok]").onclick = () => finish(true);
    overlay.onclick = (e) => { if (e.target === overlay) finish(false); };
    document.addEventListener("keydown", onKey, true);

    overlay.classList.add("show");
    overlay.querySelector("[data-confirm-ok]").focus();
  });
}

function confirmLogout(onConfirm) {
  confirmAction({
    title: "Log out?",
    body: "You will be returned to the login screen.",
    confirmLabel: "Log out",
  }).then((yes) => { if (yes) onConfirm(); });
}

/* Search-focus shortcut. On a till the mouse is the slow path, so "/" (or
   Ctrl/Cmd-K) jumps straight to the search box on whichever screen is open, and
   Escape clears it and returns focus to the page. Ignored while the user is
   already typing in a field, so it never eats a keystroke mid-entry. */
function initSearchShortcut() {
  const box = document.querySelector('input[type="search"]');
  if (!box) return;

  if (!box.getAttribute("aria-label")) box.setAttribute("aria-label", box.placeholder || "Search");
  // Advertise the shortcut in the placeholder so it is discoverable.
  if (box.placeholder && !box.placeholder.includes("press /")) {
    box.placeholder = box.placeholder.replace(/[\s.…]*$/, "") + "  ·  press /";
  }

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")
      || document.activeElement?.isContentEditable;
    const modalOpen = document.querySelector(".modal-overlay.show");
    if (modalOpen) return;

    if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      box.focus();
      box.select();
      return;
    }
    if (e.key === "Escape" && document.activeElement === box) {
      if (box.value) {
        box.value = "";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        box.blur();
      }
    }
  });
}

function formatMoney(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Discount entered as ₹ or % (selector #discountMode), converted to a rupee
   amount capped at the subtotal. Shared by food + bar billing. */
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
  try { const m = localStorage.getItem("kf_discount_mode"); if (m) sel.value = m; } catch (e) { /* ignore */ }
  sel.addEventListener("change", () => {
    try { localStorage.setItem("kf_discount_mode", sel.value); } catch (e) { /* ignore */ }
    if (onChange) onChange();
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function menuImage(itemOrName, kind = "food") {
  const item = typeof itemOrName === "string" ? { name: itemOrName } : (itemOrName || {});
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

function categoryImage(category, kind = "food") {
  return menuImage({ category_name: category }, kind);
}

function animatePress(element) {
  if (!element) return;
  element.classList.remove("is-pressed");
  requestAnimationFrame(() => element.classList.add("is-pressed"));
  setTimeout(() => element.classList.remove("is-pressed"), 180);
}
