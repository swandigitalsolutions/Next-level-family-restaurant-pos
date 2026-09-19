/**
 * Authoritative, concurrency-safe Idempotency-Key handling for
 * POST /api/website/orders — Postgres port of
 * firebase/functions/src/lib/idempotency.ts. Same contract, same outcomes
 * (claimed/resume/duplicate/in_progress/conflict), same 25h retention /
 * 90s stale-claim retake window. See WEBSITE-INTEGRATION.md.
 *
 * Mechanism (Postgres row lock replaces Firestore tx.create()):
 *  - claimIdempotencyKey runs `INSERT ... ON CONFLICT DO NOTHING` first
 *    (atomic "first writer wins" — Postgres unique-index equivalent of
 *    tx.create() failing for a second writer), then re-reads under
 *    `FOR UPDATE` to decide claimed/resume/duplicate/in_progress/conflict.
 *  - The full computed order (prices + the Razorpay provider order) is
 *    stashed in `pending_order` BEFORE the counter transaction, so a crash
 *    between the provider call and the order INSERT is resumable WITHOUT a
 *    second provider order.
 *  - `website_orders.idempotency_key` carries a UNIQUE index — the true
 *    safety net if two claims somehow both think they "won".
 *  - A scheduled Lambda (db/scripts/reap-idempotency.mjs) deletes rows older
 *    than 25h (RETAIN_MS) — the Postgres equivalent of a Firestore TTL policy.
 */
import type { PoolClient } from "pg";
import * as crypto from "crypto";
import { getPool } from "./db";

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const RETAIN_MS = 25 * 60 * 60 * 1000;
const STALE_MS = 90 * 1000;

export function requestHash(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

export type PendingOrder = Record<string, unknown>;

export type ClaimResult =
  | { outcome: "claimed" }
  | { outcome: "resume"; pendingOrder: PendingOrder }
  | { outcome: "duplicate"; orderId: string; ref: string }
  | { outcome: "in_progress" }
  | { outcome: "conflict" };

/** Must be called with the client of an already-open (SERIALIZABLE) transaction. */
export async function claimIdempotencyKey(client: PoolClient, key: string, hash: string): Promise<ClaimResult> {
  // RETURNING tells us, with no ambiguity, whether THIS statement inserted the
  // row. The previous version inferred it from "the row is less than 250ms
  // old", comparing the Lambda's clock against the database's - a few hundred
  // milliseconds of skew between them (entirely normal) either made the first
  // caller believe someone else held the claim, so a paid order was never
  // created, or made a genuinely stale claim look brand new. The database's
  // own answer does not drift.
  const inserted = await client.query(
    `INSERT INTO website_order_idempotency (key, request_hash, status, created_at)
     VALUES ($1, $2, 'pending', now())
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, hash],
  );
  const insertedByThisCall = (inserted.rowCount ?? 0) > 0;
  const res = await client.query(
    `SELECT request_hash, status, order_id, ref, pending_order, created_at
     FROM website_order_idempotency WHERE key = $1 FOR UPDATE`,
    [key],
  );
  const row = res.rows[0];
  if (!row) throw new Error("idempotency row vanished — should be unreachable");

  if (row.request_hash !== hash) return { outcome: "conflict" };
  if (row.status === "done" && row.order_id) return { outcome: "duplicate", orderId: row.order_id, ref: row.ref };
  if (row.status === "pending" && row.pending_order) return { outcome: "resume", pendingOrder: row.pending_order };

  if (insertedByThisCall) return { outcome: "claimed" };

  // Someone else's row. Only take it over once it is definitively abandoned.
  // Age is measured entirely inside the database (both `created_at` and the
  // comparison clock are the server's), so it does not depend on the Lambda's
  // clock agreeing with it.
  const stale = await client.query(
    `SELECT (now() - created_at) > make_interval(secs => $2) AS stale
     FROM website_order_idempotency WHERE key = $1`,
    [key, STALE_MS / 1000],
  );
  if (row.status === "pending" && stale.rows[0]?.stale) {
    await client.query(
      `UPDATE website_order_idempotency SET request_hash = $2, created_at = now() WHERE key = $1`,
      [key, hash],
    );
    return { outcome: "claimed" };
  }
  return { outcome: "in_progress" };
}

/** Stash the fully computed order — call OUTSIDE the claiming transaction
 * (after the Razorpay provider-order call, which must never happen inside a
 * DB transaction), using its own short autocommit statement. */
export async function stashPendingOrder(key: string, pendingOrder: PendingOrder): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE website_order_idempotency SET pending_order = $2 WHERE key = $1`,
    [key, JSON.stringify(pendingOrder)],
  );
}

export async function finalizeIdempotencyKey(client: PoolClient, key: string, orderId: string, ref: string): Promise<void> {
  await client.query(
    `UPDATE website_order_idempotency SET status = 'done', order_id = $2, ref = $3, completed_at = now() WHERE key = $1`,
    [key, orderId, ref],
  );
}

/** Only safe to call BEFORE any provider order was created for this key. */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  const pool = await getPool();
  await pool.query(`DELETE FROM website_order_idempotency WHERE key = $1 AND status = 'pending' AND pending_order IS NULL`, [key]);
}

/** Loser of a concurrent race polls briefly for the winner to finish. */
export async function awaitIdempotencyResult(key: string, timeoutMs = 8000): Promise<{ orderId: string; ref: string } | null> {
  const pool = await getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await pool.query(`SELECT status, order_id, ref FROM website_order_idempotency WHERE key = $1`, [key]);
    const row = res.rows[0];
    if (!row) return null;
    if (row.status === "done" && row.order_id) return { orderId: row.order_id, ref: row.ref };
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
