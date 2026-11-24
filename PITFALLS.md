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

## P-018 只读开关关过头

- **现象**：出事时打开 `READONLY_MODE`，站点整片 503，连文章页都打不开——本来只想挡住写入。
- **根因**：开关写在业务 handler 里而不是入口，或者没排除 `GET/HEAD/OPTIONS`；再或者取值写成 `TRUE `（带空格）就静默不生效。
- **复现**：`READONLY_MODE=1` 后 `curl -s -o /dev/null -w '%{http_code}' /api/site`，应得 404（路由兜底），不该是 503。
- **断言**：`npm test` → `test-readonly.mjs` 输出 `[P-018]`：RO-03 写接口 503 且带 `retry-after` + `no-store`；RO-05 `GET/OPTIONS` 不被拦；RO-01 对 `1/true/on/yes` 与前后空格都认。
- **出处**：站务记录（本文件，2026-11-23）

## P-019 没验证过会失败的断言等于没写

- **现象**：27 条 XSS 探针全绿，但把 `esc()` 改成恒等函数、把协议白名单拆掉，测试依然全绿。
- **根因**：断言只比对「输出等于昨天的输出」，快照本身由被测代码生成——函数坏了，快照跟着坏，两边一起错就永远看不出来。
- **复现**：`node scripts/test-md-guard.mjs`，它自己就是复现：复制 `md.js` 做单点变异再跑同一批探针。
- **断言**：原版 0 违反；`esc` 失效至少红 5 条（实测 7）；`safeUrl` 白名单失效至少红 3 条（实测 3）；`s = esc(s);` 必须早于 `IMG_RE` / `LINK_RE` 替换——这一条是全文唯一的顺序断言。
- **第二例（2026-11-23，同一天）**：`test-headers.mjs` 的 `t()` 写成同步函数，而 `[P-028]` 那六条用例是 `async`——`await harden(...)` 抛的错变成 rejected promise，同步 `try/catch` 抓不到。于是那六条**永远是绿的**，包括它们该红的时候。靠四处注入才发现：注入 1/2/4 全部 0 FAIL，只有第 3 条（同步用例）红了。修法是把 `t()` 改成 `async` 并在调用处 `await`，改完四处注入全部变红。
  **这一例比第一例更值得记**：第一例是「快照跟着被测代码一起坏」，人还能通过读代码起疑；这一例是**断言本身在语法层面就失效了**，读代码看不出问题，dump 出来的输出全是 ok。唯一的发现途径就是注入——而这正是本条标题的意思。

- **出处**：站务记录（本文件，2026-11-23）

## P-020 CSP 与 Turnstile 脱钩

- **现象**：配好 Turnstile 两把 key，验证框一片空白、评论发不出去；控制台只有一行被 CSP 拦掉的 URL。
- **根因**：Turnstile 的组件在 iframe 里、校验走 XHR，`script-src` 放行了不等于能渲染——`frame-src` 少一个源就是白框，`connect-src` 少了就是「勾了也提交不了」。反过来，没配 Turnstile 时多放行这三个源，等于平白给第三方开三个口子。
- **复现**：`csp(nonce, { turnstile: true })` 之后删掉 `frame-src` 里的 `challenges.cloudflare.com`，页面依旧 200，只有浏览器控制台报错。
- **断言**：`npm test` → `test-security.mjs` 输出 `[P-020]`：开启时 `script-src` / `connect-src` / `frame-src` 三处都必须含该源；关闭时整条头里不许出现该字符串；`script-src` 不许出现 `unsafe-inline` / `unsafe-eval`（`style-src` 的内联是已知债务，单独断言）。
- **出处**：《评论区防滥用》`content/11-comment-anti-spam.md`；`src/security.js` 的 `csp()`

## P-021 管理员席位先到先得

- **现象**：部署到新环境后，第一个用 GitHub 登录的人自动变成管理员——不管他是谁。多实例 / 清库重来都会重开这个窗口。
- **根因**：`handleCallback` 里 `const isFirst = count.c === 0; ... isFirst ? 1 : 0`。注册入口对任何 GitHub 账号开放，于是"系统里第一个用户"这个条件等价于"最先到达的人"。Rin 的 `services/user.ts` 是同一处写法（同款硬伤）。
- **复现**：空库 + 配好 OAuth，用一个没见过的 GitHub 账号点登录 → `users` 表多一行且 `is_admin = 1`。
- **修法**：准入判定前移，`decideAccess(env, login, isFirst)` 统一决定"放不放行 + 放行后是不是管理员"；拒绝发生在 `INSERT INTO users` **之前**（名单外账号连行都不留）。`ADMIN_LOGINS` 配了就以它为准，每次登录同步回库，撤权不用等 30 天 token 过期。
- **断言**：`npm test` → `test-auth-policy.mjs` 输出 `[P-021]`：AP-13 抓 `INSERT` 里回退成 `isFirst ?`（注入即红）；AP-14 抓"先建行后拒绝"（注入即红）；AP-15 抓裸写 `author_id !== u.id && !u.is_admin`（api.js 与 index.js 都必须为 0 处）。
- **出处**：站务记录（本文件，2026-11-23）；Rin 对照见 `content/45-rin-permission-model.md`

## P-022 限流的判定不是原子的（已知边界，未修）

- **现象**：日上限写的是 10 条，但理论上并发能打成 10N。单条压测永远测不出来。
- **根因**：`guard()` 先 `SELECT` 读两把钥匙 → `judge()` 判定 → 评论插入 → `record()` 才累加。**累加是原子的**（`INSERT … ON CONFLICT(k) DO UPDATE SET hits = comment_guard.hits + 1`），**判定不是**——检查与累加之间有一个窗口，N 个并发请求可以同时读到 `hits=0` 并全部通过。
- **复现**：`hits=9`（上限 10）时同时发 20 条，会全部通过判定，最终 `hits=29`。当前线上过不去：Turnstile 未配置时也还需要越过蜜罐与 IP/设备双钥匙，且真实场景是博客评论。
- **为什么没修**：改成「先单语句原子占位、再写评论」会让被 400 拒掉的请求也计额度（真人填错邮箱被拒就少一次机会），而现有语义是「落库成功才计数」。两种语义都要原子，就得加事务或补偿删除——复杂度换一个需要并发 10 以上才成立的窗口，不划算。要真正收紧，正路是在边缘层做（WAF 速率限制），而不是在应用层加锁。
- **断言**：`npm test` → `test-antispam.mjs` 输出 `[P-022]`：`guard()` 体内不许出现 `INSERT`/`UPDATE`；`record()` 的 upsert 必须还是 `comment_guard.hits + 1`。**这条断言守的是「现状就是 check-then-act」这个事实**，不是「这样是对的」——哪天改成单语句原子占位，它会红，届时同步改本条措辞。
- **出处**：站务记录（本文件，2026-11-23）

## P-023 安全头「配了」不等于「守住了」

- **现象**：六条安全头从 2026-10 就在 `securityHeaders()` 里，但除了 CSP 与 nosniff，其余四条（HSTS / XFO / Referrer / Permissions）**一条断言都没有**。删掉任意一条，`npm test` 全绿，线上也看不出变化。
- **根因**：把「写进代码」当成「已经安全」。安全头是纯字符串，不会自己报错；它的失效方式是静默的——某次「顺手简化」删掉 `x-frame-options`，页面照常渲染，只有审计时才发现。
- **复现**：`scripts/test-headers.mjs` 的 7 处注入，任一处都能让断言变红（删 XFO → 红 2 条；Referrer 改 `unsafe-url` → 红 1 条；`base-uri` 改 `*` → 红 2 条；`object-src` 改 `'self'` → 红 1 条）。
- **断言**：`npm test` → `test-headers.mjs` 输出 `[P-023]`：HSTS `max-age >= 31536000` 且含 `includeSubDomains`；`nosniff` 在 HTML 与数据路径都必须在；XFO 必须 `DENY`；Referrer 不许 `unsafe-url`；Permissions-Policy 至少禁 `camera`/`microphone`/`geolocation`；COOP 必须 `same-origin`。`check-live` 另有 4 条守「线上真的发出来了」（代码设了但边缘吃掉，只有线上能测）。
- **出处**：站务记录（本文件，2026-11-23）

## P-024 X-XSS-Protection 写反了方向

- **现象**：老教程清一色写 `X-XSS-Protection: 1; mode=block`，照着抄等于把旧引擎的 XSS Auditor 打开。
- **根因**：那个 Auditor 会在某些反射场景下被诱导去删页面里合法片段，反而制造可利用面（OWASP 已改为建议 `0`）。现代浏览器已移除该功能，`1; mode=block` 只剩下对旧引擎的负收益。
- **复现**：`securityHeaders()` 里把它改回 `1; mode=block`，`test-headers.mjs` 立刻红两条（值断言 + 源码断言）。
- **修法**：显式 `h.set('x-xss-protection', '0')`。注意这是全站唯一一条「该有值、而值为 0」的头，写成「删掉不设」不安全——旧引擎会走它自己的默认行为。
- **断言**：`test-headers.mjs` 的 `[P-024]` 两条：返回值必须是 `'0'` 或缺省（不许 `1; mode=block`），且 `src/security.js` 里必须有 `x-xss-protection` → `'0'` 这一行。`check-live` 再守一条线上的值。
- **出处**：站务记录（本文件，2026-11-23）

## P-025 CSP 的松紧在两个方向都能错

- **现象**：CSP 出问题从来不是「有或没有」，而是两个方向相反的错误：漏一条指令（`base-uri`、`form-action`、`object-src`），或者多放一个源（Turnstile 没配却放行它、某处写成 `*`）。
- **根因**：CSP 是字符串，少一条和多一条都不报错。`default-src 'self'` 看上去已经收得很紧，但 `base-uri` 不归 `default-src` 管——注入一个 `<base href>` 就能把所有相对链接改向别处，而默认策略完全不管。
- **复现**：把 `object-src 'none'` 改成 `'self'`、把 `base-uri 'self'` 改成 `*`、给 `script-src` 加 `'unsafe-inline'`、删掉 `frame-ancestors 'none'`——四处注入各自变红。
- **断言**：`test-headers.mjs` 的 `[P-025]` 八条：`script-src` 必须带本次 nonce 且无 `unsafe-*`；`object-src` 必须 `'none'`；`base-uri` 必须存在且不是 `*`；`frame-ancestors` 必须 `'none'`；`form-action` 必须 `'self'`；任何指令不许出现裸 `*`；**未配 Turnstile 时一个字节都不许出现 `challenges.cloudflare.com`**；无 nonce 的路径不发 CSP 但其余头仍在。
- **出处**：站务记录（本文件，2026-11-23）；放行侧的一半见 P-020

## P-026 Cookie 属性没有断言 = 默认值随时会被「优化」掉

- **现象**：`setCookie()` 从第一天就带 `HttpOnly; SameSite=Lax; Secure`，但**没有任何脚本守着这三个词**。删掉 `HttpOnly`，登录照常、评论照常，线上零症状。
- **根因**：默认值是代码里的一串字符串字面量，不是平台保证。它离「被顺手简化」只差一次 refactor。
- **复现**：把 `'Path=/', 'HttpOnly', 'SameSite=Lax'` 改成 `'Path=/', 'SameSite=Lax'`，`test-headers.mjs` 立刻红一条，而 `npm run check:live` 完全无感（它不带 cookie 请求）。
- **断言**：`test-headers.mjs` 的 `[P-026]` 两条：`setCookie()` 必须含 `HttpOnly` / `Secure` / `SameSite=Lax|Strict` / `Path=/`；`clearCookie()` 额外必须有 `Max-Age=0`（退出用的那条更容易被忘）。
- **出处**：站务记录（本文件，2026-11-23）

## P-027 CORS 通配开一次就会扩散

- **现象**：`access-control-allow-origin: '*'` 一旦出现在某个接口上，下一个接口「照着写」的概率极高；配上 `allow-credentials` 更是直接被浏览器拒绝的无效组合。
- **根因**：通配本身不区分场景。PWA manifest 是公开静态数据、不带凭据，通配完全合理；带会话的接口通配就是把响应交给任意源读取。
- **复现**：在 `src/index.js` 再写一处 `access-control-allow-origin`，`test-headers.mjs` 立刻红（条数必须恰好 1，且那处必须在 manifest 附近）。
- **断言**：`test-headers.mjs` 的 `[P-027]`：源码里 ACAO 出现次数必须等于 1；全文不许出现 `allow-credentials`；唯一那处前后 400 字符内必须有 `manifest`。
- **出处**：站务记录（本文件，2026-11-23）

## P-028 nonce 与共享缓存并存，靠的是「可缓存页面零反射面」

