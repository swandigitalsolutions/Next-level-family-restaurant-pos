"""
NEXT LEVEL FAMILY RESTAURANT - Backend API
Flask + session-based authentication, backed by SQLite locally or PostgreSQL
when DATABASE_URL is set (see database.py).
"""

import csv
import io
import json
import logging
import os
import re
import functools
import secrets
import threading
import time
import uuid
from datetime import datetime

from flask import (
    Flask, g, request, jsonify, session, send_from_directory, redirect, Response,
    has_app_context,
)
from flask_cors import CORS
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash

from database import (
    get_db as _open_db,
    init_db,
    next_bill_number,
    generate_password_hash,
    USE_POSTGRES,
)

log = logging.getLogger("nextlevel")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")

IS_PRODUCTION = bool(os.environ.get("RENDER") or os.environ.get("PRODUCTION"))
_DEFAULT_SECRET = "next-level-family-restaurant-dev-secret-change-me"
_secret_key = os.environ.get("SECRET_KEY", "").strip()
if IS_PRODUCTION and (not _secret_key or _secret_key == _DEFAULT_SECRET):
    # A hardcoded/missing session secret in production would let anyone forge a
    # login session. Fail loudly at boot instead of silently shipping that hole.
    raise RuntimeError(
        "SECRET_KEY environment variable must be set to a random value in production. "
        "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
    )

app = Flask(__name__)
app.secret_key = _secret_key or _DEFAULT_SECRET
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_HTTPONLY"] = True

# When served behind Render's HTTPS proxy, mark the session cookie Secure and
# trust the X-Forwarded-* headers so redirects and URLs use https.
if IS_PRODUCTION:
    app.config["SESSION_COOKIE_SECURE"] = True
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# CORS is only needed when the frontend is opened from a different origin than
# the API (e.g. a separate dev server). Flask serves the frontend directly on
# the same origin by default, so cross-origin credentialed requests are closed
# unless the deployment explicitly lists allowed origins via CORS_ORIGINS
# (comma-separated). "*" is never honoured together with credentials.
_cors_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    CORS(app, supports_credentials=True, origins=_cors_origins)

# Static API keys for server-to-server callers (e.g. the restaurant's public
# website fetching the menu). Deliberately separate from session auth: no
# cookie, no CORS - the caller is another backend, not a browser.
WEBSITE_API_KEYS = {k.strip() for k in os.environ.get("WEBSITE_API_KEYS", "").split(",") if k.strip()}


def require_api_key(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        key = request.headers.get("X-API-Key", "")
        if not key or key not in WEBSITE_API_KEYS:
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)
    return wrapper

# =========================================================
# Request-scoped database connections
# =========================================================
#
# Every route used to do `conn = get_db()` ... `conn.close()` on each exit
# path. With Postgres that connection comes out of a fixed-size pool, so ANY
# exception between those two lines - a bug, a dropped socket, a client
# disconnect - leaked it permanently. Ten such requests and the pool is empty
# and the entire till stops responding until someone restarts the server. That
# is the single worst failure mode this app had.
#
# The connection is now owned by the request, not by the handler: it is opened
# on first use, reused for the rest of that request, and always released in
# teardown, whether the handler returned, raised, or the client vanished.
# `conn.close()` inside a handler stays valid (it just does nothing), so none
# of the existing route code had to change.

class _ScopedConnection:
    """Per-request view of a pooled connection whose close() is deferred."""

    __slots__ = ("_conn",)

    def __init__(self, conn):
        object.__setattr__(self, "_conn", conn)

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        """No-op: teardown_appcontext owns the real close."""
        return None


def get_db():
    if not has_app_context():  # pragma: no cover - scripts/CLI use
        return _open_db()
    conn = getattr(g, "_db_conn", None)
    if conn is None:
        conn = _open_db()
        g._db_conn = conn
    return _ScopedConnection(conn)


@app.teardown_appcontext
def _release_db(exc):
    conn = g.pop("_db_conn", None)
    if conn is None:
        return
    try:
        # Anything not explicitly committed by the handler is abandoned. On the
        # error path this is what stops a half-written bill from being visible.
        conn.rollback()
    except Exception:  # noqa: BLE001
        pass
    try:
        conn.close()
    except Exception:  # noqa: BLE001 - a close failure must not mask the real error
        log.exception("Failed to release database connection")


# Ensure the schema exists and seed data is present on every boot. This is
# idempotent and matters for WSGI servers (gunicorn) that never run __main__.
#
# A database that is briefly unreachable at boot must not put the server into a
# crash-restart loop: the process starts anyway, reports itself unhealthy, and
# retries initialisation on demand until it succeeds.
_init_lock = threading.Lock()
_init_done = False
_init_error = None


def ensure_initialized():
    """Run init_db() once per process, retrying on a later request if it failed."""
    global _init_done, _init_error
    if _init_done:
        return True
    with _init_lock:
        if _init_done:
            return True
        try:
            init_db()
            _init_done = True
            _init_error = None
        except Exception as exc:  # noqa: BLE001
            _init_error = exc
            log.exception("Database initialisation failed; will retry on next request")
            return False
    return True


ensure_initialized()


# =========================================================
# Frontend static serving
# =========================================================

@app.route("/")
def index():
    return redirect("/pages/login.html")


@app.route("/healthz")
def healthz():
    """Liveness + readiness for the platform's health check.

    Reports 503 while the schema has not been initialised (database
    unreachable at boot), so a deploy that cannot see its database is visibly
    unhealthy instead of silently serving errors to the till.
    """
    if not _init_done:
        ensure_initialized()
    if not _init_done:
        return jsonify({"status": "degraded", "detail": "database unavailable"}), 503
    return jsonify({"status": "ok"}), 200


@app.route("/pages/<path:filename>")
def serve_pages(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, "pages"), filename)


@app.route("/css/<path:filename>")
def serve_css(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, "css"), filename)


@app.route("/js/<path:filename>")
def serve_js(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, "js"), filename)


@app.route("/assets/<path:filename>")
def serve_assets(filename):
    response = send_from_directory(os.path.join(FRONTEND_DIR, "assets"), filename)
    # Optimized derivatives are stable local assets; let browsers reuse them across
    # billing, menu, and dashboard navigation while keeping a short cache for legacy files.
    max_age = 86400 if filename.startswith("optimized/") else 3600
    response.headers["Cache-Control"] = f"public, max-age={max_age}"
    return response


# =========================================================
# Helpers
# =========================================================

def error(message, status=400):
    return jsonify({"success": False, "error": message}), status


def ok(data=None, status=200):
    payload = {"success": True}
    if data is not None:
        payload["data"] = data
    return jsonify(payload), status


def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return error("Unauthorized. Please log in.", 401)
        return fn(*args, **kwargs)
    return wrapper


# Roles, from most to least privileged:
#   admin   - full access, including staff management and menu/catalog edits
#   manager - operations + catalog edits, but cannot manage staff accounts
#   staff   - billing, table service and QR order handling only (cashier/waiter)
#   owner   - view-only dashboard access (see OWNER_ALLOWED_API below)
VALID_ROLES = {"admin", "manager", "staff", "owner"}
MANAGE_ROLES = ("admin", "manager")


def require_role(*roles):
    """Like login_required, but also 403s if the session role is not one of `roles`."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if not session.get("user_id"):
                return error("Unauthorized. Please log in.", 401)
            if session.get("role") not in roles:
                return error("You do not have permission to perform this action.", 403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


# The "owner" role is view-only: it can reach the dashboard/insights and its own
# session, nothing else. Every other /api route returns 403 for an owner.
OWNER_ALLOWED_API = {"/api/me", "/api/logout", "/api/login", "/api/dashboard", "/api/health"}

# ---------------------------------------------------------------------------
# Login throttling. In-process only (resets on restart / differs per gunicorn
# worker) but still raises the bar against naive password guessing on the
# small login form; a proper deployment should also rate-limit at the proxy.
# ---------------------------------------------------------------------------
_LOGIN_ATTEMPTS = {}
LOGIN_MAX_ATTEMPTS = 6
LOGIN_LOCKOUT_SECONDS = 5 * 60
LOGIN_ATTEMPTS_MAX_KEYS = 4096


def _login_throttle_key():
    return request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()


def _is_login_locked(key):
    entry = _LOGIN_ATTEMPTS.get(key)
    if not entry:
        return False
    count, locked_at = entry
    if count < LOGIN_MAX_ATTEMPTS:
        return False
    if time.time() - locked_at > LOGIN_LOCKOUT_SECONDS:
        _LOGIN_ATTEMPTS.pop(key, None)
        return False
    return True


def _register_login_failure(key):
    # The map is keyed by client IP and nothing ever removed a successful or
    # expired entry, so a long-running worker under a spray of bogus logins grew
    # it without bound. Sweep expired entries whenever it gets large.
    if len(_LOGIN_ATTEMPTS) > LOGIN_ATTEMPTS_MAX_KEYS:
        cutoff = time.time() - LOGIN_LOCKOUT_SECONDS
        for stale in [k for k, (_, at) in _LOGIN_ATTEMPTS.items() if at < cutoff]:
            _LOGIN_ATTEMPTS.pop(stale, None)
        if len(_LOGIN_ATTEMPTS) > LOGIN_ATTEMPTS_MAX_KEYS:
            # Still oversized: everything in it is recent, i.e. an active flood.
            # Drop the oldest half rather than let memory grow without limit.
            for stale, _ in sorted(_LOGIN_ATTEMPTS.items(), key=lambda kv: kv[1][1])[
                : len(_LOGIN_ATTEMPTS) // 2
            ]:
                _LOGIN_ATTEMPTS.pop(stale, None)
    count, _ = _LOGIN_ATTEMPTS.get(key, (0, 0))
    _LOGIN_ATTEMPTS[key] = (count + 1, time.time())


def _clear_login_failures(key):
    _LOGIN_ATTEMPTS.pop(key, None)


@app.before_request
def _require_initialized():
    """Retry a failed boot-time initialisation before serving an API call."""
    if _init_done or not request.path.startswith("/api/"):
        return
    if ensure_initialized():
        return
    return error(
        "The system is starting up or the database is unreachable. "
        "Please try again in a moment.",
        503,
    )


@app.before_request
def _restrict_owner_scope():
    if session.get("role") != "owner":
        return
    path = request.path
    if not path.startswith("/api/"):
        return  # static pages/assets are harmless; the sidebar hides the rest
    if path in OWNER_ALLOWED_API or path.startswith("/api/qr/"):
        return
    return error("This account has view-only dashboard access.", 403)


def to_float(value, field_name, allow_negative=False):
    try:
        val = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be a valid number")
    if not allow_negative and val < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return round(val, 2)


def to_positive_int(value, field_name):
    try:
        val = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be a valid integer")
    if val <= 0:
        raise ValueError(f"{field_name} must be greater than zero")
    return val


def to_optional_stock(value, field_name):
    """Stock quantity input: blank/None means "not tracked" (unlimited)."""
    if value is None or value == "":
        return None
    try:
        val = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be a whole number")
    if val < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return val


# A bill POST that the browser had to retry - flaky wifi at the counter, a
# tab reloaded mid-save, an impatient second click after the first response was
# lost - must not create a second bill. The client sends a random key that stays
# the same across retries of the same sale; the database's unique index on
# client_ref makes "only one bill per key" a fact rather than a hope.
_CLIENT_REF_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,64}$")


def request_client_ref():
    raw = request.headers.get("Idempotency-Key") or ""
    if not raw:
        body = request.get_json(silent=True) or {}
        raw = body.get("client_ref") or ""
    raw = str(raw).strip()
    return raw if _CLIENT_REF_RE.match(raw) else None


def _bill_payload(conn, bill_table, items_table, bill_id, bill_type):
    bill = conn.execute(f"SELECT * FROM {bill_table} WHERE id = ?", (bill_id,)).fetchone()
    if not bill:
        return None
    items = conn.execute(
        f"SELECT * FROM {items_table} WHERE bill_id = ?", (bill_id,)
    ).fetchall()
    result = dict(bill)
    result["items"] = [dict(r) for r in items]
    result["type"] = bill_type
    return result


def _bill_by_client_ref(conn, bill_table, items_table, bill_type, client_ref):
    if not client_ref:
        return None
    row = conn.execute(
        f"SELECT id FROM {bill_table} WHERE client_ref = ?", (client_ref,)
    ).fetchone()
    if not row:
        return None
    return _bill_payload(conn, bill_table, items_table, row["id"], bill_type)


def log_audit(conn, action, entity_type, entity_id=None, details=None):
    """Append an audit trail row for a mutating action. Never raises - a
    logging failure must not roll back or block the action it is describing.

    On Postgres a failed statement poisons the *whole* transaction: every later
    statement, including the COMMIT, fails with "current transaction is
    aborted". Swallowing the audit error therefore used to convert a harmless
    logging problem into a lost bill. The insert runs inside its own SAVEPOINT
    so that if it fails, only it is rolled back and the sale still commits.
    """
    sp = None
    try:
        if USE_POSTGRES:
            sp = f"audit_{secrets.token_hex(4)}"
            conn.execute(f"SAVEPOINT {sp}")
        conn.execute(
            """INSERT INTO audit_log (actor_id, actor_username, actor_role, action, entity_type, entity_id, details)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                session.get("user_id"),
                session.get("username"),
                session.get("role"),
                action,
                entity_type,
                str(entity_id) if entity_id is not None else None,
                json.dumps(details, default=str) if details is not None else None,
            ),
        )
        if sp:
            conn.execute(f"RELEASE SAVEPOINT {sp}")
    except Exception:  # noqa: BLE001
        log.exception("Audit log write failed for %s/%s", action, entity_type)
        if sp:
            try:
                conn.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                conn.execute(f"RELEASE SAVEPOINT {sp}")
            except Exception:  # noqa: BLE001
                pass


