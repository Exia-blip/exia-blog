#!/usr/bin/env node
// TTFB 分阶段测量：把「网络抖」和「Worker 慢」分开。
//
// 只用 fetch 的话只有一个总时长，代理抖一下就把结论带偏 —— 上一次实测
// 首页 TTFB 出现 1.2s / 1.5s / 4.0s，看着像 Worker 出了问题，其实要看的
// 是 time_starttransfer 减去 time_appconnect（这一段才是等服务器答话），
// 以及这次到底是 edge HIT 还是回了源。
//
// 用法：
//   node scripts/ttfb.mjs                        默认打首页 + 一篇文章，各 10 次
//   node scripts/ttfb.mjs https://exia.de5.net/  --n=20
//   node scripts/ttfb.mjs --fresh                只测 miss（每次带随机参数绕开边缘缓存）

import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';

const args = process.argv.slice(2);
const N = Number((args.find((a) => a.startsWith('--n=')) || '').split('=')[1] || 10);
const FRESH = args.includes('--fresh');
const urls = args.filter((a) => /^https?:\/\//.test(a));
const targets = urls.length ? urls : ['https://exia.de5.net/', 'https://exia.de5.net/p/sticky-toc-grid-align-items'];

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (v) => Math.round(v * 1000);

function probe(url) {
  /* -w 里这五个时间的含义（都从请求开始算）：
     namelookup → connect → appconnect（TLS 完成）→ starttransfer（首字节）→ total。
     真正「服务器在想什么」的是 starttransfer - appconnect，DNS 和 TLS 不算它的锅。

     %header{cf-cache-status} 跟在同一个请求里读，不能像以前那样另发一次 HEAD：
     那条 HEAD 和真正计时的 GET 可能一次 HIT 一次 MISS —— 分组归错了，
     HIT/MISS 的 P50 就全是噪声。用 | 做分隔符，因为 cf-cache-status 有时是空串。 */
  const raw = execFileSync(
    'curl',
    [
      // Windows 自带的 curl.exe 不认 /dev/null，会当成文件名写出来
      '-s', '-o', devNull,
      '-H', 'cache-control: no-cache',
      '-w', '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{http_code}|%header{cf-cache-status}',
      '--max-time', '30',
      url,
    ],
    { encoding: 'utf8', shell: false }
  ).trim();

  const [timings, cache = ''] = raw.split('|');
  const [dns, conn, tls, ttfb, total, code] = timings.trim().split(' ').map(Number);
  return {
    dns: ms(dns),
    // 没有 TLS 层（http）时 appconnect 是 0，退回 connect
    server: ms(ttfb - (tls || conn)),
    ttfb: ms(ttfb),
    total: ms(total),
    code,
    cache: (cache.trim() || 'DYNAMIC').toUpperCase(),
  };
}

function report(label, rows) {
  const server = rows.map((r) => r.server);
  const ttfb = rows.map((r) => r.ttfb);
  const total = rows.map((r) => r.total);
  const dns = rows.map((r) => r.dns);
  console.log(`  [${label}] n=${rows.length}`);
  console.log(
    `    服务器处理  P50 ${pct(server, 50)}ms  P95 ${pct(server, 95)}ms  max ${Math.max(...server)}ms`
  );
  console.log(`    TTFB        P50 ${pct(ttfb, 50)}ms  P95 ${pct(ttfb, 95)}ms  max ${Math.max(...ttfb)}ms`);
  console.log(`    整条请求    P50 ${pct(total, 50)}ms  P95 ${pct(total, 95)}ms  max ${Math.max(...total)}ms`);
  console.log(`    DNS         P50 ${pct(dns, 50)}ms（这一段是链路，不是 Worker）`);
}

console.log(`每项 ${N} 次，${FRESH ? '全部带随机参数（测 miss）' : '复用同一 URL（测 hit 路径）'}\n`);

for (const base of targets) {
  const rows = [];
  for (let i = 0; i < N; i++) {
    const u = FRESH ? base + (base.includes('?') ? '&' : '?') + 'cb=' + Date.now() + i : base;
    try {
      rows.push(probe(u));
    } catch (e) {
      rows.push({ dns: 0, server: 0, ttfb: 0, total: 0, code: 0, cache: 'ERR', err: e.message.slice(0, 40) });
    }
  }

  const ok = rows.filter((r) => r.code === 200);
  // 关键：按每次请求自己的 cf-cache-status 分组，不再混在一起算一个中位。
  // HIT 慢是边缘链路问题（跟 Worker/D1 无关），MISS 慢才是回源渲染的锅。
  const groups = new Map();
  for (const r of ok) {
    if (!groups.has(r.cache)) groups.set(r.cache, []);
    groups.get(r.cache).push(r);
  }

  console.log(base);
  console.log(`  成功 ${ok.length}/${rows.length} · 缓存态: ${[...groups.keys()].join(', ')}`);
  for (const [name, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    report(name, g);
  }
  const failed = rows.filter((r) => r.code !== 200);
  if (failed.length) console.log('  异常：', failed.slice(0, 3).map((r) => r.code + (r.err ? ' ' + r.err : '')).join(', '));
  console.log('');
}

/* 判读方式写出来，省得下次又对着一个 4 秒发呆：
   · HIT 的 server P95 还上百毫秒 → 边缘节点到客户端这段（代理/跨国/TLS），不是代码问题
   · MISS 的 server P95 上几百毫秒、且明显高于 HIT → 回源渲染 + D1 往返，查 html_content / LRU 有没有命中
   · HIT 快而 MISS 慢，但 MISS 占比很低 → 不用动 Worker，把 SWR / EDGE_TTL 调大更划算
   · 两者都正常但 total 高 → 客户端到边缘那一段，跟站点无关 */
