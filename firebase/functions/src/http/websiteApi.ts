/**
 * websiteApi — the backend the SEPARATE Website project calls for pre-ordering
 * (see WEBSITE-INTEGRATION.md). Server-to-server, X-API-Key, CORS closed.
 *
 *   POST /api/website/orders        re-price the cart, mint WEB-000123, create the
 *                                   PENDING_PAYMENT order + a Razorpay order for
 *                                   the 50% advance, return the WebsiteOrder
 *   GET  /api/website/orders/<ref>  the same WebsiteOrder (website polls every 8s)
 *
 * The website sends NO amounts, ever. Every paise figure and the Order ID come
 * from here. (GET /api/website/menu stays on the `websiteMenu` function.)
 *
 * Idempotency: POST honours an optional `Idempotency-Key` header
 * (^[A-Za-z0-9._:-]{8,128}$). The same key replays the SAME WebsiteOrder and
 * never creates a 2nd WEB-xxxxxx or a 2nd Razorpay provider order, even under
 * concurrent delivery from multiple Cloud Function instances (see lib/idempotency.ts).
 */
import { onRequest } from "firebase-functions/v2/https";
import { getAppCheck } from "firebase-admin/app-check";
import { REGION, ADVANCE_RATE, RESTAURANT_TZ } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { ValidationError } from "../lib/money";
import { dateKey } from "../lib/money";
import { priceCartPaise } from "../lib/pricing";
import { peekCounter, commitCounter } from "../lib/counters";
import { createProviderOrder } from "../lib/razorpay";
import {
  IDEMPOTENCY_KEY_RE, IDEMPOTENCY_COLL, requestHash,
  claimIdempotencyKey, stashPendingOrder, finalizeIdempotencyKey,
  releaseIdempotencyKey, awaitIdempotencyResult,
} from "../lib/idempotency";

const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === "true";
const keys = () =>
  new Set(String(process.env.WEBSITE_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean));

async function appCheckOk(req: any): Promise<boolean> {
  if (!ENFORCE_APP_CHECK) return true;
  const t = String(req.header("X-Firebase-AppCheck") || "");
  if (!t) return false;
  try {
    await getAppCheck().verifyToken(t);
    return true;
  } catch {
    return false;
  }
}

const strip = (path: string) =>
  path.replace(/^\/+/, "").replace(/^api\/website\/?/, "").replace(/^websiteApi\/?/, "").split("/").filter(Boolean);

/** The WebsiteOrder wire object — the website team's exact contract. */
export function websiteOrderWire(d: any) {
  const iso = (v: any) => {
    const dt = v?.toDate ? v.toDate() : v instanceof Date ? v : null;
    return dt ? dt.toISOString() : null;
  };
  return {
    ref: d.ref,
    status: d.status,
    paymentStatus: d.paymentStatus,
    items: (d.items || []).map((it: any) => ({
      id: it.itemId,
      name: it.name,
      unitPricePaise: it.unitPricePaise,
      qty: it.qty,
      lineTotalPaise: it.lineTotalPaise,
    })),
    subtotalPaise: d.subtotalPaise,
    taxPaise: d.taxPaise,
    totalPaise: d.totalPaise,
    advancePaise: d.advancePaise,
    balancePaise: d.balancePaise,
    amountPaidPaise: d.paidPaise || 0,
    customer: d.customer || {},
    fulfillment: {
      type: d.fulfillment?.type || "pickup",
      pickupAt: iso(d.fulfillment?.pickupAt) ?? d.fulfillment?.pickupAt ?? null,
      notes: d.fulfillment?.notes ?? "",
    },
    createdAt: iso(d.createdAt),
    confirmedAt: iso(d.confirmedAt),
    payment: d.payment
      ? {
          provider: d.payment.provider,
          amountPaise: d.payment.amountPaise,
          providerOrderId: d.payment.providerOrderId,
          keyId: d.payment.keyId,
        }
      : null,
  };
}

