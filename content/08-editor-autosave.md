## 结论

"停手三秒自动保存"拆开是两个问题：**什么时候存**（防抖）和**存到哪**（双写）。整套东西连同注释两百行上下，没有框架，浏览器原生 API 全家桶。但正确性全靠四个边界条件撑着，写错任何一个，丢的都是自己的稿子。

本站写作端是自建编辑器（[关于我](/p/about) 里提过）。自动保存是里面第一个"真做成了"的模块，这篇按实现顺序拆。

## 三层，各堵一类事故

用第三方平台的那些年，我对写作工具的全部要求就一条：别让我丢东西。轮到自己写，这条需求拆成三层：

| 层 | 堵什么 | 时机 |
|---|---|---|
| localStorage 直写 | 误关标签页、浏览器崩溃、断电 | **每次输入，不防抖** |
| 云端保存 | 换设备继续写、本地缓存被清 | 停手 3 秒（防抖） |
| `Ctrl/Cmd + S`、`Ctrl/Cmd + Enter` | 写完最后一句立刻要走 | 立即执行，跳过防抖 |

本地那份是主力，云端是低频镜像。这个优先级决定了下面第一个反常识的选择。

## 一、本地那份不防抖，故意的

新手写法是先给本地也套个防抖。我最后没套，理由是算了一下成本：

`localStorage.setItem` 是同步写，5KB 级别的草稿一次在 1ms 以内。而防抖的作用是把"已经打进内存的字"推迟落盘——推迟的那几百毫秒，正好是崩溃、断电、手滑关标签页最可能发生的窗口。收益是省 1ms，代价是扩大丢稿窗口，这笔账不划算。

所以 `onInput` 里直接落，一行注释写死这个决定：

```js
function onInput() {
  dirty = true;
  rev++;                // 版本号：判断一次保存响应是否已过期（下面会用到）
  saveLocal();          // 每次输入即写 localStorage
  schedulePreview();
  scheduleSave();       // 停顿 3 秒落库
}
```

外面再包两道保险，覆盖"输入没触发 `input` 事件"的场景：

```js
// 切到后台时先把本地草稿写死（手机切 App、切标签页都不触发 input）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty) saveLocal();
});

window.addEventListener('beforeunload', (e) => {
  saveLocal();                       // 关页面前最后落一次
  if (dirty) { e.preventDefault(); e.returnValue = ''; }   // 再问一句
});
```

`beforeunload` 里那个 `preventDefault` 是给云端用的：本地已经安全了，但云端可能还差一次 PUT，这时候弹"离开此网站？"至少给人一次按 `Ctrl+S` 的机会。

## 二、云端这条必须防抖，而且只能有一个句柄

云端每次写都是一次 D1 行写入。每键一次 PUT，等于用自己的额度打自己的 Worker。所以云端一路走防抖，且**全局只有一个计时器**：

```js
function scheduleSave() {
  clearTimeout(saveTimer);          // saveTimer 是模块级单例
  setState('', '编辑中…');
  saveTimer = setTimeout(() => saveNow(false), 3000);
}
```

所有输入源共用它（标题、正文、slug、栏目、系列、私密/隐藏开关都指向同一个 `onInput`）。多句柄的问题不是"写两份"，而是**后触发的那个会把先触发的清掉**：改完标题改正文，标题那次计时器被正文的 `clearTimeout` 干掉了，结果只有正文进云端，标题改动等下一次按键。单例，一行 `clearTimeout` 就干净了。

**坑一：请求在飞的时候，用户还在打字。**

`saveNow` 原来的结尾是这么写的：

```js
    await api('/api/posts/' + postId, { method: 'PUT', body: payload });
    dirty = false;        // ✗ 不管这期间用户敲了多少字，一律标成"干净"
    saveLocal();
```

PUT 走公网，慢的时候一两秒。这两秒里用户完全可以再敲二十个字——`onInput` 把 `dirty` 置 `true`、排了个新计时器，然后旧响应回来，`dirty = false` 一刀切。3 秒后新计时器触发 `saveNow(false)`，第一句 `if (!dirty) return` 直接退出。**最后那二十个字只存在于 localStorage，云端永远是旧的**，而且不会有任何报错提示。本地保险救了稿子，但"换设备继续写"这条需求悄悄失效了。

修法是把 `dirty` 从布尔值升级成"带版本的布尔值"：

```js
let rev = 0;                       // 每次输入 +1

async function saveNow(manual = false) {
  clearTimeout(saveTimer);
  if (saving) { scheduleSave(); return; }   // 坑二，见下
  if (!dirty && !manual) return;
  saving = true;
  const myRev = rev;               // 出发时拍个快照
  ...
  // 响应回来：中间又改过就别清 dirty，这份响应已经过期
  if (rev === myRev) {
    dirty = false;
  } else {
    scheduleSave();                // 重新排队，把最新的再发一次
  }
```

**坑二：`if (saving) return` 会吞掉请求。**

同一个地方还有个更隐蔽的：3 秒计时器触发时，如果上一次保存还在飞，`saveNow` 第二句 `if (saving) return` 就地退出。计时器已经烧掉了，不会重排——这次改动就挂在 `dirty = true` 上等着，直到用户**再敲一个字**才会重新开始倒计时。用户停手去泡茶，云端就一直停在旧版本。

一行修掉：正在存就把自己重新排进队列，而不是消失。

