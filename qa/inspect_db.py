import os
import sqlite3

path = os.path.join(os.path.dirname(__file__), "..", "backend", "nextlevel.db")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
for table in ("restaurant_tables", "table_sessions", "food_bills", "alcohol_bills", "counters"):
    rows = conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
    print(f"[{table}] {len(rows)}")
    for row in rows:
        print(dict(row))
conn.close()
