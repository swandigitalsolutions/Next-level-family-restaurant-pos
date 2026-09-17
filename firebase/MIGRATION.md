# Migration progress tracker

Strangler migration. `../backend` (Flask) and `../frontend` are **never edited**; all Firebase
work lives under `firebase/`. Each phase ends with the checks in ARCHITECTURE.md §7 passing.

| Phase | Status | Notes |
| --- | --- | --- |
| 0 — Architecture | ✅ done | `ARCHITECTURE.md` |
| 1 — Firebase infrastructure | ✅ done | scaffold + installs + tsc/eslint/jest/CLI/emulator all green |
| 2 — Authentication | ✅ done | custom-token flow; Werkzeug hash compat proven both directions |
| 2.1 — Credential-isolation hardening | ✅ done | password hashes moved to server-only `userCredentials/{uid}`; `listStaff` callable returns sanitized fields |
| 3 — Firestore (schema/rules/indexes/seed/ETL) | ✅ done | `FIRESTORE-SCHEMA.md`; full rules; 18 composite indexes; deterministic-id ETL (dry + emulator) with reconciliation; portable JRE added → emulator rules + integration tests now execute. 154 tests green. |
| 4 — Cloud Functions | ✅ done | 23 functions: createBill/settleTable/openTable, catalog+table admin, qrApi/websiteMenu/exportReport, setQrOrderStatus/pushQrOrderToBill, onBillWrite/rebuildStats. 39 emulator integration tests. |
| 5 — Feature migration (per page) | ✅ done | strangler: all 11 pages copied to `hosting/`; `api-shim.js` translates the Flask `apiFetch` surface to Firestore + callables; page logic unchanged. 22 shim unit tests + 16 hosting smoke tests. |
| 4b/5b — Website Orders channel | ✅ done | Website team's contract: integer **paise**, **Razorpay**. `websiteApi` (`POST /orders` → mint `WEB-000123` + `PENDING_PAYMENT` + Razorpay order; `GET /orders/{ref}`), `razorpayWebhook` (verify `X-Razorpay-Signature` + amount == advance → `CONFIRMED`/`ADVANCE_PAID`, idempotent), `websiteMenu` (+`imageUrl`/`pricePaise`), `setWebsiteOrderStatus` / `addItemsToWebsiteOrder` / `settleWebsiteOrder` callables; `websiteOrders` + `websitePayments` (sealed de-dup) collections; POS **Website Orders** page (realtime on `status=="CONFIRMED"`, Order-ID search, "Website Order Received" alert, Add Items, Settle Bill → immutable bill keeps `websiteOrderNo`). Contract: `WEBSITE-INTEGRATION.md`. |
| 6 — Cutover runbook | ✅ done | `DEPLOY.md` — project setup, config, App Check, deploy order, prod Postgres→Firestore ETL (`--target live`), password reset, cutover/rollback, post-deploy smoke. |
| 7 — Roles + Kitchen + Cafe | ✅ done | **Kitchen screen** (`kitchen.html` + `kitchenTickets` + `acceptOrderToKitchen`/`setKitchenTicketStatus`): billing "Accept → Kitchen" raises a money-free ticket, realtime board + chime, `QUEUED→PREPARING→READY→DONE`. **Outside-cafe billing** (`cafe-billing.html`, catalog `kind:"cafe"`, `CAFE-xxxxx` series via `counters/cafeBill`, no tax, `source:"cafe"`, own dashboard line). |
| 8 — Role model finalised | ✅ done | **Exactly 6 roles**: `admin`, `owner`, `manager`, `billing`, `kitchen`, `cafe_billing`. `manager` pulled OUT of audit-log access (`isAuditReader` = admin+owner only). Explicit **`salesChannel: RESTAURANT \| OUTSIDE_CAFE`** on every catalog/category doc. Kitchen status **denormalised** onto `qrOrders`/`websiteOrders` (`kitchenStatus`) so Billing sees live progress. Kitchen chime hardened: `kitchenAlertDecision` + persisted `kf_kds_seen_ms` high-water-mark + `fromCache` guard (no re-alert on reload/reconnect). Full role-matrix test: every callable × every role. |

