# Exia Blog

跑在 Cloudflare 全家桶上的博客系统。Workers + D1 + R2 + 静态资源，没有服务器，不需要备案，一个解析到 Cloudflare 的域名就能上线。

## 功能

| 能力 | 实现 |
|---|---|
| GitHub OAuth 登录 | 第一个登录的用户自动成为管理员，其余为普通用户 |
| 文章写作 / 编辑 | Markdown 编辑器，左右分栏实时预览，内置零依赖语法高亮 |
| 本地实时保存 | 每次输入即写 `localStorage`，按文章 ID 分键，多篇互不覆盖 |
| 服务端自动保存 | 停止输入 3 秒自动落库，`Ctrl/Cmd + S` 立即保存 |
| 私密文章 | 仅作者可见，未登录访问返回 404 |
| 图片上传 | 拖拽或粘贴，SigV4 直传 R2（S3 兼容），自动插入 Markdown |
| 文章别名 | 设为 `about` 即可通过 `/about` 访问 |
| 不列入首页 | 仍在线上可直达，只是不出现在列表 |
| 友链 | Cron 每 20 分钟巡检，卡片上亮状态小圆点 |
| 评论 | 两级回复树，游客可评，管理员可删，博主身份标记 |
| Webhook 通知 | 新评论 POST 到指定地址，兼容企业微信 / 飞书 / Slack / Discord |
| 自动头图 | 正文第一张图片自动作为列表缩略图 |
| 分类 | 一篇文章一个分类，编辑器侧栏填写，首页分类条筛选 `/cat/名字` |
| 自动标签 | 正文写 `#博客 #部署` 自动解析，支持筛选与计数 `/tag/名字` |
| 栏目总览 | `/categories` 汇总全部分类与标签及篇数 |
| 归档 | `/archive` 按年月倒序，时间线 / 紧凑两种视图，年份筛选 `/archive/2026` |
| 搜索 | 标题 + 正文关键词，分页列表 |
| 风格主题 | 7 套预设（安知鱼 / 纸韵 / 水墨 / 苔原 / 静海 / 暮紫 / 终端），读者自选，浅色·深色·跟随系统三档 |
| 站点头像 | 导航栏左上角圆形头像，后台可上传 / 拖拽 / 粘贴 / 填外链，兼作 favicon |
| AI 摘要 | 保存/发布时自动生成导语，文章页顶部展示，同时作为列表简介、SEO description 与 RSS 描述；可手动改写或重新生成 |

额外：RSS、sitemap、移动端适配、文章内 `#标签` 自动转为可点击链接。

## 目录结构

```
exia-blog/
├── wrangler.jsonc      # Workers / D1 / R2 / Cron 绑定
├── schema.sql          # D1 建表
├── cors.json           # R2 CORS（图片直传需要）
├── src/
│   ├── index.js        # 入口：路由、SSR meta / 主题注入、图片代理、RSS
│   ├── api.js          # 全部 API
│   ├── auth.js         # GitHub OAuth + 签名会话
│   ├── s3.js           # R2 presigned PUT（SigV4，纯 WebCrypto）
│   ├── cron.js         # 友链巡检
│   ├── webhook.js      # 评论通知
│   ├── ai.js           # AI 摘要：Workers AI / 外部接口 / 抽取式兜底
│   ├── settings.js     # 站点名 / 介绍 / 头像 / 默认风格（D1 覆盖 vars）
│   └── utils.js        # cookie / token / 分页
└── public/
    ├── md.js           # Markdown 渲染器（前后端同构，预览与线上一致）
    ├── theme.js        # 7 套风格定义 + 切换面板
    ├── app.js          # 前端公共层
    ├── style.css       # 变量体系：主题 × 明暗
    ├── index.html      # 首页 / 搜索 / 标签
    ├── post.html       # 文章 + 评论
    ├── editor.html     # 编辑器
    ├── login.html
    ├── friends.html
    └── 404.html
```

---

## 部署

### 0. 前置

- Cloudflare 账号，域名 NS 已托管到 Cloudflare
- Node.js 18+
- 一个 GitHub 账号（用来建 OAuth App）

```bash
cd exia-blog
npm install
npx wrangler login
```

### 1. 建 D1 数据库

