/**
 * Phase 4b — Website Orders channel (website team's contract, Razorpay).
 *
 *   POS catalog -> GET /api/website/menu -> cart -> POST /api/website/orders
 *   (re-priced, minted WEB-000123, PENDING_PAYMENT + Razorpay order for the 50%
 *   advance) -> Razorpay webhook verifies the advance -> CONFIRMED / ADVANCE_PAID
 *   -> POS Website Orders board -> Add Items -> Settle Bill -> existing POS
 *   billing/stock/bill-number/immutable-bill machinery.
 *
 * Everything is priced/totalled/verified server-side in integer paise. The
 * website sends NO amounts, ever. Duplicate payment and duplicate settlement are
 * both blocked. `status` and `paymentStatus` are separate state machines.
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, staffReq, adminReq, fnUrl, auditRows } from "./_seed.mjs";

const { signWebhookBody } = await import("../../lib/lib/razorpay.js");
const web = await import("../../lib/callable/websiteOrdersAdmin.js");
const stats = await import("../../lib/triggers/stats.js");
const db = getFirestore();

const KEY = "test-website-key";
const WEBHOOK_SECRET = "test-webhook-secret";

const post = (fn, path, body, headers = {}) =>
  fetch(fnUrl(fn) + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const apiPost = (path, body, headers = {}) => post("websiteApi", path, body, { "X-API-Key": KEY, ...headers });
const apiGet = (path) => fetch(fnUrl("websiteApi") + path, { headers: { "X-API-Key": KEY } });

/** Build + sign a Razorpay webhook delivery exactly as the provider would. */
function webhookDelivery(event, { paymentId, providerOrderId, amountPaise }) {
  const raw = JSON.stringify({
    event,
    payload: { payment: { entity: { id: paymentId, order_id: providerOrderId, amount: amountPaise, currency: "INR" } } },
  });
  return { raw, sig: signWebhookBody(WEBHOOK_SECRET, raw) };
}
function sendWebhook(event, opts, sigOverride) {
  const { raw, sig } = webhookDelivery(event, opts);
  return fetch(fnUrl("razorpayWebhook"), {
    method: "POST",
    headers: { "content-type": "application/json", "X-Razorpay-Signature": sigOverride ?? sig },
    body: raw,
  });
}

/** POST /orders then deliver a captured-advance webhook -> returns the wire order. */
async function placeAndConfirm(items, paymentId = "pay_" + Math.random().toString(16).slice(2)) {
  const r = await apiPost("/orders", {
    items,
    customer: { name: "Web Customer", phone: "9800011122", email: "w@x.com" },
    fulfillment: { type: "pickup", pickupAt: "2026-09-10T12:30:00.000Z", notes: "ring the bell" },
  });
  assert.equal(r.status, 201, "POST /orders should create the pre-order");
  const order = await r.json();
  const wh = await sendWebhook("payment.captured", {
    paymentId,
    providerOrderId: order.payment.providerOrderId,
    amountPaise: order.advancePaise,
  });
  assert.equal(wh.status, 200);
  return order;
}

const idOf = async (ref) => {
  const s = await db.collection("websiteOrders").where("ref", "==", ref).limit(1).get();
  return s.docs[0].id;
};

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "bills", "counters", "auditLog", "websiteOrders", "websitePayments"]);
  const s = await db.collection("stats").doc("daily").collection("entries").get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
  await seedCatalog();
});

// ------------------------------------------------------------ POST /orders

