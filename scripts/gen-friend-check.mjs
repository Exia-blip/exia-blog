// 由 content/07-worker-cron-friend-check.md 生成 seed SQL（改正文后重跑，不要手改 seed 文件）
// 用法：node scripts/gen-friend-check.mjs > scripts/seed-friend-check.sql
import { readFileSync } from 'node:fs';

const SLUG = 'worker-cron-friend-check';
const TITLE = '用 Worker Cron 做友链存活检测：20 分钟一轮，403 不算挂';
const CATEGORY = 'tools';
const AUTHOR = 1;
const TAGS = ['cloudflare', 'workers', 'd1', 'cache'];
// 库里一律存 UTC
const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || '2026-11-09 15:37:00';
const SUMMARY =
  '友链检测的四个坑都在这：一次 invocation 50 次 fetch 是累计计数、10 个站点串行 2026ms 并发 332ms、403 与 DNS 530 要分三态判、fetch 自己 zone 的域名回 522。附一个文件跑完的完整实现。';

const md = readFileSync(new URL('../content/07-worker-cron-friend-check.md', import.meta.url), 'utf8');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 小工具：Worker Cron 友链存活检测
-- 由 scripts/gen-friend-check.mjs 生成，重跑会覆盖正文

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES (${q(SLUG)}, ${q(TITLE)}, ${q(md)}, '', ${q(CATEGORY)}, '', 0,
        0, 0, ${q(SUMMARY)}, 'manual', '', ${AUTHOR},
        ${q(STAMP)}, ${q(STAMP)}, ${q(STAMP)})
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

`;

for (const t of TAGS) out += `INSERT OR IGNORE INTO tags (name) VALUES (${q(t)});\n`;
out += `\nDELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = ${q(SLUG)});\n`;
out += `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN (${TAGS.map(q).join(', ')}) WHERE p.slug = ${q(SLUG)};\n`;

process.stdout.write(out);
