## 结论

Turnstile 测的不是「你是不是机器人」，是**这次请求有没有留下「人类参与过」的证据**：浏览器环境完整不完整、事件轨迹像不像手、执行时序对不对、TLS 指纹和 IP 声誉站在哪一边。它输出一个概率判断，不是一个身份判定。所以「过了 Turnstile」的准确含义是：这一次提交背后，大概率有一个真实浏览器，且在最近五分钟内跑过它的 JS。

token 有三条硬约束，把最省事的那条路堵在第一层：有效期 300 秒、只能兑换一次、绑定 `sitekey` 与域名。把一枚 token 存下来复用，第二次 `siteverify` 回的是 `timeout-or-duplicate`，不是 `success`。很多人以为「缓存一个 token 就能反复用」，这条在协议层面就不成立。

但单次不等于稀缺。在真实浏览器里跑 Playwright，无感模式往往直接就发 token——自动化工具不需要骗过检测，因为它压根没被提问。这不是 Turnstile 的漏洞，是「无感」这个产品决策的必然结果：不打断用户，就只能靠旁证推断，而旁证在完整浏览器里是齐的。

它能拦住的是「没有浏览器」的那一类：`curl`、`fetch` 脚本、改了 UA 的爬虫、重放旧 token、把 `sitekey` 抄到别的域名上。拦不住的是「有浏览器但没人」和「有人但在滥用」。

本站的现状是接好了、没开。`TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET` 都没配，`turnstileMode()` 返回 `off`，`siteverify` 一次都不执行。线上 CSP 里没有 `challenges.cloudflare.com`，页面上 `__SITE__.turnstile` 的值是空串。理由在第八节，不是忘了。

放回三层结构看更清楚：它只是第二层。过得了它，只证明「有一次人类浏览器的参与」，不证明「这条评论该入库」——限流和内容判断必须独立存在，因为它们回答的是另外两个问题。

## 一、它收集的不是答案，是旁证

传统验证码是「出题—作答」，答案对错是硬信号。Turnstile 的无感模式没有题目，所以它拿到的只能是旁证：请求这个页面的浏览器，是不是一个「正常」的浏览器；从这个浏览器到这次提交之间，发生过什么。

旁证大致分五类。环境类的看 `window`、`document`、Canvas、WebGL、`navigator` 上那一串属性齐不齐；行为类的看鼠标和触摸事件有没有轨迹、有没有停顿、有没有抖动；时序类的看从加载到提交隔了多久、期间触发了多少次 `requestAnimationFrame`；网络类的看 TLS 指纹（JA3/JA4）和 HTTP 头顺序；来源类的看 IP 与 ASN，家宽、移动网、机房在这条轴上差得很远。

| 检测维度 | 正常桌面 Chrome | Playwright / Puppeteer 默认 | `curl` |
|---|---|---|---|
| JS 与 DOM | 完整 | 完整（真内核） | 无 |
| `navigator.webdriver` | `false` | `true`（`--disable-blink-features=AutomationControlled` 可改） | 无 |
| UA 里的无头标记 | 无 | 旧版带 `HeadlessChrome`，Chrome 112 起默认不带 | 随便写 |
| `navigator.plugins.length` | 5（都是内置 PDF 相关） | 常见 0 | 无 |
| WebGL renderer | 真实 GPU 型号 | 常见 `SwiftShader` / 软件栈 | 无 |
| 鼠标轨迹 | 数百条 `mousemove`，带抖动与停顿 | `page.click()` 只有落点附近一两条 | 无 |
| 加载到提交的时序 | 秒级，间隔不均匀 | 毫秒级，间隔近乎固定 | 无 |
| TLS 指纹（JA3/JA4） | Chrome 自己的 | 用浏览器内核时相同；用 Node 直连时不同 | curl/OpenSSL，明显不同 |
| IP / ASN | 家宽、移动网 | 常是机房 | 机房 |

表里右两列是公开可自查的差异，我这台机器上能直接跑出来。Turnstile 具体读哪几项、权重怎么给，没有公开文档，所以上面这张表是按「如果我要写一个这样的评分器，我会看什么」推的，属于推断，不是逆出来的清单。这条得说在前面，不然它看起来像一份说明书。

