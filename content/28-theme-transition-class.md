## 结论

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
  if (e.target === ROOT && (e.propertyName === 'color' || e.propertyName === 'background-color')) done();
};
ROOT.addEventListener('transitionend', animOff);
```

但 `transitionend` 有三个坑，每一个都真实发生过。

**坑一：没有过渡就没有事件。** 如果主题 CSS 还没加载完，`var(--bg)` 的值没变；或者切换前后两个主题的背景色恰好相同（比如只换风格不换明暗，`paper` 和 `ink` 的浅色底很接近），浏览器认为计算值没变化，不会启动 transition，自然也不发 `transitionend`。这时 class 会永远留在 html 上——页面变成「常驻 transition」，绕回第一节那个闪屏问题。

**坑二：子元素事件会冒泡上来。** 前面给整棵子树都挂了过渡，所以卡片、按钮各自都会发 `transitionend`，这些事件冒泡到 html。`e.target === ROOT` 把子元素的事件挡掉，只认根元素自己触发的那一次。`propertyName` 再限定为 `color` 或 `background-color`，避免 border、transform 之类混进来——虽然当前 CSS 没过渡这些属性，但别人以后加了不该误触发。

**坑三：连续切换的旧回调。** 用户快速点两次主题，第一次的 `transitionend` 可能在第二次过渡中间到达，把第二次刚挂上的 class 摘掉。所以每次开始都要先清理：

```js
if (animOff) { ROOT.removeEventListener('transitionend', animOff); animOff = null; }
clearTimeout(animTimer);
ROOT.classList.add('theme-transition');
```

`done()` 里也要再清一遍监听和定时器，防止重复触发：

```js
const done = () => {
  ROOT.classList.remove('theme-transition');
  if (animOff) { ROOT.removeEventListener('transitionend', animOff); animOff = null; }
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
  if (theme === 'paper' || theme === 'anzhiyu') return Promise.resolve();
  const id = `tcss-${theme}`;
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.id = id;
    l.rel = 'stylesheet';
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
  const dark = mode === 'dark' || (mode === 'auto' && systemDark());
  flashTransition();                          // 挂临时 class
  ROOT.setAttribute('data-theme', theme);     // 这时变量才切过去
  ROOT.setAttribute('data-mode', dark ? 'dark' : 'light');
  // ...
};
if (document.getElementById(`tcss-${theme}`) || theme === 'paper' || theme === 'anzhiyu') return run();
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
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
await page.click('[data-theme-btn]');
await page.waitForFunction(() => document.documentElement.dataset.theme !== oldTheme);
const during = await page.evaluate(() =>
  document.documentElement.classList.contains('theme-transition'));
assert.equal(during, true);
await new Promise((r) => setTimeout(r, 500));
const after = await page.evaluate(() =>
  document.documentElement.classList.contains('theme-transition'));
assert.equal(after, false);
```

第一次跑这组，过渡相关的断言怎么都对不上——`during` 拿不到 true，`after` 又一直是 false。第一反应是 `flashTransition()` 没被调用，或者 class 名写错了，照着实现查了一圈，代码是对的。

真正的原因藏在浏览器环境里：**无头 Chrome 默认 `prefers-reduced-motion: reduce`。** 也就是说，它替所有用户选了「减少动态效果」。`flashTransition()` 第一行就 return，class 从头到尾没挂过，后面那套 `transitionend` + 定时兜底根本没跑。我测的不是「过渡是否正常」，而是「降噪模式下是否跳过过渡」——代码在这条路径上完全正确，只是不是我想验的那条。

修法是显式把环境摆到目标状态：

```js
await page.emulateMediaFeatures([
  { name: 'prefers-reduced-motion', value: 'no-preference' },
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
const bg = getComputedStyle(ROOT).getPropertyValue('--bg').trim();
if (bg) meta.setAttribute('content', bg);
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
