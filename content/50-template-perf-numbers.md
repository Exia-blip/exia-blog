## 结论

材料的第一条性能实践方向是对的，但它举的那个问题**本站已经有一个更严重的版本，而且是我自己造的**——不是 KV 最终一致，是边缘缓存的 300 秒 TTL 加上两处漏传参数。

这一轮真正改的代码只有两行：

```js
// api.js 审核放行：栏目一起传
ctx.waitUntil(bust(url, [p.slug], [p.category], db));
// api.js 版本回滚：回滚会改栏目，新旧两个都清
ctx.waitUntil(bust(url, [p.slug], [p.category, rev.category], db));
```

原来两处都是 `bust(url, [p.slug], [], db)`。文章本体清了，`/cat/<栏目>` 没清。投稿放行的那一刻是它**第一次**进入栏目列表，栏目页却还压着 300 秒的旧 HTML——作者点进去看不见自己的稿子，以为没发出去。

| 材料条目 | 实测 |
|---|---|
| 「Cloudflare **Northstar** 模板」 | 仓库是 `jroth1111/cloudflare_template`，个人项目，非 Cloudflare 官方；最后提交 2025-12-19，近一年未更新 |
| Northstar「五个里唯一性能与权限边界感都做对」 | Service Binding 那一件事确实做对了。但它带 **Tailwind v4**（`packages/ui` 就是 Tailwind entrypoint），与「保住 3KB CSS」直接冲突 |
| 「DO 的 rateLimit 比 D1 更省 subrequest」 | **错**。DO 调用本身就是一次 subrequest。真正不占 subrequest 的是 `[[ratelimits]]` binding（2025-09 GA，per-PoP，10/60 秒窗） |
| 「TinyMCE 会顶掉你自研渲染器」 | 概念混淆。TinyMCE 是**编辑器**，`md.js` 是**服务端渲染器**；本站编辑器是 textarea + Monaco，不是富文本 |
| 「CSP 先 Report-Only 跑一周」 | **第三次出现了**。上一轮已核过：enforcing 上线已久，退回 Report-Only 是降档 |
| 「你测的 96ms 含渲染」 | 96 是 13 篇里「排队段」的数，不是优化后的总耗时。13 篇正文明确写着「549 → 96 跨了两个实验，属于拿两个不同实验的结果互相背书」——材料在批判别人拿数字当基线的那一条里，自己用了同一个用法 |
| 「KV 写路径主动失效」 | **成立**，而且本站已经在做（`bustPaths` + `postCacheDrop`），只是漏了两个维度 |
| 「首个用户自动管理员该删」 | **成立**，flare-stack README 现在仍写着这句 |
| 「模板的 API 数字不是你的首屏数字」 | **成立**，且是这轮材料里最有用的一条判断 |
| lumi-cms 默认 `admin/123456` | **成立**，README 原话「默认用户: admin / 123456, lumi / 123456」 |
| SonicJS 宣称「零冷启动、API 15–50ms」 | 出自它官网首页的对照表，单位与方法未公开（对比对象是 Strapi/Payload/Directus） |

## 一、五候选，只看与本站冲突的那一列

| 项目 | 权限 | 性能卖点 | 与本站的冲突 |
|---|---|---|---|
| SonicJS (MIT) | `requireAuth()` / `requireRole()` 中间件 | 边缘原生、Hono、`documents` 通用表、HTMX | 表结构差一个数量级；HTMX 换掉现有一切前端交互 |
| flare-stack (GPL-3.0) | Better Auth | SSR + D1 FTS + KV + DO 限流 + Queues | React 19 + Tailwind 4；GPL 传染；首用户即管理员 |
| Cloudcore (MIT) | `role` 单列 + `PERMISSIONS` 常量表 | 块式内容、公开只读 REST | React 管理端；README 建议生产环境挂 Cloudflare Access 后面 |
| CFBlog | 5 级角色 | 状态机、R2、AI slug | **核实不到这个项目**（上一轮已记，本轮仍未找到出处） |
| cf-astro-blog-starter | JWT + Turnstile，单管理员 | `src/middleware.ts` 集中响应头、Astro SSR 直查 D1 | 不是多用户，直接出局 |
| Northstar | Better Auth | Service Binding 拆公开/私有 Worker | 个人仓库、一年未更新、带 Tailwind v4 |

Northstar 值得单独说一句，但和材料说的不一样：**它做对的只有 Service Binding 这一件**，而这一件的价值在本站是负的。理由在第四节。

## 二、材料对的那一条判断，比它自己意识到的更重要

> 「别拿模板的 API 数字当你的首屏数字。」

这是这轮材料里唯一能改变决策的一句话。SonicJS 的「零冷启动、API 15–50ms」测的是**一次 API 响应**；13 篇测的是**一次完整 HTML 直出**，含 4~6 次 D1 查询、Markdown 渲染、模板拼装、nonce 注入。这两件事之间隔着渲染，量级差一个数量级不是异常，是必然。

