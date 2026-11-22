## 结论

今天把投稿审核这条线做完，本地和线上各跑了一遍。结论摆在前面：审核态不能放在作者自己能写的字段上，也不能只挡住列表——单篇入口和缓存是两条独立的旁路，漏掉任何一条，这套审核就等于没做。

线上现在的身份构成很简单，1 个管理员（uid=1）和 1 个普通用户（uid=2）。需求是普通用户能登录写文章，但别人发的稿子要管理员通过才在首页显示。动手前我以为这是"加个开关、默认关上"的小事，做完才发现真正的工作量不在加字段，在把作者能碰到的每一条出口堵上。整套改动落在提交 `002425b`，迁移文件是 `migrations/0002_review_status.sql`，下面引的行号都以这个版本为准。

我第一反应是复用 `hidden`。它本来就叫"不列入首页"，语义看着几乎一样。但翻编辑器保存逻辑，`hidden` 是作者随时能改回 0 的字段——投稿人点一下保存就把自己的稿子放行了。拿它当审核态，等于把钥匙交给被审的那个人。

审核态改由新增的 `posts.review_status` 承载，三态 `approved` / `pending` / `rejected`，作者不可写，只有管理员的审核 API 能改。默认值取 `approved` 是为了不误伤存量：线上总行数 36 篇（含定时和私密），公开数是 19 篇，这两个口径得分开讲——默认值保的是那 36 篇不集体消失，不是那 19 篇。

还有一条比字段更要命的旁路是缓存。单篇正文会进一个 45 秒的实例级 LRU（`postcache.js` 里 `TTL = 45_000`），作者预览一次就把 pending 正文写进缓存，匿名访客紧接着读缓存就绕过了闸门。所以闸门不能只写在 SQL 里，还得写进"这篇要不要缓存"这个决定里。

把这套设计抽象成一张检查清单，其实就三问：状态放在谁写不到的地方、列表和单篇是不是各有一道闸、缓存写入条件里有没有带审核态。三问都答"是"，审核才成立；少答一问，就留下一条旁路。下面按我实际踩坑的顺序拆开。

## 一、hidden 不是审核态

`hidden` 的历史比审核这条需求早得多。它最初的用途是"这篇还没写好，先别上首页"，属于作者自控的下架开关。编辑器里它就是一个复选框，保存文章时跟着正文一起提交，服务端照单全收：

```js
const isHidden = body.hidden !== undefined ? (body.hidden ? 1 : 0) : p.hidden;
// ... 组装进 UPDATE
UPDATE posts SET ... hidden=?, ... WHERE id=?
```

"作者可控"这四个字是问题的全部。一个 `is_admin=0` 的普通用户对自己发的稿子有完整编辑权，`hidden` 当然在其中。假如审核态就是 `hidden=1`，投稿人把复选框取消勾选再保存，状态立刻变回公开——不需要调任何审核接口，也不需要绕权限，就是编辑器里一次再正常不过的操作。

更隐蔽一点的情况是驳回。审核人把稿子打回，如果状态存在 `hidden` 里，那作者"改回可见"和"重新送审"是同一个动作，系统分不清他到底是修好了还是硬放行。审核结论必须绑定内容版本，而这个绑定关系不可能建立在一个作者随时能覆写的字段上。

所以我没动 `hidden` 的语义，另外加了 `posts.review_status`：

```sql
ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_posts_review ON posts(review_status);
```

三态的分工写进迁移注释里了。`approved` 是公开可见，`pending` 是作者可见、读者不可见，`rejected` 是作者可见、读者不可见但作者改完能重新提交。关键在于这个字段不出现在编辑器的可写集合里——更新文章时它由服务端根据 `u.is_admin` 算出来，不读请求体里的任何值。

```js
// 管理员写的是已通过；普通用户的稿子进来先待审
const review = u.is_admin ? 'approved' : 'pending';
```

