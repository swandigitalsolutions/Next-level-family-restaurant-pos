# Deployment runbook — Next Level Family Restaurant POS on Firebase

The whole migrated app lives in `firebase/`. `../backend` (Flask) and `../frontend`
are untouched and stay runnable as a hot rollback.

Nothing in this repo has been deployed or connected to a real Firebase project.
Everything below has been verified end-to-end against the local emulator suite
(`npm run check` — 225 tests).

---

## 0. One-time machine setup

```bash
cd firebase
npm install                 # installs firebase-tools, functions deps, test deps
npm i pg                     # ONLY needed for the production Postgres ETL (step 6)
```

You need Node 20+ and a JRE for local emulator runs. A portable JRE is already at
`firebase/tools/jdk/` (gitignored); CI must provide its own.

---

## 1. Create the Firebase project (console, once)

1. https://console.firebase.google.com → **Add project** (name e.g. `nextlevel-pos`).
2. **Build → Firestore Database → Create database** → *Production mode* → location
   **`asia-south1`** (must match the Functions region).
3. **Build → Authentication → Get started** → no providers need enabling (the app
   uses custom tokens minted by `loginWithPassword`).
4. **Project settings → General → Your apps → Web app** (`</>`), register it, copy
   the config object.
5. Upgrade to the **Blaze** plan (Cloud Functions require it).

Put the real project id in `.firebaserc`:

```json
{ "projects": { "default": "nextlevel-pos" } }
```

Log the CLI in:

```bash
cd firebase
npx firebase login
npx firebase use nextlevel-pos
```

---

## 2. Wire the web config

Edit `firebase/hosting/js/firebase-config.js` — replace the placeholders in
`firebaseConfig` with the values from step 1.4. (`apiKey` is a public client key,
not a secret; it is still project-specific.)

`USE_EMULATORS` auto-detects `localhost`, so the same file works locally and in prod.

---

## 3. Functions configuration (env vars + secrets)

```bash
cd firebase/functions

# Public website integration key(s) — comma-separated, same contract as Flask WEBSITE_API_KEYS
npx firebase functions:secrets:set WEBSITE_API_KEYS       # paste the key(s)

# Restaurant timezone / name (non-secret; also fine as runtime env)
```
Set the non-secret env at deploy time via `firebase.json` `functions[].` or, simplest,
create `firebase/functions/.env.nextlevel-pos` (loaded automatically for that project):

```
RESTAURANT_TZ=Asia/Kolkata
RESTAURANT_NAME=Next Level Family Restaurant
ENFORCE_APP_CHECK=true
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
```

Website Orders / Razorpay secrets (the pre-order flow — see
`WEBSITE-INTEGRATION.md`). The POS owns Razorpay order creation **and** the
webhook that verifies the 50% advance; the Website never verifies payments.
```bash
npx firebase functions:secrets:set RAZORPAY_KEY_SECRET       # Razorpay Orders API secret
npx firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET   # HMAC secret for X-Razorpay-Signature
```
Bind the secrets on the `websiteApi` / `razorpayWebhook` functions if you use
secret binding:
`{ secrets: ["WEBSITE_API_KEYS", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"] }`.
`RAZORPAY_KEY_ID` is public (returned to the Website as `payment.keyId`) so it can
stay in `.env.<project>`. Set `PAYMENT_PROVIDER=mock` to run without Razorpay
(deterministic `order_mock_…` ids; webhook signed with the same HMAC rule).

After deploy, register the webhook URL `https://<project>.web.app/api/razorpay/webhook`
in the Razorpay dashboard for events `payment.captured`, `payment.failed`,
`order.paid`, using `RAZORPAY_WEBHOOK_SECRET` as the webhook secret.

Then bind the secret in code is not required — `websiteMenu` reads
`process.env.WEBSITE_API_KEYS`; add the secret to its options if you prefer secret
binding (`{ secrets: ["WEBSITE_API_KEYS"] }` on the `onRequest`). Either works.

---

## 4. App Check (protects the browser-facing surface)

App Check attests **browser** callers; it does **not** apply to server-to-server
callers. Enable it for:

