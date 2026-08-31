import json
from pathlib import Path

items = json.loads((Path(__file__).resolve().parents[1] / "qa" / "menu-item-catalog.json").read_text())
bar_tags = {"bar", "beer", "whisky", "vodka", "rum", "wine", "brandy", "gin", "tequila", "liquor", "cocktail", "margarita", "mojito", "colorful"}
for item in items:
    if item["kind"] == "alcohol" and not (set(item.get("tags", [])) & bar_tags):
        print(item["name"], item["category"], item["source_file"], item.get("tags"))