默认值这一步我是慎重的。迁移上线时线上已有 36 行文章，其中公开的是 19 篇，剩下的含定时稿和私密稿。如果默认 `pending`，这 36 篇会集体从首页消失，等着逐篇人工放行——那不是上线，是事故。默认 `approved` 让历史数据和管理员新建的文章直接是"已通过"，只有普通用户新建时显式写 `pending` 的才进队列。索引 `idx_posts_review` 是给待审查询用的，三态基数小，主要是让管理视图的 `WHERE review_status='pending'` 别全表扫。

还有一个容易混淆的点：`hidden` 和 `review_status` 是正交的两个开关，不是替代关系。管理员照样能用 `hidden` 把自己写的稿子从首页撤下，这件事和审核态无关；反过来，一篇通过审核的文章也可以被作者设成 hidden。把它们拆成两个字段，语义各管各的，排查问题时才不会互相污染。

## 二、两个闸门，别混用

可见性判断收口成两个 SQL 片段，定义在 `src/api.js` 大约 204 到 217 行。这两个函数名字很像，用途完全不同，混用就是后面第三节那个坑的来历。

```js
/* 纯时间闸门：只管「发布时间到了没」，不掺审核态。
   管理视图（待审队列、定时队列）用它——那些地方本来就是要看未公开/未到点的稿子。 */
export function timeGateSql(a = 'p') {
  return `COALESCE(NULLIF(${a}.published_at, ''), ${a}.created_at) <= datetime('now')`;
}

export function liveSql(a = 'p') {
  /* 公开闸门 = 时间到了 + 审核通过 */
  return `${timeGateSql(a)} AND ${a}.review_status = 'approved'`;
}
```

`timeGateSql` 只回答一个问题：这篇稿子的发布时间到了没有。`COALESCE(NULLIF(published_at,''), created_at)` 的意思是，定时发布时间为空的老文章退回用创建时间，和列表排序用的是同一个表达式，不会出现"排序觉得它该在前、闸门觉得它还没到"的错乱。SQLite 同一条语句里的 `datetime('now')` 是常量，不会逐行重新求值，这点我在注释里也标了。

`liveSql` 是在时间闸门上再叠一层 `review_status='approved'`。所有公开出口都调它——首页、归档、标签、分类、系列、RSS、sitemap、404 页推荐文章，一处加条件就全挡住。比如归档查询的 WHERE 就是这么拼的：

```js
const where = ['p.is_private = 0', 'p.hidden = 0', liveSql('p')];
```

两个闸门的分工我列了个表，贴在这儿免得自己以后又混：

| 闸门 | 条件 | 管什么 | 用在哪 | 能不能看到 pending |
|---|---|---|---|---|
| `timeGateSql` | 发布时间 ≤ now | 只管定时 | 待审队列、定时队列（管理视图） | 能 |
| `liveSql` | 时间闸门 + `review_status='approved'` | 定时 + 审核 | 首页/归档/标签/分类/系列/RSS/sitemap/404 推荐 | 不能 |

这里有个边界要说死：`liveSql` 只守列表查询。单篇文章是独立查询，不走 `liveSql`，所以列表挡住了不等于单篇挡住了——这是第 663 行那道闸门要管的事。把"列表可见性"当成"全站可见性"来推理，是我这次最容易犯的错。

`liveSql` 这种收口写法还有个实际好处：新增出口时不容易漏。404 页的推荐文章、系列目录的上下篇，这些地方当初也是查列表时顺手接上 `liveSql` 的。如果每个出口各写一遍 WHERE，总有一处会在某个周末被改成"临时看看数据"，然后忘了改回来。一处定义、多处调用，省的不是代码行数，是"哪天又漏了一个出口"的风险。

## 三、待审队列为什么是空的

