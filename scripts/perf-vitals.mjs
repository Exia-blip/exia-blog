#!/usr/bin/env node
/**
 * Core Web Vitals 实测：LCP / CLS / INP / 阻塞资源。
 *
 * 与 perf-audit.mjs 的区别：那个走 CDP 抓网络瀑布，这个直接读浏览器里的
 * PerformanceObserver 数据 —— LCP 是渲染管线给的，CLS 是布局引擎给的，
 * 自己按时间戳反推永远差一点。
 *
 * 用法：
 *   node scripts/perf-vitals.mjs https://exia.de5.net/            # 桌面
 *   node scripts/perf-vitals.mjs https://exia.de5.net/ --mobile   # 移动 4G + 4x CPU
 *   node scripts/perf-vitals.mjs https://exia.de5.net/ --json
 */
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const URL_ARG = process.argv[2] || 'https://exia.de5.net/';
const MOBILE = process.argv.includes('--mobile');
const AS_JSON = process.argv.includes('--json');
const RUNS = Number((process.argv.find((a) => a.startsWith('--runs=')) || '').split('=')[1]) || 1;

const CHROME = resolveChrome();

/* 采集器在文档创建前注入：LCP/CLS 都是「持续观察」型指标，
   页面都 load 完了才挂 observer，前面那几次 shift 就永远抓不到。 */