清单里最不稳的一项是 UA。Chrome 112 之后，新版 headless 的默认 UA 已经不带 `HeadlessChrome` 了，靠 UA 判无头的年代基本过去。真正难伪装的是事件轨迹和时序——不是造不出来，是要造得像，成本比加一个启动参数高一个量级。

判定发生在边缘，不在页面里。浏览器里那几百行 JS 只负责收集和上报，签发 token 的是 Cloudflare 那一侧，所以本地改几个 `navigator` 属性、把 `window.turnstile` 改成自己的假对象，都换不来一枚能过 `siteverify` 的字符串——它得由持有私钥的一方签。这一点决定了这层的下限：**伪造 token 的难度等于伪造签名，而不是等于读懂前端代码。** 真正松的地方不在密码学，在「谁有资格去领一枚」。

还有一个经常被混淆的东西：`cf_clearance`。它是 WAF 的 Managed Challenge 发的 cookie，跟 Turnstile 的 token 不是一回事。站点只接 Turnstile 的时候，浏览器里不会出现 `cf_clearance`；看到它，说明这道请求前面还有一层 WAF 在拦。这两层在文章里常被写成一件事，排查时会往错误的方向找。

## 二、token 的三条约束：单次、300 秒、绑站点

前端那个框只是取 token 的容器。安全上唯一有意义的一步在服务端，拿 token 去兑一次：

```js
// src/antispam.js —— 全站唯一一处「这层到底算不算过了」的判断
const form = new FormData();
form.append('secret', secret);
form.append('response', String(token));
if (ip) form.append('remoteip', ip);

const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
  method: 'POST',
  body: form,
});
const d = await r.json();
if (d.success) return { ok: true };
return { ok: false, error: '人机验证没通过，刷新页面再试一次' };
```

这段没做任何额外判断：`d.success` 为真就放行。也就是说，这层的全部安全性来自对面那一个布尔值，而支撑那个布尔值的是三条约束。响应里其实还有几个字段，我们一个都没用：

| 字段 | 本站拿它干什么 | 能推出什么 |
|---|---|---|
| `success` | 唯一的开关 | token 有效、未过期、未被兑换过 |
| `challenge_ts` | 没看 | 挑战发生的时刻，能算出提交比挑战晚了多久 |
| `hostname` | 没看 | 这枚 token 是在哪个域名下签发的 |
| `error-codes` | 没看，也没打日志 | 失败原因，`timeout-or-duplicate` 就是重放或过期 |
| `action` / `cdata` | 没传，所以也没有 | 自定义标签，用来把 token 绑到「哪一次动作」 |

第三行和第五行连起来看，是本篇最想说的一句：我们既没传 `action`，也没传 `cdata`，所以校验端的信息只到「这枚 token 属于 exia.de5.net」，到不了「它属于这次评论提交」。token 绑的是**一次挑战**，不是**一次表单提交**。差别在于：同一枚 token 在 300 秒内只能兑一次，但兑给哪一次 POST，Cloudflare 不知道，我们也没告诉它。

重放这条路怎么堵死的。第一次兑换成功后，这枚 token 在 CF 侧就被标记为已用；第二次拿它去兑，返回 `success: false`，`error-codes` 里是 `timeout-or-duplicate`。超过 300 秒再兑，是同一个错误码——过期与重复在协议里共用一格。这点值得记住：日志里看到这个码，可能是脚本在重放，也可能只是用户把表单开了六分钟才点提交，两种情况的处置完全相反。

域名这条容易被低估。`sitekey` 是公开的，就写在 HTML 里，谁都能抄走。但 widget 只在 `sitekey` 后台登记过的域名下签发 token，抄到别的域名上渲染会直接报错，那是 widget 自己的域名校验，不经过你的代码；就算真签出来了，`hostname` 也对不上。所以「偷 `sitekey` 到自己站上跑，拿 token 打你的接口」走不通。前提是建 `sitekey` 时填的是具体域名，不是能匹配一切的泛域名。

单次不等于稀缺，这是最容易被误读的一条。token 只能兑一次，但签一枚的成本在真浏览器里接近零：widget 会自己刷新，重载一次页面就有一枚新的。所以「单次性」防的是**重放**（一枚用两次），不防**量产**（每次都用一枚新的）。这两种行为在日志里的形态完全不同：重放是同一串 token 出现两次，量产是每次一串不同的 token，每一串都合法。