```bash
npx wrangler d1 create blog-db
```

把输出里的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`。

### 2. 建 R2 桶

```bash
npx wrangler r2 bucket create blog-images
```

### 3. 初始化表结构

```bash
npx wrangler d1 execute blog-db --remote --file=./schema.sql
```

### 4. 建 GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App

- **Homepage URL**：`https://你的域名`
- **Authorization callback URL**：`https://你的域名/auth/callback`

拿到 Client ID 和 Client Secret。

### 5. 改 `wrangler.jsonc` 里的 vars

```jsonc
"vars": {
  "SITE_NAME": "Exia Blog",
  "SITE_DESC": "一句话简介",
  "SITE_ORIGIN": "https://你的域名",   // 只写 scheme + host，不要带路径和末尾斜杠
  "GITHUB_CLIENT_ID": "你的 Client ID",
  "R2_PUBLIC_BASE": ""
}
```

想绑定自定义域名，加上：

```jsonc
"routes": [{ "pattern": "你的域名/*", "zone_name": "你的域名" }]
```

### 6. 写 secrets

```bash
# 必填：会话签名密钥，随便生成一串
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put SESSION_SECRET

# 必填：GitHub OAuth App 的 Client Secret
npx wrangler secret put GITHUB_CLIENT_SECRET

# 可选：配了就启用 R2 直传（不配则走 Worker 中转，一样能用）
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_BUCKET_NAME

# 可选：新评论通知
npx wrangler secret put WEBHOOK_URL
```

R2 的 Access Key 在 Cloudflare 控制台 → R2 → Manage R2 API Tokens → Create API token（权限选 Object Read & Write），拿到 Access Key ID 和 Secret Access Key。

### 7. 配置 R2 CORS（仅启用直传时需要）

把 `cors.json` 里的域名改成你的，然后：

```bash
npx wrangler r2 bucket cors put blog-images --file=./cors.json
```

### 8. 部署

```bash
npx wrangler deploy
```

打开 `https://你的域名/login`，用 GitHub 登录。**第一个登录的人自动成为管理员。**

---

## 后台

登录后顶部只有一个 **后台** 入口（`/editor`），页面里同时包含：

- 写作区：Markdown 编辑 + 实时预览 + 自动保存
- 侧栏「我的文章」：切换/新建/删除
- 侧栏「分类」：填一个分类名，已存在的分类会在输入时提示（datalist）
- 侧栏「站点设置」（仅管理员）：改站点名、介绍、站点头像、默认风格与默认外观，存进 D1 的 `settings` 表，**即时生效，不用重新 deploy**

### 站点名称 / 站点描述

| 字段 | 出现在哪 |
|---|---|
| 站点名称 | 浏览器标签页标题（`首页` → 站名，其它页 `归档 · 站名`）、导航栏左侧、favicon 兜底首字母、RSS 频道名 |
| 站点描述 | 导航栏站名右侧的竖线后一句话（≤1080px 收窄、≤860px 整条隐藏）、首页 `<meta name="description">` / `og:description`、RSS 频道描述 |

两者都写进 D1 `settings` 表，改完刷新即生效。静态页的标题与 meta 由 Worker 注入（`src/index.js` 的 `fillSeo`，靠 HTML 里的 `<!--SEO-->` 占位），文章页仍用文章自身的标题与摘要。

### 站点头像

导航栏左上角那个圆形图标，四种设置方式，随便挑：

| 方式 | 操作 |
|---|---|
| 上传 | 点圆形虚线框选图，或点「上传图片」；单张限 4MB |
| 拖拽 | 把图片直接拖到圆形框上，边框变色即松手 |
| 粘贴 | 设置区展开、光标在里面时 `Ctrl+V` 直接粘图 |
| 外链 | 在输入框填 `https://…` 地址，边填边预览 |

上传的图存进 R2（`/img/…`），外链存原地址；两者都会写进 `settings.site_avatar`。
没设头像时导航显示站名首字母方块，不会留空。头像同时被用作：

- 浏览器 favicon（每个页面的 `<link rel="icon">`）
- 文章无封面时的 `og:image` 兜底

`SITE_NAME` / `SITE_DESC` / `SITE_THEME` / `SITE_MODE` 只是没设置过时的兜底默认值。

