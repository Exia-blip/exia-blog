-- 由 scripts/seed-27-28.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('lightbox-no-deps', '无第三方库的图片灯箱：CSP nonce、SSR 不动、R2 原链路四条约束怎么同时守住', '## 结论

图片灯箱没必要装库。我这个站的文章页里，整个灯箱是 78 行原生 JS 加 30 行 CSS，没有外部依赖，没有 `innerHTML`，没有改一行服务端渲染代码。它同时要守住四条互相拉扯的约束：CSP nonce 不能多开一个脚本源、SSR 输出一个字节都不能动、放大图必须走已有的 R2 代理链路、移动端手势不能被浏览器抢走。

| 约束 | 做法 | 守不住会怎样 |
|---|---|---|
| CSP nonce | 灯箱逻辑并进已有的 `post.html` 内联脚本，由现有 nonce 出口统一补标 | 引外部库就要在 `script-src` 加源，或者内联脚本漏补 nonce 被静默挡掉 |
| SSR 零改动 | 用现成的 `.md-img img` 选择器识别独立成行图，不给 `<img>` 加新标记 | 改 `md.js` 要动落库的 `html_content`，全量重算所有文章 |
| R2 原链路 | 放大图读 `img.currentSrc || img.src`，复用浏览器已经选好的那张 | 自己拼 CDN 地址会绕过图片代理，多一次回源，SVG 沙箱也被跳过 |
| 手势与降噪 | 只认单指上滑 >64px 关闭，`touch-action: none`，`prefers-reduced-motion` 直接跳过淡出 | 浏览器把手势当页面滚动吃掉；降噪用户看到一个永远不消失的透明层 |

最值钱的一条是第二个：**选择器够用就别加标记。** 我一开始的本能是给每个可放大的 `<img>` 打一个 `data-light`，客户端按属性找。看着更「语义化」，实际上会动 SSR 输出——`html_content` 是发布时落库的，改渲染函数意味着全量重算，为一个按钮掀翻整条内容管线不划算。改用 `.md-img img` 之后，服务端代码一行没碰，线上文章页的 ETag 连打两次都是 `"184f-5972f6fd"`，跟没加灯箱时同一套生成逻辑。

## 一、先看 CSP 给灯箱留了多大的口子

这个站的 CSP 头是零第三方脚本起步：

```http
content-security-policy: default-src ''self''; script-src ''self'' ''nonce-e1022201…''; style-src ''self'' ''unsafe-inline''; img-src ''self'' data: blob: https:; connect-src ''self''; object-src ''none''; base-uri ''self''; form-action ''self''; frame-ancestors ''none''
```

灯箱要是引一个看图库，有三种走法，每一种都要付代价。

一是从 CDN 拉脚本，那就得往 `script-src` 里加一个源。一个纯展示用的浮层换一条 CSP 例外，这笔账不划算；何况我这个项目六个月不扩技术栈，读者侧多一个第三方域名就是多一个长期维护面。

二是把库代码内联进页面。内联脚本在 CSP 下必须带当次 nonce，这些脚本统一由出口的 `applyNonce()` 补标。新内联一段代码本身没问题，但把几十 KB 的库塞进每篇文章的 body，等于让每个访客为一件可能永远不点的事付带宽。

三是自己写。原生 `createElement` 加事件委托，正好落在第一种和第二种之间——不新增脚本源，代码量不到一百行，按需创建，首屏零成本。

还有一个容易被忽略的点：灯箱里的 `<img>` 是客户端动态创建的，它的 `src` 来自页面里已有的图片 URL。CSP 的 `img-src` 已经放行了 `self`、`data:`、`blob:` 和 `https:`，所以放大层不需要为图片来源改任何 CSP 指令。如果放大时用的是 `blob:` URL 或 `data:` URL，现有白名单也 cover 得住。这一条不用专门加测试，但写代码前得先确认，否则做完了才发现要动安全头。

## 二、选择器就够了：为什么不给 img 打标记

本站的 Markdown 渲染里，独立成行的图片会被包成 `<figure class="md-img">`，行内混在文字里的图片不会。渲染代码就这么一行：

```js
// public/md.js，行级渲染
out.push(`<figure class="md-img">${inline(line.trim())}${cap ? `<figcaption>${cap}</figcaption>` : ''''}</figure>`);
```

这个结构本来就在，不是为了灯箱造的——它是图片居中和图注排版的容器。灯箱直接借用它：

```js
// public/post.html，事件委托挂在正文根节点上
body.addEventListener(''click'', (e) => {
  const img = e.target.closest(''.md-img img'');
  if (!img) return;
  e.preventDefault();
  openLb(img.currentSrc || img.src, img.alt);
});
```

`closest(''.md-img img'')` 一条选择器就划清了边界：正文里独立成行的图能点，行内图不触发，图注文字点击也冒泡到同一张图。没有新属性、没有新的 DOM 结构、没有服务端改动。

我认真想过加 `data-light` 的代价。这篇文章的 `html_content` 是发布时算好写进 D1 的，读取侧虽然有 `html_content || renderBody()` 兜底，但那是保险，不该常态化触发。改 `md.js` 意味着所有存量文章要重算一遍 HTML 和封面，这不是一个按钮该掀起的动静。而且一旦加了标记，样式、测试、文档都要跟着维护一个「哪些图可点」的清单；现在这套靠结构区分，Markdown 怎么变，规则都自动跟着变。

真正的判断标准是：**如果选择器能表达这条规则，就不要往 SSR 输出里加东西。** 服务端渲出的字节一旦改了，ETag、缓存、回填三件事全部被牵连；客户端补的钩子只影响访客浏览器，改错了刷新就好。这两边的改动成本差一个数量级。

事件委托还有个附带好处：`hydrate()` 只跑一次，正文里后来插进来的图片也自动可点。不用在每次重渲染后重新绑定，也不用担心重复绑定。

## 三、懒创建：首屏一个字节都不给灯箱

灯箱的 DOM 不是写在 HTML 里的，是第一次点击时才造：

```js
let lb = null;
function ensureLb() {
  if (lb) return lb;
  const wrap = document.createElement(''div'');
  wrap.className = ''lb'';
  wrap.setAttribute(''role'', ''dialog'');
  wrap.setAttribute(''aria-label'', ''图片预览'');
  wrap.setAttribute(''aria-modal'', ''true'');
  wrap.hidden = true;
  // ...stage / img / close 一行行 createElement 出来
  document.body.appendChild(wrap);
  // ...点击事件、键盘、touch 监听一次挂好
  lb = { wrap, stage, im, close };
  return lb;
}
```

三个细节值得说。

`if (lb) return lb` 让它变成单例。第一次点的时候创建，关掉之后不销毁，只是 `hidden = true`。第二次点复用同一个节点，只换 `src`。用户连着看十张图，DOM 里始终只有一份灯箱，不会积累十层浮层。

全部用 `createElement`，没有一处 `innerHTML`。倒不是因为这段 HTML 有注入风险——图片地址来自本站 SSR 的内容，alt 文本也过了渲染器的转义——而是因为整站的 CSP 对内联脚本管得很严，用字符串拼 DOM 容易在后续维护里被人塞进事件属性。纯 DOM API 没有这个口子，也省掉一次 HTML 解析。

`wrap.hidden = true` 配合 CSS 里的 `.lb[hidden] { display: none; }`。这一条必须写，否则浏览器默认样式表里的 `display: none` 会被 `.lb { display: grid }` 盖掉，浮层一创建就挡在页面上。这是个很小但很容易漏的坑——hidden 属性不是万能的，作者样式优先级比 UA 样式高。

## 四、放大图走 currentSrc，不多一次回源

放大时取的是 `img.currentSrc || img.src`：

```js
// currentSrc 是浏览器按 srcset 选好的那张（R2 代理链路），命中已有缓存；
// 没选定时退回 src。放大层复用同一 URL，不多一次回源。
openLb(img.currentSrc || img.src, img.alt);
```

本站的图片走 R2 代理：正文里写的是 `/r2/...` 一类路径，Worker 负责取对象、定 content-type、做 SVG 沙箱。浏览器拿到带 `srcset` 的 `<img>` 之后，会按视口宽度和 DPR 自己挑一张，`currentSrc` 就是它最终选择的结果。

如果放大层自己拼一个「大图」地址，会发生三件事：绕开浏览器已经命中的缓存，多一次 R2 回源；跳过 SVG 沙箱（如果那张是 SVG）；移动端拿到一张远超屏幕的图，白付流量。用 `currentSrc` 则是零成本——那张图已经在浏览器缓存里，放大层只是换了个容器显示它。

`|| img.src` 是兜底：`currentSrc` 在图片还没开始加载、或者浏览器不支持 `srcset` 时可能是空串。这时候退回 `src` 至少能显示原图，不至于点开一片空白。

灯箱内部的 `<img>` 大小由 CSS 限制，不用改图片本身：

```css
.lb-img {
  display: block; max-width: 94vw; max-height: 88vh;
  width: auto; height: auto; margin: 0;
  cursor: zoom-out;
  touch-action: none;
}
```

`max-width/max-height` 配 `width: auto; height: auto`，长图短图都能完整落在视口里，不会被拉伸。`94vw / 88vh` 留出一点边距，让深色蒙层露出来，用户看得出这是个浮层而不是跳了页。

## 五、关闭的三条路与 64px 阈值

关闭只有三个入口：点蒙层或关闭按钮、按 ESC、移动端上滑。

```js
wrap.addEventListener(''click'', (e) => {
  if (e.target === wrap || e.target === stage || e.target.closest(''.lb-close'')) closeLb();
});
addEventListener(''keydown'', (e) => { if (e.key === ''Escape'' && !wrap.hidden) closeLb(); });
```

点击那行刻意写成三个条件的或：`e.target === wrap` 是点蒙层空白处，`e.target === stage` 是点图片周围的留白，`closest(''.lb-close'')` 是点右上角按钮。不写 `!closest(''.lb-img'')` 之类的反向判断，是因为图片本身点了不该关——用户放大图片往往就是想凑近看，点一下就消失很恼人。

移动端上滑是后加的：

```js
let ty0 = null;
stage.addEventListener(''touchstart'', (e) => {
  if (e.touches.length !== 1) { ty0 = null; return; }
  ty0 = e.touches[0].clientY;
}, { passive: true });
stage.addEventListener(''touchend'', (e) => {
  if (ty0 == null) return;
  const dy = (e.changedTouches[0]?.clientY ?? ty0) - ty0;
  ty0 = null;
  if (Math.abs(dy) > 64) closeLb();
}, { passive: true });
```

三个判断各自有原因。

`touches.length !== 1` 把多指手势排除掉。这一版最初是放行双指缩放的，`touch-action` 写的是 `pan-x pan-y pinch-zoom`。后来砍掉了：双指缩放由浏览器原生处理，我这套浮层做不出比系统更好的缩放体验，反而让关闭逻辑要多判断一种状态。取舍定下来之后，多指事件就一律不记起点，避免误关。

`Math.abs(dy) > 64` 同时接受上滑和下滑。写 `dy < -64` 只认上滑看着更符合「划走」的直觉，但真机上用户也常往下甩，两个方向都关更宽容。64px 是在 390px 宽的视口上试出来的阈值——再小，翻图时的手指微动会误关；再大，要甩得很用力。

`passive: true` 让这两个监听不阻塞滚动。配合 CSS 里的 `touch-action: none`：

```css
.lb-stage {
  max-width: 94vw; max-height: 88vh;
  display: grid; place-items: center;
  /* 只做单图预览，不做双指缩放/拖动。
     none 让上滑关闭的 touch 监听拿到完整手势，不被引擎当页面滚动吃掉。 */
  touch-action: none;
}
```

这一对是配套的：如果 `touch-action` 留着 `pan-y`，浏览器会把手势当页面滚动消费掉，`touchend` 里拿到的位移可能已经被引擎处理过，关闭就不跟手。`none` 把完整手势留给监听器，`passive: true` 则保证监听器不去 `preventDefault()` 跟浏览器抢。

## 六、180ms 淡出和 reduced-motion 的空层坑

浮层不是瞬间消失，先淡出再隐藏：

```js
function closeLb() {
  if (!lb || lb.wrap.hidden) return;
  lb.wrap.classList.remove(''on'');
  document.documentElement.style.overflow = '''';
  const hide = () => { lb.wrap.hidden = true; };
  // reduced-motion 下没有淡出过渡，直接隐藏，别留一个看不见还吃事件的层
  if (matchMedia(''(prefers-reduced-motion: reduce)'').matches) hide();
  else setTimeout(hide, 180);
}
```

CSS 里 `.lb { opacity: 0; transition: opacity .18s ease; }`，`.lb.on { opacity: 1; }`。关的时候摘掉 `on`，180ms 内 opacity 从 1 走到 0，然后 `hidden = true`。时间常数两边必须对齐——JS 的 180 和 CSS 的 `.18s` 是同一个数。哪边改了另一边没跟上，就会出现「还没淡完就被隐藏」或者「淡完了还挡着」。`document.documentElement.style.overflow = ''hidden''` 在打开时锁住背景滚动，关闭时立刻解锁，不用等淡出结束——用户关掉浮层的瞬间就该能继续滚页面。

最阴的是 reduced-motion 那个分支。系统开了「减少动态效果」之后，CSS 里 `.lb { transition: none }`，根本没有淡出。如果 JS 还是等 180ms 才设 `hidden`，这 180ms 里浮层已经完全透明，但 `display: grid` 还在，鼠标和触摸全被它吃掉，页面像卡死了一样。所以 reduced-motion 下必须直接 `hide()`，不是「顺便优化」，是修一个真 bug。

写测试的时候踩了一个反过来的坑：无头 Chrome 默认就是 `prefers-reduced-motion: reduce`。我第一次跑 Puppeteer，断言「关闭 250ms 后浮层 hidden」通过了，但想验的那条 180ms 淡出其实根本没跑——环境替我把分支短路了。后来在测试开头显式加：

```js
await page.emulateMediaFeatures([
  { name: ''prefers-reduced-motion'', value: ''no-preference'' },
]);
```

才真的测到淡出路径。另外断言 `hidden` 之前要等 250ms，比 180ms 多 70ms 余量，避免定时器抖动造成偶发失败。**测交互之前先确认测试环境没有替用户做出降噪选择**，这条比灯箱代码本身更容易被忘掉。

## 七、实测：14 项交互与线上零变化

这批前台交互一起做了 14 项 Puppeteer 实测，灯箱部分覆盖桌面点击放大、点背景关闭、ESC 关闭、移动端上滑关闭、降噪模式下不等淡出，主题过渡那部分覆盖了临时 class 的挂载与摘除、降噪跳过，其余是复制链接和搜索快捷键。14 项全过。

线上复核的数字（2026-11-21）：

| 检查项 | 结果 |
|---|---|
| 文章页同源脚本里的灯箱钩子 | `function bindLightbox` 1 处、`currentSrc || img.src` 1 处、`Math.abs(dy) > 64` 1 处 |
| SSR 输出里的 `data-light` | 0 处 |
| 同一文章页连打两次 ETag | `"184f-5972f6fd"` / `"184f-5972f6fd"`，完全一致 |
| 线上 `style.css` md5 | `a7a1e38f5222f1df58544c7fbf8e544f`，与本地一致 |
| 线上 `theme.js` md5 | `f0f72e517a557591f1f46007f7ec39b8`，与本地一致 |

`data-light` 命中 0 是「SSR 零改动」的直接证据：没有标记，客户端就只能用选择器找图，整条内容管线不用有任何感知。ETag 两次一致则说明灯箱代码虽然打进了同源脚本，但它是静态的——不会因为访客点没点图而改变服务端产出的字节，CDN 缓存和 304 链路都不受影响。

守门测试 `scripts/test-ux-extras.mjs` 用静态钩子锁住这些约束：必须存在 `.md-img img` 选择器、必须复用 `currentSrc`、灯箱的 `ensureLb()` 里不许出现 `innerHTML`、CSS 里不许再出现 `pinch-zoom`、必须尊重 `prefers-reduced-motion`。这类纯前端交互没有 SSR 输出可断言，静态钩子是唯一能防「改样式时顺手删了接线」的办法。

## 八、这套方案的边界，明说

灯箱只做单图预览。没有图集轮播、没有左右切换、没有双指缩放、没有下载按钮。这些不是「以后再加」的待办，是明确的取舍。

图集轮播要维护一组图片和当前索引，还要处理预加载、边界回绕、缩略图导航。本站一篇文章里的图通常是三到六张截图，读者点开看的是某一张的细节，不是按顺序翻相册。加轮播是写一个读者不会用的功能。双指缩放砍掉的理由前面说过——浏览器原生的缩放体验比我自己写得好，而且引入多指手势会让上滑关闭多一层判断。下载按钮的取舍更简单：图片本来就在页面上，右键保存或者长按存图都能做到，不需要我在浮层里再放一个按钮占地方。

放大层用固定深色蒙层 `rgba(0, 0, 0, .86)`，不跟随主题。这条看着不一致，其实是有意的：浅色主题下如果蒙层也变浅，白底配白图边，图片边界会糊掉；深色是看图场景的行业惯例。本站的主题变量里也没有专门的浮层色，为一个浮层新加一组变量不划算。

还有一个没测的地方要如实说：**我没有在真机上做过触摸手势的对照实验。** 上滑 64px 的阈值、单指判定、`touch-action: none` 这套组合是在无头 Chrome 里用 Puppeteer 模拟 touch 事件验的，逻辑路径全过，但真机的触摸采样率、边缘手势冲突（比如从屏幕边缘上滑会触发系统的控制中心）没有覆盖。真机上如果用户从底部边缘上滑关不掉，就得调阈值或者换关闭方式——这一条只到模拟测试为止，没做过实机验证。

同样，ETag 两次一致只能证明灯箱代码没改服务端产出的字节，不能证明跨 CDN 节点的缓存一致性。线上是一次请求抽两份响应头对比的，不是多个边缘节点同时采样。要验后者得从多地发请求，这次没做。

## 怎么自己验一遍

**1. 确认 SSR 里没有新标记。** 抓一篇文章页，搜 `data-light`，必须是 0：

```bash
curl -s "https://你的域名/p/任意文章?cb=$RANDOM" | grep -c ''data-light''
# 0
```

**2. 确认放大图没有二次回源。** 打开 DevTools 的 Network，过滤图片请求，先点开一张图再关掉。放大层显示的 URL 应该和正文里那张完全相同，Network 里不出现第二个图片请求。

**3. 验三条关闭路径。** 分别点蒙层、按 ESC、手机上滑超过 64px。关掉之后立刻试着滚动页面，背景必须能滚——如果滚不动，说明 `overflow` 没解锁，或者透明浮层还在。

**4. 验降噪分支。** DevTools 里把 `prefers-reduced-motion` 切成 `reduce`，再开关一次。浮层应当瞬间消失，不能留一个看不见但吃事件的元素。

**5. 验测试环境没替你降噪。** 跑 Puppeteer 之前显式 `emulateMediaFeatures` 设成 `no-preference`，断言 `hidden` 前等 250ms。不这么做，180ms 淡出这条路径测不到。

**6. 跑守门测试。**

```bash
node scripts/test-ux-extras.mjs
```

六条断言分别守着 DOM 创建方式、选择器、R2 链路、手势取舍和降噪。任何一条红，都说明有人为了「顺手改进」动了这套约束——先看清他想解决什么，再决定是改代码还是改测试。
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>图片灯箱没必要装库。我这个站的文章页里，整个灯箱是 78 行原生 JS 加 30 行 CSS，没有外部依赖，没有 <code>innerHTML</code>，没有改一行服务端渲染代码。它同时要守住四条互相拉扯的约束：CSP nonce 不能多开一个脚本源、SSR 输出一个字节都不能动、放大图必须走已有的 R2 代理链路、移动端手势不能被浏览器抢走。</p>
<div class="table-wrap"><table><thead><tr><th>约束</th><th>做法</th><th>守不住会怎样</th></tr></thead><tbody><tr><td>CSP nonce</td><td>灯箱逻辑并进已有的 <code>post.html</code> 内联脚本，由现有 nonce 出口统一补标</td><td>引外部库就要在 <code>script-src</code> 加源，或者内联脚本漏补 nonce 被静默挡掉</td></tr><tr><td>SSR 零改动</td><td>用现成的 <code>.md-img img</code> 选择器识别独立成行图，不给 <code>&lt;img&gt;</code> 加新标记</td><td>改 <code>md.js</code> 要动落库的 <code>html_content</code>，全量重算所有文章</td></tr><tr><td>R2 原链路</td><td>放大图读 `img.currentSrc</td><td></td><td>img.src`，复用浏览器已经选好的那张</td><td>自己拼 CDN 地址会绕过图片代理，多一次回源，SVG 沙箱也被跳过</td></tr><tr><td>手势与降噪</td><td>只认单指上滑 &gt;64px 关闭，<code>touch-action: none</code>，<code>prefers-reduced-motion</code> 直接跳过淡出</td><td>浏览器把手势当页面滚动吃掉；降噪用户看到一个永远不消失的透明层</td></tr></tbody></table></div>
<p>最值钱的一条是第二个：<strong>选择器够用就别加标记。</strong> 我一开始的本能是给每个可放大的 <code>&lt;img&gt;</code> 打一个 <code>data-light</code>，客户端按属性找。看着更「语义化」，实际上会动 SSR 输出——<code>html_content</code> 是发布时落库的，改渲染函数意味着全量重算，为一个按钮掀翻整条内容管线不划算。改用 <code>.md-img img</code> 之后，服务端代码一行没碰，线上文章页的 ETag 连打两次都是 <code>&quot;184f-5972f6fd&quot;</code>，跟没加灯箱时同一套生成逻辑。</p>
<h2 id="一-先看-csp-给灯箱留了多大的口子"><a class="h-anchor" href="#一-先看-csp-给灯箱留了多大的口子">#</a>一、先看 CSP 给灯箱留了多大的口子</h2>
<p>这个站的 CSP 头是零第三方脚本起步：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">http</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-http">content-security-policy: default-src <span class="tok-s">&#39;self&#39;</span>; script-src <span class="tok-s">&#39;self&#39;</span> <span class="tok-s">&#39;nonce-e1022201…&#39;</span>; style-src <span class="tok-s">&#39;self&#39;</span> <span class="tok-s">&#39;unsafe-inline&#39;</span>; img-src <span class="tok-s">&#39;self&#39;</span> data: blob: https:; connect-src <span class="tok-s">&#39;self&#39;</span>; object-src <span class="tok-s">&#39;none&#39;</span>; base-uri <span class="tok-s">&#39;self&#39;</span>; form-action <span class="tok-s">&#39;self&#39;</span>; frame-ancestors <span class="tok-s">&#39;none&#39;</span></code></pre></div>
<p>灯箱要是引一个看图库，有三种走法，每一种都要付代价。</p>
<p>一是从 CDN 拉脚本，那就得往 <code>script-src</code> 里加一个源。一个纯展示用的浮层换一条 CSP 例外，这笔账不划算；何况我这个项目六个月不扩技术栈，读者侧多一个第三方域名就是多一个长期维护面。</p>
<p>二是把库代码内联进页面。内联脚本在 CSP 下必须带当次 nonce，这些脚本统一由出口的 <code>applyNonce()</code> 补标。新内联一段代码本身没问题，但把几十 KB 的库塞进每篇文章的 body，等于让每个访客为一件可能永远不点的事付带宽。</p>
<p>三是自己写。原生 <code>createElement</code> 加事件委托，正好落在第一种和第二种之间——不新增脚本源，代码量不到一百行，按需创建，首屏零成本。</p>
<p>还有一个容易被忽略的点：灯箱里的 <code>&lt;img&gt;</code> 是客户端动态创建的，它的 <code>src</code> 来自页面里已有的图片 URL。CSP 的 <code>img-src</code> 已经放行了 <code>self</code>、<code>data:</code>、<code>blob:</code> 和 <code>https:</code>，所以放大层不需要为图片来源改任何 CSP 指令。如果放大时用的是 <code>blob:</code> URL 或 <code>data:</code> URL，现有白名单也 cover 得住。这一条不用专门加测试，但写代码前得先确认，否则做完了才发现要动安全头。</p>
<h2 id="二-选择器就够了-为什么不给-img-打标记"><a class="h-anchor" href="#二-选择器就够了-为什么不给-img-打标记">#</a>二、选择器就够了：为什么不给 img 打标记</h2>
<p>本站的 Markdown 渲染里，独立成行的图片会被包成 <code>&lt;figure class=&quot;md-img&quot;&gt;</code>，行内混在文字里的图片不会。渲染代码就这么一行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// public/md.js，行级渲染</span>
out.<span class="tok-f">push</span>(<span class="tok-s">`&lt;figure class=&quot;md-img&quot;&gt;${inline(line.trim())}${cap ? `</span>&lt;figcaption&gt;${cap}&lt;/figcaption&gt;<span class="tok-s">` : &#39;&#39;}&lt;/figure&gt;`</span>);</code></pre></div>
<p>这个结构本来就在，不是为了灯箱造的——它是图片居中和图注排版的容器。灯箱直接借用它：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// public/post.html，事件委托挂在正文根节点上</span>
body.<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;click&#39;</span>, (e) =&gt; {
  <span class="tok-k">const</span> img = e.target.<span class="tok-f">closest</span>(<span class="tok-s">&#39;.md-img img&#39;</span>);
  <span class="tok-k">if</span> (!img) <span class="tok-k">return</span>;
  e.<span class="tok-f">preventDefault</span>();
  <span class="tok-f">openLb</span>(img.currentSrc || img.src, img.alt);
});</code></pre></div>
<p><code>closest(&#39;.md-img img&#39;)</code> 一条选择器就划清了边界：正文里独立成行的图能点，行内图不触发，图注文字点击也冒泡到同一张图。没有新属性、没有新的 DOM 结构、没有服务端改动。</p>
<p>我认真想过加 <code>data-light</code> 的代价。这篇文章的 <code>html_content</code> 是发布时算好写进 D1 的，读取侧虽然有 <code>html_content || renderBody()</code> 兜底，但那是保险，不该常态化触发。改 <code>md.js</code> 意味着所有存量文章要重算一遍 HTML 和封面，这不是一个按钮该掀起的动静。而且一旦加了标记，样式、测试、文档都要跟着维护一个「哪些图可点」的清单；现在这套靠结构区分，Markdown 怎么变，规则都自动跟着变。</p>
<p>真正的判断标准是：<strong>如果选择器能表达这条规则，就不要往 SSR 输出里加东西。</strong> 服务端渲出的字节一旦改了，ETag、缓存、回填三件事全部被牵连；客户端补的钩子只影响访客浏览器，改错了刷新就好。这两边的改动成本差一个数量级。</p>
<p>事件委托还有个附带好处：<code>hydrate()</code> 只跑一次，正文里后来插进来的图片也自动可点。不用在每次重渲染后重新绑定，也不用担心重复绑定。</p>
<h2 id="三-懒创建-首屏一个字节都不给灯箱"><a class="h-anchor" href="#三-懒创建-首屏一个字节都不给灯箱">#</a>三、懒创建：首屏一个字节都不给灯箱</h2>
<p>灯箱的 DOM 不是写在 HTML 里的，是第一次点击时才造：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">let</span> lb = <span class="tok-k">null</span>;
<span class="tok-k">function</span> <span class="tok-f">ensureLb</span>() {
  <span class="tok-k">if</span> (lb) <span class="tok-k">return</span> lb;
  <span class="tok-k">const</span> wrap = document.<span class="tok-f">createElement</span>(<span class="tok-s">&#39;div&#39;</span>);
  wrap.className = <span class="tok-s">&#39;lb&#39;</span>;
  wrap.<span class="tok-f">setAttribute</span>(<span class="tok-s">&#39;role&#39;</span>, <span class="tok-s">&#39;dialog&#39;</span>);
  wrap.<span class="tok-f">setAttribute</span>(<span class="tok-s">&#39;aria-label&#39;</span>, <span class="tok-s">&#39;图片预览&#39;</span>);
  wrap.<span class="tok-f">setAttribute</span>(<span class="tok-s">&#39;aria-modal&#39;</span>, <span class="tok-s">&#39;true&#39;</span>);
  wrap.hidden = <span class="tok-k">true</span>;
  <span class="tok-c">// ...stage / img / close 一行行 createElement 出来</span>
  document.body.<span class="tok-f">appendChild</span>(wrap);
  <span class="tok-c">// ...点击事件、键盘、touch 监听一次挂好</span>
  lb = { wrap, stage, im, close };
  <span class="tok-k">return</span> lb;
}</code></pre></div>
<p>三个细节值得说。</p>
<p><code>if (lb) return lb</code> 让它变成单例。第一次点的时候创建，关掉之后不销毁，只是 <code>hidden = true</code>。第二次点复用同一个节点，只换 <code>src</code>。用户连着看十张图，DOM 里始终只有一份灯箱，不会积累十层浮层。</p>
<p>全部用 <code>createElement</code>，没有一处 <code>innerHTML</code>。倒不是因为这段 HTML 有注入风险——图片地址来自本站 SSR 的内容，alt 文本也过了渲染器的转义——而是因为整站的 CSP 对内联脚本管得很严，用字符串拼 DOM 容易在后续维护里被人塞进事件属性。纯 DOM API 没有这个口子，也省掉一次 HTML 解析。</p>
<p><code>wrap.hidden = true</code> 配合 CSS 里的 <code>.lb[hidden] { display: none; }</code>。这一条必须写，否则浏览器默认样式表里的 <code>display: none</code> 会被 <code>.lb { display: grid }</code> 盖掉，浮层一创建就挡在页面上。这是个很小但很容易漏的坑——hidden 属性不是万能的，作者样式优先级比 UA 样式高。</p>
<h2 id="四-放大图走-currentsrc-不多一次回源"><a class="h-anchor" href="#四-放大图走-currentsrc-不多一次回源">#</a>四、放大图走 currentSrc，不多一次回源</h2>
<p>放大时取的是 <code>img.currentSrc || img.src</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// currentSrc 是浏览器按 srcset 选好的那张（R2 代理链路），命中已有缓存；</span>
<span class="tok-c">// 没选定时退回 src。放大层复用同一 URL，不多一次回源。</span>
<span class="tok-f">openLb</span>(img.currentSrc || img.src, img.alt);</code></pre></div>
<p>本站的图片走 R2 代理：正文里写的是 <code>/r2/...</code> 一类路径，Worker 负责取对象、定 content-type、做 SVG 沙箱。浏览器拿到带 <code>srcset</code> 的 <code>&lt;img&gt;</code> 之后，会按视口宽度和 DPR 自己挑一张，<code>currentSrc</code> 就是它最终选择的结果。</p>
<p>如果放大层自己拼一个「大图」地址，会发生三件事：绕开浏览器已经命中的缓存，多一次 R2 回源；跳过 SVG 沙箱（如果那张是 SVG）；移动端拿到一张远超屏幕的图，白付流量。用 <code>currentSrc</code> 则是零成本——那张图已经在浏览器缓存里，放大层只是换了个容器显示它。</p>
<p><code>|| img.src</code> 是兜底：<code>currentSrc</code> 在图片还没开始加载、或者浏览器不支持 <code>srcset</code> 时可能是空串。这时候退回 <code>src</code> 至少能显示原图，不至于点开一片空白。</p>
<p>灯箱内部的 <code>&lt;img&gt;</code> 大小由 CSS 限制，不用改图片本身：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">.lb-img {
  display: block; max-width: <span class="tok-n">94vw</span>; max-height: <span class="tok-n">88vh</span>;
  width: auto; height: auto; margin: <span class="tok-n">0</span>;
  cursor: zoom-out;
  touch-action: none;
}</code></pre></div>
<p><code>max-width/max-height</code> 配 <code>width: auto; height: auto</code>，长图短图都能完整落在视口里，不会被拉伸。<code>94vw / 88vh</code> 留出一点边距，让深色蒙层露出来，用户看得出这是个浮层而不是跳了页。</p>
<h2 id="五-关闭的三条路与-64px-阈值"><a class="h-anchor" href="#五-关闭的三条路与-64px-阈值">#</a>五、关闭的三条路与 64px 阈值</h2>
<p>关闭只有三个入口：点蒙层或关闭按钮、按 ESC、移动端上滑。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">wrap.<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;click&#39;</span>, (e) =&gt; {
  <span class="tok-k">if</span> (e.target === wrap || e.target === stage || e.target.<span class="tok-f">closest</span>(<span class="tok-s">&#39;.lb-close&#39;</span>)) <span class="tok-f">closeLb</span>();
});
<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;keydown&#39;</span>, (e) =&gt; { <span class="tok-k">if</span> (e.key === <span class="tok-s">&#39;Escape&#39;</span> &amp;&amp; !wrap.hidden) <span class="tok-f">closeLb</span>(); });</code></pre></div>
<p>点击那行刻意写成三个条件的或：<code>e.target === wrap</code> 是点蒙层空白处，<code>e.target === stage</code> 是点图片周围的留白，<code>closest(&#39;.lb-close&#39;)</code> 是点右上角按钮。不写 <code>!closest(&#39;.lb-img&#39;)</code> 之类的反向判断，是因为图片本身点了不该关——用户放大图片往往就是想凑近看，点一下就消失很恼人。</p>
<p>移动端上滑是后加的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">let</span> ty0 = <span class="tok-k">null</span>;
stage.<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;touchstart&#39;</span>, (e) =&gt; {
  <span class="tok-k">if</span> (e.touches.length !== <span class="tok-n">1</span>) { ty0 = <span class="tok-k">null</span>; <span class="tok-k">return</span>; }
  ty0 = e.touches[<span class="tok-n">0</span>].clientY;
}, { passive: <span class="tok-k">true</span> });
stage.<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;touchend&#39;</span>, (e) =&gt; {
  <span class="tok-k">if</span> (ty0 == <span class="tok-k">null</span>) <span class="tok-k">return</span>;
  <span class="tok-k">const</span> dy = (e.changedTouches[<span class="tok-n">0</span>]?.clientY ?? ty0) - ty0;
  ty0 = <span class="tok-k">null</span>;
  <span class="tok-k">if</span> (Math.<span class="tok-f">abs</span>(dy) &gt; <span class="tok-n">64</span>) <span class="tok-f">closeLb</span>();
}, { passive: <span class="tok-k">true</span> });</code></pre></div>
<p>三个判断各自有原因。</p>
<p><code>touches.length !== 1</code> 把多指手势排除掉。这一版最初是放行双指缩放的，<code>touch-action</code> 写的是 <code>pan-x pan-y pinch-zoom</code>。后来砍掉了：双指缩放由浏览器原生处理，我这套浮层做不出比系统更好的缩放体验，反而让关闭逻辑要多判断一种状态。取舍定下来之后，多指事件就一律不记起点，避免误关。</p>
<p><code>Math.abs(dy) &gt; 64</code> 同时接受上滑和下滑。写 <code>dy &lt; -64</code> 只认上滑看着更符合「划走」的直觉，但真机上用户也常往下甩，两个方向都关更宽容。64px 是在 390px 宽的视口上试出来的阈值——再小，翻图时的手指微动会误关；再大，要甩得很用力。</p>
<p><code>passive: true</code> 让这两个监听不阻塞滚动。配合 CSS 里的 <code>touch-action: none</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">.lb-stage {
  max-width: <span class="tok-n">94vw</span>; max-height: <span class="tok-n">88vh</span>;
  display: grid; place-items: center;
  <span class="tok-c">/* 只做单图预览，不做双指缩放/拖动。
     none 让上滑关闭的 touch 监听拿到完整手势，不被引擎当页面滚动吃掉。 */</span>
  touch-action: none;
}</code></pre></div>
<p>这一对是配套的：如果 <code>touch-action</code> 留着 <code>pan-y</code>，浏览器会把手势当页面滚动消费掉，<code>touchend</code> 里拿到的位移可能已经被引擎处理过，关闭就不跟手。<code>none</code> 把完整手势留给监听器，<code>passive: true</code> 则保证监听器不去 <code>preventDefault()</code> 跟浏览器抢。</p>
<h2 id="六-180ms-淡出和-reduced-motion-的空层坑"><a class="h-anchor" href="#六-180ms-淡出和-reduced-motion-的空层坑">#</a>六、180ms 淡出和 reduced-motion 的空层坑</h2>
<p>浮层不是瞬间消失，先淡出再隐藏：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">closeLb</span>() {
  <span class="tok-k">if</span> (!lb || lb.wrap.hidden) <span class="tok-k">return</span>;
  lb.wrap.classList.<span class="tok-f">remove</span>(<span class="tok-s">&#39;on&#39;</span>);
  document.documentElement.style.overflow = <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">const</span> hide = () =&gt; { lb.wrap.hidden = <span class="tok-k">true</span>; };
  <span class="tok-c">// reduced-motion 下没有淡出过渡，直接隐藏，别留一个看不见还吃事件的层</span>
  <span class="tok-k">if</span> (<span class="tok-f">matchMedia</span>(<span class="tok-s">&#39;(prefers-reduced-motion: reduce)&#39;</span>).matches) <span class="tok-f">hide</span>();
  <span class="tok-k">else</span> <span class="tok-f">setTimeout</span>(hide, <span class="tok-n">180</span>);
}</code></pre></div>
<p>CSS 里 <code>.lb { opacity: 0; transition: opacity .18s ease; }</code>，<code>.lb.on { opacity: 1; }</code>。关的时候摘掉 <code>on</code>，180ms 内 opacity 从 1 走到 0，然后 <code>hidden = true</code>。时间常数两边必须对齐——JS 的 180 和 CSS 的 <code>.18s</code> 是同一个数。哪边改了另一边没跟上，就会出现「还没淡完就被隐藏」或者「淡完了还挡着」。<code>document.documentElement.style.overflow = &#39;hidden&#39;</code> 在打开时锁住背景滚动，关闭时立刻解锁，不用等淡出结束——用户关掉浮层的瞬间就该能继续滚页面。</p>
<p>最阴的是 reduced-motion 那个分支。系统开了「减少动态效果」之后，CSS 里 <code>.lb { transition: none }</code>，根本没有淡出。如果 JS 还是等 180ms 才设 <code>hidden</code>，这 180ms 里浮层已经完全透明，但 <code>display: grid</code> 还在，鼠标和触摸全被它吃掉，页面像卡死了一样。所以 reduced-motion 下必须直接 <code>hide()</code>，不是「顺便优化」，是修一个真 bug。</p>
<p>写测试的时候踩了一个反过来的坑：无头 Chrome 默认就是 <code>prefers-reduced-motion: reduce</code>。我第一次跑 Puppeteer，断言「关闭 250ms 后浮层 hidden」通过了，但想验的那条 180ms 淡出其实根本没跑——环境替我把分支短路了。后来在测试开头显式加：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">await</span> page.<span class="tok-f">emulateMediaFeatures</span>([
  { name: <span class="tok-s">&#39;prefers-reduced-motion&#39;</span>, value: <span class="tok-s">&#39;no-preference&#39;</span> },
]);</code></pre></div>
<p>才真的测到淡出路径。另外断言 <code>hidden</code> 之前要等 250ms，比 180ms 多 70ms 余量，避免定时器抖动造成偶发失败。<strong>测交互之前先确认测试环境没有替用户做出降噪选择</strong>，这条比灯箱代码本身更容易被忘掉。</p>
<h2 id="七-实测-14-项交互与线上零变化"><a class="h-anchor" href="#七-实测-14-项交互与线上零变化">#</a>七、实测：14 项交互与线上零变化</h2>
<p>这批前台交互一起做了 14 项 Puppeteer 实测，灯箱部分覆盖桌面点击放大、点背景关闭、ESC 关闭、移动端上滑关闭、降噪模式下不等淡出，主题过渡那部分覆盖了临时 class 的挂载与摘除、降噪跳过，其余是复制链接和搜索快捷键。14 项全过。</p>
<p>线上复核的数字（2026-11-21）：</p>
<div class="table-wrap"><table><thead><tr><th>检查项</th><th>结果</th></tr></thead><tbody><tr><td>文章页同源脚本里的灯箱钩子</td><td><code>function bindLightbox</code> 1 处、`currentSrc</td><td></td><td>img.src<code> 1 处、</code>Math.abs(dy) &gt; 64` 1 处</td></tr><tr><td>SSR 输出里的 <code>data-light</code></td><td>0 处</td></tr><tr><td>同一文章页连打两次 ETag</td><td><code>&quot;184f-5972f6fd&quot;</code> / <code>&quot;184f-5972f6fd&quot;</code>，完全一致</td></tr><tr><td>线上 <code>style.css</code> md5</td><td><code>a7a1e38f5222f1df58544c7fbf8e544f</code>，与本地一致</td></tr><tr><td>线上 <code>theme.js</code> md5</td><td><code>f0f72e517a557591f1f46007f7ec39b8</code>，与本地一致</td></tr></tbody></table></div>
<p><code>data-light</code> 命中 0 是「SSR 零改动」的直接证据：没有标记，客户端就只能用选择器找图，整条内容管线不用有任何感知。ETag 两次一致则说明灯箱代码虽然打进了同源脚本，但它是静态的——不会因为访客点没点图而改变服务端产出的字节，CDN 缓存和 304 链路都不受影响。</p>
<p>守门测试 <code>scripts/test-ux-extras.mjs</code> 用静态钩子锁住这些约束：必须存在 <code>.md-img img</code> 选择器、必须复用 <code>currentSrc</code>、灯箱的 <code>ensureLb()</code> 里不许出现 <code>innerHTML</code>、CSS 里不许再出现 <code>pinch-zoom</code>、必须尊重 <code>prefers-reduced-motion</code>。这类纯前端交互没有 SSR 输出可断言，静态钩子是唯一能防「改样式时顺手删了接线」的办法。</p>
<h2 id="八-这套方案的边界-明说"><a class="h-anchor" href="#八-这套方案的边界-明说">#</a>八、这套方案的边界，明说</h2>
<p>灯箱只做单图预览。没有图集轮播、没有左右切换、没有双指缩放、没有下载按钮。这些不是「以后再加」的待办，是明确的取舍。</p>
<p>图集轮播要维护一组图片和当前索引，还要处理预加载、边界回绕、缩略图导航。本站一篇文章里的图通常是三到六张截图，读者点开看的是某一张的细节，不是按顺序翻相册。加轮播是写一个读者不会用的功能。双指缩放砍掉的理由前面说过——浏览器原生的缩放体验比我自己写得好，而且引入多指手势会让上滑关闭多一层判断。下载按钮的取舍更简单：图片本来就在页面上，右键保存或者长按存图都能做到，不需要我在浮层里再放一个按钮占地方。</p>
<p>放大层用固定深色蒙层 <code>rgba(0, 0, 0, .86)</code>，不跟随主题。这条看着不一致，其实是有意的：浅色主题下如果蒙层也变浅，白底配白图边，图片边界会糊掉；深色是看图场景的行业惯例。本站的主题变量里也没有专门的浮层色，为一个浮层新加一组变量不划算。</p>
<p>还有一个没测的地方要如实说：<strong>我没有在真机上做过触摸手势的对照实验。</strong> 上滑 64px 的阈值、单指判定、<code>touch-action: none</code> 这套组合是在无头 Chrome 里用 Puppeteer 模拟 touch 事件验的，逻辑路径全过，但真机的触摸采样率、边缘手势冲突（比如从屏幕边缘上滑会触发系统的控制中心）没有覆盖。真机上如果用户从底部边缘上滑关不掉，就得调阈值或者换关闭方式——这一条只到模拟测试为止，没做过实机验证。</p>
<p>同样，ETag 两次一致只能证明灯箱代码没改服务端产出的字节，不能证明跨 CDN 节点的缓存一致性。线上是一次请求抽两份响应头对比的，不是多个边缘节点同时采样。要验后者得从多地发请求，这次没做。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p><strong>1. 确认 SSR 里没有新标记。</strong> 抓一篇文章页，搜 <code>data-light</code>，必须是 0：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s <span class="tok-s">&quot;https://你的域名/p/任意文章?cb=$RANDOM&quot;</span> | <span class="tok-k">grep</span> -c <span class="tok-s">&#39;data-light&#39;</span>
<span class="tok-c"># 0</span></code></pre></div>
<p><strong>2. 确认放大图没有二次回源。</strong> 打开 DevTools 的 Network，过滤图片请求，先点开一张图再关掉。放大层显示的 URL 应该和正文里那张完全相同，Network 里不出现第二个图片请求。</p>
<p><strong>3. 验三条关闭路径。</strong> 分别点蒙层、按 ESC、手机上滑超过 64px。关掉之后立刻试着滚动页面，背景必须能滚——如果滚不动，说明 <code>overflow</code> 没解锁，或者透明浮层还在。</p>
<p><strong>4. 验降噪分支。</strong> DevTools 里把 <code>prefers-reduced-motion</code> 切成 <code>reduce</code>，再开关一次。浮层应当瞬间消失，不能留一个看不见但吃事件的元素。</p>
<p><strong>5. 验测试环境没替你降噪。</strong> 跑 Puppeteer 之前显式 <code>emulateMediaFeatures</code> 设成 <code>no-preference</code>，断言 <code>hidden</code> 前等 250ms。不这么做，180ms 淡出这条路径测不到。</p>
<p><strong>6. 跑守门测试。</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> scripts/test-ux-extras.mjs</code></pre></div>
<p>六条断言分别守着 DOM 创建方式、选择器、R2 链路、手势取舍和降噪。任何一条红，都说明有人为了「顺手改进」动了这套约束——先看清他想解决什么，再决定是改代码还是改测试。</p>', '', 'tools', '78 行原生 JS 做灯箱，不装库、不碰 md.js、不多一次回源。选择器够用就别给 img 加 data-light——html_content 落库，改渲染要全量重算。currentSrc 复用 R2 已选图，上滑 64px 关闭，180ms 淡出在降噪下直接跳过。',
        '', 0, 0, 0, 1, '2026-12-19 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('javascript') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'lightbox-no-deps' AND t.name = 'javascript';
INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'lightbox-no-deps' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('ssr') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'lightbox-no-deps' AND t.name = 'ssr';
INSERT INTO tags (name) VALUES ('r2') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'lightbox-no-deps' AND t.name = 'r2';
INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('theme-transition-class', '主题切换只闪一下：临时 class + transitionend 兜底，为什么常驻 transition 会闪首屏', '## 结论

主题切换的平滑过渡，靠的是**一个只在切换那一刻存在的 class**，不是常驻在 body 上的 `transition`。常驻写法会让首屏加载、按需加载主题样式表、甚至 hover 都跟着渐变，看起来就是闪屏。临时 class 只在 `apply()` 里挂上、过渡结束就摘掉，平时页面里一个 transition 都没有。

但这个 class 不能靠 `transitionend` 单独摘——有两种情况下这个事件根本不来：主题 CSS 还在异步加载、或者切换前后颜色值相同。所以必须留一个 400ms 的定时兜底，比 0.28s 的过渡时长略长，确保 class 一定被摘掉。两道保险各管一种故障，缺一道就会留下一个常驻的 class，把「临时」变成「永久」，等于绕回原点。

| 约束 | 做法 | 不做会怎样 |
|---|---|---|
| 首屏不能有动画 | 无常驻 transition，只在 `apply()` 里临时挂 `html.theme-transition` | 首屏、滚动、hover 全部带渐变，像闪屏 |
| 不能抖布局 | CSS 只过渡 `color` / `background-color` | 碰 width/height/margin 会产生 CLS |
| 事件不保证来 | `transitionend` + 400ms `setTimeout` 双保险 | 异步加载主题 CSS 或前后同色时 class 残留 |
| 只认自己的事件 | `e.target === ROOT` 且 `propertyName` 是两种颜色之一 | 子元素过渡冒泡上来，提前摘掉 class |
| 连续切换 | 每次先撤旧监听和旧定时器 | 上一次的回调提前摘掉这一次的 class |
| 降噪优先 | `prefers-reduced-motion: reduce` 直接 return | 前庭敏感用户被迫看完整过渡 |

最容易被误判的是最后一行的反向形态：我第一次跑 Puppeteer 验过渡，断言「切换后 class 挂上、200ms 后摘掉」**通过了**，以为实现没问题。其实无头 Chrome 默认就是 `prefers-reduced-motion: reduce`，第一道硬开关直接 return，整段过渡逻辑根本没执行——测试验的是「降噪用户跳过了过渡」，却报成了「过渡正常」。现象像 A，根因在 B。这个形态和 11-13 那篇 sticky 误判同类，搜索价值也高。

## 一、常驻 transition 为什么会闪首屏

最早的实现是在 `style.css` 里给 body 挂一条常驻规则：

```css
body {
  transition: color .3s ease, background-color .3s ease;
}
```

看着很合理：主题一换，body 的文字色和背景色平滑过渡。问题在于 CSS transition 不管「是谁改的」——只要计算值变了，它就动。

首屏加载时，`index.html` 头部有一段引导脚本读 `localStorage` 里的偏好，给 `html` 设 `data-theme` 和 `data-mode`。这段脚本必须放在 CSS 后面执行，才能赶在首屏绘制前定好主题。但主题样式表是按需加载的：纸韵和安知鱼编在主样式表里，另外五套在 `/theme/<id>.css`，要等文件拿到手。这段空档里 body 已经按默认色绘制，等主题 CSS 一到，颜色变了——常驻 transition 把这次变化当成一次「切换」，页面开头就渐变一下。

hover、滚动、任何会改颜色的交互也都带上了这 300ms。用户没切主题，只是把鼠标移到按钮上，页面背景跟着慢慢变，手感发黏。

根因是**动画的作用域错了**。需要动画的只是「用户主动切换主题」这一个瞬间，不是「任何颜色变化」。把 transition 挂在 body 上等于声明「所有颜色变化都要动画」，范围太大了。

改法是把它收窄成一个临时状态：

```css
/* 只在切换那一刻存在，完事就摘掉 */
html.theme-transition, html.theme-transition * {
  transition: color .28s ease, background-color .28s ease;
}
@media (prefers-reduced-motion: reduce) {
  html.theme-transition, html.theme-transition * { transition: none !important; }
}
```

常态下这条选择器不匹配，页面里没有颜色过渡。只有 `apply()` 执行时临时给 `html` 加上 `theme-transition`，动画生效，结束立刻摘掉。

选择器后面那个 `*` 是必要的。主题切换改的是根元素的 `data-theme` / `data-mode`，颜色变量定义在 `:root` 上，但真正渲染颜色的可能是卡片、按钮、链接等子元素——它们用 `var(--bg)` 取值，变量变了，它们的颜色也跟着变。只给 `html` 自己挂 transition，根元素自己的颜色会渐变，子元素却是硬跳。所以整棵子树都要临时带上这条过渡。

## 二、为什么只碰两种颜色属性

`transition: color .28s ease, background-color .28s ease` 只列了这两项，不是省略。

CLS（累积布局偏移）的计算只看几何属性：位置、尺寸。颜色变化再大，元素占的地方不变，CLS 就是 0。把 `width`、`height`、`margin`、`padding`、`transform` 里的任何一项塞进 transition，切换主题的 280ms 里布局会连续重排，读者正在读的那行字可能移动几次。

主题切换在语义上只该改变配色——深浅、强调色、底色。如果某套主题的按钮圆角或字号和另一套不同，那些差异应该在主题 CSS 加载完、data-theme 改掉的那一刻**一次性生效**，不参与渐变。混进过渡会把「换肤」变成「动画重排」，代价远大于那点顺滑感。

`.28s` 是个折中：低于 200ms 人眼看不出过渡，高于 400ms 会觉得切换迟钝。0.28s 刚好能在不改变阅读节奏的前提下让颜色有来路。400ms 的兜底定时比它长 120ms，留出事件派发和定时器抖动的余量。

## 三、transitionend 什么时候不来

摘 class 的第一选择是监听 `transitionend`：

```js
animOff = (e) => {
  if (e.target === ROOT && (e.propertyName === ''color'' || e.propertyName === ''background-color'')) done();
};
ROOT.addEventListener(''transitionend'', animOff);
```

但 `transitionend` 有三个坑，每一个都真实发生过。

**坑一：没有过渡就没有事件。** 如果主题 CSS 还没加载完，`var(--bg)` 的值没变；或者切换前后两个主题的背景色恰好相同（比如只换风格不换明暗，`paper` 和 `ink` 的浅色底很接近），浏览器认为计算值没变化，不会启动 transition，自然也不发 `transitionend`。这时 class 会永远留在 html 上——页面变成「常驻 transition」，绕回第一节那个闪屏问题。

**坑二：子元素事件会冒泡上来。** 前面给整棵子树都挂了过渡，所以卡片、按钮各自都会发 `transitionend`，这些事件冒泡到 html。`e.target === ROOT` 把子元素的事件挡掉，只认根元素自己触发的那一次。`propertyName` 再限定为 `color` 或 `background-color`，避免 border、transform 之类混进来——虽然当前 CSS 没过渡这些属性，但别人以后加了不该误触发。

**坑三：连续切换的旧回调。** 用户快速点两次主题，第一次的 `transitionend` 可能在第二次过渡中间到达，把第二次刚挂上的 class 摘掉。所以每次开始都要先清理：

```js
if (animOff) { ROOT.removeEventListener(''transitionend'', animOff); animOff = null; }
clearTimeout(animTimer);
ROOT.classList.add(''theme-transition'');
```

`done()` 里也要再清一遍监听和定时器，防止重复触发：

```js
const done = () => {
  ROOT.classList.remove(''theme-transition'');
  if (animOff) { ROOT.removeEventListener(''transitionend'', animOff); animOff = null; }
  clearTimeout(animTimer);
};
```

兜底定时器是最后一招：

```js
animTimer = setTimeout(done, 400);
```

它和 `transitionend` 是或的关系——谁先到谁先摘，另一个被 `done()` 清掉。这套双保险不是为了「更保险一点」，是因为两种故障各有各的触发条件，单独靠哪一个都会在某一类场景下失效。

## 四、按需加载主题 CSS 的顺序

本站七套主题，只有纸韵（`paper`）和安知鱼（`anzhiyu`）编在主样式表里，其余五套在 `/theme/<id>.css`。切到一个没加载过的主题时，顺序很关键：

```js
function ensureThemeCss(theme) {
  if (theme === ''paper'' || theme === ''anzhiyu'') return Promise.resolve();
  const id = `tcss-${theme}`;
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement(''link'');
    l.id = id;
    l.rel = ''stylesheet'';
    l.href = `/theme/${theme}.css`;
    l.onload = resolve;
    l.onerror = resolve;
    document.head.appendChild(l);
  });
}
```

`apply()` 里必须先拿到 CSS，再改 `data-theme`：

```js
const run = () => {
  const dark = mode === ''dark'' || (mode === ''auto'' && systemDark());
  flashTransition();                          // 挂临时 class
  ROOT.setAttribute(''data-theme'', theme);     // 这时变量才切过去
  ROOT.setAttribute(''data-mode'', dark ? ''dark'' : ''light'');
  // ...
};
if (document.getElementById(`tcss-${theme}`) || theme === ''paper'' || theme === ''anzhiyu'') return run();
ensureThemeCss(theme).then(run);
return { theme, mode, dark: /* 乐观值 */ };
```

反过来会有一两帧「data-theme 已经变了，但新主题的 CSS 还没到」的窗口，页面用旧变量渲染新主题名，比闪一下白更难看。所以样式到位前不动 DOM。

`l.onerror = resolve` 这一行是故意的：加载失败也放行，样式缺一份总比点按钮没反应强。用户点了没动静是最糟的体验，哪怕退回到上一套主题的配色，至少交互是通的。

`flashTransition()` 放在 `run()` 里、`setAttribute` 之前——class 必须先挂上，颜色变化才会被捕获。顺序写反了，过渡不会产生，`transitionend` 不触发，就靠 400ms 兜底撑着，用户看到的是硬跳加一段多余的等待。

`apply()` 在样式加载期间返回的是一个乐观值，这不是 bug：调用方要立刻更新选中态和 localStorage，不能等网络。真正可靠的当前值从 `pref()` 读，它优先读 localStorage，和 `syncUI()` 走同一套口径。

## 五、reduced-motion 是第一道硬开关

```js
function flashTransition() {
  if (matchMedia(''(prefers-reduced-motion: reduce)'').matches) return;
  // ...后面的监听、定时器、class 全都不跑
}
```

这一行放在函数最开头，后面所有逻辑都不执行——不挂 class、不监听、不设定时器。它的优先级高于一切：不管 CSS 里写了什么、不管主题怎么切，用户明确要求少动效，就一点动画都不给。

不这么做会影响前庭敏感人群。大幅的颜色渐变可能引发眩晕和恶心，`prefers-reduced-motion` 就是给这类用户的系统级开关。尊重它不是「锦上添花」，是无障碍基线。

CSS 里还有第二道：

```css
@media (prefers-reduced-motion: reduce) {
  html.theme-transition, html.theme-transition * { transition: none !important; }
}
```

JS 那道防的是「已经 reduced-motion 就不启动」，CSS 这道防的是「切换中途用户打开了 reduced-motion」。两层夹死，不会有哪条路径漏过去。

## 六、误判现场：无头 Chrome 的默认降噪

开头那个「测试通过了却什么都没测到」，根因在测试环境，不在实现。

想验的是「切换后 class 挂上、过渡结束摘掉」，断言逻辑很直白：

```js
await page.click(''[data-theme-btn]'');
await page.waitForFunction(() => document.documentElement.dataset.theme !== oldTheme);
const during = await page.evaluate(() =>
  document.documentElement.classList.contains(''theme-transition''));
assert.equal(during, true);
await new Promise((r) => setTimeout(r, 500));
const after = await page.evaluate(() =>
  document.documentElement.classList.contains(''theme-transition''));
assert.equal(after, false);
```

第一次跑这组，过渡相关的断言怎么都对不上——`during` 拿不到 true，`after` 又一直是 false。第一反应是 `flashTransition()` 没被调用，或者 class 名写错了，照着实现查了一圈，代码是对的。

真正的原因藏在浏览器环境里：**无头 Chrome 默认 `prefers-reduced-motion: reduce`。** 也就是说，它替所有用户选了「减少动态效果」。`flashTransition()` 第一行就 return，class 从头到尾没挂过，后面那套 `transitionend` + 定时兜底根本没跑。我测的不是「过渡是否正常」，而是「降噪模式下是否跳过过渡」——代码在这条路径上完全正确，只是不是我想验的那条。

修法是显式把环境摆到目标状态：

```js
await page.emulateMediaFeatures([
  { name: ''prefers-reduced-motion'', value: ''no-preference'' },
]);
```

加上这一行，同样那组断言才有意义。反过来说，如果目的是验降噪分支，就保留默认值、断言 class 始终不出现——两条路径要分开测，不能共用一组断言。

这个坑的形态是「现象像 A、根因在 B」：现象是过渡逻辑没生效，像实现写错了；根因是测试环境默认开了降噪。搜索价值也在这里——很多人遇到的是同一个现象，但会一路往 CSS 和事件监听上查。

同一批 14 项交互实测里，灯箱关闭那段也撞了同一个默认值：淡出被 CSS 的 `@media (prefers-reduced-motion: reduce)` 短路，180ms 的 `setTimeout` 没走，class 状态和预期不符。两处用的是同一个修法。验交互类功能之前，先把环境摆到目标状态——降噪、DPR、视口宽度、字体加载，哪一样都可能让代码走另一条分支。

## 七、这套方案没覆盖的地方

有三处只到推断或者部分实测为止，写清楚免得别人误以为是经过完整验证的。

**第一处：CLS 为 0 是机制推断，不是这次单独测的数。** 我只过渡 `color` 和 `background-color`，这两种属性不参与布局计算，因此不会触发重排——这是浏览器渲染模型的直接结论。线上性能基线里 CLS 确实是 0，但那个数字是整站多个优化共同的结果，没法单独归因给主题过渡。要严格证明得做 A/B：开过渡和关过渡各跑一遍 Lighthouse，对比 CLS。这次没做，只到「属性本身不引起布局偏移」这一层。

**第二处：0.28s 和 400ms 是经验值，没做过用户测试。** 低于 200ms 看不出过渡、高于 400ms 觉得迟钝，这是常见的动画时长经验，不是对这个站读者做过实验得出的。400ms 兜底比 0.28s 长 120ms，这个余量是拍的——足够覆盖定时器抖动，但如果某个设备的 CSS 过渡因为掉帧拖到 500ms，兜底会提前摘掉 class，过渡硬生生断掉。这种情况我没在慢设备上复现过，属于已知但未量化的边界。

**第三处：连续切换只验了三次点击，没做压力测试。** 测试里快速连点三次主题按钮，等 1 秒，class 已经摘掉。这验证了旧监听和旧定时器被清理的路径，但没测过十次、二十次连续切换，也没测过切换过程中主题 CSS 还在下载的情况。代码上每次都先撤旧监听再挂新的，逻辑上不会累积，但这是读代码的结论，不是压测数据。

把这三处写出来不是自曝其短。这个站的文章底线是「一个别处没有的东西」，而这个东西必须是真的——把推断标成实测，整篇的可信度就垮了。11-18 那篇把标题里的 549→96 拆成三个实验的归因，也是同一个道理。

## 八、一个相关细节：theme-color

顺带记一个相关细节：`theme-color` meta 跟着主题走，是在 `run()` 里读 `--bg` 变量写回去的：

```js
const bg = getComputedStyle(ROOT).getPropertyValue(''--bg'').trim();
if (bg) meta.setAttribute(''content'', bg);
```

这行必须在 `data-theme` 改完之后执行，读到的才是新主题的底色。顺序反了，手机地址栏会留着上一主题的颜色，浅色模式下尤其刺眼。

## 怎么自己验一遍

**1. 确认没有常驻 transition。** 在浏览器 DevTools 里搜 `body { transition`，应该搜不到任何给 body 或全局元素常驻挂 `color/background-color` 过渡的规则。只有 `html.theme-transition` 那一条临时规则。

**2. 手动切一次，看 class 的生命周期。** 打开 DevTools Elements 面板，盯着 `<html>` 节点，点主题切换。应当看到 `theme-transition` 出现，大约 280ms 后消失。切完之后这个 class 不能再留在节点上。

**3. 验异步加载路径。** 先清掉 `/theme/*.css` 的缓存，切到一个从没加载过的主题（比如「暮紫」）。等 CSS 加载完、`data-theme` 变了之后，class 仍应能正常摘掉。这一步专门覆盖 `transitionend` 不来、靠 400ms 兜底的场景。

**4. 验同色切换。** 在两个背景色接近的主题之间来回切（只换风格不换明暗）。颜色没变，不会有 `transitionend`，400ms 兜底必须把 class 摘掉。

**5. 验连续点击。** 快速连点三次主题按钮，等 1 秒。class 必须已经摘掉——如果还在，说明上一次的回调或定时器没清干净。

**6. 验降噪。** DevTools → Rendering → 勾选 `prefers-reduced-motion: reduce`，再切一次主题。颜色应该瞬间变，没有任何渐变；`<html>` 上也不该出现 `theme-transition`。

**7. 跑守门测试。**

```bash
node scripts/test-ux-extras.mjs   # 主题过渡那组断言
node scripts/test-theme.mjs       # 七套主题样式直出与边界
```

第一组锁住「临时 class + transitionend + 定时兜底 + 只过渡颜色 + 无常驻 body transition」这些实现约束，第二组锁住主题样式表的直出规则——七套里只有两套不发 link，未知主题名不许拼进 `href`。两组一起绿，才算这条链路没被回退。
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>主题切换的平滑过渡，靠的是<strong>一个只在切换那一刻存在的 class</strong>，不是常驻在 body 上的 <code>transition</code>。常驻写法会让首屏加载、按需加载主题样式表、甚至 hover 都跟着渐变，看起来就是闪屏。临时 class 只在 <code>apply()</code> 里挂上、过渡结束就摘掉，平时页面里一个 transition 都没有。</p>
<p>但这个 class 不能靠 <code>transitionend</code> 单独摘——有两种情况下这个事件根本不来：主题 CSS 还在异步加载、或者切换前后颜色值相同。所以必须留一个 400ms 的定时兜底，比 0.28s 的过渡时长略长，确保 class 一定被摘掉。两道保险各管一种故障，缺一道就会留下一个常驻的 class，把「临时」变成「永久」，等于绕回原点。</p>
<div class="table-wrap"><table><thead><tr><th>约束</th><th>做法</th><th>不做会怎样</th></tr></thead><tbody><tr><td>首屏不能有动画</td><td>无常驻 transition，只在 <code>apply()</code> 里临时挂 <code>html.theme-transition</code></td><td>首屏、滚动、hover 全部带渐变，像闪屏</td></tr><tr><td>不能抖布局</td><td>CSS 只过渡 <code>color</code> / <code>background-color</code></td><td>碰 width/height/margin 会产生 CLS</td></tr><tr><td>事件不保证来</td><td><code>transitionend</code> + 400ms <code>setTimeout</code> 双保险</td><td>异步加载主题 CSS 或前后同色时 class 残留</td></tr><tr><td>只认自己的事件</td><td><code>e.target === ROOT</code> 且 <code>propertyName</code> 是两种颜色之一</td><td>子元素过渡冒泡上来，提前摘掉 class</td></tr><tr><td>连续切换</td><td>每次先撤旧监听和旧定时器</td><td>上一次的回调提前摘掉这一次的 class</td></tr><tr><td>降噪优先</td><td><code>prefers-reduced-motion: reduce</code> 直接 return</td><td>前庭敏感用户被迫看完整过渡</td></tr></tbody></table></div>
<p>最容易被误判的是最后一行的反向形态：我第一次跑 Puppeteer 验过渡，断言「切换后 class 挂上、200ms 后摘掉」<strong>通过了</strong>，以为实现没问题。其实无头 Chrome 默认就是 <code>prefers-reduced-motion: reduce</code>，第一道硬开关直接 return，整段过渡逻辑根本没执行——测试验的是「降噪用户跳过了过渡」，却报成了「过渡正常」。现象像 A，根因在 B。这个形态和 11-13 那篇 sticky 误判同类，搜索价值也高。</p>
<h2 id="一-常驻-transition-为什么会闪首屏"><a class="h-anchor" href="#一-常驻-transition-为什么会闪首屏">#</a>一、常驻 transition 为什么会闪首屏</h2>
<p>最早的实现是在 <code>style.css</code> 里给 body 挂一条常驻规则：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">body {
  transition: color .<span class="tok-n">3s</span> ease, background-color .<span class="tok-n">3s</span> ease;
}</code></pre></div>
<p>看着很合理：主题一换，body 的文字色和背景色平滑过渡。问题在于 CSS transition 不管「是谁改的」——只要计算值变了，它就动。</p>
<p>首屏加载时，<code>index.html</code> 头部有一段引导脚本读 <code>localStorage</code> 里的偏好，给 <code>html</code> 设 <code>data-theme</code> 和 <code>data-mode</code>。这段脚本必须放在 CSS 后面执行，才能赶在首屏绘制前定好主题。但主题样式表是按需加载的：纸韵和安知鱼编在主样式表里，另外五套在 <code>/theme/&lt;id&gt;.css</code>，要等文件拿到手。这段空档里 body 已经按默认色绘制，等主题 CSS 一到，颜色变了——常驻 transition 把这次变化当成一次「切换」，页面开头就渐变一下。</p>
<p>hover、滚动、任何会改颜色的交互也都带上了这 300ms。用户没切主题，只是把鼠标移到按钮上，页面背景跟着慢慢变，手感发黏。</p>
<p>根因是<strong>动画的作用域错了</strong>。需要动画的只是「用户主动切换主题」这一个瞬间，不是「任何颜色变化」。把 transition 挂在 body 上等于声明「所有颜色变化都要动画」，范围太大了。</p>
<p>改法是把它收窄成一个临时状态：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css"><span class="tok-c">/* 只在切换那一刻存在，完事就摘掉 */</span>
html.theme-transition, html.theme-transition * {
  transition: color .<span class="tok-n">28s</span> ease, background-color .<span class="tok-n">28s</span> ease;
}
@media (prefers-reduced-motion: reduce) {
  html.theme-transition, html.theme-transition * { transition: none !important; }
}</code></pre></div>
<p>常态下这条选择器不匹配，页面里没有颜色过渡。只有 <code>apply()</code> 执行时临时给 <code>html</code> 加上 <code>theme-transition</code>，动画生效，结束立刻摘掉。</p>
<p>选择器后面那个 <code>*</code> 是必要的。主题切换改的是根元素的 <code>data-theme</code> / <code>data-mode</code>，颜色变量定义在 <code>:root</code> 上，但真正渲染颜色的可能是卡片、按钮、链接等子元素——它们用 <code>var(--bg)</code> 取值，变量变了，它们的颜色也跟着变。只给 <code>html</code> 自己挂 transition，根元素自己的颜色会渐变，子元素却是硬跳。所以整棵子树都要临时带上这条过渡。</p>
<h2 id="二-为什么只碰两种颜色属性"><a class="h-anchor" href="#二-为什么只碰两种颜色属性">#</a>二、为什么只碰两种颜色属性</h2>
<p><code>transition: color .28s ease, background-color .28s ease</code> 只列了这两项，不是省略。</p>
<p>CLS（累积布局偏移）的计算只看几何属性：位置、尺寸。颜色变化再大，元素占的地方不变，CLS 就是 0。把 <code>width</code>、<code>height</code>、<code>margin</code>、<code>padding</code>、<code>transform</code> 里的任何一项塞进 transition，切换主题的 280ms 里布局会连续重排，读者正在读的那行字可能移动几次。</p>
<p>主题切换在语义上只该改变配色——深浅、强调色、底色。如果某套主题的按钮圆角或字号和另一套不同，那些差异应该在主题 CSS 加载完、data-theme 改掉的那一刻<strong>一次性生效</strong>，不参与渐变。混进过渡会把「换肤」变成「动画重排」，代价远大于那点顺滑感。</p>
<p><code>.28s</code> 是个折中：低于 200ms 人眼看不出过渡，高于 400ms 会觉得切换迟钝。0.28s 刚好能在不改变阅读节奏的前提下让颜色有来路。400ms 的兜底定时比它长 120ms，留出事件派发和定时器抖动的余量。</p>
<h2 id="三-transitionend-什么时候不来"><a class="h-anchor" href="#三-transitionend-什么时候不来">#</a>三、transitionend 什么时候不来</h2>
<p>摘 class 的第一选择是监听 <code>transitionend</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">animOff = (e) =&gt; {
  <span class="tok-k">if</span> (e.target === ROOT &amp;&amp; (e.propertyName === <span class="tok-s">&#39;color&#39;</span> || e.propertyName === <span class="tok-s">&#39;background-color&#39;</span>)) <span class="tok-f">done</span>();
};
ROOT.<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;transitionend&#39;</span>, animOff);</code></pre></div>
<p>但 <code>transitionend</code> 有三个坑，每一个都真实发生过。</p>
<p><strong>坑一：没有过渡就没有事件。</strong> 如果主题 CSS 还没加载完，<code>var(--bg)</code> 的值没变；或者切换前后两个主题的背景色恰好相同（比如只换风格不换明暗，<code>paper</code> 和 <code>ink</code> 的浅色底很接近），浏览器认为计算值没变化，不会启动 transition，自然也不发 <code>transitionend</code>。这时 class 会永远留在 html 上——页面变成「常驻 transition」，绕回第一节那个闪屏问题。</p>
<p><strong>坑二：子元素事件会冒泡上来。</strong> 前面给整棵子树都挂了过渡，所以卡片、按钮各自都会发 <code>transitionend</code>，这些事件冒泡到 html。<code>e.target === ROOT</code> 把子元素的事件挡掉，只认根元素自己触发的那一次。<code>propertyName</code> 再限定为 <code>color</code> 或 <code>background-color</code>，避免 border、transform 之类混进来——虽然当前 CSS 没过渡这些属性，但别人以后加了不该误触发。</p>
<p><strong>坑三：连续切换的旧回调。</strong> 用户快速点两次主题，第一次的 <code>transitionend</code> 可能在第二次过渡中间到达，把第二次刚挂上的 class 摘掉。所以每次开始都要先清理：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (animOff) { ROOT.<span class="tok-f">removeEventListener</span>(<span class="tok-s">&#39;transitionend&#39;</span>, animOff); animOff = <span class="tok-k">null</span>; }
<span class="tok-f">clearTimeout</span>(animTimer);
ROOT.classList.<span class="tok-f">add</span>(<span class="tok-s">&#39;theme-transition&#39;</span>);</code></pre></div>
<p><code>done()</code> 里也要再清一遍监听和定时器，防止重复触发：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> done = () =&gt; {
  ROOT.classList.<span class="tok-f">remove</span>(<span class="tok-s">&#39;theme-transition&#39;</span>);
  <span class="tok-k">if</span> (animOff) { ROOT.<span class="tok-f">removeEventListener</span>(<span class="tok-s">&#39;transitionend&#39;</span>, animOff); animOff = <span class="tok-k">null</span>; }
  <span class="tok-f">clearTimeout</span>(animTimer);
};</code></pre></div>
<p>兜底定时器是最后一招：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">animTimer = <span class="tok-f">setTimeout</span>(done, <span class="tok-n">400</span>);</code></pre></div>
<p>它和 <code>transitionend</code> 是或的关系——谁先到谁先摘，另一个被 <code>done()</code> 清掉。这套双保险不是为了「更保险一点」，是因为两种故障各有各的触发条件，单独靠哪一个都会在某一类场景下失效。</p>
<h2 id="四-按需加载主题-css-的顺序"><a class="h-anchor" href="#四-按需加载主题-css-的顺序">#</a>四、按需加载主题 CSS 的顺序</h2>
<p>本站七套主题，只有纸韵（<code>paper</code>）和安知鱼（<code>anzhiyu</code>）编在主样式表里，其余五套在 <code>/theme/&lt;id&gt;.css</code>。切到一个没加载过的主题时，顺序很关键：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">ensureThemeCss</span>(theme) {
  <span class="tok-k">if</span> (theme === <span class="tok-s">&#39;paper&#39;</span> || theme === <span class="tok-s">&#39;anzhiyu&#39;</span>) <span class="tok-k">return</span> Promise.<span class="tok-f">resolve</span>();
  <span class="tok-k">const</span> id = <span class="tok-s">`tcss-${theme}`</span>;
  <span class="tok-k">if</span> (document.<span class="tok-f">getElementById</span>(id)) <span class="tok-k">return</span> Promise.<span class="tok-f">resolve</span>();
  <span class="tok-k">return</span> <span class="tok-k">new</span> <span class="tok-f">Promise</span>((resolve) =&gt; {
    <span class="tok-k">const</span> l = document.<span class="tok-f">createElement</span>(<span class="tok-s">&#39;link&#39;</span>);
    l.id = id;
    l.rel = <span class="tok-s">&#39;stylesheet&#39;</span>;
    l.href = <span class="tok-s">`/theme/${theme}.css`</span>;
    l.onload = resolve;
    l.onerror = resolve;
    document.head.<span class="tok-f">appendChild</span>(l);
  });
}</code></pre></div>
<p><code>apply()</code> 里必须先拿到 CSS，再改 <code>data-theme</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> run = () =&gt; {
  <span class="tok-k">const</span> dark = mode === <span class="tok-s">&#39;dark&#39;</span> || (mode === <span class="tok-s">&#39;auto&#39;</span> &amp;&amp; <span class="tok-f">systemDark</span>());
  <span class="tok-f">flashTransition</span>();                          <span class="tok-c">// 挂临时 class</span>
  ROOT.<span class="tok-f">setAttribute</span>(<span class="tok-s">&#39;data-theme&#39;</span>, theme);     <span class="tok-c">// 这时变量才切过去</span>
  ROOT.<span class="tok-f">setAttribute</span>(<span class="tok-s">&#39;data-mode&#39;</span>, dark ? <span class="tok-s">&#39;dark&#39;</span> : <span class="tok-s">&#39;light&#39;</span>);
  <span class="tok-c">// ...</span>
};
<span class="tok-k">if</span> (document.<span class="tok-f">getElementById</span>(<span class="tok-s">`tcss-${theme}`</span>) || theme === <span class="tok-s">&#39;paper&#39;</span> || theme === <span class="tok-s">&#39;anzhiyu&#39;</span>) <span class="tok-k">return</span> <span class="tok-f">run</span>();
<span class="tok-f">ensureThemeCss</span>(theme).<span class="tok-f">then</span>(run);
<span class="tok-k">return</span> { theme, mode, dark: <span class="tok-c">/* 乐观值 */</span> };</code></pre></div>
<p>反过来会有一两帧「data-theme 已经变了，但新主题的 CSS 还没到」的窗口，页面用旧变量渲染新主题名，比闪一下白更难看。所以样式到位前不动 DOM。</p>
<p><code>l.onerror = resolve</code> 这一行是故意的：加载失败也放行，样式缺一份总比点按钮没反应强。用户点了没动静是最糟的体验，哪怕退回到上一套主题的配色，至少交互是通的。</p>
<p><code>flashTransition()</code> 放在 <code>run()</code> 里、<code>setAttribute</code> 之前——class 必须先挂上，颜色变化才会被捕获。顺序写反了，过渡不会产生，<code>transitionend</code> 不触发，就靠 400ms 兜底撑着，用户看到的是硬跳加一段多余的等待。</p>
<p><code>apply()</code> 在样式加载期间返回的是一个乐观值，这不是 bug：调用方要立刻更新选中态和 localStorage，不能等网络。真正可靠的当前值从 <code>pref()</code> 读，它优先读 localStorage，和 <code>syncUI()</code> 走同一套口径。</p>
<h2 id="五-reduced-motion-是第一道硬开关"><a class="h-anchor" href="#五-reduced-motion-是第一道硬开关">#</a>五、reduced-motion 是第一道硬开关</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">flashTransition</span>() {
  <span class="tok-k">if</span> (<span class="tok-f">matchMedia</span>(<span class="tok-s">&#39;(prefers-reduced-motion: reduce)&#39;</span>).matches) <span class="tok-k">return</span>;
  <span class="tok-c">// ...后面的监听、定时器、class 全都不跑</span>
}</code></pre></div>
<p>这一行放在函数最开头，后面所有逻辑都不执行——不挂 class、不监听、不设定时器。它的优先级高于一切：不管 CSS 里写了什么、不管主题怎么切，用户明确要求少动效，就一点动画都不给。</p>
<p>不这么做会影响前庭敏感人群。大幅的颜色渐变可能引发眩晕和恶心，<code>prefers-reduced-motion</code> 就是给这类用户的系统级开关。尊重它不是「锦上添花」，是无障碍基线。</p>
<p>CSS 里还有第二道：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">@media (prefers-reduced-motion: reduce) {
  html.theme-transition, html.theme-transition * { transition: none !important; }
}</code></pre></div>
<p>JS 那道防的是「已经 reduced-motion 就不启动」，CSS 这道防的是「切换中途用户打开了 reduced-motion」。两层夹死，不会有哪条路径漏过去。</p>
<h2 id="六-误判现场-无头-chrome-的默认降噪"><a class="h-anchor" href="#六-误判现场-无头-chrome-的默认降噪">#</a>六、误判现场：无头 Chrome 的默认降噪</h2>
<p>开头那个「测试通过了却什么都没测到」，根因在测试环境，不在实现。</p>
<p>想验的是「切换后 class 挂上、过渡结束摘掉」，断言逻辑很直白：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">await</span> page.<span class="tok-f">click</span>(<span class="tok-s">&#39;[data-theme-btn]&#39;</span>);
<span class="tok-k">await</span> page.<span class="tok-f">waitForFunction</span>(() =&gt; document.documentElement.dataset.theme !== oldTheme);
<span class="tok-k">const</span> during = <span class="tok-k">await</span> page.<span class="tok-f">evaluate</span>(() =&gt;
  document.documentElement.classList.<span class="tok-f">contains</span>(<span class="tok-s">&#39;theme-transition&#39;</span>));
assert.<span class="tok-f">equal</span>(during, <span class="tok-k">true</span>);
<span class="tok-k">await</span> <span class="tok-k">new</span> <span class="tok-f">Promise</span>((r) =&gt; <span class="tok-f">setTimeout</span>(r, <span class="tok-n">500</span>));
<span class="tok-k">const</span> after = <span class="tok-k">await</span> page.<span class="tok-f">evaluate</span>(() =&gt;
  document.documentElement.classList.<span class="tok-f">contains</span>(<span class="tok-s">&#39;theme-transition&#39;</span>));
assert.<span class="tok-f">equal</span>(after, <span class="tok-k">false</span>);</code></pre></div>
<p>第一次跑这组，过渡相关的断言怎么都对不上——<code>during</code> 拿不到 true，<code>after</code> 又一直是 false。第一反应是 <code>flashTransition()</code> 没被调用，或者 class 名写错了，照着实现查了一圈，代码是对的。</p>
<p>真正的原因藏在浏览器环境里：<strong>无头 Chrome 默认 <code>prefers-reduced-motion: reduce</code>。</strong> 也就是说，它替所有用户选了「减少动态效果」。<code>flashTransition()</code> 第一行就 return，class 从头到尾没挂过，后面那套 <code>transitionend</code> + 定时兜底根本没跑。我测的不是「过渡是否正常」，而是「降噪模式下是否跳过过渡」——代码在这条路径上完全正确，只是不是我想验的那条。</p>
<p>修法是显式把环境摆到目标状态：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">await</span> page.<span class="tok-f">emulateMediaFeatures</span>([
  { name: <span class="tok-s">&#39;prefers-reduced-motion&#39;</span>, value: <span class="tok-s">&#39;no-preference&#39;</span> },
]);</code></pre></div>
<p>加上这一行，同样那组断言才有意义。反过来说，如果目的是验降噪分支，就保留默认值、断言 class 始终不出现——两条路径要分开测，不能共用一组断言。</p>
<p>这个坑的形态是「现象像 A、根因在 B」：现象是过渡逻辑没生效，像实现写错了；根因是测试环境默认开了降噪。搜索价值也在这里——很多人遇到的是同一个现象，但会一路往 CSS 和事件监听上查。</p>
<p>同一批 14 项交互实测里，灯箱关闭那段也撞了同一个默认值：淡出被 CSS 的 <code>@media (prefers-reduced-motion: reduce)</code> 短路，180ms 的 <code>setTimeout</code> 没走，class 状态和预期不符。两处用的是同一个修法。验交互类功能之前，先把环境摆到目标状态——降噪、DPR、视口宽度、字体加载，哪一样都可能让代码走另一条分支。</p>
<h2 id="七-这套方案没覆盖的地方"><a class="h-anchor" href="#七-这套方案没覆盖的地方">#</a>七、这套方案没覆盖的地方</h2>
<p>有三处只到推断或者部分实测为止，写清楚免得别人误以为是经过完整验证的。</p>
<p><strong>第一处：CLS 为 0 是机制推断，不是这次单独测的数。</strong> 我只过渡 <code>color</code> 和 <code>background-color</code>，这两种属性不参与布局计算，因此不会触发重排——这是浏览器渲染模型的直接结论。线上性能基线里 CLS 确实是 0，但那个数字是整站多个优化共同的结果，没法单独归因给主题过渡。要严格证明得做 A/B：开过渡和关过渡各跑一遍 Lighthouse，对比 CLS。这次没做，只到「属性本身不引起布局偏移」这一层。</p>
<p><strong>第二处：0.28s 和 400ms 是经验值，没做过用户测试。</strong> 低于 200ms 看不出过渡、高于 400ms 觉得迟钝，这是常见的动画时长经验，不是对这个站读者做过实验得出的。400ms 兜底比 0.28s 长 120ms，这个余量是拍的——足够覆盖定时器抖动，但如果某个设备的 CSS 过渡因为掉帧拖到 500ms，兜底会提前摘掉 class，过渡硬生生断掉。这种情况我没在慢设备上复现过，属于已知但未量化的边界。</p>
<p><strong>第三处：连续切换只验了三次点击，没做压力测试。</strong> 测试里快速连点三次主题按钮，等 1 秒，class 已经摘掉。这验证了旧监听和旧定时器被清理的路径，但没测过十次、二十次连续切换，也没测过切换过程中主题 CSS 还在下载的情况。代码上每次都先撤旧监听再挂新的，逻辑上不会累积，但这是读代码的结论，不是压测数据。</p>
<p>把这三处写出来不是自曝其短。这个站的文章底线是「一个别处没有的东西」，而这个东西必须是真的——把推断标成实测，整篇的可信度就垮了。11-18 那篇把标题里的 549→96 拆成三个实验的归因，也是同一个道理。</p>
<h2 id="八-一个相关细节-theme-color"><a class="h-anchor" href="#八-一个相关细节-theme-color">#</a>八、一个相关细节：theme-color</h2>
<p>顺带记一个相关细节：<code>theme-color</code> meta 跟着主题走，是在 <code>run()</code> 里读 <code>--bg</code> 变量写回去的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> bg = <span class="tok-f">getComputedStyle</span>(ROOT).<span class="tok-f">getPropertyValue</span>(<span class="tok-s">&#39;--bg&#39;</span>).<span class="tok-f">trim</span>();
<span class="tok-k">if</span> (bg) meta.<span class="tok-f">setAttribute</span>(<span class="tok-s">&#39;content&#39;</span>, bg);</code></pre></div>
<p>这行必须在 <code>data-theme</code> 改完之后执行，读到的才是新主题的底色。顺序反了，手机地址栏会留着上一主题的颜色，浅色模式下尤其刺眼。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p><strong>1. 确认没有常驻 transition。</strong> 在浏览器 DevTools 里搜 <code>body { transition</code>，应该搜不到任何给 body 或全局元素常驻挂 <code>color/background-color</code> 过渡的规则。只有 <code>html.theme-transition</code> 那一条临时规则。</p>
<p><strong>2. 手动切一次，看 class 的生命周期。</strong> 打开 DevTools Elements 面板，盯着 <code>&lt;html&gt;</code> 节点，点主题切换。应当看到 <code>theme-transition</code> 出现，大约 280ms 后消失。切完之后这个 class 不能再留在节点上。</p>
<p><strong>3. 验异步加载路径。</strong> 先清掉 <code>/theme/*.css</code> 的缓存，切到一个从没加载过的主题（比如「暮紫」）。等 CSS 加载完、<code>data-theme</code> 变了之后，class 仍应能正常摘掉。这一步专门覆盖 <code>transitionend</code> 不来、靠 400ms 兜底的场景。</p>
<p><strong>4. 验同色切换。</strong> 在两个背景色接近的主题之间来回切（只换风格不换明暗）。颜色没变，不会有 <code>transitionend</code>，400ms 兜底必须把 class 摘掉。</p>
<p><strong>5. 验连续点击。</strong> 快速连点三次主题按钮，等 1 秒。class 必须已经摘掉——如果还在，说明上一次的回调或定时器没清干净。</p>
<p><strong>6. 验降噪。</strong> DevTools → Rendering → 勾选 <code>prefers-reduced-motion: reduce</code>，再切一次主题。颜色应该瞬间变，没有任何渐变；<code>&lt;html&gt;</code> 上也不该出现 <code>theme-transition</code>。</p>
<p><strong>7. 跑守门测试。</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> scripts/test-ux-extras.mjs   <span class="tok-c"># 主题过渡那组断言</span>
<span class="tok-k">node</span> scripts/test-theme.mjs       <span class="tok-c"># 七套主题样式直出与边界</span></code></pre></div>
<p>第一组锁住「临时 class + transitionend + 定时兜底 + 只过渡颜色 + 无常驻 body transition」这些实现约束，第二组锁住主题样式表的直出规则——七套里只有两套不发 link，未知主题名不许拼进 <code>href</code>。两组一起绿，才算这条链路没被回退。</p>', '', 'tools', '常驻 body transition 会让首屏和按需加载主题 CSS 时闪一下。改成切换时才挂的 html.theme-transition，只过渡颜色不动布局；transitionend 在异步加载/同色时不触发，留 400ms 定时兜底。无头 Chrome 默认降噪会让过渡测试误判。',
        '', 0, 0, 0, 1, '2026-12-21 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('css') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'theme-transition-class' AND t.name = 'css';
INSERT INTO tags (name) VALUES ('javascript') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'theme-transition-class' AND t.name = 'javascript';
INSERT INTO tags (name) VALUES ('testing') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'theme-transition-class' AND t.name = 'testing';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'theme-transition-class' AND t.name = 'debugging';
