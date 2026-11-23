## 结论

清单给了四类模板、六条响应头、一份 CSP 基线和一套断言编号。实测下来：**六条头全都在，其中四项比 OWASP 基线更严；唯一的真缺口是一条「该有值、而值为 0」的头——`X-XSS-Protection`。**

断言那部分给的是 `P-009`~`P-012`，这四个编号在 2026-11 就被 CRLF/SRI 和 103 preload 占完了。这是第三轮撞车。

| 清单条目 | 实测 |
|---|---|
| HSTS `max-age=63072000; includeSubDomains` | **已有，且更严**：`31536000; includeSubDomains; preload` |
| CSP `script-src 'self'` | **已有，且更严**：`'self' 'nonce-<每请求随机>'` |
| `X-Frame-Options: deny` | 已有，`DENY` |
| `X-Content-Type-Options: nosniff` | 已有，HTML 与数据路径都有 |
| `Referrer-Policy: no-referrer` | 已有，但是 `strict-origin-when-cross-origin`——**刻意选的，不是抄漏** |
| `X-XSS-Protection: 0` | **没有。这是唯一要改的** |
| 删 `Server` / `X-Powered-By` | `X-Powered-By` 没有；`Server: cloudflare` 是边缘加的，**Worker 删不掉** |
| `P-009`~`P-012` | 编号已占用，新条目顺延到 `P-023`~`P-027` |

## 一、那六条头，逐条对着 OWASP 打一遍

清单说「这是唯一能兜住前面全失守的一层，你现在完全没有」。实际是 2026-10 就在 `src/security.js` 的 `securityHeaders()` 里，四条路径实测：

```
$ curl -sI https://exia.de5.net/ | grep -iE "strict-transport|referrer|x-frame|x-xss|permissions|cross-origin"
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
cross-origin-opener-policy: same-origin
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
referrer-policy: strict-origin-when-cross-origin
x-content-type-options: nosniff
x-frame-options: DENY
```

和 OWASP 的建议值对比，四项是「本站更严」：

**HSTS** —— OWASP 给 `max-age=63072000; includeSubDomains`（两年）。本站是 `31536000`（一年）**外加 `preload`**。一年是 preload 列表的准入门槛，两年只对「首次访问前的空窗期」有意义；而 `preload` 把域名硬编码进浏览器，等于把这个窗口直接关死。多那一年 max-age 换不到额外收益。

**CSP 的 `script-src`** —— OWASP 基线是 `'self'`，本站是 `'self' 'nonce-<32 位十六进制>'`，且每次响应不同：

```
content-security-policy: default-src 'self'; script-src 'self' 'nonce-e7e71c74aa34aa34d552c85f1b6db221'; ...
```

这一条是**实质差别，不是格式差别**。`script-src 'self'` 意味着「本站域名下的任何脚本都能跑」——只要有一个上传点能让攻击者写入 `/x.js`，或者某个静态资源被替换，就破了。nonce 是「只有我这次渲染时盖了章的那几个 `<script>` 能跑」。**照抄 OWASP 那条基线，是把现有防线往下调一档。**

**Permissions-Policy** —— 清单给 `geolocation=(), microphone=(), camera=()` 三项，本站五项，多了 `payment=(), usb=()`。

**COOP** —— 清单没提，本站有 `same-origin`。

唯一比 OWASP 松的是 `Referrer-Policy`：`strict-origin-when-cross-origin` 对 `no-referrer`。这不是抄漏。站内有友链页，出站链接如果一律 `no-referrer`，对方的访问统计会把所有来自本站的流量记成「直接访问」。而 `strict-origin-when-cross-origin` 已经把跨站请求降级成只发 origin、不发路径和查询串——**站内 URL 结构、文章 slug 不会泄露**，这是这个头真正要防的东西。收得更紧的代价是断掉友链的互惠数据，不划算。断言里只守「不是 `unsafe-url`」这一条下限。

## 二、唯一该改的那条：`X-XSS-Protection: 0`

这是清单里我完全认同的一条，也是全站唯一一条「该有值、而值为 0」的头。

老教程清一色写 `1; mode=block`。那个开关打开的是旧引擎的 XSS Auditor，而它会在某些反射场景下被诱导去删页面里的合法片段，反而制造可利用面——OWASP 现在也建议 `0`。现代浏览器已经把这个功能移除了，所以这条头今天只剩一个作用：**给还没移除它的旧引擎一个明确的「关掉」信号**。

有个细节值得说：这条不能靠「不设」来实现。不设的话旧引擎走它自己的默认行为（在若干版本里默认是开着的），只有显式 `0` 才是关。

```js
/* 显式设 0，不是「关掉保护」。
   旧引擎的 XSS Auditor 会在某些反射场景下被诱导去删页面里合法片段，
   反而制造可利用面；现代浏览器已移除该功能，这条只为旧引擎兜底。 */
h.set('x-xss-protection', '0');
```

## 三、`Server` 头删不掉

清单说「顺手删 `Server` / `X-Powered-By`」。实测只有前者：

```
$ curl -sI https://exia.de5.net/ | grep -iE "^server:|^x-powered-by:"
Server: cloudflare
```

`X-Powered-By` 本来就没有（Worker 不发这个头）。`Server: cloudflare` 是**边缘写入的，不是 Worker 写的**——在 Worker 里 `headers.delete('server')` 没有用，因为响应离开 Worker 之后还要过一层边缘，那个头是边缘补的。

