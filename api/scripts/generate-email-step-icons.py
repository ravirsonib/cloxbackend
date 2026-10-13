"""Bake next-step icons onto opaque peach circles for email.

Root cause of off-center icons: clients (esp. after dark-mode restyle) do not
reliably center a small PNG inside a CSS border-radius table cell. Baking the
icon onto a solid circle PNG removes that dependency.
"""

from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICON_DIRS = [
    ROOT / 'assets' / 'email' / 'icons',
    ROOT / 'src' / 'assets' / 'email' / 'icons',
]

PEACH = (255, 241, 232, 255)  # #fff1e8
SIZE = 80
ICON_SIZE = 40


def load_icon(name: str) -> Image.Image:
    for folder in ICON_DIRS:
        path = folder / f'icon-{name}.png'
        if path.exists():
            return Image.open(path).convert('RGBA')
    raise FileNotFoundError(f'icon-{name}.png not found')


def circle_with_icon(name: str) -> Image.Image:
    icon = load_icon(name)
    # Scale icon to ICON_SIZE while preserving aspect
    icon = icon.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)

    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((0, 0, SIZE - 1, SIZE - 1), fill=PEACH)

    x = (SIZE - ICON_SIZE) // 2
    y = (SIZE - ICON_SIZE) // 2
    canvas.paste(icon, (x, y), icon)

    # Flatten to opaque RGB so dark-mode cannot "see through" to invert oddly
    flat = Image.new('RGB', (SIZE, SIZE), (255, 241, 232))
    flat.paste(canvas, mask=canvas.split()[-1])
    return flat


def main() -> None:
    for name in ('document', 'shield', 'bell'):
        img = circle_with_icon(name)
        for folder in ICON_DIRS:
            folder.mkdir(parents=True, exist_ok=True)
            dest = folder / f'icon-{name}-circle.png'
            img.save(dest, 'PNG')
            print(f'wrote {dest} mode={img.mode} size={img.size}')


if __name__ == '__main__':
    main()
