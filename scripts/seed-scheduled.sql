-- 由 scripts/seed-scheduled.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态

INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('three-layer-cache', '三层缓存怎么排，才不会被 Cloudflare 改写成 4 小时', '## 结论

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
headers.set(''cache-control'', `public, s-maxage=${ttl}`);

// 改之后：swr 一起写进去
headers.set(''cache-control'', `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
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
', 'log', '三层缓存各看一个头，配错一层症状完全不同：浏览器层被 zone 改写会让所有人都看不到更新。',
        '', 0, 0, 0, 1, '2026-11-25 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('cache') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'three-layer-cache' AND t.name = 'cache';
INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'three-layer-cache' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('http') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'three-layer-cache' AND t.name = 'http';


INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('jwt-exp-verify', 'JWT 的 exp 到底在哪一层被校验', '## 结论

`exp` 在 payload 里，payload 只是 base64url。任何人拿到一枚 token，不验签就能读出 `exp` 是哪一秒，也能把它改成明天——重新编码拼回去，解出来看到的还是新值。它之所以真的会"过期"，唯一原因是**验签方在验签之后主动拿当前时间去比了一次**。没有那次比较，`exp` 等于一条写给自己看的注释。

比较这件事可能发生在三个地方：边缘/网关、框架的认证中间件、业务 handler 里手写的几行。位置不同，安全性差别没有想象中大，真正的差别是**过期 token 能走多远**，以及 401 由谁产出。放在最外层，业务代码永远见不到过期 token；放在 handler 里，每个 handler 都得自己记得写。

库的默认行为基本都是"验签顺便验 exp"。但验签和查过期在代码里是两个独立动作，绕过去的路径有三条：只调 `decode`、手写 HMAC 比较、给 `verify` 传 `ignoreExpiration`。前两条尤其常见——`decode` 的名字听起来像"验证"，实际只做 base64 解码加 JSON parse，一个字节都没验。

`exp` 缺失比过期更常见。RFC 7519 里 `exp` 是 OPTIONAL，`jsonwebtoken` 和 `jose` 默认都不要求它。缺了就是永久有效，而且不报错。

本站自己的校验就是这么写的：

```js
if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
```

`data.exp &&` 这个前缀的意思是「有 `exp` 才检查，没有就当没过期」。我拿本地脚本对这个函数喂了五枚 token，缺 `exp`、`exp` 是字符串、`exp` 是 `null`、`exp` 写成毫秒——全部放行，只有「昨天已经过期」那枚被拦下。四格全过，一个都没拦住。

这个缺口实际不可利用：`signToken()` 每次都会写入 `exp`，要造一枚不带 `exp` 的 token 得先有 `SESSION_SECRET`，而拿到 secret 之后本来就能随便签。所以它不是漏洞，是**代码正确性依赖了调用方的自觉**——眼下唯一的调用方守规矩，哪天多一个调用方就未必了。这种缺陷不会挨打，只会慢慢长成负债。

到期不等于撤销。`exp` 过了只是"从这一刻起不再被接受"，服务端没有删除任何东西，签出去的 token 仍在别人手里。要让它立刻作废，只能靠查库、黑名单，或者把有效期压到很短再配 refresh。

时间源是另一层。`exp` 是 Unix 秒，签发方和校验方的钟差几十秒是常态，所以各家的 `verify` 都留了容差参数（`clockTolerance` / `leeway`），典型值 30~60 秒。容差不是"多活一会儿"的开关，它的边界比多数人以为的更硬——这个后面用实测数据说。

这是「认证边界」系列的第一篇。后面几篇会接着拆 cookie 的 `Domain`/`Path`、CSRF、以及反向代理下的 `X-Forwarded-*` 到底能信几成。

## 一、把 token 拆开，先看 exp 是什么

造一枚过期 30 秒的 token，什么都不验，直接拆。

```js
// decode.mjs —— 不验签，纯拆包
import jwt from ''jsonwebtoken'';

const token = jwt.sign({ uid: 7, admin: 0, exp: Math.floor(Date.now() / 1000) - 30 }, ''lab-secret'');

const [h, p, s] = token.split(''.'');
console.log(''段数'', token.split(''.'').length, ''各段长度'', h.length, p.length, s.length);
console.log(''header '', Buffer.from(h, ''base64url'').toString());
console.log(''payload'', Buffer.from(p, ''base64url'').toString());
```

输出：

```text
段数 3 各段长度 36 71 43
header  {"alg":"HS256","typ":"JWT"}
payload {"uid":7,"admin":0,"exp":1794501998,"iat":1794502028}
```

三段加起来 152 个字符（含两个点），header 36、payload 71、签名 43。base64url 不是加密，它是编码，用 `Buffer.from(p, ''base64url'')` 一行就还原了。浏览器的 DevTools、任何代理的日志、随手一个在线解码器，都能看到同样的内容。

改也不难。把 `admin` 改成 1、`exp` 改成明天，签名原封不动：

```js
const raw = JSON.parse(Buffer.from(p, ''base64url'').toString());
raw.admin = 1;
raw.exp = Math.floor(Date.now() / 1000) + 86400;

const forged = `${h}.${Buffer.from(JSON.stringify(raw)).toString(''base64url'')}.${s}`;

jwt.verify(forged, ''lab-secret'');   // 抛 JsonWebTokenError: invalid signature
jwt.decode(forged);                 // 照样返回 { uid: 7, admin: 1, exp: 1794588435, ... }
```

这两行的对比就是全部答案：**校验方拒绝它，是因为签名对不上；解码方照样读得出你改过的值，因为解码根本不看签名**。`exp` 这个字段的可信度，完全等于"有没有人替你验过签名"。

RFC 7519 §4.1.4 对它的定义只有两句关键的话：

> The `exp` (expiration time) claim identifies the expiration time on or after which the JWT MUST NOT be accepted for processing.
>
> The processing of the `exp` claim requires that the current date/time MUST be before the expiration date/time listed in the `exp` claim.

注意 "MUST NOT be accepted **for processing**" 和 "**processing** of the claim requires"。规范约束的是**处理方**的行为，不是 token 自身的性质。一枚 `exp` 已经过去的 token 在物理上完好无损，字节一个不少，它只是"不应该再被接受"。这句话是写给收 token 的那个人看的，不是写给 token 看的。

所以 `exp` 生效需要三个条件同时成立：有人验签、有人比较、比较用的是可信的时间。少任何一个，这个字段就退化成注释。下面几节逐个拆。

## 二、三个校验位置，决定 token 能走多远

同一段校验代码，放在不同层，行为差别很大。

| 位置 | 典型实现 | 拦在哪 | 过期 token 会到达哪 | 401 由谁产出 |
|---|---|---|---|---|
| 边缘 / 网关 | Cloudflare Worker 入口、nginx + lua、API Gateway 的 JWT authorizer | 请求进入业务代码之前 | 到不了业务代码，连路由都不匹配 | 网关 |
| 框架认证中间件 | Express + passport-jwt、Hono 的 `jwt()` 中间件 | 路由匹配之后、handler 之前 | 到不了 handler，但路由已经跑过 | 中间件 |
| 业务 handler 手写 | 每个接口开头自己 `verify` 一次 | 每个 handler 内部 | 已经在业务逻辑里了 | 每个 handler 各写各的 |

这张表里只有第三列和第四列是我在意的。安全性的差别没有那么大——三层都能验签，验签代码也基本是同一份。差别在于**失败路径的形状**。

放网关，过期 token 的失败是一条直线：请求进来，签名不对或时间过了，直接 401，日志里一行，后面什么都不用管。放中间件，多了一层"这个路由要不要认证"的判断，公开路由得显式跳过，跳过的地方就是漏的地方。放手写，失败路径的数量等于 handler 的数量，而 handler 是会增加的。

还有一件容易被忽略的事：**状态码的语义**。过期和没权限是两种情况，前者应该让客户端去刷新或重新登录，后者刷新一百次也没用。位置越靠近业务，这两种错误越容易被合并成一个 403 或者一句"操作失败"。放网关，区分它们几乎是免费的，因为网关只有"放行"和"不放行"两种出口，你被迫在写这一层时就想清楚；放 handler，`return null` 一行就糊过去了，反正前端也只会弹一个"请重新登录"。

本站把两者分开了：`currentUser` 返回 `null` 表示"没有有效身份"，`requireAdmin` 在拿到用户之后再判 `is_admin`，返回 `403 {"ok":false,"error":"需要管理员权限"}`（`src/auth.js:283`）。过期的 token 走不到那一行，它在 `currentUser` 里就变成了 `null`，被 `requireUser` 拦成 `401 {"ok":false,"error":"未登录"}`。前端拿 401 去跳登录页，拿 403 提示权限不足，两条路不重叠。

本站属于第三种的变体，位置很特殊：没有独立网关，Cloudflare Worker 本身就是边缘，但校验写在 `handleApi` 的第一行——

```js
// src/api.js:299
export async function handleApi(env, request, url, ctx) {
  const db = env.DB;
  const path = url.pathname.replace(/^\/api/, '''') || ''/'';
  const method = request.method;
  const user = await currentUser(env, request);   // 每个 /api/* 请求都过这里
```

`currentUser` 做的就是 `parseCookies` → `verifyToken` → 查 D1。所以从效果上看它接近"网关"：所有 `/api/*` 都过一遍，公开接口也不例外（`/api/site`、`/api/posts` 明明不需要登录，也照样验一次、查一次库）。代价是每个 API 请求多一次 D1 往返，收益是不存在"忘了给这个路由加认证"这种事。

页面层是另一套，而且它**只看 cookie 存不存在，不看内容**：

```js
// src/index.js:1461 —— 决定这页能不能进边缘缓存，不做鉴权
const cookie = request.headers.get(''cookie'') || '''';
const loggedIn = /(^|;\s*)sid=/.test(cookie);
const cacheable = request.method === ''GET'' && !loggedIn && isPagePath(url.pathname);
```

一个正则，匹配到 `sid=` 就算"登录了"，`exp` 过没过完全不参与。这行代码的本意是缓存旁路（带 cookie 的请求不缓存，避免串号），不是鉴权，所以它写错也不会造成越权——页面 HTML 里本来就不含用户数据。但它说明一件事：**"代码里出现了 cookie 判断"和"这里在校验过期"是两件不同的事**。我在读自己的代码时，第一眼就把这行当成了登录判断，看到 `loggedIn` 这个变量名，差点就跳过去了。

## 三、"验签通过"和"没过期"是两个判断

我见过最多的一种写法长这样：函数叫 `verify`，签名比得很认真，`exp` 就在解出来的对象里躺着，没人碰。

```js
// 反例：验签是对的，过期没人管
import crypto from ''node:crypto'';

export function verify(secret, token) {
  const [h, p, s] = String(token).split(''.'');
  if (!h || !p || !s) return null;

  const want = crypto.createHmac(''sha256'', secret).update(`${h}.${p}`).digest(''base64url'');
  if (s.length !== want.length) return null;                       // 长度不等时 timingSafeEqual 会抛
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;

  return JSON.parse(Buffer.from(p, ''base64url'').toString());       // exp 就在里面，没人看
}
```

这段代码有一个很强的误导性：它确实"验了"，`timingSafeEqual` 用得也对，注释也写了为什么先比长度。review 的时候注意力全在签名上，`exp` 那个字段看起来像是"解出来自然就生效了"。

它不生效。`JSON.parse` 不做任何检查，它只是把 JSON 变成对象。这段函数对一枚 2019 年签发的 token 和一枚刚刚签发的 token，返回完全一样的结果。

改正版多了几行判断，顺序和判据都有讲究：

```js
// 正例：验签之后，显式比较 exp，判据是 now >= exp
const MAX_TTL = 60 * 60 * 24 * 30;   // 自己签发的最长有效期，30 天

export function verify(secret, token, now = Math.floor(Date.now() / 1000)) {
  const [h, p, s] = String(token).split(''.'');
  if (!h || !p || !s) return null;

  const want = crypto.createHmac(''sha256'', secret).update(`${h}.${p}`).digest(''base64url'');
  if (s.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(p, ''base64url'').toString());
  } catch {
    return null;                                     // payload 不是 JSON，别让异常冒到路由层
  }

  if (typeof claims.exp !== ''number'' || !Number.isFinite(claims.exp)) return null;  // 缺了、字符串、null 全拒
  if (now >= claims.exp) return null;                                               // RFC："MUST be before"
  if (claims.exp > now + MAX_TTL) return null;                                      // 挡毫秒误写，见第五节

  return claims;
}
```

`now >= exp` 而不是 `now > exp`，这个符号不是风格问题。RFC 说的是"当前时间必须早于 `exp`"，所以 `now == exp` 那一刻就已经不该被接受了。我原先写的是 `<`（等价于 `now > exp` 才算过期），实测时它让 `exp` 正好等于当前秒的 token 多活了一秒。一秒听起来无所谓，但它意味着我的实现和 `jsonwebtoken`、`jose` 在边界上不一致——两个服务对同一枚 token 给出相反结论，这种问题排查起来能耗掉一晚上。

同一枚过期 30 秒的 token，打三种接口，状态码的差别是这样的：

| 接口实现 | 状态码 | 响应体 |
|---|---|---|
| 只 `jwt.decode`，拿 `uid` 就用 | `200` | `{"ok":true,"uid":7}` |
| `jwt.verify`，捕获异常返回 401 | `401` | `{"ok":false,"error":"TokenExpiredError"}` |
| 照本站 `verifyToken` 那套（验签 + `exp`） | `401` | `{"ok":false,"error":"未登录"}` |

第二行和第三行的区别只在错误文案。第一行是灾难。而它在代码里的样子，和另外两行几乎一模一样——都是"从 token 里取出 uid"。

这类 bug 能活下来，靠的是命名。函数叫 `verify`，调用方就默认它把该做的都做了。我现在的习惯是把返回值的名字写死：`verify` 只返回 `boolean`，取 claims 必须调另一个函数 `readClaims`，两个函数分开，调用方想跳过检查就得显式多写一行。麻烦一点，但"忘了查"变成了一件需要主动做的事。

## 四、exp 是秒，但不是"你的"秒

RFC 7519 §2 定义 `NumericDate`：从 1970-01-01T00:00:00Z UTC 起的秒数，忽略闰秒。三个关键词：秒、UTC、忽略闰秒。任何一个搞错，`exp` 就偏了。

毫秒是最常见的一种。`Date.now()` 返回毫秒，`Date.now() / 1000` 才是秒，中间那个除以 1000 很容易漏。我拿本站的 `signToken` 造了一枚 `exp: Date.now() + 3600_000` 的 token：

```text
exp = 1794505643297 (秒是 1794502043)
verifyToken = { uid: 1, admin: 1, exp: 1794505643297 }
```

校验通过了。1794505643297 秒是公元 5.7 万年之后，这枚"一小时有效"的 token 实际上是永久的。它不会报错，不会告警，`exp` 字段看起来还挺像个正经时间戳——13 位和 10 位，肉眼扫过去差别不大。

时钟偏差是另一种，而且是结构性的。签发方和校验方是两台机器，两台机器的钟各自跑。方向别记反：`exp` 是签发方用自己的钟算出来的，所以签发方的钟快 40 秒，签出来的 token 就多活 40 秒；签发方的钟慢 40 秒（或者校验方的钟快 40 秒），这枚 token 会提前 40 秒被判死。后一种表现为"刚登录就掉线"，前一种表现为"有效期比配置的长一点，没人发现"。两种都很难复现，因为触发条件是钟差，不是代码。

所以规范里留了口子：

> Implementers MAY provide for some small leeway, usually no more than a few minutes, to account for clock skew.

`jsonwebtoken` 把它叫 `clockTolerance`，单位秒，默认 `0`；`jose` 同名同默认值。用法只多一个参数：

```js
import jwt from ''jsonwebtoken'';

try {
  // 允许两端钟差 60 秒：签发方慢 60 秒、校验方快 60 秒，都还能过
  const claims = jwt.verify(token, process.env.SESSION_SECRET, {
    clockTolerance: 60,
    algorithms: [''HS256''],       // 显式限定算法，别让 header 里的 alg 决定用什么验
  });
  return claims;
} catch (e) {
  if (e.name === ''TokenExpiredError'') return null;   // 过期 -> 401
  throw e;                                           // 签名错、格式错是另一类，别一起吞
}
```

容差的边界比名字听起来硬。我按"过期了多少秒 × 容差多少秒"扫了一遍，`jsonwebtoken` 9.0.3：

| token 已过期 | `clockTolerance: 0` | `clockTolerance: 60` |
|---|---|---|
| 30 秒 | `TokenExpiredError: jwt expired` | 通过 |
| 60 秒 | `TokenExpiredError: jwt expired` | `TokenExpiredError: jwt expired` |
| 61 秒 | `TokenExpiredError: jwt expired` | `TokenExpiredError: jwt expired` |
| 90 秒 | `TokenExpiredError: jwt expired` | `TokenExpiredError: jwt expired` |

`60 秒` 那一行是重点：过期整 60 秒、容差也给了 60 秒，仍然被拒。`jsonwebtoken` 的判据写在 `verify.js:189`：`clockTimestamp >= payload.exp + (options.clockTolerance || 0)`，两端相等时就算过期。所以"容差 60 秒"对一枚已经过期的 token 来说，实际容忍的是 59 秒，而不是 60 秒。`jose` 6.2.17 的结果一模一样（`ERR_JWT_EXPIRED`，`claim=exp`，`reason=check_failed`），它俩在这条边界上是对齐的。

反方向也一样，只是差一秒的边界落在另一侧。`verify` 有一个 `clockTimestamp` 参数可以覆盖"现在"，等于把校验方的钟往前拨，用它就能把钟差现象在单机上复现出来。签一枚 60 秒后过期的 token，把校验方的钟往前拨 N 秒：

| 校验方快 | `clockTolerance: 0` | `clockTolerance: 60` |
|---|---|---|
| 0 秒 | 通过 | 通过 |
| 30 秒 | 通过 | 通过 |
| 59 秒 | 通过 | 通过 |
| 60 秒 | `TokenExpiredError` | 通过 |
| 61 秒 | `TokenExpiredError` | 通过 |
| 120 秒 | `TokenExpiredError` | `TokenExpiredError` |

同一张表读两遍，结论是相反的：钟快 60 秒时，容差 60 刚好能救回来（`now+60 >= exp+60` 不成立）；而一枚已经过期 60 秒的 token，容差 60 救不回来（`now >= now-60+60` 成立）。差别就在等号落在哪一边。这也解释了为什么"容差设成 60 就安全了"是个错觉——它只在一个方向上有 60 秒的余量，另一个方向只有 59 秒。

容差值给多少，取决于链路上有几台机器、各自的钟怎么同步。RFC 说"不超过几分钟"，实践里 30~60 秒够用。给到 300 秒以上通常是掩盖问题：要么签发方的钟真的偏了几分钟（那是运维问题），要么有人想偷偷延长 token 寿命（那应该改 `exp`，不是改容差）。

本站没有容差。`verifyToken` 用的是严格小于，`data.exp < now` 才拒绝，等于容差 0。这在 Worker 上问题不大——运行时是平台的，钟由平台同步；但本机 `wrangler dev` 和线上同时跑的时候，两边的秒不一定对得齐，这是推断，我没在两条链路上同时打过同一枚 token 去测。

## 五、没有 exp 的 token 是永久的

`exp` 在 RFC 里是 OPTIONAL，原文结尾那句就是 "Use of this claim is OPTIONAL."。规范允许不写，库也就不强制。我把两台库的默认行为都跑了一遍：

| 写法 | 有 `exp` 且已过期 | 没有 `exp` | `exp` 不是数字 | 容差参数 |
|---|---|---|---|---|
| `jsonwebtoken` 9.0.3 `verify` | 抛 `TokenExpiredError: jwt expired` | **通过** | 抛 `JsonWebTokenError: invalid exp value` | `clockTolerance`，默认 `0` |
| `jose` 6.2.17 `jwtVerify` | 抛 `ERR_JWT_EXPIRED`（`claim=exp`） | **通过**，除非传 `requiredClaims` | 抛 `ERR_JWT_CLAIM_VALIDATION_FAILED` | `clockTolerance`，默认 `0` |
| 本站 `verifyToken` | 返回 `null` | **通过** | **通过**（只要 truthy） | 无 |

三行里有三个"通过"落在"没有 `exp`"这一列。这不是库的缺陷，是规范的直接后果：一个可选字段没写，校验方没有理由拒绝。`jsonwebtoken` 的源码里那段判断（`verify.js:185`）是 `typeof payload.exp !== ''undefined'' && !options.ignoreExpiration`，进了这个 `if` 才比较；`exp` 不存在，整段跳过。

本站的那一行更微妙：

```js
// src/utils.js:78
if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
```

`data.exp &&` 这个前置条件是为了防止 `undefined` 参与比较（`undefined < 1794502043` 是 `false`，会让缺 `exp` 的 token 意外通过——作者显然想到了这一层）。但加了这个短路之后，缺 `exp` 就直接跳到 `return data`。**防住了一个假问题，放过了一个真问题。**

我照本站的两段式格式造了四枚 token，打到一个只调 `verifyToken` 的接口上：

```text
过期 30s     -> 401 {"ok":false,"error":"未登录"}
缺 exp      -> 200 {"ok":true,"uid":7}
exp 是毫秒    -> 200 {"ok":true,"uid":7}
exp == now -> 200 {"ok":true,"uid":7}
```

第二行是这节要说的事。攻击面不在"攻击者能不能造出这种 token"——他造不出来，没有 `SESSION_SECRET` 签不出合法签名。真正的风险是**代码自己签发了一枚没有 `exp` 的 token**。签名是合法的，校验也通过，谁都没做错，它就是永久的。签发点一多，总有一个地方忘了传 TTL。

检测这件事有三个动作，成本从低到高：

**一、数签发点。** 所有 `sign`／`signToken`／`new SignJWT` 的调用，逐个看有没有传过期时间。

```bash
# 本站只有一处签发，参数 60*60*24*30 写死在调用处，没有默认值兜底
grep -rn "signToken(" src/
```

结果只有一条：`src/auth.js:233`。这就是"签发点收敛到一个函数"的好处——查一遍等于查全部。如果签发散在十几个 handler 里，这条命令的输出会长到没人愿意看完。

**二、拿一枚无 `exp` 的 token 打接口。** 这是唯一能证明"线上真的会放行"的方法，静态读代码只能证明"可能"。

**三、把判据反过来写。** 不要问"`exp` 过期了吗"，要问"`exp` 是不是一个合理的未来时间"。前者默认放行、异常拦截，后者默认拦截、异常放行：

```js
// 白名单式判据：先证明它合法，再放行
function expOk(exp, now = Math.floor(Date.now() / 1000), maxTtl = 60 * 60 * 24 * 30) {
  if (typeof exp !== ''number'' || !Number.isFinite(exp)) return false;  // 缺、字符串、null、NaN
  if (exp <= now) return false;                                        // 过期（含 exp == now）
  if (exp > now + maxTtl) return false;                                // 秒写成毫秒、TTL 被改大
  return true;
}
```

第三条同时挡住了毫秒误写。`exp = 1794505643297` 会落在 `exp > now + maxTtl` 这一支，因为任何合法 token 的 `exp` 都不可能超过"现在 + 我签发过的最长 TTL"。这个上界的值不需要精确，30 天、90 天都行，它只用来区分"10 位秒"和"13 位毫秒"。

## 六、到期不是删除

`exp` 过去的那一刻，服务端什么都没发生。没有记录被删，没有连接被断，token 本身完好无损地留在对方的 localStorage、cookie、日志、截图里。改变的只有一件事：**校验方从这一刻起拒绝接受它**。这是纯客户端约定，靠的是双方都守规矩。

所以"令牌泄露了，等它过期就好"这句话，只在一种情况下成立：泄露方不知道 `SESSION_SECRET`，且 `exp` 足够短。前者成立，后者通常不成立——本站的 `exp` 是 30 天。

要真正让一枚 token 失效，只有三条路：

| 方案 | 生效延迟 | 需要存什么 | 能改权限吗 | 代价 |
|---|---|---|---|---|
| 短 `exp` + refresh token | 等到 `exp`，通常 5~15 分钟 | refresh token 本身 | 不能，得等下一次换发 | 前端要处理续期，请求会翻倍 |
| 黑名单（存已撤销的 `jti`） | 立即 | 每条被撤销的 token | 不能 | 又变成有状态，还得给黑名单设过期清理 |
| 每次请求查库 | 立即 | 用户表／会话表 | 能，改库即生效 | 每个请求一次存储往返 |

第一条路的坑在 refresh token 自己身上。为了让 access token 短命，refresh token 必然长命，于是它成了新的高价值目标；而且它必须每次刷新都换新、旧的立刻作废（rotation），否则一枚泄露的 refresh token 可以无限续下去，短 `exp` 就白设了。rotation 又需要"记住哪些 refresh token 已被用过"——绕一圈还是回到了状态存储。区别只是那张表比用户表小，而且可以按行过期。想靠纯无状态把撤销做掉，终究会撞上这堵墙。

本站走的是第三条。`currentUser` 每次都用 `payload.uid` 去 D1 查一遍 `users`，所以删掉一个用户、或者把 `is_admin` 从 1 改成 0，下一个请求立刻生效，不用等 30 天。代价是每个 `/api/*` 请求多一次 D1 查询——包括那些根本不需要登录的公开接口。

这条选择带来一个副作用，值得单独说：**JWT 的主要卖点在本站一条都没用上**。JWT 的价值是"claims 自带，校验方不用查库"，而本站每条请求都查库。既然一定要查，token 里放 `uid` 就够了，其余的字段都是冗余。事实上 `signToken` 签进去的 `admin` 字段，全站没有任何地方读过：

```text
$ grep -rn "payload\." src/
src/auth.js:267:  if (!payload || !payload.uid) return null;
src/auth.js:269:    .bind(payload.uid)
```

只有 `uid`。`admin` 是签的时候顺手写进去的，权限判断用的是从 D1 查出来的 `is_admin`（`src/auth.js:283`）。这个字段现在的唯一作用是让 payload 段从 35 个字符变成 48 个字符（base64 之前是 26 个字符和 36 个字符），以及给人一个"权限在 token 里"的错觉——如果哪天有人图省事改成读 `payload.admin`，那才是个真洞：改权限得等 30 天，或者得换 secret 让所有人重新登录。

`logout` 也一样。它只是把 cookie 的 `Max-Age` 设成 0：

```js
export function logout() {
  return new Response(null, { status: 302, headers: { location: ''/'', ''set-cookie'': clearCookie(COOKIE) } });
}
```

浏览器会把 `sid` 删掉，但服务端没有记录任何"这枚 token 已作废"的信息。如果这枚 token 在登出前被复制过（比如贴在 curl 里、存在另一个浏览器里），它在剩下的 30 天里照样有效。这不是实现 bug，是无状态 token 的定义：**服务端从来没有"持有"过它，也就无从"收回"它**。想让登出真的登出，得在 D1 里存一个 `session_version`，签发时写进 payload，校验时比对——那就又回到查库了，而本站本来就在查。

## 七、本站没写 JWT，写了个两段式

翻到 `src/utils.js:59`，本站的会话 cookie 长这样：

```js
export async function signToken(secret, payload, ttlSec = 60 * 60 * 24 * 30) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64u(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign(''HMAC'', await hmacKey(secret), new TextEncoder().encode(p));
  return `${p}.${b64u(sig)}`;
}
```

两段：`base64url(payload).base64url(hmac)`。没有 header，没有 `alg` 字段，没有 `typ`。拿 `{uid:1,exp:1794502181}` 这份 claims 算：JSON 26 字节，base64url 后 35 字符；HMAC-SHA256 签名 32 字节，base64url 后 43 字符；加中间一个点，共 79 字符。等价的 JWT 会在前面多一段 36 字符的 header 和另一个点，共 116。

它和 JWT 的差别不是"简化版 JWT"，而是两个不同的东西：

| | 标准 JWT | 本站的两段式 |
|---|---|---|
| 段数 | 3（header.payload.signature） | 2（payload.signature） |
| 算法声明 | 在 header 里，由 token 自己说 | 不在 token 里，由代码写死 HMAC-SHA256 |
| `alg: none` 攻击面 | 有，取决于库的实现 | 不存在，没有这个字段可改 |
| 其他库能否验证 | 能，任何 JWT 库都行 | 不能，只能自己实现 |
| 长度 | 116 字符（同样的 claims，多出一段 36 字符的 header 和一个点） | 79 字符 |

选它的理由很实际：这个 cookie 只有本站的 Worker 会读，不存在"第三方要验我的 token"的需求，也就不需要标准格式和算法协商。没有 `alg` 字段，就没有"token 自己声明用什么算法"这个问题——`jsonwebtoken` 9.0.3 在这件事上已经处理得很好了，我照 `alg: none` 搓了一枚，无论 `algorithms` 里放不放 `none`，它都直接给 `JsonWebTokenError: jwt signature is required`。但那是它的实现细节，不是所有库、所有版本都一致；本站干脆把这个问题从数据结构里删掉了。

代价也很实在。第一，任何标准工具都不认它——调试只能自己写脚本，`jwt.io` 贴进去会报格式错误。第二，`verifyToken` 按"两段"写死了：

```js
const [p, s] = token.split(''.'');   // 三段 token 进来时，p 是 header，s 是 payload
```

一枚标准的三段 JWT 打进来，`p` 拿到的是 header，`s` 拿到的是 payload，HMAC 必然对不上，返回 `null`。方向是安全的（失败即拒绝），但错误信息是零——它和"签名错"、"secret 换了"、"token 被截断"共用同一个返回值 `null`，排查时完全分不出来。这一点我只能靠读代码知道，没在线上遇到过，因为前端从来不会往这个 cookie 里塞三段 token。

值不值得换回标准 JWT？以现在的用法，不值得。本站的 cookie 本质上是"自带过期时间的签名 session id"，真正的权限数据在 D1 里，`claims` 只用到 `uid` 一个字段。用标准 JWT 会多出 header、`alg` 协商、`kid`、JWKS 这一整套东西，换来的互操作性在本站没有使用场景。哪天要接第二个服务、或者要把 token 交给第三方验，那就该换——不是因为 JWT 更安全，是因为那时候"标准"本身有了价值。

## 八、五种畸形 token 的实测结果

把前面散落的边界收成一张表。同一个 secret，三种校验实现，五种畸形输入：

| token 形态 | 本站 `verifyToken` | `jsonwebtoken` 9.0.3 | `jose` 6.2.17 |
|---|---|---|---|
| 缺 `exp` | `200` 通过 | 通过 | 通过 |
| `exp: "1794502181"`（字符串） | `200` 通过 | `invalid exp value` | `"exp" claim must be a number` |
| `exp: null` | `200` 通过 | `invalid exp value` | `"exp" claim must be a number` |
| `exp` 写成毫秒 | `200` 通过 | 通过 | 通过 |
| `exp == now` | `200` 通过 | 过期 | 过期 |

五行全是 200。这不是"更宽松"的设计选择，是四个独立的判断缺口叠在一起：`data.exp &&` 放过了缺失和 `null`，`<` 放过了相等，没有上界放过了毫秒；字符串那一格是 JS 的隐式转换帮了忙——`"1794502181" < 1794502043` 会把左边转成数字再比，结果是 `false`，于是通过。

`jsonwebtoken` 和 `jose` 在"缺 `exp`"和"毫秒"两格上一样是放行的。这两件事不是本站的独家问题，是所有 JWT 实现的共同默认：**`exp` 是可选字段，你写了它才管，没写它不管，写错单位它也不管**。库能帮你验签、能帮你比大小，但"这个 token 该不该有过期时间"这个决定，只能由签发方做。

毫秒那一格特别值得盯。它不是"少了一道检查"，是"检查通过了但值是错的"。任何依赖 `exp < now` 的判断，对 13 位时间戳都会给出"还有很久才过期"的结论，而且一年、十年、五万年都是同一个结论。这种错不会随着时间暴露，只会随着时间变得更错。

## 怎么自己验一遍

不需要装任何依赖，Node 22 自带 `crypto` 和 `fetch`。整个流程是：造五枚 token → 打自己的接口 → 看除第一枚之外是不是全被拒绝。

**第一步，起一个能被控制的对照服务。** 直接打线上也行，但线上你不方便改校验逻辑做 A/B，而且过期 token 打生产接口会污染日志。用本地服务，十几行就能起：

```js
// server.mjs —— 只做一件事：把 verify 的结果翻译成状态码
import http from ''node:http'';
import { verifyToken } from ''./src/utils.js'';   // 换成你自己的校验函数

const SECRET = process.env.SESSION_SECRET || ''lab-secret'';

http.createServer(async (req, res) => {
  const tk = (req.headers.authorization || '''').replace(/^Bearer /, '''')
    || (req.headers.cookie || '''').match(/(?:^|;\s*)sid=([^;]+)/)?.[1] || '''';
  const claims = await verifyToken(SECRET, decodeURIComponent(tk));

  res.writeHead(claims ? 200 : 401, { ''content-type'': ''application/json'' });
  res.end(JSON.stringify(claims ? { ok: true, uid: claims.uid } : { ok: false, error: ''未登录'' }));
}).listen(8787, ''127.0.0.1'', () => console.log(''http://127.0.0.1:8787''));
```

**第二步，造 token 并打过去。** 关键是五枚 token 除 `exp` 外完全一致，这样状态码的差异只能来自 `exp`：

```js
// forge.mjs —— 造五枚只有 exp 不同的 token，逐枚打接口
import crypto from ''node:crypto'';

const SECRET = process.env.SESSION_SECRET || ''lab-secret'';
const BASE = ''http://127.0.0.1:8787'';
const b64u = (s) => Buffer.from(s).toString(''base64url'');
const now = Math.floor(Date.now() / 1000);

// 两段式，和本站 signToken 的输出格式一致
function mint(claims) {
  const p = b64u(JSON.stringify(claims));
  const sig = crypto.createHmac(''sha256'', SECRET).update(p).digest(''base64url'');
  return `${p}.${sig}`;
}

const cases = [
  [''正常，10 分钟后过期'', { uid: 7, exp: now + 600 }],
  [''过期 30 秒'',        { uid: 7, exp: now - 30 }],
  [''没有 exp'',          { uid: 7 }],
  [''exp 写成毫秒'',      { uid: 7, exp: Date.now() + 600_000 }],
  [''exp 正好是现在'',    { uid: 7, exp: now }],
];

for (const [label, claims] of cases) {
  const tk = mint(claims);
  const r = await fetch(`${BASE}/api/me`, { headers: { cookie: `sid=${tk}` } });
  console.log(label.padEnd(18), r.status, (await r.text()).slice(0, 80));
}
```

跑出来的样子（这是本机实测的输出，`src/utils.js` 的 `verifyToken` 原样调用）：

```text
正常，10 分钟后过期        200 {"ok":true,"uid":7}
过期 30 秒            401 {"ok":false,"error":"未登录"}
没有 exp             200 {"ok":true,"uid":7}
exp 写成毫秒           200 {"ok":true,"uid":7}
exp 正好是现在          200 {"ok":true,"uid":7}
```

判据只有一条：**除了第二行，其余四行都该是 401**。现在只有一行是 401，说明校验函数只挡住了"`exp` 存在且已经过去"这一种情况。

**第三步，用 curl 复核。** 脚本能证明逻辑，curl 能证明"这东西真的能从网络上传过去"——`HttpOnly` 和 `Secure` 保护的是浏览器，不是线路，任何拿到 cookie 值的人都可以这样发：

```bash
TOKEN=''eyJ1aWQiOjcsImV4cCI6MTc5NDUwMTk3MH0.xxxxx''
curl -s -i http://127.0.0.1:8787/api/me -H "cookie: sid=$TOKEN"
# HTTP/1.1 401 Unauthorized
```

**第四步，把判据补上，重跑。** 改 `verifyToken` 里那一行：

```js
// 改前：缺 exp 直接跳过比较
if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;

// 改后：先证明 exp 合法，再放行
const now = Math.floor(Date.now() / 1000);
if (typeof data.exp !== ''number'' || !Number.isFinite(data.exp)) return null;
if (data.exp <= now) return null;
if (data.exp > now + 60 * 60 * 24 * 30) return null;
```

重跑 `forge.mjs`，期望只剩第一枚 200，其余四枚全部 401。这一改会让所有"没有 `exp` 的老 token"立即失效。本站的 `signToken` 无条件写入 `exp`，翻遍 `src/` 也只有一处签发，所以存量 token 全都有 `exp`，影响范围是零；但如果你的站曾经有一段时间没写 `exp`，改之前先统计一下存量。

收尾留三个自查项，按能查到的概率排序：

1. **所有签发点是不是都传了 TTL。** `grep -rn "sign\|SignJWT" src/`，一个个看。签发点收敛到一个函数的话，这条两分钟能查完。
2. **校验函数对"缺 `exp`"返回什么。** 造一枚无 `exp` 的 token 打过去，200 就是洞。这一条比读代码可靠，因为 `data.exp &&` 这种写法读起来很像是"已经处理了"。
3. **`exp` 的判据是 `<` 还是 `<=`。** 和你的其他服务对齐，别让两个服务对同一秒给出相反答案。本站现在是 `<`（`exp == now` 放行），`jsonwebtoken` 和 `jose` 都是"相等即过期"，这处不一致我还没改：它只影响 `exp` 恰好等于当前那一秒的 token，等下次动 `auth.js` 时一起处理。记在这里，比假装没看见好。

#jwt #auth #protocol
', 'teardown', 'exp 只是一条声明，失效与否取决于验签方有没有主动比那一次时间；本站的校验就漏了四格。',
        '认证边界', 1, 0, 0, 1, '2026-12-02 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('jwt') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'jwt-exp-verify' AND t.name = 'jwt';
INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'jwt-exp-verify' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('http') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'jwt-exp-verify' AND t.name = 'http';


INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('samesite-behavior', 'SameSite 的三种取值，到底谁在什么时候带上 cookie', '## 结论

SameSite 比的是 site，不是 origin。`a.example.com` 和 `b.example.com` 是两个 origin、一个 site，两者之间的请求**根本不进入 SameSite 的判断**。绝大多数「明明是同域却不发 cookie」的误判，都是把这两件事当成了同一件。

未声明 `SameSite` 的 cookie，Chrome 从 80（2020-02-04）起按 `Lax` 处理。但有一个例外：cookie 写入后 **2 分钟内**，跨站顶级 POST 也会带上。这个宽限只对「什么都没写」的 cookie 生效——显式写 `SameSite=Lax` 反而比不写更严，宽限直接消失。

`Lax` 的判定只有一条：**顶级导航 + 安全方法**。地址栏回车、点超链接、302 跳转、`<form method="get">` 都算；跨站 `POST` 表单不算；iframe、`img`、`script`、`fetch` 这类子资源请求一律不算。所以 Lax 放行的是「用户主动跳过来」，拦住的是「别人页面上的东西顺手拿你的身份」。

`Strict` 连第一条也不给。从搜索结果点进来的那一次导航不带 cookie，服务端渲染出未登录页面，刷新一次才登录——因为刷新是同站导航。这是 Strict 最典型的体验坑，不是 bug。

`None` 必须同时带 `Secure`，否则浏览器直接丢弃整条 cookie，连存都不存。跨站 iframe 嵌入、跨站带凭证 API 调用只有这一个选项，它也是第三方 cookie 收缩里最先被打掉的一类。

## 一、site 是 eTLD+1，origin 是三元组

`origin` 的定义是 `scheme + host + port`，三者任一不同就是不同 origin。`site` 的定义是 `scheme + eTLD+1`，其中 eTLD+1 指公共后缀再加一级，比如 `example.com`、`example.co.uk`。

两个概念差在哪：`origin` 精确到端口，`site` 只到可注册域名。`https://a.example.com:8443` 和 `https://b.example.com` 是两个 origin、一个 site。

| 组合 | 例子 | 同 site？ | 同 origin？ | 算跨站？ |
|---|---|---|---|---|
| 同 site 同 origin | `https://a.example.com/x` 与 `https://a.example.com/y` | 是 | 是 | 否 |
| 同 site 不同 origin（子域） | `https://a.example.com` 与 `https://b.example.com` | 是 | 否 | 否 |
| 同 site 不同 origin（端口） | `https://a.example.com` 与 `https://a.example.com:8443` | 是 | 否 | 否 |
| 同 host 不同 scheme | `http://a.example.com` 与 `https://a.example.com` | 否 | 否 | **是** |
| 不同 site | `https://a.example.com` 与 `https://a.example.org` | 否 | 否 | 是 |

第四行值得单独说：`http` 与 `https` 之间现在算跨站。浏览器把 scheme 也算进 site 的比较（schemeful same-site），所以从 `http://exia.de5.net` 跳到 `https://exia.de5.net`，Lax 的判断是「跨站顶级 GET 导航」——恰好放行，看起来像同站，其实走了跨站那条分支。哪天规则再收紧，这一条就是隐藏的断裂点。

第三行也反直觉：端口不同不影响 site。`localhost:3000` 和 `localhost:3001` 同 site，`fetch` 互调时 SameSite 不参与判断，但 CORS 会拦——这是两个独立的闸，别指望一个能替另一个。

判断一次请求落在哪一行，不用猜。浏览器会在请求上带 `Sec-Fetch-Site`，取值四个：`same-origin`、`same-site`、`cross-site`、`none`。地址栏输入是 `none`，点站内链接是 `same-origin`，`a.example.com` 跳到 `b.example.com` 是 `same-site`，跳到 `example.org` 是 `cross-site`。这个头的算法和 SameSite 用的是同一套 site 判定，所以在 Network 里看到它，就等于看到了浏览器的判断结果。它对不上你的预期时，错的一定是预期。

拿本站的具体域名举例。主站是 `exia.de5.net`，eTLD+1 是 `de5.net`。如果哪天加一台图床 `img.de5.net`：

- 从 `exia.de5.net` 请求 `img.de5.net` 的图片，**同站**，SameSite 完全不吭声。
- 但 `sid` 这条 cookie 是在 `exia.de5.net` 上写的，没有写 `Domain=`，浏览器按 **host-only** 存，只回给 `exia.de5.net` 这一个主机名。`img.de5.net` 一个字节都收不到。

第二种情况的锅不在 SameSite，在 `Domain` 属性缺失。我见过太多人这时候去改 SameSite，改成 `None; Secure` 依然不发，因为跨子域共享靠的是 `Domain=de5.net`，跟 SameSite 是两个维度。加 `Domain` 之后 cookie 会发给 `de5.net` 下所有子域，任何一台子域被接管，会话就一起没了——这才是要不要加的真实取舍。

## 二、默认值是 Lax，但规范和浏览器说的不是一回事

读 RFC 6265bis 会发现，`SameSite` 缺省时的规范默认值是 `None`。读 Chrome 的行为会发现，缺省时按 `Lax` 处理。两条都对，问的不是同一个对象：规范定义的是「属性缺失时如何解释」，浏览器加的是「没写就替你补一个 Lax」的策略层。

这个差别有实际后果。如果你的服务端依赖「不写就是 None」，那在所有现代浏览器上都是错的；如果你的服务端依赖「不写就是 Lax」，那在极老的客户端和非浏览器 HTTP 客户端上又不成立。

`Lax + POST` 的 2 分钟宽限是这段历史里最容易漏掉的一笔。它存在的原因很具体：很多 SSO 流程是「第三方站点 → POST 回你的站点」，如果不给窗口，Chrome 80 上线当天会打断一大批登录。于是 Chromium 留了一个口子——**创建时间在 2 分钟内的 cookie，跨站顶级 POST 也带上**。

关键在「创建时间」。不是请求时间，是 cookie 自己的年龄。用户在你的登录页停留超过 2 分钟再去第三方发起 POST，这条 cookie 就不带了。

还有一条更少人知道：这个宽限只对**没有写 SameSite 属性**的 cookie 生效。一旦你显式写了 `SameSite=Lax`，浏览器认为你已经表过态，宽限取消。所以「我写了 Lax，应该和默认一样吧」是错的——写出来比不写更严格，恰恰会把那 2 分钟弄丢。

| 请求形态 | 未声明（按 Lax + 宽限） | 显式 `Lax` | `Strict` | `None; Secure` |
|---|---|---|---|---|
| 同站任意请求 | 带 | 带 | 带 | 带 |
| 跨站顶级导航 GET | 带 | 带 | **不带** | 带 |
| 跨站顶级导航 POST | 2 分钟内带，之后不带 | **不带** | 不带 | 带 |
| 跨站 iframe / img / script / fetch | 不带 | 不带 | 不带 | 带 |

## 三、Lax 的边界画在「顶级导航 + 安全方法」

`Lax` 的规则可以压成一句话：这个请求是不是**用户主动把整个页面导航过去**，并且用的是**安全方法**。

安全方法指 `GET`、`HEAD`、`OPTIONS`、`TRACE`——定义上的意思是「不改变服务端状态」，`POST` 不在里面。

按这个规则过一遍常见场景：

- 地址栏输入网址、点书签、点别人页面上的 `<a href>`，都是顶级 GET 导航，带。
- 302 / 303 跳转链，只要发起方是顶级导航，链上每一跳仍按顶级导航算，带。OAuth 回调就活在这一条上。
- 跨站的 `<form method="post">` 自动提交，不带。这一条挡住了大量 CSRF。
- 页面里 `<iframe src>`、`<img src>`、`<script src>`、`fetch()`、`XHR`，全部不带，因为它们不是导航，是子资源。

第三条和第四条合起来，就是 Lax 的设计意图：拦住「别的站点偷偷用你的身份发请求」，放行「用户自己点过来」。代价是 GET 型的跨站请求仍然带 cookie，所以任何**用 GET 改状态**的接口在 Lax 下依然是敞开的。CSRF 防护不能只靠 SameSite，这条老结论没变。

302 那条要多说一句。判断「是不是顶级导航」看的是发起请求的上下文，不是看目标。第三方站点 302 到你的回调地址，浏览器把这次跳转当作导航的延续，`Sec-Fetch-Site` 会标成 `cross-site`，但导航类型仍是 `navigate`，Lax 放行。这也是为什么 Lax 能当 OAuth 的默认选项——换成 Strict 就死。

## 四、Strict：从搜索引擎点进来是未登录

`Strict` 在任何跨站请求上都不带 cookie，包括顶级导航。规则干净，体验有坑。

用户从搜索结果点进来，第一跳是 `cross-site` 的顶级导航，`Strict` 下浏览器不带 `sid`。服务端拿不到会话，按匿名叫渲染，页面右上角显示「登录」。页面加载完之后，页面里的同站子请求（头像接口、未读计数）会带上 cookie——因为那些是同站请求。用户看到的是一个自相矛盾的状态：内容区知道你的偏好，头部说你没登录。

刷新一次就对了，因为刷新是同站导航，cookie 带上，服务端重新渲染。这个「刷新才好」的形态太典型了，凡是听到这个描述，基本可以先怀疑 Strict。

那 Strict 还值不值得用。看 cookie 干什么：

- 会话 cookie 用 Strict，等于给所有外链入口加了一道「看起来没登录」的门。搜索结果、社交分享、邮件里的链接，全部中招。入口流量越大，损失越明显。
- 只对高风险动作生效的 cookie（比如二次验证的临时票据、CSRF token）用 Strict 是合理的，因为这些动作本来就发生在站内，用户不会从外站直接 POST 过来。
- 想要「外链进来也带、但只在站内导航才带」这种中间态，只能自己拼：一条 Lax 的会话 cookie 负责「认得出你」，一条 Strict 的标记 cookie 负责「确认这是一次站内发起的敏感操作」。

两条 cookie 的写法是这样的：

```js
// 会话用 Lax：外链点进来也能认出来
res.headers.append(''set-cookie'',
  `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
// 敏感动作的票据用 Strict：只有站内导航才带得过来
res.headers.append(''set-cookie'',
  `op=${nonce}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`);
```

删文章、改邮箱这类操作要求两条同时在。从外站直接点进来时，`sid` 在、`op` 不在，服务端能识别出「这是一次外来入口」，于是先跳一次站内页把 `op` 补上，再放行——用户多看到一次跳转，但不会在「看起来未登录」的状态里操作。这套东西的成本不在代码，在每一次新增敏感接口时都要记得同时校验两条，漏一次就等于没做。

本站没上这套，因为删改动作全部走 `/api/*` 的 `POST` + 同源校验，Strict 那层没有额外的收益。

## 五、None 必须配 Secure，否则整条被丢

`SameSite=None` 的意思是「跨站也发」。这个能力太强，规范给它绑了一个前置条件：必须同时有 `Secure`，也就是只能走 HTTPS。

不满足会怎样：**整条 cookie 不被存储**。不是「存了但不发」，是浏览器在解析 `Set-Cookie` 那一步就拒绝了。表现是 DevTools 的 Application 面板里根本找不到这条 cookie，Network 里那条响应带 `Set-Cookie`，但下一跳请求的 `Cookie` 头是空的。

Chrome 会在这条响应上给一条警告，大意是「这条 Set-Cookie 被拦了，因为它带了 SameSite=None 却没有 Secure，而 SameSite=None 要求 Secure」。看到这句话，不用怀疑别的，先把 `Secure` 补上。

三种写法的完整形态：

```http
# 站内会话，默认值即可。不要写 Domain，host-only 更安全
Set-Cookie: sid=eyJ1aWQiOjEyfQ; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000

# 需要跨站嵌入时：None 和 Secure 必须成对，缺一个整条失效
Set-Cookie: sid=eyJ1aWQiOjEyfQ; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000

# 想跨子域共享：加 Domain。加完 de5.net 下所有子域都会收到
Set-Cookie: sid=eyJ1aWQiOjEyfQ; Domain=de5.net; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
```

`None` 的生存空间在收窄。Safari 和 Firefox 默认就拦第三方 cookie，Chrome 的限制分阶段推进、后来改成以用户选择为主，各家节奏不一致，具体以官方公告为准。能确定的是方向：`SameSite=None` 这一类的第三方 cookie 是第一批被处理的，因为它同时具备「跨站可见」和「长期存在」两个特征，是追踪链路最依赖的形态。

真要跨站嵌入又有正当理由，现在的做法是 CHIPS：`SameSite=None; Secure; Partitioned`，cookie 按顶层站点分区，每个嵌入方拿到的是独立的一份，跨站追踪就断了。代价是被嵌入方换一个宿主站就换一份状态，适合「嵌在别人页面里的客服窗口」，不适合「全站单点登录」。

## 六、SameSite 挡不住的那一半

把 Lax 当成 CSRF 的完整答案，会漏掉三块。

**第一块：GET 型的写操作。** Lax 只按方法分类，不看接口语义。`<a href="https://exia.de5.net/post/3/delete">点我看猫</a>` 是一次跨站顶级 GET 导航，带 cookie，服务端如果真在这条路由上删了东西，SameSite 一点没帮上忙。同理 `/logout?next=...` 这类用 GET 实现的登出，任何第三方页面都能把你踢下线——危害不大，但说明「改状态必须 POST」不是代码风格，是安全前提。

**第二块：2 分钟的宽限。** 用户刚在第三方站点完成一次授权，2 分钟内那张跨站 POST 表单会带着你刚写的 cookie 一起提交。这个窗口原本是为了不打断 SSO，代价是跨站 POST 在最关键的 2 分钟里是通的。显式写 `SameSite=Lax` 能关掉它，这也是第二节说「写出来比不写更严」的实际意义——如果你的站点是 Strict 派，把 Lax 写死反而能消掉这个窗口。

**第三块：子域能往主域种 cookie。** `img.de5.net` 返回一条 `Set-Cookie: sid=xxx; Domain=de5.net; Path=/`，浏览器会接受——`de5.net` 是该 host 的后缀，合法。于是 `sid` 这个名字在 `exia.de5.net` 上出现了两条作用域不同的 cookie，之后每个请求都会把两条一起放进 `Cookie` 头。

哪条生效取决于顺序。浏览器按 `Path` 长度降序排，同长度按创建时间升序；`src/utils.js` 的 `parseCookies` 是逐段赋值、后出现的覆盖前面的，所以最终取到的是排在最后那条。`Path=/` 已经是最短的一档，长度上分不出胜负，剩下的变量就是创建时间——**后写入的那条排在后面，也就是胜出的那条**。注入方只要让自己的写入发生在主站之后，就能赢；它不需要抢第一次，等会话刷新时再种一次就行。这套手法叫 cookie tossing：攻击者不需要攻破主站，只需要控制任意一个子域，或者一个已经废弃、CNAME 还指着的子域。SameSite 在这件事上完全不发音，因为 `img.de5.net` 和 `exia.de5.net` 是同站，跨站判断根本没启动。

第三块的解法是 `__Host-` 前缀：

```http
# 前缀强制三件事：必须 Secure、必须 Path=/、必须不带 Domain
Set-Cookie: __Host-sid=eyJ1aWQiOjEyfQ; Path=/; Secure; HttpOnly; SameSite=Lax
```

浏览器在看到 `__Host-` 前缀时会校验这三条，缺一条就拒绝存储，带 `Domain=` 直接拒。于是 `img.de5.net` 没办法把 `__Host-sid` 种到 `exia.de5.net` 上：带 `Domain=de5.net` 会被浏览器打回，不带 `Domain` 只能种给它自己那个主机名，主站收不到。代价是这条 cookie 永远只属于一个主机名，跨子域共享和它互斥。本站目前没用这个前缀，`sid` 还是裸名，能改但会影响已经发出去的 30 天会话（改了等于所有人重新登录一次），所以先记着。

这三块合起来说明一件事：SameSite 是纵深防御里的一层，不是边界本身。它能挡住「浏览器替你自动附上身份」的大部分场景，挡不住「接口自己用 GET 改状态」和「同站内的越权写入」。

## 七、和 CORS 是两套闸，报错各不相同

SameSite 决定**请求发出去时带不带 cookie**，CORS 决定**响应回来之后 JS 能不能读**。两件事发生在不同时刻，报错也完全不同。混在一起排查，最常见的结局是改了一边、另一边还在拦。

带凭证的跨站 `fetch` 要同时满足三个条件：

```js
// 前端：默认值是 same-origin，跨站必须显式写 include
const res = await fetch(''https://api.de5.net/whoami'', {
  method: ''GET'',
  credentials: ''include'',           // 少了这一行，请求照发，cookie 不带
  headers: { accept: ''application/json'' },
});
console.log(await res.json());      // 服务端回显这次实际收到的 cookie 名
```

```http
# 服务端：Origin 必须回具体值，不能是 *
Access-Control-Allow-Origin: https://exia.de5.net
Access-Control-Allow-Credentials: true
Vary: Origin
```

第三个条件藏在细节里：`Allow-Origin` 不能是 `*`。星号的含义是「任何源都能读」，而带凭证的响应一旦允许任何源读，等于把会话数据广播出去，所以规范直接禁止这个组合。

预检这一段还有个容易忽略的分工。只有当请求「不是简单请求」时才会先发 `OPTIONS`——带 `content-type: application/json` 就属于不是，因为 JSON 不在允许的三个类型里（只有 `application/x-www-form-urlencoded`、`multipart/form-data`、`text/plain`）。预检本身不带 cookie，所以它检验的是「服务端允不允许这个源发这种请求」，凭证校验发生在紧随其后的第二次请求上。

这带来一个缓存陷阱：如果响应里没有 `Vary: Origin`，CDN 会把「给 A 站看的 `Allow-Origin: https://a.example.com`」缓存下来，回给 B 站。表现是 CORS 时好时坏，刷新几次又能过。本站有边缘缓存，这条不是假设——凡是按 `Origin` 变头的响应，`Vary` 必须写全，否则缓存层会把一个访客的答案发给所有人。

| 缺哪个条件 | 请求带 cookie 了吗 | 现象 / 报错 |
|---|---|---|
| 前端没写 `credentials: ''include''` | 没带 | 请求 200，响应正常，但 `Set-Cookie` 被忽略，JS 无任何报错 |
| `Allow-Origin` 写成 `*` | 带了 | 响应被拦，控制台报 `Allow-Origin` 在 `include` 模式下不能是通配符 |
| 有 `Allow-Origin`，缺 `Allow-Credentials: true` | 带了 | 响应被拦，控制台说凭证模式是 `include`，但该响应头为空 |
| 服务端全对，但 cookie 是 `SameSite=Lax` | **没带** | CORS 全绿、状态 200、服务端认为你没登录 |

最后一行是这一节的重点。前三行的失败都在控制台里有字，第四行**没有任何报错**：CORS 检查的是「这个源能不能读这个响应」，而这条响应本身是合法的、可读的，只是里面的业务逻辑说「未登录」。于是现象变成「接口 200，返回 `{"user":null}`」，往前端和往后端互相甩锅。

反过来还有一个更阴的版本：cookie 没带上，CORS 反而更容易通过。因为不带凭证的请求只校验 `Allow-Origin`，`*` 也合法。所以「我把 `Allow-Origin` 改成 `*` 之后不报错了」不是修好了，是把凭证彻底关了——请求能通，身份没了。

排查顺序建议倒过来：先在 Network 的请求头里确认 `Cookie` 到底有没有出现，再看响应头。`Cookie` 空着就往下查 SameSite 和 `Domain`，`Cookie` 有值但 JS 读不到才轮到 CORS。方向反了会白改半天。

## 八、本站真实用的是哪一档

`src/utils.js` 里那个 `setCookie` 把属性写死了：

```js
export function setCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, ''Path=/'', ''HttpOnly'', ''SameSite=Lax''];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure !== false) parts.push(''Secure'');
  return parts.join(''; '');
}
```

`SameSite=Lax` 是硬编码的，`Secure` 默认开。`src/auth.js` 第 237 行用它写会话：

```js
headers.append(''set-cookie'', setCookie(COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }));
```

`COOKIE` 是 `sid`，有效期 30 天，`Path=/`，`HttpOnly`，`Secure`，`SameSite=Lax`，**没有 `Domain`**。最后这一点意味着它是 host-only 的，只回给 `exia.de5.net`，任何子域都拿不到。

选 Lax 的理由不是「默认值省事」，是 OAuth 回调走不通 Strict。登录流程是这样的：`/login` 写一条 `oauth_state`，302 到 GitHub；用户在 GitHub 授权完，GitHub 302 回 `https://exia.de5.net/auth/callback?code=...&state=...`。这一跳是**跨站的顶级 GET 导航**。

- Lax：带上 `oauth_state`，`state` 对得上，换 token，写 `sid`。
- Strict：不带 `oauth_state`，`state` 为空，校验失败，用户 100% 看到「登录状态已失效」。

这是 Strict 在本站唯一但致命的坏处。同一段逻辑在 `src/auth.js` 的 131、132 行写了两条 cookie，`oauth_state` 和 `oauth_next`，都是 `SameSite=Lax; Max-Age=600; Secure`，600 秒跟 code 的寿命对齐。回调成功后 238、239 行立刻把它们置空。

顺带说一条跟 SameSite 无关、但同一个坑位的东西：`src/cache.js` 的 `edgePut` 在写入缓存副本前有一行

```js
headers.delete(''set-cookie'');
```

这行必须有。边缘缓存是给所有匿名访客复用的，如果某个响应带着 `Set-Cookie: sid=...` 被存进去，下一个访客就会收到别人的会话。SameSite 管的是「这条 cookie 该发给谁」，缓存管的是「这条响应该给谁看」，两个边界都得守。

评论区的 `cmt_did` 也是同一条路：`src/api.js` 第 807 行用 `setCookie` 写设备 id，同样落成 `SameSite=Lax`。现在没有任何跨站嵌入场景，这样写没问题。如果哪天把评论区做成可嵌入的 iframe 给别人的站用，`cmt_did` 在 Lax 下永远不会发出去，防重复评论会直接失效——那时候要改成 `None; Secure; Partitioned`，同时接受「每个宿主站一份独立 id」的后果。

## 九、几个容易判错的边界

**IP 地址没有 eTLD+1。** 访问 `http://1.2.3.4` 时，site 就是这个 IP 本身（不含端口）。所以 `1.2.3.4:8080` 与 `1.2.3.4:80` 同 site，`1.2.3.4` 与 `5.6.7.8` 跨站。用 IP 做本地联调时，SameSite 的判断和用域名完全不是一回事。

**公共后缀列表决定 eTLD+1，不是「最后两段」。** `a.github.io` 与 `b.github.io` 看起来同域，实际上 `github.io` 在公共后缀列表里，两者的 eTLD+1 分别是 `a.github.io` 和 `b.github.io`，属于**不同 site**。同理 `example.co.uk` 的 eTLD+1 是 `example.co.uk`，不是 `co.uk`。这条决定了「把测试环境放在别人的二级域下」时，cookie 一定不共享。

**`localhost` 与 `127.0.0.1` 是两个 site。** 两个都没有可注册域名，各按自身 host 算。想在本机做跨站实验，这是最省事的一对：`localhost:3000` 与 `127.0.0.1:3001` 天然跨站，不用改 hosts。

**同站不同端口不触发 SameSite。** `localhost:3000` 与 `localhost:3001` 同 site（端口不属于 site 的组成部分），但 CORS 会拦——`origin` 含端口。这个组合刚好把两套闸拆开看：SameSite 沉默，CORS 报错。

**`Path` 不是安全边界。** `Path=/admin` 只约束「浏览器往哪些路径发」，不阻止同源的其他路径通过 `document.cookie` 读到它（`HttpOnly` 才阻止）。把它当权限用，等于没设防。

## 十、一条清单

下次遇到「cookie 该带没带」，按这个顺序排：

1. 先确认是不是跨站。比 eTLD+1，不要比 host。同站不同子域的问题跟 SameSite 无关，去查 `Domain` 属性和 host-only。
2. 看那条 cookie 的 `SameSite` 到底是 `Lax`、`Strict`、`None` 还是真·没写。没写和写了 Lax 在 2 分钟宽限上行为不同。
3. 判断请求形态：顶级导航还是子资源，GET 还是 POST。Lax 只认「顶级导航 + 安全方法」。
4. `None` 的必须回头看有没有 `Secure`。没有就是整条不存在，不是不发。
5. 最后才看 CORS。`Cookie` 头空着的时候，CORS 配得再对也没用。

## 怎么自己验一遍

先说清楚工具的能力边界：`curl` 能看服务端发了什么，看不到浏览器会怎么筛。`curl` 不是浏览器，没有 SameSite 策略，你给它 `-b` 它就发，不管是不是跨站。

第一步，看服务端到底写了哪些属性：

```bash
# 只看响应头。登录入口会 302 到 GitHub，所以跟一次跳转没必要，看第一跳就够了
curl -sI https://exia.de5.net/login | grep -i ''^set-cookie''
```

按 `src/auth.js` 第 131、132 行的写法，这两条响应头应该是这样（值截断了）：

```text
set-cookie: oauth_state=3f2a...; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure
set-cookie: oauth_next=%2Fp%2Fsamesite-behavior; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure
```

两条都在，属性齐全。这一步能确认的只有「服务端没写错」，跨站会不会被拦，要到浏览器里看。

再发一次，把来源伪装成外站：

```bash
# 带上外站的 Origin 和 Referer，响应和上面一模一样
curl -sI https://exia.de5.net/login \
  -H ''Origin: https://example.org'' \
  -H ''Referer: https://example.org/post'' | grep -i ''^set-cookie''
```

```text
set-cookie: oauth_state=3f2a...; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure
```

同一条 `Set-Cookie`，一个字都没变。服务端不看 `Origin`，只负责把属性写出来；存不存、什么时候带，由浏览器收到响应之后自己算。所以在 `curl` 里永远复现不出「跨站 cookie 不发送」——这也是为什么这类问题必须开浏览器。`curl -b ''sid=abc''` 手动塞进去的 cookie，它一样照发，不管你把 `Referer` 写成什么。

第二步，在真实浏览器里看存储。打开 DevTools → Application → 左侧 Storage → Cookies → 选中 `https://exia.de5.net`。表格里有一列 `SameSite`，值只会是 `Lax`、`Strict`、`None` 或空白。空白表示这条 cookie 在落盘时没有该属性，浏览器会按 Lax 解释——但别指望它替你补上，服务端该写的还是要写。

同一张表里再看三列：`Domain` 为空表示 host-only（只发主站），`HttpOnly` 打勾表示 JS 读不到，`Secure` 打勾表示只走 HTTPS。这三列加 `SameSite` 一列，cookie 的发送条件就全了。

第三步，看请求实际带了什么。Network → 选一条请求 → Headers → Request Headers 里的 `Cookie`。有值就是带了，没这一行就是没带。想看被 SameSite 挡掉的那几条，在 Network 的请求详情里切到 Cookies 子面板，被拦的会单独标出来；Application → Cookies 面板上有个 `Show filtered out request cookies` 的开关，打开后能看到「存在但没发」的 cookie，这一栏最有用——它把「没有这条 cookie」和「有这条但被拦了」分开了，而这两种情况的修法完全不同。

要在控制台里一次打印「到底带了哪几条」，得让服务端回显，因为 `HttpOnly` 的那条 JS 永远读不到：

```js
// 页面控制台里跑：对比「服务端收到什么」和「JS 看得见什么」
const probe = async (url) => {
  const r = await fetch(url, { credentials: ''include'' });   // 跨站时 include 才有意义
  const j = await r.json();                                  // 服务端回显 cookie 名数组
  const js = document.cookie.split('';'')
    .map((s) => s.trim().split(''='')[0]).filter(Boolean);
  console.log(url);
  console.log(''  服务端收到:'', j.names, `共 ${j.count} 条`);
  console.log(''  JS 可见  :'', js);
};

await probe(''/api/whoami'');                       // 同站：两条都应该在
await probe(''https://api.example.net/whoami'');    // 不同 site：Lax 那条不该出现
```

服务端那一侧只要能回显 `request.headers.get(''cookie'')` 里出现的名字就够了，不需要解析值：

```js
// Worker 侧：把这次请求实际收到的 cookie 名回显出来
export default {
  async fetch(req) {
    const raw = req.headers.get(''cookie'') || '''';
    const names = raw.split('';'').map((s) => s.trim().split(''='')[0]).filter(Boolean);
    const origin = req.headers.get(''origin'') || '''';
    return new Response(JSON.stringify({ names, count: names.length }), {
      headers: {
        ''content-type'': ''application/json'',
        // 带凭证时只能回具体 Origin，* 会被浏览器拒掉，所以把请求里的 Origin 原样回写
        ''access-control-allow-origin'': origin,
        ''access-control-allow-credentials'': ''true'',
        vary: ''Origin'',
      },
    });
  },
};
```

两行输出的差值就是 `HttpOnly` 的条目；两个 URL 的差值就是 SameSite 拦掉的部分。同站那次如果 `服务端收到` 是空的，问题一定不在 SameSite，去查 `Path` 和 `Domain`——这两条在 set 的时候就决定了 cookie 会不会被送到这个路径和这个主机。

第四步，做一次对照。本机起两个服务：`http://localhost:3000` 写 cookie 并渲染一个页面，页面里 `fetch(''http://127.0.0.1:3001/echo'', { credentials: ''include'' })`；`127.0.0.1:3001` 把收到的 `Cookie` 头原样回显。按 site 的定义，`localhost` 与 `127.0.0.1` 是两个 site，这次请求算跨站，Lax 下 cookie 不会出现，回显是空的。把目标换成 `http://localhost:3001/echo`，同 site 不同 origin，cookie 会出现——如果两边都监听在同一台机器上、代码完全一样，唯一的变量就是 host。

这一步我只在纸面上推过，没在三个独立注册域名上跑过完整对照。按规范和浏览器实现应当如此，结论到推断为止；要拿真数，得有两个真实域名和一份证书，本机这对只能验机制、验不了「公共后缀列表」那一层。

SameSite 的坑几乎都不在三种取值本身，在它前面那一步：**这条请求到底算不算跨站**。这一步判错，后面三种取值推得再细都是白推。
', 'teardown', 'SameSite 比的是 site 不是 origin；Lax 只在顶级导航 + 安全方法时带 cookie。',
        '认证边界', 2, 0, 0, 1, '2026-12-09 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('http') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'samesite-behavior' AND t.name = 'http';
INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'samesite-behavior' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('javascript') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'samesite-behavior' AND t.name = 'javascript';


INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('cors-preflight-cost', 'CORS 预检不是每个请求都发：OPTIONS 的真实成本', '## 结论

预检（`OPTIONS`）不是每次请求都发。它有缓存，而且是浏览器自己维护的一张表。

实测同一页面、同一个跨域 `PUT`、连发 3 次，服务端数到的 `OPTIONS` 次数：

| 响应头 | 请求间隔 | PUT 次数 | 实际 OPTIONS 次数 |
|---|---|---|---|
| `Access-Control-Max-Age: 600` | 7 秒 | 3 | **1** |
| 不带 Max-Age | 7 秒 | 3 | **3** |
| 不带 Max-Age | 4.2 秒 | 3 | **2** |
| 不带 Max-Age | 连发（间隔≈0） | 3 | **1** |

三件事：

**第一，加了 `Access-Control-Max-Age` 之后，7 秒间隔的三次请求只花了一次预检。** 也就是说「每个跨域 API 请求都要多一次往返」这个说法是错的，只在**第一次**成立。

**第二，不加 Max-Age 也不是每次都发。** 连发时三次只算一次，因为浏览器对没有 Max-Age 的预检响应有一个默认缓存窗口。4.2 秒间隔时第 2 次没预检、第 3 次预检了，说明这个窗口在 4.2 秒到 7 秒之间——和 Chrome 源码里的 5 秒默认值对得上。

**第三，真正决定成本的是「同一个 URL、同一个方法、同一个 origin」会被复用，换个 URL 就要重来。** 如果你把 20 个接口拆成 20 个路径，每个路径第一次请求都各付一次预检；如果它们在同一个路径上靠参数区分，就只付一次。

下面是完整的测法和三个容易踩的点。

## 一、先搞清楚什么会触发预检

不是所有跨域请求都有预检。满足下面全部条件时，浏览器直接发「简单请求」，不预检：

| 条件 | 允许的值 |
|---|---|
| 方法 | `GET` / `HEAD` / `POST` |
| 手动设置的请求头 | 只能是 CORS 安全列表内的（`Accept`、`Accept-Language`、`Content-Language`、`Content-Type` 等） |
| `Content-Type` | 只能是 `text/plain`、`multipart/form-data`、`application/x-www-form-urlencoded` |
| 没有 `ReadableStream` 请求体 | — |

只要有一个不满足，浏览器就先发一个 `OPTIONS` 问服务器「我能不能发这个」。我这次测试故意用了 `PUT` + 自定义头 `x-bench`，两个条件同时不满足，保证每次都会走预检流程。

所以「我的 API 有预检吗」这个问题的答案，先看你的请求长什么样：

```js
// 不触发预检 —— POST + JSON 是不行的，因为 application/json 不在允许列表里
await fetch(''https://api.example.com/comments'', {
  method: ''POST'',
  headers: { ''content-type'': ''application/json'' },   // ← 这一行就触发预检
  body: JSON.stringify({ text: ''hi'' }),
});

// 不触发预检
await fetch(''https://api.example.com/comments'', {
  method: ''POST'',
  headers: { ''content-type'': ''application/x-www-form-urlencoded'' },
  body: ''text=hi'',
});

// 触发预检
await fetch(''https://api.example.com/comments'', {
  method: ''DELETE'',                                   // ← 方法不在列表
  headers: { ''authorization'': ''Bearer xxx'' },         // ← 头不在列表
});
```

绝大多数现代 API 都是 `application/json` + `Authorization`，所以**默认就在付预检的钱**。这一点没法避免，能优化的只有「付几次」。

## 二、测量：服务端数 OPTIONS，浏览器跑真实间隔

浏览器侧看不到预检缓存，DevTools 的 Network 面板会把预检折叠成一条，而且不会告诉你「这次是缓存命中还是真发了」。唯一可靠的办法是**在服务端数**。

服务端加一个计数端点：

```js
// 每次 OPTIONS 往 D1 记一行，测完删表
if (req.method === ''OPTIONS'') {
  await env.DB.prepare(''INSERT INTO _bench_cors (kind) VALUES (?)'').bind(path).run();
  return new Response(null, {
    status: 204,
    headers: {
      ''access-control-allow-origin'': ''*'',
      ''access-control-allow-methods'': ''GET, PUT, POST, DELETE, OPTIONS'',
      ''access-control-allow-headers'': ''content-type, x-bench'',
      // 对照组：这一行加不加，就是全部差别
      ''access-control-max-age'': ''600'',
    },
  });
}
```

页面侧从**另一个 origin** 加载（我用 `http://127.0.0.1:8788` 起静态页，请求打到 Worker 的 `workers.dev` 域名），连发 3 次，然后把服务端计数读回来：

```js
// 间隔可配：gap = 0 / 4200 / 7000
for (let i = 0; i < 3; i++) {
  if (i && gap) await new Promise((r) => setTimeout(r, gap));
  await fetch(BASE + ''/cors/'' + kind, {
    method: ''PUT'',
    headers: { ''content-type'': ''application/json'', ''x-bench'': ''1'' },
    body: JSON.stringify({ i }),
  });
}
```

这里有个测量方法上的坑，值得单独说：**不能用 `--virtual-time-budget` 让无头浏览器「快进」时间。** 虚拟时间会把 `setTimeout(7000)` 瞬间执行完，而浏览器的预检缓存按真实时间算，结果就是「间隔 7 秒」测出来还是缓存命中，得出完全错误的结论。我第一次就是这么测的，三组数据全是 1 次。

必须让页面真等。要么不加虚拟时间、让进程真跑 20 秒，要么像我现在这样：页面把结果 `POST` 回服务端一张表，本地脚本隔 25 秒去读——这样不受无头浏览器 dump 时机的影响。

## 三、三个数据点怎么解释

把四次测量放一起看：

| 场景 | 时间轴（第 n 次请求的时刻） | 预检发生在 | 次数 |
|---|---|---|---|
| 带 `Max-Age: 600`，间隔 7s | 0 / 7 / 14 | 第 1 次 | 1 |
| 无 Max-Age，间隔 7s | 0 / 7 / 14 | 三次全发 | 3 |
| 无 Max-Age，间隔 4.2s | 0 / 4.2 / 8.4 | 第 1 次、第 3 次 | 2 |
| 无 Max-Age，连发 | 0 / ~0 / ~0 | 第 1 次 | 1 |

第三行是信息量最大的：**4.2 秒时第 2 次没预检，8.4 秒时第 3 次预检了。** 缓存窗口在 (4.2, 8.4) 区间内失效。结合第一行（Max-Age 显式给 600，7 秒后仍然命中），可以确定：

- 有 `Max-Age` 时，缓存时长由它决定（但浏览器有上限，见下一节）
- 没有 `Max-Age` 时，浏览器给一个自己的默认值，Chrome 这个值约 5 秒

注意「约 5 秒」是实测推出来的区间，不是文档写的。CORS 规范没有规定无 Max-Age 时该缓存多久，这是实现细节。Firefox 和 Safari 的默认值不一样，所以**不要依赖这个默认值做任何设计**——想要确定性，就显式写 `Max-Age`。

## 四、上线时容易踩的三件事

**一、浏览器会砍 `Max-Age` 的值。** 你写 `86400`（一天），Chrome 会按自己的上限截断（当前是 2 小时，7200 秒）。写太大没用，写 600 到 3600 是合理区间。给一个表：

| 取值 | 效果 |
|---|---|
| 不写 | 浏览器默认窗口（Chrome 约 5s），不可控 |
| `600` | 10 分钟内同 URL 同方法复用，绝大多数场景够用 |
| `7200` | Chrome 的上限，再大写也等于 7200 |
| `-1` | 禁用缓存，每次都预检（调试时用） |

**二、预检请求不带 cookie。** 这是个常被误解的点：即使你 `fetch` 时写了 `credentials: ''include''`，浏览器发出的那个 `OPTIONS` **不会**携带 cookie 和 `Authorization`。所以：

- 预检的响应**不能**依赖登录态来生成。如果你的 `OPTIONS` 处理器要查 session 才决定允许哪个 origin，它永远查不到。
- 需要凭证的接口，`Access-Control-Allow-Origin` 不能是 `*`，必须是具体 origin，同时要 `Access-Control-Allow-Credentials: true`。

**三、CDN 缓存 OPTIONS 会串味。** 如果 `Access-Control-Allow-Origin` 是按请求的 `Origin` 动态返回的（多域名白名单的常见写法），而你又让 CDN 缓存了 `OPTIONS` 响应，就会出现「A 站拿到的响应里写着 B 站的 origin」。修法是加 `Vary: Origin`，或者干脆别缓存 `OPTIONS`（它本来就该被浏览器缓存，不需要 CDN 再存一层）。

```js
// 多域名白名单的正确写法：按 Origin 回显 + Vary
const allow = [''https://a.example.com'', ''https://b.example.com''];
const origin = req.headers.get(''origin'');
const headers = {
  ''access-control-allow-origin'': allow.includes(origin) ? origin : allow[0],
  ''access-control-allow-methods'': ''GET, POST, PUT, DELETE, OPTIONS'',
  ''access-control-allow-headers'': ''content-type, authorization'',
  ''access-control-max-age'': ''600'',
  ''vary'': ''Origin'',
};
```

## 五、这条数据改变了什么

之前我以为「跨域 API 每个请求都多一次 RTT」，所以一直在纠结要不要把所有接口合并成一个 `/api` 端点。测完发现这个前提是错的：

| 假设 | 实际 | 影响 |
|---|---|---|
| 每个跨域请求都多一次 OPTIONS | 只有第一次（或无 Max-Age 时每 5 秒一次） | 接口拆分不必为了省预检而合并 |
| Max-Age 写大点更好 | Chrome 上限 7200，写 86400 等于 7200 | 写 600~3600 就够 |
| 预检会带上 cookie，可以按登录态放行 | 预检永远不带凭证 | 权限判断必须在正式请求里做，不能在预检里做 |

真正该做的是：**给所有跨域接口的预检响应加上 `Access-Control-Max-Age: 600`。** 这一行加不加，决定了连续操作时是多花一次往返还是省下它。按 44ms 一次往返算（见 D1/KV/R2 那篇的实测），一个页面上 5 个接口调用，省下来的是 176ms。

## 六、怎么自己验一遍

1. 服务端起两个端点：`/cors/with-maxage`（带 `Access-Control-Max-Age: 600`）和 `/cors/without`（不带），**两者都在 `OPTIONS` 里往一张表记行**。
2. 本地起一个静态页（`python -m http.server 8788`），页面从 `127.0.0.1` 加载，请求打到你的远端域名——这样 origin 不同，跨域成立。
3. 页面连发 3 次带自定义头的 `PUT`，间隔用真实时间（`setTimeout`），**不要开虚拟时间**。
4. 读服务端那张表的 `COUNT(*)`。预期：带 Max-Age 的是 1，不带的是 3。
5. 把间隔改成 4.2 秒再跑一次不带 Max-Age 的，应该得到 2——这是确认「默认窗口存在」的关键一步。

这套脚本我留在 `bench/page.html` 和 `bench/index.js` 的 `/cors/*` 分支里，跑完记得删表删 Worker。
', 'teardown', '加了 Access-Control-Max-Age 之后，7 秒间隔的三次跨域请求只花了一次预检。',
        '认证边界', 3, 0, 0, 1, '2026-12-16 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('http') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'cors-preflight-cost' AND t.name = 'http';
INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'cors-preflight-cost' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('javascript') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'cors-preflight-cost' AND t.name = 'javascript';


INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('turnstile-what-it-blocks', 'Turnstile 拦住了什么，没拦住什么', '## 结论

Turnstile 测的不是「你是不是机器人」，是**这次请求有没有留下「人类参与过」的证据**：浏览器环境完整不完整、事件轨迹像不像手、执行时序对不对、TLS 指纹和 IP 声誉站在哪一边。它输出一个概率判断，不是一个身份判定。所以「过了 Turnstile」的准确含义是：这一次提交背后，大概率有一个真实浏览器，且在最近五分钟内跑过它的 JS。

token 有三条硬约束，把最省事的那条路堵在第一层：有效期 300 秒、只能兑换一次、绑定 `sitekey` 与域名。把一枚 token 存下来复用，第二次 `siteverify` 回的是 `timeout-or-duplicate`，不是 `success`。很多人以为「缓存一个 token 就能反复用」，这条在协议层面就不成立。

但单次不等于稀缺。在真实浏览器里跑 Playwright，无感模式往往直接就发 token——自动化工具不需要骗过检测，因为它压根没被提问。这不是 Turnstile 的漏洞，是「无感」这个产品决策的必然结果：不打断用户，就只能靠旁证推断，而旁证在完整浏览器里是齐的。

它能拦住的是「没有浏览器」的那一类：`curl`、`fetch` 脚本、改了 UA 的爬虫、重放旧 token、把 `sitekey` 抄到别的域名上。拦不住的是「有浏览器但没人」和「有人但在滥用」。

本站的现状是接好了、没开。`TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET` 都没配，`turnstileMode()` 返回 `off`，`siteverify` 一次都不执行。线上 CSP 里没有 `challenges.cloudflare.com`，页面上 `__SITE__.turnstile` 的值是空串。理由在第八节，不是忘了。

放回三层结构看更清楚：它只是第二层。过得了它，只证明「有一次人类浏览器的参与」，不证明「这条评论该入库」——限流和内容判断必须独立存在，因为它们回答的是另外两个问题。

## 一、它收集的不是答案，是旁证

传统验证码是「出题—作答」，答案对错是硬信号。Turnstile 的无感模式没有题目，所以它拿到的只能是旁证：请求这个页面的浏览器，是不是一个「正常」的浏览器；从这个浏览器到这次提交之间，发生过什么。

旁证大致分五类。环境类的看 `window`、`document`、Canvas、WebGL、`navigator` 上那一串属性齐不齐；行为类的看鼠标和触摸事件有没有轨迹、有没有停顿、有没有抖动；时序类的看从加载到提交隔了多久、期间触发了多少次 `requestAnimationFrame`；网络类的看 TLS 指纹（JA3/JA4）和 HTTP 头顺序；来源类的看 IP 与 ASN，家宽、移动网、机房在这条轴上差得很远。

| 检测维度 | 正常桌面 Chrome | Playwright / Puppeteer 默认 | `curl` |
|---|---|---|---|
| JS 与 DOM | 完整 | 完整（真内核） | 无 |
| `navigator.webdriver` | `false` | `true`（`--disable-blink-features=AutomationControlled` 可改） | 无 |
| UA 里的无头标记 | 无 | 旧版带 `HeadlessChrome`，Chrome 112 起默认不带 | 随便写 |
| `navigator.plugins.length` | 5（都是内置 PDF 相关） | 常见 0 | 无 |
| WebGL renderer | 真实 GPU 型号 | 常见 `SwiftShader` / 软件栈 | 无 |
| 鼠标轨迹 | 数百条 `mousemove`，带抖动与停顿 | `page.click()` 只有落点附近一两条 | 无 |
| 加载到提交的时序 | 秒级，间隔不均匀 | 毫秒级，间隔近乎固定 | 无 |
| TLS 指纹（JA3/JA4） | Chrome 自己的 | 用浏览器内核时相同；用 Node 直连时不同 | curl/OpenSSL，明显不同 |
| IP / ASN | 家宽、移动网 | 常是机房 | 机房 |

表里右两列是公开可自查的差异，我这台机器上能直接跑出来。Turnstile 具体读哪几项、权重怎么给，没有公开文档，所以上面这张表是按「如果我要写一个这样的评分器，我会看什么」推的，属于推断，不是逆出来的清单。这条得说在前面，不然它看起来像一份说明书。

清单里最不稳的一项是 UA。Chrome 112 之后，新版 headless 的默认 UA 已经不带 `HeadlessChrome` 了，靠 UA 判无头的年代基本过去。真正难伪装的是事件轨迹和时序——不是造不出来，是要造得像，成本比加一个启动参数高一个量级。

判定发生在边缘，不在页面里。浏览器里那几百行 JS 只负责收集和上报，签发 token 的是 Cloudflare 那一侧，所以本地改几个 `navigator` 属性、把 `window.turnstile` 改成自己的假对象，都换不来一枚能过 `siteverify` 的字符串——它得由持有私钥的一方签。这一点决定了这层的下限：**伪造 token 的难度等于伪造签名，而不是等于读懂前端代码。** 真正松的地方不在密码学，在「谁有资格去领一枚」。

还有一个经常被混淆的东西：`cf_clearance`。它是 WAF 的 Managed Challenge 发的 cookie，跟 Turnstile 的 token 不是一回事。站点只接 Turnstile 的时候，浏览器里不会出现 `cf_clearance`；看到它，说明这道请求前面还有一层 WAF 在拦。这两层在文章里常被写成一件事，排查时会往错误的方向找。

## 二、token 的三条约束：单次、300 秒、绑站点

前端那个框只是取 token 的容器。安全上唯一有意义的一步在服务端，拿 token 去兑一次：

```js
// src/antispam.js —— 全站唯一一处「这层到底算不算过了」的判断
const form = new FormData();
form.append(''secret'', secret);
form.append(''response'', String(token));
if (ip) form.append(''remoteip'', ip);

const r = await fetch(''https://challenges.cloudflare.com/turnstile/v0/siteverify'', {
  method: ''POST'',
  body: form,
});
const d = await r.json();
if (d.success) return { ok: true };
return { ok: false, error: ''人机验证没通过，刷新页面再试一次'' };
```

这段没做任何额外判断：`d.success` 为真就放行。也就是说，这层的全部安全性来自对面那一个布尔值，而支撑那个布尔值的是三条约束。响应里其实还有几个字段，我们一个都没用：

| 字段 | 本站拿它干什么 | 能推出什么 |
|---|---|---|
| `success` | 唯一的开关 | token 有效、未过期、未被兑换过 |
| `challenge_ts` | 没看 | 挑战发生的时刻，能算出提交比挑战晚了多久 |
| `hostname` | 没看 | 这枚 token 是在哪个域名下签发的 |
| `error-codes` | 没看，也没打日志 | 失败原因，`timeout-or-duplicate` 就是重放或过期 |
| `action` / `cdata` | 没传，所以也没有 | 自定义标签，用来把 token 绑到「哪一次动作」 |

第三行和第五行连起来看，是本篇最想说的一句：我们既没传 `action`，也没传 `cdata`，所以校验端的信息只到「这枚 token 属于 exia.de5.net」，到不了「它属于这次评论提交」。token 绑的是**一次挑战**，不是**一次表单提交**。差别在于：同一枚 token 在 300 秒内只能兑一次，但兑给哪一次 POST，Cloudflare 不知道，我们也没告诉它。

重放这条路怎么堵死的。第一次兑换成功后，这枚 token 在 CF 侧就被标记为已用；第二次拿它去兑，返回 `success: false`，`error-codes` 里是 `timeout-or-duplicate`。超过 300 秒再兑，是同一个错误码——过期与重复在协议里共用一格。这点值得记住：日志里看到这个码，可能是脚本在重放，也可能只是用户把表单开了六分钟才点提交，两种情况的处置完全相反。

域名这条容易被低估。`sitekey` 是公开的，就写在 HTML 里，谁都能抄走。但 widget 只在 `sitekey` 后台登记过的域名下签发 token，抄到别的域名上渲染会直接报错，那是 widget 自己的域名校验，不经过你的代码；就算真签出来了，`hostname` 也对不上。所以「偷 `sitekey` 到自己站上跑，拿 token 打你的接口」走不通。前提是建 `sitekey` 时填的是具体域名，不是能匹配一切的泛域名。

单次不等于稀缺，这是最容易被误读的一条。token 只能兑一次，但签一枚的成本在真浏览器里接近零：widget 会自己刷新，重载一次页面就有一枚新的。所以「单次性」防的是**重放**（一枚用两次），不防**量产**（每次都用一枚新的）。这两种行为在日志里的形态完全不同：重放是同一串 token 出现两次，量产是每次一串不同的 token，每一串都合法。

单次加上 300 秒，合起来是第二层真正的约束力：它让「先囤一批、慢慢用」这条流水线失效。想批量提交，就必须在五分钟的窗口里把每一枚 token 兑掉，兑一枚少一枚；想在窗口外继续，就得重新回到浏览器里领。这不会让量产的代价变高多少（真浏览器领 token 近乎免费），但它把攻击的时间结构从「离线准备、集中投放」压成了「在线实时」，而实时的那部分最容易被限流看见。

我们的实现里还有个细节。`siteverify` 支持 `idempotency_key`，作用是让「网络超时后的重试」不被当成重复兑换。我们没传。后果是：如果这次 `fetch` 超时、代码重试一次，第二次会被判成重复，返回 `timeout-or-duplicate`，然后用户看到「人机验证没通过」——而他什么都没做错。这条没在线上发生过（这层还没开），是按接口语义推的，标为推断。

## 三、无感是默认，点击是例外

Turnstile 有三种形态。`managed`（默认）：多数会话直接过，少数「可疑」会话弹一个 checkbox。`non-interactive`：完全不给交互，跑完检测就发 token。`invisible`：连容器都不渲染，由代码调 `turnstile.execute()` 才发。配置项里那个 `appearance` 还能再细分，`always` 是一直显示，`execute` 是等程序调用，`interaction-only` 是只在需要交互时才把框露出来。

所以「Turnstile 要不要点」不是站点决定的，是评分决定的。同一个站、同一个组件，家里电脑上什么都不用做，机房 IP 上可能就要点一下。用户体感上的随机性，来自这层评分，不是组件抽风。

无感的代价，是没有「答对」这个硬信号。出题式的验证码有个好处：正确答案只有人和足够聪明的模型能给。无感模式把这道题撤了，剩下的全是旁证，而旁证在完整浏览器里天然齐全——包括由自动化驱动起来的完整浏览器。这是产品取舍的直接后果，不是实现缺陷：要么打断所有人，要么接受「像人的自动化」也能过。

钱的部分。一次 `siteverify` 就是一次跨网 HTTPS 往返，按 11-18 那篇量出来的单次往返 41ms 量级推，这层至少是 41~90ms 的墙钟成本，CPU 几乎为 0。这个数没实测，配了 key 之后可以用同一个接口对比 `wallTime` 和 `cpuTime`，方法照抄那篇。要注意的是它加在最贵的路径上：每一条评论提交都要多等一次网络。

token 的有效期从签发那一刻算，不是从提交那一刻算。这个差别在长表单上会变成真实的体验问题：写完一段长评论、切出去查资料、七八分钟回来点发送，手里那枚 token 早就过期了。组件通常会自己换新，但「它什么时候换」与「你读到的是哪一枚」之间有时间差——前端如果把 token 存进变量、提交时直接读变量，就会拿到过期的那个。本站是提交那一刻才调 `getResponse()`，不吃这个亏，代价是每次提交多一次同步读取。刷新时机的细节没测，这里只到推断。

还有一笔不明显的：它是全站唯一的第三方脚本。CSP 要同时放开 `script-src`（`api.js`）、`connect-src`（widget 自己的回调）、`frame-src`（组件是个 iframe）。三个指令少放一个，表现各不相同——少放 `frame-src` 最典型：脚本能加载、能初始化，框里一片空白，控制台报 CSP 违规，而人会先去怀疑 key 配错了。

## 四、拦得住什么

这一节的每一条都能落到具体某一步，而不是「更安全了」。

| 形态 | 卡在哪一步 | 服务端拿到的 |
|---|---|---|
| `curl -X POST` 直接发 JSON | 没有 JS，`turnstile_token` 是空串 | 400，`{"ok":false,"error":"请先完成人机验证"}` |
| Node 里的 `fetch` / `axios` | 同上 | 同上 |
| 只改了 UA 的爬虫 | UA 不参与签发，改它不影响任何一步 | 同上 |
| 存储里翻出来的旧 token | `siteverify` | `success:false`，`timeout-or-duplicate` |
| 从别人页面上抄来的一枚当次 token | `siteverify`（`remoteip` 对不上时更容易暴露） | 视情况，可能 `success:false` |
| 把 `sitekey` 抄到自己域名下 | widget 渲染阶段就失败 | 前端报错，请求根本到不了你 |

这六类的共同点：**要么缺一个能跑 JS 的环境，要么缺一枚当次有效的 token**。这也是这层在表单站上性价比高的原因——绝大多数垃圾提交来自不跑 JS 的填表机，而这类恰好是 Turnstile 最擅长的区间。

「改 UA」那条值得单独说一句。很多人把 UA 当主要防线，实际上它在整条链上只是旁证之一，甚至是最弱的一条。改 UA 不会让 `curl` 长出 `window.turnstile`，也不会让 `body.turnstile_token` 从 `undefined` 变成一串字符。

第五行那个「抄来的一枚当次 token」是本层真正的软边。token 可以被搬运——这正好是下一节的第一条。

## 五、没拦住什么

下面每条只讲原因，不讲做法。知道边界在哪，比知道边界存在有用。

**真实浏览器加自动化驱动。** Playwright 起的是真 Chromium，`window`、`document`、Canvas、WebGL、事件系统全在。无感模式下，这类会话通常直接拿到 token。不是「检测被绕过了」，是「没有检测发生」——它没有可用的异常信号，于是按正常会话处理。市面上所谓「绕过 Turnstile」的方案，绝大多数在能跑浏览器的场景里根本不需要绕过：老老实实把页面加载完，token 自己就来了。`navigator.webdriver` 确实是一个信号（Playwright 默认给 `true`），但它可改，一个启动参数的事；而且它表示的是「可疑」，不是「判定」。把一整层的安全性押在一个布尔属性上，是这类方案最常见的误判。

**人工代过。** 打码平台、远程人工、朋友帮点一下。人过了，就是人过了：token 是真的，`hostname` 是对的，`challenge_ts` 是刚才。Turnstile 能证明「有一个人的浏览器在五分钟内参与了这次挑战」，证明不了「这枚 token 是被谁拿去提交的」，更证明不了「提交的那段文字是人写的」。

这个边界的形状值得看清楚：**token 是可转移的**。它签给浏览器，不签给内容。一个人在 A 机器上过验证，把 token 复制到 B 机器的脚本里，在 300 秒内提交一次，协议上通。我们传了 `remoteip`，这让 CF 有能力比对签发 IP 和兑换 IP——但那是「有能力」，不是「一定拦」，跨 IP 兑换的判定细节我没做过实验，只到推断为止。真要堵这条，得把 token 绑到一次性 nonce 或表单内容摘要，成本比 Turnstile 本身还贵。

**拿到合法 token 之后的行为层滥用。** 一个人一天发 500 条内容正常的评论：每次提交重新拿一枚 token，每枚都合法，每个 `hostname` 都对。Turnstile 没有任何理由拦他——他确实是个人。这是设计边界，不是失败。它回答的问题是「请求从哪来」，不是「这个人今天能说多少话」。

有个变体更常见：内容不正常，但每条都换一枚新 token 的「真人加模板」。这类在 Turnstile 眼里和上面那位没有区别，因为两者的证据集完全一样。

**校验服务自己不可达的时候。** 本站的 `verifyTurnstile` 在 `fetch` 抛错时 `return { ok: true, degraded: true }`，是 fail-open。理由 11-11 那篇写过：外部依赖挂掉时若 fail-closed，等于把评论区的开关交给一个第三方域名的可用性。代价是这条路可以被「打挂校验接口」利用。这条属于设计时就知道的没拦住。

还有一条不算漏洞但会被误读的：Turnstile 不产生任何频率概念。它没有「这个 IP 今天已经验证过几次」这种计数，每次提交都是独立的一次挑战。想让它兼任限流，是在用错工具。

## 六、所以它只是三层里的第二层

三层的分工，一句话一层：

| 层 | 回答的问题 | 过了它意味着 |
|---|---|---|
| 蜜罐 `hp` | 这个表单是被脚本填的吗 | 填表的东西没看见那个框 |
| Turnstile | 这次提交背后有没有人类浏览器 | 有一次人类参与 |
| D1 限额 | 这个来源今天还能花多少 | 还没到额度和间隔 |

单独任何一层都不够。蜜罐过了不代表是人（脚本学一次就知道留空）；Turnstile 过了不代表量不大（真人有的是时间）；限额过了不代表内容干净（限额只数次数，不看内容）。

算一次攻击的成本，差别很直白。只有 Turnstile 的时候，发一条广告的成本是「一枚 token」，在真浏览器里等于 0，所以它能拦住的是「连浏览器都没有」的那批人。加上限额之后，成本变成「每天 10 条、每条间隔 60 秒」，一天要发 50 条就得换 5 个 IP、花掉至少 50 分钟。**让攻击不划算的不是验证，是配额。**

这也是「Turnstile 过了」不能当成「这条评论可以入库」的原因。它只说明第一问的答案是「是」，而入库需要三问都过。把三者合并成一个 `if`，会在某一层失效时把另外两层一起废掉——比如 siteverify 挂了就整体 fail-open 顺带跳过限额，那才是真正的灾难。

反过来说，限额也不能替 Turnstile。限额是事后计数，一个从没来过的 IP 发第一条时，限额永远是放行的；能不能让这条请求到达限额那一层之前就被筛掉，靠的是前面两层。三层是串联，不是三选一。

## 七、免费的那部分，价钱在别处

Turnstile 免费且不限次数，这是它和 reCAPTCHA 最大的差别。代价不在钱上，在「你要接受一个第三方脚本」和「你要接受它的判断粒度」。

| | Turnstile | reCAPTCHA v3 | hCaptcha |
|---|---|---|---|
| 费用 | 免费，不限次数 | 有免费额度，超出按次计费 | 有免费额度，超出按量计费 |
| 是否无感 | 默认无感，可疑会话才要点击 | 全程无感，只回分数 | 默认要勾选，无感在付费档 |
| 返回什么 | 布尔加少量元数据 | `0.0~1.0` 的分数，阈值自己定 | 布尔，企业版另有分数 |
| 数据去向 | 留在 Cloudflare，官方口径不用于广告画像 | 送到 Google | 留在 hCaptcha |
| 对自动化浏览器的宽松度 | 宽：完整浏览器常直接给 token | 宽：给高分，靠站点自己卡阈值 | 相对严：默认要一次交互 |
| 站点侧成本 | 一个脚本加一次跨网校验 | 一个脚本加一次校验，还要定阈值策略 | 一个脚本加一次校验 |

v3 的分数制听着更「细」，实际是把判断责任推回站点：0.5 分是拦还是不拦？大多数站到后来都定了一个拍脑袋的阈值，然后在「误伤真人」和「放过脚本」之间来回调。Turnstile 直接给布尔，等于替你做完了这个取舍，代价是你看不到中间那层信息——出问题时也没法解释「为什么这个人被要求点击」。

数据去向这条对本站是硬约束。全站 CSP 只放 `''self''` 加 nonce，唯一的第三方是 YouTube 和 Bilibili 的 iframe，还得用户点开才加载。接 Turnstile 要放开三个指令，接 reCAPTCHA 放开的是同一组，但多了一条：访客的鼠标轨迹会进 Google 的模型。这两个不是一个量级的取舍，尤其对一个没有广告收入的博客。

## 八、本站的真实状态：接好了，没开

代码在，key 没配。`turnstileMode()` 的四种状态里，现在落在 `off`：

```js
export function turnstileMode(env = {}) {
  const site = !!(env && env.TURNSTILE_SITE_KEY);
  const secret = !!(env && env.TURNSTILE_SECRET);
  if (site && secret) return ''on'';
  if (site) return ''site-only'';
  if (secret) return ''secret-only'';
  return ''off'';
}

// verifyTurnstile 的第一行：off 直接返回，一个请求都不发
if (mode === ''off'') return { ok: true, skipped: true };
```

线上证据不是「我看了一眼后台」，是两个可复现的读数。页面里下发的是 `"turnstile":""`，所以 `mountTurnstile()` 在 `if (!key || !slot) return;` 就返回了，`#ts-wrap` 一直是 `hidden`。CSP 里也没有那个域名：

```bash
curl -s -o /dev/null -D - https://exia.de5.net/ | grep -i content-security-policy
```

```text
content-security-policy: default-src ''self''; script-src ''self'' ''nonce-…'';
  style-src ''self'' ''unsafe-inline''; img-src ''self'' data: blob: https:;
  connect-src ''self''; frame-src ''self'' https://www.youtube.com https://player.bilibili.com;
  object-src ''none''; frame-ancestors ''none''
```

`nonce-…` 那里是一次响应 32 位十六进制的 nonce，每次都不一样，抄进文章没有意义。

`script-src` 里只有 `''self''` 和 nonce，`frame-src` 里只有两个视频站。就算哪天 `__SITE__.turnstile` 有值了，脚本插进 DOM 的那一刻也会被 CSP 拦掉——这是第二道保险，也是为什么本站在「半配」状态下会表现为「评论发不出去」，而不是「看起来有验证、实际没有」。

为什么不开，三条。

一是现在没有需要它解决的问题。后台没有一条待处置的垃圾评论，蜜罐和限额的拦截记录都是 0。给一个还没发生的问题付体验成本，是拿确定的代价换不确定的收益。

二是它要破全站的「零第三方」。放开三个 CSP 指令、引入一个会在每个访客浏览器里跑的脚本，这笔账在「垃圾评论 0 条」的前提下算不过来。全站现在唯一的第三方请求，是用户主动点开视频时才发的。

三是它拦的那一类，已经被更便宜的两层挡住了。没有浏览器的脚本过不了蜜罐，也拿不出 token；真正的空白区只剩「带浏览器的批量提交」，而这一类至今一次都没出现。

什么时候开：出现第一条「明显是脚本、但蜜罐和限额都没拦住」的提交时。那一刻它才是唯一不可替代的那层——不是因为它强，是因为另外两层对「有浏览器的对手」是盲的。

接了一半比接完了更能说明问题。`site-only` 那种状态（前端弹框、服务端无从校验）比 `off` 危险得多，因为它看起来在工作。本站现在是 `off`，至少是诚实的。

## 九、想在本地记一笔 token，怎么记

单次性由 CF 保证，本地不需要重复实现。但有一件事 CF 不给你：留痕。`timeout-or-duplicate` 只在响应里出现一次，不会进你的库。想把「同一枚 token 第二次到达」变成可查的记录，加一张表最省事。

```sql
CREATE TABLE IF NOT EXISTS turnstile_seen (
  token_hash TEXT PRIMARY KEY,   -- sha256(token) 的十六进制，不存原文
  first_ts   INTEGER NOT NULL
);
```

```js
/* 本地留痕：不替代 Cloudflare 的单次性，只把「第二次到达」变成一条可查的记录。
   并发两发同时打到 siteverify 时，谁先谁后由网络决定；本地这条 INSERT 是原子的。 */
async function seenBefore(db, token) {
  const buf = await crypto.subtle.digest(''SHA-256'', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, ''0'')).join('''');
  const now = Math.floor(Date.now() / 1000);

  // 主键冲突 = 这枚 token 来过；INSERT OR IGNORE 之后 changes 是 0
  const r = await db
    .prepare(''INSERT OR IGNORE INTO turnstile_seen (token_hash, first_ts) VALUES (?, ?)'')
    .bind(hash, now)
    .run();

  // token 只活 300 秒，留 10 分钟的记录就够；更长的时间窗没有意义
  await db.prepare(''DELETE FROM turnstile_seen WHERE first_ts < ?'').bind(now - 600).run();
  return r.meta.changes === 0;
}
```

这段有三个边界。

它不提供防护，只提供取证。CF 已经拒了，本地这层只是让「拒了几次、从哪个 IP、间隔多久」能查。真要拿它当防护，等于把 CF 的判断又实现了一遍，还得自己处理 300 秒的窗口。

它在并发下比 CF 硬。两发请求同时到 `siteverify`，理论上存在一个都返回 `success` 的窗口（这点我没测，只按「跨网往返不是原子的」推）；本地这张表的 `INSERT OR IGNORE` 是原子的，第二发一定拿到 `changes = 0`。这个差异只在毫秒级存在，但它是唯一「你这边能确定」的部分。

它得存 hash。token 只活 300 秒，泄露了用处也不大，但日志里出现完整凭证是坏习惯，而且这类日志经常被导出、被贴进 issue。

还有更省的写法：不建表，只在 `siteverify` 失败且 `error-codes` 含 `timeout-or-duplicate` 时打一行结构化日志，带 IP 和 token 前 8 位。本站现在连这行都没有——`if (!token)` 和 `!d.success` 走的是同一个返回，日志里分不清「没带 token」和「token 被判无效」。配 key 之前该补的第一件事不是这张表，是把 `error-codes` 打进日志。

## 怎么自己验一遍

三条检查，前两条现在就能跑、不产生任何数据，第三条要等 key 配好。命令都在 Git Bash 里验证过，`date` 是 2026-11-12。

**第一条，空 body。** 这一步走的是 `if (!content)`，在任何验证之前：

```bash
curl -s -i -X POST https://exia.de5.net/api/comments \
  -H ''content-type: application/json'' -d ''{}''
```

```text
HTTP/1.1 400 Bad Request
content-type: application/json; charset=utf-8
cache-control: no-store

{"ok":false,"error":"评论不能为空"}
```

**第二条，蜜罐填值。** 字段全合法，只把 `hp` 写成非空。它在 Turnstile 之前，所以返回的是蜜罐的文案，不是人机验证的文案：

```bash
curl -s -i -X POST https://exia.de5.net/api/comments \
  -H ''content-type: application/json'' \
  -d ''{"slug":"comment-anti-spam","content":"probe","name":"probe","email":"p@example.com","hp":"x"}''
```

```text
HTTP/1.1 400 Bad Request

{"ok":false,"error":"验证没通过，刷新页面再试一次"}
```

两次都是 400，但文案不同。这个区别就是校验链的顺序：`400 评论不能为空` → `400 验证没通过` → `400 请先完成人机验证`，三条文案对应三个位置，看返回就知道请求走到了哪。

**第三条，不带 token 的合法请求。** 这一步会真的写库，所以下面给的是「看什么」，不是「随便跑」：

```bash
curl -s -i -X POST https://exia.de5.net/api/comments \
  -H ''content-type: application/json'' \
  -d ''{"slug":"comment-anti-spam","content":"probe","name":"probe","email":"p@example.com"}''
```

| 当前状态 | 返回 | 原因 |
|---|---|---|
| key 没配（现在） | `200`，`{"ok":true,"id":…}`，真的入库 | `mode === ''off''`，`verifyTurnstile` 在第一行就 `skipped: true` |
| 两把 key 都配了 | `400`，`{"ok":false,"error":"请先完成人机验证"}` | `token` 为空串，走 `if (!token)` |
| 只配了 sitekey | `400`，`{"ok":false,"error":"人机验证配置不完整，暂时无法评论"}` | `site-only` 按配置不完整拒收 |

第二、三行是按代码路径推的，没在线上跑过——现在两把 key 都没配，跑不出这个返回。真要在生产上验，拿一篇草稿文章当目标，测完自己删那条评论，不然你会得到一条叫 `probe` 的垃圾数据。

**第四条，DevTools 里看 token 字段。** 打开任意文章页，开发者工具 → Network → 勾上 `Fetch/XHR`，在评论框里发一条（或者只看请求不点发送）。找 `POST /api/comments`，看 Payload：

- 本站走 JSON 提交，字段名是 `turnstile_token`，值是一长串不透明字符串，肉眼能看出不是 JWT（没有三段 base64，也没有点分隔的 header）；
- 用官方隐式表单的站点，字段名是 `cf-turnstile-response`——组件会自己在 `<form>` 里插一个隐藏 input，提交时随表单一起走。看到这个字段有值，说明 widget 已经签发了 token；字段不存在，说明组件没渲染成功，先去 Console 看 CSP 和脚本加载错误。

再发同一条：如果这层是开着的，第二次会拿到 `400 人机验证没通过`，服务端日志里对应的错误码是 `timeout-or-duplicate`。判断「是重放还是超时」的办法只有一个——看 `challenge_ts` 和提交时间的差：小于 300 秒是重放，接近或超过 300 秒是过期。我们没记这个字段，所以现在只能靠现象猜，这也是第九节那张表存在的理由。

#cloudflare #turnstile #security
', 'teardown', 'Turnstile 测的是「有没有人类参与的证据」：挡得住脚本，挡不住真实浏览器和过了验证之后的行为滥用。',
        '认证边界', 4, 0, 0, 1, '2026-12-23 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('turnstile') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'turnstile-what-it-blocks' AND t.name = 'turnstile';
INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'turnstile-what-it-blocks' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'turnstile-what-it-blocks' AND t.name = 'cloudflare';


INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('workers-free-tier-limits', 'Workers 免费额度到底能撑多少人：把 10 万次/天换算成真实访问', '## 结论

Workers 免费额度是每天 100,000 次请求，UTC 零点重置——所谓「Workers 每日请求限制」就是这一条，没有别的隐藏门槛。这个数单独看没有意义，因为它数的是「请求」，不是「访问」。一次访问花掉几次请求，取决于这一页有几张图。

本站的口径：HTML 1 次；CSS、JS、字体、图标走静态资源绑定，0 次；图片走 `/img/` 代理，1 张 1 次。所以纯文字页 1 次/访问，带 3 张图的文章 4 次/访问。`100000 / 4 = 25000`。

25,000 次带图访问/天，乘 30 天是 75 万 PV/月。听上去很远，实际比听上去更远：一个日均 1,000 PV 的站，每天 4,000 次请求，占额度 4%，一个月 12 万次。

先撞墙的也不是请求数。是每次调用 10ms 的 CPU，和每次调用 50 条的 subrequest。请求数决定「一天能接多少人」，CPU 决定「一页能算多复杂」，subrequest 决定「一页能查多少东西」。本站一页 SSR 的 `cpuTime` 是 5~9ms，已经贴着 10ms 在跑。

所以这笔账分四层：请求数换 PV、CPU 换功能、subrequest 换架构、超限之后的行为决定你敢不敢把它当生产环境用。

## 一、先定义「一次请求」

计费单位是 invocation，不是「一个 URL」，也不是「一个文件」。一次 HTTP 请求进入 Worker 的 `fetch()`，记 1 次。同一个请求里你 `fetch()` 自己十次，请求数还是 1，但会吃掉 10 条 subrequest——这两条额度是分开的，下面第五节会拆。

**静态资源不算 Worker 请求**——这是 10 万次能用很久的唯一原因，也是最多人搞错的一点。CSS、JS、字体、图标、`robots.txt` 这些由静态资源绑定吐出去的文件，不进 Worker 的计费；很多人以为「一个页面 20 个资源 = 20 次请求」，于是算出「一天只够 5,000 PV」，把免费额度判了死刑。

图片是另一回事。`R2_PUBLIC_BASE` 留空的时候，图片走 `/img/` 代理，那是 Worker 里的一条路由，1 张图 1 次请求。配上 R2 公开域名之后图片直连 R2，这个 Worker 路由就不再被经过，图片请求归零。

同一个页面的三种配置，容量差一个数量级：

| 配置 | 每次访问的请求 | 10 万次能撑 | 差在哪 |
|---|---|---|---|
| 全站 `run_worker_first: true`（连 CSS 都进 Worker） | 11 | 9,090 | 静态资源也在计费 |
| 只有 HTML 进 Worker | 4 | 25,000 | 静态资源不计费 |
| 再加上 R2 公开域名（图片不走代理） | 1 | 100,000 | 图片也不计费 |

所以「省额度」最有效的一招不是压缩代码、不是减小 HTML，是把静态资源和图片挪出 Worker 的执行路径。这件事改配置就能做到，改代码做不到。

这里有个开关会把便宜吃回去：`assets.run_worker_first`。设成全站 `true`，所有请求先进入 Worker，再由 Worker 去 `env.ASSETS.fetch()`，那每个 CSS 都算一次调用。本站为了让 HTML 注入主题，必须让页面先过 Worker；正确的做法是把 `run_worker_first` 收窄到页面路径，别让它覆盖 `/style.css` 和 `/icon-192.png`。这一条是配置层面的推断，没做过 A/B 计数，写在这里是提醒别照抄模板。

## 二、一次访问到底产生几次请求

按页面类型列一遍。`/img/` 每张 1 次，HTML 1 次，其它静态资源 0 次：

| 页面类型 | HTML | `/img/` 图 | 前台接口 | 合计 | 10 万次能撑的访问 |
|---|---|---|---|---|---|
| 纯文字文章（无图） | 1 | 0 | 0 | 1 | 100,000 |
| 纯文字文章 + 登录态探测 | 1 | 0 | 1 | 2 | 50,000 |
| 文章带 1 张图 | 1 | 1 | 0 | 2 | 50,000 |
| 文章带 3 张图 | 1 | 3 | 0 | 4 | 25,000 |
| 文章带 3 张图 + 登录态探测 | 1 | 3 | 1 | 5 | 20,000 |
| 首页（10 篇，各 1 张封面） | 1 | 10 | 0 | 11 | 9,090 |
| 首页 + R2 公开域名 | 1 | 0 | 0 | 1 | 100,000 |

注意「登录态探测」这一行。页面 HTML 是匿名缓存过的，登录状态靠前端再打一次 `/auth/status` 补，这一发也算 Worker 请求。它不产生任何内容，纯属为了在右上角显示一个头像——但它让每个访客的成本从 4 变成 5，容量从 25,000 掉到 20,000。这种「看不见的请求」是免费额度最常见的漏斗，比图片更隐蔽，因为它在 DevTools 里长得像一次正常接口调用。

还有一类请求不产生任何价值：扫描器。本站的 404 也是 Worker 渲染的（`notFoundPage`），所以每一次 `/wp-login.php`、`/.env`、`/phpmyadmin` 的探测都算一次真实请求，只是它不体现在 PV 里。这部分有多大取决于域名被扫的频率，我没做过连续统计，只能确定它不为零。能压的办法是在边缘用 WAF 自定义规则把明显的扫描路径直接 403——请求不进 Worker，就不计费，这比在代码里 `if` 判断划算得多。

数这个不用靠猜，写个脚本把页面里浏览器真会去取的东西数出来：

```js
// scripts/count-worker-requests.mjs
// 用法：node scripts/count-worker-requests.mjs https://exia.de5.net/p/some-post
const url = process.argv[2];
if (!url) {
  console.error(''用法: node count-worker-requests.mjs <页面 URL>'');
  process.exit(1);
}

const res = await fetch(url);
const html = await res.text();
const base = new URL(url);

// 只数浏览器会真的发出去的子资源：img / script / link / source / video / audio
// <a href> 是下一次访问，不属于这一次，排除掉
const refs = new Set();
const re = /<(?:img|script|link|source|video|audio)\b[^>]*?\b(?:src|href)=["'']([^"'']+)["'']/gi;
for (const m of html.matchAll(re)) {
  const u = new URL(m[1], base);
  if (u.origin !== base.origin) continue;      // 跨域资源由对方出钱，不算本站额度
  refs.add(u.pathname + u.search);             // 同一个 URL 只算一次
}

const bucket = { img: 0, static: 0, other: 0 };
for (const p of refs) {
  if (p.startsWith(''/img/'')) bucket.img++;                              // R2 代理，1 张 1 次
  else if (/\.(css|js|mjs|woff2?|png|jpe?g|gif|svg|ico|webp|avif)$/i.test(p)) bucket.static++; // 静态资源绑定，0 次
  else bucket.other++;                                                  // 页面内接口，按 1 次算
}

// HTML 自己 1 次 + 图片 + 接口；静态资源不计
const workerRequests = 1 + bucket.img + bucket.other;

console.log(JSON.stringify({
  url,
  htmlKB: +(html.length / 1024).toFixed(1),
  workerRequests,
  breakdown: { html: 1, ...bucket, staticFree: bucket.static },
}, null, 2));
```

这脚本只解析 HTML，不执行 JS，所以它抓不到运行时才发出的 XHR。它是下限，不是全貌——用它抓「图片和静态资源」这两项足够，接口那一项要开 DevTools 的 Network 面板对一遍。

## 三、把 100,000 换成 PV

按每页 4 次请求算（1 次 HTML + 3 张图，这是本站文章页最典型的形态）：

| 日均 PV | 日耗请求 | 占 10 万 | 月耗（30 天） | 判断 |
|---|---|---|---|---|
| 100 | 400 | 0.4% | 12,000 | 完全无感 |
| 1,000 | 4,000 | 4% | 120,000 | 随便用 |
| 5,000 | 20,000 | 20% | 600,000 | 还有四倍余量 |
| 10,000 | 40,000 | 40% | 1,200,000 | 开始要看峰值 |
| 25,000 | 100,000 | 100% | 3,000,000 | 顶满，任何突发都 1027 |

`1000 × 4 = 4000`，`4000 / 100000 = 4%`，`4000 × 30 = 120000`。这三个式子就是「免费够不够」的全部答案，剩下的都是口径问题。

口径问题里最容易被忽略的是日切时刻。UTC 零点对应北京时间早上 8 点，也就是说中文站长嘴里的「今天额度」是从早上 8 点算到次日早上 8 点。晚上 9 点的流量和次日早上 7 点的流量算在同一个计费日里，而早上 9 点的流量算新的一天。发文章、做推广、看曲线，都得先把这个 8 小时偏移记住，否则你会看到「明明凌晨没人访问，请求数却在涨」这种鬼故事。

UV 换不出来。额度不认人，只认请求；一个 UV 看 3 页还是看 30 页，后台看不出区别。真要按 UV 估容量，只能取「PV / UV」的历史比值，那个数从站点日志里来，不在 Cloudflare 的面板里。

75 万 PV/月 是「每天顶满」乘出来的，不是可持续目标。真实站点有峰谷：发文那天可能是平时的 10 倍，一篇被转发的文章能拖出一周长尾。按日均算容量，等于假设每天都是平均日，而 1027 只会出现在你最不希望它出现的那个峰值日。所以判断「够不够」的口径应该是「峰值日 × 1.5 < 100,000」。日均 1,000 PV 的站，峰值日按 8,000 PV 算，`8000 × 4 = 32000`，还剩三倍余量，这才叫够用；日均 1 万 PV 的站，峰值日按 8 万 PV 算，`80000 × 4 = 320000`，早就爆了，日均看着只有 40% 也没用。

## 四、10ms CPU 才是真瓶颈

请求数管的是「一天能接多少人」，CPU 管的是「接住的这个人，你能为他算多少」。免费版每次调用 10ms，这个额度不按天累计，是按次卡死：任何一次调用超了，那一次就是 1102（Worker threw exception），跟当天已经用了多少无关。

本站实测的 `cpuTime`（`wrangler tail` 抓的，13 那篇同一批数据）：

| 路径 | wallTime | cpuTime | 说明 |
|---|---|---|---|
| `/cat/tools`（并发改造后） | 84ms | 5ms | 一页 HTML 渲染 |
| `/cat/tools`（缓存命中） | 4ms | 0ms | 只查了 `caches.default` |
| `/tag/cloudflare` | 148ms | — | 多一次标签查询，CPU 没单独抓 |
| `/api/posts` | 51ms | 2ms | 两条查询 + JSON 序列化 |

官方给的参考值是「平均每次请求约 2.2ms」，处理认证、SSR、大 payload 的 Worker 通常 10~20ms。本站的 SSR 落在 5~6ms，属于官方口径里的「正常偏重」——也就是说，一个正常的中文博客，做完渲染就已经用掉了 10ms 里的一半。

把 10ms 折成一天的总量：`100000 × 10ms = 1000000ms = 1000 秒 ≈ 16.7 分钟`。这是极端情况（每一发都打满），本站按 5ms 算是 500 秒/天，8 分多钟。这个数字说明免费版的 CPU 其实很宽裕——**它不是总量不够，是单次不够。**

还有一个容易漏的点：模块顶层的代码也算 CPU。在文件顶部 `await` 一次 KV 读、在模块作用域建一个大 Map、在 import 时解析一份 JSON，这些只在冷 isolate 里跑一次，但那一次的 CPU 会跟正常渲染叠在同一发请求的账上。把配置缓存在模块作用域是常见写法，代价就是「每个新 isolate 的第一发特别容易超」——不是渲染变重了，是初始化一起付了。13 那篇记的第一发 `wallTime` 是 549ms，其中 CPU 占多少我没单独抓，只能确定它不是零。

单次不够意味着什么，列清楚：

| 想在请求里做的事 | 典型 CPU | 10ms 下能不能做 |
|---|---|---|
| 8KB HTML 的模板字符串替换（本站） | 5~6ms | 能，但只剩 3~4ms 余量 |
| 最重的一页（模板 + 较大结果集） | 7~9ms | 能，再重一点就危险 |
| 解析 1MB JSON | 数十 ms | 不能（推断，没实测） |
| 图片缩放 / 加水印 / 转 WebP | 几百 ms 到数秒 | 不能，必须外移 |
| PDF 生成、加密解密、压缩包 | 数百 ms 起 | 不能 |

标了「推断」的那一行得说清楚：我没在免费版上真跑过 1MB JSON 解析，只是按 V8 的解析吞吐估的。图片和 PDF 那两行不算推断——它们的耗时在几百毫秒量级，10ms 连一次解码都跑不完，这是量级差，不是边界情况。**免费版禁止的是「重活」，不是「慢活」**。

这两件事经常被混为一谈。13 那篇里 `/cat/tools` 的 wallTime 是 84ms、cpuTime 是 5ms，94% 的时间在等数据库，CPU 一点没花。等 I/O 不烧 CPU，你完全可以有一个 500ms 才吐出来的页面而 CPU 只花 3ms。所以「超 CPU」的判断标准是 `cpuTime`，不是 TTFB，也不是页面打开速度。看到页面慢就去砍字符串拼接，是这类问题里最常见的误诊。

## 五、50 条 subrequest 是第二个天花板

`fetch()` 派发那一刻计数，一次调用 50 条，超出直接抛 `Too many subrequests by single Worker invocation`。这条在 06 那篇里踩过，实测第 50 次成功、第 51 次抛错，并发发 200 条 184ms 就全炸。

它比 CPU 更容易先撞，因为 CPU 只在你写重代码时超标，subrequest 会在你「多查两次就好」的时候悄悄涨上去。文章页从串行改并发那一次，顺手把条数从 9 条压到了 6 条：

| 项 | 改造前 | 改造后 | 怎么省的 |
|---|---|---|---|
| 正文查询 | 1 | 1 | — |
| 标签 | 1（第二次往返） | 0 | 并进主查询的 `GROUP_CONCAT` 子查询 |
| 评论 | 1 | 1 | — |
| 系列目录 | 1（有条件） | 1 | 绑定参数从 `post.id` 换成 `slug`，不再等正文 |
| 封面图（走 `/img/` 代理） | 1 | 1 | — |
| 模板读取 | 2（重复读） | 1 | 同一次请求里只 `assetText` 一次 |
| 站点设置 | 2（两个 hook 各拉一次） | 1 | 30 秒进程内缓存兜住 |
| 合计 | 9 条 | 6 条 | 两条重复 + 一条内联 |

省掉的 3 条里有 2 条是纯浪费：同一个模板、同一份站点设置，在一次请求里被读了两遍。这种重复在 `wrangler tail` 里完全看不出来——它只告诉你这一发花了 84ms，不告诉你里面派发了 9 次。数条数得自己在 `fetch` 外面套一层计数器（06 那篇的 `counted`）。

改造后同一页 127ms → 86ms，那是 13 那篇的数字。但那次改动真正的收益不是 41ms，是**条数从 9 降到 6**：时间可以靠并发叠，条数有硬上限。

50 条怎么分，得提前拍预算，不然会在某个「加个功能」的下午突然撞墙：

| 用途 | 预算 | 计入哪条额度 | 本站实际 |
|---|---|---|---|
| D1 查询 | 20 | D1 自己的 50 条/调用 | 6 |
| 外部 API `fetch` | 5 | subrequest 50 | 0~1 |
| 模板 / 静态资源（`ASSETS.fetch`） | 5 | subrequest 50 | 1 |
| 图片 / 头像代理 | 5 | subrequest 50 | 0~3 |
| 余量（突发图片、webhook 重试） | 15 | subrequest 50 | — |

这张表有个容易看错的地方：D1 查询不占 subrequest 的 50。06 那篇实测过，800 次 D1 查询在免费计划下全部跑完，只慢不报错。文档里另有一条「单次调用 50 条查询」的说法，跟这个实测对不上——要么是口径跟我理解的不一样，要么它只对某些路径生效。我按实测走，但预算还是给自己留了 20 条，因为撞上这条的时候没有任何日志能告诉你撞的是哪一条。

还有一条隐藏上限：同时出站连接 6 条。所以 `Promise.all` 里塞 20 条查询，第 7 条开始是排队的，你看不见，只觉得「并发怎么没快多少」。13 那篇反推的单次往返成本是 41ms，20 条排队等于 6 批 × 41ms ≈ 250ms，比串行好、比想象差。真要压，用 `db.batch()` 把多条语句塞进一次请求，省的是固定开销，不是连接数。

「不占 subrequest」的清单值得背下来：D1、KV、R2、Workers AI、Service Binding，凡是走 `env.X` 的都不占，它们走内部通道，不出公网。占的只有 `fetch()`：外部 API、同 zone 自调、`/img/` 图片代理、`env.ASSETS.fetch()`。判断方法很土但很好用——代码里出现 `fetch(` 就是一次，没出现就不是。这条也解释了为什么「用 binding 替掉 HTTP」是省额度收益最高的一刀：同一个功能，换成 binding 之后请求数不变，subrequest 直接归零。

## 六、配套额度：先撞的往往不是 Workers

Workers 只是入口，真正的数据在 D1、KV、R2 里，这三个各有各的免费线：

| 资源 | 免费额度 | 最先撞墙的场景 | 折成访问量 |
|---|---|---|---|
| D1 存储 | 5GB/账户，单库 500MB | 单库写满 500MB | 按每篇正文 12KB 算约 4 万篇（`500×1024/12 ≈ 42666`） |
| D1 查询数 | 单次调用 50 条 | 一页塞十几个关联查询 | 本站 6 条，余量充足 |
| KV 读 | 100,000 次/天 | 每个请求读一次就正好打平 Workers 的 10 万 | 与请求额度同量级，等于没有余量 |
| KV 写 | 1,000 次/天（不同 key） | 每来一条评论写一次、每个赞写一次 | 1,000 次/天，一个有互动的站当天就满 |
| KV 单 key | 1 次写/秒 | 用 KV 做阅读计数 | 无法实时，必然丢计数 |
| R2 存储 | 10GB-month | 图片站 | 按每张 200KB 算约 5 万张（`10×1024×1024/200 ≈ 52428`） |
| R2 写（Class A） | 100 万/月 | 上传图片 | 约 3.3 万次/天 |
| R2 读（Class B） | 1,000 万/月 | 图片外链 | 约 33 万次/天，比 Workers 宽 3 倍多 |
| R2 出网 | 免费 | — | 这是 R2 唯一明显的优势 |

这张表里最紧的是 KV 的 1,000 次写/天。它不是「不够用」，是「用量稍微一涨就满了」——一条评论一次写、一个赞一次写、一次阅读计数一次写，500 个互动就是 1,500 次，当天下午就超。KV 的定位是「读多写少的配置和缓存」，不是计数器。要做计数，得上 D1（写不按次计费，按行数）或者 Durable Objects（付费）。

D1 的单库 500MB 也容易被误解：它是单库上限，不是账户总量。账户 5GB 可以放 10 个库，每个 500MB，加起来正好 5GB。所以「库满了」通常不是因为总量不够，是把所有东西塞进了同一个库。本站只有一个库，按每篇正文 12KB 算，`500 × 1024 / 12 ≈ 42666` 篇才到 500MB——这个数字比大多数人的写作寿命长，真正会先满的是图片，而图片在 R2 里。

反过来，R2 的免费额度比 Workers 宽得多：1,000 万次读/月折 33 万次/天，是 Workers 请求额度的 3.3 倍。所以「图片走 R2 公开域名」这件事在两条额度上都划得来——Worker 少一次请求，R2 那边还有大量余量。

## 七、超限之后到底发生什么

请求打满，返回的是 Cloudflare 的 `Error 1027` 页。白底、一行 `Error 1027`、一句平台口径的说明（大意是「该站点已超出每日请求限制」），没有你的导航、没有你的 404 插图、没有你的主题色。访客看到的是「这个网站挂了」，不是「这个网站今天额度用完了」。

三个反直觉的点：

**第一，你的日志里什么都没有。** 1027 在边缘就被拦下，Worker 根本没被调用，所以 `wrangler tail` 抓不到任何事件——不是抓到报错，是**一片空白**。第一次遇到会以为是 tail 掉线了。

**第二，你的错误页不生效。** `notFoundPage`、`harden` 那套响应头、你自己写的 500 兜底，全在 Worker 里，而 Worker 没跑。

**第三，缓存也救不了。** 13 那篇把一页从 84ms 压到 4ms，CPU 从 5ms 压到 0，但**请求数一次没少**——缓存命中的请求仍然是一次 invocation。免费额度只认「有没有进来」，不认「进来干了多少活」。这也解释了为什么优化性能不等于省额度：这两件事的计量单位根本不同。

顺手把三个错误码分开，它们的处理方式完全不同：

| 错误码 | 含义 | 影响范围 | 恢复方式 |
|---|---|---|---|
| 1027 | 账户当日请求额度用尽 | 这个 Worker 的所有路由 | UTC 零点自动恢复 |
| 1102 | 单次调用 CPU 超限 | 只有这一发请求 | 下次请求可能正常 |
| 1101 | 代码抛了未捕获异常 | 只有这一发请求 | 修代码 |

1027 会让人误判成「代码挂了」，因为它长得最不像你的站；1102 会让人误判成「网络抖了一下」，因为重试就好了。两者的日志特征完全不同：1027 在 `wrangler tail` 里是空白，1102 是一条带 `exceeded CPU` 的 exception。

超限时的行为由路由的 fail mode 决定：

```jsonc
// wrangler.jsonc
{
  "name": "exia-blog",
  "routes": [
    {
      "pattern": "exia.de5.net/*",
      "zone_name": "de5.net",
      // false = fail closed：超限时直接返回 1027
      // true  = fail open：超限时绕过 Worker，把请求交给源站
      "fail_open": false
    }
  ]
}
```

这个字段在部分 wrangler 版本里会被静默忽略（不报错、也不生效），所以配完必须去 Dashboard → Workers & Pages → 选中 Worker → Settings → Routes，确认那一行的模式写着 Fail closed。配置文件和面板不一致这种事，只会在出故障的那一天才暴露。

为什么公共站点该选 fail closed：`true` 的意思是「Worker 撑不住了就让请求穿过去」。如果你的 Worker 只是渲染页面、后面是静态资源，穿过去等于全站 404，难看但不漏数据；如果你的 Worker 站在真实源站前面做鉴权，穿过去就是**鉴权层消失，所有请求直连源站**——私密文章、后台接口、写操作全部裸奔。超限那一刻恰恰是流量最大的那一刻，也是你最不希望鉴权失效的那一刻。

选 closed 的代价是：超限期间整站不可用，包括本来可以静态返回的页面。这个代价我认，因为「挂一小时」可以被解释，「漏一小时数据」不能。

没有预警这件事最难受。Cloudflare 不会在用到 80% 的时候发邮件，1027 是硬着陆，落地就是整站不可用。想提前知道只能自己埋：用一个 cron 每天拉一次 GraphQL 的 `workersInvocationsAdaptive`，把 `sum.requests` 跟昨天比；或者在 D1 里放一行计数器，每个请求 `UPDATE ... SET n = n + 1`（D1 按行计费，这点写入可以忽略），到 7 万就在页面顶部挂一条只给自己看的横幅。KV 干不了这活——1,000 次写/天，每请求写一次，半小时就满。

顺带一个数：友链巡检的 cron 是 `*/20 * * * *`，一天 72 次，`72 / 100000 = 0.072%`。Cron 触发也占请求额度，但按这个量级可以忽略。免费账户最多 5 个 cron，真要塞满，得先算 `24 × 60 / 间隔分钟数`。

## 八、什么时候必须掏 $5

判断标准不是「访问量大了」，是「你的请求模型变了」：

| 信号 | 阈值 | 为什么 |
|---|---|---|
| 日均 PV 逼近 2 万（每页 4 次） | 日耗 8 万次，余量 20% | 一次转载或被推荐就顶满 |
| 单页 `cpuTime` 常态 > 8ms | 10ms 上限只剩 2ms | 任何一次抖动就是 1102 |
| 需要在请求内做图片处理 / 大 JSON / PDF | 几十到几百 ms | 免费版物理上做不到 |
| 需要 Durable Objects、Queues、WebSocket 长连接 | — | 这些能力只在付费计划开放 |
| 需要 CPU 超过 10ms（哪怕偶尔） | — | 付费默认 30 秒，可调到 5 分钟 |
| 需要 subrequest 超过 50（爬虫、批量同步、聚合 API） | 付费 10,000 | 免费版这条不可调 |

`$5/月` 买到的东西，按「能不能改变架构」排序：

| 项 | Free | Paid（$5/月） |
|---|---|---|
| 请求 | 100,000/天 | 无日上限（含每月 1,000 万次，超出按量计费） |
| CPU | 10ms/次 | 默认 30 秒/次，可调到 5 分钟 |
| subrequest | 50/次 | 10,000/次 |
| Durable Objects / Queues | 不可用 | 可用 |
| 内存 | 128MB | 128MB |

$5 真正买的不是「更多的请求」，是**不用再为额度设计架构**。免费版下你会为了省一条 subrequest 把三条查询揉成一条丑 SQL，会把图片挪去 R2 公开域名，会为了不超 CPU 放弃在请求内做该做的事。这些妥协在小站上是对的，在「一个月多写十篇文章」的站上就是负债。

但别为了 CPU 付钱，先确认瓶颈真是 CPU。大多数喊着「Worker 超 CPU」的站，`cpuTime` 只有 2~3ms，慢在往返上（13 那篇整整一篇都在说这件事）。`$5` 解决不了 41ms 一次的数据库往返，那要靠改查询结构。

还有一层容易被忽略：付费之后 Workers 不再是瓶颈，D1 会变成。付费版 D1 按「读行数 / 写行数」计费，一个没加索引的 `LIKE ''%关键词%''` 扫描能瞬间把行数打上去。所以 $5 之后该看的仪表盘从「Requests」换成「D1 rows read」，那是另一条账。

## 九、按一个月排一次预算

把上面的口径拼起来，给一个具体的小站算一遍：日均 800 PV，一个月发 8 篇，每篇 3 张图。访问构成按本站的比例估：60% 文章页、30% 列表页、10% 其它（归档、404、静态页）。

| 页面 | 占比 | 每次访问请求 | 加权 |
|---|---|---|---|
| 文章页（3 图） | 60% | 4 | 2.4 |
| 列表 / 首页（10 张封面） | 30% | 11 | 3.3 |
| 其它（归档、404、静态页） | 10% | 2 | 0.2 |
| 平均 | 100% | — | 5.9 |

`800 × 5.9 ≈ 4720 次/天`，`4720 / 100000 = 4.7%`，一个月 `4720 × 30 = 141600` 次。

反直觉的是列表页比文章页贵：一篇 3 图的文章 4 次，首页 10 张封面 11 次，因为一屏要拉十张图。所以「图片挪去 R2 公开域名」收益最大的不是文章页，是首页。改一个配置，整站的平均成本能掉一大截：

| 配置 | 平均请求/访问 | 日耗（800 PV） | 占 10 万 |
|---|---|---|---|
| 现状（图片全走 `/img/` 代理） | 5.9 | 4,720 | 4.7% |
| 只有首页图片走 R2 公开域名 | 2.9 | 2,320 | 2.3% |
| 全站图片都走公开域名 | 1.1 | 880 | 0.9% |

`0.6×4 + 0.3×1 + 0.1×2 = 2.9`，`0.6×1 + 0.3×1 + 0.1×2 = 1.1`。第二行只改了首页的图片路径，日耗直接砍一半；第三行把文章页的图也挪出去，同样的访问量只剩 0.9%。

这张表能看出免费额度的真正瓶颈不在「10 万」这个数，在「你把多少东西放在了 Worker 路径上」。同一个站、同样的流量，请求数可以差 5 倍，区别全在配置。

「Cloudflare Workers 免费够用吗」这个问题因此没有统一答案：日均 1,000 PV 的文字博客，够用得完全看不出来；日均 1 万 PV、每页十张图的站，第一个峰值日就会挂。能回答这个问题的不是访问量，是「平均每次访问要花几次请求」这一行小字。

## 怎么自己验一遍

**1. 看当日请求数。** Dashboard → Workers & Pages → 选中你的 Worker → Metrics → Requests，时间范围选 Last 24 hours。注意横轴的日切是 UTC，对应北京时间早上 8 点；同一个面板往下拉有 CPU time 曲线，两条并排看才知道是请求先到还是 CPU 先到。免费版的历史窗口很短，当天不记，过几天就没了。

**2. 抓单次调用的 `cpuTime` 与 `wallTime`。**

```bash
npx wrangler tail --format json \
  | jq -c ''select(.event.cpuTime != null)
           | {path: (.event.request.url | sub("^https?://[^/]+"; "")),
              cpu: .event.cpuTime, wall: .event.wallTime, outcome: .event.outcome}''
```

输出长这样，`cpu` 贴着 10 就跑在悬崖边：

```text
{"path":"/p/workers-free-tier-limits","cpu":9,"wall":86,"outcome":"ok"}
{"path":"/cat/tools","cpu":5,"wall":84,"outcome":"ok"}
{"path":"/cat/tools","cpu":0,"wall":4,"outcome":"ok"}
```

**3. 数 subrequest。** `wrangler tail` 不直接给条数，得自己在 `fetch` 外面包一层，把结果打进日志，日志会随 tail 的事件一起出来：

```js
// src/index.js 入口，临时包一层计数
let n = 0;
const counted = (input, init) => { n++; return fetch(input, init); };

// 业务函数里所有 fetch 都换成 counted（D1 / KV / R2 的 binding 不算，不用换）
try {
  const res = await handle(request, env, ctx, counted);
  console.log(`sub=${n} path=${new URL(request.url).pathname}`);
  return res;
} catch (e) {
  console.error(`sub=${n} path=${new URL(request.url).pathname} ${e.message}`);
  throw e;
}
```

```bash
# 只看带 sub= 的那条日志
npx wrangler tail --format json \
  | jq -r ''select(any(.logs[]?; .message[0] | startswith("sub=")))
           | "\(.event.request.url) cpu=\(.event.cpuTime) \(.logs[0].message[0])"''
```

**4. 算这一页能撑多少人。** 拿第 3 步的 `sub` 和第 2 步的 `cpu`，套两个式子：`100000 / 每次访问的请求数 = 日访问上限`；`10 / cpuTime` 就是你离 CPU 上限还有几倍——5ms 的页面是 2 倍，9ms 的页面是 1.1 倍。前者小于你的日均 PV 就该看付费，后者掉到 1.5 以下就该拆功能。

**5. 验证「图片计费、静态资源不计费」。** 找同一天，一个只发纯文字页、一个发 10 图页，隔一小时看 Dashboard 的请求增量差多少。这一步要真实流量，我没跑过，只能给出判断口径：如果 10 图页的增量是纯文字页的 11 倍，说明图片走的是 `/img/` 代理、在计费；如果两边差不多，说明图片走了 R2 公开域名，Worker 那条路没被经过。

额度这件事压成一句话：**免费版不是「给你 10 万次」，是「给你 10 万次里不许有一次算得久、查得多」。** 前者很宽，后者很窄。
', 'log', '静态资源不算 Worker 请求，这是免费额度能用很久的关键；真正的瓶颈是 10ms CPU 和 50 条 subrequest。',
        '', 0, 0, 0, 1, '2027-01-06 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'workers-free-tier-limits' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('workers') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'workers-free-tier-limits' AND t.name = 'workers';


INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('d1-kv-r2-latency', 'D1、KV、R2 到底谁快：1100 次调用的实测分布', '## 结论

在同一台 Worker、同一个机房、同一秒内跑出来的一组数：

| 操作 | p50 | p95 | 相对 D1 |
|---|---|---|---|
| D1 `SELECT 1`（不碰任何表） | 44.4ms | 46.8ms | 1.00× |
| D1 主键单行查询 | 43.8ms | 47.2ms | 0.99× |
| D1 列表 10 行 + ORDER BY | 44.0ms | 50.0ms | 0.99× |
| D1 聚合 GROUP BY | 43.4ms | 45.6ms | 0.98× |
| D1 单行 UPDATE | 43.2ms | 49.0ms | 0.97× |
| R2 HEAD | 74.0ms | 92.4ms | 1.67× |
| R2 GET 1KB | 76.2ms | 87.0ms | 1.72× |
| R2 PUT 1KB | 279.2ms | 684.4ms | 6.29× |
| KV GET（key 存在） | 3.6ms | 4.2ms | 0.08× |
| KV GET（随机 key，必然未命中） | 265.4ms | 294.6ms | 5.98× |
| KV PUT（每次新 key） | 560.4ms | 605.0ms | 12.7× |

三个结论，每一个都跟直觉相反：

**第一，D1 上优化 SQL 写法几乎没有收益。** `SELECT 1` 和「10 行带排序」差了 0.6ms，和「GROUP BY 聚合」差了 1ms。真正的问题是那 44ms 的固定往返——四类查询里它占 97% 以上。想在 D1 上提速，唯一有效的动作是**减少查询次数**，不是把 SQL 写得更聪明。

**第二，KV 的 3.6ms 不是「KV 存储快」，是「这次读没出机房」。** 同一个 KV 读一个不存在的 key，265ms。差 73 倍。KV 快的前提是命中边缘缓存，命中率决定一切，跟数据量、跟 key 大小都没关系。

**第三，R2 读比 D1 慢。** 76ms vs 44ms。R2 的定位是便宜，不是快。任何把 R2 当「图片直接每次读」的架构，都在为每张图付 76ms。

下面是完整的测量方法、数据和选型判断。

## 一、怎么量的

不测「客户端到 Worker」这一段网络——那一段取决于我家的宽带和 Cloudflare 的边缘调度，跟产品本身没关系。只测 Worker 内部对绑定的调用。

写一个临时 Worker，绑同一个 D1 库、同一个 R2 桶、新建一个 KV 命名空间，每个 target 在一个请求里串行调用 N 次：

```js
// bench/index.js —— 只保留核心，完整版见 content/bench-data.md
async function timeIt(n, fn) {
  const GROUP = 5;
  const out = [];
  for (let i = 0; i < n; i += GROUP) {
    const t0 = performance.now();
    for (let j = 0; j < GROUP; j++) await fn(i + j);
    out.push((performance.now() - t0) / GROUP);
  }
  return stats(out);
}
```

这里有个必须先踩的坑：**Workers 里 `performance.now()` 被量化到整毫秒**。直接单次测量，绝大多数样本读到 0：

```json
{ "n": 5, "min": 0, "p50": 0, "p95": 0, "max": 0 }
```

所以改成 5 次一组测总时长再摊平，样本粒度回到 0.2ms。这一步不做，所有亚毫秒级的结论都是错的——包括 KV 那 3.6ms，单测的话它和 0 分不开。

采集流程：每个 target 打 3 轮，每轮 60 次（写操作 30 次），**丢弃第一轮**（isolate 预热），合并后两轮算分位。最终每项 120 次调用（写操作 60 次）。

对照组 `SELECT 1` 是关键。它不碰任何表、不需要解析、不需要 IO，只走一次 D1 的网络往返。它测出来的数就是「固定成本」的底。

## 二、D1：44ms 里，查询本身只占 1ms

把四类查询和对照组放一起看：

| 查询 | p50 | 与 `SELECT 1` 的差 |
|---|---|---|
| `SELECT 1 AS x` | 44.4ms | — |
| `SELECT id, title FROM posts WHERE slug = ?` | 43.8ms | −0.6ms |
| 10 行 + `ORDER BY` | 44.0ms | −0.4ms |
| `GROUP BY category` 聚合 | 43.4ms | −1.0ms |
| 单行 `UPDATE` | 43.2ms | −1.2ms |

差值是负的。也就是说，这四类真实查询**比空查询还快一点点**——纯粹是噪声，量级 1ms 左右的抖动。落在同一区间里，分不出谁更贵。

这就是 D1 的成本结构：**每一次 `await env.DB.prepare(...)` 都是一次独立的网络往返，往返本身 44ms，查询在里面花的时间是小头。**

官方文档里说「有索引的单行查询 SQL 时长不到 1ms」，这跟我量到的完全对得上——SQL 时长确实不到 1ms，但你在 Worker 里等的是 44ms。那 43ms 花在序列化、排队、跨机房传输上，跟你的 SQL 写得好不好无关。

所以优化方向只有一个：**把多次查询压成一次往返。**

本站文章页原来是这样拿数据的：

```js
// 改之前：5 次 await = 5 次往返 = 220ms 的固定成本
const post = await env.DB.prepare(''SELECT ... FROM posts WHERE slug = ?'').bind(slug).first();
const tags = await env.DB.prepare(''SELECT ... FROM tags WHERE post_id = ?'').bind(post.id).all();
const cmts = await env.DB.prepare(''SELECT ... FROM comments WHERE post_id = ?'').bind(post.id).all();
const sers = await env.DB.prepare(''SELECT ... FROM posts WHERE series = ?'').bind(post.series).all();
const site = await getSite(env);
```

改成一次 `Promise.all` 并发、并且用 `slug` 直接关联（不再先查 `post.id` 再用 id 查别的），依赖深度从 2 掉到 1：

```js
// 改之后：1 次并发 = 1 次往返窗口
const [post, tagRes, cmtRes, seriesRes, site] = await Promise.all([
  env.DB.prepare(`SELECT p.*, u.name AS author_name FROM posts p
    LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`).bind(slug).first(),
  env.DB.prepare(`SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
    JOIN posts p ON p.id = pt.post_id WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`SELECT ... FROM posts WHERE series =
    (SELECT series FROM posts WHERE slug = ?)`).bind(slug).all(),
  getSite(env),
]);
```

实测下来页面 TTFB 从 127ms 掉到 86ms。掉的那 41ms 正好等于一次往返——数字对得上，说明这个模型是对的。

## 三、KV：3.6ms 和 265ms 是同一个产品

| 场景 | p50 | p95 | 说明 |
|---|---|---|---|
| 读一个存在的 key（反复读同一个） | 3.6ms | 4.2ms | 命中边缘 |
| 读一个随机 key（必然不存在） | 265.4ms | 294.6ms | 回中央存储 |

73 倍。而且注意 p95 只有 4.2ms——命中路径几乎没有抖动，它就是内存读。未命中那 265ms 也不是「慢」，是「跑了一趟远的」。

这解释了一件很多人误解的事：**KV 不是数据库，是「带全局复制的配置缓存」。**

它的读性能取决于命中率：
- 热 key（首页配置、功能开关、限流计数器）→ 3.6ms，比 D1 快一个数量级
- 冷 key（每个用户一份、每个请求一个新 key）→ 265ms，比 D1 慢 6 倍

写更离谱：

| 操作 | p50 | p95 |
|---|---|---|
| KV PUT（每次新 key） | 560.4ms | 605.0ms |
| D1 单行 UPDATE | 43.2ms | 49.0ms |

KV 写入比 D1 慢 13 倍。原因是 KV 的写不是「写入一个地方就返回」，是写到一个中心点然后异步扩散到全球边缘——它优化的目标是「写完很久之后，全世界读都很快」，不是「写完立刻能读到」。

所以 KV 的三个用法边界很硬：

| 用法 | 行不行 | 原因 |
|---|---|---|
| 站点配置、主题开关 | 行 | 读极热、写极冷，典型 1:10000 |
| 限流计数器 | 行，但注意同 key 1 次/秒 | 免费版写 1000 次/天 |
| 会话存储 | 勉强 | 每次请求读一次，命中率看用户活跃度；写 560ms 意味着登录会明显卡 |
| 每次请求一个新 key 的缓存 | 不行 | 命中率 0，等于每次 265ms |
| 评论数、点赞数这种高频写 | 不行 | 560ms × 每次写，且免费版 1000 次/天 |

同 key 每秒只能写 1 次，这条限制在本地压测里很容易被忽略——我第一次测 KV 写入时就是同一个 key 连写 100 次，结果全是失败重试，白跑一轮。换成每次新 key 才测出上面那个数。

## 四、R2：76ms 的读，279ms 的写

| 操作 | p50 | p95 | max |
|---|---|---|---|
| HEAD（只查元信息） | 74.0ms | 92.4ms | 93.2ms |
| GET 1KB | 76.2ms | 87.0ms | 87.4ms |
| PUT 1KB | 279.2ms | 684.4ms | 684.4ms |

两个反直觉点：

**HEAD 和 GET 只差 2ms。** 说明 76ms 里几乎没有「传数据」的成本，全是往返和元数据查询。1KB 和 1MB 的 GET 在这个量级下不会有本质差别——这也是为什么 R2 适合存大文件：**小文件反而不划算**，你为每个小文件付了同样的 76ms。

**PUT 的 p95 是 p50 的 2.4 倍。** 写操作抖动最大，684ms 的尾部延迟意味着上传图片时必须异步、必须有重试。用户点「上传」后等 684ms 才拿到成功，体验上是能感知的卡顿。

本站的图片链路是：上传走 R2 直传（签名 URL，前端直连，不经过 Worker），读取走 `/img/` 代理 + 边缘缓存。这个设计现在有了数字支撑：

| 方案 | 单次成本 | 结论 |
|---|---|---|
| Worker 每次读 R2 再返回 | 76ms + 传输 | 每张图都付 76ms，首屏 5 张图 = 380ms |
| Worker 读 R2 + `cacheEverything` | 首次 76ms，之后边缘命中 | 只有冷启动付一次 |
| 上传走 Worker 中转 | 279ms（p95 684ms） | 大文件会撞 CPU 和请求体限制 |

## 五、选型：按延迟排，不按「产品定位」排

很多人选存储是看「D1 是数据库所以放数据、KV 是缓存所以放缓存、R2 是对象存储所以放文件」。这个顺序没错，但理由经常是错的。按实测延迟重排：

| 需求 | 该选 | 实测依据 |
|---|---|---|
| 亚毫秒、读极热写极冷、key 数量有限 | KV | 命中 3.6ms，比 D1 快 12 倍 |
| 有关系、要事务、要 JOIN、要聚合 | D1 | 44ms 固定成本，查询复杂度几乎免费 |
| 大文件、一次写多次读、出网免费 | R2 | 读 76ms 但按 GB 计费极便宜 |
| 高频写（计数、日志、状态机） | D1 | 写 43ms vs KV 560ms vs R2 279ms |
| 每次请求都是新 key 的缓存 | 别用 KV | 未命中 265ms，不如直接查 D1 |

一句话版本：**KV 和 D1 的延迟差 12 倍，但只有在 key 命中时才成立。选错存储的代价不是「慢一点」，是「慢 6 到 70 倍」。**

再补一条容易被忽略的：这三种存储的调用**都算 subrequest**。免费版一次调用 50 个，一个页面上 5 个 D1 查询 + 3 张图读 R2 = 8 个，看着宽裕，但如果你在循环里查数据库，50 很快就见底，而且报错是 `Too many subrequests`，不是你以为的数据库错误。

## 六、怎么自己验一遍

不需要我这份数据，你自己十分钟能跑出来。步骤：

1. 建一个临时 Worker，绑你现有的 D1、R2，再 `wrangler kv namespace create BENCH` 建一个 KV。
2. 把 `timeIt` 那段抄进去，注意必须是**5 次一组摊平**，不要单次测。
3. 加一个 `SELECT 1` 的对照组。没有对照组，你分不清 44ms 是查询贵还是往返贵。
4. 每个 target 打 3 轮，**丢掉第一轮**。第一轮含 isolate 冷启动，混进去 p95 会虚高。
5. 写完把 Worker 删掉、KV 命名空间删掉，别留着——它会一直吃你的免费额度。

完整的测量代码留在 `content/bench-data.md` 和 `bench/` 目录里，包括我踩过的两个坑：`performance.now()` 量化、KV 同 key 写限速。下次要复测，改一下 target 列表就能跑。
', 'log', 'D1 一切查询都是 44ms（连 SELECT 1 也是），KV 命中 3.6ms、未命中 265ms，R2 读比 D1 还慢。',
        '', 0, 0, 0, 1, '2027-01-13 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('d1') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-kv-r2-latency' AND t.name = 'd1';
INSERT INTO tags (name) VALUES ('r2') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-kv-r2-latency' AND t.name = 'r2';
INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-kv-r2-latency' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('workers') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-kv-r2-latency' AND t.name = 'workers';


INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('workers-blog-pillar', 'Cloudflare Workers 建站全流程', '## 结论

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
', 'site', '从域名到第一个 200，从 D1 到 R2，从 SSR 到三层缓存：这个站 20 篇的六段路径。',
        '', 0, 0, 0, 1, '2027-01-20 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'workers-blog-pillar' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('workers') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'workers-blog-pillar' AND t.name = 'workers';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'workers-blog-pillar' AND t.name = 'debugging';

