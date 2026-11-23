## 结论

一份"把 Rin 的结构抄过来"的建议，我照着做了。结论是：它的目录值得看，但能直接搬的**只有一条**——路由边界的断言。

另外两条（`services/` 垂直切分、`@rin/api` 契约）一条落不了地、一条不适用。而支撑这些判断的四个事实里，有三个不对，其中 `3KB CSS` 这个数字我在两份材料里都见过，两次都不是真的。

这篇记的是核对过程、抄的那一条、以及它抄过来之后**先红了一次**这件事。

## 一、先核事实：四条说法，三条不成立

材料里的事实我逐条去仓库里查了，口径是 `2026-11-23` 的 `main` 分支。

| # | 材料说法 | 核实结果 | 依据 |
|---|---|---|---|
| 1 | `runtime/` 三个 handler 分离 | **成立**，比描述更彻底 | `_worker.ts` **720 字节 / 19 行**，三个 handler 各一行转发 |
| 2 | Webhook 支持新评论 + 新友链申请、GET/POST、模板变量、自定义头 | **成立**，实际更宽 | 7 种方法、7 个变量，官方文档逐条列了 |
| 3 | 服务端用 unified/remark/rehype 做 **HTML→Markdown** 转换**和 sanitize** | **三处错** | 见下 |
| 4 | 每个功能一个 service，加个目录加一行注册 | **不成立** | `services/` 是横切能力，`features/` 只有一个文件 |
| 5 | 首屏 CSS gzip ≤ 3KB | **不成立** | 实测 gzip 37626 B、原始 142039 B |
| 6 | 它在快速变动期，下次上游合并就是一次手动移植 | **过度推断** | 21 个月一次大重构，正式版已 8 个月 |
| 7 | 客户端 react-markdown + KaTeX + Mermaid + 代码高亮 | **成立** | 依赖全在，`@tailwindcss/typography` 确实会接管排版 |
| 8 | v0.3.0 四条破坏性变更 | **成立**，逐字对得上 | 见下 |

### `3KB CSS` 错在哪

真实数字：`style.css` 单份全站表，**原始 142039 字节、gzip 37626 字节**，上限 39000 加基线 +10%。这是《样式表也做减法》那篇实测过并明确否定的方案——3KB 那套预算是给单页模板定的，差 12 倍。

写评论文章最容易犯的错，是把对方的宣传语和自己的能力混着说。这条如果发出去，第一次有人来对账就会崩。

### `services/` 不是功能层

材料写的是"每个功能一个 service，注册为子路由"。实际：

```
server/src/services/          8 个文件
  feed.ts          25040 B    文章列表 / 详情
  config-health.ts 14774 B    配置体检
  favicon.ts        9774 B
  sitemap.ts        8490 B
  feed-ai-summary.ts 4551 B
  storage.ts        4546 B
  config-compat-tasks.ts 3873 B
  tag.ts            3701 B

server/src/features/          1 个文件
  feed/repository.ts 2791 B
```

`services/` 装的是 feed、sitemap、tag、storage、favicon、config-health 这类**横切能力**；`features/` 里只有 `feed/repository.ts` 一个文件，是"把数据访问从 service 里拆出来"这件事**刚做完 feed 一个**。

所以"service 模式：每个功能一个目录 + 一行注册"描述的是**设计意图**，不是现状。真正的路由装配在 `core/register-routes.ts`（1437 字节），配 `register-middlewares.ts`（637 字节）。

这不是挑刺。它直接决定了"抄 services/"这条建议能不能落地——**你要抄的那个目录，装的不是你以为的东西**。

### sanitize 在客户端，服务端方向是反的

材料说"服务端用 unified/remark/rehype 做 HTML→Markdown 转换和 sanitize"。三处都要改：

**方向。** 服务端从 `remark-parse` 起手，链条是 `remark-parse → remark-gfm → remark-rehype → rehype-stringify`，输出 HTML。这是 **MD→HTML**。

**HTML→MD 是另一个包。** `html-to-md ^0.8.5`，配合 v0.3.0 加的 WordPress 导入用。跟渲染管线不是一回事。

**sanitize 不在服务端。** 服务端依赖里没有 `rehype-sanitize`。它在 **client** 的依赖里：`rehype-sanitize ^6.0.0` + `rehype-raw ^7.0.0` 配对出现——`raw` 放原始 HTML 进来，`sanitize` 负责洗。

这三处合起来说明一件事，而且是对材料结论有利的一件事：**要保住"敢让读者敲 `<script>`"那条测试，得换的不是一个函数，是整条管线**。它和"先转义后拼装"确实不能并存。这点材料说对了，只是理由建在错的事实上。

### 21 个月不算"快速变动期"

| 版本 | 日期 |
|---|---|
| v0.2.0 | 2024-06-07 |
| v0.3.0-rc.1 | 2026-03-06 |
| v0.3.0 | 2026-03-12 |

从 0.2 到 0.3 隔了 **21 个月**，一次大重构，而且 `v0.3.0` 是**正式版**，到今天已 8 个月。日常 commit 很活跃（最后 push `2026-11-15`，3151 star / 2574 fork / 83 open issues），但"破坏性变更"和"日常合并"是两件事。

