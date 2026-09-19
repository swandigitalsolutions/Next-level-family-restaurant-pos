#!/usr/bin/env node
/**
 * Replace the FOOD menu (categories + items + prices + images) with the
 * owner's printed menu card: aws/db/data/menu-card.json.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node seed-menu.mjs --dry     # print the plan, write nothing
 *   DATABASE_URL=postgres://... node seed-menu.mjs           # apply
 *   ... --file <path>   use another menu json (default data/menu-card.json)
 *   ... --images <path> image manifest (default data/menu-images.json, optional)
 *
 * Safety properties (this touches live catalog data, so each one is deliberate):
 *   - ONE transaction: any failure rolls everything back, never a half menu.
 *   - Idempotent: card items get deterministic ids (item_food_card_<slug>),
 *     re-running upserts in place. Editing menu-card.json and re-running
 *     updates prices / retires dropped items.
 *   - Nothing is DELETED. Old food items/categories are set status='inactive'
 *     (they vanish from POS, QR and Website menus). Past bills, orders and
 *     open sessions keep their own copies of names/prices so history is
 *     unaffected. Restore by re-activating in Menu Studio if ever needed.
 *   - Only kind='food' is touched. Alcohol and Cafe catalogs are NOT changed.
 *   - stock_qty is left NULL (untracked) on new items so they are always
 *     orderable; existing stock on a card item is preserved on re-run.
 *   - Refuses to run if the JSON has duplicate names, non-integer/<=0 prices.
 *
 * NOTE: if you also run migrate-from-firestore.mjs, run THIS AFTER it —
 * the ETL brings the old catalog across, this script then retires it.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    dry: { type: "boolean", default: false },
    file: { type: "string", default: join(here, "../data/menu-card.json") },
    images: { type: "string", default: join(here, "../data/menu-images.json") },
    "force-images": { type: "boolean", default: false },
  },
});

export const slugify = (s) =>
  String(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Pure: validate + flatten the card into category rows and item rows. */
export function buildPlan(card, images = {}) {
  if (!card || !Array.isArray(card.categories) || card.categories.length === 0) throw new Error("menu file has no categories");
  const cats = [];
  const items = [];
  const seenNames = new Set();
  const seenIds = new Set();
  card.categories.forEach((c, ci) => {
    const cname = String(c.name || "").trim();
    if (!cname) throw new Error(`category #${ci} has no name`);
    const cid = `cat_food_card_${slugify(cname)}`;
    if (seenIds.has(cid)) throw new Error(`duplicate category "${cname}"`);
    seenIds.add(cid);
    cats.push({ id: cid, name: cname, sort: (ci + 1) * 10 });
    if (!Array.isArray(c.items) || c.items.length === 0) throw new Error(`category "${cname}" has no items`);
    for (const it of c.items) {
      const [name, price, description] = it;
      const n = String(name || "").trim();
      if (!n) throw new Error(`empty item name in "${cname}"`);
      if (!Number.isInteger(price) || price <= 0) throw new Error(`bad price for "${n}": ${price}`);
      const lower = n.toLowerCase();
      if (seenNames.has(lower)) throw new Error(`duplicate item name "${n}"`);
      seenNames.add(lower);
      const id = `item_food_card_${slugify(n)}`;
      if (seenIds.has(id)) throw new Error(`item id collision for "${n}"`);
      seenIds.add(id);
      items.push({ id, name: n, lower, price, description: description || null, categoryId: cid, categoryName: cname, categorySort: (ci + 1) * 10, image: images[n] ?? null });
    }
  });
  return { cats, items };
}

