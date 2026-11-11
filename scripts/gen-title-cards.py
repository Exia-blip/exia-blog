#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成文章标题卡（分享图）：1200×630 PNG + 216×156 WebP 缩略图。

为什么要有这个：没有手填封面的文章，分享到微信/Telegram/Twitter 只有一张通用
og-default.jpg，别人站上是你的门面，一张通用图等于没有门面。

设计约束（跟站内 auto-N.jpg 一套语言，但更适合放字）：
- 米白纸底 + 一个极淡的色块，靠字撑住画面，不靠花哨
- 标题用衬线（宋体/思源），最多三行，超长自动降字号
- 分类决定强调色，同一栏目的卡片在时间线上是一家人
- 无图依赖、字号/换行全部算出来，同一篇文章重复跑结果一致

用法：python scripts/gen-title-cards.py posts.json
      posts.json = [{"slug","title","category","date"}, ...]
输出：public/cards/<slug>.png 1200×630、public/cards/<slug>.webp 216×156
"""
import json
import os
import re
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1200, 630
THUMB = (216, 156)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'cards')
FONTS = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts')

BG = (250, 249, 247)
INK = (28, 27, 25)
SOFT = (74, 71, 65)
MUTED = (111, 106, 99)

# 分类 → 强调色（与站内 auto 图的配色同一族）
ACCENT = {
    'log': (37, 99, 235),
    'tools': (5, 150, 105),
    'teardown': (124, 58, 237),
    'site': (217, 119, 6),
}
CAT_NAME = {'log': '踩坑记录', 'tools': '小工具', 'teardown': '拆解', 'site': '站点'}


def pick(names, fallback=None):
    for n in names:
        for d in (FONTS, '/usr/share/fonts/truetype', '/System/Library/Fonts'):
            p = os.path.join(d, n)
            if os.path.exists(p):
                return p
    return fallback


# 注意别选 simsunb.ttf：那是 SimSun-ExtB，只有扩展区汉字，常用字全是豆腐块
SERIF = pick(['SourceHanSerifCN-Bold.otf', 'Songti.ttc', 'simsun.ttc', 'SourceHanSansCN-Bold.otf', 'georgia.ttf'])
SANS = pick(['SourceHanSansCN-Regular.otf', 'msyh.ttc', 'Arial.ttf'])
SANS_B = pick(['SourceHanSansCN-Medium.otf', 'msyhbd.ttc', 'Arial Bold.ttf'])
LATIN = pick(['georgia.ttf', 'times.ttf'])


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def wrap(draw, text, f, max_w, max_lines):
    """按像素断行。汉字单字可断，ASCII 单词整体不拆 —— 否则 Turnstile 会被切成 Turnsti/le。"""
    tokens = re.findall(r'[A-Za-z0-9][A-Za-z0-9@._:/#%+\-]*|\s+|.', text)
    lines, cur = [], ''
    for tk in tokens:
        if tk == '\n':
            lines.append(cur)
            cur = ''
            continue
        trial = cur + tk
        if draw.textlength(trial, font=f) > max_w and cur.strip():
            lines.append(cur.rstrip())
            cur = '' if tk.isspace() else tk
            if len(lines) == max_lines:
                break
        else:
            cur = trial
    if len(lines) < max_lines and cur.strip():
        lines.append(cur.rstrip())

    used = sum(len(l) for l in lines)
    if used < len(re.sub(r'\s', '', text)):
        last = lines[-1]
        while last and draw.textlength(last + '…', font=f) > max_w:
            last = last[:-1]
        lines[-1] = last + '…'
    return lines


def render(slug, title, category, date):
    accent = ACCENT.get(category, (37, 99, 235))
    cat = CAT_NAME.get(category, category or '文章')

    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)

    # 右下角一团极淡的色晕，给纯色底一点厚度
    glow = Image.new('RGB', (W, H), BG)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W - 420, H - 380, W + 160, H + 200], fill=tuple(int(BG[i] * 0.82 + accent[i] * 0.18) for i in range(3)))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    img = Image.blend(img, glow, 0.55)
    d = ImageDraw.Draw(img)

    # 顶部一条 6px 的强调色
    d.rectangle([0, 0, W, 6], fill=accent)

    # 左上：分类 + 日期，小号、加字距
    f_meta = font(SANS_B, 24)
    label = f'{cat}'
    x = 84
    d.text((x, 92), label, font=f_meta, fill=accent)
    lw = d.textlength(label, font=f_meta)
    d.text((x + lw + 18, 92), '·', font=f_meta, fill=MUTED)
    d.text((x + lw + 40, 92), date, font=font(SANS, 24), fill=MUTED)

    # 标题：从 76px 往下降到能塞进三行
    max_w, max_lines = W - 168, 3
    for size in (76, 70, 64, 58, 52, 46):
        f = font(SERIF, size)
        lines = wrap(d, title, f, max_w, max_lines)
        if len(lines) <= max_lines and all(d.textlength(l, font=f) <= max_w for l in lines):
            break
    lh = int(size * 1.38)
    total = lh * len(lines)
    y = 330 - total // 2
    for line in lines:
        d.text((84, y), line, font=f, fill=INK)
        y += lh

    # 底部：站名 + 域名，中间一条细线
    d.line([84, H - 110, W - 84, H - 110], fill=(231, 227, 219), width=1)
    d.text((84, H - 88), 'Exia Blog', font=font(SANS_B, 24), fill=SOFT)
    d.text((W - 84 - d.textlength('exia.de5.net', font=font(LATIN, 24)), H - 88), 'exia.de5.net',
           font=font(LATIN, 24), fill=MUTED)

    os.makedirs(OUT, exist_ok=True)
    png = os.path.join(OUT, f'{slug}.png')
    img.save(png, 'PNG', optimize=True)

    # 不再出缩略图：列表卡片走抽象预设图，把分享图塞进 108×78 只会露出半截标题
    return png


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'posts.json'
    with open(src, encoding='utf-8') as f:
        posts = json.load(f)
    total = 0
    for p in posts:
        png = render(p['slug'], p['title'], p.get('category') or '', p.get('date') or '')
        sz = os.path.getsize(png) / 1024
        total += sz
        print(f'  {p["slug"]:34s} {sz:6.1f} KB')
    print(f'\n{len(posts)} 张，PNG 合计 {total:.1f} KB')


if __name__ == '__main__':
    main()
