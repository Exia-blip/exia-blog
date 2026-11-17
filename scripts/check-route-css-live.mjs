#!/usr/bin/env node
/* 真浏览器验证 CSS 按路由拆分：不只看 HTML 里有没有 <link>，
   还要确认样式表真的加载、分片规则真的生效、主表规则没丢。
   用法：node scripts/check-route-css-live.mjs [origin] */
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const ORIGIN = (process.argv[2] || 'https://exia.de5.net').replace(/\/$/, '');
const BUST = '?cb=' + Date.now();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};

const EXPECTED = {
  '/': null,
  '/friends': 'friends.css',
  '/archive': 'archive.css',
  '/login': 'login.css',
};

const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu'],
});

for (const [path, slice] of Object.entries(EXPECTED)) {
  const page = await browser.newPage();
  const failedReqs = [];
  page.on('requestfailed', (r) => failedReqs.push(r.url()));
  await page.goto(ORIGIN + path + BUST, { waitUntil: 'networkidle2' });

  const info = await page.evaluate(() => {
    const sheets = [];
    for (const s of document.styleSheets) {
      try { sheets.push(s.href || 'inline'); } catch { sheets.push('?'); }
    }
    return { sheets };
  });

  const cssHrefs = info.sheets.filter((h) => h.includes('/css/') || h.includes('/style.css'));
  const hasMain = cssHrefs.some((h) => h.includes('/style.css'));
  ok(`${path} 主表已加载`, hasMain);
  if (slice) {
    ok(`${path} 分片 ${slice} 已加载`, cssHrefs.some((h) => h.includes('/css/' + slice)));
  } else {
    ok(`${path} 不带任何分片`, !cssHrefs.some((h) => h.includes('/css/')));
  }
  ok(`${path} 零失败请求`, failedReqs.length === 0, failedReqs.slice(0, 2).join(' '));

  await page.close();
}

// 分片规则真的生效：好友链页 .friend-apply 的 padding 来自friends.css
{
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/friends' + BUST, { waitUntil: 'networkidle2' });
  const pad = await page.evaluate(() => {
    const el = document.querySelector('.friend-apply');
    return el ? getComputedStyle(el).padding : null;
  });
  // 有友链数据时节点存在；没有就跳过这条（只验证样式表加载）
  if (pad !== null) ok('friend-apply 分片样式生效', pad === '18px 20px', pad);
  else console.log('  --   friend-apply 无数据，跳过计算样式检查');
  await page.close();
}

await browser.close();
console.log(`\n路由 CSS（浏览器） ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
