/**
 * Dashboard rollups — replaces the 6 live aggregate queries in Flask
 * GET /api/dashboard. `onBillWrite` maintains stats/daily/entries/{dateKey} and
 * rebuilds stats/rolling on every new bill; `rebuildStats` (admin) recomputes
 * everything from scratch (needed after the ETL, which does not fire triggers).
 *
 * stats/rolling matches the Flask /api/dashboard payload field-for-field:
 *   food_sales_today / alcohol_sales_today / total_sales_today / *_bills_today
 *   trend (7d), payment_mix (30d), top_items (30d, 6), hourly_flow (30d),
 *   recent_orders (6), menu_summary.
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onCall, CallableRequest } from "firebase-functions/v2/https";
import { REGION, RESTAURANT_TZ } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { assertAdmin } from "../lib/authz";
import { dateKey } from "../lib/money";

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const asDate = (v: any): Date =>
  v?.toDate ? v.toDate() : v instanceof Date ? v : new Date(v || 0);

function dayKeyOffset(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return dateKey(d, RESTAURANT_TZ);
}
function weekdayLabel(key: string): string {
  const d = new Date(key + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" })
    .format(d)
    .toUpperCase();
}

// ------------------------------------------- daily entry accumulation

interface DailyEntry {
  dateKey: string;
  foodSales: number;
  alcoholSales: number;
  cafeSales: number;
  foodBills: number;
  alcoholBills: number;
  cafeBills: number;
  /** Bill ids already folded into this entry — makes the fold IDEMPOTENT.
   * Cloud Functions delivers events at-least-once, so `onBillWrite` can fire
   * twice for one bill; without this the day's revenue would double-count. */
  billIds: string[];
  paymentMix: Record<string, { total: number; orders: number }>;
  hourly: Record<string, { total: number; orders: number }>;
  items: Record<string, { qty: number; total: number }>;
}

function emptyEntry(dk: string): DailyEntry {
  return { dateKey: dk, foodSales: 0, alcoholSales: 0, cafeSales: 0, foodBills: 0, alcoholBills: 0, cafeBills: 0, billIds: [], paymentMix: {}, hourly: {}, items: {} };
}

/** Fold one bill in. Returns false (and changes nothing) if already counted. */
function foldBill(e: DailyEntry, bill: any, billId?: string): boolean {
  if (!Array.isArray(e.billIds)) e.billIds = [];
  if (billId) {
    if (e.billIds.includes(billId)) return false; // already counted — no-op
    e.billIds.push(billId);
  }
  const gt = Number(bill.grandTotal) || 0;
  if (bill.type === "FOOD") {
    e.foodSales = r2(e.foodSales + gt);
    e.foodBills += 1;
  } else if (bill.type === "CAFE") {
    e.cafeSales = r2((e.cafeSales || 0) + gt);
    e.cafeBills = (e.cafeBills || 0) + 1;
  } else {
    e.alcoholSales = r2(e.alcoholSales + gt);
    e.alcoholBills += 1;
  }
  const pm = String(bill.paymentMethod || "Cash");
  e.paymentMix[pm] = e.paymentMix[pm] || { total: 0, orders: 0 };
  e.paymentMix[pm].total = r2(e.paymentMix[pm].total + gt);
  e.paymentMix[pm].orders += 1;

  const hr = String(Number(bill.hour) || 0);
  e.hourly[hr] = e.hourly[hr] || { total: 0, orders: 0 };
  e.hourly[hr].total = r2(e.hourly[hr].total + gt);
  e.hourly[hr].orders += 1;

  for (const line of bill.items || []) {
    const n = String(line.itemName);
    e.items[n] = e.items[n] || { qty: 0, total: 0 };
    e.items[n].qty += Number(line.qty) || 0;
    e.items[n].total = r2(e.items[n].total + (Number(line.lineTotal) || 0));
  }
  return true;
}

/** Idempotent per billId: a re-delivered trigger event is a no-op. Exported for tests. */
export async function applyBillToDaily(billDateKey: string, billId: string, bill: any): Promise<boolean> {
  const db = getDb();
  const ref = db.collection("stats").doc("daily").collection("entries").doc(billDateKey);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const entry = snap.exists ? (snap.data() as DailyEntry) : emptyEntry(billDateKey);
    if (!foldBill(entry, bill, billId)) return false; // already counted
    tx.set(ref, entry);
    return true;
  });
}

// ------------------------------------------- rolling recompute

