/*
   api-shim.js — translates the Flask-era `apiFetch("/api/...")` surface used by
   the (unchanged) per-page scripts into Firestore reads + httpsCallable() Cloud
   Function calls. Framework-agnostic: all Firebase bindings are injected, so the
   routing table is unit-testable in Node with fakes.

   makeApiFetch({ db, call, fs, auth, signInWithCustomToken, signOut, setUser })
     -> async apiFetch(path, options)
*/

export const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/**
 * Pure decision for the global new-order alert (chime + "Order received ·
 * <table> · <order#> · <₹>" popup + sidebar badge). Fed the current NEW-status
 * qrOrders docs and the last-seen order-number suffix. Mirrors the Flask
 * startOrderAlerts() tick, minus the DOM/audio.
 */
export function orderAlertDecision(seenSuffix, docs) {
  const num = (s) => parseInt(String(s || "").match(/(\d+)\s*$/)?.[1] || "0", 10);
  const money = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let maxSuffix = seenSuffix;
  const arrived = [];
  for (const o of docs) {
    const n = num(o.orderNo);
    if (n > seenSuffix) arrived.push(o);
    if (n > maxSuffix) maxSuffix = n;
  }
  if (!seenSuffix) return { badge: docs.length, seed: maxSuffix, chime: false, prompt: null, nextSeen: maxSuffix };
  let prompt = null;
  if (arrived.length === 1) {
    const o = arrived[0];
    prompt = `Order received · ${o.tableNo || "Table"} · ${o.orderNo} · ${money(o.grandTotal)}`;
  } else if (arrived.length > 1) {
    prompt = `${arrived.length} new orders received`;
  }
  return { badge: docs.length, seed: null, chime: arrived.length > 0, prompt, nextSeen: maxSuffix };
}

/** Same idea for the Website Orders board — "Website Order Received · <name> · WEB-… · ₹total".
 * Fed the CONFIRMED website orders (a verified 50% advance is what promotes an
 * order to CONFIRMED). Amounts are integer paise on the doc. */
