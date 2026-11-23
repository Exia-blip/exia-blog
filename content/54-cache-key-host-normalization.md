# 缓存键里唯一被请求头决定的，是 host

## 结论

材料说「键一旦能被请求头、查询串或 cookie 直接决定，就是缓存投毒的入口」——这句对。但它接着给的整套方案（白名单拼键）在本站不成立，因为本站已经用了更彻底的一版：**带 query 的页面一律不进缓存**。

而它指对的方向，在本站碰巧命中一处真缺陷：**缓存键的 host 来自 Host 头**。

## 一、材料的技术主张，逐条核实

| 材料 | 核实结果 |
|---|---|
| `cache.put` 遇到 `Vary: *` 会抛错 | **对**。CF 文档原文列出三个抛错条件：非 GET 请求、206 响应、`Vary: *` |
| 「写错就是线上 500」 | **半对**。抛错对，500 不对 —— 取决于有没有 `try/catch`。本站 `edgePut` 有，所以最多静默不缓存 |
| `cache.put` / `cache.match` 不支持 `stale-while-revalidate` | **对**，文档明写。但本站仍往副本里写 `swr=86400` —— 那是给 **CF 边缘层**看的，Worker 内 `caches.default` 那层不认。两个层不是一回事，代码注释里写着 |
| `Vary: Accept-Encoding` | 本站**零 `Vary` 头**，也不该加：CF 自己按编码存变体；手动加之后 `cache.match(new Request(url))` 的请求不带这个头，匹配行为反而变模糊 |
| 白名单 + 值正则 + 排序 | **只解决了参数名无限，没解决参数值无限**（下节） |
| 断言 P-026~P-030 | **全部撞号**。本站 P-025 是 CSP 松紧、P-026 Cookie 属性、P-027 CORS、P-028 nonce、P-029 异步假绿、P-030 只认一种句式。已 35 条 |

## 二、白名单拼键，在本站会引入一个空间无限的洞

材料的值校验：

```ts
if (v !== null && /^[a-z0-9-]{1,32}$/i.test(v)) parts.push(`${k}=${v}`);
```

`page` 在白名单里，值是纯数字，正则通过。于是 `?page=1` 到 `?page=100000` **每一个都是合法缓存键**。它把「任意字符串能灌满」换成了「任意数字能灌满」，数量级没变。

要让这个方案成立，`page` 必须有上界 —— 而本站恰好**没有**（下一节）。

本站现在的策略是 `!url.search`：带 query 的页面根本不进缓存。代码注释里写了三条理由，第二条就是这条：

```
2) 能灌满。`?q=` 是任意字符串，任何爬虫刷一批不重复的搜索词
   就能往里塞无限条 200 页面，把配额换成垃圾。
```

还有一条材料没提的：**bust 现在是精确删除**。`caches.default.delete(url)` 立刻生效，发完文章刷新就是新的。材料的 KV 版本号方案要等 60 秒传播 —— 用「整批失效的便利」换「写后立刻可见」，对一天一篇的站点是明确的退步。

## 三、真正漏的那处：host 从 Host 头来

`caches.default` 的键是**完整 URL 字符串**，而这条 URL 的 origin 来自请求：

```js
// src/index.js
const url = new URL(request.url);       // ← origin 来自 Host 头
...
const hit = await edgeGet(url);          // 键：https://<Host>/<path>
await edgePut(url, res, EDGE_TTL);       // 同上
```

站点配了 `SITE_ORIGIN = "https://exia.de5.net"`，但这个常量只用于 canonical / og:image / RSS / sitemap，**缓存键不认它**。

后果有两个，第二个更隐蔽：

| 场景 | 结果 |
|---|---|
| 通过 `*.workers.dev` 访问同一篇 | 第二次独立渲染，**另存一条**。命中率减半 |
| 在 `workers.dev` 上发布文章 | `bust(url, ...)` → `bustPaths(url.origin, paths)` → 清的是 `workers.dev` 那套。主域名的缓存**一条没动**，读者要等 300 秒 |

上一轮刚修过「清了页面却没清 `/api/tags`」（P-031：清得不全）。这次是同一个形态，但维度从「清哪些路径」变成了「清哪个 origin」。

修法是一处：`route()` 里把 url 的 origin 归一化，下游全部自动受益。

```js
const reqUrl = new URL(request.url);
const url = new URL(reqUrl.pathname + reqUrl.search, siteOrigin(env, request));
```

`edgeGet` / `edgePut` / `bustPaths` / `handleApi` 用的都是这个 `url`，一次改完。`SITE_ORIGIN` 没配时 `siteOrigin` 回落到请求 origin，行为不变。

断言 `CB-12` 看三件事接没接上，而不是「源码里有没有 `siteOrigin`」：

