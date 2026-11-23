/* 实测数字索引：把散在文章正文里的关键数字按栏目收成一张可检索的表。
 *
 * 为什么单独建模块而不是从正文正则抓：一个数字脱离上下文就是噪音。
 * 「96ms」在 8 篇文章里出现过，但只有 worker-render-549-to-96 里它指「并发改造后的渲染耗时」。
 * 每条必须手写三样 —— 值、含义、出处 slug —— 少一样就不收。这是「不编数字」的落地方式：
 * 数字本身来自已发表文章的正文，这里只做索引，不新增任何测量。
 *
 * 新增数字的规则：
 *   1. 必须能在对应文章正文里搜到该值（test-numbers.mjs 会连线上核对）；
 *   2. 口径写在 label 里，不写「延迟」这种无主语的词，写「D1 单行查询 p50」；
 *   3. 同类数字放同一 group，group 用栏目名或主题名，不按文章切。
 */

export const NUMBER_GROUPS = [
  {
    name: '工程实录',
    intro: '性能归因、报错对照、缓存与存储。数字来自 Server-Timing、wrangler tail、Chrome 与 bench 脚本。',
    rows: [
      { v: '549ms', label: '部署后第一发 Worker 耗时', slug: 'worker-render-549-to-96', note: '冷 isolate + 串行查询，其中冷启动约 370ms' },
      { v: '180ms', label: '同版本预热后（串行查询）', slug: 'worker-render-549-to-96', note: '两个独立 Worker 配对实验的旧版中位数' },
      { v: '84ms', label: '并发改造后 /cat/tools', slug: 'worker-render-549-to-96', note: '同批对照，CPU 仍为 5ms' },
      { v: '96ms', label: '配对实验省下的等待', slug: 'worker-render-549-to-96', note: '旧 180 − 新 84；三次串行往返被叠成一批' },
      { v: '4ms', label: 'LRU 缓存命中', slug: 'worker-render-549-to-96', note: '不进 Worker 渲染路径' },
      { v: '32ms', label: '单次 D1 往返反推值', slug: 'worker-render-549-to-96', note: '96ms ÷ 3；另一种口径的实测是 44.4ms p50' },
      { v: '182px', label: '两个筛选条推低首屏', slug: 'cls-empty-slots', note: '40px + 182px 两段，合计把正文推出视口' },
      { v: '0.0176', label: '首页 CLS 改造前', slug: 'cls-empty-slots', note: '改后为 0；文章页仍有 0.0147~0.0342' },
      { v: '336px', label: 'grid 里目录格原高度', slug: 'sticky-toc-grid-align-items', note: 'align-items:start 让它塌成内容高' },
      { v: '12939px', label: '改为 stretch 后父格高度', slug: 'sticky-toc-grid-align-items', note: 'sticky 的活动范围随之恢复' },
      { v: '86px', label: '滚到 35%/60%/95% 目录 top', slug: 'sticky-toc-grid-align-items', note: '三处采样均不漂移' },
      { v: '50 次', label: '免费计划单次请求 subrequest 上限', slug: 'workers-subrequest-limit', note: '串行 45 次成功、51 次抛错、200 次停在 50' },
      { v: '184ms', label: '并发 200 次 fetch 耗时', slug: 'workers-subrequest-limit', note: '同样停在 50，但只花 184ms' },
      { v: '800 次', label: 'D1 查询不占 subrequest 配额', slug: 'workers-subrequest-limit', note: '验证 D1 走绑定不算 fetch' },
      { v: '8 处', label: '线上 isPartOf 自指', slug: 'ld-self-reference', note: '补断言后归零' },
    ],
  },
  {
    name: '小工具',
    intro: '友链巡检、编辑器、图片链路、评论防线。数字来自线上响应、D1 计数与本机实测。',
    rows: [
      { v: '2026ms', label: '10 个友链站点串行检测', slug: 'worker-cron-friend-check', note: '同一轮并发版 332ms' },
      { v: '332ms', label: '10 个友链站点并发检测', slug: 'worker-cron-friend-check', note: '20 分钟一轮的 cron 实跑' },
      { v: '20 分钟', label: '友链巡检周期', slug: 'worker-cron-friend-check', note: '403 不算挂，连续多次失败才标记' },
      { v: '3 秒', label: '编辑器自动保存防抖', slug: 'editor-autosave', note: '另有 8 小时兜底与 5KB 本地快照' },
      { v: '12MB', label: '客户端上传体积上限', slug: 'r2-image-pipeline', note: '头像接口 4MB；服务端签名路径不验大小' },
      { v: '1.5KB', label: '列表卡片 WebP 缩略图', slug: 'r2-image-pipeline', note: '416×272；og:image 另用 1200×784 JPG' },
      { v: '10 条/天', label: '单 IP 评论限额', slug: 'comment-anti-spam', note: '另有 60 秒间隔；UTC+8 换天' },
      { v: '400', label: '蜜罐被填时的响应码', slug: 'comment-anti-spam', note: '不是 429：顺序在限额检查之前' },
      { v: '27 条', label: 'Markdown XSS 探针', slug: 'editor-markdown-xss', note: '探针只打印不判定；另有 13 条进 CI 的断言' },
    ],
  },
  {
    name: '存储与缓存',
    intro: 'bench 脚本在临时 Worker 上跑出的分位数，样本与口径见 bench-data.md。',
    rows: [
      { v: '44.4ms', label: 'D1 SELECT 1 的 p50', slug: 'd1-kv-r2-latency', note: '连空查询都一样慢，成本在固定往返' },
      { v: '3.6ms', label: 'KV 命中 p50', slug: 'd1-kv-r2-latency', note: '未命中 265.4ms，差 73 倍' },
      { v: '560.4ms', label: 'KV 写入 p50', slug: 'd1-kv-r2-latency', note: '比 D1 单行 UPDATE 慢 13 倍' },
      { v: '76.2ms', label: 'R2 GET 1KB p50', slug: 'd1-kv-r2-latency', note: 'R2 HEAD 74.0ms' },
      { v: '300s', label: 'HTML 的 s-maxage', slug: 'three-layer-cache', note: '配合 stale-while-revalidate=86400' },
      { v: '4h', label: '被 CF Cache Rule 改写成 4 小时的 TTL', slug: 'three-layer-cache', note: '两层口径不一致导致的实际值' },
    ],
  },
  {
    name: '协议拆解',
    intro: 'OAuth 系列与认证边界系列。这里的数字多是规范里的时间常量与实测窗口。',
    rows: [
      { v: '10 分钟', label: 'OAuth authorization code 典型有效期', slug: 'oauth-auth-code', note: '规范未强制，取决于授权服务器' },
      { v: '5 秒', label: 'Device Flow 轮询间隔', slug: 'oauth-device-flow', note: '对应 interval 字段；slow_down 需额外加 5 秒' },
      { v: '900 秒', label: 'device_code 默认有效期', slug: 'oauth-device-flow', note: '15 分钟' },
      { v: '8 小时', label: 'access token 常见有效期', slug: 'oauth-token-lifecycle', note: 'refresh token 90 天，两者不共用时钟' },
      { v: '3600 秒', label: '令牌过期校验里的一小时窗口', slug: 'oauth-token-lifecycle', note: '用于时钟偏移兜底' },
    ],
  },
  {
    name: '站务与工程预算',
    intro: '发版闸门、体积、可访问性。上线后的项目内指标，不是对外服务的性能。',
    rows: [
      { v: '142039 B', label: 'style.css 原始字节', slug: 'css-minimal-set-tradeoffs', note: '工作区 LF；455 个类名' },
      { v: '37626 B', label: 'style.css gzip -9', slug: 'css-minimal-set-tradeoffs', note: 'Node zlib 口径；预算 39000 B' },
      { v: '30119 B', label: 'style.css brotli', slug: 'css-minimal-set-tradeoffs', note: 'brotli 默认档' },
      { v: '54 个', label: 'grep 差集法误判的「死类」', slug: 'css-minimal-set-tradeoffs', note: '全是 SSR 插值类名，逐个核过' },
      { v: '14 组 × 9 对', label: '对比度断言覆盖', slug: 'contrast-assert', note: '6 套主题 × 明暗 = 14 组变量；126 个比值' },
      { v: '12 组', label: '修复前 --muted 踩线', slug: 'contrast-assert', note: '比值落在 4.16~4.49，阈值 4.5' },
      { v: '85/85', label: '线上体检通过项', slug: 'css-minimal-set-tradeoffs', note: 'check:live 的断言总数' },
      { v: '215ms', label: 'TTFB P50', slug: 'css-minimal-set-tradeoffs', note: '首页 LCP 桌面 244ms、移动 852~964ms' },
    ],
  },
];

// 这些 slug 指向的是存稿/新稿，上线前不算无效出处：listAllSlugs 会区分「已公开」与「待上线」。
export const PENDING_SLUGS = new Set([
  'css-minimal-set-tradeoffs',
  'contrast-assert',
  'three-layer-cache',
]);

export function allNumbers() {
  return NUMBER_GROUPS.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.name })));
}

export function numberStats() {
  const rows = allNumbers();
  return { groups: NUMBER_GROUPS.length, values: rows.length, slugs: new Set(rows.map((r) => r.slug)).size };
}