def apply_stock_delta(conn, item_kind, item_id, delta):
    """Decrement (or restore, with a positive delta) an item's tracked stock.
    A NULL stock_qty means the item isn't stock-tracked and is left alone;
    tracked stock never goes below zero."""
    if not item_id or not delta:
        return
    table = "food_items" if item_kind == "food" else "alcohol_items"
    # CASE instead of MAX()/GREATEST() - MAX(a, b) is SQLite-only as a scalar
    # function (it's aggregate-only in Postgres, whose equivalent is GREATEST).
    conn.execute(
        f"""UPDATE {table}
            SET stock_qty = CASE WHEN stock_qty + ? < 0 THEN 0 ELSE stock_qty + ? END
            WHERE id = ? AND stock_qty IS NOT NULL""",
        (delta, delta, item_id),
    )


# =========================================================
# Auth routes
# =========================================================

@app.route("/api/login", methods=["POST"])
def login():
    throttle_key = _login_throttle_key()
    if _is_login_locked(throttle_key):
        return error("Too many failed attempts. Please try again in a few minutes.", 429)

    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""

    if not username or not password:
        return error("Username and password are required", 400)

    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()

    if not user or not check_password_hash(user["password_hash"], password):
        _register_login_failure(throttle_key)
        return error("Invalid username or password", 401)

    if (user["status"] or "active") != "active":
        return error("This account has been deactivated. Contact your administrator.", 403)

    _clear_login_failures(throttle_key)
    session.clear()
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["role"] = user["role"]
    session["full_name"] = user["full_name"]

    return ok({
        "id": user["id"],
        "username": user["username"],
        "full_name": user["full_name"],
        "role": user["role"],
    })


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return ok({"message": "Logged out"})


@app.route("/api/me", methods=["GET"])
def me():
    if not session.get("user_id"):
        return error("Unauthorized", 401)
    return ok({
        "id": session["user_id"],
        "username": session["username"],
        "role": session.get("role", "staff"),
        "full_name": session.get("full_name"),
    })


# =========================================================
# Health
# =========================================================

@app.route("/api/health", methods=["GET"])
def health():
    return ok({"status": "healthy", "time": datetime.now().isoformat()})


# =========================================================
# STAFF - Accounts & role-based access (admin only)
# =========================================================

STAFF_FIELDS = "id, username, full_name, phone, role, status, created_at"
USERNAME_RE = re.compile(r"^[a-z0-9_.]{3,32}$")


def _admin_count(conn, exclude_id=None):
    if exclude_id is None:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'"
        ).fetchone()["c"]
    return conn.execute(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active' AND id != ?",
        (exclude_id,),
    ).fetchone()["c"]


@app.route("/api/staff", methods=["GET"])
@require_role("admin")
def list_staff():
    conn = get_db()
    rows = conn.execute(f"SELECT {STAFF_FIELDS} FROM users ORDER BY id").fetchall()
    conn.close()
    return ok([dict(r) for r in rows])


@app.route("/api/staff", methods=["POST"])
@require_role("admin")
def create_staff():
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    full_name = (body.get("full_name") or "").strip()
    phone = (body.get("phone") or "").strip()
    role = (body.get("role") or "staff").strip().lower()

    if not USERNAME_RE.match(username):
        return error("Username must be 3-32 characters: lowercase letters, numbers, dot or underscore only")
    if not full_name:
        return error("Full name is required")
    if len(password) < 6:
        return error("Password must be at least 6 characters")
    if role not in VALID_ROLES:
        return error("Invalid role")

    conn = get_db()
    existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        conn.close()
        return error("A staff account with this username already exists", 409)

    cur = conn.execute(
        "INSERT INTO users (username, password_hash, full_name, phone, role) VALUES (?, ?, ?, ?, ?)",
        (username, generate_password_hash(password), full_name, phone, role),
    )
    log_audit(conn, "staff.create", "user", cur.lastrowid, {"username": username, "role": role})
    conn.commit()
    row = conn.execute(f"SELECT {STAFF_FIELDS} FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/staff/<int:user_id>", methods=["PUT"])
@require_role("admin")
def update_staff(user_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    existing = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Staff member not found", 404)

    full_name = (body.get("full_name") if body.get("full_name") is not None else existing["full_name"]) or ""
    full_name = full_name.strip()
    phone = (body.get("phone") if body.get("phone") is not None else (existing["phone"] or "")).strip()
    role = (body.get("role") or existing["role"] or "staff").strip().lower()
    status = (body.get("status") or existing["status"] or "active").strip().lower()

    if not full_name:
        conn.close()
        return error("Full name is required")
    if role not in VALID_ROLES:
        conn.close()
        return error("Invalid role")
    if status not in ("active", "inactive"):
        conn.close()
        return error("Invalid status")

    # Never allow the last active admin to be demoted, deactivated, or locked out.
    demoting_last_admin = existing["role"] == "admin" and (role != "admin" or status != "active")
    if demoting_last_admin and _admin_count(conn, exclude_id=user_id) == 0:
        conn.close()
        return error("At least one active admin account must remain")

    password = body.get("password")
    if password:
        if len(password) < 6:
            conn.close()
            return error("Password must be at least 6 characters")
        conn.execute(
            "UPDATE users SET full_name = ?, phone = ?, role = ?, status = ?, password_hash = ? WHERE id = ?",
            (full_name, phone, role, status, generate_password_hash(password), user_id),
        )
    else:
        conn.execute(
            "UPDATE users SET full_name = ?, phone = ?, role = ?, status = ? WHERE id = ?",
            (full_name, phone, role, status, user_id),
        )
    log_audit(conn, "staff.update", "user", user_id, {
        "username": existing["username"],
        "role": {"from": existing["role"], "to": role},
        "status": {"from": existing["status"], "to": status},
        "password_reset": bool(password),
    })
    conn.commit()

    # A demoted/deactivated/role-changed user's existing session should not
    # keep the old privileges until it naturally expires.
    if session.get("user_id") == user_id:
        session["role"] = role

    row = conn.execute(f"SELECT {STAFF_FIELDS} FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/staff/<int:user_id>", methods=["DELETE"])
@require_role("admin")
def deactivate_staff(user_id):
    if user_id == session.get("user_id"):
        return error("You cannot remove your own account")
    conn = get_db()
    existing = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Staff member not found", 404)
    if existing["role"] == "admin" and _admin_count(conn, exclude_id=user_id) == 0:
        conn.close()
        return error("At least one active admin account must remain")
    conn.execute("UPDATE users SET status = 'inactive' WHERE id = ?", (user_id,))
    log_audit(conn, "staff.deactivate", "user", user_id, {"username": existing["username"]})
    conn.commit()
    conn.close()
    return ok({"message": "Staff account deactivated"})


# =========================================================
# FOOD - Categories
# =========================================================

@app.route("/api/food/categories", methods=["GET"])
@login_required
def get_food_categories():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM food_categories ORDER BY sort_order, name"
    ).fetchall()
    conn.close()
    return ok([dict(r) for r in rows])


