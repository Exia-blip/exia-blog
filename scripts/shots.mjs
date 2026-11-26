// 截图验收：暗色首页卡片层次、文章页底部的上下篇、系列页。
// 用 puppeteer-core 挂本机 Chrome，先写 localStorage 再进页面，强制进暗色。
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const CHROME = resolveChrome();

/* 默认截线上；本地验收用 SHOT_ORIGIN=http://127.0.0.1:8787 node scripts/shots.mjs */
const ORIGIN = process.env.SHOT_ORIGIN || 'https://miu.sryze.cc';
const OUT = 'shots';
fs.mkdirSync(OUT, { recursive: true });

const shots = [
  ['dark-home', '/', { mode: 'dark' }],
  ['light-home', '/', { mode: 'light' }],
  ['dark-post-adjacent', '/p/ci-fixture', { mode: 'dark', bottom: true }],
  ['light-post-adjacent', '/p/ci-fixture', { mode: 'light', bottom: true }],
  ['light-post-top', '/p/ci-fixture', { mode: 'light' }],
  ['dark-series-post', '/p/ci-plain', { mode: 'dark' }],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
});

for (const [name, path, opt] of shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  // 先落到同源页面，才能写 localStorage 影响随后加载的主题
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((mode) => {
    try {
      localStorage.setItem('x_theme', 'paper');
      if (mode) localStorage.setItem('x_mode', mode);
      else localStorage.removeItem('x_mode');
    } catch {}
  }, opt.mode || '');
  await page.goto(ORIGIN + path + '?shot=' + Date.now(), { waitUntil: 'networkidle2' });
  if (opt.bottom) {
    await page.evaluate(() => {
      const el = document.querySelector('.post-adjacent');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 500));
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  /* 灰度版：层级若只靠配色撑着，去色后就会塌；立得住说明靠的是排版。
     只用于验收，不进产物。 */
  await page.evaluate(() => { document.documentElement.style.filter = 'grayscale(1)'; });
  await page.screenshot({ path: file.replace(/\.png$/, '-gray.png') });
  await page.evaluate(() => { document.documentElement.style.filter = ''; });
  const mode = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
  console.log(`${file}  mode=${mode}`);
  await page.close();
}

await browser.close();
