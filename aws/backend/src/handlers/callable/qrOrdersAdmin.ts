/**
 * Staff-side QR order management — Lambda port of
 * firebase/functions/src/callable/qrOrdersAdmin.ts. Neither operation is
 * audited (matches the Firebase version).
 */
import { randomUUID } from "crypto";
import { dispatch } from "../../lib/callable";
import { HttpError, assertRole } from "../../lib/authz";
import { QR_STATUSES, legalQrTransition } from "../../lib/config";
import { round2 } from "../../lib/money";
import { withTransaction } from "../../lib/db";
import { broadcast } from "../../lib/broadcastClient";

const OPERATIONAL = ["billing", "manager", "admin"] as const;

const sum = (rows: any[], f: string) => round2(rows.reduce((s, r) => s + Number(r[f] || 0), 0));
const taxOf = (rows: any[]) => round2(rows.reduce((s, r) => s + (Number(r.lineTotal || 0) * Number(r.taxRate || 0)) / 100, 0));

export const handler = dispatch({
  async setQrOrderStatus(body, event) {
    assertRole(event as any, [...OPERATIONAL]);
    const ref = String(body?.ref ?? "");
    const status = String(body?.status ?? "").toUpperCase();
    if (!ref) throw new HttpError(422, "invalid-argument", "ref is required");
    if (!(QR_STATUSES as readonly string[]).includes(status)) throw new HttpError(422, "invalid-argument", "Unknown status");

    const out = await withTransaction(async (client) => {
      const snap = await client.query("SELECT * FROM qr_orders WHERE public_ref=$1 FOR UPDATE", [ref]);
      if (!snap.rowCount) throw new HttpError(404, "not-found", "Order not found");
      const from = String(snap.rows[0].status ?? "NEW");
      if (from === status) return { ref, ...snap.rows[0] };
      if (!legalQrTransition(from, status)) throw new HttpError(409, "failed-precondition", `Cannot move an order from ${from} to ${status}`);
      await client.query("UPDATE qr_orders SET status=$2, updated_at=now() WHERE public_ref=$1", [ref, status]);
      const after = await client.query("SELECT * FROM qr_orders WHERE public_ref=$1", [ref]);
      return { ref, ...after.rows[0] };
    });
    await broadcast("live_orders", { type: "qr_order.status", ref, status }).catch((e) => console.error("broadcast failed (non-fatal)", e));
    return out;
  },

  async pushQrOrderToBill(body, event) {
    const caller = assertRole(event as any, [...OPERATIONAL]);
    const ref = String(body?.ref ?? "");
    if (!ref) throw new HttpError(422, "invalid-argument", "ref is required");

    return withTransaction(async (client) => {
      const orderSnap = await client.query("SELECT * FROM qr_orders WHERE public_ref=$1 FOR UPDATE", [ref]);
      if (!orderSnap.rowCount) throw new HttpError(404, "not-found", "Order not found");
      const order = orderSnap.rows[0];
      if (order.status === "CANCELLED") throw new HttpError(409, "failed-precondition", "This order is cancelled");
      if (order.pushed_to_bill) throw new HttpError(409, "failed-precondition", "This order is already on the table bill");
      const items: any[] = Array.isArray(order.items) ? order.items : [];
      if (items.length === 0) throw new HttpError(409, "failed-precondition", "This order has no items");

      const openSnap = await client.query("SELECT * FROM table_sessions WHERE table_id=$1 AND status='open' LIMIT 1 FOR UPDATE", [order.table_id]);
      let sessionId: string;
      if (!openSnap.rowCount) {
        sessionId = "sess_" + randomUUID();
        await client.query(
          `INSERT INTO table_sessions (id, table_id, table_no, customer_name, customer_phone, status, opened_at, opened_by_uid, items, subtotal, tax, grand_total)
           VALUES ($1,$2,$3,$4,'-','open',now(),$5,$6,$7,$8,$9)`,
          [sessionId, order.table_id, order.table_no ?? "", order.customer_name || "Walk-in", caller.uid, JSON.stringify(items), sum(items, "lineTotal"), taxOf(items), round2(sum(items, "lineTotal") + taxOf(items))],
        );
        await client.query("UPDATE restaurant_tables SET status='occupied', open_session_id=$2, updated_at=now() WHERE id=$1", [order.table_id, sessionId]);
      } else {
        sessionId = openSnap.rows[0].id;
        const merged = [...(openSnap.rows[0].items || []), ...items];
        await client.query(
          "UPDATE table_sessions SET items=$2, subtotal=$3, tax=$4, grand_total=$5 WHERE id=$1",
          [sessionId, JSON.stringify(merged), sum(merged, "lineTotal"), taxOf(merged), round2(sum(merged, "lineTotal") + taxOf(merged))],
        );
      }
      await client.query("UPDATE qr_orders SET pushed_to_bill=true, table_session_id=$2, status='SERVED', updated_at=now() WHERE public_ref=$1", [ref, sessionId]);
      const after = await client.query("SELECT * FROM qr_orders WHERE public_ref=$1", [ref]);
      return { ref, table_session_id: sessionId, ...after.rows[0] };
    });
  },
});