- **现象**：首页与文章页 `s-maxage=300`、404 页 `s-maxage=60`，而它们都带 nonce。也就是说同一个 nonce 在窗口期内被所有访客共用。按「nonce 过的 HTML 绝不能进共享缓存」这条通行规则，本站是**违反**的。
- **根因**：这是有意识的取舍。全站 `no-store` 会让首屏回到每次回源，而本站的立身之本之一就是「首屏不回源」。既然要缓存，nonce 就必然被共享。
- **真正的安全性来自另一条**：**可缓存页面零反射面**。凡是回显用户输入的地方必须 `no-store` —— 搜索词与分页走 `harden()` 的 `search` 分支、后台走 `isAdminPath` 分支，都是双层（`cache-control` + `cdn-cache-control`）。当路径参数也参与回显时（`/tag/` `/p/` `/cat/`），线上实测是不存在的标签返回 404 且**不回显注入串**：`/tag/%3Cscript%3Ealert(1)%3C%2Fscript%3E` 的响应体里没有 `alert(1)`。
- **复现**：把 `harden()` 里 `else if (search)` 分支的两行 `no-store` 换回 `s-maxage=300` → `[P-028]` 第一条红；把 `applyNonce(...)` 的第二个参数换成 `makeNonce()`（另一个随机值）→ 第二条红，这正是「头里 `'nonce-A'`、HTML 里 `nonce="B"`」的典型错法，会导致页面所有脚本被 CSP 挡掉且只在浏览器控制台报错。
- **断言**：`npm test` → `test-headers.mjs` 的 `[P-028]` 六条：带 query（`?q=` `?page=` `?utm_source=` 三种）必须双层 `no-store`；后台 `/admin` `/editor` 必须 `private, no-store` + `cdn-cache-control`；CSP 里的 nonce 与 HTML 里每个 `nonce=` 属性逐字节相同且至少一个；nonce 是 32 位 hex 且两次响应不同；`cacheable` 源码里必须还有 `!url.search`；**可缓存的 HTML 仍然带 nonce**（反方向守，改动需同步本条与文章措辞）。
- **出处**：站务记录（本文件，2026-11-23）；`content/48-*.md`

## P-029 异步用例配同步 catch，断言永远绿

- **现象**：`test-headers.mjs` 的六条 `[P-028]` 用例全部 `async`（要 `await harden()`），而注册它们的 `t(name, fn)` 是同步函数：`try { fn(); } catch {}`。`fn()` 返回一个 rejected promise，异常根本进不了 `catch`。**六条断言从未真正执行过判断**，输出全是 `ok`。
- **根因**：`try/catch` 只捕同步异常。写成 `await fn()` 才有意义，`t` 也必须是 `async`，调用处必须 `await t(...)`。
- **复现**：四处注入 —— ①搜索页换回 `s-maxage=300`、②`applyNonce` 传另一个 nonce、④后台去掉 `private`，**全部 0 FAIL**（绿）；只有 ③（同步用例，删 `!url.search`）红了。修 `t()` 之后同样四处注入全部变红。
- **断言**：`test-headers.mjs` 的 `[P-029]` 读自身源码，要求 `t()` 是 `async` 且 `await t(...)` 出现 ≥ 20 次。把 `t` 改回同步后，脚本**直接崩**（未处理的 promise rejection 在 Node 15+ 是抛错退出），而不是变成静默绿——这仍然比一条红字更明显，但要清楚它守的是「不要退回旧写法」，守不住「新写的用例忘了 await」。后者仍然只能靠注入：**新写一条断言，先把它该抓的东西改坏一次，看着它红，再改回来**。
- **出处**：站务记录（本文件，2026-11-23）；同族见 P-019

## P-030 断言只认一种字面句式，反向写法照样漏网

- **现象**：`test-auth-policy.mjs` 的 `AP-15` 自称「裸判定已清零」，正则写的是 `author_id\s*!==\s*[a-z]+\.id\s*&&\s*![a-z]+\.is_admin` —— 只覆盖「先判作者不等、再判非管理员、用 `&&`」这一种写法。而 `src/index.js` 的 SSR 文章详情页写的是 `user.id === post.author_id || user.is_admin`（**等号、顺序相反、`||`**），两处闸门（预排与审核）连注释都写着「作者与站长例外」，断言却全绿。
- **根因**：把断言写成「匹配某个历史字符串」，而不是「定义一类语义」。历史字符串只有一个方向，代码有四个方向（`==`/`!=` × 左右两侧谁在左）。上一轮把 API 层的五处收口到 `ownerOrAdmin()` 之后，**只扫了 API 层**，SSR 路径整段没进视野——修一处不等于全站修完。
- **复现**：把 `src/index.js` 的 `if (!post.is_live && !ownerOrAdmin(user, post))` 改回 `if (!post.is_live && !(user && (user.id === post.author_id || user.is_admin)))`，旧正则 0 FAIL；新断言报 `index.js:1148` 并红。同一注入在 `api.js` 里则旧正则能抓到——差别只在写法方向。
- **断言**：`test-auth-policy.mjs` 的 `AP-15` 改为**白名单扫描**：遍历 `src/*.js` 全部文件，逐行找同时含 `.author_id`、(`.id` 或 `is_admin`)、(`===` 或 `!==`) 的行，**只有 `auth.js` 允许**（`ownerOrAdmin` 的实现点）。SQL 里的 `u.id = p.author_id` 是单等号，天然不命中，不需要额外排除表名。`AP-16` 守第二类散落：除 `auth.js` 外任何文件出现 `is_admin ? 'approved'` 即红。`AP-17` 守 `ownerOrAdmin` 的 null-safe（SSR 闸门已把 `user &&` 交给它）。
- **教训**：断言的粒度应当是「这个概念只许出现在这一个文件」，而不是「这个写法不许出现」。前者的失败信息自带行号与修法，后者只能证明你猜中了历史。
- **出处**：站务记录（本文件，2026-11-23）；`content/49-*.md`；同族见 P-019（顺序哨兵）、P-029（异步假绿）

## P-031 清缓存漏传维度，页面照样 200，只是停在上一版

- **现象**：`/api/review/:id` 放行一篇投稿时调的是 `bust(url, [p.slug], [], db)`，`/api/posts/:id/restore` 回滚版本时也是。第二个参数是 slug（文章本身），第三个参数是栏目（`/cat/<栏目>`）——**传的是空数组**。于是文章本体立刻更新，栏目列表页继续压着 300 秒的旧 HTML：投稿放行后作者点进栏目页看不见自己的文章，回滚改了栏目则新旧两个栏目页都错。
- **根因**：`bust()` 的签名是「受影响的 slug 集合 + 受影响的栏目集合 + db」，**漏传不报错**。它只决定「清哪几个 URL」，不决定「响应对不对」——所以 200、内容旧、5 分钟后自愈，人工验收永远抓不到。`CB-06` 守的是「四条写路径都挂了 bust」，守不住「参数传全了」；这两件事相差一个维度。
- **复现**：把 `api.js` 里审核那条改回 `bust(url, [p.slug], [], db)`，`node scripts/test-cache-bust.mjs` 的 `CB-10` 立刻红并报出行号；新写法通过。
- **断言**：`test-cache-bust.mjs` 的 `CB-10`：全文禁止 `bust(url, [<非空>], [])` 这个形状。凡是带具体文章 slug 的写入，必然影响它所属的栏目，第三参数不许为空。
- **教训**：清缓存的参数是「受影响的维度集合」，每加一个参与列表筛选的字段就多一个维度（栏目、标签、系列、可见性）。这类错误不会让任何一条响应变红，只会让内容慢 5 分钟上线——**所以它必须被静态形状断言守住，而不是被功能测试**。
- **出处**：站务记录（本文件，2026-11-23）；`content/50-*.md`

---

## P-032 目录一重排，四条断言一起失明，而且全绿

- **现象**：按 `features/<name>/` 垂直切片重排 `src/` 之后，`AP-15`（全站只许 `auth.js` 做「作者 or 管理员」判定）、`AP-16`（审核态只能由 `reviewStatusFor()` 生成）、`RB-03`（owner 模块文件存在）、`test-schema` 的「代码 INSERT 的列都在 migrations 里」**同时变成真空成立**。四条全是 `readdirSync(srcDir).filter(f => f.endsWith('.js'))`——只读一层，子目录里的文件根本不在集合里。
- **根因**：这四条断言证的是「扫到的文件里没有违规」，不是「该扫的都扫到了」。前者在扫描范围缩小时会自动变绿——**断言的有效性依赖一个从未被断言过的隐含契约：`src/` 是扁平的**。前两代假绿是「用例没执行」（P-029）和「只认一个方向」（P-030），这一代是「扫不到新位置」。
- **复现**：`mkdir -p src/_probe` 放一个 `evil.js`，内容 `return user && (user.id === post.author_id || user.is_admin);`，`node scripts/test-auth-policy.mjs` → **17/17 全绿**；同样在 `_probe/` 放一句 `INSERT INTO posts (slug, no_such_column_zz)`，`node scripts/test-schema.mjs` → 11/11 全绿。旧写法对子目录完全无感。
- **断言**：新增 `scripts/lib/src-walk.mjs`（`srcFiles` / `srcEntries` / `nativeSrcFiles`），四处扫描全部改用它；`test-auth-policy.mjs` 新增 `AP-18`：`srcFiles()` 必须与原生 `readdirSync(…, {recursive:true})` 逐条相等，且**每个子目录至少有一个 `.js` 进了扫描结果**——第二条在扁平结构下空转，拆分当天就红。
- **教训**：目录结构是断言的**输入**，所以它也必须被断言。任何「遍历某目录做检查」的断言，都要同时声明「遍历范围怎么算才对」；否则重构目录不是让测试变红，而是让测试变哑。改完实测：探针在位时 `AP-15` 报 `_probe/evil.js:2`、`test-schema` 报 `posts.no_such_column_zz`；删掉探针 → 18/18、11/11。
- **出处**：站务记录（本文件，2026-11-23）；`content/51-*.md`

---

## P-033 唯一能触发对外请求的两个端点，此前一条限流都没有

- **现象**：`/auth/github` 与 `/auth/callback` 全裸。前者把浏览器 302 到 GitHub 授权页，后者往下是 1~3 次到 `github.com` / `api.github.com` 的 `fetch`（token 交换、`/user`、条件性 `/user/emails`）。全站别的入口都有闸门——评论有三层（蜜罐 / D1 限额 / Turnstile）、写接口有 `readJsonLimited` 与只读开关——只有登录没有。
- **根因**：登录被当成「低频操作，不用管」。但限流要防的不是频率，是**成本落点**：刷这两个端点不花本站一分钱 CPU 之外的东西，花的是 GitHub 的额度。刷到 GitHub 对本站 `client_id` 触发滥用限流，真实用户就登不进来了——一次针对第三方的转嫁式拒绝服务。同时 `handleCallback` 的每次调用都是一次外部可触发的出站请求，`state` 只挡「没先走 `/auth/github`」的人，挡不住愿意先走一遍的脚本。
- **复现**：`curl -i https://<站>/auth/github` 连发 100 次，旧版全部 302 到 GitHub，一次 429 都没有。旧版 `auth.js` 里搜不到任何 `429` / `limit` / `throttle`。
- **断言**：`scripts/test-login-guard.mjs` 十条（LG-01~10）。判据刻意不做「源码里出现 429」这种字面匹配（P-030 同族），能测行为就测行为：假 D1 + 假 `Request` 直接跑 `guardLogin`，验 key 前缀、日上限、跨天重置、封禁、upsert 形状；只有「两个入口都接了吗」「计数在 fetch 之前吗」这种跨函数性质才退回源码切片。
- **教训**：限流的 key 只能取 `cf-connecting-ip`。本站 `src/stats.js` 原来有一条 `|| x-forwarded-for` 回退——那个头请求方随便写，拿它当 key 等于每个请求一个新桶，限流形同不存在。现在全站统一走 `utils.js` 的 `clientIp()`，`LG-04` 只认「读这个头」的三种写法，裸词不误伤注释。另一条：**评论的额度在落库成功后记，登录的额度必须在发起尝试时记**——登录尝试本身就有出站成本，失败不计数等于用无效 code 无限刷。
- **出处**：站务记录（本文件，2026-11-23）；`content/52-*.md`；同族见 P-021（准入策略）、P-022（Turnstile）

---

## P-034 扫描改递归之后，下一个故障是「假红」

- **现象**：按 `src/features/` 垂直切片重排时，测试目录通常跟着进 `src/`（`src/__tests__/auth.spec.js`）。此时 `AP-15`（权限判定只许在 `auth.js`）会把测试文件里那句 `user.id === post.author_id || user.is_admin` 判成一处在线的越权——**报错，但线上什么问题都没有**。
- **根因**：`P-032` 修的是「扫不到」（假绿），修法是把扫描范围扩到全递归；而扫描的判据仍然是「文件里有没有这串字符」，没有区分「这是产品代码」还是「这是用来描述产品代码的测试」。递归一旦生效，测试文件必然进视野，而测试里写 `user.id === post.author_id` 恰恰是**使命**，不是缺陷。
- **复现**：`mkdir -p src/__tests__ && echo "export const f = (u,p) => u.id === p.author_id || u.is_admin;" > src/__tests__/a.spec.js && node scripts/test-auth-policy.mjs` → `17/18 passed`，报 `__tests__/a.spec.js:1`。同一时刻 `src/_probe/evil.js` 报的是真越权。两者在断言的输出里长得完全一样。
- **断言**：`scripts/lib/src-walk.mjs` 新增 `NON_PRODUCT_DIRS`（`__tests__` / `__mocks__` / `__fixtures__` / `test` / `tests`）与 `isNonProduct()`，`srcFiles` / `nativeSrcFiles` 默认排除；`AP-18` 的子目录覆盖检查跳过非产品目录，否则误报会从这条倒灌回来。另配 `AP-19`：`nonProductLeaks()` 扫产品文件的 `from` / `import()` / `require()`，一旦指向非产品目录就报错——排除制造了盲区，这条守盲区。
- **教训**：断言的两端都会坏。**假绿**让人以为有保护，**假红**让人去关保护。所以「排除测试目录」不能只改过滤条件，必须同时回答「如果有人把产品代码放进被排除的目录，谁来发现」——答案是 `AP-19`，它不看目录名，看 import 边。另：`nativeSrcFiles` 的排除逻辑故意重写一遍而不复用 `isNonProduct`，两套实现共用同一个判据函数时判据写错了两边一起错，互校就失去意义。
- **出处**：站务记录（本文件，2026-11-23）；`content/53-*.md`；同族见 P-032（扫描范围）、P-030（只认一种句式）、P-029（异步假绿）

