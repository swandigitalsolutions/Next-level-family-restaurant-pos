import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "qa" / "menu-item-catalog.json"
OUT_JS = ROOT / "frontend" / "js" / "correct-food-image-map.js"
OUT_JSON = ROOT / "qa" / "correct-food-image-assignments.json"
ASSET_DIR = ROOT / "frontend" / "assets" / "menu-items-corrected"

EXACT = {
    "Buttermilk": "buttermilk.jpg", "Cold Coffee": "cold-coffee.jpg", "Filter Coffee": "filter-coffee.jpg", "Fresh Juice": "fresh-juice.jpg", "Fresh Lime Soda": "fresh-lime-soda.jpg", "Mango Lassi": "mango-lassi.jpg", "Masala Chai": "masala-chai.jpg", "Mineral Water": "mineral-water.jpg", "Soft Drink": "soft-drink.jpg", "Sweet Lassi": "sweet-lassi.jpg",
    "Butter Naan": "breads-platter.jpg", "Cheese Naan": "garlic-cheese-naan.jpg", "Garlic Naan": "garlic-naan-exact.jpg", "Kulcha": "tandoori-roti-kulcha.jpg", "Laccha Paratha": "laccha-paratha-exact.jpg", "Missi Roti": "missi-roti-exact.jpg", "Plain Roti": "plain-roti-exact.jpg", "Tandoori Roti": "tandoori-roti-kulcha.jpg",
    "Gajar Halwa": "gajar-halwa-exact.jpg", "Gulab Jamun (2pc)": "gulab-jamun-exact.jpg", "Ice Cream Scoop": "ice-cream-scoop-exact.jpg", "Jalebi": "jalebi-exact.jpeg", "Kheer": "kheer-exact.jpg", "Kulfi": "kulfi-exact.jpg", "Rasmalai (2pc)": "rasmalai-exact.jpg",
    "Butter Chicken": "butter-chicken-exact.jpg", "Chicken Chettinad": "chicken-chettinad-exact.jpg", "Chicken Curry": "butter-chicken.jpg", "Chicken Kadai": "chicken-chettinad-exact.jpg", "Egg Curry": "egg-curry-exact.jpg", "Fish Curry": "goan-fish-curry-exact.jpg", "Goan Fish Curry": "goan-fish-curry-exact.jpg", "Mutton Curry": "mutton-curry-exact.jpg", "Mutton Rogan Josh": "mutton-rogan-josh-exact.jpg", "Prawn Masala": "prawn-masala-exact.jpg",
    "Aloo Gobi": "aloo-gobi.jpg", "Chana Masala": "chana-masala.jpg", "Dal Makhani": "dal-makhani.jpg", "Kadai Paneer": "kadai-paneer.jpg", "Malai Kofta": "malai-kofta-exact.jpg", "Mixed Veg Curry": "veg-kolhapuri-exact.jpg", "Palak Paneer": "palak-paneer-exact.jpg", "Paneer Butter Masala": "paneer-butter-masala-exact.jpg", "Veg Kadai": "paneer-butter-masala.jpg", "Veg Kolhapuri": "veg-kolhapuri-exact.jpg",
    "Chicken Biryani": "chicken-biryani.jpg", "Chicken Fried Rice": "chicken-fried-rice-exact.jpg", "Curd Rice": "curd-rice-exact.jpg", "Egg Biryani": "chicken-biryani.jpg", "Jeera Rice": "jeera-rice-exact.jpg", "Mutton Biryani": "mutton-biryani.jpg", "Prawn Biryani": "prawn-masala-exact.jpg", "Veg Biryani": "veg-biryani.jpg", "Veg Fried Rice": "veg-fried-rice.jpg",
    "Chicken Clear Soup": "chicken-clear-soup.jpg", "Hot & Sour Soup": "hot-sour-soup.jpg", "Manchow Soup": "manchow-soup.jpg", "Mutton Soup": "mutton-soup.jpg", "Sweet Corn Soup": "sweet-corn-soup.jpg", "Tomato Soup": "tomato-soup.jpg",
    "Idli (2pc)": "idli-dosa-vada.jpg", "Masala Dosa": "masala-dosa.jpg", "Medu Vada": "idli-dosa-vada.jpg", "Plain Dosa": "plain-dosa.jpg", "Pongal": "idli-dosa-uttapam.jpg", "Rava Dosa": "idli-dosa-uttapam.jpg", "Uttapam": "idli-dosa-uttapam.jpg", "Vada (2pc)": "idli-dosa-vada.jpg",
    "Chicken 65": "chicken-65-ai.jpg", "Chicken Lollipop": "chicken-lollipop-ai.jpg", "Chilli Paneer": "chilli-paneer-ai.jpg", "Corn Cheese Balls": "corn-cheese-balls-ai.jpg", "Fish Fingers": "fish-fingers-ai.jpg", "Gobi Manchurian": "gobi-manchurian.jpg", "Mutton Seekh Kebab": "mutton-seekh-kebab-exact.jpg", "Paneer Tikka": "paneer-tikka-exact.jpg", "Prawn Koliwada": "prawn-koliwada.jpg", "Veg Spring Roll": "veg-spring-roll.jpg",
}