## 换域名

只改一处：`wrangler.jsonc` 的 `SITE_ORIGIN` 改成新域名（**只写 `https://host`，别带路径和斜杠**），然后 `npx wrangler deploy`。

```diff
- "SITE_ORIGIN": "https://old.example.com",
+ "SITE_ORIGIN": "https://new.example.com",
```

配套两件事：

1. **GitHub OAuth App** 的 Authorization callback URL 改成 `https://新域名/auth/callback` —— 这一步只能手动做，GitHub 只认登记的地址，不一致会返回 `redirect_uri MUST match` 错误页
2. 旧域名的会话 cookie 是 host-only 的，换域后必须重新登录一次，属正常现象

其它域名（旧 workers.dev、备用域）访问登录页会自动 302 到 `SITE_ORIGIN`，保证会话 cookie 落在同一个 host，不会出现"授权成功但后台还是未登录"。

卡住了打开 `https://你的域名/auth/status`，会直接告诉你当前算出来的回调地址：

```json
{"request_origin":"https://new.example.com","site_origin":"https://new.example.com",
 "redirect_uri":"https://new.example.com/auth/callback","client_id":"set","client_secret":"set"}
```

把 `redirect_uri` 原样填进 GitHub 即可。`SITE_ORIGIN` 里多写的斜杠、误加的 `/auth/callback` 尾巴都会被自动清掉。

## AI 摘要

文章保存（手动保存）或新建发布时，Worker 会读正文生成一段 60~110 字的中文导语，出现在：

- 文章页标题下方的导语块（左侧带强调色竖线）
- 首页 / 搜索 / 标签列表的简介（优先于正文截取）
- 文章页 `<meta name="description">`、`og:description`、RSS `<description>`

三种生成通道，按顺序尝试：

1. **Workers AI**（默认，`wrangler.jsonc` 里的 `ai.binding`）。默认模型 `@cf/qwen/qwen3-30b-a3b-fp8`，失败退 `llama-3.3-70b`，再退 `llama-3.1-8b`
2. **外部 OpenAI 兼容接口**：配 `AI_API_KEY`（+ 可选 `AI_API_BASE` / `AI_MODEL`），DeepSeek、Moonshot、自建网关都行
3. **抽取式兜底**：前两条都失败时截正文前 150 字，标签显示「摘要」而不是「AI 摘要」

控制逻辑：

- 正文指纹（`summary_hash`）没变就不重新生成，避免反复烧 token
- 编辑器里手动改过摘要 → 标记 `summary_src = manual`，之后 AI 不再覆盖
- 「清空」+ 保存 → 清掉标记，下次保存重新生成
- 生成走 `ctx.waitUntil`，不阻塞保存响应；编辑器点保存后会在后台把结果补进侧栏

## 风格主题

七套预设。`anzhiyu` 除了换变量，还有一层专属皮肤（悬浮胶囊导航、横幅、大圆角卡片、彩色标签、回到顶部），其余六套只换 CSS 变量、不改结构。

| id | 名字 | 气质 |
|---|---|---|
| `anzhiyu` | 安知鱼 | 蓝紫主色、悬浮胶囊导航、横幅 + 横向大图卡片，默认 |
| `paper` | 纸韵 | 暖白纸面 + 陶土橙 |
| `ink` | 水墨 | 纸白墨黑，正文转衬线，近直角 |
| `forest` | 苔原 | 米绿纸面 + 森林绿，圆角柔和 |
| `ocean` | 静海 | 冷白蓝调 + 靛蓝强调 |
| `plum` | 暮紫 | 淡紫纸面 + 梅色强调 |
| `mono` | 终端 | 灰阶 + 等宽字，硬边 |

- 读者：导航栏右侧调色板图标 → 选风格 / 选外观，存 `localStorage`（`x_theme` / `x_mode`），只影响本机
- 站长：后台「站点设置」里定**默认风格 / 默认外观**，给第一次来的读者用
- 首访不闪：Worker 把默认风格注入 `<head>` 的 `window.__THEME_DEFAULT__`，CSS 加载前就定好 `data-theme` / `data-mode`
- 深色不再依赖 `prefers-color-scheme`，改为显式 `html[data-mode]`，系统配色只在你选「跟随系统」时生效

