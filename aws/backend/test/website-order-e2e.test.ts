import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem, seedUser, fakeEvent } from "./_helpers";
import { handler as websiteApiHandler } from "../src/handlers/http/websiteApi";
import { handler as websiteMenuHandler } from "../src/handlers/http/websiteMenu";
import { handler as paymentWebhookHandler } from "../src/handlers/http/paymentWebhook";
import { handler as websiteOrdersAdminHandler } from "../src/handlers/callable/websiteOrdersAdmin";
import { signWebhookBody } from "../src/lib/razorpay";

/**
 * One full website-order lifecycle, end to end, through the real handlers
 * and a real local Postgres — not mocks. This is the scenario the user
 * asked to verify before considering AWS deploy-ready:
 *   website menu -> customer places order -> advance payment webhook fires
 *   -> order lands in the POS as CONFIRMED -> staff moves it through
 *   PREPARING/READY -> staff settles it into a real bill, with stock
 *   decremented and an audit row written.
 */

before(async () => { await getPool(); });
beforeEach(resetDb);

test("website order: full lifecycle end to end", async () => {
  const pool = await getPool();

  // 1) Seed catalog exactly as the POS menu screen would show it.
  const catId = await seedCategory(pool, "food", "Mains");
  const thaliId = await seedItem(pool, { kind: "food", categoryId: catId, name: "Veg Thali", price: 200, taxRate: 5, stockQty: 10 });
  const staffUid = await seedUser(pool, "billing");

  // 2) The website's menu fetch. Assert it is sourced from the SAME catalog
  //    rows the POS billing screen reads (no separate "website menu" data set
  //    that could ever drift from what's actually billed).
  const menuRes: any = await websiteMenuHandler({
    rawPath: "/api/website/menu",
    requestContext: { http: { method: "GET" } },
    headers: { "x-api-key": "test-website-key" },
  } as any);
  assert.equal(menuRes.statusCode, 200);
  const menu = JSON.parse(menuRes.body);
  const menuItem = menu.categories.flatMap((c: any) => c.items).find((it: any) => it.id === thaliId);
  assert.ok(menuItem, "seeded catalog item must appear on the website menu");
  assert.equal(menuItem.pricePaise, 20000);
  assert.equal(menuItem.available, true);

  const catalogRow = await pool.query("SELECT price, status, kind FROM catalog WHERE id=$1", [thaliId]);
  assert.equal(Number(catalogRow.rows[0].price), menuItem.price, "website price must equal the exact POS catalog price, not a copy");

  // 3) Customer places the order via the public website API (same contract
  //    the separate Website repo calls — X-API-Key, Idempotency-Key).
  const createRes: any = await websiteApiHandler({
    rawPath: "/api/website/orders",
    requestContext: { http: { method: "POST" } },
    headers: { "x-api-key": "test-website-key", "idempotency-key": "e2e-test-key-000001" },
    body: JSON.stringify({
      items: [{ id: thaliId, qty: 3 }],
      customer: { name: "Ravi Kumar", phone: "9876543210", email: "ravi@example.com" },
      fulfillment: { type: "pickup", notes: "extra spicy" },
    }),
    isBase64Encoded: false,
  } as any);
  assert.equal(createRes.statusCode, 201);
  const created = JSON.parse(createRes.body);
  assert.match(created.ref, /^WEB-\d{6}$/);
  assert.equal(created.status, "PENDING_PAYMENT");
  assert.equal(created.paymentStatus, "UNPAID");
  // 3 x Rs.200 = 600; food items never carry tax in this system (only
  // alcohol does — see lib/pricing.ts), so total == subtotal; 50% advance = 300
  assert.equal(created.totalPaise, 60000);
  assert.equal(created.advancePaise, 30000);
  assert.equal(created.balancePaise, 30000);
  assert.ok(created.payment?.providerOrderId?.startsWith("order_mock_"));

  const orderRow = await pool.query("SELECT id FROM website_orders WHERE ref=$1", [created.ref]);
  const orderId = orderRow.rows[0].id;

  // 4) Razorpay webhook fires for the advance payment — this is the ONLY
  //    path that can move PENDING_PAYMENT -> CONFIRMED (staff cannot do this
  //    directly; see websiteOrdersAdmin.ts's explicit 409 on that attempt).
  const webhookBody = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: { entity: { id: "pay_e2e_test_1", order_id: created.payment.providerOrderId, amount: created.advancePaise } },
    },
  });
  const sig = signWebhookBody("test-webhook-secret", webhookBody);
  const webhookRes: any = await paymentWebhookHandler({
    requestContext: { http: { method: "POST" } },
    headers: { "x-razorpay-signature": sig },
    body: webhookBody,
    isBase64Encoded: false,
  } as any);
  assert.equal(webhookRes.statusCode, 200);
  assert.equal(JSON.parse(webhookRes.body).status, "confirmed");

  const confirmed = await pool.query("SELECT status, payment_status, paid_paise FROM website_orders WHERE id=$1", [orderId]);
  assert.equal(confirmed.rows[0].status, "CONFIRMED");
  assert.equal(confirmed.rows[0].payment_status, "ADVANCE_PAID");
  assert.equal(Number(confirmed.rows[0].paid_paise), 30000);

  // 4b) Replaying the same webhook event must not double-apply the payment
  //     (dedup via website_payments.marker_id) — a real-world Razorpay retry.
  const replay: any = await paymentWebhookHandler({
    requestContext: { http: { method: "POST" } },
    headers: { "x-razorpay-signature": sig },
    body: webhookBody,
    isBase64Encoded: false,
  } as any);
  assert.equal(JSON.parse(replay.body).status, "already-processed");

  // 5) Staff moves the order through the kitchen workflow statuses.
  const staffCtx = (action: string, body: unknown) => fakeEvent({ role: "billing", uid: staffUid, action, body });
  for (const to of ["PREPARING", "READY"]) {
    const r: any = await websiteOrdersAdminHandler(staffCtx("setWebsiteOrderStatus", { order_id: orderId, status: to }));
    const parsed = JSON.parse(r.body ?? "{}");
    assert.equal(r.statusCode, 200, `transition to ${to} must succeed: ${r.body}`);
    assert.equal((parsed.data ?? parsed).status, to);
  }

  // 5b) Staff cannot short-circuit straight to COMPLETED (must go through Settle Bill).
  const badComplete: any = await websiteOrdersAdminHandler(staffCtx("setWebsiteOrderStatus", { order_id: orderId, status: "COMPLETED" }));
  assert.equal(badComplete.statusCode, 409);

  // 6) Settle the order into a real bill — stock decrements, a FOOD bill is
  //    created, and the order is marked COMPLETED with the balance collected.
  const settleRes: any = await websiteOrdersAdminHandler(staffCtx("settleWebsiteOrder", { order_id: orderId, payment_method: "Cash" }));
  assert.equal(settleRes.statusCode, 200, `settle must succeed: ${settleRes.body}`);
  const settled = JSON.parse(settleRes.body).data ?? JSON.parse(settleRes.body);
  assert.equal(settled.bills.length, 1);
  assert.equal(settled.bills[0].type, "FOOD");
  assert.equal(settled.grand_total_paise, 60000);
  assert.equal(settled.balance_collected_paise, 30000);

  const finalOrder = await pool.query("SELECT status, settled_bill_ids, settled_bill_nos, paid_paise, balance_paise FROM website_orders WHERE id=$1", [orderId]);
  assert.equal(finalOrder.rows[0].status, "COMPLETED");
  assert.equal(finalOrder.rows[0].settled_bill_ids.length, 1);
  assert.equal(Number(finalOrder.rows[0].paid_paise), 60000);
  assert.equal(Number(finalOrder.rows[0].balance_paise), 0);

  const billId = finalOrder.rows[0].settled_bill_ids[0];
  const bill = await pool.query("SELECT bill_no, type, grand_total, source, website_order_id FROM bills WHERE id=$1", [billId]);
  assert.equal(bill.rows[0].type, "FOOD");
  assert.equal(bill.rows[0].source, "website");
  assert.equal(bill.rows[0].website_order_id, orderId);
  assert.equal(Number(bill.rows[0].grand_total), 600);

  const stock = await pool.query("SELECT stock_qty FROM catalog WHERE id=$1", [thaliId]);
  assert.equal(Number(stock.rows[0].stock_qty), 7, "stock must decrement by the ordered qty (10 - 3)");

  const audit = await pool.query("SELECT action FROM audit_log WHERE entity_id=$1 ORDER BY created_at", [orderId]);
  assert.ok(audit.rows.some((r) => r.action === "website.settle"), "settlement must be audited");

  // 7) Trying to settle a second time must fail (no double-billing).
  const secondSettle: any = await websiteOrdersAdminHandler(staffCtx("settleWebsiteOrder", { order_id: orderId, payment_method: "Cash" }));
  assert.equal(secondSettle.statusCode, 409);
});

