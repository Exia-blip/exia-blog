# PITFALLS.md — 现象 → 根因 → 复现 → 断言 → 出处

规则：编号 `P-NNN` 一旦分配**永不复用**。每条固定五个字段、顺序不变；少一个字段，
半年后就看不懂它。断言字段必须写出**脚本名 + 可执行判定**，"检查 sticky"这类话不算断言。

`npm run check:pitfalls` 双向对账：脚本里出现的编号必须有文档条目（否则 fail），
文档里没人引用的编号只**警告**——那就是「已知但未自动化」，对应每篇文章末尾「明说的没做」。
排查时先按现象 grep 本文件，找到就跑断言字段里的命令，别重新从代码翻起。

## 通用纪律：扫源码形态的断言，搜索域里必须没有「孪生文本」

凡是「源码里必须出现／不许出现 X」的断言（不管用 `indexOf`、正则还是别的），写之前先问一句：
**这段文字还在哪里出现过？** 三类位置经常出现与目标同形的文本，判据分不清：

| 污染源 | 长什么样 | 为什么会出现 |
|---|---|---|
| 注释 | 讲解时把错误写法原样抄一遍：`// 别写成 const X = [...new Set([...])]` | 为了让判据被理解，人会把要找的那段抄进注释 —— **文档写得越好，判据越容易被自己毒死** |
| 字符串字面量 | 断言自己的 `indexOf('const X = ')`、报错文案里的示例代码 | 判据的搜索域天然包含判据自身 |
| 文档 | `PITFALLS.md` / `THEME-CONTRACT.md` 里的示例片段 | 同上，且不再受同一文件约束 |

对策两条，缺一不可：**行首锚定**（`^const X\s*=`，排掉缩进散文与引号内字面量）+ **唯一性计数**（`matchAll` 必须恰好 1 条，排掉顶格的块注释伪定义）。再加一条认知修正：**长度锚点只证明「切到了东西」，不证明「切对了」**——切出 345 字符的散文照样过 `>40`。

不做到词法分析：语义等价的改写（`const` → `let`、helper 生成、搬去 `scripts/lib/`）本来就不该被判红，正确行为是**先红、等人手工重指**。实例见 P-073，同族见 P-072。

第二个实例是 `check-pitfalls.mjs`：它用 `/^## (P-\d{3})\b/gm` 认条目，而不是 `P-\d{3}` 全局匹配 —— 因为这份文档正文里天天提到 `P-0xx`，不锚行首就会把「提及」当成「条目」。**上表的三类污染源只有落在断言真正读取的文件里才算污染**，读哪些文件由断言自己决定。

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
- **边界**：只能靠 review。判断方法不是正则，是问「如果这条红了，我能不能看到那条的结果」。**允许**一个 `t()` 里有多条正面断言（它们不是彼此的否定，通常验同一属性的连续推导，第一条失败就该停下修根因）；**禁止**反面断言与它否定的那条正面同处一个 `t()`。最省的手工判据：把正面那条注释掉，看反面那条还能不能单独跑出结果 —— 不能就是同一个块。
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
- **出处**：`scripts/test-theme-contract.mjs` TC-38 / TC-40；`public/editor.html:568 / 730`；全仓 39 个动态类名（`classList` 78 处 / `.className =` 15 处 / `setAttribute('class')` 0 处，去重后 39 个，全部来自 `public/**` 的客户端脚本与静态页内联脚本，`src/**` 的 SSR 模板里只有 3 个）；站务记录 2026-11-24

## P-066 语法高亮的第 5 类没有槽位，结构层「就近找个变量」凑 —— 三道闸一起放过

- **现象**：`highlight()` 产出 5 类 token（`k` 关键字 / `s` 字符串 / `n` 数字 / `f` 函数 / `c` 注释），契约只有 4 个 `--tok-*` 槽位。第 5 类由 `style.css:636` 的 `.tok-c { color: var(--muted) }` 借用辅助文字色兜底。这条规则同时穿过三道闸：`TC-37` 绿（类别在产物里、也有样式规则）、`P-043` 绿（`--muted` 是契约变量）、`P-046` 绿（不碰 `--brand`）。
- **根因**：所有断言都只看「类别在不在」，没有一个看**颜色从哪来**。真正危险的不是这一次借用（注释色和辅助文字同色是合理的），而是这条缝的形状：槽位数少于产出类别数时，差额由结构层**就近挑一个变量**填上 —— 挑对了没人记得，挑错了没人发现，下次新增第 6 类照旧。这正是「看起来能用」。
- **复现**：把 `.tok-c` 的 `var(--muted)` 改成 `var(--fg-soft)`（仍然是合法契约变量、视觉上也还看得清）→ 三道闸全绿，只有 `TC-41` 报「表说的是 `--muted`，`style.css` 里写的是 `--fg-soft`」。把 `TOK_EXCEPTION` 清空 → 报「既没有 `--tok-c` 槽位，也没进例外表」。给例外表加一个不存在的类别 `r` → 报「渲染器不产出这一类，登记是空头」。
- **断言**：`TC-41` 四方闭环 —— ① 产出的每一类若有 `--tok-x` 槽位，`style.css` 该类的 `color` 必须是 `var(--tok-x)`；② 若没槽位，必须在 `TOK_EXCEPTION`（`src/theme-contract.js`，当前一条 `{ c: '--muted' }`）且 `color` 与表里的值一致；③ 例外表的键必须是真实产出的类别、值必须是契约变量（**不许开空头**，这是它不退化成「随便塞名字的白名单」的那一半）；④ 契约里每个 `--tok-*` 槽位都必须被某一类真的用上（死槽位也红）。先要求 `produced.size >= 4`、`colorOf.size >= 4`，否则四条子集判断对空集恒成立（P-059 形态）。
- **边界**：只认 `style.css` 里 `.tok-x { color: var(--y) }` 这一种写法。主题文件里给 `.tok-*` 改色不在此列 —— 那是主题自己的口味，把注释色改成 `--accent` 是允许的（`--accent` 也是契约变量，仍然要过对比度）。也未覆盖 `font-style` 等其他属性。
- **出处**：`scripts/test-theme-contract.mjs` TC-41；`src/theme-contract.js` 的 `TOK_EXCEPTION`；`public/style.css:634-638`；`public/md.js:45-73`；站务记录 2026-11-24

## P-067 代码块底色与边框只归 `.code-wrap`：pre 自己画一层，横滚时盖住左框

- **现象**：`.code-wrap`（`style.css:573`）承载边框、圆角、底色、`overflow: hidden`，`pre.code-block` 自己 `background: transparent`（586 行）。若有人给 `pre` 补回背景或边框，页面平时看不出来，**只在长代码块横向滚动时**，`pre` 的底色会盖住 wrap 的左框、圆角也会被顶开 —— 需要滚到最右再滚回来才看得到，截图和肉眼巡检都容易漏。
- **根因**：双层结构里「谁负责画框」没有断言。`TC-35` 只验产物结构（`pre.code-block` 存在），`TC-37` 只验 token 类别，样式分工无人管。材料给过一条判据，但**没排除 `@media print`**，直接跑会在打印块上误报：打印纸没有滚动容器，不存在「滚动盖住左框」，而白纸上必须画出边界，所以 `@media print` 里 `border: 1px solid #d6d6d6; background: #fafafa` 是有意写的。
- **复现**：把 586 行的 `background: transparent` 改成 `var(--bg-soft)` → `TC-42` 报「`.md pre.code-block` 设了 `background: var(--bg-soft)`」；另加一条 `.md .code-wrap pre.code-block { background: #fff }` → 同样报。把打印块里的边框加粗成 `2px solid #000` → **不报**（`@media print` 豁免成立）。
- **断言**：`TC-42` 自带一个能识别 `@media` 上下文的极简 CSS 扫描器（逐字符配对大括号，维护 at-rule 栈），只看「最后一个复合选择器是 `pre.code-block`」的规则，要求 `background` ∈ {transparent, none, inherit, unset, initial} 且 `border` 缺省或为 `0`/`none`。必须带 `.code-block` 类：`.friend-apply pre`（表单预览块）不是代码块，不该被这条管。正面锚点是**解析到的规则条数 ≥2**，不是「某条声明还在」—— 后者会把「有人给 pre 加回背景」误报成「解析器坏了」，指向错的根因（这个错误我第一版真的犯了）。
- **边界**：只查 `public/style.css` 与 `public/theme/*.css` 的静态规则，不查 JS 写进去的内联样式。也不管 `>.gutter` 自己的底色（那是行号列，独立背景是有意的，打印块里同样给了 `#fafafa`）。
- **出处**：`scripts/test-theme-contract.mjs` TC-42；`public/style.css:573 / 586 / 2630`（打印块）；站务记录 2026-11-24

## P-068 「源清单无重复」的判据写在已去重的值上，恒真 —— 重复一直真实存在

- **现象**：类名采集的源清单是 `[...new Set(['public/md.js', 'public/app.js', ...src/*.js, ...public/*.{html,js}])]`。`md.js` / `app.js` 既被显式列出、又被 `public/*.js` 通配命中，重复是**结构性**的。要防它，材料给的是 `sourceList.length === new Set(sourceList).size` —— 但 `sourceList` 在这个文件里已经是 Set 展开过的结果，左右两边永远相等。一条 100% 通过的断言，守着一个真实存在的重复。
- **根因**：判据的输入是**它自己要检验的那一步转换的产物**。这和 P-059（空集恒真）、P-063（判据只等价于「每块最多一条」）是同一个病的第三种形态：不是空集、不是等价弱化，而是**同一表达式出现在等式两边**。任何「A 应该覆盖 B」的断言都需要一个与 A、B 都独立的第三计数（`TC-38` 的 `RAW_FORM` 就是），这里连 A 都被提前改写了。
- **复现**：保留未去重的 `CLASS_SOURCES_RAW` 后直接跑 → `TC-43` 报「源清单里重复出现：public/app.js, public/md.js」（第一次跑就是红的，不是构造出来的）；修法是让通配只补漏（剔掉已显式列出的两个文件），`CLASS_SOURCES_RAW` 本身无重复，`Set` 保留作保险。
- **断言**：`TC-43` 遍历原始清单做判重（`seen.has(f)` 而非长度比较），配两条锚点：`src/` 项 ≥20、`public/` 项 ≥8、总数 ≥40 —— 实测 48（src 33 / public 15）。锚点必须存在，否则「清单只剩硬编码两项时无重复」同样成立，而那意味着 SSR 模板整个没被扫。注入验证：显式加一行 `'public/theme.js'` → 报重复；删掉 `src/*.js` 通配 → 报「清单只展开到 15 项（src 0 / public 15）—— 通配失效了」。
- **边界**：只判**完全相同的路径字符串**。`./public/x` 与 `public/x`、`public//x` 这种同文件不同写法不在射程内（当前清单由同一份 `readdirSync` 拼出，不会产生）；也不判「两份内容相同的副本文件」—— 那是复制粘贴的问题，路径判重抓不到。
- **出处**：`scripts/test-theme-contract.mjs` 的 `CLASS_SOURCES_RAW` / TC-43；第七份材料「源清单 app.js 重复」；站务记录 2026-11-24

## P-069 动态类的「SSR 可见率」是 3/39，但这不是缺陷 —— 阈值 30% 会把设计判成 bug

- **现象**：全仓 39 个动态类名里，只有 `on` / `active` / `warn` 三个同时以 `class="…"` 字面量出现在 `src/**` 的 SSR 模板里（`admin-ui.js` / `index.js` / `dashboard.js`），其余 **36 个在任何 HTML 字面量里都不出现**：`public/*.js` 与 `public/*.html` 的内联脚本用 `classList.*` / `className =` 创建它们。静态页 `class="…"` 里能捞到的只有 `on` / `active` 两个，且都在那 3 个之内。可见率 3/39 ≈ 7.7%。
- **根因**：这 36 个里，`read-bar` / `back-top` / `lb`（灯箱）/ `mtoc`（移动目录）/ `copy-link` / `nav-prog` 全是 **JS 建出来的交互增强件**：无 JS 时元素根本不存在，也就不需要样式，更不会产生 CLS（不存在的东西不参与布局）。把它们和「状态样式失效」归成一类，等于要求交互件必须在 HTML 里预先躺一份空壳 —— 那是另一种设计，不是这条站的缺陷。材料拍的 30% 阈值必然红，红的理由却是口径错了。
- **复现**：不需要整页渲染，12 行就够 —— 抽动态类名字，再与「`src/**` 的 `class="…"` 字面量」「`public/**` 的 `class="…"` 字面量」各求一次交集。落盘 `probe-dyn.mjs` 后 `node probe-dyn.mjs`，输出 `动态类 39 个 | SSR 模板可见 3（on active warn） | 静态页可见 2 | 仅 JS 挂载 36`（静态页那 2 个是 `on` / `active`，仍在那 3 个之内）：
  ```js
  import { readdirSync, readFileSync } from 'node:fs';
  const list = (d) => readdirSync(d).filter((f) => /\.(js|html)$/.test(f)).map((f) => `${d}/${f}`);
  const files = [...list('src'), ...list('public')];
  const dyn = new Set(); const add = (s) => s.split(/\s+/).filter(Boolean).forEach((c) => dyn.add(c));
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g)) { const s = m[1].match(/^\s*['"]([^'"]*)['"]/); if (s) add(s[1]); }
    for (const m of t.matchAll(/\.className\s*\+?=\s*['"]([^'"]*)['"]/g)) add(m[1]);
  }
  const lit = (p) => new Set(files.filter((f) => f.startsWith(p))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/class="([^"]*)"/g)])
    .flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  const ssr = lit('src/'), html = lit('public/');
  console.log(`动态类 ${dyn.size} | SSR 可见 ${[...dyn].filter((c) => ssr.has(c)).length} | 仅 JS 挂载 ${[...dyn].filter((c) => !ssr.has(c) && !html.has(c)).length}`);
  ```
