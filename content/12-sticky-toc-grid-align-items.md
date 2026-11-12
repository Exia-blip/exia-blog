## 结论

目录不跟着滚，跟 `position: sticky` 本身没关系。问题是**它所在的那一格太矮**。

`.post-article` 是 grid，目录那一格写了 `align-items: start`。Grid 的默认值其实是 `stretch`，`start` 是写卡片列表时留下的肌肉记忆——列表里不希望每张卡被拉成一样高。放到两栏布局上，这条习惯让目录格的高度等于自身内容高度：**336px**。

sticky 的活动范围以包含块为界。包含块只有 336px 高，滚过 336px 之后目录就跟着文章一起出了视口。滚动高亮是另一套逻辑，照常工作，所以现象看起来像"目录在动，位置不动"——这大概是最容易误判成"sticky 没生效"的形态。

同一篇文章、同一份 CSS，只把这一个属性改回 `stretch`：

| 指标 | `align-items: start` | `align-items: stretch` |
|---|---|---|
| `.post-toc` 高度 | 336px | 12939px |
| 滚到 35%（scrollY 4272）时目录顶端 | −4172px | 86px |
| 滚到 60%（scrollY 7324）时目录顶端 | −7224px | 86px |

改的是一个关键字，多出来的是 12603px 的可滚余量。下面是完整过程，以及修好之后才浮出来的四处连带问题。

## 一、先量，不猜

现象是读者反馈的一句话：「目录能不能跟着文章动」。这种描述信息量为零——可能是没吸顶、可能是吸顶了但不高亮、可能是高亮错了。先量。

```js
// 无头浏览器里对线上页面直接量，不靠肉眼
const box = await page.evaluate(() => {
  const art = document.querySelector('.post-article');
  const toc = document.querySelector('.post-toc');
  const inner = document.querySelector('.toc-inner');   // 真正 sticky 的那层
  const r = (el) => el.getBoundingClientRect();
  return {
    artH: Math.round(r(art).height),
    tocH: Math.round(r(toc).height),
    innerH: Math.round(r(inner).height),
    innerTop: Math.round(r(inner).top),
  };
});
```

第一次量到的四个数：`artH 12979`、`tocH 336`、`innerH 336`、滚到 35% 时 `innerTop −4172`。

这里有个关键对照：**文章容器 12979px，目录格 336px**。同一行的两个 grid item，一个撑满了整篇文章，另一个只有自己那么高。sticky 的余量就藏在这个差值里。

顺便用同一份 DOM 做了 A/B：注入一行 `align-items: start` 再量，其他什么都不动。数字就是上面那张表——同一页面、同一内容、同一个滚动位置，指针从 −4172 回到 86。

## 二、sticky 的天花板是父容器，不是视口

`position: sticky` 的定位过程分两段：先按正常流站位，再在滚动时把元素"粘"住，但**粘的范围不能超过它的包含块**。包含块一旦滚完，元素就跟着一起走。

所以一个 sticky 元素实际能固定的距离是：

```
可固定距离 = 包含块高度 − 自身高度
```

目录格 336px、目录自身 336px，相减是 0。它不是"偶尔没粘住"，是从第一屏开始就没有可粘的空间——只不过页面顶部那一段本来也对得上，看不出问题。

这也解释了为什么在别的站上同样的代码是好的：他们的目录格被内容撑开了，或者本来就用了 `stretch`。这是一个**依赖父容器高度**的属性，抄代码抄不到父容器。

## 三、修法是两行

```css
/* 关键：grid item 必须 stretch 到整行高度，否则 sticky 没有可滚的余量。
   这不是"顺便对齐"，是 sticky 生效的前提。 */
.post-article {
  display: grid;
  grid-template-columns: 220px minmax(0, 800px);
  gap: 110px;
  align-items: stretch;          /* 默认值，但写出来，防止再被 start 覆盖 */
}

/* 目录外面那层只负责撑高，里面那层才吸顶 */
.post-toc { align-self: stretch; }

.post-toc .toc-inner {
  position: sticky;
  top: 86px;
  max-height: calc(100vh - 118px);
  overflow: auto;
}
```

两行里只有一行是必需的（`align-items: stretch`）。`align-self: stretch` 是重复声明，留着是为了将来有人在容器上改回 `start` 时，目录这一格不跟着塌——这种"防御性重复"在布局代码里值得写，因为改容器的人不会记得目录依赖它。

`.toc-inner` 内部再嵌一层的原因也在同一处：外层负责高度，内层负责吸顶。两件事分开，`max-height` 才好算。

## 四、修好之后才看见的第二层：高亮判据

目录能跟着滚了，问题立刻变成"高亮跟不上"。这里没用 `IntersectionObserver`，用的是最笨的一条线：

