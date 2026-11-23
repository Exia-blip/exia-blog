## 结论

五步里，**四步在本站没有对应物，一步刚好命中一个真缺口**——但命中的那一步指的不是材料以为的地方。

材料第 2 步说「评论和登录分开两个桶，评论被刷不连累登录」。这句话本身是对的。问题是本站评论早就有三层闸门（蜜罐 / D1 限额 / Turnstile），而**登录一个桶都没有**。`/auth/github` 和 `/auth/callback` 全裸，一直如此。

| 材料步骤 | 本站实际情况 |
|---|---|
| 1. 加 `[[ratelimits]]` 三个 binding | 没有 Hono，没有这个 binding。上一轮已核过：它**按 colo 计数**、官方文档自己写着「Requests can exceed this threshold」。不加 |
| 2. 限流中间件 | **命中，但目标错位**。评论有三层闸门，缺的是登录——材料把它当成「要防守的那一端」 |
| 3. 缓存抽象（`/api/tags`、`/api/archive`） | 当时我判成「这两个接口不存在」，**判错了**：两者都在（`api.js:703/708`）。但用处与材料想的相反——`/api/archive` 是冷路径（SSR 已把数据注入 `window.__ARCH__`），`/api/tags` 是热路径（`/categories` 是静态壳）。详见下一篇 |
| 4. 缓存中间件挂只读接口 | 同上，没有可挂的接口 |
| 5. 失效挂在写入路径上 | 早已在做（`bustPaths`）。上一轮刚抓过漏传栏目维度（P-031） |

真正落地的只有一步，而且落点比材料说的更小、更要紧。

## 那行 fail closed，其实是 fail open

```ts
if (failClosed && c.env.ENVIRONMENT === 'production') {
  return c.json({ error: 'Service temporarily unavailable' }, 503);
}
return next();   // 本地 dev 放行
```

这段的意图是「生产环境绑定缺失就 503，别裸奔」。但判据是 `ENVIRONMENT === 'production'`。**本站没有 `ENVIRONMENT` 这个变量**——`wrangler.jsonc` 里只有 `SITE_*`、`GITHUB_CLIENT_ID`、`R2_PUBLIC_BASE` 几个。

照抄过来，`undefined === 'production'` 恒为 `false`，于是永远走到 `return next()`。**「fail closed」写成了「除非某个变量恰好等于 production 才 fail closed」，而那个变量不存在。**

这不是本站独有的问题，是所有「靠一个可能没配的开关决定安全行为」的写法的通病。正确方向是反过来：**默认 fail closed，只有显式声明 dev 才放行**。缺配置时宁可 503，也不要静默放行。

本站没有这个问题——不是因为写对了，是因为本站的限流是 D1 查询，没有「binding 缺失」这个状态。但这一条值得记下来，因为它是同一类错误的原型。

## 真正缺的：登录是全站唯一能打出站请求的入口

把全站入口按「能不能被外部触发对外请求」排一遍：

| 入口 | 外部可触发 | 出站请求 | 原有闸门 |
|---|---|---|---|
| 评论 `/api/comments` | 是 | Turnstile siteverify（1 次） | 蜜罐 + D1 限额 + Turnstile |
| 图片 `/img/*` | 是 | **0 次**（只读 R2） | — |
| 友链巡检 | **否**（只有 cron） | 最多 40 次 | 网段黑名单 + 5 跳上限 |
| `/auth/github` | 是 | **0 次**（纯 302） | **无** |
| `/auth/callback` | 是 | **1~3 次**（token 交换、`/user`、`/user/emails`） | **无** |

评论那一行是全站成本最高、防守最厚的；登录这一行成本也不低，但闸门是空的。

两种滥用路径：

1. **刷 `/auth/github`**：每次都是一次 302 到 GitHub 授权页，带着本站的 `client_id`。刷到 GitHub 对本站触发滥用限流，**真实用户就登不进来了**。成本全落在 GitHub，本站一分钱不花。
2. **刷 `/auth/callback`**：`state` 校验只挡「没先走 `/auth/github`」的人——愿意先走一遍的脚本挡不住。过了 state 校验，每次调用都是 1~3 次出站 `fetch`。用无效 code 打，本站照样发出 token 交换请求。

第 2 条还藏着一个更细的问题：如果按评论那套「落库成功才计数」来写登录限流，**失败尝试永远不占额度**，无效 code 可以无限刷。所以登录的计数时机必须和评论相反。

## 实现：零迁移，复用 `comment_guard`