闸门拆开之后，我第一次把待审队列接上去，页面一直显示"没有待审文章"。库里明明有 pending 的稿子。第一反应是查身份判断，怀疑 `requireAdmin` 没放行；查完不是。第二反应是查时间条件，怀疑定时稿没到点；也不是。真正的原因很蠢：待审队列自己用了 `liveSql()`。

`liveSql()` 的定义里带着 `review_status='approved'`，而待审队列要找的恰恰是 `review_status='pending'`。两个条件一叠加，结果集恒为空——待审稿被自己的闸门过滤掉了。队列永远空，不是没数据，是查询条件自相矛盾。

修正方式是把队列换成只过时间闸门的 `timeGateSql()`，审核态条件由队列自己的 `WHERE review_status='pending'` 提供。接口在 `src/api.js` 大约 550 到 568 行：

```js
if (path === '/review/pending' && method === 'GET') {
  const { res } = await requireAdmin(env, request);
  if (res) return res;
  const { results } = await db
    .prepare(
      `SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN}
       WHERE p.review_status = 'pending' AND ${timeGateSql('p')}
       ORDER BY p.updated_at ASC LIMIT 200`
    )
    .all();
  return json({ ok: true, posts: results.map(...) });
}
```

队列为什么也要过时间闸门，这里顺便说清。一个普通用户把文章的发布时间设到明天，那是他自己还没准备发，不该堵在审核队列里占管理员的注意力；他真要送审，把发布时间设成现在或过去就行。所以队列条件是"pending 且已到发布时间"。`rejected` 不进队列——它已经处理过了，作者改稿会自动回到 `pending`，那时候自然重新入队。

`LIMIT 200` 是个保守上限。这个站一天来不了几篇投稿，200 够了；真到了 200 篇待审，问题不是查询而是该换个工作流。排序用 `updated_at ASC`，先改的先审，避免后提交的插队把前面的饿死。

## 四、缓存是第二条旁路

列表闸门和单篇闸门都挡住之后，我差点漏掉缓存。这篇站点对单篇正文做两层缓存，浏览器层之外还有两层是我能碰到的：Worker 实例级的 LRU 和边缘缓存。前者在 `postcache.js`，TTL 是 45 秒（`TTL = 45_000`）；后者是 Cloudflare 的 edge cache，TTL 300 秒（5 分钟，`cache.js` 的 `EDGE_TTL = 300`）。[三层缓存那篇](/p/three-layer-cache)把这三层的分工讲过，这里只讲跟审核有关的部分。

问题出在实例级 LRU 的写入条件。原来 `servePostPage` 拿到 bundle 就无条件 `postCacheSet`，不管这篇过没过审。于是有了一条很具体的旁路：作者用自己账号预览一次 pending 稿，正文进缓存；匿名访客紧接着请求同一个 slug，命中缓存直接返回，连数据库都不查，闸门自然也就不存在了。45 秒的窗口足够让一次预览变成一次泄露。

修法是在写缓存的地方加审核态判断，`src/index.js` 大约 1010 到 1017 行：

```js
/* 私有 / 未过审的文章不进实例缓存：
   私有正文没必要在内存多留 45 秒；未过审的更危险——作者预览过一次后
   缓存里就有正文了，匿名访客读缓存会绕过下面那道审核闸门。边缘缓存另算，
   那边的清理由审核 API 的 bust() 负责。 */
if (post && !post.is_private && post.review_status === 'approved') postCacheSet(slug, b);
```

这里要强调一点：这句判断和 1058 到 1069 行那道 SSR 审核闸门是两回事。闸门决定"这次请求要不要返回 404"，缓存判断决定"这篇要不要留在本实例内存里给下次用"。只做前者，pending 稿第一次请求确实被 404 挡住了，但作者预览那次是带身份的、会被放行，放行那次就把正文写进了缓存——匿名访客吃到的是那次预览的缓存。两处必须同时加。

