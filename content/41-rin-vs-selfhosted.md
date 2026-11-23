## 结论

Rin 和这套站押的是同一个假设：Cloudflare Pages 托管前端、Workers 跑后端、D1 存数据、R2 放图片。都免服务器、免备案，都只需要一个指向 Cloudflare 的域名。

但两个项目的目标几乎是相反的。Rin 要的是"任何人一条命令开箱即用"，我要的是"每一行我都知道它在干什么"。

这个差别不体现在技术选型上——选型反而高度重合。它体现在**谁来保证它不悄悄坏**：Rin 的答案是类型系统和测试覆盖率，我的答案是十几个盯线上现象的断言。

先把硬数字摆出来，两边都来自各自仓库的公开文件：

| | Rin | 这套站 |
|---|---|---|
| 运行时依赖 | server 15 个 + client 42 个 | **0**（`package.json` 里没有这个字段） |
| 构建期依赖 | turbo、wrangler、typescript 等 | 3 个（`puppeteer-core` / `sharp` / `wrangler`） |
| 语言 | TypeScript，端到端共享类型 | 纯 JavaScript，无类型检查 |
| 代码规模 | Bun 工作区四包（client / server / packages / cli） | `src/` 30 个文件 8647 行 + `public/` 两个大文件 1139 行 |
| 协议 / 热度 | MIT，3151 star（2026-11-23 快照） | 私有仓库，18 篇线上文章 |

**我没有部署运行过 Rin。** 下面所有关于它的描述都来自 README、`package.json`、`.env.example` 和 GitHub API，来源逐条列在文末。真实行为以它仓库的最新代码为准，我读到的版本是 `0.3.0`。

## 一、同一套假设，两种实现

| 维度 | Rin | 这套站 |
|---|---|---|
| 前端 | Pages + React 18.2 + Tailwind 3.4 + Vite 6 | Worker 直出 HTML，无前端框架 |
| 后端 | Workers + **Hono 4.12** | 单 Worker，手写路由分发 |
| 数据库 | D1 + Drizzle ORM 0.30 + drizzle-kit | D1 裸查，`prepare().bind()` |
| 图片 | R2 / S3 直传（`aws4fetch`），生成链接 | 上传直传、读取走 `/img/` 代理、SVG 单独沙箱 |
| 构建 | Turbo 1.13 + Bun 1.3 工作区 | 近乎零构建，`build:sri` 只算内容哈希 |
| Markdown | unified / remark / rehype 管线 | 自研渲染器 `public/md.js`，622 行 |
| XSS 防护 | `rehype-sanitize`（成熟库） | 自研白名单 + 先转义后拼装，不引 sanitize |
| 认证 | GitHub OAuth + 账号密码，首个注册者即管理员 | 单管理员登录格 + OAuth 回调 |
| 部署 | `bun run deploy`：建 D1、跑迁移、部署前后端 | `npm run deploy`：先全量单测，再 `wrangler deploy` |

先说一个容易看错的地方：**Rin 的后端是 Hono，不是 Elysia。** 我在别的资料里见过把它写成 Elysia 的说法，`server/package.json` 里写的是 `"hono": "^4.12.2"`。这类错误在技术对比里很常见，也是我为什么把每条来源都列出来的原因。

依赖数量那一行值得停一下。57 个运行时依赖对 0，看起来像"谁更克制"的比拼，其实不是。Rin 要开箱支持多用户、i18n、Monaco 编辑器、Mermaid、图片处理、S3 兼容存储，这些能力本身就意味着一堆包。**我的 0 依赖不是因为更聪明，是因为我把这些能力全砍掉了**——没有多用户、没有 i18n、没有富文本编辑器、图片处理用 `sharp` 在构建期做掉。

0 依赖换来的东西是具体的：运行时没有供应链面（构建期还剩 3 个，见上表），升级不跟任何上游 breaking change，出问题时栈里只有我自己写的代码。代价同样具体：所有轮子都得自己造，而且**没人替我修**。