`comment_guard` 的主键是文本 `k`，评论用的是 `ip:1.2.3.4` 和 `dev:<uuid>`。登录用 `auth:ip:1.2.3.4`，同一个表、不同前缀，**不需要新迁移**。`banIp()` 只写 `ip:` 前缀，两套额度不会互相污染。

```js
const LOGIN_KEY = (ip) => `auth:ip:${ip || 'unknown'}`;
export const LOGIN_DAY_MAX = 60;

export async function guardLogin(db, request, nowSec) {
  const ip = clientIp(request);
  const rec = await db
    .prepare('SELECT k, day, hits, last_ts, banned FROM comment_guard WHERE k = ?')
    .bind(LOGIN_KEY(ip))
    .first();
  return { ...judge(rec, nowSec, { dayMax: LOGIN_DAY_MAX, checkGap: false }), ip };
}
```

`judge()` 是评论那套纯函数，直接复用。两个参数需要按登录场景调整：

- **`checkGap: false`**：不做「相邻 60 秒」限制。登录重试是正常行为——输错、清 Cookie、换域名、授权页停留超时，卡 60 秒间隔会误伤真人。
- **`dayMax: 60`**：日上限。`/auth/github` 和回调各记一次，一次完整登录消耗 2 次额度，实际是每天 30 次登录。挡的不是「猜 code」（GitHub 的 code 一次性，猜不出来），是出站放大和 `client_id` 滥用。

计数时机：

```js
// loginRedirect：跨域 302 之后（那条只回主域，没打到 GitHub，不该计数）
const nowSec = Math.floor(Date.now() / 1000);
const lg = await guardLogin(env.DB, request, nowSec);
if (!lg.ok) return loginThrottled(lg);
await recordLogin(env.DB, lg.ip, nowSec);
```

```js
// handleCallback：state 校验之后、第一次 fetch 之前
const nowSec = Math.floor(Date.now() / 1000);
const lg = await guardLogin(env.DB, request, nowSec);
if (!lg.ok) return loginThrottled(lg);
await recordLogin(env.DB, lg.ip, nowSec);

const redirect = callbackUrl(env, request);
const tokenRes = await fetch('https://github.com/login/oauth/access_token', { … });
```

「state 校验之后」这一条很关键：没带 code、state 不对的请求在更早的地方就 return 了，它们连 GitHub 都没碰到，不该消耗额度。否则攻击者用垃圾请求就能把真人的额度耗尽——那是另一种拒绝服务。

## key 只能用 cf-connecting-ip，本站原来有一条回退

材料这句是对的，而且本站有一处真的踩了：

```js
// src/stats.js 旧写法
const ip = request.headers.get('cf-connecting-ip')
        || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
```

`x-forwarded-for` 是请求方自己写的头。用来做 UV 去重时，伪造它就能把同一个访客拆成无数个，访客数立刻虚高——不危险，但是假数据。用来做限流 key 时就更糟：每个请求换一个头，就是每个请求一个新桶，限流等于不存在。

线上不存在「拿不到 `cf-connecting-ip`」的情形（CF 边缘必注入），那条回退是纯死代码。现在统一成：

```js
export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || '';
}
```

拿不到就返回空串，由调用方落到 `unknown` 兜底桶，**绝不回退到任何请求头**。

## 为什么不接 `[[ratelimits]]`

三个理由，按重要性排：

1. **它是 per-colo 的软限**。官方文档在配置注释里写得很直白：`in a single Cloudflare location`、`Requests can exceed this threshold`。本站要的是「同一个 IP 每天 60 次」这个全局口径，不是「每个边缘节点 60 次」。
2. **多一套口径**。D1 已经在精确计数了，再叠一层近似计数，出问题时不知道该看哪个。上一轮的教训就是「同一判据复制两份必然漂移」。
3. **没有收益**。快的那点延迟，在登录这种一天几十次的路径上量不出来。

## 断言：十条，能测行为就不测文本

材料给的收口方式是：

```js
check('P-014', '限流 429 带 Retry-After', res429.headers.retry_after !== undefined);
check('P-015', 'key 用 cf-connecting-ip', !/x-forwarded-for/.test(limiterSrc));
check('P-016', '生产缺 binding 时 fail closed', /503/.test(limiterSrc));
check('P-017', '缓存命中带 X-Cache', /X-Cache/.test(resHit.headers));
```

三个问题：

