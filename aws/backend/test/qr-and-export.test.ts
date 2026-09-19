/**
 * Runtime coverage for the two handlers that had none: the public QR customer
 * API and the CSV export. Both are ported code that typechecked and linted but
 * had never actually been executed — exactly where a silent break hides.
 */
import "./_env";
import test from "node:test";
import assert from "node:assert/strict";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem, seedTable } from "./_helpers";
import { handler as qrApi } from "../src/handlers/http/qrApi";
/* exportReport memoises its Cognito verifier per module instance (correct in
   production - one user pool, one verifier, no per-request setup cost). Each
   test therefore loads a fresh copy so it can stand in its own verifier. */
function loadExportHandler() {
  delete require.cache[require.resolve("../src/handlers/http/exportReport")];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../src/handlers/http/exportReport").handler as (e: any) => Promise<any>;
}

function qrEvent(method: string, path: string, body?: unknown): any {
  return {
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    headers: {},
    queryStringParameters: {},
    requestContext: { http: { method, sourceIp: "127.0.0.1" } },
  };
}

const parse = (res: any) => JSON.parse(res.body);

async function seedMenu() {
  const pool = await getPool();
  await resetDb();
  const foodCat = await seedCategory(pool, "food", "Mains");
  const alcCat = await seedCategory(pool, "alcohol", "Beer");
  const food = await seedItem(pool, { kind: "food", categoryId: foodCat, name: "Biryani", price: 260 });
  const beer = await seedItem(pool, { kind: "alcohol", categoryId: alcCat, name: "Lager", price: 200, taxRate: 18 });
  const soldOut = await seedItem(pool, { kind: "food", categoryId: foodCat, name: "Fish Fry", price: 300, stockQty: 0 });
  const tableId = await seedTable(pool, "Table 01");
  const token = (await pool.query("SELECT qr_token FROM restaurant_tables WHERE id=$1", [tableId])).rows[0].qr_token;
  return { pool, food, beer, soldOut, tableId, token };
}

// ------------------------------------------------------------------ QR menu

test("QR menu: a valid token lists the live catalog; an unknown token is refused", async () => {
  const { token } = await seedMenu();

  const res = await qrApi(qrEvent("GET", `/api/qr/menu/${token}`));
  assert.equal((res as any).statusCode, 200);
  const data = parse(res).data;
  assert.equal(data.table.label, "Table 01");
  const names = data.categories.flatMap((c: any) => c.items.map((i: any) => i.name));
  assert.ok(names.includes("Biryani"));
  assert.ok(names.includes("Lager"));
  const fishFry = data.categories.flatMap((c: any) => c.items).find((i: any) => i.name === "Fish Fry");
  assert.equal(fishFry.available, false, "a zero-stock item must show as unavailable");

  const bad = await qrApi(qrEvent("GET", "/api/qr/menu/not-a-real-token"));
  assert.equal((bad as any).statusCode, 404);
  assert.equal(parse(bad).success, false);
});

// ---------------------------------------------------------------- QR orders

test("QR order: the server re-prices every line and ignores what the browser sent", async () => {
  const { token, food } = await seedMenu();
  const res = await qrApi(qrEvent("POST", "/api/qr/orders", {
    token,
    customer_name: "Ravi",
    items: [{ id: food, kind: "food", qty: 2, price: 1, name: "Free Biryani" }],
  }));
  assert.equal((res as any).statusCode, 201);
  const order = parse(res).data;
  assert.equal(order.items[0].price, 260, "the price must come from the catalog, not the request");
  assert.equal(order.items[0].item_name, "Biryani");
  assert.equal(order.subtotal, 520);
  assert.equal(order.grand_total, 520, "food carries no tax");
  assert.match(order.order_no, /^QR-\d{6}$/);
  assert.equal(order.status, "NEW");
});

