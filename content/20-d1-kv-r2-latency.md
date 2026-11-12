## 结论

在同一台 Worker、同一个机房、同一秒内跑出来的一组数：

| 操作 | p50 | p95 | 相对 D1 |
|---|---|---|---|
| D1 `SELECT 1`（不碰任何表） | 44.4ms | 46.8ms | 1.00× |
| D1 主键单行查询 | 43.8ms | 47.2ms | 0.99× |
| D1 列表 10 行 + ORDER BY | 44.0ms | 50.0ms | 0.99× |
| D1 聚合 GROUP BY | 43.4ms | 45.6ms | 0.98× |
| D1 单行 UPDATE | 43.2ms | 49.0ms | 0.97× |
| R2 HEAD | 74.0ms | 92.4ms | 1.67× |
| R2 GET 1KB | 76.2ms | 87.0ms | 1.72× |
| R2 PUT 1KB | 279.2ms | 684.4ms | 6.29× |
| KV GET（key 存在） | 3.6ms | 4.2ms | 0.08× |
| KV GET（随机 key，必然未命中） | 265.4ms | 294.6ms | 5.98× |
| KV PUT（每次新 key） | 560.4ms | 605.0ms | 12.7× |

三个结论，每一个都跟直觉相反：

**第一，D1 上优化 SQL 写法几乎没有收益。** `SELECT 1` 和「10 行带排序」差了 0.6ms，和「GROUP BY 聚合」差了 1ms。真正的问题是那 44ms 的固定往返——四类查询里它占 97% 以上。想在 D1 上提速，唯一有效的动作是**减少查询次数**，不是把 SQL 写得更聪明。

**第二，KV 的 3.6ms 不是「KV 存储快」，是「这次读没出机房」。** 同一个 KV 读一个不存在的 key，265ms。差 73 倍。KV 快的前提是命中边缘缓存，命中率决定一切，跟数据量、跟 key 大小都没关系。

**第三，R2 读比 D1 慢。** 76ms vs 44ms。R2 的定位是便宜，不是快。任何把 R2 当「图片直接每次读」的架构，都在为每张图付 76ms。

下面是完整的测量方法、数据和选型判断。

## 一、怎么量的

不测「客户端到 Worker」这一段网络——那一段取决于我家的宽带和 Cloudflare 的边缘调度，跟产品本身没关系。只测 Worker 内部对绑定的调用。

写一个临时 Worker，绑同一个 D1 库、同一个 R2 桶、新建一个 KV 命名空间，每个 target 在一个请求里串行调用 N 次：

```js
// bench/index.js —— 只保留核心，完整版见 content/bench-data.md
async function timeIt(n, fn) {
  const GROUP = 5;
  const out = [];
  for (let i = 0; i < n; i += GROUP) {
    const t0 = performance.now();
    for (let j = 0; j < GROUP; j++) await fn(i + j);
    out.push((performance.now() - t0) / GROUP);
  }
  return stats(out);
}
```

这里有个必须先踩的坑：**Workers 里 `performance.now()` 被量化到整毫秒**。直接单次测量，绝大多数样本读到 0：

```json
{ "n": 5, "min": 0, "p50": 0, "p95": 0, "max": 0 }
```

所以改成 5 次一组测总时长再摊平，样本粒度回到 0.2ms。这一步不做，所有亚毫秒级的结论都是错的——包括 KV 那 3.6ms，单测的话它和 0 分不开。

采集流程：每个 target 打 3 轮，每轮 60 次（写操作 30 次），**丢弃第一轮**（isolate 预热），合并后两轮算分位。最终每项 120 次调用（写操作 60 次）。

对照组 `SELECT 1` 是关键。它不碰任何表、不需要解析、不需要 IO，只走一次 D1 的网络往返。它测出来的数就是「固定成本」的底。

## 二、D1：44ms 里，查询本身只占 1ms

把四类查询和对照组放一起看：

| 查询 | p50 | 与 `SELECT 1` 的差 |
|---|---|---|
| `SELECT 1 AS x` | 44.4ms | — |
| `SELECT id, title FROM posts WHERE slug = ?` | 43.8ms | −0.6ms |
| 10 行 + `ORDER BY` | 44.0ms | −0.4ms |
| `GROUP BY category` 聚合 | 43.4ms | −1.0ms |
| 单行 `UPDATE` | 43.2ms | −1.2ms |

