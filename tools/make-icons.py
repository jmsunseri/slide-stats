#!/usr/bin/env python3
"""Draw the Slide Stats mountain icon at the sizes Pebble needs.

The 25x25 file is the launcher menu icon (``menuIcon`` in package.json); the
Pebble tool caps menu icons at 25x25.
The 80x80 and 144x144 files are for the appstore listing.
"""

from pathlib import Path
from PIL import Image, ImageDraw

SUPERSAMPLE = 8
BLACK = (0, 0, 0, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def draw_icon(size):
    scale = size / 32.0
    canvas = size * SUPERSAMPLE
    image = Image.new("RGBA", (canvas, canvas), CLEAR)
    draw = ImageDraw.Draw(image)

    def p(x, y):
        return (x * scale * SUPERSAMPLE, y * scale * SUPERSAMPLE)

    def box(x0, y0, x1, y1):
        a = p(x0, y0)
        b = p(x1, y1)
        return [a[0], a[1], b[0], b[1]]

    # White rounded tile with a heavy black border.
    draw.rounded_rectangle(
        box(1, 1, 31, 31),
        radius=6 * scale * SUPERSAMPLE,
        fill=WHITE,
        outline=BLACK,
        width=max(1, round(2 * scale * SUPERSAMPLE)),
    )

    # Taller left peak, solid black.
    draw.polygon([p(4, 28), p(13, 6), p(22, 28)], fill=BLACK)

    # White snow cap inside the left peak, with a jagged lower edge.
    cap = [
        p(10.2, 17.0),
        p(13, 10),
        p(15.8, 16.7),
        p(15.0, 18.0),
        p(13.7, 15.2),
        p(12.4, 17.8),
        p(11.2, 15.4),
    ]
    draw.polygon(cap, fill=WHITE)

    # Shorter right peak, solid black.
    draw.polygon([p(17, 28), p(24, 12), p(30, 28)], fill=BLACK)

    # White separator where the right peak crosses the left one.
    draw.line(
        [p(24, 12), p(17, 28)],
        fill=WHITE,
        width=max(1, round(1.6 * scale * SUPERSAMPLE)),
    )

    return image.resize((size, size), Image.LANCZOS)


def main():
    root = Path(__file__).resolve().parent.parent
    (root / "resources" / "images").mkdir(parents=True, exist_ok=True)
    (root / "store").mkdir(exist_ok=True)
    (root / "docs" / "images").mkdir(parents=True, exist_ok=True)

    draw_icon(25).save(root / "resources" / "images" / "menu_icon.png")
    draw_icon(80).save(root / "store" / "icon-80.png")
    draw_icon(144).save(root / "store" / "icon-144.png")
    draw_icon(144).save(root / "docs" / "images" / "app-icon.png")


if __name__ == "__main__":
    main()
