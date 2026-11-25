-- 补内链 → /p/three-layer-cache，由 scripts/patch-crosslinks-25.mjs 生成（2026-11-25 11:55:48）

UPDATE posts SET content = '11-09 那天部署完，我抓到的第一条 `Server-Timing` 是 `cfWorker;dur=549`，同一个版本另一个页面是 `752`。今天同一个栏目页 `/cat/tools`，同样的探针，`84` 到 `96`。

数字没造假，但标题这句话是**不严谨**的。549 和 96 之间隔着两个变量：一个是冷启动转热，一个才是代码改动。把这俩混在一起说"我只改了一件事就把 549 变成 96"，属于拿两个不同实验的结果互相背书。

所以这篇分两半：先把尺子校准，把 549 拆成"冷启动"和"排队"两块钱；再讲那件唯一改对的事——它省下的正好是 96ms，而不是 450ms。

先说结论：

| 阶段 | /cat/tools 的 Worker 执行时间 | 这块是谁的钱 |
|---|---|---|
| 11-09 部署后第一发（冷 isolate + 串行查询） | 549ms | 冷启动 ~370 + 排队 ~96 + 渲染十几毫秒 |
| 同版本，预热之后（串行查询） | 180ms | 全是排队 |
| 改动之后（并发查询） | 84ms | 1 次往返 + 5ms CPU |

真正可以靠写代码省掉的是中间那 96ms。冷启动那块，改代码省不掉。

## 一、先校准尺子：`cfWorker` 是好尺子，但不是一直有

`Server-Timing: cfWorker;dur=549` 这个头不是我们写的，是 Cloudflare 加的，意思是"这一发请求在 Worker 里待了 549 毫秒"。它最接近"渲染耗时"这个概念，所以当时我拿它做记录。

问题是它现在在线上抓不到了：

```bash
curl -s -o /dev/null -D - "https://exia.de5.net/cat/tools?x=$RANDOM" | grep -i server-timing
# 没有输出
```

今天同一台 Worker、同一个 URL，这个头不见了。可能是平台侧策略变了，也可能是压缩/缓存路径上被吃掉了。不管原因是什么，结论是：**别把一次性的观察当成长期监控**。你三个月后想复现，得有个不依赖平台施舍的尺子。

这篇里所有数字都用另外两种尺子量，都能自己跑：

**尺子 A：TTFB 减静态资源地板。** TTFB 里混着网络往返，直接比会掺水。先量一个静态文件的 TTFB（它由边缘直接吐，不含 Worker 逻辑），这一段就是"网络+边缘"的地板，减掉之后剩下的才是 Worker 的时间。

```bash
# 地板：静态资源，边缘直接返回
curl -s -o /dev/null -w "%{time_starttransfer}\n" "https://exia.de5.net/style.css?f=$RANDOM"
# 待测页面，带随机参数强制绕过缓存
curl -s -o /dev/null -w "%{time_starttransfer}\n" "https://exia.de5.net/cat/tools?x=$RANDOM"
```

**尺子 B：`wrangler tail` 的 `wallTime` / `cpuTime`。** 这是 Worker 自己报的账，比任何外部探针都准，而且能把"耗时"和"算力"分开：

```bash
npx wrangler tail --format json
# 每个事件里带 wallTime（墙钟）和 cpuTime（CPU 毫秒）
```

第一次看到这两个数并排出现时，我盯着看了一会儿：

```
/cat/tools   wallTime 84   cpuTime 5
```

一个页面渲染花了 84 毫秒，其中 CPU 只占 5 毫秒。**94% 的时间在等。** 等什么？等数据库。

这不是 Workers 的问题，是任何"请求-响应"式数据库都有的账：你的代码没事干，它只是在等对面把结果送回来。

## 二、一页 HTML 到底要几次数据库往返

在改成并发之前，`/cat/tools` 这一页在 `injectTheme` 里的取数是这样的（这是改动前的代码，我后来把它原样部署成一个独立 Worker 来做对照，见第四节）：

```js
// 改动前：一个 await 接一个 await
const s = await getSite(env);
body = fillSeo(body, s, url);
// ...
const { body: listed, list } = await renderList(env, body, url); // 里面还有三次
body = await renderCats(env, listed);                            // 里面还有两次
```

拆开数一下往返次数：

| 顺序 | 查询 | 干什么 |
|---|---|---|
| 1 | `getSite()` | 读 `settings` 表拿站名、主题、头像 |
| 2 | `SELECT COUNT(*)` | 算这个栏目一共几篇（分页要用） |
| 3 | 主查询 `SELECT p.*, ...` | 取当页 10 篇 |
| 4 | `attachTags()` | 把这 10 篇的标签一次性捞回来 |
| 5 | `catCounts()` | 四个栏目各几篇 |

五次往返，一次接一次。假设单程 30ms，这一页光"等"就是 150ms 起步。

而 `renderCats()` 里还有第六次（标签云），只有 `/categories` 页才走。首页更惨，多了 `pickPosts()` 那一次，五次。

关键在于：**这五次之间没有任何依赖。** count 不需要 post 列表，标签不需要栏目计数，站点设置更不需要等任何东西。它们只是被写在了五个连续的 `await` 后面，于是排队了。

## 三、改法：把"互不依赖"变成"同时发出"

改动就一处，`injectTheme` 的取数部分：

```js
/* 这一页要的三份数据互不依赖：站点设置、文章列表、栏目/标签计数。
   以前是一个 await 接一个，线上冷启动 cfWorker 跑到 500ms+ 大部分耗在这串行上。
   现在先全部发出去，最慢的那条决定总时长。 */
const siteP = getSite(env);
const catsP = body.includes(''<!--CATS-->'') ? catCounts(env) : Promise.resolve(new Map());
const tagsP = body.includes(''<!--TAGS-->'') ? tagsData(env.DB).catch(() => []) : Promise.resolve(null);
// 列表只依赖模板和 URL，不依赖站点设置，所以这里就能先发车
const listP = listQuery(env, url);

const [s, counts, tags] = await Promise.all([siteP, catsP, tagsP]);
```

注意这里是"先拿到 Promise，再在需要的地方 await"，不是 `await Promise.all([...])` 一把梭。区别在于：`s` 要用来拼 `<head>`，`listP` 的结果要等模板替换完才用得上。先把请求发出去，等真需要数据时再 await，中间那段拼字符串的时间就被利用起来了。

`listPosts` 内部还有一层同样的排队：

```js
/* COUNT 和主查询互不依赖，一起发出去。
   以前是先 await COUNT 再 await 列表，冷启动时两个往返叠加，
   等于把 D1 的延迟翻了一倍。 */
const [{ results }, totalRow] = await Promise.all([
  db.prepare(`SELECT p.*, ${AUTHOR_COLS}, ${TAG_AGG}, ... LIMIT ? OFFSET ?`).bind(...args, size, offset).all(),
  db.prepare(`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSql}`).bind(...args).first(),
]);
```

### 这里踩了一个不那么显然的坑

第一版我是直接把 `renderList` 整个塞进 `Promise.all` 的，结果页面渲染出来"上半部分正常，列表区一片空白"。原因不是查询失败，而是**顺序**：

`injectTheme` 是一串字符串替换：先换 `<!--THEME-->`、再换 `site-header`、再换 `<!--LIST-->`。如果 `renderList` 在替换还没发生的时候就把 `body` 复制走，它拿到的是一份半成品，返回时又把前面已经替换好的内容整个盖回去。

所以改成了两半：

- `listQuery(env, url)`：只查数据库，不碰 HTML，所以能和别人一起并发；
- `applyList(body, res)`：纯字符串替换，必须等前面的替换全部做完再跑。

**并发改造的真实难点不是 `Promise.all` 怎么写，是"哪一段是纯取数、哪一段必须按顺序"。** 把有副作用的字符串处理也塞进去，就会出现"能跑但内容是旧的"这种最难查的 bug。

### 标签那一次不是并发，是"少一次"

标签原本是第二次往返：先查 10 篇文章，再用 `post_id IN (?,?,...)` 捞标签。这次直接内联进主查询：