---

## P-035 分页参数只夹下界，溢出后列表静默变成骨架屏

- **现象**：`/tag/<标签>?page=999999999999999999999` 与 `/api/posts?page=999999999999999999999` 都返回 **200**，页面是一张永远「加载中」的骨架屏。没有 500、没有错误文案，日志里只有一行 `console.error('list ssr failed', e)`。
- **根因**：`parseInt('999999999999999999999')` 得到 `1e21`，`offset = (page-1) * size` 变成 `1e22`，超出 int64。SQLite 直接报 `datatype mismatch`（`node:sqlite` 实测复现）。D1 同样报错，而 SSR 的 `listQuery` 把异常兜成 `data: null`，`applyList` 见到 null 就填 `SKELETON` —— 一个「服务正常但内容空了」的形态。
- **复现**：`node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.exec('create table t(a)'); db.prepare('select * from t limit 10 offset ?').all(1e22)"` → `datatype mismatch`。
- **断言**：`scripts/test-query-params.mjs` QP-01~05。QP-01 直接调 `pageParams` 验 offset 是安全整数；QP-04 验 `(MAX_PAGE-1)*50` 本身不越界（防有人把常量调到 `Number.MAX_SAFE_INTEGER`）；QP-05 是元断言 —— `src/` 里除 `utils.js` 外不许再出现「从 searchParams 取 page 再转数字」的形状。
- **教训**：这段解析原先在 `utils.pageParams` 与 `index.listParams` **各写一遍**，两处都只夹下界。修一处漏一处是这一路反复出现的形态（P-030 认一种句式、P-032 扫一层目录、P-034 排除一类目录）：**同一个判据只要存在两个实现，就一定会分叉**。另一条：`n || 默认值` 把 `0` 和 `-5` 分成两种结果（一个回落默认、一个被 `Math.max` 夹到下界），改用 `Number.isFinite` 判断「是不是给了个数」，两种非法输入才走同一条路。
- **出处**：站务记录（本文件，2026-11-23）；`content/54-*.md`；同族见 P-031（清缓存漏传维度）、P-034（排除制造盲区）

---

## P-036 编辑器一页开两篇：异步回调读全局，写进了别人那篇

- **现象**：编辑器支持多文档页签后，在第二篇里敲字、立刻切回第一篇，那条 3 秒自动保存到点时会把**第二篇的正文**存进**第一篇**的 id；反过来，切回第二篇时正文框里出现第一篇的内容。表现是全或无：不复现就一切正常，复现就是「文章被覆盖」这种不可逆的错。
- **根因**：这套编辑器原先所有状态都是模块级单例（`postId` / `dirty` / `rev` / `saving` / `saveTimer` / `draftKey`，加上唯一一个 Monaco model），切文章靠 `location.href = '/editor?id='` 整页重载来「重置」。改成同页页签之后，页面上只换了 DOM，`setTimeout(() => saveNow(), 3000)`、`await api(...)` 之后的回写、`fetchSummary` 的响应、`uploadFile` 的插入，读到的都是**此刻**的全局值——也就是当前显示的那一篇，而不是发起请求的那一篇。
- **复现**：`node scripts/verify-editor.mjs` 的多文档段（假 API 把写请求延迟 180ms、记录每次 payload）。在第二篇里 `setValue('TIMER_LEAK_PROBE')`，120ms 内点第一个页签，等 4 秒：修复前 `writeLog` 里会出现一条 `PUT /api/posts/1` 且 `body.content` 含 `TIMER_LEAK_PROBE`；修复后这条只可能落在第二篇自己的 id 上，且总数恰好一次。
- **断言**：`scripts/test-editor-multidoc.mjs` MM-01~09（静态：切文档不许整页跳转、payload 不许读 DOM、定时器必须挂 doc、异步入口必须捕获快照、草稿键必须按篇分、`capture()` 必须覆盖全部字段）；`scripts/verify-editor.mjs` 多文档 12 条（真机：切回各篇内容正确、切走只保存一次、内容不串篇、关闭不弹 confirm）。
- **教训**：**异步回调里读全局，读到的永远是「别人」**。修法不是加锁，也不是切页签前强制保存了事（在途请求仍然会回来），而是把状态挂到文档对象上、让每个异步入口先 `const d = S`，回写前比一次 `S === d`：UI 只认当前文档，数据只落发起它的那篇。附带一条：`capture()` 少抄一个字段，症状和串篇一模一样（切回来值是上一篇的），所以这条用元断言锁住字段清单，而不是靠人眼。
- **出处**：站务记录（本文件，2026-11-23）；`public/editor.html`；同族见 P-030（两处解析）、P-034（排除目录制造盲区）、P-035（同一个判据两个实现必分叉）

---

## P-037 请求体闸门只挡得住诚实的那一半

- **现象**：`/api/*` 的写接口有一个「请求体上限」：顶层一行 `bodyTooLarge(request, bodyCapFor(path))`，超了回 413。看着是全站闸门。实际上分支里仍然写着 `const body = await request.json()` —— `content-length` 老实报 1MB 的包被顶层挡住，报 `3` 却推 1MB 的包（或分块上传干脆不给这个头）一路走到分支，整个包被读进 128MB 的 isolate 再 `JSON.parse`。闸门在，但只覆盖了一半入口，而这一半恰好是攻击者会走的那一半。同一个坑还有第二种长相：`request.formData()`（头像、图片上传），它内部同样整包读内存。
- **根因**：闸门的判据（`content-length`）和它要保护的动作（把 body 读进内存）不在同一个地方。`content-length` 是**声明**，读流才是**事实**；用声明去守事实，声明由对方给，就等于没有守。当时只在「匿名可灌数据」的发评论接口做了按流计数（`readJsonLimited`），其余 12 个 JSON 分支（文章增改、摘要、审核、评论处置、批量删、封 IP、友链增改、站点设置、直传签名）与 2 个表单分支因为「要登录」被默认放过——但登录只限制造假者，不限制一个被盗的 cookie 烧额度。
- **复现**：`node scripts/test-body-limit.mjs` 的 BL-15：伪造成 `content-length: 3`、实际推 1MB 分块体打 `POST /api/comments`，`env` 里不放 DB。修复前请求会一路读满并撞到 `env.DB` 抛错；修复后拿到 413，且 `sent` 远小于 1MB（在超限处就断流）。BL-16 是同一条对 multipart 的版本（2MB 分块、上限 64KB）。BL-14 / BL-17 是元断言：剥掉注释后扫描 `src/*.js`，任何 `request.json()` / `request.formData()` 都算红。
- **断言**：`scripts/test-body-limit.mjs` BL-14（元断言：不许裸 `request.json()`）、BL-15（端到端：谎报长度的 JSON 在分支层被 413）、BL-16（multipart 同款）、BL-17（元断言：不许裸 `request.formData()`）。都做过注入验证：评论分支改回 `request.json()` → BL-14+BL-15 双红；上传分支改回 `request.formData()` → BL-17 红；蜜罐状态码从 400 改成 200 → `test-antispam` 两条新断言红。
- **教训**：**一个「上限」如果写在解析之前，就必须同时写在每一个解析点**。修法不是把顶层的判断写得更严（`content-length` 可以撒谎，也完全可以不给），而是让所有分支只剩一条读体路径：`readBody(request, path)` 内部按流数、和顶层共用同一张路径上限表，连「回什么」都替调用方定好（`if (rb.res) return rb.res;`）。表单那条同理走 `readForm()`，计数逻辑与 JSON 共用 `readBytesLimited`（一份逻辑，两种解析）。这样新加一个写接口时，漏掉闸门的写法在语法上就不顺手了。同族：P-030（同一个判据两个实现）、P-035（只夹下界）。附带一条：蜜罐的断言不能只写「拦住了」，要同时断言「没有 INSERT、没有动限流计数表」——否则拦住的可能只是响应，垃圾照样落库。
- **出处**：站务记录（本文件，2026-11-24）；`src/utils.js` 的 `readBytesLimited` / `readFormLimited`、`src/api.js` 的 `readBody()` / `readForm()`；`scripts/test-body-limit.mjs`、`scripts/test-antispam.mjs`、`scripts/test-sticky-css.mjs`

## P-038 封面「永远有值」这条，只有一条路径在守

- **现象**：`coverOf()` 注释写着「最终生效的封面地址，永远非空」，三层回落（手填 → 正文首图 → 预设图）也是这么写的。但只要有人把 `usableCover()` 的 SVG 过滤放宽一行、或在某个入口直接用 `post.cover` 而不走 `coverOf()`，列表就会冒出一格空图：`<img src="">` 在页面上是空白方块，og 里是 `content=""`，两者都不会报错，`check-live` 当时也不看封面。<br>同一族还有另一次真实踩坑：预设图 `auto-N.jpg` 的 N 由 `id % 6` 决定，改 `AUTO_COVER_COUNT` 却忘了补图，`auto-7.jpg` 直接 404，而列表仍是 200。
- **根因**：这段逻辑的出口有四个（列表缩略图、og:image、RSS enclosure、编辑器预览），回落顺序又在注释里而不是在断言里。没有一条断言跑 `coverOf()` 本身，所以「永远非空」只是一句注释。
- **复现**：`node scripts/test-cards.mjs`，用 `undefined` / `null` / `{}` / `{id:0,slug:'',title:''}` 四种空输入打 `coverOf()`；再对 `id 1..AUTO_COVER_COUNT` 逐张取图，要求命中 N 张不同文件、路径落在 `/thumbs/auto-[1-N].jpg` 内。把 `usableCover` 的 SVG 判断去掉、或把 `|| autoCover(post)` 删掉，立刻变红。
- **断言**：`scripts/test-cards.mjs` 的四条 `[P-038]`：空输入非空、路径在白名单内、同一篇两次一致（列表不能刷一次变一次）、`1..N` 有分散度。
- **教训**：「永远非空」这种全局不变量，断言要打在**唯一的那个出口函数**上，而不是每个调用点。调用点会越加越多，出口只有一个。同族：P-032（唯一出口被改就全体失明）。
- **出处**：站务记录（本文件，2026-11-24）；`src/cover.js` 的 `coverOf` / `autoCover`；`scripts/test-cards.mjs`

## P-039 封面指向的文件被删了，页面照样 200，分享出去是裂图

- **现象**：`posts.cover` 是一列字符串。卡片文件被改名、被 `gen-cards` 覆盖成别的 slug、或手填一个不存在的 `/cards/xxx.png` 之后，文章页仍然是 200，`og:image` 仍然有值且是绝对 URL，`check-live` 全绿。只有真去抓那张图才会发现 404 —— 而社交平台抓图失败时**什么都不会告诉你**，卡片就是一张空白。
- **根因**：断言只验了「页面里有没有这个标签」，没验「标签指向的东西取不取得回来」。HTML 正确和资源存在是两件事，前者是字符串，后者要发请求。
- **复现**：`node scripts/check-live.mjs` 的 `[P-039]` 两条：把 `/api/posts` 返回的封面逐张 HEAD（每篇一张，去重后 ≤20 个请求），要求 200 + `content-type: image/*`；任一张 404 或返回 `text/html`（SPA 回落那种「200 的错误页」）即红。<br>本地等价复现：`SELECT slug FROM posts WHERE cover LIKE '/cards/%'` 之后逐条 `ls public/cards/`。
- **断言**：`scripts/check-live.mjs` `[P-039]` 两条（每篇有地址、地址全部可取且是图片）。离线侧由 `test-cards.mjs` 守仓库内图片的真实尺寸（P-041），两边合起来覆盖「文件在不在」与「文件对不对」。
- **教训**：**「有链接」不等于「链接有效」**。凡是要被外部抓取的资源（og:image、RSS enclosure、sitemap 里的 URL），断言必须走到「真取一次」这一层。同族：P-020（缩略图 404 但页面 200）。
- **出处**：站务记录（本文件，2026-11-24）；`src/cover.js`、`src/index.js` 的 og 段；`scripts/check-live.mjs`

## P-040 og:image 与它声明的尺寸，是两个地方各写一遍

- **现象**：文章页里 `og:image:width/height/type` 与 `og:image` 是分开生成的：地址来自 `coverOf(post)`，尺寸来自一段内联三元。两者一旦不同步（比如把「标题卡 1200×630」那条分支的 `w` 写成预设图的 784，或者给作者自传的图也硬标 1200×630），页面完全正常、校验器不报错，只有分享卡片被平台按错的框裁一刀 —— 标题被切掉半个字那种。<br>更常见的是第三个分支缺失：作者自传的图尺寸未知，代码却给了默认值。
- **根因**：能确认尺寸的只有两种图（预设图 1200×784 JPEG、标题卡 1200×630 PNG），第三种「不知道」被当成「按最常见的填」。而这段判定原来内联在模板字符串里，测试只能断言「页面上有没有这个 meta」，测不了「哪种封面配哪组尺寸」—— P-032 的同一个病：断言还在，被测的东西被结构改动换掉了。
- **复现**：`ogCoverOf(post)` 现在返回 `{ path, type, w, h }`，`type` 为 `null` 就是「不知道」。把卡片分支的 `h` 改成 784 → `test-cards` 的 `[P-041]` 红；把 `index.js` 退回内联三元 → `[P-040]` 的元断言红（实测两次都还原过）。线上侧 `check-live` 会把页面声明的 `width/height/type` 和实际字节解析结果比一遍。
- **断言**：`scripts/test-cards.mjs` 三条 `[P-040]`：自传封面三项全 `null`、`index.js` 确实走 `ogCoverOf`（含「不许再出现内联三元」的负断言）、`check-live.mjs` 里确实有 og 断言（防删）；`scripts/check-live.mjs` 两条：同源、声明与实际一致、自传封面不标尺寸。
- **教训**：**声明资源和描述资源必须是同一次计算的输出**。分两处写，早晚不一致，而且不一致时没有任何一方会报错。顺带：「不知道」要能表达出来 —— `type: null` 比「填个最常见值」更安全。
- **出处**：站务记录（本文件，2026-11-24）；`src/cover.js` 的 `ogCoverOf`、`src/index.js` 的文章页 og 段；`scripts/test-cards.mjs`、`scripts/check-live.mjs`

