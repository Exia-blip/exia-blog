# 两个都不报错的错：越界页码 200，MAX 写成了标量

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
  return await notFoundPage(env, null, '这一页没有文章');
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
const paged = !!url && (url.pathname === '/' || url.pathname.startsWith('/tag/') || url.pathname.startsWith('/cat/'));
// 页码仍然只在这一处解析一次：走 pageParams，不自己 parseInt
const pageNo = url ? pageParams(url).page : 1;
if (canonicalUrl && paged && pageNo > 1) {
  canonicalUrl.searchParams.set('page', String(pageNo));
}
```

两个细节，都是踩过的：

- **`pageNo` 走 `pageParams(url).page`**，不是 `url.searchParams.get('page')`。后者拿到的是原始字符串，`?page=abc`、`?page=1e21`、`?page=-5` 各有各的写法；前者已经做了 `MAX_PAGE = 10000` 上界和 `Number.isFinite` 判定。同一个参数在全站只能解析一次，这是 `QP-05` 那条元断言守的。
- **判定用 `pathname` 前缀，不用 `paged` 白名单外的东西**。首页写 `=== '/'` 不写 `startsWith('/')` —— 后者会把所有路径都放进来。

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

真正落地的 SQL 还得处理空字符串。本站的 `published_at` 有 `''`（草稿），`COALESCE(NULLIF(x, ''), '0')` 把它压成字符串 `'0'`，这样比较时不会因为 `NULL` 让整行被聚合函数忽略：
```js
const stamp = (a) =>
  `MAX(MAX(COALESCE(NULLIF(${a}.published_at, ''), '0'), COALESCE(${a}.updated_at, ${a}.created_at, '0')))`;
```

这里有个容易搞混的地方：**单篇文章的 `lastmod` 不是 SQL 算的**，是 JS 里比较两个字符串：

```js
const lastOf = (p) => {
  const a = String(p.updated_at || '');
  const b = String(p.published_at || '');
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
const lastUpd = (a = 'p') => stamp(a);   // stamp 就是上面那个 外层MAX(内层MAX(...))

// 单篇：JS 里比两个字符串，不走 SQL
const lastOf = (p) => {
  const a = String(p.updated_at || '');
  const b = String(p.published_at || '');
  return (a > b ? a : b).slice(0, 10);
};
```

`stamp()` 同时用在单篇和组内聚合上 —— 一处定义，六处引用（首页、归档、栏目总览、每个栏目页、每个标签页、每个系列页）。改口径只改一行。

里面那个 `COALESCE(NULLIF(p.updated_at, ''), p.created_at, '0')` 值得单说：本站的 `published_at` 有 `''`（草稿从没发布过）。`NULLIF(x, '')` 把空串变成 `NULL`，`COALESCE` 再往后取 `created_at`，最后兜一个 `'0'`。三层兜底看着啰嗦，缺一层的后果分别是：空串参与字符串比较时排在任何日期之前（`'' < '2026'`），于是草稿会被当成「最老的一篇」；`NULL` 会让 `MAX()` 直接忽略这一行，组内一篇都没发布时聚合结果是 `NULL`，`<lastmod>` 就变成空标签。

顺带一个同源问题：时间信号在站里有三处出口 —— sitemap 的 `<lastmod>`、页面 JSON-LD 的 `dateModified`、RSS 的 `<pubDate>`。三处各自从 `post` 对象取时间，谁都不引用谁。这轮只统一了 sitemap 这一处，另外两处用的是发布日（`pubDate` 本来就该是发布日）或 `updated_at`（`dateModified` 本来就该是最后编辑），语义上没错，但它们之间**没有断言把它们钉在一起** —— 与 P-043 同一个教训：同源字段，要么同源，要么有断言。

## 五、修完之后，同一个坑边上还有一处

P-044 上一轮已经修过一次：500 时按 `Accept` 分流，浏览器拿自绘页，`curl` 拿 JSON。

修完我以为这条结了。这一轮为了验证，往 `handleFetch` 第一行插了一行：

```js
if (new URL(request.url).pathname === '/__boom') throw new Error('D1_ERROR: no such table: posts');
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
  let here = '';
  try {
    here = new URL(request.url).pathname;
  } catch {}
  const wantsHtml =
    !here.startsWith('/api/') &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    /text\/html/.test(request.headers.get('accept') || '');
  if (wantsHtml) {
    return new Response(serverErrorPage(), {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' },
    });
  }
  return here.startsWith('/api/')
    ? json({ ok: false, error: e.message }, 500)
    : json({ ok: false, error: '服务器错误' }, 500);
}
```

里面那个 `try { new URL() } catch {}` 不是凑数：外层 catch 存在的意义就是兜「连 request 都解析不了」的意外，如果兜底的函数自己再抛一次 `TypeError: Invalid URL`，就等于没有兜底。拿不到路径时按非 API 处理 —— 这是唯一安全的默认。

改完同一组注入，三种观众：

| 请求 | 修复前 | 修复后 |
|---|---|---|
| `curl /__boom`（无 Accept） | 500 `{"error":"D1_ERROR: no such table: posts"}`，53 B | 500 `{"error":"服务器错误"}` |
| `curl -H 'Accept: text/html' /__boom` | 500 自定义页（内层 catch 挡住了，本来就没漏） | 500 自定义页，1109 B，`D1_ERROR` 出现 0 次 |
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
- 触发一：`curl -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8791/?page=999'`
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
