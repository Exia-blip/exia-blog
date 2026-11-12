-- 工程实录：Worker 渲染 549→96ms 的真实归因（D1 串行改并发 + 缓存窗口）
-- 由 scripts/gen-perf-parallel.mjs 生成，重跑会覆盖正文

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES ('worker-render-549-to-96', 'Worker 渲染从 549ms 到 96ms：我只改了一件事', '11-09 那天部署完，我抓到的第一条 `Server-Timing` 是 `cfWorker;dur=549`，同一个版本另一个页面是 `752`。今天同一个栏目页 `/cat/tools`，同样的探针，`84` 到 `96`。

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
', '', 'log', '', 0,
        0, 1, '549 和 96 之间隔着两个变量：冷启动转热，和把五次串行往返压成一次。把旧提交部署成独立 Worker、两个 tail 同时抓、请求交替发，得到干净对照：/cat/tools 180→84ms，/tag/cloudflare 207→148ms，归档与文章页纹丝不动——因为它们不在那个 Promise.all 里。CPU 两版都是 5ms，省掉的全是等待。', 'manual', '', 1,
        '2026-11-18 01:00:00', '2026-11-18 01:00:00', '2026-11-18 01:00:00')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = excluded.hidden,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('cloudflare');
INSERT OR IGNORE INTO tags (name) VALUES ('workers');
INSERT OR IGNORE INTO tags (name) VALUES ('d1');
INSERT OR IGNORE INTO tags (name) VALUES ('cache');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'worker-render-549-to-96');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('cloudflare', 'workers', 'd1', 'cache') WHERE p.slug = 'worker-render-549-to-96';
