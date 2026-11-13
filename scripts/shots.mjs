// 截图验收：暗色首页卡片层次、文章页底部的上下篇、系列页。
// 用 puppeteer-core 挂本机 Chrome，先写 localStorage 再进页面，强制进暗色。
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const ORIGIN = 'https://exia.de5.net';
const OUT = 'shots';
fs.mkdirSync(OUT, { recursive: true });

const shots = [
  ['dark-home', '/', { mode: 'dark' }],
  ['light-home', '/', { mode: 'light' }],
  ['dark-post-adjacent', '/p/comment-anti-spam', { mode: 'dark', bottom: true }],
  ['light-post-adjacent', '/p/comment-anti-spam', { mode: 'light', bottom: true }],
  ['light-series', '/series', {}],
  ['dark-series-post', '/p/editor-autosave', { mode: 'dark' }],
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
      localStorage.setItem('x_theme', 'anzhiyu');
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
  const mode = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
  console.log(`${file}  mode=${mode}`);
  await page.close();
}

await browser.close();
