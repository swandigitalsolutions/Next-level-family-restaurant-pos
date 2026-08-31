import json
import re
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "frontend" / "assets" / "menu-items-real"
TARGET_DIR = ROOT / "frontend" / "assets" / "menu-items"
MANIFEST_PATH = ROOT / "qa" / "menu-item-catalog.json"
MAP_PATH = ROOT / "frontend" / "assets" / "menu-image-map.js"

# Curated from the real image-search batches. Tags describe what is visibly represented
# or stated by the result title, allowing item-level but still distinct photo selection.
SOURCE_TAGS = {
    "FLsj21Whlxva.jpg": ["general", "food"], "dZzXkTLe5tak.jpg": ["gulab", "sweet", "dessert"], "2KTqTWsrKqTU.jpg": ["general", "food"],
    "KxynfgLoanDL.jpg": ["biryani", "rice"], "esHhr7o9JzXJ.jpg": ["biryani", "rice", "chicken"], "WYmv4V9uxULa.jpg": ["biryani", "rice", "chicken"],
    "8Sr1ePIGTflh.jpg": ["jalebi", "sweet", "dessert"], "Dd7HQyeuNVH1.jpg": ["general", "food"],
    "TOwR4zKwXLp1.jpg": ["chicken", "curry"], "PRGa14m1rA2B.webp": ["starter", "snack"], "fs7S09OcqPaR.jpg": ["butter", "chicken", "curry"],
    "fizPRR1GvECC.jpg": ["dosa", "bread", "south"], "Kl7mvi84ef2n.jpg": ["dosa", "south"], "Bq4M5QY8bwmh.jpg": ["chicken", "curry"],
    "PJKgE1Iqf7UI.jpg": ["starter", "snack"], "CwC2HvRQBk5M.jpg": ["general", "platter"],
    "DyJfgwaF9t86.jpg": ["soup"], "4oT57wkosUZv.jpg": ["seafood", "fish", "curry"], "bcYouPPdvOLW.jpg": ["prawn", "seafood", "curry"],
    "5eDhOeWp2KIn.jpg": ["fish", "seafood", "curry"], "CnOfek0BWuLJ.jpg": ["soup"], "Y9CENzkcapGR.jpg": ["soup"],
    "IXDUtGnto5G8.jpg": ["veg", "curry"], "pH2nrPrLHhhP.jpg": ["veg", "curry"],
    "oD3OXbVshrZU.jpg": ["biryani", "rice"], "fVyjq70g7pqI.jpg": ["biryani", "rice"], "LV3Z7vetR2ww.jpg": ["biryani", "rice"],
    "wpdbRvlVEjzI.jpg": ["naan", "bread"], "G4AvvjRW0WWn.jpg": ["roti", "bread"], "mFmLNeDSv7NF.jpg": ["tikka", "chicken", "starter"],
    "yxzGI7Hrak68.jpg": ["kebab", "chicken", "starter"], "dVwyv9itBlTZ.jpg": ["naan", "roti", "bread"],
    "yxkmn4N5qAwK.jpg": ["paneer", "veg", "curry"], "nZnrJQOMyDmD.jpg": ["thali", "veg", "platter"], "mdzziCIUNBUZ.jpg": ["paneer", "veg", "curry"],
    "c3vYVCgOmsXK.jpg": ["fried-rice", "rice"], "uJwXj3NURIJc.jpg": ["paneer", "tikka", "starter"], "XssHp62dNcWQ.jpg": ["thali", "veg", "platter"],
    "t36fiq3Niexs.jpg": ["fried-rice", "rice"], "zGSf1WMDil5z.jpg": ["fried-rice", "rice"],
    "pNrHCTQkIFhN.jpg": ["chai", "beverage"], "A4r49iD82ubn.jpg": ["dessert", "sweet"], "5OVhc8hFQKfP.jpg": ["coffee", "chai", "beverage"],
    "uLALnO7C7sTb.jpg": ["lassi", "beverage"], "fo68tMz463ZD.jpg": ["lassi", "beverage"], "gAgRyOkfRKuA.jpg": ["sweet", "dessert"],
    "xIoijGhsIG6R.jpg": ["chai", "coffee", "beverage"], "5Im9IcKvx5V1.jpg": ["sweet", "dessert"],
    "IEZrT4maISkh.jpg": ["samosa", "starter", "snack"], "bCyA9bXWQYPt.jpg": ["samosa", "starter", "snack"], "CiOJpygEnOPo.jpg": ["idli", "vada", "south"],
    "dp9Z4mhcaMmP.jpg": ["idli", "vada", "south"], "0dPoagwPz2S3.jpg": ["chutney", "south"], "TQbv9kvpXhjg.jpg": ["idli", "dosa", "vada", "south"],
    "gMHKQn3bjEGN.jpg": ["starter", "snack"], "Ee2ICjEKoMmY.jpg": ["dosa", "south"],
    "kvM7DjMu5OUC.jpg": ["dal", "veg", "curry"], "bcXYgi7SejMy.jpg": ["kofta", "chicken", "curry"], "LHbXhXbFg9Nr.jpg": ["veg", "curry"],
    "0tNcO4flpdwh.jpg": ["dal", "veg", "curry"], "UtTh9khBBqzn.jpg": ["veg", "curry"], "hnDrD9SzLPPo.jpg": ["kofta", "mutton", "curry"],
    "arQt7hOhdnZ1.jpg": ["kofta", "veg", "curry"], "8Uh7hP28u8jR.jpg": ["dal", "veg", "curry"],
    "9nIVzxVPTz62.jpg": ["chicken", "main"], "41hvfYzJX3z0.jpg": ["mutton", "curry"], "HDyRka71b6BC.jpg": ["prawn", "seafood", "curry"],
    "5qDAakhskEsT.jpg": ["prawn", "seafood", "curry"], "tgVwsXjae5gX.jpg": ["mutton", "curry"], "96FvRKgNmpVZ.jpg": ["prawn", "seafood", "curry"],
    "S35LszWyt5Md.jpg": ["chicken", "curry"], "T8cVu8WbdRM4.jpg": ["butter", "chicken", "curry"],
    "1bM5D2tdtLQo.jpg": ["whisky", "bar"], "Yjcv3cB8cpKn.jpg": ["whisky", "bar"], "xCMUv3q4HJjW.jpg": ["beer", "bar"],
    "jLfBkHbVHAS8.jpg": ["wine", "bar"], "guPUN8PUiHiT.png": ["beer", "bar"], "z2RVT2wyADM0.jpg": ["beer", "bar"],
    "Lv3AQO8C9iWQ.jpg": ["whisky", "bar"], "f0egaZpIWiaD.webp": ["wine", "bar"],
    "s8NRZwkTZh3j.jpg": ["margarita", "cocktail"], "XcCciKv3j3wq.jpg": ["mojito", "cocktail"], "eh1ktviGMkeu.jpg": ["margarita", "cocktail"],
    "rOZhYJQ3XMZZ.jpg": ["colorful", "cocktail"], "G2S3p7SSwyWL.jpg": ["mojito", "cocktail"], "46umQQffggps.jpg": ["colorful", "cocktail"],
    "j53H9LTYLJmY.jpg": ["margarita", "cocktail"], "5FThTBDmGScJ.png": ["mojito", "cocktail"],
    "WwswuXDZvpKW.jpeg": ["gin", "bar"], "xbIfQXDcmynD.jpg": ["gin", "rum", "tequila", "bar"], "Pb3Tky1BRxbT.jpg": ["gin", "bar"],
    "BPKUrQUj7yJA.jpg": ["tequila", "bar"], "VUz0wLfU0SNu.jpeg": ["vodka", "bar"], "5yD8bOwCcy7D.jpeg": ["gin", "bar"],
    "Qj9aQPxTLuKa.jpg": ["liquor", "bar"], "j3xl96PDQCpf.jpg": ["liquor", "bar"],
    "ouPHYFY2wmUO.jpg": ["wine", "bar"], "OKsVlqSh3rKH.jpg": ["wine", "bar"], "AtDxXcIXTkxl.webp": ["cocktail", "bar"], "sHS3ow5HamHT.webp": ["cocktail", "bar"],
    "8LRNSTM3JqHB.jpg": ["wine", "bar"], "FEshV4l1kB4y.webp": ["beer", "bar"], "WTBH4lKnkpye.jpg": ["bar", "liquor"], "3t27Cjs9OON4.jpeg": ["bar", "liquor"],
    "9QdENzdZWRFt.jpg": ["platter", "nonveg", "starter"], "vevGK1dI0stO.jpg": ["chicken65", "chicken", "starter"], "blh6pWsmD2wa.jpg": ["general", "food"],
    "dQO20sO437hu.jpg": ["chicken65", "chicken", "starter"], "bJjap5uHnIun.jpg": ["noodles", "chicken"], "IJumLD7vVIav.jpg": ["noodles", "veg"],
    "TeWgZKBD74T4.jpg": ["chicken", "starter"], "67Bcs4G0luXf.jpg": ["noodles", "chicken"],
    "MV3nVUMEGetO.jpg": ["platter", "south", "veg"], "DJGdQH5OstYu.jpg": ["platter", "starter", "snack"], "G3eq73TMnSPS.jpg": ["rice"],
    "94hL8ACS9nGo.jpg": ["rice", "curry"], "P25cdlFsbuX1.jpg": ["platter", "snack"], "jvUwH1WsTEbL.jpg": ["regional", "food"],
    "rdIVJI4hZf0w.jpg": ["thali", "platter"], "sdzkDNlTTHG7.jpg": ["regional", "food"],
}


