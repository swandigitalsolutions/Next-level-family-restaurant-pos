/**
 * Catalog + category management — Lambda port of
 * firebase/functions/src/callable/catalogAdmin.ts. admin/manager only.
 * Category CRUD is not audited (matches the Firebase version); item
 * create/price-change/delete ARE (menu.item.*).
 */
import { dispatch } from "../../lib/callable";
import { HttpError, assertManager } from "../../lib/authz";
import { salesChannelForKind } from "../../lib/config";
import { toFloat, toOptionalStock } from "../../lib/money";
import { lower } from "../../lib/normalize";
import { writeAudit } from "../../lib/audit";
import { getPool } from "../../lib/db";
import { randomUUID } from "crypto";

const kindOf = (v: unknown): "food" | "alcohol" | "cafe" => {
  const s = String(v).toLowerCase();
  return s === "alcohol" ? "alcohol" : s === "cafe" ? "cafe" : "food";
};

export const handler = dispatch({
  async upsertCategory(body, event) {
    assertManager(event as any);
    const pool = await getPool();
    const kind = kindOf(body?.kind);
    const id = body?.id ? String(body.id) : null;
    const name = String(body?.name ?? "").trim();
    if (!id && !name) throw new HttpError(422, "invalid-argument", "Category name is required");

    if (!id) {
      const dup = await pool.query("SELECT 1 FROM categories WHERE kind=$1 AND name_lower=$2 LIMIT 1", [kind, lower(name)]);
      if (dup.rowCount) throw new HttpError(409, "already-exists", "A category with this name already exists");
      const maxRes = await pool.query("SELECT coalesce(max(sort_order), -1) AS m FROM categories WHERE kind=$1", [kind]);
      const newId = "cat_" + randomUUID();
      const sortOrder = Number(maxRes.rows[0].m) + 1;
      await pool.query(
        `INSERT INTO categories (id, kind, sales_channel, name, name_lower, sort_order, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'active',now(),now())`,
        [newId, kind, salesChannelForKind(kind), name, lower(name), sortOrder],
      );
      return { id: newId, kind, salesChannel: salesChannelForKind(kind), name, sortOrder, status: "active" };
    }

    const cur = await pool.query("SELECT * FROM categories WHERE id=$1", [id]);
    if (!cur.rowCount) throw new HttpError(404, "not-found", "Category not found");
    const c = cur.rows[0];
    const newName = name || c.name;
    const status = body?.status ? String(body.status) : c.status;
    await pool.query("UPDATE categories SET name=$2, name_lower=$3, status=$4, updated_at=now() WHERE id=$1", [id, newName, lower(newName), status]);
    if (newName !== c.name) {
      await pool.query("UPDATE catalog SET category_name=$2, updated_at=now() WHERE category_id=$1", [id, newName]);
    }
    return { id, ...c, name: newName, status };
  },

  async deleteCategory(body, event) {
    assertManager(event as any);
    const pool = await getPool();
    const id = String(body?.id ?? "");
    if (!id) throw new HttpError(422, "invalid-argument", "id is required");
    const cur = await pool.query("SELECT 1 FROM categories WHERE id=$1", [id]);
    if (!cur.rowCount) throw new HttpError(404, "not-found", "Category not found");
    const active = await pool.query("SELECT 1 FROM catalog WHERE category_id=$1 AND status='active' LIMIT 1", [id]);
    if (active.rowCount) throw new HttpError(409, "failed-precondition", "Cannot delete a category that still has active items");
    await pool.query("UPDATE categories SET status='inactive', updated_at=now() WHERE id=$1", [id]);
    return { message: "Category deleted" };
  },

  async upsertCatalogItem(body, event) {
    const caller = assertManager(event as any);
    const pool = await getPool();
    const kind = kindOf(body?.kind);
    const id = body?.id ? String(body.id) : null;

    if (!id) {
      const name = String(body?.name ?? "").trim();
      if (!name) throw new HttpError(422, "invalid-argument", kind === "food" ? "Item name is required" : "Product name is required");
      const categoryId = String(body?.category_id ?? "");
      if (!categoryId) throw new HttpError(422, "invalid-argument", "category_id is required");
      const price = toFloat(body?.price, "price");
      const stockQty = toOptionalStock(body?.stock_qty, "stock_qty");
      const taxRate = kind === "alcohol" ? toFloat(body?.tax_rate ?? 0, "tax_rate") : 0;
      const catRes = await pool.query("SELECT name, sort_order FROM categories WHERE id=$1", [categoryId]);
      if (!catRes.rowCount) throw new HttpError(404, "not-found", "Category not found");

      const newId = `item_${kind}_` + randomUUID();
      await pool.query(
        `INSERT INTO catalog (id, kind, sales_channel, name, name_lower, category_id, category_name, category_sort,
           price, tax_rate, stock_qty, brand, bottle_size, description, status, image_path, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',$15,now(),now())`,
        [newId, kind, salesChannelForKind(kind), name, lower(name), categoryId, catRes.rows[0].name, catRes.rows[0].sort_order,
         price, taxRate, stockQty, kind === "alcohol" ? String(body?.brand ?? "").trim() || null : null,
         kind === "alcohol" ? String(body?.bottle_size ?? "").trim() || null : null,
         kind !== "alcohol" ? String(body?.description ?? "").trim() || null : null,
         String(body?.image_url ?? "").trim() || null],
      );
      await writeAudit({ actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action: "menu.item.create", entityType: kind === "food" ? "food_item" : kind === "cafe" ? "cafe_item" : "alcohol_item", entityId: newId, details: { name, price } });
      return { id: newId, kind, name, price, status: "active" };
    }

    const curRes = await pool.query("SELECT * FROM catalog WHERE id=$1", [id]);
    if (!curRes.rowCount) throw new HttpError(404, "not-found", "Item not found");
    const cur = curRes.rows[0];
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);

    const name = has("name") ? String(body.name ?? "").trim() || cur.name : cur.name;
    const categoryId = has("category_id") ? String(body.category_id) : cur.category_id;
    const price = has("price") ? toFloat(body.price, "price") : Number(cur.price);
    const stockQty = has("stock_qty") ? toOptionalStock(body.stock_qty, "stock_qty") : cur.stock_qty ?? null;
    const taxRate = cur.kind === "alcohol" && has("tax_rate") ? toFloat(body.tax_rate, "tax_rate") : Number(cur.tax_rate) || 0;
    const description = has("description") ? String(body.description ?? "").trim() || null : cur.description ?? null;
    const brand = has("brand") ? String(body.brand ?? "").trim() || null : cur.brand ?? null;
    const bottleSize = has("bottle_size") ? String(body.bottle_size ?? "").trim() || null : cur.bottle_size ?? null;
    const status = has("status") ? String(body.status) : cur.status;
    const imagePath = has("image_url") ? String(body.image_url ?? "").trim() || null : cur.image_path ?? null;

    let categoryName = cur.category_name, categorySort = cur.category_sort;
    if (categoryId !== cur.category_id) {
      const catRes = await pool.query("SELECT name, sort_order FROM categories WHERE id=$1", [categoryId]);
      if (!catRes.rowCount) throw new HttpError(404, "not-found", "Category not found");
      categoryName = catRes.rows[0].name; categorySort = catRes.rows[0].sort_order;
    }

    await pool.query(
      `UPDATE catalog SET name=$2, name_lower=$3, category_id=$4, category_name=$5, category_sort=$6, price=$7,
         tax_rate=$8, stock_qty=$9, description=$10, image_path=$11, brand=$12, bottle_size=$13, status=$14, updated_at=now()
       WHERE id=$1`,
      [id, name, lower(name), categoryId, categoryName, categorySort, price, taxRate, stockQty, description, imagePath, brand, bottleSize, status],
    );
    if (Number(cur.price) !== Number(price)) {
      await writeAudit({ actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action: "menu.item.price_change", entityType: cur.kind === "food" ? "food_item" : cur.kind === "cafe" ? "cafe_item" : "alcohol_item", entityId: id, details: { name, price: { from: Number(cur.price), to: price } } });
    }
    return { id, name, price, status };
  },

  async deleteCatalogItem(body, event) {
    const caller = assertManager(event as any);
    const pool = await getPool();
    const id = String(body?.id ?? "");
    if (!id) throw new HttpError(422, "invalid-argument", "id is required");
    const cur = await pool.query("SELECT name, kind FROM catalog WHERE id=$1", [id]);
    if (!cur.rowCount) throw new HttpError(404, "not-found", "Item not found");
    await pool.query("UPDATE catalog SET status='inactive', updated_at=now() WHERE id=$1", [id]);
    await writeAudit({ actorUid: caller.uid, actorUsername: caller.username || null, actorRole: caller.role, action: "menu.item.delete", entityType: cur.rows[0].kind === "food" ? "food_item" : cur.rows[0].kind === "cafe" ? "cafe_item" : "alcohol_item", entityId: id, details: { name: cur.rows[0].name } });
    return { message: "Item deleted" };
  },
});
