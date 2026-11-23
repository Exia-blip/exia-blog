# 内容排期（2026-11 → 2026-12）

原则（2026-11-21 起）：**每 2 天发 1 篇，北京时间 09:00 上线**。存量存稿已全部写完入库，改期为 2 天一篇，让它们在一个月内出清；爬虫回访和读者订阅吃的是节奏，密集段正好把站撑起来。旧文实质更新优先于新文凑数。

> **产能警告**：存稿出清后不可持续。每篇都要先做事再写，A 类单篇真实成本 2~3 个晚上——2 天一篇的节奏只适用于消耗 11 月存量，出清后必须回落到可持续频率（每周 1~2 篇），否则会逼出拆稿和数字注水，而这个站唯一不可替代的东西就是数字。这是刻意的一次性冲刺，不是长期节奏。

## 已发

| 日期 | 标题 | 栏目 | 类型 |
|---|---|---|---|
| 11-03 | D1 报错 no such table 排查实录 | 工程实录 | B 报错对照 |
| 11-08 | **OAuth 授权流程拆解（系列 1/4）** Authorization Code：为什么要绕一个 302 才把 token 给你 | 协议拆解 | C 机制拆解 |
| 11-08 | **（系列 2/4）** PKCE 补的是哪个洞：code 在回调路上被截走 | 协议拆解 | C 机制拆解 |
| 11-08 | **（系列 3/4）** OAuth Device Flow 是怎么在不配回调域名的情况下完成登录的 | 协议拆解 | C 机制拆解 |
| 11-08 | **（系列 4/4）** token 到手之后：过期、刷新、撤销分别归谁管 | 协议拆解 | C 机制拆解 |
| 11-08 | **Cloudflare 踩坑（系列 2/3）** wrangler deploy 失败对照：六条报错原文对应的真实原因 | 工程实录 | B 报错对照 |
| 11-08 | **（系列 3/3）** Cannot perform I/O on behalf of a different request：Worker 里不能跨请求缓存的东西 | 工程实录 | B 报错对照 |
| 11-08 | **（系列 4/4）** Workers 里 fetch 超时不是网络慢：subrequest 限额踩坑记 | 工程实录 | B 报错对照 |
| 11-09 | 用 Worker Cron 做友链存活检测：20 分钟一轮，403 不算挂 | **小工具** | D 自家功能 |
| 11-09 | 停手三秒就自动存了：自建编辑器的双保险保存是怎么实现的 | **小工具** | D 自家功能 |
| 11-10 | 实时预览敢让你敲 `<script>`：自研 Markdown 渲染器的「先转义后拼装」 | **小工具** | D 自家功能 |
| 11-10 | R2 图片链路：上传走直传，读取走代理，svg 走沙箱 | **小工具** | D 自家功能 |
| 11-11 | 评论区防滥用：蜜罐、Turnstile、D1 限额，按成本排序的三层 | **小工具** | D 自家功能 |
| 11-13 | 目录不跟着滚：sticky 在 grid 里失效，根因是 align-items 用了 start | 工程实录 | B 报错对照 |
| 11-15 | CLS 从 0.0176 到 0：三个空位把首屏推了 182px | 工程实录 | A 性能归因 |
| 11-18 | Worker 渲染从 549ms 到 96ms：我只改了一件事 | 工程实录 | A 性能归因 |

### 已写好并入库，等闸门到点（11-21 → 12-21）

十五篇全部写完全文、入库，`hidden=0` + 未来 `published_at`，由 `src/api.js` 的 `liveSql()` 时间闸门到点自动上线，不需要 cron 或人工改状态。发布时刻统一为**北京时间 09:00**（库里存 UTC 01:00）。**2026-11-21 起节奏由「每周三一篇」改为「2 天一篇」**：12 篇未到点存稿从 11-25 起每 2 天上线，12-17 收尾（11-21 那篇当日已上线，不动）；改期 SQL 见 `scripts/schedule-2day.sql`，回滚见 `scripts/schedule-2day-rollback.sql`。最后两篇 tools 稿 12-19 / 12-21 由 `scripts/seed-27-28.mjs` 直接入库，同一套口径。

三篇 tools 新稿（相关推荐 / 搜索高亮 / RSS enclosure）由 `scripts/seed-23-24.mjs`、`scripts/seed-25-rss.mjs` 入库，INSERT 直接带 `html_content` + `cover_body`，与 `src/api.js` 新建路径同口径。改为 2 天一篇后接在 12-09 pillar 之后的是 12-11 / 12-13 / 12-15。目标查询词：`博客相关推荐 标签交集排序` / `搜索结果关键词高亮` / `RSS 阅读器 卡片封面 不显示`。② 的辅词：`站内搜索 标签匹配`、`SQLite LIKE 子查询`——主词取短词承接通用前端需求，后端角度靠辅词和线上实测（`debugging` 4 篇全靠标签命中）撑。

新增的 teardown 稿 `csp-nonce-cache` 由 `scripts/seed-26-csp-nonce.mjs` 入库，同一套口径。12-17 收尾，接在 12-15 之后，是「认证边界」四篇之后的第二篇 teardown，不续那个系列、独立成篇。目标查询词：`csp nonce 原理`。素材是读规范 + 线上实测：CF HIT 时 nonce 三次相同（缓存回放整份配对快照）、绕缓存三次全不同、304 主动删 CSP 头。

| 日期 | slug | 标题 | 栏目 | 系列 |
|---|---|---|---|---|
| 11-21 | `ld-self-reference` | 结构化数据里的自指：一个没人发现的 url 循环 | log | — |
| 11-25 | `three-layer-cache` | 三层缓存怎么排，才不会被 Cloudflare 改写成 4 小时 | log | — |
| 11-27 | `jwt-exp-verify` | JWT 的 exp 到底在哪一层被校验 | teardown | 认证边界 1/4 |
| 11-29 | `samesite-behavior` | SameSite 的三种取值，到底谁在什么时候带上 cookie | teardown | 2/4 |
| 12-01 | `cors-preflight-cost` | CORS 预检不是每个请求都发：OPTIONS 的真实成本 | teardown | 3/4 |
| 12-03 | `turnstile-what-it-blocks` | Turnstile 拦住了什么，没拦住什么 | teardown | 4/4 |
| 12-05 | `workers-free-tier-limits` | Workers 免费额度到底能撑多少人：把 10 万次/天换算成真实访问 | log | — |
| 12-07 | `d1-kv-r2-latency` | D1、KV、R2 到底谁快：1100 次调用的实测分布 | log | — |
| 12-09 | `workers-blog-pillar` | Cloudflare Workers 建站全流程（pillar） | site | — |
| 12-11 | `related-posts` | 相关推荐上线那天，排序逻辑根本没跑：post.tags 晚赋值 16 行 | **小工具** | — |
| 12-13 | `search-highlight-xss` | 搜索结果高亮的 `<mark>` 怎么不变成注入点：先切段，再逐段转义 | **小工具** | — |
| 12-15 | `rss-enclosure-cover` | RSS 阅读器卡片封面不显示：缺的是 enclosure，不是正文首图 | **小工具** | — |
| 12-17 | `csp-nonce-cache` | CSP nonce 每次请求都换，缓存里的旧页面怎么办：三处配对与一个 304 | teardown | — |
| 12-19 | `lightbox-no-deps` | 无第三方库的图片灯箱：CSP nonce、SSR 不动、R2 原链路四条约束怎么同时守住 | **小工具** | — |
| 12-21 | `theme-transition-class` | 主题切换只闪一下：临时 class + transitionend 兜底，为什么常驻 transition 会闪首屏 | **小工具** | — |

11-21 这篇是 11-14 当天写完的存货，当日已上线。改期后 11-25 起进入 2 天一篇的密集段，11-21 → 11-25 的 4 天间隔是最后一个长间隔，之后全部压到 2 天。

### 出清后的下一批（5 篇已写完入库，每周三一篇｜2027-01-06 → 02-03）

12-21 十五篇存量出清。**按上面的产能警告回落到每周 1 篇**，不再续 2 天节奏：12-21 → 01-06 留 16 天完整空档，让读者和爬虫都喘一口气，然后每周三北京时间 09:00 上线一篇（库里 UTC 01:00）。每篇都是 11-22 当天做完的一件事，有真实报错、真实响应头、真实提交号，不是为填坑位造的题材。

| 日期 | slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|---|
| 01-06 | `crlf-sri-ci-red` | CI 连红 4 次：本地绿、线上绿、CI 红，根因是 CRLF | log | `sri integrity 不匹配` / `内容哈希 CRLF` | 三个环境三套字节；`i/lf w/crlf` 一处行尾让本地与线上自洽、只有 CI 红；20 个文件转 LF + 两层防线 |
| 01-13 | `early-hints-preload-mismatch` | 103 Early Hints 提前下的 CSS 没人用：preload 和 HTML href 差了一个字符串 | log | `103 early hints preload 不匹配` / `cloudflare early hints css` | 冷访问白下 121KB；两个版本号（部署号 / 内容哈希）逐字符比对；`?cb=` 绕缓存 CDP 实抓 103 三次全中 |
| 01-20 | `d1-schema-migrations` | D1 表结构版本化：第一次跑检查就抓到三处漂移 | teardown | `d1 migrations 最佳实践` / `cloudflare d1 schema 版本管理` | 三份描述互漂的清单；`node:sqlite` 空库重放迁移比对结构；SQLite 不支持 `ADD COLUMN IF NOT EXISTS` |
| 01-27 | `review-status-cache-bypass` | 投稿审核为什么不能复用 hidden：作者自控的开关挡不住作者自己 | teardown | `多用户博客 投稿审核 设计` / `sqlite 审核状态 缓存` | `hidden` 与审核态必须分列；两个闸门分层；未过审不进 LRU 防缓存旁路；四路实测 |
| 02-03 | `monaco-eol-crlf` | Monaco 空文档的 getEOL() 恒返回 CRLF，两个枚举值还相反 | log | `monaco getEOL CRLF` / `EndOfLineSequence LF` | 空文档 `getEOL()` 恒 CRLF；两个枚举字面值相反写死 1 越修越糟；三处修法 + textarea 仍是数据源 |