test("website order: rejected items never reach the POS as an order", async () => {
  const pool = await getPool();
  await seedUser(pool, "billing");
  // No catalog item exists for this id at all -> must be rejected up front,
  // never silently created as a phantom/zero-priced order.
  const res: any = await websiteApiHandler({
    rawPath: "/api/website/orders",
    requestContext: { http: { method: "POST" } },
    headers: { "x-api-key": "test-website-key" },
    body: JSON.stringify({ items: [{ id: "does-not-exist", qty: 1 }], customer: { name: "X" }, fulfillment: { type: "pickup" } }),
    isBase64Encoded: false,
  } as any);
  assert.equal(res.statusCode, 422);
  const count = await pool.query("SELECT count(*)::int AS n FROM website_orders");
  assert.equal(count.rows[0].n, 0, "no order row must be created for a rejected cart");
});

test("website order: out-of-stock item is rejected at order time (requireInStock)", async () => {
  const pool = await getPool();
  const catId = await seedCategory(pool, "food", "Mains");
  const itemId = await seedItem(pool, { kind: "food", categoryId: catId, name: "Sold Out Curry", price: 150, stockQty: 0 });
  await seedUser(pool, "billing");
  const res: any = await websiteApiHandler({
    rawPath: "/api/website/orders",
    requestContext: { http: { method: "POST" } },
    headers: { "x-api-key": "test-website-key" },
    body: JSON.stringify({ items: [{ id: itemId, qty: 1 }], customer: { name: "X" }, fulfillment: { type: "pickup" } }),
    isBase64Encoded: false,
  } as any);
  assert.equal(res.statusCode, 422);
});
