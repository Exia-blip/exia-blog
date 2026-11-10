-- 小工具：自研 Markdown 渲染器的实时预览与 XSS 关
-- 由 scripts/gen-editor-markdown-xss.mjs 生成，重跑会覆盖正文

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES ('editor-markdown-xss', '实时预览敢让你敲 <script>：自研 Markdown 渲染器的「先转义后拼装」', '## 结论

编辑器系列第二篇（[停手三秒就自动存了](/p/editor-autosave)）讲的是内容怎么不丢，这篇讲另一半：左边敲 Markdown 右边秒出预览，以及这个渲染器凭什么敢直接处理我随手敲进去的 `<script>`。

答案压成一句话：**安全性不靠过滤黑名单，靠一个顺序**——先把行内码抠成占位符，再把整行转义成 HTML 实体，然后在"一个裸尖括号都不剩"的文本上拼装标签，最后把行内码塞回去时再转义一次。顺序反了、或者干脆放行原始 HTML，就是绝大多数 Markdown 注入事故的根源。

`public/md.js` 三百六十九行，零依赖，其中一半是内置语法高亮。它同时被 Worker 和浏览器 `import`——**预览和发布不是两份实现，是同一份文件**。所以这篇里贴的每一个输出，都是 `node scripts/probe-md.mjs` 现场跑出来的，不是"应该会"。

## 为什么不用 marked 或 markdown-it

两个理由，第二个是真理由。

1. **要同构**。预览在浏览器里跑，发布在 Worker 里跑，两边必须逐字节一致。第三方渲染器为了兼顾 CommonMark 边角，往往要拼装 DOM 或拖半套 parser 配置，同构起来要写一层适配。我这 369 行里没有任何一行碰 `document`、`window`、`Buffer`，`import` 到哪里都能跑。

2. **通用渲染器的默认行为和我想要的正好相反**。CommonMark 语义里，Markdown 里嵌原始 HTML 是合法特性——`<img src=x onerror=alert(1)>` 写进正文，按规范就该渲染成可执行标签。文档站里这是 feature，但把它用在"处理任意输入"的编辑器预览里，就必须再配一层 sanitize 或 DOMPurify：**正确的用法 = 渲染器 + 消毒器，两个依赖**。

自研版的失败面是反的：我的渲染器根本不认识"原始 HTML"这个概念，所有字符先过 `esc()`，`<img>` 只会变成字面文本 `&lt;img&gt;`。最坏情况是"该有的效果没出来"（功能缺陷），而不是"不该执行的东西执行了"（安全缺陷）。**用功能缺陷换执行面清零，这笔交易在单作者博客上是赚的。**

## 四步管线，顺序就是全部

`inline()` 是行内渲染的全部，去掉注释剩十几行：

```js
function inline(line) {
  const codes = [];
  // ① 行内码先抠出来，换成占位符，防止里面的内容被后面的规则二次改写
  let s = String(line).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000IC${codes.length - 1}\u0000`;
  });

  // ② 整行转义：此刻 < > & " '' 全部变成实体
  s = esc(s);

  // ③ 在"只剩实体"的文本上拼标签
  s = s.replace(IMG_RE, (_, alt, src, title) => `<img src="${safeUrl(src,''img'')}" alt="${alt}"...>`);
  s = s.replace(LINK_RE, (_, text, href, title) => `<a href="${safeUrl(href,''link'')}"...>${text}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, ''<strong>$1</strong>'');
  // …斜体、删除线同一个套路

  // ④ 还原行内码，注意这里又 esc 了一次
  s = s.replace(/\u0000IC(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}
```

四个设计点，每一个都是被具体的坑逼出来的：

**一、行内码必须最先抠走。** 否则行内码里的 `<b>` 会先被转义成 `&lt;b&gt;`，再被还原进 `<code>` 时已经不是原文了——读者看到的不是他敲的东西。占位符用 `\u0000`（NUL）包着，因为正文里打出 NUL 的概率严格为零，而用 `%%%` 这种可打印哨兵就会撞车（下面有反例）。

**二、转义在拼装之前，没有例外。** 跑到第 ③ 步时，文本里不存在裸的 `<` 和 `"`，后续所有尖括号都来自我自己写的模板字符串，输入内容**物理上不可能**再构成新标签或属性。这是整篇文章唯一需要记住的一句话。

**三、正因为文本已经转义了，语法解析必须适配实体。** 链接的 title 语法在源码里长这样：

```js
const URL_PART = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
const LINK_RE = new RegExp(String.raw`\[([^\]]+)\]\((${URL_PART})(?:\s+&quot;([^&]*)&quot;)?\)`, ''g'');
```

注意 `&quot;` ——标准 Markdown 里这里写的是 `"`。因为正则跑在**已经转义过**的字符串上，引号早就是实体了。高亮器里同理，匹配 HTML 注释的规则写的是 `&lt;!--[\s\S]*?--&gt;`。

**四、还原行内码时二次转义。** 抠出来的是原文，塞回去要再过一次 `esc()`。看起来多余（第 ② 步不是整行转义过了吗），其实那一行转义时这段内容根本不在字符串里——它在 `codes` 数组里躲着。忘了这一步，行内码就是唯一的注入通道。

