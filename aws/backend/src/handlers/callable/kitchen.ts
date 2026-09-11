/**
 * Kitchen tickets — Lambda port of firebase/functions/src/callable/kitchen.ts.
 *
 *   acceptOrderToKitchen   billing/manager/admin "accepts" a QR-table order or
 *                          a paid website order -> a kitchen_tickets row.
 *                          Idempotent per source order (unique index
 *                          (source, source_id)).
 *   setKitchenTicketStatus kitchen/manager/admin steps QUEUED -> PREPARING ->
 *                          READY -> DONE.
 *
 * After each commit, broadcastKitchenEvent fans the change out over the
 * WebSocket API (realtime-stack.ts) to every connected Kitchen screen — the
 * direct replacement for Firestore onSnapshot. The kitchen role never sees
 * prices or the bill, only what to cook.
 */
import { randomUUID } from "crypto";
import { dispatch } from "../../lib/callable";
import { HttpError, assertRole } from "../../lib/authz";
import { BILLING_ROLES, KITCHEN_ROLES, KITCHEN_TICKET_STATUSES, legalKitchenTicketTransition, RESTAURANT_TZ } from "../../lib/config";
import { dateKey } from "../../lib/money";
import { auditInTx } from "../../lib/audit";
import { withTransaction } from "../../lib/db";
import { broadcast } from "../../lib/broadcastClient";

interface TicketItem { name: string; kind: string; qty: number; note: string }

const ticketRow = (id: string, d: any) => ({
  id, source: d.source, source_id: d.source_id ?? d.sourceId, ref: d.ref,
  table_label: d.table_label ?? d.tableLabel ?? null, customer_name: d.customer_name ?? d.customerName ?? "",
  items: (d.items || []).map((it: TicketItem) => ({ name: it.name, kind: it.kind, qty: it.qty, note: it.note ?? "" })),
  status: d.status, note: d.note ?? "", accepted_by: d.accepted_by_username ?? d.acceptedByUsername ?? "",
  created_at: d.created_at ?? d.createdAt ?? null, ready_at: d.ready_at ?? d.readyAt ?? null, done_at: d.done_at ?? d.doneAt ?? null,
});

