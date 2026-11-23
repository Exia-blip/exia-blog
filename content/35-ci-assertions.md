## 结论

这篇是[结构化数据自指那篇](/p/ld-self-reference)的直接续篇。那篇结尾留了一句"这一类错误只有专门写断言才抓得到"，当时只兑现了一半——补了 5 条单测、修了线上 8 处自指。另一半是把它变成一套能反复用的做法，而不是每次踩坑都临时写一个脚本。

做完之后我手里有三条可复用的规矩，按重要性排：

| 规矩 | 具体做法 | 抓的是什么 |
|---|---|---|
| 断错误的形状，不断期望值 | `ok(!art.isPartOf.url.includes(art.url.split('/p/')[1]))` | 自指这种"语义对不对"的错，实现怎么改都挡得住 |
| 基线首次只写不 fail | `--write-baseline` 落 `scripts/.size-baseline.json`，下一轮起才守 | 新断言上线第一次就红，人就会把它调松 |
| 文档与断言双向对账 | 脚本里的编号必须在文档有条目，反之只警告 | 断言写完了没人知道它守什么，半年后等于没有 |

三条都不是新技术，就是 `assert` + `fs` + 正则。难的从来不是写断言，是决定**该断哪一句**、**阈值取多少**、**失败时让谁紧张**。

## 一、现象：语法全对、链接全活，语义是错的

先复述一下起点，因为它决定了后面所有断言的形状。

11-14 那天我在做别的事，顺手抓了一篇文章的 JSON-LD，看到这一段：

```json
"isPartOf": {
  "@type": "CreativeWorkSeries",
  "name": "OAuth 授权流程拆解",
  "url": "https://exia.de5.net/p/oauth-pkce"
}
```

`/p/oauth-pkce` 这一篇，属于一个叫"OAuth 授权流程拆解"的系列，而这个系列的地址就是它自己。四篇系列文，四段一模一样的自指。从系列机制上线那天写进去，到被我发现，中间隔了三周。

它躲过所有现成检查的理由很具体：自指 url 是一个**能打开、返回 200 的合法地址**。所有靠"链接是否可达"判断的检查都会放行，人工点开也看不出异常，JSON-LD 本身又不渲染给人看。

三类错误摊开看就清楚为什么只有一类要自己写：

| 层次 | 例子 | 现成工具够不够 |
|---|---|---|
| 语法 | 多一个逗号，`JSON.parse` 直接抛 | 够，很多校验器都查 |
| 引用 | `isPartOf.url` 返回 404 | 够，爬虫点一下就知道 |
| 语义 | 自指、`position` 与实际次序不符、`headline` 与 `<h1>` 不一致 | **只有自己写断言** |

第三个原因最实在：`postLd()` 从来没有测试。15 篇文章上线，这个函数输出的五个字段全靠肉眼。它不是被什么巧妙的攻击绕过的，是**根本没有检查这一层**。

## 二、第一规矩：断错误的形状，不断期望值

补的第一组用例在 `scripts/test-seo-series.mjs`，5 条。其中 4 条是常规的"等于某个值"：

```js
test('isPartOf 指向 /series/<名称>，不是文章自己', () => {
  const art = postLd({ ...post, series: 'OAuth 授权流程拆解' }, origin);
  equal(art.isPartOf.url, `${origin}/series/${encodeURIComponent('OAuth 授权流程拆解')}`);
  ok(!art.isPartOf.url.includes(art.url.split('/p/')[1]), 'url 不能包含自己的 slug');
});
```

最后那行是整个文件里唯一有价值的一条。前一行"等于某个期望值"会随实现漂移——哪天我把系列页从 `/series/<名称>` 改成 `/s/<id>`，断言就红，但那不是 bug，是我主动改的设计。后一行断的是**这类错误的形状**：`isPartOf` 指向的地址不能包含文章自己的 slug。不管系列页地址怎么变，自指永远违反这一条。

