## 结论

阅读器里那张封面卡片，读的是 `<enclosure>`，不是正文里的第一张图。正文图写在 `content:encoded` 的 CDATA 里，Feedly、Inoreader 这类 reader 只把它当文章内容，不拿它当卡片封面。想让订阅流里出现缩略图，必须在 `<item>` 里显式输出一个 `<enclosure url="..." length="0" type="..."/>`。

我给 `exia.de5.net/rss.xml` 加完之后实测：17 个 `<item>`、14 个 enclosure，3 篇没有封面。没有封面的那三篇不是漏了，是主动跳过的——它们数据库里的 `cover` 和 `cover_body` 两列都是空串，`coverOf()` 会一路退到 `/thumbs/auto-N.jpg` 通用预设图。站里一共六张这种图，按文章 id 轮换。给这种图输出 enclosure，订阅流里会反复出现几张抽象图，读者分辨不出是哪篇，比没有卡片更糟。

取值走 `coverOf()`：手动填的 `cover` → 正文首图 `cover_body` → 预设图。不用 `thumbOf()`，那是 208×136 的列表缩略图，`cover.js` 里的注释明确写了「og:image / RSS 别用这个」。type 按真实后缀从映射表里查，站里封面大多是 `/cards/*.png`，所以线上 14 个全是 `image/png`——写死 `image/webp` 是错的。

加完前后的差别可以量化。同一份 feed，加之前 enclosure 数量 0；加之后 14，覆盖率 14/17 = 82%。剩下 18% 是主动放弃的预设图文章，不是遗漏。样例图片 `/cards/comment-anti-spam.png` 实测 `200 image/png 36.7KB`（Content-Length 36722 字节），同源绝对地址，浏览器和阅读器都能直接取。

`length="0"` 不是偷懒。R2 在渲染这一层不回传文件大小，硬填一个数字就是编数据；0 是 RSS 2.0 允许的占位，主流阅读器都认。

这套规范我后来锁进了项目的 `MEMORY.md`，写明禁止回退成缩略图版本。原因是初版实现里踩了三个想当然的坑：

| 初版的"以为" | 实际 |
|---|---|
| 站里有 `/img/u/thumbs/` 这条路径 | 没有。用户上传图的封面字段直接是 `/img/u/xxx.jpg`，没有任何 thumb 中间层 |
| 有个 `getThumbUrl()` 可以调 | 没有这个函数。封面取值只有 `coverOf()` / `thumbOf()` / `autoCover()` / `autoThumb()` |
| type 写死 `image/webp` | 站里 `/cards/*.png` 是 PNG，写死会让 reader 按错 MIME 解析 |

三个都是"看起来应该存在"的东西。我当时是照着另一套图床的经验写的代码，没先查这个站的真实路径。后来把 `src/cover.js` 从头读了一遍才发现——**站在自己项目里写功能，也可以因为照搬外部经验而写错**。这篇就是把这几个"以为"和它们错在哪儿留下来。

## 一、阅读器卡片读的是 enclosure，不是正文首图

加到 RSS 里之前，我的订阅流长这样：标题、摘要、作者、时间，左边一块空白。正文里其实有图——每篇文章都有标题卡，`/cards/` 下的 PNG，1200×630。我用浏览器打开 feed 的 XML，`content:encoded` 的 CDATA 里清清楚楚躺着 `<img src="/cards/...">`。

问题就在这儿：那张 `<img>` 在 CDATA 里。

CDATA 的作用是告诉 XML 解析器「这一段是纯文本，别当标记处理」。reader 拿到 `content:encoded` 后，会把它当 HTML 正文渲染，但**封面抽取走的是另一条路径**——它看 `<item>` 下有没有 `<enclosure>` 元素。这是 RSS 2.0 从播客时代留下来的约定： enclosure 原本表示「附件，通常是音视频」，阅读器后来约定俗成拿第一个图片类型的 enclosure 当封面。

所以正文里有多少张图都不影响卡片。feed 里没有 enclosure，卡片位就是空的。

