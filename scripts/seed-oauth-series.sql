-- OAuth 四篇系列：拆成独立篇目 + series 归属，互相内链靠正文链接与系列目录
-- 由 content/0*-oauth-*.md 生成，重跑会覆盖正文与摘要

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, created_at, updated_at)
VALUES ('oauth-auth-code', 'Authorization Code：为什么要绕一个 302 才把 token 给你', '## 结论

授权码流程存在的全部理由，可以压成一句话：**不让 token 经过浏览器**。

浏览器地址栏、历史记录、Referer 头、前端 JS、扩展、录屏、运维的代理日志——这些地方都能看到 URL 和页面内容。后端到后端那条连接，看不见。所以 OAuth 绕了个 302：令牌在后台换，浏览器只负责搬运一个一次性的 `code`。

还有一层不那么直观的：`code` 换 token 这一步同时也是**客户端身份验证**的场合。`code` 本身不携带「谁在请求」，token 端点靠 `client_id` + `client_secret` 判断。这就解释了为什么只要你去掉后端、把换 token 搬到前端，`client_secret` 就必然裸奔——也解释了 PKCE 是在补什么洞（见[第 2 篇](/p/oauth-pkce)）。

## 直接回 token 会怎样

历史上真有这个流程，叫 Implicit Flow：授权服务器把 `access_token` 直接拼在 `#` 后面 302 回来，前端从 `location.hash` 里读。

它有三个绕不过去的毛病：

1. **token 落在浏览器里**。历史记录、书签、截图、XSS 全都能拿到，而且它不是 Cookie，没有 `HttpOnly` 这种保护可用。
2. **不能刷新**。Implicit 拿不到 `refresh_token`，过期只能重新走一遍完整授权，用户要再看一次同意页。
3. **无法验证客户端**。谁拿到 URL 谁就有 token，服务器完全不知道请求方是谁。

OAuth 2.1 草案已经把 Implicit 删了。现在你看到的所有「网页登录」，都是授权码流程。

## 五步，以及每一步在防什么

| 步骤 | 谁在动 | 这一步挡住的东西 |
|---|---|---|
| 1. 跳 `/authorize?client_id&redirect_uri&scope&state` | 浏览器 | —— |
| 2. 校验 `redirect_uri` 是否与注册值完全一致 | 授权服务器 | 开放重定向，把 code 送到攻击者域名 |
| 3. 302 回 `redirect_uri?code=...&state=...` | 浏览器 | —— |
| 4. 后端 POST `/access_token`，带 code + secret + redirect_uri | 你的服务器 | 别人拿你的 code 换 token（没 secret 换不到） |
| 5. 拿 token，建自己的会话 | 你的服务器 | —— |

两个容易看漏的点：

**`redirect_uri` 会被校验两次。** 第 2 步一次，第 4 步再一次，且两次的值必须**完全相同**。第 4 步那次不是冗余——它防的是「攻击者拿到 code 后，去 token 端点声称这个 code 是发给另一个 redirect_uri 的」。这个校验失败的报错长这样：

```json
{
  "error": "redirect_uri_mismatch",
  "error_description": "The redirect_uri MUST match the registered callback URL for this application."
}
```

我在换域名时踩过这条。GitHub 做的是**逐字比较**，末尾多一个斜杠都算不同：

```
https://exia.de5.net/auth/callback    ✓
https://exia.de5.net/auth/callback/   ✗
```

**`code` 是一次性的。** GitHub 10 分钟，Google 也是 10 分钟量级。RFC 6749 §4.1.2 建议：检测到同一个 code 被使用第二次时，把第一次换出来的 token 一起撤销。所以换 token 失败**不要重试**——第二次必定失败，还可能连第一次的成功也一起废掉。要重试就从头走授权。

## `state` 到底防什么

大部分文章写「防 CSRF」，但没说清楚是哪种 CSRF。具体的攻击是这样：

1. 攻击者用自己的账号正常走一遍授权，在自己的浏览器里拦下回调，拿到 `code`。
2. 他把这个 `code` 拼成 `https://yoursite.com/auth/callback?code=<攻击者的 code>`，发给受害者。
3. 受害者点开。站点拿这个 code 换到了**攻击者**的 token，把受害者登录成攻击者的账号。
4. 受害者毫不知情，开始往「自己」账号里存东西——私密文章、草稿、绑定的东西。攻击者回头登录就能全看见。

这叫 login CSRF，危害常被低估，因为受害者不会有任何报错提示。

`state` 的作用就一句：**这个 code 必须是我为这个浏览器发起的**。对不上就拒绝。

本站的实现（`src/auth.js`）：

```js
const state = crypto.randomUUID();

const headers = new Headers({ location: gh.toString() });
headers.append(''set-cookie'', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
```

回调时对比：

```js
const expect = parseCookies(request).oauth_state;
if (!state || state !== expect) {
  return noticePage(''登录状态已失效'', ''浏览器里没有找到这次登录的临时凭据…'');
}
```

四个属性都有理由，改一个就会漏：

- `HttpOnly` —— 前端 JS 读不到，XSS 也偷不走。**别把 state 塞 localStorage**，那等于把它交给页面上任何一段脚本。
- `SameSite=Lax` —— 不能用 `Strict`。OAuth 回调是从 GitHub 域发起的顶层 GET 跳转，`Strict` 下浏览器不会带 Cookie，用户会 100% 看到「登录状态已失效」。`Lax` 恰好放行顶层 GET 导航、拦掉跨站 POST。
- `Max-Age=600` —— 与 code 的寿命对齐。用户在授权页挂 10 分钟以上，code 早就废了，state 留着也没有意义。
- `Secure` —— 没有它，任何一次明文 HTTP 请求都会把 state 一起发出去。

用完立刻置空：

```js
headers.append(''set-cookie'', ''oauth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'');
```

## 本站的真实流程，和一个阴间 bug

完整链路（线上跑的）：

```
GET /auth/github
  → 302 https://github.com/login/oauth/authorize
        ?client_id=...&redirect_uri=https://exia.de5.net/auth/callback&state=<uuid>
  → 用户授权
  → 302 回 /auth/callback?code=...&state=<uuid>
  → 校验 state → POST /login/oauth/access_token（带 client_secret）→ 拿到 token
  → GET /user 拿资料 → 写 session Cookie → 302 回原页面
```

`redirect_uri` 不是从请求里拼的，而是从配置推出来的：

```js
function resolveOrigin(env, request) {
  const reqOrigin = new URL(request.url).origin;
  const raw = String(env.SITE_ORIGIN || '''').trim();
  if (!raw) return reqOrigin;
  return new URL(raw.replace(/\/+$/, '''')).origin;
}

export function callbackUrl(env, request) {
  return `${resolveOrigin(env, request)}/auth/callback`;
}
```

为什么不直接用 `new URL(request.url).origin`？因为这个 Worker 同时挂在 `exia.de5.net` 和 `xxx.workers.dev` 上。从 workers.dev 进来时，如果按请求 origin 拼，`redirect_uri` 变成 `https://xxx.workers.dev/auth/callback`——大概率不在注册列表里，直接 400。

**更阴的是它能成功的情况。** 如果你把两个域名都注册了回调，登录看上去成功了，但 session Cookie 落在了 `xxx.workers.dev` 上。跳回 `exia.de5.net` 时，那个域名下没有 Cookie，表现是「已经登录了，但后台还是让我登录」。第二次、第三次都一样，因为它每次都在错的那个域名上循环。

所以入口处加了一层强制归位：

```js
if (url.origin !== origin) {
  return new Response(null, { status: 302, headers: { location: new URL(''/auth/github'', origin).toString() } });
}
```

先用 302 把用户送回主域，再开始 OAuth。Cookie 只会在一个 host 上产生。

这条经验可以一般化：**任何「登录后还是未登录」的问题，先看 Cookie 落在哪个 host 上**，而不是先查 session 逻辑。

## 一个收尾细节：邮箱可能是 null

`GET /user` 返回的 `email` 经常是 `null`——用户开了邮箱隐私。要再查一次 `/user/emails`：

```js
let ghEmail = ghUser.email || '''';
if (!ghEmail) {
  const arr = await fetch(''https://api.github.com/user/emails'', { headers }).then((r) => r.json());
  ghEmail = (arr.find((e) => e.primary && e.verified) || arr.find((e) => e.verified) || arr[0])?.email || '''';
}
```

前提是 scope 里有 `user:email`。本站用的 scope 是：

```
read:user user:email
```

只申请这两个。OAuth 的 scope 是「用户看到你要什么权限」的唯一凭据，多要一个 `repo`，同意率就掉一截，而且你根本用不上。

## 下一篇

授权码流程有个前提：**客户端能收到回调**。SPA 和移动 App 收到回调的方式不太可靠——`code` 会在路上被人截走。PKCE 就是为这一段准备的：[PKCE 补的是哪个洞](/p/oauth-pkce)。

如果连浏览器和回调都不存在，就该换第三种流程了：[Device Flow](/p/oauth-device-flow)。

#oauth #http #security', '', 'teardown', 'OAuth 授权流程拆解', 1,
        0, 0, '授权码流程的全部理由是让 token 不经过浏览器。拆开五步里每一步防的东西、state 防的是哪种 login CSRF、redirect_uri 为什么必须逐字一致，以及本站踩过的「登录了但后台还是未登录」的 cookie 落域问题。', 'manual', '', 1, '2026-11-08 14:41:28', '2026-11-08 14:41:28')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  series = excluded.series, series_order = excluded.series_order,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('oauth');