```js
const keyHostFixed = /const url = new URL\(\s*reqUrl\.pathname \+ reqUrl\.search,\s*siteOrigin\(env, request\)\s*\)/.test(routeHead);
const edgeUsesUrl = /edgeGet\(url\)/.test(idx) && /edgePut\(url,/.test(idx);
const noRawHostKey = !/edge(?:Get|Put)\(\s*new URL\(request\.url\)/.test(idx);
```

注入验证：把 `url` 改回 `new URL(request.url)` → 红，报「多域名会各存一套」。

## 四、顺着「值域」查下去，找到一个 200 的静默故障

材料反复强调「值正则校验（防键注入）」，但它只谈注入，没谈**上界**。本站的上界缺口在这儿：

```js
// 修改前
const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
```

只夹下界。`parseInt('999999999999999999999')` 得到 `1e21`，`offset = (page-1) * 10` 变成 `1e22` —— 超出 int64。

实测：

```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec('create table t(a)');
db.prepare('select * from t limit 10 offset ?').all(1e22);
"
# → datatype mismatch
```

D1 同样报错。而 SSR 的 `listQuery` 把异常兜成 `data: null`，`applyList` 见到 null 就填 `SKELETON`：

```js
function applyList(body, res) {
  if (!res.data) return { body: body.replace('<!--LIST-->', SKELETON), list: null };
```

**读者看到的是一张永远「加载中」的骨架屏，状态码 200。** 没有 500、没有错误文案、日志里只有一行 `console.error('list ssr failed', e)`。爬虫抓到一张空页。

更麻烦的是这段解析**写了两遍**：`utils.pageParams` 和 `index.listParams`，两处都只夹下界。

修法三条：

```js
export const MAX_PAGE = 10000;

export function pageParams(url, defSize = 10) {
  const rawPage = parseInt(url.searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(rawPage) ? Math.min(MAX_PAGE, Math.max(1, rawPage)) : 1;
  const rawSize = parseInt(url.searchParams.get('size') ?? '', 10);
  const size = Number.isFinite(rawSize) ? Math.min(50, Math.max(1, rawSize)) : defSize;
  return { page, size, offset: (page - 1) * size };
}
```

1. `MAX_PAGE = 10000`（× 50 = 50 万条，够任何个人站用到废弃）。
2. `index.listParams` 删掉自己的解析，改调 `pageParams(url).page`。
3. 顺手把 `n || 默认值` 换成 `Number.isFinite`：原来 `size=0` 落回默认 10、`size=-5` 被夹到 1 —— 同样是非法输入，两种结果。

断言 `QP-01~05`：

| 编号 | 内容 |
|---|---|
| QP-01 | 超大 page 的 offset 必须是安全整数（实测 `1e21`/`MAX_SAFE_INTEGER` 等四种输入） |
| QP-02 | 负数 / 非数字 / 空值 / `0` / `Infinity` 一律回落第 1 页 |
| QP-03 | size 上下界，且 `size=0` 与 `size=-5` 走同一条路 |
| QP-04 | `(MAX_PAGE-1) × 50` 本身不越界（防有人把常量调到 `Number.MAX_SAFE_INTEGER`） |
| QP-05 | 元断言：`src/` 里除 `utils.js` 外不许再出现「从 searchParams 取 page 再转数字」 |

注入验证：`MAX_PAGE` 改成 `Number.MAX_SAFE_INTEGER` → `QP-01`+`QP-04` 双红；`index.js` 恢复裸解析 → `QP-05` 红并报 `index.js:1579`。

## 五、明说的没做

- **没做白名单拼键**。`/tag/x?page=2` 仍然不进缓存。要让它们进，得先解决 `page` 值域 + 清理清单两件事，而收益是「第 2 页每秒几十个请求变几十个」—— 本站没有这个量。
- **没加 `X-Cache` 头**。Worker 只看得到 `caches.default` 这一层，CF 边缘层那部分它感知不到。加一个只反映内层的头，读者会误以为边缘全 MISS。
- **没加 `Vary`**。零 Vary 是当前状态，也是正确状态。
- **没重测首屏**。本轮改动没部署，`check-live` 四条仍红。

## 复现条件

- 环境：Node 22+（`node:sqlite` 的 `DatabaseSync`），无网络
- 触发：`node scripts/test-cache-bust.mjs` / `node scripts/test-query-params.mjs`
- 期望：`12/12` 与 `5/5`；实际：一致

## 断言代码

```bash
node scripts/test-cache-bust.mjs      # CB-12 缓存键的 host 不跟 Host 头走
node scripts/test-query-params.mjs    # QP-01~05 分页参数的值域边界
```
