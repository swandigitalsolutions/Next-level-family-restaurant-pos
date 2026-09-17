/**
 * Catalog + category management — replaces Flask
 *   /api/food|alcohol/categories  (GET is a direct Firestore read now)
 *   /api/food|alcohol/items
 * admin/manager only (MANAGE_ROLES). Category CRUD is NOT audited by Flask;
 * item create / price change / delete ARE (menu.item.*).
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { REGION, salesChannelForKind } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { assertManager } from "../lib/authz";
import { toFloat, toOptionalStock } from "../lib/money";
import { lower } from "../lib/normalize";
import { writeAudit } from "../lib/audit";
import { callable } from "../lib/wrap";

const kindOf = (v: unknown): "food" | "alcohol" | "cafe" => {
  const s = String(v).toLowerCase();
  return s === "alcohol" ? "alcohol" : s === "cafe" ? "cafe" : "food";
};

// ============================================================== categories

export interface UpsertCategoryInput {
  kind?: unknown;
  id?: unknown;
  name?: unknown;
  status?: unknown;
}

export async function handleUpsertCategory(req: CallableRequest<UpsertCategoryInput>) {
  assertManager(req);
  const db = getDb();
  const kind = kindOf(req.data?.kind);
  const id = req.data?.id ? String(req.data.id) : null;
  const name = String(req.data?.name ?? "").trim();

  if (!id && !name) throw new HttpsError("invalid-argument", "Category name is required");

  const col = db.collection("categories");
  if (!id) {
    // create — Flask: 409 on duplicate name, sort_order = max + 1
    const dup = await col
      .where("kind", "==", kind)
      .where("nameLower", "==", lower(name))
      .limit(1)
      .get();
    if (!dup.empty) {
      throw new HttpsError("already-exists", "A category with this name already exists");
    }
    const all = await col.where("kind", "==", kind).get();
    const maxOrder = all.docs.reduce((m, d) => Math.max(m, Number(d.data().sortOrder) || 0), -1);
    const ref = col.doc();
    const now = new Date();
    const data = {
      kind,
      salesChannel: salesChannelForKind(kind),
      name,
      nameLower: lower(name),
      sortOrder: maxOrder + 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(data);
    return { id: ref.id, ...data };
  }

  // update — name and/or status
  const ref = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Category not found");
  const cur = snap.data()!;
  const newName = name || cur.name;
  const status = req.data?.status ? String(req.data.status) : cur.status;
  const patch: Record<string, unknown> = {
    name: newName,
    nameLower: lower(newName),
    status,
    updatedAt: new Date(),
  };
  await ref.set(patch, { merge: true });
  // keep catalog denormalized categoryName in sync
  if (newName !== cur.name) {
    const items = await db.collection("catalog").where("categoryId", "==", id).get();
    await Promise.all(items.docs.map((d) => d.ref.update({ categoryName: newName, updatedAt: new Date() })));
  }
  return { id, ...cur, ...patch };
}

export interface DeleteCategoryInput {
  id?: unknown;
}

export async function handleDeleteCategory(req: CallableRequest<DeleteCategoryInput>) {
  assertManager(req);
  const db = getDb();
  const id = String(req.data?.id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "id is required");
  const ref = db.collection("categories").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Category not found");

  const active = await db
    .collection("catalog")
    .where("categoryId", "==", id)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (!active.empty) {
    throw new HttpsError(
      "failed-precondition",
      "Cannot delete a category that still has active items",
    );
  }
  await ref.set({ status: "inactive", updatedAt: new Date() }, { merge: true });
  return { message: "Category deleted" };
}

// ================================================================== items

export interface UpsertCatalogItemInput {
  kind?: unknown;
  id?: unknown;
  name?: unknown;
  category_id?: unknown;
  price?: unknown;
  stock_qty?: unknown;
  description?: unknown;
  brand?: unknown;
  bottle_size?: unknown;
  tax_rate?: unknown;
  status?: unknown;
  image_url?: unknown;
}

async function categoryMeta(db: FirebaseFirestore.Firestore, categoryId: string) {
  const c = await db.collection("categories").doc(categoryId).get();
  if (!c.exists) throw new HttpsError("not-found", "Category not found");
  return { name: c.data()?.name ?? "", sort: Number(c.data()?.sortOrder) || 0 };
}

export async function handleUpsertCatalogItem(req: CallableRequest<UpsertCatalogItemInput>) {
  const caller = assertManager(req);
  const db = getDb();
  const kind = kindOf(req.data?.kind);
  const id = req.data?.id ? String(req.data.id) : null;
  const col = db.collection("catalog");

  {
    if (!id) {
      // ---- create (Flask add_food_item / add_alcohol_item) ----
      const name = String(req.data?.name ?? "").trim();
      if (!name) {
        throw new HttpsError(
          "invalid-argument",
          kind === "food" ? "Item name is required" : "Product name is required",
        );
      }
      const categoryId = String(req.data?.category_id ?? "");
      if (!categoryId) throw new HttpsError("invalid-argument", "category_id is required");
      const price = toFloat(req.data?.price, "price");
      const stockQty = toOptionalStock(req.data?.stock_qty, "stock_qty");
      const taxRate = kind === "alcohol" ? toFloat(req.data?.tax_rate ?? 0, "tax_rate") : 0;
      const meta = await categoryMeta(db, categoryId);

      const ref = col.doc();
      const now = new Date();
      const data = {
        kind,
        salesChannel: salesChannelForKind(kind),
        name,
        nameLower: lower(name),
        categoryId,
        categoryName: meta.name,
        categorySort: meta.sort,
        price,
        taxRate,
        stockQty,
        brand: kind === "alcohol" ? String(req.data?.brand ?? "").trim() || null : null,
        bottleSize: kind === "alcohol" ? String(req.data?.bottle_size ?? "").trim() || null : null,
        description:
          kind !== "alcohol" ? String(req.data?.description ?? "").trim() || null : null,
        status: "active",
        imagePath: String(req.data?.image_url ?? "").trim() || null,
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(data);
      await writeAudit({
        actorUid: caller.uid,
        actorUsername: caller.username || null,
        actorRole: caller.role,
        action: "menu.item.create",
        entityType: kind === "food" ? "food_item" : kind === "cafe" ? "cafe_item" : "alcohol_item",
        entityId: ref.id,
        details: { name, price },
      });
      return { id: ref.id, ...data };
    }

    // ---- update (partial, Flask update_food_item / update_alcohol_item) ----
    const ref = col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Item not found");
    const cur = snap.data()!;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(req.data ?? {}, k);

    const name = has("name") ? String(req.data!.name ?? "").trim() || cur.name : cur.name;
    const categoryId = has("category_id") ? String(req.data!.category_id) : cur.categoryId;
    const price = has("price") ? toFloat(req.data!.price, "price") : Number(cur.price);
    const stockQty = has("stock_qty")
      ? toOptionalStock(req.data!.stock_qty, "stock_qty")
      : cur.stockQty ?? null;
    const taxRate =
      cur.kind === "alcohol" && has("tax_rate")
        ? toFloat(req.data!.tax_rate, "tax_rate")
        : Number(cur.taxRate) || 0;
    const description = has("description")
      ? String(req.data!.description ?? "").trim() || null
      : cur.description ?? null;
    const brand = has("brand") ? String(req.data!.brand ?? "").trim() || null : cur.brand ?? null;
    const bottleSize = has("bottle_size")
      ? String(req.data!.bottle_size ?? "").trim() || null
      : cur.bottleSize ?? null;
    const status = has("status") ? String(req.data!.status) : cur.status;
    const imagePath = has("image_url")
      ? String(req.data!.image_url ?? "").trim() || null
      : cur.imagePath ?? null;

    const meta =
      categoryId !== cur.categoryId
        ? await categoryMeta(db, categoryId)
        : { name: cur.categoryName, sort: Number(cur.categorySort) || 0 };

    const patch = {
      name,
      nameLower: lower(name),
      categoryId,
      categoryName: meta.name,
      categorySort: meta.sort,
      price,
      taxRate,
      stockQty,
      description,
      imagePath,
      brand,
      bottleSize,
      status,
      updatedAt: new Date(),
    };
    await ref.set(patch, { merge: true });

    if (Number(cur.price) !== Number(price)) {
      await writeAudit({
        actorUid: caller.uid,
        actorUsername: caller.username || null,
        actorRole: caller.role,
        action: "menu.item.price_change",
        entityType: cur.kind === "food" ? "food_item" : cur.kind === "cafe" ? "cafe_item" : "alcohol_item",
        entityId: id,
        details: { name, price: { from: Number(cur.price), to: price } },
      });
    }
    return { id, ...cur, ...patch };
  }
}

export interface DeleteCatalogItemInput {
  id?: unknown;
}

export async function handleDeleteCatalogItem(req: CallableRequest<DeleteCatalogItemInput>) {
  const caller = assertManager(req);
  const db = getDb();
  const id = String(req.data?.id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "id is required");
  const ref = db.collection("catalog").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Item not found");
  const cur = snap.data()!;
  await ref.set({ status: "inactive", updatedAt: new Date() }, { merge: true });
  await writeAudit({
    actorUid: caller.uid,
    actorUsername: caller.username || null,
    actorRole: caller.role,
    action: "menu.item.delete",
    entityType: cur.kind === "food" ? "food_item" : cur.kind === "cafe" ? "cafe_item" : "alcohol_item",
    entityId: id,
    details: { name: cur.name },
  });
  return { message: "Item deleted" };
}

// ------------------------------------------------------------------- exports

export const upsertCategory = onCall({ region: REGION }, callable(handleUpsertCategory));
export const deleteCategory = onCall({ region: REGION }, callable(handleDeleteCategory));
export const upsertCatalogItem = onCall({ region: REGION }, callable(handleUpsertCatalogItem));
export const deleteCatalogItem = onCall({ region: REGION }, callable(handleDeleteCatalogItem));