单次加上 300 秒，合起来是第二层真正的约束力：它让「先囤一批、慢慢用」这条流水线失效。想批量提交，就必须在五分钟的窗口里把每一枚 token 兑掉，兑一枚少一枚；想在窗口外继续，就得重新回到浏览器里领。这不会让量产的代价变高多少（真浏览器领 token 近乎免费），但它把攻击的时间结构从「离线准备、集中投放」压成了「在线实时」，而实时的那部分最容易被限流看见。

我们的实现里还有个细节。`siteverify` 支持 `idempotency_key`，作用是让「网络超时后的重试」不被当成重复兑换。我们没传。后果是：如果这次 `fetch` 超时、代码重试一次，第二次会被判成重复，返回 `timeout-or-duplicate`，然后用户看到「人机验证没通过」——而他什么都没做错。这条没在线上发生过（这层还没开），是按接口语义推的，标为推断。

## 三、无感是默认，点击是例外

Turnstile 有三种形态。`managed`（默认）：多数会话直接过，少数「可疑」会话弹一个 checkbox。`non-interactive`：完全不给交互，跑完检测就发 token。`invisible`：连容器都不渲染，由代码调 `turnstile.execute()` 才发。配置项里那个 `appearance` 还能再细分，`always` 是一直显示，`execute` 是等程序调用，`interaction-only` 是只在需要交互时才把框露出来。

所以「Turnstile 要不要点」不是站点决定的，是评分决定的。同一个站、同一个组件，家里电脑上什么都不用做，机房 IP 上可能就要点一下。用户体感上的随机性，来自这层评分，不是组件抽风。

无感的代价，是没有「答对」这个硬信号。出题式的验证码有个好处：正确答案只有人和足够聪明的模型能给。无感模式把这道题撤了，剩下的全是旁证，而旁证在完整浏览器里天然齐全——包括由自动化驱动起来的完整浏览器。这是产品取舍的直接后果，不是实现缺陷：要么打断所有人，要么接受「像人的自动化」也能过。

钱的部分。一次 `siteverify` 就是一次跨网 HTTPS 往返，按 11-18 那篇量出来的单次往返 41ms 量级推，这层至少是 41~90ms 的墙钟成本，CPU 几乎为 0。这个数没实测，配了 key 之后可以用同一个接口对比 `wallTime` 和 `cpuTime`，方法照抄那篇。要注意的是它加在最贵的路径上：每一条评论提交都要多等一次网络。

token 的有效期从签发那一刻算，不是从提交那一刻算。这个差别在长表单上会变成真实的体验问题：写完一段长评论、切出去查资料、七八分钟回来点发送，手里那枚 token 早就过期了。组件通常会自己换新，但「它什么时候换」与「你读到的是哪一枚」之间有时间差——前端如果把 token 存进变量、提交时直接读变量，就会拿到过期的那个。本站是提交那一刻才调 `getResponse()`，不吃这个亏，代价是每次提交多一次同步读取。刷新时机的细节没测，这里只到推断。

还有一笔不明显的：它是全站唯一的第三方脚本。CSP 要同时放开 `script-src`（`api.js`）、`connect-src`（widget 自己的回调）、`frame-src`（组件是个 iframe）。三个指令少放一个，表现各不相同——少放 `frame-src` 最典型：脚本能加载、能初始化，框里一片空白，控制台报 CSP 违规，而人会先去怀疑 key 配错了。

## 四、拦得住什么

这一节的每一条都能落到具体某一步，而不是「更安全了」。

| 形态 | 卡在哪一步 | 服务端拿到的 |
|---|---|---|
| `curl -X POST` 直接发 JSON | 没有 JS，`turnstile_token` 是空串 | 400，`{"ok":false,"error":"请先完成人机验证"}` |
| Node 里的 `fetch` / `axios` | 同上 | 同上 |
| 只改了 UA 的爬虫 | UA 不参与签发，改它不影响任何一步 | 同上 |
| 存储里翻出来的旧 token | `siteverify` | `success:false`，`timeout-or-duplicate` |
| 从别人页面上抄来的一枚当次 token | `siteverify`（`remoteip` 对不上时更容易暴露） | 视情况，可能 `success:false` |
| 把 `sitekey` 抄到自己域名下 | widget 渲染阶段就失败 | 前端报错，请求根本到不了你 |

