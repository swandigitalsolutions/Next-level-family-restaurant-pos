/**
 * Phase 7 — Kitchen screen.
 *   billing "accepts" a QR-table order or a paid website order
 *     -> acceptOrderToKitchen writes a kitchenTickets doc (QUEUED)
 *   kitchen works it: setKitchenTicketStatus  QUEUED -> PREPARING -> READY -> DONE
 *
 * The kitchen never sees prices; accept is idempotent per source order; the
 * cafe channel never raises a ticket (covered in phase7-cafe).
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, staffReq, cafeReq, kitchenReq, adminReq, fnUrl, auditRows } from "./_seed.mjs";

const kitchen = await import("../../lib/callable/kitchen.js");
const db = getFirestore();

const qrPost = (path, body) =>
  fetch(fnUrl("qrApi") + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

async function placeQrOrder(items = [{ id: "item_food_1", kind: "food", qty: 2 }]) {
  const r = await qrPost("/orders", { token: "tok_t1", customer_name: "Guest", items });
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data; // { public_ref, order_no, ... }
}

async function makeWebsiteOrder(status = "CONFIRMED") {
  const ref = db.collection("websiteOrders").doc();
  await ref.set({
    ref: "WEB-000009", channel: "website", status, paymentStatus: "ADVANCE_PAID",
    customer: { name: "Web Guest", phone: "9", email: "" },
    fulfillment: { type: "pickup", pickupAt: null, notes: "no chilli" },
    items: [
      { itemId: "item_food_1", name: "Paneer Tikka", kind: "food", unitPricePaise: 22000, qty: 1, taxRatePct: 0, lineTotalPaise: 22000 },
      { itemId: "item_alc_1", name: "Kingfisher Premium", kind: "alcohol", unitPricePaise: 18000, qty: 1, taxRatePct: 18, lineTotalPaise: 18000 },
    ],
    subtotalPaise: 40000, taxPaise: 3240, totalPaise: 43240,
    advancePaise: 21620, balancePaise: 21620, paidPaise: 21620,
    settledBillIds: [], settledBillNos: [],
    note: "no chilli",
    createdAt: new Date(), updatedAt: new Date(), confirmedAt: new Date(),
    dateKey: "2026-09-07",
  });
  return ref.id;
}

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "tableSessions", "qrOrders", "websiteOrders", "kitchenTickets", "counters", "auditLog", "bills"]);
  await seedCatalog();
});

// ------------------------------------------------------------------ QR accept

test("accept a QR order -> kitchen ticket QUEUED, QR order advances NEW->ACCEPTED, idempotent", async () => {
  const o = await placeQrOrder([{ id: "item_food_1", kind: "food", qty: 2 }, { id: "item_food_3", kind: "food", qty: 1 }]);

  const t = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: o.public_ref }));
  assert.equal(t.source, "qr");
  assert.equal(t.ref, "QR-000001");
  assert.equal(t.table_label, "Table 01");
  assert.equal(t.status, "QUEUED");
  assert.equal(t.items.length, 2);
  assert.equal(t.items[0].qty, 2);
  assert.ok(!("price" in t.items[0]) && !("unit_price_paise" in t.items[0])); // kitchen never sees money

  const order = (await db.collection("qrOrders").doc(o.public_ref).get()).data();
  assert.equal(order.status, "ACCEPTED");
  assert.equal(order.kitchenTicketId, t.id);
  assert.equal(order.kitchenStatus, "QUEUED"); // denormalised for the Billing board
  assert.equal((await db.collection("kitchenTickets").get()).size, 1);

  // accept again -> same ticket, no duplicate
  const again = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: o.public_ref }));
  assert.equal(again.id, t.id);
  assert.equal((await db.collection("kitchenTickets").get()).size, 1);

  const audit = await auditRows("kitchen.accept");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.ref, "QR-000001");
});

test("a QR order that Billing has NOT accepted raises NO kitchen ticket (kitchen never sees it)", async () => {
  await placeQrOrder();
  await placeQrOrder([{ id: "item_food_2", kind: "food", qty: 1 }]);
  // customer/staff created orders exist, but none accepted
  assert.equal((await db.collection("kitchenTickets").get()).size, 0);
  const board = await db.collection("kitchenTickets")
    .where("status", "in", ["QUEUED", "PREPARING", "READY"]).get();
  assert.equal(board.size, 0);
});

test("a website order that Billing has NOT accepted raises NO kitchen ticket", async () => {
  await makeWebsiteOrder("CONFIRMED"); // paid + confirmed, but not accepted by Billing
  assert.equal((await db.collection("kitchenTickets").get()).size, 0);
});

test("cannot accept a CANCELLED QR order", async () => {
  const o = await placeQrOrder();
  await db.collection("qrOrders").doc(o.public_ref).update({ status: "CANCELLED" });
  await assert.rejects(
    () => kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: o.public_ref })),
    (e) => e.code === "failed-precondition",
  );
});

// -------------------------------------------------------------- website accept

test("accept a CONFIRMED website order -> ticket QUEUED, order advances CONFIRMED->PREPARING", async () => {
  const id = await makeWebsiteOrder("CONFIRMED");
  const t = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "website", id }));
  assert.equal(t.source, "website");
  assert.equal(t.ref, "WEB-000009");
  assert.equal(t.table_label, null);
  assert.equal(t.customer_name, "Web Guest");
  assert.equal(t.note, "no chilli");
  assert.equal(t.items.length, 2);

  const order = (await db.collection("websiteOrders").doc(id).get()).data();
  assert.equal(order.status, "PREPARING");
  assert.equal(order.kitchenTicketId, t.id);
  assert.equal(order.kitchenStatus, "QUEUED");
});

test("kitchen status steps mirror back onto the source order (Billing sees it)", async () => {
  const o = await placeQrOrder();
  const t = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: o.public_ref }));
  await kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t.id, status: "PREPARING" }));
  assert.equal((await db.collection("qrOrders").doc(o.public_ref).get()).data().kitchenStatus, "PREPARING");
  await kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t.id, status: "READY" }));
  assert.equal((await db.collection("qrOrders").doc(o.public_ref).get()).data().kitchenStatus, "READY");
});

test("cannot accept a website order that isn't paid/confirmed", async () => {
  const id = await makeWebsiteOrder("PENDING_PAYMENT");
  await assert.rejects(
    () => kitchen.handleAcceptOrderToKitchen(staffReq({ source: "website", id })),
    (e) => e.code === "failed-precondition",
  );
});

// -------------------------------------------------------------- ticket status

test("setKitchenTicketStatus steps QUEUED -> PREPARING -> READY -> DONE and stamps times", async () => {
  const o = await placeQrOrder();
  const t = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: o.public_ref }));

  const p = await kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t.id, status: "PREPARING" }));
  assert.equal(p.status, "PREPARING");
  const r = await kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t.id, status: "READY" }));
  assert.equal(r.status, "READY");
  assert.ok(r.ready_at);
  const d = await kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t.id, status: "DONE" }));
  assert.equal(d.status, "DONE");
  assert.ok(d.done_at);

  // cannot walk backwards
  await assert.rejects(
    () => kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t.id, status: "PREPARING" })),
    (e) => e.code === "failed-precondition",
  );
  // QUEUED is not a valid manual target
  await assert.rejects(
    () => kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t.id, status: "QUEUED" })),
    (e) => e.code === "invalid-argument",
  );
});

test("QUEUED -> READY jump is allowed; QUEUED -> DONE is allowed", async () => {
  const a = await placeQrOrder();
  const t1 = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: a.public_ref }));
  assert.equal((await kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t1.id, status: "READY" }))).status, "READY");

  const id2 = await makeWebsiteOrder("CONFIRMED");
  const t2 = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "website", id: id2 }));
  assert.equal((await kitchen.handleSetKitchenTicketStatus(kitchenReq({ id: t2.id, status: "DONE" }))).status, "DONE");
});

// ---------------------------------------------------------------- permissions

test("accept is billing/manager/admin only; ticket status is kitchen/manager/admin only", async () => {
  const o = await placeQrOrder();
  await assert.rejects(() => kitchen.handleAcceptOrderToKitchen(kitchenReq({ source: "qr", id: o.public_ref })), (e) => e.code === "permission-denied");
  await assert.rejects(() => kitchen.handleAcceptOrderToKitchen(cafeReq({ source: "qr", id: o.public_ref })), (e) => e.code === "permission-denied");

  const t = await kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: o.public_ref }));
  await assert.rejects(() => kitchen.handleSetKitchenTicketStatus(staffReq({ id: t.id, status: "PREPARING" })), (e) => e.code === "permission-denied");
  await assert.rejects(() => kitchen.handleSetKitchenTicketStatus(cafeReq({ id: t.id, status: "PREPARING" })), (e) => e.code === "permission-denied");
  // manager may also work tickets
  assert.equal((await kitchen.handleSetKitchenTicketStatus(adminReq({ id: t.id, status: "PREPARING" }))).status, "PREPARING");
});

test("bad input: unknown source / missing id", async () => {
  await assert.rejects(() => kitchen.handleAcceptOrderToKitchen(staffReq({ source: "carrier-pigeon", id: "x" })), (e) => e.code === "invalid-argument");
  await assert.rejects(() => kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr" })), (e) => e.code === "invalid-argument");
  await assert.rejects(() => kitchen.handleAcceptOrderToKitchen(staffReq({ source: "qr", id: "nope" })), (e) => e.code === "not-found");
});
