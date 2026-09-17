// Deterministic Firestore doc ids — byte-identical logic to
// firebase/functions/src/lib/ids.ts. Keep the two in sync.

const K = (kind) => (kind === "alcohol" ? "alc" : kind === "cafe" ? "cafe" : "food");

export const userId = (legacyId) => `u_${legacyId}`;
export const categoryId = (kind, legacyId) => `cat_${K(kind)}_${legacyId}`;
export const catalogItemId = (kind, legacyId) => `item_${K(kind)}_${legacyId}`;
export const tableId = (legacyId) => `tbl_${legacyId}`;
export const tableSessionId = (legacyId) => `sess_${legacyId}`;
export const billId = (type, legacyId) => {
  const t = String(type).toLowerCase();
  const seg = t === "alcohol" || t === "alc" ? "alc" : t === "cafe" ? "cafe" : "food";
  return `bill_${seg}_${legacyId}`;
};
export const auditId = (legacyId) => `audit_${legacyId}`;

export const COUNTER_IDS = { foodBill: "foodBill", alcoholBill: "alcoholBill", cafeBill: "cafeBill", qrOrder: "qrOrder" };

export function remapAuditEntity(entityType, entityId) {
  if (entityId == null || entityId === "") return null;
  switch (entityType) {
    case "food_item": return catalogItemId("food", entityId);
    case "alcohol_item": return catalogItemId("alcohol", entityId);
    case "user": return userId(entityId);
    case "table_session": return tableSessionId(entityId);
    case "restaurant_table": return tableId(entityId);
    case "food_bill": return billId("food", entityId);
    case "alcohol_bill": return billId("alcohol", entityId);
    default: return String(entityId);
  }
}