## 真实输出

`node scripts/probe-md.mjs` 会逐条打印输入和原样输出，27 条探针，下面挑 12 条（v22.22.2，改动前后都跑过）：

| 输入 | 输出（原样，长行截断） | 结论 |
|---|---|---|
| `<img src=x onerror=alert(1)>` | `<p>&lt;img src=x onerror=alert(1)&gt;</p>` | 转义 ✅ |
| `# <img src=x onerror=alert(4)>标题` | `<h1 id="img-src-x-onerror-alert-4-标题">&lt;img …&gt;标题</h1>` | 转义，锚点保留中文 ✅ |
| `<script>alert(5)</script>`（行内码） | `<code>&lt;script&gt;alert(5)&lt;/script&gt;</code>` | 转义 ✅ |
| 围栏代码块（语言标 `html`）里放 `<script>` | `<code class="language-html">&lt;script&gt;<span class="tok-f">alert</span>(…)` | 转义 + 高亮 ✅ |
| `[z](javascript:alert(1))` | `<a href="#" …>z</a>` | 中和 ✅ |
| `[v](JaVaScRiPt:alert(3))` | `<a href="#" …>v</a>` | 大小写不救场 ✅ |
| `[k]( javascript:alert(1))` | `<p>[k]( javascript:alert(1))</p>` | 压根没成链接 ✅ |
| `[d](data:text/html;base64,…)` | `<a href="#" …>d</a>` | 中和 ✅ |
| `[s](data:image/svg+xml;base64,…)` | `<a href="#" …>s</a>` | 中和 ✅（**改之前是原样 href，见下节**） |
| `![" onmouseover="alert(1)](http://a.b/c.png)` | `<img src="http://a.b/c.png" alt="&quot; onmouseover=&quot;alert(1)" loading="lazy">` | 关进属性值 ✅ |
| `[t](https://a.b/c"onclick="alert(1))` | `<a href="https://a.b/c&quot;onclick=&quot;alert(1)" …>t</a>` | 引号已死 ✅ |
| 表格单元格写 `<img src=x onerror=7>` | `<td>&lt;img src=x onerror=7&gt;</td>` | 转义 ✅ |

`[k]( javascript:alert(1))` 那一行值得多说：它之所以安全，不是因为识别出了伪装，而是因为 `URL_PART` 里 `[^()\s]` **根本不允许 URL 以空白开头**——它压根没被当成链接，退化成纯文本。这类"没被识破，只是没被匹配"的路径是 fail-closed 的：失败的方向在安全侧。

## 那条"看着吓人"的输出

`alt` 那条探针的输出里赫然有 `onmouseover=` 字样，拿扫描器跑一下大概率会报红。但完整输出是：

```html
<img src="http://a.b/c.png" alt="&quot; onmouseover=&quot;alert(1)" loading="lazy" decoding="async">
```

`alt` 的定界引号是模板里的裸引号，而攻击者想用来闭合它的那个 `"`，在第 ② 步已经被转成 `&quot;`。解析器读到的 `alt` 值就是字面文本 `" onmouseover="alert(1)`，后面没有能提前闭合属性的裸引号，`loading`、`decoding` 老老实实待在模板安排的位置。

**判断标准不是"输出里有没有危险字样"，而是"危险字样有没有拿到属性解析器认可的、裸的引号配对"。** 用 grep 找 `onerror` 会得到一堆假阳性，用浏览器打开看会不会弹窗才是真的——这也是我把探针写成可执行脚本而不是一张手抄表的原因。

## 写这篇时发现的两个问题

对代码写文章有个副作用：你会看见平时滑过去的东西。

**一、`data:` 对链接也放行了。** 原来的白名单只有一份，图片和链接共用：

```js
const SAFE_URL = /^(https?:\/\/|\/|mailto:|data:image\/|\.{0,2}\/)/i;   // 图片、链接共用
```

`data:image/` 是给图片留的（`<img>` 里的 SVG 不执行脚本），但同一个正则也守着 `href`，于是 `[s](data:image/svg+xml;base64,...)` 拿到的是一个能点的 `data:` 链接。现代浏览器禁止顶层导航到 `data:`，实际影响是 self-XSS 级别，但"一个白名单伺候两种上下文"本身就是错的。拆成两份：

```js
const SAFE_LINK = /^(https?:\/\/|\/|mailto:|\.{0,2}\/)/i;                 // 链接：不给 data:
const SAFE_IMG  = /^(https?:\/\/|\/|data:image\/|\.{0,2}\/)/i;            // 图片：给
function safeUrl(u, kind = ''link'') {
  const s = String(u || '''').trim();
  return (kind === ''img'' ? SAFE_IMG : SAFE_LINK).test(s) ? s : ''#'';
}
```

**二、裸链接把句号吃进了 href。** `看 https://example.com/a. 结束` 原来渲染成 `href="https://example.com/a."`，点进去 404。修法是把尾部标点剥出来放到标签外面：

