#!/usr/bin/env node
// 运行：node scripts/check-dom.mjs [URL 或本地 HTML 路径]
// 默认 http://127.0.0.1:8787；CI 由 ci-browser.mjs 传本地 Worker 的 BASE。
// 无 DOM 环境：用正则做结构化断言，不引 jsdom / playwright，退出码非零即失败。
//
// 第 4 条针对 2026-11 那次「导航登录格 + 两个筛选条等 JS 填内容，窄屏推了 182px」：
// 哪天又改成客户端填充，这一行会红。
// 第 6 条对应「省掉的全是等待」：canonical/alternate 这类不发起请求的 link 不算外链。
import { readFile } from 'node:fs/promises';

const TARGET = process.argv[2] ?? process.env.BASE ?? 'http://127.0.0.1:8787';
let html;
try {
  if (/^https?:\/\//i.test(TARGET)) {
    // 绕过 Worker 的 LRU / 边缘缓存：本地 CI 复用同一实例时，旧 HTML 会一直命中，
    // 断言的是上一版模板而不是本次改动。线上体检同样用 ?cb= 绕缓存。
    const u = new URL(TARGET);
    u.searchParams.set('cb', String(Date.now()));
    const res = await fetch(u, {
      headers: { 'user-agent': 'dom-assert/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } else {
    html = await readFile(TARGET, 'utf8');
  }
} catch (e) {
  console.log(`FAIL  取不到首页：${e.message}`);
  process.exit(1);
}

let bad = 0;
const check = (name, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name.padEnd(26)} ${detail}`);
};

// 1) 基线没塌：唯一 h1
const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
check('首页存在唯一 h1', !!h1 && !html.slice(html.indexOf('</h1>') + 5).includes('<h1'),
  h1 ? `内容「${h1[1].replace(/<[^>]+>/g, '').trim().slice(0, 12)}」` : '未找到');

// 2) 视口与缩放未被锁死（CLS 与移动端的前提）
check('viewport 允许缩放', !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/i.test(html));

// 3) 图片宽高齐全 —— CLS 归零的硬约束
const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
const noDim = imgs.filter((t) => !/\bwidth\s*=/.test(t) || !/\bheight\s*=/.test(t));
check('图片均含 width/height', noDim.length === 0, `共 ${imgs.length} 张，缺尺寸 ${noDim.length} 张`);

// 4) 首屏不出现异步占位：等 JS 填内容的空位会把 CLS 推回去
const placeholders = [...html.matchAll(/<(nav|div|section)\b[^>]* class="[^"]*(?:skeleton|placeholder|loading|js-fill)[^"]*" /gi)];
check('无首屏异步占位', placeholders.length === 0, `命中 ${placeholders.length} 处`);

// 5) 关键语义锚点
check('跳到正文链接', /<a\b[^>]+#(main|content)[^>]*>/i.test(html) || /跳到正文/.test(html));
check('搜索框有 aria-label', /<input\b[^>]*aria-label=/i.test(html) || /<input\b[^>]*id="search" /i.test(html));
check('分页有 nav 语义', /<nav\b[^>]*aria-label=["'][^"']*分页/i.test(html) || /aria-label=["'][^"']*分页/.test(html));
check('当前页有 aria-current', /aria-current=["']page/i.test(html));

// 6) 首屏不引入外部阻塞请求。
//    只算真正会发起 GET 的 link/script；canonical / alternate / prev / next / amphtml
//    是元信息，不加载资源，不能算（否则 canonical 的自指 URL 会永远误报）。
const ext = [
  ...[...html.matchAll(/<link\b[^>]*\brel=["'][^"']*(?:stylesheet|preload|modulepreload|icon|manifest)[^"']*["'][^>]*\bhref=["']https?:\/\/([^"']+)/gi)].map((m) => m[1]),
  ...[...html.matchAll(/<script\b[^>]*\bsrc=["']https?:\/\/([^"']+)/gi)].map((m) => m[1]),
];
check('无外部阻塞资源', ext.length === 0, ext.length ? ext.slice(0, 3).join(', ') : '全站自托管');

console.log(bad ? `\n✗ ${bad} 项 DOM 断言失败` : '\n✓ DOM 断言全部通过');
process.exit(bad ? 1 : 0);