这六类的共同点：**要么缺一个能跑 JS 的环境，要么缺一枚当次有效的 token**。这也是这层在表单站上性价比高的原因——绝大多数垃圾提交来自不跑 JS 的填表机，而这类恰好是 Turnstile 最擅长的区间。

「改 UA」那条值得单独说一句。很多人把 UA 当主要防线，实际上它在整条链上只是旁证之一，甚至是最弱的一条。改 UA 不会让 `curl` 长出 `window.turnstile`，也不会让 `body.turnstile_token` 从 `undefined` 变成一串字符。

第五行那个「抄来的一枚当次 token」是本层真正的软边。token 可以被搬运——这正好是下一节的第一条。

## 五、没拦住什么

下面每条只讲原因，不讲做法。知道边界在哪，比知道边界存在有用。

**真实浏览器加自动化驱动。** Playwright 起的是真 Chromium，`window`、`document`、Canvas、WebGL、事件系统全在。无感模式下，这类会话通常直接拿到 token。不是「检测被绕过了」，是「没有检测发生」——它没有可用的异常信号，于是按正常会话处理。市面上所谓「绕过 Turnstile」的方案，绝大多数在能跑浏览器的场景里根本不需要绕过：老老实实把页面加载完，token 自己就来了。`navigator.webdriver` 确实是一个信号（Playwright 默认给 `true`），但它可改，一个启动参数的事；而且它表示的是「可疑」，不是「判定」。把一整层的安全性押在一个布尔属性上，是这类方案最常见的误判。

**人工代过。** 打码平台、远程人工、朋友帮点一下。人过了，就是人过了：token 是真的，`hostname` 是对的，`challenge_ts` 是刚才。Turnstile 能证明「有一个人的浏览器在五分钟内参与了这次挑战」，证明不了「这枚 token 是被谁拿去提交的」，更证明不了「提交的那段文字是人写的」。

这个边界的形状值得看清楚：**token 是可转移的**。它签给浏览器，不签给内容。一个人在 A 机器上过验证，把 token 复制到 B 机器的脚本里，在 300 秒内提交一次，协议上通。我们传了 `remoteip`，这让 CF 有能力比对签发 IP 和兑换 IP——但那是「有能力」，不是「一定拦」，跨 IP 兑换的判定细节我没做过实验，只到推断为止。真要堵这条，得把 token 绑到一次性 nonce 或表单内容摘要，成本比 Turnstile 本身还贵。

**拿到合法 token 之后的行为层滥用。** 一个人一天发 500 条内容正常的评论：每次提交重新拿一枚 token，每枚都合法，每个 `hostname` 都对。Turnstile 没有任何理由拦他——他确实是个人。这是设计边界，不是失败。它回答的问题是「请求从哪来」，不是「这个人今天能说多少话」。

有个变体更常见：内容不正常，但每条都换一枚新 token 的「真人加模板」。这类在 Turnstile 眼里和上面那位没有区别，因为两者的证据集完全一样。

**校验服务自己不可达的时候。** 本站的 `verifyTurnstile` 在 `fetch` 抛错时 `return { ok: true, degraded: true }`，是 fail-open。理由 11-11 那篇写过：外部依赖挂掉时若 fail-closed，等于把评论区的开关交给一个第三方域名的可用性。代价是这条路可以被「打挂校验接口」利用。这条属于设计时就知道的没拦住。

还有一条不算漏洞但会被误读的：Turnstile 不产生任何频率概念。它没有「这个 IP 今天已经验证过几次」这种计数，每次提交都是独立的一次挑战。想让它兼任限流，是在用错工具。

## 六、所以它只是三层里的第二层

三层的分工，一句话一层：

| 层 | 回答的问题 | 过了它意味着 |
|---|---|---|
| 蜜罐 `hp` | 这个表单是被脚本填的吗 | 填表的东西没看见那个框 |
| Turnstile | 这次提交背后有没有人类浏览器 | 有一次人类参与 |
| D1 限额 | 这个来源今天还能花多少 | 还没到额度和间隔 |

