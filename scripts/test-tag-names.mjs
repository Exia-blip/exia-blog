#!/usr/bin/env node
/**
 * 标签名大小写归一 —— 三处必须同时到位，缺一处就还是「同一个标签两个地址」：
 *   ① 数据：migrations/0007 把存量 Cloudflare 并进 cloudflare，并建 NOCASE 唯一索引
 *   ② 写入：syncTags 必须先按 NOCASE 查已有 id（否则 INSERT OR IGNORE 被索引挡掉，
 *      精确 SELECT 查不到 → 标签静默丢失）
 *   ③ 读取：标签页过滤 / 「有没有公开文章」/ 后台合并接口都要 NOCASE，
 *      不然 /tag/Cloudflare 301 到小写后仍然只列一半文章
 *
 * 前两条用内存库真跑（node:sqlite），第三条读源码。纯离线，进 npm test。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { report } from './pitfall-check.mjs';
import { foldTags, tagAlias } from '../src/taxonomy.js';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIG_DIR = join(ROOT, 'migrations');

let pass = 0;
const fails = [];
const t = (name, fn, id = '') => {
  try {
    fn();
    pass++;
    report(id, name, true);
  } catch (e) {
    fails.push(name);
    report(id, name, false, e.message);
  }
};
const assert = {
  ok: (v, m = 'false') => { if (!v) throw new Error(m); },
  equal: (a, b, m = '') => { if (a !== b) throw new Error(m || `${a} !== ${b}`); },
  deepEqual: (a, b, m = '') => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    if (x !== y) throw new Error(m || `${x} !== ${y}`);
  },
};

const migFiles = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const normFile = migFiles.find((f) => /tag_name/.test(f));
const normSql = normFile ? readFileSync(join(MIG_DIR, normFile), 'utf8') : '';
const schemaSql = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
const apiSrc = readFileSync(join(ROOT, 'src/api.js'), 'utf8');
const lines = apiSrc.split('\n');
/* 行首锚定 + 唯一计数：注释里为讲清问题抄过错误写法，直接 indexOf 会搜到自己。 */
const hits = (re) => lines.filter((l) => re.test(l)).length;

t('迁移文件存在且建了 NOCASE 唯一索引', () => {
  assert.ok(normFile, '找不到 migrations/*tag_name*.sql');
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags\(name COLLATE NOCASE\)/.test(normSql),
    '迁移里没有 NOCASE 唯一索引');
  assert.ok(schemaSql.includes('idx_tags_name_nocase'), 'schema.sql 没同步这条索引（db:init 会建出没有约束的库）');
});

t('迁移做了「先并关联、再删重复行」两步', () => {
  /* 只删标签不并关联 = 文章丢标签；只并关联不删标签 = 标签云照样两条。 */
  const insert = hitsIn(normSql, /INSERT OR IGNORE INTO post_tags/);
  const delPt = hitsIn(normSql, /DELETE FROM post_tags WHERE tag_id IN/);
  const delTag = hitsIn(normSql, /DELETE FROM tags WHERE id IN/);
  assert.equal(insert, 1, `并关联语句 ${insert} 处，应为 1`);
  assert.equal(delPt, 1, `删关联语句 ${delPt} 处，应为 1`);
  assert.equal(delTag, 1, `删标签语句 ${delTag} 处，应为 1`);
});

t('写入路径按 NOCASE 查已有 id（否则标签静默丢失）', () => {
  const n = hits(/SELECT id FROM tags WHERE name COLLATE NOCASE = \?/);
  assert.ok(n >= 2, `只找到 ${n} 处 NOCASE 查询（syncTags 与后台合并接口各一处）`);
});

t('读取路径没有裸 name = ?（大小写不同会查不到）', () => {
  const legacy = hits(/t\.name = \?/);
  assert.equal(legacy, 0, `还有 ${legacy} 处 t.name = ?，应改成 t.name COLLATE NOCASE = ?`);
});

/* ---------- 内存库真跑：脏数据 + 迁移 = 合并干净 ---------- */
let DatabaseSync = null;
try {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const msg = typeof w === 'string' ? w : w && w.message;
    if (/SQLite is an experimental feature/.test(String(msg))) return;
    return emit.call(this, w, ...rest);
  };
  ({ DatabaseSync } = await import('node:sqlite'));
  process.emitWarning = emit;
} catch { /* Node < 22.5 没有 node:sqlite，跳过下面两条 */ }