### 关于 Drizzle 的那点讽刺

有一层对比我一开始写错了，得先纠正。

Rin 用 drizzle-kit 管迁移（`db:gen` → 生成 SQL → 随部署执行）。我的站踩过一个坑：本地 D1 和远端 D1 是**两个实例**，`schema.sql` 和 migrations 各描述一遍表结构，漂移过一次（`friends` 表缺 `http_status` / `latency_ms`，线上却有三个索引没记），详见[no such table 那篇](/p/d1-no-such-table)。

直觉结论是"用 ORM 也没用"，但这句话不准确。Drizzle 解决的是**schema 只有一处描述**，这恰好是我那类漂移的根因；它不解决的是"两个实例、两份状态"。后者跟 ORM 无关，任何工具都替不了。

我最后做的是在 `node:sqlite` 内存库重放全部迁移、比对建出来的结构（`scripts/test-schema.mjs`）。这件事 Drizzle 用类型系统做了一半，我用运行时比对做另一半。**不是替代关系，是同一件事的两个手工版本。**

## 二、功能几乎一一对应，差别在"你怎么知道它坏了"

Rin 的 README 列的每一条，我这边几乎都有对应实现。四组摆在一起看，分野就出来了：

| 功能 | Rin 的表述 | 我这边的表述 |
|---|---|---|
| 自动保存 | "Local drafts are saved automatically in real-time, with isolation between different articles" | 本地直写不防抖、云端 3 秒单句柄、响应带版本号才清 dirty |
| 友链检测 | "The backend automatically checks link availability every 20 minutes" | 50 次 fetch 是累计计数、403 与 530 分三态、同 zone 回 522 |
| 图片 | "Drag-and-drop or paste images to upload directly to S3-compatible storage, with automatic link generation" | `/img/` 代理、key 白名单、SVG 沙箱的 CSP 与 content-type 判定 |
| 评论 | "Reply to comments or moderate them with delete functionality" | 蜜罐 + Turnstile + D1 三层按成本排序 + 响应出口脱敏 |

左边是**功能声明**，右边是**失效条件**。

差别不在谁写得好看。功能声明回答"它能不能用"，失效条件回答"它什么时候不能用、不能用的时候长什么样"。后者才是半夜被叫醒时你需要的东西。

举一个最小的例子。Rin 的友链检测写"每 20 分钟检查一次可用性"，这句话完全正确，也完全不够用。我的那版里，三个问题必须先有答案才能写代码：

- **50 次 fetch 是累计计数还是并发计数？** Workers 单次 invocation 的 subrequest 上限是 50（免费计划），付费计划高得多，但免费额度才是 cron 的真实约束。计数是累计的——包括本函数之前发过的请求。所以必须串行发、自己数，到 40 就停，留 10 次余量。
- **403 算挂了吗？** 不算，但也不能当"正常"。很多站开了 WAF，机器人访问一律 403，人访问正常。所以状态不是二分，是三态：`0` 网络层没通、`1` 拿到 2xx/3xx、`2` 拿到了响应但状态异常。403 落进 `2`，跟"连不上"的 `0` 分开——否则半个友链圈都会被判成挂。
- **同 zone 的请求会怎样？** 会回 522，实测 37ms 就返回。Worker 请求自己所在的 zone，走的是同一套边缘逻辑，超时就自己咬自己。所以自己域名必须先排除，不能靠超时兜。

这三条都不在"每 20 分钟检查一次"这句话里，但每一条都能让那个 cron 变成噪音源或者永久失效。

反过来说，Rin 那边没有这些记录，**不代表它没处理**——它可能有更简洁的实现，只是没写进 README。我读不到它的内部判断，就不替它下结论。

## 三、质量保障：他守代码正确性，我守线上现象

这一节必须先说清楚：**Rin 的 CI 比我完整，这是事实，不是客套。**

