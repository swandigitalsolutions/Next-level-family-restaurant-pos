# Production hardening pass — 2026-09-18/19

**Read `PRD.md` first** for what this product is and how the three tracks
relate. This document covers one thing: the defects found while auditing all
three tracks for "what will break, or quietly cost money, in production," what
was changed, and what was proven rather than assumed.

Every fix below is covered by a test that **fails on the old code and passes on
the new code**, or by a reproduction recorded here. Nothing in this document is
claimed on the strength of "it looks right."

---

## Test status after this pass

| Track | Suite | Before | After |
|---|---|---|---|
| A — Flask | *(none existed)* | — | **35 passing** (SQLite + real Postgres, incl. 5 concurrency tests) |
| B — Firebase | jest unit + emulator | 121 + 99 | **121 + 99 passing**, 0 failing |
| C — AWS | node:test + real Postgres | 63 (1 **failing**) | **79 passing**, 0 failing |

How to run each one is in `backend/tests/README.md`, `firebase/MIGRATION.md`
and `aws/docs/TESTING.md` respectively.

---

## 1. Track A (Flask) — the one actually running the restaurant

This track had **no automated tests at all** and had never been re-audited
(PRD §5.1). It is also the only track serving real customers, so it got the
deepest pass.

### 1.1 Pooled connections leaked on every error — *whole-POS outage*

Every route did `conn = get_db()` … `conn.close()` on each exit path with no
`try/finally`. Any exception in between — a bug, a dropped socket, a client
closing the tab mid-request — leaked that connection permanently. With
`DB_POOL_MAX=10`, **ten such requests and the till stops responding entirely**
until someone restarts the server, with no error that points at the cause.

The connection is now owned by the request, not the handler: opened on first
use, reused for the rest of the request, always released in
`teardown_appcontext`. `conn.close()` inside a handler remains valid (it defers
to teardown), so no route code had to change.

*Proof:* `test_a_failing_request_releases_its_db_connection` counts 30
checkouts and 30 returns across 30 failing requests. Fails on the old code.

### 1.2 The business day was wrong — *money reported on the wrong date*

Production reaches Supabase through the **transaction pooler** (port 6543,
confirmed from the live `DATABASE_URL`). That pooler hands a different physical
backend to each transaction, so the `SET TIME ZONE 'Asia/Kolkata'` the pool
issued once at connection setup is **not reliably in effect afterwards**. With
the session default (UTC):

* `date(created_at) = date('now','localtime')` shifts the business day by 5½
  hours, so every bill written between midnight and 05:30 IST lands on the
  wrong day of the dashboard and the CSV export;
* the dashboard's hourly flow buckets the evening rush into the wrong hours;
* **the time printed on the customer's receipt is UTC.**

Reproduced against a real local Postgres with the session `TimeZone` forced to
UTC — the same conditions the pooler creates:

```
OLD receipt timestamp: 2026-09-18 15:51:33   OLD hourly flow: [{hour: 15, ...}]
NEW receipt timestamp: 2026-09-18 21:21:46   NEW hourly flow: [{hour: 21, ...}]
```

Every timezone-sensitive expression now names `Asia/Kolkata` inline
(`database.py::_translate`), and TIMESTAMPTZ values are converted explicitly on
the way out (`_coerce`). Nothing depends on session state any more. The whole
suite runs green against a database whose default `TimeZone` is UTC, on purpose.

### 1.3 Double-charging the customer — *four separate races*

None of these needed unusual timing; a double-click or a retry after a lost
response was enough.

| Path | Old behaviour | Fix |
|---|---|---|
| Settle a table | Read `status='open'`, trust it, write bills. Two clicks → **two real bills, two bill numbers, two stock decrements** | Claim the session with `UPDATE … WHERE status='open'` *before* writing anything, plus a unique index per `(table_session_id)`. A repeat returns the original bills with `already_settled: true` |
| Save a bill | No idempotency at all; a retried POST was a second sale | `Idempotency-Key` header → `bills.client_ref`, `UNIQUE` in the database. A retry returns the first bill |
| Open a table | Read-then-insert; two terminals → two open sessions splitting one party's order across two bills | Unique partial index on `(table_id) WHERE status='open'`; the loser returns the winner's session |
| Push a QR order to a bill | `pushed_to_bill` checked in a separate SELECT; two presses → **items added to the bill twice** | Atomic claim `UPDATE … WHERE pushed_to_bill = 0` |