加上之后的线上实测：

```text
item: 17 | enclosure: 14 | 无封面: 3
MIME 分布: {"image/png":14}
length 值: 0
样例: https://exia.de5.net/cards/comment-anti-spam.png
```

14 个 enclosure 全部指向 `/cards/*.png`，同源绝对地址。这是我在意的另一点：CDATA 里的正文图写的是相对路径 `/cards/xxx.png`，阅读器解析时基准 URL 未必是站点根；enclosure 这里用 `new URL(raw, origin)` 转成了绝对地址，不会有相对路径解析错位的隐患。

那 3 篇没有 enclosure 的，是主动跳过的：

| slug | 实际封面 | 为什么跳过 |
|---|---|---|
| `worker-render-549-to-96` | `cover=""` `cover_body=""` → `/thumbs/auto-N.jpg` | `isAutoCover()` 判真 |
| `cls-empty-slots` | `cover=""` `cover_body=""` → `/thumbs/auto-N.jpg` | `isAutoCover()` 判真 |
| `sticky-toc-grid-align-items` | `cover=""` `cover_body=""` → `/thumbs/auto-N.jpg` | `isAutoCover()` 判真 |

这三个不是数据缺失，是走到三层兜底末端后的正常结果。预设大图实测 30607~32549 字节，缩略版 WebP 只有 684~928 字节——同一张图的两种尺寸，分别给 og:image 和列表用。`autoCover()` 读 `post.id` 做模（`id % 6 + 1`），没有 id 的草稿才退回 slug 的 FNV-1a 哈希，保证同一篇每次都是同一张。

给它们输出 enclosure，订阅流里就会反复出现这六张抽象图——读者分辨不出是哪篇，等于没有封面。宁可空着。

## 二、为什么用 coverOf 不用 thumbOf

初版我差点写成 `thumbOf()`。名字看起来最贴切：thumbnail，缩略图，卡片不就是缩略图吗。

看一眼 `cover.js` 的注释就该停手：

```js
/**
 * 列表缩略图（208×136 的框）。
 * 预设图有专门的 416px WebP，一张 1.5KB；文章自带图没有多尺寸可挑，只能照原样。
 * og:image / RSS 别用这个 —— 那边要 1200×784 的 JPG。
 */
export function thumbOf(post) { ... }
```

208×136 是首页文章列表那个小方框的尺寸。阅读器卡片通常是 1200×784 这个量级的展示区域，用 208px 的图拉大到卡片尺寸，糊得没法看。注释里那句「RSS 别用这个」是前人（也就是之前的我）留下的，这次差点没看见。

还有一层更隐蔽的问题。`thumbOf()` 遇到自动生成的标题卡会**退回预设图**：

```js
if (isCardCover(post)) return autoThumb(post);
```

标题卡是 1200×630 的分享图，塞进 108×78 的方框只会露出半截字，所以列表里不用它。但站里有专属封面的文章，`/cards/*.png` 恰恰就是这种标题卡。结果用 `thumbOf()` 的话，这些文章在 RSS 里反而全部拿到通用预设图——**功能看起来是好的，enclosure 有、URL 对、MIME 也对，只是每张卡片都长一样**。这类 bug 不会报错，只能靠"打开订阅流看一眼"发现。

正确取值是 `coverOf()`：

```js
export function coverOf(post) {
  const own = usableCover(post?.cover);
  if (own) return own;
  return bodyCoverOf(post) || autoCover(post);
}
```

三级优先级：手动填的 `cover` → 正文首图 `cover_body` → 预设图。`usableCover()` 还会挡掉 `.svg`，防的是 SVG 冒充图片那一类问题——`viewBox` 拉伸变形，og:image 有一半平台直接不渲染。这条规则对后台手填的 cover 同样成立，否则显式填一个 `.svg` 就绕过去了。

第三级预设图在 RSS 里被 `isAutoCover()` 拦掉，所以真正进 enclosure 的只有前两级。这个判断要在 `coverOf()` **之前**做——`coverOf()` 永远返回非空（预设图兜底），等它返回了再判断就来不及了。

