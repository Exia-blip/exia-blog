## 结论

同一个月里，我被三个问题绊过。

第一个在 SEO：结构化数据里 `isPartOf` 一直指向文章自己，8 篇系列文全中。

```json
"isPartOf": {
  "@type": "CreativeWorkSeries",
  "name": "OAuth 授权流程拆解",
  "url": "https://exia.de5.net/p/oauth-pkce"
}
```

`/p/oauth-pkce` 属于一个叫"OAuth 授权流程拆解"的系列，而这个系列的地址就是它自己。从系列机制上线那天写进去，到被发现中间隔了三周。页面返回 200，富媒体测试工具报的是"未检测到富媒体内容"——那不是错误，是这类页面本来就没有富媒体，它也看不出 `isPartOf` 指回了自己。只有把 JSON-LD 展开一行行看，才发现关系网断了一角。

第二个在性能：Worker 渲染 549ms。`tail` 里 CPU 一直是 5ms 上下，剩下的时间像幽灵。后来把旧提交部署成独立 Worker、两个 `tail` 同时抓、请求交替发，才看清 549 里约 370 是冷启动，另一块是五次串行往返在排队——改代码能省的只有其中 96ms。

第三个在样式：目录滚过 336px 就跟着文章一起出了视口。不是 `sticky` 写错，是 grid 那一格 `align-items` 用了 `start`，高度只有 336px，`sticky` 失去参照。改回 `stretch` 之后，同一篇文章、同一份 CSS，那一格是 12939px。

三个问题分属三个领域，修法也毫无关系。但它们的共同点只有一条：**都通过了人工检查**。

肉眼扫过 JSON-LD，自指看不出来；`wrangler tail` 是调试工具不是基线，冷启动和缓存一混就失真；样式靠人眼验收，而 `--muted` 对比度落到 4.16、图片缺 `width`/`height` 这件事，眼睛根本不参与判断。

于是结论不是"下次仔细点"，而是"下次别用眼睛"。这篇文章记录的是我把三类检查分别变成断言、装进 CI 的过程——以及一个副作用：现在每踩一个坑，我会先给它编个号。

做完之后手里剩下三条规矩，按重要性排：

| 规矩 | 具体做法 | 抓的是什么 |
|---|---|---|
| 断错误的形状，不断期望值 | `ok(!art.isPartOf.url.includes(art.url.split('/p/')[1]))` | 自指这种"语义对不对"的错，实现怎么改都挡得住 |
| 基线首次只写不 fail | `scripts/.size-baseline.json` 首次运行落盘、退出 0，下一轮起才守 | 新断言上线第一分钟就红，人就会把它调松 |
| 文档与断言双向对账 | 脚本里的编号必须在文档有条目，反之只警告 | 断言写完了没人知道它守什么，半年后等于没有 |

三条都不是新技术，就是 `assert` + `fs` + 正则。难的从来不是写断言，是决定**该断哪一句**、**阈值取多少**、**失败时让谁紧张**。

## 一、根因：验证方式和错误类型不匹配

根因不是粗心。是这三个问题各自的验证方式，对它们都不敏感：

| 问题 | 原来的验证方式 | 为什么抓不到 |
|---|---|---|
| 自指 | 肉眼扫 JSON-LD | 自指 url 能打开、返回 200，视觉上完全合法 |
| 549ms | `wrangler tail` 看单次 | tail 是调试工具不是基线，冷启动和缓存状态一混就失真 |
| sticky | 人眼验收 | 写到一半的页面目录本来就不该吸顶，看不出是"缩了"还是"没写" |
| 对比度 | 人眼验收 | `--muted` 落在 `--bg-soft` 上是 4.16，眼睛分不出 4.16 和 4.5 |
| 图片尺寸 | 人眼验收 | 缺 `width`/`height` 在宽带下几乎不产生位移 |

把错误按"现成工具够不够"分层，就很清楚哪一层只能自己写：

| 层次 | 例子 | 现成工具够不够 |
|---|---|---|
| 语法 | 多一个逗号，`JSON.parse` 直接抛 | 够 |
| 引用 | `isPartOf.url` 返回 404 | 够，爬虫点一下就知道 |
| 语义 | 自指、`position` 与实际次序不符、`headline` 与 `<h1>` 不一致 | **只有自己写断言** |
| 回归 | 体积涨了 12%、对比度掉到 4.4、图片少了尺寸 | **只有自己写断言** |

还有一层更实在的原因：`postLd()` 这个函数从来没有测试。十几篇文章上线，它输出的五个字段全靠肉眼。它不是被什么巧妙的方式绕过的，是**根本没有检查这一层**。

