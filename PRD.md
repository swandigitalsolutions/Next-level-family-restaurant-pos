# NextLevel Family Restaurant — POS/ERP — Product & Handoff Document

**Read this file first.** This repository contains **three separate, parallel
implementations** of the same product (explained in §3) at different stages
of completeness. This document exists so a new developer can understand the
business first, then the codebase, without re-deriving either from scratch.

Owner contact / business: Next Level Family Restaurant. Primary developer
contact for this codebase: swandigitalsolutions@gmail.com.

---

## 1. What this product is

A point-of-sale + light ERP system for a single restaurant with an attached
outside cafe counter and alcohol service, plus a customer-facing QR ordering
system and an integration with a **separate** restaurant website for online
pre-orders. It replaces manual billing books and gives the owner a live
dashboard, audit trail, and staff-role-gated access.

It is **not** a multi-tenant SaaS product (yet) — it is built for one
restaurant's exact workflow. Every business rule below is load-bearing; do
not "simplify" or "clean up" any of it without confirming with the owner —
several of these are subtle and were reverse-engineered from the original
Flask app's exact behavior (e.g. food has no tax, only alcohol does; QR
orders never reach the kitchen until a human accepts them).

### 1.1 Users and roles (exactly 6, no more, no less)

| Role | Can access | Cannot do |
|---|---|---|
| `admin` | Everything, including staff account management (create/deactivate/change role/reset password) | — |
| `manager` | Everything **except** Staff page and Audit Log | Cannot manage staff accounts, cannot view audit log |
| `owner` | Dashboard + Audit Log **only**, strictly view-only | Cannot create bills, cannot touch any operational screen, zero mutation rights anywhere |
| `billing` | Food/alcohol billing, table sessions, QR Orders board, Website Orders board, "Accept → Kitchen" action | Cannot access Menu (catalog editing), QR Tables (table/token admin), Staff, Audit, Kitchen screen, or Cafe till |
| `kitchen` | Kitchen screen only — sees ticket queue, steps ticket status | Cannot see prices, cannot bill, cannot settle, cannot accept orders into the kitchen (that's `billing`'s job) |
| `cafe_billing` | Outside-cafe till only (`cafe-billing.html`) — its own catalog (`kind: cafe`), its own bill series | Cannot touch restaurant food/alcohol billing or catalog |

Legacy role names (`staff` → `billing`, `cafe` → `cafe_billing`) are
normalized at every boundary — old data/tokens using the old names still
work.

### 1.2 Core workflows

- **Table billing**: open a table → build a running session (add items,
  customer name/phone) → settle. Settlement splits food and alcohol into
  **separate immutable bills** (`FOOD-xxxxxx`, `ALCOHOL-xxxxxx`) if the
  session has both, with any discount applied **pro-rata** across the split
  (remainder goes to the last group so the parts always sum exactly to the
  original discount — no rounding leaks).
- **Direct billing** (no table): food/alcohol counter sale, same
  bill-numbering and immutability rules.
- **Outside cafe till**: a third, independent catalog (`kind: cafe`) and its
  own bill series (`CAFE-xxxxxx`). No tax, no tables, no kitchen ticket.
  Cafe sales roll into the dashboard as their own line but also count toward
  totals.
- **QR ordering**: each physical table has a QR token. A customer scans it,
  orders directly (re-priced server-side from the live catalog — the client
  never sends a trusted price), gets a public order number. Staff sees it on
  a live board and either accepts it (raises a kitchen ticket) or pushes it
  directly onto a table's bill.
