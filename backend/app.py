"""
NEXT LEVEL FAMILY RESTAURANT - Backend API
Flask + session-based authentication, backed by SQLite locally or PostgreSQL
when DATABASE_URL is set (see database.py).
"""

import io
import os
import functools
import secrets
import uuid
from datetime import datetime

from flask import Flask, request, jsonify, session, send_from_directory, redirect, Response
from flask_cors import CORS
from werkzeug.security import check_password_hash

from database import get_db, init_db, next_bill_number

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "next-level-family-restaurant-dev-secret-change-me")
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_HTTPONLY"] = True

# When served behind Render's HTTPS proxy, mark the session cookie Secure and
# trust the X-Forwarded-* headers so redirects and URLs use https.
if os.environ.get("RENDER") or os.environ.get("PRODUCTION"):
    app.config["SESSION_COOKIE_SECURE"] = True
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# CORS stays enabled (with credentials) for cases where the frontend is opened
# from a different origin/port during development; Flask also serves the
# frontend directly below so the default same-origin setup works out of the box.
CORS(app, supports_credentials=True)

# Ensure the schema exists and seed data is present on every boot. This is
# idempotent and matters for WSGI servers (gunicorn) that never run __main__.
init_db()


# =========================================================
# Frontend static serving
# =========================================================

@app.route("/")
def index():
    return redirect("/pages/login.html")


@app.route("/healthz")
def healthz():
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


# The "owner" role is view-only: it can reach the dashboard/insights and its own
# session, nothing else. Every other /api route returns 403 for an owner.
OWNER_ALLOWED_API = {"/api/me", "/api/logout", "/api/login", "/api/dashboard", "/api/health"}


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


# =========================================================
# Auth routes
# =========================================================

@app.route("/api/login", methods=["POST"])
def login():
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""

    if not username or not password:
        return error("Username and password are required", 400)

    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return error("Invalid username or password", 401)

    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["role"] = user["role"]

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
    })


# =========================================================
# Health
# =========================================================

