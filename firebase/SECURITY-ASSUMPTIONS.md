# Security assumptions & open items (running list)

## Phase 2 — Authentication

### Assumptions the design relies on
1. **Werkzeug hash portability.** `users/{uid}.passwordHash` holds the existing
   Werkzeug string (`scrypt:32768:8:1$salt$hex` today). `checkPasswordHash` in
   `functions/src/lib/werkzeugHash.ts` recomputes it with Node `crypto` and
   compares timing-safe. Proven equivalent both directions against
   `werkzeug 3.0.3` (see MIGRATION.md verification log). If prod ever upgrades
   Werkzeug and changes default params, the stored strings still self-describe
   their params, so verification keeps working; only `generatePasswordHash`'s
   default would need a bump.
2. **Custom-token flow, no Firebase password.** The Firebase Auth user has NO
   password. The credential of record is the Werkzeug hash in Firestore. Anyone
   who can mint a custom token for a uid (i.e. holds the service-account key) can
   impersonate — same trust level as the current Flask `SECRET_KEY`. Protect the
   service account accordingly.
3. **Role claim is authoritative.** `request.auth.token.role` drives every
   Function `assertRole` and every Firestore rule. It is set by
   `authService.setRoleClaim` (Admin SDK) on login, on staff-create, and on every
   role change. A stale client token keeps an old role for up to ~1 h unless the
   client calls `getIdToken(true)`.
   - **Mitigation for deactivation:** `deactivateStaff` / `updateStaff→inactive`
     also calls `admin.auth().updateUser(uid,{disabled:true})`, which immediately
     blocks token refresh, and `auth.js` runs a `users/{uid}` snapshot listener
     that signs the user out when `status !== "active"`.
   - **Residual risk:** a role *downgrade* (admin→staff) without deactivation is
     not instant — the downgraded user keeps elevated access until their token
     refreshes. Flask had the same window except for the acting session. Accept,
     or force-refresh on sensitive screens in Phase 5.
4. **Login throttle is now durable + shared.** Moved from the per-process
   `_LOGIN_ATTEMPTS` dict to `authThrottle/{sha256(ip)}`. Key is the first
   `X-Forwarded-For` hop (or socket IP). Same 6-attempts / 5-minute policy.
   - **Residual risk:** an attacker rotating source IPs still gets 6 tries each.
     Same as Flask. Add App Check + a per-username counter later if needed.
5. **App Check is OFF in this phase** (`ENFORCE_APP_CHECK` unset). `loginWithPassword`
   is callable by anyone who can reach the project. **Before production**
   set `ENFORCE_APP_CHECK=true` (enables `enforceAppCheck` + `consumeAppCheckToken`
   on the login callable) and register a reCAPTCHA v3 / Play Integrity provider.
   The public QR endpoints (Phase 4) have the same requirement.
6. **Client route gating is cosmetic.** `page-gate.js` mirrors `common.js`
   exactly, but real enforcement is server-side: Firestore rules by claim +
   `assertRole` in every write Function. Never rely on the gate alone.
7. **Password hashes are unreachable by any browser (Phase 2 hardening).**
   Hashes live ONLY in `userCredentials/{uid}`, whose Firestore rule is
   `allow read, write: if false` for *every* client — anonymous, self, manager,
   admin. The `users/{uid}` profile doc (admin/self-readable) carries no
   credential field. The Staff screen (Phase 5) calls the `listStaff` **callable**
   (admin claim), which returns only `{id, username, full_name, phone, role,
   status}` via an allowlist mapping (`repo.toProfile`) — even a stray
   `passwordHash` accidentally written into a `users` doc would not be returned.
   `createStaff` writes the hash via `writeCredential` (→ `userCredentials`),
   never into the profile; `updateStaff` password resets go through
   `updateCredential`. Audit `details` never include the hash.
   Proven by: `repoIsolation.test.ts`, `staffAdmin.test.ts` (sanitization +
   routing), and the `userCredentials` cases in `auth.rules.test.mjs`
   (execution deferred to a JDK host).

### Deferred / to verify with a JDK present
- Execute `firebase/tests/rules/auth.rules.test.mjs` under the Firestore emulator
  (claim scoping + "no client writes" invariants). Runner auto-runs it once a JDK
  is on PATH or at `firebase/tools/jdk/`.
- Real Auth-emulator E2E: `loginWithPassword` → `signInWithCustomToken` →
  `getIdTokenResult().claims.role`, and `createStaff` creating a real Auth user.
  Currently the token-mint / claim-set boundary is mocked in unit tests.

## Phase 3 — Firestore rules / data model