```js
/* 标签用相关子查询一次带出，替代「先查 posts 再 attachTags」的第二次往返。
   char(31) 是 US（unit separator），标签名里不可能出现，拿来当分隔符比逗号安全 —— 标签本身允许逗号。 */
const TAG_AGG = `(SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str`;
const splitTagStr = (s) => (s ? String(s).split(''\u001f'').filter(Boolean) : []);
```

这一条和 `Promise.all` 是两种不同性质的动作，很容易混为一谈：

- `Promise.all`：往返次数不变，但把等待叠在一起了，省的是**时间**；
- 内联子查询：往返次数少了一次，省的是**次数**（顺带也省时间）。

真到了瓶颈，省次数比省时间更值钱——因为次数有天花板。这一点第六节会说。

### 并发不是免费的：每条都要能自己兜住

`Promise.all` 有个特性：任何一条 reject，整体立刻 reject。首页五条查询里只要有一条 SQL 挂了，整个页面 500。所以每条都单独兜：

```js
const tagsP = body.includes(''<!--TAGS-->'') ? tagsData(env.DB).catch(() => []) : Promise.resolve(null);
```

`catCounts` 里有 `try/catch` 返回空 Map，`listQuery` 里有 `try/catch` 返回 `data: null`（然后渲染骨架），`getSite` 里有 `try/catch` 回退到环境变量。**并发写法把"一个查询失败"从"一个区块空白"升级成了"整页白屏"**，兜底必须补在这之前。

## 四、A/B 怎么做的：把旧代码部署成另一个 Worker

只对比"改之前记得的数字"和"改之后现在的数字"是没有说服力的——中间还隔着 3 天、一次 CF 侧变更、几十次部署。

所以做了个真对照：

1. `git worktree add /tmp/blog-old 8e29df2`，检出并发改造的**父提交**；
2. 复制一份 `wrangler.jsonc`，只把 `name` 改成 `exia-blog-perf-old`，去掉 `triggers`（别让两个 Worker 都去跑友链巡检）；
3. `wrangler deploy -c wrangler.perfold.jsonc` —— 独立 Worker，绑同一个 D1、同一份静态资源，**线上流量一点不受影响**；
4. 两个终端同时 `wrangler tail --format json`，然后**交替**发请求：先打旧版一次，再打新版一次，循环 10 轮。

交替发是为了抵消时间漂移（CF 边缘的负载、我这条线路的抖动，都会随时间变）。10 轮下来取中位数：

| 页面 | 串行（旧） | 并发（新） | 差 |
|---|---|---|---|
| `/cat/tools` | 180ms | **84ms** | −96 |
| `/tag/cloudflare` | 207ms | **148ms** | −59 |
| `/archive` | 175ms | 170ms | −5 |
| `/p/comment-anti-spam` | 115ms | 117ms | ±0 |

同一轮里 CPU 时间是：旧版 5、5、6、7ms，新版 5、6、7、9ms。**两版一样。**

这就是这次改动最干净的一句总结：

> 并发没有让任何一行代码变快，CPU 一毫秒都没省。省下来的 96ms，是三次往返的等待被叠到了一起。

TTFB 那边（21 次采样取中位数，减去静态地板）也对得上：

| 页面 | 串行 | 并发 | 差 |
|---|---|---|---|
| 首页 | 200ms（272 − 72） | 80ms（149 − 69） | −120 |
| `/cat/tools` | 168ms（240 − 72） | 66ms（135 − 69） | −102 |
| `/archive` | 189ms | 157ms | −32 |
| 文章页 | 128ms | 111ms | −17 |

首页省得最多（120ms），因为它原本有五次往返要排：站点设置、COUNT、主查询、标签、精选位。

## 五、为什么省下的不是"SQL 时间"

这里有个反直觉的点，值得单独说：**并发查询并不会让 D1 查得更快。**

D1 的文档写得很直白：

> Each individual D1 database is inherently single-threaded, and processes queries one at a time.

单个库是单线程的，查询是一条一条处理的。你并发发五条过去，它们还是排队执行，只是队伍在**对面**排，不在你这边排。

那省下来的 96ms 是什么？是**每条查询的固定开销**——建请求、走网络、序列化结果、回来。这部分是纯等待，跟数据库在不在忙没关系。

所以可以反推单次往返的成本：96ms ÷ 3 次 ≈ **32ms**。再用一个只发一次往返的接口验证：

```bash
curl -s -o /dev/null -w "%{time_starttransfer}\n" "https://exia.de5.net/api/posts?page=1&size=1&z=$RANDOM"
```

`/api/posts` 里是两条并发查询（列表 + COUNT）+ 一点点 JSON 序列化：

```
/api/posts   wallTime 51   cpuTime 2
```

51ms 里 CPU 占 2ms，剩下 49ms 就是"一次往返 + 出结果"。和反推的 32ms 一个量级（这个接口结果集更小、但含 TLS 之后的额外开销），对得上。

**推论：并发数不是越多越好。** D1 每个 Worker 调用最多同时开 6 条连接，超过就排到下一批。把 20 条查询塞进 `Promise.all`，第 7 条开始照样等，只是你看不见。真要压次数，该用的是 `db.batch()`——多条语句一次请求，把"每次请求的固定开销"付一遍。

我们这个站点的量级（一页 5 次往返、16 篇文章）还犯不上上 batch，但知道这条线在哪，比"能并发就并发"有用。

## 六、两个页面纹丝不动，这才是最有信息量的部分

看第四节的表：`/archive` 只省了 5ms，文章页 ±0。

不是并发没用，是**这两个页面压根不在那个 `Promise.all` 里**。那次提交只动了列表页那条链（`renderList` / `renderCats`），归档页和文章页的取数代码一行没改，自然一动不动。

文章页当时的顺序是这样：

```js
const post = await env.DB.prepare(`SELECT p.*, ... WHERE p.slug = ?`).bind(slug).first();      // D1 第 1 次
const tpl = await assetText(env, request, ''/post'');                                            // 模板走 ASSETS，不是 D1
const [{ results: tagRows }, { results: cmtRows }] = await Promise.all([...]);                  // D1 第 2 次，标签与评论已经并发
if (post.series) { /* 系列目录 */ }                                                            // 这篇没有系列归属，不发起
const site = await getSite(env);                                                                // 30 秒进程内缓存，多数请求不落库
```

**我一开始把这段数成了"四次数据库往返"，这是错的。** 数 `await` 不等于数往返：`series` 只有文章属于某个系列时才发，`getSite()` 有 30 秒进程内缓存。对一篇没有系列归属的文章，真实往返是 **2 次**——正文一次，标签与评论一次。

所以 115ms 不是四次排队，是：2 次 D1 往返（按 32ms/次算约 64ms）+ 一次模板读取 + 渲染与响应。

那空间在哪？在**依赖深度**。第 2 次往返之所以不能跟第 1 次合并，是因为要先拿到 `post.id` 才能去查 `post_tags` 和 `comments`。

把关联条件从 id 换成 slug，这几条查询就不再互相等待：

```js
const [post, tagRes, cmtRes, seriesRes, site, tpl] = await Promise.all([
  env.DB.prepare(`... FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`).bind(slug).first(),
  env.DB.prepare(`... JOIN posts p ON p.id = pt.post_id WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`... JOIN posts p ON p.id = c.post_id WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`... WHERE series = (SELECT series FROM posts WHERE slug = ?)`).bind(slug).all(),
  getSite(env),
  assetText(env, request, ''/post''),
]);
```

同一 URL、同样绕开缓存、各取中位：**127ms → 86ms**（p10 79、p90 89）。

这里有个能复用的判断：**并发的单位不是"查询"，是"依赖链"**。同样是这四条 SQL，只把绑定参数的来源从 `post.id` 换成 `slug`，串行就变并行，代码行数几乎没变。

归档页更值得说。它只有两次往返，但照样 170ms，因为第一次查询本身重：

```js
// src/api.js
`SELECT p.*, ${AUTHOR_COLS}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
 FROM posts p ${AUTHOR_JOIN} WHERE ... LIMIT 2000`
```

`p.*` 把正文一起查出来了。这个站当时 14 篇公开文章，正文合计 **79KB**（最长一篇 12KB）。归档页要渲染的只是 14 个标题，却把 79KB 正文全搬了一遍，然后 `attachTags()` 再补一次往返。

改成只取需要的列，阅读时长用 SQL 现算（口径必须和 `readingTime()` 一致，否则归档显示 26 分钟、文章页显示 24 分钟）：

```sql
SELECT p.id, p.slug, p.title, p.summary, p.cover, p.category, p.published_at, p.created_at,
       length(replace(replace(replace(replace(COALESCE(p.content,''''), char(32), ''''), char(10), ''''), char(13), ''''), char(9), '''')) AS content_len
FROM posts p ...
```

实测 **175ms → 159ms**。省得不算多，因为它本来就只有两次往返，减掉的是一次查询里的传输量而不是一次排队。

两条结论：

1. **并发的收益 = 被并发的次数 × 单次往返成本。** 没有 await 可叠的页面，改多少 `Promise.all` 都是 0。
2. **单条慢查询不会因为并发变快。** 归档页 170ms 里能靠并发省的只有一次，剩下的大头是搬了 79KB 不该搬的数据，只能改 SQL。

上面这两处都是后来真做了才有的数字。写第六节初稿时我按"数 await"预估过一个"115ms → 约 70ms"，实际做出来是 86ms——**预估方向对，幅度偏乐观**，因为省掉的那次往返只有 32ms 上下，剩下的是渲染和响应，那部分动不了。

## 七、另一半：`s-maxage` 和 `s-maxage` 之外的那个参数

标题说"改了一件事"，其实同一个提交里还动了一组缓存参数。它和并发是两个完全不同的杠杆，得分开说：

```js
// src/cache.js
- export const EDGE_TTL = 60;
- export const EDGE_SWR = 600;
+ export const EDGE_TTL = 300;
+ export const EDGE_SWR = 86400;
```

**`s-maxage` 拦的是"多久回源一次"。** 60 秒意味着同一个 URL 每分钟最多渲染一次；300 秒意味着每五分钟一次。五个访客在五分钟内打开同一篇文章：改前渲染 5 次，改后 1 次。这不是"变快了"，是"根本没渲染"。

这也是为什么它比并发更便宜：并发把 180 降到 84，缓存把 84 降到 **4**。实测命中路径：

```
/cat/tools   wallTime 4   cpuTime 0
```

Worker 还是跑了（`caches.default` 的命中在 Worker 内部，不是 CF 边缘层），但只花了 4 毫秒——查缓存、返回、结束。CPU 0 毫秒。

**`stale-while-revalidate` 拦的是"过期那一刻的访客"。** 这两个参数经常被当成一回事，其实分工完全不同：

| 参数 | 管什么 | 过期之后 |
|---|---|---|
| `s-maxage=300` | 300 秒内直接用缓存，不回源 | 300 秒一到，缓存"过期" |
| `stale-while-revalidate=86400` | 过期后**一天内**仍然先把旧副本给访客，同时在后台刷新 | 一天之后，才轮到访客真的等一次渲染 |

原来的 `600` 意味着：一个页面只要超过 10 分钟没人访问，下一个访客就得结结实实等一次渲染（84–180ms）。而这个站的实际情况是——大部分文章一天也没几个访客。**`600` 等于对绝大多数页面从来没生效过。** 换成 `86400` 之后，哪怕这篇文昨天被读过、今天第一个访客来，拿到的也是旧副本（几毫秒），刷新在后台进行。

所以这两个数改的方向不一样：`s-maxage` 决定"省多少次渲染"，`swr` 决定"省不省掉过期那一刻的那一次等待"。

### 顺手发现的一处不一致

我们的边缘缓存其实是两层：CF 自己的 HTTP 缓存，和 Worker 里的 `caches.default`。两层的口径没对齐：

```js
export async function edgePut(url, res, ttl) {
  const headers = new Headers(res.headers);
  headers.set(''cache-control'', `public, s-maxage=${ttl}`);   // 这里把 swr 写丢了
  ...
}
```

存进 Worker 缓存的副本只有 `s-maxage`，没有 `stale-while-revalidate`。所以严格说：**`swr=86400` 只对 CF 边缘那一层生效，Worker 内的那层仍是硬 TTL，300 秒一到必须等一次渲染。**

实际影响不大（Worker 那层命中只要 4ms，回源一次也就 84ms），但两套口径不一致这件事本身是个隐患：以后调参数时，你以为改了一处，其实只改了一半。

还有一个实测出来的观察：这套 HTML 现在**只有首页会在 CF 边缘出 `CF-Cache-Status: HIT`**，`/cat/*`、`/p/*`、`/archive` 全是 `DYNAMIC`（没有这个头）。也就是说，实际在兜底的几乎全是 Worker 内那层 `caches.default`。因为这个观察，上面那处不一致就不是"影响不大"了，而是**主力那一层没有 SWR**。

改法是把两个参数都从同一组常量里传，写副本时跟出给浏览器的响应头对齐：

```js
export async function edgePut(url, res, ttl = EDGE_TTL, swr = EDGE_SWR) {
  const headers = new Headers(res.headers);
  headers.set(''cache-control'', `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
  ...
}

export const pageCacheControl = () =>
  `public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`;
```

现在改 `EDGE_TTL` 一处，两层一起变。以前是改了一处、另一处悄悄留着旧值——这类问题不会报错，只会让你在半年后排查"为什么偶尔有一次慢请求"。

这里只对齐了两层。还有更外面的一层：浏览器拿到的 `max-age=0` 到底能不能生效，取决于 zone 上那个会把 HTML 压成 4 小时的 Browser Cache TTL。四层合起来的判断顺序和检查表，整理在[《三层缓存怎么排，才不会被 Cloudflare 改写成 4 小时》](/p/three-layer-cache)。

### 一个不要碰的参数

```js
/* 注意：别加 no-transform。
   实测它会连带关掉 Cloudflare 的 Brotli —— 首页 HTML 从 8KB 涨回 25KB，
   为了挡一个 20KB 的 RUM 脚本反而多传 17KB，这笔账是亏的。 */
```

缓存头和压缩是连着的。`no-transform` 看着无害（"别改我的内容"），实际会把边缘压缩一起关掉。这类参数只能实测，看文档看不出来。

## 八、验收：三条命令，别只看一个数

改性能最容易犯的错是"改完觉得快了"。给三个可复现的检查，顺序是从外到内：

```bash
# 1) 缓存有没有生效：命中时应该是 4ms 级别，且 cache-control 里有 s-maxage=300
curl -s -o /dev/null -D - "https://exia.de5.net/cat/tools" | grep -iE "cache-control|cf-cache-status"

# 2) 未命中的真实渲染成本：TTFB 减静态地板
curl -s -o /dev/null -w "page %{time_starttransfer}\n" "https://exia.de5.net/cat/tools?x=$RANDOM"
curl -s -o /dev/null -w "floor %{time_starttransfer}\n" "https://exia.de5.net/style.css?f=$RANDOM"

