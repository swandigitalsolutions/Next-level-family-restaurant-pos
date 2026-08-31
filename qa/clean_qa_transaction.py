import os
import sqlite3

path = os.path.join(os.path.dirname(__file__), "..", "backend", "nextlevel.db")
conn = sqlite3.connect(path)
try:
    conn.execute("BEGIN")
    qa_food = [row[0] for row in conn.execute("SELECT id FROM food_bills WHERE customer_name = ?", ("QA Walkthrough",))]
    qa_alcohol = [row[0] for row in conn.execute("SELECT id FROM alcohol_bills WHERE customer_name = ?", ("QA Walkthrough",))]
    qa_sessions = [row[0] for row in conn.execute("SELECT id FROM table_sessions WHERE customer_name = ?", ("QA Walkthrough",))]

    for bill_id in qa_food:
        conn.execute("DELETE FROM food_bill_items WHERE bill_id = ?", (bill_id,))
    for bill_id in qa_alcohol:
        conn.execute("DELETE FROM alcohol_bill_items WHERE bill_id = ?", (bill_id,))
    for bill_id in qa_food:
        conn.execute("DELETE FROM payments WHERE bill_type = 'food' AND bill_id = ?", (bill_id,))
    for bill_id in qa_alcohol:
        conn.execute("DELETE FROM payments WHERE bill_type = 'alcohol' AND bill_id = ?", (bill_id,))
    for session_id in qa_sessions:
        conn.execute("DELETE FROM table_session_items WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM table_sessions WHERE id = ?", (session_id,))
    for bill_id in qa_food:
        conn.execute("DELETE FROM food_bills WHERE id = ?", (bill_id,))
    for bill_id in qa_alcohol:
        conn.execute("DELETE FROM alcohol_bills WHERE id = ?", (bill_id,))

    conn.execute("UPDATE restaurant_tables SET status = 'available' WHERE status != 'available' AND id NOT IN (SELECT table_id FROM table_sessions WHERE status = 'open')")
    for counter, table in (("food_bill", "food_bills"), ("alcohol_bill", "alcohol_bills")):
        max_number = conn.execute(f"SELECT COALESCE(MAX(CAST(substr(bill_no, 6) AS INTEGER)), 0) FROM {table}").fetchone()[0]
        conn.execute("UPDATE counters SET value = ? WHERE name = ?", (max_number, counter))
    conn.commit()
    print({"deleted_food_bills": qa_food, "deleted_alcohol_bills": qa_alcohol, "deleted_sessions": qa_sessions})
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
