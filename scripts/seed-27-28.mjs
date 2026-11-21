// 排期入库第 27/28 篇：两个前台交互的取舍实录（灯箱 / 主题过渡）。
// hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点自动上线。
// INSERT 直接带 html_content / cover_body，与 src/api.js 新建路径同口径。
// 用法：node scripts/seed-27-28.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-27-28.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

// 2 天一篇：接在 12-17 csp-nonce-cache 之后，12-19 / 12-21 收尾。
const posts = [
  {
    file: '27-lightbox-no-deps.md',
    slug: 'lightbox-no-deps',
    title: '无第三方库的图片灯箱：CSP nonce、SSR 不动、R2 原链路四条约束怎么同时守住',
    category: 'tools',
    summary:
      '78 行原生 JS 做灯箱，不装库、不碰 md.js、不多一次回源。选择器够用就别给 img 加 data-light——html_content 落库，改渲染要全量重算。currentSrc 复用 R2 已选图，上滑 64px 关闭，180ms 淡出在降噪下直接跳过。',
    tags: ['javascript', 'security', 'ssr', 'r2'],
    at: '2026-12-19 01:00:00', // UTC，北京时间 12-19 09:00
  },
  {
    file: '28-theme-transition-class.md',
    slug: 'theme-transition-class',
    title: '主题切换只闪一下：临时 class + transitionend 兜底，为什么常驻 transition 会闪首屏',
    category: 'tools',
    summary:
      '常驻 body transition 会让首屏和按需加载主题 CSS 时闪一下。改成切换时才挂的 html.theme-transition，只过渡颜色不动布局；transitionend 在异步加载/同色时不触发，留 400ms 定时兜底。无头 Chrome 默认降噪会让过渡测试误判。',
    tags: ['css', 'javascript', 'testing', 'debugging'],
    at: '2026-12-21 01:00:00', // UTC，北京时间 12-21 09:00
  },
];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-27-28.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径

`;
for (const p of posts) {
  const md = readFileSync(new URL(p.file, dir), 'utf8');
  const html = sanitizeHtml(renderBody(md));
  const coverBody = bodyCoverFor(md);
  sql += `INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
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
}

writeFileSync(new URL('./seed-27-28.sql', import.meta.url), sql);
console.log(`生成 ${posts.length} 篇，${sql.length} 字节`);
