/**
 * Money math + validation, ported 1:1 from backend/app.py so the Firebase
 * version bills identical amounts to the Flask version.
 *
 * Rounding note: backend/app.py uses Python round(x, 2) (half-to-even);
 * frontend/js/billing.js uses Math.round(x*100)/100 (half-up). Every amount in
 * this domain is non-negative and prices are INR (mostly integers), so the two
 * agree on every realistic input. We match the frontend convention here — no
 * Number.EPSILON nudge — because that is what the cashier saw in the cart.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Sanity caps for counter/session billing lines (see config.ts). Kept here to
 * avoid a circular import; must match config.MAX_BILL_LINE_QTY / MAX_BILL_LINES. */
const MAX_LINE_QTY = 999;
const MAX_LINES = 200;

export function round2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/** backend/app.py to_float */
export function toFloat(
  value: unknown,
  fieldName: string,
  allowNegative = false,
): number {
  const val = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(val)) {
    throw new ValidationError(`${fieldName} must be a valid number`);
  }
  if (!allowNegative && val < 0) {
    throw new ValidationError(`${fieldName} cannot be negative`);
  }
  return round2(val);
}

/** backend/app.py to_positive_int (Python int() truncates floats, rejects "3.5"). */
export function toPositiveInt(value: unknown, fieldName: string): number {
  let val: number;
  if (typeof value === "number") {
    val = Math.trunc(value);
  } else if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    val = parseInt(value.trim(), 10);
  } else {
    throw new ValidationError(`${fieldName} must be a valid integer`);
  }
  if (!Number.isFinite(val) || val <= 0) {
    throw new ValidationError(`${fieldName} must be greater than zero`);
  }
  return val;
}

/** backend/app.py to_optional_stock — blank/null means "not tracked". */
export function toOptionalStock(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  let val: number;
  if (typeof value === "number") {
    val = Math.trunc(value);
  } else if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    val = parseInt(value.trim(), 10);
  } else {
    throw new ValidationError(`${fieldName} must be a whole number`);
  }
  if (val < 0) throw new ValidationError(`${fieldName} cannot be negative`);
  return val;
}

// ---------------------------------------------------------------------------

export interface RawLine {
  name?: string;
  price?: unknown;
  qty?: unknown;
  item_id?: unknown;
  itemId?: unknown;
  brand?: string;
  bottle_size?: string;
  bottleSize?: string;
  tax_rate?: unknown;
  taxRate?: unknown;
  item_kind?: string;
  itemKind?: string;
}

export interface CleanFoodLine {
  itemName: string;
  price: number;
  qty: number;
  lineTotal: number;
  itemId: number | string | null;
}

export interface CleanAlcoholLine extends CleanFoodLine {
  brand: string;
  bottleSize: string;
  taxRate: number;
}

export interface FoodBillResult {
  subtotal: number;
  discount: number;
  tax: number;
  grandTotal: number;
  items: CleanFoodLine[];
}

export interface AlcoholBillResult {
  subtotal: number;
  discount: number;
  tax: number;
  grandTotal: number;
  items: CleanAlcoholLine[];
}

function lineItemId(raw: RawLine): number | string | null {
  const v = raw.itemId ?? raw.item_id;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && v) return v;
  return null;
}

/** backend/app.py create_food_bill body math. */
export function computeFoodBill(
  items: RawLine[],
  discountInput: unknown = 0,
  taxPercentInput: unknown = 0,
): FoodBillResult {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError("Bill must contain at least one item");
  }
  if (items.length > MAX_LINES) {
    throw new ValidationError(`A bill cannot have more than ${MAX_LINES} lines`);
  }
  const discount = toFloat(discountInput, "discount");
  const taxPercent = toFloat(taxPercentInput, "tax_percent");

  let subtotal = 0;
  const clean: CleanFoodLine[] = [];
  for (const it of items) {
    const qty = toPositiveInt(it.qty, "qty");
    if (qty > MAX_LINE_QTY) throw new ValidationError(`qty cannot exceed ${MAX_LINE_QTY}`);
    const price = toFloat(it.price, "price");
    const name = (it.name || "").trim();
    if (!name) throw new ValidationError("Each item must have a name");
    const lineTotal = round2(price * qty);
    subtotal += lineTotal;
    clean.push({ itemName: name, price, qty, lineTotal, itemId: lineItemId(it) });
  }
  subtotal = round2(subtotal);
  if (discount > subtotal) {
    throw new ValidationError("Discount cannot exceed subtotal");
  }
  const tax = round2((subtotal * taxPercent) / 100);
  const grandTotal = round2(subtotal - discount + tax);
  if (grandTotal < 0) {
    throw new ValidationError("Grand total cannot be negative");
  }
  return { subtotal, discount, tax, grandTotal, items: clean };
}

