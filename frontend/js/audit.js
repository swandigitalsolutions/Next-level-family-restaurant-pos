(async function initAudit() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("audit", user);

  const PAGE_SIZE = 50;
  let offset = 0;
  let total = 0;

  const ACTION_LABELS = {
    "staff.create": "Added staff account",
    "staff.update": "Updated staff account",
    "staff.deactivate": "Deactivated staff account",
    "menu.item.create": "Added menu item",
    "menu.item.price_change": "Changed item price",
    "menu.item.delete": "Removed menu item",
    "bill.create": "Created bill",
    "table.settle": "Settled table",
    "qr.regenerate": "Regenerated table QR",
    "report.export": "Exported sales report",
  };

  function actionLabel(action) {
    return ACTION_LABELS[action] || action;
  }

  function formatWhen(value) {
    if (!value) return "—";
    const d = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatDetails(entry) {
    if (!entry.details) return "—";
    try {
      const parts = Object.entries(entry.details).map(([key, val]) => {
        if (val && typeof val === "object" && "from" in val && "to" in val) {
          return `${key}: ${escapeHtml(String(val.from))} → ${escapeHtml(String(val.to))}`;
        }
        return `${key}: ${escapeHtml(String(val))}`;
      });
      return parts.join(" · ");
    } catch (e) {
      return "—";
    }
  }

  async function load() {
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
      const entityType = document.getElementById("entityFilter").value;
      if (entityType) params.set("entity_type", entityType);
      const result = await apiFetch(`/audit-log?${params.toString()}`);
      total = result.total;
      render(result.entries);
      updatePager();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function render(entries) {
    const body = document.getElementById("auditBody");
    const empty = document.getElementById("auditEmpty");
    if (!entries.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = entries.map(e => `
      <tr>
        <td>${formatWhen(e.created_at)}</td>
        <td>${escapeHtml(e.actor_username || "system")} <span class="who-role">${escapeHtml(e.actor_role || "")}</span></td>
        <td>${escapeHtml(actionLabel(e.action))}</td>
        <td class="audit-details">${formatDetails(e)}</td>
      </tr>
    `).join("");
  }

  function updatePager() {
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    document.getElementById("pageInfo").textContent = `${from}–${to} of ${total}`;
    document.getElementById("prevPageBtn").disabled = offset === 0;
    document.getElementById("nextPageBtn").disabled = offset + PAGE_SIZE >= total;
  }

  document.getElementById("entityFilter").addEventListener("change", () => { offset = 0; load(); });
  document.getElementById("refreshBtn").addEventListener("click", () => { offset = 0; load(); });
  document.getElementById("prevPageBtn").addEventListener("click", () => { offset = Math.max(0, offset - PAGE_SIZE); load(); });
  document.getElementById("nextPageBtn").addEventListener("click", () => { offset = offset + PAGE_SIZE; load(); });

  await load();
})();
