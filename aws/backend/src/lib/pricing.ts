/**
 * Server-side re-pricing from the POS `catalog` — the single source of truth for
 * every channel (QR, website). Anything the client sends for price / name /
 * total is ignored (invariant I7). Works with either a plain read (db.get) or a
 * transaction read (tx.get) via the injected `readItem`.
 */
import { round2, ValidationError } from "./money";
import { MAX_QR_LINE_QTY } from "./config";

export interface RawLine {
  id?: unknown;
  kind?: unknown;
  qty?: unknown;
}

export interface PricedLine {
  itemId: string;
  kind: "food" | "alcohol";
  itemName: string;
  brand: string;
  bottleSize: string;
  unitPrice: number;
  qty: number;
  taxRate: number;
  lineTotal: number;
}

export interface PricedCart {
  items: PricedLine[];
  subtotal: number;
  tax: number;
  total: number;
}

export type CatalogReader = (itemId: string) => Promise<Record<string, any> | null>;

export async function priceCart(
  readItem: CatalogReader,
  rawItems: unknown,
  opts: { requireInStock?: boolean; maxQty?: number } = {},
): Promise<PricedCart> {
  const maxQty = opts.maxQty ?? MAX_QR_LINE_QTY;
  const rows = Array.isArray(rawItems) ? (rawItems as RawLine[]) : [];
  if (rows.length === 0) throw new ValidationError("Your cart is empty.");

  const items: PricedLine[] = [];
  let subtotal = 0;
  let tax = 0;

  for (const raw of rows) {
    const itemId = String(raw.id ?? "");
    const qty = Number(raw.qty);
    if (!itemId || !Number.isFinite(qty)) {
      throw new ValidationError("That order contains an invalid item.");
    }
    if (qty <= 0 || qty > maxQty) {
      throw new ValidationError(`Quantity must be between 1 and ${maxQty}.`);
    }
    const data = await readItem(itemId);
    if (!data || data.status !== "active") {
      throw new ValidationError(
        "One of the items is no longer available. Please refresh the menu.",
      );
    }
    if (opts.requireInStock && data.stockQty !== null && data.stockQty !== undefined && Number(data.stockQty) <= 0) {
      throw new ValidationError(`${data.name} just sold out. Please remove it and try again.`);
    }
    const kind: "food" | "alcohol" = data.kind === "alcohol" ? "alcohol" : "food";
    const unitPrice = round2(Number(data.price));
    const taxRate = kind === "alcohol" ? Number(data.taxRate) || 0 : 0;
    const lineTotal = round2(unitPrice * qty);
    subtotal += lineTotal;
    tax += round2((lineTotal * taxRate) / 100);
    items.push({
      itemId,
      kind,
      itemName: data.name,
      brand: kind === "alcohol" ? data.brand ?? "" : "",
      bottleSize: kind === "alcohol" ? data.bottleSize ?? "" : "",
      unitPrice,
      qty,
      taxRate,
      lineTotal,
    });
  }

  subtotal = round2(subtotal);
  tax = round2(tax);
  return { items, subtotal, tax, total: round2(subtotal + tax) };
}

// --------------------------------------------------------------------------
// Integer-paise pricing for the website contract. Same re-pricing rules, but
// every amount is an integer number of paise (no floating point anywhere).

export interface PaiseLine {
  itemId: string;
  name: string;
  kind: "food" | "alcohol";
  brand: string;
  bottleSize: string;
  unitPricePaise: number;
  qty: number;
  taxRatePct: number;
  lineTotalPaise: number; // goods only (pre-tax)
  lineTaxPaise: number;
}
export interface PaiseCart {
  items: PaiseLine[];
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export async function priceCartPaise(
  readItem: CatalogReader,
  rawItems: unknown,
  opts: { requireInStock?: boolean; maxQty?: number } = {},
): Promise<PaiseCart> {
  const maxQty = opts.maxQty ?? MAX_QR_LINE_QTY;
  const rows = Array.isArray(rawItems) ? (rawItems as RawLine[]) : [];
  if (rows.length === 0) throw new ValidationError("Your cart is empty.");

  const items: PaiseLine[] = [];
  let subtotalPaise = 0;
  let taxPaise = 0;

  for (const raw of rows) {
    const itemId = String(raw.id ?? "");
    const qty = Number(raw.qty);
    if (!itemId || !Number.isInteger(qty)) throw new ValidationError("That order contains an invalid item.");
    if (qty <= 0 || qty > maxQty) throw new ValidationError(`Quantity must be between 1 and ${maxQty}.`);
    const data = await readItem(itemId);
    if (!data || data.status !== "active") {
      throw new ValidationError("One of the items is no longer available. Please refresh the menu.");
    }
    if (opts.requireInStock && data.stockQty !== null && data.stockQty !== undefined && Number(data.stockQty) <= 0) {
      throw new ValidationError(`${data.name} just sold out. Please remove it and try again.`);
    }
    const kind: "food" | "alcohol" = data.kind === "alcohol" ? "alcohol" : "food";
    const unitPricePaise = Math.round(Number(data.price) * 100);
    const taxRatePct = kind === "alcohol" ? Number(data.taxRate) || 0 : 0;
    const lineTotalPaise = unitPricePaise * qty;
    const lineTaxPaise = Math.round((lineTotalPaise * taxRatePct) / 100);
    subtotalPaise += lineTotalPaise;
    taxPaise += lineTaxPaise;
    items.push({
      itemId,
      name: data.name,
      kind,
      brand: kind === "alcohol" ? data.brand ?? "" : "",
      bottleSize: kind === "alcohol" ? data.bottleSize ?? "" : "",
      unitPricePaise,
      qty,
      taxRatePct,
      lineTotalPaise,
      lineTaxPaise,
    });
  }
  return { items, subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}
