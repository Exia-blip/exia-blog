## 结论

一个 HTML 页面从 Cloudflare 到用户，中间有**三层缓存**，每层各看一个不同的头：

| 层 | 谁在判 | 看哪个头 | 本站取值 | 失效后行为 |
|---|---|---|---|---|
| 浏览器 | 浏览器自己 | `max-age` | `0` | 每次都回源校验 |
| CF 边缘 | Cloudflare | `s-maxage` + Cache Rule | `300` | 过期后仍可用旧副本（`swr`） |
| Worker 内 | `caches.default` | 写入时你自己设的头 | `300` | 同上 |

三层里最容易出事的是第一层，但它不归你管——**归 Cloudflare 的 zone 设置管**。那里有一个叫 Browser Cache TTL 的开关，默认不是「尊重源站头」。它一旦设成 4 小时，你代码里写的 `max-age=0` 会被改写成 `max-age=14400`，结果就是：文章发出去，读者最长 4 小时看不到。

第二容易出事的是第三层。我自己的代码在这里丢过一个头，症状是「同一篇文章，有时秒开，有时 300ms」，查了两天才定位到。

真正的线上响应头长这样（对 `exia.de5.net` 实测）：

```http
HTTP/1.1 200 OK
CF-Cache-Status: HIT
Age: 22
Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

`CF-Cache-Status: HIT` + `Age: 22` 说明边缘命中了，这份副本 22 秒前被存进去。`max-age=0` 说明浏览器不会把它存下来，下次访问还得来问一遍。

下面把三层拆开，每一层说清楚「为什么是这个值」和「设错了会怎样」。

## 一、浏览器层：`max-age=0` 是故意的，不是漏配

看响应头会觉得奇怪：既然边缘缓存了 5 分钟，为什么不让浏览器也缓存 5 分钟？那样不是更省？

因为你控制不了「用户什么时候想看新内容」。

假设 `max-age=300`，读者在 10:00 打开了一篇文章，作者 10:01 改了个错字，读者 10:03 刷新——浏览器直接拿本地副本，看不到改动，而且他不知道为什么。更糟的是如果他点了页面上的「刷新」，浏览器仍然可能用本地副本（普通刷新会带 `If-Modified-Since` 去校验，但强缓存期内连校验都不发）。

`max-age=0` 的效果是：浏览器每次都带着 `If-None-Match` 回源问一句「变了没」。没变就返回 `304`，只有几百字节：

```http
GET /p/some-post HTTP/1.1
If-None-Match: "48a8180f9c6207cdb31b0fafc87e2455"

HTTP/1.1 304 Not Modified
CF-Cache-Status: HIT
```

这 304 是边缘回的，打到 Worker 的概率很低——前提是 Cache Rule 正确。所以「每次都回源」的真实成本不是每次跑一遍 SSR，是每次在边缘确认一次。

这条链路有个前提：**`ETag` 必须真的随内容变化。** 如果页面内容变了但 ETag 没变，浏览器会一直拿旧副本，而且它自己不知道。本站的 ETag 是响应体的哈希，内容变则变，这点是可靠的。

## 二、zone 设置：那个会把你 `max-age` 吃掉 4 小时的开关

Cloudflare 的 **Browser Cache TTL**（在 Caching → Configuration 里）有三个选项：

| 选项 | 行为 | 对你写的头 |
|---|---|---|
| Respect Existing Headers | 不改 | 原样透传 |
| 2 hours / 4 hours / 8 hours / ... | 强制改写 | `max-age` 被替换成该秒数 |
| No override | 同 Respect | 原样透传 |

选「4 hours」的时候，你返回 `max-age=0`，用户收到的是 `max-age=14400`。这个改写发生在 Cloudflare 的响应处理链上，你的 Worker 日志里看不到，`curl` 直接打 Worker 也看不到——只有经过 Cloudflare 代理的响应才有。

这就是「本地测试一切正常，上线后用户说改了看不到」的典型来源。而且它有个很迷惑的特征：**同一篇文章，新访客能看到新版，老访客看不到**。因为新访客本地没有副本。

判断方法很简单，直接看线上响应头：

```bash
curl -sI https://your.site/p/some-post | grep -i cache-control
```

如果输出里的 `max-age` 不是你代码里写的值，就是被 zone 改写了。

本站现在的输出是 `max-age=0`，和代码一致，说明 zone 那边设的是 Respect Existing Headers。这个设置必须和代码一起检查，只改一边没有意义。

## 三、边缘层：`s-maxage` 加 `swr`，两个数分工不同

```js
// src/cache.js
export const EDGE_TTL = 300;
export const EDGE_SWR = 86400;

