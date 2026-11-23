## 结论

一份对比材料说我的缓存失效「散、靠手写、没有统一失效入口」。查完源码，前半句不准：入口一直有，一个 `bust()` 函数，9 处调用全走它。

真正的问题在别处，而且比「散」严重：

- **清单少了三类。** `bust()` 清 6 类页面形态，而 `isPagePath()` 认 10 类——`/tag/<名>`、`/series/<名>`、`/series` 从来没被清过。新文章发布，它所属的标签页和系列页在 5 分钟里还是旧的。
- **有些键根本清不掉。** 缓存键是完整 URL，`/?page=2` 和 `/` 是两条独立条目。`caches.default` 没有 `list`、没有 `deletePrefix`，删不掉你枚举不出来的键。而分页和搜索的 key 是无限组合。

材料说「真要抄，只抄它的统一缓存失效入口」。我抄了，但抄过来的不是 `clearFeedCache` 那个函数——那个函数在我这儿一行都用不了。抄的是它成体系的**那一层做法**：清单集中、清完有断言守着。

这篇记的是两条改法、九个实测数字，以及为什么 Rin 的 `deletePrefix` 在我这儿不存在。

## 一、两种缓存，其实是两种所有权

材料把两边的差别说成「它成体系、你偏手写」。这个描述掩盖了真正的分界：**缓存的数据结构归不归你。**

Rin 的 `CacheImpl` 是自己实现的一个 `Map`：

```ts
export class CacheImpl {
  cache: Map = new Map();
  private storageProvider: StorageProvider;
  private dirtyKeys = new Set();
  private pendingDeletes = new Set();
```

`Map` 之上挂了两个 provider，`CACHE_STORAGE_MODE` 二选一（不是材料说的「D1 或 R2/S3」，实际枚举值是 `'database' | 's3'`，默认 `'s3'`）：

| 模式 | `supportsPartialAccess` | `deletePrefix` 怎么实现 | 每次写的代价 |
|---|---|---|---|
| `database` | `true` | `DELETE FROM cache WHERE key LIKE 'prefix%'` | 一条 UPDATE，走 D1 |
| `s3` | `false` | 遍历 Map 删完，`await this.save()` | **整个 Map 序列化后全量 PUT** |

`s3` 那份代码值得逐字看：

```ts
async delete(): Promise { await this.save(); }
async clear(): Promise { await this.save(); }
```

`delete()` 没有 key 参数，`clear()` 也不清什么——它们都只是「把内存里那份整个重新传一遍」。路径是 `path_join(env.S3_CACHE_FOLDER || 'cache', `${type}.json`)`，`type` 有三种：`cache`、`server.config`、`client.config`，对应三个独立实例。

所以「`cache/feeds.json`」这个说法也不准：文件名是 `cache/cache.json`，而且里面装的不只是 feed，还有搜索、相邻文章、配置。

这套设计的强项很实在：**前缀删是一等公民**。`deletePrefix('feeds_')` 一行，所有列表页缓存同时失效，不用枚举。

弱项也实在：这份能力的前提是**缓存住在自己家的库或桶里**。你的 `Map` 你说了算，你的 SQL 你说了算。

我的缓存不住在自己家。`caches.default` 是 Cloudflare 的托管 API：

```js
await caches.default.put(cacheUrl(url), copy.clone());
await caches.default.delete(new URL(p, origin).toString());
```

能拿到的接口就是 `match / put / delete`，键是完整 URL。没有 `keys()`，没有 `deletePrefix`，没有 `clear`。**它连自己存了什么都说不出来。**

这不是 Cloudflare 抠门，是这套 API 的定位：边缘内存缓存，设计目标是不需要你管理生命周期。你要管理，就只能管理「你事先知道的那个 URL」。

## 二、我原来漏了什么

`bust()` 改前长这样：