单独任何一层都不够。蜜罐过了不代表是人（脚本学一次就知道留空）；Turnstile 过了不代表量不大（真人有的是时间）；限额过了不代表内容干净（限额只数次数，不看内容）。

算一次攻击的成本，差别很直白。只有 Turnstile 的时候，发一条广告的成本是「一枚 token」，在真浏览器里等于 0，所以它能拦住的是「连浏览器都没有」的那批人。加上限额之后，成本变成「每天 10 条、每条间隔 60 秒」，一天要发 50 条就得换 5 个 IP、花掉至少 50 分钟。**让攻击不划算的不是验证，是配额。**

这也是「Turnstile 过了」不能当成「这条评论可以入库」的原因。它只说明第一问的答案是「是」，而入库需要三问都过。把三者合并成一个 `if`，会在某一层失效时把另外两层一起废掉——比如 siteverify 挂了就整体 fail-open 顺带跳过限额，那才是真正的灾难。

反过来说，限额也不能替 Turnstile。限额是事后计数，一个从没来过的 IP 发第一条时，限额永远是放行的；能不能让这条请求到达限额那一层之前就被筛掉，靠的是前面两层。三层是串联，不是三选一。

## 七、免费的那部分，价钱在别处

Turnstile 免费且不限次数，这是它和 reCAPTCHA 最大的差别。代价不在钱上，在「你要接受一个第三方脚本」和「你要接受它的判断粒度」。

| | Turnstile | reCAPTCHA v3 | hCaptcha |
|---|---|---|---|
| 费用 | 免费，不限次数 | 有免费额度，超出按次计费 | 有免费额度，超出按量计费 |
| 是否无感 | 默认无感，可疑会话才要点击 | 全程无感，只回分数 | 默认要勾选，无感在付费档 |
| 返回什么 | 布尔加少量元数据 | `0.0~1.0` 的分数，阈值自己定 | 布尔，企业版另有分数 |
| 数据去向 | 留在 Cloudflare，官方口径不用于广告画像 | 送到 Google | 留在 hCaptcha |
| 对自动化浏览器的宽松度 | 宽：完整浏览器常直接给 token | 宽：给高分，靠站点自己卡阈值 | 相对严：默认要一次交互 |
| 站点侧成本 | 一个脚本加一次跨网校验 | 一个脚本加一次校验，还要定阈值策略 | 一个脚本加一次校验 |

v3 的分数制听着更「细」，实际是把判断责任推回站点：0.5 分是拦还是不拦？大多数站到后来都定了一个拍脑袋的阈值，然后在「误伤真人」和「放过脚本」之间来回调。Turnstile 直接给布尔，等于替你做完了这个取舍，代价是你看不到中间那层信息——出问题时也没法解释「为什么这个人被要求点击」。

数据去向这条对本站是硬约束。全站 CSP 只放 `'self'` 加 nonce，唯一的第三方是 YouTube 和 Bilibili 的 iframe，还得用户点开才加载。接 Turnstile 要放开三个指令，接 reCAPTCHA 放开的是同一组，但多了一条：访客的鼠标轨迹会进 Google 的模型。这两个不是一个量级的取舍，尤其对一个没有广告收入的博客。

## 八、本站的真实状态：接好了，没开

代码在，key 没配。`turnstileMode()` 的四种状态里，现在落在 `off`：

```js
export function turnstileMode(env = {}) {
  const site = !!(env && env.TURNSTILE_SITE_KEY);
  const secret = !!(env && env.TURNSTILE_SECRET);
  if (site && secret) return 'on';
  if (site) return 'site-only';
  if (secret) return 'secret-only';
  return 'off';
}

// verifyTurnstile 的第一行：off 直接返回，一个请求都不发
if (mode === 'off') return { ok: true, skipped: true };
```

线上证据不是「我看了一眼后台」，是两个可复现的读数。页面里下发的是 `"turnstile":""`，所以 `mountTurnstile()` 在 `if (!key || !slot) return;` 就返回了，`#ts-wrap` 一直是 `hidden`。CSP 里也没有那个域名：

```bash
curl -s -o /dev/null -D - https://exia.de5.net/ | grep -i content-security-policy
```

