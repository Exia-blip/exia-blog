#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成文章标题卡（分享图）：1200×630 PNG，外加全站默认 OG 图 og-default.jpg。

为什么要有这个：别人第一次看见这个站，八成是在群里/时间线上看见那张卡，
而不是看见 660px 的正文列。卡片是唯一对外传播的门面。

设计约束（与 paper 底座同一套语言，2026-11-27 重出）：
- 深墨底 #141518 + 米白字 + 铁锈橙 #a8501f 单一强调色。
  旧版按分类分四色（蓝/紫/绿/琥珀）且带渐变光晕，是另一套配色，站内不存在；
  分类不再是颜色信号，统一成铁锈橙的标签文字，跟站内「一色说多事」的现状对齐。
- 域名从 wrangler.jsonc 的 SITE_ORIGIN 派生，不硬编码。旧版写死 exia.de5.net，
  主域改了以后门面还挂着已 301 掉的旧域 —— 换域只改 SITE_ORIGIN 一处。
- 标题用衬线（宋体/思源），最多三行，超长自动降字号；无外链图、无字体下载，
  同一篇文章重复跑结果一致。

用法：python scripts/gen-title-cards.py posts.json
      posts.json = [{"slug","title","category","date"}, ...]
输出：public/cards/<slug>.png（1200×630）、public/og-default.jpg（1200×630）
"""
import json
import os
import re
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'cards')
FONTS = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts')

# 与 public/style.css 的暗色 --bg / 正文 fg 同色系；强调色取站内 --accent。
BG = (20, 21, 24)        # #141518
INK = (244, 241, 235)    # 标题：米白
SOFT = (198, 193, 184)   # 站名等次要文字
MUTED = (152, 147, 139)  # 日期、域名：深底上仍过 4.5:1
ACCENT = (168, 80, 31)   # #a8501f 铁锈橙，顶部条 / 分类 / 竖线
RULE = (58, 60, 64)      # 底部分隔线

CAT_NAME = {'log': '踩坑记录', 'tools': '小工具', 'teardown': '拆解', 'site': '站点'}


def site_host():
    """主域唯一来源是 wrangler.jsonc 的 SITE_ORIGIN；缺配置时退回仓库里的现行域，
    绝不再写死那个已 301 掉的旧域。"""
    cfg = os.path.join(ROOT, 'wrangler.jsonc')
    try:
        with open(cfg, encoding='utf-8') as f:
            m = re.search(r'"SITE_ORIGIN"\s*:\s*"https?://([^"/]+)', f.read())
        if m:
            return m.group(1)
    except OSError:
        pass
    return 'miu.sryze.cc'


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


def chrome(d, host):
    """三张产物共用的门面框架：顶部橙条 + 底部分隔线与域名。"""
    d.rectangle([0, 0, W, 6], fill=ACCENT)
    d.line([84, H - 110, W - 84, H - 110], fill=RULE, width=1)
    d.text((84, H - 88), 'Exia Blog', font=font(SANS_B, 24), fill=SOFT)
    f_host = font(LATIN, 24)
    d.text((W - 84 - d.textlength(host, font=f_host), H - 88), host, font=f_host, fill=MUTED)


def render(slug, title, category, date, host):
    cat = CAT_NAME.get(category, category or '文章')

    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, host)

    # 左上：分类 + 日期
    f_meta = font(SANS_B, 24)
    x = 104
    d.text((x, 92), cat, font=f_meta, fill=ACCENT)
    lw = d.textlength(cat, font=f_meta)
    d.text((x + lw + 18, 92), '·', font=f_meta, fill=MUTED)
    d.text((x + lw + 40, 92), date, font=font(SANS, 24), fill=MUTED)

    # 标题：左侧一条铁锈橙竖线，跟站内 blockquote 的边框同一种结构信号。
    max_w, max_lines = W - 208, 3
    for size in (76, 70, 64, 58, 52, 46):
        f = font(SERIF, size)
        lines = wrap(d, title, f, max_w, max_lines)
        if len(lines) <= max_lines and all(d.textlength(l, font=f) <= max_w for l in lines):
            break
    lh = int(size * 1.38)
    total = lh * len(lines)
    y = 330 - total // 2
    d.rectangle([84, y + 4, 90, y + total - 8], fill=ACCENT)
    for line in lines:
        d.text((x, y), line, font=f, fill=INK)
        y += lh

    os.makedirs(OUT, exist_ok=True)
    png = os.path.join(OUT, f'{slug}.png')
    img.save(png, 'PNG', optimize=True)
    return png


def render_og_default(host):
    """全站默认分享图（首页 / 系列页 / 无封面兜底）。原来是另一套蓝紫渐变 +
    旧域，跟卡片不是一个门面；现在三产物共用一套配色和同一个域名。"""
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, host)

    d.text((84, 150), '把踩过的坑写成能复用的答案', font=font(SANS, 30), fill=MUTED)
    d.text((80, 214), 'Exia Blog', font=font(SERIF, 108), fill=INK)
    d.rectangle([84, 362, 380, 368], fill=ACCENT)
    d.text((84, 400), '工程实录 · 协议拆解 · 小工具 · 站务', font=font(SANS, 30), fill=SOFT)

    out = os.path.join(ROOT, 'public', 'og-default.jpg')
    # 深底纯色在 4:4:4 下要 38.8K，过不了 26K 预算；4:2:0 只丢橙色细条的色度，
    # 米白文字的亮度细节不受影响，22K 出头且肉眼无差（optimize-assets 的 PSNR 闸门随后复验）。
    img.save(out, 'JPEG', quality=68, optimize=True, progressive=True, subsampling=2)
    return out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'posts.json'
    with open(src, encoding='utf-8') as f:
        posts = json.load(f)
    host = site_host()
    total = 0
    for p in posts:
        png = render(p['slug'], p['title'], p.get('category') or '', p.get('date') or '', host)
        sz = os.path.getsize(png) / 1024
        total += sz
        print(f'  {p["slug"]:34s} {sz:6.1f} KB')
    og = render_og_default(host)
    print(f'\n{len(posts)} 张，PNG 合计 {total:.1f} KB')
    print(f'默认分享图 {os.path.basename(og)} {os.path.getsize(og) / 1024:.1f} KB · 域名 {host}')


if __name__ == '__main__':
    main()
