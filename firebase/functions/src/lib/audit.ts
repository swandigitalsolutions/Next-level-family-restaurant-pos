/**
 * Audit trail writes (auditLog collection, FIRESTORE-SCHEMA.md §10).
 * Mirrors backend/app.py log_audit — best effort outside a transaction, atomic
 * inside one. Never contains credential material.
 *
 * Flask audits exactly these actions and nothing else:
 *   staff.create / staff.update / staff.deactivate
 *   menu.item.create / menu.item.price_change / menu.item.delete
 *   bill.create / table.settle / qr.regenerate / report.export
 * Category CRUD, table CRUD, openTable, QR status/push are NOT audited.
 */
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { db as getDb } from "./adminSdk";
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
  caller: Caller,
  action: string,
  entityType: string,
  entityId?: string | null,
  details?: Record<string, unknown> | null,
): AuditEntry {
  return {
    actorUid: caller.uid,
    actorUsername: caller.username || null,
    actorRole: caller.role,
    action,
    entityType,
    entityId: entityId ?? null,
    details: details ?? null,
  };
}

function toDoc(e: AuditEntry) {
  return {
    actorUid: e.actorUid ?? null,
    actorUsername: e.actorUsername ?? null,
    actorRole: e.actorRole ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    details: e.details ?? null,
    createdAt: new Date(),
  };
}

/** Outside a transaction — best effort, never throws. */
export async function writeAudit(e: AuditEntry): Promise<void> {
  try {
    await getDb().collection("auditLog").add(toDoc(e));
  } catch {
    /* a logging failure must not block the action it describes */
  }
}

/** Inside a transaction — committed atomically with the action. */
export function auditInTx(tx: Transaction, db: Firestore, e: AuditEntry): void {
  tx.set(db.collection("auditLog").doc(), toDoc(e));
}
