from pathlib import Path
import re
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = ROOT / 'frontend' / 'assets'
OUT_ROOT = ASSET_ROOT / 'optimized'
MAP_FILES = [
    ROOT / 'frontend' / 'js' / 'correct-food-image-map.js',
    ROOT / 'frontend' / 'assets' / 'menu-image-map.js',
]

path_pattern = re.compile(r'\.\./assets/([^\"\']+)')
source_paths = set()
for map_file in MAP_FILES:
    text = map_file.read_text()
    source_paths.update(path_pattern.findall(text))

# Keep shared category and existing helper assets available as optimized fallback targets.
for directory in (ASSET_ROOT, ASSET_ROOT / 'menu-items', ASSET_ROOT / 'menu-items-corrected', ASSET_ROOT / 'menu-items-ai'):
    if directory.exists():
        for path in directory.iterdir():
            if path.is_file() and path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'}:
                source_paths.add(str(path.relative_to(ASSET_ROOT)))

OUT_ROOT.mkdir(parents=True, exist_ok=True)
converted = 0
skipped = 0
before = 0
after = 0
mapping = {}

for rel in sorted(source_paths):
    source = ASSET_ROOT / rel
    if not source.exists():
        skipped += 1
        continue
    target_rel = Path('optimized') / Path(rel).with_suffix('.webp')
    target = ASSET_ROOT / target_rel
    target.parent.mkdir(parents=True, exist_ok=True)
    before += source.stat().st_size
    try:
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode in ('RGBA', 'LA'):
                background = Image.new('RGB', image.size, (248, 246, 241))
                background.paste(image, mask=image.getchannel('A'))
                image = background
            else:
                image = image.convert('RGB')
            image.thumbnail((800, 800), Image.Resampling.LANCZOS)
            image.save(target, 'WEBP', quality=78, method=6)
        after += target.stat().st_size
        converted += 1
        mapping[rel] = str(target_rel).replace('optimized/', '../assets/optimized/')
    except Exception as exc:
        skipped += 1
        print(f'WARN {source}: {exc}')

for map_file in MAP_FILES:
    text = map_file.read_text()
    def replace(match):
        rel = match.group(1)
        return mapping.get(rel, match.group(0))
    map_file.write_text(path_pattern.sub(replace, text))

# Rewrite the generated corrected assignment manifest paths as well, when present.
assignment = ROOT / 'qa' / 'correct-food-image-assignments.json'
if assignment.exists():
    text = assignment.read_text()
    for source_rel, optimized_rel in mapping.items():
        text = text.replace(f'../assets/{source_rel}', optimized_rel)
    assignment.write_text(text)

print(f'converted={converted} skipped={skipped} before_bytes={before} after_bytes={after} reduction={(1-after/before)*100 if before else 0:.1f}%')
print(f'optimized_root={OUT_ROOT}')