export const websiteApi = onRequest({ region: REGION, cors: false }, async (req, res) => {
  const ok = (data: unknown, status = 200): void => {
    res.status(status).json(data);
  };
  const err = (message: string, status = 400): void => {
    res.status(status).json({ error: message });
  };

  const key = String(req.header("X-API-Key") || "");
  if (!key || !keys().has(key)) return err("unauthorized", 401);
  if (!(await appCheckOk(req))) return err("app check verification failed", 401);

  const db = getDb();
  const parts = strip(req.path);

  const loadOrderById = async (id: string) => {
    const s = await db.collection("websiteOrders").doc(id).get();
    return s.exists ? s.data() : null;
  };

  try {
    // ---- POST /orders --------------------------------------------
    if (req.method === "POST" && parts[0] === "orders" && !parts[1]) {
      const body = req.body || {};
      const customer = body.customer || {};
      const fulfillment = body.fulfillment || {};
      if ((fulfillment.type || "pickup") !== "pickup") {
        return err("only pickup pre-orders are supported", 422);
      }
      const pickupAt = fulfillment.pickupAt ? new Date(fulfillment.pickupAt) : null;
      if (pickupAt && isNaN(pickupAt.getTime())) {
        return err("fulfillment.pickupAt must be an ISO datetime", 422);
      }

      // ---- Idempotency-Key (optional, honoured when present) ----
      const idemKeyRaw = String(req.header("Idempotency-Key") || "").trim();
      let idemKey: string | null = null;
      if (idemKeyRaw) {
        if (!IDEMPOTENCY_KEY_RE.test(idemKeyRaw)) {
          return err("Idempotency-Key must match ^[A-Za-z0-9._:-]{8,128}$", 400);
        }
        idemKey = idemKeyRaw;
      }
      const hash = requestHash({ items: body.items, customer, fulfillment: body.fulfillment });

      let pendingOrder: any = null; // filled on a "claimed" or "resume" path
      if (idemKey) {
        const claim = await claimIdempotencyKey(db, idemKey, hash);
        if (claim.outcome === "conflict") {
          return err("Idempotency-Key already used with a different request", 422);
        }
        if (claim.outcome === "duplicate") {
          const d = await loadOrderById(claim.orderId);
          if (d) return ok(websiteOrderWire(d), 201);
          // lock said done but order is gone — fall through and re-mint (rare)
        }
        if (claim.outcome === "in_progress") {
          const done = await awaitIdempotencyResult(db, idemKey);
          if (done) {
            const d = await loadOrderById(done.orderId);
            if (d) return ok(websiteOrderWire(d), 201);
          }
          res.setHeader("Retry-After", "2");
          return err("a request with this Idempotency-Key is still processing", 409);
        }
        if (claim.outcome === "resume") pendingOrder = claim.pendingOrder;
      }

      const now = new Date();
      // Compute prices + create the Razorpay provider order ONCE per key.
      if (!pendingOrder) {
        let priced, advancePaise, provider;
        try {
          priced = await priceCartPaise(
            (id) => db.collection("catalog").doc(id).get().then((s) => (s.exists ? (s.data() as any) : null)),
            body.items,
            { requireInStock: true },
          );
          advancePaise = Math.round(priced.totalPaise * ADVANCE_RATE);
          provider = await createProviderOrder(advancePaise, idemKey || `web-${Date.now()}`);
        } catch (e) {
          // pricing/validation/provider failed — nothing durable exists yet, so
          // release the lock and let a corrected retry with the same key proceed.
          if (idemKey) await releaseIdempotencyKey(db, idemKey);
          throw e;
        }
        pendingOrder = {
          customer: {
            name: String(customer.name || "").trim().slice(0, 80),
            phone: String(customer.phone || "").trim().slice(0, 20),
            email: String(customer.email || "").trim().slice(0, 120),
          },
          fulfillment: {
            type: "pickup",
            pickupAt: pickupAt || null,
            notes: String(fulfillment.notes || "").trim().slice(0, 500),
          },
          items: priced.items,
          subtotalPaise: priced.subtotalPaise,
          taxPaise: priced.taxPaise,
          totalPaise: priced.totalPaise,
          advancePaise,
          balancePaise: priced.totalPaise - advancePaise,
          payment: {
            provider: provider.provider,
            providerOrderId: provider.providerOrderId,
            keyId: provider.keyId,
            amountPaise: advancePaise,
          },
        };
        // Provider order now exists — from here we NEVER release the lock (a
        // resume must reuse this exact provider order). Stash it for resume.
        if (idemKey) await stashPendingOrder(db, idemKey, pendingOrder);
      }

      // Mint WEB-xxxxxx + create the order atomically. The transaction ALSO
      // refuses to create a 2nd order for the same idempotency key (safety net
      // independent of the lock doc; index websiteOrders(idempotencyKey)).
      const orderRef = db.collection("websiteOrders").doc();
      let ref = "";
      let createdId = orderRef.id;
      await db.runTransaction(async (tx) => {
        if (idemKey) {
          const dup = await tx.get(
            db.collection("websiteOrders").where("idempotencyKey", "==", idemKey).limit(1),
          );
          if (!dup.empty) { createdId = dup.docs[0].id; ref = dup.docs[0].data().ref; return; }
        }
        const cur = await peekCounter(tx, db, "websiteOrder");
        ref = commitCounter(tx, db, "websiteOrder", cur + 1); // WEB-000123
        tx.set(orderRef, {
          ref,
          channel: "website",
          status: "PENDING_PAYMENT",
          paymentStatus: "UNPAID",
          idempotencyKey: idemKey || null,
          customer: pendingOrder.customer,
          fulfillment: pendingOrder.fulfillment,
          items: pendingOrder.items,
          subtotalPaise: pendingOrder.subtotalPaise,
          taxPaise: pendingOrder.taxPaise,
          totalPaise: pendingOrder.totalPaise,
          advancePaise: pendingOrder.advancePaise,
          balancePaise: pendingOrder.balancePaise,
          paidPaise: 0,
          payment: pendingOrder.payment,
          settledBillIds: [],
          settledBillNos: [],
          createdAt: now,
          updatedAt: now,
          confirmedAt: null,
          dateKey: dateKey(now, RESTAURANT_TZ),
        });
        if (idemKey) {
          tx.set(db.collection(IDEMPOTENCY_COLL).doc(idemKey),
            { status: "done", orderId: orderRef.id, ref, completedAt: now }, { merge: true });
        }
      });
      if (idemKey) await finalizeIdempotencyKey(db, idemKey, createdId, ref);

      const saved = await loadOrderById(createdId);
      return ok(websiteOrderWire(saved), 201);
    }

    // ---- GET /orders/<ref> ------------------------------------
    if (req.method === "GET" && parts[0] === "orders" && parts[1]) {
      const snap = await db.collection("websiteOrders").where("ref", "==", parts[1]).limit(1).get();
      if (snap.empty) return err("order not found", 404);
      return ok(websiteOrderWire(snap.docs[0].data()));
    }

    return err("not found", 404);
  } catch (e) {
    if (e instanceof ValidationError) return err(e.message, 422);
    // never leak internals to the caller
    console.error("websiteApi error", e);
    return err("internal error", 500);
  }
});