```js
  if (saving) { scheduleSave(); return; }
```

顺带把入口的 `clearTimeout(saveTimer)` 加上：手动保存时把排队中的定时器收掉，不然保存成功后 3 秒还会空跑一次 `saveNow(false)`（被 `!dirty` 挡掉，但状态栏会闪一下"编辑中…"）。

## 三、存到哪：一个 id 一个柜子

本地存储不是草稿箱，是个扁平键值柜。所有文章共用一个 key 的话，开第二篇新建页会把第一篇的在途草稿直接冲掉。解法朴素到不值得起标题——按 id 分 key：

```js
let draftKey = 'draft:new';        // 还没落过库的新文章统一叫 new
// 打开已有文章时：
draftKey = 'draft:' + postId;
```

真正容易漏的是**新建那一下**。`/editor` 打开时 key 是 `draft:new`，第一次 `POST` 成功拿到 id 之后，如果只改 `postId` 不改 key，这篇的草稿还躺在 `new` 那个柜子里，下次用 `?id=7` 进来读 `draft:7` 是空的——"新建的第一篇永远恢复不了"。所以保存成功的第一时间要做一次搬家：

```js
      postId = res.id;
      const old = draftKey;
      draftKey = 'draft:' + postId;
      const d = readLocal(old);
      if (d) {
        localStorage.setItem(draftKey, JSON.stringify({ ...d, id: postId }));
        localStorage.removeItem(old);        // 搬完再扫地，顺序不能反
      }
      history.replaceState(null, '', '/editor?id=' + postId);
```

存的内容是整套表单而不是只有正文——标题、正文、slug、栏目、系列、序号、私密、隐藏，外加一个 `at: Date.now()`。这个时间戳既是右下角状态回显的依据，也是下面仲裁时的关键证据。

## 四、恢复：谁的时间新听谁

草稿存两份之后，新问题反过来出现：打开编辑器时看哪份？

```js
      const d = readLocal(draftKey);
      const serverTime = new Date(String(p.updated_at).replace(' ', 'T') + 'Z').getTime();
      if (d && d.at > serverTime + 1000 && (d.title !== p.title || d.content !== p.content)) {
        applyDraft(d);
        dirty = true;
        setState('', '已恢复本地草稿');
        toast('已恢复未同步的本地草稿');
      } else {
        setState('', '已同步');
      }
```

三个细节：

1. **`+1000` 的容差**：`updated_at` 是 D1 的秒级时间戳，本地 `Date.now()` 是毫秒。不加容差，刚保存完重进页面会误判"本地更新"，每次都弹一次恢复提示。
2. **双重条件**：时间新还不够，内容必须确实不同。否则"保存成功 → 本地被 `saveLocal()` 覆盖成同一份 → 重进页面"这个正常路径也会被判成有未同步改动。
3. **过期的那份不删**。云端更新时只是不采用本地草稿，`removeItem` 只在删除文章时执行。理由是删错了没处找回，留着只是一段不会再被读到的 JSON。

## 五、失败怎么办：目前没有队列，只有一行红字

这里要老实交代一个缺口。现在的 catch 分支只做两件事：

```js
  } catch (e) {
    setState('error', e.message || '保存失败');
    toast(e.message || '保存失败');
  }
```

没有 `pending` 数组、没有 `online` 事件重放。断网时改的东西只进 localStorage，用户如果不看状态栏就不会知道云端没存上。

没补队列的理由是：**本地草稿本身就是队列**，而且比内存里的数组可靠（浏览器崩溃后还在）。断网 → 本地照写 → 下次任何输入都会重新触发保存 → 联网后第一次 `input` 就把最新全量 PUT 上去。代价是"离线写完直接关机"这个场景，云端那份会停在旧版本。这个缺口我记着，等到真被它坑一次再补——在它上面加 `online` 监听，二十行的事。

## 六、额度这笔账

Cloudflare D1 免费档每天 10 万行写入，超了请求直接失败（不是静默限流，这跟我在 [D1 踩坑篇](/p/d1-no-such-table) 里撞的那批事故是同一个脾气：报错，不糊弄）。

一次自动保存写 1 行 posts 记录。就算一天泡在编辑器里 8 小时、平均每分钟触发一次，也才 480 次——离上限差两个数量级。写满额度需要一天存 10 万次，那不是写作，是压力测试。真正吃额度的是别的东西：定时任务每 20 分钟的友链巡检（见 [这篇](/p/worker-cron-friend-check)），一次巡检就要写几十行。

## 七、验收方式

不是"看起来在跑"，而是把事故挨个演一遍：

- 打字打到一半强杀标签页 → 重进，草稿带时间戳回来；
- DevTools 切离线继续写 → 恢复在线后随便敲一个字，云端追平（注意：靠的是下一次输入，不是自动重放，见第五节）；
- 两篇草稿并行编辑 → 各自的 key 谁也不碰谁；
- 手动 `Ctrl+S` 时正在保存 → 状态栏不能卡在"保存中…"，且后续改动仍会落库。

第四个场景就是坑一和坑二的回归用例，改之前我拿它复现了两次。

## 下一篇

拆这个编辑器的另一块：**实时预览**——左边敲 Markdown 右边出效果，为什么用几十行的 `md.js` 而不是引 marked / markdown-it，以及自研渲染器必须过的 XSS 关（代码块里的 `<script>` 被转义成什么样，贴真实输出）。

#javascript #cloudflare #d1
