-- 由 scripts/seed-57.mjs 生成，勿手改
-- 临时加发：published_at 钉在首次上线时刻 2026-11-25 15:46:12（UTC），重放幂等；hidden=0
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('success-but-not-through', '接口说成功，业务其实没通：三种静默失败和一条停手线', '# 接口说成功，业务其实没通：三种静默失败和一条停手线

## 结论

一次命令打印 Success 并且 `exit 0`，可能什么都没写进去。一个 HTTP 200，可能业务码是 `93000`。一页能正常弹出验证码、CSP 也放行了源，可能服务端正在拒收每一条评论。三件事表面无关，形态是同一个：**传输层的成功掩盖了业务层的失败**。判断方法也只有一条：别信状态码，验业务码；写入之后回打一次；「配了」不等于「配对了」。

这篇里所有数字都来自 2026-11-24 / 11-25 两天的注入记录和线上打点，不是推演。旧 token 打自建 sink 回 `93000`，新 token 回 `0`；扫描器被注入丢掉 31 条规则时，两个消费者 TC-42 / TC-44 继续绿，只有独立计数 TC-46 红了，报 `1088` 对 `1119`；把空值闸门去掉再传空串，假 wrangler 静默通过，体检还报告「WEBHOOK_URL 已配」。三条都能用命令复现。

第二类错误是把会变的量当常量写进代码。清单会被后来的人再去重一次，共用的扫描器会被加一行过滤，`vars` 块末尾那一项会换人——三处都让判据守着自己输入的那一份，而真实数据已经变了。修法不是把断言写得更长，是给它一个和被测步骤无关的独立计数。

第三类是停手条件。断言链不是越长越好。最外一层被改坏输入时会先红，就可以停在 review；如果继续绿，就必须再往下加一层。这条元准则本身不写断言，否则要再写一条守它的断言，无限递归。`P-069` / `P-075` / `P-076` 在对账里是 WARN，这是预期，不是待消除的红灯。

这篇不写发版流水账。全绿的项数、资源版本、Worker ID 都是工作日志，不是文章。这里只留两件事：为什么这么判断，以及怎么验证。

还有半步没验：评论落库到触发通知目前仍是读码结论，得有人真点一次验证码。观察脚本已经写好，但自动化拿不到 managed token；我不会把「脚本就绪」写成「端到端通过」。

## 一、三种「成功」，三个不同的失败

先把三件事摆在一起，看它们共同缺的是什么：

| 场景 | 表面信号 | 真正要验的东西 | 实测到的失败 |
|---|---|---|---|
| 写 Worker secret | `Success`、`exit 0` | 值真的到了 Worker 绑定 | 非 TTY 下空 stdin 上传空值，体检只看名字仍报「已配」 |
| 发企微通知 | `HTTP 200` | 业务码为 0 | 旧 token 回 `{"errcode":93000}`，新 token 回 `0` |
| 配人机验证 | 页面 200、sitekey 下发、CSP 放行 | 服务端 siteverify 通过 | 无 token 回 400「请先完成人机验证」，假 token 回 400「人机验证没通过，刷新页面再试一次」 |

三个失败都不让任何原有测试变红。原因也一样：每一层都只回答了自己那层的问题。命令退 0 只说明 wrangler 收了参数；HTTP 200 只说明对面收到了请求；页面能弹框只说明前端拿到了 sitekey。业务层的一句话，得由业务层的判据来答。

判断的次序也因此是固定的：先问「这句话由谁来说」，再问「我手上这个信号是谁给的」。两者不是同一个主体，就不能拿后者替代前者。空 stdin 那次我差点犯的错，就是把「wrangler 说成功」读成「Worker 拿到了值」；企微那次是把「对面收到请求」读成「对面接受了这个 token」；Turnstile 那次是把「浏览器渲出了组件」读成「服务端会放行提交」。三层读错的方向一致：把上游的确认当成了下游的事实。

**空 stdin 那次**：`wrangler secret put` 在不是 TTY 的环境里会从 stdin 读值，读到空串也照样上传、照样打印成功（workers-sdk#16193）。`preflight` 又只列 secret 名字，空串也算「已配」。于是三道闸门全绿，通知静默丢失。

修法是把闸门放在调用 wrangler **之前**：

```js
if (!value || !String(value).trim())
  die(`putSecret：${name} 值为空，拒绝写入（wrangler 空 stdin 会静默成功）`);
```

位置不能挪。写入后回打用的是本地 `url` 变量，空值写进去时它照样回 `errcode 0`；CF secrets 只可写不可读，`secret list` 不给值也不给长度，写完没有第二次机会。注入时把闸门删掉再传空值，假 wrangler 静默通过、体检报「已配」；装回闸门，die 且不进体检。我没有在生产上用 `printf '''' | wrangler secret put WEBHOOK_URL` 复现——那会真的清空现役 secret 并触发部署，用假 wrangler 跑同一个形状就够了。

**HTTP 200 那次**：企微地址失效时回的是 200 加业务码 `93000`，只看状态码全是成功。token 轮换那次实测到旧地址回 `93000`、新地址回 `0`，两个数都记在 DEPLOY 的边界表里。回打函数因此把四种平台的字段都归一到同一条判据：

```js
const code = Number(data.errcode ?? data.code ?? data.StatusCode ?? 0);
if (!r.ok || code !== 0) die(`${label}失败：HTTP ${r.status} 业务码 ${code}`);
```

`setup:webhook` 在 `putSecret` 前后各走一次同一个 `smokeWebhook`：写入前自检是为了在地址写错时不先覆盖现役 secret，写入后回打是为了确认写进去的值没被改坏、token 没被轮换掉。`--dry` 跳过时必须打印原因，`--no-smoke` 是显式的救急开关，两者都不留静默。

回打发的不是 `{ text: ''test'' }`，而是复用业务通知同一个 `webhookPayload` 构造出的四平台形状。另写一个简化包等于白验：sink 侧哪天加了长度或编码校验，演练全过、真发 400，两种包型的差异正好落在没人看的地方。企微要 `msgtype: text` 加 `text.content`，飞书要 `msg_type` 加 `content.text`，Discord 用 `content`，Slack 与通用用 `text`——这段适配只有一份，脚本和业务共用，改一处不会只改到其中一边。

失败后不自动回滚 secret。回打失败有两种成因：地址本身写错，或者 sink 此刻抖动。回滚会把这两件事混成一个动作，反而把可用的旧值也弄坏。注入验证做了三条：把平台码判据改成 `false`、把调用点注释掉、删掉 `--dry` 的跳过打印——三条都先红，再还原。

**半配 Turnstile 那次**：前端拿到 sitekey 就渲染组件，CSP 也放行了 `challenges.cloudflare.com`，页面看起来完全正常；只有提交时服务端验不过，用户看到的是「评论一直提交失败」。配置过程里连续踩了四处：已有 OAuth token 缺 `challenge-widgets.write` scope，读 widget 回 403；设备码授权页点了但 token 端点持续 `authorization_pending`，页面显示已授权其实没走完；真 sitekey 含连字符，旧正则只收 base62，把真值判成「形状不对」；vars 插入写死 `R2_PUBLIC_BASE` 当锚点，Turnstile 键插到它后面之后，再插 UMAMI 两键就丢了逗号，整份 JSON 非法。

线上只读预检的结果是：评论页 200、`data-ssr="1"`、表单和 textarea 都在；sitekey 下发、CSP 带 nonce 且放行该域；评论接口 200、`total` 为 0。带无效 token 打两发，服务端分别回 400 的两句原文，复核 `total` 仍是 0。**这三样只能证明服务和拒收路径都活着，不能证明真验证码能通过**；真过验证那一步得有人点。

四处配置失败也各有自己的「成功信号」，值得并排看：

| 配置动作 | 当时以为的成功 | 实际缺的东西 | 真正的判据 |
|---|---|---|---|
| 读 widget | 已有 OAuth token | 少了 `challenge-widgets.write` scope；同一 token 读 worker scripts 是 200 | `whoami` 里出现该 scope，或 token 端点返回 200 |
| 设备码授权 | 浏览器显示了授权页 | 页面点了不等于流程走完，token 端点持续 `authorization_pending` | token 端点真的回 200 |
| 写 sitekey | 形状检查通过 | 真值含 `-`，旧正则只收 base62 | 先放行 `-` / `_`，让请求走到 siteverify 再报 secret 无效 |
| 插 vars | `--dry` 输出了 JSON | `R2_PUBLIC_BASE` 不再是末尾键，UMAMI 两键丢了逗号 | JSON 合法 + 不落盘，两条一起验 |

这四行说明一件事：**每个工具都有它自己的「成功」，而那句话的适用范围比我们以为的窄。** 页面显示已授权，是浏览器的成功；token 端点回 200，才是授权的成功。把前一个读成后一个，配置就停在半途，而所有日志都写着正常。

## 二、把会变的量当常量写进代码

三个案例的现场完全不同，错法相同。

**清单会被再去重一次。** TC-43 遍历 `CLASS_SOURCES_RAW` 判重复，前提是这份原文未去重。有人觉得两个变量名多余，把它改成 `const CLASS_SOURCES_RAW = [...new Set([...])]`，TC-43 立刻回到恒真，而且继续 pass。TC-45 本来是守这一步的元断言，但它用 `self.indexOf(''const CLASS_SOURCES = '')` 定位定义，搜索域包含字面量自己的书写处：把 `const` 改成 `let`，它命中的是 TC-43 注释里那句散文，切出 345 字符，恰好跨过一个 `new Set(`，于是 45 通过 0 失败；把 RAW 定义拆成两行，它命中的是 TC-45 自己那行代码，切出 429 字符，报出「RAW 里出现了 new Set」——红了，但理由和事实无关。长度锚点只证明切到了东西，不证明切到了对的东西。

修法是行首锚定加唯一计数：

```js
const at = (re, label) => { const all = [...self.matchAll(re)];
  assert.equal(all.length, 1, `「const ${label}」在行首出现 ${all.length} 次（应为 1）`);
  return all[0].index; };
at(/^const CLASS_SOURCES_RAW\s*=\s*\[/gm, ''CLASS_SOURCES_RAW'');
at(/^const CLASS_SOURCES\s*=/gm, ''CLASS_SOURCES'');
```

行首锚定排掉缩进里的散文和引号里的字面量，计数排掉顶格写进块注释的伪定义。`const` 改成 `let` 之后旧版继续绿，新版报「出现 0 次」；先红再还原，这条才算立住。

**共用扫描器会被加一行过滤。** TC-42 和 TC-44 共用 `scanCssRules`，各自都有锚点，但都是规模或数值锚点：一个判规则数大于 800，一个判 `--muted` 的消费点数等于登记值。在 `rules.push` 前加 `if (body.length < 16) continue;`，扫描器丢掉 31 条短规则，只剩 1088 条；TC-42 仍绿（1088 > 800），TC-44 也绿（`--muted` 恰好一条没落在这 31 条里，153 仍是 153）。两个消费者都没有理由报红，而样式表已经少算了 2.8%。

TC-46 的判据不来自扫描器：它数源文本里的 `{` 总数，减去 at-rule 自己的 `{`，应当正好等于扫描器输出的规则数，实测 `1178 - 59 = 1119`。这里要两个锚点：`openAll > 500`、`atOpen > 10`，否则两个 0 相减也会恒等。注入之后只有 TC-46 红，报「扫描器产出 1088 条，源文本独立计数 1178 - 59 = 1119 条」。**判据不能挂在自己要检验的那步转换的产物上**——这是这一类错误的统一形状。

**vars 块的「末尾一项」也会换人。** `appendVarLines` 第一版写死插在 `R2_PUBLIC_BASE` 后面，因为当时它在末尾。加了 Turnstile 之后再插 UMAMI，两个键丢了逗号，配置变成非法 JSON。修法是在 vars 块里找末尾一个真实键作为锚点，插在它后面；`--dry` 用例同时守「不落盘」和 JSON 合法性。形状正则也犯过同类错：真 sitekey 带 `-`，旧正则只收 base62，把真值挡在门外；改成放行 `-` 和 `_` 之后，占位符拦截仍在更前面，不会跟着松。

三件事的共同点：**它们把某一刻成立的形态当成了常量**。清单此刻未去重、扫描器此刻不过滤、`R2_PUBLIC_BASE` 此刻在末尾。形态一变，守着形态的断言要么恒绿，要么红得没道理。能跨过变化的只有独立计数和锚定到定义本身的定位。

同一类错误还有第三个现场，虽然不在这三处：`TOK_EXCEPTION` 登记了「注释色借用 `--muted`」，四方对账守住了来源合规，但没人问过这个来源还被谁用着。实测 `public/style.css` 里 `var(--muted)` 出现 153 次、分布在 158 个选择器上。有人嫌辅助文字太淡去调这个值，注释色跟着变，四道闸全绿。TC-44 因此登记的是**数字**而不是名单——名单会让每写一行业务 CSS 都要改契约文件，长到没人读时就退化成噪声。数字是算出来的，往清单里塞名字换不来放行。它和前两件是同一个判断：**登记「值从哪来」不等于登记「值被谁依赖」**，把一时的依赖面当成常量，就等于没有这一层。

三种现场的共同形状可以缩成一句话：**判据守住的是它自己输入的那一种形态**。输入被提前转换、被共享、被移位，判据都不会跟着变。写断言时问一句「如果被测的那一步本身被改坏，这条断言还有没有理由红」，比事后加十行判据有用。

假绿常见三种形态，这里各有一个现场：

| 形态 | 现场 | 为什么绿 |
|---|---|---|
| 空集恒真 | TC-44 的属性正则把 `.btn:hover` 的 `:hover` 当成属性名 | 总数对得上，分类全是噪声；判据只比数字不比构成 |
| 判据等价于更弱的东西 | TC-42 判规则数大于 800，丢 31 条仍是 1088 | 「大于 800」回答的是「有没有解析出一堆东西」，不是「解析对不对」 |
| 判据的输入是它要检验那步的产物 | TC-43 遍历去重后的清单判重复 | 去重发生在断言之前，重复自然为零 |

第三种最隐蔽，因为代码看起来完全合理：清单是干净的，断言也是严格的，错在两者之间那一步。识别它只看一件事——**判据的输入来自被测步骤之前还是之后**。来自之前还能守，来自之后就是自己给自己盖章。

四次注入的做法都一样：备份被测文件，改坏它，跑单条断言看着它红，还原，再跑一遍全绿。TC-45 那次改的是 `const` 一个词；TC-46 那次加的是一行 `continue`；setup 那三次分别是改判据、注释调用点、删打印。没有哪次需要改业务代码。断言值不值得留，就看这一分钟：改坏输入都不红，它以后也不会红。

## 三、停手条件：先红才加断言，静默绿就停

断言链现在有五层，每一层都曾经静默退化过一次：

| 层 | 注入 | 旧版表现 | 加层后的表现 |
|---|---|---|---|
| TC-43 | 原文被提前去重 | pass，恒真 | TC-45 报「RAW 里出现了 new Set」 |
| TC-45 | `const` 改成 `let` | 45 通过 0 失败 | 行首锚定 + 唯一计数，报「出现 0 次」 |
| TC-42 / TC-44 | 扫描器丢 31 条 | 两条都 pass | TC-46 报 1088 对 1119 |

共同症状不是「测试红了查不出原因」，而是「测试全绿，事实已经错了」。每加一层，都是因为下一层用与被测步骤无关的独立计数，把上一次静默绿变成了可见的红。

停手条件因此不是「断言越多越好」，而是一条可机械判定的规则：**对最外一层做一次注入，把它的输入改坏；它先红，就可以停在 review；它继续绿，就必须再往下加一层。** 停在 review 不等于免检——改了判据输入形态的 PR 仍要人工把落点指回来。

这条准则本身不写断言。它是关于「什么时候停止自动化」的元判据，写成断言就得再写一条守它的断言，如此递归没有终点。同理，`P-069` 明确不写阈值断言：动态类在 SSR 里的可见率是 3/39，把「该不该在 SSR 里」这种设计意图编码成阈值，等于把一个拍出来的数字钉成规范；数字记在文档里比钉在一条永远绿的断言上更有用。`P-075` 和 `P-076` 同理，一个记停手条件，一个记外部真值配置的九处同构。对账里这三条是 WARN，是刻意保留的「已知未自动化」，不是待修的红灯。

人工那一跳也挂在这条规则上。Turnstile managed 在自动化浏览器里拿不到 token，自动化到红就停，不写自动提交冒充端到端。`verify-comment-e2e` 改成生成唯一 nonce，让真人填进评论，之后从两个独立源看同一个标记：公开评论接口证明落库，自建 sink 的 inbox 证明通知触发。通知侧判据是「nonce 且带新评论字样」两个条件，只查 nonce 会把冒烟消息读成通知成功；落库侧要递归 replies，只看顶层会漏掉回复里的标记。判据自检 6 条进了 `npm test`，纯函数喂固定输入，改坏判据会红；人工点击不进测试——把自动提交塞进测试才是假绿。

两件事能自动，一件不能，边界就画在这里：判据自检是纯函数喂固定输入，属于「改坏它会红」，可以进 `npm test`；真人点验证码是链路本身，自动化到红只能停。把后者塞进测试，不会让它变真，只会让测试多一条永远绿的摆设。脚本就绪也不改变结论——要有人真点一次、真提交一条、两个源都命中，DEPLOY 里那两行才从「未验」改成「已验」。

这条规则和前两节是同一件事的三种长相。第一节里，wrangler 的成功不是 Worker 的成功；第二节里，断言的绿不是事实的绿；这一节里，自动化的红不是链路的红。三处都在提醒：**先问这句话是谁说的，再说它能证明什么。**

## 四、明说的没做

- **评论落库到触发通知仍是读码结论**。调用点在提交分支，但没有真提交触发过。冒烟验的是写入与传输，不覆盖「有评论提交时会不会发」。要有人真点一次验证码、真提交一条评论，脚本两边都命中才算过。
- **CF 线上实际存储的值读不回**。`secret list` 只给名字，本地断言用的是假 wrangler 捕获的 name/value，不是线上读回的值。这层边界写进 DEPLOY，不冒充已验。
- **没在生产用空 stdin 复现**。那会清空现役 secret 并触发部署，用假 wrangler 复现同一形状。
- **失败不回滚 secret**，理由见第一节；`--no-smoke` 只给已知 sink 暂不可达的救急场景。
- **没写第 47 条断言**，也不打算为元准则写断言。三条 WARN 保持 WARN。
- **sink 不在博客闸门扫描范围**。它是独立 Worker，改 sink 代码博客侧不会红，目前只靠真发真收那次演练守着。
- **没测真验证码的通过路径**。线上只打了无 token 和假 token 两条拒收路径，真过一次仍待人点。

## 复现条件

- 环境：Node 22+；本地断言不需要网络，`test-setup.mjs` 里需要网络的那条会显式说明跳过的部分。
- 命令：`node scripts/test-setup.mjs`、`node scripts/test-theme-contract.mjs`、`node scripts/verify-comment-e2e.mjs --check`。
- 线上只读预检：打开任意文章页看 `data-ssr`、sitekey 和 CSP；`GET /api/comments?slug=<slug>` 看 `total`；带无效 token 打 `POST /api/comments`，复核 `total` 没变。
- 线上域名：`https://miu.sryze.cc`。

## 怎么自己验一遍

按下面三张表做，每张都能单独判定，不必依赖上一篇的结论。

| 要验的事 | 命令 / 动作 | 期望 |
|---|---|---|
| 空值闸门 | `node scripts/test-setup.mjs` | 11/11 passed；删掉 `putSecret` 的空值检查再传空串会红 |
| 平台码判据 | 同上 | 把 `code !== 0` 改成 `false` 会红；注释掉回打调用会红；删掉 `--dry` 打印会红 |
| 清单去重 | `node scripts/test-theme-contract.mjs` | TC-43 / TC-45 绿；把原文提前 `new Set` 后 TC-45 红 |
| 扫描器独立计数 | 同上 | TC-46 绿；在 `rules.push` 前加 `if (body.length < 16) continue;` 后 TC-46 报 1088 对 1119 |
| 人工端到端 | `npm run verify:comment-e2e -- <slug>`（本机先设 `SINK_URL`） | 真点验证码、提交带 nonce 的评论；两个源都命中才算过 |

注入验证的做法统一：先备份被测文件，改坏它，看着断言红，再还原并复跑全绿。「看着它红」这一步不能省——没验证过会失败的断言，等于没写。
', '<h1 id="接口说成功-业务其实没通-三种静默失败和一条停手线"><a class="h-anchor" href="#接口说成功-业务其实没通-三种静默失败和一条停手线">#</a>接口说成功，业务其实没通：三种静默失败和一条停手线</h1>
<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>一次命令打印 Success 并且 <code>exit 0</code>，可能什么都没写进去。一个 HTTP 200，可能业务码是 <code>93000</code>。一页能正常弹出验证码、CSP 也放行了源，可能服务端正在拒收每一条评论。三件事表面无关，形态是同一个：<strong>传输层的成功掩盖了业务层的失败</strong>。判断方法也只有一条：别信状态码，验业务码；写入之后回打一次；「配了」不等于「配对了」。</p>
<p>这篇里所有数字都来自 2026-11-24 / 11-25 两天的注入记录和线上打点，不是推演。旧 token 打自建 sink 回 <code>93000</code>，新 token 回 <code>0</code>；扫描器被注入丢掉 31 条规则时，两个消费者 TC-42 / TC-44 继续绿，只有独立计数 TC-46 红了，报 <code>1088</code> 对 <code>1119</code>；把空值闸门去掉再传空串，假 wrangler 静默通过，体检还报告「WEBHOOK_URL 已配」。三条都能用命令复现。</p>
<p>第二类错误是把会变的量当常量写进代码。清单会被后来的人再去重一次，共用的扫描器会被加一行过滤，<code>vars</code> 块末尾那一项会换人——三处都让判据守着自己输入的那一份，而真实数据已经变了。修法不是把断言写得更长，是给它一个和被测步骤无关的独立计数。</p>
<p>第三类是停手条件。断言链不是越长越好。最外一层被改坏输入时会先红，就可以停在 review；如果继续绿，就必须再往下加一层。这条元准则本身不写断言，否则要再写一条守它的断言，无限递归。<code>P-069</code> / <code>P-075</code> / <code>P-076</code> 在对账里是 WARN，这是预期，不是待消除的红灯。</p>
<p>这篇不写发版流水账。全绿的项数、资源版本、Worker ID 都是工作日志，不是文章。这里只留两件事：为什么这么判断，以及怎么验证。</p>
<p>还有半步没验：评论落库到触发通知目前仍是读码结论，得有人真点一次验证码。观察脚本已经写好，但自动化拿不到 managed token；我不会把「脚本就绪」写成「端到端通过」。</p>
<h2 id="一-三种-成功-三个不同的失败"><a class="h-anchor" href="#一-三种-成功-三个不同的失败">#</a>一、三种「成功」，三个不同的失败</h2>
<p>先把三件事摆在一起，看它们共同缺的是什么：</p>
<div class="table-wrap"><table><thead><tr><th>场景</th><th>表面信号</th><th>真正要验的东西</th><th>实测到的失败</th></tr></thead><tbody><tr><td>写 Worker secret</td><td><code>Success</code>、<code>exit 0</code></td><td>值真的到了 Worker 绑定</td><td>非 TTY 下空 stdin 上传空值，体检只看名字仍报「已配」</td></tr><tr><td>发企微通知</td><td><code>HTTP 200</code></td><td>业务码为 0</td><td>旧 token 回 <code>{&quot;errcode&quot;:93000}</code>，新 token 回 <code>0</code></td></tr><tr><td>配人机验证</td><td>页面 200、sitekey 下发、CSP 放行</td><td>服务端 siteverify 通过</td><td>无 token 回 400「请先完成人机验证」，假 token 回 400「人机验证没通过，刷新页面再试一次」</td></tr></tbody></table></div>
<p>三个失败都不让任何原有测试变红。原因也一样：每一层都只回答了自己那层的问题。命令退 0 只说明 wrangler 收了参数；HTTP 200 只说明对面收到了请求；页面能弹框只说明前端拿到了 sitekey。业务层的一句话，得由业务层的判据来答。</p>
<p>判断的次序也因此是固定的：先问「这句话由谁来说」，再问「我手上这个信号是谁给的」。两者不是同一个主体，就不能拿后者替代前者。空 stdin 那次我差点犯的错，就是把「wrangler 说成功」读成「Worker 拿到了值」；企微那次是把「对面收到请求」读成「对面接受了这个 token」；Turnstile 那次是把「浏览器渲出了组件」读成「服务端会放行提交」。三层读错的方向一致：把上游的确认当成了下游的事实。</p>
<p><strong>空 stdin 那次</strong>：<code>wrangler secret put</code> 在不是 TTY 的环境里会从 stdin 读值，读到空串也照样上传、照样打印成功（workers-sdk#16193）。<code>preflight</code> 又只列 secret 名字，空串也算「已配」。于是三道闸门全绿，通知静默丢失。</p>
<p>修法是把闸门放在调用 wrangler <strong>之前</strong>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (!value || !<span class="tok-f">String</span>(value).<span class="tok-f">trim</span>())
  <span class="tok-f">die</span>(<span class="tok-s">`putSecret：${name} 值为空，拒绝写入（wrangler 空 stdin 会静默成功）`</span>);</code></pre></div>
<p>位置不能挪。写入后回打用的是本地 <code>url</code> 变量，空值写进去时它照样回 <code>errcode 0</code>；CF secrets 只可写不可读，<code>secret list</code> 不给值也不给长度，写完没有第二次机会。注入时把闸门删掉再传空值，假 wrangler 静默通过、体检报「已配」；装回闸门，die 且不进体检。我没有在生产上用 <code>printf &#39;&#39; | wrangler secret put WEBHOOK_URL</code> 复现——那会真的清空现役 secret 并触发部署，用假 wrangler 跑同一个形状就够了。</p>
<p><strong>HTTP 200 那次</strong>：企微地址失效时回的是 200 加业务码 <code>93000</code>，只看状态码全是成功。token 轮换那次实测到旧地址回 <code>93000</code>、新地址回 <code>0</code>，两个数都记在 DEPLOY 的边界表里。回打函数因此把四种平台的字段都归一到同一条判据：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> code = <span class="tok-f">Number</span>(data.errcode ?? data.code ?? data.StatusCode ?? <span class="tok-n">0</span>);
<span class="tok-k">if</span> (!r.ok || code !== <span class="tok-n">0</span>) <span class="tok-f">die</span>(<span class="tok-s">`${label}失败：HTTP ${r.status} 业务码 ${code}`</span>);</code></pre></div>
<p><code>setup:webhook</code> 在 <code>putSecret</code> 前后各走一次同一个 <code>smokeWebhook</code>：写入前自检是为了在地址写错时不先覆盖现役 secret，写入后回打是为了确认写进去的值没被改坏、token 没被轮换掉。<code>--dry</code> 跳过时必须打印原因，<code>--no-smoke</code> 是显式的救急开关，两者都不留静默。</p>
<p>回打发的不是 <code>{ text: &#39;test&#39; }</code>，而是复用业务通知同一个 <code>webhookPayload</code> 构造出的四平台形状。另写一个简化包等于白验：sink 侧哪天加了长度或编码校验，演练全过、真发 400，两种包型的差异正好落在没人看的地方。企微要 <code>msgtype: text</code> 加 <code>text.content</code>，飞书要 <code>msg_type</code> 加 <code>content.text</code>，Discord 用 <code>content</code>，Slack 与通用用 <code>text</code>——这段适配只有一份，脚本和业务共用，改一处不会只改到其中一边。</p>
<p>失败后不自动回滚 secret。回打失败有两种成因：地址本身写错，或者 sink 此刻抖动。回滚会把这两件事混成一个动作，反而把可用的旧值也弄坏。注入验证做了三条：把平台码判据改成 <code>false</code>、把调用点注释掉、删掉 <code>--dry</code> 的跳过打印——三条都先红，再还原。</p>
<p><strong>半配 Turnstile 那次</strong>：前端拿到 sitekey 就渲染组件，CSP 也放行了 <code>challenges.cloudflare.com</code>，页面看起来完全正常；只有提交时服务端验不过，用户看到的是「评论一直提交失败」。配置过程里连续踩了四处：已有 OAuth token 缺 <code>challenge-widgets.write</code> scope，读 widget 回 403；设备码授权页点了但 token 端点持续 <code>authorization_pending</code>，页面显示已授权其实没走完；真 sitekey 含连字符，旧正则只收 base62，把真值判成「形状不对」；vars 插入写死 <code>R2_PUBLIC_BASE</code> 当锚点，Turnstile 键插到它后面之后，再插 UMAMI 两键就丢了逗号，整份 JSON 非法。</p>
<p>线上只读预检的结果是：评论页 200、<code>data-ssr=&quot;1&quot;</code>、表单和 textarea 都在；sitekey 下发、CSP 带 nonce 且放行该域；评论接口 200、<code>total</code> 为 0。带无效 token 打两发，服务端分别回 400 的两句原文，复核 <code>total</code> 仍是 0。<strong>这三样只能证明服务和拒收路径都活着，不能证明真验证码能通过</strong>；真过验证那一步得有人点。</p>
<p>四处配置失败也各有自己的「成功信号」，值得并排看：</p>
<div class="table-wrap"><table><thead><tr><th>配置动作</th><th>当时以为的成功</th><th>实际缺的东西</th><th>真正的判据</th></tr></thead><tbody><tr><td>读 widget</td><td>已有 OAuth token</td><td>少了 <code>challenge-widgets.write</code> scope；同一 token 读 worker scripts 是 200</td><td><code>whoami</code> 里出现该 scope，或 token 端点返回 200</td></tr><tr><td>设备码授权</td><td>浏览器显示了授权页</td><td>页面点了不等于流程走完，token 端点持续 <code>authorization_pending</code></td><td>token 端点真的回 200</td></tr><tr><td>写 sitekey</td><td>形状检查通过</td><td>真值含 <code>-</code>，旧正则只收 base62</td><td>先放行 <code>-</code> / <code>_</code>，让请求走到 siteverify 再报 secret 无效</td></tr><tr><td>插 vars</td><td><code>--dry</code> 输出了 JSON</td><td><code>R2_PUBLIC_BASE</code> 不再是末尾键，UMAMI 两键丢了逗号</td><td>JSON 合法 + 不落盘，两条一起验</td></tr></tbody></table></div>
<p>这四行说明一件事：<strong>每个工具都有它自己的「成功」，而那句话的适用范围比我们以为的窄。</strong> 页面显示已授权，是浏览器的成功；token 端点回 200，才是授权的成功。把前一个读成后一个，配置就停在半途，而所有日志都写着正常。</p>
<h2 id="二-把会变的量当常量写进代码"><a class="h-anchor" href="#二-把会变的量当常量写进代码">#</a>二、把会变的量当常量写进代码</h2>
<p>三个案例的现场完全不同，错法相同。</p>
<p><strong>清单会被再去重一次。</strong> TC-43 遍历 <code>CLASS_SOURCES_RAW</code> 判重复，前提是这份原文未去重。有人觉得两个变量名多余，把它改成 <code>const CLASS_SOURCES_RAW = [...new Set([...])]</code>，TC-43 立刻回到恒真，而且继续 pass。TC-45 本来是守这一步的元断言，但它用 <code>self.indexOf(&#39;const CLASS_SOURCES = &#39;)</code> 定位定义，搜索域包含字面量自己的书写处：把 <code>const</code> 改成 <code>let</code>，它命中的是 TC-43 注释里那句散文，切出 345 字符，恰好跨过一个 <code>new Set(</code>，于是 45 通过 0 失败；把 RAW 定义拆成两行，它命中的是 TC-45 自己那行代码，切出 429 字符，报出「RAW 里出现了 new Set」——红了，但理由和事实无关。长度锚点只证明切到了东西，不证明切到了对的东西。</p>
<p>修法是行首锚定加唯一计数：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> at = (re, label) =&gt; { <span class="tok-k">const</span> all = [...self.<span class="tok-f">matchAll</span>(re)];
  assert.<span class="tok-f">equal</span>(all.length, <span class="tok-n">1</span>, <span class="tok-s">`「const ${label}」在行首出现 ${all.length} 次（应为 1）`</span>);
  <span class="tok-k">return</span> all[<span class="tok-n">0</span>].index; };
<span class="tok-f">at</span>(/^<span class="tok-k">const</span> CLASS_SOURCES_RAW\s*=\s*\[/gm, <span class="tok-s">&#39;CLASS_SOURCES_RAW&#39;</span>);
<span class="tok-f">at</span>(/^<span class="tok-k">const</span> CLASS_SOURCES\s*=/gm, <span class="tok-s">&#39;CLASS_SOURCES&#39;</span>);</code></pre></div>
<p>行首锚定排掉缩进里的散文和引号里的字面量，计数排掉顶格写进块注释的伪定义。<code>const</code> 改成 <code>let</code> 之后旧版继续绿，新版报「出现 0 次」；先红再还原，这条才算立住。</p>
<p><strong>共用扫描器会被加一行过滤。</strong> TC-42 和 TC-44 共用 <code>scanCssRules</code>，各自都有锚点，但都是规模或数值锚点：一个判规则数大于 800，一个判 <code>--muted</code> 的消费点数等于登记值。在 <code>rules.push</code> 前加 <code>if (body.length &lt; 16) continue;</code>，扫描器丢掉 31 条短规则，只剩 1088 条；TC-42 仍绿（1088 &gt; 800），TC-44 也绿（<code>--muted</code> 恰好一条没落在这 31 条里，153 仍是 153）。两个消费者都没有理由报红，而样式表已经少算了 2.8%。</p>
<p>TC-46 的判据不来自扫描器：它数源文本里的 <code>{</code> 总数，减去 at-rule 自己的 <code>{</code>，应当正好等于扫描器输出的规则数，实测 <code>1178 - 59 = 1119</code>。这里要两个锚点：<code>openAll &gt; 500</code>、<code>atOpen &gt; 10</code>，否则两个 0 相减也会恒等。注入之后只有 TC-46 红，报「扫描器产出 1088 条，源文本独立计数 1178 - 59 = 1119 条」。<strong>判据不能挂在自己要检验的那步转换的产物上</strong>——这是这一类错误的统一形状。</p>
<p><strong>vars 块的「末尾一项」也会换人。</strong> <code>appendVarLines</code> 第一版写死插在 <code>R2_PUBLIC_BASE</code> 后面，因为当时它在末尾。加了 Turnstile 之后再插 UMAMI，两个键丢了逗号，配置变成非法 JSON。修法是在 vars 块里找末尾一个真实键作为锚点，插在它后面；<code>--dry</code> 用例同时守「不落盘」和 JSON 合法性。形状正则也犯过同类错：真 sitekey 带 <code>-</code>，旧正则只收 base62，把真值挡在门外；改成放行 <code>-</code> 和 <code>_</code> 之后，占位符拦截仍在更前面，不会跟着松。</p>
<p>三件事的共同点：<strong>它们把某一刻成立的形态当成了常量</strong>。清单此刻未去重、扫描器此刻不过滤、<code>R2_PUBLIC_BASE</code> 此刻在末尾。形态一变，守着形态的断言要么恒绿，要么红得没道理。能跨过变化的只有独立计数和锚定到定义本身的定位。</p>
<p>同一类错误还有第三个现场，虽然不在这三处：<code>TOK_EXCEPTION</code> 登记了「注释色借用 <code>--muted</code>」，四方对账守住了来源合规，但没人问过这个来源还被谁用着。实测 <code>public/style.css</code> 里 <code>var(--muted)</code> 出现 153 次、分布在 158 个选择器上。有人嫌辅助文字太淡去调这个值，注释色跟着变，四道闸全绿。TC-44 因此登记的是<strong>数字</strong>而不是名单——名单会让每写一行业务 CSS 都要改契约文件，长到没人读时就退化成噪声。数字是算出来的，往清单里塞名字换不来放行。它和前两件是同一个判断：<strong>登记「值从哪来」不等于登记「值被谁依赖」</strong>，把一时的依赖面当成常量，就等于没有这一层。</p>
<p>三种现场的共同形状可以缩成一句话：<strong>判据守住的是它自己输入的那一种形态</strong>。输入被提前转换、被共享、被移位，判据都不会跟着变。写断言时问一句「如果被测的那一步本身被改坏，这条断言还有没有理由红」，比事后加十行判据有用。</p>
<p>假绿常见三种形态，这里各有一个现场：</p>
<div class="table-wrap"><table><thead><tr><th>形态</th><th>现场</th><th>为什么绿</th></tr></thead><tbody><tr><td>空集恒真</td><td>TC-44 的属性正则把 <code>.btn:hover</code> 的 <code>:hover</code> 当成属性名</td><td>总数对得上，分类全是噪声；判据只比数字不比构成</td></tr><tr><td>判据等价于更弱的东西</td><td>TC-42 判规则数大于 800，丢 31 条仍是 1088</td><td>「大于 800」回答的是「有没有解析出一堆东西」，不是「解析对不对」</td></tr><tr><td>判据的输入是它要检验那步的产物</td><td>TC-43 遍历去重后的清单判重复</td><td>去重发生在断言之前，重复自然为零</td></tr></tbody></table></div>
<p>第三种最隐蔽，因为代码看起来完全合理：清单是干净的，断言也是严格的，错在两者之间那一步。识别它只看一件事——<strong>判据的输入来自被测步骤之前还是之后</strong>。来自之前还能守，来自之后就是自己给自己盖章。</p>
<p>四次注入的做法都一样：备份被测文件，改坏它，跑单条断言看着它红，还原，再跑一遍全绿。TC-45 那次改的是 <code>const</code> 一个词；TC-46 那次加的是一行 <code>continue</code>；setup 那三次分别是改判据、注释调用点、删打印。没有哪次需要改业务代码。断言值不值得留，就看这一分钟：改坏输入都不红，它以后也不会红。</p>
<h2 id="三-停手条件-先红才加断言-静默绿就停"><a class="h-anchor" href="#三-停手条件-先红才加断言-静默绿就停">#</a>三、停手条件：先红才加断言，静默绿就停</h2>
<p>断言链现在有五层，每一层都曾经静默退化过一次：</p>
<div class="table-wrap"><table><thead><tr><th>层</th><th>注入</th><th>旧版表现</th><th>加层后的表现</th></tr></thead><tbody><tr><td>TC-43</td><td>原文被提前去重</td><td>pass，恒真</td><td>TC-45 报「RAW 里出现了 new Set」</td></tr><tr><td>TC-45</td><td><code>const</code> 改成 <code>let</code></td><td>45 通过 0 失败</td><td>行首锚定 + 唯一计数，报「出现 0 次」</td></tr><tr><td>TC-42 / TC-44</td><td>扫描器丢 31 条</td><td>两条都 pass</td><td>TC-46 报 1088 对 1119</td></tr></tbody></table></div>
<p>共同症状不是「测试红了查不出原因」，而是「测试全绿，事实已经错了」。每加一层，都是因为下一层用与被测步骤无关的独立计数，把上一次静默绿变成了可见的红。</p>
<p>停手条件因此不是「断言越多越好」，而是一条可机械判定的规则：<strong>对最外一层做一次注入，把它的输入改坏；它先红，就可以停在 review；它继续绿，就必须再往下加一层。</strong> 停在 review 不等于免检——改了判据输入形态的 PR 仍要人工把落点指回来。</p>
<p>这条准则本身不写断言。它是关于「什么时候停止自动化」的元判据，写成断言就得再写一条守它的断言，如此递归没有终点。同理，<code>P-069</code> 明确不写阈值断言：动态类在 SSR 里的可见率是 3/39，把「该不该在 SSR 里」这种设计意图编码成阈值，等于把一个拍出来的数字钉成规范；数字记在文档里比钉在一条永远绿的断言上更有用。<code>P-075</code> 和 <code>P-076</code> 同理，一个记停手条件，一个记外部真值配置的九处同构。对账里这三条是 WARN，是刻意保留的「已知未自动化」，不是待修的红灯。</p>
<p>人工那一跳也挂在这条规则上。Turnstile managed 在自动化浏览器里拿不到 token，自动化到红就停，不写自动提交冒充端到端。<code>verify-comment-e2e</code> 改成生成唯一 nonce，让真人填进评论，之后从两个独立源看同一个标记：公开评论接口证明落库，自建 sink 的 inbox 证明通知触发。通知侧判据是「nonce 且带新评论字样」两个条件，只查 nonce 会把冒烟消息读成通知成功；落库侧要递归 replies，只看顶层会漏掉回复里的标记。判据自检 6 条进了 <code>npm test</code>，纯函数喂固定输入，改坏判据会红；人工点击不进测试——把自动提交塞进测试才是假绿。</p>
<p>两件事能自动，一件不能，边界就画在这里：判据自检是纯函数喂固定输入，属于「改坏它会红」，可以进 <code>npm test</code>；真人点验证码是链路本身，自动化到红只能停。把后者塞进测试，不会让它变真，只会让测试多一条永远绿的摆设。脚本就绪也不改变结论——要有人真点一次、真提交一条、两个源都命中，DEPLOY 里那两行才从「未验」改成「已验」。</p>
<p>这条规则和前两节是同一件事的三种长相。第一节里，wrangler 的成功不是 Worker 的成功；第二节里，断言的绿不是事实的绿；这一节里，自动化的红不是链路的红。三处都在提醒：<strong>先问这句话是谁说的，再说它能证明什么。</strong></p>
<h2 id="四-明说的没做"><a class="h-anchor" href="#四-明说的没做">#</a>四、明说的没做</h2>
<ul><li><strong>评论落库到触发通知仍是读码结论</strong>。调用点在提交分支，但没有真提交触发过。冒烟验的是写入与传输，不覆盖「有评论提交时会不会发」。要有人真点一次验证码、真提交一条评论，脚本两边都命中才算过。</li><li><strong>CF 线上实际存储的值读不回</strong>。<code>secret list</code> 只给名字，本地断言用的是假 wrangler 捕获的 name/value，不是线上读回的值。这层边界写进 DEPLOY，不冒充已验。</li><li><strong>没在生产用空 stdin 复现</strong>。那会清空现役 secret 并触发部署，用假 wrangler 复现同一形状。</li><li><strong>失败不回滚 secret</strong>，理由见第一节；<code>--no-smoke</code> 只给已知 sink 暂不可达的救急场景。</li><li><strong>没写第 47 条断言</strong>，也不打算为元准则写断言。三条 WARN 保持 WARN。</li><li><strong>sink 不在博客闸门扫描范围</strong>。它是独立 Worker，改 sink 代码博客侧不会红，目前只靠真发真收那次演练守着。</li><li><strong>没测真验证码的通过路径</strong>。线上只打了无 token 和假 token 两条拒收路径，真过一次仍待人点。</li></ul>
<h2 id="复现条件"><a class="h-anchor" href="#复现条件">#</a>复现条件</h2>
<ul><li>环境：Node 22+；本地断言不需要网络，<code>test-setup.mjs</code> 里需要网络的那条会显式说明跳过的部分。</li><li>命令：<code>node scripts/test-setup.mjs</code>、<code>node scripts/test-theme-contract.mjs</code>、<code>node scripts/verify-comment-e2e.mjs --check</code>。</li><li>线上只读预检：打开任意文章页看 <code>data-ssr</code>、sitekey 和 CSP；<code>GET /api/comments?slug=&lt;slug&gt;</code> 看 <code>total</code>；带无效 token 打 <code>POST /api/comments</code>，复核 <code>total</code> 没变。</li><li>线上域名：<code>https://miu.sryze.cc</code>。</li></ul>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>按下面三张表做，每张都能单独判定，不必依赖上一篇的结论。</p>
<div class="table-wrap"><table><thead><tr><th>要验的事</th><th>命令 / 动作</th><th>期望</th></tr></thead><tbody><tr><td>空值闸门</td><td><code>node scripts/test-setup.mjs</code></td><td>11/11 passed；删掉 <code>putSecret</code> 的空值检查再传空串会红</td></tr><tr><td>平台码判据</td><td>同上</td><td>把 <code>code !== 0</code> 改成 <code>false</code> 会红；注释掉回打调用会红；删掉 <code>--dry</code> 打印会红</td></tr><tr><td>清单去重</td><td><code>node scripts/test-theme-contract.mjs</code></td><td>TC-43 / TC-45 绿；把原文提前 <code>new Set</code> 后 TC-45 红</td></tr><tr><td>扫描器独立计数</td><td>同上</td><td>TC-46 绿；在 <code>rules.push</code> 前加 <code>if (body.length &lt; 16) continue;</code> 后 TC-46 报 1088 对 1119</td></tr><tr><td>人工端到端</td><td><code>npm run verify:comment-e2e -- &lt;slug&gt;</code>（本机先设 <code>SINK_URL</code>）</td><td>真点验证码、提交带 nonce 的评论；两个源都命中才算过</td></tr></tbody></table></div>
<p>注入验证的做法统一：先备份被测文件，改坏它，看着断言红，再还原并复跑全绿。「看着它红」这一步不能省——没验证过会失败的断言，等于没写。</p>', '', 'log', 'wrangler 打印 Success 却写进空值、企微回 HTTP 200 加 errcode 93000、Turnstile 能弹框却拒收每一条评论：三件事形态相同——传输层的成功掩盖了业务层的失败。另记两种同构错误：把会变的量当常量写进代码（原文被再去重、扫描器少算 31 条、vars 锚点写死），以及停手条件（改坏输入先红才可停在 review，静默绿必须再加一层）。评论落库到触发通知仍是读码结论，明说没验。',
        '', 0, 0, 0, 1, '2026-11-25 15:46:12', datetime('now'), datetime('now'))
ON CONFLICT(slug) DO NOTHING;

UPDATE posts SET content = '# 接口说成功，业务其实没通：三种静默失败和一条停手线

## 结论

一次命令打印 Success 并且 `exit 0`，可能什么都没写进去。一个 HTTP 200，可能业务码是 `93000`。一页能正常弹出验证码、CSP 也放行了源，可能服务端正在拒收每一条评论。三件事表面无关，形态是同一个：**传输层的成功掩盖了业务层的失败**。判断方法也只有一条：别信状态码，验业务码；写入之后回打一次；「配了」不等于「配对了」。

这篇里所有数字都来自 2026-11-24 / 11-25 两天的注入记录和线上打点，不是推演。旧 token 打自建 sink 回 `93000`，新 token 回 `0`；扫描器被注入丢掉 31 条规则时，两个消费者 TC-42 / TC-44 继续绿，只有独立计数 TC-46 红了，报 `1088` 对 `1119`；把空值闸门去掉再传空串，假 wrangler 静默通过，体检还报告「WEBHOOK_URL 已配」。三条都能用命令复现。

第二类错误是把会变的量当常量写进代码。清单会被后来的人再去重一次，共用的扫描器会被加一行过滤，`vars` 块末尾那一项会换人——三处都让判据守着自己输入的那一份，而真实数据已经变了。修法不是把断言写得更长，是给它一个和被测步骤无关的独立计数。

第三类是停手条件。断言链不是越长越好。最外一层被改坏输入时会先红，就可以停在 review；如果继续绿，就必须再往下加一层。这条元准则本身不写断言，否则要再写一条守它的断言，无限递归。`P-069` / `P-075` / `P-076` 在对账里是 WARN，这是预期，不是待消除的红灯。

这篇不写发版流水账。全绿的项数、资源版本、Worker ID 都是工作日志，不是文章。这里只留两件事：为什么这么判断，以及怎么验证。

还有半步没验：评论落库到触发通知目前仍是读码结论，得有人真点一次验证码。观察脚本已经写好，但自动化拿不到 managed token；我不会把「脚本就绪」写成「端到端通过」。

## 一、三种「成功」，三个不同的失败

先把三件事摆在一起，看它们共同缺的是什么：

| 场景 | 表面信号 | 真正要验的东西 | 实测到的失败 |
|---|---|---|---|
| 写 Worker secret | `Success`、`exit 0` | 值真的到了 Worker 绑定 | 非 TTY 下空 stdin 上传空值，体检只看名字仍报「已配」 |
| 发企微通知 | `HTTP 200` | 业务码为 0 | 旧 token 回 `{"errcode":93000}`，新 token 回 `0` |
| 配人机验证 | 页面 200、sitekey 下发、CSP 放行 | 服务端 siteverify 通过 | 无 token 回 400「请先完成人机验证」，假 token 回 400「人机验证没通过，刷新页面再试一次」 |

三个失败都不让任何原有测试变红。原因也一样：每一层都只回答了自己那层的问题。命令退 0 只说明 wrangler 收了参数；HTTP 200 只说明对面收到了请求；页面能弹框只说明前端拿到了 sitekey。业务层的一句话，得由业务层的判据来答。

判断的次序也因此是固定的：先问「这句话由谁来说」，再问「我手上这个信号是谁给的」。两者不是同一个主体，就不能拿后者替代前者。空 stdin 那次我差点犯的错，就是把「wrangler 说成功」读成「Worker 拿到了值」；企微那次是把「对面收到请求」读成「对面接受了这个 token」；Turnstile 那次是把「浏览器渲出了组件」读成「服务端会放行提交」。三层读错的方向一致：把上游的确认当成了下游的事实。

**空 stdin 那次**：`wrangler secret put` 在不是 TTY 的环境里会从 stdin 读值，读到空串也照样上传、照样打印成功（workers-sdk#16193）。`preflight` 又只列 secret 名字，空串也算「已配」。于是三道闸门全绿，通知静默丢失。

修法是把闸门放在调用 wrangler **之前**：

```js
if (!value || !String(value).trim())
  die(`putSecret：${name} 值为空，拒绝写入（wrangler 空 stdin 会静默成功）`);
```

位置不能挪。写入后回打用的是本地 `url` 变量，空值写进去时它照样回 `errcode 0`；CF secrets 只可写不可读，`secret list` 不给值也不给长度，写完没有第二次机会。注入时把闸门删掉再传空值，假 wrangler 静默通过、体检报「已配」；装回闸门，die 且不进体检。我没有在生产上用 `printf '''' | wrangler secret put WEBHOOK_URL` 复现——那会真的清空现役 secret 并触发部署，用假 wrangler 跑同一个形状就够了。

**HTTP 200 那次**：企微地址失效时回的是 200 加业务码 `93000`，只看状态码全是成功。token 轮换那次实测到旧地址回 `93000`、新地址回 `0`，两个数都记在 DEPLOY 的边界表里。回打函数因此把四种平台的字段都归一到同一条判据：

```js
const code = Number(data.errcode ?? data.code ?? data.StatusCode ?? 0);
if (!r.ok || code !== 0) die(`${label}失败：HTTP ${r.status} 业务码 ${code}`);
```

`setup:webhook` 在 `putSecret` 前后各走一次同一个 `smokeWebhook`：写入前自检是为了在地址写错时不先覆盖现役 secret，写入后回打是为了确认写进去的值没被改坏、token 没被轮换掉。`--dry` 跳过时必须打印原因，`--no-smoke` 是显式的救急开关，两者都不留静默。

回打发的不是 `{ text: ''test'' }`，而是复用业务通知同一个 `webhookPayload` 构造出的四平台形状。另写一个简化包等于白验：sink 侧哪天加了长度或编码校验，演练全过、真发 400，两种包型的差异正好落在没人看的地方。企微要 `msgtype: text` 加 `text.content`，飞书要 `msg_type` 加 `content.text`，Discord 用 `content`，Slack 与通用用 `text`——这段适配只有一份，脚本和业务共用，改一处不会只改到其中一边。

失败后不自动回滚 secret。回打失败有两种成因：地址本身写错，或者 sink 此刻抖动。回滚会把这两件事混成一个动作，反而把可用的旧值也弄坏。注入验证做了三条：把平台码判据改成 `false`、把调用点注释掉、删掉 `--dry` 的跳过打印——三条都先红，再还原。

**半配 Turnstile 那次**：前端拿到 sitekey 就渲染组件，CSP 也放行了 `challenges.cloudflare.com`，页面看起来完全正常；只有提交时服务端验不过，用户看到的是「评论一直提交失败」。配置过程里连续踩了四处：已有 OAuth token 缺 `challenge-widgets.write` scope，读 widget 回 403；设备码授权页点了但 token 端点持续 `authorization_pending`，页面显示已授权其实没走完；真 sitekey 含连字符，旧正则只收 base62，把真值判成「形状不对」；vars 插入写死 `R2_PUBLIC_BASE` 当锚点，Turnstile 键插到它后面之后，再插 UMAMI 两键就丢了逗号，整份 JSON 非法。

线上只读预检的结果是：评论页 200、`data-ssr="1"`、表单和 textarea 都在；sitekey 下发、CSP 带 nonce 且放行该域；评论接口 200、`total` 为 0。带无效 token 打两发，服务端分别回 400 的两句原文，复核 `total` 仍是 0。**这三样只能证明服务和拒收路径都活着，不能证明真验证码能通过**；真过验证那一步得有人点。

四处配置失败也各有自己的「成功信号」，值得并排看：

| 配置动作 | 当时以为的成功 | 实际缺的东西 | 真正的判据 |
|---|---|---|---|
| 读 widget | 已有 OAuth token | 少了 `challenge-widgets.write` scope；同一 token 读 worker scripts 是 200 | `whoami` 里出现该 scope，或 token 端点返回 200 |
| 设备码授权 | 浏览器显示了授权页 | 页面点了不等于流程走完，token 端点持续 `authorization_pending` | token 端点真的回 200 |
| 写 sitekey | 形状检查通过 | 真值含 `-`，旧正则只收 base62 | 先放行 `-` / `_`，让请求走到 siteverify 再报 secret 无效 |
| 插 vars | `--dry` 输出了 JSON | `R2_PUBLIC_BASE` 不再是末尾键，UMAMI 两键丢了逗号 | JSON 合法 + 不落盘，两条一起验 |

这四行说明一件事：**每个工具都有它自己的「成功」，而那句话的适用范围比我们以为的窄。** 页面显示已授权，是浏览器的成功；token 端点回 200，才是授权的成功。把前一个读成后一个，配置就停在半途，而所有日志都写着正常。

## 二、把会变的量当常量写进代码

三个案例的现场完全不同，错法相同。

**清单会被再去重一次。** TC-43 遍历 `CLASS_SOURCES_RAW` 判重复，前提是这份原文未去重。有人觉得两个变量名多余，把它改成 `const CLASS_SOURCES_RAW = [...new Set([...])]`，TC-43 立刻回到恒真，而且继续 pass。TC-45 本来是守这一步的元断言，但它用 `self.indexOf(''const CLASS_SOURCES = '')` 定位定义，搜索域包含字面量自己的书写处：把 `const` 改成 `let`，它命中的是 TC-43 注释里那句散文，切出 345 字符，恰好跨过一个 `new Set(`，于是 45 通过 0 失败；把 RAW 定义拆成两行，它命中的是 TC-45 自己那行代码，切出 429 字符，报出「RAW 里出现了 new Set」——红了，但理由和事实无关。长度锚点只证明切到了东西，不证明切到了对的东西。

修法是行首锚定加唯一计数：

```js
const at = (re, label) => { const all = [...self.matchAll(re)];
  assert.equal(all.length, 1, `「const ${label}」在行首出现 ${all.length} 次（应为 1）`);
  return all[0].index; };
at(/^const CLASS_SOURCES_RAW\s*=\s*\[/gm, ''CLASS_SOURCES_RAW'');
at(/^const CLASS_SOURCES\s*=/gm, ''CLASS_SOURCES'');
```

行首锚定排掉缩进里的散文和引号里的字面量，计数排掉顶格写进块注释的伪定义。`const` 改成 `let` 之后旧版继续绿，新版报「出现 0 次」；先红再还原，这条才算立住。

**共用扫描器会被加一行过滤。** TC-42 和 TC-44 共用 `scanCssRules`，各自都有锚点，但都是规模或数值锚点：一个判规则数大于 800，一个判 `--muted` 的消费点数等于登记值。在 `rules.push` 前加 `if (body.length < 16) continue;`，扫描器丢掉 31 条短规则，只剩 1088 条；TC-42 仍绿（1088 > 800），TC-44 也绿（`--muted` 恰好一条没落在这 31 条里，153 仍是 153）。两个消费者都没有理由报红，而样式表已经少算了 2.8%。

TC-46 的判据不来自扫描器：它数源文本里的 `{` 总数，减去 at-rule 自己的 `{`，应当正好等于扫描器输出的规则数，实测 `1178 - 59 = 1119`。这里要两个锚点：`openAll > 500`、`atOpen > 10`，否则两个 0 相减也会恒等。注入之后只有 TC-46 红，报「扫描器产出 1088 条，源文本独立计数 1178 - 59 = 1119 条」。**判据不能挂在自己要检验的那步转换的产物上**——这是这一类错误的统一形状。

**vars 块的「末尾一项」也会换人。** `appendVarLines` 第一版写死插在 `R2_PUBLIC_BASE` 后面，因为当时它在末尾。加了 Turnstile 之后再插 UMAMI，两个键丢了逗号，配置变成非法 JSON。修法是在 vars 块里找末尾一个真实键作为锚点，插在它后面；`--dry` 用例同时守「不落盘」和 JSON 合法性。形状正则也犯过同类错：真 sitekey 带 `-`，旧正则只收 base62，把真值挡在门外；改成放行 `-` 和 `_` 之后，占位符拦截仍在更前面，不会跟着松。

三件事的共同点：**它们把某一刻成立的形态当成了常量**。清单此刻未去重、扫描器此刻不过滤、`R2_PUBLIC_BASE` 此刻在末尾。形态一变，守着形态的断言要么恒绿，要么红得没道理。能跨过变化的只有独立计数和锚定到定义本身的定位。

同一类错误还有第三个现场，虽然不在这三处：`TOK_EXCEPTION` 登记了「注释色借用 `--muted`」，四方对账守住了来源合规，但没人问过这个来源还被谁用着。实测 `public/style.css` 里 `var(--muted)` 出现 153 次、分布在 158 个选择器上。有人嫌辅助文字太淡去调这个值，注释色跟着变，四道闸全绿。TC-44 因此登记的是**数字**而不是名单——名单会让每写一行业务 CSS 都要改契约文件，长到没人读时就退化成噪声。数字是算出来的，往清单里塞名字换不来放行。它和前两件是同一个判断：**登记「值从哪来」不等于登记「值被谁依赖」**，把一时的依赖面当成常量，就等于没有这一层。

三种现场的共同形状可以缩成一句话：**判据守住的是它自己输入的那一种形态**。输入被提前转换、被共享、被移位，判据都不会跟着变。写断言时问一句「如果被测的那一步本身被改坏，这条断言还有没有理由红」，比事后加十行判据有用。

假绿常见三种形态，这里各有一个现场：

| 形态 | 现场 | 为什么绿 |
|---|---|---|
| 空集恒真 | TC-44 的属性正则把 `.btn:hover` 的 `:hover` 当成属性名 | 总数对得上，分类全是噪声；判据只比数字不比构成 |
| 判据等价于更弱的东西 | TC-42 判规则数大于 800，丢 31 条仍是 1088 | 「大于 800」回答的是「有没有解析出一堆东西」，不是「解析对不对」 |
| 判据的输入是它要检验那步的产物 | TC-43 遍历去重后的清单判重复 | 去重发生在断言之前，重复自然为零 |

第三种最隐蔽，因为代码看起来完全合理：清单是干净的，断言也是严格的，错在两者之间那一步。识别它只看一件事——**判据的输入来自被测步骤之前还是之后**。来自之前还能守，来自之后就是自己给自己盖章。

四次注入的做法都一样：备份被测文件，改坏它，跑单条断言看着它红，还原，再跑一遍全绿。TC-45 那次改的是 `const` 一个词；TC-46 那次加的是一行 `continue`；setup 那三次分别是改判据、注释调用点、删打印。没有哪次需要改业务代码。断言值不值得留，就看这一分钟：改坏输入都不红，它以后也不会红。

## 三、停手条件：先红才加断言，静默绿就停

断言链现在有五层，每一层都曾经静默退化过一次：

| 层 | 注入 | 旧版表现 | 加层后的表现 |
|---|---|---|---|
| TC-43 | 原文被提前去重 | pass，恒真 | TC-45 报「RAW 里出现了 new Set」 |
| TC-45 | `const` 改成 `let` | 45 通过 0 失败 | 行首锚定 + 唯一计数，报「出现 0 次」 |
| TC-42 / TC-44 | 扫描器丢 31 条 | 两条都 pass | TC-46 报 1088 对 1119 |

共同症状不是「测试红了查不出原因」，而是「测试全绿，事实已经错了」。每加一层，都是因为下一层用与被测步骤无关的独立计数，把上一次静默绿变成了可见的红。

停手条件因此不是「断言越多越好」，而是一条可机械判定的规则：**对最外一层做一次注入，把它的输入改坏；它先红，就可以停在 review；它继续绿，就必须再往下加一层。** 停在 review 不等于免检——改了判据输入形态的 PR 仍要人工把落点指回来。

这条准则本身不写断言。它是关于「什么时候停止自动化」的元判据，写成断言就得再写一条守它的断言，如此递归没有终点。同理，`P-069` 明确不写阈值断言：动态类在 SSR 里的可见率是 3/39，把「该不该在 SSR 里」这种设计意图编码成阈值，等于把一个拍出来的数字钉成规范；数字记在文档里比钉在一条永远绿的断言上更有用。`P-075` 和 `P-076` 同理，一个记停手条件，一个记外部真值配置的九处同构。对账里这三条是 WARN，是刻意保留的「已知未自动化」，不是待修的红灯。

人工那一跳也挂在这条规则上。Turnstile managed 在自动化浏览器里拿不到 token，自动化到红就停，不写自动提交冒充端到端。`verify-comment-e2e` 改成生成唯一 nonce，让真人填进评论，之后从两个独立源看同一个标记：公开评论接口证明落库，自建 sink 的 inbox 证明通知触发。通知侧判据是「nonce 且带新评论字样」两个条件，只查 nonce 会把冒烟消息读成通知成功；落库侧要递归 replies，只看顶层会漏掉回复里的标记。判据自检 6 条进了 `npm test`，纯函数喂固定输入，改坏判据会红；人工点击不进测试——把自动提交塞进测试才是假绿。

两件事能自动，一件不能，边界就画在这里：判据自检是纯函数喂固定输入，属于「改坏它会红」，可以进 `npm test`；真人点验证码是链路本身，自动化到红只能停。把后者塞进测试，不会让它变真，只会让测试多一条永远绿的摆设。脚本就绪也不改变结论——要有人真点一次、真提交一条、两个源都命中，DEPLOY 里那两行才从「未验」改成「已验」。

这条规则和前两节是同一件事的三种长相。第一节里，wrangler 的成功不是 Worker 的成功；第二节里，断言的绿不是事实的绿；这一节里，自动化的红不是链路的红。三处都在提醒：**先问这句话是谁说的，再说它能证明什么。**

## 四、明说的没做

- **评论落库到触发通知仍是读码结论**。调用点在提交分支，但没有真提交触发过。冒烟验的是写入与传输，不覆盖「有评论提交时会不会发」。要有人真点一次验证码、真提交一条评论，脚本两边都命中才算过。
- **CF 线上实际存储的值读不回**。`secret list` 只给名字，本地断言用的是假 wrangler 捕获的 name/value，不是线上读回的值。这层边界写进 DEPLOY，不冒充已验。
- **没在生产用空 stdin 复现**。那会清空现役 secret 并触发部署，用假 wrangler 复现同一形状。
- **失败不回滚 secret**，理由见第一节；`--no-smoke` 只给已知 sink 暂不可达的救急场景。
- **没写第 47 条断言**，也不打算为元准则写断言。三条 WARN 保持 WARN。
- **sink 不在博客闸门扫描范围**。它是独立 Worker，改 sink 代码博客侧不会红，目前只靠真发真收那次演练守着。
- **没测真验证码的通过路径**。线上只打了无 token 和假 token 两条拒收路径，真过一次仍待人点。

## 复现条件

- 环境：Node 22+；本地断言不需要网络，`test-setup.mjs` 里需要网络的那条会显式说明跳过的部分。
- 命令：`node scripts/test-setup.mjs`、`node scripts/test-theme-contract.mjs`、`node scripts/verify-comment-e2e.mjs --check`。
- 线上只读预检：打开任意文章页看 `data-ssr`、sitekey 和 CSP；`GET /api/comments?slug=<slug>` 看 `total`；带无效 token 打 `POST /api/comments`，复核 `total` 没变。
- 线上域名：`https://miu.sryze.cc`。

## 怎么自己验一遍

按下面三张表做，每张都能单独判定，不必依赖上一篇的结论。

| 要验的事 | 命令 / 动作 | 期望 |
|---|---|---|
| 空值闸门 | `node scripts/test-setup.mjs` | 11/11 passed；删掉 `putSecret` 的空值检查再传空串会红 |
| 平台码判据 | 同上 | 把 `code !== 0` 改成 `false` 会红；注释掉回打调用会红；删掉 `--dry` 打印会红 |
| 清单去重 | `node scripts/test-theme-contract.mjs` | TC-43 / TC-45 绿；把原文提前 `new Set` 后 TC-45 红 |
| 扫描器独立计数 | 同上 | TC-46 绿；在 `rules.push` 前加 `if (body.length < 16) continue;` 后 TC-46 报 1088 对 1119 |
| 人工端到端 | `npm run verify:comment-e2e -- <slug>`（本机先设 `SINK_URL`） | 真点验证码、提交带 nonce 的评论；两个源都命中才算过 |

注入验证的做法统一：先备份被测文件，改坏它，看着断言红，再还原并复跑全绿。「看着它红」这一步不能省——没验证过会失败的断言，等于没写。
', html_content = '<h1 id="接口说成功-业务其实没通-三种静默失败和一条停手线"><a class="h-anchor" href="#接口说成功-业务其实没通-三种静默失败和一条停手线">#</a>接口说成功，业务其实没通：三种静默失败和一条停手线</h1>
<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>一次命令打印 Success 并且 <code>exit 0</code>，可能什么都没写进去。一个 HTTP 200，可能业务码是 <code>93000</code>。一页能正常弹出验证码、CSP 也放行了源，可能服务端正在拒收每一条评论。三件事表面无关，形态是同一个：<strong>传输层的成功掩盖了业务层的失败</strong>。判断方法也只有一条：别信状态码，验业务码；写入之后回打一次；「配了」不等于「配对了」。</p>
<p>这篇里所有数字都来自 2026-11-24 / 11-25 两天的注入记录和线上打点，不是推演。旧 token 打自建 sink 回 <code>93000</code>，新 token 回 <code>0</code>；扫描器被注入丢掉 31 条规则时，两个消费者 TC-42 / TC-44 继续绿，只有独立计数 TC-46 红了，报 <code>1088</code> 对 <code>1119</code>；把空值闸门去掉再传空串，假 wrangler 静默通过，体检还报告「WEBHOOK_URL 已配」。三条都能用命令复现。</p>
<p>第二类错误是把会变的量当常量写进代码。清单会被后来的人再去重一次，共用的扫描器会被加一行过滤，<code>vars</code> 块末尾那一项会换人——三处都让判据守着自己输入的那一份，而真实数据已经变了。修法不是把断言写得更长，是给它一个和被测步骤无关的独立计数。</p>
<p>第三类是停手条件。断言链不是越长越好。最外一层被改坏输入时会先红，就可以停在 review；如果继续绿，就必须再往下加一层。这条元准则本身不写断言，否则要再写一条守它的断言，无限递归。<code>P-069</code> / <code>P-075</code> / <code>P-076</code> 在对账里是 WARN，这是预期，不是待消除的红灯。</p>
<p>这篇不写发版流水账。全绿的项数、资源版本、Worker ID 都是工作日志，不是文章。这里只留两件事：为什么这么判断，以及怎么验证。</p>
<p>还有半步没验：评论落库到触发通知目前仍是读码结论，得有人真点一次验证码。观察脚本已经写好，但自动化拿不到 managed token；我不会把「脚本就绪」写成「端到端通过」。</p>
<h2 id="一-三种-成功-三个不同的失败"><a class="h-anchor" href="#一-三种-成功-三个不同的失败">#</a>一、三种「成功」，三个不同的失败</h2>
<p>先把三件事摆在一起，看它们共同缺的是什么：</p>
<div class="table-wrap"><table><thead><tr><th>场景</th><th>表面信号</th><th>真正要验的东西</th><th>实测到的失败</th></tr></thead><tbody><tr><td>写 Worker secret</td><td><code>Success</code>、<code>exit 0</code></td><td>值真的到了 Worker 绑定</td><td>非 TTY 下空 stdin 上传空值，体检只看名字仍报「已配」</td></tr><tr><td>发企微通知</td><td><code>HTTP 200</code></td><td>业务码为 0</td><td>旧 token 回 <code>{&quot;errcode&quot;:93000}</code>，新 token 回 <code>0</code></td></tr><tr><td>配人机验证</td><td>页面 200、sitekey 下发、CSP 放行</td><td>服务端 siteverify 通过</td><td>无 token 回 400「请先完成人机验证」，假 token 回 400「人机验证没通过，刷新页面再试一次」</td></tr></tbody></table></div>
<p>三个失败都不让任何原有测试变红。原因也一样：每一层都只回答了自己那层的问题。命令退 0 只说明 wrangler 收了参数；HTTP 200 只说明对面收到了请求；页面能弹框只说明前端拿到了 sitekey。业务层的一句话，得由业务层的判据来答。</p>
<p>判断的次序也因此是固定的：先问「这句话由谁来说」，再问「我手上这个信号是谁给的」。两者不是同一个主体，就不能拿后者替代前者。空 stdin 那次我差点犯的错，就是把「wrangler 说成功」读成「Worker 拿到了值」；企微那次是把「对面收到请求」读成「对面接受了这个 token」；Turnstile 那次是把「浏览器渲出了组件」读成「服务端会放行提交」。三层读错的方向一致：把上游的确认当成了下游的事实。</p>
<p><strong>空 stdin 那次</strong>：<code>wrangler secret put</code> 在不是 TTY 的环境里会从 stdin 读值，读到空串也照样上传、照样打印成功（workers-sdk#16193）。<code>preflight</code> 又只列 secret 名字，空串也算「已配」。于是三道闸门全绿，通知静默丢失。</p>
<p>修法是把闸门放在调用 wrangler <strong>之前</strong>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (!value || !<span class="tok-f">String</span>(value).<span class="tok-f">trim</span>())
  <span class="tok-f">die</span>(<span class="tok-s">`putSecret：${name} 值为空，拒绝写入（wrangler 空 stdin 会静默成功）`</span>);</code></pre></div>
<p>位置不能挪。写入后回打用的是本地 <code>url</code> 变量，空值写进去时它照样回 <code>errcode 0</code>；CF secrets 只可写不可读，<code>secret list</code> 不给值也不给长度，写完没有第二次机会。注入时把闸门删掉再传空值，假 wrangler 静默通过、体检报「已配」；装回闸门，die 且不进体检。我没有在生产上用 <code>printf &#39;&#39; | wrangler secret put WEBHOOK_URL</code> 复现——那会真的清空现役 secret 并触发部署，用假 wrangler 跑同一个形状就够了。</p>
<p><strong>HTTP 200 那次</strong>：企微地址失效时回的是 200 加业务码 <code>93000</code>，只看状态码全是成功。token 轮换那次实测到旧地址回 <code>93000</code>、新地址回 <code>0</code>，两个数都记在 DEPLOY 的边界表里。回打函数因此把四种平台的字段都归一到同一条判据：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> code = <span class="tok-f">Number</span>(data.errcode ?? data.code ?? data.StatusCode ?? <span class="tok-n">0</span>);
<span class="tok-k">if</span> (!r.ok || code !== <span class="tok-n">0</span>) <span class="tok-f">die</span>(<span class="tok-s">`${label}失败：HTTP ${r.status} 业务码 ${code}`</span>);</code></pre></div>
<p><code>setup:webhook</code> 在 <code>putSecret</code> 前后各走一次同一个 <code>smokeWebhook</code>：写入前自检是为了在地址写错时不先覆盖现役 secret，写入后回打是为了确认写进去的值没被改坏、token 没被轮换掉。<code>--dry</code> 跳过时必须打印原因，<code>--no-smoke</code> 是显式的救急开关，两者都不留静默。</p>
<p>回打发的不是 <code>{ text: &#39;test&#39; }</code>，而是复用业务通知同一个 <code>webhookPayload</code> 构造出的四平台形状。另写一个简化包等于白验：sink 侧哪天加了长度或编码校验，演练全过、真发 400，两种包型的差异正好落在没人看的地方。企微要 <code>msgtype: text</code> 加 <code>text.content</code>，飞书要 <code>msg_type</code> 加 <code>content.text</code>，Discord 用 <code>content</code>，Slack 与通用用 <code>text</code>——这段适配只有一份，脚本和业务共用，改一处不会只改到其中一边。</p>
<p>失败后不自动回滚 secret。回打失败有两种成因：地址本身写错，或者 sink 此刻抖动。回滚会把这两件事混成一个动作，反而把可用的旧值也弄坏。注入验证做了三条：把平台码判据改成 <code>false</code>、把调用点注释掉、删掉 <code>--dry</code> 的跳过打印——三条都先红，再还原。</p>
<p><strong>半配 Turnstile 那次</strong>：前端拿到 sitekey 就渲染组件，CSP 也放行了 <code>challenges.cloudflare.com</code>，页面看起来完全正常；只有提交时服务端验不过，用户看到的是「评论一直提交失败」。配置过程里连续踩了四处：已有 OAuth token 缺 <code>challenge-widgets.write</code> scope，读 widget 回 403；设备码授权页点了但 token 端点持续 <code>authorization_pending</code>，页面显示已授权其实没走完；真 sitekey 含连字符，旧正则只收 base62，把真值判成「形状不对」；vars 插入写死 <code>R2_PUBLIC_BASE</code> 当锚点，Turnstile 键插到它后面之后，再插 UMAMI 两键就丢了逗号，整份 JSON 非法。</p>
<p>线上只读预检的结果是：评论页 200、<code>data-ssr=&quot;1&quot;</code>、表单和 textarea 都在；sitekey 下发、CSP 带 nonce 且放行该域；评论接口 200、<code>total</code> 为 0。带无效 token 打两发，服务端分别回 400 的两句原文，复核 <code>total</code> 仍是 0。<strong>这三样只能证明服务和拒收路径都活着，不能证明真验证码能通过</strong>；真过验证那一步得有人点。</p>
<p>四处配置失败也各有自己的「成功信号」，值得并排看：</p>
<div class="table-wrap"><table><thead><tr><th>配置动作</th><th>当时以为的成功</th><th>实际缺的东西</th><th>真正的判据</th></tr></thead><tbody><tr><td>读 widget</td><td>已有 OAuth token</td><td>少了 <code>challenge-widgets.write</code> scope；同一 token 读 worker scripts 是 200</td><td><code>whoami</code> 里出现该 scope，或 token 端点返回 200</td></tr><tr><td>设备码授权</td><td>浏览器显示了授权页</td><td>页面点了不等于流程走完，token 端点持续 <code>authorization_pending</code></td><td>token 端点真的回 200</td></tr><tr><td>写 sitekey</td><td>形状检查通过</td><td>真值含 <code>-</code>，旧正则只收 base62</td><td>先放行 <code>-</code> / <code>_</code>，让请求走到 siteverify 再报 secret 无效</td></tr><tr><td>插 vars</td><td><code>--dry</code> 输出了 JSON</td><td><code>R2_PUBLIC_BASE</code> 不再是末尾键，UMAMI 两键丢了逗号</td><td>JSON 合法 + 不落盘，两条一起验</td></tr></tbody></table></div>
<p>这四行说明一件事：<strong>每个工具都有它自己的「成功」，而那句话的适用范围比我们以为的窄。</strong> 页面显示已授权，是浏览器的成功；token 端点回 200，才是授权的成功。把前一个读成后一个，配置就停在半途，而所有日志都写着正常。</p>
<h2 id="二-把会变的量当常量写进代码"><a class="h-anchor" href="#二-把会变的量当常量写进代码">#</a>二、把会变的量当常量写进代码</h2>
<p>三个案例的现场完全不同，错法相同。</p>
<p><strong>清单会被再去重一次。</strong> TC-43 遍历 <code>CLASS_SOURCES_RAW</code> 判重复，前提是这份原文未去重。有人觉得两个变量名多余，把它改成 <code>const CLASS_SOURCES_RAW = [...new Set([...])]</code>，TC-43 立刻回到恒真，而且继续 pass。TC-45 本来是守这一步的元断言，但它用 <code>self.indexOf(&#39;const CLASS_SOURCES = &#39;)</code> 定位定义，搜索域包含字面量自己的书写处：把 <code>const</code> 改成 <code>let</code>，它命中的是 TC-43 注释里那句散文，切出 345 字符，恰好跨过一个 <code>new Set(</code>，于是 45 通过 0 失败；把 RAW 定义拆成两行，它命中的是 TC-45 自己那行代码，切出 429 字符，报出「RAW 里出现了 new Set」——红了，但理由和事实无关。长度锚点只证明切到了东西，不证明切到了对的东西。</p>
<p>修法是行首锚定加唯一计数：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> at = (re, label) =&gt; { <span class="tok-k">const</span> all = [...self.<span class="tok-f">matchAll</span>(re)];
  assert.<span class="tok-f">equal</span>(all.length, <span class="tok-n">1</span>, <span class="tok-s">`「const ${label}」在行首出现 ${all.length} 次（应为 1）`</span>);
  <span class="tok-k">return</span> all[<span class="tok-n">0</span>].index; };
<span class="tok-f">at</span>(/^<span class="tok-k">const</span> CLASS_SOURCES_RAW\s*=\s*\[/gm, <span class="tok-s">&#39;CLASS_SOURCES_RAW&#39;</span>);
<span class="tok-f">at</span>(/^<span class="tok-k">const</span> CLASS_SOURCES\s*=/gm, <span class="tok-s">&#39;CLASS_SOURCES&#39;</span>);</code></pre></div>
<p>行首锚定排掉缩进里的散文和引号里的字面量，计数排掉顶格写进块注释的伪定义。<code>const</code> 改成 <code>let</code> 之后旧版继续绿，新版报「出现 0 次」；先红再还原，这条才算立住。</p>
<p><strong>共用扫描器会被加一行过滤。</strong> TC-42 和 TC-44 共用 <code>scanCssRules</code>，各自都有锚点，但都是规模或数值锚点：一个判规则数大于 800，一个判 <code>--muted</code> 的消费点数等于登记值。在 <code>rules.push</code> 前加 <code>if (body.length &lt; 16) continue;</code>，扫描器丢掉 31 条短规则，只剩 1088 条；TC-42 仍绿（1088 &gt; 800），TC-44 也绿（<code>--muted</code> 恰好一条没落在这 31 条里，153 仍是 153）。两个消费者都没有理由报红，而样式表已经少算了 2.8%。</p>
<p>TC-46 的判据不来自扫描器：它数源文本里的 <code>{</code> 总数，减去 at-rule 自己的 <code>{</code>，应当正好等于扫描器输出的规则数，实测 <code>1178 - 59 = 1119</code>。这里要两个锚点：<code>openAll &gt; 500</code>、<code>atOpen &gt; 10</code>，否则两个 0 相减也会恒等。注入之后只有 TC-46 红，报「扫描器产出 1088 条，源文本独立计数 1178 - 59 = 1119 条」。<strong>判据不能挂在自己要检验的那步转换的产物上</strong>——这是这一类错误的统一形状。</p>
<p><strong>vars 块的「末尾一项」也会换人。</strong> <code>appendVarLines</code> 第一版写死插在 <code>R2_PUBLIC_BASE</code> 后面，因为当时它在末尾。加了 Turnstile 之后再插 UMAMI，两个键丢了逗号，配置变成非法 JSON。修法是在 vars 块里找末尾一个真实键作为锚点，插在它后面；<code>--dry</code> 用例同时守「不落盘」和 JSON 合法性。形状正则也犯过同类错：真 sitekey 带 <code>-</code>，旧正则只收 base62，把真值挡在门外；改成放行 <code>-</code> 和 <code>_</code> 之后，占位符拦截仍在更前面，不会跟着松。</p>
<p>三件事的共同点：<strong>它们把某一刻成立的形态当成了常量</strong>。清单此刻未去重、扫描器此刻不过滤、<code>R2_PUBLIC_BASE</code> 此刻在末尾。形态一变，守着形态的断言要么恒绿，要么红得没道理。能跨过变化的只有独立计数和锚定到定义本身的定位。</p>
<p>同一类错误还有第三个现场，虽然不在这三处：<code>TOK_EXCEPTION</code> 登记了「注释色借用 <code>--muted</code>」，四方对账守住了来源合规，但没人问过这个来源还被谁用着。实测 <code>public/style.css</code> 里 <code>var(--muted)</code> 出现 153 次、分布在 158 个选择器上。有人嫌辅助文字太淡去调这个值，注释色跟着变，四道闸全绿。TC-44 因此登记的是<strong>数字</strong>而不是名单——名单会让每写一行业务 CSS 都要改契约文件，长到没人读时就退化成噪声。数字是算出来的，往清单里塞名字换不来放行。它和前两件是同一个判断：<strong>登记「值从哪来」不等于登记「值被谁依赖」</strong>，把一时的依赖面当成常量，就等于没有这一层。</p>
<p>三种现场的共同形状可以缩成一句话：<strong>判据守住的是它自己输入的那一种形态</strong>。输入被提前转换、被共享、被移位，判据都不会跟着变。写断言时问一句「如果被测的那一步本身被改坏，这条断言还有没有理由红」，比事后加十行判据有用。</p>
<p>假绿常见三种形态，这里各有一个现场：</p>
<div class="table-wrap"><table><thead><tr><th>形态</th><th>现场</th><th>为什么绿</th></tr></thead><tbody><tr><td>空集恒真</td><td>TC-44 的属性正则把 <code>.btn:hover</code> 的 <code>:hover</code> 当成属性名</td><td>总数对得上，分类全是噪声；判据只比数字不比构成</td></tr><tr><td>判据等价于更弱的东西</td><td>TC-42 判规则数大于 800，丢 31 条仍是 1088</td><td>「大于 800」回答的是「有没有解析出一堆东西」，不是「解析对不对」</td></tr><tr><td>判据的输入是它要检验那步的产物</td><td>TC-43 遍历去重后的清单判重复</td><td>去重发生在断言之前，重复自然为零</td></tr></tbody></table></div>
<p>第三种最隐蔽，因为代码看起来完全合理：清单是干净的，断言也是严格的，错在两者之间那一步。识别它只看一件事——<strong>判据的输入来自被测步骤之前还是之后</strong>。来自之前还能守，来自之后就是自己给自己盖章。</p>
<p>四次注入的做法都一样：备份被测文件，改坏它，跑单条断言看着它红，还原，再跑一遍全绿。TC-45 那次改的是 <code>const</code> 一个词；TC-46 那次加的是一行 <code>continue</code>；setup 那三次分别是改判据、注释调用点、删打印。没有哪次需要改业务代码。断言值不值得留，就看这一分钟：改坏输入都不红，它以后也不会红。</p>
<h2 id="三-停手条件-先红才加断言-静默绿就停"><a class="h-anchor" href="#三-停手条件-先红才加断言-静默绿就停">#</a>三、停手条件：先红才加断言，静默绿就停</h2>
<p>断言链现在有五层，每一层都曾经静默退化过一次：</p>
<div class="table-wrap"><table><thead><tr><th>层</th><th>注入</th><th>旧版表现</th><th>加层后的表现</th></tr></thead><tbody><tr><td>TC-43</td><td>原文被提前去重</td><td>pass，恒真</td><td>TC-45 报「RAW 里出现了 new Set」</td></tr><tr><td>TC-45</td><td><code>const</code> 改成 <code>let</code></td><td>45 通过 0 失败</td><td>行首锚定 + 唯一计数，报「出现 0 次」</td></tr><tr><td>TC-42 / TC-44</td><td>扫描器丢 31 条</td><td>两条都 pass</td><td>TC-46 报 1088 对 1119</td></tr></tbody></table></div>
<p>共同症状不是「测试红了查不出原因」，而是「测试全绿，事实已经错了」。每加一层，都是因为下一层用与被测步骤无关的独立计数，把上一次静默绿变成了可见的红。</p>
<p>停手条件因此不是「断言越多越好」，而是一条可机械判定的规则：<strong>对最外一层做一次注入，把它的输入改坏；它先红，就可以停在 review；它继续绿，就必须再往下加一层。</strong> 停在 review 不等于免检——改了判据输入形态的 PR 仍要人工把落点指回来。</p>
<p>这条准则本身不写断言。它是关于「什么时候停止自动化」的元判据，写成断言就得再写一条守它的断言，如此递归没有终点。同理，<code>P-069</code> 明确不写阈值断言：动态类在 SSR 里的可见率是 3/39，把「该不该在 SSR 里」这种设计意图编码成阈值，等于把一个拍出来的数字钉成规范；数字记在文档里比钉在一条永远绿的断言上更有用。<code>P-075</code> 和 <code>P-076</code> 同理，一个记停手条件，一个记外部真值配置的九处同构。对账里这三条是 WARN，是刻意保留的「已知未自动化」，不是待修的红灯。</p>
<p>人工那一跳也挂在这条规则上。Turnstile managed 在自动化浏览器里拿不到 token，自动化到红就停，不写自动提交冒充端到端。<code>verify-comment-e2e</code> 改成生成唯一 nonce，让真人填进评论，之后从两个独立源看同一个标记：公开评论接口证明落库，自建 sink 的 inbox 证明通知触发。通知侧判据是「nonce 且带新评论字样」两个条件，只查 nonce 会把冒烟消息读成通知成功；落库侧要递归 replies，只看顶层会漏掉回复里的标记。判据自检 6 条进了 <code>npm test</code>，纯函数喂固定输入，改坏判据会红；人工点击不进测试——把自动提交塞进测试才是假绿。</p>
<p>两件事能自动，一件不能，边界就画在这里：判据自检是纯函数喂固定输入，属于「改坏它会红」，可以进 <code>npm test</code>；真人点验证码是链路本身，自动化到红只能停。把后者塞进测试，不会让它变真，只会让测试多一条永远绿的摆设。脚本就绪也不改变结论——要有人真点一次、真提交一条、两个源都命中，DEPLOY 里那两行才从「未验」改成「已验」。</p>
<p>这条规则和前两节是同一件事的三种长相。第一节里，wrangler 的成功不是 Worker 的成功；第二节里，断言的绿不是事实的绿；这一节里，自动化的红不是链路的红。三处都在提醒：<strong>先问这句话是谁说的，再说它能证明什么。</strong></p>
<h2 id="四-明说的没做"><a class="h-anchor" href="#四-明说的没做">#</a>四、明说的没做</h2>
<ul><li><strong>评论落库到触发通知仍是读码结论</strong>。调用点在提交分支，但没有真提交触发过。冒烟验的是写入与传输，不覆盖「有评论提交时会不会发」。要有人真点一次验证码、真提交一条评论，脚本两边都命中才算过。</li><li><strong>CF 线上实际存储的值读不回</strong>。<code>secret list</code> 只给名字，本地断言用的是假 wrangler 捕获的 name/value，不是线上读回的值。这层边界写进 DEPLOY，不冒充已验。</li><li><strong>没在生产用空 stdin 复现</strong>。那会清空现役 secret 并触发部署，用假 wrangler 复现同一形状。</li><li><strong>失败不回滚 secret</strong>，理由见第一节；<code>--no-smoke</code> 只给已知 sink 暂不可达的救急场景。</li><li><strong>没写第 47 条断言</strong>，也不打算为元准则写断言。三条 WARN 保持 WARN。</li><li><strong>sink 不在博客闸门扫描范围</strong>。它是独立 Worker，改 sink 代码博客侧不会红，目前只靠真发真收那次演练守着。</li><li><strong>没测真验证码的通过路径</strong>。线上只打了无 token 和假 token 两条拒收路径，真过一次仍待人点。</li></ul>
<h2 id="复现条件"><a class="h-anchor" href="#复现条件">#</a>复现条件</h2>
<ul><li>环境：Node 22+；本地断言不需要网络，<code>test-setup.mjs</code> 里需要网络的那条会显式说明跳过的部分。</li><li>命令：<code>node scripts/test-setup.mjs</code>、<code>node scripts/test-theme-contract.mjs</code>、<code>node scripts/verify-comment-e2e.mjs --check</code>。</li><li>线上只读预检：打开任意文章页看 <code>data-ssr</code>、sitekey 和 CSP；<code>GET /api/comments?slug=&lt;slug&gt;</code> 看 <code>total</code>；带无效 token 打 <code>POST /api/comments</code>，复核 <code>total</code> 没变。</li><li>线上域名：<code>https://miu.sryze.cc</code>。</li></ul>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>按下面三张表做，每张都能单独判定，不必依赖上一篇的结论。</p>
<div class="table-wrap"><table><thead><tr><th>要验的事</th><th>命令 / 动作</th><th>期望</th></tr></thead><tbody><tr><td>空值闸门</td><td><code>node scripts/test-setup.mjs</code></td><td>11/11 passed；删掉 <code>putSecret</code> 的空值检查再传空串会红</td></tr><tr><td>平台码判据</td><td>同上</td><td>把 <code>code !== 0</code> 改成 <code>false</code> 会红；注释掉回打调用会红；删掉 <code>--dry</code> 打印会红</td></tr><tr><td>清单去重</td><td><code>node scripts/test-theme-contract.mjs</code></td><td>TC-43 / TC-45 绿；把原文提前 <code>new Set</code> 后 TC-45 红</td></tr><tr><td>扫描器独立计数</td><td>同上</td><td>TC-46 绿；在 <code>rules.push</code> 前加 <code>if (body.length &lt; 16) continue;</code> 后 TC-46 报 1088 对 1119</td></tr><tr><td>人工端到端</td><td><code>npm run verify:comment-e2e -- &lt;slug&gt;</code>（本机先设 <code>SINK_URL</code>）</td><td>真点验证码、提交带 nonce 的评论；两个源都命中才算过</td></tr></tbody></table></div>
<p>注入验证的做法统一：先备份被测文件，改坏它，看着断言红，再还原并复跑全绿。「看着它红」这一步不能省——没验证过会失败的断言，等于没写。</p>', cover_body = '',
                 summary = 'wrangler 打印 Success 却写进空值、企微回 HTTP 200 加 errcode 93000、Turnstile 能弹框却拒收每一条评论：三件事形态相同——传输层的成功掩盖了业务层的失败。另记两种同构错误：把会变的量当常量写进代码（原文被再去重、扫描器少算 31 条、vars 锚点写死），以及停手条件（改坏输入先红才可停在 review，静默绿必须再加一层）。评论落库到触发通知仍是读码结论，明说没验。', updated_at = datetime('now')
  WHERE slug = 'success-but-not-through';

INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'success-but-not-through' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('turnstile') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'success-but-not-through' AND t.name = 'turnstile';
INSERT INTO tags (name) VALUES ('testing') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'success-but-not-through' AND t.name = 'testing';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'success-but-not-through' AND t.name = 'debugging';
-- 回补内链：11-comment-anti-spam.md
UPDATE posts SET content = '写[R2 那篇](/p/r2-image-pipeline)时预告过这篇。真动手才发现，评论防滥用没有一处需要"聪明"：三层防线全是排序题——**哪一层放在请求路径最前面，取决于拒掉一次攻击要花多少钱**。

现在的形态是三层，从零成本往上排：

| 顺序 | 层 | 一次拒绝的代价 | 失败方向 |
|---|---|---|---|
| 1 | 蜜罐字段 `hp` | 一次字符串 trim，不碰数据库、不发请求 | fail-closed（填了就拒） |
| 2 | Turnstile siteverify | 一次跨网 HTTPS 往返（仅配了 key 才发生） | 网络异常时 fail-open（放行） |
| 3 | D1 限额 | 一次 SELECT + 一次 batch 写 | fail-closed |

这条排序不是按"强度"排的，是按"钱"排的。命中第一层就 return，后面两层的数据库和网络开销一分不花。垃圾评论里最大的一类是"不跑 JS 的填表机"，而它们恰好会被最便宜的那层筛掉。

先贴实测。下面每个状态码、每个响应头都是今天线上跑出来的，不是"应该会"。

## 实测：四种拒绝，四条不同的出口

```
[1] 空 body 提交
POST /api/comments  {}
→ 400  {"ok":false,"error":"评论不能为空"}

[2] 蜜罐填了值（其余字段合法）
POST /api/comments  {"slug":"d1-no-such-table","content":"probe","name":"石井探针",
                     "email":"probe@example.com","hp":"http://spam"}
→ 400  {"ok":false,"error":"验证没通过，刷新页面再试一次"}

[3] 第一条正常提交
POST /api/comments  {…合法字段，hp 为空}
→ 200  {"ok":true,"id":9}
   Set-Cookie: cmt_did=46d65ce8…; Path=/; HttpOnly; SameSite=Lax;
               Max-Age=34560000; Secure

[4] 紧接着发第二条（同一出口 IP）
POST /api/comments  {…同样合法}
→ 429  {"ok":false,"error":"发得太快了，隔一分钟再发"}
   Retry-After: 60

[5] 把该 IP 在限额表里标成 banned 之后再发
→ 403  {"ok":false,"error":"这个来源被拦下了，如果误伤请联系博主"}
   Retry-After: 3600
```

注意 [2] 和 [4] 的区别：**同一个已经被限流的 IP，撞蜜罐拿到的仍然是 400 而不是 429**。顺序在代码里就是这么写的，不是靠返回码猜的。

`[2]` 之前先通过的校验链是：内容非空 → 文章存在 → 昵称非空 → 邮箱格式。所以一条"邮箱写错 + 蜜罐被填"的请求，先撞的是邮箱。这类顺序不影响安全，但影响你排查时看到哪个错——**把便宜的检查放前面，日志里看到的第一条错误永远是原因，不是后果**。

## 第一层：蜜罐，把"看不见"做成结构

表单里有个字段叫 `hp`，站在页面上看不见：

```html
<input type="text" name="hp" class="hp" tabindex="-1"
       autocomplete="off" aria-hidden="true" placeholder="留空">
```

```css
.cmt-form .hp {
  position: absolute; left: -9999px;
  width: 1px; height: 1px;
  opacity: 0; pointer-events: none;
}
```

四个属性各有分工，缺一个都会被某类爬虫捡走：

- **不用 `display:none`**：一部分填表机会跳过不可见元素，`display:none` 等于告诉它"这个别填"。挪到视窗外（`left:-9999px`）+ `opacity:0` 仍然参与布局，在 DOM 层面它就是个普通输入框；
- **`tabindex="-1"`**：键盘 Tab 跳不过去，真人不会误入；
- **`autocomplete="off"`**：密码管理器往里塞邮箱是最烦的一种"误伤"，显式关掉；
- **`aria-hidden="true"`**：读屏软件不念它，否则视障用户会听到一个没有意义的"留空"输入框。

服务端只有一行：

```js
if (String(body.hp || '''').trim()) return err(''验证没通过，刷新页面再试一次'', 400);
```

**为什么是 400 而不是静默 200 假成功？** 这是这层唯一值得争论的地方，我选了对真人有利的一边：

静默 200 对脚本更阴——它不知道哪一步错了，只会以为成功，连"下次别填这个字段"都学不到。但如果哪天某个密码管理器硬塞了一个字符进去（`autocomplete="off"` 只是建议，不是命令），真人看到的是"评论已发布"，然后评论凭空消失，没有任何线索。

**宁可让脚本学到规则，也不让真人的评论无声蒸发。** 这是一次明确的取舍，不是疏忽。

代价说清楚：`hp` 这个字段名一旦被写进某个采集器的黑名单，这层就只剩"拦住最懒的那批"。所以它是筛子，不是墙。

## 第二层：Turnstile，重点不在组件在配置

组件本身没什么可讲的：Cloudflare 的 Turnstile 免费、无感、不卖数据，接上就行。真正决定这层值不值的是三件事：什么时候加载、谁来验、验不了怎么办。

### 加载：配置驱动，没配就一个请求都不发

```js
let tsFailed = false;   // 配了 key 但脚本没下来（断网、被拦截插件掐掉）

async function mountTurnstile() {
  const key = (window.__SITE__ || {}).turnstile;
  const slot = document.getElementById(''ts-wrap'');
  if (!key || !slot) return;          // 没配 key：到这里就结束
  slot.hidden = false;
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement(''script'');
      s.src = ''https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'';
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    window.turnstile.render(slot, { sitekey: key, language: ''zh-cn'', size: ''flexible'' });
  } catch {
    tsFailed = true;
    slot.hidden = true;
  }
}
```

`?render=explicit` 是关键：默认的 `auto` 模式是"见到占位符就长出来"，那意味着只要页面里有那个 div，第三方脚本就有机会被拉起来。explicit 把"何时渲染"的决定权留在自己的代码里，而上面那个 `return` 保证了这个决定永远是"不加载"。

当前状态：`TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET` 两个都没配，页面里 `"turnstile":""`。所以 `challenges.cloudflare.com` 这个字符串在源码里出现 1 次（就上面那行 `src`），**实际网络请求 0 次**。这不是"加载了但没显示"，是根本没走那行代码。

### 两处收口，别只改一处

关掉 Turnstile 不只影响那一个 `return`，CSP 也得跟着：

```js
function csp(n, { turnstile = false } = {}) {
  const ts = turnstile ? '' https://challenges.cloudflare.com'' : '''';
  return [
    "default-src ''self''",
    `script-src ''self'' ''nonce-${n}''${ts}`,
    `connect-src ''self''${ts}`,
    `frame-src ''self''${ts}`,
    // …
  ];
}
```

漏掉 `frame-src` 的后果很典型：组件是个 iframe，脚本能加载、能初始化，但框里一片空白，控制台报 CSP 违规——而你会先去怀疑 key 错了。**开关必须同时管到"脚本从哪来"和"框从哪来"**，这两个是不同的指令。

### 校验：前端那个框只是个摆设

安全上唯一有意义的一步在服务端，`siteverify` 拿 token 复核：

```js
const form = new FormData();
form.append(''secret'', secret);
form.append(''response'', String(token));
if (ip) form.append(''remoteip'', ip);

const r = await fetch(''https://challenges.cloudflare.com/turnstile/v0/siteverify'', { method: ''POST'', body: form });
const d = await r.json();
if (d.success) return { ok: true };
return { ok: false, error: ''人机验证没通过，刷新页面再试一次'' };
```

`remoteip` 是可选的，但传上去了能让 Cloudflare 把"这个 token 是在哪个 IP 上签发的"一起判——token 被搬到另一个 IP 上重放时才有得比。

### 验不了的时候：这层是 fail-open 的

```js
} catch {
  // 校验服务自己挂了，不能连累评论功能 —— 记一笔降级，放行
  console.warn(''[antispam] turnstile siteverify 不可达，本次降级放行'');
  return { ok: true, degraded: true };
}
```

这跟[上一节讲的 fail-closed](/p/editor-markdown-xss)方向相反，是有意的：siteverify 是外部依赖，它挂的时候如果跟着 fail-closed，全站评论会以一个第三方服务为条件停摆，而攻击者只要能把那个域名打到超时，就等于免费关掉了你的评论区——**这本身就是一次拒绝服务**。

代价也真实：这条路理论上可被利用。能打挂 Cloudflare 校验接口的人，大概也不在乎你这一个博客的评论。取舍是这么算的。

### 半配比不配更危险

这是我写完才想明白的一点，顺手补成了代码。Turnstile 有两个 key，配置有四种状态：

```js
export function turnstileMode(env = {}) {
  const site = !!(env && env.TURNSTILE_SITE_KEY);
  const secret = !!(env && env.TURNSTILE_SECRET);
  if (site && secret) return ''on'';
  if (site) return ''site-only'';
  if (secret) return ''secret-only'';
  return ''off'';
}
```

- **只配 sitekey**：前端老老实实弹验证框，访客认真勾了，服务端却无从校验——因为 `verifyTurnstile` 的第一行是"没 secret 就跳过"。这层防护是**假的**，而它看起来是真的。这种状态比不配更糟：不配你至少知道自己没防护。所以 `site-only` 按配置不完整拒收，宁可评论挂掉被发现；
- **只配 secret**：前端根本没组件，谁也拿不出 token，此时要求 token 等于全员禁言。按未启用处理，打一行 warn。

**配置的一半不是一半的防护，是一半的错觉。** 这条经验适用于所有"开关 + 密钥"双要素的服务，不只是 Turnstile。

### 顺带修的一个死锁

`mountTurnstile` 的 catch 里原来只有一句 `slot.hidden = true`。问题在提交时：

```js
const tsToken = window.turnstile && document.getElementById(''ts-wrap'')?.hidden === false
  ? window.turnstile.getResponse() : '''';
if (window.__SITE__ && window.__SITE__.turnstile && !tsToken) {
  toast(tsFailed ? ''人机验证组件没加载出来，刷新页面或换个网络再试'' : ''先完成人机验证'');
  return;
}
```

改之前这里只有一句"先完成人机验证"。当脚本被拦截插件掐掉、或者网络抖动没下来时，组件框并不存在，用户被要求去勾一个看不见的东西，刷新也不一定好——**报错文案指错了方向，比没有文案更费时间**。现在加载失败有单独的标记和单独的话。

## 第三层：D1 限额，两把钥匙和一个时区

前两层管"你是不是脚本"，这层管"你就算是真人，也别刷"。

```js
export const MIN_GAP_SEC = 60;   // 同 IP 相邻两条的最小间隔
export const DAY_MAX = 10;       // 每天上限（IP 与设备各算各的）
```

判定抽成了一个不碰数据库、不发请求的纯函数，方便单测：

```js
export function judge(rec, nowSec, { minGap = MIN_GAP_SEC, dayMax = DAY_MAX, checkGap = true } = {}) {
  if (!rec) return { ok: true };
  if (Number(rec.banned) === 1) {
    return { ok: false, status: 403, error: ''这个来源被拦下了，如果误伤请联系博主'', retry: 3600 };
  }
  const hits = rec.day === dayKey(nowSec) ? Number(rec.hits) : 0;
  if (hits >= dayMax) {
    return { ok: false, status: 429, error: `今天已经发了 ${dayMax} 条，明天再来`, retry: secsToNextDay(nowSec) };
  }
  if (checkGap && rec.last_ts) {
    const gap = nowSec - Number(rec.last_ts);
    if (gap < minGap) return { ok: false, status: 429, error: ''发得太快了，隔一分钟再发'', retry: minGap - gap };
  }
  return { ok: true };
}
```

**banned 的判断放在额度之前**：被拉黑的人不管今天发了几条，拿到的都是 403 而不是 429。用状态码把"你被禁了"和"你太快了"分开，前端和日志都不用猜。

### 为什么是两把钥匙

`guard()` 同时查 `ip:…` 和 `dev:…` 两行：

```js
const ip = request.headers.get(''cf-connecting-ip'') || ''0.0.0.0'';
const raw = parseCookies(request)[DID_COOKIE] || '''';
const did = /^[a-f0-9]{24,64}$/i.test(raw) ? raw.toLowerCase() : '''';
const fresh = !did;
```

- **IP 那把**：60 秒一条 + 每天 10 条；
- **设备那把**（`cmt_did`，服务端发的 32 位十六进制，HttpOnly + Secure + 400 天）：只查每天 10 条，**不查间隔**。

设备键不查 60 秒间隔，是因为同一个人的两个标签页不该互相拦——IP 键已经把"机器人连发"拦住了，设备键存在的意义是"同一台机器就算换 IP 也别超过 10 条"，它不需要管节奏。

实测落库的样子（两次写入是同一秒，所以 `last_ts` 一样）：

```
k                                day          hits  last_ts
ip:188.253.6.247                 2026-11-12   1     1794413231
dev:46d65ce8…c45caa0f            2026-11-12   1     1794413231
```

### 那个日期是 11-12，而 UTC 还在 11-11

这不是 bug。`last_ts = 1794413231` 是 UTC `2026-11-11 16:07:11`，北京时间 `2026-11-12 00:07:11`，而日额度的日期键按 **UTC+8** 切：

```js
const TZ_OFFSET = 8 * 3600;
export function dayKey(sec) {
  return new Date((sec + TZ_OFFSET) * 1000).toISOString().slice(0, 10);
}
```

用 UTC 零点换天的后果很具体：**北京时间早上 8 点，一个中国访客的额度刚被重置**——他在凌晨刷满 10 条，睡一觉起来又能刷。按作者的生活时间切，额度才对应"今天"这个直觉。

`retry-after` 也跟着算，而不是固定给 60：

```js
export function secsToNextDay(sec) {
  const local = sec + TZ_OFFSET;
  return 86400 - (local % 86400);
}
```

上面那个时刻如果打满日额度，返回的 `Retry-After` 是 **85969**（≈23.88 小时），不是 86400——因为当天已经过了 431 秒。少算这 431 秒的后果是客户端多等一会儿，不算大事；但一个"永远返回 86400"的实现，在 23:59 提交的人会被要求等一整天，差了一秒的边界就成了差一天的体验。

### 记账的时机：落库成功才记

```js
// 落库成功才计额度：被 400 拒掉的请求不占次数
if (rate && rate.ok) {
  await record(db, rate.ip, rate.did, Math.floor(Date.now() / 1000));
  if (rate.fresh) headers[''set-cookie''] = setCookie(''cmt_did'', rate.did, { maxAge: DID_MAX_AGE });
}
```

这个先后顺序很重要。假如改成"请求进来就先记一笔"，那么任何人只要对着接口发 10 个内容为空的请求，就能把这个 IP 后面一小时（甚至一天）的评论额度全部烧掉——**在一个所有访客共享出口 IP 的移动网络下，这等于给陌生人一个关掉评论区的能力**。

写库用一条 upsert 同时处理"新的一天"和"同一天累加"：

```sql
INSERT INTO comment_guard (k, day, hits, last_ts) VALUES (?, ?, 1, ?)
ON CONFLICT(k) DO UPDATE SET
  hits = CASE WHEN comment_guard.day = ? THEN comment_guard.hits + 1 ELSE 1 END,
  day  = ?,
  last_ts = ?;
```

`hits = CASE WHEN day 相同 THEN hits+1 ELSE 1` 这一行替代了"先查再判断要不要清零"的三次往返。跨天不需要定时任务，第一次写入自然把计数打回 1。

### 时间逻辑单独说，它最容易写错

`judge` 抽成纯函数就是为了测它。13 条断言里，4 条专门钉时间：

```
ok  同一天打满额度就拦，retry 指向次日零点
ok  跨天后额度归零：昨天打满不影响今天
ok  间隔不足 60 秒拦住，retry 是差额
ok  刚好满 60 秒放行
ok  日期按 UTC+8 切：UTC 16:00 就是北京的次日零点
ok  secsToNextDay 在北京零点等于一整天
```

"刚好满 60 秒放行"和"跨天后归零"这两条，如果用 `<=` 而不是 `<`、用 `day !==` 而不是 `day ===`，人肉 review 三遍都看不出来，线上表现是"偶尔少拦一条"或者"偶尔多拦一条"——**没有测试的话，这种 bug 会活到你自己被拦的那天**。

## 封 IP：一键连坐，而不是单点删除

管理员视图里每条访客评论旁边的按钮，title 原文是"删掉这个来源的全部访客评论，并拉黑该 IP"。它做的事：

```js
// 只清访客评论，管理员自己的一条都不动
const { results } = await db
  .prepare(''SELECT id FROM comments WHERE ip = ? AND is_admin = 0'')
  .bind(c.ip).all();
// …删掉这些评论及其子回复…
await banIp(db, c.ip);
```

三个决定：

1. **连坐**：一个来发广告的号不会只发一条，逐条删等于替它做签到。按 IP 一次清干净，不留"漏网的那条明天冒出来"的尾巴；
2. **`is_admin = 0` 这个条件是必须的**：同一条宽带下，我自己的评论和访客的评论 IP 是一样的。少了这个条件，点一次"封 IP"会把自己写过的评论一起抹掉；
3. **入口做成一条评论上的按钮**，而不是后台一个 IP 黑名单表格。处置的动作发生在"你正看着垃圾"的那一刻，三个点击内完成。

`banIp` 只写一个字段：

```sql
INSERT INTO comment_guard (k, day, hits, last_ts, banned) VALUES (?, ?, 0, 0, 1)
ON CONFLICT(k) DO UPDATE SET banned = 1;
```

顺手回答一个必然会问的问题：**没有 TTL，是永久的**。解封目前只能改库——后台没有解封入口。这是个真实欠账，不是设计。

拉黑动作本身也值得说：它是**人按的**，没有自动规则。这条和[友链检测篇那个"403 不算挂"](/p/worker-cron-friend-check)是同一类教训的反面——**"看着像垃圾"也不等于垃圾**。按 UA、按关键词、按频率自动封，第一个被误伤的永远是办公网出口、公司 NAT、运营商 CGNAT。自动封禁省的是我的点击，花的是误伤活人的风险，这买卖现在不做。

## 数据面：邮箱和 IP 只进不出

这条其实比 Turnstile 更早生效。评论要求填邮箱，但公开列表接口按身份剥字段：

```js
const isAdm = !!(user && user.is_admin);
const rows = isAdm ? results : results.map(({ email, ip, ...rest }) => rest);
```

实测的公开响应（游客视角）：

```json
{"ok":true,"total":1,"comments":[{"id":9,"parent_id":null,"name":"石井探针",
 "website":"","content":"防滥用探针：这条会在验证后被删除。","is_admin":0,
 "created_at":"2026-11-11 16:07:11","replies":[]}]}
```

没有 `email`，没有 `ip`。管理员视图里邮箱渲染成一个 `mailto:` 链接（title "联系邮箱，仅管理员可见"），IP 只用于"封 IP"这个动作。

为什么值得单独写一节：**垃圾评论存在的意义之一就是收割邮箱**。把它们的存在理由去掉一半，比多拦几条更有用。到了[全站邮箱混淆](/p/about)那一步，这条线才真正闭合——公开页面上连一个可抓的地址都没有。

## 六个没做，明说

比"做了什么"更需要说清楚的是边界：

1. **没有内容层检测**。不看链接数、不看关键词、不接第三方库。一条评论只要过了人机验证和频率限制，就会立即公开。这是拿"少量垃圾可见"换"零审核压力"；
2. **限额只有两把钥匙**。换 IP + 清 cookie 之后，就只剩 IP 那一把的额度可算。没有网段聚合、没有 ASN 维度。要绕真能绕，只是绕的成本比发广告的收益高；
3. **`banned` 永久，没有解封入口**。误封只能进 D1 改 `banned = 0`。写在这里，是因为半年后我自己也会忘；
4. **siteverify 网络异常时放行**。见上文，可用性优先于这层防护，代价是理论上可被"打挂校验服务"绕过；
5. **10 条/天在 CGNAT 出口会误伤**。一个宿舍楼、一个公司出口，10 个真人一天只能发 10 条。这个数字是按单人站点的真实流量定的，不是按"公平"定的；
6. **蜜罐的 400 可被学习**。脚本第二次就知道 `hp` 要留空。这层只对"第一次来的懒脚本"有效。

还有一件属于权衡而非欠账的：**没有先审后发**。评论即时公开，管理员事后处置——这也是排序题的一部分，审核压力放在人身上，比放在请求路径上贵得多。

## 清单

| 层 | 机制 | 抓谁 | 误伤谁 | 失败方向 |
|---|---|---|---|---|
| 表单 | `hp` 蜜罐（视窗外 + `tabindex=-1` + `autocomplete=off`） | 不跑 JS 的填表机 | 谁都不，除非密码管理器硬填 | closed |
| 前端 | Turnstile explicit，`sitekey` 驱动，没配 = 0 请求 | 浏览器级脚本 | 无 | closed（组件加载失败就不让提交） |
| 服务端 | `siteverify` 复核 token + `remoteip` | 伪造提交的脚本 | 无 | open（校验服务不可达时降级放行） |
| 限额 | D1 双钥匙（IP / 设备），60 秒 + 10 条/天，UTC+8 换天 | 真人刷屏、换 cookie 刷 | CGNAT 共享出口 | closed |
| 处置 | 封 IP：清同源访客评论 + 永久拉黑 | 已成灾的来源 | 同 NAT 下的其他访客——靠人按 | 手按 |
| 数据面 | 邮箱/IP 按 `isAdmin` 剥字段 | 采集器 | 无 | closed |

三层加起来不到 200 行，没有一处需要模型、规则库或者人来值班。**够不够用，取决于你的评论区有没有人想攻**——单作者站，这三层大概能撑到"第一个认真的人出现"。

至于它撑了多久、后台那个"封 IP"按钮到底有没有被真的按过——等第一条垃圾评论出现，拿真实处置记录写《垃圾评论标本室》。在那之前，继续写正经的。

后补一句：蜜罐命中时到底返回什么、拦住的到底是响应还是落库，后来单独写成了一篇（排期 2027-02）。在那之前，把 `400` 改成 `200`、或者把蜜罐挪到 `INSERT` 之后，`npm test` 一条都不会红。

再补一句：Turnstile 配好了不等于配对了。sitekey 下发、CSP 放行、页面能弹框，三样都绿也可能服务端在拒收每一条评论；把「接口说成功」拆开看的那次实测，写在[接口说成功，业务其实没通](/p/success-but-not-through)。

#cloudflare #turnstile #security
', html_content = '<p>写<a href="/p/r2-image-pipeline">R2 那篇</a>时预告过这篇。真动手才发现，评论防滥用没有一处需要&quot;聪明&quot;：三层防线全是排序题——<strong>哪一层放在请求路径最前面，取决于拒掉一次攻击要花多少钱</strong>。</p>
<p>现在的形态是三层，从零成本往上排：</p>
<div class="table-wrap"><table><thead><tr><th>顺序</th><th>层</th><th>一次拒绝的代价</th><th>失败方向</th></tr></thead><tbody><tr><td>1</td><td>蜜罐字段 <code>hp</code></td><td>一次字符串 trim，不碰数据库、不发请求</td><td>fail-closed（填了就拒）</td></tr><tr><td>2</td><td>Turnstile siteverify</td><td>一次跨网 HTTPS 往返（仅配了 key 才发生）</td><td>网络异常时 fail-open（放行）</td></tr><tr><td>3</td><td>D1 限额</td><td>一次 SELECT + 一次 batch 写</td><td>fail-closed</td></tr></tbody></table></div>
<p>这条排序不是按&quot;强度&quot;排的，是按&quot;钱&quot;排的。命中第一层就 return，后面两层的数据库和网络开销一分不花。垃圾评论里最大的一类是&quot;不跑 JS 的填表机&quot;，而它们恰好会被最便宜的那层筛掉。</p>
<p>先贴实测。下面每个状态码、每个响应头都是今天线上跑出来的，不是&quot;应该会&quot;。</p>
<h2 id="实测-四种拒绝-四条不同的出口"><a class="h-anchor" href="#实测-四种拒绝-四条不同的出口">#</a>实测：四种拒绝，四条不同的出口</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span><span class="code-ln">23 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23</span><code class="language-text">[1] 空 body 提交
POST /api/comments  {}
→ 400  {&quot;ok&quot;:false,&quot;error&quot;:&quot;评论不能为空&quot;}

[2] 蜜罐填了值（其余字段合法）
POST /api/comments  {&quot;slug&quot;:&quot;d1-no-such-table&quot;,&quot;content&quot;:&quot;probe&quot;,&quot;name&quot;:&quot;石井探针&quot;,
                     &quot;email&quot;:&quot;probe@example.com&quot;,&quot;hp&quot;:&quot;http://spam&quot;}
→ 400  {&quot;ok&quot;:false,&quot;error&quot;:&quot;验证没通过，刷新页面再试一次&quot;}

[3] 第一条正常提交
POST /api/comments  {…合法字段，hp 为空}
→ 200  {&quot;ok&quot;:true,&quot;id&quot;:9}
   Set-Cookie: cmt_did=46d65ce8…; Path=/; HttpOnly; SameSite=Lax;
               Max-Age=34560000; Secure

[4] 紧接着发第二条（同一出口 IP）
POST /api/comments  {…同样合法}
→ 429  {&quot;ok&quot;:false,&quot;error&quot;:&quot;发得太快了，隔一分钟再发&quot;}
   Retry-After: 60

[5] 把该 IP 在限额表里标成 banned 之后再发
→ 403  {&quot;ok&quot;:false,&quot;error&quot;:&quot;这个来源被拦下了，如果误伤请联系博主&quot;}
   Retry-After: 3600</code></pre></div>
<p>注意 [2] 和 [4] 的区别：<strong>同一个已经被限流的 IP，撞蜜罐拿到的仍然是 400 而不是 429</strong>。顺序在代码里就是这么写的，不是靠返回码猜的。</p>
<p><code>[2]</code> 之前先通过的校验链是：内容非空 → 文章存在 → 昵称非空 → 邮箱格式。所以一条&quot;邮箱写错 + 蜜罐被填&quot;的请求，先撞的是邮箱。这类顺序不影响安全，但影响你排查时看到哪个错——<strong>把便宜的检查放前面，日志里看到的第一条错误永远是原因，不是后果</strong>。</p>
<h2 id="第一层-蜜罐-把-看不见-做成结构"><a class="h-anchor" href="#第一层-蜜罐-把-看不见-做成结构">#</a>第一层：蜜罐，把&quot;看不见&quot;做成结构</h2>
<p>表单里有个字段叫 <code>hp</code>，站在页面上看不见：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">html</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-html">&lt;input type=<span class="tok-s">&quot;text&quot;</span> name=<span class="tok-s">&quot;hp&quot;</span> class=<span class="tok-s">&quot;hp&quot;</span> tabindex=<span class="tok-s">&quot;-1&quot;</span>
       autocomplete=<span class="tok-s">&quot;off&quot;</span> aria-hidden=<span class="tok-s">&quot;true&quot;</span> placeholder=<span class="tok-s">&quot;留空&quot;</span>&gt;</code></pre></div>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">css</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-css">.cmt-form .hp {
  position: absolute; left: -<span class="tok-n">9999px</span>;
  width: <span class="tok-n">1px</span>; height: <span class="tok-n">1px</span>;
  opacity: <span class="tok-n">0</span>; pointer-events: none;
}</code></pre></div>
<p>四个属性各有分工，缺一个都会被某类爬虫捡走：</p>
<ul><li><strong>不用 <code>display:none</code></strong>：一部分填表机会跳过不可见元素，<code>display:none</code> 等于告诉它&quot;这个别填&quot;。挪到视窗外（<code>left:-9999px</code>）+ <code>opacity:0</code> 仍然参与布局，在 DOM 层面它就是个普通输入框；</li><li><strong><code>tabindex=&quot;-1&quot;</code></strong>：键盘 Tab 跳不过去，真人不会误入；</li><li><strong><code>autocomplete=&quot;off&quot;</code></strong>：密码管理器往里塞邮箱是最烦的一种&quot;误伤&quot;，显式关掉；</li><li><strong><code>aria-hidden=&quot;true&quot;</code></strong>：读屏软件不念它，否则视障用户会听到一个没有意义的&quot;留空&quot;输入框。</li></ul>
<p>服务端只有一行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (<span class="tok-f">String</span>(body.hp || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">trim</span>()) <span class="tok-k">return</span> <span class="tok-f">err</span>(<span class="tok-s">&#39;验证没通过，刷新页面再试一次&#39;</span>, <span class="tok-n">400</span>);</code></pre></div>
<p><strong>为什么是 400 而不是静默 200 假成功？</strong> 这是这层唯一值得争论的地方，我选了对真人有利的一边：</p>
<p>静默 200 对脚本更阴——它不知道哪一步错了，只会以为成功，连&quot;下次别填这个字段&quot;都学不到。但如果哪天某个密码管理器硬塞了一个字符进去（<code>autocomplete=&quot;off&quot;</code> 只是建议，不是命令），真人看到的是&quot;评论已发布&quot;，然后评论凭空消失，没有任何线索。</p>
<p><strong>宁可让脚本学到规则，也不让真人的评论无声蒸发。</strong> 这是一次明确的取舍，不是疏忽。</p>
<p>代价说清楚：<code>hp</code> 这个字段名一旦被写进某个采集器的黑名单，这层就只剩&quot;拦住最懒的那批&quot;。所以它是筛子，不是墙。</p>
<h2 id="第二层-turnstile-重点不在组件在配置"><a class="h-anchor" href="#第二层-turnstile-重点不在组件在配置">#</a>第二层：Turnstile，重点不在组件在配置</h2>
<p>组件本身没什么可讲的：Cloudflare 的 Turnstile 免费、无感、不卖数据，接上就行。真正决定这层值不值的是三件事：什么时候加载、谁来验、验不了怎么办。</p>
<h3 id="加载-配置驱动-没配就一个请求都不发"><a class="h-anchor" href="#加载-配置驱动-没配就一个请求都不发">#</a>加载：配置驱动，没配就一个请求都不发</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span><span class="code-ln">22 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22</span><code class="language-js"><span class="tok-k">let</span> tsFailed = <span class="tok-k">false</span>;   <span class="tok-c">// 配了 key 但脚本没下来（断网、被拦截插件掐掉）</span>

<span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">mountTurnstile</span>() {
  <span class="tok-k">const</span> key = (window.__SITE__ || {}).turnstile;
  <span class="tok-k">const</span> slot = document.<span class="tok-f">getElementById</span>(<span class="tok-s">&#39;ts-wrap&#39;</span>);
  <span class="tok-k">if</span> (!key || !slot) <span class="tok-k">return</span>;          <span class="tok-c">// 没配 key：到这里就结束</span>
  slot.hidden = <span class="tok-k">false</span>;
  <span class="tok-k">try</span> {
    <span class="tok-k">await</span> <span class="tok-k">new</span> <span class="tok-f">Promise</span>((resolve, reject) =&gt; {
      <span class="tok-k">const</span> s = document.<span class="tok-f">createElement</span>(<span class="tok-s">&#39;script&#39;</span>);
      s.src = <span class="tok-s">&#39;https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&#39;</span>;
      s.<span class="tok-k">async</span> = <span class="tok-k">true</span>;
      s.onload = resolve;
      s.onerror = reject;
      document.head.<span class="tok-f">appendChild</span>(s);
    });
    window.turnstile.<span class="tok-f">render</span>(slot, { sitekey: key, language: <span class="tok-s">&#39;zh-cn&#39;</span>, size: <span class="tok-s">&#39;flexible&#39;</span> });
  } <span class="tok-k">catch</span> {
    tsFailed = <span class="tok-k">true</span>;
    slot.hidden = <span class="tok-k">true</span>;
  }
}</code></pre></div>
<p><code>?render=explicit</code> 是关键：默认的 <code>auto</code> 模式是&quot;见到占位符就长出来&quot;，那意味着只要页面里有那个 div，第三方脚本就有机会被拉起来。explicit 把&quot;何时渲染&quot;的决定权留在自己的代码里，而上面那个 <code>return</code> 保证了这个决定永远是&quot;不加载&quot;。</p>
<p>当前状态：<code>TURNSTILE_SITE_KEY</code> 和 <code>TURNSTILE_SECRET</code> 两个都没配，页面里 <code>&quot;turnstile&quot;:&quot;&quot;</code>。所以 <code>challenges.cloudflare.com</code> 这个字符串在源码里出现 1 次（就上面那行 <code>src</code>），<strong>实际网络请求 0 次</strong>。这不是&quot;加载了但没显示&quot;，是根本没走那行代码。</p>
<h3 id="两处收口-别只改一处"><a class="h-anchor" href="#两处收口-别只改一处">#</a>两处收口，别只改一处</h3>
<p>关掉 Turnstile 不只影响那一个 <code>return</code>，CSP 也得跟着：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">csp</span>(n, { turnstile = <span class="tok-k">false</span> } = {}) {
  <span class="tok-k">const</span> ts = turnstile ? <span class="tok-s">&#39; https://challenges.cloudflare.com&#39;</span> : <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">return</span> [
    <span class="tok-s">&quot;default-src &#39;self&#39;&quot;</span>,
    <span class="tok-s">`script-src &#39;self&#39; &#39;nonce-${n}&#39;${ts}`</span>,
    <span class="tok-s">`connect-src &#39;self&#39;${ts}`</span>,
    <span class="tok-s">`frame-src &#39;self&#39;${ts}`</span>,
    <span class="tok-c">// …</span>
  ];
}</code></pre></div>
<p>漏掉 <code>frame-src</code> 的后果很典型：组件是个 iframe，脚本能加载、能初始化，但框里一片空白，控制台报 CSP 违规——而你会先去怀疑 key 错了。<strong>开关必须同时管到&quot;脚本从哪来&quot;和&quot;框从哪来&quot;</strong>，这两个是不同的指令。</p>
<h3 id="校验-前端那个框只是个摆设"><a class="h-anchor" href="#校验-前端那个框只是个摆设">#</a>校验：前端那个框只是个摆设</h3>
<p>安全上唯一有意义的一步在服务端，<code>siteverify</code> 拿 token 复核：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> form = <span class="tok-k">new</span> <span class="tok-f">FormData</span>();
form.<span class="tok-f">append</span>(<span class="tok-s">&#39;secret&#39;</span>, secret);
form.<span class="tok-f">append</span>(<span class="tok-s">&#39;response&#39;</span>, <span class="tok-f">String</span>(token));
<span class="tok-k">if</span> (ip) form.<span class="tok-f">append</span>(<span class="tok-s">&#39;remoteip&#39;</span>, ip);

<span class="tok-k">const</span> r = <span class="tok-k">await</span> <span class="tok-f">fetch</span>(<span class="tok-s">&#39;https://challenges.cloudflare.com/turnstile/v0/siteverify&#39;</span>, { method: <span class="tok-s">&#39;POST&#39;</span>, body: form });
<span class="tok-k">const</span> d = <span class="tok-k">await</span> r.<span class="tok-f">json</span>();
<span class="tok-k">if</span> (d.success) <span class="tok-k">return</span> { ok: <span class="tok-k">true</span> };
<span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, error: <span class="tok-s">&#39;人机验证没通过，刷新页面再试一次&#39;</span> };</code></pre></div>
<p><code>remoteip</code> 是可选的，但传上去了能让 Cloudflare 把&quot;这个 token 是在哪个 IP 上签发的&quot;一起判——token 被搬到另一个 IP 上重放时才有得比。</p>
<h3 id="验不了的时候-这层是-fail-open-的"><a class="h-anchor" href="#验不了的时候-这层是-fail-open-的">#</a>验不了的时候：这层是 fail-open 的</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">} <span class="tok-k">catch</span> {
  <span class="tok-c">// 校验服务自己挂了，不能连累评论功能 —— 记一笔降级，放行</span>
  console.<span class="tok-f">warn</span>(<span class="tok-s">&#39;[antispam] turnstile siteverify 不可达，本次降级放行&#39;</span>);
  <span class="tok-k">return</span> { ok: <span class="tok-k">true</span>, degraded: <span class="tok-k">true</span> };
}</code></pre></div>
<p>这跟<a href="/p/editor-markdown-xss">上一节讲的 fail-closed</a>方向相反，是有意的：siteverify 是外部依赖，它挂的时候如果跟着 fail-closed，全站评论会以一个第三方服务为条件停摆，而攻击者只要能把那个域名打到超时，就等于免费关掉了你的评论区——<strong>这本身就是一次拒绝服务</strong>。</p>
<p>代价也真实：这条路理论上可被利用。能打挂 Cloudflare 校验接口的人，大概也不在乎你这一个博客的评论。取舍是这么算的。</p>
<h3 id="半配比不配更危险"><a class="h-anchor" href="#半配比不配更危险">#</a>半配比不配更危险</h3>
<p>这是我写完才想明白的一点，顺手补成了代码。Turnstile 有两个 key，配置有四种状态：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">turnstileMode</span>(env = {}) {
  <span class="tok-k">const</span> site = !!(env &amp;&amp; env.TURNSTILE_SITE_KEY);
  <span class="tok-k">const</span> secret = !!(env &amp;&amp; env.TURNSTILE_SECRET);
  <span class="tok-k">if</span> (site &amp;&amp; secret) <span class="tok-k">return</span> <span class="tok-s">&#39;on&#39;</span>;
  <span class="tok-k">if</span> (site) <span class="tok-k">return</span> <span class="tok-s">&#39;site-only&#39;</span>;
  <span class="tok-k">if</span> (secret) <span class="tok-k">return</span> <span class="tok-s">&#39;secret-only&#39;</span>;
  <span class="tok-k">return</span> <span class="tok-s">&#39;off&#39;</span>;
}</code></pre></div>
<ul><li><strong>只配 sitekey</strong>：前端老老实实弹验证框，访客认真勾了，服务端却无从校验——因为 <code>verifyTurnstile</code> 的第一行是&quot;没 secret 就跳过&quot;。这层防护是<strong>假的</strong>，而它看起来是真的。这种状态比不配更糟：不配你至少知道自己没防护。所以 <code>site-only</code> 按配置不完整拒收，宁可评论挂掉被发现；</li><li><strong>只配 secret</strong>：前端根本没组件，谁也拿不出 token，此时要求 token 等于全员禁言。按未启用处理，打一行 warn。</li></ul>
<p><strong>配置的一半不是一半的防护，是一半的错觉。</strong> 这条经验适用于所有&quot;开关 + 密钥&quot;双要素的服务，不只是 Turnstile。</p>
<h3 id="顺带修的一个死锁"><a class="h-anchor" href="#顺带修的一个死锁">#</a>顺带修的一个死锁</h3>
<p><code>mountTurnstile</code> 的 catch 里原来只有一句 <code>slot.hidden = true</code>。问题在提交时：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> tsToken = window.turnstile &amp;&amp; document.<span class="tok-f">getElementById</span>(<span class="tok-s">&#39;ts-wrap&#39;</span>)?.hidden === <span class="tok-k">false</span>
  ? window.turnstile.<span class="tok-f">getResponse</span>() : <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">if</span> (window.__SITE__ &amp;&amp; window.__SITE__.turnstile &amp;&amp; !tsToken) {
  <span class="tok-f">toast</span>(tsFailed ? <span class="tok-s">&#39;人机验证组件没加载出来，刷新页面或换个网络再试&#39;</span> : <span class="tok-s">&#39;先完成人机验证&#39;</span>);
  <span class="tok-k">return</span>;
}</code></pre></div>
<p>改之前这里只有一句&quot;先完成人机验证&quot;。当脚本被拦截插件掐掉、或者网络抖动没下来时，组件框并不存在，用户被要求去勾一个看不见的东西，刷新也不一定好——<strong>报错文案指错了方向，比没有文案更费时间</strong>。现在加载失败有单独的标记和单独的话。</p>
<h2 id="第三层-d1-限额-两把钥匙和一个时区"><a class="h-anchor" href="#第三层-d1-限额-两把钥匙和一个时区">#</a>第三层：D1 限额，两把钥匙和一个时区</h2>
<p>前两层管&quot;你是不是脚本&quot;，这层管&quot;你就算是真人，也别刷&quot;。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">const</span> MIN_GAP_SEC = <span class="tok-n">60</span>;   <span class="tok-c">// 同 IP 相邻两条的最小间隔</span>
<span class="tok-k">export</span> <span class="tok-k">const</span> DAY_MAX = <span class="tok-n">10</span>;       <span class="tok-c">// 每天上限（IP 与设备各算各的）</span></code></pre></div>
<p>判定抽成了一个不碰数据库、不发请求的纯函数，方便单测：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">judge</span>(rec, nowSec, { minGap = MIN_GAP_SEC, dayMax = DAY_MAX, checkGap = <span class="tok-k">true</span> } = {}) {
  <span class="tok-k">if</span> (!rec) <span class="tok-k">return</span> { ok: <span class="tok-k">true</span> };
  <span class="tok-k">if</span> (<span class="tok-f">Number</span>(rec.banned) === <span class="tok-n">1</span>) {
    <span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, status: <span class="tok-n">403</span>, error: <span class="tok-s">&#39;这个来源被拦下了，如果误伤请联系博主&#39;</span>, retry: <span class="tok-n">3600</span> };
  }
  <span class="tok-k">const</span> hits = rec.day === <span class="tok-f">dayKey</span>(nowSec) ? <span class="tok-f">Number</span>(rec.hits) : <span class="tok-n">0</span>;
  <span class="tok-k">if</span> (hits &gt;= dayMax) {
    <span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, status: <span class="tok-n">429</span>, error: <span class="tok-s">`今天已经发了 ${dayMax} 条，明天再来`</span>, retry: <span class="tok-f">secsToNextDay</span>(nowSec) };
  }
  <span class="tok-k">if</span> (checkGap &amp;&amp; rec.last_ts) {
    <span class="tok-k">const</span> gap = nowSec - <span class="tok-f">Number</span>(rec.last_ts);
    <span class="tok-k">if</span> (gap &lt; minGap) <span class="tok-k">return</span> { ok: <span class="tok-k">false</span>, status: <span class="tok-n">429</span>, error: <span class="tok-s">&#39;发得太快了，隔一分钟再发&#39;</span>, retry: minGap - gap };
  }
  <span class="tok-k">return</span> { ok: <span class="tok-k">true</span> };
}</code></pre></div>
<p><strong>banned 的判断放在额度之前</strong>：被拉黑的人不管今天发了几条，拿到的都是 403 而不是 429。用状态码把&quot;你被禁了&quot;和&quot;你太快了&quot;分开，前端和日志都不用猜。</p>
<h3 id="为什么是两把钥匙"><a class="h-anchor" href="#为什么是两把钥匙">#</a>为什么是两把钥匙</h3>
<p><code>guard()</code> 同时查 <code>ip:…</code> 和 <code>dev:…</code> 两行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> ip = request.headers.<span class="tok-k">get</span>(<span class="tok-s">&#39;cf-connecting-ip&#39;</span>) || <span class="tok-s">&#39;0.0.0.0&#39;</span>;
<span class="tok-k">const</span> raw = <span class="tok-f">parseCookies</span>(request)[DID_COOKIE] || <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">const</span> did = /^[a-f0-<span class="tok-n">9</span>]{<span class="tok-n">24</span>,<span class="tok-n">64</span>}$/i.<span class="tok-f">test</span>(raw) ? raw.<span class="tok-f">toLowerCase</span>() : <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">const</span> fresh = !did;</code></pre></div>
<ul><li><strong>IP 那把</strong>：60 秒一条 + 每天 10 条；</li><li><strong>设备那把</strong>（<code>cmt_did</code>，服务端发的 32 位十六进制，HttpOnly + Secure + 400 天）：只查每天 10 条，<strong>不查间隔</strong>。</li></ul>
<p>设备键不查 60 秒间隔，是因为同一个人的两个标签页不该互相拦——IP 键已经把&quot;机器人连发&quot;拦住了，设备键存在的意义是&quot;同一台机器就算换 IP 也别超过 10 条&quot;，它不需要管节奏。</p>
<p>实测落库的样子（两次写入是同一秒，所以 <code>last_ts</code> 一样）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">k                                day          hits  last_ts
ip:188.253.6.247                 2026-11-12   1     1794413231
dev:46d65ce8…c45caa0f            2026-11-12   1     1794413231</code></pre></div>
<h3 id="那个日期是-11-12-而-utc-还在-11-11"><a class="h-anchor" href="#那个日期是-11-12-而-utc-还在-11-11">#</a>那个日期是 11-12，而 UTC 还在 11-11</h3>
<p>这不是 bug。<code>last_ts = 1794413231</code> 是 UTC <code>2026-11-11 16:07:11</code>，北京时间 <code>2026-11-12 00:07:11</code>，而日额度的日期键按 <strong>UTC+8</strong> 切：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> TZ_OFFSET = <span class="tok-n">8</span> * <span class="tok-n">3600</span>;
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">dayKey</span>(sec) {
  <span class="tok-k">return</span> <span class="tok-k">new</span> <span class="tok-f">Date</span>((sec + TZ_OFFSET) * <span class="tok-n">1000</span>).<span class="tok-f">toISOString</span>().<span class="tok-f">slice</span>(<span class="tok-n">0</span>, <span class="tok-n">10</span>);
}</code></pre></div>
<p>用 UTC 零点换天的后果很具体：<strong>北京时间早上 8 点，一个中国访客的额度刚被重置</strong>——他在凌晨刷满 10 条，睡一觉起来又能刷。按作者的生活时间切，额度才对应&quot;今天&quot;这个直觉。</p>
<p><code>retry-after</code> 也跟着算，而不是固定给 60：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">secsToNextDay</span>(sec) {
  <span class="tok-k">const</span> local = sec + TZ_OFFSET;
  <span class="tok-k">return</span> <span class="tok-n">86400</span> - (local % <span class="tok-n">86400</span>);
}</code></pre></div>
<p>上面那个时刻如果打满日额度，返回的 <code>Retry-After</code> 是 <strong>85969</strong>（≈23.88 小时），不是 86400——因为当天已经过了 431 秒。少算这 431 秒的后果是客户端多等一会儿，不算大事；但一个&quot;永远返回 86400&quot;的实现，在 23:59 提交的人会被要求等一整天，差了一秒的边界就成了差一天的体验。</p>
<h3 id="记账的时机-落库成功才记"><a class="h-anchor" href="#记账的时机-落库成功才记">#</a>记账的时机：落库成功才记</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 落库成功才计额度：被 400 拒掉的请求不占次数</span>
<span class="tok-k">if</span> (rate &amp;&amp; rate.ok) {
  <span class="tok-k">await</span> <span class="tok-f">record</span>(db, rate.ip, rate.did, Math.<span class="tok-f">floor</span>(Date.<span class="tok-f">now</span>() / <span class="tok-n">1000</span>));
  <span class="tok-k">if</span> (rate.fresh) headers[<span class="tok-s">&#39;set-cookie&#39;</span>] = <span class="tok-f">setCookie</span>(<span class="tok-s">&#39;cmt_did&#39;</span>, rate.did, { maxAge: DID_MAX_AGE });
}</code></pre></div>
<p>这个先后顺序很重要。假如改成&quot;请求进来就先记一笔&quot;，那么任何人只要对着接口发 10 个内容为空的请求，就能把这个 IP 后面一小时（甚至一天）的评论额度全部烧掉——<strong>在一个所有访客共享出口 IP 的移动网络下，这等于给陌生人一个关掉评论区的能力</strong>。</p>
<p>写库用一条 upsert 同时处理&quot;新的一天&quot;和&quot;同一天累加&quot;：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">INSERT INTO comment_guard (k, day, hits, last_ts) VALUES (?, ?, <span class="tok-n">1</span>, ?)
ON <span class="tok-f">CONFLICT</span>(k) DO UPDATE SET
  hits = CASE WHEN comment_guard.day = ? THEN comment_guard.hits + <span class="tok-n">1</span> ELSE <span class="tok-n">1</span> END,
  day  = ?,
  last_ts = ?;</code></pre></div>
<p><code>hits = CASE WHEN day 相同 THEN hits+1 ELSE 1</code> 这一行替代了&quot;先查再判断要不要清零&quot;的三次往返。跨天不需要定时任务，第一次写入自然把计数打回 1。</p>
<h3 id="时间逻辑单独说-它最容易写错"><a class="h-anchor" href="#时间逻辑单独说-它最容易写错">#</a>时间逻辑单独说，它最容易写错</h3>
<p><code>judge</code> 抽成纯函数就是为了测它。13 条断言里，4 条专门钉时间：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">ok  同一天打满额度就拦，retry 指向次日零点
ok  跨天后额度归零：昨天打满不影响今天
ok  间隔不足 60 秒拦住，retry 是差额
ok  刚好满 60 秒放行
ok  日期按 UTC+8 切：UTC 16:00 就是北京的次日零点
ok  secsToNextDay 在北京零点等于一整天</code></pre></div>
<p>&quot;刚好满 60 秒放行&quot;和&quot;跨天后归零&quot;这两条，如果用 <code>&lt;=</code> 而不是 <code>&lt;</code>、用 <code>day !==</code> 而不是 <code>day ===</code>，人肉 review 三遍都看不出来，线上表现是&quot;偶尔少拦一条&quot;或者&quot;偶尔多拦一条&quot;——<strong>没有测试的话，这种 bug 会活到你自己被拦的那天</strong>。</p>
<h2 id="封-ip-一键连坐-而不是单点删除"><a class="h-anchor" href="#封-ip-一键连坐-而不是单点删除">#</a>封 IP：一键连坐，而不是单点删除</h2>
<p>管理员视图里每条访客评论旁边的按钮，title 原文是&quot;删掉这个来源的全部访客评论，并拉黑该 IP&quot;。它做的事：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 只清访客评论，管理员自己的一条都不动</span>
<span class="tok-k">const</span> { results } = <span class="tok-k">await</span> db
  .<span class="tok-f">prepare</span>(<span class="tok-s">&#39;SELECT id FROM comments WHERE ip = ? AND is_admin = 0&#39;</span>)
  .<span class="tok-f">bind</span>(c.ip).<span class="tok-f">all</span>();
<span class="tok-c">// …删掉这些评论及其子回复…</span>
<span class="tok-k">await</span> <span class="tok-f">banIp</span>(db, c.ip);</code></pre></div>
<p>三个决定：</p>
<ol><li><strong>连坐</strong>：一个来发广告的号不会只发一条，逐条删等于替它做签到。按 IP 一次清干净，不留&quot;漏网的那条明天冒出来&quot;的尾巴；</li><li><strong><code>is_admin = 0</code> 这个条件是必须的</strong>：同一条宽带下，我自己的评论和访客的评论 IP 是一样的。少了这个条件，点一次&quot;封 IP&quot;会把自己写过的评论一起抹掉；</li><li><strong>入口做成一条评论上的按钮</strong>，而不是后台一个 IP 黑名单表格。处置的动作发生在&quot;你正看着垃圾&quot;的那一刻，三个点击内完成。</li></ol>
<p><code>banIp</code> 只写一个字段：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">INSERT INTO comment_guard (k, day, hits, last_ts, banned) VALUES (?, ?, <span class="tok-n">0</span>, <span class="tok-n">0</span>, <span class="tok-n">1</span>)
ON <span class="tok-f">CONFLICT</span>(k) DO UPDATE SET banned = <span class="tok-n">1</span>;</code></pre></div>
<p>顺手回答一个必然会问的问题：<strong>没有 TTL，是永久的</strong>。解封目前只能改库——后台没有解封入口。这是个真实欠账，不是设计。</p>
<p>拉黑动作本身也值得说：它是<strong>人按的</strong>，没有自动规则。这条和<a href="/p/worker-cron-friend-check">友链检测篇那个&quot;403 不算挂&quot;</a>是同一类教训的反面——<strong>&quot;看着像垃圾&quot;也不等于垃圾</strong>。按 UA、按关键词、按频率自动封，第一个被误伤的永远是办公网出口、公司 NAT、运营商 CGNAT。自动封禁省的是我的点击，花的是误伤活人的风险，这买卖现在不做。</p>
<h2 id="数据面-邮箱和-ip-只进不出"><a class="h-anchor" href="#数据面-邮箱和-ip-只进不出">#</a>数据面：邮箱和 IP 只进不出</h2>
<p>这条其实比 Turnstile 更早生效。评论要求填邮箱，但公开列表接口按身份剥字段：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> isAdm = !!(user &amp;&amp; user.is_admin);
<span class="tok-k">const</span> rows = isAdm ? results : results.<span class="tok-f">map</span>(({ email, ip, ...rest }) =&gt; rest);</code></pre></div>
<p>实测的公开响应（游客视角）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">json</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-json">{<span class="tok-s">&quot;ok&quot;</span>:<span class="tok-k">true</span>,<span class="tok-s">&quot;total&quot;</span>:<span class="tok-n">1</span>,<span class="tok-s">&quot;comments&quot;</span>:[{<span class="tok-s">&quot;id&quot;</span>:<span class="tok-n">9</span>,<span class="tok-s">&quot;parent_id&quot;</span>:<span class="tok-k">null</span>,<span class="tok-s">&quot;name&quot;</span>:<span class="tok-s">&quot;石井探针&quot;</span>,
 <span class="tok-s">&quot;website&quot;</span>:<span class="tok-s">&quot;&quot;</span>,<span class="tok-s">&quot;content&quot;</span>:<span class="tok-s">&quot;防滥用探针：这条会在验证后被删除。&quot;</span>,<span class="tok-s">&quot;is_admin&quot;</span>:<span class="tok-n">0</span>,
 <span class="tok-s">&quot;created_at&quot;</span>:<span class="tok-s">&quot;2026-11-11 16:07:11&quot;</span>,<span class="tok-s">&quot;replies&quot;</span>:[]}]}</code></pre></div>
<p>没有 <code>email</code>，没有 <code>ip</code>。管理员视图里邮箱渲染成一个 <code>mailto:</code> 链接（title &quot;联系邮箱，仅管理员可见&quot;），IP 只用于&quot;封 IP&quot;这个动作。</p>
<p>为什么值得单独写一节：<strong>垃圾评论存在的意义之一就是收割邮箱</strong>。把它们的存在理由去掉一半，比多拦几条更有用。到了<a href="/p/about">全站邮箱混淆</a>那一步，这条线才真正闭合——公开页面上连一个可抓的地址都没有。</p>
<h2 id="六个没做-明说"><a class="h-anchor" href="#六个没做-明说">#</a>六个没做，明说</h2>
<p>比&quot;做了什么&quot;更需要说清楚的是边界：</p>
<ol><li><strong>没有内容层检测</strong>。不看链接数、不看关键词、不接第三方库。一条评论只要过了人机验证和频率限制，就会立即公开。这是拿&quot;少量垃圾可见&quot;换&quot;零审核压力&quot;；</li><li><strong>限额只有两把钥匙</strong>。换 IP + 清 cookie 之后，就只剩 IP 那一把的额度可算。没有网段聚合、没有 ASN 维度。要绕真能绕，只是绕的成本比发广告的收益高；</li><li><strong><code>banned</code> 永久，没有解封入口</strong>。误封只能进 D1 改 <code>banned = 0</code>。写在这里，是因为半年后我自己也会忘；</li><li><strong>siteverify 网络异常时放行</strong>。见上文，可用性优先于这层防护，代价是理论上可被&quot;打挂校验服务&quot;绕过；</li><li><strong>10 条/天在 CGNAT 出口会误伤</strong>。一个宿舍楼、一个公司出口，10 个真人一天只能发 10 条。这个数字是按单人站点的真实流量定的，不是按&quot;公平&quot;定的；</li><li><strong>蜜罐的 400 可被学习</strong>。脚本第二次就知道 <code>hp</code> 要留空。这层只对&quot;第一次来的懒脚本&quot;有效。</li></ol>
<p>还有一件属于权衡而非欠账的：<strong>没有先审后发</strong>。评论即时公开，管理员事后处置——这也是排序题的一部分，审核压力放在人身上，比放在请求路径上贵得多。</p>
<h2 id="清单"><a class="h-anchor" href="#清单">#</a>清单</h2>
<div class="table-wrap"><table><thead><tr><th>层</th><th>机制</th><th>抓谁</th><th>误伤谁</th><th>失败方向</th></tr></thead><tbody><tr><td>表单</td><td><code>hp</code> 蜜罐（视窗外 + <code>tabindex=-1</code> + <code>autocomplete=off</code>）</td><td>不跑 JS 的填表机</td><td>谁都不，除非密码管理器硬填</td><td>closed</td></tr><tr><td>前端</td><td>Turnstile explicit，<code>sitekey</code> 驱动，没配 = 0 请求</td><td>浏览器级脚本</td><td>无</td><td>closed（组件加载失败就不让提交）</td></tr><tr><td>服务端</td><td><code>siteverify</code> 复核 token + <code>remoteip</code></td><td>伪造提交的脚本</td><td>无</td><td>open（校验服务不可达时降级放行）</td></tr><tr><td>限额</td><td>D1 双钥匙（IP / 设备），60 秒 + 10 条/天，UTC+8 换天</td><td>真人刷屏、换 cookie 刷</td><td>CGNAT 共享出口</td><td>closed</td></tr><tr><td>处置</td><td>封 IP：清同源访客评论 + 永久拉黑</td><td>已成灾的来源</td><td>同 NAT 下的其他访客——靠人按</td><td>手按</td></tr><tr><td>数据面</td><td>邮箱/IP 按 <code>isAdmin</code> 剥字段</td><td>采集器</td><td>无</td><td>closed</td></tr></tbody></table></div>
<p>三层加起来不到 200 行，没有一处需要模型、规则库或者人来值班。<strong>够不够用，取决于你的评论区有没有人想攻</strong>——单作者站，这三层大概能撑到&quot;第一个认真的人出现&quot;。</p>
<p>至于它撑了多久、后台那个&quot;封 IP&quot;按钮到底有没有被真的按过——等第一条垃圾评论出现，拿真实处置记录写《垃圾评论标本室》。在那之前，继续写正经的。</p>
<p>后补一句：蜜罐命中时到底返回什么、拦住的到底是响应还是落库，后来单独写成了一篇（排期 2027-02）。在那之前，把 <code>400</code> 改成 <code>200</code>、或者把蜜罐挪到 <code>INSERT</code> 之后，<code>npm test</code> 一条都不会红。</p>
<p>再补一句：Turnstile 配好了不等于配对了。sitekey 下发、CSP 放行、页面能弹框，三样都绿也可能服务端在拒收每一条评论；把「接口说成功」拆开看的那次实测，写在<a href="/p/success-but-not-through">接口说成功，业务其实没通</a>。</p>
<p><a class="tag-inline" href="/tag/cloudflare">#cloudflare</a> <a class="tag-inline" href="/tag/turnstile">#turnstile</a> <a class="tag-inline" href="/tag/security">#security</a></p>', cover_body = '', updated_at = datetime('now')
  WHERE slug = 'comment-anti-spam';
-- 回补内链：13-worker-render-549-to-96.md
UPDATE posts SET content = '11-09 那天部署完，我抓到的第一条 `Server-Timing` 是 `cfWorker;dur=549`，同一个版本另一个页面是 `752`。今天同一个栏目页 `/cat/tools`，同样的探针，`84` 到 `96`。

数字没造假，但标题这句话是**不严谨**的。549 和 96 之间隔着两个变量：一个是冷启动转热，一个才是代码改动。把这俩混在一起说"我只改了一件事就把 549 变成 96"，属于拿两个不同实验的结果互相背书。

所以这篇分两半：先把尺子校准，把 549 拆成"冷启动"和"排队"两块钱；再讲那件唯一改对的事——它省下的正好是 96ms，而不是 450ms。

先说结论：

| 阶段 | /cat/tools 的 Worker 执行时间 | 这块是谁的钱 |
|---|---|---|
| 11-09 部署后第一发（冷 isolate + 串行查询） | 549ms | 冷启动 ~370 + 排队 ~96 + 渲染十几毫秒 |
| 同版本，预热之后（串行查询） | 180ms | 全是排队 |
| 改动之后（并发查询） | 84ms | 1 次往返 + 5ms CPU |

真正可以靠写代码省掉的是中间那 96ms。冷启动那块，改代码省不掉。

## 一、先校准尺子：`cfWorker` 是好尺子，但不是一直有

`Server-Timing: cfWorker;dur=549` 这个头不是我们写的，是 Cloudflare 加的，意思是"这一发请求在 Worker 里待了 549 毫秒"。它最接近"渲染耗时"这个概念，所以当时我拿它做记录。

问题是它现在在线上抓不到了：

```bash
curl -s -o /dev/null -D - "https://exia.de5.net/cat/tools?x=$RANDOM" | grep -i server-timing
# 没有输出
```

今天同一台 Worker、同一个 URL，这个头不见了。可能是平台侧策略变了，也可能是压缩/缓存路径上被吃掉了。不管原因是什么，结论是：**别把一次性的观察当成长期监控**。你三个月后想复现，得有个不依赖平台施舍的尺子。

这篇里所有数字都用另外两种尺子量，都能自己跑：

**尺子 A：TTFB 减静态资源地板。** TTFB 里混着网络往返，直接比会掺水。先量一个静态文件的 TTFB（它由边缘直接吐，不含 Worker 逻辑），这一段就是"网络+边缘"的地板，减掉之后剩下的才是 Worker 的时间。

```bash
# 地板：静态资源，边缘直接返回
curl -s -o /dev/null -w "%{time_starttransfer}\n" "https://exia.de5.net/style.css?f=$RANDOM"
# 待测页面，带随机参数强制绕过缓存
curl -s -o /dev/null -w "%{time_starttransfer}\n" "https://exia.de5.net/cat/tools?x=$RANDOM"
```

**尺子 B：`wrangler tail` 的 `wallTime` / `cpuTime`。** 这是 Worker 自己报的账，比任何外部探针都准，而且能把"耗时"和"算力"分开：

```bash
npx wrangler tail --format json
# 每个事件里带 wallTime（墙钟）和 cpuTime（CPU 毫秒）
```

第一次看到这两个数并排出现时，我盯着看了一会儿：

```
/cat/tools   wallTime 84   cpuTime 5
```

一个页面渲染花了 84 毫秒，其中 CPU 只占 5 毫秒。**94% 的时间在等。** 等什么？等数据库。

这不是 Workers 的问题，是任何"请求-响应"式数据库都有的账：你的代码没事干，它只是在等对面把结果送回来。

## 二、一页 HTML 到底要几次数据库往返

在改成并发之前，`/cat/tools` 这一页在 `injectTheme` 里的取数是这样的（这是改动前的代码，我后来把它原样部署成一个独立 Worker 来做对照，见第四节）：

```js
// 改动前：一个 await 接一个 await
const s = await getSite(env);
body = fillSeo(body, s, url);
// ...
const { body: listed, list } = await renderList(env, body, url); // 里面还有三次
body = await renderCats(env, listed);                            // 里面还有两次
```

拆开数一下往返次数：

| 顺序 | 查询 | 干什么 |
|---|---|---|
| 1 | `getSite()` | 读 `settings` 表拿站名、主题、头像 |
| 2 | `SELECT COUNT(*)` | 算这个栏目一共几篇（分页要用） |
| 3 | 主查询 `SELECT p.*, ...` | 取当页 10 篇 |
| 4 | `attachTags()` | 把这 10 篇的标签一次性捞回来 |
| 5 | `catCounts()` | 四个栏目各几篇 |

五次往返，一次接一次。假设单程 30ms，这一页光"等"就是 150ms 起步。

而 `renderCats()` 里还有第六次（标签云），只有 `/categories` 页才走。首页更惨，多了 `pickPosts()` 那一次，五次。

关键在于：**这五次之间没有任何依赖。** count 不需要 post 列表，标签不需要栏目计数，站点设置更不需要等任何东西。它们只是被写在了五个连续的 `await` 后面，于是排队了。

## 三、改法：把"互不依赖"变成"同时发出"

改动就一处，`injectTheme` 的取数部分：

```js
/* 这一页要的三份数据互不依赖：站点设置、文章列表、栏目/标签计数。
   以前是一个 await 接一个，线上冷启动 cfWorker 跑到 500ms+ 大部分耗在这串行上。
   现在先全部发出去，最慢的那条决定总时长。 */
const siteP = getSite(env);
const catsP = body.includes(''<!--CATS-->'') ? catCounts(env) : Promise.resolve(new Map());
const tagsP = body.includes(''<!--TAGS-->'') ? tagsData(env.DB).catch(() => []) : Promise.resolve(null);
// 列表只依赖模板和 URL，不依赖站点设置，所以这里就能先发车
const listP = listQuery(env, url);

const [s, counts, tags] = await Promise.all([siteP, catsP, tagsP]);
```

注意这里是"先拿到 Promise，再在需要的地方 await"，不是 `await Promise.all([...])` 一把梭。区别在于：`s` 要用来拼 `<head>`，`listP` 的结果要等模板替换完才用得上。先把请求发出去，等真需要数据时再 await，中间那段拼字符串的时间就被利用起来了。

`listPosts` 内部还有一层同样的排队：

```js
/* COUNT 和主查询互不依赖，一起发出去。
   以前是先 await COUNT 再 await 列表，冷启动时两个往返叠加，
   等于把 D1 的延迟翻了一倍。 */
const [{ results }, totalRow] = await Promise.all([
  db.prepare(`SELECT p.*, ${AUTHOR_COLS}, ${TAG_AGG}, ... LIMIT ? OFFSET ?`).bind(...args, size, offset).all(),
  db.prepare(`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSql}`).bind(...args).first(),
]);
```

### 这里踩了一个不那么显然的坑

第一版我是直接把 `renderList` 整个塞进 `Promise.all` 的，结果页面渲染出来"上半部分正常，列表区一片空白"。原因不是查询失败，而是**顺序**：

`injectTheme` 是一串字符串替换：先换 `<!--THEME-->`、再换 `site-header`、再换 `<!--LIST-->`。如果 `renderList` 在替换还没发生的时候就把 `body` 复制走，它拿到的是一份半成品，返回时又把前面已经替换好的内容整个盖回去。

所以改成了两半：

- `listQuery(env, url)`：只查数据库，不碰 HTML，所以能和别人一起并发；
- `applyList(body, res)`：纯字符串替换，必须等前面的替换全部做完再跑。

**并发改造的真实难点不是 `Promise.all` 怎么写，是"哪一段是纯取数、哪一段必须按顺序"。** 把有副作用的字符串处理也塞进去，就会出现"能跑但内容是旧的"这种最难查的 bug。

### 标签那一次不是并发，是"少一次"

标签原本是第二次往返：先查 10 篇文章，再用 `post_id IN (?,?,...)` 捞标签。这次直接内联进主查询：

```js
/* 标签用相关子查询一次带出，替代「先查 posts 再 attachTags」的第二次往返。
   char(31) 是 US（unit separator），标签名里不可能出现，拿来当分隔符比逗号安全 —— 标签本身允许逗号。 */
const TAG_AGG = `(SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str`;
const splitTagStr = (s) => (s ? String(s).split(''\u001f'').filter(Boolean) : []);
```

这一条和 `Promise.all` 是两种不同性质的动作，很容易混为一谈：

- `Promise.all`：往返次数不变，但把等待叠在一起了，省的是**时间**；
- 内联子查询：往返次数少了一次，省的是**次数**（顺带也省时间）。

真到了瓶颈，省次数比省时间更值钱——因为次数有天花板。这一点第六节会说。

### 并发不是免费的：每条都要能自己兜住

`Promise.all` 有个特性：任何一条 reject，整体立刻 reject。首页五条查询里只要有一条 SQL 挂了，整个页面 500。所以每条都单独兜：

```js
const tagsP = body.includes(''<!--TAGS-->'') ? tagsData(env.DB).catch(() => []) : Promise.resolve(null);
```

`catCounts` 里有 `try/catch` 返回空 Map，`listQuery` 里有 `try/catch` 返回 `data: null`（然后渲染骨架），`getSite` 里有 `try/catch` 回退到环境变量。**并发写法把"一个查询失败"从"一个区块空白"升级成了"整页白屏"**，兜底必须补在这之前。

## 四、A/B 怎么做的：把旧代码部署成另一个 Worker

只对比"改之前记得的数字"和"改之后现在的数字"是没有说服力的——中间还隔着 3 天、一次 CF 侧变更、几十次部署。

所以做了个真对照：

1. `git worktree add /tmp/blog-old 8e29df2`，检出并发改造的**父提交**；
2. 复制一份 `wrangler.jsonc`，只把 `name` 改成 `exia-blog-perf-old`，去掉 `triggers`（别让两个 Worker 都去跑友链巡检）；
3. `wrangler deploy -c wrangler.perfold.jsonc` —— 独立 Worker，绑同一个 D1、同一份静态资源，**线上流量一点不受影响**；
4. 两个终端同时 `wrangler tail --format json`，然后**交替**发请求：先打旧版一次，再打新版一次，循环 10 轮。

交替发是为了抵消时间漂移（CF 边缘的负载、我这条线路的抖动，都会随时间变）。10 轮下来取中位数：

| 页面 | 串行（旧） | 并发（新） | 差 |
|---|---|---|---|
| `/cat/tools` | 180ms | **84ms** | −96 |
| `/tag/cloudflare` | 207ms | **148ms** | −59 |
| `/archive` | 175ms | 170ms | −5 |
| `/p/comment-anti-spam` | 115ms | 117ms | ±0 |

同一轮里 CPU 时间是：旧版 5、5、6、7ms，新版 5、6、7、9ms。**两版一样。**

这就是这次改动最干净的一句总结：

> 并发没有让任何一行代码变快，CPU 一毫秒都没省。省下来的 96ms，是三次往返的等待被叠到了一起。

TTFB 那边（21 次采样取中位数，减去静态地板）也对得上：

| 页面 | 串行 | 并发 | 差 |
|---|---|---|---|
| 首页 | 200ms（272 − 72） | 80ms（149 − 69） | −120 |
| `/cat/tools` | 168ms（240 − 72） | 66ms（135 − 69） | −102 |
| `/archive` | 189ms | 157ms | −32 |
| 文章页 | 128ms | 111ms | −17 |

首页省得最多（120ms），因为它原本有五次往返要排：站点设置、COUNT、主查询、标签、精选位。

## 五、为什么省下的不是"SQL 时间"

这里有个反直觉的点，值得单独说：**并发查询并不会让 D1 查得更快。**

D1 的文档写得很直白：

> Each individual D1 database is inherently single-threaded, and processes queries one at a time.

单个库是单线程的，查询是一条一条处理的。你并发发五条过去，它们还是排队执行，只是队伍在**对面**排，不在你这边排。

那省下来的 96ms 是什么？是**每条查询的固定开销**——建请求、走网络、序列化结果、回来。这部分是纯等待，跟数据库在不在忙没关系。

所以可以反推单次往返的成本：96ms ÷ 3 次 ≈ **32ms**。再用一个只发一次往返的接口验证：

```bash
curl -s -o /dev/null -w "%{time_starttransfer}\n" "https://exia.de5.net/api/posts?page=1&size=1&z=$RANDOM"
```

`/api/posts` 里是两条并发查询（列表 + COUNT）+ 一点点 JSON 序列化：

```
/api/posts   wallTime 51   cpuTime 2
```

51ms 里 CPU 占 2ms，剩下 49ms 就是"一次往返 + 出结果"。和反推的 32ms 一个量级（这个接口结果集更小、但含 TLS 之后的额外开销），对得上。

**推论：并发数不是越多越好。** D1 每个 Worker 调用最多同时开 6 条连接，超过就排到下一批。把 20 条查询塞进 `Promise.all`，第 7 条开始照样等，只是你看不见。真要压次数，该用的是 `db.batch()`——多条语句一次请求，把"每次请求的固定开销"付一遍。

我们这个站点的量级（一页 5 次往返、16 篇文章）还犯不上上 batch，但知道这条线在哪，比"能并发就并发"有用。

## 六、两个页面纹丝不动，这才是最有信息量的部分

看第四节的表：`/archive` 只省了 5ms，文章页 ±0。

不是并发没用，是**这两个页面压根不在那个 `Promise.all` 里**。那次提交只动了列表页那条链（`renderList` / `renderCats`），归档页和文章页的取数代码一行没改，自然一动不动。

文章页当时的顺序是这样：

```js
const post = await env.DB.prepare(`SELECT p.*, ... WHERE p.slug = ?`).bind(slug).first();      // D1 第 1 次
const tpl = await assetText(env, request, ''/post'');                                            // 模板走 ASSETS，不是 D1
const [{ results: tagRows }, { results: cmtRows }] = await Promise.all([...]);                  // D1 第 2 次，标签与评论已经并发
if (post.series) { /* 系列目录 */ }                                                            // 这篇没有系列归属，不发起
const site = await getSite(env);                                                                // 30 秒进程内缓存，多数请求不落库
```

**我一开始把这段数成了"四次数据库往返"，这是错的。** 数 `await` 不等于数往返：`series` 只有文章属于某个系列时才发，`getSite()` 有 30 秒进程内缓存。对一篇没有系列归属的文章，真实往返是 **2 次**——正文一次，标签与评论一次。

所以 115ms 不是四次排队，是：2 次 D1 往返（按 32ms/次算约 64ms）+ 一次模板读取 + 渲染与响应。

那空间在哪？在**依赖深度**。第 2 次往返之所以不能跟第 1 次合并，是因为要先拿到 `post.id` 才能去查 `post_tags` 和 `comments`。

把关联条件从 id 换成 slug，这几条查询就不再互相等待：

```js
const [post, tagRes, cmtRes, seriesRes, site, tpl] = await Promise.all([
  env.DB.prepare(`... FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`).bind(slug).first(),
  env.DB.prepare(`... JOIN posts p ON p.id = pt.post_id WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`... JOIN posts p ON p.id = c.post_id WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`... WHERE series = (SELECT series FROM posts WHERE slug = ?)`).bind(slug).all(),
  getSite(env),
  assetText(env, request, ''/post''),
]);
```

同一 URL、同样绕开缓存、各取中位：**127ms → 86ms**（p10 79、p90 89）。

这里有个能复用的判断：**并发的单位不是"查询"，是"依赖链"**。同样是这四条 SQL，只把绑定参数的来源从 `post.id` 换成 `slug`，串行就变并行，代码行数几乎没变。

归档页更值得说。它只有两次往返，但照样 170ms，因为第一次查询本身重：

```js
// src/api.js
`SELECT p.*, ${AUTHOR_COLS}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
 FROM posts p ${AUTHOR_JOIN} WHERE ... LIMIT 2000`
```

`p.*` 把正文一起查出来了。这个站当时 14 篇公开文章，正文合计 **79KB**（最长一篇 12KB）。归档页要渲染的只是 14 个标题，却把 79KB 正文全搬了一遍，然后 `attachTags()` 再补一次往返。

改成只取需要的列，阅读时长用 SQL 现算（口径必须和 `readingTime()` 一致，否则归档显示 26 分钟、文章页显示 24 分钟）：

```sql
SELECT p.id, p.slug, p.title, p.summary, p.cover, p.category, p.published_at, p.created_at,
       length(replace(replace(replace(replace(COALESCE(p.content,''''), char(32), ''''), char(10), ''''), char(13), ''''), char(9), '''')) AS content_len
FROM posts p ...
```

实测 **175ms → 159ms**。省得不算多，因为它本来就只有两次往返，减掉的是一次查询里的传输量而不是一次排队。

两条结论：

1. **并发的收益 = 被并发的次数 × 单次往返成本。** 没有 await 可叠的页面，改多少 `Promise.all` 都是 0。
2. **单条慢查询不会因为并发变快。** 归档页 170ms 里能靠并发省的只有一次，剩下的大头是搬了 79KB 不该搬的数据，只能改 SQL。

上面这两处都是后来真做了才有的数字。写第六节初稿时我按"数 await"预估过一个"115ms → 约 70ms"，实际做出来是 86ms——**预估方向对，幅度偏乐观**，因为省掉的那次往返只有 32ms 上下，剩下的是渲染和响应，那部分动不了。

## 七、另一半：`s-maxage` 和 `s-maxage` 之外的那个参数

标题说"改了一件事"，其实同一个提交里还动了一组缓存参数。它和并发是两个完全不同的杠杆，得分开说：

```js
// src/cache.js
- export const EDGE_TTL = 60;
- export const EDGE_SWR = 600;
+ export const EDGE_TTL = 300;
+ export const EDGE_SWR = 86400;
```

**`s-maxage` 拦的是"多久回源一次"。** 60 秒意味着同一个 URL 每分钟最多渲染一次；300 秒意味着每五分钟一次。五个访客在五分钟内打开同一篇文章：改前渲染 5 次，改后 1 次。这不是"变快了"，是"根本没渲染"。

这也是为什么它比并发更便宜：并发把 180 降到 84，缓存把 84 降到 **4**。实测命中路径：

```
/cat/tools   wallTime 4   cpuTime 0
```

Worker 还是跑了（`caches.default` 的命中在 Worker 内部，不是 CF 边缘层），但只花了 4 毫秒——查缓存、返回、结束。CPU 0 毫秒。

**`stale-while-revalidate` 拦的是"过期那一刻的访客"。** 这两个参数经常被当成一回事，其实分工完全不同：

| 参数 | 管什么 | 过期之后 |
|---|---|---|
| `s-maxage=300` | 300 秒内直接用缓存，不回源 | 300 秒一到，缓存"过期" |
| `stale-while-revalidate=86400` | 过期后**一天内**仍然先把旧副本给访客，同时在后台刷新 | 一天之后，才轮到访客真的等一次渲染 |

原来的 `600` 意味着：一个页面只要超过 10 分钟没人访问，下一个访客就得结结实实等一次渲染（84–180ms）。而这个站的实际情况是——大部分文章一天也没几个访客。**`600` 等于对绝大多数页面从来没生效过。** 换成 `86400` 之后，哪怕这篇文昨天被读过、今天第一个访客来，拿到的也是旧副本（几毫秒），刷新在后台进行。

所以这两个数改的方向不一样：`s-maxage` 决定"省多少次渲染"，`swr` 决定"省不省掉过期那一刻的那一次等待"。

### 顺手发现的一处不一致

我们的边缘缓存其实是两层：CF 自己的 HTTP 缓存，和 Worker 里的 `caches.default`。两层的口径没对齐：

```js
export async function edgePut(url, res, ttl) {
  const headers = new Headers(res.headers);
  headers.set(''cache-control'', `public, s-maxage=${ttl}`);   // 这里把 swr 写丢了
  ...
}
```

存进 Worker 缓存的副本只有 `s-maxage`，没有 `stale-while-revalidate`。所以严格说：**`swr=86400` 只对 CF 边缘那一层生效，Worker 内的那层仍是硬 TTL，300 秒一到必须等一次渲染。**

实际影响不大（Worker 那层命中只要 4ms，回源一次也就 84ms），但两套口径不一致这件事本身是个隐患：以后调参数时，你以为改了一处，其实只改了一半。

还有一个实测出来的观察：这套 HTML 现在**只有首页会在 CF 边缘出 `CF-Cache-Status: HIT`**，`/cat/*`、`/p/*`、`/archive` 全是 `DYNAMIC`（没有这个头）。也就是说，实际在兜底的几乎全是 Worker 内那层 `caches.default`。因为这个观察，上面那处不一致就不是"影响不大"了，而是**主力那一层没有 SWR**。

改法是把两个参数都从同一组常量里传，写副本时跟出给浏览器的响应头对齐：

```js
export async function edgePut(url, res, ttl = EDGE_TTL, swr = EDGE_SWR) {
  const headers = new Headers(res.headers);
  headers.set(''cache-control'', `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
  ...
}

export const pageCacheControl = () =>
  `public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`;
```

现在改 `EDGE_TTL` 一处，两层一起变。以前是改了一处、另一处悄悄留着旧值——这类问题不会报错，只会让你在半年后排查"为什么偶尔有一次慢请求"。

这里只对齐了两层。还有更外面的一层：浏览器拿到的 `max-age=0` 到底能不能生效，取决于 zone 上那个会把 HTML 压成 4 小时的 Browser Cache TTL。四层合起来的判断顺序和检查表，整理在[《三层缓存怎么排，才不会被 Cloudflare 改写成 4 小时》](/p/three-layer-cache)。

### 一个不要碰的参数

```js
/* 注意：别加 no-transform。
   实测它会连带关掉 Cloudflare 的 Brotli —— 首页 HTML 从 8KB 涨回 25KB，
   为了挡一个 20KB 的 RUM 脚本反而多传 17KB，这笔账是亏的。 */
```

缓存头和压缩是连着的。`no-transform` 看着无害（"别改我的内容"），实际会把边缘压缩一起关掉。这类参数只能实测，看文档看不出来。

## 八、验收：三条命令，别只看一个数

改性能最容易犯的错是"改完觉得快了"。给三个可复现的检查，顺序是从外到内：

```bash
# 1) 缓存有没有生效：命中时应该是 4ms 级别，且 cache-control 里有 s-maxage=300
curl -s -o /dev/null -D - "https://exia.de5.net/cat/tools" | grep -iE "cache-control|cf-cache-status"

# 2) 未命中的真实渲染成本：TTFB 减静态地板
curl -s -o /dev/null -w "page %{time_starttransfer}\n" "https://exia.de5.net/cat/tools?x=$RANDOM"
curl -s -o /dev/null -w "floor %{time_starttransfer}\n" "https://exia.de5.net/style.css?f=$RANDOM"

# 3) 内部账：wallTime 与 cpuTime 的比值
npx wrangler tail --format json
```

第 3 条最有价值。`wallTime` 高、`cpuTime` 低，说明你在等 I/O，去查往返次数；两个都高，才是代码本身重（渲染、正则、序列化）。**分不清这两件事，就会去优化错的地方**——比如给一个 CPU 只花 5ms 的页面做"减少字符串拼接"。

## 九、回头看，这次改动到底改对了什么

把数字按因果拆开：

| 从 | 到 | 原因 | 能不能靠代码复制 |
|---|---|---|---|
| 549ms | 180ms | 冷 isolate 转热（部署后第一发：建连接、站点设置缓存为空、预编译语句还没热） | 不能。这是平台行为，只能靠"别在冷启动时判断性能" |
| 180ms | 84ms | 五次串行往返 → 一次 | 能。数 `await` 的个数就行 |
| 84ms | 4ms | 缓存命中 | 能，但代价是内容更新的延迟（我们用主动清缓存补上） |

那次提交真正教会我的不是 `Promise.all` 的写法——那个谁都会——而是**怎么判断一页该有几次往返**：

1. 把这页要的数据列出来；
2. 画依赖箭头：谁的结果是谁的输入；
3. 没有箭头指向它的，全部并发；
4. 有箭头指向它的，串行，且放在越后面越好；
5. 能从 SQL 里一次带出来的，别发第二次（`GROUP_CONCAT` 那一条）。

按这个流程数，一页 HTML 的往返次数应该等于**依赖链的深度**，不是查询的条数。`/cat/tools` 的依赖深度是 1，理想值就是 1 次——现在做到了。文章页理论上也是 1（正文取到之后其余全部无关），但当时被「必须先有 id」卡成了 2；把绑定参数换成 slug 之后才真的落到 1 次，86ms。

这个流程有个前提：**只数真正会执行的往返**。`await` 摆在代码里不代表这次请求会走它——它可能在 `if` 里，可能被进程内缓存挡住。我最初数错就是因为没区分这两件事。

至于标题里那个 549 → 96：数字是真的，但它跨了两个实验。写成"我只改了一件事"会让人以为并发能省 450ms，然后照着做一遍发现只省了 90ms，最后得出"网上文章都是假的"的结论。

**一页 CPU 只花 5ms、却要 180ms 才吐出来，问题一定不在你的代码里，在你等的那几次网络里。** 先把 `await` 的个数数清楚，再谈优化。

同一年在断言上也遇到一次「两个实验混成一个结论」：原文清单被别人再去重、扫描器少算 31 条规则，两个消费者都还绿。判据不能挂在自己要检验的那步转换的产物上——那次逐层注入的记录写在[接口说成功，业务其实没通](/p/success-but-not-through)。
', html_content = '<p>11-09 那天部署完，我抓到的第一条 <code>Server-Timing</code> 是 <code>cfWorker;dur=549</code>，同一个版本另一个页面是 <code>752</code>。今天同一个栏目页 <code>/cat/tools</code>，同样的探针，<code>84</code> 到 <code>96</code>。</p>
<p>数字没造假，但标题这句话是<strong>不严谨</strong>的。549 和 96 之间隔着两个变量：一个是冷启动转热，一个才是代码改动。把这俩混在一起说&quot;我只改了一件事就把 549 变成 96&quot;，属于拿两个不同实验的结果互相背书。</p>
<p>所以这篇分两半：先把尺子校准，把 549 拆成&quot;冷启动&quot;和&quot;排队&quot;两块钱；再讲那件唯一改对的事——它省下的正好是 96ms，而不是 450ms。</p>
<p>先说结论：</p>
<div class="table-wrap"><table><thead><tr><th>阶段</th><th>/cat/tools 的 Worker 执行时间</th><th>这块是谁的钱</th></tr></thead><tbody><tr><td>11-09 部署后第一发（冷 isolate + 串行查询）</td><td>549ms</td><td>冷启动 ~370 + 排队 ~96 + 渲染十几毫秒</td></tr><tr><td>同版本，预热之后（串行查询）</td><td>180ms</td><td>全是排队</td></tr><tr><td>改动之后（并发查询）</td><td>84ms</td><td>1 次往返 + 5ms CPU</td></tr></tbody></table></div>
<p>真正可以靠写代码省掉的是中间那 96ms。冷启动那块，改代码省不掉。</p>
<h2 id="一-先校准尺子-cfworker-是好尺子-但不是一直有"><a class="h-anchor" href="#一-先校准尺子-cfworker-是好尺子-但不是一直有">#</a>一、先校准尺子：<code>cfWorker</code> 是好尺子，但不是一直有</h2>
<p><code>Server-Timing: cfWorker;dur=549</code> 这个头不是我们写的，是 Cloudflare 加的，意思是&quot;这一发请求在 Worker 里待了 549 毫秒&quot;。它最接近&quot;渲染耗时&quot;这个概念，所以当时我拿它做记录。</p>
<p>问题是它现在在线上抓不到了：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -o /dev/null -D - <span class="tok-s">&quot;https://exia.de5.net/cat/tools?x=$RANDOM&quot;</span> | <span class="tok-k">grep</span> -i server-timing
<span class="tok-c"># 没有输出</span></code></pre></div>
<p>今天同一台 Worker、同一个 URL，这个头不见了。可能是平台侧策略变了，也可能是压缩/缓存路径上被吃掉了。不管原因是什么，结论是：<strong>别把一次性的观察当成长期监控</strong>。你三个月后想复现，得有个不依赖平台施舍的尺子。</p>
<p>这篇里所有数字都用另外两种尺子量，都能自己跑：</p>
<p><strong>尺子 A：TTFB 减静态资源地板。</strong> TTFB 里混着网络往返，直接比会掺水。先量一个静态文件的 TTFB（它由边缘直接吐，不含 Worker 逻辑），这一段就是&quot;网络+边缘&quot;的地板，减掉之后剩下的才是 Worker 的时间。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 地板：静态资源，边缘直接返回</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;%{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/style.css?f=$RANDOM&quot;</span>
<span class="tok-c"># 待测页面，带随机参数强制绕过缓存</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;%{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/cat/tools?x=$RANDOM&quot;</span></code></pre></div>
<p><strong>尺子 B：<code>wrangler tail</code> 的 <code>wallTime</code> / <code>cpuTime</code>。</strong> 这是 Worker 自己报的账，比任何外部探针都准，而且能把&quot;耗时&quot;和&quot;算力&quot;分开：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash">npx wrangler tail --format json
<span class="tok-c"># 每个事件里带 wallTime（墙钟）和 cpuTime（CPU 毫秒）</span></code></pre></div>
<p>第一次看到这两个数并排出现时，我盯着看了一会儿：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">/cat/tools   wallTime 84   cpuTime 5</code></pre></div>
<p>一个页面渲染花了 84 毫秒，其中 CPU 只占 5 毫秒。<strong>94% 的时间在等。</strong> 等什么？等数据库。</p>
<p>这不是 Workers 的问题，是任何&quot;请求-响应&quot;式数据库都有的账：你的代码没事干，它只是在等对面把结果送回来。</p>
<h2 id="二-一页-html-到底要几次数据库往返"><a class="h-anchor" href="#二-一页-html-到底要几次数据库往返">#</a>二、一页 HTML 到底要几次数据库往返</h2>
<p>在改成并发之前，<code>/cat/tools</code> 这一页在 <code>injectTheme</code> 里的取数是这样的（这是改动前的代码，我后来把它原样部署成一个独立 Worker 来做对照，见第四节）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 改动前：一个 await 接一个 await</span>
<span class="tok-k">const</span> s = <span class="tok-k">await</span> <span class="tok-f">getSite</span>(env);
body = <span class="tok-f">fillSeo</span>(body, s, url);
<span class="tok-c">// ...</span>
<span class="tok-k">const</span> { body: listed, list } = <span class="tok-k">await</span> <span class="tok-f">renderList</span>(env, body, url); <span class="tok-c">// 里面还有三次</span>
body = <span class="tok-k">await</span> <span class="tok-f">renderCats</span>(env, listed);                            <span class="tok-c">// 里面还有两次</span></code></pre></div>
<p>拆开数一下往返次数：</p>
<div class="table-wrap"><table><thead><tr><th>顺序</th><th>查询</th><th>干什么</th></tr></thead><tbody><tr><td>1</td><td><code>getSite()</code></td><td>读 <code>settings</code> 表拿站名、主题、头像</td></tr><tr><td>2</td><td><code>SELECT COUNT(*)</code></td><td>算这个栏目一共几篇（分页要用）</td></tr><tr><td>3</td><td>主查询 <code>SELECT p.*, ...</code></td><td>取当页 10 篇</td></tr><tr><td>4</td><td><code>attachTags()</code></td><td>把这 10 篇的标签一次性捞回来</td></tr><tr><td>5</td><td><code>catCounts()</code></td><td>四个栏目各几篇</td></tr></tbody></table></div>
<p>五次往返，一次接一次。假设单程 30ms，这一页光&quot;等&quot;就是 150ms 起步。</p>
<p>而 <code>renderCats()</code> 里还有第六次（标签云），只有 <code>/categories</code> 页才走。首页更惨，多了 <code>pickPosts()</code> 那一次，五次。</p>
<p>关键在于：<strong>这五次之间没有任何依赖。</strong> count 不需要 post 列表，标签不需要栏目计数，站点设置更不需要等任何东西。它们只是被写在了五个连续的 <code>await</code> 后面，于是排队了。</p>
<h2 id="三-改法-把-互不依赖-变成-同时发出"><a class="h-anchor" href="#三-改法-把-互不依赖-变成-同时发出">#</a>三、改法：把&quot;互不依赖&quot;变成&quot;同时发出&quot;</h2>
<p>改动就一处，<code>injectTheme</code> 的取数部分：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 这一页要的三份数据互不依赖：站点设置、文章列表、栏目/标签计数。
   以前是一个 await 接一个，线上冷启动 cfWorker 跑到 500ms+ 大部分耗在这串行上。
   现在先全部发出去，最慢的那条决定总时长。 */</span>
<span class="tok-k">const</span> siteP = <span class="tok-f">getSite</span>(env);
<span class="tok-k">const</span> catsP = body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;&lt;!--CATS--&gt;&#39;</span>) ? <span class="tok-f">catCounts</span>(env) : Promise.<span class="tok-f">resolve</span>(<span class="tok-k">new</span> <span class="tok-f">Map</span>());
<span class="tok-k">const</span> tagsP = body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;&lt;!--TAGS--&gt;&#39;</span>) ? <span class="tok-f">tagsData</span>(env.DB).<span class="tok-k">catch</span>(() =&gt; []) : Promise.<span class="tok-f">resolve</span>(<span class="tok-k">null</span>);
<span class="tok-c">// 列表只依赖模板和 URL，不依赖站点设置，所以这里就能先发车</span>
<span class="tok-k">const</span> listP = <span class="tok-f">listQuery</span>(env, url);

<span class="tok-k">const</span> [s, counts, tags] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([siteP, catsP, tagsP]);</code></pre></div>
<p>注意这里是&quot;先拿到 Promise，再在需要的地方 await&quot;，不是 <code>await Promise.all([...])</code> 一把梭。区别在于：<code>s</code> 要用来拼 <code>&lt;head&gt;</code>，<code>listP</code> 的结果要等模板替换完才用得上。先把请求发出去，等真需要数据时再 await，中间那段拼字符串的时间就被利用起来了。</p>
<p><code>listPosts</code> 内部还有一层同样的排队：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* COUNT 和主查询互不依赖，一起发出去。
   以前是先 await COUNT 再 await 列表，冷启动时两个往返叠加，
   等于把 D1 的延迟翻了一倍。 */</span>
<span class="tok-k">const</span> [{ results }, totalRow] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([
  db.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT p.*, ${AUTHOR_COLS}, ${TAG_AGG}, ... LIMIT ? OFFSET ?`</span>).<span class="tok-f">bind</span>(...args, size, offset).<span class="tok-f">all</span>(),
  db.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSql}`</span>).<span class="tok-f">bind</span>(...args).<span class="tok-f">first</span>(),
]);</code></pre></div>
<h3 id="这里踩了一个不那么显然的坑"><a class="h-anchor" href="#这里踩了一个不那么显然的坑">#</a>这里踩了一个不那么显然的坑</h3>
<p>第一版我是直接把 <code>renderList</code> 整个塞进 <code>Promise.all</code> 的，结果页面渲染出来&quot;上半部分正常，列表区一片空白&quot;。原因不是查询失败，而是<strong>顺序</strong>：</p>
<p><code>injectTheme</code> 是一串字符串替换：先换 <code>&lt;!--THEME--&gt;</code>、再换 <code>site-header</code>、再换 <code>&lt;!--LIST--&gt;</code>。如果 <code>renderList</code> 在替换还没发生的时候就把 <code>body</code> 复制走，它拿到的是一份半成品，返回时又把前面已经替换好的内容整个盖回去。</p>
<p>所以改成了两半：</p>
<ul><li><code>listQuery(env, url)</code>：只查数据库，不碰 HTML，所以能和别人一起并发；</li><li><code>applyList(body, res)</code>：纯字符串替换，必须等前面的替换全部做完再跑。</li></ul>
<p><strong>并发改造的真实难点不是 <code>Promise.all</code> 怎么写，是&quot;哪一段是纯取数、哪一段必须按顺序&quot;。</strong> 把有副作用的字符串处理也塞进去，就会出现&quot;能跑但内容是旧的&quot;这种最难查的 bug。</p>
<h3 id="标签那一次不是并发-是-少一次"><a class="h-anchor" href="#标签那一次不是并发-是-少一次">#</a>标签那一次不是并发，是&quot;少一次&quot;</h3>
<p>标签原本是第二次往返：先查 10 篇文章，再用 <code>post_id IN (?,?,...)</code> 捞标签。这次直接内联进主查询：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 标签用相关子查询一次带出，替代「先查 posts 再 attachTags」的第二次往返。
   char(31) 是 US（unit separator），标签名里不可能出现，拿来当分隔符比逗号安全 —— 标签本身允许逗号。 */</span>
<span class="tok-k">const</span> TAG_AGG = <span class="tok-s">`(SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str`</span>;
<span class="tok-k">const</span> splitTagStr = (s) =&gt; (s ? <span class="tok-f">String</span>(s).<span class="tok-f">split</span>(<span class="tok-s">&#39;\u001f&#39;</span>).<span class="tok-f">filter</span>(Boolean) : []);</code></pre></div>
<p>这一条和 <code>Promise.all</code> 是两种不同性质的动作，很容易混为一谈：</p>
<ul><li><code>Promise.all</code>：往返次数不变，但把等待叠在一起了，省的是<strong>时间</strong>；</li><li>内联子查询：往返次数少了一次，省的是<strong>次数</strong>（顺带也省时间）。</li></ul>
<p>真到了瓶颈，省次数比省时间更值钱——因为次数有天花板。这一点第六节会说。</p>
<h3 id="并发不是免费的-每条都要能自己兜住"><a class="h-anchor" href="#并发不是免费的-每条都要能自己兜住">#</a>并发不是免费的：每条都要能自己兜住</h3>
<p><code>Promise.all</code> 有个特性：任何一条 reject，整体立刻 reject。首页五条查询里只要有一条 SQL 挂了，整个页面 500。所以每条都单独兜：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> tagsP = body.<span class="tok-f">includes</span>(<span class="tok-s">&#39;&lt;!--TAGS--&gt;&#39;</span>) ? <span class="tok-f">tagsData</span>(env.DB).<span class="tok-k">catch</span>(() =&gt; []) : Promise.<span class="tok-f">resolve</span>(<span class="tok-k">null</span>);</code></pre></div>
<p><code>catCounts</code> 里有 <code>try/catch</code> 返回空 Map，<code>listQuery</code> 里有 <code>try/catch</code> 返回 <code>data: null</code>（然后渲染骨架），<code>getSite</code> 里有 <code>try/catch</code> 回退到环境变量。<strong>并发写法把&quot;一个查询失败&quot;从&quot;一个区块空白&quot;升级成了&quot;整页白屏&quot;</strong>，兜底必须补在这之前。</p>
<h2 id="四-a-b-怎么做的-把旧代码部署成另一个-worker"><a class="h-anchor" href="#四-a-b-怎么做的-把旧代码部署成另一个-worker">#</a>四、A/B 怎么做的：把旧代码部署成另一个 Worker</h2>
<p>只对比&quot;改之前记得的数字&quot;和&quot;改之后现在的数字&quot;是没有说服力的——中间还隔着 3 天、一次 CF 侧变更、几十次部署。</p>
<p>所以做了个真对照：</p>
<ol><li><code>git worktree add /tmp/blog-old 8e29df2</code>，检出并发改造的<strong>父提交</strong>；</li><li>复制一份 <code>wrangler.jsonc</code>，只把 <code>name</code> 改成 <code>exia-blog-perf-old</code>，去掉 <code>triggers</code>（别让两个 Worker 都去跑友链巡检）；</li><li><code>wrangler deploy -c wrangler.perfold.jsonc</code> —— 独立 Worker，绑同一个 D1、同一份静态资源，<strong>线上流量一点不受影响</strong>；</li><li>两个终端同时 <code>wrangler tail --format json</code>，然后<strong>交替</strong>发请求：先打旧版一次，再打新版一次，循环 10 轮。</li></ol>
<p>交替发是为了抵消时间漂移（CF 边缘的负载、我这条线路的抖动，都会随时间变）。10 轮下来取中位数：</p>
<div class="table-wrap"><table><thead><tr><th>页面</th><th>串行（旧）</th><th>并发（新）</th><th>差</th></tr></thead><tbody><tr><td><code>/cat/tools</code></td><td>180ms</td><td><strong>84ms</strong></td><td>−96</td></tr><tr><td><code>/tag/cloudflare</code></td><td>207ms</td><td><strong>148ms</strong></td><td>−59</td></tr><tr><td><code>/archive</code></td><td>175ms</td><td>170ms</td><td>−5</td></tr><tr><td><code>/p/comment-anti-spam</code></td><td>115ms</td><td>117ms</td><td>±0</td></tr></tbody></table></div>
<p>同一轮里 CPU 时间是：旧版 5、5、6、7ms，新版 5、6、7、9ms。<strong>两版一样。</strong></p>
<p>这就是这次改动最干净的一句总结：</p>
<blockquote><p>并发没有让任何一行代码变快，CPU 一毫秒都没省。省下来的 96ms，是三次往返的等待被叠到了一起。</p></blockquote>
<p>TTFB 那边（21 次采样取中位数，减去静态地板）也对得上：</p>
<div class="table-wrap"><table><thead><tr><th>页面</th><th>串行</th><th>并发</th><th>差</th></tr></thead><tbody><tr><td>首页</td><td>200ms（272 − 72）</td><td>80ms（149 − 69）</td><td>−120</td></tr><tr><td><code>/cat/tools</code></td><td>168ms（240 − 72）</td><td>66ms（135 − 69）</td><td>−102</td></tr><tr><td><code>/archive</code></td><td>189ms</td><td>157ms</td><td>−32</td></tr><tr><td>文章页</td><td>128ms</td><td>111ms</td><td>−17</td></tr></tbody></table></div>
<p>首页省得最多（120ms），因为它原本有五次往返要排：站点设置、COUNT、主查询、标签、精选位。</p>
<h2 id="五-为什么省下的不是-sql-时间"><a class="h-anchor" href="#五-为什么省下的不是-sql-时间">#</a>五、为什么省下的不是&quot;SQL 时间&quot;</h2>
<p>这里有个反直觉的点，值得单独说：<strong>并发查询并不会让 D1 查得更快。</strong></p>
<p>D1 的文档写得很直白：</p>
<blockquote><p>Each individual D1 database is inherently single-threaded, and processes queries one at a time.</p></blockquote>
<p>单个库是单线程的，查询是一条一条处理的。你并发发五条过去，它们还是排队执行，只是队伍在<strong>对面</strong>排，不在你这边排。</p>
<p>那省下来的 96ms 是什么？是<strong>每条查询的固定开销</strong>——建请求、走网络、序列化结果、回来。这部分是纯等待，跟数据库在不在忙没关系。</p>
<p>所以可以反推单次往返的成本：96ms ÷ 3 次 ≈ <strong>32ms</strong>。再用一个只发一次往返的接口验证：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;%{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/api/posts?page=1&amp;size=1&amp;z=$RANDOM&quot;</span></code></pre></div>
<p><code>/api/posts</code> 里是两条并发查询（列表 + COUNT）+ 一点点 JSON 序列化：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">/api/posts   wallTime 51   cpuTime 2</code></pre></div>
<p>51ms 里 CPU 占 2ms，剩下 49ms 就是&quot;一次往返 + 出结果&quot;。和反推的 32ms 一个量级（这个接口结果集更小、但含 TLS 之后的额外开销），对得上。</p>
<p><strong>推论：并发数不是越多越好。</strong> D1 每个 Worker 调用最多同时开 6 条连接，超过就排到下一批。把 20 条查询塞进 <code>Promise.all</code>，第 7 条开始照样等，只是你看不见。真要压次数，该用的是 <code>db.batch()</code>——多条语句一次请求，把&quot;每次请求的固定开销&quot;付一遍。</p>
<p>我们这个站点的量级（一页 5 次往返、16 篇文章）还犯不上上 batch，但知道这条线在哪，比&quot;能并发就并发&quot;有用。</p>
<h2 id="六-两个页面纹丝不动-这才是最有信息量的部分"><a class="h-anchor" href="#六-两个页面纹丝不动-这才是最有信息量的部分">#</a>六、两个页面纹丝不动，这才是最有信息量的部分</h2>
<p>看第四节的表：<code>/archive</code> 只省了 5ms，文章页 ±0。</p>
<p>不是并发没用，是<strong>这两个页面压根不在那个 <code>Promise.all</code> 里</strong>。那次提交只动了列表页那条链（<code>renderList</code> / <code>renderCats</code>），归档页和文章页的取数代码一行没改，自然一动不动。</p>
<p>文章页当时的顺序是这样：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> post = <span class="tok-k">await</span> env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`SELECT p.*, ... WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">first</span>();      <span class="tok-c">// D1 第 1 次</span>
<span class="tok-k">const</span> tpl = <span class="tok-k">await</span> <span class="tok-f">assetText</span>(env, request, <span class="tok-s">&#39;/post&#39;</span>);                                            <span class="tok-c">// 模板走 ASSETS，不是 D1</span>
<span class="tok-k">const</span> [{ results: tagRows }, { results: cmtRows }] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([...]);                  <span class="tok-c">// D1 第 2 次，标签与评论已经并发</span>
<span class="tok-k">if</span> (post.series) { <span class="tok-c">/* 系列目录 */</span> }                                                            <span class="tok-c">// 这篇没有系列归属，不发起</span>
<span class="tok-k">const</span> site = <span class="tok-k">await</span> <span class="tok-f">getSite</span>(env);                                                                <span class="tok-c">// 30 秒进程内缓存，多数请求不落库</span></code></pre></div>
<p><strong>我一开始把这段数成了&quot;四次数据库往返&quot;，这是错的。</strong> 数 <code>await</code> 不等于数往返：<code>series</code> 只有文章属于某个系列时才发，<code>getSite()</code> 有 30 秒进程内缓存。对一篇没有系列归属的文章，真实往返是 <strong>2 次</strong>——正文一次，标签与评论一次。</p>
<p>所以 115ms 不是四次排队，是：2 次 D1 往返（按 32ms/次算约 64ms）+ 一次模板读取 + 渲染与响应。</p>
<p>那空间在哪？在<strong>依赖深度</strong>。第 2 次往返之所以不能跟第 1 次合并，是因为要先拿到 <code>post.id</code> 才能去查 <code>post_tags</code> 和 <code>comments</code>。</p>
<p>把关联条件从 id 换成 slug，这几条查询就不再互相等待：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> [post, tagRes, cmtRes, seriesRes, site, tpl] = <span class="tok-k">await</span> Promise.<span class="tok-f">all</span>([
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">first</span>(),
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... JOIN posts p ON p.id = pt.post_id WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">all</span>(),
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... JOIN posts p ON p.id = c.post_id WHERE p.slug = ?`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">all</span>(),
  env.DB.<span class="tok-f">prepare</span>(<span class="tok-s">`... WHERE series = (SELECT series FROM posts WHERE slug = ?)`</span>).<span class="tok-f">bind</span>(slug).<span class="tok-f">all</span>(),
  <span class="tok-f">getSite</span>(env),
  <span class="tok-f">assetText</span>(env, request, <span class="tok-s">&#39;/post&#39;</span>),
]);</code></pre></div>
<p>同一 URL、同样绕开缓存、各取中位：<strong>127ms → 86ms</strong>（p10 79、p90 89）。</p>
<p>这里有个能复用的判断：<strong>并发的单位不是&quot;查询&quot;，是&quot;依赖链&quot;</strong>。同样是这四条 SQL，只把绑定参数的来源从 <code>post.id</code> 换成 <code>slug</code>，串行就变并行，代码行数几乎没变。</p>
<p>归档页更值得说。它只有两次往返，但照样 170ms，因为第一次查询本身重：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/api.js</span>
<span class="tok-s">`SELECT p.*, ${AUTHOR_COLS}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
 FROM posts p ${AUTHOR_JOIN} WHERE ... LIMIT 2000`</span></code></pre></div>
<p><code>p.*</code> 把正文一起查出来了。这个站当时 14 篇公开文章，正文合计 <strong>79KB</strong>（最长一篇 12KB）。归档页要渲染的只是 14 个标题，却把 79KB 正文全搬了一遍，然后 <code>attachTags()</code> 再补一次往返。</p>
<p>改成只取需要的列，阅读时长用 SQL 现算（口径必须和 <code>readingTime()</code> 一致，否则归档显示 26 分钟、文章页显示 24 分钟）：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">SELECT p.id, p.slug, p.title, p.summary, p.cover, p.category, p.published_at, p.created_at,
       <span class="tok-f">length</span>(<span class="tok-f">replace</span>(<span class="tok-f">replace</span>(<span class="tok-f">replace</span>(<span class="tok-f">replace</span>(<span class="tok-f">COALESCE</span>(p.content,<span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">32</span>), <span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">10</span>), <span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">13</span>), <span class="tok-s">&#39;&#39;</span>), <span class="tok-f">char</span>(<span class="tok-n">9</span>), <span class="tok-s">&#39;&#39;</span>)) AS content_len
FROM posts p ...</code></pre></div>
<p>实测 <strong>175ms → 159ms</strong>。省得不算多，因为它本来就只有两次往返，减掉的是一次查询里的传输量而不是一次排队。</p>
<p>两条结论：</p>
<ol><li><strong>并发的收益 = 被并发的次数 × 单次往返成本。</strong> 没有 await 可叠的页面，改多少 <code>Promise.all</code> 都是 0。</li><li><strong>单条慢查询不会因为并发变快。</strong> 归档页 170ms 里能靠并发省的只有一次，剩下的大头是搬了 79KB 不该搬的数据，只能改 SQL。</li></ol>
<p>上面这两处都是后来真做了才有的数字。写第六节初稿时我按&quot;数 await&quot;预估过一个&quot;115ms → 约 70ms&quot;，实际做出来是 86ms——<strong>预估方向对，幅度偏乐观</strong>，因为省掉的那次往返只有 32ms 上下，剩下的是渲染和响应，那部分动不了。</p>
<h2 id="七-另一半-s-maxage-和-s-maxage-之外的那个参数"><a class="h-anchor" href="#七-另一半-s-maxage-和-s-maxage-之外的那个参数">#</a>七、另一半：<code>s-maxage</code> 和 <code>s-maxage</code> 之外的那个参数</h2>
<p>标题说&quot;改了一件事&quot;，其实同一个提交里还动了一组缓存参数。它和并发是两个完全不同的杠杆，得分开说：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// src/cache.js</span>
- <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_TTL = <span class="tok-n">60</span>;
- <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_SWR = <span class="tok-n">600</span>;
+ <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_TTL = <span class="tok-n">300</span>;
+ <span class="tok-k">export</span> <span class="tok-k">const</span> EDGE_SWR = <span class="tok-n">86400</span>;</code></pre></div>
<p><strong><code>s-maxage</code> 拦的是&quot;多久回源一次&quot;。</strong> 60 秒意味着同一个 URL 每分钟最多渲染一次；300 秒意味着每五分钟一次。五个访客在五分钟内打开同一篇文章：改前渲染 5 次，改后 1 次。这不是&quot;变快了&quot;，是&quot;根本没渲染&quot;。</p>
<p>这也是为什么它比并发更便宜：并发把 180 降到 84，缓存把 84 降到 <strong>4</strong>。实测命中路径：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">/cat/tools   wallTime 4   cpuTime 0</code></pre></div>
<p>Worker 还是跑了（<code>caches.default</code> 的命中在 Worker 内部，不是 CF 边缘层），但只花了 4 毫秒——查缓存、返回、结束。CPU 0 毫秒。</p>
<p><strong><code>stale-while-revalidate</code> 拦的是&quot;过期那一刻的访客&quot;。</strong> 这两个参数经常被当成一回事，其实分工完全不同：</p>
<div class="table-wrap"><table><thead><tr><th>参数</th><th>管什么</th><th>过期之后</th></tr></thead><tbody><tr><td><code>s-maxage=300</code></td><td>300 秒内直接用缓存，不回源</td><td>300 秒一到，缓存&quot;过期&quot;</td></tr><tr><td><code>stale-while-revalidate=86400</code></td><td>过期后<strong>一天内</strong>仍然先把旧副本给访客，同时在后台刷新</td><td>一天之后，才轮到访客真的等一次渲染</td></tr></tbody></table></div>
<p>原来的 <code>600</code> 意味着：一个页面只要超过 10 分钟没人访问，下一个访客就得结结实实等一次渲染（84–180ms）。而这个站的实际情况是——大部分文章一天也没几个访客。<strong><code>600</code> 等于对绝大多数页面从来没生效过。</strong> 换成 <code>86400</code> 之后，哪怕这篇文昨天被读过、今天第一个访客来，拿到的也是旧副本（几毫秒），刷新在后台进行。</p>
<p>所以这两个数改的方向不一样：<code>s-maxage</code> 决定&quot;省多少次渲染&quot;，<code>swr</code> 决定&quot;省不省掉过期那一刻的那一次等待&quot;。</p>
<h3 id="顺手发现的一处不一致"><a class="h-anchor" href="#顺手发现的一处不一致">#</a>顺手发现的一处不一致</h3>
<p>我们的边缘缓存其实是两层：CF 自己的 HTTP 缓存，和 Worker 里的 <code>caches.default</code>。两层的口径没对齐：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">edgePut</span>(url, res, ttl) {
  <span class="tok-k">const</span> headers = <span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers);
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, <span class="tok-s">`public, s-maxage=${ttl}`</span>);   <span class="tok-c">// 这里把 swr 写丢了</span>
  ...
}</code></pre></div>
<p>存进 Worker 缓存的副本只有 <code>s-maxage</code>，没有 <code>stale-while-revalidate</code>。所以严格说：<strong><code>swr=86400</code> 只对 CF 边缘那一层生效，Worker 内的那层仍是硬 TTL，300 秒一到必须等一次渲染。</strong></p>
<p>实际影响不大（Worker 那层命中只要 4ms，回源一次也就 84ms），但两套口径不一致这件事本身是个隐患：以后调参数时，你以为改了一处，其实只改了一半。</p>
<p>还有一个实测出来的观察：这套 HTML 现在<strong>只有首页会在 CF 边缘出 <code>CF-Cache-Status: HIT</code></strong>，<code>/cat/*</code>、<code>/p/*</code>、<code>/archive</code> 全是 <code>DYNAMIC</code>（没有这个头）。也就是说，实际在兜底的几乎全是 Worker 内那层 <code>caches.default</code>。因为这个观察，上面那处不一致就不是&quot;影响不大&quot;了，而是<strong>主力那一层没有 SWR</strong>。</p>
<p>改法是把两个参数都从同一组常量里传，写副本时跟出给浏览器的响应头对齐：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">export</span> <span class="tok-k">async</span> <span class="tok-k">function</span> <span class="tok-f">edgePut</span>(url, res, ttl = EDGE_TTL, swr = EDGE_SWR) {
  <span class="tok-k">const</span> headers = <span class="tok-k">new</span> <span class="tok-f">Headers</span>(res.headers);
  headers.<span class="tok-k">set</span>(<span class="tok-s">&#39;cache-control&#39;</span>, <span class="tok-s">`public, s-maxage=${ttl}, stale-while-revalidate=${swr}`</span>);
  ...
}

<span class="tok-k">export</span> <span class="tok-k">const</span> pageCacheControl = () =&gt;
  <span class="tok-s">`public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`</span>;</code></pre></div>
<p>现在改 <code>EDGE_TTL</code> 一处，两层一起变。以前是改了一处、另一处悄悄留着旧值——这类问题不会报错，只会让你在半年后排查&quot;为什么偶尔有一次慢请求&quot;。</p>
<p>这里只对齐了两层。还有更外面的一层：浏览器拿到的 <code>max-age=0</code> 到底能不能生效，取决于 zone 上那个会把 HTML 压成 4 小时的 Browser Cache TTL。四层合起来的判断顺序和检查表，整理在<a href="/p/three-layer-cache">《三层缓存怎么排，才不会被 Cloudflare 改写成 4 小时》</a>。</p>
<h3 id="一个不要碰的参数"><a class="h-anchor" href="#一个不要碰的参数">#</a>一个不要碰的参数</h3>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 注意：别加 no-transform。
   实测它会连带关掉 Cloudflare 的 Brotli —— 首页 HTML 从 8KB 涨回 25KB，
   为了挡一个 20KB 的 RUM 脚本反而多传 17KB，这笔账是亏的。 */</span></code></pre></div>
<p>缓存头和压缩是连着的。<code>no-transform</code> 看着无害（&quot;别改我的内容&quot;），实际会把边缘压缩一起关掉。这类参数只能实测，看文档看不出来。</p>
<h2 id="八-验收-三条命令-别只看一个数"><a class="h-anchor" href="#八-验收-三条命令-别只看一个数">#</a>八、验收：三条命令，别只看一个数</h2>
<p>改性能最容易犯的错是&quot;改完觉得快了&quot;。给三个可复现的检查，顺序是从外到内：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1) 缓存有没有生效：命中时应该是 4ms 级别，且 cache-control 里有 s-maxage=300</span>
<span class="tok-k">curl</span> -s -o /dev/null -D - <span class="tok-s">&quot;https://exia.de5.net/cat/tools&quot;</span> | <span class="tok-k">grep</span> -iE <span class="tok-s">&quot;cache-control|cf-cache-status&quot;</span>

<span class="tok-c"># 2) 未命中的真实渲染成本：TTFB 减静态地板</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;page %{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/cat/tools?x=$RANDOM&quot;</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&quot;floor %{time_starttransfer}\n&quot;</span> <span class="tok-s">&quot;https://exia.de5.net/style.css?f=$RANDOM&quot;</span>

<span class="tok-c"># 3) 内部账：wallTime 与 cpuTime 的比值</span>
npx wrangler tail --format json</code></pre></div>
<p>第 3 条最有价值。<code>wallTime</code> 高、<code>cpuTime</code> 低，说明你在等 I/O，去查往返次数；两个都高，才是代码本身重（渲染、正则、序列化）。<strong>分不清这两件事，就会去优化错的地方</strong>——比如给一个 CPU 只花 5ms 的页面做&quot;减少字符串拼接&quot;。</p>
<h2 id="九-回头看-这次改动到底改对了什么"><a class="h-anchor" href="#九-回头看-这次改动到底改对了什么">#</a>九、回头看，这次改动到底改对了什么</h2>
<p>把数字按因果拆开：</p>
<div class="table-wrap"><table><thead><tr><th>从</th><th>到</th><th>原因</th><th>能不能靠代码复制</th></tr></thead><tbody><tr><td>549ms</td><td>180ms</td><td>冷 isolate 转热（部署后第一发：建连接、站点设置缓存为空、预编译语句还没热）</td><td>不能。这是平台行为，只能靠&quot;别在冷启动时判断性能&quot;</td></tr><tr><td>180ms</td><td>84ms</td><td>五次串行往返 → 一次</td><td>能。数 <code>await</code> 的个数就行</td></tr><tr><td>84ms</td><td>4ms</td><td>缓存命中</td><td>能，但代价是内容更新的延迟（我们用主动清缓存补上）</td></tr></tbody></table></div>
<p>那次提交真正教会我的不是 <code>Promise.all</code> 的写法——那个谁都会——而是<strong>怎么判断一页该有几次往返</strong>：</p>
<ol><li>把这页要的数据列出来；</li><li>画依赖箭头：谁的结果是谁的输入；</li><li>没有箭头指向它的，全部并发；</li><li>有箭头指向它的，串行，且放在越后面越好；</li><li>能从 SQL 里一次带出来的，别发第二次（<code>GROUP_CONCAT</code> 那一条）。</li></ol>
<p>按这个流程数，一页 HTML 的往返次数应该等于<strong>依赖链的深度</strong>，不是查询的条数。<code>/cat/tools</code> 的依赖深度是 1，理想值就是 1 次——现在做到了。文章页理论上也是 1（正文取到之后其余全部无关），但当时被「必须先有 id」卡成了 2；把绑定参数换成 slug 之后才真的落到 1 次，86ms。</p>
<p>这个流程有个前提：<strong>只数真正会执行的往返</strong>。<code>await</code> 摆在代码里不代表这次请求会走它——它可能在 <code>if</code> 里，可能被进程内缓存挡住。我最初数错就是因为没区分这两件事。</p>
<p>至于标题里那个 549 → 96：数字是真的，但它跨了两个实验。写成&quot;我只改了一件事&quot;会让人以为并发能省 450ms，然后照着做一遍发现只省了 90ms，最后得出&quot;网上文章都是假的&quot;的结论。</p>
<p><strong>一页 CPU 只花 5ms、却要 180ms 才吐出来，问题一定不在你的代码里，在你等的那几次网络里。</strong> 先把 <code>await</code> 的个数数清楚，再谈优化。</p>
<p>同一年在断言上也遇到一次「两个实验混成一个结论」：原文清单被别人再去重、扫描器少算 31 条规则，两个消费者都还绿。判据不能挂在自己要检验的那步转换的产物上——那次逐层注入的记录写在<a href="/p/success-but-not-through">接口说成功，业务其实没通</a>。</p>', cover_body = '', updated_at = datetime('now')
  WHERE slug = 'worker-render-549-to-96';