入库脚本 `scripts/seed-29-33.mjs`，生成 SQL `scripts/seed-29-33.sql`，与其余存稿同口径：`hidden=0` + 未来 `published_at` + `html_content` / `cover_body` 一并 INSERT。守门在 `test-schedule`（间隔 7 天、UTC 01:00、seed 与文档逐条比对）。前四篇的栏目正好把 4:4:2 配额往回拉了一点（3 log : 2 teardown），没有为了配额硬改题材。

**为什么不用定时任务**：11-13/11-18 那两篇是靠 automation 改 `hidden` 上线的，那套有两个故障点——任务没跑、跑了但时间不对。现在全部走闸门，`hidden` 永远保持 0，`published_at` 一到，全部公开查询（列表、归档、分类、标签、系列、RSS、sitemap、单篇 is_live）自动放行。少一个活动部件。

**已验**：九篇直链均 404，首页/归档/分类/系列/RSS/sitemap 均搜不到 slug。

### 待排期草稿（2026-11-23 完成，未入库、未定发布日期）

按「最小 CSS 集」方案侦察后的产出。侦察结论是三KB 预算不适用于本站（实测 gzip 37626 B，差 12 倍）、grep 差集法因 SSR 插值类名失效（54 个"死类"全是误判），因此全文写成**取舍叙事**而非教程。与 11-18 那篇「打脸自己标题」同形态。

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 | 状态 |
|---|---|---|---|---|---|
| `css-minimal-set-tradeoffs` | 样式表也做减法：3KB 最小集的取舍与三个明说的没做 | log | `css 体积优化` / `最小 css 集` | 142039 B / gzip 37626 B / 455 类的实测口径；54 个差集误判的具体类名（`code-block` 插值、`tw-t0` 哈希、`site-box`）；h1 阈值从建议 28px 按实测定为 24px 的决策过程 | 全文完成（5454 字符），未入库 |

入库前按「每篇发文流程」第 6 条补 2 条旧文回链；文中 7 条内链有 3 条指向存稿（`crlf-sri-ci-red` / `theme-transition-class` / `workers-blog-pillar`），排期必须晚于这三篇上线。不占 2027-02-03 之前的坑位，节奏仍按「产能警告」执行。

### 已做完但没写出来的六篇（2026-11-23 完成，未入库）

按「做完了没落字」的顺位补齐。素材全部来自已发生的事：CI 断言、对比度修复、审核边界、SVG 沙箱实现、渲染器Still成立的缺陷、旧提交独立 Worker 对照。每篇都带可复现条件、真实数字与「明说的没做」三样，结构与 STYLE.md 一致。

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `ci-assertions` | 把断言装进 CI：从结构化数据自指到样式回归 | 工程实录 | `语义断言 怎么写` / `基线 只写不fail` | 8 段自指→0；断错误形状而非期望值；基线只写不 fail；549 拆成冷启动 370 + 排队 96，CPU 两版 5/5/6/7 vs 5/6/7/9 一毫秒没省；三层按成本排序（体积 37626→上限 39000 / DOM 9 条正则 / 对比度 126 比值最小 4.51）；`P-002`~`P-005` 7 条已生效。全文完成（11090 字符），未入库 |
| `contrast-assert` | 对比度断言：30 行脚本替你盯住黑白灰 | log | `对比度 自动检查` / `wcag 对比度 脚本` | 6 套主题×明暗=14 组、9 对角色=126 比值；修前 12 组 `--muted` 落在 4.16~4.49；按选择器块分主题而非全局表 |
| `fourth-layer-data-plane` | 评论区防滥用的第四层：发出来也白发 | 小工具 | `评论区 邮箱防采集` / `api 字段脱敏` | 按成本排序的第四层在响应出口而非请求入口；一次对象解构零成本；`email`/`ip` 根本不进响应 |
| `svg-sandbox-implementation` | SVG 沙箱实现：响应头之下的三个判断 | 小工具 | `svg xss 沙箱` / `content-security-policy sandbox` | content-type 与扩展名取并集；自家占位图也走同一条 CSP；被拒类型单独出口带 `x-img-type` |
| `nul-placeholder-collision` | 渲染器的 NUL 占位符：重复显示自己的代码块 | 工程实录 | `markdown 占位符 冲突` / `nul 字符 xss` | 真实复现：一段代码块+一行 `\u0000CB0\u0000` → 出现 2 次；危害上限与三个升级条件；同名锚点已修的对照 |
| `independent-worker-ab` | 一次迁移：把旧提交部署成独立 Worker 做对照 | 站务 | `workers a b 测试` / `性能优化 对照实验` | `git worktree` 父提交 + 改名的 worker 同绑一个 D1；两个 tail 交替发 10 轮；180→84ms、CPU 两版都是 5~9ms |

这六篇与 `css-minimal-set-tradeoffs` 同批，都是「先做事、后落字」的实录，不占 2027-02-03 之前的坑位。数字索引页 `/numbers` 已把这六篇里的关键数字登记进 `src/numbers.js`，未上线的 slug 在 `PENDING_SLUGS` 里标记、线上核对脚本会自动跳过。

### 对比文：Rin 与自研站（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `rin-vs-selfhosted` | 同一套 Cloudflare 全家桶，两种极端：Rin 与我自研站的三处分野 | 工程实录 | `rin cloudflare 博客` / `cloudflare workers 博客 对比` | 运行时依赖 15+42 vs 0；Rin 后端是 **Hono 不是 Elysia**（别家资料写错过）；配置优先级「设置页 > 环境变量 > 默认值」可抄、首注册即管理员 + `admin/admin123` 默认凭据不可抄；友链三态是 `0 网络层没通 / 1 2xx-3xx / 2 有响应但异常`，403 落 2 不落 0 |

**来源全部为公开文件，未部署运行 Rin**：README、根/`server`/`client` 三份 `package.json`、`.env.example`、GitHub API（3151 star @2026-11-23）。正文「明说的没做」已列六条边界，含"没做性能对比"和"star 是快照"。**发布时若 Rin 已改版，先复核这五个文件再发。**

### 扩展性那篇：只抄了一条断言（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `route-boundaries-from-rin` | 抄 Rin 的结构，最后只抄成了一条断言 | 站务 | `cloudflare workers 路由 分层` / `路由边界 测试` | Rin 的 `route-boundaries.test.ts` **2689 B 比实现 2442 B 还大**；`services/` 装的是横切能力不是功能（`features/` 只有一个 `feed/repository.ts`）；sanitize 在 **client** 不在 server，服务端方向是 MD→HTML；v0.2.0→v0.3.0 隔 **21 个月**，不算快变期 |
| `cache-invalidation-two-ways` | 缓存清不掉的两种写法：Rin 能 deletePrefix，我只能枚举 | 工程实录 | `cloudflare cache api 缓存 失效` / `cache busting` | `bust()` 漏 tag/series/`/series` 三类；`/?page=2` 与 `/` 是两条键、`caches.default` 无 list/deletePrefix；Rin 的 `deletePrefix` 靠 SQL `LIKE`（database）或全量 JSON 重传（s3，`supportsPartialAccess=false`）；Rin 缓存 `cache.enabled` **默认 false** |

**这篇带代码改动**：新增 `scripts/test-route-boundaries.mjs`（RB-01~RB-06，已进 `npm test` 链），`tagHasLivePosts()` 抽到 `api.js`，`route()` 111→105 行、分发器内 SQL 归零。失败分支验过（注入重复路由 → RB-04 exit 1；注入未登记路由 → RB-01 exit 1），本地 Worker 打过 7 条路径行为不变。**发布前若 `route()` 再重构，先跑 `node scripts/test-route-boundaries.mjs` 确认六条还绿。**

**缓存这篇带代码改动**：`bust()` 加 `db` 参数 + 枚举全量 tags/series（一次发布 8→30 条 delete），`bust()` 改 async 且 9 处调用全补 `.catch`，`cacheable` 加 `!url.search`，`harden()` 加 `search` 参数并把带 query 的页面两层都设 `no-store`。新增 `scripts/test-cache-bust.mjs`（CB-01~CB-09，已进 `npm test` 链）。失败分支验过（`!url.search` 改 `true` → CB-04 exit 1；删 tag 枚举 → CB-02 exit 1），本地 Worker 实测 7 条路径缓存头 + 5 个中文/含空格键逐字符一致。**改缓存逻辑后先跑 `node scripts/test-cache-bust.mjs`。**

### 安全对比：四条判断，一条反了（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `security-layers-stocktake` | 我以为我没有权限层：一次安全对比里被推翻的四条判断 | 工程实录 | `workers 安全 纵深` / `turnstile hostname 校验` | 本站**有** users 表 / is_admin / 30 天 JWT，且 `isFirst ? 1 : 0` 与 Rin 同款（材料说「你没有权限层」是错的）；线上 2 行用户实测；`payload.admin` 无读取点所以权限以 DB 为准、撤权即时生效；请求体闸门 1MB 流读 73728 字节即断流（7.2%）；Turnstile hostname/action 严格相等、缺字段即拒 |

**这篇带代码改动**（四处）：

1. `src/utils.js` 新增 `bodyTooLarge()` / `readJsonLimited()` / `BODY_LIMIT_JSON`；`src/api.js` 入口按路由分档（64KB / 1MB / 8MB），`/comments` 与 `src/stats.js` 的 `/pv`、`/ev` 改走流式读取。
2. `src/antispam.js` 的 `verifyTurnstile()` 新增 `expect.host` / `expect.action` 严格核对；`src/api.js` 传 `siteOrigin()` 的 host；`public/post.html` 的 `turnstile.render` 补 `action: 'comment'`（**public 改动已重签 SRI**）。
3. `DEPLOY.md` 第 6 节：边缘 WAF 速率限制清单（未开，仅为配置说明）。
4. `DEPLOY.md` 第 7 节：被入侵后的存量清理五步。

