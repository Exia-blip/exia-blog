## 结论

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
content-security-policy: default-src 'self'; script-src 'self' 'nonce-e1022201…'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
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
out.push(`<figure class="md-img">${inline(line.trim())}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`);
```

这个结构本来就在，不是为了灯箱造的——它是图片居中和图注排版的容器。灯箱直接借用它：

```js
// public/post.html，事件委托挂在正文根节点上
body.addEventListener('click', (e) => {
  const img = e.target.closest('.md-img img');
  if (!img) return;
  e.preventDefault();
  openLb(img.currentSrc || img.src, img.alt);
});
```

`closest('.md-img img')` 一条选择器就划清了边界：正文里独立成行的图能点，行内图不触发，图注文字点击也冒泡到同一张图。没有新属性、没有新的 DOM 结构、没有服务端改动。

我认真想过加 `data-light` 的代价。这篇文章的 `html_content` 是发布时算好写进 D1 的，读取侧虽然有 `html_content || renderBody()` 兜底，但那是保险，不该常态化触发。改 `md.js` 意味着所有存量文章要重算一遍 HTML 和封面，这不是一个按钮该掀起的动静。而且一旦加了标记，样式、测试、文档都要跟着维护一个「哪些图可点」的清单；现在这套靠结构区分，Markdown 怎么变，规则都自动跟着变。

真正的判断标准是：**如果选择器能表达这条规则，就不要往 SSR 输出里加东西。** 服务端渲出的字节一旦改了，ETag、缓存、回填三件事全部被牵连；客户端补的钩子只影响访客浏览器，改错了刷新就好。这两边的改动成本差一个数量级。

事件委托还有个附带好处：`hydrate()` 只跑一次，正文里后来插进来的图片也自动可点。不用在每次重渲染后重新绑定，也不用担心重复绑定。

## 三、懒创建：首屏一个字节都不给灯箱

灯箱的 DOM 不是写在 HTML 里的，是第一次点击时才造：

```js
let lb = null;
function ensureLb() {
  if (lb) return lb;
  const wrap = document.createElement('div');
  wrap.className = 'lb';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', '图片预览');
  wrap.setAttribute('aria-modal', 'true');
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
wrap.addEventListener('click', (e) => {
  if (e.target === wrap || e.target === stage || e.target.closest('.lb-close')) closeLb();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) closeLb(); });
```

点击那行刻意写成三个条件的或：`e.target === wrap` 是点蒙层空白处，`e.target === stage` 是点图片周围的留白，`closest('.lb-close')` 是点右上角按钮。不写 `!closest('.lb-img')` 之类的反向判断，是因为图片本身点了不该关——用户放大图片往往就是想凑近看，点一下就消失很恼人。

移动端上滑是后加的：

```js
let ty0 = null;
stage.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { ty0 = null; return; }
  ty0 = e.touches[0].clientY;
}, { passive: true });
stage.addEventListener('touchend', (e) => {
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
  lb.wrap.classList.remove('on');
  document.documentElement.style.overflow = '';
  const hide = () => { lb.wrap.hidden = true; };
  // reduced-motion 下没有淡出过渡，直接隐藏，别留一个看不见还吃事件的层
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) hide();
  else setTimeout(hide, 180);
}
```

CSS 里 `.lb { opacity: 0; transition: opacity .18s ease; }`，`.lb.on { opacity: 1; }`。关的时候摘掉 `on`，180ms 内 opacity 从 1 走到 0，然后 `hidden = true`。时间常数两边必须对齐——JS 的 180 和 CSS 的 `.18s` 是同一个数。哪边改了另一边没跟上，就会出现「还没淡完就被隐藏」或者「淡完了还挡着」。`document.documentElement.style.overflow = 'hidden'` 在打开时锁住背景滚动，关闭时立刻解锁，不用等淡出结束——用户关掉浮层的瞬间就该能继续滚页面。

最阴的是 reduced-motion 那个分支。系统开了「减少动态效果」之后，CSS 里 `.lb { transition: none }`，根本没有淡出。如果 JS 还是等 180ms 才设 `hidden`，这 180ms 里浮层已经完全透明，但 `display: grid` 还在，鼠标和触摸全被它吃掉，页面像卡死了一样。所以 reduced-motion 下必须直接 `hide()`，不是「顺便优化」，是修一个真 bug。

写测试的时候踩了一个反过来的坑：无头 Chrome 默认就是 `prefers-reduced-motion: reduce`。我第一次跑 Puppeteer，断言「关闭 250ms 后浮层 hidden」通过了，但想验的那条 180ms 淡出其实根本没跑——环境替我把分支短路了。后来在测试开头显式加：

```js
await page.emulateMediaFeatures([
  { name: 'prefers-reduced-motion', value: 'no-preference' },
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
curl -s "https://你的域名/p/任意文章?cb=$RANDOM" | grep -c 'data-light'
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
