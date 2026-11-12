// 由 content/12-sticky-toc-grid-align-items.md 生成 seed SQL（改正文后重跑，不要手改 seed 文件）
// 用法：node scripts/gen-sticky-toc.mjs > scripts/seed-sticky-toc.sql
import { readFileSync } from 'node:fs';

const SLUG = 'sticky-toc-grid-align-items';
const TITLE = '目录不跟着滚：sticky 在 grid 里失效，根因是 align-items 用了 start';
const CATEGORY = 'log';
const AUTHOR = 1;
const TAGS = ['css', 'javascript', 'debugging'];
// 库里一律存 UTC；周五 09:00 北京 = 01:00 UTC
const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || '2026-11-13 01:00:00';
// 发布前先隐藏：hidden=1 不进列表/RSS/sitemap，也不被索引
const HIDDEN = process.argv.includes('--hidden') ? 1 : 0;
const SUMMARY =
  '目录滚两屏就跟着文章跑出视口，高亮却还在正常变——不是 sticky 写错，是 grid 里那格只有 336px 高。把 align-items 从 start 改回 stretch，父格变成 12939px，滚到 35%/60%/95% 目录都停在 86px。附进度条、到底兜底、内部滚动、手机抽屉四处连带改动与实测数字。';

// Windows 上编辑器可能把文件写成 CRLF；库里统一 LF，否则渲染出来的围栏行尾会多出 \r
const md = readFileSync(new URL('../content/12-sticky-toc-grid-align-items.md', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 工程实录：侧边目录 sticky 失效（grid align-items）+ 四处连带修复
-- 由 scripts/gen-sticky-toc.mjs 生成，重跑会覆盖正文

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES (${q(SLUG)}, ${q(TITLE)}, ${q(md)}, '', ${q(CATEGORY)}, '', 0,
        0, ${HIDDEN}, ${q(SUMMARY)}, 'manual', '', ${AUTHOR},
        ${q(STAMP)}, ${q(STAMP)}, ${q(STAMP)})
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = excluded.hidden,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

`;

for (const t of TAGS) out += `INSERT OR IGNORE INTO tags (name) VALUES (${q(t)});\n`;
out += `\nDELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = ${q(SLUG)});\n`;
out += `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN (${TAGS.map(q).join(', ')}) WHERE p.slug = ${q(SLUG)};\n`;

process.stdout.write(out);
