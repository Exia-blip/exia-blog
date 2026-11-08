-- Cloudflare 踩坑对照：B 类报错对照系列（第 1 篇是已有的 D1 那篇，这里把它并入系列）
-- 由 scripts/gen-b-series.mjs 生成，重跑会覆盖正文与摘要

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES ('workers-subrequest-limit', 'Workers 里 fetch 超时不是网络慢：subrequest 限额踩坑记', '## 结论

`Too many subrequests by single Worker invocation` 不是网络问题，是**一次 invocation 里 fetch 的次数超了配额**。

免费计划 50 次，付费 1000 次。计数发生在 `fetch()` **派发那一刻**，不是你拿到响应的那一刻。这一条决定了所有现象：

- 并发发 200 个，180ms 就全炸——因为前面的响应还没回来，配额已经用光了
- 串行发 200 个，看着像"慢慢超时"，851ms 才炸——其实是被第 51 次拦下的
- 本地 `wrangler dev` 跑 200 次全过，线上 50 次就死——本地不模拟这个限额

所以这个错最坑的地方不是限额本身，是**它长得像超时，而你按超时去查永远查不到**。

## 报错现场

```
Error: Too many subrequests by single Worker invocation. To configure this limit,
refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits
```

这行提示的后半句很容易带偏：它指向 wrangler 配置的 `limits`，但那个 `limits` 管的是 CPU 时间和内存，**subrequest 数量在免费计划上不可调**。跟着链接改配置改不出来，白花半小时。

更麻烦的是线上通常看不到这句。未捕获的异常会变成：

```
Error 1101: Worker threw exception
```

1101 页面只有这一行纯文本，没有原因、没有堆栈。要么开 `wrangler tail`，要么在代码里自己 catch 打日志，否则你只知道"Worker 挂了"。

## 为什么它长得像超时

三个因素叠在一起：

1. **调用方等的是完整响应**。你的接口在内部循环 fetch，第 51 次抛错时，前面 50 次请求的时间已经花掉了。从浏览器看就是"这个接口很慢然后 500"。
2. **错误在派发时抛，不在响应时抛**。所以并发场景下失败来得极快——下面实测表里并发只用了 184ms，比串行快 4 倍多。快反而更像"网络抖了一下"。
3. **本地不复现**。Miniflare 不强制这个限额，`wrangler dev` 里 200 次全部成功，部署上去立刻翻车。于是你会在"是不是线上网络的问题"这个方向上耗掉一整天。

真超时和这个错的区别：真超时是 `fetch failed`、`network connection lost`、或者 522/524；subrequest 超限是一条明确带 `Too many subrequests` 的 Error，只是它默认不给你看。

## 实测：限额到底怎么算

我在自己的 Worker 上加了个探针，循环 `fetch()` 自己域名下的一个空路由，每次记录成功次数：

| 场景 | 结果 |
|---|---|
| 串行 45 次 | 成功，45 次，691ms |
| 串行 51 次 | 第 51 次抛错 |
| 串行 200 次 | 停在 50 次，851ms |
| 并发 200 次（`Promise.allSettled`） | 停在 50 次，**184ms** |
| 200 次 + `cf: { cacheEverything: true }` | 停在 50 次，872ms |
| D1 查询 800 次 | 全部成功，37.5s，不占 subrequest |

从这张表能读出四条：

**配额是 50，不是 49、不是 51。** 第 50 次成功，第 51 次抛错。计数单位是"一次 invocation"，不是"一个 URL"。

**fetch 自己域名也算。** 我请求的是同一 zone 下的 `/__probe/ping`，照样计数。同 zone 内部调用不免费。

**加 `cacheEverything` 不减计数。** 这组对照里仍然停在 50。别指望"缓存命中就不算"——至少在这个写法下省不掉。（想省内存和带宽可以加，想省配额不行。）

**D1 / KV / R2 这类 binding 不占这个配额。** 800 次 D1 查询跑完了，只慢，不报错。这是下面修法里性价比最高的一条。

注意：我这次是免费计划。付费是 1000，档位不同，但计数规则一样——上面四条结论不随档位变。

## 修法，按收益排序

### 1. 用 binding 替掉 HTTP

最直接的一刀。凡是"自己的数据"，就不该走 HTTP：

```js
// 差：每个 id 一次 fetch，30 个 id 就吃掉 30 次配额
const items = await Promise.all(ids.map((id) => fetch(`${BASE}/api/item/${id}`).then((r) => r.json())));

// 好：一次查询拿全部，零 subrequest
const { results } = await env.DB.prepare(
  `SELECT * FROM items WHERE id IN (${ids.map(() => ''?'').join('','')})`
).bind(...ids).all();
```

D1、KV、R2、AI、Service Binding 都是这个道理。`env.X` 走的是内部通道，跟公网 fetch 不是一条路。

### 2. 把 N 次请求合成 1 次

外部 API 没有 binding 可用，就换批量接口。多数服务都有：GitHub 的 GraphQL、Stripe 的 expand、各种 `/batch` 端点。没有的话自己在中间加一层。

```js
// 差：循环里 await，50 个用户 50 次 fetch
for (const u of users) await fetch(webhook(u));

// 好：一次提交，服务端自己分发
await fetch(WEBHOOK_BATCH, { method: ''POST'', body: JSON.stringify({ users }) });
```

### 3. 非关键请求丢进 `waitUntil`

跟用户响应无关的（埋点、通知、缓存预热）不该占主流程的时间：

```js
ctx.waitUntil(notify(payload));   // 不阻塞响应
```

但要说清楚：**`waitUntil` 里的 fetch 仍然算同一次 invocation 的配额**，它解决的是响应延迟，不是配额。真正省配额还是得靠前两条。

### 4. 请求内先聚合，别重复拉同一个东西

一个页面渲染时把同一个配置拉三遍，是最常见的浪费。请求内用一个局部变量接住：

```js
async function render(env) {
  const config = await loadConfig(env);   // 一次
  const [a, b] = await Promise.all([partA(config), partB(config)]);  // 传进去，别再拉
}
```

注意别把 `config` 存到模块作用域——那是另一个坑，见系列里的跨请求 I/O 那篇。

## 定位方法

限额不报"你用了第几个"，所以自己数：

```js
export default {
  async fetch(request, env, ctx) {
    let n = 0;
    const counted = (input, init) => { n++; return fetch(input, init); };
    try {
      const res = await handle(request, env, ctx, counted);
      return res;
    } catch (e) {
      console.error(`subrequests=${n} path=${new URL(request.url).pathname}`, e.message);
      throw e;
    }
  },
};
```

把 `fetch` 换成这个 `counted` 传进业务函数，出错时日志里就带着次数和路径。配合 `wrangler tail`，一眼能看出是哪个页面在猛拉。

三个高频来源，先查这三个：

1. **循环里 await fetch**（列表页、批量同步、webhook 分发）
2. **图片代理**。R2 代理、外链转存图，一个图一次 fetch，一屏二十张图就吃掉一半配额
3. **自己调自己**。同 zone 的内部 API 调用，看着"不出网"，其实全额计数

## 一句话总结

这个错的根因是**调度配额**，不是网络。看到超时就先去数 fetch 次数，别去查 DNS、别去换 region、别去加 timeout——都没有用。

系列里的另外三篇：[D1 报错 no such table](/p/d1-no-such-table)、[wrangler deploy 失败对照](/p/wrangler-deploy-errors)、[Cannot perform I/O on behalf of a different request](/p/workers-io-different-request)。

#cloudflare #workers #debugging #javascript
', '', 'log', 'Cloudflare 踩坑对照', 4,
        0, 0, 'Too many subrequests 长得像超时，其实是调度配额：计数发生在 fetch 派发那一刻，本地 dev 还不复现。实测 45/51/200 次与并发、缓存的对照，以及四条按收益排序的修法。', 'manual', '', 1, '2026-11-08 15:20:00', '2026-11-08 15:20:00', '2026-11-08 15:20:00')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  series = excluded.series, series_order = excluded.series_order,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('cloudflare');
INSERT OR IGNORE INTO tags (name) VALUES ('workers');
INSERT OR IGNORE INTO tags (name) VALUES ('debugging');
INSERT OR IGNORE INTO tags (name) VALUES ('javascript');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'workers-subrequest-limit');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('cloudflare', 'workers', 'debugging', 'javascript') WHERE p.slug = 'workers-subrequest-limit';

-- 把已有的 D1 那篇并入系列（正文不动，只补系列归属）
UPDATE posts SET series = 'Cloudflare 踩坑对照', series_order = 1 WHERE slug = 'd1-no-such-table';