```js
function bust(url, slugs = [], cats = []) {
  postCacheDrop();
  const paths = ['/', '/archive', '/categories'];
  for (const c of cats.filter(Boolean)) paths.push(`/cat/${encodeURIComponent(c)}`);
  for (const s of slugs.filter(Boolean)) {
    paths.push(`/p/${encodeURIComponent(s)}`, `/${encodeURIComponent(s)}`);
  }
  return bustPaths(url.origin, paths);
}
```

清 6 类：首页、归档、栏目总览、被改动的栏目、被改动的文章正文、短链。

而实际会写进边缘缓存的，是 `isPagePath()` 认的 10 类：

```js
const isPagePath = (p) =>
  p === '/' || p === '/archive' || p === '/numbers' ||
  p === '/categories' || p === '/friends' || p === '/series' ||
  p.startsWith('/series/') || p.startsWith('/tag/') || p.startsWith('/cat/') ||
  p.startsWith('/p/');
```

`/tag/`、`/series/`、`/series` 三类，一个都没在清理清单里。（10 类里 `/friends` 有独立的 `bustFriends()`，`/numbers` 是构建期常量、本来就不会变，所以真正漏的就是这 3 类。）

这不是「散」——`bust()` 确实是个统一入口，9 处调用全在写路径上。是**清单和路由表各活各的**：`isPagePath` 那边加一类，`bust` 这边没人提醒。跟上一轮那条路由边界断言查出来的问题同源（`/tag/` 那 17 行在分发器里写 SQL），都是「两处描述同一件事，靠人记得同步」。

漏掉的后果很具体：给一篇新文章打上 `caching` 标签，`/tag/caching` 那一页在 5 分钟内还是旧列表。如果这个标签此前没有公开文章，那一页给的是 404（`s-maxage=60`）——Worker 内不写这种响应（只写 200），但 CF 边缘照头缓存 60 秒，读者点进去就是一分钟的门。

比漏清更麻烦的是第二类：**清不掉的键**。

`/?page=2` 与 `/` 在缓存里是两条。`bust` 清的是 `new URL('/', origin)`，`?page=2` 那条不动。同理 `/tag/x?page=2`、`/cat/y?page=2`、`/?q=任意词`。

分页的问题是键空间可以枚举但数量随文章增长；搜索的问题是**根本不可枚举**——`?q=` 后面是任意字符串。而且它还有第二个麻烦：任何爬虫刷一批不重复的搜索词，就能往缓存里灌无限条 200 页面，把配额换成垃圾。

一个不能枚举的键，在「只能按完整 URL 删」的缓存里，等于永远不会失效。

## 三、两条改法

**第一条：能枚举的，全部枚举。**

`bust` 加了 `db` 参数，查库拿全量标签和系列名：

```js
async function bust(url, slugs = [], cats = [], db = null) {
  postCacheDrop();
  const paths = ['/', '/archive', '/categories', '/series'];
  for (const c of cats.filter(Boolean)) paths.push(`/cat/${encodeURIComponent(c)}`);
  for (const s of slugs.filter(Boolean)) {
    paths.push(`/p/${encodeURIComponent(s)}`, `/${encodeURIComponent(s)}`);
  }
  if (db) {
    const [ts, ss] = await Promise.all([
      db.prepare('SELECT name FROM tags').all(),
      db.prepare("SELECT DISTINCT series FROM posts WHERE series != ''").all(),
    ]);
    for (const r of ts.results || []) paths.push(`/tag/${encodeURIComponent(r.name)}`);
    for (const r of ss.results || []) paths.push(`/series/${encodeURIComponent(r.series)}`);
  }
  return bustPaths(url.origin, paths);
}
```

不按「这次动了哪几个标签」精确算，全清。理由跟 `postCacheDrop()` 那句注释一样：**几十次 delete 是本地操作，比漏清便宜**。本地 18 个标签、3 个系列，一次发布从 8 条 delete 变成 30 条。

查库放在 `waitUntil` 里，不占发布请求的等待时间。查失败就跳过——宁可留 5 分钟旧页面，也不能让一次 delete 失败把 `waitUntil` 拖成 unhandled rejection。