- **断言**：**不写阈值断言**，这是本轮唯一主动拒绝的一条，理由三条：① 判据要问的是「元素该不该在 SSR 里」，机器只能回答「元素在不在」，把前者写成阈值就是把设计意图编码成拍出来的数字；② 整页渲染也拿不到更多信息 —— `servePostPage` 直出的 HTML 本来就没有 JS 建的元素，`renderPage()` 花两百行 fake 掉 `env.DB`（5 条查询）与 `assetText`（R2），产出的仍然是 3/39，而 fake 层会被任意一条 SQL 改动打断；③ 真要产物级结论，正确工具是无头 Chrome 关 JS 跑一次 `document.querySelectorAll`，那是 `check-live` 的活，不该进 `npm test`。数字钉在这里，比钉在一条永远绿的断言上更有用。
- **边界**：3/39 是**今天**的快照（2026-11-24）。有人把导航或目录改成 SSR 直出，这个数会上升，断言不存在也就不会提示更新 —— 这是主动接受的漂移。另：`classList` 78 处 / `.className =` 15 处是**原始出现次数**，同一个类名在多处 toggle 很常见，不能拿 93 当「动态类个数」。
- **出处**：`scripts/test-theme-contract.mjs` 的 `scanDynamicClasses` / `CLASS_SOURCES`；`src/admin-ui.js` / `src/index.js` / `src/dashboard.js` 的 `class=` 字面量；`public/app.js` 的 `read-bar` / `back-top`；第八份材料「TC-42 动态类 SSR 可见率」；站务记录 2026-11-24

## P-070 例外表只登记「借谁」，不登记「还有谁在用」—— 借的变量影响面 153 处，没人知道

- **现象**：`TOK_EXCEPTION` 写的是 `{ c: '--muted' }`。TC-41 的四方闭环守住了「来源合规」：借用被登记、登记不许乱填、键值不许开空头。但它没回答「这个来源还被谁用着」。实测 `public/style.css` 里 `var(--muted)` 出现 **153 次、158 个选择器**（`color` 143 / `border-color` 5 / `background` 4 / `scrollbar-color` 1）—— 注释色只是这 153 个用户里的一个。有人嫌「辅助文字太淡」去调 `--muted`，注释色跟着变，四道闸全绿。
- **根因**：「值从哪来」和「值被谁依赖」是两个方向。TC-41 只朝上游看（来源是否登记、是否合规），下游（影响面）没有断言。材料提的 `alsoUsedBy: ['.note', '.post-time', '.lead-tag']` 双向对账方向是对的，但清单法在这个变量上不成立：`.post-time` 全站 **0 处**（又是按惯例猜的名字），真实共用方是 158 个选择器 —— 登记 158 行等于每写一行业务 CSS 都要动这份契约文件，而清单长到没人读的时候，「签字」就退化成噪声，和它想防的白名单是同一个终点。
- **复现**：`printf '\n.tc44-probe { color: var(--muted); }\n' >> public/style.css` → TC-44 报「登记 153 处，实际 154 处（+1）」并列出 `color 144 / border-color 5 / background 4 / scrollbar-color 1`。把 `sites` 改成 `200` → 报「-47」；改成 `1` → 报「sites 必须是 ≥2 的整数」（只被借它的那条规则用着，那不叫影响面，叫专属槽位）。
- **断言**：`TC-44` 登记**数字**而不是名单 —— `TOK_EXCEPTION[c] = { var, sites }`，`sites` 必须等于 `style.css` 里 `var(--var)` 的出现次数。数字是算出来的、不是填出来的名字，所以「往清单里塞名字就放行」那条反向洞不存在；报错带按属性的分布，因为「拿 muted 当底色」和「当文字色」是两种性质不同的扩面，前者该改回专属变量。属性名的正则必须要求前面是 `{` 或 `;` —— 第一版漏了这个，`.btn:hover { border-color: var(--muted) }` 里的 `btn` 被当成属性名（`:hover` 提供了冒号），分布里冒出 `btn` / `span` / `md-input`。
- **边界**：只统计 `public/style.css`，**不统计主题文件** —— 主题里用 `--muted` 是本职（那是它该覆盖的槽位），统计进去等于拦正常用法。按字面 `var(--muted)` 计，`color-mix(in srgb, var(--muted) 62%, transparent)` 也算消费点（它确实吃这个值）。不含 `app.js` 运行时写进内联样式的变量。数字会随业务 CSS 增长而频繁变动 —— 这是刻意的摩擦，改一行数字的成本低于「调完 muted 才发现注释色也变了」。
- **出处**：`scripts/test-theme-contract.mjs` TC-44；`src/theme-contract.js` 的 `TOK_EXCEPTION.sites`；`public/style.css` 153 处 `var(--muted)`；第九份材料「四方闭环缺第五方 / alsoUsedBy」；站务记录 2026-11-24

## P-071 判重断言的上游被改坏时，断言自己不会红 —— 它只会继续绿

- **现象**：TC-43 遍历 `CLASS_SOURCES_RAW` 判重复，前提是这份清单**未去重**。只要有人觉得「两个变量名多余」把定义合成 `const CLASS_SOURCES_RAW = [...new Set([...])]`，TC-43 就回到恒真 —— 而且**继续 pass**，因为它遍历的正是那份已经去重的清单。改动只有一行，注释写着「留着，让 TC-43 看得见」，但改的人不会读注释。
- **根因**：断言能守「数据里有没有重复」，守不住「判据自己的输入被改」。这和 P-068 是同一个病的上一层：P-068 是判据的输入被提前转换（在写断言时），P-071 是判据的输入被后来的人转换（在维护时）。文档也挡不住：`THEME-CONTRACT.md` 讲的是「主题怎么写」，源清单是测试脚本的实现细节，写进去没人会在改这一行时去翻。这类只能靠**元断言**——本项目已有先例（`test-timing.mjs` 读自身源码检查 `fn.constructor.name === 'AsyncFunction'`）。
- **复现**：两处替换（`CLASS_SOURCES_RAW = [...new Set([` + 尾部 `])]`、`CLASS_SOURCES = CLASS_SOURCES_RAW`）→ **TC-43 pass、TC-45 FAIL**，报「RAW 里出现了 new Set」与「CLASS_SOURCES 没有去重」；只把 `CLASS_SOURCES` 改成直接引用 `CLASS_SOURCES_RAW` → TC-45 单独报第二条，TC-43 仍绿（它判的是重复，不判去重那步在不在）。
- **断言**：`TC-45` 读自身源码，切出两段定义：`CLASS_SOURCES_RAW` 的片段里不许出现 `new Set`，`CLASS_SOURCES` 的片段里必须有 `new Set(`。两段各配长度锚点（>40 / >20 字符），因为 `indexOf` 返回 `-1` 时切出空串，两个否定判断对空串同样成立 —— 这是 P-059 那个形态的第四次出现。
- **边界**：只认这两处定义的**文本形态**。把清单改成 helper 函数生成（`const CLASS_SOURCES_RAW = collect()`）会让元断言先报「找不到定义」并判红，不会静默变绿 —— 但那时要手工把元断言指到新落点，否则它只能一直红着。不判语义，也无法判「这份清单该包含哪些文件」（那是 TC-43 的长度锚点在做的事）。**这条「找不到就红」的性质后来被证伪了一半**：定位用的是 `indexOf(字面量)`，而字面量在别处也出现过，见 P-073。
- **出处**：`scripts/test-theme-contract.mjs` TC-43 / TC-45；站务记录 2026-11-24

## P-072 CSS 的三层结构用正则解析，同一个根因踩了两次

