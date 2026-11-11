写[R2 那篇](/p/r2-image-pipeline)时预告过这篇。真动手才发现，评论防滥用没有一处需要"聪明"：三层防线全是排序题——**哪一层放在请求路径最前面，取决于拒掉一次攻击要花多少钱**。

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
if (String(body.hp || '').trim()) return err('验证没通过，刷新页面再试一次', 400);
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
  const slot = document.getElementById('ts-wrap');
  if (!key || !slot) return;          // 没配 key：到这里就结束
  slot.hidden = false;
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    window.turnstile.render(slot, { sitekey: key, language: 'zh-cn', size: 'flexible' });
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
  const ts = turnstile ? ' https://challenges.cloudflare.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${n}'${ts}`,
    `connect-src 'self'${ts}`,
    `frame-src 'self'${ts}`,
    // …
  ];
}
```

漏掉 `frame-src` 的后果很典型：组件是个 iframe，脚本能加载、能初始化，但框里一片空白，控制台报 CSP 违规——而你会先去怀疑 key 错了。**开关必须同时管到"脚本从哪来"和"框从哪来"**，这两个是不同的指令。

### 校验：前端那个框只是个摆设

安全上唯一有意义的一步在服务端，`siteverify` 拿 token 复核：

```js
const form = new FormData();
form.append('secret', secret);
form.append('response', String(token));
if (ip) form.append('remoteip', ip);

const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
const d = await r.json();
if (d.success) return { ok: true };
return { ok: false, error: '人机验证没通过，刷新页面再试一次' };
```

`remoteip` 是可选的，但传上去了能让 Cloudflare 把"这个 token 是在哪个 IP 上签发的"一起判——token 被搬到另一个 IP 上重放时才有得比。

### 验不了的时候：这层是 fail-open 的

```js
} catch {
  // 校验服务自己挂了，不能连累评论功能 —— 记一笔降级，放行
  console.warn('[antispam] turnstile siteverify 不可达，本次降级放行');
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
  if (site && secret) return 'on';
  if (site) return 'site-only';
  if (secret) return 'secret-only';
  return 'off';
}
```

- **只配 sitekey**：前端老老实实弹验证框，访客认真勾了，服务端却无从校验——因为 `verifyTurnstile` 的第一行是"没 secret 就跳过"。这层防护是**假的**，而它看起来是真的。这种状态比不配更糟：不配你至少知道自己没防护。所以 `site-only` 按配置不完整拒收，宁可评论挂掉被发现；
- **只配 secret**：前端根本没组件，谁也拿不出 token，此时要求 token 等于全员禁言。按未启用处理，打一行 warn。

**配置的一半不是一半的防护，是一半的错觉。** 这条经验适用于所有"开关 + 密钥"双要素的服务，不只是 Turnstile。

### 顺带修的一个死锁

`mountTurnstile` 的 catch 里原来只有一句 `slot.hidden = true`。问题在提交时：

```js
const tsToken = window.turnstile && document.getElementById('ts-wrap')?.hidden === false
  ? window.turnstile.getResponse() : '';
if (window.__SITE__ && window.__SITE__.turnstile && !tsToken) {
  toast(tsFailed ? '人机验证组件没加载出来，刷新页面或换个网络再试' : '先完成人机验证');
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
    return { ok: false, status: 403, error: '这个来源被拦下了，如果误伤请联系博主', retry: 3600 };
  }
  const hits = rec.day === dayKey(nowSec) ? Number(rec.hits) : 0;
  if (hits >= dayMax) {
    return { ok: false, status: 429, error: `今天已经发了 ${dayMax} 条，明天再来`, retry: secsToNextDay(nowSec) };
  }
  if (checkGap && rec.last_ts) {
    const gap = nowSec - Number(rec.last_ts);
    if (gap < minGap) return { ok: false, status: 429, error: '发得太快了，隔一分钟再发', retry: minGap - gap };
  }
  return { ok: true };
}
```

**banned 的判断放在额度之前**：被拉黑的人不管今天发了几条，拿到的都是 403 而不是 429。用状态码把"你被禁了"和"你太快了"分开，前端和日志都不用猜。

### 为什么是两把钥匙

`guard()` 同时查 `ip:…` 和 `dev:…` 两行：

```js
const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
const raw = parseCookies(request)[DID_COOKIE] || '';
const did = /^[a-f0-9]{24,64}$/i.test(raw) ? raw.toLowerCase() : '';
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
  if (rate.fresh) headers['set-cookie'] = setCookie('cmt_did', rate.did, { maxAge: DID_MAX_AGE });
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
  .prepare('SELECT id FROM comments WHERE ip = ? AND is_admin = 0')
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

#cloudflare #turnstile #security
