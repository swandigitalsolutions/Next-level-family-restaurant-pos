/**
 * Public QR customer API — replaces Flask
 *   GET  /api/qr/menu/<token>
 *   POST /api/qr/orders
 *   GET  /api/qr/orders/<public_ref>
 *   GET  /api/qr/tables/<token>/orders
 * No session auth. App Check enforced when ENFORCE_APP_CHECK=true.
 * Prices are ALWAYS re-read from `catalog` server-side (invariant I7) — anything
 * the browser sends for price/name/total is ignored.
 *
 * Responses use the {success,data}/{success,error} envelope, same as Flask ok()/error().
 */
import { onRequest } from "firebase-functions/v2/https";
import { getAppCheck } from "firebase-admin/app-check";
import { randomUUID } from "crypto";
import { REGION, RESTAURANT_NAME, QR_STATUSES, MAX_QR_LINE_QTY } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { peekCounter, commitCounter } from "../lib/counters";
import { dateKey, ValidationError } from "../lib/money";
import { RESTAURANT_TZ } from "../lib/config";

const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === "true";
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

async function appCheckOk(req: any): Promise<boolean> {
  if (!ENFORCE_APP_CHECK) return true;
  const token = String(req.header("X-Firebase-AppCheck") || "");
  if (!token) return false;
  try {
    await getAppCheck().verifyToken(token);
    return true;
  } catch {
    return false;
  }
}

function route(path: string): string[] {
  // Strip a Hosting rewrite prefix (/api/qr) or a direct emulator prefix (/qrApi).
  return path
    .replace(/^\/+/, "")
    .replace(/^api\/qr\/?/, "")
    .replace(/^qrApi\/?/, "")
    .split("/")
    .filter(Boolean);
}

async function tableByToken(token: string) {
  const snap = await getDb().collection("tables").where("qrToken", "==", token).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...(snap.docs[0].data() as any) };
}

/** Flask _qr_order_payload shape — snake_case, so the existing customer page
 * (qr-menu.js) consumes it unchanged. */
function qrOrderPayload(id: string, data: any) {
  const iso = (v: any) => {
    const d = v?.toDate ? v.toDate() : v instanceof Date ? v : null;
    return d ? d.toISOString() : null;
  };
  return {
    id,
    order_no: data.orderNo,
    public_ref: data.publicRef ?? id,
    table_id: data.tableId ?? null,
    table_session_id: data.tableSessionId ?? null,
    customer_name: data.customerName,
    note: data.note ?? null,
    status: data.status,
    subtotal: data.subtotal,
    tax: data.tax,
    grand_total: data.grandTotal,
    pushed_to_bill: data.pushedToBill ? 1 : 0,
    created_at: iso(data.createdAt),
    updated_at: iso(data.updatedAt),
    date_key: data.dateKey ?? null,
    items: (data.items || []).map((it: any) => ({
      item_kind: it.kind,
      item_id: it.itemId ?? null,
      item_name: it.itemName,
      brand: it.brand ?? "",
      bottle_size: it.bottleSize ?? "",
      price: it.price,
      qty: it.qty,
      tax_rate: it.taxRate ?? 0,
      line_total: it.lineTotal,
    })),
  };
}

