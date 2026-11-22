## 结论

CI 从 commit `76afc15` 起连续 4 次 failure，红的都是 check job 的「单元测试」步骤，报错落在 `public/app.js`：integrity 与磁盘文件不一致。browser job 同期一次没红。我把这当成一次 `sri integrity 不匹配` 去查，翻 SRI 的写法、`crossorigin`、哈希生成顺序，方向从一开始就错了。

根因不在 SRI 配置，在行尾。关键证据是一条命令的输出：`git ls-files --eol` 对 `app.js` 给出 `i/lf w/crlf`——git 索引里是 LF，工作区磁盘上是 CRLF。参与 SRI 的 14 个文件里，其余 13 个都是 LF，只有它一个是 CRLF。

这一列差异让三个环境跑出两种字节。`build:sri` 按工作区的 CRLF 字节算哈希，部署上去的也是这份 CRLF，本地自洽、线上 `check:live` 也绿；CI checkout 按 `.gitattributes` 的 `* text=auto eol=lf` 拿到 LF，同一个文件的哈希立刻对不上，单元测试红。报错文案里那个「磁盘」，在我本地和 CI 里指的不是同一份字节。

我把工作区 20 个 `w/crlf` 文件全部转成 LF（git 索引本来就是 LF，转完 `git diff` 里看不到它们），`app.js` 的哈希随字节变化，重新部署后线上字节复算 sha384 与 manifest 一致。验收点是 commit `ff4ec1e`、CI run `44927254879`，结果 success。

这类问题的教训一句话：Windows 上任何「按内容算哈希」的东西，先确认工作区行尾等于 git 索引行尾，否则你算的是本地那一份，CI 验的是另一份。我在 `build-sri.mjs` 和 `test-sri.mjs` 各加了一道防线，下面把误判过程、两道防线的取舍、以及为什么 browser job 一直绿写清楚。这个站的整体结构（单 Worker + Static Assets）写在[Worker 博客的整体架构](/p/workers-blog-pillar)。

## 一、第一反应是查 SRI，方向就错了

先交代背景，免得误判显得没来由。站点之前用 `?v=<Date.now()>` 当版本号，每次部署都变；`build-sri.mjs` 的注释里算过这笔账——哪怕只改一行文档，全站 CSS/JS 的 URL 也跟着变，用户每次发版都要重下 **121KB** 的 `style.css`，一年强缓存形同虚设。现在 `?v=` 换成内容哈希（sha256 前 10 位），`scripts/build-sri.mjs` 读 `public` 下的 js/css 生成 `src/assets.gen.js`，同一份字节再出 `integrity="sha384-…"`。规矩是改了 public 里的 js/css 必须跑 `npm run build:sri`，否则「单元测试」会报 manifest 与磁盘不同步。

我当时的排查路径可以完整记下来，因为它典型。先看 `integrity` 的属性拼法：源码里 `stampAssets` 把 manifest 的 `i` 字段原样写进 `integrity="…"`，前缀 `sha384-` 也是固定的，没有拼错的空间。再看 `crossorigin`：站内同源资源刻意不加，`test-sri.mjs` 里专门有一条「同源资源不加 crossorigin（加了会被 CORS 拦死）」在守着，不会突然多出来。第三条看 `?v=` 与 `integrity` 的来源：两条都是 `createHash` 吃同一份 `buf` 算出来的，同源断言一直绿。三条路全堵死，说明 SRI 这段代码没问题，出问题的只能是它读到的那份字节。

