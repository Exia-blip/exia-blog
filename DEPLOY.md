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