## 三、MIME 按后缀给，不写死 webp

初版的第二个想当然：type 写死 `image/webp`。

理由当时想得很顺——站里图片链路大量用 WebP，预设图就是 WebP。但真实 feed 打脸：14 个 enclosure 的 URL 全是 `/cards/*.png`，`type` 必须写 `image/png`。写死 webp 的话，reader 按错误的 MIME 去解析一张 PNG，部分客户端直接不显示卡片——又是那种"feed 合法、XML 解析过、就是不显示"的静默故障。

现在的实现是一张映射表：

```js
const RSS_IMG_TYPES = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', avif: 'image/avif', gif: 'image/gif',
};
```

取后缀的过程只有一行，但有两个细节：

```js
const ext = (u.pathname.split('.').pop() || '').toLowerCase();
const type = RSS_IMG_TYPES[ext];
if (!type) return '';
```

**用 `pathname` 不用完整 URL**：查询串里的点不能算后缀。`/img/a.png?v=2.1` 用 `split('.')` 切整条 URL 会拿到 `1`，取 `pathname` 才是 `png`。

**`toLowerCase()` 归一**：`.PNG` 是大写也照认。

**查不到就跳过**：映射表是白名单，不是给个默认值。碰到一个 `.bmp` 或者压根没后缀的 URL，宁可不输出 enclosure，也不能瞎写一个 `image/png` 让 reader 去解析。这和图片代理那边的 MIME 白名单是同一套思路——**输出侧声明的类型必须和真实内容一致，猜错比不声明更糟**。

正文首图 `cover_body` 也走同一张表。单测里专门有一条：

```js
t('正文首图（cover_body）也进 enclosure', () => {
  const x = item({ post: { ...post, cover_body: '/img/u/demo.jpg' } });
  assert.match(x, /type="image\/jpeg"/);
});
```

`jpg` 映射到 `image/jpeg` 而不是 `image/jpg`——后者不是合法 MIME。这种细节写错了 XML 校验器不会报，只有 reader 自己知道。

## 四、四条跳过规则

`rssEnclosure()` 核心就这么几行，四条跳过规则全在里面：

```js
export function rssEnclosure(post, origin) {
  if (isAutoCover(post)) return '';
  const raw = coverOf(post);
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw, origin);
  } catch {
    return '';
  }
  if (u.origin !== new URL(origin).origin) return '';
  const ext = (u.pathname.split('.').pop() || '').toLowerCase();
  const type = RSS_IMG_TYPES[ext];
  if (!type) return '';
  return `      <enclosure url="${esc(u.href)}" length="0" type="${type}"/>`;
}
```

| 规则 | 代码 | 为什么 |
|---|---|---|
| 预设图 | `isAutoCover(post)` | 六张通用图轮换，输出了全站卡片一样 |
| 取不到封面 | `if (!raw) return ''` | 不输出空标签 |
| 跨源外链 | `u.origin !== new URL(origin).origin` | 外链图会泄漏订阅者的 IP 给第三方，防盗链也随时会失效 |
| 未知后缀 | `if (!type) return ''` | 声明错误的 MIME 比不声明更糟 |

`new URL()` 外面那层 `try/catch` 算半个第五条。封面是用户可以填的字段，填了 `http://[` 这种残缺 URL，`new URL` 会抛；feed 是整份生成的，一个 item 抛异常会拖垮整个 `/rss.xml`。兜回空字符串，最坏就是这篇没卡片。

跨源这条要留意顺序：`new URL(raw, origin)` 的第二个参数让相对路径能解析成绝对地址，同时外链原始地址也能解析。两者都解析成 URL 对象之后比 `origin`，同源的相对路径通过，外链被挡。倒过来先比字符串就麻烦了——`/cards/a.png` 和 `https://exia.de5.net/cards/a.png` 是同一张图，字符串比对会误杀前者。

