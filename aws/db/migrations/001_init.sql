-- Next Level Family Restaurant POS — PostgreSQL schema (AWS RDS target)
-- Faithful translation of firebase/FIRESTORE-SCHEMA.md, itself verified against
-- backend/database.py + backend/app.py. Every money field is INTEGER (paise)
-- or NUMERIC(10,2) rupees exactly matching the Firestore generation's rounding
-- (lib/money.ts round2 semantics ported to backend/src/lib/money.ts).
--
-- Conventions:
--   * All PKs are the same deterministic ids used by the Firestore migration
--     (text ids, e.g. 'u_42', 'item_food_7') so the Firestore->Postgres ETL
--     (db/scripts/migrate-from-firestore.mjs) is a straight 1:1 copy — no
--     re-keying, no lookup tables, re-run-safe (ON CONFLICT DO UPDATE).
--   * created_at/updated_at are timestamptz, always written server-side.
--   * date_key ('YYYY-MM-DD', Asia/Kolkata) and hour (0..23) are denormalized
--     at write time by the Lambda handlers (lib/money.ts dateKey()), exactly
--     as the Firestore version did — avoids a timezone-aware query on every read.
--   * bills and audit_log are INSERT-only at the application layer; enforced
--     by REVOKE UPDATE/DELETE from the app role (see 002_privileges.sql) as a
--     second line of defense beyond the Lambda code path.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ── 1. users ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  uid           text PRIMARY KEY,             -- 'u_<legacyId>', == Cognito sub
  username      text NOT NULL,
  username_lower text NOT NULL,
  full_name     text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('admin','manager','owner','billing','kitchen','cafe_billing')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  cognito_sub   text UNIQUE,                  -- set once the Cognito user is provisioned
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  legacy_id     integer
);
CREATE UNIQUE INDEX users_username_lower_uq ON users (username_lower);
CREATE INDEX users_role_status_idx ON users (role, status);

