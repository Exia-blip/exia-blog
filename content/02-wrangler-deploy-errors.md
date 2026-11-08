## 结论

`wrangler deploy` 失败，报错原文里那个关键词就是**阶段名**：认证 → 配置解析 → 打包 → 上传发布。先认阶段，再只查这个阶段的三五种可能，比拿「deploy 失败」去全网搜快十倍。

这篇文章是一张**长期对照表**：每条只写四件事——报错原文、一眼判断、根因、修法。以后每踩一个新坑就往里加一条。

| 报错里的关键词 | 阶段 · 大概率原因 |
|---|---|
| `Authentication error` / `code: 10000` | 认证：token 权限不够，或者根本不是你以为的那个账号 |
| `Missing entry-point` | 配置：`main` 指向的入口文件不存在 |
| `Could not resolve` | 打包：依赖没装、大小写错的、Node 内置模块 |
| `exceeded the size limit` | 上传：打包产物超了体积上限 |
| `Unexpected fields found` | 配置：`wrangler.jsonc` 里有不认识的字段 |
| `register a workers.dev subdomain` | 发布：账号没开 workers.dev 子域 |

## 1. `Authentication error [code: 10000]`

```
✘ [ERROR] A request to the Cloudflare API (/accounts/<id>/workers/scripts/blog) failed.
  Authentication error [code: 10000]
```

一眼判断：本地 `wrangler dev` 一切正常，只有 deploy 挂。说明代码没问题，是「谁来发布」这件事没谈拢。

根因按出现频率排：

1. **token 权限不够**。只要 `Workers Scripts: Read` 没有 `Edit`，读得动、发不出去，报的就是 10000 而不是 403，所以很容易误判成「登出过期了」。
2. **token 建在了另一个账号下**。一个人挂两个 Cloudflare 账号时特别常见，权限全对，只是账号错。
3. **同时存在两份凭据**。`CLOUDFLARE_API_TOKEN` 环境变量会**覆盖** `wrangler login` 存下的 OAuth 凭据。你明明重新登录过，实际用的还是那个过期的环境变量——这条最坑，因为所有「重新登录」的动作都是无效的。

按顺序查：

```bash
npx wrangler whoami          # 它认为你是谁、能访问哪几个账号
echo "$CLOUDFLARE_API_TOKEN" # 非空就是它在生效，登录态被盖掉了
```

`whoami` 输出的账号列表里如果出现多个，再加一条 `account_id` 显式指定，别让它猜。

最小权限集：Account → **Workers Scripts: Edit**；要用 `wrangler d1` 再加 **D1: Edit**；`whoami`/dt 相关再加 Account Settings: Read。别图省事给 Account 全权，一个能发 Worker 的 token 等于能改你整个边缘逻辑。

## 2. `Missing entry-point to Worker script or to assets directory`

```
✘ [ERROR] Missing entry-point to Worker script or to assets directory
```

一眼判断：你动过目录结构，或者删掉了 `src/index.js` 然后想只发静态资源。

根因：`wrangler.jsonc` 里的 `main` 还指着老路径；同时也没配 `assets.directory`，两个入口一个都没有，wrangler 不知道该发什么。

修法分两种，别混着来：

- 有 Worker 逻辑：`main` 指向真实存在的文件，路径相对项目根目录，不带 `./`。
- 纯静态站：删掉 `main`，只留 `assets.directory`。

顺带一个容易连带踩到的：改了 `main` 的目录后，`import` 里的相对路径要跟着改，否则下一步就变成第 3 条的 `Could not resolve`。

## 3. `Could not resolve "xxx"`

```
✘ [ERROR] Could not resolve "node:fs"
✘ [ERROR] Could not resolve "./utils/date"
```

一眼判断：本地能跑、CI/服务器上挂，或者刚加了一个 `import` 就挂。这条几乎总是**打包阶段的路径解析**问题，跟 Cloudflare 本身没关系。

三种根因，按概率：

1. **大小写**。Windows 文件系统不区分大小写，构建机区分。`import './Utils/date'` 在你机器上是好的，在 Linux 上就是文件不存在。
2. **依赖没装**。`node_modules` 里没有，本地是热更新蒙过去的。
3. **Node 内置模块**。`fs` / `path` / `crypto` / `stream` 需要 `compatibility_flags: ["nodejs_compat"]` 才有。