一句话：人工检查只能覆盖"你想到要检查"的部分。**只有写断言才抓得到。**

## 二、复现条件

三个都能稳定复现，这是能写断言的前提：

| 问题 | 触发条件 | 判定点 |
|---|---|---|
| `isPartOf` 自指 | 任意带 `series` 字段的文章 | HTML 里 JSON-LD 的 `isPartOf.url` 是否等于当前文章 URL |
| 对比度不足 | 窄屏 + 深色模式 | `--muted` 落在 `--bg-soft` 上，算相对亮度比 |
| CLS 0.0176 | 窄屏、长文、导航登录格由 JS 填内容 | 图片无尺寸 / 首屏占位容器未预填 |
| sticky 失效 | grid 那格写了 `align-items: start`，父格高度不足 | 包含块高度 vs 视口高度 × 2 |

sticky 那条最挑。`.post-article` 是 grid，目录那一格写了 `align-items: start`——Grid 默认值是 `stretch`，`start` 是写卡片列表时留下的肌肉记忆。放到两栏布局上，它让目录格的高度等于自身内容高度，**336px**。包含块只有 336px 高，滚过 336px 目录就跟着文章出了视口。

复现的关键不是"哪个属性写错了"，而是**要做 A/B**：同一篇文章、同一份 CSS，只把这一个属性改回 `stretch`，再量一次。不然你永远不知道 336px 是"页面就长这样"还是"被压扁了"。

## 三、修法：三层，按成本排序

### 第一层：构建期断言，零成本

最便宜的一层，纯读磁盘，几十毫秒。

`scripts/check-size.mjs` 守样式表体积。这里有个必须先说清的坑：**预算不能照抄别人的**。我拿到过一份很完整的方案，写的是"gzip ≤ 3KB、未压缩 ≤ 12KB"，我照着侦察了一轮——本站 `public/style.css` 实测原始 142039 字节、`gzip -9` 后 37626 字节，差 12 倍。那张表覆盖 455 个类名、5 套独立主题、后台全套、代码块、灯箱、评论、编辑器；压到 3KB 等于重写整套视觉系统，不是优化。取舍的完整过程在[样式表做减法那篇](/p/css-minimal-set-tradeoffs)。

落到断言上是两套口径同时守：

```text
绝对值守底：style.css gzip-9 ≤ 39000 B
基线守增长：任何文件比 scripts/.size-baseline.json 大 >10% 就 fail
第三条：主样式必须是 LF 行尾
```

关键在于**基线第一次出现时怎么处理**：

```js
if (writeBaseline || !base) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  log('· 已写入基线（本次不因增长判失败）');
  base = current;
}
```

第一次运行写入基线、退出码 0；基线提交进仓库之后，CI 才开始守。这不是宽松，是**给基线一个被审过的机会**。如果第一次就 fail，人会做两件事之一：把阈值调到刚好通过，或者把基线文件删掉重来——两种都让这道断言失去意义。

试过一版写死 38000、只留 1% 余量，跑通之后立刻发现撑不过一周：动一行 CSS 就红，红几次人就会调大，调大之后阈值形同虚设。

LF 那条也不是凑数。行尾决定字节，字节决定内容哈希，本地 CRLF、CI checkout 出 LF，就会出现"本地体积绿、CI integrity 红"，见[CRLF 那篇](/p/crlf-sri-ci-red)。

主题文件守的是**原始字节**，主样式守的是 **gzip**。两套口径不是疏忽：主题文件小到 gzip 后差异不足 100 字节，压缩比波动能盖过真实增长；主样式大，gzip 才是浏览器实际收到的字节数。

### 第二层：渲染后断言，不引浏览器

`scripts/check-dom.mjs` 不引 jsdom、不引 playwright，用正则做结构化判定。9 条：

```text
唯一 h1 / viewport 允许缩放 / 图片含 width-height 或内联 aspect-ratio
无首屏异步占位 / 跳到正文链接 / 搜索框 aria-label
分页 nav 语义 / aria-current="page" / 无外部阻塞资源
```

第四条（无首屏异步占位）是专门为 CLS 那次写的回归断言。登录格原来是客户端填充，首屏渲染完再塞内容，窄屏上一次推 182px。如果哪天又改回客户端填充，这一行会红。

这一层选正则不选 jsdom，理由是**前置条件**。引 jsdom 就要维护一份 DOM 模拟，引 playwright 就要装浏览器，两种都会让"改一行跑一次"变成"改一行等半分钟"。正则做不到通用 DOM 校验，但对自己的 SSR 输出够用——模板是我写的，形状是我定的。