INSERT OR IGNORE INTO tags (name) VALUES ('http');
INSERT OR IGNORE INTO tags (name) VALUES ('security');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'oauth-auth-code');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('oauth','http','security') WHERE p.slug = 'oauth-auth-code';

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, created_at, updated_at)
VALUES ('oauth-pkce', 'PKCE 补的是哪个洞：code 在回调路上被截走', '## 结论

PKCE 补的洞只有一个：**`code` 在从授权服务器回到客户端的路上被同一台设备上的另一个程序截走**。

它不防钓鱼，不替代 `state`，也不管 token 落到客户端之后怎么存。只保护「code 传递」这一段——但只要你的客户端是 SPA 或移动 App，这一段是整个流程里最脆的地方。

## 攻击模型：谁在抢你的 code

前提得成立：**同一台设备上存在另一个恶意程序**。

Android 上，任何 App 都可以在 manifest 里声明 `myapp://callback`，系统不校验唯一性。两个 App 声明同一个 scheme 时，回调可能落到任何一个，甚至弹一个「用哪个应用打开」的选择器——用户多半会点第一个。

iOS 的 Universal Links 好一些（要域名验证），但旧式的自定义 scheme 一样能抢。

于是攻击长这样：

1. 受害者的 App 发起授权，`redirect_uri = myapp://callback`
2. 攻击 App 也注册了 `myapp://callback`，并且抢到了这次回调
3. 攻击者拿到 `code`
4. **但攻击者没有 `client_secret`**——公共客户端本来就没有秘密

第 4 步是原来 OAuth 安全模型里的死结。「code 只能被发放它的客户端使用」这个规则，靠什么证明「我是那个客户端」？机密客户端用 secret 证明，公共客户端什么都拿不出来。

所以 2015 年之前，移动端的做法是把 secret 硬编码进 App——反编译一次就泄漏，所有人都知道这是假的。

PKCE 换了个思路：**不去证明「我是谁」，而是证明「这个 code 是发给我的这次会话的」**。

## 机制：一个只有发起者知道的随机数

发起授权前，客户端生成一个随机串：

```
code_verifier  = 43~128 个字符，取自 [A-Z a-z 0-9 - . _ ~]
```

算出它的 SHA-256，Base64URL 编码：

```
code_challenge = BASE64URL(SHA256(code_verifier))
```

授权请求带 `code_challenge`，**不带** `code_verifier`：

```
GET /authorize?client_id=...&redirect_uri=myapp://callback
    &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    &code_challenge_method=S256
    &state=...
```

换 token 时带 `code_verifier`：

```
POST /token
    code=...
    code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

服务器自己算一遍 SHA-256，和存档的 `code_challenge` 比。对上了才发 token。

攻击者手里只有 `code`。他没有 verifier，`SHA256(x)` 是不可逆的，猜不出来。`code` 从此变成废纸。

关键点：**`code_verifier` 从头到尾没有离开过客户端**。它不经过浏览器地址栏、不经过回调、不经过任何网络跳转。攻击者能截到 code，截不到 verifier。

## `plain` 为什么基本等于没有

`code_challenge_method` 有两种取值：

| 方法 | challenge 的值 | 实际防护 |
|---|---|---|
| `S256` | `BASE64URL(SHA256(verifier))` | 有效 |
| `plain` | 直接就是 verifier 本身 | 授权请求被看到就全废 |

`plain` 只防「回调被截」，不防「授权请求被截」。而授权请求是浏览器地址栏里的明文 GET，会进历史记录、Referer、代理日志。用 `plain`，等于把 verifier 写在信封外面寄出去。

OAuth 2.1 草案只允许 `S256`。看到某个库默认 `plain`，那是个需要改的默认值。

## 它不解决的问题

这一段多数介绍文章会跳过，但它决定了你该不该对它放心。

**1. 不防钓鱼。** 用户在假授权页输入的密码照样被偷。PKCE 全程不碰密码。

**2. 不防「恶意 App 自己发起一次授权」。** 攻击 App 完全可以自己走完整流程，骗用户点同意——那是合法流程，PKCE 拦不住。这和 [Device Flow 的短码钓鱼](/p/oauth-device-flow) 是同一个结构：真正的防线是授权页上那行「XX 应用正在申请 XX 权限」，以及用户有没有看。

**3. 不替代 `state`。** 两者防的完全是两件事：

| | 防什么 | 攻击者手里有什么 |
|---|---|---|
| `state` | 别人把**他的** code 塞给你 | 他自己的有效 code |
| PKCE | 别人把你的 code **拿走** | 你的 code，没有 verifier |

一个防「塞进来」，一个防「拿出去」。两个都要有。只有 PKCE 没有 `state`，login CSRF 照样成立（见[第 1 篇](/p/oauth-auth-code)）。

**4. 不保护 token 落地之后。** token 拿到手，还是明文存在客户端内存/磁盘里。这一段要靠操作系统的 keychain，或者干脆别存（[第 4 篇](/p/oauth-token-lifecycle)）。

## 后端网站要不要上

成本是一次 SHA-256。收益：即使 `client_secret` 因为日志泄漏、仓库误提交、CI 变量被打出来而暴露，攻击者没有 verifier 也换不到 code。

本站**没有上 PKCE**，这是有意的取舍，边界写清楚：

- `client_secret` 存在 Cloudflare Worker secret 里，不进代码、不进仓库
- `redirect_uri` 是写死的 `https://exia.de5.net/auth/callback`，不接受参数
- `code` 只经过一次 HTTPS 的服务端跳转，中途不落任何可读的地方

在这三个前提下，PKCE 的边际收益接近零。但只要你的场景变成「secret 在前端」「redirect_uri 可变」「code 会经过第三方页面」，结论立刻反过来。

## 在 Worker 里实现（WebCrypto）

```js
function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '''';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, ''-'').replace(/\//g, ''_'').replace(/=+$/, '''');
}

async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest(''SHA-256'', new TextEncoder().encode(verifier));
  return b64url(digest);
}

function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64url(bytes); // 43 字符，落在 RFC 允许区间内
}
```

三个坑：

- **别用 `String.fromCharCode(...new Uint8Array(buf))` 的展开写法**处理任意长度的缓冲，几万字节就会 `Maximum call stack size exceeded`。SHA-256 输出固定 32 字节没事，但这段代码通常会被复制到别处用。上面用循环。
- **Base64URL 不是 Base64**。`+`→`-`、`/`→`_`、去掉 `=`。少做一步，服务器算出来的 challenge 就对不上，报错是含糊的 `invalid_grant`。
- **verifier 要存在本次会话里**，不能存进 cookie 发给浏览器再收回来——那等于把它也送上了马路。CLI/桌面存内存，SPA 存 `sessionStorage`（关标签页就没，比 `localStorage` 好）。

## 什么时候必须用

| 客户端形态 | 建议 | 理由 |
|---|---|---|
| 移动 App | 必须 | 自定义 scheme 可被抢注，secret 无处可藏 |
| SPA | 必须 | 无后端，换 token 只能在前端做 |
| 桌面 App | 用 Device Flow 更好 | 见[第 3 篇](/p/oauth-device-flow)，连 scheme 都不用注册 |
| CLI | 不适用 | 没有浏览器，走 Device Flow |
| 有后端的网站 | 可选 | secret 不泄漏时收益极低，但上了不亏 |

一行判断：**只要 `client_secret` 有可能出现在用户设备上，就必须上 PKCE**。

## 下一篇

`state` 和 PKCE 都建立在同一个假设上：客户端能收到回调。有一类设备连这个前提都不成立——没有浏览器，或者有浏览器但起不了 HTTP 服务。那是第三种流程：[Device Flow 怎么在不配回调域名的情况下完成登录](/p/oauth-device-flow)。

#oauth #security #http', '', 'teardown', 'OAuth 授权流程拆解', 2,
        0, 0, 'PKCE 只保护 code 从授权服务器回到客户端这一段，机制是一个不离开客户端的 code_verifier。写清它防什么、plain 为什么等于没有、它不替代 state 也不防钓鱼，以及什么条件下可以不上。', 'manual', '', 1, '2026-11-08 14:41:28', '2026-11-08 14:41:28')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  series = excluded.series, series_order = excluded.series_order,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('oauth');
