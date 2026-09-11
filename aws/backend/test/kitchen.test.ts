import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool } from "../src/lib/db";
import { resetDb, seedTable, seedUser, fakeEvent } from "./_helpers";
import { handler as kitchenHandler } from "../src/handlers/callable/kitchen";
import { randomUUID } from "crypto";

before(async () => { await getPool(); });
beforeEach(resetDb);

async function call(action: string, body: unknown, role: string) {
  const pool = await getPool();
  const uid = await seedUser(pool, role);
  return kitchenHandler(fakeEvent({ role, action, body, uid }));
}

async function seedQrOrder(status = "NEW") {
  const pool = await getPool();
  const tableId = await seedTable(pool, "T1");
  const publicRef = randomUUID().replace(/-/g, "");
  await pool.query(
    `INSERT INTO qr_orders (public_ref, order_no, table_id, table_no, customer_name, status, subtotal, tax, grand_total, pushed_to_bill, created_at, updated_at, date_key, items)
     VALUES ($1,'QR-000001',$2,'T1','Guest',$3,100,0,100,false,now(),now(),'2026-01-01',$4)`,
    [publicRef, tableId, status, JSON.stringify([{ itemName: "Dosa", kind: "food", qty: 2 }])],
  );
  return publicRef;
}

test("orders never reach the kitchen before Billing accepts (no ticket exists until acceptOrderToKitchen)", async () => {
  await seedQrOrder("NEW");
  const pool = await getPool();
  const count = await pool.query("SELECT count(*)::int AS n FROM kitchen_tickets");
  assert.equal(count.rows[0].n, 0);
});

test("acceptOrderToKitchen (billing role): creates a QUEUED ticket, advances QR order to ACCEPTED", async () => {
  const ref = await seedQrOrder("NEW");
  const res: any = await call("acceptOrderToKitchen", { source: "qr", id: ref }, "billing");
  assert.equal(res.statusCode, 200);
  const ticket = JSON.parse(res.body);
  assert.equal(ticket.status, "QUEUED");

  const pool = await getPool();
  const order = (await pool.query("SELECT status, kitchen_ticket_id, kitchen_status FROM qr_orders WHERE public_ref=$1", [ref])).rows[0];
  assert.equal(order.status, "ACCEPTED");
  assert.equal(order.kitchen_status, "QUEUED");
  assert.ok(order.kitchen_ticket_id);
});

test("acceptOrderToKitchen is idempotent per order: a second accept returns the SAME ticket, no duplicate", async () => {
  const ref = await seedQrOrder("NEW");
  const r1: any = await call("acceptOrderToKitchen", { source: "qr", id: ref }, "billing");
  const r2: any = await call("acceptOrderToKitchen", { source: "qr", id: ref }, "billing");
  const t1 = JSON.parse(r1.body), t2 = JSON.parse(r2.body);
  assert.equal(t1.id, t2.id);
  const pool = await getPool();
  const count = await pool.query("SELECT count(*)::int AS n FROM kitchen_tickets WHERE source_id=$1", [ref]);
  assert.equal(count.rows[0].n, 1);
});

test("kitchen role cannot accept orders (billing-only action)", async () => {
  const ref = await seedQrOrder("NEW");
  const res: any = await call("acceptOrderToKitchen", { source: "qr", id: ref }, "kitchen");
  assert.equal(res.statusCode, 403);
});

test("setKitchenTicketStatus: legal FSM QUEUED->PREPARING->READY->DONE, illegal jump rejected", async () => {
  const ref = await seedQrOrder("NEW");
  const acceptRes: any = await call("acceptOrderToKitchen", { source: "qr", id: ref }, "billing");
  const ticketId = JSON.parse(acceptRes.body).id;

  const r1: any = await call("setKitchenTicketStatus", { id: ticketId, status: "PREPARING" }, "kitchen");
  assert.equal(JSON.parse(r1.body).status, "PREPARING");

  // illegal: PREPARING -> QUEUED (backwards) is not in KITCHEN_TICKET_STATUSES's legal-forward set
  const bad: any = await call("setKitchenTicketStatus", { id: ticketId, status: "QUEUED" }, "kitchen");
  assert.equal(bad.statusCode, 422);

  const r2: any = await call("setKitchenTicketStatus", { id: ticketId, status: "DONE" }, "kitchen");
  assert.equal(JSON.parse(r2.body).status, "DONE");

  const pool = await getPool();
  const order = (await pool.query("SELECT kitchen_status FROM qr_orders WHERE public_ref=$1", [ref])).rows[0];
  assert.equal(order.kitchen_status, "DONE", "status mirrors back onto the source order");
});

test("billing role (not kitchen) is forbidden from stepping ticket status", async () => {
  const ref = await seedQrOrder("NEW");
  const acceptRes: any = await call("acceptOrderToKitchen", { source: "qr", id: ref }, "billing");
  const ticketId = JSON.parse(acceptRes.body).id;
  const res: any = await call("setKitchenTicketStatus", { id: ticketId, status: "PREPARING" }, "billing");
  assert.equal(res.statusCode, 403);
});
