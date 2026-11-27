#!/usr/bin/env node
/**
 * 把 check-live 依赖的三篇固定夹具搬进本地，让线上体检能在本地全绿。
 *
 * 为什么单独做一份：seed-ci.mjs 造的是 UX 夹具（目录/横滚/评论折叠），
 * check-live 盯的是线上真实文章的标签交集、隐藏页首图、相对排序。
 * 本地库只有 17 篇，这三篇 404，五项断言就变成「没东西可测」——
 * 和空集恒真一样，不是通过，是没验。
 *
 * 只读线上 D1 与线上 /img/，写只落在本地；不碰线上数据。
 *
 * 用法（先起 wrangler dev）：
 *   npx wrangler dev --port 8787 --local --var SITE_ORIGIN:http://127.0.0.1:8787
 *   node scripts/seed-live-fixtures.mjs
 *   # 想连变体一起补，带上正在跑的 dev 地址：
 *   FIXTURE_LOCAL_ORIGIN=http://127.0.0.1:8787 node scripts/seed-live-fixtures.mjs
 *
 * 幂等：三篇按 slug 删掉重插，固定 id 9001~9003；本地 R2 里已有的原图不重传。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const ORIGIN = (process.env.FIXTURE_ORIGIN || 'https://miu.sryze.cc').replace(/\/$/, '');
const LOCAL_ORIGIN = process.env.FIXTURE_LOCAL_ORIGIN || '';
const SLUGS = ['post-brfy5', 'worker-cron-friend-check', 'worker-render-549-to-96'];
const IDS = { 'post-brfy5': 9001, 'worker-cron-friend-check': 9002, 'worker-render-549-to-96': 9003 };

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const run = (args, opts = {}) => execFileSync(process.execPath, [WRANGLER, ...args], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
});

/* wrangler 在 stdout 前面塞了一行带 ANSI 的代理告警，
   而且那行本身以 '[' 开头 —— 不能用 indexOf('[') 找 JSON。 */