```js
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (_, p, u) => {
    const trail = (u.match(/[.,;:!?]+$/) || [''''])[0];
    const href = trail ? u.slice(0, -trail.length) : u;
    return `${p}<a href="${href}" target="_blank" rel="noopener nofollow">${href}</a>${trail}`;
  });
```

两条都补了断言，现在回归是 13 条。

## 三个还在的缺陷，明说

不写"应该可以"，也不写"没有缺点"。

1. **同名标题的锚点会撞。** `# 标题A` 出现两次，两次都输出 `id="标题a"`，目录跳转只会到第一个。修法是加一个已用 id 的 Set 去重（`标题a-2`），我没做——站内还没有需要页内跳转的长文，等真有了再补。
2. **表格的 `:--` 左对齐不认。** `:-:` 居中、`-:` 右对齐都认，`:-` 左对齐落到"无 style"。因为左对齐本来就是 `<td>` 的默认值，实际渲染没有区别，属于语法支持不全但不影响效果。
3. **NUL 占位符可伪造。** 围栏代码块在块解析阶段被换成 `\u0000CB0\u0000` 单独占一行，如果你能在正文里真的写入一个 NUL 字符，那一行会命中占位正则，把 `blocks[0]` 再插一遍。实测（探针最后一条）确实会出现两个相同代码块。危害上限是"重复显示自己的代码块"——`blocks` 数组里只有渲染器自己生成的东西，注入不了任意 HTML。浏览器 textarea 也基本拿不到裸 NUL，所以留着。

还有一个行为得说清楚：**未闭合的围栏不吞正文**。开头三个反引号加 `js` 之后没有闭合标记，这一行不会被当成代码块——它连反引号一起落进段落（中间用 `<br>` 断行），后面的正文照常渲染。难看，但不丢内容、不注入。宁可丑也不静默吞掉后半篇。

## 一个真历史 bug：`#tag` 链进了 `alt`

这段是当初踩的，也是现在第一条断言。正文里的 `#标签` 会被转成 `<a href="/tag/...">`，最早的实现是拿正则直接对**整个 HTML** 扫一遍：

```js
html.replace(/(^|\s)#(\S+)/g, …)      // ✗ 会把 <a> 插进 alt="..." 里面
```

于是 `![ #tag ](a.png)` 渲染出的 `alt` 里嵌了一个 `<a>`，DOM 畸形，`alt` 属性被撕开。修法是不在整个 HTML 上扫，而是按标签切开，只在**元素之间的文本**里替换：

```js
const TAG_SPLIT = /<[^>]*>/g;
function linkTags(html) {
  // 逐段处理标签之间的文本，遇到 <pre> / <code> / <a> 进来的就跳过
  let skip = 0;
  for (const m of html.matchAll(TAG_SPLIT)) { /* … */ }
}
```

`skip` 计数器同时解决了第二个问题：代码块里的 `#xxx` 不该变成标签链接。这个 bug 教会我的事比任何文档都直接——**HTML 是树，不是字符串**。凡是"对整个 HTML 跑正则"的写法，最后都会在某条属性里翻车。

## 怎么测

两个脚本，各管一件事：

```js
// scripts/test-md.mjs —— 13 条断言，进 npm test，CI 里跑
t(''原始 HTML 不执行：标签一律转义成文本'', () => {
  const out = renderBody(''正文 <img src=x onerror=alert(1)> 结束'');
  assert.ok(!out.includes(''<img src=x''), out);
  assert.ok(out.includes(''&lt;img src=x onerror=alert(1)&gt;''), out);
});
```

```bash
# scripts/probe-md.mjs —— 27 条探针，只打印不判定，改渲染器前后各跑一次对比
node scripts/probe-md.mjs
```

职责分开是有意的：断言固定"已经想清楚的行为"，探针暴露"我还没想清楚的输出"。每发现一条新的绕过手法，先把它加成断言，再修代码——顺序反了就会出现"修完忘了测"，下次重构又漏回去。

当前状态：`13/13 passed`（md）+ `6/6`（邮箱混淆）+ `9/9`（评论限额），`npm test` 全绿才发布。

## 下一篇

回到图片：拖拽上传到 R2 的链路——上传拿直链还是走 Worker 代理、`image/svg+xml` 要不要放行（这里正好有个安全决策要做）、以及浏览器端转 WebP 为什么设了"省不到 8% 就不换格式"的门槛（见 [这一篇](/p/editor-autosave) 里 `toWebp()` 那段的注释）。

#markdown #javascript #xss
', '', 'tools', '', 0,
        0, 0, '自研渲染器敢不引 sanitize 库，靠的是抠码→转义→拼装这个顺序。27 条探针的真实输出、两个被这篇文章逼出来的 bug、三个明说的缺陷，外加一个当年把 <a> 插进 alt 的历史事故。', 'manual', '', 1,
        '2026-11-10 16:20:00', '2026-11-10 16:20:00', '2026-11-10 16:20:00')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('markdown');
INSERT OR IGNORE INTO tags (name) VALUES ('javascript');
INSERT OR IGNORE INTO tags (name) VALUES ('xss');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'editor-markdown-xss');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('markdown', 'javascript', 'xss') WHERE p.slug = 'editor-markdown-xss';
