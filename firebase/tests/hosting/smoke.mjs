/**
 * Hosting smoke: every migrated page is served, carries the Firebase bootstrap
 * (page-gate + module common.js + its module page script), and the Hosting
 * rewrites resolve. Runs inside `firebase emulators:exec --only
 * hosting,functions,firestore,auth`.
 */
import test from "node:test";
import assert from "node:assert/strict";

const HOST = "http://127.0.0.1:5000";

const PAGES = {
  "login.html": ["page-gate.js", "common.js", "login.js"],
  "dashboard.html": ["page-gate.js", "common.js", "dashboard.js"],
  "billing.html": ["menu-image-map.js", "correct-food-image-map.js", "page-gate.js", "common.js", "billing.js"],
  "alcohol-billing.html": ["page-gate.js", "common.js", "alcohol-billing.js"],
  "orders.html": ["page-gate.js", "common.js", "orders.js"],
  "menu.html": ["page-gate.js", "common.js", "menu.js"],
  "staff.html": ["page-gate.js", "common.js", "staff.js"],
  "audit.html": ["page-gate.js", "common.js", "audit.js"],
  "qr-tables.html": ["qrcode-generator", "page-gate.js", "common.js", "qr-tables.js"],
  "qr-orders.html": ["page-gate.js", "common.js", "qr-orders.js"],
  "website-orders.html": ["page-gate.js", "common.js", "website-orders.js", "searchBox"],
  "kitchen.html": ["page-gate.js", "common.js", "kitchen.js", "kdsBoard"],
  "cafe-billing.html": ["page-gate.js", "common.js", "cafe-billing.js"],
  "qr-menu.html": ["qr-menu.js"],
};

for (const [page, needles] of Object.entries(PAGES)) {
  test(`GET /pages/${page} serves + carries the bootstrap`, async () => {
    const res = await fetch(`${HOST}/pages/${page}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const n of needles) assert.ok(html.includes(n), `${page} missing ${n}`);
    if (page !== "qr-menu.html") {
      assert.match(html, /<script type="module" src="\.\.\/js\/common\.js">/);
    }
  });
}

test("static assets resolve", async () => {
  for (const p of ["/js/common.js", "/js/page-gate.js", "/js/firebase-init.js", "/css/base.css", "/assets/brand/next-level-logo.jpeg"]) {
    const r = await fetch(HOST + p);
    assert.equal(r.status, 200, p);
  }
});

test("Hosting rewrite: /menu/<token> serves the customer page", async () => {
  const r = await fetch(`${HOST}/menu/anytoken`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes("qr-menu.js"));
});

test("Hosting rewrite: /api/qr/menu/<token> reaches qrApi (JSON envelope)", async () => {
  const r = await fetch(`${HOST}/api/qr/menu/does-not-exist`);
  const j = await r.json();
  assert.equal(j.success, false); // invalid token -> {success:false,error}
});

test("Hosting rewrite: /api/website/menu reaches websiteMenu (401 without key)", async () => {
  const r = await fetch(`${HOST}/api/website/menu`);
  assert.equal(r.status, 401);
});

test("Hosting rewrite: /api/website/orders reaches websiteApi (401 without key)", async () => {
  const r = await fetch(`${HOST}/api/website/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

test("Hosting rewrite: /api/razorpay/webhook reaches razorpayWebhook (401 without a valid signature)", async () => {
  const r = await fetch(`${HOST}/api/razorpay/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

test("common.js + api-shim.js are served with a JS content-type and wire the shim", async () => {
  const c = await fetch(`${HOST}/js/common.js`);
  assert.match(c.headers.get("content-type") || "", /javascript/);
  const csrc = await c.text();
  assert.ok(csrc.includes("makeApiFetch(") && csrc.includes("Object.assign(window"), "common.js not wired");
  const s = await fetch(`${HOST}/js/api-shim.js`);
  assert.equal(s.status, 200);
  assert.ok((await s.text()).includes("export function makeApiFetch"));
});