有一条真缺过：搜索框 `aria-label`。9 条里跑出来唯一一个 FAIL，补完重新部署才好。断言的价值就在这里，它不挑你心情。

### 第三层：对比度断言

`scripts/check-contrast.mjs` 按 WCAG 相对亮度算，正文 ≥ 4.5、大字 ≥ 3。14 组主题 × 9 对真实存在的 fg/bg 组合，共 126 个比值。

**只列真实存在的组合，不做全排列。** 全排列会产出上百个页面上根本不出现的告警，脚本跑一次刷一屏红，两次之后就被注释掉了。现在的最小值是 4.51，贴着线但过——这正是想要的：贴着线说明阈值真有约束力，而不是随手定个 3 万事大吉。

修之前有 12 组 `--muted` 落在 4.16~4.49，全部踩线。这个数字人眼分不出来，改了 14 组色值才拉上来。

### 补一条：断错误的形状，不断期望值

前面三层断的都是"值"，语义错断不了。这块是[结构化数据自指那篇](/p/ld-self-reference)留下的账——那篇结尾写了"这一类错误只有专门写断言才抓得到"，当时只补了 5 条单测、修了线上 8 处自指，没变成一套能反复用的做法。补的第一组用例在 `scripts/test-seo-series.mjs`，5 条，其中 4 条是常规的"等于某个值"：

```js
test('isPartOf 指向 /series/<名称>，不是文章自己', () => {
  // postLd 只吃一个对象参数，返回值是 @graph，文章节点在 [0]
  const art = postLd({ site, origin, url, post: { ...post, series: 'OAuth 授权流程拆解' } })['@graph'][0];
  equal(art.isPartOf.url, `${origin}/series/${encodeURIComponent('OAuth 授权流程拆解')}`);
  ok(!art.isPartOf.url.includes(art.url.split('/p/')[1]), 'url 不能包含自己的 slug');
});
```

最后那行是整个文件里唯一有价值的一条。前一行会随实现漂移——哪天把系列页从 `/series/<名称>` 改成 `/s/<id>`，断言就红，但那不是 bug，是我主动改的设计。后一行断的是**这类错误的形状**：`isPartOf` 指向的地址不能包含文章自己的 slug。不管地址怎么变，自指永远违反这一条。

线上体检脚本 `scripts/check-ld.mjs` 用同一套思路，逐篇抓 sitemap 里的文章、验四件事：

```text
1. JSON.parse 能通过（一个多余逗号就让整块失效，页面看不出异常）
2. BlogPosting.headline === 页面 <h1>
3. isPartOf.url 真的能打开（404 比不写更糟）
4. position 与该文在系列页里的实际次序一致
```

第 4 条要把系列页里所有文章的次序抓下来、再回头对每篇的 `position`，两遍请求。刚接进 CI 时报过"页面没有结构化数据"，我差点去改页面——真实情况是**采集正则写错了**：

```js
// 错：假设 type 属性排在 class 前面
/<script class="[^"]*" type="application\/ld\+json">/
// 对：属性顺序不固定
/<script[^>]*type="application\/ld\+json"[^>]*>/
```

报错的方向比错误本身更值得记：**断言失败说"没有结构化数据"，真实情况是"我的采集坏了"**。顺着这个报错去改页面，就会修一个不存在的问题。写采集脚本时把"抓到 0 块"和"抓到但解析失败"分开报错，比统一报"校验失败"有用得多。

### 三层怎么接进 CI

不是一条大链，是分开的几步：

```text
npm test            → test-seo-series / test-css-budget / test-parallelism / check-pitfalls
npm run check:a11y  → check-contrast.mjs
npm run check:size  → check-size.mjs（体积基线）
npm run check:dom   → check-dom.mjs（需 SSR 页面）
npm run check:pitfalls → check-pitfalls-002-005.mjs + check-pitfalls.mjs
npm run check:browser  → 起本地 Worker + 灌 D1 夹具 → css-baseline / dom / ld
```

分这么多步是因为**每层的前置条件不一样**。纯文本断言秒级无依赖，进 `npm test`；体积断言读磁盘，进 `check:size`；computed style 和线上体检要真服务，进 `check:browser` 或手动跑。把所有断言塞进一条命令，结果是本地跑一次要起 Worker、灌夹具、连线上，然后人就不跑了。

