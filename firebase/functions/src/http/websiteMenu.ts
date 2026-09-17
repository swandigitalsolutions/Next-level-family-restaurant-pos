/**
 * GET /api/website/menu — replaces Flask website_menu (backend/app.py).
 * Server-to-server, X-API-Key auth (WEBSITE_API_KEYS env, comma-separated).
 * Food only, active only. Response shape is byte-compatible with API.md.
 *
 *   id:        migrated items keep their numeric legacyId so the existing
 *              website integration is unaffected; items created after the
 *              migration return their Firestore doc id (string). `legacyId`
 *              is also included for transition.
 *   available: status==active AND (stockQty is null OR > 0)
 *   updatedAt: ISO-8601 UTC, max updatedAt across everything returned.
 */
import { onRequest } from "firebase-functions/v2/https";
import { REGION } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";

function allowedKeys(): Set<string> {
  return new Set(
    String(process.env.WEBSITE_API_KEYS || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

function isoUtc(d: Date | null): string {
  return (d ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const websiteMenu = onRequest({ region: REGION, cors: false }, async (req, res) => {
  const key = String(req.header("X-API-Key") || "");
  const keys = allowedKeys();
  if (!key || !keys.has(key)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const db = getDb();
  const [catSnap, itemSnap] = await Promise.all([
    db.collection("categories").where("kind", "==", "food").where("status", "==", "active").limit(500).get(),
    db.collection("catalog").where("kind", "==", "food").where("status", "==", "active").limit(3000).get(),
  ]);

  const cats = catSnap.docs
    .map((d) => ({ ref: d.id, ...(d.data() as any) }))
    .sort((a, b) => a.sortOrder - b.sortOrder || String(a.name).localeCompare(b.name));

  const itemsByCat = new Map<string, any[]>();
  for (const d of itemSnap.docs) {
    const it = { ref: d.id, ...(d.data() as any) };
    if (!itemsByCat.has(it.categoryId)) itemsByCat.set(it.categoryId, []);
    itemsByCat.get(it.categoryId)!.push(it);
  }

  let latest: Date | null = null;
  const bump = (ts: any) => {
    const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
    if (d && (!latest || d > latest)) latest = d;
  };

  const categories = cats.map((c) => {
    bump(c.updatedAt);
    const items = (itemsByCat.get(c.ref) || [])
      .sort((a, b) => String(a.name).localeCompare(b.name))
      .map((it) => {
        bump(it.updatedAt);
        return {
          id: it.legacyId ?? it.ref,
          legacyId: it.legacyId ?? null,
          name: it.name,
          description: it.description ?? null,
          imageUrl: it.imagePath ?? null,
          pricePaise: Math.round(Number(it.price) * 100),
          price: Number(it.price),
          available: it.stockQty === null || it.stockQty === undefined || Number(it.stockQty) > 0,
        };
      });
    return { id: c.legacyId ?? c.ref, legacyId: c.legacyId ?? null, name: c.name, sortOrder: c.sortOrder, items };
  });

  res.status(200).json({ currency: "INR", updatedAt: isoUtc(latest), categories });
});
