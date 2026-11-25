"""Keep README screenshots under 400 KB: posterise larger PNGs (fewer levels per channel).

Posterising keeps hues exact to within a few levels, so class colours in the UI stay true;
a 256-colour palette shifted them visibly. Only photos and noisy canvases need it.

Usage: python scripts/shrink_png.py docs/images
"""

import sys
from pathlib import Path

from PIL import Image, ImageOps

LIMIT = 400 * 1024


def shrink(path: Path) -> None:
    before = path.stat().st_size
    if before <= LIMIT:
        return
    img = Image.open(path).convert("RGB")
    for bits in (6, 5, 4, 3):
        ImageOps.posterize(img, bits).save(path, optimize=True)
        if path.stat().st_size <= LIMIT:
            break
    print(f"{path.name}: {before} -> {path.stat().st_size} bytes")


def main() -> None:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/images")
    for p in sorted(folder.glob("*.png")):
        shrink(p)
    big = [p.name for p in folder.glob("*.png") if p.stat().st_size > LIMIT]
    if big:
        sys.exit(f"still over 400 KB: {', '.join(big)}")


if __name__ == "__main__":
    main()