test("QR order: alcohol carries its tax, food does not", async () => {
  const { token, food, beer } = await seedMenu();
  const res = await qrApi(qrEvent("POST", "/api/qr/orders", {
    token, items: [{ id: food, kind: "food", qty: 1 }, { id: beer, kind: "alcohol", qty: 2 }],
  }));
  const order = parse(res).data;
  assert.equal(order.subtotal, 660);   // 260 + 400
  assert.equal(order.tax, 72);         // 18% of the 400 alcohol line only
  assert.equal(order.grand_total, 732);
});

test("QR order: order numbers are gap-free across consecutive orders", async () => {
  const { token, food } = await seedMenu();
  const numbers: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await qrApi(qrEvent("POST", "/api/qr/orders", { token, items: [{ id: food, kind: "food", qty: 1 }] }));
    numbers.push(Number(parse(res).data.order_no.split("-")[1]));
  }
  assert.deepEqual(numbers, [1, 2, 3, 4, 5]);
});

test("QR order: bad carts are refused, not half-accepted", async () => {
  const { token, food, soldOut } = await seedMenu();
  const cases: Array<[string, unknown]> = [
    ["empty cart", { token, items: [] }],
    ["unknown table", { token: "nope", items: [{ id: food, kind: "food", qty: 1 }] }],
    ["zero quantity", { token, items: [{ id: food, kind: "food", qty: 0 }] }],
    ["absurd quantity", { token, items: [{ id: food, kind: "food", qty: 9999 }] }],
    ["fractional quantity", { token, items: [{ id: food, kind: "food", qty: 2.5 }] }],
    ["unknown item", { token, items: [{ id: "item_does_not_exist", kind: "food", qty: 1 }] }],
    ["sold out item", { token, items: [{ id: soldOut, kind: "food", qty: 1 }] }],
    ["too many lines", { token, items: Array.from({ length: 41 }, () => ({ id: food, kind: "food", qty: 1 })) }],
  ];
  for (const [label, body] of cases) {
    const res = await qrApi(qrEvent("POST", "/api/qr/orders", body));
    assert.ok((res as any).statusCode >= 400, `${label} should be refused`);
    assert.equal(parse(res).success, false, label);
  }
  const pool = await getPool();
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM qr_orders");
  assert.equal(rows[0].n, 0, "no rejected cart may leave an order behind");
});

test("QR order: the customer can poll its status, and only their own table's orders", async () => {
  const { token, food } = await seedMenu();
  const created = parse(await qrApi(qrEvent("POST", "/api/qr/orders", {
    token, items: [{ id: food, kind: "food", qty: 1 }],
  }))).data;

  const polled = await qrApi(qrEvent("GET", `/api/qr/orders/${created.public_ref}`));
  assert.equal((polled as any).statusCode, 200);
  assert.equal(parse(polled).data.order_no, created.order_no);

  const missing = await qrApi(qrEvent("GET", "/api/qr/orders/deadbeef"));
  assert.equal((missing as any).statusCode, 404);

  const board = await qrApi(qrEvent("GET", `/api/qr/tables/${token}/orders`));
  assert.equal((board as any).statusCode, 200);
  assert.equal(parse(board).data.orders.length, 1);
});

// ------------------------------------------------------------- CSV export

async function seedBill(pool: any, opts: { billNo: string; type: string; customer: string; total: number; dateKey: string }) {
  await pool.query(
    `INSERT INTO bills (id, bill_no, bill_no_lower, type, source, customer_name, customer_phone, customer_name_lower,
       subtotal, discount, tax, grand_total, payment_method, status, created_at, date_key, hour, items)
     VALUES ($1,$2,$3,$4,'counter',$5,'123',lower($5),$6,0,0,$6,'Cash','confirmed',now(),$7,12,'[]'::jsonb)`,
    ["bill_" + opts.billNo, opts.billNo, opts.billNo.toLowerCase(), opts.type, opts.customer, opts.total, opts.dateKey],
  );
}

/** The export verifies its own Cognito token, so the test stands in for the
 * verifier the same way a deployed request would arrive already verified. */
