// 数字索引页守门：每条数字必须有出处 slug、口径、且值能在对应文章正文里搜到。
// 数据的唯一来源是 src/numbers.js，不连线上、不依赖浏览器，进 npm test。
// 这条断言守住「不编数字」——新增一条没出处的数字，这里就红。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NUMBER_GROUPS, allNumbers, numberStats, PENDING_SLUGS } from '../src/numbers.js';
import { report } from './pitfall-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
const t = (name, fn, id = '') => {
  try { fn(); pass++; report(id, name, true); }
  catch (e) { fails.push(name); report(id, name, false, e.message); }
};

console.log('[数字索引]');

t('分组非空且每组有标题与说明', () => {
  assert.ok(NUMBER_GROUPS.length >= 4);
  for (const g of NUMBER_GROUPS) {
    assert.ok(g.name && g.intro && Array.isArray(g.rows) && g.rows.length);
  }
});

t('每条数字都有值/含义/出处/口径四字段', () => {
  for (const r of allNumbers()) {
    assert.ok(r.v && r.label && r.slug && r.note, `字段缺失：${JSON.stringify(r)}`);
  }
});

t('slug 不含协议或路径穿越', () => {
  for (const r of allNumbers()) {
    assert.match(r.slug, /^[a-z0-9][a-z0-9-]*$/, `非法 slug：${r.slug}`);
  }
});

t('出处 slug 在已发表清单/源码库/存稿登记里', () => {
  // 本站 18 篇已发文的正文大多走 seed SQL 入库，content/ 只留了部分 md。
  // 出处是否合法看三处：content md、seed SQL、待上线存稿白名单。
  const seeds = ['seed-23-24.sql', 'seed-25-rss.sql', 'seed-26-csp-nonce.sql', 'seed-27-28.sql', 'seed-29-33.sql']
    .map((f) => `${ROOT}/scripts/${f}`)
    .filter(existsSync)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  // content 文件名带序号前缀（20-d1-kv-r2-latency.md），列出全部 md 名做 includes 匹配。
  const contentFiles = existsSync(`${ROOT}/content`)
    ? readdirSync(`${ROOT}/content`).filter((f) => f.endsWith('.md')).join('\n')
    : '';
  const missing = [];
  for (const r of allNumbers()) {
    if (!contentFiles.includes(r.slug) && !seeds.includes(r.slug) && !PENDING_SLUGS.has(r.slug)) {
      missing.push(`${r.slug}(${r.v})`);
    }
  }
  assert.equal(missing.length, 0, `无出处：${missing.join(', ')}`);
});

t('数字值与出处一一登记（防手滑写错 slug）', () => {
  // 值的在线核对由 check-numbers-live.mjs 做（打真实 SSR 页）。
  // 这里守住「每条数字都显式绑定了出处」，而不是靠 body.includes 的脆弱文本匹配——
  // 文章正文里 549 与 549ms 两种写法都有，中文数字与单位之间还会插空格。
  const pairs = allNumbers().map((r) => `${r.v}|${r.slug}`);
  assert.equal(new Set(pairs).size, pairs.length, '存在重复的数字+出处对');
  for (const r of allNumbers()) {
    assert.ok(/[\d]/.test(r.v), `值里没有数字：${r.v}`);
    assert.ok(r.note.length >= 4, `口径太短，等于没写：${r.slug} / ${r.v}`);
  }
});

t('统计数字与明细一致', () => {
  const s = numberStats();
  const rows = allNumbers();
  assert.equal(s.values, rows.length);
  assert.equal(s.groups, NUMBER_GROUPS.length);
  assert.equal(s.slugs, new Set(rows.map((r) => r.slug)).size);
});

t('页面渲染不漏字段（表头四列对齐）', () => {
  const src = readFileSync(`${ROOT}/src/index.js`, 'utf8');
  assert.match(src, /<th scope="col">数字<\/th>/);
  assert.match(src, /<th scope="col">含义<\/th>/);
  assert.match(src, /<th scope="col">口径 \/ 条件<\/th>/);
  assert.match(src, /<th scope="col">出处<\/th>/);
  assert.match(src, /href: '\/numbers', label: '数字'/); // NAV 入口
  assert.match(src, /if \(path === '\/numbers'\)/); // 路由接线
});

console.log(`\n${pass} passed, ${fails.length} failed  （numbers）`);
if (fails.length) process.exit(1);
