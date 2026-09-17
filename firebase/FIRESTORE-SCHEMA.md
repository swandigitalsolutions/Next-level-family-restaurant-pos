# Firestore schema — Next Level Family Restaurant POS (Phase 3)

Authoritative document shapes, relationships, invariants, and the query→index
matrix. **Verified against `backend/database.py` (SCHEMA/PG_SCHEMA) and
`backend/app.py` business logic** — see the "Verification" column and the
Invariants section. This is *not* a 1:1 table copy; see ARCHITECTURE.md §4.

Legend for field `type`: `str`, `strLower` (lowercased copy for querying),
`num`, `int`, `bool`, `ts` (Firestore Timestamp), `ref` (string doc-id of
another collection), `map`, `array<…>`, `| null` (nullable).

---

## 0. Conventions

- **Deterministic doc ids** (see §Migration ID mapping) so the ETL is idempotent
  and reference rewriting needs no lookup table.
- **Money**: every stored amount is a `num` already rounded by `lib/money.ts`
  `round2` (multiply-then-round, matches `frontend/js/billing.js`). Functions are
  the only writers of money fields.
- **Timestamps**: `createdAt` / `updatedAt` are server timestamps. `dateKey`
  (`"YYYY-MM-DD"` in `Asia/Kolkata`) and `hour` (`0..23`) are denormalized at
  write time to replace SQLite `date('now','localtime')` / `strftime('%H')`.
- **`legacy*` fields**: written by the ETL for traceability/reconciliation only;
  never read by app code.
- **Immutability**: `bills` and `auditLog` documents are `create`-only (Admin SDK)
  — rules deny `update`/`delete` for everyone.

---

## 1. `users/{uid}`  — staff profile (client-safe)

`uid` = Firebase Auth uid. Phase 2.1 credential-isolation model: **no secret here.**

| field | type | from Flask | notes |
|---|---|---|---|
| `username` | str | `users.username` | display form |
| `usernameLower` | strLower | — | login/uniqueness lookups |
| `fullName` | str | `users.full_name` | |
| `phone` | str | `users.phone` | `""` if absent |
| `role` | str | `users.role` | `admin`\|`manager`\|`staff`\|`owner` — also a custom claim |
| `status` | str | `users.status` | `active`\|`inactive` |
| `createdAt` | ts | `users.created_at` | |
| `legacyId` | int | `users.id` | ETL only |

**Relationships**: referenced by `tableSessions.openedByUid`, `bills.createdByUid`,
`auditLog.actorUid`. **Reads**: admin (any) or self. **Writes**: Functions only.

## 2. `userCredentials/{uid}`  — server-only credential

| field | type | from Flask | notes |
|---|---|---|---|
| `usernameLower` | strLower | `users.username` | credential lookup key for login |
| `passwordHash` | str | `users.password_hash` | Werkzeug string, verified by `lib/werkzeugHash.ts` |
| `updatedAt` | ts | — | |

**Reads/Writes**: **denied for every client incl. admin** (`if false`). Admin SDK only.

## 3. `categories/{cat_<kind>_<legacyId>}`

Merges `food_categories` + `alcohol_categories` (separate id sequences → `kind` in the id).

| field | type | from Flask | notes |
|---|---|---|---|
| `kind` | str | table | `food`\|`alcohol` |
| `name` | str | `.name` | |
| `nameLower` | strLower | — | uniqueness check on create |
| `sortOrder` | int | `.sort_order` | |
| `status` | str | `.status` | `active`\|`inactive` (soft delete) |
| `createdAt`/`updatedAt` | ts | `.created_at`/`.updated_at` | |
| `legacyId` | int | `.id` | |

**Relationships**: 1→N `catalog` (via `catalog.categoryId`). **Reads**: staff/owner + a
public path for the QR menu (see §rules). **Writes**: Functions only (Phase 4:
`upsertCategory` / `deleteCategory`, with the "no delete while active items exist"
guard from `app.py`).

## 4. `catalog/{item_<kind>_<legacyId>}`

Merges `food_items` + `alcohol_items`.

