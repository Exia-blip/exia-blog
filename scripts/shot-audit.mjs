// 全站美化巡检截图（一次性）：亮/暗 × 桌面/手机 × 关键页面。
// 用法：node scripts/shot-audit.mjs [outDir]
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';
import { mkdirSync } from 'node:fs';

const out = process.argv[3] || 'shots/audit-1122';
const CHROME = resolveChrome();
mkdirSync(out, { recursive: true });

const BASE = 'https://miu.sryze.cc';
const PAGES = [
  ['home', '/'],
  ['post', '/p/theme-transition-class'],
  ['friends', '/friends'],
  ['archive', '/archive'],
  ['cats', '/categories'],
  ['nf', '/no-such-page-xyz'],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

async function shot(name, url, w, h, dark, full) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((d) => {
    localStorage.setItem('x_mode', d ? 'dark' : 'light');
    localStorage.setItem('x_theme', 'paper');
  }, dark);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: !!full });
  console.log(`  ${name}.png`);
  await page.close();
}

for (const [name, path] of PAGES) {
  await shot(`${name}-light`, BASE + path, 1440, 1000, false, false);
  await shot(`${name}-dark`, BASE + path, 1440, 1000, true, false);
  await shot(`${name}-mob`, BASE + path, 390, 844, false, false);
}
await browser.close();
console.log('done -> ' + out);
