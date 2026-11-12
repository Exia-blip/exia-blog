## 结论

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
import jwt from 'jsonwebtoken';

const token = jwt.sign({ uid: 7, admin: 0, exp: Math.floor(Date.now() / 1000) - 30 }, 'lab-secret');

const [h, p, s] = token.split('.');
console.log('段数', token.split('.').length, '各段长度', h.length, p.length, s.length);
console.log('header ', Buffer.from(h, 'base64url').toString());
console.log('payload', Buffer.from(p, 'base64url').toString());
```

输出：

```text
段数 3 各段长度 36 71 43
header  {"alg":"HS256","typ":"JWT"}
payload {"uid":7,"admin":0,"exp":1794501998,"iat":1794502028}
```

三段加起来 152 个字符（含两个点），header 36、payload 71、签名 43。base64url 不是加密，它是编码，用 `Buffer.from(p, 'base64url')` 一行就还原了。浏览器的 DevTools、任何代理的日志、随手一个在线解码器，都能看到同样的内容。

改也不难。把 `admin` 改成 1、`exp` 改成明天，签名原封不动：

```js
const raw = JSON.parse(Buffer.from(p, 'base64url').toString());
raw.admin = 1;
raw.exp = Math.floor(Date.now() / 1000) + 86400;

const forged = `${h}.${Buffer.from(JSON.stringify(raw)).toString('base64url')}.${s}`;

jwt.verify(forged, 'lab-secret');   // 抛 JsonWebTokenError: invalid signature
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
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method;
  const user = await currentUser(env, request);   // 每个 /api/* 请求都过这里
