/* [P-110] 桌面框架体检：用真计算样式验「导航 / 主区 / 页脚」是不是同一条基线。
 *
 * 为什么不用 CSS 文本断言：三处宽度此前分别是 1180 / 704 / 760，文本里每一个数
 * 都写得清清楚楚，页面看起来仍是「手机版居中」。判据必须落在浏览器算出来的盒子上。
 *
 * 用法（先起本地服务）：
 *   npx wrangler dev --port 8787
 *   node scripts/check-desktop.mjs
 *   AUDIT_ORIGIN=https://miu.sryze.cc node scripts/check-desktop.mjs
 *
 * 判据：
 *   · 1920 / 1440 / 1080：导航内框、主区、页脚内框左右边界一致（±1px）
 *   · 1920 首页：文章卡片两列、单卡 > 480px、右侧栏 300px、横幅两栏并排
 *     （[P-111] 白卡版式：加 300 右栏后单卡从 675 落到 516，门槛随版式重定，
 *      继续守的是「不是 660 窄带」而不是某个具体像素）
 *   · 390 首页：仍单列、页脚竖排、汉堡出现；移动端没被桌面框架带跑
 *   · 1920 文章页：正文仍 660px；三列（目录/正文/右栏），右栏 300px 且不压正文卡
 *     （[P-112] 右栏只在 ≥1600 出现：1280 档可用宽 1236 放不下 232+660+300+两条 40 的缝）
 *   · 1920 归档页：右栏 300px、有内容、贴框架右边界；行内元信息贴右边界
 *     （[P-113] 「右栏在」不等于「右侧不空」：时间线仍两行堆叠时元信息全挤在左边）
 *   · 所有页面：无横向溢出，CSS 真的加载了（--frame 非空）
 */
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const ORIGIN = process.env.AUDIT_ORIGIN || 'http://127.0.0.1:8787';
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu'],
});

async function measure(path, width) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  const u = new URL(path, ORIGIN);
  u.searchParams.set('cb', String(Date.now()));
  await page.goto(u.href, { waitUntil: 'networkidle2', timeout: 30000 });
  const data = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) };
    };
    const cards = [...document.querySelectorAll('.post-card')].slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().width));
    const list = document.querySelector('.post-list');
    return {
      frame: getComputedStyle(document.documentElement).getPropertyValue('--frame').trim(),
      bgToken: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      header: box('header.site .inner'),
      main: box('main'),
      footer: box('.sf-inner'),
      listDisplay: list ? getComputedStyle(list).display : '',
      cols: list ? getComputedStyle(list).gridTemplateColumns.split(/\s+/).filter(Boolean).length : 0,
      cards,
      body: box('.post-body'),
      articleCols: document.querySelector('.post-article')
        ? getComputedStyle(document.querySelector('.post-article')).gridTemplateColumns.split(/\s+/).filter(Boolean).length
        : 0,
      footerDir: document.querySelector('.sf-inner') ? getComputedStyle(document.querySelector('.sf-inner')).flexDirection : '',
      burger: document.querySelector('.nav-toggle') ? getComputedStyle(document.querySelector('.nav-toggle')).display : '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      side: box('.home-side'),
      postSide: box('.post-side'),
      archShell: box('.arch-shell'),
      archRail: box('.arch-rail'),
      archRailKids: document.querySelectorAll('.arch-rail > *').length,
      /* 行内元信息离行右边界多远。两行堆叠的排法下这个值约等于「整行宽 - 标题 - 元信息」，
         实测 700 上下；改成一行排布后应该只剩 .tl-item 的 padding-right（10）。 */
      tlMetaGap: (() => {
        const it = document.querySelector('.tl-item');
        const m = it && it.querySelector('.tl-meta');
        if (!m) return null;
        return Math.round(it.getBoundingClientRect().right - m.getBoundingClientRect().right);
      })(),
      heroMain: box('.hero-main'),
      heroFeature: box('.hero-feature'),
    };
  });
  await page.close();
  return data;
}

const aligned = (d, label) => {
  check(`${label} 三处边界对齐`, !!d.header && !!d.main && !!d.footer
    && Math.abs(d.header.l - d.main.l) <= 1 && Math.abs(d.main.l - d.footer.l) <= 1
    && Math.abs(d.header.r - d.main.r) <= 1 && Math.abs(d.main.r - d.footer.r) <= 1,
  `nav ${d.header?.l}-${d.header?.r} / main ${d.main?.l}-${d.main?.r} / foot ${d.footer?.l}-${d.footer?.r}`);
};

// 文章页路径从首页真实卡片取，不写死编号
const home = await fetch(`${ORIGIN}/`, { headers: { 'user-agent': 'desktop-audit/1.0' } });
const postPath = (await home.text()).match(/href="(\/p\/[^"]+)"/)?.[1] || '/p/1';

