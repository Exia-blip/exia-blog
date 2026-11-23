## 结论

两个问题分开答，但都不是改代码就能了事的。

**多用户模板**：三个候选都不适合。不是模板差，是**本站的评论是匿名的**——加一张 member 表对匿名评论零作用。要让它有效，得先做「登录才能评论」这个产品决定。那是产品问题，不是权限架构问题。

**CSP 四步**：第 1 步上一轮刚做完，第 2 步（Report-Only）不适用，第 3 步（nonce）2026-10 就上线了，第 4 步的编号又撞了。四步里三步是既成事实。

但材料里**有一条真的戳中了**：nonce 与共享缓存。而在补这条断言的过程中，我发现自己写的六条断言**从来没执行过**——它们一直是绿的。

| 材料条目 | 本站实况 |
|---|---|
| `P-009`~`P-013` 五条断言 | **第四轮撞编号**。P-009=CRLF/SRI、P-010=103 preload，早分配掉了 |
| `!/x-xss-protection/i.test(headers)` | **和它自己第 1 步矛盾**：第 1 步说「建议设 0」，第 4 步断言「不许存在」 |
| 「先发 Report-Only 跑一周」 | 已是 enforcing，不适用 |
| 「第 3 步再上 nonce」 | nonce 2026-10 就在，每请求重生成 |
| 「nonce 不能进共享缓存」 | **说对了，本站违反**——但违反是有意的，见第三节 |
| 「`can(user, action, resource)`」 | 需要第三种资源才有意义，现在抽是空壳 |
| 「role 字段允许用户自改」 | 本站**没有改资料的接口**，`/me` 只有 GET |
| 「`base-uri 'none'`」 | 比本站严，**采纳了** |

## 一、多用户模板：三个候选，缺的是同一件东西

三个候选的定位很清楚：orboro 是 Astro + D1 + R2 + 服务端高亮，Rin 是 React SPA + 两级 permission，Cloudflare Users Framework 是四表 RBAC。

先说最该看的那条——**orboro 的双表隔离**。管理员表和 member 表分家，member 永远进不了 admin 区。这比「一个字段区分两级」安全，因为它把「提权」从「改一个字段」变成「跨表」。

但把它搬到本站，会先撞上一个问题：

**本站的评论区没有账号。** 现在填的是昵称 + 邮箱 + 网站，落库进 `comments`，不关联任何 user。评论治理靠三层——先审后发（`review_status`）、IP + 设备双钥匙限额、蜜罐。

加一张 member 表，能封的是「账号」，而评论区里没有账号可封。要让封禁生效，必须先强制登录才能评论——那是**产品决定**，会把「填个名字就能说话」变成「先注册」。这个站从第一天起就不是社区。

所以双表隔离这条，结构是对的，但落点不在评论，在**未来的投稿者**。而投稿现在是走 `/submit` 待审，投稿者本身不登录。

第二个候选 Rin 的两级 permission，上一轮已经对过账（第 45 篇）：`is_admin` 0/1 本站就有，`isFirst ? 1 : 0` 那行也改成 `decideAccess()` 了。没有可搬的。

第三个 RBAC 四表（`roles` / `permissions` / `user_roles` / `role_permissions`）——现在的动作只有两种：**能进后台**、**能改自己的文章**。给两种动作建四张表，等于用四张表表达一个布尔值。

`can(user, action, resource)` 也是同一个问题。它现在的实现会是：

```js
function can(user, action, resource) {
  if (action === 'admin') return !!user?.is_admin;
  if (action === 'write') return ownerOrAdmin(user, resource);
  return false;
}
```

一个 if 套两个已经有名字的函数。`ownerOrAdmin()` 上一轮刚从 8 处散落的裸判定收口（`[P-021]` 的 AP-15 守着不许再出现），再包一层 `can()` 只是把 8 个调用点换成 8 个 `can(u,'write',p)`，没有减少任何一处需要判断的地方。

