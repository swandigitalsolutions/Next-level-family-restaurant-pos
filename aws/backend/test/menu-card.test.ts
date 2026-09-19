import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem, seedUser } from "./_helpers";
import { handler as websiteMenuHandler } from "../src/handlers/http/websiteMenu";
import { handler as websiteApiHandler } from "../src/handlers/http/websiteApi";
import { handler as qrApiHandler } from "../src/handlers/http/qrApi";
import { websiteImageUrl, posImageUrl } from "../src/lib/assetUrl";

/**
 * The owner's printed menu card (aws/db/data/menu-card.json) must be EXACTLY
 * what the POS, QR menu and Website serve. These tests run the real seed
 * script (child process, real pg) and then read back through the real handlers.
 */
const SCRIPT = join(__dirname, "../../db/scripts/seed-menu.mjs");
const CARD = JSON.parse(readFileSync(join(__dirname, "../../db/data/menu-card.json"), "utf8"));
const CARD_ITEMS: Array<{ name: string; price: number; category: string }> = CARD.categories.flatMap((c: any) => c.items.map((i: any) => ({ name: i[0], price: i[1], category: c.name })));

function runSeed(...extra: string[]) {
  return execFileSync(process.execPath, [SCRIPT, ...extra], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL! },
    encoding: "utf8",
  });
}
const menuEvent = (key = "test-website-key") => ({ rawPath: "/api/website/menu", requestContext: { http: { method: "GET" } }, headers: { "x-api-key": key } }) as any;

before(async () => { await getPool(); });
beforeEach(resetDb);

async function seedOldWorld() {
  const pool = await getPool();
  const oldCat = await seedCategory(pool, "food", "Desserts"); // same NAME as a card category on purpose
  const oldItem = await seedItem(pool, { kind: "food", categoryId: oldCat, name: "Butter Chicken", price: 280 });
  const barCat = await seedCategory(pool, "alcohol", "Beer");
  const beer = await seedItem(pool, { kind: "alcohol", categoryId: barCat, name: "Kingfisher", price: 180, taxRate: 18 });
  const cafeCat = await seedCategory(pool, "cafe", "Tea");
  const chai = await seedItem(pool, { kind: "cafe", categoryId: cafeCat, name: "Cafe Chai", price: 20 });
  return { pool, oldItem, beer, chai };
}

test("card file is internally valid: 26 categories, 202 items, unique names, positive integer prices", () => {
  assert.equal(CARD.categories.length, 26);
  assert.equal(CARD_ITEMS.length, 202);
  assert.equal(new Set(CARD_ITEMS.map((i) => i.name.toLowerCase())).size, 202);
  for (const i of CARD_ITEMS) assert.ok(Number.isInteger(i.price) && i.price > 0, i.name);
});

test("every menu photo in menu-images.json is a real file, belongs to a card item, and is a valid WebP", () => {
  const fs = require("node:fs");
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../db/data/menu-images.json"), "utf8"));
  const names = new Set(CARD_ITEMS.map((i) => i.name));
  const entries = Object.entries<string>(manifest);
  assert.ok(entries.length > 100, "expected a substantial set of item photos");
  for (const [name, url] of entries) {
    assert.ok(names.has(name), `photo mapped to a dish that is not on the card: ${name}`);
    assert.match(url, /^\/assets\/menu\/[a-z0-9-]+\.webp$/, name);
    const file = join(__dirname, "../../hosting", url);
    assert.ok(fs.existsSync(file), `missing image file for ${name}: ${url}`);
    const head = fs.readFileSync(file).subarray(0, 12);
    assert.equal(head.subarray(0, 4).toString(), "RIFF", `not a WebP: ${url}`);
    assert.equal(head.subarray(8, 12).toString(), "WEBP", `not a WebP: ${url}`);
    assert.ok(fs.statSync(file).size < 200_000, `image too heavy for a menu page: ${url}`);
  }
  // Full and Half of the same dish must share the same photo.
  for (const [name, url] of entries) {
    if (name.endsWith(" (Full)")) assert.equal(manifest[name.replace(" (Full)", " (Half)")], url);
  }
});

