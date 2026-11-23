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