新增 `scripts/test-body-limit.mjs`（BL-01~BL-13，已进 `npm test` 链）。失败分支验过：把 `readJsonLimited` 换回 `request.json()` → BL-04 exit 1；把 hostname 比较改成「有就比」→ BL-12 exit 1。

**材料口径**：材料称「本站没有 JWT / 没有权限表 / CSP 两边都没强调」，三条均与代码不符，正文已逐条用代码与线上头反证。Rin 侧细节（`setup.ts`、`permission` 0/1、`.env.example` 明文）未独立复核，按材料引用。

**同日第二轮（按收益/成本清单对账后追加）**：

1. `src/api.js` 新增 `readonlyMode()` + 入口前置 503（写方法挡、读放行、判定早于鉴权）。
   `scripts/test-readonly.mjs` RO-01~06，已进 `npm test`，输出 `[P-018]`。
2. `scripts/test-md-guard.mjs`：把 `md.js` 复制出来做单点变异（`esc` 换恒等 → 红 7 条；
   `safeUrl` 拆白名单 → 红 3 条），外加 `s = esc(s);` 早于 `IMG_RE`/`LINK_RE` 的位置断言
   （删掉该行 → 对照组红 6 条）。输出 `[P-019]`，已进 `npm test`。
3. `test-security.mjs` 补 `[P-020]`：Turnstile 开启时 `script-src`/`connect-src`/`frame-src`
   三处必须放行、关闭时零放行、`script-src` 不许 `unsafe-*`（`style-src` 内联是已知债务，单独断言）。
4. `PITFALLS.md` 新增 P-018/P-019/P-020（**P-009/P-010 已被 CRLF/SRI 与 103 preload 占用**，
   清单里要求的那两个编号只能顺延）。对账 20 条全绿。
5. `DEPLOY.md` 新增「应急只读开关（READONLY_MODE）」一节。

**清单里按取舍不做的三条**：蜜罐改 200 假成功（与 11 号文立场冲突）；去掉
`style-src 'unsafe-inline'`（Markdown `style` 属性依赖，`clean.js` 已用白名单收窄到 `text-align`）；
`Content-Type` 校验（客户端 fetch 未必设该头，要先统一全部调用方）。

**待办（本篇识别、未修）**：普通用户（任何 GitHub 账号登录即成）可无限制调 `/upload` 写 R2、调 `/posts/:id/summary` 烧 AI。修之前先定「普通用户该不该有上传权」——该收权限，不是加计数。

### 权限结构：只摘两样，不继承（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `rin-permission-model` | 管理员席位先到先得：从 Rin 的权限模型里只摘两样东西 | 工程实录 | `workers 权限 中间件` / `github oauth 白名单` | 材料建议的四步里**第一步早已投产**（`is_private`+`hidden` 双布尔比单 `visibility` 更细，线上 37/2/1 分布实测）；材料说「权限校验散落在 handler」只说对一半——`requireAdmin` 23 处调用同一实现，真正散落的是资源级判定 **8 处两种写法**；材料建议的「不建用户表不签 JWT」**已错过**（users 表 + 30 天 JWT 在线上）；`isFirst ? 1 : 0` 硬伤已改 |

**这篇带代码改动**（三处）：

1. `src/auth.js` 新增 `admitPolicy()` / `decideAccess()` / `ownerOrAdmin()`。准入判定前移到 `INSERT INTO users` 之前；`ALLOWED_LOGINS` 白名单、`ADMIN_LOGINS` 指定管理员（每次登录同步回库，撤权不用换 `SESSION_SECRET`）；都不配 = 旧行为。
2. `src/api.js` 7 处 + `src/index.js` 1 处资源级判定改为 `ownerOrAdmin()`，裸写的 `author_id !== … is_admin` 归零。
3. `DEPLOY.md` 新增「准入白名单」一节。

新增 `scripts/test-auth-policy.mjs`（AP-01~15，`[P-021]`，已进 `npm test`）。三次注入均验过：`INSERT` 回退 `isFirst ?` → AP-13 红；拒绝段挪到建行之后 → AP-14 红；一处置回裸判定 → AP-15 红。

**材料口径**：材料称 Rin 用「Elysia/Hono 中间件」——实为 Hono（`^4.12.2`），本身就不确定；`services/user.ts` 首登录判定、`permission` 0/1、v0.2.0 破坏性变更均按材料引用未独立复核。

**明说的没做**：角色表 / ACL；入口与 handler 的 `users` 双查（2 次 D1 往返）未优化；白名单无线上演练（与 `READONLY_MODE` 同属「越过 HTTP 边界的那层靠推理」的系统性盲区）；`ALLOWED_LOGINS` 默认不配，等于没改。

### 登录是唯一能打出站请求的入口，而它没有限流（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `login-rate-limit` | 登录是唯一能打出站请求的入口，而它没有限流 | 工程实录 | `cloudflare ratelimits per colo` / `x-forwarded-for 限流绕过` / `oauth 回调限流` | **材料那行 fail closed 是 fail open**（`c.env.ENVIRONMENT === 'production'` 依赖一个可能不存在的变量，本站就没有）；CF 文档原文 `in a single Cloudflare location` + `Requests can exceed this threshold`；`/X-Cache/.test(resHint.headers)` 对 `Headers` 对象恒为 `[object Headers]`；**P-014 编号已被 image key gate 占用**；**文章 HTML 走 no-store 会废掉全部边缘缓存**（本站 nonce + s-maxage=300 并存的前提是「可缓存页面零反射面」）；全站入口按「能否触发对外请求」排表，登录是唯一裸的那个 |

**这篇带一处生产修复 + 十条新断言**：

1. `src/auth.js`：`loginRedirect` 与 `handleCallback` 各接一道限流。回调的计数卡在 `state` 校验之后、第一次 `fetch` 之前——垃圾请求不耗额度，但要打 GitHub 就必须计数。
2. `src/antispam.js`：新增 `guardLogin` / `recordLogin` / `LOGIN_DAY_MAX=60`，复用 `comment_guard` 表、key 前缀 `auth:ip:`，**零迁移**。与评论的关键差别：评论的额度在落库成功后记，登录的额度必须在发起尝试时记（每次尝试都有出站成本）。
3. `src/utils.js`：新增 `clientIp()`，唯一取法 `cf-connecting-ip`。
4. `src/stats.js`：删掉 `|| x-forwarded-for` 回退（伪造它 = 每个请求一个新桶）。
5. `scripts/test-login-guard.mjs`：LG-01~10，能测行为就测行为（假 D1 + 假 Request），只有跨函数顺序才退回源码切片。
6. `PITFALLS.md` 新增 P-033，对账 33 条。

**注入验证**：删 `loginRedirect` 限流三行 → `LG-01` 红；`recordLogin` 挪到 token 交换之后 → `LG-02` 红并报出两个下标；`stats.js` 加回 XFF 回退 → `LG-04` 红并报 `stats.js:40`。

**材料口径**：五步里四步在本站无对应物（`/api/tags`、`/api/archive` 当时被我误判为「不存在」，53 篇已更正：两者都在，`/api/archive` 是冷路径、`/api/tags` 是热路径；失效挂写路径早已在做；`[[ratelimits]]` 是 per-colo 软限且需改 wrangler）。错的四处：fail closed 写法（依赖不存在的 `ENVIRONMENT`）、「跨 isolate 计数」（per-colo）、「文章 HTML 走 no-store」（会废掉全部边缘缓存）、`/X-Cache/.test(Headers)`（恒假）。编号 P-014~P-017 全部撞车，顺延 P-033 / LG-01~10。

**明说的没做**：没加 `[[ratelimits]]`（`wrangler.jsonc` 未动）；没引 Hono（`dependencies` 仍为空）；没改文章页缓存策略；没建 KV；没重测首屏；`check-live` 四条仍红（未部署）。

### 目录重排的第二层故障：排除测试目录会造出盲区（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `src-restructure-false-red` | 目录重排的第二层故障：把测试目录排除掉，等于造出一个盲区 | 工程实录 | `递归 扫描 断言 假绿` / `cloudflare caches default s-maxage api` | **材料给的目录结构里七个组件本站不存在**（Hono、Device Flow、JWT iss/aud、KV、Ratelimit binding、vitest、`/api/comment`）；**蜜罐返回值写反了**（材料说 200 假成功，本站 400）；**`public/md.js` 是双端共用**（`public/editor.html` 直接 `import '/md.js'`），搬进 `src/` 浏览器端就 404；`/api/archive` 是冷路径（`window.__ARCH__` 已注入）、`/api/tags` 才是热路径（`/categories` 静态壳）；**假红的终点是加豁免，假绿至少还会让人怀疑** |

**这篇带两处生产修复 + 两条新断言**：

1. `scripts/lib/src-walk.mjs`：新增 `NON_PRODUCT_DIRS`（`__tests__`/`__mocks__`/`__fixtures__`/`test`/`tests`）与 `isNonProduct()`，`srcFiles`/`nativeSrcFiles` 默认排除；`nativeSrcFiles` 的排除逻辑**故意重写一遍**不复用（共用判据函数时写错了两边一起错）。
2. `scripts/test-auth-policy.mjs`：`AP-18` 的子目录覆盖检查跳过非产品目录；新增 `AP-19`，`nonProductLeaks()` 扫产品文件的 `from`/`import()`/`require()`，指向非产品目录即报错 —— 排除制造了盲区，这条守盲区。
3. `src/api.js`：`/api/tags` 从 `json()` 默认的 `no-store` 改为 `pageCacheControl()`（`public, max-age=0, s-maxage=300, swr=86400`），口径复用页面那套不另写数字。
4. `src/api.js`：`bust()` 的 paths 加 `/api/tags`。**必须同一个 commit** —— `/categories` 的 HTML 里没有标签数据，只清那页等于没清。
5. `scripts/test-cache-bust.mjs`：`CB-11` 判据两轮修正 —— 第一版对空集恒真（把 `pageCacheControl()` 删了集合变空，红线自己消失），改写成显式 `EXPECT_CACHED_GETS`；第二版直接比 `path` 会把「已清」判成「没清」（分支里的 path 剥了 `/api` 前缀），补前缀同时把「剥前缀」这个前提也验一遍（`stripApi`）。
6. `PITFALLS.md` 新增 P-034，对账 34 条。

