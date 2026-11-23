# PITFALLS.md — 现象 → 根因 → 断言

规则：每条必须是**已经踩过、已经修了、已经有断言守着**的坑。没断言的不写进来——
写进来只是备忘录，断言才是资产。格式固定为「现象 / 根因 / 断言 / 文章」，
排查时先按现象 grep 本文件，找到再跑对应断言，别重新从代码翻起。

更新方式：踩一个新坑 → 写断言 → 把本文件加一行。断言没落地的不算数。

---

## 现象：本地绿、线上绿、CI 红（integrity 不匹配）

- **根因**：工作区文件 `w/crlf`，git 索引 `i/lf`。`build:sri` 按 CRLF 字节算哈希，
  CI checkout 按 `.gitattributes` 归 LF，同一份文件两套字节。
- **断言**：`scripts/test-sri.mjs`「参与 SRI 的文件都是 LF 行尾」直读磁盘；
  `scripts/build-sri.mjs` 遇 CRLF 直接 `process.exit(1)`。
- **文章**：`content/29-crlf-sri-ci-red.md` → [/p/crlf-sri-ci-red](/p/crlf-sri-ci-red)
- **grep 词**：`CRLF`、`i/lf w/crlf`、`integrity 不匹配`

## 现象：`D1_ERROR: no such table` / `no such column`

- **根因**：不是建表语句错，是**在 A 库建表、在 B 库查询**。`wrangler d1 execute --local`
  改 `.wrangler/state` 的模拟库，`--remote` 才是线上；两个库同名不同物。
- **断言**：`scripts/schema.mjs check` 比对 migrations / schema.sql / 代码 INSERT；
  `scripts/test-schema.mjs` 在 `node:sqlite` 空库重放全部迁移并逐列比对。
- **文章**：`content/01-d1-no-such-table.md` → [/p/d1-no-such-table](/p/d1-no-such-table)
- **grep 词**：`no such table`、`--remote`、`两套库`

## 现象：目录不跟着滚

- **根因**：不是 sticky 写错，是 grid 父容器 `align-items: start` 让侧栏高度塌成内容高，
  没有滚动余量，sticky 无从吸起。
- **断言**：`scripts/check-toc-sticky.mjs` 验 position=sticky、父容器高于视口、
  滚 1200px 后 top 值不漂移（CI `check:browser` 内）。
- **文章**：`content/12-sticky-toc-grid-align-items.md` → [/p/sticky-toc-grid-align-items](/p/sticky-toc-grid-align-items)
- **grep 词**：`sticky`、`align-items`、`tocH`

## 现象：subrequest 数到 50 就停，加缓存也不减

- **根因**：免费计划 subrequest 50 是**请求派发那一刻累计计数**，函数内读不到实时值；
  `cacheEverything` 不减计数，D1 查询不占该配额。并发能把 45 次的时间从 2026ms 压到 184ms，
  但上限不变。
- **断言**：`scripts/test-cron.mjs` 守 `isBlockedHost()` 的 SSRF 闸门与逐跳上限 5；
  `src/cron.js` 注释写明"`PER_RUN=40` 留余量、计数累计、别存游标"。
- **文章**：`content/06-workers-subrequest-limit.md` → [/p/workers-subrequest-limit](/p/workers-subrequest-limit)
- **grep 词**：`subrequest`、`派发那一刻`、`PER_RUN`

## 现象：103 Early Hints 提前下的 CSS 没人用

- **根因**：preload 的 `?v=` 取部署号，HTML href 取内容哈希（ASSET_HASH），
  两个 URL 差一个字符串 = 浏览器当成两个资源，冷访问白下 121KB CSS。
- **断言**：`scripts/check-live.mjs` 逐字符比对「preload 地址与 HTML href 一致」。
- **文章**：`content/30-early-hints-preload-mismatch.md`（存稿）
- **grep 词**：`103`、`preload`、`ASSET_HASH`

## 现象：结构化数据里 `isPartOf` 指向文章自己

