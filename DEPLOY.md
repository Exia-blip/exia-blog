# 部署自检清单

每次改完照此跑。`npm run deploy` 已把第 1、3、4 步硬化进发版路径（自动跑、失败即停），
第 2 步是独立项（CI 跑，本地夹具偶有问题），第 5 步按需。

## 1. 本地单测（部署前 · 自动）
```bash
npm test
```
覆盖 markdown / 清洗 / 静态资源 / 图片安全 / 反垃圾 / 路由 / SEO / 时区 / SVG CSP /
srcset / alt 等全部管线。这是图片管线回归的最后一道闸——线上体检未必测得到这些。

## 2. 浏览器交互检查（独立 · CI 跑）
```bash
npm run check:browser
```
自起本地 Worker + D1 夹具，跑顶栏 / 搜索 / 滚动 / 目录 / 阅读进度等页面级断言。
**本地偶发「搜索 0 结果」是夹具数据问题**（线上搜索正常，可 `curl '/api/posts?q=缓存'` 核对），
不要因此阻塞发版；CI 环境夹具干净时全绿。

## 3. 部署
```bash
npm run deploy
```
它会自动：配置体检 → `npm test` → 带新资源版本号部署 → `npm run check:live`。
不要绕过它直接 `npx wrangler deploy`（丢版本号 + 丢所有关卡）。

## 4. 线上体检（部署后 · 自动）
```bash
npm run check:live
```
打 `https://miu.sryze.cc`，逐项检查响应头 / CSP / 缓存规则 / srcset 实物 / alt / 103 预加载 /
零外链头像 / 零注释泄漏 等。项数随断言增长，以脚本输出为准（这里不写死数字）。
部署脚本已在部署后自动跑这一步。

## 5. 按需确认项
```bash
npm run backfill:check     # 正文渲染缓存有无空行（退出码 0=无需 / 1=需回填）
npm run ttfb               # TTFB 分缓存态 P50/P95（HIT/MISS/DYNAMIC）
```

### check:dom 的显式处置（2026-11-25）

`- check:dom` 默认打本地 `127.0.0.1:8787`，本机没起 dev server 时必然 `fetch failed`——
  它压根没打线上，所以这条红不反映线上回归。`npm run deploy` 的前置闸门本来就只有
  `check-env` / `npm test` / `schema check`，不含 `check:dom`，不会被它挡住。
  为避免它变成「反正每次都红」的噪音，`npm run check` 里换成 `check-dom-note.mjs`
  打印跳过原因；独立命令 `npm run check:dom` 原样保留，CI 由 `ci-browser.mjs` 传
  本地 Worker BASE 覆盖，线上由 `check:live` 覆盖。**这是真·未验的留痕，不是消除检查。**

### 换主域时的仓库外动作（ Worker 改 SITE_ORIGIN 只解决代码侧）

`wrangler.jsonc` 的 `SITE_ORIGIN` 是唯一运行时开关；canonical / JSON-LD / RSS /
sitemap / OAuth 回调 / 友链自环 全部从它派生。但它管不到下面这些外部登记项，
漏一项的典型症状都是「站内全对、登录或评论静默失效」：

