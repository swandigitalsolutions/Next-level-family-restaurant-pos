(async function initAlcoholBilling() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("alcohol-billing", user);

  let CATEGORIES = [];
  let ITEMS = [];
  let TABLES = [];
  let CART = []; // {name, brand, bottle_size, price, qty, tax_rate, item_kind}
  let activeCategoryId = "all";
  let TARGET_SESSION_ID = "";

  async function loadData() {
    try {
      [CATEGORIES, ITEMS, TABLES] = await Promise.all([
        apiFetch("/alcohol/categories"),
        apiFetch("/alcohol/items"),
        apiFetch("/tables"),
      ]);
      renderTableTargets();
      renderCategories();
      renderItems();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderTableTargets() {
    const select = document.getElementById("alcoholTableTarget");
    if (!select) return;
    select.innerHTML = `<option value="">Counter sale</option>` + TABLES.filter(table => table.status === "open").map(table => `<option value="${table.session_id}">${escapeHtml(table.table_no)} · ${formatMoney(table.grand_total)}</option>`).join("");
    select.value = TARGET_SESSION_ID;
    select.addEventListener("change", async () => {
      TARGET_SESSION_ID = select.value;
      if (TARGET_SESSION_ID) {
        try {
          const session = await apiFetch(`/table-sessions/${TARGET_SESSION_ID}`);
          document.getElementById("customerName").value = session.customer_name === "Walk-in" ? "" : session.customer_name;
          document.getElementById("customerPhone").value = session.customer_phone === "-" ? "" : session.customer_phone;
          showToast(`Drinks will be added to ${session.table_no}`);
        } catch (err) { showToast(err.message, true); }
      }
    }, { once: true });
  }

  function renderCategories() {
    const list = document.getElementById("categoryList");
    let html = `<button class="cat-btn ${activeCategoryId === 'all' ? 'active' : ''}" data-id="all">All Products</button>`;
    html += CATEGORIES.filter(c => c.status === "active").map(c => `
      <button class="cat-btn ${activeCategoryId === c.id ? 'active' : ''}" data-id="${c.id}">
        ${escapeHtml(c.name)}
      </button>
    `).join("");
    list.innerHTML = html;

    list.querySelectorAll(".cat-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        activeCategoryId = id === "all" ? "all" : Number(id);
        renderCategories();
        renderItems();
      });
    });
  }

  function renderItems() {
    const grid = document.getElementById("itemGrid");
    const query = (document.getElementById("searchBox").value || "").toLowerCase().trim();

    let filtered = ITEMS;
    if (activeCategoryId !== "all") {
      filtered = filtered.filter(i => i.category_id === activeCategoryId);
    }
    if (query) {
      filtered = filtered.filter(i =>
        i.name.toLowerCase().includes(query) || (i.brand || "").toLowerCase().includes(query)
      );
    }

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="empty-state">No products found</div>`;
      return;
    }

    grid.innerHTML = filtered.map(i => {
      const soldOut = i.stock_qty !== null && i.stock_qty !== undefined && Number(i.stock_qty) <= 0;
      const lowStock = !soldOut && i.stock_qty !== null && i.stock_qty !== undefined && Number(i.stock_qty) <= 5;
      return `
      <div class="item-card ${soldOut ? "is-sold-out" : ""}"
           data-id="${i.id}"
           data-name="${escapeHtml(i.name)}"
           data-brand="${escapeHtml(i.brand || '')}"
           data-size="${escapeHtml(i.bottle_size || '')}"
           data-price="${i.price}"
           data-tax="${i.tax_rate}">
        <div class="item-card-image"><img src="${menuImage(i, "alcohol")}" alt="${escapeHtml(i.name)}" loading="lazy" decoding="async">${soldOut ? '<span class="stock-flag stock-out">Sold out</span>' : lowStock ? `<span class="stock-flag stock-low">${i.stock_qty} left</span>` : ""}</div>
        <div class="item-card-info"><div class="i-sub">${escapeHtml(i.brand || 'House selection')}${i.bottle_size ? ' · ' + escapeHtml(i.bottle_size) : ''}</div><div class="i-name">${escapeHtml(i.name)}</div><div class="i-price">${formatMoney(i.price)}</div><div class="i-tax">${soldOut ? "Out of stock" : `Tax ${i.tax_rate}%`}</div></div>
      </div>
    `;
    }).join("");

    grid.querySelectorAll(".item-card:not(.is-sold-out)").forEach(card => {
      card.addEventListener("click", () => {
          addToCart({
          item_id: Number(card.dataset.id),
          name: card.dataset.name,
          brand: card.dataset.brand,
          bottle_size: card.dataset.size,
          price: Number(card.dataset.price),
          tax_rate: Number(card.dataset.tax),
          item_kind: "alcohol",
        });
      });
    });
  }

  document.getElementById("searchBox").addEventListener("input", renderItems);

  function addToCart(product) {
    const existing = CART.find(c => product.item_id ? c.item_id === product.item_id : c.name === product.name);
    if (existing) {
      existing.qty += 1;
    } else {
      CART.push({ ...product, qty: 1 });
    }
    renderCart();
  }

  function renderCart() {
    const list = document.getElementById("cartList");
    if (CART.length === 0) {
      list.innerHTML = `<div class="empty-state">No items added yet</div>`;
    } else {
      list.innerHTML = CART.map((c, idx) => `
        <div class="cart-row">
          <span class="c-name">${escapeHtml(c.name)}</span>
          <span class="qty-ctrl">
            <button data-act="dec" data-idx="${idx}">−</button>
            <span>${c.qty}</span>
            <button data-act="inc" data-idx="${idx}">+</button>
          </span>
          <span class="c-total">${formatMoney(c.price * c.qty)}</span>
          <span class="c-remove" data-act="remove" data-idx="${idx}">&times;</span>
        </div>
      `).join("");
    }

    list.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const act = btn.dataset.act;
        if (act === "inc") CART[idx].qty += 1;
        if (act === "dec") { CART[idx].qty -= 1; if (CART[idx].qty <= 0) CART.splice(idx, 1); }
        if (act === "remove") CART.splice(idx, 1);
        renderCart();
      });
    });

    updateTotals();
  }

  function computeTotals() {
    const subtotal = CART.reduce((s, c) => s + c.price * c.qty, 0);
    const tax = CART.reduce((s, c) => s + (c.price * c.qty * c.tax_rate / 100), 0);
    const discount = computeDiscountAmount(subtotal);
    const grandTotal = Math.max(0, subtotal + tax - discount);
    return {
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      discount,
      grandTotal: Math.round(grandTotal * 100) / 100,
    };
  }

  function updateTotals() {
    const t = computeTotals();
    document.getElementById("tSubtotal").textContent = formatMoney(t.subtotal);
    document.getElementById("tTax").textContent = formatMoney(t.tax);
    document.getElementById("tDiscountLabel").textContent = discountRowLabel();
    document.getElementById("tDiscount").textContent = "− " + formatMoney(t.discount);
    document.getElementById("tGrandTotal").textContent = formatMoney(t.grandTotal);
    document.getElementById("confirmBillBtn").disabled = CART.length === 0;
  }
  document.getElementById("discountInput").addEventListener("input", updateTotals);
  setupDiscountMode(updateTotals);

  document.getElementById("clearCartBtn").addEventListener("click", () => {
    CART = [];
    renderCart();
  });

  // ---------------- Confirmation modal ----------------
  function openConfirmModal() {
    const t = computeTotals();
    const paymentMethod = document.getElementById("paymentMethod").value;
    const customerName = document.getElementById("customerName").value.trim() || "Walk-in";
    const customerPhone = document.getElementById("customerPhone").value.trim() || "-";

      const body = document.getElementById("confirmModalBody");
    const metaRows = TARGET_SESSION_ID
      ? `<div><strong>Table session:</strong> ${escapeHtml(TABLES.find(t => String(t.session_id) === String(TARGET_SESSION_ID))?.table_no || "Open table")}</div><div><strong>Customer:</strong> ${escapeHtml(customerName)}</div>`
      : `<div><strong>Customer:</strong> ${escapeHtml(customerName)}</div>`;
    body.innerHTML = `
      <div class="confirm-meta">
        ${metaRows}
        <div><strong>Phone:</strong> ${escapeHtml(customerPhone)}</div>
        <div><strong>Payment:</strong> ${escapeHtml(paymentMethod)}</div>
        <div><strong>Date:</strong> ${new Date().toLocaleString()}</div>
      </div>
      <div class="confirm-items">
        ${CART.map(c => `
          <div class="ci-row"><span>${escapeHtml(c.name)} x${c.qty}</span><span>${formatMoney(c.price * c.qty)}</span></div>
        `).join("")}
      </div>
      <div class="confirm-totals">
        <div class="t-row"><span>Subtotal</span><span>${formatMoney(t.subtotal)}</span></div>
        <div class="t-row"><span>Tax</span><span>${formatMoney(t.tax)}</span></div>
        <div class="t-row"><span>Discount</span><span>− ${formatMoney(t.discount)}</span></div>
        <div class="t-row grand"><span>Grand Total</span><span>${formatMoney(t.grandTotal)}</span></div>
      </div>
    `;
    document.getElementById("confirmModal").classList.add("show");
  }

  document.getElementById("confirmBillBtn").addEventListener("click", () => {
    if (CART.length === 0) return;
    openConfirmModal();
  });
  document.getElementById("closeModalBtn").addEventListener("click", () => {
    document.getElementById("confirmModal").classList.remove("show");
  });
  document.getElementById("editBillBtn").addEventListener("click", () => {
    document.getElementById("confirmModal").classList.remove("show");
  });

  // One key per sale, reused across retries - see billing.js for why.
  let PENDING_BILL_KEY = null;

  async function finalizeAlcoholBill(doPrint) {
    if (!PENDING_BILL_KEY) PENDING_BILL_KEY = newIdempotencyKey();
    const printBtn = document.getElementById("confirmPrintBtn");
    const onlyBtn = document.getElementById("confirmOnlyBtn");
    const labels = { [printBtn.id]: printBtn.textContent, [onlyBtn.id]: onlyBtn.textContent };
    [printBtn, onlyBtn].forEach(b => { b.disabled = true; });
    (doPrint ? printBtn : onlyBtn).textContent = "Saving…";

    const payload = {
      customer_name: document.getElementById("customerName").value.trim(),
      customer_phone: document.getElementById("customerPhone").value.trim(),
      items: CART,
      discount: computeTotals().discount,
      payment_method: document.getElementById("paymentMethod").value,
    };

    try {
      if (TARGET_SESSION_ID) {
        const snapshot = await apiFetch(`/table-sessions/${TARGET_SESSION_ID}`);
        const existing = (snapshot.items || []).map(item => ({ name: item.item_name, price: Number(item.price), qty: Number(item.qty), item_kind: item.item_kind, item_id: item.item_id || null, brand: item.brand || "", bottle_size: item.bottle_size || "", tax_rate: Number(item.tax_rate || 5) }));
        const merged = [...existing, ...CART];
        await apiFetch(`/table-sessions/${TARGET_SESSION_ID}`, { method: "PUT", body: { customer_name: customerName, customer_phone: customerPhone, items: merged } });
        const settled = await apiFetch(`/table-sessions/${TARGET_SESSION_ID}/settle`, { method: "POST", body: { payment_method: paymentMethod, discount: computeTotals().discount } });
        if (doPrint) printReceipt({ bill_no: `${settled.table_no} · TABLE BILL`, created_at: new Date().toLocaleString(), customer_name: customerName, customer_phone: customerPhone, payment_method: settled.payment_method, items: merged.map(item => ({ item_name: item.name, qty: item.qty, line_total: item.price * item.qty })), subtotal: settled.subtotal, tax: settled.tax, discount: settled.discount, grand_total: settled.grand_total });
        showToast(`${settled.table_no} settled successfully`);
        TARGET_SESSION_ID = "";
        renderTableTargets();
      } else {
        const bill = await apiFetch("/alcohol/bills", { method: "POST", idempotencyKey: PENDING_BILL_KEY, body: payload });
        showToast(`Bill ${bill.bill_no} confirmed`);
        if (doPrint) printReceipt(bill);
      }

      // Only clear cart after a successful save
      PENDING_BILL_KEY = null;   // this sale is banked; the next one is new
      CART = [];
      document.getElementById("customerName").value = "";
      document.getElementById("customerPhone").value = "";
      document.getElementById("discountInput").value = 0;
      document.getElementById("alcoholTableTarget").value = TARGET_SESSION_ID;
      renderCart();
      document.getElementById("confirmModal").classList.remove("show");
    } catch (err) {
      showToast(err.message, true);
      // Do NOT clear the cart on failure
    } finally {
      [printBtn, onlyBtn].forEach(b => { b.disabled = false; b.textContent = labels[b.id]; });
    }
  }

  document.getElementById("confirmPrintBtn").addEventListener("click", () => finalizeAlcoholBill(true));
  document.getElementById("confirmOnlyBtn").addEventListener("click", () => finalizeAlcoholBill(false));

  function printReceipt(bill) {
    const area = document.getElementById("printArea");
    area.innerHTML = `
      <div style="text-align:center;border-bottom:1px dashed #000;padding-bottom:6px;margin-bottom:6px;">
        <strong style="font-size:15px;">NEXT LEVEL FAMILY RESTAURANT</strong><br/>
        <span style="font-size:9px;">GSTIN: ${escapeHtml(RESTAURANT_GSTIN)}</span><br/>
        <span style="font-size:11px;">ALCOHOL BILL</span><br/>
        <span style="font-size:11px;">${escapeHtml(bill.bill_no)}</span><br/>
        <span style="font-size:10px;">${escapeHtml(bill.created_at)}</span>
      </div>
      <div style="font-size:11px;margin-bottom:6px;">
        Customer: ${escapeHtml(bill.customer_name)}<br/>
        Phone: ${escapeHtml(bill.customer_phone)}<br/>
        Payment: ${escapeHtml(bill.payment_method)}
      </div>
      <div style="border-top:1px dashed #000;padding-top:6px;font-size:11px;">
        ${bill.items.map(i => `
          <div style="display:flex;justify-content:space-between;">
            <span>${escapeHtml(i.item_name)} x${i.qty}</span><span>${formatMoney(i.line_total)}</span>
          </div>
        `).join("")}
      </div>
      <div style="border-top:1px dashed #000;margin-top:6px;padding-top:6px;font-size:11px;">
        <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${formatMoney(bill.subtotal)}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Tax</span><span>${formatMoney(bill.tax)}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Discount</span><span>−${formatMoney(bill.discount)}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:13px;margin-top:4px;">
          <span>GRAND TOTAL</span><span>${formatMoney(bill.grand_total)}</span>
        </div>
      </div>
      <div style="text-align:center;margin-top:10px;font-size:10px;">Thank you, visit again!</div>
    `;
    window.print();
  }

  loadData();
})();