| field | type | from Flask | notes |
|---|---|---|---|
| `kind` | str | table | `food`\|`alcohol` |
| `name` | str | `.name` | |
| `nameLower` | strLower | — | search / image-map key |
| `categoryId` | ref→categories | `.category_id` | |
| `categoryName` | str | join | denormalized for the ordered menu query (no joins in Firestore) |
| `categorySort` | int | `categories.sort_order` | denormalized; menu ordering key |
| `price` | num | `.price` | rupees |
| `taxRate` | num | `alcohol_items.tax_rate` / **`0` for food** | food tax is per-bill `taxPercent`, never on the item |
| `stockQty` | int \| null | `.stock_qty` | `null` = not tracked (unlimited) |
| `brand` | str \| null | `alcohol_items.brand` | null for food |
| `bottleSize` | str \| null | `alcohol_items.bottle_size` | null for food |
| `description` | str \| null | `food_items.description` | null for alcohol |
| `status` | str | `.status` | `active`\|`inactive` |
| `imagePath` | str \| null | — | left null; migrated frontend keeps using `menu-image-map.js` by `nameLower` |
| `createdAt`/`updatedAt` | ts | `.created_at`/`.updated_at` | |
| `legacyId` | int | `.id` | |
| `legacyKind` | str | — | `food`\|`alcohol` (redundant w/ id, kept explicit) |

**Relationships**: N→1 `categories`. Referenced (loosely, id or null) by
`tableSessions.items[].itemId`, `bills.items[]` (by name only — Flask bill items
store only `item_name`), `qrOrders.items[].itemId`. **Stock** is decremented here
by the settle / bill-create / QR-order Functions (Phase 4).
**Reads**: staff/owner + public QR path. **Writes**: Functions only.

## 5. `tables/{tbl_<legacyId>}`

From `restaurant_tables`.

| field | type | from Flask | notes |
|---|---|---|---|
| `tableNo` | str | `.table_no` | unique (enforced in the create Function) |
| `seats` | int | `.seats` | |
| `status` | str | `.status` | `available`\|`occupied` |
| `qrToken` | str | `.qr_token` | opaque; unique; the `/menu/<token>` key |
| `openSessionId` | ref→tableSessions \| null | derived | mirrors `table_sessions WHERE status='open'` |
| `createdAt`/`updatedAt` | ts | | |
| `legacyId` | int | `.id` | |

**Relationships**: 1→N `tableSessions`, `qrOrders`. **Reads**: staff/owner; `qrToken`
lookup via a query on a public path. **Writes**: Functions only.

## 6. `tableSessions/{sess_<legacyId>}`

From `table_sessions` + `table_session_items` (items inlined as an array — Flask
does a full delete+reinsert on every save, so an array `set` is the exact
semantic and is atomic).

| field | type | from Flask | notes |
|---|---|---|---|
| `tableId` | ref→tables | `.table_id` | |
| `tableNo` | str | join | denormalized for the floor view |
| `customerName` | str | `.customer_name` | default `"Walk-in"` |
| `customerPhone` | str | `.customer_phone` | default `"-"` |
| `status` | str | `.status` | `open`\|`settled` |
| `openedAt` | ts | `.opened_at` | |
| `openedByUid` | ref→users \| null | `.opened_by` | |
| `settledAt` | ts \| null | `.settled_at` | |
| `items` | array<SessionLine> | `table_session_items` rows | see below |
| `subtotal`/`tax`/`grandTotal` | num | computed | cached copy for the floor view; **authoritative recompute at settle** |
| `settledBillIds` | array<ref→bills> | — | set on settle, traceability |
| `legacyId` | int | `.id` | |

**SessionLine** (array element): `{ kind: 'food'|'alcohol', itemId: ref|null,
itemName: str, brand: str, bottleSize: str, price: num, qty: int, taxRate: num,
lineTotal: num }` — mirrors `table_session_items(item_kind,item_id,item_name,
brand,bottle_size,price,qty,tax_rate,line_total)`.

**Reads**: staff. **Writes**: a narrow client update is allowed by rules while
`status=='open'` (customer fields + `items` shape) — but prices/tax/totals are
**recomputed server-side at settle and never trusted**; `status`,
`settledAt`, totals, `settledBillIds` → Functions only. Full detail in §rules.

## 7. `bills/{bill_<type>_<legacyId>}`  — immutable invoices (food + alcohol unified)

