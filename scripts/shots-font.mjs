// 字号调整验收：截图 + 量行宽 / 横向溢出
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const BASE = process.env.BASE || 'http://127.0.0.1:8799';
const OUT = process.argv[2] || 'shots/font-after';
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  ['post-1440', '/p/oauth-device-flow', 1440, 900],
  ['home-1440', '/', 1440, 900],
  ['archive-1440', '/archive', 1440, 900],
  ['post-390', '/p/oauth-device-flow', 390, 844],
  ['home-390', '/', 390, 844],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
});

const report = [];
for (const [name, path, w, h] of CASES) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, 0));

  const m = await page.evaluate(() => {
    const body = document.querySelector('.post-body');
    const cs = body ? getComputedStyle(body) : null;
    const de = document.documentElement;
    const cs2 = getComputedStyle(document.body);
    // 全站横向溢出：找出宽度超出视口的元素
    const vw = de.clientWidth;
    const over = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > vw + 1;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} → ${Math.round(el.getBoundingClientRect().right)}`);
    return {
      bodyFont: cs2.fontSize,
      postFont: cs ? cs.fontSize : null,
      postWidth: body ? Math.round(body.getBoundingClientRect().width) : null,
      charsPerLine: body ? Math.round(body.getBoundingClientRect().width / parseFloat(cs.fontSize)) : null,
      scrollW: de.scrollWidth,
      clientW: vw,
      hScroll: de.scrollWidth > vw + 1,
      over,
    };
  });
  report.push({ name, ...m });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  if (name.startsWith('post')) {
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.screenshot({ path: `${OUT}/${name}-body.png` });
  }
  await page.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
