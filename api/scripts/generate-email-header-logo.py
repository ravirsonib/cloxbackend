"""Bake an email-safe CLOX header logo: opaque RGB on navy (#0a1f3c).

Root cause: transparent light logos fail in email dark-mode / clients that
restyle header backgrounds. White ink vanishes; only orange marks remain.
"""

from PIL import Image
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FOLDERS = [
    ROOT / 'assets' / 'email',
    ROOT / 'src' / 'assets' / 'email',
]

NAVY_RGB = (10, 31, 60)  # #0a1f3c
PAD_X, PAD_Y = 24, 16
OUT_NAME = 'logo-clox-email-header.png'


def main() -> None:
    src = None
    for folder in FOLDERS:
        candidate = folder / 'logo-clox-light.png'
        if candidate.exists():
            src = candidate
            break
    if src is None:
        raise SystemExit('logo-clox-light.png not found')

    im = Image.open(src).convert('RGBA')
    canvas = Image.new('RGBA', (im.width + PAD_X * 2, im.height + PAD_Y * 2), (*NAVY_RGB, 255))
    canvas.paste(im, (PAD_X, PAD_Y), im)

    # Flatten to opaque RGB — no alpha channel for email clients.
    flat = Image.new('RGB', canvas.size, NAVY_RGB)
    flat.paste(canvas, mask=canvas.split()[-1])

    for folder in FOLDERS:
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / OUT_NAME
        flat.save(dest, 'PNG')
        check = Image.open(dest)
        print(f'wrote {dest} mode={check.mode} size={check.size}')


if __name__ == '__main__':
    main()