INSERT OR IGNORE INTO tags (name) VALUES ('security');
INSERT OR IGNORE INTO tags (name) VALUES ('http');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'oauth-pkce');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('oauth','security','http') WHERE p.slug = 'oauth-pkce';

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, created_at, updated_at)
VALUES ('oauth-device-flow', 'OAuth Device Flow 是怎么在不配回调域名的情况下完成登录的', '## 结论

Device Flow 把「浏览器跳回来」换成了「用户手抄一个短码」，所以客户端**不需要可被公众访问的回调地址**，也不需要 `client_secret`。授权结果不是被重定向送回来的，而是客户端拿着 `device_code` 主动去轮询拿的。

这一条差异，决定了它能在 CLI、电视、路由器后台、没有本地 HTTP 服务的桌面应用里跑通——这些场景里，「回调地址」根本不存在。

## 先看清三种流程的分界

| 流程 | 谁来接收授权结果 | 需要回调地址 | 需要 client_secret | 典型场景 |
|---|---|---|---|---|
| Authorization Code | 浏览器重定向到 `redirect_uri` | 要，且必须公网可达 | 要（Web 后端换 token） | 普通网站登录 |
| Authorization Code + PKCE | 同上，但用 `code_verifier` 替代 secret | 要，可用自定义 scheme | 不要 | 移动 App / SPA |
| Device Flow | 客户端轮询 | **不要** | 不要 | CLI、TV、无浏览器设备 |

前两种的隐含前提是：授权服务器能把结果**推**给客户端。Device Flow 把方向反过来——客户端自己**拉**。

前两种的细节分别在[第 1 篇](/p/oauth-auth-code)和[第 2 篇](/p/oauth-pkce)里拆过：它们的分歧只在「用 secret 还是用 verifier 证明身份」，共同点都是**必须有一个能收到回调的地址**。这一篇讲的是这个共同点不成立时怎么办。

## Device Flow 的五步

以 GitHub 为例，端点是真的，字段名也是真的。

**第一步：申请设备码**

```bash
curl -X POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "scope=read:user"
```

返回：

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

注意 `verification_uri` 是**授权服务器自己的地址**，不是你的回调地址。这就是它不需要回调域名的原因：用户从头到尾都在 GitHub 的地盘上操作。

**第二步：把 `user_code` 和 `verification_uri` 展示给用户**

CLI 里通常是这么一行：

```
请在浏览器打开 https://github.com/login/device
并输入代码：WDJB-MJHT
```

**第三步：用户在自己设备上打开、输入、点授权**

这一步完全脱离你的客户端。你的程序此时只是挂在那里。

**第四步：客户端按 `interval` 轮询**

```bash
curl -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "device_code=3584d83530557fdd1f46af8289938c8ef79f9dc5" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code"
```

用户还没点授权时，返回的是 200 加一个错误字段：

```json
{ "error": "authorization_pending" }
```

**第五步：拿到 token**

```json
{ "access_token": "gho_xxxxxxxx", "token_type": "bearer", "scope": "read:user" }
```

轮询期间会遇到的几个错误码，含义和应对方式不一样，别一律当失败处理：

| error | 含义 | 该怎么办 |
|---|---|---|
| `authorization_pending` | 用户还没操作 | 继续按 interval 轮询 |
| `slow_down` | 轮得太快 | interval 增加 5 秒，**不要**重试原频率 |
| `expired_token` | 设备码过期（GitHub 是 900 秒） | 回到第一步，重新申请 |
| `access_denied` | 用户点了拒绝 | 停止，提示用户 |
| `incorrect_device_code` | 码不对或已用过 | 回到第一步 |

`slow_down` 是 RFC 8628 里明确规定的：收到它之后必须把间隔加 5 秒。忽略这条的客户端会被授权服务器直接拉黑。

## 机制上的关键：`user_code` 是怎么把两边对上的

这是整个流程里最容易被忽略的一环。

- `device_code`：长、随机、只在你和授权服务器之间流转，**永远不给人看**。
- `user_code`：短、可读、给人看，用户把它输进浏览器。

授权服务器内部维护一张映射：`user_code → 待授权的 device_code`。用户在浏览器里授权的是那个 `user_code`，服务器把授权结果写到对应的 `device_code` 记录上。客户端下一次轮询时，拿 `device_code` 一问，就能取到自己那份 token。

于是「两边」通过服务器上的这张表对接，客户端和浏览器之间没有任何直接通信，也就不需要回调地址——这也是它能穿过 NAT、穿透公司防火墙的原因。

## 本站用的是 Authorization Code，不是 Device Flow

说清楚一点，免得看完上面以为这个博客的登录是 Device Flow。

本站的登录走的是标准 Authorization Code：

```
GET /auth/github
  → 302 到 https://github.com/login/oauth/authorize
         ?client_id=...&redirect_uri=https://exia.de5.net/auth/callback&state=<随机值>
  → 用户授权
  → 302 回 /auth/callback?code=...&state=<同一个值>
  → 校验 state → POST /login/oauth/access_token 换 token → 写 session cookie
```

`redirect_uri` 在 GitHub App 里注册过，站点域名固定、HTTPS 可用，所以完全没有理由绕到 Device Flow 去。浏览器场景下，Authorization Code 少一步手抄、体验更好，`state` 还能顺手防 CSRF。

Device Flow 是给「没有浏览器」的场景准备的。硬要在网页上用，等于让用户从浏览器跳到另一个页面抄一串码再回来，纯属找罪受。

## 什么时候才该用它

- **CLI 工具**：`gh auth login` 就是这条路，本机起不了公网 HTTP 服务。
- **电视 / 车机 / 物联网设备**：输入法都难用。
- **桌面应用**：不想为每个平台注册自定义 scheme，也不想内嵌 WebView 抓回调。
- **临时脚本**：不想为了跑一次脚本去注册回调地址。

反过来说，只要你的运行环境有浏览器、域名可配，就别用。

## 它的安全边界

Device Flow 不是「更安全的 OAuth」，它是**在无法回调的前提下，把风险重新分配**的方案。

1. **短码可被钓鱼**：攻击者申请一个 `device_code`，把 `user_code` 发给受害者，骗他去 GitHub 输入并授权。受害者以为在登录自己的账号，实际授权的是攻击者的设备。防护只能靠授权页面始终显示「哪个应用在请求什么权限」，以及用户自己看清。这也是 Device Flow 通常只允许低风险 scope 的原因。
2. **轮询是天然的资源消耗点**：授权服务器必须对它做限流，`slow_down` 就是限流信号本身。
3. **token 直接落到客户端**：没有后端做中转，客户端一旦不可信，token 就是裸的。桌面/CLI 场景能接受，因为它本来就在用户自己的机器上。
4. **`client_secret` 不参与**：公共客户端没有秘密可言，安全性全部押在「用户确实在自己的浏览器里点了授权」。

## 一份最小实现骨架

```js
async function deviceLogin({ clientId, scope }) {
  const start = await fetch(''https://github.com/login/device/code'', {
    method: ''POST'',
    headers: { accept: ''application/json'' },
    body: new URLSearchParams({ client_id: clientId, scope }),
  }).then((r) => r.json());

  console.log(`打开 ${start.verification_uri} ，输入 ${start.user_code}`);

  let interval = start.interval || 5;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch(''https://github.com/login/oauth/access_token'', {
      method: ''POST'',
      headers: { accept: ''application/json'' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: start.device_code,
        grant_type: ''urn:ietf:params:oauth:grant-type:device_code'',
      }),
    }).then((r) => r.json());

    if (res.access_token) return res.access_token;
    if (res.error === ''authorization_pending'') continue;
    if (res.error === ''slow_down'') { interval += 5; continue; }
    throw new Error(res.error || ''device flow failed'');
  }
  throw new Error(''expired_token'');
}
```

三件事别写错：`grant_type` 那一长串不能省；`slow_down` 要加间隔而不是重试；循环必须有 `expires_in` 兜底，否则用户不操作时这个进程会一直转。

## 一句话总结

Device Flow 的本质不是「另一种 OAuth」，而是**把回调这件事从网络层挪到了人身上**：用户抄一次码，客户端就不用被公网访问。理解了这一点，它该用在哪儿、代价是什么，也就清楚了。

三种流程讲完，「怎么拿到 token」这一半就结束了。另一半问题没人管：token 拿到之后活多久、什么时候失效、怎么撤销——各家答案都不一样，而且没有一个能靠猜：[token 到手之后：过期、刷新、撤销分别归谁管](/p/oauth-token-lifecycle)。

#oauth #http #workers', '', 'teardown', 'OAuth 授权流程拆解', 3,
        0, 0, 'Device Flow 把浏览器回调换成用户手抄短码、客户端主动轮询，因此不需要可公网访问的回调地址。拆开 user_code 与 device_code 的映射机制、GitHub 真实端点、五个错误码，以及本站为什么仍然用 Authorization Code。', 'manual', '', 1, '2026-11-08 14:41:28', '2026-11-08 14:41:28')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  series = excluded.series, series_order = excluded.series_order,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('oauth');