边缘缓存的清理走另一条路。实例级 LRU 是 Worker 内存，重启即失；边缘缓存跨请求存在，靠 TTL 和主动清除。审核通过或驳回之后，`/api/review/:id` 会调 `bust()` 主动把相关路径的边缘缓存清掉，不等那 300 秒自己过期。两张表把这条线说清：

| 缓存层 | 位置 | TTL | 未过审怎么挡 | 审核后怎么清 |
|---|---|---|---|---|
| 实例 LRU | Worker 内存 | 45 秒 | `postCacheSet` 条件拒绝写入 | 不清理，本来就没写进去 |
| 边缘缓存 | Cloudflare edge | 300 秒 | 不缓存未过审响应 | 审核 API 调 `bust()` 主动清 |

这里还有个容易想当然的地方：实例级 LRU 是 Worker 内存，不跨实例、冷启清零，所以同一篇稿子在不同边缘节点上的缓存状态可能不一样。拿它当"这篇已经审核过"的依据是错的——它连自己是不是还活着都保证不了。授权判断必须每次查库，缓存只负责省那一次查询，不负责作决定。

坦白一句：缓存旁路这一条我没有单独构造一次"作者预览→匿名命中"的复现实验，是按 `postCacheSet` 的调用路径和缓存命中顺序推断出来的。四路验证里匿名单篇确实不可见，但那是在加了缓存判断之后跑的；如果只测四路、不看缓存写入条件，这个洞会一直留着。这条没测，只到推断为止。

## 五、四路验证

闸门和缓存都改完，我在本地和线上各跑了一遍全链路。验证不是看代码"觉得对"，是把 pending 稿按四种对外出口挨个试，看匿名身份到底能不能拿到内容。四路是：匿名列表、单篇 API、SSR 页面、对外清单（RSS 与 sitemap 算一路，它们都是给聚合器和爬虫看的公开目录）。

测试稿用 uid=2 那个普通用户账号发，正文是明确的探针内容，发完确认状态是 `pending`。然后切匿名身份逐路请求，记录每一项的表现；再由 uid=1 审核通过，重复一遍；再驳回，再重复一遍。所有请求都带真实状态码，不看页面截图猜。

| 出口 | pending（匿名） | approved | rejected（匿名） |
|---|---|---|---|
| 匿名列表（首页/归档） | 不出现 | 出现 | 不出现 |
| 单篇 API `/api/posts/:slug` | 404 `文章不存在` | 200 | 404 `文章不存在` |
| SSR 页面 `/p/:slug` | 404 `文章还在审核中` | 200 | 404 `文章还在审核中` |
| RSS + sitemap | 不含该条 | 含该条 | 不含该条 |

把 RSS 和 sitemap 并成一路，不是图省事。爬虫和聚合器不会带登录 cookie，在服务端看来它们就是最纯粹的匿名身份，而且抓取频率比人高得多——一篇 pending 稿要是进了 sitemap，可能在你发现之前就被抓进索引。所以这两项虽然不是"页面"，验证优先级反而排在最前。

单篇 API 的闸门在 `src/api.js` 大约 674 到 676 行，判断写得比列表更严：猜到 slug 的匿名请求直接 404，连"文章存在但需审核"这种提示都不给。作者本人和管理员是例外，用 `user.id === p.author_id || user.is_admin` 放行，方便预览。

```js
const owner = user && (user.id === p.author_id || user.is_admin);
if (p.review_status && p.review_status !== 'approved' && !owner) return err('文章不存在', 404);
```

SSR 那条走的是 `servePostPage`，逻辑一样，只是把 404 换成走 `notFoundPage`，提示文案是"文章还在审核中"。这里有个我特意留意过的细节：不能给 pending 稿返回"审核中"之外的任何区分信息，否则别人拿 slug 轮询就能探出站里有哪些未公开投稿。所返回的文案对"不存在"和"审核中"做了区分（API 用"文章不存在"，SSR 用"还在审核中"），但没有暴露作者、时间和内容。

