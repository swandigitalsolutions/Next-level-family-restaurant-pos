/* Kitchen screen — AWS rewrite of firebase/hosting/js/kitchen.js. Same board,
   same chime/dedup behavior (kf_kds_seen_ms + kitchenAlertDecision, unchanged
   pure logic). Realtime now comes from the WebSocket "kitchen" channel
   instead of a Firestore onSnapshot listener: every ticket.created/
   ticket.updated push triggers one fresh REST refetch
   (GET-equivalent /kitchen/tickets?scope=open), which is then run through
   the exact same kitchenAlertDecision dedup as before. No polling as the
   primary path — see aws-realtime.js header comment. */
import { kitchenAlertDecision } from "./api-shim.js";
import { connectRealtime, startReconciliationPoll } from "./aws-realtime.js";

const COLS = [
  { key: "QUEUED", label: "Queued", next: "PREPARING", nextLabel: "Start" },
  { key: "PREPARING", label: "Preparing", next: "READY", nextLabel: "Ready" },
  { key: "READY", label: "Ready", next: "DONE", nextLabel: "Done" },
];
const SEEN_KEY = "kf_kds_seen_ms";

let TICKETS = [];
let seenMs = 0;

function loadSeen() {
  try { seenMs = Number(localStorage.getItem(SEEN_KEY) || 0) || 0; } catch (e) { seenMs = 0; }
}
function persistSeen(ms) {
  seenMs = ms;
  try { localStorage.setItem(SEEN_KEY, String(ms)); } catch (e) {}
}

(async function boot() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("kitchen", user);

  loadSoundBtn();
  loadSeen();
  document.getElementById("soundToggle").addEventListener("click", toggleSound);
  document.addEventListener("click", unlockAudio, { once: true });

  let firstLoad = true;
  async function refresh() {
    let rows;
    try {
      rows = (await apiFetch("/kitchen/tickets?scope=open")).tickets;
    } catch (e) {
      showToast(e.message, true);
      return;
    }
    TICKETS = rows.map(rowOf);
    const decision = kitchenAlertDecision(
      seenMs,
      TICKETS.map((t) => ({ id: t.id, status: t.status, createdMs: t.created_at ? t.created_at.getTime() : 0 })),
    );
    _setBadgeSafe(decision.badge);
    // mirrors the old metadata.fromCache guard: never chime on the very
    // first load after a fresh page open — that's a backlog, not an arrival.
    if (!firstLoad && decision.chime) {
      chime();
      const first = TICKETS.find((t) => t.id === decision.arrived[0]);
      showToast(`New kitchen ticket · ${first ? first.ref : ""}${decision.arrived.length > 1 ? ` (+${decision.arrived.length - 1})` : ""}`);
    }
    if (decision.nextSeenMs > seenMs) persistSeen(decision.nextSeenMs);
    firstLoad = false;
    render();
  }

  connectRealtime("kitchen", (msg) => {
    if (msg.type === "ticket.created" || msg.type === "ticket.updated") refresh();
  }, { onReconnect: refresh });
  startReconciliationPoll(refresh, 30000);

  // re-tick the "age" labels
  setInterval(render, 30000);
})();

function _setBadgeSafe(n) {
  const el = document.getElementById("kitchenBadge");
  if (!el) return;
  if (n > 0) { el.textContent = n > 99 ? "99+" : String(n); el.hidden = false; } else el.hidden = true;
}

function rowOf(d) {
  return {
    id: d.id,
    source: d.source,
    ref: d.ref,
    table_label: d.table_label || "",
    customer_name: d.customer_name || "",
    items: (d.items || []).map((it) => ({ name: it.name, qty: Number(it.qty) || 0, note: it.note || "" })),
    status: d.status,
    note: d.note || "",
    created_at: d.created_at ? new Date(d.created_at) : null,
  };
}

function ageLabel(dt) {
  if (!dt) return "";
  const mins = Math.max(0, Math.round((Date.now() - dt.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min";
  if (mins < 60) return mins + " min";
  return Math.floor(mins / 60) + "h " + (mins % 60) + "m";
}

function render() {
  const board = document.getElementById("kdsBoard");
  document.getElementById("kdsEmpty").style.display = TICKETS.length ? "none" : "block";
  board.innerHTML = COLS.map((col) => {
    const cards = TICKETS.filter((t) => t.status === col.key);
    return `<div class="kds-col">
      <h2>${col.label} <span class="count">${cards.length}</span></h2>
      ${cards.map((t) => card(t, col)).join("") || `<div class="empty-state" style="padding:12px;">—</div>`}
    </div>`;
  }).join("");

  board.querySelectorAll("[data-advance]").forEach((b) =>
    b.addEventListener("click", () => setStatus(b.dataset.advance, b.dataset.to)));
}

function card(t, col) {
  const where = t.table_label
    ? escapeHtml(t.table_label)
    : t.customer_name
      ? escapeHtml(t.customer_name)
      : t.source === "website" ? "Website" : "QR";
  const lines = t.items.map((i) => `
    <li><span><span class="q">${i.qty}×</span>${escapeHtml(i.name)}</span>${i.note ? `<span class="kc-note">${escapeHtml(i.note)}</span>` : ""}</li>`).join("");
  return `<div class="kds-card" data-status="${t.status}">
    <div class="kc-head">
      <span class="kc-ref">${escapeHtml(t.ref || "—")}</span>
      <span class="kc-age">${ageLabel(t.created_at)}</span>
    </div>
    <div class="kc-where">${where} · ${t.source === "website" ? "Website pre-order" : "Table QR"}</div>
    <ul>${lines}</ul>
    ${t.note ? `<div class="kc-note">Note: ${escapeHtml(t.note)}</div>` : ""}
    <div class="kc-actions">
      <button class="btn btn-primary btn-sm" data-advance="${t.id}" data-to="${col.next}">${col.nextLabel}</button>
      ${col.key !== "READY" ? `<button class="btn btn-outline btn-sm" data-advance="${t.id}" data-to="DONE">Done</button>` : ""}
    </div>
  </div>`;
}

async function setStatus(id, status) {
  try {
    await apiFetch(`/kitchen/tickets/${id}/status`, { method: "POST", body: { status } });
  } catch (e) {
    showToast(e.message, true);
  }
}

/* ---- self-contained chime + toggle (shares the pref key with the QR board) ---- */
let audioCtx = null;
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
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
function chime() {
  if (!soundOn) return;
  unlockAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [[784, 0], [1046, 0.14], [1318, 0.28]].forEach(([f, at]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.45);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0 + at);
    o.stop(t0 + at + 0.47);
  });
}
