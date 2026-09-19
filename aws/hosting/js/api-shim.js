/*
 * api-shim.js — AWS rewrite of firebase/hosting/js/api-shim.js. Same public
 * contract (`apiFetch(path, options)` returning the same snake_case JSON
 * shapes) so every page-level script (billing.js, dashboard.js, menu.js,
 * ...) needed ZERO changes — only this transport layer + aws-auth.js
 * changed. Routes every call to the REST API built in aws/backend:
 *   - reads            -> POST /api/callable/queries/<action>
 *   - mutations        -> POST /api/callable/<module>/<action>
 *   - auth             -> aws-auth.js (loginWithPassword / logout)
 * Every call carries `Authorization: Bearer <Cognito ID token>` except login
 * itself. A 401 here means "not signed in or token expired" — redirect to
 * login, same behavior the Firebase version had for `functions/unauthenticated`.
 */
import { API_BASE_URL } from "./aws-config.js";
import { getIdToken, getCurrentUser, logout, loginWithPassword } from "./aws-auth.js";

export const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

// ---- pure alert-decision helpers: UNCHANGED from the Firebase version ----
// (fed rows from REST responses / WebSocket pushes instead of Firestore
// snapshots, but the decision logic — what counts as "new", when to chime —
// is identical, so it is copied verbatim rather than reinvented.)

export function orderAlertDecision(seenSuffix, docs) {
  const num = (s) => parseInt(String(s || "").match(/(\d+)\s*$/)?.[1] || "0", 10);
  const money = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let maxSuffix = seenSuffix;
  const arrived = [];
  for (const o of docs) {
    const n = num(o.order_no);
    if (n > seenSuffix) arrived.push(o);
    if (n > maxSuffix) maxSuffix = n;
  }
  if (!seenSuffix) return { badge: docs.length, seed: maxSuffix, chime: false, prompt: null, nextSeen: maxSuffix };
  let prompt = null;
  if (arrived.length === 1) {
    const o = arrived[0];
    prompt = `Order received · ${o.table_label || "Table"} · ${o.order_no} · ${money(o.grand_total)}`;
  } else if (arrived.length > 1) {
    prompt = `${arrived.length} new orders received`;
  }
  return { badge: docs.length, seed: null, chime: arrived.length > 0, prompt, nextSeen: maxSuffix };
}

export function websiteOrderAlertDecision(seenSuffix, docs) {
  const num = (s) => parseInt(String(s || "").match(/(\d+)\s*$/)?.[1] || "0", 10);
  const money = (paise) => "₹" + ((Number(paise) || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    prompt = `Website Order Received · ${o.customer_name || "Customer"} · ${o.ref} · ${money(o.total_paise)}`;
  } else if (arrived.length > 1) {
    prompt = `${arrived.length} new website orders`;
  }
  return { badge: docs.length, seed: null, chime: arrived.length > 0, prompt, nextSeen: maxSuffix };
}

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
  const chime = arrived.length > 0 && Number(seenMs) > 0;
  return { chime, arrived, badge, nextSeenMs: maxMs };
}

// ---------------------------------------------------------------------------

async function callApi(mod, action, body) {
  const token = getIdToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}/api/callable/${mod}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `${mod}.${action} failed`);
    err.code = data && data.error && data.error.code;
    err.status = res.status;
    throw err;
  }
  return data;
}
const query = (action, body) => callApi("queries", action, body);
const call = (mod, action, body) => callApi(mod, action, body);