- `P-014` 这个编号**已经被占了**（image key gate，`npm test` 里能看到 `[P-014] 4 passed`）。本站 PITFALLS 已经到 32 条，材料说的「和前 13 条同一套机制」落后了两轮。顺延为 `P-033`。
- `/503/.test(limiterSrc)` 是「源码里出现 503」——P-030 抓过的同一种假绿：判据只认字面，换个写法（比如用常量 `SERVICE_UNAVAILABLE`）就漏。
- `/X-Cache/.test(resHit.headers)` 更糟：`resHit.headers` 如果是 `Headers` 对象，`String()` 出来是 `[object Headers]`，**永远不含 `X-Cache`**。这条断言要么恒红，要么它的 `resHit` 根本不是真实响应。

我写的十条：

| ID | 判据 | 为什么这么做 |
|---|---|---|
| LG-01 | 两个入口函数体里都有 `guardLogin` / `recordLogin` / `loginThrottled` | 按函数体切片，不按全文——挂了一个漏了另一个是真实场景 |
| LG-02 | 回调里 `recordLogin` 的下标 < 第一次 `fetch` 的下标 | 顺序哨兵，同 P-019 |
| LG-03 | 登录 key 前缀 `auth:ip:`，不等于评论的 `ip:` | 真跑 `guardLogin`，用假 D1 抓 `bind` 参数 |
| LG-04 | 全站没有真正去读 `x-forwarded-for` | 只认 `.get('x-forwarded-for')` 和 `['x-forwarded-for']` 两种写法，裸词不误伤注释 |
| LG-05 | 带上伪造的 XFF，桶仍由 `cf-connecting-ip` 决定；没有它时落 `unknown` | 行为级证明「XFF 绕不过去」 |
| LG-06 | 日上限恰好 60：到顶拒、差一次放 | 边界，防 off-by-one |
| LG-07 | 换天（UTC+8）额度归零 | `judge` 的 `day` 比较 |
| LG-08 | `recordLogin` 是 `ON CONFLICT DO UPDATE` 原子累加 | 防有人改回 check-then-act |
| LG-09 | `banned=1` 的 IP 走登录限流一样被拒 | 封禁对登录也生效 |
| LG-10 | 429 出口同时返回 `retry-after` | 这条确实是文本判据，但它测的是「同一个出口函数里两件事都要有」，可接受 |

三处注入验证：

| 注入 | 结果 |
|---|---|
| 删掉 `loginRedirect` 里的限流三行 | `LG-01` 红：`loginRedirect 没接 guardLogin` |
| 把 `recordLogin` 挪到 token 交换之后 | `LG-02` 红：`recordLogin 在第一次 fetch 之后（… > …）—— 无效 code 可以无限刷出站请求` |
| 把 `stats.js` 的 XFF 回退加回去 | `LG-04` 红并报 `stats.js:40` |

## 两条没照抄的

**「文章 HTML 走 `Cache-Control: no-store` 或 `private`，因为它带 nonce」**——这条会让本站放弃**全部**边缘缓存。

本站首页和文章页确实带每响应重生成的 nonce，也确实进共享缓存（`s-maxage=300` + `swr=86400`）。这两件事能并存，是因为可缓存的那批页面上**没有任何反射面**：`/tag/<script>` 这类路径 404 且零回显，`/` 与文章页的 nonce 只用于本站自己的内联脚本。前几轮逐条验过。

改成 `no-store` 等于每次访问都回源。本站的首页 HTML 是 33–53KB，压过之后仍有 8–19KB，每一次回源都是 Worker 的 CPU 时间。这一个改动就能把站点打回「每页都跑一遍 SSR」的状态——那才是真正该避免的。

**`kvCache(env.SESSION)`**——本站没有 KV binding，`SESSION` 也不是缓存的用途（那是会话密钥）。这个函数材料全文没定义过，只在调用处出现一次。

## 闭环

| 文件 | 改动 |
|---|---|
| `src/utils.js` | 新增 `clientIp()`，唯一 IP 取法 |
| `src/antispam.js` | 新增 `guardLogin` / `recordLogin` / `LOGIN_DAY_MAX`，复用 `comment_guard` |
| `src/auth.js` | `loginRedirect` 与 `handleCallback` 各接一道限流；`noticePage` 支持自定义状态码；`loginThrottled()` 统一 429 出口 |
| `src/stats.js` | 删掉 `x-forwarded-for` 回退 |
| `scripts/test-login-guard.mjs` | 新增，LG-01~10 |
| `package.json` | `test` 串接新断言 |
| `PITFALLS.md` | 新增 P-033 |

`npm test` 全绿，PITFALLS 对账 33 条。

**没做的**：没加 `[[ratelimits]]` binding（`wrangler.jsonc` 没动）；没引 Hono；`package.json` 的 `dependencies` 仍然是空的；没改文章页缓存策略；没建 KV；没重测首屏基线。`check-live` 那四条仍然红，因为本轮同样没部署。
