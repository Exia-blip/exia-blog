#!/usr/bin/env node
/**
 * 页面性能审计：一个 URL 打一次，报告
 *   - 请求数 / 传输字节 / 各类型分布
 *   - TTFB、DOMContentLoaded、Load
 *   - LCP 元素与耗时、CLS
 *   - 第三方（非本站）请求
 *
 * 用法：
 *   node scripts/perf-audit.mjs https://exia.de5.net/ [--mobile] [--cold] [--json]
 * 前提：已有可调试 Chrome 在 9333 端口（npm run chrome:debug 或手动起）
 */
import { writeFileSync } from 'node:fs';

const CDP_PORT = process.env.CDP_PORT || 9333;
const target = process.argv[2] || 'https://exia.de5.net/';
const mobile = process.argv.includes('--mobile');
const asJson = process.argv.includes('--json');

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error(`没有可用的 page target（端口 ${CDP_PORT}）`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const waiting = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
  handlers.forEach((h) => h(msg));
});
const handlers = [];

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const reqs = new Map(); // requestId -> {url, type, bytes, enc, status}
handlers.push((msg) => {
  if (msg.method === 'Network.requestWillBeSent') {
    reqs.set(msg.params.requestId, {
      url: msg.params.request.url,
      type: msg.params.type || 'Other',
      bytes: 0,
      status: 0,
      enc: '',
      mime: '',
    });
  } else if (msg.method === 'Network.responseReceived') {
    const r = reqs.get(msg.params.requestId);
    if (r) {
      r.status = msg.params.response.status;
      r.mime = String(msg.params.response.mimeType || '');
      r.enc = msg.params.response.headers['content-encoding'] || '';
      if (msg.params.response.fromDiskCache) r.fromCache = true;
    }
  } else if (msg.method === 'Network.loadingFinished') {
    const r = reqs.get(msg.params.requestId);
    if (r) r.bytes = msg.params.encodedDataLength || 0;
  } else if (msg.method === 'Network.loadingFailed') {
    const r = reqs.get(msg.params.requestId);
    if (r) {
      r.failed = msg.params.blockedReason || msg.params.errorText || 'failed';
      r.bytes = 0;
    }
  }
});

await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: false });
// --cold：清掉浏览器缓存，测“第一次访问”的真实字节数（不清的话 CSS/JS/图全是 0 字节命中）
if (process.argv.includes('--cold')) await send('Network.clearBrowserCache');
await send('Emulation.setDeviceMetricsOverride',
  mobile
    ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
    : { width: 1366, height: 900, deviceScaleFactor: 2, mobile: false });

await send('Page.navigate', { url: target });
await new Promise((r) => setTimeout(r, 4500));

const metricsExpr = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const lcp = (window.__lcp || []);
  return JSON.stringify({
    ttfb: Math.round(nav.responseStart || 0),
    domReady: Math.round(nav.domContentLoadedEventEnd || 0),
    load: Math.round(nav.loadEventEnd || 0),
    transferSize: nav.transferSize || 0,
    decoded: nav.decodedBodySize || 0,
    resources: res.length,
    lcpEl: lcp.length ? (lcp[lcp.length-1].element || '').slice(0, 120) : '',
    lcpTime: lcp.length ? Math.round(lcp[lcp.length-1].startTime) : 0,
    cls: window.__cls || 0,
    scripts: [...document.scripts].map(s => s.src || '(inline)')
  });
})()`;

// 先挂观察器再取——用 PerformanceObserver 抓 LCP/CLS
await send('Runtime.evaluate', {
  expression: `new Promise((done) => {
    window.__lcp = []; window.__cls = 0;
    try {
      new PerformanceObserver((l) => { l.getEntries().forEach(e => window.__lcp.push({element: e.element ? (e.element.tagName + (e.element.className ? '.' + e.element.className : '') + ' ' + (e.url || '')) : (e.url || ''), startTime: e.startTime})) }).observe({type: 'largest-contentful-paint', buffered: true});
      new PerformanceObserver((l) => { l.getEntries().forEach(e => { if (!e.hadRecentInput) window.__cls += e.value }) }).observe({type: 'layout-shift', buffered: true});
    } catch (e) {}
    setTimeout(done, 50);
  })`,
  awaitPromise: true,
});
await new Promise((r) => setTimeout(r, 1200));

const raw = await send('Runtime.evaluate', { expression: metricsExpr, returnByValue: true });
const m = JSON.parse(raw.result.value);

const host = new URL(target).host;
const all = [...reqs.values()].filter((r) => r.url.startsWith('http'));
const third = all.filter((r) => { try { return new URL(r.url).host !== host; } catch { return false; } });
const kb = (n) => +(n / 1024).toFixed(1);
const sum = (arr) => arr.reduce((a, b) => a + b.bytes, 0);

const byType = {};
for (const r of all) {
  const t = r.type || 'Other';
  byType[t] = byType[t] || { n: 0, bytes: 0 };
  byType[t].n++;
  byType[t].bytes += r.bytes;
}

const report = {
  url: target,
  mode: mobile ? 'mobile 390x844@3' : 'desktop 1366x900@2',
  requests: all.length,
  transferKB: kb(sum(all)),
  ttfb_ms: m.ttfb,
  domReady_ms: m.domReady,
  load_ms: m.load,
  lcp_ms: m.lcpTime,
  lcp_element: m.lcpEl,
  cls: +m.cls.toFixed(4),
  thirdParty: third.length,
  blocked: all.filter((r) => r.failed).map((r) => `${r.url.replace(/^https?:\/\/[^/]+/, '')} → ${r.failed}`),
  scripts: m.scripts,
  thirdPartyUrls: third.map((r) => r.url),
  byType: Object.fromEntries(
    Object.entries(byType)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => [k, { n: v.n, KB: kb(v.bytes) }])
  ),
  heavy: all
    .filter((r) => r.bytes > 20000)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 12)
    .map((r) => `${kb(r.bytes)}KB ${r.type} ${r.url.replace(/^https?:\/\/[^/]+/, '')}${r.enc ? ' [' + r.enc + ']' : ''}`),
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n${'='.repeat(72)}\n${report.url}  (${report.mode})\n${'='.repeat(72)}`);
  console.log(`请求 ${report.requests} 个 · 传输 ${report.transferKB} KB · 第三方 ${report.thirdParty} 个`);
  console.log(`TTFB ${report.ttfb_ms}ms · DOMReady ${report.domReady_ms}ms · Load ${report.load_ms}ms`);
  console.log(`LCP ${report.lcp_ms}ms  ${report.lcp_element}`);
  console.log(`CLS ${report.cls}`);
  console.log('\n按类型：');
  for (const [k, v] of Object.entries(report.byType)) console.log(`  ${k.padEnd(12)} ${String(v.n).padStart(3)} 个  ${String(v.KB).padStart(8)} KB`);
  if (report.heavy.length) {
    console.log('\n最重的资源：');
    for (const h of report.heavy) console.log('  ' + h);
  }
  if (report.blocked.length) {
    console.log('被拦下的请求（CSP/其他）：');
    for (const b of report.blocked) console.log('  ' + b);
  }
  console.log('页面脚本：');
  for (const s of report.scripts) console.log('  ' + s);
  if (third.length) {
    console.log('\n第三方：');
    for (const u of report.thirdPartyUrls) console.log('  ' + u);
  }
  console.log('');
}

const out = process.env.PERF_OUT;
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
ws.close();
process.exit(0);
