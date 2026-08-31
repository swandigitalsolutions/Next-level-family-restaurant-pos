import json
import re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSIGNMENT_FILES = [
    ROOT / 'qa' / 'correct-food-image-assignments.json',
    ROOT / 'qa' / 'menu-image-assignments.json',
]
rows = []
for path in ASSIGNMENT_FILES:
    if path.exists():
        try:
            data = json.loads(path.read_text())
            rows.extend(data)
        except Exception as exc:
            print(f'WARN {path.name}: {exc}')

missing = []
corrupt = []
large = []
small = []
seen = set()
for row in rows:
    asset = row.get('asset', '')
    if not asset.startswith('../'):
        continue
    target = ROOT / 'frontend' / asset.replace('../', '')
    seen.add(str(target))
    if not target.exists():
        missing.append((row.get('kind'), row.get('name'), asset))
        continue
    size = target.stat().st_size
    try:
        with Image.open(target) as image:
            image.verify()
        with Image.open(target) as image:
            width, height = image.size
            mode = image.mode
    except Exception as exc:
        corrupt.append((row.get('name'), asset, str(exc)))
        continue
    if size > 350_000:
        large.append((row.get('name'), asset, size, width, height))
    if width < 320 or height < 240:
        small.append((row.get('name'), asset, width, height))

asset_dirs = [ROOT / 'frontend' / 'assets' / 'menu-items', ROOT / 'frontend' / 'assets' / 'menu-items-corrected', ROOT / 'frontend' / 'assets' / 'menu-items-ai']
all_assets = []
for directory in asset_dirs:
    if directory.exists():
        all_assets.extend([p for p in directory.iterdir() if p.is_file()])

print(f'mapped_rows={len(rows)} mapped_unique_paths={len(seen)}')
print(f'missing={len(missing)} corrupt={len(corrupt)} large_over_350kb={len(large)} small_under_320x240={len(small)}')
print(f'all_asset_files={len(all_assets)} all_asset_bytes={sum(p.stat().st_size for p in all_assets)}')
if missing:
    print('MISSING:')
    for row in missing[:40]: print(row)
if corrupt:
    print('CORRUPT:')
    for row in corrupt[:40]: print(row)
if large:
    print('LARGEST:')
    for row in sorted(large, key=lambda x: x[2], reverse=True)[:20]: print(row)
if small:
    print('SMALL:')
    for row in small[:20]: print(row)
