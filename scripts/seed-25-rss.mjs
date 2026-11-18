// 排期入库第 25 篇：RSS enclosure 封面图。
// hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点自动上线。
// INSERT 直接带 html_content / cover_body，与 src/api.js 新建路径同口径。
// 用法：node scripts/seed-25-rss.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-25-rss.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

// 02-24 是 2 月最后一周的空档周，跳过，落到 02-17。
const p = {
  file: '25-rss-enclosure-cover.md',
  slug: 'rss-enclosure-cover',
  title: 'RSS 阅读器卡片封面不显示：缺的是 enclosure，不是正文首图',
  category: 'tools',
  summary:
    '阅读器只读 <enclosure>，不读 content:encoded 里的图。17 个 item 加出 14 个封面：手动 cover 与正文首图进，通用预设图跳过。MIME 按真实后缀给，length 填 0。',
  tags: ['rss', 'http', 'debugging'],
  at: '2027-02-17 01:00:00', // UTC，北京时间 02-17 09:00
};

const md = readFileSync(new URL(p.file, dir), 'utf8');
const html = sanitizeHtml(renderBody(md));
const coverBody = bodyCoverFor(md);
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-25-rss.mjs 生成，勿手改
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

writeFileSync(new URL('./seed-25-rss.sql', import.meta.url), sql);
console.log(`${p.slug}: md ${md.length}B → html ${html.length}B，封面首图 ${coverBody ? '有' : '无'}`);
console.log(`生成 1 篇，${sql.length} 字节`);
