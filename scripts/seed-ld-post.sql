-- 由 scripts/seed-ld-post.mjs 生成，勿手改
INSERT INTO posts (slug, title, content, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('ld-self-reference', '结构化数据里的自指：一个没人发现的 url 循环', '## 结论

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

```json
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
', 'log', 'isPartOf 的 url 填成了文章自己，8 篇系列文全中。这类错能打开、返回 200、工具不报警，只有写断言才抓得到。',
        '', 0, 0, 0, 1, '2026-11-21 01:00:00', datetime('now'), datetime('now'));
INSERT INTO tags (name) VALUES ('seo') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'ld-self-reference' AND t.name = 'seo';
INSERT INTO tags (name) VALUES ('http') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'ld-self-reference' AND t.name = 'http';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'ld-self-reference' AND t.name = 'debugging';
