/**
 * Shared constants for the POS Cloud Functions.
 * Ported from backend/app.py + backend/database.py so behaviour stays identical.
 */

/** Deploy region — Mumbai. Firestore location should match (asia-south1). */
export const REGION = "asia-south1";

/** Restaurant local timezone for "today" / hourly rollups (backend/database.py LOCAL_TZ). */
export const RESTAURANT_TZ = process.env.RESTAURANT_TZ || "Asia/Kolkata";

/** Shown on the customer QR menu + printed bills (backend/app.py RESTAURANT_NAME). */
export const RESTAURANT_NAME =
  process.env.RESTAURANT_NAME || "Next Level Family Restaurant";

/**
 * The 6 application roles.
 *   admin        — everything (incl. staff/role/password management)
 *   owner        — dashboard + audit log, strictly view-only
 *   manager      — all operations + catalog/table CRUD + reports; NOT staff mgmt, NOT audit log
 *   billing      — food/bar billing, table sessions, QR + Website order boards, receipts
 *   kitchen      — the kitchen screen only (accepted tickets)
 *   cafe_billing — the outside-cafe till only
 * Claims/records are stored lowercase. `staff`→`billing` and `cafe`→`cafe_billing`
 * are accepted as legacy aliases (normalised at every boundary).
 */
export const VALID_ROLES = ["admin", "manager", "owner", "billing", "kitchen", "cafe_billing"] as const;
export type Role = (typeof VALID_ROLES)[number];

/** Carried-over accounts / claims that used an old name. */
export const LEGACY_ROLE_ALIASES: Record<string, Role> = { staff: "billing", cafe: "cafe_billing" };

/** Map any stored/claimed role string through the alias table; unknowns pass through. */
export function normalizeRole(r: unknown): string {
  const s = String(r ?? "").trim().toLowerCase();
  return LEGACY_ROLE_ALIASES[s] ?? s;
}

/** Menu / catalog / table + QR-token management. */
export const MANAGE_ROLES: Role[] = ["admin", "manager"];
/** Restaurant billing + table sessions + QR orders board + Website orders board. */
export const BILLING_ROLES: Role[] = ["admin", "manager", "billing"];
/** Outside-cafe billing page. */
export const CAFE_ROLES: Role[] = ["admin", "manager", "cafe_billing"];
/** Kitchen screen (accepted tickets). */
export const KITCHEN_ROLES: Role[] = ["admin", "manager", "kitchen"];
/** Audit log read — admin + owner ONLY (manager is deliberately excluded). */
export const AUDIT_ROLES: Role[] = ["admin", "owner"];
/** Any operational (non-owner) login — used for catalog/name reads. */
export const OPS_ROLES: Role[] = ["admin", "manager", "billing", "cafe_billing", "kitchen"];

/** Catalog sales channel — the explicit "which till sells this" field on every
 * catalog + category doc. RESTAURANT = food/alcohol; OUTSIDE_CAFE = the cafe till. */
export type SalesChannel = "RESTAURANT" | "OUTSIDE_CAFE";
export function salesChannelForKind(kind: unknown): SalesChannel {
  return String(kind).toLowerCase() === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT";
}
/** Seeded on first setup so the cafe till has somewhere to file items. */
export const DEFAULT_CAFE_CATEGORIES = [
  "Tea", "Coffee", "Ice Creams", "Water Bottles", "Cool Drinks", "Juices", "Other",
] as const;

/** QR order status machine (backend/app.py QR_STATUSES). */
export const QR_STATUSES = [
  "NEW",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "SERVED",
  "CANCELLED",
] as const;
export type QrStatus = (typeof QR_STATUSES)[number];

/** Legal forward transitions (backend/frontend qr-orders.js NEXT_STATUS) + cancel. */
export const QR_NEXT_STATUS: Record<string, QrStatus> = {
  NEW: "ACCEPTED",
  ACCEPTED: "PREPARING",
  PREPARING: "READY",
  READY: "SERVED",
};

/** One legal step forward, or a cancel from any non-terminal state. Mirrors
 * firestore.rules legalQrTransition(). */
export function legalQrTransition(from: string, to: string): boolean {
  if (QR_NEXT_STATUS[from] === to) return true;
  return to === "CANCELLED" && ["NEW", "ACCEPTED", "PREPARING", "READY"].includes(from);
}

