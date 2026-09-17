/**
 * POS-side Website Orders workflow (staff/manager/admin):
 *   setWebsiteOrderStatus   CONFIRMED -> PREPARING -> READY, or CANCEL
 *   addItemsToWebsiteOrder   append items at CURRENT catalog prices, recompute
 *                            totals + balance (integer paise, server-side only)
 *   settleWebsiteOrder       reuse the POS billing/stock/bill-number/immutable-
 *                            bill machinery; the bill keeps `ref` (WEB-000123)
 *
 * paymentStatus and status are separate state machines. Settlement is guarded
 * against duplicates. Nothing here trusts a client amount.
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { REGION, WEBSITE_ORDER_STATUSES, legalWebsiteOrderTransition, RESTAURANT_TZ } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { assertRole } from "../lib/authz";
import { callable } from "../lib/wrap";
import { priceCartPaise, PaiseLine } from "../lib/pricing";
import { peekCounter, commitCounter, CounterName } from "../lib/counters";
import { readStockSnapshots, applyStockWrites } from "../lib/stock";
import { buildBillDoc } from "../lib/billDoc";
import { auditInTx } from "../lib/audit";
import { dateKey } from "../lib/money";

const OPERATIONAL = ["billing", "manager", "admin"] as const;
const MODIFIABLE = ["CONFIRMED", "PREPARING", "READY"];

/** POS-board row (₹ shown in the UI; paise are the source of truth). */
const orderRow = (id: string, d: any) => ({
  id,
  ref: d.ref,
  status: d.status,
  payment_status: d.paymentStatus,
  customer: d.customer || {},
  fulfillment: {
    type: d.fulfillment?.type || "pickup",
    pickup_at: d.fulfillment?.pickupAt?.toDate?.() ?? d.fulfillment?.pickupAt ?? null,
    notes: d.fulfillment?.notes ?? "",
  },
  items: (d.items || []).map((it: any) => ({
    item_id: it.itemId,
    item_name: it.name,
    kind: it.kind,
    brand: it.brand ?? "",
    bottle_size: it.bottleSize ?? "",
    unit_price_paise: it.unitPricePaise,
    qty: it.qty,
    tax_rate: it.taxRatePct ?? 0,
    line_total_paise: it.lineTotalPaise,
  })),
  subtotal_paise: d.subtotalPaise,
  tax_paise: d.taxPaise,
  total_paise: d.totalPaise,
  advance_paise: d.advancePaise,
  balance_paise: d.balancePaise,
  paid_paise: d.paidPaise || 0,
  settled_bill_ids: d.settledBillIds || [],
  settled_bill_nos: d.settledBillNos || [],
  bill_status: (d.settledBillNos || []).length ? "billed" : "unbilled",
  created_at: d.createdAt?.toDate?.() ?? d.createdAt ?? null,
  confirmed_at: d.confirmedAt?.toDate?.() ?? d.confirmedAt ?? null,
});

