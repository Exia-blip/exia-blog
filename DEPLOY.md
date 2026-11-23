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
打 `https://exia.de5.net`，43 项：响应头 / CSP / 缓存规则 / srcset 实物 / alt / 103 预加载 /
零外链头像 / 零注释泄漏 等。部署脚本已在部署后自动跑这一步。

## 5. 按需确认项
```bash
npm run backfill:check     # 正文渲染缓存有无空行（退出码 0=无需 / 1=需回填）
npm run ttfb               # TTFB 分缓存态 P50/P95（HIT/MISS/DYNAMIC）
```

## 观测基线
- **CF Analytics**：Dashboard → 设 cached/uncached 的 TTFB P50/P95 与 Web Vitals（LCP/CLS/INP）。
  token 只有 `zone:read`，读不了 Zone Settings API，需在 Dashboard 看。
- **站内事件**：`/admin/stats` 看 read / img-error / search 近 7 天分布。
  数据进 D1 `events` 表；`umamiOn(env)` 为真时不写库（避免两边数字打架）。
- **开关核实**（token 权限不足，从实际响应验证更可靠）：
  - Brotli → 响应头 `Content-Encoding: br`
  - 缓存规则 → `CF-Cache-Status` / `Cache-Control`
  - Early Hints → CDP 抓 `Network.responseReceivedEarlyHints`（缓存命中时不发 103，用 `?cb=` 绕）

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

