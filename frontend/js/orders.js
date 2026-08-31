(async function initOrders() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("orders", user);

  let ORDERS = [];

  async function loadOrders() {
    try {
      ORDERS = await apiFetch("/orders");
      renderOrders();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderOrders() {
    const query = (document.getElementById("searchBox").value || "").toLowerCase().trim();
    const typeFilter = document.getElementById("typeFilter").value;
    const dateFilter = document.getElementById("dateFilter").value; // YYYY-MM-DD

    let filtered = ORDERS;
    if (typeFilter !== "all") {
      filtered = filtered.filter(o => o.type === typeFilter);
    }
    if (dateFilter) {
      filtered = filtered.filter(o => (o.created_at || "").startsWith(dateFilter));
    }
    if (query) {
      filtered = filtered.filter(o =>
        o.bill_no.toLowerCase().includes(query) ||
        (o.customer_name || "").toLowerCase().includes(query)
      );
    }

    const body = document.getElementById("ordersBody");
    const emptyEl = document.getElementById("ordersEmpty");

    if (filtered.length === 0) {
      body.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    body.innerHTML = filtered.map(o => `
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
      btn.addEventListener("click", () => openViewModal(Number(btn.dataset.id), btn.dataset.type));
    });
  }

  document.getElementById("searchBox").addEventListener("input", renderOrders);
  document.getElementById("typeFilter").addEventListener("change", renderOrders);
  document.getElementById("dateFilter").addEventListener("change", renderOrders);
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    document.getElementById("searchBox").value = "";
    document.getElementById("typeFilter").value = "all";
    document.getElementById("dateFilter").value = "";
    renderOrders();
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