**注入验证**：`src/__tests__/a.spec.js` 里写 `u.id === p.author_id || u.is_admin` → 修前 `17/18`（假红，与真越权在输出里无法区分）；`utils.js` 加 `export { assertOwner } from './__tests__/auth.spec.js'` → `AP-19` 红报 `utils.js:1`；删 bust 里的 `/api/tags` → `CB-11` 红报「缓存了但没清」；删 `pageCacheControl()` → `CB-11` 红报「集合变了：实际 [空]，预期 [/tags]」。

**材料口径**：目录结构按 Hono + Drizzle + KV + vitest 那套写，搬之前要先补齐七个组件。`links/check.ts`「20 分钟一轮」这条是对的（`crons: ["*/20 * * * *"]`）。「feature 之间不许互相 import」与本站冲突 —— 文章详情页同时要标签、系列、相关文章、评论数，材料自己那句「posts/service.ts 暴露查询函数」已经是互相引用了，真正的边界是表所有权不是目录所有权。

**明说的没做**：没迁目录；没引 Hono/KV/vitest；`/api/archive` 不加缓存（冷路径）；`/api/posts` 不加缓存（`?tag=&cat=&q=` 组合无穷、`?q=` 能被刷出无限 key，与 CB-04 同一条理由）；没重测首屏；`check-live` 四条仍红（未部署）。

### 六条断言查了五条：材料把我们自己的 CI 当成了文章（2026-11-24 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `gate-only-covered-the-honest-half` | 六条断言查了五条：材料把我们自己的 CI 当成了文章 | 工程实录 | `content-length 谎报 请求体 上限` / `cloudflare worker request.json 内存` | **六条要求里五条已在 CI**（渲染器顺序哨兵 `escAt<imgAt`、`isPartOf` 自指、`[P-024]` 安全头逐指令、sticky 真机、`/img/` nosniff）；**材料把蜜罐返回值写反了**（说 200，本站 400）；**闸门的判据（`content-length` 是声明）与它保护的动作（读流是事实）不在同一层** → 13 个写分支里 12 个还裸 `request.json()`；**`check-toc-sticky.mjs` 从不在 `npm test` 里**（要浏览器+线上地址），而那条回归只有长文章看得出来，CI 里没有长文章；CSP 第四次被判「没有」，实际 enforcing |

**这篇带一处生产修复 + 三组新断言**：

1. `src/utils.js`：抽出 `readBytesLimited()`（一份按流计数，超限即 `reader.cancel()`），`readJsonLimited()` 与新增的 `readFormLimited()` 都建立在它上面——表单和 JSON 是同一个坑，计数逻辑只写一遍。
2. `src/api.js`：新增 `readBody(request, path, { lenient })` 与 `readForm(request, path)`，内部共用 `bodyCapFor(path)`，返回 `{ body }` / `{ res }`。15 个写入口（站点设置、审核、文章增改、摘要、评论处置×3、封 IP、友链增改、直传签名、发评论、头像、图片上传）全部改走它，裸 `request.json()` / `request.formData()` 清零。
3. `scripts/test-body-limit.mjs`：`BL-14` 元断言（剥注释后扫 `src/*.js`，任何 `request.json()` 即红）、`BL-15` 端到端（`content-length: 3` + 1MB 分块体打 `POST /api/comments`，`env` 无 DB，必须拿到 413 且提前断流）、`BL-16` multipart 同款（2MB 分块、上限 64KB）、`BL-17` 元断言（不许裸 `request.formData()`）。
4. `scripts/test-antispam.mjs`：假 D1 真跑 `handleApi`，蜜罐命中 → 400、零 `INSERT INTO comments`、零 `comment_guard` 访问。跑器改成 `await fn()` 以支持异步用例。
5. `scripts/test-sticky-css.mjs`（新）：`SC-01~04` 守成因（`align-items: stretch` 不许 start / `align-self: stretch` / `top: 86px` + `max-height` + `overflow: auto` / 真机脚本仍在），`SC-05` 变异自检。
6. `PITFALLS.md` 新增 P-037，对账 37 条。

**注入验证**：评论分支改回 `request.json()` → `BL-14`+`BL-15` 双红；上传分支改回 `request.formData()` → `BL-17` 红；蜜罐状态码 `400`→`200` → `test-antispam` 两条红；`style.css` 的 `align-items: stretch`→`start` → `SC-01` 红。四次都还原后复跑全绿。

**材料口径**：材料列的六条断言里，渲染器顺序守护（`test-md-guard.mjs` 的 M1/M2 变异 + 源码顺序哨兵）、`isPartOf` 自指（`test-seo-series.mjs` + `check-ld.mjs`）、安全头（`test-headers.mjs` `[P-024]` 逐指令）、`/img/` nosniff（`test-headers` / `test-svg`）**都已存在**；`/img/` 不发任何出站请求（只读 R2），「拒绝内网」那条真正的位置是 `cron.js` 的 `isBlockedHost()`。三个功能缺口里，评论 Webhook（四平台）与两级回复（`parent_id`）已上线，多文隔离上一轮完成。`visibility` 不加：`published_at`/`is_private`/`review_status`/`hidden` 已把可见性拆成四个正交维度。CSP 是 enforcing，改 Report-Only 是拆防线一周。

**明说的没做**：WAF / Bot Fight Mode 未开（部署 token 无 Firewall 写权限，面板开关，代码绕不过）；没加 `[[ratelimits]]` binding（per-colo 软限，加了要部署才验得了，本轮不部署）；没拆 `features/`（`public/md.js` 双端共用）；没引 sanitize 库 / Hono / KV；没重测首屏；`check-live` 四条仍红（未部署）。

### 缓存键里唯一被请求头决定的，是 host（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `cache-key-host-normalization` | 缓存键里唯一被请求头决定的，是 host | 工程实录 | `cloudflare cache key host header` / `sqlite offset datatype mismatch` | **材料的白名单只解决参数名无限、没解决值域无限**（`page=1..100000` 每个都是合法键）；**本站 `bust` 是精确删除、立刻生效，KV 版本号要 60 秒传播**（对本站是退步）；**本站缓存键的 origin 来自 Host 头**，配了 `SITE_ORIGIN` 但键不认它 → 两个域名两套缓存 + bust 只清一套；**`?page=1e21` 让列表页变成 200 的骨架屏**（SQLite `datatype mismatch` 被 SSR catch 兜成 `data:null`）；**`n \|\| 默认值` 把 `size=0` 与 `size=-5` 分成两种结果** |

**这篇带两处生产修复 + 两组新断言**：

1. `src/index.js`：`route()` 里 url 的 origin 归一化到 `siteOrigin(env, request)`，`edgeGet` / `edgePut` / `bustPaths` / `handleApi` 一次覆盖。此前缓存键跟 Host 头走，自定义域名与 `*.workers.dev` 各存一套、bust 只清一套。
2. `src/utils.js`：`pageParams` 加 `MAX_PAGE = 10000` 上界，`n || 默认值` 改 `Number.isFinite`；`MAX_PAGE` 导出供断言用。
3. `src/index.js`：`listParams` 删掉自己那份 `Math.max(1, parseInt(...))`，改调 `pageParams(url).page`。
4. `scripts/test-cache-bust.mjs`：`CB-12` 看三件事接没接上（url 是否经过 siteOrigin / edgeGet+edgePut 是否吃它 / 有没有第二处直接拿 `request.url` 造键），不看「源码里有没有 siteOrigin」。
5. `scripts/test-query-params.mjs`：`QP-01~05`，行为断言为主（直接调 `pageParams` 验 offset 是安全整数），`QP-05` 是元断言 —— `src/` 里除 `utils.js` 外不许再出现「取 page 再转数字」的形状。
6. `PITFALLS.md` 新增 P-035，对账 35 条。

**注入验证**：`url` 改回 `new URL(request.url)` → `CB-12` 红报「多域名会各存一套」；`MAX_PAGE` 改成 `Number.MAX_SAFE_INTEGER` → `QP-01`+`QP-04` 双红；`index.js` 恢复裸解析 → `QP-05` 红报 `index.js:1579`。

**材料口径**：`Vary: *` 让 `cache.put` 抛错 —— **对**（CF 文档三个抛错条件之一），但「线上 500」半对，取决于有没有 try/catch，本站有。`cache.put/match` 不支持 `stale-while-revalidate` —— **对**，本站仍写 swr 是给 CF 边缘层看的，两层不是一回事。白名单拼键在本站不成立（`page` 无上界时仍能灌满；且 bust 精确删除比 KV 版本号快）。断言 P-026~P-030 全部撞号（本站 P-025 CSP 松紧 / P-026 Cookie 属性 / P-027 CORS / P-028 nonce / P-029 异步假绿 / P-030 只认一种句式），顺延 P-035 / QP-01~05。`c.header` 是 Hono API，本站没有 Hono。

**明说的没做**：没做白名单拼键（`/tag/x?page=2` 仍不进缓存）；没加 `X-Cache`（Worker 只看得到 `caches.default` 一层，加了会误导读成边缘全 MISS）；没加 `Vary`（零 Vary 是当前也是正确状态）；没重测首屏；`check-live` 四条仍红（未部署）。