INSERT OR IGNORE INTO tags (name) VALUES ('http');
INSERT OR IGNORE INTO tags (name) VALUES ('workers');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'oauth-device-flow');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('oauth','http','workers') WHERE p.slug = 'oauth-device-flow';

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, created_at, updated_at)
VALUES ('oauth-token-lifecycle', 'token 到手之后：过期、刷新、撤销分别归谁管', '## 结论

OAuth 规范只定义「怎么拿到 token」，不定义「token 活多久」。过期、刷新、撤销全是各家授权服务器自己的策略，同一套代码换个提供方就可能整段失效。

所以这一段最容易出错的方式，不是写错代码，是**带上一个默认假设**：「token 总会自己过期」。这个假设在 GitHub 上直接不成立。

## 三个东西别混

| 名字 | 谁签发 | 存在哪 | 谁的凭据 |
|---|---|---|---|
| `access_token` | 授权服务器 | 客户端内存/磁盘 | 授权服务器认 |
| `refresh_token` | 授权服务器 | 客户端（尽量安全存储） | 授权服务器认 |
| 会话（session cookie） | 你自己的后端 | 浏览器 Cookie | 只有你认 |

前三者之间没有自动关系。最常见的错误是把 `access_token` 当成会话——直接塞进 Cookie 发给浏览器，于是每个请求都在裸奔一个第三方令牌，而且你还得为它处理过期、刷新、撤销一整套。

正确的分层是：**token 是你的后端用来「问授权服务器要资料」的临时凭据，会话是你给浏览器发的门票**。两者生命周期完全独立。本站的做法在第 5 节。

## 各家的过期策略差多远

| 提供方 | access token | refresh token | 备注 |
|---|---|---|---|
| GitHub OAuth App（旧，未开过期策略） | **永不过期** | 无 | 只能手动撤销，这是最大的坑 |
| GitHub OAuth App（开了 Expire user authorization tokens） | 8 小时 | 6 个月 | 关闭过期策略时 refresh 也是无效的 |
| GitHub App（user-to-server） | 8 小时 | 6 个月 | 每次刷新会轮换 |
| Google | 3600 秒 | 长期，但长期不用会被回收 | 刷新时通常不返回新 refresh token |
| 微软 Entra ID | 约 60~90 分钟 | 最长 90 天（滑动） | 具体值随租户策略变 |

GitHub 那一行值得单独说。**OAuth App 的 token 默认是不带过期的**——当年设计时没有 refresh token 机制，于是干脆不过期。这意味着：

- 一个 2019 年签发的 token，只要用户没去 `Settings → Applications` 撤销，今天依然有效
- 你把这串 token 误提交到公开仓库，它不是「过几小时就没事了」，是**一直有效，直到有人去撤**
- 你的「token 存在本地省得每次登录」的偷懒实现，会变成一个长期凭证

如果用的是新的 GitHub App 流程，才有 8 小时 + refresh 这套。两者别混着理解。

## 刷新：`refresh_token` 会被轮换

现代实现（OAuth 2.1、GitHub App、Google 的部分场景）在刷新时**返回一个新的 refresh token，并让旧的立即失效**。这叫 rotation。

配套还有一套重用检测：如果旧的那个被再次拿来用，授权服务器会认为它泄漏了，把**整个 token family**（这一串派生出来的所有 token）全部撤销。

对你的代码意味着两件事：

**1. 并发刷新会互相踩。** 两个请求同时发现 token 过期、同时去刷新：第一个成功，第二个拿旧 refresh token 去换，被判为重用 —— 整条链被撤销。现象是「偶发地被强制退出登录」，日志里看不出原因。

必须做单飞（single-flight）：

```js
let refreshing = null;

async function getToken() {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  // 同一个 tick 里所有调用者共享同一次刷新
  refreshing ||= doRefresh()
    .then((t) => (cached = t))
    .finally(() => { refreshing = null; });

  return (await refreshing).token;
}
```

`expiresAt - 60_000` 那 60 秒是提前量：别等它真的过期再刷，一个跨洋请求的往返就能吃掉几秒。

**2. 刷新失败不能当普通错误处理。** `invalid_grant` 通常意味着 refresh token 已经被撤销或轮换过——这时候重试没有意义，唯一正确的动作是清掉本地凭据，让用户重新授权。

## 撤销：端点长什么样

撤销不是「删掉本地的 token」，那只是让本地忘记。服务端那份还在有效期内。

GitHub 的撤销：

```bash
curl -X DELETE https://api.github.com/applications/{client_id}/token \
  -u "{client_id}:{client_secret}" \
  -d ''{"access_token":"gho_xxxxxxxx"}''
```

三个容易写错的地方：

- 方法是 **DELETE**，不是 POST
- 认证是 **Basic**（`client_id:client_secret`，Base64），不是 Bearer
- `access_token` 放在 **body** 的 JSON 里，不是 URL 路径

如果你的应用有「退出登录」按钮，语义上应该分两步：撤销第三方 token → 清自己的会话。只做第二步，用户以为退出了，实际上第三方那边还挂着一个有效授权。

## 本站的选择：不存 token

登录流程走到最后，本站做了一件很干脆的事——**把 GitHub 的 token 丢掉**。

```js
// 用 token 换一次用户资料
const ghUser = await fetch(''https://api.github.com/user'', {
  headers: { authorization: `Bearer ${accessToken}` },
}).then((r) => r.json());

// 然后本地签一个 30 天的会话票据
const token = await signToken(env.SESSION_SECRET, { uid: user.id, admin: user.is_admin }, 60 * 60 * 24 * 30);
```

之后所有请求只认这个自签的 JWT（HS256），不再碰 GitHub API。

**换来的好处：**

- GitHub 那串 token 泄漏了也没用——我们根本没存，它随着那次请求结束就没了
- 不需要实现刷新逻辑，也就不会踩 rotation 的坑
- scope 只要 `read:user user:email` 就够，不需要任何长期权限

**付的代价，写清楚：**

- 30 天内改了权限、撤了管理员，本站不知道（要等会话过期或主动登出）
- 用户在 GitHub 那边撤销了授权，本站也不知道——我们不再调 GitHub API，没有任何渠道能发现
- 没法做「用 GitHub 头像实时同步」这类功能（头像是登录那一刻的快照）

对一个单人博客来说这个取舍是对的：**风险面从「长期第三方令牌」换成「自己签的 30 天票据」，前者泄漏等于 GitHub 账号被读，后者泄漏等于博客后台被写**。后者危害小、可撤销（换 `SESSION_SECRET` 全部作废）、且完全在我自己控制内。

如果你的应用需要长期代表用户调第三方 API（比如定时同步 GitHub 仓库），就不能这么干，必须存 token 并实现刷新。判断标准是：**登录之后还要不要再代表用户去访问第三方**。

## 收束：四种流程怎么选

系列前三篇分别拆了三种，加上服务端对服务端，一共四种。判断顺序如下：

```
客户端有浏览器吗？
├─ 没有 ──────────────────────→ Device Flow（第 3 篇）
└─ 有
   ├─ 能起 HTTP 服务接收回调吗？
   │  ├─ 能（有后端）──────────→ Authorization Code（第 1 篇）
   │  │                          └ 想再稳一点 → 加 PKCE
   │  └─ 不能（SPA / 移动 App）→ Authorization Code + PKCE（第 2 篇，必须）
   └─ 干脆没有用户参与 ────────→ Client Credentials
```

| 流程 | 需要回调地址 | 需要 secret | 需要人抄码 | 典型场景 |
|---|---|---|---|---|
| Authorization Code | 要，公网可达 | 要 | 不要 | 网站登录 |
| Authorization Code + PKCE | 要，可用自定义 scheme | 不要 | 不要 | SPA、移动 App |
| Device Flow | **不要** | 不要 | 要 | CLI、TV、无浏览器设备 |
| Client Credentials | 不要 | 要 | 不要 | 服务间调用，无用户 |

一个常被忽略的点：**Client Credentials 没有「用户」**。它拿到的 token 代表应用自己，不是某个人。拿它去调 `/user` 这类端点必然失败。看到「我的机器人在调用户接口 401」，先查是不是用错了 grant type。

## 整个系列回头看

四篇连起来是一条线：

1. [授权码流程](/p/oauth-auth-code) —— 为什么 token 不能经过浏览器，`state` 防的是哪种 CSRF
2. [PKCE](/p/oauth-pkce) —— `code` 在路上被截走，用 verifier 绑定会话
3. [Device Flow](/p/oauth-device-flow) —— 连回调都没有时，把「回调」挪到人身上
4. 本篇 —— token 到手之后，过期/刷新/撤销没有任何统一答案

真正值得记住的不是这四种流程的名字，是每一步背后「如果不这么做会怎样」。OAuth 的每个参数都是被一次真实事故逼出来的：`state` 对应 login CSRF，PKCE 对应 code 拦截，`slow_down` 对应轮询滥用，`redirect_uri` 逐字校验对应开放重定向。记住事故，参数就不用背。

#oauth #jwt #security', '', 'teardown', 'OAuth 授权流程拆解', 4,
        0, 0, 'OAuth 只定义怎么拿 token，不管它活多久。各家策略差到 GitHub OAuth App 的 token 默认永不过期；refresh 轮换会导致并发刷新互踩；本站的做法是丢 token 只留自签会话，代价写清楚了。', 'manual', '', 1, '2026-11-08 14:41:28', '2026-11-08 14:41:28')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  series = excluded.series, series_order = excluded.series_order,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('oauth');
INSERT OR IGNORE INTO tags (name) VALUES ('jwt');
INSERT OR IGNORE INTO tags (name) VALUES ('security');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'oauth-token-lifecycle');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('oauth','jwt','security') WHERE p.slug = 'oauth-token-lifecycle';