/**
 * Menu image URLs. `catalog.image_path` stores a site-root path such as
 * "/assets/menu/tandoori-chicken-full.webp" (the file ships with the hosting
 * bucket, aws/hosting/assets/menu/).
 *
 *  - Staff POS + customer QR pages are served from the same origin as the
 *    assets, so they use the root-relative path as-is (posImageUrl).
 *  - The separate Website lives on ANOTHER origin and renders imageUrl in a
 *    plain <img>, so it needs an absolute https URL (websiteImageUrl). The
 *    base comes from PUBLIC_ASSET_BASE_URL (the CloudFront domain, set at
 *    deploy: `cdk deploy nlpos-<env>-api -c assetBaseUrl=https://dXXXX.cloudfront.net`).
 *    If it isn't configured we return null on purpose: the Website renders a
 *    clean placeholder for null but a BROKEN-image icon for a dead URL, so
 *    "no image" is strictly safer than a relative path it cannot resolve.
 */
const ABSOLUTE = /^https:\/\//i;

export function posImageUrl(path: string | null | undefined): string | null {
  const p = String(path ?? "").trim();
  return p ? p : null;
}

export function websiteImageUrl(path: string | null | undefined, base = process.env.PUBLIC_ASSET_BASE_URL): string | null {
  const p = String(path ?? "").trim();
  if (!p) return null;
  if (ABSOLUTE.test(p)) return p;
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (!ABSOLUTE.test(b)) return null;
  return b + (p.startsWith("/") ? p : "/" + p);
}
