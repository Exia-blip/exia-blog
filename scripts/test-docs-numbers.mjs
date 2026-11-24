#!/usr/bin/env node
/**
 * 文档数字与代码事实的对账（[P-047]）。
 *
 * 起因：README 里同时躺着"13 张表""40 篇""第 56 篇"三个数字，而线上实际是
 * 12 张业务表 / 42 行 / 已发布 18 篇。三个数字各自都对，但没说是什么口径，
 * 读者（和下一轮的审计）只能猜——上一轮就把"40 篇"当成了站内总篇数。
 *
 * 这组断言守两件事：
 *   1. README 报的表数/索引数必须等于 migrations 建出来的数量，谁也不许靠记忆写；
 *   2. 「篇」的三种口径必须在文档里写清楚，否则文章数一定会再次打架。
 *
 * 注意 D-01 不跑 check:schema（那要连线上 D1，CI 没有凭据）；它读的是
 * migrations/*.sql 本身——这正好和 check:schema 的线上结果构成两个方向的交叉验证：
 * 本地文件 → 线上库 由 check:schema 守，文档 → 本地文件 由这里守。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/** 从 migrations 里数出真实的表与索引（去重，只认 DDL，不认注释）。 */
function schemaCounts() {
  const dir = path.join(root, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const tables = new Set();
  const indexes = new Set();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_]+)/gi)) tables.add(m[1].toLowerCase());
    for (const m of sql.matchAll(/CREATE INDEX(?:\s+IF NOT EXISTS)?\s+([A-Za-z_]+)/gi)) indexes.add(m[1].toLowerCase());
  }
  return { tables, indexes, files };
}

t('D-01 README 报的业务表数 == migrations 建出的表数', () => {
  const { tables } = schemaCounts();
  assert.ok(tables.size > 0, 'migrations 里一张表都没数到，正则或目录错了');
  const m = readme.match(/(\d+)\s*张业务表/);
  assert.ok(m, 'README 里没有「N 张业务表」的表述，改过措辞就同步改这条断言');
  assert.equal(Number(m[1]), tables.size, `README 写 ${m[1]} 张，migrations 实际 ${tables.size} 张（${[...tables].join(', ')}）`);
});

t('D-02 README 报的索引数 == migrations 建出的索引数', () => {
  const { indexes } = schemaCounts();
  const m = readme.match(/(\d+)\s*个索引/);
  assert.ok(m, 'README 里没有「N 个索引」的表述');
  assert.equal(Number(m[1]), indexes.size, `README 写 ${m[1]} 个，migrations 实际 ${indexes.size} 个`);
});

t('D-03 README 不许再出现 sqlite_master 口径的表数（13 表那种数法）', () => {
  const bad = [];
  readme.split('\n').forEach((l, i) => {
    if (/(\d+)\s*张表(?!\s*业务)/.test(l) && !/sqlite_master|d1_migrations|sqlite_sequence|_cf_KV/.test(l)) {
      bad.push(`README.md:${i + 1}  ${l.trim().slice(0, 100)}`);
    }
  });
  assert.deepEqual(bad, [], `又出现了没说口径的「N 张表」：\n${bad.join('\n')}`);
});

t('D-04 「篇」的三种口径必须在文档里写清楚', () => {
  assert.ok(/^## 数字口径$/m.test(readme), 'README 缺「## 数字口径」一节');
  for (const k of ['已发布', '全库', '第 N 篇']) {
    assert.ok(readme.includes(k), `「数字口径」里没写「${k}」`);
  }
});

t('D-05 已发布口径的三处必须同源（文档里要明确点名）', () => {
  const seg = readme.slice(readme.indexOf('## 数字口径'), readme.indexOf('## 数字口径') + 1600);
  for (const k of ['/api/posts', 'sitemap.xml', 'rss.xml']) {
    assert.ok(seg.includes(k), `数字口径没把 ${k} 列为「已发布」的核对点`);
  }
});

t('D-06 content/ 里最新一篇必须已在 EDITORIAL 登记', () => {
  const dir = path.join(root, 'content');
  const posts = fs
    .readdirSync(dir)
    .filter((f) => /^\d+-.+\.md$/.test(f))
    .map((f) => ({ f, n: Number(f.match(/^(\d+)-/)[1]) }))
    .sort((a, b) => b.n - a.n);
  assert.ok(posts.length > 0, 'content/ 里没有编号稿');
  const latest = posts[0];
  const slug = latest.f.replace(/^\d+-/, '').replace(/\.md$/, '');
  const ed = fs.readFileSync(path.join(dir, 'EDITORIAL.md'), 'utf8');
  assert.ok(ed.includes(slug), `${latest.f} 没在 EDITORIAL.md 登记（slug=${slug}）`);
});

/* ---------- 跑 ---------- */

let pass = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`[P-047] 文档数字对账 ${pass}/${cases.length} passed`);
