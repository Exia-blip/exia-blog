## 结论

图片这件事拆开是三段，每段一个决策：**写**（预签名直传 R2，Worker 中转只做兜底）、**读**（一律走 `/img/` 代理，不给直链）、**选**（封面三层兜底，同一篇永远同一张）。三个都定了之后，还剩一个当时没想清楚的问题：`image/svg+xml` 到底放不放行。

放行了，但补了一道沙箱——这是写这篇文章时才发现漏掉的，前后响应头都贴在第四节。

## 一、写：签名直传，中转只做兜底

上传接口先问 R2 能不能直接收：

```js
  if (path === '/upload-url' && method === 'POST') {
    const { res } = await requireUser(env, request);
    if (res) return res;

    const body = await request.json();
    const type = String(body.type || 'image/png');
    if (!IMAGE_TYPES[type]) return err('只支持 jpg/png/gif/webp/svg/avif');

    const key = makeKey(body.name);
    try {
      const uploadUrl = await presignPut(env, key);
      return json({ ok: true, mode: 'direct', key, uploadUrl, publicUrl });
    } catch {
      // 没配 S3 凭据 -> 走 Worker 中转
      return json({ ok: true, mode: 'proxy', key, publicUrl });
    }
  }
```

`direct` 模式下，Worker 只做一件事：算一个 15 分钟有效的 PUT 签名。图片字节从浏览器直接进 R2，一个都不经过 Worker。这不是省事，是省三样东西——请求体大小、CPU 时间、子请求额度。

签名是自己搓的，`src/s3.js` 八十五行，纯 WebCrypto，没引 aws-sdk。理由很土：为了一个 PUT 装一整套 SDK，打包体积和冷启动都不值。SigV4 的密钥派生是四个 HMAC 串起来，先用 AWS 文档里的标准向量验一遍再谈别的：

```
$ node --input-type=module -e "import {deriveSigningKey,_hex} from './src/s3.js'; \
  console.log(_hex(await deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY','20150830','us-east-1','iam')))"
derived  c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
expected c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
```

一模一样。这一步花五分钟，省掉后面所有"到底是我签错了还是 R2 不认"的排查。

前端拿到 URL 先试直传，挂了再退回中转：

```js
    if (r.mode === 'direct') {
      try {
        const put = await fetch(r.uploadUrl, { method: 'PUT',
          headers: { 'content-type': file.type }, body: file });
        if (!put.ok) throw new Error('R2 直传失败 ' + put.status);
      } catch (err) {
        // 直传失败（多半是 R2 CORS 没配）时回退到 Worker 中转
        const fd = new FormData(); fd.append('file', file);
        const r2 = await api('/api/upload', { method: 'POST', body: fd });
        r.publicUrl = r2.publicUrl;
      }
    }
```

留这条退路是因为**直传依赖 R2 桶的 CORS 配置**，而那个配置在 Cloudflare 面板里改，改错了整条上传链路立刻全挂，报错还只说一个 `CORS error`。中转路径慢（图片过一遍 Worker），但它只依赖自己的域名，永远能用。慢的可用，比快的不可用强。

## 二、读：一律走 `/img/` 代理

R2 桶可以开公开域名，直连 `pub-xxx.r2.dev`。我没开，`R2_PUBLIC_BASE` 留空，所以写入正文的地址长这样：`/img/u/202611/abc123.png`。

```js
  const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '') : '';
  const publicUrl = base ? `${base}/${key}` : `/img/${key}`;
```

代理层就这么几行：

```js
async function serveImage(env, key) {
  const obj = await env.BUCKET.get(decodeURIComponent(key));
  if (!obj) return new Response('404 Not Found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  // …svg 的额外处理，见第四节
  return new Response(obj.body, { headers });
}
```

四条理由，按重要性排：

1. **地址里没有域名。** 今天走 `/img/`，明天想换图床、换桶、加一层图片处理，正文一个字节都不用改。直链把域名焊死在一百多篇文章里，换一次就是一次全站正则。
2. **同源。** 图片跟页面一个 origin，没有 CORS，`referrer` 也不会把读者来源泄给第三方存储。
3. **能在响应上加头。** 第四节那条 CSP 就是这么加上去的——直链模式下连改的地方都没有。
4. **`R2_PUBLIC_BASE` 是开关，不是架构。** 真要直连，改一个环境变量，`/img/` 这条路自动让位。

代价是每个图片请求过一次 Worker。但 `immutable` 一年 + CF 对 `svg/png/jpg` 这类扩展名默认缓存，绝大多数请求在边缘就返回了，回源只在第一次和缓存被清的时候。这个代价我认。

## 三、`toWebp()` 的 8% 门槛

上传前在浏览器里转 WebP，省的是访客流量和 Worker 出口。这套逻辑和 [编辑器自动保存那篇](/p/editor-autosave) 里 `toWebp()` 的注释是同一份，搬到上传链路上之后多了一个判断：上传是一次性的，转坏了没机会重来，所以短路只往"放弃转换"的方向走。这段代码里有四个短路，比转换本身重要：

```js
  if (!/^image\/(jpeg|png)$/.test(file.type)) return file;   // gif 会丢动画，svg 是矢量，都不碰
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 200 * 1024) return file;    // 本来就小，不折腾
  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/webp', quality));
  if (!blob || blob.size >= file.size * 0.92) return file;   // 省不到 8% 就不换格式
```

第三条是这篇最想说的：**转完不比原图小 8% 的，直接放弃**。已经压过一轮的截图、纯色 UI 图，转 WebP 经常只小 2% 甚至更大（WebP 无损模式对已经优化的 PNG 没优势）。为了 2% 换一个格式，代价是"图片名和扩展名对不上"、"老工具打不开"这些长期麻烦。

