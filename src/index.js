import { handleApi, listPosts, archiveData, attachTags, friendsData, tagsData, liveSql } from './api.js';
import { loginRedirect, handleCallback, logout, authStatus, currentUser } from './auth.js';
import { html, json } from './utils.js';
import { checkFriends } from './cron.js';
import { getSite } from './settings.js';
import { extractExcerpt, readingTime, renderBody, tocOf } from '../public/md.js';
import { coverOf, autoThumb, isAutoCover, isCardCover, thumbOf } from './cover.js';
import { avatarSrc } from '../public/avatar.js';
import { sanitizeHtml } from './clean.js';
import { makeNonce, applyNonce, securityHeaders, obfuscateEmail } from './security.js';
import { ldJson, siteLd, postLd, listLd, iso } from './seo.js';
import { edgeGet, edgePut, EDGE_TTL, EDGE_SWR, pageCacheControl } from './cache.js';
import { CATS, catBySlug, catName, normalizeCat } from './taxonomy.js';
import { normalizePagePath } from './routes.js';
import { statsPage, prunePv } from './stats.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ESC[c]);

/* ---------- 图片代理 ---------- */
function imageResponse(obj) {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  // SVG 是文档不是图片：直接访问这个 URL 时浏览器会执行里面的 <script>，
  // 而这个 URL 跟站点同源（贴进 <img> 时没事，单独打开就成了一次存储型 XSS）。
  // sandbox + default-src 'none' 把它降级成只能看。
  const ct = (headers.get('content-type') || '').toLowerCase();
  if (ct.includes('svg')) {
    headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    headers.set('content-disposition', 'inline');
  }
  return new Response(obj.body, { headers });
}

async function serveImage(env, key) {
  const path = decodeURIComponent(key);
  const obj = await env.BUCKET.get(path);
  if (obj) return imageResponse(obj);

  /* /img/a.png.webp、/img/a.png.avif：转码后的变体。
     不按 Accept 协商，是因为 HTML 和图片都在边缘缓存，接受头分支会让同一份缓存
     发给不支持的浏览器；变体做成了独立 URL，让 <picture> 在浏览器端挑。
     变体还没转出来（新上传的图、批量脚本没跑过）时回退原图 ——
     白跑一次查询，好过让访客看到一张裂开的图。 */
  const m = path.match(/^(.*\.(?:png|jpe?g))\.(?:avif|webp)$/i);
  if (m) {
    const orig = await env.BUCKET.get(m[1]);
    if (orig) return imageResponse(orig);
  }
  return new Response('404 Not Found', { status: 404 });
}