export const pageCacheControl = () =>
  `public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`;
```

`s-maxage=300`：边缘存 5 分钟。这 5 分钟内，1000 个访客只有第 1 个打到 Worker。

`stale-while-revalidate=86400`：5 分钟过期后，边缘**不阻塞**，直接把旧副本发给用户，同时在后台去源站拿新的。拿回来之后下一个人就是新的。

这两个数配合的效果：

| 距离上次回源 | 用户拿到 | 用户等待 | 源站压力 |
|---|---|---|---|
| 0~5 分钟 | 缓存副本 | 0 | 0 |
| 5 分钟~24 小时 | 稍微旧的副本 | 0（后台刷新） | 每次过期后 1 次 |
| 超过 24 小时 | 必须等新的 | 一次 SSR 的时间 | 1 次 |

所以真正会「等」的场景，是**一个页面超过 24 小时没人访问**之后的第一位访客。这种情况下 `swr` 保不住，得老老实实渲染一遍。

关键在于：**内容更新不靠等 TTL。** 发布、改文、删文都会主动清缓存：

```js
// src/cache.js
export async function bustPaths(origin, paths) {
  const c = caches.default;
  await Promise.all(
    paths.filter(Boolean).map(async (p) => {
      try {
        await c.delete(new URL(p, origin).toString());
      } catch {}
    })
  );
}
```

因为能主动清，`s-maxage` 才敢放宽到 300 秒。如果只能等过期，这个值就得压到 30 秒以内，回源次数涨 10 倍，Worker CPU 时间也跟着涨。

## 四、Worker 内层：我在这里丢过一个头，症状是「有时快有时慢」

第三层是 Worker 自己的 `caches.default`。它在边缘缓存之外又存了一份，作用是「同一次请求里，多个地方要用同一份 HTML 时不用重复渲染」，以及「CF 边缘没命中但 Worker 内命中了」的兜底。

问题出在写入副本的这段：

```js
// 改之前：只写了 s-maxage
headers.set('cache-control', `public, s-maxage=${ttl}`);

