import { handleApi, listPosts, archiveData, attachTags, friendsData, tagsData, liveSql } from './api.js';
import { loginRedirect, handleCallback, logout, authStatus, currentUser } from './auth.js';
import { html, json, umamiOn, collectOrigins, metaDesc, sqlIso, tagOf, localDay, localParts, siteOrigin } from './utils.js';
import { checkFriends } from './cron.js';
import { themeCssTag, themeCssPath, getSite } from './settings.js';
import { extractExcerpt, readingTime, renderBody, tocOf } from '../public/md.js';
import { coverOf, autoThumb, isAutoCover, isCardCover, thumbOf } from './cover.js';
import { avatarSrc, avatarTone, safeWebsite, tagClass } from '../public/avatar.js';
import { rankRelated } from './related.js';
import { sanitizeHtml } from './clean.js';
import { makeNonce, applyNonce, securityHeaders, obfuscateEmail } from './security.js';
import { ldJson, siteLd, postLd, listLd, iso } from './seo.js';
import { edgeGet, edgePut, EDGE_TTL, EDGE_SWR, pageCacheControl } from './cache.js';
import { CATS, catBySlug, catName, normalizeCat } from './taxonomy.js';
import { normalizePagePath } from './routes.js';
import { statsPage, prunePv } from './stats.js';
import { healthPage, queuePage } from './admin-pages.js';
import { postCacheGet, postCacheSet, postCacheDrop, postCacheStats } from './postcache.js';
import { assetVersion, assetCacheControl, stampAssets } from './assets.js';
import { ASSET_HASH } from './assets.gen.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ESC[c]);

/* ---------- 图片代理 ---------- */
/* 缓存策略分两种：
   - 正常命中：这张 URL 的内容不会再变（变体是内容寻址的），锁一年。
   - 回退：变体还没转出来时把原图顶上。这是**临时状态**，如果也发 immutable，
     这张原图会在边缘躺满一年 —— 之后补传了变体，同一个 URL 仍然吐原图，
     而且没有任何报错。所以回退只给 5 分钟，补传后最迟 5 分钟自动换真变体。
   x-img-fallback 让「到底命中的是变体还是回退」一眼可见（Content-Type 也能看出来，
   但多一个显式头，排查时不用先知道原图是什么格式）。 */
export const imgCacheControl = (fallback = '') =>
  fallback ? 'public, max-age=300, must-revalidate' : 'public, max-age=31536000, immutable';

const IMG_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/* 出口白名单。R2 里躺着的 content-type 完全不可信：
   直传那条路的 Content-Type 是客户端自己填的（原签名只签了 host），
   中转那条路的 file.type 同样来自客户端。实测过最坏的一种 ——
   把一个 <script> 存成 text/html 再直接导航到 /img/xxx.png，它会被当成页面渲染，
   而且 harden 会给攻击者的 <script> 补上本站 nonce，CSP 从「拦」变成「签章放行」。
   nosniff / X-Frame-Options 在这里都救不了：这是同源的一次正常导航。 */
const SAFE_IMG_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
]);
// 少见的别名，先归一成标准值再过白名单（image/jpg 不在白名单里，但那并不是攻击）
const MIME_ALIAS = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

export function imageResponse(obj, fallback = '') {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);

  const key = String(obj.key || '');
  const ext = (key.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const rawCt = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

  /* 元数据里没有 content-type 时按扩展名兜底：writeHttpMetadata 只搬 R2 里存着的
     那几项，用 --file 直传（没带 --content-type）的对象是空的。
     缺这个头，nosniff 下有的浏览器不肯渲染，而体检脚本也会把它判成「不是变体」。 */
  let ct = rawCt || IMG_MIME[ext] || '';
  ct = MIME_ALIAS[ct] || ct;

  /* 认不出的类型一律降级成二进制下载。降级后 content-type 不再是 text/html，
     出口那层也就不会把它当页面处理、不会补 nonce —— 攻击者的脚本来不及被签章。
     完全没有类型（元数据和扩展名都说不出是什么）也算认不出：缺 content-type 时
     浏览器会自己嗅探，那等于把「这串字节是什么」的判断权交还给最不该信任的一环。 */
  let rejected = '';
  if (!SAFE_IMG_MIME.has(ct)) {
    rejected = ct || 'unknown';
    ct = 'application/octet-stream';
  }

  headers.set('cache-control', imgCacheControl(fallback));
  if (fallback) headers.set('x-img-fallback', fallback);

  if (rejected) {
    headers.set('content-type', 'application/octet-stream');
    headers.set('content-disposition', 'attachment');
    headers.set('x-img-rejected', rejected);
    headers.set('x-content-type-options', 'nosniff');
    /* 用 x-img-type 告诉出口那层「这是一次图片请求，别做 HTML 加工」。
       降级本身已经够了，这条是纵深防御：万一以后有人往 imageResponse 里加了
       能产出 HTML 的分支，出口也不会替它签名。 */
    headers.set('x-img-type', 'rejected');
    return new Response(obj.body, { headers });
  }

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
  } else if (ct) {
    headers.set('content-type', ct);
  }

  headers.set('x-img-type', ct || 'unknown');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(obj.body, { headers });
}

/* 图片真的不存在时回的占位图。
   为什么不回 404：<img> 收到 404 会画成裂图图标（浏览器那个碎框），
   一篇长文里出现几个碎框，比留白难看得多；而且不同浏览器/阅读模式表现还不一样。
   回一张 SVG 占位，页面结构稳住，读者能看出「这儿本该有张图」。

   状态码仍是 200，但配了 x-img-missing 与 noindex：
   前者让体检脚本能分辨「真图」和「占位」，后者让搜索引擎别把这个地址当有效图片。
   缓存只给 60 秒 —— 原图补传上去之后，很快就能看到真图。 */
const MISSING_IMG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" rx="8" fill="#eef0f2"/><g fill="none" stroke="#b9c0c7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="116" y="62" width="88" height="62" rx="6"/><path d="M116 108l24-22 16 14 12-10 24 22"/><circle cx="150" cy="80" r="6"/></g><path d="M108 136l104-92" stroke="#b9c0c7" stroke-width="3" stroke-linecap="round"/></svg>`;

/* reason 区分两种「没有图」：
   - missing：R2 里真的没有，属于运营事故（缺传/写错路径），缓存 60 秒让补传快速生效
   - r2-error：读 R2 本身失败，属于故障，一秒都别缓存 —— 否则一次抖动会被定格一分钟 */
function missingImage(reason = 'missing') {
  const broken = reason !== 'missing';
  return new Response(MISSING_IMG, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      /* 跟我们对待用户上传的 SVG 用的是同一套：不执行任何脚本、不加载任何外部资源、
         关掉脚本上下文。占位图内容是自己写的，但一条规则覆盖所有 SVG 出口，
         以后改这张图的人就不用再想一遍「这里要不要加」—— 策略统一比逐个推理可靠。 */
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': broken ? 'no-store' : 'public, max-age=60, must-revalidate',
      'x-img-missing': '1',
      ...(broken ? { 'x-img-error': reason } : {}),
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
    },
  });
}

/* R2 的 key 是字面量，`..` 在它眼里就是两个点，走不出前缀 —— 所以这里不是
   在防目录穿越（R2 没有目录），是在拒绝一类「明显不是图片地址」的输入：
   双斜杠、反斜杠、NUL、控制字符、超长路径。这些东西进到 R2.get 只会
   白跑一次网络往返，然后拿到 null，最后被当成「图片缺失」记一笔，
   真正缺图反而被噪音盖住。 */
const BAD_KEY = /(^\/|\/\/|\\|\u0000|[\u0001-\u001f\u007f])/;
const MAX_KEY = 512;

/* 变体地址 → 回退链。抽成纯函数是为了能单独测：
   这条链错一步的后果是「给不认 avif 的浏览器发 avif」，或者「永远退到原图、
   变体等于白转」—— 两种都不报错，只能靠断言拦下来。

   形状：<原Key>[.w<宽度>].<格式>
     /a.png.avif        全尺寸 avif
     /a.png.w800.webp   缩到 800 的 webp
   原图本身是 .webp 的也认（a.webp.avif）—— 编辑器上传前就把 jpg/png 转 webp 了，
   这类图只缺一档 avif。反过来说它们没有 a.webp.webp，候选里不能出现它：
   每张图多一次必然落空的 R2 get，在冷 miss 上是实打实的一次往返。 */
export function imgVariantChain(path) {
  const m = /^(.*\.(?:png|jpe?g|webp))(?:\.w(\d{3,4}))?\.(avif|webp)$/i.exec(path);
  if (!m) return null;
  const base = m[1];
  const width = m[2] || '';
  const want = m[3].toLowerCase();
  const isWebpSrc = /\.webp$/i.test(base);
  /* 只降格式不升格式：浏览器请求 webp 说明它不认 avif，
     塞一张 avif 过去等于发了个它可能解不开的文件。 */
  const chain = [];
  if (want === 'avif') {
    // 同档降到另一格式：宽度对了、格式差一档，比给全尺寸 avif 省得多
    if (width && !isWebpSrc) chain.push([`${base}.w${width}.webp`, 'avif-missing-served-webp']);
    // 档位缺了就先上全尺寸，别为了省几十 KB 把图弄没
    chain.push([`${base}.avif`, 'avif-missing-served-original']);
    if (!isWebpSrc) chain.push([`${base}.webp`, 'avif-missing-served-original']);
  } else if (!isWebpSrc) {
    chain.push([`${base}.webp`, 'webp-missing-served-original']);
  }
  /* 去掉「自己」——请求的那个 key 已经在上面 get 过并落空了，
     放进链里等于对同一个路径再发一次必然失败的 R2 get。 */
  return { base, want, chain: chain.filter(([k]) => k !== path) };
}

async function serveImage(env, key) {
  let path;
  try {
    path = decodeURIComponent(key);
  } catch {
    return new Response('bad image path', { status: 400 });
  }
  if (!path || path.length > MAX_KEY || BAD_KEY.test(path) || path.includes('..')) {
    return new Response('bad image path', { status: 400 });
  }

  let obj = null;
  try {
    obj = await env.BUCKET.get(path);
  } catch (e) {
    /* R2 读取失败和「对象不存在」是两回事：前者是故障（该报警），
       后者是常态（该让体检脚本看见）。混在一起会让真故障看起来像缺图。
       故障时给占位图但 no-store，别把一次抖动缓存住 60 秒。 */
    console.error('r2 get failed', path, e);
    return missingImage('r2-error');
  }
  if (obj) return imageResponse(obj);

  /* 变体地址有两种形状：
       /img/a.png.webp           全尺寸换格式
       /img/a.png.w800.webp      换格式 + 缩宽度
     不按 Accept 协商，是因为 HTML 和图片都在边缘缓存，接受头分支会让同一份缓存
     发给不支持的浏览器；变体做成了独立 URL，让 <picture> 在浏览器端挑。

     回退不是「一级」而是「一条链」，因为两个维度都可能缺：格式缺、档位也可能缺
     （老图没重转过宽度、新图刚传还没跑批量脚本）。顺序固定为
     「同档降格式 → 全尺寸同格式 → 原图」，越靠后越浪费字节，但任何时候都不会裂图。

     为什么要退到 webp 而不是直接给原图：<picture> 只按 source 的 type 挑，
     浏览器支持 avif 就一定选 avif 那条，之后资源成不成立它不管 —— 实测删掉
     .avif 变体后，Chrome 依然死认 .avif 这个地址，收到 JPEG 也照渲染，
     那个 webp 候选从头到尾没被请求过一次。不在这层补一刀，webp 等于白转。 */
  const v = imgVariantChain(path);
  if (v) {
    try {
      for (const [key, why] of v.chain) {
        const obj2 = await env.BUCKET.get(key);
        if (obj2) return imageResponse(obj2, why);
      }
      const orig = await env.BUCKET.get(v.base);
      /* 原图也没有、变体也没有 —— 这时候别再回 404 让页面裂图。
         注意这里跟上面不同：上面是有东西可给（原图），这里是真的什么都没有。 */
      if (orig) return imageResponse(orig, `${v.want}-missing-served-original`);
    } catch (e) {
      console.error('r2 fallback failed', path, e);
      return missingImage('r2-error');
    }
  }
  return missingImage();
}

/* ---------- 头像代理 ----------
   只放行 avatars.githubusercontent.com/u/<数字>，别的域名一律 400，
   免得这个口子变成通用 SSRF 跳板。第一次回源 GitHub，落一份到 R2，
   之后同源长缓存；边缘直接命中，页面上再没有第三方连接。 */

/* 头像位的 MIME 同样不透传：GitHub 正常只给 png/jpeg，但「上游给什么就发什么」
   等于把这层信任外包给了第三方响应头。认不出的一律按 image/png 发 —— 头像是
   一定要显示的，标成 attachment 会让整排评论变成下载链接，而标成 png 配 nosniff
   时最坏结果是裂图，不会执行任何东西。 */
const AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
function avatarType(ct) {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  const n = MIME_ALIAS[t] || t;
  return AVATAR_MIME.has(n) ? n : 'image/png';
}

async function serveAvatarProxy(env, url) {
  const raw = url.searchParams.get('u') || '';
  const size = Math.min(256, Math.max(32, Number(url.searchParams.get('s')) || 96));

  let src;
  try {
    src = new URL(raw);
  } catch {
    return new Response('bad avatar url', { status: 400 });
  }
  const m = src.pathname.match(/^\/u\/(\d{1,12})$/);
  if (src.protocol !== 'https:' || src.hostname !== 'avatars.githubusercontent.com' || !m) {
    return new Response('bad avatar url', { status: 400 });
  }

  const key = `avatar/u${m[1]}-${size}`;
  const hit = await env.BUCKET.get(key);
  if (hit) {
    const headers = new Headers();
    hit.writeHttpMetadata(headers);
    headers.set('etag', hit.httpEtag);
    headers.set('content-type', avatarType(headers.get('content-type')));
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(hit.body, { headers });
  }

  // GitHub 的 s 是最终边长，这里给 2 倍图，高分屏不糊
  let up = null;
  try {
    up = await fetch(`https://avatars.githubusercontent.com/u/${m[1]}?s=${size * 2}`, {
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });
  } catch {
    up = null;
  }
  if (!up || !up.ok) {
    return new Response('', { status: 404, headers: { 'cache-control': 'public, max-age=300' } });
  }

  const buf = await up.arrayBuffer();
  const type = avatarType(up.headers.get('content-type') || 'image/png');
  try {
    await env.BUCKET.put(key, buf, {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
    });
  } catch {} // 落盘失败不影响这一响应，下次访问再补

  return new Response(buf, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ---------- 取静态页模板 ---------- */
async function assetText(env, request, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: request.headers }));
  if (!res.ok) return null;
  return res.text();
}

/* ---------- 文章页 SSR（正文 / 评论 / 结构化数据全部进 HTML） ---------- */

