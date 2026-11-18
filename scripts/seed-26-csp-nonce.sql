-- 由 scripts/seed-26-csp-nonce.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('csp-nonce-cache', 'CSP nonce 每次请求都换，缓存里的旧页面怎么办：三处配对与一个 304', '## 结论

CSP nonce 和缓存不是不能共存，但必须同时守住三处配对，外加一道 ETag 归一化：

`nonce` 的全称是 number used once——一次性数字。服务器每次生成页面时抽一个随机数，写进 CSP 头的 `script-src`，同时打进这个页面每一个内联 `<script>` 的 `nonce` 属性，浏览器比对两边，一致才执行。问题在于这个数**每次生成都不一样**，而页面在 CF 边缘能躺 5 分钟：缓存里存的是上一次的 nonce，浏览器手里那份 body 也是上一次的。要是新请求生成了新 nonce、跟着新 CSP 头一起发出去，页面里每一个内联脚本都会因为对不上号被静默丢弃——主题初始化、SSR 引导数据、邮箱解码、评论渲染，一起失效。页面看着完全是好的，什么报错都没有。这不是假想，下面每一处都有线上的响应头和单测兜着。

| 环节 | 要守住什么 | 守不住会怎样 |
|---|---|---|
| 生成 | 头里的 nonce 和 body 里的 nonce 来自同一次 `makeNonce()` | 所有内联脚本被 CSP 挡掉，页面空白或功能全丢 |
| 缓存 | 存进 `caches.default` 的副本，头和 body 必须已经配好对 | 缓存命中后回放一份错位的响应，故障随机出现 |
| 304 | 不发新的 CSP 头，让浏览器沿用自己缓存里那份 | 新 nonce 配旧 body，静默失效且难复现 |
| ETag | 算指纹前把 nonce 归一化抹平 | 每次请求 ETag 都变，304 命中率恒为 0 |

第一处最容易验——头和 body 的 nonce 取同一次 `makeNonce()` 的值，代码里就是同一个局部变量传两遍，不会错。第二处靠缓存写入的时机，第三处靠 304 出口主动删头，第四处靠归一化正则。四处各管一段链路，任何一处单独拿掉，页面都能正常打开，只是某个环节开始静默失效——这正是这套机制需要四道独立探针、而不是一条端到端测试的原因。

这四处如果拆开看，失效时的症状差别很大，定位方向也不一样：

| 坏掉的环节 | 用户看到什么 | 怎么发现 | 为什么难查 |
|---|---|---|---|
| 生成：头和 body 不是同一个值 | 主题、SSR 数据、评论渲染全失效 | 浏览器控制台一片 CSP 拒绝 | 页面结构正常，肉眼看不出 |
| 缓存：存进去的副本头 body 错位 | 首次访问正常，命中缓存后才坏 | 连打两次比对 nonce | 有随机性，刷新有时又好了 |
| 304：发了新 CSP 头 | 强迫刷新正常，普通刷新就坏 | 带 `If-None-Match` 打一次 | 只在复访时触发，开发环境几乎没有 |
| ETag：没抹平 nonce | 功能全正常，只是更快不了 | 看 `cf-cache-status` 或数 304 命中 | 没有任何报错，纯性能退化 |

第三行和第四行最阴——一个功能是好的，一个是性能没达到，两者都不会有人来报障。它们是我写这几段单测的直接原因。

线上实测的数字（2026-11-18）：

| 检查项 | 结果 |
|---|---|
| 连续两次请求头里的 nonce | `ca937e2e84e4f0f2b64007fbd9bb18b0` / `ce471719391ef68d1615e365c8022815`，确实每次轮换 |
| 同一次响应头 nonce vs body nonce | 头 `a91ee031571517cc36d44e1b388b854d` = body `nonce="a91ee031571517cc36d44e1b388b854d"` |
| 带 `If-None-Match` 的 304 响应 | 状态 304，`cache-control` 在，**`content-security-policy` 不在** |
| 单测 | `test-security` 10/10、`test-etag` 31 条全过 |

最反直觉的是第三行：**304 响应里故意没有 CSP 头**。不是漏了，是删的。下面讲为什么。

## 一、nonce 到底在解哪个矛盾

CSP 的 `script-src ''self''` 只放行同源的**外部**脚本。页面里直接写的 `<script>...</script>` 属于内联，一律挡掉。可站点总是有内联脚本：我的主题切换要赶在 CSS 后面执行防闪，SSR 往页面里塞了 `window.__SITE__` 引导数据，邮箱地址要在客户端解码，评论渲染也有一段。

要么给 `script-src` 加 `''unsafe-inline''` 把门敞开，要么给每个内联脚本发一张一次性通行证。nonce 就是后者：

```js
// src/security.js
export function makeNonce() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = '''';
  for (const b of buf) s += b.toString(16).padStart(2, ''0'');
  return s;
}
```

16 字节随机数转 hex，32 个字符——线上抓到的长度正好是 32：

```bash
curl -s -D - "https://exia.de5.net/?cb=$RANDOM" -o /dev/null \
  | grep -i "^content-security-policy" | tr -d ''\r'' \
  | grep -o ''nonce-[0-9a-f]*'' | head -1 | awk ''{print length($0)-6}''
# 32
```

16 字节 = 128 位熵，攻击者靠猜来撞 nonce 的期望次数是 2¹²⁸，这个数量级不用再讨论。CSP 规范也不要求这么长，但既然 `crypto.getRandomValues()` 随手就能拿 16 字节，没理由用更短的。

CSP 头里写 `script-src ''self'' ''nonce-e1022201…''`，页面里每个内联脚本写 `<script nonce="e1022201…">`。浏览器收到的两份值对得上，才执行。

线上抓一份完整的头长这样：

```http
content-security-policy: default-src ''self''; script-src ''self'' ''nonce-e102220156b151bed92e4563ceca1db7''; style-src ''self'' ''unsafe-inline''; img-src ''self'' data: blob: https:; font-src ''self'' data:; connect-src ''self''; media-src ''self'' https:; frame-src ''self'' https://www.youtube.com https://player.bilibili.com; object-src ''none''; base-uri ''self''; form-action ''self''; frame-ancestors ''none''; upgrade-insecure-requests
```

连打两次，nonce 分别是 `ca937e2e…` 和 `ce471719…`，没有重复。这正是它安全的理由——攻击者没法预猜下一个值，就算往页面里注入了 `<script>`，也拿不到这次的 nonce。

但同一份随机性，也正是它和缓存打架的根源。

## 二、第一处配对：头和 body 必须同生共死

我见过一种写法：先拼 CSP 头，再单独生成 nonce 往 body 里塞，两处各调一次随机函数。这种代码本地一跑就露馅——头里的值和脚本上的值对不上，全部内联脚本被挡。

我的做法是只生成一次，头和 body 用同一个变量：

```js
// src/index.js，harden() 出口
const nonce = makeNonce();                       // ← 只在这里生成一次
let raw = await res.text();
const ana = analyticsTag(anCfg);
// 放在补 nonce 之前：这段 script 自己也是内联的，得跟别的一起拿到 nonce
if (ana) raw = raw.replace(''</head>'', ana + ''</head>'');
// 先混淆邮箱再补 nonce：解码脚本是内联的，得跟着一起拿到 nonce
const body = applyNonce(obfuscateEmail(raw), nonce);
const headers = securityHeaders(new Headers(res.headers), nonce, {
  turnstile: tsOn, analytics: anOn,
});
```

`applyNonce()` 用一条正则给没有 nonce 的 `<script>` 补上：

```js
// src/security.js
export function applyNonce(html, n) {
  if (!n) return html;
  return String(html).replace(/<script(?![^>]*\snonce=)/gi, `<script nonce="${n}"`);
}
```

那个负向前瞻 `(?![^>]*\snonce=)` 是防止重复打标——已经有 nonce 的脚本跳过。补标必须在所有会插入内联脚本的操作**之后**：统计脚本是后插的，邮箱解码脚本是 `obfuscateEmail()` 后插的，两者都要赶在 `applyNonce()` 之前进门，否则会漏掉。顺序写反了，页面照样能看，就是那两个功能悄悄不工作。

补标是无差别的，`<script type="application/ld+json">` 这种纯数据块也会被加上 nonce。线上实测两块都带了：

```html
<script nonce="6a6d799fc7ed9c6f27bd4d1d18f377de" type="application/ld+json">
<script nonce="6a6d799fc7ed9c6f27bd4d1d18f377de" type="application/ld+json">
```

数据块的 `type` 不是 JavaScript MIME，浏览器不会执行它，加 nonce 在安全上没有收益。但也没有代价——多 40 来个字节，换来的是一条统一的规则："所有内联 script 都补"。这比维护一份"哪些要补哪些不用补"的例外清单可靠得多。写正则匹配的时候得记住这件事，第七节那次误判就是栽在这儿。

线上验证过配对确实成立：同一次响应，头 `a91ee031…`、body `nonce="a91ee031…"`，完全一致。

还有一个不那么显眼的分支——图片代理出来的响应**完全不补 nonce**：

```js
if (res.headers.get(''x-img-type'') || !ct.includes(''text/html'')) {
  return new Response(res.body, {
    status: res.status,
    headers: securityHeaders(new Headers(res.headers), null, { turnstile: tsOn }),
  });
}
```

`nonce` 传的是 `null`，`securityHeaders()` 里 `if (nonce)` 不成立，CSP 头都不发。这一道是防升级攻击：如果攻击者上传一张伪装成图片的 HTML/SVG，里头带 `<script>`，而出口又顺手给它签上本站 nonce，CSP 的 `script-src ''nonce-…''` 就从"拦截"变成了"盖章放行"。哪怕图片代理那边已经把 `content-type` 降级成 `application/octet-stream`，这里也要再挡一道，防止以后有人改坏那个判断。

## 三、第二处配对：缓存里存的必须是配好对的整份

nonce 在 `harden()` 里生成，头和 body 当场配好对，然后整份 `Response` 交给缓存层：

```js
// src/index.js，缓存写入路径
if (cacheable && res.status === 200 &&
    (res.headers.get(''content-type'') || '''').includes(''text/html'')) {
  const stored = await edgePut(url, res, EDGE_TTL);
  return maybe304(asClient(stored), request);
}
```

`edgePut()` 只改缓存相关的头，不碰 body，也不碰 CSP：

```js
// src/cache.js
export async function edgePut(url, res, ttl = EDGE_TTL, swr = EDGE_SWR) {
  const headers = new Headers(res.headers);
  headers.set(''cache-control'', `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
  headers.delete(''set-cookie'');
  const copy = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  try {
    await caches.default.put(cacheUrl(url), copy.clone());
  } catch { /* 配额或非法请求，忽略即可 */ }
  return copy;
}
```

`asClient()` 同理，改的只是 `cache-control` 和 `cdn-cache-control`。整条链上没有任何一个环节会在缓存命中后"换个新 nonce"——这是设计上的硬约束。缓存里存的是一份已经配好对的快照，命中就整份回放，头和 body 天生配套。

换个说法：nonce 的生命周期到 `harden()` 就结束了。后面所有环节搬运的是一份 immutable 的响应，谁都不能中途改一半。

这条不是推断，能直接用响应头验。同一页连打三次，走缓存命中：

```text
第 1 次  CF-Cache-Status: HIT  Age: 85  ETag: "13mm-742d872e"  nonce-c9a54f66…
第 2 次  CF-Cache-Status: HIT  Age: 85  ETag: "13mm-742d872e"  nonce-c9a54f66…
第 3 次  CF-Cache-Status: HIT  Age: 86  ETag: "13mm-742d872e"  nonce-c9a54f66…
```

nonce 三次**完全一样**。这在安全上看着很吓人——"一次性数字用了三次"——但恰恰是对的：这三次都是同一份缓存快照的回放，头和 body 一起被吐出来，两边的 nonce 始终配套。首发那次生成的新 nonce，跟着整份响应存进了缓存。

换个对照，每次带一个随机参数绕开缓存：

```text
第 1 次  nonce-0d42f802eb501dfa1aee0b509adff323
第 2 次  nonce-ddb13452aa4a330e79b5d8b40444f144
第 3 次  nonce-a1c5143e30c06c9926fd4efe50688de8
```

三次全不同。这才是"每次请求重新生成"的真实样子。

所以 nonce 的正确心智模型不是"每个 HTTP 请求都换"，而是"每次**渲染**都换"。缓存命中不渲染，复用上次的即可。要是有人把生成逻辑挪到缓存之后——每次命中都刷新头里的 nonce 却不动 body——就会造出上面这套机制最怕的错位。

这一条守住之后，缓存命中（不管是 Worker 内的 `caches.default` 还是 CF 边缘）拿到的都是自洽的响应。真正麻烦的是 304——因为 304 按定义**没有 body**。

## 四、第三处配对：304 故意不发 CSP

浏览器带 `If-None-Match` 来，服务端算出来内容没变，回一个 304 让浏览器用自己缓存里的 body。省的是整个响应体：一篇文章页压缩后二十多 KB，304 只有几百字节头。

危险点在这里：如果 304 的响应头里带了一个**新生成**的 CSP，其中包含新 nonce，而浏览器手里那份 body 是上一次的、带着旧 nonce——两边对不上，页面所有内联脚本一起失效。

我在 `maybe304()` 里直接把 CSP 头删掉：

```js
// src/index.js
export function maybe304(res, request) {
  if (request.method !== ''GET'' && request.method !== ''HEAD'') return res;
  if (res.status !== 200) return res;
  const etag = res.headers.get(''etag'');
  if (!etag) return res;
  if (!etagHit(request.headers.get(''if-none-match''), etag)) return res;
  const headers = new Headers(res.headers);
  headers.delete(''content-encoding'');
  headers.delete(''content-length'');
  /* 这一行是整个 304 里最容易踩死人的地方。
     CSP 头里带着本次请求新生成的 nonce，而浏览器手里那份 body 里是**上一次**的
     nonce。把新 CSP 发过去，页面所有内联脚本的 nonce 全部对不上 —— 主题初始化、
     SSR 引导数据、评论渲染会一起静默失效，页面看着是好的，功能全没了。
     删掉这个头，浏览器会沿用缓存里那份响应自带的 CSP（RFC 9111：304 未提供的
     头保持不变），body 与 nonce 就还是配套的。 */
  headers.delete(''content-security-policy'');
  headers.delete(''content-security-policy-report-only'');
  headers.set(''cache-control'', pageCacheControl());
  return new Response(null, { status: 304, headers });
}
```

依据是 RFC 9111：304 响应没提供的头，客户端继续沿用缓存里那份。删掉 CSP，浏览器就继续用它保存的那份 200 响应里的 CSP——那份的 nonce 正好和它手里的 body 配套。

线上实测确认了这个行为：

```bash
ETAG=$(curl -s -D - -o /dev/null "https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM" \
  | grep -i "^etag:" | tr -d ''\r'' | cut -d'' '' -f2-)
