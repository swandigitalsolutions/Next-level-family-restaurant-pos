"""
NEXT LEVEL FAMILY RESTAURANT - Database Layer

Runs on either SQLite (default, for local development) or PostgreSQL. If the
DATABASE_URL environment variable is set - e.g. a Supabase or Render Postgres
connection string - the app talks to that Postgres server instead of the
bundled SQLite file. The rest of the codebase keeps using the same
``conn.execute("... ?", params)`` / ``cursor.lastrowid`` style; a thin
compatibility layer below translates it to psycopg for Postgres.
"""

import os
import re
import secrets
import shutil
import sqlite3
import uuid
from datetime import date as _date, datetime
from decimal import Decimal

from werkzeug.security import generate_password_hash as _generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Werkzeug defaults to scrypt, which some minimal Python builds (e.g. macOS
# system Python) lack. PASSWORD_HASH_METHOD lets local dev fall back to
# pbkdf2; leave it unset in production to keep the default scrypt hashes.
_PASSWORD_HASH_METHOD = os.environ.get("PASSWORD_HASH_METHOD", "").strip()


def generate_password_hash(password):
    if _PASSWORD_HASH_METHOD:
        return _generate_password_hash(password, method=_PASSWORD_HASH_METHOD)
    return _generate_password_hash(password)

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_POSTGRES = bool(DATABASE_URL)

# The database bundled with the repo carries the schema, seed menu, and default
# admin account. In hosted environments (e.g. Render) the working filesystem is
# ephemeral, so DB_PATH can be pointed at a persistent disk via the DB_PATH env
# var; on first boot the bundled database is copied there so seed data survives.
# (DB_PATH is ignored entirely when DATABASE_URL selects Postgres.)
BUNDLED_DB_PATH = os.path.join(BASE_DIR, "nextlevel.db")
DB_PATH = os.environ.get("DB_PATH", BUNDLED_DB_PATH)

# Timezone used for now()/CURRENT_DATE so bill timestamps and the dashboard's
# "today" match the restaurant's local day regardless of server location.
LOCAL_TZ = os.environ.get("TZ", "Asia/Kolkata")
if not re.fullmatch(r"[A-Za-z0-9_+\-/]+", LOCAL_TZ or ""):
    LOCAL_TZ = "Asia/Kolkata"

if USE_POSTGRES:
    try:
        import psycopg
        from psycopg import errors as pg_errors
    except ImportError as exc:  # pragma: no cover - deployment misconfiguration
        raise RuntimeError(
            "DATABASE_URL is set but psycopg is not installed. "
            "Run: pip install 'psycopg[binary]'"
        ) from exc


# =========================================================
# Postgres compatibility layer
# =========================================================
#
# app.py was written against sqlite3: it calls conn.execute() directly (no
# explicit cursor), uses "?" placeholders, reads cursor.lastrowid after INSERT,
# indexes rows by both name (row["x"]) and position (row[0]), and calls a few
# SQLite-only SQL functions. The wrappers below reproduce that surface on top of
# psycopg so the route code does not have to change.

class _Row(dict):
    """dict that also supports positional access (row[0]) like sqlite3.Row."""

    __slots__ = ()

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return dict.__getitem__(self, key)


def _coerce(value):
    """Make Postgres values look like the SQLite ones app.py expects: timestamps
    and dates as strings, numeric/Decimal as float."""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, _date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, Decimal):
        return float(value)
    return value


def _row_factory(cursor):
    cols = [c.name for c in (cursor.description or [])]

    def make(values):
        return _Row(zip(cols, (_coerce(v) for v in values)))

    return make