function relTime(sqlDate) {
  const d = new Date(String(sqlDate || '').replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  // 与 public/app.js 的 fmtRelative 保持同一套刻度：客户端会用 data-t 再算一遍，
  // 两边口径不一致的话，页面一加载时间就会「跳」一下
  const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
  return `${Math.floor(diff / (86400 * 365))} 年前`;
}

const avaText = (name) => esc(String(name || '?').slice(0, 1).toUpperCase());

/* 评论区的操作按钮服务端就画好，前端只挂事件。
   以前 acts 是空的，前端进来必拉一次 /api/comments 重新渲染整块 ——
   同样的数据拉两遍（一次 SSR、一次接口），多一次 Worker 请求 + 一次 D1 查询。
   现在 SSR 直接输出按钮：回复按钮给所有人，删除/封 IP 与联系邮箱只给管理员。
   登录态请求本来就绕过边缘缓存（见 fetch handler 里的 loggedIn 判断），
   所以管理员看到的 HTML 不会被缓存给匿名访客。 */
export function commentActs(c, viewer) {
  const reply = c.parent_id ? '' : `<button type="button" data-reply="${c.id}" data-name="${esc(c.name)}">回复</button>`;
  const admin = viewer && viewer.is_admin
    ? `<button type="button" data-del="${c.id}">删除</button>` +
      `<button type="button" data-ban="${c.id}" class="cmt-ban" title="删掉这个来源的全部访客评论，并拉黑该 IP">封 IP</button>`
    : '';
  return reply + admin;
}

export function renderComment(c, isChild = false, viewer = null) {
  const site = safeWebsite(c.website);
  const homepage = site
    ? `<a href="${esc(site)}" target="_blank" rel="noopener nofollow noUGc" class="muted">${esc(c.name)}</a>`
    : esc(c.name);
  const mail = viewer && viewer.is_admin && c.email
    ? `<a class="cmt-mail" href="mailto:${esc(c.email)}" title="联系邮箱，仅管理员可见">${esc(c.email)}</a>`
    : '';
  return `<div class="cmt" data-cid="${c.id}"><div class="ava ${avatarTone(c.name)}">${avaText(c.name)}</div><div class="main"><div class="head"><b>${homepage}</b>${
    c.is_admin ? '<span class="badge-owner">博主</span>' : ''
  }<time class="when" datetime="${esc(sqlIso(c.created_at))}" data-t="${esc(String(c.created_at || ''))}">${esc(
    relTime(c.created_at)
  )}</time>${mail}</div><div class="text">${esc(c.content)}</div><div class="acts">${commentActs(
    c,
    viewer
  )}</div>${
    !isChild && c.replies && c.replies.length
      ? `<div class="replies">${c.replies.map((r) => renderComment(r, true, viewer)).join('')}</div>`
      : ''
  }</div></div>`;
}

/* 表单字段挂真 <label>：占位符在输入后消失，读屏也读不到它当字段名。
   用 sr-only 而不是可见标签，是为了不动现有三列排布。 */
export function renderComments(rows, total, viewer = null) {
  const roots = rows.filter((c) => !c.parent_id);
  const kids = rows.filter((c) => c.parent_id);
  const tree = roots.map((r) => ({ ...r, replies: kids.filter((c) => c.parent_id === r.id) }));
  const list = tree.length
    ? tree.map((c) => renderComment(c, false, viewer)).join('')
    : '<div class="muted small" style="padding:14px 0">还没有评论，来抢沙发。</div>';
  return `<section class="comments" id="comments" data-ssr="1">
      <h3>评论 <span class="muted" id="cmt-count">${total ? `(${total})` : ''}</span></h3>
      <div id="cmt-list">${list}</div>
      <form class="cmt-form" id="cmt-form" novalidate>
        <div id="reply-hint" class="tiny muted" style="display:none"></div>
        <input type="text" name="hp" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true" placeholder="留空">
        <label class="sr-only" for="cmt-name">昵称（必填）</label>
        <label class="sr-only" for="cmt-email">联系邮箱（必填，不公开，仅博主可见）</label>
        <label class="sr-only" for="cmt-website">网站（可选）</label>
        <div class="row" id="guest-fields">
          <input id="cmt-name" type="text" name="name" placeholder="昵称 *" maxlength="40" autocomplete="nickname" required>
          <input id="cmt-email" type="email" name="email" placeholder="联系邮箱 *（不公开，仅博主可见）" maxlength="120" autocomplete="email" required>
          <input id="cmt-website" type="url" name="website" placeholder="网站（可选）" maxlength="200">
        </div>
        <label class="sr-only" for="cmt-content">评论内容（必填）</label>
        <textarea id="cmt-content" name="content" placeholder="说点什么…" maxlength="2000" required></textarea>
        <div class="ts-wrap" id="ts-wrap" hidden></div>
        <div class="foot">
          <span class="tiny muted" id="cmt-hint"></span>
          <button class="btn primary sm" type="submit">发表评论</button>
        </div>
      </form>
    </section>`;
}

/* ---------- 归档页 SSR ----------
   原先前端整页渲染，HTML 里只有「加载中…」，一条真实链接都没有：
   爬虫抓到的是一张空页，内链权重也传不出去。
   现在 Worker 直接输出时间线、年份筛选与统计，前端只负责视图切换，
   且不再重建首屏（切视图/切年份才重绘）。 */

const archSpan = (first, last) => {
  const ym = (v) => {
    const p = localParts(v);
    return p.y ? `${p.y}.${p.m}` : '';
  };
  const a = ym(first);
  const b = ym(last);
  if (!a) return '';
  return a === b ? a : `${a} — ${b}`;
};

function archSub(data) {
  if (!data.total) return '还没有公开文章';
  const shown = data.years.reduce((a, y) => a + y.count, 0);
  if (data.year) {
    return `${esc(data.year)} 年共 <b>${shown}</b> 篇 · <a href="/archive" class="lnk">看全部 ${data.total} 篇</a>`;
  }
  return `共 <b>${data.total}</b> 篇 · ${esc(archSpan(data.first_at, data.last_at))} · 跨越 ${data.years.length} 个年份`;
}

function archFilters(data) {
  if (!data.years.length) return '';
  // 只有一个年份且没在筛选时，筛选条意义不大，和前端保持同一判断
  if (data.years.length < 2 && !data.year) return '';
  const all = `<a class="tag${data.year ? '' : ' on'}" href="/archive">全部</a>`;
  const ys = data.years
    .map((y) => {
      const on = data.year === y.year ? ' on' : '';
      return `<a class="tag${on}" href="/archive/${esc(y.year)}">${esc(y.year)}<span class="tag-n">${y.count}</span></a>`;
    })
    .join('');
  return all + ys;
}

const archChips = (p) =>
  (p.tags || [])
    .slice(0, 3)
    .map((t) => `<span class="chi">#${esc(t)}</span>`)
    .join('');

function archTimeline(data) {
  return `<div class="timeline">${data.years
    .map(
      (y) => `<section class="tl-year">
      <div class="tl-yhead"><b>${esc(y.year)}</b><span class="tiny muted">${y.count} 篇</span></div>
      ${y.months
        .map(
          (m) => `<div class="tl-month">
        <div class="tl-mlabel">${esc(m.label)}<span class="tiny muted">${m.count}</span></div>
        <div class="tl-items">${m.posts
          .map((p) => {
            const stamp = String(p.published_at || p.created_at || '');
            const md = localParts(stamp).md;
            return `<a class="tl-item" href="/p/${encodeURIComponent(p.slug)}" title="${esc(p.title)}">
              <span class="tl-day">${esc(md)}</span>
              <span class="tl-body"><span class="tl-title">${esc(p.title)}</span><span class="tl-meta">${
                p.category ? `<span class="chi cat">${esc(p.category_name || p.category)}</span>` : ''
              }${archChips(p)}<span class="tl-dim">${p.reading} 分钟</span>${
                p.comments ? `<span class="tl-dim">${p.comments} 条评论</span>` : ''
              }</span></span></a>`;
          })
          .join('')}</div>
      </div>`
        )
        .join('')}
    </section>`
    )
    .join('')}</div>`;
}

function archList(data) {
  return `<div class="arch">${data.years
    .map(
      (y) => `<section class="arch-year">
      <div class="arch-yhead"><b>${esc(y.year)}</b><span class="tiny muted">${y.count} 篇</span></div>
      ${y.months
        .map(
          (m) => `<div class="arch-month">
        <div class="arch-mlabel">${esc(m.label)}</div>
        <div class="arch-rows">${m.posts
          .map((p) => {
            const md = localParts(p.published_at || p.created_at).md;
            return `<a class="arch-row" href="/p/${encodeURIComponent(p.slug)}">
              <span class="arch-day">${esc(md)}</span>
              <span class="arch-title">${esc(p.title)}</span>
              <span class="arch-side">${
                p.category ? `<span class="chi cat">${esc(p.category_name || p.category)}</span>` : ''
              }</span></a>`;
          })
          .join('')}</div>
      </div>`
        )
        .join('')}
    </section>`
    )
    .join('')}</div>`;
}

function archBody(data) {
  if (!data.total) {
    return '<div class="empty">站点还是空的。登录后在后台写第一篇，这里就会长出时间线。</div>';
  }
  const shown = data.years.reduce((a, y) => a + y.count, 0);
  if (!shown) {
    return `<div class="empty">${esc(data.year)} 年还没有文章。<a class="lnk" href="/archive">看全部</a></div>`;
  }
  return archTimeline(data);
}

async function serveArchivePage(env, request, url) {
  const m = url.pathname.match(/^\/archive\/(\d{4})\/?$/);
  const year = m ? m[1] : (url.searchParams.get('year') || '').trim();

  const res = await env.ASSETS.fetch(new Request(new URL('/archive', request.url), request));
  if (res.status !== 200) return res;
  let body = await res.text();

  let data;
  try {
    data = await archiveData(env.DB, year);
  } catch (e) {
    // 查库失败就退回原模板，前端脚本还能自己拉一次，别整页白屏
    console.error('archive ssr failed', e);
    return html(body, 200, { 'cache-control': pageCacheControl() });
  }

  const boot = JSON.stringify(data).replace(/</g, '\\u003c');

  body = body
    .replace(/<p id="hero-sub">[\s\S]*?<\/p>/, `<p id="hero-sub">${archSub(data)}</p>`)
    .replace(/<div class="year-filter" id="year-filter"><\/div>/, `<div class="year-filter" id="year-filter">${archFilters(data)}</div>`)
    .replace(/<div id="arch-body">[\s\S]*?<\/div>\s*<\/main>/, `<div id="arch-body">${archBody(data)}</div>\n</main>`)
    .replace('</head>', `<script>window.__ARCH__=${boot};</script></head>`);

  return html(body, 200, { 'cache-control': pageCacheControl() });
}

/* ---------- 友链：服务端直出 ---------- */
// 以前这里回 Google 的 s2/favicons：每个友链一次第三方请求，慢、会超时、还被墙。
// 现在只在自家填了 avatar 时出图，否则用首字母方块 —— 零外部请求。
function friendIcon(f) {
  if (f.avatar) return `<img class="fav" src="${esc(f.avatar)}" alt="" loading="lazy" decoding="async" width="38" height="38">`;
  const ch = String(f.name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="fav ph" aria-hidden="true">${esc(ch)}</span>`;
}

function friendsBody(list) {
  if (!list.length) return '<div class="empty">还没有友链</div>';
  return list
    .map((f) => {
      let host = '';
      try {
        host = new URL(f.url).hostname;
      } catch {}
      // 三态：1 正常 / 2 有响应但状态异常（4xx、5xx，多半是 WAF 拦爬虫）/ 0 拿不到响应
      const state = Number(f.status) === 1 ? 'on' : Number(f.status) === 2 ? 'warn' : 'off';
      const label =
        state === 'on' ? '可访问' : state === 'warn' ? `有响应（HTTP ${f.http_status || '?'}）` : '无法访问';
      const ms = Number(f.latency_ms) > 0 ? ` · ${f.latency_ms}ms` : '';
      return `<a class="friend-card" href="${esc(f.url)}" target="_blank" rel="noopener" data-id="${f.id}">
        ${friendIcon(f)}
        <div class="info">
          <div class="nm">
            <span class="dot ${state}" title="${label}${ms}"></span>
            ${esc(f.name)}
          </div>
          <div class="ds">${esc(f.desc || host)}</div>
        </div>
      </a>`;
    })
    .join('');
}

async function serveFriendsPage(env, request) {
  const res = await env.ASSETS.fetch(new Request(new URL('/friends', request.url), request));
  if (res.status !== 200) return res;
  let body = await res.text();

  let list;
  try {
    list = await friendsData(env.DB);
  } catch (e) {
    console.error('friends ssr failed', e);
    return html(body, 200, { 'cache-control': pageCacheControl() });
  }

  const boot = JSON.stringify({ friends: list }).replace(/</g, '\\u003c');
  body = body
    .replace(
      /(<div class="friend-grid" id="grid">)[\s\S]*?(<section id="admin-box")/,
      `$1${friendsBody(list)}</div>\n\n  $2`
    )
    .replace('</head>', `<script>window.__FRIENDS__=${boot};</script></head>`);

  return html(body, 200, { 'cache-control': pageCacheControl() });
}

/* ---------- 系列页 ----------
   建它的直接原因：JSON-LD 里 isPartOf 指向 CreativeWorkSeries，得有个真地址接住它；
   顺带解决另一个问题——系列里的每一篇原本只能链到「同系列另一篇」，
   没有一个页面能让读者一眼看完整条线，也没有一个入口让爬虫一次抓全。 */

// 主题初始化那一段在 404、系列页都要用，复制三份迟早漂移
function themeBoot(site) {
  const cfg = JSON.stringify({ theme: site.theme, mode: site.mode }).replace(/</g, '\\u003c');
  /* 主题 CSS 的哈希表要跟着这段脚本一起下发给浏览器：
     head 里直出的那份 <link> 由 themeCssTag 写了 integrity，但运行时切主题是
     脚本自己 createElement/改 href，拿不到哈希就只能发一个没有 integrity 的请求
     —— 同一个文件，直出时有校验、切换时没校验，等于留了条后门。
     表很小（5 套 × 约 100 字节），放进内联脚本比多一次请求划算。 */
  const H = {};
  for (const id of ['ink', 'forest', 'ocean', 'plum', 'mono']) {
    const a = ASSET_HASH[`theme/${id}.css`];
    if (a) H[`/theme/${id}.css`] = { v: a.v, i: a.i };
  }
  /* 自托管的 mermaid 由 boot.js 按需注入：2.7MB 的包只该在有图的页面落地，
     但 hash 得提前给到 —— 动态拼出来的 <script> 拿不到服务端戳的版本号。 */
  const mm = ASSET_HASH['vendor/mermaid.min.js'];
  if (mm) H['/vendor/mermaid.min.js'] = { v: mm.v, i: mm.i };
  const hs = JSON.stringify(H).replace(/</g, '\\u003c');
  return `<script>window.__THEME_DEFAULT__=${cfg};window.__ASSET_H__=${hs};(function(){var d=document.documentElement,t=null,m=null;try{t=localStorage.getItem('x_theme');m=localStorage.getItem('x_mode')}catch(e){}var g=window.__THEME_DEFAULT__||{};t=t||g.theme||'paper';m=m||g.mode||'auto';var sys=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;var dark=(m==='dark')||(m!=='light'&&sys);d.setAttribute('data-theme',t);d.setAttribute('data-mode',dark?'dark':'light');d.setAttribute('data-mpref',m);(function(){var L=document.getElementById('tcss-default'),trivial=(t==='paper'||t==='anzhiyu');if(trivial){if(L)document.head.removeChild(L);return}var H=window.__ASSET_H__||{},a=H['/theme/'+t+'.css']||{},h='/theme/'+t+'.css'+(a.v?'?v='+a.v:'');if(L){L.id='tcss-'+t;L.integrity=a.i||'';L.href=h}else{var S=document.createElement('link');S.id='tcss-'+t;S.rel='stylesheet';if(a.i)S.integrity=a.i;S.href=h;document.head.appendChild(S)}})()})();</script>`;
}

function seriesShell({ site, origin, title, kicker, desc, canonical, ld, sub, list }) {
  const siteName = esc(site.name || 'Blog');
  // 分享图与静态页同口径：固定那张 1200×630，尺寸和域名都在自己手里。
  // 系列页此前只手搓了 title/desc/canonical，贴到 IM 里不出富卡片 —— 补齐。
  const ogImage = `${origin}/og-default.jpg`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${siteName}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="${THEME_COLOR[site.theme] || '#faf9f7'}">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${esc(canonical)}">
<link rel="manifest" href="/manifest.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name || 'Blog')}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:locale" content="zh_CN">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:alt" content="${esc(site.name || 'Blog')}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(ogImage)}">
${themeBoot(site)}
<link rel="stylesheet" href="/style.css">
<script src="/boot.js" defer></script>
${ld ? ldJson(ld) : ''}
</head><body>
<a class="skip-link" href="#main">跳到正文</a>
${renderHeader(site, '/series')}
<main class="wrap" id="main" tabindex="-1">
  <div class="page-head">
    <p class="page-kicker">${esc(kicker)}</p>
    <h1>${esc(title)}</h1>
    <p class="page-sub">${sub}</p>
  </div>
  ${list}
</main>
<footer class="series-foot"><a href="/">← 首页</a> · <a href="/series">全部系列</a></footer>
${siteFooter(site)}
</body></html>`;
}

/* 显示统一按北京时间：D1 存 UTC，直接 slice 会让凌晨发布的文章显示成前一天。
   机器读的那几条（JSON-LD / sitemap / RSS）不走这里，它们就该是 UTC。 */
const fmtDay = (v) => localDay(v);

// 序号优先用 series_order；没填过就按列表位置兜底，别让读者看见「00」
function seriesRows(rows) {
  if (!rows.length) return '<p class="empty">这个系列还没有公开文章</p>';
  return `<ol class="series-page">${rows
    .map((p, i) => {
      const n = String(p.series_order > 0 ? p.series_order : i + 1).padStart(2, '0');
      return `<li><a href="/p/${encodeURIComponent(p.slug)}">
        <span class="sp-n">${n}</span>
        <span class="sp-t">${esc(p.title)}</span>
        <span class="sp-d">${esc(fmtDay(p.published_at || p.created_at))}</span></a></li>`;
    })
    .join('')}</ol>`;
}

async function serveSeriesPage(env, request, name) {
  const site = await getSite(env);
  const origin = siteOrigin(env, request);
  const { results } = await env.DB.prepare(
    `SELECT slug, title, series_order, published_at, created_at FROM posts
     WHERE series = ? AND is_private = 0 AND hidden = 0 AND ${liveSql('posts')}
     ORDER BY series_order ASC, created_at ASC`
  )
    .bind(name)
    .all();

  if (!results.length) return await notFoundPage(env, request, '没有这个系列');

  const latest = results.reduce((a, p) => {
    const t = String(p.published_at || p.created_at || '');
    return t > a ? t : a;
  }, '');
  const canonical = `${origin}/series/${encodeURIComponent(name)}`;

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CreativeWorkSeries',
        '@id': `${canonical}#series`,
        name,
        url: canonical,
        inLanguage: 'zh-CN',
        numberOfEpisodes: results.length,
        hasPart: results.map((p, i) => ({
          '@type': 'BlogPosting',
          position: p.series_order > 0 ? p.series_order : i + 1,
          name: p.title,
          url: `${origin}/p/${encodeURIComponent(p.slug)}`,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '首页', item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: '系列', item: `${origin}/series` },
          { '@type': 'ListItem', position: 3, name, item: canonical },
        ],
      },
    ],
  };

  return html(
    stampAssets(seriesShell({
      site,
      origin,
      title: name,
      kicker: '系列连载',
      desc: `${name}：共 ${results.length} 篇，最近更新 ${fmtDay(latest)}。`,
      canonical,
      ld,
      sub: `共 ${results.length} 篇 · 最近更新 ${esc(fmtDay(latest))}`,
      list: seriesRows(results),
    }), env),
    200,
    { 'cache-control': pageCacheControl() }
  );
}

