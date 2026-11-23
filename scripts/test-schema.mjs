#!/usr/bin/env node
/**
 * 库结构的离线断言：不需要网络、不需要 wrangler，进 npm test。
 *
 * 守四件事：
 *   1. migrations 文件可幂等重放（全部 IF NOT EXISTS），且不含没标注的破坏性语句
 *   2. schema.sql（db:init 用）与 migrations 等价 —— 两份描述不许漂
 *   3. 代码里 INSERT 的列，migrations 里都有 —— 这是最容易出事的一条：
 *      加了字段、忘了写迁移，线上会出现「no such column」
 *   4. 代码里用到的表，migrations 里都建了
 *
 * 与线上实际库的比对在 schema.mjs（需要 wrangler），两者共用 sql-schema.mjs 的解析。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSchema, mergeSchema, splitStatements, stripComments } from './sql-schema.mjs';
import { report } from './pitfall-check.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIG_DIR = join(ROOT, 'migrations');
const SRC_DIR = join(ROOT, 'src');

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
    const A = JSON.stringify(a);
    const B = JSON.stringify(b);
    if (A !== B) throw new Error(m || `${A} !== ${B}`);
  },
};

/* ---------- 读 migrations ---------- */
const migFiles = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

t('migrations 至少有一个文件', () => assert.ok(migFiles.length > 0, '空目录'));

t('文件名是 NNNN_名字.sql，且序号从 1 连续', () => {
  const nums = [];
  for (const f of migFiles) {
    const m = f.match(/^(\d{4})_[\w-]+\.sql$/);
    assert.ok(m, `格式不对：${f}`);
    nums.push(parseInt(m[1], 10));
  }
  nums.forEach((n, i) => assert.equal(n, i + 1, `序号断了：第 ${i + 1} 个是 ${n}`));
});

const migSources = migFiles.map((f) => ({ file: f, sql: readFileSync(join(MIG_DIR, f), 'utf8') }));

t('每条 CREATE TABLE / CREATE INDEX 都可重复执行（IF NOT EXISTS）', () => {
  for (const { file, sql } of migSources) {
    for (const stmt of splitStatements(stripComments(sql))) {
      if (/^CREATE\s+TABLE\b/i.test(stmt) && !/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(stmt)) {
        throw new Error(`${file}：${stmt.slice(0, 60)} 缺 IF NOT EXISTS`);
      }
      if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt) && !/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i.test(stmt)) {
        throw new Error(`${file}：${stmt.slice(0, 60)} 缺 IF NOT EXISTS`);
      }
    }
  }
});

t('不含未标注的破坏性语句（DROP / RENAME / 删列）', () => {
  for (const { file, sql } of migSources) {
    // 真要删就写 -- @allow-destructive 并在 PR 里说明，让这次删除是「有意识的」
    if (sql.includes('@allow-destructive')) continue;
    const bad = /^\s*(DROP\s+(?:TABLE|COLUMN|INDEX)|ALTER\s+TABLE\s+\w+\s+RENAME)/im.exec(stripComments(sql));
    assert.ok(!bad, `${file} 有破坏性语句：${bad && bad[0]}`);
  }
});

const expected = mergeSchema(migSources.map((s) => parseSchema(s.sql, s.file)));

/* ---------- schema.sql 与 migrations 等价 ---------- */
const schemaSql = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
const fromSchemaSql = parseSchema(schemaSql, 'schema.sql');

t('schema.sql 的表集合与 migrations 一致', () => {
  assert.deepEqual(
    [...fromSchemaSql.tables.keys()].sort(),
    [...expected.tables.keys()].sort(),
    '表对不上（db:init 建出来的库会缺表）'
  );
});

t('schema.sql 每张表的列与 migrations 一致', () => {
  for (const [tb, cols] of expected.tables) {
    const got = fromSchemaSql.tables.get(tb);
    assert.ok(got, `schema.sql 没有表 ${tb}`);
    assert.deepEqual([...got].sort(), [...cols].sort(), `表 ${tb} 列不一致`);
  }
}, 'P-007');

t('schema.sql 的索引与 migrations 一致', () => {
  assert.deepEqual(
    [...fromSchemaSql.indexes].sort(),
    [...expected.indexes].sort(),
    '索引对不上（少了 query 会扫表，多了是建库时的无用开销）'
  );
});

/* 上面几条只证明「文本层面一致」，证明不了「这些 DDL 真的建得出这套结构」。
   线上库早就存在，migrations 申请时 IF NOT EXISTS 全部跳过，语法对但列可能抄错 ——
   少写一列不会有任何报错，要等某天建新库才炸。这里用内存库真跑一遍：
   按顺序重放全部迁移，然后拿 SQLite 自己认定的结构跟解析结果对。 */
