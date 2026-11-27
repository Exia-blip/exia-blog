#!/usr/bin/env node
/**
 * 时区换算测试。
 *
 * 这类 bug 有个共同特征：**99% 的时间是对的**。白天发文章，UTC 和北京时间
 * 同一天，切不切片都一样；只有北京时间 00:00–07:59 那 8 小时会差一天。
 * 所以测试必须把边界钉死，靠人工「看着没问题」是发现不了的。
 */
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localParts, localDay, TZ_HOURS } from '../src/utils.js';

let pass = 0;
let fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL  ${name}\n        got  ${g}\n        want ${w}`);
  }
};

ok('时区常量', TZ_HOURS, 8);

// ——— 边界：UTC 15:59 还是同日，16:00 就跨到次日 ———
ok('UTC 15:59:59 同日', localDay('2026-11-11 15:59:59'), '2026-11-11');
ok('UTC 16:00:00 跨日', localDay('2026-11-11 16:00:00'), '2026-11-12');
ok('UTC 16:30 跨日', localDay('2026-11-11 16:30:00'), '2026-11-12');

// ——— 线上真实数据：这 6 篇原来都显示早一天 ———
const real = [
  ['2026-11-11 16:30:00', '2026-11-12'],
  ['2026-11-10 16:45:00', '2026-11-11'],
  ['2026-11-10 16:20:00', '2026-11-11'],
  ['2026-11-09 17:35:00', '2026-11-10'],
  ['2026-10-30 17:29:40', '2026-10-31'],
  ['2026-10-30 17:00:55', '2026-10-31'],
];
for (const [utc, want] of real) ok(`真实数据 ${utc}`, localDay(utc), want);

// ——— 跨年：这是归档分组最容易错的地方 ———
ok('跨年 12-31 16:30 → 次年', localDay('2026-12-31 16:30:00'), '2027-01-01');
ok('跨年分组年份', localParts('2026-12-31 16:30:00').y, '2027');
ok('跨年分组月份', localParts('2026-12-31 16:30:00').m, '01');
ok('跨年前一刻不跨', localDay('2026-12-31 15:59:00'), '2026-12-31');

// ——— 月末 / 闰年 ———
ok('月末 1-31 16:00 → 2-01', localDay('2026-01-31 16:00:00'), '2026-02-01');
ok('闰年 2-28 16:00 → 2-29', localDay('2024-02-28 16:00:00'), '2024-02-29');
ok('平年 2-28 16:00 → 3-01', localDay('2026-02-28 16:00:00'), '2026-03-01');

// ——— 输入形态 ———
ok('ISO 带 Z', localDay('2026-11-11T16:30:00Z'), '2026-11-12');
ok('ISO 带 +00:00', localDay('2026-11-11T16:30:00+00:00'), '2026-11-12');
ok('已是北京时间的偏移', localDay('2026-11-12T00:30:00+08:00'), '2026-11-12');
ok('空值', localDay(''), '');
ok('null', localDay(null), '');
ok('undefined', localDay(undefined), '');
ok('脏数据不崩', localDay('not-a-date'), 'not-a-date');

// ——— 组合字段 ———
const p = localParts('2026-11-11 16:30:45');
ok('parts.day', p.day, '2026-11-12');
ok('parts.md', p.md, '11-12');
ok('parts.y', p.y, '2026');
ok('parts.m', p.m, '11');
ok('parts.d', p.d, '12');
ok('parts.time', p.time, '00:30');

// ——— 一致性：localDay 必须等于 localParts().day ———
for (const [utc] of real) ok(`一致 ${utc}`, localDay(utc), localParts(utc).day);

// ——— [P-099] CI 夹具的时间不能被「跑 seed 的那一刻」带偏 ———
// 页面显示走 localDay(+8)，sitemap 的 lastOf 直接取 UTC 前 10 位。
// 种子若落在 UTC 16:00 后，两者差一天：2026-11-27 17:33 灌的库让
// check-sitemap 的 P-048 判据红过。夹具锚在 UTC 12:00，任何时刻执行都同一天。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const seedSql = execFileSync(process.execPath, [join(ROOT, 'scripts/seed-ci.mjs'), '--sql'], {
  encoding: 'utf8', cwd: ROOT,
});
const postsSql = (seedSql.split('INSERT INTO posts ')[1] || '').split('-- 评论：')[0];
const commentsSql = seedSql.split('-- 评论：')[1] || '';
ok('夹具 posts 块定位成功（判据输入非空）', postsSql.length > 100, true);
const anchored = [...postsSql.matchAll(/date\('now', '-\d+ days'\) \|\| ' 12:00:00'/g)].length;
ok('两篇文章的三个时间列都锚 UTC 12:00', anchored, 6);
ok('posts 块里没有裸 datetime(now)', /datetime\('now'/.test(postsSql), false);
const relative = [...commentsSql.matchAll(/datetime\('now', '-\d+ (?:hours|minutes)'\)/g)].length;
ok('两条评论仍用相对时间夹具', relative, 2);

// 行为验证，不只看源码长相：把夹具表达式交给 SQLite 求值，
// 再用显示层的 localDay 检查它取出来的日期和 sitemap 的 UTC 日期一致。
try {
  const db = new DatabaseSync(':memory:');
  const expr = (postsSql.match(/date\('now', '-\d+ days'\) \|\| ' 12:00:00'/) || [])[0] || "''";
  const v = db.prepare(`SELECT (${expr}) AS v`).get().v;
  ok(`夹具时间 ${v} 两处取日同天`, localDay(v), v.slice(0, 10));
  db.close();
} catch (e) {
  ok('夹具时间能被 SQLite 求值', e.message, '');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