### 结构重排会让四条断言一起失明（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `structural-refactor-blind-assertions` | 目录一重排，四条断言一起失明——假绿的第三代 | 工程实录 | `readdirSync 递归` / `features 垂直切片` / `cloudflare ratelimits 精度` | **`kodadot/backend-starter` 是 404**，真仓库是 `sadiq-bd/backend-starter`（2★）；依赖**漏了 `jose`**，`features/` 只有 `test-feature` 一个示例；**它的 `cacheHandler` 没有任何失效路径**——`cache()` 只暴露 put/match/delete，全仓库零调用，`CDN_CACHE_TTL` 是 **30 天**；`revalidateCache` 靠 `c.finalized = false` 重跑整条链，有副作用的 handler 会执行两次；CF 文档原文 `Limit: … in a single Cloudflare location. Requests can exceed this threshold.`；`hono/tiny` 实测 **14,209 B minified / 5,984 B gzip**，本站 gzip 99,129 B → **+6.0%** |

**这篇带一套断言改写（P-032），不动运行时**：

1. 新增 `scripts/lib/src-walk.mjs`：`srcFiles` / `srcEntries` / `nativeSrcFiles`（原生 `recursive:true` 的独立第二实现，用来互校）。
2. `scripts/test-auth-policy.mjs`：`AP-15` / `AP-16` 改递归扫描；新增 `AP-18`（扫描结果必须与原生递归逐条相等 + 每个子目录至少有一个 `.js` 进集合）。17 → 18 条。
3. `scripts/test-route-boundaries.mjs`：`RB-03` 改按 basename 匹配（原实现 `new Set(readdirSync(src))` 在拆分后会对所有 owner 报「文件不存在」），同名文件单独出警告。
4. `scripts/test-schema.mjs`：INSERT 列扫描改 `srcEntries`，子目录里的写库代码才在范围内。
5. `PITFALLS.md` 新增 P-032，对账 32 条。

**注入验证**：`src/_probe/evil.js` 放 `user.id === post.author_id || user.is_admin` → 旧写法 **17/17 全绿**（失明实证）；新写法红并报 `_probe/evil.js:2`。同目录放 `INSERT INTO posts (slug, no_such_column_zz)` → 旧写法 11/11 全绿，新写法报 `posts.no_such_column_zz`。删探针 → 18/18、11/11。

**材料口径**：按 `sadiq-bd/backend-starter`（材料未给仓库地址，`kodadot/backend-starter` 404）逐条核过。错的四处：依赖「只有四个」（漏 `jose`）、「features/ 已验证」实际只有一个 test-feature 示例、「cacheHandler 正好对应写路径失效」（它没有失效，30 天等过期）、「hono/tiny 小于 14KB」（是 minified 14,209 B，gzip 5,984 B）。半对一处：`[[ratelimits]]` 确实不占 subrequest，但按 colo 计数且官方写明可超阈值，不能替代全局精确计数。

**明说的没做**：没有按 `features/` 重排目录（只把重排的前提修好，等哪天真拆时 `AP-18` 先红）；`package.json` 的 `dependencies` 仍为空，没引 Hono / Drizzle / Zod / jose；没加 KV；没接 `[[ratelimits]]`；没重测首屏基线；`check-live` 四条仍红（本轮改动同样未部署）。

### 模板性能数字不是你的数字（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `template-perf-numbers` | 模板的 15ms 不是你的 96ms：五个候选里只有一条判断能用 | 工程实录 | `cloudflare northstar 模板` / `durable objects rate limit subrequest` | **Northstar 是个人仓库**（`jroth1111/cloudflare_template`，最后提交 2025-12-19），且带 Tailwind v4，与 3KB CSS 冲突；**「DO 更省 subrequest」是错的**——DO 调用本身就计一次，不占的是 `[[ratelimits]]` binding（per-PoP，10/60 秒窗）；**TinyMCE 顶掉的是编辑器不是渲染器**；材料把 96 当「你的首屏数字」，正好犯了 13 篇正文批判过的「两个实验互相背书」 |

**这篇带一处生产修复 + 一条新断言**：

1. `src/api.js:696`（审核放行）：`bust(url, [p.slug], [], db)` → `[p.category]`。SELECT 补 `category`。投稿放行是它第一次进 `/cat/<栏目>`，此前那页压着 300 秒旧 HTML。
2. `src/api.js:1012`（版本回滚）：→ `[p.category, rev.category]`。回滚会连 `category` 一起改回旧值，新旧两个栏目都得清。
3. `scripts/test-cache-bust.mjs`：新增 `CB-10`，禁止 `bust(url, [<非空>], [])` 形状。9 → 10 条。
4. `PITFALLS.md` 新增 P-031，对账 31 条全绿。

**注入验证**：审核那行改回 `[]` → `CB-10` 红并报 `api.js:698`；改回 → 10/10。

**材料口径**：五候选（SonicJS / flare-stack / Cloudcore / CFBlog / cf-astro-blog-starter / Northstar）逐条对过。错的四条：Northstar「Cloudflare 官方」（个人仓库、近一年未更新、带 Tailwind 4）、DO 省 subrequest、TinyMCE 顶掉渲染器、CSP Report-Only（第三次）。对的四条：模板数字不能当基线、KV 写路径主动失效、首用户即管理员该删、lumi-cms 默认口令（README 原文核实）。「549→96」的引用方式违反 13 篇自身论点。

**明说的没做**：没重测首屏基线（要两次部署 + 双 tail，本轮不做）；KV / DO / Service Binding 一行没加（`wrangler.jsonc` 仍五个绑定）；CSP 没退回 Report-Only；CFBlog 仍未核实；`bust()` 签名未改（先让 CB-10 守形状）；`check-live` 四条仍红。

### 四候选对账：说好的三张权限表只有一列（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `cms-candidates-reconciliation` | 四个 CMS 候选对账：说好的三张权限表，源码里只有一个 role 列 | 工程实录 | `cloudcore cms rbac` / `sonicjs defineplugin` | **Cloudcore 没有 roles/permissions/user_roles 三表**——`src/db/schema.ts` 只有 `cc_users.role` 单列（默认 `'contributor'`）+ `src/types.ts` 的 `PERMISSIONS` 常量表 + `hasPermission(role, action)`；EmDash 仓库在 `emdash-cms/` 不是 `cloudflare/`；**EmDash 的插件 API 也叫 `definePlugin`**，不是 SonicJS 独有；flare-stack 是 **GPL-3.0** 且 README 仍写「首个用户自动成为管理员」；CFBlog「5 级角色」**核实不到** |

**这篇带一处生产修复 + 一套断言改写**：

1. `src/index.js`：`1148` / `1156` 两处内联 `user.id === post.author_id || user.is_admin` → `ownerOrAdmin(user, post)`。**这是上一轮断言漏掉的两处真缺口**，在 SSR 文章详情页（预排闸门 + 审核闸门），线上跑了一整轮。
2. `src/auth.js`：新增 `reviewStatusFor(user)`，收口 `src/api.js` 832 / 922 两处重复三元 `u.is_admin ? 'approved' : 'pending'`。
3. `scripts/test-auth-policy.mjs`：`AP-15` 从「匹配一种字符串」改为**白名单扫描**（遍历 `src/*.js`，逐行找同时含 `.author_id` + `.id|is_admin` + `===|!==` 的行，只有 `auth.js` 允许）；新增 `AP-16`（审核态唯一来源）、`AP-17`（`ownerOrAdmin` null-safe）。16 → 17 条。
4. `PITFALLS.md` 新增 P-030，对账 30 条全绿。

**注入验证**：把 `index.js:1148` 改回旧写法 → 16/17，报 `index.js:1148` 精确行号；改回 → 17/17。按 P-030 自己写的规矩（先看它红再回滚）。

**材料口径**：四候选的 star / license / 权限模型 / 扩展机制逐条对过源码与 README。错的三条：Cloudcore 三表（不存在）、EmDash「官方」（不是 `cloudflare/*`）、CFBlog（查不到）。对的三条：沙箱是分水岭、首用户即管理员该删、只抄约定不搬代码。`visibility` 不加（已有 `published_at` / `is_private` / `review_status` / `hidden` 四开关，加一个必然出非法组合）；`can()` 仍是空壳（只有两种判据）；四表不上（`role` 一列够）。

**明说的没做**：没迁移任何候选的表或数据；`visibility` / `can()` / 四表零改动；Better Auth 没引（自带四张表与现有 `users` 异构）；CFBlog 核实失败；`check-live` 四条仍红（未部署）。

### 假绿：六条断言从来没执行过（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `ghost-green-assertions` | 六条断言一直是绿的，因为它们从来没执行过 | 工程实录 | `node 测试 异步 假绿` / `nonce 共享缓存` | **同步 `t()` 吞掉 async 用例的 rejection → 六条断言在原版与三处注入下全绿**，靠注入才发现；`nonce` 与 `s-maxage=300` 并存是**故意**的，安全性来自「可缓存页面零反射面」（`/tag/<script>` 实测 404 零回显）；`base-uri` 从 `'self'` 收到 `'none'`；材料第四轮给 P-009~P-013，且 `!/x-xss-protection/` 与它自己第 1 步矛盾 |

**这篇带两处代码改动 + 七条新断言**：

1. `src/security.js`：`base-uri 'self'` → `'none'`（全站零 `<base>`，源码与 47 篇正文都查过）。
2. `scripts/test-headers.mjs`：`t()` 改 `async` + 26 处调用改 `await`（**这是本轮最关键的修复**，之前六条 async 用例全部假绿）；新增 `[P-028]` 六条 + `[P-029]` 一条。
3. `PITFALLS.md`：新增 P-028（nonce 与共享缓存）、P-029（异步用例配同步 catch）；P-019 补「第二例」。对账 29 条全绿。

**注入验证（修 `t()` 前后对比）**：搜索页不再 no-store 0→1 红、`applyNonce` 换 nonce 0→1 红、后台去 private 0→1 红、删 `!url.search` 1→1 红。三处「修前 0 FAIL」就是假绿的直接证据。