材料提的第三个风险——「role 字段允许用户在个人资料里自改」——在本站**不存在**，因为压根没有改资料的接口：

```
$ grep -n "path === '/me'" src/api.js
622:  if (path === '/me' && method === 'GET') {
```

只有 GET。`/me` 返回自己的整行（含 `email`、`github_id`），前端只用来决定要不要显示「后台」入口。没有 PATCH、没有 PUT、没有 `Object.keys(body)` 动态拼字段。

**结论**：这一部分没有该写的代码。硬写出来只是凑数。真要动，前提是先决定「评论要不要账号」——那是个产品问题，做完再谈权限表。

## 二、CSP 四步：三步是既成事实

材料给的四步路径是对的，只是它假设的是「从零开始」。

| 步骤 | 材料 | 本站 |
|---|---|---|
| 1 集中设头 | 写一个 `securityHeaders(env)` | **已有**，`src/security.js`，40 行 |
| 2 Report-Only 跑一周 | 先发 `-Report-Only` 收报告 | **跳过**：2026-10 起就是 enforcing，13 条指令零违规 |
| 3 上 nonce | 16 字节随机，头带引号属性不带 | **已上线**，`makeNonce()` 是 `crypto.getRandomValues(new Uint8Array(16))`，hex 输出 |
| 4 变成断言 | `P-009`~`P-013` 五条 | 上一轮已做 20 条（`P-023`~`P-027`），本轮再加 7 条 |

第 3 步的三条铁律，逐条对：

**「16 字节密码学随机、每响应重生成」** —— 符合。`makeNonce()` 用 `crypto.getRandomValues`，16 字节 → 32 位 hex。断言里加了一条守它：两次响应的 nonce 必须不同，且必须是 32 位 hex。

材料示例用 `btoa(...)` 输出 base64。base64 比 hex 短 25%（16 字节 → 22 字符 vs 32 字符），对头大小和每个内联 `<script>` 属性都有点用，但这点差别在 br 压缩之后基本消失。不改。

**「头里 `'nonce-xxx'` 带引号，HTML 属性 `nonce="xxx"` 不带，两处字节必须完全一致」** —— 符合。但这一条**之前没有断言**。如果哪天有人给 `applyNonce()` 传了另一个 nonce（比如顺手 `makeNonce()` 一次），结果是：页面所有脚本被 CSP 挡掉，服务器 200，HTML 正常，只有浏览器控制台报错。**从外观看完全正常。**

现在有一条守它，注入验证过：把 `applyNonce(obfuscateEmail(raw), nonce)` 改成 `applyNonce(obfuscateEmail(raw), makeNonce())`，断言立刻红。

**「nonce 过的 HTML 绝不能进共享缓存」** —— 这条本站**违反**。下一节单独说。

## 三、材料唯一戳中的：nonce 与共享缓存

实测四种路径的缓存头：

```
首页     | cc: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
搜索     | cc: no-store
分页     | cc: no-store
后台     | cc: private, no-store
文章页    | cc: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

首页和文章页**在边缘缓存 300 秒，而它们带 nonce**。也就是说同一个 nonce 在 5 分钟窗口内被所有访客共用。404 页也一样，`s-maxage=60`。

按材料那条通行规则，这是明确的违反。而且这个违反是**故意的**——全站 `no-store` 会让首屏回到每次回源，而「首屏不回源」是本站反复写的一条立身之本。

既然要缓存，nonce 就必然被共享。这是 CSP 里 `nonce` 相对 `hash` 的固有弱点：hash 是内容决定的、天然可缓存；nonce 是响应决定的、缓存即复用。

**那为什么还能接受？** 因为 nonce 复用本身不是漏洞。漏洞的完整条件是「**nonce 复用 + 反射面**」：攻击者能在某个可缓存页面上注入一个带正确 nonce 的 `<script>`，而那个 nonce 对所有访客有效。没有反射面，知道 nonce 也没用。

所以本站的安全性并不来自「nonce 不共享」，而来自另一件事：**可缓存页面零反射面**。凡是回显用户输入的地方，一律 `no-store`：

- 搜索词、分页 → `harden()` 的 `search` 分支，双层 `no-store`（`cache-control` + `cdn-cache-control`）
- 后台 → `isAdminPath` 分支，`private, no-store`

这两条上一轮就写了。但**「路径参数」这一层之前没查过**——`isPagePath` 里含 `/tag/` `/cat/` `/p/` `/series/`，这些是 path 不是 query，`!url.search` 挡不住。实测：

```
$ curl -sI "https://exia.de5.net/tag/zzz-nonexistent-9271"
status=404 cc=[public, max-age=0, s-maxage=60]