export const handler = dispatch({
  async acceptOrderToKitchen(body, event) {
    const caller = assertRole(event as any, BILLING_ROLES);
    const source = String(body?.source ?? "").toLowerCase();
    const id = String(body?.id ?? "");
    if (source !== "qr" && source !== "website") throw new HttpError(422, "invalid-argument", "source must be 'qr' or 'website'");
    if (!id) throw new HttpError(422, "invalid-argument", "id is required");
    const table = source === "qr" ? "qr_orders" : "website_orders";
    const idCol = source === "qr" ? "public_ref" : "id";

    const out = await withTransaction(async (client) => {
      const snap = await client.query(`SELECT * FROM ${table} WHERE ${idCol}=$1 FOR UPDATE`, [id]);
      if (!snap.rowCount) throw new HttpError(404, "not-found", "Order not found");
      const order = snap.rows[0];

      if (order.kitchen_ticket_id) {
        const existing = await client.query("SELECT * FROM kitchen_tickets WHERE id=$1", [order.kitchen_ticket_id]);
        if (existing.rowCount) return ticketRow(existing.rows[0].id, existing.rows[0]);
      }

      let items: TicketItem[]; let ref: string; let tableLabel: string | null = null; let customerName = "";
      const now = new Date();
      if (source === "qr") {
        if (["CANCELLED", "SERVED"].includes(order.status)) throw new HttpError(409, "failed-precondition", `Cannot send a ${order.status} order to the kitchen`);
        items = (order.items || []).map((l: any) => ({ name: l.itemName, kind: l.kind || "food", qty: Number(l.qty) || 0, note: "" }));
        ref = order.order_no; tableLabel = order.table_no ?? null; customerName = order.customer_name ?? "";
        if (order.status === "NEW") await client.query("UPDATE qr_orders SET status='ACCEPTED', updated_at=$2 WHERE public_ref=$1", [id, now]);
      } else {
        if (!["CONFIRMED", "PREPARING", "READY"].includes(order.status)) throw new HttpError(409, "failed-precondition", `A website order must be paid/confirmed before kitchen (is ${order.status})`);
        items = (order.items || []).map((l: any) => ({ name: l.name, kind: l.kind || "food", qty: Number(l.qty) || 0, note: "" }));
        ref = order.ref; customerName = order.customer?.name ?? "";
        if (order.status === "CONFIRMED") await client.query("UPDATE website_orders SET status='PREPARING', updated_at=$2 WHERE id=$1", [id, now]);
      }
      if (items.length === 0) throw new HttpError(409, "failed-precondition", "That order has no items");

      const ticketId = "kt_" + randomUUID();
      await client.query(
        `INSERT INTO kitchen_tickets (id, source, source_id, ref, table_label, customer_name, items, status, note,
           accepted_by_uid, accepted_by_username, created_at, updated_at, date_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$9,$10,$11,$11,$12)`,
        [ticketId, source, id, ref, tableLabel, customerName, JSON.stringify(items), order.note ?? "", caller.uid, caller.username || null, now, order.date_key || dateKey(now, RESTAURANT_TZ)],
      );
      await client.query(`UPDATE ${table} SET kitchen_ticket_id=$2, kitchen_status='QUEUED' WHERE ${idCol}=$1`, [id, ticketId]);
      await auditInTx(client, { actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action: "kitchen.accept", entityType: "kitchen_ticket", entityId: ticketId, details: { source, ref, source_id: id, items: items.length } });

      return ticketRow(ticketId, { source, source_id: id, ref, table_label: tableLabel, customer_name: customerName, items, status: "QUEUED", note: order.note ?? "", accepted_by_username: caller.username || null, created_at: now });
    });

    await broadcast("kitchen", { type: "ticket.created", ticket: out }).catch((e) => console.error("broadcast failed (non-fatal)", e));
    return out;
  },

  async setKitchenTicketStatus(body, event) {
    assertRole(event as any, KITCHEN_ROLES);
    const id = String(body?.id ?? "");
    const to = String(body?.status ?? "").toUpperCase();
    if (!id) throw new HttpError(422, "invalid-argument", "id is required");
    if (!(KITCHEN_TICKET_STATUSES as readonly string[]).includes(to) || to === "QUEUED") {
      throw new HttpError(422, "invalid-argument", "status must be PREPARING, READY or DONE");
    }

    const out = await withTransaction(async (client) => {
      const snap = await client.query("SELECT * FROM kitchen_tickets WHERE id=$1 FOR UPDATE", [id]);
      if (!snap.rowCount) throw new HttpError(404, "not-found", "Ticket not found");
      const t = snap.rows[0];
      const from = String(t.status ?? "");
      if (from === to) return ticketRow(id, t);
      if (!legalKitchenTicketTransition(from, to)) throw new HttpError(409, "failed-precondition", `Cannot move a ticket from ${from} to ${to}`);
      const now = new Date();
      const readyAt = to === "READY" ? now : t.ready_at;
      const doneAt = to === "DONE" ? now : t.done_at;
      await client.query("UPDATE kitchen_tickets SET status=$2, updated_at=$3, ready_at=$4, done_at=$5 WHERE id=$1", [id, to, now, readyAt, doneAt]);
      if (t.source && t.source_id) {
        const table = t.source === "qr" ? "qr_orders" : "website_orders";
        const idCol = t.source === "qr" ? "public_ref" : "id";
        await client.query(`UPDATE ${table} SET kitchen_status=$2, updated_at=$3 WHERE ${idCol}=$1`, [t.source_id, to, now]);
      }
      return ticketRow(id, { ...t, status: to, ready_at: readyAt, done_at: doneAt });
    });

    await broadcast("kitchen", { type: "ticket.updated", ticket: out }).catch((e) => console.error("broadcast failed (non-fatal)", e));
    return out;
  },
});
