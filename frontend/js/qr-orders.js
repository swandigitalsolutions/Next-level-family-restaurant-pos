/* Live Orders board — staff screen. Polls every 5s (no WebSockets in the stack).
   New orders trigger a chime, a toast, a title flash, and a card highlight. */

const NEXT_STATUS = {
  NEW: "ACCEPTED",
  ACCEPTED: "PREPARING",
  PREPARING: "READY",
  READY: "SERVED",
};
const POLL_MS = 5000;
const BASE_TITLE = "Live Orders — Next Level Family Restaurant";
let pollTimer = null;
let lastSignature = "";
let knownIds = null;        // null until the first poll seeds it
let freshIds = new Set();   // ids that just arrived, for the highlight
let titleTimer = null;

/* ---------- notification sound ---------- */
let audioCtx = null;
let soundOn = true;

function loadSoundPref() {
  try { soundOn = localStorage.getItem("kf_qr_sound") !== "off"; } catch (e) { /* ignore */ }
}
function saveSoundPref() {
  try { localStorage.setItem("kf_qr_sound", soundOn ? "on" : "off"); } catch (e) { /* ignore */ }
}
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) { /* audio unavailable */ }
}
function chime() {
  if (!soundOn) return;
  unlockAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [[880, 0], [1174, 0.13], [1568, 0.26]].forEach(([freq, at]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.42);
  });
}
function updateSoundBtn() {
  const b = document.getElementById("soundToggle");
  if (b) {
    b.textContent = soundOn ? "🔔 Sound on" : "🔕 Sound off";
    b.classList.toggle("btn-outline", !soundOn);
    b.classList.toggle("btn-primary", soundOn);
  }
}

/* ---------- title flash while tab is in the background ---------- */
function flashTitle(text) {
  clearInterval(titleTimer);
  let on = false;
  document.title = text;
  titleTimer = setInterval(() => {
    document.title = (on = !on) ? text : BASE_TITLE;
  }, 1200);
}
function stopFlash() {
  clearInterval(titleTimer);
  titleTimer = null;
  document.title = BASE_TITLE;
}

async function boot() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("qr-orders", user);
  loadSoundPref();
  updateSoundBtn();

  document.getElementById("refreshBtn").addEventListener("click", () => load(true));
  document.getElementById("statusFilter").addEventListener("change", () => { knownIds = null; load(true); });
  document.getElementById("soundToggle").addEventListener("click", () => {
    soundOn = !soundOn;
    saveSoundPref();
    updateSoundBtn();
    if (soundOn) chime();            // confirm it works + unlock audio via this gesture
  });
  // Browsers need a user gesture before audio can play.
  document.addEventListener("click", unlockAudio, { once: true });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stopPoll(); }
    else { stopFlash(); startPoll(); }
  });

  await load(true);
  startPoll();
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => load(false), POLL_MS);
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function load(showErrors) {
  const status = document.getElementById("statusFilter").value;
  const qs = status === "active" ? "?scope=active" : (status ? `?status=${status}` : "");
  let data;
  try {
    data = await apiFetch("/qr-ordering/orders" + qs);
  } catch (e) {
    if (showErrors) showToast(e.message, true);
    return;
  }
  const orders = data.orders || [];
  detectNewOrders(orders);
  render(orders);
}

function detectNewOrders(orders) {
  const ids = new Set(orders.map((o) => o.id));
  if (knownIds === null) { knownIds = ids; return; }   // first load — just seed, no alert
  const arrived = orders.filter((o) => !knownIds.has(o.id));
  knownIds = ids;
  if (!arrived.length) return;

  freshIds = new Set(arrived.map((o) => o.id));
  chime();

  if (arrived.length === 1) {
    const o = arrived[0];
    showToast(`New order received · ${o.table_label} · ${o.order_no}`);
  } else {
    showToast(`${arrived.length} new orders received`);
  }
  if (document.hidden) {
    flashTitle(`● ${arrived.length} new order${arrived.length > 1 ? "s" : ""}`);
  }
}

function render(orders) {
  const signature = orders.map((o) => `${o.id}:${o.status}`).join("|");
  if (signature === lastSignature && !freshIds.size) return;
  lastSignature = signature;

  const board = document.getElementById("ordersBoard");
  document.getElementById("ordersEmpty").style.display = orders.length ? "none" : "block";

  board.innerHTML = orders.map((o) => {
    const lines = o.items.map((it) => `
      <li><span>${escapeHtml(it.item_name)}${it.brand ? " · " + escapeHtml(it.brand) : ""} × ${it.qty}</span>
          <span>${formatMoney(it.line_total)}</span></li>`).join("");
    const advance = NEXT_STATUS[o.status];
    const canCancel = o.status !== "SERVED" && o.status !== "CANCELLED";
    const fresh = freshIds.has(o.id) ? " is-fresh" : "";
    return `
      <div class="order-card${fresh}" data-status="${o.status}">
        <div class="oc-head">
          <span class="oc-table">${escapeHtml(o.table_label)}</span>
          <span class="oc-no">${escapeHtml(o.order_no)}</span>
        </div>
        <span class="oc-status-pill">${o.status}${o.pushed_to_bill ? " · on bill" : ""}</span>
        <ul class="oc-lines">${lines}</ul>
        <div class="oc-lines"><li><span>Subtotal</span><span>${formatMoney(o.subtotal)}</span></li>
          ${Number(o.tax) ? `<li><span>Tax</span><span>${formatMoney(o.tax)}</span></li>` : ""}</div>
        <div class="oc-total"><span>Total</span> <span style="float:right">${formatMoney(o.grand_total)}</span></div>
        ${o.note ? `<div class="oc-note">Note: ${escapeHtml(o.note)}</div>` : ""}
        <div class="oc-actions">
          ${advance ? `<button class="btn btn-primary" data-advance="${o.id}" data-to="${advance}">Mark ${advance}</button>` : ""}
          ${!o.pushed_to_bill && o.status !== "CANCELLED" ? `<button class="btn btn-outline" data-push="${o.id}">Add to bill</button>` : ""}
          ${canCancel ? `<button class="btn btn-outline" data-cancel="${o.id}">Cancel</button>` : ""}
        </div>
      </div>`;
  }).join("");

  freshIds = new Set();   // highlight shown once

  board.querySelectorAll("[data-advance]").forEach((b) =>
    b.addEventListener("click", () => setStatus(Number(b.dataset.advance), b.dataset.to)));
  board.querySelectorAll("[data-cancel]").forEach((b) =>
    b.addEventListener("click", () => {
      if (confirm("Cancel this order?")) setStatus(Number(b.dataset.cancel), "CANCELLED");
    }));
  board.querySelectorAll("[data-push]").forEach((b) =>
    b.addEventListener("click", () => pushToBill(Number(b.dataset.push))));
}

async function setStatus(id, status) {
  try {
    await apiFetch(`/qr-ordering/orders/${id}/status`, { method: "POST", body: { status } });
    lastSignature = "";
    await load(true);
  } catch (e) {
    showToast(e.message, true);
  }
}

async function pushToBill(id) {
  try {
    await apiFetch(`/qr-ordering/orders/${id}/push-to-bill`, { method: "POST" });
    showToast("Order added to the table bill");
    lastSignature = "";
    await load(true);
  } catch (e) {
    showToast(e.message, true);
  }
}

boot();
