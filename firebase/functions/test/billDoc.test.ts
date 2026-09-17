import { buildBillDoc } from "../src/lib/billDoc";

const baseInput = {
  billNo: "FOOD-000042",
  type: "FOOD" as const,
  customerName: "Ramesh Kumar",
  customerPhone: "9812345678",
  subtotal: 680,
  discount: 0,
  tax: 34,
  grandTotal: 714,
  paymentMethod: "Cash",
  createdByUid: "u_2",
  createdAt: new Date("2026-09-01T13:15:00+05:30"),
  items: [
    { itemName: "Paneer Tikka", price: 220, qty: 2, lineTotal: 440 },
    { itemName: "Butter Chicken", price: 280, qty: 1, lineTotal: 280 },
  ],
  legacyId: 1,
};

describe("buildBillDoc — FIRESTORE-SCHEMA.md §7 shape", () => {
  it("produces exactly the documented fields for a counter sale", () => {
    const d = buildBillDoc({ ...baseInput });
    expect(d).toMatchObject({
      billNo: "FOOD-000042",
      billNoLower: "food-000042",
      type: "FOOD",
      source: "counter",
      tableId: null,
      tableSessionId: null,
      customerName: "Ramesh Kumar",
      customerNameLower: "ramesh kumar",
      subtotal: 680,
      discount: 0,
      tax: 34,
      grandTotal: 714,
      paymentMethod: "Cash",
      status: "confirmed",
      createdByUid: "u_2",
      dateKey: "2026-09-01",
      hour: 13,
      legacyId: 1,
    });
    expect(d.items).toHaveLength(2);
    expect(d.searchTokens).toEqual(expect.arrayContaining(["food-000042", "ram"]));
    expect(Object.keys(d).sort()).toEqual(
      [
        "billNo", "billNoLower", "type", "source", "tableId", "tableSessionId",
        "websiteOrderId", "customerName", "customerPhone", "customerNameLower", "searchTokens",
        "subtotal", "discount", "tax", "grandTotal", "paymentMethod", "status",
        "createdByUid", "createdAt", "dateKey", "hour", "items", "legacyId",
      ].sort(),
    );
    expect(d.websiteOrderId).toBeNull();
  });

  it("marks source=table when tied to a session", () => {
    const d = buildBillDoc({ ...baseInput, tableId: "tbl_2", tableSessionId: "sess_2" });
    expect(d.source).toBe("table");
    expect(d.tableId).toBe("tbl_2");
    expect(d.tableSessionId).toBe("sess_2");
  });

  it("defaults blank customer + payment like Flask", () => {
    const d = buildBillDoc({ ...baseInput, customerName: null, customerPhone: null, paymentMethod: null });
    expect(d).toMatchObject({ customerName: "-", customerPhone: "-", paymentMethod: "Cash", customerNameLower: "-" });
  });

  it("keeps alcohol line fields", () => {
    const d = buildBillDoc({
      ...baseInput,
      billNo: "ALC-000009",
      type: "ALCOHOL",
      items: [{ itemName: "Kingfisher Premium", brand: "Kingfisher", bottleSize: "650ml", price: 180, qty: 2, taxRate: 18, lineTotal: 360 }],
    });
    expect(d.type).toBe("ALCOHOL");
    expect(d.items[0]).toMatchObject({ brand: "Kingfisher", bottleSize: "650ml", taxRate: 18 });
  });
});
