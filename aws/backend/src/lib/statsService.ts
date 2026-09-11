/**
 * Dashboard rollups — Postgres port of firebase/functions/src/triggers/stats.ts,
 * DELIBERATELY SIMPLER than the Firestore version: Firestore couldn't afford a
 * live aggregate query (read pricing), so it maintained an incrementally-
 * folded `stats/daily/entries` cache with explicit at-least-once-delivery
 * dedup (`billIds`). Postgres can run the equivalent GROUP BY directly against
 * the indexed `bills` table in milliseconds at single-restaurant scale, so
 * there is no cache to keep consistent and therefore no double-count class of
 * bug to guard against — a genuine simplification, not a feature cut. Same
 * output contract (`rolling` shape) as the Firestore version; same fields
 * the dashboard already renders.
 *
 * Call `computeRolling()` after every bill-writing transaction commits (same
 * call site as `onBillWrite` triggered before) and on-demand from the
 * dashboard GET endpoint.
 */
import { getPool } from "./db";
import { dateKey, round2 } from "./money";
import { RESTAURANT_TZ } from "./config";

function dayKeyOffset(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return dateKey(d, RESTAURANT_TZ);
}
function weekdayLabel(key: string): string {
  const d = new Date(key + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(d).toUpperCase();
}

export async function computeRolling() {
  const pool = await getPool();
  const today = dateKey(new Date(), RESTAURANT_TZ);
  const since = dayKeyOffset(29);

  const [todayRow, dailyRows, mixRows, hourlyRows, itemRows, menuCounts, recentRows] = await Promise.all([
    pool.query(
      `SELECT type, count(*)::int AS n, coalesce(sum(grand_total),0) AS total
       FROM bills WHERE date_key = $1 GROUP BY type`,
      [today],
    ),
    pool.query(
      `SELECT date_key, type, count(*)::int AS n, coalesce(sum(grand_total),0) AS total
       FROM bills WHERE date_key >= $1 GROUP BY date_key, type`,
      [since],
    ),
    pool.query(
      `SELECT payment_method, count(*)::int AS n, coalesce(sum(grand_total),0) AS total
       FROM bills WHERE date_key >= $1 GROUP BY payment_method ORDER BY total DESC`,
      [since],
    ),
    pool.query(
      `SELECT hour, count(*)::int AS n, coalesce(sum(grand_total),0) AS total
       FROM bills WHERE date_key >= $1 GROUP BY hour ORDER BY hour`,
      [since],
    ),
    pool.query(
      `SELECT item->>'itemName' AS name, sum((item->>'qty')::numeric)::numeric AS qty, sum((item->>'lineTotal')::numeric) AS total
       FROM bills, jsonb_array_elements(items) AS item
       WHERE date_key >= $1
       GROUP BY item->>'itemName'
       ORDER BY qty DESC, total DESC
       LIMIT 6`,
      [since],
    ),
    pool.query(`
      SELECT
        (SELECT count(*) FROM catalog WHERE kind='food' AND status='active')::int AS food_items,
        (SELECT count(*) FROM catalog WHERE kind='alcohol' AND status='active')::int AS alcohol_items,
        (SELECT count(*) FROM catalog WHERE kind='cafe' AND status='active')::int AS cafe_items,
        (SELECT count(*) FROM categories WHERE kind='food' AND status='active')::int AS food_categories,
        (SELECT count(*) FROM categories WHERE kind='alcohol' AND status='active')::int AS alcohol_categories,
        (SELECT count(*) FROM categories WHERE kind='cafe' AND status='active')::int AS cafe_categories
    `),
    pool.query(`SELECT id, bill_no, customer_name, grand_total, payment_method, created_at, type FROM bills ORDER BY created_at DESC LIMIT 6`),
  ]);

  const byType = (rows: any[], t: string) => rows.find((r) => r.type === t);
  const tFood = byType(todayRow.rows, "FOOD"), tAlc = byType(todayRow.rows, "ALCOHOL"), tCafe = byType(todayRow.rows, "CAFE");
  const todayBlock = {
    foodSales: round2(Number(tFood?.total || 0)),
    alcoholSales: round2(Number(tAlc?.total || 0)),
    cafeSales: round2(Number(tCafe?.total || 0)),
    totalSales: round2(Number(tFood?.total || 0) + Number(tAlc?.total || 0) + Number(tCafe?.total || 0)),
    foodBills: Number(tFood?.n || 0),
    alcoholBills: Number(tAlc?.n || 0),
    cafeBills: Number(tCafe?.n || 0),
    totalBills: Number(tFood?.n || 0) + Number(tAlc?.n || 0) + Number(tCafe?.n || 0),
  };

  const byDay = new Map<string, { total: number; orders: number }>();
  for (const r of dailyRows.rows) {
    const cur = byDay.get(r.date_key) || { total: 0, orders: 0 };
    cur.total = round2(cur.total + Number(r.total));
    cur.orders += Number(r.n);
    byDay.set(r.date_key, cur);
  }
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayKeyOffset(i);
    const e = byDay.get(k) || { total: 0, orders: 0 };
    trend.push({ day: k, label: weekdayLabel(k), total: e.total, orders: e.orders });
  }

  const paymentMix = mixRows.rows.map((r) => ({ method: r.payment_method, total: round2(Number(r.total)), orders: Number(r.n) }));
  const hourlyFlow = hourlyRows.rows.map((r) => ({ hour: Number(r.hour), orders: Number(r.n), total: round2(Number(r.total)) }));
  const topItems = itemRows.rows.map((r) => ({ name: r.name, qty: Number(r.qty), total: round2(Number(r.total)) }));
  const m = menuCounts.rows[0];
  const recentOrders = recentRows.rows.map((r) => ({
    id: r.id, bill_no: r.bill_no, customer_name: r.customer_name, grand_total: round2(Number(r.grand_total)),
    payment_method: r.payment_method, created_at: new Date(r.created_at).toISOString(), type: r.type,
  }));

  const rolling = {
    today: todayBlock,
    trend,
    paymentMix,
    topItems,
    hourlyFlow,
    menuSummary: {
      foodItems: m.food_items, alcoholItems: m.alcohol_items, cafeItems: m.cafe_items,
      foodCategories: m.food_categories, alcoholCategories: m.alcohol_categories, cafeCategories: m.cafe_categories,
    },
    recentOrders,
    updatedAt: new Date().toISOString(),
  };
  await pool.query(
    `UPDATE stats_rolling SET today=$1, trend=$2, payment_mix=$3, top_items=$4, hourly_flow=$5, menu_summary=$6, updated_at=now() WHERE id='rolling'`,
    [JSON.stringify(todayBlock), JSON.stringify(trend), JSON.stringify(paymentMix), JSON.stringify(topItems), JSON.stringify(hourlyFlow),
     JSON.stringify({ ...rolling.menuSummary })],
  );
  return rolling;
}

/** Admin-only: recompute is a no-op distinct function here (computeRolling IS
 * a full recompute, unlike the Firestore version's separate rebuild path) —
 * kept as a named export so the callable handler reads the same either way. */
export const rebuildAllStats = computeRolling;