# 3) 内部账：wallTime 与 cpuTime 的比值
npx wrangler tail --format json
```

第 3 条最有价值。`wallTime` 高、`cpuTime` 低，说明你在等 I/O，去查往返次数；两个都高，才是代码本身重（渲染、正则、序列化）。**分不清这两件事，就会去优化错的地方**——比如给一个 CPU 只花 5ms 的页面做"减少字符串拼接"。

## 九、回头看，这次改动到底改对了什么

把数字按因果拆开：

| 从 | 到 | 原因 | 能不能靠代码复制 |
|---|---|---|---|
| 549ms | 180ms | 冷 isolate 转热（部署后第一发：建连接、站点设置缓存为空、预编译语句还没热） | 不能。这是平台行为，只能靠"别在冷启动时判断性能" |
| 180ms | 84ms | 五次串行往返 → 一次 | 能。数 `await` 的个数就行 |
| 84ms | 4ms | 缓存命中 | 能，但代价是内容更新的延迟（我们用主动清缓存补上） |

那次提交真正教会我的不是 `Promise.all` 的写法——那个谁都会——而是**怎么判断一页该有几次往返**：

1. 把这页要的数据列出来；
2. 画依赖箭头：谁的结果是谁的输入；
3. 没有箭头指向它的，全部并发；
4. 有箭头指向它的，串行，且放在越后面越好；
5. 能从 SQL 里一次带出来的，别发第二次（`GROUP_CONCAT` 那一条）。

按这个流程数，一页 HTML 的往返次数应该等于**依赖链的深度**，不是查询的条数。`/cat/tools` 的依赖深度是 1，理想值就是 1 次——现在做到了。文章页理论上也是 1（正文取到之后其余全部无关），但当时被「必须先有 id」卡成了 2；把绑定参数换成 slug 之后才真的落到 1 次，86ms。

这个流程有个前提：**只数真正会执行的往返**。`await` 摆在代码里不代表这次请求会走它——它可能在 `if` 里，可能被进程内缓存挡住。我最初数错就是因为没区分这两件事。

至于标题里那个 549 → 96：数字是真的，但它跨了两个实验。写成"我只改了一件事"会让人以为并发能省 450ms，然后照着做一遍发现只省了 90ms，最后得出"网上文章都是假的"的结论。

**一页 CPU 只花 5ms、却要 180ms 才吐出来，问题一定不在你的代码里，在你等的那几次网络里。** 先把 `await` 的个数数清楚，再谈优化。
', html_content = '<p>11-09 那天部署完，我抓到的第一条 <code>Server-Timing</code> 是 <code>cfWorker;dur=549</code>，同一个版本另一个页面是 <code>752</code>。今天同一个栏目页 <code>/cat/tools</code>，同样的探针，<code>84</code> 到 <code>96</code>。</p>
<p>数字没造假，但标题这句话是<strong>不严谨</strong>的。549 和 96 之间隔着两个变量：一个是冷启动转热，一个才是代码改动。把这俩混在一起说&quot;我只改了一件事就把 549 变成 96&quot;，属于拿两个不同实验的结果互相背书。</p>
<p>所以这篇分两半：先把尺子校准，把 549 拆成&quot;冷启动&quot;和&quot;排队&quot;两块钱；再讲那件唯一改对的事——它省下的正好是 96ms，而不是 450ms。</p>
<p>先说结论：</p>
<div class="table-wrap"><table><thead><tr><th>阶段</th><th>/cat/tools 的 Worker 执行时间</th><th>这块是谁的钱</th></tr></thead><tbody><tr><td>11-09 部署后第一发（冷 isolate + 串行查询）</td><td>549ms</td><td>冷启动 ~370 + 排队 ~96 + 渲染十几毫秒</td></tr><tr><td>同版本，预热之后（串行查询）</td><td>180ms</td><td>全是排队</td></tr><tr><td>改动之后（并发查询）</td><td>84ms</td><td>1 次往返 + 5ms CPU</td></tr></tbody></table></div>
<p>真正可以靠写代码省掉的是中间那 96ms。冷启动那块，改代码省不掉。</p>
<h2 id="一-先校准尺子-cfworker-是好尺子-但不是一直有"><a class="h-anchor" href="#一-先校准尺子-cfworker-是好尺子-但不是一直有">#</a>一、先校准尺子：<code>cfWorker</code> 是好尺子，但不是一直有</h2>
<p><code>Server-Timing: cfWorker;dur=549</code> 这个头不是我们写的，是 Cloudflare 加的，意思是&quot;这一发请求在 Worker 里待了 549 毫秒&quot;。它最接近&quot;渲染耗时&quot;这个概念，所以当时我拿它做记录。</p>
<p>问题是它现在在线上抓不到了：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -o /dev/null -D - <span class="tok-s">&quot;https://exia.de5.net/cat/tools?x=$RANDOM&quot;</span> | <span class="tok-k">grep</span> -i server-timing
<span class="tok-c"># 没有输出</span></code></pre></div>
<p>今天同一台 Worker、同一个 URL，这个头不见了。可能是平台侧策略变了，也可能是压缩/缓存路径上被吃掉了。不管原因是什么，结论是：<strong>别把一次性的观察当成长期监控</strong>。你三个月后想复现，得有个不依赖平台施舍的尺子。</p>
<p>这篇里所有数字都用另外两种尺子量，都能自己跑：</p>
<p><strong>尺子 A：TTFB 减静态资源地板。</strong> TTFB 里混着网络往返，直接比会掺水。先量一个静态文件的 TTFB（它由边缘直接吐，不含 Worker 逻辑），这一段就是&quot;网络+边缘&quot;的地板，减掉之后剩下的才是 Worker 的时间。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 地板：静态资源，边缘直接返回</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;%{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/style.css?f=$RANDOM&quot;</span>
<span class="tok-c"># 待测页面，带随机参数强制绕过缓存</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;%{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/cat/tools?x=$RANDOM&quot;</span></code></pre></div>
<p><strong>尺子 B：<code>wrangler tail</code> 的 <code>wallTime</code> / <code>cpuTime</code>。</strong> 这是 Worker 自己报的账，比任何外部探针都准，而且能把&quot;耗时&quot;和&quot;算力&quot;分开：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash">npx wrangler tail --format json
<span class="tok-c"># 每个事件里带 wallTime（墙钟）和 cpuTime（CPU 毫秒）</span></code></pre></div>
<p>第一次看到这两个数并排出现时，我盯着看了一会儿：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">/cat/tools   wallTime 84   cpuTime 5</code></pre></div>
<p>一个页面渲染花了 84 毫秒，其中 CPU 只占 5 毫秒。<strong>94% 的时间在等。</strong> 等什么？等数据库。</p>
<p>这不是 Workers 的问题，是任何&quot;请求-响应&quot;式数据库都有的账：你的代码没事干，它只是在等对面把结果送回来。</p>
<h2 id="二-一页-html-到底要几次数据库往返"><a class="h-anchor" href="#二-一页-html-到底要几次数据库往返">#</a>二、一页 HTML 到底要几次数据库往返</h2>
<p>在改成并发之前，<code>/cat/tools</code> 这一页在 <code>injectTheme</code> 里的取数是这样的（这是改动前的代码，我后来把它原样部署成一个独立 Worker 来做对照，见第四节）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 改动前：一个 await 接一个 await</span>
<span class="tok-k">const</span> s = <span class="tok-k">await</span> <span class="tok-f">getSite</span>(env);
body = <span class="tok-f">fillSeo</span>(body, s, url);
<span class="tok-c">// ...</span>
<span class="tok-k">const</span> { body: listed, list } = <span class="tok-k">await</span> <span class="tok-f">renderList</span>(env, body, url); <span class="tok-c">// 里面还有三次</span>
body = <span class="tok-k">await</span> <span class="tok-f">renderCats</span>(env, listed);                            <span class="tok-c">// 里面还有两次</span></code></pre></div>
<p>拆开数一下往返次数：</p>
<div class="table-wrap"><table><thead><tr><th>顺序</th><th>查询</th><th>干什么</th></tr></thead><tbody><tr><td>1</td><td><code>getSite()</code></td><td>读 <code>settings</code> 表拿站名、主题、头像</td></tr><tr><td>2</td><td><code>SELECT COUNT(*)</code></td><td>算这个栏目一共几篇（分页要用）</td></tr><tr><td>3</td><td>主查询 <code>SELECT p.*, ...</code></td><td>取当页 10 篇</td></tr><tr><td>4</td><td><code>attachTags()</code></td><td>把这 10 篇的标签一次性捞回来</td></tr><tr><td>5</td><td><code>catCounts()</code></td><td>四个栏目各几篇</td></tr></tbody></table></div>
<p>五次往返，一次接一次。假设单程 30ms，这一页光&quot;等&quot;就是 150ms 起步。</p>
<p>而 <code>renderCats()</code> 里还有第六次（标签云），只有 <code>/categories</code> 页才走。首页更惨，多了 <code>pickPosts()</code> 那一次，五次。</p>
<p>关键在于：<strong>这五次之间没有任何依赖。</strong> count 不需要 post 列表，标签不需要栏目计数，站点设置更不需要等任何东西。它们只是被写在了五个连续的 <code>await</code> 后面，于是排队了。</p>
<h2 id="三-改法-把-互不依赖-变成-同时发出"><a class="h-anchor" href="#三-改法-把-互不依赖-变成-同时发出">#</a>三、改法：把&quot;互不依赖&quot;变成&quot;同时发出&quot;</h2>
<p>改动就一处，<code>injectTheme</code> 的取数部分：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 这一页要的三份数据互不依赖：站点设置、文章列表、栏目/标签计数。
   以前是一个 await 接一个，线上冷启动 cfWorker 跑到 500ms+ 大部分耗在这串行上。
   现在先全部发出去，最慢的那条决定总时长。 */</span>
<span class="tok-k">const</span> siteP = <span class="tok-f">getSite</span>(env);
<span class="tok-k">const</span> catsP = body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;&lt;!--CATS--&gt;&#39;</span>) ? <span class="tok-f">catCounts</span>(env) : Promise.<span class="tok-f">resolve</span>(<span class="tok-k">new</span> <span class="tok-f">Map</span>());
<span class="tok-k">const</span> tagsP = body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;&lt;!--TAGS--&gt;&#39;</span>) ? <span class="tok-f">tagsData</span>(env.DB).<span class="tok-k">catch</span>(() =&gt; []) : Promise.<span class="tok-f">resolve</span>(<span class="tok-k">null</span>);
<span class="tok-c">// 列表只依赖模板和 URL，不依赖站点设置，所以这里就能先发车</span>
<span class="tok-k">const</span> listP = <span class="tok-f">listQuery</span>(env, url);

<span class="tok-k">const</span> [s, counts, tags] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([siteP, catsP, tagsP]);</code></pre></div>
<p>注意这里是&quot;先拿到 Promise，再在需要的地方 await&quot;，不是 <code>await Promise.all([...])</code> 一把梭。区别在于：<code>s</code> 要用来拼 <code>&lt;head&gt;</code>，<code>listP</code> 的结果要等模板替换完才用得上。先把请求发出去，等真需要数据时再 await，中间那段拼字符串的时间就被利用起来了。</p>
<p><code>listPosts</code> 内部还有一层同样的排队：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* COUNT 和主查询互不依赖，一起发出去。
   以前是先 await COUNT 再 await 列表，冷启动时两个往返叠加，
   等于把 D1 的延迟翻了一倍。 */</span>
<span class="tok-k">const</span> [{ results }, totalRow] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([
  db.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT p.*, ${AUTHOR_COLS}, ${TAG_AGG}, ... LIMIT ? OFFSET ?`</span>).<span class="tok-f">bind</span>(...args, size, offset).<span class="tok-f">all</span>(),
  db.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSql}`</span>).<span class="tok-f">bind</span>(...args).<span class="tok-f">first</span>(),
]);</code></pre></div>
<h3 id="这里踩了一个不那么显然的坑"><a class="h-anchor" href="#这里踩了一个不那么显然的坑">#</a>这里踩了一个不那么显然的坑</h3>
<p>第一版我是直接把 <code>renderList</code> 整个塞进 <code>Promise.all</code> 的，结果页面渲染出来&quot;上半部分正常，列表区一片空白&quot;。原因不是查询失败，而是<strong>顺序</strong>：</p>
<p><code>injectTheme</code> 是一串字符串替换：先换 <code>&lt;!--THEME--&gt;</code>、再换 <code>site-header</code>、再换 <code>&lt;!--LIST--&gt;</code>。如果 <code>renderList</code> 在替换还没发生的时候就把 <code>body</code> 复制走，它拿到的是一份半成品，返回时又把前面已经替换好的内容整个盖回去。</p>
<p>所以改成了两半：</p>
<ul><li><code>listQuery(env, url)</code>：只查数据库，不碰 HTML，所以能和别人一起并发；</li><li><code>applyList(body, res)</code>：纯字符串替换，必须等前面的替换全部做完再跑。</li></ul>
<p><strong>并发改造的真实难点不是 <code>Promise.all</code> 怎么写，是&quot;哪一段是纯取数、哪一段必须按顺序&quot;。</strong> 把有副作用的字符串处理也塞进去，就会出现&quot;能跑但内容是旧的&quot;这种最难查的 bug。</p>
<h3 id="标签那一次不是并发-是-少一次"><a class="h-anchor" href="#标签那一次不是并发-是-少一次">#</a>标签那一次不是并发，是&quot;少一次&quot;</h3>
<p>标签原本是第二次往返：先查 10 篇文章，再用 <code>post_id IN (?,?,...)</code> 捞标签。这次直接内联进主查询：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 标签用相关子查询一次带出，替代「先查 posts 再 attachTags」的第二次往返。
   char(31) 是 US（unit separator），标签名里不可能出现，拿来当分隔符比逗号安全 —— 标签本身允许逗号。 */</span>
<span class="tok-k">const</span> TAG_AGG = <span class="tok-s">`(SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str`</span>;
<span class="tok-k">const</span> splitTagStr = (s) =&gt; (s ? <span class="tok-f">String</span>(s).<span class="tok-f">split</span>(<span class="tok-s">&#39;\u001f&#39;</span>).<span class="tok-f">filter</span>(Boolean) : []);</code></pre></div>
<p>这一条和 <code>Promise.all</code> 是两种不同性质的动作，很容易混为一谈：</p>
<ul><li><code>Promise.all</code>：往返次数不变，但把等待叠在一起了，省的是<strong>时间</strong>；</li><li>内联子查询：往返次数少了一次，省的是<strong>次数</strong>（顺带也省时间）。</li></ul>
<p>真到了瓶颈，省次数比省时间更值钱——因为次数有天花板。这一点第六节会说。</p>
<h3 id="并发不是免费的-每条都要能自己兜住"><a class="h-anchor" href="#并发不是免费的-每条都要能自己兜住">#</a>并发不是免费的：每条都要能自己兜住</h3>
<p><code>Promise.all</code> 有个特性：任何一条 reject，整体立刻 reject。首页五条查询里只要有一条 SQL 挂了，整个页面 500。所以每条都单独兜：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> tagsP = body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;&lt;!--TAGS--&gt;&#39;</span>) ? <span class="tok-f">tagsData</span>(env.DB).<span class="tok-k">catch</span>(() =&gt; []) : Promise.<span class="tok-f">resolve</span>(<span class="tok-k">null</span>);</code></pre></div>
<p><code>catCounts</code> 里有 <code>try/catch</code> 返回空 Map，<code>listQuery</code> 里有 <code>try/catch</code> 返回 <code>data: null</code>（然后渲染骨架），<code>getSite</code> 里有 <code>try/catch</code> 回退到环境变量。<strong>并发写法把&quot;一个查询失败&quot;从&quot;一个区块空白&quot;升级成了&quot;整页白屏&quot;</strong>，兜底必须补在这之前。</p>
<h2 id="四-a-b-怎么做的-把旧代码部署成另一个-worker"><a class="h-anchor" href="#四-a-b-怎么做的-把旧代码部署成另一个-worker">#</a>四、A/B 怎么做的：把旧代码部署成另一个 Worker</h2>
<p>只对比&quot;改之前记得的数字&quot;和&quot;改之后现在的数字&quot;是没有说服力的——中间还隔着 3 天、一次 CF 侧变更、几十次部署。</p>
<p>所以做了个真对照：</p>
<ol><li><code>git worktree add /tmp/blog-old 8e29df2</code>，检出并发改造的<strong>父提交</strong>；</li><li>复制一份 <code>wrangler.jsonc</code>，只把 <code>name</code> 改成 <code>exia-blog-perf-old</code>，去掉 <code>triggers</code>（别让两个 Worker 都去跑友链巡检）；</li><li><code>wrangler deploy -c wrangler.perfold.jsonc</code> —— 独立 Worker，绑同一个 D1、同一份静态资源，<strong>线上流量一点不受影响</strong>；</li><li>两个终端同时 <code>wrangler tail --format json</code>，然后<strong>交替</strong>发请求：先打旧版一次，再打新版一次，循环 10 轮。</li></ol>
<p>交替发是为了抵消时间漂移（CF 边缘的负载、我这条线路的抖动，都会随时间变）。10 轮下来取中位数：</p>
<div class="table-wrap"><table><thead><tr><th>页面</th><th>串行（旧）</th><th>并发（新）</th><th>差</th></tr></thead><tbody><tr><td><code>/cat/tools</code></td><td>180ms</td><td><strong>84ms</strong></td><td>−96</td></tr><tr><td><code>/tag/cloudflare</code></td><td>207ms</td><td><strong>148ms</strong></td><td>−59</td></tr><tr><td><code>/archive</code></td><td>175ms</td><td>170ms</td><td>−5</td></tr><tr><td><code>/p/comment-anti-spam</code></td><td>115ms</td><td>117ms</td><td>±0</td></tr></tbody></table></div>
<p>同一轮里 CPU 时间是：旧版 5、5、6、7ms，新版 5、6、7、9ms。<strong>两版一样。</strong></p>
<p>这就是这次改动最干净的一句总结：</p>
<blockquote><p>并发没有让任何一行代码变快，CPU 一毫秒都没省。省下来的 96ms，是三次往返的等待被叠到了一起。</p></blockquote>
<p>TTFB 那边（21 次采样取中位数，减去静态地板）也对得上：</p>
<div class="table-wrap"><table><thead><tr><th>页面</th><th>串行</th><th>并发</th><th>差</th></tr></thead><tbody><tr><td>首页</td><td>200ms（272 − 72）</td><td>80ms（149 − 69）</td><td>−120</td></tr><tr><td><code>/cat/tools</code></td><td>168ms（240 − 72）</td><td>66ms（135 − 69）</td><td>−102</td></tr><tr><td><code>/archive</code></td><td>189ms</td><td>157ms</td><td>−32</td></tr><tr><td>文章页</td><td>128ms</td><td>111ms</td><td>−17</td></tr></tbody></table></div>
<p>首页省得最多（120ms），因为它原本有五次往返要排：站点设置、COUNT、主查询、标签、精选位。</p>
<h2 id="五-为什么省下的不是-sql-时间"><a class="h-anchor" href="#五-为什么省下的不是-sql-时间">#</a>五、为什么省下的不是&quot;SQL 时间&quot;</h2>
<p>这里有个反直觉的点，值得单独说：<strong>并发查询并不会让 D1 查得更快。</strong></p>
<p>D1 的文档写得很直白：</p>
<blockquote><p>Each individual D1 database is inherently single-threaded, and processes queries one at a time.</p></blockquote>
<p>单个库是单线程的，查询是一条一条处理的。你并发发五条过去，它们还是排队执行，只是队伍在<strong>对面</strong>排，不在你这边排。</p>
<p>那省下来的 96ms 是什么？是<strong>每条查询的固定开销</strong>——建请求、走网络、序列化结果、回来。这部分是纯等待，跟数据库在不在忙没关系。</p>
<p>所以可以反推单次往返的成本：96ms ÷ 3 次 ≈ <strong>32ms</strong>。再用一个只发一次往返的接口验证：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;%{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/api/posts?page=1&amp;size=1&amp;z=$RANDOM&quot;</span></code></pre></div>
<p><code>/api/posts</code> 里是两条并发查询（列表 + COUNT）+ 一点点 JSON 序列化：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">/api/posts   wallTime 51   cpuTime 2</code></pre></div>
<p>51ms 里 CPU 占 2ms，剩下 49ms 就是&quot;一次往返 + 出结果&quot;。和反推的 32ms 一个量级（这个接口结果集更小、但含 TLS 之后的额外开销），对得上。</p>
<p><strong>推论：并发数不是越多越好。</strong> D1 每个 Worker 调用最多同时开 6 条连接，超过就排到下一批。把 20 条查询塞进 <code>Promise.all</code>，第 7 条开始照样等，只是你看不见。真要压次数，该用的是 <code>db.batch()</code>——多条语句一次请求，把&quot;每次请求的固定开销&quot;付一遍。</p>
<p>我们这个站点的量级（一页 5 次往返、16 篇文章）还犯不上上 batch，但知道这条线在哪，比&quot;能并发就并发&quot;有用。</p>
<h2 id="六-两个页面纹丝不动-这才是最有信息量的部分"><a class="h-anchor" href="#六-两个页面纹丝不动-这才是最有信息量的部分">#</a>六、两个页面纹丝不动，这才是最有信息量的部分</h2>
<p>看第四节的表：<code>/archive</code> 只省了 5ms，文章页 ±0。</p>
<p>不是并发没用，是<strong>这两个页面压根不在那个 <code>Promise.all</code> 里</strong>。那次提交只动了列表页那条链（<code>renderList</code> / <code>renderCats</code>），归档页和文章页的取数代码一行没改，自然一动不动。</p>
<p>文章页当时的顺序是这样：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> post = <span class="tok-k">await</span> env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT p.*, ... WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">first</span>();      <span class="tok-c">// D1 第 1 次</span>
<span class="tok-k">const</span> tpl = <span class="tok-k">await</span> <span class="tok-f">assetText</span>(env, request, <span class="tok-s">&#39;/post&#39;</span>);                                            <span class="tok-c">// 模板走 ASSETS，不是 D1</span>
<span class="tok-k">const</span> [{ results: tagRows }, { results: cmtRows }] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([...]);                  <span class="tok-c">// D1 第 2 次，标签与评论已经并发</span>
<span class="tok-k">if</span> (post.series) { <span class="tok-c">/* 系列目录 */</span> }                                                            <span class="tok-c">// 这篇没有系列归属，不发起</span>
<span class="tok-k">const</span> site = <span class="tok-k">await</span> <span class="tok-f">getSite</span>(env);                                                                <span class="tok-c">// 30 秒进程内缓存，多数请求不落库</span></code></pre></div>
<p><strong>我一开始把这段数成了&quot;四次数据库往返&quot;，这是错的。</strong> 数 <code>await</code> 不等于数往返：<code>series</code> 只有文章属于某个系列时才发，<code>getSite()</code> 有 30 秒进程内缓存。对一篇没有系列归属的文章，真实往返是 <strong>2 次</strong>——正文一次，标签与评论一次。</p>
<p>所以 115ms 不是四次排队，是：2 次 D1 往返（按 32ms/次算约 64ms）+ 一次模板读取 + 渲染与响应。</p>
<p>那空间在哪？在<strong>依赖深度</strong>。第 2 次往返之所以不能跟第 1 次合并，是因为要先拿到 <code>post.id</code> 才能去查 <code>post_tags</code> 和 <code>comments</code>。</p>
<p>把关联条件从 id 换成 slug，这几条查询就不再互相等待：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> [post, tagRes, cmtRes, seriesRes, site, tpl] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">first</span>(),
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... JOIN posts p ON p.id = pt.post_id WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">all</span>(),
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... JOIN posts p ON p.id = c.post_id WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">all</span>(),
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... WHERE series = (SELECT series FROM posts WHERE slug = ?)`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">all</span>(),
  <span class="tok-f">getSite</span>(env),
  <span class="tok-f">assetText</span>(env, request, <span class="tok-s">&#39;/post&#39;</span>),
]);</code></pre></div>
<p>同一 URL、同样绕开缓存、各取中位：<strong>127ms → 86ms</strong>（p10 79、p90 89）。</p>
<p>这里有个能复用的判断：<strong>并发的单位不是&quot;查询&quot;，是&quot;依赖链&quot;</strong>。同样是这四条 SQL，只把绑定参数的来源从 <code>post.id</code> 换成 <code>slug</code>，串行就变并行，代码行数几乎没变。</p>
<p>归档页更值得说。它只有两次往返，但照样 170ms，因为第一次查询本身重：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/api.js</span>
<span class="tok-s">`SELECT p.*, ${AUTHOR_COLS}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
 FROM posts p ${AUTHOR_JOIN} WHERE ... LIMIT 2000`</span></code></pre></div>