export const qrApi = onRequest({ region: REGION, cors: true }, async (req, res) => {
  const ok = (data: unknown, status = 200): void => {
    res.status(status).json({ success: true, data });
  };
  const err = (message: string, status = 400): void => {
    res.status(status).json({ success: false, error: message });
  };

  if (!(await appCheckOk(req))) return err("App Check verification failed", 401);

  const db = getDb();
  const parts = route(req.path);

  try {
    // GET /menu/:token
    if (req.method === "GET" && parts[0] === "menu" && parts[1]) {
      const table = await tableByToken(parts[1]);
      if (!table) return err("This table code is not valid. Please ask our staff.", 404);

      const [foodCats, alcCats, foodItems, alcItems] = await Promise.all([
        db.collection("categories").where("kind", "==", "food").where("status", "==", "active").limit(500).get(),
        db.collection("categories").where("kind", "==", "alcohol").where("status", "==", "active").limit(500).get(),
        db.collection("catalog").where("kind", "==", "food").where("status", "==", "active").limit(3000).get(),
        db.collection("catalog").where("kind", "==", "alcohol").where("status", "==", "active").limit(3000).get(),
      ]);
      const catSort = new Map<string, number>();
      foodCats.docs.forEach((d) => catSort.set(d.id, Number(d.data().sortOrder) || 0));
      alcCats.docs.forEach((d) => catSort.set(d.id, Number(d.data().sortOrder) || 0));

      const groups = new Map<string, { category: string; sort: [number, number]; items: any[] }>();
      const inStock = (r: any) => r.stockQty === null || r.stockQty === undefined || Number(r.stockQty) > 0;
      const bucket = (name: string, sort: [number, number]) => {
        if (!groups.has(name)) groups.set(name, { category: name, sort, items: [] });
        return groups.get(name)!;
      };
      for (const d of foodItems.docs) {
        const r: any = d.data();
        bucket(r.categoryName, [0, catSort.get(r.categoryId) ?? 0]).items.push({
          id: d.id,
          kind: "food",
          name: r.name,
          price: round2(Number(r.price)),
          tax_rate: 0,
          brand: null,
          bottle_size: null,
          available: r.status === "active" && inStock(r),
        });
      }
      for (const d of alcItems.docs) {
        const r: any = d.data();
        bucket(r.categoryName, [1, catSort.get(r.categoryId) ?? 0]).items.push({
          id: d.id,
          kind: "alcohol",
          name: r.name,
          price: round2(Number(r.price)),
          tax_rate: Number(r.taxRate) || 0,
          brand: r.brand ?? null,
          bottle_size: r.bottleSize ?? null,
          available: r.status === "active" && inStock(r),
        });
      }
      const categories = [...groups.values()]
        .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1])
        .map((g) => ({
          category: g.category,
          items: g.items.sort((a, b) => String(a.name).localeCompare(b.name)),
        }));
      return ok({
        restaurant: RESTAURANT_NAME,
        table: { id: table.id, label: table.tableNo, token: parts[1] },
        categories,
      });
    }

    // POST /orders
    if (req.method === "POST" && parts[0] === "orders" && !parts[1]) {
      const body = req.body || {};
      const token = String(body.token || "").trim();
      const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
      if (rawItems.length === 0) return err("Your cart is empty.");
      const table = await tableByToken(token);
      if (!table) return err("This table code is not valid. Please ask our staff.", 404);

      // re-price every line from catalog
      const clean: any[] = [];
      let subtotal = 0;
      let taxTotal = 0;
      for (const raw of rawItems) {
        const kind = raw.kind === "alcohol" ? "alcohol" : "food";
        const itemId = String(raw.id || "");
        const qty = Number(raw.qty);
        if (!itemId || !Number.isFinite(qty)) return err("That order contains an invalid item.");
        if (qty <= 0 || qty > MAX_QR_LINE_QTY) {
          return err(`Quantity must be between 1 and ${MAX_QR_LINE_QTY}.`);
        }
        const snap = await db.collection("catalog").doc(itemId).get();
        if (!snap.exists || snap.data()?.status !== "active") {
          return err("One of the items is no longer available. Please refresh the menu.");
        }
        const r: any = snap.data();
        if (r.stockQty !== null && r.stockQty !== undefined && Number(r.stockQty) <= 0) {
          return err(`${r.name} just sold out. Please remove it and try again.`);
        }
        const price = round2(Number(r.price));
        const taxRate = kind === "alcohol" ? Number(r.taxRate) || 0 : 0;
        const lineTotal = round2(price * qty);
        subtotal += lineTotal;
        taxTotal += round2((lineTotal * taxRate) / 100);
        clean.push({
          kind,
          itemId,
          itemName: r.name,
          brand: kind === "alcohol" ? r.brand ?? "" : "",
          bottleSize: kind === "alcohol" ? r.bottleSize ?? "" : "",
          price,
          qty,
          taxRate,
          lineTotal,
        });
      }
      subtotal = round2(subtotal);
      taxTotal = round2(taxTotal);
      const grandTotal = round2(subtotal + taxTotal);
      const customerName = String(body.customer_name || "Guest").trim().slice(0, 60) || "Guest";
      const note = String(body.note || "").trim().slice(0, 280) || null;
      const publicRef = randomUUID().replace(/-/g, "");
      const now = new Date();

      let orderNo = "";
      await db.runTransaction(async (tx) => {
        const cur = await peekCounter(tx, db, "qrOrder");
        orderNo = commitCounter(tx, db, "qrOrder", cur + 1);
        tx.set(db.collection("qrOrders").doc(publicRef), {
          orderNo,
          publicRef,
          tableId: table.id,
          tableNo: table.tableNo,
          customerName,
          note,
          status: "NEW",
          subtotal,
          tax: taxTotal,
          grandTotal,
          pushedToBill: false,
          tableSessionId: null,
          createdAt: now,
          updatedAt: now,
          dateKey: dateKey(now, RESTAURANT_TZ),
          items: clean,
        });
      });

      const saved = await db.collection("qrOrders").doc(publicRef).get();
      return ok({ ...qrOrderPayload(publicRef, saved.data()), table_label: table.tableNo }, 201);
    }

    // GET /orders/:ref
    if (req.method === "GET" && parts[0] === "orders" && parts[1]) {
      const snap = await db.collection("qrOrders").doc(parts[1]).get();
      if (!snap.exists) return err("Order not found", 404);
      const data: any = snap.data();
      return ok({
        ...qrOrderPayload(snap.id, data),
        table_label: data.tableNo,
        status_flow: QR_STATUSES,
      });
    }

    // GET /tables/:token/orders
    if (req.method === "GET" && parts[0] === "tables" && parts[1] && parts[2] === "orders") {
      const table = await tableByToken(parts[1]);
      if (!table) return err("This table code is not valid.", 404);
      const today = dateKey(new Date(), RESTAURANT_TZ);
      const snap = await db
        .collection("qrOrders")
        .where("tableId", "==", table.id)
        .where("dateKey", "==", today)
        .orderBy("createdAt", "desc")
        .get();
      return ok({
        table_label: table.tableNo,
        orders: snap.docs.map((d) => qrOrderPayload(d.id, d.data())),
      });
    }

    return err("Not found", 404);
  } catch (e) {
    // user-facing validation messages are safe to return; internals are not
    if (e instanceof ValidationError) return err(e.message, 422);
    console.error("qrApi error", e);
    return err("Something went wrong. Please try again.", 500);
  }
});