它的四条 workflow 分工明确：

```text
ci.yml      → tsc 类型检查 + 格式校验
test.yml    → server + client 全量测试，带覆盖率（lcov）
build.yml   → 构建，触发部署
deploy.yml  → 部署到 Pages + Workers
```

加上 `turbo check` / `turbo format:check` / `bun test --coverage`，这是工程化该有的样子。我的站没有类型检查（纯 JS）、没有覆盖率统计、没有 client/server 分层测试——因为我没有 client/server 之分。

但两边断言覆盖的东西不重叠，这点值得说清：

| | Rin 的断言覆盖 | 我的断言覆盖 |
|---|---|---|
| 对象 | 代码行为 | 线上现象 |
| 例子 | 函数返回值、组件渲染、API 响应体 | `isPartOf` 指向自己的 URL、`--muted` 对比度 4.16、sticky 包含块 336px |
| 失败形态 | 测试变红 | **测试照绿，线上悄悄不对** |
| 谁先发现 | 开发者，提交前 | 我，几周后，靠抓 HTML |

第三行是关键。`isPartOf` 自指那件事，所有单测都是绿的——那个字段确实输出了、语法确实合法、URL 确实能打开。它错在**语义**，而语义不在任何单测的断言范围内。同类还有：CLS 0.0176（页面能正常打开）、sticky 失效（目录还在，只是不吸顶）、subrequest 计数取在派发那一刻（日志里有值，只是值是 0）。

这些错误的共同点是**不会让任何测试变红**。它们需要一个更笨的东西盯着：把线上 HTML 抓下来，用正则和字符串比对。

我的那套断言里，最土的一条是：

```js
ok(!art.isPartOf.url.includes(art.url.split('/p/')[1]), 'url 不能包含自己的 slug');
```

它断的不是"等于 `/series/xxx`"，而是"不能包含自己的 slug"。前者会随实现漂移，后者断的是错误形状——系列页地址怎么改，自指永远违反这一条。这个思路和"只测函数返回值"是两种世界观：一个假设未来不会变，一个假设实现一定会变。

**两边是互补关系，不是替代。** 如果哪天要把这两套合并，正确顺序是：先用他的类型和单测把代码正确性焊死，再用我的线上断言抓语义和回归。反过来不成立——线上断言抓不到逻辑分支，单测也抓不到语义错误。

## 四、值得抄的一处：配置优先级

`.env.example` 这个文件，绝大多数项目写得敷衍。Rin 这份值得单独拿出来说。

三点：

**一、分区注释。** 文件按"站点配置 / 后端配置 / 敏感配置 / 数据库配置"分块，每块之间用 `# ====` 隔开。看一遍就知道哪几项必填、哪几项可以留空。

**二、每项都写明默认值。** 不是"留空则用默认"，而是：

```text
# 网站描述（默认：A lightweight personal blogging system）
# DESCRIPTION=A lightweight personal blogging system
```

注释行被 `#` 掉了，所以不填就是默认；要看默认值是什么，直接读被注释掉那一行。这比"默认值见文档"少一次跳转。

**三、配置优先级写明白了。**

```text
# 配置优先级：设置页面 > 环境变量 > 默认值
```

这一行是整份文件里最有价值的。它回答了"我改了环境变量为什么没生效"——因为设置页面的值优先。我见过太多项目在这一层含糊，最后所有人都在猜。

**我的站现在是环境变量优先，且只有环境变量。** 单人维护时这没问题：改配置就是改 `wrangler.jsonc` 再部署。但如果哪天开放给第二个人用，"环境变量压过设置页"就会变成一个反复解释的坑——用户在后台改了站名，刷新发现没变，因为 `.env` 里写死了。

这条我记下来了，暂时不改。它是"开放给第二个人"这个前提才成立的重构，不是现在该做的事。

## 五、不能抄的一处：第一个注册的人就是管理员

