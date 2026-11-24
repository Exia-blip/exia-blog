#!/usr/bin/env node
// 线上核对：/numbers 页渲染成功，且每条数字在其出处文章的 SSR HTML 里出现。
// 与 test-numbers.mjs 分工：那个离线守结构与登记，这个联网守「数字没写错」。
// 用法：node scripts/check-numbers-live.mjs [origin]
//   默认 https://miu.sryze.cc；CI 传本地 Worker 的 BASE。
// 存稿里的数字（PENDING_SLUGS）在线上还没上线，跳过其出处核对，只验页面本身。
import { allNumbers, PENDING_SLUGS } from '../src/numbers.js';
import { report } from './pitfall-check.mjs';

const origin = (process.argv[2] || 'https://miu.sryze.cc').replace(/\/$/, '');
const UA = { 'user-agent': 'numbers-live-check/1.0' };

let bad = 0;
const check = (name, cond, detail = '') => {
  if (!report('', name, cond, detail)) bad++;
};

// 1. /numbers 页本身
let page = '';
try {
  const res = await fetch(`${origin}/numbers?cb=${Date.now()}`, {
    headers: UA, signal: AbortSignal.timeout(10000),
  });
  check('/numbers 返回 200', res.ok, `HTTP ${res.status}`);
  page = await res.text();
} catch (e) {
  check('/numbers 返回 200', false, e.message);
  console.log(`\n✗ ${bad} 项数字页断言失败`);
  process.exit(1);
}

check('页面含全部数字值', allNumbers().every((r) => page.includes(r.v)),
  `${allNumbers().length} 条中 ${allNumbers().filter((r) => !page.includes(r.v)).length} 条缺失`);
check('页面含数字导航入口', /href="\/numbers"[^>]*>\s*数字/.test(page));
check('页面标注口径与出处', page.includes('口径 / 条件') && page.includes('num-summary'));

// 2. 逐篇抓出处，核对数字值。按 slug 去重，避免同一篇抓多次。
const bySlug = new Map();
for (const r of allNumbers()) {
  if (PENDING_SLUGS.has(r.slug)) continue;
  if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
  bySlug.get(r.slug).push(r.v);
}

const cache = new Map();
const fetchBody = async (slug) => {
  if (cache.has(slug)) return cache.get(slug);
  try {
    const res = await fetch(`${origin}/p/${slug}?cb=${Date.now()}`, {
      headers: UA, signal: AbortSignal.timeout(10000),
    });
    const text = res.ok ? await res.text() : '';
    cache.set(slug, text);
    return text;
  } catch {
    cache.set(slug, '');
    return '';
  }
};

const misses = [];
const notLive = [];
for (const [slug, values] of bySlug) {
  const html = await fetchBody(slug);
  // 存稿还没到 published_at 时线上是 404，跳过其出处核对——数字在 content md 里已由
  // test-numbers.mjs 守。线上核对只管「已经公开的文章数字没写错」。
  if (!html) { notLive.push(slug); continue; }
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  for (const v of values) {
    // 去掉单位里的空格再比：正文可能写「549 ms」或「549ms」，都算命中。
    const key = v.replace(/\s+/g, '');
    if (!plain.includes(v) && !plain.replace(/\s+/g, '').includes(key)) {
      misses.push(`${slug}:${v}`);
    }
  }
}
check('每条数字在其出处正文出现', misses.length === 0,
  misses.length ? misses.slice(0, 8).join(' / ') : `${bySlug.size - notLive.length} 篇已核${notLive.length ? `，${notLive.length} 篇存稿未上线跳过` : ''}`);

console.log(bad ? `\n✗ ${bad} 项数字页断言失败` : '\n✓ 数字页线上核对通过');
process.exit(bad ? 1 : 0);