**材料口径**：多用户三候选（orboro 双表 / Rin 两级 / RBAC 四表）均不适合——**评论匿名，member 表无封禁对象**；`can()` 只有两种动作是空壳；「role 字段自改」不存在（`/me` 只有 GET，无写接口）。CSP 四步里第 2/3 步不适用（enforcing + nonce 早已上线）。`P-009`~`P-013` 第四轮撞号。WAF 仍未开。

**明说的没做**：多用户零改动；nonce 与共享缓存共存不改（改全站 no-store=首屏回源，改 hash=算不出动态内联脚本）；`img-src` 仍多一个 `https:`；`/tag/<任意>` 仍写 60 秒 404 缓存（零回显，但可灌 60 秒窗口）；`check-live` 四条仍红（未部署）。

### 响应头模板：六条里唯一缺的那条值是 0（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `headers-template-reconciliation` | 清单说我完全没有 CSP：六条头逐条打完，只有一条要改 | 工程实录 | `owasp secure headers workers` / `x-xss-protection 0` | 六条头逐条对照 OWASP **四项本站更严**（HSTS 多 `preload`、`script-src` 是 nonce 而非 `'self'`——照抄基线等于降档）；唯一真缺口 `X-XSS-Protection` 该设 **0** 而没设；`Server: cloudflare` **边缘写入，Worker 删不掉**；20 条断言先红后绿（首跑 19/20，红的正是那条），7 处注入全红；`P-009`~`P-012` **第三轮撞号**，顺延 `P-023`~`P-027` |

**这篇带一处代码改动 + 一套新断言**：

1. `src/security.js`：`securityHeaders()` 增加 `h.set('x-xss-protection', '0')`（唯一改动的生产代码）。
2. `scripts/test-headers.mjs`（新建）：`[P-023]`~`[P-027]` 共 20 条，纯函数级，不需要 Worker。7 处注入验证：删 XFO 红 2、Referrer 改 `unsafe-url` 红 1、`object-src` 改 `self` 红 1、X-XSS 改 `1; mode=block` 红 2、`script-src` 加 `unsafe-inline` 红 1、setCookie 去 HttpOnly 红 1、`base-uri` 改 `*` 红 2。已进 `npm test`。
3. `scripts/check-live.mjs`：补 4 条线上断言（X-XSS 值、XFO、Referrer 非 unsafe-url、CSP `object-src`）。**要部署后才绿**。
4. `PITFALLS.md` 新增 P-023~P-027，对账 27 条全绿。

**材料口径**：清单称「缺 CSP / 唯一能兜住前面全失守的一层你完全没有 / 顺手删 Server」三条与实测不符；`P-009`~`P-012` 已被 CRLF-SRI 与 103-preload 占用；WAF 配额（0/1 规则、10 秒窗口、自定义 5 条）**无法核实**，token 无 Zone 读权限，以后台为准。三个 Workers 侧现成实现未引入（与「不引 sanitize 库」同一理由：把头搬进别人中间件只是换个地方放字符串）。

**明说的没做**：WAF 与 Bot Fight Mode 零开启、零误伤数据；`check-live` 新 4 条现在红（未部署）；`img-src` 多一个 `https:`（外链图，图片型回连通道未关）；`style-src 'unsafe-inline'` 仍在（依赖 Markdown `style` 属性渲染链）。

### 审计清单：8 项里 3 错 3 半对（2026-11-23 完成，未入库）

| slug | 标题 | 栏目 | 目标查询词 | 别处没有的东西 |
|---|---|---|---|---|
| `audit-checklist-reconciliation` | 清单说我没有 CSP：8 项「需复核」里 3 项判断错了 | 工程实录 | `workers csp 响应头` / `img 代理 ssrf` | **CSP 早就有**且是 enforcing（8 条路径逐条实测响应头表）；`/img/` 只读 R2 零 fetch，SSRF 不适用；**本站没有 Device Flow**（清单把文章主题当功能），自签 token 是 2 段无 header → 无 `alg:none` 面；限流**累加原子但判定不原子**（P-022）；蜜罐返回 400 不是 403 |

**这篇只改断言，不改业务代码**（查完发现代码本身无需改）：

1. `scripts/test-md-guard.mjs`：编辑器预览入口 `renderMarkdown` 单独跑 27 条探针 + 变异体上也要红 + 源码守「不许第二个渲染器」。
2. `scripts/test-comment-ssr.mjs`：三条——`post.html` 必须 import 而非复制 `safeWebsite`、`renderCmt` 的 href/正文、后台待审页不出现 `c.website`。
3. `scripts/test-antispam.mjs`：`[P-022]` 锁「guard 只读、record 才累加」这个事实。
4. `PITFALLS.md` 新增 P-022。

七处注入全验过（预览换 `marked`、暗插 `marked`、跳过 `safeWebsite`、复制 `safeWebsite`）。

**材料口径**：清单称「缺 CSP」「`/img/` 有 SSRF」「有 Device Flow 要查 device_code」三条均不成立；「渲染器顺序守护缺失」「评论字段协议校验」「D1 原子递增」三条半对。Rin 侧 7 项全部按材料引用未复核。

**明说的没做**：不改限流判定原子性（会误伤填错邮箱的真人）；不给预览加 sanitize；无真实并发压测（P-022 的 10N 是推理）；响应头只测 8 条路径。

### 收尾两篇（已写完入库，12-19 / 12-21）

两篇来自 11-20 收尾的第二档交互优化，都是 tools：代码能直接拖走跑，素材是本机实测，不是凑坑位。按 2 天一篇接在 12-17 `csp-nonce-cache` 之后，12-19 / 12-21。`scripts/seed-27-28.mjs` 已带 `published_at`（UTC 01:00）入库，与其余存稿同口径，不靠 automation 改 hidden。

| 日期 | slug（工作名） | 标题 | 栏目 | 目标查询词 | 状态 |
|---|---|---|---|---|---|
| 12-19 | `lightbox-no-deps` | 无第三方库的图片灯箱：CSP nonce、SSR 不动、R2 原链路四条约束怎么同时守住 | **小工具** | `原生 js 图片灯箱` / `csp lightbox` | 待写 |
| 12-21 | `theme-transition-class` | 主题切换只闪一下：临时 class + transitionend 兜底，为什么常驻 transition 会闪首屏 | **小工具** | `主题切换 平滑过渡` / `transitionend 不触发` | 待写 |

两篇的「别处没有的东西」：

- **Lightbox**：14 项 Puppeteer 交互实测（桌面 / 移动端上滑 / ESC / 降噪模式），线上核验 ETag/304 与 SSR 输出零变化、CSS/JS md5 与本地一致；以及否决 `data-light` 标记的取舍过程（改 md.js = 全量回填，与「SSR 零改动」红线冲突）。
- **主题过渡**：常驻 `body { transition }` 闪首屏的成因；transitionend 在按需加载主题 CSS、前后同色时不触发的实测；400ms 定时兜底 + 连续切换撤旧监听的必要性；`prefers-reduced-motion` 硬开关。

写作时把「无头 Chrome 默认 `prefers-reduced-motion: reduce`，导致过渡测试误判」也写进去——这是「现象像 A、根因在 B」的形态，和 11-13 那篇同类，搜索价值高。

### 这批稿子的数据来源

- **11-25 三层缓存**：对 `exia.de5.net` 实测响应头（`CF-Cache-Status`、`Age`、`cache-control`），五个路径各打三次。
- **12-16 CORS**：临时 Worker + Chrome headless，服务端计 `OPTIONS` 次数，四种间隔组合。关键数据：带 `Max-Age:600` 时 7 秒间隔三次只预检 1 次；不带时 3 次；4.2 秒间隔 2 次（推出 Chrome 默认窗口约 5 秒）。
- **01-13 存储延迟**：临时 Worker 绑同一个 D1/R2/新建 KV，每项 120 次调用取 p50/p95。关键数据：D1 连 `SELECT 1` 都是 44.4ms，四类查询差 <1.5ms；KV 命中 3.6ms、未命中 265.4ms；KV 写 560.4ms；R2 读 76.2ms。
- **01-06 免费额度**：官方限额（2026-11 查证）+ 本站 `cpuTime` 实测，所有换算写出算式，没做过的（如 1MB JSON 解析）明确标「推断」。
- **12-02 JWT**：对本站 `verifyToken` 真跑五枚畸形 token，四格放行、一格拒绝，脚本在 `scripts/jwt-probe.mjs`。
- **12-17 CSP nonce**：线上响应头实测——两次请求 nonce 不同；CF HIT 三次 nonce 相同（Age 85/85/86，ETag `"13mm-742d872e"`），绕缓存三次全不同；头 body 配对一致；带 `If-None-Match` 的 304 无 CSP 头。单测在 `scripts/test-security.mjs`（10 条）与 `scripts/test-etag.mjs`（31 条）。
- 采集脚本与原始数据留在 `bench/` 和 `content/bench-data.md`，Worker 与 KV 命名空间已删除。


11-09~11-10 这三篇（编辑器自动保存 / 实时预览渲染器 / R2 图片链路）是编辑器和媒体链路的一组，实际是**两天连着发完的**——违反「宁可每周 1 篇，不要攒几篇一次发完」，已记一次。后续按周三节奏回正。

11-11 评论防滥用是「编辑器 + 交互链路」的收口。11-13 那篇换栏目换题材：不写工具，写一次**误判过程**——目录不跟着滚，第一反应是查 sticky 语法，实际错在 grid 的 `align-items`。这一类（现象像 A、根因在 B）是本栏目最值钱的形态，因为它能被搜索到，也能被抄走。

11-18 那篇是本月唯一的 A 类（性能归因）：标题里的 549→96 跨了两个实验（冷启动转热 + 串行改并发），正文把这两块钱拆开——549→180 是 isolate 预热，180→84 才是代码改动，剩下 84→4 是缓存命中。这类"打脸自己标题"的写法比单纯报喜更耐读，也顺手把「怎么判断一页该有几次往返」写成了可复用的方法。