Merges `food_bills`+`food_bill_items` and `alcohol_bills`+`alcohol_bill_items`.
Replaces the `/api/orders` `UNION ALL`.

| field | type | from Flask | notes |
|---|---|---|---|
| `billNo` | str | `.bill_no` | `FOOD-000001` / `ALC-000001`; unique by construction (counter) |
| `billNoLower` | strLower | — | search |
| `type` | str | table | `FOOD`\|`ALCOHOL` |
| `source` | str | derived | `table` if `table_session_id` set, else `counter` |
| `tableId` | ref→tables \| null | `.table_id` | |
| `tableSessionId` | ref→tableSessions \| null | `.table_session_id` | |
| `customerName` | str | `.customer_name` | |
| `customerPhone` | str | `.customer_phone` | |
| `customerNameLower` | strLower | — | search |
| `searchTokens` | array<str> | — | `billNoLower` + word-prefixes of `customerNameLower` (≥2 chars); powers the orders search (see Limitations) |
| `subtotal` | num | `.subtotal` | |
| `discount` | num | `.discount` | |
| `tax` | num | `.tax` | |
| `grandTotal` | num | `.grand_total` | |
| `paymentMethod` | str | `.payment_method` | free text / `Cash` default |
| `status` | str | `.status` | always `confirmed` (Flask has no void flow) |
| `createdByUid` | ref→users \| null | `.created_by` | |
| `createdAt` | ts | `.created_at` | |
| `dateKey` | str | `date(created_at)` | `"YYYY-MM-DD"` Asia/Kolkata |
| `hour` | int | `strftime('%H')` | `0..23`, for rollup backfill |
| `items` | array<BillLine> | `_bill_items` rows | shape depends on `type` |
| `legacyId` | int | `.id` | |

**BillLine (FOOD)**: `{ itemName, price, qty, lineTotal }` — from `food_bill_items`.
**BillLine (ALCOHOL)**: `{ itemName, brand, bottleSize, price, qty, taxRate, lineTotal }` — from `alcohol_bill_items`.

**Relationships**: N→1 `tables`, `tableSessions`, `users`. **Reads**: staff/owner.
**Writes**: `create` only, Admin SDK only. `update`/`delete` **denied for everyone**.

## 8. `counters/{name}`  — gap-safe sequence

`name` ∈ `foodBill` | `alcoholBill` | `qrOrder` (was `food_bill`/`alcohol_bill`/`qr_order`).

| field | type | from Flask | notes |
|---|---|---|---|
| `value` | int | `counters.value` | last issued number |
| `prefix` | str | code | `FOOD`/`ALC`/`QR` (stored for clarity) |
| `updatedAt` | ts | — | |

`nextNumber` = a Firestore `runTransaction` that reads `value`, writes `value+1`,
returns `formatBillNo(prefix, value+1)` (`lib/money.ts`). Transaction retries on
contention → **no gaps, no duplicates**. **Reads/Writes**: denied for all clients.
ETL sets `value = max(pg counters.value, max existing numeric suffix)` so
post-migration numbers never collide with migrated ones.

## 9. `qrOrders/{publicRef}`  — customer self-service orders

`publicRef` (uuid hex, was `qr_orders.public_ref`) **is the doc id** → the customer
status endpoint is a direct `getDoc`, not a query. From `qr_orders` + `qr_order_items`.

| field | type | from Flask | notes |
|---|---|---|---|
| `orderNo` | str | `.order_no` | `QR-000001`; unique by construction |
| `publicRef` | str | `.public_ref` | == doc id |
| `tableId` | ref→tables | `.table_id` | |
| `tableNo` | str | join | denormalized |
| `customerName` | str | `.customer_name` | default `"Guest"` |
| `note` | str \| null | `.note` | |
| `status` | str | `.status` | `NEW`\|`ACCEPTED`\|`PREPARING`\|`READY`\|`SERVED`\|`CANCELLED` |
| `subtotal`/`tax`/`grandTotal` | num | `.subtotal`/`.tax`/`.grand_total` | server-priced from `catalog` |
| `pushedToBill` | bool | `.pushed_to_bill` (0/1) | |
| `tableSessionId` | ref→tableSessions \| null | `.table_session_id` | set by push-to-bill |
| `createdAt` | ts | `.created_at` | |
| `updatedAt` | ts | `.updated_at` | |
| `dateKey` | str | `date(created_at)` | today-scoped queries |
| `items` | array<QrLine> | `qr_order_items` rows | |
| `legacyId` | int | `.id` | |

