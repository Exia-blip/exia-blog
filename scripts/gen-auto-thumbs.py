#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成 6 张自动头图（文章没有正文图时轮流使用）。

设计约束：
- 无文字（中文字体不可靠，跨机器渲染会走形），只用符号 + 几何
- 1200×784，接近列表缩略图 208×136 的 1.53:1，同一张也能直接当 og:image
- 每张用不同配色 + 不同符号 + 右上角编号点阵，缩略图尺寸下也能区分
- 同一篇文章永远同一张（由 cover.js 的 id 取模决定），不随浏览变化

用法：python scripts/gen-auto-thumbs.py
输出：public/thumbs/auto-1.jpg … auto-6.jpg
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 784
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'thumbs')

# (光斑主色, 光斑辅色, 符号, 符号色)
# 浅色系：站点默认是 paper 主题（白卡片 + 浅灰底），深色封面会像贴了几块黑胶布。
# 光斑是低饱和的雾，符号才是唯一的高对比元素 —— 缩到 208px 时只剩符号这个形。
PALETTES = [
    ('#93b4f5', '#7dd3e8', '{}', '#2563eb'),
    ('#b39df0', '#f0a6c8', '</>', '#7c3aed'),
    ('#86d3b4', '#6fc8dc', '#', '#059669'),
    ('#f0c07a', '#efa79c', '//', '#d97706'),
    ('#a3a9ee', '#c9a6ea', '[]', '#4f46e5'),
    ('#8fc4e8', '#9aa8bd', '=>', '#0284c7'),
]

BASE_TOP = (246, 248, 253)
BASE_BOTTOM = (235, 240, 250)


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def darken(c, f=0.52):
    """浅底上画线画字要用同色系的深版本，否则什么都看不见"""
    return tuple(int(round(v * f)) for v in c)


def font(size):
    """等宽字体优先；找不到就退回默认位图字体（只是不要崩）"""
    for name in ('consolab.ttf', 'consola.ttf', 'courbd.ttf', 'arialbd.ttf'):
        for root in (os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'),
                     '/usr/share/fonts/truetype/dejavu',
                     '/System/Library/Fonts/Supplemental'):
            p = os.path.join(root, name)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    pass
    return ImageFont.load_default()


def gradient_base():
    img = Image.new('RGB', (W, H), BASE_TOP)
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(BASE_TOP, BASE_BOTTOM, y / (H - 1)))
    return img


def glow(img, cx, cy, radius, color, strength):
    """低成本径向光斑：低分辨率算衰减再放大，天然平滑，不需要大半径高斯"""
    sw, sh = W // 6, H // 6
    small = Image.new('L', (sw, sh), 0)
    px = small.load()
    scx, scy, sr = cx / 6.0, cy / 6.0, radius / 6.0
    for y in range(sh):
        dy = y - scy
        for x in range(sw):
            dx = x - scx
            dd = math.sqrt(dx * dx + dy * dy) / sr
            if dd < 1.0:
                # 平滑的二次衰减，中心不打死
                px[x, y] = int(255 * strength * (1.0 - dd) ** 2.2)
    mask = small.resize((W, H), Image.BICUBIC)
    layer = Image.new('RGB', (W, H), color)
    return Image.composite(layer, img, mask.point(lambda v: int(v * 0.85)))


def grid(img, step=48, alpha=11):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x in range(0, W, step):
        d.line([(x, 0), (x, H)], fill=(60, 78, 110, alpha))
    for y in range(0, H, step):
        d.line([(0, y), (W, y)], fill=(60, 78, 110, alpha))
    out = img.convert('RGBA')
    out.alpha_composite(layer)
    return out.convert('RGB')


def noise(img, amount=4):
    """轻微颗粒，压掉渐变的 banding（JPEG 量化后尤其明显）"""
    import random
    rnd = random.Random(20261108)
    px = img.load()
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            n = rnd.randint(-amount, amount)
            r, g, b = px[x, y]
            px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    return img