### Trust model in the completed ruleset (`firestore.rules`)
- **No unauthenticated Firestore access anywhere**, with ONE exception: `get` (single
  document, not `list`) on `qrOrders/{publicRef}` — the ref is an opaque uuid that is
  also the doc id, so this is "unguessable URL" access for the customer order tracker
  (same data Flask's public `/api/qr/orders/<ref>` returns). The whole QR *menu* flow
  still goes through the `qrApi` Cloud Function (Admin SDK) — clients cannot enumerate
  `tables` to harvest `qrToken`s (`list` denied).
- **6 roles**: `admin`, `manager`, `owner`, `billing` (was `staff`), `kitchen`,
  `cafe_billing` (was `cafe`). Legacy names normalised to the canonical form at every
  boundary. Rules helpers: `isBilling` (billing/manager/admin), `isCafe`
  (cafe_billing/manager/admin), `isKitchen` (kitchen/manager/admin), `isAuditReader`
  (**admin + owner only**), `isOps` (any operational role — catalog/name reads),
  `isOwnerOrOps`. Backend `assertRole` on every callable + `page-gate.js` + custom
  claims + rules all enforce the same matrix; direct-URL access is redirected, not
  just hidden. Proven end-to-end in `functions/test/emulator/phase8-role-matrix.test.mjs`
  (every callable × every role) and the `tests/rules/*` specs.
- **`owner` sees the dashboard and the logs only** — reads limited to `stats/**`,
  `config/**`, and `auditLog`; denied on `catalog`, `categories`, `tables`,
  `tableSessions`, `bills`, `qrOrders`, `websiteOrders`, `kitchenTickets`; **zero
  mutating callables** (phase8 test: "OWNER cannot mutate ANY operational callable").
- **`manager` has NO audit-log access** and NO staff/role management — `auditLog`
  read is `admin + owner` only (`isAuditReader`), `staff.html` + `staffAdmin`
  callables are `admin` only.
- **`kitchen` is the kitchen screen only** (`page-gate` → `kitchen.html`); reads
  `kitchenTickets` + `catalog` (item names), may step a ticket's `status` one way,
  and **cannot** accept orders, settle bills, or alter any amount. **`cafe_billing`
  is the cafe till only** (`page-gate` → `cafe-billing.html`); reads `OUTSIDE_CAFE`
  `catalog` + `bills`, calls `createBill type:"CAFE"`, and **cannot** modify the
  catalog or touch restaurant/bar billing.
- **Three narrow client writes exist**, all role-gated and field-diff-checked:
  1. `tableSessions/{id}` update while `status=='open'` (`isBilling()`) — may change only
     `customerName`, `customerPhone`, `items`, `subtotal`, `tax`, `grandTotal`, `updatedAt`.
     Cannot flip `status`, set `settledAt`/`settledBillIds`, or change `tableId`/`openedByUid`.
     A settled session is frozen. Session *create*/*delete* is Function-only.
  2. `qrOrders/{ref}` update (`isBilling()`) — may change only `status` (+`updatedAt`) and only
     along a legal FSM edge (`NEW→ACCEPTED→PREPARING→READY→SERVED`, or `*→CANCELLED`).
     `pushedToBill`, `tableSessionId`, `items`, totals cannot be touched. Create/delete Function-only.
  3. `kitchenTickets/{id}` update (`isKitchen()`) — may change only `status`/`updatedAt`/
     `readyAt`/`doneAt`, one legal step (`QUEUED→PREPARING→READY→DONE`, forward jumps + `→DONE`).
     Ticket create/delete is Function-only (`acceptOrderToKitchen`).
- **`bills` and `auditLog` are immutable** — `create`, `update`, `delete` all denied for
  every role (Admin SDK bypasses). No void/refund path, matching Flask.
- **`counters`, `userCredentials`, `authThrottle`, `_migration` are fully sealed** (`if false`)
  for reads and writes, every role.
- Everything money/stock/number/role still flows through Cloud Functions (Phase 4).

### Assumptions specific to Phase 3
1. **Table-session line prices are staff-entered snapshots, not re-read from `catalog` at
   settle.** This *matches Flask* (`PUT /api/table-sessions/:id` stores client-supplied
   `price`/`tax_rate`; only the QR *customer* flow re-prices). The settle Function (Phase 4)
   still recomputes every *total* (`splitSettlement`), so the arithmetic is authoritative
   even though a staff member could enter an off-catalog unit price — an insider action the
   `table.settle` audit row records. If you want settle to re-price from `catalog`, that is
   a deliberate hardening to decide in Phase 4, not a bug.
2. **`nextNumber` gap-safety** relies on Firestore transaction serialization + retry. Proven
   in the emulator at 8-way single-doc contention (emulator lock-timeout caps higher stress);
   real Firestore scales further. A missing counter doc throws — the seed/ETL must create all three.
3. **ETL is idempotent by construction**: deterministic doc ids + `set()` without `merge`.
   Re-running overwrites, never duplicates (proven: `idempotency.test.mjs`). `_migration/status`
   with `ok:true` is written last; a crash leaves it unset so a re-run is safe.
4. **`counters` are seeded to `max(source value, max issued suffix)`** so migrated bill
   numbers and post-migration numbers never collide.
5. **ETL never touches production**: `scripts/lib/source.mjs` rejects `postgres://`, and
   `--target live` is refused without `--i-understand-this-writes-production`. Phase 3 only
   ran `--target dry` and `--target emulator`.
6. **Search degradation**: the orders search uses `searchTokens` array-contains
   (exact bill number + word prefixes ≥2 chars). Interior substrings that Flask's
   `LIKE '%q%'` would match do not match. Documented in `FIRESTORE-SCHEMA.md`.

## Unchanged invariants carried over from Flask (all unit-tested)
- Last **active** admin cannot be demoted, deactivated, or deleted.
- A user cannot deactivate their own account.
- Deactivated account cannot log in ("This account has been deactivated…").
- Wrong password and unknown username return the **same** generic message.
- Username rule `^[a-z0-9_.]{3,32}$`; password ≥ 6 chars; role ∈ {admin,manager,owner,billing,kitchen,cafe_billing} (`staff`→`billing`, `cafe`→`cafe_billing` accepted as aliases).
- `owner` is view-only (dashboard/stats only); enforced in rules + `page-gate.js`.