**QrLine**: `{ kind, itemId: ref|null, itemName, brand, bottleSize, price, qty, taxRate, lineTotal }`.

**Relationships**: N→1 `tables`; may spawn/join a `tableSessions` via push-to-bill.
**Reads**: staff (board); single-doc read by `publicRef` on a public path (customer
tracker). **Writes**: `create` via the public HTTP Function only; a single legal
`status` FSM transition allowed by rules for staff; everything else Functions only.

## 10. `auditLog/{audit_<legacyId>}` (ETL) / `{auto}` (runtime)  — append-only

From `audit_log`.

| field | type | from Flask | notes |
|---|---|---|---|
| `actorUid` | ref→users \| null | `.actor_id` | |
| `actorUsername` | str \| null | `.actor_username` | |
| `actorRole` | str \| null | `.actor_role` | |
| `action` | str | `.action` | e.g. `bill.create`, `menu.item.price_change`, `staff.update`, `table.settle` |
| `entityType` | str | `.entity_type` | |
| `entityId` | str \| null | `.entity_id` | remapped to the new doc id where possible; else the legacy value |
| `details` | map \| null | `.details` (JSON text → map) | never contains a password hash |
| `createdAt` | ts | `.created_at` | |
| `legacyId` | int | `.id` | |

**Reads**: admin only. **Writes**: Admin SDK only. `update`/`delete` denied for everyone.

## 11. `stats/rolling` (doc) + `stats/daily/entries/{YYYY-MM-DD}`  — dashboard rollups (NEW)

No Flask equivalent (Flask recomputes 6 aggregate queries per `/api/dashboard`
hit). Maintained by `onBillWrite` / scheduled Functions in **Phase 4**; shapes
frozen here.

`stats/rolling`:
```
{ today: { foodSales, alcoholSales, totalSales, foodBills, alcoholBills, totalBills },
  trend:      [ { day:"YYYY-MM-DD", label:"MON", total, orders } ],          // last 7 days
  paymentMix: [ { method, total, orders } ],                                 // last 30 days
  topItems:   [ { name, qty, total } ],                                      // last 30 days, top 6
  hourlyFlow: [ { hour:0..23, orders, total } ],                             // last 30 days
  menuSummary:{ foodItems, alcoholItems, foodCategories, alcoholCategories },
  updatedAt }
```
`stats/daily/entries/{date}`:
```
{ dateKey, foodSales, alcoholSales, foodBills, alcoholBills,
  paymentMix: { <method>: { total, orders } },
  hourly:     { "<0-23>":  { total, orders } },
  items:      { <itemName>: { qty, total } },
  updatedAt }
```
**Reads**: staff/owner (dashboard). **Writes**: Functions/triggers only.

## 12. `authThrottle/{sha256(ip)}`  — login lockout (Phase 2)

`{ count:int, lockedAt:int(epoch ms) }`. **Reads/Writes denied for all clients.**

## 13. `config/{id}` — small runtime config (e.g. `config/website`)

`{ updatedAt, … }`. **Reads**: staff/owner. **Writes**: Functions only. (Thin; may
stay unused until the website-orders channel.)

## 14. `websiteOrders/{autoId}` — website pre-order channel (Phase 4b)

Website team's contract — see `WEBSITE-INTEGRATION.md`. Integer **paise**
everywhere; the website never sends an amount. Created by `POST /api/website/orders`
(`websiteApi`), confirmed by `razorpayWebhook`, mutated only by the
`setWebsiteOrderStatus` / `addItemsToWebsiteOrder` / `settleWebsiteOrder`
callables.