curl -s -D - -o /dev/null -H "If-None-Match: $ETAG" \
  "https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM" \
  | grep -iE "^HTTP/|^etag:|^content-security-policy|^cache-control"
```

```text
HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

`content-security-policy` 一行都没有。单测里也钉了一条：

```js
t(!hit.headers.get(''content-security-policy''),
  ''304 不发新 CSP（新 nonce 会打死浏览器里那份旧 body 的内联脚本）'');
```

注意 `content-encoding` 和 `content-length` 也是必须删的——304 没有 body，留着这两个头会让某些客户端等一个永远不会来的实体。

## 五、第四道闸：ETag 必须把 nonce 抹平

前三处守住，头和 body 配对没问题了，还有一个更隐蔽的坑：ETag。

`maybe304()` 只是"能返回 304"，前提是请求里的 `If-None-Match` 得先匹配上。ETag 这一层要是被 nonce 搅乱，前面三处配得再齐，304 一次都不会发生——用户每次都收到完整 200，nonce 配对也就没有了用武之地。

ETag 是内容的指纹。nonce 每次请求都随机，意味着**每一个页面的 body 每次都不同**。如果老老实实对完整 body 算 hash，ETag 每次请求都变，浏览器发来的 `If-None-Match` 永远匹配不上，304 命中率恒为 0。表面上功能齐全——ETag 有、304 逻辑有、注释写得清清楚楚——实际一次都没生效。

这就是"算了个 ETag"和"304 能工作"之间的距离。我的做法是在 `tagOf()` 里先把会变的地方归一化：

```js
// src/utils.js
const VOLATILE = /刚刚|\d+\s*(?:秒|分钟|小时|天|个月|年)前/g;
const NONCE = /\snonce="[0-9a-f]{8,}"/g;

export function tagOf(body) {
  const s = String(body).replace(VOLATILE, ''~t~'').replace(NONCE, '' nonce="~"'');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `"${s.length.toString(36)}-${(h >>> 0).toString(16)}"`;
}
```

`NONCE` 把 `nonce="a1b2c3…"` 换成固定的 `nonce="~"`，`VOLATILE` 把"3 分钟前"这类相对时间也抹平。两处都是每次请求会变、但语义上不该让页面失效的地方。

这里有个中文坑值得单独记：`VOLATILE` 正则不能用 `\b` 画边界。JS 的 `\b` 只认 ASCII 单词字符，中文旁边根本不存在"边界"，写了等于没写。这个错第一次就是被单测抓出来的——三条相对时间断言全红。代价是正文里"3 天前"这种叙述也会被归一化，但那只会让两个不同页面的 ETag 更容易撞，不影响正确性。

**为什么不用内容 hash 而用这种短指纹。** 页面 30KB 左右，每次请求算一遍 SHA-256 在 Workers 里不是不能做，但这里要的是"判断变没变"，不是密码学强度。FNV-1a 这种 32 位滚动哈希够用，配合长度前缀把碰撞概率压到可接受范围。真正决定它可不可靠的是归一化做没做对，不是哈希算法本身——一个没抹平 nonce 的 SHA-256，照样每次都变。

**非 200 的页面不走这套缓存。** `harden()` 里按状态码分流：

```js
const normal = res.status >= 200 && res.status < 400;
if (normal) {
  if (!cc.includes(''no-store'') && !cc.includes(''private'')) headers.set(''cache-control'', pageCacheControl());
  headers.set(''cdn-cache-control'', `public, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`);
} else if (!headers.has(''cache-control'') || cc === ''no-cache'') {
  headers.set(''cache-control'', res.status === 404 ? ''public, max-age=0, s-maxage=60'' : ''no-store'');
}
```

