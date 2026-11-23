## 结论

一份审计清单对本站列了 8 项「需复核」。逐条查完分三类：**3 项判断错误、3 项半对、2 项早已存在**（另外 7 项关于 Rin、4 项关于双方共同缺口，这轮不碰）。

真正需要动手的只有两处，都在「半对」那一栏里：编辑器预览的渲染入口没有断言守着，评论的第三条渲染路径没人测。都补上了。

| 清单判断 | 查证 |
|---|---|
| 缺 CSP，纵深断在最内层 | **错**。13 条指令 + 每请求 nonce，enforcing 状态，8 条路径实测 |
| `/img/` 代理有 SSRF 面 | **不适用**。这个代理只读 R2，一次外部请求都不发 |
| OAuth Device Flow 的会话绑定 | **本站没有 Device Flow**。只有 web flow + 自签 2 段 token |
| 渲染器顺序守护缺失 | **半对**。发布路径有（`[P-019]`），预览路径没有 |
| 评论字段的协议校验 | **半对**。落库不校验（故意），出口有三条路径都过滤了，但只有两条被断言守着 |
| D1 限额是否原子递增 | **半对**。累加是原子的，**判定不是** |
| 蜜罐命中返回 403 等于招供 | **半对**。返回的是 400，也不是假成功 |
| 请求体大小限制 | 早已有，64KB / 1MB / 8MB 三档 |
| Turnstile 核对 hostname / action | 早已有，严格相等、缺字段即拒 |

清单最典型的那个误判是这样写的：「没有 Content-Security-Policy 意味着渲染器一旦漏一条，没有任何兜底。这是你整个安全体系里唯一的结构性缺口。」

这条头文件我从部署第一天就有。下面第一节给出实测数据。

## 一、三处判断错误

### 1. 「缺 CSP」

线上八条路径，逐个取响应头：

| 路径 | 状态 | CSP | nosniff | COOP |
|---|---|---|---|---|
| `/` | 200 | 有 | 有 | 有 |
| `/archive` | 200 | 有 | 有 | 有 |
| `/login` | 200 | 有 | 有 | 有 |
| `/no-such-page` | 404 | 有 | 有 | 有 |
| `/api/site` | 200 | 无 | 有 | 有 |
| `/rss.xml` | 200 | 无 | 有 | 有 |
| `/sitemap.xml` | 200 | 无 | 有 | 有 |
| `/thumbs/auto-4.webp` | 200 | 无 | 有 | 无 |

JSON 与 XML 不带 CSP 是有意的：它们不经过 HTML 解析器，`script-src` 对它们没有意义。`nosniff` 全站覆盖——这条比 CSP 更基础，因为它决定了浏览器敢不敢把那串字节当 HTML 渲染。

`src/security.js` 里 `securityHeaders()` 六条：

```js
h.set('x-content-type-options', 'nosniff');
h.set('referrer-policy', 'strict-origin-when-cross-origin');
h.set('x-frame-options', 'DENY');
h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
h.set('cross-origin-opener-policy', 'same-origin');
h.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
```

而且不是 Report-Only。清单里那条「先发 `Content-Security-Policy-Report-Only` 收几天报告再切 enforcing」——我第一天就是 enforcing，因为 CSP 是跟着渲染管线一起长出来的，不是事后贴上去的。中途加过 KaTeX/Mermaid 之后才补的 `script-src` 放宽，那是唯一一次出现过「加功能导致 CSP 漏」。`check:live` 有两条断言守着 nonce 每次不同、`script-src` 不含 `unsafe-*`。

### 2. 「`/img/` 代理的 SSRF」

清单问三件事：会不会跟随重定向到内网；是否校验 Content-Type；超大畸形图片会不会成解压炸弹。

`serveImage()` 的全文里没有一次 `fetch()`：

```js
const obj = await env.BUCKET.get(path);   // 直接读 R2 对象
if (obj) return imageResponse(obj);
```

它是个 R2 对象的直出层，不是反向代理。没有外部请求，就没有 SSRF 面——重定向跟不跟随这个问题在这里不成立。

key 侧有三道：

```js
if (!path || path.length > MAX_KEY || BAD_KEY.test(path) || path.includes('..') || isPrivateImageKey(path))
  return new Response('bad image path', { status: 400 });
```

`BAD_KEY` 挡开头斜杠、双斜杠、反斜杠、NUL、控制字符；`isPrivateImageKey` 专门挡 `backups/` 这种「和图片同桶的私密对象」，否则 `/img/backups/d1.sql` 就是公开下载。