| endpoint / surface | App Check? | why |
|---|---|---|
| `qrApi` (`/api/qr/**`) — customer scans a table QR, their browser calls this | **YES** — set `ENFORCE_APP_CHECK=true` | public, browser-originated, un-authenticated |
| Hosting pages + the `callable` Functions they invoke (login, billing, staff, kitchen, cafe, etc.) | **YES** — enable App Check enforcement for Cloud Functions in the console, and `initializeAppCheck` in `firebase-init.js` | browser-originated |
| `websiteApi` (`/api/website/**`), `websiteMenu` (`/api/website/menu`) | **NO** (server-to-server) — the `X-API-Key` allow-list is the control; `ENFORCE_APP_CHECK` still gates an optional extra token check but the Website's server has none | called by the Website project's server, never a browser |
| `razorpayWebhook` (`/api/razorpay/webhook`) | **NO** — Razorpay calls it; the `X-Razorpay-Signature` HMAC is the control | third-party server |

Steps:
1. Firebase console → **Build → App Check** → register the web app with
   **reCAPTCHA Enterprise / v3**; put the site key in `firebase-config.js`
   (`__FIREBASE_CONFIG__` or the placeholder) and call `initializeAppCheck` in
   `firebase-init.js`.
2. Turn on **enforcement** for Cloud Functions and (if used) Firestore in the
   console.
3. Set `ENFORCE_APP_CHECK=true` so `qrApi` rejects tokenless calls. Leave it
   `false` until the reCAPTCHA provider is actually live, then flip it.

**REQUIRES REAL PRODUCTION CONFIGURATION** — nothing here can be verified in the
emulator; App Check has no emulator.

---

## 5. Deploy rules, indexes, functions, hosting

```bash
cd firebase
export PATH="$PWD/tools/jdk/bin:$PATH" JAVA_HOME="$PWD/tools/jdk"
npm run check                     # gate: the full suite must pass

npx firebase deploy --only firestore:rules,firestore:indexes
# wait for the composite indexes to finish building (console → Firestore → Indexes)

npx firebase deploy --only functions
npx firebase deploy --only hosting
```

Or all at once after the indexes are built:
`npx firebase deploy`

The `firebase.json` `hosting.rewrites` route `/menu/**`, `/api/qr/**`,
`/api/website/menu`, `/api/website/**`, `/api/razorpay/webhook`,
`/api/reports/export` to the right functions (region-qualified).

**Firestore TTL policy (REQUIRES REAL PRODUCTION CONFIGURATION).** After deploy,
in the console → Firestore → **TTL**, add a policy on
`websiteOrderIdempotency` with the field `expiresAt` (docs are written with
`createdAt + 25h`). This garbage-collects the Idempotency-Key lock/result cache;
without it the collection grows slowly but unboundedly (small docs — not urgent,
but set it). Optionally do the same for `websitePayments` if you add an
`expiresAt` there.

---

## 6. Migrate the production data (one time, at cutover)

The ETL is idempotent (deterministic doc ids + `set()` without merge). Run a dry
pass first, then commit.

```bash
cd firebase

# 6a. DRY RUN against the live Postgres (no writes) — read the reconciliation report
node scripts/etl-firestore.mjs \
  --source "postgresql://<user>:<pass>@<host>:6543/postgres" \
  --target dry \
  --report reports/cutover-dry.md
# -> reports/cutover-dry.md must say PASS; count reconciliation source==planned

# 6b. COMMIT to the real project (needs a service-account key)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json   # console → Project settings → Service accounts → Generate key
node scripts/etl-firestore.mjs \
  --source "postgresql://<user>:<pass>@<host>:6543/postgres" \
  --target live --i-understand-this-writes-production \
  --project nextlevel-pos \
  --create-auth-users \
  --report reports/cutover-live.md
```

`--create-auth-users` creates a Firebase Auth user (`uid = u_<legacy id>`) for
every staff account, sets its `role` custom claim, and copies the Werkzeug hash
into `userCredentials/{uid}` — so **existing usernames + passwords keep working**.

Then build the dashboard rollups (the ETL does not fire the `onBillWrite` trigger):

```bash
# call rebuildStats once — e.g. from the deployed app as an admin, or:
npx firebase functions:shell     # then:  rebuildStats({})
```

`reports/cutover-live.md` is the reconciliation record — keep it. It exits non-zero
on any count mismatch.

---

## 7. Change the default passwords

The seed / ETL carries over `admin` / `owner` (and any real cashiers — the old
`staff` role is migrated to **`billing`**). Immediately: sign in as `admin`, open
**Staff**, reset the `admin` and `owner` passwords (the `updateStaff` callable
re-hashes into `userCredentials`).

