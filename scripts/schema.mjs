#!/usr/bin/env node
/**
 * D1 库结构的单一口径：从 migrations/ 解析出「应该长什么样」，和实际库比。
 *
 *   node scripts/schema.mjs check            比对线上实际结构与 migrations 期望
 *   node scripts/schema.mjs check --local    同上，比本地库
 *   node scripts/schema.mjs dump             打印线上实际结构（表 → 列）
 *   node scripts/schema.mjs expected         打印 migrations 解析出的期望结构
 *
 * 为什么需要这个东西：
 *   表结构过去是「写功能时顺手 ALTER 一下」长出来的，没有版本记录。结果三份描述互相漂：
 *   线上库（真跑着的）、schema.sql（db:init 用的）、代码里的 SQL（假设有哪些列）。
 *   2026-11-22 第一次跑这个脚本时实测到的漂移：
 *     · schema.sql 的 friends 缺 http_status / latency_ms，cron 写这两列会直接失败
 *     · schema.sql 有 idx_pv_day / idx_pv_path，线上根本没有
 *     · 线上有 idx_posts_published / idx_posts_series / idx_comments_ip，schema.sql 没有
 *   这些都不会报错、不会 500，只会在某天建新库或换账号时突然炸。
 *   漂移已在同次提交里修平，schema.sql 现在由 test-schema 锁着与 migrations 等价。
 *
 * 输出约定：ok / FAIL 前缀与 check-live 一致，任何缺表/缺列/缺索引 → 退出码 1。
 * 「库里多出 migrations 没写的列」只 warn 不失败：那可能是历史遗留，
 * 也可能是有人手工改过库 —— 需要人看一眼，不该阻断发版。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSchema, mergeSchema } from './sql-schema.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIG_DIR = join(ROOT, 'migrations');
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');

const args = process.argv.slice(2);
const cmd = args[0] || 'check';
const LOCAL = args.includes('--local');

let fails = 0;
const ok = (name, extra = '') => console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`);
const bad = (name, extra = '') => {
  fails++;
  console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`);
};
const warn = (name, extra = '') => console.log(`  warn ${name}${extra ? '  ' + extra : ''}`);

function dbName() {
  const cfg = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const m = cfg.match(/"database_name"\s*:\s*"([^"]+)"/);
  if (!m) {
    console.error('wrangler.jsonc 里读不到 database_name');
    process.exit(2);
  }
  return m[1];
}

function loadMigrations() {
  if (!existsSync(MIG_DIR)) {
    console.error('没有 migrations/ 目录');
    process.exit(2);
  }
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  const parts = files.map((f) => parseSchema(readFileSync(join(MIG_DIR, f), 'utf8'), f));
  return { files, schema: mergeSchema(parts) };
}

function query(sql) {
  const argv = [WRANGLER, 'd1', 'execute', dbName(), LOCAL ? '--local' : '--remote', '--json', '--command', sql];
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error((r.stderr || r.stdout || '').split('\n').slice(-8).join('\n'));
    console.error('查询失败。若是没登录：wrangler login');
    process.exit(2);
  }
  // wrangler 有时往 stdout 混提示行，取第一个 JSON 数组
  const start = r.stdout.indexOf('[');
  if (start < 0) {
    console.error('没拿到 JSON：', r.stdout.slice(0, 300));
    process.exit(2);
  }
  return JSON.parse(r.stdout.slice(start))[0].results || [];
}

function actualSchema() {
  const rows = query(
    `SELECT m.name AS tbl, p.name AS col
       FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table'
        AND m.name NOT LIKE 'sqlite_%'
        AND m.name NOT IN ('_cf_KV', 'd1_migrations')
      ORDER BY m.name, p.cid`
  );
  const tables = new Map();
  for (const r of rows) {
    const set = tables.get(r.tbl) || new Set();
    set.add(r.col);
    tables.set(r.tbl, set);
  }
  const idx = query(
    `SELECT name FROM sqlite_master
      WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  );
  return { tables, indexes: new Set(idx.map((r) => r.name)) };
}

const { files, schema: expected } = loadMigrations();

if (cmd === 'expected') {
  for (const [t, cols] of [...expected.tables].sort()) {
    console.log(`${t} (${cols.size} 列)`);
    console.log(`  ${[...cols].join(', ')}`);
  }
  console.log(`\n索引 ${expected.indexes.size} 个：${[...expected.indexes].sort().join(', ')}`);
  process.exit(0);
}

const actual = actualSchema();

if (cmd === 'dump') {
  for (const [t, cols] of [...actual.tables].sort()) {
    console.log(`${t} (${cols.size} 列)`);
    console.log(`  ${[...cols].join(', ')}`);
  }
  console.log(`\n索引 ${actual.indexes.size} 个：${[...actual.indexes].sort().join(', ')}`);
  process.exit(0);
}

console.log(`目标：${dbName()}（${LOCAL ? '本地' : '线上'}） · migrations ${files.length} 个文件\n`);

// 1. 期望的每一列都得在实际库里
for (const [t, want] of [...expected.tables].sort()) {
  const got = actual.tables.get(t);
  if (!got) {
    bad(`表 ${t}`, '库里不存在');
    continue;
  }
  const missing = [...want].filter((c) => !got.has(c));
  const extra = [...got].filter((c) => !want.has(c));
  if (missing.length) bad(`表 ${t} 缺列`, missing.join(', '));
  else if (extra.length) {
    ok(`表 ${t}`, `${want.size} 列`);
    warn(`表 ${t} 多出未记录的列`, extra.join(', '));
  } else ok(`表 ${t}`, `${want.size} 列`);
}

// 2. 库里有、migrations 完全没提的表
for (const t of actual.tables.keys()) {
  if (!expected.tables.has(t)) warn(`库里的表 ${t} 不在 migrations 里`, '历史遗留或手工建的');
}

// 3. 索引
for (const i of [...expected.indexes].sort()) {
  if (actual.indexes.has(i)) ok(`索引 ${i}`);
  else bad(`索引 ${i}`, '缺失（不影响正确性，但查询会退化成扫表）');
}
for (const i of actual.indexes) {
  if (!expected.indexes.has(i)) warn(`索引 ${i} 不在 migrations 里`);
}

console.log(
  fails
    ? `\nFAIL  ${fails} 项不一致`
    : `\nPASS  ${expected.tables.size} 张表 / ${expected.indexes.size} 个索引与 migrations 一致`
);
process.exit(fails ? 1 : 0);
