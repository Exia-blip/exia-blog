# 六条断言查了五条：材料把我们自己的 CI 当成了文章

## 结论

材料开头那句判断是准的——「每篇都在立标准，但没有任何一条标准被机器守住」。它错在**病历太旧**：它列的六条断言里，五条早就在 `npm test` 里跑着；它列的三个功能缺口，两个已经上线（评论 Webhook、两级回复），第三个（多文隔离）是上一轮刚做完的。

真正剩下的只有两条，而且都不在它的清单里：

1. **请求体闸门只挡得住诚实的那一半**。顶层看 `content-length`，15 个写入口里 14 个还在裸解析——其中 12 个是 `await request.json()`，两个是 `await request.formData()`。报个 `3` 推 1MB，闸门连看都不看一眼。
2. **蜜罐没有断言**，而且材料把它的返回值写反了：本站是 400，不是 200。

另外把 sticky 的**成因**从「只存在于真机脚本」搬进了 CI——那一条材料说对了方向，但理由不是它写的那个。

## 一、六条断言，逐条查

| 材料要的断言 | 本站现状 | 在哪 |
|---|---|---|
| 渲染器顺序守护：把转义挪后一行，测试必须变红 | **已有**，而且比要求更狠 | `test-md-guard.mjs`：M1 把 `esc` 换成恒等函数、M2 拆掉协议白名单，两个变异体都必须被抓到（分别红 5 条 / 3 条）；另有一条**顺序哨兵**直接比较源码位置 `indexOf('s = esc(s)') < indexOf('s.replace(IMG_RE')` |
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
if (method !== 'GET' && method !== 'HEAD' && bodyTooLarge(request, bodyCapFor(path))) {
  return json({ ok: false, error: '请求体太大' }, 413, { 'cache-control': 'no-store' });
}
```

`bodyTooLarge()` 只读 `content-length`。这个头是**对方声明的**，不是事实。报 `3`、推 1MB；或者分块上传干脆不给这个头——顶层全放行，请求一路走到分支里的 `const body = await request.json()`，整个包读进 128MB 的 isolate 再解析。

当时只有一个接口做了按流计数（[发评论](/p/comment-anti-spam) 那条路，全站唯一匿名可灌数据的入口）。其余 12 个因为「要登录」被默认放过：文章增改、AI 摘要、审核、评论处置、批量删、封 IP、友链增改、站点设置、直传签名。登录只挡得住伪造身份，挡不住一个被盗的 cookie 拿你的额度烧 CPU。

还有两个入口是同一个坑的另一种长相：`request.formData()`。头像上传与图片直传都写着 `await request.formData()`——它内部同样把整个 body 读进内存，只是因为「像浏览器帮我解析好了」而不容易被当成出口。

修法不是把顶层写得更严（它拿不到事实），而是让所有分支只剩一条读体路径：

```js
async function readBody(request, path, { lenient = false } = {}) {
  const rd = await readJsonLimited(request, bodyCapFor(path));
  if (rd.tooBig) return { res: json({ ok: false, error: '请求体太大' }, 413, { 'cache-control': 'no-store' }) };
  if (!rd.body) {
    if (lenient) return { body: {} };
    return { res: err('请求格式不正确') };
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
if (String(body.hp || '').trim()) return err('验证没通过，刷新页面再试一次', 400);
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
