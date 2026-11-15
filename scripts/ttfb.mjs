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
     真正「服务器在想什么」的是 starttransfer - appconnect，DNS 和 TLS 不算它的锅。 */
  const out = execFileSync(
    'curl',
    [
      // Windows 自带的 curl.exe 不认 /dev/null，会当成文件名写出来
      '-s', '-o', devNull,
      '-H', 'cache-control: no-cache',
      '-w', '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{http_code}',
      '--max-time', '30',
      url,
    ],
    { encoding: 'utf8', shell: false }
  ).trim().split(' ');

  const [dns, conn, tls, ttfb, total, code] = out.map(Number);
  return {
    dns: ms(dns),
    // 没有 TLS 层（http）时 appconnect 是 0，退回 connect
    server: ms(ttfb - (tls || conn)),
    ttfb: ms(ttfb),
    total: ms(total),
    code,
  };
}

function cacheStatus(url) {
  const h = execFileSync(
    'curl',
    ['-sI', '-H', 'cache-control: no-cache', '--max-time', '20', url],
    { encoding: 'utf8', shell: false }
  );
  const m = h.match(/cf-cache-status:\s*(\S+)/i);
  return m ? m[1].toUpperCase() : '(无)';
}

console.log(`每项 ${N} 次，${FRESH ? '全部带随机参数（测 miss）' : '复用同一 URL（测 hit 路径）'}\n`);

for (const base of targets) {
  const rows = [];
  let status = '(未知)';
  for (let i = 0; i < N; i++) {
    const u = FRESH ? base + (base.includes('?') ? '&' : '?') + 'cb=' + Date.now() + i : base;
    try {
      rows.push(probe(u));
    } catch (e) {
      rows.push({ dns: 0, server: 0, ttfb: 0, total: 0, code: 0, err: e.message.slice(0, 40) });
    }
  }
  status = cacheStatus(base);

  const ok = rows.filter((r) => r.code === 200);
  const server = ok.map((r) => r.server);
  const ttfb = ok.map((r) => r.ttfb);
  const total = ok.map((r) => r.total);
  const dns = ok.map((r) => r.dns);

  console.log(base);
  console.log(`  边缘缓存 ${status} · 成功 ${ok.length}/${rows.length}`);
  console.log(
    `  服务器处理  P50 ${pct(server, 50)}ms  P95 ${pct(server, 95)}ms  max ${Math.max(...server)}ms`
  );
  console.log(`  TTFB        P50 ${pct(ttfb, 50)}ms  P95 ${pct(ttfb, 95)}ms  max ${Math.max(...ttfb)}ms`);
  console.log(`  整条请求    P50 ${pct(total, 50)}ms  P95 ${pct(total, 95)}ms  max ${Math.max(...total)}ms`);
  console.log(`  DNS         P50 ${pct(dns, 50)}ms（这一段是链路，不是 Worker）`);
  const failed = rows.filter((r) => r.code !== 200);
  if (failed.length) console.log('  异常：', failed.slice(0, 3).map((r) => r.code + (r.err ? ' ' + r.err : '')).join(', '));
  console.log('');
}

/* 判读方式写出来，省得下次又对着一个 4 秒发呆：
   · server P95 在几十毫秒 → Worker 没问题，总时长全是链路（代理、跨国、TLS 重连）
   · server P95 上几百毫秒、且 miss 明显高于 hit → 回源渲染 + D1 往返的成本，看 html_content 有没有命中
   · 两者都正常但 total 高 → 客户端到边缘那一段，跟站点无关 */