<p><code>p.*</code> 把正文一起查出来了。这个站当时 14 篇公开文章，正文合计 <strong>79KB</strong>（最长一篇 12KB）。归档页要渲染的只是 14 个标题，却把 79KB 正文全搬了一遍，然后 <code>attachTags()</code> 再补一次往返。</p>
<p>改成只取需要的列，阅读时长用 SQL 现算（口径必须和 <code>readingTime()</code> 一致，否则归档显示 26 分钟、文章页显示 24 分钟）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">SELECT p.id, p.slug, p.title, p.summary, p.cover, p.category, p.published_at, p.created_at,
       <span class="tok-f">length</span>(<span class="tok-f">replace</span>(<span class="tok-f">replace</span>(<span class="tok-f">replace</span>(<span class="tok-f">replace</span>(<span class="tok-f">COALESCE</span>(p.content,<span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">32</span>), <span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">10</span>), <span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">13</span>), <span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">9</span>), <span class="tok-s">&#39;&#39;</span>)) AS content_len
FROM posts p ...</code></pre></div>
<p>实测 <strong>175ms → 159ms</strong>。省得不算多，因为它本来就只有两次往返，减掉的是一次查询里的传输量而不是一次排队。</p>
<p>两条结论：</p>
<ol><li><strong>并发的收益 = 被并发的次数 × 单次往返成本。</strong> 没有 await 可叠的页面，改多少 <code>Promise.all</code> 都是 0。</li><li><strong>单条慢查询不会因为并发变快。</strong> 归档页 170ms 里能靠并发省的只有一次，剩下的大头是搬了 79KB 不该搬的数据，只能改 SQL。</li></ol>
<p>上面这两处都是后来真做了才有的数字。写第六节初稿时我按&quot;数 await&quot;预估过一个&quot;115ms → 约 70ms&quot;，实际做出来是 86ms——<strong>预估方向对，幅度偏乐观</strong>，因为省掉的那次往返只有 32ms 上下，剩下的是渲染和响应，那部分动不了。</p>
<h2 id="七-另一半-s-maxage-和-s-maxage-之外的那个参数"><a class="h-anchor" href="#七-另一半-s-maxage-和-s-maxage-之外的那个参数">#</a>七、另一半：<code>s-maxage</code> 和 <code>s-maxage</code> 之外的那个参数</h2>
<p>标题说&quot;改了一件事&quot;，其实同一个提交里还动了一组缓存参数。它和并发是两个完全不同的杠杆，得分开说：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/cache.js</span>
- <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_TTL = <span class="tok-n">60</span>;
- <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_SWR = <span class="tok-n">600</span>;
+ <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_TTL = <span class="tok-n">300</span>;
+ <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_SWR = <span class="tok-n">86400</span>;</code></pre></div>
<p><strong><code>s-maxage</code> 拦的是&quot;多久回源一次&quot;。</strong> 60 秒意味着同一个 URL 每分钟最多渲染一次；300 秒意味着每五分钟一次。五个访客在五分钟内打开同一篇文章：改前渲染 5 次，改后 1 次。这不是&quot;变快了&quot;，是&quot;根本没渲染&quot;。</p>
<p>这也是为什么它比并发更便宜：并发把 180 降到 84，缓存把 84 降到 <strong>4</strong>。实测命中路径：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">/cat/tools   wallTime 4   cpuTime 0</code></pre></div>
<p>Worker 还是跑了（<code>caches.default</code> 的命中在 Worker 内部，不是 CF 边缘层），但只花了 4 毫秒——查缓存、返回、结束。CPU 0 毫秒。</p>
<p><strong><code>stale-while-revalidate</code> 拦的是&quot;过期那一刻的访客&quot;。</strong> 这两个参数经常被当成一回事，其实分工完全不同：</p>
<div class="table-wrap"><table><thead><tr><th>参数</th><th>管什么</th><th>过期之后</th></tr></thead><tbody><tr><td><code>s-maxage=300</code></td><td>300 秒内直接用缓存，不回源</td><td>300 秒一到，缓存&quot;过期&quot;</td></tr><tr><td><code>stale-while-revalidate=86400</code></td><td>过期后<strong>一天内</strong>仍然先把旧副本给访客，同时在后台刷新</td><td>一天之后，才轮到访客真的等一次渲染</td></tr></tbody></table></div>
<p>原来的 <code>600</code> 意味着：一个页面只要超过 10 分钟没人访问，下一个访客就得结结实实等一次渲染（84–180ms）。而这个站的实际情况是——大部分文章一天也没几个访客。<strong><code>600</code> 等于对绝大多数页面从来没生效过。</strong> 换成 <code>86400</code> 之后，哪怕这篇文昨天被读过、今天第一个访客来，拿到的也是旧副本（几毫秒），刷新在后台进行。</p>
<p>所以这两个数改的方向不一样：<code>s-maxage</code> 决定&quot;省多少次渲染&quot;，<code>swr</code> 决定&quot;省不省掉过期那一刻的那一次等待&quot;。</p>
<h3 id="顺手发现的一处不一致"><a class="h-anchor" href="#顺手发现的一处不一致">#</a>顺手发现的一处不一致</h3>
<p>我们的边缘缓存其实是两层：CF 自己的 HTTP 缓存，和 Worker 里的 <code>caches.default</code>。两层的口径没对齐：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">edgePut</span>(url, res, ttl) {
  <span class="tok-k">const</span> headers = <span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers);
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, <span class="tok-s">`public, s-maxage=${ttl}`</span>);   <span class="tok-c">// 这里把 swr 写丢了</span>
  ...
}</code></pre></div>
<p>存进 Worker 缓存的副本只有 <code>s-maxage</code>，没有 <code>stale-while-revalidate</code>。所以严格说：<strong><code>swr=86400</code> 只对 CF 边缘那一层生效，Worker 内的那层仍是硬 TTL，300 秒一到必须等一次渲染。</strong></p>
<p>实际影响不大（Worker 那层命中只要 4ms，回源一次也就 84ms），但两套口径不一致这件事本身是个隐患：以后调参数时，你以为改了一处，其实只改了一半。</p>
<p>还有一个实测出来的观察：这套 HTML 现在<strong>只有首页会在 CF 边缘出 <code>CF-Cache-Status: HIT</code></strong>，<code>/cat/*</code>、<code>/p/*</code>、<code>/archive</code> 全是 <code>DYNAMIC</code>（没有这个头）。也就是说，实际在兜底的几乎全是 Worker 内那层 <code>caches.default</code>。因为这个观察，上面那处不一致就不是&quot;影响不大&quot;了，而是<strong>主力那一层没有 SWR</strong>。</p>
<p>改法是把两个参数都从同一组常量里传，写副本时跟出给浏览器的响应头对齐：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">edgePut</span>(url, res, ttl = EDGE_TTL, swr = EDGE_SWR) {
  <span class="tok-k">const</span> headers = <span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers);
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, <span class="tok-s">`public, s-maxage=${ttl}, stale-while-revalidate=${swr}`</span>);
  ...
}

<span class="tok-k">export</span> <span class="tok-k">const</span> pageCacheControl = () =&gt;
  <span class="tok-s">`public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`</span>;</code></pre></div>
<p>现在改 <code>EDGE_TTL</code> 一处，两层一起变。以前是改了一处、另一处悄悄留着旧值——这类问题不会报错，只会让你在半年后排查&quot;为什么偶尔有一次慢请求&quot;。</p>
<p>这里只对齐了两层。还有更外面的一层：浏览器拿到的 <code>max-age=0</code> 到底能不能生效，取决于 zone 上那个会把 HTML 压成 4 小时的 Browser Cache TTL。四层合起来的判断顺序和检查表，整理在<a href="/p/three-layer-cache">《三层缓存怎么排，才不会被 Cloudflare 改写成 4 小时》</a>。</p>
<h3 id="一个不要碰的参数"><a class="h-anchor" href="#一个不要碰的参数">#</a>一个不要碰的参数</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 注意：别加 no-transform。
   实测它会连带关掉 Cloudflare 的 Brotli —— 首页 HTML 从 8KB 涨回 25KB，
   为了挡一个 20KB 的 RUM 脚本反而多传 17KB，这笔账是亏的。 */</span></code></pre></div>
<p>缓存头和压缩是连着的。<code>no-transform</code> 看着无害（&quot;别改我的内容&quot;），实际会把边缘压缩一起关掉。这类参数只能实测，看文档看不出来。</p>
<h2 id="八-验收-三条命令-别只看一个数"><a class="h-anchor" href="#八-验收-三条命令-别只看一个数">#</a>八、验收：三条命令，别只看一个数</h2>
<p>改性能最容易犯的错是&quot;改完觉得快了&quot;。给三个可复现的检查，顺序是从外到内：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1) 缓存有没有生效：命中时应该是 4ms 级别，且 cache-control 里有 s-maxage=300</span>
<span class="tok-k">curl</span> -s -o /dev/null -D - <span class="tok-s">&quot;https://exia.de5.net/cat/tools&quot;</span> | <span class="tok-k">grep</span> -iE <span class="tok-s">&quot;cache-control|cf-cache-status&quot;</span>

<span class="tok-c"># 2) 未命中的真实渲染成本：TTFB 减静态地板</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;page %{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/cat/tools?x=$RANDOM&quot;</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;floor %{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/style.css?f=$RANDOM&quot;</span>

