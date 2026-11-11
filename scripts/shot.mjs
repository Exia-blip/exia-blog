// 视觉回归截图：宽屏 / 窄屏 / 打印三种视图各一张。
// 用法：node scripts/shot.mjs [url] [outDir]
// 依赖本机 Chrome（puppeteer-core 不下载浏览器）。
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'https://exia.de5.net/p/comment-anti-spam';
const out = process.argv[3] || 'shots';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

import { mkdirSync } from 'node:fs';
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

async function shot(name, width, height, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (opts.print) await page.emulateMediaType('print');
  if (opts.mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: !!opts.full });
  console.log(`  ${name}.png  ${width}×${height}${opts.print ? ' (print)' : ''}`);
  await page.close();
}

await shot('post-wide', 1400, 1100);
await shot('post-mobile', 390, 900);
await shot('post-print', 900, 1200, { print: true, full: false });

// 目录高亮：滚到第 4 节，看第 4 项是否点亮
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(url, { waitUntil: 'networkidle2' });
await page.evaluate(() => {
  const h = document.querySelectorAll('.md h2')[3];
  if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 80);
});
await new Promise((r) => setTimeout(r, 700));
const active = await page.$$eval('.post-toc a.on', (as) => as.map((a) => a.textContent.trim()));
console.log(`  目录高亮项：${active.join(' | ') || '（无）'}`);
await page.screenshot({ path: `${out}/post-toc-active.png` });

// hover 锚点：把鼠标移到第二个 h2 上
const box = await page.$eval('.md h2:nth-of-type(2)', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + 12 };
});
await page.mouse.move(box.x, box.y);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${out}/post-anchor-hover.png` });

await browser.close();
