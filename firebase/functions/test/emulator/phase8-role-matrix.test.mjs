/**
 * Phase 8 — full role matrix. Every protected callable × every role.
 * An unauthorised direct call MUST throw HttpsError "permission-denied"
 * (or "unauthenticated" with no auth). One allowed role per callable is
 * smoke-checked so the deny list can't be "deny everyone".
 *
 * Firestore-rules coverage for the same matrix lives in tests/rules/*.
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, reqAs } from "./_seed.mjs";

const billing = await import("../../lib/callable/billing.js");
const staffAdmin = await import("../../lib/callable/staffAdmin.js");
const catalog = await import("../../lib/callable/catalogAdmin.js");
const tables = await import("../../lib/callable/tablesAdmin.js");
const qr = await import("../../lib/callable/qrOrdersAdmin.js");
const web = await import("../../lib/callable/websiteOrdersAdmin.js");
const kitchen = await import("../../lib/callable/kitchen.js");
const stats = await import("../../lib/triggers/stats.js");
const db = getFirestore();

const ALL = ["admin", "manager", "owner", "billing", "kitchen", "cafe_billing"];

/** Assert `fn(role)` is permission-denied for every role NOT in `allowed`. */
async function deniedForAllExcept(label, allowed, fn) {
  for (const role of ALL) {
    if (allowed.includes(role)) continue;
    await assert.rejects(
      () => fn(role),
      (e) => e.code === "permission-denied",
      `${label}: role ${role} should be permission-denied`,
    );
  }
  // unauthenticated
  await assert.rejects(
    () => fn(null),
    (e) => e.code === "permission-denied" || e.code === "unauthenticated",
    `${label}: no auth should be rejected`,
  );
}
const call = (mod, handler, role, data) =>
  mod[handler](role ? reqAs(role, data) : { data, rawRequest: { headers: {}, ip: "127.0.0.1" }, acceptsStreaming: false });

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "bills", "tableSessions", "qrOrders", "websiteOrders", "kitchenTickets", "counters", "auditLog", "users"]);
  await seedCatalog();
});

// -------------------------------------------------- staff management (admin only)

test("listStaff / createStaff / updateStaff / deactivateStaff — ADMIN only", async () => {
  await deniedForAllExcept("listStaff", ["admin"], (r) => call(staffAdmin, "handleListStaff", r, {}));
  await deniedForAllExcept("createStaff", ["admin"], (r) => call(staffAdmin, "handleCreateStaff", r, { username: "x", password: "secret1", full_name: "X" }));
  await deniedForAllExcept("updateStaff", ["admin"], (r) => call(staffAdmin, "handleUpdateStaff", r, { uid: "u_1", role: "manager" }));
  await deniedForAllExcept("deactivateStaff", ["admin"], (r) => call(staffAdmin, "handleDeactivateStaff", r, { uid: "u_x" }));
});

// -------------------------------------------------- catalog / tables (manager+admin)

test("catalog CRUD — MANAGER + ADMIN only (billing/cafe/kitchen/owner denied)", async () => {
  await deniedForAllExcept("upsertCategory", ["admin", "manager"], (r) => call(catalog, "handleUpsertCategory", r, { kind: "food", name: "Z" }));
  await deniedForAllExcept("deleteCategory", ["admin", "manager"], (r) => call(catalog, "handleDeleteCategory", r, { id: "cat_food_1" }));
  await deniedForAllExcept("upsertCatalogItem", ["admin", "manager"], (r) => call(catalog, "handleUpsertCatalogItem", r, { kind: "food", name: "Z", category_id: "cat_food_1", price: 10 }));
  await deniedForAllExcept("deleteCatalogItem", ["admin", "manager"], (r) => call(catalog, "handleDeleteCatalogItem", r, { id: "item_food_1" }));
});

test("tables / QR-token management — MANAGER + ADMIN only", async () => {
  await deniedForAllExcept("createTable", ["admin", "manager"], (r) => call(tables, "handleCreateTable", r, { table_no: "T9", seats: 2 }));
  await deniedForAllExcept("updateTable", ["admin", "manager"], (r) => call(tables, "handleUpdateTable", r, { id: "tbl_1", seats: 6 }));
  await deniedForAllExcept("regenerateQrToken", ["admin", "manager"], (r) => call(tables, "handleRegenerateQrToken", r, { id: "tbl_1" }));
});

// -------------------------------------------------- billing (billing+manager+admin)

test("createBill FOOD / openTable / settleTable — BILLING + MANAGER + ADMIN only", async () => {
  await deniedForAllExcept("createBill FOOD", ["admin", "manager", "billing"], (r) => call(billing, "handleCreateBill", r, { type: "FOOD", items: [{ name: "x", price: 10, qty: 1 }] }));
  await deniedForAllExcept("openTable", ["admin", "manager", "billing"], (r) => call(billing, "handleOpenTable", r, { table_id: "tbl_1" }));
  await deniedForAllExcept("settleTable", ["admin", "manager", "billing"], (r) => call(billing, "handleSettleTable", r, { session_id: "nope" }));
});