const COLLECTOR = () => {
  window.__v = { lcp: 0, lcpEl: '', lcpUrl: '', cls: 0, shifts: [], lcpCands: [] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__v.lcp = e.startTime;
        window.__v.lcpEl = e.element ? e.element.tagName.toLowerCase() : '';
        window.__v.lcpUrl = e.url || '';
        window.__v.lcpCands.push({
          t: Math.round(e.startTime),
          size: e.size,
          el: e.element ? e.element.tagName.toLowerCase() + (e.element.className ? '.' + String(e.element.className).split(' ')[0] : '') : '',
          url: (e.url || '').slice(0, 80),
        });
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__v.cls += e.value;
        window.__v.shifts.push({
          v: +e.value.toFixed(4),
          t: Math.round(e.startTime),
          src: (e.sources || []).map((s) => (s.node ? (s.node.tagName || '').toLowerCase() + (s.node.className ? '.' + String(s.node.className).split(' ')[0] : '') : '?')),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  // 长任务：INP 高的时候基本都能在这里看到元凶
  window.__v.longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__v.longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  /* 交互延迟：Event Timing 默认 durationThreshold=104ms，
     低于这个值的事件根本不进 buffer —— 也就意味着「INP 很好」和
     「一个事件都没采到」在数据上长得一模一样。降到 16ms 才能看见全部。 */
  window.__v.events = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.interactionId) continue;
        window.__v.events.push({ name: e.name, d: Math.round(e.duration), t: Math.round(e.startTime), iid: e.interactionId });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch {}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(browser) {
  const page = await browser.newPage();
  await page.setViewport(MOBILE ? { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
  await page.setUserAgent(
    MOBILE
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.evaluateOnNewDocument(COLLECTOR);

  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  if (MOBILE) {
    // 4G：1.6Mbps 下行 / 750Kbps 上行 / 150ms RTT（Lighthouse 的 mobileSlow4G）
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }

  const reqs = [];
  page.on('request', (r) => {
    reqs.push({ url: r.url(), type: r.resourceType(), method: r.method() });
  });
  const bytes = new Map(); // requestId -> encodedDataLength
  cdp.on('Network.loadingFinished', (e) => bytes.set(e.requestId, e.encodedDataLength || 0));
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.redirectResponse) bytes.set('redirect:' + e.request.url, e.redirectResponse.encodedDataLength || 0);
  });

  const t0 = Date.now();
  const resp = await page.goto(URL_ARG, { waitUntil: 'networkidle2', timeout: 60000 });
  const navStatus = resp ? resp.status() : 0;

  // 等 LCP 稳定：加载完成后 LCP 还会被「推迟渲染」的图改写
  await sleep(2500);

  // 先定版 LCP/CLS —— 交互会改主题，别把「点出来的」算进 CLS
  const pre = await page.evaluate(() => ({ v: window.__v }));
  const settled = { lcp: pre.v.lcp, cls: pre.v.cls, shifts: pre.v.shifts, cands: pre.v.lcpCands, longTasks: pre.v.longTasks };

  /* INP：点真按钮。Event Timing 只统计「真输入 + 被处理」的事件，
     脚本 dispatchEvent 造的不算，必须走 CDP。优先点主题按钮这类
     纯前端交互（不导航），退化才点空白。 */
  const spot = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    return pick('.theme-btn') || pick('.nav-toggle') || pick('a.pick') || { x: innerWidth / 2, y: innerHeight * 0.4 };
  });
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    await sleep(150);
  }
  if (MOBILE) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot.x, y: spot.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(150);
  }
  // 键盘：Tab 聚焦后再 Enter，覆盖「输入延迟」那一档
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(200);

  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
    const events = (window.__v.events || [])
      .filter((e) => e.iid)
      .map((e) => ({ name: e.name, d: e.d, t: e.t, iid: e.iid }));
    // INP ≈ 按 interactionId 分组后取最长的那次交互的时长
    const byIid = new Map();
    for (const e of events) {
      const cur = byIid.get(e.iid) || { d: 0, name: e.name, t: e.t };
      if (e.d > cur.d) byIid.set(e.iid, { d: e.d, name: e.name, t: e.t });
      else byIid.set(e.iid, cur);
    }
    const interactions = [...byIid.values()].sort((a, b) => b.d - a.d);
    return {
      paints,
      nav: {
        ttfb: Math.round(nav.responseStart || 0),
        dcl: Math.round(nav.domContentLoadedEventEnd || 0),
        load: Math.round(nav.loadEventEnd || 0),
        transfer: nav.transferSize || 0,
        encoded: nav.encodedBodySize || 0,
      },
      interactions,
      resources: performance.getEntriesByType('resource').map((r) => ({
        url: r.name,
        type: r.initiatorType,
        start: Math.round(r.startTime),
        dur: Math.round(r.duration),
        size: r.transferSize || 0,
        renderBlocking: r.renderBlockingStatus || '',
      })),
    };
  });

  // 阻塞脚本要回到 HTML 里看：PerformanceResourceTiming 分不出 defer/async
  const rawHtml = await page.content();
  /* 先剥掉 <script> 的内容再扫 <link>：主题那段是 document.write 拼出来的，
     源码里有一句 href="/theme/'+t+'.css"，直接扫会匹配出一个不存在的 /theme/。
     实测报告里挂着这条，看着像坏链，其实页面根本没发这个请求。 */
  const htmlNoScript = rawHtml.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const blockingScripts = [...rawHtml.matchAll(/<script\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => /\bsrc=/.test(t) && !/\b(defer\b|\basync\b)/i.test(t) && !/type=["']module["']/i.test(t))
    .map((t) => (t.match(/src=["']([^"']+)/) || [])[1]);

  const headBlockingCss = [...htmlNoScript.matchAll(/<link\b([^>]*rel=["']stylesheet["'][^>]*)>/gi)]
    .map((m) => m[1])
    .filter((a) => !/media=["']print/.test(a))
    .map((a) => (a.match(/href=["']([^"']+)/) || [])[1]);

  await page.close();

  const origin = new URL(URL_ARG).origin;
  const third = reqs.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const thirdDomains = [...new Set(third.map((r) => new URL(r.url).hostname))];

  return {
    url: URL_ARG,
    mobile: MOBILE,
    navStatus,
    wallMs: Date.now() - t0,
    lcp: Math.round(settled.lcp),
    lcpEl: settled.cands.length ? settled.cands[settled.cands.length - 1].el : '',
    lcpUrl: settled.cands.length ? settled.cands[settled.cands.length - 1].url : '',
    lcpCands: settled.cands.slice(-5),
    cls: +settled.cls.toFixed(4),
    shifts: settled.shifts,
    inp: data.interactions[0] ? data.interactions[0].d : null,
    interactions: data.interactions.slice(0, 5),
    longTasks: settled.longTasks.slice(0, 8),
    ttfb: data.nav.ttfb,
    dcl: data.nav.dcl,
    load: data.nav.load,
    requests: reqs.length,
    transferKB: Math.round([...bytes.values()].reduce((a, b) => a + b, 0) / 1024),
    blockingScripts,
    headBlockingCss,
    thirdDomains,
    thirdReqs: third.map((r) => r.url.slice(0, 100)),
  };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const out = [];
for (let i = 0; i < RUNS; i++) out.push(await runOnce(browser));
await browser.close();

const best = out.sort((a, b) => a.lcp - b.lcp)[0];

function grade(metric, v) {
  const t = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500] }[metric];
  if (v == null) return 'n/a';
  return v <= t[0] ? 'good' : v <= t[1] ? 'needs-improvement' : 'poor';
}

if (AS_JSON) {
  console.log(JSON.stringify(out.length === 1 ? out[0] : { runs: out, best }, null, 2));
} else {
  const r = best;
  console.log(`\n${r.url}  ${r.mobile ? '[mobile 4G + 4x CPU]' : '[desktop]'}  HTTP ${r.navStatus}  ${r.requests} reqs / ${r.transferKB} KB\n`);
  console.log(`  LCP  ${String(r.lcp).padStart(6)} ms  ${grade('lcp', r.lcp).padEnd(18)} ${r.lcpEl}${r.lcpUrl ? ' ' + r.lcpUrl.slice(0, 60) : ''}`);
  console.log(`  CLS  ${String(r.cls).padStart(6)}     ${grade('cls', r.cls).padEnd(18)} ${r.shifts.length} 次偏移`);
  console.log(`  INP  ${String(r.inp ?? '-').padStart(6)} ms  ${grade('inp', r.inp).padEnd(18)} ${r.interactions[0] ? r.interactions[0].name : '无交互'}`);
  console.log(`  TTFB ${String(r.ttfb).padStart(6)} ms | DCL ${r.dcl} ms | load ${r.load} ms`);
  if (r.shifts.length) {
    console.log('\n  偏移明细：');
    for (const s of r.shifts.slice(0, 10)) console.log(`    +${s.v}  @${s.t}ms  ${s.src.join(',')}`);
  }
  if (r.lcpCands.length) {
    console.log('\n  LCP 候选：');
    for (const c of r.lcpCands) console.log(`    ${String(c.t).padStart(6)}ms  size=${c.size}  ${c.el}  ${c.url}`);
  }
  console.log(`\n  阻塞脚本（无 defer/async）: ${r.blockingScripts.length ? r.blockingScripts.join(', ') : '无'}`);
  console.log(`  首屏 CSS: ${r.headBlockingCss.length ? r.headBlockingCss.join(', ') : '无'}`);
  console.log(`  第三方域: ${r.thirdDomains.length ? r.thirdDomains.join(', ') : '无'}`);
  if (r.thirdReqs.length) for (const u of r.thirdReqs) console.log(`    · ${u}`);
  if (r.longTasks.length) {
    console.log('\n  长任务：');
    for (const t of r.longTasks) console.log(`    ${String(t.d).padStart(5)}ms @${t.t}ms`);
  }
  console.log('');
}