第三种要多说一句：加了 `nodejs_compat` 不等于 `fs` 能用。Workers 没有本地文件系统，`node:fs` 那层是空实现（部分 API 直接抛）。看到别人教程写「加个 flag 就好了」，先确认他要 `fs` 干什么——十有八九是想读项目里的 JSON 文件，那正确做法是把 JSON 打成模块 `import` 进去，或者放 R2/KV。

## 4. `Your Worker exceeded the size limit of 1 MiB`

```
✘ [ERROR] Your Worker exceeded the size limit of 1 MiB.
```

一眼判断：代码没改几行，体积涨了一大截，通常是新引入了一个 SDK。

根因：Worker 脚本有体积上限，免费 1 MiB、付费 10 MiB，按**压缩后**算。听起来很小，实际上业务代码很少超，超的都是依赖。

先看是谁吃掉的，别猜：

```bash
npx wrangler deploy --dry-run --outdir=dist
du -sh dist/*
```

常见元凶，从大到小：

- 整包引入的 SDK（`import AWS from 'aws-sdk'` 这种）。换成按需 `import { S3Client } from '@aws-sdk/client-s3'`，体积能差一个数量级。
- `moment` / `lodash` 全量。换 `date-fns` 的单函数、或者干脆手写。
- 大的 JSON 被当模块 `import` 进来。几千行数据就是几百 KB，挪到 R2 或 KV，用之前 fetch。
- source map 进了产物。构建配置里关掉。

`--dry-run` 这一步值得养成习惯：只打包不上传，30 秒内就能暴露入口、依赖、体积三类问题，不用等一次失败的部署。

## 5. `Unexpected fields found in your wrangler configuration`

```
✘ [ERROR] Processing wrangler.jsonc configuration:
  - Unexpected fields found in top-level field: "compatibility_flagsx"
```

一眼判断：配置里有拼错的字段名。

根因：wrangler 的配置是**严格 schema**，不认识的字段直接报错，不会静默忽略。

这条其实是好事：它替你拦下了「写了但没生效」的配置。反过来更值得警惕的是另一种情况——**升级 wrangler 之后，某个字段被弃用**，它会警告但继续跑，你以为是配置生效了，其实一直是默认值。所以 `wrangler deploy` 输出里所有 `▲ [WARNING]` 都该看完，不能只扫最后那行成功。

## 6. `You need to register a workers.dev subdomain`

```
✘ [ERROR] You need to register a workers.dev subdomain before publishing to workers.dev
```

一眼判断：第一次在这个账号发 Worker，或者用 `--env` 发到一个新环境。

根因：`workers.dev` 子域是账号级的开关，没开过就没有默认域名可用。

修法：dash 里 Workers & Pages 走一次开通流程（起个子域名，全账号唯一）。不想暴露 `*.workers.dev` 就直接配自定义域：

```jsonc
{ "routes": [{ "pattern": "blog.example.com", "custom_domain": true }],
  "workers_dev": false }
```

配了 `workers_dev: false` 之后，上面那条报错自然不会再出现——它只在「要发到 workers.dev 但没有子域」时才触发。

## 部署成功但线上 500

这是**另一个阶段**的问题，别在 deploy 日志里找，那里什么都看不到。

分诊顺序固定三步：

1. `npx wrangler tail` 看运行时异常原文。
2. 绑定的资源在**目标环境**存不存在。binding 是按环境隔离的：顶层写了 `d1_databases`，`env.production` 里没写，线上 `env.DB` 就是 `undefined`。
3. 资源存在但内容是空的：表没建。见 [D1 报错 no such table](/p/d1-no-such-table)。

九成的「本地好好的、线上 500」是第 2 步：`env.DB` 是 undefined，代码第一句 `env.DB.prepare(...)` 直接抛 `Cannot read properties of undefined`。看着像数据库坏了，其实是配置没进环境。

## 两条省时间的习惯

- **部署前先 `--dry-run`**。打包错误本地就该炸，不用等一次真部署。
- **`wrangler tail` 常开一个窗口**。部署完立刻访问一次，把首屏那几个请求的日志看一眼。很多问题在这一步就能发现，等到用户报障就已经晚了。

## 一句话总结

报错关键词就是阶段名。先定位阶段，再查这个阶段的三五种可能——而不是从「deploy 失败」开始全网搜。

系列里的另外两篇：[D1 报错 no such table](/p/d1-no-such-table)、[Cannot perform I/O on behalf of a different request](/p/workers-io-different-request)。

#cloudflare #workers #debugging