**第二条：不能枚举的，不进缓存。**

```js
const cacheable =
  request.method === 'GET' && !loggedIn && isPagePath(url.pathname) &&
  !url.search;
```

光这一行不够。Worker 内不写 `caches.default`，Cloudflare 边缘看响应头还会自己存一份——那份照样删不掉。所以 `harden()` 也要跟着改（它原来只收到 `pathname`，现在多收一个 `search`）：

```js
} else if (search) {
  headers.set('cache-control', 'no-store');
  headers.set('cdn-cache-control', 'no-store');
}
```

只改一处等于没改，这是这类问题的典型形态：**两层缓存，两层都得关，漏一层看起来就像没动过。**

## 四、九条断言，第一次跑红了两条

改完写断言（`scripts/test-cache-bust.mjs`，进 `npm test` 链）：

| 编号 | 断什么 |
|---|---|
| CB-01 | `bust` 存在且函数体可读 |
| CB-02 | tag 页全部进清理清单（查库枚举 + 编码拼接） |
| CB-03 | series 页同上 |
| CB-04 | 带 query 的页面不进缓存 |
| CB-05 | 存的键与清的键同一个规范化 |
| CB-06 | 四条文章写路径（create/update/delete/restore）都挂 bust |
| CB-07 | bust 全部走 `waitUntil`，不阻塞发布 |
| CB-08 | bust 同时清进程内 LRU |
| CB-09 | 边缘头与 Worker 内口径一致 |

第一次跑，CB-04 和 CB-07 是红的。原因都是我自己断言写错：CB-04 的检测窗口只有 12 行，而那段注释有 7 行，`!url.search` 被切在窗口外；CB-07 统计调用点时把 `async function bust(url` 这个定义行也算了进去，于是永远有「1 处同步调用」。

改断言之后 9/9 绿。失败分支验过两次：把 `!url.search` 换成 `true` → CB-04 exit 1；删掉 tag 枚举那行 → CB-02 exit 1。

CB-09 是补的。写的时候只改了 `cacheable`，忘了 `harden`——如果不是「头也必须一起改」这条断言，改完会是「本地验证通过、线上仍然缓存」这种最难查的状态。

## 五、实测

本地 Worker（`wrangler dev --local`，端口 8793），逐个打：

| 路径 | 改前 cache-control | 改后 |
|---|---|---|
| `/` | `public, max-age=0, s-maxage=300, swr=86400` | 不变 |
| `/tag/cloudflare` | 同上 | 不变 |
| `/series` | 同上 | 不变 |
| `/numbers` | 同上 | 不变 |
| `/?page=2` | `s-maxage=300` | **`no-store`** |
| `/?q=cloudflare` | `s-maxage=300` | **`no-store`** |
| `/tag/cloudflare?page=2` | `s-maxage=300` | **`no-store`** |

`cdn-cache-control` 两条口径同步：无 query 是 `public, s-maxage=300`，带 query 是 `no-store`。

键一致性逐字符比过。中文标签三个、含空格系列两个，逐条比对「`bust` 生成的 URL」与「浏览器请求的 URL」：

| 名字 | 实际请求键 | 一致 |
|---|---|---|
| 技术 | `/tag/%E6%8A%80%E6%9C%AF` | 是 |
| 生活 | `/tag/%E7%94%9F%E6%B4%BB` | 是 |
| 读书 | `/tag/%E8%AF%BB%E4%B9%A6` | 是 |
| Cloudflare 踩坑对照 | `/series/Cloudflare%20%E8%B8%A9%E5%9D%91%E5%AF%B9%E7%85%A7` | 是 |
| OAuth 授权流程拆解 | `/series/OAuth%20%E6%8E%88%E6%9D%83%E6%B5%81%E7%A8%8B%E6%8B%86%E8%A7%A3` | 是 |

