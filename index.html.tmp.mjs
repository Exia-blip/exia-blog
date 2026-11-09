
import { api, fmtDate, esc, mountHeader, toast, site } from '/app.js';
import { autoThumb } from '/cover.js';

const listEl = document.getElementById('list');
const tagbarEl = document.getElementById('tagbar');
const catbarEl = document.getElementById('catbar');
const pagerEl = document.getElementById('pager');
const qInput = document.getElementById('q');

// 路由：/tag/名字 或 /?q=
const pathParts = location.pathname.split('/').filter(Boolean);
let currentTag = pathParts[0] === 'tag' ? decodeURIComponent(pathParts[1] || '') : '';
let currentCat = pathParts[0] === 'cat' ? decodeURIComponent(pathParts[1] || '') : '';
let currentQ = new URLSearchParams(location.search).get('q') || '';
let page = parseInt(new URLSearchParams(location.search).get('page') || '1', 10) || 1;

qInput.value = currentQ;

const SITE = await site();

if (currentCat) {
  // 服务端已经按栏目名渲染过一遍，这里只在客户端兜底（栏目改名/直接改 URL 时）
  const C = window.__CAT__ || {};
  const cname = C.name || currentCat;
  document.getElementById('hero-title').textContent = cname;
  document.getElementById('hero-sub').textContent = C.desc || `栏目「${cname}」下的全部文章`;
  document.title = `${cname} · ${SITE.name}`;
} else if (currentTag) {
  // 标签页的 H1 与 title 已由 Worker 按路径服务端渲染好，这里只在 SSR 没跑到时兜底
  if (!document.title.startsWith('#')) {
    document.getElementById('hero-title').textContent = `#${currentTag}`;
    document.getElementById('hero-sub').textContent = `标签「${currentTag}」下的全部文章`;
    document.title = `#${currentTag} · ${SITE.name}`;
  }
} else if (currentQ) {
  document.getElementById('hero-title').textContent = `搜索：${currentQ}`;
  document.getElementById('hero-sub').textContent = '标题与正文关键词匹配';
  document.title = `${currentQ} · 搜索`;
} else {
  document.getElementById('hero-title').textContent = SITE.name;
  document.getElementById('hero-sub').textContent = SITE.desc || '记录思考、代码与生活。';
  document.title = SITE.name;
}

let ctrl = null;

