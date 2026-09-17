// Pure transform: Flask SQL rows -> Firestore documents.
// Follows FIRESTORE-SCHEMA.md exactly (not a 1:1 table copy).

import {
  userId,
  categoryId,
  catalogItemId,
  tableId,
  tableSessionId,
  billId,
  auditId,
  remapAuditEntity,
} from "./ids.mjs";
import { round2, parseLocalTs, lower, searchTokens } from "./money.mjs";

const suffixNum = (s) => {
  const m = String(s || "").match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
};
const lineTotals = (rows) => round2(rows.reduce((s, r) => s + Number(r.lineTotal), 0));
const lineTax = (rows) =>
  round2(rows.reduce((s, r) => s + (Number(r.lineTotal) * Number(r.taxRate || 0)) / 100, 0));

export function transformAll(src) {
  // Tolerate an old SQLite copy that predates a migration (e.g. the bundled
  // backend/nextlevel.db has no qr_orders / audit_log tables yet). A real
  // Postgres source has every table; a missing one just yields zero docs.
  const T = (table) =>
    src.has(table) ? src.all(`SELECT * FROM ${table} ORDER BY id`) : [];

  const out = {
    users: [],
    userCredentials: [],
    categories: [],
    catalog: [],
    tables: [],
    tableSessions: [],
    bills: [],
    qrOrders: [],
    auditLog: [],
    counters: [],
    authUsers: [],
  };
  const notes = [];

  // ---- users + credentials ------------------------------------------------
  for (const u of T("users")) {
    const uid = userId(u.id);
    const createdAt = parseLocalTs(u.created_at).date;
    out.users.push({
      id: uid,
      data: {
        username: u.username,
        usernameLower: lower(u.username),
        fullName: u.full_name || "",
        phone: u.phone || "",
        role: u.role === "staff" || !u.role ? "billing" : u.role,
        status: u.status || "active",
        createdAt,
        legacyId: u.id,
      },
    });
    out.userCredentials.push({
      id: uid,
      data: { usernameLower: lower(u.username), passwordHash: u.password_hash, updatedAt: createdAt },
    });
    out.authUsers.push({
      uid,
      displayName: u.full_name || u.username,
      role: u.role === "staff" || !u.role ? "billing" : u.role,
      disabled: (u.status || "active") !== "active",
    });
  }

  // ---- categories -------------------------------------------------------
  const catLookup = {}; // "<kind>:<legacyId>" -> { id, name, sort }
  const addCats = (rows, kind) => {
    for (const c of rows) {
      const id = categoryId(kind, c.id);
      catLookup[`${kind}:${c.id}`] = { id, name: c.name, sort: c.sort_order ?? 0 };
      out.categories.push({
        id,
        data: {
          kind,
          salesChannel: kind === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT",
          name: c.name,
          nameLower: lower(c.name),
          sortOrder: c.sort_order ?? 0,
          status: c.status || "active",
          createdAt: parseLocalTs(c.created_at).date,
          updatedAt: parseLocalTs(c.updated_at || c.created_at).date,
          legacyId: c.id,
        },
      });
    }
  };
  addCats(T("food_categories"), "food");
  addCats(T("alcohol_categories"), "alcohol");

  // ---- catalog -------------------------------------------------------
  const addItems = (rows, kind) => {
    for (const it of rows) {
      const cat = catLookup[`${kind}:${it.category_id}`] || { id: null, name: "", sort: 0 };
      out.catalog.push({
        id: catalogItemId(kind, it.id),
        data: {
          kind,
          salesChannel: kind === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT",
          name: it.name,
          nameLower: lower(it.name),
          categoryId: cat.id,
          categoryName: cat.name,
          categorySort: cat.sort,
          price: round2(it.price),
          taxRate: kind === "alcohol" ? round2(it.tax_rate || 0) : 0,
          stockQty: it.stock_qty === null || it.stock_qty === undefined ? null : Number(it.stock_qty),
          brand: kind === "alcohol" ? it.brand || null : null,
          bottleSize: kind === "alcohol" ? it.bottle_size || null : null,
          description: kind === "food" ? it.description || null : null,
          status: it.status || "active",
          imagePath: null,
          createdAt: parseLocalTs(it.created_at).date,
          updatedAt: parseLocalTs(it.updated_at || it.created_at).date,
          legacyId: it.id,
          legacyKind: kind,
        },
      });
    }
  };
  addItems(T("food_items"), "food");
  addItems(T("alcohol_items"), "alcohol");

  // ---- tables (openSessionId filled after sessions) ---------------------
  const tableLookup = {}; // legacyId -> tableNo
  for (const t of T("restaurant_tables")) {
    tableLookup[t.id] = t.table_no;
    out.tables.push({
      id: tableId(t.id),
      data: {
        tableNo: t.table_no,
        seats: Number(t.seats) || 4,
        status: t.status || "available",
        qrToken: t.qr_token || null,
        openSessionId: null,
        createdAt: parseLocalTs(t.created_at).date,
        updatedAt: parseLocalTs(t.updated_at || t.created_at).date,
        legacyId: t.id,
      },
    });
  }
  const tableDocById = Object.fromEntries(out.tables.map((d) => [d.id, d]));

  // ---- bills (needed for session.settledBillIds + counter max) --------
  const billsBySession = {}; // sess legacyId -> [billDocId]
  const addBills = (billRows, itemRows, type, kind) => {
    const items = {};
    for (const r of itemRows) (items[r.bill_id] ||= []).push(r);
    for (const b of billRows) {
      const its = (items[b.id] || []).map((r) =>
        type === "FOOD"
          ? {
              itemName: r.item_name,
              price: round2(r.price),
              qty: Number(r.qty),
              lineTotal: round2(r.line_total),
            }
          : {
              itemName: r.item_name,
              brand: r.brand || "",
              bottleSize: r.bottle_size || "",
              price: round2(r.price),
              qty: Number(r.qty),
              taxRate: round2(r.tax_rate || 0),
              lineTotal: round2(r.line_total),
            },
      );
      const ts = parseLocalTs(b.created_at);
      const id = billId(kind, b.id);
      if (b.table_session_id != null) (billsBySession[b.table_session_id] ||= []).push(id);
      out.bills.push({
        id,
        data: {
          billNo: b.bill_no,
          billNoLower: lower(b.bill_no),
          type,
          source: b.table_session_id != null ? "table" : "counter",
          tableId: b.table_id != null ? tableId(b.table_id) : null,
          tableSessionId: b.table_session_id != null ? tableSessionId(b.table_session_id) : null,
          customerName: b.customer_name || "-",
          customerPhone: b.customer_phone || "-",
          customerNameLower: lower(b.customer_name),
          searchTokens: searchTokens(b.bill_no, b.customer_name),
          subtotal: round2(b.subtotal),
          discount: round2(b.discount),
          tax: round2(b.tax),
          grandTotal: round2(b.grand_total),
          paymentMethod: b.payment_method || "Cash",
          status: b.status || "confirmed",
          createdByUid: b.created_by != null ? userId(b.created_by) : null,
          createdAt: ts.date,
          dateKey: ts.dateKey,
          hour: ts.hour,
          items: its,
          legacyId: b.id,
        },
      });
    }
  };
  addBills(
    T("food_bills"),
    T("food_bill_items"),
    "FOOD",
    "food",
  );
  addBills(
    T("alcohol_bills"),
    T("alcohol_bill_items"),
    "ALCOHOL",
    "alcohol",
  );

  // ---- table sessions -----------------------------------------------
  const sessItems = {};
  for (const r of T("table_session_items")) {
    (sessItems[r.session_id] ||= []).push({
      kind: r.item_kind || "food",
      itemId: r.item_id != null ? catalogItemId(r.item_kind || "food", r.item_id) : null,
      itemName: r.item_name,
      brand: r.brand || "",
      bottleSize: r.bottle_size || "",
      price: round2(r.price),
      qty: Number(r.qty),
      taxRate: round2(r.tax_rate || 0),
      lineTotal: round2(r.line_total),
    });
  }
  for (const s of T("table_sessions")) {
    const items = sessItems[s.id] || [];
    const id = tableSessionId(s.id);
    const doc = {
      id,
      data: {
        tableId: tableId(s.table_id),
        tableNo: tableLookup[s.table_id] || "",
        customerName: s.customer_name || "Walk-in",
        customerPhone: s.customer_phone || "-",
        status: s.status || "open",
        openedAt: parseLocalTs(s.opened_at).date,
        openedByUid: s.opened_by != null ? userId(s.opened_by) : null,
        settledAt: s.settled_at ? parseLocalTs(s.settled_at).date : null,
        items,
        subtotal: lineTotals(items),
        tax: lineTax(items),
        grandTotal: round2(lineTotals(items) + lineTax(items)),
        settledBillIds: billsBySession[s.id] || [],
        legacyId: s.id,
      },
    };
    out.tableSessions.push(doc);
    if ((s.status || "open") === "open") {
      const td = tableDocById[tableId(s.table_id)];
      if (td) td.data.openSessionId = id;
    }
  }

  // ---- qr orders --------------------------------------------------
  const qrItems = {};
  for (const r of T("qr_order_items")) {
    (qrItems[r.qr_order_id] ||= []).push({
      kind: r.item_kind || "food",
      itemId: r.item_id != null ? catalogItemId(r.item_kind || "food", r.item_id) : null,
      itemName: r.item_name,
      brand: r.brand || "",
      bottleSize: r.bottle_size || "",
      price: round2(r.price),
      qty: Number(r.qty),
      taxRate: round2(r.tax_rate || 0),
      lineTotal: round2(r.line_total),
    });
  }
  for (const q of T("qr_orders")) {
    const ts = parseLocalTs(q.created_at);
    out.qrOrders.push({
      id: q.public_ref,
      data: {
        orderNo: q.order_no,
        publicRef: q.public_ref,
        tableId: tableId(q.table_id),
        tableNo: tableLookup[q.table_id] || "",
        customerName: q.customer_name || "Guest",
        note: q.note || null,
        status: q.status || "NEW",
        subtotal: round2(q.subtotal),
        tax: round2(q.tax),
        grandTotal: round2(q.grand_total),
        pushedToBill: !!q.pushed_to_bill,
        tableSessionId: q.table_session_id != null ? tableSessionId(q.table_session_id) : null,
        createdAt: ts.date,
        updatedAt: parseLocalTs(q.updated_at || q.created_at).date,
        dateKey: ts.dateKey,
        items: qrItems[q.id] || [],
        legacyId: q.id,
      },
    });
  }

  // ---- audit log -----------------------------------------------
  for (const a of T("audit_log")) {
    let details = null;
    if (a.details) {
      try {
        details = JSON.parse(a.details);
      } catch {
        details = { raw: String(a.details) };
      }
    }
    out.auditLog.push({
      id: auditId(a.id),
      data: {
        actorUid: a.actor_id != null ? userId(a.actor_id) : null,
        actorUsername: a.actor_username || null,
        actorRole: a.actor_role || null,
        action: a.action,
        entityType: a.entity_type,
        entityId: remapAuditEntity(a.entity_type, a.entity_id),
        details,
        createdAt: parseLocalTs(a.created_at).date,
        legacyId: a.id,
      },
    });
  }

  // ---- counters (>= max issued number, invariant I2 safety) --------
  const maxSuffix = (docs, field) =>
    docs.reduce((m, d) => Math.max(m, suffixNum(d.data[field])), 0);
  const maxFood = maxSuffix(out.bills.filter((b) => b.data.type === "FOOD"), "billNo");
  const maxAlc = maxSuffix(out.bills.filter((b) => b.data.type === "ALCOHOL"), "billNo");
  const maxCafe = maxSuffix(out.bills.filter((b) => b.data.type === "CAFE"), "billNo");
  const maxQr = maxSuffix(out.qrOrders, "orderNo");
  const srcCounters = Object.fromEntries(
    (src.has("counters") ? src.all("SELECT * FROM counters") : []).map((r) => [r.name, Number(r.value) || 0]),
  );
  const mk = (name, prefix, srcName, floor) => {
    const value = Math.max(srcCounters[srcName] || 0, floor);
    if ((srcCounters[srcName] || 0) < floor) {
      notes.push(
        `counter ${name}: source value ${srcCounters[srcName] || 0} < max issued ${floor}; bumped to ${value}`,
      );
    }
    out.counters.push({ id: name, data: { value, prefix, updatedAt: new Date() } });
  };
  mk("foodBill", "FOOD", "food_bill", maxFood);
  mk("alcoholBill", "ALC", "alcohol_bill", maxAlc);
  mk("cafeBill", "CAFE", "cafe_bill", maxCafe); // new channel — usually 0 from a legacy source
  mk("qrOrder", "QR", "qr_order", maxQr);
  mk("websiteOrder", "WEB", "website_order", 0);

  return { docs: out, notes };
}