<span class="tok-c"># 3) 内部账：wallTime 与 cpuTime 的比值</span>
npx wrangler tail --format json</code></pre></div>
<p>第 3 条最有价值。<code>wallTime</code> 高、<code>cpuTime</code> 低，说明你在等 I/O，去查往返次数；两个都高，才是代码本身重（渲染、正则、序列化）。<strong>分不清这两件事，就会去优化错的地方</strong>——比如给一个 CPU 只花 5ms 的页面做&quot;减少字符串拼接&quot;。</p>
<h2 id="九-回头看-这次改动到底改对了什么"><a class="h-anchor" href="#九-回头看-这次改动到底改对了什么">#</a>九、回头看，这次改动到底改对了什么</h2>
<p>把数字按因果拆开：</p>
<div class="table-wrap"><table><thead><tr><th>从</th><th>到</th><th>原因</th><th>能不能靠代码复制</th></tr></thead><tbody><tr><td>549ms</td><td>180ms</td><td>冷 isolate 转热（部署后第一发：建连接、站点设置缓存为空、预编译语句还没热）</td><td>不能。这是平台行为，只能靠&quot;别在冷启动时判断性能&quot;</td></tr><tr><td>180ms</td><td>84ms</td><td>五次串行往返 → 一次</td><td>能。数 <code>await</code> 的个数就行</td></tr><tr><td>84ms</td><td>4ms</td><td>缓存命中</td><td>能，但代价是内容更新的延迟（我们用主动清缓存补上）</td></tr></tbody></table></div>
<p>那次提交真正教会我的不是 <code>Promise.all</code> 的写法——那个谁都会——而是<strong>怎么判断一页该有几次往返</strong>：</p>
<ol><li>把这页要的数据列出来；</li><li>画依赖箭头：谁的结果是谁的输入；</li><li>没有箭头指向它的，全部并发；</li><li>有箭头指向它的，串行，且放在越后面越好；</li><li>能从 SQL 里一次带出来的，别发第二次（<code>GROUP_CONCAT</code> 那一条）。</li></ol>
<p>按这个流程数，一页 HTML 的往返次数应该等于<strong>依赖链的深度</strong>，不是查询的条数。<code>/cat/tools</code> 的依赖深度是 1，理想值就是 1 次——现在做到了。文章页理论上也是 1（正文取到之后其余全部无关），但当时被「必须先有 id」卡成了 2；把绑定参数换成 slug 之后才真的落到 1 次，86ms。</p>
<p>这个流程有个前提：<strong>只数真正会执行的往返</strong>。<code>await</code> 摆在代码里不代表这次请求会走它——它可能在 <code>if</code> 里，可能被进程内缓存挡住。我最初数错就是因为没区分这两件事。</p>
<p>至于标题里那个 549 → 96：数字是真的，但它跨了两个实验。写成&quot;我只改了一件事&quot;会让人以为并发能省 450ms，然后照着做一遍发现只省了 90ms，最后得出&quot;网上文章都是假的&quot;的结论。</p>
<p><strong>一页 CPU 只花 5ms、却要 180ms 才吐出来，问题一定不在你的代码里，在你等的那几次网络里。</strong> 先把 <code>await</code> 的个数数清楚，再谈优化。</p>', updated_at = '2026-11-25 11:55:48' WHERE slug = 'worker-render-549-to-96';
SELECT slug, instr(html_content, '/p/three-layer-cache') AS link_at, length(html_content) AS len, updated_at FROM posts WHERE slug = 'worker-render-549-to-96';

UPDATE posts SET content = '## 结论

`isPartOf` 里的 `url` 填的是文章自己的地址。

```json
"isPartOf": {
  "@type": "CreativeWorkSeries",
  "name": "OAuth 授权流程拆解",
  "url": "https://exia.de5.net/p/oauth-pkce"
}
```

这句话的语义是：`/p/oauth-pkce` 这一篇，属于一个叫「OAuth 授权流程拆解」的系列，而这个系列的地址就是 `/p/oauth-pkce` 自己。四篇系列文，四段一模一样的自指声明，从系列机制上线那天写进去，一直到 11-14 才被发现。

它没被发现的理由很具体：**自指 url 是一个能打开、返回 200 的合法地址**。所有靠「链接是否可达」判断的检查都会放行，人工点开也看不出异常，JSON-LD 本身又不渲染给人看。语法对的、引用活的、语义错的——这一类错误只有专门写断言才抓得到。

真正的原因还不在 `seo.js`。站上 14 篇文章里有 6 篇的 `series` 字段是空的，系列组件拿不到数据，压根没渲染过。`isPartOf` 只在有系列的那 8 篇上输出，全站 8 段自指。补数据、建系列页、改地址，是三件事，不是一件。

修完上线，我自己又引入了一个更严重的坑：系列里只有 1 篇公开文章时，系列块和兜底导航同时不渲染，那篇文章彻底没有出口，比修之前还糟。

## 一、那行代码长什么样

`src/seo.js` 的 `postLd()` 负责文章页的 JSON-LD。改动前是这样：

```js
// src/seo.js，0f11e80 之前
isPartOf: post.series
  ? { ''@type'': ''CreativeWorkSeries'', name: post.series, url: `${origin}/p/${encodeURIComponent(post.slug)}` }
  : `${origin}/#website`,
```

写成这样几乎是必然的。写这段代码的时候，手边只有三个东西：`origin`、`post.slug`、`post.series`。`post.series` 是个字符串，不是地址；而 `url` 这个字段名要求一个地址。于是最近的、唯一现成拼得出来的地址，就是当前文章的地址。

同一个文件里，`listLd()` 也拼过同样的地址——那里是对的，列表页列出来的每个条目，地址就是它自己。区别在于位置：`isPartOf` 要的不是「这篇在哪」，是「这个系列在哪」。字段名里那个 `Part` 把方向说清楚了，写的时候没往这上面想。

这种情况有个特征：**复制粘贴不会报错，只会把语义悄悄改掉**。改完的版本：

```js
// src/seo.js，0f11e80
// 系列内序号。schema.org 的 position 定义就是「在系列/序列中的位置」，
// 挂在文章节点上比塞进 isPartOf 里更贴规范（后者没有 position 这个属性位）。
position: post.series && post.series_order > 0 ? post.series_order : undefined,
// url 必须指向系列页本身：以前这里填的是当前文章地址，等于声明
// 「这个系列就长在这篇文章上」，系列页建起来之前是个自指的假地址。
isPartOf: post.series
  ? {
      ''@type'': ''CreativeWorkSeries'',
      name: post.series,
      url: `${origin}/series/${encodeURIComponent(post.series)}`,
    }
  : `${origin}/#website`,
```

还有一个细节：`position` 从 `isPartOf` 里挪到了 `BlogPosting` 上。schema.org 给 `position` 的定义是「在系列/序列中的位置」，它属于被排序的那个条目（这里是文章），不属于容器。之前的写法把序号塞在系列对象里，读起来像「这个系列排第一」，正好反了。

## 二、自指在语义上等于什么

把三元组摊开看，旧版声明的是：

| 主体 | 谓词 | 客体 |
|---|---|---|
| `/p/oauth-pkce`（文章） | `isPartOf` | 一个系列，名字「OAuth 授权流程拆解」，地址 `/p/oauth-pkce` |

客体带着和主体完全相同的地址，还自报了 `@type: CreativeWorkSeries`。等于说「这篇博客文章是一个系列，这个系列就是这篇博客文章」。

搜索引擎要怎么处理这段，我没有在索引层面验证过，只能说到推断为止：它拿不到一个可以合并四篇文章的容器节点。四篇各自声明「我属于一个系列，那个系列的地址是我自己」，四个系列实体，互相之间没有边，`position` 也失去了可比较的父节点。`hasPart`（系列包含哪些篇）从来没出现过——因为文章端不写，系列端又不存在。

对比现在的形状，两份数据是能咬合的：

```text
// /p/oauth-pkce
{ "@type": "BlogPosting", "position": 2,
  "isPartOf": { "@type": "CreativeWorkSeries", "name": "OAuth 授权流程拆解", "url": "https://exia.de5.net/series/OAuth%20..." } }

// /series/OAuth 授权流程拆解
{ "@type": "CreativeWorkSeries", "@id": ".../series/OAuth%20...#series", "numberOfEpisodes": 4,
  "hasPart": [ { "position": 1, "url": "/p/oauth-auth-code" }, { "position": 2, "url": "/p/oauth-pkce" }, ... ] }
