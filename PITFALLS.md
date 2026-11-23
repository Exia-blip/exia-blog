# PITFALLS.md — 现象 → 根因 → 复现 → 断言 → 出处

规则：编号 `P-NNN` 一旦分配**永不复用**。每条固定五个字段、顺序不变；少一个字段，
半年后就看不懂它。断言字段必须写出**脚本名 + 可执行判定**，"检查 sticky"这类话不算断言。

`npm run check:pitfalls` 双向对账：脚本里出现的编号必须有文档条目（否则 fail），
文档里没人引用的编号只**警告**——那就是「已知但未自动化」，对应每篇文章末尾「明说的没做」。
排查时先按现象 grep 本文件，找到就跑断言字段里的命令，别重新从代码翻起。

---

## P-001 sticky 在 grid 里失效

- **现象**：目录滚两屏就跟着文章跑出视口，高亮却还在正常变。
- **根因**：`.post-article` 是 grid，目录那格写了 `align-items: start`，高度塌成内容高 336px；sticky 的活动范围以包含块为界，没有滚动余量。
- **复现**：窄屏 + 长文（> 8000 字），滚到 35%。
- **断言**：`npm run check:browser` → `check-toc-sticky.mjs` 输出 `[P-001]`，条件为 computed `position === 'sticky'` 且父格高度 > 视口高度 × 2、滚 1200px 后 `top` 不漂移。
- **出处**：《目录不跟着滚：sticky 在 grid 里失效，根因是 align-items 用了 start》，《EDITORIAL》排期 2026-11-13；`content/12-sticky-toc-grid-align-items.md`

## P-002 图片宽高缺失推高 CLS

- **现象**：首屏图片加载完，下方正文整块往下跳。
- **根因**：`<img>` 没写 `width` / `height`，浏览器按 0 高度排版，图片落地后才撑开；本站图片走 `/img/` 代理，尺寸在 SSR 时从 `cover_body` 带出。
- **复现**：清缓存后冷访问首页或文章页，观察 Cumulative Layout Shift。
- **断言**：`npm run check:dom` → `check-dom.mjs` 输出 `[P-002]`，条件为 `noDim.length === 0`（扫 SSR HTML 全部 `<img>` 的 `width` / `height`）；`check:live` 另有线上口径。
- **出处**：《CLS 从 0.0176 到 0：三个空位把首屏推了 182px》，《EDITORIAL》排期 2026-11-15（未入库）；`README.md` 可搬迁性章节

## P-003 登录格 / 筛选条等 JS 填充

- **现象**：首屏画完一两百毫秒后，栏目条、标签条或导航登录格整块往下推，窄屏实测 182px。
- **根因**：模板里留空 `<div>`，等 `app.js` 拉完 `/api/categories` 再 `innerHTML`；异步内容插进已排版的流里，CLS 必然回升。
- **复现**：4G + 4×CPU 节流，冷访问首页，录制 Layout Shift 归因。
- **断言**：`npm run check:dom` → `check-dom.mjs` 输出 `[P-003]`，条件为 `placeholders.length === 0`（匹配 `class` 含 `skeleton|placeholder|loading|js-fill` 的 `nav/div/section`）。
- **出处**：《CLS 从 0.0176 到 0：三个空位把首屏推了 182px》，《EDITORIAL》排期 2026-11-15（未入库）；`README.md` 栏目条服务端直出段

## P-004 五次串行往返

- **现象**：冷启动 `/cat/tools` 180ms、`/tag/cloudflare` 207ms，CPU 只有 5ms，时间全在等。
- **根因**：站点设置、栏目计数、标签云、列表查询、COUNT 一串 `await` 下来，每次 D1 往返 30~50ms 累加；互不依赖的查询被人为排成队列。
- **复现**：把旧提交部署成独立 Worker，两个 tail 同时抓、请求交替发；对照见文章原始数据。
- **断言**：`npm test` → `test-parallelism.mjs` 输出 `[P-004]`，条件为 `src/index.js` 存在 `Promise.all([siteP, catsP, tagsP])` 且 `listP` 在其之前发车、`src/api.js` 的 COUNT 与列表查询同批发出；构建期静态守，不依赖运行时抖动。
- **出处**：《Worker 渲染从 549ms 到 96ms：我只改了一件事》，《EDITORIAL》排期 2026-11-18；`content/13-worker-render-549-to-96.md`

## P-005 subrequest 计数在派发那一刻

- **现象**：数到 50 就停，提前返回也省不下来，加缓存不减，D1 查询也不占这 50。
- **根因**：免费计划 subrequest 是**请求派发那一刻的累计计数**，函数内没有实时计数 API；`cacheEverything` 不减，D1 走绑定不算 subrequest。往日志里写 0 是编数据。
- **复现**：cron 里 10 个站点串行 2026ms、并发 332ms，第二次跑仍从 50 起算。
- **断言**：`npm test` → `test-observe.mjs` 输出 `[P-005]`，条件为 `log.subrequests === null` 且 `log.cpuMs === null`（不可得就写 null，不编 0）；`src/cron.js` 的 `PER_RUN=40` 余量与逐跳上限 5 由 `test-cron.mjs` 守。
- **出处**：《（系列 4/4）Workers 里 fetch 超时不是网络慢：subrequest 限额踩坑记》，2026-11-08；`content/06-workers-subrequest-limit.md`

