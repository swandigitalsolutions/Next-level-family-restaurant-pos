/**
 * razorpayWebhook — Lambda port of firebase/functions/src/http/paymentWebhook.ts.
 * Verification/idempotency/no-revert logic ported line-for-line onto a
 * Postgres SERIALIZABLE transaction with a row lock on the marker id (the
 * exact analogue of the Firestore tx read-then-write pattern this handler
 * was built around, including the 11 hardening cases in
 * firebase/functions/test/emulator/phase9-webhook.test.mjs — see
 * aws/backend/test/paymentWebhook.test.ts for the ported suite).
 *
 * NOTE: API Gateway HTTP API base64-encodes a raw body for some content
 * types; `event.body` + `event.isBase64Encoded` is handled below so the
 * signature is verified over the EXACT bytes Razorpay signed, same as
 * `req.rawBody` did in the Firebase version.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { withTransaction } from "../../lib/db";
import { dateKey } from "../../lib/money";
import { verifyWebhookSignature } from "../../lib/razorpay";

function rawBodyOf(event: APIGatewayProxyEventV2): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "method not allowed" }) };
  }
  const raw = rawBodyOf(event);
  const sig = String(event.headers?.["x-razorpay-signature"] || "");
  if (!verifyWebhookSignature(raw, sig)) {
    return { statusCode: 401, body: JSON.stringify({ error: "invalid signature" }) };
  }

  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: "unparseable" }) };
  }

  const evt = String(body.event || "");
  const isPaid = evt === "payment.captured" || evt === "order.paid";
  const isFailed = evt === "payment.failed";
  if (!isPaid && !isFailed) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: evt }) };
  }

  const payEntity = body.payload?.payment?.entity || {};
  const orderEntity = body.payload?.order?.entity || {};
  const razorpayPaymentId = String(payEntity.id || "");
  const razorpayOrderId = String(evt === "order.paid" ? orderEntity.id || "" : payEntity.order_id || "");
  const amountPaise = Number(evt === "order.paid" ? orderEntity.amount_paid ?? orderEntity.amount ?? 0 : payEntity.amount ?? 0);

  if (!razorpayOrderId) return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: "no razorpay order id on payload" }) };
  if (isPaid && evt !== "order.paid" && !razorpayPaymentId) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: "no razorpay payment id" }) };
  }

  const markerId = razorpayPaymentId || `order_paid:${razorpayOrderId}`;

  const result = await withTransaction(async (client) => {
    // 1) idempotency — insert-or-detect-existing under FOR UPDATE, same
    //    "first writer wins" guarantee as Firestore tx.get+tx.set on a fresh doc.
    const existing = await client.query("SELECT marker_id FROM website_payments WHERE marker_id = $1 FOR UPDATE", [markerId]);
    if (existing.rowCount) return { status: "already-processed" };

    // 2) find the order by its stored providerOrderId (the authoritative link)
    const q = await client.query(
      "SELECT * FROM website_orders WHERE payment->>'providerOrderId' = $1 LIMIT 1 FOR UPDATE",
      [razorpayOrderId],
    );
    if (q.rowCount === 0) return { status: "no-matching-order" };
    const order = q.rows[0];
    const now = new Date();

    const markInsert = (extra: Record<string, any>) =>
      client.query(
        `INSERT INTO website_payments (marker_id, ref, event, amount_paise, amount_mismatch, rejected, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [markerId, extra.ref ?? order.ref, evt, extra.amountPaise ?? null, extra.amountMismatch ?? null, extra.rejected ?? null, now],
      );

    // 3) defence-in-depth: stored providerOrderId MUST equal the webhook's order_id
    if (String(order.payment?.providerOrderId || "") !== razorpayOrderId) {
      await markInsert({ rejected: "provider-order-mismatch" });
      return { status: "provider-order-mismatch" };
    }

    // 4) never revert an order that has already left PENDING_PAYMENT
    if (order.status !== "PENDING_PAYMENT") {
      await markInsert({});
      return { status: order.status === "CONFIRMED" ? "already-confirmed" : "ignored-not-pending", ref: order.ref };
    }

    if (isFailed) {
      await client.query("UPDATE website_orders SET payment_status='FAILED', status='PAYMENT_FAILED', updated_at=$2 WHERE id=$1", [order.id, now]);
      await markInsert({});
      return { status: "payment-failed", ref: order.ref };
    }

    // 5) captured/paid — amount MUST equal the 50% advance computed at order-create
    if (amountPaise !== Number(order.advance_paise)) {
      await client.query(
        "UPDATE website_orders SET payment_status='FAILED', status='PAYMENT_FAILED', updated_at=$2 WHERE id=$1",
        [order.id, now],
      );
      await markInsert({ amountMismatch: true });
      return { status: "amount-mismatch", ref: order.ref };
    }

    const payments = [...(order.payments || []), { kind: "advance", amountPaise, razorpayPaymentId, razorpayOrderId, at: now.toISOString() }];
    await client.query(
      `UPDATE website_orders SET payment_status='ADVANCE_PAID', status='CONFIRMED', paid_paise=$2,
         confirmed_at=$3, updated_at=$3, date_key=$4, payments=$5 WHERE id=$1`,
      [order.id, amountPaise, now, dateKey(now), JSON.stringify(payments)],
    );
    await markInsert({ amountPaise });
    return { status: "confirmed", ref: order.ref };
  });

  return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
};