## Open questions — Website Orders channel

1. **Fulfilment type(s):** pickup / delivery / dine-in pre-order / table reservation — which does the website offer? Drives the doc shape and the board columns.
2. **Auth for the website→Firebase call:** reuse the existing `WEBSITE_API_KEYS` shared secret (as `/api/website/menu` does), or a dedicated key? App Check can't apply to a server-to-server caller, so the key is the control.
3. **Pipeline:** separate `websiteOrders` collection + board (recommended, keeps QR-table flow clean), or fold into `qrOrders` with a `channel` field?
4. **Does a website order ever become a `bill`/table session,** or is it settled/fulfilled on its own track (mark READY → SERVED, no POS bill)?
5. **Payment:** does the website capture payment (then we just record it), or is it pay-on-collection?
6. **Notifications:** same chime + sidebar badge as Live Orders? Separate counter?

## Verification log

| When | Phase | Command | Result |
| --- | --- | --- | --- |
| Phase 1 | 1 | `npm install` (functions: 512 pkgs, root: 704 pkgs) | ✅ |
| Phase 1 | 1 | `eslint --ext .ts src test` | ✅ clean |
| Phase 1 | 1 | `tsc` (build → `lib/index.js`) | ✅ |
| Phase 1 | 1 | `tsc -p tsconfig.test.json` (typecheck incl. tests) | ✅ |
| Phase 1 | 1 | `jest` — money-math parity vs `backend/app.py` | ✅ 20/20 |
| Phase 1 | 1 | `firebase --version` | ✅ 13.35.1 |
| Phase 1 | 1 | `firebase emulators:exec --only functions` (no JDK needed) | ✅ healthCheck, websiteMenu, qrApi load in asia-south1 |
| Phase 1 | 1 | Firestore rules unit tests | ⏸️ needs local JDK — runner skips gracefully, specs land Phase 3 |
| Phase 1 | 1 | `../backend` + `../frontend` unchanged by this session | ✅ (pre-existing `M` files are from before the migration) |
| Phase 2 | 2 | Werkzeug fixtures generated by real `werkzeug 3.0.3` (scrypt default/explicit/params, pbkdf2 sha256×2 + sha1, + 2 real hashes from `backend/nextlevel.db`) | ✅ |
| Phase 2 | 2 | `jest werkzeugHash` — TS verifier vs every fixture, incl. real `admin`/`owner` hashes; malformed input fails closed | ✅ 33/33 |
| Phase 2 | 2 | reverse-direction: Node-generated hashes accepted by Python `werkzeug.check_password_hash` (scrypt + pbkdf2 sha256/sha1) | ✅ |
| Phase 2 | 2 | `jest loginWithPassword` — token+claim on success, generic error + throttle bump on failure, deactivated block, per-IP lockout after 6, lockout expiry | ✅ |
| Phase 2 | 2 | `jest staffAdmin` — admin-only, last-active-admin guard (demote+deactivate), self-deactivate block, username/password/role validation, claim follows role, audit written, password reset → verifiable hash | ✅ |
| Phase 2 | 2 | `jest callableWrap` — real `onCall` dispatch via `firebase-functions-test` (offline): HttpsError marshalling, auth-context parsing | ✅ |
| Phase 2 | 2 | `jest pageGate` — client route gating parity with `common.js` requireAuth (owner/staff/manager/admin × every page) | ✅ |
| Phase 2 | 2 | `tsc` build + `tsc -p tsconfig.test.json` + `eslint` + `node --check` on 4 browser modules | ✅ |
| Phase 2 | 2 | `firebase emulators:exec --only functions` — 7 functions load in asia-south1 | ✅ |
| Phase 2 | 2 | full suite | ✅ **83/83** |
| Phase 2 | 2 | Firestore rules spec `auth.rules.test.mjs` authored (claim scoping + no-client-writes) | ⏸️ needs JDK to execute; runner skips cleanly |
| Phase 2 | 2 | real Auth-emulator E2E (token mint, sign-in) | ⏸️ blocked on JDK; `mintCustomToken`/`setRoleClaim` mocked at that boundary |
| Phase 2.1 | 2.1 | `repoIsolation.test.ts` — real `repo` fns vs spying Firestore fake: `createUserProfile` payload has no hash; `writeCredential`/`updateCredential` hit `userCredentials` only; `listUserProfiles` allowlist strips a planted `passwordHash`/unknown field | ✅ |
| Phase 2.1 | 2.1 | `staffAdmin.test.ts` — `listStaff` admin-only + sanitized; `createStaff` hash→`writeCredential` not profile, return value has no hash; `updateStaff` password reset→`updateCredential` not `updateUserProfile`; audit details carry no hash | ✅ |
| Phase 2.1 | 2.1 | `loginWithPassword.test.ts` — verifies against `findCredentialByUsername` (server-only) + `getUserByUid`; orphan-credential (no profile) rejected generically; all Phase 2 throttle/deactivation cases still green | ✅ |
| Phase 2.1 | 2.1 | `auth.rules.test.mjs` — `userCredentials/{uid}` unreadable+unwritable by anon/self/staff/manager/admin; `users` doc a client reads carries no `passwordHash` | ⏸️ needs JDK to execute; authored |
| Phase 2.1 | 2.1 | `tsc` build + `tsc -p tsconfig.test.json` + `eslint` + `node --check` (4 browser modules) | ✅ |
| Phase 2.1 | 2.1 | `firebase emulators:exec --only functions` — 8 functions load (adds `listStaff`) | ✅ |
| Phase 2.1 | 2.1 | full suite | ✅ **90/90** |
| Phase 3 | 3 | Portable JRE 17 → `firebase/tools/jdk/` (download, not a system install); Phase 2 deferred rules specs now execute | ✅ |
| Phase 3 | 3 | `FIRESTORE-SCHEMA.md` authored + verified vs `backend/database.py` + `app.py` (invariants I1–I13) | ✅ |
| Phase 3 | 3 | `firestore.rules` full rewrite; `firestore.indexes.json` = 18 composite indexes matching the query matrix | ✅ |
| Phase 3 | 3 | jest: `ids` (12), `normalize`/`searchTokens` (8), `billDoc` (5), `queries` (14) + all prior | ✅ **117/117** |
| Phase 3 | 3 | rules specs (emulator): `auth` + `catalog` + `sessions` + `qrorders` + `bills` | ✅ **31/31** |
| Phase 3 | 3 | integration (emulator, Admin SDK): `nextNumber` sequential + 8-way concurrent + 2nd wave + missing-counter; `applyStockDelta` decrement/floor/restore/untracked/missing; ETL idempotency (2× run, counts stable) | ✅ **6/6** |
| Phase 3 | 3 | ETL dry-run — bundled `backend/nextlevel.db` (seed): 148 docs, 16/16 checks | ✅ `reports/phase3-dry-seed.md` |
| Phase 3 | 3 | ETL dry-run — `scripts/fixtures/etl-source.sqlite`: 30 docs, 34/34 checks | ✅ `reports/phase3-dry-fixture.md` |
| Phase 3 | 3 | ETL → Firestore + Auth **emulators**, seed source: 148 docs + 2 auth users, 16/16 | ✅ `reports/phase3-seed-reconciliation.md` |
| Phase 3 | 3 | ETL → Firestore + Auth **emulators**, fixture source: 30 docs + 2 auth users, 37/37 (incl. target read-back) | ✅ `reports/phase3-emulator-fixture.md` |
| Phase 3 | 3 | `npm run check` (lint+typecheck+build+jest+rules+integration) | ✅ **154 tests, 0 fail** |
| Phase 3 | 3 | `../backend` + `../frontend` untouched | ✅ |
| Phase 4 | 4 | 23 Cloud Functions implemented (billing/settle/open, catalog+table admin, qrApi/websiteMenu/exportReport, qr staff ops, onBillWrite/rebuildStats) | ✅ |
| Phase 4 | 4 | `functions/test/emulator/*` — createBill/settleTable (gap-safe numbers, pro-rata discount 18.92/81.08, food/alc split, stock floor, atomic rollback, non-re-runnable), catalog CRUD + audit, qrApi re-pricing + qty/stock guards, setQrOrderStatus FSM, pushQrOrderToBill session-merge + idempotency, websiteMenu key-auth + shape, exportReport auth + CSV columns, rebuildStats == Flask `/api/dashboard`, live `onBillWrite` trigger | ✅ **39/39 (emulator)** |
| Phase 5 | 5 | `hosting/` = all 11 pages + assets/css; `page-gate.js` + `type=module` common.js/page-scripts; `api-shim.js` maps every Flask `/api/*` path the pages call | ✅ |
| Phase 5 | 5 | `tests/shim/api-shim.test.mjs` — every route → right Firestore query / callable, Flask row-shape mappers (bills, sessions, tables, orders, dashboard, audit, qr) | ✅ **22/22** |
| Phase 5 | 5 | `tests/hosting/smoke.mjs` (hosting+functions+firestore+auth emulator) — every page serves + carries the bootstrap; `/menu/**`, `/api/qr/**`, `/api/website/menu`, `/api/website/orders`, `/api/razorpay/webhook` rewrites resolve | ✅ **19/19** |
| Phase 6 | 6 | `DEPLOY.md` cutover runbook; ETL Postgres source added (`--target live` gated); `firebase.json` region-qualified function rewrites | ✅ |
| Phase 4b/5b | 4b/5b | `functions/test/emulator/phase4b-website.test.mjs` — `POST /orders` re-prices in paise + mints `WEB-000001` + `PENDING_PAYMENT` + Razorpay order; `422`/no-counter-burn on bad item; Razorpay webhook (sig verify, amount == advance → `CONFIRMED`/`ADVANCE_PAID`, **idempotent** per payment id, amount-mismatch + `payment.failed` → `PAYMENT_FAILED`); `GET /orders/{ref}`; Add Items re-prices at **current** catalog (paise), blocked when `COMPLETED`/`PENDING_PAYMENT`; Settle reuses POS billing (split bills, counters, stock, immutable, `source:website`, `websiteOrderNo` on the bill + search token), **duplicate settlement blocked**, flows into dashboard; FSM `CONFIRMED→PREPARING→READY`+cancel; staff-only | ✅ **18/18 (emulator)** |
| Phase 4b/5b | 4b/5b | `tests/rules/website.rules.test.mjs` — `websiteOrders` staff-read only (owner + anon denied), **no client write** for any role; `websitePayments` / `counters.websiteOrder` sealed | ✅ **4/4** |
| Phase 4b/5b | 4b/5b | `tests/shim/api-shim.test.mjs` — `/website-orders` list/filter/`?order_no=` exact `ref` lookup/`:id` (paise rows), status/add-items/settle → callables, bill rows expose `website_order_no`, `websiteOrderAlertDecision` ("Website Order Received · …", paise) | ✅ |
| Phase 4b/5b | 4b/5b | `tests/hosting/smoke.mjs` — `website-orders.html` serves with search box; `/api/website/**` → `websiteApi`, `/api/razorpay/webhook` → `razorpayWebhook` | ✅ |
| Phase 7 | 7 | `functions/test/emulator/phase7-kitchen.test.mjs` (13) — accept qr/website → ticket QUEUED + `kitchenStatus` denorm + source advance, **not-accepted → NO ticket** (qr + website), idempotent, CANCELLED/unpaid rejected, status mirror-back, `QUEUED→…→DONE` + forward jumps, accept=billing-only / status=kitchen-only, bad input; `functions/test/emulator/phase7-cafe.test.mjs` (6) — `CAFE-000001` no-tax bill, discount, independent series, dashboard line, `cafe_billing` can bill CAFE not FOOD, cafe catalog audits `cafe_item` | ✅ |
| Phase 8 | 8 | `functions/test/emulator/phase8-role-matrix.test.mjs` (13) — every protected callable × every role: staff-admin=ADMIN, catalog/tables=MANAGER+ADMIN, food/table billing=BILLING+MANAGER+ADMIN, CAFE bill=+CAFE_BILLING, QR/website ops=BILLING+MANAGER+ADMIN, acceptOrderToKitchen=BILLING (not kitchen), setKitchenTicketStatus=KITCHEN (not billing/cafe), rebuildStats=ADMIN, **OWNER cannot mutate anything**, allow-lists proven non-empty; `pageGate.test.ts` (6 roles, manager denied audit); `tests/rules/kitchen.rules.test.mjs` + `auth.rules.test.mjs` (audit = admin+owner only); shim `kitchenAlertDecision` + cafe channel-filter | ✅ |
| Phase 9 — Production hardening | ✅ done | **Idempotency-Key** on `POST /api/website/orders` (`lib/idempotency.ts` — Firestore-lock, concurrency-safe across instances, no 2nd `WEB-xxxxxx`, no 2nd Razorpay order; `websiteOrderIdempotency` sealed; `websiteOrders(idempotencyKey)` uniqueness net). **Webhook** verifies stored `providerOrderId` == webhook `order_id` (per-event id derivation, no loose OR), never reverts a non-`PENDING_PAYMENT` order, `order.paid` path. **Mock payments fail-closed** outside the emulator (`ALLOW_MOCK_PAYMENTS`). Counter/session billing qty caps (`MAX_BILL_LINE_QTY` 999 / `MAX_BILL_LINES` 200). Bounded `getDocs` on `qrAdminTables`/`qrAdminOrders`/menu reads. Generic 500s (no internal leakage). `functions/.env` gitignored + `.env.example`. `computeRolling` read-after-write race removed. |
| Phase 9 | 9 | `functions/test/emulator/phase9-idempotency.test.mjs` (7 — key format, no-key contract, sequential replay = same order/no 2nd provider order, same-key-diff-body 422, 422 doesn't burn key, **N concurrent → exactly one order/counter/provider order**, post-race replay); `phase9-webhook.test.mjs` (11 — valid capture, `order.paid`, wrong provider order id, wrong amount, invalid signature, dup same payment id, dup different payment id on confirmed order, wrong-amount-after-confirm no-revert, `payment.failed`, non-payment ignored); `tests/rules/role-matrix.rules.test.mjs` (5 — full read/write matrix × 6 roles + sealed collections + permitted client writes) | ✅ |
| Phase 4–9 | all | `npm run check` (lint + typecheck + build + **120 jest + 38 shim + 46 rules + 104 integration + 21 hosting**) | ✅ **329 tests, 0 fail** |
| Phase 4–6 + 4b/5b | all | `../backend` + `../frontend` still untouched; no separate Website project modified | ✅ |

## Known environment gaps

- **Portable JRE 17** at `firebase/tools/jdk/` (gitignored) — a download, not a system
  install. Unblocks the Firestore/Auth emulator, `@firebase/rules-unit-testing`, and the
  Admin-SDK integration tests. **CI must supply its own JDK.**
- The **Firestore emulator's transaction lock-timeout** aborts retries past ~8-way
  single-doc contention; `nextNumber` gap-safety is proven at 8 concurrent + a second
  wave. Real Firestore uses wider backoff and scales further.
- Real Auth-emulator E2E of `loginWithPassword` token mint / `signInWithCustomToken`
  is still deferred (Phase 2 boundary mocks remain). The ETL now creates real emulator
  Auth users, so a Phase 5 end-to-end login test is unblocked.
- ETL Postgres source not wired (`scripts/lib/source.mjs` rejects `postgres://`) — Phase 3
  runs only against a SQLite copy / the fixture, per the "no production data" instruction.
  Phase 6 adds the `pg` reader + the `--target live` path.
