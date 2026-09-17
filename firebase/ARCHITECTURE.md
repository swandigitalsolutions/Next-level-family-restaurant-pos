# Firebase Migration Architecture — Next Level Family Restaurant POS

Status: **Phase 0 (architecture) complete.** Strangler migration. Flask app under `../backend`
stays live and untouched until the final Hosting cutover.

---

## 1. Target topology

```
                         ┌──────────────────────────────────────────────┐
   Staff browser  ─────▶  │  Firebase Hosting  (firebase/hosting/)        │
   Customer phone ─────▶  │   • static HTML/CSS/JS (ported from frontend/) │
                         │   • rewrites:  /menu/**        → qr-menu.html   │
                         │                /api/website/** → websiteMenu fn │
                         └───────┬───────────────────────┬──────────────────┘
                                 │ Firebase JS SDK        │ httpsCallable / fetch
                                 ▼                        ▼
                    ┌────────────────────────┐   ┌────────────────────────────┐
                    │  Cloud Firestore        │   │  Cloud Functions (2nd gen) │
                    │  (native mode)          │◀──│  region: asia-south1       │
                    │  security rules enforce │   │  Node 20 / TypeScript      │
                    │  read scope + a few     │   │  • callable: trusted writes│
                    │  self-validating writes │   │  • http: websiteMenu, qr   │
                    └───────────┬─────────────┘   │  • triggers: rollups+audit │
                                │                 └───────────┬────────────────┘
                                │ onSnapshot (realtime)        │ Admin SDK
                                ▼                              ▼
                    Live Orders board, order status,   counters, stock, auditLog,
                    new-order badge  (replaces polling) stats/* rollups
                    ┌────────────────────────┐
                    │  Firebase Auth          │  custom-token flow:
                    │  custom claims = role   │  loginWithPassword fn checks
                    └────────────────────────┘  username+password vs users doc
   Firebase App Check (reCAPTCHA v3 web) guards the public QR + websiteMenu surface.
   Firebase Storage: NOT used in v1 (menu images ship with Hosting).
```

Region: **`asia-south1`** (Mumbai) for Functions + Firestore location `asia-south1`.
Project id placeholder: **`nextlevel-pos`** (set the real one in `.firebaserc`).

---

## 2. What replaces what