async function serveSeriesIndex(env, request) {
  const site = await getSite(env);
  const origin = siteOrigin(env, request);
  const { results } = await env.DB.prepare(
    `SELECT series AS name, COUNT(*) AS n, MAX(COALESCE(NULLIF(published_at, ''), created_at)) AS latest
     FROM posts
     WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')} AND TRIM(COALESCE(series, '')) != ''
     GROUP BY series ORDER BY latest DESC`
  ).all();

  const canonical = `${origin}/series`;
  const list = results.length
    ? `<ol class="series-page">${results
        .map(
          (s) => `<li><a href="/series/${encodeURIComponent(s.name)}">
        <span class="sp-t">${esc(s.name)}</span>
        <span class="sp-d">${s.n} 篇 · ${esc(fmtDay(s.latest))}</span></a></li>`
        )
        .join('')}</ol>`
    : '<p class="empty">还没有成系列的文章</p>';

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': canonical,
        url: canonical,
        name: '系列',
        inLanguage: 'zh-CN',
        isPartOf: { '@id': `${origin}/#website` },
      },
      results.length
        ? {
            '@type': 'ItemList',
            itemListElement: results.map((s, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: s.name,
              url: `${origin}/series/${encodeURIComponent(s.name)}`,
            })),
          }
        : null,
    ].filter(Boolean),
  };

  return html(
    stampAssets(seriesShell({
      site,
      origin,
      title: '系列',
      kicker: '连载',
      desc: results.map((s) => s.name).join('、') || '按系列读',
      canonical,
      ld,
      sub: `${results.length} 个系列 · 按最近更新排`,
      list,
    }), env),
    200,
    { 'cache-control': pageCacheControl() }
  );
}

/* ---------- 系列目录（文章页顶部那块）
   爬虫发现新文章主要靠 sitemap，但「哪篇该跟着重抓」靠的是站内互链。
   系列文每发一篇，前面所有篇都多一条入链，等于每次发文带动一次全系列回访。 */
function renderSeries(post, list) {
  if (!list || list.length < 2) return '';
  const idx = list.findIndex((p) => p.slug === post.slug);
  const n = (i) => String(i + 1).padStart(2, '0');
  const items = list
    .map((p, i) => {
      const cur = p.slug === post.slug;
      const label = `<span class="sn">${n(i)}</span><span class="st">${esc(p.title)}</span>`;
      return cur
        ? `<li class="cur" aria-current="page">${label}</li>`
        : `<li><a href="/p/${encodeURIComponent(p.slug)}">${label}</a></li>`;
    })
    .join('');
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const jump =
    prev || next
      ? `<div class="series-jump">
    ${prev ? `<a href="/p/${encodeURIComponent(prev.slug)}" rel="prev">← ${esc(prev.title)}</a>` : '<span></span>'}
    ${next ? `<a href="/p/${encodeURIComponent(next.slug)}" rel="next">${esc(next.title)} →</a>` : '<span></span>'}
  </div>`
      : '';
  return `<nav class="series" id="series" aria-label="系列目录">
    <div class="series-top">
      <span class="series-kicker">系列连载</span>
      <a class="series-name" href="/series/${encodeURIComponent(post.series)}">${esc(post.series)}</a>
      <span class="series-count">共 ${list.length} 篇 · 第 ${idx + 1} 篇</span>
    </div>
    <ol class="series-list">${items}</ol>
    ${jump}
  </nav>`;
}

/* 非系列文的兜底导航：同栏目按时间排，取前后各一篇。
   注意判断条件不能只看 post.series —— 系列里只有 1 篇公开文章时，
   renderSeries 因为「不够 2 篇」什么都不渲染，这时候如果这里也跳过，
   那篇文章就彻底没有出口了（排障记刚上线时就是这个状态）。 */
function renderAdjacent(post, list, seriesList) {
  if (post.series && seriesList && seriesList.length > 1) return '';
  if (!list || list.length < 2) return '';
  const idx = list.findIndex((p) => p.slug === post.slug);
  if (idx < 0) return '';
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx < list.length - 1 ? list[idx + 1] : null;
  if (!prev && !next) return '';
  /* 卡片里除了标题，再给一行「日期 · 栏目」：只有标题时两张卡长得一样，
     读者得先读字才知道哪边是更早的一篇。箭头用 CSS 位移，不放 emoji 。*/
  const cell = (p, dir, label) => {
    if (!p) return '';
    const cname = p.category ? catName(p.category) : '';
    const day = fmtDay(p.published_at || p.created_at);
    const meta = [day, cname].filter(Boolean).join(' · ');
    return `<a class="adj ${dir}" href="/p/${encodeURIComponent(p.slug)}" rel="${dir}">
      <span class="adj-k"><i aria-hidden="true">${dir === 'prev' ? '←' : '→'}</i>${label}</span>
      <span class="adj-t">${esc(p.title)}</span>
      ${meta ? `<span class="adj-m">${esc(meta)}</span>` : ''}
    </a>`;
  };
  const cells = [cell(prev, 'prev', '上一篇'), cell(next, 'next', '下一篇')].filter(Boolean);
  // 只有一侧有文章时收成单列：留半个虚线空框看着像加载失败
  return `<nav class="post-adjacent${cells.length === 1 ? ' single' : ''}" aria-label="同栏目相邻文章">
    ${cells.join('')}
  </nav>`;
}

/* 相关推荐：同标签 / 同栏目的 3 篇。空了整块不渲染（不留空壳占版面）。
   排在上一篇/下一篇之上——先给横向的延伸阅读，再给纵向的时间序列。 */
function renderRelated(post, list) {
  if (!list || !list.length) return '';
  const cells = list
    .map((p) => {
      const cname = p.category ? catName(p.category) : '';
      const day = fmtDay(p.published_at || p.created_at);
      const meta = [cname, day].filter(Boolean).join(' · ');
      return `<a class="rel" href="/p/${encodeURIComponent(p.slug)}" rel="nofollow">
        <span class="rel-t">${esc(p.title)}</span>
        ${meta ? `<span class="rel-m">${esc(meta)}</span>` : ''}
      </a>`;
    })
    .join('');
  return `<section class="post-related" aria-label="相关文章">
    <h2 class="rel-h">相关文章</h2>
    <div class="rel-grid">${cells}</div>
  </section>`;
}