## 配置项

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `SITE_NAME` | var | 否 | 站点名默认值，后台「站点设置」可覆盖 |
| `SITE_DESC` | var | 否 | 副标题默认值，后台可覆盖 |
| `SITE_THEME` | var | 否 | 默认风格 `anzhiyu`/`paper`/`ink`/`forest`/`ocean`/`plum`/`mono`，后台可覆盖 |
| `SITE_MODE` | var | 否 | 默认外观 `auto`/`light`/`dark`，后台可覆盖 |
| `SITE_AVATAR` | var | 否 | 站点头像默认地址，后台可覆盖 |
| `AI_MODEL` | var/secret | 否 | 覆盖默认模型，如 `@cf/qwen/qwen3-30b-a3b-fp8` |
| `AI_API_BASE` | var | 否 | 走外部 OpenAI 兼容接口时的地址，默认 `https://api.deepseek.com/v1` |
| `AI_API_KEY` | secret | 否 | 不配 `AI` 绑定时用外部接口生成摘要 |
| `SITE_ORIGIN` | var | 是 | 站点主域，如 `https://exia.de5.net`。回调地址由它拼成 `${SITE_ORIGIN}/auth/callback` |
| `GITHUB_CLIENT_ID` | var | 是 | |
| `R2_PUBLIC_BASE` | var | 否 | R2 自定义公开域名；留空则用 `/img/` 代理 |
| `SESSION_SECRET` | secret | 是 | 会话签名密钥 |
| `GITHUB_CLIENT_SECRET` | secret | 是 | |
| `R2_ACCOUNT_ID` | secret | 否 | 四项都配了才走直传 |
| `R2_ACCESS_KEY_ID` | secret | 否 | |
| `R2_SECRET_ACCESS_KEY` | secret | 否 | |
| `R2_BUCKET_NAME` | secret | 否 | 默认 `blog-images` |
| `WEBHOOK_URL` | secret | 否 | 按域名自动适配企微 / 飞书 / Slack / Discord 报文 |

## 安全响应头

Worker 侧统一在 `src/security.js` 的 `securityHeaders()` 出口挂，**所有**响应路径都过这一层：HTML、静态资源、API、301、404，以及顶层 catch 的 500。

