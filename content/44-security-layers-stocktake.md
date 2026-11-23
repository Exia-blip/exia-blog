## 结论

一份安全对比材料给了四条判断。我照着代码和线上库逐条查了一遍，结果是**两条对、一条半对、一条完全反了**。

| 材料的判断 | 查证结果 |
|---|---|
| 渲染层我不靠库、靠顺序，失败会明显坏 | 对。而且比材料说的还多一道自研白名单 |
| 我没有 JWT、没有权限表，所以没有提权类漏洞 | **错**。`users` 表、`is_admin`、30 天 JWT 全在，线上有 2 行数据 |
| 防滥用我有三层，Rin 只有登录门槛 | 对，但三层全在计费之后，所以挡不住额度 |
| 边缘层两边都空着 | 对。而且这层根本不在仓库里，wrangler 管不到 |
| CSP 两边都没强调 | **错**。线上 13 条指令 + 每次不同的 nonce，`check:live` 里有两条断言守着 |

最难看的是第二节那条：材料批评 Rin「第一个登录的用户自动获得管理员权限」，而我的 `src/auth.js` 里写着同一行代码。

这一轮实际改了四处：

1. 请求体闸门（64KB / 1MB / 8MB 三档，按路由）
2. Turnstile 复核 `hostname` 与 `action`
3. `DEPLOY.md` 补边缘层清单（WAF 速率限制）
4. `DEPLOY.md` 补被入侵后的存量清理预案

新增 `scripts/test-body-limit.mjs`，13 条断言，已进 `npm test` 链。

## 一、渲染层：两种失败方式，不是两种安全等级

材料把我的路线描述成「抠码 → 转义 → 拼装」，把 Rin 描述成「解锁器 + sanitizer 白名单」。前半句只说了一半。

实际是三段：

| 段 | 文件 | 作用 |
|---|---|---|
| 生成 | `public/md.js` | Markdown → HTML，代码块占位符先抽走再回填 |
| 消毒 | `src/clean.js` | 自研白名单：`TAG_OK` 51 个标签、`ATTR_BY_TAG` 逐标签放行属性、`on*` 一律丢、`BAD_BLOCK` 先整块删 `script/iframe/svg/math` |
| 快照 | `scripts/test-md-snapshot.mjs` | 27 条 XSS 探针渲染结果钉死成 JSON，一条不一致就红 |

所以不是「不引 sanitize 库所以只靠顺序」，是「不引库，自己写了一个白名单，再叠一层顺序保证」。这两件事的失败方式不一样：

- 顺序错了（比如有人把转义挪到拼装之后），白名单还在，能兜住大部分形状；
- 白名单漏了（比如新加一个允许标签忘了收属性），顺序还在，探针可能抓到；
- 两个都错，才是洞。

Rin 那边只有一层：`rehype-sanitize` 的白名单。它在客户端（`client/` 的 `rehype-sanitize ^6`），服务端方向是 HTML→Markdown。这一层的性质是：**配漏了不报错**。测试照样绿，线上静默放行。材料那句「OWASP: sanitizing doesn't cover everything」指的是这个——不是白名单不好，是它一旦错，错得没有声音。

我的做法换来的正是这个：错误有声音。代价也真实：**27 条探针是唯一的保险**。所以 `test-md-snapshot.mjs` 里有一条断言是先于内容比对跑的：

```js
assert.equal(probes.length, 27, '探针集合应为 27 条');
```

谁删一条、改一条名字，先红在这里，不会出现「探针少了但全绿」的假象。这条比任何一条渲染断言都重要。

## 二、身份层：我有，而且和 Rin 同一个写法

材料原文：

> 你站上没有多用户、没有 JWT、没有权限表——首页那个「登录」只有一个登录格。这不是缺陷，是攻击面取舍：你没有「权限提升」这一类漏洞，因为压根没有权限。

查 `src/auth.js`：

```js
const token = await signToken(env.SESSION_SECRET, { uid: user.id, admin: user.is_admin }, 60 * 60 * 24 * 30);
headers.append('set-cookie', setCookie(COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }));
```

JWT，HS256，30 天，HttpOnly + SameSite=Lax + Secure。`users` 表有 `github_id / login / name / avatar / email / is_admin / created_at`。`requireAdmin()` 查库拿 `is_admin`，不是信 token 里的字段。

线上库实测（`wrangler d1 execute --remote`，只读）：

| id | login | is_admin | created_at |
|---|---|---|---|
| 1 | Exia-blip | 1 | 2026-10-30 16:50:54 |
| 2 | aizheni13 | 0 | 2026-11-15 13:39:47 |

两行。一行管理员，一行普通用户。所以「没有权限层」这句话是错的，连「只有一个登录格」这个观察都过期了——登录之后能发文章（待审）、能上传图片、能调 AI 摘要，这是一整套权限分级。

