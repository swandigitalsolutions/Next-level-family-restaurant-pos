from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / 'frontend' / 'assets' / 'menu-items-corrected'
OUT = ROOT / 'qa' / 'food-corrected-contact-sheet.jpg'
files = sorted(ASSET_DIR.glob('*'))
thumb_w, thumb_h = 220, 180
cols = 4
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * thumb_w, rows * thumb_h), '#10151b')
font = ImageFont.load_default()
for index, path in enumerate(files):
    try:
        img = Image.open(path).convert('RGB')
        img.thumbnail((thumb_w - 16, thumb_h - 48))
        x = (index % cols) * thumb_w
        y = (index // cols) * thumb_h
        px = x + (thumb_w - img.width) // 2
        py = y + 8
        sheet.paste(img, (px, py))
        draw = ImageDraw.Draw(sheet)
        draw.text((x + 8, thumb_h - 34), path.name[:31], fill='white', font=font)
    except Exception as exc:
        print(path.name, exc)
sheet.save(OUT, quality=88)
print(OUT)