| 项 | 动作 | 漏了的症状 |
|---|---|---|
| **GitHub OAuth App → Authorization callback URL** | 改成 `https://miu.sryze.cc/auth/callback`（GitHub 只认登记值，而且往往只能登记一条；改之前旧域那条要换掉） | 点登录跳回 GitHub 报 `redirect_uri MUST match` |
| **Turnstile widget → Hostname** | 2026-11-25 已建 widget `miu-blog-comments`（managed，domain `miu.sryze.cc`）；sitekey 在 `wrangler.jsonc` vars、secret 走线上密钥。`npm run preflight` 两项均「已配」 | 配了一半时前端照常弹框，服务端 `siteverify` 永远验不过 → 评论全量拒收 |
| **Cloudflare Zone 级规则** | 新域是独立 active zone（`miu.sryze.cc`），不是根域 `sryze.cc`。Transform Rules / WAF / 缓存规则按 zone 归属，不会跟 Worker 自动迁移；需要时跑 `node scripts/apply-edge-headers.mjs` 前先确认 `CF_ZONE=miu.sryze.cc` | Worker 侧 CSP 仍生效（每个响应都带），但 zone 级 `X-Content-Type-Options` 之类少一层 |
| **旧域整站 301** | Worker 侧已实现：`src/utils.js` 的 `hostRedirect()`，在 `handleFetch()` 里位于 HTTPS 之后、边缘缓存之前、路径规范化之前。配了 `SITE_ORIGIN` 即生效，不用改代码；想省掉每次旧域请求唤起 Worker 的开销，可在旧域那个 zone 加一条 Redirect Rule（`Hostname equals 旧域` → 301 → `SITE_ORIGIN`，保留 path 与 query），规则先命中、代码当兜底，两者不冲突 | 旧域照样 200 并吐同一份全站内容：同一页面被两个域名各抓一遍（抓取配额翻倍）、两个 zone 各算一份统计、指向旧域的外链只能靠 canonical 归并、从旧域点内链跳新域（半个跳转） |
| **DNS** | 已就绪：`miu.sryze.cc` 有 A 记录且路由到同一 Worker，无需动作 | — |

旧域 `exia.de5.net` 保留在 `src/cron.js` 的 `LEGACY_SELF_HOSTS` 里：它仍绑着同一 Worker，
不屏蔽就会被友链巡检当成外部站探测一次（实测 522）。这一段不是兼容层，是自环保护。
对访客和爬虫，它现在由 `hostRedirect()` 整站 301 到主域 —— 那才是兼容层，两件事别混。

**判据**：`curl -sI https://exia.de5.net/ | head -1` 必须是 `301`、`Location` 是主域。
`200` 就是没生效，**别把「打得开」当成正常**（P-085）。GET/HEAD 给 301，其余方法给 308：
301 会让浏览器把 POST 降级成 GET 并丢掉 body，评论提交和 OAuth 回调都会静默变成读请求。

**旧域「还吐 200」时先分清是哪一层缓存，两层长得很像、处置完全相反：**

| 层 | 位置 | 会不会挡住 301 | 处置 |
|---|---|---|---|
| `caches.default` | Worker 内（`edgeGet`/`edgePut` 那套，键含完整 URL） | **不会**——`hostRedirect()` 在它之前，命中前就跳走了 | 什么都不用做；`purge_cache` 也清不到它（那是 zone 级 API），只能等 `s-maxage` 自然过期 |
| zone 级 CDN 缓存 | Worker 外，只有 zone 配了 Cache Rule 才存在 | 会 | 面板 Purge Everything，或 `POST /zones/<zone_id>/purge_cache` |

判据是**时序**，不是响应头：部署后立刻用同一个键请求旧域（`check:live` 的 `[HOST]` 段就在这个时点）——
立刻 `301` 说明缓存位于 Worker 内层，不用清；仍 `200` 且带 `Age` 才是 zone 层。
两者都会给 `CF-Cache-Status: HIT` + `Age`，**看头分不出来**。

### 审核态匿名可见性（有 pending 样本时做）

四项状态，两项已实测、两项仍是读码结论 —— 不要把后两项读成「已验过」：

| 状态 | 结论 | 依据 |
|---|---|---|
| `approved` + 预排未到 | 匿名两次 404，正文不泄漏 | 实测。该态会进实例 LRU，第二次仍 404 → 读侧闸在缓存命中后照常执行 |
| 私有稿 | 匿名两次 404，正文不泄漏 | 实测 |
| `pending` | 匿名应 404 | **未实测**（当时库里无 pending 样本）。读码：`src/index.js` 的 1136/1142/1147 三闸在渲染之前 |
| `rejected` | 匿名应 404 | **未实测**（库里 0 条）。同上 |
| 作者登录预览私有/待审稿 → 匿名再读 | 预览不污染匿名缓存 | **未实测**（需 OAuth 凭据）。该半测的是会话与缓存的交互，与 `review_status` 无关 |

等真有 pending 稿时，四步闭环（不需要作者登录）：

```bash
# 1. 任意账号发一篇稿 → 进 pending，记下 slug
# 2. 匿名取：应 404
curl -s -o /dev/null -w '%{http_code}\n' https://miu.sryze.cc/p/<slug>
# 3. 管理员在 /admin/review 通过后，匿名再取：应 200
# 4. 驳回后，匿名再取：应 404
```

