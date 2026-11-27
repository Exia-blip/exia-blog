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
 *   · 1920 文章页：正文仍 660px，目录三列布局没被框架改动挤掉
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
  if (name === '文章') {
    check('正文仍 660px', d.body?.w === 660, `${d.body?.w}px`);
    check('目录三列未塌', d.articleCols === 3, `${d.articleCols} 列`);
  }
}

await browser.close();
console.log(fails ? `\n✗ ${fails} 项桌面框架断言失败` : '\n✓ 桌面框架断言全部通过');
process.exit(fails ? 1 : 0);