"不输出空标签"这件事值得多说一句。`<enclosure url="" length="0" type="image/png"/>` 语法上合法，但 reader 会拿空 URL 去请求，结果是卡片位上一个破图图标。空图标记比空白占位更刺眼，而且会让人以为是站点挂了。所以四条规则全部返回同一个东西：空字符串，连元素都不生成。

## 五、XML 转义与条目位置

第三个想当然：URL 直接拼进属性。

封面 URL 里有 `&` 的时候，比如 `/cards/a&b.png`，直接拼出来的 `<enclosure url="...a&b.png">` 会让 XML 解析器把 `&b` 当实体引用的开头，整份 feed 变成非法 XML。浏览器打开还看得见内容，reader 会静默丢掉整份订阅——这是最难排查的一类故障。

现在所有属性值都过 `esc()`：

```js
t('封面 URL 里的 & 转义，不破坏 XML', () => {
  const x = covered({ cover: '/cards/a&b.png' });
  assert.match(x, /<enclosure url="https:\/\/exia\.de5\.net\/cards\/a&amp;b\.png"/);
  assert.doesNotMatch(x, /url="[^"]*&(?!amp;)/);
});
```

`esc()` 是我自己写的五个字符替换，不是什么库：

```js
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ESC[c]);
```

`&` 放在第一个处理是对的——如果先替换 `<` 再替换 `&`，`&lt;` 里的 `&` 会被二次转义成 `&amp;lt;`，reader 显示出来的就是字面量 `&lt;`。这里用一次 `replace` 加查表，每个原字符只走一遍，不会二次转义。

单测里还有一条整体检查，把 `&amp;`、`&lt;`、`&gt;`、`&quot;`、`&apos;` 之外的裸 `&` 全找出来，一处都不许有。这条比逐字段断言管用——以后加新字段忘了转义，它会自动响：

```js
t('整份 feed 的 & 全部是实体，没有裸的 &', () => {
  const x = doc({ site: { name: 'A&B', ... }, items: item({ author: 'A&B' }) });
  const bad = [...x.matchAll(/&(?!amp;|lt;|gt;|quot;|apos;)/g)];
  assert.equal(bad.length, 0, `出现 ${bad.length} 处裸 &`);
});
```

CDATA 里那块正文是另一个转义战场。`content:encoded` 用 `<![CDATA[ ... ]]>` 包着渲染后的 HTML，正文里的 `<p>`、`<img>` 原样进去，不用转成实体。唯一的例外是 `]]>` 这个序列——它会出现在正文里（比如文章讲 XML 的时候引用了它），而它恰好是 CDATA 的结束标记。处理办法是拆开：

```js
const safe = String(html ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>');
```

拆成两段 CDATA，中间那截 `]]>` 由后一段开头补上，reader 还原后正文一个字不差。这段逻辑放在 `rssItem()` 里，不指望调用方记得——它和 enclosure 的位置要求是同一类问题：都是"生成 XML 时的结构性约束"，散在调用方一定会漏。

条目位置也有讲究。`rssItem()` 里 enclosure 不是随手拼在 item 末尾，而是和 category 一起攒进 `extraXml`：

```js
const enclosure = rssEnclosure(post, origin);
const extraXml = [enclosure, catXml].filter(Boolean).join('\n');
```

放进模板的位置是 `content:encoded` 之后、`category` 之前：

```xml
<content:encoded><![CDATA[<p>正文</p>]]></content:encoded>
<enclosure url="https://exia.de5.net/cards/comment-anti-spam.png" length="0" type="image/png"/>
<category>小工具</category>
```

正文里的图还多了一步绝对化。`serveRss()` 把正文塞进 CDATA 之前，先过一遍正则：

```js
html: (p.html_content || sanitizeHtml(renderBody(p.content)))
  .replace(/(src|href)="\/(?!\/)/g, `$1="${origin}/`),
