/**
 * Phase 4 — catalog + category + table callables. Flask parity: dup-name 409,
 * "category with active items" delete guard, menu.item.create / price_change /
 * delete audit rows, partial item update, admin/manager gating.
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, managerReq, staffReq, auditRows } from "./_seed.mjs";

const cat = await import("../../lib/callable/catalogAdmin.js");
const tbl = await import("../../lib/callable/tablesAdmin.js");
const db = getFirestore();

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "counters", "auditLog"]);
  await seedCatalog();
});

test("upsertCategory create: dup name rejected, sortOrder = max+1", async () => {
  await assert.rejects(
    () => cat.handleUpsertCategory(managerReq({ kind: "food", name: "Starters" })),
    (e) => e.code === "already-exists",
  );
  const out = await cat.handleUpsertCategory(managerReq({ kind: "food", name: "Desserts" }));
  assert.equal(out.sortOrder, 2); // Starters=0, Mains=1
  assert.equal(out.status, "active");
});

test("upsertCategory update renames + re-denormalizes catalog.categoryName", async () => {
  await cat.handleUpsertCategory(managerReq({ kind: "food", id: "cat_food_1", name: "Small Plates" }));
  const item = (await db.collection("catalog").doc("item_food_1").get()).data();
  assert.equal(item.categoryName, "Small Plates");
});

test("deleteCategory refuses while active items remain, then succeeds", async () => {
  await assert.rejects(
    () => cat.handleDeleteCategory(managerReq({ id: "cat_food_1" })),
    (e) => e.code === "failed-precondition",
  );
  // soft-delete the two starters
  await cat.handleDeleteCatalogItem(managerReq({ id: "item_food_1" }));
  await cat.handleDeleteCatalogItem(managerReq({ id: "item_food_2" }));
  const out = await cat.handleDeleteCategory(managerReq({ id: "cat_food_1" }));
  assert.equal(out.message, "Category deleted");
  assert.equal((await db.collection("categories").doc("cat_food_1").get()).data().status, "inactive");
});

test("upsertCatalogItem create writes menu.item.create audit", async () => {
  const out = await cat.handleUpsertCatalogItem(
    managerReq({ kind: "food", name: "Spring Roll", category_id: "cat_food_1", price: 150, stock_qty: 20 }),
  );
  assert.equal(out.price, 150);
  assert.equal(out.stockQty, 20);
  assert.equal(out.taxRate, 0);
  assert.equal(out.categoryName, "Starters");
  const audit = await auditRows("menu.item.create");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.name, "Spring Roll");
});

test("upsertCatalogItem update: price change is audited, other partial edits are not", async () => {
  await cat.handleUpsertCatalogItem(managerReq({ kind: "food", id: "item_food_3", stock_qty: 99 }));
  assert.equal((await auditRows("menu.item.price_change")).length, 0); // stock-only change

  const out = await cat.handleUpsertCatalogItem(managerReq({ kind: "food", id: "item_food_3", price: 300 }));
  assert.equal(out.price, 300);
  assert.equal(out.name, "Butter Chicken"); // untouched partial field
  const pc = await auditRows("menu.item.price_change");
  assert.equal(pc.length, 1);
  assert.deepEqual(pc[0].details.price, { from: 280, to: 300 });
});

test("upsertCatalogItem alcohol keeps brand/bottleSize/taxRate", async () => {
  const out = await cat.handleUpsertCatalogItem(
    managerReq({ kind: "alcohol", name: "Corona", category_id: "cat_alc_1", price: 250, tax_rate: 18, brand: "Corona", bottle_size: "330ml" }),
  );
  assert.equal(out.brand, "Corona");
  assert.equal(out.bottleSize, "330ml");
  assert.equal(out.taxRate, 18);
  assert.equal(out.description, null);
});

test("deleteCatalogItem soft-deletes + audits menu.item.delete", async () => {
  await cat.handleDeleteCatalogItem(managerReq({ id: "item_food_1" }));
  assert.equal((await db.collection("catalog").doc("item_food_1").get()).data().status, "inactive");
  assert.equal((await auditRows("menu.item.delete")).length, 1);
});

test("catalog writes are manager-only (staff rejected)", async () => {
  await assert.rejects(
    () => cat.handleUpsertCatalogItem(staffReq({ kind: "food", name: "x", category_id: "cat_food_1", price: 1 })),
    (e) => e.code === "permission-denied",
  );
});

test("createTable: unique name, auto qrToken; regenerateQrToken audits qr.regenerate", async () => {
  const t = await tbl.handleCreateTable(managerReq({ table_no: "Table 09", seats: 6 }));
  assert.equal(t.tableNo, "Table 09");
  assert.equal(t.seats, 6);
  assert.ok(t.qrToken && t.qrToken.length >= 12);
  await assert.rejects(
    () => tbl.handleCreateTable(managerReq({ table_no: "Table 09" })),
    (e) => e.code === "already-exists",
  );
  const before = t.qrToken;
  const r = await tbl.handleRegenerateQrToken(managerReq({ id: t.id }));
  assert.notEqual(r.qr_token, before);
  const audit = await auditRows("qr.regenerate");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.table_no, "Table 09");
});
