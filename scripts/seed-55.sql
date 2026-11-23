-- 由 scripts/seed-55.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径
-- 排期 2027-02-10（周三）09:00 北京时间，接在 monaco-eol-crlf（02-03）之后

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('gate-only-covered-the-honest-half', '六条断言查了五条：材料把我们自己的 CI 当成了文章', '# 六条断言查了五条：材料把我们自己的 CI 当成了文章

## 结论

材料开头那句判断是准的——「每篇都在立标准，但没有任何一条标准被机器守住」。它错在**病历太旧**：它列的六条断言里，五条早就在 `npm test` 里跑着；它列的三个功能缺口，两个已经上线（评论 Webhook、两级回复），第三个（多文隔离）是上一轮刚做完的。

真正剩下的只有两条，而且都不在它的清单里：

1. **请求体闸门只挡得住诚实的那一半**。顶层看 `content-length`，15 个写入口里 14 个还在裸解析——其中 12 个是 `await request.json()`，两个是 `await request.formData()`。报个 `3` 推 1MB，闸门连看都不看一眼。
2. **蜜罐没有断言**，而且材料把它的返回值写反了：本站是 400，不是 200。

另外把 sticky 的**成因**从「只存在于真机脚本」搬进了 CI——那一条材料说对了方向，但理由不是它写的那个。

## 一、六条断言，逐条查

| 材料要的断言 | 本站现状 | 在哪 |
|---|---|---|
| 渲染器顺序守护：把转义挪后一行，测试必须变红 | **已有**，而且比要求更狠 | `test-md-guard.mjs`：M1 把 `esc` 换成恒等函数、M2 拆掉协议白名单，两个变异体都必须被抓到（分别红 5 条 / 3 条）；另有一条**顺序哨兵**直接比较源码位置 `indexOf(''s = esc(s)'') < indexOf(''s.replace(IMG_RE'')` |
| `isPartOf` 不指向自己、不出现 URL 循环 | **已有**，还带线上体检 | `test-seo-series.mjs`「isPartOf 指向 `/series/<名称>`，不是文章自己」+ `assert.notEqual(a.isPartOf.url, base.url)`；`check-ld.mjs` 线上逐篇抓 JSON-LD，自指单独报一行 |
| 文章页含 CSP / nosniff / 无 `X-XSS-Protection` | **已有**，颗粒度到指令 | `test-headers.mjs` 的 `[P-024]`：nonce 必须在 `script-src` 里、`unsafe-inline`/`unsafe-eval` 不许出现、`base-uri`/`frame-ancestors`/`form-action` 逐条比、任何指令出现 `*` 直接红；`X-XSS-Protection` 只接受 `0` 或缺省 |
| 蜜罐命中返回 200 假成功 | **材料写反了**：本站返回 400；而且此前**确实没有断言** | 本轮新增，见第三节 |
| sticky 父格高度 > 336px、目录停 86px | 成因**没有** CI 断言，现象只有真机脚本 | 本轮新增 `test-sticky-css.mjs`，见第四节 |
| `/img/` 响应带 nosniff、拒绝内网地址 | **前半已有**；后半不适用 | `test-svg.mjs` + `test-headers.mjs` 的 nosniff；`/img/` 只读 R2 对象、不发任何出站请求（不是 URL 代理），真正的「拒绝内网」在 `cron.js` 的 `isBlockedHost()`，`test-cron.mjs` 8/8 |

关于 CSP，这是第四次收到「你站没有 CSP」了。`src/security.js` 的 `csp()` 从 v1.2 起就是 **enforcing**，`s-maxage=300` 与 nonce 并存的前提是「可缓存页面零反射面」——文章页的 HTML 里每个内联脚本都带当次 nonce，没有一处来自用户输入。材料让「先 Report-Only 跑一周」，对本站是退步：Report-Only 不发 nonce 违规报告以外的任何保护，跑一周等于拆掉一层防线一周。

顺带把另外三条也核了：

- **评论无 Webhook / 无回复**：`src/webhook.js` 按域名生成企微 / 飞书 / Discord / Slack 四种结构（`test-webhook.mjs`），回复走 `parent_id`，服务端强制两级（回子评论时归到顶级，`api.js` 里那段注释写着为什么）。
- **无 `visibility` 字段**：不加。`published_at` / `is_private` / `review_status` / `hidden` 四个开关已经把「可见性」拆成四个正交维度，再加一个 `visibility` 就是第五个需要跟其余四个对齐的状态位——多用户叙事里最贵的从来不是字段，是状态位之间的组合合法性。
- **多文编辑无隔离**：上一轮做完了（页签 + 每篇一个 Monaco model + 异步入口捕获 doc 快照），`test-editor-multidoc.mjs` MM-01~09。

## 二、真缺口一：闸门写在顶层，解析写在分支

顶层确实有闸门，一行：

```js
if (method !== ''GET'' && method !== ''HEAD'' && bodyTooLarge(request, bodyCapFor(path))) {
  return json({ ok: false, error: ''请求体太大'' }, 413, { ''cache-control'': ''no-store'' });
}
```

`bodyTooLarge()` 只读 `content-length`。这个头是**对方声明的**，不是事实。报 `3`、推 1MB；或者分块上传干脆不给这个头——顶层全放行，请求一路走到分支里的 `const body = await request.json()`，整个包读进 128MB 的 isolate 再解析。

当时只有一个接口做了按流计数（[发评论](/p/comment-anti-spam) 那条路，全站唯一匿名可灌数据的入口）。其余 12 个因为「要登录」被默认放过：文章增改、AI 摘要、审核、评论处置、批量删、封 IP、友链增改、站点设置、直传签名。登录只挡得住伪造身份，挡不住一个被盗的 cookie 拿你的额度烧 CPU。

还有两个入口是同一个坑的另一种长相：`request.formData()`。头像上传与图片直传都写着 `await request.formData()`——它内部同样把整个 body 读进内存，只是因为「像浏览器帮我解析好了」而不容易被当成出口。

修法不是把顶层写得更严（它拿不到事实），而是让所有分支只剩一条读体路径：

```js
async function readBody(request, path, { lenient = false } = {}) {
  const rd = await readJsonLimited(request, bodyCapFor(path));
  if (rd.tooBig) return { res: json({ ok: false, error: ''请求体太大'' }, 413, { ''cache-control'': ''no-store'' }) };
  if (!rd.body) {
    if (lenient) return { body: {} };
    return { res: err(''请求格式不正确'') };
  }
  return { body: rd.body };
}
```

两个设计决定：

- **和顶层共用 `bodyCapFor(path)`**。否则会出现「顶层按 64KB 拦、分支按 1MB 放」的错位——同一张表，两处都读，改一处不会分叉（P-030 的老毛病）。
- **连「回什么」一起定好**，返回 `{ body }` 或 `{ res }`，调用方只写 `if (rb.res) return rb.res;`。把 413 漏掉的机会从「每个人自觉」变成「不这么写就跑不通」。

13 个 JSON 分支现在全部走它。`lenient` 留给开关类接口（审核动作、评论处置、批量删、封 IP、摘要）：空 body / 坏 JSON 一律当 `{}`，保持它们原来 `.catch(() => ({}))` 的语义；写正文、上传、站点设置必须报 400。

表单那条路另有一个 `readForm(request, path)`，内容和它对称：`readFormLimited()` 先按流数一遍（与 JSON 共用 `readBytesLimited`，只写一份计数逻辑），再把手里的字节包成 `Response` 交给 `.formData()` 解析——boundary 在 `content-type` 里，原样搬过去就行。数量本身没有分叉：两条路都读 `bodyCapFor(path)`（上传与头像 8MB）。

修完发版，线上真打了一次。用分块流直接推 1.1MB、故意不给 `content-length`：

| 请求 | 结果 |
|---|---|
| 64KB × 17 块（1.1MB），`POST /api/comments` | `413` + `请求体太大`，第 1,179,648 字节就到头，`reader.cancel()` 之后一块都不再读 |

这就是新旧代码的分界线：旧代码会把整包读完，再走到别的错误分支（或撞 DB）；新代码在超限的那一块断流，花费的是 1.1MB 带宽而不是「读满 + 解析」的 CPU。

## 三、真缺口二：蜜罐的断言不能只写「拦住了」

材料说蜜罐返回 200 假成功。本站是 400：

```js
if (String(body.hp || '''').trim()) return err(''验证没通过，刷新页面再试一次'', 400);
```

但它的判断有一半是对的：**这条行为此前没有任何断言**。改 `400` 成 `200`、或者把蜜罐挪到 INSERT 之后，`npm test` 一条都不会红。

新断言用假 D1 真跑一次 `handleApi`，不读源码猜顺序：

| 断言 | 内容 |
|---|---|
| 命中 → 400 | 状态码必须是 400（200 会让前端当成功，403 会暴露拦截点） |
| 命中 → 零 INSERT | 拦住的不能只是响应，垃圾不能落库 |
| 命中 → 不动限流表 | 没过闸门就不该消耗额度（`comment_guard` 一次都不许碰） |

假 D1 只需要两个查询的返回值（`FROM posts` 与 `FROM settings`），其余照常抛。这个手法比「读源码找 `hp` 字符串」可靠一个量级：源码里字符串还在、顺序换了呢？

## 四、sticky：把成因搬进 CI

`check-toc-sticky.mjs` 是真机检查：起浏览器、滚 1200px、量 `getBoundingClientRect()`。它写得很好，但它**不在 `npm test` 里**——需要浏览器和线上地址。也就是说，那条真出过事的规则在 CI 里是无人看守的：

> grid 里写 `align-items: start`，父格缩成 336px，`position: sticky` 立刻退化成 `relative`。而且只有长文章看得出来。

这条规则是 [那次 sticky 复盘](/p/sticky-toc-grid-align-items) 的产物。文章里这句话的后半段是致命的：**CI 里没有长文章**。

所以新增 `test-sticky-css.mjs`，守成因（CSS 那三行），真机那份守现象（滚 1200px 还在原位）：

| 编号 | 断言 |
|---|---|
| SC-01 | `.post-article` 用 `align-items: stretch`，出现 `start`/`flex-start` 即红 |
| SC-02 | `.post-toc` 有 `align-self: stretch`（父格拉满，子项才跟着拉满） |
| SC-03 | `.toc-inner` 是 `sticky`、`top: 86px`、`max-height: calc(100vh - Npx)`、`overflow: auto` |
| SC-04 | 真机脚本仍在（成因断言不能替代现象断言） |
| SC-05 | 变异自检：把 `stretch` 换成 `start` 时 SC-01 的匹配必须失效 |

SC-05 是这条的「没验证过会失败的断言等于没写」——对着字符串跑同一条正则，确认检测器对 `start` 敏感。另外做过一次真注入：把 `style.css` 改回 `align-items: start`，SC-01 立刻红。

## 五、明说的没做

- **WAF / Bot Fight Mode 没开**。这是面板开关，部署用的 API token 没有 Firewall 写权限，代码里也绕不过去。材料把它排在第 1 周，实际卡在权限上，不在实现上。应用层现在有两道按 IP 的 D1 限流（评论 `comment_guard`、登录 `auth:ip:`），能挡单点刷，挡不住分布式——这一层确实只有边缘能给。
- **没加 `[[ratelimits]]` binding**。它是 per-colo 软限（文档原文 `Requests can exceed this threshold`）：同一秒打到两个节点的请求各算各的，拦不住分布式，也不跨节点累计。应用层那两道按 IP 的 D1 限流是准的，再加一个只在单节点生效、必须靠部署才验得了的配置，收益对不上成本。
- **没引 sanitize 库**，也没引 Hono、KV、vitest。`src/clean.js` 是自写的白名单清洗，`dependencies` 仍为空。
- **没拆 `features/` 目录**。`public/md.js` 双端共用（`editor.html` 直接 `import`），搬进 `src/` 浏览器端就 404；这一条前面四轮已经写过理由，不再重复。
- **没改 CSP 成 Report-Only**。理由见第一节。
- **没重测首屏**。v1.2.4 已部署，`check:live` 89/89；但这次一行渲染逻辑都没动（改的是读体入口），首屏基线是另一个指标的事，没测。

## 复现条件

- 环境：Node 22+，无网络，无浏览器
- 触发：`node scripts/test-body-limit.mjs` / `node scripts/test-antispam.mjs` / `node scripts/test-sticky-css.mjs`
- 期望：`17/17`、`16/16`、`5/5`；实际：一致
- 线上：`npm run check:live` → `89 通过，0 失败`（v1.2.4 部署后复跑；部署后 5 分钟内那一轮会有 ETag/304 组假红，是 `s-maxage=300` 的缓存窗口，不是回归）

## 断言代码

```bash
node scripts/test-body-limit.mjs   # BL-14/17 元断言 + BL-15 JSON 伪报长度 + BL-16 multipart 伪报长度
node scripts/test-antispam.mjs     # 蜜罐：400、零 INSERT、不动限流表
node scripts/test-sticky-css.mjs   # SC-01~05 sticky 的成因与自检
```

注入验证（都实测过）：

| 改动 | 期望变红 | 实际 |
|---|---|---|
| 评论分支改回 `request.json()` | BL-14 + BL-15 | 双红 |
| 上传分支改回 `request.formData()` | BL-17 | 红 |
| 蜜罐状态码 400 → 200 | 蜜罐两条 | 双红 |
| `style.css` 的 `align-items: stretch` → `start` | SC-01 | 红 |
', '<h1 id="六条断言查了五条-材料把我们自己的-ci-当成了文章"><a class="h-anchor" href="#六条断言查了五条-材料把我们自己的-ci-当成了文章">#</a>六条断言查了五条：材料把我们自己的 CI 当成了文章</h1>
<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>材料开头那句判断是准的——「每篇都在立标准，但没有任何一条标准被机器守住」。它错在<strong>病历太旧</strong>：它列的六条断言里，五条早就在 <code>npm test</code> 里跑着；它列的三个功能缺口，两个已经上线（评论 Webhook、两级回复），第三个（多文隔离）是上一轮刚做完的。</p>
<p>真正剩下的只有两条，而且都不在它的清单里：</p>
<ol><li><strong>请求体闸门只挡得住诚实的那一半</strong>。顶层看 <code>content-length</code>，15 个写入口里 14 个还在裸解析——其中 12 个是 <code>await request.json()</code>，两个是 <code>await request.formData()</code>。报个 <code>3</code> 推 1MB，闸门连看都不看一眼。</li><li><strong>蜜罐没有断言</strong>，而且材料把它的返回值写反了：本站是 400，不是 200。</li></ol>
<p>另外把 sticky 的<strong>成因</strong>从「只存在于真机脚本」搬进了 CI——那一条材料说对了方向，但理由不是它写的那个。</p>
<h2 id="一-六条断言-逐条查"><a class="h-anchor" href="#一-六条断言-逐条查">#</a>一、六条断言，逐条查</h2>
<div class="table-wrap"><table><thead><tr><th>材料要的断言</th><th>本站现状</th><th>在哪</th></tr></thead><tbody><tr><td>渲染器顺序守护：把转义挪后一行，测试必须变红</td><td><strong>已有</strong>，而且比要求更狠</td><td><code>test-md-guard.mjs</code>：M1 把 <code>esc</code> 换成恒等函数、M2 拆掉协议白名单，两个变异体都必须被抓到（分别红 5 条 / 3 条）；另有一条<strong>顺序哨兵</strong>直接比较源码位置 <code>indexOf(&#39;s = esc(s)&#39;) &lt; indexOf(&#39;s.replace(IMG_RE&#39;)</code></td></tr><tr><td><code>isPartOf</code> 不指向自己、不出现 URL 循环</td><td><strong>已有</strong>，还带线上体检</td><td><code>test-seo-series.mjs</code>「isPartOf 指向 <code>/series/&lt;名称&gt;</code>，不是文章自己」+ <code>assert.notEqual(a.isPartOf.url, base.url)</code>；<code>check-ld.mjs</code> 线上逐篇抓 JSON-LD，自指单独报一行</td></tr><tr><td>文章页含 CSP / nosniff / 无 <code>X-XSS-Protection</code></td><td><strong>已有</strong>，颗粒度到指令</td><td><code>test-headers.mjs</code> 的 <code>[P-024]</code>：nonce 必须在 <code>script-src</code> 里、<code>unsafe-inline</code>/<code>unsafe-eval</code> 不许出现、<code>base-uri</code>/<code>frame-ancestors</code>/<code>form-action</code> 逐条比、任何指令出现 <code>*</code> 直接红；<code>X-XSS-Protection</code> 只接受 <code>0</code> 或缺省</td></tr><tr><td>蜜罐命中返回 200 假成功</td><td><strong>材料写反了</strong>：本站返回 400；而且此前<strong>确实没有断言</strong></td><td>本轮新增，见第三节</td></tr><tr><td>sticky 父格高度 &gt; 336px、目录停 86px</td><td>成因<strong>没有</strong> CI 断言，现象只有真机脚本</td><td>本轮新增 <code>test-sticky-css.mjs</code>，见第四节</td></tr><tr><td><code>/img/</code> 响应带 nosniff、拒绝内网地址</td><td><strong>前半已有</strong>；后半不适用</td><td><code>test-svg.mjs</code> + <code>test-headers.mjs</code> 的 nosniff；<code>/img/</code> 只读 R2 对象、不发任何出站请求（不是 URL 代理），真正的「拒绝内网」在 <code>cron.js</code> 的 <code>isBlockedHost()</code>，<code>test-cron.mjs</code> 8/8</td></tr></tbody></table></div>
<p>关于 CSP，这是第四次收到「你站没有 CSP」了。<code>src/security.js</code> 的 <code>csp()</code> 从 v1.2 起就是 <strong>enforcing</strong>，<code>s-maxage=300</code> 与 nonce 并存的前提是「可缓存页面零反射面」——文章页的 HTML 里每个内联脚本都带当次 nonce，没有一处来自用户输入。材料让「先 Report-Only 跑一周」，对本站是退步：Report-Only 不发 nonce 违规报告以外的任何保护，跑一周等于拆掉一层防线一周。</p>
<p>顺带把另外三条也核了：</p>
<ul><li><strong>评论无 Webhook / 无回复</strong>：<code>src/webhook.js</code> 按域名生成企微 / 飞书 / Discord / Slack 四种结构（<code>test-webhook.mjs</code>），回复走 <code>parent_id</code>，服务端强制两级（回子评论时归到顶级，<code>api.js</code> 里那段注释写着为什么）。</li><li><strong>无 <code>visibility</code> 字段</strong>：不加。<code>published_at</code> / <code>is_private</code> / <code>review_status</code> / <code>hidden</code> 四个开关已经把「可见性」拆成四个正交维度，再加一个 <code>visibility</code> 就是第五个需要跟其余四个对齐的状态位——多用户叙事里最贵的从来不是字段，是状态位之间的组合合法性。</li><li><strong>多文编辑无隔离</strong>：上一轮做完了（页签 + 每篇一个 Monaco model + 异步入口捕获 doc 快照），<code>test-editor-multidoc.mjs</code> MM-01~09。</li></ul>
<h2 id="二-真缺口一-闸门写在顶层-解析写在分支"><a class="h-anchor" href="#二-真缺口一-闸门写在顶层-解析写在分支">#</a>二、真缺口一：闸门写在顶层，解析写在分支</h2>
<p>顶层确实有闸门，一行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (method !== <span class="tok-s">&#39;GET&#39;</span> &amp;&amp; method !== <span class="tok-s">&#39;HEAD&#39;</span> &amp;&amp; <span class="tok-f">bodyTooLarge</span>(request, <span class="tok-f">bodyCapFor</span>(path))) {
  <span class="tok-k">return</span> <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: <span class="tok-s">&#39;请求体太大&#39;</span> }, <span class="tok-n">413</span>, { <span class="tok-s">&#39;cache-control&#39;</span>: <span class="tok-s">&#39;no-store&#39;</span> });
}</code></pre></div>
<p><code>bodyTooLarge()</code> 只读 <code>content-length</code>。这个头是<strong>对方声明的</strong>，不是事实。报 <code>3</code>、推 1MB；或者分块上传干脆不给这个头——顶层全放行，请求一路走到分支里的 <code>const body = await request.json()</code>，整个包读进 128MB 的 isolate 再解析。</p>
<p>当时只有一个接口做了按流计数（<a href="/p/comment-anti-spam">发评论</a> 那条路，全站唯一匿名可灌数据的入口）。其余 12 个因为「要登录」被默认放过：文章增改、AI 摘要、审核、评论处置、批量删、封 IP、友链增改、站点设置、直传签名。登录只挡得住伪造身份，挡不住一个被盗的 cookie 拿你的额度烧 CPU。</p>
<p>还有两个入口是同一个坑的另一种长相：<code>request.formData()</code>。头像上传与图片直传都写着 <code>await request.formData()</code>——它内部同样把整个 body 读进内存，只是因为「像浏览器帮我解析好了」而不容易被当成出口。</p>
<p>修法不是把顶层写得更严（它拿不到事实），而是让所有分支只剩一条读体路径：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">readBody</span>(request, path, { lenient = <span class="tok-k">false</span> } = {}) {
  <span class="tok-k">const</span> rd = <span class="tok-k">await</span> <span class="tok-f">readJsonLimited</span>(request, <span class="tok-f">bodyCapFor</span>(path));
  <span class="tok-k">if</span> (rd.tooBig) <span class="tok-k">return</span> { res: <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: <span class="tok-s">&#39;请求体太大&#39;</span> }, <span class="tok-n">413</span>, { <span class="tok-s">&#39;cache-control&#39;</span>: <span class="tok-s">&#39;no-store&#39;</span> }) };
  <span class="tok-k">if</span> (!rd.body) {
    <span class="tok-k">if</span> (lenient) <span class="tok-k">return</span> { body: {} };
    <span class="tok-k">return</span> { res: <span class="tok-f">err</span>(<span class="tok-s">&#39;请求格式不正确&#39;</span>) };
  }
  <span class="tok-k">return</span> { body: rd.body };
}</code></pre></div>
<p>两个设计决定：</p>
<ul><li><strong>和顶层共用 <code>bodyCapFor(path)</code></strong>。否则会出现「顶层按 64KB 拦、分支按 1MB 放」的错位——同一张表，两处都读，改一处不会分叉（P-030 的老毛病）。</li><li><strong>连「回什么」一起定好</strong>，返回 <code>{ body }</code> 或 <code>{ res }</code>，调用方只写 <code>if (rb.res) return rb.res;</code>。把 413 漏掉的机会从「每个人自觉」变成「不这么写就跑不通」。</li></ul>
<p>13 个 JSON 分支现在全部走它。<code>lenient</code> 留给开关类接口（审核动作、评论处置、批量删、封 IP、摘要）：空 body / 坏 JSON 一律当 <code>{}</code>，保持它们原来 <code>.catch(() =&gt; ({}))</code> 的语义；写正文、上传、站点设置必须报 400。</p>
<p>表单那条路另有一个 <code>readForm(request, path)</code>，内容和它对称：<code>readFormLimited()</code> 先按流数一遍（与 JSON 共用 <code>readBytesLimited</code>，只写一份计数逻辑），再把手里的字节包成 <code>Response</code> 交给 <code>.formData()</code> 解析——boundary 在 <code>content-type</code> 里，原样搬过去就行。数量本身没有分叉：两条路都读 <code>bodyCapFor(path)</code>（上传与头像 8MB）。</p>
<p>修完发版，线上真打了一次。用分块流直接推 1.1MB、故意不给 <code>content-length</code>：</p>
<div class="table-wrap"><table><thead><tr><th>请求</th><th>结果</th></tr></thead><tbody><tr><td>64KB × 17 块（1.1MB），<code>POST /api/comments</code></td><td><code>413</code> + <code>请求体太大</code>，第 1,179,648 字节就到头，<code>reader.cancel()</code> 之后一块都不再读</td></tr></tbody></table></div>
<p>这就是新旧代码的分界线：旧代码会把整包读完，再走到别的错误分支（或撞 DB）；新代码在超限的那一块断流，花费的是 1.1MB 带宽而不是「读满 + 解析」的 CPU。</p>
<h2 id="三-真缺口二-蜜罐的断言不能只写-拦住了"><a class="h-anchor" href="#三-真缺口二-蜜罐的断言不能只写-拦住了">#</a>三、真缺口二：蜜罐的断言不能只写「拦住了」</h2>
<p>材料说蜜罐返回 200 假成功。本站是 400：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (<span class="tok-f">String</span>(body.hp || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">trim</span>()) <span class="tok-k">return</span> <span class="tok-f">err</span>(<span class="tok-s">&#39;验证没通过，刷新页面再试一次&#39;</span>, <span class="tok-n">400</span>);</code></pre></div>
<p>但它的判断有一半是对的：<strong>这条行为此前没有任何断言</strong>。改 <code>400</code> 成 <code>200</code>、或者把蜜罐挪到 INSERT 之后，<code>npm test</code> 一条都不会红。</p>
<p>新断言用假 D1 真跑一次 <code>handleApi</code>，不读源码猜顺序：</p>
<div class="table-wrap"><table><thead><tr><th>断言</th><th>内容</th></tr></thead><tbody><tr><td>命中 → 400</td><td>状态码必须是 400（200 会让前端当成功，403 会暴露拦截点）</td></tr><tr><td>命中 → 零 INSERT</td><td>拦住的不能只是响应，垃圾不能落库</td></tr><tr><td>命中 → 不动限流表</td><td>没过闸门就不该消耗额度（<code>comment_guard</code> 一次都不许碰）</td></tr></tbody></table></div>
<p>假 D1 只需要两个查询的返回值（<code>FROM posts</code> 与 <code>FROM settings</code>），其余照常抛。这个手法比「读源码找 <code>hp</code> 字符串」可靠一个量级：源码里字符串还在、顺序换了呢？</p>
<h2 id="四-sticky-把成因搬进-ci"><a class="h-anchor" href="#四-sticky-把成因搬进-ci">#</a>四、sticky：把成因搬进 CI</h2>
<p><code>check-toc-sticky.mjs</code> 是真机检查：起浏览器、滚 1200px、量 <code>getBoundingClientRect()</code>。它写得很好，但它<strong>不在 <code>npm test</code> 里</strong>——需要浏览器和线上地址。也就是说，那条真出过事的规则在 CI 里是无人看守的：</p>
<blockquote><p>grid 里写 <code>align-items: start</code>，父格缩成 336px，<code>position: sticky</code> 立刻退化成 <code>relative</code>。而且只有长文章看得出来。</p></blockquote>
<p>这条规则是 <a href="/p/sticky-toc-grid-align-items">那次 sticky 复盘</a> 的产物。文章里这句话的后半段是致命的：<strong>CI 里没有长文章</strong>。</p>
<p>所以新增 <code>test-sticky-css.mjs</code>，守成因（CSS 那三行），真机那份守现象（滚 1200px 还在原位）：</p>
<div class="table-wrap"><table><thead><tr><th>编号</th><th>断言</th></tr></thead><tbody><tr><td>SC-01</td><td><code>.post-article</code> 用 <code>align-items: stretch</code>，出现 <code>start</code>/<code>flex-start</code> 即红</td></tr><tr><td>SC-02</td><td><code>.post-toc</code> 有 <code>align-self: stretch</code>（父格拉满，子项才跟着拉满）</td></tr><tr><td>SC-03</td><td><code>.toc-inner</code> 是 <code>sticky</code>、<code>top: 86px</code>、<code>max-height: calc(100vh - Npx)</code>、<code>overflow: auto</code></td></tr><tr><td>SC-04</td><td>真机脚本仍在（成因断言不能替代现象断言）</td></tr><tr><td>SC-05</td><td>变异自检：把 <code>stretch</code> 换成 <code>start</code> 时 SC-01 的匹配必须失效</td></tr></tbody></table></div>
<p>SC-05 是这条的「没验证过会失败的断言等于没写」——对着字符串跑同一条正则，确认检测器对 <code>start</code> 敏感。另外做过一次真注入：把 <code>style.css</code> 改回 <code>align-items: start</code>，SC-01 立刻红。</p>
<h2 id="五-明说的没做"><a class="h-anchor" href="#五-明说的没做">#</a>五、明说的没做</h2>
<ul><li><strong>WAF / Bot Fight Mode 没开</strong>。这是面板开关，部署用的 API token 没有 Firewall 写权限，代码里也绕不过去。材料把它排在第 1 周，实际卡在权限上，不在实现上。应用层现在有两道按 IP 的 D1 限流（评论 <code>comment_guard</code>、登录 <code>auth:ip:</code>），能挡单点刷，挡不住分布式——这一层确实只有边缘能给。</li><li><strong>没加 <code>[[ratelimits]]</code> binding</strong>。它是 per-colo 软限（文档原文 <code>Requests can exceed this threshold</code>）：同一秒打到两个节点的请求各算各的，拦不住分布式，也不跨节点累计。应用层那两道按 IP 的 D1 限流是准的，再加一个只在单节点生效、必须靠部署才验得了的配置，收益对不上成本。</li><li><strong>没引 sanitize 库</strong>，也没引 Hono、KV、vitest。<code>src/clean.js</code> 是自写的白名单清洗，<code>dependencies</code> 仍为空。</li><li><strong>没拆 <code>features/</code> 目录</strong>。<code>public/md.js</code> 双端共用（<code>editor.html</code> 直接 <code>import</code>），搬进 <code>src/</code> 浏览器端就 404；这一条前面四轮已经写过理由，不再重复。</li><li><strong>没改 CSP 成 Report-Only</strong>。理由见第一节。</li><li><strong>没重测首屏</strong>。v1.2.4 已部署，<code>check:live</code> 89/89；但这次一行渲染逻辑都没动（改的是读体入口），首屏基线是另一个指标的事，没测。</li></ul>
<h2 id="复现条件"><a class="h-anchor" href="#复现条件">#</a>复现条件</h2>
<ul><li>环境：Node 22+，无网络，无浏览器</li><li>触发：<code>node scripts/test-body-limit.mjs</code> / <code>node scripts/test-antispam.mjs</code> / <code>node scripts/test-sticky-css.mjs</code></li><li>期望：<code>17/17</code>、<code>16/16</code>、<code>5/5</code>；实际：一致</li><li>线上：<code>npm run check:live</code> → <code>89 通过，0 失败</code>（v1.2.4 部署后复跑；部署后 5 分钟内那一轮会有 ETag/304 组假红，是 <code>s-maxage=300</code> 的缓存窗口，不是回归）</li></ul>
<h2 id="断言代码"><a class="h-anchor" href="#断言代码">#</a>断言代码</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> scripts/test-body-limit.mjs   <span class="tok-c"># BL-14/17 元断言 + BL-15 JSON 伪报长度 + BL-16 multipart 伪报长度</span>
<span class="tok-k">node</span> scripts/test-antispam.mjs     <span class="tok-c"># 蜜罐：400、零 INSERT、不动限流表</span>
<span class="tok-k">node</span> scripts/test-sticky-css.mjs   <span class="tok-c"># SC-01~05 sticky 的成因与自检</span></code></pre></div>
<p>注入验证（都实测过）：</p>
<div class="table-wrap"><table><thead><tr><th>改动</th><th>期望变红</th><th>实际</th></tr></thead><tbody><tr><td>评论分支改回 <code>request.json()</code></td><td>BL-14 + BL-15</td><td>双红</td></tr><tr><td>上传分支改回 <code>request.formData()</code></td><td>BL-17</td><td>红</td></tr><tr><td>蜜罐状态码 400 → 200</td><td>蜜罐两条</td><td>双红</td></tr><tr><td><code>style.css</code> 的 <code>align-items: stretch</code> → <code>start</code></td><td>SC-01</td><td>红</td></tr></tbody></table></div>', '', 'log', '材料列的六条断言里五条早就在 npm test 跑着：渲染器变异哨兵、isPartOf 自指、安全头逐指令、sticky 真机、/img/ nosniff；它还把蜜罐返回值写反了（本站 400，不是 200）。真缺口只有两个——请求体闸门只看 content-length 这条「声明」，15 个写入口里 14 个还在裸解析。统一走 readBody/readForm 后，线上分块推 1.1MB 在 413 处断流。',
        '', 0, 0, 0, 1, '2027-02-10 01:00:00', datetime('now'), datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'gate-only-covered-the-honest-half' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'gate-only-covered-the-honest-half' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('testing') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'gate-only-covered-the-honest-half' AND t.name = 'testing';
-- 回补内链：11-comment-anti-spam.md
UPDATE posts SET content = '写[R2 那篇](/p/r2-image-pipeline)时预告过这篇。真动手才发现，评论防滥用没有一处需要"聪明"：三层防线全是排序题——**哪一层放在请求路径最前面，取决于拒掉一次攻击要花多少钱**。

现在的形态是三层，从零成本往上排：

| 顺序 | 层 | 一次拒绝的代价 | 失败方向 |
|---|---|---|---|
| 1 | 蜜罐字段 `hp` | 一次字符串 trim，不碰数据库、不发请求 | fail-closed（填了就拒） |
| 2 | Turnstile siteverify | 一次跨网 HTTPS 往返（仅配了 key 才发生） | 网络异常时 fail-open（放行） |
| 3 | D1 限额 | 一次 SELECT + 一次 batch 写 | fail-closed |

这条排序不是按"强度"排的，是按"钱"排的。命中第一层就 return，后面两层的数据库和网络开销一分不花。垃圾评论里最大的一类是"不跑 JS 的填表机"，而它们恰好会被最便宜的那层筛掉。

先贴实测。下面每个状态码、每个响应头都是今天线上跑出来的，不是"应该会"。

## 实测：四种拒绝，四条不同的出口

```
[1] 空 body 提交
POST /api/comments  {}
→ 400  {"ok":false,"error":"评论不能为空"}

[2] 蜜罐填了值（其余字段合法）
POST /api/comments  {"slug":"d1-no-such-table","content":"probe","name":"石井探针",
                     "email":"probe@example.com","hp":"http://spam"}
→ 400  {"ok":false,"error":"验证没通过，刷新页面再试一次"}

[3] 第一条正常提交
POST /api/comments  {…合法字段，hp 为空}
→ 200  {"ok":true,"id":9}
   Set-Cookie: cmt_did=46d65ce8…; Path=/; HttpOnly; SameSite=Lax;
               Max-Age=34560000; Secure

[4] 紧接着发第二条（同一出口 IP）
POST /api/comments  {…同样合法}
→ 429  {"ok":false,"error":"发得太快了，隔一分钟再发"}
   Retry-After: 60

[5] 把该 IP 在限额表里标成 banned 之后再发
→ 403  {"ok":false,"error":"这个来源被拦下了，如果误伤请联系博主"}
   Retry-After: 3600
```

注意 [2] 和 [4] 的区别：**同一个已经被限流的 IP，撞蜜罐拿到的仍然是 400 而不是 429**。顺序在代码里就是这么写的，不是靠返回码猜的。

`[2]` 之前先通过的校验链是：内容非空 → 文章存在 → 昵称非空 → 邮箱格式。所以一条"邮箱写错 + 蜜罐被填"的请求，先撞的是邮箱。这类顺序不影响安全，但影响你排查时看到哪个错——**把便宜的检查放前面，日志里看到的第一条错误永远是原因，不是后果**。

## 第一层：蜜罐，把"看不见"做成结构

表单里有个字段叫 `hp`，站在页面上看不见：

```html
<input type="text" name="hp" class="hp" tabindex="-1"
       autocomplete="off" aria-hidden="true" placeholder="留空">
```

```css
.cmt-form .hp {
  position: absolute; left: -9999px;
  width: 1px; height: 1px;
  opacity: 0; pointer-events: none;
}
```

四个属性各有分工，缺一个都会被某类爬虫捡走：

- **不用 `display:none`**：一部分填表机会跳过不可见元素，`display:none` 等于告诉它"这个别填"。挪到视窗外（`left:-9999px`）+ `opacity:0` 仍然参与布局，在 DOM 层面它就是个普通输入框；
- **`tabindex="-1"`**：键盘 Tab 跳不过去，真人不会误入；
- **`autocomplete="off"`**：密码管理器往里塞邮箱是最烦的一种"误伤"，显式关掉；
- **`aria-hidden="true"`**：读屏软件不念它，否则视障用户会听到一个没有意义的"留空"输入框。

服务端只有一行：

```js
if (String(body.hp || '''').trim()) return err(''验证没通过，刷新页面再试一次'', 400);
```

**为什么是 400 而不是静默 200 假成功？** 这是这层唯一值得争论的地方，我选了对真人有利的一边：

静默 200 对脚本更阴——它不知道哪一步错了，只会以为成功，连"下次别填这个字段"都学不到。但如果哪天某个密码管理器硬塞了一个字符进去（`autocomplete="off"` 只是建议，不是命令），真人看到的是"评论已发布"，然后评论凭空消失，没有任何线索。

**宁可让脚本学到规则，也不让真人的评论无声蒸发。** 这是一次明确的取舍，不是疏忽。

代价说清楚：`hp` 这个字段名一旦被写进某个采集器的黑名单，这层就只剩"拦住最懒的那批"。所以它是筛子，不是墙。

## 第二层：Turnstile，重点不在组件在配置

组件本身没什么可讲的：Cloudflare 的 Turnstile 免费、无感、不卖数据，接上就行。真正决定这层值不值的是三件事：什么时候加载、谁来验、验不了怎么办。

### 加载：配置驱动，没配就一个请求都不发

```js
let tsFailed = false;   // 配了 key 但脚本没下来（断网、被拦截插件掐掉）

async function mountTurnstile() {
  const key = (window.__SITE__ || {}).turnstile;
  const slot = document.getElementById(''ts-wrap'');
  if (!key || !slot) return;          // 没配 key：到这里就结束
  slot.hidden = false;
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement(''script'');
      s.src = ''https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'';
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    window.turnstile.render(slot, { sitekey: key, language: ''zh-cn'', size: ''flexible'' });
  } catch {
    tsFailed = true;
    slot.hidden = true;
  }
}
```

`?render=explicit` 是关键：默认的 `auto` 模式是"见到占位符就长出来"，那意味着只要页面里有那个 div，第三方脚本就有机会被拉起来。explicit 把"何时渲染"的决定权留在自己的代码里，而上面那个 `return` 保证了这个决定永远是"不加载"。

当前状态：`TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET` 两个都没配，页面里 `"turnstile":""`。所以 `challenges.cloudflare.com` 这个字符串在源码里出现 1 次（就上面那行 `src`），**实际网络请求 0 次**。这不是"加载了但没显示"，是根本没走那行代码。

### 两处收口，别只改一处

关掉 Turnstile 不只影响那一个 `return`，CSP 也得跟着：

```js
function csp(n, { turnstile = false } = {}) {
  const ts = turnstile ? '' https://challenges.cloudflare.com'' : '''';
  return [
    "default-src ''self''",
    `script-src ''self'' ''nonce-${n}''${ts}`,
    `connect-src ''self''${ts}`,
    `frame-src ''self''${ts}`,
    // …
  ];
}
```

漏掉 `frame-src` 的后果很典型：组件是个 iframe，脚本能加载、能初始化，但框里一片空白，控制台报 CSP 违规——而你会先去怀疑 key 错了。**开关必须同时管到"脚本从哪来"和"框从哪来"**，这两个是不同的指令。

### 校验：前端那个框只是个摆设

安全上唯一有意义的一步在服务端，`siteverify` 拿 token 复核：

```js
const form = new FormData();
form.append(''secret'', secret);
form.append(''response'', String(token));
if (ip) form.append(''remoteip'', ip);

const r = await fetch(''https://challenges.cloudflare.com/turnstile/v0/siteverify'', { method: ''POST'', body: form });
const d = await r.json();
if (d.success) return { ok: true };
return { ok: false, error: ''人机验证没通过，刷新页面再试一次'' };
```

`remoteip` 是可选的，但传上去了能让 Cloudflare 把"这个 token 是在哪个 IP 上签发的"一起判——token 被搬到另一个 IP 上重放时才有得比。

### 验不了的时候：这层是 fail-open 的

```js
} catch {
  // 校验服务自己挂了，不能连累评论功能 —— 记一笔降级，放行
  console.warn(''[antispam] turnstile siteverify 不可达，本次降级放行'');
  return { ok: true, degraded: true };
}
```

这跟[上一节讲的 fail-closed](/p/editor-markdown-xss)方向相反，是有意的：siteverify 是外部依赖，它挂的时候如果跟着 fail-closed，全站评论会以一个第三方服务为条件停摆，而攻击者只要能把那个域名打到超时，就等于免费关掉了你的评论区——**这本身就是一次拒绝服务**。

代价也真实：这条路理论上可被利用。能打挂 Cloudflare 校验接口的人，大概也不在乎你这一个博客的评论。取舍是这么算的。

### 半配比不配更危险

这是我写完才想明白的一点，顺手补成了代码。Turnstile 有两个 key，配置有四种状态：

```js
export function turnstileMode(env = {}) {
  const site = !!(env && env.TURNSTILE_SITE_KEY);
  const secret = !!(env && env.TURNSTILE_SECRET);
  if (site && secret) return ''on'';
  if (site) return ''site-only'';
  if (secret) return ''secret-only'';
  return ''off'';
}
```

- **只配 sitekey**：前端老老实实弹验证框，访客认真勾了，服务端却无从校验——因为 `verifyTurnstile` 的第一行是"没 secret 就跳过"。这层防护是**假的**，而它看起来是真的。这种状态比不配更糟：不配你至少知道自己没防护。所以 `site-only` 按配置不完整拒收，宁可评论挂掉被发现；
- **只配 secret**：前端根本没组件，谁也拿不出 token，此时要求 token 等于全员禁言。按未启用处理，打一行 warn。

**配置的一半不是一半的防护，是一半的错觉。** 这条经验适用于所有"开关 + 密钥"双要素的服务，不只是 Turnstile。

### 顺带修的一个死锁

`mountTurnstile` 的 catch 里原来只有一句 `slot.hidden = true`。问题在提交时：

```js
const tsToken = window.turnstile && document.getElementById(''ts-wrap'')?.hidden === false
  ? window.turnstile.getResponse() : '''';
if (window.__SITE__ && window.__SITE__.turnstile && !tsToken) {
  toast(tsFailed ? ''人机验证组件没加载出来，刷新页面或换个网络再试'' : ''先完成人机验证'');
  return;
}
```

改之前这里只有一句"先完成人机验证"。当脚本被拦截插件掐掉、或者网络抖动没下来时，组件框并不存在，用户被要求去勾一个看不见的东西，刷新也不一定好——**报错文案指错了方向，比没有文案更费时间**。现在加载失败有单独的标记和单独的话。

## 第三层：D1 限额，两把钥匙和一个时区

前两层管"你是不是脚本"，这层管"你就算是真人，也别刷"。

```js
export const MIN_GAP_SEC = 60;   // 同 IP 相邻两条的最小间隔
export const DAY_MAX = 10;       // 每天上限（IP 与设备各算各的）
```

判定抽成了一个不碰数据库、不发请求的纯函数，方便单测：

```js
export function judge(rec, nowSec, { minGap = MIN_GAP_SEC, dayMax = DAY_MAX, checkGap = true } = {}) {
  if (!rec) return { ok: true };
  if (Number(rec.banned) === 1) {
    return { ok: false, status: 403, error: ''这个来源被拦下了，如果误伤请联系博主'', retry: 3600 };
  }
  const hits = rec.day === dayKey(nowSec) ? Number(rec.hits) : 0;
  if (hits >= dayMax) {
    return { ok: false, status: 429, error: `今天已经发了 ${dayMax} 条，明天再来`, retry: secsToNextDay(nowSec) };
  }
  if (checkGap && rec.last_ts) {
    const gap = nowSec - Number(rec.last_ts);
    if (gap < minGap) return { ok: false, status: 429, error: ''发得太快了，隔一分钟再发'', retry: minGap - gap };
  }
  return { ok: true };
}
```

**banned 的判断放在额度之前**：被拉黑的人不管今天发了几条，拿到的都是 403 而不是 429。用状态码把"你被禁了"和"你太快了"分开，前端和日志都不用猜。

### 为什么是两把钥匙

`guard()` 同时查 `ip:…` 和 `dev:…` 两行：

```js
const ip = request.headers.get(''cf-connecting-ip'') || ''0.0.0.0'';
const raw = parseCookies(request)[DID_COOKIE] || '''';
const did = /^[a-f0-9]{24,64}$/i.test(raw) ? raw.toLowerCase() : '''';
const fresh = !did;
```

- **IP 那把**：60 秒一条 + 每天 10 条；
- **设备那把**（`cmt_did`，服务端发的 32 位十六进制，HttpOnly + Secure + 400 天）：只查每天 10 条，**不查间隔**。

设备键不查 60 秒间隔，是因为同一个人的两个标签页不该互相拦——IP 键已经把"机器人连发"拦住了，设备键存在的意义是"同一台机器就算换 IP 也别超过 10 条"，它不需要管节奏。

实测落库的样子（两次写入是同一秒，所以 `last_ts` 一样）：

```
k                                day          hits  last_ts
ip:188.253.6.247                 2026-11-12   1     1794413231
dev:46d65ce8…c45caa0f            2026-11-12   1     1794413231
```

### 那个日期是 11-12，而 UTC 还在 11-11

这不是 bug。`last_ts = 1794413231` 是 UTC `2026-11-11 16:07:11`，北京时间 `2026-11-12 00:07:11`，而日额度的日期键按 **UTC+8** 切：

```js
const TZ_OFFSET = 8 * 3600;
export function dayKey(sec) {
  return new Date((sec + TZ_OFFSET) * 1000).toISOString().slice(0, 10);
}
```

用 UTC 零点换天的后果很具体：**北京时间早上 8 点，一个中国访客的额度刚被重置**——他在凌晨刷满 10 条，睡一觉起来又能刷。按作者的生活时间切，额度才对应"今天"这个直觉。

`retry-after` 也跟着算，而不是固定给 60：

```js
export function secsToNextDay(sec) {
  const local = sec + TZ_OFFSET;
  return 86400 - (local % 86400);
}
```

上面那个时刻如果打满日额度，返回的 `Retry-After` 是 **85969**（≈23.88 小时），不是 86400——因为当天已经过了 431 秒。少算这 431 秒的后果是客户端多等一会儿，不算大事；但一个"永远返回 86400"的实现，在 23:59 提交的人会被要求等一整天，差了一秒的边界就成了差一天的体验。

### 记账的时机：落库成功才记

```js
// 落库成功才计额度：被 400 拒掉的请求不占次数
if (rate && rate.ok) {
  await record(db, rate.ip, rate.did, Math.floor(Date.now() / 1000));
  if (rate.fresh) headers[''set-cookie''] = setCookie(''cmt_did'', rate.did, { maxAge: DID_MAX_AGE });
}
```

这个先后顺序很重要。假如改成"请求进来就先记一笔"，那么任何人只要对着接口发 10 个内容为空的请求，就能把这个 IP 后面一小时（甚至一天）的评论额度全部烧掉——**在一个所有访客共享出口 IP 的移动网络下，这等于给陌生人一个关掉评论区的能力**。

写库用一条 upsert 同时处理"新的一天"和"同一天累加"：

```sql
INSERT INTO comment_guard (k, day, hits, last_ts) VALUES (?, ?, 1, ?)
ON CONFLICT(k) DO UPDATE SET
  hits = CASE WHEN comment_guard.day = ? THEN comment_guard.hits + 1 ELSE 1 END,
  day  = ?,
  last_ts = ?;
```

`hits = CASE WHEN day 相同 THEN hits+1 ELSE 1` 这一行替代了"先查再判断要不要清零"的三次往返。跨天不需要定时任务，第一次写入自然把计数打回 1。

### 时间逻辑单独说，它最容易写错

`judge` 抽成纯函数就是为了测它。13 条断言里，4 条专门钉时间：

```
ok  同一天打满额度就拦，retry 指向次日零点
ok  跨天后额度归零：昨天打满不影响今天
ok  间隔不足 60 秒拦住，retry 是差额
ok  刚好满 60 秒放行
ok  日期按 UTC+8 切：UTC 16:00 就是北京的次日零点
ok  secsToNextDay 在北京零点等于一整天
```

"刚好满 60 秒放行"和"跨天后归零"这两条，如果用 `<=` 而不是 `<`、用 `day !==` 而不是 `day ===`，人肉 review 三遍都看不出来，线上表现是"偶尔少拦一条"或者"偶尔多拦一条"——**没有测试的话，这种 bug 会活到你自己被拦的那天**。

## 封 IP：一键连坐，而不是单点删除

管理员视图里每条访客评论旁边的按钮，title 原文是"删掉这个来源的全部访客评论，并拉黑该 IP"。它做的事：

```js
// 只清访客评论，管理员自己的一条都不动
const { results } = await db
  .prepare(''SELECT id FROM comments WHERE ip = ? AND is_admin = 0'')
  .bind(c.ip).all();
// …删掉这些评论及其子回复…
await banIp(db, c.ip);
```

三个决定：

1. **连坐**：一个来发广告的号不会只发一条，逐条删等于替它做签到。按 IP 一次清干净，不留"漏网的那条明天冒出来"的尾巴；
2. **`is_admin = 0` 这个条件是必须的**：同一条宽带下，我自己的评论和访客的评论 IP 是一样的。少了这个条件，点一次"封 IP"会把自己写过的评论一起抹掉；
3. **入口做成一条评论上的按钮**，而不是后台一个 IP 黑名单表格。处置的动作发生在"你正看着垃圾"的那一刻，三个点击内完成。

`banIp` 只写一个字段：

```sql
INSERT INTO comment_guard (k, day, hits, last_ts, banned) VALUES (?, ?, 0, 0, 1)
ON CONFLICT(k) DO UPDATE SET banned = 1;
```

顺手回答一个必然会问的问题：**没有 TTL，是永久的**。解封目前只能改库——后台没有解封入口。这是个真实欠账，不是设计。

拉黑动作本身也值得说：它是**人按的**，没有自动规则。这条和[友链检测篇那个"403 不算挂"](/p/worker-cron-friend-check)是同一类教训的反面——**"看着像垃圾"也不等于垃圾**。按 UA、按关键词、按频率自动封，第一个被误伤的永远是办公网出口、公司 NAT、运营商 CGNAT。自动封禁省的是我的点击，花的是误伤活人的风险，这买卖现在不做。

## 数据面：邮箱和 IP 只进不出

这条其实比 Turnstile 更早生效。评论要求填邮箱，但公开列表接口按身份剥字段：

```js
const isAdm = !!(user && user.is_admin);
const rows = isAdm ? results : results.map(({ email, ip, ...rest }) => rest);
```

实测的公开响应（游客视角）：

```json
{"ok":true,"total":1,"comments":[{"id":9,"parent_id":null,"name":"石井探针",
 "website":"","content":"防滥用探针：这条会在验证后被删除。","is_admin":0,
 "created_at":"2026-11-11 16:07:11","replies":[]}]}
```

没有 `email`，没有 `ip`。管理员视图里邮箱渲染成一个 `mailto:` 链接（title "联系邮箱，仅管理员可见"），IP 只用于"封 IP"这个动作。

为什么值得单独写一节：**垃圾评论存在的意义之一就是收割邮箱**。把它们的存在理由去掉一半，比多拦几条更有用。到了[全站邮箱混淆](/p/about)那一步，这条线才真正闭合——公开页面上连一个可抓的地址都没有。

## 六个没做，明说

比"做了什么"更需要说清楚的是边界：

1. **没有内容层检测**。不看链接数、不看关键词、不接第三方库。一条评论只要过了人机验证和频率限制，就会立即公开。这是拿"少量垃圾可见"换"零审核压力"；
2. **限额只有两把钥匙**。换 IP + 清 cookie 之后，就只剩 IP 那一把的额度可算。没有网段聚合、没有 ASN 维度。要绕真能绕，只是绕的成本比发广告的收益高；
3. **`banned` 永久，没有解封入口**。误封只能进 D1 改 `banned = 0`。写在这里，是因为半年后我自己也会忘；
4. **siteverify 网络异常时放行**。见上文，可用性优先于这层防护，代价是理论上可被"打挂校验服务"绕过；
5. **10 条/天在 CGNAT 出口会误伤**。一个宿舍楼、一个公司出口，10 个真人一天只能发 10 条。这个数字是按单人站点的真实流量定的，不是按"公平"定的；
6. **蜜罐的 400 可被学习**。脚本第二次就知道 `hp` 要留空。这层只对"第一次来的懒脚本"有效。

还有一件属于权衡而非欠账的：**没有先审后发**。评论即时公开，管理员事后处置——这也是排序题的一部分，审核压力放在人身上，比放在请求路径上贵得多。

## 清单

| 层 | 机制 | 抓谁 | 误伤谁 | 失败方向 |
|---|---|---|---|---|
| 表单 | `hp` 蜜罐（视窗外 + `tabindex=-1` + `autocomplete=off`） | 不跑 JS 的填表机 | 谁都不，除非密码管理器硬填 | closed |
| 前端 | Turnstile explicit，`sitekey` 驱动，没配 = 0 请求 | 浏览器级脚本 | 无 | closed（组件加载失败就不让提交） |
| 服务端 | `siteverify` 复核 token + `remoteip` | 伪造提交的脚本 | 无 | open（校验服务不可达时降级放行） |
| 限额 | D1 双钥匙（IP / 设备），60 秒 + 10 条/天，UTC+8 换天 | 真人刷屏、换 cookie 刷 | CGNAT 共享出口 | closed |
| 处置 | 封 IP：清同源访客评论 + 永久拉黑 | 已成灾的来源 | 同 NAT 下的其他访客——靠人按 | 手按 |
| 数据面 | 邮箱/IP 按 `isAdmin` 剥字段 | 采集器 | 无 | closed |

三层加起来不到 200 行，没有一处需要模型、规则库或者人来值班。**够不够用，取决于你的评论区有没有人想攻**——单作者站，这三层大概能撑到"第一个认真的人出现"。

至于它撑了多久、后台那个"封 IP"按钮到底有没有被真的按过——等第一条垃圾评论出现，拿真实处置记录写《垃圾评论标本室》。在那之前，继续写正经的。

后补一句：蜜罐命中时到底返回什么、拦住的到底是响应还是落库，后来单独写成了一篇（排期 2027-02）。在那之前，把 `400` 改成 `200`、或者把蜜罐挪到 `INSERT` 之后，`npm test` 一条都不会红。

#cloudflare #turnstile #security
', html_content = '<p>写<a href="/p/r2-image-pipeline">R2 那篇</a>时预告过这篇。真动手才发现，评论防滥用没有一处需要&quot;聪明&quot;：三层防线全是排序题——<strong>哪一层放在请求路径最前面，取决于拒掉一次攻击要花多少钱</strong>。</p>
<p>现在的形态是三层，从零成本往上排：</p>
<div class="table-wrap"><table><thead><tr><th>顺序</th><th>层</th><th>一次拒绝的代价</th><th>失败方向</th></tr></thead><tbody><tr><td>1</td><td>蜜罐字段 <code>hp</code></td><td>一次字符串 trim，不碰数据库、不发请求</td><td>fail-closed（填了就拒）</td></tr><tr><td>2</td><td>Turnstile siteverify</td><td>一次跨网 HTTPS 往返（仅配了 key 才发生）</td><td>网络异常时 fail-open（放行）</td></tr><tr><td>3</td><td>D1 限额</td><td>一次 SELECT + 一次 batch 写</td><td>fail-closed</td></tr></tbody></table></div>
<p>这条排序不是按&quot;强度&quot;排的，是按&quot;钱&quot;排的。命中第一层就 return，后面两层的数据库和网络开销一分不花。垃圾评论里最大的一类是&quot;不跑 JS 的填表机&quot;，而它们恰好会被最便宜的那层筛掉。</p>
<p>先贴实测。下面每个状态码、每个响应头都是今天线上跑出来的，不是&quot;应该会&quot;。</p>
<h2 id="实测-四种拒绝-四条不同的出口"><a class="h-anchor" href="#实测-四种拒绝-四条不同的出口">#</a>实测：四种拒绝，四条不同的出口</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span><span class="code-ln">23 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
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
21
22
23</span><code class="language-text">[1] 空 body 提交
POST /api/comments  {}
→ 400  {&quot;ok&quot;:false,&quot;error&quot;:&quot;评论不能为空&quot;}

[2] 蜜罐填了值（其余字段合法）
POST /api/comments  {&quot;slug&quot;:&quot;d1-no-such-table&quot;,&quot;content&quot;:&quot;probe&quot;,&quot;name&quot;:&quot;石井探针&quot;,
                     &quot;email&quot;:&quot;probe@example.com&quot;,&quot;hp&quot;:&quot;http://spam&quot;}
→ 400  {&quot;ok&quot;:false,&quot;error&quot;:&quot;验证没通过，刷新页面再试一次&quot;}

[3] 第一条正常提交
POST /api/comments  {…合法字段，hp 为空}
→ 200  {&quot;ok&quot;:true,&quot;id&quot;:9}
   Set-Cookie: cmt_did=46d65ce8…; Path=/; HttpOnly; SameSite=Lax;
               Max-Age=34560000; Secure

[4] 紧接着发第二条（同一出口 IP）
POST /api/comments  {…同样合法}
→ 429  {&quot;ok&quot;:false,&quot;error&quot;:&quot;发得太快了，隔一分钟再发&quot;}
   Retry-After: 60

[5] 把该 IP 在限额表里标成 banned 之后再发
→ 403  {&quot;ok&quot;:false,&quot;error&quot;:&quot;这个来源被拦下了，如果误伤请联系博主&quot;}
   Retry-After: 3600</code></pre></div>
<p>注意 [2] 和 [4] 的区别：<strong>同一个已经被限流的 IP，撞蜜罐拿到的仍然是 400 而不是 429</strong>。顺序在代码里就是这么写的，不是靠返回码猜的。</p>
<p><code>[2]</code> 之前先通过的校验链是：内容非空 → 文章存在 → 昵称非空 → 邮箱格式。所以一条&quot;邮箱写错 + 蜜罐被填&quot;的请求，先撞的是邮箱。这类顺序不影响安全，但影响你排查时看到哪个错——<strong>把便宜的检查放前面，日志里看到的第一条错误永远是原因，不是后果</strong>。</p>
<h2 id="第一层-蜜罐-把-看不见-做成结构"><a class="h-anchor" href="#第一层-蜜罐-把-看不见-做成结构">#</a>第一层：蜜罐，把&quot;看不见&quot;做成结构</h2>
<p>表单里有个字段叫 <code>hp</code>，站在页面上看不见：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">html</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-html">&lt;input type=<span class="tok-s">&quot;text&quot;</span> name=<span class="tok-s">&quot;hp&quot;</span> class=<span class="tok-s">&quot;hp&quot;</span> tabindex=<span class="tok-s">&quot;-1&quot;</span>
       autocomplete=<span class="tok-s">&quot;off&quot;</span> aria-hidden=<span class="tok-s">&quot;true&quot;</span> placeholder=<span class="tok-s">&quot;留空&quot;</span>&gt;</code></pre></div>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">.cmt-form .hp {
  position: absolute; left: -<span class="tok-n">9999px</span>;
  width: <span class="tok-n">1px</span>; height: <span class="tok-n">1px</span>;
  opacity: <span class="tok-n">0</span>; pointer-events: none;
}</code></pre></div>
<p>四个属性各有分工，缺一个都会被某类爬虫捡走：</p>
<ul><li><strong>不用 <code>display:none</code></strong>：一部分填表机会跳过不可见元素，<code>display:none</code> 等于告诉它&quot;这个别填&quot;。挪到视窗外（<code>left:-9999px</code>）+ <code>opacity:0</code> 仍然参与布局，在 DOM 层面它就是个普通输入框；</li><li><strong><code>tabindex=&quot;-1&quot;</code></strong>：键盘 Tab 跳不过去，真人不会误入；</li><li><strong><code>autocomplete=&quot;off&quot;</code></strong>：密码管理器往里塞邮箱是最烦的一种&quot;误伤&quot;，显式关掉；</li><li><strong><code>aria-hidden=&quot;true&quot;</code></strong>：读屏软件不念它，否则视障用户会听到一个没有意义的&quot;留空&quot;输入框。</li></ul>
<p>服务端只有一行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (<span class="tok-f">String</span>(body.hp || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">trim</span>()) <span class="tok-k">return</span> <span class="tok-f">err</span>(<span class="tok-s">&#39;验证没通过，刷新页面再试一次&#39;</span>, <span class="tok-n">400</span>);</code></pre></div>
<p><strong>为什么是 400 而不是静默 200 假成功？</strong> 这是这层唯一值得争论的地方，我选了对真人有利的一边：</p>
<p>静默 200 对脚本更阴——它不知道哪一步错了，只会以为成功，连&quot;下次别填这个字段&quot;都学不到。但如果哪天某个密码管理器硬塞了一个字符进去（<code>autocomplete=&quot;off&quot;</code> 只是建议，不是命令），真人看到的是&quot;评论已发布&quot;，然后评论凭空消失，没有任何线索。</p>
<p><strong>宁可让脚本学到规则，也不让真人的评论无声蒸发。</strong> 这是一次明确的取舍，不是疏忽。</p>
<p>代价说清楚：<code>hp</code> 这个字段名一旦被写进某个采集器的黑名单，这层就只剩&quot;拦住最懒的那批&quot;。所以它是筛子，不是墙。</p>
<h2 id="第二层-turnstile-重点不在组件在配置"><a class="h-anchor" href="#第二层-turnstile-重点不在组件在配置">#</a>第二层：Turnstile，重点不在组件在配置</h2>
<p>组件本身没什么可讲的：Cloudflare 的 Turnstile 免费、无感、不卖数据，接上就行。真正决定这层值不值的是三件事：什么时候加载、谁来验、验不了怎么办。</p>
<h3 id="加载-配置驱动-没配就一个请求都不发"><a class="h-anchor" href="#加载-配置驱动-没配就一个请求都不发">#</a>加载：配置驱动，没配就一个请求都不发</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span><span class="code-ln">22 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
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
21
22</span><code class="language-js"><span class="tok-k">let</span> tsFailed = <span class="tok-k">false</span>;   <span class="tok-c">// 配了 key 但脚本没下来（断网、被拦截插件掐掉）</span>

<span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">mountTurnstile</span>() {
  <span class="tok-k">const</span> key = (window.__SITE__ || {}).turnstile;
  <span class="tok-k">const</span> slot = document.<span class="tok-f">getElementById</span>(<span class="tok-s">&#39;ts-wrap&#39;</span>);
  <span class="tok-k">if</span> (!key || !slot) <span class="tok-k">return</span>;          <span class="tok-c">// 没配 key：到这里就结束</span>
  slot.hidden = <span class="tok-k">false</span>;
  <span class="tok-k">try</span> {
    <span class="tok-k">await</span> <span class="tok-k">new</span> <span class="tok-f">Promise</span>((resolve, reject) =&gt; {
      <span class="tok-k">const</span> s = document.<span class="tok-f">createElement</span>(<span class="tok-s">&#39;script&#39;</span>);
      s.src = <span class="tok-s">&#39;https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&#39;</span>;
      s.<span class="tok-k">async</span> = <span class="tok-k">true</span>;
      s.onload = resolve;
      s.onerror = reject;
      document.head.<span class="tok-f">appendChild</span>(s);
    });
    window.turnstile.<span class="tok-f">render</span>(slot, { sitekey: key, language: <span class="tok-s">&#39;zh-cn&#39;</span>, size: <span class="tok-s">&#39;flexible&#39;</span> });
  } <span class="tok-k">catch</span> {
    tsFailed = <span class="tok-k">true</span>;
    slot.hidden = <span class="tok-k">true</span>;
  }
}</code></pre></div>
<p><code>?render=explicit</code> 是关键：默认的 <code>auto</code> 模式是&quot;见到占位符就长出来&quot;，那意味着只要页面里有那个 div，第三方脚本就有机会被拉起来。explicit 把&quot;何时渲染&quot;的决定权留在自己的代码里，而上面那个 <code>return</code> 保证了这个决定永远是&quot;不加载&quot;。</p>
<p>当前状态：<code>TURNSTILE_SITE_KEY</code> 和 <code>TURNSTILE_SECRET</code> 两个都没配，页面里 <code>&quot;turnstile&quot;:&quot;&quot;</code>。所以 <code>challenges.cloudflare.com</code> 这个字符串在源码里出现 1 次（就上面那行 <code>src</code>），<strong>实际网络请求 0 次</strong>。这不是&quot;加载了但没显示&quot;，是根本没走那行代码。</p>
<h3 id="两处收口-别只改一处"><a class="h-anchor" href="#两处收口-别只改一处">#</a>两处收口，别只改一处</h3>
<p>关掉 Turnstile 不只影响那一个 <code>return</code>，CSP 也得跟着：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">csp</span>(n, { turnstile = <span class="tok-k">false</span> } = {}) {
  <span class="tok-k">const</span> ts = turnstile ? <span class="tok-s">&#39; https://challenges.cloudflare.com&#39;</span> : <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">return</span> [
    <span class="tok-s">&quot;default-src &#39;self&#39;&quot;</span>,
    <span class="tok-s">`script-src &#39;self&#39; &#39;nonce-${n}&#39;${ts}`</span>,
    <span class="tok-s">`connect-src &#39;self&#39;${ts}`</span>,
    <span class="tok-s">`frame-src &#39;self&#39;${ts}`</span>,
    <span class="tok-c">// …</span>
  ];
}</code></pre></div>
<p>漏掉 <code>frame-src</code> 的后果很典型：组件是个 iframe，脚本能加载、能初始化，但框里一片空白，控制台报 CSP 违规——而你会先去怀疑 key 错了。<strong>开关必须同时管到&quot;脚本从哪来&quot;和&quot;框从哪来&quot;</strong>，这两个是不同的指令。</p>
<h3 id="校验-前端那个框只是个摆设"><a class="h-anchor" href="#校验-前端那个框只是个摆设">#</a>校验：前端那个框只是个摆设</h3>
<p>安全上唯一有意义的一步在服务端，<code>siteverify</code> 拿 token 复核：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> form = <span class="tok-k">new</span> <span class="tok-f">FormData</span>();
form.<span class="tok-f">append</span>(<span class="tok-s">&#39;secret&#39;</span>, secret);
form.<span class="tok-f">append</span>(<span class="tok-s">&#39;response&#39;</span>, <span class="tok-f">String</span>(token));
<span class="tok-k">if</span> (ip) form.<span class="tok-f">append</span>(<span class="tok-s">&#39;remoteip&#39;</span>, ip);

<span class="tok-k">const</span> r = <span class="tok-k">await</span> <span class="tok-f">fetch</span>(<span class="tok-s">&#39;https://challenges.cloudflare.com/turnstile/v0/siteverify&#39;</span>, { method: <span class="tok-s">&#39;POST&#39;</span>, body: form });
<span class="tok-k">const</span> d = <span class="tok-k">await</span> r.<span class="tok-f">json</span>();
<span class="tok-k">if</span> (d.success) <span class="tok-k">return</span> { ok: <span class="tok-k">true</span> };
<span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, error: <span class="tok-s">&#39;人机验证没通过，刷新页面再试一次&#39;</span> };</code></pre></div>
<p><code>remoteip</code> 是可选的，但传上去了能让 Cloudflare 把&quot;这个 token 是在哪个 IP 上签发的&quot;一起判——token 被搬到另一个 IP 上重放时才有得比。</p>
<h3 id="验不了的时候-这层是-fail-open-的"><a class="h-anchor" href="#验不了的时候-这层是-fail-open-的">#</a>验不了的时候：这层是 fail-open 的</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">} <span class="tok-k">catch</span> {
  <span class="tok-c">// 校验服务自己挂了，不能连累评论功能 —— 记一笔降级，放行</span>
  console.<span class="tok-f">warn</span>(<span class="tok-s">&#39;[antispam] turnstile siteverify 不可达，本次降级放行&#39;</span>);
  <span class="tok-k">return</span> { ok: <span class="tok-k">true</span>, degraded: <span class="tok-k">true</span> };
}</code></pre></div>
<p>这跟<a href="/p/editor-markdown-xss">上一节讲的 fail-closed</a>方向相反，是有意的：siteverify 是外部依赖，它挂的时候如果跟着 fail-closed，全站评论会以一个第三方服务为条件停摆，而攻击者只要能把那个域名打到超时，就等于免费关掉了你的评论区——<strong>这本身就是一次拒绝服务</strong>。</p>
<p>代价也真实：这条路理论上可被利用。能打挂 Cloudflare 校验接口的人，大概也不在乎你这一个博客的评论。取舍是这么算的。</p>
<h3 id="半配比不配更危险"><a class="h-anchor" href="#半配比不配更危险">#</a>半配比不配更危险</h3>
<p>这是我写完才想明白的一点，顺手补成了代码。Turnstile 有两个 key，配置有四种状态：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">turnstileMode</span>(env = {}) {
  <span class="tok-k">const</span> site = !!(env &amp;&amp; env.TURNSTILE_SITE_KEY);
  <span class="tok-k">const</span> secret = !!(env &amp;&amp; env.TURNSTILE_SECRET);
  <span class="tok-k">if</span> (site &amp;&amp; secret) <span class="tok-k">return</span> <span class="tok-s">&#39;on&#39;</span>;
  <span class="tok-k">if</span> (site) <span class="tok-k">return</span> <span class="tok-s">&#39;site-only&#39;</span>;
  <span class="tok-k">if</span> (secret) <span class="tok-k">return</span> <span class="tok-s">&#39;secret-only&#39;</span>;
  <span class="tok-k">return</span> <span class="tok-s">&#39;off&#39;</span>;
}</code></pre></div>
<ul><li><strong>只配 sitekey</strong>：前端老老实实弹验证框，访客认真勾了，服务端却无从校验——因为 <code>verifyTurnstile</code> 的第一行是&quot;没 secret 就跳过&quot;。这层防护是<strong>假的</strong>，而它看起来是真的。这种状态比不配更糟：不配你至少知道自己没防护。所以 <code>site-only</code> 按配置不完整拒收，宁可评论挂掉被发现；</li><li><strong>只配 secret</strong>：前端根本没组件，谁也拿不出 token，此时要求 token 等于全员禁言。按未启用处理，打一行 warn。</li></ul>
<p><strong>配置的一半不是一半的防护，是一半的错觉。</strong> 这条经验适用于所有&quot;开关 + 密钥&quot;双要素的服务，不只是 Turnstile。</p>
<h3 id="顺带修的一个死锁"><a class="h-anchor" href="#顺带修的一个死锁">#</a>顺带修的一个死锁</h3>
<p><code>mountTurnstile</code> 的 catch 里原来只有一句 <code>slot.hidden = true</code>。问题在提交时：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> tsToken = window.turnstile &amp;&amp; document.<span class="tok-f">getElementById</span>(<span class="tok-s">&#39;ts-wrap&#39;</span>)?.hidden === <span class="tok-k">false</span>
  ? window.turnstile.<span class="tok-f">getResponse</span>() : <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">if</span> (window.__SITE__ &amp;&amp; window.__SITE__.turnstile &amp;&amp; !tsToken) {
  <span class="tok-f">toast</span>(tsFailed ? <span class="tok-s">&#39;人机验证组件没加载出来，刷新页面或换个网络再试&#39;</span> : <span class="tok-s">&#39;先完成人机验证&#39;</span>);
  <span class="tok-k">return</span>;
}</code></pre></div>
<p>改之前这里只有一句&quot;先完成人机验证&quot;。当脚本被拦截插件掐掉、或者网络抖动没下来时，组件框并不存在，用户被要求去勾一个看不见的东西，刷新也不一定好——<strong>报错文案指错了方向，比没有文案更费时间</strong>。现在加载失败有单独的标记和单独的话。</p>
<h2 id="第三层-d1-限额-两把钥匙和一个时区"><a class="h-anchor" href="#第三层-d1-限额-两把钥匙和一个时区">#</a>第三层：D1 限额，两把钥匙和一个时区</h2>
<p>前两层管&quot;你是不是脚本&quot;，这层管&quot;你就算是真人，也别刷&quot;。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">const</span> MIN_GAP_SEC = <span class="tok-n">60</span>;   <span class="tok-c">// 同 IP 相邻两条的最小间隔</span>
<span class="tok-k">export</span> <span class="tok-k">const</span> DAY_MAX = <span class="tok-n">10</span>;       <span class="tok-c">// 每天上限（IP 与设备各算各的）</span></code></pre></div>
<p>判定抽成了一个不碰数据库、不发请求的纯函数，方便单测：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">judge</span>(rec, nowSec, { minGap = MIN_GAP_SEC, dayMax = DAY_MAX, checkGap = <span class="tok-k">true</span> } = {}) {
  <span class="tok-k">if</span> (!rec) <span class="tok-k">return</span> { ok: <span class="tok-k">true</span> };
  <span class="tok-k">if</span> (<span class="tok-f">Number</span>(rec.banned) === <span class="tok-n">1</span>) {
    <span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, status: <span class="tok-n">403</span>, error: <span class="tok-s">&#39;这个来源被拦下了，如果误伤请联系博主&#39;</span>, retry: <span class="tok-n">3600</span> };
  }
  <span class="tok-k">const</span> hits = rec.day === <span class="tok-f">dayKey</span>(nowSec) ? <span class="tok-f">Number</span>(rec.hits) : <span class="tok-n">0</span>;
  <span class="tok-k">if</span> (hits &gt;= dayMax) {
    <span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, status: <span class="tok-n">429</span>, error: <span class="tok-s">`今天已经发了 ${dayMax} 条，明天再来`</span>, retry: <span class="tok-f">secsToNextDay</span>(nowSec) };
  }
  <span class="tok-k">if</span> (checkGap &amp;&amp; rec.last_ts) {
    <span class="tok-k">const</span> gap = nowSec - <span class="tok-f">Number</span>(rec.last_ts);
    <span class="tok-k">if</span> (gap &lt; minGap) <span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, status: <span class="tok-n">429</span>, error: <span class="tok-s">&#39;发得太快了，隔一分钟再发&#39;</span>, retry: minGap - gap };
  }
  <span class="tok-k">return</span> { ok: <span class="tok-k">true</span> };
}</code></pre></div>
<p><strong>banned 的判断放在额度之前</strong>：被拉黑的人不管今天发了几条，拿到的都是 403 而不是 429。用状态码把&quot;你被禁了&quot;和&quot;你太快了&quot;分开，前端和日志都不用猜。</p>
<h3 id="为什么是两把钥匙"><a class="h-anchor" href="#为什么是两把钥匙">#</a>为什么是两把钥匙</h3>
<p><code>guard()</code> 同时查 <code>ip:…</code> 和 <code>dev:…</code> 两行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> ip = request.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;cf-connecting-ip&#39;</span>) || <span class="tok-s">&#39;0.0.0.0&#39;</span>;
<span class="tok-k">const</span> raw = <span class="tok-f">parseCookies</span>(request)[DID_COOKIE] || <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">const</span> did = /^[a-f0-<span class="tok-n">9</span>]{<span class="tok-n">24</span>,<span class="tok-n">64</span>}$/i.<span class="tok-f">test</span>(raw) ? raw.<span class="tok-f">toLowerCase</span>() : <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">const</span> fresh = !did;</code></pre></div>
<ul><li><strong>IP 那把</strong>：60 秒一条 + 每天 10 条；</li><li><strong>设备那把</strong>（<code>cmt_did</code>，服务端发的 32 位十六进制，HttpOnly + Secure + 400 天）：只查每天 10 条，<strong>不查间隔</strong>。</li></ul>
<p>设备键不查 60 秒间隔，是因为同一个人的两个标签页不该互相拦——IP 键已经把&quot;机器人连发&quot;拦住了，设备键存在的意义是&quot;同一台机器就算换 IP 也别超过 10 条&quot;，它不需要管节奏。</p>
<p>实测落库的样子（两次写入是同一秒，所以 <code>last_ts</code> 一样）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">k                                day          hits  last_ts
ip:188.253.6.247                 2026-11-12   1     1794413231
dev:46d65ce8…c45caa0f            2026-11-12   1     1794413231</code></pre></div>
<h3 id="那个日期是-11-12-而-utc-还在-11-11"><a class="h-anchor" href="#那个日期是-11-12-而-utc-还在-11-11">#</a>那个日期是 11-12，而 UTC 还在 11-11</h3>
<p>这不是 bug。<code>last_ts = 1794413231</code> 是 UTC <code>2026-11-11 16:07:11</code>，北京时间 <code>2026-11-12 00:07:11</code>，而日额度的日期键按 <strong>UTC+8</strong> 切：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> TZ_OFFSET = <span class="tok-n">8</span> * <span class="tok-n">3600</span>;
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">dayKey</span>(sec) {
  <span class="tok-k">return</span> <span class="tok-k">new</span> <span class="tok-f">Date</span>((sec + TZ_OFFSET) * <span class="tok-n">1000</span>).<span class="tok-f">toISOString</span>().<span class="tok-f">slice</span>(<span class="tok-n">0</span>, <span class="tok-n">10</span>);
}</code></pre></div>
<p>用 UTC 零点换天的后果很具体：<strong>北京时间早上 8 点，一个中国访客的额度刚被重置</strong>——他在凌晨刷满 10 条，睡一觉起来又能刷。按作者的生活时间切，额度才对应&quot;今天&quot;这个直觉。</p>
<p><code>retry-after</code> 也跟着算，而不是固定给 60：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">secsToNextDay</span>(sec) {
  <span class="tok-k">const</span> local = sec + TZ_OFFSET;
  <span class="tok-k">return</span> <span class="tok-n">86400</span> - (local % <span class="tok-n">86400</span>);
}</code></pre></div>
<p>上面那个时刻如果打满日额度，返回的 <code>Retry-After</code> 是 <strong>85969</strong>（≈23.88 小时），不是 86400——因为当天已经过了 431 秒。少算这 431 秒的后果是客户端多等一会儿，不算大事；但一个&quot;永远返回 86400&quot;的实现，在 23:59 提交的人会被要求等一整天，差了一秒的边界就成了差一天的体验。</p>
<h3 id="记账的时机-落库成功才记"><a class="h-anchor" href="#记账的时机-落库成功才记">#</a>记账的时机：落库成功才记</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 落库成功才计额度：被 400 拒掉的请求不占次数</span>
<span class="tok-k">if</span> (rate &amp;&amp; rate.ok) {
  <span class="tok-k">await</span> <span class="tok-f">record</span>(db, rate.ip, rate.did, Math.<span class="tok-f">floor</span>(Date.<span class="tok-f">now</span>() / <span class="tok-n">1000</span>));
  <span class="tok-k">if</span> (rate.fresh) headers[<span class="tok-s">&#39;set-cookie&#39;</span>] = <span class="tok-f">setCookie</span>(<span class="tok-s">&#39;cmt_did&#39;</span>, rate.did, { maxAge: DID_MAX_AGE });
}</code></pre></div>
<p>这个先后顺序很重要。假如改成&quot;请求进来就先记一笔&quot;，那么任何人只要对着接口发 10 个内容为空的请求，就能把这个 IP 后面一小时（甚至一天）的评论额度全部烧掉——<strong>在一个所有访客共享出口 IP 的移动网络下，这等于给陌生人一个关掉评论区的能力</strong>。</p>
<p>写库用一条 upsert 同时处理&quot;新的一天&quot;和&quot;同一天累加&quot;：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">INSERT INTO comment_guard (k, day, hits, last_ts) VALUES (?, ?, <span class="tok-n">1</span>, ?)
ON <span class="tok-f">CONFLICT</span>(k) DO UPDATE SET
  hits = CASE WHEN comment_guard.day = ? THEN comment_guard.hits + <span class="tok-n">1</span> ELSE <span class="tok-n">1</span> END,
  day  = ?,
  last_ts = ?;</code></pre></div>
<p><code>hits = CASE WHEN day 相同 THEN hits+1 ELSE 1</code> 这一行替代了&quot;先查再判断要不要清零&quot;的三次往返。跨天不需要定时任务，第一次写入自然把计数打回 1。</p>
<h3 id="时间逻辑单独说-它最容易写错"><a class="h-anchor" href="#时间逻辑单独说-它最容易写错">#</a>时间逻辑单独说，它最容易写错</h3>
<p><code>judge</code> 抽成纯函数就是为了测它。13 条断言里，4 条专门钉时间：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">ok  同一天打满额度就拦，retry 指向次日零点
ok  跨天后额度归零：昨天打满不影响今天
ok  间隔不足 60 秒拦住，retry 是差额
ok  刚好满 60 秒放行
ok  日期按 UTC+8 切：UTC 16:00 就是北京的次日零点
ok  secsToNextDay 在北京零点等于一整天</code></pre></div>
<p>&quot;刚好满 60 秒放行&quot;和&quot;跨天后归零&quot;这两条，如果用 <code>&lt;=</code> 而不是 <code>&lt;</code>、用 <code>day !==</code> 而不是 <code>day ===</code>，人肉 review 三遍都看不出来，线上表现是&quot;偶尔少拦一条&quot;或者&quot;偶尔多拦一条&quot;——<strong>没有测试的话，这种 bug 会活到你自己被拦的那天</strong>。</p>
<h2 id="封-ip-一键连坐-而不是单点删除"><a class="h-anchor" href="#封-ip-一键连坐-而不是单点删除">#</a>封 IP：一键连坐，而不是单点删除</h2>
<p>管理员视图里每条访客评论旁边的按钮，title 原文是&quot;删掉这个来源的全部访客评论，并拉黑该 IP&quot;。它做的事：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 只清访客评论，管理员自己的一条都不动</span>
<span class="tok-k">const</span> { results } = <span class="tok-k">await</span> db
  .<span class="tok-f">prepare</span>(<span class="tok-s">&#39;SELECT id FROM comments WHERE ip = ? AND is_admin = 0&#39;</span>)
  .<span class="tok-f">bind</span>(c.ip).<span class="tok-f">all</span>();
<span class="tok-c">// …删掉这些评论及其子回复…</span>
<span class="tok-k">await</span> <span class="tok-f">banIp</span>(db, c.ip);</code></pre></div>
<p>三个决定：</p>
<ol><li><strong>连坐</strong>：一个来发广告的号不会只发一条，逐条删等于替它做签到。按 IP 一次清干净，不留&quot;漏网的那条明天冒出来&quot;的尾巴；</li><li><strong><code>is_admin = 0</code> 这个条件是必须的</strong>：同一条宽带下，我自己的评论和访客的评论 IP 是一样的。少了这个条件，点一次&quot;封 IP&quot;会把自己写过的评论一起抹掉；</li><li><strong>入口做成一条评论上的按钮</strong>，而不是后台一个 IP 黑名单表格。处置的动作发生在&quot;你正看着垃圾&quot;的那一刻，三个点击内完成。</li></ol>
<p><code>banIp</code> 只写一个字段：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">INSERT INTO comment_guard (k, day, hits, last_ts, banned) VALUES (?, ?, <span class="tok-n">0</span>, <span class="tok-n">0</span>, <span class="tok-n">1</span>)
ON <span class="tok-f">CONFLICT</span>(k) DO UPDATE SET banned = <span class="tok-n">1</span>;</code></pre></div>
<p>顺手回答一个必然会问的问题：<strong>没有 TTL，是永久的</strong>。解封目前只能改库——后台没有解封入口。这是个真实欠账，不是设计。</p>
<p>拉黑动作本身也值得说：它是<strong>人按的</strong>，没有自动规则。这条和<a href="/p/worker-cron-friend-check">友链检测篇那个&quot;403 不算挂&quot;</a>是同一类教训的反面——<strong>&quot;看着像垃圾&quot;也不等于垃圾</strong>。按 UA、按关键词、按频率自动封，第一个被误伤的永远是办公网出口、公司 NAT、运营商 CGNAT。自动封禁省的是我的点击，花的是误伤活人的风险，这买卖现在不做。</p>
<h2 id="数据面-邮箱和-ip-只进不出"><a class="h-anchor" href="#数据面-邮箱和-ip-只进不出">#</a>数据面：邮箱和 IP 只进不出</h2>
<p>这条其实比 Turnstile 更早生效。评论要求填邮箱，但公开列表接口按身份剥字段：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> isAdm = !!(user &amp;&amp; user.is_admin);
<span class="tok-k">const</span> rows = isAdm ? results : results.<span class="tok-f">map</span>(({ email, ip, ...rest }) =&gt; rest);</code></pre></div>
<p>实测的公开响应（游客视角）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">json</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-json">{<span class="tok-s">&quot;ok&quot;</span>:<span class="tok-k">true</span>,<span class="tok-s">&quot;total&quot;</span>:<span class="tok-n">1</span>,<span class="tok-s">&quot;comments&quot;</span>:[{<span class="tok-s">&quot;id&quot;</span>:<span class="tok-n">9</span>,<span class="tok-s">&quot;parent_id&quot;</span>:<span class="tok-k">null</span>,<span class="tok-s">&quot;name&quot;</span>:<span class="tok-s">&quot;石井探针&quot;</span>,
 <span class="tok-s">&quot;website&quot;</span>:<span class="tok-s">&quot;&quot;</span>,<span class="tok-s">&quot;content&quot;</span>:<span class="tok-s">&quot;防滥用探针：这条会在验证后被删除。&quot;</span>,<span class="tok-s">&quot;is_admin&quot;</span>:<span class="tok-n">0</span>,
 <span class="tok-s">&quot;created_at&quot;</span>:<span class="tok-s">&quot;2026-11-11 16:07:11&quot;</span>,<span class="tok-s">&quot;replies&quot;</span>:[]}]}</code></pre></div>
<p>没有 <code>email</code>，没有 <code>ip</code>。管理员视图里邮箱渲染成一个 <code>mailto:</code> 链接（title &quot;联系邮箱，仅管理员可见&quot;），IP 只用于&quot;封 IP&quot;这个动作。</p>
<p>为什么值得单独写一节：<strong>垃圾评论存在的意义之一就是收割邮箱</strong>。把它们的存在理由去掉一半，比多拦几条更有用。到了<a href="/p/about">全站邮箱混淆</a>那一步，这条线才真正闭合——公开页面上连一个可抓的地址都没有。</p>
<h2 id="六个没做-明说"><a class="h-anchor" href="#六个没做-明说">#</a>六个没做，明说</h2>
<p>比&quot;做了什么&quot;更需要说清楚的是边界：</p>
<ol><li><strong>没有内容层检测</strong>。不看链接数、不看关键词、不接第三方库。一条评论只要过了人机验证和频率限制，就会立即公开。这是拿&quot;少量垃圾可见&quot;换&quot;零审核压力&quot;；</li><li><strong>限额只有两把钥匙</strong>。换 IP + 清 cookie 之后，就只剩 IP 那一把的额度可算。没有网段聚合、没有 ASN 维度。要绕真能绕，只是绕的成本比发广告的收益高；</li><li><strong><code>banned</code> 永久，没有解封入口</strong>。误封只能进 D1 改 <code>banned = 0</code>。写在这里，是因为半年后我自己也会忘；</li><li><strong>siteverify 网络异常时放行</strong>。见上文，可用性优先于这层防护，代价是理论上可被&quot;打挂校验服务&quot;绕过；</li><li><strong>10 条/天在 CGNAT 出口会误伤</strong>。一个宿舍楼、一个公司出口，10 个真人一天只能发 10 条。这个数字是按单人站点的真实流量定的，不是按&quot;公平&quot;定的；</li><li><strong>蜜罐的 400 可被学习</strong>。脚本第二次就知道 <code>hp</code> 要留空。这层只对&quot;第一次来的懒脚本&quot;有效。</li></ol>
<p>还有一件属于权衡而非欠账的：<strong>没有先审后发</strong>。评论即时公开，管理员事后处置——这也是排序题的一部分，审核压力放在人身上，比放在请求路径上贵得多。</p>
<h2 id="清单"><a class="h-anchor" href="#清单">#</a>清单</h2>
<div class="table-wrap"><table><thead><tr><th>层</th><th>机制</th><th>抓谁</th><th>误伤谁</th><th>失败方向</th></tr></thead><tbody><tr><td>表单</td><td><code>hp</code> 蜜罐（视窗外 + <code>tabindex=-1</code> + <code>autocomplete=off</code>）</td><td>不跑 JS 的填表机</td><td>谁都不，除非密码管理器硬填</td><td>closed</td></tr><tr><td>前端</td><td>Turnstile explicit，<code>sitekey</code> 驱动，没配 = 0 请求</td><td>浏览器级脚本</td><td>无</td><td>closed（组件加载失败就不让提交）</td></tr><tr><td>服务端</td><td><code>siteverify</code> 复核 token + <code>remoteip</code></td><td>伪造提交的脚本</td><td>无</td><td>open（校验服务不可达时降级放行）</td></tr><tr><td>限额</td><td>D1 双钥匙（IP / 设备），60 秒 + 10 条/天，UTC+8 换天</td><td>真人刷屏、换 cookie 刷</td><td>CGNAT 共享出口</td><td>closed</td></tr><tr><td>处置</td><td>封 IP：清同源访客评论 + 永久拉黑</td><td>已成灾的来源</td><td>同 NAT 下的其他访客——靠人按</td><td>手按</td></tr><tr><td>数据面</td><td>邮箱/IP 按 <code>isAdmin</code> 剥字段</td><td>采集器</td><td>无</td><td>closed</td></tr></tbody></table></div>
<p>三层加起来不到 200 行，没有一处需要模型、规则库或者人来值班。<strong>够不够用，取决于你的评论区有没有人想攻</strong>——单作者站，这三层大概能撑到&quot;第一个认真的人出现&quot;。</p>
<p>至于它撑了多久、后台那个&quot;封 IP&quot;按钮到底有没有被真的按过——等第一条垃圾评论出现，拿真实处置记录写《垃圾评论标本室》。在那之前，继续写正经的。</p>
<p>后补一句：蜜罐命中时到底返回什么、拦住的到底是响应还是落库，后来单独写成了一篇（排期 2027-02）。在那之前，把 <code>400</code> 改成 <code>200</code>、或者把蜜罐挪到 <code>INSERT</code> 之后，<code>npm test</code> 一条都不会红。</p>
<p><a class="tag-inline" href="/tag/cloudflare">#cloudflare</a> <a class="tag-inline" href="/tag/turnstile">#turnstile</a> <a class="tag-inline" href="/tag/security">#security</a></p>', cover_body = '', updated_at = datetime('now')
  WHERE slug = 'comment-anti-spam';
-- 回补内链：12-sticky-toc-grid-align-items.md
UPDATE posts SET content = '## 结论

目录不跟着滚，跟 `position: sticky` 本身没关系。问题是**它所在的那一格太矮**。

`.post-article` 是 grid，目录那一格写了 `align-items: start`。Grid 的默认值其实是 `stretch`，`start` 是写卡片列表时留下的肌肉记忆——列表里不希望每张卡被拉成一样高。放到两栏布局上，这条习惯让目录格的高度等于自身内容高度：**336px**。

sticky 的活动范围以包含块为界。包含块只有 336px 高，滚过 336px 之后目录就跟着文章一起出了视口。滚动高亮是另一套逻辑，照常工作，所以现象看起来像"目录在动，位置不动"——这大概是最容易误判成"sticky 没生效"的形态。

同一篇文章、同一份 CSS，只把这一个属性改回 `stretch`：

| 指标 | `align-items: start` | `align-items: stretch` |
|---|---|---|
| `.post-toc` 高度 | 336px | 12939px |
| 滚到 35%（scrollY 4272）时目录顶端 | −4172px | 86px |
| 滚到 60%（scrollY 7324）时目录顶端 | −7224px | 86px |

改的是一个关键字，多出来的是 12603px 的可滚余量。下面是完整过程，以及修好之后才浮出来的四处连带问题。

## 一、先量，不猜

现象是读者反馈的一句话：「目录能不能跟着文章动」。这种描述信息量为零——可能是没吸顶、可能是吸顶了但不高亮、可能是高亮错了。先量。

```js
// 无头浏览器里对线上页面直接量，不靠肉眼
const box = await page.evaluate(() => {
  const art = document.querySelector(''.post-article'');
  const toc = document.querySelector(''.post-toc'');
  const inner = document.querySelector(''.toc-inner'');   // 真正 sticky 的那层
  const r = (el) => el.getBoundingClientRect();
  return {
    artH: Math.round(r(art).height),
    tocH: Math.round(r(toc).height),
    innerH: Math.round(r(inner).height),
    innerTop: Math.round(r(inner).top),
  };
});
```

第一次量到的四个数：`artH 12979`、`tocH 336`、`innerH 336`、滚到 35% 时 `innerTop −4172`。

这里有个关键对照：**文章容器 12979px，目录格 336px**。同一行的两个 grid item，一个撑满了整篇文章，另一个只有自己那么高。sticky 的余量就藏在这个差值里。

顺便用同一份 DOM 做了 A/B：注入一行 `align-items: start` 再量，其他什么都不动。数字就是上面那张表——同一页面、同一内容、同一个滚动位置，指针从 −4172 回到 86。

## 二、sticky 的天花板是父容器，不是视口

`position: sticky` 的定位过程分两段：先按正常流站位，再在滚动时把元素"粘"住，但**粘的范围不能超过它的包含块**。包含块一旦滚完，元素就跟着一起走。

所以一个 sticky 元素实际能固定的距离，就是一句话：**可固定距离 = 包含块高度 − 自身高度**。

目录格 336px、目录自身 336px，相减是 0。它不是"偶尔没粘住"，是从第一屏开始就没有可粘的空间——只不过页面顶部那一段本来也对得上，看不出问题。

这也解释了为什么在别的站上同样的代码是好的：他们的目录格被内容撑开了，或者本来就用了 `stretch`。这是一个**依赖父容器高度**的属性，抄代码抄不到父容器。

## 三、修法是两行

```css
/* 关键：grid item 必须 stretch 到整行高度，否则 sticky 没有可滚的余量。
   这不是"顺便对齐"，是 sticky 生效的前提。 */
.post-article {
  display: grid;
  grid-template-columns: 220px minmax(0, 800px);
  gap: 110px;
  align-items: stretch;          /* 默认值，但写出来，防止再被 start 覆盖 */
}

/* 目录外面那层只负责撑高，里面那层才吸顶 */
.post-toc { align-self: stretch; }

.post-toc .toc-inner {
  position: sticky;
  top: 86px;
  max-height: calc(100vh - 118px);
  overflow: auto;
}
```

两行里只有一行是必需的（`align-items: stretch`）。`align-self: stretch` 是重复声明，留着是为了将来有人在容器上改回 `start` 时，目录这一格不跟着塌——这种"防御性重复"在布局代码里值得写，因为改容器的人不会记得目录依赖它。

`.toc-inner` 内部再嵌一层的原因也在同一处：外层负责高度，内层负责吸顶。两件事分开，`max-height` 才好算。

## 四、修好之后才看见的第二层：高亮判据

目录能跟着滚了，问题立刻变成"高亮跟不上"。这里没用 `IntersectionObserver`，用的是最笨的一条线：

```js
const onScroll = () => {
  const line = window.scrollY + 96;             // 吸顶区下沿再往下一点
  let active = pairs[0][0];
  for (const [el, a] of pairs) {
    // 标题顶端在页面里的绝对位置，越过这条线就算"当前节"
    if (el.getBoundingClientRect().top + window.scrollY <= line) {
      active = el;
      activeLink = a;
    }
  }
  // …切换 class、更新进度条、滚动目录
};
```

不用 IO 的理由有两条：

1. **语义不对**。IO 回答的是"元素有没有进入视口"，我要的是"哪一条标题是最后一条越过吸顶线的"。一节长两千字，进入视口的那一刻和读完的那一刻差很远。
2. **会同时命中多个**。可见区里经常并排两三个 h2，IO 的回调只告诉你"这两个都在"，排序还得自己做。既然要遍历，不如一开始就遍历。

代价是每个 `scroll` 事件都要算一次 `getBoundingClientRect()`。十几个标题的规模下可以忽略，用 `requestAnimationFrame` 合并一帧内的多次事件就够：

```js
let raf = 0;
const onEvt = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; onScroll(); }); };
addEventListener(''scroll'', onEvt, { passive: true });
```

## 五、进度条：端点停在当前项的中点

左侧那条跟着走的色条不是独立算的，它借用了同一次计算的结果：

```js
const li = activeLink.closest(''li'');
const oR = ol.getBoundingClientRect();
const lR = li.getBoundingClientRect();
// 高度占比 = 当前项中点相对目录顶部的距离
const p = ((lR.top + lR.height / 2 - oR.top) / oR.height) * 100;
ol.style.setProperty(''--toc-p'', Math.max(0, Math.min(100, p)) + ''%'');
```

CSS 侧只是一条 `::before`，高度吃这个变量，`transition: height .18s` 让它是滑过去而不是跳过去：

```css
.post-toc ol { position: relative; border-left: 1px solid var(--line); }
.post-toc ol::before {
  content: ''''; position: absolute; left: -1px; top: 0; width: 2px;
  height: var(--toc-p, 0%);
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  transition: height .18s ease-out;
}
```

在站内一篇 8 个小节的文章上量的五个点：

| 滚动位置 | scrollY | `--toc-p` | 高亮项 |
|---|---|---|---|
| 顶部 | 0 | 7.4% | 01 |
| 35% | 4272 | 37.0% | 03 |
| 60% | 7324 | 51.7% | 04 |
| 95% | 11597 | 87.0% | 07 |
| 底部 | 12207 | 95.7% | 08 |

读到底时进度条停在 95.7% 而不是 100%，因为端点算的是最后一项的**中点**，不是目录底部。这是刻意的：条拉满意味着"下面还有"，停在最后一项的中点意味着"到头了"。

## 六、到底兜底：最后一个标题永远越不过那条线

这一条不做，前五条的效果全废。

判据是"标题顶端越过 `scrollY + 96`"。但最后一节往往只占屏幕下半部分，它的顶端在页面里的位置可能离页底只有 700px——滚到最底，`scrollY + 96` 仍然追不上它。表现就是：读完全文，目录还停在第 7 项。

```js
const atBottom = Math.ceil(window.scrollY + innerHeight)
                 >= document.documentElement.scrollHeight - 2;
```

到底了就直接认最后一项，跳过整段遍历。实测滚到 100% 时高亮是 08，进度 95.7%，两项都对得上。

另一个思路是给正文加 `padding-bottom: 100vh`，让最后一个标题能真正越过判据线。没采用：每篇文章末尾都会多出一大块空白，短文尤其明显，而且要按文章长度调。一行 `if` 能解决的事，不值得换一段留白。

## 七、目录自己也会滚

标题一多，目录比视口还高。这时 sticky 之外还要加一层：目录内部滚动。

```css
.post-toc .toc-inner {
  position: sticky; top: 86px;
  max-height: calc(100vh - 118px);   /* 86 顶部 + 32 底部余量 */
  overflow: auto;
  scrollbar-width: thin;
}
```

往里滚的时候不能让高亮项跑出可视区，所以每次切换都把它拉回来。注意这段只动**目录自己的 `scrollTop`**：

```js
const keepVisible = (a) => {
  const box = scrollerOf(a);                 // 最近的 overflow: auto 祖先
  if (!box) return;
  const br = box.getBoundingClientRect();
  const ar = a.getBoundingClientRect();
  const pad = br.height * 0.28;              // 上下各留 28% 缓冲
  if (ar.top < br.top + pad) box.scrollTo({ top: box.scrollTop - (br.top + pad - ar.top), behavior: ''smooth'' });
  else if (ar.bottom > br.bottom - pad) box.scrollTo({ top: box.scrollTop + (ar.bottom - (br.bottom - pad)), behavior: ''smooth'' });
};
```

第一版写的是 `a.scrollIntoView({ block: ''center'' })`。它会把**页面**也一起滚一下（`scrollIntoView` 不区分容器），于是滚动事件再触发一次高亮计算，页面开始自己抖。改成只操作容器 `scrollTop` 就干净了。

留 28% 缓冲而不是 `center`，是为了让下一项也露出来——读者能看到"后面还有"，而不是每次只剩当前这一行。

## 八、点击落点要对齐吸顶区

能滚、能高亮之后，还剩一个体感问题：点目录跳过去，标题要么被吸顶条盖住一截，要么离得太远。

这里有三个数字必须成对出现：

| 参数 | 值 | 作用 |
|---|---|---|
| 顶栏高度 | 72px + 阅读进度条 2px | 吸顶区实际占 74px |
| `.toc-inner` 的 `top` | 86px | 目录停在吸顶区下方 12px |
| 标题的 `scroll-margin-top` | 88px | 锚点跳转后标题离视口顶 88px |

实测点第 5 项，跳转后标题的 `getBoundingClientRect().top` 正好是 **88**，和 `scroll-margin-top` 一致：

```css
/* 锚点跳转时浏览器会把这 88px 让出来，标题不会藏进吸顶条 */
.md h2, .md h3, .md h4 { scroll-margin-top: 88px; }
```

只调其中一个就会露馅：`top` 调到 120 而 `scroll-margin-top` 还是 88，点完标题会钻进目录上方那条缝里；反过来则会在标题上方留一大片空。

## 九、手机上不 sticky，换成抽屉

窄屏没有左侧那 220px，硬塞目录会把正文压到 300px 以下。所以 1080 以下直接 `display: none`，另起一套：右下角一个悬浮按钮，点开是底部抽屉。

实现上没重算任何东西，直接把桌面那份链接复制过去：

```js
const src = document.querySelectorAll(''.post-toc a[data-toc]'');
const items = [...src].map((a) =>
  // href 照抄桌面那条：SSR 里是 #中文id，自己再 encodeURI 一遍会变成两种地址
  `<a href="${a.getAttribute(''href'')}" data-toc="${a.dataset.toc}">${a.innerHTML}</a>`
).join('''');
```

几个细节：

- 按钮在滚过文章头部之后才浮出来（`opacity 0 → 1`），第一屏不挡内容。
- 打开时给 `html` 加 `overflow: hidden`，否则背景还能滚，抽屉跟着页面飘。
- 点条目时**先关抽屉再让浏览器跳转**。顺序反了的话，`overflow: hidden` 还在，锚点跳转会被吞掉。
- Esc、点遮罩、点关闭都能收。

390×844 实测：初始按钮 `opacity 0`、`pointer-events: none`；滚动后 `opacity 1`，标签显示「目录 8」；点开抽屉 8 项齐全，`html` 的 `overflow` 变 `hidden`，当前项已高亮。

## 十、边界，明说

1. **目录只收 h2**。h3 收进来会到 20 项以上，扫起来比手动找还慢。长文里 h3 是段落内的小标题，不该进导航。
2. **锚点 id 是中文**（`#封-ip-一键连坐-而不是单点删除`），分享出去的链接百分号编码后很长。改成短 id 会让已有外链全部失效，不动。
3. **无 JS 时**目录仍然能点（链接是 SSR 出来的），但没有高亮、没有进度条、也没有手机抽屉。
4. **打印时**整块目录 `display: none`，正文全宽——纸上不需要导航。
5. **目录超过一屏**靠内部滚动；如果哪天某篇有 40 个小节，得做分组折叠，现在没做。

## 一条清单

下次再给页面加侧边目录，按这个顺序检查：

1. 先量 sticky 元素的**父容器**高度，不是它自己的。`可固定距离 = 父高 − 自身高`，这个差值是 0 就一定是坏的。
2. grid / flex 里看 `align-items` 和 `align-self`。默认 `stretch`，被改成 `start` 就等于砍掉了 sticky 的余量。
3. 点击落点用 `scroll-margin-top`，和吸顶的 `top` 一起调，两个数字必须对得上。
4. 滚到底要单独兜底。最后一个标题通常越不过判据线，这是结构问题，不是阈值没调好。
5. 内部滚动只动容器，别用 `scrollIntoView`——它会把整个页面也拖一下。

这一篇里真正难的不是 sticky，是**"看着像样式问题"的直觉**。目录不动、高亮在动，第一反应都是去查 sticky 的语法或者 z-index。查语法永远查不出来，因为语法没错；错的是它脚下那块地只有 336px 高。

后来把这段的**成因**也搬进了 CI——`test-sticky-css.mjs` 守 CSS 那三行（`align-items: stretch` 出现 `start` 即红），真机脚本守现象。那份对账写在另一篇里（排期 2027-02）：CI 里没有长文章，所以只能守成因。

#css #layout #browsers
', html_content = '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>目录不跟着滚，跟 <code>position: sticky</code> 本身没关系。问题是<strong>它所在的那一格太矮</strong>。</p>
<p><code>.post-article</code> 是 grid，目录那一格写了 <code>align-items: start</code>。Grid 的默认值其实是 <code>stretch</code>，<code>start</code> 是写卡片列表时留下的肌肉记忆——列表里不希望每张卡被拉成一样高。放到两栏布局上，这条习惯让目录格的高度等于自身内容高度：<strong>336px</strong>。</p>
<p>sticky 的活动范围以包含块为界。包含块只有 336px 高，滚过 336px 之后目录就跟着文章一起出了视口。滚动高亮是另一套逻辑，照常工作，所以现象看起来像&quot;目录在动，位置不动&quot;——这大概是最容易误判成&quot;sticky 没生效&quot;的形态。</p>
<p>同一篇文章、同一份 CSS，只把这一个属性改回 <code>stretch</code>：</p>
<div class="table-wrap"><table><thead><tr><th>指标</th><th><code>align-items: start</code></th><th><code>align-items: stretch</code></th></tr></thead><tbody><tr><td><code>.post-toc</code> 高度</td><td>336px</td><td>12939px</td></tr><tr><td>滚到 35%（scrollY 4272）时目录顶端</td><td>−4172px</td><td>86px</td></tr><tr><td>滚到 60%（scrollY 7324）时目录顶端</td><td>−7224px</td><td>86px</td></tr></tbody></table></div>
<p>改的是一个关键字，多出来的是 12603px 的可滚余量。下面是完整过程，以及修好之后才浮出来的四处连带问题。</p>
<h2 id="一-先量-不猜"><a class="h-anchor" href="#一-先量-不猜">#</a>一、先量，不猜</h2>
<p>现象是读者反馈的一句话：「目录能不能跟着文章动」。这种描述信息量为零——可能是没吸顶、可能是吸顶了但不高亮、可能是高亮错了。先量。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 无头浏览器里对线上页面直接量，不靠肉眼</span>
<span class="tok-k">const</span> box = <span class="tok-k">await</span> page.<span class="tok-f">evaluate</span>(() =&gt; {
  <span class="tok-k">const</span> art = document.<span class="tok-f">querySelector</span>(<span class="tok-s">&#39;.post-article&#39;</span>);
  <span class="tok-k">const</span> toc = document.<span class="tok-f">querySelector</span>(<span class="tok-s">&#39;.post-toc&#39;</span>);
  <span class="tok-k">const</span> inner = document.<span class="tok-f">querySelector</span>(<span class="tok-s">&#39;.toc-inner&#39;</span>);   <span class="tok-c">// 真正 sticky 的那层</span>
  <span class="tok-k">const</span> r = (el) =&gt; el.<span class="tok-f">getBoundingClientRect</span>();
  <span class="tok-k">return</span> {
    artH: Math.<span class="tok-f">round</span>(<span class="tok-f">r</span>(art).height),
    tocH: Math.<span class="tok-f">round</span>(<span class="tok-f">r</span>(toc).height),
    innerH: Math.<span class="tok-f">round</span>(<span class="tok-f">r</span>(inner).height),
    innerTop: Math.<span class="tok-f">round</span>(<span class="tok-f">r</span>(inner).top),
  };
});</code></pre></div>
<p>第一次量到的四个数：<code>artH 12979</code>、<code>tocH 336</code>、<code>innerH 336</code>、滚到 35% 时 <code>innerTop −4172</code>。</p>
<p>这里有个关键对照：<strong>文章容器 12979px，目录格 336px</strong>。同一行的两个 grid item，一个撑满了整篇文章，另一个只有自己那么高。sticky 的余量就藏在这个差值里。</p>
<p>顺便用同一份 DOM 做了 A/B：注入一行 <code>align-items: start</code> 再量，其他什么都不动。数字就是上面那张表——同一页面、同一内容、同一个滚动位置，指针从 −4172 回到 86。</p>
<h2 id="二-sticky-的天花板是父容器-不是视口"><a class="h-anchor" href="#二-sticky-的天花板是父容器-不是视口">#</a>二、sticky 的天花板是父容器，不是视口</h2>
<p><code>position: sticky</code> 的定位过程分两段：先按正常流站位，再在滚动时把元素&quot;粘&quot;住，但<strong>粘的范围不能超过它的包含块</strong>。包含块一旦滚完，元素就跟着一起走。</p>
<p>所以一个 sticky 元素实际能固定的距离，就是一句话：<strong>可固定距离 = 包含块高度 − 自身高度</strong>。</p>
<p>目录格 336px、目录自身 336px，相减是 0。它不是&quot;偶尔没粘住&quot;，是从第一屏开始就没有可粘的空间——只不过页面顶部那一段本来也对得上，看不出问题。</p>
<p>这也解释了为什么在别的站上同样的代码是好的：他们的目录格被内容撑开了，或者本来就用了 <code>stretch</code>。这是一个<strong>依赖父容器高度</strong>的属性，抄代码抄不到父容器。</p>
<h2 id="三-修法是两行"><a class="h-anchor" href="#三-修法是两行">#</a>三、修法是两行</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css"><span class="tok-c">/* 关键：grid item 必须 stretch 到整行高度，否则 sticky 没有可滚的余量。
   这不是&quot;顺便对齐&quot;，是 sticky 生效的前提。 */</span>
.post-article {
  display: grid;
  grid-template-columns: <span class="tok-n">220px</span> <span class="tok-f">minmax</span>(<span class="tok-n">0</span>, <span class="tok-n">800px</span>);
  gap: <span class="tok-n">110px</span>;
  align-items: stretch;          <span class="tok-c">/* 默认值，但写出来，防止再被 start 覆盖 */</span>
}

<span class="tok-c">/* 目录外面那层只负责撑高，里面那层才吸顶 */</span>
.post-toc { align-self: stretch; }

.post-toc .toc-inner {
  position: sticky;
  top: <span class="tok-n">86px</span>;
  max-height: <span class="tok-f">calc</span>(<span class="tok-n">100vh</span> - <span class="tok-n">118px</span>);
  overflow: auto;
}</code></pre></div>
<p>两行里只有一行是必需的（<code>align-items: stretch</code>）。<code>align-self: stretch</code> 是重复声明，留着是为了将来有人在容器上改回 <code>start</code> 时，目录这一格不跟着塌——这种&quot;防御性重复&quot;在布局代码里值得写，因为改容器的人不会记得目录依赖它。</p>
<p><code>.toc-inner</code> 内部再嵌一层的原因也在同一处：外层负责高度，内层负责吸顶。两件事分开，<code>max-height</code> 才好算。</p>
<h2 id="四-修好之后才看见的第二层-高亮判据"><a class="h-anchor" href="#四-修好之后才看见的第二层-高亮判据">#</a>四、修好之后才看见的第二层：高亮判据</h2>
<p>目录能跟着滚了，问题立刻变成&quot;高亮跟不上&quot;。这里没用 <code>IntersectionObserver</code>，用的是最笨的一条线：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> onScroll = () =&gt; {
  <span class="tok-k">const</span> line = window.scrollY + <span class="tok-n">96</span>;             <span class="tok-c">// 吸顶区下沿再往下一点</span>
  <span class="tok-k">let</span> active = pairs[<span class="tok-n">0</span>][<span class="tok-n">0</span>];
  <span class="tok-k">for</span> (<span class="tok-k">const</span> [el, a] <span class="tok-k">of</span> pairs) {
    <span class="tok-c">// 标题顶端在页面里的绝对位置，越过这条线就算&quot;当前节&quot;</span>
    <span class="tok-k">if</span> (el.<span class="tok-f">getBoundingClientRect</span>().top + window.scrollY &lt;= line) {
      active = el;
      activeLink = a;
    }
  }
  <span class="tok-c">// …切换 class、更新进度条、滚动目录</span>
};</code></pre></div>
<p>不用 IO 的理由有两条：</p>
<ol><li><strong>语义不对</strong>。IO 回答的是&quot;元素有没有进入视口&quot;，我要的是&quot;哪一条标题是最后一条越过吸顶线的&quot;。一节长两千字，进入视口的那一刻和读完的那一刻差很远。</li><li><strong>会同时命中多个</strong>。可见区里经常并排两三个 h2，IO 的回调只告诉你&quot;这两个都在&quot;，排序还得自己做。既然要遍历，不如一开始就遍历。</li></ol>
<p>代价是每个 <code>scroll</code> 事件都要算一次 <code>getBoundingClientRect()</code>。十几个标题的规模下可以忽略，用 <code>requestAnimationFrame</code> 合并一帧内的多次事件就够：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">let</span> raf = <span class="tok-n">0</span>;
<span class="tok-k">const</span> onEvt = () =&gt; { <span class="tok-k">if</span> (!raf) raf = <span class="tok-f">requestAnimationFrame</span>(() =&gt; { raf = <span class="tok-n">0</span>; <span class="tok-f">onScroll</span>(); }); };
<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;scroll&#39;</span>, onEvt, { passive: <span class="tok-k">true</span> });</code></pre></div>
<h2 id="五-进度条-端点停在当前项的中点"><a class="h-anchor" href="#五-进度条-端点停在当前项的中点">#</a>五、进度条：端点停在当前项的中点</h2>
<p>左侧那条跟着走的色条不是独立算的，它借用了同一次计算的结果：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> li = activeLink.<span class="tok-f">closest</span>(<span class="tok-s">&#39;li&#39;</span>);
<span class="tok-k">const</span> oR = ol.<span class="tok-f">getBoundingClientRect</span>();
<span class="tok-k">const</span> lR = li.<span class="tok-f">getBoundingClientRect</span>();
<span class="tok-c">// 高度占比 = 当前项中点相对目录顶部的距离</span>
<span class="tok-k">const</span> p = ((lR.top + lR.height / <span class="tok-n">2</span> - oR.top) / oR.height) * <span class="tok-n">100</span>;
ol.style.<span class="tok-f">setProperty</span>(<span class="tok-s">&#39;--toc-p&#39;</span>, Math.<span class="tok-f">max</span>(<span class="tok-n">0</span>, Math.<span class="tok-f">min</span>(<span class="tok-n">100</span>, p)) + <span class="tok-s">&#39;%&#39;</span>);</code></pre></div>
<p>CSS 侧只是一条 <code>::before</code>，高度吃这个变量，<code>transition: height .18s</code> 让它是滑过去而不是跳过去：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">.post-toc ol { position: relative; border-left: <span class="tok-n">1px</span> solid <span class="tok-f">var</span>(--line); }
.post-toc ol::before {
  content: <span class="tok-s">&#39;&#39;</span>; position: absolute; left: -<span class="tok-n">1px</span>; top: <span class="tok-n">0</span>; width: <span class="tok-n">2px</span>;
  height: <span class="tok-f">var</span>(--toc-p, <span class="tok-n">0</span>%);
  background: color-<span class="tok-f">mix</span>(in srgb, <span class="tok-f">var</span>(--accent) <span class="tok-n">55</span>%, transparent);
  transition: height .<span class="tok-n">18s</span> ease-out;
}</code></pre></div>
<p>在站内一篇 8 个小节的文章上量的五个点：</p>
<div class="table-wrap"><table><thead><tr><th>滚动位置</th><th>scrollY</th><th><code>--toc-p</code></th><th>高亮项</th></tr></thead><tbody><tr><td>顶部</td><td>0</td><td>7.4%</td><td>01</td></tr><tr><td>35%</td><td>4272</td><td>37.0%</td><td>03</td></tr><tr><td>60%</td><td>7324</td><td>51.7%</td><td>04</td></tr><tr><td>95%</td><td>11597</td><td>87.0%</td><td>07</td></tr><tr><td>底部</td><td>12207</td><td>95.7%</td><td>08</td></tr></tbody></table></div>
<p>读到底时进度条停在 95.7% 而不是 100%，因为端点算的是最后一项的<strong>中点</strong>，不是目录底部。这是刻意的：条拉满意味着&quot;下面还有&quot;，停在最后一项的中点意味着&quot;到头了&quot;。</p>
<h2 id="六-到底兜底-最后一个标题永远越不过那条线"><a class="h-anchor" href="#六-到底兜底-最后一个标题永远越不过那条线">#</a>六、到底兜底：最后一个标题永远越不过那条线</h2>
<p>这一条不做，前五条的效果全废。</p>
<p>判据是&quot;标题顶端越过 <code>scrollY + 96</code>&quot;。但最后一节往往只占屏幕下半部分，它的顶端在页面里的位置可能离页底只有 700px——滚到最底，<code>scrollY + 96</code> 仍然追不上它。表现就是：读完全文，目录还停在第 7 项。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> atBottom = Math.<span class="tok-f">ceil</span>(window.scrollY + innerHeight)
                 &gt;= document.documentElement.scrollHeight - <span class="tok-n">2</span>;</code></pre></div>
<p>到底了就直接认最后一项，跳过整段遍历。实测滚到 100% 时高亮是 08，进度 95.7%，两项都对得上。</p>
<p>另一个思路是给正文加 <code>padding-bottom: 100vh</code>，让最后一个标题能真正越过判据线。没采用：每篇文章末尾都会多出一大块空白，短文尤其明显，而且要按文章长度调。一行 <code>if</code> 能解决的事，不值得换一段留白。</p>
<h2 id="七-目录自己也会滚"><a class="h-anchor" href="#七-目录自己也会滚">#</a>七、目录自己也会滚</h2>
<p>标题一多，目录比视口还高。这时 sticky 之外还要加一层：目录内部滚动。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">.post-toc .toc-inner {
  position: sticky; top: <span class="tok-n">86px</span>;
  max-height: <span class="tok-f">calc</span>(<span class="tok-n">100vh</span> - <span class="tok-n">118px</span>);   <span class="tok-c">/* 86 顶部 + 32 底部余量 */</span>
  overflow: auto;
  scrollbar-width: thin;
}</code></pre></div>
<p>往里滚的时候不能让高亮项跑出可视区，所以每次切换都把它拉回来。注意这段只动<strong>目录自己的 <code>scrollTop</code></strong>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> keepVisible = (a) =&gt; {
  <span class="tok-k">const</span> box = <span class="tok-f">scrollerOf</span>(a);                 <span class="tok-c">// 最近的 overflow: auto 祖先</span>
  <span class="tok-k">if</span> (!box) <span class="tok-k">return</span>;
  <span class="tok-k">const</span> br = box.<span class="tok-f">getBoundingClientRect</span>();
  <span class="tok-k">const</span> ar = a.<span class="tok-f">getBoundingClientRect</span>();
  <span class="tok-k">const</span> pad = br.height * <span class="tok-n">0.28</span>;              <span class="tok-c">// 上下各留 28% 缓冲</span>
  <span class="tok-k">if</span> (ar.top &lt; br.top + pad) box.<span class="tok-f">scrollTo</span>({ top: box.scrollTop - (br.top + pad - ar.top), behavior: <span class="tok-s">&#39;smooth&#39;</span> });
  <span class="tok-k">else</span> <span class="tok-k">if</span> (ar.bottom &gt; br.bottom - pad) box.<span class="tok-f">scrollTo</span>({ top: box.scrollTop + (ar.bottom - (br.bottom - pad)), behavior: <span class="tok-s">&#39;smooth&#39;</span> });
};</code></pre></div>
<p>第一版写的是 <code>a.scrollIntoView({ block: &#39;center&#39; })</code>。它会把<strong>页面</strong>也一起滚一下（<code>scrollIntoView</code> 不区分容器），于是滚动事件再触发一次高亮计算，页面开始自己抖。改成只操作容器 <code>scrollTop</code> 就干净了。</p>
<p>留 28% 缓冲而不是 <code>center</code>，是为了让下一项也露出来——读者能看到&quot;后面还有&quot;，而不是每次只剩当前这一行。</p>
<h2 id="八-点击落点要对齐吸顶区"><a class="h-anchor" href="#八-点击落点要对齐吸顶区">#</a>八、点击落点要对齐吸顶区</h2>
<p>能滚、能高亮之后，还剩一个体感问题：点目录跳过去，标题要么被吸顶条盖住一截，要么离得太远。</p>
<p>这里有三个数字必须成对出现：</p>
<div class="table-wrap"><table><thead><tr><th>参数</th><th>值</th><th>作用</th></tr></thead><tbody><tr><td>顶栏高度</td><td>72px + 阅读进度条 2px</td><td>吸顶区实际占 74px</td></tr><tr><td><code>.toc-inner</code> 的 <code>top</code></td><td>86px</td><td>目录停在吸顶区下方 12px</td></tr><tr><td>标题的 <code>scroll-margin-top</code></td><td>88px</td><td>锚点跳转后标题离视口顶 88px</td></tr></tbody></table></div>
<p>实测点第 5 项，跳转后标题的 <code>getBoundingClientRect().top</code> 正好是 <strong>88</strong>，和 <code>scroll-margin-top</code> 一致：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css"><span class="tok-c">/* 锚点跳转时浏览器会把这 88px 让出来，标题不会藏进吸顶条 */</span>
.md h2, .md h3, .md h4 { scroll-margin-top: <span class="tok-n">88px</span>; }</code></pre></div>
<p>只调其中一个就会露馅：<code>top</code> 调到 120 而 <code>scroll-margin-top</code> 还是 88，点完标题会钻进目录上方那条缝里；反过来则会在标题上方留一大片空。</p>
<h2 id="九-手机上不-sticky-换成抽屉"><a class="h-anchor" href="#九-手机上不-sticky-换成抽屉">#</a>九、手机上不 sticky，换成抽屉</h2>
<p>窄屏没有左侧那 220px，硬塞目录会把正文压到 300px 以下。所以 1080 以下直接 <code>display: none</code>，另起一套：右下角一个悬浮按钮，点开是底部抽屉。</p>
<p>实现上没重算任何东西，直接把桌面那份链接复制过去：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> src = document.<span class="tok-f">querySelectorAll</span>(<span class="tok-s">&#39;.post-toc a[data-toc]&#39;</span>);
<span class="tok-k">const</span> items = [...src].<span class="tok-f">map</span>((a) =&gt;
  <span class="tok-c">// href 照抄桌面那条：SSR 里是 #中文id，自己再 encodeURI 一遍会变成两种地址</span>
  <span class="tok-s">`&lt;a href=&quot;${a.getAttribute(&#39;href&#39;)}&quot; data-toc=&quot;${a.dataset.toc}&quot;&gt;${a.innerHTML}&lt;/a&gt;`</span>
).<span class="tok-f">join</span>(<span class="tok-s">&#39;&#39;</span>);</code></pre></div>
<p>几个细节：</p>
<ul><li>按钮在滚过文章头部之后才浮出来（<code>opacity 0 → 1</code>），第一屏不挡内容。</li><li>打开时给 <code>html</code> 加 <code>overflow: hidden</code>，否则背景还能滚，抽屉跟着页面飘。</li><li>点条目时<strong>先关抽屉再让浏览器跳转</strong>。顺序反了的话，<code>overflow: hidden</code> 还在，锚点跳转会被吞掉。</li><li>Esc、点遮罩、点关闭都能收。</li></ul>
<p>390×844 实测：初始按钮 <code>opacity 0</code>、<code>pointer-events: none</code>；滚动后 <code>opacity 1</code>，标签显示「目录 8」；点开抽屉 8 项齐全，<code>html</code> 的 <code>overflow</code> 变 <code>hidden</code>，当前项已高亮。</p>
<h2 id="十-边界-明说"><a class="h-anchor" href="#十-边界-明说">#</a>十、边界，明说</h2>
<ol><li><strong>目录只收 h2</strong>。h3 收进来会到 20 项以上，扫起来比手动找还慢。长文里 h3 是段落内的小标题，不该进导航。</li><li><strong>锚点 id 是中文</strong>（<code>#封-ip-一键连坐-而不是单点删除</code>），分享出去的链接百分号编码后很长。改成短 id 会让已有外链全部失效，不动。</li><li><strong>无 JS 时</strong>目录仍然能点（链接是 SSR 出来的），但没有高亮、没有进度条、也没有手机抽屉。</li><li><strong>打印时</strong>整块目录 <code>display: none</code>，正文全宽——纸上不需要导航。</li><li><strong>目录超过一屏</strong>靠内部滚动；如果哪天某篇有 40 个小节，得做分组折叠，现在没做。</li></ol>
<h2 id="一条清单"><a class="h-anchor" href="#一条清单">#</a>一条清单</h2>
<p>下次再给页面加侧边目录，按这个顺序检查：</p>
<ol><li>先量 sticky 元素的<strong>父容器</strong>高度，不是它自己的。<code>可固定距离 = 父高 − 自身高</code>，这个差值是 0 就一定是坏的。</li><li>grid / flex 里看 <code>align-items</code> 和 <code>align-self</code>。默认 <code>stretch</code>，被改成 <code>start</code> 就等于砍掉了 sticky 的余量。</li><li>点击落点用 <code>scroll-margin-top</code>，和吸顶的 <code>top</code> 一起调，两个数字必须对得上。</li><li>滚到底要单独兜底。最后一个标题通常越不过判据线，这是结构问题，不是阈值没调好。</li><li>内部滚动只动容器，别用 <code>scrollIntoView</code>——它会把整个页面也拖一下。</li></ol>
<p>这一篇里真正难的不是 sticky，是<strong>&quot;看着像样式问题&quot;的直觉</strong>。目录不动、高亮在动，第一反应都是去查 sticky 的语法或者 z-index。查语法永远查不出来，因为语法没错；错的是它脚下那块地只有 336px 高。</p>
<p>后来把这段的<strong>成因</strong>也搬进了 CI——<code>test-sticky-css.mjs</code> 守 CSS 那三行（<code>align-items: stretch</code> 出现 <code>start</code> 即红），真机脚本守现象。那份对账写在另一篇里（排期 2027-02）：CI 里没有长文章，所以只能守成因。</p>
<p><a class="tag-inline" href="/tag/css">#css</a> <a class="tag-inline" href="/tag/layout">#layout</a> <a class="tag-inline" href="/tag/browsers">#browsers</a></p>', cover_body = '', updated_at = datetime('now')
  WHERE slug = 'sticky-toc-grid-align-items';