第 2/3/4 步各取两次，才能同时覆盖「写 LRU 后读侧闸仍执行」。作者预览那半只能等有真实登录态时补，不能用这四步代替。

### 评论通知链路的验证边界（2026-11-25）

Webhook 用自建 sink（`webhook-sink/`，CF Worker + 专用 KV）验过真发真收；但覆盖的是通知链路本身，不是评论提交全链路。和上面那组「已实测 / 读码结论」并排记，别把未验那行读成已验：

| 环节 | 结论 | 依据 |
|---|---|---|
| 通知构造（💬 新评论 payload） | 已验 | `src/webhook.js` 的 `notifyComment` 真代码 |
| 通知传输（POST → sink → KV） | 已验 | 真网络、真写库，inbox 看到完整 payload |
| 平台码判定与落库闸门 | 已验 | 真端点两条路径：errcode 0 写入；HTTP 200 + 93000 → die 且不覆盖 secret |
| 写入前自检 / 写入后回打（冒烟） | 已验（脚本内；**只到写入与传输**） | `setup:webhook` 在 `putSecret` 前后各走一次同一个 `smokeWebhook`（带 label），复用 `webhookPayload`；93000 → die，写入前失败时现役 secret 未被覆盖；`--dry` / `--no-smoke` 显式打印跳过；**注入验证均先红后恢复**。这行验的是配置写入与平台码传输，**不是评论触发**——别读成「通知链路全验过了」 |
| wrangler 空 stdin 静默成功（workers-sdk#16193） | 已验（闸门在调用前） | `putSecret` 入口拦空值：非 TTY 下 `wrangler secret put` 会上传空值、打印 `Success`、exit 0，`preflight` 还把空串报成「已配」。注入去掉闸门 + 传空值 → 假 wrangler 静默通过且体检给出「WEBHOOK_URL 已配」；装回闸门 → die 且不进体检 |
| 写入值 → `env.WEBHOOK_URL` 绑定 → Worker 真发（代码链） | 已验（本地断言） | `test-setup.mjs` 用假 wrangler 捕获真正写进去的 name/value，再喂给真 `notifyComment` 打到 mock sink；四处注入（读错键 / 写错名 / 写入值被包装 / payload 形状被改）均先红后恢复 |
| 评论落库 → 触发 `notifyComment` | **本地已验 + 线上已验（管理员身份）** | 2026-11-26 本地 dev 真发一条评论（`POST /api/comments` → `{ok:true,status:"pending"}`），本地 sink 收到 `[待办] 新评论待审…`，库里 `notify_status=ok / notify_note=待办提醒 / notified_at` 与 `created_at` 同秒。那一轮把 `TURNSTILE_SITE_KEY` 置空跑的，**只覆盖「落库 → 通知」这段，不含 Turnstile 那一跳**。线上同一段 2026-11-26 23:57 也已验：管理员 cookie 走 `POST /api/comments` 真发 #18（`status=approved` / `is_admin=1` / `notify_status=ok` / `notify_note` 为空＝首次投递而非「补发」），与访客共用 `notifyForComment`。**未覆盖的只剩真人过 Turnstile 那一跳**（管理员豁免）。投递到群这一格 2026-11-27 已由维护者肉眼确认（#18 的 💬 真实到达，见本节末）。没有管理员态时仍可跑 `npm run verify:comment-e2e -- <slug>`：用唯一 nonce 同时查 D1 公开评论与 sink inbox 的 💬 payload，两边都命中才算过；判据自检 6/6 已进 `npm test`、两次注入（去形状判据 / 去回复递归）均先红后恢复 |
| 浏览器真过 Turnstile → 提交评论 | **未验** | managed 模式在无头/有头自动化浏览器都拿不到 token，需真实人工点一次验证码；上面那个脚本不自动提交、只观察，token 从 `SINK_URL` 环境变量读且不回显 |