```js
const onScroll = () => {
  const line = window.scrollY + 96;             // 吸顶区下沿再往下一点
  let active = pairs[0][0];
  for (const [el, a] of pairs) {
    // 标题顶端在页面里的绝对位置，越过这条线就算"当前节"
    if (el.getBoundingClientRect().top + window.scrollY <= line) {
      active = el;
      activeLink = a;
    }
  }
  // …切换 class、更新进度条、滚动目录
};
```

不用 IO 的理由有两条：

1. **语义不对**。IO 回答的是"元素有没有进入视口"，我要的是"哪一条标题是最后一条越过吸顶线的"。一节长两千字，进入视口的那一刻和读完的那一刻差很远。
2. **会同时命中多个**。可见区里经常并排两三个 h2，IO 的回调只告诉你"这两个都在"，排序还得自己做。既然要遍历，不如一开始就遍历。

代价是每个 `scroll` 事件都要算一次 `getBoundingClientRect()`。8 个标题的规模下可以忽略，用 `requestAnimationFrame` 合并一帧内的多次事件就够：

```js
let raf = 0;
const onEvt = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; onScroll(); }); };
addEventListener('scroll', onEvt, { passive: true });
```

## 五、进度条：端点停在当前项的中点

左侧那条跟着走的色条不是独立算的，它借用了同一次计算的结果：

```js
const li = activeLink.closest('li');
const oR = ol.getBoundingClientRect();
const lR = li.getBoundingClientRect();
// 高度占比 = 当前项中点相对目录顶部的距离
const p = ((lR.top + lR.height / 2 - oR.top) / oR.height) * 100;
ol.style.setProperty('--toc-p', Math.max(0, Math.min(100, p)) + '%');
```

CSS 侧只是一条 `::before`，高度吃这个变量，`transition: height .18s` 让它是滑过去而不是跳过去：

```css
.post-toc ol { position: relative; border-left: 1px solid var(--line); }
.post-toc ol::before {
  content: ''; position: absolute; left: -1px; top: 0; width: 2px;
  height: var(--toc-p, 0%);
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  transition: height .18s ease-out;
}
```

实测量到的五个点：

| 滚动位置 | scrollY | `--toc-p` | 高亮项 |
|---|---|---|---|
| 顶部 | 0 | 7.4% | 01 |
| 35% | 4272 | 37.0% | 03 |
| 60% | 7324 | 51.7% | 04 |
| 95% | 11597 | 87.0% | 07 |
| 底部 | 12207 | 95.7% | 08 |

读到底时进度条停在 95.7% 而不是 100%，因为端点算的是最后一项的**中点**，不是目录底部。这是刻意的：条拉满意味着"下面还有"，停在最后一项的中点意味着"到头了"。

## 六、到底兜底：最后一个标题永远越不过那条线

这一条不做，前五条的效果全废。

判据是"标题顶端越过 `scrollY + 96`"。但最后一节往往只占屏幕下半部分，它的顶端在页面里的位置可能离页底只有 700px——滚到最底，`scrollY + 96` 仍然追不上它。表现就是：读完全文，目录还停在第 7 项。

```js
const atBottom = Math.ceil(window.scrollY + innerHeight)
                 >= document.documentElement.scrollHeight - 2;
```

到底了就直接认最后一项，跳过整段遍历。实测滚到 100% 时高亮是 08，进度 95.7%，两项都对得上。

另一个思路是给正文加 `padding-bottom: 100vh`，让最后一个标题能真正越过判据线。没采用：每篇文章末尾都会多出一大块空白，短文尤其明显，而且要按文章长度调。一行 `if` 能解决的事，不值得换一段留白。

## 七、目录自己也会滚

标题一多，目录比视口还高。这时 sticky 之外还要加一层：目录内部滚动。

```css
.post-toc .toc-inner {
  position: sticky; top: 86px;
  max-height: calc(100vh - 118px);   /* 86 顶部 + 32 底部余量 */
  overflow: auto;
  scrollbar-width: thin;
}
```

往里滚的时候不能让高亮项跑出可视区，所以每次切换都把它拉回来。注意这段只动**目录自己的 `scrollTop`**：

```js
const keepVisible = (a) => {
  const box = scrollerOf(a);                 // 最近的 overflow: auto 祖先
  if (!box) return;
  const br = box.getBoundingClientRect();
  const ar = a.getBoundingClientRect();
  const pad = br.height * 0.28;              // 上下各留 28% 缓冲
  if (ar.top < br.top + pad) box.scrollTo({ top: box.scrollTop - (br.top + pad - ar.top), behavior: 'smooth' });
  else if (ar.bottom > br.bottom - pad) box.scrollTo({ top: box.scrollTop + (ar.bottom - (br.bottom - pad)), behavior: 'smooth' });
};
```

