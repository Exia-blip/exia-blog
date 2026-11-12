## 结论

这个站是一个跑在单台 Cloudflare Worker 上的博客：没有服务器、没有构建步骤、没有数据库服务器，全部在 Cloudflare 的免费额度内。20 篇文章、一个后台编辑器、一套评论系统，一起塞在同一个 Worker 里。

| 层 | 用什么 | 为什么是它 |
|---|---|---|
| 入口 | Worker + Static Assets | HTML 要服务端渲染，CSS/JS 走静态资源（不吃请求配额） |
| 数据 | D1（SQLite） | 要 JOIN、要事务、要 `ORDER BY`，KV 做不了 |
| 文件 | R2 | 图片只写一次读多次，出网免费 |
| 热点 | Worker 内 `caches.default` + CF 边缘 | 让 1000 个访客只有 1 个打到源站 |
| 内容 | Markdown 存 D1 字段 | 不想为改一个字跑一次构建 |

这套东西的能力上限和成本下限都很清楚：**每天 10 万次 Worker 请求、每次 10ms CPU、50 个 subrequest**。文字博客能一直跑在里面，一旦开始做图片处理或者重计算就会撞墙。

下面是这套架构的完整路径，按「从零到有读者」的顺序排。每一段都指向对应的详文，这里只写取舍。

## 一、从域名到第一个 200

最先撞上的不是代码问题，是部署问题。`wrangler deploy` 的报错文案几乎不说人话——「Authentication error」可能是 token 权限不对，「Script startup timed out」可能是你在模块顶层 `await` 了一个网络请求。

六条最常见的报错，以及它们背后真正的原因，整理在[《wrangler deploy 失败对照》](/p/wrangler-deploy-errors)里。那篇的用法是反着查：**先搜报错原文，再看原因**，不要顺着读。

部署成功之后紧接着是「本地能跑，线上 500」。这类问题八成是同一个原因：在模块作用域里缓存了不该缓存的东西。Worker 的 isolate 会在请求之间复用，但有一些对象绑定了请求上下文，跨请求使用会直接抛 `Cannot perform I/O on behalf of a different request`。这条写在[《Worker 里不能跨请求缓存的东西》](/p/workers-io-different-request)里。

第三个必踩的是 subrequest：一次调用最多 50 个 `fetch`（含 D1、KV、R2 调用）。串行 45 次成功、51 次抛错，这个边界[实测过](/p/workers-subrequest-limit)。

这一段的三篇都是「报错对照」，适合出问题时查，不适合通读。

## 二、数据层：为什么是 D1 而不是 KV

最初想用 KV 存文章，因为「KV 快」。实测之后放弃了这个想法：

| 操作 | p50 | 适用性 |
|---|---|---|
| KV 读（命中） | 3.6ms | 极快，但只对热 key 成立 |
| KV 读（未命中） | 265.4ms | 比 D1 慢 6 倍 |
| D1 任意查询 | 约 44ms | 稳定，不随查询复杂度变化 |

一个博客的文章列表、标签关联、评论、系列排序，全都是关系型查询。KV 只有 `get(key)`，要查「某个标签下的所有文章」得自己维护索引，而且每加一篇文章都要改十几份索引——这个维护成本比 44ms 的延迟贵得多。

完整的实测数据和选型表在[《D1、KV、R2 到底谁快》](/p/d1-kv-r2-latency)。

D1 有一个特性必须提前知道：**它的成本在往返次数上，不在查询复杂度上。** `SELECT 1` 和带 `ORDER BY` 的十行查询，耗时差不到 1ms。所以优化方向不是把 SQL 写得更好，是把多次查询压成一次：

```js
// 5 次串行 await = 5 次往返 = 220ms 的固定成本
// 1 次 Promise.all = 1 次往返窗口
const [post, tags, comments, series, site] = await Promise.all([...]);
```

这个改造把文章页 TTFB 从 127ms 压到 86ms，具体做法见[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)。

建库时第一个坑是 `D1_ERROR: no such table`——它不代表表没建，可能是 `wrangler d1 execute` 连到了本地库而不是远程库。[实录在这](/p/d1-no-such-table)。

## 三、文件与图片：R2 的正确用法

R2 的读延迟 76ms，比 D1 还慢。它的价值不在快，在**出网免费**：10GB 存储、每月 100 万次写入、1000 万次读取，不花钱。图片站用它是划算的，用它做实时读写的缓存是灾难。

本站的图片链路是三段：

| 环节 | 走哪 | 为什么 |
|---|---|---|
| 上传 | 前端拿签名 URL 直传 R2 | 不经过 Worker，避开 279ms 的 PUT 延迟和请求体限制 |
| 读取 | `/img/` 代理 + 边缘缓存 | 只有冷请求付 76ms，之后边缘命中 |
| SVG | 沙箱域名 | SVG 能带脚本，不能和主站同源 |

完整实现（含 `toWebp()` 压缩、尺寸变体）在[《R2 图片链路：上传走直传，读取走代理，svg 走沙箱》](/p/r2-image-pipeline)。

## 四、渲染：SSR 与三支防线

所有页面都是服务端渲染的 HTML，不是前端拿到空 `<div>` 再填。原因有两个：首屏不闪，以及搜索引擎看到的和用户看到的是同一份。