# Some exact names above refer to future/current catalog assets. These are resolved to the existing curated pool when the corrected folder does not contain a named file.
LEGACY_BY_STEM = {
    "chicken-biryani.jpg": "../assets/menu-items/076-food-chicken-biryani.jpg", "chicken-fried-rice.jpg": "../assets/menu-items/077-food-chicken-fried-rice.jpg", "curd-rice.jpg": "../assets/menu-items/078-food-curd-rice.jpg", "jeera-rice.jpg": "../assets/menu-items/080-food-jeera-rice.jpg", "mutton-biryani.jpg": "../assets/menu-items/081-food-mutton-biryani.jpg", "veg-biryani.jpg": "../assets/menu-items/083-food-veg-biryani.jpg", "veg-fried-rice.jpg": "../assets/menu-items/084-food-veg-fried-rice.jpg",
}


def key(kind, name):
    return f"{kind}:{name.strip().lower()}"


def asset_for(name, original):
    filename = EXACT.get(name)
    if filename:
        candidate = ASSET_DIR / filename
        if candidate.exists():
            return f"../assets/menu-items-corrected/{filename}", "corrected-local-photo"
        if filename in LEGACY_BY_STEM:
            return LEGACY_BY_STEM[filename], "curated-real-photo-fallback"
    # Fail-safe category-specific fallback, never a food image for a bar item.
    return original, "existing-item-asset"

catalog = json.loads(CATALOG.read_text())
assignments = []
map_data = {}
for item in catalog:
    if item.get("kind") != "food":
        continue
    asset, source_type = asset_for(item["name"], item.get("asset", "../assets/menu-reference.jpg"))
    row = {"kind": "food", "category": item["category"], "name": item["name"], "asset": asset, "source_type": source_type}
    assignments.append(row)
    map_data[key("food", item["name"])] = asset

OUT_JSON.write_text(json.dumps(assignments, indent=2, ensure_ascii=False) + "\n")
OUT_JS.write_text("window.CORRECT_FOOD_IMAGE_MAP = " + json.dumps(map_data, ensure_ascii=False, indent=2) + ";\n")
missing = [row["name"] for row in assignments if row["source_type"] == "existing-item-asset"]
print(f"Generated {len(assignments)} food assignments; corrected-local={sum(r['source_type']=='corrected-local-photo' for r in assignments)}; legacy-fallback={sum(r['source_type']=='curated-real-photo-fallback' for r in assignments)}; unchanged={len(missing)}")
if missing:
    print("Unchanged assignments:", ", ".join(missing))
