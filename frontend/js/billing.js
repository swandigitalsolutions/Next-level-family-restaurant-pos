(async function initBilling() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("billing", user);

  let CATEGORIES = [];
  let ITEMS = [];
  let TABLES = [];
  let CART = [];
  let activeCategoryId = "all";
  let ACTIVE_TABLE = null;
  let TABLE_MODAL_MODE = "open";
  let saveTimer = null;
  const TAX_PERCENT = 5;                       // fallback when nothing is saved yet
  const TAX_STORAGE_KEY = "kf_default_tax_percent";

  function storedTaxPercent() {
    try {
      const raw = Number(localStorage.getItem(TAX_STORAGE_KEY));
      if (Number.isFinite(raw) && raw >= 0 && localStorage.getItem(TAX_STORAGE_KEY) !== null) return raw;
    } catch (e) { /* storage unavailable */ }
    return TAX_PERCENT;
  }

  // Live value from the Tax (%) field, falling back to the saved default.
  function currentTaxPercent() {
    const el = document.getElementById("taxInput");
    const raw = Number(el && el.value);
    return Number.isFinite(raw) && raw >= 0 ? raw : storedTaxPercent();
  }

  async function loadData() {
    try {
      [CATEGORIES, ITEMS] = await Promise.all([apiFetch("/food/categories"), apiFetch("/food/items")]);
      await loadTables();
      renderCategories();
      renderItems();
      renderCart();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function loadTables() {
    TABLES = await apiFetch("/tables");
    renderTables();
  }

  function renderTables() {
    const list = document.getElementById("tableList");
    if (!list) return;
    list.innerHTML = TABLES.map(table => {
      const isOpen = table.status === "open";
      const isActive = ACTIVE_TABLE && Number(ACTIVE_TABLE.table_id || ACTIVE_TABLE.id) === Number(table.id);
      return `<button class="table-card ${isOpen ? "open" : ""} ${isActive ? "active" : ""}" data-table-id="${table.id}" type="button">
        <span class="table-state">${isOpen ? "Open" : "Available"}</span>
        <div class="table-no">${escapeHtml(table.table_no)}</div>
        <div class="table-meta">${table.seats} seats${isOpen && table.customer_name ? ` · ${escapeHtml(table.customer_name)}` : ""}</div>
        ${isOpen ? `<div class="table-total">${formatMoney(table.grand_total)}</div><span class="table-action">Continue billing →</span>` : `<span class="table-action">Open table →</span>`}
      </button>`;
    }).join("");
    list.querySelectorAll("[data-table-id]").forEach(button => {
      button.addEventListener("click", () => selectTable(Number(button.dataset.tableId)));
    });
    updateTableSummary();
  }

  function updateTableSummary() {
    const summary = document.getElementById("tableSummary");
    if (!summary) return;
    if (!ACTIVE_TABLE) {
      summary.textContent = "Counter sale mode · select an available table to start a live bill.";
      return;
    }
    summary.textContent = `${ACTIVE_TABLE.table_no} is open · items added here stay attached to this table until settlement.`;
  }

  async function selectTable(tableId) {
    const table = TABLES.find(item => Number(item.id) === Number(tableId));
    if (!table) return;
    if (table.status !== "open") {
      openTableModal(table);
      return;
    }
    try {
      const session = await apiFetch(`/table-sessions/${table.session_id}`);
      ACTIVE_TABLE = session;
      CART = (session.items || []).map(item => ({
        name: item.item_name,
        price: Number(item.price),
        qty: Number(item.qty),
        item_kind: item.item_kind,
        brand: item.brand || "",
        bottle_size: item.bottle_size || "",
        tax_rate: Number(item.tax_rate || TAX_PERCENT),
      }));
      document.getElementById("customerName").value = session.customer_name === "Walk-in" ? "" : session.customer_name;
      document.getElementById("customerPhone").value = session.customer_phone === "-" ? "" : session.customer_phone;
      updateTableSummary();
      renderTables();
      renderCart();
      showToast(`Billing opened for ${table.table_no}`);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function openTableModal(table = null) {
    TABLE_MODAL_MODE = table ? "open" : "create";
    document.getElementById("tableModalTitle").textContent = table ? `Open ${table.table_no}` : "Add table";
    document.getElementById("saveTableBtn").textContent = table ? "Open table" : "Add table";
    document.getElementById("tableNumberInput").value = table ? table.table_no : "";
    document.getElementById("tableNumberInput").readOnly = Boolean(table);
    document.getElementById("tableSeatsInput").value = table ? table.seats : 4;
    document.getElementById("tableCustomerInput").value = "";
    document.getElementById("tablePhoneInput").value = "";
    document.getElementById("tableModal").classList.add("show");
    setTimeout(() => document.getElementById("tableCustomerInput").focus(), 80);
  }

  function closeTableModal() {
    document.getElementById("tableModal").classList.remove("show");
  }

  document.getElementById("addTableBtn").addEventListener("click", () => openTableModal());
  document.getElementById("closeTableModalBtn").addEventListener("click", closeTableModal);
  document.getElementById("counterSaleBtn").addEventListener("click", () => {
    ACTIVE_TABLE = null;
    CART = [];
    document.getElementById("customerName").value = "";
    document.getElementById("customerPhone").value = "";
    renderTables();
    renderCart();
    showToast("Counter sale mode selected");
  });
  document.getElementById("tableForm").addEventListener("submit", async event => {
    event.preventDefault();
    const tableNumber = document.getElementById("tableNumberInput").value.trim();
    const seats = Number(document.getElementById("tableSeatsInput").value || 4);
    const customerName = document.getElementById("tableCustomerInput").value.trim();
    const customerPhone = document.getElementById("tablePhoneInput").value.trim();
    try {
      if (TABLE_MODAL_MODE === "create") {
        await apiFetch("/tables", { method: "POST", body: { table_no: tableNumber, seats } });
        showToast(`${tableNumber} added to the dining floor`);
      } else {
        const table = TABLES.find(item => item.table_no === tableNumber);
        const opened = await apiFetch(`/tables/${table.id}/open`, { method: "POST", body: { customer_name: customerName, customer_phone: customerPhone } });
        await loadTables();
        await selectTable(table.id);
        if (opened) showToast(`${tableNumber} is now open`);
      }
      closeTableModal();
      await loadTables();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  function renderCategories() {
    const list = document.getElementById("categoryList");
    let html = `<button class="cat-btn ${activeCategoryId === "all" ? "active" : ""}" data-id="all">All Items <span class="cat-count">${ITEMS.length}</span></button>`;
    html += CATEGORIES.filter(c => c.status === "active").map(c => {
      const count = ITEMS.filter(item => item.category_id === c.id).length;
      return `<button class="cat-btn ${activeCategoryId === c.id ? "active" : ""}" data-id="${c.id}">${escapeHtml(c.name)} <span class="cat-count">${count}</span></button>`;
    }).join("");
    list.innerHTML = html;
    list.querySelectorAll(".cat-btn").forEach(btn => btn.addEventListener("click", () => {
      activeCategoryId = btn.dataset.id === "all" ? "all" : Number(btn.dataset.id);
      renderCategories();
      renderItems();
    }));
  }

  function renderItems() {
    const grid = document.getElementById("itemGrid");
    const query = (document.getElementById("searchBox").value || "").toLowerCase().trim();
    let filtered = ITEMS;
    if (activeCategoryId !== "all") filtered = filtered.filter(i => i.category_id === activeCategoryId);
    if (query) filtered = filtered.filter(i => i.name.toLowerCase().includes(query) || (i.category_name || "").toLowerCase().includes(query));
    if (!filtered.length) {
      grid.innerHTML = `<div class="empty-state">No food items found. Try another search or category.</div>`;
      return;
    }
    grid.innerHTML = filtered.map(i => `<button class="item-card" data-name="${escapeHtml(i.name)}" data-price="${i.price}" type="button" aria-label="Add ${escapeHtml(i.name)}">
      <div class="item-card-image"><img src="${menuImage(i)}" alt="${escapeHtml(i.name)}" loading="lazy" decoding="async"></div>
      <div class="item-card-info"><div class="i-sub">${escapeHtml(i.category_name || "Food item")}</div><div class="i-name">${escapeHtml(i.name)}</div><div class="i-price">${formatMoney(i.price)}</div><div class="i-add-hint">Tap to add to ${ACTIVE_TABLE ? escapeHtml(ACTIVE_TABLE.table_no) : "counter bill"}</div></div>
    </button>`).join("");
    grid.querySelectorAll(".item-card").forEach(card => card.addEventListener("click", () => addToCart({ name: card.dataset.name, price: Number(card.dataset.price), item_kind: "food", tax_rate: TAX_PERCENT })));
  }

  document.getElementById("searchBox").addEventListener("input", renderItems);

  function addToCart(item) {
    const existing = CART.find(c => c.name === item.name && c.item_kind === item.item_kind);
    if (existing) existing.qty += 1;
    else CART.push({ ...item, qty: 1 });
    renderCart();
    scheduleSessionSave();
  }

  function renderCart() {
    const list = document.getElementById("cartList");
    list.innerHTML = CART.length ? CART.map((c, idx) => `<div class="cart-row"><span class="c-name">${escapeHtml(c.name)}</span><span class="qty-ctrl"><button data-act="dec" data-idx="${idx}">−</button><span>${c.qty}</span><button data-act="inc" data-idx="${idx}">+</button></span><span class="c-total">${formatMoney(c.price * c.qty)}</span><span class="c-remove" data-act="remove" data-idx="${idx}">&times;</span></div>`).join("") : `<div class="empty-state">${ACTIVE_TABLE ? "No items on this table yet" : "No items added yet"}</div>`;
    list.querySelectorAll("[data-act]").forEach(btn => btn.addEventListener("click", () => {
      const index = Number(btn.dataset.idx);
      if (btn.dataset.act === "inc") CART[index].qty += 1;
      if (btn.dataset.act === "dec") { CART[index].qty -= 1; if (CART[index].qty <= 0) CART.splice(index, 1); }
      if (btn.dataset.act === "remove") CART.splice(index, 1);
      renderCart();
      scheduleSessionSave();
    }));
    updateTotals();
  }

  function computeTotals() {
    const subtotal = CART.reduce((sum, item) => sum + item.price * item.qty, 0);
    const taxPercent = currentTaxPercent();
    const tax = subtotal * (taxPercent / 100);
    const discount = computeDiscountAmount(subtotal);
    return { subtotal: Math.round(subtotal * 100) / 100, tax: Math.round(tax * 100) / 100, taxPercent, discount, grandTotal: Math.max(0, Math.round((subtotal + tax - discount) * 100) / 100) };
  }

  function updateTotals() {
    const totals = computeTotals();
    document.getElementById("tSubtotal").textContent = formatMoney(totals.subtotal);
    document.getElementById("tTaxLabel").textContent = `Tax (${totals.taxPercent}%)`;
    document.getElementById("tTax").textContent = formatMoney(totals.tax);
    document.getElementById("tDiscountLabel").textContent = discountRowLabel();
    document.getElementById("tDiscount").textContent = "− " + formatMoney(totals.discount);
    document.getElementById("tGrandTotal").textContent = formatMoney(totals.grandTotal);
    document.getElementById("confirmBillBtn").disabled = CART.length === 0;
    document.getElementById("confirmBillBtn").textContent = ACTIVE_TABLE ? "Settle table bill" : "Confirm Bill";
  }

  document.getElementById("discountInput").addEventListener("input", () => { updateTotals(); scheduleSessionSave(); });
  setupDiscountMode(() => { updateTotals(); scheduleSessionSave(); });
  document.getElementById("clearCartBtn").addEventListener("click", () => { CART = []; renderCart(); scheduleSessionSave(); });

  // Tax (%): prefill from the saved default, and persist any change so it
  // carries over to future bills without re-entering it every time.
  const taxInput = document.getElementById("taxInput");
  taxInput.value = storedTaxPercent();
  taxInput.addEventListener("input", () => {
    const val = Number(taxInput.value);
    if (Number.isFinite(val) && val >= 0) {
      try { localStorage.setItem(TAX_STORAGE_KEY, String(val)); } catch (e) { /* storage unavailable */ }
    }
    updateTotals();
    scheduleSessionSave();
  });

  function scheduleSessionSave() {
    if (!ACTIVE_TABLE) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const taxPercent = currentTaxPercent();
        const itemsWithTax = CART.map(item => ({ ...item, tax_rate: taxPercent }));
        await apiFetch(`/table-sessions/${ACTIVE_TABLE.id}`, { method: "PUT", body: { customer_name: document.getElementById("customerName").value.trim() || "Walk-in", customer_phone: document.getElementById("customerPhone").value.trim() || "-", items: itemsWithTax } });
        await loadTables();
      } catch (err) { showToast(err.message, true); }
    }, 350);
  }
  document.getElementById("customerName").addEventListener("input", scheduleSessionSave);
  document.getElementById("customerPhone").addEventListener("input", scheduleSessionSave);

  function openConfirmModal() {
    const totals = computeTotals();
    const paymentMethod = document.getElementById("paymentMethod").value;
    const customerName = document.getElementById("customerName").value.trim() || "Walk-in";
    const customerPhone = document.getElementById("customerPhone").value.trim() || "-";
    document.getElementById("confirmModalBody").innerHTML = `<div class="confirm-meta"><div><strong>${ACTIVE_TABLE ? "Table" : "Customer"}:</strong> ${escapeHtml(ACTIVE_TABLE ? ACTIVE_TABLE.table_no : customerName)}</div><div><strong>Customer:</strong> ${escapeHtml(customerName)}</div><div><strong>Payment:</strong> ${escapeHtml(paymentMethod)}</div><div><strong>Date:</strong> ${new Date().toLocaleString()}</div></div><div class="confirm-items">${CART.map(c => `<div class="ci-row"><span>${escapeHtml(c.name)} x${c.qty}</span><span>${formatMoney(c.price * c.qty)}</span></div>`).join("")}</div><div class="confirm-totals"><div class="t-row"><span>Subtotal</span><span>${formatMoney(totals.subtotal)}</span></div><div class="t-row"><span>Tax</span><span>${formatMoney(totals.tax)}</span></div><div class="t-row"><span>Discount</span><span>− ${formatMoney(totals.discount)}</span></div><div class="t-row grand"><span>Grand Total</span><span>${formatMoney(totals.grandTotal)}</span></div></div>`;
    document.getElementById("confirmModal").classList.add("show");
  }

  document.getElementById("confirmBillBtn").addEventListener("click", () => { if (CART.length) openConfirmModal(); });
  document.getElementById("closeModalBtn").addEventListener("click", () => document.getElementById("confirmModal").classList.remove("show"));
  document.getElementById("editBillBtn").addEventListener("click", () => document.getElementById("confirmModal").classList.remove("show"));

  async function finalizeBill(doPrint) {
    const printBtn = document.getElementById("confirmPrintBtn");
    const onlyBtn = document.getElementById("confirmOnlyBtn");
    const labels = { [printBtn.id]: printBtn.textContent, [onlyBtn.id]: onlyBtn.textContent };
    [printBtn, onlyBtn].forEach(b => { b.disabled = true; });
    (doPrint ? printBtn : onlyBtn).textContent = "Saving…";
    const paymentMethod = document.getElementById("paymentMethod").value;
    try {
      if (ACTIVE_TABLE) {
        const snapshot = await apiFetch(`/table-sessions/${ACTIVE_TABLE.id}`);
        const settled = await apiFetch(`/table-sessions/${ACTIVE_TABLE.id}/settle`, { method: "POST", body: { payment_method: paymentMethod, discount: computeTotals().discount } });
        if (doPrint) printTableReceipt(snapshot, settled);
        showToast(`${settled.table_no} settled successfully`);
        ACTIVE_TABLE = null;
        CART = [];
        await loadTables();
      } else {
        const bill = await apiFetch("/food/bills", { method: "POST", body: { customer_name: document.getElementById("customerName").value.trim(), customer_phone: document.getElementById("customerPhone").value.trim(), items: CART, discount: computeTotals().discount, tax_percent: currentTaxPercent(), payment_method: paymentMethod } });
        showToast(`Bill ${bill.bill_no} confirmed`);
        if (doPrint) printReceipt(bill);
      }
      document.getElementById("customerName").value = "";
      document.getElementById("customerPhone").value = "";
      document.getElementById("discountInput").value = 0;
      renderTables();
      renderCart();
      document.getElementById("confirmModal").classList.remove("show");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      [printBtn, onlyBtn].forEach(b => { b.disabled = false; b.textContent = labels[b.id]; });
    }
  }

  document.getElementById("confirmPrintBtn").addEventListener("click", () => finalizeBill(true));
  document.getElementById("confirmOnlyBtn").addEventListener("click", () => finalizeBill(false));

  function printTableReceipt(snapshot, settled) {
    printReceipt({ bill_no: `${settled.table_no} · TABLE BILL`, created_at: new Date().toLocaleString(), customer_name: snapshot.customer_name, customer_phone: snapshot.customer_phone, payment_method: settled.payment_method, items: snapshot.items.map(item => ({ item_name: item.item_name, qty: item.qty, line_total: item.line_total })), subtotal: settled.subtotal, tax: settled.tax, discount: settled.discount, grand_total: settled.grand_total });
  }

  function printReceipt(bill) {
    document.getElementById("printArea").innerHTML = `<div style="text-align:center;border-bottom:1px dashed #000;padding-bottom:6px;margin-bottom:6px;"><strong style="font-size:15px;">NEXT LEVEL FAMILY RESTAURANT</strong><br/><span style="font-size:11px;">FOOD BILL</span><br/><span style="font-size:11px;">${escapeHtml(bill.bill_no)}</span><br/><span style="font-size:10px;">${escapeHtml(bill.created_at)}</span></div><div style="font-size:11px;margin-bottom:6px;">Customer: ${escapeHtml(bill.customer_name)}<br/>Phone: ${escapeHtml(bill.customer_phone)}<br/>Payment: ${escapeHtml(bill.payment_method)}</div><div style="border-top:1px dashed #000;padding-top:6px;font-size:11px;">${bill.items.map(i => `<div style="display:flex;justify-content:space-between;"><span>${escapeHtml(i.item_name)} x${i.qty}</span><span>${formatMoney(i.line_total)}</span></div>`).join("")}</div><div style="border-top:1px dashed #000;margin-top:6px;padding-top:6px;font-size:11px;"><div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${formatMoney(bill.subtotal)}</span></div><div style="display:flex;justify-content:space-between;"><span>Tax</span><span>${formatMoney(bill.tax)}</span></div><div style="display:flex;justify-content:space-between;"><span>Discount</span><span>−${formatMoney(bill.discount)}</span></div><div style="display:flex;justify-content:space-between;font-weight:bold;font-size:13px;margin-top:4px;"><span>GRAND TOTAL</span><span>${formatMoney(bill.grand_total)}</span></div></div><div style="text-align:center;margin-top:10px;font-size:10px;">Thank you, visit again!</div>`;
    window.print();
  }

  loadData();
})();
