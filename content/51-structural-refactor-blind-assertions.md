## 结论

材料首推的那个仓库，**按它给的名字打不开**。`kodadot/backend-starter` 是 404。真正叫 Backend Starter 的是 `sadiq-bd/backend-starter`（2★、MIT、最后推送 2026-08-27），结构和材料描述逐项对得上——`src/features/test-feature/{index,config,controller,service}.ts`、`lib/middleware/cacheHandler.ts`、`rateLimiter.ts`、`basicAuth.ts`、`routes/index.ts` 全在。所以我按这个仓库核的。

它确实比前几轮的候选干净。但材料里有四处说错，其中两处正好是它被推荐的理由：

| 材料主张 | 实测 |
|---|---|
| 依赖只有 Hono、Drizzle、Zod、Vitest | **漏了 `jose`**。runtime 依赖是 `drizzle-orm` + `hono` + `jose` + `zod` 四个，devDeps 还有六个（`drizzle-kit`、`@cloudflare/vitest-pool-workers`、`workers-types`、`@types/node`、`vitest`、`wrangler`） |
| `features/` 垂直切片，加功能 = 加目录 + 挂一行 | **仓库里只有一个 `src/features/test-feature/`**，是示例。这套约定验证过一遍，不是验证过多轮 |
| `cacheHandler.ts` 用 Cache API + 内存回退，正好对应「失效挂在写入路径上」 | Cache API + 内存回退是真的。**但它没有失效路径**：`cache()` 只暴露 `put / match / delete`，全仓库没有一处调用 `delete`；`CDN_CACHE_TTL = 60 * 60 * 24 * 30`，内容是**存 30 天等自然过期**。这和你那条要求是相反的 |
| `rateLimiter.ts` 用内置限流，替代 D1 原子 upsert | 用的是 `[[ratelimits]]` binding，成立。但**语义不等价**，见下 |
| `hono/tiny` 预集小于 14KB | 成立但容易读错：**14,209 B 是 minified 未压缩**，实测 gzip 是 **5,984 B** |
| `vitest-pool-workers` 跑在真 workerd | 成立。`@cloudflare/vitest-pool-workers ^0.14.9` |
| 首个用户即管理员该删 | 成立，但**这个仓库里没有这段逻辑**——它连注册都没有，只有 `basicAuth.ts`（DB-backed HTTP Basic） |

## 内置限流不是 D1 原子 upsert 的替代品

Cloudflare 自己的文档在配置示例的注释里写了两句话，都很短：

```
// Limit: the request threshold within a given period in a single
// Cloudflare location. Requests can exceed this threshold.
```

一是**按边缘节点计数**（文档 "Locality" 一节的原例：悉尼的 100 次算悉尼的），二是**官方自己承认可以超出阈值**——它是近似计数器，不是硬闸。

本站的限流是 D1 单主库上的原子 `INSERT … ON CONFLICT DO UPDATE`，全局一个口径、写完即准。两者解决的问题不一样：

| | `[[ratelimits]]` binding | 本站 D1 原子 upsert |
|---|---|---|
| 计数范围 | 单个 colo | 全球单主库 |
| 精度 | 近似，文档承认可超 | 精确 |
| 窗口 | 固定 10 或 60 秒 | 任意（现在用滑动分钟桶） |
| 跨区攻击 | 每个 colo 各给一份额度 | 共享一份额度 |

拿它替掉 D1，等于把「全局每分钟 N 次」换成「每个 colo 每分钟 N 次」。对评论防刷这种场景影响有限（CF 按就近路由，攻击面本来集中），但这不是同一个东西，不能当成「省一次 subrequest 的等价替换」写进方案。

顺带纠正上一轮我自己的措辞：`[[ratelimits]]` 调用确实不算 subrequest，但它换来的是**精度**，不是省钱。

## 那套 cacheHandler 里有一个不能抄的写法

```ts
const revalidateCache = async (c, next, req, ttl) => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  c.finalized = false;      // ← Hono 内部字段
  await next();             // ← 在同一个请求里把中间件链重跑一遍
  …
  c.finalized = true;
};
```

stale 命中时，它把 `c.finalized` 翻回去再跑一次 `next()`，让整条链（含 handler）在**同一个请求上下文里执行第二遍**。对只读的 GET 接口勉强能用，但任何带副作用的 handler——记浏览量、写审计日志、递增计数——都会被算两次。本站 `/pv`、`/ev` 就是写库的，抄过来等于每次 stale 命中多记一次。

正确做法是本站现在这种：**后台重算走独立路径，不复用前台 handler**。`postCacheDrop` + `bustPaths` 是「删掉，让下一次请求正常回源」，不是「在别人的请求里偷偷重跑一遍」。

## 本轮真正的缺口：目录一重排，四条断言一起失明

材料最后问要不要按 `features/` 切片重排一版。**我没有重排，先做了一件事：验证重排会不会把现有断言弄哑。答案是会，而且是四条一起。**

仓库里有四处「遍历 `src/` 找违规」的断言，写法都是：

```js
fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'))
```

`readdirSync` 不递归。所以只要有一个文件进到 `src/features/post/controller.js`，它就不在这四个集合里：

