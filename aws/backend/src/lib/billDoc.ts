/**
 * Pure builder for a `bills` row (aws/db/migrations/001_init.sql). Postgres
 * port of firebase/functions/src/lib/billDoc.ts — same field derivation,
 * same searchTokens, same dateKey/hour denormalization. Kept pure/storage-
 * agnostic in shape so it can be unit-tested directly (see test/billDoc.test.ts).
 */
import { lower, searchTokens } from "./normalize";
import { dateKey, hourOf } from "./money";
import { RESTAURANT_TZ } from "./config";

export interface FoodBillLine { itemName: string; price: number; qty: number; lineTotal: number }
export interface AlcoholBillLine extends FoodBillLine { brand: string; bottleSize: string; taxRate: number }

export interface BuildBillInput {
  billNo: string;
  type: "FOOD" | "ALCOHOL" | "CAFE";
  source?: "counter" | "table" | "website" | "cafe" | null;
  tableId?: string | null;
  tableSessionId?: string | null;
  websiteOrderId?: string | null;
  websiteOrderNo?: string | null;
  depositPaidPaise?: number | null;
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
  /** Caller-supplied retry key; see bills.client_ref in 001_init.sql. */
  clientRef?: string | null;
}

/** Row shape ready for a parameterized INSERT into `bills`. */
export interface BillRow {
  bill_no: string;
  bill_no_lower: string;
  type: "FOOD" | "ALCOHOL" | "CAFE";
  source: "table" | "counter" | "website" | "cafe";
  table_id: string | null;
  table_session_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_name_lower: string;
  search_tokens: string[];
  subtotal: number;
  discount: number;
  tax: number;
  grand_total: number;
  payment_method: string;
  status: "confirmed";
  website_order_id: string | null;
  website_order_no: string | null;
  deposit_paid_paise: number | null;
  created_by_uid: string | null;
  created_at: Date;
  date_key: string;
  hour: number;
  items: unknown;
  legacy_id: number | string | null;
  client_ref: string | null;
}

export function buildBillRow(input: BuildBillInput): BillRow {
  const customerName = String(input.customerName ?? "-") || "-";
  const billNo = input.billNo;
  const extraTokens = input.websiteOrderNo ? [lower(input.websiteOrderNo)] : [];
  return {
    bill_no: billNo,
    bill_no_lower: lower(billNo),
    type: input.type,
    source: input.source ?? (input.tableSessionId ? "table" : "counter"),
    table_id: input.tableId ?? null,
    table_session_id: input.tableSessionId ?? null,
    customer_name: customerName,
    customer_phone: String(input.customerPhone ?? "-") || "-",
    customer_name_lower: lower(customerName),
    search_tokens: [...searchTokens(billNo, customerName), ...extraTokens],
    subtotal: input.subtotal,
    discount: input.discount,
    tax: input.tax,
    grand_total: input.grandTotal,
    payment_method: String(input.paymentMethod ?? "Cash") || "Cash",
    status: "confirmed",
    website_order_id: input.websiteOrderId ?? null,
    website_order_no: input.websiteOrderNo ?? null,
    deposit_paid_paise: input.depositPaidPaise ?? null,
    created_by_uid: input.createdByUid ?? null,
    created_at: input.createdAt,
    date_key: dateKey(input.createdAt, RESTAURANT_TZ),
    hour: hourOf(input.createdAt, RESTAURANT_TZ),
    items: input.items,
    legacy_id: input.legacyId ?? null,
    client_ref: input.clientRef ?? null,
  };
}

/** INSERT a bill row inside the caller's transaction. Immutable by design —
 * this is the only write path for `bills` (no update/delete helper exists). */
import type { PoolClient } from "pg";
export async function insertBill(client: PoolClient, id: string, row: BillRow): Promise<void> {
  await client.query(
    `INSERT INTO bills (id, bill_no, bill_no_lower, type, source, table_id, table_session_id,
       customer_name, customer_phone, customer_name_lower, search_tokens, subtotal, discount, tax,
       grand_total, payment_method, status, website_order_id, website_order_no, deposit_paid_paise,
       created_by_uid, created_at, date_key, hour, items, legacy_id, client_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [
      id, row.bill_no, row.bill_no_lower, row.type, row.source, row.table_id, row.table_session_id,
      row.customer_name, row.customer_phone, row.customer_name_lower, row.search_tokens, row.subtotal,
      row.discount, row.tax, row.grand_total, row.payment_method, row.status, row.website_order_id,
      row.website_order_no, row.deposit_paid_paise, row.created_by_uid, row.created_at, row.date_key,
      row.hour, JSON.stringify(row.items), row.legacy_id, row.client_ref,
    ],
  );
}