真正该记的是上游那一行：

```js
const isFirst = count.c === 0;
// ...
isFirst ? 1 : 0,
```

**第一个登录的用户自动成为管理员。** 和材料批评 Rin 的那条，一字不差。

我这边窗口已经关了：id=1 是 2026-10-30 我自己建的。机制没关——清库、换库、开新实例，窗口立刻重开，而且第一个到达的人拿走整站写权限。这不是理论风险，是部署顺序问题。

跟 Rin 比，我在这一层只有一处真的更好：**权限以 DB 为准**。签发时 token 里塞了 `admin`，但 `currentUser()` 每次都回库：

```js
const user = await env.DB.prepare('SELECT id, login, name, avatar, email, is_admin FROM users WHERE id = ?')
  .bind(payload.uid)
  .first();
```

`payload.admin` 在代码里没有任何读取点。所以撤权限是立即生效的，不用等 30 天 token 过期。Rin 的 `setup.ts` 把 `id/username/admin` 挂到请求上下文，那一份来源是 token 还是库，材料没写清，我不替它下结论。

差的地方也明确：**退出只清 cookie**，服务端没有吊销名单。cookie 被复制走，30 天内依然有效，唯一止血手段是换 `SESSION_SECRET`——那会一次性踢掉所有人，包括我自己。

还有一处材料没提、但比上面两条更值钱：普通用户的门槛是「有一个 GitHub 账号」。登录后 `/upload` 可以直接往 R2 写 4MB 以内的文件，`/posts/:id/summary` 可以调 Workers AI。这两处都没有频率限制。材料说 Rin「挡不住登录了然后狂发」，我这边是「挡不住登录了然后狂传」——同一个病。

## 三、防滥用：三层都在，但都站在计费之后

现有三层按成本排序，材料这段描述是准的：

| 层 | 触发条件 | 成本 | 失败取向 |
|---|---|---|---|
| 蜜罐字段 `hp` | 被填就 400 | 一次字符串判断 | closed |
| Turnstile | 只有配齐两把 key 才发一次跨网请求 | 一次 HTTPS 往返 | open（不可达时降级放行） |
| D1 限额 | IP 60 秒一条、每天 10 条；设备每天 10 条，UTC+8 换天 | 两条 D1 读 | closed |

这轮补了两处。

### 3.1 请求体闸门

材料点的是「请求体大小限制」。这里有个必须先说清的前提：**请求进到 Worker 那一刻就已经开始计费**，所以闸门省的不是额度，是 CPU 和内存——一个 100MB 的包被 `request.json()` 整个读进 128MB 的 isolate，是免费送给攻击者的 OOM。

两道：

- `bodyTooLarge()` 只看 `content-length`，一次 header 读，便宜，但客户端可以谎报，也能用 chunked 不给；
- `readJsonLimited()` 按流边读边数，超了立刻 `cancel()`，谎报绕不过去。

按路由分档，因为一刀切会把编辑器保存和图片上传一起挡死：

| 路由 | 上限 | 依据 |
|---|---|---|
| `/comments`、`/pv`、`/ev`、其余默认 | 64KB | 评论正文字符上限 2000，全放汉字也只有约 6KB |
| `/posts`、`/posts/:id` | 1MB | 正文 + 元数据，线上最长一篇 21664 字符（约 65KB 上限） |
| `/upload`、`/upload-url`、`/settings/avatar` | 8MB | 单图上限 4MB，留一倍余量 |

`/comments` 是全站唯一「匿名人可以往里灌数据」的入口，所以它走的是按流那道：`content-length` 谎报成 3 字节、实际传 50MB，`request.json()` 照样全读，`readJsonLimited()` 不会。

实测断流位置：喂一个 1MB 的流，它在 **73728 字节**、第 9 块就停了——读了 7.2%，剩下 92.8% 一个字节没读。

`scripts/test-body-limit.mjs` 13 条，其中 BL-04 守的就是这个：

```js
assert.ok(pulls() <= 12, `读了 ${pulls()} 块，说明没有及时断流`);
```

以后谁把 `readJsonLimited()` 换回 `request.json()`，这条会红。

### 3.2 Turnstile 的 hostname / action

材料这条是对的，我原来的实现只看了 `d.success`：

```js
if (d.success) return { ok: true };
```

`siteverify` 回 success 只证明「有一枚有效 token 被兑换了」。`sitekey` 是公开的，任何人可以在自己的页面上渲染同一个 sitekey、过验证、把 token 拿来打我的接口。不核对出处，这一层的真实语义是「任何人的真人都能替你投票」，不是「这个站的真人」。

两项都在 siteverify 的响应里，核对它们不用再发一次请求：

