#!/usr/bin/env node
// 补内链（三篇旧文 → /p/three-layer-cache），生成 SQL 后由 wrangler 推远程。
// 只更新 content / html_content / updated_at，不动标题、时间、分类、封面。
//
// 用法：node scripts/patch-crosslinks-25.mjs > scripts/patch-crosslinks-25.sql
//       npx wrangler d1 execute blog-db --remote --file scripts/patch-crosslinks-25.sql
//
// 为什么同时写两个字段：读取侧优先用 html_content（src/index.js:1177），
// 只改 content 的话线上正文不会变。

import { readFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';

const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8)
  || new Date().toISOString().slice(0, 19).replace('T', ' ');

const TARGETS = [
  ['worker-render-549-to-96', '../content/13-worker-render-549-to-96.md'],
  ['ld-self-reference', '../content/22-ld-self-reference.md'],
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 补内链 → /p/three-layer-cache，由 scripts/patch-crosslinks-25.mjs 生成（${STAMP}）\n\n`;
for (const [slug, path] of TARGETS) {
  const md = readFileSync(new URL(path, import.meta.url), 'utf8');
  const html = sanitizeHtml(renderBody(md));
  out += `UPDATE posts SET content = ${q(md)}, html_content = ${q(html)}, updated_at = ${q(STAMP)} WHERE slug = ${q(slug)};\n`;
  out += `SELECT slug, instr(html_content, '/p/three-layer-cache') AS link_at, length(html_content) AS len, updated_at FROM posts WHERE slug = ${q(slug)};\n\n`;
}
process.stdout.write(out);
