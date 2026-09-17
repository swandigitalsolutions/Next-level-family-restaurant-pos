/**
 * Verifies each query builder emits the exact where/orderBy/limit chain the
 * FIRESTORE-SCHEMA.md §Query→index matrix (and firestore.indexes.json) expect.
 * Uses a chainable spy in place of Firestore.
 */
import {
  ordersQuery,
  reportQuery,
  qrBoardQuery,
  qrByStatusQuery,
  qrTodayForTableQuery,
  openSessionForTableQuery,
  tableByTokenQuery,
  activeAdminsQuery,
  auditQuery,
  tablesQuery,
} from "../src/lib/queries";

type Op = [string, ...unknown[]];

function fakeDb() {
  const ops: Op[] = [];
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "__ops") return ops;
        return (...args: unknown[]) => {
          ops.push([prop, ...args]);
          return chain;
        };
      },
    },
  );
  return { db: { collection: (name: string) => (ops.push(["collection", name]), chain) } as any, ops };
}

describe("query builders", () => {
  it("tablesQuery: collection(tables).orderBy(tableNo)", () => {
    const { db, ops } = fakeDb();
    tablesQuery(db);
    expect(ops).toEqual([["collection", "tables"], ["orderBy", "tableNo"]]);
  });

  it("openSessionForTableQuery: tableId== + status==open + limit 1  (index tableSessions(tableId,status))", () => {
    const { db, ops } = fakeDb();
    openSessionForTableQuery(db, "tbl_5");
    expect(ops).toEqual([
      ["collection", "tableSessions"],
      ["where", "tableId", "==", "tbl_5"],
      ["where", "status", "==", "open"],
      ["limit", 1],
    ]);
  });

  it("tableByTokenQuery: qrToken== + limit 1", () => {
    const { db, ops } = fakeDb();
    tableByTokenQuery(db, "tok_abc");
    expect(ops).toContainEqual(["where", "qrToken", "==", "tok_abc"]);
    expect(ops).toContainEqual(["limit", 1]);
  });

  it("ordersQuery: no filters -> createdAt desc only", () => {
    const { db, ops } = fakeDb();
    ordersQuery(db);
    expect(ops).toEqual([["collection", "bills"], ["orderBy", "createdAt", "desc"]]);
  });

  it("ordersQuery: search+type+date -> array-contains, type==, dateKey==, createdAt desc, limit", () => {
    const { db, ops } = fakeDb();
    ordersQuery(db, { search: "  RAM ", type: "FOOD", dateKey: "2026-09-01", limit: 25 });
    expect(ops).toEqual([
      ["collection", "bills"],
      ["where", "searchTokens", "array-contains", "ram"],
      ["where", "type", "==", "FOOD"],
      ["where", "dateKey", "==", "2026-09-01"],
      ["orderBy", "createdAt", "desc"],
      ["limit", 25],
    ]);
  });

  it("ordersQuery: clamps limit to [1,200]", () => {
    expect(fakeDb().ops).toEqual([]);
    const a = fakeDb();
    ordersQuery(a.db, { limit: 9999 });
    expect(a.ops).toContainEqual(["limit", 200]);
  });

  it("reportQuery: type== + dateKey range + orderBy dateKey  (index bills(type,dateKey))", () => {
    const { db, ops } = fakeDb();
    reportQuery(db, { type: "ALCOHOL", from: "2026-09-01", to: "2026-09-30" });
    expect(ops).toEqual([
      ["collection", "bills"],
      ["where", "type", "==", "ALCOHOL"],
      ["where", "dateKey", ">=", "2026-09-01"],
      ["where", "dateKey", "<=", "2026-09-30"],
      ["orderBy", "dateKey"],
    ]);
  });

  it("qrBoardQuery: status in active[] + createdAt desc  (index qrOrders(status,createdAt))", () => {
    const { db, ops } = fakeDb();
    qrBoardQuery(db);
    expect(ops[0]).toEqual(["collection", "qrOrders"]);
    expect(ops[1][0]).toBe("where");
    expect(ops[1][1]).toBe("status");
    expect(ops[1][2]).toBe("in");
    expect(ops[1][3]).toEqual(["NEW", "ACCEPTED", "PREPARING", "READY"]);
    expect(ops[2]).toEqual(["orderBy", "createdAt", "desc"]);
  });

  it("qrByStatusQuery + qrTodayForTableQuery shapes", () => {
    const a = fakeDb();
    qrByStatusQuery(a.db, "NEW");
    expect(a.ops).toEqual([["collection", "qrOrders"], ["where", "status", "==", "NEW"], ["orderBy", "createdAt", "desc"]]);
    const b = fakeDb();
    qrTodayForTableQuery(b.db, "tbl_3", "2026-09-02");
    expect(b.ops).toEqual([
      ["collection", "qrOrders"],
      ["where", "tableId", "==", "tbl_3"],
      ["where", "dateKey", "==", "2026-09-02"],
      ["orderBy", "createdAt", "desc"],
    ]);
  });

  it("activeAdminsQuery: role==admin + status==active  (index users(role,status), last-admin guard)", () => {
    const { db, ops } = fakeDb();
    activeAdminsQuery(db);
    expect(ops).toEqual([
      ["collection", "users"],
      ["where", "role", "==", "admin"],
      ["where", "status", "==", "active"],
    ]);
  });

  it("auditQuery: entityType -> where + createdAt desc", () => {
    const { db, ops } = fakeDb();
    auditQuery(db, { entityType: "food_item" });
    expect(ops).toEqual([
      ["collection", "auditLog"],
      ["where", "entityType", "==", "food_item"],
      ["orderBy", "createdAt", "desc"],
    ]);
  });

  it("auditQuery: actionPrefix -> prefix range + orderBy action,createdAt  (Flask action LIKE 'staff.%')", () => {
    const { db, ops } = fakeDb();
    auditQuery(db, { actionPrefix: "staff." });
    expect(ops[0]).toEqual(["collection", "auditLog"]);
    expect(ops[1]).toEqual(["where", "action", ">=", "staff."]);
    expect(ops[2][0]).toBe("where");
    expect(ops[2][1]).toBe("action");
    expect(ops[2][2]).toBe("<");
    expect(String(ops[2][3]).startsWith("staff.")).toBe(true);
    expect(ops[3]).toEqual(["orderBy", "action"]);
    expect(ops[4]).toEqual(["orderBy", "createdAt", "desc"]);
  });
});
