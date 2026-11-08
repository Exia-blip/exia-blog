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
  {
    slug: 'workers-subrequest-limit',
    file: 'content/06-workers-subrequest-limit.md',
    title: 'Workers 里 fetch 超时不是网络慢：subrequest 限额踩坑记',
    order: 4,
    // 免费计划实测：50 次封顶，第 51 次抛错；并发 200 次 184ms 就停，串行 851ms
    stamp: '2026-11-08 15:20:00',
    summary:
      'Too many subrequests 长得像超时，其实是调度配额：计数发生在 fetch 派发那一刻，本地 dev 还不复现。实测 45/51/200 次与并发、缓存的对照，以及四条按收益排序的修法。',
    tags: ['cloudflare', 'workers', 'debugging', 'javascript'],
  },
];

// 只生成某一篇：node scripts/gen-b-series.mjs --only=workers-subrequest-limit
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- ${SERIES}：B 类报错对照系列（第 1 篇是已有的 D1 那篇，这里把它并入系列）
-- 由 scripts/gen-b-series.mjs 生成，重跑会覆盖正文与摘要

`;

for (const p of posts.filter((x) => !ONLY || x.slug === ONLY)) {
  const md = readFileSync(p.file, 'utf8');
  const stamp = p.stamp || STAMP;
  out += `INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES (${q(p.slug)}, ${q(p.title)}, ${q(md)}, '', 'log', ${q(SERIES)}, ${p.order},
        0, 0, ${q(p.summary)}, 'manual', '', ${AUTHOR}, ${q(stamp)}, ${q(stamp)}, ${q(stamp)})
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
