// 目录进度条的像素级回归：色条末端是否真的停在当前项的中线上。
// 把 height 动画换成 scaleY 之后，长度由「容器高 × scaleY」决定 ——
// 一旦 CSS 和 JS 对单位的约定不一致（一个要 0–1，一个给百分比），
// 结果不是报错，而是色条悄悄变成 0 或满格，肉眼在浅色主题下很容易漏掉。
//
// 用法：node scripts/check-toc-bar.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://127.0.0.1:8788/p/blog-markdown-xss';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
// HTML 有 5 分钟边缘缓存，改完立刻测会读到旧壳 —— 加 random 参数绕开
await page.goto(url + (url.includes('?') ? '&' : '?') + '__t=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 600));

const sections = await page.$$eval('.post-toc a[data-toc]', (as) => as.map((a) => a.dataset.toc));
if (!sections.length) {
  console.log('页面没有侧栏目录（窄屏或非文章页），跳过');
  await browser.close();
  process.exit(0);
}

let bad = 0;
// 抽查首、中、末三节：两端最容易暴露单位错误
const picks = [0, Math.floor(sections.length / 2), sections.length - 1];

for (const i of picks) {
  const id = sections[i];
  // 滚到该标题上方 200px，让它成为当前节
  await page.evaluate((id) => {
    const h = document.getElementById(id);
    if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 200);
  }, id);
  await new Promise((r) => setTimeout(r, 500));

  const r = await page.evaluate(() => {
    const ol = document.querySelector('.post-toc ol');
    const on = document.querySelector('.post-toc a.on');
    if (!ol || !on) return null;
    const oR = ol.getBoundingClientRect();
    const li = on.closest('li');
    const lR = li.getBoundingClientRect();
    const cs = getComputedStyle(ol, '::before');
    // 布局高固定 100%，长度全靠 transform 的 scaleY。getComputedStyle().height 给的是
    // 没被 transform 影响的布局盒子，直接用它对比会永远是满格 —— 必须乘上矩阵里的 scaleY
    const m = cs.transform;
    const scaleY = m && m.startsWith('matrix') ? parseFloat(m.slice(7).split(',')[3]) : 1;
    const barH = parseFloat(cs.height) * scaleY;
    const want = lR.top + lR.height / 2 - oR.top;
    return { barH, want, olH: oR.height, p: ol.style.getPropertyValue('--toc-p'), label: on.textContent.trim().slice(0, 20) };
  });

  if (!r) {
    console.log(`  第 ${i + 1} 节：读不到目录，跳过`);
    continue;
  }

  // 允许 2px 误差（行高取整）与 0.18s 过渡未走完的余量
  const diff = Math.abs(r.barH - r.want);
  const ok = diff <= 2.5;
  if (!ok) bad++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} 第 ${i + 1} 节《${r.label}》 色条 ${r.barH.toFixed(1)}px / 应为 ${r.want.toFixed(1)}px` +
      `（差 ${diff.toFixed(1)}）  --toc-p=${r.p} 容器 ${r.olH.toFixed(0)}px`
  );
}

// 首节：色条不该是满格或零长
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 500));
const first = await page.evaluate(() => {
  const ol = document.querySelector('.post-toc ol');
  if (!ol) return -1;
  const cs = getComputedStyle(ol, '::before');
  const m = cs.transform;
  const scaleY = m && m.startsWith('matrix') ? parseFloat(m.slice(7).split(',')[3]) : 1;
  return parseFloat(cs.height) * scaleY;
});
const sane = first > 0 && first < 200;
console.log(`  ${sane ? 'ok  ' : 'FAIL'} 首屏色条长度 ${first.toFixed(1)}px（应大于 0 且远小于容器高）`);
if (!sane) bad++;

await browser.close();
console.log(bad ? `\n${bad} 项不符` : '\n全部符合');
process.exit(bad ? 1 : 0);
