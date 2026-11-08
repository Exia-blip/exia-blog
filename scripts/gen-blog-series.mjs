// 由 content/*.md 生成「自建博客实录」系列的 seed SQL。
// 用法：node scripts/gen-blog-series.mjs > scripts/seed-blog-series.sql
// 注意：库里 published_at 一律存 UTC。11-11 10:00 北京时间 = 11-11 02:00 UTC。
import { readFileSync } from 'node:fs';

const SERIES = '自建博客实录';
const AUTHOR = 1;
const STAMP = '2026-11-11 02:00:00';

// 后续 2/3、3/3 写成稿后往这里加一条，order 递增
const posts = [
  {
    slug: 'blog-markdown-xss',
    file: 'content/05-blog-markdown-xss.md',
    title: '自建博客实录 1/3：Markdown 渲染与白名单，怎么既放行代码块又不放行 XSS',
    order: 1,
    category: 'log',
    summary:
      'XSS 风险不在 Markdown，在把渲染结果当 HTML 插入那一刻。转义→代码块占位→白名单三道闸的顺序为什么不能换，九个 payload 的实测输出，以及两处正则漏洞（alt 属性注入、括号 URL 截断）的修前修后与回归用例。',
    tags: ['markdown', 'xss', 'security'],
  },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- ${SERIES}：自建博客实录（${posts.length} 篇）
-- 由 scripts/gen-blog-series.mjs 生成，重跑会覆盖正文与摘要

`;

for (const p of posts) {
  const md = readFileSync(p.file, 'utf8');
  out += `INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES (${q(p.slug)}, ${q(p.title)}, ${q(md)}, '', ${q(p.category)}, ${q(SERIES)}, ${p.order},
        0, 0, ${q(p.summary)}, 'manual', '', ${AUTHOR}, ${q(STAMP)}, ${q(STAMP)}, ${q(STAMP)})
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  series = excluded.series, series_order = excluded.series_order,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

`;
  for (const t of p.tags) out += `INSERT OR IGNORE INTO tags (name) VALUES (${q(t)});\n`;
  out += `\nDELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = ${q(p.slug)});\n`;
  out += `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN (${p.tags.map(q).join(', ')}) WHERE p.slug = ${q(p.slug)};\n\n`;
}

process.stdout.write(out);