| Today (Flask) | Firebase |
| --- | --- |
| `backend/app.py` static routes | Firebase Hosting |
| `GET /` redirect, `/menu/<token>` | Hosting `rewrites` |
| Session cookie + `login_required`/`require_role` | Firebase Auth ID token + custom claim `role` + `request.auth` in rules/functions |
| `POST /api/login` | `loginWithPassword` **callable** → looks up `userCredentials` by `usernameLower`, verifies the Werkzeug hash (server-only), loads the `users/{uid}` profile → `admin.auth().createCustomToken(uid,{role})` |
| Flask `GET /api/staff` | `listStaff` **callable** (admin) → returns only sanitized profile fields (`id, username, full_name, phone, role, status`), never credential material |
| `POST /api/logout`, `GET /api/me` | client SDK `signOut()` / `onAuthStateChanged` + `getIdTokenResult()` |
| login throttle (`_LOGIN_ATTEMPTS`) | `authThrottle/{ipHash}` doc, checked+bumped inside `loginWithPassword`; App Check on the callable |
| 17 SQL tables | 11 Firestore collections (§4) |
| `counters` + `next_bill_number()` | `counters/{foodBill|alcoholBill|qrOrder}` — mutated **only** inside a Function `runTransaction` |
| `apply_stock_delta()` | Firestore transaction inside the bill/settle/qr-order Functions |
| `settle_table_session()` | `settleTable` callable (one multi-doc transaction: split food/alc, pro-rata discount w/ remainder, stock, session→settled, table→available, audit) |
| `POST /api/food/bills`, `/api/alcohol/bills` | `createBill` callable → `bills` collection (`type` field) |
| `GET /api/orders` (UNION+LIKE+paginate) | client Firestore query on unified `bills`, composite indexes, cursor paging; search = `customerNameLower` / `billNo` prefix + `search` token array |
| `GET /api/dashboard` (6 aggregates) | `stats/daily/{yyyy-mm-dd}` + `stats/rolling` rollup docs maintained by `onBillWrite` trigger; client reads rollups |
| `GET /api/reports/export` (CSV) | `exportReport` **http** function (auth = ID token w/ admin|manager claim) streams `text/csv` |
| `GET /api/audit-log` + `log_audit()` | `auditLog` collection, **written only by Functions**, read by admin claim |
| food/alcohol catalog CRUD | reads: rules-guarded direct; writes: `upsertCatalogItem` / `upsertCategory` / `deleteCatalogItem` callables (admin|manager) that also write price-change audit |
| `POST /api/qr/orders` (server re-pricing) | `placeQrOrder` **http** (unauth + App Check) → re-price from `catalog`, qty/stock checks, `QR-` number, `publicRef` |
| `GET /api/qr/orders/<ref>`, board `/pulse` polling | Firestore `onSnapshot` listeners |
| `POST .../status`, `.../push-to-bill` | `setQrOrderStatus` (FSM-guarded; callable) / `pushQrOrderToBill` callable |
| server QR SVG (`qrcode` py) | client-side `qrcode` JS lib (bundled with Hosting) |
| `GET /api/website/menu` (`X-API-Key`) | `websiteMenu` **http** function, key from Functions params / Secret Manager |
| `render.yaml` / gunicorn / `Procfile` | `firebase.json` + `firebase deploy` |
| `scripts/*.ps1` pg backups | Firestore managed backups / scheduled export (out of scope v1) |
| 5–20 s polling loops | `onSnapshot` |
| `customers`, `payments` tables | dropped (unused) |

---

## 3. Trust boundary — the hard rule

**Security Rules** may allow a client write ONLY when the write is fully self-validating
against data the client cannot forge. Everything touching money, stock, invoice numbers,
roles, or the audit log is a **Cloud Function (Admin SDK)** and rules `deny` the matching
client write.

### Roles (6)

`admin`, `manager`, `owner`, `billing`, `kitchen`, `cafe_billing`. `billing` is
the cashier role (was `staff`); `cafe_billing` is the outside-cafe till. Legacy
claims/records are normalised at every boundary — `normalizeRole()` in
`lib/config.ts`, `auth.js`, `page-gate.js`, ETL (`staff`→`billing`,
`cafe`→`cafe_billing`).

| role | pages (page-gate) | key rule/function access |
|---|---|---|
| `admin` | everything | all callables; **only** role that can manage staff accounts / roles / passwords |
| `manager` | everything except `staff.html` **and** `audit.html` | menu/catalog/table CRUD, all billing, QR + Website boards, kitchen, cafe, reports/CSV. **No staff mgmt, NO audit log.** |
| `owner` | `dashboard.html` + `audit.html` only | `stats/**`, `config/**`, `auditLog` **read** — strictly view-only, zero mutations |
| `billing` | all except menu / qr-tables / staff / audit / kitchen / cafe pages | food+bar billing, table sessions, QR + Website boards, Accept → Kitchen, receipts |
| `kitchen` | `kitchen.html` only | `kitchenTickets` read + status step; catalog read (item names). No billing, no settlement. |
| `cafe_billing` | `cafe-billing.html` only | `createBill type:CAFE` + cafe catalog + own `bills` read. Cannot touch restaurant billing or the catalog. |

Rules helpers: `isBilling()` = billing/manager/admin, `isCafe()` = cafe_billing/manager/admin,
`isKitchen()` = kitchen/manager/admin, `isAuditReader()` = **admin + owner only**,
`isOps()` = any of the five operational roles (catalog/name reads),
`isOwnerOrOps()` (stats/config). Backend `assertRole` mirrors these on every
callable; `page-gate.js` mirrors the page column; direct-URL access to an
unauthorised page redirects to the role's home.

