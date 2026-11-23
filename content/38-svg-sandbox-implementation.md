## 结论

[R2 图片链路那篇](/p/r2-image-pipeline)写到 SVG 时，贴了加固前后的响应头，然后跳过了实现本身——"沙箱实现长什么样、为什么要同时判 content-type 和扩展名、为什么用户上传的 SVG 和自家占位图用同一条 CSP"。这三件事比响应头本身更值得写，因为响应头只是结果，判断逻辑才是能抄走的东西。

一句话概括修法：**SVG 是文档不是图片，贴进 `<img>` 时浏览器会沙箱化它，单独打开时不会**——同一份字节，两种执行上下文。加固是在 `/img/` 出口按类型加响应头，把"单独打开"这个上下文也降级成"只能看"。桶里的文件一个字不改。

实现只有十几行，但里面有三个判断是踩过坑才定下来的，下面逐条拆。

## 一、现象：一份合法的 SVG，能在站点 origin 上跑脚本

`/img/` 是本站所有图片的代理出口。上传走 R2 预签名直传，读取一律走这个代理——不给直链的理由在[图片链路那篇](/p/r2-image-pipeline)里说过，主要是缓存口径和换存储时可搬迁。

`IMAGE_TYPES` 里留着 `image/svg+xml`，因为矢量图对技术文章有真实用处：流程图、架构图、坐标轴，放大不糊，体积还小。

问题在于 SVG 同时是 XML 文档。浏览器用 `<img src="x.svg">` 加载时，会把它当图片处理，脚本不执行；但**直接访问 `https://exia.de5.net/img/u/xxx.svg`** 时，浏览器按文档渲染，里面的 `<script>` 就跑，而且 `location.origin` 是本站。

写这篇之前，出口的响应头是这样的：

```http
HTTP/1.1 200 OK
Content-Type: image/svg+xml
Cache-Control: public, max-age=31536000, immutable
x-content-type-options: nosniff
x-frame-options: DENY
```

看着挺严，其实两个头都没挡住这件事：

| 头 | 挡什么 | 为什么不挡 SVG 脚本 |
|---|---|---|
| `nosniff` | 浏览器按声明的类型解释，不猜 | content-type 本来就是对的 `image/svg+xml`，没什么可猜 |
| `x-frame-options: DENY` | 禁止被 iframe 嵌 | 脚本是**顶层导航**执行的，不是被嵌 |

我传了一个带 `<script>document.title="SVG_RAN"</script>` 的测试文件上去，直开，标题真的变了。

攻击链接起来是这样：

```text
/api/upload-url 的门槛是 requireUser —— 任何登录用户都能上传
→ 上传拿到 /img/u/xxx.svg
→ 把链接发给管理员，诱导点开
→ 脚本在 https://exia.de5.net 这个 origin 上执行
→ 调同源接口：发文章、封 IP、读评论里的 IP，全都可以
```

会话 cookie 是 `HttpOnly` 的，偷不走。但**根本不需要偷**——脚本在同源上下文里，`fetch` 自动带上 cookie，直接就能调接口。这是存储型 XSS 的标准形态，只是入口不是文本，是文件类型。

和[渲染器那篇](/p/editor-markdown-xss)的差别值得说清：那篇防的是"文本里的标签被当标签执行"，靠转义；这里转义完全不管用，因为文件本身就是合法的 `image/svg+xml`，一个字符都不用改。**转义管文字，沙箱管文件类型**，两条路各自堵各自的洞。

## 二、修法：在出口加 CSP，桶里文件不动

实现在 `src/index.js` 的 `imageResponse()` 里，加在原有类型处理之后、`Response` 构造之前：

```js
/* SVG 是文档不是图片：直接访问这个 URL 时浏览器会执行里面的 <script>，
   而这个 URL 跟站点同源（贴进 <img> 时没事，单独打开就成了一次存储型 XSS）。
   sandbox + default-src 'none' 把它降级成只能看：脚本不跑、外部资源不加载、
   顶层导航被禁。key 的扩展名也认一遍 —— content-type 不可信，两个判据取并集。 */
const isSvg = ct === 'image/svg+xml' || ext === 'svg';
if (isSvg) {
  if (ct !== 'image/svg+xml') {
    /* key 说 svg、元数据说别的：以 key 为准。内容是矢量图时按 image/png 发出去
       会渲染失败，而按 svg 发最多是「多加了沙箱」，两种错法的代价差一个数量级。 */
    ct = 'image/svg+xml';
  }
  headers.set('content-type', ct);
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  headers.set('content-disposition', 'inline');
}
```