**11-13 是补发，不是新节奏**：11-11 那篇之后本周还差一篇，周五补上，下周回到周三。发布用定时任务，正文提前入库但 `hidden=1`（不进列表/RSS/sitemap、带 noindex），周五 09:00 改 `hidden=0`。

OAuth 系列四篇共用系列名「OAuth 授权流程拆解」，`series_order` 1~4。互链有三层：文章页自动生成的系列目录（含 `rel=prev/next`）、正文里的上下文链接、首页与 `/cat/teardown` 的列表。四篇合计覆盖 `oauth device flow` / `pkce` / `authorization code` / `token 过期` 四组搜索词，是站内第一个完整互链网。

「Cloudflare 踩坑对照」系列四篇：D1 那篇 1/4（正文补了指向另三篇的链接），deploy 对照 2/4、跨请求 I/O 3/4、subrequest 限额 4/4。四篇都是 B 类报错对照，天然互相引用，且第 2、3 篇的「部署成功但线上 500」直接引第 1 篇。系列里每篇都是**可持续追加**的活文档：以后每踩一个新坑就往对照表里加一条，`updated_at` 变化即真实更新，不算刷 lastmod。

第 4 篇的数据是当场实测的（Worker 上加临时探针，测完删除）：串行 45 次成功、51 次抛错、200 次停在 50；并发 200 次同样停在 50 但只用 184ms；加 `cacheEverything` 不减计数；D1 查询 800 次不占该配额。这类**自己账号上跑出来的数字**是这个系列唯一不可替代的东西，别处抄不到。


## 小工具栏目：首篇已发，后面还有存货

`tools` 是四个栏目里最后补上的（11-09 发首篇）。这个栏目的定位很明确：**文章本身就是交付物，读者能直接把代码拖走跑**。和「工程实录」的区别是——实录写"我踩了什么坑"，小工具写"这东西怎么用，坑在哪"，代码是完整可运行的，不是片段。

首篇《用 Worker Cron 做友链存活检测》选它的理由：功能就在本站跑着（`/friends` 页面上那三个点），是活的 demo，不是截图；而且它天然带一组实测数字（50 次 fetch 上限、串行 2026ms vs 并发 332ms、403/530/522 三个反直觉状态），有别的站抄不走的东西。

后续存货，按"自己真用得上"排序：

| 候选 | 触发条件 | 为什么值得写 |
|---|---|---|
| 正文回链检查器 | 友链超过 20 条 | 现在是"站点可达"，不是"还链着我"。拉正文找自己的域名，做法与 cron 那篇共享一半代码 |
| 图片批处理（WebP + 尺寸） | 再攒 10 张图 | 编辑器里已经有 `toWebp()`，但批量处理历史图那套只在本机跑过，没沉淀成脚本 |
| D1 备份到 R2 | 数据超过 5MB | `wrangler d1 export` 之外没有现成方案，SQLite 快照 + 定时上传能写成通用工具 |
| 站点巡检脚本 | 每加一个新路由 | 现在靠手敲 curl 清单，该固化成 `scripts/smoke.mjs`（已有 perf-audit 打底） |

不写没有真实使用场景的工具——这个栏目最容易变成"为了填坑位造工具"，那样代码质量会立刻掉下来。

## 排期（周三发，12 月起每月末留空档周）

**本表已执行完毕**：W2~W10 的稿子全部写完并入库，实际发布日期与状态以上面「已写好并入库」那张表为准。与原计划的差异只有一处——「认证边界」实际是 4 篇（JWT / SameSite / CORS 预检 / Turnstile），没有第五篇；12-30 的空档周保留，所以 12-23 到 01-06 之间有 13 天间隔，这是刻意的。

11-08 已提前补一篇（踩坑系列 4/4，subrequest 限额）填上 11-03 到 11-11 之间的空档，11-11 那篇照旧发，不往后推。

| 周 | 日期 | 标题（工作名） | 栏目 | 系列 | 目标查询词 | 备注 |
|---|---|---|---|---|---|---|
| W1 | 11-11 | ~~自建博客实录 1/3：Markdown 渲染与白名单~~ **作废** | 工程实录 | — | — | **与 11-10 已发的 `editor-markdown-xss` 撞题**：那篇把三道闸（转义/占位/白名单）、27 条探针、`![ #tag ](/a.png)` 的 alt 注入全写了。草稿 `content/05-blog-markdown-xss.md` 不再发布，留作素材库。11-11 当日不发新稿——11-09~11-10 已连发 3 篇，再发就是第 4 篇 |
| W2 | 11-18 | **已改题**：Worker 渲染 549→96ms 的归因（预热/并发/缓存三块拆开） | 工程实录 | — | `d1 查询并发` / `workers 渲染慢` | 用户给的六选一里排第一。做法：把并发改造的父提交部署成独立 Worker，两个 `wrangler tail` 同时抓、请求交替发，拿到同库同机房的干净 A/B |
| W3 | 11-25 | 三层缓存怎么排，才不会被 CF 改写成 4 小时 | 工程实录 | — | `cloudflare html cache-control` / `s-maxage html` | 11-18 那篇已经把 `s-maxage` 与 `swr` 的分工写掉了，W3 收窄成"zone 的 Browser Cache TTL 把 HTML 压 4 小时"+ 两层缓存口径不一致（`edgePut` 写副本时丢 `swr`）|
| — | 12-30 | **空档周：不出新稿** | — | — | — | 做 12 月实验采集（免费额度压测 / 三存储延迟）+ 旧文实质更新 2 篇 |
| W4 | 12-02 | JWT 的 exp 校验到底发生在哪一层 | 协议拆解 | **认证边界 1/5** | `jwt exp 校验` / `jwt 过期 在哪校验` | 纯机制，无需实测。开新系列：从「凭证怎么被验证」切入，与 OAuth 系列互补不重叠（OAuth 讲"怎么拿到 token"，这一系列讲"拿到之后怎么被信任"）|
| W5 | 12-09 | 浏览器 SameSite 三种取值的真实行为差异 | 协议拆解 | 认证边界 2/5 | `samesite lax strict none 区别` | **需实测**：三个独立域名 + 三种取值跑一遍 |
| W6 | 12-16 | CORS 预检到底发了几个请求：OPTIONS 的真实成本 | 协议拆解 | 认证边界 3/5 | `cors 预检 几次请求` / `options 预检 缓存` | **需实测**：`Access-Control-Max-Age` 缺失时的重复预检，用 Worker 日志数 OPTIONS 次数。这条与 11-18 那篇的"数真实往返"是同一套方法 |
| W7 | 12-23 | Turnstile 拦住了什么、没拦住什么 | 协议拆解 | 认证边界 4/5 | `turnstile 绕过` / `turnstile 原理` | **需实测**：脚本试探，只写观察不写结论外的猜测。与 11-11 评论防滥用那篇互为引用 |
| W8 | 01-06 | Workers 免费额度实测：一天到底能跑多少请求 | 工程实录 | — | `workers 免费额度` / `workers 每日请求限制` | **需实测**：脚本压一天，出曲线。跨年空档周采集的数据在这里成稿 |
| W9 | 01-13 | D1 vs KV vs R2 读写延迟实测 | 工程实录 | — | `d1 延迟` / `kv r2 延迟 对比` | **需实测**：1000 次取 p50/p95 |
| W10 | 01-20 | Cloudflare Workers 建站全流程（pillar） | site | — | `cloudflare workers 搭建博客` | **汇总页**，不写新内容：把前 20 篇按"域名→数据→存储→渲染→缓存→上线"六段挂成目录，每段 2~3 句说明 + 指路。它是站内权重汇聚点，也是唯一会被从头读到尾的页面 |

标「需实测」的四篇，先把采集脚本跑出真数据再写。没有数字就不发——这个站的差异化全在真数据上，编一次就废了。

`crypto.getRandomValues` 报错那篇从排期表降级进 B 类池（随时插队），不占正式坑位——它没有独立的方法论含量，占一个周三不值得。

## 栏目配额：log 4 : teardown 4 : tools 2（每 10 篇）

现在 15 篇的实际比例是 log 53% / tools 33% / teardown 27%，**teardown 明显偏低，log 明显偏高**。往后按 4:4:2 回正，理由：

| 栏目 | 依赖什么 | 产能上限 | 判断 |
|---|---|---|---|
| log 工程实录 | **必须有真实事故素材** | 低——等坑来 | 53% 已透支。B 类报错池 7 条用完后，新增只能靠"制造事故"，那就不再是真事故了 |
| teardown 协议拆解 | **读规范 + 自己实测** | 高——可主动生产 | 唯一不依赖外部素材的栏目，且长尾词最稳（`jwt exp`/`samesite`/`cors 预检` 常年有搜索，不像报错对照是一次性的） |
| tools 小工具 | **必须有真实使用场景** | 低——等需求 | 5 篇已发，4 个候选全部卡在触发条件（友链>20 条、攒 10 张图、数据>5MB、每加路由），短期断供。**不要为填坑位造工具** |

teardown 之所以能上位，不是因为它更好写，而是因为它是唯一**可以计划**的栏目：log 和 tools 都得等事情发生，teardown 只要选定一个机制就能开工。节奏要稳定，主力必须是可以计划的那一个。

> **分发口径（2026-11-21 定）**：原「12-13 Search Console 满月复盘」节点已取消，不再用自然点击数触发停稿/转分发判定。排期按「2 天一篇」推进至 12-21 存稿出清；`content/dist/` 三份外发稿（掘金/V2EX/dev.to）转为独立待命，需要时单独点名发布，不绑定任何数据门槛。

## B 类报错池（成本最低，随时插队）

排期表是下限不是上限：某周没时间写长篇，就从这里挑一条发，20 分钟能成稿，节奏也不断。每条都是独立 URL、独立查询词，发完回头给「Cloudflare 踩坑对照」系列里相关那篇补一条链接。

