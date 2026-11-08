## 结论

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
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# 线上
npx wrangler d1 execute blog-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
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

**坑三：拿 `--command` 建表。** 单条 `CREATE TABLE` 用 `--command` 能过，但多语句、触发器、`DEFAULT (datetime('now'))` 这类带括号的默认值，用 `--file` 更稳。我见过 `--command` 只执行了第一句、后面静默丢掉的情况。

## 一句话总结

D1 的 `--local` 和 `--remote` 不是「同一个库的两种访问方式」，而是**两个库**。记住这句，这个错基本只会犯一次。

系列里的另外两篇：[wrangler deploy 失败对照](/p/wrangler-deploy-errors)、[Cannot perform I/O on behalf of a different request](/p/workers-io-different-request)。

#cloudflare #d1 #debugging #sqlite