```

`currentUser` 做的就是 `parseCookies` → `verifyToken` → 查 D1。所以从效果上看它接近"网关"：所有 `/api/*` 都过一遍，公开接口也不例外（`/api/site`、`/api/posts` 明明不需要登录，也照样验一次、查一次库）。代价是每个 API 请求多一次 D1 往返，收益是不存在"忘了给这个路由加认证"这种事。

页面层是另一套，而且它**只看 cookie 存不存在，不看内容**：

```js
// src/index.js:1461 —— 决定这页能不能进边缘缓存，不做鉴权
const cookie = request.headers.get('cookie') || '';
const loggedIn = /(^|;\s*)sid=/.test(cookie);
const cacheable = request.method === 'GET' && !loggedIn && isPagePath(url.pathname);
```

一个正则，匹配到 `sid=` 就算"登录了"，`exp` 过没过完全不参与。这行代码的本意是缓存旁路（带 cookie 的请求不缓存，避免串号），不是鉴权，所以它写错也不会造成越权——页面 HTML 里本来就不含用户数据。但它说明一件事：**"代码里出现了 cookie 判断"和"这里在校验过期"是两件不同的事**。我在读自己的代码时，第一眼就把这行当成了登录判断，看到 `loggedIn` 这个变量名，差点就跳过去了。

## 三、"验签通过"和"没过期"是两个判断

我见过最多的一种写法长这样：函数叫 `verify`，签名比得很认真，`exp` 就在解出来的对象里躺着，没人碰。

```js
// 反例：验签是对的，过期没人管
import crypto from 'node:crypto';

export function verify(secret, token) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return null;

  const want = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (s.length !== want.length) return null;                       // 长度不等时 timingSafeEqual 会抛
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;

  return JSON.parse(Buffer.from(p, 'base64url').toString());       // exp 就在里面，没人看
}
```

这段代码有一个很强的误导性：它确实"验了"，`timingSafeEqual` 用得也对，注释也写了为什么先比长度。review 的时候注意力全在签名上，`exp` 那个字段看起来像是"解出来自然就生效了"。

它不生效。`JSON.parse` 不做任何检查，它只是把 JSON 变成对象。这段函数对一枚 2019 年签发的 token 和一枚刚刚签发的 token，返回完全一样的结果。

改正版多了几行判断，顺序和判据都有讲究：

```js
// 正例：验签之后，显式比较 exp，判据是 now >= exp
const MAX_TTL = 60 * 60 * 24 * 30;   // 自己签发的最长有效期，30 天

export function verify(secret, token, now = Math.floor(Date.now() / 1000)) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return null;

  const want = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (s.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch {
    return null;                                     // payload 不是 JSON，别让异常冒到路由层
  }

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;  // 缺了、字符串、null 全拒
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
import jwt from 'jsonwebtoken';

try {
  // 允许两端钟差 60 秒：签发方慢 60 秒、校验方快 60 秒，都还能过
  const claims = jwt.verify(token, process.env.SESSION_SECRET, {
    clockTolerance: 60,
    algorithms: ['HS256'],       // 显式限定算法，别让 header 里的 alg 决定用什么验
  });
  return claims;
} catch (e) {
  if (e.name === 'TokenExpiredError') return null;   // 过期 -> 401
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

三行里有三个"通过"落在"没有 `exp`"这一列。这不是库的缺陷，是规范的直接后果：一个可选字段没写，校验方没有理由拒绝。`jsonwebtoken` 的源码里那段判断（`verify.js:185`）是 `typeof payload.exp !== 'undefined' && !options.ignoreExpiration`，进了这个 `if` 才比较；`exp` 不存在，整段跳过。

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
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;  // 缺、字符串、null、NaN
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
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': clearCookie(COOKIE) } });
}
```

浏览器会把 `sid` 删掉，但服务端没有记录任何"这枚 token 已作废"的信息。如果这枚 token 在登出前被复制过（比如贴在 curl 里、存在另一个浏览器里），它在剩下的 30 天里照样有效。这不是实现 bug，是无状态 token 的定义：**服务端从来没有"持有"过它，也就无从"收回"它**。想让登出真的登出，得在 D1 里存一个 `session_version`，签发时写进 payload，校验时比对——那就又回到查库了，而本站本来就在查。

## 七、本站没写 JWT，写了个两段式

翻到 `src/utils.js:59`，本站的会话 cookie 长这样：

```js
export async function signToken(secret, payload, ttlSec = 60 * 60 * 24 * 30) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64u(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(p));
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
const [p, s] = token.split('.');   // 三段 token 进来时，p 是 header，s 是 payload
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
import http from 'node:http';
import { verifyToken } from './src/utils.js';   // 换成你自己的校验函数

const SECRET = process.env.SESSION_SECRET || 'lab-secret';

http.createServer(async (req, res) => {
  const tk = (req.headers.authorization || '').replace(/^Bearer /, '')
    || (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1] || '';
  const claims = await verifyToken(SECRET, decodeURIComponent(tk));

  res.writeHead(claims ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(claims ? { ok: true, uid: claims.uid } : { ok: false, error: '未登录' }));
}).listen(8787, '127.0.0.1', () => console.log('http://127.0.0.1:8787'));
```

**第二步，造 token 并打过去。** 关键是五枚 token 除 `exp` 外完全一致，这样状态码的差异只能来自 `exp`：

```js
// forge.mjs —— 造五枚只有 exp 不同的 token，逐枚打接口
import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET || 'lab-secret';
const BASE = 'http://127.0.0.1:8787';
const b64u = (s) => Buffer.from(s).toString('base64url');
const now = Math.floor(Date.now() / 1000);

// 两段式，和本站 signToken 的输出格式一致
function mint(claims) {
  const p = b64u(JSON.stringify(claims));
  const sig = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return `${p}.${sig}`;
}

const cases = [
  ['正常，10 分钟后过期', { uid: 7, exp: now + 600 }],
  ['过期 30 秒',        { uid: 7, exp: now - 30 }],
  ['没有 exp',          { uid: 7 }],
  ['exp 写成毫秒',      { uid: 7, exp: Date.now() + 600_000 }],
  ['exp 正好是现在',    { uid: 7, exp: now }],
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
TOKEN='eyJ1aWQiOjcsImV4cCI6MTc5NDUwMTk3MH0.xxxxx'
curl -s -i http://127.0.0.1:8787/api/me -H "cookie: sid=$TOKEN"
# HTTP/1.1 401 Unauthorized
```

**第四步，把判据补上，重跑。** 改 `verifyToken` 里那一行：

```js
// 改前：缺 exp 直接跳过比较
if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;

// 改后：先证明 exp 合法，再放行
const now = Math.floor(Date.now() / 1000);
if (typeof data.exp !== 'number' || !Number.isFinite(data.exp)) return null;
if (data.exp <= now) return null;
if (data.exp > now + 60 * 60 * 24 * 30) return null;
```

重跑 `forge.mjs`，期望只剩第一枚 200，其余四枚全部 401。这一改会让所有"没有 `exp` 的老 token"立即失效。本站的 `signToken` 无条件写入 `exp`，翻遍 `src/` 也只有一处签发，所以存量 token 全都有 `exp`，影响范围是零；但如果你的站曾经有一段时间没写 `exp`，改之前先统计一下存量。

收尾留三个自查项，按能查到的概率排序：

1. **所有签发点是不是都传了 TTL。** `grep -rn "sign\|SignJWT" src/`，一个个看。签发点收敛到一个函数的话，这条两分钟能查完。
2. **校验函数对"缺 `exp`"返回什么。** 造一枚无 `exp` 的 token 打过去，200 就是洞。这一条比读代码可靠，因为 `data.exp &&` 这种写法读起来很像是"已经处理了"。
3. **`exp` 的判据是 `<` 还是 `<=`。** 和你的其他服务对齐，别让两个服务对同一秒给出相反答案。本站现在是 `<`（`exp == now` 放行），`jsonwebtoken` 和 `jose` 都是"相等即过期"，这处不一致我还没改：它只影响 `exp` 恰好等于当前那一秒的 token，等下次动 `auth.js` 时一起处理。记在这里，比假装没看见好。

#jwt #auth #protocol

相关：这篇讲「拿到 token 之后怎么被信任」。[《token 到手之后：过期、刷新、撤销分别归谁管》](/p/oauth-token-lifecycle)讲的是上游那一半——token 怎么来、什么时候该换；[《Authorization Code：为什么要绕一个 302》](/p/oauth-auth-code)是整条链路的起点。
