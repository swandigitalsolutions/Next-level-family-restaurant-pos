import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem } from "./_helpers";
import { handler as websiteApiHandler } from "../src/handlers/http/websiteApi";
import { handler as webhookHandler } from "../src/handlers/http/paymentWebhook";
import { signWebhookBody } from "../src/lib/razorpay";

before(async () => { await getPool(); });
beforeEach(resetDb);

async function createOrder(): Promise<{ id: string; ref: string; providerOrderId: string; advancePaise: number }> {
  const pool = await getPool();
  const catId = await seedCategory(pool, "food");
  const itemId = await seedItem(pool, { kind: "food", categoryId: catId, name: "Thali", price: 200 });
  const res: any = await websiteApiHandler({
    rawPath: "/api/website/orders", requestContext: { http: { method: "POST" } },
    headers: { "x-api-key": "test-website-key" },
    body: JSON.stringify({ items: [{ id: itemId, qty: 2 }], customer: { name: "Ravi" }, fulfillment: { type: "pickup" } }),
    isBase64Encoded: false,
  } as any);
  const body = JSON.parse(res.body);
  return { id: body.ref, ref: body.ref, providerOrderId: body.payment.providerOrderId, advancePaise: body.advancePaise };
}

function sendWebhook(payload: object) {
  const raw = JSON.stringify(payload);
  const sig = signWebhookBody("test-webhook-secret", raw);
  return webhookHandler({
    requestContext: { http: { method: "POST" } },
    headers: { "x-razorpay-signature": sig },
    body: raw, isBase64Encoded: false,
  } as any);
}

function capturedEvent(providerOrderId: string, amountPaise: number, paymentId = "pay_test1") {
  return { event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: providerOrderId, amount: amountPaise } } } };
}

test("valid capture confirms the order (status CONFIRMED, paymentStatus ADVANCE_PAID)", async () => {
  const o = await createOrder();
  const res: any = await sendWebhook(capturedEvent(o.providerOrderId, o.advancePaise));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, "confirmed");

  const pool = await getPool();
  const row = (await pool.query("SELECT status, payment_status FROM website_orders WHERE ref=$1", [o.ref])).rows[0];
  assert.equal(row.status, "CONFIRMED");
  assert.equal(row.payment_status, "ADVANCE_PAID");
});

test("invalid signature -> 401, order untouched", async () => {
  const o = await createOrder();
  const raw = JSON.stringify(capturedEvent(o.providerOrderId, o.advancePaise));
  const res: any = await webhookHandler({
    requestContext: { http: { method: "POST" } },
    headers: { "x-razorpay-signature": "0000deadbeef" },
    body: raw, isBase64Encoded: false,
  } as any);
  assert.equal(res.statusCode, 401);
  const pool = await getPool();
  const row = (await pool.query("SELECT status FROM website_orders WHERE ref=$1", [o.ref])).rows[0];
  assert.equal(row.status, "PENDING_PAYMENT");
});

test("wrong provider order id (mismatch) -> rejected, order stays pending", async () => {
  const o = await createOrder();
  const res: any = await sendWebhook(capturedEvent("order_totally_wrong_id", o.advancePaise));
  const body = JSON.parse(res.body);
  assert.equal(body.status, "no-matching-order");
  const pool = await getPool();
  const row = (await pool.query("SELECT status FROM website_orders WHERE ref=$1", [o.ref])).rows[0];
  assert.equal(row.status, "PENDING_PAYMENT");
});

test("wrong amount -> PAYMENT_FAILED, not confirmed", async () => {
  const o = await createOrder();
  const res: any = await sendWebhook(capturedEvent(o.providerOrderId, o.advancePaise + 100));
  const body = JSON.parse(res.body);
  assert.equal(body.status, "amount-mismatch");
  const pool = await getPool();
  const row = (await pool.query("SELECT status FROM website_orders WHERE ref=$1", [o.ref])).rows[0];
  assert.equal(row.status, "PAYMENT_FAILED");
});

test("duplicate webhook delivery (same payment id) is a no-op the second time", async () => {
  const o = await createOrder();
  const r1: any = await sendWebhook(capturedEvent(o.providerOrderId, o.advancePaise, "pay_dup_1"));
  const r2: any = await sendWebhook(capturedEvent(o.providerOrderId, o.advancePaise, "pay_dup_1"));
  assert.equal(JSON.parse(r1.body).status, "confirmed");
  assert.equal(JSON.parse(r2.body).status, "already-processed");
});

test("a stray event AFTER confirmation never reverts a confirmed order", async () => {
  const o = await createOrder();
  await sendWebhook(capturedEvent(o.providerOrderId, o.advancePaise, "pay_first"));
  const stray: any = await sendWebhook(capturedEvent(o.providerOrderId, o.advancePaise + 999, "pay_stray"));
  const body = JSON.parse(stray.body);
  assert.match(body.status, /already-confirmed|ignored-not-pending/);
  const pool = await getPool();
  const row = (await pool.query("SELECT status, payment_status FROM website_orders WHERE ref=$1", [o.ref])).rows[0];
  assert.equal(row.status, "CONFIRMED", "must never revert a confirmed order");
  assert.equal(row.payment_status, "ADVANCE_PAID");
});

test("payment.failed on a still-pending order -> PAYMENT_FAILED", async () => {
  const o = await createOrder();
  const raw = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_fail1", order_id: o.providerOrderId, amount: o.advancePaise } } } });
  const sig = signWebhookBody("test-webhook-secret", raw);
  const res: any = await webhookHandler({ requestContext: { http: { method: "POST" } }, headers: { "x-razorpay-signature": sig }, body: raw, isBase64Encoded: false } as any);
  assert.equal(JSON.parse(res.body).status, "payment-failed");
  const pool = await getPool();
  const row = (await pool.query("SELECT status FROM website_orders WHERE ref=$1", [o.ref])).rows[0];
  assert.equal(row.status, "PAYMENT_FAILED");
});

test("unrelated event type is ignored (200, no-op)", async () => {
  const raw = JSON.stringify({ event: "refund.created", payload: {} });
  const sig = signWebhookBody("test-webhook-secret", raw);
  const res: any = await webhookHandler({ requestContext: { http: { method: "POST" } }, headers: { "x-razorpay-signature": sig }, body: raw, isBase64Encoded: false } as any);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ignored, "refund.created");
});
