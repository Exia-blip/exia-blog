// 入库第 57 篇：成功不是一个词（传输层成功掩盖业务层失败 / 会变的量当常量 / 停手条件）。
// 老板指定临时加发，published_at 钉在首次上线的 UTC 时刻（2026-11-25 15:46:12），不进 2 天排期表。
// 钉死而非取 new Date()：重放必须幂等，仓库记录要和线上事实同一个值（否则又是一次「看着改了其实漂移」）。
// 同时回补两条内链：11-comment-anti-spam（Turnstile 配了≠配对了）/ 13-worker-render-549-to-96（两个实验混成一个结论）。
// 用法：node scripts/seed-57.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-57.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

const post = {
  file: '57-success-but-not-through.md',
  slug: 'success-but-not-through',
  title: '接口说成功，业务其实没通：三种静默失败和一条停手线',
  category: 'log',
  summary:
    'wrangler 打印 Success 却写进空值、企微回 HTTP 200 加 errcode 93000、Turnstile 能弹框却拒收每一条评论：三件事形态相同——传输层的成功掩盖了业务层的失败。另记两种同构错误：把会变的量当常量写进代码（原文被再去重、扫描器少算 31 条、vars 锚点写死），以及停手条件（改坏输入先红才可停在 review，静默绿必须再加一层）。评论落库到触发通知仍是读码结论，明说没验。',
  tags: ['cloudflare', 'turnstile', 'testing', 'debugging'],
  at: '2026-11-25 15:46:12', // 首次上线的 UTC 时刻，重放幂等
};

const backlinks = ['11-comment-anti-spam.md', '13-worker-render-549-to-96.md'];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-57.mjs 生成，勿手改
-- 临时加发：published_at 钉在首次上线时刻 2026-11-25 15:46:12（UTC），重放幂等；hidden=0
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径

`;

const md = readFileSync(new URL(post.file, dir), 'utf8');
const html = sanitizeHtml(renderBody(md));
const coverBody = bodyCoverFor(md);

sql += `INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES (${q(post.slug)}, ${q(post.title)}, ${q(md)}, ${q(html)}, ${q(coverBody)}, ${q(post.category)}, ${q(post.summary)},
        '', 0, 0, 0, 1, ${q(post.at)}, datetime('now'), datetime('now'))
ON CONFLICT(slug) DO NOTHING;

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
console.log(`${post.slug}: md ${md.length} 字 → html ${html.length}B，封面首图 ${coverBody ? '有' : '无'}，published_at ${post.at}`);

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

writeFileSync(new URL('./seed-57.sql', import.meta.url), sql);
console.log(`SQL ${sql.length} 字节 → scripts/seed-57.sql`);