# SQLite -> Postgres SQL rewrites. Applied to every statement that goes through
# the wrapper. Kept deliberately small - it only has to cover what this codebase
# actually uses.
_RE_DATETIME_NOW = re.compile(r"datetime\(\s*'now'\s*,\s*'localtime'\s*\)", re.I)
_RE_DATE_NOW_OFFSET = re.compile(
    r"date\(\s*'now'\s*,\s*'localtime'\s*,\s*'\s*-\s*(\d+)\s*day'\s*\)", re.I
)
_RE_DATE_NOW = re.compile(r"date\(\s*'now'\s*,\s*'localtime'\s*\)", re.I)
_RE_CAST_STRFTIME_H = re.compile(
    r"CAST\(\s*strftime\(\s*'%H'\s*,\s*([\w.]+)\s*\)\s*AS\s+INTEGER\s*\)", re.I
)
_RE_STRFTIME_H = re.compile(r"strftime\(\s*'%H'\s*,\s*([\w.]+)\s*\)", re.I)
_RE_DATE_COL = re.compile(r"\bdate\(\s*([A-Za-z_][\w.]*)\s*\)", re.I)
_RE_INSERT_TABLE = re.compile(r"insert\s+into\s+[\"']?(\w+)", re.I)

# Tables with no surrogate "id" column - INSERTs into these must not get a
# "RETURNING id" appended.
_NO_ID_TABLES = {"counters"}


def _translate(sql, has_params):
    sql = _RE_DATETIME_NOW.sub("now()", sql)
    sql = _RE_DATE_NOW_OFFSET.sub(r"(CURRENT_DATE - INTERVAL '\1 day')", sql)
    sql = _RE_DATE_NOW.sub("CURRENT_DATE", sql)
    sql = _RE_CAST_STRFTIME_H.sub(r"EXTRACT(HOUR FROM \1)::int", sql)
    sql = _RE_STRFTIME_H.sub(r"EXTRACT(HOUR FROM \1)::int", sql)
    sql = _RE_DATE_COL.sub(r"(\1)::date", sql)
    if has_params:
        # psycopg treats % as a placeholder marker when params are supplied.
        sql = sql.replace("%", "%%")
    sql = sql.replace("?", "%s")
    return sql


class _CursorWrapper:
    def __init__(self, cur, lastrowid=None):
        self._cur = cur
        self.lastrowid = lastrowid

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def __iter__(self):
        return iter(self._cur)

    @property
    def rowcount(self):
        return self._cur.rowcount


class _PgConnection:
    """sqlite3.Connection-shaped wrapper around a psycopg connection."""

    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=()):
        params = tuple(params) if params else None
        tsql = _translate(sql, params is not None)
        cur = self._raw.cursor()
        head = tsql.lstrip()
        match = _RE_INSERT_TABLE.match(head)
        if (
            match
            and match.group(1).lower() not in _NO_ID_TABLES
            and "returning" not in tsql.lower()
        ):
            cur.execute(tsql.rstrip().rstrip(";") + " RETURNING id", params)
            row = cur.fetchone()
            return _CursorWrapper(cur, row[0] if row is not None else None)
        cur.execute(tsql, params)
        return _CursorWrapper(cur)

    def executemany(self, sql, seq_of_params):
        cur = self._raw.cursor()
        cur.executemany(_translate(sql, True), [tuple(p) for p in seq_of_params])
        return _CursorWrapper(cur)

    def executescript(self, sql):
        # DDL only, no parameters - psycopg runs multiple ;-separated statements.
        self._raw.execute(sql)

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        try:
            self._raw.close()
        except Exception:
            pass


def _postgres_dsn():
    dsn = DATABASE_URL
    if "sslmode=" not in dsn and not re.search(r"@(localhost|127\.0\.0\.1)[:/]", dsn):
        dsn += ("&" if "?" in dsn else "?") + "sslmode=require"
    return dsn


def get_db():
    if USE_POSTGRES:
        # prepare_threshold=None disables prepared statements so the connection
        # works through PgBouncer / Supabase's transaction pooler.
        raw = psycopg.connect(
            _postgres_dsn(),
            autocommit=False,
            prepare_threshold=None,
            row_factory=_row_factory,
        )
        conn = _PgConnection(raw)
        raw.execute(f"SET TIME ZONE '{LOCAL_TZ}'")
        raw.commit()
        return conn

    # timeout lets a worker wait out a short write lock instead of failing
    # immediately when more than one gunicorn worker touches the file.
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    # WAL improves read/write concurrency for the multi-worker hosted setup. It
    # is only enabled for an external DB_PATH so a plain local checkout keeps the
    # bundled database in its default rollback-journal mode (no header churn).
    if DB_PATH != BUNDLED_DB_PATH:
        conn.execute("PRAGMA journal_mode = WAL")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'staff',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS food_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS food_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (category_id) REFERENCES food_categories(id)
);

