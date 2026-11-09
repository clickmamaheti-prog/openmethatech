#!/usr/bin/env python3
"""Render a tmux `capture-pane -p -e` file (ANSI SGR colors) to a PNG.

Usage: python3 render-ansi-png.py <capture.txt> <out.png>
Black background, DejaVu Sans Mono, one cell per character so the PNG
is a faithful render of what the terminal showed (ANSI preserved).
"""
import re
import sys

from PIL import Image, ImageDraw, ImageFont

SGR_RE = re.compile(r"\x1b\[([0-9;]*)m")

# tmux/ink 8-color palette (approx. xterm values)
ANSI8 = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
    (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
]
ANSI8_BRIGHT = [
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]


def xterm256(n):
    """xterm 256-color palette: 0-15 standard, 16-231 6x6x6 cube, 232-255 gray."""
    if n < 0 or n > 255:
        return (245, 245, 245)
    if n < 8:
        return ANSI8[n]
    if n < 16:
        return ANSI8_BRIGHT[n - 8]
    if n < 232:
        n -= 16
        r, g, b = (n // 36) % 6, (n // 6) % 6, n % 6
        levels = [0, 95, 135, 175, 215, 255]
        return (levels[r], levels[g], levels[b])
    v = 8 + 10 * (n - 232)
    return (v, v, v)


def parse_line(line):
    """Return a list of (char, fg_rgb, bold, bg_rgb) cells."""
    cells = []
    fg = (245, 245, 245)
    bg = (0, 0, 0)
    bold = False
    pos = 0
    for m in SGR_RE.finditer(line):
        for ch in line[pos:m.start()]:
            cells.append((ch, fg, bold, bg))
        params = [int(p) if p else 0 for p in m.group(1).split(";")] if m.group(1) else [0]
        i = 0
        while i < len(params):
            p = params[i]
            if p == 0:
                fg, bg, bold = (245, 245, 245), (0, 0, 0), False
            elif p == 1:
                bold = True
            elif p == 22:
                bold = False
            elif 30 <= p <= 37:
                fg = ANSI8[p - 30]
            elif 90 <= p <= 97:
                fg = ANSI8_BRIGHT[p - 90]
            elif p == 39:
                fg = (245, 245, 245)
            elif 40 <= p <= 47:
                bg = ANSI8[p - 40]
            elif 100 <= p <= 107:
                bg = ANSI8_BRIGHT[p - 100]
            elif p == 49:
                bg = (0, 0, 0)
            elif p == 38 and i + 2 < len(params) and params[i + 1] == 2:
                fg = tuple(params[i + 2:i + 5])
                i += 5
                continue
            elif p == 48 and i + 2 < len(params) and params[i + 1] == 2:
                bg = tuple(params[i + 2:i + 5])
                i += 5
                continue
            elif p == 38 and i + 2 < len(params) and params[i + 1] == 5:
                fg = xterm256(params[i + 2])
                i += 3
                continue
            elif p == 48 and i + 2 < len(params) and params[i + 1] == 5:
                bg = xterm256(params[i + 2])
                i += 3
                continue
            i += 1
        pos = m.end()
    for ch in line[pos:]:
        cells.append((ch, fg, bold, bg))
    return cells


def main():
    src, out = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8", errors="replace") as f:
        raw_lines = f.read().split("\n")
    # Drop the trailing empty line the capture ends with.
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()
    rows = [parse_line(l) for l in raw_lines]
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 15)
    font_bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 15)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent
    char_w = int(font.getlength("M"))
    ncols = max((len(r) for r in rows), default=0)
    pad = 8
    W = char_w * ncols + pad * 2
    H = line_h * len(rows) + pad * 2
    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(rows):
        for x, (ch, fg, bold, bg) in enumerate(row):
            cx = pad + x * char_w
            cy = pad + y * line_h
            if bg != (0, 0, 0):
                d.rectangle([cx, cy, cx + char_w, cy + line_h], fill=bg)
            if ch != " ":
                d.text((cx, cy), ch, font=font_bold if bold else font, fill=fg)
    img.save(out)
    print("saved", out, img.size)


if __name__ == "__main__":
    main()
