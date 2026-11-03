-- 首批两篇：报错对照 + 机制拆解（由 content/*.md 生成）

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, created_at, updated_at)
VALUES ('d1-no-such-table', 'D1 报错 no such table 排查实录：本地和远程根本不是一套库', '## 结论

`D1_ERROR: no such table` 九成不是建表语句写错了，是**你在 A 库建表、在 B 库查询**。

`wrangler dev` 默认连本地模拟库（文件落在 `.wrangler/state` 下），`wrangler d1 execute --remote` 连线上库。这是两个完全独立的数据库：本地建的表线上不存在，线上建的表本地也看不见。它们只是恰好都叫 `blog-db`。

## 报错现场

本地跑 `npx wrangler dev`，打开首页，Worker 里执行：

```sql
SELECT id, slug, title FROM posts ORDER BY created_at DESC LIMIT 10
```

返回 500，日志原样：

```
✘ [ERROR] D1_ERROR: no such table: posts: SQLITE_ERROR
```

同一句 SQL，换成 `--remote` 去查却是正常的：

```bash
npx wrangler d1 execute blog-db --remote \
  --command "SELECT COUNT(*) FROM posts"
# [{"COUNT(*)": 1}]
```

到这里就能定性了：SQL 没写错，表也存在，只是**不在你以为的那个库里**。

## 为什么会这样

D1 的 binding 在运行时只有一份（`env.DB`），但它指向谁，由启动方式决定：

| 启动方式 | `env.DB` 实际指向 | 数据在哪 |
|---|---|---|
| `wrangler dev`（默认） | 本地模拟的 D1 | `.wrangler/state/v3/d1/*.sqlite` |
| `wrangler dev --remote` | 线上 D1 | Cloudflare 边缘 |
| `wrangler deploy` 之后访问 | 线上 D1 | Cloudflare 边缘 |
| `wrangler d1 execute --local` | 本地模拟的 D1 | 同第一行 |
| `wrangler d1 execute --remote` | 线上 D1 | 同第二行 |

控制台里那句 `[simulated locally]` 就是提示，只是很容易被刷过去：

```
- D1 Databases:
  - DB: blog-db (2568eaf1-...) [simulated locally]
```

同一个 `database_id`，本地是「模拟」，线上是真库。`schema.sql` 你只跑了一遍，另一套库自然什么都没有。

## 三分钟定位

别猜，按顺序查四个问题：

**1. 报错的 SQL 是哪一条**

把 `console.error(e)` 和 SQL 一起打出来，不然你只能看到「首页 500」。

**2. 这条 SQL 在哪个进程里跑的**

dev、deploy 后的线上、cron 定时任务，三者连的库可能各不相同。

**3. 那个进程连的哪个库**

看 `wrangler dev` 启动时的 binding 列表里有没有 `[simulated locally]`。

**4. 那个库里到底有没有这张表**

```bash
# 本地
npx wrangler d1 execute blog-db --local \
  --command "SELECT name FROM sqlite_master WHERE type=''table'' ORDER BY name"

# 线上
npx wrangler d1 execute blog-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type=''table'' ORDER BY name"
```

两条命令各跑一次，表清单不一样，问题就到此为止了。

## 修法

两个库都要建，就建两次。别指望一条命令通吃：

```bash
npx wrangler d1 execute blog-db --local  --file=./schema.sql
npx wrangler d1 execute blog-db --remote --file=./schema.sql
```

`wrangler d1 migrations apply` 也是一样，`--local` 和 `--remote` 各有各的 `d1_migrations` 记录表。本地记录显示「已执行」，线上完全可能是空的——迁移文件名一样，不代表两边都跑过。

几条配套习惯：

- `.wrangler/` 加进 `.gitignore`。本地库就是那个目录里的一堆 sqlite 文件，删掉等于清库，别手滑。
- 想稳定复现线上状态，用 `npx wrangler d1 export blog-db --remote --output=seed.sql` 导一份，再 `--local --file=seed.sql` 灌进去。
- 本地调试需要登录态时，别去线上 OAuth 绕一圈，直接往本地 `users` 表插一行、手写一个 session cookie 更快（`SESSION_SECRET` 用 `.dev.vars` 里的那份）。

## 三个容易二次踩的坑

**坑一：以为 `wrangler dev` 连的是线上。** v3 之后默认就是本地模式，写不写 `--local` 都一样。要连线上必须显式 `--remote`，而它会真的改线上数据，调试删除逻辑时尤其危险。

**坑二：preview 和 production 用了不同的 database_id。** 如果 `wrangler.jsonc` 里给 preview 环境配了另一个库，你会在 preview 里把同样的错再撞一遍，而且这次本地和线上都是对的，只有 preview 是空的。

**坑三：拿 `--command` 建表。** 单条 `CREATE TABLE` 用 `--command` 能过，但多语句、触发器、`DEFAULT (datetime(''now''))` 这类带括号的默认值，用 `--file` 更稳。我见过 `--command` 只执行了第一句、后面静默丢掉的情况。

## 一句话总结

D1 的 `--local` 和 `--remote` 不是「同一个库的两种访问方式」，而是**两个库**。记住这句，这个错基本只会犯一次。

#cloudflare #d1 #debugging #sqlite', '', 'log', '', 0,
        0, 0, 'D1 的 no such table 多数不是 SQL 写错，而是本地模拟库与线上库各存一份。给出三分钟定位顺序、两边建表的正确命令，以及三个容易二次踩的坑。', 'manual', '', 1, '2026-11-03 14:37:53', '2026-11-03 14:37:53')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = 0, updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('cloudflare');
INSERT OR IGNORE INTO tags (name) VALUES ('d1');
INSERT OR IGNORE INTO tags (name) VALUES ('debugging');
INSERT OR IGNORE INTO tags (name) VALUES ('sqlite');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('cloudflare','d1','debugging','sqlite') WHERE p.slug = 'd1-no-such-table';

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, created_at, updated_at)
VALUES ('oauth-device-flow', 'OAuth Device Flow 是怎么在不配回调域名的情况下完成登录的', '## 结论

Device Flow 把「浏览器跳回来」换成了「用户手抄一个短码」，所以客户端**不需要可被公众访问的回调地址**，也不需要 `client_secret`。授权结果不是被重定向送回来的，而是客户端拿着 `device_code` 主动去轮询拿的。

这一条差异，决定了它能在 CLI、电视、路由器后台、没有本地 HTTP 服务的桌面应用里跑通——这些场景里，「回调地址」根本不存在。

## 先看清三种流程的分界

| 流程 | 谁来接收授权结果 | 需要回调地址 | 需要 client_secret | 典型场景 |
|---|---|---|---|---|
| Authorization Code | 浏览器重定向到 `redirect_uri` | 要，且必须公网可达 | 要（Web 后端换 token） | 普通网站登录 |
| Authorization Code + PKCE | 同上，但用 `code_verifier` 替代 secret | 要，可用自定义 scheme | 不要 | 移动 App / SPA |
| Device Flow | 客户端轮询 | **不要** | 不要 | CLI、TV、无浏览器设备 |

前两种的隐含前提是：授权服务器能把结果**推**给客户端。Device Flow 把方向反过来——客户端自己**拉**。

## Device Flow 的五步

以 GitHub 为例，端点是真的，字段名也是真的。

**第一步：申请设备码**

```bash
curl -X POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "scope=read:user"
```

返回：

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

注意 `verification_uri` 是**授权服务器自己的地址**，不是你的回调地址。这就是它不需要回调域名的原因：用户从头到尾都在 GitHub 的地盘上操作。

**第二步：把 `user_code` 和 `verification_uri` 展示给用户**

CLI 里通常是这么一行：

```
请在浏览器打开 https://github.com/login/device
并输入代码：WDJB-MJHT
```

**第三步：用户在自己设备上打开、输入、点授权**

这一步完全脱离你的客户端。你的程序此时只是挂在那里。

**第四步：客户端按 `interval` 轮询**

```bash
curl -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=Iv1.xxxxxxxxxxxx" \
  -d "device_code=3584d83530557fdd1f46af8289938c8ef79f9dc5" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code"
```

用户还没点授权时，返回的是 200 加一个错误字段：

```json
{ "error": "authorization_pending" }
```

**第五步：拿到 token**

```json
{ "access_token": "gho_xxxxxxxx", "token_type": "bearer", "scope": "read:user" }
```

轮询期间会遇到的几个错误码，含义和应对方式不一样，别一律当失败处理：

| error | 含义 | 该怎么办 |
|---|---|---|
| `authorization_pending` | 用户还没操作 | 继续按 interval 轮询 |
| `slow_down` | 轮得太快 | interval 增加 5 秒，**不要**重试原频率 |
| `expired_token` | 设备码过期（GitHub 是 900 秒） | 回到第一步，重新申请 |
| `access_denied` | 用户点了拒绝 | 停止，提示用户 |
| `incorrect_device_code` | 码不对或已用过 | 回到第一步 |

`slow_down` 是 RFC 8628 里明确规定的：收到它之后必须把间隔加 5 秒。忽略这条的客户端会被授权服务器直接拉黑。

## 机制上的关键：`user_code` 是怎么把两边对上的

这是整个流程里最容易被忽略的一环。

- `device_code`：长、随机、只在你和授权服务器之间流转，**永远不给人看**。
- `user_code`：短、可读、给人看，用户把它输进浏览器。

授权服务器内部维护一张映射：`user_code → 待授权的 device_code`。用户在浏览器里授权的是那个 `user_code`，服务器把授权结果写到对应的 `device_code` 记录上。客户端下一次轮询时，拿 `device_code` 一问，就能取到自己那份 token。

于是「两边」通过服务器上的这张表对接，客户端和浏览器之间没有任何直接通信，也就不需要回调地址——这也是它能穿过 NAT、穿透公司防火墙的原因。

## 本站用的是 Authorization Code，不是 Device Flow

说清楚一点，免得看完上面以为这个博客的登录是 Device Flow。

本站的登录走的是标准 Authorization Code：

```
GET /auth/github
  → 302 到 https://github.com/login/oauth/authorize
         ?client_id=...&redirect_uri=https://exia.de5.net/auth/callback&state=<随机值>
  → 用户授权
  → 302 回 /auth/callback?code=...&state=<同一个值>
  → 校验 state → POST /login/oauth/access_token 换 token → 写 session cookie
```

`redirect_uri` 在 GitHub App 里注册过，站点域名固定、HTTPS 可用，所以完全没有理由绕到 Device Flow 去。浏览器场景下，Authorization Code 少一步手抄、体验更好，`state` 还能顺手防 CSRF。

Device Flow 是给「没有浏览器」的场景准备的。硬要在网页上用，等于让用户从浏览器跳到另一个页面抄一串码再回来，纯属找罪受。

## 什么时候才该用它

- **CLI 工具**：`gh auth login` 就是这条路，本机起不了公网 HTTP 服务。
- **电视 / 车机 / 物联网设备**：输入法都难用。
- **桌面应用**：不想为每个平台注册自定义 scheme，也不想内嵌 WebView 抓回调。
- **临时脚本**：不想为了跑一次脚本去注册回调地址。

反过来说，只要你的运行环境有浏览器、域名可配，就别用。

## 它的安全边界

Device Flow 不是「更安全的 OAuth」，它是**在无法回调的前提下，把风险重新分配**的方案。

1. **短码可被钓鱼**：攻击者申请一个 `device_code`，把 `user_code` 发给受害者，骗他去 GitHub 输入并授权。受害者以为在登录自己的账号，实际授权的是攻击者的设备。防护只能靠授权页面始终显示「哪个应用在请求什么权限」，以及用户自己看清。这也是 Device Flow 通常只允许低风险 scope 的原因。
2. **轮询是天然的资源消耗点**：授权服务器必须对它做限流，`slow_down` 就是限流信号本身。
3. **token 直接落到客户端**：没有后端做中转，客户端一旦不可信，token 就是裸的。桌面/CLI 场景能接受，因为它本来就在用户自己的机器上。
4. **`client_secret` 不参与**：公共客户端没有秘密可言，安全性全部押在「用户确实在自己的浏览器里点了授权」。

## 一份最小实现骨架

```js
async function deviceLogin({ clientId, scope }) {
  const start = await fetch(''https://github.com/login/device/code'', {
    method: ''POST'',
    headers: { accept: ''application/json'' },
    body: new URLSearchParams({ client_id: clientId, scope }),
  }).then((r) => r.json());

  console.log(`打开 ${start.verification_uri} ，输入 ${start.user_code}`);

  let interval = start.interval || 5;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch(''https://github.com/login/oauth/access_token'', {
      method: ''POST'',
      headers: { accept: ''application/json'' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: start.device_code,
        grant_type: ''urn:ietf:params:oauth:grant-type:device_code'',
      }),
    }).then((r) => r.json());

    if (res.access_token) return res.access_token;
    if (res.error === ''authorization_pending'') continue;
    if (res.error === ''slow_down'') { interval += 5; continue; }
    throw new Error(res.error || ''device flow failed'');
  }
  throw new Error(''expired_token'');
}
```

三件事别写错：`grant_type` 那一长串不能省；`slow_down` 要加间隔而不是重试；循环必须有 `expires_in` 兜底，否则用户不操作时这个进程会一直转。

## 一句话总结

Device Flow 的本质不是「另一种 OAuth」，而是**把回调这件事从网络层挪到了人身上**：用户抄一次码，客户端就不用被公网访问。理解了这一点，它该用在哪儿、代价是什么，也就清楚了。

#oauth #http #workers', '', 'teardown', '', 0,
        0, 0, 'Device Flow 把浏览器回调换成用户手抄短码、客户端主动轮询，因此不需要可公网访问的回调地址。拆开 user_code 与 device_code 的映射机制、GitHub 真实端点、五个错误码，以及本站为什么仍然用 Authorization Code。', 'manual', '', 1, '2026-11-03 14:37:53', '2026-11-03 14:37:53')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = 0, updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('oauth');
INSERT OR IGNORE INTO tags (name) VALUES ('http');
INSERT OR IGNORE INTO tags (name) VALUES ('workers');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('oauth','http','workers') WHERE p.slug = 'oauth-device-flow';