*Proof:* `backend/tests/test_concurrency.py` fires 6–8 genuinely simultaneous
requests at each path. On the original code, 4 of the 5 tests fail — each one a
real overcharge. All pass now.

The till also sends a key that survives retries (`common.js::newIdempotencyKey`,
generated once per sale and reused for every attempt of it — regenerating per
attempt would defeat the whole mechanism).

### 1.4 Boot and availability

* **`pg_advisory_lock` behind the transaction pooler** was a slow-motion
  deadlock: a session-scoped lock is taken on a random backend and is *not*
  released when the pooled connection returns, so a crash — or simply a normal
  return to the pool — leaves that backend holding it and the next boot blocks
  forever. Now `pg_advisory_xact_lock`, inside one transaction that also does
  the schema work, released by COMMIT *or* ROLLBACK.
* **`--preload` + a connection pool** (see `render.yaml`) means gunicorn's
  master opens the pool *before forking*, and both workers inherit the same TCP
  sockets — two processes taking turns on one Postgres connection. The pool now
  notices the pid changed and rebuilds itself per worker.
* A database that is briefly unreachable at boot no longer puts the service in
  a crash-restart loop: the process starts, `/healthz` reports 503, and
  initialisation is retried on demand until it succeeds.
* Connection and pool-checkout timeouts are bounded (8s), so a database outage
  is a fast, clear error instead of a frozen browser tab. Stale pooled
  connections are validated before use.
* `app.run(debug=True)` was **unconditional** — anyone who could reach the port
  got an interactive Python console on the first traceback, i.e. remote code
  execution. Now opt-in for local development and impossible in production.

### 1.5 Smaller, still real

* `log_audit` swallowed its errors, which on Postgres **aborts the entire
  transaction** — turning a harmless logging problem into a lost bill. It now
  runs inside a `SAVEPOINT`.
* `next_bill_number` raised `TypeError` mid-sale if a counter row was ever
  missing (cashier sees a bare 500, cannot take money). It now recreates the
  counter at the correct high-water mark so no bill number is ever reused.
* Internal exception text was returned to the client (`Failed to save bill:
  <psycopg internals>`). Now logged server-side, generic message out.
* Unhandled exceptions could reach the till as an HTML error page, which
  `apiFetch` cannot parse. Everything is JSON now.
* CSV export: customer names are written exactly as typed, so a "customer"
  named `=HYPERLINK(...)` executed when the owner opened their own sales
  report. Neutralised.
* CSV export and bill/session item lists are bounded (they were unbounded and
  grew with the trading history).
* The login-throttle map had no eviction and grew without limit under a login
  flood.
* The public QR ordering endpoint — the only unauthenticated write in the
  system — now caps lines per order and rate-limits per table.
* `init_db()`'s `first_time` flag was computed after the file it tests for had
  already been created, so it was always `False`.

---

## 2. Track C (AWS)

### 2.1 The menu seed destroyed the owner's photos — *the repo's own failing test*

`npm test` had **1 failing test** before this pass. It was right: after
`db/data/menu-images.json` was added, re-running `seed-menu.mjs` (something you
do to fix a price) silently overwrote every item photo set by hand. The
manifest is now a **default**, filling in only where no image exists;
`--force-images` restores the old behaviour when the manifest really is the
source of truth.

### 2.2 `lib/db.ts` — three ways the Lambda dies in production

* **No `pool.on('error')` handler.** `pg` emits `error` on *idle* clients when
  the server hangs up — an RDS Proxy failover, an idle reap, a database deploy.
  An `error` event with no listener is an **uncaught exception in Node**, which
  kills the whole Lambda container including whatever else it was serving.
  Absorbed and logged; the pool recovers on its own.
* **Rotated credentials were cached forever.** The database secret is rotated;
  a warm container kept the old password, so from the moment of rotation every
  invocation in that container failed authentication — for as long as the
  container stayed warm. Any auth failure now discards the cache and retries.
