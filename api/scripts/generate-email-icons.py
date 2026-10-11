"""Generate flat orange email icons with content optically centered on a square canvas.

Root cause of misaligned email icons: uneven transparent padding in the PNG
made stroke art look shifted inside the peach circles. This script draws each
icon, then re-centers the opaque bounding box on a fresh square canvas.
"""

from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FOLDERS = [
    ROOT / 'assets' / 'email' / 'icons',
    ROOT / 'src' / 'assets' / 'email' / 'icons',
]

ORANGE = (241, 90, 36, 255)  # #f15a24
TRANSPARENT = (0, 0, 0, 0)
SIZE = 64
STROKE = 4
# Keep equal inset so every icon occupies the same visual frame after centering.
TARGET_INSET = 8


def content_bbox(img: Image.Image, alpha_threshold: int = 10) -> tuple[int, int, int, int] | None:
    alpha = img.split()[-1]
    bbox = alpha.point(lambda a: 255 if a > alpha_threshold else 0).getbbox()
    return bbox


def center_on_canvas(src: Image.Image, size: int = SIZE, inset: int = TARGET_INSET) -> Image.Image:
    """Crop to ink, scale to fit inset square, paste dead-center on transparent canvas."""
    bbox = content_bbox(src)
    if bbox is None:
        return Image.new('RGBA', (size, size), TRANSPARENT)

    cropped = src.crop(bbox)
    cw, ch = cropped.size
    max_side = size - (inset * 2)
    scale = min(max_side / cw, max_side / ch)
    nw = max(1, round(cw * scale))
    nh = max(1, round(ch * scale))
    resized = cropped.resize((nw, nh), Image.Resampling.LANCZOS)

    canvas = Image.new('RGBA', (size, size), TRANSPARENT)
    x = (size - nw) // 2
    y = (size - nh) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def save(img: Image.Image, name: str) -> None:
    centered = center_on_canvas(img)
    bbox = content_bbox(centered)
    assert bbox is not None
    minx, miny, maxx, maxy = bbox
    pad_l, pad_t = minx, miny
    pad_r, pad_b = SIZE - 1 - maxx, SIZE - 1 - maxy
    print(
        f'{name}: pads LTRB=({pad_l},{pad_t},{pad_r},{pad_b}) '
        f'content={maxx - minx + 1}x{maxy - miny + 1}'
    )
    for folder in FOLDERS:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'{name}.png'
        centered.save(path, 'PNG')
        print('wrote', path)


def new_draw() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new('RGBA', (SIZE, SIZE), TRANSPARENT)
    return img, ImageDraw.Draw(img)


# --- truck ---
img, d = new_draw()
d.rounded_rectangle((6, 18, 34, 40), radius=3, outline=ORANGE, width=STROKE)
d.line([(34, 24), (46, 24), (54, 32), (54, 40), (34, 40), (34, 24)], fill=ORANGE, width=STROKE, joint='curve')
d.ellipse((12, 42, 24, 54), outline=ORANGE, width=STROKE)
d.ellipse((40, 42, 52, 54), outline=ORANGE, width=STROKE)
save(img, 'icon-truck')

# --- building ---
img, d = new_draw()
d.rectangle((12, 10, 40, 54), outline=ORANGE, width=STROKE)
d.rectangle((40, 26, 52, 54), outline=ORANGE, width=STROKE)
for y in (20, 32, 44):
    for x in (18, 28):
        d.rectangle((x, y, x + 6, y + 6), outline=ORANGE, width=3)
d.line([(8, 54), (56, 54)], fill=ORANGE, width=STROKE)
save(img, 'icon-building')

# --- envelope ---
img, d = new_draw()
d.rounded_rectangle((8, 16, 56, 48), radius=4, outline=ORANGE, width=STROKE)
d.line([(8, 20), (32, 36), (56, 20)], fill=ORANGE, width=STROKE, joint='curve')
save(img, 'icon-envelope')

# --- document ---
img, d = new_draw()
d.line([(18, 8), (38, 8), (48, 18), (48, 56), (18, 56), (18, 8)], fill=ORANGE, width=STROKE, joint='curve')
d.line([(38, 8), (38, 18), (48, 18)], fill=ORANGE, width=STROKE, joint='curve')
d.line([(26, 30), (40, 30)], fill=ORANGE, width=STROKE)
d.line([(26, 40), (40, 40)], fill=ORANGE, width=STROKE)
save(img, 'icon-document')

# --- shield with tick ---
img, d = new_draw()
shield = [
    (32, 6),
    (50, 12),
    (52, 28),
    (32, 58),
    (12, 28),
    (14, 12),
    (32, 6),
]
d.line(shield, fill=ORANGE, width=STROKE, joint='curve')
d.line([(22, 30), (29, 38), (43, 22)], fill=ORANGE, width=STROKE, joint='curve')
save(img, 'icon-shield')

# --- bell ---
img, d = new_draw()
d.arc((16, 12, 48, 44), start=200, end=-20, fill=ORANGE, width=STROKE)
d.line([(16, 30), (16, 40), (48, 40), (48, 30)], fill=ORANGE, width=STROKE, joint='curve')
d.line([(12, 40), (52, 40)], fill=ORANGE, width=STROKE)
d.arc((26, 42, 38, 54), start=20, end=160, fill=ORANGE, width=STROKE)
d.line([(32, 6), (32, 14)], fill=ORANGE, width=STROKE)
save(img, 'icon-bell')

print('done')