def key(kind, name):
    return f"{kind}:{name.strip().lower()}"


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def make_asset(source, target):
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original).convert("RGB")
        image = ImageOps.fit(image, (1000, 750), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        image.save(target, "JPEG", quality=86, optimize=True, progressive=True)


def preferences(item):
    name = item["name"].lower()
    category = item.get("category", "").lower()
    if item["kind"] == "alcohol":
        if "beer" in category: return ["beer", "bar"]
        if "whisky" in category: return ["whisky", "bar"]
        if "vodka" in category: return ["vodka", "bar"]
        if "rum" in category: return ["rum", "bar"]
        if "wine" in category: return ["wine", "bar"]
        if "gin" in category: return ["gin", "bar"]
        if "tequila" in category: return ["tequila", "bar"]
        if "brandy" in category: return ["liquor", "bar"]
        return ["margarita", "mojito", "cocktail", "colorful", "bar"]
    if "chicken 65" in name: return ["chicken65", "starter"]
    if "noodle" in name or "chow" in name: return ["noodles", "veg", "chicken"]
    if "prawn" in name or "shrimp" in name: return ["prawn", "seafood", "curry"]
    if "fish" in name: return ["fish", "seafood", "curry"]
    if "mutton" in name: return ["mutton", "curry"]
    if "butter chicken" in name: return ["butter", "chicken", "curry"]
    if "paneer" in name: return ["paneer", "veg", "curry"]
    if "dal" in name: return ["dal", "veg", "curry"]
    if "kofta" in name: return ["kofta", "veg", "curry"]
    if "biryani" in name: return ["biryani", "rice"]
    if "fried rice" in name: return ["fried-rice", "rice"]
    if category == "rice & biryani": return ["rice", "biryani"]
    if category == "breads": return ["naan", "roti", "bread"]
    if category == "south indian": return ["dosa", "idli", "vada", "south"]
    if category == "desserts": return ["dessert", "sweet", "jalebi", "gulab"]
    if category == "beverages": return ["beverage", "chai", "coffee", "lassi"]
    if category == "soups": return ["soup"]
    if category == "starters": return ["starter", "snack", "platter", "tikka", "kebab"]
    if category == "main course - non veg": return ["chicken", "curry", "nonveg", "platter"]
    return ["veg", "curry", "general", "food"]


def score(tags, wanted):
    return sum((len(wanted) - index) * (2 if tag == wanted[index] else 1) for index, tag in enumerate(wanted) if tag in tags)


def main():
    entries = json.loads(MANIFEST_PATH.read_text())
    items = [entry for entry in entries if entry.get("kind") in {"food", "alcohol"}]
    sources = sorted([path for path in SOURCE_DIR.iterdir() if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}])
    if len(sources) < len(items):
        raise RuntimeError(f"Need {len(items)} image files but found {len(sources)}")
    unknown = [source.name for source in sources if source.name not in SOURCE_TAGS]
    if unknown:
        raise RuntimeError(f"Missing tags for: {unknown}")

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    unused = {source.name for source in sources}
    mapping = {}
    assignments = []
    for index, item in enumerate(items, start=1):
        wanted = preferences(item)
        pool = [source for source in sources if source.name in unused and (set(SOURCE_TAGS[source.name]) & {"bar", "beer", "whisky", "vodka", "rum", "wine", "brandy", "gin", "tequila", "liquor", "cocktail", "margarita", "mojito", "colorful"})] if item["kind"] == "alcohol" else [source for source in sources if source.name in unused]
        candidates = sorted(pool, key=lambda source: score(SOURCE_TAGS[source.name], wanted), reverse=True)
        if not candidates:
            raise RuntimeError(f"No valid real image remains for {item['kind']} {item['name']}")
        source = candidates[0]
        unused.remove(source.name)
        filename = f"{index:03d}-{item['kind']}-{slug(item['name'])}.jpg"
        target = TARGET_DIR / filename
        make_asset(source, target)
        relative = f"../assets/menu-items/{filename}"
        mapping[key(item["kind"], item["name"])] = relative
        assignments.append({
            "kind": item["kind"], "category": item.get("category", ""), "name": item["name"],
            "asset": relative, "source_file": source.name, "tags": SOURCE_TAGS[source.name],
            "source_title": "Curated real internet image-search asset", "source_page": "",
        })

    MAP_PATH.write_text("/* Generated from curated real internet image-search assets. */\nwindow.MENU_IMAGE_MAP = " + json.dumps(mapping, indent=2, ensure_ascii=False) + ";\n")
    manifest_text = json.dumps(assignments, indent=2, ensure_ascii=False) + "\n"
    (ROOT / "qa" / "menu-image-assignments.json").write_text(manifest_text)
    (ROOT / "qa" / "menu-item-catalog.json").write_text(manifest_text)
    print(f"Assigned {len(assignments)} unique semantic real images")
    print(f"Unused pool: {len(unused)}")


if __name__ == "__main__":
    main()