```
{ ref: "WEB-000123",                     // gap-safe counter, immutable, the primary reference
  channel: "website",
  status: "PENDING_PAYMENT",             // PENDING_PAYMENT→CONFIRMED→PREPARING→READY→COMPLETED | CANCELLED | PAYMENT_FAILED
  paymentStatus: "UNPAID",               // UNPAID→ADVANCE_PAID | FAILED | REFUNDED
  customer: { name, phone, email },
  fulfillment: { type: "pickup", pickupAt: Timestamp|null, notes },
  items: [ { itemId, name, kind:"food"|"alcohol", brand, bottleSize,
             unitPricePaise:int, qty:int, taxRatePct:number, lineTotalPaise:int, lineTaxPaise:int } ],
  subtotalPaise, taxPaise, totalPaise,   // int paise; subtotal = Σ lineTotalPaise (pre-tax)
  advancePaise,                          // round(totalPaise * 0.5)
  balancePaise,                          // max(0, totalPaise - paidPaise)
  paidPaise,                             // 0 until the webhook verifies the advance
  payment: { provider:"razorpay", providerOrderId:"order_…", keyId:"rzp_…", amountPaise },
  payments: [ { kind:"advance"|"balance", amountPaise, razorpayPaymentId?, at } ],
  settledBillIds: [], settledBillNos: [],
  createdAt, updatedAt, confirmedAt: Timestamp|null, settledAt?,
  dateKey: "YYYY-MM-DD" }                // restaurant-TZ; refreshed at confirm
```

**Reads**: staff/manager/admin only (owner + anon denied — the website reads via
`websiteApi` + `X-API-Key`, never Firestore). **Writes**: Functions only.
Settlement (`settleWebsiteOrder`) reuses `nextNumber` / `buildBillDoc` /
`applyStockWrites`: one immutable `bills` doc per non-empty {food,alcohol} group,
each with `source:"website"`, `websiteOrderId`, `websiteOrderNo = ref`,
`depositPaidPaise`, and `ref.toLowerCase()` appended to `searchTokens`.
Indexes: `(status ASC, createdAt DESC)`, `(dateKey ASC, createdAt DESC)`.

## 15. `websitePayments/{razorpayPaymentId}` — webhook idempotency markers

`{ ref, event, amountPaise?, at, amountMismatch? }`. Written once per Razorpay
payment id inside the `razorpayWebhook` transaction so a re-delivered event is a
no-op. **Reads/Writes denied for all clients** (Functions only).

## 16. `kitchenTickets/{autoId}` — kitchen screen (Phase 7)

Raised by `acceptOrderToKitchen` when `billing` accepts a QR-table or paid
Website order. Carries **no money** — just what to cook.

```
{ source: "qr" | "website",
  sourceId: <qrOrders/websiteOrders doc id>,
  ref: "QR-000012" | "WEB-000123",
  tableLabel: "Table 03" | null,
  customerName,
  items: [ { name, kind, qty, note } ],
  status: "QUEUED",              // QUEUED → PREPARING → READY → DONE (forward jumps + →DONE allowed)
  note,
  acceptedByUid, acceptedByUsername,
  createdAt, updatedAt, readyAt: Timestamp|null, doneAt: Timestamp|null,
  dateKey }
```

The source order (`qrOrders` / `websiteOrders`) records `kitchenTicketId` **and a
denormalised `kitchenStatus`** (`QUEUED`→…→`DONE`, mirrored by
`acceptOrderToKitchen` + `setKitchenTicketStatus`) so the Billing boards show
live kitchen progress from their own snapshot. Accept is idempotent per order.
**Reads**: kitchen/manager/admin. **Writes**: create/delete Function-only; a
kitchen/manager/admin client may step `status` one legal way
(`legalKitchenTicket` in `firestore.rules`). Indexes:
`(status ASC, createdAt ASC)`, `(dateKey ASC, createdAt ASC)`.

## 17. Outside-cafe channel (Phase 7/8)

Not a new collection — a third catalog **`kind: "cafe"`** (tea/coffee/ice
cream/water/cool drinks/juices; no `brand`/`bottleSize`, `taxRate` always 0).
Every `catalog` + `categories` doc also carries an explicit
**`salesChannel: "RESTAURANT" | "OUTSIDE_CAFE"`** (`salesChannelForKind()`), the
clean field the cafe till and restaurant screens filter on. Default cafe
categories (`DEFAULT_CAFE_CATEGORIES`): Tea, Coffee, Ice Creams, Water Bottles,
Cool Drinks, Juices, Other.