## P-041 尺寸断言拿 utf8 读二进制，永远读不出尺寸，也就永远绿

- **现象**：一段看着没问题的 PNG 尺寸读取：`readFile(..., 'utf8')` 拿到字符串，再 `Buffer.from(str, 'binary')` 还原。实测 `public/cards/about.png`：原文件 17360 字节，这样来回一趟变 16544 字节，签名从 `89504e47` 变成 `fd504e47`，宽度从 1200 读成 1277。`readPngSize` 于是返回 `null`，调用处一句 `if (size) check(...)` —— **条件不成立就跳过，不报错**。整条断言在任何输入下都是绿的，包括图片真被压成 800×420 的时候。
- **根因**：`readFileSync` 的 `encoding` 参数一给，返回的就不是字节了；`0x89` 不是合法 UTF-8，被替换成 `EF BF BD`（3 字节换 1 个替换符），长度和内容一起失真。第二层原因是 `if (size)` 把「解析失败」当成「不适用」：解析失败恰恰是文件坏了或代码写错了，应该红。
- **复现**：`node -e "const b=require('fs').readFileSync('public/cards/about.png');console.log(b.toString('utf8').length, Buffer.from(b.toString('utf8'),'binary').readUInt32BE(0).toString(16))"` → 签名不是 `89504e47`。<br>换成不带 encoding 的 `readFileSync(path)`，签名与 `1200×630` 立刻都对了；`test-cards.mjs` 对 `public/cards/` 14 张、`public/thumbs/` 6 张逐一断言就是这个写法。
- **断言**：`scripts/test-cards.mjs` 的 `[P-041]`：卡片真值表 1200×630 PNG、预设图真值表 1200×784 JPEG（JPEG 走 SOF 段扫描，不是看文件头猜），以及两个目录**逐文件**断言 —— 目录空要红（`至少有一张`），不做「空就跳过」。`check-live` 侧对线上实际字节再验一遍。
- **教训**：**「跳过」和「通过」必须分开**。凡是 `if (拿得到) 断言(...)` 的写法，都要问一句：拿不到时会发生什么？如果答案是「静默通过」，那这条断言只在最理想的情况下有效。同族：P-034（排除目录后把测试代码报成越权 = 假红）、P-035（只夹下界）。
- **出处**：站务记录（本文件，2026-11-24）；`scripts/test-cards.mjs` 的 `pngSize` / `jpegSize`；对照 `scripts/gen-title-cards.py`（生成侧 `W, H = 1200, 630`）

## P-042 越界页码是 200 的空页，而且每张都自称规范地址

- **现象**：`/?page=99`、`/tag/cloudflare?page=99`、`/cat/log?page=99` 一律返回 **200**，正文是「还没有文章」的空态，`canonical` 却写着 `…?page=99` 本身。`/archive?page=9` 更怪：归档一次列全部、`page` 根本不参与查询，所以 1 和 9 输出同一份内容，而两份各自声明自己是规范地址。分页链接是有边界的（末页没有「下一页」），但 URL 是无边界的 —— 爬虫不需要点链接，拼数字就能造出无限张空页，每张都 200、都自指、都能被收录。顺带 `/`、`/?page=1` 也是同一页的两份地址。
- **根因**：两处都只处理了「合法输入」。分页只管对 `LIMIT/OFFSET` 夹上下界（P-035 修过），没人问「OFFSET 越过末尾时该回什么」，默认就是空数组 + 200。canonical 那边把 `page` 当无条件有效的参数抄进规范地址，没区分「真分页的三种列表」与「`page` 只是噪声的归档页」，也没把 `page=1` 归一到无参数地址。
- **复现**：本地 `npm run seed:ci && npx wrangler dev`，`curl -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8787/?page=999'`。修复前 200 且页面是空态、canonical 是 `?page=999`；修复后 404，`/?page=1` 的 canonical 是 `/`，`/archive?page=9` 的 canonical 是 `/archive`，`/?page=2` 仍然保留 `?page=2`（18 篇、每页 10 → 真有第 2 页）。
- **断言**：`scripts/check-live.mjs` 第 13 节 5 条 `[P-042]`（`?page=1` 归一、第 2 页保留页码、首页/栏目页越界 404、404 页里不许出现列表空态、归档页 page 不进 canonical）；离线一半在 `scripts/test-query-params.mjs` QP-06（`list.total > 0 && list.page > list.pages` 与 `notFoundPage` 必须在）与 QP-07（`paged` 只认 `/`、`/tag/`、`/cat/`，且 `pageNo > 1` 才写页码）。
- **教训**：**分页有两种边界，一种在页面里，一种在 URL 里**。页面上的边界由链接保证（末页不渲染「下一页」），URL 的边界必须由服务端保证，因为参数是用户/爬虫直接拼出来的。凡「无效输入仍返回 200」的地方，都要问一句：这个 200 会不会被当成一张独立页面索引？同族：P-035（只夹下界）、P-039（有链接 ≠ 链接有效）。
- **出处**：站务记录（本文件，2026-11-24）；`src/index.js` 的 `injectTheme`（越界 404）与 `fillSeo`（canonical 归一）；`scripts/check-live.mjs`、`scripts/test-query-params.mjs`

## P-043 排期稿的 sitemap lastmod 早于 datePublished

- **现象**：一篇文章 11 月写完、定在次年 1 月发。上线后 `sitemap.xml` 给它的 `<lastmod>` 是 11 月（最后一次编辑），页面结构化数据里的 `datePublished` 是 1 月。两个日期出自同一个 Worker、同一份数据，却互相矛盾：`lastmod` 比发布日还早。页面、RSS、收录全都正常，没有任何工具会为「时间信号自相矛盾」报警。
- **根因**：`lastmod` 取的是 `updated_at`，而排期稿的 `updated_at` 停在写稿那一刻，`published_at` 才是它真正对外可见的时间。单篇和列表页聚合（栏目 / 标签 / 系列页的 `MAX(...)`）用的是同一处错口径 —— 一处写错，五处跟着错。
- **复现**：本地把某篇改成 `published_at` 晚于 `updated_at`（模拟排期），`curl /sitemap.xml | grep 该 slug`。修复前 `<lastmod>` 是编辑日，修复后是发布日；`/p/<slug>` 的 `datePublished` 与它一致。
- **断言**：`scripts/check-sitemap.mjs` `[P-043]`：抽 sitemap 里最新 3 篇文章页，逐篇比 `lastmod >= datePublished.slice(0,10)`，任何一篇倒挂即红；同时保留原有一条「没有未来日期的 lastmod」。
- **教训**：**同一份数据派生出的两个字段，要么同源，要么有一条断言把它们钉在一起**。`lastmod` 与 `datePublished` 属于后者：它们没有代码上的依赖关系，只有语义约束，「发布即一次修改」这条语义必须显式落到 SQL 里（`MAX(published_at, updated_at)`），否则排期越多，倒挂越多。
- **出处**：站务记录（本文件，2026-11-24）；`src/index.js` 的 `serveSitemap`；`scripts/check-sitemap.mjs`

## P-044 500 页按观众分成两种，其中一种被告知了表名

- **现象**：站点挂了的时候，浏览器（`Accept: text/html`）拿到的是自绘的 500 页「服务暂时不可用」，深色模式都有；而随手 `curl` 同一个地址，拿到的是 `{"ok":false,"error":"D1_ERROR: no such table: posts: SQLITE_ERROR"}`。同一份故障，两种观众：一种被保护，一种拿走了库结构、SQL 方言和出错位置。404 页也一样是自定义的 —— 所以「没有自定义错误页、会露出 Workers 默认页」这个判断本身是错的，漏的是最后那行兜底。
- **根因**：内容协商只回答了一个问题（「这是不是浏览器」），没回答第二个（「这个错误该不该把细节说给调用方」）。API 分支要 `e.message` 是因为前端要显示「保存失败：xxx」，但这行兜底没有区分「`/api/` 的调用方」与「随手 curl 页面路径的人」，一律把 `e.message` 回出去了。
- **复现**：本地临时在 `handleFetch` 里 `throw new Error('D1_ERROR: no such table: posts')`，然后 `curl` 两次：不带 `Accept` 拿到 500 + 异常原文；带 `Accept: text/html` 拿到 500 + 静态页。修好后前者是 `{"ok":false,"error":"服务器错误"}`，后者仍是那张静态页（实测：正文里 `D1_ERROR` 出现 0 次）。注入的那行验证完已删除。
- **断言**：`scripts/test-route-boundaries.mjs` RB-07 两条：`serverErrorPage()` 里不许有 `${` 插值与 `e.message`；内层 catch 必须按 `here.startsWith('/api/')` 分流，非 API 回固定文案。另有一条实测口径记在这里：404 与 500 都是自定义页，别再把「没有错误页」写成待办。
- **教训**：**错误信息也是响应体，要按观众分级**。「给调用方看」和「给调试用」是两拨人：堆栈进日志（observability 可查），API 回可执行的原因，给普通请求回一句通版话。反过来的错也常见 —— 为了「方便排查」把 `e.message` 回给所有人，等于把内部结构贴到门口。
- **出处**：站务记录（本文件，2026-11-24）；`src/index.js` 的 `serverErrorPage()` 与 `handleFetch` 的 catch；`scripts/test-route-boundaries.mjs`

## P-045 500 的出口有两个，P-044 只修了内层那个

- **现象**：P-044 修完、断言全绿。这一轮为了复验，把 `throw` 扔在 `handleFetch` 第一行（内层 `try` 之外），`curl` 不带 `Accept` 拿到的仍是 `{"ok":false,"error":"D1_ERROR: no such table: posts"}`，53 字节，表名和 SQL 方言一个不少。带 `Accept: text/html` 的那条路反而正常 —— 因为内层 catch 挡得住，只有外层漏。同一份故障，同一天，两种回包。
- **根因**：`handleFetch` 里的 `try` 只包住了 `route()` 分发那一段。异常如果抛在它前面（HEAD 预处理、URL 解析）或者后面（ETag 重算、日志上报），到不了内层那个已经改好的 catch，一路掉到 `fetch()` 最外层。那里还是 `json({ ok: false, error: e.message }, 500)` —— 判断写了两份，改的时候只改了一份。P-030 同族。
- **复现**：本地 `wrangler dev`，`handleFetch` 首行临时插 `if (new URL(request.url).pathname === '/__boom') throw new Error('D1_ERROR: no such table: posts')`。修前：无 `Accept` → 500 + 53B 原文；`Accept: text/html` → 500 + 1109B 静态页（`D1_ERROR` 出现 0 次）；`/api/` 路径 → 500 + 原文（本来就该）。修后：前者变成 `{"ok":false,"error":"服务器错误"}`，另两条不变。注入行验证完已删除。
- **断言**：`scripts/test-route-boundaries.mjs` RB-07 新增两条 —— `(res = |return )fatalResponse(request, e)` 的调用点 ≥ 2（排除函数定义行本身）；catch 块里出现 `error: e.message` 且块内没有 `return fatalResponse` 即红。注入验证：外层 catch 改回裸写法 → 双红；还原 → 32 条全绿。
- **教训**：**「修好了」要再问一句：这条规则有几份实现**。一处在内层 catch，一处在最外层，第三处可能在 `scheduled` 或别的手工入口。收口的标准不是「路径测试通过」，是「只剩一处能写出这个回包」。所以这次不补分支，抽 `fatalResponse()`，两个 catch 都调它 —— 判断合并，控制流不动。
- **出处**：站务记录（本文件，2026-11-24）；`src/index.js` 的 `fatalResponse()`（内层 catch 与外层 catch 共用）；`scripts/test-route-boundaries.mjs`；正文 `/p/scalar-max-and-out-of-range-page`

---

## P-046 管理员席位按登录顺序发放，谁先到谁进后台

