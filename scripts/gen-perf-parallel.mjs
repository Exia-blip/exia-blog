// 由 content/13-worker-render-549-to-96.md 生成 seed SQL（改正文后重跑，不要手改 seed 文件）
// 用法：node scripts/gen-perf-parallel.mjs > scripts/seed-perf-parallel.sql
import { readFileSync } from 'node:fs';

const SLUG = 'worker-render-549-to-96';
const TITLE = 'Worker 渲染从 549ms 到 96ms：我只改了一件事';
const CATEGORY = 'log';
const AUTHOR = 1;
const TAGS = ['cloudflare', 'workers', 'd1', 'cache'];
// 库里一律存 UTC；周三 09:00 北京 = 01:00 UTC
const STAMP = process.argv.find((a) => a.startsWith('--stamp='))?.slice(8) || '2026-11-18 01:00:00';
// 发布前先隐藏：hidden=1 不进列表/RSS/sitemap，也不被索引
const HIDDEN = process.argv.includes('--hidden') ? 1 : 0;
const SUMMARY =
  '549 和 96 之间隔着两个变量：冷启动转热，和把五次串行往返压成一次。把旧提交部署成独立 Worker、两个 tail 同时抓、请求交替发，得到干净对照：/cat/tools 180→84ms，/tag/cloudflare 207→148ms，归档与文章页纹丝不动——因为它们不在那个 Promise.all 里。CPU 两版都是 5ms，省掉的全是等待。';

// Windows 上编辑器可能把文件写成 CRLF；库里统一 LF，否则渲染出来的围栏行尾会多出 \r
const md = readFileSync(new URL('../content/13-worker-render-549-to-96.md', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let out = `-- 工程实录：Worker 渲染 549→96ms 的真实归因（D1 串行改并发 + 缓存窗口）
-- 由 scripts/gen-perf-parallel.mjs 生成，重跑会覆盖正文

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES (${q(SLUG)}, ${q(TITLE)}, ${q(md)}, '', ${q(CATEGORY)}, '', 0,
        0, ${HIDDEN}, ${q(SUMMARY)}, 'manual', '', ${AUTHOR},
        ${q(STAMP)}, ${q(STAMP)}, ${q(STAMP)})
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = excluded.hidden,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

`;

for (const t of TAGS) out += `INSERT OR IGNORE INTO tags (name) VALUES (${q(t)});\n`;
out += `\nDELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = ${q(SLUG)});\n`;
out += `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN (${TAGS.map(q).join(', ')}) WHERE p.slug = ${q(SLUG)};\n`;

process.stdout.write(out);
