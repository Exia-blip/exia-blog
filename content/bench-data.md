# 实测数据存档（2026-11-13）

采集脚本：`bench/index.js` + `bench/collect.mjs`（临时 Worker，测完已删）。
测量方式：Worker 内串行调用，`performance.now()` 被量化到整毫秒，故按 5 次一组测总时长摊平，样本粒度 0.2ms。
每项打 3 轮各 60 次（写操作 30 次），丢弃第一轮（isolate 预热），取后两轮合并算分位。

## 一、存储延迟（单位 ms）

| 操作 | p50 | p95 | p99 | max | 样本 |
|---|---|---|---|---|---|
| D1 `SELECT 1`（对照组，不碰任何表） | 44.4 | 46.8 | 47.4 | 47.4 | 24 |
| D1 主键/索引单行查询 | 43.8 | 47.2 | 47.8 | 47.8 | 24 |
| D1 列表 10 行 + ORDER BY | 44.0 | 50.0 | 51.0 | 51.0 | 24 |
| D1 聚合 GROUP BY | 43.4 | 45.6 | 80.4 | 80.4 | 24 |
| D1 单行 UPDATE | 43.2 | 49.0 | 49.0 | 49.0 | 12 |
| R2 HEAD | 74.0 | 92.4 | 93.2 | 93.2 | 24 |
| R2 GET 1KB | 76.2 | 87.0 | 87.4 | 87.4 | 24 |
| R2 PUT 1KB | 279.2 | 684.4 | 684.4 | 684.4 | 12 |
| KV GET（key 存在，边缘命中） | 3.6 | 4.2 | 4.2 | 4.2 | 24 |
| KV GET（随机 key，必然未命中） | 265.4 | 294.6 | 354.2 | 354.2 | 24 |
| KV PUT（每次新 key） | 560.4 | 605.0 | 605.0 | 605.0 | 12 |

关键点：
- **D1 四类查询耗时差 <1.5ms，连 `SELECT 1` 都和真实查询一样慢** —— 成本在固定往返，不在查询本身。
- KV 命中与未命中差 73 倍（3.6 vs 265.4）。
- KV 写入比 D1 写入慢 13 倍。
- R2 读比 D1 读慢 72%。

## 二、边缘缓存（对 exia.de5.net 实测，2026-11-13 00:26 GMT+8）

| 路径 | CF-Cache-Status | Cache-Control |
|---|---|---|
| `/` | HIT | `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` |
| `/cat/log` | HIT（首次 MISS 时无该响应头） | 同上 |
| `/archive` | HIT | 同上 |
| `/tag/cloudflare` | 首次 none → 后续 HIT | 同上 |
| `/rss.xml` | 始终无该头 → 未进边缘缓存 | `public, max-age=600, stale-while-revalidate=3600` |
| `/p/worker-render-549-to-96`（预排文） | 404 | 同上 |

`Age` 头三条路径同为 22（同一批被缓存），说明边缘 TTL 由 `s-maxage` 与 Cache Rule 共同决定，页面间无差异。

## 三、CORS 预检缓存（Chrome headless，真实时间间隔）

服务端在 OPTIONS 里计数，页面跨域连发 3 次带自定义头的 PUT。

| 端点 | 请求间隔 | PUT 次数 | 实际 OPTIONS 次数 |
|---|---|---|---|
| 带 `Access-Control-Max-Age: 600` | 7s | 3 | **1** |
| 不带 Max-Age | 7s | 3 | **3** |
| 不带 Max-Age | 4.2s | 3 | **2** |
| 不带 Max-Age | ~0s（连发） | 3 | 1 |

推断：Chrome 对没有 Max-Age 的预检响应有一个默认缓存窗口，实测落在 (4.2s, 7s) 区间；4.2s 时第 2 次未预检、第 3 次才预检，与 5 秒不符任何其他常见值。规范未规定该值，属实现细节。

复现脚本：`bench/page.html`（页面侧）+ `bench/index.js` 的 `/cors/*` 与 `/cors-count`。