```

`src="/img/u/xxx.jpg"` 变成 `src="https://exia.de5.net/img/u/xxx.jpg"`，但 `src="//cdn.example.com/x.png"` 这种协议相对 URL 不动——负向前瞻 `(?!\/)` 专门挡它。原因和 enclosure 用绝对地址一样：reader 拿 feed 的时候没有"当前页面"这个上下文，相对路径会被解析到订阅器的域名上去。enclosure 是卡片上的图，正文图是文章里的图，两处都得转，只转一处的话读者会看到卡片正常、点进去正文里的图全裂。

这个细节是加 enclosure 之前就有的，但我是在写这篇的时候才注意到它和 enclosure 走的是同一个道理。两处代码离得远——一个在 `serveRss()` 的 map 里，一个在 `rssEnclosure()` 里——改一处很容易忘了另一处。所以验证清单里我加了"在点进去的正文里也看一眼图"，不只盯卡片。

CDATA 是 XML 解析器眼里的一整块文本。如果 enclosure 被塞进 CDATA 边界里（尤其是正文里出现 `]]>` 拆分的场景），它就不再是元素，reader 读不到。放在 CDATA 闭合之后是硬要求，不是排版偏好。单测有一条专门盯顺序：

```js
assert.ok(block.indexOf('<content:encoded>') < block.indexOf('<enclosure'));
assert.ok(block.indexOf('<enclosure') < block.indexOf('<category>'));
```

同时断言原有字段没被动过——`<dc:creator>`、`<category>` 都还在。加 enclosure 是往 item 里插一个元素，不是重写 item 的拼装逻辑。原来的 `<author>` + `<dc:creator>` 双署名（前者 RSS 2.0 原生，后者 Feedly 和 Inoreader 实际读的那个）、`<ttl>60</ttl>` 与 HTTP `max-age=600` 的对齐，都不受影响。

## 六、length=0 与只做 RSS 2.0 的取舍

RSS 2.0 的 enclosure 有三个必填属性：`url`、`length`、`type`。`length` 的语义是资源的字节数。

我填了 0。原因是这条链路拿不到真实大小：图片存在 R2，渲染 feed 的这一步只有 URL 字符串，没有去做一次 HEAD 请求问 Content-Length，也不打算为这个再打一次 R2。为每张封面在生成 feed 时多发一次网络往返，换一个阅读器根本不看的数字，不划算。

填 0 是规范允许的占位值，主流 reader 都认。反过来，硬猜一个数字是危险的——部分 reader 会按 `length` 截断下载，猜小了图片显示半截，猜大了可能一直等不到结束。站里原本就有 `length="0"` 的先例可循，这次照做。

feed 本身的缓存也和 enclosure 的更新速度有关。站点给 `/rss.xml` 发的响应头是：

```text
Content-Type: application/rss+xml; charset=utf-8
Cache-Control: public, max-age=600, stale-while-revalidate=3600
```

浏览器和中间缓存 10 分钟过期，边缘还能在后台刷新时先吐旧的两小时。频道里写的 `<ttl>60</ttl>` 单位是分钟，和 `max-age=600` 是对齐的——阅读器按 ttl 每小时来一次，正好不会每次都撞上还没过期的旧 feed。这两个数字一个在 XML 里、一个在 HTTP 头里，改一个忘了另一个，表现就是"我明明发了新文章，订阅流里还是旧的"。加 enclosure 的时候没动这两个值，但顺手核了一遍。

`lastBuildDate` 还有个坑值得记一下：它取的是返回结果里最近一次的 `updated_at`，但预排文章的 `updated_at` 可能是未来时间。上面虽然有 `liveSql()` 把正文挡住了，`MAX(updated_at)` 单独取仍然会顶到未来。聚合器见到未来的日期会认为这份 feed 异常——我实测撞到过一次，当天是 11-12，feed 里却写着 `Wed, 18 Nov 2026`。现在的实现把它夹到「现在」以内。这类问题属于"feed 结构正确但阅读器就是不刷新"，和 enclosure 缺失是同一类静默故障。

范围上只做了 RSS 2.0。站点只产出 `/rss.xml`，没有 `/atom.xml`。Atom 的封面对应 `<link rel="enclosure" href="..." type="..." length="..."/>`，语义不同、元素名不同，虽然 reader 两边都读，但为一个没有 feed 的格式写输出没有意义。等真有 Atom 需求再说——这也是项目里一贯的取舍：**先做实际在跑的那条路径，别为假想需求铺摊子**。

同样的道理，没有为 enclosure 单独加一条 D1 查询。`serveRss()` 原来的 SELECT 已经取了 `cover` 和 `cover_body`，标签也由 `attachTags()` 一次带出来。enclosure 需要的字段全在手里，加一行纯函数调用就能生成，没必要为了它多打一次库。Worker 环境的 D1 subrequest 是稀缺资源——50 次上限，文章页已经用掉 5 次，feed 这边省下来的余量留给真正需要的地方。

`rssEnclosure()` 抽成纯函数也是为了省事。源码里的注释写得很直白："抽成纯函数是为了能单测 —— 埋在 `serveRss` 里就只能起 miniflare 才能验。"要验的东西很纯：给一个 post 对象和一个 origin，吐一段 XML 字符串或者空串。没有数据库、没有 fetch、没有环境变量。直接 import 进 Node 脚本就能跑，20 条断言秒级完成。

对比一下另一条路：把 enclosure 拼装写在 `serveRss()` 的 map 回调里，要验它就得起一个 Worker 实例、塞一条假的 D1 记录、发一次真实请求、再从响应里正则提取。跑一轮几秒钟，还没法方便地构造"封面带 `&`"这种刁钻输入。纯函数的代价只是多一个参数（origin 要显式传进来），换来的是全部边界情况都能在两行代码里构造出来。

这条经验和上一篇写相关推荐时踩的坑凑成了一对：那次是纯函数写对了、调用方传值时机错了，单测全绿线上却不对。这次是反过来——把逻辑留在纯函数里、让调用方只负责传参，调用方几乎不可能写错。两次的结论指向同一处：**边界画在哪里，比函数本身怎么写更影响出错概率**。

这套实现在 `MEMORY.md` 里锁了固定规范：`coverOf`、动态 MIME、`length="0"`，禁止回退为 `thumbOf` 版本。写下来不是为了好看。这类决策如果不留档，下次有人在别的地方看到 `thumbOf()` 觉得"缩略图更合适"，改一行代码就能把整套卡片悄悄弄坏——不报错、不报警，只有打开订阅流才看得出来。

## 怎么自己验一遍

先在浏览器里看结果，再看数据。

**1. 看订阅流**（最直观）：把 `https://exia.de5.net/rss.xml` 加进 Feedly 或 Inoreader，确认有专属封面的文章出卡片，预设图的文章空着。这一步能抓到"enclosure 有但每张图都一样"这类只在渲染层出现的问题。

