/**
 * POS-side Website Orders workflow (staff/manager/admin) — Lambda port of
 * firebase/functions/src/callable/websiteOrdersAdmin.ts:
 *   setWebsiteOrderStatus   CONFIRMED -> PREPARING -> READY, or CANCEL
 *   addItemsToWebsiteOrder  append items at CURRENT catalog prices, recompute
 *                           totals/balance (integer paise, server-side only)
 *   settleWebsiteOrder      reuse the billing/stock/bill-number/immutable-bill
 *                           machinery; the bill keeps `ref` (WEB-000123)
 * paymentStatus and status are separate state machines. Nothing here trusts
 * a client amount.
 */
import { randomUUID } from "crypto";
import { dispatch } from "../../lib/callable";
import { HttpError, assertRole } from "../../lib/authz";
import { WEBSITE_ORDER_STATUSES, legalWebsiteOrderTransition, RESTAURANT_TZ } from "../../lib/config";
import { priceCartPaise, PaiseLine } from "../../lib/pricing";
import { peekCounter, commitCounter, CounterName } from "../../lib/counters";
import { readStockSnapshots, applyStockWrites } from "../../lib/stock";
import { buildBillRow, insertBill } from "../../lib/billDoc";
import { auditInTx } from "../../lib/audit";
import { dateKey } from "../../lib/money";
import { withTransaction } from "../../lib/db";
import { broadcast } from "../../lib/broadcastClient";
import { computeRolling } from "../../lib/statsService";

const OPERATIONAL = ["billing", "manager", "admin"] as const;
const MODIFIABLE = ["CONFIRMED", "PREPARING", "READY"];

const orderRow = (row: any) => ({
  id: row.id, ref: row.ref, status: row.status, payment_status: row.payment_status,
  customer: row.customer || {},
  fulfillment: { type: row.fulfillment?.type || "pickup", pickup_at: row.fulfillment?.pickupAt ?? null, notes: row.fulfillment?.notes ?? "" },
  items: (row.items || []).map((it: any) => ({ item_id: it.itemId, item_name: it.name, kind: it.kind, brand: it.brand ?? "", bottle_size: it.bottleSize ?? "", unit_price_paise: it.unitPricePaise, qty: it.qty, tax_rate: it.taxRatePct ?? 0, line_total_paise: it.lineTotalPaise })),
  subtotal_paise: row.subtotal_paise, tax_paise: row.tax_paise, total_paise: row.total_paise,
  advance_paise: row.advance_paise, balance_paise: row.balance_paise, paid_paise: row.paid_paise || 0,
  settled_bill_ids: row.settled_bill_ids || [], settled_bill_nos: row.settled_bill_nos || [],
  bill_status: (row.settled_bill_nos || []).length ? "billed" : "unbilled",
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  confirmed_at: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
});

