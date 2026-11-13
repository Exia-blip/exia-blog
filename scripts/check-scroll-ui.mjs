// 滚动件的「边界抖动」回归：滞回生效后，在阈值前后微滚不该让按钮闪。
// 这条不测的话，改回单阈值也不会报错 —— 只会有人偶尔觉得「这按钮一闪一闪的」。
//
// 用法：node scripts/check-scroll-ui.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://127.0.0.1:8788/p/blog-markdown-xss';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0;
let fail = 0;
const t = (ok, name, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// 静态壳用版本号做缓存 key，dev 下版本号不变 —— 开着缓存会读到改动前的 HTML，
// 于是「改坏了也显示 ok」
await page.setCacheEnabled(false);
await page.setViewport({ width: 1400, height: 900 });
// HTML 有 5 分钟边缘缓存，本地改完立刻测会读到改动前的壳 —— 加 random 参数绕开
await page.goto(url + (url.includes('?') ? '&' : '?') + '__t=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 700));

/** 在 [lo, hi] 之间来回微滚，数某个元素的 class 变更次数 */
const jiggle = async (selector, lo, hi, rounds = 8) => {
  const found = await page.$(selector);
  if (!found) return null;
  return await page.evaluate(
    async (sel, lo, hi, rounds) => {
      const el = document.querySelector(sel);
      let changes = 0;
      const mo = new MutationObserver((ms) => {
        for (const m of ms) if (m.attributeName === 'class') changes++;
      });
      mo.observe(el, { attributes: true, attributeFilter: ['class'] });
      const step = Math.round((hi - lo) / 4) || 1;
      for (let r = 0; r < rounds; r++) {
        for (let y = lo; y <= hi; y += step) {
          window.scrollTo(0, y);
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        }
        for (let y = hi; y >= lo; y -= step) {
          window.scrollTo(0, y);
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        }
      }
      mo.disconnect();
      return { changes, on: el.classList.contains('on') };
    },
    selector,
    lo,
    hi,
    rounds
  );
};

/* ---------- 回到顶部按钮 ---------- */
// 阈值带 320–400：在这条带里来回滚，按钮状态应当纹丝不动
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 300));
const bt = await jiggle('.back-top', 330, 390, 6);
if (!bt) {
  console.log('  跳过：当前主题没有 .back-top');
} else {
  t(bt.changes === 0, '回到顶部：在 330–390 来回卷 6 轮，class 变更为 0', `实际 ${bt.changes} 次`);
}

// 真滚过 400 要出现，回落到 320 以下要消失
const btState = async (y) => {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await new Promise((r) => setTimeout(r, 260));
  return page.$eval('.back-top', (el) => el.classList.contains('on')).catch(() => null);
};
if (bt) {
  t((await btState(0)) === false, '回到顶部：顶部不显示');
  t((await btState(600)) === true, '回到顶部：滚过 400 显示');
  t((await btState(320)) === true, '回到顶部：退到 321 仍显示（滞回区间内）');
  t((await btState(200)) === false, '回到顶部：退到 200 收起');
}

/* ---------- 移动端目录按钮 ---------- */
// 桌面视口下 .mtoc-btn 是 display:none，但 class 逻辑照样在跑，照样能测抖动
const headEdge = await page.evaluate(() => {
  const h = document.querySelector('.post-head');
  return h ? Math.round(h.offsetTop + h.offsetHeight - 120) : 300;
});
// 要测的抖动是「停在切换点附近微动」。单阈值的切换点就在 edge，
// 所以区间必须压在 edge 两侧（±20）；整段落在 edge 下方或上方，两种实现都不切，
// 那种测法是假的。先把按钮滚成已显示，再回来微动。
await page.evaluate((y) => window.scrollTo(0, y), headEdge + 60);
await new Promise((r) => setTimeout(r, 300));
const lo = Math.max(0, headEdge - 20);
const hi = headEdge + 20;
const mb = await jiggle('.mtoc-btn', lo, hi, 6);
if (!mb) {
  console.log('  跳过：当前页面没有 .mtoc-btn');
} else {
  t(mb.changes === 0, `移动端目录按钮：在切换点 ${lo}–${hi} 来回卷，class 变更为 0`, `实际 ${mb.changes} 次`);
}

await browser.close();
console.log(`\n${pass} 项通过${fail ? `，${fail} 项不符` : ''}`);
process.exit(fail ? 1 : 0);
