"""
Builds firebase/scripts/fixtures/etl-source.sqlite — a small, schema-faithful
copy of the Flask database with representative TRANSACTIONAL rows (bills, an open
+ a settled table session, QR orders, audit rows), so the Phase 3 ETL and its
reconciliation exercise every mapping / reference-rewrite path.

Schema comes straight from backend/database.py (SCHEMA constant); the row values
mirror what backend/app.py writes. Deterministic — safe to regenerate and commit.

Run:  python firebase/scripts/fixtures/build-etl-source.py
"""
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, "backend"))
from database import SCHEMA  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "etl-source.sqlite")
if os.path.exists(OUT):
    os.remove(OUT)

db = sqlite3.connect(OUT)
db.executescript(SCHEMA)
c = db.cursor()

# --- users (known Werkzeug hashes so the ETL/login tests can verify) ---------
c.execute(
    "INSERT INTO users (id, username, password_hash, full_name, phone, role, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
    (1, "admin", generate_password_hash("nextlevel@123"), "Administrator", "", "admin", "active", "2026-08-22 18:19:07"),
)
c.execute(
    "INSERT INTO users (id, username, password_hash, full_name, phone, role, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
    (2, "cashier1", generate_password_hash("cashier@123"), "Cashier One", "9990001111", "staff", "active", "2026-08-25 09:00:00"),
)

# --- catalog -----------------------------------------------------------------
c.execute("INSERT INTO food_categories (id,name,sort_order,status) VALUES (1,'Starters',0,'active')")
c.execute("INSERT INTO food_categories (id,name,sort_order,status) VALUES (2,'Main Course',1,'active')")
c.execute("INSERT INTO alcohol_categories (id,name,sort_order,status) VALUES (1,'Beer',0,'active')")
c.execute("INSERT INTO alcohol_categories (id,name,sort_order,status) VALUES (2,'Whisky',1,'active')")

c.execute("INSERT INTO food_items (id,name,category_id,price,stock_qty,description,status) VALUES (1,'Paneer Tikka',1,220,10,'Char-grilled','active')")
c.execute("INSERT INTO food_items (id,name,category_id,price,stock_qty,description,status) VALUES (2,'Chicken 65',1,240,NULL,NULL,'active')")
c.execute("INSERT INTO food_items (id,name,category_id,price,stock_qty,description,status) VALUES (3,'Butter Chicken',2,280,4,NULL,'active')")
c.execute("INSERT INTO alcohol_items (id,name,category_id,brand,bottle_size,price,tax_rate,stock_qty,status) VALUES (1,'Kingfisher Premium',1,'Kingfisher','650ml',180,18,24,'active')")
c.execute("INSERT INTO alcohol_items (id,name,category_id,brand,bottle_size,price,tax_rate,stock_qty,status) VALUES (2,'Blenders Pride',2,'Blenders Pride','750ml',1200,20,NULL,'active')")

# --- tables ----------------------------------------------------------------
for tid, no, seats, status, tok in [
    (1, "Table 01", 4, "occupied", "tok_table01_abc"),
    (2, "Table 02", 4, "available", "tok_table02_def"),
    (3, "Table 03", 6, "available", "tok_table03_ghi"),
]:
    c.execute(
        "INSERT INTO restaurant_tables (id,table_no,seats,status,qr_token) VALUES (?,?,?,?,?)",
        (tid, no, seats, status, tok),
    )

# --- counter-sale bills (no table) ---------------------------------------
c.execute(
    """INSERT INTO food_bills (id,bill_no,table_id,table_session_id,customer_name,customer_phone,subtotal,discount,tax,grand_total,payment_method,status,created_by,created_at)
       VALUES (1,'FOOD-000001',NULL,NULL,'Ramesh Kumar','9812345678',680,0,34,714,'Cash','confirmed',2,'2026-09-01 13:15:00')"""
)
c.execute("INSERT INTO food_bill_items (bill_id,item_name,price,qty,line_total) VALUES (1,'Paneer Tikka',220,2,440)")
c.execute("INSERT INTO food_bill_items (bill_id,item_name,price,qty,line_total) VALUES (1,'Butter Chicken',280,1,280)")

c.execute(
    """INSERT INTO alcohol_bills (id,bill_no,table_id,table_session_id,customer_name,customer_phone,subtotal,discount,tax,grand_total,payment_method,status,created_by,created_at)
       VALUES (1,'ALC-000001',NULL,NULL,'Walk-in','-',360,0,64.8,424.8,'Card','confirmed',2,'2026-09-01 20:40:00')"""
)
c.execute("INSERT INTO alcohol_bill_items (bill_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (1,'Kingfisher Premium','Kingfisher','650ml',180,2,18,360)")

# --- OPEN table session on table 1 (food + alcohol lines) --------------
c.execute(
    """INSERT INTO table_sessions (id,table_id,customer_name,customer_phone,status,opened_at,settled_at,opened_by)
       VALUES (1,1,'Priya','9876500000','open','2026-09-02 12:05:00',NULL,2)"""
)
c.execute("INSERT INTO table_session_items (session_id,item_kind,item_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (1,'food',1,'Paneer Tikka','','',220,1,5,220)")
c.execute("INSERT INTO table_session_items (session_id,item_kind,item_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (1,'alcohol',1,'Kingfisher Premium','Kingfisher','650ml',180,2,18,360)")

