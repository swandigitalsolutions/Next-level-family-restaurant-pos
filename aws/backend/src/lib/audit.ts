/**
 * Audit trail writes (`audit_log` table) — Postgres port of
 * firebase/functions/src/lib/audit.ts. Same "best effort outside a
 * transaction, atomic inside one" contract. Never contains credential
 * material. `audit_log` has UPDATE/DELETE revoked from the app DB role
 * (002_privileges.sql) — append-only enforced by Postgres itself.
 */
import type { PoolClient } from "pg";
import { getPool } from "./db";
import type { Caller } from "./authz";

export interface AuditEntry {
  actorUid: string | null;
  actorUsername: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
}

export function auditFromCaller(
  caller: Caller, action: string, entityType: string,
  entityId?: string | null, details?: Record<string, unknown> | null,
): AuditEntry {
  return { actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action, entityType, entityId: entityId ?? null, details: details ?? null };
}

/** Outside a transaction — best effort, never throws (a logging failure must
 * never block the action it describes). */
export async function writeAudit(e: AuditEntry): Promise<void> {
  try {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO audit_log (actor_uid, actor_username, actor_role, action, entity_type, entity_id, details, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [e.actorUid, e.actorUsername, e.actorRole, e.action, e.entityType, e.entityId ?? null, e.details ? JSON.stringify(e.details) : null],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("audit write failed (non-fatal)", err);
  }
}

/** Inside a transaction — committed atomically with the action it describes. */
export async function auditInTx(client: PoolClient, e: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_uid, actor_username, actor_role, action, entity_type, entity_id, details, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
    [e.actorUid, e.actorUsername, e.actorRole, e.action, e.entityType, e.entityId ?? null, e.details ? JSON.stringify(e.details) : null],
  );
}
