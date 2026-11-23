# 目录重排的第二层故障：把测试目录排除掉，等于造出一个盲区

## 结论

这份目录结构里有**七个组件在本站不存在**，一处行为写反，还有一处是我上一轮自己说错的判断。

真正能落地的只有一件事：`/api/tags` 加边缘缓存并进清理清单。而这件事暴露的断言问题，比目录本身重要得多。

## 先纠正我上一轮的那句话

上一轮我写「`/api/tags`、`/api/archive` 这两个接口不存在」。

**存在。** `src/api.js:703` 和 `:708`。我当时的判断只覆盖了页面路径（`/tag`、`/archive`），没往 API 层看一眼就下了结论。

但两个接口的处境完全不同：

| 接口 | 谁在调 | 频率 |
|---|---|---|
| `/api/tags` | `public/categories.html` | **热路径**。`/categories` 是静态壳原样返回（`env.ASSETS.fetch('/categories')` 不注入任何东西），标签云完全靠前端拉这个接口 |
| `/api/archive` | `public/archive.html` | **冷路径**。`/archive` 的 SSR 把数据一起吐进 `window.__ARCH__`，前端第一行是 `let DATA = window.__ARCH__ || null`，后面才有 `if (!DATA) return await load();` —— 只有 SSR 挂了才 fallback |

首页的标签栏也是同理：`if (ssrBars.tag) return;`，SSR 直出的 `<!--TAGBAR-->` 已经接住了。

所以材料第 4 步说的「挂 `/api/tags` 和 `/api/archive`」只对了一半 —— 而恰好是它没想到的那一半（`/api/tags`）才是真的。

## 材料里不存在的七个组件

| 材料写的 | 本站实际 |
|---|---|
| `app.ts` + Hono v4 `app.route()` | 零运行时依赖，`dependencies` 是空的。上一轮实测 `hono/tiny` gzip 5,984 B，本站 Worker gzip 99,129 B，引入即 +6.0% |
| `auth/oauth.ts`：Device Flow | **没有 Device Flow**。是标准授权码流程 + `state` cookie |
| `auth/jwt.ts`：验签、`iss`/`aud`/`exp`、算法锁定 | **不是 JWT**。HMAC 两段 `p.s`，`parts.length !== 2` 直接判无效 —— 没有 header 段，也就没有 alg 可锁、没有 iss/aud 可校 |
| `types/env.ts`：含 KV、Ratelimit | binding 只有 `ASSETS` / `DB` / `BUCKET` / `AI` / `CF_VERSION_METADATA` |
| `__tests__/*.test.ts` + vitest | 33 个 `.mjs` 断言脚本，`node scripts/xxx.mjs`，没有测试框架 |
| `/api/comment`、`/api/links`、`/api/auth` | 实际是 `/api/comments`、`/api/friends`、`/auth/github`（登录**不在** `/api` 下） |
| `comments/honeypot.ts`：命中返回 200 假成功 | 返回 **400**（`api.js:1143`）。「不招供」指的是文案含糊，不是状态码撒谎 |

`links/check.ts` 那条「20 分钟一轮」是对的：`crons: ["*/20 * * * *"]`。

## `md.js` 不能搬进 `src/features/posts/render.ts`

`public/md.js` 622 行，是**双端共用**的：

```
src/api.js:18      import { renderBody, ... } from '../public/md.js';
src/cover.js:12    import { extractCover } from '../public/md.js';
src/index.js:6     import { extractExcerpt, readingTime, renderBody, tocOf } from '../public/md.js';
public/editor.html:311   import { renderMarkdown, ... } from '/md.js';   ← 浏览器直接加载
```

最后一行是关键：编辑器在浏览器里 `import '/md.js'`。文件搬进 `src/` 之后，浏览器那一端就 404 了。

顺带一提，「渲染器挤在入口里」也是概念混淆。`index.js` 那 2826 行不是渲染器，是**各页面的布局拼装**（55 个函数：首页、标签页、栏目页、归档、友链、系列、404、后台各页）。markdown 渲染本体早就在独立文件里。这和上一轮那条「TinyMCE 顶掉自研渲染器」属于同一类错误 —— 把编辑器、渲染器、页面拼装三件事混成一件。

## 「feature 之间不许互相 import」在本站直接冲突

材料自己写了：「评论要读文章标题，就在 posts/service.ts 暴露一个查询函数，由 controller 调，别让 comments 直接摸 posts 的表」。

那句话的后半句才是真的边界 —— **表所有权**，不是目录所有权。包一层函数不改变依赖方向，只是让它看起来没有。

本站文章详情页在同一个渲染过程里要：文章本体、作者、标签、系列、相关文章、评论数。拆成两个 feature 之后，`posts/controller` 要调 `comments/service` 拿计数、调 `tags/service` 拿标签 —— 材料那条禁令立刻被违反，或者要再造三层转发。

真正合理的切法是按**数据所有权**切，不是按 URL 切。而本站只有一个人写代码，`route()` 里加一行分支比拆目录便宜两个数量级。

## 这一轮真正修的两件

### 一、排除测试目录，会造出一个盲区（P-034）

上一轮修的是「扫不到」（P-032）：四处 `readdirSync(srcDir).filter(.js)` 不递归，子目录里的裸权限判定 17/17 全绿。

递归修好之后，把测试放进 `src/` 就变成另一种故障。实测：

