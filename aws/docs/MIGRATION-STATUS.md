# Firebase → AWS migration — status report

Firebase (`firebase/`) is **untouched and still the live/reference system**.
Everything below lives in `aws/` and has not been deployed — no AWS resources
exist yet, nothing has been cut over, no live Razorpay credentials were used.

This is an honest progress report, not a completion claim. A full-parity
migration of this app (4,785 lines of Firestore business logic across 8
callables + 5 HTTP functions + 1 trigger, 20 frontend modules, 14 pages, a
331-test suite) is a multi-week engineering effort. What follows is what got
built in this session and exactly what's left.

## 1. AWS architecture (built, as code — not deployed)

- **Network**: VPC, 2 AZs, no NAT gateway (cost control — Lambda/RDS stay in
  private isolated subnets; S3 + Secrets Manager reached via VPC endpoints).
- **Database**: Aurora PostgreSQL Serverless v2 (0.5–2 ACU) + RDS Proxy,
  encrypted, 14-day PITR backups, deletion protection on.
- **Auth**: Cognito User Pool, custom `role`/`pos_uid` claims refreshed by a
  PreTokenGeneration Lambda trigger reading `users.role` from Postgres at
  every token mint (replaces the Firebase custom-claims model exactly).
- **API**: API Gateway HTTP API, Cognito JWT authorizer on staff routes,
  unauthenticated routes for `/api/website/*` (API-key gated) and
  `/api/razorpay/webhook` (signature gated) — a 1:1 route map of
  `firebase/firebase.json`'s rewrites.
- **Realtime**: API Gateway WebSocket API + a connection registry table
  (`ws_connections`), replacing Firestore `onSnapshot` for the Kitchen screen
  and Live Orders / Website Orders boards.
- **Hosting**: S3 + CloudFront, with a CloudFront Function reproducing
  Firebase's `cleanUrls` behavior (the exact mechanism behind the "login page
  flickering" bug fixed on Firebase this session — flagged for re-verification
  on this stack, see §13).

Files: `aws/infra/bin/app.ts`, `aws/infra/lib/{network,database,auth,api,realtime,hosting}-stack.ts`.

## 2. Firebase → AWS mapping

| Firebase | AWS |
|---|---|
| Firestore | Aurora PostgreSQL (RDS Proxy) |
| Firebase Auth custom tokens | Cognito User Pool + custom claims |
| Cloud Functions v2 (onCall/onRequest) | Lambda behind API Gateway HTTP API |
| Firestore onSnapshot | API Gateway WebSocket API |
| Firebase Hosting | S3 + CloudFront |
| Firestore transactions | Postgres `SERIALIZABLE` transactions + row locks |
| Firestore Security Rules | Cognito authorizer + handler-level `assertRole` + Postgres GRANT/REVOKE |
| App Check | *(no AWS equivalent wired — see §13)* |

## 3. PostgreSQL schema — COMPLETE

`aws/db/migrations/001_init.sql`: all 17 collections from
`firebase/FIRESTORE-SCHEMA.md` translated to 17 tables with real foreign
keys, unique constraints, check constraints, and every composite index listed
in that doc's query→index matrix. Money is `numeric(10,2)` (rupees, matches
existing rounding) or `integer` paise for the website channel, matching the
Firestore version exactly — never floating point.
`002_privileges.sql` revokes UPDATE/DELETE on `bills`/`audit_log`/
`website_payments` from the app DB role — immutability enforced by Postgres
itself, not just application code (defense-in-depth parity with Firestore
rules `if false`).

## 4/5/6. Migrated business logic and APIs

**Ported and storage-agnostic (copied verbatim — no behavior change possible):**
`lib/money.ts` (all rounding/validation/settlement math), `lib/config.ts` (6
roles, constants, state machines), `lib/pricing.ts` (server-side re-pricing),
`lib/razorpay.ts` (provider + webhook signature).