CREATE TABLE IF NOT EXISTS alcohol_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS alcohol_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    brand TEXT,
    bottle_size TEXT,
    price REAL NOT NULL,
    tax_rate REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (category_id) REFERENCES alcohol_categories(id)
);

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_no TEXT UNIQUE NOT NULL,
    seats INTEGER NOT NULL DEFAULT 4,
    status TEXT NOT NULL DEFAULT 'available',
    qr_token TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS table_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER NOT NULL,
    customer_name TEXT NOT NULL DEFAULT 'Walk-in',
    customer_phone TEXT NOT NULL DEFAULT '-',
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    settled_at TEXT,
    opened_by INTEGER,
    FOREIGN KEY (table_id) REFERENCES restaurant_tables(id),
    FOREIGN KEY (opened_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS table_session_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    item_kind TEXT NOT NULL DEFAULT 'food',
    item_name TEXT NOT NULL,
    brand TEXT,
    bottle_size TEXT,
    price REAL NOT NULL,
    qty INTEGER NOT NULL,
    tax_rate REAL NOT NULL DEFAULT 5,
    line_total REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES table_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS food_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_no TEXT UNIQUE NOT NULL,
    table_id INTEGER,
    table_session_id INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    subtotal REAL NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'Cash',
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS food_bill_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    price REAL NOT NULL,
    qty INTEGER NOT NULL,
    line_total REAL NOT NULL,
    FOREIGN KEY (bill_id) REFERENCES food_bills(id)
);

CREATE TABLE IF NOT EXISTS alcohol_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_no TEXT UNIQUE NOT NULL,
    table_id INTEGER,
    table_session_id INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    subtotal REAL NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'Cash',
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS alcohol_bill_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    brand TEXT,
    bottle_size TEXT,
    price REAL NOT NULL,
    qty INTEGER NOT NULL,
    tax_rate REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL,
    FOREIGN KEY (bill_id) REFERENCES alcohol_bills(id)
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_type TEXT NOT NULL,
    bill_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

-- QR-based table ordering. Isolated from the billing tables above: a customer
-- scans a table's QR, places one or more qr_orders during the visit, and staff
-- move the accepted items into the table's session for the existing settle flow.
CREATE TABLE IF NOT EXISTS qr_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT UNIQUE NOT NULL,
    public_ref TEXT UNIQUE NOT NULL,
    table_id INTEGER NOT NULL,
    table_session_id INTEGER,
    customer_name TEXT NOT NULL DEFAULT 'Guest',
    note TEXT,
    status TEXT NOT NULL DEFAULT 'NEW',
    subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL DEFAULT 0,
    pushed_to_bill INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
);