// 改之后：swr 一起写进去
headers.set('cache-control', `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
```

看起来只是少了个头，实际后果是**同一个页面存在两条缓存口径**：

| 路径 | 看到的 Cache-Control | 过期后 |
|---|---|---|
| 回给浏览器的响应（CF 边缘判定） | 带 `swr=86400` | 给旧副本，后台刷新 |
| Worker 内 `caches.default` 的副本 | 只有 `s-maxage=300` | 硬失效，必须回源 |

于是同一篇文章，走不同路径的延迟不一样。表现出来就是「有时秒开、有时 300ms」，而且没法稳定复现——取决于这次请求命中的是哪一层、那一层是不是刚过期。

这个 bug 难查的原因是：**两条路径都对，只是不一致。** 单独看任何一段代码都找不出错，必须把两处的头对照着看。

修完之后，`ttl` 和 `swr` 都改成从同一组常量来（`EDGE_TTL`、`EDGE_SWR`），改一处两边同步，杜绝再次分叉。

## 五、顺手实测出来的两件事

**一、`no-transform` 会关掉 Brotli。**

有一阵子想在响应里加 `no-transform` 防止运营商压缩，加上之后首页 HTML 从 8KB 涨回 25KB。原因是 `no-transform` 会连带阻止 Cloudflare 的 Brotli 压缩——为了挡一个 20KB 的 RUM 脚本，反而多传 17KB。

这条现在写在 `src/cache.js` 的注释里：

```js
/* 注意：别加 no-transform。
   实测它会连带关掉 Cloudflare 的 Brotli —— 首页 HTML 从 8KB 涨回 25KB，
   为了挡一个 20KB 的 RUM 脚本反而多传 17KB，这笔账是亏的。 */
```

**二、首次 MISS 时不返回 `cf-cache-status`。**

连续打三次 `/tag/cloudflare`，第一次的响应里**没有** `CF-Cache-Status` 这个头，第二、三次都是 `HIT`。

这不是 bug，是 Cloudflare 在「这个请求没经过缓存判定」时干脆不带这个头。写监控脚本时要注意：把「缺少该头」当成 MISS 处理，否则第一次访问会被判成「未知状态」，监控图上就会出现莫名其妙的空档。

`/rss.xml` 则是另一个情况：

```http
HTTP/1.1 200 OK
Cache-Control: public, max-age=600, stale-while-revalidate=3600
（没有 CF-Cache-Status）
```

连着打十次都没有。原因是 Cache Rule 只匹配了 HTML 路径，`rss.xml` 不在规则里——它虽然写了 `s-maxage`，但 Cloudflare 对默认不缓存的扩展名不会因为这个头就改变主意（需要 Cache Rule 或 `cacheEverything`）。所以 RSS 每次都是真回源。

要不要给它也加进 Cache Rule？可以，但 RSS 的更新频率比 HTML 更需要「即时」，而且读者是用阅读器定时拉取，量很小。现在的取舍是**不加**，让它每次现算。

## 六、整理成一张检查表

上线前对一遍，五项都过才算配好：

| 检查项 | 怎么看 | 期望 |
|---|---|---|
| zone 的 Browser Cache TTL | Dashboard → Caching → Configuration | Respect Existing Headers |
| 浏览器实际收到的头 | `curl -sI https://your.site/` | `max-age=0`（和你代码一致） |
| 边缘是否命中 | 同上，看 `CF-Cache-Status` | 第二次请求起是 `HIT` |
| Worker 内副本口径 | 搜代码里所有 `cache-control` 赋值 | 只有一处生成，其余引用常量 |
| 主动清理是否生效 | 改一篇文章后立刻刷新 | 立即看到新版，不等 5 分钟 |

第五项最能暴露问题：如果改完文章要等一会儿才看到，说明 `bustPaths` 没覆盖到那条路径——而它看起来是对的原因，往往是「清了列表页，没清文章页」。

## 七、怎么自己验一遍

1. `curl -sI https://your.site/` 打三次，看 `CF-Cache-Status` 从无到 `HIT` 再到 `HIT`，记下 `Age` 的增长。
2. `curl -sI` 再打一次，重点看 `cache-control` 里的 `max-age` 是不是你写的值。不是，就去查 zone 的 Browser Cache TTL。
3. 在 Worker 里临时加一个 `/__cache-debug` 路由，返回 `pageCacheControl()` 的字符串和当前 `caches.default.match()` 是否命中。两边对不上就是口径分叉。
4. 改一篇文章的标题，立刻用无痕窗口刷新列表页和文章页，都应该立即看到新标题。要等，就是 `bustPaths` 漏了路径。
5. 临时加上 `no-transform`，对比响应体大小。你会看到 Brotli 关掉之后的真实差距——本站是 8KB 到 25KB。

这三层里，第一层（浏览器）和第二层（CF 边缘）的正确性靠配置，第三层（Worker 内）靠代码一致性。配置错了表现为「所有人都看不到更新」，代码分叉了表现为「有的人快有的人慢」。两种症状完全不同，别混着查。

相关：一次渲染到底要花几次往返，是另一条线，[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)把它拆成了预热、并发、缓存三块；图片这条链路的缓存口径单独写在[《R2 图片链路》](/p/r2-image-pipeline)。