Rin 的 README 写得很明白：

```text
The first registered user becomes an administrator,
while subsequent users join as regular members.
```

对一个自己部署、域名只有自己知道的实例来说，这个设计没问题——第一个注册的就是你。但它的前提是"部署完立刻去注册"。

`.env.example` 里还有第二层：

```text
# 管理员账号密码（用于账号密码登录，如果不配置 GitHub OAuth 则必须设置）
# 默认账号: admin
# 默认密码: admin123
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
...
JWT_SECRET=your-jwt-secret-key
```

要说得精确：**这些是模板默认值，不是泄露的真实密钥。** 文件头也注明了"敏感配置（会被加密存储）"，说明这些值落库时会加密。这不是安全漏洞，是一个**默认凭据**。

但默认凭据的风险是具体的：部署者如果没配 GitHub OAuth、也没改这两行，实例就是"admin / admin123 可登录 + JWT 密钥为公开字符串"。对一个公网可达的地址，这等于把管理员席位放在门口。

组合起来更要注意：**首位注册者即管理员** + **默认凭据可用**。如果站点先被人发现、后被你注册，两个入口都通向同一个位置。

我的站没有这个面，因为**根本没有注册入口**：单管理员，账号在环境变量里，登录格只认那一个。少一个功能，也少一整类风险。

这不是说 Rin 做得差。开源项目要开箱即用，默认值必须存在，否则新人第一步就卡住。"默认值 + 文档警告"是标准做法，我只是在说：**这套默认值不能原样搬到公网**。抄之前先看清它假设了什么。

## 六、明说的没做

这篇的边界比正文重要，因为它是二手观察：

| 没做 | 原因 | 影响 |
|---|---|---|
| 部署运行 Rin | 只读公开文件 | 性能、真实交互、边界行为都未验证 |
| 跑它的测试套件 | 没 clone | 不知道覆盖率具体百分比，只知道有 lcov 输出 |
| 做性能对比 | 页面结构、请求数、功能集都不同 | 比 LCP 或 TTFB 不公平，结论不可用 |
| 验证"Rin 当脚手架 + 接我的渲染器" | 没做 | 这条只是可行性推断，不是实测结论 |
| 逐条对照功能实现 | 只读了 README 与两个 `package.json` | 它可能有更完善的实现，只是没写进文档 |

还有一条要主动交代：**star 数、依赖数量、代码行数都是 2026-11-23 的快照。** Rin 在活跃维护（最后 push 11-15），我这边也在改，这些数字半年后都会过期。写对比文最危险的地方就是把快照当常量。

最后是一个判断，不是事实：Rin 的 README 回答"它能做什么"，这套站的十几篇文章回答"它什么时候会坏"。前者决定你要不要用，后者决定你用起来会不会半夜被叫醒。两个问题都重要，只是问的人不同。

## 怎么自己复核

所有引用都能在这几个位置找到，不用信我：

```bash
# 技术栈与功能清单
https://github.com/openRin/Rin/blob/main/README.md

# 多包结构、Turbo、Bun、部署脚本
https://github.com/openRin/Rin/blob/main/package.json
# server 15 个运行时依赖，Hono 而非 Elysia
https://github.com/openRin/Rin/blob/main/server/package.json
# client 42 个运行时依赖，含 rehype-sanitize
https://github.com/openRin/Rin/blob/main/client/package.json

# 配置优先级、默认凭据
https://github.com/openRin/Rin/blob/main/.env.example

# star / license / 最后提交时间
https://api.github.com/repos/openRin/Rin
```

我这边对应的数字是现成的：

```bash
node -e "console.log(require('./package.json').dependencies)"   # undefined（没有这个字段）
wc -l src/*.js | tail -1                                        # 8647
ls src/*.js | wc -l                                             # 30
node scripts/check-pitfalls.mjs                                 # 17 条断言与文档对账
```

#cloudflare #architecture #comparison #opensource