这是 Workers 模型的一个固定边界，和前面几轮遇到的「wrangler 管不了 WAF 规则」是同一类：**代码能控制的只有 Worker 出口那一层，边缘那一层只能靠面板。**

## 四、20 条断言，7 处注入全红

清单第四类给的是 `check-dom.mjs` 风格的四条 `check()`。方向对，落点换了——`check-dom` 要跑 SSR Worker，本地不一定起得来；响应头是纯字符串，`securityHeaders()` 是个纯函数，改完立刻能验。

新建 `scripts/test-headers.mjs`，`[P-023]`~`[P-027]` 共 20 条：

| 编号 | 守什么 | 条数 |
|---|---|---|
| `P-023` | 基础六条：HSTS 有效期 ≥1 年含子域、nosniff（两条路径）、XFO `DENY`、Referrer 非 `unsafe-url`、Permissions 三项、COOP | 6 |
| `P-024` | `X-XSS-Protection` 必须是 `0` 或缺省，不许 `1; mode=block`；源码里必须有那一行 | 2 |
| `P-025` | CSP 八条：`script-src` 带 nonce 且无 `unsafe-*`、`object-src 'none'`、`base-uri` 非通配、`frame-ancestors 'none'`、`form-action 'self'`、无裸 `*`、未配 Turnstile 时零放行、无 nonce 路径不发 CSP 但其余头仍在 | 9 |
| `P-026` | `setCookie()` 四属性、`clearCookie()` 含 `Max-Age=0` | 2 |
| `P-027` | ACAO 通配只允许 manifest 一处、全文无 `allow-credentials` | 1 |

**先红后绿**：脚本写完第一次跑是 19/20，唯一红的就是 `P-024` 那条「源码里必须写了 `x-xss-protection: 0`」——因为那时代码里确实没有。加上那一行之后 20/20。这条断言是先证明自己会红、再变绿的，不是写完就绿的。

七处注入逐一验过：

| 注入 | 变红 |
|---|---|
| 删 `x-frame-options` | 2 条 |
| `Referrer-Policy` 改 `unsafe-url` | 1 条 |
| `object-src` 改 `'self'` | 1 条 |
| `X-XSS-Protection` 改回 `1; mode=block` | 2 条 |
| `script-src` 加 `'unsafe-inline'` | 1 条 |
| `setCookie` 去掉 `HttpOnly` | 1 条 |
| `base-uri` 改 `*` | 2 条 |

`check-live` 另补四条，守「代码里设了、边缘也真的发出来了」——纯函数测试永远看不到边缘吃掉头这种情况。这四条**要等部署后才绿**，现在跑是红的，这是预期的。

## 五、材料第三轮撞编号

清单写：

```
check('P-009', 'CSP 存在', ...)
check('P-010', 'nosniff 存在', ...)
check('P-011', '无 X-XSS-Protection', ...)
check('P-012', 'cookie 含 HttpOnly', ...)
```

`P-009` 是 CRLF/SRI（内容哈希被行尾破坏，本地绿 CI 红），`P-010` 是 103 Early Hints 的 preload 版本号。这两个在 2026-11 就已经分配出去了，编号不复用是这套机制的硬规则——**编号一改，所有历史文章的「失败跳回 P-00X」全部指向错地方**。

新条目顺延到 `P-023`~`P-027`，对账现 27 条全绿。

## 六、WAF 那部分：抄不了，也验不了

清单给的配额是「免费版 0/1 规则、计数特征只能选 IP、Duration 固定 10 秒、自定义规则 5 条」，动作建议先 `Managed Challenge` 观察几天再切 `Block`。

这段我无法核实。`wrangler` 不管 WAF 规则，API token 也没有 Zone 读权限，面板上现在是什么配额、免费版给了几条，只能登录后台看。**清单这些数字如果和你后台显示的不一致，以后台为准**——这就是为什么前面几轮我一直说「WAF 是仓库管不到的那一层」。

能确认的是它和现有三层的关系没变：蜜罐抓不跑 JS 的填表机、Turnstile 抓能跑 JS 但没法过挑战的、D1 限额抓已登录但狂发的。WAF 在这一层外面，拦下的请求不进 Worker，也就不烧额度——**这是应用层任何限流都换不来的**。

## 明说的没做

1. **WAF 和 Bot Fight Mode 一次都没开过。** 没有误伤数据，`DEPLOY.md` 第 6 节那份清单仍然只是清单。
2. **`check-live` 那四条新断言现在是红的**，因为它打的是线上，而 `x-xss-protection: 0` 还没部署。部署后第一次跑才是有意义的。
3. **`img-src` 比 OWASP 基线松一档**：本站是 `'self' data: blob: https:`，模板给的是 `'self' data: blob:`。多出来的 `https:` 是为了外链图，代价是图片型回连通道没有被 CSP 关掉。收紧要先把全部外链图迁进 R2，没做。
4. **`style-src 'unsafe-inline'` 仍在。** 清单建议用 nonce 去掉，但那要动 Markdown 的 `style` 属性渲染链（`clean.js` 的 `attrFilter` 现在只放行 `text-align`），不是加个头能解决的。
5. **清单里关于 OWASP 那三个 Workers 实现（单文件 header 对象、`strict-dynamic-csp`、`cf-hardhat`）我没引入。** 本站的头已经写在一个 40 行的 `securityHeaders()` 里，换成别人的中间件只是把同样的字符串搬个地方，还多一个依赖——和「不引 sanitize 库」同一条理由。
