(async function initOrders() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("orders", user);

  if (user.role === "admin" || user.role === "manager") {
    document.getElementById("exportControls").hidden = false;
    document.getElementById("exportCsvBtn").addEventListener("click", () => {
      const from = document.getElementById("exportFrom").value;
      const to = document.getElementById("exportTo").value;
      const typeFilter = document.getElementById("typeFilter").value;
      const type = typeFilter === "FOOD" ? "food" : typeFilter === "ALCOHOL" ? "alcohol" : "all";
      const params = new URLSearchParams({ type });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      downloadCsv(`/reports/export?${params.toString()}`);
    });
  }

  async function downloadCsv(path) {
    // Firebase migration: exportReport is an HTTP Cloud Function behind the
    // Hosting rewrite /api/reports/export -> exportReport, authenticated with a
    // Bearer ID token. common.js.downloadReportCsv handles the token + blob.
    try {
      await window.downloadReportCsv(path);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // Filtering, search and paging all happen server-side now (see /api/orders) -
  // this page used to fetch every bill ever created on every visit, which was
  // fine with a handful of rows and would only get slower the longer the
  // restaurant stays open. Only the current page's worth of rows ever reaches
  // the browser.
  const PAGE_SIZE = 25;
  let offset = 0;
  let total = 0;
  let searchDebounce = null;

  async function loadOrders() {
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
      const typeFilter = document.getElementById("typeFilter").value;
      const dateFilter = document.getElementById("dateFilter").value;
      const query = document.getElementById("searchBox").value.trim();
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (dateFilter) params.set("date", dateFilter);
      if (query) params.set("search", query);

      const result = await apiFetch(`/orders?${params.toString()}`);
      total = result.total;
      renderOrders(result.orders);
      updatePager();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderOrders(orders) {
    const body = document.getElementById("ordersBody");
    const emptyEl = document.getElementById("ordersEmpty");

    if (orders.length === 0) {
      body.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    body.innerHTML = orders.map(o => `
      <tr>
        <td><strong>${escapeHtml(o.bill_no)}</strong></td>
        <td><span class="tag ${o.type === 'FOOD' ? 'tag-food' : 'tag-alcohol'}">${o.type}</span></td>
        <td>${escapeHtml(o.customer_name || '-')}</td>
        <td>${escapeHtml(o.created_at)}</td>
        <td>${formatMoney(o.grand_total)}</td>
        <td>${escapeHtml(o.payment_method)}</td>
        <td><span class="tag tag-active">${escapeHtml(o.status)}</span></td>
        <td><button class="view-link" data-id="${o.id}" data-type="${o.type}">View / Print</button></td>
      </tr>
    `).join("");

    body.querySelectorAll(".view-link").forEach(btn => {
      btn.addEventListener("click", () => openViewModal(btn.dataset.id, btn.dataset.type));
    });
  }

  function updatePager() {
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    document.getElementById("ordersPageInfo").textContent = `${from}–${to} of ${total}`;
    document.getElementById("ordersPrevBtn").disabled = offset === 0;
    document.getElementById("ordersNextBtn").disabled = offset + PAGE_SIZE >= total;
  }

  function resetAndLoad() {
    offset = 0;
    loadOrders();
  }

  document.getElementById("searchBox").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(resetAndLoad, 300);
  });
  document.getElementById("typeFilter").addEventListener("change", resetAndLoad);
  document.getElementById("dateFilter").addEventListener("change", resetAndLoad);
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    document.getElementById("searchBox").value = "";
    document.getElementById("typeFilter").value = "all";
    document.getElementById("dateFilter").value = "";
    resetAndLoad();
  });
  document.getElementById("ordersPrevBtn").addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    loadOrders();
  });
  document.getElementById("ordersNextBtn").addEventListener("click", () => {
    offset += PAGE_SIZE;
    loadOrders();
  });

  let currentBill = null;

  async function openViewModal(id, type) {
    try {
      const endpoint = type === "FOOD" ? `/food/bills/${id}` : `/alcohol/bills/${id}`;
      const bill = await apiFetch(endpoint);
      currentBill = bill;

      document.getElementById("viewModalTitle").textContent = `${bill.bill_no} — ${type}`;
      document.getElementById("viewModalBody").innerHTML = `
        <div class="confirm-meta">
          <div><strong>Customer:</strong> ${escapeHtml(bill.customer_name)}</div>
          <div><strong>Phone:</strong> ${escapeHtml(bill.customer_phone)}</div>
          <div><strong>Payment:</strong> ${escapeHtml(bill.payment_method)}</div>
          <div><strong>Date:</strong> ${escapeHtml(bill.created_at)}</div>
        </div>
        <div class="confirm-items">
          ${bill.items.map(i => `
            <div class="ci-row"><span>${escapeHtml(i.item_name)} x${i.qty}</span><span>${formatMoney(i.line_total)}</span></div>
          `).join("")}
        </div>
        <div class="confirm-totals">
          <div class="t-row"><span>Subtotal</span><span>${formatMoney(bill.subtotal)}</span></div>
          <div class="t-row"><span>Tax</span><span>${formatMoney(bill.tax)}</span></div>
          <div class="t-row"><span>Discount</span><span>− ${formatMoney(bill.discount)}</span></div>
          <div class="t-row grand"><span>Grand Total</span><span>${formatMoney(bill.grand_total)}</span></div>
        </div>
      `;
      document.getElementById("viewModal").classList.add("show");
    } catch (err) {
      showToast(err.message, true);
    }
  }

  document.getElementById("closeViewModalBtn").addEventListener("click", () => {
    document.getElementById("viewModal").classList.remove("show");
  });
  document.getElementById("closeViewBtn").addEventListener("click", () => {
    document.getElementById("viewModal").classList.remove("show");
  });

  document.getElementById("printViewBtn").addEventListener("click", () => {
    if (!currentBill) return;
    const bill = currentBill;
    const area = document.getElementById("printArea");
    area.innerHTML = `
      <div style="text-align:center;border-bottom:1px dashed #000;padding-bottom:6px;margin-bottom:6px;">
        <strong style="font-size:15px;">NEXT LEVEL FAMILY RESTAURANT</strong><br/>
        <span style="font-size:9px;">GSTIN: ${escapeHtml(RESTAURANT_GSTIN)}</span><br/>
        <span style="font-size:11px;">${bill.type} BILL</span><br/>
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
  });

  loadOrders();
})();
