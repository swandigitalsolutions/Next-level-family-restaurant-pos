import re
from pathlib import Path

text = (Path(__file__).resolve().parents[1] / "qa" / "build_item_image_map.py").read_text()
bar_tags = {"bar", "beer", "whisky", "vodka", "rum", "wine", "brandy", "gin", "tequila", "liquor", "cocktail", "margarita", "mojito", "colorful"}
rows = re.findall(r'"([^\"]+\.(?:jpg|jpeg|png|webp))": \[([^\]]+)\]', text)
bar = []
for name, raw_tags in rows:
    tags = {tag.strip().strip('"') for tag in raw_tags.split(',')}
    if tags & bar_tags:
        bar.append((name, sorted(tags)))
print(f"tagged rows={len(rows)} bar-tagged={len(bar)}")
for name, tags in bar:
    print(name, tags)