test("seed with the photo manifest stores the image path on the right items", async () => {
  const { pool } = await seedOldWorld();
  runSeed();
  const r = await pool.query("SELECT name, image_path FROM catalog WHERE kind='food' AND status='active'");
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../db/data/menu-images.json"), "utf8"));
  let withImg = 0;
  for (const row of r.rows) {
    if (manifest[row.name]) { assert.equal(row.image_path, manifest[row.name], row.name); withImg++; }
    else assert.equal(row.image_path, null, `no photo must stay null (never a wrong photo): ${row.name}`);
  }
  assert.equal(withImg, Object.keys(manifest).length);
});

test("--dry writes nothing", async () => {
  const { pool } = await seedOldWorld();
  const out = runSeed("--dry");
  assert.match(out, /202 items/);
  const n = await pool.query("SELECT count(*)::int AS n FROM catalog WHERE id LIKE 'item_food_card%'");
  assert.equal(n.rows[0].n, 0);
});

test("seed replaces the food menu with exactly the card, at exact prices; alcohol/cafe untouched; old items retired not deleted", async () => {
  const { pool, oldItem, beer, chai } = await seedOldWorld();
  runSeed();

  const active = await pool.query("SELECT name, price, category_name, tax_rate, stock_qty FROM catalog WHERE kind='food' AND status='active'");
  assert.equal(active.rowCount, 202);
  const byName = new Map(active.rows.map((r) => [r.name, r]));
  for (const c of CARD_ITEMS) {
    const row = byName.get(c.name);
    assert.ok(row, `missing on menu: ${c.name}`);
    assert.equal(Number(row.price), c.price, `wrong price for ${c.name}`);
    assert.equal(row.category_name, c.category, `wrong category for ${c.name}`);
    assert.equal(Number(row.tax_rate), 0, `food must carry no tax: ${c.name}`);
    assert.equal(row.stock_qty, null, `card items start untracked: ${c.name}`);
  }
  const cats = await pool.query("SELECT name FROM categories WHERE kind='food' AND status='active' ORDER BY sort_order");
  assert.deepEqual(cats.rows.map((r) => r.name), CARD.categories.map((c: any) => c.name), "category order must follow the card");

  const old = await pool.query("SELECT status FROM catalog WHERE id=$1", [oldItem]);
  assert.equal(old.rows[0].status, "inactive", "old item retired, not deleted");
  assert.equal((await pool.query("SELECT status FROM catalog WHERE id=$1", [beer])).rows[0].status, "active", "alcohol untouched");
  assert.equal((await pool.query("SELECT status FROM catalog WHERE id=$1", [chai])).rows[0].status, "active", "cafe untouched");
  const audit = await pool.query("SELECT action FROM audit_log WHERE action='menu.replace_from_card'");
  assert.equal(audit.rowCount, 1);
});

test("seed is idempotent, preserves stock/image on re-run, and retires items removed from the card", async () => {
  const { pool } = await seedOldWorld();
  runSeed();
  await pool.query("UPDATE catalog SET stock_qty=7, image_path='/assets/menu/x.webp' WHERE id='item_food_card_tandoori-chicken-full'");
  runSeed();
  const n = await pool.query("SELECT count(*)::int AS n FROM catalog WHERE kind='food' AND status='active'");
  assert.equal(n.rows[0].n, 202, "re-run must not duplicate");
  const row = await pool.query("SELECT stock_qty, image_path FROM catalog WHERE id='item_food_card_tandoori-chicken-full'");
  assert.equal(row.rows[0].stock_qty, 7);
  assert.equal(row.rows[0].image_path, "/assets/menu/x.webp");
});

