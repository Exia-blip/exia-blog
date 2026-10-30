import { handleApi } from './api.js';
import { loginRedirect, handleCallback, logout, currentUser } from './auth.js';
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

  const desc = extractExcerpt(post.content, 150);
  const cover = post.cover || '';
  const siteName = (await getSite(env)).name;
  const canonical = new URL(`/${post.slug}`, request.url).toString();

  const meta = [
    `<title>${esc(post.title)} · ${esc(siteName)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${esc(post.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    cover ? `<meta property="og:image" content="${esc(new URL(cover, request.url))}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`,
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

/* ---------- 主题默认值注入（首访不闪） ---------- */
async function injectTheme(env, res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return res;

  const body = await res.text();
  if (!body.includes('<!--THEME-->')) return new Response(body, res);

  const s = await getSite(env);
  const cfg = JSON.stringify({ theme: s.theme, mode: s.mode }).replace(/</g, '\\u003c');
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(body.replace('<!--THEME-->', `<script>window.__THEME_DEFAULT__=${cfg}</script>`), {
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
    `SELECT slug, title, content, created_at FROM posts
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
      <description>${esc(extractExcerpt(p.content, 200))}</description>
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

/* ---------- 入口 ---------- */
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/api/')) return await handleApi(env, request, url);
  if (path === '/auth/github') return loginRedirect(env, request);
  if (path === '/auth/callback') return await handleCallback(env, request);
  if (path === '/auth/logout') return logout();
  if (path.startsWith('/img/')) return await serveImage(env, path.slice('/img/'.length));
  if (path === '/rss.xml') return await serveRss(env, request);
  if (path === '/sitemap.xml') return await serveSitemap(env, request);

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
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return await servePostPage(env, request, decodeURIComponent(segs[0]));
  }

  // 其它交给静态资源
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) return await notFoundPage(env, request);
  return res;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await injectTheme(env, await route(request, env));
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkFriends(env));
  },
};
