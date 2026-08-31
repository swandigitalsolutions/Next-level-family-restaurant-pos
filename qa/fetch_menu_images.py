import io
import json
import re
import sys
import time
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "frontend" / "assets" / "menu-items"
ASSET_DIR.mkdir(parents=True, exist_ok=True)
BACKEND_DIR = ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))
from database import FOOD_SEED, ALCOHOL_SEED  # noqa: E402

API = "https://commons.wikimedia.org/w/api.php"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "NextLevelFamilyRestaurantMenuAssetFetcher/1.0 (local project asset preparation)"})
USED_TITLES = set()


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def clean_query(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9 /&'-]+", " ", value).strip()


def search_candidates(query: str):
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srnamespace": 6,
        "srlimit": 20,
        "srinfo": "totalhits",
        "format": "json",
    }
    try:
        response = SESSION.get(API, params=params, timeout=25)
        response.raise_for_status()
        hits = response.json().get("query", {}).get("search", [])
        titles = [hit.get("title") for hit in hits if hit.get("title")]
        if not titles:
            return []
        info_response = SESSION.get(API, params={
            "action": "query",
            "pageids": "|".join(str(hit.get("pageid")) for hit in hits if hit.get("pageid")),
            "prop": "imageinfo",
            "iiprop": "url|mime|size|extmetadata",
            "iiurlwidth": 1000,
            "format": "json",
        }, timeout=25)
        info_response.raise_for_status()
        pages = info_response.json().get("query", {}).get("pages", {})
        candidates = []
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            mime = info.get("mime", "")
            url = info.get("thumburl") or info.get("url")
            if url and mime.startswith("image/") and (info.get("width") or 0) >= 500 and (info.get("height") or 0) >= 300:
                candidates.append({"title": page.get("title", ""), "pageid": page.get("pageid"), "url": url, "info": info})
        return candidates
    except Exception as exc:
        print(f"search failed: {query}: {exc}", file=sys.stderr)
        return []


def choose_candidate(candidates):
    for candidate in candidates:
        title = candidate.get("title")
        if title and title not in USED_TITLES:
            USED_TITLES.add(title)
            return candidate
    return None


def queries_for(item):
    name = clean_query(item["name"])
    category = clean_query(item["category"])
    kind = item["kind"]
    if kind == "food":
        return [f'intitle:"{name}"', f'"{name}" Indian dish', f'{name} {category}', f'Indian {category} food', 'Indian food dish']
    if category.lower() in {"beer", "whisky", "vodka", "rum", "wine", "brandy", "gin", "tequila"}:
        return [f'intitle:"{name}"', f'{name} bottle', f'{category} bottle', f'{category} drink', 'alcohol beverage']
    return [f'intitle:"{name}"', f'{name} cocktail', 'cocktail drink', 'bar beverage']


def fetch_one(item, index, total):
    name = item["name"]
    queries = queries_for(item)
    candidate = None
    for query in queries:
        candidate = choose_candidate(search_candidates(query))
        time.sleep(0.45)
        if candidate:
            break
    if not candidate:
        return {**item, "status": "missing", "queries": queries}

    try:
        image_url = candidate["url"].split("?", 1)[0]
        response = SESSION.get(image_url, timeout=40)
        response.raise_for_status()
        image = Image.open(io.BytesIO(response.content)).convert("RGB")
        image.thumbnail((1000, 750), Image.Resampling.LANCZOS)
        filename = f"{item['kind']}-{slug(name)}.jpg"
        image.save(ASSET_DIR / filename, "JPEG", quality=84, optimize=True)
        metadata = candidate.get("info", {}).get("extmetadata", {})
        clean = lambda key: re.sub(r"<[^>]+>", "", str(metadata.get(key, {}).get("value", ""))).strip()
        result = {
            **item,
            "status": "ok",
            "path": f"../assets/menu-items/{filename}",
            "source_title": candidate.get("title"),
            "source_page": f"https://commons.wikimedia.org/wiki/{candidate.get('title', '').replace(' ', '_')}",
            "source_url": image_url,
            "author": clean("Artist") or clean("Credit"),
            "license": clean("LicenseShortName") or clean("UsageTerms"),
            "width": image.width,
            "height": image.height,
        }
        print(f"[{index}/{total}] {item['kind']}: {name} — ok — {candidate.get('title')}")
        time.sleep(0.45)
        return result
    except Exception as exc:
        print(f"[{index}/{total}] {item['kind']}: {name} — download_failed — {exc}")
        return {**item, "status": "download_failed", "source_title": candidate.get("title"), "error": str(exc)}


def all_items():
    result = []
    for category, entries in FOOD_SEED.items():
        result.extend({"kind": "food", "category": category, "name": entry[0]} for entry in entries)
    for category, entries in ALCOHOL_SEED.items():
        result.extend({"kind": "alcohol", "category": category, "name": entry[0]} for entry in entries)
    return result


if __name__ == "__main__":
    items = all_items()
    results = [fetch_one(item, index, len(items)) for index, item in enumerate(items, start=1)]
    results.sort(key=lambda item: (item["kind"], item["category"], item["name"]))
    (ROOT / "qa" / "menu-image-sources.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
    ok = sum(1 for item in results if item["status"] == "ok")
    print(f"Fetched {ok}/{len(results)} distinct real images")
