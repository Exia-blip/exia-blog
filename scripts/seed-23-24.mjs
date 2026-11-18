// 排期入库第 23/24 篇：相关推荐、搜索高亮。
// hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点自动上线。
// 与旧 seed 脚本的差别：INSERT 直接带 html_content / cover_body，读取侧永远命中成品，
// 不触发 backfill:check 的空行告警。
// 用法：node scripts/seed-23-24.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-23-24.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

// published_at 存 UTC；北京时间 09:00 = UTC 01:00。
// 01-20 pillar 之后：01-27 是 1 月最后一周（空档周），跳过，落到 02-03 / 02-10。
const posts = [
  {
    file: '23-related-posts.md',
    slug: 'related-posts',
    title: '相关推荐上线那天，排序逻辑根本没跑：post.tags 晚赋值 16 行',
    category: 'tools',
    summary:
      '代码写了「共同标签数 → 同栏目 → 时间新」三级排序，线上只跑两级。赋值顺序错让共同标签数恒为 0，纯函数单测 10 项全绿也没抓到。',
    tags: ['workers', 'd1', 'debugging'],
    at: '2027-02-03 01:00:00',
  },
  {
    file: '24-search-highlight.md',
    slug: 'search-highlight-xss',
    title: '搜索结果高亮的 <mark> 怎么不变成注入点：先切段，再逐段转义',
    category: 'tools',
    summary:
      '三路 SQL 让标签进结果集；前端 hl() 先切段、逐段 esc、再包 mark。c++ 直接 new RegExp 会抛错，先 esc 再匹配会让 & 失配。',
    tags: ['javascript', 'xss', 'security'],
    at: '2027-02-10 01:00:00',
  },
];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-23-24.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径
`;

for (const p of posts) {
  const md = readFileSync(new URL(p.file, dir), 'utf8');
  const html = sanitizeHtml(renderBody(md));
  const coverBody = bodyCoverFor(md);
  sql += `
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
  console.log(`${p.slug}: md ${md.length}B → html ${html.length}B，封面首图 ${coverBody ? '有' : '无'}`);
  sql += '\n';
}

writeFileSync(new URL('./seed-23-24.sql', import.meta.url), sql);
console.log(`生成 ${posts.length} 篇，${sql.length} 字节`);