体积守完还有一层 computed style 基线（`scripts/check-css-baseline.mjs`），在真浏览器里量：body 背景 alpha 必须为 1、h1 字号 ≥ 24px、`--accent` 有值、主样式表已加载。为什么还要这层？CSS 解析成文本之后，你只能证明"规则还在文件里"。样式表 404、变量被覆盖、主题错配——这几种情况规则文本都是对的，只有浏览器量出来的值会变。

h1 阈值写 24px 而不是方案建议的 28px，理由是实测：首页 h1 27px、文章页 30px。照抄 28px，CI 第一次就红，然后我会被迫改字号，改字号就改布局——从"加断言"滑向"为了断言改样式"。24px 能抓住"CSS 全挂、回落到浏览器默认 16px"这种情况，正常状态离它有 3px 余量。

## 四、实测数字

| 指标 | 修前 | 修后 | 口径 |
|---|---|---|---|
| Worker 渲染（冷 + 串行） | 549ms | — | `Server-Timing: cfWorker`，冷启动约 370ms，不是代码问题 |
| Worker 渲染（热 + 串行） | 180ms | 84ms（−96） | `/cat/tools`，10 轮交替取中位 |
| 同批另一个栏目页 | 207ms | 148ms（−59） | `/tag/cloudflare` |
| 单往返接口 | — | 51ms（CPU 2ms） | 反推单次往返 ≈ 32ms |
| 缓存命中路径 | 84ms | **4ms（CPU 0）** | `caches.default` 命中，Worker 仍跑 |
| CPU 时间 | 5/5/6/7ms | 5/6/7/9ms | 两版中位相同，**一毫秒没省** |
| `/archive` | 175ms | 170ms（−5） | 本来就只有两次往返 |
| 文章页 | 115ms | 117ms（±0） | 查询数没变 |
| CLS | 0.0176 | 0 | 窄屏长文，少推 182px |
| `.post-toc` 包含块高度 | 336px | 12939px | 只改 `align-items: start` → `stretch` |
| 目录顶端（滚 35% / 60%） | −4172 / −7224 | 86 / 86 | 两次量点都停在 86px |
| 对比度踩线组 | 12 组落 4.16~4.49 | 126 个比值全过，最小 4.51 | 14 组 × 9 对 |
| 主样式体积 | 142039 B 原始 / 37626 B gzip | 上限 39000 B + 基线 +10% | Node `zlib.gzipSync` level 9 |
| `isPartOf` 自指 | 8 篇 8 段 | 0 | 补断言后归零 |

**549 这个数字要单独说一句**，因为它最容易被当成战果。549 和 96 之间隔着两个变量：一个冷启动转热，一个是代码改动。混在一起说"我只改了一件事就把 549 变成 96"，是拿两个不同实验的结果互相背书。真正靠代码省掉的是那 96ms，而且是对比 180 → 84 得出来的。

对照方法：把旧提交部署成独立 Worker，两个 `tail` 同时抓，请求交替发。交替是为了抵消时间漂移——CF 边缘负载、我这线路的抖动都会随时间变。一次跑完 "旧的 N 发、新的 N 发" 是错的做法，两边时间窗口不同。10 轮取中位，才得出 180 → 84。

CPU 那一行是这套方法最有说服力的部分。**CPU 一毫秒都没省，省的 96ms 全是等待**：三次往返被叠成了一次。如果只贴"509ms 优化到 96ms"，读者会以为我写了多聪明的代码；实际是三个 `await` 改成 `Promise.all`，加上把 COUNT 和列表查询同批发出。

## 五、文档与断言双向绑定

断言多了之后，新问题不是"没写"，是"写完了没人知道它守什么"。

`PITFALLS.md` 每条固定五字段：现象、根因、复现、断言、出处。编号 `P-NNN` 分配后永不复用，17 条，`P-001` 到 `P-017`。

`scripts/check-pitfalls.mjs` 做双向对账，两个方向的处理完全不同：

```js
const missing = [...scripted].filter((x) => !documented.has(x));
const orphan  = [...documented].filter((x) => !scripted.has(x));
// missing → fail：断言里冒出没登记的编号，说明有人在暗处加了断言没写文档
// orphan  → WARN：文档有条目但没人引用，那是"已知但未自动化"，不该卡 CI
```

不对称是有意的。**有断言没文档**是欠账：半年后看到 `[P-014] FAIL`，得翻遍代码才知道它守什么。**有文档没断言**是明说的边界：文章末尾写了"这条没做"，读者知道，我也知道，它不该让 CI 变红。

