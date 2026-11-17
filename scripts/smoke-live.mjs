#!/usr/bin/env node
/* 线上冒烟：在真浏览器里跑一遍新加的埋点与多档图，看有没有把页面弄坏。
 *
 * 这类检查只能靠真浏览器：boot.js 是普通脚本、defer 执行，DOM 查询时机错了
 * 单元测试完全看不出来 —— 它只会在控制台留一行红字，而页面看起来一切正常。
 *
 * 用法：node scripts/smoke-live.mjs [https://exia.de5.net]
 * 退出码非 0 表示有控制台错误或断言不过。
 *
 * 注意：它会真的往线上 events 表写几条（read / search），因为埋点就是打线上的。
 * 跑完想清掉：wrangler d1 execute blog-db --remote --command "DELETE FROM events"
 */
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const ORIGIN = (process.argv[2] || 'https://exia.de5.net').replace(/\/$/, '');
const CHROME = resolveChrome();

let pass = 0;
const fails = [];
const t = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`);
  }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();

  /* 103 Early Hints：CDP 的 responseReceivedEarlyHints 才是真凭证。
     Link 头只能证明「触发条件在」，不能证明 CF 的开关真开了、103 真发了 ——
     这一条曾靠手动抓 CDP 验证，开关一关就会静默退化成普通 preload。 */
  const cdp = await page.createCDPSession();
  const earlyHints = [];
  cdp.on('Network.responseReceivedEarlyHints', (e) => {
    earlyHints.push((e && e.headers && e.headers.link) || '');
  });
  await cdp.send('Network.enable');

  const errors = [];
  const evCalls = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 160)));
  /* 不要开 request interception：sendBeacon 走的是独立通道，被拦截后
     请求根本不会发出（第一次就是这么误判成「埋点没工作」的）。
     守 request 事件就够，虽然拿不到 POST body，但计数足以验「发没发」和「发几次」。 */
  page.on('request', (r) => {
    if (/\/api\/ev$/.test(r.url())) evCalls.push(r.url());
  });

  await page.setViewport({ width: 1280, height: 900 });
  const resp = await page.goto(`${ORIGIN}/p/post-brfy5?smoke=${Date.now()}`, {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });
  t(resp.status() === 200, '文章页能打开', String(resp.status()));

  /* 多档图：浏览器选中的那一档应该是真变体，不是原图回退 */
  const picked = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.post-body img')).map((i) => ({
      src: (i.currentSrc || i.src || '').replace(location.origin, ''),
      w: i.naturalWidth,
    }))
  );
  t(picked.length > 0, '正文有图片', `${picked.length} 张`);
  t(
    picked.some((p) => /\.w(480|800)\.(avif|webp)$/.test(p.src)),
    '浏览器选中的是宽度档（srcset 生效）',
    picked.map((p) => p.src).join(' , ').slice(0, 120)
  );

  /* 滚到底 + 等够 15 秒，read 必须发一次且只发一次 */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 16000));
  t(evCalls.length === 1, '阅读完成事件恰好发一次', `${evCalls.length} 次`);

  /* 再滚一次，确认不会重复发 */
  await page.evaluate(() => window.scrollBy(0, -200));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 1200));
  t(evCalls.length === 1, '重复滚动不会重发', `${evCalls.length} 次`);

  /* 首访可能还没有 Early Hints 缓存（CF 要先见一次主响应才生成 103），
     补打两次再判。带图文章那篇的 103 里应含首图 image preload。 */
  for (let i = 0; i < 2; i++) {
    await page.goto(`${ORIGIN}/p/post-brfy5?eh=${Date.now()}${i}`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await new Promise((r) => setTimeout(r, 400));
  }
  t(earlyHints.length > 0, '浏览器收到 103 Early Hints', `${earlyHints.length} 次`);
  t(
    earlyHints.some((h) => /rel=preload/.test(h) && /as=image/.test(h)),
    '103 里带首图 preload（多档 imagesrcset）',
    earlyHints.find((h) => h.includes('as=image'))?.slice(0, 120) || ''
  );

  t(errors.length === 0, '控制台没有报错', errors.join(' | '));

  /* 首页搜索：输一个词，search 事件要发 */
  const home = await browser.newPage();
  const homeEv = [];
  home.on('request', (r) => {
    if (/\/api\/ev$/.test(r.url())) homeEv.push(r.postData() || '');
  });
  await home.goto(`${ORIGIN}/?smoke=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 45000 });
  await home.type('#q', '缓存');
  await new Promise((r) => setTimeout(r, 2500));
  t(homeEv.length >= 1, '搜索触发上报', `${homeEv.length} 次`);
  /* 同词重复不该重发 */
  const n1 = homeEv.length;
  await home.click('#q', { clickCount: 3 });
  await home.type('#q', '缓存');
  await new Promise((r) => setTimeout(r, 2500));
  t(homeEv.length === n1, '同一个词不重复上报', `${n1} 次`);
} finally {
  await browser.close();
}

console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${pass} 通过，${fails.length} 失败`);
if (fails.length) process.exit(1);
