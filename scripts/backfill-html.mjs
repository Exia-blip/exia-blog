#!/usr/bin/env node
// 把存量文章的正文渲染成 html_content / cover_body 写回 D1。
//
// 为什么要单独跑一次：html_content 是「发布时顺手存下来」的，而现有文章
// 都是加列之前入库的，读取侧会退回现算 —— 能跑，但每次回源都在烧 CPU。
// 这个脚本负责把历史账补齐，之后读取侧就永远命中成品。
//
// 用法：
//   node scripts/backfill-html.mjs              只补 html_content 为空的行
//   node scripts/backfill-html.mjs --all        全部重算（渲染逻辑改过之后用）
//   node scripts/backfill-html.mjs --dry        只打印统计，不写库
//   node scripts/backfill-html.mjs --local      打本地库（wrangler dev 的 D1）

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const argv = new Set(process.argv.slice(2));
const ALL = argv.has('--all');
const DRY = argv.has('--dry');
const LOCAL = argv.has('--local');
const DB = 'blog-db';

/* 直接跑 node_modules 里的 wrangler.js，不走 npx / .cmd。
   Windows 上 npx 是 .cmd，shell:true 会把带空格的 SQL 拆成十几个参数
   （第一次就栽在这：--command 后面的 SQL 被当成了列名列表）。 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const WRANGLER = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');

const wrangler = (args) =>
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/* wrangler 会把日志和 JSON 混着打到 stdout，从第一个 [{ 开始截，
   再取 results。进度条那几行不管，JSON.parse 会自己抛。 */
function d1Json(args) {
  const out = wrangler(args);
  const i = out.search(/\[\s*\{\s*"results"/);
  if (i < 0) throw new Error('取不到 JSON：' + out.slice(0, 300));
  return JSON.parse(out.slice(i));
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

console.log(`目标库：${DB}${LOCAL ? '（本地）' : '（线上）'}${DRY ? ' · dry run' : ''}\n`);

const rows = d1Json([
  ...(LOCAL ? ['--local'] : ['--remote']),
  '--json',
  '--command',
  "SELECT id, slug, content, html_content, cover_body FROM posts ORDER BY id",
])[0].results;

const todo = ALL ? rows : rows.filter((r) => !r.html_content);
console.log(`共 ${rows.length} 篇，待处理 ${todo.length} 篇${ALL ? '（--all 全量重算）' : '（其余已有 html_content）'}`);

if (!todo.length) {
  console.log('没有需要回填的行。');
  process.exit(0);
}

const updates = [];
let totalHtml = 0;
let totalMd = 0;
let emptyCover = 0;
const t0 = Date.now();

for (const r of todo) {
  const md = String(r.content || '');
  const html = sanitizeHtml(renderBody(md));
  const cover = bodyCoverFor(md);
  totalMd += md.length;
  totalHtml += html.length;
  if (!cover) emptyCover++;
  updates.push(
    `UPDATE posts SET html_content = ${q(html)}, cover_body = ${q(cover)} WHERE id = ${Number(r.id)};`
  );
  process.stdout.write(`\r  渲染 ${updates.length}/${todo.length}  ${r.slug}`.slice(0, 80).padEnd(80));
}

const ms = Date.now() - t0;
console.log(`\r  渲染完成 ${updates.length} 篇，耗时 ${ms}ms`.padEnd(80));
console.log(
  `  Markdown ${(totalMd / 1024).toFixed(0)}KB → HTML ${(totalHtml / 1024).toFixed(0)}KB` +
    `（体积 +${Math.round((totalHtml / Math.max(1, totalMd) - 1) * 100)}%）；${emptyCover} 篇没有正文首图`
);

if (DRY) {
  console.log('\ndry run：不写库。');
  process.exit(0);
}

/* 分批写：一条 UPDATE 里塞进整篇 HTML，27 篇一次发出去 SQL 文件会到几百 KB，
   wrangler 上传和 D1 解析都没必要扛这个。每批 8 条，失败能定位到批。 */
const BATCH = 8;
for (let i = 0; i < updates.length; i += BATCH) {
  const chunk = updates.slice(i, i + BATCH);
  const file = `.tmp-backfill-${i / BATCH}.sql`;
  writeFileSync(file, chunk.join('\n') + '\n');
  const args = ['--file=' + file, ...(LOCAL ? ['--local'] : ['--remote'])];
  try {
    wrangler(args);
    console.log(`  写入 ${Math.min(i + BATCH, updates.length)}/${updates.length}`);
  } finally {
    unlinkSync(file);
  }
}

const check = d1Json([
  ...(LOCAL ? ['--local'] : ['--remote']),
  '--json',
  '--command',
  'SELECT COUNT(*) AS n, SUM(CASE WHEN html_content = \'\' THEN 1 ELSE 0 END) AS empty FROM posts',
])[0].results[0];

console.log(`\n完成：${check.n} 篇，html_content 仍为空 ${check.empty ?? 0} 篇`);
if (check.empty > 0) {
  console.log('还有空行 —— 要么这批跳过了（已存在），要么 UPDATE 被截断，重跑一次看日志。');
  process.exitCode = 1;
}