CREATE TABLE IF NOT EXISTS qr_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_order_id INTEGER NOT NULL,
    item_kind TEXT NOT NULL DEFAULT 'food',
    item_id INTEGER,
    item_name TEXT NOT NULL,
    brand TEXT,
    bottle_size TEXT,
    price REAL NOT NULL,
    qty INTEGER NOT NULL,
    tax_rate REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL,
    FOREIGN KEY (qr_order_id) REFERENCES qr_orders(id) ON DELETE CASCADE
);
"""

# Postgres equivalent of SCHEMA. Same tables and columns; SERIAL ids, real
# TIMESTAMPTZ defaults, and NUMERIC money columns so ROUND(x, 2) works in the
# dashboard aggregate queries.
PG_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'staff',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS food_categories (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS food_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES food_categories(id),
    price NUMERIC(12, 2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alcohol_categories (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alcohol_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES alcohol_categories(id),
    brand TEXT,
    bottle_size TEXT,
    price NUMERIC(12, 2) NOT NULL,
    tax_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name TEXT,
    phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
    id SERIAL PRIMARY KEY,
    table_no TEXT UNIQUE NOT NULL,
    seats INTEGER NOT NULL DEFAULT 4,
    status TEXT NOT NULL DEFAULT 'available',
    qr_token TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS table_sessions (
    id SERIAL PRIMARY KEY,
    table_id INTEGER NOT NULL REFERENCES restaurant_tables(id),
    customer_name TEXT NOT NULL DEFAULT 'Walk-in',
    customer_phone TEXT NOT NULL DEFAULT '-',
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    opened_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS table_session_items (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    item_kind TEXT NOT NULL DEFAULT 'food',
    item_name TEXT NOT NULL,
    brand TEXT,
    bottle_size TEXT,
    price NUMERIC(12, 2) NOT NULL,
    qty INTEGER NOT NULL,
    tax_rate NUMERIC(6, 2) NOT NULL DEFAULT 5,
    line_total NUMERIC(12, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS food_bills (
    id SERIAL PRIMARY KEY,
    bill_no TEXT UNIQUE NOT NULL,
    table_id INTEGER,
    table_session_id INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    subtotal NUMERIC(12, 2) NOT NULL,
    discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
    grand_total NUMERIC(12, 2) NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'Cash',
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS food_bill_items (
    id SERIAL PRIMARY KEY,
    bill_id INTEGER NOT NULL REFERENCES food_bills(id),
    item_name TEXT NOT NULL,
    price NUMERIC(12, 2) NOT NULL,
    qty INTEGER NOT NULL,
    line_total NUMERIC(12, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS alcohol_bills (
    id SERIAL PRIMARY KEY,
    bill_no TEXT UNIQUE NOT NULL,
    table_id INTEGER,
    table_session_id INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    subtotal NUMERIC(12, 2) NOT NULL,
    discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
    grand_total NUMERIC(12, 2) NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'Cash',
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alcohol_bill_items (
    id SERIAL PRIMARY KEY,
    bill_id INTEGER NOT NULL REFERENCES alcohol_bills(id),
    item_name TEXT NOT NULL,
    brand TEXT,
    bottle_size TEXT,
    price NUMERIC(12, 2) NOT NULL,
    qty INTEGER NOT NULL,
    tax_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
    line_total NUMERIC(12, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    bill_type TEXT NOT NULL,
    bill_id INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    method TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS qr_orders (
    id SERIAL PRIMARY KEY,
    order_no TEXT UNIQUE NOT NULL,
    public_ref TEXT UNIQUE NOT NULL,
    table_id INTEGER NOT NULL REFERENCES restaurant_tables(id),
    table_session_id INTEGER,
    customer_name TEXT NOT NULL DEFAULT 'Guest',
    note TEXT,
    status TEXT NOT NULL DEFAULT 'NEW',
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
    grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
    pushed_to_bill INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qr_order_items (
    id SERIAL PRIMARY KEY,
    qr_order_id INTEGER NOT NULL REFERENCES qr_orders(id) ON DELETE CASCADE,
    item_kind TEXT NOT NULL DEFAULT 'food',
    item_id INTEGER,
    item_name TEXT NOT NULL,
    brand TEXT,
    bottle_size TEXT,
    price NUMERIC(12, 2) NOT NULL,
    qty INTEGER NOT NULL,
    tax_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
    line_total NUMERIC(12, 2) NOT NULL
);
"""