**判据的强弱顺序（留痕按这个写）**：`群里真的跳出 💬` > `D1 + sink 双源命中同一个 nonce` > `脚本单侧命中`。
理由不是「多查一处更硬」，而是覆盖面不同：双源守的是「落库了但通知没发」这条缝；消息真进群说明投递确实发生了，
它把「`notifyComment` 被调用」和「sink 收到」两步一起覆盖，范围比两个接口都命中更大。所以留痕优先写「群里收到」
（前提是留痕的人有群入口——2026-11-27 维护者已确认在群内看到 #18 的 💬，这条前提当下成立）。
双源脚本（`verify:comment-e2e`）的价值主要在**排查定位**：群里没消息时跑一次，D1 缺 = 评论没落库，sink 缺 = 通知没发，
一次分清哪半步断，不用两边猜。平时不必跑。
`SINK_URL` 带 `token=` 查询参数，**它本身就是凭证**：只在 shell 里 `export`，别贴进对话、别写进文档、别进任何提交。

**补发（`npm run notify:resend`）是独立端点，不是后台按钮**：`POST /api/comments/notify`（仅管理员、`no-store`）+ 本机 CLI
（`scripts/notify-resend.mjs`）。`/admin/notify` 保持只读 —— 通知没有幂等键，在只读页放按钮等于给每次误点开一条写路径。
补发语义与首次推送**同源**（都走 `webhook.js` 的 `notifyForComment`：待审发待办提醒，其余发 💬），所以重投不会变成另一种消息。
拒绝状态 409（补发是重投，不是翻案）、3 秒内重复 429（CLI 自动等一次再试）、原文章已删 404（宁可发不出去，也不发半条）。
结果写回 `notify_status / notify_note`（前缀「补发」，事后能分清哪次是手工重投）/ `notified_at`，并进 `audit_log`。
**退出码就是判据**：0 = 平台回执 ok；1 = fail（平台码 93000 会点名「地址失效」）；2 = skip（没配 `WEBHOOK_URL`）；3 = 鉴权 / 参数 / 条目不存在。
**`ok` 已经排掉两类怀疑**：地址失效与机器人被移出群都回 `200 + errcode 93000`，`sendWebhook` 判 `fail`。所以「`notify_status=ok` 但群里没消息」只剩一种可能——`WEBHOOK_URL` 指向另一个同样有效的群（两个群都回 0，机器分不出来）。那一步去对机器人配置，不是查代码。

**这条已验：2026-11-27 维护者在群内看到 #18 的 💬。** 这是最强一档判据，不是 `ok` 的另一种说法——
`notify_status=ok` 只能排掉「地址失效」与「机器人被移出群」（两者都回 `200 + errcode 93000`，`sendWebhook` 判 `fail`），
排不掉「`WEBHOOK_URL` 指向另一个同样有效的群」：两个群都回 0，机器分不出来，只有人眼能分辨。
这次就是人眼分辨的：看到的那条对应 #18（管理员身份、`notify_note` 为空 = 首次投递，不是「补发」）。
**改群或换 webhook 时这一格要重新验一次**——`ok` 不能替代它，把这次的结论当成永久有效，就是又造一份会过期的记录。
同理，第 123 行的「留痕优先写群里收到」只在留痕的人有群入口时成立；没有入口时写 `ok` + 它排除掉的那两类，
不要用「应该收到了」凑数。
不带 `--id` 时补发最新一条 —— 发完评论紧接着跑的那条命令就是它。

**评论巡检（cron 每 20 分钟，与友链巡检同一个触发器）**：`src/cron.js` 的 `sweepComments` 做两件事。
① 补推：`notify_status` 为空（没尝试过）或 `fail` 的，按下面三条边界重投一次（待审的仍走待办提醒）。
**三条边界全部写在同一条 SQL 里，调用方拿不到也改不掉**——改调用方（加参数、换入口）不会把窗口弄丢，
和 `navCounts` 把 `-7 days` 写死在 179 行是同一手法；写在 SQL 里还顺带排除了「内存计数」这条路
（Worker 每次冷启都是新进程，内存计数等于没有）：

| 边界 | SQL 里的形状 | 没有它会怎样 |
|---|---|---|
| 下界 6 小时 | `created_at >= datetime('now','-6 hours')` | 两年前的评论半夜被捞出来推进群 |
| 冷却 1 小时 | `notified_at <= datetime('now','-1 hour')` | 每 20 分钟重投一次，6 小时内 18 次 |
| 每轮 10 条 | `LIMIT 10` | 平台抖动积压时一次把队列打穿 |