function recomputePaise(items: any[]) {
  const subtotalPaise = items.reduce((s, i) => s + Number(i.lineTotalPaise), 0);
  const taxPaise = items.reduce((s, i) => s + Math.round((Number(i.lineTotalPaise) * Number(i.taxRatePct || 0)) / 100), 0);
  return { subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

export const handler = dispatch({
  async setWebsiteOrderStatus(body, event) {
    assertRole(event as any, [...OPERATIONAL]);
    const id = String(body?.order_id ?? "");
    const to = String(body?.status ?? "").toUpperCase();
    if (!id) throw new HttpError(422, "invalid-argument", "order_id is required");
    if (!(WEBSITE_ORDER_STATUSES as readonly string[]).includes(to)) throw new HttpError(422, "invalid-argument", "Unknown status");
    if (["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "PAYMENT_FAILED"].includes(to)) {
      throw new HttpError(409, "failed-precondition", to === "COMPLETED" ? "Use Settle Bill to complete a website order" : `${to} is set by the payment flow`);
    }
    const out = await withTransaction(async (client) => {
      const snap = await client.query("SELECT * FROM website_orders WHERE id=$1 FOR UPDATE", [id]);
      if (!snap.rowCount) throw new HttpError(404, "not-found", "Order not found");
      const from = String(snap.rows[0].status ?? "");
      if (from === to) return orderRow(snap.rows[0]);
      if (!legalWebsiteOrderTransition(from, to)) throw new HttpError(409, "failed-precondition", `Cannot move an order from ${from} to ${to}`);
      await client.query("UPDATE website_orders SET status=$2, updated_at=now() WHERE id=$1", [id, to]);
      const after = await client.query("SELECT * FROM website_orders WHERE id=$1", [id]);
      return orderRow(after.rows[0]);
    });
    await broadcast("website_orders", { type: "order.status", id, status: to }).catch((e) => console.error("broadcast failed (non-fatal)", e));
    return out;
  },

  async addItemsToWebsiteOrder(body, event) {
    const caller = assertRole(event as any, [...OPERATIONAL]);
    const id = String(body?.order_id ?? "");
    if (!id) throw new HttpError(422, "invalid-argument", "order_id is required");

    const out = await withTransaction(async (client) => {
      const snap = await client.query("SELECT * FROM website_orders WHERE id=$1 FOR UPDATE", [id]);
      if (!snap.rowCount) throw new HttpError(404, "not-found", "Order not found");
      const order = snap.rows[0];
      if (!MODIFIABLE.includes(order.status)) throw new HttpError(409, "failed-precondition", "This order can no longer be modified");

      const priced = await priceCartPaise(
        async (itemId) => {
          const r = await client.query("SELECT * FROM catalog WHERE id=$1", [itemId]);
          if (!r.rows[0]) return null;
          const d = r.rows[0];
          return { name: d.name, status: d.status, kind: d.kind, price: d.price, taxRate: d.tax_rate, stockQty: d.stock_qty, brand: d.brand, bottleSize: d.bottle_size };
        },
        body?.items, { requireInStock: false },
      );
      const merged = [...(order.items || []), ...priced.items];
      const { subtotalPaise, taxPaise, totalPaise } = recomputePaise(merged);
      const paidPaise = Number(order.paid_paise) || 0;
      const balancePaise = Math.max(0, totalPaise - paidPaise);

      await client.query("UPDATE website_orders SET items=$2, subtotal_paise=$3, tax_paise=$4, total_paise=$5, balance_paise=$6, updated_at=now() WHERE id=$1", [id, JSON.stringify(merged), subtotalPaise, taxPaise, totalPaise, balancePaise]);
      await auditInTx(client, { actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action: "website.order.additems", entityType: "website_order", entityId: id, details: { ref: order.ref, added: priced.items.map((l: PaiseLine) => `${l.name} x${l.qty}`), total_paise: totalPaise, balance_paise: balancePaise } });
      const after = await client.query("SELECT * FROM website_orders WHERE id=$1", [id]);
      return orderRow(after.rows[0]);
    });
    await broadcast("website_orders", { type: "order.items", id }).catch((e) => console.error("broadcast failed (non-fatal)", e));
    return out;
  },

  async settleWebsiteOrder(body, event) {
    const caller = assertRole(event as any, [...OPERATIONAL]);
    const id = String(body?.order_id ?? "");
    if (!id) throw new HttpError(422, "invalid-argument", "order_id is required");
    const paymentMethod = String(body?.payment_method ?? "Cash").trim() || "Cash";

    const out = await withTransaction(async (client) => {
      const snap = await client.query("SELECT * FROM website_orders WHERE id=$1 FOR UPDATE", [id]);
      if (!snap.rowCount) throw new HttpError(404, "not-found", "Order not found");
      const order = snap.rows[0];
      if (order.status === "COMPLETED" || (order.settled_bill_ids || []).length > 0) throw new HttpError(409, "failed-precondition", "This website order is already settled");
      if (["CANCELLED", "PAYMENT_FAILED", "PENDING_PAYMENT"].includes(order.status)) throw new HttpError(409, "failed-precondition", `Cannot settle a ${order.status} order`);
      const lines: any[] = Array.isArray(order.items) ? order.items : [];
      if (lines.length === 0) throw new HttpError(409, "failed-precondition", "This order has no items");

      const stockSnaps = await readStockSnapshots(client, lines.map((l) => l.itemId));
      const foodLines = lines.filter((l) => l.kind !== "alcohol");
      const alcLines = lines.filter((l) => l.kind === "alcohol");
      const groups: Array<["food" | "alcohol", any[]]> = [];
      if (foodLines.length) groups.push(["food", foodLines]);
      if (alcLines.length) groups.push(["alcohol", alcLines]);

      let foodNext = groups.some((g) => g[0] === "food") ? await peekCounter(client, "foodBill") : 0;
      let alcNext = groups.some((g) => g[0] === "alcohol") ? await peekCounter(client, "alcoholBill") : 0;

      const createdAt = new Date();
      const billIds: string[] = []; const billNos: string[] = [];
      const bills: Array<{ type: string; id: string; bill_no: string }> = [];
      let settledSubtotalPaise = 0, settledTaxPaise = 0;

      for (const [kind, group] of groups) {
        const counterName: CounterName = kind === "food" ? "foodBill" : "alcoholBill";
        const nextVal = kind === "food" ? ++foodNext : ++alcNext;
        const billNo = await commitCounter(client, counterName, nextVal);
        const gSubtotalPaise = group.reduce((s, l) => s + Number(l.lineTotalPaise), 0);
        const gTaxPaise = group.reduce((s, l) => s + Math.round((Number(l.lineTotalPaise) * Number(l.taxRatePct || 0)) / 100), 0);
        settledSubtotalPaise += gSubtotalPaise; settledTaxPaise += gTaxPaise;

        const billItems = kind === "food"
          ? group.map((l) => ({ itemName: l.name, price: l.unitPricePaise / 100, qty: l.qty, lineTotal: l.lineTotalPaise / 100 }))
          : group.map((l) => ({ itemName: l.name, brand: l.brand ?? "", bottleSize: l.bottleSize ?? "", price: l.unitPricePaise / 100, qty: l.qty, taxRate: l.taxRatePct, lineTotal: l.lineTotalPaise / 100 }));
        const billId = "bill_" + randomUUID();
        const row = buildBillRow({
          billNo, type: kind === "food" ? "FOOD" : "ALCOHOL", source: "website", websiteOrderId: id, websiteOrderNo: order.ref,
          depositPaidPaise: Number(order.paid_paise) || 0, customerName: order.customer?.name || "Website customer", customerPhone: order.customer?.phone || "-",
          subtotal: gSubtotalPaise / 100, discount: 0, tax: gTaxPaise / 100, grandTotal: (gSubtotalPaise + gTaxPaise) / 100,
          paymentMethod, createdByUid: caller.uid, createdAt, items: billItems as never,
        });
        await insertBill(client, billId, row);
        billIds.push(billId); billNos.push(billNo);
        bills.push({ type: kind === "food" ? "FOOD" : "ALCOHOL", id: billId, bill_no: billNo });
      }

      await applyStockWrites(client, stockSnaps, lines.map((l) => ({ itemId: l.itemId, delta: -l.qty })));

      const totalPaise = settledSubtotalPaise + settledTaxPaise;
      const prevBalancePaise = Math.max(0, totalPaise - (Number(order.paid_paise) || 0));
      const payments = [...(order.payments || []), { kind: "balance", amountPaise: prevBalancePaise, at: createdAt.toISOString() }];
      await client.query(
        `UPDATE website_orders SET status='COMPLETED', paid_paise=$2, balance_paise=0, settled_bill_ids=$3, settled_bill_nos=$4,
           settled_at=$5, payments=$6, updated_at=$5, date_key=$7 WHERE id=$1`,
        [id, totalPaise, billIds, billNos, createdAt, JSON.stringify(payments), order.date_key || dateKey(createdAt, RESTAURANT_TZ)],
      );
      await auditInTx(client, { actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action: "website.settle", entityType: "website_order", entityId: id, details: { ref: order.ref, grand_total_paise: totalPaise, bill_ids: billIds, balance_collected_paise: prevBalancePaise } });

      return { order_id: id, ref: order.ref, bills, grand_total_paise: totalPaise, balance_collected_paise: prevBalancePaise };
    });
    computeRolling().catch((e) => console.error("stats refresh failed (non-fatal)", e));
    await broadcast("website_orders", { type: "order.settled", id }).catch((e) => console.error("broadcast failed (non-fatal)", e));
    return out;
  },
});