这里踩过一次：第一次跑对账时 P-001（sticky 在 grid 里失效）被识别成 orphan，退出码 0。原因不是文档错了，是那条断言在 `check-toc-sticky.mjs` 里只跑真浏览器，静态扫描扫不到 `P-001` 字样。处理办法是把"真机断言"的编号登记方式写进文档，让对账脚本扫得到，而不是把警告级别提到 fail。

失败分支也验过：把脚本里一个编号改成不存在的 `P-999`，退出码立刻变 1。**没验证过会失败的断言，和没写一样**——这条适用于所有断言，包括断言断言本身的那个。

`P-002`~`P-005` 这四条（图片尺寸、首屏占位、查询并行、日志字段）是最后补的，写在 `scripts/check-pitfalls-002-005.mjs` 里，扫 `public/` 的 HTML 和 `src/` 的源码，零依赖、不到 100ms。接入流程是先在 CI 外面单跑：8 个 HTML、30 个源码文件，7 条断言全过，没有误报；再把一条条件改成恒假，退出码 1，恢复。全部跑干净之后才进 `npm test`。

第一次跑 002-005 真抓到过一处：`P-003` 那条的判定偏宽松——找不到目标容器时按通过计。本站 public 模板里 0 处占位容器，所以按通过走，但这是个真边界，写进了 PITFALLS 的"明说的没做"。

## 六、明说的没做

| 边界 | 现状 | 为什么没做 |
|---|---|---|
| 语义断言不能穷举 | 只覆盖 `isPartOf` / `position` / `headline` 三类 | 语义错误没有完备判据，写多少都有漏。这类断言是"踩一个补一个"，不是一次做完 |
| `P-003` 判定偏宽松 | 找不到目标容器时按通过计 | 避免误伤改版中的页面。想严格就改成"找不到即失败"，代价是每次改版都要先补容器 |
| 对比度只覆盖 CSS 变量 | `<img>` 的 alt 文本、焦点可见性仍靠人工 | 相对亮度公式只对"已知 fg/bg"有效，alt 的底色取决于图片本身，算不出来 |
| 没有视觉回归截图 | 样式塌了只有断言能兜 | 截图对比要维护基线图、要容忍渲染抖动，成本比收益高。现在靠 computed style 基线兜最关键的几个值 |
| 体积基线只挡变大 | `+10%` 单向阈值 | 变小可能是好事（真优化），也可能是坏事（样式被误删）。后者由 computed style 基线挡，不靠体积 |
| orphan 只警告 | 不 fail | 有些坑确实只能靠人记，比如"主题切换要 simulate no-preference"。变成 fail 会逼出假断言 |

还有一条是效率取舍：`check:browser` 每次要起 Worker、灌 D1 夹具，一轮几十秒，只适合提交前跑。"改一行跑一次"靠的是 `npm test` 里的纯文本断言——它们如果哪天也变成需要起服务，这套分工就垮了。

最后回到那篇自指文章的原话：**语法对的、引用活的、语义错的**。这一类错误不会自己消失，也不会被更聪明的工具替你发现。你只能决定要不要写那一行 `assert`。

## 怎么自己验一遍

前五步不用起服务：

```bash
# 1. 语义断言的形状：故意自指，看断言能不能红
node -e "import('./src/seo.js').then(({postLd})=>{const o='https://x',g=postLd({site:{name:'B'},origin:o,url:o+'/p/x',post:{slug:'x',title:'T',series:'S',series_order:1}})['@graph'][0];console.log(g.isPartOf.url,'| position',g.position)})"
# 期望：https://x/series/S | position 1 —— 不含 /p/x

# 2. 体积基线：首次写基线，第二次起守增长
node scripts/check-size.mjs --write-baseline
cp scripts/.size-baseline.json /tmp/base.bak
node scripts/check-size.mjs                       # 期望全 pass
node -e "const f='scripts/.size-baseline.json',j=require('./'+f);j['style.css']=1;require('fs').writeFileSync(f,JSON.stringify(j))"
node scripts/check-size.mjs                       # 期望 exit 1
cp /tmp/base.bak scripts/.size-baseline.json

# 3. 对比度：126 个比值
node scripts/check-contrast.mjs                   # 期望 14 组通过 / 0 组踩线

# 4. 文档双向对账 + 静态断言
node scripts/check-pitfalls-002-005.mjs public    # 期望 7/7，exit 0
node scripts/check-pitfalls.mjs                   # 期望 exit 0

# 5. 全量单测（纯 Node，无浏览器）
npm test
```

第 2 步是唯一会改文件的：先把基线备份，改完还回去。这一步的意义是让你亲眼看到那条断言真的会红——一个从来没红过的阈值，你不知道它到底在守什么。

#debugging #css #seo #workers
