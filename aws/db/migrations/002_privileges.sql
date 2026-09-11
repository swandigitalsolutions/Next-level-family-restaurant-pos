-- Second line of defense for immutability (mirrors Firestore rules:
-- "bills"/"auditLog" allow update,delete: if false for everyone).
-- The Lambda execution role connects as `pos_app`; revoke UPDATE/DELETE on the
-- append-only tables so even a bug in handler code cannot mutate history —
-- Postgres itself refuses it.
--
-- Run once per environment after 001_init.sql. Requires a role `pos_app` to
-- already exist (created by aws/infra CDK via a Secrets-Manager-rotated user,
-- or manually: CREATE ROLE pos_app LOGIN PASSWORD '...';).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_app') THEN
    RAISE NOTICE 'Role pos_app does not exist yet — run this after the app DB user is created.';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pos_app;

-- Immutable / append-only tables: INSERT + SELECT only.
REVOKE UPDATE, DELETE ON bills FROM pos_app;
REVOKE UPDATE, DELETE ON audit_log FROM pos_app;
REVOKE UPDATE, DELETE ON website_payments FROM pos_app; -- webhook markers, write-once per id (INSERT ... ON CONFLICT DO NOTHING)

-- Credentials / throttle / idempotency ledger: app-only, never exposed to any
-- "read all" admin API — enforced at the handler layer (no handler selects
-- user_credentials except the login handler; see backend/src/handlers/callable/loginWithPassword.ts).