async function servePostPage(env, request, slug) {
  const user = await currentUser(env, request);

  /* 依赖深度压到 1：标签和评论不再等 post.id，直接用 slug 关联，就能跟正文一起发。
     上一版把 [标签, 评论] 并在一起，看着像"已经并发了"，但深度的成因不是查询条数，
     而是"必须先拿到 id 才能查子表"——真正的串行段是 post → 子表这一跳。
     系列目录同理，用子查询按 slug 找同系列名，也进同一批。
     D1 单库单线程、单次调用最多 6 条连接，这里 5 条查询刚好卡在线上，
     再加查询就得换成 batch() —— 别在这条路上继续加。

     文章本体、标签、系列目录、同栏目列表这四份走实例内 LRU（见 src/postcache.js）：
     它们只在改文/改栏目时变，而改文那一刻我们已经主动清了缓存。
     评论不缓存 —— 页面上唯一会秒级变化的就是它。 */
  const cached = postCacheGet(slug);
  const bundleP = cached
    ? Promise.resolve(cached)
    : (async () => {
        const [post, tagRes, seriesRes, catRes] = await Promise.all([
          env.DB.prepare(
            `SELECT p.*, u.name AS author_name, u.login, u.avatar,
                    COALESCE(NULLIF(p.published_at, ''), p.created_at) <= datetime('now') AS is_live
             FROM posts p
             LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`
          )
            .bind(slug)
            .first(),
          env.DB.prepare(
            `SELECT t.name FROM tags t
             JOIN post_tags pt ON pt.tag_id = t.id
             JOIN posts p ON p.id = pt.post_id
             WHERE p.slug = ? ORDER BY t.name`
          )
            .bind(slug)
            .all(),
          env.DB.prepare(
            `SELECT slug, title, series_order FROM posts
             WHERE TRIM(COALESCE(series, '')) != ''
               AND series = (SELECT series FROM posts WHERE slug = ?)
               AND is_private = 0 AND hidden = 0 AND ${liveSql('posts')}
             ORDER BY series_order ASC, created_at ASC`
          )
            .bind(slug)
            .all(),
          // 同栏目整份列表 + 相关推荐候选，一条查询两用（D1 连接已用 5 条、上限 6，不再加）：
          //   · 上下篇：只取 category 相同的行，按时间排（见下面 sameCat 的过滤）
          //   · 相关推荐：取全部候选（同栏目 OR 有共同标签），在内存里按标签交集排序
          // 带出 tag_str（char(31) 分隔）才能在内存算交集，避免为推荐单开一条查询。
          env.DB.prepare(
            `SELECT p.slug, p.title, p.published_at, p.created_at, p.category,
                    (SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt
                     JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str
             FROM posts p
             WHERE p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}
               AND (p.category = (SELECT category FROM posts WHERE slug = ?)
                    OR EXISTS (
                      SELECT 1 FROM post_tags a JOIN post_tags b ON a.tag_id = b.tag_id
                      WHERE a.post_id = p.id
                        AND b.post_id = (SELECT id FROM posts WHERE slug = ?)
                    ))
             ORDER BY COALESCE(NULLIF(p.published_at, ''), created_at) ASC`
          )
            .bind(slug, slug)
            .all(),
        ]);
        const b = {
          post,
          tags: tagRes.results.map((r) => r.name),
          series: seriesRes.results,
          same: catRes.results,
        };
        /* 私有文章不进缓存：来访者本来就少，缓不缓存无所谓；
           把私有正文在内存里多留 45 秒也没有必要。 */
        if (post && !post.is_private) postCacheSet(slug, b);
        return b;
      })();

  const [bundle, cmtRes, site, tpl] = await Promise.all([
    bundleP,
    env.DB.prepare(
      // email 只有管理员会在页面上看到（见 commentActs 的 viewer 判断），
      // 匿名访客的 HTML 里不会出现这个字段
      `SELECT c.id, c.parent_id, c.name, c.email, c.website, c.content, c.is_admin, c.created_at
       FROM comments c JOIN posts p ON p.id = c.post_id
       WHERE p.slug = ? ORDER BY c.created_at ASC`
    )
      .bind(slug)
      .all(),
    getSite(env),
    assetText(env, request, '/post'),
  ]);

  /* 行是浅拷贝出来的：下面会往 post 上挂 tags / comments / 系列，
     直接改缓存里那份，下一次读到的就带着上一次的评论数了。 */
  const post = bundle.post ? { ...bundle.post } : null;
  const tagNames = bundle.tags;
  /* tags 必须在 rankRelated 之前挂上。posts 表没有 tags 列，它是独立查询出来的；
     rankRelated 靠 post.tags 算共同标签数，晚一步赋值就全是 0，
     排序退化成「同栏目 + 时间新」，跨栏目同标签的文章一条都进不来。
     2026-11-18 实测线上就是这个问题，单测测不到（纯函数只验传进来的值）。 */
  if (post) post.tags = tagNames;
  const seriesPosts = bundle.series.map((r) => ({ ...r }));
  /* 同一份查询结果两用：上下篇只要同栏目的（按查询里的时间序，不能打乱）；
     相关推荐吃全部候选（含跨栏目同标签的），由 rankRelated 重排。 */
  const allCat = bundle.same.map((r) => ({ ...r }));
  const sameCat = post ? allCat.filter((r) => r.category === post.category) : [];
  const related = rankRelated(post, allCat);

  if (!post) return await notFoundPage(env, request, '页面走丢了');
  if (post.is_private && (!user || (user.id !== post.author_id && !user.is_admin))) {
    return await notFoundPage(env, request, '页面走丢了');
  }
  // 预排：时间没到就当这页不存在。列表/RSS/sitemap 已经挡住了，但直接拿到 slug
  // 的人还是能拼出来 —— 不挡的话，预排等于提前公开，只是没人知道地址。
  // 作者与站长例外，要能提前预览。
  if (!post.is_live && !(user && (user.id === post.author_id || user.is_admin))) {
    return await notFoundPage(env, request, '页面走丢了');
  }

  if (!tpl) return new Response('模板缺失', { status: 500 });

  const cmtRows = cmtRes.results;
  post.comments = cmtRows.length;

  // 系列目录：同系列公开文章按序号排，当前这篇标出来，顺带算出上下篇
  const siteName = site.name;
  const origin = siteOrigin(env, request);
  // canonical 必须和 sitemap / RSS 里给的地址一致，否则同一篇文章被收录两份
  // 三处都用可信源，不能从 request.url 派生（Host 头可控）
  const canonical = new URL(`/p/${encodeURIComponent(post.slug)}`, origin).toString();

  const desc = metaDesc(post.summary || extractExcerpt(post.content, 260), site.desc || site.name);
  // 手填封面 → 正文首图 → 预设自动图，永远有值
  const cover = coverOf(post);
  // 封面 → 本站分享图。站点头像不参与：GitHub 头像只有 460px，社交卡片会糊成一团，
  // 而且外链域名不受自己控制（改天换图床就 404）。
  const ogImage = new URL(cover, origin).toString();
  /* og:image 的尺寸只标能确认的两种：预设图 1200×784 JPEG、标题卡 1200×630 PNG。
     作者自己传的图尺寸未知，标错了平台会按错的框去裁。 */
  const ogKind = isAutoCover(post)
    ? { type: 'image/jpeg', w: 1200, h: 784 }
    : isCardCover(post)
      ? { type: 'image/png', w: 1200, h: 630 }
      : null;

  /* 发布时已经渲染 + 消毒并落库（html_content），这里只读成品。
     缓存 miss 的那一次回源不再跑 Markdown 解析 —— 长文 miss 是最吃亏的场景：
     边缘挡得住重复访问，挡不住冷启动、淘汰和改文之后的那一下。
     空串（还没回填的历史行）退回现算，两种情况页面完全一致。 */
  const bodyHtml = post.html_content || sanitizeHtml(renderBody(post.content));
  const words = String(post.content || '').replace(/\s/g, '').length;
  const reading = readingTime(post.content);

  const lead = post.summary
    ? `<aside class="post-lead"><span class="lead-tag">${post.summary_src === 'ai' ? 'AI 摘要' : '摘要'}</span><p>${esc(
        post.summary
      )}</p></aside>`
    : '';

  const tagbar = [
    post.category
      ? `<a class="tag cat-chip" href="/cat/${encodeURIComponent(post.category)}">${esc(catName(post.category))}</a>`
      : '',
    (post.tags || []).map((t) => `<a class="tag" href="/tag/${encodeURIComponent(t)}">#${esc(t)}</a>`).join(''),
  ].join('');

  /* 侧边目录：只有 h2 够多才出（少于 3 节的文章不需要目录，出了反而是噪音）。
     id 直接从渲染结果里抽，不重算 slug —— 两套规则迟早漂移成"目录点了跳偏"。 */
  const heads = tocOf(bodyHtml);
  /* 目录自带 01/02 序号，标题里再写「一、二、」就成了「02 一、先量，不猜」。
     只剥目录这一份文案，正文标题保持作者原样（有人就是喜欢给章节编号）。 */
  const tocLabel = (t) => String(t).replace(/^[一二三四五六七八九十百]+[、.．]\s*/, '');
  const toc =
    heads.length >= 3
      ? `<aside class="post-toc" aria-label="本文目录"><div class="toc-inner">
        <div class="toc-kicker">目录</div>
        <ol>${heads
          .map(
            (h, i) =>
              `<li><a href="#${esc(h.id)}" data-toc="${esc(h.id)}"><span class="toc-n">${String(i + 1).padStart(
                2,
                '0'
              )}</span><span class="toc-t">${esc(tocLabel(h.text))}</span></a></li>`
          )
          .join('')}</ol>
      </div></aside>`
      /* 标题少于 3 个时不出目录，但**不能连容器一起省掉**：
         .post-article 是两列 grid，第一个子元素落在 232px 那一列。
         少了 <aside>，正文就成了第一个子元素，被挤进目录列 —— 整篇文章压成
         180px 宽，右边一片空白。短文章（没有小标题的那种）全中，页面上不报错，
         只是「看着很窄」。留一个空 aside 占住位置。 */
      : '<aside class="post-toc" aria-hidden="true"></aside>';

  // 系列徽章：四个系列是站里最大的资产，得让人一眼看出"这是连载，可以追"
  const seriesIdx = post.series ? seriesPosts.findIndex((p) => p.slug === post.slug) : -1;
  const seriesChip =
    seriesIdx >= 0 && seriesPosts.length > 1
      ? `<a class="series-chip" href="#series"><span class="sc-dot"></span>${esc(post.series)} · 第 ${seriesIdx + 1}/${seriesPosts.length} 篇</a>`
      : '';

  const article = `<article class="post-article">
      ${toc}
      <div class="post-main">
      <header class="post-head">
        <h1>${esc(post.title)}${
          post.is_private ? ' <span class="tag" style="background:var(--accent-soft);color:var(--accent)">私密</span>' : ''
        }</h1>
        ${seriesChip}
        <div class="meta">
          ${post.avatar ? `<img class="avatar-xs" src="${esc(avatarSrc(post.avatar, 48))}" alt="" width="20" height="20" loading="lazy" decoding="async">` : ''}
          <span>${esc(post.author_name || post.login || '')}</span>
          <span class="sep-dot">${esc(fmtDay(post.published_at || post.created_at))}</span>
          <span class="sep-dot">${reading} 分钟阅读</span>
          ${
            post.updated_at && fmtDay(post.updated_at) !== fmtDay(post.published_at || post.created_at)
              ? `<span class="sep-dot">更新于 ${esc(fmtDay(post.updated_at))}</span>`
              : ''
          }
          <span class="post-edit" style="margin-left:auto"></span>
        </div>
      </header>
      ${lead}
      ${renderSeries(post, seriesPosts)}
      <div class="md post-body">${bodyHtml}</div>
      <footer class="post-foot"><div class="tagbar" style="margin:0">${tagbar}</div></footer>
      ${renderRelated(post, related)}
      ${renderAdjacent(post, sameCat, seriesPosts)}
      ${renderComments(cmtRows, cmtRows.length, user)}
      </div>
    </article>`;

  const meta = [
    `<title>${esc(post.title)} · ${esc(siteName)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    // 隐藏文章（不进首页/归档/sitemap）不该再被收录，否则等于绕开自己的分流
    post.hidden ? `<meta name="robots" content="noindex,follow">` : '',
    `<meta name="theme-color" content="${THEME_COLOR[site.theme] || '#f7f9fe'}">`,
    `<meta name="color-scheme" content="light dark">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<link rel="manifest" href="/manifest.webmanifest">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${esc(siteName)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:title" content="${esc(post.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:locale" content="zh_CN">`,
    `<meta property="og:image" content="${esc(ogImage)}">`,
    `<meta property="og:image:alt" content="${esc(post.title)}">`,
    ogKind ? `<meta property="og:image:type" content="${ogKind.type}">` : '',
    ogKind ? `<meta property="og:image:width" content="${ogKind.w}">` : '',
    ogKind ? `<meta property="og:image:height" content="${ogKind.h}">` : '',
    `<meta property="article:published_time" content="${esc(iso(post.published_at || post.created_at))}">`,
    `<meta property="article:modified_time" content="${esc(iso(post.updated_at, iso(post.published_at || post.created_at)))}">`,
    post.category ? `<meta property="article:section" content="${esc(catName(post.category))}">` : '',
    ...(post.tags || []).map((t) => `<meta property="article:tag" content="${esc(t)}">`),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(post.title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    `<meta name="twitter:image" content="${esc(ogImage)}">`,
    // 隐藏文章已经 noindex，再输出 BlogPosting 等于一边说别收录、一边递结构化数据，语义打架
    post.hidden
      ? ''
      : ldJson(
          postLd({
            post: { ...post, comments: cmtRows.length },
            site,
            origin,
            url: canonical,
            image: ogImage,
            words,
          })
        ),
  ]
    .filter(Boolean)
    .join('\n  ');

  const boot = {
    id: post.id,
    slug: post.slug,
    title: post.title,
    author: post.author_name || post.login || '',
    author_id: post.author_id,
    is_private: !!post.is_private,
    published_at: post.published_at || post.created_at,
    created_at: post.created_at,
    updated_at: post.updated_at,
    summary: post.summary || '',
    summary_src: post.summary_src || '',
    category: post.category || '',
    tags: post.tags || [],
    reading,
    html: true,
  };

  const injected = tpl
    .replace('<!--SEO-->', meta)
    .replace(
      '</head>',
      `<script>window.__POST__=${JSON.stringify(boot).replace(/</g, '\\u003c')};</script></head>`
    )
    .replace(/<main class="wrap" id="page"[^>]*>[\s\S]*?<\/main>/, `<main class="wrap wrap-post" id="page" tabindex="-1">${article}</main>`);

  return html(stampAssets(injected, env), 200, {
    // 私密文章不进缓存；公开文章统一走 pageCacheControl（浏览器不缓存、边缘 300s + SWR 86400）
    'cache-control': post.is_private ? 'private, no-store' : pageCacheControl(),
    // 自检用：这份 HTML 是命中进程内热缓存还是回源查的 D1。只在回源那一次有意义
    //（edge cache 命中时根本走不到这里）
    'x-post-cache': cached ? 'hit' : 'miss',
  });
}

/* ---------- 导航栏 SSR ----------
   以前 #site-header 是个空 div，导航要等 app.js（module）下载+执行完才出现，
   首屏顶部先空一块再突然长出来，肉眼能看见跳动。现在由 Worker 直接渲染好，
   JS 只补「登录/后台/退出」这一小块用户态内容（HTML 是缓存的，不能带用户信息）。 */
const NAV = [
  { href: '/', label: '首页', key: 'home' },
  { href: '/categories', label: '栏目', key: 'categories' },
  { href: '/series', label: '系列', key: 'series' },
  { href: '/archive', label: '归档', key: 'archive' },
  { href: '/friends', label: '友链', key: 'friends' },
  { href: '/about', label: '关于', key: 'about' },
];

const THEME_BTN = `<button class="theme-btn" data-theme-btn type="button" aria-label="切换风格" aria-expanded="false" title="切换风格"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18 2.2 2.2 0 0 0 1.7-3.6 2.2 2.2 0 0 1 1.7-3.6H18A3 3 0 0 0 21 10.8 9 9 0 0 0 12 3Z"/><circle cx="8" cy="9.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.4" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="16.4" cy="9.4" r="1.1" fill="currentColor" stroke="none"/></svg></button>`;

/* ---------- 全站页脚 ----------
   只在读者页注入（injectTheme 里用 isPagePath 判断），后台/登录页不带。
   站名取站点设置，GitHub 是作者主页常量；明暗三按钮复用主题系统的
   data-mode-pick 属性，theme.js 的 syncUI 会自动同步选中态。 */
const AUTHOR_GITHUB = 'https://github.com/Exia-blip';
const MODE_ICON = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8Z"/></svg>',
};
function siteFooter(site) {
  const name = esc(site.name || 'Exia Blog');
  const year = new Date().getUTCFullYear();
  const modes = ['light', 'auto', 'dark']
    .map(
      (m) =>
        `<button type="button" class="foot-mode" data-mode-pick="${m}" aria-label="${{ light: '浅色', auto: '跟随系统', dark: '深色' }[m]}" title="${{ light: '浅色', auto: '跟随系统', dark: '深色' }[m]}">${MODE_ICON[m]}</button>`
    )
    .join('');
  return `<footer class="site-foot"><div class="sf-inner">
  <div class="sf-line"><a href="/">${name}</a><span class="sf-dot">·</span><a href="${AUTHOR_GITHUB}" target="_blank" rel="noopener noreferrer">GitHub</a></div>
  <div class="sf-bottom"><span class="sf-copy">© ${year} ${name}</span>
  <div class="sf-modes" role="group" aria-label="外观模式">${modes}</div></div>
</div></footer>`;
}

/* 窄屏汉堡：640 以下导航整块收进抽屉，站名才不会被压成「Exia Bl...」。
   按钮与抽屉都在 SSR 里出，JS 没跑也能看见入口（点了没反应好过看不见）。 */
const NAV_TOGGLE = `<button class="nav-toggle" id="nav-toggle" type="button" aria-label="打开导航" aria-expanded="false" aria-controls="site-nav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path class="nt-a" d="M4 7h16"/><path class="nt-b" d="M4 12h16"/><path class="nt-c" d="M4 17h16"/></svg></button>`;

// 各主题主色，用于浏览器地址栏（theme-color）
const THEME_COLOR = {
  anzhiyu: '#f7f9fe',
  paper: '#faf9f7',
  ink: '#f6f6f4',
  forest: '#f4f7f2',
  ocean: '#f2f7fa',
  plum: '#faf5f8',
  mono: '#ffffff',
};

function activeKey(path) {
  if (path === '/') return 'home';
  if (path === '/categories') return 'categories';
  if (path.startsWith('/series')) return 'series';
  if (path.startsWith('/archive')) return 'archive';
  if (path.startsWith('/friends')) return 'friends';
  if (path.startsWith('/about')) return 'about';
  if (path.startsWith('/editor')) return 'editor';
  return '';
}

function renderHeader(site, path) {
  const active = activeKey(path);
  const name = site.name || 'Exia Blog';
  const desc = (site.desc || '').trim();
  const avatar = site.avatar
    ? `<img class="brand-avatar" src="${esc(avatarSrc(site.avatar, 64))}" alt="" width="32" height="32" loading="eager" decoding="async">`
    : `<span class="brand-avatar ph" aria-hidden="true">${esc((name.trim() || 'E').charAt(0).toUpperCase())}</span>`;

  const extra = [];
  if (path.startsWith('/tag/')) {
    const t = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (t) extra.push(`<a href="${esc(path)}" class="active" aria-current="page">#${esc(t)}</a>`);
  } else if (path.startsWith('/cat/')) {
    const c = catBySlug(decodeURIComponent(path.slice(5).split('/')[0] || ''));
    if (c) extra.push(`<a href="/cat/${c.slug}" class="active" aria-current="page">${esc(c.name)}</a>`);
  }

  // aria-current 不是一个装饰：屏幕阅读器靠它回答「我现在在哪一页」，
  // 光靠视觉上的 .active 底色，读屏用户听不出区别。
  const links = NAV.map(
    (l) =>
      `<a href="${l.href}"${active === l.key ? ' class="active" aria-current="page"' : ''}>${l.label}</a>`
  ).join('');

  /* nav-user 先按匿名访客填上「登录」。留空等 JS 填的话，
     那一格会从 0 宽长到 51px，整条导航跟着左移 —— 又是一次布局偏移。
     已登录的访客会被 app.js 换成后台入口，位置宽度差不多，不跳。 */
  return `<header class="site">
    <div class="inner">
      <a class="brand" href="/">${avatar}<span class="brand-name">${esc(name)}<span class="dot">.</span></span></a>
      ${desc ? `<span class="brand-desc" title="${esc(desc)}">${esc(desc)}</span>` : ''}
      <nav class="top" id="site-nav">${links}${extra.join('')}<span id="nav-user"><a href="/login">登录</a></span>${THEME_BTN}</nav>
      ${NAV_TOGGLE}
    </div>
  </header>`;
}

/* 首页横幅文案也先在服务端填好：标签页/分类页复用首页骨架，
   首屏就不该先显示站名再被 JS 改成「#标签」，那一下闪得最明显 */
function renderHero(body, site, path) {
  if (!body.includes('id="hero-title"')) return body;
  const name = site.name || '';
  const desc = site.desc || '记录思考、代码与生活。';
  // 只改首页与标签/栏目页的 H1：
  // 归档页 / 栏目总览 / 友链页自己有标题，被站名盖掉等于把页面 H1 写成了品牌名
  if (path !== '/' && !path.startsWith('/tag/') && !path.startsWith('/cat/')) return body;

  let title = name;
  let sub = desc;
  let boot = '';
  if (path.startsWith('/tag/')) {
    const t = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (t) {
      title = `#${t}`;
      sub = `标签「${t}」下的全部文章`;
    }
  } else if (path.startsWith('/cat/')) {
    const c = catBySlug(decodeURIComponent(path.slice(5).split('/')[0] || ''));
    if (c) {
      title = c.name;
      sub = c.desc || `栏目「${c.name}」下的全部文章`;
      // 前端要按栏目名显示标题、按 slug 拼链接，别让它再拿路径里的 slug 当名字
      boot = `<script>window.__CAT__=${JSON.stringify({ slug: c.slug, name: c.name, desc: c.desc }).replace(
        /</g,
        '\\u003c'
      )};</script>`;
    }
  }
  const out = body
    .replace(/(<h1 id="hero-title"[^>]*>)[\s\S]*?(<\/h1>)/, `$1${esc(title)}$2`)
    .replace(/(<p id="hero-sub"[^>]*>)[\s\S]*?(<\/p>)/, `$1${esc(sub)}$2`);
  return boot ? out.replace('</head>', `${boot}</head>`) : out;
}

/* ---------- 首页文章列表 SSR ----------
   以前首页 HTML 里只有一句「加载中…」，内容和分页都得等 /api/posts 回来。
   现在首屏直接把第一页写进 HTML：搜索引擎能抓到正文摘要，用户也不用等一圈往返。 */
const SKELETON = Array.from({ length: 3 })
  .map(
    () =>
      '<div class="sk-card"><div class="sk sk-thumb"></div><div class="sk-body"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div></div>'
  )
  .join('');

/* 列表缩略图。两个点：
   ① /img/ 下的对象是用户原图，R2 里有对应的 .webp / .avif 变体（make-variants 生成）。
      之前变体转完就没人引用 —— 108×78 的方框照样下 140KB 的 jpg。
      用 <picture> 让支持 avif 的浏览器拿 79KB。变体缺失时 serveImage 会逐级退回原图，
      所以 source 写死了也不会裂图。
   ② 第一张给 eager + fetchpriority=high。lazy 要等布局算完才发起请求，
      而第一张图恰好经常就是 LCP 元素 —— 这一下能白丢几百毫秒。 */
function thumbTag(url, first = false) {
  const u = String(url || '');
  const attrs = first ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const img = `<img class="thumb" src="${esc(u)}" alt="" ${attrs} decoding="async" width="108" height="78">`;
  // /thumbs/* 是构建时生成的 webp，/cards/* 是 png 标题卡，都没有 R2 变体
  if (!/^\/img\//.test(u)) return img;
  const variant = (ext) => {
    const [base, q] = u.split('?');
    return q ? `${base}.${ext}?${q}` : `${base}.${ext}`;
  };
  return `<picture><source type="image/avif" srcset="${esc(variant('avif'))}"><source type="image/webp" srcset="${esc(
    variant('webp')
  )}">${img}</picture>`;
}

function postCard(p, i = 0) {
  // 卡片永远有图：shapePost 已经兜过一层，这里再兜一次是防「传进来的是原始行」
  const cover = thumbTag(thumbOf(p), i === 0);
  const tags = (p.tags || [])
    .slice(0, 3)
    .map((t) => `<span class="tag">#${esc(t)}</span>`)
    .join('');
  return `<a class="post-card" href="/p/${encodeURIComponent(p.slug)}">${cover}<div class="body"><h2>${esc(p.title)}${
    p.is_private ? ' <span class="tiny muted">私密</span>' : ''
  }</h2>${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ''}<div class="meta"><span>${esc(
    fmtDay(p.published_at || p.created_at)
  )}</span><span class="sep-dot">${p.reading} 分钟</span>${
    p.comments ? `<span class="sep-dot">${p.comments} 条评论</span>` : ''
  }${p.category ? `<span class="tag cat-chip">${esc(p.category_name || catName(p.category))}</span>` : ''}${tags}</div></div></a>`;
}

function pagerHtml(page, pages, total, base) {
  if (pages <= 1) return '';
  const href = (p) => `${base}?page=${p}`;
  return [
    page > 1 ? `<a class="btn sm" href="${href(page - 1)}">← 上一页</a>` : '',
    `<span class="page-info">${page} / ${pages}　共 ${total} 篇</span>`,
    page < pages ? `<a class="btn sm" href="${href(page + 1)}">下一页 →</a>` : '',
  ].join('');
}

/* 列表页 SSR 拆成两半：
   - listQuery：只查数据库，不碰 HTML —— 这样它能和站点设置、栏目计数一起并发
   - applyList：纯字符串替换，跑在 THEME/SEO/header 都换完之后
   合在一起写的话，查询会在模板还没替换时就把 body 复制走，返回时把前面的替换全盖掉。 */
function listParams(url) {
  const path = url.pathname;
  let tag = '';
  let cat = '';
  if (path.startsWith('/tag/')) tag = decodeURIComponent(path.slice(5).split('/')[0] || '');
  else if (path.startsWith('/cat/')) cat = decodeURIComponent(path.slice(5).split('/')[0] || '');
  else if (path !== '/') return null;

  // 搜索结果分页靠前端接管，这里只兜首屏
  if (url.searchParams.get('q')) return null;

  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const base = tag ? `/tag/${encodeURIComponent(tag)}` : cat ? `/cat/${encodeURIComponent(cat)}` : '/';
  return { tag, cat, page, base };
}

/* 首页导语位：固定三篇代表作。新访客第一眼看到的不是"最新"，而是"该从哪读起"。
   只查这三条，不参与列表排序 —— 精选是编辑决定，不该被发布时间推着走。 */
const PICKS = ['d1-no-such-table', 'oauth-device-flow', 'editor-markdown-xss'];

async function pickPosts(db) {
  try {
    const { results } = await db
      .prepare(
        `SELECT slug, title, category, published_at FROM posts
         WHERE slug IN (${PICKS.map(() => '?').join(',')}) AND is_private = 0 AND hidden = 0 AND ${liveSql('posts')}`
      )
      .bind(...PICKS)
      .all();
    const by = new Map(results.map((r) => [r.slug, r]));
    return PICKS.map((s) => by.get(s)).filter(Boolean);
  } catch (e) {
    console.error('picks failed', e);
    return [];
  }
}

function picksHtml(list) {
  if (!list || !list.length) return '';
  const rows = list
    .map(
      (p, i) => `<a class="pick" href="/p/${encodeURIComponent(p.slug)}">
        <span class="pick-n">${String(i + 1).padStart(2, '0')}</span>
        <span class="pick-t">${esc(p.title)}</span>
        <span class="pick-m">${esc(catName(p.category))}</span>
      </a>`
    )
    .join('');
  return `<section class="picks" aria-label="先读这三篇">
    <div class="picks-kicker">不知道从哪读起</div>
    ${rows}
  </section>`;
}

async function listQuery(env, url) {
  const p = listParams(url);
  if (!p) return null;
  try {
    const [data, picks] = await Promise.all([
      listPosts(env.DB, { page: p.page, size: 10, tag: p.tag, cat: p.cat }),
      p.base === '/' && p.page === 1 ? pickPosts(env.DB) : null,
    ]);
    return { ...p, data, picks };
  } catch (e) {
    console.error('list ssr failed', e);
    return { ...p, data: null };
  }
}

function applyList(body, res) {
  if (!body.includes('<!--LIST-->') || !res) return { body, list: null };
  if (!res.data) return { body: body.replace('<!--LIST-->', SKELETON), list: null };

  const data = res.data;
  const cards = data.posts.length
    ? data.posts.map(postCard).join('')
    : `<div class="empty">${res.tag || res.cat ? '这个栏目下还没有文章' : '还没有文章，去写第一篇吧'}</div>`;

  const boot = JSON.stringify({ page: data.page, pages: data.pages, total: data.total }).replace(/</g, '\\u003c');
  const out = body
    .replace('<!--LIST-->', (res.picks ? picksHtml(res.picks) : '') + cards)
    .replace('<!--PAGER-->', pagerHtml(res.page, data.pages, data.total, res.base))
    .replace('</head>', `<script>window.__LIST__=${boot};</script></head>`);

  return { body: out, list: data };
}

/* ---------- 栏目页 SSR：四个固定栏目直接进 HTML ----------
   栏目就四个，哪怕暂时没有文章也该出现在页面上（空栏目比缺栏目好解释），
   顺便让栏目页对爬虫是一张有内容的目录页，而不是「加载中…」。 */
/* 栏目计数单独拿出来：它和文章列表、站点设置互不依赖，
   在 injectTheme 里一起发出去才能真的并行（原来是一个 await 接一个）。 */
async function catCounts(env) {
  const counts = new Map();
  try {
    const { results } = await env.DB.prepare(
      `SELECT category, COUNT(*) AS count FROM posts
       WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')} GROUP BY category`
    ).all();
    for (const r of results) {
      const slug = normalizeCat(r.category);
      if (!slug) continue;
      counts.set(slug, (counts.get(slug) || 0) + (Number(r.count) || 0));
    }
  } catch (e) {
    console.error('cat ssr failed', e);
  }
  return counts;
}

/* 纯字符串拼装，不再碰数据库 —— 数据由调用方并行取好传进来 */
function renderCats(body, counts, tags) {
  if (!body.includes('<!--CATS-->') && !body.includes('<!--TAGS-->')) return body;

  const cells = CATS.map(
    (c) => `<a class="tax-cell cat-cell" href="/cat/${c.slug}">
      <span class="tax-name">${esc(c.name)}<span class="cat-slug">${esc(c.slug)}</span></span>
      <span class="tax-desc">${esc(c.desc)}</span>
      <span class="tax-count">${counts.get(c.slug) || 0}</span>
    </a>`
  ).join('');

  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  let out = body
    .replace('<!--CATS-->', cells)
    .replace('<!--CAT-TOTAL-->', `${CATS.length} 个栏目 · ${sum} 篇`);

  /* 标签云也直出：/tag/* 页面的唯一入口就是这里，
     客户端渲染等于把整个标签体系对爬虫关掉。 */
  if (out.includes('<!--TAGS-->')) {
    const list = tags || [];
    const cloud = list.length
      ? list
          .map(
            (t) => `<a class="tax-cell" href="/tag/${encodeURIComponent(t.name)}">
      <span class="tax-name">#${esc(t.name)}</span>
      <span class="tax-count">${t.count}</span>
    </a>`
          )
          .join('')
      : '<div class="empty">还没有标签。正文里写 <code>#标签</code> 会自动归集。</div>';

    out = out
      .replace('<!--TAGS-->', cloud)
      .replace('<!--TAG-TOTAL-->', list.length ? `${list.length} 个标签` : '');
  }

  return out;
}

/* ---------- 静态页 SEO：站点名进标签页标题、站点描述进 meta ----------
   文章页的 <!--SEO--> 已在 servePostPage 里换掉，这里只兜静态页（首页/归档/栏目/友链…） */
function fillSeo(body, site, url) {
  if (!body.includes('<!--SEO-->')) return body;

  const m = body.match(/<title>([\s\S]*?)<\/title>/i);
  let label = (m?.[1] || '').replace(/\s+/g, ' ').trim();
  let cat = null;
  // 标签页/栏目页复用首页骨架，标题得按路径算，不能沿用「首页」
  if (url) {
    const p = url.pathname;
    if (p.startsWith('/tag/')) {
      const t = decodeURIComponent(p.slice(5).split('/')[0] || '');
      if (t) label = `#${t}`;
    } else if (p.startsWith('/cat/')) {
      cat = catBySlug(decodeURIComponent(p.slice(5).split('/')[0] || ''));
      if (cat) label = cat.name;
    }
  }
  const home = !label || label === '首页';
  const title = home ? site.name : `${label} · ${site.name}`;
  /* 描述按页面类型分三种，都比全站一句通用话贴主题：
     栏目页用栏目自己的说明，标签页说明「这一页是什么」，其它退回站点描述。
     统一过 metaDesc：换行压平、超长截断、空值兜底。 */
  const isTag = !!(url && url.pathname.startsWith('/tag/'));
  const desc = metaDesc(cat ? cat.desc : isTag ? `${label} 标签下的全部文章` : '', site.desc || `${site.name} · 记录思考、代码与生活`);
  const canonical = url ? new URL(url.pathname, url.origin).toString() : '';
  const origin = url ? url.origin : '';
  // 分享图固定用本站那张 1200×630：尺寸、域名、可用性都在自己手里
  const ogImage = `${origin}/og-default.jpg`;

  // 搜索结果页是客户端渲染的，爬虫拿不到结果列表；加 noindex 省抓取配额，
  // 但保留 follow —— 结果里的文章链接仍值得被发现
  const isSearch = !!(url && (url.searchParams.get('q') || '').trim());

  const block = [
    `<title>${esc(title)}</title>`,
    isSearch ? `<meta name="robots" content="noindex,follow">` : '',
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="theme-color" content="${THEME_COLOR[site.theme] || '#f7f9fe'}">`,
    `<meta name="color-scheme" content="light dark">`,
    canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '',
    `<link rel="manifest" href="/manifest.webmanifest">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    canonical ? `<meta property="og:url" content="${esc(canonical)}">` : '',
    `<meta property="og:locale" content="zh_CN">`,
    `<meta property="og:image" content="${esc(ogImage)}">`,
    `<meta property="og:image:alt" content="${esc(site.name)}">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    `<meta name="twitter:image" content="${esc(ogImage)}">`,
  ]
    .filter(Boolean)
    .join('\n  ');

  const stripped = m ? body.replace(/<title>[\s\S]*?<\/title>\s*/i, '') : body;
  return stripped.replace('<!--SEO-->', block);
}

/* 首页顶部那两条筛选栏（栏目 / 标签）直出到 HTML。

   它们原来是两个空 div，等 app.js 拉完 /api/categories 再 innerHTML 填进去。
   代价是首屏已经画完、读者开始看了，整块列表突然往下推 90 多像素 ——
   实测 0.0176 的 CLS 全部来自这里（图片的 width/height 早就补齐了）。

   数据本来就是现成的：injectTheme 为了别的页面已经在并行取栏目计数和标签云，
   这里只是真的把它们用掉，不额外增加一次 D1 往返。
   客户端拿到 SSR 内容后只改选中态，不再整体重绘。 */
function renderListBars(body, counts, tags, url) {
  const needCat = body.includes('<!--CATBAR-->');
  const needTag = body.includes('<!--TAGBAR-->');
  if (!needCat && !needTag) return body;

  const path = url ? url.pathname : '';
  const curCat = (path.match(/^\/cat\/([^/]+)/) || [])[1] || '';
  const curTag = (path.match(/^\/tag\/([^/]+)/) || [])[1] || '';
  const hl = (on) => (on ? ' style="background:var(--accent-soft);color:var(--accent)"' : '');

  let out = body;
  if (needCat) {
    const rows = CATS.map(
      (c) =>
        `<a class="tag cat-chip" href="/cat/${c.slug}" title="${esc(c.desc)}"${hl(curCat === c.slug)}>${esc(c.name)} ${
          counts.get(c.slug) || 0
        }</a>`
    ).join('');
    out = out.replace(
      '<!--CATBAR-->',
      `<span class="bar-label">栏目</span><a class="tag" href="/"${hl(!curCat && !curTag)}>全部</a>${rows}`
    );
  }
  if (needTag) {
    const rows = (tags || [])
      .map(
        (t) =>
          `<a class="${tagClass(t.name, t.count)}" href="/tag/${encodeURIComponent(t.name)}"${hl(curTag === t.name)}>#${esc(t.name)} ${
            t.count
          }</a>`
      )
      .join('');
    out = out.replace('<!--TAGBAR-->', `<span class="bar-label">标签</span><a class="tag" href="/"${hl(!curTag)}>全部</a>${rows}`);
  }
  return out;
}

/* ---------- 主题默认值注入（首访不闪） ---------- */
async function injectTheme(env, res, url) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return res;

  let body = await res.text();
  if (!body.includes('<!--THEME-->')) return new Response(body, res);

  /* 这一页要的三份数据互不依赖：站点设置、文章列表、栏目/标签计数。
     以前是一个 await 接一个，线上冷启动 cfWorker 跑到 500ms+ 大部分耗在这串行上。
     现在先全部发出去，最慢的那条决定总时长。 */
  const siteP = getSite(env);
  const catsP =
    body.includes('<!--CATS-->') || body.includes('<!--CATBAR-->') ? catCounts(env) : Promise.resolve(new Map());
  const tagsP =
    body.includes('<!--TAGS-->') || body.includes('<!--TAGBAR-->') ? tagsData(env.DB).catch(() => []) : Promise.resolve(null);
  // 列表只依赖模板和 URL，不依赖站点设置，所以这里就能先发车
  const listP = listQuery(env, url);

  const [s, counts, tags] = await Promise.all([siteP, catsP, tagsP]);

  const cfg = JSON.stringify({ theme: s.theme, mode: s.mode }).replace(/</g, '\\u003c');
  // 站点头像与站名先落到 window.__SITE__，导航渲染时能立刻用。
  // avatar 这里就换成代理地址：前端 avatarSrc() 见到 /avatar 会原样用，
  // 不会再套一层；而首屏源码里也就不再出现 githubusercontent。
  const siteCfg = JSON.stringify({
    name: s.name,
    desc: s.desc,
    avatar: avatarSrc(s.avatar, 128),
    // 只下发公开的 site key；secret 只在 Worker 里，永不进页面
    turnstile: env.TURNSTILE_SITE_KEY || '',
  }).replace(/</g, '\\u003c');
  // 图标用本站文件，不再把 GitHub 头像当 favicon（外链一换就白图，尺寸也不对）
  const icon =
    '<link rel="icon" href="/favicon.ico" sizes="any">' +
    '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">' +
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
  /* 非纸韵/安知鱼的主题，样式表直接在 head 里直出。
     以前这段是内联脚本里的 document.write —— 在那之前解析器必须停下来等脚本执行，
     而 document.write 插入的 link 又会把渲染卡到 CSS 到手。直出之后浏览器
     解析到 link 就开始下载，跟后面的 style.css 并行。
     用户自己换过主题时，head 里那段脚本会把这个 link 的 href 改掉（见模板）。 */
  const themeCss = themeCssTag(s.theme, assetVersion(env));
  const inject =
    `<script>window.__THEME_DEFAULT__=${cfg};window.__SITE__=${siteCfg};</script>${icon}${themeCss}`;

  body = fillSeo(body, s, url).replace('<!--THEME-->', inject);

  // 导航栏直接渲染进 HTML，省掉首屏空白与跳动
  body = body.replace(/<div id="site-header"[^>]*><\/div>/, renderHeader(s, url.pathname));
  body = renderHero(body, s, url.pathname);

  const { body: listed, list } = applyList(body, await listP);
  body = renderCats(listed, counts, tags);
  body = renderListBars(body, counts, tags, url);

  // 结构化数据：站点一条，列表页再加 CollectionPage
  const ld = [ldJson(siteLd(s, url.origin))];
  if (list) {
    const title = (body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || s.name).trim();
    ld.push(
      ldJson(
        listLd({
          site: s,
          origin: url.origin,
          url: url.toString(),
          name: title,
          desc: s.desc,
          posts: list.posts,
        })
      )
    );
  }
  body = body.replace('</head>', `${ld.join('\n')}</head>`);
  /* 全站页脚：只对读者页注入。isPagePath 不含 /editor、/login、/admin/*，
     这样后台与登录页不会多一条读者导航。用 marker 重复注入时兜底替换。 */
  if (isPagePath(url.pathname)) {
    body = body.replace(/<footer class="site-foot">[\s\S]*?<\/footer>\s*/, '');
    body = body.replace('</body>', `${siteFooter(s)}</body>`);
  }
  // 资源带部署版本号，静态资源才能一年强缓存
  body = stampAssets(body, env);

  const headers = new Headers(res.headers);
  headers.delete('content-length');
  /* 103 Early Hints。Cloudflare 看到响应里的 Link: rel=preload，会在 HTML body
     之前先发一个 103，浏览器收到就开始下 CSS —— 不用等 HTML 流解析到那一行。

     它对 TTFB 没帮助（那时 TLS 和 Worker 都已经跑完了），省的是「HTML 开始到手」
     到「CSS 开始下载」之间那段，也就是 LCP 前最后一道串行。

     只放样式表，不放首图：首图走 <picture> + srcset，浏览器按 sizes 和 DPR
     自己挑档位；Link 头只能写一个固定 URL，等于替浏览器做决定，挑错了就是先白下
     一份再下正确的那份。CSS 没有维度、地址唯一，是唯一适合放进 103 的东西。

     站上要开：Dashboard → Speed → Content Optimization → Early Hints。
     不开也不会坏，这个头退化成普通响应头（浏览器照样当 preload 处理）。

     版本号必须取**内容哈希**，不能取部署号：preload 的 URL 与 HTML 里的
     href 差一个字符，浏览器就当两个资源，103 提前下的那份全程没人用 ——
     等于每次冷访问白下一遍 121KB 的 CSS，而且两份都会被边缘缓存住。
     拿不到哈希时宁可不发 Link 头，也不发一个错的。 */
  const cssHash = ASSET_HASH['style.css'] && ASSET_HASH['style.css'].v;
  const hints = [];
  if (cssHash) hints.push(`</style.css?v=${cssHash}>; rel=preload; as=style`);
  const themeHref = themeCssPath(s.theme);
  const themeHash = themeHref && ASSET_HASH[themeHref.replace(/^\//, '')];
  if (themeHref && themeHash) hints.push(`<${themeHref}?v=${themeHash.v}>; rel=preload; as=style`);

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
  headers.set('link', hints.join(', '));
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* 统一加安全头：HTML 顺带给内联脚本发 nonce（缓存里存的也是配对好的头，回放不会错位） */
/* 外部统计服务（可选）。
   默认走自己记的 /api/pv，一个第三方脚本都不引；
   只有显式配了 UMAMI_SCRIPT + UMAMI_SITE_ID 才换成 umami，并顺手关掉自建上报 ——
   两套同时开着，两边数字会互相矛盾，没人能判断哪个是真的。

   两个值必须成对：只填 script 不填 site id 时，脚本会正常下载、正常执行，
   但一句上报都发不出去（没有 website id 就不知道该记到哪个站点）。
   那种半配状态比完全不配更糟 —— 自建上报已经被 __PV_OFF__ 关掉了，
   两边都没有数据。所以缺一个就整体退回自建。 */
function analyticsCfg(env) {
  // 成对判断统一走 utils 里那一份，避免「页面关了、服务端还在收」
  if (!umamiOn(env)) return null;
  const src = String(env.UMAMI_SCRIPT).trim();
  const id = String(env.UMAMI_SITE_ID).trim();
  let u;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  /* 采集端不一定和脚本同域，映射放在 utils 里一份，验收脚本也用同一份 */
  return { src: src, id: id, script: u.origin, collect: collectOrigins(src) };
}

function analyticsTag(cfg) {
  if (!cfg) return '';
  return (
    `<script>window.__PV_OFF__=1</script>` +
    `<script defer src="${esc(cfg.src)}" data-website-id="${esc(cfg.id)}"></script>`
  );
}

/* 后台私有页：写作页与各管理页。这些页面不进边缘缓存——
   否则部署后 CF 边缘还会吐最多 1 天的旧副本（s-maxage + swr），
   表现为「明明部署了，刷新还是旧界面」。后台是单人用的，没有缓存价值。 */
export const isAdminPath = (p) =>
  p === '/editor' || p.startsWith('/editor/') || p.startsWith('/admin/');

/* 写作页服务端门禁：匿名访客不该拿到 55KB 的完整后台骨架（内含全部字段名和
   视图结构）。这些页本来就不进边缘缓存（isPagePath 不含 /editor，且带 sid 绕过），
   所以在 route() 入口用与 /api/settings 同一套 currentUser 判一次即可，
   未登录直接 302 到登录页，登录后带着 next 原路返回。
   next 取自本站请求的 path+search，是站内相对路径，无开放重定向面；
   /auth/* 自己处理登录流程，不走这里，避免 loginRedirect 被二次拦截。 */
export async function editorGate(env, request, path) {
  if (path !== '/editor' && !path.startsWith('/editor/')) return null;
  if (await currentUser(env, request)) return null;
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  const to = new URL('/login', url.origin);
  to.searchParams.set('next', next);
  return new Response(null, {
    status: 302,
    headers: { location: to.toString(), 'cache-control': 'no-store' },
  });
}

export async function harden(res, env, path = '') {
  // 配了 Turnstile 才在 CSP 里放行它的域名；没配就保持零第三方
  const tsOn = !!(env && env.TURNSTILE_SITE_KEY);
  const anCfg = analyticsCfg(env);
  const anOn = anCfg ? { script: anCfg.script, collect: anCfg.collect } : null;
  const ct = res.headers.get('content-type') || '';
  /* 图片代理出来的响应不参与任何 HTML 加工 —— 哪怕它的 content-type 被写成 text/html。
     否则 applyNonce 会给攻击者塞进来的 <script> 签上本站 nonce，CSP 的
     script-src 'nonce-…' 反而成了「已批准」的印章。imageResponse 那边已经统一降级成
     application/octet-stream 了，这里再加一道，防止以后有人改坏那个判断。 */
  if (res.headers.get('x-img-type') || !ct.includes('text/html')) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: securityHeaders(new Headers(res.headers), null, { turnstile: tsOn }),
    });
  }
  const nonce = makeNonce();
  let raw = await res.text();
  const ana = analyticsTag(anCfg);
  // 放在补 nonce 之前：这段 script 自己也是内联的，得跟别的一起拿到 nonce
  if (ana) raw = raw.replace('</head>', ana + '</head>');
  // 先混淆邮箱再补 nonce：解码脚本是内联的，得跟着一起拿到 nonce
  const body = applyNonce(obfuscateEmail(raw), nonce);
  const headers = securityHeaders(new Headers(res.headers), nonce, { turnstile: tsOn, analytics: anOn });
  /* 统一缓存口径，但只管「正常页面」。
     4xx/5xx 不能跟 200 用同一套：一张 404 页在边缘压 300 秒，意味着
     刚发布的文章地址会在这 5 分钟里继续回 404；一张 500 页更不该被缓存，
     否则一次数据库抖动会被定格成整站错误页。调用方给了头就尊重调用方，
     没给才用这里的兜底。 */
  const cc = (headers.get('cache-control') || '').toLowerCase();
  const normal = res.status >= 200 && res.status < 400;
  if (normal) {
    if (isAdminPath(path)) {
      // 后台页：浏览器与 CF 边缘都不缓存，改完立刻可见
      headers.set('cache-control', 'private, no-store');
      headers.set('cdn-cache-control', 'private, no-store');
    } else {
      if (!cc.includes('no-store') && !cc.includes('private')) headers.set('cache-control', pageCacheControl());
      headers.set('cdn-cache-control', `public, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`);
    }
  } else if (!headers.has('cache-control') || cc === 'no-cache') {
    headers.set('cache-control', res.status === 404 ? 'public, max-age=0, s-maxage=60' : 'no-store');
  }
  headers.delete('content-length');
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/* ---------- 404 ---------- */
async function notFoundPage(env, request, message = '页面走丢了') {
  const site = await getSite(env);
  const siteName = esc(site.name);
  const cfg = JSON.stringify({ theme: site.theme, mode: site.mode }).replace(/</g, '\\u003c');
  /* 走错路的人多半是在找某篇文章。搜框之外再给几条最近的公开文章，
     按 liveSql 走同一条时间闸门 —— 排期未到的文章不能在 404 页被剧透。
     这条查询失败也不能把 404 页一起拖成 500。 */
  const { results: recent = [] } = await env.DB.prepare(
    `SELECT slug, title FROM posts WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')}
     ORDER BY COALESCE(NULLIF(published_at, ''), created_at) DESC LIMIT 5`
  )
    .all()
    .catch(() => ({ results: [] }));
  const recentHtml = recent.length
    ? `<div class="g404-recent"><div class="g404-hint">最近更新</div><ul>${recent
        .map((p) => `<li><a href="/p/${encodeURIComponent(p.slug)}">${esc(p.title)}</a></li>`)
        .join('')}</ul></div>`
    : '';
  /* 走错路的人第一眼该知道自己站在谁的地盘上。这里只放一条静态品牌线，
     不放整条导航 —— 404 不加载 app.js，而导航抽屉（汉堡）的交互正好在 app.js 里，
     放一条点不动的导航比没有导航更糟。 */
  const brandHtml = `<div class="g404-brand"><a href="/">${
    site.avatar
      ? `<img src="${esc(avatarSrc(site.avatar, 64))}" alt="" width="26" height="26" decoding="async">`
      : `<span class="g404-av" aria-hidden="true">${esc((site.name || 'E').trim().charAt(0).toUpperCase())}</span>`
  }<span>${siteName}</span></a></div>`;
  return html(
    stampAssets(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 · ${siteName}</title>
<meta name="robots" content="noindex,follow">
<meta name="description" content="页面不存在">
<script>window.__THEME_DEFAULT__=${cfg};(function(){var d=document.documentElement,t=null,m=null;try{t=localStorage.getItem('x_theme');m=localStorage.getItem('x_mode')}catch(e){}var g=window.__THEME_DEFAULT__||{};t=t||g.theme||'paper';m=m||g.mode||'auto';var sys=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;var dark=(m==='dark')||(m!=='light'&&sys);d.setAttribute('data-theme',t);d.setAttribute('data-mode',dark?'dark':'light');d.setAttribute('data-mpref',m);(function(){var L=document.getElementById('tcss-default'),trivial=(t==='paper'||t==='anzhiyu');if(trivial){if(L)document.head.removeChild(L);return}if(L){L.id='tcss-'+t;L.href='/theme/'+t+'.css'}else{var S=document.createElement('link');S.id='tcss-'+t;S.rel='stylesheet';S.href='/theme/'+t+'.css';document.head.appendChild(S)}})()})();</script>
<link rel="stylesheet" href="/style.css">
<script src="/boot.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">跳到正文</a>
<main class="g404" id="main" tabindex="-1">${brandHtml}<div><h1>404</h1><p>${esc(message)}</p>
<form action="/" method="get" role="search"><input type="search" name="q" placeholder="搜一下想找的内容…" aria-label="搜索文章"><button type="submit">搜索</button></form>
${recentHtml}<div class="g404-foot"><a href="/archive">全部文章</a><a href="/">回到首页</a></div></div></main></body></html>`,
      env
    ),
    404,
    /* 404 页每访问一次就要查一次站点设置（D1）再拼一遍 HTML。
       爬虫扫废链的时候这是纯粹的负载：给它 60 秒边缘缓存，
       既不会把「刚发布的文章」挡在 404 里太久（60 秒后自然失效），
       也不至于让一次扫描把 D1 打满。x-robots-tag 与 meta 双保险，别让
       任何搜索入口把它当成有效页面。 */
    { 'cache-control': 'public, max-age=0, s-maxage=60', 'x-robots-tag': 'noindex, follow' }
  );
}

/* ---------- RSS / Sitemap ---------- */
const rfc822 = (v) => {
  const s = String(v ?? '').trim();
  // D1 里存的是「2026-11-01 10:00:00」这种无时区字符串，按 UTC 解释
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
};

async function serveRss(env, request) {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, content, html_content, summary, category, cover, cover_body, published_at, created_at, updated_at FROM posts
     WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')}
     ORDER BY COALESCE(NULLIF(published_at, ''), created_at) DESC LIMIT 30`
  ).all();

  // <category> 让聚合器按主题归类；栏目用中文名，标签原样
  await attachTags(env.DB, results);

  const origin = siteOrigin(env, request);
  const site = await getSite(env);
  const items = results
    .map((p) =>
      rssItem({
        origin,
        post: p,
        author: site.author,
        html: (p.html_content || sanitizeHtml(renderBody(p.content))).replace(/(src|href)="\/(?!\/)/g, `$1="${origin}/`),
      })
    )
    .join('\n');

  // lastBuildDate 取最近一次改动的时间：聚合器靠它判断要不要重抓。
  // 注意必须夹到「现在」以内 —— 预排文章的 updated_at 可能是未来的时间戳，
  // 上面虽然有 liveSql 把正文挡住了，但 lastBuildDate 单独取 MAX 仍然会顶到未来，
  // 聚合器见到未来日期会认为这份 feed 异常（实测出现过 Wed, 18 Nov 2026 而当天是 11-12）。
  const lastPost = results[0];
  const now = Date.now();
  const rawBuild = lastPost ? rfc822(lastPost.updated_at || lastPost.created_at) : null;
  const lastBuild = rawBuild && new Date(rawBuild).getTime() <= now ? rawBuild : new Date(now).toUTCString();

  return new Response(rssDoc({ origin, site, items, lastBuild }), {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=600, stale-while-revalidate=3600',
    },
  });
}