差值是负的。也就是说，这四类真实查询**比空查询还快一点点**——纯粹是噪声，量级 1ms 左右的抖动。落在同一区间里，分不出谁更贵。

这就是 D1 的成本结构：**每一次 `await env.DB.prepare(...)` 都是一次独立的网络往返，往返本身 44ms，查询在里面花的时间是小头。**

官方文档里说「有索引的单行查询 SQL 时长不到 1ms」，这跟我量到的完全对得上——SQL 时长确实不到 1ms，但你在 Worker 里等的是 44ms。那 43ms 花在序列化、排队、跨机房传输上，跟你的 SQL 写得好不好无关。

所以优化方向只有一个：**把多次查询压成一次往返。**

本站文章页原来是这样拿数据的：

```js
// 改之前：5 次 await = 5 次往返 = 220ms 的固定成本
const post = await env.DB.prepare('SELECT ... FROM posts WHERE slug = ?').bind(slug).first();
const tags = await env.DB.prepare('SELECT ... FROM tags WHERE post_id = ?').bind(post.id).all();
const cmts = await env.DB.prepare('SELECT ... FROM comments WHERE post_id = ?').bind(post.id).all();
const sers = await env.DB.prepare('SELECT ... FROM posts WHERE series = ?').bind(post.series).all();
const site = await getSite(env);
```

改成一次 `Promise.all` 并发、并且用 `slug` 直接关联（不再先查 `post.id` 再用 id 查别的），依赖深度从 2 掉到 1：

```js
// 改之后：1 次并发 = 1 次往返窗口
const [post, tagRes, cmtRes, seriesRes, site] = await Promise.all([
  env.DB.prepare(`SELECT p.*, u.name AS author_name FROM posts p
    LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`).bind(slug).first(),
  env.DB.prepare(`SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
    JOIN posts p ON p.id = pt.post_id WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE p.slug = ?`).bind(slug).all(),
  env.DB.prepare(`SELECT ... FROM posts WHERE series =
    (SELECT series FROM posts WHERE slug = ?)`).bind(slug).all(),
  getSite(env),
]);
```

实测下来页面 TTFB 从 127ms 掉到 86ms。掉的那 41ms 正好等于一次往返——数字对得上，说明这个模型是对的。

## 三、KV：3.6ms 和 265ms 是同一个产品

| 场景 | p50 | p95 | 说明 |
|---|---|---|---|
| 读一个存在的 key（反复读同一个） | 3.6ms | 4.2ms | 命中边缘 |
| 读一个随机 key（必然不存在） | 265.4ms | 294.6ms | 回中央存储 |

73 倍。而且注意 p95 只有 4.2ms——命中路径几乎没有抖动，它就是内存读。未命中那 265ms 也不是「慢」，是「跑了一趟远的」。

这解释了一件很多人误解的事：**KV 不是数据库，是「带全局复制的配置缓存」。**

它的读性能取决于命中率：
- 热 key（首页配置、功能开关、限流计数器）→ 3.6ms，比 D1 快一个数量级
- 冷 key（每个用户一份、每个请求一个新 key）→ 265ms，比 D1 慢 6 倍

写更离谱：

| 操作 | p50 | p95 |
|---|---|---|
| KV PUT（每次新 key） | 560.4ms | 605.0ms |
| D1 单行 UPDATE | 43.2ms | 49.0ms |

KV 写入比 D1 慢 13 倍。原因是 KV 的写不是「写入一个地方就返回」，是写到一个中心点然后异步扩散到全球边缘——它优化的目标是「写完很久之后，全世界读都很快」，不是「写完立刻能读到」。

所以 KV 的三个用法边界很硬：

| 用法 | 行不行 | 原因 |
|---|---|---|
| 站点配置、主题开关 | 行 | 读极热、写极冷，典型 1:10000 |
| 限流计数器 | 行，但注意同 key 1 次/秒 | 免费版写 1000 次/天 |
| 会话存储 | 勉强 | 每次请求读一次，命中率看用户活跃度；写 560ms 意味着登录会明显卡 |
| 每次请求一个新 key 的缓存 | 不行 | 命中率 0，等于每次 265ms |
| 评论数、点赞数这种高频写 | 不行 | 560ms × 每次写，且免费版 1000 次/天 |

