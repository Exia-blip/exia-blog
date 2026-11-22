-- 由 scripts/seed-29-33.mjs 生成，勿手改
-- hidden=0 + 未来 published_at：liveSql 时间闸门负责到点上线，无需 cron 改状态
-- INSERT 带 html_content / cover_body：与 src/api.js 新建路径同口径
-- 节奏：每周三一篇，从 2027-01-06 起（2 天冲刺段 12-21 已出清）

INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('crlf-sri-ci-red', 'CI 连红 4 次：本地绿、线上绿、CI 红，根因是 CRLF', '## 结论

CI 从 commit `76afc15` 起连续 4 次 failure，红的都是 check job 的「单元测试」步骤，报错落在 `public/app.js`：integrity 与磁盘文件不一致。browser job 同期一次没红。我把这当成一次 `sri integrity 不匹配` 去查，翻 SRI 的写法、`crossorigin`、哈希生成顺序，方向从一开始就错了。

根因不在 SRI 配置，在行尾。关键证据是一条命令的输出：`git ls-files --eol` 对 `app.js` 给出 `i/lf w/crlf`——git 索引里是 LF，工作区磁盘上是 CRLF。参与 SRI 的 14 个文件里，其余 13 个都是 LF，只有它一个是 CRLF。

这一列差异让三个环境跑出两种字节。`build:sri` 按工作区的 CRLF 字节算哈希，部署上去的也是这份 CRLF，本地自洽、线上 `check:live` 也绿；CI checkout 按 `.gitattributes` 的 `* text=auto eol=lf` 拿到 LF，同一个文件的哈希立刻对不上，单元测试红。报错文案里那个「磁盘」，在我本地和 CI 里指的不是同一份字节。

我把工作区 20 个 `w/crlf` 文件全部转成 LF（git 索引本来就是 LF，转完 `git diff` 里看不到它们），`app.js` 的哈希随字节变化，重新部署后线上字节复算 sha384 与 manifest 一致。验收点是 commit `ff4ec1e`、CI run `44927254879`，结果 success。

这类问题的教训一句话：Windows 上任何「按内容算哈希」的东西，先确认工作区行尾等于 git 索引行尾，否则你算的是本地那一份，CI 验的是另一份。我在 `build-sri.mjs` 和 `test-sri.mjs` 各加了一道防线，下面把误判过程、两道防线的取舍、以及为什么 browser job 一直绿写清楚。这个站的整体结构（单 Worker + Static Assets）写在[Worker 博客的整体架构](/p/workers-blog-pillar)。

## 一、第一反应是查 SRI，方向就错了

先交代背景，免得误判显得没来由。站点之前用 `?v=<Date.now()>` 当版本号，每次部署都变；`build-sri.mjs` 的注释里算过这笔账——哪怕只改一行文档，全站 CSS/JS 的 URL 也跟着变，用户每次发版都要重下 **121KB** 的 `style.css`，一年强缓存形同虚设。现在 `?v=` 换成内容哈希（sha256 前 10 位），`scripts/build-sri.mjs` 读 `public` 下的 js/css 生成 `src/assets.gen.js`，同一份字节再出 `integrity="sha384-…"`。规矩是改了 public 里的 js/css 必须跑 `npm run build:sri`，否则「单元测试」会报 manifest 与磁盘不同步。

我当时的排查路径可以完整记下来，因为它典型。先看 `integrity` 的属性拼法：源码里 `stampAssets` 把 manifest 的 `i` 字段原样写进 `integrity="…"`，前缀 `sha384-` 也是固定的，没有拼错的空间。再看 `crossorigin`：站内同源资源刻意不加，`test-sri.mjs` 里专门有一条「同源资源不加 crossorigin（加了会被 CORS 拦死）」在守着，不会突然多出来。第三条看 `?v=` 与 `integrity` 的来源：两条都是 `createHash` 吃同一份 `buf` 算出来的，同源断言一直绿。三条路全堵死，说明 SRI 这段代码没问题，出问题的只能是它读到的那份字节。

所以 CI 报 `public/app.js` 的 integrity 与磁盘不一致时，我的第一反应是：是不是有人改了 app.js 忘了跑 `build:sri`。这判断看起来很合理，因为报错文案本身就是这个意思——`test-sri.mjs` 里那条断言写的是 `不同步：${bad.join(''、'')}（跑 npm run build:sri）`，落到这次就是 `不同步：app.js（跑 npm run build:sri）`。

「忘了跑 build:sri」这个假设还有第二个漏洞：失败列表里只有 app.js 一个，其余 13 个 SRI 文件的哈希全部对得上。这个形状不像「整批 manifest 过期」，更像「某一个文件的字节来源和别人不一样」。当时我没把这句话说出来，现在回看，它是离答案最近的一句话。

我在本地照着报错提示跑了一次 `npm run build:sri`，它安安稳稳写回 manifest，再跑 `npm test` 全绿。这一步本该让我警觉：如果真只是「忘了跑」，那 CI 上跑一次同样的命令也该绿；但它连红 4 次。我那时候没往字节上想，继续在 SRI 写法里打转——查 `integrity` 的前缀、查 `crossorigin`、查 `?v=` 和 `integrity` 是不是来自同一批字节。这些在源码里本来就自洽：`test-sri.mjs` 有专门的断言「每个条目的 `?v=` 与 integrity 同源（同一份字节）」，它一直绿。

误判的根源是我把「磁盘」当成了同一个概念。`sri integrity 不匹配` 这类报错最常见的成因确实是哈希算错或写错，我默认套用了这个模式；但这次磁盘上有两份 app.js，一份在 Windows 工作区，一份在 CI checkout，它们的字节不同。SRI 本身一行没配错，错的是它依赖的输入。CSP 那一层（nonce 与缓存怎么配对）是另一回事，见[CSP nonce 与缓存](/p/csp-nonce-cache)。

这里值得记一笔：报错文案给出的「修复建议」有时会把人带沟里。`跑 npm run build:sri` 在本地是对的、在 CI 上也是对的，但只有在工作区字节正确时才对；在 CRLF 工作区上跑，它只会把一个错误的哈希固化进 manifest，让本地更绿、CI 更红。

## 二、三个环境，三套字节

把三个环境的同一份 `app.js` 摆在一起，矛盾就消失了。注意「字节」和「文件」不是一回事：文件名一样，磁盘上的 `\r\n` 不同，sha384 就不同。

| 环境 | app.js 行尾 | 哈希从哪来 | 校验结果 |
|---|---|---|---|
| 本地工作区（Windows） | CRLF（`w/crlf`） | `build:sri` 按 CRLF 字节算 | 自洽，`npm test` 绿 |
| 线上 Static Assets | CRLF（部署上传的就是工作区字节） | manifest 存的 CRLF 哈希 | `check:live` 绿 |
| CI checkout | LF（按 `.gitattributes` 归一） | manifest 还是 CRLF 哈希 | integrity 与磁盘不一致，「单元测试」红 |

两个绿的环境共享同一份 CRLF 字节：本地算、线上验，两边对得上。红的环境只有 CI，因为 checkout 这一步会按规则改字节。仓库里的 `.gitattributes` 是这么写的：

```text
* text=auto eol=lf
*.png binary
*.jpg binary
*.webp binary
```

`text=auto eol=lf` 的意思是：文本文件时，git 索引里存 LF，checkout 到工作区时也转 LF。CI 是干净的 checkout，没有 Windows 编辑器插手，所以它磁盘上的 app.js 必定是 LF。本地工作区这边的 CRLF 是编辑器或某个写文件的工具留下的，git 索引并不认它——索引里一直是 LF，这也是后面「转完 `git diff` 看不到变化」的原因。线上那一份为什么也是 CRLF？因为部署上传的是工作区里的文件，不是 git 索引里的 blob：工作区里 app.js 每行末尾是 `\r\n`，线上就是 `\r\n`。这一点我没有单独抓线上字节去数 `\r`，是结合「`check:live` 绿」和「manifest 按 CRLF 算」推出来的；`check:live` 验的就是线上字节与 manifest 一致，它绿着，说明线上那份和本地 CRLF 版本同源。

`text=auto` 还有一层意思：git 自动判断哪些文件是文本、哪些是二进制，二进制不换行尾。`.gitattributes` 里紧跟着三行 `*.png binary`、`*.jpg binary`、`*.webp binary`，就是把图片明确钉成二进制，避免 git 好心替它们改字节。参与 SRI 的 14 个文件都是 js/css，落在 `text=auto` 的文本分支里，所以行尾规训对它们全部生效——包括那个被写回 CRLF 的 app.js。

于是 CI 上的 `test-sri.mjs` 做了一件注定失败的事：它读磁盘上的 LF 字节算 sha384，再和 manifest 里按 CRLF 算出来的 `i` 字段比。14 个文件里 13 个在三个环境都是 LF，只有 app.js 对不上，失败列表里就只有它一个，定位倒是很干净。这里可以对照缓存分层里那类问题：当时踩的是「同一资源在不同层被改头换面」，这次是「同一文件在不同环境被改了行尾」，形状几乎一样——都是拿 A 处的字节去验 B 处的字节，还以为在验同一个东西。

这一节的核心观察：本地绿、线上绿、CI 红，三者可以同时成立，因为它们验的不是同一份字节。谁说「我这边跑过了是绿的」，谁只是在说自己那一套字节自洽。

## 三、把行尾量出来

真正定位靠的不是猜，是一条命令。先说清楚我为什么要量而不是继续看代码：SRI 的断言全是「哈希与字节是否一致」，代码本身没问题，问题在字节层面，得用 git 自己的视角看。

```bash
git ls-files --eol | grep ''w/crlf''
```

这条命令列出工作区里行尾是 CRLF 的受版本控制文件。输出的关键两列是 `i/` 和 `w/`：前者是 git 索引（index）里的行尾，后者是当前工作区（worktree）磁盘上的行尾。`app.js` 那一行的关键片段是 `i/lf w/crlf`——索引 LF、工作区 CRLF。我把这个证据记成一句话：同一文件在 git 眼里是 LF，在我磁盘上是 CRLF。

`i/lf w/crlf` 这四个字符值得拆开念。`i/` 后面是索引（index）状态，也就是 `git add` 之后存进 `.git` 的那一版；`w/` 后面是工作区（worktree）状态，也就是编辑器真正打开的那一版。两者本该一致，`.gitattributes` 的 `eol=lf` 就是用来保证这一点。这次它们分叉了，而且分叉的方向很关键：索引是对的那一版（LF），工作区是错的那一版（CRLF）。如果反过来——索引 CRLF、工作区 LF——后果会不同，但那不是本次的情况，我没遇到过，不做展开。

还有一个顺手验证的点：为什么 git 索引里是 LF？因为 `.gitattributes` 在文件被 `git add` 时就按 `* text=auto eol=lf` 归一了，不管工作区当时是 CRLF 还是 LF，写进索引的永远是 LF。所以「索引 LF」不是运气，是规则；「工作区 CRLF」才是违规的那一个。把这两句话写进排查记录，后面讨论「以谁为准」时就不会扯皮——以索引为准，因为它才是干净 checkout 会还原出来的那一版。

全量比对的结果：

| 文件组 | 数量 | `git ls-files --eol` 关键列 | 参与 SRI |
|---|---|---|---|
| `public/app.js` | 1 | `i/lf w/crlf` | 是 |
| 其余 SRI 文件 | 13 | `i/lf w/lf` | 是 |
| 工作区其他 CRLF 文件 | 19 | `w/crlf` | 否 |

这张表里有两个数字要分清。参与 SRI 的是 14 个文件，其中 13 个三环境一致，1 个不一致；而工作区里 `w/crlf` 的文件一共 20 个（app.js 加上另外 19 个），它们大多不参与 SRI，不直接引发这次事故，但我还是一起转了，理由在下一节。把这两个数字混起来会得到错误结论——比如以为「20 个文件都坏了」，其实真正让 CI 红的只有 1 个。

我还用 `git diff` 反向确认过一次：既然索引本来就是 LF，那么把一个 `w/crlf` 文件转成 LF 之后，`git diff` 里不该出现它。事故版本上，app.js 的 `git diff` 是空的——git 认为工作区内容和索引完全一致，没有任何改动。这条观察说明 CRLF 这件事在 git 眼里根本不算「修改」，也解释了它为什么能悄悄溜进 manifest：所有基于 `git diff` 的检查都会漏掉它。

把现象概括成 `内容哈希 CRLF` 这条检索锚点：内容哈希对字节逐字节敏感，CRLF 在每一行的末尾多塞了一个 `\r`，字节变了，哈希当然不再是同一份文件的代表。这不是 SRI 独有的坑，任何「先算哈希、再拿哈希当身份」的机制都会中招。我没有把这条推广到全站所有哈希场景去实测，只到推断为止；能确认的是它在本次 SRI 这条链上成立。

## 四、修的时候不能静默归一

修法分两步，顺序不能反。第一步把工作区所有 CRLF 转成 LF，第二步让 manifest 按新的 LF 字节重算并重新部署。先说第一步的边界：只转 app.js 不行吗？技术上能修好 CI，但工作区里还有 19 个 `w/crlf` 文件，下次谁碰到其中一个、恰好那个文件进了 SRI，同一场事故会重演，所以我一次性转了 20 个。这 19 个文件里具体哪些是 js/css 我没逐个看过，但它们和 app.js 一样处在同一个工作区、同样受行尾规则约束。与其维护一份「哪些文件不能是 CRLF」的清单，不如把工作区整体对齐到索引——反正索引本来就是 LF，转完 `git diff` 不产生任何改动，代价接近零。

```bash
node -e "const fs=require(''fs'');for(const f of [''public/app.js'']){fs.writeFileSync(f,fs.readFileSync(f,''utf8'').replace(/\r\n/g,''\n''))}"
```

这条命令就是 `build-sri.mjs` 在硬失败时打印给开发者的那条（它会把检测到的文件列表填进数组）。转完以后跑 `git diff`，这 20 个文件一个都不出现——因为它们的内容在 git 索引里本来就是 LF，我把工作区对齐回去，等于让工作区回到索引的样子。这一点很重要：如果 `git diff` 里冒出大片改动，说明转写方式不对，得停下来看。

两步的顺序为什么不能反？假设先重建 manifest 再转行尾：manifest 记的还是 CRLF 哈希，转完之后磁盘变成 LF，CI 立刻报不一致，等于白跑一趟。反过来先转行尾、先不重建，CI 也会报 manifest 与磁盘不一致，但这时报错的方向是对的——它指向「manifest 该重算了」，而不是「字节来源不对」。两种错误的形状不一样，后者一眼能看出下一步该做什么。

第二步，`app.js` 的字节从 CRLF 变成 LF，内容哈希必然变，`?v=` 和 `integrity` 都跟着变。这时候必须跑 `npm run build:sri` 重新生成 `src/assets.gen.js`，然后重新部署，让线上 Static Assets 拿到 LF 版本。部署完在线上把字节 curl 回来复算 sha384，结果等于新 manifest 里的 `i` 字段，这一步才算完。只改工作区不重建 manifest，CI 会报另一种不一致；只重建 manifest 不重新部署，线上 SRI 会直接崩。线上复算这一步我用的是最笨的办法：curl 回来、算摘要、转 base64、和 manifest 里的 `i` 字段逐字比。没有比这更可靠的验证——它验的不是配置、不是代码，是浏览器真正会拿到的那串字节。写进 HTML 的 `integrity` 一旦和浏览器实际收到的字节对不上，脚本会被整个丢弃，页面白屏且控制台只有一行提示。所以「manifest 自洽」不等于「线上正确」，必须拿线上字节再验一次。

这里要说清一个容易做错的选择：为什么构建脚本不能「静默归一」——也就是读文件时把 `\r\n` 替换成 `\n`，再拿归一后的字节算哈希。看上去很省事，但它会造出一个更隐蔽的故障：manifest 按 LF 算，但部署上传的是工作区那份没被改过的 CRLF 文件，浏览器按 CRLF 字节算 sha384，和 manifest 对不上，线上脚本被整个丢弃。本地测试还是绿的，因为测试读的也是被归一后的假字节。这个坑一旦踩进去，比 CI 红更难查——CI 红至少会拦住发版，线上 SRI 崩是直接白屏。

所以我的选择是硬失败：构建脚本发现 CRLF 就退出，把转换命令打出来，逼着人去修工作区的真实字节。宁可让发版卡在这里，也不能让一份和线上字节脱钩的 manifest 溜出去。

## 五、两层防线：构建时硬失败 + 测试直读磁盘

第一层在 `scripts/build-sri.mjs`。它在循环里读每个文件的原始字节，检查是否含 `\r\n`，收集到列表后统一报错退出：

```js
if (buf.includes(''\r\n'')) crlf.push(f);
```

```js
if (crlf.length) {
  console.error(`[sri] 这些文件是 CRLF 行尾，哈希会与仓库里的 LF 版本对不上：`);
  for (const f of crlf) console.error(`  public/${f}`);
  console.error(`[sri] 转成 LF 再跑：` +
    `node -e "const fs=require(''fs'');for(const f of ${JSON.stringify(crlf.map((f) => ''public/'' + f))}){fs.writeFileSync(f,fs.readFileSync(f,''utf8'').replace(/\\r\\n/g,''\\n''))}"`);
  process.exit(1);
}
```

注意检查发生在算哈希之前，且用的是 `readFileSync` 返回的原始 Buffer，不做任何替换。这是唯一还能阻止错误传播的时刻：一旦让 CRLF 字节进了 `createHash(''sha384'').update(buf)`，manifest 就已经脏了，后面所有基于 manifest 的自洽检查都会替它背书。`crlf` 这个数组在循环里边读边收，等 14 个文件全过一遍再统一报错，好处是一次能把所有违规文件列出来，不用修一个跑一次。报错里直接给出可复制的转换命令，把「发现问题」和「怎么修」放在同一个输出里，省得再翻文档。这段是我在 11-22 这次事故之后加的；事故当时没有这道检查，所以 CRLF 文件被安安静静算进了 manifest。

第二层在 `scripts/test-sri.mjs` 末尾，是一条直接读磁盘字节的断言：

```js
t(''参与 SRI 的文件都是 LF 行尾（与仓库索引一致）'', () => {
  const offenders = Object.keys(ASSET_HASH).filter((f) =>
    readFileSync(join(PUB, f), ''utf8'').includes(''\r\n'')
  );
  assert.deepEqual(offenders, [], `CRLF：${offenders.join(''、'')}`);
});
```

这条断言的关键不在逻辑多复杂，在它信任谁。前面那些测试都是「manifest 与磁盘比」「`?v=` 与 `integrity` 比」，本质上是拿 manifest 当参照物；如果 manifest 本身是在 CRLF 工作区上生成的，这些比较会一起绿。而这一条不碰 manifest 的内容，只用 `Object.keys(ASSET_HASH)` 拿到文件名列表，然后 `readFileSync` 读真实字节看有没有 `\r\n`。它不依赖 `build:sri` 有没有跑过，也不依赖 manifest 对不对——manifest 错的时候它反而最能抓到问题。两条防线的假设完全不同：一条假设构建流程会被正确执行，另一条不假设任何流程，只看磁盘。

两层防线的分工：`build-sri.mjs` 在生成 manifest 的入口硬拦，并在报错里给出修复命令；`test-sri.mjs` 在测试阶段独立复核磁盘字节，堵住「有人绕过构建直接改 manifest」或「本地重新生成了一个自洽但错误的 manifest」的口子。另外 `build-sri.mjs` 还有 `--check` 模式（`node scripts/build-sri.mjs --check`），只校验不写文件，不同步就退出码 1，适合放进发版闸门；这条模式是源码里本来就有的，这次没改它。

不过 `--check` 在这次事故里也拦不住：它比较的是 manifest 与当前磁盘，而两者都是 CRLF 版本，照样自洽。能拦住它的只有那条直接看字节的 LF 断言。`--check` 的价值在别处——它只读不写，不会像不带参数的 `npm run build:sri` 那样顺手把文件改了、把问题「修」掉却没人 review。

## 六、为什么 browser job 一直是绿的

同 4 个 commit，check job 的「单元测试」连红 4 次，browser job 一次没红。这个不对称不是巧合，是两个 job 的触发条件不同。check job 的那一步直接读 CI checkout 的磁盘字节，跟 manifest 比 sha384，CRLF/LF 的差异正好落在它的判据上，所以它必红。

browser job 的判据里没有「manifest 与磁盘字节逐字比对」这一项，否则它也会跟着红；它验证的是页面能不能跑起来这一维。线上那一份字节是 CRLF、和 manifest 自洽，浏览器侧按同一份字节算 sha384，integrity 校验过得去，所以从 browser job 的视角看 SRI 是好的。至于 browser job 内部每一步具体跑什么、有没有真的加载带 integrity 的资源，这条没测，只到推断为止；我能确认的只有「同 4 个 commit 它全绿」这个观察。

还有一个细节值得记：这 4 次 failure 都落在 check job 的「单元测试」上，不是什么新加的校验。也就是说，现成的测试本来就足以发现这个 bug，只是它跑在能被 CRLF 污染的工作区里时不会报——同样的代码，CI 跑就报，本地跑就不报。这种「同一套测试在不同机器上结论相反」的形态，最容易让人怀疑测试本身不稳定，从而把它当成 flaky 跳过。我没有跳过，但确实犹豫过。

这个观察的价值在于：别用「大部分 job 是绿的」当验收标准。如果当时我看一眼 browser job 绿着就以为没事，这个 bug 会一直躺在线上，直到某次真的有字节不匹配让浏览器丢脚本。多 job 的流水线里，任何一个红都对应某一维的失败；红的那维恰好没人看，就等于没检测。

反过来说，browser job 绿也不是没用——它至少排除了「SRI 配错导致页面整体加载失败」这一大类可能。把「它排除了什么」和「它没覆盖什么」分开写，才不会在误判时拿错的绿灯给自己壮胆。这次是 check job 的红把我拽回正确方向，而不是 browser job 的绿。如果流水线里只有 browser job，这次事故会静默地发到线上：manifest 按 CRLF 算、线上字节 CRLF、SRI 校验通过，一切正常——直到某次在干净 checkout 上重新生成 manifest，把 LF 版本的哈希提交上去，线上才会出问题。这一段是推断，没在线上复现过。

## 怎么自己验一遍

下面是我这次实际走的清单，按顺序跑能复现定位、修复和验收的全过程。顺序是按「先定位、再修、再验」排的，跳步会丢证据。尤其是第 1 步，必须在任何转换之前跑：一旦把行尾转了，`git ls-files --eol` 就只剩 `i/lf w/lf`，现场没了，只能靠回忆写排查记录。

**1. 量行尾，先确认问题在字节层。**

```bash
git ls-files --eol | grep ''w/crlf''
```

输出里找 `i/lf w/crlf`：有这一行、且这个文件在 SRI 清单里，就是同一种病。正常文件应该是 `i/lf w/lf`。

**2. 看 manifest 与磁盘是否同步。**

```bash
node scripts/build-sri.mjs --check
npm test
```

`--check` 不改文件，只比 manifest 主体与磁盘；`npm test` 跑完整断言集，包括新增的 LF 断言。在事故版本上，这里会打印 `不同步：app.js（跑 npm run build:sri）` 以及 `CRLF：app.js`。如果这一步绿着但 CI 仍红，别停在这里怀疑 CI，先回到第 1 步看行尾——本地和 CI 的字节可能不是一份。

**3. 转 LF，再用 `git diff` 确认没改内容。**

```bash
node -e "const fs=require(''fs'');for(const f of [''public/app.js'']){fs.writeFileSync(f,fs.readFileSync(f,''utf8'').replace(/\r\n/g,''\n''))}"
git diff --stat
```

`git diff --stat` 里不该出现这些文件；出现了就说明转写方式不对，停手检查。

**4. 重建 manifest 并重新部署。**

```bash
npm run build:sri
```

`src/assets.gen.js` 里 app.js 那条的 `v` 和 `i` 都会变。部署后把线上字节 curl 回来复算：

```bash
curl -s https://exia.de5.net/app.js | openssl dgst -sha384 -binary | openssl base64 -A
```

把输出的 base64 前面拼上 `sha384-`，和 `src/assets.gen.js` 里 app.js 的 `i` 字段逐字比；线上校验（`check:live`）也应该绿。

**5. 看 CI 的最终结果。** 这次的验收点是 commit `ff4ec1e`、CI run `44927254879`，结果 success，check job 的「单元测试」和 browser job 都通过。对照起点是 commit `76afc15` 起的连续 4 次 failure。run 编号我记在排查文档里，是为了让「修好了」这句话有可追溯的证据——那条 run 上两个 job 都通过，才算数。

**6. 确认防线已就位。** 在 `build-sri.mjs` 里能看到 `if (buf.includes(''\r\n'')) crlf.push(f)` 和 `process.exit(1)` 分支；在 `test-sri.mjs` 末尾能看到 `t(''参与 SRI 的文件都是 LF 行尾（与仓库索引一致）'', …)`。少任何一条，下次同样的事故都会重演。

#cloudflare #javascript #testing #debugging
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>CI 从 commit <code>76afc15</code> 起连续 4 次 failure，红的都是 check job 的「单元测试」步骤，报错落在 <code>public/app.js</code>：integrity 与磁盘文件不一致。browser job 同期一次没红。我把这当成一次 <code>sri integrity 不匹配</code> 去查，翻 SRI 的写法、<code>crossorigin</code>、哈希生成顺序，方向从一开始就错了。</p>
<p>根因不在 SRI 配置，在行尾。关键证据是一条命令的输出：<code>git ls-files --eol</code> 对 <code>app.js</code> 给出 <code>i/lf w/crlf</code>——git 索引里是 LF，工作区磁盘上是 CRLF。参与 SRI 的 14 个文件里，其余 13 个都是 LF，只有它一个是 CRLF。</p>
<p>这一列差异让三个环境跑出两种字节。<code>build:sri</code> 按工作区的 CRLF 字节算哈希，部署上去的也是这份 CRLF，本地自洽、线上 <code>check:live</code> 也绿；CI checkout 按 <code>.gitattributes</code> 的 <code>* text=auto eol=lf</code> 拿到 LF，同一个文件的哈希立刻对不上，单元测试红。报错文案里那个「磁盘」，在我本地和 CI 里指的不是同一份字节。</p>
<p>我把工作区 20 个 <code>w/crlf</code> 文件全部转成 LF（git 索引本来就是 LF，转完 <code>git diff</code> 里看不到它们），<code>app.js</code> 的哈希随字节变化，重新部署后线上字节复算 sha384 与 manifest 一致。验收点是 commit <code>ff4ec1e</code>、CI run <code>44927254879</code>，结果 success。</p>
<p>这类问题的教训一句话：Windows 上任何「按内容算哈希」的东西，先确认工作区行尾等于 git 索引行尾，否则你算的是本地那一份，CI 验的是另一份。我在 <code>build-sri.mjs</code> 和 <code>test-sri.mjs</code> 各加了一道防线，下面把误判过程、两道防线的取舍、以及为什么 browser job 一直绿写清楚。这个站的整体结构（单 Worker + Static Assets）写在<a href="/p/workers-blog-pillar">Worker 博客的整体架构</a>。</p>
<h2 id="一-第一反应是查-sri-方向就错了"><a class="h-anchor" href="#一-第一反应是查-sri-方向就错了">#</a>一、第一反应是查 SRI，方向就错了</h2>
<p>先交代背景，免得误判显得没来由。站点之前用 <code>?v=&lt;Date.now()&gt;</code> 当版本号，每次部署都变；<code>build-sri.mjs</code> 的注释里算过这笔账——哪怕只改一行文档，全站 CSS/JS 的 URL 也跟着变，用户每次发版都要重下 <strong>121KB</strong> 的 <code>style.css</code>，一年强缓存形同虚设。现在 <code>?v=</code> 换成内容哈希（sha256 前 10 位），<code>scripts/build-sri.mjs</code> 读 <code>public</code> 下的 js/css 生成 <code>src/assets.gen.js</code>，同一份字节再出 <code>integrity=&quot;sha384-…&quot;</code>。规矩是改了 public 里的 js/css 必须跑 <code>npm run build:sri</code>，否则「单元测试」会报 manifest 与磁盘不同步。</p>
<p>我当时的排查路径可以完整记下来，因为它典型。先看 <code>integrity</code> 的属性拼法：源码里 <code>stampAssets</code> 把 manifest 的 <code>i</code> 字段原样写进 <code>integrity=&quot;…&quot;</code>，前缀 <code>sha384-</code> 也是固定的，没有拼错的空间。再看 <code>crossorigin</code>：站内同源资源刻意不加，<code>test-sri.mjs</code> 里专门有一条「同源资源不加 crossorigin（加了会被 CORS 拦死）」在守着，不会突然多出来。第三条看 <code>?v=</code> 与 <code>integrity</code> 的来源：两条都是 <code>createHash</code> 吃同一份 <code>buf</code> 算出来的，同源断言一直绿。三条路全堵死，说明 SRI 这段代码没问题，出问题的只能是它读到的那份字节。</p>
<p>所以 CI 报 <code>public/app.js</code> 的 integrity 与磁盘不一致时，我的第一反应是：是不是有人改了 app.js 忘了跑 <code>build:sri</code>。这判断看起来很合理，因为报错文案本身就是这个意思——<code>test-sri.mjs</code> 里那条断言写的是 <code>不同步：${bad.join(&#39;、&#39;)}（跑 npm run build:sri）</code>，落到这次就是 <code>不同步：app.js（跑 npm run build:sri）</code>。</p>
<p>「忘了跑 build:sri」这个假设还有第二个漏洞：失败列表里只有 app.js 一个，其余 13 个 SRI 文件的哈希全部对得上。这个形状不像「整批 manifest 过期」，更像「某一个文件的字节来源和别人不一样」。当时我没把这句话说出来，现在回看，它是离答案最近的一句话。</p>
<p>我在本地照着报错提示跑了一次 <code>npm run build:sri</code>，它安安稳稳写回 manifest，再跑 <code>npm test</code> 全绿。这一步本该让我警觉：如果真只是「忘了跑」，那 CI 上跑一次同样的命令也该绿；但它连红 4 次。我那时候没往字节上想，继续在 SRI 写法里打转——查 <code>integrity</code> 的前缀、查 <code>crossorigin</code>、查 <code>?v=</code> 和 <code>integrity</code> 是不是来自同一批字节。这些在源码里本来就自洽：<code>test-sri.mjs</code> 有专门的断言「每个条目的 <code>?v=</code> 与 integrity 同源（同一份字节）」，它一直绿。</p>
<p>误判的根源是我把「磁盘」当成了同一个概念。<code>sri integrity 不匹配</code> 这类报错最常见的成因确实是哈希算错或写错，我默认套用了这个模式；但这次磁盘上有两份 app.js，一份在 Windows 工作区，一份在 CI checkout，它们的字节不同。SRI 本身一行没配错，错的是它依赖的输入。CSP 那一层（nonce 与缓存怎么配对）是另一回事，见<a href="/p/csp-nonce-cache">CSP nonce 与缓存</a>。</p>
<p>这里值得记一笔：报错文案给出的「修复建议」有时会把人带沟里。<code>跑 npm run build:sri</code> 在本地是对的、在 CI 上也是对的，但只有在工作区字节正确时才对；在 CRLF 工作区上跑，它只会把一个错误的哈希固化进 manifest，让本地更绿、CI 更红。</p>
<h2 id="二-三个环境-三套字节"><a class="h-anchor" href="#二-三个环境-三套字节">#</a>二、三个环境，三套字节</h2>
<p>把三个环境的同一份 <code>app.js</code> 摆在一起，矛盾就消失了。注意「字节」和「文件」不是一回事：文件名一样，磁盘上的 <code>\r\n</code> 不同，sha384 就不同。</p>
<div class="table-wrap"><table><thead><tr><th>环境</th><th>app.js 行尾</th><th>哈希从哪来</th><th>校验结果</th></tr></thead><tbody><tr><td>本地工作区（Windows）</td><td>CRLF（<code>w/crlf</code>）</td><td><code>build:sri</code> 按 CRLF 字节算</td><td>自洽，<code>npm test</code> 绿</td></tr><tr><td>线上 Static Assets</td><td>CRLF（部署上传的就是工作区字节）</td><td>manifest 存的 CRLF 哈希</td><td><code>check:live</code> 绿</td></tr><tr><td>CI checkout</td><td>LF（按 <code>.gitattributes</code> 归一）</td><td>manifest 还是 CRLF 哈希</td><td>integrity 与磁盘不一致，「单元测试」红</td></tr></tbody></table></div>
<p>两个绿的环境共享同一份 CRLF 字节：本地算、线上验，两边对得上。红的环境只有 CI，因为 checkout 这一步会按规则改字节。仓库里的 <code>.gitattributes</code> 是这么写的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text">* text=auto eol=lf
*.png binary
*.jpg binary
*.webp binary</code></pre></div>
<p><code>text=auto eol=lf</code> 的意思是：文本文件时，git 索引里存 LF，checkout 到工作区时也转 LF。CI 是干净的 checkout，没有 Windows 编辑器插手，所以它磁盘上的 app.js 必定是 LF。本地工作区这边的 CRLF 是编辑器或某个写文件的工具留下的，git 索引并不认它——索引里一直是 LF，这也是后面「转完 <code>git diff</code> 看不到变化」的原因。线上那一份为什么也是 CRLF？因为部署上传的是工作区里的文件，不是 git 索引里的 blob：工作区里 app.js 每行末尾是 <code>\r\n</code>，线上就是 <code>\r\n</code>。这一点我没有单独抓线上字节去数 <code>\r</code>，是结合「<code>check:live</code> 绿」和「manifest 按 CRLF 算」推出来的；<code>check:live</code> 验的就是线上字节与 manifest 一致，它绿着，说明线上那份和本地 CRLF 版本同源。</p>
<p><code>text=auto</code> 还有一层意思：git 自动判断哪些文件是文本、哪些是二进制，二进制不换行尾。<code>.gitattributes</code> 里紧跟着三行 <code>*.png binary</code>、<code>*.jpg binary</code>、<code>*.webp binary</code>，就是把图片明确钉成二进制，避免 git 好心替它们改字节。参与 SRI 的 14 个文件都是 js/css，落在 <code>text=auto</code> 的文本分支里，所以行尾规训对它们全部生效——包括那个被写回 CRLF 的 app.js。</p>
<p>于是 CI 上的 <code>test-sri.mjs</code> 做了一件注定失败的事：它读磁盘上的 LF 字节算 sha384，再和 manifest 里按 CRLF 算出来的 <code>i</code> 字段比。14 个文件里 13 个在三个环境都是 LF，只有 app.js 对不上，失败列表里就只有它一个，定位倒是很干净。这里可以对照缓存分层里那类问题：当时踩的是「同一资源在不同层被改头换面」，这次是「同一文件在不同环境被改了行尾」，形状几乎一样——都是拿 A 处的字节去验 B 处的字节，还以为在验同一个东西。</p>
<p>这一节的核心观察：本地绿、线上绿、CI 红，三者可以同时成立，因为它们验的不是同一份字节。谁说「我这边跑过了是绿的」，谁只是在说自己那一套字节自洽。</p>
<h2 id="三-把行尾量出来"><a class="h-anchor" href="#三-把行尾量出来">#</a>三、把行尾量出来</h2>
<p>真正定位靠的不是猜，是一条命令。先说清楚我为什么要量而不是继续看代码：SRI 的断言全是「哈希与字节是否一致」，代码本身没问题，问题在字节层面，得用 git 自己的视角看。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">git</span> <span class="tok-k">ls</span>-files --eol | <span class="tok-k">grep</span> <span class="tok-s">&#39;w/crlf&#39;</span></code></pre></div>
<p>这条命令列出工作区里行尾是 CRLF 的受版本控制文件。输出的关键两列是 <code>i/</code> 和 <code>w/</code>：前者是 git 索引（index）里的行尾，后者是当前工作区（worktree）磁盘上的行尾。<code>app.js</code> 那一行的关键片段是 <code>i/lf w/crlf</code>——索引 LF、工作区 CRLF。我把这个证据记成一句话：同一文件在 git 眼里是 LF，在我磁盘上是 CRLF。</p>
<p><code>i/lf w/crlf</code> 这四个字符值得拆开念。<code>i/</code> 后面是索引（index）状态，也就是 <code>git add</code> 之后存进 <code>.git</code> 的那一版；<code>w/</code> 后面是工作区（worktree）状态，也就是编辑器真正打开的那一版。两者本该一致，<code>.gitattributes</code> 的 <code>eol=lf</code> 就是用来保证这一点。这次它们分叉了，而且分叉的方向很关键：索引是对的那一版（LF），工作区是错的那一版（CRLF）。如果反过来——索引 CRLF、工作区 LF——后果会不同，但那不是本次的情况，我没遇到过，不做展开。</p>
<p>还有一个顺手验证的点：为什么 git 索引里是 LF？因为 <code>.gitattributes</code> 在文件被 <code>git add</code> 时就按 <code>* text=auto eol=lf</code> 归一了，不管工作区当时是 CRLF 还是 LF，写进索引的永远是 LF。所以「索引 LF」不是运气，是规则；「工作区 CRLF」才是违规的那一个。把这两句话写进排查记录，后面讨论「以谁为准」时就不会扯皮——以索引为准，因为它才是干净 checkout 会还原出来的那一版。</p>
<p>全量比对的结果：</p>
<div class="table-wrap"><table><thead><tr><th>文件组</th><th>数量</th><th><code>git ls-files --eol</code> 关键列</th><th>参与 SRI</th></tr></thead><tbody><tr><td><code>public/app.js</code></td><td>1</td><td><code>i/lf w/crlf</code></td><td>是</td></tr><tr><td>其余 SRI 文件</td><td>13</td><td><code>i/lf w/lf</code></td><td>是</td></tr><tr><td>工作区其他 CRLF 文件</td><td>19</td><td><code>w/crlf</code></td><td>否</td></tr></tbody></table></div>
<p>这张表里有两个数字要分清。参与 SRI 的是 14 个文件，其中 13 个三环境一致，1 个不一致；而工作区里 <code>w/crlf</code> 的文件一共 20 个（app.js 加上另外 19 个），它们大多不参与 SRI，不直接引发这次事故，但我还是一起转了，理由在下一节。把这两个数字混起来会得到错误结论——比如以为「20 个文件都坏了」，其实真正让 CI 红的只有 1 个。</p>
<p>我还用 <code>git diff</code> 反向确认过一次：既然索引本来就是 LF，那么把一个 <code>w/crlf</code> 文件转成 LF 之后，<code>git diff</code> 里不该出现它。事故版本上，app.js 的 <code>git diff</code> 是空的——git 认为工作区内容和索引完全一致，没有任何改动。这条观察说明 CRLF 这件事在 git 眼里根本不算「修改」，也解释了它为什么能悄悄溜进 manifest：所有基于 <code>git diff</code> 的检查都会漏掉它。</p>
<p>把现象概括成 <code>内容哈希 CRLF</code> 这条检索锚点：内容哈希对字节逐字节敏感，CRLF 在每一行的末尾多塞了一个 <code>\r</code>，字节变了，哈希当然不再是同一份文件的代表。这不是 SRI 独有的坑，任何「先算哈希、再拿哈希当身份」的机制都会中招。我没有把这条推广到全站所有哈希场景去实测，只到推断为止；能确认的是它在本次 SRI 这条链上成立。</p>
<h2 id="四-修的时候不能静默归一"><a class="h-anchor" href="#四-修的时候不能静默归一">#</a>四、修的时候不能静默归一</h2>
<p>修法分两步，顺序不能反。第一步把工作区所有 CRLF 转成 LF，第二步让 manifest 按新的 LF 字节重算并重新部署。先说第一步的边界：只转 app.js 不行吗？技术上能修好 CI，但工作区里还有 19 个 <code>w/crlf</code> 文件，下次谁碰到其中一个、恰好那个文件进了 SRI，同一场事故会重演，所以我一次性转了 20 个。这 19 个文件里具体哪些是 js/css 我没逐个看过，但它们和 app.js 一样处在同一个工作区、同样受行尾规则约束。与其维护一份「哪些文件不能是 CRLF」的清单，不如把工作区整体对齐到索引——反正索引本来就是 LF，转完 <code>git diff</code> 不产生任何改动，代价接近零。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> -e <span class="tok-s">&quot;const fs=require(&#39;fs&#39;);for(const f of [&#39;public/app.js&#39;]){fs.writeFileSync(f,fs.readFileSync(f,&#39;utf8&#39;).replace(/\r\n/g,&#39;\n&#39;))}&quot;</span></code></pre></div>
<p>这条命令就是 <code>build-sri.mjs</code> 在硬失败时打印给开发者的那条（它会把检测到的文件列表填进数组）。转完以后跑 <code>git diff</code>，这 20 个文件一个都不出现——因为它们的内容在 git 索引里本来就是 LF，我把工作区对齐回去，等于让工作区回到索引的样子。这一点很重要：如果 <code>git diff</code> 里冒出大片改动，说明转写方式不对，得停下来看。</p>
<p>两步的顺序为什么不能反？假设先重建 manifest 再转行尾：manifest 记的还是 CRLF 哈希，转完之后磁盘变成 LF，CI 立刻报不一致，等于白跑一趟。反过来先转行尾、先不重建，CI 也会报 manifest 与磁盘不一致，但这时报错的方向是对的——它指向「manifest 该重算了」，而不是「字节来源不对」。两种错误的形状不一样，后者一眼能看出下一步该做什么。</p>
<p>第二步，<code>app.js</code> 的字节从 CRLF 变成 LF，内容哈希必然变，<code>?v=</code> 和 <code>integrity</code> 都跟着变。这时候必须跑 <code>npm run build:sri</code> 重新生成 <code>src/assets.gen.js</code>，然后重新部署，让线上 Static Assets 拿到 LF 版本。部署完在线上把字节 curl 回来复算 sha384，结果等于新 manifest 里的 <code>i</code> 字段，这一步才算完。只改工作区不重建 manifest，CI 会报另一种不一致；只重建 manifest 不重新部署，线上 SRI 会直接崩。线上复算这一步我用的是最笨的办法：curl 回来、算摘要、转 base64、和 manifest 里的 <code>i</code> 字段逐字比。没有比这更可靠的验证——它验的不是配置、不是代码，是浏览器真正会拿到的那串字节。写进 HTML 的 <code>integrity</code> 一旦和浏览器实际收到的字节对不上，脚本会被整个丢弃，页面白屏且控制台只有一行提示。所以「manifest 自洽」不等于「线上正确」，必须拿线上字节再验一次。</p>
<p>这里要说清一个容易做错的选择：为什么构建脚本不能「静默归一」——也就是读文件时把 <code>\r\n</code> 替换成 <code>\n</code>，再拿归一后的字节算哈希。看上去很省事，但它会造出一个更隐蔽的故障：manifest 按 LF 算，但部署上传的是工作区那份没被改过的 CRLF 文件，浏览器按 CRLF 字节算 sha384，和 manifest 对不上，线上脚本被整个丢弃。本地测试还是绿的，因为测试读的也是被归一后的假字节。这个坑一旦踩进去，比 CI 红更难查——CI 红至少会拦住发版，线上 SRI 崩是直接白屏。</p>
<p>所以我的选择是硬失败：构建脚本发现 CRLF 就退出，把转换命令打出来，逼着人去修工作区的真实字节。宁可让发版卡在这里，也不能让一份和线上字节脱钩的 manifest 溜出去。</p>
<h2 id="五-两层防线-构建时硬失败-测试直读磁盘"><a class="h-anchor" href="#五-两层防线-构建时硬失败-测试直读磁盘">#</a>五、两层防线：构建时硬失败 + 测试直读磁盘</h2>
<p>第一层在 <code>scripts/build-sri.mjs</code>。它在循环里读每个文件的原始字节，检查是否含 <code>\r\n</code>，收集到列表后统一报错退出：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (buf.<span class="tok-f">includes</span>(<span class="tok-s">&#39;\r\n&#39;</span>)) crlf.<span class="tok-f">push</span>(f);</code></pre></div>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (crlf.length) {
  console.<span class="tok-f">error</span>(<span class="tok-s">`[sri] 这些文件是 CRLF 行尾，哈希会与仓库里的 LF 版本对不上：`</span>);
  <span class="tok-k">for</span> (<span class="tok-k">const</span> f <span class="tok-k">of</span> crlf) console.<span class="tok-f">error</span>(<span class="tok-s">`  public/${f}`</span>);
  console.<span class="tok-f">error</span>(<span class="tok-s">`[sri] 转成 LF 再跑：`</span> +
    <span class="tok-s">`node -e &quot;const fs=require(&#39;fs&#39;);for(const f of ${JSON.stringify(crlf.map((f) =&gt; &#39;public/&#39; + f))}){fs.writeFileSync(f,fs.readFileSync(f,&#39;utf8&#39;).replace(/\\r\\n/g,&#39;\\n&#39;))}&quot;`</span>);
  process.<span class="tok-f">exit</span>(<span class="tok-n">1</span>);
}</code></pre></div>
<p>注意检查发生在算哈希之前，且用的是 <code>readFileSync</code> 返回的原始 Buffer，不做任何替换。这是唯一还能阻止错误传播的时刻：一旦让 CRLF 字节进了 <code>createHash(&#39;sha384&#39;).update(buf)</code>，manifest 就已经脏了，后面所有基于 manifest 的自洽检查都会替它背书。<code>crlf</code> 这个数组在循环里边读边收，等 14 个文件全过一遍再统一报错，好处是一次能把所有违规文件列出来，不用修一个跑一次。报错里直接给出可复制的转换命令，把「发现问题」和「怎么修」放在同一个输出里，省得再翻文档。这段是我在 11-22 这次事故之后加的；事故当时没有这道检查，所以 CRLF 文件被安安静静算进了 manifest。</p>
<p>第二层在 <code>scripts/test-sri.mjs</code> 末尾，是一条直接读磁盘字节的断言：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-f">t</span>(<span class="tok-s">&#39;参与 SRI 的文件都是 LF 行尾（与仓库索引一致）&#39;</span>, () =&gt; {
  <span class="tok-k">const</span> offenders = Object.<span class="tok-f">keys</span>(ASSET_HASH).<span class="tok-f">filter</span>((f) =&gt;
    <span class="tok-f">readFileSync</span>(<span class="tok-f">join</span>(PUB, f), <span class="tok-s">&#39;utf8&#39;</span>).<span class="tok-f">includes</span>(<span class="tok-s">&#39;\r\n&#39;</span>)
  );
  assert.<span class="tok-f">deepEqual</span>(offenders, [], <span class="tok-s">`CRLF：${offenders.join(&#39;、&#39;)}`</span>);
});</code></pre></div>
<p>这条断言的关键不在逻辑多复杂，在它信任谁。前面那些测试都是「manifest 与磁盘比」「<code>?v=</code> 与 <code>integrity</code> 比」，本质上是拿 manifest 当参照物；如果 manifest 本身是在 CRLF 工作区上生成的，这些比较会一起绿。而这一条不碰 manifest 的内容，只用 <code>Object.keys(ASSET_HASH)</code> 拿到文件名列表，然后 <code>readFileSync</code> 读真实字节看有没有 <code>\r\n</code>。它不依赖 <code>build:sri</code> 有没有跑过，也不依赖 manifest 对不对——manifest 错的时候它反而最能抓到问题。两条防线的假设完全不同：一条假设构建流程会被正确执行，另一条不假设任何流程，只看磁盘。</p>
<p>两层防线的分工：<code>build-sri.mjs</code> 在生成 manifest 的入口硬拦，并在报错里给出修复命令；<code>test-sri.mjs</code> 在测试阶段独立复核磁盘字节，堵住「有人绕过构建直接改 manifest」或「本地重新生成了一个自洽但错误的 manifest」的口子。另外 <code>build-sri.mjs</code> 还有 <code>--check</code> 模式（<code>node scripts/build-sri.mjs --check</code>），只校验不写文件，不同步就退出码 1，适合放进发版闸门；这条模式是源码里本来就有的，这次没改它。</p>
<p>不过 <code>--check</code> 在这次事故里也拦不住：它比较的是 manifest 与当前磁盘，而两者都是 CRLF 版本，照样自洽。能拦住它的只有那条直接看字节的 LF 断言。<code>--check</code> 的价值在别处——它只读不写，不会像不带参数的 <code>npm run build:sri</code> 那样顺手把文件改了、把问题「修」掉却没人 review。</p>
<h2 id="六-为什么-browser-job-一直是绿的"><a class="h-anchor" href="#六-为什么-browser-job-一直是绿的">#</a>六、为什么 browser job 一直是绿的</h2>
<p>同 4 个 commit，check job 的「单元测试」连红 4 次，browser job 一次没红。这个不对称不是巧合，是两个 job 的触发条件不同。check job 的那一步直接读 CI checkout 的磁盘字节，跟 manifest 比 sha384，CRLF/LF 的差异正好落在它的判据上，所以它必红。</p>
<p>browser job 的判据里没有「manifest 与磁盘字节逐字比对」这一项，否则它也会跟着红；它验证的是页面能不能跑起来这一维。线上那一份字节是 CRLF、和 manifest 自洽，浏览器侧按同一份字节算 sha384，integrity 校验过得去，所以从 browser job 的视角看 SRI 是好的。至于 browser job 内部每一步具体跑什么、有没有真的加载带 integrity 的资源，这条没测，只到推断为止；我能确认的只有「同 4 个 commit 它全绿」这个观察。</p>
<p>还有一个细节值得记：这 4 次 failure 都落在 check job 的「单元测试」上，不是什么新加的校验。也就是说，现成的测试本来就足以发现这个 bug，只是它跑在能被 CRLF 污染的工作区里时不会报——同样的代码，CI 跑就报，本地跑就不报。这种「同一套测试在不同机器上结论相反」的形态，最容易让人怀疑测试本身不稳定，从而把它当成 flaky 跳过。我没有跳过，但确实犹豫过。</p>
<p>这个观察的价值在于：别用「大部分 job 是绿的」当验收标准。如果当时我看一眼 browser job 绿着就以为没事，这个 bug 会一直躺在线上，直到某次真的有字节不匹配让浏览器丢脚本。多 job 的流水线里，任何一个红都对应某一维的失败；红的那维恰好没人看，就等于没检测。</p>
<p>反过来说，browser job 绿也不是没用——它至少排除了「SRI 配错导致页面整体加载失败」这一大类可能。把「它排除了什么」和「它没覆盖什么」分开写，才不会在误判时拿错的绿灯给自己壮胆。这次是 check job 的红把我拽回正确方向，而不是 browser job 的绿。如果流水线里只有 browser job，这次事故会静默地发到线上：manifest 按 CRLF 算、线上字节 CRLF、SRI 校验通过，一切正常——直到某次在干净 checkout 上重新生成 manifest，把 LF 版本的哈希提交上去，线上才会出问题。这一段是推断，没在线上复现过。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>下面是我这次实际走的清单，按顺序跑能复现定位、修复和验收的全过程。顺序是按「先定位、再修、再验」排的，跳步会丢证据。尤其是第 1 步，必须在任何转换之前跑：一旦把行尾转了，<code>git ls-files --eol</code> 就只剩 <code>i/lf w/lf</code>，现场没了，只能靠回忆写排查记录。</p>
<p><strong>1. 量行尾，先确认问题在字节层。</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">git</span> <span class="tok-k">ls</span>-files --eol | <span class="tok-k">grep</span> <span class="tok-s">&#39;w/crlf&#39;</span></code></pre></div>
<p>输出里找 <code>i/lf w/crlf</code>：有这一行、且这个文件在 SRI 清单里，就是同一种病。正常文件应该是 <code>i/lf w/lf</code>。</p>
<p><strong>2. 看 manifest 与磁盘是否同步。</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> scripts/build-sri.mjs --check
<span class="tok-k">npm</span> test</code></pre></div>
<p><code>--check</code> 不改文件，只比 manifest 主体与磁盘；<code>npm test</code> 跑完整断言集，包括新增的 LF 断言。在事故版本上，这里会打印 <code>不同步：app.js（跑 npm run build:sri）</code> 以及 <code>CRLF：app.js</code>。如果这一步绿着但 CI 仍红，别停在这里怀疑 CI，先回到第 1 步看行尾——本地和 CI 的字节可能不是一份。</p>
<p><strong>3. 转 LF，再用 <code>git diff</code> 确认没改内容。</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">node</span> -e <span class="tok-s">&quot;const fs=require(&#39;fs&#39;);for(const f of [&#39;public/app.js&#39;]){fs.writeFileSync(f,fs.readFileSync(f,&#39;utf8&#39;).replace(/\r\n/g,&#39;\n&#39;))}&quot;</span>
<span class="tok-k">git</span> diff --stat</code></pre></div>
<p><code>git diff --stat</code> 里不该出现这些文件；出现了就说明转写方式不对，停手检查。</p>
<p><strong>4. 重建 manifest 并重新部署。</strong></p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">npm</span> run build:sri</code></pre></div>
<p><code>src/assets.gen.js</code> 里 app.js 那条的 <code>v</code> 和 <code>i</code> 都会变。部署后把线上字节 curl 回来复算：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s https:<span class="tok-c">//exia.de5.net/app.js | openssl dgst -sha384 -binary | openssl base64 -A</span></code></pre></div>
<p>把输出的 base64 前面拼上 <code>sha384-</code>，和 <code>src/assets.gen.js</code> 里 app.js 的 <code>i</code> 字段逐字比；线上校验（<code>check:live</code>）也应该绿。</p>
<p><strong>5. 看 CI 的最终结果。</strong> 这次的验收点是 commit <code>ff4ec1e</code>、CI run <code>44927254879</code>，结果 success，check job 的「单元测试」和 browser job 都通过。对照起点是 commit <code>76afc15</code> 起的连续 4 次 failure。run 编号我记在排查文档里，是为了让「修好了」这句话有可追溯的证据——那条 run 上两个 job 都通过，才算数。</p>
<p><strong>6. 确认防线已就位。</strong> 在 <code>build-sri.mjs</code> 里能看到 <code>if (buf.includes(&#39;\r\n&#39;)) crlf.push(f)</code> 和 <code>process.exit(1)</code> 分支；在 <code>test-sri.mjs</code> 末尾能看到 <code>t(&#39;参与 SRI 的文件都是 LF 行尾（与仓库索引一致）&#39;, …)</code>。少任何一条，下次同样的事故都会重演。</p>
<p><a class="tag-inline" href="/tag/cloudflare">#cloudflare</a> <a class="tag-inline" href="/tag/javascript">#javascript</a> <a class="tag-inline" href="/tag/testing">#testing</a> <a class="tag-inline" href="/tag/debugging">#debugging</a></p>', '', 'log', '内容哈希对字节敏感。工作区 app.js 是 i/lf w/crlf，本地算的哈希与线上 CRLF 字节自洽，CI 按 .gitattributes checkout 出 LF 就对不上。浏览器 job 一直绿、只有单测红。build-sri 遇 CRLF 硬失败 + test-sri 直读磁盘补上两层防线。',
        '', 0, 0, 0, 1, '2027-01-06 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'crlf-sri-ci-red' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('javascript') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'crlf-sri-ci-red' AND t.name = 'javascript';
INSERT INTO tags (name) VALUES ('testing') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'crlf-sri-ci-red' AND t.name = 'testing';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'crlf-sri-ci-red' AND t.name = 'debugging';
INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('early-hints-preload-mismatch', '103 Early Hints 提前下的 CSS 没人用：preload 和 HTML href 差了一个字符串', '## 结论

11-22 部署完，我在 CDP 的 Network 面板里看到 `style.css` 被下了两遍。两遍的地址长得几乎一样，都是 `/style.css?v=`，区别只在 `v=` 后面那一串：103 Early Hints 提前发出的 preload 用的是部署号，HTML 里 `<link>` 的 href 用的是内容哈希。浏览器把它们当成两个资源，分别下载、分别解析、分别缓存，其中一份从头到尾没人用。

白下的那份是 121KB CSS。它发生在每一次冷访问上，不是 TTFB 变慢了，也不是 CSS 写大了——是同一个文件被两个版本号指成了两份。两份还各自在边缘缓存里占一份，下一个冷访问照样重来。这类问题检索起来通常落到 `103 early hints preload 不匹配`、`cloudflare early hints css` 这些词上，但搜索结果大多只讲 103 是什么，不会告诉你「两个版本号长得像」这件事有多隐蔽。

修法是把两边收进同一个事实来源：preload 的地址也去读 `ASSET_HASH[''style.css''].v`。拿不到哈希就不发 Link 头，宁缺勿错。提交 `d20bf49`，线上 `check:live` 跑出 75/75。

| 谁写的地址 | 长什么样 | `v=` 的来源 |
|---|---|---|
| 103 的 `Link: rel=preload` | `</style.css?v=<部署号>>` | `assetVersion(env)`，即 `SITE_VERSION` 或 `CF_VERSION_METADATA.id` |
| HTML 里的 `<link href>` | `/style.css?v=<内容哈希>` | `ASSET_HASH[''style.css''].v`，内容变才变 |

这个修复在提交 `d20bf49` 里只是「顺手修一个真 bug」那一条，主标题写的是全站视觉收敛——标签云去彩、窄屏首屏、404 补品牌线。性能问题藏在视觉改动的尾巴里，这在复盘时很容易被漏记： changelog 里看不见它，三个月后想知道「121KB 那次是怎么回事」，只能靠提交说明里那几行字。我把它单独写成一篇，也是为了让这条归因有地方落脚。

这篇要讲清楚的不是「preload 怎么写」——那几行代码谁都会。要讲的是三件更容易搞错的事：103 省的到底是哪段时间，为什么两个看起来都像版本号的东西不能混用，以及缓存命中时 103 消失为什么不是缺陷。它们的共同点是都不报错，只会让你在几个月后对着一份「明明开了 Early Hints」的配置纳闷为什么没提速。

## 一、103 到底省的是哪一段时间

先把分工说准，不然后面所有推断都会错位。103 不是 Worker 发的，是 Cloudflare 边缘发的。Worker 只干一件事：在最终响应上挂一条 `Link: </style.css?v=...>; rel=preload; as=style` 头。边缘看到这条头，就在 HTML body 之前先吐一个 `103 Early Hints`，里面带上同一段 Link。浏览器收到 103，不等 HTML 流，先把 CSS 下载起来。

开关在 `Dashboard → Speed → Content Optimization → Early Hints`。我手上的 token 没有写权限，只能看，改不了。实测下来：不开也不会坏，那个 Link 头退化成普通响应头，浏览器照样当 preload 处理——只是没人提前打招呼，启动时机从「103 那一刻」退回到「HTML 解析到 `<link>` 那一刻」。换句话说，开关决定的是有没有 103 这个**提前量**，不决定 preload 本来的语义。把它当成「不开就失效」的功能，是误读。

这段串行在本站比在纯静态站上更值得治。静态站的 HTML 由边缘直接吐，head 很快就到，浏览器没等太久就能发现 CSS；本站的 HTML 要过 Worker 渲染，head 到得晚一些，「HTML 到手」与「CSS 开始下载」之间的空隙自然更长。这是我从两站架构差异推出来的，没有做静态站对照，只到推断为止。但方向是清楚的：越依赖服务端渲染，103 的提前量越有可能值钱，也越经不起「预告了一个没人用的地址」这种错法。

它省的时间段很具体，画一条线就清楚：

| 阶段 | 谁在跑 | 103 帮不帮 |
|---|---|---|
| TLS 握手 | 边缘 | 不帮 |
| Worker 执行（取数、渲染） | Worker | 不帮 |
| HTML 第一个字节到手 | 网络 | 不帮 |
| 浏览器解析到 `<link rel=stylesheet>` | 浏览器 | 帮 |
| CSS 下载 | 浏览器 | 帮 |

源码里的原话是：「它对 TTFB 没帮助（那时 TLS 和 Worker 都已经跑完了），省的是『HTML 开始到手』到『CSS 开始下载』之间那段。」我完全同意这个界定。103 发出去的时刻，Worker 已经执行完了，最终响应的头还没出——它插在两者之间，目的就是把「解析 HTML 才知道要下 CSS」这步从关键路径上摘掉。那段串行横在 LCP 前面，是我这里唯一想动的地方。

103 本身是个 1xx 临时响应，只带头、不带 HTML。浏览器的处理方式是：收到 103 就按里面的 Link 先发起 CSS 请求，同时继续等真正的 200 和 HTML body。这个机制成立的前提只有一条——103 里预告的资源，必须是后面 HTML 真会用的那份。一旦两边不是同一份，提前量就变成纯粹的浪费，而且比不提前更糟：浏览器已经把带宽花在没人用的字节上了。

所以别拿 TTFB 当用户感知的尺子去验收 103。TTFB 量到的是最终响应的第一个字节，它在这条链上位于 103 之后，103 不会把它挪早。真要量，看的是 CSS 请求的 `startTime` 相对 HTML 请求 `responseStart` 往前挪了多少。这次事故里我盯的是「有没有多下一份」，那个位移具体减少多少毫秒，这条没测，只到推断为止。

## 二、两个版本号，一个像另一个

`assetVersion(env)` 的实现是 `env.SITE_VERSION || env.CF_VERSION_METADATA.id || ''''`。它是一个跟着部署走的标识，跟文件内容没有关系：哪怕 CSS 一个字节没改，重新部署一次它也换。拿它当静态资源的版本号，语义上就是「这次部署的这一版」，而不是「这份内容」。

HTML 那条路不是这样。`stampAssets` 遇到 manifest 里的文件，会用 `ASSET_HASH[文件名].v` 覆盖 `?v=`。这个 v 是内容哈希——现在 `assets.gen.js` 里 `style.css` 那一行是 `38a1442c00`——内容不变它就不变，所以 `max-age=31536000, immutable` 那种一年强缓存才真的能用满。manifest 里没有的资源（`/thumbs/`、`/cards/`）才退回部署号，因为它们是构建产物，文件名按 slug 固定，内容跟着文章改。

出事那版 preload 走的是第一条路：

```js
// 改动前（d20bf49 之前）
const av = assetVersion(env);
const avq = av ? `?v=${encodeURIComponent(av)}` : '''';
const hints = [`</style.css${avq}>; rel=preload; as=style`];
const themeHref = themeCssPath(s.theme);
if (themeHref) hints.push(`<${themeHref}${avq}>; rel=preload; as=style`);
```

同一时刻，HTML 里的 href 已经被 `stampAssets` 改成了内容哈希。两个字符串都是 `?v=` 接一串十六进制样的字符，肉眼扫过去几乎一样；浏览器按完整 URL 做缓存键，差一个字符就是两个资源。这是它最难查的地方——不是「明显错了」，而是「看起来对」。

主题 CSS 同一条链上中招。`themeCssPath` 把纸韵和安知鱼留在主 `style.css` 里，其余五套主题各一个 `/theme/<id>.css` 文件。旧代码给这个路径也拼上部署号，而 head 里那一份走的是内容哈希。更麻烦的是它**只在特定主题下出现**：你用默认主题复现不出来，换一套主题才慢，等于把 bug 藏进了一个没人测的分支。`src/settings.js` 开头那段注释写的就是这个理由——把路径单独抽出来，是为了让 103 和 head 里的 `<link>` 用同一个来源；两处各写一份判断，加主题时必然漏改一处，漏的那处表现为「preload 了一个 404 地址」，而且只在某个主题下出现，测不到。

| 资源 | HTML href 的 `v` | 旧 preload 的 `v` | 结果 |
|---|---|---|---|
| `style.css` | 内容哈希 | 部署号 | 两份，冷访问多下 121KB |
| `theme/ink.css` 等五套 | 内容哈希 | 部署号 | 两份，且只在非纸韵/安知鱼主题下出现 |
| `/thumbs/`、`/cards/` | 部署号 | 不进 103 | 不受影响 |

注意第三行：退回部署号这件事本身不是罪，罪在**两边不一致**。thumbs 和 cards 的 href 与它们的缓存策略本来就按部署号走，没有第二份声明跟它打架。一旦同一资源有了两个权威，浏览器就会老老实实下两遍。

`src/assets.js` 开头把这套约定写成三层，各管一段：内容哈希决定 URL，内容不变 URL 就不变；`integrity` 也来自同一份哈希，URL 和校验值永远配套；缓存头只看「URL 上有没有 `v`」，有 `v` 就是不可变内容，锁一年。三层共享一个事实来源，所以不存在「版本号换了、SRI 还是旧的」那种能让页面白屏又难查的状态。preload 用部署号，等于在这三层的第一层上开了个旁路：URL 被写成了「部署号版」，而缓存头照样按「有 `v`」给它 immutable。一个不存在的资源被当成不可变内容缓存住，浏览器没有任何机制去纠正它，只会一冷访问就再下一遍。

这也是我把这次事故归成性能问题、而不是正确性问题的原因。页面照常渲染，样式照常生效，控制台不报错，`check:live` 里跟 CSS 和 integrity 有关的断言全是绿的——出事的只有「多下了 121KB」这一件事。正确性测试覆盖面再全，也照不到这种「两份都对、同时存在」的浪费。

## 三、把它量出来

现象是从 CDP 里看出来的，不是从监控告警里看出来的。Network 面板过滤 `style.css`，冷访问一次出现两条记录，`Initiator` 一条指向 `103 Early Hints`、一条指向 `Document` 的解析器。两条的 `v=` 值不同。把响应体里 `<link rel="stylesheet">` 的 href 复制出来，跟 Network 里的两条一比，就能确认哪条是废的。

想稳定抓到 103，得绕开缓存：URL 上带一个 `?cb=` 随机参数。实测文章页和首页各抓三次，三次都拿到 103，也就是 3/3。绕不开的时候，命中的响应直接从缓存出，源站那条路径不走，103 就不出现——这件事第五节单独说。

这一步只能靠 CDP，curl 看不到 103。它是 1xx 临时响应，在最终的 200 之前就发完了，`curl -D -` 只打印最终响应的头。DevTools 的 Network 面板则把中间响应也记下来，所以能在同一条资源记录上看到 `103 Early Hints` 的痕迹。两条 `style.css` 的 `Initiator` 还不一样：指向 `103 Early Hints` 的那条是浏览器按预告提前发的，指向 `Document` 的那条是 HTML 解析器走到 `<link>` 才发的。同一个文件被两条不同路径各发一次，这条差别就是「两个版本号」在 Network 面板里的样子。

我特意没有用「页面感觉快了还是慢了」来判断修没修好。冷访问和命中缓存的耗时本来就差得远，叠加一次白下的 CSS，体感根本分不出是哪一项造成的。能拿来做归因的只有可逐字符核对的东西：两个 URL、两个 Initiator、一份没人用的响应体。

把能确认的和只能推断的分开列，省得自己骗自己：

| 结论 | 数字 | 来源 |
|---|---|---|
| 每次冷访问多下一份 CSS | 121KB | 事故记录里的字节数，`d20bf49` 提交说明同样写了 |
| 两个 URL 只差一段字符串 | 2 个 URL | CDP Network 里两条 `style.css`，`v=` 值不同 |
| 带 `?cb=` 能稳定抓到 103 | 文章页 3/3，首页 3/3 | CDP 实抓 |
| 两份各被缓存一份 | — | 事故记录里写了；我没有单独去数缓存条目 |
| 这个 bug 让 LCP 多花多少毫秒 | — | 这条没测，只到推断为止 |

表里那行留白是我刻意的。「多下 121KB」和「LCP 晚了多少」不是同一个量，前者的字节数再确定，也推不出后者的毫秒数——中间隔着带宽、CPU 和渲染时序。我没有那组对照数据，就不写那个数字。

我也没把「页面感觉变慢了」写进结论。这类归因最忌讳拿体感当尺子：同一篇冷访问和命中缓存的耗时差一个量级，人根本分不清哪一次慢是这份 CSS 造成的。能落地的只有「两条请求、两个 URL、一份没人用」这种可以逐字符核对的事实。

## 四、改成同一个事实来源

改动落在 `src/index.js` 的 `injectTheme` 里，核心就是把 `assetVersion(env)` 换成 manifest 里的哈希，并且拿不到就不发：

```js
const cssHash = ASSET_HASH[''style.css''] && ASSET_HASH[''style.css''].v;
const hints = [];
if (cssHash) hints.push(`</style.css?v=${cssHash}>; rel=preload; as=style`);
const themeHref = themeCssPath(s.theme);
const themeHash = themeHref && ASSET_HASH[themeHref.replace(/^\//, '''')];
if (themeHref && themeHash) hints.push(`<${themeHref}?v=${themeHash.v}>; rel=preload; as=style`);
```

`if (cssHash)` 这一句不是洁癖。拿不到哈希时，旧代码会退到部署号，于是又回到「两边不一致」的老路；现在的选择是宁可不发 Link 头，也不发一个错的。少一次提前预载，代价是回到「解析到 `<link>` 才下载」；多发一份 121KB，代价是每次冷访问都付一遍。这两笔账不用算。

主题那条也照同一份表取。`themeCssPath` 返回 `/theme/ink.css`，去掉开头的斜杠正好是 manifest 的键 `theme/ink.css`，所以 `ASSET_HASH[themeHref.replace(/^\//, '''')]` 和 `stampAssets` 用的是同一段查找逻辑。新增主题时只要往 manifest 里加一行，两处一起生效；不会再加主题时漏改 head 那一处。

光改代码不够，这种 bug 不会让任何测试变红，必须加一条会失败的断言。`scripts/check-live.mjs` 补的是这两条：

```js
/* ---------- 103 Early Hints：preload 必须与 HTML 同址 ----------
   这条是 2026-11 补的：preload 一度还在用部署号（?v=<部署 UUID>），
   而 HTML 里的 href 已经是内容哈希 —— 两个 URL 差一个字符串，浏览器就当两个资源，
   103 提前下的那份全程没人用，冷访问白下一遍 121KB 的 CSS，还会被边缘各缓存一份。
   两者必须逐字符相等，这条断言就是守它。 */
{
  const { h, body } = await get(''/'');
  const link = h.get(''link'') || '''';
  const pre = link.match(/<([^>]*\/style\.css\?v=[^>]+)>;\s*rel=preload/i);
  const href = body.match(/<link[^>]+href="(\/style\.css\?v=[^"]+)"/);
  ok(''响应头带 style.css 的 preload'', !!pre, pre ? pre[1] : ''没有 Link 头'');
  ok(
    ''preload 地址与 HTML 里的 href 逐字符一致'',
    !!pre && !!href && pre[1] === href[1],
    pre && href && pre[1] !== href[1] ? `preload=${pre[1]} html=${href[1]}` : ''''
  );
}
```

第二条断言用的是 `pre[1] === href[1]`，逐字符相等，不做「看起来差不多」的归一化。这里特意不解析 URL、不比较 `pathname`——一旦允许「等价就算过」，下次有人改了查询参数的拼写顺序，断言还是绿的，浏览器还是下两份。检查结果写进失败信息里，`preload=... html=...` 并排放，不用再去 CDP 里翻。

脚本本身有个细节值得学：体检条目有几十条，失败夹在中间的 `ok` 里很容易漏读，所以末尾把失败项单独列一遍再 `process.exit`。我这次加的两条也吃这套机制——红了不用去翻几十行输出，直接看末尾那两行。

把断言放在 `check:live` 而不是单元测试里，是我的判断：这条规则要守的是「线上真实响应头里的地址」和「线上真实 HTML 里的 href」逐字符相等，本地单测拿不到边缘生成的 103，也没法验证最终吐给浏览器的那份 HTML。它需要打一个真实的 URL，把两边都取回来对比。

线上 `check:live` 跑出 75/75。这类断言的价值不在于这次抓到了什么——改完当然是绿的——而在于下一次：谁要是又把 preload 改回部署号，CI 会直接把两个 URL 打出来。这两条只覆盖 `style.css`；主题 CSS 没有单独断言，靠的是和 head 共用 `themeCssPath` 与 manifest 这两处同一来源。主题那条单独验证不验证，这条没测，只到推断为止。

同一份响应头在缓存回放时也必须成对，之前踩过的 nonce 错位是另一个版本的同类问题，写在[CSP nonce 每次请求都换，缓存里的旧页面怎么办](/p/csp-nonce-cache)里。

## 五、缓存命中时 103 会消失，这不是缺陷

验收的时候我一度以为改坏了：同一条 URL，有时能看到 103，有时只有 200。反复几次之后才反应过来，这是缓存命中与否的差别，跟代码无关。

103 是在源站路径上生成的——准确说，是 Worker 把 Link 头交出去、边缘据此先发 103。缓存命中的响应根本不从源站走，边缘直接吐存好的那份，中间没有「先发个 103」这一步。于是首页有时候只回一个 200，不是功能丢了，是那一次请求根本没经过会发 103 的路。想看 103，加 `?cb=` 绕开缓存，上一节写的 3/3 就是这么抓的。

| 请求形态 | 源站是否参与 | 103 |
|---|---|---|
| 冷访问 / 带 `?cb=` 绕缓存 | 是 | 有，文章页与首页各 3/3 抓到 |
| 缓存命中 | 否 | 没有，只回 200 |
| 关掉 Early Hints 开关 | 是 | 没有 103，Link 退化为普通响应头 |

这里要把两种响应的关系摆正：103 是临时响应，200 才是最终响应。浏览器收到 103 之后仍然要等 200 和它的 HTML body，103 不携带页面内容，也不替代 200。所以把「只回了一个 200」当成异常，是把临时响应和最终响应的位置搞反了——200 一直在，少的只是那张提前发的预告。

第三种情况再说一遍：不开也不会坏。Link 头还在，浏览器仍按 preload 处理，只是启动时机退回解析 HTML 那一刻。103 是「多给的提前量」，不是「preload 生效的前提」；把它当后者，就会在开关没权限改的时候以为整件事白做了。

我后来验收时把两件事分开看：带 `?cb=` 的那次专盯 103 有没有发出来，不带参数的那次专盯命中路径是不是正常返回。混在一次请求里判断，很容易把「这次命中了缓存所以没有 103」误读成「改回去了」。分开之后，两个现象各自都稳定，不再互相干扰。

这套缓存的分层不止一处，CF 边缘和 Worker 内部的 `caches.default` 各有各的命中路径，逐层拆开写在[三层缓存怎么排，才不会被 CF 改写成 4 小时](/p/three-layer-cache)。103 只挂在最外面那条会回源的路径上，这决定了它在命中时注定消失——这是设计使然，不是漏发。

## 六、首图为什么不进 103（以及后来怎么放行的）

同一段 `injectTheme` 里还有一条取舍，和版本号无关，但更容易被「既然 preload 好，那就多 preload 几个」的直觉带偏。最初我只放样式表，不放正文首图。CSS 没有维度、地址唯一，一个 URL 就是一份资源，放进 103 不会有歧义。首图不一样：它是 `<picture>` 加 `srcset`，同一张图有 480、800、1200 三档。Link 头只能写一个固定 URL，等于替浏览器挑档；手机拿到 1200 那张是白下大图，DPR=2 的桌面拿到 480 那张是糊图，两种结果都要先下错的再下对的。

后来放行的办法不是「挑一个折中档」，而是把选择权交还给浏览器。Link 头里同时带 `imagesrcset` 和 `imagesizes`，规则跟正文那段 `<picture>` 里的 `source` 完全一致——本来就是从那段 HTML 里提出来的：

```js
/* 正文首图也预加载。这里跟 CSS 不一样：首图有 480/800/1200 多档，写死一个 URL
   等于替浏览器挑档 —— 手机会白下 1200 那张，或者 DPR=2 的桌面拿到 480 的糊图。
   imagesrcset + imagesizes 让浏览器在收到 103 的那一刻就按自己的视口挑，
   规则跟 <picture> 里的 source 完全一致（本来就是从那段 HTML 里提出来的）。

   只认正文里带 srcset 的 picture：列表页的卡片封面是固定尺寸的缩略图，
   preload 它反而抢走首屏 CSS 的带宽。 */
const lcp = body.match(
  /<source type="image\/avif" srcset="([^"]+)" sizes="([^"]+)"/
);
if (lcp) {
  const first = lcp[1].trim().split(/\s+/)[0];
  // imagesrcset 里有逗号，必须用引号包住，否则 Link 会把它当成两条指令拆开
  hints.push(`<${first}>; rel=preload; as=image; imagesrcset="${lcp[1]}"; imagesizes="${lcp[2]}"`);
}
```

有个细节是 `imagesrcset="${lcp[1]}"` 上的那对引号。`imagesrcset` 的值里带逗号，Link 头又用逗号分隔指令；不加引号，浏览器会把一条 preload 拆成两条残指令。这不是安全性问题，纯粹是语法坑，抓包的时候看起来像「103 里凭空多了一条预载」。

放行还有一条边界：只认正文里带 `srcset` 的 `<picture>`。列表页的卡片封面是固定尺寸的缩略图，没有多档可选；把它塞进 103 只是让一张本来就小的图提前下，却会去抢首屏 CSS 的带宽。CSS 在关键路径上，缩略图不在——带宽有限时先给谁，这个顺序不能反。

正则只取第一个 `<source type="image/avif" srcset="..." sizes="...">`，也就是正文首图的 avif 档列表。`imagesrcset` 直接用匹配到的整串，`imagesizes` 用同一段 `sizes`，等于把 `<picture>` 里的选择规则原样搬到 103 头里。浏览器在收到预告的那一刻就按自己的视口和 DPR 选档，和它稍后解析到 `<picture>` 时做的判断是同一个；不会出现「103 选了 800、HTML 解析后又选 1200」这种分裂。这里能提前多少毫秒，这条没测，只到推断为止。

这段演进和版本号那件事是同一个道理的两面：103 是个提前量，提前的东西必须和后面真正要用的东西**完全同一份**。地址要逐字符一致，图片档位要由同一个 `srcset` 决定。任何一处「差不多就行」，都会变成一次白下。CSS 那次是地址差一个字符串，首图这次是档位差一个判断——形式不同，错法一样。

## 怎么自己验一遍

```bash
# 1) 看 Link 头里的 preload 地址
curl -s -o /dev/null -D - "https://exia.de5.net/?cb=$RANDOM" | grep -i ''^link:''

# 2) 看 HTML 里 style.css 的 href，和上一条逐字符对比
curl -s "https://exia.de5.net/?cb=$RANDOM" | grep -oE ''href="/style\.css\?v=[^"]+"''

# 3) 跑线上体检；两条新断言在 103 Early Hints 那一节
npm run check:live
```

第 1、2 条要带不同的 `?cb=` 分别抓，再把两边的 `v=` 值对一遍。它们必须完全相等，不是「看着像」。

抓 103 本身要用 CDP，curl 看不到中间响应：DevTools → Network → 勾 `?cb=` 随机参数刷新，在 `style.css` 的 `Initiator` 列里找 `103 Early Hints`。冷访问和带 `?cb=` 的都试一次，前者命中缓存时只有 200 属于正常。开关状态在 `Dashboard → Speed → Content Optimization → Early Hints` 看，token 没写权限就只能确认它有没有开，改不了。

收尾跑一次 `npm run check:live`。如果两条 103 断言有一条红了，失败信息会直接给出 `preload=... html=...` 两个地址——复制出来比对，不用再开 CDP。体检条目多，失败项会在末尾单独再列一遍，别只盯着中间那片 `ok`。

#cloudflare #cache #http #debugging
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>11-22 部署完，我在 CDP 的 Network 面板里看到 <code>style.css</code> 被下了两遍。两遍的地址长得几乎一样，都是 <code>/style.css?v=</code>，区别只在 <code>v=</code> 后面那一串：103 Early Hints 提前发出的 preload 用的是部署号，HTML 里 <code>&lt;link&gt;</code> 的 href 用的是内容哈希。浏览器把它们当成两个资源，分别下载、分别解析、分别缓存，其中一份从头到尾没人用。</p>
<p>白下的那份是 121KB CSS。它发生在每一次冷访问上，不是 TTFB 变慢了，也不是 CSS 写大了——是同一个文件被两个版本号指成了两份。两份还各自在边缘缓存里占一份，下一个冷访问照样重来。这类问题检索起来通常落到 <code>103 early hints preload 不匹配</code>、<code>cloudflare early hints css</code> 这些词上，但搜索结果大多只讲 103 是什么，不会告诉你「两个版本号长得像」这件事有多隐蔽。</p>
<p>修法是把两边收进同一个事实来源：preload 的地址也去读 <code>ASSET_HASH[&#39;style.css&#39;].v</code>。拿不到哈希就不发 Link 头，宁缺勿错。提交 <code>d20bf49</code>，线上 <code>check:live</code> 跑出 75/75。</p>
<div class="table-wrap"><table><thead><tr><th>谁写的地址</th><th>长什么样</th><th><code>v=</code> 的来源</th></tr></thead><tbody><tr><td>103 的 <code>Link: rel=preload</code></td><td><code>&lt;/style.css?v=&lt;部署号&gt;&gt;</code></td><td><code>assetVersion(env)</code>，即 <code>SITE_VERSION</code> 或 <code>CF_VERSION_METADATA.id</code></td></tr><tr><td>HTML 里的 <code>&lt;link href&gt;</code></td><td><code>/style.css?v=&lt;内容哈希&gt;</code></td><td><code>ASSET_HASH[&#39;style.css&#39;].v</code>，内容变才变</td></tr></tbody></table></div>
<p>这个修复在提交 <code>d20bf49</code> 里只是「顺手修一个真 bug」那一条，主标题写的是全站视觉收敛——标签云去彩、窄屏首屏、404 补品牌线。性能问题藏在视觉改动的尾巴里，这在复盘时很容易被漏记： changelog 里看不见它，三个月后想知道「121KB 那次是怎么回事」，只能靠提交说明里那几行字。我把它单独写成一篇，也是为了让这条归因有地方落脚。</p>
<p>这篇要讲清楚的不是「preload 怎么写」——那几行代码谁都会。要讲的是三件更容易搞错的事：103 省的到底是哪段时间，为什么两个看起来都像版本号的东西不能混用，以及缓存命中时 103 消失为什么不是缺陷。它们的共同点是都不报错，只会让你在几个月后对着一份「明明开了 Early Hints」的配置纳闷为什么没提速。</p>
<h2 id="一-103-到底省的是哪一段时间"><a class="h-anchor" href="#一-103-到底省的是哪一段时间">#</a>一、103 到底省的是哪一段时间</h2>
<p>先把分工说准，不然后面所有推断都会错位。103 不是 Worker 发的，是 Cloudflare 边缘发的。Worker 只干一件事：在最终响应上挂一条 <code>Link: &lt;/style.css?v=...&gt;; rel=preload; as=style</code> 头。边缘看到这条头，就在 HTML body 之前先吐一个 <code>103 Early Hints</code>，里面带上同一段 Link。浏览器收到 103，不等 HTML 流，先把 CSS 下载起来。</p>
<p>开关在 <code>Dashboard → Speed → Content Optimization → Early Hints</code>。我手上的 token 没有写权限，只能看，改不了。实测下来：不开也不会坏，那个 Link 头退化成普通响应头，浏览器照样当 preload 处理——只是没人提前打招呼，启动时机从「103 那一刻」退回到「HTML 解析到 <code>&lt;link&gt;</code> 那一刻」。换句话说，开关决定的是有没有 103 这个<strong>提前量</strong>，不决定 preload 本来的语义。把它当成「不开就失效」的功能，是误读。</p>
<p>这段串行在本站比在纯静态站上更值得治。静态站的 HTML 由边缘直接吐，head 很快就到，浏览器没等太久就能发现 CSS；本站的 HTML 要过 Worker 渲染，head 到得晚一些，「HTML 到手」与「CSS 开始下载」之间的空隙自然更长。这是我从两站架构差异推出来的，没有做静态站对照，只到推断为止。但方向是清楚的：越依赖服务端渲染，103 的提前量越有可能值钱，也越经不起「预告了一个没人用的地址」这种错法。</p>
<p>它省的时间段很具体，画一条线就清楚：</p>
<div class="table-wrap"><table><thead><tr><th>阶段</th><th>谁在跑</th><th>103 帮不帮</th></tr></thead><tbody><tr><td>TLS 握手</td><td>边缘</td><td>不帮</td></tr><tr><td>Worker 执行（取数、渲染）</td><td>Worker</td><td>不帮</td></tr><tr><td>HTML 第一个字节到手</td><td>网络</td><td>不帮</td></tr><tr><td>浏览器解析到 <code>&lt;link rel=stylesheet&gt;</code></td><td>浏览器</td><td>帮</td></tr><tr><td>CSS 下载</td><td>浏览器</td><td>帮</td></tr></tbody></table></div>
<p>源码里的原话是：「它对 TTFB 没帮助（那时 TLS 和 Worker 都已经跑完了），省的是『HTML 开始到手』到『CSS 开始下载』之间那段。」我完全同意这个界定。103 发出去的时刻，Worker 已经执行完了，最终响应的头还没出——它插在两者之间，目的就是把「解析 HTML 才知道要下 CSS」这步从关键路径上摘掉。那段串行横在 LCP 前面，是我这里唯一想动的地方。</p>
<p>103 本身是个 1xx 临时响应，只带头、不带 HTML。浏览器的处理方式是：收到 103 就按里面的 Link 先发起 CSS 请求，同时继续等真正的 200 和 HTML body。这个机制成立的前提只有一条——103 里预告的资源，必须是后面 HTML 真会用的那份。一旦两边不是同一份，提前量就变成纯粹的浪费，而且比不提前更糟：浏览器已经把带宽花在没人用的字节上了。</p>
<p>所以别拿 TTFB 当用户感知的尺子去验收 103。TTFB 量到的是最终响应的第一个字节，它在这条链上位于 103 之后，103 不会把它挪早。真要量，看的是 CSS 请求的 <code>startTime</code> 相对 HTML 请求 <code>responseStart</code> 往前挪了多少。这次事故里我盯的是「有没有多下一份」，那个位移具体减少多少毫秒，这条没测，只到推断为止。</p>
<h2 id="二-两个版本号-一个像另一个"><a class="h-anchor" href="#二-两个版本号-一个像另一个">#</a>二、两个版本号，一个像另一个</h2>
<p><code>assetVersion(env)</code> 的实现是 <code>env.SITE_VERSION || env.CF_VERSION_METADATA.id || &#39;&#39;</code>。它是一个跟着部署走的标识，跟文件内容没有关系：哪怕 CSS 一个字节没改，重新部署一次它也换。拿它当静态资源的版本号，语义上就是「这次部署的这一版」，而不是「这份内容」。</p>
<p>HTML 那条路不是这样。<code>stampAssets</code> 遇到 manifest 里的文件，会用 <code>ASSET_HASH[文件名].v</code> 覆盖 <code>?v=</code>。这个 v 是内容哈希——现在 <code>assets.gen.js</code> 里 <code>style.css</code> 那一行是 <code>38a1442c00</code>——内容不变它就不变，所以 <code>max-age=31536000, immutable</code> 那种一年强缓存才真的能用满。manifest 里没有的资源（<code>/thumbs/</code>、<code>/cards/</code>）才退回部署号，因为它们是构建产物，文件名按 slug 固定，内容跟着文章改。</p>
<p>出事那版 preload 走的是第一条路：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 改动前（d20bf49 之前）</span>
<span class="tok-k">const</span> av = <span class="tok-f">assetVersion</span>(env);
<span class="tok-k">const</span> avq = av ? <span class="tok-s">`?v=${encodeURIComponent(av)}`</span> : <span class="tok-s">&#39;&#39;</span>;
<span class="tok-k">const</span> hints = [<span class="tok-s">`&lt;/style.css${avq}&gt;; rel=preload; as=style`</span>];
<span class="tok-k">const</span> themeHref = <span class="tok-f">themeCssPath</span>(s.theme);
<span class="tok-k">if</span> (themeHref) hints.<span class="tok-f">push</span>(<span class="tok-s">`&lt;${themeHref}${avq}&gt;; rel=preload; as=style`</span>);</code></pre></div>
<p>同一时刻，HTML 里的 href 已经被 <code>stampAssets</code> 改成了内容哈希。两个字符串都是 <code>?v=</code> 接一串十六进制样的字符，肉眼扫过去几乎一样；浏览器按完整 URL 做缓存键，差一个字符就是两个资源。这是它最难查的地方——不是「明显错了」，而是「看起来对」。</p>
<p>主题 CSS 同一条链上中招。<code>themeCssPath</code> 把纸韵和安知鱼留在主 <code>style.css</code> 里，其余五套主题各一个 <code>/theme/&lt;id&gt;.css</code> 文件。旧代码给这个路径也拼上部署号，而 head 里那一份走的是内容哈希。更麻烦的是它<strong>只在特定主题下出现</strong>：你用默认主题复现不出来，换一套主题才慢，等于把 bug 藏进了一个没人测的分支。<code>src/settings.js</code> 开头那段注释写的就是这个理由——把路径单独抽出来，是为了让 103 和 head 里的 <code>&lt;link&gt;</code> 用同一个来源；两处各写一份判断，加主题时必然漏改一处，漏的那处表现为「preload 了一个 404 地址」，而且只在某个主题下出现，测不到。</p>
<div class="table-wrap"><table><thead><tr><th>资源</th><th>HTML href 的 <code>v</code></th><th>旧 preload 的 <code>v</code></th><th>结果</th></tr></thead><tbody><tr><td><code>style.css</code></td><td>内容哈希</td><td>部署号</td><td>两份，冷访问多下 121KB</td></tr><tr><td><code>theme/ink.css</code> 等五套</td><td>内容哈希</td><td>部署号</td><td>两份，且只在非纸韵/安知鱼主题下出现</td></tr><tr><td><code>/thumbs/</code>、<code>/cards/</code></td><td>部署号</td><td>不进 103</td><td>不受影响</td></tr></tbody></table></div>
<p>注意第三行：退回部署号这件事本身不是罪，罪在<strong>两边不一致</strong>。thumbs 和 cards 的 href 与它们的缓存策略本来就按部署号走，没有第二份声明跟它打架。一旦同一资源有了两个权威，浏览器就会老老实实下两遍。</p>
<p><code>src/assets.js</code> 开头把这套约定写成三层，各管一段：内容哈希决定 URL，内容不变 URL 就不变；<code>integrity</code> 也来自同一份哈希，URL 和校验值永远配套；缓存头只看「URL 上有没有 <code>v</code>」，有 <code>v</code> 就是不可变内容，锁一年。三层共享一个事实来源，所以不存在「版本号换了、SRI 还是旧的」那种能让页面白屏又难查的状态。preload 用部署号，等于在这三层的第一层上开了个旁路：URL 被写成了「部署号版」，而缓存头照样按「有 <code>v</code>」给它 immutable。一个不存在的资源被当成不可变内容缓存住，浏览器没有任何机制去纠正它，只会一冷访问就再下一遍。</p>
<p>这也是我把这次事故归成性能问题、而不是正确性问题的原因。页面照常渲染，样式照常生效，控制台不报错，<code>check:live</code> 里跟 CSS 和 integrity 有关的断言全是绿的——出事的只有「多下了 121KB」这一件事。正确性测试覆盖面再全，也照不到这种「两份都对、同时存在」的浪费。</p>
<h2 id="三-把它量出来"><a class="h-anchor" href="#三-把它量出来">#</a>三、把它量出来</h2>
<p>现象是从 CDP 里看出来的，不是从监控告警里看出来的。Network 面板过滤 <code>style.css</code>，冷访问一次出现两条记录，<code>Initiator</code> 一条指向 <code>103 Early Hints</code>、一条指向 <code>Document</code> 的解析器。两条的 <code>v=</code> 值不同。把响应体里 <code>&lt;link rel=&quot;stylesheet&quot;&gt;</code> 的 href 复制出来，跟 Network 里的两条一比，就能确认哪条是废的。</p>
<p>想稳定抓到 103，得绕开缓存：URL 上带一个 <code>?cb=</code> 随机参数。实测文章页和首页各抓三次，三次都拿到 103，也就是 3/3。绕不开的时候，命中的响应直接从缓存出，源站那条路径不走，103 就不出现——这件事第五节单独说。</p>
<p>这一步只能靠 CDP，curl 看不到 103。它是 1xx 临时响应，在最终的 200 之前就发完了，<code>curl -D -</code> 只打印最终响应的头。DevTools 的 Network 面板则把中间响应也记下来，所以能在同一条资源记录上看到 <code>103 Early Hints</code> 的痕迹。两条 <code>style.css</code> 的 <code>Initiator</code> 还不一样：指向 <code>103 Early Hints</code> 的那条是浏览器按预告提前发的，指向 <code>Document</code> 的那条是 HTML 解析器走到 <code>&lt;link&gt;</code> 才发的。同一个文件被两条不同路径各发一次，这条差别就是「两个版本号」在 Network 面板里的样子。</p>
<p>我特意没有用「页面感觉快了还是慢了」来判断修没修好。冷访问和命中缓存的耗时本来就差得远，叠加一次白下的 CSS，体感根本分不出是哪一项造成的。能拿来做归因的只有可逐字符核对的东西：两个 URL、两个 Initiator、一份没人用的响应体。</p>
<p>把能确认的和只能推断的分开列，省得自己骗自己：</p>
<div class="table-wrap"><table><thead><tr><th>结论</th><th>数字</th><th>来源</th></tr></thead><tbody><tr><td>每次冷访问多下一份 CSS</td><td>121KB</td><td>事故记录里的字节数，<code>d20bf49</code> 提交说明同样写了</td></tr><tr><td>两个 URL 只差一段字符串</td><td>2 个 URL</td><td>CDP Network 里两条 <code>style.css</code>，<code>v=</code> 值不同</td></tr><tr><td>带 <code>?cb=</code> 能稳定抓到 103</td><td>文章页 3/3，首页 3/3</td><td>CDP 实抓</td></tr><tr><td>两份各被缓存一份</td><td>—</td><td>事故记录里写了；我没有单独去数缓存条目</td></tr><tr><td>这个 bug 让 LCP 多花多少毫秒</td><td>—</td><td>这条没测，只到推断为止</td></tr></tbody></table></div>
<p>表里那行留白是我刻意的。「多下 121KB」和「LCP 晚了多少」不是同一个量，前者的字节数再确定，也推不出后者的毫秒数——中间隔着带宽、CPU 和渲染时序。我没有那组对照数据，就不写那个数字。</p>
<p>我也没把「页面感觉变慢了」写进结论。这类归因最忌讳拿体感当尺子：同一篇冷访问和命中缓存的耗时差一个量级，人根本分不清哪一次慢是这份 CSS 造成的。能落地的只有「两条请求、两个 URL、一份没人用」这种可以逐字符核对的事实。</p>
<h2 id="四-改成同一个事实来源"><a class="h-anchor" href="#四-改成同一个事实来源">#</a>四、改成同一个事实来源</h2>
<p>改动落在 <code>src/index.js</code> 的 <code>injectTheme</code> 里，核心就是把 <code>assetVersion(env)</code> 换成 manifest 里的哈希，并且拿不到就不发：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> cssHash = ASSET_HASH[<span class="tok-s">&#39;style.css&#39;</span>] &amp;&amp; ASSET_HASH[<span class="tok-s">&#39;style.css&#39;</span>].v;
<span class="tok-k">const</span> hints = [];
<span class="tok-k">if</span> (cssHash) hints.<span class="tok-f">push</span>(<span class="tok-s">`&lt;/style.css?v=${cssHash}&gt;; rel=preload; as=style`</span>);
<span class="tok-k">const</span> themeHref = <span class="tok-f">themeCssPath</span>(s.theme);
<span class="tok-k">const</span> themeHash = themeHref &amp;&amp; ASSET_HASH[themeHref.<span class="tok-f">replace</span>(/^\<span class="tok-c">//, &#39;&#39;)];</span>
<span class="tok-k">if</span> (themeHref &amp;&amp; themeHash) hints.<span class="tok-f">push</span>(<span class="tok-s">`&lt;${themeHref}?v=${themeHash.v}&gt;; rel=preload; as=style`</span>);</code></pre></div>
<p><code>if (cssHash)</code> 这一句不是洁癖。拿不到哈希时，旧代码会退到部署号，于是又回到「两边不一致」的老路；现在的选择是宁可不发 Link 头，也不发一个错的。少一次提前预载，代价是回到「解析到 <code>&lt;link&gt;</code> 才下载」；多发一份 121KB，代价是每次冷访问都付一遍。这两笔账不用算。</p>
<p>主题那条也照同一份表取。<code>themeCssPath</code> 返回 <code>/theme/ink.css</code>，去掉开头的斜杠正好是 manifest 的键 <code>theme/ink.css</code>，所以 <code>ASSET_HASH[themeHref.replace(/^\//, &#39;&#39;)]</code> 和 <code>stampAssets</code> 用的是同一段查找逻辑。新增主题时只要往 manifest 里加一行，两处一起生效；不会再加主题时漏改 head 那一处。</p>
<p>光改代码不够，这种 bug 不会让任何测试变红，必须加一条会失败的断言。<code>scripts/check-live.mjs</code> 补的是这两条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* ---------- 103 Early Hints：preload 必须与 HTML 同址 ----------
   这条是 2026-11 补的：preload 一度还在用部署号（?v=&lt;部署 UUID&gt;），
   而 HTML 里的 href 已经是内容哈希 —— 两个 URL 差一个字符串，浏览器就当两个资源，
   103 提前下的那份全程没人用，冷访问白下一遍 121KB 的 CSS，还会被边缘各缓存一份。
   两者必须逐字符相等，这条断言就是守它。 */</span>
{
  <span class="tok-k">const</span> { h, body } = <span class="tok-k">await</span> <span class="tok-k">get</span>(<span class="tok-s">&#39;/&#39;</span>);
  <span class="tok-k">const</span> link = h.<span class="tok-k">get</span>(<span class="tok-s">&#39;link&#39;</span>) || <span class="tok-s">&#39;&#39;</span>;
  <span class="tok-k">const</span> pre = link.<span class="tok-f">match</span>(/&lt;([^&gt;]*\/style\.css\?v=[^&gt;]+)&gt;;\s*rel=preload/i);
  <span class="tok-k">const</span> href = body.<span class="tok-f">match</span>(/&lt;link[^&gt;]+href=<span class="tok-s">&quot;(\/style\.css\?v=[^&quot;</span>]+)&quot;/);
  <span class="tok-f">ok</span>(<span class="tok-s">&#39;响应头带 style.css 的 preload&#39;</span>, !!pre, pre ? pre[<span class="tok-n">1</span>] : <span class="tok-s">&#39;没有 Link 头&#39;</span>);
  <span class="tok-f">ok</span>(
    <span class="tok-s">&#39;preload 地址与 HTML 里的 href 逐字符一致&#39;</span>,
    !!pre &amp;&amp; !!href &amp;&amp; pre[<span class="tok-n">1</span>] === href[<span class="tok-n">1</span>],
    pre &amp;&amp; href &amp;&amp; pre[<span class="tok-n">1</span>] !== href[<span class="tok-n">1</span>] ? <span class="tok-s">`preload=${pre[1]} html=${href[1]}`</span> : <span class="tok-s">&#39;&#39;</span>
  );
}</code></pre></div>
<p>第二条断言用的是 <code>pre[1] === href[1]</code>，逐字符相等，不做「看起来差不多」的归一化。这里特意不解析 URL、不比较 <code>pathname</code>——一旦允许「等价就算过」，下次有人改了查询参数的拼写顺序，断言还是绿的，浏览器还是下两份。检查结果写进失败信息里，<code>preload=... html=...</code> 并排放，不用再去 CDP 里翻。</p>
<p>脚本本身有个细节值得学：体检条目有几十条，失败夹在中间的 <code>ok</code> 里很容易漏读，所以末尾把失败项单独列一遍再 <code>process.exit</code>。我这次加的两条也吃这套机制——红了不用去翻几十行输出，直接看末尾那两行。</p>
<p>把断言放在 <code>check:live</code> 而不是单元测试里，是我的判断：这条规则要守的是「线上真实响应头里的地址」和「线上真实 HTML 里的 href」逐字符相等，本地单测拿不到边缘生成的 103，也没法验证最终吐给浏览器的那份 HTML。它需要打一个真实的 URL，把两边都取回来对比。</p>
<p>线上 <code>check:live</code> 跑出 75/75。这类断言的价值不在于这次抓到了什么——改完当然是绿的——而在于下一次：谁要是又把 preload 改回部署号，CI 会直接把两个 URL 打出来。这两条只覆盖 <code>style.css</code>；主题 CSS 没有单独断言，靠的是和 head 共用 <code>themeCssPath</code> 与 manifest 这两处同一来源。主题那条单独验证不验证，这条没测，只到推断为止。</p>
<p>同一份响应头在缓存回放时也必须成对，之前踩过的 nonce 错位是另一个版本的同类问题，写在<a href="/p/csp-nonce-cache">CSP nonce 每次请求都换，缓存里的旧页面怎么办</a>里。</p>
<h2 id="五-缓存命中时-103-会消失-这不是缺陷"><a class="h-anchor" href="#五-缓存命中时-103-会消失-这不是缺陷">#</a>五、缓存命中时 103 会消失，这不是缺陷</h2>
<p>验收的时候我一度以为改坏了：同一条 URL，有时能看到 103，有时只有 200。反复几次之后才反应过来，这是缓存命中与否的差别，跟代码无关。</p>
<p>103 是在源站路径上生成的——准确说，是 Worker 把 Link 头交出去、边缘据此先发 103。缓存命中的响应根本不从源站走，边缘直接吐存好的那份，中间没有「先发个 103」这一步。于是首页有时候只回一个 200，不是功能丢了，是那一次请求根本没经过会发 103 的路。想看 103，加 <code>?cb=</code> 绕开缓存，上一节写的 3/3 就是这么抓的。</p>
<div class="table-wrap"><table><thead><tr><th>请求形态</th><th>源站是否参与</th><th>103</th></tr></thead><tbody><tr><td>冷访问 / 带 <code>?cb=</code> 绕缓存</td><td>是</td><td>有，文章页与首页各 3/3 抓到</td></tr><tr><td>缓存命中</td><td>否</td><td>没有，只回 200</td></tr><tr><td>关掉 Early Hints 开关</td><td>是</td><td>没有 103，Link 退化为普通响应头</td></tr></tbody></table></div>
<p>这里要把两种响应的关系摆正：103 是临时响应，200 才是最终响应。浏览器收到 103 之后仍然要等 200 和它的 HTML body，103 不携带页面内容，也不替代 200。所以把「只回了一个 200」当成异常，是把临时响应和最终响应的位置搞反了——200 一直在，少的只是那张提前发的预告。</p>
<p>第三种情况再说一遍：不开也不会坏。Link 头还在，浏览器仍按 preload 处理，只是启动时机退回解析 HTML 那一刻。103 是「多给的提前量」，不是「preload 生效的前提」；把它当后者，就会在开关没权限改的时候以为整件事白做了。</p>
<p>我后来验收时把两件事分开看：带 <code>?cb=</code> 的那次专盯 103 有没有发出来，不带参数的那次专盯命中路径是不是正常返回。混在一次请求里判断，很容易把「这次命中了缓存所以没有 103」误读成「改回去了」。分开之后，两个现象各自都稳定，不再互相干扰。</p>
<p>这套缓存的分层不止一处，CF 边缘和 Worker 内部的 <code>caches.default</code> 各有各的命中路径，逐层拆开写在<a href="/p/three-layer-cache">三层缓存怎么排，才不会被 CF 改写成 4 小时</a>。103 只挂在最外面那条会回源的路径上，这决定了它在命中时注定消失——这是设计使然，不是漏发。</p>
<h2 id="六-首图为什么不进-103-以及后来怎么放行的"><a class="h-anchor" href="#六-首图为什么不进-103-以及后来怎么放行的">#</a>六、首图为什么不进 103（以及后来怎么放行的）</h2>
<p>同一段 <code>injectTheme</code> 里还有一条取舍，和版本号无关，但更容易被「既然 preload 好，那就多 preload 几个」的直觉带偏。最初我只放样式表，不放正文首图。CSS 没有维度、地址唯一，一个 URL 就是一份资源，放进 103 不会有歧义。首图不一样：它是 <code>&lt;picture&gt;</code> 加 <code>srcset</code>，同一张图有 480、800、1200 三档。Link 头只能写一个固定 URL，等于替浏览器挑档；手机拿到 1200 那张是白下大图，DPR=2 的桌面拿到 480 那张是糊图，两种结果都要先下错的再下对的。</p>
<p>后来放行的办法不是「挑一个折中档」，而是把选择权交还给浏览器。Link 头里同时带 <code>imagesrcset</code> 和 <code>imagesizes</code>，规则跟正文那段 <code>&lt;picture&gt;</code> 里的 <code>source</code> 完全一致——本来就是从那段 HTML 里提出来的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 正文首图也预加载。这里跟 CSS 不一样：首图有 480/800/1200 多档，写死一个 URL
   等于替浏览器挑档 —— 手机会白下 1200 那张，或者 DPR=2 的桌面拿到 480 的糊图。
   imagesrcset + imagesizes 让浏览器在收到 103 的那一刻就按自己的视口挑，
   规则跟 &lt;picture&gt; 里的 source 完全一致（本来就是从那段 HTML 里提出来的）。

   只认正文里带 srcset 的 picture：列表页的卡片封面是固定尺寸的缩略图，
   preload 它反而抢走首屏 CSS 的带宽。 */</span>
<span class="tok-k">const</span> lcp = body.<span class="tok-f">match</span>(
  /&lt;source type=<span class="tok-s">&quot;image\/avif&quot;</span> srcset=<span class="tok-s">&quot;([^&quot;</span>]+)<span class="tok-s">&quot; sizes=&quot;</span>([^<span class="tok-s">&quot;]+)&quot;</span>/
);
<span class="tok-k">if</span> (lcp) {
  <span class="tok-k">const</span> first = lcp[<span class="tok-n">1</span>].<span class="tok-f">trim</span>().<span class="tok-f">split</span>(/\s+/)[<span class="tok-n">0</span>];
  <span class="tok-c">// imagesrcset 里有逗号，必须用引号包住，否则 Link 会把它当成两条指令拆开</span>
  hints.<span class="tok-f">push</span>(<span class="tok-s">`&lt;${first}&gt;; rel=preload; as=image; imagesrcset=&quot;${lcp[1]}&quot;; imagesizes=&quot;${lcp[2]}&quot;`</span>);
}</code></pre></div>
<p>有个细节是 <code>imagesrcset=&quot;${lcp[1]}&quot;</code> 上的那对引号。<code>imagesrcset</code> 的值里带逗号，Link 头又用逗号分隔指令；不加引号，浏览器会把一条 preload 拆成两条残指令。这不是安全性问题，纯粹是语法坑，抓包的时候看起来像「103 里凭空多了一条预载」。</p>
<p>放行还有一条边界：只认正文里带 <code>srcset</code> 的 <code>&lt;picture&gt;</code>。列表页的卡片封面是固定尺寸的缩略图，没有多档可选；把它塞进 103 只是让一张本来就小的图提前下，却会去抢首屏 CSS 的带宽。CSS 在关键路径上，缩略图不在——带宽有限时先给谁，这个顺序不能反。</p>
<p>正则只取第一个 <code>&lt;source type=&quot;image/avif&quot; srcset=&quot;...&quot; sizes=&quot;...&quot;&gt;</code>，也就是正文首图的 avif 档列表。<code>imagesrcset</code> 直接用匹配到的整串，<code>imagesizes</code> 用同一段 <code>sizes</code>，等于把 <code>&lt;picture&gt;</code> 里的选择规则原样搬到 103 头里。浏览器在收到预告的那一刻就按自己的视口和 DPR 选档，和它稍后解析到 <code>&lt;picture&gt;</code> 时做的判断是同一个；不会出现「103 选了 800、HTML 解析后又选 1200」这种分裂。这里能提前多少毫秒，这条没测，只到推断为止。</p>
<p>这段演进和版本号那件事是同一个道理的两面：103 是个提前量，提前的东西必须和后面真正要用的东西<strong>完全同一份</strong>。地址要逐字符一致，图片档位要由同一个 <code>srcset</code> 决定。任何一处「差不多就行」，都会变成一次白下。CSS 那次是地址差一个字符串，首图这次是档位差一个判断——形式不同，错法一样。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1) 看 Link 头里的 preload 地址</span>
<span class="tok-k">curl</span> -s -o /dev/null -D - <span class="tok-s">&quot;https://exia.de5.net/?cb=$RANDOM&quot;</span> | <span class="tok-k">grep</span> -i <span class="tok-s">&#39;^link:&#39;</span>

<span class="tok-c"># 2) 看 HTML 里 style.css 的 href，和上一条逐字符对比</span>
<span class="tok-k">curl</span> -s <span class="tok-s">&quot;https://exia.de5.net/?cb=$RANDOM&quot;</span> | <span class="tok-k">grep</span> -oE <span class="tok-s">&#39;href=&quot;/style\.css\?v=[^&quot;]+&quot;&#39;</span>

<span class="tok-c"># 3) 跑线上体检；两条新断言在 103 Early Hints 那一节</span>
<span class="tok-k">npm</span> run check:live</code></pre></div>
<p>第 1、2 条要带不同的 <code>?cb=</code> 分别抓，再把两边的 <code>v=</code> 值对一遍。它们必须完全相等，不是「看着像」。</p>
<p>抓 103 本身要用 CDP，curl 看不到中间响应：DevTools → Network → 勾 <code>?cb=</code> 随机参数刷新，在 <code>style.css</code> 的 <code>Initiator</code> 列里找 <code>103 Early Hints</code>。冷访问和带 <code>?cb=</code> 的都试一次，前者命中缓存时只有 200 属于正常。开关状态在 <code>Dashboard → Speed → Content Optimization → Early Hints</code> 看，token 没写权限就只能确认它有没有开，改不了。</p>
<p>收尾跑一次 <code>npm run check:live</code>。如果两条 103 断言有一条红了，失败信息会直接给出 <code>preload=... html=...</code> 两个地址——复制出来比对，不用再开 CDP。体检条目多，失败项会在末尾单独再列一遍，别只盯着中间那片 <code>ok</code>。</p>
<p><a class="tag-inline" href="/tag/cloudflare">#cloudflare</a> <a class="tag-inline" href="/tag/cache">#cache</a> <a class="tag-inline" href="/tag/http">#http</a> <a class="tag-inline" href="/tag/debugging">#debugging</a></p>', '', 'log', '103 的 Link preload 取部署号，HTML href 取内容哈希，两个 URL 差一个字符串=两个资源。冷访问白下 121KB CSS，两份各缓存一份。修法是把出处换成同一份 ASSET_HASH，拿不到就不发；check-live 加逐字符比对守门。',
        '', 0, 0, 0, 1, '2027-01-13 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'early-hints-preload-mismatch' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('cache') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'early-hints-preload-mismatch' AND t.name = 'cache';
INSERT INTO tags (name) VALUES ('http') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'early-hints-preload-mismatch' AND t.name = 'http';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'early-hints-preload-mismatch' AND t.name = 'debugging';
INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('d1-schema-migrations', 'D1 表结构版本化：第一次跑检查就抓到三处漂移', '## 结论

表结构没有版本记录的时候，它其实有三份互相矛盾的描述：线上真跑着的库、`db:init` 用的 `schema.sql`、还有代码里默认「这张表有这些列」的 SQL。三份各说各话，谁也不负责跟谁对齐。第一次跑 `scripts/schema.mjs check`，三处漂移当场抓到，外加一笔本地库的旧账。

最险的一处是 `schema.sql` 的 `friends` 表少了 `http_status` 和 `latency_ms`。`src/cron.js` 会写这两列，用 `db:init` 建出来的新库一上线就撞 `no such column`——这类问题在开发机上测不出来，因为线上库一直有这两列，cron 一直在写，缺的只是那份当「标准」用的建库脚本。

另外两处是索引的双向漂移：`schema.sql` 记着 `idx_pv_day` / `idx_pv_path`，线上根本没有；线上有 `idx_posts_published` / `idx_posts_series` / `idx_comments_ip`，`schema.sql` 一个没记。少记的索引不会报错，只会让「按这个结构重建一份」从一开始就不可信。

修法不是再重写一份 `schema.sql`，是承认它不可信，改成一份可重放的基线加一套检查。`migrations/0001_baseline.sql` 从线上 `sqlite_master` 导出，全部 `IF NOT EXISTS`；存量库 apply 是 **21 commands / 1.45ms** 的 no-op，只让 wrangler 在 `d1_migrations` 里记一笔，空库则一次建齐。

三份描述都不会自己报错。线上库照常服务请求，`schema.sql` 照常能建出一个库，代码照常在已有库上写成功——每一份在自己的上下文里都是对的，只有把它们两两摆在一起才露出裂缝。漂移这个叫法很贴切：不是谁错了，是它们各自走远了。

这套东西挂在一个 Worker 上跑，整体取舍写在[单 Worker 博客的架构全貌](/p/workers-blog-pillar)里。这一篇只讲数据层那一格：提交 `0be25e6`，线上 `check:live` 73/73。

## 一、先承认没有版本记录

这些表是「写功能时顺手 `ALTER` 一下」长出来的。加友链检测就 `ALTER TABLE friends ADD COLUMN http_status`，加封面就给 `posts` 加一列。每次只改当下要用的那个库，改完不记，也没有一个文件说「到现在为止结构长这样」。

顺手 `ALTER` 的诱惑在于成本看着是零：一行命令，当场解决眼前的功能，没有失败反馈。它的成本只在出现第二个环境那一刻才结算——而第二个环境迟早会出现，可能是一台新机器，可能是一次灾难恢复，也可能只是本地库被清掉重建。

没有版本记录的代价不是乱，是没法回答一个很具体的问题：眼前这个库，是从哪一步长成现在这样的。每台库都有自己的 ALTER 史——线上改过线上的列，本地改过本地的列，`db:init` 手里是某一时刻的快照。三份描述不是三个人写的三种观点，是同一份代码在不同时间点留下的三个切片。

我第一反应是去翻 `schema.sql`，以为它就是答案。翻完发现它只是 `db:init` 用的建库脚本，后来加的列没人同步回去；而且它和线上库从来没被比对过，连「两者是不是不一样」都没人知道。所谓三份描述，是我第一次把三者摆在一起时才成立的——在那之前它们各自都「能用」。

第三份描述最隐蔽：代码里的 SQL。它不说自己需要哪些列，它只是 `INSERT INTO friends (slug, url, http_status, ...)`，隐含着「这张表已经有这些列」。没人写文档，检查器也不看代码，于是这一份长期游离在视线外。

本地首页起不来那次，现象落在页面上，很容易先去查渲染模板和 Markdown 解析。真因却是 `posts` 表在本地少了两列。结构漂移伪装成功能 bug 的时候，排查路径会被它带偏——报错发生在读数据的地方，根因写在写结构的地方，两者隔着一层。

我做的第一步不是修漂移，是承认没有版本记录，再把「哪份算数」定下来：线上库算数，`schema.sql` 和代码都得向它对齐；但线上库本身也要能被重放出来，否则换台机器就重建不了。承认这一点之后，后面所有决定都顺了。

## 二、第一次检查抓到的三处漂移

`scripts/schema.mjs check` 把三份描述两两对照，输出不是一句「通过 / 不通过」，是逐条列出差异。我把第一次实跑的四条发现原样贴在这里：前三条是描述之间的漂移，第四条是本地库自己的旧账。每条差异都点名两份来源和具体对象，不写「结构不一致」这种没法动手的结论——检查器的输出得能直接翻译成下一步动作。

| 发现 | 哪两份对不上 | 具体内容 | 后果 |
|---|---|---|---|
| 1 | `schema.sql` ↔ 代码 | `friends` 缺 `http_status` / `latency_ms` | `src/cron.js` 写这两列，`db:init` 建的库上线即 `no such column` |
| 2 | `schema.sql` ↔ 线上 | `schema.sql` 多出 `idx_pv_day` / `idx_pv_path` | 线上根本没有，等于重建出一个线上没有的结构 |
| 3 | 线上 ↔ `schema.sql` | 线上有 `idx_posts_published` / `idx_posts_series` / `idx_comments_ip` | `schema.sql` 漏记，按它重建后这三个索引消失 |
| 4 | 本地库 ↔ 线上 | 本地 `posts` 缺 `html_content` / `cover_body` | 本地首页起不来，已 `ALTER` 补上 |

第 1 条最要命，因为它不会在测试期暴露。线上库有那两列，cron 一直在写，`schema.sql` 没记；开发时谁也不会拿 `db:init` 从零建一个库再接 cron。同一份代码，在已有库上跑得好好的，换台干净机器按文档初始化，一写就炸。

本地库和线上库同名不同物这件事，[D1 报错 no such table](/p/d1-no-such-table)里拆过一次，这里撞的是它的近亲 `no such column`：不是表不存在，是列不存在。第 4 条的 `html_content` / `cover_body` 同理，本地首页起不来，真因就是这两列在本地 `posts` 上缺席，不是渲染代码写错。它在写这篇之前已经 `ALTER` 补上，我把它留在表里不是为了留案底，是因为它解释了为什么我对漂移后知后觉——本地库少两列照样能让人误以为是页面 bug。

第 2 和第 3 条方向相反，正好说明「互相漂」不是修辞：`schema.sql` 比线上多了两个索引，又比线上少了三个。从名字能猜出这些索引的意图：`idx_posts_published` 大约服务于按发布时间取列表，`idx_posts_series` 服务于系列，`idx_comments_ip` 服务于按 IP 过滤。这几个用途我没逐条跑 `EXPLAIN`，只到从命名推断为止。能确定的是，索引缺失不会当场报错，慢不慢我没量，这条没测，只到推断为止；但「按 `schema.sql` 重建线上」这个念头，从此不能成立了。

## 三、基线不是新建，是从线上导出来的

定下「线上算数」之后，基线文件的来源就明确了：不是我照着记忆重写一遍 DDL，是从线上 `sqlite_master` 把真实建表语句导出来，整理成干净、可重放的 SQL，存成 `migrations/0001_baseline.sql`。

线上 `sqlite_master` 里的原始建表语句是能跑的，但不能直接拿进 migrations。它没有 `IF NOT EXISTS`，照搬过去，存量库第一次 apply 就撞 `table already exists`。我做的整理只有两类动作：给每个 `CREATE TABLE` / `CREATE INDEX` 补上 `IF NOT EXISTS`，把导出时带的格式噪声抹平；列、类型、约束一个字不改。整理得越少，基线越像线上，越不容易再引入新分歧。「干净」在这里就指只留结构声明，不把某一时刻的数据内容掺进来。

导出时这个细节必须处理到位：所有 `CREATE` 都加 `IF NOT EXISTS`。存量库已经有这些表和索引，apply 一遍应该是 no-op；空库则一遍建齐。两种场景跑同一份文件，这是版本化能成立的前提，也是我愿意把「导出」当成基线来源的前提。

实测存量库上 apply 这一遍：**21 commands / 1.45ms**。21 条命令里绝大部分是撞到已存在对象后的空操作，1.45ms 是 wrangler 报出来的执行时间。它没改任何一行数据，唯一的实际效果是让 wrangler 在 `d1_migrations` 表里记了一笔——这笔记录就是后面所有幂等判断的依据。要确认它真是 no-op，办法是 apply 前后各 `dump` 一次比对输出；这一步是建基线时的一次性核对，我没把它做成每次发版都要跑的断言。

```sql
-- migrations/0001_baseline.sql 节选：列、类型、约束照线上 sqlite_master 原样导出
-- 这里只摘与漂移相关的声明，完整 DDL 在文件里
CREATE TABLE IF NOT EXISTS friends (
  -- 线上既有的其余列原样保留
  http_status INTEGER,
  latency_ms INTEGER
);

-- 索引同样带 IF NOT EXISTS：存量库撞到就跳过，空库才真正建
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published);
CREATE INDEX IF NOT EXISTS idx_posts_series ON posts(series);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip);
```

空库那条路径我更在意。以前按 `db:init` 建出来的库，正是第 1 条漂移的受害方：cron 一写 `http_status` 就炸。现在空库 apply 这一遍，表和索引一次建齐，建出来的结构和线上重放出来的结构同源。同一份 migration 同时服务「已有库升级」和「新库初始化」，两条路径才不会再分叉。

从线上导出也有边界：它描述的是当前状态，不是历史。基线建好之后就不再改，0002 之后的新变更写进新文件——这样任何时间点重建出来的结构，都能按文件名顺序重放到那一刻，而不是永远取一份不断被覆盖的快照。

我犯过一个惯性错误：第一版想把 `schema.sql` 改名成 baseline 交差。改名解决不了漂移——它带着缺的两列和多出的两个索引，只会把错的东西正式化，还给它盖了个「版本化」的章。基线必须从线上导出，不能从另一份已经漂过的副本推导。

## 四、解析器只写一份

漂移能抓到，前提是「怎么读一份 SQL」只有一个答案。我差点写两个解析器：一个给 `check` 用，从线上 `sqlite_master` 读；一个给测试用，从 migration 文件读。两个解析器读同一句 `CREATE TABLE` 稍有分歧，检查就会报假阳性或者漏报，那比没有检查更糟——至少没有检查时没人信它。

两个解析器会怎么分歧不用列举也能想到：一句跨多行的 `CREATE TABLE`、一个带引号的标识符、一段注释里出现的 `CREATE`，都可能被两边读成不同结果。到时候 check 说缺列、test 说不缺，我得先判断哪个解析器错了，再判断结构错了——检查工具本身成了新的排查对象。共用一份解析器，把这个分支直接删掉。

解析器本身是纯函数：同一份输入吐出同一个结构对象，不读环境变量，不看 D1 连接状态。这份纯粹性是它能被两边共用的前提——check 拿着它去对线上，test 拿着它去对内存库，中间没有任何随上下文变化的分支。

所以 `parseSchema` 和 `mergeSchema` 都收进 `scripts/sql-schema.mjs`，`check` 和 `test` 共用。parse 把 DDL 拆成「表 → 列集合 / 索引集合」，merge 把 `0001`、`0002`……按序叠成一份期望结构。两个子命令看到的期望是同一个对象，差异只可能来自真差异，不会来自解析口径不一致。

```js
// scripts/sql-schema.mjs：check 与 test 共用这一份解析结果
import { parseSchema, mergeSchema } from ''./sql-schema.mjs'';

const baseline = parseSchema(read(''migrations/0001_baseline.sql''));
const expected = mergeSchema([
  baseline,
  parseSchema(read(''migrations/0002_xxx.sql'')),
]);
// expected.tables.get(''friends'').columns 就是唯一判据
```

merge 按文件名排序叠加，`0001` 必须排在 `0002` 前面。文件名用四位数字补零，目的就是让字典序等于版本序；到了五位数那天得换排序规则，那是很远的事，现在不管。`dump` 和 `expected` 两个子命令则是排查用的：`dump` 打线上实际结构，`expected` 打迁移叠出来的期望结构，两边各存一份贴到一起 diff，比对着报错猜快得多。

退出码在这一层分了三档，是整套东西里最需要讲清楚的设计。缺表、缺列、缺索引 → exit 1；连不上 D1 → exit 2；库里多出 migrations 没写的列 → 只 warn，不阻断。第三档我特意放宽：多出来的列可能是历史遗留，删它要单独评估，不该因为一条警告就卡住发版。

| 退出码 | 触发条件 | 检查器动作 | 发版闸门动作 |
|---|---|---|---|
| 0 | 结构一致（多出的列只 warn） | 正常结束 | 放行 |
| 1 | 缺表 / 缺列 / 缺索引 | 打印差异 | 停下发版 |
| 2 | 连不上 D1 | 打印连接失败 | 告警后放行 |

这张表是写给未来的自己的。exit 2 的「告警后放行」最容易被后人改成「一律拦住」，看着更严谨，实际把 D1 抖动变成了发版故障。

## 五、两条真正值钱的断言

`scripts/test-schema.mjs` 一共 **11 条**离线断言，进了 `npm test`。大多数是常规的形状检查，真正值钱的是下面两条——它们分别把第三份描述和重放结果纳入了机器判定。这 11 条全离线，不连 D1。能进 `npm test` 是刻意选的：发版前的检查依赖网络，本地改完想快速验证就跑不了；离线断言把反馈压到一次本地命令里。

第一条：代码里 `INSERT INTO 表 (列…)` 用到的列，必须在 migrations 里找得到。它把「代码假设有哪些列」这份一直游离的第三描述，第一次纳入了检查。前面说的 `friends.http_status` 漂移，靠的就是这一类断言兜底：就算有人再手改 `schema.sql`，只要代码还在写这一列，migrations 里缺了就红。

```js
// 断言一：抓源码里的 INSERT 列，对着 migrations 的期望结构核
const inserts = scanSqlStringLiterals(srcFiles);   // 取 `INSERT INTO x (a, b, ...)`
for (const { table, columns } of inserts) {
  const known = expected.tables.get(table)?.columns ?? new Set();
  for (const c of columns) {
    assert(known.has(c), `${table}.${c} 不在 migrations 里`);
  }
}
```

这条断言的输入不是手写的清单，是从源码里扫出来的。手写清单会过期——加一列忘了往清单里加，断言就形同虚设；从 `INSERT` 语句反推，代码怎么写，清单就怎么变。第三份描述因此第一次有了机器可读的形态，不用靠我在评审时肉眼对照。

第二条：在 `node:sqlite` 的内存库里按序重放全部迁移，把建出来的实际结构，和 `parseSchema` 解析出来的期望结构逐项比对。这条抓的是「手抄 DDL 抄漏一列」——迁移文件是人写的，人会漏；期望和实际对不上，就说明哪里漏了或者写岔了，不必等上线才炸。

```js
// 断言二：内存库重放，结果要等于解析出来的期望
const db = new Database('':memory:'');
for (const f of migrationFiles) db.exec(read(f));
const actual = introspect(db);              // 从 sqlite_master 读回真实结构
assert.deepEqual(actual, expected);         // 表 / 列 / 索引逐项相等
```

用内存库而不是直接查线上，是为了让这条断言能离线跑、不依赖 D1 凭证。按序重放是关键：0002 的 `ALTER` 必须落在 0001 建好的表上，顺序错了结果就没有意义。比对的另一端是 `parseSchema` 算出来的期望，不是 `schema.sql`——`schema.sql` 自己就是被检查对象，不能让它当裁判。

两条断言的方向是相反的：第一条从代码走向 migrations，回答「写进去的列有没有地方放」；第二条从 migrations 走向真实数据库，回答「写下来的结构能不能真建出来」。漂移恰好会沿这两个方向漏出去，只堵一头另一头照样出问题，两头都查才算把路径覆盖完整。

`test-schema` 还禁止未标注的 `DROP` / `RENAME` / 删列。真要删，得在迁移文件里写 `-- @allow-destructive`，让破坏性动作显式留痕。这个标记的作用不是授权，是留痕：真出事的时候能一眼看出哪次迁移动过刀。`-- @allow-destructive` 挡的也不是手滑，是「顺手清理一下」——清理掉的列可能还有代码在写，而这个体系里没人会替你先跑一遍引用扫描。

`schema.sql` 的兼容性也靠这套断言锁住。它保留着给老脚本用，但 `test-schema` 会把它解析一遍，要求和 migrations 叠出来的期望等价——于是它再漂一次，测试就红。我没删 `schema.sql`，删了要改的调用点太多；锁住等价，比删掉省事。

## 六、SQLite 不支持的那种幂等

0002 迁移踩过一个语法坑：`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 在 SQLite 里是语法错。我下意识以为它跟 `CREATE TABLE IF NOT EXISTS` 一样，加个后缀就幂等，跑的时候被 wrangler 直接打回来。

```sql
-- 语法示意：SQLite 没有 ADD COLUMN IF NOT EXISTS 这个分支
ALTER TABLE t ADD COLUMN IF NOT EXISTS c INTEGER;   -- 语法错
ALTER TABLE t ADD COLUMN c INTEGER;                 -- 标准写法
```

原因是 `ADD COLUMN` 根本没有这个语法分支。标准写法重复执行会报 `duplicate column name`，但在这个体系里重复执行本来就不该发生——幂等不靠 SQL 语句自己扛，靠 wrangler 的 `d1_migrations` 记录：apply 过的版本号不会再 apply 第二次。

这件事把幂等的归属讲清楚了：它是整套机制的属性，不是单条语句的属性。`CREATE ... IF NOT EXISTS` 看着幂等，其实也靠 wrangler 的记录兜底，只是 SQLite 恰好给 `CREATE` 留了这个语法；`ADD COLUMN` 没留，就别在语法上硬凑，把判断统一交给 `d1_migrations` 这一层。

`test-schema` 对这件事处理得很克制：只要求 `CREATE` 系列语句带 `IF NOT EXISTS`，`ALTER` 不查这一项。检查器要有边界，把 SQLite 根本做不到的语法也列进要求，只会逼出绕过检查的写法，那比不检查还坏。

新建一次迁移的流程也定下来了，顺序不再靠记：

```bash
# 新建 migrations/NNNN_xxx.sql 之后，本地连跑两次验幂等
npm run schema:apply:local
npm run schema:apply:local
# 上线上，再检查结构
npm run schema:apply
npm run check:schema
# 过了才发版
```

这套检查有一个已知的空档：将来谁写了 `ADD COLUMN IF NOT EXISTS`，`test-schema` 不会拦，因为它只要求 `CREATE` 带 `IF NOT EXISTS`。那种写法会在 apply 的时候被 SQLite 拒掉，不会静默通过。我没写过 0003 去验证这个行为，这条按解析器规则推断，只到推断为止。

两次 `schema:apply:local` 是这个流程里最便宜的一步：第一次建结构，第二次应该什么都没做。如果第二次报错，就说明这条迁移里有没被 `d1_migrations` 接住的重复动作，多半又是某个 `ALTER`。便宜到这种程度还跳过，就没有理由了。

## 七、把检查接进发版闸门

检查写好了不接进部署，等于没有。`deploy.mjs` 里加了一道闸门，调 `check` 之后看退出码：exit 1 停下发版，提示先把 migration apply 掉；exit 2 只打警告，继续发。

分开处理这两个码有原因。exit 1 是真漂移——代码需要的列线上没有，发上去就是 500，必须拦。exit 2 是连不上 D1，可能是网络抖动、token 过期、或者 D1 正在维护；这种时候把整个发版卡住，代价大于收益，而且漂移本身并没被证明存在。我宁可带着一条警告发一版，也不要因为 D1 抖一下就停住。

```js
// deploy.mjs 里的闸门
const code = checkSchema();
if (code === 1) {
  console.error(''结构漂移：先 apply migrations，再发版'');
  process.exit(1);
}
if (code === 2) {
  console.warn(''D1 连不上，跳过结构检查（不阻断发版）'');
}
```

闸门只挡一种错：结构漂移。它不做全量测试，也不修任何东西，职责收得这么窄才敢放在发版路径上——一个想解决所有问题的前置检查，结果往往变成人人想绕过的那一步。

闸门接在 `deploy.mjs` 内部，不是单拎出来的 CI 步骤。这个站没有构建流水线，发版就是一次脚本调用；把检查塞进调用内部，才没人能绕过。独立步骤的好处是可跳过，坏处也是可跳过——我不要这个好处。

exit 1 停住之后，动作是明确的：新建或补一条 migration、本地两次 apply、上线 apply、再 check。这套顺序在上一节写过，闸门不负责教人怎么修，只负责不让人带着漂移过去。

`db:init` 和 `db:init:local` 也改了：不再直接 execute `schema.sql`，改成走 `migrations apply`。这样「初始化一个库」和「升级一个库」变成同一条路径，不会再出现「初始化出来的库和升级上来的库结构不一样」这种事——前面那三处漂移，正是两条路径分叉养出来的。

`schema.sql` 留着当兼容副本，由 `test-schema` 锁死它和 migrations 等价。它不再是真相，只是一份接受检查的影子。真要改结构，入口只有一个：新建 `migrations/NNNN_xxx.sql`。

## 怎么自己验一遍

1. 在存量库上跑 `npm run check:schema`，确认输出是通过而不是差异列表；我第一次跑抓到的是上面表格里那四条。
2. 翻 `migrations/0001_baseline.sql`，确认每条 `CREATE` 都带 `IF NOT EXISTS`；在已有库上 apply 应看到 **21 commands / 1.45ms** 这个量级的 no-op，前后各 `dump` 一次应当一致，并且 `d1_migrations` 多出一行记录。
3. 跑 `npm test`，确认 `test-schema` 的 **11 条**断言全绿。删掉某条 migration 里的一列再跑，按断言写法至少第二条会红——这个破坏性试验我没在提交 `0be25e6` 之后重做，只到推断为止。
4. 本地连跑两次 `npm run schema:apply:local`，第二次必须仍是 no-op；第二次报错就说明有 `ALTER` 没走 `d1_migrations` 的幂等路径。
5. 对 `deploy.mjs` 看退出码分支：exit 1 必须 `process.exit(1)`，exit 2 只能是 `console.warn`。断网模拟一次 exit 2、确认发版没被拦住这条我没实测，只到读代码为止。
6. 提交 `0be25e6` 之后线上跑一次 `check:live`，我这边是 73/73；数字对不上就回去 diff `dump` 与 `expected`，别直接改基线。

#d1 #sqlite #cloudflare #testing
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>表结构没有版本记录的时候，它其实有三份互相矛盾的描述：线上真跑着的库、<code>db:init</code> 用的 <code>schema.sql</code>、还有代码里默认「这张表有这些列」的 SQL。三份各说各话，谁也不负责跟谁对齐。第一次跑 <code>scripts/schema.mjs check</code>，三处漂移当场抓到，外加一笔本地库的旧账。</p>
<p>最险的一处是 <code>schema.sql</code> 的 <code>friends</code> 表少了 <code>http_status</code> 和 <code>latency_ms</code>。<code>src/cron.js</code> 会写这两列，用 <code>db:init</code> 建出来的新库一上线就撞 <code>no such column</code>——这类问题在开发机上测不出来，因为线上库一直有这两列，cron 一直在写，缺的只是那份当「标准」用的建库脚本。</p>
<p>另外两处是索引的双向漂移：<code>schema.sql</code> 记着 <code>idx_pv_day</code> / <code>idx_pv_path</code>，线上根本没有；线上有 <code>idx_posts_published</code> / <code>idx_posts_series</code> / <code>idx_comments_ip</code>，<code>schema.sql</code> 一个没记。少记的索引不会报错，只会让「按这个结构重建一份」从一开始就不可信。</p>
<p>修法不是再重写一份 <code>schema.sql</code>，是承认它不可信，改成一份可重放的基线加一套检查。<code>migrations/0001_baseline.sql</code> 从线上 <code>sqlite_master</code> 导出，全部 <code>IF NOT EXISTS</code>；存量库 apply 是 <strong>21 commands / 1.45ms</strong> 的 no-op，只让 wrangler 在 <code>d1_migrations</code> 里记一笔，空库则一次建齐。</p>
<p>三份描述都不会自己报错。线上库照常服务请求，<code>schema.sql</code> 照常能建出一个库，代码照常在已有库上写成功——每一份在自己的上下文里都是对的，只有把它们两两摆在一起才露出裂缝。漂移这个叫法很贴切：不是谁错了，是它们各自走远了。</p>
<p>这套东西挂在一个 Worker 上跑，整体取舍写在<a href="/p/workers-blog-pillar">单 Worker 博客的架构全貌</a>里。这一篇只讲数据层那一格：提交 <code>0be25e6</code>，线上 <code>check:live</code> 73/73。</p>
<h2 id="一-先承认没有版本记录"><a class="h-anchor" href="#一-先承认没有版本记录">#</a>一、先承认没有版本记录</h2>
<p>这些表是「写功能时顺手 <code>ALTER</code> 一下」长出来的。加友链检测就 <code>ALTER TABLE friends ADD COLUMN http_status</code>，加封面就给 <code>posts</code> 加一列。每次只改当下要用的那个库，改完不记，也没有一个文件说「到现在为止结构长这样」。</p>
<p>顺手 <code>ALTER</code> 的诱惑在于成本看着是零：一行命令，当场解决眼前的功能，没有失败反馈。它的成本只在出现第二个环境那一刻才结算——而第二个环境迟早会出现，可能是一台新机器，可能是一次灾难恢复，也可能只是本地库被清掉重建。</p>
<p>没有版本记录的代价不是乱，是没法回答一个很具体的问题：眼前这个库，是从哪一步长成现在这样的。每台库都有自己的 ALTER 史——线上改过线上的列，本地改过本地的列，<code>db:init</code> 手里是某一时刻的快照。三份描述不是三个人写的三种观点，是同一份代码在不同时间点留下的三个切片。</p>
<p>我第一反应是去翻 <code>schema.sql</code>，以为它就是答案。翻完发现它只是 <code>db:init</code> 用的建库脚本，后来加的列没人同步回去；而且它和线上库从来没被比对过，连「两者是不是不一样」都没人知道。所谓三份描述，是我第一次把三者摆在一起时才成立的——在那之前它们各自都「能用」。</p>
<p>第三份描述最隐蔽：代码里的 SQL。它不说自己需要哪些列，它只是 <code>INSERT INTO friends (slug, url, http_status, ...)</code>，隐含着「这张表已经有这些列」。没人写文档，检查器也不看代码，于是这一份长期游离在视线外。</p>
<p>本地首页起不来那次，现象落在页面上，很容易先去查渲染模板和 Markdown 解析。真因却是 <code>posts</code> 表在本地少了两列。结构漂移伪装成功能 bug 的时候，排查路径会被它带偏——报错发生在读数据的地方，根因写在写结构的地方，两者隔着一层。</p>
<p>我做的第一步不是修漂移，是承认没有版本记录，再把「哪份算数」定下来：线上库算数，<code>schema.sql</code> 和代码都得向它对齐；但线上库本身也要能被重放出来，否则换台机器就重建不了。承认这一点之后，后面所有决定都顺了。</p>
<h2 id="二-第一次检查抓到的三处漂移"><a class="h-anchor" href="#二-第一次检查抓到的三处漂移">#</a>二、第一次检查抓到的三处漂移</h2>
<p><code>scripts/schema.mjs check</code> 把三份描述两两对照，输出不是一句「通过 / 不通过」，是逐条列出差异。我把第一次实跑的四条发现原样贴在这里：前三条是描述之间的漂移，第四条是本地库自己的旧账。每条差异都点名两份来源和具体对象，不写「结构不一致」这种没法动手的结论——检查器的输出得能直接翻译成下一步动作。</p>
<div class="table-wrap"><table><thead><tr><th>发现</th><th>哪两份对不上</th><th>具体内容</th><th>后果</th></tr></thead><tbody><tr><td>1</td><td><code>schema.sql</code> ↔ 代码</td><td><code>friends</code> 缺 <code>http_status</code> / <code>latency_ms</code></td><td><code>src/cron.js</code> 写这两列，<code>db:init</code> 建的库上线即 <code>no such column</code></td></tr><tr><td>2</td><td><code>schema.sql</code> ↔ 线上</td><td><code>schema.sql</code> 多出 <code>idx_pv_day</code> / <code>idx_pv_path</code></td><td>线上根本没有，等于重建出一个线上没有的结构</td></tr><tr><td>3</td><td>线上 ↔ <code>schema.sql</code></td><td>线上有 <code>idx_posts_published</code> / <code>idx_posts_series</code> / <code>idx_comments_ip</code></td><td><code>schema.sql</code> 漏记，按它重建后这三个索引消失</td></tr><tr><td>4</td><td>本地库 ↔ 线上</td><td>本地 <code>posts</code> 缺 <code>html_content</code> / <code>cover_body</code></td><td>本地首页起不来，已 <code>ALTER</code> 补上</td></tr></tbody></table></div>
<p>第 1 条最要命，因为它不会在测试期暴露。线上库有那两列，cron 一直在写，<code>schema.sql</code> 没记；开发时谁也不会拿 <code>db:init</code> 从零建一个库再接 cron。同一份代码，在已有库上跑得好好的，换台干净机器按文档初始化，一写就炸。</p>
<p>本地库和线上库同名不同物这件事，<a href="/p/d1-no-such-table">D1 报错 no such table</a>里拆过一次，这里撞的是它的近亲 <code>no such column</code>：不是表不存在，是列不存在。第 4 条的 <code>html_content</code> / <code>cover_body</code> 同理，本地首页起不来，真因就是这两列在本地 <code>posts</code> 上缺席，不是渲染代码写错。它在写这篇之前已经 <code>ALTER</code> 补上，我把它留在表里不是为了留案底，是因为它解释了为什么我对漂移后知后觉——本地库少两列照样能让人误以为是页面 bug。</p>
<p>第 2 和第 3 条方向相反，正好说明「互相漂」不是修辞：<code>schema.sql</code> 比线上多了两个索引，又比线上少了三个。从名字能猜出这些索引的意图：<code>idx_posts_published</code> 大约服务于按发布时间取列表，<code>idx_posts_series</code> 服务于系列，<code>idx_comments_ip</code> 服务于按 IP 过滤。这几个用途我没逐条跑 <code>EXPLAIN</code>，只到从命名推断为止。能确定的是，索引缺失不会当场报错，慢不慢我没量，这条没测，只到推断为止；但「按 <code>schema.sql</code> 重建线上」这个念头，从此不能成立了。</p>
<h2 id="三-基线不是新建-是从线上导出来的"><a class="h-anchor" href="#三-基线不是新建-是从线上导出来的">#</a>三、基线不是新建，是从线上导出来的</h2>
<p>定下「线上算数」之后，基线文件的来源就明确了：不是我照着记忆重写一遍 DDL，是从线上 <code>sqlite_master</code> 把真实建表语句导出来，整理成干净、可重放的 SQL，存成 <code>migrations/0001_baseline.sql</code>。</p>
<p>线上 <code>sqlite_master</code> 里的原始建表语句是能跑的，但不能直接拿进 migrations。它没有 <code>IF NOT EXISTS</code>，照搬过去，存量库第一次 apply 就撞 <code>table already exists</code>。我做的整理只有两类动作：给每个 <code>CREATE TABLE</code> / <code>CREATE INDEX</code> 补上 <code>IF NOT EXISTS</code>，把导出时带的格式噪声抹平；列、类型、约束一个字不改。整理得越少，基线越像线上，越不容易再引入新分歧。「干净」在这里就指只留结构声明，不把某一时刻的数据内容掺进来。</p>
<p>导出时这个细节必须处理到位：所有 <code>CREATE</code> 都加 <code>IF NOT EXISTS</code>。存量库已经有这些表和索引，apply 一遍应该是 no-op；空库则一遍建齐。两种场景跑同一份文件，这是版本化能成立的前提，也是我愿意把「导出」当成基线来源的前提。</p>
<p>实测存量库上 apply 这一遍：<strong>21 commands / 1.45ms</strong>。21 条命令里绝大部分是撞到已存在对象后的空操作，1.45ms 是 wrangler 报出来的执行时间。它没改任何一行数据，唯一的实际效果是让 wrangler 在 <code>d1_migrations</code> 表里记了一笔——这笔记录就是后面所有幂等判断的依据。要确认它真是 no-op，办法是 apply 前后各 <code>dump</code> 一次比对输出；这一步是建基线时的一次性核对，我没把它做成每次发版都要跑的断言。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">-- migrations/<span class="tok-n">0001_baseline.sql</span> 节选：列、类型、约束照线上 sqlite_master 原样导出
-- 这里只摘与漂移相关的声明，完整 DDL 在文件里
CREATE TABLE IF NOT EXISTS friends (
  -- 线上既有的其余列原样保留
  http_status INTEGER,
  latency_ms INTEGER
);

-- 索引同样带 IF NOT EXISTS：存量库撞到就跳过，空库才真正建
CREATE INDEX IF NOT EXISTS idx_posts_published ON <span class="tok-f">posts</span>(published);
CREATE INDEX IF NOT EXISTS idx_posts_series ON <span class="tok-f">posts</span>(series);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON <span class="tok-f">comments</span>(ip);</code></pre></div>
<p>空库那条路径我更在意。以前按 <code>db:init</code> 建出来的库，正是第 1 条漂移的受害方：cron 一写 <code>http_status</code> 就炸。现在空库 apply 这一遍，表和索引一次建齐，建出来的结构和线上重放出来的结构同源。同一份 migration 同时服务「已有库升级」和「新库初始化」，两条路径才不会再分叉。</p>
<p>从线上导出也有边界：它描述的是当前状态，不是历史。基线建好之后就不再改，0002 之后的新变更写进新文件——这样任何时间点重建出来的结构，都能按文件名顺序重放到那一刻，而不是永远取一份不断被覆盖的快照。</p>
<p>我犯过一个惯性错误：第一版想把 <code>schema.sql</code> 改名成 baseline 交差。改名解决不了漂移——它带着缺的两列和多出的两个索引，只会把错的东西正式化，还给它盖了个「版本化」的章。基线必须从线上导出，不能从另一份已经漂过的副本推导。</p>
<h2 id="四-解析器只写一份"><a class="h-anchor" href="#四-解析器只写一份">#</a>四、解析器只写一份</h2>
<p>漂移能抓到，前提是「怎么读一份 SQL」只有一个答案。我差点写两个解析器：一个给 <code>check</code> 用，从线上 <code>sqlite_master</code> 读；一个给测试用，从 migration 文件读。两个解析器读同一句 <code>CREATE TABLE</code> 稍有分歧，检查就会报假阳性或者漏报，那比没有检查更糟——至少没有检查时没人信它。</p>
<p>两个解析器会怎么分歧不用列举也能想到：一句跨多行的 <code>CREATE TABLE</code>、一个带引号的标识符、一段注释里出现的 <code>CREATE</code>，都可能被两边读成不同结果。到时候 check 说缺列、test 说不缺，我得先判断哪个解析器错了，再判断结构错了——检查工具本身成了新的排查对象。共用一份解析器，把这个分支直接删掉。</p>
<p>解析器本身是纯函数：同一份输入吐出同一个结构对象，不读环境变量，不看 D1 连接状态。这份纯粹性是它能被两边共用的前提——check 拿着它去对线上，test 拿着它去对内存库，中间没有任何随上下文变化的分支。</p>
<p>所以 <code>parseSchema</code> 和 <code>mergeSchema</code> 都收进 <code>scripts/sql-schema.mjs</code>，<code>check</code> 和 <code>test</code> 共用。parse 把 DDL 拆成「表 → 列集合 / 索引集合」，merge 把 <code>0001</code>、<code>0002</code>……按序叠成一份期望结构。两个子命令看到的期望是同一个对象，差异只可能来自真差异，不会来自解析口径不一致。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// scripts/sql-schema.mjs：check 与 test 共用这一份解析结果</span>
<span class="tok-k">import</span> { parseSchema, mergeSchema } <span class="tok-k">from</span> <span class="tok-s">&#39;./sql-schema.mjs&#39;</span>;

<span class="tok-k">const</span> baseline = <span class="tok-f">parseSchema</span>(<span class="tok-f">read</span>(<span class="tok-s">&#39;migrations/0001_baseline.sql&#39;</span>));
<span class="tok-k">const</span> expected = <span class="tok-f">mergeSchema</span>([
  baseline,
  <span class="tok-f">parseSchema</span>(<span class="tok-f">read</span>(<span class="tok-s">&#39;migrations/0002_xxx.sql&#39;</span>)),
]);
<span class="tok-c">// expected.tables.get(&#39;friends&#39;).columns 就是唯一判据</span></code></pre></div>
<p>merge 按文件名排序叠加，<code>0001</code> 必须排在 <code>0002</code> 前面。文件名用四位数字补零，目的就是让字典序等于版本序；到了五位数那天得换排序规则，那是很远的事，现在不管。<code>dump</code> 和 <code>expected</code> 两个子命令则是排查用的：<code>dump</code> 打线上实际结构，<code>expected</code> 打迁移叠出来的期望结构，两边各存一份贴到一起 diff，比对着报错猜快得多。</p>
<p>退出码在这一层分了三档，是整套东西里最需要讲清楚的设计。缺表、缺列、缺索引 → exit 1；连不上 D1 → exit 2；库里多出 migrations 没写的列 → 只 warn，不阻断。第三档我特意放宽：多出来的列可能是历史遗留，删它要单独评估，不该因为一条警告就卡住发版。</p>
<div class="table-wrap"><table><thead><tr><th>退出码</th><th>触发条件</th><th>检查器动作</th><th>发版闸门动作</th></tr></thead><tbody><tr><td>0</td><td>结构一致（多出的列只 warn）</td><td>正常结束</td><td>放行</td></tr><tr><td>1</td><td>缺表 / 缺列 / 缺索引</td><td>打印差异</td><td>停下发版</td></tr><tr><td>2</td><td>连不上 D1</td><td>打印连接失败</td><td>告警后放行</td></tr></tbody></table></div>
<p>这张表是写给未来的自己的。exit 2 的「告警后放行」最容易被后人改成「一律拦住」，看着更严谨，实际把 D1 抖动变成了发版故障。</p>
<h2 id="五-两条真正值钱的断言"><a class="h-anchor" href="#五-两条真正值钱的断言">#</a>五、两条真正值钱的断言</h2>
<p><code>scripts/test-schema.mjs</code> 一共 <strong>11 条</strong>离线断言，进了 <code>npm test</code>。大多数是常规的形状检查，真正值钱的是下面两条——它们分别把第三份描述和重放结果纳入了机器判定。这 11 条全离线，不连 D1。能进 <code>npm test</code> 是刻意选的：发版前的检查依赖网络，本地改完想快速验证就跑不了；离线断言把反馈压到一次本地命令里。</p>
<p>第一条：代码里 <code>INSERT INTO 表 (列…)</code> 用到的列，必须在 migrations 里找得到。它把「代码假设有哪些列」这份一直游离的第三描述，第一次纳入了检查。前面说的 <code>friends.http_status</code> 漂移，靠的就是这一类断言兜底：就算有人再手改 <code>schema.sql</code>，只要代码还在写这一列，migrations 里缺了就红。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 断言一：抓源码里的 INSERT 列，对着 migrations 的期望结构核</span>
<span class="tok-k">const</span> inserts = <span class="tok-f">scanSqlStringLiterals</span>(srcFiles);   <span class="tok-c">// 取 `INSERT INTO x (a, b, ...)`</span>
<span class="tok-k">for</span> (<span class="tok-k">const</span> { table, columns } <span class="tok-k">of</span> inserts) {
  <span class="tok-k">const</span> known = expected.tables.<span class="tok-k">get</span>(table)?.columns ?? <span class="tok-k">new</span> <span class="tok-f">Set</span>();
  <span class="tok-k">for</span> (<span class="tok-k">const</span> c <span class="tok-k">of</span> columns) {
    <span class="tok-f">assert</span>(known.<span class="tok-f">has</span>(c), <span class="tok-s">`${table}.${c} 不在 migrations 里`</span>);
  }
}</code></pre></div>
<p>这条断言的输入不是手写的清单，是从源码里扫出来的。手写清单会过期——加一列忘了往清单里加，断言就形同虚设；从 <code>INSERT</code> 语句反推，代码怎么写，清单就怎么变。第三份描述因此第一次有了机器可读的形态，不用靠我在评审时肉眼对照。</p>
<p>第二条：在 <code>node:sqlite</code> 的内存库里按序重放全部迁移，把建出来的实际结构，和 <code>parseSchema</code> 解析出来的期望结构逐项比对。这条抓的是「手抄 DDL 抄漏一列」——迁移文件是人写的，人会漏；期望和实际对不上，就说明哪里漏了或者写岔了，不必等上线才炸。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 断言二：内存库重放，结果要等于解析出来的期望</span>
<span class="tok-k">const</span> db = <span class="tok-k">new</span> <span class="tok-f">Database</span>(<span class="tok-s">&#39;:memory:&#39;</span>);
<span class="tok-k">for</span> (<span class="tok-k">const</span> f <span class="tok-k">of</span> migrationFiles) db.<span class="tok-f">exec</span>(<span class="tok-f">read</span>(f));
<span class="tok-k">const</span> actual = <span class="tok-f">introspect</span>(db);              <span class="tok-c">// 从 sqlite_master 读回真实结构</span>
assert.<span class="tok-f">deepEqual</span>(actual, expected);         <span class="tok-c">// 表 / 列 / 索引逐项相等</span></code></pre></div>
<p>用内存库而不是直接查线上，是为了让这条断言能离线跑、不依赖 D1 凭证。按序重放是关键：0002 的 <code>ALTER</code> 必须落在 0001 建好的表上，顺序错了结果就没有意义。比对的另一端是 <code>parseSchema</code> 算出来的期望，不是 <code>schema.sql</code>——<code>schema.sql</code> 自己就是被检查对象，不能让它当裁判。</p>
<p>两条断言的方向是相反的：第一条从代码走向 migrations，回答「写进去的列有没有地方放」；第二条从 migrations 走向真实数据库，回答「写下来的结构能不能真建出来」。漂移恰好会沿这两个方向漏出去，只堵一头另一头照样出问题，两头都查才算把路径覆盖完整。</p>
<p><code>test-schema</code> 还禁止未标注的 <code>DROP</code> / <code>RENAME</code> / 删列。真要删，得在迁移文件里写 <code>-- @allow-destructive</code>，让破坏性动作显式留痕。这个标记的作用不是授权，是留痕：真出事的时候能一眼看出哪次迁移动过刀。<code>-- @allow-destructive</code> 挡的也不是手滑，是「顺手清理一下」——清理掉的列可能还有代码在写，而这个体系里没人会替你先跑一遍引用扫描。</p>
<p><code>schema.sql</code> 的兼容性也靠这套断言锁住。它保留着给老脚本用，但 <code>test-schema</code> 会把它解析一遍，要求和 migrations 叠出来的期望等价——于是它再漂一次，测试就红。我没删 <code>schema.sql</code>，删了要改的调用点太多；锁住等价，比删掉省事。</p>
<h2 id="六-sqlite-不支持的那种幂等"><a class="h-anchor" href="#六-sqlite-不支持的那种幂等">#</a>六、SQLite 不支持的那种幂等</h2>
<p>0002 迁移踩过一个语法坑：<code>ALTER TABLE ... ADD COLUMN IF NOT EXISTS</code> 在 SQLite 里是语法错。我下意识以为它跟 <code>CREATE TABLE IF NOT EXISTS</code> 一样，加个后缀就幂等，跑的时候被 wrangler 直接打回来。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">-- 语法示意：SQLite 没有 ADD COLUMN IF NOT EXISTS 这个分支
ALTER TABLE t ADD COLUMN IF NOT EXISTS c INTEGER;   -- 语法错
ALTER TABLE t ADD COLUMN c INTEGER;                 -- 标准写法</code></pre></div>
<p>原因是 <code>ADD COLUMN</code> 根本没有这个语法分支。标准写法重复执行会报 <code>duplicate column name</code>，但在这个体系里重复执行本来就不该发生——幂等不靠 SQL 语句自己扛，靠 wrangler 的 <code>d1_migrations</code> 记录：apply 过的版本号不会再 apply 第二次。</p>
<p>这件事把幂等的归属讲清楚了：它是整套机制的属性，不是单条语句的属性。<code>CREATE ... IF NOT EXISTS</code> 看着幂等，其实也靠 wrangler 的记录兜底，只是 SQLite 恰好给 <code>CREATE</code> 留了这个语法；<code>ADD COLUMN</code> 没留，就别在语法上硬凑，把判断统一交给 <code>d1_migrations</code> 这一层。</p>
<p><code>test-schema</code> 对这件事处理得很克制：只要求 <code>CREATE</code> 系列语句带 <code>IF NOT EXISTS</code>，<code>ALTER</code> 不查这一项。检查器要有边界，把 SQLite 根本做不到的语法也列进要求，只会逼出绕过检查的写法，那比不检查还坏。</p>
<p>新建一次迁移的流程也定下来了，顺序不再靠记：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 新建 migrations/NNNN_xxx.sql 之后，本地连跑两次验幂等</span>
<span class="tok-k">npm</span> run schema:apply:local
<span class="tok-k">npm</span> run schema:apply:local
<span class="tok-c"># 上线上，再检查结构</span>
<span class="tok-k">npm</span> run schema:apply
<span class="tok-k">npm</span> run check:schema
<span class="tok-c"># 过了才发版</span></code></pre></div>
<p>这套检查有一个已知的空档：将来谁写了 <code>ADD COLUMN IF NOT EXISTS</code>，<code>test-schema</code> 不会拦，因为它只要求 <code>CREATE</code> 带 <code>IF NOT EXISTS</code>。那种写法会在 apply 的时候被 SQLite 拒掉，不会静默通过。我没写过 0003 去验证这个行为，这条按解析器规则推断，只到推断为止。</p>
<p>两次 <code>schema:apply:local</code> 是这个流程里最便宜的一步：第一次建结构，第二次应该什么都没做。如果第二次报错，就说明这条迁移里有没被 <code>d1_migrations</code> 接住的重复动作，多半又是某个 <code>ALTER</code>。便宜到这种程度还跳过，就没有理由了。</p>
<h2 id="七-把检查接进发版闸门"><a class="h-anchor" href="#七-把检查接进发版闸门">#</a>七、把检查接进发版闸门</h2>
<p>检查写好了不接进部署，等于没有。<code>deploy.mjs</code> 里加了一道闸门，调 <code>check</code> 之后看退出码：exit 1 停下发版，提示先把 migration apply 掉；exit 2 只打警告，继续发。</p>
<p>分开处理这两个码有原因。exit 1 是真漂移——代码需要的列线上没有，发上去就是 500，必须拦。exit 2 是连不上 D1，可能是网络抖动、token 过期、或者 D1 正在维护；这种时候把整个发版卡住，代价大于收益，而且漂移本身并没被证明存在。我宁可带着一条警告发一版，也不要因为 D1 抖一下就停住。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// deploy.mjs 里的闸门</span>
<span class="tok-k">const</span> code = <span class="tok-f">checkSchema</span>();
<span class="tok-k">if</span> (code === <span class="tok-n">1</span>) {
  console.<span class="tok-f">error</span>(<span class="tok-s">&#39;结构漂移：先 apply migrations，再发版&#39;</span>);
  process.<span class="tok-f">exit</span>(<span class="tok-n">1</span>);
}
<span class="tok-k">if</span> (code === <span class="tok-n">2</span>) {
  console.<span class="tok-f">warn</span>(<span class="tok-s">&#39;D1 连不上，跳过结构检查（不阻断发版）&#39;</span>);
}</code></pre></div>
<p>闸门只挡一种错：结构漂移。它不做全量测试，也不修任何东西，职责收得这么窄才敢放在发版路径上——一个想解决所有问题的前置检查，结果往往变成人人想绕过的那一步。</p>
<p>闸门接在 <code>deploy.mjs</code> 内部，不是单拎出来的 CI 步骤。这个站没有构建流水线，发版就是一次脚本调用；把检查塞进调用内部，才没人能绕过。独立步骤的好处是可跳过，坏处也是可跳过——我不要这个好处。</p>
<p>exit 1 停住之后，动作是明确的：新建或补一条 migration、本地两次 apply、上线 apply、再 check。这套顺序在上一节写过，闸门不负责教人怎么修，只负责不让人带着漂移过去。</p>
<p><code>db:init</code> 和 <code>db:init:local</code> 也改了：不再直接 execute <code>schema.sql</code>，改成走 <code>migrations apply</code>。这样「初始化一个库」和「升级一个库」变成同一条路径，不会再出现「初始化出来的库和升级上来的库结构不一样」这种事——前面那三处漂移，正是两条路径分叉养出来的。</p>
<p><code>schema.sql</code> 留着当兼容副本，由 <code>test-schema</code> 锁死它和 migrations 等价。它不再是真相，只是一份接受检查的影子。真要改结构，入口只有一个：新建 <code>migrations/NNNN_xxx.sql</code>。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<ol><li>在存量库上跑 <code>npm run check:schema</code>，确认输出是通过而不是差异列表；我第一次跑抓到的是上面表格里那四条。</li><li>翻 <code>migrations/0001_baseline.sql</code>，确认每条 <code>CREATE</code> 都带 <code>IF NOT EXISTS</code>；在已有库上 apply 应看到 <strong>21 commands / 1.45ms</strong> 这个量级的 no-op，前后各 <code>dump</code> 一次应当一致，并且 <code>d1_migrations</code> 多出一行记录。</li><li>跑 <code>npm test</code>，确认 <code>test-schema</code> 的 <strong>11 条</strong>断言全绿。删掉某条 migration 里的一列再跑，按断言写法至少第二条会红——这个破坏性试验我没在提交 <code>0be25e6</code> 之后重做，只到推断为止。</li><li>本地连跑两次 <code>npm run schema:apply:local</code>，第二次必须仍是 no-op；第二次报错就说明有 <code>ALTER</code> 没走 <code>d1_migrations</code> 的幂等路径。</li><li>对 <code>deploy.mjs</code> 看退出码分支：exit 1 必须 <code>process.exit(1)</code>，exit 2 只能是 <code>console.warn</code>。断网模拟一次 exit 2、确认发版没被拦住这条我没实测，只到读代码为止。</li><li>提交 <code>0be25e6</code> 之后线上跑一次 <code>check:live</code>，我这边是 73/73；数字对不上就回去 diff <code>dump</code> 与 <code>expected</code>，别直接改基线。</li></ol>
<p><a class="tag-inline" href="/tag/d1">#d1</a> <a class="tag-inline" href="/tag/sqlite">#sqlite</a> <a class="tag-inline" href="/tag/cloudflare">#cloudflare</a> <a class="tag-inline" href="/tag/testing">#testing</a></p>', '', 'teardown', '线上库、schema.sql、代码里的 SQL 三份描述各说各话：friends 缺两列、schema 多两个索引、线上多三个索引。migrations 从线上 sqlite_master 导出做基线，全部 IF NOT EXISTS；node:sqlite 内存重放建出的结构必须与解析结果一致，手抄漏列也抓得到。',
        '', 0, 0, 0, 1, '2027-01-20 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('d1') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-schema-migrations' AND t.name = 'd1';
INSERT INTO tags (name) VALUES ('sqlite') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-schema-migrations' AND t.name = 'sqlite';
INSERT INTO tags (name) VALUES ('cloudflare') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-schema-migrations' AND t.name = 'cloudflare';
INSERT INTO tags (name) VALUES ('testing') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'd1-schema-migrations' AND t.name = 'testing';
INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('review-status-cache-bypass', '投稿审核为什么不能复用 hidden：作者自控的开关挡不住作者自己', '## 结论

今天把投稿审核这条线做完，本地和线上各跑了一遍。结论摆在前面：审核态不能放在作者自己能写的字段上，也不能只挡住列表——单篇入口和缓存是两条独立的旁路，漏掉任何一条，这套审核就等于没做。

线上现在的身份构成很简单，1 个管理员（uid=1）和 1 个普通用户（uid=2）。需求是普通用户能登录写文章，但别人发的稿子要管理员通过才在首页显示。动手前我以为这是"加个开关、默认关上"的小事，做完才发现真正的工作量不在加字段，在把作者能碰到的每一条出口堵上。整套改动落在提交 `002425b`，迁移文件是 `migrations/0002_review_status.sql`，下面引的行号都以这个版本为准。

我第一反应是复用 `hidden`。它本来就叫"不列入首页"，语义看着几乎一样。但翻编辑器保存逻辑，`hidden` 是作者随时能改回 0 的字段——投稿人点一下保存就把自己的稿子放行了。拿它当审核态，等于把钥匙交给被审的那个人。

审核态改由新增的 `posts.review_status` 承载，三态 `approved` / `pending` / `rejected`，作者不可写，只有管理员的审核 API 能改。默认值取 `approved` 是为了不误伤存量：线上总行数 36 篇（含定时和私密），公开数是 19 篇，这两个口径得分开讲——默认值保的是那 36 篇不集体消失，不是那 19 篇。

还有一条比字段更要命的旁路是缓存。单篇正文会进一个 45 秒的实例级 LRU（`postcache.js` 里 `TTL = 45_000`），作者预览一次就把 pending 正文写进缓存，匿名访客紧接着读缓存就绕过了闸门。所以闸门不能只写在 SQL 里，还得写进"这篇要不要缓存"这个决定里。

把这套设计抽象成一张检查清单，其实就三问：状态放在谁写不到的地方、列表和单篇是不是各有一道闸、缓存写入条件里有没有带审核态。三问都答"是"，审核才成立；少答一问，就留下一条旁路。下面按我实际踩坑的顺序拆开。

## 一、hidden 不是审核态

`hidden` 的历史比审核这条需求早得多。它最初的用途是"这篇还没写好，先别上首页"，属于作者自控的下架开关。编辑器里它就是一个复选框，保存文章时跟着正文一起提交，服务端照单全收：

```js
const isHidden = body.hidden !== undefined ? (body.hidden ? 1 : 0) : p.hidden;
// ... 组装进 UPDATE
UPDATE posts SET ... hidden=?, ... WHERE id=?
```

"作者可控"这四个字是问题的全部。一个 `is_admin=0` 的普通用户对自己发的稿子有完整编辑权，`hidden` 当然在其中。假如审核态就是 `hidden=1`，投稿人把复选框取消勾选再保存，状态立刻变回公开——不需要调任何审核接口，也不需要绕权限，就是编辑器里一次再正常不过的操作。

更隐蔽一点的情况是驳回。审核人把稿子打回，如果状态存在 `hidden` 里，那作者"改回可见"和"重新送审"是同一个动作，系统分不清他到底是修好了还是硬放行。审核结论必须绑定内容版本，而这个绑定关系不可能建立在一个作者随时能覆写的字段上。

所以我没动 `hidden` 的语义，另外加了 `posts.review_status`：

```sql
ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT ''approved'';
CREATE INDEX IF NOT EXISTS idx_posts_review ON posts(review_status);
```

三态的分工写进迁移注释里了。`approved` 是公开可见，`pending` 是作者可见、读者不可见，`rejected` 是作者可见、读者不可见但作者改完能重新提交。关键在于这个字段不出现在编辑器的可写集合里——更新文章时它由服务端根据 `u.is_admin` 算出来，不读请求体里的任何值。

```js
// 管理员写的是已通过；普通用户的稿子进来先待审
const review = u.is_admin ? ''approved'' : ''pending'';
```

默认值这一步我是慎重的。迁移上线时线上已有 36 行文章，其中公开的是 19 篇，剩下的含定时稿和私密稿。如果默认 `pending`，这 36 篇会集体从首页消失，等着逐篇人工放行——那不是上线，是事故。默认 `approved` 让历史数据和管理员新建的文章直接是"已通过"，只有普通用户新建时显式写 `pending` 的才进队列。索引 `idx_posts_review` 是给待审查询用的，三态基数小，主要是让管理视图的 `WHERE review_status=''pending''` 别全表扫。

还有一个容易混淆的点：`hidden` 和 `review_status` 是正交的两个开关，不是替代关系。管理员照样能用 `hidden` 把自己写的稿子从首页撤下，这件事和审核态无关；反过来，一篇通过审核的文章也可以被作者设成 hidden。把它们拆成两个字段，语义各管各的，排查问题时才不会互相污染。

## 二、两个闸门，别混用

可见性判断收口成两个 SQL 片段，定义在 `src/api.js` 大约 204 到 217 行。这两个函数名字很像，用途完全不同，混用就是后面第三节那个坑的来历。

```js
/* 纯时间闸门：只管「发布时间到了没」，不掺审核态。
   管理视图（待审队列、定时队列）用它——那些地方本来就是要看未公开/未到点的稿子。 */
export function timeGateSql(a = ''p'') {
  return `COALESCE(NULLIF(${a}.published_at, ''''), ${a}.created_at) <= datetime(''now'')`;
}

export function liveSql(a = ''p'') {
  /* 公开闸门 = 时间到了 + 审核通过 */
  return `${timeGateSql(a)} AND ${a}.review_status = ''approved''`;
}
```

`timeGateSql` 只回答一个问题：这篇稿子的发布时间到了没有。`COALESCE(NULLIF(published_at,''''), created_at)` 的意思是，定时发布时间为空的老文章退回用创建时间，和列表排序用的是同一个表达式，不会出现"排序觉得它该在前、闸门觉得它还没到"的错乱。SQLite 同一条语句里的 `datetime(''now'')` 是常量，不会逐行重新求值，这点我在注释里也标了。

`liveSql` 是在时间闸门上再叠一层 `review_status=''approved''`。所有公开出口都调它——首页、归档、标签、分类、系列、RSS、sitemap、404 页推荐文章，一处加条件就全挡住。比如归档查询的 WHERE 就是这么拼的：

```js
const where = [''p.is_private = 0'', ''p.hidden = 0'', liveSql(''p'')];
```

两个闸门的分工我列了个表，贴在这儿免得自己以后又混：

| 闸门 | 条件 | 管什么 | 用在哪 | 能不能看到 pending |
|---|---|---|---|---|
| `timeGateSql` | 发布时间 ≤ now | 只管定时 | 待审队列、定时队列（管理视图） | 能 |
| `liveSql` | 时间闸门 + `review_status=''approved''` | 定时 + 审核 | 首页/归档/标签/分类/系列/RSS/sitemap/404 推荐 | 不能 |

这里有个边界要说死：`liveSql` 只守列表查询。单篇文章是独立查询，不走 `liveSql`，所以列表挡住了不等于单篇挡住了——这是第 663 行那道闸门要管的事。把"列表可见性"当成"全站可见性"来推理，是我这次最容易犯的错。

`liveSql` 这种收口写法还有个实际好处：新增出口时不容易漏。404 页的推荐文章、系列目录的上下篇，这些地方当初也是查列表时顺手接上 `liveSql` 的。如果每个出口各写一遍 WHERE，总有一处会在某个周末被改成"临时看看数据"，然后忘了改回来。一处定义、多处调用，省的不是代码行数，是"哪天又漏了一个出口"的风险。

## 三、待审队列为什么是空的

闸门拆开之后，我第一次把待审队列接上去，页面一直显示"没有待审文章"。库里明明有 pending 的稿子。第一反应是查身份判断，怀疑 `requireAdmin` 没放行；查完不是。第二反应是查时间条件，怀疑定时稿没到点；也不是。真正的原因很蠢：待审队列自己用了 `liveSql()`。

`liveSql()` 的定义里带着 `review_status=''approved''`，而待审队列要找的恰恰是 `review_status=''pending''`。两个条件一叠加，结果集恒为空——待审稿被自己的闸门过滤掉了。队列永远空，不是没数据，是查询条件自相矛盾。

修正方式是把队列换成只过时间闸门的 `timeGateSql()`，审核态条件由队列自己的 `WHERE review_status=''pending''` 提供。接口在 `src/api.js` 大约 550 到 568 行：

```js
if (path === ''/review/pending'' && method === ''GET'') {
  const { res } = await requireAdmin(env, request);
  if (res) return res;
  const { results } = await db
    .prepare(
      `SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN}
       WHERE p.review_status = ''pending'' AND ${timeGateSql(''p'')}
       ORDER BY p.updated_at ASC LIMIT 200`
    )
    .all();
  return json({ ok: true, posts: results.map(...) });
}
```

队列为什么也要过时间闸门，这里顺便说清。一个普通用户把文章的发布时间设到明天，那是他自己还没准备发，不该堵在审核队列里占管理员的注意力；他真要送审，把发布时间设成现在或过去就行。所以队列条件是"pending 且已到发布时间"。`rejected` 不进队列——它已经处理过了，作者改稿会自动回到 `pending`，那时候自然重新入队。

`LIMIT 200` 是个保守上限。这个站一天来不了几篇投稿，200 够了；真到了 200 篇待审，问题不是查询而是该换个工作流。排序用 `updated_at ASC`，先改的先审，避免后提交的插队把前面的饿死。

## 四、缓存是第二条旁路

列表闸门和单篇闸门都挡住之后，我差点漏掉缓存。这篇站点对单篇正文做两层缓存，浏览器层之外还有两层是我能碰到的：Worker 实例级的 LRU 和边缘缓存。前者在 `postcache.js`，TTL 是 45 秒（`TTL = 45_000`）；后者是 Cloudflare 的 edge cache，TTL 300 秒（5 分钟，`cache.js` 的 `EDGE_TTL = 300`）。[三层缓存那篇](/p/three-layer-cache)把这三层的分工讲过，这里只讲跟审核有关的部分。

问题出在实例级 LRU 的写入条件。原来 `servePostPage` 拿到 bundle 就无条件 `postCacheSet`，不管这篇过没过审。于是有了一条很具体的旁路：作者用自己账号预览一次 pending 稿，正文进缓存；匿名访客紧接着请求同一个 slug，命中缓存直接返回，连数据库都不查，闸门自然也就不存在了。45 秒的窗口足够让一次预览变成一次泄露。

修法是在写缓存的地方加审核态判断，`src/index.js` 大约 1010 到 1017 行：

```js
/* 私有 / 未过审的文章不进实例缓存：
   私有正文没必要在内存多留 45 秒；未过审的更危险——作者预览过一次后
   缓存里就有正文了，匿名访客读缓存会绕过下面那道审核闸门。边缘缓存另算，
   那边的清理由审核 API 的 bust() 负责。 */
if (post && !post.is_private && post.review_status === ''approved'') postCacheSet(slug, b);
```

这里要强调一点：这句判断和 1058 到 1069 行那道 SSR 审核闸门是两回事。闸门决定"这次请求要不要返回 404"，缓存判断决定"这篇要不要留在本实例内存里给下次用"。只做前者，pending 稿第一次请求确实被 404 挡住了，但作者预览那次是带身份的、会被放行，放行那次就把正文写进了缓存——匿名访客吃到的是那次预览的缓存。两处必须同时加。

边缘缓存的清理走另一条路。实例级 LRU 是 Worker 内存，重启即失；边缘缓存跨请求存在，靠 TTL 和主动清除。审核通过或驳回之后，`/api/review/:id` 会调 `bust()` 主动把相关路径的边缘缓存清掉，不等那 300 秒自己过期。两张表把这条线说清：

| 缓存层 | 位置 | TTL | 未过审怎么挡 | 审核后怎么清 |
|---|---|---|---|---|
| 实例 LRU | Worker 内存 | 45 秒 | `postCacheSet` 条件拒绝写入 | 不清理，本来就没写进去 |
| 边缘缓存 | Cloudflare edge | 300 秒 | 不缓存未过审响应 | 审核 API 调 `bust()` 主动清 |

这里还有个容易想当然的地方：实例级 LRU 是 Worker 内存，不跨实例、冷启清零，所以同一篇稿子在不同边缘节点上的缓存状态可能不一样。拿它当"这篇已经审核过"的依据是错的——它连自己是不是还活着都保证不了。授权判断必须每次查库，缓存只负责省那一次查询，不负责作决定。

坦白一句：缓存旁路这一条我没有单独构造一次"作者预览→匿名命中"的复现实验，是按 `postCacheSet` 的调用路径和缓存命中顺序推断出来的。四路验证里匿名单篇确实不可见，但那是在加了缓存判断之后跑的；如果只测四路、不看缓存写入条件，这个洞会一直留着。这条没测，只到推断为止。

## 五、四路验证

闸门和缓存都改完，我在本地和线上各跑了一遍全链路。验证不是看代码"觉得对"，是把 pending 稿按四种对外出口挨个试，看匿名身份到底能不能拿到内容。四路是：匿名列表、单篇 API、SSR 页面、对外清单（RSS 与 sitemap 算一路，它们都是给聚合器和爬虫看的公开目录）。

测试稿用 uid=2 那个普通用户账号发，正文是明确的探针内容，发完确认状态是 `pending`。然后切匿名身份逐路请求，记录每一项的表现；再由 uid=1 审核通过，重复一遍；再驳回，再重复一遍。所有请求都带真实状态码，不看页面截图猜。

| 出口 | pending（匿名） | approved | rejected（匿名） |
|---|---|---|---|
| 匿名列表（首页/归档） | 不出现 | 出现 | 不出现 |
| 单篇 API `/api/posts/:slug` | 404 `文章不存在` | 200 | 404 `文章不存在` |
| SSR 页面 `/p/:slug` | 404 `文章还在审核中` | 200 | 404 `文章还在审核中` |
| RSS + sitemap | 不含该条 | 含该条 | 不含该条 |

把 RSS 和 sitemap 并成一路，不是图省事。爬虫和聚合器不会带登录 cookie，在服务端看来它们就是最纯粹的匿名身份，而且抓取频率比人高得多——一篇 pending 稿要是进了 sitemap，可能在你发现之前就被抓进索引。所以这两项虽然不是"页面"，验证优先级反而排在最前。

单篇 API 的闸门在 `src/api.js` 大约 674 到 676 行，判断写得比列表更严：猜到 slug 的匿名请求直接 404，连"文章存在但需审核"这种提示都不给。作者本人和管理员是例外，用 `user.id === p.author_id || user.is_admin` 放行，方便预览。

```js
const owner = user && (user.id === p.author_id || user.is_admin);
if (p.review_status && p.review_status !== ''approved'' && !owner) return err(''文章不存在'', 404);
```

SSR 那条走的是 `servePostPage`，逻辑一样，只是把 404 换成走 `notFoundPage`，提示文案是"文章还在审核中"。这里有个我特意留意过的细节：不能给 pending 稿返回"审核中"之外的任何区分信息，否则别人拿 slug 轮询就能探出站里有哪些未公开投稿。所返回的文案对"不存在"和"审核中"做了区分（API 用"文章不存在"，SSR 用"还在审核中"），但没有暴露作者、时间和内容。

实测四路在 pending 下全部不可见，approve 后全部可见，reject 后全部回到不可见。测试稿在跑完之后删掉了，线上公开数回到 19 篇——和动手前一致。这一步我认为比"写了多少行代码"更重要：审核这种功能，验证的价值全在"匿名视角下到底看不看得见"，不在实现看起来严不严密。

## 六、改稿重置与驳回重提

审核通过后还有个坑：投稿人把一篇过审文章的正文偷换成广告或违规内容。如果审核态停在 `approved` 不跟着内容变，那么"先发一篇无害的过审，再改正文"就能绕过整条审核线。所以普通用户每次保存文章，状态都无条件退回 `pending`，`src/api.js` 大约 802 到 807 行：

```js
/* 审核态跟着这次保存走：
   - 普通用户改稿（哪怕只改一个字）一律退回 pending —— 否则「先发篇无害的过审，
     再偷偷把正文换成广告/违规内容」就绕过了审核。审核结论必须绑定内容版本。
   - 管理员编辑视为认可，直接 approved。 */
const review = u.is_admin ? ''approved'' : ''pending'';
```

"哪怕只改一个字"是字面意思，更新接口不做"内容是否实质变化"的判断，只要走了保存就重置。这么做牺牲了一点便利：作者改个错别字也要重新过审。但反过来，一旦引入"小改动不重置"的豁免，就给了绕过审核的口子——而判断什么是"小改动"本身又是个可被利用的规则。我选了笨但严的那边。

管理员编辑视为认可，这条是权限模型决定的：管理员本来就能直接审核，他改稿时没必要再把自己写的东西打回待审。审核通过和驳回走专门的接口，不混在普通文章保存里：

```js
if (/^\/review\/\d+$/.test(path) && method === ''POST'') {
  const { res } = await requireAdmin(env, request);
  if (res) return res;
  const id = parseInt(path.split(''/'')[2], 10);
  const action = String(body.action || '''');
  if (action !== ''approve'' && action !== ''reject'') return err(''action 只能是 approve 或 reject'');
  // ... 更新 review_status
  if (ctx) ctx.waitUntil(bust(url, [p.slug]).catch(() => {}));
  return json({ ok: true, id, review_status: next });
}
```

`action` 只认 `approve` 和 `reject` 两个值，其他一律报错，避免拼错字符串时静默走到某个默认分支。状态写完之后调 `bust()` 清边缘缓存，这样通过后刷新就能看到，不用等那 300 秒。实测里 reject 之后单篇立刻变 404、作者改稿立刻回 pending 重入队，都走的这条路径。

后台这边加了三处入口。`/admin/review` 是审核页，列出已到发布时间的 pending 稿，每条带通过和驳回按钮；页面用内联 `script` 调 `/api/review/:id`，nonce 由出口的 `harden()` 统一签，和 [CSP nonce 那篇](/p/csp-nonce-cache) 是同一套机制，没新增 CSP 面。工作台加了一个待审 KPI，有值就能点进去直达审核页；编辑器自己的文章列表里，pending 和 rejected 各显示一个徽标，作者不用猜自己稿子卡在哪一步。

审核页的接口和页面本身都带 `requireAdmin`，且响应是 `cache-control: no-store`——待审列表不该被任何一层缓存记住。这一点和前面缓存章节是同一条原则的延伸：凡是基于身份才可见的内容，缓存键里不包含身份，就只能不缓存。

## 七、SQLite 的幂等没了

这次改表踩到一个 SQLite 和 MySQL 的差异，值得单独记一笔。我原本想像给索引加 `IF NOT EXISTS` 那样，把加字段也写成幂等语句：

```sql
-- 这条在 SQLite 里是语法错
ALTER TABLE posts ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT ''approved'';
```

SQLite 不支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，直接报语法错。它只支持标准的 `ADD COLUMN`，重复执行会报"列已存在"之类的错误，但没有"存在就跳过"这个语法。迁移文件 `migrations/0002_review_status.sql` 落地的是最朴素的一条：

```sql
ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT ''approved'';
CREATE INDEX IF NOT EXISTS idx_posts_review ON posts(review_status);
```

注意一个不对称：索引那句带了 `IF NOT EXISTS`，字段那句没有。`CREATE INDEX IF NOT EXISTS` 在 SQLite 里是合法的，所以索引可以重复跑；加字段不行，只能靠"迁移只执行一次"这个前提来保证幂等。这意味着部署脚本得自己记住 0002 跑没跑过——好在这个站的迁移本来就是手工按顺序执行的，没有自动 migration runner，重复执行的风险本来就可控。

这条经验不只适用于审核字段。以后任何"给 SQLite 加列"的迁移都不能套 MySQL 那套幂等写法，写之前先确认目标引擎。我把这个差异写进迁移文件的注释里，主要是怕半年后自己又照着 MySQL 的习惯写一遍。

## 怎么自己验一遍

如果你想在类似的多用户博客里复现这套审核开关，按下面的顺序查，每一步都有明确的预期结果。命令里的路径按本站的文件布局写，换项目时改路径即可。

先看字段和索引是不是真的落库了，以及存量数据有没有被误伤：

```sql
-- 字段类型、默认值、是否允许为空
PRAGMA table_info(posts);
-- 索引是否存在
SELECT name FROM sqlite_master WHERE type=''index'' AND name=''idx_posts_review'';
-- 口径分开看：总行数和公开数
SELECT COUNT(*) AS total FROM posts;
SELECT COUNT(*) AS public_cnt FROM posts
  WHERE review_status=''approved'' AND is_private=0 AND hidden=0;
```

本站当前这两个数分别是 36 和 19。如果你的迁移没写默认 `approved`，第二条会接近 0，说明存量被误伤了。

然后用普通用户账号发一篇测试稿，确认它进的是 `pending` 而不是 `approved`：

```bash
curl -s -X POST https://你的域名/api/posts \
  -H ''content-type: application/json'' \
  -H ''cookie: 你的登录cookie'' \
  -d ''{"title":"审核探针","content":"probe","publish_at":""}'' | jq .
# 再去库里核对
# sqlite3 db.sqlite "SELECT slug,review_status FROM posts WHERE title=''审核探针'';"
```

接着按四路验匿名不可见，记状态码而不是看截图：

```bash
curl -s -o /dev/null -w ''%{http_code}\n'' https://你的域名/api/posts/审核探针-slug
curl -s -o /dev/null -w ''%{http_code}\n'' https://你的域名/p/审核探针-slug
curl -s https://你的域名/rss | grep -c ''审核探针''        # 期望 0
curl -s https://你的域名/sitemap.xml | grep -c ''审核探针'' # 期望 0
```

前两条期望都是 404，后两条期望都是 0。任何一条不符合，就回头查对应的闸门：`liveSql` 管列表，单篇 API 和 SSR 各自那段 `review_status` 判断管单篇。

顺手把后台那几个入口也点一遍。用 uid=2 登录时访问 `/admin/review` 应该被挡住，工作台的待审 KPI 不该出现；用 uid=1 登录时应能看到 KPI 数字并点进审核页，编辑器文章列表里的测试稿应显示待审徽标。这些不是安全边界，但能确认"审核结论有没有传到人眼前"——状态对了而没人看见，审核照样失效。

收尾验缓存旁路。用一个低成本的办法近似：作者身份预览一次测试稿，紧接着立刻用匿名身份请求同一个 slug，看是不是仍然 404。如果匿名那次拿到了正文，说明 `postCacheSet` 的审核态条件没加上，或者边缘缓存没在审核后清掉。

```js
// 该条件必须同时出现在实例缓存写入处
if (post && !post.is_private && post.review_status === ''approved'') postCacheSet(slug, b);
```

验完记得把测试稿删掉，再核对一次公开数。本站跑完这一轮之后公开数回到 19，和动手前一致。这一条别省——留一篇探针稿在库里，比没有这套审核还糟。

#security #sqlite #ssr #cache
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>今天把投稿审核这条线做完，本地和线上各跑了一遍。结论摆在前面：审核态不能放在作者自己能写的字段上，也不能只挡住列表——单篇入口和缓存是两条独立的旁路，漏掉任何一条，这套审核就等于没做。</p>
<p>线上现在的身份构成很简单，1 个管理员（uid=1）和 1 个普通用户（uid=2）。需求是普通用户能登录写文章，但别人发的稿子要管理员通过才在首页显示。动手前我以为这是&quot;加个开关、默认关上&quot;的小事，做完才发现真正的工作量不在加字段，在把作者能碰到的每一条出口堵上。整套改动落在提交 <code>002425b</code>，迁移文件是 <code>migrations/0002_review_status.sql</code>，下面引的行号都以这个版本为准。</p>
<p>我第一反应是复用 <code>hidden</code>。它本来就叫&quot;不列入首页&quot;，语义看着几乎一样。但翻编辑器保存逻辑，<code>hidden</code> 是作者随时能改回 0 的字段——投稿人点一下保存就把自己的稿子放行了。拿它当审核态，等于把钥匙交给被审的那个人。</p>
<p>审核态改由新增的 <code>posts.review_status</code> 承载，三态 <code>approved</code> / <code>pending</code> / <code>rejected</code>，作者不可写，只有管理员的审核 API 能改。默认值取 <code>approved</code> 是为了不误伤存量：线上总行数 36 篇（含定时和私密），公开数是 19 篇，这两个口径得分开讲——默认值保的是那 36 篇不集体消失，不是那 19 篇。</p>
<p>还有一条比字段更要命的旁路是缓存。单篇正文会进一个 45 秒的实例级 LRU（<code>postcache.js</code> 里 <code>TTL = 45_000</code>），作者预览一次就把 pending 正文写进缓存，匿名访客紧接着读缓存就绕过了闸门。所以闸门不能只写在 SQL 里，还得写进&quot;这篇要不要缓存&quot;这个决定里。</p>
<p>把这套设计抽象成一张检查清单，其实就三问：状态放在谁写不到的地方、列表和单篇是不是各有一道闸、缓存写入条件里有没有带审核态。三问都答&quot;是&quot;，审核才成立；少答一问，就留下一条旁路。下面按我实际踩坑的顺序拆开。</p>
<h2 id="一-hidden-不是审核态"><a class="h-anchor" href="#一-hidden-不是审核态">#</a>一、hidden 不是审核态</h2>
<p><code>hidden</code> 的历史比审核这条需求早得多。它最初的用途是&quot;这篇还没写好，先别上首页&quot;，属于作者自控的下架开关。编辑器里它就是一个复选框，保存文章时跟着正文一起提交，服务端照单全收：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> isHidden = body.hidden !== <span class="tok-k">undefined</span> ? (body.hidden ? <span class="tok-n">1</span> : <span class="tok-n">0</span>) : p.hidden;
<span class="tok-c">// ... 组装进 UPDATE</span>
UPDATE posts SET ... hidden=?, ... WHERE id=?</code></pre></div>
<p>&quot;作者可控&quot;这四个字是问题的全部。一个 <code>is_admin=0</code> 的普通用户对自己发的稿子有完整编辑权，<code>hidden</code> 当然在其中。假如审核态就是 <code>hidden=1</code>，投稿人把复选框取消勾选再保存，状态立刻变回公开——不需要调任何审核接口，也不需要绕权限，就是编辑器里一次再正常不过的操作。</p>
<p>更隐蔽一点的情况是驳回。审核人把稿子打回，如果状态存在 <code>hidden</code> 里，那作者&quot;改回可见&quot;和&quot;重新送审&quot;是同一个动作，系统分不清他到底是修好了还是硬放行。审核结论必须绑定内容版本，而这个绑定关系不可能建立在一个作者随时能覆写的字段上。</p>
<p>所以我没动 <code>hidden</code> 的语义，另外加了 <code>posts.review_status</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT <span class="tok-s">&#39;approved&#39;</span>;
CREATE INDEX IF NOT EXISTS idx_posts_review ON <span class="tok-f">posts</span>(review_status);</code></pre></div>
<p>三态的分工写进迁移注释里了。<code>approved</code> 是公开可见，<code>pending</code> 是作者可见、读者不可见，<code>rejected</code> 是作者可见、读者不可见但作者改完能重新提交。关键在于这个字段不出现在编辑器的可写集合里——更新文章时它由服务端根据 <code>u.is_admin</code> 算出来，不读请求体里的任何值。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 管理员写的是已通过；普通用户的稿子进来先待审</span>
<span class="tok-k">const</span> review = u.is_admin ? <span class="tok-s">&#39;approved&#39;</span> : <span class="tok-s">&#39;pending&#39;</span>;</code></pre></div>
<p>默认值这一步我是慎重的。迁移上线时线上已有 36 行文章，其中公开的是 19 篇，剩下的含定时稿和私密稿。如果默认 <code>pending</code>，这 36 篇会集体从首页消失，等着逐篇人工放行——那不是上线，是事故。默认 <code>approved</code> 让历史数据和管理员新建的文章直接是&quot;已通过&quot;，只有普通用户新建时显式写 <code>pending</code> 的才进队列。索引 <code>idx_posts_review</code> 是给待审查询用的，三态基数小，主要是让管理视图的 <code>WHERE review_status=&#39;pending&#39;</code> 别全表扫。</p>
<p>还有一个容易混淆的点：<code>hidden</code> 和 <code>review_status</code> 是正交的两个开关，不是替代关系。管理员照样能用 <code>hidden</code> 把自己写的稿子从首页撤下，这件事和审核态无关；反过来，一篇通过审核的文章也可以被作者设成 hidden。把它们拆成两个字段，语义各管各的，排查问题时才不会互相污染。</p>
<h2 id="二-两个闸门-别混用"><a class="h-anchor" href="#二-两个闸门-别混用">#</a>二、两个闸门，别混用</h2>
<p>可见性判断收口成两个 SQL 片段，定义在 <code>src/api.js</code> 大约 204 到 217 行。这两个函数名字很像，用途完全不同，混用就是后面第三节那个坑的来历。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 纯时间闸门：只管「发布时间到了没」，不掺审核态。
   管理视图（待审队列、定时队列）用它——那些地方本来就是要看未公开/未到点的稿子。 */</span>
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">timeGateSql</span>(a = <span class="tok-s">&#39;p&#39;</span>) {
  <span class="tok-k">return</span> <span class="tok-s">`COALESCE(NULLIF(${a}.published_at, &#39;&#39;), ${a}.created_at) &lt;= datetime(&#39;now&#39;)`</span>;
}

<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">liveSql</span>(a = <span class="tok-s">&#39;p&#39;</span>) {
  <span class="tok-c">/* 公开闸门 = 时间到了 + 审核通过 */</span>
  <span class="tok-k">return</span> <span class="tok-s">`${timeGateSql(a)} AND ${a}.review_status = &#39;approved&#39;`</span>;
}</code></pre></div>
<p><code>timeGateSql</code> 只回答一个问题：这篇稿子的发布时间到了没有。<code>COALESCE(NULLIF(published_at,&#39;&#39;), created_at)</code> 的意思是，定时发布时间为空的老文章退回用创建时间，和列表排序用的是同一个表达式，不会出现&quot;排序觉得它该在前、闸门觉得它还没到&quot;的错乱。SQLite 同一条语句里的 <code>datetime(&#39;now&#39;)</code> 是常量，不会逐行重新求值，这点我在注释里也标了。</p>
<p><code>liveSql</code> 是在时间闸门上再叠一层 <code>review_status=&#39;approved&#39;</code>。所有公开出口都调它——首页、归档、标签、分类、系列、RSS、sitemap、404 页推荐文章，一处加条件就全挡住。比如归档查询的 WHERE 就是这么拼的：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> where = [<span class="tok-s">&#39;p.is_private = 0&#39;</span>, <span class="tok-s">&#39;p.hidden = 0&#39;</span>, <span class="tok-f">liveSql</span>(<span class="tok-s">&#39;p&#39;</span>)];</code></pre></div>
<p>两个闸门的分工我列了个表，贴在这儿免得自己以后又混：</p>
<div class="table-wrap"><table><thead><tr><th>闸门</th><th>条件</th><th>管什么</th><th>用在哪</th><th>能不能看到 pending</th></tr></thead><tbody><tr><td><code>timeGateSql</code></td><td>发布时间 ≤ now</td><td>只管定时</td><td>待审队列、定时队列（管理视图）</td><td>能</td></tr><tr><td><code>liveSql</code></td><td>时间闸门 + <code>review_status=&#39;approved&#39;</code></td><td>定时 + 审核</td><td>首页/归档/标签/分类/系列/RSS/sitemap/404 推荐</td><td>不能</td></tr></tbody></table></div>
<p>这里有个边界要说死：<code>liveSql</code> 只守列表查询。单篇文章是独立查询，不走 <code>liveSql</code>，所以列表挡住了不等于单篇挡住了——这是第 663 行那道闸门要管的事。把&quot;列表可见性&quot;当成&quot;全站可见性&quot;来推理，是我这次最容易犯的错。</p>
<p><code>liveSql</code> 这种收口写法还有个实际好处：新增出口时不容易漏。404 页的推荐文章、系列目录的上下篇，这些地方当初也是查列表时顺手接上 <code>liveSql</code> 的。如果每个出口各写一遍 WHERE，总有一处会在某个周末被改成&quot;临时看看数据&quot;，然后忘了改回来。一处定义、多处调用，省的不是代码行数，是&quot;哪天又漏了一个出口&quot;的风险。</p>
<h2 id="三-待审队列为什么是空的"><a class="h-anchor" href="#三-待审队列为什么是空的">#</a>三、待审队列为什么是空的</h2>
<p>闸门拆开之后，我第一次把待审队列接上去，页面一直显示&quot;没有待审文章&quot;。库里明明有 pending 的稿子。第一反应是查身份判断，怀疑 <code>requireAdmin</code> 没放行；查完不是。第二反应是查时间条件，怀疑定时稿没到点；也不是。真正的原因很蠢：待审队列自己用了 <code>liveSql()</code>。</p>
<p><code>liveSql()</code> 的定义里带着 <code>review_status=&#39;approved&#39;</code>，而待审队列要找的恰恰是 <code>review_status=&#39;pending&#39;</code>。两个条件一叠加，结果集恒为空——待审稿被自己的闸门过滤掉了。队列永远空，不是没数据，是查询条件自相矛盾。</p>
<p>修正方式是把队列换成只过时间闸门的 <code>timeGateSql()</code>，审核态条件由队列自己的 <code>WHERE review_status=&#39;pending&#39;</code> 提供。接口在 <code>src/api.js</code> 大约 550 到 568 行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (path === <span class="tok-s">&#39;/review/pending&#39;</span> &amp;&amp; method === <span class="tok-s">&#39;GET&#39;</span>) {
  <span class="tok-k">const</span> { res } = <span class="tok-k">await</span> <span class="tok-f">requireAdmin</span>(env, request);
  <span class="tok-k">if</span> (res) <span class="tok-k">return</span> res;
  <span class="tok-k">const</span> { results } = <span class="tok-k">await</span> db
    .<span class="tok-f">prepare</span>(
      <span class="tok-s">`SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN}
       WHERE p.review_status = &#39;pending&#39; AND ${timeGateSql(&#39;p&#39;)}
       ORDER BY p.updated_at ASC LIMIT 200`</span>
    )
    .<span class="tok-f">all</span>();
  <span class="tok-k">return</span> <span class="tok-f">json</span>({ ok: <span class="tok-k">true</span>, posts: results.<span class="tok-f">map</span>(...) });
}</code></pre></div>
<p>队列为什么也要过时间闸门，这里顺便说清。一个普通用户把文章的发布时间设到明天，那是他自己还没准备发，不该堵在审核队列里占管理员的注意力；他真要送审，把发布时间设成现在或过去就行。所以队列条件是&quot;pending 且已到发布时间&quot;。<code>rejected</code> 不进队列——它已经处理过了，作者改稿会自动回到 <code>pending</code>，那时候自然重新入队。</p>
<p><code>LIMIT 200</code> 是个保守上限。这个站一天来不了几篇投稿，200 够了；真到了 200 篇待审，问题不是查询而是该换个工作流。排序用 <code>updated_at ASC</code>，先改的先审，避免后提交的插队把前面的饿死。</p>
<h2 id="四-缓存是第二条旁路"><a class="h-anchor" href="#四-缓存是第二条旁路">#</a>四、缓存是第二条旁路</h2>
<p>列表闸门和单篇闸门都挡住之后，我差点漏掉缓存。这篇站点对单篇正文做两层缓存，浏览器层之外还有两层是我能碰到的：Worker 实例级的 LRU 和边缘缓存。前者在 <code>postcache.js</code>，TTL 是 45 秒（<code>TTL = 45_000</code>）；后者是 Cloudflare 的 edge cache，TTL 300 秒（5 分钟，<code>cache.js</code> 的 <code>EDGE_TTL = 300</code>）。<a href="/p/three-layer-cache">三层缓存那篇</a>把这三层的分工讲过，这里只讲跟审核有关的部分。</p>
<p>问题出在实例级 LRU 的写入条件。原来 <code>servePostPage</code> 拿到 bundle 就无条件 <code>postCacheSet</code>，不管这篇过没过审。于是有了一条很具体的旁路：作者用自己账号预览一次 pending 稿，正文进缓存；匿名访客紧接着请求同一个 slug，命中缓存直接返回，连数据库都不查，闸门自然也就不存在了。45 秒的窗口足够让一次预览变成一次泄露。</p>
<p>修法是在写缓存的地方加审核态判断，<code>src/index.js</code> 大约 1010 到 1017 行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 私有 / 未过审的文章不进实例缓存：
   私有正文没必要在内存多留 45 秒；未过审的更危险——作者预览过一次后
   缓存里就有正文了，匿名访客读缓存会绕过下面那道审核闸门。边缘缓存另算，
   那边的清理由审核 API 的 bust() 负责。 */</span>
<span class="tok-k">if</span> (post &amp;&amp; !post.is_private &amp;&amp; post.review_status === <span class="tok-s">&#39;approved&#39;</span>) <span class="tok-f">postCacheSet</span>(slug, b);</code></pre></div>
<p>这里要强调一点：这句判断和 1058 到 1069 行那道 SSR 审核闸门是两回事。闸门决定&quot;这次请求要不要返回 404&quot;，缓存判断决定&quot;这篇要不要留在本实例内存里给下次用&quot;。只做前者，pending 稿第一次请求确实被 404 挡住了，但作者预览那次是带身份的、会被放行，放行那次就把正文写进了缓存——匿名访客吃到的是那次预览的缓存。两处必须同时加。</p>
<p>边缘缓存的清理走另一条路。实例级 LRU 是 Worker 内存，重启即失；边缘缓存跨请求存在，靠 TTL 和主动清除。审核通过或驳回之后，<code>/api/review/:id</code> 会调 <code>bust()</code> 主动把相关路径的边缘缓存清掉，不等那 300 秒自己过期。两张表把这条线说清：</p>
<div class="table-wrap"><table><thead><tr><th>缓存层</th><th>位置</th><th>TTL</th><th>未过审怎么挡</th><th>审核后怎么清</th></tr></thead><tbody><tr><td>实例 LRU</td><td>Worker 内存</td><td>45 秒</td><td><code>postCacheSet</code> 条件拒绝写入</td><td>不清理，本来就没写进去</td></tr><tr><td>边缘缓存</td><td>Cloudflare edge</td><td>300 秒</td><td>不缓存未过审响应</td><td>审核 API 调 <code>bust()</code> 主动清</td></tr></tbody></table></div>
<p>这里还有个容易想当然的地方：实例级 LRU 是 Worker 内存，不跨实例、冷启清零，所以同一篇稿子在不同边缘节点上的缓存状态可能不一样。拿它当&quot;这篇已经审核过&quot;的依据是错的——它连自己是不是还活着都保证不了。授权判断必须每次查库，缓存只负责省那一次查询，不负责作决定。</p>
<p>坦白一句：缓存旁路这一条我没有单独构造一次&quot;作者预览→匿名命中&quot;的复现实验，是按 <code>postCacheSet</code> 的调用路径和缓存命中顺序推断出来的。四路验证里匿名单篇确实不可见，但那是在加了缓存判断之后跑的；如果只测四路、不看缓存写入条件，这个洞会一直留着。这条没测，只到推断为止。</p>
<h2 id="五-四路验证"><a class="h-anchor" href="#五-四路验证">#</a>五、四路验证</h2>
<p>闸门和缓存都改完，我在本地和线上各跑了一遍全链路。验证不是看代码&quot;觉得对&quot;，是把 pending 稿按四种对外出口挨个试，看匿名身份到底能不能拿到内容。四路是：匿名列表、单篇 API、SSR 页面、对外清单（RSS 与 sitemap 算一路，它们都是给聚合器和爬虫看的公开目录）。</p>
<p>测试稿用 uid=2 那个普通用户账号发，正文是明确的探针内容，发完确认状态是 <code>pending</code>。然后切匿名身份逐路请求，记录每一项的表现；再由 uid=1 审核通过，重复一遍；再驳回，再重复一遍。所有请求都带真实状态码，不看页面截图猜。</p>
<div class="table-wrap"><table><thead><tr><th>出口</th><th>pending（匿名）</th><th>approved</th><th>rejected（匿名）</th></tr></thead><tbody><tr><td>匿名列表（首页/归档）</td><td>不出现</td><td>出现</td><td>不出现</td></tr><tr><td>单篇 API <code>/api/posts/:slug</code></td><td>404 <code>文章不存在</code></td><td>200</td><td>404 <code>文章不存在</code></td></tr><tr><td>SSR 页面 <code>/p/:slug</code></td><td>404 <code>文章还在审核中</code></td><td>200</td><td>404 <code>文章还在审核中</code></td></tr><tr><td>RSS + sitemap</td><td>不含该条</td><td>含该条</td><td>不含该条</td></tr></tbody></table></div>
<p>把 RSS 和 sitemap 并成一路，不是图省事。爬虫和聚合器不会带登录 cookie，在服务端看来它们就是最纯粹的匿名身份，而且抓取频率比人高得多——一篇 pending 稿要是进了 sitemap，可能在你发现之前就被抓进索引。所以这两项虽然不是&quot;页面&quot;，验证优先级反而排在最前。</p>
<p>单篇 API 的闸门在 <code>src/api.js</code> 大约 674 到 676 行，判断写得比列表更严：猜到 slug 的匿名请求直接 404，连&quot;文章存在但需审核&quot;这种提示都不给。作者本人和管理员是例外，用 <code>user.id === p.author_id || user.is_admin</code> 放行，方便预览。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> owner = user &amp;&amp; (user.id === p.author_id || user.is_admin);
<span class="tok-k">if</span> (p.review_status &amp;&amp; p.review_status !== <span class="tok-s">&#39;approved&#39;</span> &amp;&amp; !owner) <span class="tok-k">return</span> <span class="tok-f">err</span>(<span class="tok-s">&#39;文章不存在&#39;</span>, <span class="tok-n">404</span>);</code></pre></div>
<p>SSR 那条走的是 <code>servePostPage</code>，逻辑一样，只是把 404 换成走 <code>notFoundPage</code>，提示文案是&quot;文章还在审核中&quot;。这里有个我特意留意过的细节：不能给 pending 稿返回&quot;审核中&quot;之外的任何区分信息，否则别人拿 slug 轮询就能探出站里有哪些未公开投稿。所返回的文案对&quot;不存在&quot;和&quot;审核中&quot;做了区分（API 用&quot;文章不存在&quot;，SSR 用&quot;还在审核中&quot;），但没有暴露作者、时间和内容。</p>
<p>实测四路在 pending 下全部不可见，approve 后全部可见，reject 后全部回到不可见。测试稿在跑完之后删掉了，线上公开数回到 19 篇——和动手前一致。这一步我认为比&quot;写了多少行代码&quot;更重要：审核这种功能，验证的价值全在&quot;匿名视角下到底看不看得见&quot;，不在实现看起来严不严密。</p>
<h2 id="六-改稿重置与驳回重提"><a class="h-anchor" href="#六-改稿重置与驳回重提">#</a>六、改稿重置与驳回重提</h2>
<p>审核通过后还有个坑：投稿人把一篇过审文章的正文偷换成广告或违规内容。如果审核态停在 <code>approved</code> 不跟着内容变，那么&quot;先发一篇无害的过审，再改正文&quot;就能绕过整条审核线。所以普通用户每次保存文章，状态都无条件退回 <code>pending</code>，<code>src/api.js</code> 大约 802 到 807 行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">/* 审核态跟着这次保存走：
   - 普通用户改稿（哪怕只改一个字）一律退回 pending —— 否则「先发篇无害的过审，
     再偷偷把正文换成广告/违规内容」就绕过了审核。审核结论必须绑定内容版本。
   - 管理员编辑视为认可，直接 approved。 */</span>
<span class="tok-k">const</span> review = u.is_admin ? <span class="tok-s">&#39;approved&#39;</span> : <span class="tok-s">&#39;pending&#39;</span>;</code></pre></div>
<p>&quot;哪怕只改一个字&quot;是字面意思，更新接口不做&quot;内容是否实质变化&quot;的判断，只要走了保存就重置。这么做牺牲了一点便利：作者改个错别字也要重新过审。但反过来，一旦引入&quot;小改动不重置&quot;的豁免，就给了绕过审核的口子——而判断什么是&quot;小改动&quot;本身又是个可被利用的规则。我选了笨但严的那边。</p>
<p>管理员编辑视为认可，这条是权限模型决定的：管理员本来就能直接审核，他改稿时没必要再把自己写的东西打回待审。审核通过和驳回走专门的接口，不混在普通文章保存里：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">if</span> (/^\/review\/\d+$/.<span class="tok-f">test</span>(path) &amp;&amp; method === <span class="tok-s">&#39;POST&#39;</span>) {
  <span class="tok-k">const</span> { res } = <span class="tok-k">await</span> <span class="tok-f">requireAdmin</span>(env, request);
  <span class="tok-k">if</span> (res) <span class="tok-k">return</span> res;
  <span class="tok-k">const</span> id = <span class="tok-f">parseInt</span>(path.<span class="tok-f">split</span>(<span class="tok-s">&#39;/&#39;</span>)[<span class="tok-n">2</span>], <span class="tok-n">10</span>);
  <span class="tok-k">const</span> action = <span class="tok-f">String</span>(body.action || <span class="tok-s">&#39;&#39;</span>);
  <span class="tok-k">if</span> (action !== <span class="tok-s">&#39;approve&#39;</span> &amp;&amp; action !== <span class="tok-s">&#39;reject&#39;</span>) <span class="tok-k">return</span> <span class="tok-f">err</span>(<span class="tok-s">&#39;action 只能是 approve 或 reject&#39;</span>);
  <span class="tok-c">// ... 更新 review_status</span>
  <span class="tok-k">if</span> (ctx) ctx.<span class="tok-f">waitUntil</span>(<span class="tok-f">bust</span>(url, [p.slug]).<span class="tok-k">catch</span>(() =&gt; {}));
  <span class="tok-k">return</span> <span class="tok-f">json</span>({ ok: <span class="tok-k">true</span>, id, review_status: next });
}</code></pre></div>
<p><code>action</code> 只认 <code>approve</code> 和 <code>reject</code> 两个值，其他一律报错，避免拼错字符串时静默走到某个默认分支。状态写完之后调 <code>bust()</code> 清边缘缓存，这样通过后刷新就能看到，不用等那 300 秒。实测里 reject 之后单篇立刻变 404、作者改稿立刻回 pending 重入队，都走的这条路径。</p>
<p>后台这边加了三处入口。<code>/admin/review</code> 是审核页，列出已到发布时间的 pending 稿，每条带通过和驳回按钮；页面用内联 <code>script</code> 调 <code>/api/review/:id</code>，nonce 由出口的 <code>harden()</code> 统一签，和 <a href="/p/csp-nonce-cache">CSP nonce 那篇</a> 是同一套机制，没新增 CSP 面。工作台加了一个待审 KPI，有值就能点进去直达审核页；编辑器自己的文章列表里，pending 和 rejected 各显示一个徽标，作者不用猜自己稿子卡在哪一步。</p>
<p>审核页的接口和页面本身都带 <code>requireAdmin</code>，且响应是 <code>cache-control: no-store</code>——待审列表不该被任何一层缓存记住。这一点和前面缓存章节是同一条原则的延伸：凡是基于身份才可见的内容，缓存键里不包含身份，就只能不缓存。</p>
<h2 id="七-sqlite-的幂等没了"><a class="h-anchor" href="#七-sqlite-的幂等没了">#</a>七、SQLite 的幂等没了</h2>
<p>这次改表踩到一个 SQLite 和 MySQL 的差异，值得单独记一笔。我原本想像给索引加 <code>IF NOT EXISTS</code> 那样，把加字段也写成幂等语句：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">-- 这条在 SQLite 里是语法错
ALTER TABLE posts ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT <span class="tok-s">&#39;approved&#39;</span>;</code></pre></div>
<p>SQLite 不支持 <code>ALTER TABLE ADD COLUMN IF NOT EXISTS</code>，直接报语法错。它只支持标准的 <code>ADD COLUMN</code>，重复执行会报&quot;列已存在&quot;之类的错误，但没有&quot;存在就跳过&quot;这个语法。迁移文件 <code>migrations/0002_review_status.sql</code> 落地的是最朴素的一条：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT <span class="tok-s">&#39;approved&#39;</span>;
CREATE INDEX IF NOT EXISTS idx_posts_review ON <span class="tok-f">posts</span>(review_status);</code></pre></div>
<p>注意一个不对称：索引那句带了 <code>IF NOT EXISTS</code>，字段那句没有。<code>CREATE INDEX IF NOT EXISTS</code> 在 SQLite 里是合法的，所以索引可以重复跑；加字段不行，只能靠&quot;迁移只执行一次&quot;这个前提来保证幂等。这意味着部署脚本得自己记住 0002 跑没跑过——好在这个站的迁移本来就是手工按顺序执行的，没有自动 migration runner，重复执行的风险本来就可控。</p>
<p>这条经验不只适用于审核字段。以后任何&quot;给 SQLite 加列&quot;的迁移都不能套 MySQL 那套幂等写法，写之前先确认目标引擎。我把这个差异写进迁移文件的注释里，主要是怕半年后自己又照着 MySQL 的习惯写一遍。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>如果你想在类似的多用户博客里复现这套审核开关，按下面的顺序查，每一步都有明确的预期结果。命令里的路径按本站的文件布局写，换项目时改路径即可。</p>
<p>先看字段和索引是不是真的落库了，以及存量数据有没有被误伤：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">sql</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-sql">-- 字段类型、默认值、是否允许为空
PRAGMA <span class="tok-f">table_info</span>(posts);
-- 索引是否存在
SELECT name FROM sqlite_master WHERE type=<span class="tok-s">&#39;index&#39;</span> AND name=<span class="tok-s">&#39;idx_posts_review&#39;</span>;
-- 口径分开看：总行数和公开数
SELECT <span class="tok-f">COUNT</span>(*) AS total FROM posts;
SELECT <span class="tok-f">COUNT</span>(*) AS public_cnt FROM posts
  WHERE review_status=<span class="tok-s">&#39;approved&#39;</span> AND is_private=<span class="tok-n">0</span> AND hidden=<span class="tok-n">0</span>;</code></pre></div>
<p>本站当前这两个数分别是 36 和 19。如果你的迁移没写默认 <code>approved</code>，第二条会接近 0，说明存量被误伤了。</p>
<p>然后用普通用户账号发一篇测试稿，确认它进的是 <code>pending</code> 而不是 <code>approved</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -X POST https:<span class="tok-c">//你的域名/api/posts \</span>
  -H <span class="tok-s">&#39;content-type: application/json&#39;</span> \
  -H <span class="tok-s">&#39;cookie: 你的登录cookie&#39;</span> \
  -d <span class="tok-s">&#39;{&quot;title&quot;:&quot;审核探针&quot;,&quot;content&quot;:&quot;probe&quot;,&quot;publish_at&quot;:&quot;&quot;}&#39;</span> | jq .
<span class="tok-c"># 再去库里核对</span>
<span class="tok-c"># sqlite3 db.sqlite &quot;SELECT slug,review_status FROM posts WHERE title=&#39;审核探针&#39;;&quot;</span></code></pre></div>
<p>接着按四路验匿名不可见，记状态码而不是看截图：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&#39;%{http_code}\n&#39;</span> https:<span class="tok-c">//你的域名/api/posts/审核探针-slug</span>
<span class="tok-k">curl</span> -s -o /dev/null -w <span class="tok-s">&#39;%{http_code}\n&#39;</span> https:<span class="tok-c">//你的域名/p/审核探针-slug</span>
<span class="tok-k">curl</span> -s https:<span class="tok-c">//你的域名/rss | grep -c &#39;审核探针&#39;        # 期望 0</span>
<span class="tok-k">curl</span> -s https:<span class="tok-c">//你的域名/sitemap.xml | grep -c &#39;审核探针&#39; # 期望 0</span></code></pre></div>
<p>前两条期望都是 404，后两条期望都是 0。任何一条不符合，就回头查对应的闸门：<code>liveSql</code> 管列表，单篇 API 和 SSR 各自那段 <code>review_status</code> 判断管单篇。</p>
<p>顺手把后台那几个入口也点一遍。用 uid=2 登录时访问 <code>/admin/review</code> 应该被挡住，工作台的待审 KPI 不该出现；用 uid=1 登录时应能看到 KPI 数字并点进审核页，编辑器文章列表里的测试稿应显示待审徽标。这些不是安全边界，但能确认&quot;审核结论有没有传到人眼前&quot;——状态对了而没人看见，审核照样失效。</p>
<p>收尾验缓存旁路。用一个低成本的办法近似：作者身份预览一次测试稿，紧接着立刻用匿名身份请求同一个 slug，看是不是仍然 404。如果匿名那次拿到了正文，说明 <code>postCacheSet</code> 的审核态条件没加上，或者边缘缓存没在审核后清掉。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 该条件必须同时出现在实例缓存写入处</span>
<span class="tok-k">if</span> (post &amp;&amp; !post.is_private &amp;&amp; post.review_status === <span class="tok-s">&#39;approved&#39;</span>) <span class="tok-f">postCacheSet</span>(slug, b);</code></pre></div>
<p>验完记得把测试稿删掉，再核对一次公开数。本站跑完这一轮之后公开数回到 19，和动手前一致。这一条别省——留一篇探针稿在库里，比没有这套审核还糟。</p>
<p><a class="tag-inline" href="/tag/security">#security</a> <a class="tag-inline" href="/tag/sqlite">#sqlite</a> <a class="tag-inline" href="/tag/ssr">#ssr</a> <a class="tag-inline" href="/tag/cache">#cache</a></p>', '', 'teardown', 'hidden 是作者随时能改回 0 的开关，拿它当审核态等于没有审核。新增 review_status 三态，公开列表走 liveSql、管理队列走 timeGateSql；未过审的不进 LRU，否则作者预览一次匿名就能读缓存绕过闸门。四路实测：列表/单篇/SSR/RSS。',
        '', 0, 0, 0, 1, '2027-01-27 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('security') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'review-status-cache-bypass' AND t.name = 'security';
INSERT INTO tags (name) VALUES ('sqlite') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'review-status-cache-bypass' AND t.name = 'sqlite';
INSERT INTO tags (name) VALUES ('ssr') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'review-status-cache-bypass' AND t.name = 'ssr';
INSERT INTO tags (name) VALUES ('cache') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'review-status-cache-bypass' AND t.name = 'cache';
INSERT INTO posts (slug, title, content, html_content, cover_body, category, summary, series, series_order,
                   is_private, hidden, author_id, published_at, created_at, updated_at)
VALUES ('monaco-eol-crlf', 'Monaco 空文档的 getEOL() 恒返回 CRLF，两个枚举值还相反', '## 结论

这篇是编辑器系列的第三篇，接在 [停手三秒就自动存了](/p/editor-autosave) 和 [Markdown 渲染器凭什么敢直接处理 `<script>`](/p/editor-markdown-xss) 后面。前两篇一个管内容不丢，一个管预览不执行脚本，这篇管第三件麻烦事：把 Monaco 当外壳挂上去以后，换行符怎么把我精心维护的偏移量彻底搅乱。

先把结论压成三句。第一句：**Monaco 对一个空文档，`model.getEOL()` 恒返回 `''\r\n''`（CRLF），哪怕同一个时刻 `getEndOfLineSequence()` 已经是 LF。** 这两者不是一回事，前者是「当前实际用的换行串」，后者是「记录在 model 上的序列枚举」，空文档里它们会分叉。第二句：**`EndOfLineSequence.LF === 0`，而 `EndOfLinePreference.LF === 1`，两个枚举的字面值正好相反**，任何写死数字的写法都有一半概率设反。第三句：这套编辑器真正的数据源一直是那个影子 `textarea`，Monaco 只是挂在外面的壳，所以一旦 Monaco 内部的换行和 textarea 的换行不一致，所有基于偏移的工具栏操作都会错位。

这三条里最容易低估的是第一条。空文档在写作场景里不是边角情况——每篇新文章都是从空文档开始敲的，而「第一次插入」又往往不是逐字敲，是点一下工具栏模板、粘贴一段现成文字。恰恰是这些批量插入的路径，会把 CRLF 一次性带进整篇正文。等发现的时候，字数统计、diff、正则匹配全被看不见的 `\r` 带偏，而肉眼在渲染后的预览里什么异常都看不到。

数据源这件事也值得在开头钉死。保存、自检、草稿读取，全部读 `inputEl.value`，一共三处，没有第四处。Monaco 的存在感被压到最低：它只负责显示和接收键盘输入，它的 `getValue()` 在每次内容变化时整篇写回 `inputEl.value`，仅此而已。这个架构决定了「偏移错位」的爆炸半径——它不会让内容丢失，不会让保存失败，只会让工具栏和光标这些建立在偏移之上的交互变得诡异。正因为不致命，它很容易被当成小毛病拖着，而拖着拖着就会有人用写死数字去「修」，于是引出第二条坑。

三个数字都来自本站 2026-11-22 的实际改动，代码在 `public/editor.html`，commit 是 `82e4b84`（Monaco 主体）和 `877d1dc`（工具栏 mermaid 模板 + 换行 LF 归一）。我没有引入任何第三方封装库，Monaco 只挂在 `/editor` 这一个页面，CDN 锁死在 `monaco-editor@0.52.2`。下面每一段代码都能在 `public/editor.html` 的对应行号里找到原型，贴出来的是删掉无关分支后的版本；没有测过的判断我会单独标出来，不当成结论卖。

## 一、现象：工具栏一插模板，光标就偏一行

第一个症状出现在工具栏的 mermaid 模板按钮上。这个按钮是 `877d1dc` 那次一起加的，点一下往光标处插一段三行的围栏代码：

```text
```mermaid
graph TD
  A --> B
```
```

插完预览是好的，mermaid 照常渲染（`securityLevel:''strict''`，和它同批上线），但光标没有落在模板末尾，而是往上飘了一行；紧接着再点一次别的按钮，插入位置就落在了上一行的中间。这个反差一开始把我带偏了——预览正确说明 Markdown 解析没问题、内容没丢，那出错的只能是「光标位置」这件看起来很小的事。我把注意力全放在选区设置上，反复看 `edReplace` 里那段 `setSelection`，怎么读都觉得行列算得没毛病。

插入走的是适配层的 `edReplace`，代码在 `public/editor.html:383`：

```js
function edReplace(text, s, e, selectFrom, selectTo) {
  if (monaco) {
    const model = monaco.getModel();
    const st = model.getPositionAt(s);
    const en = model.getPositionAt(e);
    monaco.executeEdits(''toolbar'', [
      { range: new monacoApi.Range(st.lineNumber, st.column, en.lineNumber, en.column), text },
    ]);
    if (selectFrom != null) {
      const a = model.getPositionAt(selectFrom);
      const b = model.getPositionAt(selectTo == null ? selectFrom : selectTo);
      monaco.setSelection(new monacoApi.Range(a.lineNumber, a.column, b.lineNumber, b.column));
    }
    monaco.focus();
  } else {
    inputEl.setRangeText(text, s, e, ''end'');
    if (selectFrom != null) inputEl.setSelectionRange(selectFrom, selectTo == null ? selectFrom : selectTo);
    inputEl.focus();
  }
  onInput();
}
```

这段代码有个前提：`s` 和 `e` 是 textarea 口径的偏移（UTF-16 code unit），而 `getPositionAt` 收的是 Monaco model 口径的偏移。两者要相等，必须满足一件事——两份文本逐字节一致，尤其是换行符必须逐字节一致。这个前提在空文档上第一次被打破，于是整条链从第一行就开始歪。

走 `else` 分支（Monaco 没挂载）时，同一段逻辑完全正常：`inputEl.setRangeText` 直接吃 textarea 原生偏移，不存在两层文本不一致的问题。也就是说这个 bug 只在 Monaco 挂载成功时出现——降级路径反而是干净的那条。这一点后来成了定位问题的关键线索：同一个按钮，挂了 Monaco 会错，不挂就对，那问题必然出在「Monaco 与 textarea 之间的映射」上，而不是工具栏逻辑本身。

## 二、第一反应是数错偏移，其实错在换行

我最初怀疑自己数错了行数，拿着 `getPositionAt(s)` 和 `getOffsetAt(pos)` 来回对拍，怀疑是 UTF-16 把 emoji 算成两个 code unit 导致的。这个方向后来证明是错的：中文标题和 emoji 那条路径没有出问题，偏偏只在插入多行文本、且文档原本是空的时候出问题。把插入后的 `model.getValue()` 打印出来，才看见每个换行位置躺着的是 `\r\n` 而不是 `\n`。

根因在 `executeEdits` 内部：它用 `model.getEOL()` 来规范化插入文本里的换行。空文档的 `getEOL()` 恒为 `''\r\n''`，所以第一次插入三行 mermaid 模板，三行之间就被塞进了 `\r`。而 textarea 那一侧从来都是 `\n`，库里存量文章也都是 `\n`（早年编辑器留下的 CRLF 是另一路，后面单独说）。于是同一个「第 2 行行首」，两边的偏移开始分叉。

这里要补一句术语。偏移是 UTF-16 code unit 计数：一个普通汉字占一个 code unit，一个 emoji 占两个，而一个 `\r\n` 占两个、一个 `\n` 占一个。Monaco 的 `getPositionAt(offset)` 把偏移翻译成「第几行第几列」，`getOffsetAt(position)` 反过来翻译，两者互为逆运算——前提是它们操作的是同一份、换行符完全一致的字符串。一旦 textarea 用 `\n`、model 用 `\r\n`，这两个函数算出来的行列和 textarea 的 `selectionStart` 就再也对不上，而且差值逐行累加，越往后越离谱。

分叉的规律很朴素，每个 `\r\n` 比 `\n` 多一个字符，偏移就多算 1：

| 位置 | textarea（`\n`）偏移 | Monaco（`\r\n`）偏移 | 差值 |
|---|---|---|---|
| 第 1 行末尾 | 11 | 11 | 0 |
| 第 2 行行首 | 12 | 13 | +1 |
| 第 3 行行首 | 20 | 22 | +2 |
| 第 4 行行首 | 23 | 26 | +3 |

这张表里的具体字符数是按那段 mermaid 模板手工推的，用来说明「每个换行差 1、逐行累加」这个规律；我没有在真机上逐个打印过这些偏移量，所以表中数值只到推断为止，能确定的只有差值那一列的递增规律。真正确认过的，是 `getValue()` 里出现 `\r\n`、以及 `inputEl.value.slice(s,e)` 与 Monaco 返回的文本对不上这两件事——它们都能在改动前后的对照里复现。

工具栏里所有需要「取一段文本再改」的操作都吃这个亏。`## `、`> `、`- ` 这类行首前缀往 `edLineStart()` 返回的偏移处插，Tab 键把选中行整体缩进两个空格，撤销/重做后重新算选区，全部依赖偏移和行列的一一映射。换行符一旦多出一个不可见字符，这条映射就从出错那一行起整体平移。四个适配函数各自吃偏移的方式不同，但都建立在同一个假设上：

| 函数 | 拿偏移做什么 | 受 CRLF 影响的环节 |
|---|---|---|
| `edSelection` | `getOffsetAt` 把行列换成偏移 | 选区起止偏移整体平移 |
| `edReplace` | `getPositionAt` 把偏移换成行列 | 插入位置与回设选区错位 |
| `edSetText` | 整篇赋值，不直接吃偏移 | 入口是否归一决定后续是否错位 |
| `edLineStart` | `getOffsetAt` 取当前行行首 | 行首前缀插到错误的行 |

这张表是四个函数在 `public/editor.html` 里的实际职责归纳，不是另造的分类。可以看到真正「吃偏移」的是前两个和第四个，而 `edSetText` 的作用是在最上游把文本洗对——这也解释了为什么修法必须落在 `edSetText` 入口，光在 `edReplace` 里兜是不够的。

## 三、两个枚举，字面值相反

真正把坑挖深的是我第一版修法：既然 `getEOL()` 是 CRLF，那就设成 LF 好了，于是写了 `model.setEOL(1)`。结果越修越糟——插入的多行文本 `\r` 更多了。查 Monaco 的枚举定义才发现，两个名字里都带 `LF` 的常量，字面值是反的：

| 枚举 | `LF` 的值 | `CRLF` 的值 | 用途 |
|---|---|---|---|
| `monacoApi.editor.EndOfLineSequence` | `0` | `1` | `model.setEOL()` 的参数，表示要把 model 设成哪种换行 |
| `monacoApi.editor.EndOfLinePreference` | `1` | `2` | 读值/保存时的偏好，表示按哪种换行解释文本 |

我写的 `setEOL(1)` 落到了 `EndOfLineSequence.CRLF` 上，等于亲手把 model 锁进 CRLF。这里没有类型转换也没有隐式规则，就是两个枚举把 `LF` 摆在了不同的数字上：一个是 0，一个是 1。两个枚举各自内部自洽，跨着用就翻车——这是所有「字面值相反」类 bug 的通病。

为什么库里会存在两个几乎同名的枚举，我没有查 Monaco 的设计文档，这条只到推断为止：一个描述「model 实际存了什么换行」（Sequence，写），一个描述「读出来时按什么偏好解释」（Preference，读），职责不同所以各自编号，编号时又都以自己喜欢的值为先，于是撞出了相反的字面值。这个推断能解释现象，但成因我没有验证过，不当成事实。

唯一稳妥的写法是永远用枚举常量，永远不写裸数字：

```js
// ✓ 用枚举，数字是多少不关心
model.setEOL(monacoApi.editor.EndOfLineSequence.LF);

// ✗ 写死数字：1 在 Sequence 里是 CRLF，在 Preference 里才是 LF
model.setEOL(1);
```

我把这条写进了代码注释，位置在 `public/editor.html:394`，因为这种坑一定会有人（包括几个月后的我）再踩一次。判断依据不是「文档说 0 还是 1」，而是「这个参数的类型是 `EndOfLineSequence` 还是 `EndOfLinePreference`」。写死数字的坏处不只是这次设反——它还会通过一个隐蔽的路径扩散：`setEOL(1)` 让 model 变成 CRLF，下一次 `executeEdits` 又用这个 CRLF 去规范化新插入的多行，于是 `\r` 越来越多，形成正反馈。这才是我说的「越修越糟」的真正机制，不是一次性的写错，是错误被后续操作不断放大。

## 四、三处修法，各堵一类入口

修法落在三个入口上，每个堵一类来源，缺一个都会从别的口子漏回来：

| 入口 | 触发时机 | 修法 | 代码位置 |
|---|---|---|---|
| `executeEdits` | 工具栏、Tab、粘贴等一切插入多行 | 插入后检测并压回 LF | `public/editor.html:396` |
| `edSetText` | 载入草稿、切换文章、整篇赋值 | 入口把存量 CRLF 归一成 LF | `public/editor.html:418` |
| `editor.create` | 页面初始化、空文档第一次建 model | create 后显式 `setEOL` | `public/editor.html:1588` |

第一处是 `edReplace` 里紧跟 `executeEdits` 的那两行：

```js
monaco.executeEdits(''toolbar'', [
  { range: new monacoApi.Range(st.lineNumber, st.column, en.lineNumber, en.column), text },
]);
/* executeEdits 用 model.getEOL() 规范化换行，而空文档的 getEOL() 恒为 CRLF
   （哪怕 getEndOfLineSequence() 已经是 LF）—— 空文档里第一次插入多行内容会带进 \r。 */
if (model.getEOL() !== ''\n'') model.setEOL(monacoApi.editor.EndOfLineSequence.LF);
```

用 `model.getEOL() !== ''\n''` 当判断条件，而不是无条件 `setEOL`，是为了不把已经是 LF 的正常插入也标成一次 model 改动——少一次改动，就少一次触发 `onDidChangeModelContent` 的机会。这里的固定搭配是「检测实际换行串 + 用序列枚举写回」，两件事分开做，谁都不省。省掉检测，正常的 LF 插入也会走一遍 `setEOL`；省掉枚举，就可能设反。这一行看着短，两个坑同时被它堵住。

第二处在 `edSetText` 入口，处理的是存量文章。库里有早年编辑器留下的 CRLF 正文，它们不经过 `executeEdits`，而是整篇灌进 textarea 和 Monaco：

```js
function edSetText(t) {
  // 存量文章可能是 CRLF（早年编辑器留下的），进来先统一，别再传染出去
  t = String(t || '''').replace(/\r\n?/g, ''\n'');
  if (inputEl.value !== t) inputEl.value = t;
  if (monaco) {
    monoSyncing = true;
    monaco.setValue(t);
    monoSyncing = false;
  }
}
```

正则 `/\r\n?/g` 同时覆盖 `\r\n`（Windows 换行）和落单的 `\r`（老 Mac 换行），两种都归一成 `\n`。这一步放在赋值之前，保证 textarea 和 Monaco 拿到的永远是同一份、同一种换行的文本——数据源一致，偏移就不会漂。`monoSyncing` 这个布尔开关包住 `setValue`，是防止程序自己的整篇赋值又被 `onDidChange` 当成用户输入回灌一遍。

第三处在 `create` 之后、挂监听之前，下一节专门讲。三处合起来覆盖的时间线是：页面初始化时定基调（create 后 setEOL），载入文章时洗存量（edSetText），日常编辑时兜插入（executeEdits 后归一）。这三层分别对应「空文档」「旧数据」「新输入」，没有重叠也没有遗漏。我试过只留其中两处：留 create 和 edReplace、去掉 edSetText，存量 CRLF 文章一载入就错位；留 create 和 edSetText、去掉 edReplace，空文档点模板立刻带 `\r`。三处不是防御性冗余，是三种不同的入口各自需要的处理。

## 五、create 的 defaultEOL 为什么没用

我最早想偷懒：既然 `create()` 有个 `defaultEOL` 配置项，直接在创建时传 `EndOfLineSequence.LF` 不就一劳永逸？实测不行——空文档上它不生效。原因写在 Monaco 的行为里：`defaultEOL` 只在 model 能从传入内容推断出换行时才作为默认值使用，空文档没有内容可推断，这个配置就被跳过了。换句话说，它管的是「有内容但看不出换行风格时兜个底」，管不了「压根没有内容」。

这条「只在能推断时才用」的行为我是从实测现象反推的，没有去翻 Monaco 源码逐行确认，属于有实验支撑的推断，还没到源码级验证。但结论是可操作的：在空文档这个场景下不能指望 `defaultEOL`，必须在 model 建好之后显式调用一次 `setEOL`。

可行的做法只有一条：建完 model 再显式改，而且要在挂 `onDidChangeModelContent` 监听之前改——

```js
monaco = monacoApi.editor.create(host, {
  value: inputEl.value,
  language: ''markdown'',
  // ... 字体、行高、tab 等配置
});
/* 换行统一成 LF。create() 的 defaultEOL 在空文档上不生效
   （它只在能从内容推断时才用），只能建完 model 再显式改。
   放在挂监听之前，避免这次改动被当成用户输入。 */
try {
  monaco.getModel().setEOL(monacoApi.editor.EndOfLineSequence.LF);
} catch {}
pane.classList.add(''mon-ready'');
```

顺序是关键，不是风格问题。如果先挂监听再 `setEOL`，这次换行改动会触发一次 `onDidChangeModelContent`，回调里 `getValue()` 读到的已经是 LF 全文，它会把这份全文写回 textarea 并调用 `onInput()`——这轮「假用户输入」会惊动自动保存和草稿逻辑，平白制造一次不必要的写入。放在监听之前，改动发生得悄无声息，回调压根还没接上。那段 `try {} catch {}` 是兜底：`setEOL` 在某些边缘状态下可能抛（比如 model 还没就绪），这里吞掉异常即可，因为最坏情况只是没设上，还有 `edReplace` 那道兜底接着——这就是三处修法彼此形成的冗余。

字体和行高也在这个 `create` 配置里一起对齐，目的是切换那一刻不要有半个字的位置跳动：`fontSize: 14.5`、`lineHeight: 27`、`padding: { top: 22, bottom: 22 }`、`tabSize: 2`、`insertSpaces: true`。这些数字是从 CSS 变量和 textarea 的 `14.5px / 1.85 ≈ 26.8px` 反推来的，写死在 `public/editor.html:1571` 附近。`automaticLayout: true` 让双栏/单栏切换和窗口缩放都不用自己算尺寸，`scrollBeyondLastLine: false`、`minimap: { enabled: false }`、`lineNumbers: ''off''` 这些开关则把 Monaco 往「像一块普通 textarea」的方向压。让 Monaco 的行高和 textarea 尽量重合，是「Monaco 只是外壳、textarea 是数据源」这个定位在视觉层的体现——两层看起来该是同一块编辑区，换行符也该是同一种。

## 六、降级与代价：textarea 始终是数据源

接 Monaco 的代价不只在换行，还在加载链路。这套编辑器对 Monaco 的态度一直是「有它更好，没它照写」：加载脚本在 `initMonaco()` 里，任何一步失败都给 `.pane.left` 加上 `mon-fail` 类，然后原样退回 textarea，写作流程完全不受影响。失败点一共有几处：`loadScript` 抛错、`window.require` 不存在、`require([''vs/editor/editor.main''])` 加载失败、`window.monaco` 为空，每一处都走同一个 `mon-fail` 出口。

CDN 锁在 `https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min`，`loader.js` 带 SRI：

```js
const MONACO_CDN = ''https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min'';
const MONACO_LOADER_SRI =
  ''sha384-pHG02SG8pId94Np3AbPmBEJ1yPqaH0IkJGLSNGXYmuGhkazT8Lr/57WYpbkGjJtu'';
```

跨源加载必须同时给 `crossOrigin = ''anonymous''`，否则 `integrity` 会被浏览器直接忽略，SRI 等于白写：

```js
s.integrity = integrity;
s.crossOrigin = ''anonymous''; // 跨源没有它，integrity 直接被忽略
s.onload = resolve;
s.onerror = () => reject(new Error(''加载失败：'' + src));
```

SRI 这道防线只覆盖 `loader.js` 这一条手动插入的 `<script>`。浏览器拿到 `integrity` 后会用 `sha384` 比对实际字节，不一致就拒绝执行，于是 CDN 上这一份文件被篡改也过不了关。但 `crossOrigin=''anonymous''` 是前置条件——跨源脚本默认不带 CORS 凭据，浏览器出于同源策略会直接跳过完整性校验，所以少写这一行，SRI 就静默失效，看起来配了其实没配。

这里有个绕不开的限制：AMD 加载器拉起的子模块拿不到这条 SRI。`loader.js` 这一条能被校验，是因为它是我手动插 `<script>` 加载的；后面 `require([''vs/editor/editor.main''])` 拉起来的几十个子模块走的是 AMD 自己的路径，`integrity` 管不到它们。Monaco 的 loader 模式天生如此。我能做的只有把版本号写死到 `0.52.2`——锁住版本，就等于锁住子模块的内容，把「内容被换掉」这个风险转嫁给「版本号不变」这个前提。这条没做独立验证，只是按锁版本号的常规做法推断，真要验证得比对该版本所有子模块的哈希，我没测，只到推断为止。

worker 是另一个必踩的坑。markdown 没有语言服务，但 Monaco 基础 worker 仍可能被要一次；默认它会去同源的 `/vs/base/worker/workerMain.js` 找，那个路径本站不存在，控制台会一直报 404。解法是用 blob 包一层 `importScripts` 指回 CDN：

```js
window.MonacoEnvironment = {
  getWorkerUrl() {
    const code =
      ''self.MonacoEnvironment={baseUrl:'' +
      JSON.stringify(MONACO_CDN + ''/'') +
      ''};importScripts('' +
      JSON.stringify(MONACO_CDN + ''/vs/base/worker/workerMain.js'') +
      '');'';
    return URL.createObjectURL(new Blob([code], { type: ''text/javascript'' }));
  },
};
```

这个 blob 的巧妙之处在于：worker 脚本本身是同源的（blob URL 挂在本站 origin 下），不受跨源限制，但它内部 `importScripts` 的地址指向 CDN，而 CDN 带 CORS 头，于是真正的 worker 代码从 CDN 拉取成功。一个 404 反复刷屏的问题，靠一层两行的转发就消掉了。这里的判断依据是控制台里反复出现的 404 路径——先看见它去 `/vs/...` 找，才想到要用 `getWorkerUrl` 改指向，不是凭空加的配置。

粘贴图片那块也跟着改了。Monaco 是另一个 DOM 树，它自己藏了一个 textarea 当事件目标，原来绑在正文 textarea 上的 `paste` 监听收不到 Monaco 里的粘贴。于是把监听挪到 `document` 上，再用 `closest(''.pane.left'')` 限定只在正文编辑区生效，标题和摘要框里粘图仍走浏览器默认行为：

```js
document.addEventListener(''paste'', async (e) => {
  const inBody = e.target.closest && e.target.closest(''.pane.left'');
  if (!inBody) return;
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find((i) => i.type.startsWith(''image/''));
  if (img) { e.preventDefault(); await uploadFile(img.getAsFile()); }
});
```

绑到 `document` 而不直接绑到 Monaco 的隐藏 textarea，是因为那个元素是 Monaco 内部生成的、没有稳定 id，等我去绑的时候它未必已经存在。事件委托到 `document` 上则不存在时序问题，代价是每次粘贴都要多做一次 `closest` 判断——这个开销可以忽略。链接到正文编辑区的判断用 `.pane.left` 这个容器，和 `initMonaco()` 里判断挂载位置用的是同一个选择器，两处保持一致，不会出现「Monaco 挂在这、粘贴判断那」的错位。

所有这一切能成立，前提是 textarea 始终是唯一数据源。保存、自检、草稿读取，全部读 `inputEl.value`；Monaco 的 `onDidChangeModelContent` 回调只做一件事——把 `getValue()` 整篇写回 `inputEl.value`，再调 `onInput()`：

```js
monaco.onDidChangeModelContent(() => {
  if (monoSyncing) return;
  const v = monaco.getValue();
  if (inputEl.value !== v) inputEl.value = v;
  onInput();
});
```

我选的是整篇写回而不是增量打补丁，因为 `onInput` 只读 `value`，增量同步既没收益，又要自己处理撤销/重做与光标，出错面大得多。适配器就四个函数：`edSelection`、`edReplace`、`edSetText`、`edLineStart`，工具栏、Tab、滚动同步、粘贴全走它们；双栏滚动同步因为 Monaco 是另一个滚动容器，还单独接了一条 `onDidScrollChange`。这层薄薄的适配把「Monaco 是不是加载成功」和「正文逻辑怎么跑」彻底解耦——换行坑再深，也只在这四个函数里发作，不会渗到保存和发布链路。这也是为什么我敢让 Monaco 可降级：它从来就不是不可替代的那一层。

这篇里我没做两件事，说清楚边界。一是没有去改 Monaco 的枚举或 `executeEdits` 行为——库是 CDN 上的成品，改它就得自己维护一份 fork，代价远大于在应用层堵三处，所以选择在适配层解决。二是没有跨版本验证：结论建立在锁定的 `monaco-editor@0.52.2` 上，换一个版本，`getEOL()` 的空文档行为和两个枚举的字面值都可能变，那套验证脚本得重跑一遍才能作数。这两条都属于「没测，只到推断或选择为止」，不当成普适规律讲。

## 怎么自己验一遍

下面这套是我自己在真机上跑过的顺序，对应 2026-11-22 那次提交。环境：本站 `/editor` 页面，浏览器控制台开着，CDN 用 `monaco-editor@0.52.2`。

```bash
# 1. 确认挂载成功：左栏应该有 mon-ready 类，而不是 mon-fail
#    控制台执行：
document.querySelector(''.pane.left'').className
```

```js
// 2. 空文档下直接看两个枚举的分叉（这就是主角）
const m = monaco.getModel();
console.log(m.getEOL(), m.getEndOfLineSequence());
// 期望：''\r\n'' 与 0 —— 两者不一致即复现
console.log(monacoApi.editor.EndOfLineSequence.LF);   // 0
console.log(monacoApi.editor.EndOfLinePreference.LF); // 1
```

```js
// 3. 修好以后：空文档插多行，再取全文，不该有 \r
//    先点 mermaid 模板按钮，再在控制台执行：
const v = monaco.getValue();
console.log(/[\r]/.test(v)); // 期望 false
console.log(document.querySelector(''textarea'').value === v); // 期望 true
```

手工清单，按这个顺序点一遍：

| 步骤 | 操作 | 通过的标志 |
|---|---|---|
| 1 | 打开 `/editor`，确认左栏挂载 | 出现 `mon-ready`，无 `mon-fail` |
| 2 | 空文档点 mermaid 模板 | 光标停在模板末尾，不飘行 |
| 3 | 再点 `## ` / `> ` / `- ` 行首按钮 | 插入位置正确，不落到上一行 |
| 4 | 选中多行按 Tab | 每行缩进 2 空格，无 `\r` |
| 5 | 载入一篇存量 CRLF 文章 | 全文归一成 `\n`，偏移不错位 |
| 6 | 预览 mermaid 图 | 正常渲染（`securityLevel:''strict''`） |
| 7 | 断网/拦掉 loader.js 后刷新 | 出现 `mon-fail`，textarea 仍可写可存 |

这套清单在真机跑的结果是 **11/11 全过**，覆盖挂载、同步、工具栏、2 空格缩进、预览 mermaid 这几类；Mermaid 和换行归一是同批上线。11 项比我上面列的 7 步要细，多出来的部分是同步链路和保存回读的逐项检查，这里不逐条展开，只说结论：没有一项因为换行归一而回退。我另外试过把 `setEOL(1)` 写回去的错误版本，第 2、3、4 步立刻失败，但那条不是回归用例，只是手动对照，没有计入 11 项。

要复现我踩的坑，最简单的一步是把 `public/editor.html:396` 那行 `if (model.getEOL() !== ''\n'') model.setEOL(...)` 注释掉，再从空文档点一次 mermaid 模板，控制台执行 `/\r/.test(monaco.getValue())`——会变成 `true`。反过来，把 `setEOL` 的参数从枚举换成裸 `1`，会看到 `\r` 不减反增。两条都亲测过，不是纸上推演。改完记得把那行恢复回去，再跑一遍第 2 到第 4 步确认回归。

#editor #javascript #debugging
', '<h2 id="结论"><a class="h-anchor" href="#结论">#</a>结论</h2>
<p>这篇是编辑器系列的第三篇，接在 <a href="/p/editor-autosave">停手三秒就自动存了</a> 和 <a href="/p/editor-markdown-xss">Markdown 渲染器凭什么敢直接处理 <code>&lt;script&gt;</code></a> 后面。前两篇一个管内容不丢，一个管预览不执行脚本，这篇管第三件麻烦事：把 Monaco 当外壳挂上去以后，换行符怎么把我精心维护的偏移量彻底搅乱。</p>
<p>先把结论压成三句。第一句：<strong>Monaco 对一个空文档，<code>model.getEOL()</code> 恒返回 <code>&#39;\r\n&#39;</code>（CRLF），哪怕同一个时刻 <code>getEndOfLineSequence()</code> 已经是 LF。</strong> 这两者不是一回事，前者是「当前实际用的换行串」，后者是「记录在 model 上的序列枚举」，空文档里它们会分叉。第二句：<strong><code>EndOfLineSequence.LF === 0</code>，而 <code>EndOfLinePreference.LF === 1</code>，两个枚举的字面值正好相反</strong>，任何写死数字的写法都有一半概率设反。第三句：这套编辑器真正的数据源一直是那个影子 <code>textarea</code>，Monaco 只是挂在外面的壳，所以一旦 Monaco 内部的换行和 textarea 的换行不一致，所有基于偏移的工具栏操作都会错位。</p>
<p>这三条里最容易低估的是第一条。空文档在写作场景里不是边角情况——每篇新文章都是从空文档开始敲的，而「第一次插入」又往往不是逐字敲，是点一下工具栏模板、粘贴一段现成文字。恰恰是这些批量插入的路径，会把 CRLF 一次性带进整篇正文。等发现的时候，字数统计、diff、正则匹配全被看不见的 <code>\r</code> 带偏，而肉眼在渲染后的预览里什么异常都看不到。</p>
<p>数据源这件事也值得在开头钉死。保存、自检、草稿读取，全部读 <code>inputEl.value</code>，一共三处，没有第四处。Monaco 的存在感被压到最低：它只负责显示和接收键盘输入，它的 <code>getValue()</code> 在每次内容变化时整篇写回 <code>inputEl.value</code>，仅此而已。这个架构决定了「偏移错位」的爆炸半径——它不会让内容丢失，不会让保存失败，只会让工具栏和光标这些建立在偏移之上的交互变得诡异。正因为不致命，它很容易被当成小毛病拖着，而拖着拖着就会有人用写死数字去「修」，于是引出第二条坑。</p>
<p>三个数字都来自本站 2026-11-22 的实际改动，代码在 <code>public/editor.html</code>，commit 是 <code>82e4b84</code>（Monaco 主体）和 <code>877d1dc</code>（工具栏 mermaid 模板 + 换行 LF 归一）。我没有引入任何第三方封装库，Monaco 只挂在 <code>/editor</code> 这一个页面，CDN 锁死在 <code>monaco-editor@0.52.2</code>。下面每一段代码都能在 <code>public/editor.html</code> 的对应行号里找到原型，贴出来的是删掉无关分支后的版本；没有测过的判断我会单独标出来，不当成结论卖。</p>
<h2 id="一-现象-工具栏一插模板-光标就偏一行"><a class="h-anchor" href="#一-现象-工具栏一插模板-光标就偏一行">#</a>一、现象：工具栏一插模板，光标就偏一行</h2>
<p>第一个症状出现在工具栏的 mermaid 模板按钮上。这个按钮是 <code>877d1dc</code> 那次一起加的，点一下往光标处插一段三行的围栏代码：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text"></code></pre></div>
<p>mermaid<br>graph TD<br>  A --&gt; B</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">text</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-text"></code></pre></div>
<p>插完预览是好的，mermaid 照常渲染（<code>securityLevel:&#39;strict&#39;</code>，和它同批上线），但光标没有落在模板末尾，而是往上飘了一行；紧接着再点一次别的按钮，插入位置就落在了上一行的中间。这个反差一开始把我带偏了——预览正确说明 Markdown 解析没问题、内容没丢，那出错的只能是「光标位置」这件看起来很小的事。我把注意力全放在选区设置上，反复看 <code>edReplace</code> 里那段 <code>setSelection</code>，怎么读都觉得行列算得没毛病。</p>
<p>插入走的是适配层的 <code>edReplace</code>，代码在 <code>public/editor.html:383</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span><span class="code-ln">21 行</span></span><button class="copy-btn">复制</button></div><pre class="code-block has-ln"><span class="gutter">1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21</span><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">edReplace</span>(text, s, e, selectFrom, selectTo) {
  <span class="tok-k">if</span> (monaco) {
    <span class="tok-k">const</span> model = monaco.<span class="tok-f">getModel</span>();
    <span class="tok-k">const</span> st = model.<span class="tok-f">getPositionAt</span>(s);
    <span class="tok-k">const</span> en = model.<span class="tok-f">getPositionAt</span>(e);
    monaco.<span class="tok-f">executeEdits</span>(<span class="tok-s">&#39;toolbar&#39;</span>, [
      { range: <span class="tok-k">new</span> monacoApi.<span class="tok-f">Range</span>(st.lineNumber, st.column, en.lineNumber, en.column), text },
    ]);
    <span class="tok-k">if</span> (selectFrom != <span class="tok-k">null</span>) {
      <span class="tok-k">const</span> a = model.<span class="tok-f">getPositionAt</span>(selectFrom);
      <span class="tok-k">const</span> b = model.<span class="tok-f">getPositionAt</span>(selectTo == <span class="tok-k">null</span> ? selectFrom : selectTo);
      monaco.<span class="tok-f">setSelection</span>(<span class="tok-k">new</span> monacoApi.<span class="tok-f">Range</span>(a.lineNumber, a.column, b.lineNumber, b.column));
    }
    monaco.<span class="tok-f">focus</span>();
  } <span class="tok-k">else</span> {
    inputEl.<span class="tok-f">setRangeText</span>(text, s, e, <span class="tok-s">&#39;end&#39;</span>);
    <span class="tok-k">if</span> (selectFrom != <span class="tok-k">null</span>) inputEl.<span class="tok-f">setSelectionRange</span>(selectFrom, selectTo == <span class="tok-k">null</span> ? selectFrom : selectTo);
    inputEl.<span class="tok-f">focus</span>();
  }
  <span class="tok-f">onInput</span>();
}</code></pre></div>
<p>这段代码有个前提：<code>s</code> 和 <code>e</code> 是 textarea 口径的偏移（UTF-16 code unit），而 <code>getPositionAt</code> 收的是 Monaco model 口径的偏移。两者要相等，必须满足一件事——两份文本逐字节一致，尤其是换行符必须逐字节一致。这个前提在空文档上第一次被打破，于是整条链从第一行就开始歪。</p>
<p>走 <code>else</code> 分支（Monaco 没挂载）时，同一段逻辑完全正常：<code>inputEl.setRangeText</code> 直接吃 textarea 原生偏移，不存在两层文本不一致的问题。也就是说这个 bug 只在 Monaco 挂载成功时出现——降级路径反而是干净的那条。这一点后来成了定位问题的关键线索：同一个按钮，挂了 Monaco 会错，不挂就对，那问题必然出在「Monaco 与 textarea 之间的映射」上，而不是工具栏逻辑本身。</p>
<h2 id="二-第一反应是数错偏移-其实错在换行"><a class="h-anchor" href="#二-第一反应是数错偏移-其实错在换行">#</a>二、第一反应是数错偏移，其实错在换行</h2>
<p>我最初怀疑自己数错了行数，拿着 <code>getPositionAt(s)</code> 和 <code>getOffsetAt(pos)</code> 来回对拍，怀疑是 UTF-16 把 emoji 算成两个 code unit 导致的。这个方向后来证明是错的：中文标题和 emoji 那条路径没有出问题，偏偏只在插入多行文本、且文档原本是空的时候出问题。把插入后的 <code>model.getValue()</code> 打印出来，才看见每个换行位置躺着的是 <code>\r\n</code> 而不是 <code>\n</code>。</p>
<p>根因在 <code>executeEdits</code> 内部：它用 <code>model.getEOL()</code> 来规范化插入文本里的换行。空文档的 <code>getEOL()</code> 恒为 <code>&#39;\r\n&#39;</code>，所以第一次插入三行 mermaid 模板，三行之间就被塞进了 <code>\r</code>。而 textarea 那一侧从来都是 <code>\n</code>，库里存量文章也都是 <code>\n</code>（早年编辑器留下的 CRLF 是另一路，后面单独说）。于是同一个「第 2 行行首」，两边的偏移开始分叉。</p>
<p>这里要补一句术语。偏移是 UTF-16 code unit 计数：一个普通汉字占一个 code unit，一个 emoji 占两个，而一个 <code>\r\n</code> 占两个、一个 <code>\n</code> 占一个。Monaco 的 <code>getPositionAt(offset)</code> 把偏移翻译成「第几行第几列」，<code>getOffsetAt(position)</code> 反过来翻译，两者互为逆运算——前提是它们操作的是同一份、换行符完全一致的字符串。一旦 textarea 用 <code>\n</code>、model 用 <code>\r\n</code>，这两个函数算出来的行列和 textarea 的 <code>selectionStart</code> 就再也对不上，而且差值逐行累加，越往后越离谱。</p>
<p>分叉的规律很朴素，每个 <code>\r\n</code> 比 <code>\n</code> 多一个字符，偏移就多算 1：</p>
<div class="table-wrap"><table><thead><tr><th>位置</th><th>textarea（<code>\n</code>）偏移</th><th>Monaco（<code>\r\n</code>）偏移</th><th>差值</th></tr></thead><tbody><tr><td>第 1 行末尾</td><td>11</td><td>11</td><td>0</td></tr><tr><td>第 2 行行首</td><td>12</td><td>13</td><td>+1</td></tr><tr><td>第 3 行行首</td><td>20</td><td>22</td><td>+2</td></tr><tr><td>第 4 行行首</td><td>23</td><td>26</td><td>+3</td></tr></tbody></table></div>
<p>这张表里的具体字符数是按那段 mermaid 模板手工推的，用来说明「每个换行差 1、逐行累加」这个规律；我没有在真机上逐个打印过这些偏移量，所以表中数值只到推断为止，能确定的只有差值那一列的递增规律。真正确认过的，是 <code>getValue()</code> 里出现 <code>\r\n</code>、以及 <code>inputEl.value.slice(s,e)</code> 与 Monaco 返回的文本对不上这两件事——它们都能在改动前后的对照里复现。</p>
<p>工具栏里所有需要「取一段文本再改」的操作都吃这个亏。<code>## </code>、<code>&gt; </code>、<code>- </code> 这类行首前缀往 <code>edLineStart()</code> 返回的偏移处插，Tab 键把选中行整体缩进两个空格，撤销/重做后重新算选区，全部依赖偏移和行列的一一映射。换行符一旦多出一个不可见字符，这条映射就从出错那一行起整体平移。四个适配函数各自吃偏移的方式不同，但都建立在同一个假设上：</p>
<div class="table-wrap"><table><thead><tr><th>函数</th><th>拿偏移做什么</th><th>受 CRLF 影响的环节</th></tr></thead><tbody><tr><td><code>edSelection</code></td><td><code>getOffsetAt</code> 把行列换成偏移</td><td>选区起止偏移整体平移</td></tr><tr><td><code>edReplace</code></td><td><code>getPositionAt</code> 把偏移换成行列</td><td>插入位置与回设选区错位</td></tr><tr><td><code>edSetText</code></td><td>整篇赋值，不直接吃偏移</td><td>入口是否归一决定后续是否错位</td></tr><tr><td><code>edLineStart</code></td><td><code>getOffsetAt</code> 取当前行行首</td><td>行首前缀插到错误的行</td></tr></tbody></table></div>
<p>这张表是四个函数在 <code>public/editor.html</code> 里的实际职责归纳，不是另造的分类。可以看到真正「吃偏移」的是前两个和第四个，而 <code>edSetText</code> 的作用是在最上游把文本洗对——这也解释了为什么修法必须落在 <code>edSetText</code> 入口，光在 <code>edReplace</code> 里兜是不够的。</p>
<h2 id="三-两个枚举-字面值相反"><a class="h-anchor" href="#三-两个枚举-字面值相反">#</a>三、两个枚举，字面值相反</h2>
<p>真正把坑挖深的是我第一版修法：既然 <code>getEOL()</code> 是 CRLF，那就设成 LF 好了，于是写了 <code>model.setEOL(1)</code>。结果越修越糟——插入的多行文本 <code>\r</code> 更多了。查 Monaco 的枚举定义才发现，两个名字里都带 <code>LF</code> 的常量，字面值是反的：</p>
<div class="table-wrap"><table><thead><tr><th>枚举</th><th><code>LF</code> 的值</th><th><code>CRLF</code> 的值</th><th>用途</th></tr></thead><tbody><tr><td><code>monacoApi.editor.EndOfLineSequence</code></td><td><code>0</code></td><td><code>1</code></td><td><code>model.setEOL()</code> 的参数，表示要把 model 设成哪种换行</td></tr><tr><td><code>monacoApi.editor.EndOfLinePreference</code></td><td><code>1</code></td><td><code>2</code></td><td>读值/保存时的偏好，表示按哪种换行解释文本</td></tr></tbody></table></div>
<p>我写的 <code>setEOL(1)</code> 落到了 <code>EndOfLineSequence.CRLF</code> 上，等于亲手把 model 锁进 CRLF。这里没有类型转换也没有隐式规则，就是两个枚举把 <code>LF</code> 摆在了不同的数字上：一个是 0，一个是 1。两个枚举各自内部自洽，跨着用就翻车——这是所有「字面值相反」类 bug 的通病。</p>
<p>为什么库里会存在两个几乎同名的枚举，我没有查 Monaco 的设计文档，这条只到推断为止：一个描述「model 实际存了什么换行」（Sequence，写），一个描述「读出来时按什么偏好解释」（Preference，读），职责不同所以各自编号，编号时又都以自己喜欢的值为先，于是撞出了相反的字面值。这个推断能解释现象，但成因我没有验证过，不当成事实。</p>
<p>唯一稳妥的写法是永远用枚举常量，永远不写裸数字：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// ✓ 用枚举，数字是多少不关心</span>
model.<span class="tok-f">setEOL</span>(monacoApi.editor.EndOfLineSequence.LF);

<span class="tok-c">// ✗ 写死数字：1 在 Sequence 里是 CRLF，在 Preference 里才是 LF</span>
model.<span class="tok-f">setEOL</span>(<span class="tok-n">1</span>);</code></pre></div>
<p>我把这条写进了代码注释，位置在 <code>public/editor.html:394</code>，因为这种坑一定会有人（包括几个月后的我）再踩一次。判断依据不是「文档说 0 还是 1」，而是「这个参数的类型是 <code>EndOfLineSequence</code> 还是 <code>EndOfLinePreference</code>」。写死数字的坏处不只是这次设反——它还会通过一个隐蔽的路径扩散：<code>setEOL(1)</code> 让 model 变成 CRLF，下一次 <code>executeEdits</code> 又用这个 CRLF 去规范化新插入的多行，于是 <code>\r</code> 越来越多，形成正反馈。这才是我说的「越修越糟」的真正机制，不是一次性的写错，是错误被后续操作不断放大。</p>
<h2 id="四-三处修法-各堵一类入口"><a class="h-anchor" href="#四-三处修法-各堵一类入口">#</a>四、三处修法，各堵一类入口</h2>
<p>修法落在三个入口上，每个堵一类来源，缺一个都会从别的口子漏回来：</p>
<div class="table-wrap"><table><thead><tr><th>入口</th><th>触发时机</th><th>修法</th><th>代码位置</th></tr></thead><tbody><tr><td><code>executeEdits</code></td><td>工具栏、Tab、粘贴等一切插入多行</td><td>插入后检测并压回 LF</td><td><code>public/editor.html:396</code></td></tr><tr><td><code>edSetText</code></td><td>载入草稿、切换文章、整篇赋值</td><td>入口把存量 CRLF 归一成 LF</td><td><code>public/editor.html:418</code></td></tr><tr><td><code>editor.create</code></td><td>页面初始化、空文档第一次建 model</td><td>create 后显式 <code>setEOL</code></td><td><code>public/editor.html:1588</code></td></tr></tbody></table></div>
<p>第一处是 <code>edReplace</code> 里紧跟 <code>executeEdits</code> 的那两行：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">monaco.<span class="tok-f">executeEdits</span>(<span class="tok-s">&#39;toolbar&#39;</span>, [
  { range: <span class="tok-k">new</span> monacoApi.<span class="tok-f">Range</span>(st.lineNumber, st.column, en.lineNumber, en.column), text },
]);
<span class="tok-c">/* executeEdits 用 model.getEOL() 规范化换行，而空文档的 getEOL() 恒为 CRLF
   （哪怕 getEndOfLineSequence() 已经是 LF）—— 空文档里第一次插入多行内容会带进 \r。 */</span>
<span class="tok-k">if</span> (model.<span class="tok-f">getEOL</span>() !== <span class="tok-s">&#39;\n&#39;</span>) model.<span class="tok-f">setEOL</span>(monacoApi.editor.EndOfLineSequence.LF);</code></pre></div>
<p>用 <code>model.getEOL() !== &#39;\n&#39;</code> 当判断条件，而不是无条件 <code>setEOL</code>，是为了不把已经是 LF 的正常插入也标成一次 model 改动——少一次改动，就少一次触发 <code>onDidChangeModelContent</code> 的机会。这里的固定搭配是「检测实际换行串 + 用序列枚举写回」，两件事分开做，谁都不省。省掉检测，正常的 LF 插入也会走一遍 <code>setEOL</code>；省掉枚举，就可能设反。这一行看着短，两个坑同时被它堵住。</p>
<p>第二处在 <code>edSetText</code> 入口，处理的是存量文章。库里有早年编辑器留下的 CRLF 正文，它们不经过 <code>executeEdits</code>，而是整篇灌进 textarea 和 Monaco：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">function</span> <span class="tok-f">edSetText</span>(t) {
  <span class="tok-c">// 存量文章可能是 CRLF（早年编辑器留下的），进来先统一，别再传染出去</span>
  t = <span class="tok-f">String</span>(t || <span class="tok-s">&#39;&#39;</span>).<span class="tok-f">replace</span>(/\r\n?/g, <span class="tok-s">&#39;\n&#39;</span>);
  <span class="tok-k">if</span> (inputEl.value !== t) inputEl.value = t;
  <span class="tok-k">if</span> (monaco) {
    monoSyncing = <span class="tok-k">true</span>;
    monaco.<span class="tok-f">setValue</span>(t);
    monoSyncing = <span class="tok-k">false</span>;
  }
}</code></pre></div>
<p>正则 <code>/\r\n?/g</code> 同时覆盖 <code>\r\n</code>（Windows 换行）和落单的 <code>\r</code>（老 Mac 换行），两种都归一成 <code>\n</code>。这一步放在赋值之前，保证 textarea 和 Monaco 拿到的永远是同一份、同一种换行的文本——数据源一致，偏移就不会漂。<code>monoSyncing</code> 这个布尔开关包住 <code>setValue</code>，是防止程序自己的整篇赋值又被 <code>onDidChange</code> 当成用户输入回灌一遍。</p>
<p>第三处在 <code>create</code> 之后、挂监听之前，下一节专门讲。三处合起来覆盖的时间线是：页面初始化时定基调（create 后 setEOL），载入文章时洗存量（edSetText），日常编辑时兜插入（executeEdits 后归一）。这三层分别对应「空文档」「旧数据」「新输入」，没有重叠也没有遗漏。我试过只留其中两处：留 create 和 edReplace、去掉 edSetText，存量 CRLF 文章一载入就错位；留 create 和 edSetText、去掉 edReplace，空文档点模板立刻带 <code>\r</code>。三处不是防御性冗余，是三种不同的入口各自需要的处理。</p>
<h2 id="五-create-的-defaulteol-为什么没用"><a class="h-anchor" href="#五-create-的-defaulteol-为什么没用">#</a>五、create 的 defaultEOL 为什么没用</h2>
<p>我最早想偷懒：既然 <code>create()</code> 有个 <code>defaultEOL</code> 配置项，直接在创建时传 <code>EndOfLineSequence.LF</code> 不就一劳永逸？实测不行——空文档上它不生效。原因写在 Monaco 的行为里：<code>defaultEOL</code> 只在 model 能从传入内容推断出换行时才作为默认值使用，空文档没有内容可推断，这个配置就被跳过了。换句话说，它管的是「有内容但看不出换行风格时兜个底」，管不了「压根没有内容」。</p>
<p>这条「只在能推断时才用」的行为我是从实测现象反推的，没有去翻 Monaco 源码逐行确认，属于有实验支撑的推断，还没到源码级验证。但结论是可操作的：在空文档这个场景下不能指望 <code>defaultEOL</code>，必须在 model 建好之后显式调用一次 <code>setEOL</code>。</p>
<p>可行的做法只有一条：建完 model 再显式改，而且要在挂 <code>onDidChangeModelContent</code> 监听之前改——</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">monaco = monacoApi.editor.<span class="tok-f">create</span>(host, {
  value: inputEl.value,
  language: <span class="tok-s">&#39;markdown&#39;</span>,
  <span class="tok-c">// ... 字体、行高、tab 等配置</span>
});
<span class="tok-c">/* 换行统一成 LF。create() 的 defaultEOL 在空文档上不生效
   （它只在能从内容推断时才用），只能建完 model 再显式改。
   放在挂监听之前，避免这次改动被当成用户输入。 */</span>
<span class="tok-k">try</span> {
  monaco.<span class="tok-f">getModel</span>().<span class="tok-f">setEOL</span>(monacoApi.editor.EndOfLineSequence.LF);
} <span class="tok-k">catch</span> {}
pane.classList.<span class="tok-f">add</span>(<span class="tok-s">&#39;mon-ready&#39;</span>);</code></pre></div>
<p>顺序是关键，不是风格问题。如果先挂监听再 <code>setEOL</code>，这次换行改动会触发一次 <code>onDidChangeModelContent</code>，回调里 <code>getValue()</code> 读到的已经是 LF 全文，它会把这份全文写回 textarea 并调用 <code>onInput()</code>——这轮「假用户输入」会惊动自动保存和草稿逻辑，平白制造一次不必要的写入。放在监听之前，改动发生得悄无声息，回调压根还没接上。那段 <code>try {} catch {}</code> 是兜底：<code>setEOL</code> 在某些边缘状态下可能抛（比如 model 还没就绪），这里吞掉异常即可，因为最坏情况只是没设上，还有 <code>edReplace</code> 那道兜底接着——这就是三处修法彼此形成的冗余。</p>
<p>字体和行高也在这个 <code>create</code> 配置里一起对齐，目的是切换那一刻不要有半个字的位置跳动：<code>fontSize: 14.5</code>、<code>lineHeight: 27</code>、<code>padding: { top: 22, bottom: 22 }</code>、<code>tabSize: 2</code>、<code>insertSpaces: true</code>。这些数字是从 CSS 变量和 textarea 的 <code>14.5px / 1.85 ≈ 26.8px</code> 反推来的，写死在 <code>public/editor.html:1571</code> 附近。<code>automaticLayout: true</code> 让双栏/单栏切换和窗口缩放都不用自己算尺寸，<code>scrollBeyondLastLine: false</code>、<code>minimap: { enabled: false }</code>、<code>lineNumbers: &#39;off&#39;</code> 这些开关则把 Monaco 往「像一块普通 textarea」的方向压。让 Monaco 的行高和 textarea 尽量重合，是「Monaco 只是外壳、textarea 是数据源」这个定位在视觉层的体现——两层看起来该是同一块编辑区，换行符也该是同一种。</p>
<h2 id="六-降级与代价-textarea-始终是数据源"><a class="h-anchor" href="#六-降级与代价-textarea-始终是数据源">#</a>六、降级与代价：textarea 始终是数据源</h2>
<p>接 Monaco 的代价不只在换行，还在加载链路。这套编辑器对 Monaco 的态度一直是「有它更好，没它照写」：加载脚本在 <code>initMonaco()</code> 里，任何一步失败都给 <code>.pane.left</code> 加上 <code>mon-fail</code> 类，然后原样退回 textarea，写作流程完全不受影响。失败点一共有几处：<code>loadScript</code> 抛错、<code>window.require</code> 不存在、<code>require([&#39;vs/editor/editor.main&#39;])</code> 加载失败、<code>window.monaco</code> 为空，每一处都走同一个 <code>mon-fail</code> 出口。</p>
<p>CDN 锁在 <code>https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min</code>，<code>loader.js</code> 带 SRI：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-k">const</span> MONACO_CDN = <span class="tok-s">&#39;https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min&#39;</span>;
<span class="tok-k">const</span> MONACO_LOADER_SRI =
  <span class="tok-s">&#39;sha384-pHG02SG8pId94Np3AbPmBEJ1yPqaH0IkJGLSNGXYmuGhkazT8Lr/57WYpbkGjJtu&#39;</span>;</code></pre></div>
<p>跨源加载必须同时给 <code>crossOrigin = &#39;anonymous&#39;</code>，否则 <code>integrity</code> 会被浏览器直接忽略，SRI 等于白写：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">s.integrity = integrity;
s.crossOrigin = <span class="tok-s">&#39;anonymous&#39;</span>; <span class="tok-c">// 跨源没有它，integrity 直接被忽略</span>
s.onload = resolve;
s.onerror = () =&gt; <span class="tok-f">reject</span>(<span class="tok-k">new</span> <span class="tok-f">Error</span>(<span class="tok-s">&#39;加载失败：&#39;</span> + src));</code></pre></div>
<p>SRI 这道防线只覆盖 <code>loader.js</code> 这一条手动插入的 <code>&lt;script&gt;</code>。浏览器拿到 <code>integrity</code> 后会用 <code>sha384</code> 比对实际字节，不一致就拒绝执行，于是 CDN 上这一份文件被篡改也过不了关。但 <code>crossOrigin=&#39;anonymous&#39;</code> 是前置条件——跨源脚本默认不带 CORS 凭据，浏览器出于同源策略会直接跳过完整性校验，所以少写这一行，SRI 就静默失效，看起来配了其实没配。</p>
<p>这里有个绕不开的限制：AMD 加载器拉起的子模块拿不到这条 SRI。<code>loader.js</code> 这一条能被校验，是因为它是我手动插 <code>&lt;script&gt;</code> 加载的；后面 <code>require([&#39;vs/editor/editor.main&#39;])</code> 拉起来的几十个子模块走的是 AMD 自己的路径，<code>integrity</code> 管不到它们。Monaco 的 loader 模式天生如此。我能做的只有把版本号写死到 <code>0.52.2</code>——锁住版本，就等于锁住子模块的内容，把「内容被换掉」这个风险转嫁给「版本号不变」这个前提。这条没做独立验证，只是按锁版本号的常规做法推断，真要验证得比对该版本所有子模块的哈希，我没测，只到推断为止。</p>
<p>worker 是另一个必踩的坑。markdown 没有语言服务，但 Monaco 基础 worker 仍可能被要一次；默认它会去同源的 <code>/vs/base/worker/workerMain.js</code> 找，那个路径本站不存在，控制台会一直报 404。解法是用 blob 包一层 <code>importScripts</code> 指回 CDN：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">window.MonacoEnvironment = {
  <span class="tok-f">getWorkerUrl</span>() {
    <span class="tok-k">const</span> code =
      <span class="tok-s">&#39;self.MonacoEnvironment={baseUrl:&#39;</span> +
      JSON.<span class="tok-f">stringify</span>(MONACO_CDN + <span class="tok-s">&#39;/&#39;</span>) +
      <span class="tok-s">&#39;};importScripts(&#39;</span> +
      JSON.<span class="tok-f">stringify</span>(MONACO_CDN + <span class="tok-s">&#39;/vs/base/worker/workerMain.js&#39;</span>) +
      <span class="tok-s">&#39;);&#39;</span>;
    <span class="tok-k">return</span> URL.<span class="tok-f">createObjectURL</span>(<span class="tok-k">new</span> <span class="tok-f">Blob</span>([code], { type: <span class="tok-s">&#39;text/javascript&#39;</span> }));
  },
};</code></pre></div>
<p>这个 blob 的巧妙之处在于：worker 脚本本身是同源的（blob URL 挂在本站 origin 下），不受跨源限制，但它内部 <code>importScripts</code> 的地址指向 CDN，而 CDN 带 CORS 头，于是真正的 worker 代码从 CDN 拉取成功。一个 404 反复刷屏的问题，靠一层两行的转发就消掉了。这里的判断依据是控制台里反复出现的 404 路径——先看见它去 <code>/vs/...</code> 找，才想到要用 <code>getWorkerUrl</code> 改指向，不是凭空加的配置。</p>
<p>粘贴图片那块也跟着改了。Monaco 是另一个 DOM 树，它自己藏了一个 textarea 当事件目标，原来绑在正文 textarea 上的 <code>paste</code> 监听收不到 Monaco 里的粘贴。于是把监听挪到 <code>document</code> 上，再用 <code>closest(&#39;.pane.left&#39;)</code> 限定只在正文编辑区生效，标题和摘要框里粘图仍走浏览器默认行为：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">document.<span class="tok-f">addEventListener</span>(<span class="tok-s">&#39;paste&#39;</span>, <span class="tok-k">async</span> (e) =&gt; {
  <span class="tok-k">const</span> inBody = e.target.closest &amp;&amp; e.target.<span class="tok-f">closest</span>(<span class="tok-s">&#39;.pane.left&#39;</span>);
  <span class="tok-k">if</span> (!inBody) <span class="tok-k">return</span>;
  <span class="tok-k">const</span> items = [...(e.clipboardData?.items || [])];
  <span class="tok-k">const</span> img = items.<span class="tok-f">find</span>((i) =&gt; i.type.<span class="tok-f">startsWith</span>(<span class="tok-s">&#39;image/&#39;</span>));
  <span class="tok-k">if</span> (img) { e.<span class="tok-f">preventDefault</span>(); <span class="tok-k">await</span> <span class="tok-f">uploadFile</span>(img.<span class="tok-f">getAsFile</span>()); }
});</code></pre></div>
<p>绑到 <code>document</code> 而不直接绑到 Monaco 的隐藏 textarea，是因为那个元素是 Monaco 内部生成的、没有稳定 id，等我去绑的时候它未必已经存在。事件委托到 <code>document</code> 上则不存在时序问题，代价是每次粘贴都要多做一次 <code>closest</code> 判断——这个开销可以忽略。链接到正文编辑区的判断用 <code>.pane.left</code> 这个容器，和 <code>initMonaco()</code> 里判断挂载位置用的是同一个选择器，两处保持一致，不会出现「Monaco 挂在这、粘贴判断那」的错位。</p>
<p>所有这一切能成立，前提是 textarea 始终是唯一数据源。保存、自检、草稿读取，全部读 <code>inputEl.value</code>；Monaco 的 <code>onDidChangeModelContent</code> 回调只做一件事——把 <code>getValue()</code> 整篇写回 <code>inputEl.value</code>，再调 <code>onInput()</code>：</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js">monaco.<span class="tok-f">onDidChangeModelContent</span>(() =&gt; {
  <span class="tok-k">if</span> (monoSyncing) <span class="tok-k">return</span>;
  <span class="tok-k">const</span> v = monaco.<span class="tok-f">getValue</span>();
  <span class="tok-k">if</span> (inputEl.value !== v) inputEl.value = v;
  <span class="tok-f">onInput</span>();
});</code></pre></div>
<p>我选的是整篇写回而不是增量打补丁，因为 <code>onInput</code> 只读 <code>value</code>，增量同步既没收益，又要自己处理撤销/重做与光标，出错面大得多。适配器就四个函数：<code>edSelection</code>、<code>edReplace</code>、<code>edSetText</code>、<code>edLineStart</code>，工具栏、Tab、滚动同步、粘贴全走它们；双栏滚动同步因为 Monaco 是另一个滚动容器，还单独接了一条 <code>onDidScrollChange</code>。这层薄薄的适配把「Monaco 是不是加载成功」和「正文逻辑怎么跑」彻底解耦——换行坑再深，也只在这四个函数里发作，不会渗到保存和发布链路。这也是为什么我敢让 Monaco 可降级：它从来就不是不可替代的那一层。</p>
<p>这篇里我没做两件事，说清楚边界。一是没有去改 Monaco 的枚举或 <code>executeEdits</code> 行为——库是 CDN 上的成品，改它就得自己维护一份 fork，代价远大于在应用层堵三处，所以选择在适配层解决。二是没有跨版本验证：结论建立在锁定的 <code>monaco-editor@0.52.2</code> 上，换一个版本，<code>getEOL()</code> 的空文档行为和两个枚举的字面值都可能变，那套验证脚本得重跑一遍才能作数。这两条都属于「没测，只到推断或选择为止」，不当成普适规律讲。</p>
<h2 id="怎么自己验一遍"><a class="h-anchor" href="#怎么自己验一遍">#</a>怎么自己验一遍</h2>
<p>下面这套是我自己在真机上跑过的顺序，对应 2026-11-22 那次提交。环境：本站 <code>/editor</code> 页面，浏览器控制台开着，CDN 用 <code>monaco-editor@0.52.2</code>。</p>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">bash</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-bash"><span class="tok-c"># 1. 确认挂载成功：左栏应该有 mon-ready 类，而不是 mon-fail</span>
<span class="tok-c">#    控制台执行：</span>
document.<span class="tok-f">querySelector</span>(<span class="tok-s">&#39;.pane.left&#39;</span>).className</code></pre></div>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 2. 空文档下直接看两个枚举的分叉（这就是主角）</span>
<span class="tok-k">const</span> m = monaco.<span class="tok-f">getModel</span>();
console.<span class="tok-f">log</span>(m.<span class="tok-f">getEOL</span>(), m.<span class="tok-f">getEndOfLineSequence</span>());
<span class="tok-c">// 期望：&#39;\r\n&#39; 与 0 —— 两者不一致即复现</span>
console.<span class="tok-f">log</span>(monacoApi.editor.EndOfLineSequence.LF);   <span class="tok-c">// 0</span>
console.<span class="tok-f">log</span>(monacoApi.editor.EndOfLinePreference.LF); <span class="tok-c">// 1</span></code></pre></div>
<div class="code-wrap"><div class="code-head"><span class="code-meta"><span class="code-lang">js</span></span><button class="copy-btn">复制</button></div><pre class="code-block"><code class="language-js"><span class="tok-c">// 3. 修好以后：空文档插多行，再取全文，不该有 \r</span>
<span class="tok-c">//    先点 mermaid 模板按钮，再在控制台执行：</span>
<span class="tok-k">const</span> v = monaco.<span class="tok-f">getValue</span>();
console.<span class="tok-f">log</span>(/[\r]/.<span class="tok-f">test</span>(v)); <span class="tok-c">// 期望 false</span>
console.<span class="tok-f">log</span>(document.<span class="tok-f">querySelector</span>(<span class="tok-s">&#39;textarea&#39;</span>).value === v); <span class="tok-c">// 期望 true</span></code></pre></div>
<p>手工清单，按这个顺序点一遍：</p>
<div class="table-wrap"><table><thead><tr><th>步骤</th><th>操作</th><th>通过的标志</th></tr></thead><tbody><tr><td>1</td><td>打开 <code>/editor</code>，确认左栏挂载</td><td>出现 <code>mon-ready</code>，无 <code>mon-fail</code></td></tr><tr><td>2</td><td>空文档点 mermaid 模板</td><td>光标停在模板末尾，不飘行</td></tr><tr><td>3</td><td>再点 <code>## </code> / <code>&gt; </code> / <code>- </code> 行首按钮</td><td>插入位置正确，不落到上一行</td></tr><tr><td>4</td><td>选中多行按 Tab</td><td>每行缩进 2 空格，无 <code>\r</code></td></tr><tr><td>5</td><td>载入一篇存量 CRLF 文章</td><td>全文归一成 <code>\n</code>，偏移不错位</td></tr><tr><td>6</td><td>预览 mermaid 图</td><td>正常渲染（<code>securityLevel:&#39;strict&#39;</code>）</td></tr><tr><td>7</td><td>断网/拦掉 loader.js 后刷新</td><td>出现 <code>mon-fail</code>，textarea 仍可写可存</td></tr></tbody></table></div>
<p>这套清单在真机跑的结果是 <strong>11/11 全过</strong>，覆盖挂载、同步、工具栏、2 空格缩进、预览 mermaid 这几类；Mermaid 和换行归一是同批上线。11 项比我上面列的 7 步要细，多出来的部分是同步链路和保存回读的逐项检查，这里不逐条展开，只说结论：没有一项因为换行归一而回退。我另外试过把 <code>setEOL(1)</code> 写回去的错误版本，第 2、3、4 步立刻失败，但那条不是回归用例，只是手动对照，没有计入 11 项。</p>
<p>要复现我踩的坑，最简单的一步是把 <code>public/editor.html:396</code> 那行 <code>if (model.getEOL() !== &#39;\n&#39;) model.setEOL(...)</code> 注释掉，再从空文档点一次 mermaid 模板，控制台执行 <code>/\r/.test(monaco.getValue())</code>——会变成 <code>true</code>。反过来，把 <code>setEOL</code> 的参数从枚举换成裸 <code>1</code>，会看到 <code>\r</code> 不减反增。两条都亲测过，不是纸上推演。改完记得把那行恢复回去，再跑一遍第 2 到第 4 步确认回归。</p>
<p><a class="tag-inline" href="/tag/editor">#editor</a> <a class="tag-inline" href="/tag/javascript">#javascript</a> <a class="tag-inline" href="/tag/debugging">#debugging</a></p>', '', 'log', '空文档的 model.getEOL() 恒为 CRLF，第一次插入多行模板就把 \r 带进正文；工具栏偏移按 UTF-16 算，每个换行差 1 字符。更坑的是 EndOfLineSequence.LF=0、EndOfLinePreference.LF=1，写死 setEOL(1) 越修越糟。三处修法 + textarea 仍是数据源。',
        '', 0, 0, 0, 1, '2027-02-03 01:00:00', datetime('now'), datetime('now'));

INSERT INTO tags (name) VALUES ('editor') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'monaco-eol-crlf' AND t.name = 'editor';
INSERT INTO tags (name) VALUES ('javascript') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'monaco-eol-crlf' AND t.name = 'javascript';
INSERT INTO tags (name) VALUES ('debugging') ON CONFLICT(name) DO NOTHING;
INSERT INTO post_tags (post_id, tag_id)
  SELECT p.id, t.id FROM posts p, tags t WHERE p.slug = 'monaco-eol-crlf' AND t.name = 'debugging';
