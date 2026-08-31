import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
assignments = json.loads((ROOT / "qa" / "menu-item-catalog.json").read_text())
assets = [entry["asset"] for entry in assignments]
missing = [entry["asset"] for entry in assignments if not (ROOT / "frontend" / entry["asset"].replace("../", "")).exists()]
assert len(assignments) == 108, len(assignments)
assert len(set(assets)) == 108, len(set(assets))
assert not missing, missing
assert sum(entry["kind"] == "food" for entry in assignments) == 78
assert sum(entry["kind"] == "alcohol" for entry in assignments) == 30
assert len({entry["source_file"] for entry in assignments}) == 108
bar_tags = {"bar", "beer", "whisky", "vodka", "rum", "wine", "brandy", "gin", "tequila", "liquor", "cocktail", "margarita", "mojito", "colorful"}
assert all(set(entry.get("tags", [])) & bar_tags for entry in assignments if entry["kind"] == "alcohol")
print({"assignments": len(assignments), "unique_assets": len(set(assets)), "unique_sources": len({entry['source_file'] for entry in assignments}), "missing": len(missing), "food": 78, "alcohol": 30})
