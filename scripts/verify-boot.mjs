// 验证两件新东西真的在浏览器里跑起来：
// 1. 站内点击后顶部出现进度条，落地后收尾
// 2. 页面 load 之后发一次 /api/pv
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const BASE = process.env.BASE || 'http://127.0.0.1:8799';

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 800 });

const pv = [];
p.on('request', (r) => {
  if (r.url().includes('/api/pv')) pv.push(r.method());
});

await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 2600));
const afterHome = pv.length;

// 点第一个站内文章链接：进度条应该在跳转前就插进 DOM
const href = await p.evaluate(() => {
  const a = [...document.querySelectorAll('a[href^="/p/"]')][0];
  return a ? a.getAttribute('href') : null;
});
if (!href) throw new Error('首页没有文章链接');

/* 本地导航只要几十毫秒，进度条还没看见就落地了。
   这里把目标文档的响应拖住 600ms，模拟真实网络下那段「点了没反应」的空窗。 */
await p.setRequestInterception(true);
p.on('request', (req) => {
  if (req.isNavigationRequest() && req.url().includes('/p/')) {
    setTimeout(() => req.continue().catch(() => {}), 600);
  } else {
    req.continue().catch(() => {});
  }
});

// 点下去就会开始导航，执行上下文随即销毁，进度条也就没法在这里看了。
// 挂一个冒泡阶段的 preventDefault：boot.js 在捕获阶段先跑（进度条已插入），
// 之后默认行为被拦下，页面留在原地，才有机会拍照取证。
await p.evaluate(() => {
  document.addEventListener('click', (e) => e.preventDefault(), false);
});
await p.evaluate((h) => {
  document.querySelector(`a[href="${h}"]`).click();
}, href);
await new Promise((r) => setTimeout(r, 260));
const barDuring = await p.evaluate(() => {
  const el = document.querySelector('.nav-prog');
  return el ? { opacity: el.style.opacity, transform: el.style.transform } : null;
});

await p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
const barAfter = await p.evaluate(() => !!document.querySelector('.nav-prog'));

console.log(
  JSON.stringify(
    {
      首页上报次数: afterHome,
      点击后总数: pv.length,
      跳转中进度条: barDuring,
      落地后进度条已收: !barAfter,
      当前页: p.url().replace(BASE, ''),
    },
    null,
    1
  )
);

await b.close();
