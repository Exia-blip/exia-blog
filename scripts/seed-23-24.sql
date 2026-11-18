-- 由 scripts/seed-23-24.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('related-posts', '相关推荐上线那天，排序逻辑根本没跑：post.tags 晚赋值 16 行', '## 结论

相关推荐上线那天，线上跑的其实不是我写的排序逻辑。

代码里排得好好的「共同标签数 → 同栏目 → 时间新」，线上渲染出来永远是同一个栏目的三篇文章。我看了一眼页面，三张卡全是 `tools` 栏目——恰好是当前文章自己的栏目，恰好按时间从新到旧。这种「看起来差不多」的巧合最危险，因为它不会报错，也不会有人来告诉你。

根因是**赋值顺序**：`rankRelated(post, allCat)` 在第 1019 行被调用，而 `post.tags = tagNames` 在第 1035 行才执行。标签是在另一条 D1 查询里取出来的，`posts` 表本身没有 `tags` 列。调用发生的那一刻，`post.tags` 是 `undefined`，共同标签数恒等于 0，三级排序直接塌成两级——只剩「同栏目 + 时间新」。

| 状态 | 第一张卡 | 第二张卡 | 第三张卡 |
|---|---|---|---|
| 修复前 | 评论区防滥用（tools） | R2 图片链路（tools） | 实时预览渲染器（tools） |
| 修复后 | Worker 渲染 549→96（log，4 标签全中） | 编辑器自动保存（tools） | subrequest 限额（log） |

修复只是把一行赋值挪到调用之前，加了 5 行注释。真正费时间的是发现它——**单测 10 项全绿，线上体检 5 项全绿，两个绿灯同时指着错误的实现**。

这篇讲三件事：排序逻辑怎么设计、一条 SQL 怎么同时喂给上下篇和相关推荐、以及那个让所有测试都漏掉的赋值顺序坑。所有数字都来自 2026-11-18 当天对 `exia.de5.net` 的实测和真实 D1 查询。

## 一、先把排序规则定死，再写代码

相关推荐最容易做成一个黑箱：喂进去一篇文章，吐出来三篇，说不清为什么是这三篇。我的规则只有三条，优先级写死在注释里：

| 优先级 | 规则 | 理由 |
|---|---|---|
| 1 | 共同标签数多的在前 | 标签是作者手填的语义，比栏目细 |
| 2 | 标签数相同时，同栏目在前 | 栏目是粗分类，聊同一件事的优先 |
| 3 | 前两项都相同时，发布时间新的在前 | 纯兜底，打破平局 |

还有四道过滤，全在排序之前：排除自己、排除私密、排除隐藏、既不沾标签也不同栏目的候选直接丢掉。剩下这一条很重要——没有它，「相关」两个字就没有门槛，`limit=3` 会拿时间最近的三篇来凑数。

这个规则落成一个纯函数 `rankRelated(post, candidates, limit = 3)`，放在 `src/related.js`，41 行，不碰 D1、不碰环境绑定：

```js
const splitTags = (s) => (s ? String(s).split(''\u001f'').filter(Boolean) : []);
const stamp = (r) => String(r.published_at || r.created_at || '''');

export function rankRelated(post, candidates, limit = 3) {
  if (!post || !candidates || !candidates.length) return [];
  const mine = new Set(post.tags || []);
  const cat = post.category || '''';
  const scored = [];

  for (const r of candidates) {
    if (!r || r.slug === post.slug) continue;
    if (r.is_private || r.hidden) continue;
    const shared = splitTags(r.tag_str).reduce((n, t) => n + (mine.has(t) ? 1 : 0), 0);
    const sameCat = !!cat && r.category === cat;
    if (!shared && !sameCat) continue;
    scored.push({ r, shared, sameCat, time: stamp(r) });
  }

  scored.sort(
    (a, b) =>
      b.shared - a.shared ||
      Number(b.sameCat) - Number(a.sameCat) ||
      b.time.localeCompare(a.time)
  );
  return scored.slice(0, limit).map((x) => x.r);
}
```

几个刻意的选择：

- **`char(31)` 分隔标签，不用逗号。** 31 是 ASCII 的 US（unit separator），标签名里不可能出现，但标签名里允许有逗号。用逗号拼 `tag_str` 再 `split('','')`，遇到 `#c++` 这类标签就断了。
- **时间用字符串比较，不 `new Date()`。** D1 存的是 `YYYY-MM-DD HH:MM:SS`，字典序和时间序一致。`localeCompare` 避开时区解析差异——Worker 跑在 UTC，读者在别处，把时间当字符串比反而没有歧义。
- **候选行原样返回，不改结构。** 排序过程里塞进 `shared`/`sameCat` 的是新建的 `{ r, shared, ... }` 包装对象，出口 `.map((x) => x.r)` 把原始行吐回去。页面模板里上下篇要按查询返回的时间序渲染，不能被推荐排序改掉。

### 边界 case 都要有对应测试

规则定死之后，测试是按边界逐条写的，不是想到哪写到哪。10 项里真正值钱的不是「共同标签 2 篇排在 1 篇前面」这种主干路径，而是这些：

| 测试 | 防的是什么 |
|---|---|
| 标签与栏目都不沾的候选被排除 | 「相关」沦为「最近三篇」 |
| 排除当前文章自己 | 页面底部推荐自己，最常见的低级错误 |
| 排除私密与隐藏文章 | 预排期的文章 slug 被猜到后提前泄露 |
| 同栏目无标签也进候选 | 没打标签的老文章永远没推荐 |
| 空候选 / 无标签无栏目都不报错 | 页面 500 |
| 返回的候选行不被改写 | 上下篇的时间序被推荐排序带偏 |

`published_at` 为空时回退到 `created_at`，这件事在 `stamp()` 里一行处理。D1 里预排期文章的 `published_at` 是未来时间，但 `liveSql()` 在 SQL 层已经把它们挡在候选外，所以内存里看到的时间都可信。

## 二、为什么不为推荐单开一条 D1 查询

最直觉的做法：拿到当前文章，再发一条 SQL 查「有共同标签或同栏目的文章，按交集数排序，limit 3」。我没有这么做，因为文章页的 D1 连接已经用满了。

`servePostPage` 里有一组 `Promise.all`，四条查询并发发出：

```js
const [post, tagRes, seriesRes, catRes] = await Promise.all([
  /* 1. 文章本体 + 作者 */
  /* 2. 标签名 */
  /* 3. 同系列目录 */
  /* 4. 同栏目列表 + 推荐候选（一条查询两用） */
]);
```

加上评论那条，一共 5 条。D1 单库单线程，**单次调用最多 6 条连接**，代码里的注释写得很直接：

> D1 单库单线程、单次调用最多 6 条连接，这里 5 条查询刚好卡在线上，再加查询就得换成 `batch()` —— 别在这条路上继续加。

所以推荐候选是从第 4 条查询里「顺带」带出来的。那条 SQL 原本只服务上下篇，现在扩成并集：

```sql
SELECT p.slug, p.title, p.published_at, p.created_at, p.category,
       (SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt
        JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str
FROM posts p
WHERE p.is_private = 0 AND p.hidden = 0 AND ${liveSql(''p'')}
  AND (p.category = (SELECT category FROM posts WHERE slug = ?)
       OR EXISTS (
         SELECT 1 FROM post_tags a JOIN post_tags b ON a.tag_id = b.tag_id
         WHERE a.post_id = p.id
           AND b.post_id = (SELECT id FROM posts WHERE slug = ?)
       ))
ORDER BY COALESCE(NULLIF(p.published_at, ''''), created_at) ASC
```

三个点值得拆开：

**`GROUP_CONCAT(t.name, char(31))` 是相关子查询。** 它跟着主查询的每一行跑一次，把这篇文章的标签拼成一个字符串带出来。这样内存里才算得出交集，不用为每篇候选再发一条查标签的 SQL——那样 12 个候选就是 12 次往返。

**`EXISTS` 那一段是标签交集。** `post_tags a` 是候选文章的标签行，`post_tags b` 是当前文章的标签行，`a.tag_id = b.tag_id` 就是「至少共有一个标签」。数据库只负责判断「有没有交集」，不负责排序——排序交给 `rankRelated`，因为共同标签数要在内存里数。

**`ORDER BY` 保持时间升序。** 上下篇要按时间序渲染，不能打乱。所以这条查询的结果分两用：

```js
const allCat = bundle.same.map((r) => ({ ...r }));
const sameCat = post ? allCat.filter((r) => r.category === post.category) : [];
const related = rankRelated(post, allCat);
```

`sameCat` 喂上下篇（只留同栏目，顺序不动），`allCat` 喂推荐（含跨栏目同标签的，由 `rankRelated` 重排）。一份数据两用，D1 往返次数没增加。

我在真实 D1 上把这条 SQL 跑了一遍，当前文章 `worker-cron-friend-check`（标签 `cloudflare d1 workers cache`，栏目 `tools`）拿到 12 条 live 候选。完整结果：

| slug | 栏目 | 标签 | 与当前文章的共同标签数 |
|---|---|---|---|
| d1-no-such-table | log | cloudflare d1 debugging sqlite | 2 |
| oauth-device-flow | teardown | oauth http workers | 1 |
| wrangler-deploy-errors | log | cloudflare debugging workers | 2 |
| workers-io-different-request | log | cloudflare workers javascript | 2 |
| workers-subrequest-limit | log | cloudflare debugging workers javascript | 2 |
| worker-cron-friend-check | tools | cloudflare d1 workers cache | 自己，排除 |
| editor-autosave | tools | cloudflare d1 javascript | 2 |
| editor-markdown-xss | tools | javascript markdown xss | 0 |
| r2-image-pipeline | tools | cloudflare xss r2 | 1 |
| comment-anti-spam | tools | cloudflare security turnstile | 1 |
| cls-empty-slots | log | workers css performance | 1 |
| worker-render-549-to-96 | log | cloudflare d1 workers cache | **4** |

`worker-render-549-to-96` 标签四个全中，但栏目是 `log`——修复前它一条都进不来，因为排序里压根没算标签。

### 为什么标签要在内存里数，不交给 SQL 排序

一个自然的追问：既然 SQL 已经用 `EXISTS` 判断了有没有交集，为什么不让 SQL 直接数出交集数、直接 `ORDER BY`？

两条理由。一是 D1 的 SQL 方言里没有现成的数组交集函数，`GROUP_CONCAT` 出来的是一个字符串，要在 SQL 里数交集得再套一层 `json_each` 或递归 CTE，可读性会掉到没法维护。二是排序规则会变——今天三级，明天可能加「同系列优先」，改动落在 41 行的纯函数里，测试跑一遍就知道；改动落在 SQL 里，得同时改单测 fixtures 和线上探针。

把 DB 当数据源、把规则当纯函数，这个分界在别的功能上也成立。数据库负责「筛出可能相关的」，内存负责「决定相关的怎么排」。前者的成本是往返次数，后者的成本是 CPU——这页 CPU 只花几毫秒，往内存里放 12 条候选完全不是问题。

## 三、单测 10 项全绿，线上排序却是错的

`scripts/test-related.mjs` 写了 10 项，覆盖规则里的每一条：

```text
相关推荐排序
  ok  共同标签 2 篇排在 1 篇前面
  ok  标签数相同时同栏目优先
  ok  标签与栏目都不沾的候选被排除
  ok  排除当前文章自己
  ok  排除私密与隐藏文章
  ok  最多取 limit 篇（默认 3）
  ok  同栏目无标签也进候选（栏目兜底）
  ok  标签数/栏目都相同时按发布时间新→旧
  ok  空候选 / 无标签无栏目都不报错
  ok  返回的候选行不被改写

PASS  相关推荐排序全部通过
```

测试全过，函数没问题。问题在调用方。

我把修复前的 `src/index.js` 摘录出来，看这两行的位置：

```js
// 1012 行
const post = bundle.post ? { ...bundle.post } : null;
const tagNames = bundle.tags;
// ...
// 1019 行
const related = rankRelated(post, allCat);

// ... 中间隔了 16 行权限判断、404 判断、模板检查 ...

// 1035 行
const cmtRows = cmtRes.results;
post.tags = tagNames;   // ← 太晚了
post.comments = cmtRows.length;
```

`posts` 表没有 `tags` 列（我查过 `schema.sql`，标签存在独立的 `tags` 和 `post_tags` 表），标签是第 2 条 D1 查询单独取出来的。所以 `bundle.post` 身上没有 `tags` 属性，浅拷贝出来的 `post` 也没有。

`rankRelated` 里 `const mine = new Set(post.tags || [])`——传进来的是 `undefined`，`mine` 就是空 Set。每一篇候选的 `shared` 都算成 0，三级排序的第一级和第二级永远打平，只剩 `b.time.localeCompare(a.time)` 在起作用。结果就是：**当前栏目里时间最新的三篇**。

这正是线上看到的画面。三张卡全是 `tools` 栏目，按发布时间倒序。而 `worker-render-549-to-96` 有 4 个共同标签、栏目是 `log`，本该排第一，却因为标签数恒为 0 被彻底埋掉。

### 我是怎么发现的：从标签列表看出去

起点不是读代码，是抓线上 HTML。我用 `curl` 拉了几篇文章页，把 `/tag/...` 的锚文本全抓出来，想验证标签交集是不是真的生效：

```bash
for slug in worker-cron-friend-check comment-anti-spam r2-image-pipeline; do
  curl -s "https://exia.de5.net/p/$slug" | grep -oE ''/tag/[^"]+"[^>]*>#[^<]+''
done
```

抓出来的标签列表里，每篇的标签都出现**两遍**——页面顶部的元信息区和底部的文章标签栏各渲染一次。这个重复本身不是 bug，但它让我意识到一件事：页面上能看到的标签，和 `post.tags` 这个 JS 变量是不是一回事，还得往回追。

于是做了第二件事：拿真实 D1 候选，在本地直接跑 `rankRelated`，看它应该排出什么：

```js
const rows = /* 上一节那条 SQL 的 D1 返回 */;
const post = { slug: ''worker-cron-friend-check'',
               category: ''tools'',
               tags: [''cloudflare'', ''d1'', ''workers'', ''cache''] };
for (const x of rankRelated(post, rows)) console.log(x.slug);
```

输出是 `worker-render-549-to-96` / `editor-autosave` / `workers-subrequest-limit`——和线上三张卡**一张都不重合**。到这一步可以确定：不是排序规则写错，是排序没拿到它该拿的输入。

再回到 `servePostPage`，把 `rankRelated` 那一行的上下文和 `post.tags` 的赋值位置对着看，16 行的距离一眼就出来了。

**为什么测试没抓到？** 因为纯函数单测只验证「传进去什么，吐出来什么」。它不会检查调用方有没有在正确的时间、用正确的参数调用。这种 bug 在纯函数里不存在，只存在于接线处。

### 一个反过来被验证的设计

这次能快速定位，是因为 `rankRelated` 是纯函数。如果排序逻辑直接写在 `servePostPage` 里、直接读 `post.tags`，我得在一页几百行的渲染代码里找「标签是从哪来的」，而不是在本地跑 5 行 JS 就能复刻预期结果。

纯函数的价值不在于「好测试」这句口号，在于**它能被单独拎出来跑**。线上结果和本地复刻不一致，这个差异本身就是最强的定位信号——错的一定是接线，不是函数。

## 四、修一行，补一条探针

修复本身只有一处挪动：

```js
const post = bundle.post ? { ...bundle.post } : null;
const tagNames = bundle.tags;
/* tags 必须在 rankRelated 之前挂上。posts 表没有 tags 列，它是独立查询出来的；
   rankRelated 靠 post.tags 算共同标签数，晚一步赋值就全是 0，
   排序退化成「同栏目 + 时间新」，跨栏目同标签的文章一条都进不来。 */
if (post) post.tags = tagNames;
// ...
const related = rankRelated(post, allCat);
```

然后把 1035 行那句 `post.tags = tagNames` 删掉——不能留两处，否则下次有人改其中一处，又是一个坑。

光改代码不够，得让线上体检能抓住这类回归。原来的探针只验「有没有区块、几张卡、链接格式、不含自己」，全是结构检查，排序对不对根本没测。补一条：

```js
// worker-render-549-to-96 是 log 栏目，与本篇 4 个标签全中；
// 若 post.tags 没在 rankRelated 之前赋值，共同标签数恒为 0，跨栏目这篇进不来。
ok(''跨栏目同标签文章排第一（标签交集真生效）'',
  relHrefs[0] === ''/p/worker-render-549-to-96'', `实际第一张 ${relHrefs[0]}`);
```

这条探针的厉害之处在于它是**行为断言**，不是结构断言。它不关心 HTML 里有没有 `class="rel"`，只问一件事：跨栏目同标签的那篇排第一了吗？赋值顺序错了就必挂。

修复上线前后，同一篇文章的线上实测：

| 检查项 | 修复前 | 修复后 |
|---|---|---|
| 卡片数 | 3 | 3 |
| 第一张卡 | 评论区防滥用（tools） | Worker 渲染 549→96（log） |
| 跨栏目同标签文章进前三 | 否 | 是 |
| 单测 | 10/10 | 10/10 |
| 线上体检 | 52/52 | 53/53 |

注意前两行——卡片数和以前一模一样。这就是这个 bug 藏了这么久的原因：**从外面看，功能完全正常**。

我用三篇文章交叉验证过修复后的排序，每篇都符合规则预期：

| 当前文章 | 标签 | 第一张推荐 | 为什么是它 |
|---|---|---|---|
| worker-cron-friend-check | cloudflare d1 workers cache | Worker 渲染 549→96 | 4 个标签全中，跨栏目 |
| editor-markdown-xss | javascript markdown xss | R2 图片链路 | 共同标签 `xss` |
| worker-render-549-to-96 | cloudflare d1 workers cache | 友链存活检测 | 共同标签最多，同栏目 tools |

第二篇尤其能说明问题：`editor-markdown-xss` 是 `tools` 栏目，修复前推的三篇全是 tools；修复后第一张仍是 tools 的 R2 图片链路——但这次是因为它真的共享 `xss` 标签，不是因为栏目碰巧相同。第二张变成 `editor-autosave`（共享 `javascript`），第三张是 `sticky-toc`（共享 `javascript`）——三张卡的共同标签都是 1，同栏目优先生效，所以 tools 栏目在前。

这个结果用修复前的代码**永远得不到**，因为它连 `post.tags` 都拿不到，谈不上数交集。

## 五、空结果不渲染，别留空壳

`renderRelated` 的第一行是：

```js
function renderRelated(post, list) {
  if (!list || !list.length) return '''';
  // ...
}
```

没有候选就整块不输出。这条看着简单，但很容易被忽略——有人为了让页面「看起来完整」，会渲染一个空的 `<section>` 加一句「暂无相关文章」。对一个 31 篇文章的小站，没标签又没同栏目的文章是存在的（`post-brfy5` 就是），空壳会占掉一大块版面。

渲染成三列卡片，移动端收成一列：

```css
.post-related .rel-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
}
@media (max-width: 720px) {
  .post-related .rel-grid { grid-template-columns: 1fr; }
}
```

位置上放在正文之后、上下篇之前——先给横向的延伸阅读，再给纵向的时间序列。卡片上的链接带 `rel="nofollow"`：相关推荐是站内跳转，但不想让爬虫把这里当成主要的权重传递路径。

这里有个取舍值得说清楚：**上下篇已经存在了，为什么还要相关推荐？** 因为两者回答的问题不一样。上下篇是「这个系列的前后文」，按时间轴走，同栏目才有；相关推荐是「还能看什么」，按语义相似度走，允许跨栏目。对一篇有系列的文章，页面底部同时出现两块——系列目录在最上面，相关推荐在中间，上下篇在下面——读者按需要挑。

`worker-cron-friend-check` 不是系列文章，但仍有上下篇：同栏目的 `editor-autosave` 和 `editor-markdown-xss`。线上体检里有一条专门验这两块共存：

```js
ok(''有标签文章渲染相关推荐区块'', withTags.body.includes(''class="post-related"''));
ok(''相关推荐链接格式正确'', relHrefs.length === cards.length && ...);
```

上下篇那块还有个细节：只有一侧有文章时收成单列，不留半个虚线空框——「看起来像加载失败」比「少一个元素」更糟。相关推荐没有这个问题，因为它要么三张要么不渲染。

### 缓存层带来的一个隐性约束

文章页有实例内 LRU（`src/postcache.js`），缓存的是数据库行，不是 HTML。TTL 45 秒，上限 40 条，只缓存公开文章：

```js
if (post && !post.is_private) postCacheSet(slug, b);
```

`b` 是 `{ post, tags, series, same }`——标签在 `b.tags`，文章本体在 `b.post`。两条数据是**并列**存的，不是 `b.post.tags`。这正是 bug 的温床：浅拷贝 `post` 时不会带上 tags，因为从数据库行层面它们本来就是分开的。

缓存还有个副作用：热路径下这页根本不走 D1，`bundle` 直接来自 LRU。也就是说候选集 `allCat` 可能是 45 秒前的快照。对推荐来说这完全可以接受——没人在意推荐列表是不是秒级新鲜；但意味着**改了标签之后，推荐结果最多滞后 45 秒**。这个延迟和缓存的其他部分一致，不需要特殊处理。

真正不能缓存的是 HTML 本身：里面有 CSP nonce、当前用户名、编辑入口，存下来必然串号。所以每次请求都会重新执行 `rankRelated`——排序成本是纯 CPU，几毫秒，换来的是每个访客看到正确的 nonce 和登录态。

标题和摘要都过 `esc()`：

```js
return `<a class="rel" href="/p/${encodeURIComponent(p.slug)}" rel="nofollow">
  <span class="rel-t">${esc(p.title)}</span>
  ${meta ? `<span class="rel-m">${esc(meta)}</span>` : ''''}
</a>`;
```

## 六、这次真正学到的

写完代码、测试全绿、上线跑通，然后发现功能从没真正工作过——这种事比「上线就报错」麻烦得多。报错会有人喊，静默降级没人喊。

三条经验，按重要性排：

**第一，纯函数的单测覆盖不了接线。** `rankRelated` 的 10 项测试全部通过，但它测的是「给定正确的 `post.tags`，排序对不对」。调用方有没有给正确的 `post.tags`，是另一回事。补这类洞只能靠行为级断言——线上探针直接问业务问题，不问实现细节。

**第二，「看起来差不多」的输出最可疑。** 修复前后都是三张卡、格式一样、不含自己。任何结构检查都发现不了差别。发现问题的唯一线索是「三张卡全是同一个栏目」——这是一个统计特征，不是一个错误状态。以后做推荐类功能，我会先看结果的**分布**，不只看结果的存在。

**第三，D1 连接数限制会倒逼出好的设计。** 如果不能单开查询，就必须把候选从已有查询里带出来，就必须用 `GROUP_CONCAT` 一次带标签，就必须把排序做成纯函数。这些限制看起来是麻烦，到头来反而让代码更简单——一条 SQL、一个纯函数、5 行探针。

### 空结果为什么必须不渲染

`post-brfy5` 这篇文章没有标签，也没有同栏目文章，`rankRelated` 返回空数组。页面上的处理是整块不输出，不是渲染一个空壳。

这件事看着小，但对一个小站很关键。31 篇文章里，标签覆盖率不是 100%——早期文章可能没打标签，有些独立文章不属于任何栏目。如果空结果也渲染，这些文章底部就多一个「相关文章」标题，下面空空荡荡，读者会以为页面加载失败。

线上体检也覆盖了这条：

```js
ok(''无标签无栏目文章不渲染相关推荐'', !noTags.body.includes(''class="post-related"''));
```

这条断言只看区块在不在，不看卡片数。因为它防的是「回归时有人把空态渲染打开」——那种改动不会报错，只会让页面变丑。

### 这次改动的范围

把收尾的 diff 摆出来，能看清一个静默 bug 的修复成本有多低：

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/index.js` | `post.tags` 赋值前移 + 注释根因 | +6 / −1 |
| `scripts/check-live.mjs` | 跨栏目同标签排第一的探针 | +5 |
| `content/23-related-posts.md` | 这篇记录 | 新增 |

代码改动 11 行，其中 6 行是注释。真正防回归的是那 5 行探针——它把「标签交集真的生效了」变成一个可观察的线上事实，而不是一句写在注释里的假设。

## 怎么自己验一遍

三步，从离线到线上，每步都能独立跑。

```bash
# 1) 纯函数单测：验证排序规则本身（10 项）
node scripts/test-related.mjs

# 2) 用真实 D1 数据复刻候选集，看 rankRelated 会排出什么
npx wrangler d1 execute blog-db --remote --json --command \
  "SELECT p.slug, p.category, p.published_at, p.created_at,
          (SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt
           JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id) AS tag_str
   FROM posts p WHERE p.is_private=0 AND p.hidden=0
     AND (p.category=(SELECT category FROM posts WHERE slug=''worker-cron-friend-check'')
          OR EXISTS (SELECT 1 FROM post_tags a JOIN post_tags b ON a.tag_id=b.tag_id
                     WHERE a.post_id=p.id
                       AND b.post_id=(SELECT id FROM posts WHERE slug=''worker-cron-friend-check'')))
   ORDER BY COALESCE(NULLIF(p.published_at,''''),created_at) ASC"

# 3) 线上体检：53 项，其中「跨栏目同标签文章排第一」直接验赋值顺序
npm run check:live
```

第 2 步单独拿出来说：它不需要改代码，也不需要部署，直接在命令行里能看到 12 条候选和每条的 `tag_str`。如果某天排序又不对了，先跑这条——能一眼分清是候选查询错了，还是内存排序错了，还是赋值顺序又错了。

第 3 步里那条新增探针，是这个 bug 留下的唯一长期保险。以后谁再动 `post.tags` 的赋值时机，它会当场把人拦下来。

### 一个小提醒：别把探针写成实现细节

补探针时最容易犯的错，是断言 HTML 里某个类名存在——这类断言在重构时全挂，却什么都保不住。

对比这两条：

```js
// 结构断言：改动类名就挂，排序错了照样过
ok(''有相关推荐区块'', body.includes(''class="post-related"''));

// 行为断言：只有排序真按标签交集走才会过
ok(''跨栏目同标签排第一'', relHrefs[0] === ''/p/worker-render-549-to-96'');
```

原来的探针 5 项里有 4 项是结构断言，只有「不含当前文章」算半个行为断言。这次补的第 6 项才是第一条真正验证业务语义的。断言写什么，取决于你想让测试在什么时候响——**测试响的时机不对，比没有测试更浪费时间**，因为会养出「测试全绿就没事」的习惯。

这也是为什么这篇文章值得单独写一篇：功能实现只花了 41 行纯函数，让它真正工作的是 5 行线上探针，而发现它需要的是「线上结果和本地复刻对不上」这一个信号。三件事里没有一件写在功能代码里。
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>相关推荐上线那天，线上跑的其实不是我写的排序逻辑。</p>
<p>代码里排得好好的「共同标签数 → 同栏目 → 时间新」，线上渲染出来永远是同一个栏目的三篇文章。我看了一眼页面，三张卡全是 <code>tools</code> 栏目——恰好是当前文章自己的栏目，恰好按时间从新到旧。这种「看起来差不多」的巧合最危险，因为它不会报错，也不会有人来告诉你。</p>
<p>根因是<strong>赋值顺序</strong>：<code>rankRelated(post, allCat)</code> 在第 1019 行被调用，而 <code>post.tags = tagNames</code> 在第 1035 行才执行。标签是在另一条 D1 查询里取出来的，<code>posts</code> 表本身没有 <code>tags</code> 列。调用发生的那一刻，<code>post.tags</code> 是 <code>undefined</code>，共同标签数恒等于 0，三级排序直接塌成两级——只剩「同栏目 + 时间新」。</p>
<div class="table-wrap"><table><thead><tr><th>状态</th><th>第一张卡</th><th>第二张卡</th><th>第三张卡</th></tr></thead><tbody><tr><td>修复前</td><td>评论区防滥用（tools）</td><td>R2 图片链路（tools）</td><td>实时预览渲染器（tools）</td></tr><tr><td>修复后</td><td>Worker 渲染 549→96（log，4 标签全中）</td><td>编辑器自动保存（tools）</td><td>subrequest 限额（log）</td></tr></tbody></table></div>
<p>修复只是把一行赋值挪到调用之前，加了 5 行注释。真正费时间的是发现它——<strong>单测 10 项全绿，线上体检 5 项全绿，两个绿灯同时指着错误的实现</strong>。</p>
<p>这篇讲三件事：排序逻辑怎么设计、一条 SQL 怎么同时喂给上下篇和相关推荐、以及那个让所有测试都漏掉的赋值顺序坑。所有数字都来自 2026-11-18 当天对 <code>exia.de5.net</code> 的实测和真实 D1 查询。</p>
<h2 id="一-先把排序规则定死-再写代码"><a class="h-anchor" href="#一-先把排序规则定死-再写代码">#</a>一、先把排序规则定死，再写代码</h2>
<p>相关推荐最容易做成一个黑箱：喂进去一篇文章，吐出来三篇，说不清为什么是这三篇。我的规则只有三条，优先级写死在注释里：</p>
<div class="table-wrap"><table><thead><tr><th>优先级</th><th>规则</th><th>理由</th></tr></thead><tbody><tr><td>1</td><td>共同标签数多的在前</td><td>标签是作者手填的语义，比栏目细</td></tr><tr><td>2</td><td>标签数相同时，同栏目在前</td><td>栏目是粗分类，聊同一件事的优先</td></tr><tr><td>3</td><td>前两项都相同时，发布时间新的在前</td><td>纯兜底，打破平局</td></tr></tbody></table></div>
<p>还有四道过滤，全在排序之前：排除自己、排除私密、排除隐藏、既不沾标签也不同栏目的候选直接丢掉。剩下这一条很重要——没有它，「相关」两个字就没有门槛，<code>limit=3</code> 会拿时间最近的三篇来凑数。</p>
<p>这个规则落成一个纯函数 <code>rankRelated(post, candidates, limit = 3)</code>，放在 <code>src/related.js</code>，41 行，不碰 D1、不碰环境绑定：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span><span class="code-ln">26 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
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
23
24
25
26</span><code class="language-js"><span class="tok-k">const</span> splitTags = (s) =&gt; (s ? <span class="tok-f">String</span>(s).<span class="tok-f">split</span>(<span class="tok-s">&#39;\u001f&#39;</span>).<span class="tok-f">filter</span>(Boolean) : []);
<span class="tok-k">const</span> stamp = (r) =&gt; <span class="tok-f">String</span>(r.published_at || r.created_at || <span class="tok-s">&#39;&#39;</span>);

<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">rankRelated</span>(post, candidates, limit = <span class="tok-n">3</span>) {
  <span class="tok-k">if</span> (!post || !candidates || !candidates.length) <span class="tok-k">return</span> [];
  <span class="tok-k">const</span> mine = <span class="tok-k">new</span> <span class="tok-f">Set</span>(post.tags || []);
  <span class="tok-k">const</span> cat = post.category || <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">const</span> scored = [];

  <span class="tok-k">for</span> (<span class="tok-k">const</span> r <span class="tok-k">of</span> candidates) {
    <span class="tok-k">if</span> (!r || r.slug === post.slug) <span class="tok-k">continue</span>;
    <span class="tok-k">if</span> (r.is_private || r.hidden) <span class="tok-k">continue</span>;
    <span class="tok-k">const</span> shared = <span class="tok-f">splitTags</span>(r.tag_str).<span class="tok-f">reduce</span>((n, t) =&gt; n + (mine.<span class="tok-f">has</span>(t) ? <span class="tok-n">1</span> : <span class="tok-n">0</span>), <span class="tok-n">0</span>);
    <span class="tok-k">const</span> sameCat = !!cat &amp;&amp; r.category === cat;
    <span class="tok-k">if</span> (!shared &amp;&amp; !sameCat) <span class="tok-k">continue</span>;
    scored.<span class="tok-f">push</span>({ r, shared, sameCat, time: <span class="tok-f">stamp</span>(r) });
  }

  scored.<span class="tok-f">sort</span>(
    (a, b) =&gt;
      b.shared - a.shared ||
      <span class="tok-f">Number</span>(b.sameCat) - <span class="tok-f">Number</span>(a.sameCat) ||
      b.time.<span class="tok-f">localeCompare</span>(a.time)
  );
  <span class="tok-k">return</span> scored.<span class="tok-f">slice</span>(<span class="tok-n">0</span>, limit).<span class="tok-f">map</span>((x) =&gt; x.r);
}</code></pre></div>
<p>几个刻意的选择：</p>
<ul><li><strong><code>char(31)</code> 分隔标签，不用逗号。</strong> 31 是 ASCII 的 US（unit separator），标签名里不可能出现，但标签名里允许有逗号。用逗号拼 <code>tag_str</code> 再 <code>split(&#39;,&#39;)</code>，遇到 <code>#c++</code> 这类标签就断了。</li><li><strong>时间用字符串比较，不 <code>new Date()</code>。</strong> D1 存的是 <code>YYYY-MM-DD HH:MM:SS</code>，字典序和时间序一致。<code>localeCompare</code> 避开时区解析差异——Worker 跑在 UTC，读者在别处，把时间当字符串比反而没有歧义。</li><li><strong>候选行原样返回，不改结构。</strong> 排序过程里塞进 <code>shared</code>/<code>sameCat</code> 的是新建的 <code>{ r, shared, ... }</code> 包装对象，出口 <code>.map((x) =&gt; x.r)</code> 把原始行吐回去。页面模板里上下篇要按查询返回的时间序渲染，不能被推荐排序改掉。</li></ul>
<h3 id="边界-case-都要有对应测试"><a class="h-anchor" href="#边界-case-都要有对应测试">#</a>边界 case 都要有对应测试</h3>
<p>规则定死之后，测试是按边界逐条写的，不是想到哪写到哪。10 项里真正值钱的不是「共同标签 2 篇排在 1 篇前面」这种主干路径，而是这些：</p>
<div class="table-wrap"><table><thead><tr><th>测试</th><th>防的是什么</th></tr></thead><tbody><tr><td>标签与栏目都不沾的候选被排除</td><td>「相关」沦为「最近三篇」</td></tr><tr><td>排除当前文章自己</td><td>页面底部推荐自己，最常见的低级错误</td></tr><tr><td>排除私密与隐藏文章</td><td>预排期的文章 slug 被猜到后提前泄露</td></tr><tr><td>同栏目无标签也进候选</td><td>没打标签的老文章永远没推荐</td></tr><tr><td>空候选 / 无标签无栏目都不报错</td><td>页面 500</td></tr><tr><td>返回的候选行不被改写</td><td>上下篇的时间序被推荐排序带偏</td></tr></tbody></table></div>
<p><code>published_at</code> 为空时回退到 <code>created_at</code>，这件事在 <code>stamp()</code> 里一行处理。D1 里预排期文章的 <code>published_at</code> 是未来时间，但 <code>liveSql()</code> 在 SQL 层已经把它们挡在候选外，所以内存里看到的时间都可信。</p>
<h2 id="二-为什么不为推荐单开一条-d1-查询"><a class="h-anchor" href="#二-为什么不为推荐单开一条-d1-查询">#</a>二、为什么不为推荐单开一条 D1 查询</h2>
<p>最直觉的做法：拿到当前文章，再发一条 SQL 查「有共同标签或同栏目的文章，按交集数排序，limit 3」。我没有这么做，因为文章页的 D1 连接已经用满了。</p>
<p><code>servePostPage</code> 里有一组 <code>Promise.all</code>，四条查询并发发出：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> [post, tagRes, seriesRes, catRes] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([
  <span class="tok-c">/* 1. 文章本体 + 作者 */</span>
  <span class="tok-c">/* 2. 标签名 */</span>
  <span class="tok-c">/* 3. 同系列目录 */</span>
  <span class="tok-c">/* 4. 同栏目列表 + 推荐候选（一条查询两用） */</span>
]);</code></pre></div>
<p>加上评论那条，一共 5 条。D1 单库单线程，<strong>单次调用最多 6 条连接</strong>，代码里的注释写得很直接：</p>
<blockquote><p>D1 单库单线程、单次调用最多 6 条连接，这里 5 条查询刚好卡在线上，再加查询就得换成 <code>batch()</code> —— 别在这条路上继续加。</p></blockquote>
<p>所以推荐候选是从第 4 条查询里「顺带」带出来的。那条 SQL 原本只服务上下篇，现在扩成并集：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">SELECT p.slug, p.title, p.published_at, p.created_at, p.category,
       (SELECT <span class="tok-f">GROUP_CONCAT</span>(t.name, <span class="tok-f">char</span>(<span class="tok-n">31</span>)) FROM post_tags pt
        JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str
FROM posts p
WHERE p.is_private = <span class="tok-n">0</span> AND p.hidden = <span class="tok-n">0</span> AND ${<span class="tok-f">liveSql</span>(<span class="tok-s">&#39;p&#39;</span>)}
  AND (p.category = (SELECT category FROM posts WHERE slug = ?)
       OR EXISTS (
         SELECT <span class="tok-n">1</span> FROM post_tags a JOIN post_tags b ON a.tag_id = b.tag_id
         WHERE a.post_id = p.id
           AND b.post_id = (SELECT id FROM posts WHERE slug = ?)
       ))
ORDER BY <span class="tok-f">COALESCE</span>(<span class="tok-f">NULLIF</span>(p.published_at, <span class="tok-s">&#39;&#39;</span>), created_at) ASC</code></pre></div>
<p>三个点值得拆开：</p>
<p><strong><code>GROUP_CONCAT(t.name, char(31))</code> 是相关子查询。</strong> 它跟着主查询的每一行跑一次，把这篇文章的标签拼成一个字符串带出来。这样内存里才算得出交集，不用为每篇候选再发一条查标签的 SQL——那样 12 个候选就是 12 次往返。</p>
<p><strong><code>EXISTS</code> 那一段是标签交集。</strong> <code>post_tags a</code> 是候选文章的标签行，<code>post_tags b</code> 是当前文章的标签行，<code>a.tag_id = b.tag_id</code> 就是「至少共有一个标签」。数据库只负责判断「有没有交集」，不负责排序——排序交给 <code>rankRelated</code>，因为共同标签数要在内存里数。</p>
<p><strong><code>ORDER BY</code> 保持时间升序。</strong> 上下篇要按时间序渲染，不能打乱。所以这条查询的结果分两用：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> allCat = bundle.same.<span class="tok-f">map</span>((r) =&gt; ({ ...r }));
<span class="tok-k">const</span> sameCat = post ? allCat.<span class="tok-f">filter</span>((r) =&gt; r.category === post.category) : [];
<span class="tok-k">const</span> related = <span class="tok-f">rankRelated</span>(post, allCat);</code></pre></div>
<p><code>sameCat</code> 喂上下篇（只留同栏目，顺序不动），<code>allCat</code> 喂推荐（含跨栏目同标签的，由 <code>rankRelated</code> 重排）。一份数据两用，D1 往返次数没增加。</p>
<p>我在真实 D1 上把这条 SQL 跑了一遍，当前文章 <code>worker-cron-friend-check</code>（标签 <code>cloudflare d1 workers cache</code>，栏目 <code>tools</code>）拿到 12 条 live 候选。完整结果：</p>
<div class="table-wrap"><table><thead><tr><th>slug</th><th>栏目</th><th>标签</th><th>与当前文章的共同标签数</th></tr></thead><tbody><tr><td>d1-no-such-table</td><td>log</td><td>cloudflare d1 debugging sqlite</td><td>2</td></tr><tr><td>oauth-device-flow</td><td>teardown</td><td>oauth http workers</td><td>1</td></tr><tr><td>wrangler-deploy-errors</td><td>log</td><td>cloudflare debugging workers</td><td>2</td></tr><tr><td>workers-io-different-request</td><td>log</td><td>cloudflare workers javascript</td><td>2</td></tr><tr><td>workers-subrequest-limit</td><td>log</td><td>cloudflare debugging workers javascript</td><td>2</td></tr><tr><td>worker-cron-friend-check</td><td>tools</td><td>cloudflare d1 workers cache</td><td>自己，排除</td></tr><tr><td>editor-autosave</td><td>tools</td><td>cloudflare d1 javascript</td><td>2</td></tr><tr><td>editor-markdown-xss</td><td>tools</td><td>javascript markdown xss</td><td>0</td></tr><tr><td>r2-image-pipeline</td><td>tools</td><td>cloudflare xss r2</td><td>1</td></tr><tr><td>comment-anti-spam</td><td>tools</td><td>cloudflare security turnstile</td><td>1</td></tr><tr><td>cls-empty-slots</td><td>log</td><td>workers css performance</td><td>1</td></tr><tr><td>worker-render-549-to-96</td><td>log</td><td>cloudflare d1 workers cache</td><td><strong>4</strong></td></tr></tbody></table></div>
<p><code>worker-render-549-to-96</code> 标签四个全中，但栏目是 <code>log</code>——修复前它一条都进不来，因为排序里压根没算标签。</p>
<h3 id="为什么标签要在内存里数-不交给-sql-排序"><a class="h-anchor" href="#为什么标签要在内存里数-不交给-sql-排序">#</a>为什么标签要在内存里数，不交给 SQL 排序</h3>
<p>一个自然的追问：既然 SQL 已经用 <code>EXISTS</code> 判断了有没有交集，为什么不让 SQL 直接数出交集数、直接 <code>ORDER BY</code>？</p>
<p>两条理由。一是 D1 的 SQL 方言里没有现成的数组交集函数，<code>GROUP_CONCAT</code> 出来的是一个字符串，要在 SQL 里数交集得再套一层 <code>json_each</code> 或递归 CTE，可读性会掉到没法维护。二是排序规则会变——今天三级，明天可能加「同系列优先」，改动落在 41 行的纯函数里，测试跑一遍就知道；改动落在 SQL 里，得同时改单测 fixtures 和线上探针。</p>
<p>把 DB 当数据源、把规则当纯函数，这个分界在别的功能上也成立。数据库负责「筛出可能相关的」，内存负责「决定相关的怎么排」。前者的成本是往返次数，后者的成本是 CPU——这页 CPU 只花几毫秒，往内存里放 12 条候选完全不是问题。</p>
<h2 id="三-单测-10-项全绿-线上排序却是错的"><a class="h-anchor" href="#三-单测-10-项全绿-线上排序却是错的">#</a>三、单测 10 项全绿，线上排序却是错的</h2>
<p><code>scripts/test-related.mjs</code> 写了 10 项，覆盖规则里的每一条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">相关推荐排序
  ok  共同标签 2 篇排在 1 篇前面
  ok  标签数相同时同栏目优先
  ok  标签与栏目都不沾的候选被排除
  ok  排除当前文章自己
  ok  排除私密与隐藏文章
  ok  最多取 limit 篇（默认 3）
  ok  同栏目无标签也进候选（栏目兜底）
  ok  标签数/栏目都相同时按发布时间新→旧
  ok  空候选 / 无标签无栏目都不报错
  ok  返回的候选行不被改写

PASS  相关推荐排序全部通过</code></pre></div>
<p>测试全过，函数没问题。问题在调用方。</p>
<p>我把修复前的 <code>src/index.js</code> 摘录出来，看这两行的位置：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 1012 行</span>
<span class="tok-k">const</span> post = bundle.post ? { ...bundle.post } : <span class="tok-k">null</span>;
<span class="tok-k">const</span> tagNames = bundle.tags;
<span class="tok-c">// ...</span>
<span class="tok-c">// 1019 行</span>
<span class="tok-k">const</span> related = <span class="tok-f">rankRelated</span>(post, allCat);

<span class="tok-c">// ... 中间隔了 16 行权限判断、404 判断、模板检查 ...</span>

<span class="tok-c">// 1035 行</span>
<span class="tok-k">const</span> cmtRows = cmtRes.results;
post.tags = tagNames;   <span class="tok-c">// ← 太晚了</span>
post.comments = cmtRows.length;</code></pre></div>
<p><code>posts</code> 表没有 <code>tags</code> 列（我查过 <code>schema.sql</code>，标签存在独立的 <code>tags</code> 和 <code>post_tags</code> 表），标签是第 2 条 D1 查询单独取出来的。所以 <code>bundle.post</code> 身上没有 <code>tags</code> 属性，浅拷贝出来的 <code>post</code> 也没有。</p>
<p><code>rankRelated</code> 里 <code>const mine = new Set(post.tags || [])</code>——传进来的是 <code>undefined</code>，<code>mine</code> 就是空 Set。每一篇候选的 <code>shared</code> 都算成 0，三级排序的第一级和第二级永远打平，只剩 <code>b.time.localeCompare(a.time)</code> 在起作用。结果就是：<strong>当前栏目里时间最新的三篇</strong>。</p>
<p>这正是线上看到的画面。三张卡全是 <code>tools</code> 栏目，按发布时间倒序。而 <code>worker-render-549-to-96</code> 有 4 个共同标签、栏目是 <code>log</code>，本该排第一，却因为标签数恒为 0 被彻底埋掉。</p>
<h3 id="我是怎么发现的-从标签列表看出去"><a class="h-anchor" href="#我是怎么发现的-从标签列表看出去">#</a>我是怎么发现的：从标签列表看出去</h3>
<p>起点不是读代码，是抓线上 HTML。我用 <code>curl</code> 拉了几篇文章页，把 <code>/tag/...</code> 的锚文本全抓出来，想验证标签交集是不是真的生效：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">for</span> slug in worker-cron-friend-check comment-anti-spam r2-image-pipeline; <span class="tok-k">do</span>
  <span class="tok-k">curl</span> -s <span class="tok-s">&quot;https://exia.de5.net/p/$slug&quot;</span> | <span class="tok-k">grep</span> -oE <span class="tok-s">&#39;/tag/[^&quot;]+&quot;[^&gt;]*&gt;#[^&lt;]+&#39;</span>
<span class="tok-k">done</span></code></pre></div>
<p>抓出来的标签列表里，每篇的标签都出现<strong>两遍</strong>——页面顶部的元信息区和底部的文章标签栏各渲染一次。这个重复本身不是 bug，但它让我意识到一件事：页面上能看到的标签，和 <code>post.tags</code> 这个 JS 变量是不是一回事，还得往回追。</p>
<p>于是做了第二件事：拿真实 D1 候选，在本地直接跑 <code>rankRelated</code>，看它应该排出什么：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> rows = <span class="tok-c">/* 上一节那条 SQL 的 D1 返回 */</span>;
<span class="tok-k">const</span> post = { slug: <span class="tok-s">&#39;worker-cron-friend-check&#39;</span>,
               category: <span class="tok-s">&#39;tools&#39;</span>,
               tags: [<span class="tok-s">&#39;cloudflare&#39;</span>, <span class="tok-s">&#39;d1&#39;</span>, <span class="tok-s">&#39;workers&#39;</span>, <span class="tok-s">&#39;cache&#39;</span>] };
<span class="tok-k">for</span> (<span class="tok-k">const</span> x <span class="tok-k">of</span> <span class="tok-f">rankRelated</span>(post, rows)) console.<span class="tok-f">log</span>(x.slug);</code></pre></div>
<p>输出是 <code>worker-render-549-to-96</code> / <code>editor-autosave</code> / <code>workers-subrequest-limit</code>——和线上三张卡<strong>一张都不重合</strong>。到这一步可以确定：不是排序规则写错，是排序没拿到它该拿的输入。</p>
<p>再回到 <code>servePostPage</code>，把 <code>rankRelated</code> 那一行的上下文和 <code>post.tags</code> 的赋值位置对着看，16 行的距离一眼就出来了。</p>
<p><strong>为什么测试没抓到？</strong> 因为纯函数单测只验证「传进去什么，吐出来什么」。它不会检查调用方有没有在正确的时间、用正确的参数调用。这种 bug 在纯函数里不存在，只存在于接线处。</p>
<h3 id="一个反过来被验证的设计"><a class="h-anchor" href="#一个反过来被验证的设计">#</a>一个反过来被验证的设计</h3>
<p>这次能快速定位，是因为 <code>rankRelated</code> 是纯函数。如果排序逻辑直接写在 <code>servePostPage</code> 里、直接读 <code>post.tags</code>，我得在一页几百行的渲染代码里找「标签是从哪来的」，而不是在本地跑 5 行 JS 就能复刻预期结果。</p>
<p>纯函数的价值不在于「好测试」这句口号，在于<strong>它能被单独拎出来跑</strong>。线上结果和本地复刻不一致，这个差异本身就是最强的定位信号——错的一定是接线，不是函数。</p>
<h2 id="四-修一行-补一条探针"><a class="h-anchor" href="#四-修一行-补一条探针">#</a>四、修一行，补一条探针</h2>
<p>修复本身只有一处挪动：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> post = bundle.post ? { ...bundle.post } : <span class="tok-k">null</span>;
<span class="tok-k">const</span> tagNames = bundle.tags;
<span class="tok-c">/* tags 必须在 rankRelated 之前挂上。posts 表没有 tags 列，它是独立查询出来的；
   rankRelated 靠 post.tags 算共同标签数，晚一步赋值就全是 0，
   排序退化成「同栏目 + 时间新」，跨栏目同标签的文章一条都进不来。 */</span>
<span class="tok-k">if</span> (post) post.tags = tagNames;
<span class="tok-c">// ...</span>
<span class="tok-k">const</span> related = <span class="tok-f">rankRelated</span>(post, allCat);</code></pre></div>
<p>然后把 1035 行那句 <code>post.tags = tagNames</code> 删掉——不能留两处，否则下次有人改其中一处，又是一个坑。</p>
<p>光改代码不够，得让线上体检能抓住这类回归。原来的探针只验「有没有区块、几张卡、链接格式、不含自己」，全是结构检查，排序对不对根本没测。补一条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// worker-render-549-to-96 是 log 栏目，与本篇 4 个标签全中；</span>
<span class="tok-c">// 若 post.tags 没在 rankRelated 之前赋值，共同标签数恒为 0，跨栏目这篇进不来。</span>
<span class="tok-f">ok</span>(<span class="tok-s">&#39;跨栏目同标签文章排第一（标签交集真生效）&#39;</span>,
  relHrefs[<span class="tok-n">0</span>] === <span class="tok-s">&#39;/p/worker-render-549-to-96&#39;</span>, <span class="tok-s">`实际第一张 ${relHrefs[0]}`</span>);</code></pre></div>
<p>这条探针的厉害之处在于它是<strong>行为断言</strong>，不是结构断言。它不关心 HTML 里有没有 <code>class=&quot;rel&quot;</code>，只问一件事：跨栏目同标签的那篇排第一了吗？赋值顺序错了就必挂。</p>
<p>修复上线前后，同一篇文章的线上实测：</p>
<div class="table-wrap"><table><thead><tr><th>检查项</th><th>修复前</th><th>修复后</th></tr></thead><tbody><tr><td>卡片数</td><td>3</td><td>3</td></tr><tr><td>第一张卡</td><td>评论区防滥用（tools）</td><td>Worker 渲染 549→96（log）</td></tr><tr><td>跨栏目同标签文章进前三</td><td>否</td><td>是</td></tr><tr><td>单测</td><td>10/10</td><td>10/10</td></tr><tr><td>线上体检</td><td>52/52</td><td>53/53</td></tr></tbody></table></div>
<p>注意前两行——卡片数和以前一模一样。这就是这个 bug 藏了这么久的原因：<strong>从外面看，功能完全正常</strong>。</p>
<p>我用三篇文章交叉验证过修复后的排序，每篇都符合规则预期：</p>
<div class="table-wrap"><table><thead><tr><th>当前文章</th><th>标签</th><th>第一张推荐</th><th>为什么是它</th></tr></thead><tbody><tr><td>worker-cron-friend-check</td><td>cloudflare d1 workers cache</td><td>Worker 渲染 549→96</td><td>4 个标签全中，跨栏目</td></tr><tr><td>editor-markdown-xss</td><td>javascript markdown xss</td><td>R2 图片链路</td><td>共同标签 <code>xss</code></td></tr><tr><td>worker-render-549-to-96</td><td>cloudflare d1 workers cache</td><td>友链存活检测</td><td>共同标签最多，同栏目 tools</td></tr></tbody></table></div>
<p>第二篇尤其能说明问题：<code>editor-markdown-xss</code> 是 <code>tools</code> 栏目，修复前推的三篇全是 tools；修复后第一张仍是 tools 的 R2 图片链路——但这次是因为它真的共享 <code>xss</code> 标签，不是因为栏目碰巧相同。第二张变成 <code>editor-autosave</code>（共享 <code>javascript</code>），第三张是 <code>sticky-toc</code>（共享 <code>javascript</code>）——三张卡的共同标签都是 1，同栏目优先生效，所以 tools 栏目在前。</p>
<p>这个结果用修复前的代码<strong>永远得不到</strong>，因为它连 <code>post.tags</code> 都拿不到，谈不上数交集。</p>
<h2 id="五-空结果不渲染-别留空壳"><a class="h-anchor" href="#五-空结果不渲染-别留空壳">#</a>五、空结果不渲染，别留空壳</h2>
<p><code>renderRelated</code> 的第一行是：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">renderRelated</span>(post, list) {
  <span class="tok-k">if</span> (!list || !list.length) <span class="tok-k">return</span> <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-c">// ...</span>
}</code></pre></div>
<p>没有候选就整块不输出。这条看着简单，但很容易被忽略——有人为了让页面「看起来完整」，会渲染一个空的 <code>&lt;section&gt;</code> 加一句「暂无相关文章」。对一个 31 篇文章的小站，没标签又没同栏目的文章是存在的（<code>post-brfy5</code> 就是），空壳会占掉一大块版面。</p>
<p>渲染成三列卡片，移动端收成一列：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">.post-related .rel-grid {
  display: grid; grid-template-columns: <span class="tok-f">repeat</span>(<span class="tok-n">3</span>, <span class="tok-n">1fr</span>); gap: <span class="tok-n">12px</span>;
}
@media (max-width: <span class="tok-n">720px</span>) {
  .post-related .rel-grid { grid-template-columns: <span class="tok-n">1fr</span>; }
}</code></pre></div>
<p>位置上放在正文之后、上下篇之前——先给横向的延伸阅读，再给纵向的时间序列。卡片上的链接带 <code>rel=&quot;nofollow&quot;</code>：相关推荐是站内跳转，但不想让爬虫把这里当成主要的权重传递路径。</p>
<p>这里有个取舍值得说清楚：<strong>上下篇已经存在了，为什么还要相关推荐？</strong> 因为两者回答的问题不一样。上下篇是「这个系列的前后文」，按时间轴走，同栏目才有；相关推荐是「还能看什么」，按语义相似度走，允许跨栏目。对一篇有系列的文章，页面底部同时出现两块——系列目录在最上面，相关推荐在中间，上下篇在下面——读者按需要挑。</p>
<p><code>worker-cron-friend-check</code> 不是系列文章，但仍有上下篇：同栏目的 <code>editor-autosave</code> 和 <code>editor-markdown-xss</code>。线上体检里有一条专门验这两块共存：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">ok</span>(<span class="tok-s">&#39;有标签文章渲染相关推荐区块&#39;</span>, withTags.body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;class=&quot;post-related&quot;&#39;</span>));
<span class="tok-f">ok</span>(<span class="tok-s">&#39;相关推荐链接格式正确&#39;</span>, relHrefs.length === cards.length &amp;&amp; ...);</code></pre></div>
<p>上下篇那块还有个细节：只有一侧有文章时收成单列，不留半个虚线空框——「看起来像加载失败」比「少一个元素」更糟。相关推荐没有这个问题，因为它要么三张要么不渲染。</p>
<h3 id="缓存层带来的一个隐性约束"><a class="h-anchor" href="#缓存层带来的一个隐性约束">#</a>缓存层带来的一个隐性约束</h3>
<p>文章页有实例内 LRU（<code>src/postcache.js</code>），缓存的是数据库行，不是 HTML。TTL 45 秒，上限 40 条，只缓存公开文章：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (post &amp;&amp; !post.is_private) <span class="tok-f">postCacheSet</span>(slug, b);</code></pre></div>
<p><code>b</code> 是 <code>{ post, tags, series, same }</code>——标签在 <code>b.tags</code>，文章本体在 <code>b.post</code>。两条数据是<strong>并列</strong>存的，不是 <code>b.post.tags</code>。这正是 bug 的温床：浅拷贝 <code>post</code> 时不会带上 tags，因为从数据库行层面它们本来就是分开的。</p>
<p>缓存还有个副作用：热路径下这页根本不走 D1，<code>bundle</code> 直接来自 LRU。也就是说候选集 <code>allCat</code> 可能是 45 秒前的快照。对推荐来说这完全可以接受——没人在意推荐列表是不是秒级新鲜；但意味着<strong>改了标签之后，推荐结果最多滞后 45 秒</strong>。这个延迟和缓存的其他部分一致，不需要特殊处理。</p>
<p>真正不能缓存的是 HTML 本身：里面有 CSP nonce、当前用户名、编辑入口，存下来必然串号。所以每次请求都会重新执行 <code>rankRelated</code>——排序成本是纯 CPU，几毫秒，换来的是每个访客看到正确的 nonce 和登录态。</p>
<p>标题和摘要都过 <code>esc()</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">return</span> <span class="tok-s">`&lt;a class=&quot;rel&quot; href=&quot;/p/${encodeURIComponent(p.slug)}&quot; rel=&quot;nofollow&quot;&gt;
  &lt;span class=&quot;rel-t&quot;&gt;${esc(p.title)}&lt;/span&gt;
  ${meta ? `</span>&lt;span <span class="tok-k">class</span>=<span class="tok-s">&quot;rel-m&quot;</span>&gt;${<span class="tok-f">esc</span>(meta)}&lt;/span&gt;<span class="tok-s">` : &#39;&#39;}
&lt;/a&gt;`</span>;</code></pre></div>
<h2 id="六-这次真正学到的"><a class="h-anchor" href="#六-这次真正学到的">#</a>六、这次真正学到的</h2>
<p>写完代码、测试全绿、上线跑通，然后发现功能从没真正工作过——这种事比「上线就报错」麻烦得多。报错会有人喊，静默降级没人喊。</p>
<p>三条经验，按重要性排：</p>
<p><strong>第一，纯函数的单测覆盖不了接线。</strong> <code>rankRelated</code> 的 10 项测试全部通过，但它测的是「给定正确的 <code>post.tags</code>，排序对不对」。调用方有没有给正确的 <code>post.tags</code>，是另一回事。补这类洞只能靠行为级断言——线上探针直接问业务问题，不问实现细节。</p>
<p><strong>第二，「看起来差不多」的输出最可疑。</strong> 修复前后都是三张卡、格式一样、不含自己。任何结构检查都发现不了差别。发现问题的唯一线索是「三张卡全是同一个栏目」——这是一个统计特征，不是一个错误状态。以后做推荐类功能，我会先看结果的<strong>分布</strong>，不只看结果的存在。</p>
<p><strong>第三，D1 连接数限制会倒逼出好的设计。</strong> 如果不能单开查询，就必须把候选从已有查询里带出来，就必须用 <code>GROUP_CONCAT</code> 一次带标签，就必须把排序做成纯函数。这些限制看起来是麻烦，到头来反而让代码更简单——一条 SQL、一个纯函数、5 行探针。</p>
<h3 id="空结果为什么必须不渲染"><a class="h-anchor" href="#空结果为什么必须不渲染">#</a>空结果为什么必须不渲染</h3>
<p><code>post-brfy5</code> 这篇文章没有标签，也没有同栏目文章，<code>rankRelated</code> 返回空数组。页面上的处理是整块不输出，不是渲染一个空壳。</p>
<p>这件事看着小，但对一个小站很关键。31 篇文章里，标签覆盖率不是 100%——早期文章可能没打标签，有些独立文章不属于任何栏目。如果空结果也渲染，这些文章底部就多一个「相关文章」标题，下面空空荡荡，读者会以为页面加载失败。</p>
<p>线上体检也覆盖了这条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">ok</span>(<span class="tok-s">&#39;无标签无栏目文章不渲染相关推荐&#39;</span>, !noTags.body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;class=&quot;post-related&quot;&#39;</span>));</code></pre></div>
<p>这条断言只看区块在不在，不看卡片数。因为它防的是「回归时有人把空态渲染打开」——那种改动不会报错，只会让页面变丑。</p>
<h3 id="这次改动的范围"><a class="h-anchor" href="#这次改动的范围">#</a>这次改动的范围</h3>
<p>把收尾的 diff 摆出来，能看清一个静默 bug 的修复成本有多低：</p>
<div class="table-wrap"><table><thead><tr><th>文件</th><th>改动</th><th>行数</th></tr></thead><tbody><tr><td><code>src/index.js</code></td><td><code>post.tags</code> 赋值前移 + 注释根因</td><td>+6 / −1</td></tr><tr><td><code>scripts/check-live.mjs</code></td><td>跨栏目同标签排第一的探针</td><td>+5</td></tr><tr><td><code>content/23-related-posts.md</code></td><td>这篇记录</td><td>新增</td></tr></tbody></table></div>
<p>代码改动 11 行，其中 6 行是注释。真正防回归的是那 5 行探针——它把「标签交集真的生效了」变成一个可观察的线上事实，而不是一句写在注释里的假设。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>三步，从离线到线上，每步都能独立跑。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1) 纯函数单测：验证排序规则本身（10 项）</span>
<span class="tok-k">node</span> scripts/test-related.mjs

<span class="tok-c"># 2) 用真实 D1 数据复刻候选集，看 rankRelated 会排出什么</span>
npx wrangler d1 execute blog-db --remote --json --command \
  &quot;SELECT p.slug, p.category, p.published_at, p.created_at,
          (SELECT <span class="tok-f">GROUP_CONCAT</span>(t.name, <span class="tok-f">char</span>(<span class="tok-n">31</span>)) FROM post_tags pt
           JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id) AS tag_str
   FROM posts p WHERE p.is_private=<span class="tok-n">0</span> AND p.hidden=<span class="tok-n">0</span>
     AND (p.category=(SELECT category FROM posts WHERE slug=<span class="tok-s">&#39;worker-cron-friend-check&#39;</span>)
          OR EXISTS (SELECT <span class="tok-n">1</span> FROM post_tags a JOIN post_tags b ON a.tag_id=b.tag_id
                     WHERE a.post_id=p.id
                       AND b.post_id=(SELECT id FROM posts WHERE slug=<span class="tok-s">&#39;worker-cron-friend-check&#39;</span>)))
   ORDER BY <span class="tok-f">COALESCE</span>(<span class="tok-f">NULLIF</span>(p.published_at,<span class="tok-s">&#39;&#39;</span>),created_at) ASC&quot;

<span class="tok-c"># 3) 线上体检：53 项，其中「跨栏目同标签文章排第一」直接验赋值顺序</span>
<span class="tok-k">npm</span> run check:live</code></pre></div>
<p>第 2 步单独拿出来说：它不需要改代码，也不需要部署，直接在命令行里能看到 12 条候选和每条的 <code>tag_str</code>。如果某天排序又不对了，先跑这条——能一眼分清是候选查询错了，还是内存排序错了，还是赋值顺序又错了。</p>
<p>第 3 步里那条新增探针，是这个 bug 留下的唯一长期保险。以后谁再动 <code>post.tags</code> 的赋值时机，它会当场把人拦下来。</p>
<h3 id="一个小提醒-别把探针写成实现细节"><a class="h-anchor" href="#一个小提醒-别把探针写成实现细节">#</a>一个小提醒：别把探针写成实现细节</h3>
<p>补探针时最容易犯的错，是断言 HTML 里某个类名存在——这类断言在重构时全挂，却什么都保不住。</p>
<p>对比这两条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 结构断言：改动类名就挂，排序错了照样过</span>
<span class="tok-f">ok</span>(<span class="tok-s">&#39;有相关推荐区块&#39;</span>, body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;class=&quot;post-related&quot;&#39;</span>));

<span class="tok-c">// 行为断言：只有排序真按标签交集走才会过</span>
<span class="tok-f">ok</span>(<span class="tok-s">&#39;跨栏目同标签排第一&#39;</span>, relHrefs[<span class="tok-n">0</span>] === <span class="tok-s">&#39;/p/worker-render-549-to-96&#39;</span>);</code></pre></div>
<p>原来的探针 5 项里有 4 项是结构断言，只有「不含当前文章」算半个行为断言。这次补的第 6 项才是第一条真正验证业务语义的。断言写什么，取决于你想让测试在什么时候响——<strong>测试响的时机不对，比没有测试更浪费时间</strong>，因为会养出「测试全绿就没事」的习惯。</p>
<p>这也是为什么这篇文章值得单独写一篇：功能实现只花了 41 行纯函数，让它真正工作的是 5 行线上探针，而发现它需要的是「线上结果和本地复刻对不上」这一个信号。三件事里没有一件写在功能代码里。</p>', '', 'tools', '代码写了「共同标签数 → 同栏目 → 时间新」三级排序，线上只跑两级。赋值顺序错让共同标签数恒为 0，纯函数单测 10 项全绿也没抓到。',
        '', 0, 0, 0, 1, '2027-02-03 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('workers') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'related-posts' AND t.name = 'workers';
INSERT INTO tags (name) VALUES ('d1') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'related-posts' AND t.name = 'd1';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'related-posts' AND t.name = 'debugging';


INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('search-highlight-xss', '搜索结果高亮的 <mark> 怎么不变成注入点：先切段，再逐段转义', '## 结论

站内搜索最常见的漏，不是分词不准，也不是没上全文索引，是**标签压根没进检索**。

我的博客搜 `debugging`，返回 4 篇。这 4 篇的标题里一个 `debugging` 都没有：

| slug | 标题 | 命中的是什么 |
|---|---|---|
| sticky-toc-grid-align-items | 目录不跟着滚：sticky 在 grid 里失效，根因是 align-items 用了 start | 标签 `debugging` |
| workers-subrequest-limit | Workers 里 fetch 超时不是网络慢：subrequest 限额踩坑记 | 标签 `debugging` |
| wrangler-deploy-errors | wrangler deploy 失败对照：六条报错原文对应的真实原因 | 标签 `debugging` |
| d1-no-such-table | D1 报错 no such table 排查实录：本地和远程根本不是一套库 | 标签 `debugging` |

这四篇的正文里也确实写着 debugging 这个词，但读者搜的是概念，不是原文。标签是作者手填的语义索引，比正文里的字面出现更接近「这篇文章在讲什么」。

只加后端还不够。结果页得把命中的词标出来，否则读者看到一个标题，不知道它为什么被搜出来——上面四个标题，没有一个长得像「调试」。

高亮这件事看起来是前端小事：找到关键词、包一层 `<mark>`。但顺序错了会有两个具体的坑，我都踩了：

- **先转义再匹配**，query 里带 `&` 或 `<` 就永远匹配不到，因为它已经被换成了 `&amp;` 和 `&lt;`。
- **不做正则转义**，query 是 `c++` 时 `new RegExp` 直接抛 `Nothing to repeat`，整个结果列表白屏。

这篇按顺序讲：三路 SQL 怎么写、占位符为什么必须对齐、高亮为什么先切段再逐段转义、以及中文和空词的边界。数据都是 2026-11-18 对 `exia.de5.net` 的实测。

## 一、标签为什么是死角

最初的搜索只有两路：

```js
p.title LIKE ? OR p.content LIKE ?
```

看起来够了——标题和正文都搜，还能漏什么？漏的是**不在标题也不在正文里出现的词**。

我的文章标题是「目录不跟着滚：sticky 在 grid 里失效，根因是 align-items 用了 start」，标签是 `css` `layout` `browsers` `css` `debugging`。一个读者想找「调试相关的东西」，他会敲 `debugging`，不会敲 `sticky`。这个词在标题里没有，在正文里也许提了一次，但标题和正文的 LIKE 命中率取决于作者的用词，不取决于读者的用词。

标签不一样。标签是我在发文时手动选的，它的作用就是「这篇归到哪一类」。读者搜的也往往是类别词，不是原文词。

补上第三路之后，三路是**并集**：

```sql
(p.title LIKE ?
 OR p.content LIKE ?
 OR p.id IN (SELECT pt.post_id FROM post_tags pt
             JOIN tags t ON t.id = pt.tag_id
             WHERE t.name LIKE ?))
```

前两路是字面匹配，第三路是「这篇文章的标签里，有没有一个像关键词的」。

上线后同一个词的命中数变化：

| 查询词 | 两路（标题+正文） | 三路（加标签） | 多出来的 |
|---|---|---|---|
| `debugging` | 0 篇标题命中 | 4 篇 | 4 篇全靠标签 |
| `d1` | 部分 | 11 篇 | 标签 `d1` 的文章全部进来 |
| `缓存` | 部分 | 7 篇 | 标题、正文、标签三路都有贡献 |

`缓存` 这个词值得单独看：它既可能出现在标题（「三层缓存怎么排」），也可能出现在正文，也可能是标签。三路命中会有重复，但 `OR` 天然去重——一篇文章只要任一路命中就进结果，不会因为三路都中而出现三次。

## 二、三路 SQL 与子查询口径

三路条件抽成了一个纯函数，放在 `src/api.js`：

```js
export function searchMatch(q) {
  const kw = `%${q}%`;
  return {
    sql: `(p.title LIKE ? OR p.content LIKE ? OR p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name LIKE ?))`,
    args: [kw, kw, kw],
  };
}
```

三个决定：

**第一，标签那一路用 `IN` 子查询，不是 `JOIN`。** 如果用 `JOIN post_tags`，主查询的 `FROM` 就变了，一篇文章有 4 个标签就会变成 4 行，`COUNT(*)` 和分页全乱。`IN` 子查询只回答「这个 post_id 在不在集合里」，不改变主查询的行数。

**第二，子查询的口径和站内标签过滤完全一致。** 站内点标签进 `/tag/debugging` 时用的也是 `post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?`。搜索这里只是把 `=` 换成 `LIKE`，连接方式一模一样。口径一致的好处是：从搜索结果点进一篇文章，再点它的标签，看到的集合是对得上的；如果两处口径不同，会出现「搜到 4 篇，点标签只有 3 篇」这种解释不清的差异。

**第三，抽成纯函数是为了单测不碰 D1。** `searchMatch` 只负责拼 SQL 和参数，不执行查询。测试可以直接断言「SQL 里有三个 `?`」「参数是三个 `%词%`」，不需要起一个 D1 实例。

这一步还顺手解决了一个更隐蔽的问题——下一节。

## 三、占位符对齐：COUNT 和列表必须共用一段 WHERE

列表接口返回两个数：当前页的文章，和总数。两个数来自两条 SQL：

```js
const [listRes, countRes] = await Promise.all([
  db.prepare(`SELECT ... WHERE ${whereSql} ORDER BY ... LIMIT ? OFFSET ?`).bind(...args, size, offset).all(),
  db.prepare(`SELECT COUNT(*) AS total FROM posts p WHERE ${whereSql}`).bind(...args).first(),
]);
```

`whereSql` 和 `args` 是同一份。这是刻意的：如果两条 SQL 各拼一遍 WHERE，只要有一处漏了某个条件，线上表现就是**搜得到但总数不对**——列表 4 篇，总数写 17 篇，分页器算出 2 页，点第二页是空的。

更糟的是参数数量对不上：`whereSql` 里有三个 `?`，`args` 只 push 了两个，`bind()` 直接抛错，整个接口 500。

两种失败都很常见，而且都不容易在开发时发现——开发时搜的词往往只有一个分支命中，三个 `?` 都绑上了，看不出问题。等到线上搜一个「标题、正文、标签都命中」的词，或者一个都不命中的词，才暴露。

单测专门验这一条：

```js
t(''占位符数量与参数数量一致（COUNT 和列表共用 whereSql）'', () => {
  const { sql, args } = searchMatch(''d1'');
  const holes = (sql.match(/\?/g) || []).length;
  assert.equal(holes, 3, `SQL 里有 ${holes} 个 ?`);
  assert.equal(args.length, holes, ''参数数量与占位符不符'');
});
```

这条断言很朴素，但它保的是「不会 500」。子查询里如果哪天多加一个 `?`（比如按标签权重过滤），参数忘了加，这条测试当场红。

`test-search.mjs` 一共 6 项，全部不碰 D1：

```text
  ok  标题 / 正文 / 标签三路条件都进了 SQL
  ok  子查询口径与现有 tag 过滤一致（post_tags.post_id）
  ok  占位符数量与参数数量一致（COUNT 和列表共用 whereSql）
  ok  三个参数绑的是同一个 %关键词%
  ok  空关键词不抛错，参数退化为 %%
  ok  中文关键词原样保留，不转义不改写
```

第 2 项「口径一致」和第 6 项「中文原样保留」是后补的——前者防两处 SQL 走偏，后者防有人「顺手」给中文做 URL 编码或大小写处理。

## 四、高亮为什么必须先切段再逐段转义

这是整篇最容易写错的地方。高亮的实现只有 20 行，但顺序一换，行为完全不同。

正确的顺序是：**在原文上找位置，切出片段，逐段转义，然后拼 `<mark>`**。

```js
function hl(text, q) {
  const s = String(text ?? '''');
  const needle = String(q || '''').trim();
  if (!needle) return esc(s);
  let re;
  try {
    re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, ''\\$&''), ''gi'');
  } catch {
    return esc(s);
  }
  let out = '''';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(s.slice(last, m.index)) + ''<mark>'' + esc(m[0]) + ''</mark>'';
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}
```

### 反面一：先 `esc` 再匹配，query 里的 `&` 和 `<` 永远匹配不到

直觉的做法是「先把文本转义成安全的 HTML，再在上面找关键词包 mark」。这样写不会注入，但它有一个死的缺陷：转义之后，原文的 `&` 变成了 `&amp;`，`<` 变成了 `&lt;`。

你搜 `a&b`，`needle` 是 `a&b`，文本已经被转成 `a&amp;b`——匹配不上。搜 `1 < 2` 也一样。用户看到的是「搜到了这篇，但一个字都没高亮」，而他没法知道为什么。

这个问题在技术博客里出现频率不低：文章正文里到处都是 `&`、`<`、`>`（比如讲 HTML 转义的文章本身）。先转义的写法在这类文章上等于高亮失效。

正确顺序是：原文匹配 → 切段 → 每段各自转义 → 拼起来。`esc(s.slice(last, m.index))` 转的是「命中之前的普通文本」，`esc(m[0])` 转的是「命中的词本身」。两段都转义了，但匹配是在未转义的原文上做的，所以 `&` 和 `<` 照样能命中。

### 反面二：不做正则转义，`c++` 直接抛错

关键词要当正则用（为了 `gi` 做大小写不敏感、为了 `exec` 拿位置），但用户输入的词不一定是合法正则。

我实测了四个 query，在 Node 里直接 `new RegExp`：

| query | 结果 |
|---|---|
| `c++` | 抛错 `Invalid regular expression: /c++/gi: Nothing to repeat` |
| `[x` | 抛错 `Invalid regular expression: /[x/gi: Unterminated character class` |
| `a.b` | 不抛错，但 `.` 会匹配任意字符 |
| `(x)` | 不抛错，但括号被当成捕获组 |

`c++` 是程序员真会搜的词。`+` 是量词，`c++` 意思是「一个 c 后面跟一个或多个 +」，语法上非法，`RegExp` 构造函数直接抛。如果不捕获这个异常，整个结果列表的渲染会中断——页面上是骨架屏永远转圈，或者一段空白。

所以有两道防线：

```js
try {
  re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, ''\\$&''), ''gi'');
} catch {
  return esc(s);
}
```

第一道是把正则元字符全部转义成字面量（`c++` → `c\+\+`），这样绝大多数情况根本不会抛。第二道是 `try/catch` 兜底：万一还有没覆盖到的语法（比如某些 Unicode 属性转义），退化成「不高亮但正常显示」，而不是整页挂掉。

`a.b` 那种不抛错但会误匹配的情况更阴险：它不报错，只是把 `axb` 也标成命中。转义之后变成 `a\.b`，只匹配字面量。这类错误没人会来报，但会让人怀疑「高亮怎么不准」。

### 零宽匹配：不跳过就是死循环

```js
while ((m = re.exec(s)) !== null) {
  if (!m[0]) { re.lastIndex++; continue; }
  // ...
}
```

`m[0]` 为空的情况来自「能匹配零个字符」的正则。正常情况下转义后不会出现，但 `gi` 加上某些边界（比如关键词是空字符串、或者全是空白被 trim 成空）可能构造出零宽匹配。零宽匹配时 `re.lastIndex` 不前进，`while` 永远为真——浏览器直接卡死。

这行 `re.lastIndex++` 是保险，不是主逻辑。写它的理由很简单：这个函数在渲染循环里跑，一个死循环能让整页失去响应，代价太大。

### 这里为什么不用完整的 HTML 清洗器

项目里已经有一个给正文用的清洗器（`sanitizeHtml`），它会解析 HTML、按白名单过滤标签和属性。高亮这里没有复用它，用的是最简单的 `esc()`：

```js
const ESC = { ''&'': ''&amp;'', ''<'': ''&lt;'', ''>'': ''&gt;'', ''"'': ''&quot;'', "''": ''&#39;'' };
const esc = (s) => String(s || '''').replace(/[&<>"'']/g, (c) => ESC[c]);
```

两个理由。一是**输入类型不同**：高亮的输入是纯文本（标题、摘要、标签名），不是 HTML。对它跑一个 HTML 解析器，等于先假设它是 HTML 再证明它不是，多绕一圈。二是**输出要可预测**：`esc()` 的行为就五个字符映射，一眼能看完；`sanitizeHtml` 会重排属性、丢掉不认识的标签，用在「把一个词包进 mark」这种场景上，结果会比输入更需要解释。

正确的关系是分层的：`sanitizeHtml` 管正文（那部分确实有 HTML），`esc()` 管所有拼进属性的纯文本。两者不互相替代——用 `sanitizeHtml` 处理标题既慢又可能改字，用 `esc()` 处理正文会漏掉标签。

## 五、三处调用与空结果出口

`hl()` 在三个地方被调用，都是搜索结果的可见部分：

```js
<h2>${hl(p.title, currentQ)}</h2>
${p.excerpt ? `<p class="excerpt">${hl(p.excerpt, currentQ)}</p>` : ''''}
${(p.tags || []).slice(0, 3).map((t) => `<span class="tag">#${hl(t, currentQ)}</span>`).join('''')}
```

标题、导语、标签芯片。标签芯片那处是后来补的——搜 `debugging` 时，标题和导语里一个 `debugging` 都没有，读者看到四张卡，完全不知道为什么这四篇被搜出来。标签芯片上标出 `#debugging` 并高亮，答案立刻就在眼前。

这也是「后端三路匹配」和「前端三处高亮」必须一起做的原因：只做后端，结果是「搜得对但看不懂」；只做前端，标签根本进不了结果集。

### 为什么用 `<mark>` 而不是给 span 挂类

高亮的容器可以是 `<span class="hl">`，也可以是 `<mark>`。我选了后者，两个理由。

一是**语义**。`<mark>` 的 HTML 定义就是「标记出与当前上下文相关的文本」，屏幕阅读器会念出来，而 `<span class="hl">` 对一个读屏用户来说什么都不是。搜索结果里的高亮刚好是 `<mark>` 的标准用途，没有比它更贴切的元素。

二是**默认样式**。浏览器给 `<mark>` 自带黄底，即使 CSS 没加载出来，高亮也在。`<span class="hl">` 在样式表失效时就是一个普通 span，搜索命中的视觉线索全部消失。

配色上没写死黄色，而是跟着主题的强调色走：

```css
mark {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}
```

`color-mix` 把强调色按 24% 混进透明背景，两套主题（亮色和暗色）不用各写一遍——暗色主题下 `--accent` 变亮，混出来的底色自动跟着变，文字对比度也保持得住。写死 `background: #fff3a3` 的话，暗色主题下会变成一块刺眼的黄斑。

### 分页不能把搜索词弄丢

搜索结果翻页时，`q` 参数必须跟着走，否则第二页会退回「全部文章」：

```js
const qs = (p) => {
  const u = new URLSearchParams();
  if (currentQ) u.set(''q'', currentQ);
  u.set(''page'', String(p));
  // ...
};
```

这个逻辑看着理所当然，但漏了会很难查——第一页 4 篇，翻到第二页变成 17 篇，用户会以为「搜索只对第一页生效」。分页器里 `currentQ`、`currentCat`、`currentTag` 三个状态都要带上，任何一个漏了，翻页就换了一个筛选条件。

### 卡片是客户端渲染的

这一点容易被忽略：搜索结果的卡片不是服务端渲染的，是前端拉接口渲染的。

服务端返回的 HTML 里只有骨架屏：

```html
<div class="sk-card"><div class="sk sk-thumb"></div>...</div>
```

前端拿到 `/api/posts?q=debugging` 之后，用 `card()` 拼 HTML 塞进 `#list`：

```js
const { posts, total, pages } = await api(''/api/posts?'' + params, { signal: mine.signal });
listEl.innerHTML = posts.map(card).join('''');
```

所以高亮发生在浏览器里，`hl()` 是前端函数。服务端也有一份 `postCard`，用于首页和栏目页的 SSR，那份**不带高亮**——因为 SSR 的列表页不涉及搜索词，不需要。

这条分工带来一个好处：搜索是实时的，输入框 320ms 防抖，不用整页刷新。代价是高亮逻辑必须在客户端跑一遍，而且要考虑 `AbortController`——用户快速改词时，前一个请求的结果不能覆盖后一个。代码里用 `mine !== ctrl` 判断，过期的响应直接丢掉。

竞态这件事不处理会有很具体的症状：输入 `rus` 之后马上改成 `rust`，两个请求并发发出，如果 `rus` 的响应后到，列表里显示的是「rus 的结果」，而输入框里写着「rust」。用户看到的是「搜索不准」，实际上是响应顺序的问题。`AbortController` 在发新请求时 abort 旧的，再加上 `mine !== ctrl` 双重判断，两条防线。

### 客户端渲染带来的 SEO 代价

搜索结果是客户端渲染的，这意味着一件事：**爬虫抓这一页时，拿不到任何结果**。它看到的只有骨架屏。

所以搜索结果页直接标了 `noindex,follow`：

```js
const isSearch = !!(url && (url.searchParams.get(''q'') || '''').trim());
// ...
isSearch ? `<meta name="robots" content="noindex,follow">` : '''',
```

两个决定都在里面。`noindex` 是因为「搜索结果页」对搜索引擎没有价值——它是查询的产物，不是内容本身，让爬虫反复抓 `?q=xxx` 的各种组合纯属浪费抓取配额。`follow` 是保留下来的：结果里的文章链接值得被发现，尤其对一个小站，每一条额外入链都有用。

这条也和「先做后端还是先做前端」的取舍有关：如果搜索页做 SSR，爬虫能拿到结果，但每次搜索都要回源打 D1，实时性和成本都变差；做客户端渲染，搜索体验好，代价是这一页对 SEO 没贡献。对一个内容站，后者的代价可以接受——搜索页本来就不该是落地页。

### 空结果不能只说一句「没找到」

搜不到东西时，原来的实现是一行字：「没有找到匹配的文章」。这句话的问题不是不礼貌，是**没给下一步**。

现在空结果页是这样：

```js
function emptySearch() {
  return `<div class="empty empty-search">
    <p class="es-t">没有找到与「${esc(currentQ)}」相关的文章</p>
    <p class="es-h">试着换个更短的关键词，或者从栏目、标签翻进去。</p>
    <div class="es-acts">
      <a class="btn sm" href="/">看全部文章</a>
      <a class="btn sm" href="/archive">按时间归档</a>
    </div>
  </div>`;
}
```

三件事：回显关键词（让用户确认自己搜的是什么，而不是怀疑输入框吞了字）、给一个改词的建议、给两条明确的出口。

`check-ux.mjs` 用 Puppeteer 真跑一遍浏览器，验三条：

```js
t(r.cards > 0, `搜索「${KEY}」有结果（${r.cards} 篇）`);
t(r.marks.length > 0, `结果里出现 <mark> 高亮（${r.marks.length} 处）`);
t(r.marks.every((m) => m.toLowerCase().includes(KEY.toLowerCase())),
  ''每个 <mark> 都正好是关键词，没有把整句圈进去'');
```

第三条最有用。它防的是「正则写宽了，把整段文字包进 mark」——那种情况下高亮确实存在，但视觉上整段变色，等于没有高亮。这条断言要求每个 `<mark>` 的文本都必须包含关键词，写宽了当场失败。

空结果那一段也是三条：有结构化提示、提示里回显关键词、至少给两个出口链接。

## 六、边界：中文、空词、大小写、元字符

### 中文 LIKE 的实际行为

`LIKE ''%缓存%''` 在 SQLite 里是字节级子串匹配，对中文没有分词——它能匹配「缓存」出现在任何位置，但匹配不了「缓存」的同义词。

实测结果：

| 查询词 | 命中数 | 说明 |
|---|---|---|
| `缓存` | 7 篇 | 标题、正文、标签三路都有贡献 |
| `d1` | 11 篇 | 标签 `d1` 的文章全部进来 |
| `DEBUGGING` | 4 篇 | 全大写，和 `debugging` 结果一致 |
| `Debugging` | 4 篇 | 混合大小写，同上 |
| `c++` | 0 篇 | 字面匹配，站内确实没有这个字符串 |
| 空 | 17 篇 | 全部文章（空词在调用方就被挡掉，不进 SQL） |

`DEBUGGING` 和 `Debugging` 都返回 4 篇，是因为 SQLite 的 `LIKE` 对 ASCII 字母默认不区分大小写。中文没有大小写，这条对中文无影响，但对英文标签很重要——用户不会记得标签是小写还是大写。

### 空词在调用方挡掉，不在 SQL 里挡

```js
if (q) {
  const m = searchMatch(q);
  where.push(m.sql);
  args.push(...m.args);
}
```

`q` 为空时，`searchMatch` 根本不会被调用，SQL 里不会出现那三个 `?`。这比在 SQL 里写 `LIKE ''%%''` 好——后者虽然也能返回全部，但它是一次全表扫描，而且 `COUNT` 也要跟着扫。

`searchMatch('''')` 单独调用时不会抛错（参数退化成 `%%`），这是给单测留的容错，不是给调用方用的。线上路径上，空词压根到不了这一步。

### 元字符：后端不炸，前端靠兜底

`c++` 在后端是安全的：`LIKE ''%c++%''` 里的 `+` 是字面量，不是量词。实测返回 0 篇，因为站内没有 `c++` 这个字符串，但不会报错。

真正会炸的是前端 `hl()`，前面已经讲过——`new RegExp(''c++'', ''gi'')` 抛 `Nothing to repeat`。所以同一次搜索里，后端能正常返回结果，前端渲染时才可能挂。这类「后端绿、前端炸」的问题，光测接口发现不了，必须跑浏览器。

### 标签大小写归一

标签在入库时已经统一小写（seed 白名单里全是小写）。所以库里不会有 `Debugging` 和 `debugging` 两个标签。

但搜索时用户可能输入任何大小写。`LIKE` 对 ASCII 不区分大小写，所以 `Debugging` 能匹配到 `debugging` 标签。这算是免费得到的行为，但依赖数据库的 collation 默认值——如果哪天换成别的数据库，或者 `LIKE` 走了 `BINARY` collation，这个行为就没了。

单测第 6 项「中文关键词原样保留」防的是另一个方向：有人在传参时对中文做了 `encodeURIComponent` 或 `toLowerCase`，导致 `%缓存%` 变成 `%E7%BC%93%E5%AD%98%`，永远匹配不到。

### 搜索埋点：防抖会骗你

搜索是有埋点的（`window.__ev(''search'', q)`），但这条埋点写不写、怎么写，直接决定后台看到的数字有没有意义。

输入框是 320ms 防抖的。一个输入「rust」的人，会依次触发 `r`、`ru`、`rus`、`rust` 四次查询——如果每次都上报，后台记录的不是搜索意图，是打字速度。所以上报前加了两道：

```js
if (currentQ && page === 1 && currentQ !== lastQ) {
  lastQ = currentQ;
  if (window.__ev) window.__ev(''search'', currentQ);
}
```

只在第一页报（翻页不算新搜索）、同一个词只报一次（`lastQ` 比对）。服务端还有一层「同人同日同词」去重，两道一起才干净。

这件事和搜索质量的关系比看起来要紧：如果埋点记的是半截词，你按搜索词排序看热门查询，会得到一堆 `r`、`ru` 这样的碎片，然后误判「用户都在搜什么单词」。数据脏了，后面所有基于它的判断都是错的。

### 规模上限：`%词%` 走不了索引

三路条件全是 `LIKE ''%词%''`，前置通配符意味着 B-tree 索引完全用不上，每次搜索都是全表扫描。

31 篇文章的表，这件事的代价可以忽略——`posts` 表就这么点行，扫一遍比走索引的额外开销还小。但这是个明确的天花板：行数到几千、正文又长的时候，每次搜索都要把全部正文读一遍做子串匹配，CPU 时间和内存都会顶上来。

真要往上走，换 FTS5（SQLite 全文索引）是标准答案，D1 支持建虚表。但那是另一个工程量级：要维护索引表、要处理中文分词（FTS5 默认的 `unicode61` 分词器不切中文词）、要在增删改文章时同步。当前这个站的实际搜索量一天个位数，上 FTS5 属于为一个不存在的问题写代码。

把上限写在这里，是为了下次搜索变慢时不用重新推导一遍——先看表有多大，再决定要不要换。

## 怎么自己验一遍

四条命令，从纯函数到真实浏览器，都不需要改代码。

```bash
# 1) 三路 SQL 与占位符对齐（6 项，不碰 D1）
node scripts/test-search.mjs

# 2) 接口层：标签命中的真实条数
curl -s -G "https://exia.de5.net/api/posts" \
  --data-urlencode "q=debugging" --data "size=20" | grep -oE ''"total":[0-9]+''

# 3) 大小写与中文边界
for q in DEBUGGING Debugging 缓存 d1; do
  printf "%-12s " "$q"
  curl -s -G "https://exia.de5.net/api/posts" --data-urlencode "q=$q" --data "size=20" \
    | head -c 200 | grep -oE ''"total":[0-9]+''
done

# 4) 浏览器里验高亮：有没有 mark、每个 mark 是不是关键词、空结果有没有出口
node scripts/check-ux.mjs https://exia.de5.net --q debugging
```

第 4 条必须有，因为高亮是客户端行为。第 2 条和第 4 条要一起看：接口返回 4 篇、浏览器里 4 张卡都有 `<mark>`，才算这条链路完整。只有接口对、页面没高亮，说明 `hl()` 没被调用或者 `currentQ` 没传下去；只有页面有高亮、接口条数不对，说明图省事在前端本地过滤了，绕过了后端的三路匹配。

收尾给一个手验的办法，验正则兜底：

```bash
# 浏览器地址栏里打开，确认页面不白屏、卡片正常显示、只是没有 mark
https://exia.de5.net/?q=c%2B%2B
```

`c++` 这个词站内没有，结果是空列表 + 空结果提示。要验的是它**不报错**——控制台里不该有 `Invalid regular expression` 的未捕获异常。这条最容易在改了 `hl()` 之后回归，而且不会有人主动来报。
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>站内搜索最常见的漏，不是分词不准，也不是没上全文索引，是<strong>标签压根没进检索</strong>。</p>
<p>我的博客搜 <code>debugging</code>，返回 4 篇。这 4 篇的标题里一个 <code>debugging</code> 都没有：</p>
<div class="table-wrap"><table><thead><tr><th>slug</th><th>标题</th><th>命中的是什么</th></tr></thead><tbody><tr><td>sticky-toc-grid-align-items</td><td>目录不跟着滚：sticky 在 grid 里失效，根因是 align-items 用了 start</td><td>标签 <code>debugging</code></td></tr><tr><td>workers-subrequest-limit</td><td>Workers 里 fetch 超时不是网络慢：subrequest 限额踩坑记</td><td>标签 <code>debugging</code></td></tr><tr><td>wrangler-deploy-errors</td><td>wrangler deploy 失败对照：六条报错原文对应的真实原因</td><td>标签 <code>debugging</code></td></tr><tr><td>d1-no-such-table</td><td>D1 报错 no such table 排查实录：本地和远程根本不是一套库</td><td>标签 <code>debugging</code></td></tr></tbody></table></div>
<p>这四篇的正文里也确实写着 debugging 这个词，但读者搜的是概念，不是原文。标签是作者手填的语义索引，比正文里的字面出现更接近「这篇文章在讲什么」。</p>
<p>只加后端还不够。结果页得把命中的词标出来，否则读者看到一个标题，不知道它为什么被搜出来——上面四个标题，没有一个长得像「调试」。</p>
<p>高亮这件事看起来是前端小事：找到关键词、包一层 <code>&lt;mark&gt;</code>。但顺序错了会有两个具体的坑，我都踩了：</p>
<ul><li><strong>先转义再匹配</strong>，query 里带 <code>&amp;</code> 或 <code>&lt;</code> 就永远匹配不到，因为它已经被换成了 <code>&amp;amp;</code> 和 <code>&amp;lt;</code>。</li><li><strong>不做正则转义</strong>，query 是 <code>c++</code> 时 <code>new RegExp</code> 直接抛 <code>Nothing to repeat</code>，整个结果列表白屏。</li></ul>
<p>这篇按顺序讲：三路 SQL 怎么写、占位符为什么必须对齐、高亮为什么先切段再逐段转义、以及中文和空词的边界。数据都是 2026-11-18 对 <code>exia.de5.net</code> 的实测。</p>
<h2 id="一-标签为什么是死角"><a class="h-anchor" href="#一-标签为什么是死角">#</a>一、标签为什么是死角</h2>
<p>最初的搜索只有两路：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">p.title LIKE ? OR p.content LIKE ?</code></pre></div>
<p>看起来够了——标题和正文都搜，还能漏什么？漏的是<strong>不在标题也不在正文里出现的词</strong>。</p>
<p>我的文章标题是「目录不跟着滚：sticky 在 grid 里失效，根因是 align-items 用了 start」，标签是 <code>css</code> <code>layout</code> <code>browsers</code> <code>css</code> <code>debugging</code>。一个读者想找「调试相关的东西」，他会敲 <code>debugging</code>，不会敲 <code>sticky</code>。这个词在标题里没有，在正文里也许提了一次，但标题和正文的 LIKE 命中率取决于作者的用词，不取决于读者的用词。</p>
<p>标签不一样。标签是我在发文时手动选的，它的作用就是「这篇归到哪一类」。读者搜的也往往是类别词，不是原文词。</p>
<p>补上第三路之后，三路是<strong>并集</strong>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">(p.title LIKE ?
 OR p.content LIKE ?
 OR p.id IN (SELECT pt.post_id FROM post_tags pt
             JOIN tags t ON t.id = pt.tag_id
             WHERE t.name LIKE ?))</code></pre></div>
<p>前两路是字面匹配，第三路是「这篇文章的标签里，有没有一个像关键词的」。</p>
<p>上线后同一个词的命中数变化：</p>
<div class="table-wrap"><table><thead><tr><th>查询词</th><th>两路（标题+正文）</th><th>三路（加标签）</th><th>多出来的</th></tr></thead><tbody><tr><td><code>debugging</code></td><td>0 篇标题命中</td><td>4 篇</td><td>4 篇全靠标签</td></tr><tr><td><code>d1</code></td><td>部分</td><td>11 篇</td><td>标签 <code>d1</code> 的文章全部进来</td></tr><tr><td><code>缓存</code></td><td>部分</td><td>7 篇</td><td>标题、正文、标签三路都有贡献</td></tr></tbody></table></div>
<p><code>缓存</code> 这个词值得单独看：它既可能出现在标题（「三层缓存怎么排」），也可能出现在正文，也可能是标签。三路命中会有重复，但 <code>OR</code> 天然去重——一篇文章只要任一路命中就进结果，不会因为三路都中而出现三次。</p>
<h2 id="二-三路-sql-与子查询口径"><a class="h-anchor" href="#二-三路-sql-与子查询口径">#</a>二、三路 SQL 与子查询口径</h2>
<p>三路条件抽成了一个纯函数，放在 <code>src/api.js</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">searchMatch</span>(q) {
  <span class="tok-k">const</span> kw = <span class="tok-s">`%${q}%`</span>;
  <span class="tok-k">return</span> {
    sql: <span class="tok-s">`(p.title LIKE ? OR p.content LIKE ? OR p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name LIKE ?))`</span>,
    args: [kw, kw, kw],
  };
}</code></pre></div>
<p>三个决定：</p>
<p><strong>第一，标签那一路用 <code>IN</code> 子查询，不是 <code>JOIN</code>。</strong> 如果用 <code>JOIN post_tags</code>，主查询的 <code>FROM</code> 就变了，一篇文章有 4 个标签就会变成 4 行，<code>COUNT(*)</code> 和分页全乱。<code>IN</code> 子查询只回答「这个 post_id 在不在集合里」，不改变主查询的行数。</p>
<p><strong>第二，子查询的口径和站内标签过滤完全一致。</strong> 站内点标签进 <code>/tag/debugging</code> 时用的也是 <code>post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?</code>。搜索这里只是把 <code>=</code> 换成 <code>LIKE</code>，连接方式一模一样。口径一致的好处是：从搜索结果点进一篇文章，再点它的标签，看到的集合是对得上的；如果两处口径不同，会出现「搜到 4 篇，点标签只有 3 篇」这种解释不清的差异。</p>
<p><strong>第三，抽成纯函数是为了单测不碰 D1。</strong> <code>searchMatch</code> 只负责拼 SQL 和参数，不执行查询。测试可以直接断言「SQL 里有三个 <code>?</code>」「参数是三个 <code>%词%</code>」，不需要起一个 D1 实例。</p>
<p>这一步还顺手解决了一个更隐蔽的问题——下一节。</p>
<h2 id="三-占位符对齐-count-和列表必须共用一段-where"><a class="h-anchor" href="#三-占位符对齐-count-和列表必须共用一段-where">#</a>三、占位符对齐：COUNT 和列表必须共用一段 WHERE</h2>
<p>列表接口返回两个数：当前页的文章，和总数。两个数来自两条 SQL：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> [listRes, countRes] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([
  db.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT ... WHERE ${whereSql} ORDER BY ... LIMIT ? OFFSET ?`</span>).<span class="tok-f">bind</span>(...args, size, offset).<span class="tok-f">all</span>(),
  db.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT COUNT(*) AS total FROM posts p WHERE ${whereSql}`</span>).<span class="tok-f">bind</span>(...args).<span class="tok-f">first</span>(),
]);</code></pre></div>
<p><code>whereSql</code> 和 <code>args</code> 是同一份。这是刻意的：如果两条 SQL 各拼一遍 WHERE，只要有一处漏了某个条件，线上表现就是<strong>搜得到但总数不对</strong>——列表 4 篇，总数写 17 篇，分页器算出 2 页，点第二页是空的。</p>
<p>更糟的是参数数量对不上：<code>whereSql</code> 里有三个 <code>?</code>，<code>args</code> 只 push 了两个，<code>bind()</code> 直接抛错，整个接口 500。</p>
<p>两种失败都很常见，而且都不容易在开发时发现——开发时搜的词往往只有一个分支命中，三个 <code>?</code> 都绑上了，看不出问题。等到线上搜一个「标题、正文、标签都命中」的词，或者一个都不命中的词，才暴露。</p>
<p>单测专门验这一条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">t</span>(<span class="tok-s">&#39;占位符数量与参数数量一致（COUNT 和列表共用 whereSql）&#39;</span>, () =&gt; {
  <span class="tok-k">const</span> { sql, args } = <span class="tok-f">searchMatch</span>(<span class="tok-s">&#39;d1&#39;</span>);
  <span class="tok-k">const</span> holes = (sql.<span class="tok-f">match</span>(/\?/g) || []).length;
  assert.<span class="tok-f">equal</span>(holes, <span class="tok-n">3</span>, <span class="tok-s">`SQL 里有 ${holes} 个 ?`</span>);
  assert.<span class="tok-f">equal</span>(args.length, holes, <span class="tok-s">&#39;参数数量与占位符不符&#39;</span>);
});</code></pre></div>
<p>这条断言很朴素，但它保的是「不会 500」。子查询里如果哪天多加一个 <code>?</code>（比如按标签权重过滤），参数忘了加，这条测试当场红。</p>
<p><code>test-search.mjs</code> 一共 6 项，全部不碰 D1：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">  ok  标题 / 正文 / 标签三路条件都进了 SQL
  ok  子查询口径与现有 tag 过滤一致（post_tags.post_id）
  ok  占位符数量与参数数量一致（COUNT 和列表共用 whereSql）
  ok  三个参数绑的是同一个 %关键词%
  ok  空关键词不抛错，参数退化为 %%
  ok  中文关键词原样保留，不转义不改写</code></pre></div>
<p>第 2 项「口径一致」和第 6 项「中文原样保留」是后补的——前者防两处 SQL 走偏，后者防有人「顺手」给中文做 URL 编码或大小写处理。</p>
<h2 id="四-高亮为什么必须先切段再逐段转义"><a class="h-anchor" href="#四-高亮为什么必须先切段再逐段转义">#</a>四、高亮为什么必须先切段再逐段转义</h2>
<p>这是整篇最容易写错的地方。高亮的实现只有 20 行，但顺序一换，行为完全不同。</p>
<p>正确的顺序是：<strong>在原文上找位置，切出片段，逐段转义，然后拼 <code>&lt;mark&gt;</code></strong>。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span><span class="code-ln">20 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
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
20</span><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">hl</span>(text, q) {
  <span class="tok-k">const</span> s = <span class="tok-f">String</span>(text ?? <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">const</span> needle = <span class="tok-f">String</span>(q || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">trim</span>();
  <span class="tok-k">if</span> (!needle) <span class="tok-k">return</span> <span class="tok-f">esc</span>(s);
  <span class="tok-k">let</span> re;
  <span class="tok-k">try</span> {
    re = <span class="tok-k">new</span> <span class="tok-f">RegExp</span>(needle.<span class="tok-f">replace</span>(/[.*+?^${}()|[\]\\]/g, <span class="tok-s">&#39;\\$&amp;&#39;</span>), <span class="tok-s">&#39;gi&#39;</span>);
  } <span class="tok-k">catch</span> {
    <span class="tok-k">return</span> <span class="tok-f">esc</span>(s);
  }
  <span class="tok-k">let</span> out = <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">let</span> last = <span class="tok-n">0</span>;
  <span class="tok-k">let</span> m;
  <span class="tok-k">while</span> ((m = re.<span class="tok-f">exec</span>(s)) !== <span class="tok-k">null</span>) {
    <span class="tok-k">if</span> (!m[<span class="tok-n">0</span>]) { re.lastIndex++; <span class="tok-k">continue</span>; }
    out += <span class="tok-f">esc</span>(s.<span class="tok-f">slice</span>(last, m.index)) + <span class="tok-s">&#39;&lt;mark&gt;&#39;</span> + <span class="tok-f">esc</span>(m[<span class="tok-n">0</span>]) + <span class="tok-s">&#39;&lt;/mark&gt;&#39;</span>;
    last = m.index + m[<span class="tok-n">0</span>].length;
  }
  <span class="tok-k">return</span> out + <span class="tok-f">esc</span>(s.<span class="tok-f">slice</span>(last));
}</code></pre></div>
<h3 id="反面一-先-esc-再匹配-query-里的-和-永远匹配不到"><a class="h-anchor" href="#反面一-先-esc-再匹配-query-里的-和-永远匹配不到">#</a>反面一：先 <code>esc</code> 再匹配，query 里的 <code>&amp;</code> 和 <code>&lt;</code> 永远匹配不到</h3>
<p>直觉的做法是「先把文本转义成安全的 HTML，再在上面找关键词包 mark」。这样写不会注入，但它有一个死的缺陷：转义之后，原文的 <code>&amp;</code> 变成了 <code>&amp;amp;</code>，<code>&lt;</code> 变成了 <code>&amp;lt;</code>。</p>
<p>你搜 <code>a&amp;b</code>，<code>needle</code> 是 <code>a&amp;b</code>，文本已经被转成 <code>a&amp;amp;b</code>——匹配不上。搜 <code>1 &lt; 2</code> 也一样。用户看到的是「搜到了这篇，但一个字都没高亮」，而他没法知道为什么。</p>
<p>这个问题在技术博客里出现频率不低：文章正文里到处都是 <code>&amp;</code>、<code>&lt;</code>、<code>&gt;</code>（比如讲 HTML 转义的文章本身）。先转义的写法在这类文章上等于高亮失效。</p>
<p>正确顺序是：原文匹配 → 切段 → 每段各自转义 → 拼起来。<code>esc(s.slice(last, m.index))</code> 转的是「命中之前的普通文本」，<code>esc(m[0])</code> 转的是「命中的词本身」。两段都转义了，但匹配是在未转义的原文上做的，所以 <code>&amp;</code> 和 <code>&lt;</code> 照样能命中。</p>
<h3 id="反面二-不做正则转义-c-直接抛错"><a class="h-anchor" href="#反面二-不做正则转义-c-直接抛错">#</a>反面二：不做正则转义，<code>c++</code> 直接抛错</h3>
<p>关键词要当正则用（为了 <code>gi</code> 做大小写不敏感、为了 <code>exec</code> 拿位置），但用户输入的词不一定是合法正则。</p>
<p>我实测了四个 query，在 Node 里直接 <code>new RegExp</code>：</p>
<div class="table-wrap"><table><thead><tr><th>query</th><th>结果</th></tr></thead><tbody><tr><td><code>c++</code></td><td>抛错 <code>Invalid regular expression: /c++/gi: Nothing to repeat</code></td></tr><tr><td><code>[x</code></td><td>抛错 <code>Invalid regular expression: /[x/gi: Unterminated character class</code></td></tr><tr><td><code>a.b</code></td><td>不抛错，但 <code>.</code> 会匹配任意字符</td></tr><tr><td><code>(x)</code></td><td>不抛错，但括号被当成捕获组</td></tr></tbody></table></div>
<p><code>c++</code> 是程序员真会搜的词。<code>+</code> 是量词，<code>c++</code> 意思是「一个 c 后面跟一个或多个 +」，语法上非法，<code>RegExp</code> 构造函数直接抛。如果不捕获这个异常，整个结果列表的渲染会中断——页面上是骨架屏永远转圈，或者一段空白。</p>
<p>所以有两道防线：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">try</span> {
  re = <span class="tok-k">new</span> <span class="tok-f">RegExp</span>(needle.<span class="tok-f">replace</span>(/[.*+?^${}()|[\]\\]/g, <span class="tok-s">&#39;\\$&amp;&#39;</span>), <span class="tok-s">&#39;gi&#39;</span>);
} <span class="tok-k">catch</span> {
  <span class="tok-k">return</span> <span class="tok-f">esc</span>(s);
}</code></pre></div>
<p>第一道是把正则元字符全部转义成字面量（<code>c++</code> → <code>c\+\+</code>），这样绝大多数情况根本不会抛。第二道是 <code>try/catch</code> 兜底：万一还有没覆盖到的语法（比如某些 Unicode 属性转义），退化成「不高亮但正常显示」，而不是整页挂掉。</p>
<p><code>a.b</code> 那种不抛错但会误匹配的情况更阴险：它不报错，只是把 <code>axb</code> 也标成命中。转义之后变成 <code>a\.b</code>，只匹配字面量。这类错误没人会来报，但会让人怀疑「高亮怎么不准」。</p>
<h3 id="零宽匹配-不跳过就是死循环"><a class="h-anchor" href="#零宽匹配-不跳过就是死循环">#</a>零宽匹配：不跳过就是死循环</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">while</span> ((m = re.<span class="tok-f">exec</span>(s)) !== <span class="tok-k">null</span>) {
  <span class="tok-k">if</span> (!m[<span class="tok-n">0</span>]) { re.lastIndex++; <span class="tok-k">continue</span>; }
  <span class="tok-c">// ...</span>
}</code></pre></div>
<p><code>m[0]</code> 为空的情况来自「能匹配零个字符」的正则。正常情况下转义后不会出现，但 <code>gi</code> 加上某些边界（比如关键词是空字符串、或者全是空白被 trim 成空）可能构造出零宽匹配。零宽匹配时 <code>re.lastIndex</code> 不前进，<code>while</code> 永远为真——浏览器直接卡死。</p>
<p>这行 <code>re.lastIndex++</code> 是保险，不是主逻辑。写它的理由很简单：这个函数在渲染循环里跑，一个死循环能让整页失去响应，代价太大。</p>
<h3 id="这里为什么不用完整的-html-清洗器"><a class="h-anchor" href="#这里为什么不用完整的-html-清洗器">#</a>这里为什么不用完整的 HTML 清洗器</h3>
<p>项目里已经有一个给正文用的清洗器（<code>sanitizeHtml</code>），它会解析 HTML、按白名单过滤标签和属性。高亮这里没有复用它，用的是最简单的 <code>esc()</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> ESC = { <span class="tok-s">&#39;&amp;&#39;</span>: <span class="tok-s">&#39;&amp;amp;&#39;</span>, <span class="tok-s">&#39;&lt;&#39;</span>: <span class="tok-s">&#39;&amp;lt;&#39;</span>, <span class="tok-s">&#39;&gt;&#39;</span>: <span class="tok-s">&#39;&amp;gt;&#39;</span>, <span class="tok-s">&#39;&quot;&#39;</span>: <span class="tok-s">&#39;&amp;quot;&#39;</span>, <span class="tok-s">&quot;&#39;&quot;</span>: <span class="tok-s">&#39;&amp;#39;&#39;</span> };
<span class="tok-k">const</span> esc = (s) =&gt; <span class="tok-f">String</span>(s || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">replace</span>(/[&amp;&lt;&gt;&quot;&#39;]/g, (c) =&gt; ESC[c]);</code></pre></div>
<p>两个理由。一是<strong>输入类型不同</strong>：高亮的输入是纯文本（标题、摘要、标签名），不是 HTML。对它跑一个 HTML 解析器，等于先假设它是 HTML 再证明它不是，多绕一圈。二是<strong>输出要可预测</strong>：<code>esc()</code> 的行为就五个字符映射，一眼能看完；<code>sanitizeHtml</code> 会重排属性、丢掉不认识的标签，用在「把一个词包进 mark」这种场景上，结果会比输入更需要解释。</p>
<p>正确的关系是分层的：<code>sanitizeHtml</code> 管正文（那部分确实有 HTML），<code>esc()</code> 管所有拼进属性的纯文本。两者不互相替代——用 <code>sanitizeHtml</code> 处理标题既慢又可能改字，用 <code>esc()</code> 处理正文会漏掉标签。</p>
<h2 id="五-三处调用与空结果出口"><a class="h-anchor" href="#五-三处调用与空结果出口">#</a>五、三处调用与空结果出口</h2>
<p><code>hl()</code> 在三个地方被调用，都是搜索结果的可见部分：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">&lt;h2&gt;${<span class="tok-f">hl</span>(p.title, currentQ)}&lt;/h2&gt;
${p.excerpt ? <span class="tok-s">`&lt;p class=&quot;excerpt&quot;&gt;${hl(p.excerpt, currentQ)}&lt;/p&gt;`</span> : <span class="tok-s">&#39;&#39;</span>}
${(p.tags || []).<span class="tok-f">slice</span>(<span class="tok-n">0</span>, <span class="tok-n">3</span>).<span class="tok-f">map</span>((t) =&gt; <span class="tok-s">`&lt;span class=&quot;tag&quot;&gt;#${hl(t, currentQ)}&lt;/span&gt;`</span>).<span class="tok-f">join</span>(<span class="tok-s">&#39;&#39;</span>)}</code></pre></div>
<p>标题、导语、标签芯片。标签芯片那处是后来补的——搜 <code>debugging</code> 时，标题和导语里一个 <code>debugging</code> 都没有，读者看到四张卡，完全不知道为什么这四篇被搜出来。标签芯片上标出 <code>#debugging</code> 并高亮，答案立刻就在眼前。</p>
<p>这也是「后端三路匹配」和「前端三处高亮」必须一起做的原因：只做后端，结果是「搜得对但看不懂」；只做前端，标签根本进不了结果集。</p>
<h3 id="为什么用-mark-而不是给-span-挂类"><a class="h-anchor" href="#为什么用-mark-而不是给-span-挂类">#</a>为什么用 <code>&lt;mark&gt;</code> 而不是给 span 挂类</h3>
<p>高亮的容器可以是 <code>&lt;span class=&quot;hl&quot;&gt;</code>，也可以是 <code>&lt;mark&gt;</code>。我选了后者，两个理由。</p>
<p>一是<strong>语义</strong>。<code>&lt;mark&gt;</code> 的 HTML 定义就是「标记出与当前上下文相关的文本」，屏幕阅读器会念出来，而 <code>&lt;span class=&quot;hl&quot;&gt;</code> 对一个读屏用户来说什么都不是。搜索结果里的高亮刚好是 <code>&lt;mark&gt;</code> 的标准用途，没有比它更贴切的元素。</p>
<p>二是<strong>默认样式</strong>。浏览器给 <code>&lt;mark&gt;</code> 自带黄底，即使 CSS 没加载出来，高亮也在。<code>&lt;span class=&quot;hl&quot;&gt;</code> 在样式表失效时就是一个普通 span，搜索命中的视觉线索全部消失。</p>
<p>配色上没写死黄色，而是跟着主题的强调色走：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">mark {
  background: color-<span class="tok-f">mix</span>(in srgb, <span class="tok-f">var</span>(--accent) <span class="tok-n">24</span>%, transparent);
}</code></pre></div>
<p><code>color-mix</code> 把强调色按 24% 混进透明背景，两套主题（亮色和暗色）不用各写一遍——暗色主题下 <code>--accent</code> 变亮，混出来的底色自动跟着变，文字对比度也保持得住。写死 <code>background: #fff3a3</code> 的话，暗色主题下会变成一块刺眼的黄斑。</p>
<h3 id="分页不能把搜索词弄丢"><a class="h-anchor" href="#分页不能把搜索词弄丢">#</a>分页不能把搜索词弄丢</h3>
<p>搜索结果翻页时，<code>q</code> 参数必须跟着走，否则第二页会退回「全部文章」：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> qs = (p) =&gt; {
  <span class="tok-k">const</span> u = <span class="tok-k">new</span> <span class="tok-f">URLSearchParams</span>();
  <span class="tok-k">if</span> (currentQ) u.<span class="tok-k">set</span>(<span class="tok-s">&#39;q&#39;</span>, currentQ);
  u.<span class="tok-k">set</span>(<span class="tok-s">&#39;page&#39;</span>, <span class="tok-f">String</span>(p));
  <span class="tok-c">// ...</span>
};</code></pre></div>
<p>这个逻辑看着理所当然，但漏了会很难查——第一页 4 篇，翻到第二页变成 17 篇，用户会以为「搜索只对第一页生效」。分页器里 <code>currentQ</code>、<code>currentCat</code>、<code>currentTag</code> 三个状态都要带上，任何一个漏了，翻页就换了一个筛选条件。</p>
<h3 id="卡片是客户端渲染的"><a class="h-anchor" href="#卡片是客户端渲染的">#</a>卡片是客户端渲染的</h3>
<p>这一点容易被忽略：搜索结果的卡片不是服务端渲染的，是前端拉接口渲染的。</p>
<p>服务端返回的 HTML 里只有骨架屏：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">html</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-html">&lt;div class=<span class="tok-s">&quot;sk-card&quot;</span>&gt;&lt;div class=<span class="tok-s">&quot;sk sk-thumb&quot;</span>&gt;&lt;/div&gt;...&lt;/div&gt;</code></pre></div>
<p>前端拿到 <code>/api/posts?q=debugging</code> 之后，用 <code>card()</code> 拼 HTML 塞进 <code>#list</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> { posts, total, pages } = <span class="tok-k">await</span> <span class="tok-f">api</span>(<span class="tok-s">&#39;/api/posts?&#39;</span> + params, { signal: mine.signal });
listEl.innerHTML = posts.<span class="tok-f">map</span>(card).<span class="tok-f">join</span>(<span class="tok-s">&#39;&#39;</span>);</code></pre></div>
<p>所以高亮发生在浏览器里，<code>hl()</code> 是前端函数。服务端也有一份 <code>postCard</code>，用于首页和栏目页的 SSR，那份<strong>不带高亮</strong>——因为 SSR 的列表页不涉及搜索词，不需要。</p>
<p>这条分工带来一个好处：搜索是实时的，输入框 320ms 防抖，不用整页刷新。代价是高亮逻辑必须在客户端跑一遍，而且要考虑 <code>AbortController</code>——用户快速改词时，前一个请求的结果不能覆盖后一个。代码里用 <code>mine !== ctrl</code> 判断，过期的响应直接丢掉。</p>
<p>竞态这件事不处理会有很具体的症状：输入 <code>rus</code> 之后马上改成 <code>rust</code>，两个请求并发发出，如果 <code>rus</code> 的响应后到，列表里显示的是「rus 的结果」，而输入框里写着「rust」。用户看到的是「搜索不准」，实际上是响应顺序的问题。<code>AbortController</code> 在发新请求时 abort 旧的，再加上 <code>mine !== ctrl</code> 双重判断，两条防线。</p>
<h3 id="客户端渲染带来的-seo-代价"><a class="h-anchor" href="#客户端渲染带来的-seo-代价">#</a>客户端渲染带来的 SEO 代价</h3>
<p>搜索结果是客户端渲染的，这意味着一件事：<strong>爬虫抓这一页时，拿不到任何结果</strong>。它看到的只有骨架屏。</p>
<p>所以搜索结果页直接标了 <code>noindex,follow</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> isSearch = !!(url &amp;&amp; (url.searchParams.<span class="tok-k">get</span>(<span class="tok-s">&#39;q&#39;</span>) || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">trim</span>());
<span class="tok-c">// ...</span>
isSearch ? <span class="tok-s">`&lt;meta name=&quot;robots&quot; content=&quot;noindex,follow&quot;&gt;`</span> : <span class="tok-s">&#39;&#39;</span>,</code></pre></div>
<p>两个决定都在里面。<code>noindex</code> 是因为「搜索结果页」对搜索引擎没有价值——它是查询的产物，不是内容本身，让爬虫反复抓 <code>?q=xxx</code> 的各种组合纯属浪费抓取配额。<code>follow</code> 是保留下来的：结果里的文章链接值得被发现，尤其对一个小站，每一条额外入链都有用。</p>
<p>这条也和「先做后端还是先做前端」的取舍有关：如果搜索页做 SSR，爬虫能拿到结果，但每次搜索都要回源打 D1，实时性和成本都变差；做客户端渲染，搜索体验好，代价是这一页对 SEO 没贡献。对一个内容站，后者的代价可以接受——搜索页本来就不该是落地页。</p>
<h3 id="空结果不能只说一句-没找到"><a class="h-anchor" href="#空结果不能只说一句-没找到">#</a>空结果不能只说一句「没找到」</h3>
<p>搜不到东西时，原来的实现是一行字：「没有找到匹配的文章」。这句话的问题不是不礼貌，是<strong>没给下一步</strong>。</p>
<p>现在空结果页是这样：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">emptySearch</span>() {
  <span class="tok-k">return</span> <span class="tok-s">`&lt;div class=&quot;empty empty-search&quot;&gt;
    &lt;p class=&quot;es-t&quot;&gt;没有找到与「${esc(currentQ)}」相关的文章&lt;/p&gt;
    &lt;p class=&quot;es-h&quot;&gt;试着换个更短的关键词，或者从栏目、标签翻进去。&lt;/p&gt;
    &lt;div class=&quot;es-acts&quot;&gt;
      &lt;a class=&quot;btn sm&quot; href=&quot;/&quot;&gt;看全部文章&lt;/a&gt;
      &lt;a class=&quot;btn sm&quot; href=&quot;/archive&quot;&gt;按时间归档&lt;/a&gt;
    &lt;/div&gt;
  &lt;/div&gt;`</span>;
}</code></pre></div>
<p>三件事：回显关键词（让用户确认自己搜的是什么，而不是怀疑输入框吞了字）、给一个改词的建议、给两条明确的出口。</p>
<p><code>check-ux.mjs</code> 用 Puppeteer 真跑一遍浏览器，验三条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">t</span>(r.cards &gt; <span class="tok-n">0</span>, <span class="tok-s">`搜索「${KEY}」有结果（${r.cards} 篇）`</span>);
<span class="tok-f">t</span>(r.marks.length &gt; <span class="tok-n">0</span>, <span class="tok-s">`结果里出现 &lt;mark&gt; 高亮（${r.marks.length} 处）`</span>);
<span class="tok-f">t</span>(r.marks.<span class="tok-f">every</span>((m) =&gt; m.<span class="tok-f">toLowerCase</span>().<span class="tok-f">includes</span>(KEY.<span class="tok-f">toLowerCase</span>())),
  <span class="tok-s">&#39;每个 &lt;mark&gt; 都正好是关键词，没有把整句圈进去&#39;</span>);</code></pre></div>
<p>第三条最有用。它防的是「正则写宽了，把整段文字包进 mark」——那种情况下高亮确实存在，但视觉上整段变色，等于没有高亮。这条断言要求每个 <code>&lt;mark&gt;</code> 的文本都必须包含关键词，写宽了当场失败。</p>
<p>空结果那一段也是三条：有结构化提示、提示里回显关键词、至少给两个出口链接。</p>
<h2 id="六-边界-中文-空词-大小写-元字符"><a class="h-anchor" href="#六-边界-中文-空词-大小写-元字符">#</a>六、边界：中文、空词、大小写、元字符</h2>
<h3 id="中文-like-的实际行为"><a class="h-anchor" href="#中文-like-的实际行为">#</a>中文 LIKE 的实际行为</h3>
<p><code>LIKE &#39;%缓存%&#39;</code> 在 SQLite 里是字节级子串匹配，对中文没有分词——它能匹配「缓存」出现在任何位置，但匹配不了「缓存」的同义词。</p>
<p>实测结果：</p>
<div class="table-wrap"><table><thead><tr><th>查询词</th><th>命中数</th><th>说明</th></tr></thead><tbody><tr><td><code>缓存</code></td><td>7 篇</td><td>标题、正文、标签三路都有贡献</td></tr><tr><td><code>d1</code></td><td>11 篇</td><td>标签 <code>d1</code> 的文章全部进来</td></tr><tr><td><code>DEBUGGING</code></td><td>4 篇</td><td>全大写，和 <code>debugging</code> 结果一致</td></tr><tr><td><code>Debugging</code></td><td>4 篇</td><td>混合大小写，同上</td></tr><tr><td><code>c++</code></td><td>0 篇</td><td>字面匹配，站内确实没有这个字符串</td></tr><tr><td>空</td><td>17 篇</td><td>全部文章（空词在调用方就被挡掉，不进 SQL）</td></tr></tbody></table></div>
<p><code>DEBUGGING</code> 和 <code>Debugging</code> 都返回 4 篇，是因为 SQLite 的 <code>LIKE</code> 对 ASCII 字母默认不区分大小写。中文没有大小写，这条对中文无影响，但对英文标签很重要——用户不会记得标签是小写还是大写。</p>
<h3 id="空词在调用方挡掉-不在-sql-里挡"><a class="h-anchor" href="#空词在调用方挡掉-不在-sql-里挡">#</a>空词在调用方挡掉，不在 SQL 里挡</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (q) {
  <span class="tok-k">const</span> m = <span class="tok-f">searchMatch</span>(q);
  where.<span class="tok-f">push</span>(m.sql);
  args.<span class="tok-f">push</span>(...m.args);
}</code></pre></div>
<p><code>q</code> 为空时，<code>searchMatch</code> 根本不会被调用，SQL 里不会出现那三个 <code>?</code>。这比在 SQL 里写 <code>LIKE &#39;%%&#39;</code> 好——后者虽然也能返回全部，但它是一次全表扫描，而且 <code>COUNT</code> 也要跟着扫。</p>
<p><code>searchMatch(&#39;&#39;)</code> 单独调用时不会抛错（参数退化成 <code>%%</code>），这是给单测留的容错，不是给调用方用的。线上路径上，空词压根到不了这一步。</p>
<h3 id="元字符-后端不炸-前端靠兜底"><a class="h-anchor" href="#元字符-后端不炸-前端靠兜底">#</a>元字符：后端不炸，前端靠兜底</h3>
<p><code>c++</code> 在后端是安全的：<code>LIKE &#39;%c++%&#39;</code> 里的 <code>+</code> 是字面量，不是量词。实测返回 0 篇，因为站内没有 <code>c++</code> 这个字符串，但不会报错。</p>
<p>真正会炸的是前端 <code>hl()</code>，前面已经讲过——<code>new RegExp(&#39;c++&#39;, &#39;gi&#39;)</code> 抛 <code>Nothing to repeat</code>。所以同一次搜索里，后端能正常返回结果，前端渲染时才可能挂。这类「后端绿、前端炸」的问题，光测接口发现不了，必须跑浏览器。</p>
<h3 id="标签大小写归一"><a class="h-anchor" href="#标签大小写归一">#</a>标签大小写归一</h3>
<p>标签在入库时已经统一小写（seed 白名单里全是小写）。所以库里不会有 <code>Debugging</code> 和 <code>debugging</code> 两个标签。</p>
<p>但搜索时用户可能输入任何大小写。<code>LIKE</code> 对 ASCII 不区分大小写，所以 <code>Debugging</code> 能匹配到 <code>debugging</code> 标签。这算是免费得到的行为，但依赖数据库的 collation 默认值——如果哪天换成别的数据库，或者 <code>LIKE</code> 走了 <code>BINARY</code> collation，这个行为就没了。</p>
<p>单测第 6 项「中文关键词原样保留」防的是另一个方向：有人在传参时对中文做了 <code>encodeURIComponent</code> 或 <code>toLowerCase</code>，导致 <code>%缓存%</code> 变成 <code>%E7%BC%93%E5%AD%98%</code>，永远匹配不到。</p>
<h3 id="搜索埋点-防抖会骗你"><a class="h-anchor" href="#搜索埋点-防抖会骗你">#</a>搜索埋点：防抖会骗你</h3>
<p>搜索是有埋点的（<code>window.__ev(&#39;search&#39;, q)</code>），但这条埋点写不写、怎么写，直接决定后台看到的数字有没有意义。</p>
<p>输入框是 320ms 防抖的。一个输入「rust」的人，会依次触发 <code>r</code>、<code>ru</code>、<code>rus</code>、<code>rust</code> 四次查询——如果每次都上报，后台记录的不是搜索意图，是打字速度。所以上报前加了两道：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (currentQ &amp;&amp; page === <span class="tok-n">1</span> &amp;&amp; currentQ !== lastQ) {
  lastQ = currentQ;
  <span class="tok-k">if</span> (window.__ev) window.<span class="tok-f">__ev</span>(<span class="tok-s">&#39;search&#39;</span>, currentQ);
}</code></pre></div>
<p>只在第一页报（翻页不算新搜索）、同一个词只报一次（<code>lastQ</code> 比对）。服务端还有一层「同人同日同词」去重，两道一起才干净。</p>
<p>这件事和搜索质量的关系比看起来要紧：如果埋点记的是半截词，你按搜索词排序看热门查询，会得到一堆 <code>r</code>、<code>ru</code> 这样的碎片，然后误判「用户都在搜什么单词」。数据脏了，后面所有基于它的判断都是错的。</p>
<h3 id="规模上限-词-走不了索引"><a class="h-anchor" href="#规模上限-词-走不了索引">#</a>规模上限：<code>%词%</code> 走不了索引</h3>
<p>三路条件全是 <code>LIKE &#39;%词%&#39;</code>，前置通配符意味着 B-tree 索引完全用不上，每次搜索都是全表扫描。</p>
<p>31 篇文章的表，这件事的代价可以忽略——<code>posts</code> 表就这么点行，扫一遍比走索引的额外开销还小。但这是个明确的天花板：行数到几千、正文又长的时候，每次搜索都要把全部正文读一遍做子串匹配，CPU 时间和内存都会顶上来。</p>
<p>真要往上走，换 FTS5（SQLite 全文索引）是标准答案，D1 支持建虚表。但那是另一个工程量级：要维护索引表、要处理中文分词（FTS5 默认的 <code>unicode61</code> 分词器不切中文词）、要在增删改文章时同步。当前这个站的实际搜索量一天个位数，上 FTS5 属于为一个不存在的问题写代码。</p>
<p>把上限写在这里，是为了下次搜索变慢时不用重新推导一遍——先看表有多大，再决定要不要换。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>四条命令，从纯函数到真实浏览器，都不需要改代码。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1) 三路 SQL 与占位符对齐（6 项，不碰 D1）</span>
<span class="tok-k">node</span> scripts/test-search.mjs

<span class="tok-c"># 2) 接口层：标签命中的真实条数</span>
<span class="tok-k">curl</span> -s -G <span class="tok-s">&quot;https://exia.de5.net/api/posts&quot;</span> \
  --data-urlencode <span class="tok-s">&quot;q=debugging&quot;</span> --data <span class="tok-s">&quot;size=20&quot;</span> | <span class="tok-k">grep</span> -oE <span class="tok-s">&#39;&quot;total&quot;:[0-9]+&#39;</span>

<span class="tok-c"># 3) 大小写与中文边界</span>
<span class="tok-k">for</span> q in DEBUGGING Debugging 缓存 d1; <span class="tok-k">do</span>
  printf <span class="tok-s">&quot;%-12s &quot;</span> <span class="tok-s">&quot;$q&quot;</span>
  <span class="tok-k">curl</span> -s -G <span class="tok-s">&quot;https://exia.de5.net/api/posts&quot;</span> --data-urlencode <span class="tok-s">&quot;q=$q&quot;</span> --data <span class="tok-s">&quot;size=20&quot;</span> \
    | head -c <span class="tok-n">200</span> | <span class="tok-k">grep</span> -oE <span class="tok-s">&#39;&quot;total&quot;:[0-9]+&#39;</span>
<span class="tok-k">done</span>

<span class="tok-c"># 4) 浏览器里验高亮：有没有 mark、每个 mark 是不是关键词、空结果有没有出口</span>
<span class="tok-k">node</span> scripts/check-ux.mjs https:<span class="tok-c">//exia.de5.net --q debugging</span></code></pre></div>
<p>第 4 条必须有，因为高亮是客户端行为。第 2 条和第 4 条要一起看：接口返回 4 篇、浏览器里 4 张卡都有 <code>&lt;mark&gt;</code>，才算这条链路完整。只有接口对、页面没高亮，说明 <code>hl()</code> 没被调用或者 <code>currentQ</code> 没传下去；只有页面有高亮、接口条数不对，说明图省事在前端本地过滤了，绕过了后端的三路匹配。</p>
<p>收尾给一个手验的办法，验正则兜底：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 浏览器地址栏里打开，确认页面不白屏、卡片正常显示、只是没有 mark</span>
https:<span class="tok-c">//exia.de5.net/?q=c%2B%2B</span></code></pre></div>
<p><code>c++</code> 这个词站内没有，结果是空列表 + 空结果提示。要验的是它<strong>不报错</strong>——控制台里不该有 <code>Invalid regular expression</code> 的未捕获异常。这条最容易在改了 <code>hl()</code> 之后回归，而且不会有人主动来报。</p>', '', 'tools', '三路 SQL 让标签进结果集；前端 hl() 先切段、逐段 esc、再包 mark。c++ 直接 new RegExp 会抛错，先 esc 再匹配会让 & 失配。',
        '', 0, 0, 0, 1, '2027-02-10 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('javascript') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'search-highlight-xss' AND t.name = 'javascript';
INSERT INTO tags (name) VALUES ('xss') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'search-highlight-xss' AND t.name = 'xss';
INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'search-highlight-xss' AND t.name = 'security';