但紧接着材料就把 96 当成了「你的首屏数字」。13 篇第 3 行的原话是：

> 549 和 96 之间隔着两个变量：一个是冷启动转热，一个才是代码改动。把这俩混在一起说「我只改了一件事就把 549 变成 96」，属于拿两个不同实验的结果互相背书。

所以真要基线，只能重测，而且要用材料第四条自己给的方法：旧提交独立部署、两个 tail 同时抓、请求交替发。这一轮没做，理由见「明说的没做」。

## 三、KV 那条实践：方向对，但本站的问题不在 KV

材料说 `withCache(kv, key, ttl, fn)` 的标准写法是「写路径主动失效，别只靠 TTL」，并提醒 KV 是全球最终一致、传播约 60 秒。

**本站没有 KV。** `wrangler.jsonc` 的绑定只有 `ASSETS` / `DB` / `BUCKET` / `AI` / `CF_VERSION_METADATA`。理由上一轮记过：D1 才是真缓存层，KV 是「读写比极高、能容忍几秒陈旧」的场景——本站的文章列表页有 300 秒边缘缓存，加一层 60 秒的 KV 只是把「旧多久」从 300 秒降到 60 秒，代价是引入一个最终一致的层。

**但「写后读到旧值」这个问题本站有，只是来源不同。**

`src/cache.js` 里：

```js
export const EDGE_TTL = 300;
export const EDGE_SWR = 86400;
```

所有列表页走 `s-maxage=300, stale-while-revalidate=86400`。300 秒内边缘直接吐旧副本，300 秒后先吐 stale 再后台刷新。所以「旧多久」的窗口比 KV 的 60 秒还长——**只不过本站有主动失效，能把这个窗口压到接近零**。

前提是每次写入都把该清的维度清全了。

### 两处没清全

`bust()` 的签名是：

```js
async function bust(url, slugs = [], cats = [], db = null)
```

它拼的清单是：固定的 `/`、`/archive`、`/categories`、`/series`，加上 `slugs` 里每篇的两条路径，加上 `cats` 里每个栏目一条 `/cat/<栏目>`，加上从库里枚举的全部 tag 与全部 series。

tag 和 series 是查库全量枚举的，所以漏不了。**栏目是唯一依赖调用方传参的维度。**

全站九处调用里，两处传了空数组：

| 位置 | 场景 | 后果 |
|---|---|---|
| `api.js:696` | `/api/review/:id` 审核通过/驳回 | 放行前稿件是 `pending`，不在任何列表里；放行那一刻才第一次进 `/cat/<栏目>`，而那一页还压着 300 秒旧 HTML |
| `api.js:1012` | `/api/posts/:id/restore` 版本回滚 | 回滚会连 `category` 一起改回旧值，新旧两个栏目都该清，实际一个都没清 |

第二处更隐蔽：回滚的 UPDATE 语句里明明写着 `category=?`，读的人一眼能看到「栏目变了」，但下一行清缓存只传了 slug。**这两行相邻，中间没有任何东西提示它们不一致。**

### 断言怎么守

`CB-06` 已经在守「四条文章写路径都挂了 bust」，但它守的是**挂了没有**，不是**参数传全没有**。这两件事差一个维度。所以加了 `CB-10`：

```js
// 凡第二参数带 slug 的 bust 调用，第三参数不许为空数组
const emptyCatsWithSlug = api.split('\n')
  .filter((l) => /bust\(url,\s*\[[^\]]+\],\s*\[\]/.test(l));
if (emptyCatsWithSlug.length) → FAIL，打印行号
```

判据是**形状**而不是次数：带具体 slug 的写入，必然影响它所属的栏目，所以第三参数不许为空。注入验证：把审核那行改回 `[]`，`CB-10` 红并报 `api.js:698`；改回来，10/10 全绿。

这条断言的价值在于它守的东西**没有任何功能测试能抓到**——漏清时响应是 200、内容正确、只是慢 5 分钟上线。功能测试全绿，人工验收也全绿。

## 四、为什么不上 KV、DO、Service Binding

三样都被材料点名，三样我都查了，三样都不上，理由各不相同。

**KV 不上**：把 300 秒的一致性问题换成 60 秒的一致性问题。本站的写入频率是「一天一篇」，`bustPaths` 一次清几十个 key，成本可忽略；换成 KV 要维护一套 key 命名、TTL、失效三处对齐，收益是「miss 时快几十毫秒」——而 miss 已经被 D1 的进程内 LRU 和边缘缓存挡住了。

