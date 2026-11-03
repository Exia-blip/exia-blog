import { handleApi, listPosts } from './api.js';
import { loginRedirect, handleCallback, logout, authStatus, currentUser } from './auth.js';
import { html, json } from './utils.js';
import { checkFriends } from './cron.js';
import { getSite } from './settings.js';
import { extractExcerpt, extractCover, readingTime, renderBody } from '../public/md.js';
import { sanitizeHtml } from './clean.js';
import { makeNonce, applyNonce, securityHeaders } from './security.js';
import { ldJson, siteLd, postLd, listLd, iso } from './seo.js';
import { edgeGet, edgePut, EDGE_TTL, EDGE_SWR, pageCacheControl } from './cache.js';
import { CATS, catBySlug, catName, normalizeCat } from './taxonomy.js';

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
  return new Response(obj.body, { headers });
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
        <div class="row" id="guest-fields">
          <input type="text" name="name" placeholder="昵称 *" maxlength="40" autocomplete="nickname">
          <input type="email" name="email" placeholder="联系邮箱 *（不公开，仅博主可见）" maxlength="120" autocomplete="email">
          <input type="url" name="website" placeholder="网站（可选）" maxlength="200">
        </div>
        <textarea name="content" placeholder="说点什么…" maxlength="2000"></textarea>
        <div class="foot">
          <span class="tiny muted" id="cmt-hint"></span>
          <button class="btn primary sm" type="submit">发表评论</button>
        </div>
      </form>
    </section>`;
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
  const cover = post.cover || extractCover(post.content) || '';
  // 封面 → 本站默认分享图。站点头像不参与：GitHub 头像只有 460px，社交卡片会糊成一团，
  // 而且外链域名不受自己控制（改天换图床就 404）。
  const ogImage = cover ? new URL(cover, request.url).toString() : `${origin}/og-default.jpg`;
  const isDefaultOg = !cover;

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
          ${post.avatar ? `<img class="avatar-xs" src="${esc(post.avatar)}" alt="" width="20" height="20">` : ''}
          <span>${esc(post.author_name || post.login || '')}</span>
          <span class="sep-dot">${esc(String(post.created_at || '').slice(0, 10))}</span>
          <span class="sep-dot">${reading} 分钟阅读</span>
          ${
            post.updated_at && post.updated_at !== post.created_at
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
    isDefaultOg ? `<meta property="og:image:type" content="image/jpeg">` : '',
    isDefaultOg ? `<meta property="og:image:width" content="1200">` : '',
    isDefaultOg ? `<meta property="og:image:height" content="630">` : '',
    `<meta property="article:published_time" content="${esc(iso(post.created_at))}">`,
    `<meta property="article:modified_time" content="${esc(iso(post.updated_at, iso(post.created_at)))}">`,
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
    ? `<img class="brand-avatar" src="${esc(site.avatar)}" alt="" loading="eager">`
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
  const cover = p.cover
    ? `<img class="thumb" src="${esc(p.cover)}" alt="" loading="lazy" decoding="async" width="208" height="136">`
    : '';
  const tags = (p.tags || [])
    .slice(0, 3)
    .map((t) => `<span class="tag">#${esc(t)}</span>`)
    .join('');
  return `<a class="post-card" href="/p/${encodeURIComponent(p.slug)}">${cover}<div class="body"><h2>${esc(p.title)}${
    p.is_private ? ' <span class="tiny muted">私密</span>' : ''
  }</h2>${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ''}<div class="meta"><span>${esc(
    String(p.created_at || '').slice(0, 10)
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

async function renderList(env, body, url) {
  if (!body.includes('<!--LIST-->')) return { body, list: null };

  const path = url.pathname;
  let tag = '';
  let cat = '';
  if (path.startsWith('/tag/')) tag = decodeURIComponent(path.slice(5).split('/')[0] || '');
  else if (path.startsWith('/cat/')) cat = decodeURIComponent(path.slice(5).split('/')[0] || '');
  else if (path !== '/') return { body, list: null };

  // 搜索结果分页靠前端接管，这里只兜首屏
  if (url.searchParams.get('q')) return { body, list: null };

  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const base = tag ? `/tag/${encodeURIComponent(tag)}` : cat ? `/cat/${encodeURIComponent(cat)}` : '/';

  let data;
  try {
    data = await listPosts(env.DB, { page, size: 10, tag, cat });
  } catch (e) {
    console.error('list ssr failed', e);
    return { body: body.replace('<!--LIST-->', SKELETON), list: null };
  }

  const cards = data.posts.length
    ? data.posts.map(postCard).join('')
    : `<div class="empty">${tag || cat ? '这个栏目下还没有文章' : '还没有文章，去写第一篇吧'}</div>`;

  const boot = JSON.stringify({ page: data.page, pages: data.pages, total: data.total }).replace(/</g, '\\u003c');
  const out = body
    .replace('<!--LIST-->', cards)
    .replace('<!--PAGER-->', pagerHtml(page, data.pages, data.total, base))
    .replace('</head>', `<script>window.__LIST__=${boot};</script></head>`);

  return { body: out, list: data };
}

/* ---------- 栏目页 SSR：四个固定栏目直接进 HTML ----------
   栏目就四个，哪怕暂时没有文章也该出现在页面上（空栏目比缺栏目好解释），
   顺便让栏目页对爬虫是一张有内容的目录页，而不是「加载中…」。 */
async function renderCats(env, body) {
  if (!body.includes('<!--CATS-->')) return body;

  let counts = new Map();
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

  const cells = CATS.map(
    (c) => `<a class="tax-cell cat-cell" href="/cat/${c.slug}">
      <span class="tax-name">${esc(c.name)}<span class="cat-slug">${esc(c.slug)}</span></span>
      <span class="tax-desc">${esc(c.desc)}</span>
      <span class="tax-count">${counts.get(c.slug) || 0}</span>
    </a>`
  ).join('');

  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  return body
    .replace('<!--CATS-->', cells)
    .replace('<!--CAT-TOTAL-->', `${CATS.length} 个栏目 · ${sum} 篇`);
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

  const block = [
    `<title>${esc(title)}</title>`,
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

  const s = await getSite(env);
  const cfg = JSON.stringify({ theme: s.theme, mode: s.mode }).replace(/</g, '\\u003c');
  // 站点头像与站名先落到 window.__SITE__，导航渲染时能立刻用
  const siteCfg = JSON.stringify({ name: s.name, desc: s.desc, avatar: s.avatar }).replace(/</g, '\\u003c');
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

  const { body: listed, list } = await renderList(env, body, url);
  body = await renderCats(env, listed);

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
async function harden(res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: securityHeaders(new Headers(res.headers), null),
    });
  }
  const nonce = makeNonce();
  const body = applyNonce(await res.text(), nonce);
  const headers = securityHeaders(new Headers(res.headers), nonce);
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
    `SELECT slug, title, content, summary, created_at, updated_at FROM posts
     WHERE is_private = 0 AND hidden = 0 ORDER BY created_at DESC LIMIT 30`
  ).all();

  const origin = new URL(request.url).origin;
  const { name: siteName, desc: siteDesc } = await getSite(env);
  const items = results
    .map((p) => {
      const link = `${origin}/p/${encodeURIComponent(p.slug)}`;
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${rfc822(p.created_at)}</pubDate>
      <description>${esc(p.summary || extractExcerpt(p.content, 200))}</description>
    </item>`;
    })
    .join('\n');

  // lastBuildDate 取最近一次改动的时间：聚合器靠它判断要不要重抓
  const lastPost = results[0];
  const lastBuild = lastPost ? rfc822(lastPost.updated_at || lastPost.created_at) : new Date().toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
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
      `SELECT p.slug, p.updated_at FROM posts p WHERE ${publicOnly} ORDER BY p.created_at DESC LIMIT 1000`
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
  return body.replace(/(["'])\/(style\.css|app\.js|theme\.js|md\.js|boot\.js)\1/g, (m, q, f) => `${q}/${f}?v=${v}${q}`);
}

async function asset(env, request, url) {
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('text/html')) return res;

  const headers = new Headers(res.headers);
  const cc = headers.get('cache-control') || '';
  if (url?.searchParams.has('v')) {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
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

  // 归档 / 时间线
  if (path === '/archive' || /^\/archive\/\d{4}\/?$/.test(path)) {
    // 注意用无后缀路径：/xxx.html 会被 Assets 以 307 重定向到 /xxx
    const res = await env.ASSETS.fetch(new Request(new URL('/archive', request.url), request));
    if (res.status === 200) return html(await res.text());
  }

  // 栏目总览（分类 + 标签）
  if (path === '/categories') {
    const res = await env.ASSETS.fetch(new Request(new URL('/categories', request.url), request));
    if (res.status === 200) return html(await res.text());
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
      res = await harden(res);

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
