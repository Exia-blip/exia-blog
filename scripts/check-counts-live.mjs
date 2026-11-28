#!/usr/bin/env node
/**
 * 篇数口径线上对账：七个出口必须报同一个「已发布」数。
 *
 * 页面自己的数字是自洽的（首页 / 归档 / 栏目都读 liveSql 那一套），
 * 但出口之间各写各的提取逻辑，任何一处漂移都不会报错、浏览器也看不出来。
 * 这里打真产物：API total、栏目合计、sitemap 条数、RSS item 数、三个页面文案。
 *
 * 用法：node scripts/check-counts-live.mjs [origin]
 */
import { COUNT_SOURCES, reconcileCounts } from '../src/count-consistency.js';
import { report } from './pitfall-check.mjs';

const origin = (process.argv[2] || 'https://miu.sryze.cc').replace(/\/$/, '');
const UA = { 'user-agent': 'counts-live-check/1.0' };
const bust = `cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const q = (p) => origin + p + (p.includes('?') ? '&' : '?') + bust;

const PATHS = {
  api: '/api/posts?page=1&size=1',
  categories: '/api/categories',
  sitemap: '/sitemap.xml',
  rss: '/rss.xml',
  home: '/',
  archive: '/archive',
  categoriesPage: '/categories',
};

let bad = 0;
const check = (name, cond, detail = '') => {
  if (!report('P-126', name, cond, detail)) bad++;
};

const responses = await Promise.all(
  COUNT_SOURCES.map(async (s) => {
    try {
      const res = await fetch(q(PATHS[s]), {
        headers: UA, signal: AbortSignal.timeout(12000),
      });
      return [s, res.ok ? await res.text() : `HTTP ${res.status}`];
    } catch (e) {
      return [s, `fetch failed: ${e.message}`];
    }
  })
);
const raw = Object.fromEntries(responses);
const r = reconcileCounts(raw);
const shown = COUNT_SOURCES.map((s) => `${s}=${Number.isNaN(r.values[s]) ? '?' : r.values[s]}`).join(' ');

check('七出口篇数一致', r.consistent, shown);
// 这条恒输出：失败时才冒出来的断言会让报告条数随结果漂移，和 skip-as-pass 同族。
check('七出口都抽得到数', r.bad.length === 0,
  r.bad.length ? `抽不到：${r.bad.join(', ')}` : `${COUNT_SOURCES.length}/${COUNT_SOURCES.length}`);

console.log(bad ? `\n✗ ${bad} 项篇数口径断言失败` : '\n✓ 篇数口径线上对账通过');
process.exit(bad ? 1 : 0);