所以 CI 报 `public/app.js` 的 integrity 与磁盘不一致时，我的第一反应是：是不是有人改了 app.js 忘了跑 `build:sri`。这判断看起来很合理，因为报错文案本身就是这个意思——`test-sri.mjs` 里那条断言写的是 `不同步：${bad.join('、')}（跑 npm run build:sri）`，落到这次就是 `不同步：app.js（跑 npm run build:sri）`。

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
git ls-files --eol | grep 'w/crlf'
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
node -e "const fs=require('fs');for(const f of ['public/app.js']){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n'))}"
```

这条命令就是 `build-sri.mjs` 在硬失败时打印给开发者的那条（它会把检测到的文件列表填进数组）。转完以后跑 `git diff`，这 20 个文件一个都不出现——因为它们的内容在 git 索引里本来就是 LF，我把工作区对齐回去，等于让工作区回到索引的样子。这一点很重要：如果 `git diff` 里冒出大片改动，说明转写方式不对，得停下来看。

两步的顺序为什么不能反？假设先重建 manifest 再转行尾：manifest 记的还是 CRLF 哈希，转完之后磁盘变成 LF，CI 立刻报不一致，等于白跑一趟。反过来先转行尾、先不重建，CI 也会报 manifest 与磁盘不一致，但这时报错的方向是对的——它指向「manifest 该重算了」，而不是「字节来源不对」。两种错误的形状不一样，后者一眼能看出下一步该做什么。

第二步，`app.js` 的字节从 CRLF 变成 LF，内容哈希必然变，`?v=` 和 `integrity` 都跟着变。这时候必须跑 `npm run build:sri` 重新生成 `src/assets.gen.js`，然后重新部署，让线上 Static Assets 拿到 LF 版本。部署完在线上把字节 curl 回来复算 sha384，结果等于新 manifest 里的 `i` 字段，这一步才算完。只改工作区不重建 manifest，CI 会报另一种不一致；只重建 manifest 不重新部署，线上 SRI 会直接崩。线上复算这一步我用的是最笨的办法：curl 回来、算摘要、转 base64、和 manifest 里的 `i` 字段逐字比。没有比这更可靠的验证——它验的不是配置、不是代码，是浏览器真正会拿到的那串字节。写进 HTML 的 `integrity` 一旦和浏览器实际收到的字节对不上，脚本会被整个丢弃，页面白屏且控制台只有一行提示。所以「manifest 自洽」不等于「线上正确」，必须拿线上字节再验一次。

这里要说清一个容易做错的选择：为什么构建脚本不能「静默归一」——也就是读文件时把 `\r\n` 替换成 `\n`，再拿归一后的字节算哈希。看上去很省事，但它会造出一个更隐蔽的故障：manifest 按 LF 算，但部署上传的是工作区那份没被改过的 CRLF 文件，浏览器按 CRLF 字节算 sha384，和 manifest 对不上，线上脚本被整个丢弃。本地测试还是绿的，因为测试读的也是被归一后的假字节。这个坑一旦踩进去，比 CI 红更难查——CI 红至少会拦住发版，线上 SRI 崩是直接白屏。

所以我的选择是硬失败：构建脚本发现 CRLF 就退出，把转换命令打出来，逼着人去修工作区的真实字节。宁可让发版卡在这里，也不能让一份和线上字节脱钩的 manifest 溜出去。

## 五、两层防线：构建时硬失败 + 测试直读磁盘

第一层在 `scripts/build-sri.mjs`。它在循环里读每个文件的原始字节，检查是否含 `\r\n`，收集到列表后统一报错退出：

```js
if (buf.includes('\r\n')) crlf.push(f);
```

```js
if (crlf.length) {
  console.error(`[sri] 这些文件是 CRLF 行尾，哈希会与仓库里的 LF 版本对不上：`);
  for (const f of crlf) console.error(`  public/${f}`);
  console.error(`[sri] 转成 LF 再跑：` +
    `node -e "const fs=require('fs');for(const f of ${JSON.stringify(crlf.map((f) => 'public/' + f))}){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\\r\\n/g,'\\n'))}"`);
  process.exit(1);
}
```

注意检查发生在算哈希之前，且用的是 `readFileSync` 返回的原始 Buffer，不做任何替换。这是唯一还能阻止错误传播的时刻：一旦让 CRLF 字节进了 `createHash('sha384').update(buf)`，manifest 就已经脏了，后面所有基于 manifest 的自洽检查都会替它背书。`crlf` 这个数组在循环里边读边收，等 14 个文件全过一遍再统一报错，好处是一次能把所有违规文件列出来，不用修一个跑一次。报错里直接给出可复制的转换命令，把「发现问题」和「怎么修」放在同一个输出里，省得再翻文档。这段是我在 11-22 这次事故之后加的；事故当时没有这道检查，所以 CRLF 文件被安安静静算进了 manifest。

第二层在 `scripts/test-sri.mjs` 末尾，是一条直接读磁盘字节的断言：

```js
t('参与 SRI 的文件都是 LF 行尾（与仓库索引一致）', () => {
  const offenders = Object.keys(ASSET_HASH).filter((f) =>
    readFileSync(join(PUB, f), 'utf8').includes('\r\n')
  );
  assert.deepEqual(offenders, [], `CRLF：${offenders.join('、')}`);
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
git ls-files --eol | grep 'w/crlf'
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
node -e "const fs=require('fs');for(const f of ['public/app.js']){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n'))}"
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

**6. 确认防线已就位。** 在 `build-sri.mjs` 里能看到 `if (buf.includes('\r\n')) crlf.push(f)` 和 `process.exit(1)` 分支；在 `test-sri.mjs` 末尾能看到 `t('参与 SRI 的文件都是 LF 行尾（与仓库索引一致）', …)`。少任何一条，下次同样的事故都会重演。

#cloudflare #javascript #testing #debugging
