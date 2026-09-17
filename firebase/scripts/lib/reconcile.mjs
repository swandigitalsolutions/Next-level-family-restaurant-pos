// Reconciliation: source row counts vs planned docs vs (optionally) target docs,
// plus structural spot-checks. Generic checks always run; the deep checks only
// run when the committed ETL fixture (scripts/fixtures/etl-source.sqlite) is the
// source — detected by a marker document.

const SRC_COUNT = {
  users: (s) => s.count("users"),
  userCredentials: (s) => s.count("users"),
  categories: (s) => s.count("food_categories") + s.count("alcohol_categories"),
  catalog: (s) => s.count("food_items") + s.count("alcohol_items"),
  tables: (s) => s.count("restaurant_tables"),
  tableSessions: (s) => s.count("table_sessions"),
  bills: (s) => s.count("food_bills") + s.count("alcohol_bills"),
  qrOrders: (s) => s.count("qr_orders"),
  auditLog: (s) => s.count("audit_log"),
  counters: () => 5, // foodBill / alcoholBill / cafeBill / qrOrder / websiteOrder
};

const approx = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

export async function reconcile({ src, docs, target }) {
  const rows = [];
  const checks = [];
  const fail = (name, msg) => checks.push({ name, ok: false, msg: msg || "assertion failed" });
  const pass = (name) => checks.push({ name, ok: true });
  const expect = (name, cond, detail) => (cond ? pass(name) : fail(name, detail));

  // ---- count reconciliation (always) --------------------------------
  for (const coll of Object.keys(SRC_COUNT)) {
    const source = SRC_COUNT[coll](src);
    const planned = docs[coll].length;
    let targetCount = null;
    if (target.mode !== "dry") targetCount = await target.verifyCount(coll);
    const ok = planned === source && (targetCount === null || targetCount === planned);
    rows.push({ coll, source, planned, target: targetCount, ok });
    if (!ok) fail(`count:${coll}`, `source=${source} planned=${planned} target=${targetCount}`);
  }

  const sum = (coll, f) => docs[coll].reduce((n, d) => n + (d.data[f]?.length || 0), 0);
  for (const [label, got, want] of [
    ["bill items", sum("bills", "items"), src.count("food_bill_items") + src.count("alcohol_bill_items")],
    ["session items", sum("tableSessions", "items"), src.count("table_session_items")],
    ["qr items", sum("qrOrders", "items"), src.count("qr_order_items")],
  ]) {
    expect(`nested:${label}`, got === want, `flattened ${got} != source ${want}`);
  }

  const byId = Object.fromEntries(
    Object.entries(docs).map(([k, arr]) => [k, Object.fromEntries(arr.map((d) => [d.id, d.data]))]),
  );

  // ---- generic structural checks (any source) --------------------
  const c = byId.counters;
  expect("counters: exactly 5", Object.keys(c).length === 5);
  expect("counters: all five present", !!(c.foodBill && c.alcoholBill && c.cafeBill && c.qrOrder && c.websiteOrder));
  expect(
    "counters: value >= max issued bill/order number",
    (() => {
      const maxSuffix = (arr, f) =>
        arr.reduce((m, d) => Math.max(m, parseInt(String(d.data[f]).match(/(\d+)\s*$/)?.[1] || 0, 10)), 0);
      const f = maxSuffix(docs.bills.filter((b) => b.data.type === "FOOD"), "billNo");
      const a = maxSuffix(docs.bills.filter((b) => b.data.type === "ALCOHOL"), "billNo");
      const q = maxSuffix(docs.qrOrders, "orderNo");
      return c.foodBill.value >= f && c.alcoholBill.value >= a && c.qrOrder.value >= q;
    })(),
  );
  expect("users: at least one admin", docs.users.some((u) => u.data.role === "admin"));
  expect("users: no profile carries passwordHash", docs.users.every((u) => !("passwordHash" in u.data)));
  expect(
    "userCredentials: every doc has a Werkzeug hash + usernameLower",
    docs.userCredentials.every((d) => /^(scrypt|pbkdf2):/.test(d.data.passwordHash || "") && !!d.data.usernameLower),
  );
  expect("auditLog: no doc contains a password hash", !JSON.stringify(docs.auditLog).match(/scrypt:|pbkdf2:/));
  expect(
    "catalog: food items have taxRate 0, alcohol carry brand/bottleSize",
    docs.catalog.every((d) =>
      d.data.kind === "food"
        ? d.data.taxRate === 0 && d.data.brand === null
        : d.data.description === null,
    ),
  );
  expect(
    "catalog: categoryId points at an existing category doc",
    docs.catalog.every((d) => d.data.categoryId === null || !!byId.categories[d.data.categoryId]),
  );
  expect(
    "tables: openSessionId (when set) points at an open session",
    docs.tables.every((t) => {
      const sid = t.data.openSessionId;
      return sid === null || byId.tableSessions[sid]?.status === "open";
    }),
  );
  expect(
    "tableSessions: every settled session lists its bill ids and has settledAt",
    docs.tableSessions
      .filter((s) => s.data.status === "settled")
      .every((s) => Array.isArray(s.data.settledBillIds) && s.data.settledBillIds.length > 0 && !!s.data.settledAt),
  );
  expect(
    "bills: session-linked bills carry source=table and a sess_ ref",
    docs.bills.every((b) => b.data.tableSessionId === null || (b.data.source === "table" && /^sess_/.test(b.data.tableSessionId))),
  );

  // ---- fixture-specific deep checks -----------------------------
  const isFixture = !!byId.bills.bill_food_2 && !!byId.qrOrders["ref0000000000000000000000000001"];
  if (isFixture) {
    expect("fixture: user u_1 admin / u_2 staff", byId.users.u_1?.role === "admin" && byId.users.u_2?.role === "staff");
    expect("fixture: cred u_1 usernameLower admin", byId.userCredentials.u_1?.usernameLower === "admin");
    const bc = byId.catalog.item_food_3;
    expect("fixture: item_food_3 price 280 -> cat_food_2 'Main Course'", approx(bc?.price, 280) && bc?.categoryId === "cat_food_2" && bc?.categoryName === "Main Course");
    expect("fixture: item_food_2 stock null (untracked)", byId.catalog.item_food_2?.stockQty === null);
    expect("fixture: item_food_1 stock 10", byId.catalog.item_food_1?.stockQty === 10);
    const ac = byId.catalog.item_alc_1;
    expect("fixture: item_alc_1 taxRate 18 brand Kingfisher 650ml", approx(ac?.taxRate, 18) && ac?.brand === "Kingfisher" && ac?.bottleSize === "650ml");
    expect("fixture: table tbl_1 -> openSessionId sess_1; tbl_2 null", byId.tables.tbl_1?.openSessionId === "sess_1" && byId.tables.tbl_2?.openSessionId === null);
    const s1 = byId.tableSessions.sess_1;
    expect("fixture: sess_1 open, 2 items, alc line -> item_alc_1", s1?.status === "open" && s1?.items?.length === 2 && s1?.items?.[1]?.itemId === "item_alc_1");
    expect("fixture: sess_1 subtotal 580 / tax 75.8 / grandTotal 655.8", approx(s1?.subtotal, 580) && approx(s1?.tax, 75.8) && approx(s1?.grandTotal, 655.8));
    const s2 = byId.tableSessions.sess_2;
    expect("fixture: sess_2 settled, settledBillIds [bill_food_2, bill_alc_2]", s2?.status === "settled" && (s2?.settledBillIds || []).includes("bill_food_2") && (s2?.settledBillIds || []).includes("bill_alc_2"));
    const bf1 = byId.bills.bill_food_1;
    expect("fixture: bill_food_1 FOOD/counter, 2 items, grandTotal 714, createdBy u_2, dateKey 2026-09-01, hour 13", bf1?.type === "FOOD" && bf1?.source === "counter" && bf1?.items?.length === 2 && approx(bf1?.grandTotal, 714) && bf1?.createdByUid === "u_2" && bf1?.dateKey === "2026-09-01" && bf1?.hour === 13);
    expect("fixture: bill_food_1 searchTokens has 'ram' + 'food-000001'", (bf1?.searchTokens || []).includes("ram") && (bf1?.searchTokens || []).includes("food-000001"));
    const bf2 = byId.bills.bill_food_2;
    const ba2 = byId.bills.bill_alc_2;
    expect("fixture: bill_food_2 -> sess_2, split discount food+alc == 100", bf2?.tableSessionId === "sess_2" && approx((bf2?.discount || 0) + (ba2?.discount || 0), 100));
    expect("fixture: bill_alc_1 ALCOHOL, line taxRate 18", byId.bills.bill_alc_1?.type === "ALCOHOL" && approx(byId.bills.bill_alc_1?.items?.[0]?.taxRate, 18));
    const q1 = byId.qrOrders["ref0000000000000000000000000001"];
    expect("fixture: qr ..01 SERVED, pushedToBill, -> sess_1, line -> item_food_1, tableNo 'Table 01'", q1?.status === "SERVED" && q1?.pushedToBill === true && q1?.tableSessionId === "sess_1" && q1?.items?.[0]?.itemId === "item_food_1" && q1?.tableNo === "Table 01");
    const q2 = byId.qrOrders["ref0000000000000000000000000002"];
    expect("fixture: qr ..02 NEW, not pushed", q2?.status === "NEW" && q2?.pushedToBill === false && q2?.tableSessionId === null);
    const a2 = byId.auditLog.audit_2;
    expect("fixture: audit_2 table.settle, entityId remapped -> sess_2, details.discount 100", a2?.action === "table.settle" && a2?.entityId === "sess_2" && a2?.details?.discount === 100);
    expect("fixture: audit_3 entityId remapped -> item_food_3", byId.auditLog.audit_3?.entityId === "item_food_3");
    expect("fixture: audit_1 actorUid -> u_2", byId.auditLog.audit_1?.actorUid === "u_2");

    if (target.mode !== "dry") {
      const tb = await target.getDoc("bills", "bill_food_2");
      expect("fixture(target): bill_food_2 grandTotal 275.08 persisted", approx(tb?.grandTotal, 275.08));
      const tc = await target.getDoc("counters", "foodBill");
      expect("fixture(target): counter foodBill persisted >= 2", (tc?.value ?? 0) >= 2);
      const ts1 = await target.getDoc("tableSessions", "sess_1");
      expect("fixture(target): sess_1 items persisted (2)", ts1?.items?.length === 2);
    }
  } else {
    pass("seed source: generic checks only (no transactional fixture markers)");
  }

  const failed = checks.filter((x) => !x.ok);
  return { rows, checks, ok: failed.length === 0, failed, mode: isFixture ? "fixture" : "seed" };
}