/* ---------- 头像代理 ----------
   只放行 avatars.githubusercontent.com/u/<数字>，别的域名一律 400，
   免得这个口子变成通用 SSRF 跳板。第一次回源 GitHub，落一份到 R2，
   之后同源长缓存；边缘直接命中，页面上再没有第三方连接。 */
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
    headers.set('cache-control', 'public, max-age=31536000, immutable');
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
  const type = up.headers.get('content-type') || 'image/png';
  try {
    await env.BUCKET.put(key, buf, {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
    });
  } catch {} // 落盘失败不影响这一响应，下次访问再补

  return new Response(buf, {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' },
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
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return String(sqlDate).slice(0, 10);
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
  const homepage = c.website
    ? `<a href="${esc(c.website)}" target="_blank" rel="noopener nofollow noUGc" class="muted">${esc(c.name)}</a>`
    : esc(c.name);
  const mail = viewer && viewer.is_admin && c.email
    ? `<a class="cmt-mail" href="mailto:${esc(c.email)}" title="联系邮箱，仅管理员可见">${esc(c.email)}</a>`
    : '';
  return `<div class="cmt" data-cid="${c.id}"><div class="ava">${avaText(c.name)}</div><div class="main"><div class="head"><b>${homepage}</b>${
    c.is_admin ? '<span class="badge-owner">博主</span>' : ''
  }<span class="when">${esc(relTime(c.created_at))}</span>${mail}</div><div class="text">${esc(c.content)}</div><div class="acts">${commentActs(
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
  const a = String(first || '').slice(0, 7).replace('-', '.');
  const b = String(last || '').slice(0, 7).replace('-', '.');
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
            const md = stamp.slice(5, 10);
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
            const md = String(p.published_at || p.created_at || '').slice(5, 10);
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
  return `<script>window.__THEME_DEFAULT__=${cfg};(function(){var d=document.documentElement,t=null,m=null;try{t=localStorage.getItem('x_theme');m=localStorage.getItem('x_mode')}catch(e){}var g=window.__THEME_DEFAULT__||{};t=t||g.theme||'paper';m=m||g.mode||'auto';var sys=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;var dark=(m==='dark')||(m!=='light'&&sys);d.setAttribute('data-theme',t);d.setAttribute('data-mode',dark?'dark':'light');d.setAttribute('data-mpref',m);if(t!=='paper'&&t!=='anzhiyu')document.write('<link rel="stylesheet" href="/theme/'+t+'.css">')})();</script>`;
}

function seriesShell({ site, origin, title, kicker, desc, canonical, ld, sub, list }) {
  const siteName = esc(site.name || 'Blog');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${siteName}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="${THEME_COLOR[site.theme] || '#faf9f7'}">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${esc(canonical)}">
<link rel="manifest" href="/manifest.webmanifest">
${themeBoot(site)}
<link rel="stylesheet" href="/style.css">
<script src="/boot.js" defer></script>
<style>
.page-head{padding:42px 0 26px}
.page-kicker{margin:0 0 8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.page-head h1{font-family:var(--serif);font-size:30px;line-height:1.25;margin:0 0 10px;letter-spacing:var(--hero-space)}
.page-sub{margin:0;color:var(--muted);font-size:13.5px}
.series-page{list-style:none;margin:0;padding:0 0 60px;display:flex;flex-direction:column;border-top:1px solid var(--line)}
.series-page li:first-child{border-top:none}
.series-page a{display:flex;gap:14px;align-items:baseline;padding:13px 0;border-top:1px solid var(--line);color:var(--fg);text-decoration:none}
.series-page a:hover .sp-t{color:var(--accent)}
.sp-n{flex:0 0 auto;font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.sp-t{flex:1 1 auto;font-size:15px;line-height:1.55}
.sp-d{flex:0 0 auto;font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.foot{max-width:760px;margin:0 auto;padding:26px 22px 60px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
.foot a{color:var(--muted);text-decoration:none}
.foot a:hover{color:var(--accent)}
@media(max-width:560px){.sp-t{font-size:14px}.sp-d{display:none}}
</style>
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
<footer class="foot"><a href="/">← 首页</a> · <a href="/series">全部系列</a></footer>
</body></html>`;
}

const fmtDay = (v) => String(v || '').slice(0, 10);

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
  const origin = new URL(request.url).origin;
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
    seriesShell({
      site,
      origin,
      title: name,
      kicker: '系列连载',
      desc: `${name}：共 ${results.length} 篇，最近更新 ${fmtDay(latest)}。`,
      canonical,
      ld,
      sub: `共 ${results.length} 篇 · 最近更新 ${esc(fmtDay(latest))}`,
      list: seriesRows(results),
    }),
    200,
    { 'cache-control': pageCacheControl() }
  );
}

async function serveSeriesIndex(env, request) {
  const site = await getSite(env);
  const origin = new URL(request.url).origin;
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
    seriesShell({
      site,
      origin,
      title: '系列',
      kicker: '连载',
      desc: results.map((s) => s.name).join('、') || '按系列读',
      canonical,
      ld,
      sub: `${results.length} 个系列 · 按最近更新排`,
      list,
    }),
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
  const cell = (p, dir, label) =>
    p
      ? `<a class="adj ${dir}" href="/p/${encodeURIComponent(p.slug)}" rel="${dir}"><span class="adj-k">${label}</span><span class="adj-t">${esc(p.title)}</span></a>`
      : '';
  const cells = [cell(prev, 'prev', '← 上一篇'), cell(next, 'next', '下一篇 →')].filter(Boolean);
  // 只有一侧有文章时收成单列：留半个虚线空框看着像加载失败
  return `<nav class="post-adjacent${cells.length === 1 ? ' single' : ''}" aria-label="同栏目相邻文章">
    ${cells.join('')}
  </nav>`;
}