export function websiteOrderAlertDecision(seenSuffix, docs) {
  const num = (s) => parseInt(String(s || "").match(/(\d+)\s*$/)?.[1] || "0", 10);
  const money = (paise) =>
    "₹" + ((Number(paise) || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let maxSuffix = seenSuffix;
  const arrived = [];
  for (const o of docs) {
    const n = num(o.ref);
    if (n > seenSuffix) arrived.push(o);
    if (n > maxSuffix) maxSuffix = n;
  }
  if (!seenSuffix) return { badge: docs.length, seed: maxSuffix, chime: false, prompt: null, nextSeen: maxSuffix };
  let prompt = null;
  if (arrived.length === 1) {
    const o = arrived[0];
    prompt = `Website Order Received · ${(o.customer && o.customer.name) || "Customer"} · ${o.ref} · ${money(o.totalPaise)}`;
  } else if (arrived.length > 1) {
    prompt = `${arrived.length} new website orders`;
  }
  return { badge: docs.length, seed: null, chime: arrived.length > 0, prompt, nextSeen: maxSuffix };
}

/**
 * Pure decision for the Kitchen screen chime + badge. Fed the current open
 * kitchen tickets and the last-seen high-water-mark (ms epoch of the newest
 * ticket already acknowledged, persisted to localStorage). A ticket chimes ONCE
 * — only while it is QUEUED and newer than the mark — so a refresh/reconnect
 * that re-delivers the same docs never re-chimes.
 *
 *   tickets: [{ id, status, createdMs }]
 *   -> { chime, arrived:[id], badge, nextSeenMs }
 */
export function kitchenAlertDecision(seenMs, tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  let maxMs = Number(seenMs) || 0;
  const arrived = [];
  for (const t of list) {
    const ms = Number(t.createdMs) || 0;
    if (ms > maxMs) maxMs = ms;
    if (t.status === "QUEUED" && ms > (Number(seenMs) || 0)) arrived.push(t.id);
  }
  const badge = list.filter((t) => t.status && t.status !== "DONE").length;
  // no chime on the very first ever load (no stored mark) — that's a backlog
  const chime = arrived.length > 0 && Number(seenMs) > 0;
  return { chime, arrived, badge, nextSeenMs: maxMs };
}

export const tsToStr = (v) => {
  const d = v && v.toDate ? v.toDate() : v instanceof Date ? v : null;
  if (!d) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const suffix = (s) => parseInt(String(s || "").match(/(\d+)\s*$/)?.[1] || "0", 10);
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* ---- row-shape mappers: Firestore doc -> Flask JSON row ---- */
const channelOf = (d) => d.salesChannel ?? (String(d.kind).toLowerCase() === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT");
export const catRow = (id, d) => ({ id, name: d.name, status: d.status, sort_order: d.sortOrder, kind: d.kind, sales_channel: channelOf(d) });
export const itemRow = (id, d) => ({
  id, name: d.name, category_id: d.categoryId, category_name: d.categoryName,
  price: Number(d.price),
  stock_qty: d.stockQty === null || d.stockQty === undefined ? null : Number(d.stockQty),
  description: d.description ?? null, brand: d.brand ?? null, bottle_size: d.bottleSize ?? null,
  tax_rate: Number(d.taxRate) || 0, status: d.status, kind: d.kind, sales_channel: channelOf(d),
});
export const billRow = (id, d) => ({
  id, bill_no: d.billNo, type: d.type, source: d.source ?? null,
  table_id: d.tableId ?? null, table_session_id: d.tableSessionId ?? null,
  website_order_id: d.websiteOrderId ?? null, website_order_no: d.websiteOrderNo ?? null,
  customer_name: d.customerName, customer_phone: d.customerPhone,
  subtotal: Number(d.subtotal), discount: Number(d.discount), tax: Number(d.tax), grand_total: Number(d.grandTotal),
  payment_method: d.paymentMethod, status: d.status, created_at: tsToStr(d.createdAt),
  items: (d.items || []).map((it) => ({
    item_name: it.itemName, brand: it.brand ?? "", bottle_size: it.bottleSize ?? "",
    price: Number(it.price), qty: Number(it.qty), tax_rate: Number(it.taxRate) || 0, line_total: Number(it.lineTotal),
  })),
});
export const sessionRow = (id, d) => {
  const items = (d.items || []).map((it) => ({
    item_kind: it.kind, item_id: it.itemId ?? null, item_name: it.itemName,
    brand: it.brand ?? "", bottle_size: it.bottleSize ?? "",
    price: Number(it.price), qty: Number(it.qty), tax_rate: Number(it.taxRate) || 0, line_total: Number(it.lineTotal),
  }));
  const subtotal = round2(items.reduce((s, i) => s + i.line_total, 0));
  const tax = round2(items.reduce((s, i) => s + (i.line_total * i.tax_rate) / 100, 0));
  return {
    id, table_id: d.tableId, table_no: d.tableNo, customer_name: d.customerName, customer_phone: d.customerPhone,
    status: d.status, opened_at: tsToStr(d.openedAt), settled_at: tsToStr(d.settledAt),
    items, subtotal, tax, grand_total: round2(subtotal + tax),
  };
};
// Integer paise on the doc; the board formats ₹ from *_paise. `ref` (WEB-000123)
// is the permanent human Order ID — minted at creation, kept through settlement.
export const websiteOrderRow = (id, d) => ({
  id,
  ref: d.ref,
  order_no: d.ref, // alias kept for callers that still say order_no
  status: d.status,
  payment_status: d.paymentStatus,
  customer: {
    name: d.customer?.name ?? "",
    phone: d.customer?.phone ?? "",
    email: d.customer?.email ?? "",
  },
  customer_name: d.customer?.name ?? "",
  customer_phone: d.customer?.phone ?? "",
  customer_email: d.customer?.email ?? "",
  fulfillment: {
    type: d.fulfillment?.type ?? "pickup",
    pickup_at: tsToStr(d.fulfillment?.pickupAt) ?? null,
    notes: d.fulfillment?.notes ?? "",
  },
  items: (d.items || []).map((it) => ({
    item_id: it.itemId, item_name: it.name, kind: it.kind,
    brand: it.brand ?? "", bottle_size: it.bottleSize ?? "",
    unit_price_paise: Number(it.unitPricePaise) || 0, qty: Number(it.qty) || 0,
    tax_rate: Number(it.taxRatePct) || 0, line_total_paise: Number(it.lineTotalPaise) || 0,
  })),
  subtotal_paise: Number(d.subtotalPaise) || 0,
  tax_paise: Number(d.taxPaise) || 0,
  total_paise: Number(d.totalPaise) || 0,
  advance_paise: Number(d.advancePaise) || 0,
  balance_paise: Number(d.balancePaise) || 0,
  paid_paise: Number(d.paidPaise) || 0,
  settled_bill_ids: d.settledBillIds || [],
  settled_bill_nos: d.settledBillNos || [],
  bill_status: (d.settledBillNos || []).length ? "billed" : "unbilled",
  kitchen_ticket_id: d.kitchenTicketId ?? null,
  kitchen_status: d.kitchenStatus ?? null,
  created_at: tsToStr(d.createdAt),
  confirmed_at: tsToStr(d.confirmedAt),
});

export const kitchenTicketRow = (id, d) => ({
  id,
  source: d.source,
  source_id: d.sourceId,
  ref: d.ref,
  table_label: d.tableLabel ?? null,
  customer_name: d.customerName ?? "",
  items: (d.items || []).map((it) => ({ name: it.name, kind: it.kind, qty: Number(it.qty) || 0, note: it.note ?? "" })),
  status: d.status,
  note: d.note ?? "",
  accepted_by: d.acceptedByUsername ?? "",
  created_at: tsToStr(d.createdAt),
  ready_at: tsToStr(d.readyAt),
  done_at: tsToStr(d.doneAt),
});

export const qrOrderRow = (id, d) => ({
  id, order_no: d.orderNo, public_ref: d.publicRef ?? id, table_id: d.tableId, table_label: d.tableNo,
  customer_name: d.customerName, note: d.note ?? null, status: d.status,
  kitchen_ticket_id: d.kitchenTicketId ?? null,
  kitchen_status: d.kitchenStatus ?? null,
  subtotal: Number(d.subtotal), tax: Number(d.tax), grand_total: Number(d.grandTotal),
  pushed_to_bill: d.pushedToBill ? 1 : 0, table_session_id: d.tableSessionId ?? null, created_at: tsToStr(d.createdAt),
  items: (d.items || []).map((it) => ({
    item_kind: it.kind, item_name: it.itemName, brand: it.brand ?? "", bottle_size: it.bottleSize ?? "",
    price: Number(it.price), qty: Number(it.qty), tax_rate: Number(it.taxRate) || 0, line_total: Number(it.lineTotal),
  })),
});

export function makeApiFetch(deps) {
  const { db, call, fs, signInWithCustomToken, signOut, auth, setUser, getUser } = deps;
  const { collection, doc, getDoc, getDocs, getCountFromServer, query, where, orderBy, limit: qlimit, updateDoc } = fs;

  async function apiFetch(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const body = options.body && typeof options.body === "string" ? JSON.parse(options.body) : options.body || {};
    const [rawPath, qsStr] = path.split("?");
    const q = new URLSearchParams(qsStr || "");
    const p = rawPath.replace(/^\//, "");
    const seg = p.split("/");
    try {
      return await route(p, seg, method, body, q);
    } catch (e) {
      if (e && (e.code === "functions/unauthenticated" || e.code === "unauthenticated")) {
        // cleanUrls strips ".html", so the login page can be /pages/login OR
        // /pages/login.html — match both, else we bounce in a redirect loop.
        const onLogin = typeof location !== "undefined" && /(^|\/)login(\.html)?$/i.test(location.pathname);
        if (typeof location !== "undefined" && !onLogin) location.href = "login.html";
      }
      throw new Error((e && e.message) || String(e));
    }
  }

  async function route(p, seg, method, body, q) {
    // auth
    if (p === "me") {
      const u = await getUser();
      if (!u) { const err = new Error("Unauthorized"); err.code = "unauthenticated"; throw err; }
      return { id: u.id, username: u.username, role: u.role, full_name: u.full_name };
    }
    if (p === "login" && method === "POST") {
      const res = await call("loginWithPassword", { username: body.username, password: body.password });
      await signInWithCustomToken(auth, res.token);
      setUser(res.user && { id: res.user.id, uid: res.user.id, username: res.user.username, full_name: res.user.full_name, role: res.user.role });
      return res.user;
    }
    if (p === "logout" && method === "POST") { await signOut(auth); setUser(null); return { message: "Logged out" }; }
    if (p === "health") return { status: "healthy", time: new Date().toISOString() };

    // staff
    if (p === "staff" && method === "GET") return (await call("listStaff")).staff;
    if (p === "staff" && method === "POST") return call("createStaff", body);
    if (seg[0] === "staff" && seg[1] && method === "PUT") return call("updateStaff", { uid: seg[1], ...body });
    if (seg[0] === "staff" && seg[1] && method === "DELETE") return call("deactivateStaff", { uid: seg[1] });

    const kind = seg[0] === "alcohol" ? "alcohol" : seg[0] === "cafe" ? "cafe" : "food";

    // categories
    if (seg[1] === "categories" && method === "GET") {
      const snap = await getDocs(query(collection(db, "categories"), where("kind", "==", kind), orderBy("sortOrder"), orderBy("name"), qlimit(500)));
      return snap.docs.map((d) => catRow(d.id, d.data()));
    }
    if (seg[1] === "categories" && !seg[2] && method === "POST") return call("upsertCategory", { kind, name: body.name });
    if (seg[1] === "categories" && seg[2] && method === "PUT") return call("upsertCategory", { kind, id: seg[2], name: body.name, status: body.status });
    if (seg[1] === "categories" && seg[2] && method === "DELETE") return call("deleteCategory", { id: seg[2] });

    // items
    if (seg[1] === "items" && method === "GET") {
      let qc;
      if (q.get("category_id")) {
        qc = query(collection(db, "catalog"), where("status", "==", "active"), where("categoryId", "==", q.get("category_id")), orderBy("nameLower"), qlimit(3000));
      } else {
        qc = query(collection(db, "catalog"), where("kind", "==", kind), where("status", "==", "active"), orderBy("categorySort"), orderBy("nameLower"), qlimit(3000));
      }
      const snap = await getDocs(qc);
      return snap.docs.map((d) => itemRow(d.id, d.data())).filter((r) => r.kind === kind);
    }
    if (seg[1] === "items" && !seg[2] && method === "POST") return call("upsertCatalogItem", { kind, ...body });
    if (seg[1] === "items" && seg[2] && method === "PUT") return call("upsertCatalogItem", { kind, id: seg[2], ...body });
    if (seg[1] === "items" && seg[2] && method === "DELETE") return call("deleteCatalogItem", { id: seg[2] });

    // tables
    if (p === "tables" && method === "GET") return listTables();
    if (p === "tables" && method === "POST") return call("createTable", body);
    if (seg[0] === "tables" && seg[1] && seg[2] === "open" && method === "POST") {
      const r = await call("openTable", { table_id: seg[1], customer_name: body.customer_name, customer_phone: body.customer_phone });
      return sessionRow(r.session.id, r.session);
    }
    if (seg[0] === "tables" && seg[1] && !seg[2] && method === "PUT") return call("updateTable", { id: seg[1], ...body });

    // table sessions
    if (seg[0] === "table-sessions" && seg[1] && !seg[2] && method === "GET") {
      const s = await getDoc(doc(db, "tableSessions", seg[1]));
      if (!s.exists()) throw new Error("Table session not found");
      return sessionRow(s.id, s.data());
    }
    if (seg[0] === "table-sessions" && seg[1] && !seg[2] && method === "PUT") return saveSession(seg[1], body);
    if (seg[0] === "table-sessions" && seg[1] && seg[2] === "settle" && method === "POST") {
      return call("settleTable", { session_id: seg[1], payment_method: body.payment_method, discount: body.discount });
    }

    // bills
    if (seg[1] === "bills" && !seg[2] && method === "POST") {
      const r = await call("createBill", { type: kind.toUpperCase(), ...body });
      return billRow(r.id, r);
    }
    if (seg[1] === "bills" && !seg[2] && method === "GET") {
      const lim = Math.min(Math.max(parseInt(q.get("limit") || "200", 10), 1), 500);
      const snap = await getDocs(query(collection(db, "bills"), where("type", "==", kind.toUpperCase()), orderBy("createdAt", "desc"), qlimit(lim)));
      return snap.docs.map((d) => billRow(d.id, d.data()));
    }
    if (seg[1] === "bills" && seg[2] && method === "GET") {
      const s = await getDoc(doc(db, "bills", seg[2]));
      if (!s.exists()) throw new Error("Bill not found");
      return billRow(s.id, s.data());
    }

    if (p === "orders" && method === "GET") return listOrders(q);
    if (p === "dashboard" && method === "GET") return dashboard();
    if (p === "audit-log" && method === "GET") return auditLog(q);

    // website orders (POS board)
    if (p === "website-orders" && method === "GET") return listWebsiteOrders(q);
    if (seg[0] === "website-orders" && seg[1] && !seg[2] && method === "GET") {
      const s = await getDoc(doc(db, "websiteOrders", seg[1]));
      if (!s.exists()) throw new Error("Website order not found");
      return websiteOrderRow(s.id, s.data());
    }
    if (seg[0] === "website-orders" && seg[1] && seg[2] === "status" && method === "POST")
      return call("setWebsiteOrderStatus", { order_id: seg[1], status: body.status });
    if (seg[0] === "website-orders" && seg[1] && seg[2] === "add-items" && method === "POST")
      return call("addItemsToWebsiteOrder", { order_id: seg[1], items: body.items });
    if (seg[0] === "website-orders" && seg[1] && seg[2] === "settle" && method === "POST")
      return call("settleWebsiteOrder", { order_id: seg[1], payment_method: body.payment_method });
    if (seg[0] === "website-orders" && seg[1] && seg[2] === "accept" && method === "POST")
      return call("acceptOrderToKitchen", { source: "website", id: seg[1] });

    // kitchen screen
    if (p === "kitchen/tickets" && method === "GET") return listKitchenTickets(q);
    if (seg[0] === "kitchen" && seg[1] === "tickets" && seg[2] && seg[3] === "status" && method === "POST")
      return call("setKitchenTicketStatus", { id: seg[2], status: body.status });

    // QR staff
    if (p === "qr-ordering/tables" && method === "GET") return qrAdminTables();
    if (seg[0] === "qr-ordering" && seg[1] === "tables" && seg[3] === "regenerate-qr" && method === "POST")
      return call("regenerateQrToken", { id: seg[2] });
    if (p === "qr-ordering/orders" && method === "GET") return qrAdminOrders(q);
    if (p === "qr-ordering/pulse" && method === "GET") return qrPulse(q);
    if (seg[0] === "qr-ordering" && seg[1] === "orders" && seg[3] === "status" && method === "POST")
      return call("setQrOrderStatus", { ref: seg[2], status: body.status });
    if (seg[0] === "qr-ordering" && seg[1] === "orders" && seg[3] === "push-to-bill" && method === "POST")
      return call("pushQrOrderToBill", { ref: seg[2] });
    if (seg[0] === "qr-ordering" && seg[1] === "orders" && seg[3] === "accept" && method === "POST")
      return call("acceptOrderToKitchen", { source: "qr", id: seg[2] });

    throw new Error(`Unmapped API route: ${method} /${p}`);
  }

  async function listTables() {
    const [tSnap, sSnap] = await Promise.all([
      getDocs(query(collection(db, "tables"), orderBy("tableNo"))),
      getDocs(query(collection(db, "tableSessions"), where("status", "==", "open"))),
    ]);
    const byTable = new Map();
    sSnap.docs.forEach((d) => byTable.set(d.data().tableId, { id: d.id, ...d.data() }));
    return tSnap.docs.map((d) => {
      const t = d.data();
      const s = byTable.get(d.id);
      const items = s ? s.items || [] : [];
      const subtotal = round2(items.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0));
      const tax = round2(items.reduce((a, i) => a + (Number(i.price) * Number(i.qty) * (Number(i.taxRate) || 0)) / 100, 0));
      return {
        id: d.id, table_no: t.tableNo, seats: t.seats, status: s ? "open" : "available",
        session_id: s ? s.id : null, customer_name: s ? s.customerName : null, customer_phone: s ? s.customerPhone : null,
        opened_at: s ? tsToStr(s.openedAt) : null,
        subtotal, tax, grand_total: round2(subtotal + tax),
        item_count: items.reduce((a, i) => a + Number(i.qty), 0),
      };
    });
  }

  async function saveSession(id, body) {
    const items = Array.isArray(body.items) ? body.items : [];
    const clean = items.map((it) => {
      const price = round2(it.price);
      const qty = Math.max(1, parseInt(it.qty, 10) || 1);
      return {
        kind: it.item_kind === "alcohol" ? "alcohol" : "food",
        itemId: typeof it.item_id === "string" ? it.item_id : it.item_id ? String(it.item_id) : null,
        itemName: (it.name || it.item_name || "").trim(),
        brand: (it.brand || "").trim(), bottleSize: (it.bottle_size || "").trim(),
        price, qty, taxRate: Number(it.tax_rate ?? 5) || 0, lineTotal: round2(price * qty),
      };
    });
    const subtotal = round2(clean.reduce((a, i) => a + i.lineTotal, 0));
    const tax = round2(clean.reduce((a, i) => a + (i.lineTotal * i.taxRate) / 100, 0));
    await updateDoc(doc(db, "tableSessions", id), {
      items: clean,
      customerName: (body.customer_name || "Walk-in").trim() || "Walk-in",
      customerPhone: (body.customer_phone || "-").trim() || "-",
      subtotal, tax, grandTotal: round2(subtotal + tax), updatedAt: new Date(),
    });
    const s = await getDoc(doc(db, "tableSessions", id));
    return sessionRow(s.id, s.data());
  }

  async function listOrders(q) {
    const type = (q.get("type") || "all").toUpperCase();
    const date = q.get("date") || "";
    const search = (q.get("search") || "").trim().toLowerCase();
    const lim = Math.min(Math.max(parseInt(q.get("limit") || "25", 10), 1), 200);
    const offset = Math.max(parseInt(q.get("offset") || "0", 10), 0);
    const clauses = [];
    if (search) clauses.push(where("searchTokens", "array-contains", search));
    if (type === "FOOD" || type === "ALCOHOL") clauses.push(where("type", "==", type));
    if (date) clauses.push(where("dateKey", "==", date));
    const base = collection(db, "bills");
    const total = (await getCountFromServer(query(base, ...clauses))).data().count;
    const snap = await getDocs(query(base, ...clauses, orderBy("createdAt", "desc"), qlimit(offset + lim)));
    const orders = snap.docs.slice(offset).map((d) => {
      const b = d.data();
      return { id: d.id, bill_no: b.billNo, type: b.type, customer_name: b.customerName, created_at: tsToStr(b.createdAt), grand_total: Number(b.grandTotal), payment_method: b.paymentMethod, status: b.status };
    });
    return { orders, total, limit: lim, offset };
  }

  async function dashboard() {
    const s = await getDoc(doc(db, "stats", "rolling"));
    const r = s.exists() ? s.data() : {};
    const t = r.today || {};
    return {
      food_sales_today: t.foodSales || 0, alcohol_sales_today: t.alcoholSales || 0, cafe_sales_today: t.cafeSales || 0,
      total_sales_today: t.totalSales || 0,
      food_bills_today: t.foodBills || 0, alcohol_bills_today: t.alcoholBills || 0, cafe_bills_today: t.cafeBills || 0,
      total_bills_today: t.totalBills || 0,
      trend: r.trend || [], payment_mix: r.paymentMix || [], top_items: r.topItems || [], hourly_flow: r.hourlyFlow || [],
      recent_orders: r.recentOrders || [],
      menu_summary: {
        food_items: r.menuSummary?.foodItems || 0, alcohol_items: r.menuSummary?.alcoholItems || 0,
        cafe_items: r.menuSummary?.cafeItems || 0,
        food_categories: r.menuSummary?.foodCategories || 0, alcohol_categories: r.menuSummary?.alcoholCategories || 0,
        cafe_categories: r.menuSummary?.cafeCategories || 0,
      },
    };
  }

  async function auditLog(q) {
    const lim = Math.min(Math.max(parseInt(q.get("limit") || "100", 10), 1), 500);
    const offset = Math.max(parseInt(q.get("offset") || "0", 10), 0);
    const entityType = q.get("entity_type") || "";
    const action = q.get("action") || "";
    const clauses = [];
    if (entityType) clauses.push(where("entityType", "==", entityType));
    const base = collection(db, "auditLog");
    const total = (await getCountFromServer(query(base, ...clauses))).data().count;
    const snap = await getDocs(query(base, ...clauses, orderBy("createdAt", "desc"), qlimit(offset + lim + (action ? 300 : 0))));
    let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (action) docs = docs.filter((d) => String(d.action || "").startsWith(action));
    docs = docs.slice(offset, offset + lim);
    return {
      entries: docs.map((d) => ({
        id: d.id, actor_id: d.actorUid, actor_username: d.actorUsername, actor_role: d.actorRole,
        action: d.action, entity_type: d.entityType, entity_id: d.entityId, details: d.details, created_at: tsToStr(d.createdAt),
      })),
      total, limit: lim, offset,
    };
  }

  async function qrAdminTables() {
    // bounded: only today's QR orders feed the per-table open/new counters
    const [tSnap, oSnap] = await Promise.all([
      getDocs(query(collection(db, "tables"), orderBy("tableNo"), qlimit(500))),
      getDocs(query(collection(db, "qrOrders"), where("dateKey", "==", todayKey()), qlimit(1000))),
    ]);
    const orders = oSnap.docs.map((d) => d.data());
    const origin = typeof location !== "undefined" ? location.origin : "";
    return tSnap.docs.map((d) => {
      const t = d.data();
      const mine = orders.filter((o) => o.tableId === d.id);
      const menuUrl = `${origin}/menu/${t.qrToken}`;
      return {
        id: d.id, table_no: t.tableNo, seats: t.seats, status: t.status, qr_token: t.qrToken,
        open_orders: mine.filter((o) => o.status !== "SERVED" && o.status !== "CANCELLED").length,
        new_orders: mine.filter((o) => o.status === "NEW").length,
        menu_url: menuUrl,
      };
    });
  }

  async function qrAdminOrders(q) {
    const status = (q.get("status") || "").toUpperCase();
    const scope = (q.get("scope") || "").toLowerCase();
    const dateF = q.get("date") || "";
    const clauses = [];
    if (["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED", "CANCELLED"].includes(status)) clauses.push(where("status", "==", status));
    if (dateF) clauses.push(where("dateKey", "==", dateF));
    else if (scope !== "all") clauses.push(where("dateKey", "==", todayKey()));
    const snap = await getDocs(query(collection(db, "qrOrders"), ...clauses, orderBy("createdAt", "desc"), qlimit(500)));
    let orders = snap.docs.map((d) => qrOrderRow(d.id, d.data()));
    if (scope === "active") orders = orders.filter((o) => o.status !== "SERVED" && o.status !== "CANCELLED");
    return { orders, status_flow: ["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED", "CANCELLED"] };
  }

  async function listWebsiteOrders(q) {
    const orderNo = (q.get("order_no") || "").trim();
    if (orderNo) {
      // exact human Order-ID lookup — the primary way staff find an order
      const norm = /^web/i.test(orderNo) ? orderNo.toUpperCase().replace(/^WEB-?/, "WEB-") : orderNo;
      const snap = await getDocs(query(collection(db, "websiteOrders"), where("ref", "==", norm), qlimit(1)));
      return { orders: snap.docs.map((d) => websiteOrderRow(d.id, d.data())) };
    }
    const status = (q.get("status") || "").toUpperCase();
    const scope = (q.get("scope") || "").toLowerCase();
    const TERMINAL = ["COMPLETED", "CANCELLED", "PAYMENT_FAILED"];
    const clauses = [];
    if (["PENDING_PAYMENT", "CONFIRMED", "PREPARING", "READY", ...TERMINAL].includes(status)) {
      clauses.push(where("status", "==", status));
    }
    let snap = await getDocs(query(collection(db, "websiteOrders"), ...clauses, orderBy("createdAt", "desc"), qlimit(200)));
    let orders = snap.docs.map((d) => websiteOrderRow(d.id, d.data()));
    // the board only ever deals with orders whose advance is verified
    if (scope === "active") orders = orders.filter((o) => !TERMINAL.includes(o.status) && o.status !== "PENDING_PAYMENT");
    const cust = (q.get("customer") || "").trim().toLowerCase();
    if (cust) orders = orders.filter((o) => `${o.customer_name} ${o.customer_phone}`.toLowerCase().includes(cust));
    return { orders };
  }

  async function listKitchenTickets(q) {
    const scope = (q.get("scope") || "open").toLowerCase();
    const statuses = scope === "all" ? null : ["QUEUED", "PREPARING", "READY"];
    const clauses = statuses ? [where("status", "in", statuses)] : [];
    const snap = await getDocs(query(collection(db, "kitchenTickets"), ...clauses, orderBy("createdAt", "asc"), qlimit(200)));
    return { tickets: snap.docs.map((d) => kitchenTicketRow(d.id, d.data())) };
  }

  async function qrPulse(q) {
    const after = q.get("after") || "";
    const snap = await getDocs(query(collection(db, "qrOrders"), orderBy("createdAt", "desc"), qlimit(50)));
    const rows = snap.docs.map((d) => qrOrderRow(d.id, d.data()));
    const latest = rows.reduce((m, o) => Math.max(m, suffix(o.order_no)), 0);
    return {
      latest_id: latest,
      new_count: rows.filter((o) => o.status === "NEW").length,
      active_count: rows.filter((o) => o.status !== "SERVED" && o.status !== "CANCELLED").length,
      new: after ? rows.filter((o) => suffix(o.order_no) > Number(after)).map((o) => ({ id: o.id, order_no: o.order_no, table_label: o.table_label, grand_total: o.grand_total, item_count: (o.items || []).reduce((a, i) => a + i.qty, 0) })) : [],
    };
  }

  return apiFetch;
}