- **根因**：`isPartOf` 要的是「这个系列在哪」，填成了「这篇在哪」。
  `position` 也塞错位置——它属于文章节点，不属于系列容器。
- **断言**：`scripts/check-ld.mjs` + `scripts/test-seo-series.mjs` 验系列 URL 与自指不存在。
- **文章**：`content/22-ld-self-reference.md` → [/p/ld-self-reference](/p/ld-self-reference)
- **grep 词**：`isPartOf`、`自指`、`position`

## 现象：投稿通过了还是不显示 / 待审混进首页

- **根因**：审核态复用 `hidden`（作者自控开关），挡不住作者自己；
  且 `timeGateSql()` 与 `liveSql()` 混用会让待审队列永远为空。
- **断言**：`scripts/test-admin-extras.mjs` 守 `review_status` 独立列、两个闸门分层、
  翻转条件；`scripts/test-comment-ssr.mjs` 守评论 `status='approved'` 过滤。
- **文章**：`content/32-review-status-cache-bypass.md`（存稿）
- **grep 词**：`review_status`、`hidden`、`timeGateSql`

## 现象：搜索 `%` / `_` 命中全表

- **根因**：SQL LIKE 的通配符没转义，`%` 匹配一切。
- **断言**：`scripts/test-security.mjs` 搜 `\ % _` 三字符 + 三路 SQL 都带 `ESCAPE '\'`。
- **文章**：`content/25-rss-enclosure-cover.md` 同批的工具链记录；主文在安全修复归档。
- **grep 词**：`searchMatch`、`ESCAPE`、`LIKE`

## 现象：CSS 改了但线上样式没变 / 版本号对不上

- **根因**：`?v=` 是内容哈希，不是部署号。改了 public 下 js/css 忘跑 `build:sri`，
  manifest 与磁盘字节脱节；同源资源加 `crossorigin` 会走 CORS 模式被 Worker 拒绝。
- **断言**：`scripts/test-sri.mjs` 校验 manifest 与磁盘 sha384 一致、同源资源无 crossorigin。
- **grep 词**：`build:sri`、`内容哈希`、`crossorigin`

## 现象：主题切换闪首屏 / transitionend 不触发

- **根因**：常驻 `body { transition }` 首屏就闪；`transitionend` 在按需加载主题 CSS、
  前后同色时根本不触发，不能只靠它摘临时 class。
- **断言**：`scripts/test-ux-l3.mjs` + `npm run verify:editor`；
  `prefers-reduced-motion: reduce` 是第一道硬开关。
- **文章**：`content/28-theme-transition-class.md`（存稿）
- **grep 词**：`theme-transition`、`transitionend`、`reduced-motion`

## 现象：备份 SQL 被公开下载（本轮新增）

- **根因**：备份和图片共用 `blog-images` 桶，`/img/` 代理直取 R2 对象且 key 无白名单，
  `/img/backups/d1.sql` 会把含正文与邮箱的 SQL 当图片吐出来。
- **断言**：`scripts/test-image-key-gate.mjs` 穷举 `backups/` 的大小写、编码、反斜杠绕过；
  `src/index.js` 的 `isPrivateImageKey()` 在 serveImage 入口挡住。
- **文章**：本文件（站务记录，暂无独立文章）
- **grep 词**：`backups`、`isPrivateImageKey`、`/img/`

## 现象：对比度肉眼看着没问题，自动化扣分（本轮新增）

- **根因**：`--muted` 用在 11.5~14.5px 的日期、标签、面包屑，7 套主题 × 明暗里
  有 12 组掉到 4.16~4.49:1。灰阶差一档肉眼几乎看不出，但低于 WCAG AA 4.5。
- **断言**：`scripts/test-contrast.mjs` 解析全部主题变量，14 组组合逐对验 ≥4.5。
- **文章**：本文件 + `content/34-css-minimal-set-tradeoffs.md`（草稿）
- **grep 词**：`contrast`、`--muted`、`4.5`

---

## 每篇长文末尾的「复现条件 + 断言代码」模板

新写工程实录/teardown 时，正文末尾附一段（可折叠或直接列）：

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