404 只压 60 秒，500 一律 `no-store`。原因写在注释里：一张 404 页在边缘压 300 秒，意味着刚发布的文章地址会在 5 分钟里继续回 404；一张 500 页被缓存，一次数据库抖动会被定格成整站错误页。nonce 在这些页面上照样生成、照样配对，但它们不进 304 那条链路，`maybe304()` 第一句 `if (res.status !== 200) return res` 就把它们挡在外面了。

ETag 还必须用**强校验**（带引号、不带 `W/`）。这是 Cloudflare 边缘自己能答 304 的前提。这篇文章页实测未压缩 62701 字节、Brotli 后 22055 字节，带上 `If-None-Match` 命中时是 304 + 0 字节响应体。弱 `W/` tag 下边缘会不会放弃自己答 304、把请求转给 Worker，这条我没单独做对照实验，只到机制推断为止；能确认的是 `tagOf()` 返回的是 `"长度-哈希"` 这种强 tag 格式，线上抓到的是 `ETag: "13mm-742d872e"`。

**`If-None-Match` 的写法不止一种，四类都得认。** 浏览器发来的不一定就是你发出去的那个字符串。规范允许 `*`，允许多个 tag 用逗号分隔，允许带 `W/` 弱前缀。整体等值比较看着省事，实际漏掉大半：

```js
// src/index.js
export function etagHit(header, etag) {
  if (!header) return false;
  if (header.trim() === ''*'') return true;
  const bare = (s) => s.trim().replace(/^W\//, '''');
  const mine = bare(etag);
  return header.split('','').some((t) => bare(t) === mine);
}
```

四类命中写法，加上不匹配不命中，五种情况都钉在单测里：完全一致命中、去掉 `W/` 命中、逗号列表里含目标命中、`*` 命中、不匹配不命中。这层和 nonce 没有直接关系，但它是 304 链路上最容易被"简化"掉的一段——砍掉之后功能表面正常，只是命中率掉一大截，和 ETag 被 nonce 污染是同一种静默故障。

归一化不能做过头。`test-etag.mjs` 里钉了正反两组：

```js
const n1 = tagOf(''<script nonce="a1b2c3d4e5f60718">x()</script>'');
const n2 = tagOf(''<script nonce="9988776655443322">x()</script>'');
t(n1 === n2, ''CSP nonce 变化不影响 ETag'');
t(tagOf(''<script nonce="a1b2c3d4e5f60718">x()</script>'') !==
  tagOf(''<script nonce="a1b2c3d4e5f60718">y()</script>''),
  ''脚本内容本身变化仍让 ETag 变'');
```

nonce 变了不算内容变，脚本里的 `x()` 变成 `y()` 必须算。31 条 ETag 单测里，这组占了两条。

还有一处不能有 ETag：`html()` 构造函数刻意不算。它生成的 body 后面还要被 `injectTheme` 和 `harden` 两次改写，在那时算出来的指纹对应的是"注入前"的页面。ETag 统一在出口的 `withEtag()` 里按最终 body 重算，而且无条件重算——首页模板自带一个静态文件 ETag，那是"注入前"的值，直接拿来用会让站点设置改了、访客却一直看到旧页面。

## 六、CSP 其余指令的连带约束

nonce 解决的是脚本执行，CSP 头里其他几项也各有取舍，顺手记在这里。

`style-src` 保留了 `''unsafe-inline''`：

```js
"style-src ''self'' ''unsafe-inline''",
```

主题和 Markdown 渲染大量用 `style` 属性，要收掉就得把整个样式体系改成外部类。这是一笔明确的交换——脚本那道门守死了，样式属性放行。

第三方脚本按配置放行，没配就一个字节都不放：

```js
const ts = turnstile ? '' https://challenges.cloudflare.com'' : '''';
```

Turnstile 只在 `TURNSTILE_SITE_KEY` 配了的时候才进 `script-src` 和 `connect-src`。默认状态是零第三方脚本 + 严格 CSP。

统计那个分支更绕。Umami Cloud 的脚本在 `cloud.umami.is`，上报却打到 `gateway.umami.is`，两个不同域。只把脚本源加进 `script-src` 的话，脚本能下载、能执行，CSP 控制台干干净净，但每一条上报都被 `connect-src` 挡掉——表现是"统计接上了，后台一条数据没有"。所以代码把脚本源和采集端分别处理：

```js
const anScript = analytics && analytics.script ? '' '' + analytics.script : '''';
const anConnect = analytics
  ? [...new Set([analytics.script, ...(analytics.collect || [])].filter(Boolean))]
      .map((o) => '' '' + o).join('''')
  : '''';
```

采集端不需要执行脚本，所以它只进 `connect-src`，不进 `script-src`。单测里专门有一条断言这个边界：`analytics 传 null 不炸`，以及 `采集端不同域时 connect-src 必须单独放行它`。这套测试 10 条全过，是为了防止哪天有人"顺手简化"把两个源合并。

## 七、三次误判：nonce 会把相邻环节一起带歪

nonce 不只是一个属性，它会改写整页 HTML 的字节。凡是对页面做字符串匹配的地方，都要重新想一遍。下面三次误判有两次真的发生过，一次是从提交记录里翻出来的。

**第一次：采集脚本抓不到 JSON-LD。** 验收脚本用这条正则抓结构化数据：

```js
const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
```

线上抓到 0 块，断言报「页面没有结构化数据」。实际页面里是：

```html
<script nonce="ZDU1Y2..." type="application/ld+json">
```

`applyNonce()` 给所有 `<script>` 插了 nonce 属性，属性顺序不保证，`type` 不再紧跟 `<script`。正则写死了顺序，自然一个都匹配不到。修法是 `<script[^>]*type="application\/ld\+json"[^>]*>`。

真正值得记的是**报错的方向**：断言说"页面没有结构化数据"，真实情况是"我的采集坏了"。这时候去改页面，就是在修一个不存在的问题。后来我把这两种失败拆开了——`if (blocks.length === 0) throw new Error(''采集失败'')` 和"内容不对"是两种不同性质的错，不能共用一个报错文案。这段已在 `22-ld-self-reference.md` 里单独写过，这里只提它和 nonce 的因果关系。

**第二次：统计接上了，后台一条数据没有。** CSP 拼装最初只把 Umami 的脚本源加进 `script-src`。脚本正常下载、正常执行、控制台没有 CSP 拒绝，但上报地址 `gateway.umami.is` 被 `connect-src` 挡掉了。浏览器对 `connect-src` 违反的提示很容易被当成噪声，排查时盯着"脚本到底执行了没有"这条线，会一路走错方向。提交 `edccc54` 修的就是这个，单测里现在专门有一条守着采集端与脚本源不同域的情况。

**第三次：图片代理会不会给攻击者盖章。** 这条没在线上发生过，是我读代码时发现的边界，做过推理但没实测攻击样本。场景是：上传一个 content-type 被写成 `text/html` 的恶意文件，让它走到 `harden()` 的 HTML 分支，于是 `applyNonce()` 给它内嵌的 `<script>` 签上本站 nonce——CSP 从防线变成通行证。现在的双重防护是 `imageResponse` 把类型降级成 `application/octet-stream`，加上 `harden()` 里对 `x-img-type` 和非 HTML 类型直接跳过 nonce 注入。这条只到代码审查为止，没做过真实攻击验证，实测部分在 `10-r2-image-pipeline.md` 那篇里。

三次误判的共同点是：**nonce 改的是页面字节，不是某个开关**。任何"按原样匹配 HTML"的工具，都会在某一天被它绊一跤。所以我把探针直接写在脚本里，不靠临时手敲 curl——`check-live.mjs` 现在钉了两条：一条在 304 场景检查响应头里没有 `nonce-`，一条在正常响应里检查有。

`check-headers.mjs` 是另一道：安全头在七类路径上都得齐全。刚跑的一次实测，首页、文章、栏目、404 四类带 CSP（`csp=yes`），静态资源、API、301 三类不带——后三类本来就不产出 HTML，没有内联脚本要放行，CSP 头也就不必发。探针不要求它们带，只要求 `nosniff`、`referrer-policy`、`x-frame-options` 三个头在七类路径上都在，这次七类全过。

探针还单独问了 `/cdn-cgi/trace`。这个路径由 Cloudflare 边缘直接返回，不经过 Worker，是判断面板 Transform Rule 有没有落地的可靠信号。这次结果是缺三个头，说明规则还没生效——正常页面不受影响，Worker 那一层已经把头给齐了；但 CF 自己的 1101、52x 错误页和 `/cdn-cgi/*` 上没有。这是两层出口，别把其中一层的通过当成全覆盖。

## 怎么自己验一遍

四道闸各有一条独立的验法，任一条不过就别上线。四道闸守的是同一件事的四个环节，缺一不可：生成、缓存、304、ETag 任何一处出错，表现都不一样。单测守函数行为，线上探针守真实部署，浏览器控制台守最终执行结果——nonce 配错的典型症状是"页面正常、功能静默失效"，前两层都过、只有第三层能发现的情况并不少见。

**1. 验 nonce 每次轮换。** 连打两次同一页，把头里的 nonce 抠出来比对：

```bash
for i in 1 2; do
  curl -s -D - "https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM$RANDOM" \
    -o /dev/null | grep -i "^content-security-policy" | tr -d ''\r'' \
    | grep -o "nonce-[A-Za-z0-9+/=]*" | head -1
done
```