- **现象**：`decideAccess()` 不配 `ADMIN_LOGINS` 时回落到 `isFirst ? 1 : 0`。空库的第一个 GitHub 登录者就是管理员，此后所有 `pending` 投稿归他放行。线上 `users` 表只有 2 行、窗口已关，但清库、换域名重装、开新实例都会重开这个窗口。README「功能」表与部署第 8 步当时都还在承诺「第一个登录的用户自动成为管理员」，等于把这件事当成特性写。
- **根因**：权限来源只有一个布尔，而那个布尔来自「注册顺序」——一个任何人都能通过先访问来争夺的位置。而 ACL 不该由到达时间决定：`is_admin` 的正确来源只能是配置（`ADMIN_LOGINS`）或一次显式引导（令牌），不是 `COUNT(*) = 0`。
- **复现**：空库 + 不配任何环境变量 → `decideAccess({}, 'anyone', true).admin === 1`（旧行为）。修后同一条返回 0；只有 `decideAccess({}, 'anyone', true, true)`（带引导令牌）才是 1，且 `isFirst=false` 时令牌无效。
- **断言**：`scripts/test-bootstrap-admin.mjs` B-01~B-13 —— 令牌常量时间比较（B-01~03、B-13 读源码禁止退化成 `===`）、四种角色组合（B-04~08）、cookie 必须 HttpOnly+Secure+600s（B-09）、回调只认 `=== '1'`（B-10）、`admin` 赋值必须同时要求 `bootstrapped === true`（B-11）、文档不许再写「自动成为管理员」（B-12）。注入验证：`!!isFirst && bootstrapped === true` 改回 `!!isFirst` → B-04/B-07/B-11 三红；`secretEq` 退化成 `A === B` → B-03/B-13 双红。
- **教训**：**「默认行为」才是最常被执行的代码**。`ADMIN_LOGINS` 早就有了，但默认路径还是先到先得，于是「支持指定管理员」和「管理员不靠抢」是两件事。安全默认必须是关掉的：不配置就当没有管理员，而不是回落到更弱的历史行为。
- **出处**：站务记录（本文件，2026-11-24）；`src/auth.js` 的 `secretEq()` / `decideAccess()` / `loginRedirect()` / `handleCallback()`；`scripts/test-bootstrap-admin.mjs`

---

## P-047 文档里的表数与篇数各说各话，而两者都能用一条 SQL 复核

- **现象**：README 同一篇里躺着三个数：备份演练记录「13 表 / 40 篇」、首页「18 篇」、提交信息「第 56 篇」。实测线上是 **12 张业务表 / 15 个索引**、`posts` **42 行**、已发布 **18 篇**。三个数各自都对，但没有一处写明口径，读者只能猜。上一轮审计就把「40 篇」当成了站内总篇数。
- **根因**：数字是手抄进文档的，抄的那一刻是对的，之后没人再核。`check:schema` 能算出表数、`/api/posts` 能给出篇数，但文档与这两者之间没有断言 —— 和 P-035「结论留在文章里、没进 CI」是同一个病，只是这次病在 README 而不是正文。
- **复现**：`npm run check:schema` → `PASS 12 张表 / 15 个索引`；`SELECT COUNT(*) FROM posts` → 42；`/api/posts` 的 `total` → 18。再读 README 第 291 行：「13 表 / 40 篇」。`SELECT name FROM sqlite_master` 是 **15** 张表，多出来的 `d1_migrations`、`sqlite_sequence`、`_cf_KV` 全不是业务表——13 这个数大概就是从这里数出来的。
- **断言**：`scripts/test-docs-numbers.mjs` D-01~D-06 —— README 报的表数/索引数必须等于 `migrations/*.sql` 里 `CREATE TABLE`/`CREATE INDEX` 去重后的数量（D-01、D-02）；不许出现没说口径的「N 张表」（D-03）；「## 数字口径」必须写清「已发布 / 全库 / 第 N 篇」三义（D-04、D-05）；`content/` 最新一篇必须在 `EDITORIAL.md` 登记（D-06）。注入验证：README 改回「13 张表 / 40 篇」→ D-01/D-02 双红。
- **教训**：**文档里的数字必须有一个可执行的对账人**。写「12 张表」的时候不需要记得自己写过，只要让断言去数 `migrations/`；数不对它就红。口径本身也要写下来——「18」和「42」都不错，错的是没人说清哪个是哪个。
- **出处**：站务记录（本文件，2026-11-24）；`README.md` 的 `## 数字口径`；`scripts/test-docs-numbers.mjs`

---

## P-048 datePublished / lastmod / pubDate 三处各按一种口径

- **现象**：同一篇文章在三个地方各报一个日期——JSON-LD 的 `datePublished`、`sitemap` 的 `lastmod`、RSS 的 `pubDate`。上一轮修掉的是 `lastmod` 早于 `datePublished`（排期稿取 `updated_at` 导致），但「三者是否等于同一天」从来没被比较过。任一处理解不同，搜索引擎就会把同一篇判成「更新过的旧内容」或「未来内容」。
- **根因**：三个出口分别由 `postLd()`（`src/seo.js`）、`stamp()`（`src/index.js` sitemap）、`rfc822()`（RSS）生成，各自 `published_at || created_at`。表达式相同是巧合，不是约束——谁改一处 fallback，另外两处不会红。加上 `published_at` 是 `+08` 存的，直接按 UTC 截日期，凌晨发的稿子会差一天。
- **复现**：`node scripts/check-sitemap.mjs`。拿 RSS 前 3 条，逐条抓页面取 `datePublished`，把两个时间都换算到北京时间再截日期比较。注入验证：把比较改成恒真 → 立刻列出 3 条地址（`ld-self-reference` / `worker-render-549-to-96` / `cls-empty-slots`），说明这条断言确实在跑而不是跳过。
- **断言**：`scripts/check-sitemap.mjs` 新增 `[P-048]`，与既有 `[P-043]`（`lastmod ≥ datePublished`）拼成完整链条：`datePublished ≤ lastmod`，且 `datePublished` 与 `pubDate` 同日。线上实测 13/13。
- **教训**：**同一个事实有几个出口，就有几次走样的机会**。上次只修了「先后顺序」，这次补「是否同日」——但真正的约束是三者同源。哪天要改 fallback，得三处一起改，所以这条断言的价值不在「今天对不对」，在于改错一处时它会红。
- **出处**：站务记录（本文件，2026-11-24）；`src/seo.js` 的 `postLd()`；`src/index.js` 的 `stamp()` 与 RSS 生成；`scripts/check-sitemap.mjs`

---

## P-049 排查性能全靠 `wrangler tail`，响应上没有分段

- **现象**：文章里写了一串耗时（549→96、180→84、TTFB P50 215ms），但那些数字一个都不在响应上。想知道某个页面慢在哪，必须开 `wrangler tail`、复现一次、读那行 JSON，读完就散了。生产者（`requestLog`）只在日志侧，消费侧（浏览器、curl、同行）什么都看不到。
- **根因**：`startedAt` 从头到尾只喂给 `emit(requestLog(...))` 的 `durationMs`，没有第二个出口；D1 调用点散在 6 个文件一百多处，逐点插桩不现实，于是干脆没做。`cfWorker;dur=549` 那个头是运行时加的（第 30 篇记过），不是我们控制得了的分段，也分不出 db 与模板。
- **复现**：`curl -s -o /dev/null -D - 'https://exia.de5.net/?cb='$(date +%s) | grep -i server-timing` —— 修之前这一行什么都不输出。修法在 `src/timing.js`：`timedDb()` 用 Proxy 包 `env.DB`，在 `fetch()` 里换成 `timedEnv` 再传给 `handleFetch`，所有查询自动计时，零调用点改动；`bind()` 必须重新包（否则 `.bind(...).all()` 漏计），`batch()` 必须解包（传代理进 D1 会类型检查失败，代理上挂 `__raw` 指回原对象）；`withServerTiming()` 只在 `fetch()` 出口加一次，只认 `text/html` 与 `application/json`。
- **断言**：`scripts/test-timing.mjs` T-01~T-12（假 D1 真跑代理，验 batch 解包、bind 链、二次包装、304 空 body、app 钳零，外加元断言「只包一次」与 T-12 自检「同步 runner 拒收 async」）；`check-live.mjs` 第 14 节 `[P-049]` 5 条守线上。注入验证两组：摘掉 `timedDb` → T-11 红；`batch` 不解包 → T-03 红。
- **出处**：站务记录（本文件，2026-11-24）；`src/timing.js`；`src/index.js` 的 `fetch()`；`src/cache.js` 的 `edgePut()`（存副本前删头，否则命中会显示上一次的耗时）

两个反直觉的点，值得单独记：

1. **`db` 可以大于 `total`**。`Promise.all` 并行查库时，七条各 20ms 的查询累加成 140ms，而总耗时只有 33ms。累加的是每次查询各自花了多久，不是这条请求在库里待了多久。实测 `/cat/log` 出现过 `db=173 / total=137`，`app` 被钳到 0。别拿 `db/total` 当数据库占比用，也别当 bug 修掉。
2. **边缘缓存命中的响应没有这个头**，因为它不经过 Worker。所以「有头 = 回源，无头 = 缓存命中」本身就是判据，比 `cf-cache-status` 直接（那个头可能是上一跳留下的）。`check:live` 先 `?cb=` 绕缓存再核，否则会把正常的缓存命中判成失败。

**教训："我量过"和"别人能量"是两件事。** 前者的数字只活在文章里，改完就过期；后者有个固定入口，谁都能复现。这条头的价值不在今天这几个数，在于下次真慢的时候不用重新搭环境。

---

## P-050 canonical 归一了，JSON-LD 的 `@id` 没有

- **现象**：`/?cb=zz1`、`/?utm_source=x`、`/?anything` 这些地址的 `canonical` 都正确指向 `/`，但页面里 `CollectionPage` 的 `@id` 和 `url` 各写各的 —— 每个 query 一个。同一份内容在结构化数据里变成无限多个实体。
- **根因**：canonical 的规则写在 `fillSeo()` 里（内联的一段 `paged` + `pageNo > 1`），JSON-LD 在 `listLd()` 调用处直接吃 `url.toString()`。**两条出口，只归一了一条** —— 和 P-030（`ownerOrAdmin` 两处内联判定）、P-044（500 的两个 catch）是同一个形态，第三次发作。
- **复现**：`curl -s 'https://exia.de5.net/?cb=zz1' | grep -o '"@id":"[^"]*"'` —— 修之前输出 `https://exia.de5.net/?cb=zz1`，而同一页的 `<link rel="canonical">` 是 `https://exia.de5.net/`。修法是把规则抽成 `canonicalOf(url)`（`src/index.js`），`fillSeo()` 与 `listLd()` 调用处共用；`/?page=2` 仍然保留页码，`/archive?page=9` 仍然丢掉。
- **断言**：`scripts/test-query-params.mjs` QP-07 从源码扫描改成**行为测试**（直接喂 URL 看 `canonicalOf` 返回值，9 条），QP-08 是元断言（`listLd` 的 url 必须走 `canonicalOf`，不许出现 `url.toString()`）；`check-live.mjs` 第 15 节 `[P-050]` 4 条守线上，打 `?cb=` 绕缓存。注入验证：`url: canonicalOf(url)` 改回 `url.toString()` → QP-08 立刻红。
- **出处**：站务记录（本文件，2026-11-24）；`src/index.js` 的 `canonicalOf()` / `fillSeo()` / `listLd()` 调用处；`src/seo.js` 的 `listLd()`；`scripts/test-query-params.mjs`

## P-051 同一段防闪脚本 10 份副本，9 份丢了 SRI 与内容哈希

- **现象**：首屏（SSR 首页/文章页）直出的主题 CSS 带 `integrity` 与 `?v=<内容哈希>`；但读者在静态页（归档 / 分类 / 友链 / 登录 / 编辑器 / 404）或后台把主题切到水墨、苔原这些，网络面板里那份 `/theme/ink.css` 既没有 `integrity`，也没有 `?v=` —— 缓存头从「一年 immutable」掉回 `public, max-age=300`，每 5 分钟重取一次，且失去子资源完整性校验。查下去还发现第二层：连那份「唯一正确」的副本在运行时也查不到清单。
- **根因**：两层。
  1. 这段脚本手抄了 10 份（8 个静态 HTML、后台统计/健康/队列三页、404、系列页），只有 `src/index.js` 的 `themeBoot()` 那份拼了 `window.__ASSET_H__`。副本一多就必然分化：抄的人只补了自己那页。「哪几套主题有独立文件」的判断也散在两处（boot 里的主题名比较、`theme.js` 的 `ensureThemeCss`），`themeBoot()` 里还硬编码了五套主题 id 的循环 —— 加第 8 套主题要改 4 个地方。
  2. 就算清单下发对了也没用：`stampAssets()` 拿一条正则通扫整份 HTML 里带引号的 `/xxx.css`，把内联脚本里 `window.__ASSET_H__={"/theme/ink.css":…}` 的**键**也改成了 `/theme/ink.css?v=…`；客户端按 `/theme/ink.css` 一路查空，于是「切了主题但没请求样式表」。mermaid 的键同样被改坏，只是一直没人从「为什么没挂上 SRI」这个方向查。
  两条同因 —— 同 P-030（两处内联的资源判定）、P-044（两个 catch）、P-050（两条 canonical 出口）：**同一份规则有第二个实现，就一定会分叉**。