```text
content-security-policy: default-src 'self'; script-src 'self' 'nonce-…';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;
  connect-src 'self'; frame-src 'self' https://www.youtube.com https://player.bilibili.com;
  object-src 'none'; frame-ancestors 'none'
```

`nonce-…` 那里是一次响应 32 位十六进制的 nonce，每次都不一样，抄进文章没有意义。

`script-src` 里只有 `'self'` 和 nonce，`frame-src` 里只有两个视频站。就算哪天 `__SITE__.turnstile` 有值了，脚本插进 DOM 的那一刻也会被 CSP 拦掉——这是第二道保险，也是为什么本站在「半配」状态下会表现为「评论发不出去」，而不是「看起来有验证、实际没有」。

为什么不开，三条。

一是现在没有需要它解决的问题。后台没有一条待处置的垃圾评论，蜜罐和限额的拦截记录都是 0。给一个还没发生的问题付体验成本，是拿确定的代价换不确定的收益。

二是它要破全站的「零第三方」。放开三个 CSP 指令、引入一个会在每个访客浏览器里跑的脚本，这笔账在「垃圾评论 0 条」的前提下算不过来。全站现在唯一的第三方请求，是用户主动点开视频时才发的。

三是它拦的那一类，已经被更便宜的两层挡住了。没有浏览器的脚本过不了蜜罐，也拿不出 token；真正的空白区只剩「带浏览器的批量提交」，而这一类至今一次都没出现。

什么时候开：出现第一条「明显是脚本、但蜜罐和限额都没拦住」的提交时。那一刻它才是唯一不可替代的那层——不是因为它强，是因为另外两层对「有浏览器的对手」是盲的。

接了一半比接完了更能说明问题。`site-only` 那种状态（前端弹框、服务端无从校验）比 `off` 危险得多，因为它看起来在工作。本站现在是 `off`，至少是诚实的。

## 九、想在本地记一笔 token，怎么记

单次性由 CF 保证，本地不需要重复实现。但有一件事 CF 不给你：留痕。`timeout-or-duplicate` 只在响应里出现一次，不会进你的库。想把「同一枚 token 第二次到达」变成可查的记录，加一张表最省事。

```sql
CREATE TABLE IF NOT EXISTS turnstile_seen (
  token_hash TEXT PRIMARY KEY,   -- sha256(token) 的十六进制，不存原文
  first_ts   INTEGER NOT NULL
);
```

```js
/* 本地留痕：不替代 Cloudflare 的单次性，只把「第二次到达」变成一条可查的记录。
   并发两发同时打到 siteverify 时，谁先谁后由网络决定；本地这条 INSERT 是原子的。 */
async function seenBefore(db, token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = Math.floor(Date.now() / 1000);

  // 主键冲突 = 这枚 token 来过；INSERT OR IGNORE 之后 changes 是 0
  const r = await db
    .prepare('INSERT OR IGNORE INTO turnstile_seen (token_hash, first_ts) VALUES (?, ?)')
    .bind(hash, now)
    .run();

  // token 只活 300 秒，留 10 分钟的记录就够；更长的时间窗没有意义
  await db.prepare('DELETE FROM turnstile_seen WHERE first_ts < ?').bind(now - 600).run();
  return r.meta.changes === 0;
}
```

这段有三个边界。

它不提供防护，只提供取证。CF 已经拒了，本地这层只是让「拒了几次、从哪个 IP、间隔多久」能查。真要拿它当防护，等于把 CF 的判断又实现了一遍，还得自己处理 300 秒的窗口。

它在并发下比 CF 硬。两发请求同时到 `siteverify`，理论上存在一个都返回 `success` 的窗口（这点我没测，只按「跨网往返不是原子的」推）；本地这张表的 `INSERT OR IGNORE` 是原子的，第二发一定拿到 `changes = 0`。这个差异只在毫秒级存在，但它是唯一「你这边能确定」的部分。

它得存 hash。token 只活 300 秒，泄露了用处也不大，但日志里出现完整凭证是坏习惯，而且这类日志经常被导出、被贴进 issue。

