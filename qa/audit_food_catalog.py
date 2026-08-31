import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
rows = json.loads((ROOT / "qa" / "menu-item-catalog.json").read_text())
foods = [row for row in rows if row["kind"] == "food"]
by_category = defaultdict(list)
for row in foods:
    by_category[row["category"]].append(row)

print(f"food_items={len(foods)} categories={len(by_category)}")
for category, items in by_category.items():
    print(f"\n[{category}] ({len(items)})")
    print(" | ".join(item["name"] for item in items))

food_words = {
    "biryani": {"biryani", "rice"}, "fried rice": {"fried-rice", "rice"}, "naan": {"naan", "bread", "roti"},
    "roti": {"roti", "bread"}, "paratha": {"bread", "roti"}, "dosa": {"dosa", "south"}, "idli": {"idli", "south"},
    "vada": {"vada", "south"}, "soup": {"soup"}, "prawn": {"prawn", "seafood", "curry"}, "fish": {"fish", "seafood", "curry"},
    "mutton": {"mutton", "curry"}, "chicken": {"chicken", "curry"}, "paneer": {"paneer", "veg", "curry"},
    "dal": {"dal", "veg", "curry"}, "kofta": {"kofta", "curry"}, "dessert": {"dessert", "sweet"}, "gulab": {"gulab", "sweet", "dessert"},
    "jalebi": {"jalebi", "sweet", "dessert"}, "kheer": {"sweet", "dessert"}, "kulfi": {"sweet", "dessert"}, "lassi": {"lassi", "beverage"},
    "coffee": {"coffee", "beverage"}, "chai": {"chai", "beverage"}, "juice": {"beverage"}, "soda": {"beverage"},
}

mismatches = []
for item in foods:
    haystack = (item["name"] + " " + item.get("category", "")).lower()
    expected = set()
    for phrase, tags in food_words.items():
        if phrase in haystack:
            expected |= tags
    actual = set(item.get("tags", []))
    if expected and not (expected & actual):
        mismatches.append((item["name"], item["category"], item["source_file"], sorted(actual), sorted(expected)))
print(f"\nobvious_mismatches={len(mismatches)}")
for row in mismatches:
    print(row)
