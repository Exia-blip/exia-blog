// 入库第 56 篇：两个都不报错的错（越界页码 200 + MAX 写成标量 + 500 出口两处）。
// hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点上线（北京时间 2027-02-17 09:00）。
// 同时回补两条内链预告：ld-self-reference（时间信号自相矛盾）/ d1-no-such-table（报错原文的分级）。
// 用法：node scripts/seed-56.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-56.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

const post = {
  file: '56-scalar-max-and-out-of-range-page.md',
  slug: 'scalar-max-and-out-of-range-page',
  title: '两个都不报错的错：越界页码 200，MAX 写成了标量',
  category: 'log',
  summary:
    '越界页码返回 200 的空页，每张都自称规范地址；MAX(a,b) 在 GROUP BY 里是标量函数，组内最新时间退化成组里某一行的时间，差 74 天。两条都不会报错——页面 200、sitemap 是合法 XML。修完还发现 500 的出口有两处，上一轮只改了一处，curl 拿到的仍是 D1_ERROR 原文。四条修复、五组断言，都在旧代码上验过会红。',
  tags: ['cloudflare', 'sqlite', 'seo'],
  at: '2027-02-17 01:00:00', // UTC，北京时间 2027-02-17 09:00
};

// 回补内链：正文里各加了一句指向新文的预告（不带 href，新文 2027-02-17 才开闸）
const backlinks = ['22-ld-self-reference.md', '01-d1-no-such-table.md'];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-56.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径
-- 排期 2027-02-17（周三）09:00 北京时间，接在 gate-only-covered-the-honest-half（02-10）之后

`;

const md = readFileSync(new URL(post.file, dir), 'utf8');
const html = sanitizeHtml(renderBody(md));
const coverBody = bodyCoverFor(md);

sql += `INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES (${q(post.slug)}, ${q(post.title)}, ${q(md)}, ${q(html)}, ${q(coverBody)}, ${q(post.category)}, ${q(post.summary)},
        '', 0, 0, 0, 1, ${q(post.at)}, datetime('now'), datetime('now'))
ON CONFLICT(slug) DO NOTHING;

-- 正文修订：改稿后重放一次，只覆盖正文与摘要，不动 published_at / hidden
UPDATE posts SET content = ${q(md)}, html_content = ${q(html)}, cover_body = ${q(coverBody)},
                 summary = ${q(post.summary)}, updated_at = datetime('now')
  WHERE slug = ${q(post.slug)};

`;
for (const t of post.tags) {
  sql += `INSERT INTO tags (name) VALUES (${q(t)}) ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = ${q(post.slug)} AND t.name = ${q(t)};
`;
}
console.log(`${post.slug}: md ${md.length} 字 → html ${html.length}B，封面首图 ${coverBody ? '有' : '无'}`);

for (const f of backlinks) {
  const m = readFileSync(new URL(f, dir), 'utf8');
  const h = sanitizeHtml(renderBody(m));
  const c = bodyCoverFor(m);
  sql += `-- 回补内链：${f}
UPDATE posts SET content = ${q(m)}, html_content = ${q(h)}, cover_body = ${q(c)}, updated_at = datetime('now')
  WHERE slug = ${q(f.replace(/^\d+-/, '').replace(/\.md$/, ''))};
`;
  console.log(`回补 ${f}: ${m.length} 字 → html ${h.length}B`);
}

writeFileSync(new URL('./seed-56.sql', import.meta.url), sql);
console.log(`SQL ${sql.length} 字节 → scripts/seed-56.sql`);