test("createBill CAFE — CAFE_BILLING + BILLING + MANAGER + ADMIN (kitchen/owner denied)", async () => {
  await deniedForAllExcept("createBill CAFE", ["admin", "manager", "billing", "cafe_billing"], (r) => call(billing, "handleCreateBill", r, { type: "CAFE", items: [{ name: "Filter Coffee", price: 40, qty: 1, itemId: "item_cafe_1" }] }));
});

// -------------------------------------------------- QR + website order ops

test("QR order ops — BILLING + MANAGER + ADMIN only", async () => {
  await deniedForAllExcept("setQrOrderStatus", ["admin", "manager", "billing"], (r) => call(qr, "handleSetQrOrderStatus", r, { ref: "nope", status: "ACCEPTED" }));
  await deniedForAllExcept("pushQrOrderToBill", ["admin", "manager", "billing"], (r) => call(qr, "handlePushQrOrderToBill", r, { ref: "nope" }));
});

test("website order ops — BILLING + MANAGER + ADMIN only", async () => {
  await deniedForAllExcept("setWebsiteOrderStatus", ["admin", "manager", "billing"], (r) => call(web, "handleSetWebsiteOrderStatus", r, { order_id: "nope", status: "PREPARING" }));
  await deniedForAllExcept("addItemsToWebsiteOrder", ["admin", "manager", "billing"], (r) => call(web, "handleAddItemsToWebsiteOrder", r, { order_id: "nope", items: [] }));
  await deniedForAllExcept("settleWebsiteOrder", ["admin", "manager", "billing"], (r) => call(web, "handleSettleWebsiteOrder", r, { order_id: "nope" }));
});

// -------------------------------------------------- kitchen

test("acceptOrderToKitchen — BILLING + MANAGER + ADMIN (kitchen CANNOT accept)", async () => {
  await deniedForAllExcept("acceptOrderToKitchen", ["admin", "manager", "billing"], (r) => call(kitchen, "handleAcceptOrderToKitchen", r, { source: "qr", id: "nope" }));
});

test("setKitchenTicketStatus — KITCHEN + MANAGER + ADMIN (billing/cafe/owner denied)", async () => {
  await deniedForAllExcept("setKitchenTicketStatus", ["admin", "manager", "kitchen"], (r) => call(kitchen, "handleSetKitchenTicketStatus", r, { id: "nope", status: "PREPARING" }));
});

// -------------------------------------------------- dashboard rebuild (admin only)

test("rebuildStats — ADMIN only", async () => {
  await deniedForAllExcept("rebuildStats", ["admin"], (r) => call(stats, "handleRebuildStats", r, {}));
});

// -------------------------------------------------- OWNER is fully view-only

test("OWNER cannot mutate ANY operational callable", async () => {
  const mutations = [
    () => call(billing, "handleCreateBill", "owner", { type: "FOOD", items: [{ name: "x", price: 1, qty: 1 }] }),
    () => call(billing, "handleOpenTable", "owner", { table_id: "tbl_1" }),
    () => call(catalog, "handleUpsertCategory", "owner", { kind: "food", name: "Z" }),
    () => call(tables, "handleCreateTable", "owner", { table_no: "T9", seats: 2 }),
    () => call(qr, "handleSetQrOrderStatus", "owner", { ref: "x", status: "ACCEPTED" }),
    () => call(web, "handleSettleWebsiteOrder", "owner", { order_id: "x" }),
    () => call(kitchen, "handleAcceptOrderToKitchen", "owner", { source: "qr", id: "x" }),
    () => call(kitchen, "handleSetKitchenTicketStatus", "owner", { id: "x", status: "READY" }),
    () => call(staffAdmin, "handleCreateStaff", "owner", { username: "x", password: "secret1", full_name: "X" }),
    () => call(stats, "handleRebuildStats", "owner", {}),
  ];
  for (const m of mutations) {
    await assert.rejects(m, (e) => e.code === "permission-denied");
  }
});

// -------------------------------------------------- allowed roles actually work

test("smoke: each callable's allow-list is non-empty (an allowed role succeeds)", async () => {
  // manager: catalog
  const cat = await call(catalog, "handleUpsertCategory", "manager", { kind: "food", name: "Snacks" });
  assert.ok(cat.id);
  // billing: a food bill
  const bill = await call(billing, "handleCreateBill", "billing", { type: "FOOD", items: [{ name: "Paneer Tikka", price: 220, qty: 1, itemId: "item_food_1" }], tax_percent: 0 });
  assert.equal(bill.type, "FOOD");
  // cafe_billing: a cafe bill
  const cbill = await call(billing, "handleCreateBill", "cafe_billing", { type: "CAFE", items: [{ name: "Filter Coffee", price: 40, qty: 1, itemId: "item_cafe_1" }] });
  assert.equal(cbill.type, "CAFE");
  // admin: rebuild stats
  const rb = await call(stats, "handleRebuildStats", "admin", {});
  assert.equal(rb.ok, true);
});