## P-006 isPartOf 自指

- **现象**：结构化数据校验报错，系列节点的 `isPartOf` 指向文章自己。
- **根因**：`isPartOf` 要的是「这个系列在哪」，填成了「这篇在哪」；`position` 属于文章节点，不属于系列容器。
- **复现**：`npm run check:ld` 对线上全量文章扫 JSON-LD。
- **断言**：`npm run check:ld` → 输出含 `[P-006]`，条件为 `isPartOf` 解析后的 URL 不等于当前文章 URL、且 `position` 在文章节点而非系列节点；`test-seo-series.mjs` 同口径本地守。
- **出处**：《结构化数据里的自指：一个没人发现的 url 循环》，2026-11-21（首次提交 11-14）；`content/22-ld-self-reference.md`

## P-007 no such table 两套库

- **现象**：本地建表成功、查询也成功，一到线上就 `D1_ERROR: no such table`。
- **根因**：不是 DDL 写错，是在 A 库建表、在 B 库查询——`wrangler d1 execute --local` 改 `.wrangler/state` 的模拟库，`--remote` 才是线上，两个库同名不同物。
- **复现**：本地 `schema:apply:local` 后不跑 `schema:apply` 就发版。
- **断言**：`npm test` → `test-schema.mjs` 输出含 `[P-007]`，条件为在 `node:sqlite` 空库重放全部 migrations 后，逐表逐列与 `schema.sql` 一致、代码 `INSERT` 的列都存在于迁移产物；`npm run check:schema` 在发版闸门复核远端。
- **出处**：《D1 报错 no such table 排查实录》，2026-11-03；`content/01-d1-no-such-table.md`

## P-008 渲染器转义顺序

- **现象**：Markdown 里一个带引号的 `alt`、一个 `data:` 链接，渲染后变成真属性。
- **根因**：先拼 HTML 后转义，或只对正文转义却把属性上下文漏掉；实体化的引号（`&quot;`）在标签内不是引号，反过来裸引号才是属性边界，正则一刀切会误报也会漏报。
- **复现**：`node scripts/probe-md.mjs` 跑 27 条 XSS 探针。
- **断言**：`npm test` → `test-md-snapshot.mjs` 输出 `[P-008]`，条件为 27 条渲染输出逐字符等于 `scripts/fixtures/md-snapshots.json` 且标签内引号状态机判无裸事件属性 / 危险 href / 裸 `<script>`。
- **出处**：《实时预览敢让你敲 `<script>`：自研 Markdown 渲染器的「先转义后拼装」》，《EDITORIAL》排期 2026-11-10；`content/05-blog-markdown-xss.md`

---

## 以下为既有坑续编号（编号分配后不再变动）

## P-009 CRLF 让 SRI 本地绿 CI 红

- **现象**：本地 `build:sri` 与 `npm test` 全绿，CI 4 连红在 integrity。
- **根因**：工作区 `w/crlf`、git 索引 `i/lf`；`build:sri` 按 CRLF 字节算哈希，CI checkout 按 `.gitattributes` 归 LF。
- **复现**：Windows 上把任一 public 资源写回 CRLF，再跑 CI。
- **断言**：`npm test` → `test-sri.mjs`「参与 SRI 的文件都是 LF 行尾」直读磁盘；`build-sri.mjs` 遇 CRLF 直接退出 1。
- **出处**：《CI 连红 4 次：本地绿、线上绿、CI 红，根因是 CRLF》，存稿 `content/29-crlf-sri-ci-red.md`

## P-010 103 preload 与 HTML href 差一个字符串

- **现象**：103 提前下的 CSS 没人用，冷访问白下 121KB。
- **根因**：preload 的 `?v=` 取部署号，HTML href 取内容哈希 `ASSET_HASH`，浏览器当成两个资源。
- **复现**：用 `?cb=` 绕缓存后 CDP 抓 103，比对两条 URL。
- **断言**：`npm run check:live` 逐字符比对 preload 地址与 HTML href；缓存命中时无 103 是正常态。
- **出处**：《103 Early Hints 提前下的 CSS 没人用：preload 和 HTML href 差了一个字符串》，存稿 `content/30-early-hints-preload-mismatch.md`

## P-011 审核态复用 hidden

- **现象**：投稿通过了还是不显示，待审却混进首页。
- **根因**：`hidden` 是作者自控开关，挡不住作者自己；`timeGateSql()` 与 `liveSql()` 混用让待审队列永远为空。
- **复现**：作者把待审稿的 `hidden` 改回 0，或管理员打开待审列表。
- **断言**：`npm test` → `test-admin-extras.mjs` 守 `review_status` 独立列、两个闸门分层与翻转条件；`test-comment-ssr.mjs` 守评论 `status='approved'` 过滤。
- **出处**：《投稿审核为什么不能复用 hidden：作者自控的开关挡不住作者自己》，存稿 `content/32-review-status-cache-bypass.md`

