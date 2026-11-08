## 结论

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
  -d '{"access_token":"gho_xxxxxxxx"}'
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
const ghUser = await fetch('https://api.github.com/user', {
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

#oauth #jwt #security