test("POST /orders: re-prices from catalog, mints WEB-000001, PENDING_PAYMENT + Razorpay order for the advance", async () => {
  const r = await apiPost("/orders", {
    items: [
      { id: "item_food_1", qty: 2 }, // 2 * 22000 = 44000 paise
      { id: "item_alc_1", qty: 1 }, // 18000 paise + 18% tax = 3240
    ],
    customer: { name: "Asha", phone: "9811122233", email: "asha@x.com" },
    fulfillment: { type: "pickup", pickupAt: "2026-09-10T12:30:00.000Z", notes: "extra napkins" },
  });
  assert.equal(r.status, 201);
  const o = await r.json();

  assert.equal(o.ref, "WEB-000001");
  assert.equal(o.status, "PENDING_PAYMENT");
  assert.equal(o.paymentStatus, "UNPAID");
  assert.equal(o.subtotalPaise, 62000);
  assert.equal(o.taxPaise, 3240);
  assert.equal(o.totalPaise, 65240);
  assert.equal(o.advancePaise, 32620); // round(65240 / 2)
  assert.equal(o.balancePaise, 32620);
  assert.equal(o.amountPaidPaise, 0);
  assert.equal(o.confirmedAt, null);

  // server price snapshot, not anything the client said
  assert.equal(o.items[0].id, "item_food_1");
  assert.equal(o.items[0].name, "Paneer Tikka");
  assert.equal(o.items[0].unitPricePaise, 22000);
  assert.equal(o.items[0].lineTotalPaise, 44000);

  // Razorpay handle for the browser checkout
  assert.equal(o.payment.provider, "razorpay");
  assert.equal(o.payment.amountPaise, 32620);
  assert.match(o.payment.providerOrderId, /^order_/);
  assert.ok(o.payment.keyId);

  assert.equal(o.customer.name, "Asha");
  assert.equal(o.fulfillment.type, "pickup");
  assert.equal(o.fulfillment.notes, "extra napkins");

  // persisted
  const id = await idOf("WEB-000001");
  const doc = (await db.collection("websiteOrders").doc(id).get()).data();
  assert.equal(doc.channel, "website");
  assert.equal(doc.paidPaise, 0);
  assert.deepEqual(doc.settledBillIds, []);
  assert.equal((await db.collection("counters").doc("websiteOrder").get()).data().value, 1);
});

