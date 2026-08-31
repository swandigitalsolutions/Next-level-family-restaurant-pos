import io
import json
import re
import sys
import time
from pathlib import Path

import requests
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))
from database import FOOD_SEED  # noqa: E402

API = "https://commons.wikimedia.org/w/api.php"
OUT_DIR = ROOT / "frontend" / "assets" / "menu-items-corrected"
OUT_DIR.mkdir(parents=True, exist_ok=True)
MANIFEST_PATH = ROOT / "qa" / "correct-food-image-manifest.json"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "NextLevelFamilyRestaurantProductionAssetFetcher/2.0 (menu image preparation)"})
USED_PAGE_IDS = set()

STOPWORDS = {"and", "the", "with", "style", "recipe", "indian", "food", "dish", "pc", "piece", "pieces", "soup"}
SYNONYMS = {
    "prawn": {"prawn", "prawns", "shrimp"}, "chicken": {"chicken"}, "mutton": {"mutton", "lamb", "goat"},
    "paneer": {"paneer", "cottage", "cheese"}, "gobi": {"gobi", "cauliflower"}, "manchow": {"manchow", "manchurian"},
    "biryani": {"biryani", "biriyani"}, "dosa": {"dosa", "dosai"}, "vada": {"vada", "vade", "medu"},
    "roti": {"roti", "chapati"}, "naan": {"naan"}, "lassi": {"lassi"}, "chai": {"chai", "tea"},
    "coffee": {"coffee"}, "soda": {"soda", "lime"}, "juice": {"juice"}, "dessert": {"dessert", "sweet"},
}


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def tokens(text):
    raw = re.findall(r"[a-z0-9]+", text.lower())
    expanded = set()
    for token in raw:
        if token not in STOPWORDS:
            expanded.add(token)
            expanded.update(SYNONYMS.get(token, set()))
    return expanded


def query_api(params):
    response = SESSION.get(API, params={**params, "format": "json"}, timeout=30)
    response.raise_for_status()
    return response.json()


def search_candidates(query):
    data = query_api({"action": "query", "list": "search", "srsearch": query, "srnamespace": 6, "srlimit": 30})
    hits = data.get("query", {}).get("search", [])
    pageids = [str(hit["pageid"]) for hit in hits if hit.get("pageid")]
    if not pageids:
        return []
    info = query_api({"action": "query", "pageids": "|".join(pageids), "prop": "imageinfo", "iiprop": "url|mime|size|extmetadata", "iiurlwidth": 1200})
    candidates = []
    for page in info.get("query", {}).get("pages", {}).values():
        imageinfo = (page.get("imageinfo") or [{}])[0]
        mime = imageinfo.get("mime", "")
        if not mime.startswith("image/"):
            continue
        url = imageinfo.get("thumburl") or imageinfo.get("url")
        if not url or (imageinfo.get("width") or 0) < 500 or (imageinfo.get("height") or 0) < 300:
            continue
        candidates.append({"pageid": page.get("pageid"), "title": page.get("title", ""), "url": url, "info": imageinfo})
    return candidates


def title_score(item_name, category, title, query_priority):
    name = item_name.lower()
    title_text = re.sub(r"^file:\s*", "", title.lower())
    name_tokens = tokens(name)
    title_tokens = tokens(title_text)
    exact_phrase = re.sub(r"[^a-z0-9 ]", " ", name).strip()
    normalized_title = re.sub(r"[^a-z0-9 ]", " ", title_text)
    score = query_priority * 4
    if exact_phrase and exact_phrase in normalized_title:
        score += 100
    if name_tokens:
        score += round(60 * len(name_tokens & title_tokens) / len(name_tokens), 2)
    category_tokens = tokens(category)
    score += min(12, len(category_tokens & title_tokens) * 3)
    if any(bad in title_text for bad in ["logo", "icon", "flag", "map", "poster", "screenshot"]):
        score -= 100
    return score


def choose(item, candidate_groups):
    candidates = []
    for priority, group in enumerate(candidate_groups, start=1):
        for candidate in group:
            if candidate.get("pageid") in USED_PAGE_IDS:
                continue
            candidate["score"] = title_score(item["name"], item["category"], candidate["title"], len(candidate_groups) - priority + 1)
            candidates.append(candidate)
    if not candidates:
        return None
    candidates.sort(key=lambda candidate: (candidate["score"], candidate.get("info", {}).get("width", 0)), reverse=True)
    selected = candidates[0]
    USED_PAGE_IDS.add(selected.get("pageid"))
    return selected


def metadata(info):
    ext = info.get("extmetadata", {})
    def clean(key):
        value = str(ext.get(key, {}).get("value", ""))
        return re.sub(r"<[^>]+>", "", value).strip()
    return {"author": clean("Artist") or clean("Credit"), "license": clean("LicenseShortName") or clean("UsageTerms")}


def download(candidate, target):
    response = SESSION.get(candidate["url"].split("?", 1)[0], timeout=45)
    response.raise_for_status()
    with Image.open(io.BytesIO(response.content)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image = ImageOps.fit(image, (1000, 750), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        image.save(target, "JPEG", quality=88, optimize=True, progressive=True)


def all_food_items():
    return [{"kind": "food", "category": category, "name": name} for category, items in FOOD_SEED.items() for name, _price in items]


def queries(item):
    name = item["name"]
    category = item["category"]
    return [
        f'intitle:"{name}"',
        f'"{name}" Indian',
        f'"{name}" {category}',
        f'{name} Indian food',
        f'{name} recipe',
    ]


def main():
    results = []
    items = all_food_items()
    for index, item in enumerate(items, start=1):
        groups = []
        for query in queries(item):
            try:
                groups.append(search_candidates(query))
            except Exception as exc:
                print(f"[{index}/{len(items)}] {item['name']} query failed: {exc}", file=sys.stderr)
                groups.append([])
            time.sleep(0.35)
            if groups[-1] and any(title_score(item["name"], item["category"], c["title"], 1) >= 100 for c in groups[-1]):
                break
        candidate = choose(item, groups)
        if not candidate:
            result = {**item, "status": "missing", "queries": queries(item)}
            print(f"[{index}/{len(items)}] {item['name']} — missing")
            results.append(result)
            continue
        filename = f"{slug(item['name'])}.jpg"
        target = OUT_DIR / filename
        try:
            download(candidate, target)
            result = {
                **item, "status": "ok", "asset": f"../assets/menu-items-corrected/{filename}",
                "source_title": candidate["title"], "source_page": f"https://commons.wikimedia.org/wiki/{candidate['title'].replace(' ', '_')}",
                "source_url": candidate["url"].split("?", 1)[0], "match_score": candidate["score"],
                **metadata(candidate.get("info", {})),
            }
            print(f"[{index}/{len(items)}] {item['name']} — {candidate['title']} — score {candidate['score']}")
        except Exception as exc:
            result = {**item, "status": "download_failed", "source_title": candidate["title"], "error": str(exc)}
            print(f"[{index}/{len(items)}] {item['name']} — download failed: {exc}")
        results.append(result)
        time.sleep(0.35)
    MANIFEST_PATH.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
    ok = sum(row["status"] == "ok" for row in results)
    print(f"Fetched {ok}/{len(results)} exact food image candidates")


if __name__ == "__main__":
    main()