def draw_marks(img, idx, c1, c2, symbol, accent):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    m1, m2 = darken(c1, 0.62), darken(c2, 0.40)

    # 左上：短横线 + 端点圆
    d.line([(72, 96), (196, 96)], fill=m1 + (170,), width=3)
    d.ellipse([68, 92, 76, 100], fill=m2 + (235,))
    d.line([(72, 118), (128, 118)], fill=m1 + (80,), width=2)

    # 右上：6 点编号，当前张亮起
    for i in range(len(PALETTES)):
        x = W - 72 - (len(PALETTES) - 1 - i) * 22
        if i == idx - 1:
            d.ellipse([x - 5, 91, x + 5, 101], fill=m2 + (245,))
        else:
            d.ellipse([x - 3, 93, x + 3, 99], fill=(60, 78, 110, 52))

    # 右下：大号符号，压得很淡，缩略图里只剩一个轮廓
    # 字号按字符数收，三字符的 </> 用同尺寸会顶到画布边
    f = font(330 if len(symbol) <= 2 else 250)
    txt = symbol
    bbox = d.textbbox((0, 0), txt, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # 垂直位置按字号算，不按 bbox 高度 —— 等号、中括号这种字形矮，
    # 按 bbox 对齐会让它贴到画布底边，六张看起来高低不一
    tx = max(48, W - 130 - tw - bbox[0])
    ty = H - 108 - int(f.size * 0.74) - bbox[1]
    # 符号是这张图唯一的强对比元素：彩色剪影，不做浮雕（浅底上加白高光只会显脏）
    d.text((tx, ty), txt, font=f, fill=accent + (78,))

    # 左下角：三条等距短线，当作一个抽象的“目录”记号
    for i in range(3):
        w = 84 - i * 22
        d.line([(72, H - 150 + i * 22), (72 + w, H - 150 + i * 22)], fill=(60, 78, 110, 40), width=2)

    # 底部一条渐隐色带，把卡片下沿“压住”
    return Image.alpha_composite(img.convert('RGBA'), layer).convert('RGB')


def vignette(img):
    """四角压暗，让中心光斑更聚焦"""
    sw, sh = W // 8, H // 8
    small = Image.new('L', (sw, sh), 0)
    px = small.load()
    for y in range(sh):
        for x in range(sw):
            nx = (x / (sw - 1)) * 2 - 1
            ny = (y / (sh - 1)) * 2 - 1
            dd = min(1.0, math.sqrt(nx * nx * 0.9 + ny * ny * 1.1))
            px[x, y] = int(86 * (dd ** 2.6))
    mask = small.resize((W, H), Image.BICUBIC)
    dark = Image.new('RGB', (W, H), (205, 213, 228))
    return Image.composite(dark, img, mask)


def build(i):
    c1h, c2h, sym, ach = PALETTES[i - 1]
    c1, c2, accent = hex_rgb(c1h), hex_rgb(c2h), hex_rgb(ach)

    img = gradient_base()
    # 主光斑放在左上偏中，缩略图裁切时也不会丢
    img = glow(img, W * 0.24, H * 0.20, H * 0.72, c1, 0.92)
    img = glow(img, W * 0.86, H * 0.92, H * 0.58, c2, 0.70)
    img = grid(img, 48, 11)
    img = vignette(img)
    img = draw_marks(img, i, c1, c2, sym, accent)
    img = noise(img, 2)
    img = img.filter(ImageFilter.SMOOTH)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f'auto-{i}.jpg')
    img.save(path, 'JPEG', quality=84, optimize=True, progressive=True, subsampling=1)
    return path, os.path.getsize(path)


if __name__ == '__main__':
    total = 0
    for i in range(1, len(PALETTES) + 1):
        p, size = build(i)
        total += size
        print(f'{os.path.basename(p):14s} {size / 1024:6.1f} KB')
    print(f'{"合计":12s} {total / 1024:6.1f} KB')