第一版写的是 `a.scrollIntoView({ block: 'center' })`。它会把**页面**也一起滚一下（`scrollIntoView` 不区分容器），于是滚动事件再触发一次高亮计算，页面开始自己抖。改成只操作容器 `scrollTop` 就干净了。

留 28% 缓冲而不是 `center`，是为了让下一项也露出来——读者能看到"后面还有"，而不是每次只剩当前这一行。

## 八、点击落点要对齐吸顶区

能滚、能高亮之后，还剩一个体感问题：点目录跳过去，标题要么被吸顶条盖住一截，要么离得太远。

这里有三个数字必须成对出现：

| 参数 | 值 | 作用 |
|---|---|---|
| 顶栏高度 | 72px + 阅读进度条 2px | 吸顶区实际占 74px |
| `.toc-inner` 的 `top` | 86px | 目录停在吸顶区下方 12px |
| 标题的 `scroll-margin-top` | 88px | 锚点跳转后标题离视口顶 88px |

实测点第 5 项，跳转后标题的 `getBoundingClientRect().top` 正好是 **88**，和 `scroll-margin-top` 一致：

```css
/* 锚点跳转时浏览器会把这 88px 让出来，标题不会藏进吸顶条 */
.md h2, .md h3, .md h4 { scroll-margin-top: 88px; }
```

只调其中一个就会露馅：`top` 调到 120 而 `scroll-margin-top` 还是 88，点完标题会钻进目录上方那条缝里；反过来则会在标题上方留一大片空。

## 九、手机上不 sticky，换成抽屉

窄屏没有左侧那 220px，硬塞目录会把正文压到 300px 以下。所以 1080 以下直接 `display: none`，另起一套：右下角一个悬浮按钮，点开是底部抽屉。

实现上没重算任何东西，直接把桌面那份链接复制过去：

```js
const src = document.querySelectorAll('.post-toc a[data-toc]');
const items = [...src].map((a) =>
  // href 照抄桌面那条：SSR 里是 #中文id，自己再 encodeURI 一遍会变成两种地址
  `<a href="${a.getAttribute('href')}" data-toc="${a.dataset.toc}">${a.innerHTML}</a>`
).join('');
```

几个细节：

- 按钮在滚过文章头部之后才浮出来（`opacity 0 → 1`），第一屏不挡内容。
- 打开时给 `html` 加 `overflow: hidden`，否则背景还能滚，抽屉跟着页面飘。
- 点条目时**先关抽屉再让浏览器跳转**。顺序反了的话，`overflow: hidden` 还在，锚点跳转会被吞掉。
- Esc、点遮罩、点关闭都能收。

390×844 实测：初始按钮 `opacity 0`、`pointer-events: none`；滚动后 `opacity 1`，标签显示「目录 8」；点开抽屉 8 项齐全，`html` 的 `overflow` 变 `hidden`，当前项已高亮。

## 十、边界，明说

1. **目录只收 h2**。h3 收进来会到 20 项以上，扫起来比手动找还慢。长文里 h3 是段落内的小标题，不该进导航。
2. **锚点 id 是中文**（`#封-ip-一键连坐-而不是单点删除`），分享出去的链接百分号编码后很长。改成短 id 会让已有外链全部失效，不动。
3. **无 JS 时**目录仍然能点（链接是 SSR 出来的），但没有高亮、没有进度条、也没有手机抽屉。
4. **打印时**整块目录 `display: none`，正文全宽——纸上不需要导航。
5. **目录超过一屏**靠内部滚动；如果哪天某篇有 40 个小节，得做分组折叠，现在没做。

## 一条清单

下次再给页面加侧边目录，按这个顺序检查：

1. 先量 sticky 元素的**父容器**高度，不是它自己的。`可固定距离 = 父高 − 自身高`，这个差值是 0 就一定是坏的。
2. grid / flex 里看 `align-items` 和 `align-self`。默认 `stretch`，被改成 `start` 就等于砍掉了 sticky 的余量。
3. 点击落点用 `scroll-margin-top`，和吸顶的 `top` 一起调，两个数字必须对得上。
4. 滚到底要单独兜底。最后一个标题通常越不过判据线，这是结构问题，不是阈值没调好。
5. 内部滚动只动容器，别用 `scrollIntoView`——它会把整个页面也拖一下。

这一篇里真正难的不是 sticky，是**"看着像样式问题"的直觉**。目录不动、高亮在动，第一反应都是去查 sticky 的语法或者 z-index。查语法永远查不出来，因为语法没错；错的是它脚下那块地只有 336px 高。

#css #layout #browsers
