import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / 'backend' / 'nextlevel.db'
conn = sqlite3.connect(DB)
conn.execute("DELETE FROM table_sessions WHERE customer_name = 'QA Guest'")
conn.execute("UPDATE restaurant_tables SET status = 'available' WHERE table_no = 'T1'")
conn.commit()
print('cleaned QA Guest sessions and reset T1 to available')
conn.close()
