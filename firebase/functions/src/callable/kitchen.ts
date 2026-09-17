/**
 * Kitchen tickets — the "separate UI" for the kitchen role.
 *
 *   acceptOrderToKitchen   billing/manager/admin "accepts" a QR-table order or a
 *                          (paid) website order -> a kitchenTickets doc is
 *                          raised. Idempotent per source order.
 *   setKitchenTicketStatus kitchen/manager/admin steps QUEUED -> PREPARING ->
 *                          READY -> DONE.
 *
 * The kitchen screen listens to kitchenTickets in realtime (with a chime); it
 * never sees prices or the bill — only what to cook. The cafe channel is
 * self-contained and never raises a kitchen ticket.
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import {
  REGION, RESTAURANT_TZ, BILLING_ROLES, KITCHEN_ROLES,
  KITCHEN_TICKET_STATUSES, legalKitchenTicketTransition,
} from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { assertRole } from "../lib/authz";
import { callable } from "../lib/wrap";
import { auditInTx } from "../lib/audit";
import { dateKey } from "../lib/money";

interface TicketItem { name: string; kind: string; qty: number; note: string }

const ticketRow = (id: string, d: any) => ({
  id,
  source: d.source,
  source_id: d.sourceId,
  ref: d.ref,
  table_label: d.tableLabel ?? null,
  customer_name: d.customerName ?? "",
  items: (d.items || []).map((it: TicketItem) => ({
    name: it.name, kind: it.kind, qty: it.qty, note: it.note ?? "",
  })),
  status: d.status,
  note: d.note ?? "",
  accepted_by: d.acceptedByUsername ?? "",
  created_at: d.createdAt?.toDate?.() ?? d.createdAt ?? null,
  ready_at: d.readyAt?.toDate?.() ?? d.readyAt ?? null,
  done_at: d.doneAt?.toDate?.() ?? d.doneAt ?? null,
});

// -------------------------------------------------------- acceptOrderToKitchen

export interface AcceptInput {
  source?: unknown; // "qr" | "website"
  id?: unknown; // qrOrder doc id / websiteOrder doc id
}

export async function handleAcceptOrderToKitchen(req: CallableRequest<AcceptInput>) {
  const caller = assertRole(req, BILLING_ROLES);
  const db = getDb();
  const source = String(req.data?.source ?? "").toLowerCase();
  const id = String(req.data?.id ?? "");
  if (source !== "qr" && source !== "website") {
    throw new HttpsError("invalid-argument", "source must be 'qr' or 'website'");
  }
  if (!id) throw new HttpsError("invalid-argument", "id is required");

  const orderRef = db.collection(source === "qr" ? "qrOrders" : "websiteOrders").doc(id);
  let out: any = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found");
    const order = snap.data()!;

    // idempotent — one kitchen ticket per source order
    if (order.kitchenTicketId) {
      const existing = await tx.get(db.collection("kitchenTickets").doc(order.kitchenTicketId));
      out = existing.exists ? ticketRow(existing.id, existing.data()) : null;
      if (out) return;
    }

    let items: TicketItem[];
    let ref: string;
    let tableLabel: string | null = null;
    let customerName = "";
    const now = new Date();

    if (source === "qr") {
      if (["CANCELLED", "SERVED"].includes(order.status)) {
        throw new HttpsError("failed-precondition", `Cannot send a ${order.status} order to the kitchen`);
      }
      items = (order.items || []).map((l: any) => ({
        name: l.itemName, kind: l.kind || "food", qty: Number(l.qty) || 0, note: "",
      }));
      ref = order.orderNo;
      tableLabel = order.tableNo ?? null;
      customerName = order.customerName ?? "";
      if (order.status === "NEW") tx.update(orderRef, { status: "ACCEPTED", updatedAt: now });
    } else {
      if (!["CONFIRMED", "PREPARING", "READY"].includes(order.status)) {
        throw new HttpsError("failed-precondition", `A website order must be paid/confirmed before kitchen (is ${order.status})`);
      }
      items = (order.items || []).map((l: any) => ({
        name: l.name, kind: l.kind || "food", qty: Number(l.qty) || 0, note: "",
      }));
      ref = order.ref;
      customerName = order.customer?.name ?? "";
      if (order.status === "CONFIRMED") tx.update(orderRef, { status: "PREPARING", updatedAt: now });
    }
    if (items.length === 0) throw new HttpsError("failed-precondition", "That order has no items");

    const ticketRef = db.collection("kitchenTickets").doc();
    tx.set(ticketRef, {
      source, sourceId: id, ref,
      tableLabel, customerName,
      items,
      status: "QUEUED",
      note: order.note ?? "",
      acceptedByUid: caller.uid,
      acceptedByUsername: caller.username || null,
      createdAt: now, updatedAt: now, readyAt: null, doneAt: null,
      dateKey: order.dateKey || dateKey(now, RESTAURANT_TZ),
    });
    // denormalise onto the source order so the Billing boards show live kitchen
    // status straight from their existing snapshot (no extra read).
    tx.update(orderRef, { kitchenTicketId: ticketRef.id, kitchenStatus: "QUEUED" });
    auditInTx(tx, db, {
      actorUid: caller.uid,
      actorUsername: caller.username || null,
      actorRole: caller.role,
      action: "kitchen.accept",
      entityType: "kitchen_ticket",
      entityId: ticketRef.id,
      details: { source, ref, source_id: id, items: items.length },
    });
    out = ticketRow(ticketRef.id, {
      source, sourceId: id, ref, tableLabel, customerName, items,
      status: "QUEUED", note: order.note ?? "", acceptedByUsername: caller.username || null,
      createdAt: now, readyAt: null, doneAt: null,
    });
  });

  return out;
}

// ------------------------------------------------------ setKitchenTicketStatus

export interface SetTicketStatusInput {
  id?: unknown;
  status?: unknown;
}

export async function handleSetKitchenTicketStatus(req: CallableRequest<SetTicketStatusInput>) {
  assertRole(req, KITCHEN_ROLES);
  const db = getDb();
  const id = String(req.data?.id ?? "");
  const to = String(req.data?.status ?? "").toUpperCase();
  if (!id) throw new HttpsError("invalid-argument", "id is required");
  if (!(KITCHEN_TICKET_STATUSES as readonly string[]).includes(to) || to === "QUEUED") {
    throw new HttpsError("invalid-argument", "status must be PREPARING, READY or DONE");
  }
  const ref = db.collection("kitchenTickets").doc(id);
  let out: any = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found");
    const t = snap.data()!;
    const from = String(t.status ?? "");
    if (from === to) { out = ticketRow(ref.id, t); return; }
    if (!legalKitchenTicketTransition(from, to)) {
      throw new HttpsError("failed-precondition", `Cannot move a ticket from ${from} to ${to}`);
    }
    const now = new Date();
    const patch: any = { status: to, updatedAt: now };
    if (to === "READY") patch.readyAt = now;
    if (to === "DONE") patch.doneAt = now;
    tx.update(ref, patch);
    // mirror onto the source order so Billing sees the updated status live
    if (t.source && t.sourceId) {
      const col = t.source === "qr" ? "qrOrders" : "websiteOrders";
      tx.set(db.collection(col).doc(t.sourceId), { kitchenStatus: to, updatedAt: now }, { merge: true });
    }
    out = ticketRow(ref.id, { ...t, ...patch });
  });
  return out;
}

export const acceptOrderToKitchen = onCall({ region: REGION }, callable(handleAcceptOrderToKitchen));
export const setKitchenTicketStatus = onCall({ region: REGION }, callable(handleSetKitchenTicketStatus));