function rowsOf(out) {
  const s = out.replace(/\x1b\[[0-9;]*m/g, '');
  const m = s.match(/\[\s*\{\s*"results"/);
  if (!m) throw new Error(`读不出 wrangler JSON：${s.slice(0, 300)}`);
  return JSON.parse(s.slice(m.index, s.lastIndexOf(']') + 1))[0].results;
}

const remoteRows = (sql) => rowsOf(run(['d1', 'execute', 'blog-db', '--remote', '--json', '--command', sql]));

/* ---------- 1. D1：文章 + 标签 ---------- */
const inList = SLUGS.map(q).join(',');
const COLS = [
  'id', 'slug', 'title', 'content', 'cover', 'summary', 'category', 'series',
  'series_order', 'is_private', 'hidden', 'author_id', 'published_at',
  'review_status', 'html_content', 'cover_body',
];
const posts = remoteRows(
  `SELECT ${COLS.join(',')} FROM posts WHERE slug IN (${inList}) ORDER BY slug`
);
if (posts.length !== SLUGS.length) {
  throw new Error(`线上夹具只找到 ${posts.length}/${SLUGS.length} 篇：${posts.map((p) => p.slug).join(',')}`);
}
const remoteIds = posts.map((p) => p.id);
const tagRows = remoteRows(
  `SELECT p.slug, t.name FROM posts p
   JOIN post_tags pt ON pt.post_id = p.id
   JOIN tags t ON t.id = pt.tag_id
   WHERE p.id IN (${remoteIds.join(',')}) ORDER BY p.slug, t.name`
);
const bySlug = new Map(posts.map((p) => [p.slug, p]));

/* 不加 BEGIN/COMMIT：wrangler 4 的本地 D1 会拒绝显式事务
   （让 storage.transaction() 自己管）。删了再插本身就是幂等的。 */
const sql = [`INSERT OR IGNORE INTO users (id, github_id, login, name, avatar, is_admin)
  VALUES (1, 'ci', 'ci', 'CI', '', 1);`];
for (const id of Object.values(IDS)) {
  sql.push(`DELETE FROM post_tags WHERE post_id = ${id};`);
  sql.push(`DELETE FROM comments WHERE post_id = ${id};`);
  sql.push(`DELETE FROM posts WHERE id = ${id};`);
}
sql.push(`DELETE FROM posts WHERE slug IN (${inList});`);
for (const p of posts) {
  const vals = COLS.map((c) => (c === 'id' ? IDS[p.slug] : q(p[c])));
  sql.push(`INSERT INTO posts (${COLS.join(',')}) VALUES (${vals.join(',')});`);
}
for (const t of tagRows) sql.push(`INSERT OR IGNORE INTO tags (name) VALUES (${q(t.name)});`);
for (const t of tagRows) {
  sql.push(`INSERT INTO post_tags (post_id, tag_id) SELECT ${IDS[t.slug]}, id FROM tags WHERE name = ${q(t.name)};`);
}

const tmp = mkdtempSync(join(tmpdir(), 'live-fixtures-'));
const sqlFile = join(tmp, 'seed.sql');
writeFileSync(sqlFile, sql.join('\n') + '\n', 'utf8');
run(['d1', 'execute', 'blog-db', '--local', `--file=${sqlFile}`]);
rmSync(sqlFile, { force: true });
console.log(`本地 D1：${posts.length} 篇文章 / ${tagRows.length} 条标签关系已就位`);

/* ---------- 2. R2 原图：线上 /img/ 拉下来，灌进本地桶 ---------- */
/* 正文里的 ?w= / ?h= 是展示参数，R2 的 key 不带 query，正则要在扩展名处收口。 */
const REF_RE = /\/img\/([A-Za-z0-9_][A-Za-z0-9_.\-/]*\.(?:png|jpe?g|webp))/gi;
const keys = new Set();
for (const p of posts) {
  for (const m of String(p.content || '').matchAll(REF_RE)) keys.add(decodeURIComponent(m[1]));
  if (/^\/img\//.test(p.cover || '')) keys.add(p.cover.slice('/img/'.length).split('?')[0]);
}
if (!keys.size) throw new Error('夹具正文里没有 /img/ 图片，首图 preload 那条仍会跳过');

const r2dir = join(ROOT, '.wrangler/state/v3/r2/miniflare-R2BucketObject');
const meta = readdirSync(r2dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
if (!meta) throw new Error('本地 R2 还没初始化，先跑一次 wrangler dev');
const db = new DatabaseSync(join(r2dir, meta));
const hasObject = db.prepare('SELECT 1 FROM _mf_objects WHERE key = ?');

let mirrored = 0;
for (const key of [...keys].sort()) {
  if (hasObject.get(key)) continue;
  const res = await fetch(`${ORIGIN}/img/${key}`);
  const type = res.headers.get('content-type') || '';
  if (!res.ok || res.headers.has('x-img-missing') || !type.startsWith('image/')) {
    throw new Error(`线上原图不可用：${key}（${res.status} ${type}）`);
  }
  const file = join(tmp, key.replace(/[\\/]/g, '_'));
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  run(['r2', 'object', 'put', `blog-images/${key}`, '--local',
    '--file', file, '--content-type', type, '-y']);
  rmSync(file, { force: true });
  mirrored++;
  console.log(`本地 R2：${key}`);
}
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`本地 R2：新增 ${mirrored} 张原图（已有 ${keys.size - mirrored} 张跳过）`);

/* ---------- 3. 变体：复用 make-variants 的同一套宽度档与判据 ---------- */
if (LOCAL_ORIGIN) {
  console.log(`\n补变体（VARIANTS_SITE=${LOCAL_ORIGIN}）`);
  execFileSync(process.execPath, [join(ROOT, 'scripts/make-variants.mjs'), '--local'], {
    cwd: ROOT, env: { ...process.env, VARIANTS_SITE: LOCAL_ORIGIN }, stdio: 'inherit',
  });
} else {
  console.log('\n未传 FIXTURE_LOCAL_ORIGIN，跳过变体。要补变体请带 dev server 地址重跑。');
}