/** backend/app.py MAX_QR_LINE_QTY. */
export const MAX_QR_LINE_QTY = 50;

/** Safety caps for counter/session billing (fat-finger + doc-size protection).
 * The caller is an authenticated cashier, so these are sanity limits, not a
 * trust boundary. */
export const MAX_BILL_LINE_QTY = 999;
export const MAX_BILL_LINES = 200;

/** Bill-number counters + prefixes (backend/database.py _seed + next_bill_number). */
export const COUNTERS = {
  foodBill: { doc: "foodBill", prefix: "FOOD" },
  alcoholBill: { doc: "alcoholBill", prefix: "ALC" },
  cafeBill: { doc: "cafeBill", prefix: "CAFE" },
  qrOrder: { doc: "qrOrder", prefix: "QR" },
  websiteOrder: { doc: "websiteOrder", prefix: "WEB" },
} as const;

/** Catalog kinds. `cafe` = the outside-cafe menu (tea/coffee/ice cream/bottled
 * drinks); billed on its own CAFE-xxxxx series, no tax, no brand/bottle. */
export const CATALOG_KINDS = ["food", "alcohol", "cafe"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/** Kitchen ticket lifecycle (billing "accepts" an order -> QUEUED). */
export const KITCHEN_TICKET_STATUSES = ["QUEUED", "PREPARING", "READY", "DONE"] as const;
export type KitchenTicketStatus = (typeof KITCHEN_TICKET_STATUSES)[number];
const KITCHEN_TICKET_NEXT: Record<string, KitchenTicketStatus> = {
  QUEUED: "PREPARING",
  PREPARING: "READY",
  READY: "DONE",
};
export function legalKitchenTicketTransition(from: string, to: string): boolean {
  if (KITCHEN_TICKET_NEXT[from] === to) return true;
  // allow jumping straight QUEUED/PREPARING -> READY, and any -> DONE
  if (to === "READY" && ["QUEUED", "PREPARING"].includes(from)) return true;
  if (to === "DONE" && ["QUEUED", "PREPARING", "READY"].includes(from)) return true;
  return false;
}

/** Website pre-order channel (Phase 4b). Two separate state machines, exactly
 * as specified by the Website team's contract (see WEBSITE-INTEGRATION.md). */
export const WEBSITE_ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "COMPLETED",
  "CANCELLED",
  "PAYMENT_FAILED",
] as const;
export type WebsiteOrderStatus = (typeof WEBSITE_ORDER_STATUSES)[number];

export const WEBSITE_PAYMENT_STATUSES = ["UNPAID", "ADVANCE_PAID", "FAILED", "REFUNDED"] as const;
export type WebsitePaymentStatus = (typeof WEBSITE_PAYMENT_STATUSES)[number];

const WEBSITE_ORDER_NEXT: Record<string, WebsiteOrderStatus> = {
  CONFIRMED: "PREPARING",
  PREPARING: "READY",
};
/** Staff may step status one place forward (CONFIRMED→PREPARING→READY) or CANCEL a
 * live order. PENDING_PAYMENT→CONFIRMED / →PAYMENT_FAILED happen ONLY in the
 * Razorpay webhook; COMPLETED happens ONLY in settleWebsiteOrder. */
export function legalWebsiteOrderTransition(from: string, to: string): boolean {
  if (WEBSITE_ORDER_NEXT[from] === to) return true;
  return to === "CANCELLED" && ["CONFIRMED", "PREPARING", "READY"].includes(from);
}

/** Advance = half the total (goods + tax), rounded to whole paise. */
export const ADVANCE_RATE = 0.5;

/** Login throttle (backend/app.py LOGIN_MAX_ATTEMPTS / LOGIN_LOCKOUT_SECONDS). */
export const LOGIN_MAX_ATTEMPTS = 6;
export const LOGIN_LOCKOUT_SECONDS = 5 * 60;

/** Default sample GSTIN printed on receipts (frontend/js/common.js RESTAURANT_GSTIN). */
export const RESTAURANT_GSTIN = process.env.RESTAURANT_GSTIN || "22AAAAA0000A1Z5";