实测四路在 pending 下全部不可见，approve 后全部可见，reject 后全部回到不可见。测试稿在跑完之后删掉了，线上公开数回到 19 篇——和动手前一致。这一步我认为比"写了多少行代码"更重要：审核这种功能，验证的价值全在"匿名视角下到底看不看得见"，不在实现看起来严不严密。

## 六、改稿重置与驳回重提

审核通过后还有个坑：投稿人把一篇过审文章的正文偷换成广告或违规内容。如果审核态停在 `approved` 不跟着内容变，那么"先发一篇无害的过审，再改正文"就能绕过整条审核线。所以普通用户每次保存文章，状态都无条件退回 `pending`，`src/api.js` 大约 802 到 807 行：

```js
/* 审核态跟着这次保存走：
   - 普通用户改稿（哪怕只改一个字）一律退回 pending —— 否则「先发篇无害的过审，
     再偷偷把正文换成广告/违规内容」就绕过了审核。审核结论必须绑定内容版本。
   - 管理员编辑视为认可，直接 approved。 */
const review = u.is_admin ? 'approved' : 'pending';
```

"哪怕只改一个字"是字面意思，更新接口不做"内容是否实质变化"的判断，只要走了保存就重置。这么做牺牲了一点便利：作者改个错别字也要重新过审。但反过来，一旦引入"小改动不重置"的豁免，就给了绕过审核的口子——而判断什么是"小改动"本身又是个可被利用的规则。我选了笨但严的那边。

管理员编辑视为认可，这条是权限模型决定的：管理员本来就能直接审核，他改稿时没必要再把自己写的东西打回待审。审核通过和驳回走专门的接口，不混在普通文章保存里：

```js
if (/^\/review\/\d+$/.test(path) && method === 'POST') {
  const { res } = await requireAdmin(env, request);
  if (res) return res;
  const id = parseInt(path.split('/')[2], 10);
  const action = String(body.action || '');
  if (action !== 'approve' && action !== 'reject') return err('action 只能是 approve 或 reject');
  // ... 更新 review_status
  if (ctx) ctx.waitUntil(bust(url, [p.slug]).catch(() => {}));
  return json({ ok: true, id, review_status: next });
}
```

`action` 只认 `approve` 和 `reject` 两个值，其他一律报错，避免拼错字符串时静默走到某个默认分支。状态写完之后调 `bust()` 清边缘缓存，这样通过后刷新就能看到，不用等那 300 秒。实测里 reject 之后单篇立刻变 404、作者改稿立刻回 pending 重入队，都走的这条路径。

后台这边加了三处入口。`/admin/review` 是审核页，列出已到发布时间的 pending 稿，每条带通过和驳回按钮；页面用内联 `script` 调 `/api/review/:id`，nonce 由出口的 `harden()` 统一签，和 [CSP nonce 那篇](/p/csp-nonce-cache) 是同一套机制，没新增 CSP 面。工作台加了一个待审 KPI，有值就能点进去直达审核页；编辑器自己的文章列表里，pending 和 rejected 各显示一个徽标，作者不用猜自己稿子卡在哪一步。

审核页的接口和页面本身都带 `requireAdmin`，且响应是 `cache-control: no-store`——待审列表不该被任何一层缓存记住。这一点和前面缓存章节是同一条原则的延伸：凡是基于身份才可见的内容，缓存键里不包含身份，就只能不缓存。

## 七、SQLite 的幂等没了

这次改表踩到一个 SQLite 和 MySQL 的差异，值得单独记一笔。我原本想像给索引加 `IF NOT EXISTS` 那样，把加字段也写成幂等语句：

```sql
-- 这条在 SQLite 里是语法错
ALTER TABLE posts ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'approved';
```

SQLite 不支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，直接报语法错。它只支持标准的 `ADD COLUMN`，重复执行会报"列已存在"之类的错误，但没有"存在就跳过"这个语法。迁移文件 `migrations/0002_review_status.sql` 落地的是最朴素的一条：