A third immutable **`bills`** series with `type:"CAFE"`, `source:"cafe"`, numbered
from `counters/cafeBill` (prefix `CAFE`). `createBill type:"CAFE"` reuses the
FOOD math/machinery (gap-safe number, stock floor, immutable bill, audit
`entityType:"cafe_bill"`); role-gated to `cafe_billing` + `billing` +
manager/admin. `stats/rolling.today` + daily entries gain `cafeSales`/`cafeBills`;
`menuSummary` gains `cafeItems`/`cafeCategories`. A cafe bill never raises a
kitchen ticket.

---

## Relationships (summary)

```
categories 1───N catalog
tables     1───N tableSessions ───(inlined array)─── SessionLine ──?──> catalog
tables     1───N qrOrders      ───(inlined array)─── QrLine      ──?──> catalog
tableSessions 1──N bills        (a settle makes 1 bill per non-empty {food,alcohol} group)
qrOrders   ──push-to-bill──> tableSessions (creates one if none open) ; sets pushedToBill, status=SERVED
users      1───N tableSessions (openedByUid) / bills (createdByUid) / auditLog (actorUid)
counters   ── issues ──> bills.billNo, qrOrders.orderNo
bills, auditLog : immutable (create-only)
stats/*    : derived from bills (triggers)
```

---

## Business invariants preserved (verified vs `backend/app.py`)

| # | Invariant | Flask source | Firestore mechanism |
|---|---|---|---|
| I1 | **Atomic bill settlement** — split food/alc, stock, session close, table free, audit all-or-nothing | `settle_table_session` (one SQL txn + rollback) | one `db.runTransaction`: read session+items+counters+referenced catalog docs → compute (`splitSettlement`) → create 1 bill/group, decrement stock, `session.status='settled'`+`settledAt`+`settledBillIds`, `table.status='available'`+`openSessionId=null`, append audit. Any throw ⇒ nothing commits. |
| I2 | **Gap-safe bill numbering** | `next_bill_number` (`UPDATE … value+1` in txn) | `counters/{name}` mutated only inside the settle/create txn via read-modify-write; Firestore retries the whole txn on contention ⇒ each number issued exactly once, monotonically. |
| I3 | **Stock decrement, floored at 0, only when tracked** | `apply_stock_delta` (`CASE WHEN stock_qty+? < 0 …`, `WHERE stock_qty IS NOT NULL`) | inside the txn: for each line with `itemId`, read `catalog/{itemId}`; if `stockQty !== null` → `stockQty = Math.max(0, stockQty + delta)`. Untracked (`null`) untouched. |
| I4 | **Food and alcohol bills are separate documents** with separate number series | two tables `food_bills` / `alcohol_bills`, prefixes `FOOD`/`ALC` | `bills` doc per group with `type` + `billNo` from the matching counter. `splitSettlement` yields `groups[]` = non-empty of `[food, alcohol]`. |
| I5 | **Pro-rata discount with remainder on the last group; groups sum back to the whole** | `settle_table_session` loop (`round(discount*group_subtotal/subtotal,2)`, last = `round(discount_left,2)`) | `lib/money.ts splitSettlement` — ported line-for-line, unit-tested (`money.test.ts`: `[285,432]`, discounts `[30,40]`, `[3.33,6.67]` remainder). |
| I6 | **Discount ≤ subtotal; grand total ≥ 0** | `create_*_bill` / settle checks | `computeFoodBill`/`computeAlcoholBill`/`splitSettlement` throw `ValidationError` (→ `HttpsError invalid-argument`). |
| I7 | **QR order re-priced server-side** — client price/name/total ignored | `qr_place_order` (re-reads `food_items`/`alcohol_items`) | `placeQrOrder` HTTP Fn (Phase 4) reads `catalog/{id}`; rules forbid client `create` on `qrOrders`. |
| I8 | **QR push-to-bill** folds items into the table's open session (creating it, marking table occupied), sets `pushed_to_bill`, `status=SERVED` | `qr_admin_push_to_bill` (one txn) | `pushQrOrderToBill` Fn: txn reads order+session(by `tableId`,`status='open'`)→ create session if none (`table.status='occupied'`, `openSessionId`) → append `items` → `order.pushedToBill=true`, `status='SERVED'`, `tableSessionId`. Idempotency guard: refuse if `pushedToBill` already true or `status=='CANCELLED'`. |
| I9 | **Bills and audit rows are immutable** (no update/void/delete route exists) | absence of routes | rules: `bills` & `auditLog` `allow update, delete: if false` for all; `create: if false` too (Admin SDK bypasses). |
| I10 | **`table_no` / `qr_token` / `username` / category `name` uniqueness** | SQL `UNIQUE` | deterministic doc ids + create-time uniqueness queries in the owning Function; token/number collisions negligible (random / monotonic). |
| I11 | **"today" / hourly use restaurant local time** | `date('now','localtime')`, `TZ=Asia/Kolkata` | `dateKey`/`hour` denormalized via `lib/money.ts` (`Intl` + `RESTAURANT_TZ`). |
| I12 | **Owner is view-only** | `_restrict_owner_scope` before_request | rules: `owner` claim → reads on `catalog`/`categories`/`tables`/`bills`/`stats` only; every write path is Functions-guarded by `assertRole`. |
| I13 | **Deactivated user cannot act** | `login` status check + session role | login Fn blocks `status!='active'`; `deactivateStaff` also `auth().updateUser({disabled:true})` + client `users/{uid}` listener signs out. |

