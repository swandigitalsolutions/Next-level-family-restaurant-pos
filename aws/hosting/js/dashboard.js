(async function () {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("dashboard", user);
  document.getElementById("welcomeName").textContent = user.username || "Owner";
  // Owner is view-only — drop the "New food bill" shortcut.
  if (user.role === "owner") document.querySelector(".welcome-row .btn-primary")?.remove();

  const money = (value) => formatMoney(Number(value) || 0);
  const animateNumber = (el, target, formatter = (n) => n.toLocaleString("en-IN")) => {
    if (!el) return;
    const value = Number(target) || 0;
    const start = performance.now();
    const duration = 520;
    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = formatter(value * eased);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  document.querySelector(".welcome-row .eyebrow").textContent = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date()).toUpperCase();

  function buildSevenDayTrend(rows) {
    const map = new Map((rows || []).map((row) => [row.day, row]));
    const days = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - offset);
      const key = date.toISOString().slice(0, 10);
      days.push(map.get(key) || { day: key, label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date).toUpperCase(), total: 0, orders: 0 });
    }
    return days;
  }

  function renderSalesChart(rows) {
    const svg = document.getElementById("salesChart");
    const axis = document.getElementById("salesAxis");
    const data = buildSevenDayTrend(rows);
    const values = data.map((item) => Number(item.total) || 0);
    const max = Math.max(...values, 1);
    const left = 22, top = 22, width = 676, height = 176;
    const points = values.map((value, index) => {
      const x = left + (width / (values.length - 1)) * index;
      const y = top + height - ((value / max) * (height - 24));
      return [x, y];
    });
    const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const area = `${line} L ${points[points.length - 1][0]} ${top + height} L ${points[0][0]} ${top + height} Z`;
    const guides = [0, 1, 2, 3].map((step) => {
      const y = top + (height / 3) * step;
      return `<line class="chart-guide" x1="${left}" x2="${left + width}" y1="${y}" y2="${y}" />`;
    }).join("");
    const dots = points.map(([x, y], index) => `<circle class="chart-dot" cx="${x}" cy="${y}" r="${index === points.length - 1 ? 5 : 3.5}"><title>${data[index].label}: ${money(values[index])}</title></circle>`).join("");
    svg.innerHTML = `${guides}<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/>${dots}`;
    axis.innerHTML = data.map((item) => `<span>${item.label}</span>`).join("");
    const total = values.reduce((sum, value) => sum + value, 0);
    document.getElementById("chartTotal").textContent = money(total);
    const best = data.reduce((winner, item) => Number(item.total) > Number(winner.total) ? item : winner, data[0]);
    document.getElementById("chartInsight").textContent = best && Number(best.total) > 0 ? `${best.label} led the week at ${money(best.total)}` : "Capture your first bill to unlock the trend";
  }

  function renderTopItems(items) {
    const mount = document.getElementById("topItemsList");
    if (!items || !items.length) {
      mount.innerHTML = `<div class="empty-state">Top sellers will appear after your first order.</div>`;
      return;
    }
    const max = Math.max(...items.map((item) => Number(item.qty) || 0), 1);
    mount.innerHTML = items.slice(0, 5).map((item, index) => `
      <div class="rank-row"><span class="rank-number">0${index + 1}</span><div class="rank-info"><strong>${escapeHtml(item.name)}</strong><div class="rank-bar"><i style="width:${Math.max(8, (Number(item.qty) / max) * 100)}%"></i></div></div><span class="rank-value">${item.qty} sold</span></div>`).join("");
  }

  function renderHourlyFlow(rows) {
    const mount = document.getElementById("hourBars");
    const map = new Map((rows || []).map((row) => [Number(row.hour), Number(row.orders) || 0]));
    const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const values = hours.map((hour) => map.get(hour) || 0);
    const max = Math.max(...values, 1);
    const peakIndex = values.indexOf(Math.max(...values));
    mount.innerHTML = values.map((value, index) => `<span class="hour-bar ${index === peakIndex && value > 0 ? "peak" : ""}" style="height:${Math.max(8, (value / max) * 86)}%" title="${hours[index]}:00 — ${value} orders"></span>`).join("");
    document.getElementById("peakHourBadge").textContent = values[peakIndex] > 0 ? `Peak ${hours[peakIndex] > 12 ? hours[peakIndex] - 12 : hours[peakIndex]} ${hours[peakIndex] >= 12 ? "PM" : "AM"}` : "Peak pending";
  }

  function renderPaymentMix(rows, totalOrders) {
    const colors = ["#c8102e", "#f2a81d", "#3a1a17", "#d8bfb7"];
    const total = (rows || []).reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    let cursor = 0;
    const segments = (rows || []).map((row, index) => {
      const amount = Number(row.total) || 0;
      const start = total ? (cursor / total) * 100 : 0;
      cursor += amount;
      const end = total ? (cursor / total) * 100 : 0;
      return `${colors[index % colors.length]} ${start}% ${end}%`;
    });
    document.getElementById("paymentDonut").style.background = segments.length ? `conic-gradient(${segments.join(",")})` : "conic-gradient(#f2e9e2 0 100%)";
    document.getElementById("paymentTotal").textContent = money(total);
    document.getElementById("paymentCount").textContent = Number(totalOrders) || 0;
    const legend = document.getElementById("paymentLegend");
    legend.innerHTML = rows && rows.length ? rows.map((row, index) => `<div class="payment-row"><span><i style="background:${colors[index % colors.length]}"></i>${escapeHtml(row.method)}</span><strong>${total ? Math.round((Number(row.total) / total) * 100) : 0}%</strong></div>`).join("") : `<div class="empty-state">Payment mix will appear after your first order.</div>`;
  }

  function renderRecentOrders(rows) {
    const mount = document.getElementById("recentOrdersList");
    if (!rows || !rows.length) {
      mount.innerHTML = `<div class="empty-state">No orders captured yet.</div>`;
      return;
    }
    mount.innerHTML = rows.slice(0, 5).map((row) => {
      const time = new Date(String(row.created_at).replace(" ", "T")).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const isBar = row.type === "ALCOHOL";
      return `<a href="orders.html" class="recent-row"><span class="recent-avatar ${isBar ? "avatar-bar" : ""}">${isBar ? "B" : "F"}</span><span class="recent-copy"><strong>${escapeHtml(row.customer_name || "Walk-in customer")}</strong><small>${escapeHtml(row.bill_no)} · ${time}</small></span><span class="recent-amount">${money(row.grand_total)}</span></a>`;
    }).join("");
  }

  async function loadDashboard() {
    try {
      const data = await apiFetch("/dashboard");
      document.querySelectorAll(".stat-value.is-loading").forEach(el => el.classList.remove("is-loading"));
      document.getElementById("chartSkeleton")?.remove();
      animateNumber(document.getElementById("statTotalSales"), data.total_sales_today, money);
      animateNumber(document.getElementById("statFoodSales"), data.food_sales_today, money);
      animateNumber(document.getElementById("statAlcoholSales"), data.alcohol_sales_today, money);
      animateNumber(document.getElementById("statAverageBill"), data.total_bills_today ? data.total_sales_today / data.total_bills_today : 0, money);
      document.getElementById("statFoodBills").textContent = `${data.food_bills_today} bills`;
      document.getElementById("statAlcoholBills").textContent = `${data.alcohol_bills_today} bills`;
      document.getElementById("statTotalBills").textContent = `${data.total_bills_today} orders`;
      const totalSales = Number(data.total_sales_today) || 0;
      document.getElementById("foodProgress").style.width = `${totalSales ? Math.min(100, (data.food_sales_today / totalSales) * 100) : 0}%`;
      document.getElementById("barProgress").style.width = `${totalSales ? Math.min(100, (data.alcohol_sales_today / totalSales) * 100) : 0}%`;
      document.getElementById("foodMenuCount").textContent = data.menu_summary?.food_items || 0;
      document.getElementById("barMenuCount").textContent = data.menu_summary?.alcohol_items || 0;
      renderSalesChart(data.trend);
      renderTopItems(data.top_items);
      renderHourlyFlow(data.hourly_flow);
      renderPaymentMix(data.payment_mix, data.total_bills_today);
      renderRecentOrders(data.recent_orders);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  await loadDashboard();

  // Keep the numbers current while the screen is left open at the counter -
  // a fresh bill elsewhere shouldn't require a manual reload to show up here.
  // Paused while the tab is hidden/backgrounded so it doesn't poll for nothing.
  setInterval(() => { if (!document.hidden) loadDashboard(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadDashboard(); });
})();
