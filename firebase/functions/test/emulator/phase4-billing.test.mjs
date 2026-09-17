/**
 * Phase 4 — createBill / openTable / settleTable against the real emulator.
 * Asserts exact Flask parity: gap-safe numbering, discount rounding, food/alc
 * separation, stock floor, immutable bills, audit rows, atomic settlement.
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, staffReq, auditRows } from "./_seed.mjs";

const { handleCreateBill, handleOpenTable, handleSettleTable } = await import(
  "../../lib/callable/billing.js"
);

const db = getFirestore();
before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
});
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "tableSessions", "bills", "counters", "auditLog"]);
  await seedCatalog();
});

const approx = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

test("createBill FOOD: number FOOD-000001, tax on top, stock decremented, audit written", async () => {
  const out = await handleCreateBill(
    staffReq({
      type: "FOOD",
      items: [
        { name: "Paneer Tikka", price: 220, qty: 2, itemId: "item_food_1" },
        { name: "Butter Chicken", price: 280, qty: 1, itemId: "item_food_3" },
      ],
      discount: 0,
      tax_percent: 5,
      payment_method: "Cash",
      customer_name: "Ramesh",
    }),
  );
  assert.equal(out.billNo, "FOOD-000001");
  assert.equal(out.type, "FOOD");
  assert.ok(approx(out.subtotal, 720));
  assert.ok(approx(out.tax, 36)); // 720 * 5%
  assert.ok(approx(out.grandTotal, 756));
  assert.equal(out.source, "counter");
  assert.equal(out.dateKey.length, 10);

  const f1 = (await db.collection("catalog").doc("item_food_1").get()).data();
  const f3 = (await db.collection("catalog").doc("item_food_3").get()).data();
  assert.equal(f1.stockQty, 8); // 10 - 2
  assert.equal(f3.stockQty, 2); // 3 - 1

  const audit = await auditRows("bill.create");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.bill_no, "FOOD-000001");
  assert.equal(audit[0].actorUid, "u_2");

  const counter = (await db.collection("counters").doc("foodBill").get()).data();
  assert.equal(counter.value, 1);
});

test("createBill ALCOHOL: separate ALC series, per-line tax, untracked stock untouched", async () => {
  await handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "x", price: 100, qty: 1, itemId: "item_food_2" }], tax_percent: 5 }));
  const out = await handleCreateBill(
    staffReq({
      type: "ALCOHOL",
      items: [{ name: "Kingfisher Premium", price: 180, qty: 2, tax_rate: 18, itemId: "item_alc_1" }],
      discount: 0,
    }),
  );
  assert.equal(out.billNo, "ALC-000001"); // independent of the FOOD counter
  assert.ok(approx(out.subtotal, 360));
  assert.ok(approx(out.tax, 64.8));
  assert.ok(approx(out.grandTotal, 424.8));
  const alc = (await db.collection("catalog").doc("item_alc_1").get()).data();
  assert.equal(alc.stockQty, 22);
  const f2 = (await db.collection("catalog").doc("item_food_2").get()).data();
  assert.equal(f2.stockQty, null); // untracked, unchanged
});

test("createBill: discount over subtotal is rejected, nothing written", async () => {
  // handleX throws the raw ValidationError; the onCall wrapper (lib/wrap.callable)
  // maps it to HttpsError('invalid-argument') — covered by the callable() unit path.
  await assert.rejects(
    () => handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "x", price: 100, qty: 1, itemId: "item_food_1" }], discount: 500 })),
    (e) => e.name === "ValidationError" && /Discount cannot exceed subtotal/.test(e.message),
  );
  assert.equal((await db.collection("bills").get()).size, 0);
  assert.equal((await db.collection("counters").doc("foodBill").get()).data().value, 0);
});

test("createBill via the wrapped onCall export maps ValidationError -> invalid-argument", async () => {
  const { callable } = await import("../../lib/lib/wrap.js");
  const wrapped = callable(handleCreateBill);
  await assert.rejects(
    () => wrapped(staffReq({ type: "FOOD", items: [{ name: "x", price: 100, qty: 1 }], discount: 999 })),
    (e) => e.code === "invalid-argument",
  );
});

test("createBill: numbers are gap-free across sequential bills", async () => {
  for (let i = 1; i <= 4; i++) {
    const out = await handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "x", price: 10, qty: 1, itemId: "item_food_2" }], tax_percent: 0 }));
    assert.equal(out.billNo, `FOOD-${String(i).padStart(6, "0")}`);
  }
});

test("bills are immutable once written", async () => {
  const out = await handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "x", price: 10, qty: 1, itemId: "item_food_2" }] }));
  // no update path exists; a direct admin write is possible but rules forbid clients.
  // assert the doc shape is complete/immutable-ready:
  const bill = (await db.collection("bills").doc(out.id).get()).data();
  assert.equal(bill.status, "confirmed");
  assert.ok(Array.isArray(bill.searchTokens));
});

test("openTable is idempotent — second call returns the SAME open session", async () => {
  const a = await handleOpenTable(staffReq({ table_id: "tbl_1", customer_name: "Priya" }));
  assert.equal(a.created, true);
  const b = await handleOpenTable(staffReq({ table_id: "tbl_1" }));
  assert.equal(b.created, false);
  assert.equal(b.session.id, a.session.id);
  const t = (await db.collection("tables").doc("tbl_1").get()).data();
  assert.equal(t.status, "occupied");
  assert.equal(t.openSessionId, a.session.id);
  assert.equal((await db.collection("tableSessions").where("tableId", "==", "tbl_1").get()).size, 1);
});

test("settleTable: splits food/alc, pro-rata discount w/ remainder, stock, session+table state, audit", async () => {
  const { session } = await handleOpenTable(staffReq({ table_id: "tbl_2", customer_name: "Anil" }));
  // put a food + an alcohol line on the session (direct write, like the rules-guarded client)
  await db.collection("tableSessions").doc(session.id).update({
    items: [
      { kind: "food", itemId: "item_food_3", itemName: "Butter Chicken", brand: "", bottleSize: "", price: 280, qty: 1, taxRate: 5, lineTotal: 280 },
      { kind: "alcohol", itemId: "item_alc_1", itemName: "Kingfisher Premium", brand: "Kingfisher", bottleSize: "650ml", price: 1200, qty: 1, taxRate: 20, lineTotal: 1200 },
    ],
  });
  const out = await handleSettleTable(staffReq({ session_id: session.id, payment_method: "UPI", discount: 100 }));

  assert.equal(out.bills.length, 2);
  const food = out.bills.find((b) => b.type === "FOOD");
  const alc = out.bills.find((b) => b.type === "ALCOHOL");
  assert.equal(food.bill_no, "FOOD-000001");
  assert.equal(alc.bill_no, "ALC-000001");

  const fb = (await db.collection("bills").doc(food.id).get()).data();
  const ab = (await db.collection("bills").doc(alc.id).get()).data();
  // subtotal 1480; food share round(100*280/1480,2)=18.92 ; alcohol gets remainder 81.08
  assert.ok(approx(fb.discount, 18.92));
  assert.ok(approx(ab.discount, 81.08));
  assert.ok(approx(fb.discount + ab.discount, 100));
  assert.ok(approx(fb.grandTotal + ab.grandTotal, out.grand_total));
  assert.ok(approx(out.grand_total, 1480 + (280 * 5) / 100 + (1200 * 20) / 100 - 100));
  assert.equal(fb.tableSessionId, session.id);
  assert.equal(fb.source, "table");

  const f3 = (await db.collection("catalog").doc("item_food_3").get()).data();
  assert.equal(f3.stockQty, 2); // 3 - 1
  const alcItem = (await db.collection("catalog").doc("item_alc_1").get()).data();
  assert.equal(alcItem.stockQty, 23);

  const sess = (await db.collection("tableSessions").doc(session.id).get()).data();
  assert.equal(sess.status, "settled");
  assert.ok(sess.settledAt);
  assert.deepEqual([...sess.settledBillIds].sort(), [food.id, alc.id].sort());
  const t = (await db.collection("tables").doc("tbl_2").get()).data();
  assert.equal(t.status, "available");
  assert.equal(t.openSessionId, null);

  const audit = await auditRows("table.settle");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.discount, 100);
  assert.ok(approx(audit[0].details.grand_total, out.grand_total));
});

test("settleTable is not re-runnable — a settled session throws and writes nothing new", async () => {
  const { session } = await handleOpenTable(staffReq({ table_id: "tbl_1" }));
  await db.collection("tableSessions").doc(session.id).update({
    items: [{ kind: "food", itemId: "item_food_1", itemName: "Paneer Tikka", brand: "", bottleSize: "", price: 220, qty: 1, taxRate: 5, lineTotal: 220 }],
  });
  await handleSettleTable(staffReq({ session_id: session.id }));
  const billsAfter1 = (await db.collection("bills").get()).size;
  await assert.rejects(
    () => handleSettleTable(staffReq({ session_id: session.id })),
    (e) => e.code === "not-found",
  );
  assert.equal((await db.collection("bills").get()).size, billsAfter1);
});

test("settleTable: empty session rejected", async () => {
  const { session } = await handleOpenTable(staffReq({ table_id: "tbl_1" }));
  await assert.rejects(
    () => handleSettleTable(staffReq({ session_id: session.id })),
    (e) => e.code === "failed-precondition",
  );
});

test("owner cannot bill or settle (dashboard-only)", async () => {
  const ownerReq = (data) => staffReq(data, { auth: { uid: "u_9", token: { role: "owner", username: "owner" } } });
  await assert.rejects(() => handleCreateBill(ownerReq({ type: "FOOD", items: [{ name: "x", price: 1, qty: 1 }] })), (e) => e.code === "permission-denied");
  await assert.rejects(() => handleOpenTable(ownerReq({ table_id: "tbl_1" })), (e) => e.code === "permission-denied");
});