含空格那条是我特意挑的：`encodeURIComponent(' ')` 是 `%20`，路径里的空格必须是 `%20`，如果哪天有人把生成逻辑换成查询串那套（空格编成 `+`），键就会差一个字符，删不掉且静默。逐字符比对是唯一能发现这种事的方法。

键不一致就白改：`delete()` 对不存在的键不报错，返回成功，页面上什么都不会变。

## 六、首屏模型决定了谁必须管失效

材料里「SPA 壳 vs SSR 直出」那段我认同，但它跟缓存失效是同一件事的两面，值得接上。

Rin 的前端是静态壳，文章数据由浏览器再请求 API。所以它的缓存只影响 API 层：首页列表过期了，壳还是那个壳。而我是直出，一次请求出完整 HTML——**页面本身就是缓存对象**，它一过期就是读者眼里的错内容。

这就是为什么「带 query 不进缓存」在我这儿是必要代价，在 Rin 那儿不需要：它的分页缓存键 `feeds_${type}_${page}_${limit}` 存在自己的 D1 里，`deletePrefix('feeds_')` 一行清完，不需要「不缓存」这种退让。

同一套预算，花法相反：它花在缓存层的复杂度上（三个 provider、dirtyKeys、pendingDeletes、全量 save），我花在「减少需要缓存的东西」上。两个方向的成本最终都落在同一个地方——**失效**。

顺带核了两个数字。材料说「免费版 subrequest 上限 50、付费 1000」：前一半我在[那篇 subrequest](/p/workers-subrequest-limit)里实测过，串行 45 次成功（691ms），第 51 次抛错，并发 200 次在 184ms 内停在第 50 个。后一半（付费 1000）我没验证，不引用。

材料说「Hono 约 14KB，gzip ~5KB」：Hono README 写的是 `hono/tiny` **under 12kB**，没说 gzip 数。这个我同样不引用。

## 七、明说的没做

- **`caches.default.delete` 只影响当前 colo。** 同一个 URL 在多个边缘节点各有一份副本，我的 `bust` 清的是处理这次请求的那个节点。其他节点靠 300 秒 TTL 自然过期。真正的全局失效只有 `purge` 那一套（走 CF API，要 token 权限），我没做。
- **分页和搜索现在每次回源。** 第 2 页访问量低，我判断这笔交换值得，但**没有测** LCP 影响——这是基于「第 2 页本来就慢也没人看」的推断，不是实测。
- **`?utm_source=` 这类分享链接也走回源。** 故意的：只要放行任意参数，就等于允许别人用不重复的 query 灌缓存。代价是社交渠道来的访客拿不到边缘缓存。
- **没实测 Rin 部署。** 上面所有 Rin 结论来自 `2026-11-23` 的 `main` 源码阅读，没跑过它的实例，没测过它的缓存命中率。`s3` 模式全量 PUT 的延迟和体积我没有数字。
- **没做压测。** 材料里「78K req/s」那种数字我这套结构给不出来，也不打算给。
- **进程内 LRU 仍是全清。** `postCacheDrop()` 一把清空整个 chunk，没有精细失效。缓存小（几十条），全清比按 key 删便宜。

## 怎么自己验

```bash
# 1. 九条断言
node scripts/test-cache-bust.mjs

# 2. 缓存头：无 query 应该有 s-maxage，带 query 应该是 no-store
curl -sI 'http://127.0.0.1:8793/'            | grep -i cache-control
curl -sI 'http://127.0.0.1:8793/?page=2'     | grep -i cache-control

# 3. 键一致性（含空格与中文）
node -e "console.log(new URL('/tag/'+encodeURIComponent('技术'),'https://exia.de5.net').toString())"
# 期望：https://exia.de5.net/tag/%E6%8A%80%E6%9C%AF —— 与线上该标签页地址逐字符一致
```

第 1 步改坏任一处都应该 exit 1（把 `!url.search` 改成 `true`，CB-04 会红）。改不红，说明断言没写对。

#cloudflare #caching #workers #performance
