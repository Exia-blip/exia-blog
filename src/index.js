import { handleApi, listPosts } from './api.js';
import { loginRedirect, handleCallback, logout, authStatus, currentUser } from './auth.js';
import { html, json } from './utils.js';
import { checkFriends } from './cron.js';
import { getSite } from './settings.js';
import { extractExcerpt } from '../public/md.js';

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

/* ---------- 文章页 SSR（注入 title / description / og） ---------- */
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

  const desc = post.summary || extractExcerpt(post.content, 150);
  const cover = post.cover || '';
  const site = await getSite(env);
  const siteName = site.name;
  // canonical 必须和 sitemap / RSS 里给的地址一致，否则同一篇文章被收录两份
  const canonical = new URL(`/p/${encodeURIComponent(post.slug)}`, request.url).toString();
  // 没封面就退到站点头像，社交卡片不至于空白
  const ogImage = cover || site.avatar || '';

  const meta = [
    `<title>${esc(post.title)} · ${esc(siteName)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="theme-color" content="${THEME_COLOR[site.theme] || '#f7f9fe'}">`,
    `<meta name="color-scheme" content="light dark">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<link rel="manifest" href="/manifest.webmanifest">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${esc(siteName)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:title" content="${esc(post.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="article:published_time" content="${esc(String(post.created_at).replace(' ', 'T') + 'Z')}">`,
    ogImage ? `<meta property="og:image" content="${esc(new URL(ogImage, request.url))}">` : '',
    `<meta name="twitter:card" content="${cover ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(post.title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
  ]
    .filter(Boolean)
    .join('\n  ');

  const injected = tpl.replace('<!--SEO-->', meta).replace(
    '<!--BOOT-->',
    `<script>window.__POST__=${JSON.stringify({
      slug: post.slug,
      title: post.title,
      is_private: !!post.is_private,
    }).replace(/</g, '\\u003c')};</script>`
  );

  return html(injected, 200, {
    // 私密文章不进缓存
    'cache-control': post.is_private ? 'private, no-store' : 'public, max-age=60',
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
    ? `<img class="brand-avatar" src="${esc(site.avatar)}" alt="" loading="eager" onerror="this.remove()">`
    : `<span class="brand-avatar ph" aria-hidden="true">${esc((name.trim() || 'E').charAt(0).toUpperCase())}</span>`;

  const extra = [];
  if (path.startsWith('/tag/')) {
    const t = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (t) extra.push(`<a href="${esc(path)}" class="active">#${esc(t)}</a>`);
  } else if (path.startsWith('/cat/')) {
    const c = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (c) extra.push(`<a href="${esc(path)}" class="active">${esc(c)}</a>`);
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
  let title = name;
  let sub = desc;
  if (path.startsWith('/tag/')) {
    const t = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (t) {
      title = `#${t}`;
      sub = `标签「${t}」下的全部文章`;
    }
  } else if (path.startsWith('/cat/')) {
    const c = decodeURIComponent(path.slice(5).split('/')[0] || '');
    if (c) {
      title = c;
      sub = `分类「${c}」下的全部文章`;
    }
  }
  return body
    .replace(/(<h1 id="hero-title"[^>]*>)[\s\S]*?(<\/h1>)/, `$1${esc(title)}$2`)
    .replace(/(<p id="hero-sub"[^>]*>)[\s\S]*?(<\/p>)/, `$1${esc(sub)}$2`);
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
  }${p.category ? `<span class="tag cat-chip">${esc(p.category)}</span>` : ''}${tags}</div></div></a>`;
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

/* ---------- 静态页 SEO：站点名进标签页标题、站点描述进 meta ----------
   文章页的 <!--SEO--> 已在 servePostPage 里换掉，这里只兜静态页（首页/归档/栏目/友链…） */
function fillSeo(body, site, url) {
  if (!body.includes('<!--SEO-->')) return body;

  const m = body.match(/<title>([\s\S]*?)<\/title>/i);
  let label = (m?.[1] || '').replace(/\s+/g, ' ').trim();
  // 标签页/分类页复用首页骨架，标签页标题得按路径算，不能沿用「首页」
  if (url && label === '首页') {
    const p = url.pathname;
    if (p.startsWith('/tag/')) label = '#' + decodeURIComponent(p.slice(5).split('/')[0] || '');
    else if (p.startsWith('/cat/')) label = decodeURIComponent(p.slice(5).split('/')[0] || '');
  }
  const home = !label || label === '首页';
  const title = home ? site.name : `${label} · ${site.name}`;
  const desc = site.desc || `${site.name} · 记录思考、代码与生活`;
  const canonical = url ? new URL(url.pathname, url.origin).toString() : '';

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
    site.avatar ? `<meta property="og:image" content="${esc(new URL(site.avatar, url || 'https://x/').toString())}">` : '',
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
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
  // 站点头像与站名先落到 window.__SITE__，导航渲染时能立刻用，也顺手当 favicon
  const siteCfg = JSON.stringify({ name: s.name, desc: s.desc, avatar: s.avatar }).replace(/</g, '\\u003c');
  const icon = s.avatar ? `<link rel="icon" href="${esc(s.avatar)}">` : '';
  const inject =
    `<script>window.__THEME_DEFAULT__=${cfg};window.__SITE__=${siteCfg};</script>${icon}`;

  body = fillSeo(body, s, url).replace('<!--THEME-->', inject);

  // 导航栏直接渲染进 HTML，省掉首屏空白与跳动
  body = body.replace(/<div id="site-header"[^>]*><\/div>/, renderHeader(s, url.pathname));
  body = renderHero(body, s, url.pathname);
  body = (await renderList(env, body, url)).body;

  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
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
async function serveRss(env, request) {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, content, summary, created_at FROM posts
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
      <pubDate>${new Date(String(p.created_at).replace(' ', 'T') + 'Z').toUTCString()}</pubDate>
      <description>${esc(p.summary || extractExcerpt(p.content, 200))}</description>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(siteName)}</title>
  <link>${origin}</link>
  <description>${esc(siteDesc)}</description>
  <language>zh-CN</language>
${items}
</channel></rss>`;

  return new Response(xml, {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}

async function serveSitemap(env, request) {
  const { results } = await env.DB.prepare(
    'SELECT slug, updated_at FROM posts WHERE is_private = 0 AND hidden = 0 ORDER BY created_at DESC LIMIT 1000'
  ).all();
  const origin = new URL(request.url).origin;
  const urls = results
    .map(
      (p) =>
        `  <url><loc>${origin}/p/${encodeURIComponent(p.slug)}</loc><lastmod>${String(p.updated_at || '').slice(0, 10)}</lastmod></url>`
    )
    .join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/</loc></url>\n  <url><loc>${origin}/archive</loc></url>\n  <url><loc>${origin}/categories</loc></url>\n${urls}\n</urlset>`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' } }
  );
}

/* ---------- 静态资源统一出口 ----------
   HTML 不能缓存（要注入主题），但 CSS/JS/图标这些没有用户态的可以放心缓存，
   否则每次站内跳转浏览器都要回来问一遍「变了没」 */
async function asset(env, request) {
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('text/html')) return res;

  const headers = new Headers(res.headers);
  const cc = headers.get('cache-control') || '';
  if (!cc || /max-age=0/.test(cc)) {
    // 5 分钟：站内连续浏览不用重复下载，改了样式也基本立刻能看到新版
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
  const origin = new URL(request.url).origin;
  const icon = s.avatar ? new URL(s.avatar, origin).toString() : '';
  const data = {
    name: s.name,
    short_name: s.name.slice(0, 12),
    description: s.desc || '',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: THEME_COLOR[s.theme] || '#ffffff',
    theme_color: THEME_COLOR[s.theme] || '#ffffff',
    lang: 'zh-CN',
    icons: icon ? [{ src: icon, sizes: '192x192 512x512 any', purpose: 'any' }] : [],
  };
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

/* ---------- 入口 ---------- */
const EDGE_TTL = 45;

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
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.set('cdn-cache-control', `public, s-maxage=${EDGE_TTL}`);
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

  // 标签页 / 分类页复用首页骨架，前端读路径
  if (path.startsWith('/tag/') || path.startsWith('/cat/')) {
    const res = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    const body = await res.text();
    return html(body);
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
    const hit = await asset(env, request);
    if (hit.status !== 404) return hit;
    return await servePostPage(env, request, decodeURIComponent(segs[0]));
  }

  // 其它交给静态资源
  const res = await asset(env, request);
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
        const hit = await caches.default.match(url.toString());
        if (hit) return asClient(hit);
      }

      const res = await injectTheme(env, await route(request, env, ctx), url);

      if (cacheable && res.status === 200 && (res.headers.get('content-type') || '').includes('text/html')) {
        // 存缓存用 s-maxage；回给浏览器的副本一律 max-age=0，
        // 否则 CF 会按 zone 的 Browser Cache TTL 把 HTML 在浏览器里压 4 小时
        const storeHeaders = new Headers(res.headers);
        storeHeaders.set('cache-control', `public, s-maxage=${EDGE_TTL}`);
        storeHeaders.delete('set-cookie');
        const stored = new Response(res.body, { status: res.status, statusText: res.statusText, headers: storeHeaders });
        ctx.waitUntil(caches.default.put(url.toString(), stored.clone()));
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
