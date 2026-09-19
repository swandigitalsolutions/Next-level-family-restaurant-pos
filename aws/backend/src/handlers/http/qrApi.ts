/**
 * Public QR customer API — Lambda port of
 * firebase/functions/src/http/qrApi.ts. No session auth. Prices are ALWAYS
 * re-read from `catalog` server-side (invariant I7) — anything the browser
 * sends for price/name/total is ignored. Response envelope
 * `{success,data}`/`{success,error}` matches the Firebase version so
 * `hosting/js/qr-menu.js` needs no response-shape changes, only a transport
 * swap (see aws/hosting/js/api-shim.js).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { randomUUID } from "crypto";
import { RESTAURANT_NAME, RESTAURANT_TZ, QR_STATUSES, MAX_QR_LINE_QTY, MAX_QR_LINES } from "../../lib/config";
import { getPool, withTransaction } from "../../lib/db";
import { peekCounter, commitCounter } from "../../lib/counters";
import { dateKey, round2, ValidationError } from "../../lib/money";
import { broadcast } from "../../lib/broadcastClient";
import { posImageUrl } from "../../lib/assetUrl";

function ok(data: unknown, status = 200): APIGatewayProxyResultV2 {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, data }) };
}
function err(message: string, status = 400): APIGatewayProxyResultV2 {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, error: message }) };
}

async function tableByToken(token: string) {
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM restaurant_tables WHERE qr_token=$1 LIMIT 1", [token]);
  return res.rows[0] || null;
}

function qrOrderPayload(row: any) {
  return {
    id: row.public_ref, order_no: row.order_no, public_ref: row.public_ref,
    table_id: row.table_id ?? null, table_session_id: row.table_session_id ?? null,
    customer_name: row.customer_name, note: row.note ?? null, status: row.status,
    subtotal: Number(row.subtotal), tax: Number(row.tax), grand_total: Number(row.grand_total),
    pushed_to_bill: row.pushed_to_bill ? 1 : 0,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    date_key: row.date_key ?? null,
    items: (row.items || []).map((it: any) => ({ item_kind: it.kind, item_id: it.itemId ?? null, item_name: it.itemName, brand: it.brand ?? "", bottle_size: it.bottleSize ?? "", price: it.price, qty: it.qty, tax_rate: it.taxRate ?? 0, line_total: it.lineTotal })),
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const pool = await getPool();
  const parts = String(event.rawPath || "").replace(/^\/+/, "").replace(/^api\/qr\/?/, "").split("/").filter(Boolean);
  const method = event.requestContext.http.method;

  try {
    // GET /menu/:token
    if (method === "GET" && parts[0] === "menu" && parts[1]) {
      const table = await tableByToken(parts[1]);
      if (!table) return err("This table code is not valid. Please ask our staff.", 404);

      const [foodItems, alcItems] = await Promise.all([
        pool.query("SELECT * FROM catalog WHERE kind='food' AND status='active' ORDER BY category_sort, name_lower LIMIT 3000"),
        pool.query("SELECT * FROM catalog WHERE kind='alcohol' AND status='active' ORDER BY category_sort, name_lower LIMIT 3000"),
      ]);
      const groups = new Map<string, { category: string; sort: [number, number]; items: any[] }>();
      const inStock = (r: any) => r.stock_qty === null || r.stock_qty === undefined || Number(r.stock_qty) > 0;
      const bucket = (name: string, sort: [number, number]) => {
        if (!groups.has(name)) groups.set(name, { category: name, sort, items: [] });
        return groups.get(name)!;
      };
      for (const r of foodItems.rows) {
        bucket(r.category_name, [0, r.category_sort ?? 0]).items.push({ id: r.id, kind: "food", name: r.name, price: round2(Number(r.price)), tax_rate: 0, brand: null, bottle_size: null, image_url: posImageUrl(r.image_path), available: r.status === "active" && inStock(r) });
      }
      for (const r of alcItems.rows) {
        bucket(r.category_name, [1, r.category_sort ?? 0]).items.push({ id: r.id, kind: "alcohol", name: r.name, price: round2(Number(r.price)), tax_rate: Number(r.tax_rate) || 0, brand: r.brand ?? null, bottle_size: r.bottle_size ?? null, image_url: posImageUrl(r.image_path), available: r.status === "active" && inStock(r) });
      }
      const categories = [...groups.values()].sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1])
        .map((g) => ({ category: g.category, items: g.items.sort((a, b) => String(a.name).localeCompare(b.name)) }));
      return ok({ restaurant: RESTAURANT_NAME, table: { id: table.id, label: table.table_no, token: parts[1] }, categories });
    }

    // POST /orders
    if (method === "POST" && parts[0] === "orders" && !parts[1]) {
      const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : {};
      const token = String(body.token || "").trim();
      const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
      if (rawItems.length === 0) return err("Your cart is empty.");
      // This route is public and unauthenticated - anyone who can photograph a
      // table's QR can call it. Each line costs a database round trip, so an
      // uncapped cart is a free way to tie up a Lambda and run up a bill.
      if (rawItems.length > MAX_QR_LINES) return err(`An order can have at most ${MAX_QR_LINES} different items.`);
      const table = await tableByToken(token);
      if (!table) return err("This table code is not valid. Please ask our staff.", 404);

      const clean: any[] = []; let subtotal = 0; let taxTotal = 0;
      for (const raw of rawItems) {
        const kind = raw.kind === "alcohol" ? "alcohol" : "food";
        const itemId = String(raw.id || "");
        const qty = Number(raw.qty);
        // Integer, not merely finite: a qty of 2.5 priced a real line at half a
        // portion and put a fractional quantity on the kitchen ticket. Track A
        // parses this with int(); matching it keeps the two in step.
        if (!itemId || !Number.isInteger(qty)) return err("That order contains an invalid item.");
        if (qty <= 0 || qty > MAX_QR_LINE_QTY) return err(`Quantity must be between 1 and ${MAX_QR_LINE_QTY}.`);
        const r = (await pool.query("SELECT * FROM catalog WHERE id=$1", [itemId])).rows[0];
        if (!r || r.status !== "active") return err("One of the items is no longer available. Please refresh the menu.");
        if (r.stock_qty !== null && r.stock_qty !== undefined && Number(r.stock_qty) <= 0) return err(`${r.name} just sold out. Please remove it and try again.`);
        const price = round2(Number(r.price));
        const taxRate = kind === "alcohol" ? Number(r.tax_rate) || 0 : 0;
        const lineTotal = round2(price * qty);
        subtotal += lineTotal; taxTotal += round2((lineTotal * taxRate) / 100);
        clean.push({ kind, itemId, itemName: r.name, brand: kind === "alcohol" ? r.brand ?? "" : "", bottleSize: kind === "alcohol" ? r.bottle_size ?? "" : "", price, qty, taxRate, lineTotal });
      }
      subtotal = round2(subtotal); taxTotal = round2(taxTotal);
      const grandTotal = round2(subtotal + taxTotal);
      const customerName = String(body.customer_name || "Guest").trim().slice(0, 60) || "Guest";
      const note = String(body.note || "").trim().slice(0, 280) || null;
      const publicRef = randomUUID().replace(/-/g, "");
      const now = new Date();

      await withTransaction(async (client) => {
        const cur = await peekCounter(client, "qrOrder");
        const orderNo = await commitCounter(client, "qrOrder", cur + 1);
        await client.query(
          `INSERT INTO qr_orders (public_ref, order_no, table_id, table_no, customer_name, note, status, subtotal, tax, grand_total, pushed_to_bill, created_at, updated_at, date_key, items)
           VALUES ($1,$2,$3,$4,$5,$6,'NEW',$7,$8,$9,false,$10,$10,$11,$12)`,
          [publicRef, orderNo, table.id, table.table_no, customerName, note, subtotal, taxTotal, grandTotal, now, dateKey(now, RESTAURANT_TZ), JSON.stringify(clean)],
        );
      });
      const saved = (await pool.query("SELECT * FROM qr_orders WHERE public_ref=$1", [publicRef])).rows[0];
      await broadcast("live_orders", { type: "qr_order.created", ref: publicRef }).catch((e) => console.error("broadcast failed (non-fatal)", e));
      return ok({ ...qrOrderPayload(saved), table_label: table.table_no }, 201);
    }

    // GET /orders/:ref
    if (method === "GET" && parts[0] === "orders" && parts[1]) {
      const row = (await pool.query("SELECT * FROM qr_orders WHERE public_ref=$1", [parts[1]])).rows[0];
      if (!row) return err("Order not found", 404);
      return ok({ ...qrOrderPayload(row), table_label: row.table_no, status_flow: QR_STATUSES });
    }

    // GET /tables/:token/orders
    if (method === "GET" && parts[0] === "tables" && parts[1] && parts[2] === "orders") {
      const table = await tableByToken(parts[1]);
      if (!table) return err("This table code is not valid.", 404);
      const today = dateKey(new Date(), RESTAURANT_TZ);
      const rows = (await pool.query("SELECT * FROM qr_orders WHERE table_id=$1 AND date_key=$2 ORDER BY created_at DESC", [table.id, today])).rows;
      return ok({ table_label: table.table_no, orders: rows.map(qrOrderPayload) });
    }

    return err("Not found", 404);
  } catch (e) {
    if (e instanceof ValidationError) return err(e.message, 422);
    console.error("qrApi error", e);
    return err("Something went wrong. Please try again.", 500);
  }
};
