// 由 content/09-editor-markdown-xss.md 生成 seed SQL（改正文后重跑，不要手改 seed 文件）
// 用法：node scripts/gen-editor-markdown-xss.mjs > scripts/seed-editor-markdown-xss.sql
import { readFileSync } from 'node:fs';

const SLUG = 'editor-markdown-xss';
const TITLE = '实时预览敢让你敲 <script>：自研 Markdown 渲染器的「先转义后拼装」';
const CATEGORY = 'tools';
const AUTHOR = 1;
const TAGS = ['markdown', 'javascript', 'xss'];
// 库里一律存 UTC
const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || '2026-11-10 16:20:00';
const SUMMARY =
  '自研渲染器敢不引 sanitize 库，靠的是抠码→转义→拼装这个顺序。27 条探针的真实输出、两个被这篇文章逼出来的 bug、三个明说的缺陷，外加一个当年把 <a> 插进 alt 的历史事故。';

const md = readFileSync(new URL('../content/09-editor-markdown-xss.md', import.meta.url), 'utf8');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 小工具：自研 Markdown 渲染器的实时预览与 XSS 关
-- 由 scripts/gen-editor-markdown-xss.mjs 生成，重跑会覆盖正文

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