t('脏数据跑迁移后只剩一条标签、关联不丢', () => {
  if (!DatabaseSync) return;
  const db = new DatabaseSync(':memory:');
  /* 只建这一对表：迁移里的合并语句只碰 tags / post_tags，其余表与本条无关。 */
  db.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);');
  db.exec('CREATE TABLE post_tags (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (post_id, tag_id));');
  db.exec("INSERT INTO tags (name) VALUES ('cloudflare'), ('Cloudflare'), ('workers');");
  /* 大写那条挂了两篇，小写挂一篇 —— 合并后 cloudflare 名下应有三条关联 */
  db.exec('INSERT INTO post_tags VALUES (1,2),(2,2),(3,1),(1,3);');

  db.exec(normSql);

  const names = db.prepare('SELECT name FROM tags ORDER BY id').all().map((r) => r.name);
  assert.equal(names.length, 2, `标签还剩 ${names.join(',')}，应只剩 cloudflare / workers`);
  assert.equal(names[0], 'cloudflare', `保留的是 ${names[0]}，应保留 id 最小的那条`);
  const links = db.prepare('SELECT COUNT(*) AS c FROM post_tags WHERE tag_id = 1').get().c;
  assert.equal(links, 3, `cloudflare 名下 ${links} 条关联，应为 3（1 条原有 + 2 条并入）`);

  /* 唯一索引真的在管事：再插任何大小写变体都要失败 */
  let threw = false;
  try { db.exec("INSERT INTO tags (name) VALUES ('CLOUDFLARE')"); } catch { threw = true; }
  assert.ok(threw, 'NOCASE 唯一索引没拦住 CLOUDFLARE');

  /* 幂等：迁移再跑一遍，行数与关联数不变 */
  db.exec(normSql);
  const again = db.prepare('SELECT COUNT(*) AS c FROM tags').get().c;
  assert.equal(again, 2, `重放后标签 ${again} 条，应为 2`);
  db.close();
});

t('NOCASE 查询能命中大小写不同的存量行', () => {
  if (!DatabaseSync) return;
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);');
  db.exec("INSERT INTO tags VALUES (1,'cloudflare'),(2,'Cloudflare');");
  /* 迁移前（还没合并）也必须能查到大写那条 —— 这条守的是查询侧兜底，
     即使有人跳过迁移直接上线，文章也不会丢标签。 */
  const row = db.prepare('SELECT id FROM tags WHERE name COLLATE NOCASE = ?').get('Cloudflare');
  assert.ok(row && row.id, 'NOCASE 查不到 Cloudflare');
  db.close();
});

/* ---------- 读取侧折叠：存量别名行不进标签云、不进 sitemap ---------- */
t('读取侧把别名行折成一条（cf + cloudflare）', () => {
  const out = foldTags([
    { name: 'cloudflare', count: 7 },
    { name: 'cf', count: 1 },
    { name: 'js', count: 2 },
    { name: 'javascript', count: 5 },
  ]);
  assert.deepEqual(out, [
    { name: 'cloudflare', count: 8 },
    { name: 'javascript', count: 7 },
  ]);
});

t('sitemap 的行字段（n/c/last）也能折，last 取最新', () => {
  const out = foldTags(
    [
      { n: 'cf', c: 1, last: '2026-01-01' },
      { n: 'cloudflare', c: 2, last: '2026-03-05' },
    ],
    { name: 'n', count: 'c', last: 'last' }
  );
  assert.deepEqual(out, [{ n: 'cloudflare', c: 3, last: '2026-03-05' }]);
});

t('路径别名只换名、不截断也不小写（截断会 301 到不存在的地址）', () => {
  assert.equal(tagAlias('CF'), 'cloudflare');
  assert.equal(tagAlias('server-timing'), 'server-timing');
  const long = 'a'.repeat(30);
  assert.equal(tagAlias(long), long, 'tagAlias 把长标签截短了');
});

function hitsIn(text, re) {
  /* 去掉整行注释再数：把语句注释掉是最常见的"撤掉修复"方式，
     注释里的同一行字面量会让计数照常通过 —— 那是假绿。 */
  return text.split('\n').filter((l) => !/^\s*--/.test(l) && re.test(l)).length;
}

console.log(fails.length ? `\n✗ ${fails.length} 项标签断言失败` : '');
process.exit(fails.length ? 1 : 0);
