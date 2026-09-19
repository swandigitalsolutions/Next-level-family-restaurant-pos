/**
 * Deterministic Firestore document ids (FIRESTORE-SCHEMA.md §Migration ID mapping).
 * Deterministic ids make the ETL idempotent (a re-run overwrites, never
 * duplicates) and let reference rewriting be pure computation — no lookup table.
 *
 * NOTE: the ETL scripts carry a byte-identical copy at scripts/lib/ids.mjs
 * (ESM, no TS toolchain there). Keep the two in sync.
 */

export type Kind = "food" | "alcohol" | "cafe";
const K = (kind: string): "food" | "alc" | "cafe" =>
  kind === "alcohol" ? "alc" : kind === "cafe" ? "cafe" : "food";

export const userId = (legacyId: number | string) => `u_${legacyId}`;
export const categoryId = (kind: string, legacyId: number | string) =>
  `cat_${K(kind)}_${legacyId}`;
export const catalogItemId = (kind: string, legacyId: number | string) =>
  `item_${K(kind)}_${legacyId}`;
export const tableId = (legacyId: number | string) => `tbl_${legacyId}`;
export const tableSessionId = (legacyId: number | string) => `sess_${legacyId}`;
export const billId = (type: string, legacyId: number | string) => {
  const t = type.toLowerCase();
  const seg = t === "alcohol" || t === "alc" ? "alc" : t === "cafe" ? "cafe" : "food";
  return `bill_${seg}_${legacyId}`;
};
export const auditId = (legacyId: number | string) => `audit_${legacyId}`;

/** counters/{name} — fixed ids (were food_bill / alcohol_bill / qr_order). */
export const COUNTER_IDS = {
  foodBill: "foodBill",
  alcoholBill: "alcoholBill",
  cafeBill: "cafeBill",
  qrOrder: "qrOrder",
  websiteOrder: "websiteOrder",
} as const;

/** Best-effort remap of an audit_log.entity_id given its entity_type. */
export function remapAuditEntity(
  entityType: string | null | undefined,
  entityId: string | null | undefined,
): string | null {
  if (entityId == null || entityId === "") return null;
  switch (entityType) {
    case "food_item":
      return catalogItemId("food", entityId);
    case "alcohol_item":
      return catalogItemId("alcohol", entityId);
    case "user":
      return userId(entityId);
    case "table_session":
      return tableSessionId(entityId);
    case "restaurant_table":
      return tableId(entityId);
    case "food_bill":
      return billId("food", entityId);
    case "alcohol_bill":
      return billId("alcohol", entityId);
    default:
      return String(entityId); // bills export / unknown — keep raw
  }
}
