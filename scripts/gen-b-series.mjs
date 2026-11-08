// 由 content/*.md 生成 B 类报错系列的 seed SQL。
// 用法：node scripts/gen-b-series.mjs > scripts/seed-b-series.sql
import { readFileSync } from 'node:fs';

const SERIES = 'Cloudflare 踩坑对照';
const AUTHOR = 1;
// 和 nowISO() 一致：库里一律存 UTC，别写本地时间，否则 JSON-LD 会出未来日期
const STAMP = '2026-11-08 14:50:00';

const posts = [
  {
    slug: 'wrangler-deploy-errors',
    file: 'content/02-wrangler-deploy-errors.md',
    title: 'wrangler deploy 失败对照：六条报错原文对应的真实原因',
    order: 2,
    summary:
      'deploy 失败的报错关键词就是阶段名：认证、配置、打包、上传发布。六条真实报错逐条对照根因与修法，附「部署成功但线上 500」的三步分诊。',
    tags: ['cloudflare', 'workers', 'debugging'],
  },
  {
    slug: 'workers-io-different-request',
    file: 'content/03-workers-io-different-request.md',
    title: 'Cannot perform I/O on behalf of a different request：Worker 里不能跨请求缓存的东西',
    order: 3,
    summary:
      '这条报错不是业务 bug，是把请求 A 的 I/O 对象交给了请求 B。模块作用域缓存 Response、复用 ASSETS.fetch 结果、waitUntil 留下引用，四种写法对照修法。',
    tags: ['cloudflare', 'workers', 'javascript'],
  },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- ${SERIES}：B 类报错对照系列（第 1 篇是已有的 D1 那篇，这里把它并入系列）
-- 由 scripts/gen-b-series.mjs 生成，重跑会覆盖正文与摘要

`;

for (const p of posts) {
  const md = readFileSync(p.file, 'utf8');
  out += `INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES (${q(p.slug)}, ${q(p.title)}, ${q(md)}, '', 'log', ${q(SERIES)}, ${p.order},
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

out += `-- 把已有的 D1 那篇并入系列（正文不动，只补系列归属）
UPDATE posts SET series = ${q(SERIES)}, series_order = 1 WHERE slug = 'd1-no-such-table';\n`;

process.stdout.write(out);
