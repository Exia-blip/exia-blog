> 跑过一次 `gh auth login` 的人多半见过这一幕：终端里打印一串 `WDJB-MJHT`，让你去浏览器打开一个地址、把码输进去。输完回到终端，登录就好了。
>
> 这里没有任何 localhost 回调、没有端口映射、没有 `client_secret`。它靠的就是 OAuth 2.0 里那个总被跳过的小节：Device Authorization Grant（RFC 8628），也就是 Device Flow。

## 一句话说清它换掉了什么

Device Flow 把「浏览器跳回来」换成了「用户手抄一个短码」。

所以客户端**不需要可被公众访问的回调地址**，也不需要 `client_secret`。授权结果不是被重定向送回来的，而是客户端拿着 `device_code` 主动去轮询拿的。

这一条差异决定了它能在 CLI、电视、路由器后台、没有本地 HTTP 服务的桌面应用里跑通——这些场景里，「回调地址」这个东西根本不存在。

## 先看清三种流程的分界

| 流程 | 谁来接收授权结果 | 需要回调地址 | 需要 client_secret | 典型场景 |
|---|---|---|---|---|
| Authorization Code | 浏览器重定向到 `redirect_uri` | 要，且必须公网可达 | 要（Web 后端换 token） | 普通网站登录 |
| Authorization Code + PKCE | 同上，但用 `code_verifier` 替代 secret | 要，可用自定义 scheme | 不要 | 移动 App / SPA |
| Device Flow | 客户端轮询 | **不要** | 不要 | CLI、TV、无浏览器设备 |

前两种的隐含前提是：授权服务器能把结果**推**给客户端。Device Flow 把方向反过来——客户端自己**拉**。

