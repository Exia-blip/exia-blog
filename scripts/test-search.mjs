// 搜索匹配条件的回归：标签名必须参与 LIKE，否则「按标签搜到文章」这条路永远不存在。
// 纯函数校验，不碰 D1 —— SQL 占位符和参数数量一旦走偏，COUNT 与列表查询（共用
// whereSql/args）会同时绑错，线上表现是「搜得到但总数不对」或直接绑定报错。
// 用法：node scripts/test-search.mjs
import assert from 'node:assert/strict';
import { searchMatch } from '../src/api.js';

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};

t('标题 / 正文 / 标签三路条件都进了 SQL', () => {
  const { sql } = searchMatch('cloudflare');
  assert.match(sql, /p\.title LIKE \?/, '缺标题分支');
  assert.match(sql, /p\.content LIKE \?/, '缺正文分支');
  assert.match(sql, /post_tags pt JOIN tags t/, '缺标签子查询');
  assert.match(sql, /t\.name LIKE \?/, '标签用的是精确匹配而非 LIKE');
});

t('子查询口径与现有 tag 过滤一致（post_tags.post_id）', () => {
  const { sql } = searchMatch('d1');
  assert.match(sql, /p\.id IN \(SELECT pt\.post_id FROM post_tags pt JOIN tags t ON t\.id = pt\.tag_id/);
});

t('占位符数量与参数数量一致（COUNT 和列表共用 whereSql）', () => {
  const { sql, args } = searchMatch('d1');
  const holes = (sql.match(/\?/g) || []).length;
  assert.equal(holes, 3, `SQL 里有 ${holes} 个 ?`);
  assert.equal(args.length, holes, '参数数量与占位符不符');
});

t('三个参数绑的是同一个 %关键词%', () => {
  const { args } = searchMatch('R2');
  assert.deepEqual(args, ['%R2%', '%R2%', '%R2%']);
});

t('空关键词不抛错，参数退化为 %%', () => {
  const { sql, args } = searchMatch('');
  assert.equal(typeof sql, 'string');
  assert.deepEqual(args, ['%%', '%%', '%%']);
});

t('中文关键词原样保留，不转义不改写', () => {
  const { args } = searchMatch('缓存');
  assert.equal(args[0], '%缓存%');
});

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