**2. 数数量**（一行命令）：

```bash
curl -s 'https://exia.de5.net/rss.xml' | grep -o '<enclosure' | wc -l
```

对照 `<item>` 的数量。enclosure 数应该小于等于 item 数，差出来的是预设图文章。本站当前是 14 / 17。

**3. 验 MIME 和长度**（浏览器控制台或 Node）：

```js
const x = await (await fetch('/rss.xml')).text();
const enc = [...x.matchAll(/<enclosure url="([^"]+)" length="(\d+)" type="([^"]+)"/g)];
const ok = enc.every((m) =>
  m[1].startsWith(location.origin + '/') &&
  m[2] === '0' &&
  /^image\/(png|webp|jpeg|avif|gif)$/.test(m[3])
);
console.log(`${enc.length} 个 enclosure，全部合规：${ok}`);
```

**4. 验 XML 合法性**（防整份 feed 被丢）：

```bash
curl -s 'https://exia.de5.net/rss.xml' | node -e '
let x="";process.stdin.on("data",d=>x+=d).on("end",()=>{
  const bad=[...x.matchAll(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/g)];
  console.log(bad.length ? `非法实体 ${bad.length} 处` : "XML 实体合法");
  console.log("item / enclosure:",(x.match(/<item>/g)||[]).length,"/",(x.match(/<enclosure/g)||[]).length);
});'
```