| 断言 | 守什么 | 重排后 |
|---|---|---|
| `AP-15` | 全站只许 `auth.js` 出现「作者 or 管理员」判定 | 子目录里的裸判定视而不见 |
| `AP-16` | 审核态只能由 `reviewStatusFor()` 生成 | 子目录里的三元视而不见 |
| `RB-03` | 路由登记的 owner 文件真实存在 | 全部报「文件不存在」，然后大概率被人删掉 |
| `test-schema` | 代码 `INSERT` 的列必须在 migrations 里 | 子目录里加列忘写迁移，静默通过 |

实测：建 `src/_probe/evil.js`，里面就一行

```js
return user && (user.id === post.author_id || user.is_admin);
```

`node scripts/test-auth-policy.mjs` → **17/17 全绿**。同一个目录里放一句 `INSERT INTO posts (slug, no_such_column_zz)`，`node scripts/test-schema.mjs` → **11/11 全绿**。

这是假绿的第三代，前两代都在这个网站上：

| 代 | 形态 | 编号 |
|---|---|---|
| 一 | `t()` 是同步函数，async 用例的 rejection 被吞，六条断言从来没执行过 | P-029 |
| 二 | 断言执行了，但只认 `!== && !is_admin` 一种句式，等号/反序/或运算全漏 | P-030 |
| 三 | 断言执行了、判据也对，但**扫描范围**随着目录重排悄悄缩成零 | P-032 |

第三代最难受的地方：前两代改代码能让它红，这一代**改代码它也不红**——它眼里根本没有那个文件。

## 修法：把「扫描范围」本身变成被断言的对象

新增 `scripts/lib/src-walk.mjs`，三个函数：`srcFiles`（递归枚举，返回相对 `src` 的 posix 路径）、`srcEntries`（连文本一起读，报错能指到子目录行号）、`nativeSrcFiles`（用原生 `readdirSync(root, {recursive:true})` 独立实现一遍）。

四处扫描全部换过去，同一条判据只有一份实现——否则四个脚本各写一遍，迟早有一个忘了改。

然后加一条元断言：

```js
t('AP-18 源文件扫描必须覆盖 src 全部层级', () => {
  const walk = srcFiles(root);
  const native = nativeSrcFiles(root);
  assert.deepEqual(walk, native);              // 两套实现互校，walk 自己写错也会红
  assert.ok(native.length >= 20);              // 扫到的数量下界
  for (const d of 子目录列表) {
    assert.ok(native.some((x) => x.startsWith(d + '/')),
      `src/${d}/ 下的 .js 一个都没进扫描结果`);
  }
});
```

最后那条现在是空转（`src/` 是扁平的），但它是给未来准备的：**拆分那天它会先红，而不是等到某个子目录里的裸判定上线之后**。

注入验证：探针在位时 `AP-15` 报 `_probe/evil.js:2`、`test-schema` 报 `posts.no_such_column_zz`；删掉探针 → 18/18、11/11。

## 为什么不重排

不是嫌麻烦。是这三件事的性价比不对：

1. **收益是目录好看**。`src/index.js` 2826 行确实大，但它是 `route()` 分发器 + SSR 页面，按 `features/` 拆成 `post/`、`comment/`、`tag/` 之后，跨模块的调用（详情页要标签、要相关文章、要评论数）会从同文件函数调用变成循环依赖，或者多一层转发。
2. **风险已经被量化**：四处断言失明，而且是静默的。
3. **`features/` 那套约定的真正价值是「第三方能加功能」**。本站没有插件需求——加功能的只有我一个人，`route()` 里加一行分支的成本比拆目录低。

所以本轮做的是「把重排的前提修好，而不是执行重排」。哪天真要拆，`AP-18` 会先拦住。

## Hono 的代价，实测数字

材料说「轻量」是对的，但要说清是哪种轻：

| 项 | 实测 |
|---|---|
| `hono/tiny` + 一条 GET 路由，minified | **14,209 B** |
| 同上，gzip -9 | **5,984 B** |
| 本站 Worker 脚本，minified | 333,792 B |
| 本站 Worker 脚本，gzip | **99,129 B** |
| 引入 hono/tiny 后 gzip 增幅 | **+6.0%** |

+6% 不是否决理由——真正的成本在别处：111 行 `route()` 要重写成 Hono 的路由表，而那个分发器是被 `RB-01`~`RB-06` 六条断言锁着的（路由必须登记、不许重复、兜底不许上移、分发器里不许写 SQL）。换框架等于把这六条全部重写一遍，换来的只是「中间件写法更标准」。

本站的中间件已经是函数组合（`harden()`、`withCache()`、`ownerOrAdmin()`），Hono 提供的 `c.set/get` 上下文在本站是显式传参，没有收益差。

## 闭环

| 文件 | 改动 |
|---|---|
| `scripts/lib/src-walk.mjs` | 新增，递归枚举 + 独立第二实现 |
| `scripts/test-auth-policy.mjs` | `AP-15` / `AP-16` 改递归扫描，新增 `AP-18`，17 → 18 条 |
| `scripts/test-route-boundaries.mjs` | `RB-03` 改按 basename 匹配，同名文件单独警告 |
| `scripts/test-schema.mjs` | INSERT 列扫描改递归 |
| `PITFALLS.md` | 新增 `P-032` |

`npm test` 全绿，PITFALLS 对账 32 条。

**没做的**：没有重排目录；没有引 Hono / Drizzle / Zod / jose 任何一行（`package.json` 的 `dependencies` 仍然是空的，运行时零依赖）；没有加 KV；没有把 `[[ratelimits]]` 接进来（它解决不了本站要的全局口径）。