- **Website online ordering**: a **separate** website project (not in this
  repo — a different, independently-developed codebase) lets customers
  place pickup pre-orders. The website calls this POS's public API with a
  shared API key. The POS re-prices everything server-side, mints a
  `WEB-000123` order, creates a Razorpay order for a **50% advance
  payment**, and the browser pays via Razorpay Checkout. Razorpay's webhook
  (server-to-server, signature-verified) is the *only* thing that can move
  an order from `PENDING_PAYMENT` to `CONFIRMED` — staff cannot do this
  manually, by design (prevents an order being marked paid when it wasn't).
  Once confirmed, staff work it like a QR order: accept → kitchen → settle
  into a real bill (keeping the `WEB-000123` reference on the bill).
- **Kitchen**: a QR or Website order is invisible to the kitchen screen
  until a `billing` user explicitly presses "Accept → Kitchen." This raises
  a money-free ticket (no prices, ever, on the kitchen screen) that steps
  through `QUEUED → PREPARING → READY → DONE`. Accepting is idempotent — a
  double-click never creates two tickets for the same order.
- **Dashboard**: rolling stats (today + 7-day trend + payment-method mix +
  top items + hourly flow), built from bill data, viewable by every role
  except `kitchen`/`cafe_billing`.
- **Audit log**: every privileged write (bill creation, settlement, staff
  changes, catalog price changes, website order settlement, etc.) is
  recorded with actor/role/action/entity/details. Append-only — nothing can
  edit or delete an audit row, enforced at the database/rules layer, not
  just in application code.
- **Bills are immutable** once created. No edit, no delete, anywhere, by
  anyone, at the database layer — this is enforced by Postgres
  GRANT/REVOKE in the AWS track and by Firestore Security Rules in the
  Firebase track, not just by omitting an "edit" button in the UI.

### 1.3 Money rules (exact — do not approximate)

- All amounts are rupees rounded to 2 decimals using
  `round2(x) = Math.round((x + EPSILON) * 100) / 100`, matching the
  original Flask app's Python rounding exactly — **except** the Website
  Orders channel, which uses **integer paise** everywhere (never a float)
  because it's a payment-gateway-facing surface.
- **Only alcohol lines carry tax.** Food and cafe lines never do. This is a
  real, deliberate business rule — it looks like an inconsistency but it
  isn't; it was confirmed against the original app's behavior and is
  exercised by tests in all three tracks.
- Bill numbers are gap-safe (never skip, never repeat) via a locked-counter
  increment inside the same transaction as the bill write — proven under
  concurrent load in all three tracks.
- Settlement discount split across food+alcohol is pro-rata by subtotal,
  with the rounding remainder assigned to the last group, so the parts
  always sum back to exactly the original total discount.

---

## 2. Business rule source of truth

If any of the three code tracks below ever disagrees with this document,
**treat the original Flask app (`backend/`, `frontend/`) as the tiebreaker**
— it is the actual, currently-live reference implementation the restaurant
has been using, and both later migrations were built to match it exactly,
line-for-line where possible. Divergences discovered during the Firebase
migration were documented and preserved deliberately (e.g. the tax-only-on-
alcohol rule, and one internal field-naming quirk between "kind" and
"itemKind" that both migrations replicate on purpose because the running
Flask code depends on it).

---

## 3. Repository structure — THREE parallel tracks

This is the single most important thing to understand before touching this
repo. There are three complete-or-partial implementations living side by
side:

```
/                    ← Track A: ORIGINAL — Flask + PostgreSQL/SQLite
  backend/             Flask app (app.py, database.py), currently deployable to Render
  frontend/            Static HTML/CSS/JS served by Flask
  DEPLOY.md            Render + Supabase deployment guide (Track A only)
  API.md               Track A's HTTP API reference

firebase/            ← Track B: FIREBASE MIGRATION (complete, never deployed)
  functions/           Cloud Functions (TypeScript) — all business logic
  hosting/              Static frontend, rewired off Flask's apiFetch onto Firestore/callables
  firestore.rules, firestore.indexes.json
  ARCHITECTURE.md, MIGRATION.md, FIRESTORE-SCHEMA.md, WEBSITE-INTEGRATION.md, DEPLOY.md

aws/                 ← Track C: AWS MIGRATION (feature-complete backend, never deployed)
  backend/              Lambda handlers (TypeScript) — all business logic, ported again
  infra/                AWS CDK (TypeScript) — 6 stacks: network/database/auth/api/realtime/hosting
  db/                   Postgres schema (001_init.sql, 002_privileges.sql) + Firestore→Postgres ETL script
  hosting/              Static frontend, rewired again onto REST + WebSocket
  docs/DEPLOY.md, docs/MIGRATION-STATUS.md (the latter is a STALE mid-session snapshot — see §5.3)
```

**Track A (Flask)** is the original, currently-live production system. It
is complete and has been deployed before (Render + Supabase, per its
`DEPLOY.md`). It is the reference for "what does this business rule
actually do."

**Track B (Firebase)** is a from-scratch reimplementation on Firebase
(Firestore + Cloud Functions + Firebase Auth/Hosting), built as a strangler
migration with the explicit goal of never touching Track A. It reached
100% feature parity with Track A per its own tracker and is covered by a
very large real (emulator-based) test suite. **It has never been deployed
to a real Firebase project** — everything has run against the local
Firestore/Auth emulator only.

**Track C (AWS)** is a second from-scratch reimplementation, this time on
AWS (Aurora PostgreSQL + Lambda + API Gateway + Cognito + CloudFront), built
the same way — strangler migration, Track A/B untouched. Built later than
Track B and does **not** derive from Track B's Firestore data model
directly; it re-derives its Postgres schema and business logic from the
same specification as Track B (Track A's behavior), so it should behave
the same at the business-rule level even though the storage engine and API
shape differ. **It has never been deployed to a real AWS account.**

**None of the three tracks talk to each other.** They are independent,
runnable-in-isolation systems that all implement the same product. Only
one of them should ever be "live" for the restaurant at a time.

---

## 4. Decision the next developer/owner needs to make

**Before doing more work, decide which track becomes production.** Three
realistic options:

1. **Stay on Track A (Flask)** — it's the one with real deployment history
   (Render/Supabase). Lowest risk, but the least modern infrastructure and
   the one place SQL injection/scale concerns should be re-audited since
   it predates both migrations' hardening work.
2. **Deploy Track B (Firebase)** — most heavily tested by test *count*
   (329 tests, all green, across unit/rules/integration/shim/hosting
   layers), simpler ops model (no VPC/CDK/IAM to manage), but Firestore's
   per-document/transaction pricing and contention model doesn't scale
   quite the same way as a relational database under heavy concurrent
   write load (e.g. many billing terminals settling at the exact same
   second) — the emulator's transaction lock-timeout already showed limits
   around 8-way contention (see `firebase/MIGRATION.md`, "Known environment
   gaps").
3. **Deploy Track C (AWS)** — real relational database with proper
   `SERIALIZABLE` transactions and row locking (handles concurrent
   settlement better in principle), more moving infrastructure pieces to
   operate (VPC, RDS Proxy, Cognito, API Gateway, WebSocket API, CDK
   stacks), and it has the least real-world exercise of the three — its
   Cognito auth and WebSocket realtime layers have **never** connected to
   anything real, only to local test doubles.

This document does not make that call — it's a cost/ops/timeline decision
for the business, not a code-completeness one. Whichever is chosen, the
other two should be archived (not deleted — they're valuable reference/
rollback material) rather than continued in parallel.

---

## 5. What's DONE vs PENDING, per track

### 5.1 Track A — Flask (original)

**Done:** Full feature set is live-proven; this is the app the restaurant
has actually been using. Deployable today via `DEPLOY.md` (Render +
Supabase Postgres, or SQLite for local/dev).

**Pending / risks:**
- No automated test suite is present in this track (the later two tracks
  added one; Track A did not get one retrofitted).
- Whatever bugs exist in current production are still there — this repo
  snapshot doesn't include a bug list; ask the owner what's currently
  reported as broken, if anything.
- Session-cookie auth model, not token-based — fine for a single small
  deployment, worth reconsidering if this ever needs to scale to multiple
  concurrent instances behind a load balancer.

### 5.2 Track B — Firebase migration

**Done (per `firebase/MIGRATION.md`, all 9 phases marked complete):**
- Full auth flow (custom-token login, Werkzeug-hash-compatible password
  verification so existing Track A passwords work unchanged), staff admin,
  role claims.
- All 23 Cloud Functions: billing/settle/open-table, catalog + table admin,
  QR ordering (`qrApi`), Website Orders channel (order creation, Razorpay
  advance payment + webhook, add-items, settle), kitchen ticket workflow,
  cafe billing, dashboard rollups, audit log, CSV export.
- All 11 frontend pages ported and rewired from Flask's `apiFetch` calls
  onto Firestore reads/`onSnapshot` realtime + callable functions —
  page-level logic otherwise unchanged.
- Full Firestore Security Rules (defense in depth alongside function-level
  role checks) and 18 composite indexes.
- ETL script (Postgres/SQLite → Firestore), proven against seed and fixture
  data with reconciliation reports (`firebase/reports/*.md`).
- **329 tests passing, 0 failing**, spanning unit (jest), Firestore/Auth
  rules (emulator, real JDK), Cloud Functions integration (real Firestore
  emulator, not mocked), API-shim mapping, and hosting smoke tests. Run via
  `npm run check` inside `firebase/functions` (needs the portable JDK at
  `firebase/tools/jdk/` for the emulator-backed suites).
- Cutover runbook written (`firebase/DEPLOY.md`).

**Pending:**
- **Never deployed to a real Firebase project.** Everything above ran
  against local emulators only. Needs: a real Firebase project, real App
  Check keys (reCAPTCHA v3), real Razorpay credentials, `firebase deploy`,
  then a genuine post-deploy smoke test before it could be trusted.
- Real Auth-emulator end-to-end login (`signInWithCustomToken`) is
  explicitly flagged as still deferred — the boundary was mocked in tests.
- ETL's Postgres source reader was not wired for a live production pull at
  the time of the last status update (`scripts/lib/source.mjs` — check its
  current state before relying on this).
- No independent security audit.

### 5.3 Track C — AWS migration

**Done (verified this session — see the AWS backend test run below, not
just the stale `aws/docs/MIGRATION-STATUS.md`, which was written mid-session
and understates current progress; do not trust that file's "13 of 15 not
ported" line, it is outdated):**
- Full Postgres schema (17 tables, real FKs/constraints/indexes,
  `aws/db/migrations/001_init.sql`) with immutability enforced by
  `REVOKE UPDATE/DELETE` on bills/audit_log/website_payments
  (`002_privileges.sql`).
- **All 15 Lambda handlers ported**: 10 "callable" modules (staffAdmin,
  loginWithPassword, catalogAdmin, tablesAdmin, billing, kitchen,
  qrOrdersAdmin, websiteOrdersAdmin, dashboard, queries) + 5 HTTP handlers
  (websiteApi, paymentWebhook, qrApi, websiteMenu, exportReport).
- Cognito User Pool wiring with a `PreTokenGeneration` trigger that reads
  the live role from Postgres on every token mint (fails closed on error),
  matching Firebase's custom-claims-refreshed-on-demand model.
- WebSocket realtime stack (connect/disconnect/default Lambdas +
  direct-broadcast-from-write-path pattern) replacing Firestore
  `onSnapshot`.
- Full CDK infra-as-code, 6 stacks, confirmed to `cdk synth` cleanly to 6
  valid CloudFormation templates.
- Frontend fully rewired off the Firebase SDK onto REST + WebSocket
  (`aws/hosting/js/{aws-config,aws-auth,api-shim,aws-realtime}.js`), zero
  remaining Firestore/Firebase references.
- Firestore → Postgres ETL script, genuinely tested against a live
  Firestore emulator (not a skeleton — dry-run, write, idempotent re-run,
  and verify all exercised for real), with a real bug found and fixed
  (audit-log dedup key) during that testing.
- **52 backend tests passing, 0 failing** (`aws/backend`, run via
  `npm test`), covering billing/stock/tables, kitchen FSM, counter
  concurrency (including N-way concurrent-request races), the full
  Razorpay webhook hardening suite (8 cases), the complete 6-role
  authorization matrix, dashboard/queries, website-order idempotency
  (including concurrent-request races), and — added this session — a full
  real website-order lifecycle end to end (menu fetch → order creation →
  Razorpay webhook → status transitions → settlement into a real bill with
  stock decrement and audit logging), all against a real local Postgres,
  not mocks.
- `tsc --noEmit` and `eslint src` both clean.
- A real deploy-time secret-wiring bug was found and fixed before any
  deploy (Razorpay/website-API-key secrets weren't reaching the Lambda that
  needed them).
- A real cross-project integration gap reported by the separate Website
  team's own Claude session was found and fixed (a 409 "still processing"
  response didn't carry a distinguishable error code, so their retry logic
  couldn't tell it apart from a genuine rejection) — see
  `aws/backend/src/handlers/http/websiteApi.ts` and the exchange recorded
  in this project's session history.
- **Menu replaced with the owner's printed menu card** (26 categories, 203
  items, exact prices; source of truth `aws/db/data/menu-card.json`). Applied
  with `aws/db/scripts/seed-menu.mjs` (dry-run, single transaction,
  idempotent, retires old food items instead of deleting them, never touches
  alcohol/cafe). Every item has a photo (`aws/db/data/menu-images.json`,
  files in `aws/hosting/assets/menu/`): most are cropped from the card itself,
  the rest are Wikimedia Commons photos credited in
  `aws/hosting/assets/menu/CREDITS.md` (CC BY / BY-SA need a public credits
  page on the Website). Two prices are ambiguous on the printed card and must
  be confirmed by the owner: Paneer Butter Masala (English 200 / Kannada 220)
  and Club Veg Sandwich (130 / 120); `_flags` in the JSON lists them.
  The seed has been run only against a local test database, NOT production.
- Fixed a production-breaking frontend bug: billing/alcohol/menu/orders pages
  wrapped string ids in `Number()` (NaN), breaking category tabs, table
  selection and stock deduction. Guarded by `aws/backend/test/frontend-ids.test.ts`.
- Deploy runbook written (`aws/docs/DEPLOY.md`) — bootstrap → validate →
  create secrets → deploy stack-by-stack → init DB → point frontend at real
  endpoints → smoke test *before* any data migration → migrate data →
  rollback plan (rollback = do nothing; Firebase/Flask are untouched by
  this track, so "rollback" just means keep serving from whichever of
  Track A/B was live before).

**Pending — genuinely unverified, not glossed over:**
- **Never deployed to a real AWS account.** No `cdk bootstrap`/`cdk deploy`
  has been run against a real account.
- **Cognito auth has zero real-world testing** — no local emulator exists
  for it in this stack; the login/role-claim flow only exists as code,
  never exercised against a real Cognito user pool.
- **The WebSocket realtime layer has never connected to anything real** —
  kitchen-screen chime / live-order push is untested beyond local fake
  Lambda events. `aws/docs/DEPLOY.md` step 7 explicitly flags this as the
  single most likely thing to need real debugging after a first deploy.
- `qrApi.ts`, `qrOrdersAdmin.ts` (public QR endpoints), and
  `exportReport.ts` have **zero integration-test coverage** — ported and
  lint/typecheck-clean, but unverified at runtime.
- No AWS WAF / App-Check-equivalent bot protection wired on public routes
  (Firebase's App Check has no direct AWS analogue; `aws/docs/DEPLOY.md`
  and the code comments flag this as a decision to make before real
  launch).
- No security audit, no load testing at realistic concurrency.
- Requires real IAM programmatic credentials (not a console password) to
  do anything — this was explicitly withheld during this project's session
  and no AWS action was ever taken.

---

## 6. The separate Website project

There is a **second, independently developed and independently deployed**
codebase (not in this repo) for the restaurant's public marketing/ordering
website. It integrates with whichever POS backend is live via a small,
deliberately stable HTTP contract:

- `GET /api/website/menu` — food-only, active-only catalog, `X-API-Key`
  server-to-server auth.
- `POST /api/website/orders` — create a pre-order; supports an
  `Idempotency-Key` header so a network retry never double-creates an
  order or double-charges via Razorpay.
- `GET /api/website/orders/{ref}` — poll order status.
- `POST /api/razorpay/webhook` — Razorpay calls this directly; not called
  by the website.

This contract is documented in `firebase/WEBSITE-INTEGRATION.md` and is
intentionally identical across Track B and Track C so the Website project
needs **zero changes** regardless of which POS track goes live — only the
base URL and API key it's configured with change. Whoever continues this
project should coordinate with whoever owns the Website repo before
changing this contract in any way (request/response shape, status values,
error codes) — the two are developed by different people/sessions and any
shape change breaks the other side silently.

---

## 7. How to run each track locally

**Track A (Flask):**
```
cd backend && pip install -r requirements.txt && python app.py
# http://127.0.0.1:5000 — SQLite by default, or set DATABASE_URL for Postgres
```

**Track B (Firebase):**
```
cd firebase/functions && npm install && npm run check   # lint+typecheck+build+full test suite
# to run locally: firebase emulators:start (needs the portable JDK — see MIGRATION.md)
```

**Track C (AWS):**
```
cd aws/backend && npm install
npx tsc --noEmit && npx eslint src --ext .ts
# tests need a local Postgres on port 55432 (disposable — initdb/pg_ctl, or Docker),
# database name posdb, then:
npm test
cd ../infra && npm install && npx cdk synth --context env=dev   # validates infra, no deploy
```
None of these commands touch any real cloud account.

---

## 8. Secrets / environment this project needs before any real deployment

Never commit real values for any of these — `.gitignore` in each track
already excludes `.env`/`.env.*` files.

- Werkzeug-compatible admin/staff passwords (already seeded in Track A;
  both migrations preserve the same hashes so existing logins keep
  working).
- `WEBSITE_API_KEYS` — shared secret with the separate Website project.
- Razorpay: key id, key secret, webhook secret (test keys are fine until
  go-live; every track supports a "mock" payment provider for
  local/emulator use, fail-closed outside that context).
- Track B only: a real Firebase project id, App Check reCAPTCHA v3 site
  key.
- Track C only: AWS IAM programmatic credentials (access key + secret, or
  SSO), a target AWS account/region.

---

## 9. Recommended immediate next steps for the incoming developer

1. Read this file, then skim `firebase/ARCHITECTURE.md` (business rules in
   full technical detail) — it's the most complete single description of
   the domain model, even if Track B itself doesn't end up chosen.
2. Get the owner's decision on §4 (which track becomes production).
3. Re-run that track's full test suite yourself before trusting any
   "N/N passing" claim in this document or elsewhere — trust your own
   execution, not this report, once you're set up.
4. If continuing Track B or C: budget real time for the "never deployed"
   gap — every unverified item in §5.2/§5.3 needs to be exercised against
   real infrastructure before this can be called production-ready. Do not
   skip the smoke-test steps in either track's `DEPLOY.md` — they exist
   because a past incident on a different project taught this team the
   hard way that "tests pass locally" and "works in production" are not
   the same claim, and the gap between them is exactly where restaurants
   lose orders during dinner service.
5. Coordinate with whoever owns the separate Website repository before
   changing the `/api/website/*` contract in any way.