**不按 `is_admin` 过滤**：首次投递（`POST /api/comments`）不区分身份，补推曾经多带一个 is_admin 条件，
两条路径判据不一致 = 管理员自己发的评论「第一次失败就没人管」。这种不对称不报错、不改状态码、CI 全绿，
只有对照两条路径才看得出来（P-082）。所以旧的操作纪律「自己发的评论失败了只能手动 `notify:resend`」
**已作废**：管理员评论与访客一样进补推队列，6 小时内最多约 6 次。
手动通道保留，用途不变：历史 `skip` 记录、以及等不及 20 分钟 cron 时立刻重投 —— 它是坏了才用的东西。
② 清垃圾：`src/spam.js` 按可机械判定的形状打分，`SPAM_MIN_SCORE=4` 才删。**三条免检线**：管理员自己发的、
有回复的（删父会连坐子回复）、已拒绝的 —— 任一成立直接跳过，且这三条在 JS 里再过一次，不只依赖 SQL 的 WHERE。
（补推不做身份过滤，清垃圾做：删自己发的评论没有「第一次失败就没人管」这种不对称。）
删除是**硬删**，所以 `audit_log`（`comment.spam.purge`）里那段「分数 + 命中规则 + 原文片段」是唯一的溯源材料。
手动入口 `npm run comment:sweep`，**默认 dry**（只列会删谁、不发不删），`--apply` 才动手。
误删过就调 `SPAM_MIN_SCORE`，别去删规则 —— 规则表在 `spam.js` 文件头，每条都注明了它的误杀面。

冒烟守得住「写入动作没把地址弄坏 / token 在写入窗口被轮换 / sink 此刻可用」，**守不住「写进去的值和 sink 认的值不是同一个」**：CF secrets 只可写不可读（`wrangler secret list` 只列名字/类型，没有长度或哈希），回打用的还是本地 `url` 变量。补上本地断言后，代码链（写值 → 绑定名 → 真 `webhook.js` → sink 接受）已验；2026-11-26 的本地真发把「评论落库 → 触发通知」补成了本地已验，同日的线上真发 #18（`notify_status=ok`）把它补成了线上已验。**未验的只剩一条**：真人过 Turnstile 那一跳（managed 模式拿不到 token，见本节末）。CF 线上实际存的值已由那次线上回打证实，不要再读成「线上绑定未读回」。

**空值闸门的位置不能挪到回打里**：回打打的是本地 `url`，wrangler 把空值写进去时它照样 errcode 0；写进去之后 secrets 读不回，没有第二次机会。所以 `putSecret` 入口的 `if (!value || !String(value).trim()) die(...)` 是唯一能挡空 stdin 的地方。wrangler 的 `isTTY ? prompt() : readFromStdin()` 路径在 workers-sdk#16193 已确认，本机 `wrangler-dist/cli.js` 里也能读到同一分支。**不要用 `printf '' | wrangler secret put WEBHOOK_URL` 去线上复现**——那会真的把现役 secret 清空并触发部署；本地用假 wrangler（收到空 stdin 仍 exit 0）复现同一形状即可。冒烟失败不回滚 secret——回打失败可能是 sink 抖动，回滚会把「地址本身错」和「sink 短暂不可用」混成一件事。

`managed` 模式拿不到 token 这件事本身是停手条件：自动化先红，停在 review，不是缺代码——端到端那半只能等一次人工点击。**冒烟进了脚本不等于端到端已验，两件事并排看，别让前者盖住后者。**

**本地起 sink 不要用 shell `&`**：`node sink.mjs &` 起的进程随那条命令结束被杀，评论侧写回的 `notify_note` 变成 `Network connection lost.` —— 看着像 `webhook.js` 的 bug，其实是端点已经不在。排查顺序固定：**先确认对端活着（`curl -s <sink>/inbox` 有没有回 200），再读自己的栈**。这是「接口说成功、业务其实没通」的镜像，这次是「接口说失败、其实是端点不在」。同一轮还有两个附带条件：本机走代理时 Worker 打 `127.0.0.1` 也会走代理，`NO_PROXY=127.0.0.1,localhost` 必须带上；后台进程用工具的后台任务跑，不要用 `&` 或 `nohup`。