材料引的官方原话是准的——`downstream forks with custom auth, deployment, or API wrappers should validate their integrations before treating it as production-ready`。但那是**针对预发布版本**的提醒，不是"每次合并都要手动移植"。把 21 个月一次的大重构说成高频，会让人低估"等它稳定"这个选项。

## 二、扩展性的分界线：谁为边界负责

材料把分界线画在"功能多少"上——Rin 模块化，我这边"评论、友链、图片、渲染全挤在一起"。这个描述我得改一下，因为它对**双方**都不准。

**我站的实际形状：** `src/` 30 个 `.js`、8657 行，其中 `index.js` 2811 行、`api.js` 1450 行。但真正属于"路由分发"的是 `async function route()` 那一个函数——改前 **111 行**，32 条路由规则（26 条精确匹配 + 6 条前缀），每条都 `return await serveXxx(...)`，实现在别的模块。入口 `export default` 本身已经很薄，`fetch` 里只包了日志和兜底。

**所以"全挤在一起"不成立。** 30 个模块切得不算乱。

材料还有一句："扩展到第五个功能时就会开始互相踩。"我这边已经 30 个模块、32 条路由，日常加功能就是新建文件 + 在 `route()` 加一行，没踩过。真正踩过的只有两次：一次是**路由抢匹配**（前缀路由排在精确路由后面，后者永不生效），一次是**同一个 path 写了两遍**。这两次都不是"文件多"造成的，是"那 111 行没人管"造成的——所以问题定位在分发器，不在模块数。

**真正的缺口是那 111 行里一条约束都没有：**

- 谁都能插一条 `if`，没人要求登记它归哪个模块
- 同一个 `path ===` 写两遍，前一条**静默失效**（早退型 if 的特性，不报错）
- 兜底分支（`segs.length === 1`）往上一挪，所有前缀路由全哑
- 分发器里能直接写 SQL——真有，`/tag/` 那 17 行

这四条都属于"改对了没感觉、改错了也不报错"。

**Rin 那边解决这事的不是目录，是测试。** `core/` 11 个文件里有 2 个 test，其中一个：

```
route-boundaries.ts       2442 B   ← 边界实现
route-boundaries.test.ts  2689 B   ← 边界测试
```

**测试比实现还大。** 这才是"加功能不碰老代码"能成立的唯一原因——不是目录摆得好看，是**有一条测试在断言"哪个路由归谁"**。目录只是让人容易遵守，测试才是让人必须遵守。

| | Rin | 我站（改前） |
|---|---|---|
| 路由装配 | `register-routes.ts` 1437 B | `route()` 111 行内联 |
| 边界约束 | `route-boundaries.ts` 2442 B | 无 |
| 边界断言 | `route-boundaries.test.ts` 2689 B | **0 条** |
| Worker 入口 | `_worker.ts` 720 B | `export default` + `route()` |

## 三、只抄一条：六条断言

"抄结构"的三条建议，我实际只抄得动一条：

**`services/` 垂直切分——抄不到。** 它装的不是功能，`features/` 又只是半成品。硬抄等于抄一个刚开工的重构。

**`@rin/api` 契约——不适用。** 那是 TypeScript + 两个包（client/server）+ 跨包类型共享的组合。我是 JS 单 Worker，没有第二端要跟前端对齐类型，也没有 `zod` 这一层。它解决的问题我不存在。

**`route-boundaries`——可抄，成本最低。** 不碰渲染、不碰 SSR 输出、不动 `html_content`，纯源码静态分析。

`scripts/test-route-boundaries.mjs`，六条：

| 编号 | 断言 | 守的是什么 |
|---|---|---|
| RB-01 | 路由已登记归属 | 新增路由不登记 → 红。32 条全部要出现在归属表里 |
| RB-02 | 登记项在代码里存在 | orphan 只警告（可能刚删代码），不算事故 |
| RB-03 | owner 模块文件存在 | 归属表里写 `auths.js` 这种拼错 → 红 |
| RB-04 | exact 路由无重复 | 写两遍 `path === '/x'`，前一条永不生效 → 红 |
| RB-05 | 兜底分支在前缀路由之后 | 兜底上移，`/p/`、`/tag/` 全哑 → 红 |
| RB-06 | 分发器不含 SQL | 路由层自己写查询，"加一行注册"就失效 → 红 |

归属表 `OWNERS` 是手写的，一条一个 pattern。这是有意的：**登记这件事本身要花一秒钟，这一秒钟就是"我知道我在动哪一层"**。

```js
const OWNERS = {
  // 前缀路由
  '/api/':      { file: 'api.js',      kind: 'prefix' },
  '/tag/':      { file: 'taxonomy.js', kind: 'prefix', note: '数据在 taxonomy，渲染内联在 route()' },
  '/p/':        { file: 'index.js',    kind: 'prefix' },

  // 鉴权
  '/auth/github':   { file: 'auth.js' },
  '/auth/callback': { file: 'auth.js' },

  // 后台
  '/admin':          { file: 'dashboard.js' },
  '/admin/review':   { file: 'review.js' },
  '/admin/health':   { file: 'admin-pages.js' },

  // 页面
  '/archive':    { file: 'index.js' },
  '/numbers':    { file: 'numbers.js', note: '数据在 numbers.js，渲染在 index.js' },
  '/categories': { file: 'taxonomy.js', note: '渲染内联在 route()，取静态骨架' },
};
```