两个值必须不同。相同说明随机数被缓存了，或者根本没走重新生成。

**2. 验头和 body 配对。** 同一次响应里，头的 nonce 必须等于每个 `<script>` 上的 nonce：

```bash
curl -s -D /tmp/hdr.txt "https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM" \
  -o /tmp/body.html
grep -i "^content-security-policy" /tmp/hdr.txt | tr -d ''\r'' \
  | grep -o "nonce-[A-Za-z0-9+/=]*" | head -1
grep -o ''nonce="[A-Za-z0-9+/=]*"'' /tmp/body.html | head -1
```

两行去掉引号后应该是同一个值。

**3. 验 304 不带 CSP。** 先取 ETag，再带 `If-None-Match` 回 request（命令见第四节）。返回 304，且响应头里搜不到 `content-security-policy`。搜得到就是 bug——浏览器会拿新 nonce 配旧 body，页面看着好、功能全丢。

**4. 跑两组单测。**

```bash
node scripts/test-security.mjs   # 10/10
node scripts/test-etag.mjs       # 31 条
```

前者守 CSP 拼装（第三方源、邮箱解码脚本的 nonce、图片响应不签章），后者守 ETag 三段（`tagOf` 归一化、`etagHit` 四类命中写法、`maybe304` 删头）。

**5. 改了 nonce 生成或注入顺序之后**，重跑第 2 步，并在浏览器控制台看一眼有没有 CSP 拒绝日志。内联脚本被挡的时候页面往往不报错，控制台是唯一的线索。
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>CSP nonce 和缓存不是不能共存，但必须同时守住三处配对，外加一道 ETag 归一化：</p>
<p><code>nonce</code> 的全称是 number used once——一次性数字。服务器每次生成页面时抽一个随机数，写进 CSP 头的 <code>script-src</code>，同时打进这个页面每一个内联 <code>&lt;script&gt;</code> 的 <code>nonce</code> 属性，浏览器比对两边，一致才执行。问题在于这个数<strong>每次生成都不一样</strong>，而页面在 CF 边缘能躺 5 分钟：缓存里存的是上一次的 nonce，浏览器手里那份 body 也是上一次的。要是新请求生成了新 nonce、跟着新 CSP 头一起发出去，页面里每一个内联脚本都会因为对不上号被静默丢弃——主题初始化、SSR 引导数据、邮箱解码、评论渲染，一起失效。页面看着完全是好的，什么报错都没有。这不是假想，下面每一处都有线上的响应头和单测兜着。</p>
<div class="table-wrap"><table><thead><tr><th>环节</th><th>要守住什么</th><th>守不住会怎样</th></tr></thead><tbody><tr><td>生成</td><td>头里的 nonce 和 body 里的 nonce 来自同一次 <code>makeNonce()</code></td><td>所有内联脚本被 CSP 挡掉，页面空白或功能全丢</td></tr><tr><td>缓存</td><td>存进 <code>caches.default</code> 的副本，头和 body 必须已经配好对</td><td>缓存命中后回放一份错位的响应，故障随机出现</td></tr><tr><td>304</td><td>不发新的 CSP 头，让浏览器沿用自己缓存里那份</td><td>新 nonce 配旧 body，静默失效且难复现</td></tr><tr><td>ETag</td><td>算指纹前把 nonce 归一化抹平</td><td>每次请求 ETag 都变，304 命中率恒为 0</td></tr></tbody></table></div>
<p>第一处最容易验——头和 body 的 nonce 取同一次 <code>makeNonce()</code> 的值，代码里就是同一个局部变量传两遍，不会错。第二处靠缓存写入的时机，第三处靠 304 出口主动删头，第四处靠归一化正则。四处各管一段链路，任何一处单独拿掉，页面都能正常打开，只是某个环节开始静默失效——这正是这套机制需要四道独立探针、而不是一条端到端测试的原因。</p>
<p>这四处如果拆开看，失效时的症状差别很大，定位方向也不一样：</p>
<div class="table-wrap"><table><thead><tr><th>坏掉的环节</th><th>用户看到什么</th><th>怎么发现</th><th>为什么难查</th></tr></thead><tbody><tr><td>生成：头和 body 不是同一个值</td><td>主题、SSR 数据、评论渲染全失效</td><td>浏览器控制台一片 CSP 拒绝</td><td>页面结构正常，肉眼看不出</td></tr><tr><td>缓存：存进去的副本头 body 错位</td><td>首次访问正常，命中缓存后才坏</td><td>连打两次比对 nonce</td><td>有随机性，刷新有时又好了</td></tr><tr><td>304：发了新 CSP 头</td><td>强迫刷新正常，普通刷新就坏</td><td>带 <code>If-None-Match</code> 打一次</td><td>只在复访时触发，开发环境几乎没有</td></tr><tr><td>ETag：没抹平 nonce</td><td>功能全正常，只是更快不了</td><td>看 <code>cf-cache-status</code> 或数 304 命中</td><td>没有任何报错，纯性能退化</td></tr></tbody></table></div>
<p>第三行和第四行最阴——一个功能是好的，一个是性能没达到，两者都不会有人来报障。它们是我写这几段单测的直接原因。</p>
<p>线上实测的数字（2026-11-18）：</p>
<div class="table-wrap"><table><thead><tr><th>检查项</th><th>结果</th></tr></thead><tbody><tr><td>连续两次请求头里的 nonce</td><td><code>ca937e2e84e4f0f2b64007fbd9bb18b0</code> / <code>ce471719391ef68d1615e365c8022815</code>，确实每次轮换</td></tr><tr><td>同一次响应头 nonce vs body nonce</td><td>头 <code>a91ee031571517cc36d44e1b388b854d</code> = body <code>nonce=&quot;a91ee031571517cc36d44e1b388b854d&quot;</code></td></tr><tr><td>带 <code>If-None-Match</code> 的 304 响应</td><td>状态 304，<code>cache-control</code> 在，<strong><code>content-security-policy</code> 不在</strong></td></tr><tr><td>单测</td><td><code>test-security</code> 10/10、<code>test-etag</code> 31 条全过</td></tr></tbody></table></div>
<p>最反直觉的是第三行：<strong>304 响应里故意没有 CSP 头</strong>。不是漏了，是删的。下面讲为什么。</p>
<h2 id="一-nonce-到底在解哪个矛盾"><a class="h-anchor" href="#一-nonce-到底在解哪个矛盾">#</a>一、nonce 到底在解哪个矛盾</h2>
<p>CSP 的 <code>script-src &#39;self&#39;</code> 只放行同源的<strong>外部</strong>脚本。页面里直接写的 <code>&lt;script&gt;...&lt;/script&gt;</code> 属于内联，一律挡掉。可站点总是有内联脚本：我的主题切换要赶在 CSS 后面执行防闪，SSR 往页面里塞了 <code>window.__SITE__</code> 引导数据，邮箱地址要在客户端解码，评论渲染也有一段。</p>
<p>要么给 <code>script-src</code> 加 <code>&#39;unsafe-inline&#39;</code> 把门敞开，要么给每个内联脚本发一张一次性通行证。nonce 就是后者：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/security.js</span>
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">makeNonce</span>() {
  <span class="tok-k">const</span> buf = <span class="tok-k">new</span> <span class="tok-f">Uint8Array</span>(<span class="tok-n">16</span>);
  crypto.<span class="tok-f">getRandomValues</span>(buf);
  <span class="tok-k">let</span> s = <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">for</span> (<span class="tok-k">const</span> b <span class="tok-k">of</span> buf) s += b.<span class="tok-f">toString</span>(<span class="tok-n">16</span>).<span class="tok-f">padStart</span>(<span class="tok-n">2</span>, <span class="tok-s">&#39;0&#39;</span>);
  <span class="tok-k">return</span> s;
}</code></pre></div>
<p>16 字节随机数转 hex，32 个字符——线上抓到的长度正好是 32：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -D - <span class="tok-s">&quot;https://exia.de5.net/?cb=$RANDOM&quot;</span> -o /dev/null \
  | <span class="tok-k">grep</span> -i <span class="tok-s">&quot;^content-security-policy&quot;</span> | tr -d <span class="tok-s">&#39;\r&#39;</span> \
  | <span class="tok-k">grep</span> -o <span class="tok-s">&#39;nonce-[0-9a-f]*&#39;</span> | head -<span class="tok-n">1</span> | <span class="tok-k">awk</span> <span class="tok-s">&#39;{print length($0)-6}&#39;</span>
