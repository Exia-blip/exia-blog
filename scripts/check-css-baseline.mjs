// computed style 基线守门：CSS 没加载 / 变量被冲掉 / 排版基线塌掉时，页面仍可能返回 200，
// 只有真浏览器量出来的 computed 值能抓到。CI 里由 ci-browser.mjs 起本地 Worker 后调用。
//
// 阈值取实测基线偏低一档：
//   首页 h1 27px、文章页 h1 30px → 守门线 24px（CSS 全挂时回落到浏览器默认 16px，抓得到）
//   body 背景 rgb(24,23,29) alpha=1 → 只断言 alpha=1，不绑具体颜色（亮/暗主题都该不透明）
// 用法：node scripts/check-css-baseline.mjs [base]
import puppeteer from 'puppeteer-core';
import { resolveChrome, CHROME_ARGS } from './chrome.mjs';
import { report } from './pitfall-check.mjs';

const base = (process.argv[2] || 'http://127.0.0.1:8799/').replace(/\/$/, '');
const CHROME = resolveChrome();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: CHROME_ARGS,
});

let fail = 0;
const check = (ok, msg) => {
  if (!report('P-016', msg, ok)) fail++;
};

for (const [label, url] of [
  ['首页', `${base}/`],
  ['文章页', `${base}/p/ci-fixture`],
]) {
  const page = await browser.newPage();
  // 本地 Worker 的 HTML 会命中 LRU（cache:HIT），不加 cache-buster 量到的是上一版模板
  const fresh = new URL(url);
  fresh.searchParams.set('cb', String(Date.now() + Math.random()));
  await page.goto(fresh.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
  const r = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    const h1 = document.querySelector('h1');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const sheets = [...document.styleSheets].filter((s) => (s.href || '').includes('style.css'));
    return {
      bg,
      h1Size: h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0,
      accent,
      sheetCount: sheets.length,
    };
  });
  const alpha = r.bg.startsWith('rgba') ? parseFloat(r.bg.split(',')[3]) : 1;
  console.log(`\n[${label}] ${url}`);
  check(alpha === 1, `body 背景不透明（${r.bg}）`);
  check(r.h1Size >= 24, `h1 字号 ${r.h1Size}px ≥ 24px`);
  check(!!r.accent, `--accent 有值（${r.accent || '空'}）`);
  check(r.sheetCount > 0, `主样式表已加载（${r.sheetCount} 张）`);
  await page.close();
}

await browser.close();
if (fail) {
  console.error(`computed style 基线失败 ${fail} 项`);
  process.exit(1);
}