let DatabaseSync = null;
try {
  /* node:sqlite 到现在还是 experimental，import 时必打一行 stderr 警告。
     这里只屏蔽这一条，别把别的警告一起吞了。 */
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const msg = typeof w === 'string' ? w : w && w.message;
    if (/SQLite is an experimental feature/.test(String(msg))) return;
    return emit.call(this, w, ...rest);
  };
  ({ DatabaseSync } = await import('node:sqlite'));
  process.emitWarning = emit;
} catch {
  /* Node < 22.5 没有 node:sqlite，跳过这条（CI 用 22，跑得到） */
}

t('按顺序在空库里重放全部迁移，建出的结构与期望一致', () => {
  if (!DatabaseSync) return;
  const db = new DatabaseSync(':memory:');
  for (const { file, sql } of migSources) {
    try {
      db.exec(sql);
    } catch (e) {
      throw new Error(`${file} 执行失败：${e.message}`);
    }
  }
  const rows = db
    .prepare(
      `SELECT m.name AS tbl, p.name AS col
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`
    )
    .all();
  const built = new Map();
  for (const r of rows) {
    const set = built.get(r.tbl) || new Set();
    set.add(r.col);
    built.set(r.tbl, set);
  }
  for (const [tb, cols] of expected.tables) {
    const got = built.get(tb);
    assert.ok(got, `migrations 跑完没有表 ${tb}`);
    assert.deepEqual([...got].sort(), [...cols].sort(), `表 ${tb} 建出来的列与预期不符`);
  }
  const idx = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(idx, [...expected.indexes].sort(), '建出来的索引与预期不符');
  db.close();
});

/* ---------- 代码里的 SQL 与结构对得上 ---------- */
const code = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.js') && f !== 'assets.gen.js')
  .map((f) => readFileSync(join(SRC_DIR, f), 'utf8'))
  .join('\n');

/* 表值函数 / 系统表 / 别名，出现在 FROM 后面但不是我们的表 */
const NOT_TABLES = new Set([
  'sqlite_master', 'sqlite_schema', 'pragma_table_info', 'pragma_index_list',
  'json_each', 'json_tree', 'excluded', 'select',
]);

function codeTables() {
  const found = new Set();
  const add = (name) => {
    const n = name.toLowerCase();
    if (!NOT_TABLES.has(n)) found.add(n);
  };
  for (const m of code.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_]\w*)/gi)) add(m[1]);
  for (const m of code.matchAll(/\bUPDATE\s+([a-z_]\w*)\s+SET\b/gi)) add(m[1]);
  for (const m of code.matchAll(/\bDELETE\s+FROM\s+([a-z_]\w*)/gi)) add(m[1]);
  for (const m of code.matchAll(/\bFROM\s+([a-z_]\w*)\b(?!\s*\()/gi)) add(m[1]);
  return [...found].sort();
}

t('代码里用到的表都在 migrations 里', () => {
  const unknown = codeTables().filter((tb) => !expected.tables.has(tb));
  assert.deepEqual(unknown, [], `未建表：${unknown.join('、')}`);
});

t('代码里 INSERT 的列都在 migrations 里（加字段忘写迁移会在这里红）', () => {
  const problems = [];
  for (const m of code.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_]\w*)\s*\(([^)]*)\)/gi)) {
    const tb = m[1].toLowerCase();
    const cols = m[2].split(',').map((s) => s.trim().replace(/[`"[\]\s]/g, '')).filter(Boolean);
    const known = expected.tables.get(tb);
    if (!known) {
      problems.push(`${tb}: 表不存在`);
      continue;
    }
    for (const c of cols) {
      // 动态拼接的列名（${...}）跳过：解析不了就别误报
      if (c.includes('$')) continue;
      if (!known.has(c)) problems.push(`${tb}.${c}`);
    }
  }
  assert.deepEqual(problems, [], `代码写了但库里没有：${problems.join('、')}`);
});

/* ---------- 增量迁移的可读性 ---------- */
t('基线之后的新增迁移带注释说明意图', () => {
  for (const { file, sql } of migSources.slice(1)) {
    const hasComment = /^\s*--\s*\S/m.test(sql);
    assert.ok(hasComment, `${file} 没有一句注释，半年后没人知道为什么加`);
  }
});

console.log(`\nPASS  ${pass} passed, ${fails.length} failed  （schema / migrations）`);
if (fails.length) {
  console.log(fails.map((f) => '   · ' + f).join('\n'));
  process.exit(1);
}