**Ported and rewritten for Postgres (Firestore transaction → SQL transaction):**
`lib/db.ts` (pool + `withTransaction` with 40001/40P01 retry, the Postgres
analogue of Firestore's automatic contention retry), `lib/counters.ts`
(gap-safe numbering via `SELECT...FOR UPDATE`), `lib/idempotency.ts` (full
claim/resume/duplicate/in_progress/conflict state machine, `INSERT...ON
CONFLICT` as the atomic lock), `lib/authz.ts` (Cognito JWT claims instead of
`CallableRequest.auth`), `lib/http.ts` (error-envelope wrapper).

**Fully ported handlers (2 of 15, the two highest-risk):**
- `handlers/http/websiteApi.ts` — `POST/GET /api/website/orders`, full
  Idempotency-Key contract preserved end-to-end.
- `handlers/http/paymentWebhook.ts` — Razorpay webhook, all 5 hardening
  invariants preserved (provider-order-id verification, no-revert-of-confirmed,
  per-event id derivation, amount-mismatch handling, marker-based dedup).

**NOT yet ported (13 of 15 — REQUIRES CONTINUATION):**
`callable/{billing,catalogAdmin,kitchen,loginWithPassword,qrOrdersAdmin,
staffAdmin,tablesAdmin,websiteOrdersAdmin}.ts`, `http/{qrApi,websiteMenu,
exportReport}.ts`, `triggers/stats.ts` (dashboard rollups — needs a Postgres
trigger or an explicit post-commit call from every bill-writing handler),
`triggers/preTokenGeneration.ts` (referenced by the CDK Cognito stack but not
yet written), the 4 realtime Lambdas (`connect/disconnect/default/broadcast`).
Each is a direct, same-pattern port of its Firestore counterpart — the two
completed handlers above are the template to follow.

## 7. Website integration

Contract preserved unchanged in the ported handler (same JSON wire shape,
same `Idempotency-Key` header contract, same `WEB-000123` ref format). The
separate Website project needs **zero changes** once this endpoint is live —
same as the mandate requires. Not yet deployed or given a real URL.

## 8. Migration/reconciliation tooling

`aws/db/scripts/migrate-from-firestore.mjs` — structured skeleton (arg
parsing, `--dry`/`--target`/`--verify`/production opt-in guard, idempotent
`INSERT...ON CONFLICT` upsert helper, FK-respecting collection order
documented) but **the per-collection Firestore→Postgres field mappings are
not yet filled in** — deliberately, since wiring a live Firestore read
requires a service-account credential this task should not silently create.
**REQUIRES CONTINUATION** before any real data migration.

## 9/10. Tests / build / typecheck / lint

**Not run — nothing compiles yet.** `npm install` was not executed in
`aws/infra` or `aws/backend` (no network/package install was performed this
session). The two ported handlers have not been unit-tested against a real
Postgres. **REQUIRES CONTINUATION**: `npm install` in both packages, `npm run
build`/`lint` in each, then a ported test suite (start from
`firebase/functions/test/emulator/phase9-{idempotency,webhook}.test.mjs` —
same test cases, swap the Firestore emulator setup for a local Postgres via
Docker or `pg-mem`).

## 11. Security

- Defense in depth is architecturally in place: Cognito authorizer → handler
  `assertRole` → Postgres GRANT/REVOKE. Matches the Firebase model's 3 layers
  minus App Check (no wired AWS equivalent — recommend AWS WAF on public
  routes as the closest analogue; not yet added).
- Secrets (DB credentials, `WEBSITE_API_KEYS`, Razorpay keys) are designed to
  live in Secrets Manager, never in code or env files — wired in
  `api-stack.ts` but no real secret values have been created.
- `user_credentials`/`website_order_idempotency` tables carry no client-facing
  read/write role by design (mirrors Firestore's `if false`).

## 12. Backup / rollback

RDS automated backups + 14-day PITR configured in `database-stack.ts`
(nothing deployed yet, so nothing to restore). **Firebase remains the
rollback target for the entire migration** — untouched, still serving
`nextlevel-pos.web.app` if you proceed with that deployment separately.

## 13. Remaining limitations / REQUIRES MY ACTION

1. **Nothing is deployed.** No `cdk bootstrap`/`cdk deploy` has been run —
   this task explicitly forbids production cutover, and I did not create an
   AWS account, credentials, or run any AWS CLI/CDK command that talks to a
   real account.
2. **13 of 15 handlers, all frontend rewiring (20 files), the stats rollup
   trigger, the realtime Lambdas, and the full test suite still need
   porting** — several more sessions of the same pattern shown in §6.
3. **App Check has no AWS equivalent wired** — decide between AWS WAF token
   rules, a custom attestation Lambda, or accepting the gap for launch.
4. **cleanUrls CloudFront Function needs the same headless-browser
   verification** that caught the Firebase redirect-loop bug — do this before
   any real cutover.
5. **`npm install` / build / lint / tests have not been run** — the code is
   written to the same patterns as the working Firebase code but is
   unverified by a compiler or test run.
6. **Migration ETL is a skeleton** — needs the Firestore read side wired with
   a real service account before it can move any data.
7. **No Razorpay production credentials, no Cognito user pool, no RDS
   instance, no domain — all deliberately not created.**

## 14. Exact files changed/created

All new, under `aws/` (nothing in `firebase/`, `backend/`, `frontend/`, or
`scripts/` was touched):
```
aws/infra/{package.json,tsconfig.json,bin/app.ts,lib/network-stack.ts,
  lib/database-stack.ts,lib/auth-stack.ts,lib/api-stack.ts,
  lib/realtime-stack.ts,lib/hosting-stack.ts}
aws/db/migrations/{001_init.sql,002_privileges.sql}
aws/db/scripts/migrate-from-firestore.mjs
aws/backend/{package.json,tsconfig.json}
aws/backend/src/lib/{db.ts,counters.ts,idempotency.ts,authz.ts,http.ts,
  money.ts,config.ts,pricing.ts,razorpay.ts}
aws/backend/src/handlers/http/{websiteApi.ts,paymentWebhook.ts}
aws/docs/MIGRATION-STATUS.md (this file)
```

## 15. Exact commands (for continuation, none run yet)

```
cd aws/infra && npm install && npm run build && npx cdk synth   # validate, no deploy
cd aws/backend && npm install && npm run build
psql $STAGING_DATABASE_URL -f aws/db/migrations/001_init.sql
psql $STAGING_DATABASE_URL -f aws/db/migrations/002_privileges.sql
```

## 16–20. AWS resources / deploy / data migration / cutover / rollback procedures

Prepared as documented above (network → database → auth → api → realtime →
hosting stack order; ETL skeleton; Firebase-as-rollback). **None executed.**
Per the mandate, actual `cdk deploy`, Cognito account creation, Razorpay
production config, real data migration, and DNS/traffic cutover all require
your explicit go-ahead and are not run here.

---

**Bottom line:** the hardest, highest-risk pieces — schema fidelity, money
math, idempotency, and Razorpay webhook correctness — are ported and follow
the same battle-tested logic as the Firebase version. The remaining work is
large but mechanical: repeat the same handler-porting pattern for the other
13 handlers, rewire the frontend's Firestore calls to REST/WebSocket calls,
fill in the ETL, then install/build/test everything before touching a real
AWS account. Say "continue" and I'll keep going through that list in the same
order.