$ curl -s "https://exia.de5.net/tag/%3Cscript%3Ealert(1)%3C%2Fscript%3E" | grep -c "alert(1)"
0
```

不存在的标签返回 404，**不回显注入串**。404 页有 60 秒的边缘缓存，但因为零回显，那 60 秒里共享的 nonce 没有可利用的地方。

这就是「缓存 + nonce」能并存的实际原因：**不是 nonce 安全，是反射面为零**。

补了 7 条断言（`[P-028]`）把这个边界钉住：

| 断言 | 守什么 |
|---|---|
| 带 query 三种（`?q=` `?page=` `?utm_source=`）必须双层 no-store | 反射面入口 |
| `/admin` `/editor` 必须 `private, no-store` + `cdn-cache-control` | 后台不进任何缓存 |
| CSP 里的 nonce === HTML 里每个 `nonce=` 属性 | 材料铁律 2 |
| nonce 是 32 位 hex 且两次响应不同 | 材料铁律 1 |
| `cacheable` 源码必须含 `!url.search` | 防回退（元断言） |
| **可缓存的 HTML 仍然带 nonce**（反方向） | 这是既定设计，改动需同步本文 |

最后一条是故意写反的：它守的不是「对」，是「这是有意的」。哪天有人把可缓存页面的 nonce 摘掉改回 `'self'`，这条会红，提醒同步删掉本文这一节。

## 四、我写的六条断言，从来没执行过

这是本轮真正的发现，而且不是材料指出来的。

写完 `[P-028]` 那六条，跑一遍：27/27 全绿。按规矩做注入验证——把 `harden()` 里搜索分支的两行 `no-store` 换回 `s-maxage=300`。

**没红。**

再注入两处：`applyNonce` 传另一个 nonce、后台去掉 `private`。**都没红。**

去看 `t()`：

```js
function t(name, fn) {
  cases.push(name);
  try {
    fn();          // ← async 用例在这里返回一个 Promise
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {    // ← rejected promise 进不了这里
    ...
  }
}
```

那六条用例是 `async` 的（要 `await harden(...)`）。`fn()` 返回一个 rejected promise，同步的 `try/catch` 抓不到它。异常被吞掉，`pass++` 照常执行，输出照常是 `ok`。

**六条断言从来没有执行过判断。** 它们在任何情况下都是绿的——包括该红的时候。

这比上一轮记的 P-019（快照跟着被测代码一起坏）更隐蔽：那一次人还能通过读代码起疑；这一次**断言在语法层面就失效了**，输出里全是 ok，看不出任何异常。

修法是把 `t` 改成 `async`、调用处全部 `await`。改完四处注入全部变红：

| 注入 | 修前 | 修后 |
|---|---|---|
| 搜索页不再 no-store | 0 FAIL（绿） | 1 FAIL |
| `applyNonce` 换另一个 nonce | 0 FAIL（绿） | 1 FAIL |
| 删掉 `!url.search` | 1 FAIL | 1 FAIL |
| 后台去掉 `private` | 0 FAIL（绿） | 1 FAIL |

第三行是同步用例，只有它一直是有效的——这也正是事后能看出问题的线索：四处注入三处不红，说明红的那个不是因为断言对，是因为它恰好是同步的。

补了一条元断言 `[P-029]`：读自身源码，要求 `t()` 是 `async`、`await t(...)` ≥ 20 处。把 `t` 改回同步，脚本**直接崩**（Node 15+ 里未处理的 promise rejection 是抛错退出），而不是变成静默绿。

`[P-029]` 守得住「不要退回旧写法」，守不住「新写的用例忘了 await」。后者只能靠同一条规矩：**新写一条断言，先把它该抓的东西改坏一次，看着它红，再改回来。** 没有别的办法。

## 五、唯一采纳的收紧：`base-uri` 从 `'self'` 到 `'none'`

材料给的第 1 步代码里写 `base-uri 'none'`，本站是 `'self'`。查了一遍：源码和 47 篇文章里没有任何 `<base>` 标签。

那 `'self'` 留着的唯一作用是**给注入的 `<base href>` 留一个合法位置**。收紧到 `'none'`：

```js
/* 'none' 而不是 'self'：全站没有任何 <base> 标签（源码与 47 篇文章都不含），
   base 的合法用途为零，剩下的只有「被注入一个 <base href> 改掉所有相对链接」。
   CSP 是最后一道，就该按「前面全失守」写 —— 收紧到 none 零成本。 */
"base-uri 'none'",
```

断言也同步收紧：从「存在且不是 `*`」改成「必须是 `'none'`」。原来那条太宽松，`'self'` 能过。

## 六、编号第四轮撞车

材料给：

```
check('P-009', 'CSP 存在', ...)
check('P-010', 'CSP 放行 Turnstile', ...)
check('P-011', 'nosniff 存在', ...)
check('P-012', '无 X-XSS-Protection', ...)
check('P-013', 'cookie 含 HttpOnly', ...)
```

`P-009` 是 CRLF/SRI，`P-010` 是 103 Early Hints 的 preload 版本号。这是**第四轮**给这两个编号了。

而且 `P-012` 那条断言和材料自己第 1 步矛盾：第 1 步说「`X-XSS-Protection` 建议设 0」，第 4 步断言 `!/x-xss-protection/i.test(headers)`——不许这个头存在。上一轮已经论证过：**必须显式设 `0`，不能靠不设**，因为不设时旧引擎走自己的默认行为。按 `P-012` 那条断言写，等于把上一轮刚修的东西又拆掉。

五条的具体内容早就被覆盖了：

| 材料断言 | 现在在哪 |
|---|---|
| CSP 存在 | `[P-025]` 九条里的第一条 |
| CSP 放行 Turnstile | `[P-020]` 三处放行 + `[P-025]` 反向「未配时零放行」 |
| nosniff 存在 | `[P-023]` |
| 无 X-XSS-Protection | `[P-024]` —— **但要求是 `0`，不是「不存在」** |
| cookie 含 HttpOnly | `[P-026]` |

对账现 29 条全绿。

## 明说的没做

1. **多用户权限一行没动。** 不是不想做，是做完没有用——评论没账号，封禁无对象。要动先决定「评论要不要登录」，那是产品决定。
2. **nonce 与共享缓存共存没改。** 改成全站 `no-store` 能彻底消掉这个理论缺口，代价是首屏回源；改成 hash 则要预先算出所有内联脚本（analytics tag 和邮件解码脚本是动态拼的，算不出来）。继续保持现状，靠「可缓存页面零反射面」兜着。
3. **`img-src` 仍比 OWASP 多一个 `https:`**，与上一轮同一条理由：外链图。收紧要先迁图。
4. **`/tag/<任意>` 仍会写一条 60 秒的 404 缓存。** 零回显所以不构成 XSS 面，但确实可以用不重复的路径灌一批 60 秒条目。上限是 60 秒窗口内的请求量，不像 `?q=` 那样能无限堆积——后者已经 `no-store`。
5. **`check-live` 上一轮加的 4 条断言还是红的**，因为 `x-xss-protection: 0` 和这一轮的 `base-uri 'none'` 都还没部署。线上现在跑的仍是旧代码。