FOOD_SEED = {
    "Starters": [
        ("Veg Spring Roll", 150), ("Paneer Tikka", 220), ("Chicken 65", 240),
        ("Gobi Manchurian", 170), ("Chilli Paneer", 210), ("Fish Fingers", 260),
        ("Chicken Lollipop", 250), ("Corn Cheese Balls", 160), ("Prawn Koliwada", 320),
        ("Mutton Seekh Kebab", 300),
    ],
    "Soups": [
        ("Tomato Soup", 90), ("Sweet Corn Soup", 100), ("Hot & Sour Soup", 110),
        ("Manchow Soup", 110), ("Chicken Clear Soup", 130), ("Mutton Soup", 160),
    ],
    "Main Course - Veg": [
        ("Paneer Butter Masala", 240), ("Dal Makhani", 190), ("Veg Kolhapuri", 210),
        ("Malai Kofta", 230), ("Mixed Veg Curry", 180), ("Palak Paneer", 220),
        ("Kadai Paneer", 230), ("Chana Masala", 170), ("Veg Kadai", 200),
        ("Aloo Gobi", 160),
    ],
    "Main Course - Non Veg": [
        ("Butter Chicken", 280), ("Chicken Curry", 250), ("Mutton Rogan Josh", 340),
        ("Fish Curry", 300), ("Egg Curry", 180), ("Chicken Chettinad", 270),
        ("Prawn Masala", 340), ("Mutton Curry", 320), ("Chicken Kadai", 270),
        ("Goan Fish Curry", 310),
    ],
    "Rice & Biryani": [
        ("Veg Fried Rice", 160), ("Chicken Fried Rice", 190), ("Veg Biryani", 190),
        ("Chicken Biryani", 260), ("Mutton Biryani", 320), ("Egg Biryani", 200),
        ("Jeera Rice", 130), ("Curd Rice", 120), ("Prawn Biryani", 340),
    ],
    "Breads": [
        ("Butter Naan", 45), ("Garlic Naan", 55), ("Tandoori Roti", 25),
        ("Plain Roti", 20), ("Laccha Paratha", 50), ("Kulcha", 45),
        ("Cheese Naan", 70), ("Missi Roti", 40),
    ],
    "South Indian": [
        ("Masala Dosa", 100), ("Plain Dosa", 80), ("Idli (2pc)", 60),
        ("Vada (2pc)", 60), ("Uttapam", 110), ("Rava Dosa", 120),
        ("Pongal", 90), ("Medu Vada", 70),
    ],
    "Desserts": [
        ("Gulab Jamun (2pc)", 80), ("Rasmalai (2pc)", 100), ("Ice Cream Scoop", 70),
        ("Gajar Halwa", 110), ("Kheer", 90), ("Jalebi", 80),
        ("Kulfi", 90),
    ],
    "Beverages": [
        ("Masala Chai", 30), ("Filter Coffee", 40), ("Cold Coffee", 90),
        ("Fresh Lime Soda", 60), ("Buttermilk", 40), ("Sweet Lassi", 70),
        ("Mango Lassi", 90), ("Soft Drink", 50), ("Mineral Water", 20),
        ("Fresh Juice", 90),
    ],
}

