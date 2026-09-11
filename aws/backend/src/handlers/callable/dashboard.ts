/**
 * Dashboard rollups — Lambda port of the read/rebuild surface from
 * firebase/functions/src/triggers/stats.ts. The Firestore version let the
 * frontend `getDoc(stats/rolling)` directly; Postgres has no client-readable
 * surface, so `getRollingStats` is the read endpoint every ops role can call
 * (mirrors Firestore rules: staff/owner readable). `rebuildStats` stays
 * admin-only, for after a data migration or to force a resync.
 */
import { dispatch } from "../../lib/callable";
import { assertRole } from "../../lib/authz";
import { OPS_ROLES } from "../../lib/config";
import { getPool } from "../../lib/db";
import { computeRolling } from "../../lib/statsService";

export const handler = dispatch({
  async getRollingStats(_body, event) {
    // owner (view-only dashboard access) + every operational role.
    assertRole(event as any, [...OPS_ROLES, "owner"] as any);
    const pool = await getPool();
    const res = await pool.query("SELECT * FROM stats_rolling WHERE id='rolling'");
    const row = res.rows[0];
    if (!row) return computeRolling();
    return { today: row.today, trend: row.trend, paymentMix: row.payment_mix, topItems: row.top_items, hourlyFlow: row.hourly_flow, menuSummary: row.menu_summary, updatedAt: row.updated_at };
  },

  async rebuildStats(_body, event) {
    assertRole(event as any, ["admin"]);
    const rolling = await computeRolling();
    return { ok: true, updatedAt: rolling.updatedAt };
  },
});
