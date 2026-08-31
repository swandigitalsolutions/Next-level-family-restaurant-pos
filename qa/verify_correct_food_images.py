import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSIGNMENTS = ROOT / 'qa' / 'correct-food-image-assignments.json'
MAP = ROOT / 'frontend' / 'js' / 'correct-food-image-map.js'
DB = ROOT / 'backend' / 'nextlevel.db'

rows = json.loads(ASSIGNMENTS.read_text())
assert len(rows) == 78, len(rows)
assert len({row['name'] for row in rows}) == 78
assert MAP.exists()

missing = []
for row in rows:
    asset = row['asset']
    path = ROOT / 'frontend' / asset.replace('../', '')
    if not path.exists():
        missing.append((row['name'], asset))
assert not missing, missing

# Guardrails for the specific production mismatch class reported by the user.
for row in rows:
    name = row['name'].lower()
    asset = row['asset'].lower()
    if 'chicken lollipop' in name:
        assert 'chicken-lollipop' in asset, row
    if 'chicken 65' in name:
        assert 'chicken-65' in asset, row
    if 'mutton seekh' in name:
        assert 'seekh' in asset, row
    if 'paneer tikka' in name:
        assert 'paneer-tikka' in asset, row
    if 'gulab jamun' in name:
        assert 'gulab-jamun' in asset, row
    if name == 'jalebi':
        assert 'jalebi' in asset, row
    if 'gajar halwa' in name:
        assert 'gajar-halwa' in asset, row
    if 'curd rice' in name:
        assert 'curd-rice' in asset, row

conn = sqlite3.connect(DB)
tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
for required in ('restaurant_tables', 'table_sessions', 'table_session_items'):
    assert required in tables, required
count = conn.execute('SELECT COUNT(*) FROM restaurant_tables').fetchone()[0]
assert count >= 12, count
qa = conn.execute("SELECT COUNT(*) FROM table_sessions WHERE customer_name='QA Guest'").fetchone()[0]
assert qa == 0, qa
conn.close()
print(f'food_map_ok items={len(rows)} missing={len(missing)} default_tables={count} qa_sessions={qa}')
