#!/usr/bin/env node
/**
 * 线上体检：一次把「能用」层面的硬指标全过一遍。
 *
 * 和 perf-vitals.mjs 分工不同：那个测浏览器里的 LCP/CLS/INP，
 * 这个只用 fetch 打 HTTP，验证那些用户不会报障、但一旦坏了很难察觉的东西：
 *   时区显示、字符编码、404 语义与缓存、HEAD 与 GET 的 ETag 一致性、
 *   缩略图缓存策略、阻塞脚本。
 *
 * 用法：
 *   node scripts/check-live.mjs                       # 默认打 https://exia.de5.net
 *   node scripts/check-live.mjs https://shturl.cc     # 换域名
 */
import { createHash } from 'node:crypto';

const ORIGIN = (process.argv[2] || 'https://exia.de5.net').replace(/\/$/, '');

let pass = 0;
let fail = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`);
  }
};

/* 首页带一个 cache-buster：边缘缓存 s-maxage 300，
   刚部署完直接打正式 URL 会拿到上一版 HTML，然后得到一堆「明明是刚修过的」FAIL。
   这个参数不改变页面内容（列表接口忽略未知 query），只让缓存 key 变掉。 */
const BUST = `/cb=${Date.now()}`;

const get = async (path, opts = {}) => {
  const url = ORIGIN + (path === '/' ? `/?${BUST.slice(1)}` : path);
  const res = await fetch(url, { redirect: 'manual', ...opts });
  const body = opts.head ? '' : await res.text();
  return { res, body, h: res.headers };
};

/* 动态 HTML 必须带 cache-buster。原来只有首页带 BUST：刚部署完 /series、
   /archive、文章页还可能命中上一版的边缘缓存，体检等于在测旧代码 ——
   新增断言会假红，旧断言会假绿。静态资源（CSS/JS/图片）不能加，
   否则测的就不是用户实际走的那条缓存路径了。 */
const bustUrl = (path) => {
  const i = path.indexOf('?');
  const base = i < 0 ? path : path.slice(0, i);
  const q = i < 0 ? '' : path.slice(i + 1) + '&';
  return `${base}?${q}cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
};
const page = (path, opts = {}) => get(bustUrl(path), opts);

console.log(`\n${ORIGIN}\n`);

/* ---------- 1. 域名与可达性 ---------- */
{
  let res;
  try {
    res = await fetch(ORIGIN + '/', { redirect: 'manual' });
  } catch (e) {
    console.log(`  FAIL 域名不可达：${e.message}`);
    process.exit(1);
  }
  ok('首页可达', res.status === 200 || res.status === 304, `HTTP ${res.status}`);
}