Content-Type 侧是白名单 + 认不出就降级：

```js
let rejected = '';
if (!SAFE_IMG_MIME.has(ct)) {
  rejected = ct || 'unknown';
  ct = 'application/octet-stream';
}
```

降级时同时补 `content-disposition: attachment` 与 `nosniff`。注释里写清了理由：认不出的类型不能让浏览器自己嗅探，「这串字节是什么」的判断权不该交给最不可信的一环。

解压炸弹这一条不适用：这条链路**不做任何转码**。webp/avif 变体是上传时（`toWebp`）转好写进 R2 的，读的时候只挑文件。

### 3. 「OAuth Device Flow 的会话绑定」

清单说「你写了 OAuth 与 JWT 两篇，审计要点：`device_code` 是否足够长且单次消费、轮询端点是否限流、JWT 是否校验 `iss`/`aud`/`exp`、签名算法是否锁定」。

这是把**文章讲的主题**当成了**本站实现的功能**。整个 `src/` 与 `public/` 里没有一处 `device_code`——唯一出现在 `src/numbers.js` 的一行数字里，那是文章引用的通用知识。

本站只有 GitHub OAuth web flow（`/auth/login` → `/auth/callback`），拿到 `access_token` 后调一次 `/user`，然后**自签**一枚 token：

```js
export async function signToken(secret, payload, ttlSec = 60 * 60 * 24 * 30) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64u(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(p));
  return `${p}.${b64u(sig)}`;
}
```

两段，不是三段。**没有 header 段，所以没有 `alg` 字段，`alg:none` 这个攻击面在这里不存在**——不是「锁了算法」，是压根没有算法协商这一步。`verifyToken` 的第一件事是 `if (parts.length !== 2) return null`，多出来的段直接拒。

`iss`/`aud` 没有：这不是给第三方验的 token，只有一个消费方，加 `aud` 只是自己跟自己握手。`exp` 有，而且判定写成了「没有 exp 就算无效」：

```js
/* 原来写的是 `if (data.exp && ...)`：token 里不带 exp 时等式直接短路，
   签名正确就永久有效 —— 一个本该 30 天过期的会话票，改成永久票只要去掉一个字段。 */
```

这是清单里唯一一条我认同「该警惕」的，只是警惕的对象错了：不是 `alg:none`，是**过期判断的短路**。那处已经修过并留了注释。

## 二、四处「半对」

### 1. 渲染器顺序守护：发布路径有，预览路径没有

`[P-019]` 早就做了：把 `md.js` 复制到临时目录做单点变异（`esc` 换恒等、`safeUrl` 拆白名单），再跑同一批 27 条探针，要求变异体必须变红。加一条 `s = esc(s);` 必须早于 `IMG_RE`/`LINK_RE` 替换的位置哨兵。

但清单那句「探针测的是输出正确，不是顺序正确」提醒了一件事：**探针只跑了 `renderBody`**。而编辑器预览跑的是 `renderMarkdown`：

```js
// public/editor.html
previewEl.innerHTML = renderMarkdown(md);

// src/index.js（发布路径）
sanitizeHtml(renderBody(p.content))

// public/md.js
export function renderBody(content = '') {
  return linkTags(renderMarkdown(content));
}
```

两条路的差别应该只有 `linkTags` 与 `sanitizeHtml` 两件事，**不该差渲染器本身**。现在确实没差——但没人守。若有人给预览加个专用分支（很常见：「预览里加个行号」之类），那段代码就落在 27 条探针的覆盖之外，而它会把用户输入塞进 `innerHTML`。

补了三条：

```js
const previewHit = countUnsafe(renderMarkdown);          // 预览入口单独跑 27 条探针
assert.deepEqual(previewHit, []);

const m1PreviewHit = countUnsafe(m1.renderMarkdown);     // 变异体上也要红
assert.ok(m1PreviewHit.length >= 5);

assert.ok(/previewEl\.innerHTML\s*=\s*renderMarkdown\(/.test(editorSrc));
assert.ok(!/\b(marked|showdown|markdownit|MarkdownIt|remark)\s*[(.]/i.test(editorSrc));
```

第一组测「预览入口本身干净」，第二组测「探针在预览入口也生效」（`esc` 坏掉时预览红 7 条，与发布路径同数），第三组测「没有第二个渲染器」。两次注入都验过：把 `renderMarkdown` 换成 `marked` → 红；在 `editor.html` 里悄悄加一句 `marked('')` → 红。