for (const width of [1920, 1440, 1080]) {
  const d = await measure('/', width);
  console.log(`\n首页 @${width}px（frame=${d.frame || '未加载'}）`);
  check('CSS 已加载', !!d.bgToken && !!d.frame);
  check('无横向溢出', d.overflow <= 1, `${d.overflow}px`);
  aligned(d, '首页');
  if (width === 1920) {
    check('列表两列', d.listDisplay === 'grid' && d.cols === 2, `${d.listDisplay} / ${d.cols} 列`);
    /* 右栏固定 300 后单卡约 516：判据要求「明显宽于旧的 660 单列」而不是继续
       把 600 当门槛 —— 加侧栏是版式决策，卡片变窄是它的直接结果。 */
    check('单卡宽 > 480px', d.cards[0] > 480, `首卡 ${d.cards[0]}px`);
    check('右侧栏 300px', d.side?.w === 300, `${d.side?.w}px`);
    check('横幅两栏（右卡窄于主卡）', !!d.heroMain && !!d.heroFeature && d.heroMain.w > d.heroFeature.w, `${d.heroMain?.w} / ${d.heroFeature?.w}`);
    check('页脚横向排布', d.footerDir === 'row', d.footerDir);
  }
  if (width === 1080) check('桌面断点已启用', d.frame === '1180px', d.frame);
  if (width === 1440) check('1440 档 frame=1280', d.frame === '1280px', d.frame);
}

const wide = await measure('/', 1920);
check('1920 档 frame=1408', wide.frame === '1408px', wide.frame);

const mobile = await measure('/', 390);
console.log('\n首页 @390px');
check('CSS 已加载', !!mobile.bgToken);
check('无横向溢出', mobile.overflow <= 1, `${mobile.overflow}px`);
check('列表仍单列', mobile.listDisplay !== 'grid' && mobile.cards[0] < 390, `${mobile.listDisplay} / 首卡 ${mobile.cards[0]}px`);
check('页脚竖排', mobile.footerDir === 'column', mobile.footerDir);
check('汉堡可见', mobile.burger !== 'none', mobile.burger);

for (const [name, path] of [['归档', '/archive'], ['栏目', '/categories'], ['文章', postPath]]) {
  const d = await measure(path, 1920);
  console.log(`\n${name} @1920px`);
  check('CSS 已加载', !!d.bgToken);
  check('无横向溢出', d.overflow <= 1, `${d.overflow}px`);
  aligned(d, name);
  if (name === '归档') {
    /* 三件事一起验：右栏在（不是被挤没了）、真的有内容（空 aside 也有 300 宽）、
       右边贴住框架右边界（否则整个 shell 缩在左边，右侧照样空）。 */
    check('右栏 300px', d.archRail?.w === 300, `${d.archRail?.w}px`);
    check('右栏有内容', d.archRailKids >= 2, `${d.archRailKids} 张卡`);
    /* 比的是 .arch-shell 而不是 main：main 的盒子含 .wrap 左右各 22 的内边距，
       拿它当右边界会把 22px 的留白判成「没贴边」。 */
    check('右栏贴 shell 右边界', !!d.archRail && !!d.archShell && Math.abs(d.archRail.r - d.archShell.r) <= 1,
      `栏右 ${d.archRail?.r} / shell 右 ${d.archShell?.r}`);
    /* 只验「右栏存在」会漏掉「时间线还是原来的两行堆叠」——那时右栏也对，右侧仍是空的。
       这条盯的是行内：元信息离行右边界只剩 padding，说明标题那列撑满了整行。 */
    check('行内元信息贴右边界', d.tlMetaGap !== null && d.tlMetaGap <= 12, `差 ${d.tlMetaGap}px`);
  }
  if (name === '文章') {
    check('正文仍 660px', d.body?.w === 660, `${d.body?.w}px`);
    /* 三列 = 目录 / 正文 / 右栏。以前第三列是个空占位（只为把正文拨回中间），
       现在放系列目录与相关文章，判据同时验「列数没塌」和「右栏真的是 300」——
       只看列数的话，第三列缩成 120 也照样绿。 */
    check('三列：目录 / 正文 / 右栏', d.articleCols === 3, `${d.articleCols} 列`);
    check('右栏 300px', d.postSide?.w === 300, `${d.postSide?.w}px`);
    check('右栏不压正文卡', !!d.postSide && !!d.body && d.postSide.l - (d.body.r + 40) >= 0,
      `栏左 ${d.postSide?.l} / 卡右 ${d.body ? d.body.r + 40 : '?'}`);
  }
}

await browser.close();
console.log(fails ? `\n✗ ${fails} 项桌面框架断言失败` : '\n✓ 桌面框架断言全部通过');
process.exit(fails ? 1 : 0);