/* ---------- 2. 字符编码 ---------- */
{
  const { res, body, h } = await get('/');
  const ct = h.get('content-type') || '';
  /* text/html 的 charset 有两条路：HTTP 头，或者文档里的 <meta charset>。
     Cloudflare 会把 `text/html; charset=utf-8` 规范化成 `text/html`
     （HTML 规范就是这么定的：text/html 的编码由 BOM 和 meta 决定，
     头里的 charset 参数本来就被废弃了）。所以这里要求的是「至少有一条」。 */
  ok('编码声明存在（头或 meta）', /charset=utf-8/i.test(ct) || /<meta\s+charset=["']?utf-8/i.test(body), ct);
  ok('HTML 有 <meta charset>', /<meta\s+charset=["']?utf-8/i.test(body));
  ok('没有替换字符 U+FFFD', !body.includes('\uFFFD'));
  ok('中文正常（首页 >200 字）', (body.match(/[\u4e00-\u9fff]/g) || []).length > 200);
  const latin = (body.match(/[ÃÂ][\u0080-\u00BF]/g) || []).length;
  ok('没有 latin1 二次解码痕迹', latin === 0, latin ? `${latin} 处` : '');
}

/* ---------- 3. 404 ---------- */
{
  const p = `/__check_${Date.now()}`;
  const { res, body, h } = await get(p);
  ok('未知路径回 404（不是 200）', res.status === 404, `HTTP ${res.status}`);
  ok('404 是自定义页', /<title>404/.test(body));
  ok('404 不让收录（meta）', /<meta\s+name=["']robots["'][^>]*noindex/i.test(body));
  ok('404 不让收录（头）', /noindex/i.test(h.get('x-robots-tag') || ''));
  ok('404 页带返回入口', /回到首页/.test(body) || /href="\/"/.test(body));
  /* 404 也是读者会落到的页面，键盘用户同样需要跳过导航。
     这两条连同下面的「无内联 style」守住上一轮把 404 从内联壳迁出的改动。 */
  ok('404 有跳到正文链接', /class="skip-link"[^>]*href="#main"/.test(body));
  ok('404 有 main 落点', /<main\b[^>]*id="main"/.test(body));
  ok('404 样式已外链（无内联 style）', !/<style\b/.test(body));
  const cc = h.get('cache-control') || '';
  ok('404 缓存不超过 1 分钟', !/s-maxage=(\d{3,})/.test(cc), cc);
  // 文章 slug 不存在
  const p404 = await get('/p/__nope__');
  ok('/p/不存在 回 404', p404.res.status === 404, `HTTP ${p404.res.status}`);
}

/* ---------- 4. 时区（显示层）---------- */
{
  // 从 sitemap 拿一篇真文章
  const { body: sm } = await page('/sitemap.xml');
  const locs = [...sm.matchAll(/<loc>[^<]*\/p\/([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok('sitemap 有文章', locs.length > 0, `${locs.length} 篇`);
  if (locs.length) {
    const { body } = await page(`/p/${locs[0]}`);
    const m = body.match(/class="sep-dot">(\d{4}-\d{2}-\d{2})</);
    const d = m ? m[1] : '';
    ok('文章页有发布日期', /^\d{4}-\d{2}-\d{2}$/.test(d), d);
    // 机器读的时间必须是带时区的 ISO；给人看的必须是北京日期
    const ld = body.match(/"datePublished":"([^"]+)"/);
    if (ld) ok('JSON-LD datePublished 是带时区 ISO', /(Z|[+-]\d{2}:\d{2})$/.test(ld[1]), ld[1]);
    const meta = body.match(/article:published_time" content="([^"]+)"/);
    if (meta) ok('og published_time 带时区', /(Z|[+-]\d{2}:\d{2})$/.test(meta[1]), meta[1]);
  }
}

/* ---------- 5. HEAD 与 GET 的 ETag 必须一致 ---------- */
{
  for (const path of ['/', '/archive']) {
    // GET 与 HEAD 必须打同一个 URL，否则比的是两个缓存键
    const url = bustUrl(path);
    const g = await get(url);
    const { h: hh } = await get(url, { head: true });
    const ge = g.h.get('etag');
    const he = hh.get('etag');
    ok(`HEAD 与 GET 的 ETag 一致 ${path}`, ge && ge === he, `${ge} vs ${he}`);
  }
}

/* ---------- 6. 304 协商 ---------- */
{
  const first = await get('/');
  const etag = first.h.get('etag');
  if (etag) {
    const again = await get('/', { headers: { 'if-none-match': etag } });
    ok('带 If-None-Match 回 304', again.res.status === 304, `HTTP ${again.res.status}`);
    ok('304 没有 body', again.body === '');
    ok('304 不带新 nonce 的 CSP', !/nonce-/.test(again.h.get('content-security-policy') || ''));
  } else {
    ok('首页有 ETag', false);
  }
}

/* ---------- 7. 图片链路 ---------- */
{
  const { body } = await get('/');
  const imgs = [...body.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
  ok('列表图有 width/height', imgs.length > 0 && imgs.every((t) => /width="\d+"/.test(t) && /height="\d+"/.test(t)), `${imgs.length} 张`);
  /* 预设封面（/thumbs/*.webp）本来就只有一份，没什么可协商的；要验的是
     作者自己传的图有没有 avif/webp 候选。原来这条直接扫首页，等于赌「首页
     恰好有一篇带配图的文章」—— 那篇被设成 hidden 或者掉到第二页，就是一条假红。
     改成先问接口有没有 /img/ 封面，有才验。 */
  const list = await (await fetch(ORIGIN + '/api/posts?page=1&size=50')).json();
  const hasOwn = (list.posts || []).some((p) => /^\/img\//.test(p.cover || ''));
  if (hasOwn) {
    ok('自有封面走 avif/webp 协商', /<picture><source type="image\/avif"/.test(body));
  } else {
    ok('自有封面走 avif/webp 协商', true, '当前列表里没有 /img/ 封面的公开文章，跳过');
  }

  // 缩略图缓存必须与「带版本号」对齐：带了 v 就该 immutable
  const thumb = (body.match(/["'](\/thumbs\/[^"']+)["']/) || [])[1];
  if (thumb) {
    const { h } = await get(thumb);
    const cc = h.get('cache-control') || '';
    ok('缩略图带版本号', /\?v=/.test(thumb), thumb);
    ok('缩略图一年强缓存', /immutable/.test(cc), cc);
    ok('缩略图 MIME 正确', /image\//.test(h.get('content-type') || ''), h.get('content-type'));
  }
  // 原图与变体
  const cover = (body.match(/src="(\/img\/[^"?]+)"/) || [])[1];
  if (cover) {
    const orig = await get(cover);
    ok('原图可达', orig.res.status === 200, `${orig.res.status} ${orig.h.get('content-type')}`);
    ok('原图 immutable', /immutable/.test(orig.h.get('cache-control') || ''));
    const av = await get(cover + '.avif');
    ok('avif 变体可用', av.res.status === 200 && /avif/.test(av.h.get('content-type') || ''), av.h.get('content-type'));
  }
}

/* ---------- 8. 阻塞资源 ---------- */
{
  const { body } = await get('/');
  /* 整标签匹配。只匹配到 src= 为止的话，"defer" 在 src 后面，
     每条都会被判成阻塞脚本 —— 这个错误我第一版就犯过。 */
  const scripts = [...body.matchAll(/<script\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((t) => /\bsrc=["']/.test(t))
    .map((t) => ({ tag: t, src: (t.match(/src=["']([^"']+)/) || [])[1] }));
  const blocking = scripts.filter((s) => !/\b(defer\b|\basync\b)/.test(s.tag) && !/type=["']module["']/.test(s.tag));
  ok('没有 parser-blocking 外链脚本', blocking.length === 0, blocking.map((b) => b.src).join(', '));
  /* document.write 在解析期插入样式或脚本，解析器必须停下等它执行完 ——
     它比普通阻塞脚本更糟：连后面的 HTML 都排不出来。主题样式表已经改成
     服务端直出，这条断言防它被改回去。 */
  ok('页面里没有 document.write', !/document\.write\s*\(/.test(body));
  ok('所有外链脚本都带版本号', scripts.every((s) => /\?v=/.test(s.src)), scripts.map((s) => s.src).join(', '));

  /* 只认真正会发起子资源请求的标签：<script src>、<link rel=stylesheet/preload>、
     <img/iframe/video src>。原来扫所有 (src|href) 外链，把页脚 GitHub 这种 <a href>
     导航链接也算成子资源 —— 点才跳转、首屏不下载，不该让「无第三方子资源」误报。 */
  const subRes = [
    ...[...body.matchAll(/<script\b[^>]*\bsrc=["'](https?:\/\/[^"']+)/gi)].map((m) => m[1]),
    ...[...body.matchAll(/<link\b[^>]*\brel=["'](?:stylesheet|preload|preconnect|modulepreload)["'][^>]*\bhref=["'](https?:\/\/[^"']+)/gi)].map((m) => m[1]),
    ...[...body.matchAll(/<(?:img|iframe|video|source)\b[^>]*\bsrc=["'](https?:\/\/[^"']+)/gi)].map((m) => m[1]),
  ];
  const third = subRes.map((u) => new URL(u).host).filter((h) => !ORIGIN.includes(h));
  ok('首屏没有第三方子资源', third.length === 0, [...new Set(third)].join(', '));
}

/* ---------- 8.5 模板里不能漏出注释 ----------
 * 在 return `…` 的模板字符串中间写 /* 说明 *\/ ，JS 不会报错，它会老老实实
 * 把那段当成文本节点输出到页面上 —— 语法检查、类型检查、单元测试全部通过，
 * 只有打开页面才看得见。剥掉 <style>/<script> 再看，才不会误伤真正的 CSS 注释。 */
{
  const pages = ['/', '/archive', '/p/post-brfy5'];
  const leaked = [];
  for (const path of pages) {
    const { body } = await page(path);
    const text = body
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const m = text.match(/\/\*[\s\S]{0,80}?\*\//g);
    if (m) leaked.push(`${path}: ${m[0].slice(0, 50).replace(/\s+/g, ' ')}`);
  }
  ok(`页面正文里没有漏出的注释（抽 ${pages.length} 页）`, leaked.length === 0, leaked.join(' | '));
}

/* ---------- 9. 图片出口：类型必须落在白名单里 ----------
 * /img/ 的 content-type 来自 R2 元数据，而元数据在上传时由客户端写入 —— 它是一份
 * 声明，不是事实。一旦某一环把它写成 text/html，同源导航就能执行其中的脚本。
 * 这里验的不是「图片能不能显示」，而是「出口有没有把不可信类型降级掉」。 */
{
  const home = (await get('/')).body;
  /* 首页头几篇不一定有正文配图，往下翻几篇再定样本 */
  const slugs = [...new Set([...home.matchAll(/href="(\/p\/[^"]+)"/g)].map((m) => m[1]))].slice(0, 5);
  let imgs = [];
  for (const p of slugs) {
    const art = (await page(p)).body;
    imgs = [...new Set([...art.matchAll(/<img[^>]+src="(\/img\/[^"]+)"/g)].map((m) => m[1]))].slice(0, 8);
    if (imgs.length) break;
  }
  if (imgs.length) {
    const ALLOWED = /^image\/(png|jpeg|webp|avif|gif|svg\+xml)$/;
    const bad = [];
    for (const src of imgs) {
      const r = await fetch(ORIGIN + src);
      const ct = (r.headers.get('content-type') || '').split(';')[0];
      if (!ALLOWED.test(ct)) bad.push(`${src} -> ${ct || '(空)'}`);
      const rj = r.headers.get('x-img-rejected');
      if (rj) bad.push(`${src} 被降级(${rj})`);
      if (ct === 'image/svg+xml' && !/sandbox/.test(r.headers.get('content-security-policy') || '')) {
        bad.push(`${src} 是 svg 却没有沙箱`);
      }
    }
    ok(`图片类型全在白名单（抽 ${imgs.length} 张）`, bad.length === 0, bad.join('; '));
  } else {
    console.log('  --   跳过后端图片检查：最近 5 篇文章都没有 /img/ 配图');
  }
}

/* ---------- 9.6 资源提示与多档图片 ----------
 * 这两块都是「改坏了也不报错、只是白做」的类型：
 *   - Link: rel=preload 没了，页面照样能开，只是 103 永远不触发，CSS 晚几百毫秒才开下载
 *   - srcset 里的档位地址不存在，浏览器会选中它然后靠 serveImage 回退到全尺寸，
 *     页面不裂，但用户多下了几百 KB —— 从外面完全看不出来
 */
{
  /* 样本要覆盖全部公开文章，不能只翻首页 —— 有正文图的往往是最早那几篇，
     首页按时间倒序排在最后，翻不到就永远「跳过」，这条检查等于没写。 */
  let slugs = [];
  try {
    const list = await (await fetch(`${ORIGIN}/api/posts?size=50`)).json();
    slugs = (list.posts || []).map((x) => `/p/${encodeURIComponent(x.slug)}`);
  } catch {}
  if (!slugs.length) {
    const home = (await get('/')).body;
    slugs = [...new Set([...home.matchAll(/href="(\/p\/[^"]+)"/g)].map((m) => m[1]))];
  }
  ok('能取到文章样本（多档图片检查需要）', slugs.length > 0, `${slugs.length} 篇`);

  let linkHeader = '';
  let multi = null;
  for (const p of slugs) {
    const r = await get(`${p}?b=${Date.now()}${Math.random().toString(36).slice(2, 6)}`);
    const lh = r.h.get('link') || '';
    const m = [...new Set([...r.body.matchAll(/srcset="(\/img\/[^"]+?\.w\d{3,4}\.(?:avif|webp)) \d+w/g)].map((x) => x[1]))];
    /* 只认纯 CSS 那份 link 头就错了：首图 preload 只在带图的文章上出现，
       取到第一篇没图文章的头，会把「有多档 preload」误报成失败。 */
    if (m.length && !multi) {
      multi = { path: p, urls: m };
      linkHeader = lh;
    }
    if (!linkHeader) linkHeader = lh;
    if (linkHeader && multi) break;
  }

  /* 公开文章里目前一张多档图都没有 —— 那批测试图所在的文章一篇是 hidden、
     一篇是私密。hidden 那篇仍可直连访问，拿它当固定夹具；
     哪天它被删了，这里会退回「跳过」而不是误报失败。
     必须在断言之前探：首图 preload 只出现在带图的文章上。 */
  if (!multi) {
    const probe = await get(`/p/post-brfy5?b=${Date.now()}`);
    const m = [...new Set([...probe.body.matchAll(/srcset="(\/img\/[^"]+?\.w\d{3,4}\.(?:avif|webp)) \d+w/g)].map((x) => x[1]))];
    if (m.length) {
      multi = { path: '/p/post-brfy5', urls: m };
      linkHeader = probe.h.get('link') || linkHeader;
    }
  }

  /* 103 的触发条件就是响应里这个头。没有它，Cloudflare 那边开不开 Early Hints 都一样 */
  ok(
    '文章页带 Link 预加载头（103 的触发条件）',
    /rel=preload/.test(linkHeader) && /style\.css/.test(linkHeader),
    linkHeader.slice(0, 90) || '(没有 link 头)'
  );
  /* 首图的 preload 必须带 imagesrcset：只写死一个 URL 的话，手机会白下 1200 那张，
     高 DPR 桌面会拿到 480 的糊图 —— 页面看着没问题，LCP 反而更差。 */
  ok(
    '首图 preload 带 imagesrcset/imagesizes 多档',
    /rel=preload; as=image/.test(linkHeader) && /imagesrcset="[^"]+ \d+w/.test(linkHeader) && /imagesizes="[^"]+"/.test(linkHeader),
    linkHeader.slice(0, 200)
  );
  /* 页面源码里不该出现 githubusercontent：可见 <img> 早就代理了，
     漏的两次在 __SITE__.avatar 和 JSON-LD 的 author.image —— 都是看不见的地方。 */
  const gh = [...(await get(`/?b=${Date.now()}`)).body.matchAll(/https:\/\/avatars\.githubusercontent\.com\/[^"\\ <]+/g)];
  ok('页面源码无 githubusercontent 外链（含 __SITE__ 与 JSON-LD）', gh.length === 0, gh.slice(0, 2).join(' | '));

  if (!multi) {
    console.log('  --   当前公开文章里没有带宽度档的正文图，跳过 srcset 实物校验');
  } else {
    ok(`正文图有多档 srcset（${multi.path}）`, multi.urls.length >= 2);
    /* 抽两个档位真发一次请求：地址写错、档位没产出，都会在这里露出来 */
    const probes = multi.urls.slice(0, 2);
    const bad = [];
    for (const u of probes) {
      const r = await fetch(ORIGIN + u);
      const ct = (r.headers.get('content-type') || '').split(';')[0];
      const want = /\.avif$/.test(u) ? 'image/avif' : 'image/webp';
      /* 回退是允许的（老图没重转过），但至少要落到图片类型上而不是 404/HTML */
      if (!/^image\//.test(ct)) bad.push(`${u} -> ${ct || '(空)'}`);
      else if (ct !== want && !r.headers.get('x-img-fallback')) bad.push(`${u} -> ${ct}（既不是 ${want} 也没标回退）`);
    }
    ok('srcset 里的档位地址能取到图片', bad.length === 0, bad.join('; '));
  }
}

/* ---------- 相关推荐 ---------- */
{
  // 固定夹具：worker-cron-friend-check 有 4 标签、非系列，相关推荐与上下篇应共存；
  // post-brfy5 无标签无栏目，整块不该渲染（空壳占版面是回归）。
  const withTags = await page('/p/worker-cron-friend-check');
  const cards = [...withTags.body.matchAll(/class="rel"[^>]*>/g)].map((_, i) => i);
  ok('有标签文章渲染相关推荐区块', withTags.body.includes('class="post-related"'));
  ok('相关推荐最多 3 张卡', cards.length > 0 && cards.length <= 3, `实际 ${cards.length} 张`);
  const relHrefs = [...withTags.body.matchAll(/class="rel"[^>]*href="(\/p\/[^"]+)"/g)].map((m) => m[1]);
  ok('相关推荐链接格式正确', relHrefs.length === cards.length && relHrefs.every((u) => /^\/p\/[^/]+$/.test(u)));
  ok('相关推荐不含当前文章', !relHrefs.includes('/p/worker-cron-friend-check'));
  // 赋值顺序回归：worker-render-549-to-96 是 log 栏目，与本篇 4 个标签全中；
  // 若 post.tags 没在 rankRelated 之前赋值，共同标签数恒为 0，跨栏目这篇进不来，
  // 前三会退化成纯 tools 栏目文章。这条只有排序真按标签交集走才会过。
  ok('跨栏目同标签文章排第一（标签交集真生效）',
    relHrefs[0] === '/p/worker-render-549-to-96', `实际第一张 ${relHrefs[0]}`);
  const noTags = await page('/p/post-brfy5');
  ok('无标签无栏目文章不渲染相关推荐', !noTags.body.includes('class="post-related"'));
}

/* ---------- 系列页：手搓壳的四项线上守门 ----------
 * test-seo-series.mjs 在源码层锁住了这些约束；这里验的是线上真的吐出来了 ——
 * 静态断言过、Worker 里换个返回值，只有线上体检能抓到。
 * 这页以前 OG/Twitter 整块缺失、CSS/JS 裸引用、还带一段内联 style。 */
{
  const idx = await page('/series');
  const stamped = (b) =>
    /href="\/style\.css\?v=[^"]+"/.test(b) && /src="\/boot\.js\?v=[^"]+"/.test(b);

  ok('系列页有 OG 标题与站点名',
    /<meta property="og:title" content="[^"]+"/.test(idx.body) &&
    /<meta property="og:site_name" content="[^"]+"/.test(idx.body));
  ok('系列页有 Twitter 富卡片',
    /<meta name="twitter:card" content="summary_large_image"/.test(idx.body) &&
    /<meta name="twitter:image" content="[^"]+"/.test(idx.body));
  ok('系列页 OG 图走同源 1200×630 默认卡',
    idx.body.includes(`content="${ORIGIN}/og-default.jpg"`) &&
    /og:image:width" content="1200"/.test(idx.body) &&
    /og:image:height" content="630"/.test(idx.body));
  ok('系列总览资源带部署版本戳', stamped(idx.body));
  ok('系列总览样式已外链（无内联 style）', !/<style\b/.test(idx.body));
  ok('系列总览有 skip-link 与 main 落点',
    /class="skip-link"[^>]*href="#main"/.test(idx.body) && /<main\b[^>]*id="main"/.test(idx.body));

  // 两处 seriesShell 调用，总览过了不代表详情也过了
  const href = (idx.body.match(/href="(\/series\/[^"]+)"/) || [])[1];
  if (href) {
    const detail = await page(href.replace(/&amp;/g, '&'));
    ok('系列详情资源带部署版本戳', stamped(detail.body));
    ok('系列详情样式已外链（无内联 style）', !/<style\b/.test(detail.body));
  } else {
    ok('能取到系列详情样本', false);
  }
}

/* ---------- RSS 封面 enclosure ---------- */
{
  const rss = await get('/rss.xml?cb=' + Date.now());
  const enc = [...rss.body.matchAll(/<enclosure url="([^"]+)" length="(\d+)" type="([^"]+)"\/>/g)];
  ok('RSS item 带封面 enclosure', enc.length > 0, `${enc.length} 个`);
  ok('enclosure URL 同源绝对地址', enc.length > 0 && enc.every((m) => m[1].startsWith(ORIGIN + '/')));
  ok('enclosure type 是合法图片 MIME', enc.length > 0 && enc.every((m) => /^image\/(png|webp|jpeg|avif|gif)$/.test(m[3])));
  ok('enclosure 不破坏原有 item 字段', rss.body.includes('<content:encoded>') && rss.body.includes('<dc:creator>'));
}

/* ---------- SRI + immutable 静态资源 ----------
   这一组验的是「浏览器会不会真的去校验」：
   光有 integrity 属性不够，值必须与线上字节对得上；
   光有 ?v= 不够，头部得真是 immutable，否则一年强缓存是句空话。
   算摘要是整段体检里唯一一次读字节，值得 —— 别的手段都验不出「值写错了」。 */
{
  const { body: html } = await get('/');
  const link = html.match(/<link[^>]+href="(\/style\.css\?v=[^"]+)"[^>]*>/);
  const script = html.match(/<script[^>]+src="(\/boot\.js\?v=[^"]+)"[^>]*>/);
  ok('style.css 带内容哈希版本号', !!link && /\?v=[0-9a-f]{10}["']/.test(link[0]), link ? link[1] : '没找到');
  ok('boot.js 带内容哈希版本号', !!script && /\?v=[0-9a-f]{10}["']/.test(script[0]), script ? script[1] : '没找到');
  ok('style.css 带 integrity', !!link && /integrity="sha384-[A-Za-z0-9+/=]+"/.test(link[0]));
  ok('boot.js 带 integrity', !!script && /integrity="sha384-[A-Za-z0-9+/=]+"/.test(script[0]));
  ok('同源资源不加 crossorigin', !!link && !/crossorigin/i.test(link[0]));

  // 关键一条：拿线上真实字节复算 sha384，与 HTML 里写的比对
  if (link && /integrity="(sha384-[^"]+)"/.test(link[0])) {
    const want = link[0].match(/integrity="(sha384-[^"]+)"/)[1];
    const r = await fetch(ORIGIN + link[1]);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = 'sha384-' + createHash('sha384').update(buf).digest('base64');
    ok('style.css 的 integrity 与线上字节一致', got === want, got === want ? '' : `HTML=${want.slice(0, 24)}… 实际=${got.slice(0, 24)}…`);
    ok('带 v 的 CSS 返回 immutable', /immutable/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control') || '');
    ok('带 v 的 CSS 强缓存一年', /max-age=31536000/.test(r.headers.get('cache-control') || ''));
  }
  // 不带 v 的请求不该被当成 immutable（否则改了样式永远刷不出来）
  const plain = await fetch(ORIGIN + '/style.css');
  ok('无 v 的 CSS 不给 immutable', !/immutable/.test(plain.headers.get('cache-control') || ''), plain.headers.get('cache-control') || '');
}

/* ---------- 103 Early Hints：preload 必须与 HTML 同址 ----------

   这条是 2026-11 补的：preload 一度还在用部署号（?v=<部署 UUID>），
   而 HTML 里的 href 已经是内容哈希 —— 两个 URL 差一个字符串，浏览器就当两个资源，
   103 提前下的那份全程没人用，冷访问白下一遍 121KB 的 CSS，还会被边缘各缓存一份。
   两者必须逐字符相等，这条断言就是守它。 */
{
  const { h, body } = await get('/');
  const link = h.get('link') || '';
  const pre = link.match(/<([^>]*\/style\.css\?v=[^>]+)>;\s*rel=preload/i);
  const href = body.match(/<link[^>]+href="(\/style\.css\?v=[^"]+)"/);
  ok('响应头带 style.css 的 preload', !!pre, pre ? pre[1] : '没有 Link 头');
  ok(
    'preload 地址与 HTML 里的 href 逐字符一致',
    !!pre && !!href && pre[1] === href[1],
    pre && href && pre[1] !== href[1] ? `preload=${pre[1]} html=${href[1]}` : ''
  );
}

/* ---------- 10. 安全与缓存头 ---------- */
{
  const { h } = await get('/');
  ok('有 CSP', !!h.get('content-security-policy'));
  ok('CSP 带 nonce', /nonce-/.test(h.get('content-security-policy') || ''));
  ok('HSTS', !!h.get('strict-transport-security'));
  ok('x-content-type-options', h.get('x-content-type-options') === 'nosniff');
  ok('HTML 不做浏览器长缓存', !/max-age=[1-9]\d{2,}/.test((h.get('cache-control') || '').split('s-maxage')[0]));
}

/* ---------- 11. 新增公开入口与后台门禁 ----------

   七项功能上线后这批路由还没有体检覆盖：llms.txt 是给 AI 爬虫的索引，
   一旦把未来稿/待审稿漏进去就是提前剧透；后台页则必须匿名一律 401。 */
{
  const { res, body, h } = await get('/llms.txt');
  ok('/llms.txt 返回 200', res.status === 200, `HTTP ${res.status}`);
  ok('/llms.txt 是纯文本', /text\/plain/.test(h.get('content-type') || ''), h.get('content-type') || '');

  const { body: sitemap } = await get('/sitemap.xml');
  const inSitemap = new Set([...sitemap.matchAll(/\/p\/([a-z0-9-]+)/g)].map((m) => m[1]));
  const inLlms = [...body.matchAll(/\/p\/([a-z0-9-]+)/g)].map((m) => m[1]);
  ok('/llms.txt 列了文章', inLlms.length > 0, `${inLlms.length} 篇`);
  ok(
    '/llms.txt 的每篇都在 sitemap 里（不提前剧透未来稿）',
    inLlms.length > 0 && inLlms.every((s) => inSitemap.has(s)),
    inLlms.filter((s) => !inSitemap.has(s)).join(', ')
  );

  for (const p of ['/admin', '/admin/review', '/admin/audit', '/admin/history', '/admin/friends', '/admin/comments']) {
    const r = await fetch(ORIGIN + p, { method: 'HEAD', redirect: 'manual' });
    ok(`${p} 匿名不可达`, r.status === 401 || r.status === 302, `HTTP ${r.status}`);
  }
}

/* 体检有几十条，失败夹在中间的 ok 里很容易漏读。末尾把失败项单独列一遍。 */
if (failed.length) {
  console.log('\n失败项：');
  for (const name of failed) console.log(`  - ${name}`);
}
console.log(`\n[P-010] ${fail ? 'FAIL' : 'PASS'}  ${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
