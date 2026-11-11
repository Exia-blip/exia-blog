-- 补内链（09 <-> 10），由 scripts/gen-crosslinks.mjs 生成

UPDATE posts SET content = '## 结论

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

[图片链路那篇](/p/r2-image-pipeline) 正好接上这个话头：拖拽上传到 R2 的整条路——上传拿直链还是走 Worker 代理、浏览器端转 WebP 为什么设了"省不到 8% 就不换格式"的门槛，以及这篇的同类问题换了个入口：`image/svg+xml` 放行之后，直开那个 URL 会在本站 origin 上跑脚本。转义在这条路上一点用都没有，得靠响应头沙箱。

#markdown #javascript #xss
', updated_at = '2026-11-11 11:44:34' WHERE slug = 'editor-markdown-xss';
SELECT slug, length(content) AS len, updated_at FROM posts WHERE slug = 'editor-markdown-xss';

UPDATE posts SET content = '## 结论

图片这件事拆开是三段，每段一个决策：**写**（预签名直传 R2，Worker 中转只做兜底）、**读**（一律走 `/img/` 代理，不给直链）、**选**（封面三层兜底，同一篇永远同一张）。三个都定了之后，还剩一个当时没想清楚的问题：`image/svg+xml` 到底放不放行。

放行了，但补了一道沙箱——这是写这篇文章时才发现漏掉的，前后响应头都贴在第四节。

## 一、写：签名直传，中转只做兜底

上传接口先问 R2 能不能直接收：

```js
  if (path === ''/upload-url'' && method === ''POST'') {
    const { res } = await requireUser(env, request);
    if (res) return res;

    const body = await request.json();
    const type = String(body.type || ''image/png'');
    if (!IMAGE_TYPES[type]) return err(''只支持 jpg/png/gif/webp/svg/avif'');

    const key = makeKey(body.name);
    try {
      const uploadUrl = await presignPut(env, key);
      return json({ ok: true, mode: ''direct'', key, uploadUrl, publicUrl });
    } catch {
      // 没配 S3 凭据 -> 走 Worker 中转
      return json({ ok: true, mode: ''proxy'', key, publicUrl });
    }
  }
```

`direct` 模式下，Worker 只做一件事：算一个 15 分钟有效的 PUT 签名。图片字节从浏览器直接进 R2，一个都不经过 Worker。这不是省事，是省三样东西——请求体大小、CPU 时间、子请求额度。

签名是自己搓的，`src/s3.js` 八十五行，纯 WebCrypto，没引 aws-sdk。理由很土：为了一个 PUT 装一整套 SDK，打包体积和冷启动都不值。SigV4 的密钥派生是四个 HMAC 串起来，先用 AWS 文档里的标准向量验一遍再谈别的：

```
$ node --input-type=module -e "import {deriveSigningKey,_hex} from ''./src/s3.js''; \
  console.log(_hex(await deriveSigningKey(''wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'',''20150830'',''us-east-1'',''iam'')))"
derived  c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
expected c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
```

一模一样。这一步花五分钟，省掉后面所有"到底是我签错了还是 R2 不认"的排查。

前端拿到 URL 先试直传，挂了再退回中转：

```js
    if (r.mode === ''direct'') {
      try {
        const put = await fetch(r.uploadUrl, { method: ''PUT'',
          headers: { ''content-type'': file.type }, body: file });
        if (!put.ok) throw new Error(''R2 直传失败 '' + put.status);
      } catch (err) {
        // 直传失败（多半是 R2 CORS 没配）时回退到 Worker 中转
        const fd = new FormData(); fd.append(''file'', file);
        const r2 = await api(''/api/upload'', { method: ''POST'', body: fd });
        r.publicUrl = r2.publicUrl;
      }
    }
```

留这条退路是因为**直传依赖 R2 桶的 CORS 配置**，而那个配置在 Cloudflare 面板里改，改错了整条上传链路立刻全挂，报错还只说一个 `CORS error`。中转路径慢（图片过一遍 Worker），但它只依赖自己的域名，永远能用。慢的可用，比快的不可用强。

## 二、读：一律走 `/img/` 代理

R2 桶可以开公开域名，直连 `pub-xxx.r2.dev`。我没开，`R2_PUBLIC_BASE` 留空，所以写入正文的地址长这样：`/img/u/202611/abc123.png`。