---

## Query → index matrix

Single-field indexes are auto-created by Firestore; only composite ones are
declared in `firestore.indexes.json`.

| Screen / Function | Query | Index (composite unless noted) |
|---|---|---|
| Billing / Menu — food menu | `catalog where kind=='food' and status=='active' orderBy categorySort, nameLower` | `catalog(kind, status, categorySort, nameLower)` |
| Billing / Menu — alcohol menu | `catalog where kind=='alcohol' and status=='active' orderBy categorySort, nameLower` | (same composite, different `kind` value) |
| Menu Studio — items in a category | `catalog where status=='active' and categoryId==X orderBy nameLower` | `catalog(status, categoryId, nameLower)` |
| Menu — categories | `categories where kind==K and status=='active' orderBy sortOrder` | `categories(kind, status, sortOrder)` |
| Floor view | `tables orderBy tableNo` | single-field (auto) |
| Open session for a table | `tableSessions where tableId==X and status=='open' limit 1` | `tableSessions(tableId, status)` |
| Orders list — all | `bills orderBy createdAt desc` (+ cursor) | single-field (auto) |
| Orders list — by type | `bills where type==T orderBy createdAt desc` | `bills(type, createdAt desc)` |
| Orders list — by day | `bills where dateKey==D orderBy createdAt desc` | `bills(dateKey, createdAt desc)` |
| Orders list — type + day | `bills where type==T and dateKey==D orderBy createdAt desc` | `bills(type, dateKey, createdAt desc)` |
| Orders search | `bills where searchTokens array-contains q orderBy createdAt desc` | `bills(searchTokens, createdAt desc)` |
| Orders search + type | `… array-contains q and type==T orderBy createdAt desc` | `bills(searchTokens, type, createdAt desc)` |
| Orders search + day | `… array-contains q and dateKey==D orderBy createdAt desc` | `bills(searchTokens, dateKey, createdAt desc)` |
| CSV report | `bills where dateKey>=from and dateKey<=to orderBy dateKey` (+ `type==T`) | `bills(type, dateKey)` ; range on `dateKey` alone = auto |
| Live Orders board | `qrOrders where status in [NEW,ACCEPTED,PREPARING,READY] orderBy createdAt desc` | `qrOrders(status, createdAt desc)` |
| Live Orders — today, all | `qrOrders where dateKey==today orderBy createdAt desc` | `qrOrders(dateKey, createdAt desc)` |
| QR — today's orders for a table | `qrOrders where tableId==X and dateKey==today orderBy createdAt desc` | `qrOrders(tableId, dateKey, createdAt desc)` |
| Pulse / badge | `qrOrders where status=='NEW'` (count) | single-field (auto) |
| Customer tracker | `getDoc(qrOrders/{publicRef})` | none |
| QR menu by token | `tables where qrToken==tok limit 1` | single-field (auto) |
| Staff list | `users orderBy usernameLower` (via `listStaff` Fn) | single-field (auto) |
| Last-admin guard | `users where role=='admin' and status=='active'` | `users(role, status)` |
| Audit log | `auditLog orderBy createdAt desc` (+ `entityType==` / `action` prefix) | `auditLog(entityType, createdAt desc)`, `auditLog(action, createdAt desc)` |
| Login | `userCredentials where usernameLower==u limit 1` | single-field (auto) |
| Dashboard | `getDoc(stats/rolling)` | none |