async function main() {
  const card = JSON.parse(readFileSync(args.file, "utf8"));
  const images = existsSync(args.images) ? JSON.parse(readFileSync(args.images, "utf8")) : {};
  const plan = buildPlan(card, images);
  const withImg = plan.items.filter((i) => i.image).length;
  const forceImages = args["force-images"];
  console.log(`menu plan: ${plan.cats.length} categories, ${plan.items.length} items, ${withImg} with images, ${plan.items.length - withImg} without${forceImages ? " (--force-images: manifest overwrites existing photos)" : ""}`);
  if (args.dry) { console.log("--dry: nothing written."); return; }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const oldItems = await client.query(
      "UPDATE catalog SET status='inactive', updated_at=now() WHERE kind='food' AND status='active' AND id NOT LIKE 'item_food_card\\_%' ESCAPE '\\'");
    const oldCats = await client.query(
      "UPDATE categories SET status='inactive', updated_at=now() WHERE kind='food' AND status='active' AND id NOT LIKE 'cat_food_card\\_%' ESCAPE '\\'");
    for (const c of plan.cats) {
      await client.query(
        `INSERT INTO categories (id, kind, sales_channel, name, name_lower, sort_order, status, created_at, updated_at)
         VALUES ($1,'food','RESTAURANT',$2,$3,$4,'active',now(),now())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, name_lower=EXCLUDED.name_lower, sort_order=EXCLUDED.sort_order, status='active', updated_at=now()`,
        [c.id, c.name, c.name.toLowerCase(), c.sort]);
    }
    // The image manifest supplies a DEFAULT photo, it does not own the column.
    // An image set by hand (admin UI, a one-off correction) survives every
    // re-run of this script - re-seeding the menu to fix a price must not
    // silently revert the owner's photos. Pass --force-images when the
    // manifest is deliberately the source of truth and should overwrite.
    for (const it of plan.items) {
      await client.query(
        `INSERT INTO catalog (id, kind, sales_channel, name, name_lower, category_id, category_name, category_sort,
            price, tax_rate, stock_qty, description, status, image_path, created_at, updated_at)
         VALUES ($1,'food','RESTAURANT',$2,$3,$4,$5,$6,$7,0,NULL,$8,'active',$9,now(),now())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, name_lower=EXCLUDED.name_lower, category_id=EXCLUDED.category_id,
            category_name=EXCLUDED.category_name, category_sort=EXCLUDED.category_sort, price=EXCLUDED.price, tax_rate=0,
            description=EXCLUDED.description, status='active',
            image_path=${forceImages
              ? "COALESCE(EXCLUDED.image_path, catalog.image_path)"
              : "COALESCE(catalog.image_path, EXCLUDED.image_path)"}, updated_at=now()`,
        [it.id, it.name, it.lower, it.categoryId, it.categoryName, it.categorySort, it.price, it.description, it.image]);
    }
    // Card items that were dropped from the JSON since a previous run.
    const keepIds = plan.items.map((i) => i.id);
    const dropped = await client.query(
      "UPDATE catalog SET status='inactive', updated_at=now() WHERE kind='food' AND id LIKE 'item_food_card\\_%' ESCAPE '\\' AND status='active' AND NOT (id = ANY($1))", [keepIds]);
    const keepCats = plan.cats.map((c) => c.id);
    await client.query(
      "UPDATE categories SET status='inactive', updated_at=now() WHERE kind='food' AND id LIKE 'cat_food_card\\_%' ESCAPE '\\' AND status='active' AND NOT (id = ANY($1))", [keepCats]);
    await client.query(
      `INSERT INTO audit_log (actor_role, actor_username, action, entity_type, entity_id, details)
       VALUES ('system','seed-menu.mjs','menu.replace_from_card','food_menu','card',$1)`,
      [JSON.stringify({ categories: plan.cats.length, items: plan.items.length, retired_items: oldItems.rowCount + dropped.rowCount, retired_categories: oldCats.rowCount })]);
    await client.query("COMMIT");
    console.log(`applied: ${plan.items.length} items live; retired ${oldItems.rowCount} old items, ${oldCats.rowCount} old categories, ${dropped.rowCount} dropped card items.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("FAILED, rolled back, nothing changed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
