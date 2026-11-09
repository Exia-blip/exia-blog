// 由 content/08-editor-autosave.md 生成 seed SQL（改正文后重跑，不要手改 seed 文件）
// 用法：node scripts/gen-editor-autosave.mjs > scripts/seed-editor-autosave.sql
import { readFileSync } from 'node:fs';

const SLUG = 'editor-autosave';
const TITLE = '停手三秒就自动存了：自建编辑器的双保险保存是怎么实现的';
const CATEGORY = 'tools';
const AUTHOR = 1;
const TAGS = ['javascript', 'cloudflare', 'd1'];
// 库里一律存 UTC
const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || '2026-11-09 17:35:00';
const SUMMARY =
  '自动保存的难点不是存，是别存错：本地直写不防抖、云端 3 秒单句柄、响应带版本号才敢清 dirty。三个坑都是回头对代码翻出来的，附原样片段和修法。';

const md = readFileSync(new URL('../content/08-editor-autosave.md', import.meta.url), 'utf8');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 小工具：自建编辑器的自动保存（本地直写 + 云端防抖）
-- 由 scripts/gen-editor-autosave.mjs 生成，重跑会覆盖正文

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
