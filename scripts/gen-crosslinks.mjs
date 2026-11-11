// 补内链：只更新正文与 updated_at，不动标题/发布时间/分类
// 用法：node scripts/gen-crosslinks.mjs > scripts/patch-crosslinks.sql
import { readFileSync } from 'node:fs';

const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8)
  || new Date().toISOString().slice(0, 19).replace('T', ' ');

const TARGETS = [
  ['editor-markdown-xss', '../content/09-editor-markdown-xss.md'],
  ['r2-image-pipeline', '../content/10-r2-image-pipeline.md'],
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 补内链（09 <-> 10），由 scripts/gen-crosslinks.mjs 生成\n\n`;
for (const [slug, path] of TARGETS) {
  const md = readFileSync(new URL(path, import.meta.url), 'utf8');
  out += `UPDATE posts SET content = ${q(md)}, updated_at = ${q(STAMP)} WHERE slug = ${q(slug)};\n`;
  out += `SELECT slug, length(content) AS len, updated_at FROM posts WHERE slug = ${q(slug)};\n\n`;
}
process.stdout.write(out);