这个区别在"语义错误"上特别关键。语法错和引用错都有稳定的期望值（合法 JSON、200），所以断言"等于 X"很自然。语义错的期望值本身会跟着产品走，但它的**错误形状**是固定的：自己指向自己、序号和次序不符、标题和正文不一致。断形状，实现改了断言还活着；断期望值，改一次设计就得重写一次断言，重写几次人就懒得写了。

线上体检脚本 `scripts/check-ld.mjs` 用了同一套思路，逐篇抓 sitemap 里的文章、验四件事：

```text
1. JSON.parse 能通过（一个多余逗号就让整块失效，页面看不出异常）
2. BlogPosting.headline === 页面 <h1>（改标题忘了改模板时这里会炸）
3. isPartOf.url 真的能打开（404 比不写更糟）
4. position 与该文在系列页里的实际次序一致
```

其中第 4 条是最容易写错的：它要先把系列页里所有文章的次序抓下来，再回头对每篇文章的 `position`，两遍请求。刚接进 CI 时有一次报"页面没有结构化数据"，我差点去改页面——真实情况是**我的采集正则写错了**：

```js
// 错：假设 type 属性排在 class 前面
/<script class="[^"]*" type="application\/ld\+json">/
// 对：属性顺序不固定
/<script[^>]*type="application\/ld\+json"[^>]*>/
```

报错的方向比错误本身更值得记：**断言失败说"没有结构化数据"，真实情况是"我的采集坏了"**。如果这时候顺着报错去改页面，就会去修一个不存在的问题，越修越乱。写采集脚本时给"抓到 0 块"和"抓到但解析失败"分开报错，比统一报"校验失败"有用得多。

## 三、第二规矩：基线首次只写不 fail

第二条来自体积断言。我最初的设计很直接：`gzip -9 public/style.css | wc -c`，超过 3072 就 fail。侦察之后发现本站实测 37626 字节，差 12 倍——预算本身就不对，见[样式表做减法那篇](/p/css-minimal-set-tradeoffs)。

改成按实测定之后，新问题来了：阈值怎么写才不会变成噪音？

试过一版写死 38000，只留 1% 余量。跑通之后立刻发现这数字撑不过一周——以后动一行 CSS 就红，红几次人就会把它调大，调大之后阈值形同虚设。最后落地的方案分两层：

```text
绝对值守底：style.css gzip-9 ≤ 39000 B（余量 3.7%）
基线守增长：任何文件比 scripts/.size-baseline.json 大 >10% 就 fail
```

关键在基线第一次出现时的处理：

```js
if (writeBaseline || !base) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  log('· 已写入基线（本次不因增长判失败）');
  base = current;
}
```

第一次运行写入基线、退出码 0；基线提交进仓库之后，CI 才开始守。这不是宽松，是**给基线一个被审过的机会**。如果第一次就 fail，人会做两件事之一：要么把阈值调到刚好通过，要么把基线文件删掉重来——两种都让这道断言失去意义。

现在的基线长这样：

| 文件 | gzip-9 字节 | 上限 |
|---|---|---|
| `style.css` | 37626 | 39000 + 基线 +10% |
| `forest.css` | 796 | 原始 2000 |
| `ink.css` | 676 | 原始 2000 |
| `mono.css` | 657 | 原始 2000 |
| `ocean.css` | 610 | 原始 2000 |
| `plum.css` | 691 | 原始 2000 |

注意主题文件守的是**原始字节**，主样式守的是 **gzip**。两套口径不是疏忽：主题文件小到 gzip 后差异不足 100 字节，压缩比波动就能盖过真实增长；主样式大，gzip 才是浏览器实际收到的字节数。

体积断言还有第三条：`主样式必须 LF 行尾`。这条不是凑数——行尾决定字节，字节决定内容哈希，见[CRLF 那篇](/p/crlf-sri-ci-red)。体积预算和内容哈希共用一个字节口径，才不会出现"本地体积绿、CI integrity 红"。