* **TLS would have failed on first deploy.** RDS presents certificates signed
  by the Amazon RDS CA, which is *not* in Node's default trust store, so
  `rejectUnauthorized: true` alone refuses every connection. `DB_CA_BUNDLE` /
  `DB_CA_PEM` supply it; verification can only be disabled by setting
  `DB_TLS_INSECURE=true` explicitly.
* Connection, statement and query timeouts are now bounded.

### 2.3 Idempotency depended on two clocks agreeing

`claimIdempotencyKey` decided "did *I* just insert this row?" by checking
whether it was less than 250 ms old — comparing the **Lambda's** clock against
the **database's**. A few hundred milliseconds of skew (entirely normal) either
made the first caller believe someone else held the claim, so **a paid order
was never created**, or made a stale claim look brand new. It now uses
`INSERT … RETURNING`, which is the database's own unambiguous answer, and
measures staleness entirely inside the database.

### 2.4 Retry-safe billing, matching Track A

`createBill` had no idempotency: a retried POST was a second bill. Added
`bills.client_ref` with a partial unique index, dedupe-on-read and
dedupe-on-conflict, and the key wired through the three till screens. A till
that sends no key behaves exactly as before.
*Proof:* `test/bill-retry.test.ts`, including 6 concurrent retries of one sale.

### 2.5 The two handlers with zero runtime coverage

PRD §5.3 flagged `qrApi.ts` and `exportReport.ts` as ported, lint-clean and
**never actually executed**. They now have 9 integration tests against a real
Postgres (`test/qr-and-export.test.ts`), which is how these were found:

* the public QR order route had **no cap on the number of lines** (each line is
  a database round trip on an unauthenticated endpoint);
* `qty` was validated with `Number.isFinite`, so **2.5 was accepted** — half a
  portion priced as a real line, with a fractional quantity on the kitchen
  ticket. Track A parses it with `int()`; they now agree;
* the CSV export had the same spreadsheet-formula-injection hole as Track A,
  and no row limit — and a Lambda response is hard-capped at 6 MB by API
  Gateway, so "export everything" eventually fails with an opaque platform
  error. It now refuses with a sentence the owner can act on.

---

## 3. Track B (Firebase)

Verified against the real Firestore/Auth/Functions emulators: **121 jest + 99
emulator tests, 0 failing.**

Track B's idempotency does *not* have Track C's clock bug — it uses
`snap.exists` inside a Firestore transaction, which is unambiguous. The port to
Postgres introduced that one.

Fixed here, matching the other tracks: CSV formula injection, the unbounded
export, the missing QR line cap, and `Number.isFinite` accepting a fractional
quantity.

---

## 4. Known gaps — deliberately not fixed

* **Track B `createBill` has no idempotency key.** Firestore has no unique
  index, so this needs a claims collection or deterministic document ids —
  a real design change, not a patch, and Track B is the least likely to be
  deployed. If Track B is chosen, do this before go-live.
* **No WAF / bot protection on the AWS public routes.** Already flagged in
  PRD §5.3; unchanged. The in-process QR rate limit added to Track A has no
  Track C equivalent, because Lambda has no process to keep it in.
* **The `--preload` fix makes the pool fork-safe; it does not make
  `render.yaml` ideal.** Consider dropping `--preload` as well.
* Cognito and the AWS WebSocket layer still have no real-world exercise
  (PRD §5.3). Nothing in this pass changed that.
* `aws/db/data/` is still untracked in git — including the menu card the seed
  script reads.

---

## 5. Contract changes for the Website team

Per PRD §6, the `/api/website/*` contract is shared with a separately developed
website. **Its request and response shapes are unchanged.** One behavioural
change is worth telling them about:

* `POST /api/website/orders` — the `in_progress` path is now decided by the
  database rather than by comparing clocks. In practice this makes the existing
  `409 { code: "processing" }` **more** reliable: a first request can no longer
  be mistaken for a concurrent duplicate and refused. No new status codes, no
  new fields, no retry-logic changes needed on their side.

Everything else in this pass is internal.
