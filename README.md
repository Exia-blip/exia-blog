# Exia Blog

<p>
  <img src="https://img.shields.io/badge/CI-GitHub%20Actions-blue?logo=githubactions&logoColor=white" alt="CI: GitHub Actions">
  <img src="https://img.shields.io/badge/version-v1.2.6-blue.svg" alt="version v1.2.6">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-brightgreen.svg" alt="zero dependencies">
</p>

**在线：[miu.sryze.cc](https://miu.sryze.cc)** — 这个 README 讲的就是它正在跑的那套东西，不是示例工程。
**在线：[exia.de5.net](https://exia.de5.net)** — 旧域仍绑同一个 Worker，canonical 一律归一到主域。

跑在 Cloudflare 全家桶上的博客系统。Workers + D1 + R2 + 静态资源，没有服务器，不需要备案，一个解析到 Cloudflare 的域名就能上线。

<img src="docs/preview.webp" alt="Exia Blog 首页" width="100%">

## 目录

| 上手 | 深入 |
|---|---|
| [功能](#功能) · [目录结构](#目录结构) · [部署](#部署) · [后台](#后台) · [本地开发](#本地开发) | [性能与缓存](#性能与缓存) · [安全响应头](#安全响应头) · [投稿审核](#投稿审核) · [评论防滥用](#评论防滥用) · [友链存活检测](#友链存活检测) · [常见问题](#常见问题) |

## 功能

| 能力 | 实现 |
|---|---|
| GitHub OAuth 登录 | 会话落 D1 `users` 表；管理员由 `ADMIN_LOGINS` 指定，空库引导用 `BOOTSTRAP_TOKEN`，不按登录顺序自动发放 |
| 文章写作 / 编辑 | Monaco 编辑器（CDN 拉不到就退回原生 textarea），左右分栏实时预览，内置零依赖语法高亮；多篇同开、页签切换，正文/撤销栈/光标各篇独立 |
| 本地实时保存 | 每次输入即写 `localStorage`，按文档分键（未落库的新稿用临时键），多篇互不覆盖 |
| 服务端自动保存 | 停止输入 3 秒自动落库，`Ctrl/Cmd + S` 立即保存 |
| 私密文章 | 仅作者可见，未登录访问返回 404 |
| 图片上传 | 拖拽或粘贴，SigV4 直传 R2（S3 兼容），自动插入 Markdown |
| 文章别名 | 设为 `about` 即可通过 `/about` 访问 |
| 不列入首页 | 仍在线上可直达，只是不出现在列表 |
| 友链 | Cron 每 20 分钟巡检，卡片小圆点三态（通 / 有响应但异常 / 拿不到响应），悬停看 HTTP 码与耗时 |
| 评论 | 两级回复树，游客可评，管理员可删，博主身份标记；防滥用见下文 |
| Webhook 通知 | 新评论 POST 到指定地址，兼容企业微信 / 飞书 / Slack / Discord |
| 自动头图 | 正文第一张图片自动作为列表缩略图 |
| 分类 | 一篇文章一个分类，编辑器侧栏填写，首页分类条筛选 `/cat/名字` |
| 自动标签 | 正文写 `#博客 #部署` 自动解析，支持筛选与计数 `/tag/名字` |
| 栏目总览 | `/categories` 汇总全部分类与标签及篇数 |
| 归档 | `/archive` 按年月倒序，时间线 / 紧凑两种视图，年份筛选 `/archive/2026` |
| 搜索 | 标题 + 正文关键词，分页列表 |
| 风格主题 | 8 套预设（安知鱼 / 纸韵 / 水墨 / 苔原 / 静海 / 暮紫 / 终端 / 基建），读者自选，浅色·深色·跟随系统三档 |
| 站点头像 | 导航栏左上角圆形头像，后台可上传 / 拖拽 / 粘贴 / 填外链，兼作 favicon |
| 图表 | 正文里写 mermaid 代码块（围栏语言标 mermaid），读者侧按需加载自托管 mermaid 渲染成 SVG；无 JS 时显示源码 |
| AI 摘要 | 保存/发布时自动生成导语，文章页顶部展示，同时作为列表简介、SEO description 与 RSS 描述；可手动改写或重新生成 |
| 工作台 | `/admin`：待办条（待审评论 / 24h 内待发 / 友链异常 / 近 7 天通知失败）+ 五个 KPI、最近编辑与运行状态（仅管理员）；不摆入口墙，入口都在四栏侧栏 |
| 投稿审核 | 普通用户发文进 `pending`，管理员在 `/admin/review` 通过后才公开；作者改稿重置审核态，预览不会泄漏到匿名缓存 |
| 定时发布 | 编辑器里选未来时间写进 `published_at`，到点自动进首页 / RSS / sitemap；不依赖 cron，管理视图单独看定时队列 |
| D1 结构版本化 | 结构变更只走 `migrations/`；`check:schema` 在发版前比对线上库，缺列就停发（见「部署 → 3.1」） |
| 文章版本历史 | 内容真改动时自动留快照（每篇最近 30 版），编辑器文章列表进「历史」页预览与回滚 |
| 操作审计 | 文章增删改、审核、评论处置、友链变更都留痕，`/admin/audit` 只读可查；审计失败不阻断主流程 |
| 评论先审后发 | 开关可切；新评论进 `pending`，`/admin/comments` 放行或驳回，前台只见已通过 |
| 友链管理 | `/admin/friends` 增删改与手动探测；待审稿、友链挂掉经 webhook 推待办提醒 |
| llms.txt / 字数 | `/llms.txt` 给 AI 爬虫的纯文本索引；文章页显示真实字数（中文按字、西文按词） |

额外：RSS（带 `content:encoded` 全文，站内相对链接自动补成绝对地址）、sitemap、移动端适配、文章内 `#标签` 自动转为可点击链接。

## 目录结构

```
exia-blog/
├── wrangler.jsonc      # Workers / D1 / R2 / Cron 绑定
├── schema.sql          # D1 建表（与 migrations/ 等价，由 test-schema 锁着）
├── migrations/         # 结构变更的唯一来源；0001 是基线
├── cors.json           # R2 CORS（图片直传需要）
├── src/
│   ├── index.js        # 入口：路由、SSR meta / 主题注入、图片代理、RSS
│   ├── api.js          # 全部 API
│   ├── auth.js         # GitHub OAuth + 签名会话
│   ├── s3.js           # R2 presigned PUT（SigV4，纯 WebCrypto）
│   ├── cron.js         # 友链巡检 + 评论巡检（补推漏发的通知 / 按打分清垃圾）
│   ├── spam.js         # 垃圾评论打分（只看机械可判定的形状，误杀面写在文件头）
│   ├── webhook.js      # 评论通知
│   ├── ai.js           # AI 摘要：Workers AI / 外部接口 / 抽取式兜底
│   ├── settings.js     # 站点名 / 介绍 / 头像 / 默认风格（D1 覆盖 vars）
│   ├── cover.js        # 封面：手填 → 正文首图 → 预设自动图
│   └── utils.js        # cookie / token / 分页
└── public/
    ├── md.js           # Markdown 渲染器（前后端同构，预览与线上一致）
    ├── cover.js        # 预设头图的分配规则（前后端同构）
    ├── theme.js        # 8 套风格定义 + 切换面板
    ├── app.js          # 前端公共层
    ├── style.css       # 变量体系：主题 × 明暗
    ├── thumbs/         # 6 张预设头图（scripts/gen-auto-thumbs.py 生成）
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
npm run db:init            # = wrangler d1 migrations apply blog-db --remote
```

走的 `migrations/0001_baseline.sql`，建完表同时记一笔版本（`d1_migrations` 表）。全空库和已有库都能跑，语句都是 `IF NOT EXISTS`。

#### 3.1 以后改表结构（加字段 / 加表 / 加索引）

结构变更一律走 `migrations/`，不要直接对线上库敲 `ALTER` —— 手工改库不留记录，等到换账号或建新库那天才发现漏了。

```bash
npm run schema:plan          # 看还有哪些迁移没应用
# 新建 migrations/0002_xxx.sql，序号接着最后一个

npm run schema:apply:local   # 先在本地库验证
npm run schema:apply:local   # 再跑一次，应该显示 No migrations to apply（幂等）

npm run schema:apply         # 应用线上
npm run check:schema         # 确认线上结构与 migrations 一致
```

硬性约定，由 `scripts/test-schema.mjs` 守着，违反就 `npm test` 红：

| 约定 | 为什么 |
|---|---|
| 所有 `CREATE TABLE` / `CREATE INDEX` 带 `IF NOT EXISTS` | 迁移要能重放，不能跑第二次就炸 |
| `schema.sql` 与 `migrations/` 等价 | 两份描述同一个库，漂了就会「新库缺列、老库没问题」 |
| 代码里 `INSERT INTO 表 (列…)` 的列必须在 migrations 里 | 加了字段忘写迁移 → 线上 `no such column`，这条把问题提前到测试 |
| 不许 `DROP` / `RENAME` / 删列，除非文件里写 `-- @allow-destructive` | 删数据的语句必须是有意识的 |

`npm run deploy` 在部署前会跑一次 `check:schema`：线上库缺列就停下，不留「代码要新列、库还没有」的 500 窗口。连不上 D1 只警告不阻断（网络抖动不该让人发不了版）。

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

`secret put` 默认是交互式的：敲回车后等你粘贴值，再回车结束。在脚本、CI 或 AI 助手里跑会一直卡在等待输入。把值接到标准输入就不会卡：

```bash
printf '%s' 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' | npx wrangler secret put WEBHOOK_URL
```

### 6.1 用 setup 脚本配通知与人机验证（推荐）

上面两条也可以交给脚本：先拿真实请求验一遍，通过了才写进去；webhook 写完还会回打一条，确认写进去的值没被改坏。

```bash
# 写入前往群里发一条测试消息，收到才写 WEBHOOK_URL，写入后再回打一条确认值没写坏
npm run setup:webhook -- 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx'

# 会拿 secret 去 siteverify 验一次，然后再写 secret、写 vars
npm run setup:turnstile -- '0x4AAAAAAA...' '0x4AAAAAAA...'

# 只想验，不想动线上：加 --dry
npm run setup:turnstile -- '0x4AAAAAAA...' '0x4AAAAAAA...' --dry
```

为什么值得多这一步：这两个值配错的后果都是**静默**的。webhook 地址失效时企微回的是 `HTTP 200 + {"errcode":93000}`，只看状态码全是成功；Turnstile secret 写错时前端照常弹框、服务端永远验不过，用户看到的是「评论一直提交失败」。脚本在写入前用一次真实请求把这两种情况挡住，webhook 还会在写入后用刚写进去的地址再回打一次，防的是「wrangler 报 `Success` 其实写了空值」「token 在读写之间被轮换」「写入动作把值改坏」——这三样都不会让任何现有测试变红。回打失败不会自动回滚 secret：sink 抖动和地址写错是两件事，看清是哪件再改。注意这仍不等于端到端已验：评论落库后是否真的触发 `notifyComment` 仍是读码结论，得有人真点一次验证码、真提交一条评论。

Turnstile 的两个值不用去 Dashboard 手抄，`wrangler` 直接能建 widget 并打印真值：

```bash
npx wrangler turnstile widget create miu-blog-comments \
  --domain miu.sryze.cc --mode managed --json
# 输出里 sitekey / secret 就是 setup:turnstile 的两个参数
```

前提是 OAuth token 带 `challenge-widgets.write` scope。旧 token 会报 403 `Authentication error`（实测 `worker scripts` 200、同一 token 读 widget 403，不是账号权限问题）；跑一次 `npx wrangler login` 刷新即可。本项目的 widget 是 2026-11-25 用这条命令建的，domain 写站点主域，mode 用 `managed`（服务端 `siteverify` 校验）。

`setup.mjs` 的形状校验放行密钥里的 `-` / `_`：CF 真 key 形如 `0x4AAAAAAGSeGX0Z2Mj-pELs`，不是纯 base62。

写完跑一次体检，它会列出每一项是「已配」「仅本地」还是「未配」，并拦下有问题的组合：

```bash
npm run preflight
```

`npm run deploy` 也会先跑这一步。挡的不是「还没配完」，而是「半配」—— 只填 `TURNSTILE_SITE_KEY` 不填 `TURNSTILE_SECRET` 时，评论会被全量拒收，而页面看起来一切正常。

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

打开 `https://你的域名/login`，用 GitHub 登录。

**管理员不按登录顺序发放。** 首次部署三选一：

```bash
# 方式一（推荐，长期有效）：把管理员写进环境变量，每次登录同步回库
npx wrangler secret put ADMIN_LOGINS        # 输入 Exia 就填你的 GitHub login

# 方式二（一次性引导）：随机串，登录时带在 URL 上，库有行之后自动失效
npx wrangler secret put BOOTSTRAP_TOKEN     # 输入一个 32 位随机串
# 然后访问 https://你的域名/login?bootstrap=<刚才那个串>

# 方式三：什么都不配 —— 第一个登录的只会是普通账号，后台进不去，也没人能抢
```

只想自己写、不让别人注册，再加 `ALLOWED_LOGINS`（逗号分隔的 login，不配 = 开放注册）。

---

## 换域名 / 换账号

**换域名（同一个 Cloudflare 账号）不需要搬数据。** D1 和 R2 绑在账号上，跟域名无关。只需三步：

1. `wrangler.jsonc` 的 `SITE_ORIGIN` 改成新域名
2. CF Dashboard 给 Worker 绑新域名
3. GitHub OAuth App 的 Callback URL 改成 `新域名/auth/callback`

**旧域别急着解绑**：301 是 Worker 打的，解绑之后旧域既没有内容也没有跳转，历史外链全断。
留着绑定即可，它在 `src/cron.js` 的 `LEGACY_SELF_HOSTS` 里已被排除友链自检。

运行时代码已从 `SITE_ORIGIN` / canonical 派生域名——友链自检的 UA 与自环判定、友链申请示例、复制声明都不用手动改。唯一要动的是 D1 里指向旧域名的**本站友链数据**（后台改，属数据不属代码）。`npm run migrate:plan` 会打印这份清单。

**换账号 / 灾备重建**才要搬数据：

```bash
# 旧账号：导出 D1 全库 + 配置快照 + R2 图片命令清单
npm run migrate:export

# 新账号：建好 D1 / R2，改 wrangler.jsonc 的 database_id，然后
npm run migrate:import -- --apply    # 灌 D1；不加 --apply 是 dry-run
sh backups/<日期>/r2-get.sh          # 在旧账号登录态下拉图
sh backups/<日期>/r2-put.sh          # 切到新账号登录态后灌图
npm run make:variants                # 重生成变体（get.sh 已含，补漏用）
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_CLIENT_SECRET
npm run deploy
```

`manifest.json` 只记 secrets 的**名字**不记值——密钥必须在新账号重新 `put`。导出目录含文章全文与用户邮箱，`.gitignore` 已排除，别外传。

### 自动备份（D1 → R2，滚动 7 份）

```bash
node scripts/backup-upload.mjs --dry-run   # 只导出并打印计划
node scripts/backup-upload.mjs             # 真跑：导出 → 上传 → 滚动保留 7 份
node scripts/backup-drill.mjs              # 恢复演练：空库重放导出 SQL 并校验
```

备份写入同桶的 `backups/` 前缀，`/img/backups/*` 已被 `isPrivateImageKey()` 挡住，不会被图片代理公开读取（有断言守着）。滚动状态记在 `backups/_manifest.json`，不依赖 wrangler CLI 没有的 `r2 object list`。`backup-drill` 只读导出、在内存库重建，不碰线上数据——2026-11-23 已用真实导出演练通过（非空正文全部有 `html_content`）。

表数以 `npm run check:schema` 的输出为准（当前 **12 张业务表 / 16 个索引**）。库里另外三张表不是我们的：`d1_migrations`（wrangler 的迁移台账）、`sqlite_sequence`（SQLite 自增计数器）、`_cf_KV`（平台内部）。用 `sqlite_master` 数表会把它们算进去，数出来是 15，别拿这个数字对账。

定时执行交给外部调度器（GitHub Actions cron 或本机 cron），本项目不含自动触发配置——备份脚本需要 wrangler 的已登录态，CI 里要先注入 `CLOUDFLARE_API_TOKEN`。

---

## 后台

登录后顶部只有一个 **后台** 入口（`/editor`），页面里同时包含：

- 写作区：Markdown 编辑 + 实时预览 + 自动保存
- 侧栏「我的文章」：切换/新建/删除
- 侧栏「分类」：填一个分类名，已存在的分类会在输入时提示（datalist）
- 侧栏「站点设置」（仅管理员）：改站点名、介绍、站点头像、默认风格与默认外观，存进 D1 的 `settings` 表，**即时生效，不用重新 deploy**

管理侧栏按「打开后台要做什么」分**四栏**（顺序固定，断言锁在 4）：

| 栏 | 放什么 | 判定 |
|---|---|---|
| 概览 | 工作台 | 打开 3 秒知道今天动不动手 |
| 内容 | 写作 / 文章列表 / 发布自检 / 投稿审核 / 评论审核 / 系列 / 友链 | 日常 90% 的操作 |
| 系统 | 通知投递 / 访问统计 / 健康检查 / 定时队列 / 操作日志 / 站点设置 | 配好就不常动 |
| 工具 | 工具与备份 | 低频、误触代价高，只做命令索引，后台不给按钮 |

`/admin/notify` 是只读的投递明细（哪条、发给谁、平台码、相对时间）；`/admin/tools` 只列备份 / 迁移 / 回填命令与前置条件，**不提供任何可写入口**。

侧栏带计数徽章：**评论审核**显示待审条数（琥珀）、**通知投递**显示近 7 天失败数（红）。口径写在 `BADGE_SOURCE` 里，数字与概览页待办条走同一个 `navCounts()` —— 两处物理同源，不会出现「侧栏说 3、概览说 5」。0 不渲染：一排 0 会把「有没有事要做」重新变成阅读任务。带窗口的计数名字里必须带窗口后缀（`notifyFail7d`），断言 N-07 把这条从口头纪律变成机械判据。

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

### 定时发布

编辑器侧栏可以填未来的发布时间，写进 `posts.published_at`（UTC 裸字符串，北京时间 09:00 = 库里 01:00）。公开闸门统一是一条 SQL：

```sql
COALESCE(NULLIF(published_at, ''), created_at) <= datetime('now')
```

`src/api.js` 的 `timeGateSql()` 只做这一件事。首页、归档、标签、分类、单篇 API、SSR、RSS、sitemap 都带它；到点自动可见，不需要 cron 扫表改状态，也没有 `is_live` 这种需要维护的派生字段。

工作台的「待发布」和编辑器文章列表用同一条 `timeGateSql()` 的反条件，能看到未来稿。这条口径不能和公开闸门混——公开列表多加一层审核态，管理队列不能加，否则待审稿会被自己的闸门滤掉。给人看的日期另走 `localDay()` / `localParts()` 固定 UTC+8，见「性能与缓存 → 时区」。

### 投稿审核

普通用户可以登录写文章，但公开需要管理员通过。审核态放在独立的 `posts.review_status`（`approved` / `pending` / `rejected`，默认 `approved` 保存量数据），**不复用 `hidden`**——`hidden` 是作者自控的「不列入首页」开关，作者随时能改回去，等于自己放行。

公开闸门 = 定时闸门 + 审核态：

```js
export function liveSql(a = 'p') {
  return `${timeGateSql(a)} AND ${a}.review_status = 'approved'`;
}
```

未过审的文章在列表 API、单篇 API、SSR 文章页、RSS、sitemap 五路都不可见（逐路实测过）；作者和管理员凭会话可以预览。缓存这一层单独守：`postCacheSet` 只在 `review_status === 'approved'` 时写 LRU，否则作者预览一次之后匿名访客就能从实例缓存里读到未过审正文——边缘缓存那层由审核接口的 `bust()` 清。

普通用户每次改稿（含驳回后重提）都把审核态重置为 `pending`，审核结论绑定的是内容版本；管理员编辑视为认可。接口：`GET /api/review/pending` 与 `POST /api/review/:id`（`approve` / `reject`），后台入口 `/admin/review`，工作台有待审 KPI 直达。

新增列走 `migrations/0002_review_status.sql`。SQLite 不支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，幂等靠 wrangler 的 `d1_migrations` 记录，别手写那句 SQL。

## 换域名

只改一处：`wrangler.jsonc` 的 `SITE_ORIGIN` 改成新域名（**只写 `https://host`，别带路径和斜杠**），然后 `npx wrangler deploy`。

```diff
- "SITE_ORIGIN": "https://old.example.com",
+ "SITE_ORIGIN": "https://new.example.com",
```

配套两件事：

1. **GitHub OAuth App** 的 Authorization callback URL 改成 `https://新域名/auth/callback` —— 这一步只能手动做，GitHub 只认登记的地址，不一致会返回 `redirect_uri MUST match` 错误页
2. 旧域名的会话 cookie 是 host-only 的，换域后必须重新登录一次，属正常现象

其它域名（旧域、备用域、旧 workers.dev）**整站** 301 到 `SITE_ORIGIN` —— 不只是登录页。
规则在 `src/utils.js` 的 `hostRedirect()`，位置在 HTTPS 之后、边缘缓存之前：GET/HEAD 给 301，
写请求给 308（301 会把 POST 降级成 GET 并丢掉 body）。判断是否生效只看一行：

```bash
curl -sI https://旧域名/ | head -1   # 必须是 301，200 就是没生效
```

**「打得开」不是正常，是 bug 本身** —— 两个域名同时提供全站内容会让同一页面被抓两遍、
两个 zone 各算一份统计（P-085）。想省掉旧域每次请求唤起 Worker 的开销，可以在旧域那个
zone 加一条 Redirect Rule；规则先命中、代码当兜底，两者不冲突。

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

八套预设。`paper` 是主表里裸 `:root` 的基准；`editorial` 与 `edge` 各有少量部件覆盖（导航去毛玻璃 / 发丝线、卡片去阴影），其余六套只换 CSS 变量、不改结构。回到顶部按钮八套通用。

| id | 名字 | 气质 |
|---|---|---|
| `paper` | 纸韵 | 暖白纸面 + 陶土橙，默认 |
| `editorial` | 编辑部 | 深蓝灰纸面 + 暖金强调，浅深两态，标题衬线 |
| `ink` | 水墨 | 纸白墨黑，正文转衬线，近直角 |
| `forest` | 苔原 | 米绿纸面 + 森林绿，圆角柔和 |
| `ocean` | 静海 | 冷白蓝调 + 靛蓝强调 |
| `plum` | 暮紫 | 淡紫纸面 + 梅色强调 |
| `mono` | 终端 | 灰阶 + 等宽字，硬边 |
| `edge` | 基建 | 纯白 + 发丝线 + 锚定橙，标题转无衬线，等宽字给数字与代码 |

- 读者：导航栏右侧调色板图标 → 选风格 / 选外观，存 `localStorage`（`x_theme` / `x_mode`），只影响本机
- 站长：后台「站点设置」里定**默认风格 / 默认外观**，给第一次来的读者用
- 首访不闪：Worker 把默认风格注入 `<head>` 的 `window.__THEME_DEFAULT__`，CSS 加载前就定好 `data-theme` / `data-mode`
- 深色不再依赖 `prefers-color-scheme`，改为显式 `html[data-mode]`，系统配色只在你选「跟随系统」时生效
- 试穿：给链接加 `?theme=ink`（或任意 id）临时预览，**只影响当前这一页**，不写 `localStorage`、不写 cookie；在面板里真选一次即落盘，同时把参数摘掉

### 主题契约

完整边界见 **[THEME-CONTRACT.md](THEME-CONTRACT.md)**（管什么、不管什么、哪条断言守着）。要点：

**一套主题 = 一个 `public/theme/<id>.css` + 面板里一行文案。** 清单不用手写：`THEME_IDS` 从资源清单派生（`deriveThemeIds`），`theme-color` 从各主题 CSS 的 `--bg` 在构建期读出来。加第 9 套只动两处代码 + 跑一次 `build:sri`。

- 文件里的规则必须以 `:root[data-theme="<id>"]` 打头，所以换配色、换字体、换圆角都只动这一个文件。变量名必须在 `src/theme-contract.js` 的清单里（9 个必填 + 15 个可选），加新变量要先改那里 —— 否则就是「在结构层开后门」，单看一套主题永远发现不了（TC-24）。
- **要不要额外请求由文件决定**：清单（`ASSET_HASH`）里有 `/theme/<id>.css` 就发请求，没有就说明变量编在主样式表里（`paper` 是裸 `:root`，`anzhiyu` 是 `:root[data-theme="anzhiyu"]` 那一段）。代码里没有「主题名判断」这种东西，加第 9 套不用改引导脚本。
- **主样式表只承载默认主题的骨架**：`SITE_THEME` 指向的那套可以把布局规则写进 `style.css`（默认主题的样式必须跟第一个请求一起到，单独一个请求是净亏）；其余主题的骨架必须待在自己的文件里，否则每个读者都在下载自己用不到的东西。这条由 `scripts/test-theme-contract.mjs` 的 TC-05/TC-06 守着。
- 引导脚本只有一份（`src/themeboot.js`），静态模板用 `<!--THEMEBOOT-->` 占位，由 Worker 在出口替换 —— 手抄副本的下场见 P-051。
- **皮肤只放变量，不放理由**：单个文件 ≤ 2000 B（与 `check-size` 同口径，TC-20），禁渐变与玻璃拟态（TC-19，主表里那些骨架屏渐变与渐隐遮罩是功能性例外，别抄）。`--brand` 只做填充 —— `#f6821f` 在纯白上只有 2.58:1，当文字色过不了 AA，所以文字用压深的 `--accent`、橙底上的字用 `--on-brand`（TC-22 把 8 套 × 2 态 × 4 个色实算一遍）。这三条是 P-052~P-054；清单派生见 P-055。
- 远程主题（从别的域名拉 CSS）**不做**：会破 `integrity` 与内容哈希缓存，冷路径多一次 RTT，而且 CSS 本身能当外泄通道（属性选择器 + `background:url()`）。要真做，得先有域名白名单 + 体积上限 + `@import` / 远程 `url()` 剥离 + 边缘缓存，为一个作者维护的站不值。

## 配置项

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `SITE_NAME` | var | 否 | 站点名默认值，后台「站点设置」可覆盖 |
| `SITE_DESC` | var | 否 | 副标题默认值，后台可覆盖 |
| `SITE_AUTHOR` | var | 否 | 作者署名默认值，进 RSS 的 `<author>`/`<dc:creator>`；留空跟 `SITE_NAME` 走，后台可覆盖 |
| `SITE_THEME` | var | 否 | 默认风格 `anzhiyu`/`paper`/`ink`/`forest`/`ocean`/`plum`/`mono`，后台可覆盖 |
| `SITE_MODE` | var | 否 | 默认外观 `auto`/`light`/`dark`，后台可覆盖 |
| `SITE_AVATAR` | var | 否 | 站点头像默认地址，后台可覆盖 |
| `AI_MODEL` | var/secret | 否 | 覆盖默认模型，如 `@cf/qwen/qwen3-30b-a3b-fp8` |
| `AI_API_BASE` | var | 否 | 走外部 OpenAI 兼容接口时的地址，默认 `https://api.deepseek.com/v1` |
| `AI_API_KEY` | secret | 否 | 不配 `AI` 绑定时用外部接口生成摘要 |
| `SITE_ORIGIN` | var | 是 | 站点主域，如 `https://miu.sryze.cc`。回调地址由它拼成 `${SITE_ORIGIN}/auth/callback` |
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

CSP 没有 `'unsafe-inline'`：每次渲染生成一个随机 nonce，把页面里所有 `<script>`（含主题防闪脚本、JSON-LD、`window.__POST__` 引导数据、编辑器内联 module）都打上。缓存里存的是「HTML + 配套 CSP 头」这一对，回放时不会错位。代价是**不能再写 `onerror=` 这类内联事件属性**——图片错误兜底改在 `app.js` 里用捕获阶段的 `error` 监听处理。

### 面板再兜一层（可选）

Worker 起来之前/挂掉时，边缘返回的是 Cloudflare 自己的错误页（1101、520~527）和 `/cdn-cgi/*`，那些响应**不经过** Worker，也就没有上面这些头。想补齐就在面板加一条 Transform Rule：

`Rules → Transform Rules → Modify Response Header → Create rule`

- 规则名：`security-baseline`
- 匹配：Custom filter expression → `true`（或 `http.host eq "miu.sryze.cc"`）
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
  echo "== $u"; curl -sI "https://miu.sryze.cc$u" | grep -iE 'x-content-type|referrer-policy|x-frame'
done
```

也可以直接跑 `node scripts/check-headers.mjs`，7 条路径一次过。

### 用脚本代替手点

面板点一遍是一次性动作，脚本的价值是幂等、可回滚、能进版本库：

```bash
echo 'cf_你的token' > .cf-token        # 已被 .gitignore 忽略
node scripts/apply-edge-headers.mjs --verify     # 只验证权限，不读规则
node scripts/apply-edge-headers.mjs              # 预览将写入的规则集
node scripts/apply-edge-headers.mjs --apply      # 写入（同名规则原地替换，不动其它规则）
```

Token 权限两项：`Zone · Transform Rules · Edit` + `Zone · Zone · Read`，Zone Resources 选 `miu.sryze.cc`。

**`wrangler login` 的 OAuth token 一定失败（403 / code 10000）**：Cloudflare 的 OAuth 授权范围里没有 Transform Rules，只支持 API Token 或 Global API Key。2026-11-08 实测确认过，不用再试。

### 怎么判断面板规则到底加没加

三个头分两层，用一条命令就能分清：

```bash
curl -sD - -o /dev/null https://miu.sryze.cc/cdn-cgi/trace | grep -iE 'x-content-type|referrer-policy|x-frame'
```

`/cdn-cgi/trace` 由 Cloudflare 边缘直接返回，**不经过 Worker**：

| 结果 | 含义 |
|---|---|
| 无输出 | 面板 Transform Rule 还没加（Worker 侧的头与它无关） |
| 三条都在 | 已经加了 |

2026-11-08 实测：`/cdn-cgi/trace` 三个头 **均无**，`/` 三个头齐全。这说明 Worker 层是好的、边缘规则确实还没落地。

第三方核验（2026-11-08，securityheaders.com）：**A+**，六项全 present（HSTS / CSP / Permissions-Policy / Referrer-Policy / X-Content-Type-Options / X-Frame-Options）。所以如果某个工具说这几个头缺失，先怀疑工具或缓存，别改代码——用上面两条命令复现一次。

### 输入与出站防护

响应头管的是「浏览器怎么对待页面」，这一组管的是「不可信输入怎么被使用」。审计出的四项，都已修：

| 位置 | 攻击面 | 修法 |
|---|---|---|
| `src/auth.js` `safeNext()` | 登录 `?next=` 开放重定向（CWE-601） | 只接受以单个 `/` 开头、且 `new URL(s, origin).origin` 等于本站的路径；`//evil.com`、`/\evil.com`、控制字符、畸形值一律回落 `/`。OAuth 回调、服务端跳转、登录页客户端三处共用同一守卫 |
| `public/avatar.js` `safeWebsite()` | 评论 website 填 `javascript:` 伪协议 | 无协议补 `https:` 并剥掉前导 `//`，只放行 http/https，其余 scheme 回落空串。SSR 与浏览器共用一份 |
| `src/utils.js` `siteOrigin()` | 拿请求的 `Host` 直接拼 canonical / og / RSS / sitemap | 一律以 `SITE_ORIGIN`（校验过 scheme + hostname）为准，配错才回落请求 origin。canonical、og:image、RSS、sitemap、robots 全部改从它派生 |
| `src/api.js` `searchMatch()` | 搜索关键词里的 `%` `_` `\` 被当成 LIKE 通配符，「100%」变全表匹配 | 三字符转义 + 三路 SQL 都带 `ESCAPE '\'`（标题/正文/标签子查询口径一致，COUNT 与列表不会走偏） |

`safeWebsite()` / `siteOrigin()` 是前后端共享函数：改它们要同时过 SSR 与客户端两条路径，别只改一边。

## 本地开发

```bash
# 建本地库（首次）
npm run schema:apply:local

# 起服务，http://localhost:8788
npx wrangler dev --port 8788 --local
```

本地 OAuth 需要把 `SITE_ORIGIN` 临时改成 `http://localhost:8788`，并在 GitHub OAuth App 里同步改回调地址（GitHub 只允许登记一条）。本地测试想跳过 OAuth，直接在 `.dev.vars` 写 `SESSION_SECRET`，然后自己签一个 token 塞进 cookie 即可。

`.dev.vars` 已被 gitignore，本地密钥不会进仓库。

## 性能与缓存

**当前实测**（`node scripts/perf-vitals.mjs https://miu.sryze.cc/ --runs=3`，2026-11-24，桌面无节流）：

| 指标 | 值 | 评级 | 备注 |
|---|---|---|---|
| LCP | **248 ms** | good | LCP 元素是列表首图的 `img.thumb`（`auto-4.webp`，23KB），不是字体也不是大图 |
| CLS | **0** | good | 0 次偏移；三个空位的修法见「CLS 的最后一格」 |
| INP | 40 ms | good | 交互打点，不是 TBT |
| TTFB | 47 ms | good | 热连接；冷连接实测 260 ms（其中 TLS 握手 140 ms） |
| 请求数 / 传输 | 23 reqs / 16 KB | — | 不含 `static.cloudflareinsights.com` 那一个 RUM 脚本 |

移动端（`--mobile`，4G + 4× CPU）LCP **940 ms**，仍是 good，但 LCP 元素换了人：桌面是列表首图，移动端变成「先读这三篇」榜单的标题文字（`span.pick-t`）——窄屏下首图被挤出首屏，最大元素成了文字块。两个数都远好于 2.5 s 的阈值，所以没有为它改排版。

没有用 Lighthouse 分数做基线：那是合成分数，同一份页面两次跑能差 10 分；也不报 TBT，本站没有长任务，40 ms 的 INP 更能说明问题。

**文章页整页服务端渲染**。以前 `/p/:slug` 只在 `<title>` 和 meta 上做了手脚，正文、评论、标签全得等 `/api/posts/:slug` 回来才画出来；现在 Worker 直接把整篇文章（含 AI 摘要块、标签、评论列表与评论框）写进 HTML，`window.__POST__` 只带元信息，前端不再重复拉一份正文。

| 内容 | 以前 | 现在 |
|---|---|---|
| 导航栏 | 空 `<div>`，等 `app.js` 下载执行后长出来 | Worker 直接输出 `<header>` |
| 首页列表 | 一句「加载中…」，等 `/api/posts` 回来 | 第一页 10 篇已在 HTML 里 |
| 文章正文 / 评论 | 空 `<main>` + 「加载中…」 | 全文 + 评论列表 + 评论表单 |
| 标签页/分类页标题 | 先显示站名再被 JS 改成 `#标签` | 直接是 `#标签` |

登录态（登录 / 后台 / 退出）不参与 SSR——HTML 是共享缓存的，带上用户信息会串号。Worker 先按匿名访客填上「登录」，JS 取到 `/api/me` 后再按真实状态替换成后台入口。**那一格不能留空**：留空的话它会从 0 宽长到 51px，整条导航跟着左移，又是一次布局偏移（CLS）。首页的栏目条 / 标签条同理，见下面「CLS 的最后一格」。

**三层缓存**：

| 层 | 对象 | 策略 |
|---|---|---|
| 浏览器 | `style.css` / `app.js` / `theme.js` / `md.js`（带 `?v=`） | `max-age=31536000, immutable` |
| 浏览器 | 同上但不带版本号 | `max-age=300, stale-while-revalidate=3600` |
| 边缘（Cache API） | 匿名访客的公开页面 | `s-maxage=300` + `stale-while-revalidate=86400` |
| 浏览器/边缘 | R2 图片、`/avatar` 头像代理 | `max-age=31536000, immutable` |
| 浏览器/边缘 | `/thumbs/*`、`/cards/*`（带 `?v=`） | `max-age=31536000, immutable` |
| 浏览器/边缘 | 同上但不带版本号（兜底） | `max-age=86400, stale-while-revalidate=604800` |

资源版本号取自**内容哈希**（`npm run build:sri` 算出，落在 `src/assets.gen.js`），不是部署序号。两者差别很大：部署序号每次发版都换，等于每改一行文档就逼所有访客重下 121KB 的 `style.css`；内容哈希只在文件真变了才换，没动过的资源跨部署继续命中缓存——一年 `immutable` 这时候才是真的生效。

同一份哈希顺手产出 `integrity="sha384-…"` 写进 `<script>` / `<link>`。它和版本号同源，所以不会出现「URL 换了、校验值还是旧的」这种既白屏又难查的状态。**改了 `public/` 下的 js/css 必须跑一次 `npm run build:sri`**（`npm run deploy` 会自动跑，`npm test` 里有一条会校验 manifest 与磁盘字节一致）。

SRI 的边界在 `<head>` 直出的标签上；`/editor`、`/login` 这类直接由静态资源返回的 HTML 不过 Worker 模板，标签上没有版本号也没有 integrity，它们只能吃 5 分钟短缓存。故意不补：为这几个页每次请求读一遍 HTML 文章算哈希，代价大于收益。

`public/vendor/mermaid.min.js`（2.7MB）也走同一条路：自托管、内容哈希、`immutable`、`integrity`。只在页面上真有 mermaid 图时才注入，不拖累其它页面。

**发布即失效**：新建 / 修改 / 删除文章后会主动 `caches.default.delete()` 掉首页、归档、栏目页和新旧文章地址，不用等 TTL。TTL 放宽到 300 秒就是靠这一条兜底的——内容更新是主动清的，不是等出来的。带 `sid` cookie 的请求一律绕过缓存，后台、私密文章、登录流程永远实时渲染。

**分段计时（Server-Timing）**：每个 HTML 与 JSON 响应带一条

```
server-timing: db;dur=154;desc="7q", app;dur=0, total;dur=33
```

`db` 是本请求所有 D1 调用的**累计墙钟**，`desc` 里的 `7q` 是查询条数；`total` 从进入 `fetch` 算到响应对象造好；`app = total - db`，钳到 0 不取负（理由见下）。

**`db` 可以大于 `total`，这不是 bug。** `Promise.all` 并行查库时，七条各 20ms 的查询累加成 140ms，而总耗时只有 33ms——累加的是"每次查询各自花了多久"，不是"这条请求在库里待了多久"。实测 `/cat/log` 出现过 `db=173 / total=137`。所以三个数不是嵌套关系，别拿 `db/total` 当"数据库占比"用。

另外两个判据：

- **边缘缓存命中的响应没有这个头**，因为它不经过 Worker。所以「有头 = 回源，无头 = 缓存命中」，比看 `cf-cache-status` 更直接（那个头可能是上一跳留下的）。要强制回源就加 `?cb=`。
- **静态资源不带**。CSS / JS / 图片每个响应多几十字节纯属浪费，`withServerTiming` 只认 `text/html` 与 `application/json`。

实现是单点包装：`timedDb()` 用 Proxy 包住 `env.DB` 再传给 `handleFetch`，所有查询点（`src/api.js` 78 处 `prepare`）自动计时，不用逐点插桩。`batch()` 那条路要特别处理——传代理对象进 D1 会触发类型检查失败，所以代理上挂了 `__raw` 指回原对象，`batch` 时解包（`scripts/test-timing.mjs` T-03 守着）。

**ETag / 304**：HTML 的浏览器缓存是 `max-age=0`（每次回源校验），没有 ETag 的话这次"校验"就是一次完整的 200。现在每个 HTML 响应都带强 ETag（`tagOf()` 算归一化内容指纹），命中时回 304 —— 实测复访从 29102B 降到 **0B**。

三个坑，都踩过：

1. **不能在 `html()` 里算**。那个 body 之后还要被 `injectTheme`（塞 `__POST__`/`__ARCH__`）和 `harden` 改写，早算的 tag 与浏览器手里的副本对不上，304 永远命中不了。统一在入口按最终 body 补（`withEtag`）。
2. **CSP nonce 每次随机**，注入进每个 `<script nonce="...">`。不归一化的话 ETag 每次请求都变，命中率恒为 0。相对时间（"3 分钟前"）同理。
3. **304 不能发新 CSP**。CSP 头里是本次新生成的 nonce，而浏览器手里那份 body 里是上一次的——发过去会让所有内联脚本 nonce 对不上，主题、引导数据、评论一起静默失效。`maybe304` 显式删掉这个头，浏览器沿用缓存里那份配套的 CSP（RFC 9111）。

另外必须是**强** ETag（不带 `W/`）：Cloudflare 只对强 ETag 在边缘直接答 304，弱校验会一路打到 Worker，等于白做。

**其它**：`robots.txt` 与 `manifest.webmanifest` 由 Worker 按当前域名动态生成；`/login`、`/editor` 带 `noindex`；文章页顶部有阅读进度条，正文不足一屏时不显示；深色模式下 `theme-color` 会跟着主题底色变。

### Core Web Vitals 实测

不用 Lighthouse 跑分（分数会飘，而且分不清「网络慢」和「代码慢」），直接读浏览器里的 PerformanceObserver：

```bash
npm run vitals                 # 桌面，默认打 https://miu.sryze.cc/
npm run vitals -- <URL>        # 换地址
npm run vitals:mobile          # 移动 4G（1.6Mbps / 150ms RTT）+ 4x CPU，跑 3 次取最好
npm run cls -- <URL>           # 只看 CLS，并打出每个偏移的前后矩形与父链
```

`perf-vitals.mjs` 报四项：LCP（连同元素和候选）、CLS（连同每次偏移的来源）、INP（用 CDP 发真实点击/触摸，Event Timing 只认可信输入）、阻塞资源（parser-blocking 的 `<script>` 和首屏 `<link rel=stylesheet>`）。

两个细节值得记一下：

- **Event Timing 默认 `durationThreshold` 是 104ms**，低于这个值的交互根本不进 buffer。不显式降到 16ms，「INP 很好」和「一个事件都没采到」在数据上长得一模一样。
- **`<script defer>` 的判断要看整个标签**。只匹配到 `src="` 为止的话，`defer` 在 `src` 后面，每条都会被误报成阻塞脚本。

当前基线（2026-11，首页）：

| | 桌面 | 移动 4G + 4x CPU |
|---|---|---|
| LCP | 244ms | 368ms |
| CLS | 0 | 0 |
| INP | 32ms | 32ms |
| TTFB | 60ms | 152ms |

CLS 归零靠三处改动，缺一不可：

1. **正文图 / 列表图都带 `width` + `height`**，浏览器在图片字节到达之前就知道该占多大。
2. **首屏第一张图 `loading="eager"` + `fetchpriority="high"`**。`lazy` 要等布局算完才发请求，而它经常正好就是 LCP 元素。
3. **栏目条 / 标签条服务端直出**（`renderListBars()`）。它们原来是两个空 `<div>`，等 `app.js` 拉完 `/api/categories` 才 `innerHTML`——首屏画完一两百毫秒后整块列表往下推 90 多像素。图片的宽高早就补齐了，CLS 0.0176 全部来自这两个条。现在数据本来就在 `injectTheme` 里并行取（栏目计数、标签云），只是把它用掉，不多一次 D1 往返。

### 时区

D1 里所有时间都是 **UTC 裸字符串**（`nowISO()` 写进去的就是 UTC），而 `String(x).slice(0, 10)` 取的是 UTC 的日期。

后果不是理论上的：北京时间 11-12 00:30 发的文章，UTC 是 11-11 16:30，页面上写 11-11——凌晨写完顺手发布的人，看到的日期是「昨天」。27 篇里有 6 篇踩中。跨年那 8 小时更糟：北京 2027-01-01 00:30 的文章会被归档进 2026 那一栏。

规则：

- **给人看的**（列表日期、归档年月、文章页日期、「更新于」）→ `localDay()` / `localParts()`，固定 UTC+8。
- **喂机器的**（JSON-LD `datePublished`、sitemap `lastmod`、RSS `pubDate`）→ 保持 UTC。ISO 8601 带 `Z`、RFC 822 带 `GMT` 才是协议要的，改成 +08:00 反而会被部分解析器当成非法值。
- **`liveSql()` 的发布闸门**（`<= datetime('now')`）→ 不动。存的是 UTC、比的也是 UTC，换算过来反而全部错位。
- **归档的年份过滤**走 SQL `strftime('%Y', datetime(ts, '+8 hours'))`，和 JS 侧同一口径；否则 `/2027` 页面会漏掉跨年凌晨发的那篇，而那篇在页面上明明写着 2027。

`npm test` 里有 36 条用例（`scripts/test-tz.mjs`），把边界钉死：UTC 15:59:59 同日 / 16:00:00 跨日、跨年、闰年 2-28、以及线上那 6 篇真实数据。

### 线上体检

```bash
npm run check:live             # 一次性过 53 项硬指标
```

只打 HTTP，不跑浏览器，验证那些「用户不会报障但坏了很难察觉」的东西：编码声明、404 语义与缓存、时区显示、HEAD 与 GET 的 ETag 是否一致、缩略图缓存策略、阻塞脚本、CSP/HSTS。

两个踩过的坑写进脚本里了：

- **请求首页要带 cache-buster**。边缘 `s-maxage=300`，刚部署完直接打正式 URL 会拿到上一版 HTML，然后得到一堆「明明是刚修过的」FAIL。
- **`text/html` 的 charset 被 Cloudflare 规范掉了**。Worker 发的是 `text/html; charset=utf-8`，出网变成 `text/html`——这是 HTML 规范定的（text/html 的编码由 BOM 和 `<meta charset>` 决定，头里的 charet 参数已废弃）。所以断言要写成「头或 meta 至少有一条」，页面里 `<meta charset="utf-8">` 在第一位，中文不会乱码。

## 结构化数据与分享卡片

每页都输出 JSON-LD（`ldJson()` 在 `src/seo.js`，统一出口避免各页字段走偏）：

| 页面 | schema |
|---|---|
| 全站 | `WebSite`（带 `SearchAction`，指向 `/?q={搜索词}`）+ `Person`（站点主人） |
| 文章 | `BlogPosting`（`headline` / `datePublished` / `dateModified` / `author` / `publisher` / `keywords` / `wordCount` / `timeRequired`）+ `BreadcrumbList` |
| 首页、归档、栏目、标签 | `CollectionPage` + `ItemList`（前 20 篇） |

`og:image` 与列表缩略图同源（见下一节）。另外补齐了 `og:url`、`og:locale`、`og:image:alt`、`article:published_time` / `modified_time` / `section` / `tag` 和 `twitter:image`。

`CollectionPage` 的 `@id` / `url` 必须是**规范地址**，与 `<link rel="canonical">` 同一个来源（`canonicalOf()`，`src/index.js`）。以前直接塞 `url.toString()`，于是 `/?cb=x`、`/?utm_source=x` 各生成一个 `@id`，而 canonical 指向同一个 `/` —— 同一份内容两个身份，Search Console 会当成重复页。规则和 canonical 完全一致：除真分页的 `page > 1` 之外，所有 query 都丢掉。

`sitemap.xml` 里**每条 URL 都带 `<lastmod>`**，不只文章页：首页 / 归档 / 栏目总览取全站最新 `updated_at`，栏目页与标签页取组内 `MAX()`，友链页取最近新增的友链。没有 `lastmod` 的 URL 会被爬虫当作「从不更新」，只登记不重抓。友链表为空时 `MAX()` 是 NULL，会漏掉 lastmod，所以空表退回站点最后更新时间。

description 统一走 `metaDesc()`（`src/utils.js`）：换行压平、超 155 字截断（英文回退到空格处，不留半个词）、首选为空时退到站点描述。以前是直接拼 `summary || extractExcerpt()`，正文只有图片时输出空串，等于没写。

## 缩略图与自动头图

列表卡片、`og:image`、`BlogPosting.image` 用的是同一个值，取值顺序写在 `src/cover.js` 的 `coverOf()` 里：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `posts.cover` | 手动指定，优先级最高 |
| 2 | 正文第一张图 | 直接复用作者已经放进去的图，不用再单独设封面 |
| 3 | `/thumbs/auto-N.jpg` | 纯文字文章兜底，6 张预设图轮换 |

第三层按 `posts.id % 6 + 1` 分配：id 单调递增，新文章天然轮到下一张，相邻卡片不会撞同一张；同一篇文章永远同一张（换成随机的话列表每次刷新都变脸，边缘缓存也会被打散）。分配规则放在 `public/cover.js`，服务端与浏览器共用一份，避免 hydrate 时缩略图闪一下换脸。

正文提取有两个坑，`extractCover()` 里都处理了：

- **围栏代码块要先剥掉**。讲 Markdown 的文章里，示例图语法就写在 ` ``` ` 里，直接扫会把 `![x](/a.png)` 当真封面，列表里出现一张破图。
- **`.svg` 与 `favicon` / `icon-` / `emoji` 开头的不算**。这类图当 108×78 缩略图只会糊成一块，宁可退回预设图。

预设图由 `python scripts/gen-auto-thumbs.py` 生成（PIL，无网络依赖），**一张图出两份**：

| 文件 | 尺寸 | 体积 | 用途 |
|---|---|---|---|
| `auto-N.jpg` | 1200×784 | ~30KB | `og:image` / `BlogPosting.image` / RSS（WebP 在部分社交平台不认） |
| `auto-N.webp` | 216×156 | ~1KB | 列表卡片（显示 108×78，2 倍图刚好，比例与盒子一致） |

浅色系是有意为之：站点默认 paper 主题是白卡片 + 浅灰底，深色封面会让列表像贴了几块黑胶布。改配色或符号改脚本里的 `PALETTES` 再跑一次即可，文件名 `auto-1..6` 复用，`/thumbs/*` 的缓存是 1 天，换图当天生效。

浏览器端上传的图片在**上传前**就转成 WebP（`editor.html` 的 `toWebp()`）：长边 1600、q 0.82，省不到 8% 就直接传原图；GIF 与 SVG 不动（一个丢动画，一个是矢量）。服务端不做转码——Workers 里没有图像库，免费计划也用不了 Image Resizing。

#### AVIF 变体（存量图补转）

上传时只能产出 WebP：浏览器的 `canvas.toBlob` 在稳定版里没有 AVIF 编码（Safari 有、Chrome 没有），要 AVIF 只能在这台机器上转。所以分两步走：

| 原图 | 已有 | 缺 |
|---|---|---|
| 老图 `.jpg` / `.png`（上传时还没接 `toWebp()`） | `.webp` + `.avif` | — |
| 新图 `.webp`（上传前转过） | 原图已是 WebP | 只有 `.avif` |

```bash
npm run variants:check     # 只体检：正文引用了哪些图、谁缺变体、谁原图丢了，有缺口 exit 1
npm run make:variants      # 补缺的（已有变体的跳过，--force 才全量重转）
```

体检走 `HEAD`，不下载不转码，7 张图一秒内跑完，适合发完带图文章顺手敲一次。两种缺口的修法不一样，所以分开报：**缺变体**跑 `make:variants` 就补上；**原图丢失**是转码救不了的，得回去重传或者改正文引用。

判据是 **Content-Type 必须是该格式自己的 MIME**，不是状态码。缺失变体时 Worker 会回退原图并照样返回 200，只看 `r.ok` 会把「全是回退」报成「变体齐全」——页面不报错，只是每次多传几百 KB。

变体 key 是原 key 加后缀（`/img/u/x.png.avif`），`serveImage` 认这个后缀，缺失时回退原图，所以转与不转都不会出现裂图。原图本身是 `.webp` 的只查 `.avif`——再产一份 `.webp` 变体是同一份编码，没有意义。

回退响应只缓存 5 分钟（正常命中才 immutable 一年）。这是为了避免「变体补传后，边缘里那份回退原图靠 immutable 躺满一年」——同一个 URL 继续吐旧图，且没有任何报错。修复前已经缓存下去的回退需要主动清：配 `CF_API_TOKEN`（Cache Purge 权限）+ `CF_ZONE_ID`，`make:variants` 会在上传后自动按 URL 清；没配则打印手动清理命令。

`sharp` 是显式开发依赖（`npm i -D sharp`），不靠 `wrangler` 带的 miniflare 传递进来——那是别人的依赖，哪天它不带了脚本就断。

#### 宽高（CLS）

正文图必须带 `width` / `height`，否则浏览器在图片下载完之前不知道该留多高，每张图落地都把下面的内容往下顶一次。实测同一篇文章：

| | CLS |
|---|---|
| 带宽高 | **0.0005**（good） |
| 去掉宽高 | **0.2682**（poor） |

尺寸从哪来，两条路各管一段：

- **Worker 中转上传**（`/api/upload`）读得到文件，用 `src/img-size.js` 读文件头拿宽高（PNG 的 IHDR、JPEG 的 SOF、WebP 三种子格式、AVIF 的 ispe、GIF 的逻辑屏），拼成 `?w=800&h=400` 返回。
- **R2 直传**后端只见到一个 key，所以由浏览器在 `toWebp()` 里顺带量好（那里本来就 `createImageBitmap` 了），插入 markdown 时补上参数。

渲染时 `md.js` 把 w/h 取出来变成属性，再把这两个参数从 `src` / `srcset` 里**剥掉**——尺寸是排版元数据不是资源标识，留着会让同一张图在边缘多一份缓存分区。认不出的格式（`imageSize()` 返回 `null`）就不写属性，不瞎猜。

```bash
npm run backfill:imgsize   # 给历史文章补尺寸（读 R2 文件头，幂等，--dry 先看）
npm run check:alt          # 扫 alt：空值 / 文件名型 / 过长（--fix-name 只做去扩展名）
```

存量 9 张图就是这么补上的。返回 200 也骗不过体检——图片缺失时 Worker 回的是占位 SVG（不裂图），带 `x-img-missing` 头，`originOk()` 靠它判断「原图到底在不在」。

#### SVG 与不可信 MIME

`/img/` 的 Content-Type 来自 R2 元数据，而元数据是**上传时由客户端写进去的一句声明**，不是事实。它一旦是 `text/html`，同源导航到 `/img/xxx.png` 就是一次存储型 XSS：`nosniff` 不管用（`text/html` 本来就该按 HTML 渲染），`X-Frame-Options` 也不管用（这是顶层导航），更糟的是出口那层 `harden()` 会把响应当页面处理，顺手给攻击者的 `<script>` 补上本站 nonce，CSP 从「拦」变成「盖章放行」。

所以出口按白名单发，不按 R2 说的发：

| R2 里的 content-type | 实际响应 | 效果 |
|---|---|---|
| `image/png` `image/jpeg` `image/webp` `image/avif` `image/gif` | 原样 | 正常显示 |
| `image/svg+xml` | 原样 + `CSP: default-src 'none'; style-src 'unsafe-inline'; sandbox` | 文档级沙箱：脚本不跑、外链不加载、站内导航被禁 |
| 其它（`text/html` / `application/json` / 空值 / 认不出的扩展名） | `application/octet-stream` + `attachment` + `x-img-rejected` | 触发下载，不渲染 |

两条判据取并集：content-type 说 svg **或** key 以 `.svg` 结尾，都按 svg 处理。key 用 `makeKey(name, type)` 生成，扩展名跟声明过的白名单类型走，不听文件名——否则 `type=image/svg+xml` 配 `name=a.png` 就能让扩展名这道判据失效。

入口也收了一道：

- `/api/upload` 与 `/api/upload-url` 用 `imageSize()` 读文件头复核声明的 MIME，两者打架时以内容为准（`settleType()`）。声明 png、内容其实是 svg 的，会被纠正成 `image/svg+xml`，出口才会给它上沙箱。
- R2 直传的 presigned URL 现在把 `content-type` 签进 `SignedHeaders`。原来只签 `host`，等于允许客户端 PUT 任意类型——包括 `text/html`。改了类型就是 403，前端会自动回退到 Worker 中转，不阻断上传。
- `/avatar` 代理同样不透传上游 MIME，认不出的按 `image/png` 发（头像位必须能显示，裂图比下载链接好）。

**SVG 不进封面位**：手动填的 `cover` 和正文首图都会被过滤掉，退到预设图。SVG 没有固定像素尺寸，108×78 的缩略图里会按 `viewBox` 拉伸变形，`og:image` 更有一半平台不渲染。正文里嵌 SVG 不受影响，`<img>` 上下文本来就不执行它的脚本。

`npm test` 里有 26 条针对这块的用例（`scripts/test-svg.mjs`），`npm run check:live` 会抽文章里的真实图片验一遍「类型在白名单内、没有被降级、svg 都带沙箱」。

### 标题卡（分享图）

纯文字文章分享出去原来只有一张通用 `og-default.jpg`。现在每篇都会渲染一张 1200×630 的标题卡，`og:image` 指它；列表缩略图仍然用抽象预设图——把带字的分享图塞进 108×78 只会露出半截标题。

```bash
node scripts/gen-cards.mjs            # 出图 + 生成 SQL，不写库
node scripts/gen-cards.mjs --apply    # 出图并写回 posts.cover
```

- 编排在 `scripts/gen-cards.mjs`（读 D1 → 写 `scripts/.cards-input.json` → 调 Python → 写 `scripts/seed-cards.sql`），渲染在 `scripts/gen-title-cards.py`（Pillow，中文字体取 `simsun.ttc`；**别用 `simsunb.ttf`**，那是 SimSun-ExtB，常用字全是豆腐块）
- 配色只有一套：深墨底 `#141518` + 米白字 + 铁锈橙 `#a8501f`（顶条 / 分类 / 标题左竖线）。分类不再决定颜色——旧版四色渐变是站内另一套配色，门面和正文对不上；域名从 `wrangler.jsonc` 的 `SITE_ORIGIN` 派生，换域只改一处
- 同一次运行还重出 `public/og-default.jpg`：首页/系列页/无封面兜底共用同一套门面，不再是一张带旧域的蓝紫图
- 标题最多三行，超长自动降字号（76→46px），按像素断行且不拆 ASCII 单词
- 输出 `public/cards/<slug>.png`（1200×630）；`/cards/*` 缓存一天
- 只给「还没有手填封面」的文章挂卡，`posts.cover` 一旦非空就尊重作者的选择。2026-11-27 全量重出 40 张（公开文章数），26 篇空封面的挂卡 SQL 落在 `scripts/seed-cards.sql`

#### 图标与默认分享图的体积

这一组是设计出来的图形（纯色底 + 文字，旧版曾带渐变），**PNG24 里全是熵**：zlib level 9 无损重压一张都省不到 1%，所以「优化 PNG」这类说法在它们身上是空的。

真正有效的是降到 256 色索引图，但抖动强度必须压小：`dither: 1` 会在平缓渐变上堆出可见的颗粒斑（512 图标右侧那块），`quality: 100` + `dither: 0.5` 反而又小又干净，PSNR 55、肉眼看不出、体积 -33%~-42%。OG 图是 1200×630 的 JPEG，原文件只有 0.039 B/px，已经贴着 JPEG 地板，能动的只剩色度抽样 4:4:4 → 4:2:0（-15%）。

```bash
npm run assets          # 原地重压（只写变小的，带 PSNR 闸门）
npm run assets -- --dry # 只看结果不落盘
npm run assets:check    # 比对体积预算，超了 exit 1
```

| 目标 | 前 | 后 |
|---|---|---|
| `favicon.ico`（4 帧 PNG 重压后重拼容器） | 5.9K | 3.0K |
| `icon-192.png` / `apple-touch-icon.png` | 8.9K / 8.3K | 6.0K / 5.5K |
| `icon-512.png` | 28.5K | 16.6K |
| `og-default.jpg` | 38.8K | 23.2K |
| `cards/*.png`（40 张，同时是各篇 `og:image`） | 2354K | 673K |

脚本**幂等**：PNG 头里已是索引色（color type 3）、JPEG 已是渐进 4:2:0 的直接跳过，收益不足 5% 的也不写 —— 二次量化是累计有损的，跑两遍不会把图越压越糊。`sharp` 的 `effort` 参数在这条路上是陷阱：它是给索引色量化用的，配在无损档上会悄悄改像素（实测最大偏差 16）。

`/cards/*` 缓存一天、图标走一年 immutable，所以换图后老访客手里那份会留着，压缩收益主要落在新访客和爬虫上；视觉上两份内容一致，不需要清缓存。

## 阅读体验

> 目录的 sticky 有个隐蔽前提：`.post-article` 是 grid，`align-items: start` 会让 `.post-toc` 的高度等于内容高度，sticky 元素没有可滚余量，滚两屏目录就跟着文章跑出视口 —— 表现是"高亮在变，但目录看不见了"。改成 `stretch` 才真正固定。


| 能力 | 实现 | 备注 |
|---|---|---|
| 侧边目录 | `.post-toc`，SSR 从渲染好的 HTML 抽 h2（`tocOf()`） | ≥1080px 出现，正文仍锁 760px；`bindTocSpy()` 按「标题顶端越过视口 96px」高亮，左侧竖条按当前项中点填充进度，目录超长时只在目录内部滚动把高亮项拉进视野 |
| 窄屏目录 | `.mtoc-btn` + 底部抽屉（JS 从桌面目录复制，不重算标题） | ≤1079px；滚过文章头部才浮出，点条目跳转并自动关闭；`scroll-margin-top: 88px` 防吸顶遮挡 |
| 标题锚点 | 每个 h2/h3 前挂 `.h-anchor` | hover 才显形，负 margin 挂在正文留白里；同名标题自动加 `-2`、`-3` |
| 代码块 | 语言徽章 + 超长块（≥20 行）行号 + 复制按钮「已复制」态 | 行号是独立一列，不往高亮后的 HTML 里插标记：多行字符串的 span 会跨行，切了就把标签劈开 |
| 系列徽章 | 文章头部 `series-chip`：`OAuth 授权流程拆解 · 第 3/4 篇` | 点进去跳到系列目录 |
| 阅读进度 | 顶部细线 `.read-bar` + 右侧百分比 `.read-pct` | 两者共用一次 rAF 与同一份 rect；百分比 ≥1280px 才出现，2%–99% 之间显示，读完自动撤掉，`pointer-events: none` 不挡选中 |
| 上下篇 | `.post-adjacent`，同栏目前后各一篇；系列文不显示（顶部已有跳转） | 卡片带「日期 · 栏目」，箭头随方向位移（`prefers-reduced-motion` 下不动） |
| 复制本文链接 | 文章头部 `.copy-link`，只读 `<link rel="canonical">` 的 URL + 复用现有 toast | 纯客户端注入，不进 SSR 输出（ETag 不受影响）；无社交分享、无第三方脚本 |
| 正文图片灯箱 | 点独立成行的 `.md-img` 图放大，ESC / 点蒙层 / 移动端上滑关闭 | 浮层首次点击才 `createElement`、`hidden` 复用；图走 `currentSrc` 现有 R2 链路不多一次回源；行内图不触发；无图集无手势缩放；`prefers-reduced-motion` 关动画 |
| 阅读进度位置 | 头部按钮三态循环：顶部 → 底部 → 关闭，偏好存 `localStorage(x_readbar)` | 白名单拒绝脏值；关闭时 `display:none` 且跳过每帧几何计算；打印仍隐藏 |
| 主题切换过渡 | 切换瞬间给 `<html>` 挂临时 `.theme-transition`，只过渡 color / background-color | `transitionend`（只认 ROOT 自身颜色属性）+ 400ms 定时兜底双保险；静态无 transition 不引 CLS；`prefers-reduced-motion` 直接跳过 |
| 打印 | `@media print`：隐藏导航/目录/评论框，正文全宽，代码块折叠块强制展开，外链后缀显示 URL | 二三十行的量，存 PDF 时不至于把导航栏也印上去 |

> 没有小标题（不足 3 个 h2）的文章不出目录，但**空 `<aside class="post-toc">` 必须留**：`.post-article` 是两列 grid，第一个子元素落在 232px 那一列，少了 aside，正文就被挤进目录列——整篇压成 180px 宽，页面上什么都不报错，只是「看着很窄」。CSS 里另外用 `grid-column` 写死列位置兜第二层。

评论与搜索的几处细节：

| 能力 | 行为 |
|---|---|
| 搜索高亮 | 命中词包在 `<mark>` 里（语义元素，屏幕阅读器会念），英文大小写不敏感，`c++`、`a.b` 这类含正则元字符的关键词不会抛错 |
| 搜索快捷键 | `/` 聚焦搜索框（排除输入框 / 文本域 / contentEditable / 修饰键 / 输入法状态），非空的清除按钮复用 `applyQuery()` 不清空 D1 查询口径 |
| 搜索摘要 | 命中落在正文深处时，摘要改成「关键词前后那一段」而不是开头 140 字，否则高亮标不出东西 |
| 空结果 | 回显关键词 + 两条出口（全部文章 / 按时间归档），不再是一句「没有找到」 |
| 评论时间 | `刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前`，SSR 与客户端同一套刻度；`<time data-t>` 在页面加载后重算一次（边缘缓存最多 5 分钟，不重算就会一直显示「刚刚」），`title` 给准确到分钟的绝对时间 |
| 长评论折叠 | 按渲染高度（>220px）判，不按字数；展开/收起按钮同步 `aria-expanded`，遮罩用 `mask-image` 渐隐 |

```bash
npm run check:ux -- http://127.0.0.1:8788 --q 缓存   # 高亮 / 空结果 / 折叠 / 百分比 / 代码横滚 / 正文宽度
npm run check:sitemap -- https://miu.sryze.cc        # 每条 URL 都有 lastmod、无未来日期、无重复
npm run check:browser                                # 一条命令：灌 D1 夹具 → 起本地 Worker → 跑上面这组页面断言
npm run seed:ci                                      # 只灌夹具（本地空库时文章页全 404，页面断言没有靶子）
```

`check:browser` 就是 CI 里 `browser` job 跑的同一个入口：先建表 + 灌两篇夹具（一篇带目录/长代码行/关键词，一篇无小标题），起 `wrangler dev`，跑完再收服务。CI runner 没有中文字体，同样的字数排出来的行数更少，夹具里那条长评论按「最窄字体」留了余量——它需要稳定超过 220px 的折叠阈值。

配色上 `--muted` 全部提到 4.5:1 以上（`#6f6a63` 在 paper 主题下是 5.36:1；暗色主题值在 4.6–5.0 之间），meta 文字只有 12.5px，原来 3.7:1 是这套界面里唯一真正不合格的可访问性项。

## 图片与第三方请求

页面上的外链越少，首屏越快，被墙的风险面也越小。目前的做法：

| 原来的第三方 | 现在 | 省下 |
|---|---|---|
| `avatars.githubusercontent.com` 头像（每页 1–2 个，单个 30KB） | `/avatar?u=…&s=…` 同源代理，首次回源后落 R2，之后 immutable | 1–2 个连接 + ~26KB |
| Google `s2/favicons`（友链页每个友链一次） | 首字母色块（`span.fav.ph`），有自家头像才出图 | 全部第三方请求 |
| Markdown 正文外链图 | 统一 `loading="lazy" decoding="async"` | 首屏不必等 |

`/avatar` 只放行 `avatars.githubusercontent.com/u/<数字>`，别的域名一律 400——否则这个口子就是通用 SSRF 跳板。

**剩下一个**：Cloudflare 的 Web Analytics（`static.cloudflareinsights.com/beacon.min.js`，约 20KB）。它不属于站点代码，是边缘在 Worker 之后注入 HTML 的，`no-transform` 能挡住但会连带关掉 Brotli（HTML 从 8KB 涨回 25KB，亏），改 CSP 也没用（Cloudflare 会给注入的脚本套上页面 nonce）。要彻底去掉只能在面板关：**Speed → Optimization → Web Analytics**。它本身是 `defer`，不阻塞渲染，留着不影响 LCP。

### 访问统计

默认**零第三方脚本**：`boot.js` 在 `load` 之后用 `sendBeacon` 打一条 `/api/pv`，落 D1 的 `pv` 表，后台 `/admin/stats` 看。IP 做加盐摘要（`sha256(ip|salt)` 前 8 字节）够去重、反查不出人；按北京时间切日；同人同日同页只记一次；爬虫和 `/editor` 不记。

想换成 Umami（或任何 umami 兼容实例），直接在终端里跑不带参数的版本，它会逐项问你：

```bash
npm run setup:umami          # 第一项回车用默认的 cloud.umami.is/script.js，第二项粘 website-id
npm run deploy
npm run verify:umami         # 部署后验收：HTML / CSP / 上报三项一次比完
```

`verify:umami` 读本地 `wrangler.jsonc` 算「应该是什么样」，再去线上比对，两边不一致就 exit 1。它盖住的正是手工检查最容易看错的两处：CSP 只放行脚本源没放行采集端（页面不报错、后台没数据）、以及部署后第一次拉到旧副本（看起来像没生效，脚本自带 cache-buster 和一次重试）。

也可以一次给全：

```bash
npm run setup:umami -- https://cloud.umami.is/script.js 1f2e3d4c-5b6a-4978-8c9d-0e1f2a3b4c5d
```

**别把 `<website-id>` 这种尖括号占位符原样粘进 shell**：`<` 在 bash 里是重定向而不是参数，命令会去找一个同名文件、找不到、在脚本启动之前就断掉，报的是 `No such file or directory` —— 看起来像文件缺失，实际是参数写错了，而且这个形态下什么都不会发生。脚本里做了占位符识别（尖括号、`你的`、`xxxx`、`...`），认出来会直接拒绝并说明原因。

脚本会先拉一次 `script.js` 确认地址真的是 umami，再发一条假事件去问实例「这个 id 存在吗」——id 不存在时 umami 回 `Invalid website ID`，据此在写入前拦掉。`--dry` 只验不写，`--no-probe` 跳过那条会写数据的事件。

两个值必须**成对**：只填 `UMAMI_SCRIPT` 不填 `UMAMI_SITE_ID` 时，脚本会正常下载、正常执行，但一句上报都发不出去（没有 id 就不知道记到哪个站点），而自建上报已经被关掉了。所以缺一个就整体退回自建，`npm run preflight` 会把这种半配单独列出来。

配齐之后**服务端也会停**：`/api/pv` 直接返回 204，不再写 D1。只在页面里写 `__PV_OFF__` 是不够的 —— `boot.js` 是长缓存资源，已经加载过它的浏览器在缓存过期前还会继续上报，加一个人手工 POST 同样能写进去，最后就是你以为切走了、`pv` 表却每天在涨。判断逻辑只留一份（`src/utils.js` 的 `umamiOn`），注入脚本、CSP 放行、服务端停写三处共用，免得各写一遍之后漂掉。

**CSP 要按两个域名放行。** Umami Cloud 的脚本在 `cloud.umami.is`，上报实际打到 `gateway.umami.is`（从 `script.js` 里读出来的）。只放行脚本源的话，脚本能加载、`script-src` 不报错，但每条上报都在 `connect-src` 被静默挡掉 —— 后台一条数据没有，控制台只有一句容易被当成噪声的 CSP 拒绝。`src/security.js` 的 `csp()` 因此把 `script` 和 `collect` 分开处理。

## 友链存活检测

`src/cron.js` 一个文件，`*/20 * * * *` 触发，`ctx.waitUntil()` 托管。规则和坑都写在文件头注释里，这里只记结论：

| 判定 | 条件 | 页面表现 |
|---|---|---|
| 1 正常 | 2xx / 3xx | 绿点 |
| 2 有响应但异常 | 4xx / 5xx（含 WAF 的 403、DNS 失败的 530） | 黄点，tooltip 带真实状态码 |
| 0 挂 | 超时（8s）或连接失败 | 灰点 |

实测数据（都在这台账号上跑出来的）：

| 项 | 数值 |
|---|---|
| 单次 invocation fetch 上限 | 50，且是**累计**计数（先做 3 次其他 fetch，剩 47 次） |
| 跳转是否额外计数 | 否，`http://` 301 到 `https` 仍按 1 次算 |
| 10 个站点串行 | 2026ms |
| 10 个站点并发（批 10） | 332ms |
| 死域名 | 返回 `status: 530`，**不抛异常** |
| fetch 自己 zone 的域名 | 522（37ms），必须跳过 |
| `cf: { cacheTtl: 0 }` | **不绕缓存**，仍 `cf-cache-status: HIT` |

超过 40 条友链时不存游标，用 `ORDER BY COALESCE(NULLIF(checked_at,''),'') ASC LIMIT 40` 让最久没检的排前面，跑完自动轮转。

**出站 SSRF 防护**：友链 URL 是用户填的，Cron 会主动去请求它——这是个天然的 SSRF 口子。`src/cron.js` 的 `resolveTarget()` 在首跳和**每一次跳转**后都过 `isBlockedHost()`，拦截：回环 / 私有段（`10/8`、`192.168/16`、`172.16/12`）、链路本地与云元数据（`169.254/16`，含 `169.254.169.254`）、CGNAT（`100.64/10`）、`0/8`、文档保留段、`localhost`/`.local`/`.internal`、IPv6 回环与未指定地址、ULA（`fc00::/7`）、链路本地（`fe80::/10`）、IPv4-mapped IPv6（`::ffff:127.0.0.1` 剥前缀再判）；域名带尾点、IPv6 带方括号都先归一化。跳转用 `redirect: 'manual'` 自行跟随、上限 5 跳，全程共享一个 8s `AbortSignal`（不让 5 跳把超时放大成 40s），响应只要头——`res.body.cancel()` 立刻断流，不拉正文（cloudflare.com 首页 1.3MB，纯属浪费出口流量）。

**已知残余**：DNS rebinding——域名 A 记录先指公网过校验、再改指内网，Worker 侧挡不住。触发前提是管理员身份填的友链，且探测结果不回显响应体（盲 SSRF），风险有限，代码注释里如实标注。

对应文章：`/p/worker-cron-friend-check`（正文在 `content/07-worker-cron-friend-check.md`）。

## 评论防滥用

三层，命中任一层就拒；管理员自己发言全部跳过（调样式时最容易连发）。

| 层 | 做什么 | 代价 |
|---|---|---|
| 蜜罐字段 | 表单里有个真人看不见的 `hp` 输入框，被填了就说明是脚本在填表 | 0 |
| 频率限制 | D1 记「IP」与「设备 cookie」两把钥匙：同 IP 60 秒一条、每天 10 条；同设备每天 10 条 | 一次 SELECT + 一次 batch |
| Turnstile | 只有配了 `TURNSTILE_SECRET` 才启用，Worker 侧拿 token 去 siteverify | 一次 fetch |

日额度按 **UTC+8** 换天（跟着作者的生活时间走，不是 UTC 零点）。被拦时返回 429，`retry-after` 直接告诉客户端还差多少秒。限额记在 `comment_guard` 表，评论**落库成功才计数**——被 400 拒掉的请求不占额度。

**默认不启用 Turnstile**：没配 key 时一行第三方脚本都不加载，CSP 也不放行 `challenges.cloudflare.com`。要开：

```bash
npx wrangler secret put TURNSTILE_SECRET     # 控制台拿的 secret key
# site key 是公开的，写进 wrangler.jsonc 的 vars：
#   "TURNSTILE_SITE_KEY": "0x4AAAAAAA..."
npx wrangler deploy
```

**管理员的两把刀**：每条评论上的「删除」只删一条；「封 IP」会把这个来源的全部访客评论一起清掉，并在 `comment_guard` 里把 `ip:<地址>` 标成 `banned=1`——之后这个地址再发直接 403。批量删接口：`POST /api/comments/bulk`，body `{"ids":[1,2,3]}`，上限 200 条。

**为什么不做「评论先审核」**：个人站的评论量撑不起审核队列，攒着不显示比被刷更难发现。

## 内容清理

`src/clean.js` 两条路：

- `cleanMarkdown()` 在**写入时**跑：去零宽字符与 BOM、全角空格转半角、去行尾空白、连续空行压成一行、去掉与标题重复的一级标题、清掉空图片空链接。代码块内容原样保留（围栏先摘出来再放回），函数幂等，跑两次结果一致。
- `sanitizeHtml()` 在**渲染时**跑：标签白名单 + 属性白名单，丢掉 `<script>/<iframe>/<object>` 等、所有 `on*` 事件属性、`javascript:` 协议，`style` 只放行 `text-align`，外链自动补 `target="_blank" rel="noopener nofollow"`，顺手清掉空段落。

存量文章想清一遍，登录后台后 POST 一次即可（管理员）：

```bash
curl -X POST https://你的域名/api/maintenance/clean -H "cookie: sid=<你的会话>"
```

返回扫描篇数与改动明细。日常写作不需要手动跑，保存时已经清理过。

## 数字口径

这份文档里出现的「篇」有三种含义，对不上不是数据错了，是口径不同。看数字前先认口径：

| 说法 | 指什么 | 来源 |
|---|---|---|
| **已发布** | 到点可见：`published_at <= now` + `is_private=0` + `hidden=0` + `review_status='approved'` | `/api/posts` 的 `total`、sitemap 条数、RSS `<item>` 条数、首页分页的 `pages` |
| **全库** | `posts` 表的行数，含私密、未列出、待审、未到点的定时稿 | `SELECT COUNT(*) FROM posts` |
| **第 N 篇** | `content/` 下的文件编号，写作顺序，与发布日期无关 | 文件名前缀、`EDITORIAL.md` |

三处必须一致的是**已发布**这一口径：`/api/posts` 的 `total`、`sitemap.xml` 的 `/p/` 条数、`rss.xml` 的 `<item>` 条数。任何一处不同都说明某个查询漏了闸门（`timeGateSql()` / `review_status` / `is_private`），`check:live` 有断言守着。

表数同理：`check:schema` 报的是**业务表**，`sqlite_master` 会把 `d1_migrations`、`sqlite_sequence`、`_cf_KV` 一起数进来。

## 几个实现上的取舍

**Markdown 渲染器前后端同构**：`public/md.js` 同时被 Worker 和浏览器 import。编辑器右侧预览走浏览器本地渲染，零请求零延迟，且和线上输出逐字节一致。语法高亮是内置的 tokenizer，不引 CDN，国内也能秒开。

**图片两条路**：配了 R2 S3 凭据就走 presigned PUT，浏览器直传 R2，不占 Worker 额度；没配则回退到 Worker 中转 `PUT` 进桶。前端会自动选，不需要手动切换。默认用 `/img/<key>` 代理读图，所以**不配公开域名也能用**。

**私密文章在数据层过滤**：所有列表 SQL 都带 `is_private = 0`，单篇在 API 层判断作者，非作者直接返回 404 而不是 403——不泄露文章是否存在。

**两级评论强制封顶**：回复子评论时 `parent_id` 会被归到它的顶级评论，前端只在两层里渲染，树永远不会加深。

**会话是无状态签名 cookie**：HMAC-SHA256 签 `{uid, exp}`，不查库不占 KV。代价是没法单点踢人；要踢就改 `SESSION_SECRET`，全员重新登录。

## 常见问题

**图片上传 403**：R2 的 CORS 没配，或 `AllowedOrigins` 里没写你的域名。

**登录后还是普通用户**：管理员席位不会按登录顺序自动发放。三种提权方式，从干净到粗暴：

1. **`ADMIN_LOGINS` 环境变量**（推荐）：逗号分隔的 login，每次登录同步回库，改配置即生效，不用碰库。
2. **`BOOTSTRAP_TOKEN` 引导令牌**：只在库为空时有效，`/login?bootstrap=<令牌>` 登录一次即成为管理员；库里有行之后令牌自动失效。
3. 直接改库：

```bash
npx wrangler d1 execute blog-db --remote --command "UPDATE users SET is_admin = 1 WHERE login = '你的GitHub用户名'"
```

**友链圆点全是灰的**：Cron 只在部署后按 20 分钟周期触发，刚加上去需要等一轮，或在友链页点「立即重新检测」。

**改完 `wrangler.jsonc` 没生效**：`vars` 改动需要重新 `wrangler deploy`，本地开发则重启 `wrangler dev`。

**文章名和静态页冲突**：`/login`、`/editor`、`/friends` 这些是保留路径，别名别用它们。想把文章放根路径就直接填 `about`。