渲染 Markdown 是这个站最危险的一段代码。用户写的内容里可以有 `<script>`、可以有 `javascript:` 链接、可以有 `![ #tag ](/a.png)` 这种借 alt 属性注入的写法。防法不是「过滤危险字符」，是**先转义，再拼装**：整段内容先做 HTML 实体转义，然后把白名单语法（标题、粗体、链接、代码块）从转义后的文本里「挖」出来重新拼成标签。

27 条探针跑下来，这套做法在[《实时预览敢让你敲 `<script>`》](/p/editor-markdown-xss)里有完整代码和用例。

没转义会怎样？第一次撞上去的时候，模板字符串里少写一个 `esc()`，页面直接把 `${esc(p.title)}` 这段源码印了出来——那一刻才知道「模板里看起来像变量」的东西，浏览器只当它是文本。[完整的三支防线和 27 条探针](/p/editor-markdown-xss)。

编辑器的另一个设计是自动保存：停手三秒存草稿，Ctrl+S 立刻存，两套触发共用一条防抖链路。跑在浏览器的 `beforeunload` 和 `visibilitychange` 上，为什么这两个事件都要监听，[那篇](/p/editor-autosave)里有踩坑记录。

## 五、缓存与性能

三层缓存怎么排，是这套架构里最容易配错的部分：

```http
Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

- `max-age=0`：浏览器每次回源校验（用 `ETag` 换 `304`），保证改了字立刻能看到
- `s-maxage=300`：边缘存 5 分钟
- `stale-while-revalidate=86400`：过期后先给旧的、后台刷新，回源延迟不落在用户身上

三个值分别管三层。任何一层配错，症状都不一样：浏览器层被 zone 的 Browser Cache TTL 改写，表现是「所有人都看不到更新」；Worker 内副本和边缘副本口径不一致，表现是「有时秒开有时 300ms」。

[《三层缓存怎么排，才不会被 CF 改写成 4 小时》](/p/three-layer-cache)把三层拆开讲了，包括 `no-transform` 会连带关掉 Brotli 这种反直觉的发现（首页从 8KB 涨回 25KB）。

## 六、上线之后：监控、搜索、评论

**友链巡检**：每 20 分钟一轮，50 个站并发检查。403 不算挂（很多站挡爬虫但活着），530/522 才算。这个任务跑在 Cron Trigger 上，代码在[《用 Worker Cron 做友链存活检测》](/p/worker-cron-friend-check)。

**搜索收录**：`sitemap.xml` 和 `rss.xml` 都是服务端生成的，`lastmod` 用 `updated_at`。这里有一条纪律：**不要为了刷 `lastmod` 改空格和标点**，被判定为无效 `lastmod` 之后，整站的 `lastmod` 信号都会被忽略。

**评论**：三层防线，按成本排序——蜜罐（0 成本，挡住最笨的脚本）、Turnstile（免费，挡住没有浏览器环境的自动化）、D1 限额（挡住通过验证之后的行为滥用）。第三层最重要，因为前两层都过了的「人」依然可能一天发 500 条。[完整实现](/p/comment-anti-spam)、[Turnstile 的边界在哪](/p/turnstile-what-it-blocks)。

**预算**：这些加起来要花多少额度，[《Workers 免费额度到底能撑多少人》](/p/workers-free-tier-limits)做了换算——关键是静态资源不算 Worker 请求，这条让文字站的额度极其宽裕。

## 七、这套架构的代价

写清楚它不适合什么，比写它适合什么有用：

| 限制 | 数值 | 意味着 |
|---|---|---|
| CPU 时间 | 10ms / 请求 | 不能做图片处理、不能解析大 JSON、不能跑复杂模板循环 |
| subrequest | 50 / 请求 | 一次渲染超过 50 次存储调用就会抛错 |
| 同时出站连接 | 6 | 并发查询上限就是 6，第 7 个会排队 |
| D1 单库 | 500MB（免费） | 文字够用很久，存二进制文件会很快见底 |
| D1 并发 | 单库单线程 | 查询排队，写入不能高频 |

如果哪天要加「上传后自动生成三种尺寸的缩略图」，这套就跑不动了——那需要 CPU 或者外部服务。届时的做法是把图片处理挪到 R2 + Cloudflare Images 或者一个独立的容器，Worker 只负责发签名 URL。

## 八、按什么顺序读

不是所有人都有时间读 20 篇。按目的分三条路径：

**想照抄一套能跑的博客** → 依次读：deploy 报错对照 → D1 那篇 → SSR/Markdown 转义 → R2 图片 → 三层缓存。这五篇是骨架，其余是补丁。

**正在踩某个具体的坑** → 直接搜报错原文。`no such table`、`Cannot perform I/O`、`Too many subrequests`、`Body has already been used`、`Error 1101/1102` 都在站内有过记录。

**想理解协议本身** → OAuth 四篇（[Authorization Code](/p/oauth-auth-code)、[PKCE](/p/oauth-pkce)、[Device Flow](/p/oauth-device-flow)、[token 生命周期](/p/oauth-token-lifecycle)）是入口，之后核验系列的 [JWT exp](/p/jwt-exp-verify)、[SameSite](/p/samesite-behavior)、[CORS 预检](/p/cors-preflight-cost)、[Turnstile](/p/turnstile-what-it-blocks)接在后面。

这个页面会随新文章更新，不另开新 URL——它是一份活的目录，不是一篇一次性的文章。
