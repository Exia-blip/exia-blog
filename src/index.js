import { handleApi, listPosts, archiveData, attachTags, friendsData, tagsData } from './api.js';
import { loginRedirect, handleCallback, logout, authStatus, currentUser } from './auth.js';
import { html, json } from './utils.js';
import { checkFriends } from './cron.js';
import { getSite } from './settings.js';
import { extractExcerpt, readingTime, renderBody } from '../public/md.js';
import { coverOf, autoThumb, isAutoCover, thumbOf } from './cover.js';
import { avatarSrc } from '../public/avatar.js';
import { sanitizeHtml } from './clean.js';
import { makeNonce, applyNonce, securityHeaders, obfuscateEmail } from './security.js';
import { ldJson, siteLd, postLd, listLd, iso } from './seo.js';
import { edgeGet, edgePut, EDGE_TTL, EDGE_SWR, pageCacheControl } from './cache.js';
import { CATS, catBySlug, catName, normalizeCat } from './taxonomy.js';
import { normalizePagePath } from './routes.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ESC[c]);

/* ---------- 图片代理 ---------- */
async function serveImage(env, key) {
  const obj = await env.BUCKET.get(decodeURIComponent(key));
  if (!obj) return new Response('404 Not Found', { status: 404 });

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
const TAG_JOIN_SQL = `SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ? ORDER BY t.name`;

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

function renderComment(c, isChild = false) {
  const homepage = c.website
    ? `<a href="${esc(c.website)}" target="_blank" rel="noopener nofollow noUGc" class="muted">${esc(c.name)}</a>`
    : esc(c.name);
  return `<div class="cmt" data-cid="${c.id}"><div class="ava">${avaText(c.name)}</div><div class="main"><div class="head"><b>${homepage}</b>${
    c.is_admin ? '<span class="badge-owner">博主</span>' : ''
  }<span class="when">${esc(relTime(c.created_at))}</span></div><div class="text">${esc(c.content)}</div><div class="acts"></div>${
    !isChild && c.replies && c.replies.length
      ? `<div class="replies">${c.replies.map((r) => renderComment(r, true)).join('')}</div>`
      : ''
  }</div></div>`;
}

function renderComments(rows, total) {
  const roots = rows.filter((c) => !c.parent_id);
  const kids = rows.filter((c) => c.parent_id);
  const tree = roots.map((r) => ({ ...r, replies: kids.filter((c) => c.parent_id === r.id) }));
  const list = tree.length
    ? tree.map((c) => renderComment(c)).join('')
    : '<div class="muted small" style="padding:14px 0">还没有评论，来抢沙发。</div>';
  return `<section class="comments" id="comments">
      <h3>评论 <span class="muted" id="cmt-count">${total ? `(${total})` : ''}</span></h3>
      <div id="cmt-list">${list}</div>
      <form class="cmt-form" id="cmt-form" novalidate>
        <div id="reply-hint" class="tiny muted" style="display:none"></div>
        <input type="text" name="hp" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true" placeholder="留空">
        <div class="row" id="guest-fields">
          <input type="text" name="name" placeholder="昵称 *" maxlength="40" autocomplete="nickname">
          <input type="email" name="email" placeholder="联系邮箱 *（不公开，仅博主可见）" maxlength="120" autocomplete="email">
          <input type="url" name="website" placeholder="网站（可选）" maxlength="200">
        </div>
        <textarea name="content" placeholder="说点什么…" maxlength="2000"></textarea>
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

/* ---------- 系列目录 ----------
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
  return `<nav class="series" aria-label="系列目录">
    <div class="series-top">
      <span class="series-kicker">系列连载</span>
      <strong class="series-name">${esc(post.series)}</strong>
      <span class="series-count">共 ${list.length} 篇 · 第 ${idx + 1} 篇</span>
    </div>
    <ol class="series-list">${items}</ol>
    ${jump}
  </nav>`;
}

async function servePostPage(env, request, slug) {
  const user = await currentUser(env, request);

  const post = await env.DB.prepare(
    `SELECT p.*, u.name AS author_name, u.login, u.avatar FROM posts p
     LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ?`
  )
    .bind(slug)
    .first();

  if (!post) return await notFoundPage(env, request, '页面走丢了');
  if (post.is_private && (!user || (user.id !== post.author_id && !user.is_admin))) {
    return await notFoundPage(env, request, '页面走丢了');
  }

  const tpl = await assetText(env, request, '/post');
  if (!tpl) return new Response('模板缺失', { status: 500 });

  const [{ results: tagRows }, { results: cmtRows }] = await Promise.all([
    env.DB.prepare(TAG_JOIN_SQL).bind(post.id).all(),
    env.DB.prepare(
      'SELECT id, parent_id, name, website, content, is_admin, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC'
    )
      .bind(post.id)
      .all(),
  ]);

  post.tags = tagRows.map((r) => r.name);
  post.comments = cmtRows.length;

  // 系列目录：同系列公开文章按序号排，当前这篇标出来，顺带算出上下篇
  let seriesPosts = [];
  if (post.series) {
    const { results } = await env.DB.prepare(
      `SELECT slug, title, series_order FROM posts
       WHERE series = ? AND is_private = 0 AND hidden = 0
       ORDER BY series_order ASC, created_at ASC`
    )
      .bind(post.series)
      .all();
    seriesPosts = results;
  }

  const site = await getSite(env);
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
  // 只有预设自动图能确认尺寸（1200×784 JPEG），正文图尺寸未知就不标
  const ogSized = isAutoCover(post);

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

  const article = `<article>
      <header class="post-head">
        <h1>${esc(post.title)}${
          post.is_private ? ' <span class="tag" style="background:var(--accent-soft);color:var(--accent)">私密</span>' : ''
        }</h1>
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
    </article>

    ${renderComments(cmtRows, cmtRows.length)}`;

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
    ogSized ? `<meta property="og:image:type" content="image/jpeg">` : '',
    ogSized ? `<meta property="og:image:width" content="1200">` : '',
    ogSized ? `<meta property="og:image:height" content="784">` : '',
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
    .replace(/<main class="wrap" id="page">[\s\S]*?<\/main>/, `<main class="wrap" id="page">${article}</main>`);

  return html(stampAssets(injected, env), 200, {
    // 私密文章不进缓存；公开文章统一走 pageCacheControl（浏览器不缓存、边缘 60s + SWR 600s）
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
  { href: '/archive', label: '归档', key: 'archive' },
  { href: '/friends', label: '友链', key: 'friends' },
  { href: '/about', label: '关于', key: 'about' },
];

const THEME_BTN = `<button class="theme-btn" data-theme-btn type="button" aria-label="切换风格" aria-expanded="false" title="切换风格"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18 2.2 2.2 0 0 0 1.7-3.6 2.2 2.2 0 0 1 1.7-3.6H18A3 3 0 0 0 21 10.8 9 9 0 0 0 12 3Z"/><circle cx="8" cy="9.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.4" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="16.4" cy="9.4" r="1.1" fill="currentColor" stroke="none"/></svg></button>`;

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
    if (t) extra.push(`<a href="${esc(path)}" class="active">#${esc(t)}</a>`);
  } else if (path.startsWith('/cat/')) {
    const c = catBySlug(decodeURIComponent(path.slice(5).split('/')[0] || ''));
    if (c) extra.push(`<a href="/cat/${c.slug}" class="active">${esc(c.name)}</a>`);
  }

  const links = NAV.map(
    (l) => `<a href="${l.href}"${active === l.key ? ' class="active"' : ''}>${l.label}</a>`
  ).join('');

  return `<header class="site">
    <div class="inner">
      <a class="brand" href="/">${avatar}<span class="brand-name">${esc(name)}<span class="dot">.</span></span></a>
      ${desc ? `<span class="brand-desc" title="${esc(desc)}">${esc(desc)}</span>` : ''}
      <nav class="top">${links}${extra.join('')}<span id="nav-user"></span>${THEME_BTN}</nav>
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
  const cover = `<img class="thumb" src="${esc(p.cover || autoThumb(p))}" alt="" loading="lazy" decoding="async" width="208" height="136">`;
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

async function listQuery(env, url) {
  const p = listParams(url);
  if (!p) return null;
  try {
    return { ...p, data: await listPosts(env.DB, { page: p.page, size: 10, tag: p.tag, cat: p.cat }) };
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
    .replace('<!--LIST-->', cards)
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
       WHERE is_private = 0 AND hidden = 0 GROUP BY category`
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
async function harden(res, env) {
  // 配了 Turnstile 才在 CSP 里放行它的域名；没配就保持零第三方
  const tsOn = !!(env && env.TURNSTILE_SITE_KEY);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: securityHeaders(new Headers(res.headers), null, { turnstile: tsOn }),
    });
  }
  const nonce = makeNonce();
  // 先混淆邮箱再补 nonce：解码脚本是内联的，得跟着一起拿到 nonce
  const body = applyNonce(obfuscateEmail(await res.text()), nonce);
  const headers = securityHeaders(new Headers(res.headers), nonce, { turnstile: tsOn });
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
<script>window.__THEME_DEFAULT__=${cfg};(function(){var d=document.documentElement,t=null,m=null;try{t=localStorage.getItem('x_theme');m=localStorage.getItem('x_mode')}catch(e){}var g=window.__THEME_DEFAULT__||{};t=t||g.theme||'paper';m=m||g.mode||'auto';var sys=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;var dark=(m==='dark')||(m!=='light'&&sys);d.setAttribute('data-theme',t);d.setAttribute('data-mode',dark?'dark':'light');d.setAttribute('data-mpref',m)})();</script>
<link rel="stylesheet" href="/style.css">
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
     WHERE is_private = 0 AND hidden = 0
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

  // lastBuildDate 取最近一次改动的时间：聚合器靠它判断要不要重抓
  const lastPost = results[0];
  const lastBuild = lastPost ? rfc822(lastPost.updated_at || lastPost.created_at) : new Date().toUTCString();
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
  const publicOnly = 'p.is_private = 0 AND p.hidden = 0';

  const [{ results: posts }, { results: cats }, { results: tags }] = await Promise.all([
    env.DB.prepare(
      `SELECT p.slug, p.updated_at FROM posts p WHERE ${publicOnly}
       ORDER BY COALESCE(NULLIF(p.published_at, ''), p.created_at) DESC LIMIT 1000`
    ).all(),
    env.DB.prepare(
      `SELECT p.category AS c, COUNT(*) AS n FROM posts p WHERE ${publicOnly} AND TRIM(COALESCE(p.category,'')) != '' GROUP BY p.category`
    ).all(),
    env.DB.prepare(
      `SELECT t.name AS n, COUNT(*) AS c FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       JOIN posts p ON p.id = pt.post_id AND ${publicOnly}
       GROUP BY t.name ORDER BY c DESC`
    ).all(),
  ]);

  const urls = posts
    .map(
      (p) =>
        `  <url><loc>${origin}/p/${encodeURIComponent(p.slug)}</loc><lastmod>${String(p.updated_at || '').slice(0, 10)}</lastmod></url>`
    )
    .join('\n');

  // 栏目页只在真有文章时进 sitemap；空栏目页对爬虫是薄内容
  const catUrls = [...new Set(cats.map((r) => normalizeCat(r.c)).filter(Boolean))]
    .map((slug) => `  <url><loc>${origin}/cat/${slug}</loc></url>`)
    .join('\n');

  const tagUrls = tags
    .filter((t) => t.c > 0)
    .map((t) => `  <url><loc>${origin}/tag/${encodeURIComponent(t.n)}</loc></url>`)
    .join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/</loc></url>\n  <url><loc>${origin}/archive</loc></url>\n  <url><loc>${origin}/categories</loc></url>\n  <url><loc>${origin}/friends</loc></url>\n${catUrls}\n${tagUrls}\n${urls}\n</urlset>`,
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
  } else if (url && url.pathname.startsWith('/thumbs/')) {
    // 预设头图：文件不变，但换图集时文件名复用，所以给一天而不是一年
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

  // 标签页 / 栏目页复用首页骨架，前端读路径
  if (path.startsWith('/tag/')) {
    const tag = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (!tag) return await notFoundPage(env, request, '页面走丢了');
    // 没有任何公开文章的标签页就是薄内容，直接 404，别让爬虫收一堆空页
    const hit = await env.DB.prepare(
      `SELECT 1 FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0
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
  },
};
