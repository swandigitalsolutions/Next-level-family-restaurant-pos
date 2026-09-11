import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFoodBill, computeAlcoholBill, splitSettlement, round2 } from "../src/lib/money";

// Spot-checks mirroring firebase/functions/test/money.test.ts — money.ts here
// is a byte-identical copy, so these exist to catch a future accidental edit
// diverging the two, not to re-prove logic already proven there.

test("round2 matches frontend Math.round(x*100)/100 semantics", () => {
  assert.equal(round2(19.994), 19.99);
  assert.equal(round2(19.996), 20);
  assert.equal(round2(10), 10);
});

test("computeFoodBill: subtotal/tax/grandTotal", () => {
  const r = computeFoodBill([{ name: "Dosa", price: 100, qty: 2 }], 0, 5);
  assert.equal(r.subtotal, 200);
  assert.equal(r.tax, 10);
  assert.equal(r.grandTotal, 210);
});

test("computeAlcoholBill: per-line tax", () => {
  const r = computeAlcoholBill([{ name: "Beer", price: 150, qty: 2, taxRate: 18 }], 0);
  assert.equal(r.subtotal, 300);
  assert.equal(r.tax, 54);
  assert.equal(r.grandTotal, 354);
});

test("splitSettlement: pro-rata discount, remainder on last group, groups sum back to whole", () => {
  const items = [
    { itemKind: "food" as const, itemId: "a", itemName: "A", brand: "", bottleSize: "", price: 285, qty: 1, taxRate: 0, lineTotal: 285 },
    { itemKind: "alcohol" as const, itemId: "b", itemName: "B", brand: "", bottleSize: "", price: 432, qty: 1, taxRate: 0, lineTotal: 432 },
  ];
  const r = splitSettlement(items, 30);
  assert.equal(r.groups.length, 2);
  const totalDiscount = round2(r.groups.reduce((s, g) => s + g.discount, 0));
  assert.equal(totalDiscount, 30);
  assert.equal(r.discount, 30);
});

test("computeFoodBill rejects discount exceeding subtotal", () => {
  assert.throws(() => computeFoodBill([{ name: "X", price: 10, qty: 1 }], 20, 0));
});