function recomputePaise(items: any[]): { subtotalPaise: number; taxPaise: number; totalPaise: number } {
  const subtotalPaise = items.reduce((s, i) => s + Number(i.lineTotalPaise), 0);
  const taxPaise = items.reduce(
    (s, i) => s + Math.round((Number(i.lineTotalPaise) * Number(i.taxRatePct || 0)) / 100),
    0,
  );
  return { subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

// ------------------------------------------------------- setWebsiteOrderStatus

export interface SetStatusInput {
  order_id?: unknown;
  status?: unknown;
}

export async function handleSetWebsiteOrderStatus(req: CallableRequest<SetStatusInput>) {
  assertRole(req, [...OPERATIONAL]);
  const db = getDb();
  const id = String(req.data?.order_id ?? "");
  const to = String(req.data?.status ?? "").toUpperCase();
  if (!id) throw new HttpsError("invalid-argument", "order_id is required");
  if (!(WEBSITE_ORDER_STATUSES as readonly string[]).includes(to)) {
    throw new HttpsError("invalid-argument", "Unknown status");
  }
  if (["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "PAYMENT_FAILED"].includes(to)) {
    throw new HttpsError(
      "failed-precondition",
      to === "COMPLETED" ? "Use Settle Bill to complete a website order" : `${to} is set by the payment flow`,
    );
  }
  const ref = db.collection("websiteOrders").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Order not found");
  const from = String(snap.data()?.status ?? "");
  if (from === to) return orderRow(ref.id, snap.data());
  if (!legalWebsiteOrderTransition(from, to)) {
    throw new HttpsError("failed-precondition", `Cannot move an order from ${from} to ${to}`);
  }
  await ref.set({ status: to, updatedAt: new Date() }, { merge: true });
  return orderRow(ref.id, (await ref.get()).data());
}

// ------------------------------------------------------- addItemsToWebsiteOrder

export interface AddItemsInput {
  order_id?: unknown;
  items?: unknown;
}

export async function handleAddItemsToWebsiteOrder(req: CallableRequest<AddItemsInput>) {
  const caller = assertRole(req, [...OPERATIONAL]);
  const db = getDb();
  const id = String(req.data?.order_id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "order_id is required");
  const ref = db.collection("websiteOrders").doc(id);
  let result: any = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found");
    const order = snap.data()!;
    if (!MODIFIABLE.includes(order.status)) {
      throw new HttpsError("failed-precondition", "This order can no longer be modified");
    }
    const priced = await priceCartPaise(
      (itemId) => tx.get(db.collection("catalog").doc(itemId)).then((s) => (s.exists ? (s.data() as any) : null)),
      req.data?.items,
      { requireInStock: false },
    );
    const merged = [...(order.items || []), ...priced.items];
    const { subtotalPaise, taxPaise, totalPaise } = recomputePaise(merged);
    const paidPaise = Number(order.paidPaise) || 0;
    const balancePaise = Math.max(0, totalPaise - paidPaise);

    tx.update(ref, { items: merged, subtotalPaise, taxPaise, totalPaise, balancePaise, updatedAt: new Date() });
    auditInTx(tx, db, {
      actorUid: caller.uid,
      actorUsername: caller.username || null,
      actorRole: caller.role,
      action: "website.order.additems",
      entityType: "website_order",
      entityId: ref.id,
      details: {
        ref: order.ref,
        added: priced.items.map((l: PaiseLine) => `${l.name} x${l.qty}`),
        total_paise: totalPaise,
        balance_paise: balancePaise,
      },
    });
    result = { ...order, items: merged, subtotalPaise, taxPaise, totalPaise, balancePaise };
  });

  return orderRow(ref.id, result);
}

// ---------------------------------------------------------- settleWebsiteOrder

export interface SettleInput {
  order_id?: unknown;
  payment_method?: unknown;
}

export async function handleSettleWebsiteOrder(req: CallableRequest<SettleInput>) {
  const caller = assertRole(req, [...OPERATIONAL]);
  const db = getDb();
  const id = String(req.data?.order_id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "order_id is required");
  const paymentMethod = String(req.data?.payment_method ?? "Cash").trim() || "Cash";

  const ref = db.collection("websiteOrders").doc(id);
  const out = {
    order_id: id,
    ref: "",
    bills: [] as Array<{ type: string; id: string; bill_no: string }>,
    grand_total_paise: 0,
    balance_collected_paise: 0,
  };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found");
    const order = snap.data()!;
    if (order.status === "COMPLETED" || (order.settledBillIds || []).length > 0) {
      throw new HttpsError("failed-precondition", "This website order is already settled");
    }
    if (["CANCELLED", "PAYMENT_FAILED", "PENDING_PAYMENT"].includes(order.status)) {
      throw new HttpsError("failed-precondition", `Cannot settle a ${order.status} order`);
    }
    const lines: any[] = Array.isArray(order.items) ? order.items : [];
    if (lines.length === 0) throw new HttpsError("failed-precondition", "This order has no items");

    const stockSnaps = await readStockSnapshots(tx, db, lines.map((l) => l.itemId));
    const foodLines = lines.filter((l) => l.kind !== "alcohol");
    const alcLines = lines.filter((l) => l.kind === "alcohol");
    const groups: Array<["food" | "alcohol", any[]]> = [];
    if (foodLines.length) groups.push(["food", foodLines]);
    if (alcLines.length) groups.push(["alcohol", alcLines]);

    let foodNext = groups.some((g) => g[0] === "food") ? await peekCounter(tx, db, "foodBill") : 0;
    let alcNext = groups.some((g) => g[0] === "alcohol") ? await peekCounter(tx, db, "alcoholBill") : 0;

    const createdAt = new Date();
    const billIds: string[] = [];
    const billNos: string[] = [];
    let settledSubtotalPaise = 0;
    let settledTaxPaise = 0;

    for (const [kind, group] of groups) {
      const counterName: CounterName = kind === "food" ? "foodBill" : "alcoholBill";
      const nextVal = kind === "food" ? ++foodNext : ++alcNext;
      const billNo = commitCounter(tx, db, counterName, nextVal);
      const gSubtotalPaise = group.reduce((s, l) => s + Number(l.lineTotalPaise), 0);
      const gTaxPaise = group.reduce(
        (s, l) => s + Math.round((Number(l.lineTotalPaise) * Number(l.taxRatePct || 0)) / 100),
        0,
      );
      settledSubtotalPaise += gSubtotalPaise;
      settledTaxPaise += gTaxPaise;

      const billItems =
        kind === "food"
          ? group.map((l) => ({
              itemName: l.name,
              price: l.unitPricePaise / 100,
              qty: l.qty,
              lineTotal: l.lineTotalPaise / 100,
            }))
          : group.map((l) => ({
              itemName: l.name,
              brand: l.brand ?? "",
              bottleSize: l.bottleSize ?? "",
              price: l.unitPricePaise / 100,
              qty: l.qty,
              taxRate: l.taxRatePct,
              lineTotal: l.lineTotalPaise / 100,
            }));
      const billRef = db.collection("bills").doc();
      const doc = buildBillDoc({
        billNo,
        type: kind === "food" ? "FOOD" : "ALCOHOL",
        source: "website",
        websiteOrderId: id,
        customerName: order.customer?.name || "Website customer",
        customerPhone: order.customer?.phone || "-",
        subtotal: gSubtotalPaise / 100,
        discount: 0,
        tax: gTaxPaise / 100,
        grandTotal: (gSubtotalPaise + gTaxPaise) / 100,
        paymentMethod,
        createdByUid: caller.uid,
        createdAt,
        items: billItems as never,
      });
      tx.set(billRef, {
        ...doc,
        websiteOrderNo: order.ref, // the WEB-000123 reference travels onto the bill
        depositPaidPaise: Number(order.paidPaise) || 0,
        searchTokens: [...doc.searchTokens, String(order.ref).toLowerCase()],
      });
      billIds.push(billRef.id);
      billNos.push(billNo);
      out.bills.push({ type: kind === "food" ? "FOOD" : "ALCOHOL", id: billRef.id, bill_no: billNo });
    }

    applyStockWrites(tx, stockSnaps, lines.map((l) => ({ itemId: l.itemId, delta: -l.qty })));

    const totalPaise = settledSubtotalPaise + settledTaxPaise;
    const prevBalancePaise = Math.max(0, totalPaise - (Number(order.paidPaise) || 0));
    tx.update(ref, {
      status: "COMPLETED",
      paidPaise: totalPaise,
      balancePaise: 0,
      settledBillIds: billIds,
      settledBillNos: billNos,
      settledAt: createdAt,
      payments: [...(order.payments || []), { kind: "balance", amountPaise: prevBalancePaise, at: createdAt }],
      updatedAt: createdAt,
      dateKey: order.dateKey || dateKey(createdAt, RESTAURANT_TZ),
    });
    auditInTx(tx, db, {
      actorUid: caller.uid,
      actorUsername: caller.username || null,
      actorRole: caller.role,
      action: "website.settle",
      entityType: "website_order",
      entityId: id,
      details: { ref: order.ref, grand_total_paise: totalPaise, bill_ids: billIds, balance_collected_paise: prevBalancePaise },
    });

    out.ref = order.ref;
    out.grand_total_paise = totalPaise;
    out.balance_collected_paise = prevBalancePaise;
  });

  return out;
}

// --------------------------------------------------------------------- exports

export const setWebsiteOrderStatus = onCall({ region: REGION }, callable(handleSetWebsiteOrderStatus));
export const addItemsToWebsiteOrder = onCall({ region: REGION }, callable(handleAddItemsToWebsiteOrder));
export const settleWebsiteOrder = onCall({ region: REGION }, callable(handleSettleWebsiteOrder));