async function servePostPage(env, request, slug) {
  const user = await currentUser(env, request);

  /* 依赖深度压到 1：标签和评论不再等 post.id，直接用 slug 关联，就能跟正文一起发。
     上一版把 [标签, 评论] 并在一起，看着像"已经并发了"，但深度的成因不是查询条数，
     而是"必须先拿到 id 才能查子表"——真正的串行段是 post → 子表这一跳。
     系列目录同理，用子查询按 slug 找同系列名，也进同一批。
     D1 单库单线程、单次调用最多 6 条连接，这里 5 条查询刚好卡在线上，
     再加查询就得换成 batch() —— 别在这条路上继续加。 */
  const [post, tagRes, cmtRes, seriesRes, catRes, site, tpl] = await Promise.all([
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
      // email 只有管理员会在页面上看到（见 commentActs 的 viewer 判断），
      // 匿名访客的 HTML 里不会出现这个字段
      `SELECT c.id, c.parent_id, c.name, c.email, c.website, c.content, c.is_admin, c.created_at
       FROM comments c JOIN posts p ON p.id = c.post_id
       WHERE p.slug = ? ORDER BY c.created_at ASC`
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
    // 同栏目整份列表：只取 slug/title，一个栏目最多十来篇，比「查上一篇 + 查下一篇」
    // 两条 SQL 便宜——D1 的成本主要在往返，不在这十几行数据。
    env.DB.prepare(
      `SELECT slug, title FROM posts
       WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')}
         AND category = (SELECT category FROM posts WHERE slug = ?)
       ORDER BY COALESCE(NULLIF(published_at, ''), created_at) ASC`
    )
      .bind(slug)
      .all(),
    getSite(env),
    assetText(env, request, '/post'),
  ]);

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

  const tagRows = tagRes.results;
  const cmtRows = cmtRes.results;
  post.tags = tagRows.map((r) => r.name);
  post.comments = cmtRows.length;

  // 系列目录：同系列公开文章按序号排，当前这篇标出来，顺带算出上下篇
  const seriesPosts = seriesRes.results;
  const siteName = site.name;
  const origin = new URL(request.url).origin;
  // canonical 必须和 sitemap / RSS 里给的地址一致，否则同一篇文章被收录两份
  const canonical = new URL(`/p/${encodeURIComponent(post.slug)}`, request.url).toString();

  const desc = post.summary || extractExcerpt(post.content, 150);
  // 手填封面 → 正文首图 → 预设自动图，永远有值
  const cover = coverOf(post);
  // 封面 → 本站分享图。站点头像不参与：GitHub 头像只有 460px，社交卡片会糊成一团，
  // 而且外链域名不受自己控制（改天换图床就 404）。
  const ogImage = new URL(cover, request.url).toString();
  /* og:image 的尺寸只标能确认的两种：预设图 1200×784 JPEG、标题卡 1200×630 PNG。
     作者自己传的图尺寸未知，标错了平台会按错的框去裁。 */
  const ogKind = isAutoCover(post)
    ? { type: 'image/jpeg', w: 1200, h: 784 }
    : isCardCover(post)
      ? { type: 'image/png', w: 1200, h: 630 }
      : null;

  const bodyHtml = sanitizeHtml(renderBody(post.content));
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
      : '';

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
          <span class="sep-dot">${esc(String(post.published_at || post.created_at || '').slice(0, 10))}</span>
          <span class="sep-dot">${reading} 分钟阅读</span>
          ${
            post.updated_at && post.updated_at.slice(0, 10) !== String(post.published_at || post.created_at || '').slice(0, 10)
              ? `<span class="sep-dot">更新于 ${esc(String(post.updated_at).slice(0, 10))}</span>`
              : ''
          }
          <span class="post-edit" style="margin-left:auto"></span>
        </div>
      </header>
      ${lead}
      ${renderSeries(post, seriesPosts)}
      <div class="md post-body">${bodyHtml}</div>
      <footer class="post-foot"><div class="tagbar" style="margin:0">${tagbar}</div></footer>
      ${renderAdjacent(post, catRes.results, seriesPosts)}
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

  return `<header class="site">
    <div class="inner">
      <a class="brand" href="/">${avatar}<span class="brand-name">${esc(name)}<span class="dot">.</span></span></a>
      ${desc ? `<span class="brand-desc" title="${esc(desc)}">${esc(desc)}</span>` : ''}
      <nav class="top" id="site-nav">${links}${extra.join('')}<span id="nav-user"></span>${THEME_BTN}</nav>
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

function postCard(p) {
  // 卡片永远有图：shapePost 已经兜过一层，这里再兜一次是防「传进来的是原始行」
  const cover = `<img class="thumb" src="${esc(thumbOf(p))}" alt="" loading="lazy" decoding="async" width="108" height="78">`;
  const tags = (p.tags || [])
    .slice(0, 3)
    .map((t) => `<span class="tag">#${esc(t)}</span>`)
    .join('');
  return `<a class="post-card" href="/p/${encodeURIComponent(p.slug)}">${cover}<div class="body"><h2>${esc(p.title)}${
    p.is_private ? ' <span class="tiny muted">私密</span>' : ''
  }</h2>${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ''}<div class="meta"><span>${esc(
    String(p.published_at || p.created_at || '').slice(0, 10)
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
  // 栏目页用自己的栏目说明当描述，比全站一句通用话更贴页面主题
  const desc = cat ? cat.desc : site.desc || `${site.name} · 记录思考、代码与生活`;
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
  const catsP = body.includes('<!--CATS-->') ? catCounts(env) : Promise.resolve(new Map());
  const tagsP = body.includes('<!--TAGS-->') ? tagsData(env.DB).catch(() => []) : Promise.resolve(null);
  // 列表只依赖模板和 URL，不依赖站点设置，所以这里就能先发车
  const listP = listQuery(env, url);

  const [s, counts, tags] = await Promise.all([siteP, catsP, tagsP]);

  const cfg = JSON.stringify({ theme: s.theme, mode: s.mode }).replace(/</g, '\\u003c');
  // 站点头像与站名先落到 window.__SITE__，导航渲染时能立刻用
  const siteCfg = JSON.stringify({
    name: s.name,
    desc: s.desc,
    avatar: s.avatar,
    // 只下发公开的 site key；secret 只在 Worker 里，永不进页面
    turnstile: env.TURNSTILE_SITE_KEY || '',
  }).replace(/</g, '\\u003c');
  // 图标用本站文件，不再把 GitHub 头像当 favicon（外链一换就白图，尺寸也不对）
  const icon =
    '<link rel="icon" href="/favicon.ico" sizes="any">' +
    '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">' +
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
  const inject =
    `<script>window.__THEME_DEFAULT__=${cfg};window.__SITE__=${siteCfg};</script>${icon}`;

  body = fillSeo(body, s, url).replace('<!--THEME-->', inject);

  // 导航栏直接渲染进 HTML，省掉首屏空白与跳动
  body = body.replace(/<div id="site-header"[^>]*><\/div>/, renderHeader(s, url.pathname));
  body = renderHero(body, s, url.pathname);

  const { body: listed, list } = applyList(body, await listP);
  body = renderCats(listed, counts, tags);

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
  // 资源带部署版本号，静态资源才能一年强缓存
  body = stampAssets(body, env);

  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* 统一加安全头：HTML 顺带给内联脚本发 nonce（缓存里存的也是配对好的头，回放不会错位） */
/* 外部统计服务（可选）。
   默认走自己记的 /api/pv，一个第三方脚本都不引；
   只有显式配了 UMAMI_SCRIPT 才换成 umami，并顺手关掉自建上报 ——
   两套同时开着，两边数字会互相矛盾，没人能判断哪个是真的。 */
function analyticsTag(env) {
  const src = String((env && env.UMAMI_SCRIPT) || '').trim();
  if (!/^https:\/\//.test(src)) return '';
  const id = String((env && env.UMAMI_SITE_ID) || '').trim();
  const attr = id ? ` data-website-id="${esc(id)}"` : '';
  return `<script>window.__PV_OFF__=1</script><script defer src="${esc(src)}"${attr}></script>`;
}

function analyticsOrigin(env) {
  const src = String((env && env.UMAMI_SCRIPT) || '').trim();
  try {
    return src ? new URL(src).origin : '';
  } catch {
    return '';
  }
}

async function harden(res, env) {
  // 配了 Turnstile 才在 CSP 里放行它的域名；没配就保持零第三方
  const tsOn = !!(env && env.TURNSTILE_SITE_KEY);
  const anOn = analyticsOrigin(env);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: securityHeaders(new Headers(res.headers), null, { turnstile: tsOn }),
    });
  }
  const nonce = makeNonce();
  let raw = await res.text();
  const ana = analyticsTag(env);
  // 放在补 nonce 之前：这段 script 自己也是内联的，得跟别的一起拿到 nonce
  if (ana) raw = raw.replace('</head>', ana + '</head>');
  // 先混淆邮箱再补 nonce：解码脚本是内联的，得跟着一起拿到 nonce
  const body = applyNonce(obfuscateEmail(raw), nonce);
  const headers = securityHeaders(new Headers(res.headers), nonce, { turnstile: tsOn, analytics: anOn });
  // 所有 HTML 用同一套缓存口径，别再让文章页单独漏成 max-age=60 / 无 s-maxage
  const cc = (headers.get('cache-control') || '').toLowerCase();
  if (!cc.includes('no-store') && !cc.includes('private')) headers.set('cache-control', pageCacheControl());
  headers.set('cdn-cache-control', `public, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`);
  headers.delete('content-length');
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/* ---------- 404 ---------- */
async function notFoundPage(env, request, message = '页面走丢了') {
  const site = await getSite(env);
  const siteName = esc(site.name);
  const cfg = JSON.stringify({ theme: site.theme, mode: site.mode }).replace(/</g, '\\u003c');
  return html(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 · ${siteName}</title>
<script>window.__THEME_DEFAULT__=${cfg};(function(){var d=document.documentElement,t=null,m=null;try{t=localStorage.getItem('x_theme');m=localStorage.getItem('x_mode')}catch(e){}var g=window.__THEME_DEFAULT__||{};t=t||g.theme||'paper';m=m||g.mode||'auto';var sys=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;var dark=(m==='dark')||(m!=='light'&&sys);d.setAttribute('data-theme',t);d.setAttribute('data-mode',dark?'dark':'light');d.setAttribute('data-mpref',m);if(t!=='paper'&&t!=='anzhiyu')document.write('<link rel="stylesheet" href="/theme/'+t+'.css">')})();</script>
<link rel="stylesheet" href="/style.css">
<script src="/boot.js" defer></script>
<style>
.g404{min-height:100vh;display:grid;place-items:center;text-align:center;padding:40px 20px}
.g404 h1{font-family:var(--serif);font-size:88px;margin:0;opacity:.12;font-weight:700;letter-spacing:-.05em}
.g404 p{color:var(--muted);margin:0 0 26px}
.g404 a{display:inline-block;padding:10px 20px;border-radius:999px;background:var(--fg);color:var(--bg);text-decoration:none;font-size:14px}
</style></head>
<body><div class="g404"><div><h1>404</h1><p>${esc(message)}</p><a href="/">回到首页</a></div></div></body></html>`,
    404
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
    `SELECT id, slug, title, content, summary, category, published_at, created_at, updated_at FROM posts
     WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')}
     ORDER BY COALESCE(NULLIF(published_at, ''), created_at) DESC LIMIT 30`
  ).all();

  // <category> 让聚合器按主题归类；栏目用中文名，标签原样
  await attachTags(env.DB, results);

  const origin = new URL(request.url).origin;
  const { name: siteName, desc: siteDesc } = await getSite(env);
  const items = results
    .map((p) => {
      const link = `${origin}/p/${encodeURIComponent(p.slug)}`;
      const cats = [...new Set([catName(p.category), ...(p.tags || [])].filter(Boolean))];
      const catXml = cats.map((c) => `      <category>${esc(c)}</category>`).join('\n');
      // 全文：站内相对链接补成绝对地址，否则阅读器里图片和文内跳转全是坏的
      const full = sanitizeHtml(renderBody(p.content))
        .replace(/(src|href)="\/(?!\/)/g, `$1="${origin}/`)
        .replace(/\]\]>/g, ']]]]><![CDATA[>');
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${rfc822(p.published_at || p.created_at)}</pubDate>
      <description>${esc(p.summary || extractExcerpt(p.content, 200))}</description>
      <content:encoded><![CDATA[${full}]]></content:encoded>
${catXml}
    </item>`;
    })
    .join('\n');

  // lastBuildDate 取最近一次改动的时间：聚合器靠它判断要不要重抓。
  // 注意必须夹到「现在」以内 —— 预排文章的 updated_at 可能是未来的时间戳，
  // 上面虽然有 liveSql 把正文挡住了，但 lastBuildDate 单独取 MAX 仍然会顶到未来，
  // 聚合器见到未来日期会认为这份 feed 异常（实测出现过 Wed, 18 Nov 2026 而当天是 11-12）。
  const lastPost = results[0];
  const now = Date.now();
  const rawBuild = lastPost ? rfc822(lastPost.updated_at || lastPost.created_at) : null;
  const lastBuild = rawBuild && new Date(rawBuild).getTime() <= now ? rawBuild : new Date(now).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>${esc(siteName)}</title>
  <link>${origin}/</link>
  <atom:link href="${origin}/rss.xml" rel="self" type="application/rss+xml"/>
  <description>${esc(siteDesc || siteName)}</description>
  <language>zh-CN</language>
  <lastBuildDate>${lastBuild}</lastBuildDate>
  <generator>Exia Blog</generator>
  <ttl>60</ttl>
${items}
</channel></rss>`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=600, stale-while-revalidate=3600',
    },
  });
}

async function serveSitemap(env, request) {
  const origin = new URL(request.url).origin;
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

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/</loc>${lm(
      siteLast
    )}</url>\n  <url><loc>${origin}/archive</loc>${lm(siteLast)}</url>\n  <url><loc>${origin}/categories</loc>${lm(
      siteLast
    )}</url>\n  <url><loc>${origin}/friends</loc>${lm(friendRow[0] && friendRow[0].last)}</url>\n${catUrls}\n${tagUrls}\n${seriesUrls}\n${urls}\n</urlset>`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' } }
  );
}

