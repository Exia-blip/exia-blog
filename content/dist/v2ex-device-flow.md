标题：为什么 gh auth login 不需要回调地址？把 Device Flow 拆了一遍

---

一直觉得 `gh auth login` 那个「终端里给你一串 WDJB-MJHT，让你去浏览器输进去」的设计很怪，最近认真读了一遍 RFC 8628 才想明白它到底在绕开什么，记一下。

结论是：它把「浏览器跳回来」换成了「用户手抄一个短码」。所以客户端不需要能被公网访问的回调地址，也不需要 client_secret。授权结果不是被重定向推回来的，是客户端拿着 device_code 主动去轮询拉回来的。

一个常见误解是「Device Flow 是移动端/CLI 专用的另一种 OAuth」。其实 grant type 没变复杂，变的只有结果的传递方向：授权码流程是服务器**推**，Device Flow 是客户端**拉**。三方角色一个都没少。

几个实现上容易错的点：

1. `authorization_pending` 是 HTTP 200 带 error 字段，不是 4xx。用 `fetch` + `res.ok` 判断会直接把它当成功处理。
2. `slow_down` 必须把 interval 加 5 秒再继续，不能按原频率重试。这条是规范里写死的，忽略会被限流。
3. 轮询循环必须有 `expires_in` 兜底（GitHub 是 900 秒），否则用户不操作时进程就一直转。
4. `grant_type` 那个 URN 是 `urn:ietf:params:oauth:grant-type:device_code`，不能简写成 `device_code`。

最反直觉的一环是 user_code 和 device_code 怎么对上：授权服务器内部维护一张 `user_code → device_code` 的映射。用户在浏览器里授权的是短码，服务器把结果写到对应的 device_code 记录上，客户端下次轮询拿长码一问就取到了。客户端和浏览器之间没有任何直接通信——所以它能穿 NAT、穿公司防火墙。

代价也说清楚：短码天然可被钓鱼（攻击者把自己的 user_code 发给受害者，骗他授权到自己账号上），所以 Device Flow 一般只允许低风险 scope。它不是「更安全的 OAuth」，是在没法回调的前提下重新分配风险。

完整版写了五步 curl 实录、错误码对照表和一份 Node 实现骨架，放自己博客上了：https://exia.de5.net/p/oauth-device-flow

顺便问一句：有没有人在生产里用 Device Flow 做过非 CLI 的东西（车机、机顶盒之类）？想听听实际体验，尤其是 user_code 的可读性设计，大写加连字符是不是真的比纯数字好抄。