ALCOHOL_SEED = {
    "Beer": [
        ("Kingfisher Premium", "Kingfisher", "650ml", 180, 18),
        ("Kingfisher Strong", "Kingfisher", "650ml", 200, 18),
        ("Budweiser", "Budweiser", "650ml", 220, 18),
        ("Tuborg", "Tuborg", "500ml", 170, 18),
        ("Corona", "Corona", "330ml", 250, 18),
    ],
    "Whisky": [
        ("Johnnie Walker Black Label", "Johnnie Walker", "750ml", 3200, 20),
        ("Blenders Pride", "Blenders Pride", "750ml", 1200, 20),
        ("Royal Challenge", "Royal Challenge", "750ml", 900, 20),
        ("Signature", "Signature", "750ml", 1000, 20),
        ("Jack Daniel's", "Jack Daniel's", "750ml", 3500, 20),
        ("Glenfiddich 12yr", "Glenfiddich", "750ml", 4800, 20),
    ],
    "Vodka": [
        ("Absolut", "Absolut", "750ml", 1600, 20),
        ("Smirnoff", "Smirnoff", "750ml", 900, 20),
        ("Grey Goose", "Grey Goose", "750ml", 4500, 20),
        ("Magic Moments", "Magic Moments", "750ml", 700, 20),
    ],
    "Rum": [
        ("Old Monk", "Old Monk", "750ml", 600, 18),
        ("Bacardi White", "Bacardi", "750ml", 900, 18),
        ("Captain Morgan", "Captain Morgan", "750ml", 1100, 18),
    ],
    "Wine": [
        ("Sula Red Wine", "Sula", "750ml", 900, 20),
        ("Sula White Wine", "Sula", "750ml", 900, 20),
        ("Jacob's Creek", "Jacob's Creek", "750ml", 1400, 20),
    ],
    "Brandy": [
        ("Mansion House", "Mansion House", "750ml", 700, 18),
        ("Honey Bee", "Honey Bee", "750ml", 550, 18),
    ],
    "Gin": [
        ("Bombay Sapphire", "Bombay Sapphire", "750ml", 2200, 20),
        ("Gordon's", "Gordon's", "750ml", 1300, 20),
    ],
    "Tequila": [
        ("Jose Cuervo", "Jose Cuervo", "750ml", 2400, 20),
    ],
    "Cocktails / Mixers": [
        ("Mojito", "House", "1 glass", 280, 10),
        ("Margarita", "House", "1 glass", 320, 10),
        ("Screwdriver", "House", "1 glass", 260, 10),
        ("Soda / Mixer", "House", "300ml", 60, 5),
    ],
}


def _ensure_db_present():
    """When DB_PATH points at an external location (a Render persistent disk,
    say), create its parent directory and seed it once from the bundled
    database so the default admin login and menu are available on first boot."""
    if DB_PATH == BUNDLED_DB_PATH or os.path.exists(DB_PATH):
        return
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.exists(BUNDLED_DB_PATH):
        shutil.copy2(BUNDLED_DB_PATH, DB_PATH)


QR_TABLE_COUNT = 15


def _qr_token():
    """URL-safe opaque token that identifies a table's QR, not its database id."""
    return secrets.token_urlsafe(12)