<span class="tok-c"># 32</span></code></pre></div>
<p>16 字节 = 128 位熵，攻击者靠猜来撞 nonce 的期望次数是 2¹²⁸，这个数量级不用再讨论。CSP 规范也不要求这么长，但既然 <code>crypto.getRandomValues()</code> 随手就能拿 16 字节，没理由用更短的。</p>
<p>CSP 头里写 <code>script-src &#39;self&#39; &#39;nonce-e1022201…&#39;</code>，页面里每个内联脚本写 <code>&lt;script nonce=&quot;e1022201…&quot;&gt;</code>。浏览器收到的两份值对得上，才执行。</p>
<p>线上抓一份完整的头长这样：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">http</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-http">content-security-policy: default-src <span class="tok-s">&#39;self&#39;</span>; script-src <span class="tok-s">&#39;self&#39;</span> <span class="tok-s">&#39;nonce-e102220156b151bed92e4563ceca1db7&#39;</span>; style-src <span class="tok-s">&#39;self&#39;</span> <span class="tok-s">&#39;unsafe-inline&#39;</span>; img-src <span class="tok-s">&#39;self&#39;</span> data: blob: https:; font-src <span class="tok-s">&#39;self&#39;</span> data:; connect-src <span class="tok-s">&#39;self&#39;</span>; media-src <span class="tok-s">&#39;self&#39;</span> https:; frame-src <span class="tok-s">&#39;self&#39;</span> https:<span class="tok-c">//www.youtube.com https://player.bilibili.com; object-src &#39;none&#39;; base-uri &#39;self&#39;; form-action &#39;self&#39;; frame-ancestors &#39;none&#39;; upgrade-insecure-requests</span></code></pre></div>
<p>连打两次，nonce 分别是 <code>ca937e2e…</code> 和 <code>ce471719…</code>，没有重复。这正是它安全的理由——攻击者没法预猜下一个值，就算往页面里注入了 <code>&lt;script&gt;</code>，也拿不到这次的 nonce。</p>
<p>但同一份随机性，也正是它和缓存打架的根源。</p>
<h2 id="二-第一处配对-头和-body-必须同生共死"><a class="h-anchor" href="#二-第一处配对-头和-body-必须同生共死">#</a>二、第一处配对：头和 body 必须同生共死</h2>
<p>我见过一种写法：先拼 CSP 头，再单独生成 nonce 往 body 里塞，两处各调一次随机函数。这种代码本地一跑就露馅——头里的值和脚本上的值对不上，全部内联脚本被挡。</p>
<p>我的做法是只生成一次，头和 body 用同一个变量：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/index.js，harden() 出口</span>
<span class="tok-k">const</span> nonce = <span class="tok-f">makeNonce</span>();                       <span class="tok-c">// ← 只在这里生成一次</span>
<span class="tok-k">let</span> raw = <span class="tok-k">await</span> res.<span class="tok-f">text</span>();
<span class="tok-k">const</span> ana = <span class="tok-f">analyticsTag</span>(anCfg);
<span class="tok-c">// 放在补 nonce 之前：这段 script 自己也是内联的，得跟别的一起拿到 nonce</span>
<span class="tok-k">if</span> (ana) raw = raw.<span class="tok-f">replace</span>(<span class="tok-s">&#39;&lt;/head&gt;&#39;</span>, ana + <span class="tok-s">&#39;&lt;/head&gt;&#39;</span>);
<span class="tok-c">// 先混淆邮箱再补 nonce：解码脚本是内联的，得跟着一起拿到 nonce</span>
<span class="tok-k">const</span> body = <span class="tok-f">applyNonce</span>(<span class="tok-f">obfuscateEmail</span>(raw), nonce);
<span class="tok-k">const</span> headers = <span class="tok-f">securityHeaders</span>(<span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers), nonce, {
  turnstile: tsOn, analytics: anOn,
});</code></pre></div>
<p><code>applyNonce()</code> 用一条正则给没有 nonce 的 <code>&lt;script&gt;</code> 补上：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/security.js</span>
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">applyNonce</span>(html, n) {
  <span class="tok-k">if</span> (!n) <span class="tok-k">return</span> html;
  <span class="tok-k">return</span> <span class="tok-f">String</span>(html).<span class="tok-f">replace</span>(/&lt;<span class="tok-f">script</span>(?![^&gt;]*\snonce=)/gi, <span class="tok-s">`&lt;script nonce=&quot;${n}&quot;`</span>);
}</code></pre></div>
<p>那个负向前瞻 <code>(?![^&gt;]*\snonce=)</code> 是防止重复打标——已经有 nonce 的脚本跳过。补标必须在所有会插入内联脚本的操作<strong>之后</strong>：统计脚本是后插的，邮箱解码脚本是 <code>obfuscateEmail()</code> 后插的，两者都要赶在 <code>applyNonce()</code> 之前进门，否则会漏掉。顺序写反了，页面照样能看，就是那两个功能悄悄不工作。</p>
<p>补标是无差别的，<code>&lt;script type=&quot;application/ld+json&quot;&gt;</code> 这种纯数据块也会被加上 nonce。线上实测两块都带了：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">html</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-html">&lt;script nonce=<span class="tok-s">&quot;6a6d799fc7ed9c6f27bd4d1d18f377de&quot;</span> type=<span class="tok-s">&quot;application/ld+json&quot;</span>&gt;
&lt;script nonce=<span class="tok-s">&quot;6a6d799fc7ed9c6f27bd4d1d18f377de&quot;</span> type=<span class="tok-s">&quot;application/ld+json&quot;</span>&gt;</code></pre></div>
<p>数据块的 <code>type</code> 不是 JavaScript MIME，浏览器不会执行它，加 nonce 在安全上没有收益。但也没有代价——多 40 来个字节，换来的是一条统一的规则：&quot;所有内联 script 都补&quot;。这比维护一份&quot;哪些要补哪些不用补&quot;的例外清单可靠得多。写正则匹配的时候得记住这件事，第七节那次误判就是栽在这儿。</p>
<p>线上验证过配对确实成立：同一次响应，头 <code>a91ee031…</code>、body <code>nonce=&quot;a91ee031…&quot;</code>，完全一致。</p>
<p>还有一个不那么显眼的分支——图片代理出来的响应<strong>完全不补 nonce</strong>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (res.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;x-img-type&#39;</span>) || !ct.<span class="tok-f">includes</span>(<span class="tok-s">&#39;text/html&#39;</span>)) {
  <span class="tok-k">return</span> <span class="tok-k">new</span> <span class="tok-f">Response</span>(res.body, {
    status: res.status,
    headers: <span class="tok-f">securityHeaders</span>(<span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers), <span class="tok-k">null</span>, { turnstile: tsOn }),
  });
}</code></pre></div>
<p><code>nonce</code> 传的是 <code>null</code>，<code>securityHeaders()</code> 里 <code>if (nonce)</code> 不成立，CSP 头都不发。这一道是防升级攻击：如果攻击者上传一张伪装成图片的 HTML/SVG，里头带 <code>&lt;script&gt;</code>，而出口又顺手给它签上本站 nonce，CSP 的 <code>script-src &#39;nonce-…&#39;</code> 就从&quot;拦截&quot;变成了&quot;盖章放行&quot;。哪怕图片代理那边已经把 <code>content-type</code> 降级成 <code>application/octet-stream</code>，这里也要再挡一道，防止以后有人改坏那个判断。</p>
<h2 id="三-第二处配对-缓存里存的必须是配好对的整份"><a class="h-anchor" href="#三-第二处配对-缓存里存的必须是配好对的整份">#</a>三、第二处配对：缓存里存的必须是配好对的整份</h2>
<p>nonce 在 <code>harden()</code> 里生成，头和 body 当场配好对，然后整份 <code>Response</code> 交给缓存层：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/index.js，缓存写入路径</span>
<span class="tok-k">if</span> (cacheable &amp;&amp; res.status === <span class="tok-n">200</span> &amp;&amp;
    (res.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;content-type&#39;</span>) || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">includes</span>(<span class="tok-s">&#39;text/html&#39;</span>)) {
  <span class="tok-k">const</span> stored = <span class="tok-k">await</span> <span class="tok-f">edgePut</span>(url, res, EDGE_TTL);
  <span class="tok-k">return</span> <span class="tok-f">maybe304</span>(<span class="tok-f">asClient</span>(stored), request);
}</code></pre></div>
<p><code>edgePut()</code> 只改缓存相关的头，不碰 body，也不碰 CSP：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/cache.js</span>
<span class="tok-k">export</span> <span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">edgePut</span>(url, res, ttl = EDGE_TTL, swr = EDGE_SWR) {
  <span class="tok-k">const</span> headers = <span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers);
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, <span class="tok-s">`public, s-maxage=${ttl}, stale-while-revalidate=${swr}`</span>);
  headers.<span class="tok-k">delete</span>(<span class="tok-s">&#39;set-cookie&#39;</span>);
  <span class="tok-k">const</span> copy = <span class="tok-k">new</span> <span class="tok-f">Response</span>(res.body, { status: res.status, statusText: res.statusText, headers });
  <span class="tok-k">try</span> {
    <span class="tok-k">await</span> caches.<span class="tok-k">default</span>.<span class="tok-f">put</span>(<span class="tok-f">cacheUrl</span>(url), copy.<span class="tok-f">clone</span>());
  } <span class="tok-k">catch</span> { <span class="tok-c">/* 配额或非法请求，忽略即可 */</span> }
  <span class="tok-k">return</span> copy;
}</code></pre></div>
<p><code>asClient()</code> 同理，改的只是 <code>cache-control</code> 和 <code>cdn-cache-control</code>。整条链上没有任何一个环节会在缓存命中后&quot;换个新 nonce&quot;——这是设计上的硬约束。缓存里存的是一份已经配好对的快照，命中就整份回放，头和 body 天生配套。</p>
<p>换个说法：nonce 的生命周期到 <code>harden()</code> 就结束了。后面所有环节搬运的是一份 immutable 的响应，谁都不能中途改一半。</p>
<p>这条不是推断，能直接用响应头验。同一页连打三次，走缓存命中：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">第 1 次  CF-Cache-Status: HIT  Age: 85  ETag: &quot;13mm-742d872e&quot;  nonce-c9a54f66…
第 2 次  CF-Cache-Status: HIT  Age: 85  ETag: &quot;13mm-742d872e&quot;  nonce-c9a54f66…
第 3 次  CF-Cache-Status: HIT  Age: 86  ETag: &quot;13mm-742d872e&quot;  nonce-c9a54f66…</code></pre></div>
<p>nonce 三次<strong>完全一样</strong>。这在安全上看着很吓人——&quot;一次性数字用了三次&quot;——但恰恰是对的：这三次都是同一份缓存快照的回放，头和 body 一起被吐出来，两边的 nonce 始终配套。首发那次生成的新 nonce，跟着整份响应存进了缓存。</p>
<p>换个对照，每次带一个随机参数绕开缓存：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">第 1 次  nonce-0d42f802eb501dfa1aee0b509adff323
第 2 次  nonce-ddb13452aa4a330e79b5d8b40444f144
第 3 次  nonce-a1c5143e30c06c9926fd4efe50688de8</code></pre></div>
<p>三次全不同。这才是&quot;每次请求重新生成&quot;的真实样子。</p>
<p>所以 nonce 的正确心智模型不是&quot;每个 HTTP 请求都换&quot;，而是&quot;每次<strong>渲染</strong>都换&quot;。缓存命中不渲染，复用上次的即可。要是有人把生成逻辑挪到缓存之后——每次命中都刷新头里的 nonce 却不动 body——就会造出上面这套机制最怕的错位。</p>
<p>这一条守住之后，缓存命中（不管是 Worker 内的 <code>caches.default</code> 还是 CF 边缘）拿到的都是自洽的响应。真正麻烦的是 304——因为 304 按定义<strong>没有 body</strong>。</p>
<h2 id="四-第三处配对-304-故意不发-csp"><a class="h-anchor" href="#四-第三处配对-304-故意不发-csp">#</a>四、第三处配对：304 故意不发 CSP</h2>
<p>浏览器带 <code>If-None-Match</code> 来，服务端算出来内容没变，回一个 304 让浏览器用自己缓存里的 body。省的是整个响应体：一篇文章页压缩后二十多 KB，304 只有几百字节头。</p>
<p>危险点在这里：如果 304 的响应头里带了一个<strong>新生成</strong>的 CSP，其中包含新 nonce，而浏览器手里那份 body 是上一次的、带着旧 nonce——两边对不上，页面所有内联脚本一起失效。</p>
<p>我在 <code>maybe304()</code> 里直接把 CSP 头删掉：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span><span class="code-ln">21 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21</span><code class="language-js"><span class="tok-c">// src/index.js</span>
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">maybe304</span>(res, request) {
  <span class="tok-k">if</span> (request.method !== <span class="tok-s">&#39;GET&#39;</span> &amp;&amp; request.method !== <span class="tok-s">&#39;HEAD&#39;</span>) <span class="tok-k">return</span> res;
  <span class="tok-k">if</span> (res.status !== <span class="tok-n">200</span>) <span class="tok-k">return</span> res;
  <span class="tok-k">const</span> etag = res.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;etag&#39;</span>);
  <span class="tok-k">if</span> (!etag) <span class="tok-k">return</span> res;
  <span class="tok-k">if</span> (!<span class="tok-f">etagHit</span>(request.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;if-none-match&#39;</span>), etag)) <span class="tok-k">return</span> res;
  <span class="tok-k">const</span> headers = <span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers);
  headers.<span class="tok-k">delete</span>(<span class="tok-s">&#39;content-encoding&#39;</span>);
  headers.<span class="tok-k">delete</span>(<span class="tok-s">&#39;content-length&#39;</span>);
  <span class="tok-c">/* 这一行是整个 304 里最容易踩死人的地方。
     CSP 头里带着本次请求新生成的 nonce，而浏览器手里那份 body 里是**上一次**的
     nonce。把新 CSP 发过去，页面所有内联脚本的 nonce 全部对不上 —— 主题初始化、
     SSR 引导数据、评论渲染会一起静默失效，页面看着是好的，功能全没了。
     删掉这个头，浏览器会沿用缓存里那份响应自带的 CSP（RFC 9111：304 未提供的
     头保持不变），body 与 nonce 就还是配套的。 */</span>
  headers.<span class="tok-k">delete</span>(<span class="tok-s">&#39;content-security-policy&#39;</span>);
  headers.<span class="tok-k">delete</span>(<span class="tok-s">&#39;content-security-policy-report-only&#39;</span>);
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, <span class="tok-f">pageCacheControl</span>());
  <span class="tok-k">return</span> <span class="tok-k">new</span> <span class="tok-f">Response</span>(<span class="tok-k">null</span>, { status: <span class="tok-n">304</span>, headers });
}</code></pre></div>
<p>依据是 RFC 9111：304 响应没提供的头，客户端继续沿用缓存里那份。删掉 CSP，浏览器就继续用它保存的那份 200 响应里的 CSP——那份的 nonce 正好和它手里的 body 配套。</p>
<p>线上实测确认了这个行为：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash">ETAG=<span class="tok-f">$</span>(<span class="tok-k">curl</span> -s -D - -o /dev/null <span class="tok-s">&quot;https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM&quot;</span> \
  | <span class="tok-k">grep</span> -i <span class="tok-s">&quot;^etag:&quot;</span> | tr -d <span class="tok-s">&#39;\r&#39;</span> | cut -d<span class="tok-s">&#39; &#39;</span> -f2-)
<span class="tok-k">curl</span> -s -D - -o /dev/null -H <span class="tok-s">&quot;If-None-Match: $ETAG&quot;</span> \
  <span class="tok-s">&quot;https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM&quot;</span> \
  | <span class="tok-k">grep</span> -iE <span class="tok-s">&quot;^HTTP/|^etag:|^content-security-policy|^cache-control&quot;</span></code></pre></div>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400</code></pre></div>
<p><code>content-security-policy</code> 一行都没有。单测里也钉了一条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">t</span>(!hit.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;content-security-policy&#39;</span>),
  <span class="tok-s">&#39;304 不发新 CSP（新 nonce 会打死浏览器里那份旧 body 的内联脚本）&#39;</span>);</code></pre></div>
<p>注意 <code>content-encoding</code> 和 <code>content-length</code> 也是必须删的——304 没有 body，留着这两个头会让某些客户端等一个永远不会来的实体。</p>
<h2 id="五-第四道闸-etag-必须把-nonce-抹平"><a class="h-anchor" href="#五-第四道闸-etag-必须把-nonce-抹平">#</a>五、第四道闸：ETag 必须把 nonce 抹平</h2>
<p>前三处守住，头和 body 配对没问题了，还有一个更隐蔽的坑：ETag。</p>
<p><code>maybe304()</code> 只是&quot;能返回 304&quot;，前提是请求里的 <code>If-None-Match</code> 得先匹配上。ETag 这一层要是被 nonce 搅乱，前面三处配得再齐，304 一次都不会发生——用户每次都收到完整 200，nonce 配对也就没有了用武之地。</p>
<p>ETag 是内容的指纹。nonce 每次请求都随机，意味着<strong>每一个页面的 body 每次都不同</strong>。如果老老实实对完整 body 算 hash，ETag 每次请求都变，浏览器发来的 <code>If-None-Match</code> 永远匹配不上，304 命中率恒为 0。表面上功能齐全——ETag 有、304 逻辑有、注释写得清清楚楚——实际一次都没生效。</p>
<p>这就是&quot;算了个 ETag&quot;和&quot;304 能工作&quot;之间的距离。我的做法是在 <code>tagOf()</code> 里先把会变的地方归一化：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/utils.js</span>
<span class="tok-k">const</span> VOLATILE = /刚刚|\d+\s*(?:秒|分钟|小时|天|个月|年)前/g;
<span class="tok-k">const</span> NONCE = /\snonce=<span class="tok-s">&quot;[0-9a-f]{8,}&quot;</span>/g;

<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">tagOf</span>(body) {
  <span class="tok-k">const</span> s = <span class="tok-f">String</span>(body).<span class="tok-f">replace</span>(VOLATILE, <span class="tok-s">&#39;~t~&#39;</span>).<span class="tok-f">replace</span>(NONCE, <span class="tok-s">&#39; nonce=&quot;~&quot;&#39;</span>);
  <span class="tok-k">let</span> h = <span class="tok-n">0x811c9dc5</span>;
  <span class="tok-k">for</span> (<span class="tok-k">let</span> i = <span class="tok-n">0</span>; i &lt; s.length; i++) {
    h ^= s.<span class="tok-f">charCodeAt</span>(i);
    h = Math.<span class="tok-f">imul</span>(h, <span class="tok-n">0x01000193</span>);
  }
  <span class="tok-k">return</span> <span class="tok-s">`&quot;${s.length.toString(36)}-${(h &gt;&gt;&gt; 0).toString(16)}&quot;`</span>;
}</code></pre></div>
<p><code>NONCE</code> 把 <code>nonce=&quot;a1b2c3…&quot;</code> 换成固定的 <code>nonce=&quot;~&quot;</code>，<code>VOLATILE</code> 把&quot;3 分钟前&quot;这类相对时间也抹平。两处都是每次请求会变、但语义上不该让页面失效的地方。</p>
<p>这里有个中文坑值得单独记：<code>VOLATILE</code> 正则不能用 <code>\b</code> 画边界。JS 的 <code>\b</code> 只认 ASCII 单词字符，中文旁边根本不存在&quot;边界&quot;，写了等于没写。这个错第一次就是被单测抓出来的——三条相对时间断言全红。代价是正文里&quot;3 天前&quot;这种叙述也会被归一化，但那只会让两个不同页面的 ETag 更容易撞，不影响正确性。</p>
<p><strong>为什么不用内容 hash 而用这种短指纹。</strong> 页面 30KB 左右，每次请求算一遍 SHA-256 在 Workers 里不是不能做，但这里要的是&quot;判断变没变&quot;，不是密码学强度。FNV-1a 这种 32 位滚动哈希够用，配合长度前缀把碰撞概率压到可接受范围。真正决定它可不可靠的是归一化做没做对，不是哈希算法本身——一个没抹平 nonce 的 SHA-256，照样每次都变。</p>
<p><strong>非 200 的页面不走这套缓存。</strong> <code>harden()</code> 里按状态码分流：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> normal = res.status &gt;= <span class="tok-n">200</span> &amp;&amp; res.status &lt; <span class="tok-n">400</span>;
<span class="tok-k">if</span> (normal) {
  <span class="tok-k">if</span> (!cc.<span class="tok-f">includes</span>(<span class="tok-s">&#39;no-store&#39;</span>) &amp;&amp; !cc.<span class="tok-f">includes</span>(<span class="tok-s">&#39;private&#39;</span>)) headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, <span class="tok-f">pageCacheControl</span>());
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cdn-cache-control&#39;</span>, <span class="tok-s">`public, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`</span>);
} <span class="tok-k">else</span> <span class="tok-k">if</span> (!headers.<span class="tok-f">has</span>(<span class="tok-s">&#39;cache-control&#39;</span>) || cc === <span class="tok-s">&#39;no-cache&#39;</span>) {
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, res.status === <span class="tok-n">404</span> ? <span class="tok-s">&#39;public, max-age=0, s-maxage=60&#39;</span> : <span class="tok-s">&#39;no-store&#39;</span>);
}</code></pre></div>
<p>404 只压 60 秒，500 一律 <code>no-store</code>。原因写在注释里：一张 404 页在边缘压 300 秒，意味着刚发布的文章地址会在 5 分钟里继续回 404；一张 500 页被缓存，一次数据库抖动会被定格成整站错误页。nonce 在这些页面上照样生成、照样配对，但它们不进 304 那条链路，<code>maybe304()</code> 第一句 <code>if (res.status !== 200) return res</code> 就把它们挡在外面了。</p>
<p>ETag 还必须用<strong>强校验</strong>（带引号、不带 <code>W/</code>）。这是 Cloudflare 边缘自己能答 304 的前提。这篇文章页实测未压缩 62701 字节、Brotli 后 22055 字节，带上 <code>If-None-Match</code> 命中时是 304 + 0 字节响应体。弱 <code>W/</code> tag 下边缘会不会放弃自己答 304、把请求转给 Worker，这条我没单独做对照实验，只到机制推断为止；能确认的是 <code>tagOf()</code> 返回的是 <code>&quot;长度-哈希&quot;</code> 这种强 tag 格式，线上抓到的是 <code>ETag: &quot;13mm-742d872e&quot;</code>。</p>
<p><strong><code>If-None-Match</code> 的写法不止一种，四类都得认。</strong> 浏览器发来的不一定就是你发出去的那个字符串。规范允许 <code>*</code>，允许多个 tag 用逗号分隔，允许带 <code>W/</code> 弱前缀。整体等值比较看着省事，实际漏掉大半：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/index.js</span>
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">etagHit</span>(header, etag) {
  <span class="tok-k">if</span> (!header) <span class="tok-k">return</span> <span class="tok-k">false</span>;
  <span class="tok-k">if</span> (header.<span class="tok-f">trim</span>() === <span class="tok-s">&#39;*&#39;</span>) <span class="tok-k">return</span> <span class="tok-k">true</span>;
  <span class="tok-k">const</span> bare = (s) =&gt; s.<span class="tok-f">trim</span>().<span class="tok-f">replace</span>(/^W\<span class="tok-c">//, &#39;&#39;);</span>
  <span class="tok-k">const</span> mine = <span class="tok-f">bare</span>(etag);
  <span class="tok-k">return</span> header.<span class="tok-f">split</span>(<span class="tok-s">&#39;,&#39;</span>).<span class="tok-f">some</span>((t) =&gt; <span class="tok-f">bare</span>(t) === mine);
}</code></pre></div>
<p>四类命中写法，加上不匹配不命中，五种情况都钉在单测里：完全一致命中、去掉 <code>W/</code> 命中、逗号列表里含目标命中、<code>*</code> 命中、不匹配不命中。这层和 nonce 没有直接关系，但它是 304 链路上最容易被&quot;简化&quot;掉的一段——砍掉之后功能表面正常，只是命中率掉一大截，和 ETag 被 nonce 污染是同一种静默故障。</p>
<p>归一化不能做过头。<code>test-etag.mjs</code> 里钉了正反两组：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> n1 = <span class="tok-f">tagOf</span>(<span class="tok-s">&#39;&lt;script nonce=&quot;a1b2c3d4e5f60718&quot;&gt;x()&lt;/script&gt;&#39;</span>);
<span class="tok-k">const</span> n2 = <span class="tok-f">tagOf</span>(<span class="tok-s">&#39;&lt;script nonce=&quot;9988776655443322&quot;&gt;x()&lt;/script&gt;&#39;</span>);
<span class="tok-f">t</span>(n1 === n2, <span class="tok-s">&#39;CSP nonce 变化不影响 ETag&#39;</span>);
<span class="tok-f">t</span>(<span class="tok-f">tagOf</span>(<span class="tok-s">&#39;&lt;script nonce=&quot;a1b2c3d4e5f60718&quot;&gt;x()&lt;/script&gt;&#39;</span>) !==
  <span class="tok-f">tagOf</span>(<span class="tok-s">&#39;&lt;script nonce=&quot;a1b2c3d4e5f60718&quot;&gt;y()&lt;/script&gt;&#39;</span>),
  <span class="tok-s">&#39;脚本内容本身变化仍让 ETag 变&#39;</span>);</code></pre></div>
<p>nonce 变了不算内容变，脚本里的 <code>x()</code> 变成 <code>y()</code> 必须算。31 条 ETag 单测里，这组占了两条。</p>
<p>还有一处不能有 ETag：<code>html()</code> 构造函数刻意不算。它生成的 body 后面还要被 <code>injectTheme</code> 和 <code>harden</code> 两次改写，在那时算出来的指纹对应的是&quot;注入前&quot;的页面。ETag 统一在出口的 <code>withEtag()</code> 里按最终 body 重算，而且无条件重算——首页模板自带一个静态文件 ETag，那是&quot;注入前&quot;的值，直接拿来用会让站点设置改了、访客却一直看到旧页面。</p>
<h2 id="六-csp-其余指令的连带约束"><a class="h-anchor" href="#六-csp-其余指令的连带约束">#</a>六、CSP 其余指令的连带约束</h2>
<p>nonce 解决的是脚本执行，CSP 头里其他几项也各有取舍，顺手记在这里。</p>
<p><code>style-src</code> 保留了 <code>&#39;unsafe-inline&#39;</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-s">&quot;style-src &#39;self&#39; &#39;unsafe-inline&#39;&quot;</span>,</code></pre></div>
<p>主题和 Markdown 渲染大量用 <code>style</code> 属性，要收掉就得把整个样式体系改成外部类。这是一笔明确的交换——脚本那道门守死了，样式属性放行。</p>
<p>第三方脚本按配置放行，没配就一个字节都不放：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> ts = turnstile ? <span class="tok-s">&#39; https://challenges.cloudflare.com&#39;</span> : <span class="tok-s">&#39;&#39;</span>;</code></pre></div>
<p>Turnstile 只在 <code>TURNSTILE_SITE_KEY</code> 配了的时候才进 <code>script-src</code> 和 <code>connect-src</code>。默认状态是零第三方脚本 + 严格 CSP。</p>
<p>统计那个分支更绕。Umami Cloud 的脚本在 <code>cloud.umami.is</code>，上报却打到 <code>gateway.umami.is</code>，两个不同域。只把脚本源加进 <code>script-src</code> 的话，脚本能下载、能执行，CSP 控制台干干净净，但每一条上报都被 <code>connect-src</code> 挡掉——表现是&quot;统计接上了，后台一条数据没有&quot;。所以代码把脚本源和采集端分别处理：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> anScript = analytics &amp;&amp; analytics.script ? <span class="tok-s">&#39; &#39;</span> + analytics.script : <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">const</span> anConnect = analytics
  ? [...<span class="tok-k">new</span> <span class="tok-f">Set</span>([analytics.script, ...(analytics.collect || [])].<span class="tok-f">filter</span>(Boolean))]
      .<span class="tok-f">map</span>((o) =&gt; <span class="tok-s">&#39; &#39;</span> + o).<span class="tok-f">join</span>(<span class="tok-s">&#39;&#39;</span>)
  : <span class="tok-s">&#39;&#39;</span>;</code></pre></div>
<p>采集端不需要执行脚本，所以它只进 <code>connect-src</code>，不进 <code>script-src</code>。单测里专门有一条断言这个边界：<code>analytics 传 null 不炸</code>，以及 <code>采集端不同域时 connect-src 必须单独放行它</code>。这套测试 10 条全过，是为了防止哪天有人&quot;顺手简化&quot;把两个源合并。</p>
<h2 id="七-三次误判-nonce-会把相邻环节一起带歪"><a class="h-anchor" href="#七-三次误判-nonce-会把相邻环节一起带歪">#</a>七、三次误判：nonce 会把相邻环节一起带歪</h2>
<p>nonce 不只是一个属性，它会改写整页 HTML 的字节。凡是对页面做字符串匹配的地方，都要重新想一遍。下面三次误判有两次真的发生过，一次是从提交记录里翻出来的。</p>
<p><strong>第一次：采集脚本抓不到 JSON-LD。</strong> 验收脚本用这条正则抓结构化数据：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> re = /&lt;script type=<span class="tok-s">&quot;application\/ld\+json&quot;</span>&gt;([\s\S]*?)&lt;\/script&gt;/g;</code></pre></div>
<p>线上抓到 0 块，断言报「页面没有结构化数据」。实际页面里是：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">html</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-html">&lt;script nonce=<span class="tok-s">&quot;ZDU1Y2...&quot;</span> type=<span class="tok-s">&quot;application/ld+json&quot;</span>&gt;</code></pre></div>
<p><code>applyNonce()</code> 给所有 <code>&lt;script&gt;</code> 插了 nonce 属性，属性顺序不保证，<code>type</code> 不再紧跟 <code>&lt;script</code>。正则写死了顺序，自然一个都匹配不到。修法是 <code>&lt;script[^&gt;]*type=&quot;application\/ld\+json&quot;[^&gt;]*&gt;</code>。</p>
<p>真正值得记的是<strong>报错的方向</strong>：断言说&quot;页面没有结构化数据&quot;，真实情况是&quot;我的采集坏了&quot;。这时候去改页面，就是在修一个不存在的问题。后来我把这两种失败拆开了——<code>if (blocks.length === 0) throw new Error(&#39;采集失败&#39;)</code> 和&quot;内容不对&quot;是两种不同性质的错，不能共用一个报错文案。这段已在 <code>22-ld-self-reference.md</code> 里单独写过，这里只提它和 nonce 的因果关系。</p>
<p><strong>第二次：统计接上了，后台一条数据没有。</strong> CSP 拼装最初只把 Umami 的脚本源加进 <code>script-src</code>。脚本正常下载、正常执行、控制台没有 CSP 拒绝，但上报地址 <code>gateway.umami.is</code> 被 <code>connect-src</code> 挡掉了。浏览器对 <code>connect-src</code> 违反的提示很容易被当成噪声，排查时盯着&quot;脚本到底执行了没有&quot;这条线，会一路走错方向。提交 <code>edccc54</code> 修的就是这个，单测里现在专门有一条守着采集端与脚本源不同域的情况。</p>
<p><strong>第三次：图片代理会不会给攻击者盖章。</strong> 这条没在线上发生过，是我读代码时发现的边界，做过推理但没实测攻击样本。场景是：上传一个 content-type 被写成 <code>text/html</code> 的恶意文件，让它走到 <code>harden()</code> 的 HTML 分支，于是 <code>applyNonce()</code> 给它内嵌的 <code>&lt;script&gt;</code> 签上本站 nonce——CSP 从防线变成通行证。现在的双重防护是 <code>imageResponse</code> 把类型降级成 <code>application/octet-stream</code>，加上 <code>harden()</code> 里对 <code>x-img-type</code> 和非 HTML 类型直接跳过 nonce 注入。这条只到代码审查为止，没做过真实攻击验证，实测部分在 <code>10-r2-image-pipeline.md</code> 那篇里。</p>
<p>三次误判的共同点是：<strong>nonce 改的是页面字节，不是某个开关</strong>。任何&quot;按原样匹配 HTML&quot;的工具，都会在某一天被它绊一跤。所以我把探针直接写在脚本里，不靠临时手敲 curl——<code>check-live.mjs</code> 现在钉了两条：一条在 304 场景检查响应头里没有 <code>nonce-</code>，一条在正常响应里检查有。</p>
<p><code>check-headers.mjs</code> 是另一道：安全头在七类路径上都得齐全。刚跑的一次实测，首页、文章、栏目、404 四类带 CSP（<code>csp=yes</code>），静态资源、API、301 三类不带——后三类本来就不产出 HTML，没有内联脚本要放行，CSP 头也就不必发。探针不要求它们带，只要求 <code>nosniff</code>、<code>referrer-policy</code>、<code>x-frame-options</code> 三个头在七类路径上都在，这次七类全过。</p>
<p>探针还单独问了 <code>/cdn-cgi/trace</code>。这个路径由 Cloudflare 边缘直接返回，不经过 Worker，是判断面板 Transform Rule 有没有落地的可靠信号。这次结果是缺三个头，说明规则还没生效——正常页面不受影响，Worker 那一层已经把头给齐了；但 CF 自己的 1101、52x 错误页和 <code>/cdn-cgi/*</code> 上没有。这是两层出口，别把其中一层的通过当成全覆盖。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>四道闸各有一条独立的验法，任一条不过就别上线。四道闸守的是同一件事的四个环节，缺一不可：生成、缓存、304、ETag 任何一处出错，表现都不一样。单测守函数行为，线上探针守真实部署，浏览器控制台守最终执行结果——nonce 配错的典型症状是&quot;页面正常、功能静默失效&quot;，前两层都过、只有第三层能发现的情况并不少见。</p>
<p><strong>1. 验 nonce 每次轮换。</strong> 连打两次同一页，把头里的 nonce 抠出来比对：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">for</span> i in <span class="tok-n">1</span> <span class="tok-n">2</span>; <span class="tok-k">do</span>
  <span class="tok-k">curl</span> -s -D - <span class="tok-s">&quot;https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM$RANDOM&quot;</span> \
    -o /dev/null | <span class="tok-k">grep</span> -i <span class="tok-s">&quot;^content-security-policy&quot;</span> | tr -d <span class="tok-s">&#39;\r&#39;</span> \
    | <span class="tok-k">grep</span> -o <span class="tok-s">&quot;nonce-[A-Za-z0-9+/=]*&quot;</span> | head -<span class="tok-n">1</span>
<span class="tok-k">done</span></code></pre></div>
<p>两个值必须不同。相同说明随机数被缓存了，或者根本没走重新生成。</p>
<p><strong>2. 验头和 body 配对。</strong> 同一次响应里，头的 nonce 必须等于每个 <code>&lt;script&gt;</code> 上的 nonce：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -D /tmp/hdr.txt <span class="tok-s">&quot;https://exia.de5.net/p/worker-cron-friend-check?cb=$RANDOM&quot;</span> \
  -o /tmp/body.html
<span class="tok-k">grep</span> -i <span class="tok-s">&quot;^content-security-policy&quot;</span> /tmp/hdr.txt | tr -d <span class="tok-s">&#39;\r&#39;</span> \
  | <span class="tok-k">grep</span> -o <span class="tok-s">&quot;nonce-[A-Za-z0-9+/=]*&quot;</span> | head -<span class="tok-n">1</span>
<span class="tok-k">grep</span> -o <span class="tok-s">&#39;nonce=&quot;[A-Za-z0-9+/=]*&quot;&#39;</span> /tmp/body.html | head -<span class="tok-n">1</span></code></pre></div>
<p>两行去掉引号后应该是同一个值。</p>
<p><strong>3. 验 304 不带 CSP。</strong> 先取 ETag，再带 <code>If-None-Match</code> 回 request（命令见第四节）。返回 304，且响应头里搜不到 <code>content-security-policy</code>。搜得到就是 bug——浏览器会拿新 nonce 配旧 body，页面看着好、功能全丢。</p>
<p><strong>4. 跑两组单测。</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> scripts/test-security.mjs   <span class="tok-c"># 10/10</span>
<span class="tok-k">node</span> scripts/test-etag.mjs       <span class="tok-c"># 31 条</span></code></pre></div>
<p>前者守 CSP 拼装（第三方源、邮箱解码脚本的 nonce、图片响应不签章），后者守 ETag 三段（<code>tagOf</code> 归一化、<code>etagHit</code> 四类命中写法、<code>maybe304</code> 删头）。</p>
<p><strong>5. 改了 nonce 生成或注入顺序之后</strong>，重跑第 2 步，并在浏览器控制台看一眼有没有 CSP 拒绝日志。内联脚本被挡的时候页面往往不报错，控制台是唯一的线索。</p>', '', 'teardown', 'nonce 是每次渲染换、不是每个请求换：缓存命中回放整份配对快照。304 必须删掉 CSP 头，ETag 必须抹平 nonce，否则一个静默失效、一个命中率恒为零。',
        '', 0, 0, 0, 1, '2027-03-03 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'csp-nonce-cache' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('cache') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'csp-nonce-cache' AND t.name = 'cache';
INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'csp-nonce-cache' AND t.name = 'cloudflare';
