/**
 * Phase 4 — QR customer API (server re-pricing, stock-out, qty limits) + staff
 * setQrOrderStatus (FSM) + pushQrOrderToBill (session merge, idempotency).
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, staffReq, fnUrl } from "./_seed.mjs";

const qrAdmin = await import("../../lib/callable/qrOrdersAdmin.js");
const billing = await import("../../lib/callable/billing.js");
const db = getFirestore();
const post = (path, body) =>
  fetch(fnUrl("qrApi") + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const get = (path) => fetch(fnUrl("qrApi") + path).then((r) => r.json());

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "tableSessions", "qrOrders", "counters", "auditLog", "bills"]);
  await seedCatalog();
});

test("GET /menu/:token groups food then alcohol, marks availability, 404 on bad token", async () => {
  const bad = await get("/menu/nope");
  assert.equal(bad.success, false);

  const res = await get("/menu/tok_t1");
  assert.equal(res.success, true);
  assert.equal(res.data.table.label, "Table 01");
  const cats = res.data.categories.map((c) => c.category);
  assert.deepEqual(cats, ["Starters", "Mains", "Beer"]); // food sort, then alcohol
  const alc = res.data.categories.find((c) => c.category === "Beer").items[0];
  assert.equal(alc.kind, "alcohol");
  assert.equal(alc.tax_rate, 18);
  assert.equal(alc.available, true);
});

test("POST /orders re-prices from catalog (ignores client price), assigns QR-000001", async () => {
  const res = await post("/orders", {
    token: "tok_t1",
    customer_name: "Guest",
    items: [
      { id: "item_food_1", kind: "food", qty: 2, price: 1 }, // client price ignored
      { id: "item_alc_1", kind: "alcohol", qty: 1, price: 999 },
    ],
  });
  assert.equal(res.success, true);
  const o = res.data;
  assert.equal(o.order_no, "QR-000001");
  assert.equal(o.status, "NEW");
  // 2*220 + 1*180 = 620 subtotal; tax = 180*18% = 32.4
  assert.equal(o.subtotal, 620);
  assert.equal(o.tax, 32.4);
  assert.equal(o.grand_total, 652.4);
  assert.equal(o.items[0].price, 220); // server price
  assert.equal(o.items[0].item_name, "Paneer Tikka"); // Flask snake_case wire shape
  // QR placement does NOT decrement stock (Flask only checks availability)
  assert.equal((await db.collection("catalog").doc("item_food_1").get()).data().stockQty, 10);
});

test("POST /orders enforces qty 1..50 and rejects sold-out / inactive items", async () => {
  const tooMany = await post("/orders", { token: "tok_t1", items: [{ id: "item_food_1", kind: "food", qty: 51 }] });
  assert.match(tooMany.error, /between 1 and 50/);

  await db.collection("catalog").doc("item_food_3").update({ stockQty: 0 });
  const soldOut = await post("/orders", { token: "tok_t1", items: [{ id: "item_food_3", kind: "food", qty: 1 }] });
  assert.match(soldOut.error, /sold out/);

  await db.collection("catalog").doc("item_food_2").update({ status: "inactive" });
  const gone = await post("/orders", { token: "tok_t1", items: [{ id: "item_food_2", kind: "food", qty: 1 }] });
  assert.match(gone.error, /no longer available/);
});

test("GET /orders/:ref returns status + status_flow; GET /tables/:token/orders lists today's", async () => {
  const placed = (await post("/orders", { token: "tok_t1", items: [{ id: "item_food_1", kind: "food", qty: 1 }] })).data;
  const status = await get("/orders/" + placed.public_ref);
  assert.equal(status.data.status, "NEW");
  assert.ok(Array.isArray(status.data.status_flow));

  const list = await get("/tables/tok_t1/orders");
  assert.equal(list.data.orders.length, 1);
  assert.equal(list.data.orders[0].order_no, "QR-000001");
});

test("setQrOrderStatus enforces one legal FSM step", async () => {
  const placed = (await post("/orders", { token: "tok_t1", items: [{ id: "item_food_1", kind: "food", qty: 1 }] })).data;
  const ref = placed.public_ref;

  await assert.rejects(
    () => qrAdmin.handleSetQrOrderStatus(staffReq({ ref, status: "READY" })), // skip
    (e) => e.code === "failed-precondition",
  );
  const a = await qrAdmin.handleSetQrOrderStatus(staffReq({ ref, status: "ACCEPTED" }));
  assert.equal(a.status, "ACCEPTED");
  const c = await qrAdmin.handleSetQrOrderStatus(staffReq({ ref, status: "CANCELLED" }));
  assert.equal(c.status, "CANCELLED");
  await assert.rejects(
    () => qrAdmin.handleSetQrOrderStatus(staffReq({ ref, status: "PREPARING" })), // from terminal
    (e) => e.code === "failed-precondition",
  );
});

test("pushQrOrderToBill creates an open session, merges items, is not repeatable", async () => {
  const placed = (await post("/orders", {
    token: "tok_t1",
    items: [{ id: "item_food_1", kind: "food", qty: 1 }, { id: "item_alc_1", kind: "alcohol", qty: 2 }],
  })).data;
  const ref = placed.public_ref;

  const out = await qrAdmin.handlePushQrOrderToBill(staffReq({ ref }));
  assert.ok(out.table_session_id);
  const sess = (await db.collection("tableSessions").doc(out.table_session_id).get()).data();
  assert.equal(sess.status, "open");
  assert.equal(sess.items.length, 2);
  const t = (await db.collection("tables").doc("tbl_1").get()).data();
  assert.equal(t.status, "occupied");
  assert.equal(t.openSessionId, out.table_session_id);

  const order = (await db.collection("qrOrders").doc(ref).get()).data();
  assert.equal(order.pushedToBill, true);
  assert.equal(order.status, "SERVED");

  await assert.rejects(
    () => qrAdmin.handlePushQrOrderToBill(staffReq({ ref })),
    (e) => e.code === "failed-precondition",
  );
});

test("pushQrOrderToBill appends to an already-open session", async () => {
  const { session } = await billing.handleOpenTable(staffReq({ table_id: "tbl_1", customer_name: "Priya" }));
  await db.collection("tableSessions").doc(session.id).update({
    items: [{ kind: "food", itemId: "item_food_2", itemName: "Chicken 65", brand: "", bottleSize: "", price: 240, qty: 1, taxRate: 0, lineTotal: 240 }],
  });
  const placed = (await post("/orders", { token: "tok_t1", items: [{ id: "item_food_1", kind: "food", qty: 1 }] })).data;
  const out = await qrAdmin.handlePushQrOrderToBill(staffReq({ ref: placed.public_ref }));
  assert.equal(out.table_session_id, session.id);
  const sess = (await db.collection("tableSessions").doc(session.id).get()).data();
  assert.equal(sess.items.length, 2);
});
