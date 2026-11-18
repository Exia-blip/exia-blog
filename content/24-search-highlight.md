## 结论

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
t('占位符数量与参数数量一致（COUNT 和列表共用 whereSql）', () => {
  const { sql, args } = searchMatch('d1');
  const holes = (sql.match(/\?/g) || []).length;
  assert.equal(holes, 3, `SQL 里有 ${holes} 个 ?`);
  assert.equal(args.length, holes, '参数数量与占位符不符');
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
  const s = String(text ?? '');
  const needle = String(q || '').trim();
  if (!needle) return esc(s);
  let re;
  try {
    re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch {
    return esc(s);
  }
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
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
  re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
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
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ESC[c]);
```

两个理由。一是**输入类型不同**：高亮的输入是纯文本（标题、摘要、标签名），不是 HTML。对它跑一个 HTML 解析器，等于先假设它是 HTML 再证明它不是，多绕一圈。二是**输出要可预测**：`esc()` 的行为就五个字符映射，一眼能看完；`sanitizeHtml` 会重排属性、丢掉不认识的标签，用在「把一个词包进 mark」这种场景上，结果会比输入更需要解释。

正确的关系是分层的：`sanitizeHtml` 管正文（那部分确实有 HTML），`esc()` 管所有拼进属性的纯文本。两者不互相替代——用 `sanitizeHtml` 处理标题既慢又可能改字，用 `esc()` 处理正文会漏掉标签。

## 五、三处调用与空结果出口

`hl()` 在三个地方被调用，都是搜索结果的可见部分：

```js
<h2>${hl(p.title, currentQ)}</h2>
${p.excerpt ? `<p class="excerpt">${hl(p.excerpt, currentQ)}</p>` : ''}
${(p.tags || []).slice(0, 3).map((t) => `<span class="tag">#${hl(t, currentQ)}</span>`).join('')}
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
  if (currentQ) u.set('q', currentQ);
  u.set('page', String(p));
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
const { posts, total, pages } = await api('/api/posts?' + params, { signal: mine.signal });
listEl.innerHTML = posts.map(card).join('');
```

所以高亮发生在浏览器里，`hl()` 是前端函数。服务端也有一份 `postCard`，用于首页和栏目页的 SSR，那份**不带高亮**——因为 SSR 的列表页不涉及搜索词，不需要。

这条分工带来一个好处：搜索是实时的，输入框 320ms 防抖，不用整页刷新。代价是高亮逻辑必须在客户端跑一遍，而且要考虑 `AbortController`——用户快速改词时，前一个请求的结果不能覆盖后一个。代码里用 `mine !== ctrl` 判断，过期的响应直接丢掉。

竞态这件事不处理会有很具体的症状：输入 `rus` 之后马上改成 `rust`，两个请求并发发出，如果 `rus` 的响应后到，列表里显示的是「rus 的结果」，而输入框里写着「rust」。用户看到的是「搜索不准」，实际上是响应顺序的问题。`AbortController` 在发新请求时 abort 旧的，再加上 `mine !== ctrl` 双重判断，两条防线。

### 客户端渲染带来的 SEO 代价

搜索结果是客户端渲染的，这意味着一件事：**爬虫抓这一页时，拿不到任何结果**。它看到的只有骨架屏。

所以搜索结果页直接标了 `noindex,follow`：

```js
const isSearch = !!(url && (url.searchParams.get('q') || '').trim());
// ...
isSearch ? `<meta name="robots" content="noindex,follow">` : '',
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
  '每个 <mark> 都正好是关键词，没有把整句圈进去');
```

第三条最有用。它防的是「正则写宽了，把整段文字包进 mark」——那种情况下高亮确实存在，但视觉上整段变色，等于没有高亮。这条断言要求每个 `<mark>` 的文本都必须包含关键词，写宽了当场失败。

空结果那一段也是三条：有结构化提示、提示里回显关键词、至少给两个出口链接。

## 六、边界：中文、空词、大小写、元字符

### 中文 LIKE 的实际行为

`LIKE '%缓存%'` 在 SQLite 里是字节级子串匹配，对中文没有分词——它能匹配「缓存」出现在任何位置，但匹配不了「缓存」的同义词。

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

`q` 为空时，`searchMatch` 根本不会被调用，SQL 里不会出现那三个 `?`。这比在 SQL 里写 `LIKE '%%'` 好——后者虽然也能返回全部，但它是一次全表扫描，而且 `COUNT` 也要跟着扫。

`searchMatch('')` 单独调用时不会抛错（参数退化成 `%%`），这是给单测留的容错，不是给调用方用的。线上路径上，空词压根到不了这一步。

### 元字符：后端不炸，前端靠兜底

`c++` 在后端是安全的：`LIKE '%c++%'` 里的 `+` 是字面量，不是量词。实测返回 0 篇，因为站内没有 `c++` 这个字符串，但不会报错。

真正会炸的是前端 `hl()`，前面已经讲过——`new RegExp('c++', 'gi')` 抛 `Nothing to repeat`。所以同一次搜索里，后端能正常返回结果，前端渲染时才可能挂。这类「后端绿、前端炸」的问题，光测接口发现不了，必须跑浏览器。

### 标签大小写归一

标签在入库时已经统一小写（seed 白名单里全是小写）。所以库里不会有 `Debugging` 和 `debugging` 两个标签。

但搜索时用户可能输入任何大小写。`LIKE` 对 ASCII 不区分大小写，所以 `Debugging` 能匹配到 `debugging` 标签。这算是免费得到的行为，但依赖数据库的 collation 默认值——如果哪天换成别的数据库，或者 `LIKE` 走了 `BINARY` collation，这个行为就没了。

单测第 6 项「中文关键词原样保留」防的是另一个方向：有人在传参时对中文做了 `encodeURIComponent` 或 `toLowerCase`，导致 `%缓存%` 变成 `%E7%BC%93%E5%AD%98%`，永远匹配不到。

### 搜索埋点：防抖会骗你

搜索是有埋点的（`window.__ev('search', q)`），但这条埋点写不写、怎么写，直接决定后台看到的数字有没有意义。

输入框是 320ms 防抖的。一个输入「rust」的人，会依次触发 `r`、`ru`、`rus`、`rust` 四次查询——如果每次都上报，后台记录的不是搜索意图，是打字速度。所以上报前加了两道：

```js
if (currentQ && page === 1 && currentQ !== lastQ) {
  lastQ = currentQ;
  if (window.__ev) window.__ev('search', currentQ);
}
```

只在第一页报（翻页不算新搜索）、同一个词只报一次（`lastQ` 比对）。服务端还有一层「同人同日同词」去重，两道一起才干净。

这件事和搜索质量的关系比看起来要紧：如果埋点记的是半截词，你按搜索词排序看热门查询，会得到一堆 `r`、`ru` 这样的碎片，然后误判「用户都在搜什么单词」。数据脏了，后面所有基于它的判断都是错的。

### 规模上限：`%词%` 走不了索引

三路条件全是 `LIKE '%词%'`，前置通配符意味着 B-tree 索引完全用不上，每次搜索都是全表扫描。

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
  --data-urlencode "q=debugging" --data "size=20" | grep -oE '"total":[0-9]+'

# 3) 大小写与中文边界
for q in DEBUGGING Debugging 缓存 d1; do
  printf "%-12s " "$q"
  curl -s -G "https://exia.de5.net/api/posts" --data-urlencode "q=$q" --data "size=20" \
    | head -c 200 | grep -oE '"total":[0-9]+'
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
