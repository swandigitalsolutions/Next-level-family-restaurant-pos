/**
 * websiteApi — Lambda/API Gateway port of firebase/functions/src/http/websiteApi.ts.
 * Same contract the separate Website project already integrates against (see
 * firebase/WEBSITE-INTEGRATION.md) — only the transport under it changed.
 *
 *   POST /api/website/orders        re-price the cart, mint WEB-000123, create
 *                                   the PENDING_PAYMENT order + a Razorpay order
 *                                   for the 50% advance
 *   GET  /api/website/orders/<ref>  the same WebsiteOrder (website polls)
 *
 * Idempotency-Key handling, outcome-for-outcome, matches the Firestore version
 * (see lib/idempotency.ts port notes). App Check has no AWS equivalent — the
 * X-API-Key check is the sole bot/abuse gate here; consider AWS WAF token/rate
 * rules on this route in production (see aws/docs/PARITY-CHECKLIST.md).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getPool, withTransaction } from "../../lib/db";
import { ADVANCE_RATE } from "../../lib/config";
import { ValidationError, dateKey } from "../../lib/money";
import { priceCartPaise } from "../../lib/pricing";
import { peekCounter, commitCounter } from "../../lib/counters";
import { createProviderOrder } from "../../lib/razorpay";
import {
  IDEMPOTENCY_KEY_RE, requestHash,
  claimIdempotencyKey, stashPendingOrder, finalizeIdempotencyKey,
  releaseIdempotencyKey, awaitIdempotencyResult,
} from "../../lib/idempotency";
import { ok, err, withErrors } from "../../lib/http";

const keys = () => new Set(String(process.env.WEBSITE_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean));

function websiteOrderWire(row: any) {
  return {
    ref: row.ref,
    status: row.status,
    paymentStatus: row.payment_status,
    items: (row.items || []).map((it: any) => ({
      id: it.itemId, name: it.name, unitPricePaise: it.unitPricePaise, qty: it.qty, lineTotalPaise: it.lineTotalPaise,
    })),
    subtotalPaise: row.subtotal_paise,
    taxPaise: row.tax_paise,
    totalPaise: row.total_paise,
    advancePaise: row.advance_paise,
    balancePaise: row.balance_paise,
    amountPaidPaise: row.paid_paise || 0,
    customer: row.customer || {},
    fulfillment: {
      type: row.fulfillment?.type || "pickup",
      pickupAt: row.fulfillment?.pickupAt ?? null,
      notes: row.fulfillment?.notes ?? "",
    },
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
    payment: row.payment
      ? { provider: row.payment.provider, amountPaise: row.payment.amountPaise, providerOrderId: row.payment.providerOrderId, keyId: row.payment.keyId }
      : null,
  };
}

async function loadOrderById(id: string) {
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM website_orders WHERE id = $1", [id]);
  return res.rows[0] || null;
}
async function loadOrderByRef(ref: string) {
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM website_orders WHERE ref = $1", [ref]);
  return res.rows[0] || null;
}

async function handlePost(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = event.body ? JSON.parse(event.body) : {};
  const customer = body.customer || {};
  const fulfillment = body.fulfillment || {};
  if ((fulfillment.type || "pickup") !== "pickup") return err("only pickup pre-orders are supported", 422);
  const pickupAt = fulfillment.pickupAt ? new Date(fulfillment.pickupAt) : null;
  if (pickupAt && isNaN(pickupAt.getTime())) return err("fulfillment.pickupAt must be an ISO datetime", 422);

  const idemKeyRaw = String(event.headers?.["idempotency-key"] || "").trim();
  let idemKey: string | null = null;
  if (idemKeyRaw) {
    if (!IDEMPOTENCY_KEY_RE.test(idemKeyRaw)) return err("Idempotency-Key must match ^[A-Za-z0-9._:-]{8,128}$", 400);
    idemKey = idemKeyRaw;
  }
  const hash = requestHash({ items: body.items, customer, fulfillment: body.fulfillment });

  let pendingOrder: any = null;
  if (idemKey) {
    const claim = await withTransaction((c) => claimIdempotencyKey(c, idemKey!, hash));
    if (claim.outcome === "conflict") return err("Idempotency-Key already used with a different request", 422);
    if (claim.outcome === "duplicate") {
      const row = await loadOrderById(claim.orderId);
      if (row) return ok(websiteOrderWire(row), 201);
    }
    if (claim.outcome === "in_progress") {
      const done = await awaitIdempotencyResult(idemKey);
      if (done) {
        const row = await loadOrderById(done.orderId);
        if (row) return ok(websiteOrderWire(row), 201);
      }
      return { statusCode: 409, headers: { "Retry-After": "2", "Content-Type": "application/json" }, body: JSON.stringify({ error: "a request with this Idempotency-Key is still processing" }) };
    }
    if (claim.outcome === "resume") pendingOrder = claim.pendingOrder;
  }

  const pool = await getPool();
  if (!pendingOrder) {
    let priced, advancePaise, provider;
    try {
      priced = await priceCartPaise(
        async (id) => {
          const r = await pool.query("SELECT * FROM catalog WHERE id = $1", [id]);
          if (!r.rows[0]) return null;
          const d = r.rows[0];
          return { name: d.name, status: d.status, kind: d.kind, price: d.price, taxRate: d.tax_rate, stockQty: d.stock_qty, brand: d.brand, bottleSize: d.bottle_size };
        },
        body.items,
        { requireInStock: true },
      );
      advancePaise = Math.round(priced.totalPaise * ADVANCE_RATE);
      provider = await createProviderOrder(advancePaise, idemKey || `web-${Date.now()}`);
    } catch (e) {
      if (idemKey) await releaseIdempotencyKey(idemKey);
      throw e;
    }
    pendingOrder = {
      customer: {
        name: String(customer.name || "").trim().slice(0, 80),
        phone: String(customer.phone || "").trim().slice(0, 20),
        email: String(customer.email || "").trim().slice(0, 120),
      },
      fulfillment: { type: "pickup", pickupAt: pickupAt ? pickupAt.toISOString() : null, notes: String(fulfillment.notes || "").trim().slice(0, 500) },
      items: priced.items,
      subtotalPaise: priced.subtotalPaise, taxPaise: priced.taxPaise, totalPaise: priced.totalPaise,
      advancePaise, balancePaise: priced.totalPaise - advancePaise,
      payment: { provider: provider.provider, providerOrderId: provider.providerOrderId, keyId: provider.keyId, amountPaise: advancePaise },
    };
    if (idemKey) await stashPendingOrder(idemKey, pendingOrder);
  }

  const now = new Date();
  const { id: createdId, ref } = await withTransaction(async (client) => {
    if (idemKey) {
      const dup = await client.query("SELECT id, ref FROM website_orders WHERE idempotency_key = $1", [idemKey]);
      if (dup.rows[0]) return { id: dup.rows[0].id, ref: dup.rows[0].ref };
    }
    const cur = await peekCounter(client, "website");
    const ref = await commitCounter(client, "website", cur + 1); // WEB-000123
    const insert = await client.query(
      `INSERT INTO website_orders
         (ref, channel, status, payment_status, idempotency_key, customer, fulfillment, items,
          subtotal_paise, tax_paise, total_paise, advance_paise, balance_paise, paid_paise, payment,
          created_at, updated_at, date_key)
       VALUES ($1,'website','PENDING_PAYMENT','UNPAID',$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$12,$13)
       RETURNING id`,
      [ref, idemKey, JSON.stringify(pendingOrder.customer), JSON.stringify(pendingOrder.fulfillment), JSON.stringify(pendingOrder.items),
       pendingOrder.subtotalPaise, pendingOrder.taxPaise, pendingOrder.totalPaise, pendingOrder.advancePaise, pendingOrder.balancePaise,
       JSON.stringify(pendingOrder.payment), now, dateKey(now)],
    );
    const id = insert.rows[0].id;
    if (idemKey) await finalizeIdempotencyKey(client, idemKey, id, ref);
    return { id, ref };
  });

  const saved = await loadOrderById(createdId);
  return ok(websiteOrderWire(saved), 201);
}

export const handler = withErrors(async (event: any): Promise<APIGatewayProxyResultV2> => {
  const key = String(event.headers?.["x-api-key"] || "");
  if (!key || !keys().has(key)) return err("unauthorized", 401, "unauthenticated");

  const method = event.requestContext.http.method;
  const parts = String(event.rawPath || "").replace(/^\/+/, "").replace(/^api\/website\/?/, "").split("/").filter(Boolean);

  try {
    if (method === "POST" && parts[0] === "orders" && !parts[1]) return await handlePost(event);
    if (method === "GET" && parts[0] === "orders" && parts[1]) {
      const row = await loadOrderByRef(parts[1]);
      if (!row) return err("order not found", 404);
      return ok(websiteOrderWire(row));
    }
    return err("not found", 404);
  } catch (e) {
    if (e instanceof ValidationError) return err(e.message, 422);
    console.error("websiteApi error", e);
    return err("internal error", 500);
  }
});