/** backend/app.py create_alcohol_bill body math (per-line tax_rate). */
export function computeAlcoholBill(
  items: RawLine[],
  discountInput: unknown = 0,
): AlcoholBillResult {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError("Bill must contain at least one item");
  }
  if (items.length > MAX_LINES) {
    throw new ValidationError(`A bill cannot have more than ${MAX_LINES} lines`);
  }
  const discount = toFloat(discountInput, "discount");

  let subtotal = 0;
  let taxTotal = 0;
  const clean: CleanAlcoholLine[] = [];
  for (const it of items) {
    const qty = toPositiveInt(it.qty, "qty");
    if (qty > MAX_LINE_QTY) throw new ValidationError(`qty cannot exceed ${MAX_LINE_QTY}`);
    const price = toFloat(it.price, "price");
    const taxRate = toFloat(it.taxRate ?? it.tax_rate ?? 0, "tax_rate");
    const name = (it.name || "").trim();
    if (!name) throw new ValidationError("Each item must have a name");
    const lineTotal = round2(price * qty);
    const lineTax = round2((lineTotal * taxRate) / 100);
    subtotal += lineTotal;
    taxTotal += lineTax;
    clean.push({
      itemName: name,
      brand: (it.brand || "").trim(),
      bottleSize: (it.bottleSize ?? it.bottle_size ?? "").toString().trim(),
      price,
      qty,
      taxRate,
      lineTotal,
      itemId: lineItemId(it),
    });
  }
  subtotal = round2(subtotal);
  taxTotal = round2(taxTotal);
  if (discount > subtotal) {
    throw new ValidationError("Discount cannot exceed subtotal");
  }
  const grandTotal = round2(subtotal + taxTotal - discount);
  if (grandTotal < 0) {
    throw new ValidationError("Grand total cannot be negative");
  }
  return { subtotal, discount, tax: taxTotal, grandTotal, items: clean };
}

// ---------------------------------------------------------------------------

export interface SessionLine {
  itemKind: "food" | "alcohol";
  itemId: number | string | null;
  itemName: string;
  brand: string;
  bottleSize: string;
  price: number;
  qty: number;
  taxRate: number;
  lineTotal: number;
}

export interface SettlementGroup {
  kind: "food" | "alcohol";
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  items: SessionLine[];
}

export interface SettlementResult {
  groups: SettlementGroup[];
  subtotal: number;
  tax: number;
  discount: number;
  grandTotal: number;
}

const sumLineTotal = (rows: SessionLine[]) =>
  round2(rows.reduce((s, r) => s + Number(r.lineTotal), 0));
const sumLineTax = (rows: SessionLine[]) =>
  round2(
    rows.reduce((s, r) => s + (Number(r.lineTotal) * Number(r.taxRate || 0)) / 100, 0),
  );

/**
 * backend/app.py settle_table_session: split into food/alcohol bills, spread the
 * discount pro-rata by subtotal, last group absorbs the rounding remainder so the
 * two bills always sum back to `discount`.
 */
export function splitSettlement(
  items: SessionLine[],
  discountInput: unknown = 0,
): SettlementResult {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError("Add at least one item before settling the table");
  }
  if (items.length > MAX_LINES) {
    throw new ValidationError(`A table bill cannot have more than ${MAX_LINES} lines`);
  }
  for (const r of items) {
    if (!Number.isFinite(Number(r.qty)) || Number(r.qty) <= 0 || Number(r.qty) > MAX_LINE_QTY) {
      throw new ValidationError(`each line qty must be between 1 and ${MAX_LINE_QTY}`);
    }
  }
  const discount = toFloat(discountInput, "discount");
  const subtotal = sumLineTotal(items);
  if (discount > subtotal) {
    throw new ValidationError("Discount cannot exceed subtotal");
  }

  const food = items.filter((r) => r.itemKind === "food");
  const alcohol = items.filter((r) => r.itemKind === "alcohol");
  const groupsIn: Array<["food" | "alcohol", SessionLine[]]> = [];
  if (food.length) groupsIn.push(["food", food]);
  if (alcohol.length) groupsIn.push(["alcohol", alcohol]);

  let discountLeft = discount;
  let settledSubtotal = 0;
  let settledTax = 0;
  const groups: SettlementGroup[] = groupsIn.map(([kind, group], index) => {
    const groupSubtotal = sumLineTotal(group);
    const groupTax = sumLineTax(group);
    const isLast = index === groupsIn.length - 1;
    const groupDiscount = isLast
      ? round2(discountLeft)
      : subtotal
        ? round2((discount * groupSubtotal) / subtotal)
        : 0;
    discountLeft = round2(discountLeft - groupDiscount);
    const total = round2(groupSubtotal + groupTax - groupDiscount);
    settledSubtotal = round2(settledSubtotal + groupSubtotal);
    settledTax = round2(settledTax + groupTax);
    return { kind, subtotal: groupSubtotal, tax: groupTax, discount: groupDiscount, total, items: group };
  });

  return {
    groups,
    subtotal: settledSubtotal,
    tax: settledTax,
    discount,
    grandTotal: round2(settledSubtotal + settledTax - discount),
  };
}

// ---------------------------------------------------------------------------

/** backend/database.py next_bill_number formatting (FOOD-000001). */
export function formatBillNo(prefix: string, value: number): string {
  return `${prefix}-${String(value).padStart(6, "0")}`;
}

/** YYYY-MM-DD in the restaurant timezone (replaces SQLite date('now','localtime')). */
export function dateKey(when: Date = new Date(), tz = "Asia/Kolkata"): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

/** Local hour 0..23 in the restaurant timezone (replaces strftime('%H')). */
export function hourOf(when: Date = new Date(), tz = "Asia/Kolkata"): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(when);
  const n = parseInt(h, 10);
  return n === 24 ? 0 : n;
}