sink 项目在工作区 `webhook-sink/`，**不在** `check:dom` / `check:size` 等博客闸门的扫描范围里：它现在只靠那次演练守着，以后改 sink 代码博客侧不会红。sink 的 `SINK_TOKEN` 走 Worker secret（不在 `wrangler.jsonc` 里落明文）；2026-11-25 曾在对话消息里泄露过一次，已生成新 token、重部署 sink、用新地址覆盖 blog 侧 secret，旧 token 实测回 93000 失效。**token 值不写进任何文档或消息。**

## 观测基线
- **CF Analytics**：Dashboard → 设 cached/uncached 的 TTFB P50/P95 与 Web Vitals（LCP/CLS/INP）。
  token 只有 `zone:read`，读不了 Zone Settings API，需在 Dashboard 看。
- **站内事件**：`/admin/stats` 看 read / img-error / search 近 7 天分布。
  数据进 D1 `events` 表；`umamiOn(env)` 为真时不写库（避免两边数字打架）。
- **开关核实**（token 权限不足，从实际响应验证更可靠）：
  - Brotli → 响应头 `Content-Encoding: br`
  - 缓存规则 → `CF-Cache-Status` / `Cache-Control`
  - Early Hints → CDP 抓 `Network.responseReceivedEarlyHints`（缓存命中时不发 103，用 `?cb=` 绕）

## 应急只读开关（READONLY_MODE）

出事时先把写接口关掉，比翻代码快，也比后台开关可靠（后台开关本身要写库）。

```bash
# 开：所有 /api/* 的写方法立即 503，静态页与文章照常读
npx wrangler secret put READONLY_MODE      # 输入 1
# 关：删掉这个变量（不是设成 0，删干净更省心）
npx wrangler secret delete READONLY_MODE
```

- 只挡 `POST/PUT/PATCH/DELETE`；`GET/HEAD/OPTIONS` 放行，所以站点看起来还是活的。
- 响应带 `retry-after: 600` 与 `cache-control: no-store`，不会被边缘缓存住。
- 判定在鉴权之前，降级时连 `users` 那次查询都省掉。
- 取值 `1 / true / on / yes` 都认（大小写与前后空格无关）；写错值等于没开，别指望它提醒你。
- 断言：`node scripts/test-readonly.mjs`（RO-01~06，已进 `npm test`）。

## 准入白名单（ALLOWED_LOGINS / ADMIN_LOGINS）

两个都可选，**都不配 = 旧行为**（任何 GitHub 账号登录即成普通用户，首个注册者即管理员）。
公开可部署的实例应当配第一个。

```bash
# 只允许这两个账号登录/注册，其余在回调时直接拒（不建 users 行、不发 cookie）
npx wrangler secret put ALLOWED_LOGINS     # 输入: exia-blip,someoneelse

# 管理员由配置决定，不再看"谁是第一个注册的"
npx wrangler secret put ADMIN_LOGINS       # 输入: exia-blip
```

- 逗号分隔，**大小写不敏感**，前后空格自动去掉（GitHub login 本身不区分大小写）。
- `ADMIN_LOGINS` 配了就以它为准，且**每次登录同步回库** —— 撤权/授权不用等 30 天 token 到期，
  也不用改库；比换 `SESSION_SECRET`（一次性踢掉所有人）温和。
- 只配 `ALLOWED_LOGINS` 不配 `ADMIN_LOGINS`：白名单生效，管理员仍按"首个注册者"判定。
- `ADMIN_LOGINS` 里的人若不在 `ALLOWED_LOGINS` 内，**仍会被拒**（准入先于角色）。
- 拒绝发生在建行之前，名单外账号不会在 `users` 表留痕。
- 断言：`node scripts/test-auth-policy.mjs`（AP-01~15，`[P-021]`，已进 `npm test`）。
- 改完对下一次登录立即生效（`wrangler secret put` 会创建一个新版本）；已签发的 token 不受影响，
  但 `ADMIN_LOGINS` 的权限同步只发生在登录那一刻。

