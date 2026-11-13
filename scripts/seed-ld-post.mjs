// 单篇入库：hidden=0 + 未来 published_at，靠 liveSql 时间闸门到点上线。
// 用法：node scripts/seed-ld-post.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-ld-post.sql
import { readFileSync, writeFileSync } from 'node:fs';

const p = {
  file: '22-ld-self-reference.md',
  slug: 'ld-self-reference',
  title: '结构化数据里的自指：一个没人发现的 url 循环',
  category: 'log',
  summary:
    'isPartOf 的 url 填成了文章自己，8 篇系列文全中。这类错能打开、返回 200、工具不报警，只有写断言才抓得到。',
  tags: ['seo', 'http', 'debugging'],
  at: '2026-11-21 01:00:00', // UTC，北京时间 11-21 09:00
};

const content = readFileSync(new URL('../content/' + p.file, import.meta.url), 'utf8');
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-ld-post.mjs 生成，勿手改
INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES (${q(p.slug)}, ${q(p.title)}, ${q(content)}, ${q(p.category)}, ${q(p.summary)},
        '', 0, 0, 0, 1, ${q(p.at)}, datetime('now'), datetime('now'));
`;

for (const t of p.tags) {
  sql += `INSERT INTO tags (name) VALUES (${q(t)}) ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = ${q(p.slug)} AND t.name = ${q(t)};
`;
}

writeFileSync(new URL('./seed-ld-post.sql', import.meta.url), sql);
console.log(`生成 1 篇，${sql.length} 字节，正文 ${content.length} 字符`);
