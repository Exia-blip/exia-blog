## 结论

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
await fetch('https://api.example.com/comments', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },   // ← 这一行就触发预检
  body: JSON.stringify({ text: 'hi' }),
});

// 不触发预检
await fetch('https://api.example.com/comments', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'text=hi',
});

// 触发预检
await fetch('https://api.example.com/comments', {
  method: 'DELETE',                                   // ← 方法不在列表
  headers: { 'authorization': 'Bearer xxx' },         // ← 头不在列表
});
```

绝大多数现代 API 都是 `application/json` + `Authorization`，所以**默认就在付预检的钱**。这一点没法避免，能优化的只有「付几次」。

## 二、测量：服务端数 OPTIONS，浏览器跑真实间隔

浏览器侧看不到预检缓存，DevTools 的 Network 面板会把预检折叠成一条，而且不会告诉你「这次是缓存命中还是真发了」。唯一可靠的办法是**在服务端数**。

服务端加一个计数端点：

```js
// 每次 OPTIONS 往 D1 记一行，测完删表
if (req.method === 'OPTIONS') {
  await env.DB.prepare('INSERT INTO _bench_cors (kind) VALUES (?)').bind(path).run();
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-bench',
      // 对照组：这一行加不加，就是全部差别
      'access-control-max-age': '600',
    },
  });
}
```

页面侧从**另一个 origin** 加载（我用 `http://127.0.0.1:8788` 起静态页，请求打到 Worker 的 `workers.dev` 域名），连发 3 次，然后把服务端计数读回来：

```js
// 间隔可配：gap = 0 / 4200 / 7000
for (let i = 0; i < 3; i++) {
  if (i && gap) await new Promise((r) => setTimeout(r, gap));
  await fetch(BASE + '/cors/' + kind, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-bench': '1' },
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

**二、预检请求不带 cookie。** 这是个常被误解的点：即使你 `fetch` 时写了 `credentials: 'include'`，浏览器发出的那个 `OPTIONS` **不会**携带 cookie 和 `Authorization`。所以：

- 预检的响应**不能**依赖登录态来生成。如果你的 `OPTIONS` 处理器要查 session 才决定允许哪个 origin，它永远查不到。
- 需要凭证的接口，`Access-Control-Allow-Origin` 不能是 `*`，必须是具体 origin，同时要 `Access-Control-Allow-Credentials: true`。

**三、CDN 缓存 OPTIONS 会串味。** 如果 `Access-Control-Allow-Origin` 是按请求的 `Origin` 动态返回的（多域名白名单的常见写法），而你又让 CDN 缓存了 `OPTIONS` 响应，就会出现「A 站拿到的响应里写着 B 站的 origin」。修法是加 `Vary: Origin`，或者干脆别缓存 `OPTIONS`（它本来就该被浏览器缓存，不需要 CDN 再存一层）。

```js
// 多域名白名单的正确写法：按 Origin 回显 + Vary
const allow = ['https://a.example.com', 'https://b.example.com'];
const origin = req.headers.get('origin');
const headers = {
  'access-control-allow-origin': allow.includes(origin) ? origin : allow[0],
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600',
  'vary': 'Origin',
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

相关：SameSite 管「cookie 带不带」，是[上一篇](/p/samesite-behavior)；这里管「跨域读了之后让不让用」。预检省下来的那次往返值多少钱，按[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)量出来的 41ms 单次成本算就清楚了。