`note` 字段不是注释，是**债务标记**。现在 32 条里有 4 条带 note，全部是同一个形状：数据归 A 模块、渲染还留在 `index.js`。这四条就是"还没拆干净"的清单——比写在 README 里的 TODO 可靠，因为它和断言同一个文件，改坏了会红。

## 四、断言先是红的

第一次跑，六条里五条绿，一条红：

```
pass  [RB-01] 路由已登记归属        32 条全部有归属
pass  [RB-02] 登记项在代码里存在      31 条全命中
pass  [RB-03] owner 模块文件存在     9 个模块
pass  [RB-04] exact 路由无重复      26 条唯一
pass  [RB-05] 兜底分支在前缀路由之后  兜底 L2656 / 最后前缀 L2651
FAIL  [RB-06] 分发器不含 SQL        命中 1 处：L2591
```

L2591 就是 `/tag/` 那个分支。它在分发器里同时干着四件事：解路径、写 SQL 判有没有公开文章、决定 404、取静态骨架渲染。

抽法不改判据——只是把那段 SQL 挪进 `api.js`：

```js
// src/api.js，紧跟 liveSql 之后
export async function tagHasLivePosts(env, name) {
  const hit = await env.DB.prepare(
    `SELECT 1 FROM tags t
     JOIN post_tags pt ON pt.tag_id = t.id
     JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}
     WHERE t.name = ? LIMIT 1`
  ).bind(name).first();
  return Boolean(hit);
}
```

分发器里那 9 行变成 1 行：

```js
if (!(await tagHasLivePosts(env, tag))) {
  return await notFoundPage(env, request, '这个标签下还没有文章');
}
```

**结果：**

| 项 | 改前 | 改后 |
|---|---|---|
| `route()` 行数 | 111 | **105** |
| 分发器内 SQL | 1 处 | **0** |
| `src/index.js` | 2817 行 | 2811 行 |
| `src/api.js` | 1434 行 | 1450 行 |
| 断言 | 0 条 | **6 条** |
| RB-06 | FAIL | pass |

**失败分支验过，不是摆设：**

```
注入重复 path === '/numbers'
  FAIL  [RB-04] exact 路由无重复  /numbers L2619/L2620    exit=1

注入未登记 path === '/brand-new'
  FAIL  [RB-01] 路由已登记归属    未登记 1 条：/brand-new(L2619)  exit=1

恢复后 exit=0
```

**行为不变，起本地 Worker 打过：**

| 路径 | 状态 |
|---|---|
| `/tag/cloudflare` | 200 |
| `/tag/nonexistent-xyz` | 404 |
| `/tag/Cloudflare` | 301 → `/tag/cloudflare` |
| `/cat/tools` | 200 |
| `/cat/unknown` | 404 |
| `/categories` | 200 |
| `/numbers` | 200 |

同一套判据、同一个 `liveSql('p')`，只是不在路由层了。

## 五、明说的没做

- **没部署 Rin，没跑它的测试。** 所有对比基于仓库文件和官方文档，不基于运行行为。
- **没做性能对比。** 页结构、请求数、功能集都不同，比 LCP 不公平，不重复。
- **没把 `index.js` 拆成 `features/` 目录。** 会动渲染闭包（`html()` / `injectTheme()` / `stampAssets()` 都在 `index.js` 里），违反"SSR 零改动"，收益也远不如一条断言。
- **RB-05 只断位置，不断语义。** 兜底在最后 ≠ 兜底逻辑对。它只能防"往上一挪"这一种改法。
- **归属表要手维护。** 新增一个模块要手改一行 `OWNERS`，没有从 import 图自动推导。做的代价是每次多打一行字，不做就是断言变噪音。
- **RB-02 的 orphan 只警告。** 和 `check-pitfalls` 同一口径：文档里写了但代码里没有，可能是刚删，不该让 CI 停下。
- **没抄那套 `zod` 契约。** 理由上面写了，不是不认同——是单 Worker 没有第二端要对齐。

## 怎么自己验

```bash
# 六条断言，纯静态分析，不起服务
node scripts/test-route-boundaries.mjs

# 已接进 npm test 链，在 test-numbers 之后
npm test

# 看分发器现在长什么样
sed -n '2557,2661p' src/index.js
```

如果你想验"它是不是真能红"：在 `route()` 里随便加一条 `if (path === '/whatever') return null;`，RB-01 会告诉你 `未登记 1 条：/whatever(Lxxxx)`。删掉就绿。

---

最后说回那个判断：**"想加功能"选 Rin，"想某一处做到极限"留自研**。这条我认同，但理由要换——不是因为它模块化、我耦合，而是因为它有一条测试在替边界负责，而我没有。现在有了，只有一条，但那条是能红的。

#rin #workers #testing #refactoring