**DO 不上，而且材料那句是错的。** 「DO 的 rateLimit 比 D1 更省 subrequest」——Cloudflare 自己的文档把 subrequest 定义为「Worker 发起的每一次 fetch，包括对 D1、R2、KV、Durable Objects 的调用」。DO 调用是 subrequest，D1 查询也是 subrequest，**两者都是 1 次**。DO 真正换来的是「全局单点串行」，代价是每次多一次网络往返（实测报告 10–50ms，冷启 ~100ms）。

对本站的限流：现在是一条 `INSERT ... ON CONFLICT DO UPDATE` 原子递增，1 次写、精确、全局限流（D1 是单一主库）。换 DO 是 1 次 subrequest + 一次往返 + 一个要单独部署和监控的类——纯粹升成本。

材料可能想说的是 **`[[ratelimits]]` binding**：它确实不占 subrequest（不走网络，边缘本地判定），但它是 **per-PoP** 计数，300 多个 PoP 各自算一份，10 秒或 60 秒固定窗口。适合挡「同一个 IP 疯狂刷登录」，不适合「这个账号今天只能发 5 篇」这种精确配额。本站要的是后者。

**Service Binding 不上，但它是五个方案里唯一值得记下来的。** 把 `/api/*` 转到私有 Worker，公开入口只剩页面渲染，私有 Worker 没有公网 URL。Cloudflare 文档说它「零额外延迟、默认同线程、不增加成本」——技术上是干净的。

不做的理由是收益为负：

1. **nonce 要跨 Worker 传。** CSP 的 nonce 在公开 Worker 生成、注入 HTML；私有 Worker 若也要输出任何带脚本的响应，两边必须共享同一个 nonce 来源，否则 CSP 挡掉自己。这会把现在「一次响应内生成」的模型拆成「跨进程对齐」。
2. **缓存键要重新对账。** 现在 `caches.default` 的键是完整 URL，公开 Worker 缓存、私有 Worker 也可能缓存，两份 TTL 不同步时会出现「页面是新的、接口是旧的」。
3. **部署不再原子。** 现在 `wrangler deploy` 一次上去，前后端永远同版本。拆成两个 Worker 就有中间态：新前端配旧接口。

对本站这种「一个 Worker、七个页面、四个写接口」的规模，拆分换来的边界感，抵不上这三条。

## 五、权限那条，第三次出现了

> 「权限判断只许出现在中间件和 can() 里，不许散在 handler。」

上一轮已经把这条落成了断言（`AP-15`：遍历 `src/*.js`，`.author_id` 与 `.id`/`is_admin` 的比较只许出现在 `auth.js`），`AP-16` 守审核态唯一来源，`AP-17` 守 null-safe。17/17 绿。

材料说「这条在加了多用户之后会变成你整套安全体系里最关键的一行」——**方向反了**。越权判定与用户数量无关：`is_admin` 只有 0 和 1 的时候，「能不能改别人的文章」这个问题就已经存在，而且已经有人踩过（上一轮 `index.js` 那两处）。加多用户不会让它变得更重要，只会让漏掉的后果从「改错一篇」变成「改错一个作者的十篇」。

所以这条不是「加了多用户才要守」，是**现在就必须守着，加不加多用户都一样**。

## 明说的没做

1. **没有重测首屏基线。** 材料给的对照方法（旧提交独立部署 + 两个 tail 交替抓）是唯一可信的做法，但它要动线上、要两次部署、要抓够样本，这一轮没做。所以这篇不提供任何新的性能数字，只指出 96 不能当基线用。
2. **KV / DO / Service Binding 一行没加。** `wrangler.jsonc` 的绑定还是五个，没多没少。
3. **CSP 没退回 Report-Only。** 第三次要求，第三次拒绝，理由不变。
4. **CFBlog 仍未核实到。** 两轮都搜不到，如果它真的存在，需要材料给仓库地址。
5. **只修了两处漏传栏目，没做「bust 参数自动化」。** 更彻底的做法是让 `bust()` 自己接收文章行、内部读 `category`，调用方不可能传错。没做的原因是它要改九处调用签名，而 `CB-10` 已经把错误形状挡住了——先让断言守，等下次真需要改 `bust()` 时一起做。
6. **`check-live` 四条仍红。** 本轮改动同样未部署。

## 复现条件

- 环境：本机 Node 22，仓库 `main`
- 触发：`node scripts/test-cache-bust.mjs`
- 期望：`CB-01`~`CB-10` 全绿；把 `api.js` 审核那行改回 `bust(url, [p.slug], [], db)` 后 `CB-10` 红并打印行号
- 实际：一致（注入后报 `api.js:698`，回滚后 10/10）

## 断言代码

```bash
node scripts/test-cache-bust.mjs    # CB-10 单篇写入必须带栏目
node scripts/test-auth-policy.mjs   # AP-15 全站白名单 / AP-16 / AP-17
npm test                            # 含 PITFALLS 双向对账（31 条）
```