## P-012 SQL LIKE 通配符命中全表

- **现象**：搜 `%` 返回 17 篇（全表），搜 `_` 返回 14 篇。
- **根因**：`LIKE` 的通配符没转义，`%` 匹配一切、`_` 匹配单字符。
- **复现**：线上搜索框输入 `%` 或 `_`。
- **断言**：`npm test` → `test-security.mjs` 验 `\ % _` 三字符转义 + 三路 SQL 都带 `ESCAPE '\'`；`check:live` 有线上口径。
- **出处**：安全修复归档（站务记录，暂无独立文章）

## P-013 主题切换闪首屏

- **现象**：切主题时先白一下；`transitionend` 有时永远不触发，临时 class 摘不掉。
- **根因**：常驻 `body { transition }` 首屏就闪；主题 CSS 按需加载或前后同色时根本没有 transition 事件。
- **复现**：无头 Chrome 默认 `prefers-reduced-motion: reduce`，会短路整套逻辑——验交互前必须 simulate `no-preference`。
- **断言**：`npm test` → `test-ux-l3.mjs` + `npm run verify:editor` 真机断言；400ms `setTimeout` 兜底与 reduced-motion 硬开关都有专条。
- **出处**：《主题切换只闪一下：临时 class + transitionend 兜底，为什么常驻 transition 会闪首屏》，存稿 `content/28-theme-transition-class.md`

## P-014 备份 SQL 被公开下载

- **现象**：`/img/backups/d1.sql` 能当图片取走，正文与用户邮箱外泄。
- **根因**：备份和图片共用 `blog-images` 桶，`/img/` 代理直取 R2 对象且 key 无白名单，路径隐藏不算防护。
- **复现**：直接 GET `/img/backups/_manifest.json`。
- **断言**：`npm test` → `test-image-key-gate.mjs` 穷举 `backups/` 的大小写、编码、反斜杠绕过；`src/index.js` 的 `isPrivateImageKey()` 在 serveImage 入口挡住，线上返回 400。
- **出处**：站务记录（本文件，2026-11-23）

## P-015 对比度肉眼看着没问题

- **现象**：7 套主题 × 明暗里有 12 组 `--muted` 掉到 4.16~4.49:1，灰阶差一档肉眼看不出。
- **根因**：`--muted` 用在 11.5~14.5px 的日期、标签、面包屑，属正文级却按大字口径配了颜色。
- **复现**：`node scripts/check-contrast.mjs --verbose` 逐对看比值。
- **断言**：`npm run check:a11y` → `check-contrast.mjs` 验 14 组组合 × 9 对角色，`--muted` 调浅即 FAIL 退出 1。
- **出处**：《样式表也做减法：3KB 最小集的取舍与三个明说的没做》，草稿 `content/34-css-minimal-set-tradeoffs.md`

## P-016 本地 CI 命中旧 HTML 缓存

- **现象**：本地 `check:browser` 两组红——样式表 0 张、h1 回落到浏览器默认 32px、DOM 断言找不到新加的 aria-label。
- **根因**：Worker 的 LRU 命中改版前响应（日志 `cache:HIT`），Puppeteer / fetch 拿到旧模板，CSS `?v=` 也是旧哈希。
- **复现**：改 `public/index.html` 后立刻复用同一本地 Worker 跑浏览器断言。
- **断言**：`scripts/check-dom.mjs` 与 `scripts/check-css-baseline.mjs` 都在 URL 上挂 `?cb=`；断言失败时先看日志 cache 字段，别先改 CSS。
- **出处**：站务记录（本文件，2026-11-23）

## P-017 canonical 被当成外部资源

- **现象**：DOM 断言「无外部阻塞资源」恒红，报出 `exia.de5.net/`。
- **根因**：正则把任意 `<link href="https://...">` 都当外链请求，而 canonical / alternate 只是元信息，不发起 GET。
- **复现**：在 HTML 里放一条自指 canonical，用宽松正则扫 link。
- **断言**：`npm run check:dom` → 只匹配 `rel` 含 `stylesheet|preload|modulepreload|icon|manifest` 的 link 和 `<script src>`；canonical 不计入。
- **出处**：站务记录（本文件，2026-11-23）

---

## 每篇长文末尾的「复现条件 + 断言代码」模板

新写工程实录 / teardown 时，正文末尾附一段（可折叠或直接列）：

```md
### 复现条件

- 环境：<本机 / CI / 线上；Chrome 版本；主题与模式>
- 触发：<一条命令或一个操作序列>
- 期望：<现象>; 实际：<现象>

### 断言代码

\`\`\`bash
node scripts/test-xxx.mjs    # 断言名：…
\`\`\`
```

没有可运行断言的段落不写进「断言代码」——那只是叙述，不是资产。
