// 滚动时动画/过渡被重复触发的实证探针。
// 思路：在捕获阶段挂 animationstart / transitionrun 监听，记录「哪个元素、哪个属性、
// 第几次、滚动到哪个位置」，然后匀速滚一遍再滚回来，把触发次数 >1 的挑出来。
// 这些都是浏览器自己发的事件，不靠肉眼判断「看起来像卡了一下」。
//
// 用法：node scripts/probe-anim.mjs [url] [--touch]
// 依赖本机 Chrome（puppeteer-core 不下载浏览器）。
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'https://exia.de5.net/';
const touch = process.argv.includes('--touch');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: touch ? 390 : 1400, height: touch ? 844 : 900, hasTouch: touch, isMobile: touch });
// 布局次数从 CDP 的 Performance 域取，是浏览器自己数的，不受 JS 干扰
const cdp = await page.target().createCDPSession();
await cdp.send('Performance.enable');
const metrics = async () => {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  const get = (n) => (m.find((x) => x.name === n) || {}).value || 0;
  return { layout: get('LayoutCount'), style: get('RecalcStyleCount'), task: get('TaskDuration') };
};

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));
const before = await metrics();

await page.evaluate(() => {
  window.__anim = [];
  const path = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && out.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += '#' + n.id;
      const c = [...n.classList].slice(0, 2).join('.');
      if (c) s += '.' + c;
      out.unshift(s);
    }
    return out.join(' > ');
  };
  const rec = (kind, name, el) =>
    window.__anim.push({ kind, name, el: path(el), y: Math.round(window.scrollY) });

  document.addEventListener('animationstart', (e) => rec('animation', e.animationName || '', e.target), true);
  // transitionrun 每段过渡只发一次（transitionstart 也是），用它统计「第几次开始」
  document.addEventListener('transitionrun', (e) => rec('transition', e.propertyName || '', e.target), true);

  // 滚动位置也记一份，方便看是不是卡在某个阈值上反复
  window.__ys = [];
  addEventListener('scroll', () => window.__ys.push(Math.round(window.scrollY)), { passive: true });
});

// 匀速滚到底再回来。步长 60px、每步 16ms，接近真人滚轮的节奏
const total = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
const steps = [];
for (let y = 0; y <= total; y += 60) steps.push(y);
for (let y = total; y >= 0; y -= 60) steps.push(y);

await page.evaluate(async (steps) => {
  for (const y of steps) {
    window.scrollTo(0, y);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
}, steps);

await new Promise((r) => setTimeout(r, 500));

const data = await page.evaluate(() => ({ hits: window.__anim, ys: window.__ys }));
const after = await metrics();
await browser.close();

/* ---------- 聚合 ---------- */
const byKey = new Map();
for (const h of data.hits) {
  const key = `${h.kind}:${h.name} @ ${h.el}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(h.y);
}

const repeat = [...byKey.entries()].filter(([, ys]) => ys.length > 1).sort((a, b) => b[1].length - a[1].length);
const once = byKey.size - repeat.length;

console.log(`URL      ${url}`);
console.log(`模式      ${touch ? '触屏 390×844' : '桌面 1400×900'}`);
console.log(`滚动      0 → ${total} → 0，共 ${steps.length} 步，${data.ys.length} 次 scroll 事件`);
console.log(`事件      animationstart + transitionrun 合计 ${data.hits.length} 次，涉及 ${byKey.size} 个目标`);
console.log(`其中      只触发 1 次 ${once} 个，重复触发 ${repeat.length} 个`);
console.log(
  `滚动开销  layout ${before.layout} → ${after.layout}（+${after.layout - before.layout}）` +
    `  style ${before.style} → ${after.style}（+${after.style - before.style}）` +
    `  task ${Math.round((after.task - before.task) * 1000)}ms\n`
);

if (!repeat.length) {
  console.log('没有重复触发。');
} else {
  for (const [key, ys] of repeat) {
    const uniq = [...new Set(ys)];
    console.log(`  ×${ys.length}  ${key}`);
    console.log(`        触发位置 ${ys.join(' → ')}${uniq.length === 1 ? '  ← 全在同一位置，像阈值抖动' : ''}`);
  }
}
