// 顶栏会不会挤成两行：量每个链接的 rect，按 top 聚簇数行 + 查行内高度是否一致。
//
// 两件事分开判，因为它们由不同原因造成、也各自会单独坏：
//   ① 行数 > 1  → flex-wrap 真的折了（宽度不够 / 某项变宽）
//   ② 行内高度不齐 → 某一项的 padding 或 font-size 跟别人不一样（视觉上「胶囊矮一圈」）
// 用 top 的 Set 数行会把 ② 误读成 ①：同一行里垂直居中，高度差 4px 就产生 2px 的 top 差。
// 2026-11-28 整站换风时就撞上过 —— 换风段只写了 `nav.top a`，选中项被基线里特异度更高的
// `.active` 规则按 6px 11px 排，比旁边矮 4px，于是 8 个宽度全报「换行」，而页面上完全没有换行。
// 所以 top 聚簇容差 4px（真换行相差约一个行高 41px，不会被吞），高度单独判。
// 用法：node scripts/check-nav.mjs [url]
// [P-114] 那次红是 padding 特异度不够 + 判据把 2px 当换行，不是导航真折行。
import puppeteer from 'puppeteer-core';
import { resolveChrome, CHROME_ARGS } from './chrome.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8799/';
const CHROME = resolveChrome();
const widths = [660, 700, 760, 820, 900, 1024, 1280, 1440];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: CHROME_ARGS });
const page = await browser.newPage();
let bad = 0;

for (const w of widths) {
  await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const r = await page.evaluate(() => {
    const nav = document.querySelector('nav.top');
    const header = document.querySelector('header.site');
    const links = [...nav.querySelectorAll('a')].filter((a) => !a.closest('#nav-user'));
    const boxes = links.map((a) => {
      const b = a.getBoundingClientRect();
      return { top: b.top, h: b.height };
    });
    // 聚簇：与当前簇的首值差 ≤ TOL 视为同一行
    const TOL = 4;
    const rowTops = [];
    for (const t of boxes.map((b) => b.top).sort((x, y) => x - y)) {
      if (!rowTops.length || t - rowTops[rowTops.length - 1] > TOL) rowTops.push(t);
    }
    const hs = boxes.map((b) => b.h);
    const hSpread = hs.length ? Math.round(Math.max(...hs) - Math.min(...hs)) : 0;
    const drawer = getComputedStyle(nav).position === 'fixed';
    return {
      headerH: Math.round(header.getBoundingClientRect().height),
      rows: rowTops.length,
      hSpread,
      count: links.length,
      drawer,
      overX: document.documentElement.scrollWidth > window.innerWidth,
      navRight: Math.round(nav.getBoundingClientRect().right),
      vw: window.innerWidth,
    };
  });
  // 抽屉模式下链接是纵向排列，"多行"是正常的，只看有没有横向溢出与高度是否齐
  const wrap = !r.drawer && r.rows > 1;
  const uneven = !r.drawer && r.hSpread > 1;
  if (wrap || uneven || r.overX) bad++;
  console.log(
    `  ${String(w).padStart(4)}px  头高 ${String(r.headerH).padStart(3)}  链接 ${r.count}  行数 ${r.rows}` +
      `  高度差 ${r.hSpread}  抽屉 ${r.drawer ? '是' : '否'}  横向溢出 ${r.overX ? '有' : '无'}` +
      `${wrap ? '  ← 换行' : ''}${uneven ? '  ← 高度不齐' : ''}`
  );
}

await browser.close();
if (bad) {
  console.log(`\n${bad} 个宽度有问题`);
  process.exitCode = 1;
} else {
  console.log('\n所有宽度单行排列，无横向溢出');
}
