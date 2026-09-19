/**
 * Read-query builders matching FIRESTORE-SCHEMA.md §Query→index matrix. Thin
 * wrappers so the Phase 4 Functions and Phase 5 client code (which rebuilds the
 * equivalents with the Web SDK) share one definition of each query's shape.
 */
import type { Firestore, Query } from "firebase-admin/firestore";
import { QR_STATUSES } from "./config";

const ACTIVE_QR = QR_STATUSES.filter((s) => s !== "SERVED" && s !== "CANCELLED");

// Firestore prefix-range upper bound (highest BMP private-use codepoint).
const PREFIX_HI = String.fromCharCode(0xf8ff);

export const tablesQuery = (db: Firestore): Query =>
  db.collection("tables").orderBy("tableNo");

export const tableByTokenQuery = (db: Firestore, qrToken: string): Query =>
  db.collection("tables").where("qrToken", "==", qrToken).limit(1);

export const openSessionForTableQuery = (db: Firestore, tableId: string): Query =>
  db
    .collection("tableSessions")
    .where("tableId", "==", tableId)
    .where("status", "==", "open")
    .limit(1);

export interface OrdersFilter {
  type?: "FOOD" | "ALCOHOL";
  dateKey?: string;
  search?: string;
  limit?: number;
}

/** Replaces GET /api/orders (the food_bills union alcohol_bills query). */
export function ordersQuery(db: Firestore, f: OrdersFilter = {}): Query {
  let q: Query = db.collection("bills");
  if (f.search) {
    q = q.where("searchTokens", "array-contains", f.search.trim().toLowerCase());
  }
  if (f.type) q = q.where("type", "==", f.type);
  if (f.dateKey) q = q.where("dateKey", "==", f.dateKey);
  q = q.orderBy("createdAt", "desc");
  if (f.limit) q = q.limit(Math.min(Math.max(f.limit, 1), 200));
  return q;
}

/** Replaces GET /api/reports/export (date range on created_at + optional type). */
export function reportQuery(
  db: Firestore,
  opts: { from?: string; to?: string; type?: "FOOD" | "ALCOHOL" } = {},
): Query {
  let q: Query = db.collection("bills");
  if (opts.type) q = q.where("type", "==", opts.type);
  if (opts.from) q = q.where("dateKey", ">=", opts.from);
  if (opts.to) q = q.where("dateKey", "<=", opts.to);
  return q.orderBy("dateKey");
}

/** Kitchen board — active statuses, newest first. */
export const qrBoardQuery = (db: Firestore): Query =>
  db
    .collection("qrOrders")
    .where("status", "in", ACTIVE_QR as unknown as string[])
    .orderBy("createdAt", "desc");

export const qrByStatusQuery = (db: Firestore, status: string): Query =>
  db.collection("qrOrders").where("status", "==", status).orderBy("createdAt", "desc");

export const qrTodayQuery = (db: Firestore, dateKey: string): Query =>
  db.collection("qrOrders").where("dateKey", "==", dateKey).orderBy("createdAt", "desc");

export const qrTodayForTableQuery = (
  db: Firestore,
  tableId: string,
  dateKey: string,
): Query =>
  db
    .collection("qrOrders")
    .where("tableId", "==", tableId)
    .where("dateKey", "==", dateKey)
    .orderBy("createdAt", "desc");

export const qrNewCountQuery = (db: Firestore): Query =>
  db.collection("qrOrders").where("status", "==", "NEW");

export const activeAdminsQuery = (db: Firestore): Query =>
  db.collection("users").where("role", "==", "admin").where("status", "==", "active");

export function auditQuery(
  db: Firestore,
  opts: { entityType?: string; actionPrefix?: string } = {},
): Query {
  const q: Query = db.collection("auditLog");
  if (opts.entityType) {
    // index: auditLog(entityType ASC, createdAt DESC)
    return q.where("entityType", "==", opts.entityType).orderBy("createdAt", "desc");
  }
  if (opts.actionPrefix) {
    // Flask `action LIKE 'staff.%'` -> Firestore prefix range.
    // index: auditLog(action ASC, createdAt DESC)
    const p = opts.actionPrefix;
    return q
      .where("action", ">=", p)
      .where("action", "<", p + PREFIX_HI)
      .orderBy("action")
      .orderBy("createdAt", "desc");
  }
  return q.orderBy("createdAt", "desc");
}
