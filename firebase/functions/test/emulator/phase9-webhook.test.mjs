/**
 * Phase 9 — razorpayWebhook hardening.
 *
 * Beyond signature + amount: the webhook's order_id MUST equal the exact
 * providerOrderId stored on the WebsiteOrder. A confirmed order can never be
 * reverted by a later stray webhook. Every delivery is idempotent.
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, fnUrl } from "./_seed.mjs";

const { signWebhookBody } = await import("../../lib/lib/razorpay.js");
const db = getFirestore();
const KEY = "test-website-key";
const WEBHOOK_SECRET = "test-webhook-secret";

const apiPost = (path, body, headers = {}) =>
  fetch(fnUrl("websiteApi") + path, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": KEY, ...headers },
    body: JSON.stringify(body),
  });

function deliver(event, { paymentId, providerOrderId, amountPaise }, sigOverride) {
  const raw = event === "order.paid"
    ? JSON.stringify({ event, payload: { order: { entity: { id: providerOrderId, amount_paid: amountPaise, amount: amountPaise } } } })
    : JSON.stringify({ event, payload: { payment: { entity: { id: paymentId, order_id: providerOrderId, amount: amountPaise } } } });
  return fetch(fnUrl("razorpayWebhook"), {
    method: "POST",
    headers: { "content-type": "application/json", "X-Razorpay-Signature": sigOverride ?? signWebhookBody(WEBHOOK_SECRET, raw) },
    body: raw,
  });
}

async function placeOrder() {
  const r = await apiPost("/orders", {
    items: [{ id: "item_food_1", qty: 1 }],
    customer: { name: "Hook", phone: "9", email: "" },
    fulfillment: { type: "pickup", pickupAt: "2026-09-10T12:00:00.000Z", notes: "" },
  });
  assert.equal(r.status, 201);
  return r.json(); // { ref, advancePaise, payment: { providerOrderId } }
}
const orderDoc = async (ref) =>
  (await db.collection("websiteOrders").where("ref", "==", ref).limit(1).get()).docs[0].data();

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "bills", "counters", "auditLog", "websiteOrders", "websitePayments", "websiteOrderIdempotency"]);
  await seedCatalog();
});

test("valid capture for the stored providerOrderId -> CONFIRMED / ADVANCE_PAID", async () => {
  const o = await placeOrder();
  const r = await deliver("payment.captured", { paymentId: "pay_ok", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "confirmed");
  const d = await orderDoc(o.ref);
  assert.equal(d.status, "CONFIRMED");
  assert.equal(d.paymentStatus, "ADVANCE_PAID");
  assert.equal(d.paidPaise, o.advancePaise);
});

test("order.paid event path also confirms (uses payload.order.entity)", async () => {
  const o = await placeOrder();
  const r = await deliver("order.paid", { providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "confirmed");
  assert.equal((await orderDoc(o.ref)).status, "CONFIRMED");
});

test("WRONG provider order id -> rejected, order untouched", async () => {
  const o = await placeOrder();
  const r = await deliver("payment.captured", { paymentId: "pay_x", providerOrderId: "order_someone_elses", amountPaise: o.advancePaise });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "no-matching-order");
  assert.equal((await orderDoc(o.ref)).status, "PENDING_PAYMENT");
});

test("WRONG amount -> PAYMENT_FAILED, mismatch recorded", async () => {
  const o = await placeOrder();
  const r = await deliver("payment.captured", { paymentId: "pay_short", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise - 1 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "amount-mismatch");
  const d = await orderDoc(o.ref);
  assert.equal(d.status, "PAYMENT_FAILED");
  assert.equal(d.paymentMismatch.expected, o.advancePaise);
});

test("invalid signature -> 401, nothing processed", async () => {
  const o = await placeOrder();
  const r = await deliver("payment.captured", { paymentId: "pay_bad", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise }, "deadbeef");
  assert.equal(r.status, 401);
  assert.equal((await orderDoc(o.ref)).status, "PENDING_PAYMENT");
  assert.equal((await db.collection("websitePayments").get()).size, 0);
});

test("duplicate delivery of the SAME payment id -> processed once", async () => {
  const o = await placeOrder();
  const one = await deliver("payment.captured", { paymentId: "pay_dup", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  const two = await deliver("payment.captured", { paymentId: "pay_dup", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  assert.equal((await one.json()).status, "confirmed");
  assert.equal((await two.json()).status, "already-processed");
  const d = await orderDoc(o.ref);
  assert.equal(d.payments.length, 1);
  assert.equal(d.paidPaise, o.advancePaise);
});

test("a DIFFERENT payment webhook on an ALREADY-CONFIRMED order -> no double-confirm, no double-record", async () => {
  const o = await placeOrder();
  await deliver("payment.captured", { paymentId: "pay_first", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  const later = await deliver("payment.captured", { paymentId: "pay_second", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  assert.equal(later.status, 200);
  assert.equal((await later.json()).status, "already-confirmed");
  const d = await orderDoc(o.ref);
  assert.equal(d.status, "CONFIRMED");
  assert.equal(d.payments.length, 1); // not double-recorded
  assert.equal(d.paidPaise, o.advancePaise); // not doubled
});

test("a WRONG-amount capture arriving AFTER confirmation does NOT revert the order", async () => {
  const o = await placeOrder();
  await deliver("payment.captured", { paymentId: "pay_good", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  const bad = await deliver("payment.captured", { paymentId: "pay_junk", providerOrderId: o.payment.providerOrderId, amountPaise: 1 });
  assert.equal(bad.status, 200);
  const d = await orderDoc(o.ref);
  assert.equal(d.status, "CONFIRMED"); // still confirmed — not flipped to PAYMENT_FAILED
});

test("payment.failed -> PAYMENT_FAILED (only while still pending)", async () => {
  const o = await placeOrder();
  const r = await deliver("payment.failed", { paymentId: "pay_f", providerOrderId: o.payment.providerOrderId, amountPaise: o.advancePaise });
  assert.equal(r.status, 200);
  assert.equal((await orderDoc(o.ref)).status, "PAYMENT_FAILED");

  // a stray failed event after confirmation would NOT apply (order not pending)
  const o2 = await placeOrder();
  await deliver("payment.captured", { paymentId: "pc2", providerOrderId: o2.payment.providerOrderId, amountPaise: o2.advancePaise });
  const stray = await deliver("payment.failed", { paymentId: "pf2", providerOrderId: o2.payment.providerOrderId, amountPaise: o2.advancePaise });
  assert.match((await stray.json()).status, /already-confirmed|ignored-not-pending/); // not applied
  assert.equal((await orderDoc(o2.ref)).status, "CONFIRMED"); // NOT reverted
});

test("non-payment events are ignored with 200", async () => {
  const r = await deliver("payment.authorized", { paymentId: "pa", providerOrderId: "order_x", amountPaise: 100 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ignored, "payment.authorized");
});
