#!/usr/bin/env node
/**
 * 回填历史正文图片的宽高。
 *
 * 为什么要回填：图片没写 width/height 时，浏览器在下载完之前不知道该留多高，
 * 每张图落地都把下面的内容往下顶一次 —— 这就是 CLS。新上传的图已经由
 * /api/upload 把 w/h 拼进 URL 了（见 src/img-size.js），但库里已有的文章
 * 还都是裸路径，得跑一遍把尺寸补进去。
 *
 *   node scripts/backfill-img-size.mjs              # 本地 D1 + 本地 R2
 *   node scripts/backfill-img-size.mjs --remote     # 线上 D1 + 线上 R2
 *   node scripts/backfill-img-size.mjs --dry        # 只报告，不写库
 *
 * 幂等：已经带 ?w=&h= 的 URL 会跳过，重复跑不会叠加参数。
 * 读尺寸只读文件头几十个字节，不解码像素，也不依赖 sharp。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from '../src/img-size.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const DB = 'blog-db';
const BUCKET = 'blog-images';

const args = new Set(process.argv.slice(2));
const remote = args.has('--remote');
const dry = args.has('--dry');
const scope = remote ? ['--remote'] : ['--local'];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function wrangler(argv, opts = {}) {
  return execFileSync(process.execPath, [WRANGLER, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/* wrangler 的输出前面混着版本号、代理警告、日志路径，JSON 得靠首个 [ 定位 */
function jsonOf(text) {
  const i = text.indexOf('[');
  return i < 0 ? [] : JSON.parse(text.slice(i));
}

console.log(`回填图片尺寸（${remote ? '线上' : '本地'} D1 + R2）\n`);

const rows = jsonOf(
  wrangler([
    'd1',
    'execute',
    DB,
    ...scope,
    '--json',
    '--command',
    `SELECT id, slug, content FROM posts WHERE content LIKE '%/img/%' ORDER BY id`,
  ])
)[0]?.results || [];

if (!rows.length) {
  console.log('没有引用站内图片的文章，收工。');
  process.exit(0);
}

/* 匹配裸图片路径：后面不能紧跟 ?（已经带参数了）或另一个路径字符。
   只认站内 /img/ 下的常见图片扩展名，外链图和 data: 一律不碰。 */
const IMG_REF = /\/img\/[A-Za-z0-9._~\-\/%]+\.(?:png|jpe?g|webp|gif|avif)(?![\w?])/g;

const keys = new Set();
for (const r of rows) {
  for (const m of String(r.content || '').matchAll(IMG_REF)) {
    keys.add(m[0].replace(/^\/img\//, ''));
  }
}

console.log(`${rows.length} 篇文章引用 ${keys.size} 张不同的图，逐个读文件头…`);

const tmp = mkdtempSync(join(tmpdir(), 'imgsize-'));
const sizeOf = new Map(); // key → {w,h} | null

for (const key of keys) {
  const out = join(tmp, key.replace(/[/\\]/g, '_'));
  try {
    wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${out}`, ...scope], { stdio: 'ignore' });
    const sz = imageSize(readFileSync(out));
    sizeOf.set(key, sz);
    console.log(`  ${sz ? `${String(sz.w).padStart(4)}×${String(sz.h).padEnd(4)}` : '  ?  × ?   '}  ${key}`);
  } catch (e) {
    sizeOf.set(key, null);
    console.log(`  ✗ 读不到 ${key}（${String(e.message).split('\n')[0].slice(0, 60)}）`);
  }
}

const updates = [];
let touched = 0;

for (const r of rows) {
  const before = String(r.content || '');
  const after = before.replace(IMG_REF, (url) => {
    const sz = sizeOf.get(url.replace(/^\/img\//, ''));
    if (!sz) return url;
    touched++;
    return `${url}?w=${sz.w}&h=${sz.h}`;
  });
  if (after === before) continue;
  updates.push({ id: r.id, slug: r.slug, sql: `UPDATE posts SET content = ${q(after)} WHERE id = ${Number(r.id)};` });
}

rmSync(tmp, { recursive: true, force: true });

for (const u of updates) console.log(`  ~ ${u.slug}`);
console.log(`\n${touched} 张图补上尺寸，${updates.length} 篇文章要更新`);

const missing = [...sizeOf.entries()].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) console.log(`${missing.length} 张读不出尺寸（保持原样，页面不会写属性）：${missing.join(', ')}`);

if (!updates.length) {
  console.log('没有需要改的，收工。');
  process.exit(0);
}
if (dry) {
  console.log('\n--dry：只报告不写库。');
  process.exit(0);
}

const sqlFile = join(tmpdir(), `img-size-${Date.now()}.sql`);
const { writeFileSync } = await import('node:fs');
writeFileSync(sqlFile, updates.map((u) => u.sql).join('\n') + '\n', 'utf8');
try {
  wrangler(['d1', 'execute', DB, ...scope, `--file=${sqlFile}`], { stdio: 'inherit' });
} finally {
  rmSync(sqlFile, { force: true });
}
console.log(`\n完成：${touched} 张图带上宽高。`);
if (remote) console.log('线上是边缘缓存的，文章页几分钟内自然过期；急的话跑一次 deploy 带的清缓存。');