Client-writable (rules-guarded) surface:
- `tableSessions/{id}` — `customerName`, `customerPhone`, and the `items` array **shape**
  (name/qty/itemId) while `status == "open"` and caller `isBilling()`.
  Prices/tax/line totals on those items are **recomputed server-side at settle** and never trusted.
- `qrOrders/{id}.status` — a single legal FSM edge (`NEW→ACCEPTED→PREPARING→READY→SERVED`,
  or `*→CANCELLED`) by `isBilling()`. (`pushToBill`, totals, item edits, `Accept → Kitchen` = Function.)
- `kitchenTickets/{id}.status` — one legal step (`QUEUED→PREPARING→READY→DONE`, or a
  forward jump / `→DONE`) by `isKitchen()`. Ticket creation is Function-only (`acceptOrderToKitchen`).
- everything else client-side is **read-only** or **denied**.

Function-only writes: `bills` (FOOD/ALCOHOL/**CAFE**), `counters`, `auditLog`, `stats/**`,
`users` role/status, `catalog` price/tax/stock, `qrOrders` create + totals + pushToBill,
`tables` create/rename/token, `tableSessions` settle/close, `kitchenTickets` create,
`websiteOrders` (all).

---

## 4. Firestore data model (see firestore.rules / firestore.indexes.json)

| Collection | Doc id | Purpose | Key fields | Client writes? |
| --- | --- | --- | --- | --- |
| `users/{uid}` | Auth uid | staff **profile** (client-safe, no secrets); role in custom claim | `username, usernameLower, fullName, phone, role, status, createdAt` | ❌ Function only; read: admin or self |
| `userCredentials/{uid}` | Auth uid | **server-only** password credential. Werkzeug hash lives here and NOWHERE else | `usernameLower, passwordHash, updatedAt` | ❌ **read AND write denied for every client**, admin included (rules: `if false`). Only Cloud Functions (Admin SDK) touch it |
| `categories/{id}` | auto | food+alcohol categories | `kind, name, nameLower, sortOrder, status` | ❌ Function only |
| `catalog/{id}` | auto | food+alcohol items (merged) | `kind, name, nameLower, categoryId, categoryName, categorySort, price, taxRate, stockQty, brand, bottleSize, description, status, imagePath, updatedAt` | ❌ Function only |
| `tables/{id}` | auto | dining floor + QR token | `tableNo, seats, status, qrToken, openSessionId` | ❌ Function only |
| `tableSessions/{id}` | auto | running tab | `tableId, tableNo, customerName, customerPhone, status, openedAt, openedBy, items[], subtotal, tax, grandTotal` | ⚠️ limited (see §3) |
| `bills/{id}` | auto | immutable invoices (food+alcohol) | `billNo, type, tableId, tableSessionId, customerName, customerNameLower, subtotal, discount, tax, grandTotal, paymentMethod, status, createdBy, createdAt, dateKey, items[]` | ❌ Function only, never update/delete |
| `qrOrders/{id}` | auto | customer self-service orders | `orderNo, publicRef, tableId, tableNo, customerName, note, status, subtotal, tax, grandTotal, pushedToBill, createdAt, updatedAt, dateKey, items[]` | ⚠️ status edge only |
| `qrOrders/{id}` create | — | via `placeQrOrder` http fn | — | ❌ |
| `counters/{name}` | `foodBill\|alcoholBill\|qrOrder` | gapless sequence | `value` | ❌ Function tx only; rules deny all |
| `auditLog/{id}` | auto | append-only trail | `actorId, actorUsername, actorRole, action, entityType, entityId, details, createdAt` | ❌ Function only; no update/delete |
| `stats/daily` `/entries/{yyyy-mm-dd}` | date | dashboard rollups | `foodSales, alcoholSales, foodBills, alcoholBills, paymentMix{}, hourly{}, topItems[]` | ❌ trigger only |
| `stats/rolling` | fixed | 7d trend + 30d windows cache | `trend[], paymentMix[], topItems[], hourlyFlow[]` | ❌ trigger only |
| `authThrottle/{ipHash}` | hash | login lockout | `count, lockedAt` | ❌ Function only |
| `config/website` | fixed | (optional) website menu meta | `updatedAt` | ❌ |

Dead tables `customers`, `payments` are **not** migrated.

### Website Orders channel (Phase 4b — implemented)

Central API for the *separate* Website project (`WEBSITE-INTEGRATION.md`), plus a
POS **Website Orders** board directly below "Live Orders". Everything is integer
**paise**; the website sends **no amounts**. Flow: POS catalog →
`GET /api/website/menu` → cart → `POST /api/website/orders` (items + customer
only; server re-prices, mints `WEB-000123`, creates the order
`PENDING_PAYMENT`/`UNPAID`, creates a **Razorpay** order for
`advancePaise = round(totalPaise/2)`) → browser pays via Razorpay Checkout →
**Razorpay calls the POS webhook** `POST /api/razorpay/webhook` → POS verifies
`X-Razorpay-Signature` (`HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)`) **and**
that the captured amount == `advancePaise` → `paymentStatus:ADVANCE_PAID`,
`status:CONFIRMED`, `confirmedAt` set → POS board (realtime, Order-ID search,
"Website Order Received" chime keyed on `status=="CONFIRMED"`) → staff **Add
Items** (re-priced at current catalog, paise) → **Settle Bill** → the existing
`nextNumber`/`buildBillDoc`/`applyStockWrites` machinery makes immutable `bills`
(`source:"website"`, `websiteOrderNo = "WEB-000123"` kept + search token). The
webhook is idempotent per Razorpay payment id and duplicate settlement is
blocked. `status` (`PENDING_PAYMENT → CONFIRMED → PREPARING → READY → COMPLETED`,
`CANCELLED`, `PAYMENT_FAILED`) and `paymentStatus` (`UNPAID → ADVANCE_PAID`,
`FAILED`, `REFUNDED`) are separate state machines — the webhook owns the
payment-driven transitions, Settle Bill owns `COMPLETED`, staff own the rest.
Collections: `websiteOrders`, `websitePayments` (sealed Razorpay-payment-id de-dup
markers), `counters/websiteOrder`. See FIRESTORE-SCHEMA.md.

### Kitchen screen (Phase 7 — implemented)

A separate full-screen board for the `kitchen` role (also reachable by
manager/admin). Lifecycle:

```
customer order → (payment/confirmation) → shows on the POS QR / Website board
  → Billing presses "Accept → Kitchen"
  → acceptOrderToKitchen writes a kitchenTickets doc (QUEUED == KITCHEN_PENDING,
    items only, NO prices/payment data) and advances the source order
    (qrOrders NEW→ACCEPTED, websiteOrders CONFIRMED→PREPARING), stamping
    order.kitchenTicketId + order.kitchenStatus="QUEUED" (denormalised so the
    Billing boards show live kitchen status from their own snapshot)
  → Kitchen board receives it instantly (realtime onSnapshot)
  → kitchen/manager/admin step QUEUED→PREPARING→READY→DONE via
    setKitchenTicketStatus, which also mirrors kitchenStatus back onto the
    source order → Billing sees the update.
```

**A QR/Website order NEVER appears on the Kitchen board just because it was
created — only after Billing accepts it.** Accept is idempotent per source order
(`order.kitchenTicketId`). The board query is
`kitchenTickets where status in [QUEUED,PREPARING,READY] orderBy createdAt` (no
polling). Chime/toast/badge are driven by `kitchenAlertDecision(seenMs, tickets)`
(pure, unit-tested): a ticket chimes **once**, only while `QUEUED` and newer than
the persisted high-water-mark (`localStorage kf_kds_seen_ms`), and
`snapshot.metadata.fromCache` suppresses chimes on reconnect/replay — so a reload
or a dropped connection never re-alerts. Kitchen tickets carry no money and the
`cafe_billing` channel never raises one; `kitchen` cannot accept orders, settle
bills, or change amounts.

### Cafe billing (Phase 7 — implemented)

The outside cafe (tea/coffee/ice cream/water/cool drinks/juices) is a third
catalog `kind: "cafe"` — every catalog + category doc also carries an explicit
`salesChannel: "RESTAURANT" | "OUTSIDE_CAFE"` (`salesChannelForKind()`), so the
cafe till and the restaurant screens filter cleanly and never show each other's
products. Default cafe categories (`DEFAULT_CAFE_CATEGORIES`): Tea, Coffee, Ice
Creams, Water Bottles, Cool Drinks, Juices, Other — admin/manager configure item
membership by creating items under a cafe category in Menu Studio.

A third immutable bill series **`CAFE-xxxxx`** (`counters/cafeBill`).
`cafe-billing.html` is a counter-only clone of the bar screen (no tables, no
sessions, **no tax**). `createBill type:"CAFE"` reuses the existing gap-safe
number / stock-floor / immutable-bill / audit machinery (`source:"cafe"`, audit
`entityType:"cafe_bill"`); allowed for `cafe_billing` + `billing` + manager/admin.
Cafe sales roll into the dashboard as their own `cafeSales`/`cafeBills` line and
into `totalSales`/`totalBills`. A cafe bill never raises a kitchen ticket.

Indexes (composite) — full list in `firestore.indexes.json`:
- `bills`: `(type ASC, createdAt DESC)`, `(dateKey ASC, createdAt DESC)`, `(createdAt DESC)` [single-field auto], `(customerNameLower ASC, createdAt DESC)`
- `catalog`: `(kind ASC, status ASC, categorySort ASC, nameLower ASC)`, `(status ASC, categoryId ASC)`
- `categories`: `(kind ASC, status ASC, sortOrder ASC)`
- `qrOrders`: `(status ASC, createdAt DESC)`, `(tableId ASC, dateKey ASC)`, `(dateKey ASC, createdAt DESC)`
- `tableSessions`: `(tableId ASC, status ASC)`
- `auditLog`: `(entityType ASC, createdAt DESC)`, `(action ASC, createdAt DESC)`

---

## 5. Money & numbering — ported logic (must match `app.py` exactly)

Implemented once in `functions/src/lib/money.ts`, unit-tested against the Flask behaviour:

- `round2(x)` = `Math.round((x + Number.EPSILON) * 100) / 100`.
- `toFloat` / `toPositiveInt` / `toOptionalStock` validators (same error messages).
- Food bill: `subtotal = Σ round2(price*qty)`; `tax = round2(subtotal * taxPercent/100)`;
  `discount ≤ subtotal`; `grandTotal = round2(subtotal - discount + tax)` and `≥ 0`.
- Alcohol bill: per-line `lineTax = round2(lineTotal * taxRate/100)`; `tax = round2(Σ lineTax)`;
  `grandTotal = round2(subtotal + tax - discount)`.
- **Settle split**: groups = non-empty of `[food, alcohol]`; for each non-last group
  `groupDiscount = round2(discount * groupSubtotal / subtotal)`; last group gets the remainder
  `round2(discountLeft)`; `groupTotal = round2(groupSubtotal + groupTax - groupDiscount)`.
- `nextBillNumber(tx, name, prefix)`: `value += 1`; return `PREFIX-000001` (`String(value).padStart(6,"0")`).
- `dateKey(ts, tz="Asia/Kolkata")`: `YYYY-MM-DD` in restaurant TZ (Intl API, fixed offset table not used — use `Intl.DateTimeFormat('en-CA',{timeZone})`).
- `hourOf(ts, tz)`: `0..23` local hour, for the hourly flow rollup.

---

## 6. Auth flow (custom token)

1. Login form posts `{username, password}` to `loginWithPassword` callable (App Check enforced).
2. Function: `ipHash` throttle check → `users where usernameLower == username` → `check_password_hash`
   (Werkzeug scrypt/pbkdf2 re-implemented in `lib/werkzeugHash.ts`) → `status == "active"` →
   `createCustomToken(uid, { role })`.
3. Client `signInWithCustomToken(token)`; `getIdTokenResult()` exposes `role`.
4. `requireAuth()` (ported) = `onAuthStateChanged` + claim-based page gating (identical rules to
   `page-gate.js`: owner→dashboard+audit only; kitchen→kitchen.html only; cafe→cafe-billing.html
   only; billing blocked from menu/qr-tables/kitchen/cafe; staff.html=admin, audit.html=admin/manager/owner).
5. Role change / deactivate: `setStaffRole` / `deactivateStaff` callables set the custom claim via
   Admin SDK and write `users` + audit. Client is forced to `getIdToken(true)` on next action;
   a `users/{uid}.status` listener signs the user out on deactivation.
6. Seed: `seedEmulator.mjs` / ETL creates `admin` (`nextlevel@123`) and `owner` (`owner@123`)
   with imported hashes.

---

## 7. Phase plan & exit criteria

| Phase | Deliverable | "Build/test check" (Java-free) | Exit criteria |
| --- | --- | --- | --- |
| 0 | this doc + `MIGRATION.md` tracker | markdown lint (n/a) | architecture agreed |
| 1 | `firebase.json`, `.firebaserc`, `firestore.rules` (skeleton), `firestore.indexes.json`, `storage.rules`, functions TS project, emulator + test config, installs | `npm ci` in `functions/`; `tsc --noEmit`; `eslint`; `firebase --version`; `firebase emulators:exec --only functions` dry (functions emu = no Java) | all green; Flask still runs |
| 2 | Auth: `loginWithPassword`, `werkzeugHash.ts`, `setStaffRole`, `deactivateStaff`, hosting `auth.js` + `firebase-init.js`, throttle | jest unit: hash verify vs known Werkzeug hash; functions-test offline for `loginWithPassword` | login returns a usable custom token in tests; Flask login untouched |
| 3 | Firestore: full `firestore.rules`, all indexes, `seedEmulator.mjs`, `etl-postgres-to-firestore.mjs` | `@firebase/rules-unit-testing` specs authored (exec = needs JDK, flagged); ETL dry-run against a dump with `--dry` | rules tests written & pass in CI-with-JDK; ETL dry-run maps every table w/o error |
| 4 | Cloud Functions: `createBill`, `settleTable`, `saveTableSession`, `openTable`, catalog/category/table callables, `placeQrOrder`, `setQrOrderStatus`, `pushQrOrderToBill`, `exportReport`, `websiteMenu`, `onBillWrite`/`onQrOrderWrite` triggers, `lib/money.ts` | jest + firebase-functions-test (offline) for every function; `tsc`; `eslint` | money math unit tests match `app.py` table of cases; every callable has a happy + auth-fail + validation-fail test |
| 5 | Feature migration into `firebase/hosting/` — one page per sub-step: login, dashboard, billing, alcohol-billing, orders, menu, staff, audit, qr-tables, qr-orders, qr-menu | per page: emulator (functions) + `firebase serve` smoke script hitting the page; no console errors; parity checklist | each page reaches feature parity vs Flask screen; polling replaced by `onSnapshot` |
| 6 | Cutover runbook: DNS/Hosting, App Check keys, Secret Manager, prod ETL, rollback | `firebase deploy --only ... --dry-run` where supported | signed-off runbook; Flask kept as hot rollback for N days |

**Rule enforced every phase:** do not proceed while `tsc`, `eslint`, or the phase's jest suite is red.
Flask under `../backend` is never edited.