```bash
mkdir -p src/__tests__ && echo 'export const f = (u,p) => u.id === p.author_id || u.is_admin;' > src/__tests__/a.spec.js
node scripts/test-auth-policy.mjs
# → 17/18 passed，报 __tests__/a.spec.js:1
```

同一时刻 `src/_probe/evil.js` 报的是真越权。两者在输出里长得一模一样。

**假红比假绿更危险**：假绿让人以为有保护（至少还会怀疑）；假红让人去关断言 —— 而关断言的路径是「给它加个豁免」，一路加下去等于删掉。

修法是显式分家，而不是加豁免：

```js
export const NON_PRODUCT_DIRS = new Set(['__tests__', '__mocks__', '__fixtures__', 'test', 'tests']);
export function isNonProduct(rel) {
  const segs = String(rel).split('/');
  segs.pop();                                  // 文件名不参与判断
  return segs.some((s) => NON_PRODUCT_DIRS.has(s));
}
```

但排除本身制造了盲区：`src/__tests__/` 从此不在四条扫描断言的视野里。所以配套一条 `AP-19` —— 它不看目录名，看 import 边：

```js
t('AP-19 产品代码不许 import 非产品目录', () => {
  const leaks = nonProductLeaks(path.join(here, '..'));
  assert.deepEqual(leaks, [], `产品代码引到了测试/夹具目录：\n${leaks.join('\n')}`);
});
```

注入验证：`utils.js` 顶部加 `export { assertOwner } from './__tests__/auth.spec.js'` → `AP-19` 红，报 `utils.js:1`。

还有一处细节：`nativeSrcFiles()` 的排除逻辑**故意重写一遍**，不调 `isNonProduct()`。两套实现共用一个判据函数时，判据写错了两边一起错，互校就失去意义。

### 二、`/api/tags` 加缓存，同时必须进 bust（CB-11）

`json()` 的默认是 `cache-control: no-store` —— 这是给鉴权接口用的安全默认，`/api/tags` 一直吃这个默认。它没有用户维度（只查 `is_private = 0 AND hidden = 0`），每次打开 `/categories` 都打一次 D1 三表 JOIN。

改成复用页面那套口径：

```js
if (path === '/tags' && method === 'GET') {
  return json({ ok: true, tags: await tagsData(db) }, 200, { 'cache-control': pageCacheControl() });
}
```

`pageCacheControl()` = `public, max-age=0, s-maxage=300, stale-while-revalidate=86400`。浏览器每次校验、边缘 5 分钟、过期后先给旧的。不另写数字，是为了让 `CB-09`（边缘头与 Worker 内口径一致）继续守得住。

**必须同一个 commit 加上清理**：

```js
const paths = ['/', '/archive', '/categories', '/series', '/api/tags'];
```

理由很具体：`/categories` 的 HTML 里**根本没有标签数据**（静态壳原样返回），只清那一页等于没清。

断言 `CB-11` 的判据做过两轮修正，两次都是我自己踩的坑：

**第一版**只验「识别到的带缓存接口都在清理清单里」。问题是它在**识别集为空时恒真** —— 谁把 `pageCacheControl()` 删了，集合变空，红线自己消失了。这是 P-034 的同族：判据对空输入恒真，等于没有判据。改成写死预期集合：

```js
const EXPECT_CACHED_GETS = ['/tags'];
const setMismatch = cachedGets.sort().join(',') !== EXPECT_CACHED_GETS.sort().join(',');
```

**第二版**直接比 `path` 和 bust 清单，结果把「已清」判成「没清」：分支里的 `path` 是**剥掉 `/api` 前缀**的（`handleApi` 第一行 `replace(/^\/api/, '')`），而 bust 里写的是完整 URL。补上前缀还不够 —— 那是个隐含前提，得一起验：

```js
const stripApi = /const path = url\.pathname\.replace\(\/\^\\\/api\/, ''\)/.test(api);
```

哪天路由改成挂在根路径下，这条断言会自己报「前提已失效」，而不是静默永远通过。

注入验证两个方向：删掉 bust 里的 `/api/tags` → 红，报「这些接口缓存了但没清：/api/tags」；删掉 `pageCacheControl()` → 红，报「缓存接口集合变了：实际 [空]，预期 [/tags]」。

## 明说的没做

- **没迁目录**。七个不存在的组件是直接证据：这份结构是按 Hono + Drizzle + KV + vitest 那套写的，搬过来要先补齐它们。
- **`/api/archive` 不加缓存**。冷路径，加了是给一条几乎不跑的路径加复杂度。
- **`/api/posts` 不加缓存**。`?tag=&cat=&q=` 组合无穷，`?q=` 能被刷出无限条 key，清不干净 —— 和 `CB-04`「带 query 的页面根本不进缓存」是同一条理由。
- **没重测首屏**。这一轮的改动没部署，`check-live` 那四条仍然是红的。

## 复现条件

- 环境：本机 Node 20+，无网络依赖
- 触发：`node scripts/test-auth-policy.mjs` / `node scripts/test-cache-bust.mjs`
- 期望：`19/19` 与 `11/11`；实际：一致

## 断言代码

```bash
node scripts/test-auth-policy.mjs    # AP-18 扫描覆盖 / AP-19 非产品目录不可被 import
node scripts/test-cache-bust.mjs     # CB-11 带缓存的接口必须进 bust
```
