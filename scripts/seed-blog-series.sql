-- 自建博客实录：自建博客实录（1 篇）
-- 由 scripts/gen-blog-series.mjs 生成，重跑会覆盖正文与摘要

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES ('blog-markdown-xss', '自建博客实录 1/3：Markdown 渲染与白名单，怎么既放行代码块又不放行 XSS', '## 结论

Markdown 博客的 XSS 风险不在 Markdown 本身，在**你把渲染结果当 HTML 插进页面那一刻**。

我最后落地的方案是三道闸，顺序不能换：

1. **转义**：所有文本先过 `esc()`，把 `& < > " ''` 变成实体。这一步就杀掉了 90% 的注入，因为原始标签根本到不了 DOM。
2. **占位**：代码块在解析前整段摘出，用 `\u0000CB0\u0000` 这种不可能出现在正文里的占位符替换，最后再放回来。不放行代码块里的 `<script>` 就等于没有代码高亮，而先拼 HTML 再消毒会把示例代码吃掉。
3. **白名单**：渲染完的 HTML 再过一遍标签级过滤，这是给**历史数据和手改的库记录**兜底的，不是主防线。

写完这套跑了九个 payload，八个如预期，一个有真洞：`![ #tag ](/a.png)` 会把 `<a>` 注入到 `alt` 属性里。同一个渲染器里还有一处会把带括号的链接截断。两处都已经修掉——下面贴的是修之前的输出、修之后的代码，以及一个能重跑的回归脚本。

## 为什么没用现成的 sanitizer

`sanitize-html` / `DOMPurify` 都能用，在 Worker 里跑不动或不好跑：

- DOMPurify 依赖 DOM，Workers 没有 `document`，得挂 jsdom，包体积直接翻十倍。
- `sanitize-html` 是 Node 生态，几十个依赖，打进 Worker 影响冷启动。
- 这个站只用 `wrangler` 一个依赖，`package.json` 里 `devDependencies` 就一项。为了一个消毒函数引入一棵依赖树，不划算。

自己写白名单的前提是**先把渲染器写对**。渲染器只要有一处漏了转义，白名单就成了唯一防线，那时候一个正则漏洞就是真 XSS。

## 三道闸的实际代码

### 第一道：转义，放在所有替换之前

```js
const ESC = { ''&'': ''&amp;'', ''<'': ''&lt;'', ''>'': ''&gt;'', ''"'': ''&quot;'', "''": ''&#39;'' };
export const esc = (s = '''') => String(s).replace(/[&<>"'']/g, (c) => ESC[c]);

function inline(line) {
  // 先摘行内代码，否则 `**` 会进到 code 里被当成加粗
  const codes = [];
  let s = String(line).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000IC${codes.length - 1}\u0000`;
  });

  s = esc(s);                    // ← 转义在这里，后面所有替换都是在"已安全"的字符串上做

  s = s.replace(/\*\*([^*\n]+)\*\*/g, ''<strong>$1</strong>'');
  // …链接、图片、删除线
  return s;
}
```

顺序为什么必须是「先 esc 再拼标签」：esc 之后文本里的 `"` 已经变成 `&quot;`，所以后面写链接正则时**要匹配的是 `&quot;` 而不是 `"`**。这个细节第一次写的时候坑了我半小时——按普通 Markdown 正则写 `(?:\s+"([^"]*)")?`，标题永远匹配不上，因为源串里早就没有引号了。