```

一边指过去，一边列回来，`numberOfEpisodes` 和实际条数一致。这才是能被当成一个整体处理的结构。

顺带一个副产品：`isPartOf` 指向的地址以前是文章自己，现在是一个真实存在的页面。**结构化数据里的 url 一旦 404，比不写更糟**——搜索引擎会认为这个实体已失效。所以建系列页不是「顺便做的美化」，是改这个字段的前置条件。顺序不能反。

## 三、三类错误，只有一类需要自己写断言

这一节是这件事唯一值得记下来的部分。JSON-LD 的错误分三层，抓法完全不同：

| 层级 | 典型错误 | 谁能抓到 | 本站这次的命中情况 |
|---|---|---|---|
| 语法 | 多一个逗号、`</script>` 被提前闭合、`JSON.parse` 失败 | 任何 JSON 校验；甚至浏览器控制台会报 | 0 处 |
| 引用 | `url` / `image` / `@id` 指向 404 | 死链扫描、爬虫报告 | 0 处 |
| 语义 | 自指、`position` 与实际次序不符、`headline` 与 `<h1>` 不一致、`numberOfEpisodes` 和 `hasPart` 长度不符 | **只有自己写断言** | 8 处自指，一直没人知道 |

自指落在第三层，所以它同时躲过了三种检查：

1. **人眼**。JSON-LD 不渲染。文章页看上去一切正常，系列目录也在，四篇之间的链接也在。
2. **死链检测**。`/p/oauth-pkce` 返回 200，它当然返回 200，它就是当前页。
3. **富媒体测试工具**。Google 的 Rich Results Test 对 `BlogPosting` 报的是「未检测到富媒体内容」，这不是错误，是「这类页面本来就没有富媒体」。它不会告诉你 `isPartOf.url` 指回了自己——这一条我没有逐页跑过 Search Console，只到推断为止。

第四个原因更实在：**`postLd()` 从来没有测试**。15 篇文章上线，这个函数输出的五个字段全靠肉眼。这轮补的 5 条用例，是它第一次被断言：

```js
test(''isPartOf 指向 /series/<名称>，不是文章自己'', () => {
  const j = postLd({ post: { ...base, series: ''OAuth 授权流程拆解'', series_order: 2 }, ...ctx });
  const art = j[''@graph''][0];
  equal(art.isPartOf.url, `${origin}/series/${encodeURIComponent(''OAuth 授权流程拆解'')}`);
  ok(!art.isPartOf.url.includes(art.url.split(''/p/'')[1]), ''url 不能包含自己的 slug'');
});
```

最后那行 `ok(!...)` 是这组用例里唯一有价值的一条。断言「等于某个期望值」会随实现漂移；断言「不能等于自己」是这类错误的形状本身。

## 四、真因：不是 `seo.js`，是 10 篇没有系列归属

发现问题的路径是这样的：先怀疑系列导航缺失，去线上抓了五篇文章，数 `class="series"` 的出现次数。`oauth-pkce` 有，`sticky-toc-grid-align-items` 和 `comment-anti-spam` 没有。当时的判断是「`.series-jump` 是一段写完样式没接上功能的死代码」。

查下去发现不是。`renderSeries()` 在 `oauth-pkce` 上一直在渲染，`series-jump` 的样式也在用。那两篇没有，是因为它们没有 `series`：

| 指标 | 改前 | 改后 |
|---|---|---|
| 已发布文章 | 14 | 14 |
| 有 `series` 的文章 | 8 | 11 |
| 系列数（库内） | 2 | 6 |
| 可见系列页 | 2 | 4（两组整组未到发布时间） |
| 线上自指的 `isPartOf` | 8 | 0 |

8 篇全是 OAuth 四部曲和 Cloudflare 踩坑四篇——这两个系列是最早建的，当时顺手填了 `series`。剩下 6 篇已发的（编辑器两篇、R2、评论、友链、目录 sticky）谁都没填，另外还有 4 篇预排文章（性能、三层缓存、免费额度、存储延迟）也是空的。加起来 10 篇。About 那页同样为空，但它是静态页，不该进系列，不算在里面。

组件这边还有一道闸：`renderSeries()` 第一行就是 `if (!list || list.length < 2) return '''';`。所以只要某篇的 `series` 只有它自己，系列块就不出。这道闸本身是对的（1 篇的「系列目录」没有意义），但它把「没数据」和「数据只有一条」两种状态压成了同一个结果：什么都没有。

## 五、补的三件事

**第一件，补归属。** 三个新系列，把 10 篇里的 7 篇收进去（3 篇已发 + 4 篇预排）：

| 系列 | 成员 |
|---|---|
| 自建博客排障记 | 目录 sticky 失效 / 渲染 549→96ms / 三层缓存 |
| Workers 成本核算 | 免费额度换算 / D1-KV-R2 延迟实测 |
| 编辑器实战 | 自动保存双保险 / Markdown 渲染白名单 |

剩下三篇（友链检测、R2 图片链路、评论防滥用）没硬凑。系列的前提是「有先后顺序、读完一篇想读下一篇」，这三篇是并列的工具文，塞进任何系列都是假连载。

**第二件，建页面。** `/series` 汇总页和 `/series/<名称>` 明细页，都是 Worker 直出：

```js
async function serveSeriesPage(env, request, name) {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, series_order, published_at, created_at FROM posts
     WHERE series = ? AND is_private = 0 AND hidden = 0 AND ${liveSql(''posts'')}
     ORDER BY series_order ASC, created_at ASC`
  ).bind(name).all();

  if (!results.length) return await notFoundPage(env, request, ''没有这个系列'');
  // ...
  numberOfEpisodes: results.length,
  hasPart: results.map((p, i) => ({
    ''@type'': ''BlogPosting'',
    position: p.series_order > 0 ? p.series_order : i + 1,
    name: p.title,
    url: `${origin}/p/${encodeURIComponent(p.slug)}`,
  })),
}
```

注意 `liveSql(''posts'')`——系列页也走时间闸门。这一条不是顺手加的：站上有 9 篇预排文章 `hidden=0`、`published_at` 在未来，系列页如果只按 `hidden` 过滤，`/series/认证边界` 会立刻把四篇没发布的东西列出来。上线后实测这两个系列页都是 404，sitemap 里也没有。

**第三件，改地址 + 上移 `position`。** 就是第一节那段代码。同时系列块里的系列名从纯文本改成链接，指向系列页——不然文章端指过去，读者点不了。

改完 sitemap 从 39 条变 44 条：15 篇文章 + 16 个标签 + 5 个系列（1 个总览 + 4 个明细）+ 4 个栏目 + 4 个单页。系列页进 sitemap 是必须的，它没有别的入口——顶栏放不下第 6 个导航项，640px 会溢出。

还有一处容易漏：`isPagePath()` 是边缘缓存的开关，只认白名单里的路径。新页面不加进去，每次请求都会打到 D1 再渲染一遍，和改造前一样慢。

```js
const isPagePath = (p) =>
  p === ''/'' || p === ''/archive'' || p === ''/categories'' || p === ''/friends'' ||
  p === ''/series'' || p.startsWith(''/series/'') ||
  p.startsWith(''/tag/'') || p.startsWith(''/cat/'') || p.startsWith(''/p/'');
```

加页面的时候顺手想一下它该不该进这个白名单。系列页是纯静态输出（只依赖库里的文章），应该进；如果哪天做一个带登录态的页面，就不能进。

## 六、修完立刻踩到的第二个洞

部署后跑复验，`sticky-toc-grid-align-items` 上 `class="series"` 和 `class="post-adjacent"` 都是 0。**两块都不渲染。**

原因是我自己写的那段兜底导航：

```js
// 非系列文的兜底导航：同栏目按时间排，取前后各一篇。
function renderAdjacent(post, list) {
  if (post.series) return '''';   // ← 有系列就不出兜底
  // ...
}
```

逻辑本来是「系列文有系列块顶着，不需要兜底」。但 `renderSeries()` 要求同系列 ≥2 篇才渲染。那个时刻「自建博客排障记」只有 sticky-toc 一篇公开（549→96 排在 11-18，「[三层缓存](/p/three-layer-cache)」排在 11-25），于是：

- `renderSeries` 看到 `list.length === 1`，返回空字符串
- `renderAdjacent` 看到 `post.series` 非空，返回空字符串

那篇文章底部什么都没有，比改之前更糟——改之前至少还有栏目页可退。这类 bug 的特征是**只在数据边界上出现**：系列 2 篇以上、或者 0 篇，都正常；偏偏 1 篇时两块同时消失。

改法是让兜底判断跟着「系列块是否真的渲染」，而不是跟着「有没有系列」：

```js
function renderAdjacent(post, list, seriesList) {
  if (post.series && seriesList && seriesList.length > 1) return '''';
  // ...
}
```

判断条件必须和上游的渲染条件一致，不能各写一套「我认为对方会渲染」。

## 七、验收脚本的第三次自指

写端到端验收时又栽了一次，这次错在检查工具本身。

脚本里用正则抓 JSON-LD：

```js
const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
```

线上抓到 0 块，断言全红，报了两条「没有结构化数据」。实际页面里是：

```html
<script nonce="ZDU1Y2..." type="application/ld+json">
```

`applyNonce()` 会给所有 `<script>` 插 nonce 属性（CSP 要求），属性顺序也不保证。正则把标签写死成 `type` 紧跟 `>`，自然一个都匹配不到。

改成 `<script[^>]*type="application\/ld\+json"[^>]*>` 就好了。但值得记的是**报错的方向**：断言失败说「页面没有结构化数据」，真实情况是「我的采集坏了」。如果这时候去改页面，就会去修一个不存在的问题。

教训很短：断言失败时，先确认采集到了东西，再确认内容对不对。`if (blocks.length === 0) throw new Error(''采集失败'')` 和 `if (!h.includes(''CreativeWorkSeries'')) throw ...` 是两种完全不同性质的失败，不能共用一个报错文案。

## 八、现在的结果

写了个体检脚本 `scripts/check-ld.mjs`，从 sitemap 取出全部文章页，逐篇校验四件事：JSON-LD 能否 `JSON.parse`、`headline` 是否等于页面 `<h1>`、`isPartOf.url` 是否真的能打开且返回 `CreativeWorkSeries`、`position` 是否与该文在系列页里的实际次序一致。

```text
slug                           JSON-LD   headline  isPartOf       position
sticky-toc-grid-align-items    ok        ok        200 +Series    1/1 声明1
editor-autosave                ok        ok        200 +Series    1/2 声明1
editor-markdown-xss            ok        ok        200 +Series    2/2 声明2
oauth-auth-code                ok        ok        200 +Series    1/4 声明1
oauth-pkce                     ok        ok        200 +Series    2/4 声明2
oauth-device-flow              ok        ok        200 +Series    3/4 声明3
oauth-token-lifecycle          ok        ok        200 +Series    4/4 声明4
d1-no-such-table               ok        ok        200 +Series    1/4 声明1
wrangler-deploy-errors         ok        ok        200 +Series    2/4 声明2
workers-io-different-request   ok        ok        200 +Series    3/4 声明3
workers-subrequest-limit       ok        ok        200 +Series    4/4 声明4
comment-anti-spam              ok        ok        站点级          -
r2-image-pipeline              ok        ok        站点级          -
worker-cron-friend-check       ok        ok        站点级          -
about                          ok        ok        站点级          -

15 篇，坏 0 篇，耗时 3479ms
```

`sticky-toc` 那行是 `1/1`——它所在系列此刻确实只有 1 篇公开，正好是第六节那个边界状态。系列块不渲染，兜底导航接管，页面有出口。

同一个脚本如果只查「url 能不能打开」，改之前跑会是全绿：`isPartOf.url` 打开的是文章自己，200。**引用可达这一条根本抓不到自指**。

现在的版本靠两处抓它。第一处是显式比较：

```js
// url 等于本篇地址时，后面所有检查都会以 200 放行
if (part.url === art.url) {
  row.partOf = ''自指'';
  rows.push(row);
  continue;
}
```

第二处是语义比对：从系列页 HTML 里按 `<a href="/p/...">` 抽次序，找自己，`position` 必须等于那个次序。自指的 url 返回的是文章页，抽出来的次序里没有自己，于是判「不在系列页」。

这也是第二次「报错方向不对」：改之前跑，这一条确实会红，但红的是「不在系列页」，而不是「url 指向了自己」。同一个事实，两种描述，后一种要人再往回追一步才想得到。所以第一处那个显式比较不能省——它让报错直接说出原因。

单元测试现在是 88 条全绿，其中 5 条专测 `postLd()`——在这轮之前，这个函数一条用例都没有。`git grep postLd 0f11e80^ -- scripts/` 返回空，就是证据。

## 九、这类错误的一般形态

把这次的两处（`isPartOf` 自指、兜底导航的双空）放在一起，形状是一样的：**两个本该咬合的东西，各自都合法，合起来是错的**。

`isPartOf.url` 单独看是个合法 URL，`CreativeWorkSeries` 单独看是个合法的类型名，拼起来变成一个声称「我是我自己的系列」的节点。`renderSeries` 和 `renderAdjacent` 单独看都正确，组合起来让一篇文章失去全部出口。

所以这类问题的验收不能靠「看每一处对不对」，只能靠「查两个东西对不对得上」。落到结构化数据上，具体就这几条：

| 字段 | 断言 | 出错时的样子 |
|---|---|---|
| `isPartOf.url` | 不等于本篇 `url` | 自指，200，工具全放行 |
| `isPartOf.url` | 打开后含 `CreativeWorkSeries` | 指向文章页或 404 |
| `position` | 等于在系列页中的实际次序 | 序号重复或断号，看不出 |
| `numberOfEpisodes` | 等于 `hasPart` 长度 | 系列页漏算了未发布文章时最常发生 |
| `headline` | 等于页面 `<h1>` | 改标题只改了一处 |
| 系列块 / 兜底导航 | 至少一个渲染 | 单篇系列时两块同时消失 |

其中最容易被忽略的是最后一行。它不是结构化数据问题，但它和第一行是同一个毛病：**判断条件写在了两个地方，各自都自洽**。

## 十、两个刻意的取舍

**`/series` 没有进顶栏。** 现在顶栏 5 项，第 6 项在 640px 会把站名挤成 `Exia Bl…`——这个坑十月份刚修过一次，不想为一个入口再动手机端布局。所以系列页的入口是三处：每篇系列文顶部的系列名、各系列页页脚的互链、sitemap。读者从文章进系列是最自然的路径，从首页找系列本来就不是常见动作。

**没有把 15 篇全塞进系列。** 判据只有一条：**有没有先后顺序**。「目录不跟着滚 → 渲染 549ms → 三层缓存」是同一个站在不同阶段的排障，后一篇用得上前一篇的结论；「友链检测 / R2 图片链路 / 评论防滥用」是三件并列的工具，谁也不依赖谁，硬凑成「站内功能三部曲」只会让系列目录变成第二个栏目页。系列的价值在于「读完这篇该读哪篇」，不在于「把文章分组」。

相关：这一轮同时动的布局与暗色层次，写在[《目录不跟着滚：sticky 在 grid 里失效》](/p/sticky-toc-grid-align-items)和[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)里；系列机制最早是在[《OAuth：为什么要绕一个 302》](/p/oauth-auth-code)那批稿子里立起来的，那批稿子也是这次 8 段自指的全部来源。

还有一条没做：这个体检脚本没有挂进 CI，是手动跑的。挂进去的代价是要在 CI 里访问线上站点（构建阶段站可能还没部署），收益是每次改 `seo.js` 自动验一遍。现在改成手动跑，是因为改动频率低——一个月动两次的东西，加一条流水线的维护成本比收益高。等它真出第二次问题再说。

## 怎么自己验一遍

```bash
# 1. 体检线上全部文章的 JSON-LD（含引用可达、position 一致、headline 一致）
node scripts/check-ld.mjs

# 2. 只看某一篇的 isPartOf，确认 url 不是它自己
node --input-type=module -e "const h=await(await fetch(''https://exia.de5.net/p/oauth-pkce'')).text();
  const j=JSON.parse(h.match(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/)[1]);
  console.log(j[''@graph''][0].isPartOf)"

# 3. 确认系列页地址真实存在且带 number/hasPart
curl -s "https://exia.de5.net/series/OAuth%20%E6%8E%88%E6%9D%83%E6%B5%81%E7%A8%8B%E6%8B%86%E8%A7%A3" \
  | grep -oE ''numberOfEpisodes":[0-9]+|"position":[0-9]+'' | head

# 4. 单元测试里的形状断言（不要只断言等于某个值）
npm test 2>&1 | grep -A2 "isPartOf"
```

手动那一步：把文章页地址粘进 Google Rich Results Test，看它识别出的是什么类型、`isPartOf` 有没有被展开。这一步只能看到「解析结果」，看不到语义对错——自指的 url 在那里同样是一个正常的链接。

要判断语义，只有一条路：把 url 打开，看里面有没有那个系列本身。

同一族还有一个更安静的：`sitemap` 的 `<lastmod>` 会早于页面里的 `datePublished`。两个字段出自同一条记录、同一个 Worker，却声明了相反的先后 —— 页面照样 200，XML 照样合法，没有任何工具报警。那篇写完再回来补链接。
', html_content = '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p><code>isPartOf</code> 里的 <code>url</code> 填的是文章自己的地址。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">json</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-json"><span class="tok-s">&quot;isPartOf&quot;</span>: {
  <span class="tok-s">&quot;@type&quot;</span>: <span class="tok-s">&quot;CreativeWorkSeries&quot;</span>,
  <span class="tok-s">&quot;name&quot;</span>: <span class="tok-s">&quot;OAuth 授权流程拆解&quot;</span>,
  <span class="tok-s">&quot;url&quot;</span>: <span class="tok-s">&quot;https://exia.de5.net/p/oauth-pkce&quot;</span>
}</code></pre></div>
<p>这句话的语义是：<code>/p/oauth-pkce</code> 这一篇，属于一个叫「OAuth 授权流程拆解」的系列，而这个系列的地址就是 <code>/p/oauth-pkce</code> 自己。四篇系列文，四段一模一样的自指声明，从系列机制上线那天写进去，一直到 11-14 才被发现。</p>
<p>它没被发现的理由很具体：<strong>自指 url 是一个能打开、返回 200 的合法地址</strong>。所有靠「链接是否可达」判断的检查都会放行，人工点开也看不出异常，JSON-LD 本身又不渲染给人看。语法对的、引用活的、语义错的——这一类错误只有专门写断言才抓得到。</p>
<p>真正的原因还不在 <code>seo.js</code>。站上 14 篇文章里有 6 篇的 <code>series</code> 字段是空的，系列组件拿不到数据，压根没渲染过。<code>isPartOf</code> 只在有系列的那 8 篇上输出，全站 8 段自指。补数据、建系列页、改地址，是三件事，不是一件。</p>
<p>修完上线，我自己又引入了一个更严重的坑：系列里只有 1 篇公开文章时，系列块和兜底导航同时不渲染，那篇文章彻底没有出口，比修之前还糟。</p>
<h2 id="一-那行代码长什么样"><a class="h-anchor" href="#一-那行代码长什么样">#</a>一、那行代码长什么样</h2>
<p><code>src/seo.js</code> 的 <code>postLd()</code> 负责文章页的 JSON-LD。改动前是这样：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/seo.js，0f11e80 之前</span>
isPartOf: post.series
  ? { <span class="tok-s">&#39;@type&#39;</span>: <span class="tok-s">&#39;CreativeWorkSeries&#39;</span>, name: post.series, url: <span class="tok-s">`${origin}/p/${encodeURIComponent(post.slug)}`</span> }
  : <span class="tok-s">`${origin}/#website`</span>,</code></pre></div>
<p>写成这样几乎是必然的。写这段代码的时候，手边只有三个东西：<code>origin</code>、<code>post.slug</code>、<code>post.series</code>。<code>post.series</code> 是个字符串，不是地址；而 <code>url</code> 这个字段名要求一个地址。于是最近的、唯一现成拼得出来的地址，就是当前文章的地址。</p>
<p>同一个文件里，<code>listLd()</code> 也拼过同样的地址——那里是对的，列表页列出来的每个条目，地址就是它自己。区别在于位置：<code>isPartOf</code> 要的不是「这篇在哪」，是「这个系列在哪」。字段名里那个 <code>Part</code> 把方向说清楚了，写的时候没往这上面想。</p>
<p>这种情况有个特征：<strong>复制粘贴不会报错，只会把语义悄悄改掉</strong>。改完的版本：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/seo.js，0f11e80</span>
<span class="tok-c">// 系列内序号。schema.org 的 position 定义就是「在系列/序列中的位置」，</span>
<span class="tok-c">// 挂在文章节点上比塞进 isPartOf 里更贴规范（后者没有 position 这个属性位）。</span>
position: post.series &amp;&amp; post.series_order &gt; <span class="tok-n">0</span> ? post.series_order : <span class="tok-k">undefined</span>,
<span class="tok-c">// url 必须指向系列页本身：以前这里填的是当前文章地址，等于声明</span>
<span class="tok-c">// 「这个系列就长在这篇文章上」，系列页建起来之前是个自指的假地址。</span>
isPartOf: post.series
  ? {
      <span class="tok-s">&#39;@type&#39;</span>: <span class="tok-s">&#39;CreativeWorkSeries&#39;</span>,
      name: post.series,
      url: <span class="tok-s">`${origin}/series/${encodeURIComponent(post.series)}`</span>,
    }
  : <span class="tok-s">`${origin}/#website`</span>,</code></pre></div>
<p>还有一个细节：<code>position</code> 从 <code>isPartOf</code> 里挪到了 <code>BlogPosting</code> 上。schema.org 给 <code>position</code> 的定义是「在系列/序列中的位置」，它属于被排序的那个条目（这里是文章），不属于容器。之前的写法把序号塞在系列对象里，读起来像「这个系列排第一」，正好反了。</p>
<h2 id="二-自指在语义上等于什么"><a class="h-anchor" href="#二-自指在语义上等于什么">#</a>二、自指在语义上等于什么</h2>
<p>把三元组摊开看，旧版声明的是：</p>
<div class="table-wrap"><table><thead><tr><th>主体</th><th>谓词</th><th>客体</th></tr></thead><tbody><tr><td><code>/p/oauth-pkce</code>（文章）</td><td><code>isPartOf</code></td><td>一个系列，名字「OAuth 授权流程拆解」，地址 <code>/p/oauth-pkce</code></td></tr></tbody></table></div>
<p>客体带着和主体完全相同的地址，还自报了 <code>@type: CreativeWorkSeries</code>。等于说「这篇博客文章是一个系列，这个系列就是这篇博客文章」。</p>
<p>搜索引擎要怎么处理这段，我没有在索引层面验证过，只能说到推断为止：它拿不到一个可以合并四篇文章的容器节点。四篇各自声明「我属于一个系列，那个系列的地址是我自己」，四个系列实体，互相之间没有边，<code>position</code> 也失去了可比较的父节点。<code>hasPart</code>（系列包含哪些篇）从来没出现过——因为文章端不写，系列端又不存在。</p>
<p>对比现在的形状，两份数据是能咬合的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">// /p/oauth-pkce
{ &quot;@type&quot;: &quot;BlogPosting&quot;, &quot;position&quot;: 2,
  &quot;isPartOf&quot;: { &quot;@type&quot;: &quot;CreativeWorkSeries&quot;, &quot;name&quot;: &quot;OAuth 授权流程拆解&quot;, &quot;url&quot;: &quot;https://exia.de5.net/series/OAuth%20...&quot; } }

// /series/OAuth 授权流程拆解
{ &quot;@type&quot;: &quot;CreativeWorkSeries&quot;, &quot;@id&quot;: &quot;.../series/OAuth%20...#series&quot;, &quot;numberOfEpisodes&quot;: 4,
  &quot;hasPart&quot;: [ { &quot;position&quot;: 1, &quot;url&quot;: &quot;/p/oauth-auth-code&quot; }, { &quot;position&quot;: 2, &quot;url&quot;: &quot;/p/oauth-pkce&quot; }, ... ] }</code></pre></div>
<p>一边指过去，一边列回来，<code>numberOfEpisodes</code> 和实际条数一致。这才是能被当成一个整体处理的结构。</p>
<p>顺带一个副产品：<code>isPartOf</code> 指向的地址以前是文章自己，现在是一个真实存在的页面。<strong>结构化数据里的 url 一旦 404，比不写更糟</strong>——搜索引擎会认为这个实体已失效。所以建系列页不是「顺便做的美化」，是改这个字段的前置条件。顺序不能反。</p>
<h2 id="三-三类错误-只有一类需要自己写断言"><a class="h-anchor" href="#三-三类错误-只有一类需要自己写断言">#</a>三、三类错误，只有一类需要自己写断言</h2>
<p>这一节是这件事唯一值得记下来的部分。JSON-LD 的错误分三层，抓法完全不同：</p>
<div class="table-wrap"><table><thead><tr><th>层级</th><th>典型错误</th><th>谁能抓到</th><th>本站这次的命中情况</th></tr></thead><tbody><tr><td>语法</td><td>多一个逗号、<code>&lt;/script&gt;</code> 被提前闭合、<code>JSON.parse</code> 失败</td><td>任何 JSON 校验；甚至浏览器控制台会报</td><td>0 处</td></tr><tr><td>引用</td><td><code>url</code> / <code>image</code> / <code>@id</code> 指向 404</td><td>死链扫描、爬虫报告</td><td>0 处</td></tr><tr><td>语义</td><td>自指、<code>position</code> 与实际次序不符、<code>headline</code> 与 <code>&lt;h1&gt;</code> 不一致、<code>numberOfEpisodes</code> 和 <code>hasPart</code> 长度不符</td><td><strong>只有自己写断言</strong></td><td>8 处自指，一直没人知道</td></tr></tbody></table></div>
<p>自指落在第三层，所以它同时躲过了三种检查：</p>
<ol><li><strong>人眼</strong>。JSON-LD 不渲染。文章页看上去一切正常，系列目录也在，四篇之间的链接也在。</li><li><strong>死链检测</strong>。<code>/p/oauth-pkce</code> 返回 200，它当然返回 200，它就是当前页。</li><li><strong>富媒体测试工具</strong>。Google 的 Rich Results Test 对 <code>BlogPosting</code> 报的是「未检测到富媒体内容」，这不是错误，是「这类页面本来就没有富媒体」。它不会告诉你 <code>isPartOf.url</code> 指回了自己——这一条我没有逐页跑过 Search Console，只到推断为止。</li></ol>
<p>第四个原因更实在：<strong><code>postLd()</code> 从来没有测试</strong>。15 篇文章上线，这个函数输出的五个字段全靠肉眼。这轮补的 5 条用例，是它第一次被断言：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">test</span>(<span class="tok-s">&#39;isPartOf 指向 /series/&lt;名称&gt;，不是文章自己&#39;</span>, () =&gt; {
  <span class="tok-k">const</span> j = <span class="tok-f">postLd</span>({ post: { ...base, series: <span class="tok-s">&#39;OAuth 授权流程拆解&#39;</span>, series_order: <span class="tok-n">2</span> }, ...ctx });
  <span class="tok-k">const</span> art = j[<span class="tok-s">&#39;@graph&#39;</span>][<span class="tok-n">0</span>];
  <span class="tok-f">equal</span>(art.isPartOf.url, <span class="tok-s">`${origin}/series/${encodeURIComponent(&#39;OAuth 授权流程拆解&#39;)}`</span>);
  <span class="tok-f">ok</span>(!art.isPartOf.url.<span class="tok-f">includes</span>(art.url.<span class="tok-f">split</span>(<span class="tok-s">&#39;/p/&#39;</span>)[<span class="tok-n">1</span>]), <span class="tok-s">&#39;url 不能包含自己的 slug&#39;</span>);
});</code></pre></div>
<p>最后那行 <code>ok(!...)</code> 是这组用例里唯一有价值的一条。断言「等于某个期望值」会随实现漂移；断言「不能等于自己」是这类错误的形状本身。</p>
<h2 id="四-真因-不是-seo-js-是-10-篇没有系列归属"><a class="h-anchor" href="#四-真因-不是-seo-js-是-10-篇没有系列归属">#</a>四、真因：不是 <code>seo.js</code>，是 10 篇没有系列归属</h2>
<p>发现问题的路径是这样的：先怀疑系列导航缺失，去线上抓了五篇文章，数 <code>class=&quot;series&quot;</code> 的出现次数。<code>oauth-pkce</code> 有，<code>sticky-toc-grid-align-items</code> 和 <code>comment-anti-spam</code> 没有。当时的判断是「<code>.series-jump</code> 是一段写完样式没接上功能的死代码」。</p>
<p>查下去发现不是。<code>renderSeries()</code> 在 <code>oauth-pkce</code> 上一直在渲染，<code>series-jump</code> 的样式也在用。那两篇没有，是因为它们没有 <code>series</code>：</p>
<div class="table-wrap"><table><thead><tr><th>指标</th><th>改前</th><th>改后</th></tr></thead><tbody><tr><td>已发布文章</td><td>14</td><td>14</td></tr><tr><td>有 <code>series</code> 的文章</td><td>8</td><td>11</td></tr><tr><td>系列数（库内）</td><td>2</td><td>6</td></tr><tr><td>可见系列页</td><td>2</td><td>4（两组整组未到发布时间）</td></tr><tr><td>线上自指的 <code>isPartOf</code></td><td>8</td><td>0</td></tr></tbody></table></div>
<p>8 篇全是 OAuth 四部曲和 Cloudflare 踩坑四篇——这两个系列是最早建的，当时顺手填了 <code>series</code>。剩下 6 篇已发的（编辑器两篇、R2、评论、友链、目录 sticky）谁都没填，另外还有 4 篇预排文章（性能、三层缓存、免费额度、存储延迟）也是空的。加起来 10 篇。About 那页同样为空，但它是静态页，不该进系列，不算在里面。</p>
<p>组件这边还有一道闸：<code>renderSeries()</code> 第一行就是 <code>if (!list || list.length &lt; 2) return &#39;&#39;;</code>。所以只要某篇的 <code>series</code> 只有它自己，系列块就不出。这道闸本身是对的（1 篇的「系列目录」没有意义），但它把「没数据」和「数据只有一条」两种状态压成了同一个结果：什么都没有。</p>
<h2 id="五-补的三件事"><a class="h-anchor" href="#五-补的三件事">#</a>五、补的三件事</h2>
<p><strong>第一件，补归属。</strong> 三个新系列，把 10 篇里的 7 篇收进去（3 篇已发 + 4 篇预排）：</p>
<div class="table-wrap"><table><thead><tr><th>系列</th><th>成员</th></tr></thead><tbody><tr><td>自建博客排障记</td><td>目录 sticky 失效 / 渲染 549→96ms / 三层缓存</td></tr><tr><td>Workers 成本核算</td><td>免费额度换算 / D1-KV-R2 延迟实测</td></tr><tr><td>编辑器实战</td><td>自动保存双保险 / Markdown 渲染白名单</td></tr></tbody></table></div>
<p>剩下三篇（友链检测、R2 图片链路、评论防滥用）没硬凑。系列的前提是「有先后顺序、读完一篇想读下一篇」，这三篇是并列的工具文，塞进任何系列都是假连载。</p>
<p><strong>第二件，建页面。</strong> <code>/series</code> 汇总页和 <code>/series/&lt;名称&gt;</code> 明细页，都是 Worker 直出：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">serveSeriesPage</span>(env, request, name) {
  <span class="tok-k">const</span> { results } = <span class="tok-k">await</span> env.DB.<span class="tok-f">prepare</span>(
    <span class="tok-s">`SELECT slug, title, series_order, published_at, created_at FROM posts
     WHERE series = ? AND is_private = 0 AND hidden = 0 AND ${liveSql(&#39;posts&#39;)}
     ORDER BY series_order ASC, created_at ASC`</span>
  ).<span class="tok-f">bind</span>(name).<span class="tok-f">all</span>();

  <span class="tok-k">if</span> (!results.length) <span class="tok-k">return</span> <span class="tok-k">await</span> <span class="tok-f">notFoundPage</span>(env, request, <span class="tok-s">&#39;没有这个系列&#39;</span>);
  <span class="tok-c">// ...</span>
  numberOfEpisodes: results.length,
  hasPart: results.<span class="tok-f">map</span>((p, i) =&gt; ({
    <span class="tok-s">&#39;@type&#39;</span>: <span class="tok-s">&#39;BlogPosting&#39;</span>,
    position: p.series_order &gt; <span class="tok-n">0</span> ? p.series_order : i + <span class="tok-n">1</span>,
    name: p.title,
    url: <span class="tok-s">`${origin}/p/${encodeURIComponent(p.slug)}`</span>,
  })),
}</code></pre></div>
<p>注意 <code>liveSql(&#39;posts&#39;)</code>——系列页也走时间闸门。这一条不是顺手加的：站上有 9 篇预排文章 <code>hidden=0</code>、<code>published_at</code> 在未来，系列页如果只按 <code>hidden</code> 过滤，<code>/series/认证边界</code> 会立刻把四篇没发布的东西列出来。上线后实测这两个系列页都是 404，sitemap 里也没有。</p>
<p><strong>第三件，改地址 + 上移 <code>position</code>。</strong> 就是第一节那段代码。同时系列块里的系列名从纯文本改成链接，指向系列页——不然文章端指过去，读者点不了。</p>
<p>改完 sitemap 从 39 条变 44 条：15 篇文章 + 16 个标签 + 5 个系列（1 个总览 + 4 个明细）+ 4 个栏目 + 4 个单页。系列页进 sitemap 是必须的，它没有别的入口——顶栏放不下第 6 个导航项，640px 会溢出。</p>
<p>还有一处容易漏：<code>isPagePath()</code> 是边缘缓存的开关，只认白名单里的路径。新页面不加进去，每次请求都会打到 D1 再渲染一遍，和改造前一样慢。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> isPagePath = (p) =&gt;
  p === <span class="tok-s">&#39;/&#39;</span> || p === <span class="tok-s">&#39;/archive&#39;</span> || p === <span class="tok-s">&#39;/categories&#39;</span> || p === <span class="tok-s">&#39;/friends&#39;</span> ||
  p === <span class="tok-s">&#39;/series&#39;</span> || p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/series/&#39;</span>) ||
  p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/tag/&#39;</span>) || p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/cat/&#39;</span>) || p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/p/&#39;</span>);</code></pre></div>
<p>加页面的时候顺手想一下它该不该进这个白名单。系列页是纯静态输出（只依赖库里的文章），应该进；如果哪天做一个带登录态的页面，就不能进。</p>
<h2 id="六-修完立刻踩到的第二个洞"><a class="h-anchor" href="#六-修完立刻踩到的第二个洞">#</a>六、修完立刻踩到的第二个洞</h2>
<p>部署后跑复验，<code>sticky-toc-grid-align-items</code> 上 <code>class=&quot;series&quot;</code> 和 <code>class=&quot;post-adjacent&quot;</code> 都是 0。<strong>两块都不渲染。</strong></p>
<p>原因是我自己写的那段兜底导航：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 非系列文的兜底导航：同栏目按时间排，取前后各一篇。</span>
<span class="tok-k">function</span> <span class="tok-f">renderAdjacent</span>(post, list) {
  <span class="tok-k">if</span> (post.series) <span class="tok-k">return</span> <span class="tok-s">&#39;&#39;</span>;   <span class="tok-c">// ← 有系列就不出兜底</span>
  <span class="tok-c">// ...</span>
}</code></pre></div>
<p>逻辑本来是「系列文有系列块顶着，不需要兜底」。但 <code>renderSeries()</code> 要求同系列 ≥2 篇才渲染。那个时刻「自建博客排障记」只有 sticky-toc 一篇公开（549→96 排在 11-18，「<a href="/p/three-layer-cache">三层缓存</a>」排在 11-25），于是：</p>
<ul><li><code>renderSeries</code> 看到 <code>list.length === 1</code>，返回空字符串</li><li><code>renderAdjacent</code> 看到 <code>post.series</code> 非空，返回空字符串</li></ul>
<p>那篇文章底部什么都没有，比改之前更糟——改之前至少还有栏目页可退。这类 bug 的特征是<strong>只在数据边界上出现</strong>：系列 2 篇以上、或者 0 篇，都正常；偏偏 1 篇时两块同时消失。</p>
<p>改法是让兜底判断跟着「系列块是否真的渲染」，而不是跟着「有没有系列」：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">renderAdjacent</span>(post, list, seriesList) {
  <span class="tok-k">if</span> (post.series &amp;&amp; seriesList &amp;&amp; seriesList.length &gt; <span class="tok-n">1</span>) <span class="tok-k">return</span> <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-c">// ...</span>
}</code></pre></div>
<p>判断条件必须和上游的渲染条件一致，不能各写一套「我认为对方会渲染」。</p>
<h2 id="七-验收脚本的第三次自指"><a class="h-anchor" href="#七-验收脚本的第三次自指">#</a>七、验收脚本的第三次自指</h2>
<p>写端到端验收时又栽了一次，这次错在检查工具本身。</p>
<p>脚本里用正则抓 JSON-LD：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> re = /&lt;script type=<span class="tok-s">&quot;application\/ld\+json&quot;</span>&gt;([\s\S]*?)&lt;\/script&gt;/g;</code></pre></div>
<p>线上抓到 0 块，断言全红，报了两条「没有结构化数据」。实际页面里是：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">html</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-html">&lt;script nonce=<span class="tok-s">&quot;ZDU1Y2...&quot;</span> type=<span class="tok-s">&quot;application/ld+json&quot;</span>&gt;</code></pre></div>
<p><code>applyNonce()</code> 会给所有 <code>&lt;script&gt;</code> 插 nonce 属性（CSP 要求），属性顺序也不保证。正则把标签写死成 <code>type</code> 紧跟 <code>&gt;</code>，自然一个都匹配不到。</p>
<p>改成 <code>&lt;script[^&gt;]*type=&quot;application\/ld\+json&quot;[^&gt;]*&gt;</code> 就好了。但值得记的是<strong>报错的方向</strong>：断言失败说「页面没有结构化数据」，真实情况是「我的采集坏了」。如果这时候去改页面，就会去修一个不存在的问题。</p>
<p>教训很短：断言失败时，先确认采集到了东西，再确认内容对不对。<code>if (blocks.length === 0) throw new Error(&#39;采集失败&#39;)</code> 和 <code>if (!h.includes(&#39;CreativeWorkSeries&#39;)) throw ...</code> 是两种完全不同性质的失败，不能共用一个报错文案。</p>
<h2 id="八-现在的结果"><a class="h-anchor" href="#八-现在的结果">#</a>八、现在的结果</h2>
<p>写了个体检脚本 <code>scripts/check-ld.mjs</code>，从 sitemap 取出全部文章页，逐篇校验四件事：JSON-LD 能否 <code>JSON.parse</code>、<code>headline</code> 是否等于页面 <code>&lt;h1&gt;</code>、<code>isPartOf.url</code> 是否真的能打开且返回 <code>CreativeWorkSeries</code>、<code>position</code> 是否与该文在系列页里的实际次序一致。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">slug                           JSON-LD   headline  isPartOf       position
sticky-toc-grid-align-items    ok        ok        200 +Series    1/1 声明1
editor-autosave                ok        ok        200 +Series    1/2 声明1
editor-markdown-xss            ok        ok        200 +Series    2/2 声明2
oauth-auth-code                ok        ok        200 +Series    1/4 声明1
oauth-pkce                     ok        ok        200 +Series    2/4 声明2
oauth-device-flow              ok        ok        200 +Series    3/4 声明3
oauth-token-lifecycle          ok        ok        200 +Series    4/4 声明4
d1-no-such-table               ok        ok        200 +Series    1/4 声明1
wrangler-deploy-errors         ok        ok        200 +Series    2/4 声明2
workers-io-different-request   ok        ok        200 +Series    3/4 声明3
workers-subrequest-limit       ok        ok        200 +Series    4/4 声明4
comment-anti-spam              ok        ok        站点级          -
r2-image-pipeline              ok        ok        站点级          -
worker-cron-friend-check       ok        ok        站点级          -
about                          ok        ok        站点级          -

15 篇，坏 0 篇，耗时 3479ms</code></pre></div>
<p><code>sticky-toc</code> 那行是 <code>1/1</code>——它所在系列此刻确实只有 1 篇公开，正好是第六节那个边界状态。系列块不渲染，兜底导航接管，页面有出口。</p>
<p>同一个脚本如果只查「url 能不能打开」，改之前跑会是全绿：<code>isPartOf.url</code> 打开的是文章自己，200。<strong>引用可达这一条根本抓不到自指</strong>。</p>
<p>现在的版本靠两处抓它。第一处是显式比较：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// url 等于本篇地址时，后面所有检查都会以 200 放行</span>
<span class="tok-k">if</span> (part.url === art.url) {
  row.partOf = <span class="tok-s">&#39;自指&#39;</span>;
  rows.<span class="tok-f">push</span>(row);
  <span class="tok-k">continue</span>;
}</code></pre></div>
<p>第二处是语义比对：从系列页 HTML 里按 <code>&lt;a href=&quot;/p/...&quot;&gt;</code> 抽次序，找自己，<code>position</code> 必须等于那个次序。自指的 url 返回的是文章页，抽出来的次序里没有自己，于是判「不在系列页」。</p>
<p>这也是第二次「报错方向不对」：改之前跑，这一条确实会红，但红的是「不在系列页」，而不是「url 指向了自己」。同一个事实，两种描述，后一种要人再往回追一步才想得到。所以第一处那个显式比较不能省——它让报错直接说出原因。</p>
<p>单元测试现在是 88 条全绿，其中 5 条专测 <code>postLd()</code>——在这轮之前，这个函数一条用例都没有。<code>git grep postLd 0f11e80^ -- scripts/</code> 返回空，就是证据。</p>
<h2 id="九-这类错误的一般形态"><a class="h-anchor" href="#九-这类错误的一般形态">#</a>九、这类错误的一般形态</h2>
<p>把这次的两处（<code>isPartOf</code> 自指、兜底导航的双空）放在一起，形状是一样的：<strong>两个本该咬合的东西，各自都合法，合起来是错的</strong>。</p>
<p><code>isPartOf.url</code> 单独看是个合法 URL，<code>CreativeWorkSeries</code> 单独看是个合法的类型名，拼起来变成一个声称「我是我自己的系列」的节点。<code>renderSeries</code> 和 <code>renderAdjacent</code> 单独看都正确，组合起来让一篇文章失去全部出口。</p>
<p>所以这类问题的验收不能靠「看每一处对不对」，只能靠「查两个东西对不对得上」。落到结构化数据上，具体就这几条：</p>
<div class="table-wrap"><table><thead><tr><th>字段</th><th>断言</th><th>出错时的样子</th></tr></thead><tbody><tr><td><code>isPartOf.url</code></td><td>不等于本篇 <code>url</code></td><td>自指，200，工具全放行</td></tr><tr><td><code>isPartOf.url</code></td><td>打开后含 <code>CreativeWorkSeries</code></td><td>指向文章页或 404</td></tr><tr><td><code>position</code></td><td>等于在系列页中的实际次序</td><td>序号重复或断号，看不出</td></tr><tr><td><code>numberOfEpisodes</code></td><td>等于 <code>hasPart</code> 长度</td><td>系列页漏算了未发布文章时最常发生</td></tr><tr><td><code>headline</code></td><td>等于页面 <code>&lt;h1&gt;</code></td><td>改标题只改了一处</td></tr><tr><td>系列块 / 兜底导航</td><td>至少一个渲染</td><td>单篇系列时两块同时消失</td></tr></tbody></table></div>
<p>其中最容易被忽略的是最后一行。它不是结构化数据问题，但它和第一行是同一个毛病：<strong>判断条件写在了两个地方，各自都自洽</strong>。</p>
<h2 id="十-两个刻意的取舍"><a class="h-anchor" href="#十-两个刻意的取舍">#</a>十、两个刻意的取舍</h2>
<p><strong><code>/series</code> 没有进顶栏。</strong> 现在顶栏 5 项，第 6 项在 640px 会把站名挤成 <code>Exia Bl…</code>——这个坑十月份刚修过一次，不想为一个入口再动手机端布局。所以系列页的入口是三处：每篇系列文顶部的系列名、各系列页页脚的互链、sitemap。读者从文章进系列是最自然的路径，从首页找系列本来就不是常见动作。</p>
<p><strong>没有把 15 篇全塞进系列。</strong> 判据只有一条：<strong>有没有先后顺序</strong>。「目录不跟着滚 → 渲染 549ms → 三层缓存」是同一个站在不同阶段的排障，后一篇用得上前一篇的结论；「友链检测 / R2 图片链路 / 评论防滥用」是三件并列的工具，谁也不依赖谁，硬凑成「站内功能三部曲」只会让系列目录变成第二个栏目页。系列的价值在于「读完这篇该读哪篇」，不在于「把文章分组」。</p>
<p>相关：这一轮同时动的布局与暗色层次，写在<a href="/p/sticky-toc-grid-align-items">《目录不跟着滚：sticky 在 grid 里失效》</a>和<a href="/p/worker-render-549-to-96">《Worker 渲染从 549ms 到 96ms》</a>里；系列机制最早是在<a href="/p/oauth-auth-code">《OAuth：为什么要绕一个 302》</a>那批稿子里立起来的，那批稿子也是这次 8 段自指的全部来源。</p>
<p>还有一条没做：这个体检脚本没有挂进 CI，是手动跑的。挂进去的代价是要在 CI 里访问线上站点（构建阶段站可能还没部署），收益是每次改 <code>seo.js</code> 自动验一遍。现在改成手动跑，是因为改动频率低——一个月动两次的东西，加一条流水线的维护成本比收益高。等它真出第二次问题再说。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1. 体检线上全部文章的 JSON-LD（含引用可达、position 一致、headline 一致）</span>
<span class="tok-k">node</span> scripts/check-ld.mjs

<span class="tok-c"># 2. 只看某一篇的 isPartOf，确认 url 不是它自己</span>
<span class="tok-k">node</span> --input-type=module -e &quot;const h=<span class="tok-f">await</span>(await <span class="tok-f">fetch</span>(<span class="tok-s">&#39;https://exia.de5.net/p/oauth-pkce&#39;</span>)).<span class="tok-f">text</span>();
  const j=JSON.<span class="tok-f">parse</span>(h.<span class="tok-f">match</span>(/&lt;script[^&gt;]*ld\+json[^&gt;]*&gt;([\s\S]*?)&lt;\/script&gt;/)[<span class="tok-n">1</span>]);
  console.<span class="tok-f">log</span>(j[<span class="tok-s">&#39;@graph&#39;</span>][<span class="tok-n">0</span>].isPartOf)&quot;

<span class="tok-c"># 3. 确认系列页地址真实存在且带 number/hasPart</span>
<span class="tok-k">curl</span> -s <span class="tok-s">&quot;https://exia.de5.net/series/OAuth%20%E6%8E%88%E6%9D%83%E6%B5%81%E7%A8%8B%E6%8B%86%E8%A7%A3&quot;</span> \
  | <span class="tok-k">grep</span> -oE <span class="tok-s">&#39;numberOfEpisodes&quot;:[0-9]+|&quot;position&quot;:[0-9]+&#39;</span> | head

<span class="tok-c"># 4. 单元测试里的形状断言（不要只断言等于某个值）</span>
<span class="tok-k">npm</span> test <span class="tok-n">2</span>&gt;&amp;<span class="tok-n">1</span> | <span class="tok-k">grep</span> -A2 <span class="tok-s">&quot;isPartOf&quot;</span></code></pre></div>
<p>手动那一步：把文章页地址粘进 Google Rich Results Test，看它识别出的是什么类型、<code>isPartOf</code> 有没有被展开。这一步只能看到「解析结果」，看不到语义对错——自指的 url 在那里同样是一个正常的链接。</p>
<p>要判断语义，只有一条路：把 url 打开，看里面有没有那个系列本身。</p>
<p>同一族还有一个更安静的：<code>sitemap</code> 的 <code>&lt;lastmod&gt;</code> 会早于页面里的 <code>datePublished</code>。两个字段出自同一条记录、同一个 Worker，却声明了相反的先后 —— 页面照样 200，XML 照样合法，没有任何工具报警。那篇写完再回来补链接。</p>', updated_at = '2026-11-25 11:55:48' WHERE slug = 'ld-self-reference';
SELECT slug, instr(html_content, '/p/three-layer-cache') AS link_at, length(html_content) AS len, updated_at FROM posts WHERE slug = 'ld-self-reference';

