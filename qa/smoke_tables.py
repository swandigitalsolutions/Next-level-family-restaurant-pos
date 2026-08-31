import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import database  # noqa: E402


def main():
    database.init_db()
    conn = sqlite3.connect(database.DB_PATH)
    conn.row_factory = sqlite3.Row
    tables = conn.execute("SELECT id, table_no, seats FROM restaurant_tables ORDER BY id").fetchall()
    required = {"restaurant_tables", "table_sessions", "table_session_items"}
    actual = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    missing = required - actual
    if missing:
        raise SystemExit(f"missing tables: {sorted(missing)}")
    if len(tables) < 12:
        raise SystemExit(f"expected at least 12 default tables, got {len(tables)}")
    table_id = tables[0]["id"]
    conn.execute("DELETE FROM table_sessions WHERE table_id = ? AND status = 'open'", (table_id,))
    conn.execute("UPDATE restaurant_tables SET status = 'available' WHERE id = ?", (table_id,))
    cur = conn.execute("INSERT INTO table_sessions (table_id, customer_name, customer_phone) VALUES (?, ?, ?)", (table_id, "QA Guest", "000"))
    session_id = cur.lastrowid
    conn.execute("INSERT INTO table_session_items (session_id, item_kind, item_name, price, qty, tax_rate, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)", (session_id, "food", "QA Chicken Biryani", 250, 2, 5, 500))
    conn.execute("INSERT INTO table_session_items (session_id, item_kind, item_name, price, qty, tax_rate, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)", (session_id, "alcohol", "QA Soda", 80, 1, 0, 80))
    total = conn.execute("SELECT ROUND(SUM(line_total), 2) AS total FROM table_session_items WHERE session_id = ?", (session_id,)).fetchone()["total"]
    if total != 580:
        raise SystemExit(f"unexpected session total: {total}")
    conn.execute("UPDATE table_sessions SET status = 'settled' WHERE id = ?", (session_id,))
    conn.execute("UPDATE restaurant_tables SET status = 'available' WHERE id = ?", (table_id,))
    conn.commit()
    conn.close()
    print(f"table schema ok; default_tables={len(tables)}; mixed_session_total={total:.2f}")


if __name__ == "__main__":
    main()