test("POST /orders: unknown / unavailable item -> 422 {error}, no counter burn", async () => {
  await db.collection("catalog").doc("item_food_3").update({ stockQty: 0 });
  const sold = await apiPost("/orders", { items: [{ id: "item_food_3", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } });
  assert.equal(sold.status, 422);
  assert.match((await sold.json()).error, /sold out/i);

  const bogus = await apiPost("/orders", { items: [{ id: "item_nope", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } });
  assert.equal(bogus.status, 422);

  const del = await apiPost("/orders", { items: [{ id: "item_food_1", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "delivery" } });
  assert.equal(del.status, 422); // only pickup pre-orders

  const c = await db.collection("counters").doc("websiteOrder").get();
  assert.equal(c.exists ? c.data().value : 0, 0);
});

test("POST /orders: missing X-API-Key -> 401", async () => {
  const r = await fetch(fnUrl("websiteApi") + "/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ id: "item_food_1", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } }),
  });
  assert.equal(r.status, 401);
});

// ----------------------------------------------------- Razorpay webhook

test("webhook: verified advance -> CONFIRMED / ADVANCE_PAID, confirmedAt set, WEB id kept", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_confirm"); // total 22000, advance 11000
  const id = await idOf(o.ref);
  const d = (await db.collection("websiteOrders").doc(id).get()).data();
  assert.equal(o.ref, "WEB-000001");
  assert.equal(d.status, "CONFIRMED");
  assert.equal(d.paymentStatus, "ADVANCE_PAID");
  assert.equal(d.paidPaise, 11000);
  assert.equal(d.balancePaise, 11000);
  assert.ok(d.confirmedAt);
  assert.equal(d.payments.at(-1).kind, "advance");
  assert.equal(d.payments.at(-1).razorpayPaymentId, "pay_confirm");

  // de-dup marker written
  assert.equal((await db.collection("websitePayments").doc("pay_confirm").get()).data().ref, "WEB-000001");
});

test("webhook: bad signature -> 401, order untouched", async () => {
  const r = await apiPost("/orders", { items: [{ id: "item_food_1", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } });
  const o = await r.json();
  const bad = await sendWebhook("payment.captured", { paymentId: "pay_x", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise }, "deadbeef");
  assert.equal(bad.status, 401);
  const d = (await db.collection("websiteOrders").doc(await idOf(o.ref)).get()).data();
  assert.equal(d.status, "PENDING_PAYMENT");
});

test("webhook is idempotent on the razorpay payment id (no double-confirm)", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_dup");
  const again = await sendWebhook("payment.captured", { paymentId: "pay_dup", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "already-processed");
  const d = (await db.collection("websiteOrders").doc(await idOf(o.ref)).get()).data();
  assert.equal(d.payments.length, 1);
});

test("webhook: captured amount != advancePaise -> PAYMENT_FAILED / FAILED", async () => {
  const r = await apiPost("/orders", { items: [{ id: "item_food_1", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } });
  const o = await r.json();
  const wh = await sendWebhook("payment.captured", { paymentId: "pay_short", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise - 1 });
  assert.equal(wh.status, 200);
  assert.equal((await wh.json()).status, "amount-mismatch");
  const d = (await db.collection("websiteOrders").doc(await idOf(o.ref)).get()).data();
  assert.equal(d.status, "PAYMENT_FAILED");
  assert.equal(d.paymentStatus, "FAILED");
  assert.equal(d.paymentMismatch.expected, o.advancePaise);
});

test("webhook: payment.failed -> PAYMENT_FAILED / FAILED", async () => {
  const r = await apiPost("/orders", { items: [{ id: "item_food_1", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } });
  const o = await r.json();
  const wh = await sendWebhook("payment.failed", { paymentId: "pay_f", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  assert.equal(wh.status, 200);
  const d = (await db.collection("websiteOrders").doc(await idOf(o.ref)).get()).data();
  assert.equal(d.status, "PAYMENT_FAILED");
  assert.equal(d.paymentStatus, "FAILED");
});

test("webhook: unknown providerOrderId -> 200 no-matching-order", async () => {
  const wh = await sendWebhook("payment.captured", { paymentId: "pay_q", providerOrderId: "order_ghost", amountPaise: 100 });
  assert.equal(wh.status, 200);
  assert.equal((await wh.json()).status, "no-matching-order");
});

// -------------------------------------------------- GET /orders/<ref>

test("GET /api/website/orders/<ref> returns the same WebsiteOrder the website polls", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_poll");
  const r = await apiGet("/orders/" + o.ref);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ref, "WEB-000001");
  assert.equal(d.status, "CONFIRMED");
  assert.equal(d.paymentStatus, "ADVANCE_PAID");
  assert.equal(d.amountPaidPaise, 11000);
  assert.equal(d.balancePaise, 11000);

  const miss = await apiGet("/orders/WEB-999999");
  assert.equal(miss.status, 404);
});

// ------------------------------------------------------------ add items

test("addItemsToWebsiteOrder uses CURRENT catalog prices (paise) and grows the balance", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_add"); // total 22000, advance 11000
  const id = await idOf(o.ref);

  await db.collection("catalog").doc("item_food_3").update({ price: 300 }); // staff bumps price after the order

  const updated = await web.handleAddItemsToWebsiteOrder(staffReq({ order_id: id, items: [{ id: "item_food_3", qty: 2 }] }));
  // 22000 + 2*30000 = 82000 paise total (food tax 0); paid still 11000 -> balance 71000
  assert.equal(updated.total_paise, 82000);
  assert.equal(updated.paid_paise, 11000);
  assert.equal(updated.balance_paise, 71000);
  assert.equal(updated.items.length, 2);
  assert.equal(updated.items[1].unit_price_paise, 30000); // current price, never a client value

  const audit = await auditRows("website.order.additems");
  assert.equal(audit.length, 1);
  assert.match(audit[0].details.added[0], /Butter Chicken x2/);
  assert.equal(audit[0].details.balance_paise, 71000);
});

test("addItemsToWebsiteOrder is blocked once the order is COMPLETED", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_block");
  const id = await idOf(o.ref);
  await web.handleSettleWebsiteOrder(staffReq({ order_id: id, payment_method: "Cash" }));
  await assert.rejects(
    () => web.handleAddItemsToWebsiteOrder(staffReq({ order_id: id, items: [{ id: "item_food_1", qty: 1 }] })),
    (e) => e.code === "failed-precondition",
  );
});

test("addItemsToWebsiteOrder is blocked while PENDING_PAYMENT (not yet confirmed)", async () => {
  const r = await apiPost("/orders", { items: [{ id: "item_food_1", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } });
  const o = await r.json();
  const id = await idOf(o.ref);
  await assert.rejects(
    () => web.handleAddItemsToWebsiteOrder(staffReq({ order_id: id, items: [{ id: "item_food_1", qty: 1 }] })),
    (e) => e.code === "failed-precondition",
  );
});

// ----------------------------------------------------------------- settle

test("settleWebsiteOrder reuses POS billing: split bills, counters, stock, immutable, source=website, WEB ref kept", async () => {
  const o = await placeAndConfirm(
    [
      { id: "item_food_1", qty: 2 }, // 44000 paise
      { id: "item_alc_1", qty: 1 }, // 18000 + 3240 tax
    ],
    "pay_settle",
  );
  const id = await idOf(o.ref);
  assert.equal(o.advancePaise, 32620);

  const res = await web.handleSettleWebsiteOrder(staffReq({ order_id: id, payment_method: "UPI" }));

  assert.equal(res.ref, "WEB-000001");
  assert.equal(res.bills.length, 2);
  const food = res.bills.find((b) => b.type === "FOOD");
  const alc = res.bills.find((b) => b.type === "ALCOHOL");
  assert.equal(food.bill_no, "FOOD-000001");
  assert.equal(alc.bill_no, "ALC-000001");
  assert.equal(res.grand_total_paise, 65240);
  assert.equal(res.balance_collected_paise, 32620);

  const fb = (await db.collection("bills").doc(food.id).get()).data();
  assert.equal(fb.source, "website");
  assert.equal(fb.websiteOrderId, id);
  assert.equal(fb.websiteOrderNo, "WEB-000001"); // human Order ID retained on the bill
  assert.ok(fb.searchTokens.includes("web-000001")); // findable by Order ID in Orders & Bills
  assert.equal(fb.subtotal, 440);
  assert.equal(fb.discount, 0);
  assert.equal(fb.status, "confirmed");
  assert.equal(fb.depositPaidPaise, 32620);

  const ab = (await db.collection("bills").doc(alc.id).get()).data();
  assert.equal(ab.tax, 32.4);
  assert.equal(ab.grandTotal, 212.4);

  // stock decremented at settle
  assert.equal((await db.collection("catalog").doc("item_food_1").get()).data().stockQty, 8);
  assert.equal((await db.collection("catalog").doc("item_alc_1").get()).data().stockQty, 23);

  const ord = (await db.collection("websiteOrders").doc(id).get()).data();
  assert.equal(ord.status, "COMPLETED");
  assert.equal(ord.paidPaise, 65240);
  assert.equal(ord.balancePaise, 0);
  assert.deepEqual([...ord.settledBillIds].sort(), [food.id, alc.id].sort());
  assert.deepEqual([...(ord.settledBillNos || [])].sort(), ["ALC-000001", "FOOD-000001"]);
  assert.ok(ord.settledAt);
  assert.equal(ord.payments.at(-1).kind, "balance");

  // the Order ID stays the reference
  const byRef = await db.collection("bills").where("websiteOrderNo", "==", "WEB-000001").get();
  assert.equal(byRef.size, 2);

  const audit = await auditRows("website.settle");
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details.bill_ids.sort(), [food.id, alc.id].sort());
});

test("settleWebsiteOrder cannot be run twice (duplicate settlement blocked)", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_twice");
  const id = await idOf(o.ref);
  await web.handleSettleWebsiteOrder(staffReq({ order_id: id, payment_method: "Cash" }));
  const billsAfter1 = (await db.collection("bills").get()).size;
  await assert.rejects(
    () => web.handleSettleWebsiteOrder(staffReq({ order_id: id, payment_method: "Cash" })),
    (e) => e.code === "failed-precondition",
  );
  assert.equal((await db.collection("bills").get()).size, billsAfter1);
});

test("settleWebsiteOrder refuses a PENDING_PAYMENT order", async () => {
  const r = await apiPost("/orders", { items: [{ id: "item_food_1", qty: 1 }], customer: { name: "x" }, fulfillment: { type: "pickup" } });
  const o = await r.json();
  const id = await idOf(o.ref);
  await assert.rejects(
    () => web.handleSettleWebsiteOrder(staffReq({ order_id: id, payment_method: "Cash" })),
    (e) => e.code === "failed-precondition",
  );
});

test("website settlement flows into the dashboard rollups", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_dash");
  await web.handleSettleWebsiteOrder(staffReq({ order_id: await idOf(o.ref), payment_method: "Cash" }));
  // rebuildAllStats folds from a fresh `bills` collection read; under a loaded
  // emulator that query can lag the just-committed settle bill by a few ms
  // (production Firestore reads are strongly consistent), so retry briefly.
  let rolling = await stats.rebuildAllStats();
  for (let i = 0; i < 15 && rolling.today.foodBills < 1; i++) {
    await new Promise((r) => setTimeout(r, 200));
    rolling = await stats.rebuildAllStats();
  }
  assert.equal(rolling.today.foodBills, 1);
  assert.equal(rolling.today.foodSales, 220);
});