体积守完还有一层 computed style 基线（`scripts/check-css-baseline.mjs`），在真浏览器里量：

```text
body 背景不透明（rgba alpha === 1）
h1 字号 ≥ 24px
--accent 有值
主样式表已加载
```

为什么还要这一层？CSS 解析成文本之后，你只能证明"规则还在文件里"。样式表 404、变量被覆盖、主题错配——这几种情况规则文本都是对的，只有浏览器量出来的 computed 值会变。

阈值按实测定，不按建议定。方案写的是"h1 ≥ 28px"，但本站首页 h1 实测 27px、文章页 30px。照抄 28px，CI 第一次就红，然后我会被迫改字号，改字号就改布局——从"加断言"滑向"为了断言改样式"。取 24px 的理由是：CSS 全部加载失败时 h1 回落到浏览器默认 16px，24px 能抓到；正常状态离它有 3px 以上余量，不会误报。

背景只断 alpha、不断具体颜色。本地 CI 亮色 `rgb(247,249,254)`，线上暗色 `rgb(24,23,29)`，两边都验过。绑死颜色值会让断言跟主题走，主题一换就红——那是把回归检测变成了主题检测。

## 四、第三规矩：文档与断言双向对账

断言多了之后，新问题不是"没写"，是"写完了没人知道它守什么"。

11-23 那天我做了个实验：把 `PITFALLS.md` 里每条坑的五个字段（现象 / 根因 / 复现 / 断言 / 出处）固定下来，然后让脚本反过来查——文件里的编号和脚本里的编号是否一一对应。

`scripts/check-pitfalls.mjs` 双向查，但两个方向的处理完全不同：

```js
const missing = [...scripted].filter((x) => !documented.has(x));
const orphan = [...documented].filter((x) => !scripted.has(x));
// missing → fail：断言里冒出一个没登记的编号，说明有人在暗处加了断言没写文档
// orphan → WARN：文档有条目但没人引用，那是"已知但未自动化"，不该卡 CI
```

两个方向不对称是有意的。**有断言没文档**是欠账：半年后看到 `[P-014] FAIL`，得翻遍代码才知道它守什么，这种状态不该被容忍。**有文档没断言**是明说的边界：那篇文章末尾就写了"这条没做"，读者知道，我也知道，它不该让 CI 变红。

实测结果：17 条文档条目全部五字段齐全、脚本里出现的 17 个编号全都有文档条目、没有 orphan。第一次在沙盒里跑时 P-001（sticky 在 grid 里失效）被识别成 orphan，退出码 0——那正好是"明说的没做"该有的表现：文档说断言在 `check-toc-sticky.mjs`，但那个脚本只在真浏览器里跑，静态扫描不到 P-001 字样。我把这类"真机断言"的编号登记方式写进了文档，让对账脚本扫得到它，而不是把警告级别提到 fail。

失败分支也验过：临时把脚本里一个编号改成一个不存在的 `P-999`，退出码立刻变 1。断言不验失败分支等于没写——这条规矩适用于所有断言，包括断言断言本身的那个。

## 五、三层怎么接进 CI

三套做法落在 CI 里是分开的几步，不是一条大链：

```text
npm run test          → test-seo-series.mjs / test-css-budget.mjs / check-pitfalls.mjs
npm run check:a11y    → check-contrast.mjs
npm run check:size    → check-size.mjs（体积基线）
npm run check:pitfalls→ check-pitfalls-002-005.mjs + check-pitfalls.mjs
npm run check:browser → 起本地 Worker + 灌 D1 夹具 → check-css-baseline / check-dom / check-ld 等
```

分这么多步不是故意复杂，是**每层的前置条件不一样**。纯文本断言（`assert` + 正则）进 `npm test`，秒级、无依赖。体积断言读磁盘，进 `check:size`。computed style 和线上体检要真服务，进 `check:browser` 或手动跑。把所有断言塞进一条命令，结果是本地跑一次要起 Worker、灌夹具、连线上，然后人就不跑了。