- **现象**：TC-44 要报「`--muted` 的消费点分布在哪些属性上」，第一版用 `([a-z-]+)\s*:\s*[^;}]*var\(` 扫全文，实测输出是 `color 141 / btn 1 / border-color 2 / title-input 1 / span 1 / md-input 1 / background 2 / tp-item 1 / ava-drop 1 / scrollbar-color 1 / code-block 2` —— `btn` / `span` / `md-input` / `tp-item` 全是被认成属性名的**伪类或选择器片段**，因为 `.btn:hover { border-color: var(--muted) }` 里 `:hover` 提供了一个冒号。反方向的同类错误：想「取最近的上一个选择器」来归属声明，会漏掉嵌套规则与逗号分隔的选择器组。
- **根因**：CSS 是 **at-rule / 选择器 / 声明** 三层嵌套结构，正则只做扁平匹配，看不见层级。把属性名的前置字符收紧到 `{`/`;` 能过这一例，但那是在给正则打补丁 —— 下一个 `.x[title="a:b"]` 或 `@supports` 里再嵌一层，又要打一次。TC-42 早就写好了逐字符配对大括号 + at-rule 栈的扫描器，正确做法是复用它，而不是另写一条更聪明的正则。
- **复现**：退回正则版（把 TC-44 的 `scanCssRules` + `cssDecls` 换回 `matchAll(/([a-z-]+)\s*:\s*[^;}]*var\(/g)`），在 `style.css` 末尾加 `.tc44-probe { color: var(--muted); }` → 分布里立刻混进伪类碎片，总数对但分类不可读。走扫描器版本时同一注入输出 `color 144 / border-color 5 / background 4 / scrollbar-color 1`。
- **断言**：`TC-42` 与 `TC-44` 共用两个模块级函数 —— `scanCssRules(text)` 返回 `[{ at, selector, body }]`（逐字符配对大括号，at 栈只负责记录上下文，不解析媒体条件），`cssDecls(body)` 按 `;` 切声明、首个 `:` 之前为属性名。TC-42 的打印豁免改成判 `rule.at` 里有没有 `print`，不再自己扫 `@media`；TC-44 的分布遍历 `cssDecls`，`actual` 的口径随之明确为「含该变量的**声明条数**」（同一声明写两次算一点，今天 0 处）。锚点：`rules.length > 800`（实测 1119 条），解析器退化到几十条时立刻红。注入验证三条：给 `.md pre.code-block` 加 `background: var(--bg-soft)` → TC-42 报「双层结构回退了」；加一处 muted → TC-44 报 154 且分布 `color 144`；`SITES_CAP` 调成 100 → 报「已超过扩面上限 100」。
- **边界**：`cssDecls` 按 `;` 切，**引号内的分号会切错** —— 已补：加了引号状态机（`"` / `'` / `\` 转义），`content: "a;b: c"` 不再切出 `b` 这种伪属性名。CSS nesting（规则里嵌规则）在 `cssDecls` 里整段跳过，今天没用它；真用了要改成递归 —— 但**不会静默**：TC-46 数源文本的 `{`，嵌套一出现差 1 就红（见 P-074）。`at` 栈只记字符串，不求值媒体条件（`@media (min-width: 900px)` 里的规则在窄屏不生效，这条断言不管那层）。
- **出处**：`scripts/test-theme-contract.mjs` 的 `scanCssRules` / `cssDecls` / TC-42 / TC-44；第九份材料「解析 CSS 一律走括号配对扫描器」；站务记录 2026-11-24

---

## P-073 读自身源码的断言，`indexOf(字面量)` 会搜到自己 —— 报绿时报的是注释，报红时报的原因是假的

- **现象**：TC-45 用 `self.indexOf('const CLASS_SOURCES = ')` 定位定义。两个方向的实测：
  - 把真定义改成 `let CLASS_SOURCES = [...new Set(CLASS_SOURCES_RAW)];`（语义完全不变）→ `indexOf` 命中的是 **TC-43 注释里那句散文**「我是 `const CLASS_SOURCES = [...new Set([...])]`」，从那里切出 345 字符的正文，恰好跨过一个 `new Set(`，`!has` 判据成立 → **45 通过，0 失败**，而元断言该管的定义已经不在它读的那段里。
  - 把 RAW 定义写成 `const CLASS_SOURCES_RAW =\n  [` 时，`indexOf` 命中的是 **TC-45 自己那行** `self.indexOf('const CLASS_SOURCES_RAW = [')` 里的字符串字面量，切出 429 字符（含下一行判据自己的 `new Set`），报出「`CLASS_SOURCES_RAW` 里出现了 `new Set`」—— 红了，但理由与事实无关。
- **根因**：`indexOf(needle)` 的搜索域包含 needle 自身的书写处。读自身源码的断言里，要找的文本同时出现在两处非定义位置：①解释性注释（PITFALLS 和代码注释里为了讲清问题，会把错误写法原样抄一遍）、②断言自己的字符串字面量。更关键的是**长度锚点证明不了这件事** —— 它只证明「切到了东西」，不证明「切到了对的东西」；上面两次分别切到 345 / 429 字符，两个长度检查都轻松通过。
- **复现**：上面两条注入各一行 `node -e`，不需要别的准备。判定「搜索域污染」的最快手法是先打一行 `self.slice(0, at).split('\n').length` 看命中的是第几行，再对照那一行的上下文。
- **断言**：TC-45 的定位改成行首锚定 + 唯一性计数：
  ```js
  const at = (re, label) => { const all = [...self.matchAll(re)];
    assert.equal(all.length, 1, `「const ${label}」在行首出现 ${all.length} 次（应为 1）…`);
    return all[0].index; };
  at(/^const CLASS_SOURCES_RAW\s*=\s*\[/gm, 'CLASS_SOURCES_RAW')
  at(/^const CLASS_SOURCES\s*=/gm, 'CLASS_SOURCES')
  ```
  行首锚定排掉缩进里的散文与引号里的字面量（这两类都顶不到列 0），`matchAll` 计数排掉**顶格写的块注释伪定义**（第三种注入：把同样的定义抄进一段 `/* … */` 且顶格，实测报「在行首出现 2 次」）。三条注入 + 原始威胁（RAW 提前去重）全部按预期红，基线 45 通过。
- **边界**：`\s*=\s*` 允许空格与换行差异，所以 `const CLASS_SOURCES=[...]`、`=\n  [...]` 这类纯排版变化**不红** —— 有意为之：该红的是语义变化，不是格式。反过来说，它仍然只认模块级顶格 `const`：定义搬进 `scripts/lib/*.mjs`、或改成 helper 生成，会先红（报「出现 0 次」）等人手工重指，不会静默变绿 —— 这一点和 P-071 的边界一致。不判「切出来的这段到底是不是那段语义」，那需要 JS 词法分析，超出这个文件的成本。
- **出处**：`scripts/test-theme-contract.mjs` TC-45 的 `at()`；TC-43 注释里那句被误中的伪定义；第十份材料「找不到就红而不是找不到就绿」；站务记录 2026-11-24

---

## P-074 两个消费者各有锚点，共用层一个都没有 —— 丢 31 条规则时两条都绿

- **现象**：TC-42 / TC-44 共用 `scanCssRules`，各自都有锚点，但都是**规模或数值**锚点：TC-42 判 `rules.length > 800`，TC-44 判 `actual !== sites`。实测在 `rules.push` 前加一行 `if (body.length < 16) continue;`（丢掉 31 条）→ 剩 **1088 条**，TC-42 pass（1088 > 800）、TC-44 pass（`--muted` 恰好一条没落在这 31 条里，153 仍是 153）。**两条消费者都没有理由报红，而扫描器已经少算了 2.8% 的样式表。**
  同族第二例：往 `style.css` 追加 `.nest-probe { color: red; & .child { color: blue } }`，源文本多两个 `{`，扫描器只产出一条规则（内层被 `cssDecls` 的「含 `{` 就整段丢」吃掉，内层声明全失），TC-42 / TC-44 依旧绿。
- **根因**：共用基础设施的退化，只能被「恰好踩到它」的那个消费者发现。消费者锚点回答的是「我关心的那部分还在不在」，不是「解析器还对不对」。规模锚点（>800）天生对「少几十条」不敏感，而少几十条正是配对漏层、换行漏切、注释残留的典型振幅。上面两次都是 P-071 同族：**判据守不住自己输入的那一层**，只是这次的输入是两个消费者共享的。
- **复现**：两条各一行注入，都不需要改 `style.css` 之外的东西。判断「谁看见了」只要看 TC-42 / TC-44 / TC-46 三行 —— 前两条绿、后一条红，就是共用层单点退化的特征。
- **断言**：`TC-46` 用**与扫描器完全无关的第三条计数**：数源文本的 `{` 总数，减去 at-rule 自己的 `{`（`@[^{;]*\{`），应当正好等于 `rules.length`（实测 1178 - 59 = 1119）。另加形态判据：每条规则的 `selector` 非空、不含 `{`、不含 `;`（带 `{` = 配对漏层，带 `;` = 上一条的尾巴并进了下一段头）。锚点 `openAll > 500 && atOpen > 10` 证明计数本身没失效，否则两个 0 相减也能恒等。两条注入下只有 TC-46 红，报「扫描器产出 1088 条，源文本独立计数 1178 - 59 = 1119 条」。
- **边界**：`atOpen` 的正则假定 at-rule 头里没有分号（`@import url(x);` 不产 `{`，被正确跳过）；`@font-face` / `@keyframes` 的内层 `0% {` 会被当普通规则计，但两边同时计，差值为 0；写成 `@supports (--x: {)` 这种畸形头会误计。嵌套 at-rule 已实测对齐：往 `@media print` 里再放一层 `@supports` 加一条规则，源文本 `{` +3、at-rule `{` +2、扫描器规则 +1，差仍为 0；单行与多行两种写法都一样。只判「条数对不对」，不判「规则内容对不对」——后者要词法分析，超出这个脚本的成本。顺带：`cssDecls` 补了引号状态机，`content: "a;b: c"` 不再切出 `b` 这个伪属性名（旧切法实测产出 `[["content","\"a"],["b","c\""],["color","var(--muted)"]]`）。
- **出处**：`scripts/test-theme-contract.mjs` 的 TC-46 / `scanCssRules` / `cssDecls`；第十一份材料「共用扫描器的锚点」；站务记录 2026-11-24

---

## P-075 停手条件：判据只要还「先红」就可以停在 review，一旦静默绿就必须再往下加一层

- **现象**：断言链五层，每层都曾静默退化过一次：TC-43 的输入被提前去重后继续绿（P-068 / P-071）；TC-45 的 `indexOf` 搜到注释里的孪生文本后继续绿（P-073）；TC-42 / TC-44 共用的扫描器丢掉 31 条规则后**两条都继续绿**（P-074）。共同症状不是「测试红了查不出原因」，而是「测试全绿、事实已经错了」。每加一层，都是因为下一层用独立计数把上一次静默绿变成了可见的红。
- **根因**：判据守得住的是**它自己输入的那一种形态**，守不住语义等价改写与共用基础设施的局部退化。继续往下自动化是有底的：词法分析能排除注释和字符串字面量，排除不了 `const` → `let`、helper 生成、模块搬家——而这些本来就是合理重构，不该被判红。所以正确行为是「先红、等人手工重指」，而不是「自动适配」。当最外一层已经满足这个行为时，再加一层守它的断言，只会把问题推到更外一层，成本递增、收益递减。
- **复现**：对最外一层做一次「把它守的输入改坏」的注入，看它红不红。现成的两次实证：
  | 层 | 注入 | 结果 | 结论 |
  |---|---|---|---|
  | TC-45 | `const CLASS_SOURCES` 改成 `let`（语义不变） | 旧版 45 通过 0 失败；改成行首锚定 + 唯一计数后报「出现 0 次」 | 旧版静默绿 → 必须加层；新版先红 → 可停 |
  | TC-46 | 扫描器丢掉 body < 16 的 31 条 | TC-42 pass / TC-44 pass / **TC-46 FAIL**（1088 vs 1119） | 两个消费者静默绿 → 必须加层；TC-46 先红 → 可停 |
  命令都是 `node scripts/test-theme-contract.mjs`，注入前先备份、跑完还原。
- **断言**：**不为这条准则再写断言**。它是关于「什么时候停止自动化」的元判据，写成断言就得再写一条守它的断言，直到无限递归。可执行的判定只有人工注入：改坏最外一层的输入 → 它先红即合格，可停在 review；它继续绿即不合格，必须再往下加一层。这条判断本身不漂，所以写在这里；**具体数字与行号会漂，所以不在本条内复述**。
- **边界**：只对**已经做过注入验证**的层成立——没注入过的断言不能声称「它会先红」，那正是 P-073 那次被打脸的地方（我上轮把「找不到就红」当性质夸，实际只是巧合）。停在 review 不等于免检：改了判据输入形态的 PR 仍要人工把落点指回来。反向也成立：如果某层开始静默绿，就不能拿「review 兜底」当理由停手，必须先恢复「先红」再停。
- **出处**：`scripts/test-theme-contract.mjs` TC-43 / TC-45 / TC-46 的注入记录；P-068 / P-071 / P-073 / P-074；第十一份材料「停手条件」；站务记录 2026-11-24

---

---

## P-076 外部真值配置：scope、密钥形状、插入锚点，三处都会让「真值写不进去」

- **现象**：2026-11-25 配 Turnstile 时连续三次卡住，每次表象都不同：① 已有 OAuth token 读 widget 返回 HTTP 403 `Authentication error`，但同一 token 读 worker scripts 是 200 —— 不是权限等级问题，是缺 `challenge-widgets.write` scope；② 设备码授权页点了但 token 一直不回写，日志里 token 端点持续 400，抓 body 是 `authorization_pending`，即浏览器侧交互根本没走到最后一步；③ 拿到真 sitekey `0x4AAAAAAGSeGX0Z2Mj-pELs` 后 setup 脚本报「形状不对」—— CF 真密钥含连字符，旧正则只收 base62。写进去后又踩第四处：umami 的 `--dry` 用例红，因为 vars 插入写死 `R2_PUBLIC_BASE` 当锚，Turnstile 键插到它后面后，再插 UMAMI 两键就丢了 comma，整份配置 JSON 非法。
- **根因**：三类「假设」都没经过实测。scope 假设「wrangler 已登录 = 什么都能做」；授权假设「页面打开了 = 授权完成了」，而 OAuth 设备流只有 token 端点返回 200 才算数；形状假设「密钥都是 base62」，而真值带 `-`；锚点假设「R2_PUBLIC_BASE 永远是 vars 最后一项」，而每加一组配置就多一个后来者。第六处同构（2026-11-25 冒烟）：「写入成功」假设等于「写对了值」——`putSecret` 退出码 0 只证明 wrangler 收了参数，不证明 Worker 侧拿到的和 sink 认的是同一个。修法是在 `putSecret` 后复用同一个 `webhookPayload` 再发一次（冒烟），`--dry` 显式打印跳过； 注入验证三处（平台码闸失效 / 调用点注释掉 / dry 跳过静默）都先红后恢复。**判据不挂在「wrangler 返回 0」这个自己转换的产物上**——和 TC-46 的独立计数同构。边界照写：CF secrets 不可读回，冒烟用的还是本地 `url` 变量，验不到 Worker 实际存的值。第七处同构（同日 Worker 侧真发断言）：「写进去的值」和「Worker 读到的值」之间没有断言串着，写错键名或值被包装都能过冒烟；修法是假 wrangler 捕获真正写入的 name/value，再喂给真 `notifyComment`。四处注入（读错键 / 写错名 / 值被包装 / payload 形状被改）都先红后恢复。**判据落在捕获值上，不落在本地 `url` 变量上**。仍不冒充已验：CF 线上实际存储读不回；**评论落库 → 触发 `notifyComment` 仍是读码结论**——读码确认调用点在提交分支，但没有真提交触发过；Turnstile managed 在自动化浏览器拿不到 token，得有人真点一次验证码、真提交一条评论才算验（P-075 的停手条件：自动化先红就停在 review，不冒充端到端）。第八处同构（同日空值闸门）：「wrangler 报 Success + exit 0」假设等于「值写进去了」——workers-sdk#16193 非 TTY 下空 stdin 也上传空值，而 `preflight` 只看名字、空串也算「已配」，三道闸门全绿而通知静默丢失。修法是把闸门放在 `putSecret` 调用 wrangler **之前**；回打打的是本地 `url`，抓不到空值，写完 secrets 又读不回，没有第二次机会。注入验证：去掉闸门 + 传空值 → 假 wrangler 静默通过、体检报「WEBHOOK_URL 已配」；装回 → die 且不进体检。**判据不挂在 wrangler 的退出码上**。不在生产上用 `printf '' | wrangler secret put` 复现（会清空现役 secret 并触发部署），用假 wrangler 复现同一形状。失败不回滚 secret——回滚会把「地址错」和「sink 抖动」混成一件。第九处同构（同日人工观察脚本）：managed 拿不到 token 是停手条件，不能写自动提交冒充端到端；改为 `scripts/verify-comment-e2e.mjs` 生成唯一 nonce 让真人填进评论，再从两个独立源（D1 公开评论 / sink inbox）各自查同一 nonce。**通知侧判据是 `nonce && '💬 新评论'` 双条件**——只查 nonce 会把冒烟的 🔔 消息读成通知成功（注入去掉形状判据，那条先红）；落库侧要递归 replies（注入去掉递归，那条先红）。判据自检 6/6 已进 `npm test`（纯函数喂固定输入，改坏判据会红）；**人工那一跳不进**——两件事别混，塞进 test 的若是自动提交才是假绿。脚本仍不改变「未验」结论——要有人真点一次验证码并跑脚本命中才算。
- **复现**：`node scripts/test-setup.mjs`。注入验证七次：冒烟三条（把 `code !== 0` 改成 `false`；注释掉 `await smokeWebhook(url)`；删掉 dry 跳过打印）；Worker 真发四条（`env.WEBHOOK_URL` 改成 `env.WEBHOOK`；`putSecret('WEBHOOK_URL')` 改成 `WEBHOOK`；写入值包一层 `JSON.stringify`；`💬 新评论` 去掉 emoji）。每条都先红、跑完还原。此前还有两次（形状正则、 vars 锚点），同一套办法。
- **断言**：11/11。新增第四条「Worker 侧真发」：判据是假 wrangler 捕获的 name/value 与本地 url 一致、`notifyComment` 真代码让 mock 命中数 +1、sink 收到完整 💬 payload。原有三条冒烟判据是 exit 1 + 文案 + 两次 mock 命中 / `--dry` 显式跳过并写明原因 / 调用点行首锚定唯一计数；「带连字符的密钥形状」判据是「没停在形状校验、走到 siteverify 并报 SECRET 无效」；`--dry` 原用例守「不落盘」+ JSON 合法性。
- **边界**：OAuth token 现在含 `challenge-widgets.write`，但设备码/回调流程仍可能因为代理或浏览器交互半成品静默失败——判据只有 `whoami` 里出现该 scope 或 token 端点 200，不看「页面显示已授权」。密钥形状放行 `-`/`_` 后，占位符拦截仍在更前面，不受影响。第五处同构：把「本地 Worker 的 URL」写成常量——`npm run check` 没起服务就调 `check:dom`，必然 `fetch failed`。处置是在聚合命令里换成显式跳过说明（`scripts/check-dom-note.mjs`），独立命令与 CI 的 BASE 覆盖保留；部署前置本来就不含它，不会被挡。真·未验留痕，不是消除检查。
- **出处**：`scripts/setup.mjs` / `scripts/test-setup.mjs`；README 6.1；DEPLOY 换主域表；站务记录 2026-11-25

---

## P-077 界面层把故障渲染成最健康的状态（负 age →「刚刚」、sv-time 双重包裹）

- **现象**：两条都发生在渲染层，都不报错、不红、状态码 200，只表现为「有点怪」。① 库里 `notified_at` 是未来时刻（写入端拿本地时间当 UTC 存、或时钟漂移）时，`age` 为负，落进 `mins < 1` 分支，新鲜度显示成 **「刚刚」** —— 一个口径错的数据被渲染成最健康的状态，比报错更难查。② `notifyCell` 里 `fresh()` 的返回值已经自带 `<span class="sv-time">`，调用方又包了一层，字号与颜色叠两遍；HTML 合法、页面照常 200。
- **根因**：`fresh()` 只按「age 越小越新」单向假设写了分支，没给负值定义语义；`fresh()` 自带外壳这条契约只存在于注释里，调用方多包一层在本层无副作用。两者都属于「无异常路径」：不抛、不记日志、不进任何统计 —— **和 HTTP 200 里塞 `errcode 93000` 是同一种形态，只是搬到了界面层**。补一句来路：`Math.max(0, …)` 与负 age 分支这两处，原型里有、第一版落地时抄漏了 —— 抄一遍不等于接上了，得有断言在旁边盯着。
- **复现**：`UPDATE comments SET notified_at = datetime('now','+10 minutes')` → 评论页该行显示「刚刚」（本地 2026-11-26 实测，修复前）；把 `notifyCell` 的 `${fresh(...)}` 外面再套一层 `<span class="sv-time">` → 页面仍 200，只有肉眼看出字号变大。
- **断言**：`npm test` → `test-admin-atoms.mjs`：A-07（未来时刻必须落 `sv-pill warn` + 「时间异常」，且不得出现「刚刚」）、A-18（`fresh()` 返回值以 `<span class="sv-time"` 开头，且页面对 `<span class="sv-time">${fresh(` 的行首锚定计数为 0）。注入：删掉 `if (age < -60e3)` 分支 → A-07 红；把 `when` 改成包一层 → A-18 红；两次都先红后恢复。
- **边界**：负 age 阈值 60s，容忍正常时钟漂移；1 分钟内的偏差仍显示「刚刚」，那是噪声，不是这条要防的东西。A-18 只拦 `sv-time` 这一种外壳，挡不住「包一个别的 span 再写样式」——那属于样式回归，归 `test-contrast` / 视觉检查，不在这里加正则。
- **出处**：`src/admin-ui.js` 的 `fresh()`、`src/admin-pages.js` 的 `notifyCell()`；本地真发验证 2026-11-26（评论 id 55 正常显示「1 分钟前」，构造的未来行报「时间异常」）

---

## P-078 待办条的死法不是算错，是永远显示同一个数字

- **现象**：`todoBar` 少一个 `Math.max(0, …)`，查询异常回 `-1` 时，5 条待办被一个错误数字拉成「今天没有待办」—— 界面看起来比平时还干净；`notifyFail` 用全表 `COUNT` 统计，三周前、已无法补救的失败永久占着「今天要做的 N 件」。两种都不断言、不报错，只是数字不变；几天后打开后台，人就不看这一行了。
- **根因**：待办条的全部价值在「数字会变」，两处实现都在消灭变化。一处是**数值域没定义**：`COUNT` 出错时可能回负值，没人约定它该怎么显示，于是它直接参与求和；另一处是**时间域没定义**：评论通知没有重发机制，历史失败永远不可行动，把它算进「今天」等于给待办条挂一条永远做不完的项。修法是承认边界：负值钳到 0、失败只数近 7 天 ——「超过这个窗口的事，界面不再替你记」，但不删数据，评论页四态里仍可见。
- **复现**：`todoBar([{label:'A',v:5},{label:'B',v:-99}])` → 修复前输出「今天没有待办」；本地插一条 `notified_at = datetime('now','-30 days')` 的 `fail` 行 → 待办条「通知失败」永久 +1。2026-11-26 实测：全表 3 条 fail、其中 1 条 30 天前，待办条显示 **2**。
- **断言**：`npm test` → `test-admin-atoms.mjs`：A-14（`[{v:5},{v:-99}]` 必须求和为 5）、A-19（窗口必须落在 `admin-ui.js` 的 `navCounts()` 里、`dashboard.js` 必须走 `navCounts(db)` 不许另起一条查询、7 天窗口全仓只能有一处定义），配合 A-12 / A-13（零也列出来 / 全零说「今天没有待办」）。注入：去掉 `Math.max` → A-14 红；去掉 7 天窗口 → A-19 红。
- **边界**：7 天是产品口径，不是技术常量 —— 改窗口只改一处查询，但改了就要重跑一次概览页看数字是否还在合理区间。钳位只处理负值，不处理「大得离谱」的值；后者需要对账（`check:live` 那套三方相等），不塞进渲染层。窗口外的失败依旧计入评论页汇总的「失败 N」，两处口径不同是刻意的：一个回答「今天要不要动手」，一个回答「历史上失败过几次」。
- **出处**：`src/admin-ui.js` 的 `todoBar()`、`src/dashboard.js` 的 `notifyFail` 查询；本地真发 + 边界样本验证 2026-11-26

## P-079 改完样式没生效，页面不会报错

- **现象**：给侧栏徽章写了 `.admin-nav .sv-pill{font-size:11px;padding:1px 7px}`，文件里有这条规则、CSS 预算通过、断言全绿，浏览器里 padding 和字号一点没变（徽章宽 27px，应该是 21px）；`a.on .sv-pill{background:0 0}` 写了却不清底色，高亮项上的徽章仍是一块琥珀。同一轮还抓到另一处：评论页传 `active: 'comments'`，而导航配置里的 key 是 `'cmts'` —— 那一项在评论页永远不高亮，可评论页本来就在评论管理里，没人会觉得缺了什么。
- **根因**：两处都是「源码里写了 ≠ 渲染后生效」。CSS 那处是两件小事叠加：`.stat-page .sv-pill` 的同名属性（padding / 字号）比裸 `.admin-nav .sv-pill` 特异性高，直接压掉；`background: 0 0` 的简写只设了 position，**不重置 background-color**。`active` 那处是两份字符串各自演化 —— 导航配置一份 key、页面传另一份字面量，中间没有交叉校验，改错了连 TypeScript 都不会吭声。
- **复现**：改完 CSS 量 `document.querySelector('#nav-cmts .sv-pill').getBoundingClientRect().width` —— 修复前 27、修复后 21；`active:'comments'` 时抓 `/admin/comments` 的 `#nav-cmts`，class 里没有 `on`。两种都不抛错、不影响状态码、CI 全绿。
- **断言**：`test-admin-nav.mjs` N-09（扫 `src/*.js` 里所有 `active:` 值，必须在 `ADMIN_NAV` 的 key 集合里；`history` 进白名单因为它没有菜单项）、N-04（tone 白名单：把配置值直接拼 class 就是注入面）、N-05（0 / 负 / null 不渲染徽章）、N-07（带 `window` 的计数名字必须带窗口后缀）、N-08（侧栏容器只由 `renderAdminNav` 产出，除 admin-ui.js 外命中 0 次 + admin-ui.js 恰好 1 次，两个独立计数防空集恒真）。**CSS 生效与否故意不进断言** —— 写一条「文件里有没有这行」的判据，测的是源码不是渲染，那是假绿；这一条只能靠渲染后量一次 computed style。
- **边界**：能变成结构不变量的（active key、tone 白名单、窗口后缀、容器唯一来源）必须写成断言；只能在浏览器里算的（特异性、简写语义、布局）不进断言，改成一次性实测并记录数值（pillW 27→21）。别为了「都有断言」去写读自身源码的伪判据 —— 那比没有断言更坏，因为它会绿。
- **出处**：`public/style.css` 的侧栏徽章两条规则、`src/admin-pages.js` 的 `active: 'cmts'`；2026-11-26 落地侧栏徽章时实测

---

## P-080 静态副本不跟配置漂移，而断言只扫了 src/

- **现象**：`public/editor.html:31` 有一份手写的 `<nav class="admin-nav">`，结构与 `ADMIN_NAV` 相同但不派生。给导航加一项、改一个 key、加一个 `badge`，编辑器面板的侧栏**一动不动**；后台其他页跟着变，只有它不变。上一轮靠临时脚本（`.tmp-nav-gen.mjs`，用完删）重建过一次，之后没再变过 —— 看起来「已经对齐」。
- **根因**：N-08 的判据是「`src/` 内手写 `<nav class="admin-nav"` 为 0 处、`admin-ui.js` 恰好 1 处」，`public/` 不在搜索域里。于是「src 内 0 处」被读成「全局收成一处」—— 两个命题不等价，中间那一份正好在搜索域外。这不等于侧栏散了（同一轮按 `sv-nav` 这类假符号 grep 得到零命中，也不能读成「散了」），它是「唯一事实源在 src，另有一份只读快照在 public，且没有同步机制」。
- **复现**：在 `ADMIN_NAV` 里给 `cmts` 加 `badge: 'pendingComments'`，然后对比 `/admin/comments` 与 `/editor?panel=posts` 的侧栏：前者出现琥珀数字，后者永远没有（静态 HTML 拿不到 counts）。再删一项：前者少一行，后者仍在。
- **断言**：**无，已知未自动化。** 因为 `test-admin-nav.mjs` N-08 明确只覆盖 `src/`；断言「public 里这一份与 ADMIN_NAV 一致」等于在源码层比对两份字符串，抓不到「运行时该有徽章却没有」。这一条进 WARN 清单是预期的（对账脚本把「文档有条目、脚本未引用」标 WARN，不卡 CI）。
- **边界**：要真自动化只有两条路，都动架构而非补判据 —— ① 构建期从 `ADMIN_NAV` 生成 editor.html 的 nav 段（本仓库无构建步骤，加一个就是引入构建）；② 运行时只读 API + 前端 fetch 渲染（新增攻击面与一次 RTT，且要让 editor 页在未登录/无 JS 时降级）。在不做这两件事之前，正确说法是「editor 侧栏是快照，不是派生」；别把「上次人工跑脚本重建过」当成「已经对齐」。
- **出处**：`public/editor.html:31`、`scripts/test-admin-nav.mjs` 的 N-08；2026-11-26 上线后复查侧栏覆盖范围时确认

## P-081 窗口定义在查询里，名字却还停在「全量」

- **现象**：待办条第三格写「通知失败」，点进去是「近 7 天」的数字 —— 它取自 `nav.notifyFail7d`，本来就有窗口。名字没跟上，读者只能当成历史累计，于是每天看见同一个数字也不觉得该动手。同一形状还有反过来的：某个数字是全量，名字却带「24h」，人以为它只数今天。两种都不报错、不 500，只是**让人按错误的口径理解一个正确的数字**。
- **根因**：口径定义在查询层（`navCounts` 的 `-7 days`），展示名在另一个地方各自演化（`todos` 数组、`BADGE_SOURCE.label`）。一份数据两三个消费者，每个都自己起名，中间没有任何地方要求「名字必须体现口径」。这是 P-078 的细一半：P-078 是**时间域没定义**（全表统计），这条是**时间域定义了但不可见**。修 P-078 只保证数字对，不保证名字对，所以它能原地复发。
- **复现**：把 `src/dashboard.js` 的 `TODOS` 里 `notifyFail` 改回 `label: '通知失败'`、保留 `window: '7d'` → `npm test` 红在「名字「通知失败」里没有这个窗口（可写 7d / 7 天）」。反向：给它 `window: null` 但不写 `total` → 红在「是全量计数，必须用 total 写明它是什么全量」。
- **断言**：`npm test` → `test-admin-nav.mjs` N-11（N-07 的通用版）。规则双出口、`window` 键不许缺：非 null → 名字必须含该窗口（`7d` / `7 天` 由显式映射表给出，不是「含数字就算」）；null → 必须有 `total` 说明且名字不得含窗口字样。徽章的「名字」取 key、待办条取 label（混用会让 badge 那条恒真，它的 label 是中文自然语言）。**空转防护按来源分别查**：待办条全变全量而徽章仍带窗口时，合并计数照样 ≥1，待办条那半就成空转 —— 空集被另一半掩盖。四处注入各自只红目标分支：A 名字去窗口、B 删 `total`、C 删 `window` 键、D 两侧各自全变全量。
- **边界**：判据只验「名字与声明一致」，验不了读者真懂 —— 写「7 天内通知失败」而实际是 30 天窗口，只要声明也写 30d 就不会红，那靠 review。`total` 说明 ≥6 字只防「忘了写」，挡不住敷衍。`SPAM_MIN_SCORE` 式的「改阈值不改规则」原则在这里同样适用：口径变了先改声明，别把断言放宽。
- **出处**：`src/dashboard.js` 的 `TODOS`、`src/admin-ui.js` 的 `BADGE_SOURCE`；2026-11-26 把 N-07 扩成通用规则时，新断言第一次跑就抓到 `notifyFail` 这一处

---

## P-082 半条规则：同一条链路上两处判据不一致，读起来却像刻意设计

- **现象**：发评论时的首次投递不区分身份（管理员发的也推），cron 补推的查询却多带一个 `is_admin` 过滤。结果是管理员自己发的评论第一次投递失败后再没有重试，访客的能重试约 6 次。不报错、不改状态码、CI 全绿 —— 失败只表现为「群里少一条消息」，而少一条消息和「本来就没发」在界面上长得一样。
- **根因**：同一个判断（要不要推送）写在两条路径上，没有任何地方要求它们一致。更麻烦的是过滤条件落在 SQL 的 `WHERE` 里，读起来像**刻意排除**（「管理员不需要自己的通知」），实际只是漏了 —— 在形态上，「省略」与「设计」长得一模一样，所以它不会被当成缺陷读出来。同一族还有 P-077（没生效渲染成生效）、P-081（名字与口径不一致）：共同点是**没有任何东西会红**。
- **复现**：把 `is_admin` 条件加回 `src/cron.js` 的补推查询 → `npm test` 红在 SW-17「不得按 is_admin 过滤」与 SW-18「管理员那条没被补推」。删掉 `created_at >= datetime('now','-6 hours')` → 红 SW-16 + SW-19；删掉 `LIMIT 10` → 红 SW-16 + SW-20。
- **断言**：`test-comment-sweep.mjs` SW-16..SW-20，分两层。**结构层**（SW-16 / SW-17）断言真正下发的 SQL 文本：必须有 `created_at >=` 下界（且必须写成相对 `datetime('now','-Nh')`，固定日期会在某天悄悄变成「什么都补」）、必须有 `LIMIT n` 且 n ≤ 50、不得出现 `is_admin`。**行为层**（SW-18..SW-20）把同一句 SQL 丢进 `node:sqlite` 内存库真跑：管理员那条要进队列、7 小时前 / 冷却中 / 刚发出 2 分钟内的都不补、12 条候选只捞 10 条。只有结构层会漏掉「字符串对但语义错」，只有行为层会漏掉「语义对但换了个写法」，所以两层都留。
- **边界**：SW-17 只认 SQL 里没有 `is_admin`，认不出「在 JS 里又过滤了一次」—— 后者由 SW-18 兜（它看结果集，不看字符串）。反过来 SW-18 也只能覆盖当前这条查询的形状。真正防复发的是「同一件事只有一个判据来源」，本仓库还没做到（首次投递在 `api.js`、补推在 `cron.js`），所以只能靠这两层钉住。`node:sqlite` 的夹具必须手动跟上真实表结构：第一版少了 `parent_id`，垃圾那条子查询直接报 `no such column` —— 夹具缺列会伪装成代码 bug。
- **出处**：`src/cron.js` 的 `sweepComments` ① 补推、`src/api.js` 评论落库后的首次投递；2026-11-26 去掉补推里的 `is_admin` 过滤时确认

---

## P-083 进程根本没起来，报错却指向 SQL

- **现象**：脚本里 `execFileSync('npx', ['wrangler', 'd1', 'execute', …])` 在 Windows 上直接抛 `spawnSync npx ENOENT`；退一步改成 `shell: true` 再把整条命令拼成字符串，带空格的 SQL 又被 shell 拆成十几个参数（`--command` 只吃到第一个词），wrangler 回一段 `near "AND": syntax error`。两种失败都会被读成「SQL 写错了」。
- **根因**：Windows 上 `npx` 是 `npx.cmd`，`.cmd` 由 `cmd.exe` 解释，而 node 的 `spawn` 只认 PE 可执行文件 —— **进程根本没起来**，错误文案里却只有 `spawnSync`，没有一个字说「你的命令没跑」。`shell: true` 那条更远：故障在参数边界（一个 argv 被切成十几个），却由最下游的 SQL 解析器报出来，**报错指向错误的一端**。与 P-077 / P-082 同族：失败被翻译成一个能自圆其说的形状，于是修的人一直在错的地方改。
- **复现**：`node -e "require('node:child_process').execFileSync('npx',['-v'])"` → `ENOENT`；任何把带空格 SQL 拼进 `shell: true` 命令串的写法 → wrangler 报 SQL 语法错而不是参数个数错。旧探针（临时脚本）两次都栽在这里。
- **断言**：运行时报错没有断言能提前抓，这一条靠**单一入口**约束代替断言 —— **调用 wrangler 跑 D1 查询的唯一入口是 `scripts/lib/d1.mjs`，新增脚本不许内联 `spawn` / `execFileSync`**。那个模块用 `process.execPath` + `require.resolve('wrangler/package.json')` 推出的 `wrangler.js` 绝对路径，shell 全程不参与；`sqlStr()` 统一转义，不手拼引号。`comment-probe.mjs` 已走它 —— 而 `grep -l "lib/d1.mjs" scripts/*.mjs` 只命中一个文件，本身就是「这条约束还没普及」的证据。
- **边界**：这条只覆盖 D1 查询。存量 **16 个脚本**里仍能 grep 到 wrangler（多数是 `deploy` / `secret put` / `d1 export`，`lib/d1.mjs` 没有对应封装），属**已知的第二份事实源**。按各自下次动到来迁，别单开一轮：每个脚本都带自己的幂等 UPDATE 逻辑，一次迁四个等于一次改四件事。真到那一步，判据是「同一个脚本改完，它自己的行为断言仍然全绿」，不是「全仓零 `execFileSync`」。
- **出处**：`scripts/lib/d1.mjs` 头部注释（2026-11-26 抽公共入口时写下）；此前 `backfill-html` / `make-variants` / `gen-cards` / `setup` 各留过一段同义注释，四份互相独立

---

## P-084 断言测在编码之后，等于测了另一层

- **现象**：媒体页的 XSS 断言原本这样写 —— 用 key `x"><img src=x onerror=alert(1)>.png`，断言渲染结果里不出现 `"><img src=x`。把文件名那一处的 `esc()` 删掉，断言**仍然是绿的**。
- **根因**：`<img src>` 的值先过 `encodeURIComponent`（逐段编码），`"` 早就是 `%22`，引号永远闭合不了属性。断言测的是编码那层的效果，不是 `esc()` 那层的效果 —— 与「判据的输入是它自己要检验那步转换的产物」同族（P-075 的假绿形态③）。`esc()` 真正独当一面的是**文本节点**：文件名进 `<strong>` 时没有任何编码兜底。
  **选测点之前先问一句：把这一层防线删掉，这个测点会变吗？不变就说明测点选错了层。**（删 `esc` 而断言照绿，就是这一问的答案。）
- **复现**：去掉 `<strong class="adm-fr-name">${esc(...)}</strong>` 里的 `esc`，旧断言照绿；把同一个恶意 key 放进文本节点，去掉 `esc` 后 `<img src=x onerror=...>` 原样出现在页面里。
- **断言**：`scripts/test-media.mjs` M-04 改测文本节点 —— `! /<img src=x onerror/` 且 `includes('&lt;img src=x onerror=alert(1)&gt;')`。注入（删 `esc`）→ 红；恢复 → 绿。同一轮的 M-01（删变体过滤）也做过同样的先红后绿。
- **边界**：只覆盖文本节点的转义；属性值走的是编码，这条不为它背书。另外文件名用 `split('/').pop()` 取 basename —— key 里含 `/` 时（例如 `x<script>alert(1)</script>.png`）会切到 `script>.png` 那一段。正常上传的 key 结构固定，不算 bug，但**测试数据别用带 `/` 的恶意 key**，否则测的是切段逻辑，不是转义。
- **出处**：`scripts/test-media.mjs` M-04（2026-11-27 媒体页落地时）

---

## P-085 换主域只改 SITE_ORIGIN，等于只迁移了一半

- **现象**：全站 URL 口径已经统一到新域 —— canonical、`og:url`、sitemap 53 条 `<loc>`、robots 的 `Sitemap:`、RSS 的 channel link 与 guid 全是 `miu.sryze.cc`；但旧域 `exia.de5.net` 仍然 **200 并提供同一份全站内容**（首页 38441B 对 38441B，逐行比对只差一行 Analytics beacon token，说明两个域名是两个独立 CF zone，各自在跑统计）。站内一切"正确"，所以任何只查站内产物的检查都发现不了。
- **根因**：`SITE_ORIGIN` 只决定**输出**里写哪个域名，不决定**接受**哪个 host。旧域还绑着同一个 Worker，请求照样进来、照样渲染、照样进边缘缓存（缓存键是完整 URL，两个域名两套副本，`bust` 只清得掉一套）。四份账因此同时出错：同一页面被两个域名各抓一遍（抓取配额翻倍）、两个 zone 各算一份访问统计（来源无法合计）、指向旧域的外链只能靠 canonical 归并（比 301 弱一档）、从旧域进来点任意内链又跳到新域（半个跳转）。
- **复现**：`curl -sI https://旧域/ | head -1` → `200`。判据看状态码和 `Location`，**不看"能不能打开"** —— 能打开正是 bug 本身。换成旧域的 `/p/<slug>?utm=x` 也必须给 301 且 query 原样保留。
- **断言**：`scripts/test-host-redirect.mjs` U-01..U-10（跳/不跳、301 vs 308、query 保留、本地放行、`SITE_ORIGIN` 未配与配错都不动作）；线上 `check-live.mjs` 第 17 段查旧域 301/308 与每类页面正好一条 RSS 声明。注入三处各自只红自己那一对：删本地放行 → 只 U-06 红；301 改 302 → U-01/U-05/U-09 红；不回 query → U-02/U-03 红。
- **边界**：Worker 侧 301 每次旧域请求都要唤起一次 Worker（计费、有 CPU 开销）；换成 CF Redirect Rule 更便宜，但那是面板状态、进不了版本库 —— 与 HTTPS 强跳同一取舍。两边都上也不冲突：规则先命中，代码成为兜底。另外 `*.workers.dev` 预览域也会被跳走，`wrangler versions upload` 的预览验证需要带 `SITE_ORIGIN` 覆盖。
- **出处**：`src/utils.js` 的 `hostRedirect()`（规则本体）、`src/index.js` 的 `handleFetch()`（发响应，位置在 HTTPS 之后、缓存之前、路径规范化之前）

---

## P-086 判据的正则被更宽的同类词命中：`/serif/i` 匹配 `sans-serif`

- **现象**：给「基准 `--serif` 必须是衬线栈」写断言，用 `/Iowan|Palatino|Georgia|Songti|Noto Serif|serif/i` 判。把基准那一行改成 `"PingFang SC", "Microsoft YaHei", sans-serif` 做注入——**四条断言全绿**。断言声称守的是衬线，实际守的只是「这个字符串里出现过 serif 这六个字母」。
- **根因**：`sans-serif` 包含 `serif`。用通用字体族名当判据，等于把「反面的名字」也算成正面证据。同族的还有 `\b` 写在中文边界上不生效、`_` 没进字符类、`indexOf` 命中注释里的示例——都是「判据的匹配面比它自称的宽」。
- **复现**：把 `public/style.css` 基准 `:root` 的 `--serif` 换成 sans 栈，跑 `node scripts/test-typography.mjs`。修好前 4/4 绿，修好后 T-04 红并打出实际值。
- **断言**：`scripts/test-typography.mjs` T-04 改成两条并存——必须点名一个具体衬线族（`Iowan|Palatino|Georgia|Songti|"Noto Serif"`）**且** 不得出现 `sans-serif`。另一条更根本的纪律：**判据里不写能被反面值命中的词**，写具体族名，不写通用类名。
- **边界**：这条只管源码层（有人把正文改成 `font-family: var(--serif)` 会被 T-02 抓到）。主题层把 `--serif` 指向 sans（anzhiyu 就是这么做的）是**设计选择，不判红**——所以 T-04 只看基准 `:root`，不看 `:root[data-theme=...]`。真要判「渲染后标题是不是衬线」，得读计算样式，那层在截图里看，不在这个脚本里冒充。
- **出处**：`scripts/test-typography.mjs`（T-01 正文宽 680–740、T-02 正文零处衬线、T-03 落点白名单、T-04 基准衬线栈）

---

## P-087 默认主题换皮，会把「默认主题存在」这条判据的前提整个反转

- **现象**：把 `wrangler.jsonc` 的 `SITE_THEME` 从 `anzhiyu` 换成 `paper` 之后，主题契约测试两条红：TC-05 报「style.css 里出现了非默认主题 anzhiyu 的规则（46 处）」，TC-06 报「主表里找不到默认主题 paper 的规则」。TC-05 是对的——那 45 条规则确实该随默认主题一起下架；TC-06 是错的——paper 的规则就在主表最上面的裸 `:root` 里，只是它没有 `[data-theme="paper"]` 这个名字。
- **根因**：TC-06 写的是 `ruleCount(css, 'paper') > 0`，把「默认主题存在」等价成了「有一个带 `[data-theme]` 前缀的块」。默认主题原来恰好是块形态（anzhiyu），所以这条隐式前提从没被检验过；换成裸 `:root` 形态（paper）后，正确结构被判成坏。同类判据都吃这一刀：只要它把「某个东西存在」写成「某种实现形态的特征」，换形态时要么误报，要么改成 `||` 之后恒真。
- **复现**：`wrangler.jsonc` 里 `SITE_THEME: "anzhiyu"` 改 `"paper"`，`node scripts/test-theme-contract.mjs`。修前 TC-06 红，修后 TC-05 仍然红到 `INLINE_THEMES` 与主表规则一起清干净为止——两条红里只有一条是真问题，这正是坑：**报错文本会把人指向错误的方向**。
- **断言**：TC-06 的下限改成 `n > 0 || (INLINE_THEMES.includes(DEFAULT_THEME) && bareRoot)`，`bareRoot = /:root\s*\{[^}]*--bg:/`，把「存在」挂到「兜底底色存在」这个独立事实上；上限 `n <= 100` 不动。`INLINE_THEMES` 从 `['paper','anzhiyu']` 收到 `['paper']`，`assets.gen.js` 的 `THEME_BG` 由 `build:sri` 重生成（anzhiyu 那条自动消失）。
- **边界**：这条只管「默认主题是块还是裸 `:root`」。第三种形态（既无块也无裸 `:root`）由 TC-01 先红。另外 `build:sri` 之后必须重启 dev server —— 旧进程继续下发旧哈希，浏览器按 `integrity` 拦掉新 CSS，症状是「页面完全没样式」，别当成 CSS 写坏了查。
- **出处**：`scripts/test-theme-contract.mjs`（TC-05 / TC-06）、`src/theme-contract.js`（`INLINE_THEMES`）

---

## P-088 同一个视觉问题有两份实现，改掉带主题前缀的那份等于没改

- **现象**：视觉评审列了「首页双列」「标签五色轮换」要删。照字面去 anzhiyu 层删——双列的 grid 在 `@media (min-width: 1180px)` 里，选择器是 `main.wrap.home .post-list`，**没有 `[data-theme]` 前缀**，注释却写着「只放宽首页」。它写在 anzhiyu 段落中间，所以读代码的人默认它只属于 anzhiyu；实际八套主题全中。标签也一样：anzhiyu 层是 `nth-child(5n+2..5n+5)` 四色，基准层还有一份 `.tag.tw-t0..t9` 十色——**问题的主份在基准层**。
- **根因**：主题相关的样式只有一半带前缀。带前缀的那半在 review 时看得见（`grep anzhiyu` 能搜到），不带前缀的那半是隐形的——它在 anzhiyu 段落里，但 CSS 不看段落上下文。于是「在 anzhiyu 层删掉六项」这个动作在语法上完成了，在效果上一项没删。
- **复现**：`grep -n "main.wrap.home" public/style.css`，看它在哪个注释块下、有没有 `[data-theme]` 前缀。切换主题到 ink，宽屏下首页仍是双列——这就是泄漏的证据。
- **断言**：删双列时把整段（grid、`> :not(.post-card)`、`.thumb` 的 176 尺寸）一起删，不留半段；标签侧把基准层十色 + 暗色十档 + 5px 圆点 + `::before` 全部删掉，然后**反向**断言 `!/--tw\s*:/.test(css)` 与 `!/\.tag\[class\*="tw-t"\]/.test(css)`（`scripts/test-ux-l3.mjs`），注入任何一处都会红。正向断言「十档色值齐全」这一刻起必须翻面，否则它守的就是已经删掉的东西。
- **边界**：反向断言只能证明「没有 `--tw` 定义」，不能证明「标签云看起来是单色」——配色若改由行内 style 注入，这条抓不到。渲染层靠灰度截图看（`scripts/shots.mjs` 每张图额外输出 `-gray.png`）。
- **出处**：`public/style.css`（`.post-list` 双列段已删、`.tag.tw-t*` 已删）、`scripts/test-ux-l3.mjs`（标签单色反向断言）、`scripts/shots.mjs`（灰度截图）

---

## P-089 按「这块没有」的清单施工前，先 grep 一遍现状，否则会造出第二份

- **现象**：视觉评审给出七条，其中第 6 条写「现在线上 `style.css` 里没有 print 段，等于打印出来是米白底 + 阴影 + 看不到链接」。实际 `public/style.css` 里 `@media print` 已经 44 行：白底黑字、隐藏导航、折叠代码展开、链接 `http` 地址印出、表格解除限高、`page-break-inside`，一样不少。照着清单直接追加，就会出现第二段 `@media print`，位置在原来那段之后，**整体覆盖**前一段里没重复的规则——原有 44 行里有一半会悄悄失效。
- **根因**：需求清单描述的是「我以为的现状」，不是现状。清单越长、越像体检报告，这个偏差越贵：它同时给了方向和「已完成度」，而后者从没被核验。同类偏差这一轮还有两处——「删掉 hero SVG 能省 90px 首屏」不成立（那个节点是 `position:absolute` + `display:none`，本来就不占高度），「TOC 左侧色条没有脚本在推」也不成立（见 P-090，写入端在 `public/post.html`）。
- **复现**：`grep -c "@media print" public/style.css`，修前是 2（一段主块 + 一行 mermaid）。把 mermaid 那行并进主块后是 1。不并的话，T-06 的 `printCount === 1` 直接红。
- **断言**：`scripts/test-typography.mjs` T-06 先数 `@media print` 段数必须为 1，再在**那一段**里查四件事：`@page` 页边距、`attr(href)` 印链接、`box-shadow: none !important`、`--fg: #000` 洗 token（深色模式打印出来是 `#e9e6e1` 浅灰）。段数那条是主判据：它挡的不是「漏写」，是「写了两份」。
- **边界**：`grep -c` 只能数到段，数不到「某条规则是否被后一段覆盖」。真正的覆盖关系要按源码顺序读。T-06 的 `printCss` 从第一段切到文件尾，若将来 print 段不在末尾，切片会带进别的规则——那时要改成按大括号配对截取。
- **出处**：`public/style.css`（打印段）、`scripts/test-typography.mjs`（T-06）

---

## P-090 按扩展名搜代码，把活功能判成死代码：`--toc-p` 写在 `public/post.html` 里

- **现象**：改侧栏目录时，我 grep 了 `public/*.js` 与 `src/*.js` 找 `--toc-p` / `setProperty` / `IntersectionObserver`，0 命中，于是当场判定「进度条从上线起就没亮过，JS 从来没写，`check-toc-bar.mjs` 守的是个不存在的功能」。真实情况正相反：`public/post.html:528` 就是 `ol.style.setProperty('--toc-p', …)`，`:534` 切换 `.on`，截图里当前小节是橙色的。差一步就把一个在跑的功能写进文档、还据此删掉一个有效的检查脚本。
- **根因**：无构建静态站的脚本有三个落点——独立 `.js`、HTML 内联 `<script>`、以及 Worker 模板拼出来的字符串。只按扩展名 grep，漏掉的恰好是最大的一类（`public/post.html` 有 600+ 行内联脚本）。更根本的是：把「搜不到」当成「不存在」。否定结论没有第三来源（运行时读 DOM / 截图），而搜索只能证明「我搜的那几个文件里没有」。
- **复现**：`grep -rn "toc-p" public/*.js src/*.js` → 0；`grep -n "toc-p" public/post.html` → 528。再用 puppeteer 读 `.post-toc a.on` 的 textContent，非空——两个来源不一致时，以运行时为准。
- **断言**：色条这次确实要删（要求是「纯缩进」），删的时候三处一起清：CSS（`ol::before` + 两处 `border-left`）、写入端（`public/post.html` 的 `--toc-p` 块与只服务于它的 `ol` 变量）、守它的像素检查（`check-toc-bar.mjs` / `check:toc` / `ci-browser` 条目）。T-07 反向锁 CSS 侧；写入端与检查脚本的删除没有断言，属于已知未自动化。
- **边界**：`.on` 的高亮必须保留（JS 仍在写，删掉它当前小节就不变色了）。所以「删色条」不等于「目录失效」——这也是本条与 P-089 的共同点：**先分清哪一半在跑，再决定删哪一半**。
- **出处**：`public/style.css`（`.post-toc`）、`public/post.html`（`--toc-p` 写入端已删）、`scripts/test-typography.mjs`（T-07）、已删的 `scripts/check-toc-bar.mjs`

---

## P-091 行号与代码字号不同，却共用同一个无单位行高

- **现象**：代码块行号 `.gutter` 是 12px，代码是 14px，两边都写 `line-height: 1.7`。无单位行高按**各自字号**换算：20.4px vs 23.8px，每行差 3.4px。十行之后编号就比代码低 34px，读者会以为行号标错了行。
- **根因**：`1.7` 看起来是「同一个值」，实际是「同一个倍数」。行号是独立块（`white-space: pre` 的一串数字），它不继承代码的行盒，只能靠 px 对齐。这类错在短代码块（<5 行）里肉眼看不出来，而长代码块才加行号（`long` 判定），恰好是漂移最明显的地方。
- **复现**：打开任意 40 行以上的代码块，量 `.gutter` 与 `code` 的第 1 行与第 20 行基线差；或直接算 `12×1.7` 与 `14×1.7`。
- **断言**：`.md pre.code-block` 的 `font-size × line-height` 必须等于 `.gutter` 的 px 行高（容差 0.01）。`scripts/test-typography.mjs` T-08 读三个数现算，改字号不改行号会红。
- **边界**：这条只管行高对齐，不管字体本身的 ascent/descent 差；等宽字体与数字混排若仍有 1px 视觉偏差，属于字体度量，断言管不到。
- **出处**：`public/style.css`（`.md pre.code-block` / `.gutter`）、`scripts/test-typography.mjs`（T-08）

---

## P-092 打印段的 token 洗白输给皮肤文件：`(0,3,0)` 压 `(0,2,0)`

- **现象**：`@media print` 里用 `:root, :root[data-mode="dark"]` 把 `--bg/--fg` 洗成白纸黑字，纸韵（裸 `:root`）下完全正常；换成 `ink` + 深色再打印，computed 是 `--bg #0e0e10`、`--fg #efeee9`、代码块 `rgb(23,23,26)` —— 存 PDF 得到一张**深色纸**。同一段还漏了代码高亮：`--tok-*` 从来没洗过，纸韵深色下 `--tok-k #d6a4e0` 印在白纸上对比度约 **1.9:1**，关键字与字符串基本只剩字形轮廓。
- **根因**：六套皮肤是独立 CSS（`/theme/ink.css`），最强的一条是 `:root[data-theme="ink"][data-mode="dark"]`，权重 `(0,3,0)`；print 段只有 `:root (0,1,0)` 与 `:root[data-mode="dark"] (0,2,0)`。**权重先于顺序**，print 段写在样式表最后也没用。更根本的是分层错觉：「打印样式属于全站」让人只想到页面，没想到还有六份皮肤文件在改同一批变量 —— token 属于主题层，print 段却按页面层去写。
- **复现**：按真实加载顺序注两份 CSS（`<!--THEME-->` 在 `<link style.css>` 之前，即皮肤先到），`emulateMediaType('print')` 后读 `getComputedStyle(document.documentElement).getPropertyValue('--bg')`。实测四组（修前）：paper/light `#fff`、paper/dark `#fff`、ink/light `#fdfcfa`、**ink/dark `#0e0e10`**。修后四组统一 `#fff` / `#000` / tok `#a626a4` / codeBg 白。
- **断言**：`scripts/test-typography.mjs` T-09 枚举 13 个 token（`--bg…--accent-soft` 含 `--tok-k/s/n/f`），要求 print 段内**恰好声明一次且带 `!important`**。唯一计数是防「别处补一条同名声明把断言凑绿」。两次注入都验过：去掉 `--bg` 的 `!important` → 红（「皮肤 (0,3,0) 会整条压过它」）；把 `--tok-f` 复制成两条 → 红（「声明了 2 次」）。
- **边界**：`!important` 只压 token 声明，不压皮肤里的非 token 规则（如 ink 的 `.back-top` 覆写）——那些靠 print 段 `display:none` 与 `* { box-shadow: none !important }` 处理。自包含页面不适用：`serverErrorPage()`（`src/index.js`）与 `auth.js` 的提示页注释里就写明不引 `/style.css`，样式全内联，天然白底黑字；`stats.js` 后台页引 `/style.css`，自动继承本段。
- **副产品**：TC-05 的 `ruleCount` 是 `cssText.split('\[data-theme="id"\]')` 的字面量计数，被 print 段注释里引用的选择器原形态命中，一度报「ink 在主表里有 1 条规则」。同轮改为**剥注释再数**（`replace(/\/\*[\s\S]*?\*\//g, '')`）—— 注释里引用选择器是正常说明手段，不该算成规则。
- **出处**：`public/style.css`（`@media print` 的 token 块）、`scripts/test-typography.mjs`（T-09）、`scripts/test-theme-contract.mjs`（`ruleCount`）

---

## P-093 print 段按「想到什么写什么」写，漏掉的是一整类元素

- **现象**：`@media print` 存在、token 也洗干净了，逐页渲染仍抓到 9 处：文章页顶部阅读进度条（`.read-pct`，`position: fixed`）照印；归档时间线 `.tl-item` 的 `margin: 0 -10px` 把右边界顶出 10px（纸上直接裁边）；归档页年份分段按钮可见；列表页几十张封面缩略图全印；404 的搜索表单还在；后台 4 页 `body` 锁 `100vh` + 内部滚动，**存 PDF 只有第一屏**；后台侧栏 264px 常驻；编辑器工具栏与发布按钮印成空框。
- **根因**：print 段是**按类名清单**写的，清单来自「写的时候想得到什么」。但纸上会出现什么是**运行时决定**的：`.read-pct` 由 `app.js` 注入、`.arch-bar` 由模板按年份渲染、后台是满屏应用壳（`height:100vh` + 内部 `overflow-y:auto`）。读 CSS 只能确认「哪些规则存在」，不能确认「哪些元素会落在纸上」。这条与 P-092 同源：都是「按层写」与「按渲染验」的差 —— P-092 漏的是主题层，这条漏的是页面内的一类元素。
- **复现**：`npx wrangler dev --port 8787` 后 `node scripts/check-print.mjs`。脚本遍历 13 个前台路由 + 4 个后台路由，逐页 `emulateMediaType('print')`，五条判据：body 背景须白、横向溢出 ≤1px、无可见 fixed/sticky、无非白大背景块、无可见按钮。实测修前 13 个 ✗ / 修后 17 个 ✓。
- **断言**：`scripts/check-print.mjs` 自身 `exit(fails?1:0)`，旧版本服务（SRI 对不上 → CSS 被拦）实测 `EXIT=1`。**假绿防线**：样式没加载时上面五条会全部「通过」（没有 fixed、没有背景、没有按钮），所以先查 `--bg` 是否为空 —— 为空即判 `NO-CSS`，后面判据一律不认。
- **边界**：脚本抓的是「结构性残留」，抓不出「压得够不够」——hero 从 159px 压到 57px 是数值达标，好不好看仍是人眼。
- **出处**：`scripts/check-print.mjs`、`public/style.css`（`@media print` 末尾两段）

---

## P-094 打印禁令按页面清单写：清单比页面少一条，而且空列表时看不出来

- **现象**：`/admin` 只验过概览 / 媒体 / 统计 / 编辑器四页。把体检清单扩到全部十二个后台页 + `/editor` 后，`/admin/friends` 立刻 ✗ —— 新增友链表单的提交按钮、每行「编辑 / 立即探测 / 删除」三个按钮全印在纸上。同类残留还在 `/admin/history`（预览 / 回滚）、`/admin/comments`（通过 / 驳回）、`/admin/review`（`.rv-btn`）里，只是本地库没有行数据，页面渲染成空列表，**体检全绿**。
- **根因**：上一版 print 段按「屏幕上看到过哪些按钮」列类名（`.copy-link`、`.view-head .btn`、`.pub-actions`…）。后台每个子页都是独立模板，各自有 `.adm-fr-ops` / `.adm-hist-ops` / `.adm-cmt-ops` / `.rv-btn`，清单必然漏；漏掉的那几条又恰好长在「有数据才渲染」的行里，本地空库直接绕过。判据换了形态：**按元素类型收口** `button, [role="button"] { display: none }` —— 纸上没有任何东西可按，这个判断与页面、与数据量、与主题都无关。`input/textarea/select` 不能一起收（编辑器里它们承载标题与正文）。空壳表单（`.adm-fr-add` / `.adm-fr-edit` / `.adm-cmt-ops` / `.adm-cmt-toggle`）单独隐藏，因为印出来是一排 placeholder 空框。
- **复现**：`npx wrangler dev --port 8801` 后 `AUDIT_ORIGIN=http://127.0.0.1:8801 node scripts/check-print.mjs`；插一行 `comments(status='pending')` 与一行 `post_revisions` 再看评论 / 历史页。修前 `/admin/friends` 11 个按钮上纸，修后全部 0。
- **断言**：`scripts/check-print.mjs` 覆盖 15 个前台路由（含年份归档、系列详情、OAuth 提示页）+ 13 个后台路由，`exit(fails?1:0)`。清单本身是手写的，所以另有 `test-typography` 的 **T-10** 对账：`src/index.js` 里每个 `path === '/xxx'` 字面量必须出现在清单里，非页面出口（`/auth/*`、`/avatar`、rss/sitemap/robots/llms/manifest）逐条列进 `NON_PAGE` 并给理由；注入验证（删掉 `['/admin/tools',…]`）实测变红。另加独立下限「字面量 ≥ 25 条」，防源码重构成查表后正则抓空、断言恒绿。
- **边界**：`button` 一律不印的前提是「按钮里没有内容」。目前成立（复制 / 折叠 / 主题 / 导航 / 后台操作全在按钮上）。哪天有按钮承载正文（比如「展开全文」把内容放在按钮自身文本里），这条要收窄到类名。
- **出处**：`public/style.css`（`@media print` 末尾「按元素类型收口」段）、`scripts/check-print.mjs`、`scripts/test-typography.mjs`（T-10）

---

## P-095 边缘缓存里的旧 HTML 带旧 integrity：审计假红，线上发版后 5 分钟白屏

- **现象**：同一份代码、同一个 dev server，`/` 与 `/p/*` 报 `NO-CSS`（`--bg` 为空、body 透明、按钮全可见），`/archive`、`/tag/*` 却正常。对比响应头：首页 `style.css?v=250592fd18`，归档页 `style.css?v=b88da71348` —— 两个不同的内容哈希，同一时刻。
- **根因**：`build:sri` 改过 `style.css` 之后，`ASSET_HASH` 变了，但本地 `.wrangler/state/v3/cache` 里还留着上一轮渲染好的 HTML（`s-maxage=300`），里面写死了旧 `?v=` 与旧 `integrity`。浏览器拿到新 CSS 字节、按旧哈希校验 → SRI 拦截 → 整页无样式。这不是页面缺陷，是**缓存与构建产物不同步**。线上同理：发版瞬间边缘缓存仍在吐旧 HTML，最长 5 分钟整站无样式（PWA 强缓存 CSS 一年是另一回事，`?v=` 变了就是新 URL）。
- **复现**：改 `public/style.css` → `npm run build:sri` → **不重启** dev server 或不清 `.wrangler/state/v3/cache` 直接跑体检，首页必现 `NO-CSS`。清缓存后同一路由 `style.css?v=` 与归档页一致，立刻转 ✓。
- **断言**：`check-print.mjs` 的 `NO-CSS` 红线正是这条的探测器（改坏输入先红：旧服务实测 `EXIT=1`）。日常跑体检前先 `rm -rf .wrangler/state/v3/cache` 并重启 dev（`build:sri` 之后必须重启，理由见 P-092 边界那段：旧进程下发旧哈希）。
- **边界**：线上无法用清缓存验证，只能靠 `?v=` 一致性判断——同一时刻抓两页比 `style.css?v=`，不一致就是缓存没同步，不是样式坏了。
- **出处**：`scripts/check-print.mjs`（`NO-CSS` 判据）、`scripts/build-sri.mjs`、`.wrangler/state/v3/cache`

---

## P-096 正文宽度的断言量在 `.wrap` 上，真正生效的是媒体查询里的 grid 列

- **现象**：T-01 长期绿在「正文内容宽 720px（.wrap 764 - 2×22）」。浏览器实测 `getComputedStyle` / `getBoundingClientRect`：`main.wrap` 计算 `max-width: 1180px`，`.post-body` 宽 **780px**，17px 字号下每行 45.9 个汉字 / 88ch（目标区间 34~40 字 / 65~75ch）。同一份 CSS 里 `@media (min-width:1440px)` 的注释还写着「正文固定 720」，而 1080 档写的是 780 —— 意图与实现不一致。
- **根因**：读源码层断言只覆盖了 `.wrap` 那条规则，没有跟进 `@media (min-width:1080px)` 里 `.post-article { grid-template-columns: 232px minmax(0,780px) }`。媒体查询的 grid 列在 1280/1440/1600 视口下直接决定正文宽，`.wrap` 的 720px 被它盖掉。这是 P-084 的同类：**断言落在编码之前的那一层，测的是另一个东西**。不是「没设计」，是「量错了地方」。
- **复现**：`getComputedStyle(document.querySelector('.post-body')).width` → 780px；跑 `node scripts/test-typography.mjs` → T-01 仍绿。把 1080 档改回 `minmax(0,720px)` 后浏览器实测 720px / 42.4 汉字 / 81ch。
- **断言**：T-11 把三档宽屏列（1080/1440/1600）逐个解析出来，与 T-01 算出的 `.wrap` 可用宽相等才算过；独立计数「固定列断点恰好 3 个」防解析失效后空集恒真。注入验证：把 1080 档改回 780px，T-11 立刻红，恢复后绿。T-12 同时锁住 body 的 `tabular-nums lining-nums`（前台此前只有后台声明，实测当前字体栈 `000`/`111`/`012` 已同宽——补的是跨平台契约，不是本机可见变化）。
- **边界**：老板 2026-11-27 亲定 **660px**，不取 680 的理由是「680 只是刚好进区，660 进区且有余量」：中英混排 + 大量代码行会顺着正文宽走，81ch 的英文行偏长；左侧 232px 目录在 720 时显得像附属物。老板估的是 74ch，`tabular-nums lining-nums` 落地后浏览器实测 `0` 宽变大，ch 变 **72**；落文档按实测值，不按估值。T-01 从「680~740 区间」收紧为 `=== 660`，T-11 继续守三档同源。
- **出处**：`public/style.css`（`.wrap`、`@media (min-width:1080px)` 的 `.post-article`）、`scripts/test-typography.mjs`（T-01 / T-11 / T-12）

---

## P-097 线上体检拿首页当夹具：首页没有那篇文章，判据却说「协商标记丢了」

- **现象**：本地 `check:live` 18 项失败，其中「自有封面走 avif/webp 协商」报红——首页确实一个 `<picture>` 都没有。但接口里唯一一篇自带 `/img/` 封面的文章（`post-edpe2`）排在第 **12** 位，首页只渲染前 10 篇；第 2 页和文章页各有 1 个 `<picture>`。同一段里「avif 变体可用」也红了，因为它从首页正文 grep 了一个 `/img/` 地址，抓到的其实是页头 `brand-avatar`，回退响应头明写 `x-img-fallback: avif-missing-served-original`。
- **根因**：断言的输入与它要证明的命题不是同一个对象。命题是「有自带图的文章有没有协商标记」，输入却取了「接口全库列表 + 首页 HTML」。只要自带图那篇不在第 1 页，或首页页头刚好有个 `/img/` 头像，判据就测错了东西。线上之所以一直绿，是因为线上 21 篇封面全是 `/thumbs/*`，断言走「跳过」分支——**跳过不代表它是对的**。
- **复现**：本地起 `npx wrangler dev --port 8803 --var SITE_ORIGIN:http://127.0.0.1:8803`，`node scripts/check-live.mjs http://127.0.0.1:8803`。修前「协商」红、夹具名未打印；修后打印 `post-edpe2` 并转绿，失败从 18 → 5（其余 5 项都是本地种子/R2 缺口，见边界）。线上同一脚本 135/0 → 138/0（三个「跳过」改成显式 ok）。
- **断言**：`scripts/check-live.mjs` 现在从 `/api/posts` 找到第一篇 `/img/` 封面的文章，直接打它的页面验 `<picture><source type="image/avif">`；原图与变体也用那篇文章的 `cover`，不再从首页 grep。输入从「首页」换成「有自带图的那篇」后，同一条判据由红转绿——这就是 P-075 要的「改坏输入先红，改对转绿」。
- **边界**：本地剩余 5 项全是环境缺口，不是代码故障：① `avif 变体可用`——本地 R2 只有原图，Worker 按设计回退（响应头 `x-img-fallback` 为证）；② `首图 preload` + ③~⑤ 相关推荐三条——夹具 `post-brfy5` / `worker-cron-friend-check` / `worker-render-549-to-96` 本地 404、线上 200，本地库只有 17 篇。要让本地全绿得先把线上 D1 导进本地并补生成 R2 变体（`make-variants` 默认打远端）。
- **出处**：`scripts/check-live.mjs`（第 7 段「原图与变体」、相关推荐夹具）、`src/index.js`（`thumbTag` / `serveImage` 回退链）

---

## P-098 本地体检的最后 5 项不是「代码故障」，是夹具和变体根本没落地

- **现象**：P-097 修完后本地 `check-live` 仍 129/5。红的是 `avif 变体可用`（回 `image/png`）、`首图 preload` 和三条相关推荐。线上同一脚本 138/0——本地库 18 篇，缺 `post-brfy5` / `worker-cron-friend-check` / `worker-render-549-to-96`；本地 R2 只有 8 个原图、1 个 webp，没有 avif。
- **根因**：`make-variants.mjs` 的 D1 查询与 R2 put 都写死 `--remote`，`SITE` 默认线上；`seed-ci.mjs` 造的是 UX 夹具（目录/横滚/评论折叠），不含线上体检盯的三篇真实文章。于是「本地跑线上体检」测到的是空集：缺文章的页面 404，缺变体的 URL 走设计内的回退，没有一条能证明线上判据有效。
- **复现**：`npx wrangler dev --port 8804 --local --var SITE_ORIGIN:http://127.0.0.1:8804` 后 `node scripts/check-live.mjs http://127.0.0.1:8804` → 129/5。`node scripts/seed-live-fixtures.mjs` 从线上只读 D1 与 `/img/`，写本地 D1/R2；再用 `VARIANTS_SITE=http://127.0.0.1:8804 node scripts/make-variants.mjs --local` 补 44 个变体 → **136/0**。首图 preload 的 Link 头现在真带 `.w480.avif` 的 `imagesrcset`，相关推荐第一张是 `/p/worker-render-549-to-96`。
- **断言**：`test-variants.mjs` 新增三条源码断言：`SCOPE` 同时管 D1 与 R2（恰好 3 处：声明 + 两处使用）、本地模式跳过 CDN 清缓存、默认探测本地 dev；另两条锁 `seed-live-fixtures.mjs` 的 put/d1 落地路径只能是 `--local`。注入验证：把 R2 put 的 `SCOPE` 改成 `'--remote'`，`SCOPE` 计数从 3 掉到 2 并变红，恢复后绿。
- **边界**：`--local` 只换读写目标，不换图片来源——`VARIANTS_SITE` 仍可指向线上拉原图，这样本地桶才补得齐。wrangler 4 的本地 D1 拒绝 SQL 文件里的 `BEGIN/COMMIT`，seed 脚本靠「按固定 id 删除再插」保持幂等，不靠显式事务。线上数据只读，三篇夹具固定 id 9001~9003，不碰真实文章。
- **出处**：`scripts/seed-live-fixtures.mjs`、`scripts/make-variants.mjs`、`scripts/test-variants.mjs`、`scripts/check-live.mjs`

---

## P-099 CI 夹具的时间戳跟着 seed 执行时刻漂：本地 sitemap 日期链差一天

- **现象**：本地 `node scripts/check-sitemap.mjs http://127.0.0.1:8806` 是 12/1，`[P-048] datePublished / lastmod / RSS pubDate 三者不矛盾` 红在两篇夹具：`ci-fixture lastmod 2026-11-22 < datePublished 2026-11-23`、`ci-plain lastmod 2026-11-21 < datePublished 2026-11-22`。页面、RSS、sitemap 各自都没报错，只有日期链互相对不上。
- **根因**：`seed-ci.mjs` 用 `datetime('now', '-3 days')` 写 UTC 裸字符串。页面显示走 `localDay()`（再 +8 取北京日），sitemap 的 `lastOf()` 直接取字符串前 10 位（UTC 日）。种子执行在 UTC 16:00 之后（北京时间 00:00 后）时两者必然差一天——本地库那两行是 UTC 17:33 灌的。同一份夹具白天灌就绿、凌晨灌就红，不是代码改坏了。
- **复现**：把 `published_at` 改成 `2026-11-24 12:00:00` 后重跑 → 13/0；`npm run seed:ci` 现在锚在 `date('now','-N days') || ' 12:00:00'`（+8 后仍是当天 20:00），任何时刻重灌都同天。评论继续用 `datetime('now')`，它们是相对时间的靶子且不进 sitemap。
- **断言**：`scripts/test-tz.mjs` 从 `seed-ci.mjs --sql` 取真实输出：posts 块里锚定表达式恰好 6 处（两行 × 三个时间列）、`datetime('now')` 0 处、评论相对时间 2 处；再把锚定表达式交给 `node:sqlite` 求值，用独立的 `localDay()` 验「显示日 == sitemap 取的 UTC 日」。注入：把一列改回 `datetime('now')` → 计数掉到 5 且裸 datetime 断言红，恢复后 41/0。
- **边界**：这是本地夹具的时间口径问题，不改展示层与 sitemap 的生成逻辑；线上库由后台 `nowISO()` 写 UTC，P-048 的 +8 对账口径保持原样。这里的「any time of day 都同天」只对夹具成立，真实凌晨发布的文章仍会显示北京次日日期——那是展示层的既定设计（`localDay`），不是本条要改的东西。
- **出处**：`scripts/seed-ci.mjs`、`scripts/test-tz.mjs`、`scripts/check-sitemap.mjs`（P-048）、`src/utils.js`（`localDay`）

---

## P-100 分享卡是唯一对外门面，却挂着旧域和站内不存在的四色渐变

- **现象**：三个 OG 产物各说各话：`og-default.jpg` 浅底蓝紫渐变 + `exia.de5.net`、`thumbs/auto-N.jpg` 紫蓝绿琥珀六色、`/cards/*.png` 按分类四色 + 同一个旧域。别人第一次见到这个站是在群里/时间线上那张卡，不是在 660px 正文列 —— 最有辨识度的门面挂着已 301 掉的旧域。
- **根因**：`gen-title-cards.py` 把域名写死在 `d.text()` 的参数里，四色写死在 `ACCENT` 字典里。换域时 `SITE_ORIGIN` 只归一了 Worker 运行时，构建期产物没人管；分类配色是早期「让栏目看起来不同」的约定，后来 paper 底座收口成铁锈橙单色，产物没跟着收。
- **复现**：2026-11-27 把 `gen-title-cards.py` 改成深墨底 `#141518` + 铁锈橙 `#a8501f` + `SITE_ORIGIN` 派生域名，全量重出 40 张卡和 `og-default.jpg`。分类不再决定颜色（信息归标题里的栏目文字），渐变光晕整个删掉。
- **断言**：`test-assets.mjs` 逐文件验 1200×630 与体积；`test-cards.mjs` 验 `ogCoverOf()` 真值表与仓库图同尺寸；`optimize-assets.mjs --check` 守图片预算。域名由 `SITE_ORIGIN` 一处派生，但**派生正确 ≠ 产物全对**：`test-cards.mjs` P-100 现在全量扫 `cards/*.png` + `thumbs/*.jpg` + `og-default.jpg` 的原始字节，40+ 张一张不漏；抽样 3 张只能验脚本逻辑，验不了产物完整性。自检喂旧域字节必须判真，注入非首卡单独验过全量那条独立红。
- **边界**：深底 4:2:0 JPEG 的米白字亮度细节不受色度抽样影响，实测 23.2K 过 26K 预算；40 张卡压缩后 673K，预算按每张 20K × 40 调到 800K（原来 470K 是 14 张时代的数）。
- **出处**：`scripts/gen-title-cards.py`、`scripts/gen-cards.mjs`、`scripts/optimize-assets.mjs`、`README.md`「标题卡」段

---

## P-101 theme-color 的暗色首屏不能等 JS：meta 要 SSR 出两条，JS 接管后删一条

- **现象**：SSR 只出一条浅色 `theme-color`，暗色用户在 CSS/JS 到手前顶栏是亮白的；更持久的错是用户手动选浅色、系统却是暗色时，`querySelector` 只改第一条，浏览器的 `prefers-color-scheme` 仍按系统偏好取色，页面亮着而地址栏长期是黑的。
- **根因**：theme-color 的值有两个来源在打架——SSR 常量和运行时计算样式。[P-055] 已经把浅色那条改成从 CSS 派生，但只解决「主题换色忘了改常量」，没解决首屏和执行顺序。
- **复现**：SSR 由 `themeColorMetas()` 一次输出浅色 + `media="(prefers-color-scheme: dark)"` 两条，值分别取 `THEME_BG` / `THEME_BG_DARK`（都由 build-sri 从各主题 `--bg` 派生）。`theme.js` 的 `syncThemeColor()` 在 `apply()` 里删掉 media 那条、只把剩下的写成当前 `--bg`。
- **断言**：`test-theme-contract.mjs` TC-47 逐值比对 `THEME_BG_DARK` 与 CSS 暗色块，行首锚定三个 head 出口都走 helper（恰 3 处）、`apply()` 里恰 1 次调用 `syncThemeColor()`。注入三处坏值逐条验过：改错色值 → 逐值比对红；手搓一条出口 meta → 计数掉到 2；删 sync 调用 → 计数掉到 0。恢复后 47/0。
- **边界**：首屏的两条 meta 是给无 JS / JS 未执行时的兜底，不是给浏览器长期按系统偏好决定 —— JS 一旦跑起来，用户选择就是唯一事实来源。
- **出处**：`src/index.js`（`themeColorMetas`）、`scripts/build-sri.mjs`（`THEME_BG_DARK`）、`public/theme.js`（`syncThemeColor`）、`scripts/test-theme-contract.mjs`（TC-47）

---

## P-102 首页 16.5 / 文章 17 两档字号：读者点进文章的那一刻字号会跳

- **现象**：`body` 基准 16.5px，`.post-body` 显式 17px。首页和文章页两套规则各长各的，从列表点进正文字号跳一档；`ch` 口径跟着分裂 —— 文章页按 17px 定死 72ch，首页同宽下是另一个数。四档字号（卡片 17.5 / 正文 16.5 / 文章 17 / h2 22）挤在 16.5–22 之间，层级靠衬线切换撑，不靠尺度。
- **根因**：字号是在各页面容器上分别调出来的，没有一条「全站正文基准」的契约；T-01 只锁宽度、没锁字号，所以两档长期共存且全绿。
- **复现**：2026-11-27 收成单一基准 —— `body` 改 17px，`.post-body` 已是 17px 不动；首页因此略微变宽，卡片区回到 660 那套口径。改声明不加规则，gzip 只动几个字节。
- **断言**：`test-typography.mjs` T-13 从 body / `.post-body` 两处独立读字号，要求都为 17 且 CSS 全文无 16.5px 残留；注入 16.5 回退实测红。
- **出处**：`public/style.css`（body / .post-body）、`scripts/test-typography.mjs`（T-13）

---

## P-103 断言里的 `color:` 子串：`border-bottom-color` 让 hover 判据恒绿

- **现象**：新写的「hover 必须进铁锈橙」判据用 `/color:\s*var\(--accent\)/` 搜 `.md a:hover` 的规则体。把 CSS 里的 hover 字色改回 `color: inherit` 后断言照样绿 —— 因为同一行的 `border-bottom-color: var(--accent)` 里也有一段 `color: var(--accent)`，正则命中了它。
- **根因**：判据的输入是整段声明文本，而搜索词是另一个属性的子串。这属于「同形假绿」的新形态：不是没验，是验的时候搜到了自己要检验那步之外的东西。宽泛正则 + 同一行多个同后缀属性 = 必然误命中。
- **复现**：注入验证时第一次没红，停下来查才发现。`test-typography.mjs` 改成 `decl()` 先按分号切成独立声明、再用 `^color\s*:` 行首锚定取那一条，正则本身也锚 `^color:`；静态色与 hover 色都走这个函数。改完逐条注入：静态改 inherit → 红；hover 改 inherit → 红；恢复 → 绿。
- **断言**：T-05 现在有独立的 `decl()` 取声明，且静态色要求同时含 `color-mix` / `var(--fg)` / `var(--accent)` 三个来源（只查 color-mix 会被「混两个 fg」骗过）。
- **边界**：任何「从规则体里搜某个属性」的断言，只要同块里有别的属性以相同后缀结尾（`*-color`、`*-width`、`*-background`），都必须先切独立声明再行首锚定，不能宽泛搜子串。
- **出处**：`scripts/test-typography.mjs`（T-05 / `decl()`）

---

## P-104 派生断言守机制，比例靠 review —— 别把「有断言」读成「比例也安全」

- **现象**：正文链接静态色写成 `color-mix(in srgb, var(--fg) 70%, var(--accent))`，T-05 断言要求同时命中 `color-mix` / `var(--fg)` / `var(--accent)` 三个来源。某天把 `70%` 改成 `95%`，三条来源都在、断言全绿，但链接已经接近纯橙 —— 静止态重新变成「一色说五事」，正是这条规则当初要避开的。
- **根因**：断言能守的是「颜色从哪来」（机制），守不了「按多少比例混合」（数值）。对比度余量 12.31 / 9.87 大到把数值也写成断言时几乎无法改红 —— 按 P-075 停手条件，这种断言不值得加。于是比例这个自由度就落在断言之外，而「断言全绿」很容易被读成「这一行安全」。
- **复现**：2026-11-27 老板明确这条分工后记录：不加对比度数值断言（难改红、无价值），比例交给 code review。T-05 的职责边界到此为止。
- **断言**：`test-typography.mjs` T-05 只守机制 —— 静态色必须是 `color-mix` 且混了 `--fg` 与 `--accent`，hover 必须显式进 `--accent`（`decl()` 切独立声明 + 行首锚定，见 P-103）。比例数值不在断言覆盖范围。
- **边界**：改 `color-mix` 任何百分比时，断言不会红，必须人工算一次明暗两态对比度并确认静止态仍是棕不是橙。同理适用于全站其它 `color-mix` 派生（如 `--line-strong`）：机制断言绿 ≠ 视觉结论成立。
- **出处**：`public/style.css`（`.md a`）、`scripts/test-typography.mjs`（T-05）

---

## P-105 `--apply` 重渲染标题卡会覆盖压缩产物，发版闸门才抓到

- **现象**：`node scripts/gen-cards.mjs --apply` 写 26 条 cover 到 D1 后，`npm run deploy` 在 npm test 一步停下：`test-assets` 报标题卡合计 2300K > 800K、38 张单张超 45K。但提交前跑的 `npm test` 是 EXIT=0 —— 两次测试之间产物被改了。
- **根因**：`gen-cards.mjs` 只调 `gen-title-cards.py` 渲染，Pillow 吐的是 PNG24（2.3MB）；上一版仓库里的卡是另外手动跑 `optimize-assets.mjs` 压成索引色（673K）的。`--apply` 重渲染把压缩版本覆盖回未压缩，而脚本里没有任何一步把它压回去。压缩成了一个"记得手动跑"的动作，恰恰是发版路径上都硬化了闸门、这里却漏掉的那一类 —— **否则下次 `--apply` 还会重犯**：闸门挡住纯属那次跑了一遍完整 deploy，不是断言在产物变更之后仍能守住（和 M-04「断言落在编码之后、测了另一层」同族，这次是「验了另一个时刻」）。修法必须是让产物天生可发布，而不是靠操作顺序。
- **复现**：2026-11-27 v1.2.8 发版时实测触发。修法：把 `optimize-assets.mjs` 接进 `gen-cards.mjs`，紧跟在 Python 渲染之后、体积统计与 SQL 之前 —— 产物天生可发布，不依赖操作顺序。
- **断言**：`test-cards.mjs` P-105 不验「仓库里的 PNG 现在是压缩的」（那只证明上次跑过），而验生成脚本的调用顺序：optimize 调用存在、在渲染之后、在 `if (apply)` 分支之外（只出图模式也要压）。删调用注入实测红，恢复绿。
- **边界**：D1 写入发生在压缩之前，但 cover 只存路径、不存字节，所以已写的 26 条无需回滚；部署上传的是磁盘上的压缩版本。真正不可逆的风险不在这里，而在「闸门放行但产物是坏的」——这条由 npm test 挡住了。
- **出处**：`scripts/gen-cards.mjs`、`scripts/optimize-assets.mjs`、`scripts/test-cards.mjs`（P-105）

---

## P-106 `package.json` 的 version 不是版本真源 —— 别把它列成发版硬前提

- **现象**：`package.json` 停在 `1.2.6`，而线上已发到 v1.2.8。不了解链路的人会以为版本没对齐，要求先改 `package.json` 才准发版。
- **根因**：`scripts/deploy.mjs` 用 `Date.now().toString(36)` 生成 asset version 并注入 `SITE_VERSION`，从不读 `package.json`；语义版本只存在于 git tag + GitHub Release。两条版本号各管各的，本来就不该相等。
- **复现**：2026-11-27 发 v1.2.8 前，老板据 `1.2.6` 把它列为"发版前必须先解决"；核实 deploy 链路后确认是抬高权重，按既有惯例直接发，tag/Release 打 v1.2.8 即可。
- **断言**：无断言，也不加 —— 这是部署链路的约定而不是可测性质。唯一约束是 `deploy.mjs` 里 asset version 的来源保持 `Date.now().toString(36)`，改动它要单独评估 103 Early Hints 的 preload 哈希配对。
- **边界**：`package.json` 的 `version` 可以随便改，对线上产物零影响；反过来，看到它不是当前 tag 号也不代表漏发版。对账版本只看 `git tag --sort=-version:refname` 与 GitHub Release，不看 `package.json`。
- **出处**：`scripts/deploy.mjs`（asset version 计算）、仓库根 `package.json`（P-106）

---

## P-107 同一个颜色同时说四件事，信号被摊薄成「橙色的东西值得注意」

- **现象**：`#a8501f` 在正文一篇里命中 117 次，绝大多数是行内代码（`code` 的文字色），其次是导航/TOC 当前项，摘要与 blockquote 左边框各一份。读者收到的不是「这是当前位置」或「这是引用」，而是一个笼统的「橙色值得注意」——四件事共用一个色，哪一件都不够强。这正是站看起来「正确但没有观点」的颜色侧根因。
- **根因**：不是强调色闲置，恰恰相反是它过载。老板最初提的「让橙只表示作者判断」需要先给行内代码和当前项做语义拆迁，而那两件事都在正常工作，让位只会削弱现有信号。正确方向是反向：让最密的那个语义（代码是阅读中的障碍物）退到中性，把橙腾给结构信号。
- **复现**：2026-11-28 把 `.md code` 的 `color: var(--accent)` 改成 `var(--fg-soft)`。测过 gzip 净变化为 0（`--accent` 与 `--fg-soft` 都在 gzip 字典里），所以这一件不需要先删 CSS 腾预算；注释写成一行后 gzip 38926/39000，余量 74 B。对比度浅 8.28 / 暗 9.21，都过 AA，比正文（16.36 / 14.67）退一档。
- **断言**：`test-typography.mjs` T-14 守三件事：`.md code` 走 `--fg-soft` 而非强调色或裸值；`.md pre.code-block code` 仍是 `color: inherit`（隔离层）；`.tok-k/s/n/f` 四类仍走各自的 `--tok-*`（四色高亮不被连带洗掉）。改回橙色注入实测红，恢复绿。
- **边界**：`--fg-soft` 八套主题各有明暗两档（`CONTRACT_CORE` 锁着），暗色自动跟随，不需要新增暗色规则。代码块里的语法高亮是独立类，不受此改动影响——但 T-14 守的正是「将来有人在 pre 里加 color 覆盖」这类漏法。比例类的视觉判断（退得够不够）靠 review，断言只守机制（P-104 分工）。
- **出处**：`public/style.css`（`.md code` / `pre.code-block code` / `.tok-*`）、`scripts/test-typography.mjs`（T-14）、`src/theme-contract.js`（`CONTRACT_CORE` 含 `--fg-soft`）（P-107）

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