// ---------------------------------------------------------- state machine

test("setWebsiteOrderStatus enforces the FSM (CONFIRMED->PREPARING->READY) and blocks payment/settlement targets", async () => {
  const o = await placeAndConfirm([{ id: "item_food_1", qty: 1 }], "pay_fsm");
  const id = await idOf(o.ref);

  await assert.rejects(() => web.handleSetWebsiteOrderStatus(staffReq({ order_id: id, status: "READY" })), (e) => e.code === "failed-precondition");
  await assert.rejects(() => web.handleSetWebsiteOrderStatus(staffReq({ order_id: id, status: "COMPLETED" })), (e) => e.code === "failed-precondition");
  await assert.rejects(() => web.handleSetWebsiteOrderStatus(staffReq({ order_id: id, status: "CONFIRMED" })), (e) => e.code === "failed-precondition");

  const a = await web.handleSetWebsiteOrderStatus(staffReq({ order_id: id, status: "PREPARING" }));
  assert.equal(a.status, "PREPARING");
  assert.equal(a.payment_status, "ADVANCE_PAID"); // payment machine unchanged
  const b = await web.handleSetWebsiteOrderStatus(staffReq({ order_id: id, status: "READY" }));
  assert.equal(b.status, "READY");
  const c = await web.handleSetWebsiteOrderStatus(staffReq({ order_id: id, status: "CANCELLED" }));
  assert.equal(c.status, "CANCELLED");
});

test("website order callables are staff-only (owner rejected)", async () => {
  const ownerReq = (d) => staffReq(d, { auth: { uid: "u_9", token: { role: "owner", username: "owner" } } });
  await assert.rejects(() => web.handleSettleWebsiteOrder(ownerReq({ order_id: "x" })), (e) => e.code === "permission-denied");
  await assert.rejects(() => web.handleAddItemsToWebsiteOrder(ownerReq({ order_id: "x", items: [] })), (e) => e.code === "permission-denied");
  await assert.rejects(() => web.handleSetWebsiteOrderStatus(adminReq({ order_id: "" })), (e) => e.code === "invalid-argument");
});
