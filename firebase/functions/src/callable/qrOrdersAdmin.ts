/**
 * Staff-side QR order management — replaces Flask
 *   POST /api/qr-ordering/orders/<id>/status
 *   POST /api/qr-ordering/orders/<id>/push-to-bill
 * Neither is audited by Flask, so neither is here.
 *
 * setQrOrderStatus enforces the one-legal-step FSM (matches firestore.rules and
 * the kitchen board's actual usage); Flask's endpoint technically accepted any
 * status but the UI never did — this is the approved Phase-3 tightening.
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { REGION, QR_STATUSES, legalQrTransition } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { assertRole } from "../lib/authz";

const OPERATIONAL = ["billing", "manager", "admin"] as const;

export interface SetQrStatusInput {
  ref?: unknown;
  status?: unknown;
}

export async function handleSetQrOrderStatus(req: CallableRequest<SetQrStatusInput>) {
  assertRole(req, [...OPERATIONAL]);
  const db = getDb();
  const ref = String(req.data?.ref ?? "");
  const status = String(req.data?.status ?? "").toUpperCase();
  if (!ref) throw new HttpsError("invalid-argument", "ref is required");
  if (!(QR_STATUSES as readonly string[]).includes(status)) {
    throw new HttpsError("invalid-argument", "Unknown status");
  }
  const docRef = db.collection("qrOrders").doc(ref);
  const snap = await docRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Order not found");
  const from = String(snap.data()?.status ?? "NEW");
  if (from === status) return { ref, status, ...snap.data() }; // no-op
  if (!legalQrTransition(from, status)) {
    throw new HttpsError("failed-precondition", `Cannot move an order from ${from} to ${status}`);
  }
  await docRef.set({ status, updatedAt: new Date() }, { merge: true });
  const after = await docRef.get();
  return { ref, ...after.data() };
}

// ------------------------------------------------------------- push to bill

export interface PushToBillInput {
  ref?: unknown;
}

export async function handlePushQrOrderToBill(req: CallableRequest<PushToBillInput>) {
  const caller = assertRole(req, [...OPERATIONAL]);
  const db = getDb();
  const ref = String(req.data?.ref ?? "");
  if (!ref) throw new HttpsError("invalid-argument", "ref is required");

  const out: { ref: string; table_session_id: string | null } = { ref, table_session_id: null };

  await db.runTransaction(async (tx) => {
    const orderRef = db.collection("qrOrders").doc(ref);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found");
    const order = orderSnap.data()!;
    if (order.status === "CANCELLED") throw new HttpsError("failed-precondition", "This order is cancelled");
    if (order.pushedToBill) {
      throw new HttpsError("failed-precondition", "This order is already on the table bill");
    }
    const items: any[] = Array.isArray(order.items) ? order.items : [];
    if (items.length === 0) throw new HttpsError("failed-precondition", "This order has no items");

    const tableRef = db.collection("tables").doc(String(order.tableId));
    const openSnap = await tx.get(
      db
        .collection("tableSessions")
        .where("tableId", "==", order.tableId)
        .where("status", "==", "open")
        .limit(1),
    );

    let sessionRef: FirebaseFirestore.DocumentReference;
    let mergedItems: any[];
    if (openSnap.empty) {
      sessionRef = db.collection("tableSessions").doc();
      mergedItems = items;
      tx.set(sessionRef, {
        tableId: order.tableId,
        tableNo: order.tableNo ?? "",
        customerName: order.customerName || "Walk-in",
        customerPhone: "-",
        status: "open",
        openedAt: new Date(),
        openedByUid: caller.uid,
        settledAt: null,
        items: mergedItems,
        subtotal: sum(mergedItems, "lineTotal"),
        tax: taxOf(mergedItems),
        grandTotal: round2(sum(mergedItems, "lineTotal") + taxOf(mergedItems)),
        settledBillIds: [],
      });
      tx.update(tableRef, { status: "occupied", openSessionId: sessionRef.id, updatedAt: new Date() });
    } else {
      sessionRef = openSnap.docs[0].ref;
      const existing: any[] = openSnap.docs[0].data().items || [];
      mergedItems = [...existing, ...items];
      tx.update(sessionRef, {
        items: mergedItems,
        subtotal: sum(mergedItems, "lineTotal"),
        tax: taxOf(mergedItems),
        grandTotal: round2(sum(mergedItems, "lineTotal") + taxOf(mergedItems)),
        updatedAt: new Date(),
      });
    }

    tx.update(orderRef, {
      pushedToBill: true,
      tableSessionId: sessionRef.id,
      status: "SERVED",
      updatedAt: new Date(),
    });
    out.table_session_id = sessionRef.id;
  });

  const after = await db.collection("qrOrders").doc(ref).get();
  return { ...out, ...after.data() };
}

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const sum = (rows: any[], f: string) => round2(rows.reduce((s, r) => s + Number(r[f] || 0), 0));
const taxOf = (rows: any[]) =>
  round2(rows.reduce((s, r) => s + (Number(r.lineTotal || 0) * Number(r.taxRate || 0)) / 100, 0));

// ------------------------------------------------------------------- exports

export const setQrOrderStatus = onCall(
  { region: REGION },
  (r: CallableRequest<SetQrStatusInput>) => handleSetQrOrderStatus(r),
);
export const pushQrOrderToBill = onCall(
  { region: REGION },
  (r: CallableRequest<PushToBillInput>) => handlePushQrOrderToBill(r),
);