/* ---------- 静态资源统一出口 ----------
   带 ?v=<部署版本> 的资源内容不会变，直接一年强缓存；
   没带版本号的退回 5 分钟，保证改了样式也能较快生效 */
function assetVersion(env) {
  return env.SITE_VERSION || (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || '';
}

function stampAssets(body, env) {
  const v = assetVersion(env);
  if (!v) return body;
  return body.replace(/(["'])\/(style\.css|app\.js|theme\.js|md\.js|boot\.js|cover\.js|avatar\.js)\1/g, (m, q, f) => `${q}/${f}?v=${v}${q}`);
}

async function asset(env, request, url) {
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('text/html')) return res;

  const headers = new Headers(res.headers);
  const cc = headers.get('cache-control') || '';
  if (url?.searchParams.has('v')) {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
  } else if (url && (url.pathname.startsWith('/thumbs/') || url.pathname.startsWith('/cards/'))) {
    // 预设头图与标题卡：文件名按 slug 固定，内容跟着文章改，给一天而不是一年
    headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
  } else if (!cc || /max-age=0/.test(cc)) {
    headers.set('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
  }
  headers.delete('content-length');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/* ---------- robots.txt / manifest ---------- */
function serveRobots(request) {
  const origin = new URL(request.url).origin;
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

/** 缓存命中的响应也要改头，否则浏览器会按存缓存时的 s-maxage 去缓存 HTML */
function asClient(res) {
  const headers = new Headers(res.headers);
  // 浏览器不缓存（每次校验），边缘 60s + 过期后 600s 内先给旧副本再后台刷新
  headers.set('cache-control', pageCacheControl());
  headers.set('cdn-cache-control', `public, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/api/')) return await handleApi(env, request, url, ctx);
  if (path === '/auth/github') return loginRedirect(env, request);
  if (path === '/auth/callback') return await handleCallback(env, request);
  if (path === '/auth/logout') return logout();
  if (path === '/auth/status') return authStatus(env, request);
  if (path.startsWith('/img/')) return await serveImage(env, path.slice('/img/'.length));
  if (path === '/avatar') return await serveAvatarProxy(env, url);
  if (path === '/rss.xml') return await serveRss(env, request);
  if (path === '/sitemap.xml') return await serveSitemap(env, request);
  if (path === '/robots.txt') return serveRobots(request);
  if (path === '/manifest.webmanifest') return await serveManifest(env, request);
  if (path === '/admin/stats') return await statsPage(env, request);

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
        if (hit) return asClient(hit);
      }

      let res = await route(request, env, ctx);
      res = await injectTheme(env, res, url);
      res = await harden(res, env);

      if (cacheable && res.status === 200 && (res.headers.get('content-type') || '').includes('text/html')) {
        // 存缓存用 s-maxage；回给浏览器的副本一律 max-age=0，
        // 否则 CF 会按 zone 的 Browser Cache TTL 把 HTML 在浏览器里压 4 小时
        const stored = await edgePut(url, res, EDGE_TTL);
        return asClient(stored);
      }

      return res;
    } catch (e) {
      console.error(e);
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