三行响应头，各有分工：

| 头 | 作用 |
|---|---|
| `content-security-policy: default-src 'none'` | 掐掉所有外部资源加载——图片、脚本、样式表、字体、connect 全部禁止 |
| `style-src 'unsafe-inline'` | 放行 SVG 内部的 `<style>` 元素，否则很多矢量图的渐变和动画会失效 |
| `sandbox` | 文档失去脚本能力，顶层导航被禁——即使 CSP 被绕过，这一层还在 |
| `content-disposition: inline` | 明确"在页面里显示"，不是附件下载 |

为什么留 `style-src 'unsafe-inline'`：`default-src 'none'` 太狠，会把 SVG 内部的 `<style>` 一起掐掉。很多工具导出的矢量图把渐变、滤镜定义在内联 `<style>` 里，禁掉就变成黑白线框。放行内联样式不增加执行面——CSS 不能执行脚本，也不能发网络请求（`default-src 'none'` 还管着）。

为什么同时写 CSP 和 sandbox：纵深防御，两者关的不是同一扇门。CSP 管"能加载什么资源"，sandbox 管"能做什么动作"（脚本、导航、表单提交、弹窗）。哪天 CSP 语法写错被浏览器忽略，sandbox 还在。

## 三、三个判断，都是踩出来的

### 1. content-type 不可信，扩展名也认一遍

`const isSvg = ct === 'image/svg+xml' || ext === 'svg'` —— 两个判据取**并集**，不是只信 content-type。

R2 对象的 `contentType` 元数据是上传时客户端声明的。声明错了、被人故意写错、或者某些 SDK 默认传 `application/octet-stream`，都会让 `ct` 不等于 `image/svg+xml`。这时候如果只看 `ct`，SVG 会带着错误的类型发出去：

- 按 `image/png` 发：浏览器按 PNG 解析 SVG 字节，渲染失败，显示裂图；
- 按 `application/octet-stream` 发：裸类型可能被浏览器嗅探成 HTML，执行面反而更大。

所以 key 的扩展名也认。两者不一致时以 key 为准：

```js
if (ct !== 'image/svg+xml') ct = 'image/svg+xml';
```

理由写在注释里了：**按 svg 发最多是"多加了沙箱"（渲染正常），按 png 发是渲染失败**。两种错法的代价差一个数量级，选代价小的那边。

### 2. 自家占位图也走同一条 CSP

`missingImage()` 是图片不存在时回的占位 SVG——回 404 会让 `<img>` 画成裂图图标，一篇长文里几个碎框比留白难看。这张图是本站自己写的，内容是固定的矩形加几根线，没有任何用户可控部分。

按理不需要沙箱。但实现里还是加了：

```js
'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
```

理由不是"这张图危险"，是**让一条规则覆盖所有 SVG 出口**：

> 占位图内容是自己写的，但一条规则覆盖所有 SVG 出口，以后改这张图的人就不用再想一遍"这里要不要加"——策略统一比逐个推理可靠。

这是安全实现里很值钱的一个习惯：不要依赖"这段内容现在是安全的"，要依赖"不管内容是什么，出口都按同一策略处理"。人会换，图会改，规则不变。

### 3. 被拒绝的类型走另一条路，不共用

`SAFE_IMG_MIME` 白名单之外的类型不进上面的 SVG 分支，而是单独处理：

```js
headers.set('content-type', 'application/octet-stream');
headers.set('content-disposition', 'attachment');
headers.set('x-img-rejected', rejected);
headers.set('x-content-type-options', 'nosniff');
headers.set('x-img-type', 'rejected');
return new Response(obj.body, { headers });
```

`attachment` 让浏览器下载而不是渲染，`nosniff` 禁止嗅探，`x-img-type: rejected` 是给出口那层的信号——注释里写得很清楚："万一以后有人往 `imageResponse` 里加了能产出 HTML 的分支，出口也不会替它签名。"

这条纵深防御是后来补的。单纯降级到 `octet-stream` 已经够了，但如果将来有人加了新分支，只测了"类型合法"没测"类型安全"，就可能把 HTML 从这条路上送出去。`x-img-type` 让出口层能分辨"这是图片请求"和"这是被拒的请求"，不让它们混在一起。