| 头 | 值 |
|---|---|
| `x-content-type-options` | `nosniff` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `x-frame-options` | `DENY`（与 CSP `frame-ancestors 'none'` 同义） |
| `permissions-policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `cross-origin-opener-policy` | `same-origin` |
| `strict-transport-security` | `max-age=31536000; includeSubDomains; preload` |
| `content-security-policy` | 仅 HTML，带每次请求的 nonce |

### 面板再兜一层（可选）

Worker 起来之前/挂掉时，边缘返回的是 Cloudflare 自己的错误页（1101、520~527）和 `/cdn-cgi/*`，那些响应**不经过** Worker，也就没有上面这些头。想补齐就在面板加一条 Transform Rule：

`Rules → Transform Rules → Modify Response Header → Create rule`

- 规则名：`security-baseline`
- 匹配：Custom filter expression → `true`（或 `http.host eq "exia.de5.net"`）
- 操作：Set static，三条

| Header name | Value |
|---|---|
| `x-content-type-options` | `nosniff` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `x-frame-options` | `DENY` |

三条值必须和 `security.js` **逐字一致**，否则 Worker 会覆盖成自己的值，边缘和源站两套值反而更难排查。

**不要**把 `content-security-policy` 也放进面板：CSP 里有每次请求生成的 nonce，写死会把站内所有内联脚本（主题防闪、SSR 引导数据）全部拦掉。也不要加 `strict-transport-security`，面板的 Set static 会把 Worker 的 `includeSubDomains; preload` 覆盖成短值。

验证（四条路径都应带全三个头）：

```bash
for u in / /p/about /api/posts /nonexistent; do
  echo "== $u"; curl -sI "https://exia.de5.net$u" | grep -iE 'x-content-type|referrer-policy|x-frame'
done
```

也可以直接跑 `node scripts/check-headers.mjs`，7 条路径一次过。

第三方核验（2026-11-08，securityheaders.com）：**A+**，六项全 present（HSTS / CSP / Permissions-Policy / Referrer-Policy / X-Content-Type-Options / X-Frame-Options）。所以如果某个工具说这几个头缺失，先怀疑工具或缓存，别改代码——用上面两条命令复现一次。

## 本地开发

```bash
# 建本地库（首次）
npx wrangler d1 execute blog-db --local --file=./schema.sql

# 起服务，http://localhost:8788
npx wrangler dev --port 8788 --local
```

本地 OAuth 需要把 `SITE_ORIGIN` 临时改成 `http://localhost:8788`，并在 GitHub OAuth App 里同步改回调地址（GitHub 只允许登记一条）。本地测试想跳过 OAuth，直接在 `.dev.vars` 写 `SESSION_SECRET`，然后自己签一个 token 塞进 cookie 即可。

`.dev.vars` 已被 gitignore，本地密钥不会进仓库。

## 性能与缓存

**文章页整页服务端渲染**。以前 `/p/:slug` 只在 `<title>` 和 meta 上做了手脚，正文、评论、标签全得等 `/api/posts/:slug` 回来才画出来；现在 Worker 直接把整篇文章（含 AI 摘要块、标签、评论列表与评论框）写进 HTML，`window.__POST__` 只带元信息，前端不再重复拉一份正文。

| 内容 | 以前 | 现在 |
|---|---|---|
| 导航栏 | 空 `<div>`，等 `app.js` 下载执行后长出来 | Worker 直接输出 `<header>` |
| 首页列表 | 一句「加载中…」，等 `/api/posts` 回来 | 第一页 10 篇已在 HTML 里 |
| 文章正文 / 评论 | 空 `<main>` + 「加载中…」 | 全文 + 评论列表 + 评论表单 |
| 标签页/分类页标题 | 先显示站名再被 JS 改成 `#标签` | 直接是 `#标签` |

登录态（登录 / 后台 / 退出）不参与 SSR——HTML 是共享缓存的，带上用户信息会串号。Worker 只留一个空的 `<span id="nav-user">`，JS 取到 `/api/me` 后再填。空的时候 `:empty` 会让它不占位，避免「已登录却闪一下登录」。SSR 页面在前端只挂事件、不重建 DOM，所以正文不会重排、滚动位置不会跳。

**三层缓存**：

| 层 | 对象 | 策略 |
|---|---|---|
| 浏览器 | `style.css` / `app.js` / `theme.js` / `md.js`（带 `?v=`） | `max-age=31536000, immutable` |
| 浏览器 | 同上但不带版本号 | `max-age=300, stale-while-revalidate=3600` |
| 边缘（Cache API） | 匿名访客的公开页面 | 45 秒，`s-maxage=45` |
| 浏览器/边缘 | R2 图片与 `og-default.jpg` | `max-age=31536000, immutable` |

资源版本号取自 `CF_VERSION_METADATA.id`（每次 `wrangler deploy` 自动换一个 UUID），HTML 里的 `/style.css?v=<uuid>` 跟着变，所以能放心给一年强缓存——改样式不用教用户清缓存。

**发布即失效**：新建 / 修改 / 删除文章后会主动 `caches.default.delete()` 掉首页、归档、栏目页和新旧文章地址，不用等 45 秒 TTL。带 `sid` cookie 的请求一律绕过缓存，后台、私密文章、登录流程永远实时渲染。

**其它**：`robots.txt` 与 `manifest.webmanifest` 由 Worker 按当前域名动态生成；`/login`、`/editor` 带 `noindex`；文章页顶部有阅读进度条，正文不足一屏时不显示；深色模式下 `theme-color` 会跟着主题底色变。

## 结构化数据与分享卡片

每页都输出 JSON-LD（`ldJson()` 在 `src/seo.js`，统一出口避免各页字段走偏）：

| 页面 | schema |
|---|---|
| 全站 | `WebSite`（带 `SearchAction`，指向 `/?q={搜索词}`）+ `Person`（站点主人） |
| 文章 | `BlogPosting`（`headline` / `datePublished` / `dateModified` / `author` / `publisher` / `keywords` / `wordCount` / `timeRequired`）+ `BreadcrumbList` |
| 首页、归档、栏目、标签 | `CollectionPage` + `ItemList`（前 20 篇） |

`og:image` 的取值顺序：文章封面 → 站点头像 → 站点默认图 `/og-default.jpg`（1200×630，仅在后两者上用 `og:image:width/height`，因为封面尺寸未知）。另外补齐了 `og:url`、`og:locale`、`og:image:alt`、`article:published_time` / `modified_time` / `section` / `tag` 和 `twitter:image`。

## 安全响应头

`src/security.js` 统一出口，HTML 与静态资源都带：

```
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
x-frame-options: SAMEORIGIN
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
cross-origin-opener-policy: same-origin
content-security-policy: default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline'; …
```

CSP 没有 `'unsafe-inline'`：每次渲染生成一个随机 nonce，把页面里所有 `<script>`（含主题防闪脚本、JSON-LD、`window.__POST__` 引导数据、编辑器内联 module）都打上。缓存里存的是「HTML + 配套 CSP 头」这一对，回放时不会错位。代价是**不能再写 `onerror=` 这类内联事件属性**——图片错误兜底改在 `app.js` 里用捕获阶段的 `error` 监听处理。

## 内容清理

`src/clean.js` 两条路：

- `cleanMarkdown()` 在**写入时**跑：去零宽字符与 BOM、全角空格转半角、去行尾空白、连续空行压成一行、去掉与标题重复的一级标题、清掉空图片空链接。代码块内容原样保留（围栏先摘出来再放回），函数幂等，跑两次结果一致。
- `sanitizeHtml()` 在**渲染时**跑：标签白名单 + 属性白名单，丢掉 `<script>/<iframe>/<object>` 等、所有 `on*` 事件属性、`javascript:` 协议，`style` 只放行 `text-align`，外链自动补 `target="_blank" rel="noopener nofollow"`，顺手清掉空段落。

存量文章想清一遍，登录后台后 POST 一次即可（管理员）：

```bash
curl -X POST https://你的域名/api/maintenance/clean -H "cookie: sid=<你的会话>"
```

返回扫描篇数与改动明细。日常写作不需要手动跑，保存时已经清理过。

## 几个实现上的取舍

**Markdown 渲染器前后端同构**：`public/md.js` 同时被 Worker 和浏览器 import。编辑器右侧预览走浏览器本地渲染，零请求零延迟，且和线上输出逐字节一致。语法高亮是内置的 tokenizer，不引 CDN，国内也能秒开。

**图片两条路**：配了 R2 S3 凭据就走 presigned PUT，浏览器直传 R2，不占 Worker 额度；没配则回退到 Worker 中转 `PUT` 进桶。前端会自动选，不需要手动切换。默认用 `/img/<key>` 代理读图，所以**不配公开域名也能用**。

**私密文章在数据层过滤**：所有列表 SQL 都带 `is_private = 0`，单篇在 API 层判断作者，非作者直接返回 404 而不是 403——不泄露文章是否存在。

**两级评论强制封顶**：回复子评论时 `parent_id` 会被归到它的顶级评论，前端只在两层里渲染，树永远不会加深。

**会话是无状态签名 cookie**：HMAC-SHA256 签 `{uid, exp}`，不查库不占 KV。代价是没法单点踢人；要踢就改 `SESSION_SECRET`，全员重新登录。

## 常见问题

**图片上传 403**：R2 的 CORS 没配，或 `AllowedOrigins` 里没写你的域名。

**登录后还是普通用户**：管理员是「第一个登录的用户」。库里已有用户时再登录一律是普通用户。要手动提权：

```bash
npx wrangler d1 execute blog-db --remote --command "UPDATE users SET is_admin = 1 WHERE login = '你的GitHub用户名'"
```

**友链圆点全是灰的**：Cron 只在部署后按 20 分钟周期触发，刚加上去需要等一轮，或在友链页点「立即重新检测」。

**改完 `wrangler.jsonc` 没生效**：`vars` 改动需要重新 `wrangler deploy`，本地开发则重启 `wrangler dev`。

**文章名和静态页冲突**：`/login`、`/editor`、`/friends` 这些是保留路径，别名别用它们。想把文章放根路径就直接填 `about`。
