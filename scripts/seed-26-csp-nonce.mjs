// 排期入库第 26 篇：CSP nonce 与缓存配对（teardown 机制拆解）。
// hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点自动上线。
// INSERT 直接带 html_content / cover_body，与 src/api.js 新建路径同口径。
// 用法：node scripts/seed-26-csp-nonce.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-26-csp-nonce.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

// 02-24 是 2 月最后一周的空档周，跳过，落到 03-03。
const p = {
  file: '26-csp-nonce-cache.md',
  slug: 'csp-nonce-cache',
  title: 'CSP nonce 每次请求都换，缓存里的旧页面怎么办：三处配对与一个 304',
  category: 'teardown',
  summary:
    'nonce 是每次渲染换、不是每个请求换：缓存命中回放整份配对快照。304 必须删掉 CSP 头，ETag 必须抹平 nonce，否则一个静默失效、一个命中率恒为零。',
  tags: ['security', 'cache', 'cloudflare'],
  at: '2027-03-03 01:00:00', // UTC，北京时间 03-03 09:00
};

const md = readFileSync(new URL(p.file, dir), 'utf8');
const html = sanitizeHtml(renderBody(md));
const coverBody = bodyCoverFor(md);
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-26-csp-nonce.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES (${q(p.slug)}, ${q(p.title)}, ${q(md)}, ${q(html)}, ${q(coverBody)}, ${q(p.category)}, ${q(p.summary)},
        '', 0, 0, 0, 1, ${q(p.at)}, datetime('now'), datetime('now'));

`;
for (const t of p.tags) {
  sql += `INSERT INTO tags (name) VALUES (${q(t)}) ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = ${q(p.slug)} AND t.name = ${q(t)};
`;
}

writeFileSync(new URL('./seed-26-csp-nonce.sql', import.meta.url), sql);
console.log(`${p.slug}: md ${md.length}B → html ${html.length}B，封面首图 ${coverBody ? '有' : '无'}`);
console.log(`生成 1 篇，${sql.length} 字节`);
