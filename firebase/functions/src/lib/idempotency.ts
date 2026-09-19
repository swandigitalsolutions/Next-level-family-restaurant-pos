/**
 * Authoritative, concurrency-safe Idempotency-Key handling for
 * POST /api/website/orders (see WEBSITE-INTEGRATION.md).
 *
 * Mechanism:
 *  - `websiteOrderIdempotency/{key}` is the cross-instance lock + result cache.
 *    `tx.create()` inside a transaction is atomic: the first writer wins, every
 *    other concurrent transaction retries, re-reads, and sees the claim.
 *  - The full computed order (prices + the Razorpay provider order) is stashed
 *    on the lock doc BEFORE the counter transaction, so a crash between the
 *    provider call and the write is resumable WITHOUT a second provider order.
 *  - The created `websiteOrders` doc also carries `idempotencyKey`, and the
 *    minting transaction refuses to create a second order for the same key
 *    (index: websiteOrders(idempotencyKey) ) — the true safety net.
 *  - Docs keep `expiresAt = createdAt + 25h` for a Firestore TTL policy
 *    (REQUIRES REAL PRODUCTION CONFIGURATION — see DEPLOY.md).
 */
import type { Firestore } from "firebase-admin/firestore";
import * as crypto from "crypto";

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const IDEMPOTENCY_COLL = "websiteOrderIdempotency";
const RETAIN_MS = 25 * 60 * 60 * 1000; // >= 24h retention
const STALE_MS = 90 * 1000; // a "pending" claim with no computed order this old = crashed instance

/** Stable hash of the logical request (same key + different body -> conflict). */
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

const ms = (v: any): number => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : 0);

/** Atomically claim `key`. Safe across concurrent Cloud Function instances. */
export async function claimIdempotencyKey(
  db: Firestore,
  key: string,
  hash: string,
): Promise<ClaimResult> {
  const ref = db.collection(IDEMPOTENCY_COLL).doc(key);
  return db.runTransaction<ClaimResult>(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data() as any;
      if (d.requestHash && d.requestHash !== hash) return { outcome: "conflict" };
      if (d.status === "done" && d.orderId) return { outcome: "duplicate", orderId: d.orderId, ref: d.ref };
      if (d.status === "pending" && d.pendingOrder) return { outcome: "resume", pendingOrder: d.pendingOrder };
      // pending, no computed order: another instance is mid-flight, or it crashed
      if (d.status === "pending" && Date.now() - ms(d.createdAt) > STALE_MS) {
        tx.set(ref, { status: "pending", requestHash: hash, createdAt: new Date(), retakenAt: new Date() }, { merge: true });
        return { outcome: "claimed" };
      }
      return { outcome: "in_progress" };
    }
    const now = new Date();
    tx.create(ref, {
      status: "pending",
      requestHash: hash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETAIN_MS),
      endpoint: "POST /api/website/orders",
    });
    return { outcome: "claimed" };
  });
}

/** Stash the fully computed order (incl. provider order) so a resume needs no re-price / no second provider order. */
export async function stashPendingOrder(db: Firestore, key: string, pendingOrder: PendingOrder): Promise<void> {
  await db.collection(IDEMPOTENCY_COLL).doc(key).set({ status: "pending", pendingOrder }, { merge: true });
}

export async function finalizeIdempotencyKey(
  db: Firestore, key: string, orderId: string, ref: string,
): Promise<void> {
  await db.collection(IDEMPOTENCY_COLL).doc(key).set(
    { status: "done", orderId, ref, completedAt: new Date() }, { merge: true },
  );
}

/** Only safe to call BEFORE any provider order was created for this key. */
export async function releaseIdempotencyKey(db: Firestore, key: string): Promise<void> {
  await db.collection(IDEMPOTENCY_COLL).doc(key).delete().catch(() => undefined);
}

/** Loser of a concurrent race waits briefly for the winner to finish. */
export async function awaitIdempotencyResult(
  db: Firestore, key: string, timeoutMs = 8000,
): Promise<{ orderId: string; ref: string } | null> {
  const ref = db.collection(IDEMPOTENCY_COLL).doc(key);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await ref.get();
    if (!snap.exists) return null;
    const d = snap.data() as any;
    if (d.status === "done" && d.orderId) return { orderId: d.orderId, ref: d.ref };
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