## 四、实测：加固前后

同一个测试文件，加固前：

```http
Content-Type: image/svg+xml
Cache-Control: public, max-age=31536000, immutable
x-content-type-options: nosniff
x-frame-options: DENY
```

直开后 `document.title` 变成 `SVG_RAN`。

加固后：

```http
Content-Type: image/svg+xml
Content-Disposition: inline
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
x-content-type-options: nosniff
x-img-type: image/svg+xml
```

同样的文件，直开后标题不变，脚本没跑。

对照组是位图（`/img/avatar/u36541432-96`，`image/jpeg`）：没有 CSP，没有 `Content-Disposition`。位图不是文档，加这些头是噪音——**每条策略都要有它挡的东西，挡不住任何东西的头只会让响应头表变长**。

封面层还有一半：`src/cover.js` 里正文首图如果是 `.svg` 就直接弃用，退回预设图。

```js
if (/\.svg(\?|#|$)/i.test(url)) return '';
```

这不是安全考虑，是显示考虑：208×136 的缩略图框里塞矢量图，要么糊、要么被裁得看不出是什么。一列卡片里混着清晰和糊的，比全糊还难看。安全靠出口沙箱，显示靠封面过滤，两条线互不替代。

## 五、明说的没做

[R2 那篇](/p/r2-image-pipeline)结尾列了三笔账，这里续一条更细的边界表：

| 没做的 | 现状 | 边界 |
|---|---|---|
| 上传时检查 SVG 内容 | 只看声明的 MIME，不扫文件里的 `<script>` | 出口沙箱已经让脚本跑不起来；再扫内容是重复投入。真要扫，得防 XML 实体展开和 XXE，那是另一个量级的工程 |
| 上传大小的服务端上限 | 客户端拦 12MB，头像 4MB，`/upload-url` 只验 MIME 不验大小 | 签名在 PUT 之前发出，那时还不知道文件多大。要补得把 `content-length` 写进签名头 |
| SVG 改名成 `.png` 上传 | 能存进去 | 浏览器按 png 解 + `nosniff`，执行面关着；白占配额没人管 |
| 正文大图多尺寸 | 只有封面做了 416px 缩略版 | 手机读者仍在下 1600px 原图。`srcset` 要服务端出多份，属于"知道该做还没做" |
| iframe 里的 SVG | `x-frame-options: DENY` 只挡本站页面被嵌 | SVG 文档自身的 sandbox 已经禁止被导航；不额外测第三方 embedding 场景 |

还有一条元层面的：**这个沙箱只在浏览器里成立**。如果某个阅读器把 SVG 下载下来用别的渲染器打开，CSP 头可能被忽略。本站的 RSS enclosure 和 `og:image` 都只用位图，不走这条路——那是[封面那篇](/p/rss-enclosure-cover)定的规矩，不是巧合。

## 怎么自己验一遍

```bash
# 1. 找一张站内 SVG（有就测，没有就先传一张测试图）
curl -sI 'https://exia.de5.net/img/u/xxx.svg' | grep -iE 'content-(type|disposition)|content-security-policy|x-img-type'
# 期望：CSP 含 sandbox、content-disposition: inline、x-img-type: image/svg+xml

# 2. 位图对照组不应有 CSP
curl -sI 'https://exia.de5.net/img/avatar/u36541432-96' | grep -i 'content-security-policy'
# 期望：无输出

# 3. 被拒类型的出口
curl -sI 'https://exia.de5.net/img/u/not-an-image.exe' | grep -iE 'content-disposition|x-img-rejected|x-img-type'
# 期望：attachment、rejected

# 4. 本地断言：确认沙箱逻辑在源码里
grep -n "default-src 'none'; style-src 'unsafe-inline'; sandbox" src/index.js
# 期望：至少两处（用户 SVG + 自家占位图）

# 5. 全量单测
npm test
```

第 1 步的关键不是头"有没有"，是 `sandbox` 这个 token 必须出现在 CSP 里。只有 `default-src 'none'` 而缺 `sandbox` 时，脚本仍可能被内联执行——CSP 的 `script-src` 没显式设置时，`default-src` 兜底是对的，但 sandbox 提供的是另一层独立机制，两层都在才稳。

#svg #security #csp #r2
