// meta description / 搜索摘要的回归：这两处都是「看着有值、实际有坑」的类型。
// 摘要带换行、超长不截断、正文只有图片时返回空串 —— 三种都不会报错，
// 只是搜索结果里没有关键词、或者 Google 摘要栏被拦腰切在半个词上。
// 用法：node scripts/test-meta.mjs
import assert from 'node:assert/strict';
import { metaDesc, sqlIso } from '../src/utils.js';
import { extractExcerpt, searchSnippet } from '../public/md.js';

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};

/* ---------- metaDesc ---------- */
t('换行与连续空白压成单个空格', () => {
  assert.equal(metaDesc('第一行\n第二行\t\t 第三行'), '第一行 第二行 第三行');
});

t('超长截断到上限以内，并以省略号收尾', () => {
  const s = metaDesc('测'.repeat(400));
  assert.ok(s.length <= 156, `实际 ${s.length}`);
  assert.ok(s.endsWith('…'));
});

t('首位为空的文本退到兜底值', () => {
  assert.equal(metaDesc('   ', '站点描述'), '站点描述');
  assert.equal(metaDesc(undefined, '站点描述'), '站点描述');
});

t('首选与兜底都空时返回空串，不返回 undefined', () => {
  assert.equal(metaDesc('', ''), '');
  assert.equal(metaDesc(null, null), '');
});

t('未超长时不加省略号', () => {
  const s = '一句话摘要';
  assert.equal(metaDesc(s), s);
});

t('截断后不留在行尾的标点', () => {
  // 155 个字之后紧跟一个逗号，截断点正好落在逗号前
  const s = metaDesc('字'.repeat(154) + '，后面还有很多');
  assert.ok(!/[，,、；;：:]\s*…$/.test(s), `实际结尾 ${s.slice(-6)}`);
});

t('英文超长时在空格处断，不切半个单词', () => {
  const s = metaDesc('The quick brown fox jumps over the lazy dog. '.repeat(8));
  assert.ok(s.length <= 156);
  // 末尾应当是完整的词 + 省略号
  assert.ok(/[a-z]…$/.test(s), `实际结尾 ${s.slice(-12)}`);
});

/* ---------- sqlIso ---------- */
t('SQL 时间补成带 Z 的 ISO', () => {
  assert.equal(sqlIso('2026-11-06 08:00:00'), '2026-11-06T08:00:00Z');
});
t('已经是 ISO 的不重复加 Z', () => {
  assert.equal(sqlIso('2026-11-06T08:00:00Z'), '2026-11-06T08:00:00Z');
  assert.equal(sqlIso('2026-11-06T08:00:00+08:00'), '2026-11-06T08:00:00+08:00');
});
t('空值返回空串，给 datetime="" 用', () => {
  assert.equal(sqlIso(''), '');
  assert.equal(sqlIso(null), '');
});

/* ---------- searchSnippet ---------- */
const body = [
  '# 标题',
  '',
  '开头一段和关键词无关的铺垫文字，用来把关键词推到后面去。'.repeat(3),
  '',
  '```js',
  'const x = "PKCE 不该出现在代码块里";',
  '```',
  '',
  '真正的重点在这里：PKCE 补的是授权码被拦截之后的那段空隙。',
  '',
  '后面还有更多正文。'.repeat(10),
].join('\n');

t('关键词在正文深处时，摘要里确实包含它', () => {
  const s = searchSnippet(body, 'PKCE');
  assert.ok(s.includes('PKCE'), s);
});

t('摘要不是从正文开头切，命中点前有省略号', () => {
  const s = searchSnippet(body, '授权码');
  assert.ok(s.startsWith('…'), s.slice(0, 10));
  assert.ok(s.includes('授权码'));
});

t('代码块里的命中不算——那里不是给人读的正文', () => {
  const s = searchSnippet(body, '不该出现在代码块里');
  assert.equal(s, '');
});

t('没命中返回空串，调用方据此保留原摘要', () => {
  assert.equal(searchSnippet(body, '完全不存在的词'), '');
  assert.equal(searchSnippet(body, ''), '');
});

t('大小写不敏感，且摘要保留原文大小写', () => {
  const s = searchSnippet('前面铺垫 ' + 'x'.repeat(80) + ' 然后出现 Workers 这个词', 'workers');
  assert.ok(s.includes('Workers'), s);
});

t('extractExcerpt 仍是纯文本、不含 Markdown 标记', () => {
  const s = extractExcerpt(body, 5000);
  assert.ok(!s.includes('```'));
  assert.ok(!s.includes('#'));
});

console.log(`\n${pass} 通过，${fails.length} 失败`);
if (fails.length) process.exit(1);
