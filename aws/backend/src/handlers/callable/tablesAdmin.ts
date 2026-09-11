/**
 * Dining-table management — Lambda port of
 * firebase/functions/src/callable/tablesAdmin.ts. admin/manager only. Only
 * qr.regenerate is audited (matches the Firebase version).
 */
import * as crypto from "crypto";
import { randomUUID } from "crypto";
import { dispatch } from "../../lib/callable";
import { HttpError, assertManager } from "../../lib/authz";
import { toPositiveInt } from "../../lib/money";
import { writeAudit } from "../../lib/audit";
import { getPool } from "../../lib/db";

const qrToken = () => crypto.randomBytes(12).toString("base64url");

export const handler = dispatch({
  async createTable(body, event) {
    assertManager(event as any);
    const pool = await getPool();
    const tableNo = String(body?.table_no ?? "").trim();
    if (!tableNo) throw new HttpError(422, "invalid-argument", "Table name or number is required");
    const seats = toPositiveInt(body?.seats ?? 4, "seats");
    const dup = await pool.query("SELECT 1 FROM restaurant_tables WHERE table_no=$1 LIMIT 1", [tableNo]);
    if (dup.rowCount) throw new HttpError(409, "already-exists", `Could not add table: ${tableNo} already exists`);
    const id = "tbl_" + randomUUID();
    const token = qrToken();
    await pool.query(
      `INSERT INTO restaurant_tables (id, table_no, seats, status, qr_token, created_at, updated_at)
       VALUES ($1,$2,$3,'available',$4,now(),now())`,
      [id, tableNo, seats, token],
    );
    return { id, table_no: tableNo, seats, status: "available", qr_token: token };
  },

  async updateTable(body, event) {
    assertManager(event as any);
    const pool = await getPool();
    const id = String(body?.id ?? "");
    if (!id) throw new HttpError(422, "invalid-argument", "id is required");
    const cur = await pool.query("SELECT * FROM restaurant_tables WHERE id=$1", [id]);
    if (!cur.rowCount) throw new HttpError(404, "not-found", "Table not found");
    const c = cur.rows[0];
    const tableNo = body?.table_no != null ? String(body.table_no).trim() : c.table_no;
    const seats = toPositiveInt(body?.seats ?? c.seats, "seats");
    if (tableNo !== c.table_no) {
      const dup = await pool.query("SELECT 1 FROM restaurant_tables WHERE table_no=$1 LIMIT 1", [tableNo]);
      if (dup.rowCount) throw new HttpError(409, "already-exists", "A table with this name already exists");
    }
    await pool.query("UPDATE restaurant_tables SET table_no=$2, seats=$3, updated_at=now() WHERE id=$1", [id, tableNo, seats]);
    return { id, table_no: tableNo, seats };
  },

  async regenerateQrToken(body, event) {
    const caller = assertManager(event as any);
    const pool = await getPool();
    const id = String(body?.id ?? "");
    if (!id) throw new HttpError(422, "invalid-argument", "id is required");
    const cur = await pool.query("SELECT table_no FROM restaurant_tables WHERE id=$1", [id]);
    if (!cur.rowCount) throw new HttpError(404, "not-found", "Table not found");
    const newToken = qrToken();
    await pool.query("UPDATE restaurant_tables SET qr_token=$2, updated_at=now() WHERE id=$1", [id, newToken]);
    await writeAudit({ actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action: "qr.regenerate", entityType: "restaurant_table", entityId: id, details: { table_no: cur.rows[0].table_no } });
    return { id, qr_token: newToken };
  },
});
