// 排期入库第 29~33 篇：2026-11-22 当天做完的五件事，各写成独立可搜的题。
// hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点自动上线。
// INSERT 直接带 html_content / cover_body，与 src/api.js 新建路径同口径。
// 节奏：2 天冲刺段 12-21 出清后回落到每周三一篇，从 2027-01-06 起。
// 用法：node scripts/seed-29-33.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-29-33.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const dir = new URL('../content/', import.meta.url);

const posts = [
  {
    file: '29-crlf-sri-ci-red.md',
    slug: 'crlf-sri-ci-red',
    title: 'CI 连红 4 次：本地绿、线上绿、CI 红，根因是 CRLF',
    category: 'log',
    summary:
      '内容哈希对字节敏感。工作区 app.js 是 i/lf w/crlf，本地算的哈希与线上 CRLF 字节自洽，CI 按 .gitattributes checkout 出 LF 就对不上。浏览器 job 一直绿、只有单测红。build-sri 遇 CRLF 硬失败 + test-sri 直读磁盘补上两层防线。',
    tags: ['cloudflare', 'javascript', 'testing', 'debugging'],
    at: '2027-01-06 01:00:00', // UTC，北京时间 2027-01-06 09:00
  },
  {
    file: '30-early-hints-preload-mismatch.md',
    slug: 'early-hints-preload-mismatch',
    title: '103 Early Hints 提前下的 CSS 没人用：preload 和 HTML href 差了一个字符串',
    category: 'log',
    summary:
      '103 的 Link preload 取部署号，HTML href 取内容哈希，两个 URL 差一个字符串=两个资源。冷访问白下 121KB CSS，两份各缓存一份。修法是把出处换成同一份 ASSET_HASH，拿不到就不发；check-live 加逐字符比对守门。',
    tags: ['cloudflare', 'cache', 'http', 'debugging'],
    at: '2027-01-13 01:00:00', // UTC，北京时间 2027-01-13 09:00
  },
  {
    file: '31-d1-schema-migrations.md',
    slug: 'd1-schema-migrations',
    title: 'D1 表结构版本化：第一次跑检查就抓到三处漂移',
    category: 'teardown',
    summary:
      '线上库、schema.sql、代码里的 SQL 三份描述各说各话：friends 缺两列、schema 多两个索引、线上多三个索引。migrations 从线上 sqlite_master 导出做基线，全部 IF NOT EXISTS；node:sqlite 内存重放建出的结构必须与解析结果一致，手抄漏列也抓得到。',
    tags: ['d1', 'sqlite', 'cloudflare', 'testing'],
    at: '2027-01-20 01:00:00', // UTC，北京时间 2027-01-20 09:00
  },
  {
    file: '32-review-status-cache-bypass.md',
    slug: 'review-status-cache-bypass',
    title: '投稿审核为什么不能复用 hidden：作者自控的开关挡不住作者自己',
    category: 'teardown',
    summary:
      'hidden 是作者随时能改回 0 的开关，拿它当审核态等于没有审核。新增 review_status 三态，公开列表走 liveSql、管理队列走 timeGateSql；未过审的不进 LRU，否则作者预览一次匿名就能读缓存绕过闸门。四路实测：列表/单篇/SSR/RSS。',
    tags: ['security', 'sqlite', 'ssr', 'cache'],
    at: '2027-01-27 01:00:00', // UTC，北京时间 2027-01-27 09:00
  },
  {
    file: '33-monaco-eol-crlf.md',
    slug: 'monaco-eol-crlf',
    title: 'Monaco 空文档的 getEOL() 恒返回 CRLF，两个枚举值还相反',
    category: 'log',
    summary:
      '空文档的 model.getEOL() 恒为 CRLF，第一次插入多行模板就把 \\r 带进正文；工具栏偏移按 UTF-16 算，每个换行差 1 字符。更坑的是 EndOfLineSequence.LF=0、EndOfLinePreference.LF=1，写死 setEOL(1) 越修越糟。三处修法 + textarea 仍是数据源。',
    tags: ['editor', 'javascript', 'debugging'],
    at: '2027-02-03 01:00:00', // UTC，北京时间 2027-02-03 09:00
  },
];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-29-33.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径
-- 节奏：每周三一篇，从 2027-01-06 起（2 天冲刺段 12-21 已出清）

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

writeFileSync(new URL('./seed-29-33.sql', import.meta.url), sql);
console.log(`生成 ${posts.length} 篇，${sql.length} 字节`);
