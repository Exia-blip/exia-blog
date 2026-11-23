// 入库第 55 篇：六条断言查了五条（材料对账 + 请求体闸门全面收口）。
// hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点上线（北京时间 2027-02-10 09:00）。
// 同时回补两条内链：comment-anti-spam / sticky-toc-grid-align-items 各加一句指向新文。
// 用法：node scripts/seed-55.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-55.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

const post = {
  file: '55-gate-only-covered-the-honest-half.md',
  slug: 'gate-only-covered-the-honest-half',
  title: '六条断言查了五条：材料把我们自己的 CI 当成了文章',
  category: 'log',
  summary:
    '材料列的六条断言里五条早就在 npm test 跑着：渲染器变异哨兵、isPartOf 自指、安全头逐指令、sticky 真机、/img/ nosniff；它还把蜜罐返回值写反了（本站 400，不是 200）。真缺口只有两个——请求体闸门只看 content-length 这条「声明」，15 个写入口里 14 个还在裸解析。统一走 readBody/readForm 后，线上分块推 1.1MB 在 413 处断流。',
  tags: ['cloudflare', 'security', 'testing'],
  at: '2027-02-10 01:00:00', // UTC，北京时间 2027-02-10 09:00
};

// 回补内链：这两篇的正文已经各自加了一句指向新文，这里把 HTML 与封面一起重算
const backlinks = ['11-comment-anti-spam.md', '12-sticky-toc-grid-align-items.md'];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-55.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径
-- 排期 2027-02-10（周三）09:00 北京时间，接在 monaco-eol-crlf（02-03）之后

`;

const md = readFileSync(new URL(post.file, dir), 'utf8');
const html = sanitizeHtml(renderBody(md));
const coverBody = bodyCoverFor(md);

sql += `INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES (${q(post.slug)}, ${q(post.title)}, ${q(md)}, ${q(html)}, ${q(coverBody)}, ${q(post.category)}, ${q(post.summary)},
        '', 0, 0, 0, 1, ${q(post.at)}, datetime('now'), datetime('now'))
ON CONFLICT(slug) DO NOTHING;

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

writeFileSync(new URL('./seed-55.sql', import.meta.url), sql);
console.log(`SQL ${sql.length} 字节 → scripts/seed-55.sql`);
