## 结论

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
const splitTags = (s) => (s ? String(s).split('\u001f').filter(Boolean) : []);
const stamp = (r) => String(r.published_at || r.created_at || '');

export function rankRelated(post, candidates, limit = 3) {
  if (!post || !candidates || !candidates.length) return [];
  const mine = new Set(post.tags || []);
  const cat = post.category || '';
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

- **`char(31)` 分隔标签，不用逗号。** 31 是 ASCII 的 US（unit separator），标签名里不可能出现，但标签名里允许有逗号。用逗号拼 `tag_str` 再 `split(',')`，遇到 `#c++` 这类标签就断了。
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
WHERE p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}
  AND (p.category = (SELECT category FROM posts WHERE slug = ?)
       OR EXISTS (
         SELECT 1 FROM post_tags a JOIN post_tags b ON a.tag_id = b.tag_id
         WHERE a.post_id = p.id
           AND b.post_id = (SELECT id FROM posts WHERE slug = ?)
       ))
ORDER BY COALESCE(NULLIF(p.published_at, ''), created_at) ASC
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
  curl -s "https://exia.de5.net/p/$slug" | grep -oE '/tag/[^"]+"[^>]*>#[^<]+'
done
```

抓出来的标签列表里，每篇的标签都出现**两遍**——页面顶部的元信息区和底部的文章标签栏各渲染一次。这个重复本身不是 bug，但它让我意识到一件事：页面上能看到的标签，和 `post.tags` 这个 JS 变量是不是一回事，还得往回追。

于是做了第二件事：拿真实 D1 候选，在本地直接跑 `rankRelated`，看它应该排出什么：

```js
const rows = /* 上一节那条 SQL 的 D1 返回 */;
const post = { slug: 'worker-cron-friend-check',
               category: 'tools',
               tags: ['cloudflare', 'd1', 'workers', 'cache'] };
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
ok('跨栏目同标签文章排第一（标签交集真生效）',
  relHrefs[0] === '/p/worker-render-549-to-96', `实际第一张 ${relHrefs[0]}`);
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
  if (!list || !list.length) return '';
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
ok('有标签文章渲染相关推荐区块', withTags.body.includes('class="post-related"'));
ok('相关推荐链接格式正确', relHrefs.length === cards.length && ...);
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
  ${meta ? `<span class="rel-m">${esc(meta)}</span>` : ''}
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
ok('无标签无栏目文章不渲染相关推荐', !noTags.body.includes('class="post-related"'));
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
     AND (p.category=(SELECT category FROM posts WHERE slug='worker-cron-friend-check')
          OR EXISTS (SELECT 1 FROM post_tags a JOIN post_tags b ON a.tag_id=b.tag_id
                     WHERE a.post_id=p.id
                       AND b.post_id=(SELECT id FROM posts WHERE slug='worker-cron-friend-check')))
   ORDER BY COALESCE(NULLIF(p.published_at,''),created_at) ASC"

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
ok('有相关推荐区块', body.includes('class="post-related"'));

// 行为断言：只有排序真按标签交集走才会过
ok('跨栏目同标签排第一', relHrefs[0] === '/p/worker-render-549-to-96');
```

原来的探针 5 项里有 4 项是结构断言，只有「不含当前文章」算半个行为断言。这次补的第 6 项才是第一条真正验证业务语义的。断言写什么，取决于你想让测试在什么时候响——**测试响的时机不对，比没有测试更浪费时间**，因为会养出「测试全绿就没事」的习惯。

这也是为什么这篇文章值得单独写一篇：功能实现只花了 41 行纯函数，让它真正工作的是 5 行线上探针，而发现它需要的是「线上结果和本地复刻对不上」这一个信号。三件事里没有一件写在功能代码里。