function withFakeVerifier(
  claims: Record<string, string> | null,
  fn: (exportReport: (e: any) => Promise<any>) => Promise<void>,
) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("aws-jwt-verify");
  const original = mod.CognitoJwtVerifier.create;
  mod.CognitoJwtVerifier.create = () => ({
    verify: async () => {
      if (!claims) throw new Error("invalid token");
      return claims;
    },
  });
  const handler = loadExportHandler();
  return fn(handler).finally(() => { mod.CognitoJwtVerifier.create = original; });
}

function exportEvent(qs: Record<string, string>, auth = "Bearer faketoken"): any {
  return {
    rawPath: "/api/reports/export",
    headers: { authorization: auth },
    queryStringParameters: qs,
    isBase64Encoded: false,
    requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } },
  };
}

test("CSV export: refuses anonymous callers and non-manager roles", async () => {
  await resetDb();
  await withFakeVerifier({ "custom:role": "admin", sub: "u1" }, async (exportReport) => {
    const anon = await exportReport({ ...exportEvent({}), headers: {} });
    assert.equal(anon.statusCode, 401, "no Authorization header at all");
  });

  await withFakeVerifier(null, async (exportReport) => {
    const bad = await exportReport(exportEvent({}, "Bearer forged"));
    assert.equal(bad.statusCode, 401, "a token that does not verify");
  });

  await withFakeVerifier({ "custom:role": "billing", sub: "u1" }, async (exportReport) => {
    const res = await exportReport(exportEvent({}));
    assert.equal(res.statusCode, 403, "a cashier must not be able to export the sales book");
  });
});

test("CSV export: renders the bills in range and validates its parameters", async () => {
  const pool = await getPool();
  await resetDb();
  await pool.query(`INSERT INTO users (uid, username, username_lower, full_name, phone, role, status, created_at, updated_at)
                    VALUES ('u_admin','adm','adm','Admin','','admin','active',now(),now())`);
  await seedBill(pool, { billNo: "FOOD-000001", type: "FOOD", customer: "Asha", total: 250, dateKey: "2026-01-10" });
  await seedBill(pool, { billNo: "ALC-000001", type: "ALCOHOL", customer: "Ravi", total: 400, dateKey: "2026-02-20" });

  await withFakeVerifier({ "custom:role": "admin", sub: "u_admin", "custom:pos_uid": "u_admin", "cognito:username": "adm" }, async (exportReport) => {
    const all = await exportReport(exportEvent({ type: "all" }));
    assert.equal(all.statusCode, 200);
    assert.match(all.headers["Content-Type"], /text\/csv/);
    const lines = (all as any).body.split("\r\n");
    assert.equal(lines.length, 3, "header + two bills");
    assert.ok(lines[0].startsWith("Type,Bill No,Date"));

    const food = await exportReport(exportEvent({ type: "food" }));
    assert.equal((food as any).body.split("\r\n").length, 2);

    const ranged = await exportReport(exportEvent({ type: "all", from: "2026-02-01", to: "2026-02-28" }));
    const rangedLines = (ranged as any).body.split("\r\n");
    assert.equal(rangedLines.length, 2);
    assert.ok(rangedLines[1].includes("ALC-000001"));

    for (const qs of [{ type: "nonsense" }, { from: "10-01-2026" }, { to: "not-a-date" }]) {
      const bad = await exportReport(exportEvent(qs as any));
      assert.equal(bad.statusCode, 400, JSON.stringify(qs));
    }

    const audit = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='report.export'");
    assert.ok(audit.rows[0].n > 0, "every export must be audited");
  });
});

test("CSV export: a customer name that looks like a formula is neutralised", async () => {
  const pool = await getPool();
  await resetDb();
  await seedBill(pool, { billNo: "FOOD-000009", type: "FOOD", customer: '=HYPERLINK("http://evil","click")', total: 10, dateKey: "2026-03-01" });

  await withFakeVerifier({ "custom:role": "manager", sub: "u_m" }, async (exportReport) => {
    const res = await exportReport(exportEvent({ type: "food" }));
    const body = res.body as string;
    assert.ok(body.includes("'=HYPERLINK"), "the cell must be quoted so a spreadsheet treats it as text");
  });
});