```sql
ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_posts_review ON posts(review_status);
```

注意一个不对称：索引那句带了 `IF NOT EXISTS`，字段那句没有。`CREATE INDEX IF NOT EXISTS` 在 SQLite 里是合法的，所以索引可以重复跑；加字段不行，只能靠"迁移只执行一次"这个前提来保证幂等。这意味着部署脚本得自己记住 0002 跑没跑过——好在这个站的迁移本来就是手工按顺序执行的，没有自动 migration runner，重复执行的风险本来就可控。

这条经验不只适用于审核字段。以后任何"给 SQLite 加列"的迁移都不能套 MySQL 那套幂等写法，写之前先确认目标引擎。我把这个差异写进迁移文件的注释里，主要是怕半年后自己又照着 MySQL 的习惯写一遍。

## 怎么自己验一遍

如果你想在类似的多用户博客里复现这套审核开关，按下面的顺序查，每一步都有明确的预期结果。命令里的路径按本站的文件布局写，换项目时改路径即可。

先看字段和索引是不是真的落库了，以及存量数据有没有被误伤：

```sql
-- 字段类型、默认值、是否允许为空
PRAGMA table_info(posts);
-- 索引是否存在
SELECT name FROM sqlite_master WHERE type='index' AND name='idx_posts_review';
-- 口径分开看：总行数和公开数
SELECT COUNT(*) AS total FROM posts;
SELECT COUNT(*) AS public_cnt FROM posts
  WHERE review_status='approved' AND is_private=0 AND hidden=0;
```

本站当前这两个数分别是 36 和 19。如果你的迁移没写默认 `approved`，第二条会接近 0，说明存量被误伤了。

然后用普通用户账号发一篇测试稿，确认它进的是 `pending` 而不是 `approved`：

```bash
curl -s -X POST https://你的域名/api/posts \
  -H 'content-type: application/json' \
  -H 'cookie: 你的登录cookie' \
  -d '{"title":"审核探针","content":"probe","publish_at":""}' | jq .
# 再去库里核对
# sqlite3 db.sqlite "SELECT slug,review_status FROM posts WHERE title='审核探针';"
```

接着按四路验匿名不可见，记状态码而不是看截图：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://你的域名/api/posts/审核探针-slug
curl -s -o /dev/null -w '%{http_code}\n' https://你的域名/p/审核探针-slug
curl -s https://你的域名/rss | grep -c '审核探针'        # 期望 0
curl -s https://你的域名/sitemap.xml | grep -c '审核探针' # 期望 0
```

前两条期望都是 404，后两条期望都是 0。任何一条不符合，就回头查对应的闸门：`liveSql` 管列表，单篇 API 和 SSR 各自那段 `review_status` 判断管单篇。

顺手把后台那几个入口也点一遍。用 uid=2 登录时访问 `/admin/review` 应该被挡住，工作台的待审 KPI 不该出现；用 uid=1 登录时应能看到 KPI 数字并点进审核页，编辑器文章列表里的测试稿应显示待审徽标。这些不是安全边界，但能确认"审核结论有没有传到人眼前"——状态对了而没人看见，审核照样失效。

收尾验缓存旁路。用一个低成本的办法近似：作者身份预览一次测试稿，紧接着立刻用匿名身份请求同一个 slug，看是不是仍然 404。如果匿名那次拿到了正文，说明 `postCacheSet` 的审核态条件没加上，或者边缘缓存没在审核后清掉。

```js
// 该条件必须同时出现在实例缓存写入处
if (post && !post.is_private && post.review_status === 'approved') postCacheSet(slug, b);
```

验完记得把测试稿删掉，再核对一次公开数。本站跑完这一轮之后公开数回到 19，和动手前一致。这一条别省——留一篇探针稿在库里，比没有这套审核还糟。

#security #sqlite #ssr #cache
