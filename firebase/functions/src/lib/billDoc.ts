/**
 * Pure builder for a `bills` document (FIRESTORE-SCHEMA.md §7). Shared by the
 * Phase 4 createBill / settleTable Functions and mirrored by the ETL. Keeping it
 * pure lets the schema shape be unit-tested directly.
 */
import { lower, searchTokens } from "./normalize";
import { dateKey, hourOf } from "./money";
import { RESTAURANT_TZ } from "./config";

export interface FoodBillLine {
  itemName: string;
  price: number;
  qty: number;
  lineTotal: number;
}
export interface AlcoholBillLine extends FoodBillLine {
  brand: string;
  bottleSize: string;
  taxRate: number;
}

export interface BuildBillInput {
  billNo: string;
  type: "FOOD" | "ALCOHOL" | "CAFE";
  source?: "counter" | "table" | "website" | "cafe" | null;
  tableId?: string | null;
  tableSessionId?: string | null;
  websiteOrderId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  grandTotal: number;
  paymentMethod?: string | null;
  createdByUid?: string | null;
  createdAt: Date;
  items: FoodBillLine[] | AlcoholBillLine[];
  legacyId?: number | string | null;
}

export interface BillDoc {
  billNo: string;
  billNoLower: string;
  type: "FOOD" | "ALCOHOL" | "CAFE";
  source: "table" | "counter" | "website" | "cafe";
  tableId: string | null;
  tableSessionId: string | null;
  customerName: string;
  customerPhone: string;
  customerNameLower: string;
  searchTokens: string[];
  subtotal: number;
  discount: number;
  tax: number;
  grandTotal: number;
  paymentMethod: string;
  status: "confirmed";
  websiteOrderId: string | null;
  createdByUid: string | null;
  createdAt: Date;
  dateKey: string;
  hour: number;
  items: FoodBillLine[] | AlcoholBillLine[];
  legacyId: number | string | null;
}

export function buildBillDoc(input: BuildBillInput): BillDoc {
  const customerName = String(input.customerName ?? "-") || "-";
  return {
    billNo: input.billNo,
    billNoLower: lower(input.billNo),
    type: input.type,
    source: input.source ?? (input.tableSessionId ? "table" : "counter"),
    tableId: input.tableId ?? null,
    tableSessionId: input.tableSessionId ?? null,
    websiteOrderId: input.websiteOrderId ?? null,
    customerName,
    customerPhone: String(input.customerPhone ?? "-") || "-",
    customerNameLower: lower(customerName),
    searchTokens: searchTokens(input.billNo, customerName),
    subtotal: input.subtotal,
    discount: input.discount,
    tax: input.tax,
    grandTotal: input.grandTotal,
    paymentMethod: String(input.paymentMethod ?? "Cash") || "Cash",
    status: "confirmed",
    createdByUid: input.createdByUid ?? null,
    createdAt: input.createdAt,
    dateKey: dateKey(input.createdAt, RESTAURANT_TZ),
    hour: hourOf(input.createdAt, RESTAURANT_TZ),
    items: input.items,
    legacyId: input.legacyId ?? null,
  };
}