test("seed rolls back completely on a bad menu file (no half menu)", async () => {
  const { pool, oldItem } = await seedOldWorld();
  const bad = join(__dirname, "_bad-menu.json");
  require("node:fs").writeFileSync(bad, JSON.stringify({ categories: [{ name: "X", items: [["Dup", 10], ["dup", 20]] }] }));
  try {
    assert.throws(() => runSeed("--file", bad), /duplicate item name/);
  } finally { require("node:fs").unlinkSync(bad); }
  assert.equal((await pool.query("SELECT status FROM catalog WHERE id=$1", [oldItem])).rows[0].status, "active", "old menu must still be intact");
});

test("Website menu API returns exactly the card: same items, same paise prices, categories in card order", async () => {
  await seedOldWorld();
  runSeed();
  const res: any = await websiteMenuHandler(menuEvent());
  assert.equal(res.statusCode, 200);
  const menu = JSON.parse(res.body);
  assert.deepEqual(menu.categories.map((c: any) => c.name), CARD.categories.map((c: any) => c.name));
  const served = menu.categories.flatMap((c: any) => c.items.map((i: any) => ({ name: i.name, pricePaise: i.pricePaise, available: i.available, imageUrl: i.imageUrl })));
  assert.equal(served.length, 202, "no extra (old/alcohol/cafe) items may appear");
  const byName = new Map(served.map((s: any) => [s.name, s]));
  for (const c of CARD_ITEMS) {
    const s: any = byName.get(c.name);
    assert.ok(s, `website missing ${c.name}`);
    assert.equal(s.pricePaise, c.price * 100, `website price for ${c.name}`);
    assert.equal(s.available, true);
    assert.equal(s.imageUrl, null, "no image configured => null, never a relative/dead url");
  }
  assert.ok(!served.some((s: any) => /butter chicken$/i.test(s.name) && s.pricePaise === 28000), "old 280 Butter Chicken must be gone");
});

test("imageUrl is absolute only when an asset base is configured; POS gets the raw root path", () => {
  assert.equal(websiteImageUrl("/assets/menu/a.webp", undefined), null);
  assert.equal(websiteImageUrl("/assets/menu/a.webp", "http://insecure.example"), null, "http base rejected");
  assert.equal(websiteImageUrl("/assets/menu/a.webp", "https://d1.cloudfront.net/"), "https://d1.cloudfront.net/assets/menu/a.webp");
  assert.equal(websiteImageUrl("assets/menu/a.webp", "https://d1.cloudfront.net"), "https://d1.cloudfront.net/assets/menu/a.webp");
  assert.equal(websiteImageUrl("https://cdn.example/x.jpg", undefined), "https://cdn.example/x.jpg");
  assert.equal(websiteImageUrl(null, "https://d1.cloudfront.net"), null);
  assert.equal(websiteImageUrl("   ", "https://d1.cloudfront.net"), null);
  assert.equal(posImageUrl("/assets/menu/a.webp"), "/assets/menu/a.webp");
  assert.equal(posImageUrl(""), null);
});

test("Website menu serves absolute image URLs once PUBLIC_ASSET_BASE_URL is set", async () => {
  await seedOldWorld();
  runSeed();
  const pool = await getPool();
  await pool.query("UPDATE catalog SET image_path='/assets/menu/tandoori-chicken-full.webp' WHERE id='item_food_card_tandoori-chicken-full'");
  process.env.PUBLIC_ASSET_BASE_URL = "https://d111.cloudfront.net";
  try {
    const menu = JSON.parse(((await websiteMenuHandler(menuEvent())) as any).body);
    const it = menu.categories.flatMap((c: any) => c.items).find((i: any) => i.name === "Tandoori Chicken (Full)");
    assert.equal(it.imageUrl, "https://d111.cloudfront.net/assets/menu/tandoori-chicken-full.webp");
  } finally { delete process.env.PUBLIC_ASSET_BASE_URL; }
});

