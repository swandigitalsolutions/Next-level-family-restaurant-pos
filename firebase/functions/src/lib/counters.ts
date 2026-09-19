/**
 * Gap-safe bill / order numbering (FIRESTORE-SCHEMA.md §8, invariant I2).
 * Replaces backend/database.py next_bill_number (`UPDATE counters SET value =
 * value + 1` inside a transaction).
 *
 * `nextNumber` MUST be called inside a Firestore transaction: it reads the
 * counter, writes value+1, and returns the formatted string. Firestore retries
 * the whole transaction on contention, so every number is issued exactly once,
 * monotonically — no gaps, no duplicates.
 */
import type {
  Firestore,
  Transaction,
  DocumentReference,
} from "firebase-admin/firestore";
import { formatBillNo } from "./money";
import { COUNTER_IDS } from "./ids";

export type CounterName = keyof typeof COUNTER_IDS;

const PREFIX: Record<CounterName, string> = {
  foodBill: "FOOD",
  alcoholBill: "ALC",
  cafeBill: "CAFE",
  qrOrder: "QR",
  websiteOrder: "WEB",
};

export function counterRef(db: Firestore, name: CounterName): DocumentReference {
  return db.collection("counters").doc(COUNTER_IDS[name]);
}

/**
 * Read-modify-write the counter inside `tx` and return e.g. "FOOD-000042".
 * Throws if the counter document is missing (the seed / ETL must create it).
 */
export async function nextNumber(
  tx: Transaction,
  db: Firestore,
  name: CounterName,
): Promise<{ number: number; formatted: string }> {
  const ref = counterRef(db, name);
  const snap = await tx.get(ref);
  if (!snap.exists) {
    throw new Error(
      `counter "${name}" is missing — seed/ETL must create counters/${COUNTER_IDS[name]}`,
    );
  }
  const current = Number(snap.data()?.value) || 0;
  const next = current + 1;
  tx.set(ref, { value: next, prefix: PREFIX[name], updatedAt: new Date() }, { merge: true });
  return { number: next, formatted: formatBillNo(PREFIX[name], next) };
}

export { PREFIX as COUNTER_PREFIX };

/**
 * Decomposed form for transactions that also read other documents: call
 * `peekCounter` during the read phase, then `commitCounter` during the write
 * phase. Same gap-safe guarantee (the whole transaction retries on contention).
 */
export async function peekCounter(
  tx: Transaction,
  db: Firestore,
  name: CounterName,
): Promise<number> {
  const snap = await tx.get(counterRef(db, name));
  if (!snap.exists) {
    throw new Error(
      `counter "${name}" is missing — seed/ETL must create counters/${COUNTER_IDS[name]}`,
    );
  }
  return Number(snap.data()?.value) || 0;
}

export function commitCounter(
  tx: Transaction,
  db: Firestore,
  name: CounterName,
  nextValue: number,
): string {
  tx.set(
    counterRef(db, name),
    { value: nextValue, prefix: PREFIX[name], updatedAt: new Date() },
    { merge: true },
  );
  return formatBillNo(PREFIX[name], nextValue);
}