`check:pitfalls` 是最后接进去的，两条命令串在一起：

```json
"check:pitfalls": "node scripts/check-pitfalls-002-005.mjs public && node scripts/check-pitfalls.mjs"
```

前一条做静态断言（图片尺寸、首屏占位、查询并行、日志字段），扫 `public/` 的 HTML 和 `src/` 的源码；后一条做文档与断言对账。两条都是零依赖、不到 100ms，放在哪里都不会成为负担。

第一次跑 002-005 脚本时我特意没直接进 CI，先单独执行了一遍。8 个 HTML、29 个源码文件，7 条断言全过，没有误报。但失败分支必须验——临时把一条断言的条件改成恒假，退出码是 1，再恢复。没验证过会失败的断言，和没写一样。

## 六、明说的没做

这套东西有三条边界，写清楚免得以后被当成银弹：

| 边界 | 现状 | 为什么没做 |
|---|---|---|
| 语义断言不能穷举 | 只覆盖了 `isPartOf` / `position` / `headline` 三类 | 语义错误没有完备判据，写多少都有漏。这类断言是"踩一个补一个"，不是一次做完 |
| 基线只挡变大，不挡变小 | `+10%` 单向阈值 | 变小可能是好事（真优化了），也可能是坏事（样式被误删）。后者由 computed style 基线挡，不靠体积 |
| 文档对账的 orphan 只警告 | 不 fail | 有些坑确实只能靠人记，比如"主题切换要 simulate no-preference"。把它们变成 fail 会逼出假断言 |

还有一条是效率上的取舍：`check:browser` 每次跑都要起 Worker、灌 D1 夹具，一轮下来几十秒。这意味着它不会被当成"改一行跑一次"的快速反馈，只在提交前跑。快速反馈那条路靠 `npm test` 里的纯文本断言——它们如果哪天也变成需要起服务，这套分工就垮了。

最后一句留给那篇自指文章的原话：**语法对的、引用活的、语义错的**——这一类错误不会自己消失，也不会被更聪明的工具替你发现。你只能决定要不要写那一行 `assert`。

## 怎么自己验一遍

按这个顺序，每一步都是独立命令，不用起服务就能跑完前五步：

```bash
# 1. 语义断言的形状：故意自指，看断言能不能红
node -e "import('./src/seo.js').then(m=>{const p=m.postLd({slug:'x',url:'https://x/p/x',series:'S'},'https://x');console.log(p.isPartOf.url)})"
# 期望：url 指向 /series/S，不含 /p/x

# 2. 线上结构化数据体检（需站点在线）
node scripts/check-ld.mjs
# 期望：逐篇 headline 一致、isPartOf 可达、position 次序匹配

# 3. 体积基线：首次写基线，第二次起守增长
node scripts/check-size.mjs --write-baseline
cp scripts/.size-baseline.json /tmp/base.bak
node scripts/check-size.mjs    # 期望全 pass
node -e "const f='scripts/.size-baseline.json',j=require(f);j['style.css']=1;require('fs').writeFileSync(f,JSON.stringify(j))"
node scripts/check-size.mjs    # 期望 exit 1（增长 >10%）
cp /tmp/base.bak scripts/.size-baseline.json

# 4. 文档双向对账 + 失败分支
node scripts/check-pitfalls.mjs                  # 期望 exit 0
node scripts/check-pitfalls-002-005.mjs public   # 期望 7/7，exit 0

# 5. 全量单测（纯 Node，无浏览器）
npm test
```

第 3 步是唯一会改文件的：先把基线备份，改完记得还回去。这一步的意义是让你亲眼看到那条断言真的会红——一个从来没红过的阈值，你不知道它到底在守什么。

#testing #ci #debugging #structured-data
