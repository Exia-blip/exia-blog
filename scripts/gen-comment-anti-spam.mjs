// 由 content/11-comment-anti-spam.md 生成 seed SQL（改正文后重跑，不要手改 seed 文件）
// 用法：node scripts/gen-comment-anti-spam.mjs > scripts/seed-comment-anti-spam.sql
import { readFileSync } from 'node:fs';

const SLUG = 'comment-anti-spam';
const TITLE = '评论区防滥用：蜜罐、Turnstile、D1 限额，按成本排序的三层';
const CATEGORY = 'tools';
const AUTHOR = 1;
const TAGS = ['cloudflare', 'turnstile', 'security'];
// 库里一律存 UTC
const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || '2026-11-11 16:30:00';
const SUMMARY =
  '垃圾评论的防线不靠模型，靠排序：视窗外的蜜罐先筛掉不跑 JS 的填表机，Turnstile 只在配了 key 时才发一个第三方请求，D1 用 IP 和设备两把钥匙算额度、按北京时间换天。附四类拒绝的线上实测响应，和六个明说的没做。';

const md = readFileSync(new URL('../content/11-comment-anti-spam.md', import.meta.url), 'utf8');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 小工具：评论区防滥用（蜜罐 / Turnstile / D1 限额 / 封 IP）
-- 由 scripts/gen-comment-anti-spam.mjs 生成，重跑会覆盖正文

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
