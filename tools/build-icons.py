#!/usr/bin/env python3
"""Sinh bộ icon TuiRead từ logo gốc người dùng cấp: icons/tuiread_logo.png.

Chạy: python3 tools/build-icons.py   (cần Pillow — có sẵn trên máy này, KHÔNG phải
dependency của extension; Chrome chỉ đọc các file .png kết quả).

Logo gốc là ô vuông bo góc bóng nằm trên nền đá xám xanh. Script tách nền đá bằng
flood-fill từ biên theo hue (đá ~195-235 độ và tối), giữ nguyên ô logo kể cả tóc và
mặt (hue ấm / teal nên không lẫn vào đá), bỏ đốm đá sót ngoài ô, crop sát bbox rồi
hạ mẫu LANCZOS xuống 16/32/48/128/256. Kích thước <=48 tăng nét nhẹ để hình không
bị mềm nhòe trong toolbar.
"""

import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SIZES = (16, 32, 48, 128, 256)


def stone_maps(im):
    """hue (độ / 1.5) và value dạng bytearray để flood-fill không phải tính lại màu."""
    w, h = im.size
    px = im.load()
    hue = bytearray(w * h)
    val = bytearray(w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            r, g, b = px[x, y]
            mx = max(r, g, b)
            mn = min(r, g, b)
            val[base + x] = mx
            if mx == mn:
                continue
            d = mx - mn
            if mx == r:
                hh = ((g - b) / d) % 6
            elif mx == g:
                hh = (b - r) / d + 2
            else:
                hh = (r - g) / d + 4
            hue[base + x] = int(hh * 40)
    return hue, val


def cut_tile(im):
    """Bỏ nền đá quanh ô logo; ngoài góc bo của ô trở thành trong suốt."""
    w, h = im.size
    hue, val = stone_maps(im)

    def is_stone(x, y):
        i = y * w + x
        return 130 <= hue[i] <= 157 and val[i] < 135

    bg = bytearray(w * h)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_stone(x, y) and not bg[y * w + x]:
                bg[y * w + x] = 1
                dq.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_stone(x, y) and not bg[y * w + x]:
                bg[y * w + x] = 1
                dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and is_stone(nx, ny):
                bg[ny * w + nx] = 1
                dq.append((nx, ny))

    # Đốm đá sáng sót ngoài ô: thành phần opaque nhỏ hơn 1500px thì bỏ.
    seen = bytearray(w * h)
    drop = []
    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if bg[i] or seen[i]:
                continue
            comp = []
            dq = deque([(sx, sy)])
            seen[i] = 1
            while dq:
                x, y = dq.popleft()
                comp.append((x, y))
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not bg[j] and not seen[j]:
                            seen[j] = 1
                            dq.append((nx, ny))
            if len(comp) < 1500:
                drop.extend(comp)

    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    for y in range(h):
        base = y * w
        for x in range(w):
            if bg[base + x]:
                mp[x, y] = 0
    for x, y in drop:
        mp[x, y] = 0
    tile = im.convert("RGBA")
    tile.putalpha(mask)
    return tile.crop(mask.getbbox())


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT / "tuiread_logo.png"
    if not src.exists():
        sys.exit(f"Khong thay logo goc: {src}")
    tile = cut_tile(Image.open(src).convert("RGB"))
    print(f"logo goc {src.name} -> tach nen, crop con {tile.size[0]}x{tile.size[1]}")
    for s in SIZES:
        icon = tile.resize((s, s), Image.LANCZOS)
        if s <= 48:
            icon = icon.filter(ImageFilter.UnsharpMask(radius=1, percent=60, threshold=2))
        p = OUT / f"icon{s}.png"
        icon.save(p, optimize=True)
        print(f"  {p.relative_to(ROOT)}  {p.stat().st_size} byte")


if __name__ == "__main__":
    main()