同 key 每秒只能写 1 次，这条限制在本地压测里很容易被忽略——我第一次测 KV 写入时就是同一个 key 连写 100 次，结果全是失败重试，白跑一轮。换成每次新 key 才测出上面那个数。

## 四、R2：76ms 的读，279ms 的写

| 操作 | p50 | p95 | max |
|---|---|---|---|
| HEAD（只查元信息） | 74.0ms | 92.4ms | 93.2ms |
| GET 1KB | 76.2ms | 87.0ms | 87.4ms |
| PUT 1KB | 279.2ms | 684.4ms | 684.4ms |

两个反直觉点：

**HEAD 和 GET 只差 2ms。** 说明 76ms 里几乎没有「传数据」的成本，全是往返和元数据查询。1KB 和 1MB 的 GET 在这个量级下不会有本质差别——这也是为什么 R2 适合存大文件：**小文件反而不划算**，你为每个小文件付了同样的 76ms。

**PUT 的 p95 是 p50 的 2.4 倍。** 写操作抖动最大，684ms 的尾部延迟意味着上传图片时必须异步、必须有重试。用户点「上传」后等 684ms 才拿到成功，体验上是能感知的卡顿。

本站的图片链路是：上传走 R2 直传（签名 URL，前端直连，不经过 Worker），读取走 `/img/` 代理 + 边缘缓存。这个设计现在有了数字支撑：

| 方案 | 单次成本 | 结论 |
|---|---|---|
| Worker 每次读 R2 再返回 | 76ms + 传输 | 每张图都付 76ms，首屏 5 张图 = 380ms |
| Worker 读 R2 + `cacheEverything` | 首次 76ms，之后边缘命中 | 只有冷启动付一次 |
| 上传走 Worker 中转 | 279ms（p95 684ms） | 大文件会撞 CPU 和请求体限制 |

## 五、选型：按延迟排，不按「产品定位」排

很多人选存储是看「D1 是数据库所以放数据、KV 是缓存所以放缓存、R2 是对象存储所以放文件」。这个顺序没错，但理由经常是错的。按实测延迟重排：

| 需求 | 该选 | 实测依据 |
|---|---|---|
| 亚毫秒、读极热写极冷、key 数量有限 | KV | 命中 3.6ms，比 D1 快 12 倍 |
| 有关系、要事务、要 JOIN、要聚合 | D1 | 44ms 固定成本，查询复杂度几乎免费 |
| 大文件、一次写多次读、出网免费 | R2 | 读 76ms 但按 GB 计费极便宜 |
| 高频写（计数、日志、状态机） | D1 | 写 43ms vs KV 560ms vs R2 279ms |
| 每次请求都是新 key 的缓存 | 别用 KV | 未命中 265ms，不如直接查 D1 |

一句话版本：**KV 和 D1 的延迟差 12 倍，但只有在 key 命中时才成立。选错存储的代价不是「慢一点」，是「慢 6 到 70 倍」。**

再补一条容易被忽略的：这三种存储的调用**都算 subrequest**。免费版一次调用 50 个，一个页面上 5 个 D1 查询 + 3 张图读 R2 = 8 个，看着宽裕，但如果你在循环里查数据库，50 很快就见底，而且报错是 `Too many subrequests`，不是你以为的数据库错误。

## 六、怎么自己验一遍

不需要我这份数据，你自己十分钟能跑出来。步骤：

1. 建一个临时 Worker，绑你现有的 D1、R2，再 `wrangler kv namespace create BENCH` 建一个 KV。
2. 把 `timeIt` 那段抄进去，注意必须是**5 次一组摊平**，不要单次测。
3. 加一个 `SELECT 1` 的对照组。没有对照组，你分不清 44ms 是查询贵还是往返贵。
4. 每个 target 打 3 轮，**丢掉第一轮**。第一轮含 isolate 冷启动，混进去 p95 会虚高。
5. 写完把 Worker 删掉、KV 命名空间删掉，别留着——它会一直吃你的免费额度。

完整的测量代码留在 `content/bench-data.md` 和 `bench/` 目录里，包括我踩过的两个坑：`performance.now()` 量化、KV 同 key 写限速。下次要复测，改一下 target 列表就能跑。

相关：把多次查询压成一次的具体改法，在[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)；缓存三层各自的口径在[《三层缓存怎么排》](/p/three-layer-cache)。
