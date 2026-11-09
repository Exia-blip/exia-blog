-- 小工具：Worker Cron 友链存活检测
-- 由 content/07-worker-cron-friend-check.md 生成，重跑会覆盖正文

INSERT INTO posts (slug, title, content, cover, category, series, series_order,
                   is_private, hidden, summary, summary_src, summary_hash,
                   author_id, published_at, created_at, updated_at)
VALUES ('worker-cron-friend-check', '用 Worker Cron 做友链存活检测：20 分钟一轮，403 不算挂', '## 结论

友链存活检测这件事，用 Worker Cron 做只要一个文件、72 次定时调用、一天几 kB 数据库写入。但它有四个坑，每一个都会让检测结果系统性失真：

| 坑 | 现象 | 后果 |
|---|---|---|
| `403` 不是"挂" | 大站对爬虫 UA 直接回 403 | 十个友链里三个被误判成红点 |
| 死域名不抛异常 | DNS 解析失败返回 `status: 530` | 只 catch 异常的话，死站显示"正常" |
| 单次 invocation 只能发 50 次 fetch | 友链超过 50 条时整批失败 | 一轮全红，看着像全站挂了 |
| `fetch` 自己 zone 的域名 | 请求绕回本 Worker，实测 522 | 友链里指向自己的那条永远报错 |

判断口径先定清楚，代码才写得对：**检测的是"用户点进去能不能打开"，不是"源站在不在跑"。** 这两件事在 Cloudflare 前面常常不一致——站点源站已经 502 了，边缘缓存还能给你一个完整的 200。对友链场景来说，前者恰好才是我们要的。

本站 `/friends` 页面上那三个小点（绿 / 黄 / 灰）就是这个脚本的输出，鼠标停上去能看到 HTTP 状态码和耗时。写这篇文章的时候它正在跑，不是示意图。

## 为什么不用现成的监控

UptimeRobot、BetterStack 这类服务当然能用，但：

- 免费额度通常 50 个监控项，友链一多就不够
- 最短检测间隔 5 分钟起，而且被告警的是"你的邮箱"，不是"读者看到的状态"
- 每加一个友链要去第三方后台点一遍，加友链这件事本来是一行 SQL

自己写的话，成本是：**每 20 分钟一次 cron 调用 + 一次 D1 查询 + 一次批量写**。免费计划 10 万请求/天，这点量可以忽略。而且状态直接落在自己的表里，`/friends` 页面读同一张表就有颜色，不需要对接任何外部 API。

## 第一步：把 cron 挂上

`wrangler.jsonc`：

```jsonc
"triggers": {
  "crons": ["*/20 * * * *"]
}
```

入口就三行：

```js
export default {
  async scheduled(event, env, ctx) {
    // waitUntil 而不是 await：cron 触发的返回值没人看，
    // 但 await 会把这次 invocation 的生命周期绑在检测上，
    // waitUntil 交给运行时托管，异常也不会变成 cron 的失败记录
    ctx.waitUntil(checkFriends(env));
  },
};
```

`*/20 * * * *` 是 UTC，20 分钟一轮，一天 72 轮。免费计划的 cron 触发有分钟级抖动，别指望整点整分——对存活检测来说无所谓。

## 实测：一次 invocation 到底能发几次 fetch

这是整个设计的硬约束，先量清楚。在 Worker 里循环 fetch 同一个地址，数到第几次炸：

| 场景 | 成功次数 | 第几次抛错 |
|---|---|---|
| 干净的 invocation，循环 `GET https://example.com/` | **50** | 第 51 次 |
| 同一 invocation 里先做 3 件事（1 次超时测试 + 2 次正常 fetch），再循环 | **47** | 第 48 次 |
| 循环 `GET http://example.com/`（每条 301 跳到 https） | **50** | 第 51 次 |

两行数字值得单独说：

**第一，「50 次」是累计的，不是每个函数 50 次。** 47 + 3 = 50。所以真实代码里不能只按"我要检测多少友链"来算，同一个请求里前面做过的所有 fetch 都要算进去。`checkFriends()` 里除了检测什么都不发，才敢按 40 条切。

**第二，跳转不额外计数。** `http://example.com/` 每次都 301 到 https，按"一次跳转算一次 subrequest"的常见说法，50 次应该变成 25 次，实测仍然是 50。所以 `redirect: ''follow''` 可以放心用，友链里一堆 http 的老站不会因此翻倍消耗配额。

## 并发还是串行：6 倍差距

选 10 个真实站点（cloudflare / github / MDN / nodejs / example / npm / w3 / kernel / python / go.dev），串行跑一遍 vs 10 个并发：

| 方式 | 总耗时 | 单站耗时范围 |
|---|---|---|
| 串行 | **2026ms** | 5 – 391ms |
| 并发 10 | **332ms** | 5 – 332ms |

单站平均 200ms，串行 10 个就是 2 秒；并发之后总耗时等于最慢那一个。40 条友链串行要 8 秒，并发（每批 10）大概 1 秒内。

批大小选 10 不是拍的：并发太多会被部分站的 WAF 当成攻击，也会让超时判定变得难解释。10 个一批，40 条友链就是 4 批。

## 超时要自己设，而且要设对

Worker 里的 `fetch` 没有默认超时。不加超时，一个不响应的站会挂到平台级超时（几十秒），把整轮检测拖住。

```js
signal: AbortSignal.timeout(8000)
```

实测这个信号是精确的：对 `https://httpbin.org/delay/10`（故意睡 10 秒）设 1500ms 超时，**1500ms 整**抛出：

```
TimeoutError: The operation was aborted due to timeout
```

8 秒的取值理由：正常站点 200–400ms 就有响应头，慢的跨境站 1–2 秒，8 秒足够宽松；再长就会拖住整批。

## 坑一：403 不是"挂"

第一版代码是 `status >= 200 && status < 400 ? 1 : 0`。上线后我去看数据，发现十个测试站里有三个被标成红色：

| 站点 | 状态码 | 耗时 |
|---|---|---|
| `www.npmjs.com` | **403** | 7ms |
| `www.kernel.org` | **403** | 32ms |
| `go.dev` | **403** | 328ms |

7ms 返回 403 —— 那是 WAF 在门口就把爬虫挡了，服务器自己活得很健康。真实的友链圈里，用 Vercel / Cloudflare 免费版 + 默认安全规则的站点很多，一律按 403 判死，等于把大半个圈子标红。

所以状态改成三态：

```js
status: code >= 200 && code < 400 ? 1 : 2   // 1 通，2 有响应但状态异常
```

- **1 绿**：2xx / 3xx
- **2 黄**：4xx / 5xx —— 拿到响应就说明服务器活着，只是不是正常页面（WAF、维护页、404）
- **0 灰**：完全没拿到响应（超时、连接失败）

页面上黄点的 tooltip 会写清楚 `有响应（HTTP 403） · 7ms`，人工看一眼就知道是 WAF 还是真坏。

## 坑二：死域名不抛异常

这条最反直觉。`fetch(''https://no-such-host-99213.example/'')` 不会 throw，它返回一个响应：

```
status: 530, ms: 8
```

530 是 Cloudflare 的 "origin DNS error"。也就是说 `try/catch` 里那个 catch 分支根本不会进，你如果只判断 catch，所有死域名都会被当成"正常"——因为代码里没有 else 分支去检查 530。

所以判定必须落在状态码上，而不是异常上：

```js
try {
  const res = await fetch(...);
  return { status: res.status < 400 ? 1 : 2, code: res.status, ms };
} catch (e) {
  // 只有真超时 / 连接失败才走这里：TimeoutError、TypeError: fetch failed
  return { status: 0, code: 0, ms, note: e.name };
}
```

配合超时那一条：530 归 2（黄点，有响应但异常），超时归 0（灰点）。语义刚好对上。

## 坑三：不能 fetch 自己 zone 的域名

把本站地址放进检测列表时，它 100% 报错：

| 目标 | 结果 | 耗时 |
|---|---|---|
| `https://exia.de5.net/`（自己 zone） | **522** | 37ms |
| `https://exia-blog.meitu.workers.dev/`（自己 workers.dev） | **404** | 27ms |

原因是这个域名本身就是 Worker 在响应：Worker 去 fetch 自己的域名，请求转一圈又回到自己，Cloudflare 不让它闭合成环，直接给 522。

所以代码里显式跳过：

```js
const SELF_HOSTS = new Set([''exia.de5.net'', ''www.exia.de5.net'', ''exia-blog.meitu.workers.dev'']);
if (SELF_HOSTS.has(new URL(target).hostname)) return { status: 1, code: 0, ms: 0, note: ''self'' };
```

顺带说，友链指向自己的那条记录本来就没什么可检测的——它一定通，因为你自己就在这。

## 坑四：`cacheTtl: 0` 不绕缓存

第一版加了 `cf: { cacheTtl: 0 }`，以为能让每次检测都打到源站。实测没用：

| 请求 | cf-cache-status | age | content-length |
|---|---|---|---|
| 默认 | HIT | 3 | 1334957 |
| `cf: { cacheTtl: 0 }` | **HIT** | 3 | 1334957 |
| 带唯一 query（`?cb=<时间戳>`） | MISS | — | — |

`cacheTtl` 改的是"缓存多久"，不是"绕不绕过缓存"。想拿 MISS 只有一条路：换成不会被缓存的 URL。而那样一来，你测的就不是友链的真实地址了。

这也回到开头定的口径：**能被边缘缓存返回，就等于用户能打开**。友链场景不需要知道源站死活，那加参数绕缓存就没必要，`cacheTtl: 0` 直接删掉。

另一个真实的浪费：`cloudflare.com` 首页 1.3MB。检测只需要响应头，正文不要：

```js
if (res.body) await res.body.cancel().catch(() => {});
```

`cancel()` 不会让这条 subrequest 少算一次，但能省掉 1.3MB 的传输。

## 超 40 条怎么办：不存游标，按"最久没检"轮转

50 次上限下，一次最多跑 40 条，留 10 次余量给未来可能加的额外请求。友链一旦超过 40 条，就需要"这一轮跑哪些"的策略。

第一反应是存个游标（`last_checked_id`）。别这么做：多一次读写、多一个可能写坏的字段，而且两次 cron 靠得近时会互相覆盖。

用 `checked_at` 自己当游标就行：

```sql
SELECT id, url FROM friends
ORDER BY COALESCE(NULLIF(checked_at, ''''), '''') ASC, id ASC
LIMIT 40
```

跑完的 40 条 `checked_at` 更新成当前时间，自动排到队尾；下一次自然接上后面 40 条。零额外状态，崩了也不会卡住——最坏情况是某条多等一轮。

`COALESCE(NULLIF(checked_at, ''''), '''')` 是为了让从没检测过的（NULL 或空串）排最前。`NULLIF` 把空串变成 NULL，`COALESCE` 再兜成空串，空串在升序里排最前。

## 完整实现

一个文件，没有依赖：

```js
import { nowISO } from ''./utils.js'';

const UA = ''Mozilla/5.0 (compatible; BlogFriendCheck/1.0; +https://exia.de5.net/friends)'';
const TIMEOUT_MS = 8000;
const PER_RUN = 40;      // 单次 invocation fetch 上限 50，留余量
const CONCURRENCY = 10;  // 一批 10 个，40 条分 4 批
const SELF_HOSTS = new Set([''exia.de5.net'', ''www.exia.de5.net'', ''exia-blog.meitu.workers.dev'']);

/* 0 挂 / 1 正常 / 2 有响应但状态异常 */
async function probe(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  try {
    if (SELF_HOSTS.has(new URL(target).hostname)) return { status: 1, code: 0, ms: 0, note: ''self'' };
  } catch {
    return { status: 0, code: 0, ms: 0, note: ''bad-url'' };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(target, {
      method: ''GET'',
      redirect: ''follow'',
      headers: { ''user-agent'': UA, accept: ''text/html,*/*'' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    const code = res.status;
    if (res.body) await res.body.cancel().catch(() => {});
    return { status: code >= 200 && code < 400 ? 1 : 2, code, ms };
  } catch (e) {
    return { status: 0, code: 0, ms: Date.now() - t0, note: e.name };
  }
}

export async function checkFriends(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, url FROM friends
     ORDER BY COALESCE(NULLIF(checked_at, ''''), '''') ASC, id ASC
     LIMIT ?`
  ).bind(PER_RUN).all();
  if (!results || !results.length) return { checked: 0 };

  const stamp = nowISO();
  let done = 0;

  for (let i = 0; i < results.length; i += CONCURRENCY) {
    const batch = results.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(batch.map(async (f) => ({ id: f.id, ...(await probe(f.url)) })));

    // batch() 单次往返写多条，比逐条 run() 省 N-1 次 D1 调用
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare(
          ''UPDATE friends SET status = ?, http_status = ?, latency_ms = ?, checked_at = ? WHERE id = ?''
        ).bind(r.status, r.code, r.ms, stamp, r.id)
      )
    );
    done += rows.length;
  }

  return { checked: done };
}
```

表结构多两个字段：

```sql
ALTER TABLE friends ADD COLUMN http_status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friends ADD COLUMN latency_ms INTEGER;
```

`latency_ms` 不是给页面炫技用的。它有个实际用途：某个友链从 200ms 涨到 3 秒，说明对方在换服务器或被打，这种"还没挂但变慢"的状态比挂掉更早出现，是唯一能提前发现的信号。

## 成本

| 项 | 量 |
|---|---|
| cron 触发 | 72 次/天 |
| D1 查询 | 72 次/天（一次取 40 条 id+url） |
| D1 写入 | 72 次 batch/天（每条友链一次 UPDATE，batch 内合并） |
| 出口流量 | 每条友链只拉响应头，正文 cancel |

一天跑下来对免费计划来说完全是噪声级别。

## 关于 User-Agent

```js
const UA = ''Mozilla/5.0 (compatible; BlogFriendCheck/1.0; +https://exia.de5.net/friends)'';
```

带了 `+https://` 一个能说明来意的地址。理由很实际：被 WAF 挡的概率会低一些（有些规则专门放行带 `+http` 的爬虫 UA），同时对方站长在日志里看到这行，知道是谁在打他，而不是把它当扫描器封 IP。

伪装成普通浏览器是反效果——Cloudflare 的 bot 管理对"UA 说是 Chrome 但 TLS 指纹不是 Chrome"的组合打分很低，反而更容易进挑战页。

## 还没做的

- **正文里的回链检查**：现在只测"对方站点是否可达"，没测"对方页面里是否还有本站链接"。真要做需要拉正文、找 `<a href>` 里的自己的域名，一条友链一次 fetch——40 条友链正好把配额吃满，得另开一轮。
- **变慢告警**：`latency_ms` 已经在存了，但只是显示在 tooltip 里，没做"连续三轮比基线上涨 3 倍就记一笔"。
- **RSS / 邮件告警**：站点挂了目前只能靠我自己打开 `/friends` 才看见。真挂的时候我也未必在看。

这三件里有价值的下一件是变慢告警——它不需要新配额，纯粹是拿已经存下来的数据做判断。

---

顺带一句：这套代码里"一次 invocation 能发 50 次 fetch、且是累计计数"的实测，和 [Workers 里 fetch 超时不是网络慢](/p/workers-subrequest-limit) 那篇是同一轮做的。那篇讲这个限额怎么伪装成超时，这篇讲它在真实功能里怎么把人坑住——建议连着看。

#cloudflare #workers #d1 #cache
', '', 'tools', '', 0,
        0, 0, '友链检测的四个坑都在这：一次 invocation 50 次 fetch 是累计计数、10 个站点串行 2026ms 并发 332ms、403 与 DNS 530 要分三态判、fetch 自己 zone 的域名回 522。附一个文件跑完的完整实现。', 'manual', '', 1,
        '2026-11-09 15:26:00', '2026-11-09 15:26:00', '2026-11-09 15:26:00')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title, content = excluded.content, category = excluded.category,
  summary = excluded.summary, summary_src = 'manual', hidden = 0,
  published_at = CASE WHEN posts.published_at = '' THEN excluded.published_at ELSE posts.published_at END,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO tags (name) VALUES ('cloudflare');
INSERT OR IGNORE INTO tags (name) VALUES ('workers');
INSERT OR IGNORE INTO tags (name) VALUES ('d1');
INSERT OR IGNORE INTO tags (name) VALUES ('cache');

DELETE FROM post_tags WHERE post_id = (SELECT id FROM posts WHERE slug = 'worker-cron-friend-check');
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.name IN ('cloudflare', 'workers', 'd1', 'cache') WHERE p.slug = 'worker-cron-friend-check';