export async function computeRolling(entriesOverride?: DailyEntry[]) {
  const db = getDb();
  const since = dayKeyOffset(29);
  // When the caller already has the freshly-computed entries in memory
  // (rebuildAllStats), use them directly — avoids a read-after-write race.
  const entries =
    entriesOverride ??
    (await db
      .collection("stats")
      .doc("daily")
      .collection("entries")
      .where("dateKey", ">=", since)
      .orderBy("dateKey")
      .get()
    ).docs.map((d) => d.data() as DailyEntry);
  const byDay = new Map(entries.map((e) => [e.dateKey, e]));

  const today = dateKey(new Date(), RESTAURANT_TZ);
  const te = byDay.get(today) || emptyEntry(today);
  const todayBlock = {
    foodSales: r2(te.foodSales),
    alcoholSales: r2(te.alcoholSales),
    cafeSales: r2(te.cafeSales || 0),
    totalSales: r2(te.foodSales + te.alcoholSales + (te.cafeSales || 0)),
    foodBills: te.foodBills,
    alcoholBills: te.alcoholBills,
    cafeBills: te.cafeBills || 0,
    totalBills: te.foodBills + te.alcoholBills + (te.cafeBills || 0),
  };

  const trend: Array<{ day: string; label: string; total: number; orders: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayKeyOffset(i);
    const e = byDay.get(k) || emptyEntry(k);
    trend.push({
      day: k,
      label: weekdayLabel(k),
      total: r2(e.foodSales + e.alcoholSales + (e.cafeSales || 0)),
      orders: e.foodBills + e.alcoholBills + (e.cafeBills || 0),
    });
  }

  const mix: Record<string, { total: number; orders: number }> = {};
  const hourly: Record<string, { total: number; orders: number }> = {};
  const items: Record<string, { qty: number; total: number }> = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.paymentMix || {})) {
      mix[k] = mix[k] || { total: 0, orders: 0 };
      mix[k].total = r2(mix[k].total + v.total);
      mix[k].orders += v.orders;
    }
    for (const [k, v] of Object.entries(e.hourly || {})) {
      hourly[k] = hourly[k] || { total: 0, orders: 0 };
      hourly[k].total = r2(hourly[k].total + v.total);
      hourly[k].orders += v.orders;
    }
    for (const [k, v] of Object.entries(e.items || {})) {
      items[k] = items[k] || { qty: 0, total: 0 };
      items[k].qty += v.qty;
      items[k].total = r2(items[k].total + v.total);
    }
  }

  const paymentMix = Object.entries(mix)
    .map(([method, v]) => ({ method, total: r2(v.total), orders: v.orders }))
    .sort((a, b) => b.total - a.total);
  const topItems = Object.entries(items)
    .map(([name, v]) => ({ name, qty: v.qty, total: r2(v.total) }))
    .sort((a, b) => b.qty - a.qty || b.total - a.total)
    .slice(0, 6);
  const hourlyFlow = Object.entries(hourly)
    .map(([hour, v]) => ({ hour: Number(hour), orders: v.orders, total: r2(v.total) }))
    .sort((a, b) => a.hour - b.hour);

  const [fi, ai, ci, fc, ac, cc, recentSnap] = await Promise.all([
    db.collection("catalog").where("kind", "==", "food").where("status", "==", "active").count().get(),
    db.collection("catalog").where("kind", "==", "alcohol").where("status", "==", "active").count().get(),
    db.collection("catalog").where("kind", "==", "cafe").where("status", "==", "active").count().get(),
    db.collection("categories").where("kind", "==", "food").where("status", "==", "active").count().get(),
    db.collection("categories").where("kind", "==", "alcohol").where("status", "==", "active").count().get(),
    db.collection("categories").where("kind", "==", "cafe").where("status", "==", "active").count().get(),
    db.collection("bills").orderBy("createdAt", "desc").limit(6).get(),
  ]);

  const recentOrders = recentSnap.docs.map((d) => {
    const b: any = d.data();
    return {
      id: d.id,
      bill_no: b.billNo,
      customer_name: b.customerName,
      grand_total: r2(Number(b.grandTotal)),
      payment_method: b.paymentMethod,
      created_at: asDate(b.createdAt).toISOString(),
      type: b.type,
    };
  });

  const rolling = {
    today: todayBlock,
    trend,
    paymentMix,
    topItems,
    hourlyFlow,
    menuSummary: {
      foodItems: fi.data().count,
      alcoholItems: ai.data().count,
      cafeItems: ci.data().count,
      foodCategories: fc.data().count,
      alcoholCategories: ac.data().count,
      cafeCategories: cc.data().count,
    },
    recentOrders,
    updatedAt: new Date(),
  };
  await db.collection("stats").doc("rolling").set(rolling);
  return rolling;
}

export async function rebuildAllStats() {
  const db = getDb();
  // wipe daily entries + re-fold every bill
  const existing = await db.collection("stats").doc("daily").collection("entries").get();
  await Promise.all(existing.docs.map((d) => d.ref.delete()));

  const bills = await db.collection("bills").get();
  const perDay = new Map<string, DailyEntry>();
  for (const d of bills.docs) {
    const b: any = d.data();
    const dk = b.dateKey || dateKey(asDate(b.createdAt), RESTAURANT_TZ);
    if (!perDay.has(dk)) perDay.set(dk, emptyEntry(dk));
    foldBill(perDay.get(dk)!, b, d.id);
  }
  const writer = db.bulkWriter();
  for (const [dk, entry] of perDay) {
    writer.set(db.collection("stats").doc("daily").collection("entries").doc(dk), entry);
  }
  await writer.close();
  // pass the in-memory entries straight through — no read-after-write.
  return computeRolling([...perDay.values()]);
}

// ------------------------------------------------------------------- exports

export const onBillWrite = onDocumentWritten(
  { region: REGION, document: "bills/{billId}" },
  async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!after?.exists) return; // deletes never happen for bills
    if (before?.exists) return; // bills are immutable — only act on create
    const bill: any = after.data();
    const dk = bill.dateKey || dateKey(asDate(bill.createdAt), RESTAURANT_TZ);
    // at-least-once delivery: skip the rolling recompute if this bill was
    // already folded in by an earlier delivery of the same event.
    const applied = await applyBillToDaily(dk, after.id, bill);
    if (applied) await computeRolling();
  },
);

export async function handleRebuildStats(req: CallableRequest<unknown>) {
  assertAdmin(req);
  const rolling = await rebuildAllStats();
  return { ok: true, updatedAt: rolling.updatedAt };
}

export const rebuildStats = onCall({ region: REGION }, handleRebuildStats);
