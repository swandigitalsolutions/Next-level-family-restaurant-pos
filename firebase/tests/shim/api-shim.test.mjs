/**
 * api-shim.js routing/mapping coverage — every path the migrated page scripts
 * call must resolve to the right Firestore query or Cloud Function, and the
 * returned rows must be in the Flask JSON shape the page scripts expect.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeApiFetch, orderAlertDecision, websiteOrderAlertDecision, kitchenAlertDecision } from "../../hosting/js/api-shim.js";
import { makeFakeFirestore } from "./fake-firestore.mjs";

function harness(seed = {}) {
  const { db, fs, store, calls } = makeFakeFirestore(seed);
  const callLog = [];
  const call = async (name, data) => {
    callLog.push({ name, data });
    return CALL_RESULTS[name] ? CALL_RESULTS[name](data) : { ok: true };
  };
  let user = { id: "u_2", uid: "u_2", username: "cashier1", full_name: "Cashier", role: "staff" };
  const apiFetch = makeApiFetch({
    db, call, fs,
    auth: {},
    signInWithCustomToken: async () => {},
    signOut: async () => { user = null; },
    setUser: (u) => { user = u; },
    getUser: async () => user,
  });
  return { apiFetch, callLog, store, calls, setUser: (u) => (user = u) };
}

const CALL_RESULTS = {
  loginWithPassword: () => ({ token: "tok", user: { id: "u_1", username: "admin", full_name: "Admin", role: "admin" } }),
  listStaff: () => ({ staff: [{ id: "u_1", username: "admin", full_name: "Admin", phone: "", role: "admin", status: "active" }] }),
  createBill: (d) => ({ id: "bill_x", billNo: d.type === "FOOD" ? "FOOD-000001" : d.type === "CAFE" ? "CAFE-000001" : "ALC-000001", type: d.type, tableId: null, tableSessionId: null, customerName: "-", customerPhone: "-", subtotal: 100, discount: 0, tax: d.type === "CAFE" ? 0 : 5, grandTotal: d.type === "CAFE" ? 100 : 105, paymentMethod: "Cash", status: "confirmed", createdAt: new Date("2026-09-01T08:00:00Z"), items: [{ itemName: "x", price: 100, qty: 1, lineTotal: 100 }] }),
  openTable: () => ({ session: { id: "sess_1", tableId: "tbl_1", tableNo: "Table 01", customerName: "Walk-in", customerPhone: "-", status: "open", openedAt: new Date(), settledAt: null, items: [] }, created: true }),
  settleTable: () => ({ table_no: "Table 01", session_id: "sess_1", bills: [{ type: "FOOD", id: "b1", bill_no: "FOOD-000001" }], subtotal: 100, tax: 5, discount: 0, grand_total: 105, payment_method: "Cash" }),
  upsertCategory: (d) => ({ id: d.id || "cat_new", ...d }),
  deleteCategory: () => ({ message: "Category deleted" }),
  upsertCatalogItem: (d) => ({ id: d.id || "item_new", ...d }),
  deleteCatalogItem: () => ({ message: "Item deleted" }),
  createTable: (d) => ({ id: "tbl_new", ...d }),
  updateTable: (d) => ({ id: d.id, ...d }),
  regenerateQrToken: (d) => ({ id: d.id, qr_token: "newtok" }),
  createStaff: (d) => ({ id: "u_new", ...d }),
  updateStaff: (d) => ({ id: d.uid, ...d }),
  deactivateStaff: () => ({ message: "Staff account deactivated" }),
  setQrOrderStatus: (d) => ({ ref: d.ref, status: d.status }),
  pushQrOrderToBill: (d) => ({ ref: d.ref, table_session_id: "sess_1" }),
  setWebsiteOrderStatus: (d) => ({ id: d.order_id, order_status: d.status, payment_status: "deposit_paid" }),
  addItemsToWebsiteOrder: (d) => ({ id: d.order_id, items: d.items, total: 820, balance_amount: 710 }),
  settleWebsiteOrder: (d) => ({ order_id: d.order_id, bills: [{ type: "FOOD", id: "b1", bill_no: "FOOD-000001" }], grand_total: 220, balance_collected: 110 }),
  acceptOrderToKitchen: (d) => ({ id: "kt_1", source: d.source, ref: d.source === "qr" ? "QR-000001" : "WEB-000009", status: "QUEUED", items: [{ name: "Paneer Tikka", kind: "food", qty: 2, note: "" }] }),
  setKitchenTicketStatus: (d) => ({ id: d.id, status: d.status }),
};

// ------------------------------------------------------------------ auth

test("/me returns the session user; unauthenticated throws", async () => {
  const h = harness();
  assert.deepEqual(await h.apiFetch("/me"), { id: "u_2", username: "cashier1", role: "staff", full_name: "Cashier" });
  h.setUser(null);
  await assert.rejects(() => h.apiFetch("/me"));
});

test("/login calls loginWithPassword + signs in", async () => {
  const h = harness();
  const u = await h.apiFetch("/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "x" }) });
  assert.equal(u.role, "admin");
  assert.equal(h.callLog[0].name, "loginWithPassword");
});

test("/logout signs out", async () => {
  const h = harness();
  assert.deepEqual(await h.apiFetch("/logout", { method: "POST" }), { message: "Logged out" });
});

// --------------------------------------------------------------- catalog

test("GET /food/categories -> categories where kind==food, mapped to Flask row", async () => {
  const h = harness({
    categories: {
      c1: { kind: "food", name: "Starters", nameLower: "starters", sortOrder: 0, status: "active" },
      c2: { kind: "alcohol", name: "Beer", nameLower: "beer", sortOrder: 0, status: "active" },
    },
  });
  const rows = await h.apiFetch("/food/categories");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: "c1", name: "Starters", status: "active", sort_order: 0, kind: "food", sales_channel: "RESTAURANT" });
});

test("GET /alcohol/items -> catalog where kind==alcohol,status==active, Flask row shape", async () => {
  const h = harness({
    catalog: {
      a1: { kind: "alcohol", name: "Kingfisher", nameLower: "kingfisher", categoryId: "cat_alc_1", categoryName: "Beer", categorySort: 0, price: 180, taxRate: 18, stockQty: 24, brand: "KF", bottleSize: "650ml", description: null, status: "active" },
      f1: { kind: "food", name: "Dal", nameLower: "dal", categoryId: "cat_food_1", categoryName: "Mains", categorySort: 1, price: 190, taxRate: 0, stockQty: null, status: "active" },
    },
  });
  const rows = await h.apiFetch("/alcohol/items");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "a1", name: "Kingfisher", category_id: "cat_alc_1", category_name: "Beer",
    price: 180, stock_qty: 24, description: null, brand: "KF", bottle_size: "650ml",
    tax_rate: 18, status: "active", kind: "alcohol", sales_channel: "RESTAURANT",
  });
});

test("GET /food/items?category_id filters to that category", async () => {
  const h = harness({
    catalog: {
      f1: { kind: "food", name: "A", nameLower: "a", categoryId: "cat_food_1", categoryName: "X", categorySort: 0, price: 10, taxRate: 0, stockQty: null, status: "active" },
      f2: { kind: "food", name: "B", nameLower: "b", categoryId: "cat_food_2", categoryName: "Y", categorySort: 1, price: 20, taxRate: 0, stockQty: null, status: "active" },
    },
  });
  const rows = await h.apiFetch("/food/items?category_id=cat_food_2");
  assert.deepEqual(rows.map((r) => r.name), ["B"]);
});

test("category + item write routes hit the right callables", async () => {
  const h = harness();
  await h.apiFetch("/food/categories", { method: "POST", body: JSON.stringify({ name: "New" }) });
  await h.apiFetch("/food/categories/c1", { method: "PUT", body: JSON.stringify({ name: "Ren" }) });
  await h.apiFetch("/alcohol/categories/c1", { method: "DELETE" });
  await h.apiFetch("/food/items", { method: "POST", body: JSON.stringify({ name: "I", category_id: "c1", price: 1 }) });
  await h.apiFetch("/alcohol/items/i1", { method: "PUT", body: JSON.stringify({ price: 2 }) });
  await h.apiFetch("/food/items/i1", { method: "DELETE" });
  assert.deepEqual(h.callLog.map((c) => c.name), [
    "upsertCategory", "upsertCategory", "deleteCategory", "upsertCatalogItem", "upsertCatalogItem", "deleteCatalogItem",
  ]);
  assert.equal(h.callLog[0].data.kind, "food");
  assert.equal(h.callLog[3].data.kind, "food");
  assert.equal(h.callLog[4].data.kind, "alcohol");
});

// ----------------------------------------------------------------- tables

test("GET /tables joins open sessions -> Flask floor rows", async () => {
  const h = harness({
    tables: {
      tbl_1: { tableNo: "Table 01", seats: 4, status: "occupied", qrToken: "t1" },
      tbl_2: { tableNo: "Table 02", seats: 4, status: "available", qrToken: "t2" },
    },
    tableSessions: {
      s1: { tableId: "tbl_1", tableNo: "Table 01", status: "open", customerName: "Priya", customerPhone: "9", openedAt: new Date(), items: [{ price: 220, qty: 2, taxRate: 5 }] },
    },
  });
  const rows = await h.apiFetch("/tables");
  const t1 = rows.find((r) => r.id === "tbl_1");
  const t2 = rows.find((r) => r.id === "tbl_2");
  assert.equal(t1.status, "open");
  assert.equal(t1.session_id, "s1");
  assert.equal(t1.subtotal, 440);
  assert.equal(t1.tax, 22);
  assert.equal(t1.grand_total, 462);
  assert.equal(t1.item_count, 2);
  assert.equal(t2.status, "available");
  assert.equal(t2.session_id, null);
});

test("POST /tables/:id/open -> openTable callable, returns session row", async () => {
  const h = harness();
  const s = await h.apiFetch("/tables/tbl_1/open", { method: "POST", body: JSON.stringify({ customer_name: "P" }) });
  assert.equal(h.callLog[0].name, "openTable");
  assert.equal(s.status, "open");
  assert.ok(Array.isArray(s.items));
});

test("PUT /table-sessions/:id recomputes line totals + persists (rules-guarded write)", async () => {
  const h = harness({ tableSessions: { s1: { tableId: "tbl_1", tableNo: "Table 01", status: "open", customerName: "x", customerPhone: "-", openedAt: new Date(), items: [] } } });
  await h.apiFetch("/table-sessions/s1", {
    method: "PUT",
    body: JSON.stringify({ customer_name: "Priya", items: [{ name: "Paneer", price: 220, qty: 2, item_kind: "food", tax_rate: 5, item_id: "item_food_1" }] }),
  });
  const [, patch] = h.calls.updateDoc[0];
  assert.equal(patch.items[0].lineTotal, 440);
  assert.equal(patch.subtotal, 440);
  assert.equal(patch.tax, 22);
  assert.equal(patch.customerName, "Priya");
  assert.equal(patch.items[0].itemId, "item_food_1");
});

test("POST /table-sessions/:id/settle -> settleTable callable", async () => {
  const h = harness();
  const r = await h.apiFetch("/table-sessions/s1/settle", { method: "POST", body: JSON.stringify({ payment_method: "UPI", discount: 50 }) });
  assert.equal(h.callLog[0].name, "settleTable");
  assert.deepEqual(h.callLog[0].data, { session_id: "s1", payment_method: "UPI", discount: 50 });
  assert.equal(r.grand_total, 105);
});

// ------------------------------------------------------------------ bills

test("POST /food/bills -> createBill FOOD; POST /alcohol/bills -> createBill ALCOHOL", async () => {
  const h = harness();
  const f = await h.apiFetch("/food/bills", { method: "POST", body: JSON.stringify({ items: [{ name: "x", price: 100, qty: 1 }], tax_percent: 5 }) });
  assert.equal(h.callLog[0].data.type, "FOOD");
  assert.equal(f.bill_no, "FOOD-000001");
  assert.equal(f.type, "FOOD");
  assert.equal(f.items[0].line_total, 100);
  const a = await h.apiFetch("/alcohol/bills", { method: "POST", body: JSON.stringify({ items: [{ name: "y", price: 180, qty: 1, tax_rate: 18 }] }) });
  assert.equal(h.callLog[1].data.type, "ALCOHOL");
  assert.equal(a.bill_no, "ALC-000001");
});

test("GET /food/bills + GET /food/bills/:id map to Flask bill rows", async () => {
  const h = harness({
    bills: {
      b1: { billNo: "FOOD-000001", type: "FOOD", customerName: "R", customerPhone: "9", subtotal: 100, discount: 0, tax: 5, grandTotal: 105, paymentMethod: "Cash", status: "confirmed", createdAt: new Date("2026-09-01T10:00:00Z"), items: [{ itemName: "x", price: 100, qty: 1, lineTotal: 100 }] },
      b2: { billNo: "ALC-000001", type: "ALCOHOL", customerName: "-", customerPhone: "-", subtotal: 180, discount: 0, tax: 32.4, grandTotal: 212.4, paymentMethod: "Card", status: "confirmed", createdAt: new Date("2026-09-01T11:00:00Z"), items: [] },
    },
  });
  const list = await h.apiFetch("/food/bills?limit=50");
  assert.deepEqual(list.map((b) => b.bill_no), ["FOOD-000001"]);
  const one = await h.apiFetch("/food/bills/b1");
  assert.equal(one.grand_total, 105);
  assert.equal(one.items[0].item_name, "x");
  assert.equal(one.type, "FOOD");
});

// ----------------------------------------------------------------- orders

test("GET /orders filters by type/date/search, paginates, returns {orders,total,limit,offset}", async () => {
  const h = harness({
    bills: {
      b1: { billNo: "FOOD-000001", type: "FOOD", customerName: "Ramesh", searchTokens: ["ram", "food-000001"], dateKey: "2026-09-01", grandTotal: 100, paymentMethod: "Cash", status: "confirmed", createdAt: new Date("2026-09-01T10:00:00Z") },
      b2: { billNo: "FOOD-000002", type: "FOOD", customerName: "Sita", searchTokens: ["si", "sita", "food-000002"], dateKey: "2026-09-02", grandTotal: 200, paymentMethod: "Cash", status: "confirmed", createdAt: new Date("2026-09-02T10:00:00Z") },
      b3: { billNo: "ALC-000001", type: "ALCOHOL", customerName: "Ramesh", searchTokens: ["ram", "alc-000001"], dateKey: "2026-09-01", grandTotal: 300, paymentMethod: "Card", status: "confirmed", createdAt: new Date("2026-09-01T12:00:00Z") },
    },
  });
  const all = await h.apiFetch("/orders?limit=25");
  assert.equal(all.total, 3);
  assert.equal(all.orders[0].bill_no, "FOOD-000002"); // newest createdAt first (Sep 2)

  const food = await h.apiFetch("/orders?type=FOOD");
  assert.deepEqual(food.orders.map((o) => o.bill_no).sort(), ["FOOD-000001", "FOOD-000002"]);

  const byDate = await h.apiFetch("/orders?date=2026-09-01");
  assert.equal(byDate.total, 2);

  const search = await h.apiFetch("/orders?search=ram");
  assert.deepEqual(search.orders.map((o) => o.bill_no).sort(), ["ALC-000001", "FOOD-000001"]);

  const page2 = await h.apiFetch("/orders?limit=1&offset=1");
  assert.equal(page2.orders.length, 1);
  assert.equal(page2.offset, 1);
});

// -------------------------------------------------------------- dashboard

test("GET /dashboard remaps stats/rolling to the Flask /api/dashboard shape", async () => {
  const h = harness({
    stats: {
      rolling: {
        today: { foodSales: 756, alcoholSales: 637.2, totalSales: 1393.2, foodBills: 2, alcoholBills: 1, totalBills: 3 },
        trend: [{ day: "2026-09-01", label: "MON", total: 1393.2, orders: 3 }],
        paymentMix: [{ method: "Cash", total: 1099.2, orders: 2 }],
        topItems: [{ name: "Kingfisher", qty: 3, total: 540 }],
        hourlyFlow: [{ hour: 13, orders: 3, total: 1393.2 }],
        recentOrders: [{ id: "b1", bill_no: "FOOD-000001", customer_name: "R", grand_total: 100, payment_method: "Cash", created_at: "2026-09-01T10:00:00.000Z", type: "FOOD" }],
        menuSummary: { foodItems: 3, alcoholItems: 1, foodCategories: 2, alcoholCategories: 1 },
      },
    },
  });
  const d = await h.apiFetch("/dashboard");
  assert.equal(d.food_sales_today, 756);
  assert.equal(d.total_bills_today, 3);
  assert.equal(d.payment_mix[0].method, "Cash");
  assert.equal(d.top_items[0].name, "Kingfisher");
  assert.equal(d.menu_summary.food_items, 3);
  assert.equal(d.recent_orders[0].bill_no, "FOOD-000001");
});

// -------------------------------------------------------------- audit-log

test("GET /audit-log maps rows, supports entity_type + action-prefix + paging", async () => {
  const h = harness({
    auditLog: {
      a1: { actorUid: "u_2", actorUsername: "c1", actorRole: "staff", action: "bill.create", entityType: "food_bill", entityId: "b1", details: { bill_no: "FOOD-000001" }, createdAt: new Date("2026-09-01T10:00:00Z") },
      a2: { actorUid: "u_1", actorUsername: "admin", actorRole: "admin", action: "staff.update", entityType: "user", entityId: "u_2", details: {}, createdAt: new Date("2026-09-02T10:00:00Z") },
      a3: { actorUid: "u_1", actorUsername: "admin", actorRole: "admin", action: "staff.create", entityType: "user", entityId: "u_3", details: {}, createdAt: new Date("2026-09-03T10:00:00Z") },
    },
  });
  const all = await h.apiFetch("/audit-log?limit=50");
  assert.equal(all.total, 3);
  assert.equal(all.entries[0].action, "staff.create"); // newest first
  assert.equal(all.entries[0].actor_id, "u_1");

  const users = await h.apiFetch("/audit-log?entity_type=user");
  assert.equal(users.total, 2);

  const staffActions = await h.apiFetch("/audit-log?action=staff.");
  assert.deepEqual(staffActions.entries.map((e) => e.action).sort(), ["staff.create", "staff.update"]);
});

// -------------------------------------------------------- QR ordering (staff)

test("GET /qr-ordering/tables -> table cards with order counts + menu_url", async () => {
  const today = new Date();
  const dk = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const h = harness({
    tables: { tbl_1: { tableNo: "Table 01", seats: 4, status: "occupied", qrToken: "tok1" } },
    qrOrders: {
      o1: { tableId: "tbl_1", status: "NEW", orderNo: "QR-000001", dateKey: dk },
      o2: { tableId: "tbl_1", status: "SERVED", orderNo: "QR-000002", dateKey: dk },
      o3: { tableId: "tbl_1", status: "NEW", orderNo: "QR-000000", dateKey: "2000-01-01" }, // old — excluded
    },
  });
  const rows = await h.apiFetch("/qr-ordering/tables");
  assert.equal(rows[0].new_orders, 1);
  assert.equal(rows[0].open_orders, 1);
  assert.match(rows[0].menu_url, /\/menu\/tok1$/);
});

test("GET /qr-ordering/orders filters by status / scope=active / today", async () => {
  const today = new Date();
  const dk = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const h = harness({
    qrOrders: {
      o1: { orderNo: "QR-000001", tableId: "tbl_1", tableNo: "Table 01", status: "NEW", subtotal: 100, tax: 0, grandTotal: 100, pushedToBill: false, dateKey: dk, createdAt: new Date(Date.now() - 1000), items: [] },
      o2: { orderNo: "QR-000002", tableId: "tbl_1", tableNo: "Table 01", status: "SERVED", subtotal: 50, tax: 0, grandTotal: 50, pushedToBill: true, dateKey: dk, createdAt: new Date(), items: [] },
      o3: { orderNo: "QR-000003", tableId: "tbl_1", tableNo: "Table 01", status: "NEW", subtotal: 10, tax: 0, grandTotal: 10, pushedToBill: false, dateKey: "2000-01-01", createdAt: new Date(0), items: [] },
    },
  });
  const todayNew = await h.apiFetch("/qr-ordering/orders?status=NEW");
  assert.deepEqual(todayNew.orders.map((o) => o.order_no), ["QR-000001"]); // o3 is not today
  const active = await h.apiFetch("/qr-ordering/orders?scope=active");
  assert.deepEqual(active.orders.map((o) => o.order_no), ["QR-000001"]);
  const allScope = await h.apiFetch("/qr-ordering/orders?scope=all");
  assert.equal(allScope.orders.length, 3);
});

test("GET /qr-ordering/pulse -> counts + latest_id + arrivals after marker", async () => {
  const h = harness({
    qrOrders: {
      o1: { orderNo: "QR-000001", tableNo: "T1", status: "NEW", grandTotal: 100, createdAt: new Date(1), items: [{ qty: 2 }] },
      o2: { orderNo: "QR-000002", tableNo: "T1", status: "ACCEPTED", grandTotal: 50, createdAt: new Date(2), items: [{ qty: 1 }] },
    },
  });
  const p = await h.apiFetch("/qr-ordering/pulse?after=1");
  assert.equal(p.new_count, 1);
  assert.equal(p.active_count, 2);
  assert.equal(p.latest_id, 2);
  assert.deepEqual(p.new.map((x) => x.order_no), ["QR-000002"]);
});

test("QR status + push-to-bill + regenerate map to callables", async () => {
  const h = harness();
  await h.apiFetch("/qr-ordering/orders/ref1/status", { method: "POST", body: JSON.stringify({ status: "ACCEPTED" }) });
  await h.apiFetch("/qr-ordering/orders/ref1/push-to-bill", { method: "POST" });
  await h.apiFetch("/qr-ordering/tables/tbl_1/regenerate-qr", { method: "POST" });
  assert.deepEqual(h.callLog.map((c) => c.name), ["setQrOrderStatus", "pushQrOrderToBill", "regenerateQrToken"]);
  assert.deepEqual(h.callLog[0].data, { ref: "ref1", status: "ACCEPTED" });
});

test("staff CRUD routes map to callables", async () => {
  const h = harness();
  await h.apiFetch("/staff");
  await h.apiFetch("/staff", { method: "POST", body: JSON.stringify({ username: "x", password: "secret1", full_name: "X" }) });
  await h.apiFetch("/staff/u_3", { method: "PUT", body: JSON.stringify({ role: "manager" }) });
  await h.apiFetch("/staff/u_3", { method: "DELETE" });
  assert.deepEqual(h.callLog.map((c) => c.name), ["listStaff", "createStaff", "updateStaff", "deactivateStaff"]);
  assert.equal(h.callLog[2].data.uid, "u_3");
});

// ------------------------------------------------- Website Orders (POS board)

const webSeed = () => ({
  websiteOrders: {
    w1: {
      ref: "WEB-000001", channel: "website", status: "CONFIRMED", paymentStatus: "ADVANCE_PAID",
      customer: { name: "Asha", phone: "9811", email: "a@x.com" },
      fulfillment: { type: "pickup", pickupAt: new Date("2026-09-10T12:30:00Z"), notes: "ring bell" },
      items: [{ itemId: "item_food_1", name: "Paneer", kind: "food", unitPricePaise: 22000, qty: 1, taxRatePct: 0, lineTotalPaise: 22000 }],
      subtotalPaise: 22000, taxPaise: 0, totalPaise: 22000, advancePaise: 11000, balancePaise: 11000, paidPaise: 11000,
      settledBillNos: [], createdAt: new Date("2026-09-03T10:00:00Z"), confirmedAt: new Date("2026-09-03T10:01:00Z"),
    },
    w2: {
      ref: "WEB-000002", channel: "website", status: "COMPLETED", paymentStatus: "ADVANCE_PAID",
      customer: { name: "Bala", phone: "9822", email: "" },
      fulfillment: { type: "pickup", pickupAt: null, notes: "" },
      items: [], subtotalPaise: 50000, taxPaise: 0, totalPaise: 50000, advancePaise: 25000, balancePaise: 0, paidPaise: 50000,
      settledBillNos: ["FOOD-000009"], settledBillIds: ["bx"], createdAt: new Date("2026-09-03T09:00:00Z"),
    },
  },
});

test("GET /website-orders lists recent, maps to POS rows (paise) with bill status", async () => {
  const h = harness(webSeed());
  const { orders } = await h.apiFetch("/website-orders");
  assert.equal(orders.length, 2);
  assert.equal(orders[0].ref, "WEB-000001"); // newest first
  assert.equal(orders[0].order_no, "WEB-000001"); // alias kept
  assert.equal(orders[0].balance_paise, 11000);
  assert.equal(orders[0].total_paise, 22000);
  assert.equal(orders[0].bill_status, "unbilled");
  const settled = orders.find((o) => o.ref === "WEB-000002");
  assert.equal(settled.bill_status, "billed");
  assert.deepEqual(settled.settled_bill_nos, ["FOOD-000009"]);
});

test("GET /website-orders?order_no= is an exact human Order-ID lookup", async () => {
  const h = harness(webSeed());
  const hit = await h.apiFetch("/website-orders?order_no=WEB-000002");
  assert.equal(hit.orders.length, 1);
  assert.equal(hit.orders[0].customer_name, "Bala");
  const norm = await h.apiFetch("/website-orders?order_no=web000002"); // loose form normalised
  assert.equal(norm.orders[0]?.ref, "WEB-000002");
});

test("GET /website-orders?scope=active + ?customer= filter", async () => {
  const h = harness(webSeed());
  const active = await h.apiFetch("/website-orders?scope=active");
  assert.deepEqual(active.orders.map((o) => o.ref), ["WEB-000001"]); // COMPLETED filtered out
  const byName = await h.apiFetch("/website-orders?customer=bala");
  assert.deepEqual(byName.orders.map((o) => o.ref), ["WEB-000002"]);
});

test("GET /website-orders/:id maps one order (paise); unknown -> error", async () => {
  const h = harness(webSeed());
  const o = await h.apiFetch("/website-orders/w1");
  assert.equal(o.ref, "WEB-000001");
  assert.equal(o.items[0].unit_price_paise, 22000);
  assert.equal(o.advance_paise, 11000);
  await assert.rejects(() => h.apiFetch("/website-orders/nope"), /not found/i);
});

test("website order status / add-items / settle map to their callables", async () => {
  const h = harness();
  await h.apiFetch("/website-orders/w1/status", { method: "POST", body: JSON.stringify({ status: "PREPARING" }) });
  await h.apiFetch("/website-orders/w1/add-items", { method: "POST", body: JSON.stringify({ items: [{ id: "item_food_3", kind: "food", qty: 2 }] }) });
  const res = await h.apiFetch("/website-orders/w1/settle", { method: "POST", body: JSON.stringify({ payment_method: "Cash" }) });
  assert.deepEqual(h.callLog.map((c) => c.name), ["setWebsiteOrderStatus", "addItemsToWebsiteOrder", "settleWebsiteOrder"]);
  assert.deepEqual(h.callLog[0].data, { order_id: "w1", status: "PREPARING" });
  assert.equal(h.callLog[1].data.items[0].id, "item_food_3");
  assert.equal(res.bills[0].bill_no, "FOOD-000001");
});

test("bill rows expose the website Order-ID reference", async () => {
  const h = harness({
    bills: { b1: { billNo: "FOOD-000009", type: "FOOD", source: "website", websiteOrderId: "w2", websiteOrderNo: "WEB-000002", customerName: "Bala", customerPhone: "9822", subtotal: 500, discount: 0, tax: 0, grandTotal: 500, paymentMethod: "Cash", status: "confirmed", createdAt: new Date(), items: [] } },
  });
  const one = await h.apiFetch("/food/bills/b1");
  assert.equal(one.website_order_no, "WEB-000002");
  assert.equal(one.source, "website");
});

test("websiteOrderAlertDecision: one new -> 'Website Order Received · <name> · WEB-… · ₹total' (paise doc)", async () => {
  const mk = (ref, name, totalPaise) => ({ ref, customer: { name }, totalPaise });
  const seed = websiteOrderAlertDecision(0, [mk("WEB-000004", "Asha", 65240)]);
  assert.equal(seed.chime, false);
  const one = websiteOrderAlertDecision(3, [mk("WEB-000004", "Asha", 65240)]);
  assert.equal(one.chime, true);
  assert.equal(one.prompt, "Website Order Received · Asha · WEB-000004 · ₹652.40");
  const many = websiteOrderAlertDecision(2, [mk("WEB-000003", "A", 100), mk("WEB-000004", "B", 200)]);
  assert.equal(many.prompt, "2 new website orders");
});

// ------------------------------------------------- Cafe billing

test("cafe: only OUTSIDE_CAFE products show; restaurant items hidden; /cafe/bills posts a CAFE createBill", async () => {
  const h = harness({
    categories: {
      cc1: { kind: "cafe", salesChannel: "OUTSIDE_CAFE", name: "Coffee", nameLower: "coffee", sortOrder: 0, status: "active" },
      fc1: { kind: "food", salesChannel: "RESTAURANT", name: "Mains", nameLower: "mains", sortOrder: 0, status: "active" },
    },
    catalog: {
      ic1: { kind: "cafe", salesChannel: "OUTSIDE_CAFE", name: "Filter Coffee", nameLower: "filter coffee", categoryId: "cc1", categorySort: 0, price: 40, taxRate: 0, stockQty: null, status: "active" },
      if1: { kind: "food", salesChannel: "RESTAURANT", name: "Butter Chicken", nameLower: "butter chicken", categoryId: "fc1", categorySort: 0, price: 280, taxRate: 0, stockQty: 5, status: "active" },
    },
  });
  const cats = await h.apiFetch("/cafe/categories");
  assert.deepEqual(cats.map((c) => c.name), ["Coffee"]); // restaurant category excluded
  const items = await h.apiFetch("/cafe/items");
  assert.deepEqual(items.map((i) => i.name), ["Filter Coffee"]); // Butter Chicken (RESTAURANT) hidden
  assert.equal(items[0].kind, "cafe");
  assert.equal(items[0].sales_channel, "OUTSIDE_CAFE");
  assert.equal(items[0].price, 40);
  // and the reverse: a restaurant billing screen never lists the cafe item
  const foodItems = await h.apiFetch("/food/items");
  assert.deepEqual(foodItems.map((i) => i.name), ["Butter Chicken"]);

  const bill = await h.apiFetch("/cafe/bills", { method: "POST", body: JSON.stringify({ items: [{ item_id: "ic1", name: "Filter Coffee", price: 40, qty: 2 }], payment_method: "Cash" }) });
  assert.equal(h.callLog[0].name, "createBill");
  assert.equal(h.callLog[0].data.type, "CAFE");
  assert.equal(bill.bill_no, "CAFE-000001");
  assert.equal(bill.type, "CAFE");
});

// ------------------------------------------------- Kitchen screen

test("kitchen: accept routes (qr + website) and ticket-status route hit their callables", async () => {
  const h = harness();
  await h.apiFetch("/qr-ordering/orders/ref1/accept", { method: "POST" });
  await h.apiFetch("/website-orders/w1/accept", { method: "POST" });
  await h.apiFetch("/kitchen/tickets/kt_1/status", { method: "POST", body: JSON.stringify({ status: "PREPARING" }) });
  assert.deepEqual(h.callLog.map((c) => c.name), ["acceptOrderToKitchen", "acceptOrderToKitchen", "setKitchenTicketStatus"]);
  assert.deepEqual(h.callLog[0].data, { source: "qr", id: "ref1" });
  assert.deepEqual(h.callLog[1].data, { source: "website", id: "w1" });
  assert.deepEqual(h.callLog[2].data, { id: "kt_1", status: "PREPARING" });
});

test("kitchenAlertDecision: chimes once per new QUEUED ticket; survives reload/reconnect", async () => {
  const T = (id, status, ms) => ({ id, status, createdMs: ms });
  // very first load ever (no stored mark) — seed silently, no chime
  const first = kitchenAlertDecision(0, [T("a", "QUEUED", 1000), T("b", "PREPARING", 900)]);
  assert.equal(first.chime, false);
  assert.equal(first.badge, 2);
  assert.equal(first.nextSeenMs, 1000);

  // a genuinely new QUEUED ticket after the mark -> chime once
  const d1 = kitchenAlertDecision(1000, [T("a", "QUEUED", 1000), T("c", "QUEUED", 2000)]);
  assert.equal(d1.chime, true);
  assert.deepEqual(d1.arrived, ["c"]);
  assert.equal(d1.nextSeenMs, 2000);

  // same snapshot re-delivered (reconnect replay) with the advanced mark -> no chime
  const d2 = kitchenAlertDecision(2000, [T("a", "QUEUED", 1000), T("c", "QUEUED", 2000)]);
  assert.equal(d2.chime, false);
  assert.deepEqual(d2.arrived, []);

  // ticket c moved to PREPARING -> still no chime, badge tracks non-DONE
  const d3 = kitchenAlertDecision(2000, [T("c", "PREPARING", 2000), T("d", "DONE", 2500)]);
  assert.equal(d3.chime, false);
  assert.equal(d3.badge, 1);
});

test("GET /kitchen/tickets maps docs; open scope hides DONE", async () => {
  const h = harness({
    kitchenTickets: {
      t1: { source: "qr", sourceId: "ref1", ref: "QR-000001", tableLabel: "Table 01", customerName: "", items: [{ name: "Paneer", kind: "food", qty: 2, note: "" }], status: "QUEUED", note: "", acceptedByUsername: "cashier1", createdAt: new Date("2026-09-07T10:00:00Z") },
      t2: { source: "website", sourceId: "w9", ref: "WEB-000009", tableLabel: null, customerName: "Asha", items: [], status: "DONE", createdAt: new Date("2026-09-07T09:00:00Z"), doneAt: new Date("2026-09-07T09:30:00Z") },
    },
  });
  const open = await h.apiFetch("/kitchen/tickets");
  assert.deepEqual(open.tickets.map((t) => t.ref), ["QR-000001"]);
  assert.equal(open.tickets[0].table_label, "Table 01");
  assert.equal(open.tickets[0].accepted_by, "cashier1");
  const all = await h.apiFetch("/kitchen/tickets?scope=all");
  assert.equal(all.tickets.length, 2);
});

test("an unmapped route throws a clear error", async () => {
  const h = harness();
  await assert.rejects(() => h.apiFetch("/totally/unknown"), /Unmapped API route/);
});

// ------------------------------------------- new-order alert (chime + popup)

test("orderAlertDecision: first run seeds silently, no chime", async () => {
  const d = orderAlertDecision(0, [
    { orderNo: "QR-000003", tableNo: "Table 03", grandTotal: 100 },
    { orderNo: "QR-000005", tableNo: "Table 01", grandTotal: 50 },
  ]);
  assert.equal(d.badge, 2);
  assert.equal(d.seed, 5);
  assert.equal(d.chime, false);
  assert.equal(d.prompt, null);
});

test("orderAlertDecision: one fresh order -> chime + 'Order received · <table> · <no> · ₹'", async () => {
  const d = orderAlertDecision(4, [
    { orderNo: "QR-000004", tableNo: "Table 02", grandTotal: 200 },
    { orderNo: "QR-000005", tableNo: "Table 03", grandTotal: 652.4 },
  ]);
  assert.equal(d.chime, true);
  assert.equal(d.prompt, "Order received · Table 03 · QR-000005 · ₹652.40");
  assert.equal(d.badge, 2);
  assert.equal(d.nextSeen, 5);
});

test("orderAlertDecision: multiple fresh -> '<n> new orders received'", async () => {
  const d = orderAlertDecision(2, [
    { orderNo: "QR-000003", tableNo: "T1", grandTotal: 10 },
    { orderNo: "QR-000004", tableNo: "T2", grandTotal: 20 },
    { orderNo: "QR-000005", tableNo: "T3", grandTotal: 30 },
  ]);
  assert.equal(d.chime, true);
  assert.equal(d.prompt, "3 new orders received");
});

test("orderAlertDecision: nothing new (order left NEW) -> badge updates, no chime", async () => {
  const d = orderAlertDecision(5, [{ orderNo: "QR-000005", tableNo: "T3", grandTotal: 30 }]);
  assert.equal(d.badge, 1);
  assert.equal(d.chime, false);
  assert.equal(d.prompt, null);
  assert.equal(d.nextSeen, 5);
});

test("orderAlertDecision: empty NEW set -> badge 0", async () => {
  const d = orderAlertDecision(5, []);
  assert.equal(d.badge, 0);
  assert.equal(d.chime, false);
});