# --- SETTLED table session on table 2 + its 2 linked bills (pro-rata split) --
c.execute(
    """INSERT INTO table_sessions (id,table_id,customer_name,customer_phone,status,opened_at,settled_at,opened_by)
       VALUES (2,2,'Anil','9800011111','settled','2026-09-02 19:00:00','2026-09-02 20:30:00',2)"""
)
c.execute("INSERT INTO table_session_items (session_id,item_kind,item_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (2,'food',3,'Butter Chicken','','',280,1,5,280)")
c.execute("INSERT INTO table_session_items (session_id,item_kind,item_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (2,'alcohol',2,'Blenders Pride','Blenders Pride','750ml',1200,1,20,1200)")
# discount 100 over subtotal 1480 -> food share round(100*280/1480,2)=18.92 ; alcohol gets remainder 81.08
c.execute(
    """INSERT INTO food_bills (id,bill_no,table_id,table_session_id,customer_name,customer_phone,subtotal,discount,tax,grand_total,payment_method,status,created_by,created_at)
       VALUES (2,'FOOD-000002',2,2,'Anil','9800011111',280,18.92,14,275.08,'UPI','confirmed',2,'2026-09-02 20:30:00')"""
)
c.execute("INSERT INTO food_bill_items (bill_id,item_name,price,qty,line_total) VALUES (2,'Butter Chicken',280,1,280)")
c.execute(
    """INSERT INTO alcohol_bills (id,bill_no,table_id,table_session_id,customer_name,customer_phone,subtotal,discount,tax,grand_total,payment_method,status,created_by,created_at)
       VALUES (2,'ALC-000002',2,2,'Anil','9800011111',1200,81.08,240,1358.92,'UPI','confirmed',2,'2026-09-02 20:30:00')"""
)
c.execute("INSERT INTO alcohol_bill_items (bill_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (2,'Blenders Pride','Blenders Pride','750ml',1200,1,20,1200)")

# --- QR orders --------------------------------------------------------
c.execute(
    """INSERT INTO qr_orders (id,order_no,public_ref,table_id,table_session_id,customer_name,note,status,subtotal,tax,grand_total,pushed_to_bill,created_at,updated_at)
       VALUES (1,'QR-000001','ref0000000000000000000000000001',1,1,'Priya','No onions','SERVED',220,0,220,1,'2026-09-02 12:06:00','2026-09-02 12:20:00')"""
)
c.execute("INSERT INTO qr_order_items (qr_order_id,item_kind,item_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (1,'food',1,'Paneer Tikka','','',220,1,0,220)")
c.execute(
    """INSERT INTO qr_orders (id,order_no,public_ref,table_id,table_session_id,customer_name,note,status,subtotal,tax,grand_total,pushed_to_bill,created_at,updated_at)
       VALUES (2,'QR-000002','ref0000000000000000000000000002',3,NULL,'Guest',NULL,'NEW',480,0,480,0,'2026-09-02 12:30:00','2026-09-02 12:30:00')"""
)
c.execute("INSERT INTO qr_order_items (qr_order_id,item_kind,item_id,item_name,brand,bottle_size,price,qty,tax_rate,line_total) VALUES (2,'food',2,'Chicken 65','','',240,2,0,480)")

# --- counters (>= max issued number) -------------------------------
c.execute("DELETE FROM counters")
c.execute("INSERT INTO counters (name,value) VALUES ('food_bill',2)")
c.execute("INSERT INTO counters (name,value) VALUES ('alcohol_bill',2)")
c.execute("INSERT INTO counters (name,value) VALUES ('qr_order',2)")

# --- audit log -----------------------------------------------------
c.execute(
    "INSERT INTO audit_log (id,actor_id,actor_username,actor_role,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    (1, 2, "cashier1", "staff", "bill.create", "food_bill", "1", json.dumps({"bill_no": "FOOD-000001", "grand_total": 714}), "2026-09-01 13:15:00"),
)
c.execute(
    "INSERT INTO audit_log (id,actor_id,actor_username,actor_role,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    (2, 2, "cashier1", "staff", "table.settle", "table_session", "2", json.dumps({"table_no": "Table 02", "grand_total": 1634, "discount": 100}), "2026-09-02 20:30:00"),
)
c.execute(
    "INSERT INTO audit_log (id,actor_id,actor_username,actor_role,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    (3, 1, "admin", "admin", "menu.item.price_change", "food_item", "3", json.dumps({"name": "Butter Chicken", "price": {"from": 260, "to": 280}}), "2026-08-30 11:00:00"),
)

db.commit()

# summary
for t in ["users", "food_categories", "alcohol_categories", "food_items", "alcohol_items",
          "restaurant_tables", "table_sessions", "table_session_items",
          "food_bills", "food_bill_items", "alcohol_bills", "alcohol_bill_items",
          "qr_orders", "qr_order_items", "counters", "audit_log"]:
    n = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    print(f"  {t:22} {n}")
db.close()
print(f"wrote {OUT}")