**为什么不是给预览加 sanitize。** 三条理由：`renderMarkdown` 本身转义是完整的（27 条探针全过）；`clean.js` 是服务端模块，拉进浏览器要多一份字节；更麻烦的是预览的白名单一旦与 `clean.js` 不同步，预览和成品的样式会不一致——那是最难查的一类 bug。预览层真出问题，受害的是刚粘贴了恶意 md 的作者自己（cookie 是 HttpOnly，偷不走）。风险等级够不上加重资产。

### 2. 评论注入面：三条路径安全，第四条没人守

清单问「评论落库前是否做了协议校验」和「预览与正式渲染是否共用同一条管线」。

第一个问题：**落库不校验，故意的。** `INSERT INTO comments` 那里 `website` 只做 `slice(0, 200)`。理由写在 `safeWebsite()` 的注释里：

```
esc() 能防属性逃逸，但挡不住 href="javascript:..." 这类伪协议——
现代 CSP 会拦执行，但协议本身不该进 DOM。宽松点：无协议的裸域名（example.com）
和协议相对（//example.com）按 https 补齐，其余 scheme 一律判无效。
存储层可能已有历史脏值，所以过滤放在渲染出口（SSR 与客户端共用）。
```

出口过滤比入口校验更强的一点：它能覆盖**已经躺在库里的**脏数据。入口校验只能保护未来的。

第二个问题的答案藏在「有几条出口」里。评论的 `website` 在四处分流：

| # | 位置 | 处理 | 被测了吗 |
|---|---|---|---|
| 1 | SSR `renderComment` | `safeWebsite()` + `esc()` | 有 |
| 2 | 后台待审 `renderCommentsAdmin` | 只输 `esc(name/content/post_title)`，**不显示 website** | 没有 |
| 3 | 客户端 `renderCmt` | `safeWebsite()` + `esc()` | 没有 |
| 4 | API JSON | 原值返回，仅上面三处消费 | 不适用 |

第 3 条是这次才看清楚的：评论提交成功后 `loadComments()` 会用 `comments.map(renderCmt).join('')` 重绘整个列表，那是**客户端第二套实现**，与服务端的 `renderComment` 靠注释「保持同一份结构」来同步。它确实调了 `safeWebsite`、确实用了 `esc`——但这是我看过才确认的，不是被测试确认的。

补了三条断言：`post.html` 必须从 `/avatar.js` 导入 `safeWebsite`（不许自带副本）、`renderCmt` 的 `href` 必须是 `esc(site)`、后台待审页不许出现 `c.website`（要显示就得走 `safeWebsite`，现在是干脆不显示）。两次注入都红：把 `safeWebsite(c.website)` 换成 `c.website` → 红；在 `post.html` 里复制一份 `safeWebsite` → 红。

### 3. D1 限额：累加原子，判定不原子

清单这条问得最准：「限流用 D1 单条 upsert 完成原子递增，别用 KV 的 get/put——KV 无原子性，并发请求会互相覆盖计数。」

**累加那一半我早就做对了：**

```sql
INSERT INTO comment_guard (k, day, hits, last_ts) VALUES (?, ?, 1, ?)
ON CONFLICT(k) DO UPDATE SET
  hits = CASE WHEN comment_guard.day = ? THEN comment_guard.hits + 1 ELSE 1 END,
  day = ?, last_ts = ?
```

**判定那一半不是。** 完整顺序是：

```
guard()  →  SELECT k, day, hits, last_ts, banned FROM comment_guard   ← 只读
judge()  →  纯函数判定
（业务）  →  INSERT INTO comments
record() →  上面那条 upsert 累加
```

`SELECT` 和 `+1` 之间有窗口。N 个并发请求可以同时读到 `hits=9`（上限 10），全部通过判定，然后各自累加。日上限 10 理论上能被打成 10N。

清单说「确认一下用的是原子 upsert」——确认完了，**只有累加是原子的**。这两件事经常被当成一件。

**为什么不修。** 改成「先单语句原子占位、再写评论」会让被 400 拒掉的请求也计额度——正文里注释写着「落库成功才计额度：被 400 拒掉的请求不占次数」，那是为了不误伤「邮箱填错被拒」的真人。两种语义都要原子，就得加事务或补偿删除。而换来的窗口需要「Turnstile 未配置 + 并发 10 以上」才成立，博客评论场景打不出来。

真正的收紧位置在边缘（WAF 速率限制每秒计数），不在应用层加锁——这条清单自己也说了：应用层限流保护数据正确性，保护不了额度。

