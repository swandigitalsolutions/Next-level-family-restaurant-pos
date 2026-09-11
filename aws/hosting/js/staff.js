(async function initStaff() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("staff", user);

  let STAFF = [];
  let editingId = null;

  const modal = document.getElementById("staffModal");
  const form = document.getElementById("staffForm");
  const statusField = document.getElementById("staffStatusField");
  const usernameInput = document.getElementById("staffUsername");
  const passwordInput = document.getElementById("staffPassword");
  const passwordHint = document.getElementById("staffPasswordHint");
  const passwordLabel = document.getElementById("staffPasswordLabel");

  const ROLE_LABELS = {
    admin: "Admin",
    manager: "Manager",
    billing: "Billing",
    cafe_billing: "Cafe Billing",
    kitchen: "Kitchen",
    owner: "Owner",
    staff: "Billing", // legacy alias
    cafe: "Cafe Billing", // legacy alias
  };

  function roleTag(role) {
    const r = role === "staff" ? "billing" : role === "cafe" ? "cafe_billing" : role;
    return `<span class="tag role-${r}">${ROLE_LABELS[role] || role}</span>`;
  }

  function statusTag(status) {
    return `<span class="tag ${status === "active" ? "tag-active" : "tag-inactive"}">${status}</span>`;
  }

  function formatDate(value) {
    if (!value) return "—";
    const d = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  async function loadAll() {
    try {
      STAFF = await apiFetch("/staff");
      renderStats();
      renderTable();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderStats() {
    const active = STAFF.filter(s => s.status === "active");
    document.getElementById("statTotal").textContent = STAFF.length;
    document.getElementById("statActive").textContent = active.length;
    document.getElementById("statAdmins").textContent = STAFF.filter(s => s.role === "admin").length;
    document.getElementById("statCashiers").textContent = STAFF.filter(s => s.role === "manager" || s.role === "staff" || s.role === "billing").length;
  }

  function renderTable() {
    const body = document.getElementById("staffBody");
    const empty = document.getElementById("staffEmpty");
    const query = (document.getElementById("staffSearch").value || "").toLowerCase().trim();
    const filtered = STAFF.filter(s =>
      !query || `${s.full_name} ${s.username} ${s.phone || ""} ${s.role}`.toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    body.innerHTML = filtered.map(s => `
      <tr data-id="${s.id}">
        <td class="cell-name">${escapeHtml(s.full_name || "—")}</td>
        <td>${escapeHtml(s.username)}</td>
        <td>${escapeHtml(s.phone || "—")}</td>
        <td>${roleTag(s.role)}</td>
        <td>${statusTag(s.status)}</td>
        <td>${formatDate(s.created_at)}</td>
        <td class="row-actions">
          <button class="btn btn-outline btn-sm act-edit">Edit</button>
          ${s.id === user.id
            ? `<span class="you-badge">You</span>`
            : `<button class="btn btn-danger btn-sm act-toggle">${s.status === "active" ? "Deactivate" : "Activate"}</button>`}
        </td>
      </tr>
    `).join("");

    body.querySelectorAll(".act-edit").forEach(btn => {
      btn.addEventListener("click", () => openEdit(Number(btn.closest("tr").dataset.id)));
    });
    body.querySelectorAll(".act-toggle").forEach(btn => {
      btn.addEventListener("click", () => toggleStatus(Number(btn.closest("tr").dataset.id)));
    });
  }

  function openAdd() {
    editingId = null;
    form.reset();
    document.getElementById("staffModalTitle").textContent = "Add staff";
    document.getElementById("staffSaveBtn").textContent = "Add staff";
    usernameInput.disabled = false;
    statusField.hidden = true;
    passwordInput.required = true;
    passwordLabel.textContent = "Password";
    passwordHint.textContent = "At least 6 characters.";
    document.getElementById("staffRole").value = "billing";
    modal.classList.add("show");
    document.getElementById("staffFullName").focus();
  }

  function openEdit(id) {
    const person = STAFF.find(s => s.id === id);
    if (!person) return;
    editingId = id;
    form.reset();
    document.getElementById("staffModalTitle").textContent = `Edit ${person.full_name || person.username}`;
    document.getElementById("staffSaveBtn").textContent = "Save changes";
    document.getElementById("staffFullName").value = person.full_name || "";
    usernameInput.value = person.username;
    usernameInput.disabled = true;
    document.getElementById("staffPhone").value = person.phone || "";
    document.getElementById("staffRole").value = person.role;
    statusField.hidden = false;
    document.getElementById("staffStatus").value = person.status;
    passwordInput.required = false;
    passwordLabel.textContent = "New password";
    passwordHint.textContent = "Leave blank to keep the current password.";
    modal.classList.add("show");
    document.getElementById("staffFullName").focus();
  }

  function closeModal() {
    modal.classList.remove("show");
    editingId = null;
  }

  document.getElementById("addStaffBtn").addEventListener("click", openAdd);
  document.getElementById("staffCancelBtn").addEventListener("click", closeModal);
  document.getElementById("staffModalClose").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  async function toggleStatus(id) {
    const person = STAFF.find(s => s.id === id);
    if (!person) return;
    const activating = person.status !== "active";
    const proceed = await confirmAction({
      title: activating ? "Reactivate this account?" : "Deactivate this account?",
      body: activating
        ? "They will be able to log in again immediately."
        : "They will be signed out on their next request and cannot log in until reactivated.",
      confirmLabel: activating ? "Activate" : "Deactivate",
      danger: !activating,
    });
    if (!proceed) return;
    try {
      if (activating) {
        await apiFetch(`/staff/${id}`, { method: "PUT", body: { status: "active" } });
      } else {
        await apiFetch(`/staff/${id}`, { method: "DELETE" });
      }
      showToast(activating ? "Account activated" : "Account deactivated");
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      full_name: document.getElementById("staffFullName").value.trim(),
      phone: document.getElementById("staffPhone").value.trim(),
      role: document.getElementById("staffRole").value,
      password: passwordInput.value,
    };

    try {
      if (editingId) {
        payload.status = document.getElementById("staffStatus").value;
        await apiFetch(`/staff/${editingId}`, { method: "PUT", body: payload });
        showToast("Staff account updated");
      } else {
        payload.username = usernameInput.value.trim().toLowerCase();
        await apiFetch("/staff", { method: "POST", body: payload });
        showToast("Staff account created");
      }
      closeModal();
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("staffSearch").addEventListener("input", renderTable);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("show")) closeModal();
  });

  await loadAll();
})();