```js
  const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '''') : '''';
  const publicUrl = base ? `${base}/${key}` : `/img/${key}`;
```

代理层就这么几行：

```js
async function serveImage(env, key) {
  const obj = await env.BUCKET.get(decodeURIComponent(key));
  if (!obj) return new Response(''404 Not Found'', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set(''etag'', obj.httpEtag);
  headers.set(''cache-control'', ''public, max-age=31536000, immutable'');
  // …svg 的额外处理，见第四节
  return new Response(obj.body, { headers });
}
```

四条理由，按重要性排：

1. **地址里没有域名。** 今天走 `/img/`，明天想换图床、换桶、加一层图片处理，正文一个字节都不用改。直链把域名焊死在一百多篇文章里，换一次就是一次全站正则。
2. **同源。** 图片跟页面一个 origin，没有 CORS，`referrer` 也不会把读者来源泄给第三方存储。
3. **能在响应上加头。** 第四节那条 CSP 就是这么加上去的——直链模式下连改的地方都没有。
4. **`R2_PUBLIC_BASE` 是开关，不是架构。** 真要直连，改一个环境变量，`/img/` 这条路自动让位。

代价是每个图片请求过一次 Worker。但 `immutable` 一年 + CF 对 `svg/png/jpg` 这类扩展名默认缓存，绝大多数请求在边缘就返回了，回源只在第一次和缓存被清的时候。这个代价我认。

## 三、`toWebp()` 的 8% 门槛

上传前在浏览器里转 WebP，省的是访客流量和 Worker 出口。这套逻辑和 [编辑器自动保存那篇](/p/editor-autosave) 里 `toWebp()` 的注释是同一份，搬到上传链路上之后多了一个判断：上传是一次性的，转坏了没机会重来，所以短路只往"放弃转换"的方向走。这段代码里有四个短路，比转换本身重要：

```js
  if (!/^image\/(jpeg|png)$/.test(file.type)) return file;   // gif 会丢动画，svg 是矢量，都不碰
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 200 * 1024) return file;    // 本来就小，不折腾
  const blob = await new Promise((ok) => cv.toBlob(ok, ''image/webp'', quality));
  if (!blob || blob.size >= file.size * 0.92) return file;   // 省不到 8% 就不换格式
```

第三条是这篇最想说的：**转完不比原图小 8% 的，直接放弃**。已经压过一轮的截图、纯色 UI 图，转 WebP 经常只小 2% 甚至更大（WebP 无损模式对已经优化的 PNG 没优势）。为了 2% 换一个格式，代价是"图片名和扩展名对不上"、"老工具打不开"这些长期麻烦。

参数是长边 1600、质量 0.82。1600 的依据是正文栏 720px，两倍屏 1440，再留一点余量——不是"越大越好"，是"刚好够清晰"。

最后两个兜底：`createImageBitmap` 不存在（老浏览器）就直接传原图，`toBlob` 返回 null 也传原图。图片上传失败比图片没压缩严重得多。

## 四、SVG：放行，但先补一道沙箱

`IMAGE_TYPES` 里留着 `image/svg+xml`，因为矢量图对技术文章有真实用处：流程图、架构图、坐标轴，放大不糊，体积还小。

问题在于 **SVG 不是图片，是文档**。浏览器用 `<img>` 加载它时沙箱化，不执行脚本；但**直接访问那个 URL** 时，它就按 HTML 一样渲染——里面的 `<script>` 会跑，而且跑在 `https://exia.de5.net` 这个 origin 上。

写这篇之前，`/img/` 的响应是这样的：

```
HTTP/1.1 200 OK
Content-Type: image/svg+xml
Cache-Control: public, max-age=31536000, immutable
x-content-type-options: nosniff
x-frame-options: DENY
```

没有 CSP。我传了一个带 `<script>document.title="SVG_RAN"</script>` 的测试文件上去，直开就能执行（nosniff 拦不住，因为 content-type 本来就是对的；`x-frame-options` 只挡 iframe）。

链子是这样接的：`/api/upload-url` 的门槛是 `requireUser`，**任何登录用户都能上传**；上传完拿到 `/img/u/xxx.svg`；把链接发给管理员点开；脚本就以管理员的身份调同源接口——发文章、封 IP、读评论里的 IP 全都可以。会话 cookie 是 `HttpOnly` 的，偷不走，但根本不需要偷。

