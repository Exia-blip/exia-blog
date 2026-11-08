## 结论

`Cannot perform I/O on behalf of a different request` 不是业务 bug，是**你把属于请求 A 的 I/O 对象交给了请求 B**。

最常见的一行代码是在模块作用域缓存 `fetch()` 的结果：

```js
let configPromise = null;   // ← 罪魁祸首
```

Response、ReadableStream、请求体、D1 的查询结果流，这些对象都绑死在创建它的那个请求上下文上。请求结束，上下文回收，对象作废。下一个请求再碰它，就是这条报错。第一个请求永远正常，所以现象是「刚部署好好的，过一会儿开始全 500」。

## 报错现场

```
Error: Cannot perform I/O on behalf of a different request.
I/O objects (such as streams, request/response bodies, and others) created in the
context of one request handler cannot be accessed from a different request's handler.
This is a limitation of Cloudflare Workers which allows us to improve the overall
reliability of network requests over time.
```

部分版本末尾会多一行 `(I/O type: Response)` 之类的提示，直接告诉你是哪类对象——有这行就先看它，能省一半时间。

触发它的代码通常看着完全合理，甚至像是优化：

```js
let configPromise = null;

export default {
  async fetch(request, env) {
    if (!configPromise) configPromise = fetch('https://api.example.com/config');
    const res = await configPromise;          // 第 2 个请求在这里炸
    return new Response(await res.text(), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
```

第 1 个请求创建 promise 并读完 `res.text()`，一切正常。第 2 个请求复用了同一个 promise，拿到的 `res` 属于上一个请求的上下文，`res.text()` 抛错。

## 为什么 Worker 非要这么设计

每个请求有独立的 I/O 上下文，是为了在请求结束时能**干净地回收和取消**所有还没完成的网络与流。

设想真允许跨请求共享：请求 A 已经返回、连接关了，它那个 `ReadableStream` 还在被请求 B 读；回收时机就说不清了——早收会切断 B，晚收会泄漏 A 的资源。更糟的是分不清「慢请求」和「卡住的流」，边缘节点的内存会被一堆无人认领的流占满。

所以运行时选择直接报错，而不是静默复用。这条错误信息写得啰嗦但很准确：**限制在 I/O 对象的归属上，不在你的代码风格上**。

## 四种常见写法，和各自的修法

### 1. 模块作用域缓存 Response 或它的 promise

错误写法，也是最常见的：

```js
let cached;
if (!cached) cached = fetch(url);
const res = await cached;
```

正确写法：缓存**已经读成纯数据**的东西。

```js
let cachedConfig = null;

async function getConfig() {
  if (cachedConfig) return cachedConfig;
  const res = await fetch(CONFIG_URL);
  cachedConfig = await res.json();   // Response 在这里就消费完，留下的只是普通对象
  return cachedConfig;
}
```

判断标准一句话：**存字符串/对象，不存 Response、stream、promise-of-Response**。

还有个不容易发现的地方：模块作用域的 `Map` 缓存也是一样的道理。

```js
const memo = new Map();            // 错：value 里存了 Response
memo.set(key, await fetch(url));   // 下一个请求 get 出来直接用 → 炸
```

存 `await res.json()` 的结果就没事。这不是 Map 的问题，是 Map 里装了什么的问题。

### 2. 想跨请求真缓存，用 Cache API 或 KV

变量缓存只在**同一个 isolate 存活期内**有效，本来就不该指望它。要跨请求、跨节点，交给 Cache API：

```js
export default {
  async fetch(request, env, ctx) {
    const cache = caches.default;
    let res = await cache.match(request);
    if (!res) {
      res = await fetch(request);
      // clone 必须在读 body 之前，clone 出来的两份各只能读一次
      ctx.waitUntil(cache.put(request, res.clone()));
    }
    return res;
  },
};
```

`cache.match` 每次返回的都是新对象，天然不跨上下文。KV 同理——从 KV 取出来的是重新构造的 Response，不存在归属问题。

要注意的相邻坑：`clone()` 之后再对原对象和前一份都读 body，会得到 `Body has already been used`。这是另一条报错，但成因经常和这条混在一起，排查时别把两个问题当成一个。

### 3. 复用了 `env.ASSETS.fetch()` 的返回值

静态资源这条路特别容易中招，因为「把首页 HTML 缓存到变量里」看起来太自然了：

```js
// 错
if (!indexHtml) indexHtml = await env.ASSETS.fetch(new URL('/', request.url));
return indexHtml;
```

`ASSETS.fetch` 返回的也是绑定**当前请求**的 Response。要复用就存文本：

```js
// 对
if (!indexHtml) indexHtml = await (await env.ASSETS.fetch(new URL('/', request.url))).text();
return new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
```

这个坑我是在给自己的站加 SSR 时踩的：Worker 先接所有请求（`assets.run_worker_first: true`），再决定要不要回静态资源。一开始把 `ASSETS.fetch` 的结果往模块变量里一存，本地没问题，线上并发一上来就整片报这条错。所以现在这个站里所有跨请求的缓存存的都是**拼好的字符串**，没有一个是 Response。

### 4. `waitUntil` 里留下的引用

后台任务本身没问题：

```js
ctx.waitUntil((async () => {
  const res = await fetch(STATS_URL);
  await res.text();      // 在同一个请求上下文里消费掉，合法
})());
```

出问题的是把 `res` 或那个 promise 挂到模块变量上，给后面的请求用。`waitUntil` 只延长**当前**请求的生命周期，它不会把 I/O 对象的归属转交给别人。

## 定位三步

1. **确认只在线上、并发起来才出现**。本地 `wrangler dev` 请求量小、时序干净，经常复现不出来——不要因为本地不复现就排除这条。
2. **全文搜三个模式**：`let cache`、`new Map(`、`= fetch(`。跨请求状态一共就这几个入口，模块作用域里所有可变的、装 I/O 的东西都在里面。
3. **`wrangler tail` 带上路径和时间**。同一个 URL 第一次 200、之后 500，基本就锁定是复用缓存了；如果首次请求就炸，那要往「把别的请求的对象传进来了」方向查（中间件、共享 handler 参数传递）。

## 一句话总结

Worker 里能跨请求活下来的只有**纯数据**。任何带 body 或 stream 的对象，只属于创建它的那个请求，想留着用就先读成值。

系列里的另外两篇：[D1 报错 no such table](/p/d1-no-such-table)、[wrangler deploy 失败对照](/p/wrangler-deploy-errors)。

#cloudflare #workers #javascript
