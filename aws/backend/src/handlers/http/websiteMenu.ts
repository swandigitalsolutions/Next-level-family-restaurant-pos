/**
 * GET /api/website/menu — Lambda port of
 * firebase/functions/src/http/websiteMenu.ts. Server-to-server, X-API-Key
 * auth. Food only, active only. Response shape byte-compatible with the
 * Website team's contract (WEBSITE-INTEGRATION.md / API.md).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getPool } from "../../lib/db";
import { websiteImageUrl } from "../../lib/assetUrl";
import menuCredits from "../../data/menu-credits.json";

// Photo attribution (CC BY / CC BY-SA need visible credit). Generated with the
// photo set, keyed by item name; only photos that need credit have an entry
// (photos cropped from the restaurant's own menu card do not).
const CREDITS = menuCredits as Record<string, { author: string; license: string; sourceUrl: string }>;

function allowedKeys(): Set<string> {
  return new Set(String(process.env.WEBSITE_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean));
}
function isoUtc(d: Date | null): string {
  return (d ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function creditFor(it: any): { imageCredit?: { author: string; license: string; sourceUrl: string } } {
  // Only when we actually send a photo, and only for the stock photo we shipped (a photo set by hand later has no entry).
  if (!websiteImageUrl(it.image_path) || !String(it.image_path).startsWith("/assets/menu/")) return {};
  const c = CREDITS[it.name];
  return c ? { imageCredit: c } : {};
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const key = String(event.headers?.["x-api-key"] || "");
  if (!key || !allowedKeys().has(key)) {
    return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "unauthorized" }) };
  }

  const pool = await getPool();
  const [cats, items] = await Promise.all([
    pool.query("SELECT * FROM categories WHERE kind='food' AND status='active' ORDER BY sort_order, name LIMIT 500"),
    pool.query("SELECT * FROM catalog WHERE kind='food' AND status='active' ORDER BY name LIMIT 3000"),
  ]);

  const itemsByCat = new Map<string, any[]>();
  for (const it of items.rows) {
    if (!itemsByCat.has(it.category_id)) itemsByCat.set(it.category_id, []);
    itemsByCat.get(it.category_id)!.push(it);
  }

  let latest: Date | null = null;
  const bump = (d: Date | null) => { if (d && (!latest || d > latest)) latest = d; };

  const categories = cats.rows.map((c) => {
    bump(c.updated_at);
    const catItems = (itemsByCat.get(c.id) || []).map((it) => {
      bump(it.updated_at);
      return {
        id: it.legacy_id ?? it.id, legacyId: it.legacy_id ?? null, name: it.name,
        description: it.description ?? null, imageUrl: websiteImageUrl(it.image_path),
        ...creditFor(it),
        pricePaise: Math.round(Number(it.price) * 100), price: Number(it.price),
        available: it.stock_qty === null || it.stock_qty === undefined || Number(it.stock_qty) > 0,
      };
    });
    return { id: c.legacy_id ?? c.id, legacyId: c.legacy_id ?? null, name: c.name, sortOrder: c.sort_order, items: catItems };
  });

  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currency: "INR", updatedAt: isoUtc(latest), categories }) };
};