这和 [渲染器那篇](/p/editor-markdown-xss) 是同一个问题换个入口：那篇防的是"文本里的标签被当标签执行"，靠转义；这里转义完全不管用，因为文件本身就是合法的 `image/svg+xml`，一个字符都不用改。**转义管文字，沙箱管文件类型**，两条路各自堵各自的洞。

修法是在代理层按 content-type 加头，桶里的文件一个都不动：

```js
  const ct = (headers.get(''content-type'') || '''').toLowerCase();
  if (ct.includes(''svg'')) {
    headers.set(''content-security-policy'', "default-src ''none''; style-src ''unsafe-inline''; sandbox");
    headers.set(''content-disposition'', ''inline'');
  }
```

`sandbox` 让文档失去脚本能力，`default-src ''none''` 顺手掐掉外部资源。改完再测，同一个文件：

```
Content-Type: image/svg+xml
Content-Disposition: inline
content-security-policy: default-src ''none''; style-src ''unsafe-inline''; sandbox
x-content-type-options: nosniff
```

对照组（`/img/avatar/u36541432-96`，`image/jpeg`）没有这条 CSP——位图不需要，加上是噪音。

同一件事在封面层还有一半：`src/cover.js` 里正文首图如果是 `.svg` 就直接弃用，退回预设图。

```js
  if (/\.svg(\?|#|$)/i.test(url)) return '''';
  if (/(^|\/)(favicon|icon[-_.]|emoji)/i.test(url)) return '''';
```

不是安全考虑，是显示考虑：208×136 的缩略图框里塞一张矢量图，要么糊、要么被裁得看不出是什么。一列卡片里混着清晰和糊的，比全糊还难看。

## 五、封面三层兜底

`coverOf()` 的顺序不能改：

1. `posts.cover` —— 编辑器里手动指定，最高优先级；
2. 正文第一张图 —— 作者放图了就自动拿来当缩略图，不用再管封面；
3. 预设图 —— 纯文字文章也得有图，列表不能出现空洞。

第三层必须**稳定**：`/thumbs/auto-${(id % 6) + 1}.jpg`，id 单调递增，新文章天然轮到下一张，相邻卡片不会撞同一张；同一篇文章永远同一张（用 slug 哈希兜没有 id 的场景）。这条规则放在 `public/cover.js`，服务端和浏览器 import 同一份——不然 hydrate 时缩略图会闪一下换脸。

列表卡片用的是 416×272 的 WebP 版，一张约 1.5KB；`og:image` 和 RSS 仍然要 1200×784 的 JPG。同一张图两个尺寸，按用途取，不是为了省事全用大的。

## 六、还欠的三笔账

1. **直传路径没有服务端大小上限。** 客户端拦 12MB（`if (file.size > 12 * 1024 * 1024)`），头像接口拦 4MB，但 `/upload-url` 只验 MIME 不验大小——因为签名在 PUT 之前就发出去了，那时还不知道文件多大。真要补，得把 `content-length` 写进签名头（或者用 R2 的对象大小约束）。现在的兜底是 R2 配额本身。
2. **正文大图没有多尺寸。** 只有封面做了 416px 缩略版，正文里的图只有原图一张，手机读者在下载 1600px 的图。`srcset` 需要服务端出多份，属于"知道该做、还没做"。
3. **上传只看声明的 MIME，不看文件头。** 把 SVG 改名成 `.png` 声明 `image/png` 能存进去，浏览器按 png 解 + `nosniff`，执行面是关着的；但白占配额这件事没人管。

这三条都不影响现在能用。写下来是为了下次别当它们不存在。

## 下一篇

编辑器系列到这篇收口。下一篇回到服务端：评论防滥用那三层——蜜罐、D1 限额（IP + 设备 cookie 双钥匙，UTC+8 换天）、可选 Turnstile，以及为什么"蜜罐被填了"应该返回 400 而不是静默成功。

#cloudflare #r2 #xss
', updated_at = '2026-11-11 11:44:34' WHERE slug = 'r2-image-pipeline';
SELECT slug, length(content) AS len, updated_at FROM posts WHERE slug = 'r2-image-pipeline';