- **复现**：静态页切主题，DevTools Network 过滤 `theme/`。修之前 `ink.css` 的请求 URL 没有 `?v=`，响应头 `cache-control: public, max-age=300, stale-while-revalidate=3600`；修之后带 10 位内容哈希，`max-age=31536000, immutable`。清单被改写则要直接看源码：`curl -s /login | grep -o '"/theme/ink[^,]*'` —— 修之前输出 `"/theme/ink.css?v=fa93572a62"`。
- **修法**：
  1. 引导脚本收进 `src/themeboot.js`（`THEME_BOOT` + `themeBootTag()`），全站唯一一份；静态模板改成 `<!--THEMEBOOT-->` 占位，由 `injectTheme()` 在出口替换（`<!--THEME-->` 排在它前面，先把 `__THEME_DEFAULT__` 落下来）。
  2. 判定改成「**资源清单里有没有 `/theme/<id>.css`**」：有就发请求，没有就说明变量编在主样式表里（纸韵、安知鱼）。代码里不再出现主题名判断 —— 清单由 `ASSET_HASH` 派生，加主题不用改引导。
  3. `stampAssets()` 动标签前先把内联脚本的**内容**摘出去（占位符暂存，最后还原），只加工 `<script src>` / `<link href>` 这类标签本身。这条边界必须显式写出来：脚本里的静态路径是数据，不是引用。
  4. 顺带 `?theme=<id>` 临时预览：只影响当前页，不写 `localStorage`、不写 cookie；白名单限定纯字母数字 2–16 位（这个值会拼进 href，放行斜杠与点就是 `../` 的口子）；面板里手动选过之后用 `history.replaceState` 摘掉参数，免得刷新又跳回预览。带 query 的页面本来就 `no-store`（`harden` 的 search 分支）且不进边缘缓存（`cacheable = !url.search`），预览不会污染缓存。
- **断言**：`scripts/test-theme-contract.mjs` TC-01~TC-18 —— 主题文件选择器必须以 `:root[data-theme="<id>"]` 开头、禁 `@import` 与远程 `url()`、主表只许默认主题骨架且规则数不超过 100、三处清单对齐（`THEME_IDS` / 面板 `THEMES` / 主题文件）、`data-mpref` 只许出现在 `themeboot.js`、静态模板必须有占位且不许留手抄副本、清单每条都带 `v` 与 `i`、预览白名单挡路径穿越、主题名序列化不闭合 script；**TC-16~TC-18 用 `node:vm` 把那段脚本真跑一遍**（选 ink 必须产出一条带 `?v=` 与 `integrity` 的 link；纸韵/安知鱼一条都不发；`?theme=` 生效且脏值不拼 href）—— 前十几条只检查文本，文本全绿而运行时查空正是这个坑的本体。`scripts/test-sri.mjs` 另加一条：内联脚本的 JSON 键不许被戳版本号，标签照戳。注入验证：往 `theme/ink.css` 加一条裸 `.md h2{}` → TC-02 红；往 `style.css` 加一条 `[data-theme="mono"]` → TC-05 红；从 `theme.js` 删掉暮紫 → TC-07 红；把清单的键改成带 `?v=` → TC-16 红；把 `stampAssets` 的遮罩去掉 → SRI 那条红。
- **代价与边界**：引导脚本从约 700 涨到 1030 字节（每页 gzip 后约 +100 B），换一份实现与一份清单。**没有**把安知鱼的 79 条骨架规则搬进 `theme/anzhiyu.css`：实测那 11,283 字节（gzip 占主表 2,370 B / 6.1%）只有非默认主题的读者省得下，默认主题的读者反而多一个请求 —— 净负。主表承载默认主题的骨架是故意的：默认主题的样式必须跟第一个请求一起到。
- **出处**：站务记录（本文件，2026-11-24）；`src/themeboot.js`；`src/index.js` 的 `themeBoot()` / `injectTheme()` / `notFoundPage()`；`src/admin-ui.js`；`public/theme.js`；`public/*.html` 的 `<!--THEMEBOOT-->`

---

## P-052 主题契约只管住了选择器，没管住「能用什么 CSS」

- **现象**：一套主题想做得像样，第一反应是加渐变按钮、柔光底、玻璃拟态导航。加进去立刻和另外七套不是同一个站 —— 亮度层级从「一条发丝线」变成「三层光晕」，而主表的间距与边框是按纯色底定的，糊在一起。
- **根因**：`test-theme-contract.mjs` 从 TC-01 起只校验两件事：选择器必须以 `:root[data-theme="<id>"]` 开头、不许 `@import`／远程 `url()`。选择器对了，里面写什么都不管。而主表里本来就有 16 条 `linear-gradient`、5 条 `radial-gradient`、9 处 `backdrop-filter`（骨架屏、渐隐遮罩、安知鱼的柔光底），新皮肤照着抄是最省事的路。
- **复现**：往 `public/theme/edge.css` 追加一条 `background: linear-gradient(90deg,#000,#fff)` → TC-19 红；写 `backdrop-filter: blur(10px)` → 同一条红。
- **修法**：皮肤文件禁渐变、禁玻璃拟态；主表的例外**不追改**（骨架屏的渐变是加载态语义，渐隐遮罩靠 `mask-image` 是功能，安知鱼的柔光是它自己的骨架规则），只在文档里标清楚「主表不是皮肤该抄的样本」。
- **断言**：`[TC-19]`，扫描前先剥注释与 `backdrop-filter: none` —— 显式关掉继承来的模糊正是这条想要的结果，不该被判违规（第一版就是这么被自己判红的）。
- **出处**：`public/theme/edge.css` 顶注；`scripts/test-theme-contract.mjs` TC-19；站务记录 2026-11-24

## P-053 皮肤写着写着就变成第二个 style.css

- **现象**：新皮肤第一版 3044 B，其中注释占近千字节；`check-size` 的红线是 2000 B，撞线才发现。
- **根因**：把「为什么这么配」写进皮肤文件。皮肤要发到每个用它的读者手上，而理由只有维护者看 —— 理由该在 PITFALLS 与测试文件里。同一笔字节在主表身上早就立过规矩（`check-size` 对 `style.css` 是 gzip 39000 B 硬闸），到了主题文件却没人管，于是新皮肤成了唯一没有预算的样式文件。
- **复现**：`Buffer.byteLength` 追加 3000 字节注释到 `public/theme/forest.css` → TC-20 红（4428 B > 2000 B）。
- **修法**：注释留到能看懂的最小程度，长解释搬进本文件；字体栈只保留真会命中的几个（`Inter` / `JetBrains Mono` 排头，其余走系统栈，`Cascadia Code` 这类逐项列举值不回这 200 字节）。
- **断言**：`[TC-20]` 2000 B，**与 `scripts/check-size.mjs` 同一个数** —— 两个阈值必然漂成两套口径（P-047 的教训）。
- **出处**：`scripts/test-theme-contract.mjs` TC-20；`scripts/check-size.mjs`；站务记录 2026-11-24

## P-054 对比度从没算过，而提「全站 ≥4.5」的那份材料自己过不了

- **现象**：八套主题 × 浅深两态 = 16 组配色，AA 合规一直靠肉眼。有人提议「把对比度实测变成全站规矩」时，没有一条断言能回答现状是多少。实测算下来：现有 14 组全部 ≥ 4.5:1，最低的是 `forest/light` 的 `--accent` 4.90、辅助色最低 5.03 —— 规矩早就满足，缺的只是把它锁住。反过来，材料给的锚定橙 `#F6821F` 在纯白上只有 **2.58:1**：直接当 `--accent`（链接色）用，正好违反材料自己写的那条 `contrast(ink, canvas) >= 4.5`。
- **根因**：`--accent` 在这套 CSS 里同时承担两种角色 —— 文字色（链接、强调）与填充色（按钮底、圆点、进度条）。橙色作为「唯一主操作色」在浅色底上天然过不了文字级 AA，两角色必须拆开，否则要么配色难看（把橙压成砖褐还叫它橙），要么文字读不了。
- **复现**：把 `public/theme/edge.css` 深色块的 `--muted` 改成 `#2a2f36` → 对 `#0d1117` 只有 1.40:1，TC-22 报出 `edge/dark --muted #2a2f36 on #0d1117 = 1.40`；删掉整套深色块 → TC-21 报「缺 dark 变量块」。
- **修法**：`--brand: #f6821f` 只做填充（按钮底配墨蓝字 5.3:1、圆点、竖条、进度条），`--accent: #c2410c` 做文字（5.18:1）。深色底反过来：`#f6821f` 在 `#0d1117` 上 7.33:1，那里可以直接用原色 —— 所以 `edge` 的深色态 `--accent` 就是锚橙本身，这也是「深色是变体不是反相」的落点。
- **断言**：`[TC-22]` 从 CSS 里把 `--bg/--fg/--fg-soft/--muted/--accent` 读出来实算 WCAG 比值，8 套 × 2 态 × 4 色 = 64 组全过；`[TC-21]` 每套必须两态都有变量块（缺深色块会继承上一套的底色，症状是「暗色下这块地是米色的」）。只算这五个色：`--brand`、`--line`、`--tok-*` 不算 —— 前者上面从不放字，后两者是分隔线与代码高亮（高亮按语义选，强求 4.5 会把语法色压成一片灰）。比值不区分谁是字谁是底，所以按钮底与白字的关系同类覆盖。
- **出处**：`public/theme/edge.css`；`scripts/test-theme-contract.mjs` TC-21 / TC-22；站务记录 2026-11-24

## P-055 主题清单抄了四份，5 套的地址栏颜色一直是错的

- **现象**：`<meta name="theme-color">` 与 PWA manifest 的 `theme_color` 取的是手写的 `THEME_COLOR` 常量。实测与各主题 `--bg` 逐值比对，**八套里五套对不上**：`ink` 写 `#f6f6f4` 实为 `#fdfcfa`、`mono` 写 `#ffffff` 实为 `#f4f4f5`、`forest`/`ocean`/`plum` 各差一档。症状是手机上地址栏与页面底色有一道细微的色差，读者不会专门去查，站长也看不见（桌面浏览器不显示这一条）。
- **根因**：同一份「主题清单」在四个地方各写一遍 —— `settings.js` 的 `THEME_IDS`、`theme.js` 的面板 `THEMES`、`index.js` 的 `THEME_COLOR`、`build-sri.mjs` 的目录扫描。前三份是手抄，改主题文件时只改 CSS，常量不跟着动，于是同一套主题有「CSS 里的底色」和「常量里的底色」两个事实。加第 8 套时改了 `THEME_IDS` 与面板，漏了 `THEME_COLOR` 的逐值校对 —— 测试只验「键齐全」，不验「值对不对」，所以全绿。这与 P-030（两处内联的资源判定）、P-044（两个 catch）、P-050（两条 canonical 出口）、P-051（十份防闪脚本）是同一个病：**规则有第二个实现，就一定会分叉**。
- **复现**：`node -e` 读 `src/assets.gen.js` 的 `THEME_BG` 与各主题 CSS 的 `--bg` 比对，`ink` 一项立刻差出 `#f6f6f4` 与 `#fdfcfa`。修之前 `THEME_BG` 还不存在，得先手工 grep 一遍 `--bg` 才发现。
- **修法**：
  1. 新建 `src/theme-contract.js`，把「契约管什么」写成代码：`CONTRACT_CORE`（9 个必填语义色）、`CONTRACT_OPTIONAL`（14 个可选槽位）、`deriveThemeIds(hash)`。变量清单从此只有这一份。
  2. `THEME_IDS` 改成 `deriveThemeIds(ASSET_HASH)` —— 内联两套 + 资源清单里每个 `theme/<id>.css`。加主题不用改它。
  3. `THEME_BG` 由 `build-sri.mjs` 从各主题 CSS 的 `--bg` 抽出来（内联的纸韵取裸 `:root`、安知鱼取自己的 `data-theme` 块），`index.js` 用 `import { THEME_BG as THEME_COLOR }`。手写的常量整段删掉。
  4. 顺带把 `edge.css` 部件规则里写死的 `#d9721a` / `#f0b27d` 换成 `color-mix(in srgb, var(--brand) …)`，新增 `--on-brand` 槽位承接「橙底上的字」（白字在锚橙上只有 2.58:1）。
  5. 手写的只剩 `public/theme.js` 的面板数组 —— 中文名与一句描述没法从文件名推出来，这份必须手写，所以 TC-07 从「序列一致」改成「集合一致」。
- **断言**：`scripts/test-theme-contract.mjs` 新增 TC-24~TC-28，改写 TC-07 与 TC-23。
  - `[TC-24]` 主题文件只许定义 `CONTRACT_VARS` 里的变量 —— 偷偷加 `--my-shadow` 并在组件里用，等于在结构层开后门，单看一套主题永远发现不了。
  - `[TC-25]` 两级规则：光杆 `:root[data-theme=x]` 块只许变量声明与 `color-scheme`（挡住 `background: red !important` 这种「选择器对了、块体里改站」的绕过）；带后代的部件块允许改属性，但色值必须经 `var()`/`color-mix()` 表达，混黑混白除外。
  - `[TC-26]` 契约变量的定义只许出现在 `:root` 块 —— 组件局部变量（`--ava` 这种评论头像哈希色）不在清单里，不受管。
  - `[TC-27]` 每套主题浅色块覆盖全部 9 个必填槽位。第一版写成 `block.includes('--muted:')`，注入 `--xx-muted:` 时没红 —— 假阴性，改成带边界的正则。
  - `[TC-28]` 给 `deriveThemeIds` 一个多出 `theme/probe9.css` 的假清单，新主题必须出现在结果里；反向验 `/../etc.css`、`ABC.css` 这类脏文件名不混进来。
  - `[TC-23]` 逐值比对 `THEME_BG[id]` 与 CSS 里的 `--bg`，并要求 `THEME_IDS` 的定义体真的调用 `deriveThemeIds`（防有人改回字面量）。
  - `[TC-07]` 集合一致而非序列一致。
