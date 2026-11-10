// 由 content/10-r2-image-pipeline.md 生成 seed SQL（改正文后重跑，不要手改 seed 文件）
// 用法：node scripts/gen-r2-image-pipeline.mjs > scripts/seed-r2-image-pipeline.sql
import { readFileSync } from 'node:fs';

const SLUG = 'r2-image-pipeline';
const TITLE = 'R2 图片链路：上传走直传，读取走代理，svg 走沙箱';
const CATEGORY = 'tools';
const AUTHOR = 1;
const TAGS = ['cloudflare', 'r2', 'xss'];
// 库里一律存 UTC
const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || '2026-11-10 16:45:00';
const SUMMARY =
  '上传为什么直传 R2 而不经 Worker、正文为什么写 /img/ 而不给直链、toWebp 的 8% 门槛从哪来，以及写这篇文章时才发现漏掉的 SVG 沙箱——同一个文件加固前后的响应头都贴着。';

const md = readFileSync(new URL('../content/10-r2-image-pipeline.md', import.meta.url), 'utf8');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 小工具：R2 图片链路（直传 / 代理 / 封面兜底 / SVG 沙箱）
-- 由 scripts/gen-r2-image-pipeline.mjs 生成，重跑会覆盖正文

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES (${q(SLUG)}, ${q(TITLE)}, ${q(md)}, '', ${q(CATEGORY)}, '', 0,
        0, 0, ${q(SUMMARY)}, 'manual', '', ${AUTHOR},
        ${q(STAMP)}, ${q(STAMP)}, ${q(STAMP)})
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

`;

for (const t of TAGS) out += `INSERT OR IGNORE INTO tags (name) VALUES (${q(t)});\n`;
out += `\nDELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = ${q(SLUG)});\n`;
out += `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN (${TAGS.map(q).join(', ')}) WHERE p.slug = ${q(SLUG)};\n`;

process.stdout.write(out);
