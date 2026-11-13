#!/usr/bin/env node
// 部署后的验收：把「统计到底接上没有」这一串判断压成一条命令。
//
// 手工查要五次，而且其中两次最容易看错：
//   · CSP 只放行脚本源、没放行采集端 —— 页面不报错，后台永远没数据；
//   · 早就部署了，浏览器/边缘还拿着旧 HTML —— 看起来像没生效。
// 这里一次性比对：本地配置说什么，线上就应该是那个样子。两边不一致就 exit 1。
//
// 用法：
//   npm run verify:umami                # 验 https://exia.de5.net
//   npm run verify:umami -- http://127.0.0.1:8799
import { readFileSync } from 'node:fs';
import { umamiOn, collectOrigins } from '../src/utils.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const argUrl = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
const BASE = (argUrl || 'https://exia.de5.net').replace(/\/$/, '');

/* wrangler.jsonc 是带注释的 JSON：按行删掉整行注释就能 parse。
   注意不能用「删 // 之后的部分」—— 值里全是 https://，会把 JSON 劈坏。 */
function readVars() {
  const src = readFileSync('wrangler.jsonc', 'utf8');
  const json = src.replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(json).vars || {};
  } catch (e) {
    console.error(`读不了 wrangler.jsonc 的 vars：${e.message}`);
    process.exit(1);
  }
}

const vars = readVars();
const want = umamiOn(vars);
const scriptOrigin = want ? new URL(vars.UMAMI_SCRIPT.trim()).origin : '';
const collect = want ? collectOrigins(vars.UMAMI_SCRIPT) : [];

let bad = 0;
const row = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${detail || ''}`);
};

console.log(`\n目标：${BASE}`);
console.log(`本地配置：UMAMI_SCRIPT=${vars.UMAMI_SCRIPT ? '有' : '空'}  UMAMI_SITE_ID=${vars.UMAMI_SITE_ID ? '有' : '空'}  → 期望${want ? '已启用' : '未启用（走自建 /api/pv）'}\n`);

/* 边缘缓存 300 秒 + 部署后旧副本还在：第一次拉可能是部署前那份。
   带一个随机参数绕开，否则「部署完没生效」有一半是这个假象。 */
const bust = `__vc=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let html = '';
let csp = '';
try {
  const r = await fetch(`${BASE}/?${bust}`, { headers: { 'accept': 'text/html' }, redirect: 'follow' });
  html = await r.text();
  csp = (r.headers.get('content-security-policy') || '').toLowerCase();
  row('首页可访问', r.ok, `HTTP ${r.status}，${(html.length / 1024).toFixed(1)}KB`);
} catch (e) {
  console.error(`\n✗ 打不开 ${BASE}：${e.message}\n`);
  process.exit(1);
}

const dir = (name) => {
  const m = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' '));
  return m ? m : '';
};
const scriptSrc = dir('script-src');
const connectSrc = dir('connect-src');

if (want) {
  row('HTML 里有 __PV_OFF__', html.includes('__PV_OFF__=1'), '自建上报在客户端就停了');
  const tag = /<script[^>]+src="([^"]+)"[^>]*data-website-id="([^"]+)"/i.exec(html);
  row('HTML 里有 umami <script>', !!tag, tag ? `${tag[1]}  id=${tag[2].slice(0, 8)}…` : '没找到，配置没生效或被缓存挡住');
  if (tag) {
    row('script 地址与配置一致', tag[1] === vars.UMAMI_SCRIPT.trim(), tag[1]);
    row('website-id 与配置一致', tag[2] === vars.UMAMI_SITE_ID.trim(), tag[2]);
    row('script 是 defer（不阻塞渲染）', /<script[^>]+defer[^>]+src=/i.test(html), '');
  }
  row('CSP script-src 放行脚本源', scriptSrc.includes(scriptOrigin), scriptSrc || '(无 script-src)');
  const miss = collect.filter((o) => !connectSrc.includes(o.toLowerCase()));
  row('CSP connect-src 放行采集端', miss.length === 0, miss.length ? `缺 ${miss.join(',')} —— 上报会被静默挡掉` : connectSrc);
} else {
  row('HTML 里没有 umami 脚本', !/umami/i.test(html), '未启用时不该有任何第三方统计');
  row('HTML 里没有 __PV_OFF__', !html.includes('__PV_OFF__'), '没关自建上报才正常');
  row('CSP 里没有第三方源', !/https:\/\//.test(scriptSrc + ';' + connectSrc), `${scriptSrc} | ${connectSrc}`);
  // 自建上报是否还活着：204 是正常回执。
  // 路径特意选 /admin/… —— 服务端对后台路径一律不记，所以这条探测不会污染报表。
  try {
    const r = await fetch(`${BASE}/api/pv`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' },
      body: JSON.stringify({ p: '/admin/__verify_probe__', r: '' }),
    });
    row('/api/pv 可达', r.status === 204, `HTTP ${r.status}`);
  } catch (e) {
    row('/api/pv 可达', false, e.message);
  }
}

/* 服务端是否真的停写，外面看不出来（204 两种情况都是 204）。
   这条只能在代码里保证，由 scripts/test-stats.mjs 钉住，这里只做提醒。 */
console.log(
  want
    ? '\n  说明：/api/pv 服务端是否停写无法从外部观测，由 npm test 里的用例保证。'
    : '\n  说明：/api/pv 的 204 只代表收到，不代表写进去了（同人同日同页会去重）。'
);

// 偶尔会有边缘节点没跟上，隔几秒再给一次机会，避免把正常的传播延迟报成失败
if (bad && !argUrl) {
  console.log('\n  有项目不符，8 秒后重试一次（边缘传播可能没跟上）…');
  await wait(8000);
  const html2 = await fetch(`${BASE}/?__vc=${Date.now()}`, { headers: { accept: 'text/html' } }).then((r) => r.text());
  if (html2.includes('umami') === html.includes('umami')) {
    console.log('  重试结果相同，不是传播延迟。');
  } else {
    console.log('  重试结果不同 —— 刚才那次撞上了旧副本，以重试为准。');
    bad = 0;
  }
}

console.log(bad ? `\n✗ ${bad} 项不符\n` : '\n✓ 全部符合\n');
process.exitCode = bad ? 1 : 0;