| 报错 / 现象 | 目标查询词 | 现成的素材 |
|---|---|---|
| `D1_ERROR: too many SQL variables` | `d1 too many sql variables` | 批量插入超过 100 个绑定参数 |
| `Body has already been used` | `body has already been used workers` | `clone()` 与读 body 的先后顺序 |
| `The script will never generate a response` | `script will never generate a response` | 忘记 return / await 悬挂 |
| `Error 1101` / `Error 1102` | `cloudflare error 1101` / `1102` | Worker 抛异常 vs 超资源 |
| `Network connection lost` | `d1 network connection lost` | 长事务、批量写、超时 |
| `env.DB is undefined` | `workers env binding undefined` | 环境里没配 binding（已在 deploy 篇里写了一半） |
| `crypto.getRandomValues` 报错 | `crypto.getRandomValues 报错` | 从正式排期降级到此。`crypto` 在非 secure context（http 访问、Worker 里没开 flag）下直接不存在，报错文本会误导成"方法拼错" |
| Turnstile 一直 `invalid-input-response` | `turnstile invalid-input-response` | 域名白名单、测试 key |

B 类池用掉一条就补一条，它是节奏的保险丝：某周确实没时间，从这里挑一条 20 分钟成稿，比断更或拆稿强。

## 外部分发（Device Flow 那篇优先）

站内优化边际收益已经很低了，现在外链一个顶站内十个。按平台改语气，**别一处多发同一份**：

| 平台 | 形态 | 注意 |
|---|---|---|
| 掘金 | 完整教程转贴，标题改成问题式 | 文末留原文链接，不要放二维码/导流话术，容易被判广告 |
| V2EX（`/go/create` 或 `/go/programming`） | 纯问题讨论帖，正文只讲「我踩到的那个点」，链接放最后当补充 | 直接贴全文会被当成引流，版规上也不受欢迎 |
| dev.to | 英文版，`canonical_url` 指回站内 | 英文站对 canonical 处理干净，不会跟自己抢排名 |
| 知乎 / 少数派 | 暂不做 | 长文平台审核成本高，先跑前三个看回链转化 |

分发前先确认：文章里的示例代码能直接跑、没有本地路径、没有只有作者才懂的上下文（「本站」要改成「我的博客」或直接说具体实现）。

三份稿子已经在 `content/dist/` 里备好（`juejin-device-flow.md` / `v2ex-device-flow.md` / `devto-device-flow.md`），发布顺序和注意事项见 `content/dist/README.md`。贴出去时链接带 `?utm_source=juejin|v2ex|devto&utm_medium=post`，一个月后按来源看回访。


## 每篇发文流程

1. 编辑器选栏目（四选一）、写 1~4 个白名单标签、摘要写结论。
2. 有系列的填「系列 + 第几篇」，文章页会自动出目录与上下篇（同系列 ≥2 篇才显示），系列名可点进 `/series/<名称>`。**没填系列的**，文章底部会退化成「同栏目上一篇/下一篇」，不至于读完没出口——但那只是兜底，不是理由不填。
3. 系列总数在 `/series` 汇总页，每发一篇同系列的旧文会自动多一条入链，也是爬虫回访的入口。
4. 发布 → `updated_at` 变化 → 首页/归档/栏目/系列页缓存自动失效。
5. 当天去 Search Console 对**新文章 URL** 请求一次编入索引，只做一次。
6. 在旧文里补一条指向新文的链接（内链比外链有用）。

## 旧文更新（每季度）

挑阅读最高的 2~3 篇，加实验数据或新报错条目，原 URL 不动。`updated_at` 会自然变化，sitemap 的 `lastmod` 跟着走。

**不要**为了刷 lastmod 去改空格、改标点。被判定为无效 lastmod 之后，整个站点的 lastmod 信号都会被忽略，纯亏。

## 每篇必须做到的三件事（底线，不是建议）

1. **一个具体查询词**，写在 EDITORIAL 表里。是"`d1 too many sql variables`"这种用户真会敲的，不是"Cloudflare 数据库优化"这种。
2. **一个别处没有的东西**：自己的实测数字、自己的报错原文、自己的部署日志、自己数出来的往返次数。四选一，一篇里至少有一个。
3. **回补 2 条内链**：发完当天，在旧文里补指向新文的链接（内链比外链有用，且完全可控）。

第 2 条做不到就别发。这篇会稀释整站质量印象，而全站只有 15 篇，一篇注水就是 7% 的稀释。

## 不做的

- 追热点、搬资讯：衰减后爬虫回访断崖，也和这个站的定位冲突。
- 批量灌水：低质页稀释整站信任，现在每篇都等于整站质量印象。
- 假数据：A 类文章的唯一价值是数字可信。
- **6 个月内不扩技术栈**。现在 15 篇全在 Cloudflare Workers 一个栈上，这是当前唯一能建立的定位——"Workers 建站的中文实录"这个位置几乎没人占。扩到 React/Vue/K8s 会立刻变成又一个普通前端博客，而普通前端博客有十万个。等满 30 篇、自然流量稳定了再判断要不要扩，现在扩是自杀。
- **不为「今天该发点什么」写稿**。每篇动笔前先写死一个目标查询词，写不出来就说明这篇没需求，直接放弃。这条比排期重要：排期是下限，目标词是及格线。

## 待补的站内机制

- 标签体系用起来之后，`/tag/*` 已有 SSR（标题、H1、列表都服务端渲染），无需再改。
- 系列页（`/series/:name`）暂时不做：系列少于 3 篇时是薄内容页，先靠文章内目录互链。

## 后台UI/交互优化池（仅后台、不改动读者侧｜低侵入｜不新增接口、不改D1 Schema）
> 状态：**①~⑧ 全部已完成**（2026-11-22）。守门测试 `scripts/test-admin-ui.mjs`；
> ① 另有真机验收 `npm run verify:editor`：连点只发一次 / 报错可重试 / 手动「发布中…」与自动「保存中…」两条文案都可达。
> 本节保留作变更记录，**不要再按「未启动」排一次工**——2026-11-23 盘点时只看了状态文字没验代码，差点重复造轮子。
> 优先级排序：提交防重复锁 > 表格斑马纹+hover > 内联表单报错 > Markdown预览单向滚动同步
> 约束：仅客户端JS / CSS 改动，复用现有主题CSS变量，不新增色板、不引入外部依赖
### ① 提交防重复锁（/editor，最高优先级）✅ 已完成
目标：防止连续多点保存/发布触发重复写入，前端兜底防护（不替代后端幂等）
改动要点：
- 状态标记 `saving`（落地时用的名字）；点击后按钮置灰、光标改为 `not-allowed`，文案切换：手动 `发布 → 发布中…` / 自动保存 `保存中…`，拦截重复点击
- 请求成功 / 接口报错（500、校验失败）均解锁按钮，恢复原始文案；路由跳转、页面刷新自动清除锁状态
- 不修改 `/api/post` 接口逻辑
验收标准：连续快速点击仅发出一次请求；报错后按钮可正常重试。
### ② 表格斑马纹 + hover高亮（/admin/stats 统计面板）✅ 已完成
目标：提升长数据表格可读性，区分行
改动要点：
- CSS实现，无JS；落地用 `--bg-soft`（斑马纹走 `color-mix`，hover 直接用变量），自动适配亮/暗色主题
- 表头排除斑马纹，仅数据行生效；控制透明度，避免过重干扰阅读
- 范围限定：仅后台统计表格，前台不受影响
验收标准：隔行底色区分；hover行高亮；明暗主题自动适配；空数据行无多余样式。
示例CSS：
```css
.stats-table tr:nth-child(even) {
background-color: var(--bg-subtle);
}
.stats-table tr:hover {
background-color: var(--bg-hover);
}
```
### ③ 内联表单报错（/editor 全部输入项：标题、slug、摘要等）✅ 已完成
目标：替换全局alert弹窗，就近展示校验错误，不打断操作流
改动要点：
- 落地用 `.field-error` 槽位（默认隐藏）+ `var(--red)`；无槽位的老入口回落 toast
- 校验失败：输入框增加细红色边框，下方渲染对应报错文本；自动清理上一轮旧报错
- 客户端校验、服务端返回的报错统一复用这套渲染逻辑
- 仅视图层改造，不新增、不修改后端校验规则
验收标准：报错贴在输入框附近，无弹窗；修正输入后提示自动消失。
### ④ Markdown预览单向滚动同步（/editor，最低优先级）✅ 已完成
目标：编辑源码时对照预览，辅助写作
改动要点：
- 单向同步：编辑区 → 预览区（禁止双向，规避死循环）
- 按滚动比例同步，而非像素对齐（源码行高和渲染内容行高不一致）
- 增加开关「同步滚动」，默认关闭；开关状态持久化在localStorage，不上传后端
- 短内容滚动空间不足时不触发；窗口resize自动重算
验收标准：开启后预览跟随编辑区滚动；关闭后两区独立；刷新页面记住开关偏好。
示例核心JS：
```js
const ratio = editor.scrollTop / (editor.scrollHeight - editor.clientHeight);
preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
```
### 其余候选（同批已完成 ✅：标签去重计数 / 占位文案 / 抽屉淡入 / 空状态文案）
- 标签输入实时去重 + 标签计数：onChange自动去重，右下角展示 `当前数量/上限`
- 输入框占位文案区分必填/可选：slug提示「自动生成，建议英文，不可中文」；摘要提示「可选，用于RSS和预览」
- 抽屉淡入过渡：仅transition opacity .15s ease，不改动布局，规避CLS
- 空状态文案优化：stats无数据、草稿为空，替换生硬「暂无数据」，仅纯文本+字符图标，不加大图
### 统一开工约束
改动文件范围：`editor.html` / `stats.html` / `style.css` + 页面内小段JS；不触碰Worker、D1、前台文章页面。
