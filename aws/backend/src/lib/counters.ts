/**
 * Gap-safe bill / order numbering — Postgres port of
 * firebase/functions/src/lib/counters.ts (FIRESTORE-SCHEMA.md §8, invariant I2).
 *
 * `nextNumber` MUST be called with the PoolClient of an already-open
 * transaction (see lib/db.ts withTransaction, SERIALIZABLE). `SELECT ... FOR
 * UPDATE` takes a row lock on the counter row for the lifetime of the
 * transaction — the Postgres analogue of Firestore's automatic
 * transaction-retry-on-contention: a concurrent writer blocks (not retries
 * silently), then proceeds once the first transaction commits/aborts, seeing
 * the updated value. Combined with withTransaction's 40001 retry loop, this
 * gives the same "no gaps, no duplicates, exactly-once" guarantee.
 */
import type { PoolClient } from "pg";
import { formatBillNo } from "./money";

export type CounterName = "foodBill" | "alcoholBill" | "cafeBill" | "qrOrder" | "website";

const PREFIX: Record<CounterName, string> = {
  foodBill: "FOOD",
  alcoholBill: "ALC",
  cafeBill: "CAFE",
  qrOrder: "QR",
  website: "WEB",
};
export { PREFIX as COUNTER_PREFIX };

/** Read the current value under a row lock (call during the "read phase"),
 * then call commitCounter with the value you intend to advance to. Splitting
 * these two lets a handler read other rows in between, mirroring the
 * peekCounter/commitCounter split in the Firestore version. */
export async function peekCounter(client: PoolClient, name: CounterName): Promise<number> {
  const res = await client.query<{ value: number }>(
    `SELECT value FROM counters WHERE name = $1 FOR UPDATE`,
    [name],
  );
  if (res.rowCount === 0) {
    throw new Error(`counter "${name}" is missing — run db/migrations/001_init.sql seed`);
  }
  return res.rows[0].value;
}

export async function commitCounter(client: PoolClient, name: CounterName, nextValue: number): Promise<string> {
  await client.query(
    `UPDATE counters SET value = $2, prefix = $3, updated_at = now() WHERE name = $1`,
    [name, nextValue, PREFIX[name]],
  );
  return formatBillNo(PREFIX[name], nextValue);
}

/** Convenience one-shot: lock, read, advance, commit — for handlers that mint
 * exactly one number and do nothing else with the counter row. */
export async function nextNumber(
  client: PoolClient,
  name: CounterName,
): Promise<{ number: number; formatted: string }> {
  const current = await peekCounter(client, name);
  const next = current + 1;
  const formatted = await commitCounter(client, name, next);
  return { number: next, formatted };
}
