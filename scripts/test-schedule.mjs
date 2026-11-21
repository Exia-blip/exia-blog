// 排期一致性守门：改期 SQL / seed 脚本 / 文档日期表三处必须同口径，间隔全 2 天。
// 防止日后只改一处导致 D1 实际发布时间与文档/seed 漂移。
// 用法：node scripts/test-schedule.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// 唯一事实源：slug → 新 UTC 发布时间（北京时间 09:00）
const EXPECT = [
  ['three-layer-cache', '2026-11-25 01:00:00'],
  ['jwt-exp-verify', '2026-11-27 01:00:00'],
  ['samesite-behavior', '2026-11-29 01:00:00'],
  ['cors-preflight-cost', '2026-12-01 01:00:00'],
  ['turnstile-what-it-blocks', '2026-12-03 01:00:00'],
  ['workers-free-tier-limits', '2026-12-05 01:00:00'],
  ['d1-kv-r2-latency', '2026-12-07 01:00:00'],
  ['workers-blog-pillar', '2026-12-09 01:00:00'],
  ['related-posts', '2026-12-11 01:00:00'],
  ['search-highlight-xss', '2026-12-13 01:00:00'],
  ['rss-enclosure-cover', '2026-12-15 01:00:00'],
  ['csp-nonce-cache', '2026-12-17 01:00:00'],
];
// 新入库两篇（接在 12-17 之后收尾），不参与改期 SQL / 回滚基线
const NEW_POSTS = [
  ['lightbox-no-deps', '2026-12-19 01:00:00'],
  ['theme-transition-class', '2026-12-21 01:00:00'],
];
const ALL_POSTS = [...EXPECT, ...NEW_POSTS];
// 原始每周三排期（回滚基线）
const ORIGINAL = [
  '2026-11-25 01:00:00', '2026-12-02 01:00:00', '2026-12-09 01:00:00',
  '2026-12-16 01:00:00', '2026-12-23 01:00:00', '2027-01-06 01:00:00',
  '2027-01-13 01:00:00', '2027-01-20 01:00:00', '2027-02-03 01:00:00',
  '2027-02-10 01:00:00', '2027-02-17 01:00:00', '2027-03-03 01:00:00',
];

const sql = read('scripts/schedule-2day.sql');
const rollback = read('scripts/schedule-2day-rollback.sql');
const editorial = read('content/EDITORIAL.md');
const seeds = [
  read('scripts/seed-scheduled.mjs'),
  read('scripts/seed-23-24.mjs'),
  read('scripts/seed-25-rss.mjs'),
  read('scripts/seed-26-csp-nonce.mjs'),
  read('scripts/seed-27-28.mjs'),
].join('\n');

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('日期序列：14 篇、间隔全 2 天、全为 UTC 01:00', () => {
  assert.equal(ALL_POSTS.length, 14);
  for (let i = 0; i < ALL_POSTS.length; i++) {
    assert.match(ALL_POSTS[i][1], / 01:00:00$/, `${ALL_POSTS[i][0]} 应为 UTC 01:00`);
    if (i > 0) {
      const gap = (Date.parse(ALL_POSTS[i][1]) - Date.parse(ALL_POSTS[i - 1][1])) / 86400000;
      assert.equal(gap, 2, `${ALL_POSTS[i][0]} 与上一篇间隔应为 2 天`);
    }
  }
});

t('改期 SQL：12 条 UPDATE，slug/日期与事实源逐条一致', () => {
  const rows = [...sql.matchAll(/UPDATE posts SET published_at = '([^']+)' WHERE slug = '([^']+)'/g)]
    .map((m) => [m[2], m[1]]);
  assert.equal(rows.length, 12, '改期 SQL 应有 12 条 UPDATE');
  for (const [slug, at] of EXPECT) {
    assert.ok(rows.some(([s, a]) => s === slug && a === at), `改期 SQL 缺 ${slug}=${at}`);
  }
});

t('回滚 SQL：12 条 UPDATE，日期与原始基线一致', () => {
  const rows = [...rollback.matchAll(/UPDATE posts SET published_at = '([^']+)' WHERE slug = '([^']+)'/g)]
    .map((m) => [m[2], m[1]]);
  assert.equal(rows.length, 12, '回滚 SQL 应有 12 条 UPDATE');
  for (let i = 0; i < EXPECT.length; i++) {
    assert.ok(rows.some(([s, a]) => s === EXPECT[i][0] && a === ORIGINAL[i]),
      `回滚 SQL 缺 ${EXPECT[i][0]}=${ORIGINAL[i]}`);
  }
});

t('seed 脚本：每个 at 值都属于新日期集合（含 12-09 复用不误判）', () => {
  const newDates = new Set(ALL_POSTS.map(([, at]) => at));
  const ats = [...seeds.matchAll(/at: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(ats.length, 14, 'seed 里应共 14 个 at 值');
  for (const at of ats) {
    assert.ok(newDates.has(at), `seed 残留非新日期 ${at}`);
  }
  // 旧基线里已不属于新集合的日期（2027 年那批 + 12-02/16/23）不得出现
  for (const old of ORIGINAL) {
    if (newDates.has(old)) continue;
    assert.ok(!ats.includes(old), `seed 残留旧日期 ${old}`);
  }
});

t('EDITORIAL 日期表：14 个新日期的北京 MM-DD 全部在册', () => {
  for (const [slug, at] of ALL_POSTS) {
    const mmdd = at.slice(5, 7) + '-' + at.slice(8, 10);
    assert.ok(editorial.includes(`| ${mmdd} | \`${slug}\``), `文档缺 ${slug} 的 ${mmdd} 行`);
  }
});

t('新两篇：seed 日期与事实源一致，文档标为已入库不再待写', () => {
  const seedSrc = read('scripts/seed-27-28.mjs');
  for (const [slug, at] of NEW_POSTS) {
    assert.ok(seedSrc.includes(`slug: '${slug}'`), `seed 缺 ${slug}`);
    assert.ok(seedSrc.includes(`at: '${at}'`), `seed 缺 ${slug} 的 ${at}`);
    const mmdd = at.slice(5, 7) + '-' + at.slice(8, 10);
    assert.ok(editorial.includes(`| ${mmdd} | \`${slug}\``), `文档缺 ${slug} 的 ${mmdd} 行`);
  }
  assert.ok(!editorial.includes('两篇待写，未入库'), '文档仍标待写，应改为已入库');
  assert.ok(editorial.includes('十五篇全部写完全文'), '文档总数应更新为 15 篇');
});

t('EDITORIAL 口径：原则写 2 天、产能警告在、历史排期表标注已执行', () => {
  assert.ok(editorial.includes('每 2 天发 1 篇'), '原则未改 2 天');
  assert.ok(editorial.includes('产能警告'), '缺产能警告');
  assert.ok(editorial.includes('本表已执行完毕'), '历史排期表应保留');
  assert.ok(!editorial.includes('4 周 3 篇'), '残留旧降档口径');
});

t('改期 SQL 语句不动 hidden、不碰 11-21 已上线篇', () => {
  const statements = sql.split('\n').filter((l) => /^\s*UPDATE\b/i.test(l)).join('\n');
  assert.ok(!/hidden/i.test(statements), 'UPDATE 语句不应碰 hidden');
  assert.ok(!/ld-self-reference/.test(statements), 'UPDATE 不应含已上线的 11-21 篇');
});

let pass = 0;
for (const [name, fn] of cases) {
  await fn();
  pass++;
}
console.log(`\nschedule: ${pass} passed`);