**The 6 roles.** From the **Staff** page (admin only) create accounts as:
`admin` · `owner` (dashboard + audit log, view-only) · `manager` (all ops + menu
+ tables + reports; **no** staff mgmt, **no** audit log) · `billing` (food/bar
cashier, QR + Website boards, Accept → Kitchen) · `kitchen` (kitchen screen only)
· `cafe_billing` (outside-cafe till only). Old `staff` accounts arrive as
`billing`; `cafe` as `cafe_billing`. Seed the cafe menu under **Menu Studio →
Cafe** (categories default to Tea / Coffee / Ice Creams / Water Bottles / Cool
Drinks / Juices / Other; every catalog doc gets
`salesChannel: RESTAURANT | OUTSIDE_CAFE`) before the cafe till goes live —
`counters/cafeBill` is created automatically by the ETL/seed.

---

## 8. Cutover & rollback

- **Cutover:** point the restaurant's domain at Firebase Hosting
  (console → Hosting → Add custom domain), or just switch the staff bookmark to
  `https://nextlevel-pos.web.app/pages/login.html`. Print new table QR codes from
  **Tables & QR Codes** (the tokens changed if you regenerated; otherwise the ETL
  preserved them).
- **Website integration:** update the restaurant website to call
  `https://nextlevel-pos.web.app/api/website/menu` with its `X-API-Key`. Response
  shape is unchanged; migrated items keep their numeric `id`.
- **Rollback:** the Flask app under `../backend` still runs against the untouched
  Postgres. Re-point the domain / bookmark back. Firestore data written after
  cutover would need a manual reconcile, so keep the rollback window short.

---

## 9. Post-deploy smoke (manual, 5 min)

| Check | Where |
| --- | --- |
| Login with `admin` | `/pages/login.html` |
| Dashboard shows today's numbers | `/pages/dashboard.html` |
| Create a counter food bill, verify `FOOD-00000N` increments | `/pages/billing.html` |
| Open a table, add items, settle → 1 food + 1 bar bill, table freed | `/pages/billing.html` |
| Menu Studio: change a price → audit row appears | `/pages/menu.html` → `/pages/audit.html` |
| Scan a table QR → place an order → it chimes on Live Orders → Add to bill | phone + `/pages/qr-orders.html` |
| CSV export downloads | `/pages/orders.html` (admin/manager) |
| `curl -H "X-API-Key: <key>" https://nextlevel-pos.web.app/api/website/menu` | terminal |

---

## What replaces what (final)

| Flask | Firebase |
| --- | --- |
| `POST /api/login` (session cookie) | `loginWithPassword` callable → custom token → `signInWithCustomToken` |
| `require_role` / owner scope | Firebase custom claim `role` + `firestore.rules` + `assertRole` in every write function |
| `/api/food\|alcohol/categories\|items` writes | `upsertCategory` / `deleteCategory` / `upsertCatalogItem` / `deleteCatalogItem` |
| `/api/food\|alcohol/bills` POST | `createBill` (one transaction: number, stock, audit) |
| `/api/tables/:id/open`, `/api/table-sessions/:id/settle` | `openTable`, `settleTable` (atomic split-bill settlement) |
| `/api/table-sessions/:id` PUT | rules-guarded client write to `tableSessions/{id}` |
| `/api/orders`, `/api/food/bills` GET, bill view | direct Firestore queries on the unified `bills` collection |
| `/api/dashboard` (6 live aggregates) | `stats/rolling` doc, maintained by the `onBillWrite` trigger |
| `/api/audit-log` | `auditLog` collection (admin-read) |
| `/api/reports/export` | `exportReport` HTTP function (Bearer ID token, admin/manager) |
| `/api/website/menu` | `websiteMenu` HTTP function (X-API-Key) |
| `/api/qr/*` (server-rendered) | `qrApi` HTTP function (App Check), same JSON contract |
| `/api/qr-ordering/*` staff | `setQrOrderStatus` / `pushQrOrderToBill` callables + direct Firestore reads/listeners |
| server-rendered QR SVG | client-side `qrcode-generator` in `qr-tables.js` |
| 5–20 s polling loops | Firestore `onSnapshot` (new-order alerts) + retained polls where parity mattered |
| gunicorn on Render + SQLite/Postgres | Firebase Hosting + Cloud Functions (`asia-south1`) + Cloud Firestore |
