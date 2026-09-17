/**
 * Billing — replaces Flask POST /api/food/bills, POST /api/alcohol/bills,
 * POST /api/tables/<id>/open, POST /api/table-sessions/<id>/settle.
 *
 * Every mutation runs in ONE Firestore transaction so it is all-or-nothing
 * (invariant I1). Numbers come from counters/{name} (gap-safe, I2). Stock is
 * decremented with the CASE/floor rule (I3). Food and alcohol always become
 * separate bill documents with separate number series (I4). The table-settle
 * discount is split pro-rata with the remainder on the last group (I5), via
 * lib/money.ts — a line-for-line port of backend/app.py.
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { REGION } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { assertRole } from "../lib/authz";
import { callable } from "../lib/wrap";
import { computeFoodBill, computeAlcoholBill, splitSettlement, SessionLine } from "../lib/money";
import { peekCounter, commitCounter, CounterName } from "../lib/counters";
import { readStockSnapshots, applyStockWrites } from "../lib/stock";
import { buildBillDoc } from "../lib/billDoc";
import { auditInTx } from "../lib/audit";

const OPERATIONAL = ["billing", "manager", "admin"] as const;

// ---------------------------------------------------------------- createBill

export interface CreateBillInput {
  type?: unknown;
  items?: unknown;
  discount?: unknown;
  tax_percent?: unknown;
  payment_method?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  table_id?: unknown;
  table_session_id?: unknown;
}

export async function handleCreateBill(req: CallableRequest<CreateBillInput>) {
  const db = getDb();

  const type = String(req.data?.type ?? "").toUpperCase();
  if (type !== "FOOD" && type !== "ALCOHOL" && type !== "CAFE") {
    throw new HttpsError("invalid-argument", "type must be FOOD, ALCOHOL or CAFE");
  }
  // CAFE bills belong to the `cafe_billing` role (and managers/admins); the
  // `billing` cashier may also raise one. FOOD/ALCOHOL stay billing/manager/admin.
  const caller = assertRole(req, type === "CAFE" ? ["cafe_billing", "billing", "manager", "admin"] : [...OPERATIONAL]);
  const rawItems = Array.isArray(req.data?.items) ? (req.data!.items as unknown[]) : [];
  // CAFE (outside-cafe menu: tea/coffee/ice cream/bottled drinks) has no tax and
  // no brand/bottle — same math as FOOD, its own CAFE-xxxxx number series.
  const isAlc = type === "ALCOHOL";
  const computed = isAlc
    ? computeAlcoholBill(rawItems as never, req.data?.discount)
    : computeFoodBill(rawItems as never, req.data?.discount, type === "CAFE" ? 0 : req.data?.tax_percent);

  const paymentMethod = String(req.data?.payment_method ?? "Cash") || "Cash";
  const customerName = String(req.data?.customer_name ?? "-").trim() || "-";
  const customerPhone = String(req.data?.customer_phone ?? "-").trim() || "-";
  const tableId = req.data?.table_id ? String(req.data.table_id) : null;
  const tableSessionId = req.data?.table_session_id ? String(req.data.table_session_id) : null;
  const counterName: CounterName = type === "FOOD" ? "foodBill" : type === "CAFE" ? "cafeBill" : "alcoholBill";

  const billItems = !isAlc
    ? computed.items.map((l: any) => ({
        itemName: l.itemName,
        price: l.price,
        qty: l.qty,
        lineTotal: l.lineTotal,
      }))
    : computed.items.map((l: any) => ({
          itemName: l.itemName,
          brand: l.brand,
          bottleSize: l.bottleSize,
          price: l.price,
          qty: l.qty,
          taxRate: l.taxRate,
          lineTotal: l.lineTotal,
        }));

  const billRef = db.collection("bills").doc();
  const createdAt = new Date();

  await db.runTransaction(async (tx) => {
    const stockSnaps = await readStockSnapshots(
      tx,
      db,
      computed.items.map((l: any) => l.itemId),
    );
    const current = await peekCounter(tx, db, counterName);

    const billNo = commitCounter(tx, db, counterName, current + 1);
    tx.set(
      billRef,
      buildBillDoc({
        billNo,
        type: type as "FOOD" | "ALCOHOL" | "CAFE",
        source: type === "CAFE" ? "cafe" : undefined,
        tableId,
        tableSessionId,
        customerName,
        customerPhone,
        subtotal: computed.subtotal,
        discount: computed.discount,
        tax: computed.tax,
        grandTotal: computed.grandTotal,
        paymentMethod,
        createdByUid: caller.uid,
        createdAt,
        items: billItems as never,
      }),
    );
    applyStockWrites(
      tx,
      stockSnaps,
      computed.items.map((l: any) => ({ itemId: l.itemId, delta: -l.qty })),
    );
    auditInTx(tx, db, {
      actorUid: caller.uid,
      actorUsername: caller.username || null,
      actorRole: caller.role,
      action: "bill.create",
      entityType: type === "FOOD" ? "food_bill" : type === "CAFE" ? "cafe_bill" : "alcohol_bill",
      entityId: billRef.id,
      details: { bill_no: billNo, grand_total: computed.grandTotal },
    });
  });

  const saved = await billRef.get();
  return { id: billRef.id, type, ...saved.data() };
}

// ---------------------------------------------------------------- openTable

export interface OpenTableInput {
  table_id?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
}

export async function handleOpenTable(req: CallableRequest<OpenTableInput>) {
  const caller = assertRole(req, [...OPERATIONAL]);
  const db = getDb();
  const tableId = String(req.data?.table_id ?? "");
  if (!tableId) throw new HttpsError("invalid-argument", "table_id is required");
  const customerName = String(req.data?.customer_name ?? "Walk-in").trim() || "Walk-in";
  const customerPhone = String(req.data?.customer_phone ?? "-").trim() || "-";

  let session: Record<string, unknown> | null = null;
  let created = false;

  await db.runTransaction(async (tx) => {
    const tableRef = db.collection("tables").doc(tableId);
    const tableSnap = await tx.get(tableRef);
    if (!tableSnap.exists) throw new HttpsError("not-found", "Table not found");

    const openSnap = await tx.get(
      db
        .collection("tableSessions")
        .where("tableId", "==", tableId)
        .where("status", "==", "open")
        .limit(1),
    );
    if (!openSnap.empty) {
      session = { id: openSnap.docs[0].id, ...openSnap.docs[0].data() };
      return;
    }

    const sRef = db.collection("tableSessions").doc();
    const data = {
      tableId,
      tableNo: tableSnap.data()?.tableNo ?? "",
      customerName,
      customerPhone,
      status: "open" as const,
      openedAt: new Date(),
      openedByUid: caller.uid,
      settledAt: null,
      items: [] as unknown[],
      subtotal: 0,
      tax: 0,
      grandTotal: 0,
      settledBillIds: [] as string[],
    };
    tx.set(sRef, data);
    tx.update(tableRef, { status: "occupied", openSessionId: sRef.id, updatedAt: new Date() });
    session = { id: sRef.id, ...data };
    created = true;
  });

  return { session, created };
}

// ---------------------------------------------------------------- settleTable

export interface SettleTableInput {
  session_id?: unknown;
  payment_method?: unknown;
  discount?: unknown;
}

const toSessionLine = (i: any): SessionLine => ({
  itemKind: i.kind === "alcohol" ? "alcohol" : "food",
  itemId: i.itemId ?? null,
  itemName: i.itemName ?? "",
  brand: i.brand ?? "",
  bottleSize: i.bottleSize ?? "",
  price: Number(i.price) || 0,
  qty: Number(i.qty) || 0,
  taxRate: Number(i.taxRate) || 0,
  lineTotal: Number(i.lineTotal) || 0,
});

export async function handleSettleTable(req: CallableRequest<SettleTableInput>) {
  const caller = assertRole(req, [...OPERATIONAL]);
  const db = getDb();
  const sessionId = String(req.data?.session_id ?? "");
  if (!sessionId) throw new HttpsError("invalid-argument", "session_id is required");
  const paymentMethod = String(req.data?.payment_method ?? "Cash").trim() || "Cash";

  const result = {
    table_no: "",
    session_id: sessionId,
    bills: [] as Array<{ type: string; id: string; bill_no: string }>,
    subtotal: 0,
    tax: 0,
    discount: 0,
    grand_total: 0,
    payment_method: paymentMethod,
  };

  await db.runTransaction(async (tx) => {
    const sessRef = db.collection("tableSessions").doc(sessionId);
    const sessSnap = await tx.get(sessRef);
    if (!sessSnap.exists || sessSnap.data()?.status !== "open") {
      throw new HttpsError("not-found", "Open table session not found");
    }
    const sess = sessSnap.data()!;
    const rawItems: any[] = Array.isArray(sess.items) ? sess.items : [];
    if (rawItems.length === 0) {
      throw new HttpsError("failed-precondition", "Add at least one item before settling the table");
    }
    const lines = rawItems.map(toSessionLine);
    const settlement = splitSettlement(lines, req.data?.discount); // throws ValidationError -> wrapper

    const stockSnaps = await readStockSnapshots(
      tx,
      db,
      lines.map((l) => l.itemId),
    );
    let foodNext = settlement.groups.some((g) => g.kind === "food")
      ? await peekCounter(tx, db, "foodBill")
      : 0;
    let alcNext = settlement.groups.some((g) => g.kind === "alcohol")
      ? await peekCounter(tx, db, "alcoholBill")
      : 0;

    const createdAt = new Date();
    const billIds: string[] = [];
    for (const g of settlement.groups) {
      const counterName: CounterName = g.kind === "food" ? "foodBill" : "alcoholBill";
      const nextVal = g.kind === "food" ? ++foodNext : ++alcNext;
      const billNo = commitCounter(tx, db, counterName, nextVal);
      const billRef = db.collection("bills").doc();
      const billItems =
        g.kind === "food"
          ? g.items.map((l) => ({
              itemName: l.itemName,
              price: l.price,
              qty: l.qty,
              lineTotal: l.lineTotal,
            }))
          : g.items.map((l) => ({
              itemName: l.itemName,
              brand: l.brand,
              bottleSize: l.bottleSize,
              price: l.price,
              qty: l.qty,
              taxRate: l.taxRate,
              lineTotal: l.lineTotal,
            }));
      tx.set(
        billRef,
        buildBillDoc({
          billNo,
          type: g.kind === "food" ? "FOOD" : "ALCOHOL",
          tableId: sess.tableId,
          tableSessionId: sessionId,
          customerName: sess.customerName,
          customerPhone: sess.customerPhone,
          subtotal: g.subtotal,
          discount: g.discount,
          tax: g.tax,
          grandTotal: g.total,
          paymentMethod,
          createdByUid: caller.uid,
          createdAt,
          items: billItems as never,
        }),
      );
      billIds.push(billRef.id);
      result.bills.push({
        type: g.kind === "food" ? "FOOD" : "ALCOHOL",
        id: billRef.id,
        bill_no: billNo,
      });
    }

    applyStockWrites(
      tx,
      stockSnaps,
      lines.map((l) => ({ itemId: l.itemId, delta: -l.qty })),
    );
    tx.update(sessRef, { status: "settled", settledAt: createdAt, settledBillIds: billIds });
    tx.update(db.collection("tables").doc(sess.tableId), {
      status: "available",
      openSessionId: null,
      updatedAt: createdAt,
    });
    auditInTx(tx, db, {
      actorUid: caller.uid,
      actorUsername: caller.username || null,
      actorRole: caller.role,
      action: "table.settle",
      entityType: "table_session",
      entityId: sessionId,
      details: {
        table_no: sess.tableNo,
        grand_total: settlement.grandTotal,
        discount: settlement.discount,
      },
    });

    result.table_no = sess.tableNo;
    result.subtotal = settlement.subtotal;
    result.tax = settlement.tax;
    result.discount = settlement.discount;
    result.grand_total = settlement.grandTotal;
  });

  return result;
}

// ------------------------------------------------------------------- exports

export const createBill = onCall({ region: REGION }, callable(handleCreateBill));
export const openTable = onCall({ region: REGION }, callable(handleOpenTable));
export const settleTable = onCall({ region: REGION }, callable(handleSettleTable));
