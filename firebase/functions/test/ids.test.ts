import {
  userId,
  categoryId,
  catalogItemId,
  tableId,
  tableSessionId,
  billId,
  auditId,
  remapAuditEntity,
  COUNTER_IDS,
} from "../src/lib/ids";

describe("deterministic ids (FIRESTORE-SCHEMA.md §Migration ID mapping)", () => {
  it("builds the documented forms", () => {
    expect(userId(7)).toBe("u_7");
    expect(categoryId("food", 2)).toBe("cat_food_2");
    expect(categoryId("alcohol", 2)).toBe("cat_alc_2");
    expect(catalogItemId("food", 3)).toBe("item_food_3");
    expect(catalogItemId("alcohol", 1)).toBe("item_alc_1");
    expect(tableId(1)).toBe("tbl_1");
    expect(tableSessionId(9)).toBe("sess_9");
    expect(billId("FOOD", 12)).toBe("bill_food_12");
    expect(billId("ALCOHOL", 12)).toBe("bill_alc_12");
    expect(billId("alc", 12)).toBe("bill_alc_12");
    expect(billId("CAFE", 12)).toBe("bill_cafe_12");
    expect(catalogItemId("cafe", 2)).toBe("item_cafe_2");
    expect(categoryId("cafe", 1)).toBe("cat_cafe_1");
    expect(auditId(5)).toBe("audit_5");
    expect(COUNTER_IDS).toEqual({
      foodBill: "foodBill",
      alcoholBill: "alcoholBill",
      cafeBill: "cafeBill",
      qrOrder: "qrOrder",
      websiteOrder: "websiteOrder",
    });
  });

  it("is stable — same legacy id always yields the same doc id (idempotent ETL)", () => {
    expect(catalogItemId("food", 3)).toBe(catalogItemId("food", 3));
    expect(billId("FOOD", 1)).toBe(billId("food", 1));
  });

  it("remaps audit entity ids by entity_type", () => {
    expect(remapAuditEntity("food_item", "3")).toBe("item_food_3");
    expect(remapAuditEntity("alcohol_item", "1")).toBe("item_alc_1");
    expect(remapAuditEntity("user", "2")).toBe("u_2");
    expect(remapAuditEntity("table_session", "2")).toBe("sess_2");
    expect(remapAuditEntity("restaurant_table", "1")).toBe("tbl_1");
    expect(remapAuditEntity("food_bill", "9")).toBe("bill_food_9");
    expect(remapAuditEntity("bills", null)).toBeNull();
    expect(remapAuditEntity("something_else", "abc")).toBe("abc"); // kept raw
    expect(remapAuditEntity("user", "")).toBeNull();
  });
});
