/**
 * razorpayWebhook — POS-side payment verification for the website pre-order flow.
 * The Website project has NO webhook; Razorpay calls THIS.
 *
 * Verifies X-Razorpay-Signature over the RAW body, then for a captured advance
 * payment whose amount == the order's advancePaise:
 *   paymentStatus -> ADVANCE_PAID,  status -> CONFIRMED,  confirmedAt set.
 * The order then appears on the POS Website Orders board and any listening POS
 * client fires the realtime "Website Order Received" notification (Firestore
 * onSnapshot — no server push needed).
 *
 * Idempotent per razorpay payment id. Always returns 200 once the signature is
 * valid, so Razorpay stops retrying.
 */
import { onRequest } from "firebase-functions/v2/https";
import { REGION, RESTAURANT_TZ } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { dateKey } from "../lib/money";
import { verifyWebhookSignature } from "../lib/razorpay";

export const razorpayWebhook = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const raw = (req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {}));
  const sig = String(req.header("X-Razorpay-Signature") || "");
  if (!verifyWebhookSignature(raw, sig)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const db = getDb();
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    res.status(200).json({ ok: true, ignored: "unparseable" });
    return;
  }

  const event = String(body.event || "");
  const isPaid = event === "payment.captured" || event === "order.paid";
  const isFailed = event === "payment.failed";
  if (!isPaid && !isFailed) {
    res.status(200).json({ ok: true, ignored: event });
    return;
  }

  // Derive the Razorpay ids per event type — do NOT loosely OR them together.
  const payEntity = body.payload?.payment?.entity || {};
  const orderEntity = body.payload?.order?.entity || {};
  const razorpayPaymentId = String(payEntity.id || "");
  const razorpayOrderId = String(
    event === "order.paid" ? orderEntity.id || "" : payEntity.order_id || "",
  );
  const amountPaise = Number(
    event === "order.paid" ? orderEntity.amount_paid ?? orderEntity.amount ?? 0 : payEntity.amount ?? 0,
  );

  if (!razorpayOrderId) {
    res.status(200).json({ ok: true, ignored: "no razorpay order id on payload" });
    return;
  }
  // a payment.* event with no payment id can't be de-duplicated safely
  if (isPaid && event !== "order.paid" && !razorpayPaymentId) {
    res.status(200).json({ ok: true, ignored: "no razorpay payment id" });
    return;
  }

  const markerId = razorpayPaymentId || `order_paid:${razorpayOrderId}`;

  const result = await db.runTransaction(async (tx) => {
    // 1) idempotency — same webhook delivery never processed twice
    const markerRef = db.collection("websitePayments").doc(markerId);
    const marker = await tx.get(markerRef);
    if (marker.exists) return { status: "already-processed" };

    // 2) find the order BY its stored providerOrderId (the authoritative link)
    const q = await tx.get(
      db.collection("websiteOrders").where("payment.providerOrderId", "==", razorpayOrderId).limit(1),
    );
    if (q.empty) return { status: "no-matching-order" };
    const ref = q.docs[0].ref;
    const order = q.docs[0].data();
    const now = new Date();

    // 3) defence-in-depth: the stored providerOrderId MUST equal the webhook's
    //    order_id. Reject any mismatch without touching the order.
    if (String(order.payment?.providerOrderId || "") !== razorpayOrderId) {
      tx.set(markerRef, { event, at: now, rejected: "provider-order-mismatch", razorpayOrderId });
      return { status: "provider-order-mismatch" };
    }

    // 4) never revert an order that has already left PENDING_PAYMENT
    if (order.status !== "PENDING_PAYMENT") {
      tx.set(markerRef, { ref: order.ref, event, at: now, note: "order not pending" });
      return { status: order.status === "CONFIRMED" ? "already-confirmed" : "ignored-not-pending", ref: order.ref };
    }

    if (isFailed) {
      tx.update(ref, { paymentStatus: "FAILED", status: "PAYMENT_FAILED", updatedAt: now });
      tx.set(markerRef, { ref: order.ref, event, at: now });
      return { status: "payment-failed", ref: order.ref };
    }

    // 5) captured / paid — the amount MUST equal the 50% advance we computed
    if (amountPaise !== Number(order.advancePaise)) {
      tx.update(ref, {
        paymentStatus: "FAILED",
        status: "PAYMENT_FAILED",
        updatedAt: now,
        paymentMismatch: { expected: order.advancePaise, received: amountPaise },
      });
      tx.set(markerRef, { ref: order.ref, event, at: now, amountMismatch: true });
      return { status: "amount-mismatch", ref: order.ref };
    }

    tx.update(ref, {
      paymentStatus: "ADVANCE_PAID",
      status: "CONFIRMED",
      paidPaise: amountPaise,
      confirmedAt: now,
      updatedAt: now,
      dateKey: dateKey(now, RESTAURANT_TZ),
      payments: [
        ...(order.payments || []),
        { kind: "advance", amountPaise, razorpayPaymentId, razorpayOrderId, at: now },
      ],
    });
    tx.set(markerRef, { ref: order.ref, event, amountPaise, razorpayOrderId, at: now });
    return { status: "confirmed", ref: order.ref };
  });

  res.status(200).json({ ok: true, ...result });
});