def _seed(conn):
    """Insert the starting dining floor, default admin, menu, and bill counters.
    Every step is guarded by a count/exists check, so this is safe to run on
    every boot and against either backend."""
    # Ensure the 15 QR-ordering tables exist as "Table 01".."Table 15". Existing
    # rows created by the earlier build as "T1".."T12" are renamed in place so
    # their id (and any bills/sessions that reference it) is preserved.
    for number in range(1, QR_TABLE_COUNT + 1):
        label = f"Table {number:02d}"
        seats = 4 if number <= 8 else 6
        legacy = conn.execute(
            "SELECT id FROM restaurant_tables WHERE table_no = ?", (f"T{number}",)
        ).fetchone()
        current = conn.execute(
            "SELECT id FROM restaurant_tables WHERE table_no = ?", (label,)
        ).fetchone()
        if current:
            continue
        if legacy:
            conn.execute(
                "UPDATE restaurant_tables SET table_no = ? WHERE id = ?",
                (label, legacy["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO restaurant_tables (table_no, seats) VALUES (?, ?)",
                (label, seats),
            )
    conn.commit()

    # Backfill a unique QR token for every table that does not have one yet.
    for row in conn.execute(
        "SELECT id FROM restaurant_tables WHERE qr_token IS NULL OR qr_token = ''"
    ).fetchall():
        conn.execute(
            "UPDATE restaurant_tables SET qr_token = ? WHERE id = ?",
            (_qr_token(), row["id"]),
        )
    conn.commit()

    # Seed default admin user
    existing_admin = conn.execute(
        "SELECT id FROM users WHERE username = ?", ("admin",)
    ).fetchone()
    if not existing_admin:
        conn.execute(
            "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)",
            ("admin", generate_password_hash("nextlevel@123"), "Administrator", "admin"),
        )
        conn.commit()

    # Seed a view-only owner account (dashboard/insights only).
    existing_owner = conn.execute(
        "SELECT id FROM users WHERE username = ?", ("owner",)
    ).fetchone()
    if not existing_owner:
        conn.execute(
            "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)",
            ("owner", generate_password_hash("owner@123"), "Owner", "owner"),
        )
        conn.commit()

    # Seed food categories/items only if empty
    food_cat_count = conn.execute("SELECT COUNT(*) AS c FROM food_categories").fetchone()["c"]
    if food_cat_count == 0:
        for order, (cat_name, items) in enumerate(FOOD_SEED.items()):
            cur = conn.execute(
                "INSERT INTO food_categories (name, sort_order) VALUES (?, ?)",
                (cat_name, order),
            )
            cat_id = cur.lastrowid
            for item_name, price in items:
                conn.execute(
                    "INSERT INTO food_items (name, category_id, price) VALUES (?, ?, ?)",
                    (item_name, cat_id, price),
                )
        conn.commit()

    # Seed alcohol categories/items only if empty
    alcohol_cat_count = conn.execute("SELECT COUNT(*) AS c FROM alcohol_categories").fetchone()["c"]
    if alcohol_cat_count == 0:
        for order, (cat_name, items) in enumerate(ALCOHOL_SEED.items()):
            cur = conn.execute(
                "INSERT INTO alcohol_categories (name, sort_order) VALUES (?, ?)",
                (cat_name, order),
            )
            cat_id = cur.lastrowid
            for item_name, brand, size, price, tax in items:
                conn.execute(
                    """INSERT INTO alcohol_items
                       (name, category_id, brand, bottle_size, price, tax_rate)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (item_name, cat_id, brand, size, price, tax),
                )
        conn.commit()

    # Seed bill / order number counters
    for counter_name in ("food_bill", "alcohol_bill", "qr_order"):
        existing = conn.execute(
            "SELECT name FROM counters WHERE name = ?", (counter_name,)
        ).fetchone()
        if not existing:
            conn.execute("INSERT INTO counters (name, value) VALUES (?, 0)", (counter_name,))
    conn.commit()


def _init_postgres():
    """Create the schema and seed data on the Postgres server. An advisory lock
    keeps concurrent gunicorn workers from racing on the first-ever boot."""
    conn = get_db()
    try:
        conn._raw.execute("SELECT pg_advisory_lock(872734)")
        conn._raw.commit()
        conn.executescript(PG_SCHEMA)
        conn.commit()
        # Additive migration for installs whose restaurant_tables predates QR ordering.
        conn._raw.execute(
            "ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS qr_token TEXT"
        )
        conn._raw.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_qr_token_key "
            "ON restaurant_tables (qr_token)"
        )
        conn._raw.commit()
        _seed(conn)
        conn._raw.execute("SELECT pg_advisory_unlock(872734)")
        conn._raw.commit()
    finally:
        conn.close()
    return False


def init_db():
    """Create tables (if missing), migrate existing installs, and seed initial data."""
    if USE_POSTGRES:
        return _init_postgres()

    _ensure_db_present()
    first_time = not os.path.exists(DB_PATH)
    conn = get_db()
    conn.executescript(SCHEMA)

    # Safe migrations for databases created by the earlier ERP version.
    for table, column, definition in (
        ("food_bills", "table_id", "INTEGER"),
        ("food_bills", "table_session_id", "INTEGER"),
        ("alcohol_bills", "table_id", "INTEGER"),
        ("alcohol_bills", "table_session_id", "INTEGER"),
        ("restaurant_tables", "qr_token", "TEXT"),
    ):
        existing_columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing_columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    _seed(conn)
    conn.close()
    return first_time


def next_bill_number(conn, counter_name, prefix):
    """Atomically increment and return the next bill number, e.g. FOOD-000001."""
    conn.execute(
        "UPDATE counters SET value = value + 1 WHERE name = ?", (counter_name,)
    )
    row = conn.execute(
        "SELECT value FROM counters WHERE name = ?", (counter_name,)
    ).fetchone()
    number = row["value"]
    return f"{prefix}-{number:06d}"
