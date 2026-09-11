import "./_env";
import { randomUUID } from "crypto";
import { getPool } from "../src/lib/db";

/** Build a minimal fake API Gateway v2 event with JWT claims, matching what
 * the real Cognito authorizer attaches at
 * event.requestContext.authorizer.jwt.claims (see lib/authz.ts). */
export function fakeEvent(opts: { role?: string; uid?: string; username?: string; body?: unknown; action?: string; headers?: Record<string, string> } = {}): any {
  const uid = opts.uid || "u_test_" + randomUUID().slice(0, 8);
  return {
    headers: opts.headers || {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    isBase64Encoded: false,
    pathParameters: opts.action ? { action: opts.action } : undefined,
    requestContext: {
      http: { method: "POST", sourceIp: "127.0.0.1" },
      authorizer: opts.role
        ? { jwt: { claims: { sub: uid, "custom:pos_uid": uid, "custom:role": opts.role, "cognito:username": opts.username || "test" } } }
        : undefined,
    },
    rawPath: "/api/test",
  };
}

export async function resetDb(): Promise<void> {
  const pool = await getPool();
  await pool.query(`
    TRUNCATE bills, kitchen_tickets, qr_orders, website_orders, website_order_idempotency, website_payments,
      table_sessions, restaurant_tables, catalog, categories, audit_log, auth_throttle, users, user_credentials
    RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE counters SET value = 0`);
}

export async function seedCategory(pool: Awaited<ReturnType<typeof getPool>>, kind: "food" | "alcohol" | "cafe", name = "Mains"): Promise<string> {
  const id = "cat_" + randomUUID();
  await pool.query(
    `INSERT INTO categories (id, kind, sales_channel, name, name_lower, sort_order, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,0,'active',now(),now())`,
    [id, kind, kind === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT", name, name.toLowerCase()],
  );
  return id;
}

export async function seedItem(pool: Awaited<ReturnType<typeof getPool>>, opts: { kind: "food" | "alcohol" | "cafe"; categoryId: string; name: string; price: number; taxRate?: number; stockQty?: number | null }): Promise<string> {
  const id = "item_" + randomUUID();
  await pool.query(
    `INSERT INTO catalog (id, kind, sales_channel, name, name_lower, category_id, category_name, category_sort, price, tax_rate, stock_qty, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'x',0,$7,$8,$9,'active',now(),now())`,
    [id, opts.kind, opts.kind === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT", opts.name, opts.name.toLowerCase(), opts.categoryId, opts.price, opts.taxRate ?? 0, opts.stockQty ?? null],
  );
  return id;
}

/** Seed a real `users` row and return its uid — required before any test
 * exercises a write path that stamps created_by_uid/opened_by_uid/
 * accepted_by_uid (all FK-constrained to users.uid, same as production: the
 * uid always comes from a real Postgres users row via the preTokenGeneration
 * claim — see aws/backend/src/handlers/triggers/preTokenGeneration.ts). */
export async function seedUser(pool: Awaited<ReturnType<typeof getPool>>, role: string, username?: string): Promise<string> {
  const uid = "u_" + randomUUID();
  const uname = username || `${role}_${uid.slice(2, 8)}`;
  await pool.query(
    `INSERT INTO users (uid, username, username_lower, full_name, phone, role, status, created_at, updated_at)
     VALUES ($1,$2,$2,$3,'',$4,'active',now(),now())`,
    [uid, uname, uname, role],
  );
  return uid;
}

export async function seedTable(pool: Awaited<ReturnType<typeof getPool>>, tableNo: string): Promise<string> {
  const id = "tbl_" + randomUUID();
  await pool.query(`INSERT INTO restaurant_tables (id, table_no, seats, status, qr_token, created_at, updated_at) VALUES ($1,$2,4,'available',$3,now(),now())`, [id, tableNo, randomUUID()]);
  return id;
}