@app.route("/api/health", methods=["GET"])
def health():
    return ok({"status": "healthy", "time": datetime.now().isoformat()})


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
@login_required
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
@login_required
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
@login_required
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
@login_required
def add_food_item():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return error("Item name is required")
    try:
        category_id = to_positive_int(body.get("category_id"), "category_id")
        price = to_float(body.get("price"), "price")
    except ValueError as e:
        return error(str(e))

    conn = get_db()
    cat = conn.execute("SELECT id FROM food_categories WHERE id = ?", (category_id,)).fetchone()
    if not cat:
        conn.close()
        return error("Category not found", 404)

    cur = conn.execute(
        "INSERT INTO food_items (name, category_id, price) VALUES (?, ?, ?)",
        (name, category_id, price),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM food_items WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/food/items/<int:item_id>", methods=["PUT"])
@login_required
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
    except ValueError as e:
        conn.close()
        return error(str(e))

    status = body.get("status") or existing["status"]

    conn.execute(
        """UPDATE food_items SET name = ?, category_id = ?, price = ?, status = ?,
           updated_at = datetime('now','localtime') WHERE id = ?""",
        (name, category_id, price, status, item_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM food_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/food/items/<int:item_id>", methods=["DELETE"])
@login_required
def delete_food_item(item_id):
    conn = get_db()
    existing = conn.execute("SELECT * FROM food_items WHERE id = ?", (item_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Item not found", 404)
    conn.execute("UPDATE food_items SET status = 'inactive' WHERE id = ?", (item_id,))
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
@login_required
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
@login_required
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
@login_required
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
@login_required
def add_alcohol_item():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return error("Product name is required")
    try:
        category_id = to_positive_int(body.get("category_id"), "category_id")
        price = to_float(body.get("price"), "price")
        tax_rate = to_float(body.get("tax_rate", 0), "tax_rate")
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
        """INSERT INTO alcohol_items (name, category_id, brand, bottle_size, price, tax_rate)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (name, category_id, brand, bottle_size, price, tax_rate),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM alcohol_items WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/alcohol/items/<int:item_id>", methods=["PUT"])
@login_required
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
    except ValueError as e:
        conn.close()
        return error(str(e))

    brand = body.get("brand", existing["brand"])
    bottle_size = body.get("bottle_size", existing["bottle_size"])
    status = body.get("status") or existing["status"]

    conn.execute(
        """UPDATE alcohol_items SET name = ?, category_id = ?, brand = ?, bottle_size = ?,
           price = ?, tax_rate = ?, status = ?, updated_at = datetime('now','localtime')
           WHERE id = ?""",
        (name, category_id, brand, bottle_size, price, tax_rate, status, item_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM alcohol_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    return ok(dict(row))


@app.route("/api/alcohol/items/<int:item_id>", methods=["DELETE"])
@login_required
def delete_alcohol_item(item_id):
    conn = get_db()
    existing = conn.execute("SELECT * FROM alcohol_items WHERE id = ?", (item_id,)).fetchone()
    if not existing:
        conn.close()
        return error("Item not found", 404)
    conn.execute("UPDATE alcohol_items SET status = 'inactive' WHERE id = ?", (item_id,))
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
@login_required
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
    except Exception as exc:
        conn.rollback()
        conn.close()
        return error(f"Could not add table: {exc}", 409)
    conn.close()
    return ok(dict(row), 201)


@app.route("/api/tables/<int:table_id>", methods=["PUT"])
@login_required
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
    cur = conn.execute(
        """INSERT INTO table_sessions (table_id, customer_name, customer_phone, opened_by)
           VALUES (?, ?, ?, ?)""",
        ((table_id), (body.get("customer_name") or "Walk-in").strip() or "Walk-in", (body.get("customer_phone") or "-").strip() or "-", session.get("user_id")),
    )
    conn.execute("UPDATE restaurant_tables SET status = 'occupied', updated_at = datetime('now','localtime') WHERE id = ?", (table_id,))
    conn.commit()
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
        clean_items.append((kind, name, (item.get("brand") or "").strip(), (item.get("bottle_size") or "").strip(), price, qty, tax_rate, round(price * qty, 2)))
    conn.execute("DELETE FROM table_session_items WHERE session_id = ?", (session_id,))
    conn.executemany(
        """INSERT INTO table_session_items (session_id, item_kind, item_name, brand, bottle_size, price, qty, tax_rate, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [(session_id, *item) for item in clean_items],
    )
    customer_name = (body.get("customer_name") or current["customer_name"]).strip() or "Walk-in"
    customer_phone = (body.get("customer_phone") or current["customer_phone"]).strip() or "-"
    conn.execute("UPDATE table_sessions SET customer_name = ?, customer_phone = ? WHERE id = ?", (customer_name, customer_phone, session_id))
    conn.commit()
    conn.close()
    return get_table_session(session_id)


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
        conn.close()
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
            else:
                for row in group:
                    conn.execute("INSERT INTO alcohol_bill_items (bill_id, item_name, brand, bottle_size, price, qty, tax_rate, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (bill_id, row["item_name"], row["brand"], row["bottle_size"], row["price"], row["qty"], row["tax_rate"], row["line_total"]))
            created_bills.append((kind, bill_id))
        conn.execute("UPDATE table_sessions SET status = 'settled', settled_at = datetime('now','localtime') WHERE id = ?", (session_id,))
        conn.execute("UPDATE restaurant_tables SET status = 'available', updated_at = datetime('now','localtime') WHERE id = ?", (current["table_id"],))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        conn.close()
        return error(f"Failed to settle table: {exc}", 500)
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
        clean_items.append((name, price, qty, line_total))

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

    conn = get_db()
    try:
        bill_no = next_bill_number(conn, "food_bill", "FOOD")
        cur = conn.execute(
            """INSERT INTO food_bills
               (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax, grand_total,
                payment_method, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax, grand_total,
             payment_method, session.get("user_id")),
        )
        bill_id = cur.lastrowid
        for name, price, qty, line_total in clean_items:
            conn.execute(
                """INSERT INTO food_bill_items (bill_id, item_name, price, qty, line_total)
                   VALUES (?, ?, ?, ?, ?)""",
                (bill_id, name, price, qty, line_total),
            )
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        return error(f"Failed to save bill: {str(e)}", 500)

    bill = conn.execute("SELECT * FROM food_bills WHERE id = ?", (bill_id,)).fetchone()
    bill_items = conn.execute(
        "SELECT * FROM food_bill_items WHERE bill_id = ?", (bill_id,)
    ).fetchall()
    conn.close()

    result = dict(bill)
    result["items"] = [dict(r) for r in bill_items]
    result["type"] = "FOOD"
    return ok(result, 201)


@app.route("/api/food/bills", methods=["GET"])
@login_required
def list_food_bills():
    conn = get_db()
    rows = conn.execute("SELECT * FROM food_bills ORDER BY id DESC").fetchall()
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
        clean_items.append((
            name, (it.get("brand") or "").strip(), (it.get("bottle_size") or "").strip(),
            price, qty, tax_rate, line_total
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

    conn = get_db()
    try:
        bill_no = next_bill_number(conn, "alcohol_bill", "ALC")
        cur = conn.execute(
            """INSERT INTO alcohol_bills
               (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax, grand_total,
                payment_method, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (bill_no, table_id, table_session_id, customer_name, customer_phone, subtotal, discount, tax_total, grand_total,
             payment_method, session.get("user_id")),
        )
        bill_id = cur.lastrowid
        for name, brand, bottle_size, price, qty, tax_rate, line_total in clean_items:
            conn.execute(
                """INSERT INTO alcohol_bill_items
                   (bill_id, item_name, brand, bottle_size, price, qty, tax_rate, line_total)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (bill_id, name, brand, bottle_size, price, qty, tax_rate, line_total),
            )
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        return error(f"Failed to save bill: {str(e)}", 500)

    bill = conn.execute("SELECT * FROM alcohol_bills WHERE id = ?", (bill_id,)).fetchone()
    bill_items = conn.execute(
        "SELECT * FROM alcohol_bill_items WHERE bill_id = ?", (bill_id,)
    ).fetchall()
    conn.close()

    result = dict(bill)
    result["items"] = [dict(r) for r in bill_items]
    result["type"] = "ALCOHOL"
    return ok(result, 201)


@app.route("/api/alcohol/bills", methods=["GET"])
@login_required
def list_alcohol_bills():
    conn = get_db()
    rows = conn.execute("SELECT * FROM alcohol_bills ORDER BY id DESC").fetchall()
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

@app.route("/api/orders", methods=["GET"])
@login_required
def list_orders():
    conn = get_db()
    food = conn.execute("SELECT * FROM food_bills ORDER BY id DESC").fetchall()
    alcohol = conn.execute("SELECT * FROM alcohol_bills ORDER BY id DESC").fetchall()
    conn.close()

    combined = []
    for r in food:
        d = dict(r)
        d["type"] = "FOOD"
        combined.append(d)
    for r in alcohol:
        d = dict(r)
        d["type"] = "ALCOHOL"
        combined.append(d)

    combined.sort(key=lambda x: x["created_at"], reverse=True)
    return ok(combined)


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

    payment_rows = conn.execute(
        """SELECT payment_method AS method, ROUND(SUM(total), 2) AS total, SUM(orders) AS orders
           FROM (
             SELECT payment_method, grand_total AS total, 1 AS orders FROM food_bills
             UNION ALL
             SELECT payment_method, grand_total AS total, 1 AS orders FROM alcohol_bills
           )
           GROUP BY payment_method ORDER BY total DESC"""
    ).fetchall()

    top_rows = conn.execute(
        """SELECT item_name AS name, SUM(qty) AS qty, ROUND(SUM(line_total), 2) AS total
           FROM (
             SELECT item_name, qty, line_total FROM food_bill_items
             UNION ALL
             SELECT item_name, qty, line_total FROM alcohol_bill_items
           )
           GROUP BY item_name ORDER BY qty DESC, total DESC LIMIT 6"""
    ).fetchall()

    hour_rows = conn.execute(
        """SELECT hour, SUM(orders) AS orders, ROUND(SUM(total), 2) AS total
           FROM (
             SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, 1 AS orders, grand_total AS total FROM food_bills
             UNION ALL
             SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, 1 AS orders, grand_total AS total FROM alcohol_bills
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
        """SELECT fi.id, fi.name, fi.price, fi.status, fc.name AS category_name,
                  fc.sort_order AS category_sort
           FROM food_items fi JOIN food_categories fc ON fc.id = fi.category_id
           WHERE fc.status = 'active'
           ORDER BY fc.sort_order, fi.name"""
    ).fetchall()
    alcohol_rows = conn.execute(
        """SELECT ai.id, ai.name, ai.price, ai.status, ai.brand, ai.bottle_size,
                  ai.tax_rate, ac.name AS category_name, ac.sort_order AS category_sort
           FROM alcohol_items ai JOIN alcohol_categories ac ON ac.id = ai.category_id
           WHERE ac.status = 'active'
           ORDER BY ac.sort_order, ai.name"""
    ).fetchall()
    conn.close()

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
            "available": r["status"] == "active",
        })
    for r in alcohol_rows:
        bucket(r["category_name"], (1, r["category_sort"]))["items"].append({
            "id": r["id"], "kind": "alcohol", "name": r["name"],
            "price": round(float(r["price"]), 2), "tax_rate": float(r["tax_rate"] or 0),
            "brand": r["brand"], "bottle_size": r["bottle_size"],
            "available": r["status"] == "active",
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
                "SELECT id, name, price FROM food_items WHERE id = ? AND status = 'active'",
                (item_id,),
            ).fetchone()
            brand = bottle = None
            tax_rate = 0.0
        else:
            row = conn.execute(
                "SELECT id, name, price, brand, bottle_size, tax_rate FROM alcohol_items WHERE id = ? AND status = 'active'",
                (item_id,),
            ).fetchone()
            brand = row["brand"] if row else None
            bottle = row["bottle_size"] if row else None
            tax_rate = float(row["tax_rate"] or 0) if row else 0.0
        if not row:
            conn.close()
            return error("One of the items is no longer available. Please refresh the menu.")

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
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        conn.close()
        return error(f"Could not place the order: {exc}", 500)

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
@login_required
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
                   (session_id, item_kind, item_name, brand, bottle_size, price, qty, tax_rate, line_total)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (session_id, it["item_kind"], it["item_name"], it["brand"], it["bottle_size"],
                 it["price"], it["qty"], it["tax_rate"], it["line_total"]),
            )

        conn.execute(
            """UPDATE qr_orders
               SET pushed_to_bill = 1, table_session_id = ?, status = 'SERVED',
                   updated_at = datetime('now','localtime')
               WHERE id = ?""",
            (session_id, order_id),
        )
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        conn.close()
        return error(f"Could not add the order to the bill: {exc}", 500)

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


# =========================================================
# Startup
# =========================================================

if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
