/**
 * Phase 7 — Outside-cafe billing (tea / coffee / ice cream / bottled drinks).
 *   kind:"cafe" catalog + a CAFE-xxxxx bill series, no tax, counter-only.
 *   Reuses the existing createBill machinery (gap-safe numbers, stock, immutable
 *   bills, audit) and flows into the dashboard rollups as its own line.
 *   The cafe channel never raises a kitchen ticket.
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, staffReq, cafeReq, kitchenReq, fnUrl, auditRows } from "./_seed.mjs";

const billing = await import("../../lib/callable/billing.js");
const catalog = await import("../../lib/callable/catalogAdmin.js");
const stats = await import("../../lib/triggers/stats.js");
const db = getFirestore();

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "bills", "kitchenTickets", "counters", "auditLog"]);
  const s = await db.collection("stats").doc("daily").collection("entries").get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
  await seedCatalog();
});

// ---------------------------------------------------------------- cafe bill

test("cafe bill: CAFE-000001, type CAFE, source cafe, no tax, stock decremented, audited", async () => {
  const before = (await db.collection("catalog").doc("item_cafe_1").get()).data().stockQty; // null (untracked)
  const beforeIce = (await db.collection("catalog").doc("item_cafe_2").get()).data().stockQty; // 12

  const bill = await billing.handleCreateBill(cafeReq({
    type: "CAFE",
    items: [
      { name: "Filter Coffee", price: 40, qty: 2, itemId: "item_cafe_1" },
      { name: "Vanilla Ice Cream", price: 60, qty: 1, itemId: "item_cafe_2" },
    ],
    customer_name: "Walk-in",
    payment_method: "Cash",
  }));

  assert.equal(bill.billNo, "CAFE-000001");
  assert.equal(bill.type, "CAFE");
  assert.equal(bill.source, "cafe");
  assert.equal(bill.tax, 0);
  assert.equal(bill.subtotal, 140);
  assert.equal(bill.grandTotal, 140);
  assert.equal(bill.status, "confirmed");

  assert.equal((await db.collection("catalog").doc("item_cafe_1").get()).data().stockQty, before); // untracked stays null
  assert.equal((await db.collection("catalog").doc("item_cafe_2").get()).data().stockQty, beforeIce - 1);
  assert.equal((await db.collection("counters").doc("cafeBill").get()).data().value, 1);

  const audit = await auditRows("bill.create");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entityType, "cafe_bill");

  // a cafe bill never spawns a kitchen ticket
  assert.equal((await db.collection("kitchenTickets").get()).size, 0);
});

test("cafe discount comes straight off the subtotal (no tax involved)", async () => {
  const bill = await billing.handleCreateBill(cafeReq({
    type: "CAFE",
    items: [{ name: "Filter Coffee", price: 40, qty: 5, itemId: "item_cafe_1" }],
    discount: 30,
  }));
  assert.equal(bill.subtotal, 200);
  assert.equal(bill.discount, 30);
  assert.equal(bill.grandTotal, 170);
});

test("CAFE / FOOD / ALCOHOL number series are independent", async () => {
  const c1 = await billing.handleCreateBill(cafeReq({ type: "CAFE", items: [{ name: "Filter Coffee", price: 40, qty: 1, itemId: "item_cafe_1" }] }));
  const f1 = await billing.handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "Paneer Tikka", price: 220, qty: 1, itemId: "item_food_1" }], tax_percent: 5 }));
  const c2 = await billing.handleCreateBill(cafeReq({ type: "CAFE", items: [{ name: "Vanilla Ice Cream", price: 60, qty: 1, itemId: "item_cafe_2" }] }));
  assert.equal(c1.billNo, "CAFE-000001");
  assert.equal(f1.billNo, "FOOD-000001");
  assert.equal(c2.billNo, "CAFE-000002");
});

test("cafe sales flow into the dashboard as their own line + into the totals", async () => {
  await billing.handleCreateBill(cafeReq({ type: "CAFE", items: [{ name: "Filter Coffee", price: 40, qty: 3, itemId: "item_cafe_1" }] })); // 120
  await billing.handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "Paneer Tikka", price: 220, qty: 1, itemId: "item_food_1" }], tax_percent: 0 })); // 220
  const rolling = await stats.rebuildAllStats();
  assert.equal(rolling.today.cafeBills, 1);
  assert.equal(rolling.today.cafeSales, 120);
  assert.equal(rolling.today.foodBills, 1);
  assert.equal(rolling.today.totalBills, 2);
  assert.equal(rolling.today.totalSales, 340);
  assert.equal(rolling.menuSummary.cafeItems, 2);
  assert.equal(rolling.menuSummary.cafeCategories, 7); // Tea/Coffee/Ice Creams/Water Bottles/Cool Drinks/Juices/Other
});

// ---------------------------------------------------------------- permissions

test("cafe role can bill CAFE but NOT food/alcohol; billing role can do all three", async () => {
  await assert.rejects(
    () => billing.handleCreateBill(cafeReq({ type: "FOOD", items: [{ name: "x", price: 1, qty: 1 }] })),
    (e) => e.code === "permission-denied",
  );
  await assert.rejects(
    () => billing.handleCreateBill(kitchenReq({ type: "CAFE", items: [{ name: "x", price: 1, qty: 1 }] })),
    (e) => e.code === "permission-denied",
  );
  const b = await billing.handleCreateBill(staffReq({ type: "CAFE", items: [{ name: "Filter Coffee", price: 40, qty: 1, itemId: "item_cafe_1" }] }));
  assert.equal(b.type, "CAFE");
});

// --------------------------------------------------------- cafe catalog admin

test("manager can add a cafe category + item; item audits as cafe_item", async () => {
  const cat = await catalog.handleUpsertCategory(staffReq({ kind: "cafe", name: "Cold Drinks" }, { auth: { uid: "u_1", token: { role: "manager", username: "boss" } } }));
  assert.equal(cat.kind, "cafe");
  const item = await catalog.handleUpsertCatalogItem(staffReq(
    { kind: "cafe", name: "Cola 500ml", category_id: cat.id, price: 40, stock_qty: 50 },
    { auth: { uid: "u_1", token: { role: "manager", username: "boss" } } },
  ));
  assert.equal(item.kind, "cafe");
  assert.equal(item.taxRate, 0);
  const audit = await auditRows("menu.item.create");
  assert.equal(audit[0].entityType, "cafe_item");
});
