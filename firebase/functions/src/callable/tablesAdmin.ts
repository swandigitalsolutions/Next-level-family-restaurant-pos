/**
 * Dining-table management — replaces Flask
 *   POST /api/tables, PUT /api/tables/<id>
 *   POST /api/qr-ordering/tables/<id>/regenerate-qr
 * admin/manager only. Only qr.regenerate is audited (matches Flask).
 */
import * as crypto from "crypto";
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { REGION } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { assertManager } from "../lib/authz";
import { toPositiveInt } from "../lib/money";
import { writeAudit } from "../lib/audit";
import { callable } from "../lib/wrap";

/** ~ secrets.token_urlsafe(12) — 12 random bytes, URL-safe base64 (16 chars). */
const qrToken = () => crypto.randomBytes(12).toString("base64url");

export interface CreateTableInput {
  table_no?: unknown;
  seats?: unknown;
}

export async function handleCreateTable(req: CallableRequest<CreateTableInput>) {
  assertManager(req);
  const db = getDb();
  const tableNo = String(req.data?.table_no ?? "").trim();
  if (!tableNo) throw new HttpsError("invalid-argument", "Table name or number is required");
  const seats = toPositiveInt(req.data?.seats ?? 4, "seats");

  const dup = await db.collection("tables").where("tableNo", "==", tableNo).limit(1).get();
  if (!dup.empty) throw new HttpsError("already-exists", `Could not add table: ${tableNo} already exists`);

  const ref = db.collection("tables").doc();
  const now = new Date();
  const data = {
    tableNo,
    seats,
    status: "available" as const,
    qrToken: qrToken(),
    openSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(data);
  return { id: ref.id, ...data };
}

export interface UpdateTableInput {
  id?: unknown;
  table_no?: unknown;
  seats?: unknown;
}

export async function handleUpdateTable(req: CallableRequest<UpdateTableInput>) {
  assertManager(req);
  const db = getDb();
  const id = String(req.data?.id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "id is required");
  const ref = db.collection("tables").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Table not found");
  const cur = snap.data()!;

  const tableNo = req.data?.table_no != null ? String(req.data.table_no).trim() : cur.tableNo;
  const seats = toPositiveInt(req.data?.seats ?? cur.seats, "seats");
  if (tableNo !== cur.tableNo) {
    const dup = await db.collection("tables").where("tableNo", "==", tableNo).limit(1).get();
    if (!dup.empty) throw new HttpsError("already-exists", "A table with this name already exists");
  }
  const patch = { tableNo, seats, updatedAt: new Date() };
  await ref.set(patch, { merge: true });
  return { id, ...cur, ...patch };
}

export interface RegenerateQrInput {
  id?: unknown;
}

export async function handleRegenerateQrToken(req: CallableRequest<RegenerateQrInput>) {
  const caller = assertManager(req);
  const db = getDb();
  const id = String(req.data?.id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "id is required");
  const ref = db.collection("tables").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Table not found");

  const newToken = qrToken();
  await ref.set({ qrToken: newToken, updatedAt: new Date() }, { merge: true });
  await writeAudit({
    actorUid: caller.uid,
    actorUsername: caller.username || null,
    actorRole: caller.role,
    action: "qr.regenerate",
    entityType: "restaurant_table",
    entityId: id,
    details: { table_no: snap.data()?.tableNo },
  });
  return { id, qr_token: newToken };
}

export const createTable = onCall({ region: REGION }, callable(handleCreateTable));
export const updateTable = onCall({ region: REGION }, callable(handleUpdateTable));
export const regenerateQrToken = onCall({ region: REGION }, callable(handleRegenerateQrToken));
