## 结论

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
res.headers.append('set-cookie',
  `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
// 敏感动作的票据用 Strict：只有站内导航才带得过来
res.headers.append('set-cookie',
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
const res = await fetch('https://api.de5.net/whoami', {
  method: 'GET',
  credentials: 'include',           // 少了这一行，请求照发，cookie 不带
  headers: { accept: 'application/json' },
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
| 前端没写 `credentials: 'include'` | 没带 | 请求 200，响应正常，但 `Set-Cookie` 被忽略，JS 无任何报错 |
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
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure !== false) parts.push('Secure');
  return parts.join('; ');
}
```

`SameSite=Lax` 是硬编码的，`Secure` 默认开。`src/auth.js` 第 237 行用它写会话：

```js
headers.append('set-cookie', setCookie(COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }));
```

`COOKIE` 是 `sid`，有效期 30 天，`Path=/`，`HttpOnly`，`Secure`，`SameSite=Lax`，**没有 `Domain`**。最后这一点意味着它是 host-only 的，只回给 `exia.de5.net`，任何子域都拿不到。

选 Lax 的理由不是「默认值省事」，是 OAuth 回调走不通 Strict。登录流程是这样的：`/login` 写一条 `oauth_state`，302 到 GitHub；用户在 GitHub 授权完，GitHub 302 回 `https://exia.de5.net/auth/callback?code=...&state=...`。这一跳是**跨站的顶级 GET 导航**。

- Lax：带上 `oauth_state`，`state` 对得上，换 token，写 `sid`。
- Strict：不带 `oauth_state`，`state` 为空，校验失败，用户 100% 看到「登录状态已失效」。

这是 Strict 在本站唯一但致命的坏处。同一段逻辑在 `src/auth.js` 的 131、132 行写了两条 cookie，`oauth_state` 和 `oauth_next`，都是 `SameSite=Lax; Max-Age=600; Secure`，600 秒跟 code 的寿命对齐。回调成功后 238、239 行立刻把它们置空。

顺带说一条跟 SameSite 无关、但同一个坑位的东西：`src/cache.js` 的 `edgePut` 在写入缓存副本前有一行

```js
headers.delete('set-cookie');
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
curl -sI https://exia.de5.net/login | grep -i '^set-cookie'
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
  -H 'Origin: https://example.org' \
  -H 'Referer: https://example.org/post' | grep -i '^set-cookie'
```

```text
set-cookie: oauth_state=3f2a...; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure
```

同一条 `Set-Cookie`，一个字都没变。服务端不看 `Origin`，只负责把属性写出来；存不存、什么时候带，由浏览器收到响应之后自己算。所以在 `curl` 里永远复现不出「跨站 cookie 不发送」——这也是为什么这类问题必须开浏览器。`curl -b 'sid=abc'` 手动塞进去的 cookie，它一样照发，不管你把 `Referer` 写成什么。

第二步，在真实浏览器里看存储。打开 DevTools → Application → 左侧 Storage → Cookies → 选中 `https://exia.de5.net`。表格里有一列 `SameSite`，值只会是 `Lax`、`Strict`、`None` 或空白。空白表示这条 cookie 在落盘时没有该属性，浏览器会按 Lax 解释——但别指望它替你补上，服务端该写的还是要写。

同一张表里再看三列：`Domain` 为空表示 host-only（只发主站），`HttpOnly` 打勾表示 JS 读不到，`Secure` 打勾表示只走 HTTPS。这三列加 `SameSite` 一列，cookie 的发送条件就全了。

第三步，看请求实际带了什么。Network → 选一条请求 → Headers → Request Headers 里的 `Cookie`。有值就是带了，没这一行就是没带。想看被 SameSite 挡掉的那几条，在 Network 的请求详情里切到 Cookies 子面板，被拦的会单独标出来；Application → Cookies 面板上有个 `Show filtered out request cookies` 的开关，打开后能看到「存在但没发」的 cookie，这一栏最有用——它把「没有这条 cookie」和「有这条但被拦了」分开了，而这两种情况的修法完全不同。

要在控制台里一次打印「到底带了哪几条」，得让服务端回显，因为 `HttpOnly` 的那条 JS 永远读不到：

```js
// 页面控制台里跑：对比「服务端收到什么」和「JS 看得见什么」
const probe = async (url) => {
  const r = await fetch(url, { credentials: 'include' });   // 跨站时 include 才有意义
  const j = await r.json();                                  // 服务端回显 cookie 名数组
  const js = document.cookie.split(';')
    .map((s) => s.trim().split('=')[0]).filter(Boolean);
  console.log(url);
  console.log('  服务端收到:', j.names, `共 ${j.count} 条`);
  console.log('  JS 可见  :', js);
};

await probe('/api/whoami');                       // 同站：两条都应该在
await probe('https://api.example.net/whoami');    // 不同 site：Lax 那条不该出现
```

服务端那一侧只要能回显 `request.headers.get('cookie')` 里出现的名字就够了，不需要解析值：

```js
// Worker 侧：把这次请求实际收到的 cookie 名回显出来
export default {
  async fetch(req) {
    const raw = req.headers.get('cookie') || '';
    const names = raw.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean);
    const origin = req.headers.get('origin') || '';
    return new Response(JSON.stringify({ names, count: names.length }), {
      headers: {
        'content-type': 'application/json',
        // 带凭证时只能回具体 Origin，* 会被浏览器拒掉，所以把请求里的 Origin 原样回写
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        vary: 'Origin',
      },
    });
  },
};
```

两行输出的差值就是 `HttpOnly` 的条目；两个 URL 的差值就是 SameSite 拦掉的部分。同站那次如果 `服务端收到` 是空的，问题一定不在 SameSite，去查 `Path` 和 `Domain`——这两条在 set 的时候就决定了 cookie 会不会被送到这个路径和这个主机。

第四步，做一次对照。本机起两个服务：`http://localhost:3000` 写 cookie 并渲染一个页面，页面里 `fetch('http://127.0.0.1:3001/echo', { credentials: 'include' })`；`127.0.0.1:3001` 把收到的 `Cookie` 头原样回显。按 site 的定义，`localhost` 与 `127.0.0.1` 是两个 site，这次请求算跨站，Lax 下 cookie 不会出现，回显是空的。把目标换成 `http://localhost:3001/echo`，同 site 不同 origin，cookie 会出现——如果两边都监听在同一台机器上、代码完全一样，唯一的变量就是 host。

这一步我只在纸面上推过，没在三个独立注册域名上跑过完整对照。按规范和浏览器实现应当如此，结论到推断为止；要拿真数，得有两个真实域名和一份证书，本机这对只能验机制、验不了「公共后缀列表」那一层。

SameSite 的坑几乎都不在三种取值本身，在它前面那一步：**这条请求到底算不算跨站**。这一步判错，后面三种取值推得再细都是白推。

相关：系列上一篇是[《JWT 的 exp 到底在哪一层被校验》](/p/jwt-exp-verify)，讲凭证本身；这一篇讲凭证怎么被浏览器带出去。SameSite 决定「带不带」，跨域读取走的是另一套闸，而带 cookie 的跨域请求还要过 CORS 那三个条件——[《评论区防滥用》](/p/comment-anti-spam)里那段表单提交的鉴权就是两套闸同时生效的例子。
