// 生成排期文章的入库 SQL：hidden=0 + 未来 published_at，靠 src/api.js 的 liveSql 时间闸门到点自动上线。
// 用法：node scripts/seed-scheduled.mjs && npx wrangler d1 execute blog-db --remote --file=scripts/seed-scheduled.sql
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../content/', import.meta.url);

// published_at 存 UTC；北京时间 09:00 = UTC 01:00
const posts = [
  {
    file: '14-three-layer-cache.md',
    slug: 'three-layer-cache',
    title: '三层缓存怎么排，才不会被 Cloudflare 改写成 4 小时',
    category: 'log',
    summary: '三层缓存各看一个头，配错一层症状完全不同：浏览器层被 zone 改写会让所有人都看不到更新。',
    tags: ['cache', 'cloudflare', 'http'],
    at: '2026-11-25 01:00:00',
  },
  {
    file: '15-jwt-exp-verify.md',
    slug: 'jwt-exp-verify',
    title: 'JWT 的 exp 到底在哪一层被校验',
    category: 'teardown',
    summary: 'exp 只是一条声明，失效与否取决于验签方有没有主动比那一次时间；本站的校验就漏了四格。',
    series: '认证边界',
    order: 1,
    tags: ['jwt', 'security', 'http'],
    at: '2026-12-02 01:00:00',
  },
  {
    file: '16-samesite-behavior.md',
    slug: 'samesite-behavior',
    title: 'SameSite 的三种取值，到底谁在什么时候带上 cookie',
    category: 'teardown',
    summary: 'SameSite 比的是 site 不是 origin；Lax 只在顶级导航 + 安全方法时带 cookie。',
    series: '认证边界',
    order: 2,
    tags: ['http', 'security', 'javascript'],
    at: '2026-12-09 01:00:00',
  },
  {
    file: '17-cors-preflight-cost.md',
    slug: 'cors-preflight-cost',
    title: 'CORS 预检不是每个请求都发：OPTIONS 的真实成本',
    category: 'teardown',
    summary: '加了 Access-Control-Max-Age 之后，7 秒间隔的三次跨域请求只花了一次预检。',
    series: '认证边界',
    order: 3,
    tags: ['http', 'security', 'javascript'],
    at: '2026-12-16 01:00:00',
  },
  {
    file: '18-turnstile-what-it-blocks.md',
    slug: 'turnstile-what-it-blocks',
    title: 'Turnstile 拦住了什么，没拦住什么',
    category: 'teardown',
    summary: 'Turnstile 测的是「有没有人类参与的证据」：挡得住脚本，挡不住真实浏览器和过了验证之后的行为滥用。',
    series: '认证边界',
    order: 4,
    tags: ['turnstile', 'security', 'cloudflare'],
    at: '2026-12-23 01:00:00',
  },
  {
    file: '19-workers-free-tier-limits.md',
    slug: 'workers-free-tier-limits',
    title: 'Workers 免费额度到底能撑多少人：把 10 万次/天换算成真实访问',
    category: 'log',
    summary: '静态资源不算 Worker 请求，这是免费额度能用很久的关键；真正的瓶颈是 10ms CPU 和 50 条 subrequest。',
    tags: ['cloudflare', 'workers'],
    at: '2027-01-06 01:00:00',
  },
  {
    file: '20-d1-kv-r2-latency.md',
    slug: 'd1-kv-r2-latency',
    title: 'D1、KV、R2 到底谁快：1100 次调用的实测分布',
    category: 'log',
    summary: 'D1 一切查询都是 44ms（连 SELECT 1 也是），KV 命中 3.6ms、未命中 265ms，R2 读比 D1 还慢。',
    tags: ['d1', 'r2', 'cloudflare', 'workers'],
    at: '2027-01-13 01:00:00',
  },
  {
    file: '21-workers-blog-pillar.md',
    slug: 'workers-blog-pillar',
    title: 'Cloudflare Workers 建站全流程',
    category: 'site',
    summary: '从域名到第一个 200，从 D1 到 R2，从 SSR 到三层缓存：这个站 20 篇的六段路径。',
    tags: ['cloudflare', 'workers', 'debugging'],
    at: '2027-01-20 01:00:00',
  },
];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let sql = `-- 由 scripts/seed-scheduled.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
`;

for (const p of posts) {
  const content = readFileSync(new URL(p.file, dir), 'utf8');
  sql += `
INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES (${q(p.slug)}, ${q(p.title)}, ${q(content)}, ${q(p.category)}, ${q(p.summary)},
        ${q(p.series || '')}, ${p.order || 0}, 0, 0, 1, ${q(p.at)}, datetime('now'), datetime('now'));

`;
  for (const t of p.tags) {
    sql += `INSERT INTO tags (name) VALUES (${q(t)}) ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = ${q(p.slug)} AND t.name = ${q(t)};
`;
  }
  sql += '\n';
}

writeFileSync(new URL('./seed-scheduled.sql', import.meta.url), sql);
console.log(`生成 ${posts.length} 篇，${sql.length} 字节`);
