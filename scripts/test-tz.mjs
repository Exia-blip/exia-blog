#!/usr/bin/env node
/**
 * 时区换算测试。
 *
 * 这类 bug 有个共同特征：**99% 的时间是对的**。白天发文章，UTC 和北京时间
 * 同一天，切不切片都一样；只有北京时间 00:00–07:59 那 8 小时会差一天。
 * 所以测试必须把边界钉死，靠人工「看着没问题」是发现不了的。
 */
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

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