---

## Migration ID / reference mapping

| Collection | New doc id | Idempotent? |
|---|---|---|
| `users` | `u_<users.id>` (Auth user also created with this uid) | yes — `createUser({uid})` + `set()` overwrite |
| `userCredentials` | `u_<users.id>` | yes |
| `categories` | `cat_food_<id>` / `cat_alc_<id>` | yes |
| `catalog` | `item_food_<id>` / `item_alc_<id>` | yes |
| `tables` | `tbl_<id>` | yes |
| `tableSessions` | `sess_<id>` | yes |
| `bills` | `bill_food_<id>` / `bill_alc_<id>` | yes |
| `qrOrders` | `<public_ref>` (already unique opaque) | yes |
| `auditLog` | `audit_<id>` | yes |
| `counters` | `foodBill` / `alcoholBill` / `qrOrder` | yes |

**Reference rewriting** (computed, no lookup table needed):
- `catalog.categoryId` ← `cat_<kind>_<food|alcohol_items.category_id>`
- `tableSessions.tableId` ← `tbl_<table_sessions.table_id>`; `openedByUid` ← `u_<opened_by>` (or null)
- `tableSessions.items[].itemId` ← `item_<item_kind>_<item_id>` (or null when `item_id` NULL)
- `bills.tableId` ← `tbl_<table_id>` (or null); `bills.tableSessionId` ← `sess_<table_session_id>` (or null); `bills.createdByUid` ← `u_<created_by>` (or null)
- `qrOrders.tableId` ← `tbl_<table_id>`; `qrOrders.tableSessionId` ← `sess_<table_session_id>` (or null); `items[].itemId` ← `item_<item_kind>_<item_id>` (or null)
- `auditLog.actorUid` ← `u_<actor_id>` (or null); `entityId` best-effort remap by `entity_type` (`food_item`→`item_food_…`, `alcohol_item`→`item_alc_…`, `user`→`u_…`, `table_session`→`sess_…`, `restaurant_table`→`tbl_…`), else keep raw

**Duplicate / partial-migration prevention**:
1. Deterministic ids + `set(data)` (no `merge`) ⇒ a re-run overwrites, never duplicates.
2. Per-collection `BulkWriter` (auto-batched, ≤500) with `close()` awaited before the next collection.
3. `_migration/status` doc: `{ source, startedAt, finishedAt, counts:{…}, ok:bool }` written last; a crash leaves `ok` unset ⇒ re-run.
4. `--verify` pass reads back per-collection counts + samples ⇒ reconciliation report; ETL exits non-zero on any count mismatch.
5. Target guard: refuses a non-emulator project unless `--target live --i-understand-this-writes-production` is passed. Phase 3 only ever runs `--target emulator` (or `--dry`).
6. `counters` seeded to `max(pg value, max numeric suffix seen)` so migrated + new bill numbers never collide.

---

## Limitations / deferred

- **Orders substring search degraded to token/prefix.** Flask does
  `LOWER(bill_no)/LOWER(customer_name) LIKE '%q%'` (true substring). Firestore
  can't. `searchTokens` = exact `billNoLower` + each word of `customerNameLower`
  with its running prefixes (≥2 chars). So `"ram"` matches customer `"Ramesh"`,
  and `"food-000123"` / `"food-0001"` match the bill; `"mesh"` (interior
  substring) does **not**. Acceptable for a cashier lookup; documented for Phase 5.
- **`offset` pagination → cursor pagination.** `/api/orders` and `/api/audit-log`
  used `LIMIT/OFFSET`; the migrated screens use `startAfter(lastDoc)`. Same UX
  (Prev/Next), different mechanism.
- **`stats/*` shapes are frozen but not populated** until Phase 4 triggers exist.
  Until then the dashboard would read an absent doc → Phase 4 concern.
- **`config/website`** is a placeholder for the requested website-orders channel;
  its final shape lands with that feature.
- Emulator rules tests require the portable JRE at `firebase/tools/jdk/` (now
  present); CI must provide a JDK.
