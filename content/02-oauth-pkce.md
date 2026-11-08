## 结论

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
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
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

#oauth #security #http