这条不是走形式。XML 里一个没转义的 `&` 就能让整份 feed 变成非法文档，浏览器打开还能看见内容，reader 直接静默丢掉整份订阅——没有报错、没有通知，只有读者发现"最近怎么没更新了"。单测 20 条里专门留了一条扫全域裸 `&`，线上再扫一遍，是因为真实数据里作者名、标签、摘要都来自用户输入，单测的假数据覆盖不到。

**5. 跑单测和线上探针**：

```bash
node scripts/test-rss.mjs       # 20 条，其中 7 条覆盖 enclosure
npm run check:live              # 4 条 RSS 探针，全套 53 条
```

单测里那 7 条按这个顺序排：有封面输出、webp 类型、预设图不输出、正文首图进 enclosure、外链跳过、`&amp;` 转义、条目位置。第 8 条「整份 feed 无裸 `&`」是全局断言，顺带把 enclosure 也覆盖了。哪条挂了就直接定位到对应环节。

**6. 改了封面逻辑之后**，重跑一遍 `npm run backfill:html -- --all`。`cover_body` 是入库时存的正文首图快照，改了抽取规则就得重算存量，否则新规则和旧快照对不上。这条和 enclosure 没有直接调用关系，但同一个字段两处使用，容易漏。

线上探针 `check-live.mjs` 里那 4 条是另一回事，值得说说为什么这么设计：

| 探针 | 断言 | 防的是什么 |
|---|---|---|
| 数量 | enclosure > 0 | 整段逻辑被注释掉、或者 `isAutoCover()` 判反，全站一个都不出 |
| 同源绝对 | 全部以 `ORIGIN + '/'` 开头 | 有人把 `new URL(raw, origin)` 简化成直接拼 `raw`，相对路径漏进 feed |
| MIME | 全部匹配 `^image/(png\|webp\|jpeg\|avif\|gif)$` | 映射表被改坏、或者有人图省事写死一个类型 |
| 原字段 | `content:encoded` 和 `dc:creator` 都在 | 拼 `extraXml` 时把 item 模板重写，顺手弄丢了别的字段 |

四条里没有一条去验"某篇文章的卡片图是不是它自己的封面"。那种断言要写死 slug 和 URL，今天对了，明天发篇新文章、换张图就得改测试。探针盯的是**不变量**——不管发多少篇，enclosure 都得是同源绝对地址、类型都得是合法图片、原有字段都得在。具体哪篇配哪张图，交给单测的 7 条边界用例和订阅流里那一眼。

第 4 条最容易被当成多余的。`dc:creator` 和 enclosure 没有任何调用关系，为什么要一起验？因为 `extraXml` 的拼装改的是 item 模板，改模板的人未必意识到 `dc:creator` 也在同一个字符串里。这类"改 A 顺手弄坏 B"的回归，只有把 B 也写进断言才抓得到——和上一篇给相关推荐加"跨栏目同标签排第一"是同一套思路：**结构断言管不住业务语义，得挑一个只有正确实现才能满足的具体结果钉死**。

探针跑在真实线上 feed 上，带 `?cb=` 绕开缓存。这点也有讲究：不带 cache-busting 的话拿到的是边缘缓存的旧 feed，可能还是没加 enclosure 之前的版本，测试会在"功能明明坏了但探针全绿"的状态下骗过你。绕缓存的代价是每次都回源，但探针一天只跑几次，无所谓。

单测 20 条、线上探针 4 条、订阅流里亲眼一验，三层各有各的盲区。单测能构造 `&` 和外链这种刁钻输入，但验不了 D1 里真实字段拼出来的结果；探针跑的是真实 feed，但只看不变量；订阅流那一眼能发现"每张卡片都一样"这种语义错误，但没法自动跑。三层叠起来，才敢说这个 enclosure 是真的加好了。