/** RSS 封面映射到 MIME。type 必须按真实后缀给：站里 cover 大多是 /cards/*.png，
 *  写死 image/webp 会让 reader 按错误 MIME 解析，部分客户端直接不显示卡片。 */
const RSS_IMG_TYPES = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', avif: 'image/avif', gif: 'image/gif',
};

/**
 * 单个 <enclosure>：阅读器靠它出封面卡片。
 * 用 coverOf 而不是 thumbOf —— 后者是 208×136 的列表缩略图，放阅读器卡片会糊，
 * cover.js 里也明确写了「og:image / RSS 别用这个」。
 * 没有真实封面（只剩 6 张通用预设图轮换）时不输出，符合「不输出空 enclosure」。
 */
export function rssEnclosure(post, origin) {
  if (isAutoCover(post)) return '';
  const raw = coverOf(post);
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw, origin);
  } catch {
    return '';
  }
  if (u.origin !== new URL(origin).origin) return ''; // RSS 不留外链
  const ext = (u.pathname.split('.').pop() || '').toLowerCase();
  const type = RSS_IMG_TYPES[ext];
  if (!type) return '';
  return `      <enclosure url="${esc(u.href)}" length="0" type="${type}"/>`;
}

/**
 * 单个 <item>。作者署名两处都给：<author> 是 RSS 2.0 原生字段（规范建议写成
 * 「邮箱 (名字)」，但阅读器普遍当纯文本渲染），<dc:creator> 是 Feedly / Inoreader
 * 实际去读的那个 —— 只写前者，有些聚合器会把文章标成未知作者。
 */