参数是长边 1600、质量 0.82。1600 的依据是正文栏 720px，两倍屏 1440，再留一点余量——不是"越大越好"，是"刚好够清晰"。

最后两个兜底：`createImageBitmap` 不存在（老浏览器）就直接传原图，`toBlob` 返回 null 也传原图。图片上传失败比图片没压缩严重得多。

## 四、SVG：放行，但先补一道沙箱

`IMAGE_TYPES` 里留着 `image/svg+xml`，因为矢量图对技术文章有真实用处：流程图、架构图、坐标轴，放大不糊，体积还小。

问题在于 **SVG 不是图片，是文档**。浏览器用 `<img>` 加载它时沙箱化，不执行脚本；但**直接访问那个 URL** 时，它就按 HTML 一样渲染——里面的 `<script>` 会跑，而且跑在 `https://exia.de5.net` 这个 origin 上。

写这篇之前，`/img/` 的响应是这样的：

```
HTTP/1.1 200 OK
Content-Type: image/svg+xml
Cache-Control: public, max-age=31536000, immutable
x-content-type-options: nosniff
x-frame-options: DENY
```

没有 CSP。我传了一个带 `<script>document.title="SVG_RAN"</script>` 的测试文件上去，直开就能执行（nosniff 拦不住，因为 content-type 本来就是对的；`x-frame-options` 只挡 iframe）。

链子是这样接的：`/api/upload-url` 的门槛是 `requireUser`，**任何登录用户都能上传**；上传完拿到 `/img/u/xxx.svg`；把链接发给管理员点开；脚本就以管理员的身份调同源接口——发文章、封 IP、读评论里的 IP 全都可以。会话 cookie 是 `HttpOnly` 的，偷不走，但根本不需要偷。

这和 [渲染器那篇](/p/editor-markdown-xss) 是同一个问题换个入口：那篇防的是"文本里的标签被当标签执行"，靠转义；这里转义完全不管用，因为文件本身就是合法的 `image/svg+xml`，一个字符都不用改。**转义管文字，沙箱管文件类型**，两条路各自堵各自的洞。

修法是在代理层按 content-type 加头，桶里的文件一个都不动：

```js
  const ct = (headers.get('content-type') || '').toLowerCase();
  if (ct.includes('svg')) {
    headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    headers.set('content-disposition', 'inline');
  }
```

`sandbox` 让文档失去脚本能力，`default-src 'none'` 顺手掐掉外部资源。改完再测，同一个文件：

```
Content-Type: image/svg+xml
Content-Disposition: inline
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
x-content-type-options: nosniff
```

对照组（`/img/avatar/u36541432-96`，`image/jpeg`）没有这条 CSP——位图不需要，加上是噪音。

同一件事在封面层还有一半：`src/cover.js` 里正文首图如果是 `.svg` 就直接弃用，退回预设图。

```js
  if (/\.svg(\?|#|$)/i.test(url)) return '';
  if (/(^|\/)(favicon|icon[-_.]|emoji)/i.test(url)) return '';
```

不是安全考虑，是显示考虑：208×136 的缩略图框里塞一张矢量图，要么糊、要么被裁得看不出是什么。一列卡片里混着清晰和糊的，比全糊还难看。

## 五、封面三层兜底

`coverOf()` 的顺序不能改：

1. `posts.cover` —— 编辑器里手动指定，最高优先级；
2. 正文第一张图 —— 作者放图了就自动拿来当缩略图，不用再管封面；
3. 预设图 —— 纯文字文章也得有图，列表不能出现空洞。

第三层必须**稳定**：`/thumbs/auto-${(id % 6) + 1}.jpg`，id 单调递增，新文章天然轮到下一张，相邻卡片不会撞同一张；同一篇文章永远同一张（用 slug 哈希兜没有 id 的场景）。这条规则放在 `public/cover.js`，服务端和浏览器 import 同一份——不然 hydrate 时缩略图会闪一下换脸。

列表卡片用的是 416×272 的 WebP 版，一张约 1.5KB；`og:image` 和 RSS 仍然要 1200×784 的 JPG。同一张图两个尺寸，按用途取，不是为了省事全用大的。

## 六、还欠的三笔账

1. **直传路径没有服务端大小上限。** 客户端拦 12MB（`if (file.size > 12 * 1024 * 1024)`），头像接口拦 4MB，但 `/upload-url` 只验 MIME 不验大小——因为签名在 PUT 之前就发出去了，那时还不知道文件多大。真要补，得把 `content-length` 写进签名头（或者用 R2 的对象大小约束）。现在的兜底是 R2 配额本身。
2. **正文大图没有多尺寸。** 只有封面做了 416px 缩略版，正文里的图只有原图一张，手机读者在下载 1600px 的图。`srcset` 需要服务端出多份，属于"知道该做、还没做"。
3. **上传只看声明的 MIME，不看文件头。** 把 SVG 改名成 `.png` 声明 `image/png` 能存进去，浏览器按 png 解 + `nosniff`，执行面是关着的；但白占配额这件事没人管。

这三条都不影响现在能用。写下来是为了下次别当它们不存在。

## 下一篇

编辑器系列到这篇收口。下一篇回到服务端：评论防滥用那三层——蜜罐、D1 限额（IP + 设备 cookie 双钥匙，UTC+8 换天）、可选 Turnstile，以及为什么"蜜罐被填了"应该返回 400 而不是静默成功。

#cloudflare #r2 #xss
