/**
 * catalog reads + the stock-decrement primitive (FIRESTORE-SCHEMA.md §4,
 * invariant I3 — ported from backend/app.py apply_stock_delta).
 */
import type {
  Firestore,
  Transaction,
  Query,
} from "firebase-admin/firestore";
import type { Kind } from "./ids";

export function menuQuery(db: Firestore, kind: Kind): Query {
  return db
    .collection("catalog")
    .where("kind", "==", kind)
    .where("status", "==", "active")
    .orderBy("categorySort")
    .orderBy("nameLower");
}

export function itemsInCategoryQuery(db: Firestore, categoryId: string): Query {
  return db
    .collection("catalog")
    .where("status", "==", "active")
    .where("categoryId", "==", categoryId)
    .orderBy("nameLower");
}

/**
 * Decrement (delta < 0) or restore (delta > 0) tracked stock for one catalog
 * item, inside a transaction. A null stockQty means "not tracked" and is left
 * alone; tracked stock never goes below zero. Mirrors:
 *   UPDATE {t} SET stock_qty = CASE WHEN stock_qty + ? < 0 THEN 0
 *          ELSE stock_qty + ? END WHERE id = ? AND stock_qty IS NOT NULL
 */
export async function applyStockDelta(
  tx: Transaction,
  db: Firestore,
  itemId: string | null | undefined,
  delta: number,
): Promise<void> {
  if (!itemId || !delta) return;
  const ref = db.collection("catalog").doc(itemId);
  const snap = await tx.get(ref);
  if (!snap.exists) return;
  const stockQty = snap.data()?.stockQty;
  if (stockQty === null || stockQty === undefined) return; // not tracked
  const next = Math.max(0, Number(stockQty) + delta);
  tx.update(ref, { stockQty: next, updatedAt: new Date() });
}