export function rssItem({ origin, post, author, html }) {
  const link = `${origin}/p/${encodeURIComponent(post.slug)}`;
  const cats = [...new Set([catName(post.category), ...(post.tags || [])].filter(Boolean))];
  const catXml = cats.map((c) => `      <category>${esc(c)}</category>`).join('\n');
  // CDATA 里唯一不能出现的就是 ]]>，它会把 CDATA 提前关掉、后面的正文变成裸 XML。
  // 拆成 ]]]]><![CDATA[> 还原后正文一个字都不差，交给 rssItem 自己做，别指望调用方记得。
  const safe = String(html ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>');
  const enclosure = rssEnclosure(post, origin);
  const extraXml = [enclosure, catXml].filter(Boolean).join('\n');
  return `    <item>
      <title>${esc(post.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${rfc822(post.published_at || post.created_at)}</pubDate>
      <author>${esc(author)}</author>
      <dc:creator>${esc(author)}</dc:creator>
      <description>${esc(post.summary || extractExcerpt(post.content, 200))}</description>
      <content:encoded><![CDATA[${safe}]]></content:encoded>
${extraXml}
    </item>`;
}

/**
 * 频道外壳。抽成纯函数是为了能单测 —— 埋在 serveRss 里就只能起 miniflare 才能验。
 * 作者放在 <managingEditor>：RSS 2.0 的 channel 层**没有** <author> 这个元素
 * （那是 item 专有的），写进去会被校验器判为未定义元素。channel 层合法的署名
 * 是 managingEditor / webMaster / dc:creator，读者一般也只读 item 上的那个。
 * <ttl> 单位是分钟，60 与 HTTP 的 max-age=600 对齐：阅读器按 ttl 每小时来一次，
 * 正好不会每次都撞上 CDN 里那份还没过期的旧 feed。
 */
export function rssDoc({ origin, site, items, lastBuild }) {
  const { name, desc, author } = site;
  // 空作者会让 reader 显示空白署名，退到站名总比空标签强（getSite 已经兜过一次，
  // 这里再兜一次是防着以后有人绕过 getSite 直接拼 feed）
  const who = author || name || '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>${esc(name)}</title>
  <link>${origin}/</link>
  <atom:link href="${origin}/rss.xml" rel="self" type="application/rss+xml"/>
  <description>${esc(desc || name)}</description>
  <language>zh-CN</language>
  <managingEditor>${esc(who)}</managingEditor>
  <dc:creator>${esc(who)}</dc:creator>
  <lastBuildDate>${lastBuild}</lastBuildDate>
  <generator>Exia Blog</generator>
  <ttl>60</ttl>
${items}
</channel></rss>`;
}

async function serveSitemap(env, request) {
  const origin = siteOrigin(env, request);
  const publicOnly = `p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}`;
  // 列表页也要 lastmod：一个栏目页的内容变了，是因为它下面某篇文章变了，
  // 所以取组内 MAX(updated_at)。以前只有文章页带，列表页对爬虫等于"从不更新"。
  const lastUpd = (a) => `MAX(COALESCE(p.updated_at, p.created_at))`;

  const [{ results: posts }, { results: cats }, { results: tags }, { results: series }, { results: friendRow }] =
    await Promise.all([
      env.DB.prepare(
        `SELECT p.slug, p.updated_at FROM posts p WHERE ${publicOnly}
         ORDER BY COALESCE(NULLIF(p.published_at, ''), p.created_at) DESC LIMIT 1000`
      ).all(),
      env.DB.prepare(
        `SELECT p.category AS c, COUNT(*) AS n, ${lastUpd()} AS last FROM posts p
         WHERE ${publicOnly} AND TRIM(COALESCE(p.category,'')) != '' GROUP BY p.category`
      ).all(),
      env.DB.prepare(
        `SELECT t.name AS n, COUNT(*) AS c, ${lastUpd()} AS last FROM tags t
         JOIN post_tags pt ON pt.tag_id = t.id
         JOIN posts p ON p.id = pt.post_id AND ${publicOnly}
         GROUP BY t.name ORDER BY c DESC`
      ).all(),
      // 系列页是新加的地址，只靠站内链被发现太慢，直接进 sitemap
      env.DB.prepare(
        `SELECT p.series AS n, COUNT(*) AS c, ${lastUpd()} AS last FROM posts p
         WHERE ${publicOnly} AND TRIM(COALESCE(p.series, '')) != ''
         GROUP BY p.series`
      ).all(),
      // 友链页没有文章可依，只能看"最近加过谁"——status 每 20 分钟变一次，
      // 那是探测结果不是内容变化，拿它当 lastmod 会天天报假更新
      env.DB.prepare(`SELECT MAX(COALESCE(created_at, '')) AS last FROM friends`).all(),
    ]);

  const urls = posts
    .map(
      (p) =>
        `  <url><loc>${origin}/p/${encodeURIComponent(p.slug)}</loc><lastmod>${String(p.updated_at || '').slice(0, 10)}</lastmod></url>`
    )
    .join('\n');

  const lm = (v) => (v ? `<lastmod>${String(v).slice(0, 10)}</lastmod>` : '');
  // 首页 / 归档 / 栏目总览都是"全站文章"的另一种切法，用同一份最大值
  const siteLast = posts.reduce((m, p) => ((p.updated_at || '') > m ? p.updated_at : m), '');

  // 栏目页只在真有文章时进 sitemap；空栏目页对爬虫是薄内容。
  // 多个原始栏目名可能归一成同一个 slug，所以取归一后的最大值，不是逐行取。
  const catLast = new Map();
  for (const r of cats) {
    const slug = normalizeCat(r.c);
    if (!slug) continue;
    if ((r.last || '') > (catLast.get(slug) || '')) catLast.set(slug, r.last || '');
  }
  const catUrls = [...catLast]
    .map(([slug, last]) => `  <url><loc>${origin}/cat/${slug}</loc>${lm(last)}</url>`)
    .join('\n');

  const seriesLast = series.reduce((m, r) => ((r.last || '') > m ? r.last : m), '');
  const seriesUrls = series.length
    ? [`  <url><loc>${origin}/series</loc>${lm(seriesLast)}</url>`]
        .concat(series.map((r) => `  <url><loc>${origin}/series/${encodeURIComponent(r.n)}</loc>${lm(r.last)}</url>`))
        .join('\n')
    : `  <url><loc>${origin}/series</loc></url>`;

  const tagUrls = tags
    .filter((t) => t.c > 0)
    .map((t) => `  <url><loc>${origin}/tag/${encodeURIComponent(t.n)}</loc>${lm(t.last)}</url>`)
    .join('\n');

  /* 友链页的 lastmod 取「最近加过谁」。一条友链都没有时 MAX() 是 NULL，
     页面上就漏掉 lastmod —— 对爬虫等于「这页从不更新」。
     空表时退回全站最后更新时间：那一页确实只会跟着站点一起变。 */
  const friendLast = (friendRow[0] && friendRow[0].last) || siteLast;

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/</loc>${lm(
      siteLast
    )}</url>\n  <url><loc>${origin}/archive</loc>${lm(siteLast)}</url>\n  <url><loc>${origin}/categories</loc>${lm(
      siteLast
    )}</url>\n  <url><loc>${origin}/friends</loc>${lm(friendLast)}</url>\n${catUrls}\n${tagUrls}\n${seriesUrls}\n${urls}\n</urlset>`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' } }
  );
}