```js
if (expect.host && d.hostname !== expect.host) { /* 拒 */ }
if (expect.action && d.action !== expect.action) { /* 拒 */ }
```

严格相等，缺字段按不匹配。放宽成「有就比」的写法，攻击者只要挑一条不返回该字段的路径就能整体绕过。`host` 从 `siteOrigin(env, request)` 派生（和 canonical / og:image / RSS 同一个源），`action` 前端传 `'comment'`，两边写死同一个字符串 `TURNSTILE_ACTION`。

BL-10 / BL-11 / BL-12 三条分别守：别站签发的 token、同一 sitekey 的别的 widget、响应里缺字段。

### 3.3 一条原理

应用内的限流保护的是**数据正确性**，保护不了**额度**。D1 每次查询都算行读、每次 subrequest 都算调用，限额表写在 D1 里，攻击者打到限额之前已经烧掉了几十次行读。真正挡额度的在更外层，也就是下一节。

## 四、边缘层：两边都空着，而且这层不在代码里

Cloudflare 的防护从外到内：DDoS 托管规则 → WAF 自定义规则 / 速率限制 → Access → Worker → 应用内校验。我的三层全部在最里面。

这是它和应用内限流唯一、也是最大的区别：**WAF 拦下的请求根本不进 Worker**，不计 CPU、不计 D1 行读、不计 subrequest。

这一层 wrangler 管不了——`wrangler.jsonc` 里没有也不可能有 WAF 规则，API token 也没有 Zone 写权限。所以只能手工配，配置本身就不可能进版本库。这就是为什么「两边都空着」：它不是疏忽，是这条路的默认状态。

已写进 `DEPLOY.md` 第 6 节，含免费版的真实约束（1 条速率限制、计数窗口固定 10 秒、匹配字段有限，以面板当前版本为准）和建议规则：

| 项 | 值 |
|---|---|
| 匹配 | `http.request.uri.path in {"/api/comments" "/api/pv" "/api/ev"}` |
| 计数 | 同 IP / 10 秒 / > 20 次 |
| 动作 | 先 `Log` 观察 3–7 天，再切 `Block` |

先记录再拦截的顺序不能反。WAF 是 IP 维度的，而 CGNAT 后面可能坐着整个小区——直接拦，误伤的是「同一个小区的所有读者」。这个误伤在日志里看得见，在拦截模式下只能靠投诉发现。

## 五、材料让我补的两条，一条早就有了

材料第六节说「CSP 你俩都没强调」。这条对 Rin 可能成立，对我这里不成立。线上实测（`curl -sI` 打文章页）：

```
content-security-policy: default-src 'self'; script-src 'self' 'nonce-4d4faacdeb63990442fbb57859518948';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:;
  connect-src 'self'; media-src 'self' https:; frame-src 'self' https://www.youtube.com ...;
  object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';
  upgrade-insecure-requests
```

13 条指令，`script-src` 没有 `unsafe-inline`，每次请求 nonce 都不同。这是 12-17 那篇写的 CSP nonce 方案，`scripts/check-live.mjs` 里有两条断言（`有 CSP` / `CSP 带 nonce`），另有一条守「304 不带新 nonce」——304 没有 body，配一个新 nonce 会让缓存里的 HTML 和头对不上。

Cookie 那半条也早就有：`setCookie()` 默认 `HttpOnly; SameSite=Lax; Secure`，退出走 `clearCookie()` 同一个形状。

真缺的是第二条：**被入侵后的存量清理**。存储型 XSS 的前提是库里已经有脏数据，这时候改代码不会让存量变干净。`DEPLOY.md` 第 7 节写了五步：截断入口 → 找注入源（`posts.content` / `comments.content` / `audit_log` 三处扫）→ 备份再逐条改（不 DELETE，留证）→ 换 `SESSION_SECRET` 吊销所有 30 天会话 → 把这次漏进去的形状加进 27 条探针。最后一步是唯一能让「同一种形状换个写法回来」被提前发现的。

## 六、把一份 16 项清单逐条对账

同一天又拿到一份「按收益/成本排序」的落地清单。逐条查完，**6 项早已存在、3 项本轮新做、4 项按取舍不做**，剩下的是只能手工配、或者编号已经撞了。