## 本机 .dev.vars：线上会话密钥的唯一副本

`npm run check:admin:live` 要拿线上现役 `SESSION_SECRET` 自签短效票，所以本机
`.dev.vars` 里有一行 `LIVE_SESSION_SECRET`。**CF secrets 只可写不可读** ——
`wrangler secret list` 只回名字和类型，没有值、没有长度、没有哈希（见上一节第 106 行）。
所以这份文件丢了，那把密钥就永远取不回来，只能轮换。

三条必须同时成立，缺一条就等于是「配好了」假装「安全了」：

1. **它在 `.gitignore` 里，且那行带注释说明为什么不能删。** 删掉 = 下一次 `git add -A`
   会把线上会话密钥推进 public 仓库。注释是给未来清理 gitignore 的人看的，不是给现在。
2. **离线留一份**（密码管理器）。单副本 + 平台不可读 = 本机硬盘坏了就只能轮换。
3. **轮换线上 `SESSION_SECRET` 之后，把这里那份同步删掉或覆盖。** 过期副本比没有副本危险：
   它看起来仍然有效，出事时会被当成「确认过的密钥」去排查，把方向带偏。

分流规则（`scripts/admin-autologin.mjs`）：本地 host 只认 `SESSION_SECRET`，线上 host 只认
`LIVE_SESSION_SECRET`，**互不回退**（AL-21 守着）。回退会把「配错了」伪装成「登录失败」。
`--key=dev|live` 可强制覆盖，仅调试用。

## 新评论：手动补推与清垃圾（速查）

两条命令都靠 `.dev.vars` 的 `LIVE_SESSION_SECRET` 自签短效票（见上一节），
401 只有一种含义：两版密钥不同源（AL-21 拦着，不会回退）。

| 想做的事 | 命令 | 判据 |
|---|---|---|
| 补推**最新一条**（刚发完评论就用它） | `npm run notify:resend` | 退出码 0=ok / 1=fail / 2=skip / 3=鉴权或条目不存在 |
| 补推**指定一条** | `npm run notify:resend -- --id=57` | 同上；`--id` 非正整数直接 die |
| 看清会删谁（**不发不删**） | `npm run comment:sweep` | 输出 `补推 / 垃圾 / 免检跳过` 三段，结尾自报「什么都没动」 |
| 立刻补推 + 删垃圾 | `npm run comment:sweep -- --apply` | 同上，改动落库；补推的 `notify_note` 带「补推」前缀 |
| 打本地 dev（不碰线上） | 上面任一条加 `--origin=http://127.0.0.1:8788` | 需 dev server 在跑；`--uid=<管理员 id>` 可换身份 |
| 验「待审渲染」三处联动 | `npm run comment:probe -- --apply` | 造一条 pending → 侧栏徽章 / 待办条 / 评论页三处都要 +1 → 自动删 → 再验回零；任一不符退出码 1 |

**新脚本查 D1 一律走 `scripts/lib/d1.mjs`，不要写 `execFileSync('npx', …)`**：Windows 上 npx 是 `.cmd`，
node 直接拉会报 `spawnSync npx ENOENT`；退化成 `shell: true` 则会把带空格的 SQL 拆成十几个参数，
报出来的却是 SQL 语法错。两个坑在本仓已踩过四次（`backfill-html` / `make-variants` / `gen-cards` / `setup` 各留了一段注释），
写成 **P-083** —— 这一条比「怎么调 wrangler」重要：失败时你以为要改 SQL，其实是进程根本没起来。
**存量 16 个脚本仍各自内联 wrangler**（多是 `deploy` / `secret put` / `d1 export`，`lib/d1.mjs` 没有对应封装），
属已知的第二份事实源：按各自下次动到来迁，别单开一轮 —— 每个脚本都带自己的幂等逻辑，一次迁四个等于一次改四件事。

- **两条命令筛的不是同一批**：`notify:resend` 是**点名重投**，不判断该不该补（那是你的判断），也不受补推冷却限制；
  `comment:sweep` 是**按条件筛**（6 小时内 + 距上一跳满 1 小时 + 打分 ≥ 4）并删除，与 cron 每 20 分钟跑的是同一套。
  所以「刚发完、群里没消息」→ 直接 `notify:resend`，别等 cron。