async function asset(env, request, url) {
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('text/html')) return res;

  const headers = new Headers(res.headers);
  headers.set('cache-control', assetCacheControl(url, headers.get('cache-control') || ''));
  headers.delete('content-length');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/* ---------- robots.txt / manifest ---------- */
function serveRobots(env, request) {
  const origin = siteOrigin(env, request);
  const txt = `User-agent: *
Allow: /
Disallow: /editor
Disallow: /login
Disallow: /api/
Disallow: /auth/

Sitemap: ${origin}/sitemap.xml
`;
  return new Response(txt, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

async function serveManifest(env, request) {
  const s = await getSite(env);
  const data = {
    id: '/',
    name: s.name,
    short_name: s.name.slice(0, 12),
    description: s.desc || '',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: THEME_COLOR[s.theme] || '#ffffff',
    theme_color: THEME_COLOR[s.theme] || '#ffffff',
    lang: 'zh-CN',
    dir: 'ltr',
    categories: ['blog', 'technology'],
    // 每个尺寸一条真实 PNG：以前一条 src 声明 "192x192 512x512" 是无效写法，
    // 浏览器会按第一条去取图，装到桌面就是被拉伸的头像
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      // 图标文件名固定，改图标时靠部署版本刷新
      'cache-control': assetVersion(env)
        ? 'public, max-age=3600'
        : 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}

/* ---------- 入口 ---------- */

const isPagePath = (p) =>
  p === '/' ||
  p === '/archive' ||
  p === '/categories' ||
  p === '/friends' ||
  p === '/series' ||
  p.startsWith('/series/') ||
  p.startsWith('/tag/') ||
  p.startsWith('/cat/') ||
  p.startsWith('/p/');

/* 出错时给浏览器一个能看的页面。
 *
 * 为什么不直接抛给 Cloudflare：默认错误页是英文、无导航、无站点身份的空白页，
 * 读者只会以为站没了然后关掉。给一张「稍后再试 + 回首页」的页面，至少留人。
 *
 * 注意这里一滴 D1 都不碰、也不引用 /style.css：能走到这个分支，很可能就是
 * 数据库或静态资源本身出了问题，再去依赖它们等于二次踩雷。样式全部内联。
 * no-store：故障页一秒都别缓存，恢复后要立刻能看到真页面。 */
export function serverErrorPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>服务暂时不可用</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:40px 20px;
  font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;
  color:#1b1f24;background:#fbfbfa;text-align:center}
.wrap{max-width:420px}
.big{font-size:64px;line-height:1;margin:0 0 18px;opacity:.12;font-weight:800;letter-spacing:-.04em}
p{margin:0 0 22px;color:#5a6470}
a{display:inline-block;padding:10px 22px;border-radius:999px;background:#1b1f24;color:#fbfbfa;
  text-decoration:none;font-size:14px}
@media (prefers-color-scheme:dark){
  body{background:#16181c;color:#e8eaed}
  p{color:#9aa4b0}
  a{background:#e8eaed;color:#16181c}
}
</style></head>
<body><div class="wrap"><p class="big">500</p>
<p>刚刚那次请求没能完成，多半是临时的。<br>过一会儿再试，或者先回首页。</p>
<a href="/">回到首页</a></div></body></html>`;
}

/* 给最终 HTML 补 ETag。
 *
 * 为什么不在 html() 里算：那个 body 之后还要被 injectTheme（塞 __POST__/__ARCH__）
 * 和 harden（去注释、改头）动过两轮，早算出来的 tag 与浏览器手里的副本对不上，
 * 304 永远命中不了 —— 而且这种错不会报错，只会让你以为「ETag 做了」。
 *
 * 代价是把 body 读成字符串再重建 Response（50KB 页面约 0.3ms），
 * 换的是复访时整页不再重传。streaming 那条路暂时用不上，页面本来也不是流式的。 */
async function withEtag(res) {
  if (res.status !== 200) return res;
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  /* 这里必须无条件重算，不能「已有 etag 就跳过」。
     首页 / 归档这些页面的模板来自 env.ASSETS，运行时会给静态文件自动配一个
     内容 ETag —— 那个 tag 对应的是**注入前**的模板，而 injectTheme 往 </head>
     里塞了 window.__SITE__ / __ARCH__。拿它当校验值的话，站点设置改了、数据变了，
     tag 却纹丝不动，访客会一直看到旧页面，而且没有任何报错。 */
  const body = await res.text();
  const headers = new Headers(res.headers);
  headers.set('etag', tagOf(body));
  return new Response(body, { status: 200, headers });
}

/** 缓存命中的响应也要改头，否则浏览器会按存缓存时的 s-maxage 去缓存 HTML */
function asClient(res) {
  const headers = new Headers(res.headers);
  // 浏览器不缓存（每次校验），边缘 60s + 过期后 600s 内先给旧副本再后台刷新
  headers.set('cache-control', pageCacheControl());
  headers.set('cdn-cache-control', `public, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/* If-None-Match 的值可以是 `*`、单个或多个用逗号分隔的 tag，前面还可能带 W/。
   不按这份清单拆，只做整体等值比较的话，浏览器发来两个 tag 就永远匹配不上。 */
export function etagHit(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (s) => s.trim().replace(/^W\//, '');
  const mine = bare(etag);
  return header.split(',').some((t) => bare(t) === mine);
}

/* 把 200 换成一个空 body 的 304。
   省的是整个响应体：一篇文章页压缩后 20 多 KB，304 只有几百字节的响应头。
   注意要删掉 content-encoding / content-length —— 304 没有 body，
   留着这两个头会让某些客户端等一个永远不会来的实体。 */
export function maybe304(res, request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return res;
  if (res.status !== 200) return res;
  const etag = res.headers.get('etag');
  if (!etag) return res;
  if (!etagHit(request.headers.get('if-none-match'), etag)) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  /* 这一行是整个 304 里最容易踩死人的地方。
     CSP 头里带着本次请求新生成的 nonce，而浏览器手里那份 body 里是**上一次**的
     nonce。把新 CSP 发过去，页面所有内联脚本的 nonce 全部对不上 —— 主题初始化、
     SSR 引导数据、评论渲染会一起静默失效，页面看着是好的，功能全没了。
     删掉这个头，浏览器会沿用缓存里那份响应自带的 CSP（RFC 9111：304 未提供的
     头保持不变），body 与 nonce 就还是配套的。 */
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.set('cache-control', pageCacheControl());
  return new Response(null, { status: 304, headers });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/api/')) return await handleApi(env, request, url, ctx);
  // 写作页服务端门禁：匿名直接 302 到登录，不吐后台骨架。放 API 之后避免重复鉴权。
  const gate = await editorGate(env, request, path);
  if (gate) return gate;
  if (path === '/auth/github') return loginRedirect(env, request);
  if (path === '/auth/callback') return await handleCallback(env, request);
  if (path === '/auth/logout') return logout();
  if (path === '/auth/status') return authStatus(env, request);
  if (path.startsWith('/img/')) return await serveImage(env, path.slice('/img/'.length));
  if (path === '/avatar') return await serveAvatarProxy(env, url);
  if (path === '/rss.xml') return await serveRss(env, request);
  if (path === '/sitemap.xml') return await serveSitemap(env, request);
  if (path === '/robots.txt') return serveRobots(env, request);
  if (path === '/manifest.webmanifest') return await serveManifest(env, request);
  if (path === '/admin/stats') return await statsPage(env, request);
  if (path === '/admin/health') return await healthPage(env, request);
  if (path === '/admin/queue') return await queuePage(env, request);

  // 标签页 / 栏目页复用首页骨架，前端读路径
  if (path.startsWith('/tag/')) {
    const tag = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (!tag) return await notFoundPage(env, request, '页面走丢了');
    // 没有任何公开文章的标签页就是薄内容，直接 404，别让爬虫收一堆空页
    const hit = await env.DB.prepare(
      `SELECT 1 FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}
       WHERE t.name = ? LIMIT 1`
    )
      .bind(tag)
      .first();
    if (!hit) return await notFoundPage(env, request, '这个标签下还没有文章');
    const res = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    return html(await res.text());
  }

  // 栏目只有四个 slug，未知栏目直接 404；中文旧链接 301 到 slug
  if (path.startsWith('/cat/')) {
    const raw = decodeURIComponent(path.slice(5).split('/')[0] || '');
    const c = catBySlug(raw);
    if (!c) return await notFoundPage(env, request, '没有这个栏目');
    if (raw !== c.slug) {
      return new Response(null, {
        status: 301,
        headers: { location: `/cat/${c.slug}${url.search}`, 'cache-control': 'public, max-age=86400' },
      });
    }
    const res = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    return html(await res.text());
  }

  // 归档 / 时间线（服务端直出，不再让爬虫看「加载中…」）
  if (path === '/archive' || /^\/archive\/\d{4}\/?$/.test(path)) {
    return await serveArchivePage(env, request, url);
  }

  // 栏目总览（分类 + 标签）
  if (path === '/categories') {
    const res = await env.ASSETS.fetch(new Request(new URL('/categories', request.url), request));
    if (res.status === 200) return html(await res.text());
  }

  // 友链（服务端直出，爬虫能看到真实外链）
  if (path === '/friends' || path === '/friends/') {
    return await serveFriendsPage(env, request);
  }

  // 系列页：/series 总览 + /series/<名称> 单系列
  if (path === '/series' || path === '/series/') {
    return await serveSeriesIndex(env, request);
  }
  if (path.startsWith('/series/')) {
    const name = decodeURIComponent(path.slice(8).split('/')[0] || '').trim();
    if (!name) return await notFoundPage(env, request, '没有这个系列');
    return await serveSeriesPage(env, request, name);
  }

  // /p/:slug 与 /:slug 都指向文章
  if (path.startsWith('/p/')) {
    return await servePostPage(env, request, decodeURIComponent(path.slice(3)));
  }

  const segs = path.split('/').filter(Boolean);
  if (segs.length === 1) {
    // 先看静态资源有没有同名的（login / friends / editor 等）
    const hit = await asset(env, request, url);
    if (hit.status !== 404) return hit;
    return await servePostPage(env, request, decodeURIComponent(segs[0]));
  }

  // 其它交给静态资源
  const res = await asset(env, request, url);
  if (res.status === 404) return await notFoundPage(env, request);
  return res;
}

export default {
  async fetch(request, env, ctx) {
    /* HEAD 一律按 GET 走一遍，最后再把 body 丢掉。
       不这么做的后果很隐蔽：Workers 运行时对 HEAD 请求会先把 body 置空，
       withEtag 里 `await res.text()` 拿到的是空串 —— 所有页面的 HEAD 响应
       都回同一个 ETag "0-811c9dc5"（空串的 FNV 初值），与实际内容无关。
       监控、SEO 工具、CDN 预检都爱用 HEAD，拿着这个假 tag 做校验，
       要么永远命中 304、要么永远不命中，而 GET 一切正常，很难怀疑到这里。 */
    if (request.method === 'HEAD') {
      const res = await this.fetch(
        new Request(request.url, { method: 'GET', headers: request.headers, redirect: request.redirect }),
        env,
        ctx
      );
      return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    try {
      const url = new URL(request.url);

      /* 明文 HTTP 一律跳到 HTTPS。
         面板的 Always Use HTTPS 也能做到，但那是面板状态、进不了版本库，
         而且一旦有人误关，站上没有任何代码层面的兜底。这里拦一道，双保险。
         用 308 不用 301：POST/PUT 跟随重定向时不能把方法改成 GET。
         本地 wrangler dev 是 http://127.0.0.1:8788，必须放行，否则本地没法开发。 */
      const host = url.hostname;
      const LOCAL = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
      const fwdProto = (request.headers.get('x-forwarded-proto') || '').toLowerCase();
      if (!LOCAL && (url.protocol === 'http:' || fwdProto === 'http')) {
        const target = new URL(request.url);
        target.protocol = 'https:';
        target.port = '';
        return new Response(null, {
          status: 308,
          headers: securityHeaders(
            new Headers({ location: target.toString(), 'cache-control': 'public, max-age=3600' }),
            null
          ),
        });
      }

      /* 路径规范化：/p/slug/ 与 /tag/Cloudflare 都 301 到规范地址。
         放在缓存之前 —— 这类请求不该先查一次边缘缓存（它的 key 就是错的），
         也不该让它走到 route() 里再各自判断。只对 GET/HEAD 生效：
         写请求的路径由 API 自己校验，重定向会把方法打回 GET。 */
      if (request.method === 'GET' || request.method === 'HEAD') {
        const norm = normalizePagePath(url.pathname);
        if (norm !== url.pathname) {
          const target = new URL(request.url);
          target.pathname = norm;
          return new Response(null, {
            status: 301,
            headers: securityHeaders(
              new Headers({ location: target.toString(), 'cache-control': 'public, max-age=3600' }),
              null
            ),
          });
        }
      }

      /* 匿名访客的公开页面在边缘缓存几十秒：
         页面 HTML 本身不含任何用户信息（登录态由前端补），所以缓存不会串号；
         带 sid 的请求一律绕过缓存，保证后台、私密文章、登录流程永远走实时渲染。 */
      const cookie = request.headers.get('cookie') || '';
      const loggedIn = /(^|;\s*)sid=/.test(cookie);
      const cacheable =
        request.method === 'GET' && !loggedIn && isPagePath(url.pathname);

      if (cacheable) {
        const hit = await edgeGet(url);
        /* 没有 ETag 的副本一律当未命中。
           那种副本是「上线前存进 caches.default 的旧响应」，里面没有 etag 头，
           直接用它的话：浏览器收到的还是没有 ETag 的页面，304 永远开不了，
           而且要等 s-maxage / swr 自然过期才恢复 —— 表现为「部署了但没效果」。
           当作未命中重渲染一次，顺手把缓存覆盖成带 ETag 的版本。 */
        if (hit && hit.headers.get('etag')) return maybe304(asClient(hit), request);
      }

      let res = await route(request, env, ctx);
      /* 注入 SEO / 分页链接时用一个把 host 换成可信主域的 url。
         直接用路由的 url（源自 Host 头）会让 canonical / JSON-LD / sitemap
         跟着攻击者伪造的 Host 走。这里不动 edgeGet 的缓存键，只改派生来源。 */
      const seoUrl = new URL(url.pathname + url.search, siteOrigin(env, request));
      res = await injectTheme(env, res, seoUrl);
      res = await harden(res, env, url.pathname);
      res = await withEtag(res);

      /* 顺序很重要：先按 200 写边缘缓存，再决定要不要改回 304。
         反过来做的话，304 一返回就不满足 `status === 200` 的写缓存条件，
         于是「客户端永远带着 If-None-Match」的访客永远灌不进边缘缓存 ——
         看着是省了流量，实际每次都要完整渲染一遍。 */
      if (cacheable && res.status === 200 && (res.headers.get('content-type') || '').includes('text/html')) {
        // 存缓存用 s-maxage；回给浏览器的副本一律 max-age=0，
        // 否则 CF 会按 zone 的 Browser Cache TTL 把 HTML 在浏览器里压 4 小时
        const stored = await edgePut(url, res, EDGE_TTL);
        return maybe304(asClient(stored), request);
      }

      return maybe304(res, request);
    } catch (e) {
      console.error(e);
      /* API 还是回 JSON（调用方是前端脚本，解析 HTML 只会更糟）；
         页面请求回那张 500 页，别把人扔到 Cloudflare 的英文白屏上。 */
      const here = new URL(request.url).pathname;
      const wantsHtml =
        !here.startsWith('/api/') &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        /text\/html/.test(request.headers.get('accept') || '');
      if (wantsHtml) {
        return new Response(serverErrorPage(), {
          status: 500,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'retry-after': '60',
          },
        });
      }
      return json({ ok: false, error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkFriends(env));
    // 统计明细保留 90 天。cron 每 20 分钟一轮，没必要每轮都删一次，
    // 挑 UTC 20:00（北京 04:00）那一轮做日更清理。
    const utcHour = new Date(event.scheduledTime || Date.now()).getUTCHours();
    if (utcHour === 20) ctx.waitUntil(prunePv(env));
  },
};