还有更省的写法：不建表，只在 `siteverify` 失败且 `error-codes` 含 `timeout-or-duplicate` 时打一行结构化日志，带 IP 和 token 前 8 位。本站现在连这行都没有——`if (!token)` 和 `!d.success` 走的是同一个返回，日志里分不清「没带 token」和「token 被判无效」。配 key 之前该补的第一件事不是这张表，是把 `error-codes` 打进日志。

## 怎么自己验一遍

三条检查，前两条现在就能跑、不产生任何数据，第三条要等 key 配好。命令都在 Git Bash 里验证过，`date` 是 2026-11-12。

**第一条，空 body。** 这一步走的是 `if (!content)`，在任何验证之前：

```bash
curl -s -i -X POST https://exia.de5.net/api/comments \
  -H 'content-type: application/json' -d '{}'
```

```text
HTTP/1.1 400 Bad Request
content-type: application/json; charset=utf-8
cache-control: no-store

{"ok":false,"error":"评论不能为空"}
```

**第二条，蜜罐填值。** 字段全合法，只把 `hp` 写成非空。它在 Turnstile 之前，所以返回的是蜜罐的文案，不是人机验证的文案：

```bash
curl -s -i -X POST https://exia.de5.net/api/comments \
  -H 'content-type: application/json' \
  -d '{"slug":"comment-anti-spam","content":"probe","name":"probe","email":"p@example.com","hp":"x"}'
```

```text
HTTP/1.1 400 Bad Request

{"ok":false,"error":"验证没通过，刷新页面再试一次"}
```

两次都是 400，但文案不同。这个区别就是校验链的顺序：`400 评论不能为空` → `400 验证没通过` → `400 请先完成人机验证`，三条文案对应三个位置，看返回就知道请求走到了哪。

**第三条，不带 token 的合法请求。** 这一步会真的写库，所以下面给的是「看什么」，不是「随便跑」：

```bash
curl -s -i -X POST https://exia.de5.net/api/comments \
  -H 'content-type: application/json' \
  -d '{"slug":"comment-anti-spam","content":"probe","name":"probe","email":"p@example.com"}'
```

| 当前状态 | 返回 | 原因 |
|---|---|---|
| key 没配（现在） | `200`，`{"ok":true,"id":…}`，真的入库 | `mode === 'off'`，`verifyTurnstile` 在第一行就 `skipped: true` |
| 两把 key 都配了 | `400`，`{"ok":false,"error":"请先完成人机验证"}` | `token` 为空串，走 `if (!token)` |
| 只配了 sitekey | `400`，`{"ok":false,"error":"人机验证配置不完整，暂时无法评论"}` | `site-only` 按配置不完整拒收 |

第二、三行是按代码路径推的，没在线上跑过——现在两把 key 都没配，跑不出这个返回。真要在生产上验，拿一篇草稿文章当目标，测完自己删那条评论，不然你会得到一条叫 `probe` 的垃圾数据。

**第四条，DevTools 里看 token 字段。** 打开任意文章页，开发者工具 → Network → 勾上 `Fetch/XHR`，在评论框里发一条（或者只看请求不点发送）。找 `POST /api/comments`，看 Payload：

- 本站走 JSON 提交，字段名是 `turnstile_token`，值是一长串不透明字符串，肉眼能看出不是 JWT（没有三段 base64，也没有点分隔的 header）；
- 用官方隐式表单的站点，字段名是 `cf-turnstile-response`——组件会自己在 `<form>` 里插一个隐藏 input，提交时随表单一起走。看到这个字段有值，说明 widget 已经签发了 token；字段不存在，说明组件没渲染成功，先去 Console 看 CSP 和脚本加载错误。

再发同一条：如果这层是开着的，第二次会拿到 `400 人机验证没通过`，服务端日志里对应的错误码是 `timeout-or-duplicate`。判断「是重放还是超时」的办法只有一个——看 `challenge_ts` 和提交时间的差：小于 300 秒是重放，接近或超过 300 秒是过期。我们没记这个字段，所以现在只能靠现象猜，这也是第九节那张表存在的理由。

#cloudflare #turnstile #security

相关：三层防线的完整实现（蜜罐、Turnstile、D1 限额）在[《评论区防滥用》](/p/comment-anti-spam)；系列上一篇是[《CORS 预检不是每个请求都发》](/p/cors-preflight-cost)。