- **代价与边界**：`THEME_IDS` 依赖 `assets.gen.js`，**忘了跑 `build:sri` 时新主题会不在清单里**，症状是后台选它提示「未知的风格」—— 比「静默回落纸韵」好查，且 `deploy` 与 `npm test` 都会先跑 `build:sri`。`--brand` / `--on-brand` 仍只有 `edge` 一套用，属可选槽位，不要求每套都给。**没有**把 `style.css` 物理拆成 `contract.css` + `structure.css`：那是多一个 RTT，而「两层」靠 TC-26 用断言表达比拆文件更硬 —— 拆开之后两边照样能互相引用变量。
- **出处**：`src/theme-contract.js`；`src/settings.js` 的 `THEME_IDS`；`scripts/build-sri.mjs` 的 `themeBg()`；`src/index.js` 的文件头 import；`public/theme/edge.css`；站务记录 2026-11-24

## P-056 一份 5.6 KB 的主题文件，六成规则打不中任何元素

- **现象**：提「第 9 套主题」的材料给了完整 `ming.css`，5.6 KB，未压缩。逐条比对真实的类名与变量，**能生效的不到 600 B**：`.t-ming …` 前缀（全站没有 `.t-*` class，主题作用域一直是 `[data-theme='x']`）、`.prose`（真名 `.md post-body`）、`.comment`（`.cmt`）、`.card`（`.post-card`）、`.friend-item`（`.friend-card`）、`.dot-ok/.dot-warn/.dot-err`（**零处**，友链三态圆点根本不存在）、`.ai-summary` / `.layout` / `.quote`（零处）、`.token.comment` 等 8 段（渲染器只产 `.tok-k/.tok-s/.tok-c/.tok-n/.tok-f`，Prism 没引入）、`var(--space-4)` / `var(--measure)` / `var(--baseline)`（style.css 里没这几个变量，`padding: var(--space-4)` 整条声明被丢弃 → padding 变 0）、`--canvas/--surface/--surface-2/--ink/--ink-strong/--ink-soft/--ok/--warn/--err`（契约槽位叫 `--bg/--bg-soft/--card/--fg/--fg-soft/--muted/--line/--green/--red`，TC-24 直接红）。
- **根因**：材料是按「一套常见博客主题的命名习惯」写的，不是按这个站的渲染产物写的。CSS 的选择器不匹配**不报错、不警告、HTTP 200**，眼睛不看那个组件就永远发现不了。这跟 P-051（十份防闪脚本）同源，只是那条查的是「同一逻辑几份实现」，这条查的是「实现体根本不存在」。
- **复现**：`for c in prose card comment friend-item dot-ok layout; do grep -c "\.$c[^a-z-]" public/style.css; done` → 六个 0；`grep -o '\-\-space[-0-9]*' public/style.css | sort -u` → 空。
- **修法**：不建 `ming.css`。材料的三条选型（GitHub token 表 / 锚橙只做填充 / JetBrains Mono 系统栈）**11-24 已全部落在 `edge.css` 里**（`cf222e / 0a3069 / 0550ae / 8250df` 与暗色 `ff7b72 / a5d6ff / 79c0ff / d2a8ff`、`--brand: #f6821f` + `--accent: #c2410c`、`--serif: var(--sans)`、`--mono` 带 JetBrains Mono）。新增第 9 套只会让面板出现两个几乎同色的选项。真正能落地的增量只有三条：`--mono` 补齐回退栈（`SFMono-Regular / SF Mono / Liberation Mono`，P-057 的伴生改动）、代码块关连字（P-058）、两条断言（TC-29 / TC-30）。
- **断言**：`[TC-29]` 浅色块里不许出现 `color: var(--brand)`（材料「主色必须稀缺」的可执行版）；`[TC-24]` 与 `[TC-20]` 本来就拦住了越界槽位与超体积。注入验证：在 edge 加 `color: var(--brand)` → 红。
- **出处**：材料「主题『基建』ming v1.0」全文；`public/theme/edge.css`；`scripts/test-theme-contract.mjs` TC-29；站务记录 2026-11-24

## P-057 素材说「按 gzip 比体积」，闸门是原始字节 —— 那是拆闸门不是省流量

- **现象**：材料给的主题文件 5.6 KB 原始 / 1.8 KB gzip，随后建议「P-042 那条 ≤4 KB 的断言按 gzip 比比较合理，因为线上实际传输就是 gzip」。而真实闸门是 **2000 B 原始字节**（比它估的 4 KB 还紧一半），`TC-20` 与 `scripts/check-size.mjs` 用的是同一个数 —— 刻意同口径，因为两个阈值必然漂成两套（P-047 的教训）。
- **根因**：「线上传的是 gzip 所以按 gzip 算」在**单次请求**上成立，在这套体系里不成立：`edge.css` 1898 B 原始 / 约 700 B gzip，一年强缓存 + 一条 `Link: preload`，流量从来不是瓶颈；闸门守的是**主题别长成第二个 style.css**。按 gzip 放宽等于把上限抬到约 5.5 KB 原始 —— 那就是允许主题带骨架了，而骨架必须进主表（P-051 的取舍）。
- **复现**：`node scripts/check-size.mjs` 的 `themeRaw: 2000`；`scripts/test-theme-contract.mjs` 的 TC-20 注释写着「和 check-size 的 2000 B 保持同一个数」。
- **修法**：不动口径。要加内容先腾空间 —— 这次为补全 `--mono` 回退栈（+46 B）把 edge 的开头注释从两行压成一行（省 80 B），净落到 1898 B，余 102 B。
- **断言**：`[TC-20]` 逐文件原始字节 ≤ 2000。
- **出处**：`scripts/check-size.mjs` 的 `LIMITS.themeRaw`；`scripts/test-theme-contract.mjs` TC-20；`public/theme/edge.css`；站务记录 2026-11-24

## P-058 正文的连字设置顺着同一个 div 漏进了代码块

- **现象**：文章页容器是 `<div class="md post-body">`（`src/index.js:1253`）—— `.md` 和 `.post-body` 是**同一个元素**。`.post-body` 上有 `font-feature-settings: "kern" 1, "liga" 1`（中文排版要走 kerning），`<pre>` / `<code>` 是它的后代，直接继承这个值。于是代码块里的 `=>`、`!=`、`->` 在等宽字体下被合成单字形。中文技术文里这三个符号出现极密，合成后反而更难扫读。
- **根因**：这条属性从来没人「写」在代码块上，是继承来的 —— 所以 grep `pre` 永远查不到，只有在浏览器里盯着代码块看才可能注意到。材料那条「连字默认关」的判断是对的，但它归因于「用户显式开启」，实际原因是**站内某处已经开了**。
- **复现**：注释掉 `public/style.css` 里那条 `.md code, .md pre, .md pre code { font-variant-ligatures: none; … }`，在装了 JetBrains Mono / Fira Code 的机器上看任意带 `=>` 的文章页。
- **修法**：`.md code, .md pre, .md pre code { font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }`。`calt` 一起关 —— 上下文替代在等宽字体里同样会改字形。行内代码也要关：`Ctrl/Cmd + S` 这类连写不该被合成。
- **断言**：`[TC-31]` 要求 style.css 里存在这条覆盖，**并且**反向核查 `.post-body` 仍开着 `"liga" 1` —— 哪天正文关了连字，这条覆盖就多余，断言该一起删（否则会留一条没人知道为什么在的规则）。
- **出处**：`public/style.css`（`.md code, .md pre` 规则）；`src/index.js:1253`；`scripts/test-theme-contract.mjs` TC-31；站务记录 2026-11-24

## P-059 假绿不只在「没跑红」，还在「期望空集的断言分不清没看见和没问题」

- **现象**：材料给了一份 240 行的 `check-theme-contract.mjs`，七条断言分三层（静态 / 计算 / 契约完整性），并明确说「P-044 和 P-045 必须写成变异测试，这是整个文件的重点」。**方法论全对**，但脚本本身跑不起来：`public/themes/`（真为 `public/theme/`）、`src/theme.js`（不存在，主题清单在 `settings.js` + `theme-contract.js`）、`const THEMES = [...]`（真为 `THEME_IDS = deriveThemeIds(ASSET_HASH)`）三处路径全空，`P-041~P-047` 七个编号也全部已被别的主题占用（尺寸断言读二进制 / 越界页码 / sitemap lastmod / 500 页分观众 / 500 双出口 / 管理员席位 / 文档数字）。
- **根因**：材料把「断言会红」这件事交给了 `--mutate` 开关和人工命令，而**开关型断言会被跳过当成通过**；更糟的是它自己的元断言是假绿的 —— `const 放行 = [...d.public].every(v => CONTRACT_VARS.includes(v))`，`d.public` 为空时 `every` 恒 `true`。它论证「注入 `_` 前缀必须放行」，而这行代码在**根本没解析出任何变量**时同样返回 true。
- **复现**：我按同一思路写的 TC-34 第一版里，`definedVars` 的正则是 `/(--[a-z0-9-]+)\s*:/` —— 字符类漏了 `_`，于是 `--_cd-bg` **一个都认不出来**。往 `edge.css` 注入 `--_cd-bg: #f6f8fa` 后在 `.btn.primary` 里 `var(--_cd-bg)`，TC-24 报「悬空引用」，而 TC-34 报 **pass**。它期望 `[]`，没认出来也是 `[]`。
- **修法**：
  1. 把探测逻辑从 `t()` 里抽成纯函数 `definedVars()` / `outsideVars()` —— 只有能对一段注入字符串单独调用，才验得了自己。
  2. 变异测试**常开**，不做 `--mutate` 分支：纯内存字符串、不碰磁盘、零成本，所以「跳过」这个状态根本不存在。
  3. **凡期望空集的断言，必须配一条「必须看见」的锚点**：`outsideVars(x)` 为 `[]` 之外，再加 `definedVars(x)` 必须等于预期的非空集合。这一条把「什么都没抓到」和「抓到了且合规」分开。
  4. 材料的 P-044（数 `git status --porcelain` 的改动文件）自带「工作区脏就空转」的边界，没采用 —— 改用 TC-28 的假清单派生法：给 `deriveThemeIds()` 一个多出 `theme/probe9.css` 的假 hash，验新主题自己长出来，不写磁盘、不受工作区状态影响。
  5. 采纳材料的 `--_` 前缀逃生口，但补两条护栏写进 `src/theme-contract.js` 的 `INTERNAL_PREFIX`：定义与引用必须同文件、主表零处 `var(--_x)` 与 `--_x:` 定义。
- **断言**：`[TC-32]` 用 Primer 官方四色（16.02 / 7.51 / 12.31 / 6.15，容差 0.02）反查 `contrast()` 实现，堵住「算法错了但对比度断言全绿」；`[TC-33]` 注入契约外变量必须被抓到；`[TC-34]` `_` 前缀放行**且必须看得见**、`var()` 是「用」不是「定义」、部件块里的越界定义不许漏。三条全部实跑注入：正则去掉 `_` → TC-34 红；`srgbToLinear` 阈值改坏 → TC-32 报 `#e6edf3 实算 16.15 ≠ 官方 16.02`。
- **边界**：TC-32 的四色基线抄的是 Primer 公开主题表，**没有在浏览器里核对渲染结果**；它验的是「WCAG 公式实现对不对」，不是「GitHub 那套配色好不好看」。
- **出处**：材料「七条断言不是七个 check()，而是三层」全文；`scripts/test-theme-contract.mjs` TC-32/33/34；`src/theme-contract.js` 的 `INTERNAL_PREFIX`；`THEME-CONTRACT.md` 规则 4；站务记录 2026-11-24

## P-060 一天里三份主题材料按「常见博客」猜类名，命中率为零而 HTTP 全 200

- **现象**：2026-11-24 收到的三份主题材料（ming.css 5.6 KB → 三层断言脚本 → 选择器兜底修订）累计引用了 `.prose` / `.ai-summary` / `[data-ai-summary]` / `.comment` / `.friend-item` / `.dot-ok/.dot-warn/.dot-err` / `.token.keyword` 八个名称，**真实仓库里全部零命中**。第三份还推断「代码块输出一定是 `<pre><code>`，容器可能叫 `.code-block`」——方向恰好相反：容器是 `.code-wrap`，`.code-block` 是 `<pre>` 自己的 class，所以「`.pre` 与 `.code-block` 两条兜底」是重复命中同一个节点。它估 `var(--brand)` 出现 3 处，实测 `edge.css` 是 4 处，把 `BRAND_USES` 定成 3 或 2 在本站第一跑就红。
- **根因**：CSS 选择器打不中元素**没有任何反馈** —— 不报错、不告警、HTTP 200、页面也照样打开，只是那一段样式没生效。所以「按一类博客的常见命名写主题」可以连续失败三次而不自知。这与 P-056（5.6 KB 里六成规则打不中）同源，但那条讲单个文件，这条讲**同一类错误能被反复提出**。
- **复现**：`node --input-type=module -e "import('./public/md.js').then(m=>console.log(m.renderMarkdown('\`\`\`js\nconst a=1;\n\`\`\`')))"` —— 一次渲染就能看到真实标签：`<div class="code-wrap" data-lang data-lines><div class="code-head"><span class="code-lang">js</span><button class="copy-btn" data-copy>复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span>…`。摘要则是 `<aside class="post-lead"><span class="lead-tag">AI 摘要</span><p>…`（`index.js:1182`），不是 `.ai-summary`。
- **修法**：`THEME-CONTRACT.md` 新增第四节「结构层 DOM 事实」，把 8 类元素的真实结构、被猜成过的名字、以及两条硬结论写在表里（容器是 `.code-wrap`；友链三态圆点**不存在**）。写在文档里而不是只在对话里，是因为下次来的是另一份材料，它不会读对话记录。
- **断言**：`[TC-35]` **真渲染一次**（`renderMarkdown('```js…```')`）验产物，不 grep 模板字符串 —— grep 漏得掉「事后包装」和变量拼接。四个结构事实：以 `.code-wrap` 开头、`<pre class="code-block">`、`<code class="language-js">`、`<span class="tok-*">`；`.post-lead` 由 `index.js` 的 SSR 模板产出，单独查。`[TC-36]` 验反面：产物里不许出现 `class="token"`，**且必须有 `tok-*` 作正面锚点** —— 否则「没有 token」对「代码块根本没高亮」同样成立（P-059 那条教训的同一个形态）。注入验证：`tok-*` 全改 `token x` → TC-35 报「语法钩子是 .tok-*」、TC-36 报「出现 class="token"」；`pre` 去掉 `code-block` → TC-35 报「`<pre>` 自己带 .code-block」。**否定断言不能和正向断言写在一个 `t()` 里** —— 正向那条先抛，否定永远走不到，等于验了但验不到。
- **边界**：TC-35 / TC-36 守的是 SSR 产物。客户端若在 `app.js` 里再包一层，断言看不到 —— 但代码块工具栏（`.code-head` / 复制按钮 / 行号）本来就是 `md.js` 产出的，客户端只接管事件。另：材料建议的 `data-ai-summary` 属性契约没采纳 —— 摘要已有 `.post-lead` + `.lead-tag`（`post.summary_src === 'ai'` 已区分来源），加属性要改 Worker，破坏「加主题只动两处」；且它说「属性选择器优先级低于 class」是错的，两者都是 (0,1,0)，同优先级、只看出现顺序。
- **出处**：`THEME-CONTRACT.md` 第四节；`scripts/test-theme-contract.mjs` TC-35 / TC-36；`public/md.js:386-402`（`renderMarkdown` 里的围栏替换，函数名不叫 `fence`）；`src/index.js:1182`；站务记录 2026-11-24

