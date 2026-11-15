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
const ORIGIN = (process.argv[2] || 'https://exia.de5.net').replace(/\/$/, '');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
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
  const cc = h.get('cache-control') || '';
  ok('404 缓存不超过 1 分钟', !/s-maxage=(\d{3,})/.test(cc), cc);
  // 文章 slug 不存在
  const p404 = await get('/p/__nope__');
  ok('/p/不存在 回 404', p404.res.status === 404, `HTTP ${p404.res.status}`);
}

/* ---------- 4. 时区（显示层）---------- */
{
  // 从 sitemap 拿一篇真文章
  const { body: sm } = await get('/sitemap.xml');
  const locs = [...sm.matchAll(/<loc>[^<]*\/p\/([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok('sitemap 有文章', locs.length > 0, `${locs.length} 篇`);
  if (locs.length) {
    const { body } = await get(`/p/${locs[0]}`);
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
    const g = await get(path);
    const { h: hh } = await get(path, { head: true });
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
  const pic = /<picture><source type="image\/avif"/.test(body);
  ok('封面图有 avif/webp 协商', pic);

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
  ok('所有外链脚本都带版本号', scripts.every((s) => /\?v=/.test(s.src)), scripts.map((s) => s.src).join(', '));

  const third = [...body.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)/g)].map((m) => new URL(m[1]).host).filter((h) => !ORIGIN.includes(h));
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
    const { body } = await get(path);
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
    const art = (await get(p)).body;
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

/* ---------- 10. 安全与缓存头 ---------- */
{
  const { h } = await get('/');
  ok('有 CSP', !!h.get('content-security-policy'));
  ok('CSP 带 nonce', /nonce-/.test(h.get('content-security-policy') || ''));
  ok('HSTS', !!h.get('strict-transport-security'));
  ok('x-content-type-options', h.get('x-content-type-options') === 'nosniff');
  ok('HTML 不做浏览器长缓存', !/max-age=[1-9]\d{2,}/.test((h.get('cache-control') || '').split('s-maxage')[0]));
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
