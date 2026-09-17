import {
  round2,
  toFloat,
  toPositiveInt,
  toOptionalStock,
  computeFoodBill,
  computeAlcoholBill,
  splitSettlement,
  formatBillNo,
  dateKey,
  hourOf,
  ValidationError,
  SessionLine,
} from "../src/lib/money";

describe("round2", () => {
  it("keeps exact halves", () => {
    expect(round2(7.5)).toBe(7.5);
    expect(round2(150 * 0.05)).toBe(7.5);
  });
  it("tames float noise", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
  it("uses multiply-then-round like frontend/js/billing.js (documented divergence from Python round())", () => {
    // 2.005 * 100 === 200.50000000000003 in IEEE-754, so this rounds up.
    // frontend billing.js (Math.round(x*100)/100) agrees -> 2.01.
    // Python backend round(2.005, 2) -> 2.0. Half-way cases at the 3rd decimal
    // only arise from percentage discounts and differ by <= 0.01; the Function
    // is authoritative post-migration and matches what the cashier saw.
    expect(round2(2.005)).toBe(2.01);
    expect(round2(1.005)).toBe(1.0); // 1.005 * 100 === 100.49999999999999 -> rounds down
  });
});

describe("validators (parity with backend/app.py)", () => {
  it("toFloat rejects non-numbers and negatives", () => {
    expect(() => toFloat("abc", "price")).toThrow("price must be a valid number");
    expect(() => toFloat(-1, "price")).toThrow("price cannot be negative");
    expect(toFloat("12.349", "price")).toBe(12.35);
    expect(toFloat(-3, "adjust", true)).toBe(-3);
  });
  it("toPositiveInt truncates numbers, rejects '3.5' and <= 0", () => {
    expect(toPositiveInt(3, "qty")).toBe(3);
    expect(toPositiveInt("4", "qty")).toBe(4);
    expect(toPositiveInt(3.9, "qty")).toBe(3);
    expect(() => toPositiveInt("3.5", "qty")).toThrow("qty must be a valid integer");
    expect(() => toPositiveInt(0, "qty")).toThrow("qty must be greater than zero");
  });
  it("toOptionalStock treats blank as untracked", () => {
    expect(toOptionalStock("", "stock_qty")).toBeNull();
    expect(toOptionalStock(null, "stock_qty")).toBeNull();
    expect(toOptionalStock("0", "stock_qty")).toBe(0);
    expect(() => toOptionalStock(-2, "stock_qty")).toThrow("stock_qty cannot be negative");
  });
});

describe("computeFoodBill (backend/app.py create_food_bill)", () => {
  it("adds tax percent on top of subtotal, subtracts discount", () => {
    const r = computeFoodBill([{ name: "Dal", price: 150, qty: 2 }], 0, 5);
    expect(r).toMatchObject({ subtotal: 300, tax: 15, discount: 0, grandTotal: 315 });
    expect(r.items[0]).toMatchObject({ itemName: "Dal", lineTotal: 300, qty: 2 });
  });
  it("applies a rupee discount", () => {
    expect(computeFoodBill([{ name: "Dal", price: 150, qty: 2 }], 50, 5).grandTotal).toBe(265);
  });
  it("rejects discount over subtotal", () => {
    expect(() => computeFoodBill([{ name: "Dal", price: 150, qty: 2 }], 400, 5)).toThrow(
      "Discount cannot exceed subtotal",
    );
  });
  it("rejects an empty cart, blank name, bad qty/price", () => {
    expect(() => computeFoodBill([], 0, 0)).toThrow("Bill must contain at least one item");
    expect(() => computeFoodBill([{ name: "", price: 10, qty: 1 }], 0, 0)).toThrow(
      "Each item must have a name",
    );
    expect(() => computeFoodBill([{ name: "x", price: 10, qty: 0 }], 0, 0)).toThrow(
      "qty must be greater than zero",
    );
    expect(() => computeFoodBill([{ name: "x", price: -1, qty: 1 }], 0, 0)).toThrow(
      "price cannot be negative",
    );
  });
});

describe("computeAlcoholBill (backend/app.py create_alcohol_bill)", () => {
  it("sums per-line tax", () => {
    const r = computeAlcoholBill([{ name: "Beer", price: 200, qty: 2, taxRate: 18 }], 0);
    expect(r).toMatchObject({ subtotal: 400, tax: 72, grandTotal: 472 });
  });
  it("handles mixed tax rates and a discount", () => {
    const r = computeAlcoholBill(
      [
        { name: "Beer", price: 200, qty: 1, taxRate: 18 },
        { name: "Whisky", price: 1200, qty: 1, taxRate: 20 },
      ],
      100,
    );
    expect(r).toMatchObject({ subtotal: 1400, tax: 276, grandTotal: 1576 });
  });
});

describe("splitSettlement (backend/app.py settle_table_session)", () => {
  const line = (over: Partial<SessionLine>): SessionLine => ({
    itemKind: "food",
    itemId: null,
    itemName: "x",
    brand: "",
    bottleSize: "",
    price: 0,
    qty: 1,
    taxRate: 0,
    lineTotal: 0,
    ...over,
  });

  it("splits discount pro-rata; groups sum back to the whole", () => {
    const r = splitSettlement(
      [
        line({ itemKind: "food", lineTotal: 300, taxRate: 5 }),
        line({ itemKind: "alcohol", lineTotal: 400, taxRate: 18 }),
      ],
      70,
    );
    expect(r.groups.map((g) => g.total)).toEqual([285, 432]);
    expect(r.groups.map((g) => g.discount)).toEqual([30, 40]);
    expect(round2(r.groups[0].total + r.groups[1].total)).toBe(717);
    expect(r).toMatchObject({ subtotal: 700, tax: 87, discount: 70, grandTotal: 717 });
  });

  it("single group absorbs the entire discount", () => {
    const r = splitSettlement([line({ itemKind: "food", lineTotal: 300, taxRate: 5 })], 25);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ discount: 25, total: 290 });
    expect(r.grandTotal).toBe(290);
  });

  it("last group absorbs the rounding remainder", () => {
    const r = splitSettlement(
      [
        line({ itemKind: "food", lineTotal: 100 }),
        line({ itemKind: "alcohol", lineTotal: 200 }),
      ],
      10,
    );
    expect(r.groups.map((g) => g.discount)).toEqual([3.33, 6.67]);
    expect(round2(r.groups[0].discount + r.groups[1].discount)).toBe(10);
    expect(round2(r.groups[0].total + r.groups[1].total)).toBe(290);
  });

  it("rejects discount over subtotal and empty items", () => {
    expect(() => splitSettlement([], 0)).toThrow("Add at least one item");
    expect(() => splitSettlement([line({ lineTotal: 100 })], 200)).toThrow(
      "Discount cannot exceed subtotal",
    );
  });
});

describe("formatBillNo (backend/database.py next_bill_number)", () => {
  it("zero-pads to 6 and does not truncate beyond", () => {
    expect(formatBillNo("FOOD", 1)).toBe("FOOD-000001");
    expect(formatBillNo("ALC", 123456)).toBe("ALC-123456");
    expect(formatBillNo("QR", 1234567)).toBe("QR-1234567");
  });
});

describe("timezone helpers (replace SQLite date('now','localtime') / strftime('%H'))", () => {
  it("dateKey rolls to the restaurant day", () => {
    expect(dateKey(new Date("2026-09-05T20:30:00Z"), "Asia/Kolkata")).toBe("2026-09-06");
    expect(dateKey(new Date("2026-09-05T18:00:00Z"), "Asia/Kolkata")).toBe("2026-09-05");
  });
  it("hourOf returns the local hour", () => {
    expect(hourOf(new Date("2026-09-05T20:30:00Z"), "Asia/Kolkata")).toBe(2);
    expect(hourOf(new Date("2026-09-05T18:29:00Z"), "Asia/Kolkata")).toBe(23);
  });
});

describe("ValidationError type", () => {
  it("is distinguishable", () => {
    try {
      toFloat("x", "f");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
    }
  });
});