它们的共同点是「必须有一个能收到回调的地址」；Device Flow 讲的就是这个共同点不成立时怎么办。（前两种的细节我另写在 [授权码流程](https://exia.de5.net/p/oauth-auth-code?utm_source=juejin&utm_medium=post) 和 [PKCE](https://exia.de5.net/p/oauth-pkce?utm_source=juejin&utm_medium=post) 两篇里。）

## 五步，用 GitHub 的真端点走一遍

下面这些端点、字段名都是 GitHub 线上真实的，可以照着 `curl`。

**第一步：申请设备码**

```bash
curl -X POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "scope=read:user"
```

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

注意 `verification_uri` 是**授权服务器自己的地址**，不是你的回调地址。这就是它不需要回调域名的原因：用户从头到尾都待在 GitHub 的地盘上。

**第二步：把 `user_code` 和 `verification_uri` 展示给用户**

```
请在浏览器打开 https://github.com/login/device
并输入代码：WDJB-MJHT
```

**第三步：用户在自己设备上打开、输入、点授权**

这一步完全脱离你的客户端，你的程序此时只是挂在那里等。

**第四步：客户端按 `interval` 轮询**

```bash
curl -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "device_code=3584d83530557fdd1f46af8289938c8ef79f9dc5" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code"
```

用户还没点授权时，返回的是 HTTP 200 加一个错误字段：

```json
{ "error": "authorization_pending" }
```

**第五步：拿到 token**

```json
{ "access_token": "gho_xxxxxxxx", "token_type": "bearer", "scope": "read:user" }
```

## 轮询期间的错误码，含义各不相同

别一律当失败处理，这五个要分开应对：

| error | 含义 | 该怎么办 |
|---|---|---|
| `authorization_pending` | 用户还没操作 | 继续按 interval 轮询 |
| `slow_down` | 轮得太快 | interval 增加 5 秒，**不要**按原频率重试 |
| `expired_token` | 设备码过期（GitHub 是 900 秒） | 回到第一步重新申请 |
| `access_denied` | 用户点了拒绝 | 停止，提示用户 |
| `incorrect_device_code` | 码不对或已用过 | 回到第一步 |

`slow_down` 是 RFC 8628 里明确规定的：收到它之后必须把间隔加 5 秒。忽略这条的客户端会被授权服务器限流甚至拉黑。

## 关键机制：`user_code` 是怎么把两边对上的

这是整个流程里最容易被忽略的一环。

- `device_code`：长、随机、只在你和授权服务器之间流转，**永远不给人看**。
- `user_code`：短、可读、给人看，用户把它输进浏览器。

授权服务器内部维护一张映射：`user_code → 待授权的 device_code`。用户在浏览器里授权的是那个 `user_code`，服务器把授权结果写到对应的 `device_code` 记录上。客户端下一次轮询时，拿 `device_code` 一问，就能取到自己那份 token。

于是「两边」是通过服务器上的这张表对接的，客户端和浏览器之间没有任何直接通信——这也是它能穿过 NAT、穿透公司防火墙的原因。

## 一个完整的客户端骨架

```js
async function deviceLogin({ clientId, scope }) {
  const start = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, scope }),
  }).then((r) => r.json());

  console.log(`打开 ${start.verification_uri} ，输入 ${start.user_code}`);

  let interval = start.interval || 5;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: start.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    }).then((r) => r.json());

    if (res.access_token) return res.access_token;
    if (res.error === 'authorization_pending') continue;
    if (res.error === 'slow_down') { interval += 5; continue; }
    throw new Error(res.error || 'device flow failed');
  }
  throw new Error('expired_token');
}
```

三件事别写错：`grant_type` 那一长串不能省；`slow_down` 要加间隔而不是重试；循环必须有 `expires_in` 兜底，否则用户不操作时这个进程会一直转下去。

## 它的安全边界（这段最值得看）

Device Flow 不是「更安全的 OAuth」，它是**在无法回调的前提下，把风险重新分配**的方案。四条代价：

1. **短码可被钓鱼**。攻击者申请一个 `device_code`，把 `user_code` 发给受害者，骗他去 GitHub 输入并授权。受害者以为在登录自己的账号，实际授权的是攻击者的设备。唯一的防护是授权页面始终显示「哪个应用在请求什么权限」，以及用户自己看清。这也是 Device Flow 通常只允许低风险 scope 的原因。
2. **轮询是天然的资源消耗点**。授权服务器必须对它限流，`slow_down` 就是限流信号本身。
3. **token 直接落到客户端**。没有后端做中转，客户端一旦不可信，token 就是裸的。桌面/CLI 场景能接受，因为它本来就在用户自己的机器上。
4. **`client_secret` 不参与**。公共客户端没有秘密可言，安全性全部押在「用户确实在自己的浏览器里点了授权」这一件事上。

## 什么时候才该用它

- **CLI 工具**：`gh auth login` 就是这条路，本机起不了公网 HTTP 服务。
- **电视 / 车机 / 物联网设备**：输入法都难用。
- **桌面应用**：不想为每个平台注册自定义 scheme，也不想内嵌 WebView 抓回调。
- **临时脚本**：不想为了跑一次脚本去注册回调地址。

反过来说：只要你的运行环境有浏览器、域名可配，就别用。网页上硬上 Device Flow，等于让用户从一个页面跳到另一个页面抄一串码再回来，纯属找罪受。

## 最后

Device Flow 的本质不是「另一种 OAuth」，而是**把回调这件事从网络层挪到了人身上**：用户抄一次码，客户端就不用被公网访问。理解这一点，它该用在哪儿、代价是什么，也就清楚了。

嗯，还有一半问题没人管：token 拿到之后活多久、什么时候失效、怎么撤销——各家答案都不一样，而且没有一个能靠猜。[这篇](https://exia.de5.net/p/oauth-token-lifecycle?utm_source=juejin&utm_medium=post)里做了对照。

> 原文发在 [exia.de5.net](https://exia.de5.net/p/oauth-device-flow?utm_source=juejin&utm_medium=post)，里面是四篇连着的 OAuth 拆解，这篇是第 3 篇。