所以这轮**不改代码，改断言**：`[P-022]` 断言 `guard()` 体内不许出现 `INSERT`/`UPDATE`、`record()` 必须还是 `hits + 1`。这条守的是「现状就是 check-then-act」这个事实——不是「这样是对的」。哪天有人改成原子占位，它会红，那时同步改条目措辞。

顺带一句 IP 头：`src/antispam.js` 与 `src/api.js` 只读 `cf-connecting-ip`，**没有 `x-forwarded-for` 兜底**。Workers 没有固定源站地址，不存在「绕过边缘直连」的路径，这个头由边缘写入并覆盖客户端传来的同名头。唯一一处 fallback 在 `src/stats.js`（`cf-connecting-ip` 取不到时读 `x-forwarded-for`），那是 PV 统计，伪造的后果是把访问量记到别人头上。

### 4. 蜜罐返回码：不是 403，也不是假成功

清单说「蜜罐命中返回 403 等于招供，应返回假成功」。

实际是：

```js
if (String(body.hp || '').trim()) return err('验证没通过，刷新页面再试一次', 400);
```

400，文案是一句放之四海皆准的话。不是 403（没有「你被拦了」），也不是精确的「蜜罐触发」。

**但没有改成假成功**，这是第三轮被提这件事了，理由还是同一条：假成功会骗到真人。蜜罐在 CSS 里隐藏（`tabindex="-1"` + `aria-hidden`），但屏幕阅读器、自动填充、某些浏览器扩展会往里写值——那类用户收到「评论已发布」然后刷新发现没有，比收到一句模糊的「验证没通过」糟得多。返回 200 + 假成功只对「能读响应体、会调整策略」的机器人有效，而这类机器人本来就会读源码找蜜罐字段在哪里。

## 三、本轮改动

| 文件 | 改动 | 验证 |
|---|---|---|
| `scripts/test-md-guard.mjs` | 预览入口 `renderMarkdown` 单独跑 27 条探针；变异体上也要红；源码守「没有第二个渲染器」 | 两次注入均红；原版预览 0 违反、`esc` 变异后预览红 7 条 |
| `scripts/test-comment-ssr.mjs` | 三条：客户端导入而非复制 `safeWebsite`、`renderCmt` 的 href/正文、后台待审页不显示 website | 两次注入均红；24 条全过 |
| `scripts/test-antispam.mjs` | `[P-022]` 锁「判定非原子」这个事实 | 加一条，14/14 |
| `PITFALLS.md` | 新增 P-022 | 对账 22 条全绿 |

没有改业务代码。这轮所有改动都是断言——因为查完之后发现，清单里「需复核」的六项，代码本身没有一处需要改。

## 四、复现条件

- 环境：本地；`npm test`（不需要 D1、不需要起 Worker）
- 触发：`node scripts/test-md-guard.mjs`；把 `public/editor.html` 里的 `renderMarkdown(` 改成 `marked(`
- 期望：`[P-019] ... 编辑器预览不再走 renderMarkdown`；实际：同上

## 五、断言

```bash
node scripts/test-md-guard.mjs     # [P-019] 预览入口 + 变异
node scripts/test-comment-ssr.mjs  # 24 条（含三条新增）
node scripts/test-antispam.mjs     # 14 条（含 [P-022]）
```

## 六、明说的没做

1. **没修限流的判定原子性。** 理由见 2.3。这是本文唯一一处「看清了但选择不改」的地方，也是唯一一处我承认清单指对了的地方。
2. **没给编辑器预览加 sanitize。** 理由见 2.1。
3. **没做渗透测试。** 这轮全部是代码阅读 + 单测，没有一次真实的并发压测。P-022 里那个「10N」是推理出来的数字，不是测出来的——要测需要构造 20 个并发请求并让 Turnstile 处于关闭状态，那属于改配置的实测，不在这一轮范围。
4. **Rin 侧一项都没复核。** 清单里关于 Rin 的七条（首个用户管理员、明文密钥、客户端 Markdown 白名单、权限两级、缓存竞态、鉴权迁移残留、编辑器上传），全部按材料口径引用。其中「v0.2.0 从 Elysia 换 Hono」这句——Rin 用的是 Hono，不是 Elysia，方向反了。这类细节只有翻锁定 commit 才能定，我没有。
5. **响应头表只测了八条路径。** 没有测 `/api/` 全部端点、没有测带 query 的页面、没有测 `OPTIONS`。要全覆盖应该写成 `check:live` 里的循环断言，而不是人工 curl 一遍。