-- credentials kept separate from `users` (same isolation as userCredentials/{uid}:
-- never selected by any handler except the login handler). Cognito is the
-- primary auth path; this table exists only for the ETL/rollback window and
-- for any legacy-password verification during migration cutover.
CREATE TABLE user_credentials (
  uid            text PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  username_lower text NOT NULL,
  password_hash  text NOT NULL,               -- werkzeug hash, verified by lib/werkzeugHash.ts port
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_credentials_username_lower_idx ON user_credentials (username_lower);

-- ── 2. categories ───────────────────────────────────────────────────────────
CREATE TABLE categories (
  id           text PRIMARY KEY,              -- 'cat_<kind>_<legacyId>'
  kind         text NOT NULL CHECK (kind IN ('food','alcohol','cafe')),
  sales_channel text NOT NULL CHECK (sales_channel IN ('RESTAURANT','OUTSIDE_CAFE')),
  name         text NOT NULL,
  name_lower   text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  legacy_id    integer
);
CREATE UNIQUE INDEX categories_kind_namelower_uq ON categories (kind, name_lower) WHERE status = 'active';
CREATE INDEX categories_kind_status_sort_idx ON categories (kind, status, sort_order);

-- ── 3. catalog ──────────────────────────────────────────────────────────────
CREATE TABLE catalog (
  id            text PRIMARY KEY,             -- 'item_<kind>_<legacyId>'
  kind          text NOT NULL CHECK (kind IN ('food','alcohol','cafe')),
  sales_channel text NOT NULL CHECK (sales_channel IN ('RESTAURANT','OUTSIDE_CAFE')),
  name          text NOT NULL,
  name_lower    text NOT NULL,
  category_id   text NOT NULL REFERENCES categories(id),
  category_name text NOT NULL,
  category_sort integer NOT NULL DEFAULT 0,
  price         numeric(10,2) NOT NULL CHECK (price >= 0),
  tax_rate      numeric(6,3) NOT NULL DEFAULT 0,
  stock_qty     integer,                      -- NULL = untracked/unlimited
  brand         text,
  bottle_size   text,
  description   text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  image_path    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  legacy_id     integer
);
CREATE INDEX catalog_kind_status_sort_name_idx ON catalog (kind, status, category_sort, name_lower);
CREATE INDEX catalog_status_category_name_idx ON catalog (status, category_id, name_lower);
CREATE INDEX catalog_name_lower_trgm_idx ON catalog (name_lower);

-- ── 4. tables ───────────────────────────────────────────────────────────────
CREATE TABLE restaurant_tables (
  id                text PRIMARY KEY,         -- 'tbl_<legacyId>'
  table_no          text NOT NULL,
  seats             integer NOT NULL DEFAULT 2,
  status            text NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied')),
  qr_token          text NOT NULL,
  open_session_id   text,                     -- FK added after table_sessions exists
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  legacy_id         integer
);
CREATE UNIQUE INDEX restaurant_tables_table_no_uq ON restaurant_tables (table_no);
CREATE UNIQUE INDEX restaurant_tables_qr_token_uq ON restaurant_tables (qr_token);

-- ── 5. table_sessions (+ inlined items as JSONB, matching the Firestore array) ─
CREATE TABLE table_sessions (
  id               text PRIMARY KEY,          -- 'sess_<legacyId>'
  table_id         text NOT NULL REFERENCES restaurant_tables(id),
  table_no         text NOT NULL,
  customer_name    text NOT NULL DEFAULT 'Walk-in',
  customer_phone   text NOT NULL DEFAULT '-',
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled')),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  opened_by_uid    text REFERENCES users(uid),
  settled_at       timestamptz,
  items            jsonb NOT NULL DEFAULT '[]'::jsonb, -- SessionLine[] — see FIRESTORE-SCHEMA §6
  subtotal         numeric(10,2) NOT NULL DEFAULT 0,
  tax              numeric(10,2) NOT NULL DEFAULT 0,
  grand_total      numeric(10,2) NOT NULL DEFAULT 0,
  settled_bill_ids text[] NOT NULL DEFAULT '{}',
  legacy_id        integer
);
CREATE INDEX table_sessions_table_open_idx ON table_sessions (table_id, status);

ALTER TABLE restaurant_tables
  ADD CONSTRAINT restaurant_tables_open_session_fk
  FOREIGN KEY (open_session_id) REFERENCES table_sessions(id);

-- ── 6. bills (+ inlined items) — immutable; INSERT-only enforced via privileges ─
CREATE TABLE bills (
  id                  text PRIMARY KEY,       -- 'bill_<type>_<legacyId>' / 'bill_<gen>'
  bill_no             text NOT NULL,
  bill_no_lower       text NOT NULL,
  type                text NOT NULL CHECK (type IN ('FOOD','ALCOHOL','CAFE')),
  source              text NOT NULL CHECK (source IN ('table','counter','website','cafe')),
  table_id            text REFERENCES restaurant_tables(id),
  table_session_id    text REFERENCES table_sessions(id),
  customer_name       text NOT NULL DEFAULT '',
  customer_phone      text NOT NULL DEFAULT '',
  customer_name_lower text NOT NULL DEFAULT '',
  search_tokens       text[] NOT NULL DEFAULT '{}',
  subtotal            numeric(10,2) NOT NULL,
  discount            numeric(10,2) NOT NULL DEFAULT 0,
  tax                 numeric(10,2) NOT NULL DEFAULT 0,
  grand_total         numeric(10,2) NOT NULL,
  payment_method      text NOT NULL DEFAULT 'Cash',
  status              text NOT NULL DEFAULT 'confirmed',
  created_by_uid      text REFERENCES users(uid),
  created_at          timestamptz NOT NULL DEFAULT now(),
  date_key            text NOT NULL,
  hour                smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  items               jsonb NOT NULL,         -- BillLine[]
  website_order_id    text,
  website_order_no    text,
  deposit_paid_paise  integer,
  legacy_id           integer,
  -- Retry key supplied by the till. A bill POST that the browser had to send
  -- twice (counter wifi, an impatient second tap, a reloaded tab) carries the
  -- same value both times, and the unique index below makes "one bill per
  -- sale" a fact the database enforces rather than something the handler
  -- hopes for.
  client_ref          text
);
CREATE UNIQUE INDEX bills_bill_no_uq ON bills (bill_no);
CREATE UNIQUE INDEX bills_client_ref_uq ON bills (client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX bills_type_created_idx ON bills (type, created_at DESC);
CREATE INDEX bills_datekey_created_idx ON bills (date_key, created_at DESC);
CREATE INDEX bills_type_datekey_created_idx ON bills (type, date_key, created_at DESC);
CREATE INDEX bills_search_tokens_gin_idx ON bills USING gin (search_tokens);
CREATE INDEX bills_created_idx ON bills (created_at DESC);

-- ── 7. counters — gap-safe sequence, mutated only inside a serializable txn ──
CREATE TABLE counters (
  name       text PRIMARY KEY,   -- 'foodBill' | 'alcoholBill' | 'qrOrder' | 'website' | 'cafeBill'
  value      integer NOT NULL DEFAULT 0,
  prefix     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO counters (name, value, prefix) VALUES
  ('foodBill', 0, 'FOOD'), ('alcoholBill', 0, 'ALC'), ('qrOrder', 0, 'QR'),
  ('website', 0, 'WEB'), ('cafeBill', 0, 'CAFE');

-- ── 8. qr_orders (+ inlined items) ───────────────────────────────────────────
CREATE TABLE qr_orders (
  public_ref        text PRIMARY KEY,         -- uuid hex, == old doc id
  order_no          text NOT NULL,
  table_id          text NOT NULL REFERENCES restaurant_tables(id),
  table_no          text NOT NULL,
  customer_name     text NOT NULL DEFAULT 'Guest',
  note              text,
  status            text NOT NULL DEFAULT 'NEW'
                      CHECK (status IN ('NEW','ACCEPTED','PREPARING','READY','SERVED','CANCELLED')),
  subtotal          numeric(10,2) NOT NULL,
  tax               numeric(10,2) NOT NULL,
  grand_total       numeric(10,2) NOT NULL,
  pushed_to_bill    boolean NOT NULL DEFAULT false,
  table_session_id  text REFERENCES table_sessions(id),
  kitchen_ticket_id text,
  kitchen_status    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  date_key          text NOT NULL,
  items             jsonb NOT NULL,
  legacy_id         integer
);
CREATE UNIQUE INDEX qr_orders_order_no_uq ON qr_orders (order_no);
CREATE INDEX qr_orders_status_created_idx ON qr_orders (status, created_at DESC);
CREATE INDEX qr_orders_datekey_created_idx ON qr_orders (date_key, created_at DESC);
CREATE INDEX qr_orders_table_datekey_created_idx ON qr_orders (table_id, date_key, created_at DESC);

-- ── 9. audit_log — append-only ───────────────────────────────────────────────
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_uid    text REFERENCES users(uid),
  actor_username text,
  actor_role   text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  legacy_id    integer,
  -- ETL re-run safety: every migrated row carries the SOURCE Firestore doc
  -- id (regardless of whether it also has a legacyId — most runtime-created
  -- audit rows won't) so migrate-from-firestore.mjs's INSERT is idempotent
  -- via ON CONFLICT no matter when the row was created relative to
  -- migration. NULL for rows created directly by this Postgres app post-cutover.
  source_doc_id text
);
CREATE UNIQUE INDEX audit_log_source_doc_id_uq ON audit_log (source_doc_id) WHERE source_doc_id IS NOT NULL;
CREATE INDEX audit_log_entitytype_created_idx ON audit_log (entity_type, created_at DESC);
CREATE INDEX audit_log_action_created_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- ── 10. stats — dashboard rollups (maintained by triggers/rebuild Lambda) ───
CREATE TABLE stats_rolling (
  id           text PRIMARY KEY DEFAULT 'rolling',
  today        jsonb NOT NULL DEFAULT '{}'::jsonb,
  trend        jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_mix  jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_items    jsonb NOT NULL DEFAULT '[]'::jsonb,
  hourly_flow  jsonb NOT NULL DEFAULT '[]'::jsonb,
  menu_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO stats_rolling (id) VALUES ('rolling');

CREATE TABLE stats_daily (
  date_key    text PRIMARY KEY,
  food_sales  numeric(12,2) NOT NULL DEFAULT 0,
  alcohol_sales numeric(12,2) NOT NULL DEFAULT 0,
  cafe_sales  numeric(12,2) NOT NULL DEFAULT 0,
  food_bills  integer NOT NULL DEFAULT 0,
  alcohol_bills integer NOT NULL DEFAULT 0,
  cafe_bills  integer NOT NULL DEFAULT 0,
  payment_mix jsonb NOT NULL DEFAULT '{}'::jsonb,
  hourly      jsonb NOT NULL DEFAULT '{}'::jsonb,
  items       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 11. auth_throttle — login lockout ────────────────────────────────────────
CREATE TABLE auth_throttle (
  ip_hash    text PRIMARY KEY,   -- sha256(ip)
  count      integer NOT NULL DEFAULT 0,
  locked_at  bigint             -- epoch ms, NULL if not locked
);

-- ── 12. config — small runtime config ────────────────────────────────────────
CREATE TABLE app_config (
  id         text PRIMARY KEY,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 13. website_orders (+ inlined items) ─────────────────────────────────────
CREATE TABLE website_orders (
  id                text PRIMARY KEY DEFAULT ('wo_' || gen_random_uuid()::text),
  ref               text NOT NULL,            -- 'WEB-000123'
  channel           text NOT NULL DEFAULT 'website',
  status            text NOT NULL DEFAULT 'PENDING_PAYMENT'
                      CHECK (status IN ('PENDING_PAYMENT','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED','PAYMENT_FAILED')),
  payment_status    text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','ADVANCE_PAID','FAILED','REFUNDED')),
  customer          jsonb NOT NULL,           -- { name, phone, email }
  fulfillment       jsonb NOT NULL,           -- { type, pickupAt, notes }
  items             jsonb NOT NULL,
  subtotal_paise    integer NOT NULL,
  tax_paise         integer NOT NULL DEFAULT 0,
  total_paise       integer NOT NULL,
  advance_paise     integer NOT NULL,
  balance_paise     integer NOT NULL,
  paid_paise        integer NOT NULL DEFAULT 0,
  payment           jsonb NOT NULL DEFAULT '{}'::jsonb, -- { provider, providerOrderId, keyId, amountPaise }
  payments          jsonb NOT NULL DEFAULT '[]'::jsonb,
  settled_bill_ids  text[] NOT NULL DEFAULT '{}',
  settled_bill_nos  text[] NOT NULL DEFAULT '{}',
  kitchen_ticket_id text,
  kitchen_status    text,
  idempotency_key   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  settled_at        timestamptz,
  date_key          text NOT NULL
);
CREATE UNIQUE INDEX website_orders_ref_uq ON website_orders (ref);
CREATE UNIQUE INDEX website_orders_idempotency_key_uq ON website_orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX website_orders_status_created_idx ON website_orders (status, created_at DESC);
CREATE INDEX website_orders_datekey_created_idx ON website_orders (date_key, created_at DESC);
CREATE INDEX website_orders_provider_order_idx ON website_orders (((payment->>'providerOrderId')));

-- ── 14. website_order_idempotency — the authoritative idempotency ledger ────
-- Mirrors firebase/functions/src/lib/idempotency.ts exactly: claim/resume/
-- duplicate/in_progress/conflict, via SELECT … FOR UPDATE inside a txn
-- (Postgres row lock == Firestore tx.create() atomic lock).
CREATE TABLE website_order_idempotency (
  key            text PRIMARY KEY CHECK (key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash   text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  order_id       text,
  ref            text,
  pending_order  jsonb,           -- stashed request payload used to resume after a crash mid-request
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
-- retention: a scheduled Lambda (or RDS pg_cron) deletes rows with
-- created_at < now() - interval '25 hours', mirroring RETAIN_MS in idempotency.ts.

-- ── 15. website_payments — Razorpay webhook idempotency markers ────────────
CREATE TABLE website_payments (
  marker_id       text PRIMARY KEY,   -- razorpayPaymentId, or 'order_paid:<orderId>'
  ref             text,
  event           text NOT NULL,
  amount_paise    integer,
  amount_mismatch boolean,
  rejected        text,
  at              timestamptz NOT NULL DEFAULT now()
);

-- ── 16. kitchen_tickets ──────────────────────────────────────────────────────
CREATE TABLE kitchen_tickets (
  id                text PRIMARY KEY DEFAULT ('kt_' || gen_random_uuid()::text),
  source            text NOT NULL CHECK (source IN ('qr','website')),
  source_id         text NOT NULL,
  ref               text NOT NULL,
  table_label       text,
  customer_name     text,
  items             jsonb NOT NULL,   -- [{ name, kind, qty, note }]
  status            text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PREPARING','READY','DONE')),
  note              text,
  accepted_by_uid   text REFERENCES users(uid),
  accepted_by_username text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  ready_at          timestamptz,
  done_at           timestamptz,
  date_key          text NOT NULL
);
CREATE UNIQUE INDEX kitchen_tickets_source_sourceid_uq ON kitchen_tickets (source, source_id); -- idempotent accept
CREATE INDEX kitchen_tickets_status_created_idx ON kitchen_tickets (status, created_at ASC);
CREATE INDEX kitchen_tickets_datekey_created_idx ON kitchen_tickets (date_key, created_at ASC);

-- ── 17. realtime connection registry (API Gateway WebSocket) ────────────────
-- Firestore's onSnapshot has no direct AWS equivalent; realtime is rebuilt on
-- API Gateway WebSocket APIs (see aws/infra/lib/realtime-stack.ts). Each
-- connected client (Kitchen screen, Billing "Live Orders" board) is tracked
-- here so a kitchen_tickets / qr_orders / website_orders write can fan out a
-- push instead of the client polling.
CREATE TABLE ws_connections (
  connection_id text PRIMARY KEY,
  uid            text REFERENCES users(uid),
  role           text NOT NULL,
  channel        text NOT NULL,   -- 'kitchen' | 'live_orders' | 'website_orders'
  connected_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ws_connections_channel_idx ON ws_connections (channel);

COMMIT;
