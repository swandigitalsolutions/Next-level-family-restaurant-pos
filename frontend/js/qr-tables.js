/* Tables & QR Codes — staff screen */

let TABLES = [];

async function boot() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("qr-tables", user);
  document.getElementById("qrModalClose").addEventListener("click", closeModal);
  document.getElementById("qrModal").addEventListener("click", (e) => {
    if (e.target.id === "qrModal") closeModal();
  });
  document.getElementById("printAllBtn").addEventListener("click", printAll);
  await load();
}

async function load() {
  try {
    TABLES = await apiFetch("/qr-ordering/tables");
  } catch (e) {
    showToast(e.message, true);
    return;
  }
  const grid = document.getElementById("tablesGrid");
  const empty = document.getElementById("tablesEmpty");
  empty.style.display = TABLES.length ? "none" : "block";

  grid.innerHTML = TABLES.map((t) => `
    <div class="qr-card">
      <h3>${escapeHtml(t.table_no)}</h3>
      <div class="qr-frame">
        <img src="${t.qr_svg_url}" alt="QR for ${escapeHtml(t.table_no)}" loading="lazy" />
      </div>
      <div>
        <span class="qr-badge ${t.new_orders ? "is-new" : ""}">
          ${t.new_orders ? t.new_orders + " new" : (t.open_orders ? t.open_orders + " open" : "Active")}
        </span>
      </div>
      <div class="qr-meta">${escapeHtml(t.menu_url || "no token")}</div>
      <div class="qr-card-actions">
        <button class="btn btn-outline btn-sm" data-view="${t.id}">View QR</button>
        <button class="btn btn-outline btn-sm" data-print="${t.id}">Print</button>
      </div>
    </div>`).join("");

  grid.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => openModal(Number(b.dataset.view))));
  grid.querySelectorAll("[data-print]").forEach((b) =>
    b.addEventListener("click", () => printCards([tableById(Number(b.dataset.print))])));
}

function tableById(id) { return TABLES.find((t) => t.id === id); }

let modalTableId = null;

function openModal(id) {
  const t = tableById(id);
  if (!t) return;
  modalTableId = id;
  document.getElementById("qrModalTitle").textContent = t.table_no + " — QR Code";
  document.getElementById("qrModalBody").innerHTML = `
    <div class="qr-frame" style="max-width:280px;margin:0 auto;">
      <img src="${t.qr_svg_url}?t=${Date.now()}" alt="QR for ${escapeHtml(t.table_no)}" />
    </div>
    <p class="qr-meta" style="margin-top:12px;">${escapeHtml(t.menu_url || "")}</p>`;
  document.getElementById("qrModal").classList.add("show");
}
function closeModal() {
  document.getElementById("qrModal").classList.remove("show");
  modalTableId = null;
}

document.getElementById("qrDownloadBtn").addEventListener("click", async () => {
  const t = tableById(modalTableId);
  if (!t) return;
  try {
    const res = await fetch(t.qr_svg_url, { credentials: "include" });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = t.table_no.replace(/\s+/g, "-").toLowerCase() + "-qr.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast("Could not download QR", true);
  }
});

document.getElementById("qrRegenBtn").addEventListener("click", async () => {
  const t = tableById(modalTableId);
  if (!t) return;
  if (!confirm(`Regenerate the QR for ${t.table_no}? The old printed code will stop working.`)) return;
  try {
    await apiFetch(`/qr-ordering/tables/${t.id}/regenerate-qr`, { method: "POST" });
    showToast("New QR generated");
    await load();
    openModal(t.id);
  } catch (e) {
    showToast(e.message, true);
  }
});

document.getElementById("qrPrintBtn").addEventListener("click", () => {
  const t = tableById(modalTableId);
  if (t) printCards([t]);
});

function printAll() { printCards(TABLES.filter((t) => t.qr_token)); }

function printCards(tables) {
  const sheet = document.getElementById("printSheet");
  sheet.innerHTML = tables.map((t) => `
    <div class="print-card">
      <img class="pc-mark" src="../assets/brand/next-level-logo.jpeg" alt="Next Level Family Restaurant" />
      <div class="pc-logo">NEXT LEVEL FAMILY RESTAURANT</div>
      <div class="pc-table">${escapeHtml(t.table_no)}</div>
      <div class="pc-sub">Scan to view menu &amp; place your order</div>
      <img class="pc-qr" src="${t.qr_svg_url}" alt="QR for ${escapeHtml(t.table_no)}" />
      <div class="pc-foot">Thank you for dining with us!</div>
    </div>`).join("");
  // Give the browser a tick to load the QR images before printing.
  const imgs = Array.from(sheet.querySelectorAll("img"));
  Promise.all(imgs.map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))
    .then(() => window.print());
}

boot();