| 清单项 | 状态 | 依据 |
|---|---|---|
| WAF 速率限制，先记录后拦截 | 未开 | 只能 Dashboard，代码层补不了；已写 `DEPLOY.md` |
| 托管规则 + Bot Fight Mode | 未开 | 同上。与蜜罐互补：蜜罐抓不跑 JS 的填表机，托管规则抓已知 IP 与指纹 |
| `READONLY_MODE` 运行时降级 | **本轮新增** | `api.js` 的 `readonlyMode()`，写方法 503、读放行，判定在鉴权之前 |
| CSP 响应头 | 早已有 | 13 条指令 + 每请求 nonce，不是「完全没有」 |
| Cookie `HttpOnly`/`Secure`/`Lax` | 早已有 | `utils.js` 的 `setCookie()` 默认值 |
| 去掉 `style-src 'unsafe-inline'` | 不做 | Markdown 的 `style` 属性（表格对齐）依赖它；`clean.js` 的 `attrFilter` 只放行 `text-align`，等于用白名单收窄而不是删掉 |
| 写接口流水线收口成一条 | 部分 | 闸门在入口、Turnstile 在评论、限额在 `antispam.js`。没做成单函数，因为 11 个 handler 的鉴权级别不同（匿名 / 用户 / 管理员），强行统一会变成一串 if |
| `Content-Type` 校验 | 未做 | 客户端 `fetch` 不一定设这个头，加了会先把自家编辑器打死；要做得先统一所有调用方 |
| 请求体大小限制 | **已做** | 64KB / 1MB / 8MB 三档，流式截断 |
| Turnstile 核对 hostname + action | **已做** | 严格相等，缺字段即拒 |
| 限流用 D1 单条 upsert | 早已是 | `record()` 就是 `INSERT … ON CONFLICT(k) DO UPDATE`，没有 KV 的读改写竞态 |
| 顺序守护断言 | **本轮新增** | `test-md-guard.mjs`，变异测试 + `s = esc(s);` 位置哨兵 |
| 响应头断言 | 早已有，本轮补强 | `check:live` 有 CSP/nonce 两条；本轮加 P-020 守 Turnstile 联动 |
| 蜜罐命中返回 200 假成功 | 不做 | 与站上立场冲突：11 号写明说「应该返回 400 而不是静默成功」——假成功会让误填的真人以为发出来了 |
| 给蜜罐/CSP 编 P-009、P-010 | 编号已占用 | P-009 是 CRLF/SRI，P-010 是 103 preload。改用 P-018/019/020 |
| D1 导出到 R2，保留 7 份滚动 | 早已有 | `backup-upload.mjs` 的 `KEEP = 7` + `backups/_manifest.json`；`backup-drill.mjs` 演练 |

本轮新做的那三条各有一句话值得留下：

- **只读开关写在入口、且在鉴权之前。** 降级时要省的正是那一次 `users` 查询；写进业务 handler 里，等于出事时还在花额度。
- **变异测试证明的是「断言会红」，不是「输出没变」。** 把 `esc` 换成恒等函数，27 条探针红了 7 条；拆掉协议白名单，红 3 条。这条比快照更强的点在于：快照错了会跟着一起错，变异不会。
- **顺序只能靠位置断言守。** `s = esc(s);` 必须早于 `IMG_RE` / `LINK_RE` 的替换。删掉那一行，对照组立刻红 6 条——这是全文唯一一条直接测「顺序」而非「结果」的断言。

## 明说的没做

1. **WAF 没开。** `DEPLOY.md` 只写了怎么配，配没配、误伤率多少，我这里没有数据。面板上有没有历史规则我也没查（token 读不到）。
2. **闸门只有单测，没有线上并发实测。** 73728 字节是本地 Node 的 `ReadableStream` 跑出来的，workerd 的流实现如果有差异，这个数字会变；上限本身不受影响。
3. **`/upload` 和 AI 摘要没限流。** 已识别，这轮没改。改之前要先定一件事：普通用户该不该有上传权？如果答案是「不该」，正确的修法是收权限，不是加计数。
4. **Turnstile 仍然 off。** 两把 key 都没配，所以 hostname / action 核对在线上一次都没跑过，只在单测里 stub 过 `fetch`。
5. **只读开关没有线上演练。** 6 条断言跑的是本地 `handleApi()`，`wrangler secret put READONLY_MODE` 之后线上到底是 503 还是被边缘缓存挡住，没验过。
6. **没做渗透测试，Rin 也没部署。** 材料里关于 Rin 的细节（`setup.ts` 挂上下文、`permission` 0/1、私密文章、`.env.example` 的 `admin/admin123`）我没独立复核，按材料口径引用；本文所有关于本站的结论都来自仓库代码与线上 D1 只读查询。

一个收束。

材料最后说「你的安全性来自『我知道哪一行会出事，并给它写了断言』」。这句话我认，但这次真正被记下来的不是它，是另一件事：**我对自己系统的记忆也是错的**。我以为自己没有权限层，理由还挺充分——「首页只有一个登录格」。查完 `users` 表才发现，我不仅有，还写着和对手一样的那个 `isFirst ? 1 : 0`。

断言能守住代码，守不住「我以为」。后者只能靠真去查一次。