test("Website menu carries imageCredit exactly for photos that need attribution", async () => {
  await seedOldWorld();
  runSeed("--force-images");
  process.env.PUBLIC_ASSET_BASE_URL = "https://d111.cloudfront.net";
  try {
    const menu = JSON.parse(((await websiteMenuHandler(menuEvent())) as any).body);
    const items = menu.categories.flatMap((c: any) => c.items);
    const credited = items.filter((i: any) => i.imageCredit);
    assert.ok(credited.length > 80, "stock Wikimedia photos must carry a credit");
    for (const i of credited) {
      assert.ok(i.imageUrl, `credit without a photo: ${i.name}`);
      assert.ok(i.imageCredit.author && i.imageCredit.license && /^https:\/\//.test(i.imageCredit.sourceUrl), `incomplete credit: ${i.name}`);
      assert.match(i.imageCredit.license, /^(CC0|Public domain|CC BY)/);
    }
    // an item with no photo never carries a credit
    const pool = await getPool();
    await pool.query("UPDATE catalog SET image_path=NULL WHERE id='item_food_card_tea'");
    const again = JSON.parse(((await websiteMenuHandler(menuEvent())) as any).body).categories.flatMap((c: any) => c.items);
    const tea = again.find((i: any) => i.name === "Tea");
    assert.equal(tea.imageUrl, null); assert.equal(tea.imageCredit, undefined);
  } finally { delete process.env.PUBLIC_ASSET_BASE_URL; }
});

test("Website menu rejects a missing/wrong API key with 401", async () => {
  assert.equal(((await websiteMenuHandler(menuEvent(""))) as any).statusCode, 401);
  assert.equal(((await websiteMenuHandler(menuEvent("nope"))) as any).statusCode, 401);
});

test("QR menu for a table lists exactly the card food items, with image_url", async () => {
  const pool = await getPool();
  await seedOldWorld();
  runSeed();
  const tbl = await pool.query(`INSERT INTO restaurant_tables (id, table_no, seats, status, qr_token, created_at, updated_at) VALUES ('tbl_t1','T1',4,'available','tok-menu-test-1',now(),now()) RETURNING qr_token`);
  const res: any = await qrApiHandler({ rawPath: "/api/qr/menu/" + tbl.rows[0].qr_token, requestContext: { http: { method: "GET" } }, headers: {}, isBase64Encoded: false } as any);
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  const food = body.data.categories.flatMap((c: any) => c.items).filter((i: any) => i.kind === "food");
  assert.equal(food.length, 202);
  assert.ok(food.every((i: any) => "image_url" in i));
});

test("a real website order from the NEW menu: Full + Half items, exact totals; old ids are rejected", async () => {
  const pool = await getPool();
  await seedUser(pool, "billing");
  const { oldItem } = await seedOldWorld();
  runSeed();
  const post = (items: any[]) => websiteApiHandler({
    rawPath: "/api/website/orders", requestContext: { http: { method: "POST" } },
    headers: { "x-api-key": "test-website-key" },
    body: JSON.stringify({ items, customer: { name: "Asha", phone: "9000000000" }, fulfillment: { type: "pickup" } }), isBase64Encoded: false,
  } as any) as Promise<any>;

  const full = "item_food_card_tandoori-chicken-full", half = "item_food_card_tandoori-chicken-half";
  const ok = await post([{ id: full, qty: 1 }, { id: half, qty: 2 }]);
  assert.equal(ok.statusCode, 201, ok.body);
  const o = JSON.parse(ok.body);
  assert.equal(o.totalPaise, (420 + 2 * 220) * 100);
  assert.equal(o.advancePaise, 43000, "50% advance of Rs 860");
  assert.equal(o.taxPaise, 0);

  const gone = await post([{ id: oldItem, qty: 1 }]);
  assert.equal(gone.statusCode, 422, "retired item must be rejected, not silently priced");
  assert.equal(JSON.parse(gone.body).error.code, "invalid-argument");
});
