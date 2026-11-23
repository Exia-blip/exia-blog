-- 由 scripts/seed-56.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径
-- 排期 2027-02-17（周三）09:00 北京时间，接在 gate-only-covered-the-honest-half（02-10）之后

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('scalar-max-and-out-of-range-page', '两个都不报错的错：越界页码 200，MAX 写成了标量', '# 两个都不报错的错：越界页码 200，MAX 写成了标量

## 结论

一份十条的清单里，七条我实测不成立，三条真会咬人。三条当中又有两条是同一类：

1. **`/?page=999` 返回 200 的空列表**，而且 canonical 写着 `?page=999` 自己。分页链接有边界（末页不渲染「下一页」），URL 没有 —— 爬虫不用点链接，拼数字就能造出无限多张「空但合格」的页，每张都自称规范地址。
2. **`MAX(a, b)` 在 `GROUP BY` 里不是聚合**，是标量函数。SQLite 对组内非聚合表达式的处理是「取任意一行」，于是「组内最新的更新时间」变成了「组里某一行的时间」。写成 `MAX(MAX(a, b))` 才对，多一层嵌套，差的是几个月。
3. 顺着第 2 条查 `sitemap.xml`，发现 **`lastmod` 早于 `datePublished`**：线上 18 篇文章里 1 篇倒挂（11-13 对 11-21）。排期稿越多，倒挂越多。

修完这三条，我又在同一个坑边上发现第四条：**500 的出口有两个，我上一轮只修了一个**。内层 catch 已经按路径分流，最外层那个还是裸的 `error: e.message`。把异常扔在 `handleFetch` 开头试，`curl` 拿到的就是 `{"error":"D1_ERROR: no such table: posts"}` —— 和修之前一模一样。

四条的共同点：**没有一条会报错，没有一条会被工具发现**。页面是 200，sitemap 是合法 XML，JSON 也是合法 JSON。

这轮的顺序因此反过来了：不是读代码找问题，是先把清单里的地址和字段逐条打一遍，能复现的才排优先级。七条当场消失，剩下三条各配一条断言，改完再让断言在旧代码上红一次 —— 红不了的那条，说明它测的不是这次改的东西。

## 一、先看清单里成立的那三条

材料给的形式是「问题 + 建议 + 优先级」。先按「会不会真出事」过一遍，成立的留下来：

| 材料说 | 实测 | 判断 |
|---|---|---|
| 越界页码返回空页，应该 404 | `/?page=999` 200、`/cat/log?page=999` 200、`/tag/x?page=999` 200，三处都自指 canonical | **成立**，见第二节 |
| `sitemap` 的 lastmod 有错 | 18 篇里 1 篇 `lastmod` 早于 `datePublished` | **成立**，见第四节 |
| 500 页会把异常原文回给调用方 | 带 `Accept: text/html` 的是自定义页（这条材料判错），不带 Accept 的拿到 `D1_ERROR: no such table` | **一半成立**，见第五节 |

不成立的七条里，最典型的是三条：

| 材料说 | 实测 |
|---|---|
| 搜索框没有接服务端，只是前端过滤 | `/api/posts?q=` 走 SQL LIKE，前端 320ms 防抖 + AbortController + `mark` 高亮 + 空态，都在 |
| 没有 `/series` 页面 | `/series` 与 `/series/<名称>` 都 200，都在 sitemap 里 |
| 列表图没做懒加载 | `loading="lazy"` + 宽高属性本来就有，缺的是「图片尺寸写死 vs 自适应」的取舍，不是懒加载 |

这三条我一条都没动。改一个已经正确的实现，比不改更危险 —— 下一轮审计会看到「这里被人动过」，然后重新怀疑一遍。

## 二、越界页码：页面有边界，URL 没有

修复前，线上是这样一个状态（2026-11-24 抓的，`cache-control: no-cache` 绕缓存）：

| 请求 | 状态 | 返回条数 | canonical |
|---|---|---|---|
| `/` | 200 | 10 | `/` |
| `/?page=1` | 200 | 10 | `/?page=1` |
| `/?page=2` | 200 | 8 | `/?page=2` |
| `/?page=3` | 200 | 0 | `/?page=3` |
| `/?page=999` | 200 | 0 | `/?page=999` |
| `/cat/log?page=999` | 200 | 0 | `/cat/log?page=999` |
| `/tag/cloudflare?page=999` | 200 | 0 | `/tag/cloudflare?page=999` |
| `/archive?page=9` | 200 | — | `/archive?page=9` |

（返回条数取自 `/api/posts`，和页面用的是同一个 `pageParams`；归档页不分页，所以是「—」。）

站点当时 18 篇公开、每页 10 篇，`pages = 2`。所以第 3 页开始全是越界，全部 200。

成因一句话：`OFFSET` 越过末尾时 SQLite 返回空数组，不是错误。模板拿到空数组就渲染成「还没有文章」，状态码按默认 200 出去。没人问过「越界时该回什么」。

严格说，这是两个层面的默认值叠在一起的结果。数据层：空结果集是**正常**返回值，不是异常。模板层：列表为空只有一种表达方式，就是空态文案。HTTP 层：没人显式设状态码，于是 200。三层各自都对，合起来就错了 —— 因为 HTTP 层缺一个判断：**「这一页没有内容」和「这一页不存在」是两件事**。

首页没有文章是前者（站刚建，200 的空态正确）；第 999 页没有文章是后者（这一页不在分页序列里，应该是 404）。两者在数据层长得一模一样，都是空数组，所以这个判断只能由知道 `total` 和 `pages` 的那一层来做。

危险的地方不在「空页难看」，在于**三件事叠加**：

1. **状态码是 200**，不是 404 也不是 410。爬虫会收录。
2. **canonical 自指**。`fillSeo` 把 `page` 参数无条件抄进规范地址，于是每一张空页都声明「我就是这一页的规范版本」，不会被去重。
3. **URL 是无边界的**。分页链接只到末页，但参数可以拼任意整数：`?page=3` 到 `?page=999999` 全都能生成一张独立的、合格的、自指的页面。

这不是理论风险。站内分页链只在末页停住，而爬虫发现新 URL 的方式不止「顺着链接爬」——日志、外链、站点地图、别人贴的地址，都能带进来一个 `?page=500`。

这类页面在 SEO 里有个专门名字：**软 404**。状态码说「正常」，内容说「什么都没有」。搜索引擎对软 404 的处理比 404 更麻烦 —— 404 是明确的「这里没有东西，别再来了」，软 404 是「这里有个页面，但它什么都不说」，后者只会被反复抓取、反复判断。我没有这个站的抓取日志，能说的到这儿为止：软 404 的数量级和收录影响**没有实测**，只有定性判断。

修法只有两行，但位置很关键。判定放在 `injectTheme` 里、拿到 `list` 之后：

```js
// 总数 > 0 且页码超出末页时才 404；一篇都没有的站仍然给 200 的首页空态
if (list && list.total > 0 && list.page > list.pages) {
  return await notFoundPage(env, null, ''这一页没有文章'');
}
```

`total > 0` 这个条件是必须的：一个刚建好、还没发文的站，首页本来就该是 200 的空态，不能因为 `pages = 0` 就把首页判成 404。

为什么不放在 `route()` 里拦？因为那里拿不到 `total` —— 要知道一条记录是「第 3 页」还是「越界」，必须先查一次总数。而 `route()` 只做分发、不碰 SQL（`RB-06` 那条断言守着这个边界）。把判断放在 `list` 已经算出来的地方，是最小代价：不新增查询、不新增解析点，`list.page` 和 `list.pages` 本来就是列表查询的返回值。

修完在本地重跑同一组地址（本地库 18 篇，17 篇公开，每页 10 篇 → `pages = 2`）：

| 请求 | 修复前 | 修复后 | canonical |
|---|---|---|---|
| `/?page=1` | 200 | 200 | `/` |
| `/?page=2` | 200 | 200 | `/?page=2` |
| `/?page=3` | 200 空列表 | **404** | 无 |
| `/?page=999` | 200 空列表 | **404** | 无 |
| `/cat/log?page=999` | 200 空列表 | **404** | 无 |
| `/tag/cloudflare?page=999` | 200 空列表 | **404** | 无 |
| `/archive?page=9` | 200，canonical 带页码 | 200 | `/archive` |

404 页 2682 字节，正文里 `class="empty"` 出现 0 次 —— 这一条很重要：只把状态码改成 404、页面里还留着「这个栏目下还没有文章」，那等于换了个牌子继续骗人。断言里专门有一条查它。

**第二种无效输入：page 参数本身。**

`?page=1` 与不带参数是**逐字相同**的内容，但它们曾经是两个地址，各自 canonical 自指。这是最典型的重复内容：同一页的两份地址，谁都不让谁。

归档页是另一种：`/archive` 一次列全部，`page` 根本不参与查询。所以 `/archive?page=9` 与 `/archive` 输出同一份 HTML，九个不同的地址全都自称规范。

只让「真分页」的三种路径在 `page > 1` 时保留页码：

```js
const paged = !!url && (url.pathname === ''/'' || url.pathname.startsWith(''/tag/'') || url.pathname.startsWith(''/cat/''));
// 页码仍然只在这一处解析一次：走 pageParams，不自己 parseInt
const pageNo = url ? pageParams(url).page : 1;
if (canonicalUrl && paged && pageNo > 1) {
  canonicalUrl.searchParams.set(''page'', String(pageNo));
}
```

两个细节，都是踩过的：

- **`pageNo` 走 `pageParams(url).page`**，不是 `url.searchParams.get(''page'')`。后者拿到的是原始字符串，`?page=abc`、`?page=1e21`、`?page=-5` 各有各的写法；前者已经做了 `MAX_PAGE = 10000` 上界和 `Number.isFinite` 判定。同一个参数在全站只能解析一次，这是 `QP-05` 那条元断言守的。
- **判定用 `pathname` 前缀，不用 `paged` 白名单外的东西**。首页写 `=== ''/''` 不写 `startsWith(''/'')` —— 后者会把所有路径都放进来。

顺便把 `size` 也验了一遍，因为它看起来像同类参数。结论是页面这一侧根本不认它：`/?size=1&page=5` 返回 404，说明 `listParams` 只取 `page`，列表固定每页 10 条，`size` 对页面内容零影响。`/?size=50&page=1` 的 canonical 是 `/`，内容与 `/` 逐字相同 —— 丢掉它是对的，和丢掉 `utm_*`、`?cb=` 一样。

同一个 `size` 在 `/api/posts` 上却是有效参数（`pageParams` 里夹了 1~50）。**同一参数在两个出口含义不同**这件事本身不难，难的是别让它渗进 canonical：页面侧只要问一句「这个参数会改变我渲染的内容吗」，答案是不会，就不写进规范地址。`check:live` 那 5 条断言用的是 canonical 的**精确相等**（不是「包含」），所以多写一个参数就会红。

## 三、`MAX(a,b)` 在 `GROUP BY` 里不是聚合

这条比页码隐蔽得多，因为它**看起来就是对的**。

`sitemap.xml` 里每个栏目页、标签页、系列页都要一个 `lastmod`：这一页的内容变了，是因为它下面某篇文章变了，所以取组内最大值。原来的写法：

```sql
MAX(COALESCE(p.updated_at, p.created_at))
```

一个参数，是聚合函数，没问题。改成「取发布日与更新日之较大者」时，最自然的写法是：

```sql
MAX(p.published_at, p.updated_at)
```

两个参数。**这是标量函数**，逐行求值，不是聚合。放进 `GROUP BY` 的查询里，SQLite 对「非聚合表达式」的处理是取组内任意一行 —— 文档里的说法是 bare columns，实际扫到哪行算哪行。

用 `node:sqlite` 在内存库里搭了六行数据（两篇 11 月已发、两篇排期到次年 1 月和 2 月、两篇 teardown），跑三种写法：

| 写法 | `log` 组 | `teardown` 组 |
|---|---|---|
| `MAX(published_at, updated_at)`（单层，标量） | 2026-11-21 01:00 | 2026-11-27 01:00 |
| `MAX(MAX(published_at, updated_at))`（外层聚合） | **2027-02-03 01:00** | **2026-11-29 01:00** |
| 旧口径 `MAX(COALESCE(updated_at, created_at))` | 2026-11-22 18:31 | 2026-11-19 10:40 |

第一行就是坑：`log` 组里最新的公开时间是次年 2 月 3 日，单层写法给出 11 月 21 日 —— 那是组里第一行，跟「最大」毫无关系。差 74 天。

第二行多包一层就对了：内层 `MAX(a, b)` 逐行取两列的大值，外层 `MAX(...)` 才是组内聚合。SQLite 允许这种嵌套，因为两层在语义上本来就是两件事：**行内的 max 和组内的 max**。

根源是 `MAX` 这一个名字背了两个身份：单参数时是聚合，多参数时是标量。Postgres 和 MySQL 把这两件事拆成 `MAX()` 与 `GREATEST()`，所以同一句写错在那边会直接报「参数个数不对」；SQLite 选择兼容而非报错，于是错的那个写法安静地跑出结果。**能跑的错最贵**，这一条在 SQL 里和在 CSS 里一样成立。

这个错误之所以难发现，是因为**同一个表达式在别的位置是对的**：

```sql
-- 单行查询：正确，这一行取两列的大值
SELECT slug, MAX(published_at, updated_at) AS last FROM posts WHERE slug = ?;
```

`WHERE slug = ?` 只出一行，`MAX(a, b)` 逐行求值正好就是要的语义。把它从「单行」上下文搬进「分组」上下文时，SQL 一个字都没改，含义从「取两列大值」变成「取两列大值，然后随便挑一行」。**上下文换了，表达式没换** —— 这类错误在 code review 里几乎不可见，因为看的人是按单行的语义在读。

第一版我就是这么写的。本地跑 SQL 对着数据看才发现：`log` 组最新是次年 2 月，输出却是 11 月。当时第一反应是「数据没进去」，查了三次库才回头怀疑表达式 —— 这是最典型的「现象像 A、根因在 B」。

第三行是旧口径，问题在下一节。

真正落地的 SQL 还得处理空字符串。本站的 `published_at` 有 `''''`（草稿），`COALESCE(NULLIF(x, ''''), ''0'')` 把它压成字符串 `''0''`，这样比较时不会因为 `NULL` 让整行被聚合函数忽略：
```js
const stamp = (a) =>
  `MAX(MAX(COALESCE(NULLIF(${a}.published_at, ''''), ''0''), COALESCE(${a}.updated_at, ${a}.created_at, ''0'')))`;
```

这里有个容易搞混的地方：**单篇文章的 `lastmod` 不是 SQL 算的**，是 JS 里比较两个字符串：

```js
const lastOf = (p) => {
  const a = String(p.updated_at || '''');
  const b = String(p.published_at || '''');
  return (a > b ? a : b).slice(0, 10);
};
```

字符串比较对 `YYYY-MM-DD HH:MM:SS` 这种定长格式是正确的，所以单篇那一处从来没出过问题。出问题的只有聚合那一处 —— 也就是说，**同一个语义在两条路径上各写了一遍，一条对一条错**。这种结构下次还会错，所以断言要盯的不是「这行对不对」，而是「这条语义有几处实现」。

## 四、`lastmod` 早于 `datePublished`

修好聚合，再看数据本身。

这条不是我肉眼发现的，是断言先报的。`check-sitemap.mjs` 里加了七行：抽 sitemap 里最新的三篇文章页，逐篇抓下来取 `datePublished`，和 `<lastmod>` 比大小，任何一篇倒挂就红。第一次跑就红了一篇 —— 在此之前，这个站已经带着这条矛盾跑了一个月，期间没人报错，页面看着完全正常。

线上 `sitemap.xml` 当时 50 条 `<url>`，其中 18 条是文章页。逐篇抓页面比 `datePublished`：

```text
sitemap 50 条，文章 18 篇，倒挂 1 篇：
  ld-self-reference lastmod 2026-11-13 < datePublished 2026-11-21
```

只有一篇，但那不是偶然。11-21 那篇是 11-14 当天写完的存货，`updated_at` 停在 11-14，`published_at` 是 11-21。而本站从 11-21 起改成了「2 天一篇」，库存里还有十几篇是 11 月写完、12 月到次年 2 月才开闸的 —— 它们上线之后，每一篇都是倒挂，只是现在还没到日子。

本地模拟一篇排期稿验证（`published_at` 给过去时间让它上线，`updated_at` 给 11 月）：

| 字段 | 值 |
|---|---|
| `published_at` | 2026-11-22 12:00:00 |
| `updated_at` | 2026-11-10 09:00:00 |
| 旧口径 `MAX(updated_at, created_at)` | 2026-11-20 16:53（组内别的文章撑起来的） |
| 单篇旧写法（`updated_at`） | 2026-11-10 |
| 修后单篇 `lastmod` | 2026-11-22 |
| 页面 `datePublished` | `2026-11-22T12:00:00.000Z` |

单篇倒挂 12 天，栏目聚合倒挂 2 天（被组里更新的一篇压住了，所以看起来「还好」——这种「看起来还好」比明显坏更麻烦，它会让你以为不用修）。

为什么这件事值得修，而不是「反正搜索引擎也不看」：`lastmod` 是站点自己声明的「内容最后一次变」的时间，`datePublished` 是「第一次可见」的时间。后者不可能早于前者。当这两个信号互相矛盾时，搜索引擎的合理反应是**降低这两个信号的权重**，而这个站几乎所有 SEO 判断都建立在时间信号上：sitemap 优先级、归档排序、RSS 顺序、`dateModified`。

修法就是把「发布也是一次内容变化」落进 SQL：

```js
// 组内聚合（栏目页 / 标签页 / 系列页）：SQL 里算
const lastUpd = (a = ''p'') => stamp(a);   // stamp 就是上面那个 外层MAX(内层MAX(...))

// 单篇：JS 里比两个字符串，不走 SQL
const lastOf = (p) => {
  const a = String(p.updated_at || '''');
  const b = String(p.published_at || '''');
  return (a > b ? a : b).slice(0, 10);
};
```

`stamp()` 同时用在单篇和组内聚合上 —— 一处定义，六处引用（首页、归档、栏目总览、每个栏目页、每个标签页、每个系列页）。改口径只改一行。

里面那个 `COALESCE(NULLIF(p.updated_at, ''''), p.created_at, ''0'')` 值得单说：本站的 `published_at` 有 `''''`（草稿从没发布过）。`NULLIF(x, '''')` 把空串变成 `NULL`，`COALESCE` 再往后取 `created_at`，最后兜一个 `''0''`。三层兜底看着啰嗦，缺一层的后果分别是：空串参与字符串比较时排在任何日期之前（`'''' < ''2026''`），于是草稿会被当成「最老的一篇」；`NULL` 会让 `MAX()` 直接忽略这一行，组内一篇都没发布时聚合结果是 `NULL`，`<lastmod>` 就变成空标签。

顺带一个同源问题：时间信号在站里有三处出口 —— sitemap 的 `<lastmod>`、页面 JSON-LD 的 `dateModified`、RSS 的 `<pubDate>`。三处各自从 `post` 对象取时间，谁都不引用谁。这轮只统一了 sitemap 这一处，另外两处用的是发布日（`pubDate` 本来就该是发布日）或 `updated_at`（`dateModified` 本来就该是最后编辑），语义上没错，但它们之间**没有断言把它们钉在一起** —— 与 P-043 同一个教训：同源字段，要么同源，要么有断言。

## 五、修完之后，同一个坑边上还有一处

P-044 上一轮已经修过一次：500 时按 `Accept` 分流，浏览器拿自绘页，`curl` 拿 JSON。

修完我以为这条结了。这一轮为了验证，往 `handleFetch` 第一行插了一行：

```js
if (new URL(request.url).pathname === ''/__boom'') throw new Error(''D1_ERROR: no such table: posts'');
```

`curl` 不带 Accept —— 拿到的是原文：

```http
HTTP/1.1 500 Internal Server Error
content-type: application/json; charset=utf-8

{"ok":false,"error":"D1_ERROR: no such table: posts"}
```

53 字节，表名、SQL 方言、出错位置，一个不少。

原因很直接：`handleFetch` 里的 `try` 只包住了 `route()` 分发那一段。异常如果抛在它前面（HEAD 预处理、URL 解析）或者后面（ETag、日志上报），到不了内层那个已经改好的 catch，一路掉到最外层：

```js
async fetch(request, env, ctx) {
  const startedAt = Date.now();
  let res;
  try {
    res = await this.handleFetch(request, env, ctx);
  } catch (e) {
    res = json({ ok: false, error: e.message }, 500);   // ← 这里还是裸的
  }
  ...
}
```

**同一条规则写在两处，上一轮只改了一处。** 这是 P-030 记过的老毛病（`ownerOrAdmin` 那两处内联判定），第二次发作，同一个形态：不是不知道规则，是规则有第二份实现。

两层的分工：内层 catch 拦业务层（`route()` 里的 D1 报错、模板取值失败），外层 catch 拦框架层（HEAD 预处理、URL 解析、日志上报）。抽成同一个函数之后，内层其实可以删掉，让异常一路冒到外层，回包一模一样。但这次不删 —— 删它是纯重构，对行为零收益，而这一轮已经有四处改动了。最小改动的边界在这里：**该合并的是判断，不是控制流**。

这次不补分支，抽成一个函数，两个 catch 都调它：

```js
function fatalResponse(request, e) {
  console.error(e);
  let here = '''';
  try {
    here = new URL(request.url).pathname;
  } catch {}
  const wantsHtml =
    !here.startsWith(''/api/'') &&
    (request.method === ''GET'' || request.method === ''HEAD'') &&
    /text\/html/.test(request.headers.get(''accept'') || '''');
  if (wantsHtml) {
    return new Response(serverErrorPage(), {
      status: 500,
      headers: { ''content-type'': ''text/html; charset=utf-8'', ''cache-control'': ''no-store'', ''retry-after'': ''60'' },
    });
  }
  return here.startsWith(''/api/'')
    ? json({ ok: false, error: e.message }, 500)
    : json({ ok: false, error: ''服务器错误'' }, 500);
}
```

里面那个 `try { new URL() } catch {}` 不是凑数：外层 catch 存在的意义就是兜「连 request 都解析不了」的意外，如果兜底的函数自己再抛一次 `TypeError: Invalid URL`，就等于没有兜底。拿不到路径时按非 API 处理 —— 这是唯一安全的默认。

改完同一组注入，三种观众：

| 请求 | 修复前 | 修复后 |
|---|---|---|
| `curl /__boom`（无 Accept） | 500 `{"error":"D1_ERROR: no such table: posts"}`，53 B | 500 `{"error":"服务器错误"}` |
| `curl -H ''Accept: text/html'' /__boom` | 500 自定义页（内层 catch 挡住了，本来就没漏） | 500 自定义页，1109 B，`D1_ERROR` 出现 0 次 |
| `curl /api/_boom` | 500 原文 | 500 原文（API 本来就要） |

## 六、断言：先让它红

四条修复，五组断言。原则没变：**没在旧代码上见过它红的断言，不算断言**。

| 编号 | 断言 | 位置 | 修前 |
|---|---|---|---|
| `[P-042]` | `/?page=1` 归一到 `/` | `check-live` 第 13 节 | 红（canonical 是 `?page=1`） |
| `[P-042]` | `/?page=2` 保留页码 | 同上 | 绿 |
| `[P-042]` | 首页越界 404 | 同上 | 红（200） |
| `[P-042]` | 404 页里没有列表空态 | 同上 | 红 |
| `[P-042]` | 归档页的 page 不进 canonical | 同上 | 红（canonical 带 `?page=9`） |
| `[P-042]` | 栏目页越界 404 | 同上 | 红 |
| `QP-06` | 越界判定与 `notFoundPage` 都在 | 离线 | 红（判据不存在） |
| `QP-07` | `paged` 只认三种路径、`pageNo > 1` | 离线 | 红 |
| `[P-043]` | 抽 3 篇比 `lastmod >= datePublished` | `check-sitemap` | 红（1 篇倒挂） |
| `RB-07` | 非 API 的 500 不回原文 | 离线 | 绿（上一轮修的） |
| `RB-07` | 两个 catch 共用同一出口（≥ 2 处调用） | 离线 | **红**（只有 1 处） |
| `RB-07` | catch 块里没有第二份 500 分支实现 | 离线 | **红** |

`QP-06` / `QP-07` / `RB-07` 是离线那一半：线上那一半要部署才验得了，而部署前必须有一个「规则还在代码里」的守卫，否则改回去的时候没人知道。

这两层不能互相替代。线上断言证明的是**行为**（`?page=999` 真的 404），但它要部署才能跑，写代码的当下一个字都验不了；离线断言证明的是**形状**（判定还在、分支还在），当场能跑，但它证明不了这条分支真的被走到。上一轮假绿那件事（同步 `t()` 吞掉 async 用例）就是「形状对了、行为没跑」的极端形态 —— 六条断言全是绿的，一次都没执行过。

所以这一轮的分工是：能在本地打到的（越界 404、canonical 三种路径、sitemap 单篇日期）写行为断言；只有部署后才成立的（线上的 5 条 `[P-042]`）既写线上断言，也在离线加一条「这条规则没被删」的影子断言。

三条注入验证，都实测过：

| 改动 | 期望 | 实际 |
|---|---|---|
| 外层 catch 改回 `json({ error: e.message }, 500)` | RB-07 两条红 | 双红（`只有 1 处调用` / `1 个 catch 又自己拼了 e.message`） |
| 越界判定删掉 | QP-06 红 | 红 |
| `paged` 判定去掉 `pageNo > 1` | QP-07 红 | 红 |

`[P-043]` 那条有个实现上的取舍：为什么抽 3 篇而不是全量？全量要抓 18 个页面，`check:live` 一轮从 40 秒涨到 90 秒，而倒挂只发生在「刚上线不久的排期稿」身上 —— sitemap 按发布时间倒序排，前 3 条正好覆盖这个窗口。不是完美覆盖，是成本与覆盖面的取舍，写在这儿免得下次有人以为它检查了全部。

## 七、明说的没做

- **`/archive` 没加分页**。它一次列全部，`page` 不参与查询。真要有几百篇再考虑，现在的做法是让 `page` 不进 canonical，不假装它分页。
- **标签页的 60 秒 404 缓存没动**。`/tag/<不存在>` 写 60 秒的 404 缓存，零回显（P-032 记过），能被灌 60 秒窗口，但拦不住的真实攻击者也不在乎 60 秒。
- **没改 `sitemap` 的优先级（`<priority>`）**。改 lastmod 就够了，priority 早就被 Google 公开说明「不用」。
- **没做 404 文案分类**。现在越界页码、不存在的 slug、不存在的标签共用一张 404 页，只有 H1 下面那句副标题不同。够用。
- **没验证爬虫侧的实际反应**。软 404 从 200 改成 404 之后，收录数怎么变、抓取频次怎么变，这个站没有 Search Console 的对照数据，只能等四周后再看。这篇里关于「软 404 更浪费抓取预算」的说法是推断，不是实测。
- **没重测首屏**。这轮改的是分页边界、SQL 聚合、异常出口，一处都不在前端渲染路径上。
- **写作时还没部署，发布前已部署**。改之前线上 111 通过 / 5 失败，5 条全是 `[P-042]` —— 那正是「修好了但没上线」的样子，不是回归；部署后 116 通过 / 0 失败。第一轮体检还剩一条「栏目页越界 200」，是部署前那张越界页被边缘缓存了 300 秒，绕缓存重打就是 404 —— 这一条本身就是 P-042 的注脚：**200 的空页连缓存都愿意收**。

## 复现条件

- 环境：Node 22.22.2，`node:sqlite`（内存库，不需要 D1），本地 `wrangler dev --port 8791 --local`
- 数据：本地 D1 18 篇 / 17 篇公开 / 每页 10 篇 → `pages = 2`
- 触发一：`curl -o /dev/null -w ''%{http_code}'' ''http://127.0.0.1:8791/?page=999''`
- 期望：404；实际：404（`2682` 字节的 404 页，`class="empty"` 出现 0 次）
- 触发二：插一篇 `published_at` 晚于 `updated_at` 的稿，抓 `/sitemap.xml`
- 期望：`<lastmod>` 等于发布日；实际：`2026-11-22`，页面 `datePublished` 是 `2026-11-22T12:00:00.000Z`
- 触发三：`handleFetch` 第一行临时 `throw`，`curl` 不带 Accept
- 期望：`{"ok":false,"error":"服务器错误"}`；实际：一致（注入行已删除）

## 断言代码

```bash
node scripts/test-query-params.mjs        # QP-06 越界 404 / QP-07 canonical 只认三种路径
node scripts/test-route-boundaries.mjs    # RB-07 500 页静态、两个 catch 共用出口、无第二份实现
node scripts/check-sitemap.mjs            # [P-043] lastmod >= datePublished（抽 3 篇）
npm run check:live                        # 第 13 节 [P-042] 5 条，需部署后才绿
```

一处提醒：`check:live` 在部署后 5 分钟内跑，会有一组 ETag/304 假红 —— 边缘缓存 `s-maxage=300`，GET 还命中旧副本而 HEAD 已经落到新代码。等 5 分钟重跑，116/116。
', '<h1 id="两个都不报错的错-越界页码-200-max-写成了标量"><a class="h-anchor" href="#两个都不报错的错-越界页码-200-max-写成了标量">#</a>两个都不报错的错：越界页码 200，MAX 写成了标量</h1>
<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>一份十条的清单里，七条我实测不成立，三条真会咬人。三条当中又有两条是同一类：</p>
<ol><li><strong><code>/?page=999</code> 返回 200 的空列表</strong>，而且 canonical 写着 <code>?page=999</code> 自己。分页链接有边界（末页不渲染「下一页」），URL 没有 —— 爬虫不用点链接，拼数字就能造出无限多张「空但合格」的页，每张都自称规范地址。</li><li><strong><code>MAX(a, b)</code> 在 <code>GROUP BY</code> 里不是聚合</strong>，是标量函数。SQLite 对组内非聚合表达式的处理是「取任意一行」，于是「组内最新的更新时间」变成了「组里某一行的时间」。写成 <code>MAX(MAX(a, b))</code> 才对，多一层嵌套，差的是几个月。</li><li>顺着第 2 条查 <code>sitemap.xml</code>，发现 <strong><code>lastmod</code> 早于 <code>datePublished</code></strong>：线上 18 篇文章里 1 篇倒挂（11-13 对 11-21）。排期稿越多，倒挂越多。</li></ol>
<p>修完这三条，我又在同一个坑边上发现第四条：<strong>500 的出口有两个，我上一轮只修了一个</strong>。内层 catch 已经按路径分流，最外层那个还是裸的 <code>error: e.message</code>。把异常扔在 <code>handleFetch</code> 开头试，<code>curl</code> 拿到的就是 <code>{&quot;error&quot;:&quot;D1_ERROR: no such table: posts&quot;}</code> —— 和修之前一模一样。</p>
<p>四条的共同点：<strong>没有一条会报错，没有一条会被工具发现</strong>。页面是 200，sitemap 是合法 XML，JSON 也是合法 JSON。</p>
<p>这轮的顺序因此反过来了：不是读代码找问题，是先把清单里的地址和字段逐条打一遍，能复现的才排优先级。七条当场消失，剩下三条各配一条断言，改完再让断言在旧代码上红一次 —— 红不了的那条，说明它测的不是这次改的东西。</p>
<h2 id="一-先看清单里成立的那三条"><a class="h-anchor" href="#一-先看清单里成立的那三条">#</a>一、先看清单里成立的那三条</h2>
<p>材料给的形式是「问题 + 建议 + 优先级」。先按「会不会真出事」过一遍，成立的留下来：</p>
<div class="table-wrap"><table><thead><tr><th>材料说</th><th>实测</th><th>判断</th></tr></thead><tbody><tr><td>越界页码返回空页，应该 404</td><td><code>/?page=999</code> 200、<code>/cat/log?page=999</code> 200、<code>/tag/x?page=999</code> 200，三处都自指 canonical</td><td><strong>成立</strong>，见第二节</td></tr><tr><td><code>sitemap</code> 的 lastmod 有错</td><td>18 篇里 1 篇 <code>lastmod</code> 早于 <code>datePublished</code></td><td><strong>成立</strong>，见第四节</td></tr><tr><td>500 页会把异常原文回给调用方</td><td>带 <code>Accept: text/html</code> 的是自定义页（这条材料判错），不带 Accept 的拿到 <code>D1_ERROR: no such table</code></td><td><strong>一半成立</strong>，见第五节</td></tr></tbody></table></div>
<p>不成立的七条里，最典型的是三条：</p>
<div class="table-wrap"><table><thead><tr><th>材料说</th><th>实测</th></tr></thead><tbody><tr><td>搜索框没有接服务端，只是前端过滤</td><td><code>/api/posts?q=</code> 走 SQL LIKE，前端 320ms 防抖 + AbortController + <code>mark</code> 高亮 + 空态，都在</td></tr><tr><td>没有 <code>/series</code> 页面</td><td><code>/series</code> 与 <code>/series/&lt;名称&gt;</code> 都 200，都在 sitemap 里</td></tr><tr><td>列表图没做懒加载</td><td><code>loading=&quot;lazy&quot;</code> + 宽高属性本来就有，缺的是「图片尺寸写死 vs 自适应」的取舍，不是懒加载</td></tr></tbody></table></div>
<p>这三条我一条都没动。改一个已经正确的实现，比不改更危险 —— 下一轮审计会看到「这里被人动过」，然后重新怀疑一遍。</p>
<h2 id="二-越界页码-页面有边界-url-没有"><a class="h-anchor" href="#二-越界页码-页面有边界-url-没有">#</a>二、越界页码：页面有边界，URL 没有</h2>
<p>修复前，线上是这样一个状态（2026-11-24 抓的，<code>cache-control: no-cache</code> 绕缓存）：</p>
<div class="table-wrap"><table><thead><tr><th>请求</th><th>状态</th><th>返回条数</th><th>canonical</th></tr></thead><tbody><tr><td><code>/</code></td><td>200</td><td>10</td><td><code>/</code></td></tr><tr><td><code>/?page=1</code></td><td>200</td><td>10</td><td><code>/?page=1</code></td></tr><tr><td><code>/?page=2</code></td><td>200</td><td>8</td><td><code>/?page=2</code></td></tr><tr><td><code>/?page=3</code></td><td>200</td><td>0</td><td><code>/?page=3</code></td></tr><tr><td><code>/?page=999</code></td><td>200</td><td>0</td><td><code>/?page=999</code></td></tr><tr><td><code>/cat/log?page=999</code></td><td>200</td><td>0</td><td><code>/cat/log?page=999</code></td></tr><tr><td><code>/tag/cloudflare?page=999</code></td><td>200</td><td>0</td><td><code>/tag/cloudflare?page=999</code></td></tr><tr><td><code>/archive?page=9</code></td><td>200</td><td>—</td><td><code>/archive?page=9</code></td></tr></tbody></table></div>
<p>（返回条数取自 <code>/api/posts</code>，和页面用的是同一个 <code>pageParams</code>；归档页不分页，所以是「—」。）</p>
<p>站点当时 18 篇公开、每页 10 篇，<code>pages = 2</code>。所以第 3 页开始全是越界，全部 200。</p>
<p>成因一句话：<code>OFFSET</code> 越过末尾时 SQLite 返回空数组，不是错误。模板拿到空数组就渲染成「还没有文章」，状态码按默认 200 出去。没人问过「越界时该回什么」。</p>
<p>严格说，这是两个层面的默认值叠在一起的结果。数据层：空结果集是<strong>正常</strong>返回值，不是异常。模板层：列表为空只有一种表达方式，就是空态文案。HTTP 层：没人显式设状态码，于是 200。三层各自都对，合起来就错了 —— 因为 HTTP 层缺一个判断：<strong>「这一页没有内容」和「这一页不存在」是两件事</strong>。</p>
<p>首页没有文章是前者（站刚建，200 的空态正确）；第 999 页没有文章是后者（这一页不在分页序列里，应该是 404）。两者在数据层长得一模一样，都是空数组，所以这个判断只能由知道 <code>total</code> 和 <code>pages</code> 的那一层来做。</p>
<p>危险的地方不在「空页难看」，在于<strong>三件事叠加</strong>：</p>
<ol><li><strong>状态码是 200</strong>，不是 404 也不是 410。爬虫会收录。</li><li><strong>canonical 自指</strong>。<code>fillSeo</code> 把 <code>page</code> 参数无条件抄进规范地址，于是每一张空页都声明「我就是这一页的规范版本」，不会被去重。</li><li><strong>URL 是无边界的</strong>。分页链接只到末页，但参数可以拼任意整数：<code>?page=3</code> 到 <code>?page=999999</code> 全都能生成一张独立的、合格的、自指的页面。</li></ol>
<p>这不是理论风险。站内分页链只在末页停住，而爬虫发现新 URL 的方式不止「顺着链接爬」——日志、外链、站点地图、别人贴的地址，都能带进来一个 <code>?page=500</code>。</p>
<p>这类页面在 SEO 里有个专门名字：<strong>软 404</strong>。状态码说「正常」，内容说「什么都没有」。搜索引擎对软 404 的处理比 404 更麻烦 —— 404 是明确的「这里没有东西，别再来了」，软 404 是「这里有个页面，但它什么都不说」，后者只会被反复抓取、反复判断。我没有这个站的抓取日志，能说的到这儿为止：软 404 的数量级和收录影响<strong>没有实测</strong>，只有定性判断。</p>
<p>修法只有两行，但位置很关键。判定放在 <code>injectTheme</code> 里、拿到 <code>list</code> 之后：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 总数 &gt; 0 且页码超出末页时才 404；一篇都没有的站仍然给 200 的首页空态</span>
<span class="tok-k">if</span> (list &amp;&amp; list.total &gt; <span class="tok-n">0</span> &amp;&amp; list.page &gt; list.pages) {
  <span class="tok-k">return</span> <span class="tok-k">await</span> <span class="tok-f">notFoundPage</span>(env, <span class="tok-k">null</span>, <span class="tok-s">&#39;这一页没有文章&#39;</span>);
}</code></pre></div>
<p><code>total &gt; 0</code> 这个条件是必须的：一个刚建好、还没发文的站，首页本来就该是 200 的空态，不能因为 <code>pages = 0</code> 就把首页判成 404。</p>
<p>为什么不放在 <code>route()</code> 里拦？因为那里拿不到 <code>total</code> —— 要知道一条记录是「第 3 页」还是「越界」，必须先查一次总数。而 <code>route()</code> 只做分发、不碰 SQL（<code>RB-06</code> 那条断言守着这个边界）。把判断放在 <code>list</code> 已经算出来的地方，是最小代价：不新增查询、不新增解析点，<code>list.page</code> 和 <code>list.pages</code> 本来就是列表查询的返回值。</p>
<p>修完在本地重跑同一组地址（本地库 18 篇，17 篇公开，每页 10 篇 → <code>pages = 2</code>）：</p>
<div class="table-wrap"><table><thead><tr><th>请求</th><th>修复前</th><th>修复后</th><th>canonical</th></tr></thead><tbody><tr><td><code>/?page=1</code></td><td>200</td><td>200</td><td><code>/</code></td></tr><tr><td><code>/?page=2</code></td><td>200</td><td>200</td><td><code>/?page=2</code></td></tr><tr><td><code>/?page=3</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/?page=999</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/cat/log?page=999</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/tag/cloudflare?page=999</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/archive?page=9</code></td><td>200，canonical 带页码</td><td>200</td><td><code>/archive</code></td></tr></tbody></table></div>
<p>404 页 2682 字节，正文里 <code>class=&quot;empty&quot;</code> 出现 0 次 —— 这一条很重要：只把状态码改成 404、页面里还留着「这个栏目下还没有文章」，那等于换了个牌子继续骗人。断言里专门有一条查它。</p>
<p><strong>第二种无效输入：page 参数本身。</strong></p>
<p><code>?page=1</code> 与不带参数是<strong>逐字相同</strong>的内容，但它们曾经是两个地址，各自 canonical 自指。这是最典型的重复内容：同一页的两份地址，谁都不让谁。</p>
<p>归档页是另一种：<code>/archive</code> 一次列全部，<code>page</code> 根本不参与查询。所以 <code>/archive?page=9</code> 与 <code>/archive</code> 输出同一份 HTML，九个不同的地址全都自称规范。</p>
<p>只让「真分页」的三种路径在 <code>page &gt; 1</code> 时保留页码：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> paged = !!url &amp;&amp; (url.pathname === <span class="tok-s">&#39;/&#39;</span> || url.pathname.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/tag/&#39;</span>) || url.pathname.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/cat/&#39;</span>));
<span class="tok-c">// 页码仍然只在这一处解析一次：走 pageParams，不自己 parseInt</span>
<span class="tok-k">const</span> pageNo = url ? <span class="tok-f">pageParams</span>(url).page : <span class="tok-n">1</span>;
<span class="tok-k">if</span> (canonicalUrl &amp;&amp; paged &amp;&amp; pageNo &gt; <span class="tok-n">1</span>) {
  canonicalUrl.searchParams.<span class="tok-k">set</span>(<span class="tok-s">&#39;page&#39;</span>, <span class="tok-f">String</span>(pageNo));
}</code></pre></div>
<p>两个细节，都是踩过的：</p>
<ul><li><strong><code>pageNo</code> 走 <code>pageParams(url).page</code></strong>，不是 <code>url.searchParams.get(&#39;page&#39;)</code>。后者拿到的是原始字符串，<code>?page=abc</code>、<code>?page=1e21</code>、<code>?page=-5</code> 各有各的写法；前者已经做了 <code>MAX_PAGE = 10000</code> 上界和 <code>Number.isFinite</code> 判定。同一个参数在全站只能解析一次，这是 <code>QP-05</code> 那条元断言守的。</li><li><strong>判定用 <code>pathname</code> 前缀，不用 <code>paged</code> 白名单外的东西</strong>。首页写 <code>=== &#39;/&#39;</code> 不写 <code>startsWith(&#39;/&#39;)</code> —— 后者会把所有路径都放进来。</li></ul>
<p>顺便把 <code>size</code> 也验了一遍，因为它看起来像同类参数。结论是页面这一侧根本不认它：<code>/?size=1&amp;page=5</code> 返回 404，说明 <code>listParams</code> 只取 <code>page</code>，列表固定每页 10 条，<code>size</code> 对页面内容零影响。<code>/?size=50&amp;page=1</code> 的 canonical 是 <code>/</code>，内容与 <code>/</code> 逐字相同 —— 丢掉它是对的，和丢掉 <code>utm_*</code>、<code>?cb=</code> 一样。</p>
<p>同一个 <code>size</code> 在 <code>/api/posts</code> 上却是有效参数（<code>pageParams</code> 里夹了 1~50）。<strong>同一参数在两个出口含义不同</strong>这件事本身不难，难的是别让它渗进 canonical：页面侧只要问一句「这个参数会改变我渲染的内容吗」，答案是不会，就不写进规范地址。<code>check:live</code> 那 5 条断言用的是 canonical 的<strong>精确相等</strong>（不是「包含」），所以多写一个参数就会红。</p>
<h2 id="三-max-a-b-在-group-by-里不是聚合"><a class="h-anchor" href="#三-max-a-b-在-group-by-里不是聚合">#</a>三、<code>MAX(a,b)</code> 在 <code>GROUP BY</code> 里不是聚合</h2>
<p>这条比页码隐蔽得多，因为它<strong>看起来就是对的</strong>。</p>
<p><code>sitemap.xml</code> 里每个栏目页、标签页、系列页都要一个 <code>lastmod</code>：这一页的内容变了，是因为它下面某篇文章变了，所以取组内最大值。原来的写法：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql"><span class="tok-f">MAX</span>(<span class="tok-f">COALESCE</span>(p.updated_at, p.created_at))</code></pre></div>
<p>一个参数，是聚合函数，没问题。改成「取发布日与更新日之较大者」时，最自然的写法是：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql"><span class="tok-f">MAX</span>(p.published_at, p.updated_at)</code></pre></div>
<p>两个参数。<strong>这是标量函数</strong>，逐行求值，不是聚合。放进 <code>GROUP BY</code> 的查询里，SQLite 对「非聚合表达式」的处理是取组内任意一行 —— 文档里的说法是 bare columns，实际扫到哪行算哪行。</p>
<p>用 <code>node:sqlite</code> 在内存库里搭了六行数据（两篇 11 月已发、两篇排期到次年 1 月和 2 月、两篇 teardown），跑三种写法：</p>
<div class="table-wrap"><table><thead><tr><th>写法</th><th><code>log</code> 组</th><th><code>teardown</code> 组</th></tr></thead><tbody><tr><td><code>MAX(published_at, updated_at)</code>（单层，标量）</td><td>2026-11-21 01:00</td><td>2026-11-27 01:00</td></tr><tr><td><code>MAX(MAX(published_at, updated_at))</code>（外层聚合）</td><td><strong>2027-02-03 01:00</strong></td><td><strong>2026-11-29 01:00</strong></td></tr><tr><td>旧口径 <code>MAX(COALESCE(updated_at, created_at))</code></td><td>2026-11-22 18:31</td><td>2026-11-19 10:40</td></tr></tbody></table></div>
<p>第一行就是坑：<code>log</code> 组里最新的公开时间是次年 2 月 3 日，单层写法给出 11 月 21 日 —— 那是组里第一行，跟「最大」毫无关系。差 74 天。</p>
<p>第二行多包一层就对了：内层 <code>MAX(a, b)</code> 逐行取两列的大值，外层 <code>MAX(...)</code> 才是组内聚合。SQLite 允许这种嵌套，因为两层在语义上本来就是两件事：<strong>行内的 max 和组内的 max</strong>。</p>
<p>根源是 <code>MAX</code> 这一个名字背了两个身份：单参数时是聚合，多参数时是标量。Postgres 和 MySQL 把这两件事拆成 <code>MAX()</code> 与 <code>GREATEST()</code>，所以同一句写错在那边会直接报「参数个数不对」；SQLite 选择兼容而非报错，于是错的那个写法安静地跑出结果。<strong>能跑的错最贵</strong>，这一条在 SQL 里和在 CSS 里一样成立。</p>
<p>这个错误之所以难发现，是因为<strong>同一个表达式在别的位置是对的</strong>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">-- 单行查询：正确，这一行取两列的大值
SELECT slug, <span class="tok-f">MAX</span>(published_at, updated_at) AS last FROM posts WHERE slug = ?;</code></pre></div>
<p><code>WHERE slug = ?</code> 只出一行，<code>MAX(a, b)</code> 逐行求值正好就是要的语义。把它从「单行」上下文搬进「分组」上下文时，SQL 一个字都没改，含义从「取两列大值」变成「取两列大值，然后随便挑一行」。<strong>上下文换了，表达式没换</strong> —— 这类错误在 code review 里几乎不可见，因为看的人是按单行的语义在读。</p>
<p>第一版我就是这么写的。本地跑 SQL 对着数据看才发现：<code>log</code> 组最新是次年 2 月，输出却是 11 月。当时第一反应是「数据没进去」，查了三次库才回头怀疑表达式 —— 这是最典型的「现象像 A、根因在 B」。</p>
<p>第三行是旧口径，问题在下一节。</p>
<p>真正落地的 SQL 还得处理空字符串。本站的 <code>published_at</code> 有 <code>&#39;&#39;</code>（草稿），<code>COALESCE(NULLIF(x, &#39;&#39;), &#39;0&#39;)</code> 把它压成字符串 <code>&#39;0&#39;</code>，这样比较时不会因为 <code>NULL</code> 让整行被聚合函数忽略：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> stamp = (a) =&gt;
  <span class="tok-s">`MAX(MAX(COALESCE(NULLIF(${a}.published_at, &#39;&#39;), &#39;0&#39;), COALESCE(${a}.updated_at, ${a}.created_at, &#39;0&#39;)))`</span>;</code></pre></div>
<p>这里有个容易搞混的地方：<strong>单篇文章的 <code>lastmod</code> 不是 SQL 算的</strong>，是 JS 里比较两个字符串：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> lastOf = (p) =&gt; {
  <span class="tok-k">const</span> a = <span class="tok-f">String</span>(p.updated_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">const</span> b = <span class="tok-f">String</span>(p.published_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">return</span> (a &gt; b ? a : b).<span class="tok-f">slice</span>(<span class="tok-n">0</span>, <span class="tok-n">10</span>);
};</code></pre></div>
<p>字符串比较对 <code>YYYY-MM-DD HH:MM:SS</code> 这种定长格式是正确的，所以单篇那一处从来没出过问题。出问题的只有聚合那一处 —— 也就是说，<strong>同一个语义在两条路径上各写了一遍，一条对一条错</strong>。这种结构下次还会错，所以断言要盯的不是「这行对不对」，而是「这条语义有几处实现」。</p>
<h2 id="四-lastmod-早于-datepublished"><a class="h-anchor" href="#四-lastmod-早于-datepublished">#</a>四、<code>lastmod</code> 早于 <code>datePublished</code></h2>
<p>修好聚合，再看数据本身。</p>
<p>这条不是我肉眼发现的，是断言先报的。<code>check-sitemap.mjs</code> 里加了七行：抽 sitemap 里最新的三篇文章页，逐篇抓下来取 <code>datePublished</code>，和 <code>&lt;lastmod&gt;</code> 比大小，任何一篇倒挂就红。第一次跑就红了一篇 —— 在此之前，这个站已经带着这条矛盾跑了一个月，期间没人报错，页面看着完全正常。</p>
<p>线上 <code>sitemap.xml</code> 当时 50 条 <code>&lt;url&gt;</code>，其中 18 条是文章页。逐篇抓页面比 <code>datePublished</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">sitemap 50 条，文章 18 篇，倒挂 1 篇：
  ld-self-reference lastmod 2026-11-13 &lt; datePublished 2026-11-21</code></pre></div>
<p>只有一篇，但那不是偶然。11-21 那篇是 11-14 当天写完的存货，<code>updated_at</code> 停在 11-14，<code>published_at</code> 是 11-21。而本站从 11-21 起改成了「2 天一篇」，库存里还有十几篇是 11 月写完、12 月到次年 2 月才开闸的 —— 它们上线之后，每一篇都是倒挂，只是现在还没到日子。</p>
<p>本地模拟一篇排期稿验证（<code>published_at</code> 给过去时间让它上线，<code>updated_at</code> 给 11 月）：</p>
<div class="table-wrap"><table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody><tr><td><code>published_at</code></td><td>2026-11-22 12:00:00</td></tr><tr><td><code>updated_at</code></td><td>2026-11-10 09:00:00</td></tr><tr><td>旧口径 <code>MAX(updated_at, created_at)</code></td><td>2026-11-20 16:53（组内别的文章撑起来的）</td></tr><tr><td>单篇旧写法（<code>updated_at</code>）</td><td>2026-11-10</td></tr><tr><td>修后单篇 <code>lastmod</code></td><td>2026-11-22</td></tr><tr><td>页面 <code>datePublished</code></td><td><code>2026-11-22T12:00:00.000Z</code></td></tr></tbody></table></div>
<p>单篇倒挂 12 天，栏目聚合倒挂 2 天（被组里更新的一篇压住了，所以看起来「还好」——这种「看起来还好」比明显坏更麻烦，它会让你以为不用修）。</p>
<p>为什么这件事值得修，而不是「反正搜索引擎也不看」：<code>lastmod</code> 是站点自己声明的「内容最后一次变」的时间，<code>datePublished</code> 是「第一次可见」的时间。后者不可能早于前者。当这两个信号互相矛盾时，搜索引擎的合理反应是<strong>降低这两个信号的权重</strong>，而这个站几乎所有 SEO 判断都建立在时间信号上：sitemap 优先级、归档排序、RSS 顺序、<code>dateModified</code>。</p>
<p>修法就是把「发布也是一次内容变化」落进 SQL：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 组内聚合（栏目页 / 标签页 / 系列页）：SQL 里算</span>
<span class="tok-k">const</span> lastUpd = (a = <span class="tok-s">&#39;p&#39;</span>) =&gt; <span class="tok-f">stamp</span>(a);   <span class="tok-c">// stamp 就是上面那个 外层MAX(内层MAX(...))</span>

<span class="tok-c">// 单篇：JS 里比两个字符串，不走 SQL</span>
<span class="tok-k">const</span> lastOf = (p) =&gt; {
  <span class="tok-k">const</span> a = <span class="tok-f">String</span>(p.updated_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">const</span> b = <span class="tok-f">String</span>(p.published_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">return</span> (a &gt; b ? a : b).<span class="tok-f">slice</span>(<span class="tok-n">0</span>, <span class="tok-n">10</span>);
};</code></pre></div>
<p><code>stamp()</code> 同时用在单篇和组内聚合上 —— 一处定义，六处引用（首页、归档、栏目总览、每个栏目页、每个标签页、每个系列页）。改口径只改一行。</p>
<p>里面那个 <code>COALESCE(NULLIF(p.updated_at, &#39;&#39;), p.created_at, &#39;0&#39;)</code> 值得单说：本站的 <code>published_at</code> 有 <code>&#39;&#39;</code>（草稿从没发布过）。<code>NULLIF(x, &#39;&#39;)</code> 把空串变成 <code>NULL</code>，<code>COALESCE</code> 再往后取 <code>created_at</code>，最后兜一个 <code>&#39;0&#39;</code>。三层兜底看着啰嗦，缺一层的后果分别是：空串参与字符串比较时排在任何日期之前（<code>&#39;&#39; &lt; &#39;2026&#39;</code>），于是草稿会被当成「最老的一篇」；<code>NULL</code> 会让 <code>MAX()</code> 直接忽略这一行，组内一篇都没发布时聚合结果是 <code>NULL</code>，<code>&lt;lastmod&gt;</code> 就变成空标签。</p>
<p>顺带一个同源问题：时间信号在站里有三处出口 —— sitemap 的 <code>&lt;lastmod&gt;</code>、页面 JSON-LD 的 <code>dateModified</code>、RSS 的 <code>&lt;pubDate&gt;</code>。三处各自从 <code>post</code> 对象取时间，谁都不引用谁。这轮只统一了 sitemap 这一处，另外两处用的是发布日（<code>pubDate</code> 本来就该是发布日）或 <code>updated_at</code>（<code>dateModified</code> 本来就该是最后编辑），语义上没错，但它们之间<strong>没有断言把它们钉在一起</strong> —— 与 P-043 同一个教训：同源字段，要么同源，要么有断言。</p>
<h2 id="五-修完之后-同一个坑边上还有一处"><a class="h-anchor" href="#五-修完之后-同一个坑边上还有一处">#</a>五、修完之后，同一个坑边上还有一处</h2>
<p>P-044 上一轮已经修过一次：500 时按 <code>Accept</code> 分流，浏览器拿自绘页，<code>curl</code> 拿 JSON。</p>
<p>修完我以为这条结了。这一轮为了验证，往 <code>handleFetch</code> 第一行插了一行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (<span class="tok-k">new</span> <span class="tok-f">URL</span>(request.url).pathname === <span class="tok-s">&#39;/__boom&#39;</span>) <span class="tok-k">throw</span> <span class="tok-k">new</span> <span class="tok-f">Error</span>(<span class="tok-s">&#39;D1_ERROR: no such table: posts&#39;</span>);</code></pre></div>
<p><code>curl</code> 不带 Accept —— 拿到的是原文：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">http</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-http">HTTP/<span class="tok-n">1.1</span> <span class="tok-n">500</span> Internal Server Error
content-type: application/json; charset=utf-<span class="tok-n">8</span>

{<span class="tok-s">&quot;ok&quot;</span>:<span class="tok-k">false</span>,<span class="tok-s">&quot;error&quot;</span>:<span class="tok-s">&quot;D1_ERROR: no such table: posts&quot;</span>}</code></pre></div>
<p>53 字节，表名、SQL 方言、出错位置，一个不少。</p>
<p>原因很直接：<code>handleFetch</code> 里的 <code>try</code> 只包住了 <code>route()</code> 分发那一段。异常如果抛在它前面（HEAD 预处理、URL 解析）或者后面（ETag、日志上报），到不了内层那个已经改好的 catch，一路掉到最外层：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">async</span> <span class="tok-f">fetch</span>(request, env, ctx) {
  <span class="tok-k">const</span> startedAt = Date.<span class="tok-f">now</span>();
  <span class="tok-k">let</span> res;
  <span class="tok-k">try</span> {
    res = <span class="tok-k">await</span> <span class="tok-k">this</span>.<span class="tok-f">handleFetch</span>(request, env, ctx);
  } <span class="tok-k">catch</span> (e) {
    res = <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: e.message }, <span class="tok-n">500</span>);   <span class="tok-c">// ← 这里还是裸的</span>
  }
  ...
}</code></pre></div>
<p><strong>同一条规则写在两处，上一轮只改了一处。</strong> 这是 P-030 记过的老毛病（<code>ownerOrAdmin</code> 那两处内联判定），第二次发作，同一个形态：不是不知道规则，是规则有第二份实现。</p>
<p>两层的分工：内层 catch 拦业务层（<code>route()</code> 里的 D1 报错、模板取值失败），外层 catch 拦框架层（HEAD 预处理、URL 解析、日志上报）。抽成同一个函数之后，内层其实可以删掉，让异常一路冒到外层，回包一模一样。但这次不删 —— 删它是纯重构，对行为零收益，而这一轮已经有四处改动了。最小改动的边界在这里：<strong>该合并的是判断，不是控制流</strong>。</p>
<p>这次不补分支，抽成一个函数，两个 catch 都调它：</p>
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
20</span><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">fatalResponse</span>(request, e) {
  console.<span class="tok-f">error</span>(e);
  <span class="tok-k">let</span> here = <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">try</span> {
    here = <span class="tok-k">new</span> <span class="tok-f">URL</span>(request.url).pathname;
  } <span class="tok-k">catch</span> {}
  <span class="tok-k">const</span> wantsHtml =
    !here.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/api/&#39;</span>) &amp;&amp;
    (request.method === <span class="tok-s">&#39;GET&#39;</span> || request.method === <span class="tok-s">&#39;HEAD&#39;</span>) &amp;&amp;
    /text\/html/.<span class="tok-f">test</span>(request.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;accept&#39;</span>) || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">if</span> (wantsHtml) {
    <span class="tok-k">return</span> <span class="tok-k">new</span> <span class="tok-f">Response</span>(<span class="tok-f">serverErrorPage</span>(), {
      status: <span class="tok-n">500</span>,
      headers: { <span class="tok-s">&#39;content-type&#39;</span>: <span class="tok-s">&#39;text/html; charset=utf-8&#39;</span>, <span class="tok-s">&#39;cache-control&#39;</span>: <span class="tok-s">&#39;no-store&#39;</span>, <span class="tok-s">&#39;retry-after&#39;</span>: <span class="tok-s">&#39;60&#39;</span> },
    });
  }
  <span class="tok-k">return</span> here.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/api/&#39;</span>)
    ? <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: e.message }, <span class="tok-n">500</span>)
    : <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: <span class="tok-s">&#39;服务器错误&#39;</span> }, <span class="tok-n">500</span>);
}</code></pre></div>
<p>里面那个 <code>try { new URL() } catch {}</code> 不是凑数：外层 catch 存在的意义就是兜「连 request 都解析不了」的意外，如果兜底的函数自己再抛一次 <code>TypeError: Invalid URL</code>，就等于没有兜底。拿不到路径时按非 API 处理 —— 这是唯一安全的默认。</p>
<p>改完同一组注入，三种观众：</p>
<div class="table-wrap"><table><thead><tr><th>请求</th><th>修复前</th><th>修复后</th></tr></thead><tbody><tr><td><code>curl /__boom</code>（无 Accept）</td><td>500 <code>{&quot;error&quot;:&quot;D1_ERROR: no such table: posts&quot;}</code>，53 B</td><td>500 <code>{&quot;error&quot;:&quot;服务器错误&quot;}</code></td></tr><tr><td><code>curl -H &#39;Accept: text/html&#39; /__boom</code></td><td>500 自定义页（内层 catch 挡住了，本来就没漏）</td><td>500 自定义页，1109 B，<code>D1_ERROR</code> 出现 0 次</td></tr><tr><td><code>curl /api/_boom</code></td><td>500 原文</td><td>500 原文（API 本来就要）</td></tr></tbody></table></div>
<h2 id="六-断言-先让它红"><a class="h-anchor" href="#六-断言-先让它红">#</a>六、断言：先让它红</h2>
<p>四条修复，五组断言。原则没变：<strong>没在旧代码上见过它红的断言，不算断言</strong>。</p>
<div class="table-wrap"><table><thead><tr><th>编号</th><th>断言</th><th>位置</th><th>修前</th></tr></thead><tbody><tr><td><code>[P-042]</code></td><td><code>/?page=1</code> 归一到 <code>/</code></td><td><code>check-live</code> 第 13 节</td><td>红（canonical 是 <code>?page=1</code>）</td></tr><tr><td><code>[P-042]</code></td><td><code>/?page=2</code> 保留页码</td><td>同上</td><td>绿</td></tr><tr><td><code>[P-042]</code></td><td>首页越界 404</td><td>同上</td><td>红（200）</td></tr><tr><td><code>[P-042]</code></td><td>404 页里没有列表空态</td><td>同上</td><td>红</td></tr><tr><td><code>[P-042]</code></td><td>归档页的 page 不进 canonical</td><td>同上</td><td>红（canonical 带 <code>?page=9</code>）</td></tr><tr><td><code>[P-042]</code></td><td>栏目页越界 404</td><td>同上</td><td>红</td></tr><tr><td><code>QP-06</code></td><td>越界判定与 <code>notFoundPage</code> 都在</td><td>离线</td><td>红（判据不存在）</td></tr><tr><td><code>QP-07</code></td><td><code>paged</code> 只认三种路径、<code>pageNo &gt; 1</code></td><td>离线</td><td>红</td></tr><tr><td><code>[P-043]</code></td><td>抽 3 篇比 <code>lastmod &gt;= datePublished</code></td><td><code>check-sitemap</code></td><td>红（1 篇倒挂）</td></tr><tr><td><code>RB-07</code></td><td>非 API 的 500 不回原文</td><td>离线</td><td>绿（上一轮修的）</td></tr><tr><td><code>RB-07</code></td><td>两个 catch 共用同一出口（≥ 2 处调用）</td><td>离线</td><td><strong>红</strong>（只有 1 处）</td></tr><tr><td><code>RB-07</code></td><td>catch 块里没有第二份 500 分支实现</td><td>离线</td><td><strong>红</strong></td></tr></tbody></table></div>
<p><code>QP-06</code> / <code>QP-07</code> / <code>RB-07</code> 是离线那一半：线上那一半要部署才验得了，而部署前必须有一个「规则还在代码里」的守卫，否则改回去的时候没人知道。</p>
<p>这两层不能互相替代。线上断言证明的是<strong>行为</strong>（<code>?page=999</code> 真的 404），但它要部署才能跑，写代码的当下一个字都验不了；离线断言证明的是<strong>形状</strong>（判定还在、分支还在），当场能跑，但它证明不了这条分支真的被走到。上一轮假绿那件事（同步 <code>t()</code> 吞掉 async 用例）就是「形状对了、行为没跑」的极端形态 —— 六条断言全是绿的，一次都没执行过。</p>
<p>所以这一轮的分工是：能在本地打到的（越界 404、canonical 三种路径、sitemap 单篇日期）写行为断言；只有部署后才成立的（线上的 5 条 <code>[P-042]</code>）既写线上断言，也在离线加一条「这条规则没被删」的影子断言。</p>
<p>三条注入验证，都实测过：</p>
<div class="table-wrap"><table><thead><tr><th>改动</th><th>期望</th><th>实际</th></tr></thead><tbody><tr><td>外层 catch 改回 <code>json({ error: e.message }, 500)</code></td><td>RB-07 两条红</td><td>双红（<code>只有 1 处调用</code> / <code>1 个 catch 又自己拼了 e.message</code>）</td></tr><tr><td>越界判定删掉</td><td>QP-06 红</td><td>红</td></tr><tr><td><code>paged</code> 判定去掉 <code>pageNo &gt; 1</code></td><td>QP-07 红</td><td>红</td></tr></tbody></table></div>
<p><code>[P-043]</code> 那条有个实现上的取舍：为什么抽 3 篇而不是全量？全量要抓 18 个页面，<code>check:live</code> 一轮从 40 秒涨到 90 秒，而倒挂只发生在「刚上线不久的排期稿」身上 —— sitemap 按发布时间倒序排，前 3 条正好覆盖这个窗口。不是完美覆盖，是成本与覆盖面的取舍，写在这儿免得下次有人以为它检查了全部。</p>
<h2 id="七-明说的没做"><a class="h-anchor" href="#七-明说的没做">#</a>七、明说的没做</h2>
<ul><li><strong><code>/archive</code> 没加分页</strong>。它一次列全部，<code>page</code> 不参与查询。真要有几百篇再考虑，现在的做法是让 <code>page</code> 不进 canonical，不假装它分页。</li><li><strong>标签页的 60 秒 404 缓存没动</strong>。<code>/tag/&lt;不存在&gt;</code> 写 60 秒的 404 缓存，零回显（P-032 记过），能被灌 60 秒窗口，但拦不住的真实攻击者也不在乎 60 秒。</li><li><strong>没改 <code>sitemap</code> 的优先级（<code>&lt;priority&gt;</code>）</strong>。改 lastmod 就够了，priority 早就被 Google 公开说明「不用」。</li><li><strong>没做 404 文案分类</strong>。现在越界页码、不存在的 slug、不存在的标签共用一张 404 页，只有 H1 下面那句副标题不同。够用。</li><li><strong>没验证爬虫侧的实际反应</strong>。软 404 从 200 改成 404 之后，收录数怎么变、抓取频次怎么变，这个站没有 Search Console 的对照数据，只能等四周后再看。这篇里关于「软 404 更浪费抓取预算」的说法是推断，不是实测。</li><li><strong>没重测首屏</strong>。这轮改的是分页边界、SQL 聚合、异常出口，一处都不在前端渲染路径上。</li><li><strong>写作时还没部署，发布前已部署</strong>。改之前线上 111 通过 / 5 失败，5 条全是 <code>[P-042]</code> —— 那正是「修好了但没上线」的样子，不是回归；部署后 116 通过 / 0 失败。第一轮体检还剩一条「栏目页越界 200」，是部署前那张越界页被边缘缓存了 300 秒，绕缓存重打就是 404 —— 这一条本身就是 P-042 的注脚：<strong>200 的空页连缓存都愿意收</strong>。</li></ul>
<h2 id="复现条件"><a class="h-anchor" href="#复现条件">#</a>复现条件</h2>
<ul><li>环境：Node 22.22.2，<code>node:sqlite</code>（内存库，不需要 D1），本地 <code>wrangler dev --port 8791 --local</code></li><li>数据：本地 D1 18 篇 / 17 篇公开 / 每页 10 篇 → <code>pages = 2</code></li><li>触发一：<code>curl -o /dev/null -w &#39;%{http_code}&#39; &#39;http://127.0.0.1:8791/?page=999&#39;</code></li><li>期望：404；实际：404（<code>2682</code> 字节的 404 页，<code>class=&quot;empty&quot;</code> 出现 0 次）</li><li>触发二：插一篇 <code>published_at</code> 晚于 <code>updated_at</code> 的稿，抓 <code>/sitemap.xml</code></li><li>期望：<code>&lt;lastmod&gt;</code> 等于发布日；实际：<code>2026-11-22</code>，页面 <code>datePublished</code> 是 <code>2026-11-22T12:00:00.000Z</code></li><li>触发三：<code>handleFetch</code> 第一行临时 <code>throw</code>，<code>curl</code> 不带 Accept</li><li>期望：<code>{&quot;ok&quot;:false,&quot;error&quot;:&quot;服务器错误&quot;}</code>；实际：一致（注入行已删除）</li></ul>
<h2 id="断言代码"><a class="h-anchor" href="#断言代码">#</a>断言代码</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> scripts/test-query-params.mjs        <span class="tok-c"># QP-06 越界 404 / QP-07 canonical 只认三种路径</span>
<span class="tok-k">node</span> scripts/test-route-boundaries.mjs    <span class="tok-c"># RB-07 500 页静态、两个 catch 共用出口、无第二份实现</span>
<span class="tok-k">node</span> scripts/check-sitemap.mjs            <span class="tok-c"># [P-043] lastmod &gt;= datePublished（抽 3 篇）</span>
<span class="tok-k">npm</span> run check:live                        <span class="tok-c"># 第 13 节 [P-042] 5 条，需部署后才绿</span></code></pre></div>
<p>一处提醒：<code>check:live</code> 在部署后 5 分钟内跑，会有一组 ETag/304 假红 —— 边缘缓存 <code>s-maxage=300</code>，GET 还命中旧副本而 HEAD 已经落到新代码。等 5 分钟重跑，116/116。</p>', '', 'log', '越界页码返回 200 的空页，每张都自称规范地址；MAX(a,b) 在 GROUP BY 里是标量函数，组内最新时间退化成组里某一行的时间，差 74 天。两条都不会报错——页面 200、sitemap 是合法 XML。修完还发现 500 的出口有两处，上一轮只改了一处，curl 拿到的仍是 D1_ERROR 原文。四条修复、五组断言，都在旧代码上验过会红。',
        '', 0, 0, 0, 1, '2027-02-17 01:00:00', datetime('now'), datetime('now'))
ON CONFLICT(slug) DO NOTHING;

-- 正文修订：改稿后重放一次，只覆盖正文与摘要，不动 published_at / hidden
UPDATE posts SET content = '# 两个都不报错的错：越界页码 200，MAX 写成了标量

## 结论

一份十条的清单里，七条我实测不成立，三条真会咬人。三条当中又有两条是同一类：

1. **`/?page=999` 返回 200 的空列表**，而且 canonical 写着 `?page=999` 自己。分页链接有边界（末页不渲染「下一页」），URL 没有 —— 爬虫不用点链接，拼数字就能造出无限多张「空但合格」的页，每张都自称规范地址。
2. **`MAX(a, b)` 在 `GROUP BY` 里不是聚合**，是标量函数。SQLite 对组内非聚合表达式的处理是「取任意一行」，于是「组内最新的更新时间」变成了「组里某一行的时间」。写成 `MAX(MAX(a, b))` 才对，多一层嵌套，差的是几个月。
3. 顺着第 2 条查 `sitemap.xml`，发现 **`lastmod` 早于 `datePublished`**：线上 18 篇文章里 1 篇倒挂（11-13 对 11-21）。排期稿越多，倒挂越多。

修完这三条，我又在同一个坑边上发现第四条：**500 的出口有两个，我上一轮只修了一个**。内层 catch 已经按路径分流，最外层那个还是裸的 `error: e.message`。把异常扔在 `handleFetch` 开头试，`curl` 拿到的就是 `{"error":"D1_ERROR: no such table: posts"}` —— 和修之前一模一样。

四条的共同点：**没有一条会报错，没有一条会被工具发现**。页面是 200，sitemap 是合法 XML，JSON 也是合法 JSON。

这轮的顺序因此反过来了：不是读代码找问题，是先把清单里的地址和字段逐条打一遍，能复现的才排优先级。七条当场消失，剩下三条各配一条断言，改完再让断言在旧代码上红一次 —— 红不了的那条，说明它测的不是这次改的东西。

## 一、先看清单里成立的那三条

材料给的形式是「问题 + 建议 + 优先级」。先按「会不会真出事」过一遍，成立的留下来：

| 材料说 | 实测 | 判断 |
|---|---|---|
| 越界页码返回空页，应该 404 | `/?page=999` 200、`/cat/log?page=999` 200、`/tag/x?page=999` 200，三处都自指 canonical | **成立**，见第二节 |
| `sitemap` 的 lastmod 有错 | 18 篇里 1 篇 `lastmod` 早于 `datePublished` | **成立**，见第四节 |
| 500 页会把异常原文回给调用方 | 带 `Accept: text/html` 的是自定义页（这条材料判错），不带 Accept 的拿到 `D1_ERROR: no such table` | **一半成立**，见第五节 |

不成立的七条里，最典型的是三条：

| 材料说 | 实测 |
|---|---|
| 搜索框没有接服务端，只是前端过滤 | `/api/posts?q=` 走 SQL LIKE，前端 320ms 防抖 + AbortController + `mark` 高亮 + 空态，都在 |
| 没有 `/series` 页面 | `/series` 与 `/series/<名称>` 都 200，都在 sitemap 里 |
| 列表图没做懒加载 | `loading="lazy"` + 宽高属性本来就有，缺的是「图片尺寸写死 vs 自适应」的取舍，不是懒加载 |

这三条我一条都没动。改一个已经正确的实现，比不改更危险 —— 下一轮审计会看到「这里被人动过」，然后重新怀疑一遍。

## 二、越界页码：页面有边界，URL 没有

修复前，线上是这样一个状态（2026-11-24 抓的，`cache-control: no-cache` 绕缓存）：

| 请求 | 状态 | 返回条数 | canonical |
|---|---|---|---|
| `/` | 200 | 10 | `/` |
| `/?page=1` | 200 | 10 | `/?page=1` |
| `/?page=2` | 200 | 8 | `/?page=2` |
| `/?page=3` | 200 | 0 | `/?page=3` |
| `/?page=999` | 200 | 0 | `/?page=999` |
| `/cat/log?page=999` | 200 | 0 | `/cat/log?page=999` |
| `/tag/cloudflare?page=999` | 200 | 0 | `/tag/cloudflare?page=999` |
| `/archive?page=9` | 200 | — | `/archive?page=9` |

（返回条数取自 `/api/posts`，和页面用的是同一个 `pageParams`；归档页不分页，所以是「—」。）

站点当时 18 篇公开、每页 10 篇，`pages = 2`。所以第 3 页开始全是越界，全部 200。

成因一句话：`OFFSET` 越过末尾时 SQLite 返回空数组，不是错误。模板拿到空数组就渲染成「还没有文章」，状态码按默认 200 出去。没人问过「越界时该回什么」。

严格说，这是两个层面的默认值叠在一起的结果。数据层：空结果集是**正常**返回值，不是异常。模板层：列表为空只有一种表达方式，就是空态文案。HTTP 层：没人显式设状态码，于是 200。三层各自都对，合起来就错了 —— 因为 HTTP 层缺一个判断：**「这一页没有内容」和「这一页不存在」是两件事**。

首页没有文章是前者（站刚建，200 的空态正确）；第 999 页没有文章是后者（这一页不在分页序列里，应该是 404）。两者在数据层长得一模一样，都是空数组，所以这个判断只能由知道 `total` 和 `pages` 的那一层来做。

危险的地方不在「空页难看」，在于**三件事叠加**：

1. **状态码是 200**，不是 404 也不是 410。爬虫会收录。
2. **canonical 自指**。`fillSeo` 把 `page` 参数无条件抄进规范地址，于是每一张空页都声明「我就是这一页的规范版本」，不会被去重。
3. **URL 是无边界的**。分页链接只到末页，但参数可以拼任意整数：`?page=3` 到 `?page=999999` 全都能生成一张独立的、合格的、自指的页面。

这不是理论风险。站内分页链只在末页停住，而爬虫发现新 URL 的方式不止「顺着链接爬」——日志、外链、站点地图、别人贴的地址，都能带进来一个 `?page=500`。

这类页面在 SEO 里有个专门名字：**软 404**。状态码说「正常」，内容说「什么都没有」。搜索引擎对软 404 的处理比 404 更麻烦 —— 404 是明确的「这里没有东西，别再来了」，软 404 是「这里有个页面，但它什么都不说」，后者只会被反复抓取、反复判断。我没有这个站的抓取日志，能说的到这儿为止：软 404 的数量级和收录影响**没有实测**，只有定性判断。

修法只有两行，但位置很关键。判定放在 `injectTheme` 里、拿到 `list` 之后：

```js
// 总数 > 0 且页码超出末页时才 404；一篇都没有的站仍然给 200 的首页空态
if (list && list.total > 0 && list.page > list.pages) {
  return await notFoundPage(env, null, ''这一页没有文章'');
}
```

`total > 0` 这个条件是必须的：一个刚建好、还没发文的站，首页本来就该是 200 的空态，不能因为 `pages = 0` 就把首页判成 404。

为什么不放在 `route()` 里拦？因为那里拿不到 `total` —— 要知道一条记录是「第 3 页」还是「越界」，必须先查一次总数。而 `route()` 只做分发、不碰 SQL（`RB-06` 那条断言守着这个边界）。把判断放在 `list` 已经算出来的地方，是最小代价：不新增查询、不新增解析点，`list.page` 和 `list.pages` 本来就是列表查询的返回值。

修完在本地重跑同一组地址（本地库 18 篇，17 篇公开，每页 10 篇 → `pages = 2`）：

| 请求 | 修复前 | 修复后 | canonical |
|---|---|---|---|
| `/?page=1` | 200 | 200 | `/` |
| `/?page=2` | 200 | 200 | `/?page=2` |
| `/?page=3` | 200 空列表 | **404** | 无 |
| `/?page=999` | 200 空列表 | **404** | 无 |
| `/cat/log?page=999` | 200 空列表 | **404** | 无 |
| `/tag/cloudflare?page=999` | 200 空列表 | **404** | 无 |
| `/archive?page=9` | 200，canonical 带页码 | 200 | `/archive` |

404 页 2682 字节，正文里 `class="empty"` 出现 0 次 —— 这一条很重要：只把状态码改成 404、页面里还留着「这个栏目下还没有文章」，那等于换了个牌子继续骗人。断言里专门有一条查它。

**第二种无效输入：page 参数本身。**

`?page=1` 与不带参数是**逐字相同**的内容，但它们曾经是两个地址，各自 canonical 自指。这是最典型的重复内容：同一页的两份地址，谁都不让谁。

归档页是另一种：`/archive` 一次列全部，`page` 根本不参与查询。所以 `/archive?page=9` 与 `/archive` 输出同一份 HTML，九个不同的地址全都自称规范。

只让「真分页」的三种路径在 `page > 1` 时保留页码：

```js
const paged = !!url && (url.pathname === ''/'' || url.pathname.startsWith(''/tag/'') || url.pathname.startsWith(''/cat/''));
// 页码仍然只在这一处解析一次：走 pageParams，不自己 parseInt
const pageNo = url ? pageParams(url).page : 1;
if (canonicalUrl && paged && pageNo > 1) {
  canonicalUrl.searchParams.set(''page'', String(pageNo));
}
```

两个细节，都是踩过的：

- **`pageNo` 走 `pageParams(url).page`**，不是 `url.searchParams.get(''page'')`。后者拿到的是原始字符串，`?page=abc`、`?page=1e21`、`?page=-5` 各有各的写法；前者已经做了 `MAX_PAGE = 10000` 上界和 `Number.isFinite` 判定。同一个参数在全站只能解析一次，这是 `QP-05` 那条元断言守的。
- **判定用 `pathname` 前缀，不用 `paged` 白名单外的东西**。首页写 `=== ''/''` 不写 `startsWith(''/'')` —— 后者会把所有路径都放进来。

顺便把 `size` 也验了一遍，因为它看起来像同类参数。结论是页面这一侧根本不认它：`/?size=1&page=5` 返回 404，说明 `listParams` 只取 `page`，列表固定每页 10 条，`size` 对页面内容零影响。`/?size=50&page=1` 的 canonical 是 `/`，内容与 `/` 逐字相同 —— 丢掉它是对的，和丢掉 `utm_*`、`?cb=` 一样。

同一个 `size` 在 `/api/posts` 上却是有效参数（`pageParams` 里夹了 1~50）。**同一参数在两个出口含义不同**这件事本身不难，难的是别让它渗进 canonical：页面侧只要问一句「这个参数会改变我渲染的内容吗」，答案是不会，就不写进规范地址。`check:live` 那 5 条断言用的是 canonical 的**精确相等**（不是「包含」），所以多写一个参数就会红。

## 三、`MAX(a,b)` 在 `GROUP BY` 里不是聚合

这条比页码隐蔽得多，因为它**看起来就是对的**。

`sitemap.xml` 里每个栏目页、标签页、系列页都要一个 `lastmod`：这一页的内容变了，是因为它下面某篇文章变了，所以取组内最大值。原来的写法：

```sql
MAX(COALESCE(p.updated_at, p.created_at))
```

一个参数，是聚合函数，没问题。改成「取发布日与更新日之较大者」时，最自然的写法是：

```sql
MAX(p.published_at, p.updated_at)
```

两个参数。**这是标量函数**，逐行求值，不是聚合。放进 `GROUP BY` 的查询里，SQLite 对「非聚合表达式」的处理是取组内任意一行 —— 文档里的说法是 bare columns，实际扫到哪行算哪行。

用 `node:sqlite` 在内存库里搭了六行数据（两篇 11 月已发、两篇排期到次年 1 月和 2 月、两篇 teardown），跑三种写法：

| 写法 | `log` 组 | `teardown` 组 |
|---|---|---|
| `MAX(published_at, updated_at)`（单层，标量） | 2026-11-21 01:00 | 2026-11-27 01:00 |
| `MAX(MAX(published_at, updated_at))`（外层聚合） | **2027-02-03 01:00** | **2026-11-29 01:00** |
| 旧口径 `MAX(COALESCE(updated_at, created_at))` | 2026-11-22 18:31 | 2026-11-19 10:40 |

第一行就是坑：`log` 组里最新的公开时间是次年 2 月 3 日，单层写法给出 11 月 21 日 —— 那是组里第一行，跟「最大」毫无关系。差 74 天。

第二行多包一层就对了：内层 `MAX(a, b)` 逐行取两列的大值，外层 `MAX(...)` 才是组内聚合。SQLite 允许这种嵌套，因为两层在语义上本来就是两件事：**行内的 max 和组内的 max**。

根源是 `MAX` 这一个名字背了两个身份：单参数时是聚合，多参数时是标量。Postgres 和 MySQL 把这两件事拆成 `MAX()` 与 `GREATEST()`，所以同一句写错在那边会直接报「参数个数不对」；SQLite 选择兼容而非报错，于是错的那个写法安静地跑出结果。**能跑的错最贵**，这一条在 SQL 里和在 CSS 里一样成立。

这个错误之所以难发现，是因为**同一个表达式在别的位置是对的**：

```sql
-- 单行查询：正确，这一行取两列的大值
SELECT slug, MAX(published_at, updated_at) AS last FROM posts WHERE slug = ?;
```

`WHERE slug = ?` 只出一行，`MAX(a, b)` 逐行求值正好就是要的语义。把它从「单行」上下文搬进「分组」上下文时，SQL 一个字都没改，含义从「取两列大值」变成「取两列大值，然后随便挑一行」。**上下文换了，表达式没换** —— 这类错误在 code review 里几乎不可见，因为看的人是按单行的语义在读。

第一版我就是这么写的。本地跑 SQL 对着数据看才发现：`log` 组最新是次年 2 月，输出却是 11 月。当时第一反应是「数据没进去」，查了三次库才回头怀疑表达式 —— 这是最典型的「现象像 A、根因在 B」。

第三行是旧口径，问题在下一节。

真正落地的 SQL 还得处理空字符串。本站的 `published_at` 有 `''''`（草稿），`COALESCE(NULLIF(x, ''''), ''0'')` 把它压成字符串 `''0''`，这样比较时不会因为 `NULL` 让整行被聚合函数忽略：
```js
const stamp = (a) =>
  `MAX(MAX(COALESCE(NULLIF(${a}.published_at, ''''), ''0''), COALESCE(${a}.updated_at, ${a}.created_at, ''0'')))`;
```

这里有个容易搞混的地方：**单篇文章的 `lastmod` 不是 SQL 算的**，是 JS 里比较两个字符串：

```js
const lastOf = (p) => {
  const a = String(p.updated_at || '''');
  const b = String(p.published_at || '''');
  return (a > b ? a : b).slice(0, 10);
};
```

字符串比较对 `YYYY-MM-DD HH:MM:SS` 这种定长格式是正确的，所以单篇那一处从来没出过问题。出问题的只有聚合那一处 —— 也就是说，**同一个语义在两条路径上各写了一遍，一条对一条错**。这种结构下次还会错，所以断言要盯的不是「这行对不对」，而是「这条语义有几处实现」。

## 四、`lastmod` 早于 `datePublished`

修好聚合，再看数据本身。

这条不是我肉眼发现的，是断言先报的。`check-sitemap.mjs` 里加了七行：抽 sitemap 里最新的三篇文章页，逐篇抓下来取 `datePublished`，和 `<lastmod>` 比大小，任何一篇倒挂就红。第一次跑就红了一篇 —— 在此之前，这个站已经带着这条矛盾跑了一个月，期间没人报错，页面看着完全正常。

线上 `sitemap.xml` 当时 50 条 `<url>`，其中 18 条是文章页。逐篇抓页面比 `datePublished`：

```text
sitemap 50 条，文章 18 篇，倒挂 1 篇：
  ld-self-reference lastmod 2026-11-13 < datePublished 2026-11-21
```

只有一篇，但那不是偶然。11-21 那篇是 11-14 当天写完的存货，`updated_at` 停在 11-14，`published_at` 是 11-21。而本站从 11-21 起改成了「2 天一篇」，库存里还有十几篇是 11 月写完、12 月到次年 2 月才开闸的 —— 它们上线之后，每一篇都是倒挂，只是现在还没到日子。

本地模拟一篇排期稿验证（`published_at` 给过去时间让它上线，`updated_at` 给 11 月）：

| 字段 | 值 |
|---|---|
| `published_at` | 2026-11-22 12:00:00 |
| `updated_at` | 2026-11-10 09:00:00 |
| 旧口径 `MAX(updated_at, created_at)` | 2026-11-20 16:53（组内别的文章撑起来的） |
| 单篇旧写法（`updated_at`） | 2026-11-10 |
| 修后单篇 `lastmod` | 2026-11-22 |
| 页面 `datePublished` | `2026-11-22T12:00:00.000Z` |

单篇倒挂 12 天，栏目聚合倒挂 2 天（被组里更新的一篇压住了，所以看起来「还好」——这种「看起来还好」比明显坏更麻烦，它会让你以为不用修）。

为什么这件事值得修，而不是「反正搜索引擎也不看」：`lastmod` 是站点自己声明的「内容最后一次变」的时间，`datePublished` 是「第一次可见」的时间。后者不可能早于前者。当这两个信号互相矛盾时，搜索引擎的合理反应是**降低这两个信号的权重**，而这个站几乎所有 SEO 判断都建立在时间信号上：sitemap 优先级、归档排序、RSS 顺序、`dateModified`。

修法就是把「发布也是一次内容变化」落进 SQL：

```js
// 组内聚合（栏目页 / 标签页 / 系列页）：SQL 里算
const lastUpd = (a = ''p'') => stamp(a);   // stamp 就是上面那个 外层MAX(内层MAX(...))

// 单篇：JS 里比两个字符串，不走 SQL
const lastOf = (p) => {
  const a = String(p.updated_at || '''');
  const b = String(p.published_at || '''');
  return (a > b ? a : b).slice(0, 10);
};
```

`stamp()` 同时用在单篇和组内聚合上 —— 一处定义，六处引用（首页、归档、栏目总览、每个栏目页、每个标签页、每个系列页）。改口径只改一行。

里面那个 `COALESCE(NULLIF(p.updated_at, ''''), p.created_at, ''0'')` 值得单说：本站的 `published_at` 有 `''''`（草稿从没发布过）。`NULLIF(x, '''')` 把空串变成 `NULL`，`COALESCE` 再往后取 `created_at`，最后兜一个 `''0''`。三层兜底看着啰嗦，缺一层的后果分别是：空串参与字符串比较时排在任何日期之前（`'''' < ''2026''`），于是草稿会被当成「最老的一篇」；`NULL` 会让 `MAX()` 直接忽略这一行，组内一篇都没发布时聚合结果是 `NULL`，`<lastmod>` 就变成空标签。

顺带一个同源问题：时间信号在站里有三处出口 —— sitemap 的 `<lastmod>`、页面 JSON-LD 的 `dateModified`、RSS 的 `<pubDate>`。三处各自从 `post` 对象取时间，谁都不引用谁。这轮只统一了 sitemap 这一处，另外两处用的是发布日（`pubDate` 本来就该是发布日）或 `updated_at`（`dateModified` 本来就该是最后编辑），语义上没错，但它们之间**没有断言把它们钉在一起** —— 与 P-043 同一个教训：同源字段，要么同源，要么有断言。

## 五、修完之后，同一个坑边上还有一处

P-044 上一轮已经修过一次：500 时按 `Accept` 分流，浏览器拿自绘页，`curl` 拿 JSON。

修完我以为这条结了。这一轮为了验证，往 `handleFetch` 第一行插了一行：

```js
if (new URL(request.url).pathname === ''/__boom'') throw new Error(''D1_ERROR: no such table: posts'');
```

`curl` 不带 Accept —— 拿到的是原文：

```http
HTTP/1.1 500 Internal Server Error
content-type: application/json; charset=utf-8

{"ok":false,"error":"D1_ERROR: no such table: posts"}
```

53 字节，表名、SQL 方言、出错位置，一个不少。

原因很直接：`handleFetch` 里的 `try` 只包住了 `route()` 分发那一段。异常如果抛在它前面（HEAD 预处理、URL 解析）或者后面（ETag、日志上报），到不了内层那个已经改好的 catch，一路掉到最外层：

```js
async fetch(request, env, ctx) {
  const startedAt = Date.now();
  let res;
  try {
    res = await this.handleFetch(request, env, ctx);
  } catch (e) {
    res = json({ ok: false, error: e.message }, 500);   // ← 这里还是裸的
  }
  ...
}
```

**同一条规则写在两处，上一轮只改了一处。** 这是 P-030 记过的老毛病（`ownerOrAdmin` 那两处内联判定），第二次发作，同一个形态：不是不知道规则，是规则有第二份实现。

两层的分工：内层 catch 拦业务层（`route()` 里的 D1 报错、模板取值失败），外层 catch 拦框架层（HEAD 预处理、URL 解析、日志上报）。抽成同一个函数之后，内层其实可以删掉，让异常一路冒到外层，回包一模一样。但这次不删 —— 删它是纯重构，对行为零收益，而这一轮已经有四处改动了。最小改动的边界在这里：**该合并的是判断，不是控制流**。

这次不补分支，抽成一个函数，两个 catch 都调它：

```js
function fatalResponse(request, e) {
  console.error(e);
  let here = '''';
  try {
    here = new URL(request.url).pathname;
  } catch {}
  const wantsHtml =
    !here.startsWith(''/api/'') &&
    (request.method === ''GET'' || request.method === ''HEAD'') &&
    /text\/html/.test(request.headers.get(''accept'') || '''');
  if (wantsHtml) {
    return new Response(serverErrorPage(), {
      status: 500,
      headers: { ''content-type'': ''text/html; charset=utf-8'', ''cache-control'': ''no-store'', ''retry-after'': ''60'' },
    });
  }
  return here.startsWith(''/api/'')
    ? json({ ok: false, error: e.message }, 500)
    : json({ ok: false, error: ''服务器错误'' }, 500);
}
```

里面那个 `try { new URL() } catch {}` 不是凑数：外层 catch 存在的意义就是兜「连 request 都解析不了」的意外，如果兜底的函数自己再抛一次 `TypeError: Invalid URL`，就等于没有兜底。拿不到路径时按非 API 处理 —— 这是唯一安全的默认。

改完同一组注入，三种观众：

| 请求 | 修复前 | 修复后 |
|---|---|---|
| `curl /__boom`（无 Accept） | 500 `{"error":"D1_ERROR: no such table: posts"}`，53 B | 500 `{"error":"服务器错误"}` |
| `curl -H ''Accept: text/html'' /__boom` | 500 自定义页（内层 catch 挡住了，本来就没漏） | 500 自定义页，1109 B，`D1_ERROR` 出现 0 次 |
| `curl /api/_boom` | 500 原文 | 500 原文（API 本来就要） |

## 六、断言：先让它红

四条修复，五组断言。原则没变：**没在旧代码上见过它红的断言，不算断言**。

| 编号 | 断言 | 位置 | 修前 |
|---|---|---|---|
| `[P-042]` | `/?page=1` 归一到 `/` | `check-live` 第 13 节 | 红（canonical 是 `?page=1`） |
| `[P-042]` | `/?page=2` 保留页码 | 同上 | 绿 |
| `[P-042]` | 首页越界 404 | 同上 | 红（200） |
| `[P-042]` | 404 页里没有列表空态 | 同上 | 红 |
| `[P-042]` | 归档页的 page 不进 canonical | 同上 | 红（canonical 带 `?page=9`） |
| `[P-042]` | 栏目页越界 404 | 同上 | 红 |
| `QP-06` | 越界判定与 `notFoundPage` 都在 | 离线 | 红（判据不存在） |
| `QP-07` | `paged` 只认三种路径、`pageNo > 1` | 离线 | 红 |
| `[P-043]` | 抽 3 篇比 `lastmod >= datePublished` | `check-sitemap` | 红（1 篇倒挂） |
| `RB-07` | 非 API 的 500 不回原文 | 离线 | 绿（上一轮修的） |
| `RB-07` | 两个 catch 共用同一出口（≥ 2 处调用） | 离线 | **红**（只有 1 处） |
| `RB-07` | catch 块里没有第二份 500 分支实现 | 离线 | **红** |

`QP-06` / `QP-07` / `RB-07` 是离线那一半：线上那一半要部署才验得了，而部署前必须有一个「规则还在代码里」的守卫，否则改回去的时候没人知道。

这两层不能互相替代。线上断言证明的是**行为**（`?page=999` 真的 404），但它要部署才能跑，写代码的当下一个字都验不了；离线断言证明的是**形状**（判定还在、分支还在），当场能跑，但它证明不了这条分支真的被走到。上一轮假绿那件事（同步 `t()` 吞掉 async 用例）就是「形状对了、行为没跑」的极端形态 —— 六条断言全是绿的，一次都没执行过。

所以这一轮的分工是：能在本地打到的（越界 404、canonical 三种路径、sitemap 单篇日期）写行为断言；只有部署后才成立的（线上的 5 条 `[P-042]`）既写线上断言，也在离线加一条「这条规则没被删」的影子断言。

三条注入验证，都实测过：

| 改动 | 期望 | 实际 |
|---|---|---|
| 外层 catch 改回 `json({ error: e.message }, 500)` | RB-07 两条红 | 双红（`只有 1 处调用` / `1 个 catch 又自己拼了 e.message`） |
| 越界判定删掉 | QP-06 红 | 红 |
| `paged` 判定去掉 `pageNo > 1` | QP-07 红 | 红 |

`[P-043]` 那条有个实现上的取舍：为什么抽 3 篇而不是全量？全量要抓 18 个页面，`check:live` 一轮从 40 秒涨到 90 秒，而倒挂只发生在「刚上线不久的排期稿」身上 —— sitemap 按发布时间倒序排，前 3 条正好覆盖这个窗口。不是完美覆盖，是成本与覆盖面的取舍，写在这儿免得下次有人以为它检查了全部。

## 七、明说的没做

- **`/archive` 没加分页**。它一次列全部，`page` 不参与查询。真要有几百篇再考虑，现在的做法是让 `page` 不进 canonical，不假装它分页。
- **标签页的 60 秒 404 缓存没动**。`/tag/<不存在>` 写 60 秒的 404 缓存，零回显（P-032 记过），能被灌 60 秒窗口，但拦不住的真实攻击者也不在乎 60 秒。
- **没改 `sitemap` 的优先级（`<priority>`）**。改 lastmod 就够了，priority 早就被 Google 公开说明「不用」。
- **没做 404 文案分类**。现在越界页码、不存在的 slug、不存在的标签共用一张 404 页，只有 H1 下面那句副标题不同。够用。
- **没验证爬虫侧的实际反应**。软 404 从 200 改成 404 之后，收录数怎么变、抓取频次怎么变，这个站没有 Search Console 的对照数据，只能等四周后再看。这篇里关于「软 404 更浪费抓取预算」的说法是推断，不是实测。
- **没重测首屏**。这轮改的是分页边界、SQL 聚合、异常出口，一处都不在前端渲染路径上。
- **写作时还没部署，发布前已部署**。改之前线上 111 通过 / 5 失败，5 条全是 `[P-042]` —— 那正是「修好了但没上线」的样子，不是回归；部署后 116 通过 / 0 失败。第一轮体检还剩一条「栏目页越界 200」，是部署前那张越界页被边缘缓存了 300 秒，绕缓存重打就是 404 —— 这一条本身就是 P-042 的注脚：**200 的空页连缓存都愿意收**。

## 复现条件

- 环境：Node 22.22.2，`node:sqlite`（内存库，不需要 D1），本地 `wrangler dev --port 8791 --local`
- 数据：本地 D1 18 篇 / 17 篇公开 / 每页 10 篇 → `pages = 2`
- 触发一：`curl -o /dev/null -w ''%{http_code}'' ''http://127.0.0.1:8791/?page=999''`
- 期望：404；实际：404（`2682` 字节的 404 页，`class="empty"` 出现 0 次）
- 触发二：插一篇 `published_at` 晚于 `updated_at` 的稿，抓 `/sitemap.xml`
- 期望：`<lastmod>` 等于发布日；实际：`2026-11-22`，页面 `datePublished` 是 `2026-11-22T12:00:00.000Z`
- 触发三：`handleFetch` 第一行临时 `throw`，`curl` 不带 Accept
- 期望：`{"ok":false,"error":"服务器错误"}`；实际：一致（注入行已删除）

## 断言代码

```bash
node scripts/test-query-params.mjs        # QP-06 越界 404 / QP-07 canonical 只认三种路径
node scripts/test-route-boundaries.mjs    # RB-07 500 页静态、两个 catch 共用出口、无第二份实现
node scripts/check-sitemap.mjs            # [P-043] lastmod >= datePublished（抽 3 篇）
npm run check:live                        # 第 13 节 [P-042] 5 条，需部署后才绿
```

一处提醒：`check:live` 在部署后 5 分钟内跑，会有一组 ETag/304 假红 —— 边缘缓存 `s-maxage=300`，GET 还命中旧副本而 HEAD 已经落到新代码。等 5 分钟重跑，116/116。
', html_content = '<h1 id="两个都不报错的错-越界页码-200-max-写成了标量"><a class="h-anchor" href="#两个都不报错的错-越界页码-200-max-写成了标量">#</a>两个都不报错的错：越界页码 200，MAX 写成了标量</h1>
<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>一份十条的清单里，七条我实测不成立，三条真会咬人。三条当中又有两条是同一类：</p>
<ol><li><strong><code>/?page=999</code> 返回 200 的空列表</strong>，而且 canonical 写着 <code>?page=999</code> 自己。分页链接有边界（末页不渲染「下一页」），URL 没有 —— 爬虫不用点链接，拼数字就能造出无限多张「空但合格」的页，每张都自称规范地址。</li><li><strong><code>MAX(a, b)</code> 在 <code>GROUP BY</code> 里不是聚合</strong>，是标量函数。SQLite 对组内非聚合表达式的处理是「取任意一行」，于是「组内最新的更新时间」变成了「组里某一行的时间」。写成 <code>MAX(MAX(a, b))</code> 才对，多一层嵌套，差的是几个月。</li><li>顺着第 2 条查 <code>sitemap.xml</code>，发现 <strong><code>lastmod</code> 早于 <code>datePublished</code></strong>：线上 18 篇文章里 1 篇倒挂（11-13 对 11-21）。排期稿越多，倒挂越多。</li></ol>
<p>修完这三条，我又在同一个坑边上发现第四条：<strong>500 的出口有两个，我上一轮只修了一个</strong>。内层 catch 已经按路径分流，最外层那个还是裸的 <code>error: e.message</code>。把异常扔在 <code>handleFetch</code> 开头试，<code>curl</code> 拿到的就是 <code>{&quot;error&quot;:&quot;D1_ERROR: no such table: posts&quot;}</code> —— 和修之前一模一样。</p>
<p>四条的共同点：<strong>没有一条会报错，没有一条会被工具发现</strong>。页面是 200，sitemap 是合法 XML，JSON 也是合法 JSON。</p>
<p>这轮的顺序因此反过来了：不是读代码找问题，是先把清单里的地址和字段逐条打一遍，能复现的才排优先级。七条当场消失，剩下三条各配一条断言，改完再让断言在旧代码上红一次 —— 红不了的那条，说明它测的不是这次改的东西。</p>
<h2 id="一-先看清单里成立的那三条"><a class="h-anchor" href="#一-先看清单里成立的那三条">#</a>一、先看清单里成立的那三条</h2>
<p>材料给的形式是「问题 + 建议 + 优先级」。先按「会不会真出事」过一遍，成立的留下来：</p>
<div class="table-wrap"><table><thead><tr><th>材料说</th><th>实测</th><th>判断</th></tr></thead><tbody><tr><td>越界页码返回空页，应该 404</td><td><code>/?page=999</code> 200、<code>/cat/log?page=999</code> 200、<code>/tag/x?page=999</code> 200，三处都自指 canonical</td><td><strong>成立</strong>，见第二节</td></tr><tr><td><code>sitemap</code> 的 lastmod 有错</td><td>18 篇里 1 篇 <code>lastmod</code> 早于 <code>datePublished</code></td><td><strong>成立</strong>，见第四节</td></tr><tr><td>500 页会把异常原文回给调用方</td><td>带 <code>Accept: text/html</code> 的是自定义页（这条材料判错），不带 Accept 的拿到 <code>D1_ERROR: no such table</code></td><td><strong>一半成立</strong>，见第五节</td></tr></tbody></table></div>
<p>不成立的七条里，最典型的是三条：</p>
<div class="table-wrap"><table><thead><tr><th>材料说</th><th>实测</th></tr></thead><tbody><tr><td>搜索框没有接服务端，只是前端过滤</td><td><code>/api/posts?q=</code> 走 SQL LIKE，前端 320ms 防抖 + AbortController + <code>mark</code> 高亮 + 空态，都在</td></tr><tr><td>没有 <code>/series</code> 页面</td><td><code>/series</code> 与 <code>/series/&lt;名称&gt;</code> 都 200，都在 sitemap 里</td></tr><tr><td>列表图没做懒加载</td><td><code>loading=&quot;lazy&quot;</code> + 宽高属性本来就有，缺的是「图片尺寸写死 vs 自适应」的取舍，不是懒加载</td></tr></tbody></table></div>
<p>这三条我一条都没动。改一个已经正确的实现，比不改更危险 —— 下一轮审计会看到「这里被人动过」，然后重新怀疑一遍。</p>
<h2 id="二-越界页码-页面有边界-url-没有"><a class="h-anchor" href="#二-越界页码-页面有边界-url-没有">#</a>二、越界页码：页面有边界，URL 没有</h2>
<p>修复前，线上是这样一个状态（2026-11-24 抓的，<code>cache-control: no-cache</code> 绕缓存）：</p>
<div class="table-wrap"><table><thead><tr><th>请求</th><th>状态</th><th>返回条数</th><th>canonical</th></tr></thead><tbody><tr><td><code>/</code></td><td>200</td><td>10</td><td><code>/</code></td></tr><tr><td><code>/?page=1</code></td><td>200</td><td>10</td><td><code>/?page=1</code></td></tr><tr><td><code>/?page=2</code></td><td>200</td><td>8</td><td><code>/?page=2</code></td></tr><tr><td><code>/?page=3</code></td><td>200</td><td>0</td><td><code>/?page=3</code></td></tr><tr><td><code>/?page=999</code></td><td>200</td><td>0</td><td><code>/?page=999</code></td></tr><tr><td><code>/cat/log?page=999</code></td><td>200</td><td>0</td><td><code>/cat/log?page=999</code></td></tr><tr><td><code>/tag/cloudflare?page=999</code></td><td>200</td><td>0</td><td><code>/tag/cloudflare?page=999</code></td></tr><tr><td><code>/archive?page=9</code></td><td>200</td><td>—</td><td><code>/archive?page=9</code></td></tr></tbody></table></div>
<p>（返回条数取自 <code>/api/posts</code>，和页面用的是同一个 <code>pageParams</code>；归档页不分页，所以是「—」。）</p>
<p>站点当时 18 篇公开、每页 10 篇，<code>pages = 2</code>。所以第 3 页开始全是越界，全部 200。</p>
<p>成因一句话：<code>OFFSET</code> 越过末尾时 SQLite 返回空数组，不是错误。模板拿到空数组就渲染成「还没有文章」，状态码按默认 200 出去。没人问过「越界时该回什么」。</p>
<p>严格说，这是两个层面的默认值叠在一起的结果。数据层：空结果集是<strong>正常</strong>返回值，不是异常。模板层：列表为空只有一种表达方式，就是空态文案。HTTP 层：没人显式设状态码，于是 200。三层各自都对，合起来就错了 —— 因为 HTTP 层缺一个判断：<strong>「这一页没有内容」和「这一页不存在」是两件事</strong>。</p>
<p>首页没有文章是前者（站刚建，200 的空态正确）；第 999 页没有文章是后者（这一页不在分页序列里，应该是 404）。两者在数据层长得一模一样，都是空数组，所以这个判断只能由知道 <code>total</code> 和 <code>pages</code> 的那一层来做。</p>
<p>危险的地方不在「空页难看」，在于<strong>三件事叠加</strong>：</p>
<ol><li><strong>状态码是 200</strong>，不是 404 也不是 410。爬虫会收录。</li><li><strong>canonical 自指</strong>。<code>fillSeo</code> 把 <code>page</code> 参数无条件抄进规范地址，于是每一张空页都声明「我就是这一页的规范版本」，不会被去重。</li><li><strong>URL 是无边界的</strong>。分页链接只到末页，但参数可以拼任意整数：<code>?page=3</code> 到 <code>?page=999999</code> 全都能生成一张独立的、合格的、自指的页面。</li></ol>
<p>这不是理论风险。站内分页链只在末页停住，而爬虫发现新 URL 的方式不止「顺着链接爬」——日志、外链、站点地图、别人贴的地址，都能带进来一个 <code>?page=500</code>。</p>
<p>这类页面在 SEO 里有个专门名字：<strong>软 404</strong>。状态码说「正常」，内容说「什么都没有」。搜索引擎对软 404 的处理比 404 更麻烦 —— 404 是明确的「这里没有东西，别再来了」，软 404 是「这里有个页面，但它什么都不说」，后者只会被反复抓取、反复判断。我没有这个站的抓取日志，能说的到这儿为止：软 404 的数量级和收录影响<strong>没有实测</strong>，只有定性判断。</p>
<p>修法只有两行，但位置很关键。判定放在 <code>injectTheme</code> 里、拿到 <code>list</code> 之后：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 总数 &gt; 0 且页码超出末页时才 404；一篇都没有的站仍然给 200 的首页空态</span>
<span class="tok-k">if</span> (list &amp;&amp; list.total &gt; <span class="tok-n">0</span> &amp;&amp; list.page &gt; list.pages) {
  <span class="tok-k">return</span> <span class="tok-k">await</span> <span class="tok-f">notFoundPage</span>(env, <span class="tok-k">null</span>, <span class="tok-s">&#39;这一页没有文章&#39;</span>);
}</code></pre></div>
<p><code>total &gt; 0</code> 这个条件是必须的：一个刚建好、还没发文的站，首页本来就该是 200 的空态，不能因为 <code>pages = 0</code> 就把首页判成 404。</p>
<p>为什么不放在 <code>route()</code> 里拦？因为那里拿不到 <code>total</code> —— 要知道一条记录是「第 3 页」还是「越界」，必须先查一次总数。而 <code>route()</code> 只做分发、不碰 SQL（<code>RB-06</code> 那条断言守着这个边界）。把判断放在 <code>list</code> 已经算出来的地方，是最小代价：不新增查询、不新增解析点，<code>list.page</code> 和 <code>list.pages</code> 本来就是列表查询的返回值。</p>
<p>修完在本地重跑同一组地址（本地库 18 篇，17 篇公开，每页 10 篇 → <code>pages = 2</code>）：</p>
<div class="table-wrap"><table><thead><tr><th>请求</th><th>修复前</th><th>修复后</th><th>canonical</th></tr></thead><tbody><tr><td><code>/?page=1</code></td><td>200</td><td>200</td><td><code>/</code></td></tr><tr><td><code>/?page=2</code></td><td>200</td><td>200</td><td><code>/?page=2</code></td></tr><tr><td><code>/?page=3</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/?page=999</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/cat/log?page=999</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/tag/cloudflare?page=999</code></td><td>200 空列表</td><td><strong>404</strong></td><td>无</td></tr><tr><td><code>/archive?page=9</code></td><td>200，canonical 带页码</td><td>200</td><td><code>/archive</code></td></tr></tbody></table></div>
<p>404 页 2682 字节，正文里 <code>class=&quot;empty&quot;</code> 出现 0 次 —— 这一条很重要：只把状态码改成 404、页面里还留着「这个栏目下还没有文章」，那等于换了个牌子继续骗人。断言里专门有一条查它。</p>
<p><strong>第二种无效输入：page 参数本身。</strong></p>
<p><code>?page=1</code> 与不带参数是<strong>逐字相同</strong>的内容，但它们曾经是两个地址，各自 canonical 自指。这是最典型的重复内容：同一页的两份地址，谁都不让谁。</p>
<p>归档页是另一种：<code>/archive</code> 一次列全部，<code>page</code> 根本不参与查询。所以 <code>/archive?page=9</code> 与 <code>/archive</code> 输出同一份 HTML，九个不同的地址全都自称规范。</p>
<p>只让「真分页」的三种路径在 <code>page &gt; 1</code> 时保留页码：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> paged = !!url &amp;&amp; (url.pathname === <span class="tok-s">&#39;/&#39;</span> || url.pathname.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/tag/&#39;</span>) || url.pathname.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/cat/&#39;</span>));
<span class="tok-c">// 页码仍然只在这一处解析一次：走 pageParams，不自己 parseInt</span>
<span class="tok-k">const</span> pageNo = url ? <span class="tok-f">pageParams</span>(url).page : <span class="tok-n">1</span>;
<span class="tok-k">if</span> (canonicalUrl &amp;&amp; paged &amp;&amp; pageNo &gt; <span class="tok-n">1</span>) {
  canonicalUrl.searchParams.<span class="tok-k">set</span>(<span class="tok-s">&#39;page&#39;</span>, <span class="tok-f">String</span>(pageNo));
}</code></pre></div>
<p>两个细节，都是踩过的：</p>
<ul><li><strong><code>pageNo</code> 走 <code>pageParams(url).page</code></strong>，不是 <code>url.searchParams.get(&#39;page&#39;)</code>。后者拿到的是原始字符串，<code>?page=abc</code>、<code>?page=1e21</code>、<code>?page=-5</code> 各有各的写法；前者已经做了 <code>MAX_PAGE = 10000</code> 上界和 <code>Number.isFinite</code> 判定。同一个参数在全站只能解析一次，这是 <code>QP-05</code> 那条元断言守的。</li><li><strong>判定用 <code>pathname</code> 前缀，不用 <code>paged</code> 白名单外的东西</strong>。首页写 <code>=== &#39;/&#39;</code> 不写 <code>startsWith(&#39;/&#39;)</code> —— 后者会把所有路径都放进来。</li></ul>
<p>顺便把 <code>size</code> 也验了一遍，因为它看起来像同类参数。结论是页面这一侧根本不认它：<code>/?size=1&amp;page=5</code> 返回 404，说明 <code>listParams</code> 只取 <code>page</code>，列表固定每页 10 条，<code>size</code> 对页面内容零影响。<code>/?size=50&amp;page=1</code> 的 canonical 是 <code>/</code>，内容与 <code>/</code> 逐字相同 —— 丢掉它是对的，和丢掉 <code>utm_*</code>、<code>?cb=</code> 一样。</p>
<p>同一个 <code>size</code> 在 <code>/api/posts</code> 上却是有效参数（<code>pageParams</code> 里夹了 1~50）。<strong>同一参数在两个出口含义不同</strong>这件事本身不难，难的是别让它渗进 canonical：页面侧只要问一句「这个参数会改变我渲染的内容吗」，答案是不会，就不写进规范地址。<code>check:live</code> 那 5 条断言用的是 canonical 的<strong>精确相等</strong>（不是「包含」），所以多写一个参数就会红。</p>
<h2 id="三-max-a-b-在-group-by-里不是聚合"><a class="h-anchor" href="#三-max-a-b-在-group-by-里不是聚合">#</a>三、<code>MAX(a,b)</code> 在 <code>GROUP BY</code> 里不是聚合</h2>
<p>这条比页码隐蔽得多，因为它<strong>看起来就是对的</strong>。</p>
<p><code>sitemap.xml</code> 里每个栏目页、标签页、系列页都要一个 <code>lastmod</code>：这一页的内容变了，是因为它下面某篇文章变了，所以取组内最大值。原来的写法：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql"><span class="tok-f">MAX</span>(<span class="tok-f">COALESCE</span>(p.updated_at, p.created_at))</code></pre></div>
<p>一个参数，是聚合函数，没问题。改成「取发布日与更新日之较大者」时，最自然的写法是：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql"><span class="tok-f">MAX</span>(p.published_at, p.updated_at)</code></pre></div>
<p>两个参数。<strong>这是标量函数</strong>，逐行求值，不是聚合。放进 <code>GROUP BY</code> 的查询里，SQLite 对「非聚合表达式」的处理是取组内任意一行 —— 文档里的说法是 bare columns，实际扫到哪行算哪行。</p>
<p>用 <code>node:sqlite</code> 在内存库里搭了六行数据（两篇 11 月已发、两篇排期到次年 1 月和 2 月、两篇 teardown），跑三种写法：</p>
<div class="table-wrap"><table><thead><tr><th>写法</th><th><code>log</code> 组</th><th><code>teardown</code> 组</th></tr></thead><tbody><tr><td><code>MAX(published_at, updated_at)</code>（单层，标量）</td><td>2026-11-21 01:00</td><td>2026-11-27 01:00</td></tr><tr><td><code>MAX(MAX(published_at, updated_at))</code>（外层聚合）</td><td><strong>2027-02-03 01:00</strong></td><td><strong>2026-11-29 01:00</strong></td></tr><tr><td>旧口径 <code>MAX(COALESCE(updated_at, created_at))</code></td><td>2026-11-22 18:31</td><td>2026-11-19 10:40</td></tr></tbody></table></div>
<p>第一行就是坑：<code>log</code> 组里最新的公开时间是次年 2 月 3 日，单层写法给出 11 月 21 日 —— 那是组里第一行，跟「最大」毫无关系。差 74 天。</p>
<p>第二行多包一层就对了：内层 <code>MAX(a, b)</code> 逐行取两列的大值，外层 <code>MAX(...)</code> 才是组内聚合。SQLite 允许这种嵌套，因为两层在语义上本来就是两件事：<strong>行内的 max 和组内的 max</strong>。</p>
<p>根源是 <code>MAX</code> 这一个名字背了两个身份：单参数时是聚合，多参数时是标量。Postgres 和 MySQL 把这两件事拆成 <code>MAX()</code> 与 <code>GREATEST()</code>，所以同一句写错在那边会直接报「参数个数不对」；SQLite 选择兼容而非报错，于是错的那个写法安静地跑出结果。<strong>能跑的错最贵</strong>，这一条在 SQL 里和在 CSS 里一样成立。</p>
<p>这个错误之所以难发现，是因为<strong>同一个表达式在别的位置是对的</strong>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">-- 单行查询：正确，这一行取两列的大值
SELECT slug, <span class="tok-f">MAX</span>(published_at, updated_at) AS last FROM posts WHERE slug = ?;</code></pre></div>
<p><code>WHERE slug = ?</code> 只出一行，<code>MAX(a, b)</code> 逐行求值正好就是要的语义。把它从「单行」上下文搬进「分组」上下文时，SQL 一个字都没改，含义从「取两列大值」变成「取两列大值，然后随便挑一行」。<strong>上下文换了，表达式没换</strong> —— 这类错误在 code review 里几乎不可见，因为看的人是按单行的语义在读。</p>
<p>第一版我就是这么写的。本地跑 SQL 对着数据看才发现：<code>log</code> 组最新是次年 2 月，输出却是 11 月。当时第一反应是「数据没进去」，查了三次库才回头怀疑表达式 —— 这是最典型的「现象像 A、根因在 B」。</p>
<p>第三行是旧口径，问题在下一节。</p>
<p>真正落地的 SQL 还得处理空字符串。本站的 <code>published_at</code> 有 <code>&#39;&#39;</code>（草稿），<code>COALESCE(NULLIF(x, &#39;&#39;), &#39;0&#39;)</code> 把它压成字符串 <code>&#39;0&#39;</code>，这样比较时不会因为 <code>NULL</code> 让整行被聚合函数忽略：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> stamp = (a) =&gt;
  <span class="tok-s">`MAX(MAX(COALESCE(NULLIF(${a}.published_at, &#39;&#39;), &#39;0&#39;), COALESCE(${a}.updated_at, ${a}.created_at, &#39;0&#39;)))`</span>;</code></pre></div>
<p>这里有个容易搞混的地方：<strong>单篇文章的 <code>lastmod</code> 不是 SQL 算的</strong>，是 JS 里比较两个字符串：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> lastOf = (p) =&gt; {
  <span class="tok-k">const</span> a = <span class="tok-f">String</span>(p.updated_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">const</span> b = <span class="tok-f">String</span>(p.published_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">return</span> (a &gt; b ? a : b).<span class="tok-f">slice</span>(<span class="tok-n">0</span>, <span class="tok-n">10</span>);
};</code></pre></div>
<p>字符串比较对 <code>YYYY-MM-DD HH:MM:SS</code> 这种定长格式是正确的，所以单篇那一处从来没出过问题。出问题的只有聚合那一处 —— 也就是说，<strong>同一个语义在两条路径上各写了一遍，一条对一条错</strong>。这种结构下次还会错，所以断言要盯的不是「这行对不对」，而是「这条语义有几处实现」。</p>
<h2 id="四-lastmod-早于-datepublished"><a class="h-anchor" href="#四-lastmod-早于-datepublished">#</a>四、<code>lastmod</code> 早于 <code>datePublished</code></h2>
<p>修好聚合，再看数据本身。</p>
<p>这条不是我肉眼发现的，是断言先报的。<code>check-sitemap.mjs</code> 里加了七行：抽 sitemap 里最新的三篇文章页，逐篇抓下来取 <code>datePublished</code>，和 <code>&lt;lastmod&gt;</code> 比大小，任何一篇倒挂就红。第一次跑就红了一篇 —— 在此之前，这个站已经带着这条矛盾跑了一个月，期间没人报错，页面看着完全正常。</p>
<p>线上 <code>sitemap.xml</code> 当时 50 条 <code>&lt;url&gt;</code>，其中 18 条是文章页。逐篇抓页面比 <code>datePublished</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">sitemap 50 条，文章 18 篇，倒挂 1 篇：
  ld-self-reference lastmod 2026-11-13 &lt; datePublished 2026-11-21</code></pre></div>
<p>只有一篇，但那不是偶然。11-21 那篇是 11-14 当天写完的存货，<code>updated_at</code> 停在 11-14，<code>published_at</code> 是 11-21。而本站从 11-21 起改成了「2 天一篇」，库存里还有十几篇是 11 月写完、12 月到次年 2 月才开闸的 —— 它们上线之后，每一篇都是倒挂，只是现在还没到日子。</p>
<p>本地模拟一篇排期稿验证（<code>published_at</code> 给过去时间让它上线，<code>updated_at</code> 给 11 月）：</p>
<div class="table-wrap"><table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody><tr><td><code>published_at</code></td><td>2026-11-22 12:00:00</td></tr><tr><td><code>updated_at</code></td><td>2026-11-10 09:00:00</td></tr><tr><td>旧口径 <code>MAX(updated_at, created_at)</code></td><td>2026-11-20 16:53（组内别的文章撑起来的）</td></tr><tr><td>单篇旧写法（<code>updated_at</code>）</td><td>2026-11-10</td></tr><tr><td>修后单篇 <code>lastmod</code></td><td>2026-11-22</td></tr><tr><td>页面 <code>datePublished</code></td><td><code>2026-11-22T12:00:00.000Z</code></td></tr></tbody></table></div>
<p>单篇倒挂 12 天，栏目聚合倒挂 2 天（被组里更新的一篇压住了，所以看起来「还好」——这种「看起来还好」比明显坏更麻烦，它会让你以为不用修）。</p>
<p>为什么这件事值得修，而不是「反正搜索引擎也不看」：<code>lastmod</code> 是站点自己声明的「内容最后一次变」的时间，<code>datePublished</code> 是「第一次可见」的时间。后者不可能早于前者。当这两个信号互相矛盾时，搜索引擎的合理反应是<strong>降低这两个信号的权重</strong>，而这个站几乎所有 SEO 判断都建立在时间信号上：sitemap 优先级、归档排序、RSS 顺序、<code>dateModified</code>。</p>
<p>修法就是把「发布也是一次内容变化」落进 SQL：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 组内聚合（栏目页 / 标签页 / 系列页）：SQL 里算</span>
<span class="tok-k">const</span> lastUpd = (a = <span class="tok-s">&#39;p&#39;</span>) =&gt; <span class="tok-f">stamp</span>(a);   <span class="tok-c">// stamp 就是上面那个 外层MAX(内层MAX(...))</span>

<span class="tok-c">// 单篇：JS 里比两个字符串，不走 SQL</span>
<span class="tok-k">const</span> lastOf = (p) =&gt; {
  <span class="tok-k">const</span> a = <span class="tok-f">String</span>(p.updated_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">const</span> b = <span class="tok-f">String</span>(p.published_at || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">return</span> (a &gt; b ? a : b).<span class="tok-f">slice</span>(<span class="tok-n">0</span>, <span class="tok-n">10</span>);
};</code></pre></div>
<p><code>stamp()</code> 同时用在单篇和组内聚合上 —— 一处定义，六处引用（首页、归档、栏目总览、每个栏目页、每个标签页、每个系列页）。改口径只改一行。</p>
<p>里面那个 <code>COALESCE(NULLIF(p.updated_at, &#39;&#39;), p.created_at, &#39;0&#39;)</code> 值得单说：本站的 <code>published_at</code> 有 <code>&#39;&#39;</code>（草稿从没发布过）。<code>NULLIF(x, &#39;&#39;)</code> 把空串变成 <code>NULL</code>，<code>COALESCE</code> 再往后取 <code>created_at</code>，最后兜一个 <code>&#39;0&#39;</code>。三层兜底看着啰嗦，缺一层的后果分别是：空串参与字符串比较时排在任何日期之前（<code>&#39;&#39; &lt; &#39;2026&#39;</code>），于是草稿会被当成「最老的一篇」；<code>NULL</code> 会让 <code>MAX()</code> 直接忽略这一行，组内一篇都没发布时聚合结果是 <code>NULL</code>，<code>&lt;lastmod&gt;</code> 就变成空标签。</p>
<p>顺带一个同源问题：时间信号在站里有三处出口 —— sitemap 的 <code>&lt;lastmod&gt;</code>、页面 JSON-LD 的 <code>dateModified</code>、RSS 的 <code>&lt;pubDate&gt;</code>。三处各自从 <code>post</code> 对象取时间，谁都不引用谁。这轮只统一了 sitemap 这一处，另外两处用的是发布日（<code>pubDate</code> 本来就该是发布日）或 <code>updated_at</code>（<code>dateModified</code> 本来就该是最后编辑），语义上没错，但它们之间<strong>没有断言把它们钉在一起</strong> —— 与 P-043 同一个教训：同源字段，要么同源，要么有断言。</p>
<h2 id="五-修完之后-同一个坑边上还有一处"><a class="h-anchor" href="#五-修完之后-同一个坑边上还有一处">#</a>五、修完之后，同一个坑边上还有一处</h2>
<p>P-044 上一轮已经修过一次：500 时按 <code>Accept</code> 分流，浏览器拿自绘页，<code>curl</code> 拿 JSON。</p>
<p>修完我以为这条结了。这一轮为了验证，往 <code>handleFetch</code> 第一行插了一行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (<span class="tok-k">new</span> <span class="tok-f">URL</span>(request.url).pathname === <span class="tok-s">&#39;/__boom&#39;</span>) <span class="tok-k">throw</span> <span class="tok-k">new</span> <span class="tok-f">Error</span>(<span class="tok-s">&#39;D1_ERROR: no such table: posts&#39;</span>);</code></pre></div>
<p><code>curl</code> 不带 Accept —— 拿到的是原文：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">http</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-http">HTTP/<span class="tok-n">1.1</span> <span class="tok-n">500</span> Internal Server Error
content-type: application/json; charset=utf-<span class="tok-n">8</span>

{<span class="tok-s">&quot;ok&quot;</span>:<span class="tok-k">false</span>,<span class="tok-s">&quot;error&quot;</span>:<span class="tok-s">&quot;D1_ERROR: no such table: posts&quot;</span>}</code></pre></div>
<p>53 字节，表名、SQL 方言、出错位置，一个不少。</p>
<p>原因很直接：<code>handleFetch</code> 里的 <code>try</code> 只包住了 <code>route()</code> 分发那一段。异常如果抛在它前面（HEAD 预处理、URL 解析）或者后面（ETag、日志上报），到不了内层那个已经改好的 catch，一路掉到最外层：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">async</span> <span class="tok-f">fetch</span>(request, env, ctx) {
  <span class="tok-k">const</span> startedAt = Date.<span class="tok-f">now</span>();
  <span class="tok-k">let</span> res;
  <span class="tok-k">try</span> {
    res = <span class="tok-k">await</span> <span class="tok-k">this</span>.<span class="tok-f">handleFetch</span>(request, env, ctx);
  } <span class="tok-k">catch</span> (e) {
    res = <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: e.message }, <span class="tok-n">500</span>);   <span class="tok-c">// ← 这里还是裸的</span>
  }
  ...
}</code></pre></div>
<p><strong>同一条规则写在两处，上一轮只改了一处。</strong> 这是 P-030 记过的老毛病（<code>ownerOrAdmin</code> 那两处内联判定），第二次发作，同一个形态：不是不知道规则，是规则有第二份实现。</p>
<p>两层的分工：内层 catch 拦业务层（<code>route()</code> 里的 D1 报错、模板取值失败），外层 catch 拦框架层（HEAD 预处理、URL 解析、日志上报）。抽成同一个函数之后，内层其实可以删掉，让异常一路冒到外层，回包一模一样。但这次不删 —— 删它是纯重构，对行为零收益，而这一轮已经有四处改动了。最小改动的边界在这里：<strong>该合并的是判断，不是控制流</strong>。</p>
<p>这次不补分支，抽成一个函数，两个 catch 都调它：</p>
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
20</span><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">fatalResponse</span>(request, e) {
  console.<span class="tok-f">error</span>(e);
  <span class="tok-k">let</span> here = <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">try</span> {
    here = <span class="tok-k">new</span> <span class="tok-f">URL</span>(request.url).pathname;
  } <span class="tok-k">catch</span> {}
  <span class="tok-k">const</span> wantsHtml =
    !here.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/api/&#39;</span>) &amp;&amp;
    (request.method === <span class="tok-s">&#39;GET&#39;</span> || request.method === <span class="tok-s">&#39;HEAD&#39;</span>) &amp;&amp;
    /text\/html/.<span class="tok-f">test</span>(request.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;accept&#39;</span>) || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">if</span> (wantsHtml) {
    <span class="tok-k">return</span> <span class="tok-k">new</span> <span class="tok-f">Response</span>(<span class="tok-f">serverErrorPage</span>(), {
      status: <span class="tok-n">500</span>,
      headers: { <span class="tok-s">&#39;content-type&#39;</span>: <span class="tok-s">&#39;text/html; charset=utf-8&#39;</span>, <span class="tok-s">&#39;cache-control&#39;</span>: <span class="tok-s">&#39;no-store&#39;</span>, <span class="tok-s">&#39;retry-after&#39;</span>: <span class="tok-s">&#39;60&#39;</span> },
    });
  }
  <span class="tok-k">return</span> here.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/api/&#39;</span>)
    ? <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: e.message }, <span class="tok-n">500</span>)
    : <span class="tok-f">json</span>({ ok: <span class="tok-k">false</span>, error: <span class="tok-s">&#39;服务器错误&#39;</span> }, <span class="tok-n">500</span>);
}</code></pre></div>
<p>里面那个 <code>try { new URL() } catch {}</code> 不是凑数：外层 catch 存在的意义就是兜「连 request 都解析不了」的意外，如果兜底的函数自己再抛一次 <code>TypeError: Invalid URL</code>，就等于没有兜底。拿不到路径时按非 API 处理 —— 这是唯一安全的默认。</p>
<p>改完同一组注入，三种观众：</p>
<div class="table-wrap"><table><thead><tr><th>请求</th><th>修复前</th><th>修复后</th></tr></thead><tbody><tr><td><code>curl /__boom</code>（无 Accept）</td><td>500 <code>{&quot;error&quot;:&quot;D1_ERROR: no such table: posts&quot;}</code>，53 B</td><td>500 <code>{&quot;error&quot;:&quot;服务器错误&quot;}</code></td></tr><tr><td><code>curl -H &#39;Accept: text/html&#39; /__boom</code></td><td>500 自定义页（内层 catch 挡住了，本来就没漏）</td><td>500 自定义页，1109 B，<code>D1_ERROR</code> 出现 0 次</td></tr><tr><td><code>curl /api/_boom</code></td><td>500 原文</td><td>500 原文（API 本来就要）</td></tr></tbody></table></div>
<h2 id="六-断言-先让它红"><a class="h-anchor" href="#六-断言-先让它红">#</a>六、断言：先让它红</h2>
<p>四条修复，五组断言。原则没变：<strong>没在旧代码上见过它红的断言，不算断言</strong>。</p>
<div class="table-wrap"><table><thead><tr><th>编号</th><th>断言</th><th>位置</th><th>修前</th></tr></thead><tbody><tr><td><code>[P-042]</code></td><td><code>/?page=1</code> 归一到 <code>/</code></td><td><code>check-live</code> 第 13 节</td><td>红（canonical 是 <code>?page=1</code>）</td></tr><tr><td><code>[P-042]</code></td><td><code>/?page=2</code> 保留页码</td><td>同上</td><td>绿</td></tr><tr><td><code>[P-042]</code></td><td>首页越界 404</td><td>同上</td><td>红（200）</td></tr><tr><td><code>[P-042]</code></td><td>404 页里没有列表空态</td><td>同上</td><td>红</td></tr><tr><td><code>[P-042]</code></td><td>归档页的 page 不进 canonical</td><td>同上</td><td>红（canonical 带 <code>?page=9</code>）</td></tr><tr><td><code>[P-042]</code></td><td>栏目页越界 404</td><td>同上</td><td>红</td></tr><tr><td><code>QP-06</code></td><td>越界判定与 <code>notFoundPage</code> 都在</td><td>离线</td><td>红（判据不存在）</td></tr><tr><td><code>QP-07</code></td><td><code>paged</code> 只认三种路径、<code>pageNo &gt; 1</code></td><td>离线</td><td>红</td></tr><tr><td><code>[P-043]</code></td><td>抽 3 篇比 <code>lastmod &gt;= datePublished</code></td><td><code>check-sitemap</code></td><td>红（1 篇倒挂）</td></tr><tr><td><code>RB-07</code></td><td>非 API 的 500 不回原文</td><td>离线</td><td>绿（上一轮修的）</td></tr><tr><td><code>RB-07</code></td><td>两个 catch 共用同一出口（≥ 2 处调用）</td><td>离线</td><td><strong>红</strong>（只有 1 处）</td></tr><tr><td><code>RB-07</code></td><td>catch 块里没有第二份 500 分支实现</td><td>离线</td><td><strong>红</strong></td></tr></tbody></table></div>
<p><code>QP-06</code> / <code>QP-07</code> / <code>RB-07</code> 是离线那一半：线上那一半要部署才验得了，而部署前必须有一个「规则还在代码里」的守卫，否则改回去的时候没人知道。</p>
<p>这两层不能互相替代。线上断言证明的是<strong>行为</strong>（<code>?page=999</code> 真的 404），但它要部署才能跑，写代码的当下一个字都验不了；离线断言证明的是<strong>形状</strong>（判定还在、分支还在），当场能跑，但它证明不了这条分支真的被走到。上一轮假绿那件事（同步 <code>t()</code> 吞掉 async 用例）就是「形状对了、行为没跑」的极端形态 —— 六条断言全是绿的，一次都没执行过。</p>
<p>所以这一轮的分工是：能在本地打到的（越界 404、canonical 三种路径、sitemap 单篇日期）写行为断言；只有部署后才成立的（线上的 5 条 <code>[P-042]</code>）既写线上断言，也在离线加一条「这条规则没被删」的影子断言。</p>
<p>三条注入验证，都实测过：</p>
<div class="table-wrap"><table><thead><tr><th>改动</th><th>期望</th><th>实际</th></tr></thead><tbody><tr><td>外层 catch 改回 <code>json({ error: e.message }, 500)</code></td><td>RB-07 两条红</td><td>双红（<code>只有 1 处调用</code> / <code>1 个 catch 又自己拼了 e.message</code>）</td></tr><tr><td>越界判定删掉</td><td>QP-06 红</td><td>红</td></tr><tr><td><code>paged</code> 判定去掉 <code>pageNo &gt; 1</code></td><td>QP-07 红</td><td>红</td></tr></tbody></table></div>
<p><code>[P-043]</code> 那条有个实现上的取舍：为什么抽 3 篇而不是全量？全量要抓 18 个页面，<code>check:live</code> 一轮从 40 秒涨到 90 秒，而倒挂只发生在「刚上线不久的排期稿」身上 —— sitemap 按发布时间倒序排，前 3 条正好覆盖这个窗口。不是完美覆盖，是成本与覆盖面的取舍，写在这儿免得下次有人以为它检查了全部。</p>
<h2 id="七-明说的没做"><a class="h-anchor" href="#七-明说的没做">#</a>七、明说的没做</h2>
<ul><li><strong><code>/archive</code> 没加分页</strong>。它一次列全部，<code>page</code> 不参与查询。真要有几百篇再考虑，现在的做法是让 <code>page</code> 不进 canonical，不假装它分页。</li><li><strong>标签页的 60 秒 404 缓存没动</strong>。<code>/tag/&lt;不存在&gt;</code> 写 60 秒的 404 缓存，零回显（P-032 记过），能被灌 60 秒窗口，但拦不住的真实攻击者也不在乎 60 秒。</li><li><strong>没改 <code>sitemap</code> 的优先级（<code>&lt;priority&gt;</code>）</strong>。改 lastmod 就够了，priority 早就被 Google 公开说明「不用」。</li><li><strong>没做 404 文案分类</strong>。现在越界页码、不存在的 slug、不存在的标签共用一张 404 页，只有 H1 下面那句副标题不同。够用。</li><li><strong>没验证爬虫侧的实际反应</strong>。软 404 从 200 改成 404 之后，收录数怎么变、抓取频次怎么变，这个站没有 Search Console 的对照数据，只能等四周后再看。这篇里关于「软 404 更浪费抓取预算」的说法是推断，不是实测。</li><li><strong>没重测首屏</strong>。这轮改的是分页边界、SQL 聚合、异常出口，一处都不在前端渲染路径上。</li><li><strong>写作时还没部署，发布前已部署</strong>。改之前线上 111 通过 / 5 失败，5 条全是 <code>[P-042]</code> —— 那正是「修好了但没上线」的样子，不是回归；部署后 116 通过 / 0 失败。第一轮体检还剩一条「栏目页越界 200」，是部署前那张越界页被边缘缓存了 300 秒，绕缓存重打就是 404 —— 这一条本身就是 P-042 的注脚：<strong>200 的空页连缓存都愿意收</strong>。</li></ul>
<h2 id="复现条件"><a class="h-anchor" href="#复现条件">#</a>复现条件</h2>
<ul><li>环境：Node 22.22.2，<code>node:sqlite</code>（内存库，不需要 D1），本地 <code>wrangler dev --port 8791 --local</code></li><li>数据：本地 D1 18 篇 / 17 篇公开 / 每页 10 篇 → <code>pages = 2</code></li><li>触发一：<code>curl -o /dev/null -w &#39;%{http_code}&#39; &#39;http://127.0.0.1:8791/?page=999&#39;</code></li><li>期望：404；实际：404（<code>2682</code> 字节的 404 页，<code>class=&quot;empty&quot;</code> 出现 0 次）</li><li>触发二：插一篇 <code>published_at</code> 晚于 <code>updated_at</code> 的稿，抓 <code>/sitemap.xml</code></li><li>期望：<code>&lt;lastmod&gt;</code> 等于发布日；实际：<code>2026-11-22</code>，页面 <code>datePublished</code> 是 <code>2026-11-22T12:00:00.000Z</code></li><li>触发三：<code>handleFetch</code> 第一行临时 <code>throw</code>，<code>curl</code> 不带 Accept</li><li>期望：<code>{&quot;ok&quot;:false,&quot;error&quot;:&quot;服务器错误&quot;}</code>；实际：一致（注入行已删除）</li></ul>
<h2 id="断言代码"><a class="h-anchor" href="#断言代码">#</a>断言代码</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> scripts/test-query-params.mjs        <span class="tok-c"># QP-06 越界 404 / QP-07 canonical 只认三种路径</span>
<span class="tok-k">node</span> scripts/test-route-boundaries.mjs    <span class="tok-c"># RB-07 500 页静态、两个 catch 共用出口、无第二份实现</span>
<span class="tok-k">node</span> scripts/check-sitemap.mjs            <span class="tok-c"># [P-043] lastmod &gt;= datePublished（抽 3 篇）</span>
<span class="tok-k">npm</span> run check:live                        <span class="tok-c"># 第 13 节 [P-042] 5 条，需部署后才绿</span></code></pre></div>
<p>一处提醒：<code>check:live</code> 在部署后 5 分钟内跑，会有一组 ETag/304 假红 —— 边缘缓存 <code>s-maxage=300</code>，GET 还命中旧副本而 HEAD 已经落到新代码。等 5 分钟重跑，116/116。</p>', cover_body = '',
                 summary = '越界页码返回 200 的空页，每张都自称规范地址；MAX(a,b) 在 GROUP BY 里是标量函数，组内最新时间退化成组里某一行的时间，差 74 天。两条都不会报错——页面 200、sitemap 是合法 XML。修完还发现 500 的出口有两处，上一轮只改了一处，curl 拿到的仍是 D1_ERROR 原文。四条修复、五组断言，都在旧代码上验过会红。', updated_at = datetime('now')
  WHERE slug = 'scalar-max-and-out-of-range-page';

INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'scalar-max-and-out-of-range-page' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('sqlite') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'scalar-max-and-out-of-range-page' AND t.name = 'sqlite';
INSERT INTO tags (name) VALUES ('seo') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'scalar-max-and-out-of-range-page' AND t.name = 'seo';
-- 回补内链：22-ld-self-reference.md
UPDATE posts SET content = '## 结论

`isPartOf` 里的 `url` 填的是文章自己的地址。

```json
"isPartOf": {
  "@type": "CreativeWorkSeries",
  "name": "OAuth 授权流程拆解",
  "url": "https://exia.de5.net/p/oauth-pkce"
}
```

这句话的语义是：`/p/oauth-pkce` 这一篇，属于一个叫「OAuth 授权流程拆解」的系列，而这个系列的地址就是 `/p/oauth-pkce` 自己。四篇系列文，四段一模一样的自指声明，从系列机制上线那天写进去，一直到 11-14 才被发现。

它没被发现的理由很具体：**自指 url 是一个能打开、返回 200 的合法地址**。所有靠「链接是否可达」判断的检查都会放行，人工点开也看不出异常，JSON-LD 本身又不渲染给人看。语法对的、引用活的、语义错的——这一类错误只有专门写断言才抓得到。

真正的原因还不在 `seo.js`。站上 14 篇文章里有 6 篇的 `series` 字段是空的，系列组件拿不到数据，压根没渲染过。`isPartOf` 只在有系列的那 8 篇上输出，全站 8 段自指。补数据、建系列页、改地址，是三件事，不是一件。

修完上线，我自己又引入了一个更严重的坑：系列里只有 1 篇公开文章时，系列块和兜底导航同时不渲染，那篇文章彻底没有出口，比修之前还糟。

## 一、那行代码长什么样

`src/seo.js` 的 `postLd()` 负责文章页的 JSON-LD。改动前是这样：

```js
// src/seo.js，0f11e80 之前
isPartOf: post.series
  ? { ''@type'': ''CreativeWorkSeries'', name: post.series, url: `${origin}/p/${encodeURIComponent(post.slug)}` }
  : `${origin}/#website`,
```

写成这样几乎是必然的。写这段代码的时候，手边只有三个东西：`origin`、`post.slug`、`post.series`。`post.series` 是个字符串，不是地址；而 `url` 这个字段名要求一个地址。于是最近的、唯一现成拼得出来的地址，就是当前文章的地址。

同一个文件里，`listLd()` 也拼过同样的地址——那里是对的，列表页列出来的每个条目，地址就是它自己。区别在于位置：`isPartOf` 要的不是「这篇在哪」，是「这个系列在哪」。字段名里那个 `Part` 把方向说清楚了，写的时候没往这上面想。

这种情况有个特征：**复制粘贴不会报错，只会把语义悄悄改掉**。改完的版本：

```js
// src/seo.js，0f11e80
// 系列内序号。schema.org 的 position 定义就是「在系列/序列中的位置」，
// 挂在文章节点上比塞进 isPartOf 里更贴规范（后者没有 position 这个属性位）。
position: post.series && post.series_order > 0 ? post.series_order : undefined,
// url 必须指向系列页本身：以前这里填的是当前文章地址，等于声明
// 「这个系列就长在这篇文章上」，系列页建起来之前是个自指的假地址。
isPartOf: post.series
  ? {
      ''@type'': ''CreativeWorkSeries'',
      name: post.series,
      url: `${origin}/series/${encodeURIComponent(post.series)}`,
    }
  : `${origin}/#website`,
```

还有一个细节：`position` 从 `isPartOf` 里挪到了 `BlogPosting` 上。schema.org 给 `position` 的定义是「在系列/序列中的位置」，它属于被排序的那个条目（这里是文章），不属于容器。之前的写法把序号塞在系列对象里，读起来像「这个系列排第一」，正好反了。

## 二、自指在语义上等于什么

把三元组摊开看，旧版声明的是：

| 主体 | 谓词 | 客体 |
|---|---|---|
| `/p/oauth-pkce`（文章） | `isPartOf` | 一个系列，名字「OAuth 授权流程拆解」，地址 `/p/oauth-pkce` |

客体带着和主体完全相同的地址，还自报了 `@type: CreativeWorkSeries`。等于说「这篇博客文章是一个系列，这个系列就是这篇博客文章」。

搜索引擎要怎么处理这段，我没有在索引层面验证过，只能说到推断为止：它拿不到一个可以合并四篇文章的容器节点。四篇各自声明「我属于一个系列，那个系列的地址是我自己」，四个系列实体，互相之间没有边，`position` 也失去了可比较的父节点。`hasPart`（系列包含哪些篇）从来没出现过——因为文章端不写，系列端又不存在。

对比现在的形状，两份数据是能咬合的：

```text
// /p/oauth-pkce
{ "@type": "BlogPosting", "position": 2,
  "isPartOf": { "@type": "CreativeWorkSeries", "name": "OAuth 授权流程拆解", "url": "https://exia.de5.net/series/OAuth%20..." } }

// /series/OAuth 授权流程拆解
{ "@type": "CreativeWorkSeries", "@id": ".../series/OAuth%20...#series", "numberOfEpisodes": 4,
  "hasPart": [ { "position": 1, "url": "/p/oauth-auth-code" }, { "position": 2, "url": "/p/oauth-pkce" }, ... ] }
```

一边指过去，一边列回来，`numberOfEpisodes` 和实际条数一致。这才是能被当成一个整体处理的结构。

顺带一个副产品：`isPartOf` 指向的地址以前是文章自己，现在是一个真实存在的页面。**结构化数据里的 url 一旦 404，比不写更糟**——搜索引擎会认为这个实体已失效。所以建系列页不是「顺便做的美化」，是改这个字段的前置条件。顺序不能反。

## 三、三类错误，只有一类需要自己写断言

这一节是这件事唯一值得记下来的部分。JSON-LD 的错误分三层，抓法完全不同：

| 层级 | 典型错误 | 谁能抓到 | 本站这次的命中情况 |
|---|---|---|---|
| 语法 | 多一个逗号、`</script>` 被提前闭合、`JSON.parse` 失败 | 任何 JSON 校验；甚至浏览器控制台会报 | 0 处 |
| 引用 | `url` / `image` / `@id` 指向 404 | 死链扫描、爬虫报告 | 0 处 |
| 语义 | 自指、`position` 与实际次序不符、`headline` 与 `<h1>` 不一致、`numberOfEpisodes` 和 `hasPart` 长度不符 | **只有自己写断言** | 8 处自指，一直没人知道 |

自指落在第三层，所以它同时躲过了三种检查：

1. **人眼**。JSON-LD 不渲染。文章页看上去一切正常，系列目录也在，四篇之间的链接也在。
2. **死链检测**。`/p/oauth-pkce` 返回 200，它当然返回 200，它就是当前页。
3. **富媒体测试工具**。Google 的 Rich Results Test 对 `BlogPosting` 报的是「未检测到富媒体内容」，这不是错误，是「这类页面本来就没有富媒体」。它不会告诉你 `isPartOf.url` 指回了自己——这一条我没有逐页跑过 Search Console，只到推断为止。

第四个原因更实在：**`postLd()` 从来没有测试**。15 篇文章上线，这个函数输出的五个字段全靠肉眼。这轮补的 5 条用例，是它第一次被断言：

```js
test(''isPartOf 指向 /series/<名称>，不是文章自己'', () => {
  const j = postLd({ post: { ...base, series: ''OAuth 授权流程拆解'', series_order: 2 }, ...ctx });
  const art = j[''@graph''][0];
  equal(art.isPartOf.url, `${origin}/series/${encodeURIComponent(''OAuth 授权流程拆解'')}`);
  ok(!art.isPartOf.url.includes(art.url.split(''/p/'')[1]), ''url 不能包含自己的 slug'');
});
```

最后那行 `ok(!...)` 是这组用例里唯一有价值的一条。断言「等于某个期望值」会随实现漂移；断言「不能等于自己」是这类错误的形状本身。

## 四、真因：不是 `seo.js`，是 10 篇没有系列归属

发现问题的路径是这样的：先怀疑系列导航缺失，去线上抓了五篇文章，数 `class="series"` 的出现次数。`oauth-pkce` 有，`sticky-toc-grid-align-items` 和 `comment-anti-spam` 没有。当时的判断是「`.series-jump` 是一段写完样式没接上功能的死代码」。

查下去发现不是。`renderSeries()` 在 `oauth-pkce` 上一直在渲染，`series-jump` 的样式也在用。那两篇没有，是因为它们没有 `series`：

| 指标 | 改前 | 改后 |
|---|---|---|
| 已发布文章 | 14 | 14 |
| 有 `series` 的文章 | 8 | 11 |
| 系列数（库内） | 2 | 6 |
| 可见系列页 | 2 | 4（两组整组未到发布时间） |
| 线上自指的 `isPartOf` | 8 | 0 |

8 篇全是 OAuth 四部曲和 Cloudflare 踩坑四篇——这两个系列是最早建的，当时顺手填了 `series`。剩下 6 篇已发的（编辑器两篇、R2、评论、友链、目录 sticky）谁都没填，另外还有 4 篇预排文章（性能、三层缓存、免费额度、存储延迟）也是空的。加起来 10 篇。About 那页同样为空，但它是静态页，不该进系列，不算在里面。

组件这边还有一道闸：`renderSeries()` 第一行就是 `if (!list || list.length < 2) return '''';`。所以只要某篇的 `series` 只有它自己，系列块就不出。这道闸本身是对的（1 篇的「系列目录」没有意义），但它把「没数据」和「数据只有一条」两种状态压成了同一个结果：什么都没有。

## 五、补的三件事

**第一件，补归属。** 三个新系列，把 10 篇里的 7 篇收进去（3 篇已发 + 4 篇预排）：

| 系列 | 成员 |
|---|---|
| 自建博客排障记 | 目录 sticky 失效 / 渲染 549→96ms / 三层缓存 |
| Workers 成本核算 | 免费额度换算 / D1-KV-R2 延迟实测 |
| 编辑器实战 | 自动保存双保险 / Markdown 渲染白名单 |

剩下三篇（友链检测、R2 图片链路、评论防滥用）没硬凑。系列的前提是「有先后顺序、读完一篇想读下一篇」，这三篇是并列的工具文，塞进任何系列都是假连载。

**第二件，建页面。** `/series` 汇总页和 `/series/<名称>` 明细页，都是 Worker 直出：

```js
async function serveSeriesPage(env, request, name) {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, series_order, published_at, created_at FROM posts
     WHERE series = ? AND is_private = 0 AND hidden = 0 AND ${liveSql(''posts'')}
     ORDER BY series_order ASC, created_at ASC`
  ).bind(name).all();

  if (!results.length) return await notFoundPage(env, request, ''没有这个系列'');
  // ...
  numberOfEpisodes: results.length,
  hasPart: results.map((p, i) => ({
    ''@type'': ''BlogPosting'',
    position: p.series_order > 0 ? p.series_order : i + 1,
    name: p.title,
    url: `${origin}/p/${encodeURIComponent(p.slug)}`,
  })),
}
```

注意 `liveSql(''posts'')`——系列页也走时间闸门。这一条不是顺手加的：站上有 9 篇预排文章 `hidden=0`、`published_at` 在未来，系列页如果只按 `hidden` 过滤，`/series/认证边界` 会立刻把四篇没发布的东西列出来。上线后实测这两个系列页都是 404，sitemap 里也没有。

**第三件，改地址 + 上移 `position`。** 就是第一节那段代码。同时系列块里的系列名从纯文本改成链接，指向系列页——不然文章端指过去，读者点不了。

改完 sitemap 从 39 条变 44 条：15 篇文章 + 16 个标签 + 5 个系列（1 个总览 + 4 个明细）+ 4 个栏目 + 4 个单页。系列页进 sitemap 是必须的，它没有别的入口——顶栏放不下第 6 个导航项，640px 会溢出。

还有一处容易漏：`isPagePath()` 是边缘缓存的开关，只认白名单里的路径。新页面不加进去，每次请求都会打到 D1 再渲染一遍，和改造前一样慢。

```js
const isPagePath = (p) =>
  p === ''/'' || p === ''/archive'' || p === ''/categories'' || p === ''/friends'' ||
  p === ''/series'' || p.startsWith(''/series/'') ||
  p.startsWith(''/tag/'') || p.startsWith(''/cat/'') || p.startsWith(''/p/'');
```

加页面的时候顺手想一下它该不该进这个白名单。系列页是纯静态输出（只依赖库里的文章），应该进；如果哪天做一个带登录态的页面，就不能进。

## 六、修完立刻踩到的第二个洞

部署后跑复验，`sticky-toc-grid-align-items` 上 `class="series"` 和 `class="post-adjacent"` 都是 0。**两块都不渲染。**

原因是我自己写的那段兜底导航：

```js
// 非系列文的兜底导航：同栏目按时间排，取前后各一篇。
function renderAdjacent(post, list) {
  if (post.series) return '''';   // ← 有系列就不出兜底
  // ...
}
```

逻辑本来是「系列文有系列块顶着，不需要兜底」。但 `renderSeries()` 要求同系列 ≥2 篇才渲染。那个时刻「自建博客排障记」只有 sticky-toc 一篇公开（549→96 排在 11-18，「三层缓存」排在 11-25），于是：

- `renderSeries` 看到 `list.length === 1`，返回空字符串
- `renderAdjacent` 看到 `post.series` 非空，返回空字符串

那篇文章底部什么都没有，比改之前更糟——改之前至少还有栏目页可退。这类 bug 的特征是**只在数据边界上出现**：系列 2 篇以上、或者 0 篇，都正常；偏偏 1 篇时两块同时消失。

改法是让兜底判断跟着「系列块是否真的渲染」，而不是跟着「有没有系列」：

```js
function renderAdjacent(post, list, seriesList) {
  if (post.series && seriesList && seriesList.length > 1) return '''';
  // ...
}
```

判断条件必须和上游的渲染条件一致，不能各写一套「我认为对方会渲染」。

## 七、验收脚本的第三次自指

写端到端验收时又栽了一次，这次错在检查工具本身。

脚本里用正则抓 JSON-LD：

```js
const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
```

线上抓到 0 块，断言全红，报了两条「没有结构化数据」。实际页面里是：

```html
<script nonce="ZDU1Y2..." type="application/ld+json">
```

`applyNonce()` 会给所有 `<script>` 插 nonce 属性（CSP 要求），属性顺序也不保证。正则把标签写死成 `type` 紧跟 `>`，自然一个都匹配不到。

改成 `<script[^>]*type="application\/ld\+json"[^>]*>` 就好了。但值得记的是**报错的方向**：断言失败说「页面没有结构化数据」，真实情况是「我的采集坏了」。如果这时候去改页面，就会去修一个不存在的问题。

教训很短：断言失败时，先确认采集到了东西，再确认内容对不对。`if (blocks.length === 0) throw new Error(''采集失败'')` 和 `if (!h.includes(''CreativeWorkSeries'')) throw ...` 是两种完全不同性质的失败，不能共用一个报错文案。

## 八、现在的结果

写了个体检脚本 `scripts/check-ld.mjs`，从 sitemap 取出全部文章页，逐篇校验四件事：JSON-LD 能否 `JSON.parse`、`headline` 是否等于页面 `<h1>`、`isPartOf.url` 是否真的能打开且返回 `CreativeWorkSeries`、`position` 是否与该文在系列页里的实际次序一致。

```text
slug                           JSON-LD   headline  isPartOf       position
sticky-toc-grid-align-items    ok        ok        200 +Series    1/1 声明1
editor-autosave                ok        ok        200 +Series    1/2 声明1
editor-markdown-xss            ok        ok        200 +Series    2/2 声明2
oauth-auth-code                ok        ok        200 +Series    1/4 声明1
oauth-pkce                     ok        ok        200 +Series    2/4 声明2
oauth-device-flow              ok        ok        200 +Series    3/4 声明3
oauth-token-lifecycle          ok        ok        200 +Series    4/4 声明4
d1-no-such-table               ok        ok        200 +Series    1/4 声明1
wrangler-deploy-errors         ok        ok        200 +Series    2/4 声明2
workers-io-different-request   ok        ok        200 +Series    3/4 声明3
workers-subrequest-limit       ok        ok        200 +Series    4/4 声明4
comment-anti-spam              ok        ok        站点级          -
r2-image-pipeline              ok        ok        站点级          -
worker-cron-friend-check       ok        ok        站点级          -
about                          ok        ok        站点级          -

15 篇，坏 0 篇，耗时 3479ms
```

`sticky-toc` 那行是 `1/1`——它所在系列此刻确实只有 1 篇公开，正好是第六节那个边界状态。系列块不渲染，兜底导航接管，页面有出口。

同一个脚本如果只查「url 能不能打开」，改之前跑会是全绿：`isPartOf.url` 打开的是文章自己，200。**引用可达这一条根本抓不到自指**。

现在的版本靠两处抓它。第一处是显式比较：

```js
// url 等于本篇地址时，后面所有检查都会以 200 放行
if (part.url === art.url) {
  row.partOf = ''自指'';
  rows.push(row);
  continue;
}
```

第二处是语义比对：从系列页 HTML 里按 `<a href="/p/...">` 抽次序，找自己，`position` 必须等于那个次序。自指的 url 返回的是文章页，抽出来的次序里没有自己，于是判「不在系列页」。

这也是第二次「报错方向不对」：改之前跑，这一条确实会红，但红的是「不在系列页」，而不是「url 指向了自己」。同一个事实，两种描述，后一种要人再往回追一步才想得到。所以第一处那个显式比较不能省——它让报错直接说出原因。

单元测试现在是 88 条全绿，其中 5 条专测 `postLd()`——在这轮之前，这个函数一条用例都没有。`git grep postLd 0f11e80^ -- scripts/` 返回空，就是证据。

## 九、这类错误的一般形态

把这次的两处（`isPartOf` 自指、兜底导航的双空）放在一起，形状是一样的：**两个本该咬合的东西，各自都合法，合起来是错的**。

`isPartOf.url` 单独看是个合法 URL，`CreativeWorkSeries` 单独看是个合法的类型名，拼起来变成一个声称「我是我自己的系列」的节点。`renderSeries` 和 `renderAdjacent` 单独看都正确，组合起来让一篇文章失去全部出口。

所以这类问题的验收不能靠「看每一处对不对」，只能靠「查两个东西对不对得上」。落到结构化数据上，具体就这几条：

| 字段 | 断言 | 出错时的样子 |
|---|---|---|
| `isPartOf.url` | 不等于本篇 `url` | 自指，200，工具全放行 |
| `isPartOf.url` | 打开后含 `CreativeWorkSeries` | 指向文章页或 404 |
| `position` | 等于在系列页中的实际次序 | 序号重复或断号，看不出 |
| `numberOfEpisodes` | 等于 `hasPart` 长度 | 系列页漏算了未发布文章时最常发生 |
| `headline` | 等于页面 `<h1>` | 改标题只改了一处 |
| 系列块 / 兜底导航 | 至少一个渲染 | 单篇系列时两块同时消失 |

其中最容易被忽略的是最后一行。它不是结构化数据问题，但它和第一行是同一个毛病：**判断条件写在了两个地方，各自都自洽**。

## 十、两个刻意的取舍

**`/series` 没有进顶栏。** 现在顶栏 5 项，第 6 项在 640px 会把站名挤成 `Exia Bl…`——这个坑十月份刚修过一次，不想为一个入口再动手机端布局。所以系列页的入口是三处：每篇系列文顶部的系列名、各系列页页脚的互链、sitemap。读者从文章进系列是最自然的路径，从首页找系列本来就不是常见动作。

**没有把 15 篇全塞进系列。** 判据只有一条：**有没有先后顺序**。「目录不跟着滚 → 渲染 549ms → 三层缓存」是同一个站在不同阶段的排障，后一篇用得上前一篇的结论；「友链检测 / R2 图片链路 / 评论防滥用」是三件并列的工具，谁也不依赖谁，硬凑成「站内功能三部曲」只会让系列目录变成第二个栏目页。系列的价值在于「读完这篇该读哪篇」，不在于「把文章分组」。

相关：这一轮同时动的布局与暗色层次，写在[《目录不跟着滚：sticky 在 grid 里失效》](/p/sticky-toc-grid-align-items)和[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)里；系列机制最早是在[《OAuth：为什么要绕一个 302》](/p/oauth-auth-code)那批稿子里立起来的，那批稿子也是这次 8 段自指的全部来源。

还有一条没做：这个体检脚本没有挂进 CI，是手动跑的。挂进去的代价是要在 CI 里访问线上站点（构建阶段站可能还没部署），收益是每次改 `seo.js` 自动验一遍。现在改成手动跑，是因为改动频率低——一个月动两次的东西，加一条流水线的维护成本比收益高。等它真出第二次问题再说。

## 怎么自己验一遍

```bash
# 1. 体检线上全部文章的 JSON-LD（含引用可达、position 一致、headline 一致）
node scripts/check-ld.mjs

# 2. 只看某一篇的 isPartOf，确认 url 不是它自己
node --input-type=module -e "const h=await(await fetch(''https://exia.de5.net/p/oauth-pkce'')).text();
  const j=JSON.parse(h.match(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/)[1]);
  console.log(j[''@graph''][0].isPartOf)"

# 3. 确认系列页地址真实存在且带 number/hasPart
curl -s "https://exia.de5.net/series/OAuth%20%E6%8E%88%E6%9D%83%E6%B5%81%E7%A8%8B%E6%8B%86%E8%A7%A3" \
  | grep -oE ''numberOfEpisodes":[0-9]+|"position":[0-9]+'' | head

# 4. 单元测试里的形状断言（不要只断言等于某个值）
npm test 2>&1 | grep -A2 "isPartOf"
```

手动那一步：把文章页地址粘进 Google Rich Results Test，看它识别出的是什么类型、`isPartOf` 有没有被展开。这一步只能看到「解析结果」，看不到语义对错——自指的 url 在那里同样是一个正常的链接。

要判断语义，只有一条路：把 url 打开，看里面有没有那个系列本身。

同一族还有一个更安静的：`sitemap` 的 `<lastmod>` 会早于页面里的 `datePublished`。两个字段出自同一条记录、同一个 Worker，却声明了相反的先后 —— 页面照样 200，XML 照样合法，没有任何工具报警。那篇写完再回来补链接。
', html_content = '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p><code>isPartOf</code> 里的 <code>url</code> 填的是文章自己的地址。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">json</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-json"><span class="tok-s">&quot;isPartOf&quot;</span>: {
  <span class="tok-s">&quot;@type&quot;</span>: <span class="tok-s">&quot;CreativeWorkSeries&quot;</span>,
  <span class="tok-s">&quot;name&quot;</span>: <span class="tok-s">&quot;OAuth 授权流程拆解&quot;</span>,
  <span class="tok-s">&quot;url&quot;</span>: <span class="tok-s">&quot;https://exia.de5.net/p/oauth-pkce&quot;</span>
}</code></pre></div>
<p>这句话的语义是：<code>/p/oauth-pkce</code> 这一篇，属于一个叫「OAuth 授权流程拆解」的系列，而这个系列的地址就是 <code>/p/oauth-pkce</code> 自己。四篇系列文，四段一模一样的自指声明，从系列机制上线那天写进去，一直到 11-14 才被发现。</p>
<p>它没被发现的理由很具体：<strong>自指 url 是一个能打开、返回 200 的合法地址</strong>。所有靠「链接是否可达」判断的检查都会放行，人工点开也看不出异常，JSON-LD 本身又不渲染给人看。语法对的、引用活的、语义错的——这一类错误只有专门写断言才抓得到。</p>
<p>真正的原因还不在 <code>seo.js</code>。站上 14 篇文章里有 6 篇的 <code>series</code> 字段是空的，系列组件拿不到数据，压根没渲染过。<code>isPartOf</code> 只在有系列的那 8 篇上输出，全站 8 段自指。补数据、建系列页、改地址，是三件事，不是一件。</p>
<p>修完上线，我自己又引入了一个更严重的坑：系列里只有 1 篇公开文章时，系列块和兜底导航同时不渲染，那篇文章彻底没有出口，比修之前还糟。</p>
<h2 id="一-那行代码长什么样"><a class="h-anchor" href="#一-那行代码长什么样">#</a>一、那行代码长什么样</h2>
<p><code>src/seo.js</code> 的 <code>postLd()</code> 负责文章页的 JSON-LD。改动前是这样：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/seo.js，0f11e80 之前</span>
isPartOf: post.series
  ? { <span class="tok-s">&#39;@type&#39;</span>: <span class="tok-s">&#39;CreativeWorkSeries&#39;</span>, name: post.series, url: <span class="tok-s">`${origin}/p/${encodeURIComponent(post.slug)}`</span> }
  : <span class="tok-s">`${origin}/#website`</span>,</code></pre></div>
<p>写成这样几乎是必然的。写这段代码的时候，手边只有三个东西：<code>origin</code>、<code>post.slug</code>、<code>post.series</code>。<code>post.series</code> 是个字符串，不是地址；而 <code>url</code> 这个字段名要求一个地址。于是最近的、唯一现成拼得出来的地址，就是当前文章的地址。</p>
<p>同一个文件里，<code>listLd()</code> 也拼过同样的地址——那里是对的，列表页列出来的每个条目，地址就是它自己。区别在于位置：<code>isPartOf</code> 要的不是「这篇在哪」，是「这个系列在哪」。字段名里那个 <code>Part</code> 把方向说清楚了，写的时候没往这上面想。</p>
<p>这种情况有个特征：<strong>复制粘贴不会报错，只会把语义悄悄改掉</strong>。改完的版本：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/seo.js，0f11e80</span>
<span class="tok-c">// 系列内序号。schema.org 的 position 定义就是「在系列/序列中的位置」，</span>
<span class="tok-c">// 挂在文章节点上比塞进 isPartOf 里更贴规范（后者没有 position 这个属性位）。</span>
position: post.series &amp;&amp; post.series_order &gt; <span class="tok-n">0</span> ? post.series_order : <span class="tok-k">undefined</span>,
<span class="tok-c">// url 必须指向系列页本身：以前这里填的是当前文章地址，等于声明</span>
<span class="tok-c">// 「这个系列就长在这篇文章上」，系列页建起来之前是个自指的假地址。</span>
isPartOf: post.series
  ? {
      <span class="tok-s">&#39;@type&#39;</span>: <span class="tok-s">&#39;CreativeWorkSeries&#39;</span>,
      name: post.series,
      url: <span class="tok-s">`${origin}/series/${encodeURIComponent(post.series)}`</span>,
    }
  : <span class="tok-s">`${origin}/#website`</span>,</code></pre></div>
<p>还有一个细节：<code>position</code> 从 <code>isPartOf</code> 里挪到了 <code>BlogPosting</code> 上。schema.org 给 <code>position</code> 的定义是「在系列/序列中的位置」，它属于被排序的那个条目（这里是文章），不属于容器。之前的写法把序号塞在系列对象里，读起来像「这个系列排第一」，正好反了。</p>
<h2 id="二-自指在语义上等于什么"><a class="h-anchor" href="#二-自指在语义上等于什么">#</a>二、自指在语义上等于什么</h2>
<p>把三元组摊开看，旧版声明的是：</p>
<div class="table-wrap"><table><thead><tr><th>主体</th><th>谓词</th><th>客体</th></tr></thead><tbody><tr><td><code>/p/oauth-pkce</code>（文章）</td><td><code>isPartOf</code></td><td>一个系列，名字「OAuth 授权流程拆解」，地址 <code>/p/oauth-pkce</code></td></tr></tbody></table></div>
<p>客体带着和主体完全相同的地址，还自报了 <code>@type: CreativeWorkSeries</code>。等于说「这篇博客文章是一个系列，这个系列就是这篇博客文章」。</p>
<p>搜索引擎要怎么处理这段，我没有在索引层面验证过，只能说到推断为止：它拿不到一个可以合并四篇文章的容器节点。四篇各自声明「我属于一个系列，那个系列的地址是我自己」，四个系列实体，互相之间没有边，<code>position</code> 也失去了可比较的父节点。<code>hasPart</code>（系列包含哪些篇）从来没出现过——因为文章端不写，系列端又不存在。</p>
<p>对比现在的形状，两份数据是能咬合的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">// /p/oauth-pkce
{ &quot;@type&quot;: &quot;BlogPosting&quot;, &quot;position&quot;: 2,
  &quot;isPartOf&quot;: { &quot;@type&quot;: &quot;CreativeWorkSeries&quot;, &quot;name&quot;: &quot;OAuth 授权流程拆解&quot;, &quot;url&quot;: &quot;https://exia.de5.net/series/OAuth%20...&quot; } }

// /series/OAuth 授权流程拆解
{ &quot;@type&quot;: &quot;CreativeWorkSeries&quot;, &quot;@id&quot;: &quot;.../series/OAuth%20...#series&quot;, &quot;numberOfEpisodes&quot;: 4,
  &quot;hasPart&quot;: [ { &quot;position&quot;: 1, &quot;url&quot;: &quot;/p/oauth-auth-code&quot; }, { &quot;position&quot;: 2, &quot;url&quot;: &quot;/p/oauth-pkce&quot; }, ... ] }</code></pre></div>
<p>一边指过去，一边列回来，<code>numberOfEpisodes</code> 和实际条数一致。这才是能被当成一个整体处理的结构。</p>
<p>顺带一个副产品：<code>isPartOf</code> 指向的地址以前是文章自己，现在是一个真实存在的页面。<strong>结构化数据里的 url 一旦 404，比不写更糟</strong>——搜索引擎会认为这个实体已失效。所以建系列页不是「顺便做的美化」，是改这个字段的前置条件。顺序不能反。</p>
<h2 id="三-三类错误-只有一类需要自己写断言"><a class="h-anchor" href="#三-三类错误-只有一类需要自己写断言">#</a>三、三类错误，只有一类需要自己写断言</h2>
<p>这一节是这件事唯一值得记下来的部分。JSON-LD 的错误分三层，抓法完全不同：</p>
<div class="table-wrap"><table><thead><tr><th>层级</th><th>典型错误</th><th>谁能抓到</th><th>本站这次的命中情况</th></tr></thead><tbody><tr><td>语法</td><td>多一个逗号、<code>&lt;/script&gt;</code> 被提前闭合、<code>JSON.parse</code> 失败</td><td>任何 JSON 校验；甚至浏览器控制台会报</td><td>0 处</td></tr><tr><td>引用</td><td><code>url</code> / <code>image</code> / <code>@id</code> 指向 404</td><td>死链扫描、爬虫报告</td><td>0 处</td></tr><tr><td>语义</td><td>自指、<code>position</code> 与实际次序不符、<code>headline</code> 与 <code>&lt;h1&gt;</code> 不一致、<code>numberOfEpisodes</code> 和 <code>hasPart</code> 长度不符</td><td><strong>只有自己写断言</strong></td><td>8 处自指，一直没人知道</td></tr></tbody></table></div>
<p>自指落在第三层，所以它同时躲过了三种检查：</p>
<ol><li><strong>人眼</strong>。JSON-LD 不渲染。文章页看上去一切正常，系列目录也在，四篇之间的链接也在。</li><li><strong>死链检测</strong>。<code>/p/oauth-pkce</code> 返回 200，它当然返回 200，它就是当前页。</li><li><strong>富媒体测试工具</strong>。Google 的 Rich Results Test 对 <code>BlogPosting</code> 报的是「未检测到富媒体内容」，这不是错误，是「这类页面本来就没有富媒体」。它不会告诉你 <code>isPartOf.url</code> 指回了自己——这一条我没有逐页跑过 Search Console，只到推断为止。</li></ol>
<p>第四个原因更实在：<strong><code>postLd()</code> 从来没有测试</strong>。15 篇文章上线，这个函数输出的五个字段全靠肉眼。这轮补的 5 条用例，是它第一次被断言：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">test</span>(<span class="tok-s">&#39;isPartOf 指向 /series/&lt;名称&gt;，不是文章自己&#39;</span>, () =&gt; {
  <span class="tok-k">const</span> j = <span class="tok-f">postLd</span>({ post: { ...base, series: <span class="tok-s">&#39;OAuth 授权流程拆解&#39;</span>, series_order: <span class="tok-n">2</span> }, ...ctx });
  <span class="tok-k">const</span> art = j[<span class="tok-s">&#39;@graph&#39;</span>][<span class="tok-n">0</span>];
  <span class="tok-f">equal</span>(art.isPartOf.url, <span class="tok-s">`${origin}/series/${encodeURIComponent(&#39;OAuth 授权流程拆解&#39;)}`</span>);
  <span class="tok-f">ok</span>(!art.isPartOf.url.<span class="tok-f">includes</span>(art.url.<span class="tok-f">split</span>(<span class="tok-s">&#39;/p/&#39;</span>)[<span class="tok-n">1</span>]), <span class="tok-s">&#39;url 不能包含自己的 slug&#39;</span>);
});</code></pre></div>
<p>最后那行 <code>ok(!...)</code> 是这组用例里唯一有价值的一条。断言「等于某个期望值」会随实现漂移；断言「不能等于自己」是这类错误的形状本身。</p>
<h2 id="四-真因-不是-seo-js-是-10-篇没有系列归属"><a class="h-anchor" href="#四-真因-不是-seo-js-是-10-篇没有系列归属">#</a>四、真因：不是 <code>seo.js</code>，是 10 篇没有系列归属</h2>
<p>发现问题的路径是这样的：先怀疑系列导航缺失，去线上抓了五篇文章，数 <code>class=&quot;series&quot;</code> 的出现次数。<code>oauth-pkce</code> 有，<code>sticky-toc-grid-align-items</code> 和 <code>comment-anti-spam</code> 没有。当时的判断是「<code>.series-jump</code> 是一段写完样式没接上功能的死代码」。</p>
<p>查下去发现不是。<code>renderSeries()</code> 在 <code>oauth-pkce</code> 上一直在渲染，<code>series-jump</code> 的样式也在用。那两篇没有，是因为它们没有 <code>series</code>：</p>
<div class="table-wrap"><table><thead><tr><th>指标</th><th>改前</th><th>改后</th></tr></thead><tbody><tr><td>已发布文章</td><td>14</td><td>14</td></tr><tr><td>有 <code>series</code> 的文章</td><td>8</td><td>11</td></tr><tr><td>系列数（库内）</td><td>2</td><td>6</td></tr><tr><td>可见系列页</td><td>2</td><td>4（两组整组未到发布时间）</td></tr><tr><td>线上自指的 <code>isPartOf</code></td><td>8</td><td>0</td></tr></tbody></table></div>
<p>8 篇全是 OAuth 四部曲和 Cloudflare 踩坑四篇——这两个系列是最早建的，当时顺手填了 <code>series</code>。剩下 6 篇已发的（编辑器两篇、R2、评论、友链、目录 sticky）谁都没填，另外还有 4 篇预排文章（性能、三层缓存、免费额度、存储延迟）也是空的。加起来 10 篇。About 那页同样为空，但它是静态页，不该进系列，不算在里面。</p>
<p>组件这边还有一道闸：<code>renderSeries()</code> 第一行就是 <code>if (!list || list.length &lt; 2) return &#39;&#39;;</code>。所以只要某篇的 <code>series</code> 只有它自己，系列块就不出。这道闸本身是对的（1 篇的「系列目录」没有意义），但它把「没数据」和「数据只有一条」两种状态压成了同一个结果：什么都没有。</p>
<h2 id="五-补的三件事"><a class="h-anchor" href="#五-补的三件事">#</a>五、补的三件事</h2>
<p><strong>第一件，补归属。</strong> 三个新系列，把 10 篇里的 7 篇收进去（3 篇已发 + 4 篇预排）：</p>
<div class="table-wrap"><table><thead><tr><th>系列</th><th>成员</th></tr></thead><tbody><tr><td>自建博客排障记</td><td>目录 sticky 失效 / 渲染 549→96ms / 三层缓存</td></tr><tr><td>Workers 成本核算</td><td>免费额度换算 / D1-KV-R2 延迟实测</td></tr><tr><td>编辑器实战</td><td>自动保存双保险 / Markdown 渲染白名单</td></tr></tbody></table></div>
<p>剩下三篇（友链检测、R2 图片链路、评论防滥用）没硬凑。系列的前提是「有先后顺序、读完一篇想读下一篇」，这三篇是并列的工具文，塞进任何系列都是假连载。</p>
<p><strong>第二件，建页面。</strong> <code>/series</code> 汇总页和 <code>/series/&lt;名称&gt;</code> 明细页，都是 Worker 直出：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">serveSeriesPage</span>(env, request, name) {
  <span class="tok-k">const</span> { results } = <span class="tok-k">await</span> env.DB.<span class="tok-f">prepare</span>(
    <span class="tok-s">`SELECT slug, title, series_order, published_at, created_at FROM posts
     WHERE series = ? AND is_private = 0 AND hidden = 0 AND ${liveSql(&#39;posts&#39;)}
     ORDER BY series_order ASC, created_at ASC`</span>
  ).<span class="tok-f">bind</span>(name).<span class="tok-f">all</span>();

  <span class="tok-k">if</span> (!results.length) <span class="tok-k">return</span> <span class="tok-k">await</span> <span class="tok-f">notFoundPage</span>(env, request, <span class="tok-s">&#39;没有这个系列&#39;</span>);
  <span class="tok-c">// ...</span>
  numberOfEpisodes: results.length,
  hasPart: results.<span class="tok-f">map</span>((p, i) =&gt; ({
    <span class="tok-s">&#39;@type&#39;</span>: <span class="tok-s">&#39;BlogPosting&#39;</span>,
    position: p.series_order &gt; <span class="tok-n">0</span> ? p.series_order : i + <span class="tok-n">1</span>,
    name: p.title,
    url: <span class="tok-s">`${origin}/p/${encodeURIComponent(p.slug)}`</span>,
  })),
}</code></pre></div>
<p>注意 <code>liveSql(&#39;posts&#39;)</code>——系列页也走时间闸门。这一条不是顺手加的：站上有 9 篇预排文章 <code>hidden=0</code>、<code>published_at</code> 在未来，系列页如果只按 <code>hidden</code> 过滤，<code>/series/认证边界</code> 会立刻把四篇没发布的东西列出来。上线后实测这两个系列页都是 404，sitemap 里也没有。</p>
<p><strong>第三件，改地址 + 上移 <code>position</code>。</strong> 就是第一节那段代码。同时系列块里的系列名从纯文本改成链接，指向系列页——不然文章端指过去，读者点不了。</p>
<p>改完 sitemap 从 39 条变 44 条：15 篇文章 + 16 个标签 + 5 个系列（1 个总览 + 4 个明细）+ 4 个栏目 + 4 个单页。系列页进 sitemap 是必须的，它没有别的入口——顶栏放不下第 6 个导航项，640px 会溢出。</p>
<p>还有一处容易漏：<code>isPagePath()</code> 是边缘缓存的开关，只认白名单里的路径。新页面不加进去，每次请求都会打到 D1 再渲染一遍，和改造前一样慢。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> isPagePath = (p) =&gt;
  p === <span class="tok-s">&#39;/&#39;</span> || p === <span class="tok-s">&#39;/archive&#39;</span> || p === <span class="tok-s">&#39;/categories&#39;</span> || p === <span class="tok-s">&#39;/friends&#39;</span> ||
  p === <span class="tok-s">&#39;/series&#39;</span> || p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/series/&#39;</span>) ||
  p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/tag/&#39;</span>) || p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/cat/&#39;</span>) || p.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;/p/&#39;</span>);</code></pre></div>
<p>加页面的时候顺手想一下它该不该进这个白名单。系列页是纯静态输出（只依赖库里的文章），应该进；如果哪天做一个带登录态的页面，就不能进。</p>
<h2 id="六-修完立刻踩到的第二个洞"><a class="h-anchor" href="#六-修完立刻踩到的第二个洞">#</a>六、修完立刻踩到的第二个洞</h2>
<p>部署后跑复验，<code>sticky-toc-grid-align-items</code> 上 <code>class=&quot;series&quot;</code> 和 <code>class=&quot;post-adjacent&quot;</code> 都是 0。<strong>两块都不渲染。</strong></p>
<p>原因是我自己写的那段兜底导航：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 非系列文的兜底导航：同栏目按时间排，取前后各一篇。</span>
<span class="tok-k">function</span> <span class="tok-f">renderAdjacent</span>(post, list) {
  <span class="tok-k">if</span> (post.series) <span class="tok-k">return</span> <span class="tok-s">&#39;&#39;</span>;   <span class="tok-c">// ← 有系列就不出兜底</span>
  <span class="tok-c">// ...</span>
}</code></pre></div>
<p>逻辑本来是「系列文有系列块顶着，不需要兜底」。但 <code>renderSeries()</code> 要求同系列 ≥2 篇才渲染。那个时刻「自建博客排障记」只有 sticky-toc 一篇公开（549→96 排在 11-18，「三层缓存」排在 11-25），于是：</p>
<ul><li><code>renderSeries</code> 看到 <code>list.length === 1</code>，返回空字符串</li><li><code>renderAdjacent</code> 看到 <code>post.series</code> 非空，返回空字符串</li></ul>
<p>那篇文章底部什么都没有，比改之前更糟——改之前至少还有栏目页可退。这类 bug 的特征是<strong>只在数据边界上出现</strong>：系列 2 篇以上、或者 0 篇，都正常；偏偏 1 篇时两块同时消失。</p>
<p>改法是让兜底判断跟着「系列块是否真的渲染」，而不是跟着「有没有系列」：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">renderAdjacent</span>(post, list, seriesList) {
  <span class="tok-k">if</span> (post.series &amp;&amp; seriesList &amp;&amp; seriesList.length &gt; <span class="tok-n">1</span>) <span class="tok-k">return</span> <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-c">// ...</span>
}</code></pre></div>
<p>判断条件必须和上游的渲染条件一致，不能各写一套「我认为对方会渲染」。</p>
<h2 id="七-验收脚本的第三次自指"><a class="h-anchor" href="#七-验收脚本的第三次自指">#</a>七、验收脚本的第三次自指</h2>
<p>写端到端验收时又栽了一次，这次错在检查工具本身。</p>
<p>脚本里用正则抓 JSON-LD：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> re = /&lt;script type=<span class="tok-s">&quot;application\/ld\+json&quot;</span>&gt;([\s\S]*?)&lt;\/script&gt;/g;</code></pre></div>
<p>线上抓到 0 块，断言全红，报了两条「没有结构化数据」。实际页面里是：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">html</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-html">&lt;script nonce=<span class="tok-s">&quot;ZDU1Y2...&quot;</span> type=<span class="tok-s">&quot;application/ld+json&quot;</span>&gt;</code></pre></div>
<p><code>applyNonce()</code> 会给所有 <code>&lt;script&gt;</code> 插 nonce 属性（CSP 要求），属性顺序也不保证。正则把标签写死成 <code>type</code> 紧跟 <code>&gt;</code>，自然一个都匹配不到。</p>
<p>改成 <code>&lt;script[^&gt;]*type=&quot;application\/ld\+json&quot;[^&gt;]*&gt;</code> 就好了。但值得记的是<strong>报错的方向</strong>：断言失败说「页面没有结构化数据」，真实情况是「我的采集坏了」。如果这时候去改页面，就会去修一个不存在的问题。</p>
<p>教训很短：断言失败时，先确认采集到了东西，再确认内容对不对。<code>if (blocks.length === 0) throw new Error(&#39;采集失败&#39;)</code> 和 <code>if (!h.includes(&#39;CreativeWorkSeries&#39;)) throw ...</code> 是两种完全不同性质的失败，不能共用一个报错文案。</p>
<h2 id="八-现在的结果"><a class="h-anchor" href="#八-现在的结果">#</a>八、现在的结果</h2>
<p>写了个体检脚本 <code>scripts/check-ld.mjs</code>，从 sitemap 取出全部文章页，逐篇校验四件事：JSON-LD 能否 <code>JSON.parse</code>、<code>headline</code> 是否等于页面 <code>&lt;h1&gt;</code>、<code>isPartOf.url</code> 是否真的能打开且返回 <code>CreativeWorkSeries</code>、<code>position</code> 是否与该文在系列页里的实际次序一致。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">slug                           JSON-LD   headline  isPartOf       position
sticky-toc-grid-align-items    ok        ok        200 +Series    1/1 声明1
editor-autosave                ok        ok        200 +Series    1/2 声明1
editor-markdown-xss            ok        ok        200 +Series    2/2 声明2
oauth-auth-code                ok        ok        200 +Series    1/4 声明1
oauth-pkce                     ok        ok        200 +Series    2/4 声明2
oauth-device-flow              ok        ok        200 +Series    3/4 声明3
oauth-token-lifecycle          ok        ok        200 +Series    4/4 声明4
d1-no-such-table               ok        ok        200 +Series    1/4 声明1
wrangler-deploy-errors         ok        ok        200 +Series    2/4 声明2
workers-io-different-request   ok        ok        200 +Series    3/4 声明3
workers-subrequest-limit       ok        ok        200 +Series    4/4 声明4
comment-anti-spam              ok        ok        站点级          -
r2-image-pipeline              ok        ok        站点级          -
worker-cron-friend-check       ok        ok        站点级          -
about                          ok        ok        站点级          -

15 篇，坏 0 篇，耗时 3479ms</code></pre></div>
<p><code>sticky-toc</code> 那行是 <code>1/1</code>——它所在系列此刻确实只有 1 篇公开，正好是第六节那个边界状态。系列块不渲染，兜底导航接管，页面有出口。</p>
<p>同一个脚本如果只查「url 能不能打开」，改之前跑会是全绿：<code>isPartOf.url</code> 打开的是文章自己，200。<strong>引用可达这一条根本抓不到自指</strong>。</p>
<p>现在的版本靠两处抓它。第一处是显式比较：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// url 等于本篇地址时，后面所有检查都会以 200 放行</span>
<span class="tok-k">if</span> (part.url === art.url) {
  row.partOf = <span class="tok-s">&#39;自指&#39;</span>;
  rows.<span class="tok-f">push</span>(row);
  <span class="tok-k">continue</span>;
}</code></pre></div>
<p>第二处是语义比对：从系列页 HTML 里按 <code>&lt;a href=&quot;/p/...&quot;&gt;</code> 抽次序，找自己，<code>position</code> 必须等于那个次序。自指的 url 返回的是文章页，抽出来的次序里没有自己，于是判「不在系列页」。</p>
<p>这也是第二次「报错方向不对」：改之前跑，这一条确实会红，但红的是「不在系列页」，而不是「url 指向了自己」。同一个事实，两种描述，后一种要人再往回追一步才想得到。所以第一处那个显式比较不能省——它让报错直接说出原因。</p>
<p>单元测试现在是 88 条全绿，其中 5 条专测 <code>postLd()</code>——在这轮之前，这个函数一条用例都没有。<code>git grep postLd 0f11e80^ -- scripts/</code> 返回空，就是证据。</p>
<h2 id="九-这类错误的一般形态"><a class="h-anchor" href="#九-这类错误的一般形态">#</a>九、这类错误的一般形态</h2>
<p>把这次的两处（<code>isPartOf</code> 自指、兜底导航的双空）放在一起，形状是一样的：<strong>两个本该咬合的东西，各自都合法，合起来是错的</strong>。</p>
<p><code>isPartOf.url</code> 单独看是个合法 URL，<code>CreativeWorkSeries</code> 单独看是个合法的类型名，拼起来变成一个声称「我是我自己的系列」的节点。<code>renderSeries</code> 和 <code>renderAdjacent</code> 单独看都正确，组合起来让一篇文章失去全部出口。</p>
<p>所以这类问题的验收不能靠「看每一处对不对」，只能靠「查两个东西对不对得上」。落到结构化数据上，具体就这几条：</p>
<div class="table-wrap"><table><thead><tr><th>字段</th><th>断言</th><th>出错时的样子</th></tr></thead><tbody><tr><td><code>isPartOf.url</code></td><td>不等于本篇 <code>url</code></td><td>自指，200，工具全放行</td></tr><tr><td><code>isPartOf.url</code></td><td>打开后含 <code>CreativeWorkSeries</code></td><td>指向文章页或 404</td></tr><tr><td><code>position</code></td><td>等于在系列页中的实际次序</td><td>序号重复或断号，看不出</td></tr><tr><td><code>numberOfEpisodes</code></td><td>等于 <code>hasPart</code> 长度</td><td>系列页漏算了未发布文章时最常发生</td></tr><tr><td><code>headline</code></td><td>等于页面 <code>&lt;h1&gt;</code></td><td>改标题只改了一处</td></tr><tr><td>系列块 / 兜底导航</td><td>至少一个渲染</td><td>单篇系列时两块同时消失</td></tr></tbody></table></div>
<p>其中最容易被忽略的是最后一行。它不是结构化数据问题，但它和第一行是同一个毛病：<strong>判断条件写在了两个地方，各自都自洽</strong>。</p>
<h2 id="十-两个刻意的取舍"><a class="h-anchor" href="#十-两个刻意的取舍">#</a>十、两个刻意的取舍</h2>
<p><strong><code>/series</code> 没有进顶栏。</strong> 现在顶栏 5 项，第 6 项在 640px 会把站名挤成 <code>Exia Bl…</code>——这个坑十月份刚修过一次，不想为一个入口再动手机端布局。所以系列页的入口是三处：每篇系列文顶部的系列名、各系列页页脚的互链、sitemap。读者从文章进系列是最自然的路径，从首页找系列本来就不是常见动作。</p>
<p><strong>没有把 15 篇全塞进系列。</strong> 判据只有一条：<strong>有没有先后顺序</strong>。「目录不跟着滚 → 渲染 549ms → 三层缓存」是同一个站在不同阶段的排障，后一篇用得上前一篇的结论；「友链检测 / R2 图片链路 / 评论防滥用」是三件并列的工具，谁也不依赖谁，硬凑成「站内功能三部曲」只会让系列目录变成第二个栏目页。系列的价值在于「读完这篇该读哪篇」，不在于「把文章分组」。</p>
<p>相关：这一轮同时动的布局与暗色层次，写在<a href="/p/sticky-toc-grid-align-items">《目录不跟着滚：sticky 在 grid 里失效》</a>和<a href="/p/worker-render-549-to-96">《Worker 渲染从 549ms 到 96ms》</a>里；系列机制最早是在<a href="/p/oauth-auth-code">《OAuth：为什么要绕一个 302》</a>那批稿子里立起来的，那批稿子也是这次 8 段自指的全部来源。</p>
<p>还有一条没做：这个体检脚本没有挂进 CI，是手动跑的。挂进去的代价是要在 CI 里访问线上站点（构建阶段站可能还没部署），收益是每次改 <code>seo.js</code> 自动验一遍。现在改成手动跑，是因为改动频率低——一个月动两次的东西，加一条流水线的维护成本比收益高。等它真出第二次问题再说。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1. 体检线上全部文章的 JSON-LD（含引用可达、position 一致、headline 一致）</span>
<span class="tok-k">node</span> scripts/check-ld.mjs

<span class="tok-c"># 2. 只看某一篇的 isPartOf，确认 url 不是它自己</span>
<span class="tok-k">node</span> --input-type=module -e &quot;const h=<span class="tok-f">await</span>(await <span class="tok-f">fetch</span>(<span class="tok-s">&#39;https://exia.de5.net/p/oauth-pkce&#39;</span>)).<span class="tok-f">text</span>();
  const j=JSON.<span class="tok-f">parse</span>(h.<span class="tok-f">match</span>(/&lt;script[^&gt;]*ld\+json[^&gt;]*&gt;([\s\S]*?)&lt;\/script&gt;/)[<span class="tok-n">1</span>]);
  console.<span class="tok-f">log</span>(j[<span class="tok-s">&#39;@graph&#39;</span>][<span class="tok-n">0</span>].isPartOf)&quot;

<span class="tok-c"># 3. 确认系列页地址真实存在且带 number/hasPart</span>
<span class="tok-k">curl</span> -s <span class="tok-s">&quot;https://exia.de5.net/series/OAuth%20%E6%8E%88%E6%9D%83%E6%B5%81%E7%A8%8B%E6%8B%86%E8%A7%A3&quot;</span> \
  | <span class="tok-k">grep</span> -oE <span class="tok-s">&#39;numberOfEpisodes&quot;:[0-9]+|&quot;position&quot;:[0-9]+&#39;</span> | head

<span class="tok-c"># 4. 单元测试里的形状断言（不要只断言等于某个值）</span>
<span class="tok-k">npm</span> test <span class="tok-n">2</span>&gt;&amp;<span class="tok-n">1</span> | <span class="tok-k">grep</span> -A2 <span class="tok-s">&quot;isPartOf&quot;</span></code></pre></div>
<p>手动那一步：把文章页地址粘进 Google Rich Results Test，看它识别出的是什么类型、<code>isPartOf</code> 有没有被展开。这一步只能看到「解析结果」，看不到语义对错——自指的 url 在那里同样是一个正常的链接。</p>
<p>要判断语义，只有一条路：把 url 打开，看里面有没有那个系列本身。</p>
<p>同一族还有一个更安静的：<code>sitemap</code> 的 <code>&lt;lastmod&gt;</code> 会早于页面里的 <code>datePublished</code>。两个字段出自同一条记录、同一个 Worker，却声明了相反的先后 —— 页面照样 200，XML 照样合法，没有任何工具报警。那篇写完再回来补链接。</p>', cover_body = '', updated_at = datetime('now')
  WHERE slug = 'ld-self-reference';
-- 回补内链：01-d1-no-such-table.md
UPDATE posts SET content = '## 结论

`D1_ERROR: no such table` 九成不是建表语句写错了，是**你在 A 库建表、在 B 库查询**。

`wrangler dev` 默认连本地模拟库（文件落在 `.wrangler/state` 下），`wrangler d1 execute --remote` 连线上库。这是两个完全独立的数据库：本地建的表线上不存在，线上建的表本地也看不见。它们只是恰好都叫 `blog-db`。

## 报错现场

本地跑 `npx wrangler dev`，打开首页，Worker 里执行：

```sql
SELECT id, slug, title FROM posts ORDER BY created_at DESC LIMIT 10
```

返回 500，日志原样：

```
✘ [ERROR] D1_ERROR: no such table: posts: SQLITE_ERROR
```

同一句 SQL，换成 `--remote` 去查却是正常的：

```bash
npx wrangler d1 execute blog-db --remote \
  --command "SELECT COUNT(*) FROM posts"
# [{"COUNT(*)": 1}]
```

到这里就能定性了：SQL 没写错，表也存在，只是**不在你以为的那个库里**。

## 为什么会这样

D1 的 binding 在运行时只有一份（`env.DB`），但它指向谁，由启动方式决定：

| 启动方式 | `env.DB` 实际指向 | 数据在哪 |
|---|---|---|
| `wrangler dev`（默认） | 本地模拟的 D1 | `.wrangler/state/v3/d1/*.sqlite` |
| `wrangler dev --remote` | 线上 D1 | Cloudflare 边缘 |
| `wrangler deploy` 之后访问 | 线上 D1 | Cloudflare 边缘 |
| `wrangler d1 execute --local` | 本地模拟的 D1 | 同第一行 |
| `wrangler d1 execute --remote` | 线上 D1 | 同第二行 |

控制台里那句 `[simulated locally]` 就是提示，只是很容易被刷过去：

```
- D1 Databases:
  - DB: blog-db (2568eaf1-...) [simulated locally]
```

同一个 `database_id`，本地是「模拟」，线上是真库。`schema.sql` 你只跑了一遍，另一套库自然什么都没有。

## 三分钟定位

别猜，按顺序查四个问题：

**1. 报错的 SQL 是哪一条**

把 `console.error(e)` 和 SQL 一起打出来，不然你只能看到「首页 500」。

**2. 这条 SQL 在哪个进程里跑的**

dev、deploy 后的线上、cron 定时任务，三者连的库可能各不相同。

**3. 那个进程连的哪个库**

看 `wrangler dev` 启动时的 binding 列表里有没有 `[simulated locally]`。

**4. 那个库里到底有没有这张表**

```bash
# 本地
npx wrangler d1 execute blog-db --local \
  --command "SELECT name FROM sqlite_master WHERE type=''table'' ORDER BY name"

# 线上
npx wrangler d1 execute blog-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type=''table'' ORDER BY name"
```

两条命令各跑一次，表清单不一样，问题就到此为止了。

## 修法

两个库都要建，就建两次。别指望一条命令通吃：

```bash
npx wrangler d1 execute blog-db --local  --file=./schema.sql
npx wrangler d1 execute blog-db --remote --file=./schema.sql
```

`wrangler d1 migrations apply` 也是一样，`--local` 和 `--remote` 各有各的 `d1_migrations` 记录表。本地记录显示「已执行」，线上完全可能是空的——迁移文件名一样，不代表两边都跑过。

几条配套习惯：

- `.wrangler/` 加进 `.gitignore`。本地库就是那个目录里的一堆 sqlite 文件，删掉等于清库，别手滑。
- 想稳定复现线上状态，用 `npx wrangler d1 export blog-db --remote --output=seed.sql` 导一份，再 `--local --file=seed.sql` 灌进去。
- 本地调试需要登录态时，别去线上 OAuth 绕一圈，直接往本地 `users` 表插一行、手写一个 session cookie 更快（`SESSION_SECRET` 用 `.dev.vars` 里的那份）。

## 三个容易二次踩的坑

**坑一：以为 `wrangler dev` 连的是线上。** v3 之后默认就是本地模式，写不写 `--local` 都一样。要连线上必须显式 `--remote`，而它会真的改线上数据，调试删除逻辑时尤其危险。

**坑二：preview 和 production 用了不同的 database_id。** 如果 `wrangler.jsonc` 里给 preview 环境配了另一个库，你会在 preview 里把同样的错再撞一遍，而且这次本地和线上都是对的，只有 preview 是空的。

**坑三：拿 `--command` 建表。** 单条 `CREATE TABLE` 用 `--command` 能过，但多语句、触发器、`DEFAULT (datetime(''now''))` 这类带括号的默认值，用 `--file` 更稳。我见过 `--command` 只执行了第一句、后面静默丢掉的情况。

## 一句话总结

D1 的 `--local` 和 `--remote` 不是「同一个库的两种访问方式」，而是**两个库**。记住这句，这个错基本只会犯一次。

系列里的另外两篇：[wrangler deploy 失败对照](/p/wrangler-deploy-errors)、[Cannot perform I/O on behalf of a different request](/p/workers-io-different-request)。

补一句后话：这个报错原文该出现在日志里，不该出现在页面路径的响应体里。不带 `Accept` 的请求要是也能拿到 `D1_ERROR: no such table: posts`，表名和 SQL 方言就一起送出去了 —— 那一处修完，回头写一篇专门讲 500 的分流。

#cloudflare #d1 #debugging #sqlite
', html_content = '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p><code>D1_ERROR: no such table</code> 九成不是建表语句写错了，是<strong>你在 A 库建表、在 B 库查询</strong>。</p>
<p><code>wrangler dev</code> 默认连本地模拟库（文件落在 <code>.wrangler/state</code> 下），<code>wrangler d1 execute --remote</code> 连线上库。这是两个完全独立的数据库：本地建的表线上不存在，线上建的表本地也看不见。它们只是恰好都叫 <code>blog-db</code>。</p>
<h2 id="报错现场"><a class="h-anchor" href="#报错现场">#</a>报错现场</h2>
<p>本地跑 <code>npx wrangler dev</code>，打开首页，Worker 里执行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">SELECT id, slug, title FROM posts ORDER BY created_at DESC LIMIT <span class="tok-n">10</span></code></pre></div>
<p>返回 500，日志原样：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">✘ [ERROR] D1_ERROR: no such table: posts: SQLITE_ERROR</code></pre></div>
<p>同一句 SQL，换成 <code>--remote</code> 去查却是正常的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash">npx wrangler d1 execute blog-db --remote \
  --command <span class="tok-s">&quot;SELECT COUNT(*) FROM posts&quot;</span>
<span class="tok-c"># [{&quot;COUNT(*)&quot;: 1}]</span></code></pre></div>
<p>到这里就能定性了：SQL 没写错，表也存在，只是<strong>不在你以为的那个库里</strong>。</p>
<h2 id="为什么会这样"><a class="h-anchor" href="#为什么会这样">#</a>为什么会这样</h2>
<p>D1 的 binding 在运行时只有一份（<code>env.DB</code>），但它指向谁，由启动方式决定：</p>
<div class="table-wrap"><table><thead><tr><th>启动方式</th><th><code>env.DB</code> 实际指向</th><th>数据在哪</th></tr></thead><tbody><tr><td><code>wrangler dev</code>（默认）</td><td>本地模拟的 D1</td><td><code>.wrangler/state/v3/d1/*.sqlite</code></td></tr><tr><td><code>wrangler dev --remote</code></td><td>线上 D1</td><td>Cloudflare 边缘</td></tr><tr><td><code>wrangler deploy</code> 之后访问</td><td>线上 D1</td><td>Cloudflare 边缘</td></tr><tr><td><code>wrangler d1 execute --local</code></td><td>本地模拟的 D1</td><td>同第一行</td></tr><tr><td><code>wrangler d1 execute --remote</code></td><td>线上 D1</td><td>同第二行</td></tr></tbody></table></div>
<p>控制台里那句 <code>[simulated locally]</code> 就是提示，只是很容易被刷过去：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">- D1 Databases:
  - DB: blog-db (2568eaf1-...) [simulated locally]</code></pre></div>
<p>同一个 <code>database_id</code>，本地是「模拟」，线上是真库。<code>schema.sql</code> 你只跑了一遍，另一套库自然什么都没有。</p>
<h2 id="三分钟定位"><a class="h-anchor" href="#三分钟定位">#</a>三分钟定位</h2>
<p>别猜，按顺序查四个问题：</p>
<p><strong>1. 报错的 SQL 是哪一条</strong></p>
<p>把 <code>console.error(e)</code> 和 SQL 一起打出来，不然你只能看到「首页 500」。</p>
<p><strong>2. 这条 SQL 在哪个进程里跑的</strong></p>
<p>dev、deploy 后的线上、cron 定时任务，三者连的库可能各不相同。</p>
<p><strong>3. 那个进程连的哪个库</strong></p>
<p>看 <code>wrangler dev</code> 启动时的 binding 列表里有没有 <code>[simulated locally]</code>。</p>
<p><strong>4. 那个库里到底有没有这张表</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 本地</span>
npx wrangler d1 execute blog-db --local \
  --command <span class="tok-s">&quot;SELECT name FROM sqlite_master WHERE type=&#39;table&#39; ORDER BY name&quot;</span>

<span class="tok-c"># 线上</span>
npx wrangler d1 execute blog-db --remote \
  --command <span class="tok-s">&quot;SELECT name FROM sqlite_master WHERE type=&#39;table&#39; ORDER BY name&quot;</span></code></pre></div>
<p>两条命令各跑一次，表清单不一样，问题就到此为止了。</p>
<h2 id="修法"><a class="h-anchor" href="#修法">#</a>修法</h2>
<p>两个库都要建，就建两次。别指望一条命令通吃：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash">npx wrangler d1 execute blog-db --local  --file=./schema.sql
npx wrangler d1 execute blog-db --remote --file=./schema.sql</code></pre></div>
<p><code>wrangler d1 migrations apply</code> 也是一样，<code>--local</code> 和 <code>--remote</code> 各有各的 <code>d1_migrations</code> 记录表。本地记录显示「已执行」，线上完全可能是空的——迁移文件名一样，不代表两边都跑过。</p>
<p>几条配套习惯：</p>
<ul><li><code>.wrangler/</code> 加进 <code>.gitignore</code>。本地库就是那个目录里的一堆 sqlite 文件，删掉等于清库，别手滑。</li><li>想稳定复现线上状态，用 <code>npx wrangler d1 export blog-db --remote --output=seed.sql</code> 导一份，再 <code>--local --file=seed.sql</code> 灌进去。</li><li>本地调试需要登录态时，别去线上 OAuth 绕一圈，直接往本地 <code>users</code> 表插一行、手写一个 session cookie 更快（<code>SESSION_SECRET</code> 用 <code>.dev.vars</code> 里的那份）。</li></ul>
<h2 id="三个容易二次踩的坑"><a class="h-anchor" href="#三个容易二次踩的坑">#</a>三个容易二次踩的坑</h2>
<p><strong>坑一：以为 <code>wrangler dev</code> 连的是线上。</strong> v3 之后默认就是本地模式，写不写 <code>--local</code> 都一样。要连线上必须显式 <code>--remote</code>，而它会真的改线上数据，调试删除逻辑时尤其危险。</p>
<p><strong>坑二：preview 和 production 用了不同的 database_id。</strong> 如果 <code>wrangler.jsonc</code> 里给 preview 环境配了另一个库，你会在 preview 里把同样的错再撞一遍，而且这次本地和线上都是对的，只有 preview 是空的。</p>
<p><strong>坑三：拿 <code>--command</code> 建表。</strong> 单条 <code>CREATE TABLE</code> 用 <code>--command</code> 能过，但多语句、触发器、<code>DEFAULT (datetime(&#39;now&#39;))</code> 这类带括号的默认值，用 <code>--file</code> 更稳。我见过 <code>--command</code> 只执行了第一句、后面静默丢掉的情况。</p>
<h2 id="一句话总结"><a class="h-anchor" href="#一句话总结">#</a>一句话总结</h2>
<p>D1 的 <code>--local</code> 和 <code>--remote</code> 不是「同一个库的两种访问方式」，而是<strong>两个库</strong>。记住这句，这个错基本只会犯一次。</p>
<p>系列里的另外两篇：<a href="/p/wrangler-deploy-errors">wrangler deploy 失败对照</a>、<a href="/p/workers-io-different-request">Cannot perform I/O on behalf of a different request</a>。</p>
<p>补一句后话：这个报错原文该出现在日志里，不该出现在页面路径的响应体里。不带 <code>Accept</code> 的请求要是也能拿到 <code>D1_ERROR: no such table: posts</code>，表名和 SQL 方言就一起送出去了 —— 那一处修完，回头写一篇专门讲 500 的分流。</p>
<p><a class="tag-inline" href="/tag/cloudflare">#cloudflare</a> <a class="tag-inline" href="/tag/d1">#d1</a> <a class="tag-inline" href="/tag/debugging">#debugging</a> <a class="tag-inline" href="/tag/sqlite">#sqlite</a></p>', cover_body = '', updated_at = datetime('now')
  WHERE slug = 'd1-no-such-table';