async function load() {
  // 连打关键词时只保留最后一次请求，避免旧结果盖住新结果
  if (ctrl) ctrl.abort();
  ctrl = new AbortController();
  const mine = ctrl;

  listEl.setAttribute('aria-busy', 'true');
  listEl.innerHTML = skeleton();

  const params = new URLSearchParams({ page: String(page), size: '10' });
  if (currentTag) params.set('tag', currentTag);
  if (currentCat) params.set('cat', currentCat);
  if (currentQ) params.set('q', currentQ);

  try {
    const { posts, total, pages } = await api('/api/posts?' + params, { signal: mine.signal });
    if (mine !== ctrl) return;
    if (!posts.length) {
      listEl.innerHTML = `<div class="empty">${currentQ ? '没有找到匹配的文章' : '还没有文章，去写第一篇吧'}</div>`;
      pagerEl.innerHTML = '';
      return;
    }
    listEl.innerHTML = posts.map(card).join('');
    renderPager(pages, total);
  } catch (e) {
    if (e.name === 'AbortError' || mine !== ctrl) return;
    listEl.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><a class="btn sm" href="javascript:location.reload()" style="margin-top:12px">重试</a></div>`;
  } finally {
    if (mine === ctrl) listEl.setAttribute('aria-busy', 'false');
  }
}

function skeleton(n = 3) {
  return Array.from({ length: n })
    .map(
      () =>
        '<div class="sk-card"><div class="sk sk-thumb"></div><div class="sk-body"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div></div>'
    )
    .join('');
}

function card(p) {
  return `
  <a class="post-card" href="/p/${encodeURIComponent(p.slug)}">
    <img class="thumb" src="${esc(p.cover || autoThumb(p))}" alt="" loading="lazy" decoding="async" width="208" height="136">
    <div class="body">
      <h2>${esc(p.title)}${p.is_private ? ' <span class="tiny muted">私密</span>' : ''}</h2>
      ${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ''}
      <div class="meta">
        <span>${fmtDate(p.published_at || p.created_at)}</span>
        <span class="sep-dot">${p.reading} 分钟</span>
        ${p.comments ? `<span class="sep-dot">${p.comments} 条评论</span>` : ''}
        ${p.category ? `<span class="tag cat-chip">${esc(p.category_name || p.category)}</span>` : ''}
        ${(p.tags || []).slice(0, 3).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
      </div>
    </div>
  </a>`;
}

function renderPager(pages, total) {
  if (pages <= 1) { pagerEl.innerHTML = ''; return; }
  const qs = (p) => {
    const u = new URLSearchParams();
    if (currentQ) u.set('q', currentQ);
    u.set('page', String(p));
    const base = currentCat
      ? `/cat/${encodeURIComponent(currentCat)}?`
      : currentTag
        ? `/tag/${encodeURIComponent(currentTag)}?`
        : '/?';
    return base + u.toString();
  };
  pagerEl.innerHTML = `
    ${page > 1 ? `<a class="btn sm" href="${qs(page - 1)}">← 上一页</a>` : ''}
    <span class="page-info">${page} / ${pages}　共 ${total} 篇</span>
    ${page < pages ? `<a class="btn sm" href="${qs(page + 1)}">下一页 →</a>` : ''}`;
}

async function loadCats() {
  try {
    const { categories } = await api('/api/categories');
    if (!categories.length) { catbarEl.innerHTML = ''; return; }
    catbarEl.innerHTML =
      `<span class="bar-label">栏目</span>` +
      `<a class="tag" href="/" style="${!currentCat && !currentTag ? 'background:var(--accent-soft);color:var(--accent)' : ''}">全部</a>` +
      categories.map((c) => `<a class="tag cat-chip" href="/cat/${encodeURIComponent(c.slug)}" title="${esc(c.desc || '')}"
        style="${currentCat === c.slug ? 'background:var(--accent-soft);color:var(--accent)' : ''}">${esc(c.name)} ${c.count}</a>`).join('');
  } catch {}
}

async function loadTags() {
  try {
    const { tags } = await api('/api/tags');
    if (!tags.length) return;
    tagbarEl.innerHTML =
      `<span class="bar-label">标签</span>` +
      `<a class="tag" href="/" style="${!currentTag ? 'background:var(--accent-soft);color:var(--accent)' : ''}">全部</a>` +
      tags.map((t) => `<a class="tag" href="/tag/${encodeURIComponent(t.name)}"
        style="${currentTag === t.name ? 'background:var(--accent-soft);color:var(--accent)' : ''}">#${esc(t.name)} ${t.count}</a>`).join('');
  } catch {}
}

let timer;
qInput.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const v = qInput.value.trim();
    const url = new URL(location.href);
    if (v) url.searchParams.set('q', v); else url.searchParams.delete('q');
    url.searchParams.delete('page');
    if (currentCat) {
      location.href = `/cat/${encodeURIComponent(currentCat)}${v ? '?q=' + encodeURIComponent(v) : ''}`;
    } else if (currentTag) {
      location.href = `/tag/${encodeURIComponent(currentTag)}${v ? '?q=' + encodeURIComponent(v) : ''}`;
    } else {
      history.replaceState(null, '', url);
      currentQ = v;
      page = 1;
      document.getElementById('hero-title').textContent = v ? `搜索：${v}` : SITE.name;
      document.getElementById('hero-sub').textContent = v
        ? '标题与正文关键词匹配'
        : SITE.desc || '记录思考、代码与生活。';
      load();
    }
  }, 320);
});

mountHeader(currentTag ? 'tag' : currentCat ? 'cat' : 'home');
loadCats();
loadTags();

// 文章列表与分页已经由服务端渲染好了，只有搜索要走接口
const BOOT = window.__LIST__;
if (!BOOT || currentQ) load();
