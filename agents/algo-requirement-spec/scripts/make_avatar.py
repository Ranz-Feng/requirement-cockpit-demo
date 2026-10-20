#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成专家头像 avatars/expert.png（512x512 PNG，纯几何图形，不含真实素材）。

用法:
  python3 scripts/make_avatar.py
"""

import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.stderr.write("[make_avatar] 需要 Pillow：pip install Pillow\n")
    sys.exit(1)


SIZE = 512
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "avatars", "expert.png")


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def main():
    img = Image.new("RGB", (SIZE, SIZE), (31, 42, 68))
    draw = ImageDraw.Draw(img)

    # 对角渐变背景
    top, bottom = (43, 58, 103), (24, 30, 46)
    for y in range(SIZE):
        draw.line([(0, y), (SIZE, y)], fill=lerp(top, bottom, y / (SIZE - 1)))

    # 文档纸张
    paper = (247, 249, 252)
    px0, py0, px1, py1 = 150, 120, 362, 392
    draw.rounded_rectangle([px0, py0, px1, py1], radius=22, fill=paper)

    # 纸张上的文字行
    line = (176, 186, 204)
    y = py0 + 52
    widths = [150, 118, 134, 96]
    for i, w in enumerate(widths):
        draw.rounded_rectangle([px0 + 30, y, px0 + 30 + w, y + 12], radius=6, fill=line)
        y += 34

    # 顶部标题条（强调色）
    accent = (242, 167, 59)
    draw.rounded_rectangle([px0 + 30, py0 + 24, px0 + 110, py0 + 38], radius=7, fill=accent)

    # 右侧节点图（算法感）
    nodes = [(392, 150, 20), (438, 214, 15), (392, 278, 18), (444, 342, 13)]
    edges = [(0, 1), (1, 2), (2, 3), (0, 2), (1, 3)]
    for a, b in edges:
        draw.line([(nodes[a][0], nodes[a][1]), (nodes[b][0], nodes[b][1])],
                  fill=(120, 176, 224), width=6)
    for i, (cx, cy, r) in enumerate(nodes):
        fill = accent if i % 2 == 0 else (108, 196, 190)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    size = os.path.getsize(OUT)
    print("已生成 %s（%d 字节）" % (OUT, size))
    if size > 500 * 1024:
        sys.stderr.write("[make_avatar] 超过 500KB，需压缩。\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
