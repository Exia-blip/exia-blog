## 结论

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
headers.append('set-cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
```

回调时对比：

```js
const expect = parseCookies(request).oauth_state;
if (!state || state !== expect) {
  return noticePage('登录状态已失效', '浏览器里没有找到这次登录的临时凭据…');
}
```

四个属性都有理由，改一个就会漏：

- `HttpOnly` —— 前端 JS 读不到，XSS 也偷不走。**别把 state 塞 localStorage**，那等于把它交给页面上任何一段脚本。
- `SameSite=Lax` —— 不能用 `Strict`。OAuth 回调是从 GitHub 域发起的顶层 GET 跳转，`Strict` 下浏览器不会带 Cookie，用户会 100% 看到「登录状态已失效」。`Lax` 恰好放行顶层 GET 导航、拦掉跨站 POST。
- `Max-Age=600` —— 与 code 的寿命对齐。用户在授权页挂 10 分钟以上，code 早就废了，state 留着也没有意义。
- `Secure` —— 没有它，任何一次明文 HTTP 请求都会把 state 一起发出去。

用完立刻置空：

```js
headers.append('set-cookie', 'oauth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
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
  const raw = String(env.SITE_ORIGIN || '').trim();
  if (!raw) return reqOrigin;
  return new URL(raw.replace(/\/+$/, '')).origin;
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
  return new Response(null, { status: 302, headers: { location: new URL('/auth/github', origin).toString() } });
}
```

先用 302 把用户送回主域，再开始 OAuth。Cookie 只会在一个 host 上产生。

这条经验可以一般化：**任何「登录后还是未登录」的问题，先看 Cookie 落在哪个 host 上**，而不是先查 session 逻辑。

## 一个收尾细节：邮箱可能是 null

`GET /user` 返回的 `email` 经常是 `null`——用户开了邮箱隐私。要再查一次 `/user/emails`：

```js
let ghEmail = ghUser.email || '';
if (!ghEmail) {
  const arr = await fetch('https://api.github.com/user/emails', { headers }).then((r) => r.json());
  ghEmail = (arr.find((e) => e.primary && e.verified) || arr.find((e) => e.verified) || arr[0])?.email || '';
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

#oauth #http #security