## P-061 代码块 token 类别：渲染器与样式表各自演化，谁都看不见对方少了一类

- **现象**：`highlight()` 只产出 5 类钩子（`tok-k / tok-s / tok-n / tok-f / tok-c`），`style.css` 也只定义 5 条规则（635-639 行），**今天恰好对齐，但没有任何东西保证它明天还对**。第四份材料点出前半段真缺口：渲染器新增第 6 类（比如给正则加 `tok-r`），`style.css` 没规则、主题没变量 → 那个 token 落回继承色，页面正常、HTTP 200、工具不报警。反过来方向同样成立：样式里留着产物永远不产出的 `.tok-x` 是死规则，半年后有人去改它，以为自己改的是颜色。
- **根因**：`TC-35`（结构事实）与 `TC-36`（钩子只有一个名字）都只验**存在**，不验**集合相等**。契约槽位只有 4 个 `--tok-*`，而类别有 5 个 —— 第 5 类（注释）走 `--muted` 而不占槽位，这个事实只活在 `style.css` 一行里，没写进契约。
- **复现**：在 `md.js` 的 `highlight()` 返回处只增不减地插一个 `<span class="tok-r">`（不动其余 5 类），再跑 `node scripts/test-theme-contract.mjs`；或在 `style.css` 末尾加 `.tok-z { color: #f00 }`。两种改法在 P-061 之前都是全绿。
- **断言**：`TC-37` 双向比对 `produced`（真渲染产物里的 `class="tok-*"`）与 `styled`（`style.css` 里的 `.tok-x {`），两个方向的差集都必须为空。**先要求 `produced.size >= 4`** 再比子集 —— 否则「产物 ⊆ 样式」对空集恒成立（P-059 那个形态）。注入验证：插 `tok-r` → 报「渲染器产出了没有样式的 token 类别：tok-r」；加 `.tok-z` → 报「死规则」。
- **边界**：第 5 类注释色绑 `--muted` 而不是独立槽位，是既定取舍（`--tok-c` 走 muted，所以 `P-057` 才要单独验 `--muted` on `--bg-soft`）。想把注释做成第 5 个槽位，得先改契约、八套主题各补一个值 —— 收益不抵成本。
- **出处**：`scripts/test-theme-contract.mjs` TC-37；`public/md.js:45-73`（`highlight()`）；`public/style.css:635-639`；站务记录 2026-11-24

## P-062 主题 CSS 那一侧从来没有反向校验：写一条谁都产不出的选择器，六条断言全绿

- **现象**：在 `edge.css` 写 `.tok-z { color: #f00 }` 或 `.code-badge { … }`，`TC-35/36/37` 全绿（产物侧没变）、`P-043` 绿（查变量不查选择器）、`P-046` 绿（数 `--brand`）、体积断言更绿（还更省）。一条死规则可以静静躺到半年后，等一个人去改它、并且以为自己在改颜色。这是四份材料累计暴露的最后一个盲区：所有校验都在「产物侧」和「变量侧」，没有一个在「主题文件的选择器侧」。
- **根因**：`TC-24/25/26` 都在验「变量写在哪」，`TC-35` 验「产物长什么样」，中间那条「主题选中的类名是否真的存在」没人管。
- **复现**：`printf '\n:root[data-theme="edge"] .code-badge { color: var(--fg); }\n' >> public/theme/edge.css` 后跑测试 —— P-062 之前 37 条全绿。
- **断言**：`TC-38` 建一张**全站类名表**，来源是产出侧（`src/*.js` 的 SSR 模板、`public/md.js`、`public/*.html`、`public/*.js`）的 `class="…"` 字面量，加 `.className = '…'` / `.classList.add('…')` 的动态赋值，然后要求每个主题文件里的类名选择器都在表里。**不用 `style.css` 当基准** —— 那两边可以一起烂，是循环论证。注入验证：往 `edge.css` 加 `.code-badge` → 红「全站没有任何元素产出的类名」。
- **边界**：类名表是字符串采集，不解析 AST。真正的反例是「类名只出现在 CSS 变量名或注释里」被误收 —— 所以它只做**否定判定**（不在表里 = 一定死），不做「在表里 = 一定活」。也不做材料建议的硬编码白名单：实测 `app.js` 的 `btn.className = 'back-top'` 就是动态类，多两条采集正则比维护白名单省，且不会漏。
- **出处**：`scripts/test-theme-contract.mjs` TC-38；`public/app.js:497`；站务记录 2026-11-24

## P-063 「一个 `t()` 只许一条 assert」是本仓库不收的规矩，但材料给的判据本身又是一条假绿

- **现象**：第四份材料提 `TC-38`（元断言）要治「否定断言被前序断言遮蔽」，判据写成 `firstThrow === -1 || firstThrow > lastAssert || countAsserts <= 1`。实测这行**只等价于「每个测试体最多一条 assert」**：`firstThrow` 是首条 assert 的下标、`lastAssert` 是最后一条的下标，多条时 `firstThrow < lastAssert` 恒成立，两个分支同时为假 → 红。于是它会**红掉「两条正面断言」**（无害，本仓库 35 个 `t()` 块里 25 个如此），却对「只有反面断言」放行 —— 与它声称要抓的东西不等价。
- **根因**：把「可观测性」问题写成了「数量」判据。真问题是「一条断言失败会掩盖同一块里后面那条」，它与 assert 的条数无关，只与**先后关系**和**是否互为反面**有关。
- **复现**：把材料那行判据打进 `node -e`，喂四组字符串：`"一条正面"` 通过、`"两条正面"` **红**（无害却判红）、`"正面+反面"` 红（想抓的）、`"只有反面"` 通过 —— 与「否定断言被遮蔽」不等价。
- **断言**：无。本条是纪律不是断言，机械判据实测误报 46/459 个测试块（全仓 `test-*.mjs` 里「反面断言不在首位」的块数），误报率高于收益时断言就该删 —— 与 P-056「正则防得住 A 防不住 B」同一条取舍线。保留的可执行部分在 `TC-36`：反面断言独立成 `t()`，且配正面锚点。
- **边界**：只能靠 review。判断方法不是正则，是问「如果这条红了，我能不能看到那条的结果」。
- **出处**：第四份材料「TC-38 元断言」全文；`P-060` 的否定断言拆分；站务记录 2026-11-24

## P-064 契约与消费侧两头都缺对账：一边引用不存在的变量，一边挂着没人读的槽位

- **现象**：`public/style.css` 里写 `color: var(--tok-r)` 而全站没有这个变量 → **整条声明被丢弃**，边框少一圈、颜色退回继承值，不报错、HTTP 200。反方向同样成立：契约里挂着 `--hero-weight`（`style.css` 浅色 `600` / 深色 `700`），实测 **0 处引用** —— 八套主题一个都没定义它，`.page-head h1` 只吃了 `--hero-space`，所以它是一个替「标题字重」这个从没接上的设计意图占位的槽位，白占契约文档一行。
- **根因**：`TC-24/25/26` 只见「主题文件能写什么」，`TC-37` 只见「产物 ↔ 样式表」，中间那条「结构层引用的变量有没有来源」「契约槽位有没有人读」两头都没人管。第五份材料的 `TC-41`（产物 `tok-*` ⊆ 主题覆盖）方向是对的，但那一层已被 `TC-37` + 契约覆盖（`.tok-*` 的颜色变量全是契约槽位），真正空着的是它没说的这两头。
- **复现**：`printf '\n.x-probe { color: var(--tok-r); }\n' >> public/style.css` → TC-39 报「结构层引用了无处可寻的变量」；把 `'--hero-weight',` 加回 `src/theme-contract.js` 的 `CONTRACT_OPTIONAL` → TC-39 报「契约里的槽位没有任何样式引用」。
- **断言**：`TC-39` 双向。正向取 `style.css` 里**不带 fallback** 的 `var(--x)`，要求每个都能解析到「本文件里的定义」或「契约槽位」；带 fallback 的（`var(--border, #e3e5e8)`、`var(--toc-p, 0)`）是有意给默认值，放行。反向取契约 23 个槽位，要求每一个至少被主表或任一主题文件引用过 —— `--brand` / `--on-brand` 只被 `edge` 用，正好当「主题文件真的被读进来了」的锚点。两个方向都先要求「看得见」（定义 ≥15、引用 ≥15、槽位 ≥20），否则「差集为空」对空集恒成立（P-059 那个形态）。
- **边界**：只查 `style.css`，不查 `public/app.js` 里 JS 写进去的内联变量（`--toc-p` 就是运行时由 JS 赋值的，靠 fallback 兜底）。也不判断「槽位是否**该**被消费」——`--brand` 只给主题自己用是设计，不是缺陷，所以判据是「至少一处引用」而不是「主表必须引用」。
- **出处**：`scripts/test-theme-contract.mjs` TC-39；`src/theme-contract.js`；`public/style.css:26 / 1881`（删除的两行）；`THEME-CONTRACT.md` 第二节；站务记录 2026-11-24

## P-065 动态类名是拼出来的，采集器看不见 —— 活选择器被判成死规则

- **现象**：`public/editor.html:731` 写的是 `stateEl.className = 'save-state ' + kind`，`kind` 只取 `'saving'` / `'error'` 两个值。这两个类名在 HTML 与 JS 里都不以字面量出现，于是全站类名表里没有它们：主题为保存中/出错状态写 `.save-state.saving` 时，`TC-38` 会把它判成**死规则**并拦下；反过来主题不写，这两个状态就是没人能覆盖的孤儿。同一形态的还有模板字符串 `classList.add(\`is-${state}\`)`。
- **根因**：类名采集器只能读**字面量**。它在读不到名字时不会红，只会让「全站类名表」安静地少一项 —— 这正是 `P-059` 那个空集恒真在采集侧的翻版。材料给的解法是 `DYNAMIC_PATTERNS = [/^is-/, /^state-/, /^has-/]` 前缀白名单，那等于把「哪些是动态类」变成一条**没人执行的命名纪律**：写成 `is-` 就算，写成 `open-state` 就漏 —— 与它自己反对的名字白名单是同一个病，只是换了维度。
- **复现**：把 `editor.html` 的 `classList.toggle('saving', …)` 改回 `className = 'save-state ' + kind` → `TC-40` 报「动态类名是拼出来的」；把 `app.js` 的 `classList.add('clipped')` 改成 `` classList.add(`clipped-${1}`) `` → 同样报，且括号里带上原文方便定位。
- **断言**：`TC-40` 判**写法**不判名字 —— 三种形态（`classList.*` / `.className =` / `setAttribute('class', …)`）的首个类名参数必须是纯字面量，出现拼接或模板字符串就红，并提示二选一（改成字面量 / 扩展 `scanDynamicClasses`）。配正面锚点：全仓抽到的动态类名总数 ≥10，否则「零处拼接」对「采集器死了」同样成立。另外 `TC-38` 自带**分形态失明锚点**：用一条互不依赖的 `RAW_FORM` 正则数「源码里这种形态出现几次」，与采集器的认领次数比，出现却一次都没认领就红（把 `classList\.` 手滑成 `classLst\.` → 报「源码里 18 处 classList，采集器一处都没认出来」）。
- **边界**：只覆盖上述三种写法。`el.classList.value = tpl`、`el.setAttribute('class', a + b)` 之外的 `outerHTML` 拼接、框架 diff 出来的类名都不在射程内 —— 它们的共同点是「CSS 选择器本来就该写在模板里」，不在主题契约的范围。也不判「这个动态类该不该存在」，只判「它的名字能不能被静态读到」。
- **出处**：`scripts/test-theme-contract.mjs` TC-38 / TC-40；`public/editor.html:568 / 730`；`public/app.js` 的 15 个动态类；站务记录 2026-11-24

---

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