```js
// 实际在用的样子：注意 &quot;
s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src, title) => {
  return `<img src="${safeUrl(src)}" alt="${alt}"${title ? ` title="${title}"` : ''''} loading="lazy" decoding="async">`;
});
```

### 第二道：代码块先摘出来

代码块里的 `<`、`*`、`#`、缩进全都是语义，不能过任何文本处理。所以渲染入口第一步就是把它换掉：

```js
export function renderMarkdown(src = '''') {
  const blocks = [];
  let text = String(src).replace(/\r\n?/g, ''\n'');

  // 三反引号写成 `{3}：直接写出来的话，这段示例自己就会把围栏提前闭合
  text = text.replace(/`{3}([\w+#.\-]*)[ \t]*\n([\s\S]*?)`{3}/g, (_, lang, code) => {
    const l = lang || ''text'';
    const body = highlight(code.replace(/\n$/, ''''), l);   // 高亮内部自己 esc，输出的是纯 span
    blocks.push(
      `<div class="code-wrap"><div class="code-head"><span>${esc(l)}</span>` +
      `<button class="copy-btn" data-copy>复制</button></div>` +
      `<pre class="code-block"><code class="language-${esc(l)}">${body}</code></pre></div>`
    );
    return `\n\u0000CB${blocks.length - 1}\u0000\n`;       // 占位符，不是 HTML
  });

  const lines = text.split(''\n'');
  // …逐行解析标题/列表/表格/引用，碰到 /^\u0000CB(\d+)\u0000$/ 就把 blocks[i] 放回来
}
```

两个必须这么做的理由：

- **不放行代码块，代码示例就没法写**。`<script>`、`<div>`、`&&` 这类内容在技术文里到处都是，全被吃掉的文章没用。
- **先拼 HTML 再消毒，会把示例代码一起剥掉**。白名单见到 `<code>` 里的 `<script>` 分不清这是"示例"还是"攻击"，一律删。所以示例里的尖括号必须是**已转义的实体**，而实体只能由高亮函数产生，不能被后置消毒碰到。

代码块的 `\u0000` 占位还有个副作用要认：正文里如果真出现 NUL 字符，占位会串。我的处理是写库前 `cleanMarkdown` 里清一遍控制字符，正文层不允许出现 NUL。

### 第三道：白名单

```js
const SAFE_URL = /^(https?:\/\/|\/|\.{0,2}\/|#|mailto:|data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,])/i;

const BAD_BLOCK = /<(script|style|iframe|object|embed|form|link|meta|base|svg|math|template|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const BAD_SELF  = /<(script|style|iframe|object|embed|form|link|meta|base|svg|math|template|noscript)\b[^>]*\/?>/gi;

function attrFilter(tag, name, value) {
  const lower = name.toLowerCase();
  if (lower.startsWith(''on'')) return null;                    // onerror / onclick / onload 全丢
  if (lower === ''style'') {
    // 只留表格对齐，其它一律丢：background:url(javascript:) 就是从这里进来的
    return /^\s*text-align\s*:\s*(left|center|right|justify)\s*;?\s*$/i.test(value || '''') ? value : null;
  }
  if (lower.startsWith(''data-'')) return lower === ''data-copy'' ? value : null;
  const ok = ATTR_COMMON.includes(lower) || (ATTR_BY_TAG[tag] || []).includes(lower);
  if (!ok) return null;
  if ((lower === ''href'' || lower === ''src'' || lower === ''poster'') && !SAFE_URL.test(String(value || '''').trim())) {
    return null;
  }
  return value;
}
```

三条设计取舍：

- **先整块删危险标签，再逐标签过滤**。顺序反了的话，`<svg><script>` 里的 `script` 被删掉、`svg` 留下来，结果是半个畸形标签。先按 `BAD_BLOCK` 整段删，再走标签正则。
- **`on*` 属性一律丢，不留例外**。这个站没有需要内联事件的场景，`data-copy` 用的是事件委托。
- **`style` 只放行 `text-align`**。白名单里保留 `style` 是最常见的自欺：只要给一个 `style`，`background:url(...)`、`position:fixed` 覆盖全站 UI 都进来了。

## 实测：九个 payload 的真实输出

`node` 里直接调 `sanitizeHtml(renderBody(p))`，输出逐条贴：

| 输入 | 输出 |
|---|---|
| `<script>alert(1)</script>` | `<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>` |
| `<img src=x onerror=alert(1)>` | `<p>&lt;img src=x onerror=alert(1)&gt;</p>` |
| `<a href="javascript:alert(1)">x</a>` | 整体转义，链接不成立 |
| `<div style="background:url(javascript:alert(1))">x</div>` | 整体转义 |
| `<svg><script>alert(1)</script></svg>` | 整体转义 |
| `[x](javascript:alert(1))` | `<a href="#">x</a>` ← 协议被拦成 `#`，括号不再漏到正文里 |
| `![x](data:image/svg+xml;base64,…)` | `<img src="data:image/svg+xml;base64,…">` ← 放行了，见下文 |
| `` `<img src=x onerror=alert(1)>` `` | `<code>&lt;img src=x onerror=alert(1)&gt;</code>` |
| 围栏代码块里放 `<script>alert(1)</script>` | 高亮成 `&lt;script&gt;…`，示例完整显示 |

前五条说明一件事：**渲染器的 esc 才是主防线，白名单压根没被触发**。原始 HTML 在 Markdown 里连标签都算不上，直接成了文本。这也是我不打算支持"正文内联 HTML"的原因——支持它等于主动放弃第一道闸。

## 三个真踩到的坑

### 1. 属性注入：`![ #tag ](/a.png)` 把标签塞进了 alt

站内有个功能是把正文里的 `#标签` 转成可点链接，这一步在渲染之后、消毒之前。修之前是这么写的：

```js
// renderBody
renderMarkdown(content).replace(
  /(^|>|\s)#([\p{L}\p{N}_-]{1,24})/gu,
  (m, pre, name) => `${pre}<a class="tag-inline" href="/tag/${encodeURIComponent(name)}">#${name}</a>`
);
```

正则的前置条件是 `^`、`>` 或空白。属性值里正好有空格，于是命中了：

修之前：

```
IN : ![ #tag ](/a.png)
OUT: <p class="md-img"><img src="/a.png" alt=" <a class=" loading="lazy" decoding="async"></p>
```

`alt` 被截断，属性结构崩了。不是 XSS（引号早已转义，注不进去），但会产出畸形 DOM。

修法的方向就一句话：**只在标签之外的文本里做替换**。想过两个偷懒办法，都不成——先转义 `#` 再转回来，等于要求后面所有步骤都不碰 `&`；只挑 `<p>`/`<li>`/`<h*>` 处理，则漏掉表格单元格和段落里的行内标签。

最后是按标签边界切段扫描：遇到 `<...>` 原样输出，其余片段才跑正则；同时维护一个跳过层级，`<pre>`、`<code>`、`<a>` 内部一律不动。

```js
const TAG_SPLIT = /<[^>]*>/g;

function linkTags(html) {
  const one = (text) =>
    text.replace(
      /(^|\s)#([\p{L}\p{N}_-]{1,24})/gu,
      (m, pre, name) => `${pre}<a class="tag-inline" href="/tag/${encodeURIComponent(name)}">#${name}</a>`
    );

  let out = '''';
  let last = 0;
  let skip = 0;                       // 在 <pre>/<code>/<a> 里的层级

  for (const m of html.matchAll(TAG_SPLIT)) {
    const text = html.slice(last, m.index);
    out += skip > 0 ? text : one(text);

    const tag = m[0];
    if (/^<(pre|code|a)[\s>]/i.test(tag)) skip++;
    else if (/^<\/(pre|code|a)\s*>/i.test(tag)) skip = Math.max(0, skip - 1);

    out += tag;
    last = m.index + tag.length;      // 别用 TAG_SPLIT.lastIndex：matchAll 用的是克隆对象，拿不到
  }

  out += skip > 0 ? html.slice(last) : one(html.slice(last));
  return out;
}
```

这段顺手修掉了同一个函数里的另外两个小毛病：

- **代码块里的 `#oauth` 也不再变成链接**。之前只按空白判断前置条件，代码块里的 `curl -d "#oauth"` 会被链掉，读者复制到的是 HTML 而不是命令。
- **`[#oauth](/tag/oauth)` 不会套出 `<a>` 里再套 `<a>`**。嵌套锚点在浏览器里会被拆成两个并列的 `<a>`，点了跳哪个全看运气。

有一处值得单独记：第一版我用 `matchAll` 之后去读 `TAG_SPLIT.lastIndex` 当下一段起点，结果每轮都从 0 开始，输出整段重复了十几遍。`matchAll` 内部用的是正则的克隆，写外部那个对象的 `lastIndex` 它不会更新。改成 `m.index + m[0].length` 就对了。

### 2. 链接正则被 `)` 截断

`[x](javascript:alert(1))` 里 URL 自带括号，而 `([^)\s]+)` 遇到第一个 `)` 就收工，剩下一个 `)` 变成正文。维基百科那种地址更明显：

```
IN : [维基](https://en.wikipedia.org/wiki/OAuth_(disambiguation))
OUT: <a href="https://en.wikipedia.org/wiki/OAuth_(disambiguation">维基</a>) 段落
```

链接指向一个 404，正文里还挂着一个孤零零的右括号。危害不大（`safeUrl` 已经把协议挡成 `#`），但排版和「点了 404」都是真问题。

修法是让 URL 里允许**一层成对括号**，而不是「除了右括号什么都要」：

```js
// 原来：(?:[^)\s]+)
const URL_PART = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
const IMG_RE = new RegExp(String.raw`!\[([^\]]*)\]\((${URL_PART})(?:\s+&quot;([^&]*)&quot;)?\)`, ''g'');
const LINK_RE = new RegExp(String.raw`\[([^\]]+)\]\((${URL_PART})(?:\s+&quot;([^&]*)&quot;)?\)`, ''g'');
```

只吃一层是刻意的：深度嵌套的括号在 Markdown 里本来就该用 `<>` 包住 URL，而我不打算实现尖括号形式（正文里 `<` 一律当文本转义，放行它会和第一道闸打架）。所以限制写清楚：**URL 里允许一对括号，再深就得手动百分号编码**，`(` = `%28`、`)` = `%29`。

`extractCover` 和 `extractExcerpt` 用的是同一套 URL 片段，顺手一起换了。不换的话，封面图地址里有括号就会截断成一个坏路径——这种图在 CDN 上很常见（`p_(1).png` 之类）。

### 3. `data:image/svg+xml` 放行了

`safeUrl` 只判断前缀 `data:image/`，SVG 也在内。在 `<img src>` 里加载的 SVG **不执行脚本**（浏览器对 image 上下文的 SVG 禁用了 script 和外部资源），所以这不算洞。

但边界要写清：这个判断只在「SVG 作为图片加载」时成立。哪天有人把 `data:` 拿去拼 `<object>` 或 `<iframe>`，同一段代码就成了洞。所以白名单里 `object`/`iframe` 是整块删的，不是靠 URL 校验兜。

## 回归：八条断言，`node` 直接跑

这两个 bug 的共同点是**改的时候看不出来**：一个只在 alt 里出现空格加 `#` 时触发，一个只在 URL 自带括号时触发。靠手动点页面，永远会漏。

所以修完补了一个不依赖任何测试框架的脚本，`node scripts/test-md.mjs`，八条断言：

```js
t(''alt 里不再插 <a>（#tag 只在元素之间的文本里生效）'', () => {
  const out = renderBody(''前文 ![ #tag ](/a.png) 后文'');
  assert.ok(!out.includes(''alt=" <a''), out);
  assert.ok(out.includes(''alt=" #tag "''), out);
});

t(''URL 自带括号时不被截断，也不漏一个 )'', () => {
  const out = renderBody(''见 [维基](https://en.wikipedia.org/wiki/OAuth_(disambiguation)) 段落'');
  assert.ok(out.includes(''href="https://en.wikipedia.org/wiki/OAuth_(disambiguation)"''), out);
  assert.ok(!out.includes(''</a>)''), out);
});
```

另外六条守的是**不该被改坏的东西**：普通 `#标签` 仍然成链、行内代码和围栏代码块里的 `#xxx` 不成链、`[#oauth](/tag/oauth)` 不套出嵌套 `<a>`、带括号的图片地址与 `extractCover` 一致、摘要提取不吃掉 URL 尾巴、`javascript:` 协议仍被 `safeUrl` 挡成 `#`。

`assert.ok(!out.includes(...))` 这种写法比 `assert.equal` 好用：失败时把整段输出打出来，一眼看到是哪一处多出来的东西，不用再回头复现。

## 顺带说一句同构

渲染器 `public/md.js` 被 Worker 和浏览器**引用同一份文件**：Worker 用它做 SSR，编辑器用它做实时预览。好处是预览和线上不可能不一致——预览里跑出来的畸形 HTML，线上也一样畸形，改的时候一眼能看到。

代价是这份文件不能有任何 Node API，也不能 import 服务端模块。`esc`、`highlight` 都是纯函数，能这么干。

下一篇写把客户端渲染改成整页 SSR 之后，首屏和收录具体变了什么。这两件事在同一条链路上：SSR 就是把 `renderBody` 的产出直接拼进首屏 HTML，白名单一旦漏，XSS 也就从"异步注入"变成"首屏直出"。

系列其他部分规划在 [工程实录](/cat/log) 下。相关的两篇：[D1 报错 no such table](/p/d1-no-such-table)、[Worker 里不能跨请求缓存的东西](/p/workers-io-different-request)——后者正好解释了为什么渲染结果不能往模块变量里存。

#markdown #xss #security
', '', 'log', '自建博客实录', 1,
        0, 0, 'XSS 风险不在 Markdown，在把渲染结果当 HTML 插入那一刻。转义→代码块占位→白名单三道闸的顺序为什么不能换，九个 payload 的实测输出，以及两处正则漏洞（alt 属性注入、括号 URL 截断）的修前修后与回归用例。', 'manual', '', 1, '2026-11-11 02:00:00', '2026-11-11 02:00:00', '2026-11-11 02:00:00')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  series = excluded.series, series_order = excluded.series_order,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('markdown');
INSERT OR IGNORE INTO tags (name) VALUES ('xss');
INSERT OR IGNORE INTO tags (name) VALUES ('security');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'blog-markdown-xss');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('markdown', 'xss', 'security') WHERE p.slug = 'blog-markdown-xss';