@app.route("/api/food/categories", methods=["POST"])
@require_role(*MANAGE_ROLES)
def add_food_category():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return error("Category name is required")

    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM food_categories WHERE name = ?", (name,)
    ).fetchone()
    if existing:
        conn.close()
        return error("A category with this name already exists", 409)

    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM food_categories"
    ).fetchone()["m"]
    cur = conn.execute(
        "INSERT INTO food_categories (name, sort_order) VALUES (?, ?)",
        (name, max_order + 1),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM food_categories WHERE id = ?", (cur.lastrowid,)
    ).fetchone()
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/food/categories/<int:cat_id>", methods=["PUT"])
@require_role(*MANAGE_ROLES)
def update_food_category(cat_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    existing = conn.execute(
        "SELECT * FROM food_categories WHERE id = ?", (cat_id,)
    ).fetchone()
    if not existing:
        conn.close()
        return error("Category not found", 404)

    name = (body.get("name") or existing["name"]).strip()
    status = body.get("status") or existing["status"]

    conn.execute(
        "UPDATE food_categories SET name = ?, status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        (name, status, cat_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM food_categories WHERE id = ?", (cat_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/food/categories/<int:cat_id>", methods=["DELETE"])
@require_role(*MANAGE_ROLES)
def delete_food_category(cat_id):
    conn = get_db()
    existing = conn.execute(
        "SELECT * FROM food_categories WHERE id = ?", (cat_id,)
    ).fetchone()
    if not existing:
        conn.close()
        return error("Category not found", 404)

    item_count = conn.execute(
        "SELECT COUNT(*) AS c FROM food_items WHERE category_id = ? AND status = 'active'",
        (cat_id,),
    ).fetchone()["c"]
    if item_count > 0:
        conn.close()
        return error("Cannot delete a category that still has active items", 409)

    conn.execute("UPDATE food_categories SET status = 'inactive' WHERE id = ?", (cat_id,))
    conn.commit()
    conn.close()
    return ok({"message": "Category deleted"})


# =========================================================
# FOOD - Items
# =========================================================

@app.route("/api/food/items", methods=["GET"])
@login_required
def get_food_items():
    category_id = request.args.get("category_id")
    conn = get_db()
    if category_id:
        rows = conn.execute(
            """SELECT fi.*, fc.name AS category_name FROM food_items fi
               JOIN food_categories fc ON fc.id = fi.category_id
               WHERE fi.status = 'active' AND fi.category_id = ?
               ORDER BY fi.name""",
            (category_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT fi.*, fc.name AS category_name FROM food_items fi
               JOIN food_categories fc ON fc.id = fi.category_id
               WHERE fi.status = 'active'
               ORDER BY fc.sort_order, fi.name"""
        ).fetchall()
    conn.close()
    return ok([dict(r) for r in rows])


@app.route("/api/food/items", methods=["POST"])
@require_role(*MANAGE_ROLES)
def add_food_item():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return error("Item name is required")
    try:
        category_id = to_positive_int(body.get("category_id"), "category_id")
        price = to_float(body.get("price"), "price")
        stock_qty = to_optional_stock(body.get("stock_qty"), "stock_qty")
    except ValueError as e:
        return error(str(e))
    description = (body.get("description") or "").strip() or None

    conn = get_db()
    cat = conn.execute("SELECT id FROM food_categories WHERE id = ?", (category_id,)).fetchone()
    if not cat:
        conn.close()
        return error("Category not found", 404)

    cur = conn.execute(
        "INSERT INTO food_items (name, category_id, price, stock_qty, description) VALUES (?, ?, ?, ?, ?)",
        (name, category_id, price, stock_qty, description),
    )
    log_audit(conn, "menu.item.create", "food_item", cur.lastrowid, {"name": name, "price": price})
    conn.commit()
    row = conn.execute("SELECT * FROM food_items WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/food/items/<int:item_id>", methods=["PUT"])
@require_role(*MANAGE_ROLES)
def update_food_item(item_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    existing = conn.execute("SELECT * FROM food_items WHERE id = ?", (item_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Item not found", 404)

    try:
        name = (body.get("name") or existing["name"]).strip()
        category_id = to_positive_int(body.get("category_id"), "category_id") if "category_id" in body else existing["category_id"]
        price = to_float(body.get("price"), "price") if "price" in body else existing["price"]
        stock_qty = to_optional_stock(body.get("stock_qty"), "stock_qty") if "stock_qty" in body else existing["stock_qty"]
    except ValueError as e:
        conn.close()
        return error(str(e))
    description = ((body.get("description") or "").strip() or None) if "description" in body else existing["description"]

    status = body.get("status") or existing["status"]

    conn.execute(
        """UPDATE food_items SET name = ?, category_id = ?, price = ?, stock_qty = ?, description = ?, status = ?,
           updated_at = datetime('now','localtime') WHERE id = ?""",
        (name, category_id, price, stock_qty, description, status, item_id),
    )
    if float(existing["price"]) != float(price):
        log_audit(conn, "menu.item.price_change", "food_item", item_id, {
            "name": name, "price": {"from": float(existing["price"]), "to": price},
        })
    conn.commit()
    row = conn.execute("SELECT * FROM food_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/food/items/<int:item_id>", methods=["DELETE"])
@require_role(*MANAGE_ROLES)
def delete_food_item(item_id):
    conn = get_db()
    existing = conn.execute("SELECT * FROM food_items WHERE id = ?", (item_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Item not found", 404)
    conn.execute("UPDATE food_items SET status = 'inactive' WHERE id = ?", (item_id,))
    log_audit(conn, "menu.item.delete", "food_item", item_id, {"name": existing["name"]})
    conn.commit()
    conn.close()
    return ok({"message": "Item deleted"})


# =========================================================
# ALCOHOL - Categories
# =========================================================

@app.route("/api/alcohol/categories", methods=["GET"])
@login_required
def get_alcohol_categories():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM alcohol_categories ORDER BY sort_order, name"
    ).fetchall()
    conn.close()
    return ok([dict(r) for r in rows])


@app.route("/api/alcohol/categories", methods=["POST"])
@require_role(*MANAGE_ROLES)
def add_alcohol_category():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return error("Category name is required")

    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM alcohol_categories WHERE name = ?", (name,)
    ).fetchone()
    if existing:
        conn.close()
        return error("A category with this name already exists", 409)

    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM alcohol_categories"
    ).fetchone()["m"]
    cur = conn.execute(
        "INSERT INTO alcohol_categories (name, sort_order) VALUES (?, ?)",
        (name, max_order + 1),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM alcohol_categories WHERE id = ?", (cur.lastrowid,)
    ).fetchone()
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/alcohol/categories/<int:cat_id>", methods=["PUT"])
@require_role(*MANAGE_ROLES)
def update_alcohol_category(cat_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    existing = conn.execute(
        "SELECT * FROM alcohol_categories WHERE id = ?", (cat_id,)
    ).fetchone()
    if not existing:
        conn.close()
        return error("Category not found", 404)

    name = (body.get("name") or existing["name"]).strip()
    status = body.get("status") or existing["status"]

    conn.execute(
        "UPDATE alcohol_categories SET name = ?, status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        (name, status, cat_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM alcohol_categories WHERE id = ?", (cat_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/alcohol/categories/<int:cat_id>", methods=["DELETE"])
@require_role(*MANAGE_ROLES)
def delete_alcohol_category(cat_id):
    conn = get_db()
    existing = conn.execute(
        "SELECT * FROM alcohol_categories WHERE id = ?", (cat_id,)
    ).fetchone()
    if not existing:
        conn.close()
        return error("Category not found", 404)

    item_count = conn.execute(
        "SELECT COUNT(*) AS c FROM alcohol_items WHERE category_id = ? AND status = 'active'",
        (cat_id,),
    ).fetchone()["c"]
    if item_count > 0:
        conn.close()
        return error("Cannot delete a category that still has active items", 409)

    conn.execute("UPDATE alcohol_categories SET status = 'inactive' WHERE id = ?", (cat_id,))
    conn.commit()
    conn.close()
    return ok({"message": "Category deleted"})


# =========================================================
# ALCOHOL - Items
# =========================================================

@app.route("/api/alcohol/items", methods=["GET"])
@login_required
def get_alcohol_items():
    category_id = request.args.get("category_id")
    conn = get_db()
    if category_id:
        rows = conn.execute(
            """SELECT ai.*, ac.name AS category_name FROM alcohol_items ai
               JOIN alcohol_categories ac ON ac.id = ai.category_id
               WHERE ai.status = 'active' AND ai.category_id = ?
               ORDER BY ai.name""",
            (category_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT ai.*, ac.name AS category_name FROM alcohol_items ai
               JOIN alcohol_categories ac ON ac.id = ai.category_id
               WHERE ai.status = 'active'
               ORDER BY ac.sort_order, ai.name"""
        ).fetchall()
    conn.close()
    return ok([dict(r) for r in rows])


@app.route("/api/alcohol/items", methods=["POST"])
@require_role(*MANAGE_ROLES)
def add_alcohol_item():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return error("Product name is required")
    try:
        category_id = to_positive_int(body.get("category_id"), "category_id")
        price = to_float(body.get("price"), "price")
        tax_rate = to_float(body.get("tax_rate", 0), "tax_rate")
        stock_qty = to_optional_stock(body.get("stock_qty"), "stock_qty")
    except ValueError as e:
        return error(str(e))

    brand = (body.get("brand") or "").strip()
    bottle_size = (body.get("bottle_size") or "").strip()

    conn = get_db()
    cat = conn.execute("SELECT id FROM alcohol_categories WHERE id = ?", (category_id,)).fetchone()
    if not cat:
        conn.close()
        return error("Category not found", 404)

    cur = conn.execute(
        """INSERT INTO alcohol_items (name, category_id, brand, bottle_size, price, tax_rate, stock_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (name, category_id, brand, bottle_size, price, tax_rate, stock_qty),
    )
    log_audit(conn, "menu.item.create", "alcohol_item", cur.lastrowid, {"name": name, "price": price})
    conn.commit()
    row = conn.execute("SELECT * FROM alcohol_items WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/alcohol/items/<int:item_id>", methods=["PUT"])
@require_role(*MANAGE_ROLES)
def update_alcohol_item(item_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    existing = conn.execute("SELECT * FROM alcohol_items WHERE id = ?", (item_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Item not found", 404)

    try:
        name = (body.get("name") or existing["name"]).strip()
        category_id = to_positive_int(body.get("category_id"), "category_id") if "category_id" in body else existing["category_id"]
        price = to_float(body.get("price"), "price") if "price" in body else existing["price"]
        tax_rate = to_float(body.get("tax_rate"), "tax_rate") if "tax_rate" in body else existing["tax_rate"]
        stock_qty = to_optional_stock(body.get("stock_qty"), "stock_qty") if "stock_qty" in body else existing["stock_qty"]
    except ValueError as e:
        conn.close()
        return error(str(e))

    brand = body.get("brand", existing["brand"])
    bottle_size = body.get("bottle_size", existing["bottle_size"])
    status = body.get("status") or existing["status"]

    conn.execute(
        """UPDATE alcohol_items SET name = ?, category_id = ?, brand = ?, bottle_size = ?,
           price = ?, tax_rate = ?, stock_qty = ?, status = ?, updated_at = datetime('now','localtime')
           WHERE id = ?""",
        (name, category_id, brand, bottle_size, price, tax_rate, stock_qty, status, item_id),
    )
    if float(existing["price"]) != float(price):
        log_audit(conn, "menu.item.price_change", "alcohol_item", item_id, {
            "name": name, "price": {"from": float(existing["price"]), "to": price},
        })
    conn.commit()
    row = conn.execute("SELECT * FROM alcohol_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/alcohol/items/<int:item_id>", methods=["DELETE"])
@require_role(*MANAGE_ROLES)
def delete_alcohol_item(item_id):
    conn = get_db()
    existing = conn.execute("SELECT * FROM alcohol_items WHERE id = ?", (item_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Item not found", 404)
    conn.execute("UPDATE alcohol_items SET status = 'inactive' WHERE id = ?", (item_id,))
    log_audit(conn, "menu.item.delete", "alcohol_item", item_id, {"name": existing["name"]})
    conn.commit()
    conn.close()
    return ok({"message": "Item deleted"})


# =========================================================
# TABLES - Floor and open sessions
# =========================================================

@app.route("/api/tables", methods=["GET"])
@login_required
def list_tables():
    conn = get_db()
    rows = conn.execute(
        """SELECT rt.*, ts.id AS session_id, ts.customer_name, ts.customer_phone,
                  ts.opened_at,
                  COALESCE(SUM(ti.price * ti.qty), 0) AS subtotal,
                  COALESCE(SUM(ti.price * ti.qty * ti.tax_rate / 100), 0) AS tax,
                  COALESCE(SUM(ti.qty), 0) AS item_count
           FROM restaurant_tables rt
           LEFT JOIN table_sessions ts ON ts.table_id = rt.id AND ts.status = 'open'
           LEFT JOIN table_session_items ti ON ti.session_id = ts.id
           GROUP BY rt.id, ts.id
           ORDER BY rt.table_no"""
    ).fetchall()
    conn.close()
    result = []
    for row in rows:
        item = dict(row)
        item["subtotal"] = round(float(item.get("subtotal") or 0), 2)
        item["tax"] = round(float(item.get("tax") or 0), 2)
        item["grand_total"] = round(item["subtotal"] + item["tax"], 2)
        item["status"] = "open" if item.get("session_id") else "available"
        result.append(item)
    return ok(result)


@app.route("/api/tables", methods=["POST"])
@require_role(*MANAGE_ROLES)
def create_table():
    body = request.get_json(silent=True) or {}
    table_no = (body.get("table_no") or "").strip()
    if not table_no:
        return error("Table name or number is required")
    try:
        seats = to_positive_int(body.get("seats", 4), "seats")
    except ValueError as exc:
        return error(str(exc))
    conn = get_db()
    try:
        cur = conn.execute("INSERT INTO restaurant_tables (table_no, seats) VALUES (?, ?)", (table_no, seats))
        conn.commit()
        row = conn.execute("SELECT * FROM restaurant_tables WHERE id = ?", (cur.lastrowid,)).fetchone()
    except Exception:
        conn.rollback()
        conn.close()
        log.exception("Failed to add table %r", table_no)
        return error("Could not add this table. A table with that name may already exist.", 409)
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/tables/<int:table_id>", methods=["PUT"])
@require_role(*MANAGE_ROLES)
def update_table(table_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    existing = conn.execute("SELECT * FROM restaurant_tables WHERE id = ?", (table_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Table not found", 404)
    table_no = (body.get("table_no") or existing["table_no"]).strip()
    try:
        seats = to_positive_int(body.get("seats", existing["seats"]), "seats")
    except ValueError as exc:
        conn.close()
        return error(str(exc))
    conn.execute("UPDATE restaurant_tables SET table_no = ?, seats = ?, updated_at = datetime('now','localtime') WHERE id = ?", (table_no, seats, table_id))
    conn.commit()
    row = conn.execute("SELECT * FROM restaurant_tables WHERE id = ?", (table_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/tables/<int:table_id>/open", methods=["POST"])
@login_required
def open_table(table_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    table = conn.execute("SELECT * FROM restaurant_tables WHERE id = ?", (table_id,)).fetchone()
    if not table:
        conn.close()
        return error("Table not found", 404)
    current = conn.execute("SELECT * FROM table_sessions WHERE table_id = ? AND status = 'open'", (table_id,)).fetchone()
    if current:
        conn.close()
        return ok(dict(current))
    try:
        cur = conn.execute(
            """INSERT INTO table_sessions (table_id, customer_name, customer_phone, opened_by)
               VALUES (?, ?, ?, ?)""",
            ((table_id), (body.get("customer_name") or "Walk-in").strip() or "Walk-in", (body.get("customer_phone") or "-").strip() or "-", session.get("user_id")),
        )
        conn.execute("UPDATE restaurant_tables SET status = 'occupied', updated_at = datetime('now','localtime') WHERE id = ?", (table_id,))
        conn.commit()
    except Exception:
        # Lost the race against another terminal opening the same table: the
        # unique index on (table_id) WHERE status='open' rejected the second
        # INSERT. Returning the session that won is exactly what the caller
        # wanted - two open sessions for one table would split the guests'
        # order across two bills.
        conn.rollback()
        winner = conn.execute(
            "SELECT * FROM table_sessions WHERE table_id = ? AND status = 'open'", (table_id,)
        ).fetchone()
        conn.close()
        if winner:
            return ok(dict(winner))
        log.exception("Failed to open table %s", table_id)
        return error("Could not open this table. Please try again.", 500)
    opened = conn.execute("SELECT * FROM table_sessions WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return ok(dict(opened), 201)


@app.route("/api/table-sessions/<int:session_id>", methods=["GET"])
@login_required
def get_table_session(session_id):
    conn = get_db()
    session_row = conn.execute(
        """SELECT ts.*, rt.table_no, rt.seats FROM table_sessions ts
           JOIN restaurant_tables rt ON rt.id = ts.table_id WHERE ts.id = ?""",
        (session_id,),
    ).fetchone()
    if not session_row:
        conn.close()
        return error("Table session not found", 404)
    items = conn.execute("SELECT * FROM table_session_items WHERE session_id = ? ORDER BY id", (session_id,)).fetchall()
    conn.close()
    result = dict(session_row)
    result["items"] = [dict(row) for row in items]
    result["subtotal"] = round(sum(float(row["price"]) * int(row["qty"]) for row in items), 2)
    result["tax"] = round(sum(float(row["price"]) * int(row["qty"]) * float(row["tax_rate"] or 0) / 100 for row in items), 2)
    result["grand_total"] = round(result["subtotal"] + result["tax"], 2)
    return ok(result)


@app.route("/api/table-sessions/<int:session_id>", methods=["PUT"])
@login_required
def save_table_session(session_id):
    body = request.get_json(silent=True) or {}
    items = body.get("items")
    if not isinstance(items, list):
        return error("Session items must be a list")
    if len(items) > MAX_BILL_LINES:
        return error(f"A table session can hold at most {MAX_BILL_LINES} lines.")
    conn = get_db()
    current = conn.execute("SELECT * FROM table_sessions WHERE id = ? AND status = 'open'", (session_id,)).fetchone()
    if not current:
        conn.close()
        return error("Open table session not found", 404)
    clean_items = []
    for item in items:
        try:
            qty = to_positive_int(item.get("qty"), "qty")
            price = to_float(item.get("price"), "price")
            tax_rate = to_float(item.get("tax_rate", 5), "tax_rate")
        except ValueError as exc:
            conn.close()
            return error(str(exc))
        name = (item.get("name") or "").strip()
        if not name:
            conn.close()
            return error("Each table item must have a name")
        kind = "alcohol" if item.get("item_kind") == "alcohol" else "food"
        item_id = item.get("item_id")
        clean_items.append((kind, item_id if isinstance(item_id, int) else None, name, (item.get("brand") or "").strip(), (item.get("bottle_size") or "").strip(), price, qty, tax_rate, round(price * qty, 2)))
    conn.execute("DELETE FROM table_session_items WHERE session_id = ?", (session_id,))
    conn.executemany(
        """INSERT INTO table_session_items (session_id, item_kind, item_id, item_name, brand, bottle_size, price, qty, tax_rate, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [(session_id, *item) for item in clean_items],
    )
    customer_name = (body.get("customer_name") or current["customer_name"]).strip() or "Walk-in"
    customer_phone = (body.get("customer_phone") or current["customer_phone"]).strip() or "-"
    conn.execute("UPDATE table_sessions SET customer_name = ?, customer_phone = ? WHERE id = ?", (customer_name, customer_phone, session_id))
    conn.commit()
    conn.close()
    return get_table_session(session_id)


def _existing_settlement(conn, session_id):
    """Rebuild the settle response for a session that is already settled.

    Used to make a repeated settle request idempotent: the caller gets the same
    answer the first request produced, so a lost response or an impatient second
    click can never turn into a second charge.
    """
    row = conn.execute(
        """SELECT ts.*, rt.table_no FROM table_sessions ts
           JOIN restaurant_tables rt ON rt.id = ts.table_id
           WHERE ts.id = ? AND ts.status = 'settled'""",
        (session_id,),
    ).fetchone()
    if not row:
        return None
    bills = []
    subtotal = tax = discount = 0.0
    payment_method = "Cash"
    for kind, table in (("FOOD", "food_bills"), ("ALCOHOL", "alcohol_bills")):
        for bill in conn.execute(
            f"SELECT * FROM {table} WHERE table_session_id = ? ORDER BY id", (session_id,)
        ).fetchall():
            bills.append({"type": kind, "id": bill["id"]})
            subtotal = round(subtotal + float(bill["subtotal"] or 0), 2)
            tax = round(tax + float(bill["tax"] or 0), 2)
            discount = round(discount + float(bill["discount"] or 0), 2)
            payment_method = bill["payment_method"] or payment_method
    if not bills:
        return None
    return {
        "table_no": row["table_no"],
        "session_id": session_id,
        "bills": bills,
        "subtotal": subtotal,
        "tax": tax,
        "discount": discount,
        "grand_total": round(subtotal + tax - discount, 2),
        "payment_method": payment_method,
        "already_settled": True,
    }


@app.route("/api/table-sessions/<int:session_id>/settle", methods=["POST"])
@login_required
def settle_table_session(session_id):
    body = request.get_json(silent=True) or {}
    payment_method = (body.get("payment_method") or "Cash").strip()
    try:
        discount = to_float(body.get("discount", 0), "discount")
    except ValueError as exc:
        return error(str(exc))
    conn = get_db()
    current = conn.execute(
        """SELECT ts.*, rt.table_no FROM table_sessions ts JOIN restaurant_tables rt ON rt.id = ts.table_id
           WHERE ts.id = ? AND ts.status = 'open'""", (session_id,)
    ).fetchone()
    if not current:
        # Already settled? Then this is almost certainly the same settlement
        # arriving twice (double-click, or a retry after the first response was
        # lost). Hand back the bills that settlement already produced instead of
        # an error the cashier would "fix" by billing the table a second time.
        settled = _existing_settlement(conn, session_id)
        conn.close()
        if settled:
            return ok(settled, 200)
        return error("Open table session not found", 404)
    items = conn.execute("SELECT * FROM table_session_items WHERE session_id = ? ORDER BY id", (session_id,)).fetchall()
    if not items:
        conn.close()
        return error("Add at least one item before settling the table")
    subtotal = round(sum(float(row["line_total"]) for row in items), 2)
    tax = round(sum(float(row["line_total"]) * float(row["tax_rate"] or 0) / 100 for row in items), 2)
    if discount > subtotal:
        conn.close()
        return error("Discount cannot exceed subtotal")
    food_items = [row for row in items if row["item_kind"] == "food"]
    alcohol_items = [row for row in items if row["item_kind"] == "alcohol"]
    created_bills = []
    # Split the discount across the food/alcohol bills pro rata. Rounding each
    # share independently can lose or gain a paisa, so the last bill absorbs
    # whatever is left over and the two bills always sum back to `discount`.
    groups = [(kind, group) for kind, group in (("food", food_items), ("alcohol", alcohol_items)) if group]
    discount_left = discount
    settled_subtotal = 0.0
    settled_tax = 0.0
    try:
        # Claim the session BEFORE writing any bill. This UPDATE is the lock:
        # a second settlement of the same table - the classic double-click, or
        # two terminals settling at once - either blocks here and then matches
        # zero rows, or is rejected outright by the unique index on
        # (table_session_id). Either way the restaurant never bills a table
        # twice. Reading `status = 'open'` and trusting it, as this did before,
        # let both requests through and produced two real bills with two real
        # bill numbers and two stock decrements.
        claimed = conn.execute(
            """UPDATE table_sessions
               SET status = 'settled', settled_at = datetime('now','localtime')
               WHERE id = ? AND status = 'open'""",
            (session_id,),
        )
        if claimed.rowcount != 1:
            conn.rollback()
            already = _existing_settlement(conn, session_id)
            conn.close()
            if already:
                return ok(already, 200)
            return error("This table has already been settled.", 409)

        for index, (kind, group) in enumerate(groups):
            group_subtotal = round(sum(float(row["line_total"]) for row in group), 2)
            group_tax = round(sum(float(row["line_total"]) * float(row["tax_rate"] or 0) / 100 for row in group), 2)
            is_last = index == len(groups) - 1
            if is_last:
                group_discount = round(discount_left, 2)
            else:
                group_discount = round(discount * group_subtotal / subtotal, 2) if subtotal else 0
            discount_left = round(discount_left - group_discount, 2)
            group_total = round(group_subtotal + group_tax - group_discount, 2)
            settled_subtotal = round(settled_subtotal + group_subtotal, 2)
            settled_tax = round(settled_tax + group_tax, 2)
            prefix, counter, table = (("FOOD", "food_bill", "food_bills") if kind == "food" else ("ALC", "alcohol_bill", "alcohol_bills"))
            bill_no = next_bill_number(conn, counter, prefix)
            cur = conn.execute(
                f"""INSERT INTO {table} (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax, grand_total, payment_method, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bill_no, current["table_id"], session_id, current["customer_name"], current["customer_phone"], group_subtotal, group_discount, group_tax, group_total, payment_method, session.get("user_id")),
            )
            bill_id = cur.lastrowid
            if kind == "food":
                for row in group:
                    conn.execute("INSERT INTO food_bill_items (bill_id, item_name, price, qty, line_total) VALUES (?, ?, ?, ?, ?)", (bill_id, row["item_name"], row["price"], row["qty"], row["line_total"]))
                    apply_stock_delta(conn, "food", row["item_id"], -row["qty"])
            else:
                for row in group:
                    conn.execute("INSERT INTO alcohol_bill_items (bill_id, item_name, brand, bottle_size, price, qty, tax_rate, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (bill_id, row["item_name"], row["brand"], row["bottle_size"], row["price"], row["qty"], row["tax_rate"], row["line_total"]))
                    apply_stock_delta(conn, "alcohol", row["item_id"], -row["qty"])
            created_bills.append((kind, bill_id))
        conn.execute("UPDATE restaurant_tables SET status = 'available', updated_at = datetime('now','localtime') WHERE id = ?", (current["table_id"],))
        log_audit(conn, "table.settle", "table_session", session_id, {
            "table_no": current["table_no"], "grand_total": round(settled_subtotal + settled_tax - discount, 2), "discount": discount,
        })
        conn.commit()
    except Exception:
        conn.rollback()
        conn.close()
        log.exception("Failed to settle table session %s", session_id)
        return error(
            "Could not settle this table. Nothing was charged - please try again.",
            500,
        )
    conn.close()
    return ok({"table_no": current["table_no"], "session_id": session_id, "bills": [{"type": kind.upper(), "id": bill_id} for kind, bill_id in created_bills], "subtotal": settled_subtotal, "tax": settled_tax, "discount": discount, "grand_total": round(settled_subtotal + settled_tax - discount, 2), "payment_method": payment_method}, 201)


# =========================================================
# FOOD - Bills
# =========================================================

@app.route("/api/food/bills", methods=["POST"])
@login_required
def create_food_bill():
    body = request.get_json(silent=True) or {}
    items = body.get("items")
    if not isinstance(items, list) or len(items) == 0:
        return error("Bill must contain at least one item")
    if len(items) > MAX_BILL_LINES:
        return error(f"A bill can hold at most {MAX_BILL_LINES} lines.")

    try:
        discount = to_float(body.get("discount", 0), "discount")
        tax_percent = to_float(body.get("tax_percent", 0), "tax_percent")
    except ValueError as e:
        return error(str(e))

    subtotal = 0.0
    clean_items = []
    for it in items:
        try:
            qty = to_positive_int(it.get("qty"), "qty")
            price = to_float(it.get("price"), "price")
        except ValueError as e:
            return error(str(e))
        name = (it.get("name") or "").strip()
        if not name:
            return error("Each item must have a name")
        line_total = round(price * qty, 2)
        subtotal += line_total
        item_id = it.get("item_id")
        clean_items.append((name, price, qty, line_total, item_id if isinstance(item_id, int) else None))

    subtotal = round(subtotal, 2)
    if discount > subtotal:
        return error("Discount cannot exceed subtotal")
    tax = round(subtotal * tax_percent / 100, 2)
    grand_total = round(subtotal - discount + tax, 2)
    if grand_total < 0:
        return error("Grand total cannot be negative")

    payment_method = body.get("payment_method") or "Cash"
    customer_name = (body.get("customer_name") or "-").strip() or "-"
    customer_phone = (body.get("customer_phone") or "-").strip() or "-"
    table_id = body.get("table_id")
    table_session_id = body.get("table_session_id")

    client_ref = request_client_ref()
    conn = get_db()

    # Same key seen before => same sale. Return the bill that was already
    # created rather than creating a second one.
    existing = _bill_by_client_ref(conn, "food_bills", "food_bill_items", "FOOD", client_ref)
    if existing:
        conn.close()
        return ok(existing, 200)

    try:
        bill_no = next_bill_number(conn, "food_bill", "FOOD")
        cur = conn.execute(
            """INSERT INTO food_bills
               (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax, grand_total,
                payment_method, created_by, client_ref)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax, grand_total,
             payment_method, session.get("user_id"), client_ref),
        )
        bill_id = cur.lastrowid
        for name, price, qty, line_total, item_id in clean_items:
            conn.execute(
                """INSERT INTO food_bill_items (bill_id, item_name, price, qty, line_total)
                   VALUES (?, ?, ?, ?, ?)""",
                (bill_id, name, price, qty, line_total),
            )
            apply_stock_delta(conn, "food", item_id, -qty)
        log_audit(conn, "bill.create", "food_bill", bill_id, {"bill_no": bill_no, "grand_total": grand_total})
        conn.commit()
    except Exception:
        conn.rollback()
        # Two retries that raced each other: the loser lost its INSERT to the
        # unique index on client_ref, which is exactly the outcome we want.
        duplicate = _bill_by_client_ref(conn, "food_bills", "food_bill_items", "FOOD", client_ref)
        if duplicate:
            conn.close()
            return ok(duplicate, 200)
        conn.close()
        log.exception("Failed to save food bill")
        return error("Could not save this bill. Nothing was charged - please try again.", 500)

    result = _bill_payload(conn, "food_bills", "food_bill_items", bill_id, "FOOD")
    conn.close()
    return ok(result, 201)


@app.route("/api/food/bills", methods=["GET"])
@login_required
def list_food_bills():
    try:
        limit = min(max(int(request.args.get("limit", 200)), 1), 500)
    except (TypeError, ValueError):
        limit = 200
    conn = get_db()
    rows = conn.execute("SELECT * FROM food_bills ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return ok([dict(r) for r in rows])


@app.route("/api/food/bills/<int:bill_id>", methods=["GET"])
@login_required
def get_food_bill(bill_id):
    conn = get_db()
    bill = conn.execute("SELECT * FROM food_bills WHERE id = ?", (bill_id,)).fetchone()
    if not bill:
        conn.close()
        return error("Bill not found", 404)
    items = conn.execute(
        "SELECT * FROM food_bill_items WHERE bill_id = ?", (bill_id,)
    ).fetchall()
    conn.close()
    result = dict(bill)
    result["items"] = [dict(r) for r in items]
    result["type"] = "FOOD"
    return ok(result)


# =========================================================
# ALCOHOL - Bills
# =========================================================

@app.route("/api/alcohol/bills", methods=["POST"])
@login_required
def create_alcohol_bill():
    body = request.get_json(silent=True) or {}
    items = body.get("items")
    if not isinstance(items, list) or len(items) == 0:
        return error("Bill must contain at least one item")
    if len(items) > MAX_BILL_LINES:
        return error(f"A bill can hold at most {MAX_BILL_LINES} lines.")

    try:
        discount = to_float(body.get("discount", 0), "discount")
    except ValueError as e:
        return error(str(e))

    subtotal = 0.0
    tax_total = 0.0
    clean_items = []
    for it in items:
        try:
            qty = to_positive_int(it.get("qty"), "qty")
            price = to_float(it.get("price"), "price")
            tax_rate = to_float(it.get("tax_rate", 0), "tax_rate")
        except ValueError as e:
            return error(str(e))
        name = (it.get("name") or "").strip()
        if not name:
            return error("Each item must have a name")
        line_total = round(price * qty, 2)
        line_tax = round(line_total * tax_rate / 100, 2)
        subtotal += line_total
        tax_total += line_tax
        item_id = it.get("item_id")
        clean_items.append((
            name, (it.get("brand") or "").strip(), (it.get("bottle_size") or "").strip(),
            price, qty, tax_rate, line_total, item_id if isinstance(item_id, int) else None
        ))

    subtotal = round(subtotal, 2)
    tax_total = round(tax_total, 2)
    if discount > subtotal:
        return error("Discount cannot exceed subtotal")
    grand_total = round(subtotal + tax_total - discount, 2)
    if grand_total < 0:
        return error("Grand total cannot be negative")

    payment_method = body.get("payment_method") or "Cash"
    customer_name = (body.get("customer_name") or "-").strip() or "-"
    customer_phone = (body.get("customer_phone") or "-").strip() or "-"
    table_id = body.get("table_id")
    table_session_id = body.get("table_session_id")

    client_ref = request_client_ref()
    conn = get_db()

    existing = _bill_by_client_ref(conn, "alcohol_bills", "alcohol_bill_items", "ALCOHOL", client_ref)
    if existing:
        conn.close()
        return ok(existing, 200)

    try:
        bill_no = next_bill_number(conn, "alcohol_bill", "ALC")
        cur = conn.execute(
            """INSERT INTO alcohol_bills
               (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax, grand_total,
                payment_method, created_by, client_ref)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax_total, grand_total,
             payment_method, session.get("user_id"), client_ref),
        )
        bill_id = cur.lastrowid
        for name, brand, bottle_size, price, qty, tax_rate, line_total, item_id in clean_items:
            conn.execute(
                """INSERT INTO alcohol_bill_items
                   (bill_id, item_name, brand, bottle_size, price, qty, tax_rate, line_total)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (bill_id, name, brand, bottle_size, price, qty, tax_rate, line_total),
            )
            apply_stock_delta(conn, "alcohol", item_id, -qty)
        log_audit(conn, "bill.create", "alcohol_bill", bill_id, {"bill_no": bill_no, "grand_total": grand_total})
        conn.commit()
    except Exception:
        conn.rollback()
        duplicate = _bill_by_client_ref(conn, "alcohol_bills", "alcohol_bill_items", "ALCOHOL", client_ref)
        if duplicate:
            conn.close()
            return ok(duplicate, 200)
        conn.close()
        log.exception("Failed to save alcohol bill")
        return error("Could not save this bill. Nothing was charged - please try again.", 500)

    result = _bill_payload(conn, "alcohol_bills", "alcohol_bill_items", bill_id, "ALCOHOL")
    conn.close()
    return ok(result, 201)


@app.route("/api/alcohol/bills", methods=["GET"])
@login_required
def list_alcohol_bills():
    try:
        limit = min(max(int(request.args.get("limit", 200)), 1), 500)
    except (TypeError, ValueError):
        limit = 200
    conn = get_db()
    rows = conn.execute("SELECT * FROM alcohol_bills ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return ok([dict(r) for r in rows])


@app.route("/api/alcohol/bills/<int:bill_id>", methods=["GET"])
@login_required
def get_alcohol_bill(bill_id):
    conn = get_db()
    bill = conn.execute("SELECT * FROM alcohol_bills WHERE id = ?", (bill_id,)).fetchone()
    if not bill:
        conn.close()
        return error("Bill not found", 404)
    items = conn.execute(
        "SELECT * FROM alcohol_bill_items WHERE bill_id = ?", (bill_id,)
    ).fetchall()
    conn.close()
    result = dict(bill)
    result["items"] = [dict(r) for r in items]
    result["type"] = "ALCOHOL"
    return ok(result)


# =========================================================
# ORDERS (combined food + alcohol)
# =========================================================

ORDERS_BILL_COLUMNS = (
    "id, bill_no, customer_name, customer_phone, subtotal, discount, tax, "
    "grand_total, payment_method, status, created_at"
)


@app.route("/api/orders", methods=["GET"])
@login_required
def list_orders():
    # Loading every bill ever created (no filter, no limit) was fine with a
    # handful of test rows and guaranteed to get slower every single day the
    # restaurant stays open. Filtering and pagination now happen in SQL, so
    # the page stays fast whether the history is a week old or five years old.
    type_filter = (request.args.get("type") or "all").strip().upper()
    if type_filter not in ("ALL", "FOOD", "ALCOHOL"):
        return error("type must be FOOD, ALCOHOL or all")
    date_filter = (request.args.get("date") or "").strip()
    if date_filter and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_filter):
        return error("date must be YYYY-MM-DD")
    search = (request.args.get("search") or "").strip()
    try:
        limit = min(max(int(request.args.get("limit", 25)), 1), 200)
    except (TypeError, ValueError):
        limit = 25
    try:
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        offset = 0

    parts = []
    if type_filter in ("ALL", "FOOD"):
        parts.append(f"SELECT {ORDERS_BILL_COLUMNS}, 'FOOD' AS type FROM food_bills")
    if type_filter in ("ALL", "ALCOHOL"):
        parts.append(f"SELECT {ORDERS_BILL_COLUMNS}, 'ALCOHOL' AS type FROM alcohol_bills")
    union_sql = " UNION ALL ".join(parts)

    clauses = []
    params = []
    if date_filter:
        clauses.append("date(created_at) = ?")
        params.append(date_filter)
    if search:
        clauses.append("(LOWER(bill_no) LIKE ? OR LOWER(customer_name) LIKE ?)")
        needle = f"%{search.lower()}%"
        params.extend([needle, needle])
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    conn = get_db()
    total = conn.execute(
        f"SELECT COUNT(*) AS c FROM ({union_sql}) combined {where}", tuple(params)
    ).fetchone()["c"]
    rows = conn.execute(
        f"""SELECT * FROM ({union_sql}) combined {where}
            ORDER BY created_at DESC LIMIT ? OFFSET ?""",
        tuple(params) + (limit, offset),
    ).fetchall()
    conn.close()

    return ok({"orders": [dict(r) for r in rows], "total": total, "limit": limit, "offset": offset})


# =========================================================
# DASHBOARD
# =========================================================

@app.route("/api/dashboard", methods=["GET"])
@login_required
def dashboard():
    conn = get_db()

    food_today = conn.execute(
        """SELECT COUNT(*) AS cnt, COALESCE(SUM(grand_total), 0) AS total
           FROM food_bills WHERE date(created_at) = date('now', 'localtime')"""
    ).fetchone()
    alcohol_today = conn.execute(
        """SELECT COUNT(*) AS cnt, COALESCE(SUM(grand_total), 0) AS total
           FROM alcohol_bills WHERE date(created_at) = date('now', 'localtime')"""
    ).fetchone()

    trend_rows = conn.execute(
        """SELECT day, ROUND(SUM(total), 2) AS total, SUM(orders) AS orders
           FROM (
             SELECT date(created_at) AS day, grand_total AS total, 1 AS orders FROM food_bills
             UNION ALL
             SELECT date(created_at) AS day, grand_total AS total, 1 AS orders FROM alcohol_bills
           )
           WHERE day >= date('now', 'localtime', '-6 day')
           GROUP BY day ORDER BY day"""
    ).fetchall()

    # These three widgets used to scan every bill ever created, with no date
    # bound - fine on day one, a real slowdown on every dashboard load (i.e.
    # every login) after a year of service. Bounding them to a rolling
    # 30-day window keeps the query fast forever *and* is more useful data -
    # "top sellers this month" beats "top sellers since 2024" for a manager
    # deciding what to restock today.
    payment_rows = conn.execute(
        """SELECT payment_method AS method, ROUND(SUM(total), 2) AS total, SUM(orders) AS orders
           FROM (
             SELECT payment_method, grand_total AS total, 1 AS orders FROM food_bills
               WHERE date(created_at) >= date('now', 'localtime', '-29 day')
             UNION ALL
             SELECT payment_method, grand_total AS total, 1 AS orders FROM alcohol_bills
               WHERE date(created_at) >= date('now', 'localtime', '-29 day')
           )
           GROUP BY payment_method ORDER BY total DESC"""
    ).fetchall()

    top_rows = conn.execute(
        """SELECT item_name AS name, SUM(qty) AS qty, ROUND(SUM(line_total), 2) AS total
           FROM (
             SELECT fbi.item_name, fbi.qty, fbi.line_total
               FROM food_bill_items fbi JOIN food_bills fb ON fb.id = fbi.bill_id
               WHERE date(fb.created_at) >= date('now', 'localtime', '-29 day')
             UNION ALL
             SELECT abi.item_name, abi.qty, abi.line_total
               FROM alcohol_bill_items abi JOIN alcohol_bills ab ON ab.id = abi.bill_id
               WHERE date(ab.created_at) >= date('now', 'localtime', '-29 day')
           )
           GROUP BY item_name ORDER BY qty DESC, total DESC LIMIT 6"""
    ).fetchall()

    hour_rows = conn.execute(
        """SELECT hour, SUM(orders) AS orders, ROUND(SUM(total), 2) AS total
           FROM (
             SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, 1 AS orders, grand_total AS total FROM food_bills
               WHERE date(created_at) >= date('now', 'localtime', '-29 day')
             UNION ALL
             SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, 1 AS orders, grand_total AS total FROM alcohol_bills
               WHERE date(created_at) >= date('now', 'localtime', '-29 day')
           )
           GROUP BY hour ORDER BY hour"""
    ).fetchall()

    recent_rows = conn.execute(
        """SELECT id, bill_no, customer_name, grand_total, payment_method, created_at, 'FOOD' AS type
           FROM food_bills
           UNION ALL
           SELECT id, bill_no, customer_name, grand_total, payment_method, created_at, 'ALCOHOL' AS type
           FROM alcohol_bills
           ORDER BY created_at DESC LIMIT 6"""
    ).fetchall()
    menu_summary = {
        "food_items": conn.execute("SELECT COUNT(*) FROM food_items WHERE status = 'active'").fetchone()[0],
        "alcohol_items": conn.execute("SELECT COUNT(*) FROM alcohol_items WHERE status = 'active'").fetchone()[0],
        "food_categories": conn.execute("SELECT COUNT(*) FROM food_categories WHERE status = 'active'").fetchone()[0],
        "alcohol_categories": conn.execute("SELECT COUNT(*) FROM alcohol_categories WHERE status = 'active'").fetchone()[0],
    }

    conn.close()

    def day_label(value):
        try:
            return datetime.strptime(value, "%Y-%m-%d").strftime("%a").upper()
        except (TypeError, ValueError):
            return value

    food_sales = round(food_today["total"], 2)
    alcohol_sales = round(alcohol_today["total"], 2)
    total_sales = round(food_sales + alcohol_sales, 2)

    return ok({
        "food_sales_today": food_sales,
        "alcohol_sales_today": alcohol_sales,
        "total_sales_today": total_sales,
        "food_bills_today": food_today["cnt"],
        "alcohol_bills_today": alcohol_today["cnt"],
        "total_bills_today": food_today["cnt"] + alcohol_today["cnt"],
        "trend": [{"day": r["day"], "label": day_label(r["day"]), "total": r["total"], "orders": r["orders"]} for r in trend_rows],
        "payment_mix": [dict(r) for r in payment_rows],
        "top_items": [dict(r) for r in top_rows],
        "hourly_flow": [dict(r) for r in hour_rows],
        "recent_orders": [dict(r) for r in recent_rows],
        "menu_summary": menu_summary,
    })


# =========================================================
# AUDIT LOG (admin only)
# =========================================================

@app.route("/api/audit-log", methods=["GET"])
@require_role("admin")
def list_audit_log():
    try:
        limit = min(max(int(request.args.get("limit", 100)), 1), 500)
    except (TypeError, ValueError):
        limit = 100
    try:
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        offset = 0

    clauses = []
    params = []
    action = (request.args.get("action") or "").strip()
    entity_type = (request.args.get("entity_type") or "").strip()
    if action:
        clauses.append("action LIKE ?")
        params.append(f"{action}%")
    if entity_type:
        clauses.append("entity_type = ?")
        params.append(entity_type)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    conn = get_db()
    total = conn.execute(f"SELECT COUNT(*) AS c FROM audit_log {where}", tuple(params)).fetchone()["c"]
    rows = conn.execute(
        f"SELECT * FROM audit_log {where} ORDER BY id DESC LIMIT ? OFFSET ?",
        tuple(params) + (limit, offset),
    ).fetchall()
    conn.close()

    entries = []
    for r in rows:
        d = dict(r)
        if d.get("details"):
            try:
                d["details"] = json.loads(d["details"])
            except (TypeError, ValueError):
                pass
        entries.append(d)
    return ok({"entries": entries, "total": total, "limit": limit, "offset": offset})


# =========================================================
# REPORTS - CSV export (admin/manager)
# =========================================================

EXPORT_MAX_ROWS = int(os.environ.get("EXPORT_MAX_ROWS", "50000"))

# An upper bound on how many lines one bill or table session may carry. Far
# above anything a real table orders, but it stops a buggy or hostile client
# from making the server build an arbitrarily large transaction.
MAX_BILL_LINES = 300


def _csv_cell(value):
    """Neutralise spreadsheet formula injection.

    Customer name and phone go into these exports straight from whatever was
    typed at the till. Excel and Sheets treat a leading =, +, - or @ as a
    formula, so a "customer" called `=HYPERLINK(...)` turns the owner's sales
    report into a live attack the moment they open it. Prefixing with a single
    quote keeps the text visible and inert.
    """
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _csv_response(filename, header, rows):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows([tuple(_csv_cell(c) for c in row) for row in rows])
    resp = Response(buf.getvalue(), mimetype="text/csv")
    resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


@app.route("/api/reports/export", methods=["GET"])
@require_role(*MANAGE_ROLES)
def export_report():
    report_type = (request.args.get("type") or "all").strip().lower()
    date_from = (request.args.get("from") or "").strip()
    date_to = (request.args.get("to") or "").strip()
    if report_type not in ("food", "alcohol", "all"):
        return error("type must be food, alcohol or all")
    if date_from and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_from):
        return error("from must be YYYY-MM-DD")
    if date_to and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_to):
        return error("to must be YYYY-MM-DD")

    clauses = []
    params = []
    if date_from:
        clauses.append("date(created_at) >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("date(created_at) <= ?")
        params.append(date_to)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    conn = get_db()
    rows = []
    # The whole report is built in memory. Unbounded, that is a worker-sized
    # allocation that grows with every year the restaurant stays open - one
    # click on "export all" eventually takes the server down. Cap it and tell
    # the user to narrow the range instead.
    limit = EXPORT_MAX_ROWS + 1
    if report_type in ("food", "all"):
        for r in conn.execute(
            f"SELECT * FROM food_bills {where} ORDER BY id LIMIT ?", tuple(params) + (limit,)
        ).fetchall():
            rows.append(("FOOD", r))
    if report_type in ("alcohol", "all"):
        for r in conn.execute(
            f"SELECT * FROM alcohol_bills {where} ORDER BY id LIMIT ?", tuple(params) + (limit,)
        ).fetchall():
            rows.append(("ALCOHOL", r))
    conn.close()
    if len(rows) > EXPORT_MAX_ROWS:
        return error(
            f"That range covers more than {EXPORT_MAX_ROWS} bills. "
            "Please export a shorter date range.",
            413,
        )
    rows.sort(key=lambda pair: pair[1]["created_at"])

    header = ["Type", "Bill No", "Date", "Customer", "Phone", "Subtotal", "Discount", "Tax", "Grand Total", "Payment Method", "Status"]
    csv_rows = [
        (
            kind, r["bill_no"], r["created_at"], r["customer_name"], r["customer_phone"],
            r["subtotal"], r["discount"], r["tax"], r["grand_total"], r["payment_method"], r["status"],
        )
        for kind, r in rows
    ]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_conn = get_db()
    log_audit(log_conn, "report.export", "bills", None, {"type": report_type, "from": date_from, "to": date_to, "rows": len(csv_rows)})
    log_conn.commit()
    log_conn.close()
    return _csv_response(f"sales-report-{report_type}-{stamp}.csv", header, csv_rows)


# =========================================================
# WEBSITE INTEGRATION (read-only, API-key auth)
# =========================================================
#
# The restaurant's public website calls this server-to-server (its own
# backend, not the customer's browser) to display the live food menu. Keyed
# by a static X-API-Key, not the session/cookie auth everything else uses -
# see require_api_key above. No ordering yet; that's a separate, deferred
# design (dine-in pre-order / reservations).

def _iso_utc(value):
    """Render a DB timestamp as ISO 8601 UTC ("...Z"). On Postgres the query
    below converts with `AT TIME ZONE 'UTC'` before this ever sees the value,
    so the naive string here already *is* UTC wall-clock time. On SQLite
    (dev-only fallback) timestamps are naive OS-local time with no offset
    recorded, so this is a best-effort label, not a real conversion."""
    if not value:
        return None
    try:
        dt = datetime.strptime(str(value)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


@app.route("/api/website/menu", methods=["GET"])
@require_api_key
def website_menu():
    updated_at_utc = "updated_at AT TIME ZONE 'UTC'" if USE_POSTGRES else "updated_at"
    conn = get_db()
    cat_rows = conn.execute(
        f"""SELECT id, name, sort_order, {updated_at_utc} AS updated_at
            FROM food_categories WHERE status = 'active'
            ORDER BY sort_order, name"""
    ).fetchall()
    item_rows = conn.execute(
        f"""SELECT id, category_id, name, description, price, stock_qty, {updated_at_utc} AS updated_at
            FROM food_items WHERE status = 'active'
            ORDER BY category_id, name"""
    ).fetchall()
    conn.close()

    items_by_cat = {}
    for r in item_rows:
        items_by_cat.setdefault(r["category_id"], []).append(r)

    latest = None
    categories = []
    for c in cat_rows:
        latest = max(filter(None, [latest, c["updated_at"]]), default=None)
        cat_items = []
        for it in items_by_cat.get(c["id"], []):
            latest = max(filter(None, [latest, it["updated_at"]]), default=None)
            # Every row here already satisfies status='active' via the WHERE
            # clause above; the only remaining condition is stock.
            available = it["stock_qty"] is None or it["stock_qty"] > 0
            cat_items.append({
                "id": it["id"],
                "name": it["name"],
                "description": it["description"] or None,
                "price": float(it["price"]),
                "available": available,
            })
        categories.append({
            "id": c["id"],
            "name": c["name"],
            "sortOrder": c["sort_order"],
            "items": cat_items,
        })

    return jsonify({
        "currency": "INR",
        "updatedAt": _iso_utc(latest) or datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "categories": categories,
    })


# =========================================================
# QR-BASED TABLE ORDERING
# =========================================================
#
# A customer scans a table's QR (which encodes only /menu/<token>), browses the
# existing ERP menu, and places one or more orders during the visit. Orders land
# in qr_orders / qr_order_items with a status workflow. Staff watch the Live
# Orders board and, when ready, "push" an order's items into that table's
# session so the existing settle/billing flow produces the final bill. No menu
# data is duplicated and no second pricing system is introduced - prices and tax
# are always re-read from food_items / alcohol_items on the server.

QR_STATUSES = ["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED", "CANCELLED"]
RESTAURANT_NAME = os.environ.get("RESTAURANT_NAME", "Next Level Family Restaurant")
MAX_QR_LINE_QTY = 50
# POST /api/qr/orders is the only unauthenticated write in the whole system:
# anyone who can read a table's QR code can call it, from anywhere. These two
# limits keep a bored guest (or a script) from filling the orders board and the
# database with junk faster than staff can cancel it.
MAX_QR_LINES = 40
QR_ORDER_RATE_LIMIT = int(os.environ.get("QR_ORDER_RATE_LIMIT", "12"))
QR_ORDER_RATE_WINDOW = int(os.environ.get("QR_ORDER_RATE_WINDOW", "60"))
_QR_ORDER_HITS = {}


def _qr_rate_limited(token):
    """Per-table sliding window. In-process, like the login throttle - it raises
    the bar without pretending to be a real distributed rate limiter."""
    now = time.time()
    cutoff = now - QR_ORDER_RATE_WINDOW
    hits = [t for t in _QR_ORDER_HITS.get(token, ()) if t > cutoff]
    if len(_QR_ORDER_HITS) > 512:
        for key in [k for k, v in _QR_ORDER_HITS.items() if not v or max(v) < cutoff]:
            _QR_ORDER_HITS.pop(key, None)
    if len(hits) >= QR_ORDER_RATE_LIMIT:
        _QR_ORDER_HITS[token] = hits
        return True
    hits.append(now)
    _QR_ORDER_HITS[token] = hits
    return False


def _menu_url_for(token):
    """Absolute customer menu URL for a table token. Uses PUBLIC_BASE_URL when set
    (e.g. the LAN address of the dev machine, or the public domain in production)
    so the printed QR points somewhere a phone can actually reach; otherwise falls
    back to the host the staff request came in on."""
    base = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        base = request.url_root.rstrip("/")
    return base + "/menu/" + token


def _qr_table_by_token(conn, token):
    return conn.execute(
        "SELECT * FROM restaurant_tables WHERE qr_token = ?", (token,)
    ).fetchone()


def _qr_order_payload(conn, order_row):
    items = conn.execute(
        "SELECT * FROM qr_order_items WHERE qr_order_id = ? ORDER BY id", (order_row["id"],)
    ).fetchall()
    data = dict(order_row)
    data["items"] = [dict(r) for r in items]
    return data


@app.route("/menu/<token>")
def qr_menu_page(token):
    # The page itself is static; it reads the token from the URL and calls the
    # public API below. Serve it for any token so a wrong code still shows a
    # friendly "table not found" message rather than a raw 404.
    return send_from_directory(os.path.join(FRONTEND_DIR, "pages"), "qr-menu.html")


@app.route("/api/qr/menu/<token>", methods=["GET"])
def qr_public_menu(token):
    conn = get_db()
    table = _qr_table_by_token(conn, token)
    if not table:
        conn.close()
        return error("This table code is not valid. Please ask our staff.", 404)

    food_rows = conn.execute(
        """SELECT fi.id, fi.name, fi.price, fi.status, fi.stock_qty, fc.name AS category_name,
                  fc.sort_order AS category_sort
           FROM food_items fi JOIN food_categories fc ON fc.id = fi.category_id
           WHERE fc.status = 'active'
           ORDER BY fc.sort_order, fi.name"""
    ).fetchall()
    alcohol_rows = conn.execute(
        """SELECT ai.id, ai.name, ai.price, ai.status, ai.stock_qty, ai.brand, ai.bottle_size,
                  ai.tax_rate, ac.name AS category_name, ac.sort_order AS category_sort
           FROM alcohol_items ai JOIN alcohol_categories ac ON ac.id = ai.category_id
           WHERE ac.status = 'active'
           ORDER BY ac.sort_order, ai.name"""
    ).fetchall()
    conn.close()

    def in_stock(row):
        return row["stock_qty"] is None or row["stock_qty"] > 0

    groups = []
    index = {}

    def bucket(name, sort_key):
        if name not in index:
            index[name] = {"category": name, "sort": sort_key, "items": []}
            groups.append(index[name])
        return index[name]

    for r in food_rows:
        bucket(r["category_name"], (0, r["category_sort"]))["items"].append({
            "id": r["id"], "kind": "food", "name": r["name"],
            "price": round(float(r["price"]), 2), "tax_rate": 0,
            "brand": None, "bottle_size": None,
            "available": r["status"] == "active" and in_stock(r),
        })
    for r in alcohol_rows:
        bucket(r["category_name"], (1, r["category_sort"]))["items"].append({
            "id": r["id"], "kind": "alcohol", "name": r["name"],
            "price": round(float(r["price"]), 2), "tax_rate": float(r["tax_rate"] or 0),
            "brand": r["brand"], "bottle_size": r["bottle_size"],
            "available": r["status"] == "active" and in_stock(r),
        })

    groups.sort(key=lambda g: g["sort"])
    for g in groups:
        g.pop("sort", None)

    return ok({
        "restaurant": RESTAURANT_NAME,
        "table": {"id": table["id"], "label": table["table_no"], "token": token},
        "categories": groups,
    })


@app.route("/api/qr/orders", methods=["POST"])
def qr_place_order():
    body = request.get_json(silent=True) or {}
    token = (body.get("token") or "").strip()
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return error("Your cart is empty.")
    if len(raw_items) > MAX_QR_LINES:
        return error(f"An order can have at most {MAX_QR_LINES} different items.")
    if _qr_rate_limited(token):
        return error("Too many orders from this table just now. Please wait a moment.", 429)

    conn = get_db()
    table = _qr_table_by_token(conn, token)
    if not table:
        conn.close()
        return error("This table code is not valid. Please ask our staff.", 404)

    # Re-price every line from the live menu tables. Anything the browser sent
    # for price / total / name is ignored.
    clean = []
    subtotal = 0.0
    tax_total = 0.0
    for raw in raw_items:
        kind = "alcohol" if raw.get("kind") == "alcohol" else "food"
        try:
            item_id = int(raw.get("id"))
            qty = int(raw.get("qty"))
        except (TypeError, ValueError):
            conn.close()
            return error("That order contains an invalid item.")
        if qty <= 0 or qty > MAX_QR_LINE_QTY:
            conn.close()
            return error(f"Quantity must be between 1 and {MAX_QR_LINE_QTY}.")

        if kind == "food":
            row = conn.execute(
                "SELECT id, name, price, stock_qty FROM food_items WHERE id = ? AND status = 'active'",
                (item_id,),
            ).fetchone()
            brand = bottle = None
            tax_rate = 0.0
        else:
            row = conn.execute(
                "SELECT id, name, price, brand, bottle_size, tax_rate, stock_qty FROM alcohol_items WHERE id = ? AND status = 'active'",
                (item_id,),
            ).fetchone()
            brand = row["brand"] if row else None
            bottle = row["bottle_size"] if row else None
            tax_rate = float(row["tax_rate"] or 0) if row else 0.0
        if not row:
            conn.close()
            return error("One of the items is no longer available. Please refresh the menu.")
        if row["stock_qty"] is not None and row["stock_qty"] <= 0:
            conn.close()
            return error(f"{row['name']} just sold out. Please remove it and try again.")

        price = round(float(row["price"]), 2)
        line_total = round(price * qty, 2)
        subtotal += line_total
        tax_total += round(line_total * tax_rate / 100, 2)
        clean.append((kind, row["id"], row["name"], brand, bottle, price, qty, tax_rate, line_total))

    subtotal = round(subtotal, 2)
    tax_total = round(tax_total, 2)
    grand_total = round(subtotal + tax_total, 2)

    customer_name = (body.get("customer_name") or "Guest").strip()[:60] or "Guest"
    note = (body.get("note") or "").strip()[:280] or None
    public_ref = uuid.uuid4().hex

    try:
        order_no = next_bill_number(conn, "qr_order", "QR")
        cur = conn.execute(
            """INSERT INTO qr_orders
               (order_no, public_ref, table_id, customer_name, note, status,
                subtotal, tax, grand_total)
               VALUES (?, ?, ?, ?, ?, 'NEW', ?, ?, ?)""",
            (order_no, public_ref, table["id"], customer_name, note,
             subtotal, tax_total, grand_total),
        )
        order_id = cur.lastrowid
        for kind, iid, name, brand, bottle, price, qty, tax_rate, line_total in clean:
            conn.execute(
                """INSERT INTO qr_order_items
                   (qr_order_id, item_kind, item_id, item_name, brand, bottle_size,
                    price, qty, tax_rate, line_total)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (order_id, kind, iid, name, brand, bottle, price, qty, tax_rate, line_total),
            )
        conn.commit()
    except Exception:  # noqa: BLE001
        conn.rollback()
        conn.close()
        log.exception("Failed to place QR order for table %s", table["id"])
        return error("Could not place the order. Please try again.", 500)

    row = conn.execute("SELECT * FROM qr_orders WHERE id = ?", (order_id,)).fetchone()
    payload = _qr_order_payload(conn, row)
    payload["table_label"] = table["table_no"]
    conn.close()
    return ok(payload, 201)


@app.route("/api/qr/orders/<public_ref>", methods=["GET"])
def qr_order_status(public_ref):
    conn = get_db()
    row = conn.execute(
        """SELECT qo.*, rt.table_no FROM qr_orders qo
           JOIN restaurant_tables rt ON rt.id = qo.table_id
           WHERE qo.public_ref = ?""",
        (public_ref,),
    ).fetchone()
    if not row:
        conn.close()
        return error("Order not found", 404)
    payload = _qr_order_payload(conn, row)
    payload["table_label"] = row["table_no"]
    payload["status_flow"] = QR_STATUSES
    conn.close()
    return ok(payload)


@app.route("/api/qr/tables/<token>/orders", methods=["GET"])
def qr_table_orders(token):
    conn = get_db()
    table = _qr_table_by_token(conn, token)
    if not table:
        conn.close()
        return error("This table code is not valid.", 404)
    rows = conn.execute(
        """SELECT * FROM qr_orders
           WHERE table_id = ? AND date(created_at) = date('now', 'localtime')
           ORDER BY id DESC""",
        (table["id"],),
    ).fetchall()
    orders = [_qr_order_payload(conn, r) for r in rows]
    conn.close()
    return ok({"table_label": table["table_no"], "orders": orders})


# ---- Staff-facing QR ordering management -------------------------------------

@app.route("/api/qr-ordering/tables", methods=["GET"])
@login_required
def qr_admin_tables():
    conn = get_db()
    rows = conn.execute(
        """SELECT rt.id, rt.table_no, rt.seats, rt.status, rt.qr_token,
                  (SELECT COUNT(*) FROM qr_orders qo
                     WHERE qo.table_id = rt.id
                       AND qo.status NOT IN ('SERVED', 'CANCELLED')) AS open_orders,
                  (SELECT COUNT(*) FROM qr_orders qo
                     WHERE qo.table_id = rt.id AND qo.status = 'NEW') AS new_orders
           FROM restaurant_tables rt
           ORDER BY rt.table_no"""
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["menu_url"] = _menu_url_for(r["qr_token"]) if r["qr_token"] else None
        d["qr_svg_url"] = f"/api/qr-ordering/tables/{r['id']}/qr.svg"
        result.append(d)
    return ok(result)


def _render_qr_svg(data):
    import qrcode
    import qrcode.image.svg

    img = qrcode.make(
        data,
        image_factory=qrcode.image.svg.SvgPathImage,
        box_size=11,
        border=2,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
    )
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue()


@app.route("/api/qr-ordering/tables/<int:table_id>/qr.svg", methods=["GET"])
@login_required
def qr_admin_table_svg(table_id):
    conn = get_db()
    table = conn.execute(
        "SELECT * FROM restaurant_tables WHERE id = ?", (table_id,)
    ).fetchone()
    conn.close()
    if not table:
        return error("Table not found", 404)
    if not table["qr_token"]:
        return error("This table has no QR token yet", 409)
    svg = _render_qr_svg(_menu_url_for(table["qr_token"]))
    resp = Response(svg, mimetype="image/svg+xml")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/qr-ordering/tables/<int:table_id>/regenerate-qr", methods=["POST"])
@require_role(*MANAGE_ROLES)
def qr_admin_regenerate(table_id):
    conn = get_db()
    table = conn.execute(
        "SELECT * FROM restaurant_tables WHERE id = ?", (table_id,)
    ).fetchone()
    if not table:
        conn.close()
        return error("Table not found", 404)
    new_token = secrets.token_urlsafe(12)
    conn.execute(
        "UPDATE restaurant_tables SET qr_token = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        (new_token, table_id),
    )
    log_audit(conn, "qr.regenerate", "restaurant_table", table_id, {"table_no": table["table_no"]})
    conn.commit()
    conn.close()
    return ok({"id": table_id, "qr_token": new_token, "menu_url": _menu_url_for(new_token)})


@app.route("/api/qr-ordering/orders", methods=["GET"])
@login_required
def qr_admin_orders():
    status = (request.args.get("status") or "").strip().upper()
    table_id = request.args.get("table_id")
    date_filter = request.args.get("date")
    scope = (request.args.get("scope") or "").strip().lower()

    clauses = []
    params = []
    if status in QR_STATUSES:
        clauses.append("qo.status = ?")
        params.append(status)
    if scope == "active":
        clauses.append("qo.status NOT IN ('SERVED', 'CANCELLED')")
    if table_id:
        clauses.append("qo.table_id = ?")
        params.append(table_id)
    if date_filter:
        clauses.append("date(qo.created_at) = ?")
        params.append(date_filter)
    elif scope != "all":
        clauses.append("date(qo.created_at) = date('now', 'localtime')")

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    conn = get_db()
    rows = conn.execute(
        f"""SELECT qo.*, rt.table_no FROM qr_orders qo
            JOIN restaurant_tables rt ON rt.id = qo.table_id
            {where}
            ORDER BY qo.id DESC""",
        tuple(params),
    ).fetchall()
    orders = []
    for r in rows:
        d = _qr_order_payload(conn, r)
        d["table_label"] = r["table_no"]
        orders.append(d)
    conn.close()
    return ok({"orders": orders, "status_flow": QR_STATUSES})


@app.route("/api/qr-ordering/pulse", methods=["GET"])
@login_required
def qr_admin_pulse():
    """Lightweight poll for the global new-order alerts and the sidebar badge.
    Returns the current NEW / active counts and any orders newer than `after`."""
    try:
        after = int(request.args.get("after") or 0)
    except (TypeError, ValueError):
        after = 0

    conn = get_db()
    latest = conn.execute("SELECT COALESCE(MAX(id), 0) AS m FROM qr_orders").fetchone()["m"]
    new_count = conn.execute(
        "SELECT COUNT(*) AS c FROM qr_orders WHERE status = 'NEW'"
    ).fetchone()["c"]
    active_count = conn.execute(
        "SELECT COUNT(*) AS c FROM qr_orders WHERE status NOT IN ('SERVED', 'CANCELLED')"
    ).fetchone()["c"]

    arrived = []
    if after:
        rows = conn.execute(
            """SELECT qo.id, qo.order_no, qo.grand_total, rt.table_no,
                      (SELECT COALESCE(SUM(qty), 0) FROM qr_order_items qi WHERE qi.qr_order_id = qo.id) AS item_count
               FROM qr_orders qo JOIN restaurant_tables rt ON rt.id = qo.table_id
               WHERE qo.id > ? ORDER BY qo.id""",
            (after,),
        ).fetchall()
        arrived = [
            {
                "id": r["id"],
                "order_no": r["order_no"],
                "table_label": r["table_no"],
                "grand_total": round(float(r["grand_total"] or 0), 2),
                "item_count": int(r["item_count"] or 0),
            }
            for r in rows
        ]
    conn.close()
    return ok({
        "latest_id": latest,
        "new_count": new_count,
        "active_count": active_count,
        "new": arrived,
    })


@app.route("/api/qr-ordering/orders/<int:order_id>/status", methods=["POST"])
@login_required
def qr_admin_set_status(order_id):
    body = request.get_json(silent=True) or {}
    new_status = (body.get("status") or "").strip().upper()
    if new_status not in QR_STATUSES:
        return error("Unknown status")
    conn = get_db()
    row = conn.execute("SELECT * FROM qr_orders WHERE id = ?", (order_id,)).fetchone()
    if not row:
        conn.close()
        return error("Order not found", 404)
    conn.execute(
        "UPDATE qr_orders SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        (new_status, order_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM qr_orders WHERE id = ?", (order_id,)).fetchone()
    payload = _qr_order_payload(conn, updated)
    conn.close()
    return ok(payload)


@app.route("/api/qr-ordering/orders/<int:order_id>/push-to-bill", methods=["POST"])
@login_required
def qr_admin_push_to_bill(order_id):
    conn = get_db()
    order = conn.execute(
        """SELECT qo.*, rt.table_no FROM qr_orders qo
           JOIN restaurant_tables rt ON rt.id = qo.table_id
           WHERE qo.id = ?""",
        (order_id,),
    ).fetchone()
    if not order:
        conn.close()
        return error("Order not found", 404)
    if order["status"] == "CANCELLED":
        conn.close()
        return error("This order is cancelled")
    if order["pushed_to_bill"]:
        conn.close()
        return error("This order is already on the table bill")

    items = conn.execute(
        "SELECT * FROM qr_order_items WHERE qr_order_id = ? ORDER BY id", (order_id,)
    ).fetchall()
    if not items:
        conn.close()
        return error("This order has no items")

    try:
        # Claim the order first: this UPDATE is what makes a double-click safe.
        # Checking `pushed_to_bill` in a separate SELECT (as this did before)
        # let two concurrent presses both pass the check and add every item to
        # the table's bill twice - the guest was charged twice for one order.
        claimed = conn.execute(
            """UPDATE qr_orders SET pushed_to_bill = 1, status = 'SERVED',
                   updated_at = datetime('now','localtime')
               WHERE id = ? AND pushed_to_bill = 0 AND status != 'CANCELLED'""",
            (order_id,),
        )
        if claimed.rowcount != 1:
            conn.rollback()
            conn.close()
            return error("This order is already on the table bill")

        table_session = conn.execute(
            "SELECT * FROM table_sessions WHERE table_id = ? AND status = 'open'",
            (order["table_id"],),
        ).fetchone()
        if not table_session:
            cur = conn.execute(
                """INSERT INTO table_sessions (table_id, customer_name, customer_phone, opened_by)
                   VALUES (?, ?, ?, ?)""",
                (order["table_id"], order["customer_name"] or "Walk-in", "-", session.get("user_id")),
            )
            session_id = cur.lastrowid
            conn.execute(
                "UPDATE restaurant_tables SET status = 'occupied', updated_at = datetime('now','localtime') WHERE id = ?",
                (order["table_id"],),
            )
        else:
            session_id = table_session["id"]

        for it in items:
            conn.execute(
                """INSERT INTO table_session_items
                   (session_id, item_kind, item_id, item_name, brand, bottle_size, price, qty, tax_rate, line_total)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (session_id, it["item_kind"], it["item_id"], it["item_name"], it["brand"], it["bottle_size"],
                 it["price"], it["qty"], it["tax_rate"], it["line_total"]),
            )

        conn.execute(
            "UPDATE qr_orders SET table_session_id = ? WHERE id = ?",
            (session_id, order_id),
        )
        log_audit(conn, "qr.push_to_bill", "qr_order", order_id, {
            "order_no": order["order_no"], "table_session_id": session_id,
        })
        conn.commit()
    except Exception:  # noqa: BLE001
        conn.rollback()
        conn.close()
        log.exception("Failed to push QR order %s to a bill", order_id)
        return error(
            "Could not add this order to the table bill. Nothing was changed - please try again.",
            500,
        )

    updated = conn.execute("SELECT * FROM qr_orders WHERE id = ?", (order_id,)).fetchone()
    payload = _qr_order_payload(conn, updated)
    payload["table_session_id"] = session_id
    conn.close()
    return ok(payload)


# =========================================================
# Error handlers
# =========================================================

@app.errorhandler(404)
def not_found(e):
    return error("Resource not found", 404)


@app.errorhandler(405)
def method_not_allowed(e):
    return error("Method not allowed", 405)


@app.errorhandler(500)
def server_error(e):
    return error("Internal server error", 500)


@app.errorhandler(Exception)
def unhandled_exception(exc):
    """Last line of defence: never let a bug reach the till as raw HTML.

    The frontend's apiFetch parses every response as JSON and shows "Server
    returned an invalid response" for anything else, which tells the cashier
    nothing and tells us nothing either. Everything unexpected is logged here
    with its traceback and request path, and answered with a plain, honest
    message in the shape the frontend already understands.
    """
    if isinstance(exc, HTTPException):
        # 404/405/413... keep their own handlers and status codes.
        return error(exc.description or exc.name, exc.code or 500)
    log.exception("Unhandled error on %s %s", request.method, request.path)
    return error(
        "Something went wrong on the server. The action may not have been saved - "
        "please check before retrying.",
        500,
    )


# =========================================================
# Startup
# =========================================================

if __name__ == "__main__":
    ensure_initialized()
    port = int(os.environ.get("PORT", 5000))
    # debug=True hands anyone who can reach the port an interactive Python
    # console on the first traceback. That is remote code execution, and it was
    # unconditional here. It is now opt-in for local development only, and can
    # never switch on in production regardless of what FLASK_DEBUG says.
    # (The host stays 0.0.0.0 on purpose: testing the QR flow needs a phone on
    # the same LAN to reach this machine.)
    debug = (not IS_PRODUCTION) and os.environ.get("FLASK_DEBUG", "") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