- **不手动也是自动的**：cron 每 20 分钟已经在跑这两件事。手动入口只有两个用途 —— 想立刻看结果、想看会删谁。
- **删是硬删**：`--apply` 之前先不带 `--apply` 跑一遍，看 `垃圾` 那段的分数与命中规则。
  误删过调 `SPAM_MIN_SCORE`，不要删规则（规则表在 `spam.js` 文件头，每条都注明了误杀面）。
- **`垃圾` 那行的三个数字加起来才是扫描量**：`保留 N`（打了分但不够 4）× `免检跳过 N`（管理员/有回复/已拒绝，
  为 0 时不显示）× `待删/已删 N`。三者全 0 说明**扫描范围是空的**（没有 approved/pending 评论），
  不是「一条垃圾都没有」——这两个结论长得一样，只差这一个加法。

## 运维兜底
- **D1 备份**：`node node_modules/wrangler/bin/wrangler.js d1 export blog-db --remote --output backups/d1-$(date +%Y%m%d).sql --skip-confirmation`
  （`backups/*.sql` 已 gitignore，含全文不进仓库）
- **用量**：`wrangler r2 bucket info blog-images`（当前 66 对象 / 4.34MB）、D1 约 1.15MB。
- **版本**：`package.json` version = git tag = GitHub Release，三者对齐。

## 6. 边缘层（Dashboard，不在仓库里）

Worker 里的三道防滥用（蜜罐 / Turnstile / D1 限额）全部在**计费之后**：请求进到 Worker
那一刻，CPU、D1 行读、subrequest 额度就已经开始算。WAF 挡下的请求根本不进 Worker，
这是它和应用内限流唯一的、也是最大的区别。

这一层 wrangler 管不了（`wrangler.jsonc` 里没有也不会有 WAF 规则），token 也没有
Zone 写权限，所以只能手工在 Dashboard 配。**是否已配过以面板为准，仓库里的记录只有这一节。**

建议规则（免费版 1 条速率限制、计数窗口固定 10 秒，字段与界面以面板当前版本为准）：

| 项 | 值 | 理由 |
|---|---|---|
| 匹配 | `http.request.uri.path in {"/api/comments" "/api/pv" "/api/ev"}` | 只护匿名写入口，静态页与后台不掺和 |
| 计数 | 同一 IP，10 秒内 > 20 次 | 正常读者不可能达到；脚本一轮就超 |
| 动作 | 先 `Log`，观察 3–7 天再切 `Block` | 手机网络出口共用 IP，直接拦会误伤 |
| 响应 | 默认 429 / 托管质询 | 429 比 challenge 便宜，先试 429 |

先记录再拦截的顺序不能反：WAF 拦的是「IP 维度」，而 CGNAT 后面可能坐着整个小区。

## 7. 被入侵之后的存量清理（预案，非代码）

存储型 XSS 的前提是「库里已经有脏数据」，这时候改代码不会让存量变干净。

1. **先截断入口**：把上面那条 WAF 规则切 `Block`；关评论（`/admin` 的评论开关）或
   临时把 `TURNSTILE_SECRET` 置空不如直接拦。
2. **找注入源**：`SELECT id, slug, updated_at FROM posts WHERE content LIKE '%<script%'
   OR content LIKE '%onerror=%' OR content LIKE '%javascript:%'`；`comments` 表同样扫
   `content`。`audit_log` 里按时间倒着看谁改过。
3. **备份再清**：先 `d1 export`，再逐条 `UPDATE`——不要直接 `DELETE`，要留证。
   清完跑 `npm run backfill:html -- --all` 让 `html_content` 与正文重新对齐。
4. **重置会话**：换 `SESSION_SECRET`（`wrangler secret put`）。本站会话是
   `signToken(SESSION_SECRET, …)` 签的，换密钥等于一次性吊销所有 30 天 cookie；
   被改过密码的场景还要核 GitHub OAuth 侧的授权。
5. **补断言**：这次漏进去的那条形状，加进 `public/md.js` 的 27 条探针或
   `PITFALLS.md`，否则同一个形状会以另一种写法回来。

