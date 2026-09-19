/**
 * Stock decrement/restore split into a read phase and a write phase, so it can
 * compose inside a transaction that also touches counters + bills + sessions
 * (Firestore requires all reads before all writes).
 *
 * Semantics identical to backend/app.py apply_stock_delta (invariant I3):
 *   NULL/absent stockQty  -> not tracked, left alone
 *   tracked               -> max(0, stockQty + delta)
 */
import type {
  Firestore,
  Transaction,
  DocumentSnapshot,
} from "firebase-admin/firestore";

export async function readStockSnapshots(
  tx: Transaction,
  db: Firestore,
  itemIds: Array<string | number | null | undefined>,
): Promise<Map<string, DocumentSnapshot>> {
  const ids = [...new Set(itemIds.filter((x): x is string => typeof x === "string" && x.length > 0))];
  const snaps = await Promise.all(ids.map((id) => tx.get(db.collection("catalog").doc(id))));
  const map = new Map<string, DocumentSnapshot>();
  ids.forEach((id, i) => map.set(id, snaps[i]));
  return map;
}

export interface StockDelta {
  itemId: string | number | null | undefined;
  delta: number;
}

/** Write phase — call after readStockSnapshots, during the transaction's writes. */
export function applyStockWrites(
  tx: Transaction,
  snapshots: Map<string, DocumentSnapshot>,
  deltas: StockDelta[],
): void {
  // Fold repeated itemIds so two lines of the same dish decrement once, correctly.
  const byId = new Map<string, number>();
  for (const { itemId, delta } of deltas) {
    if (typeof itemId !== "string" || !itemId || !delta) continue;
    byId.set(itemId, (byId.get(itemId) || 0) + delta);
  }
  for (const [itemId, delta] of byId) {
    const snap = snapshots.get(itemId);
    if (!snap || !snap.exists) continue;
    const cur = snap.data()?.stockQty;
    if (cur === null || cur === undefined) continue; // not tracked
    tx.update(snap.ref, { stockQty: Math.max(0, Number(cur) + delta), updatedAt: new Date() });
  }
}