/*
  A key that survives retries of the SAME sale.

  Counter wifi drops, a cashier taps "Save" twice because the first tap seemed
  to do nothing, a tab is reloaded mid-save: each can put one bill on the wire
  more than once. The backend refuses to create a second bill for a key it has
  already seen (bills.client_ref is UNIQUE), so the customer is charged once.
  The key must be created when the sale is confirmed and REUSED for every
  retry of it - a fresh key per attempt defeats the whole mechanism.
*/
export function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function apiFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const body = options.body && typeof options.body === "string" ? JSON.parse(options.body) : options.body || {};
  const [rawPath, qsStr] = path.split("?");
  const q = new URLSearchParams(qsStr || "");
  const p = rawPath.replace(/^\//, "");
  const seg = p.split("/");
  try {
    return await route(p, seg, method, body, q);
  } catch (e) {
    if (e && (e.status === 401 || e.code === "unauthenticated")) {
      const onLogin = typeof location !== "undefined" && /(^|\/)login(\.html)?$/i.test(location.pathname);
      if (typeof location !== "undefined" && !onLogin) { logout(); }
    }
    throw new Error((e && e.message) || String(e));
  }
}

async function route(p, seg, method, body, q) {
  // auth
  if (p === "me") {
    const u = getCurrentUser();
    if (!u) { const err = new Error("Unauthorized"); err.code = "unauthenticated"; throw err; }
    return { id: u.id, username: u.username, role: u.role, full_name: u.full_name };
  }
  if (p === "login" && method === "POST") return loginWithPassword(body.username, body.password);
  if (p === "logout" && method === "POST") { await logout(); return { message: "Logged out" }; }
  if (p === "health") return { status: "healthy", time: new Date().toISOString() };

  // staff
  if (p === "staff" && method === "GET") return (await call("staffAdmin", "listStaff")).staff;
  if (p === "staff" && method === "POST") return call("staffAdmin", "createStaff", body);
  if (seg[0] === "staff" && seg[1] && method === "PUT") return call("staffAdmin", "updateStaff", { uid: seg[1], ...body });
  if (seg[0] === "staff" && seg[1] && method === "DELETE") return call("staffAdmin", "deactivateStaff", { uid: seg[1] });

  const kind = seg[0] === "alcohol" ? "alcohol" : seg[0] === "cafe" ? "cafe" : "food";

  // categories
  if (seg[1] === "categories" && method === "GET") return query("listCategories", { kind });
  if (seg[1] === "categories" && !seg[2] && method === "POST") return call("catalogAdmin", "upsertCategory", { kind, name: body.name });
  if (seg[1] === "categories" && seg[2] && method === "PUT") return call("catalogAdmin", "upsertCategory", { kind, id: seg[2], name: body.name, status: body.status });
  if (seg[1] === "categories" && seg[2] && method === "DELETE") return call("catalogAdmin", "deleteCategory", { id: seg[2] });

  // items
  if (seg[1] === "items" && method === "GET") return query("listCatalogItems", { kind, category_id: q.get("category_id") || undefined });
  if (seg[1] === "items" && !seg[2] && method === "POST") return call("catalogAdmin", "upsertCatalogItem", { kind, ...body });
  if (seg[1] === "items" && seg[2] && method === "PUT") return call("catalogAdmin", "upsertCatalogItem", { kind, id: seg[2], ...body });
  if (seg[1] === "items" && seg[2] && method === "DELETE") return call("catalogAdmin", "deleteCatalogItem", { id: seg[2] });

  // tables
  if (p === "tables" && method === "GET") return query("listTables");
  if (p === "tables" && method === "POST") return call("tablesAdmin", "createTable", body);
  if (seg[0] === "tables" && seg[1] && seg[2] === "open" && method === "POST") {
    const r = await call("billing", "openTable", { table_id: seg[1], customer_name: body.customer_name, customer_phone: body.customer_phone });
    return query("getTableSession", { id: r.session.id });
  }
  if (seg[0] === "tables" && seg[1] && !seg[2] && method === "PUT") return call("tablesAdmin", "updateTable", { id: seg[1], ...body });

  // table sessions
  if (seg[0] === "table-sessions" && seg[1] && !seg[2] && method === "GET") return query("getTableSession", { id: seg[1] });
  if (seg[0] === "table-sessions" && seg[1] && !seg[2] && method === "PUT") return query("saveTableSession", { id: seg[1], ...body });
  if (seg[0] === "table-sessions" && seg[1] && seg[2] === "settle" && method === "POST") {
    return call("billing", "settleTable", { session_id: seg[1], payment_method: body.payment_method, discount: body.discount });
  }

  // bills
  if (seg[1] === "bills" && !seg[2] && method === "POST") {
    const r = await call("billing", "createBill", { type: kind.toUpperCase(), ...body });
    return query("getBill", { id: r.id });
  }
  if (seg[1] === "bills" && !seg[2] && method === "GET") return query("listBills", { kind: kind.toUpperCase(), limit: q.get("limit") || undefined });
  if (seg[1] === "bills" && seg[2] && method === "GET") return query("getBill", { id: seg[2] });

  if (p === "orders" && method === "GET") return query("listOrders", { type: q.get("type") || undefined, date: q.get("date") || undefined, search: q.get("search") || undefined, limit: q.get("limit") || undefined, offset: q.get("offset") || undefined });
  if (p === "dashboard" && method === "GET") return query("dashboard");
  if (p === "audit-log" && method === "GET") return query("auditLog", { entity_type: q.get("entity_type") || undefined, action: q.get("action") || undefined, limit: q.get("limit") || undefined, offset: q.get("offset") || undefined });

  // website orders
  if (p === "website-orders" && method === "GET") return query("listWebsiteOrders", { status: q.get("status") || undefined, scope: q.get("scope") || undefined, customer: q.get("customer") || undefined, order_no: q.get("order_no") || undefined });
  if (seg[0] === "website-orders" && seg[1] && !seg[2] && method === "GET") return query("getWebsiteOrder", { id: seg[1] });
  if (seg[0] === "website-orders" && seg[1] && seg[2] === "status" && method === "POST") return call("websiteOrdersAdmin", "setWebsiteOrderStatus", { order_id: seg[1], status: body.status });
  if (seg[0] === "website-orders" && seg[1] && seg[2] === "add-items" && method === "POST") return call("websiteOrdersAdmin", "addItemsToWebsiteOrder", { order_id: seg[1], items: body.items });
  if (seg[0] === "website-orders" && seg[1] && seg[2] === "settle" && method === "POST") return call("websiteOrdersAdmin", "settleWebsiteOrder", { order_id: seg[1], payment_method: body.payment_method });
  if (seg[0] === "website-orders" && seg[1] && seg[2] === "accept" && method === "POST") return call("kitchen", "acceptOrderToKitchen", { source: "website", id: seg[1] });

  // kitchen screen
  if (p === "kitchen/tickets" && method === "GET") return query("listKitchenTickets", { scope: q.get("scope") || undefined });
  if (seg[0] === "kitchen" && seg[1] === "tickets" && seg[2] && seg[3] === "status" && method === "POST") return call("kitchen", "setKitchenTicketStatus", { id: seg[2], status: body.status });

  // QR staff
  if (p === "qr-ordering/tables" && method === "GET") return query("qrAdminTables");
  if (seg[0] === "qr-ordering" && seg[1] === "tables" && seg[3] === "regenerate-qr" && method === "POST") return call("tablesAdmin", "regenerateQrToken", { id: seg[2] });
  if (p === "qr-ordering/orders" && method === "GET") return query("qrAdminOrders", { status: q.get("status") || undefined, scope: q.get("scope") || undefined, date: q.get("date") || undefined });
  if (p === "qr-ordering/pulse" && method === "GET") return query("qrPulse", { after: q.get("after") || undefined });
  if (seg[0] === "qr-ordering" && seg[1] === "orders" && seg[3] === "status" && method === "POST") return call("qrOrdersAdmin", "setQrOrderStatus", { ref: seg[2], status: body.status });
  if (seg[0] === "qr-ordering" && seg[1] === "orders" && seg[3] === "push-to-bill" && method === "POST") return call("qrOrdersAdmin", "pushQrOrderToBill", { ref: seg[2] });
  if (seg[0] === "qr-ordering" && seg[1] === "orders" && seg[3] === "accept" && method === "POST") return call("kitchen", "acceptOrderToKitchen", { source: "qr", id: seg[2] });

  throw new Error(`Unmapped API route: ${method} /${p}`);
}
