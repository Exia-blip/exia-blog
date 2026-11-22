// 后台导航与外壳：服务端页面（统计 / 健康检查 / 定时队列）共用同一套侧栏。
// editor.html 是静态资源，菜单内联在同一份里；test-admin-nav.mjs 会比对两边，
// 防止改了一处忘了另一处。
import { avatarSrc } from '../public/avatar.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);

/* 主题防闪引导：和 public/editor.html head 里那段等价。服务端渲染的统计/健康/队列
   页没有静态模板，之前漏了这段——用户选的深色只存在 localStorage，这三页读不到
   就回落到系统浅色，表现为「别的页黑、这三页白」。脚本经出口统一补 nonce，不新增
   CSP 面；改动这段必须同步 editor.html 里那份（test-admin-nav 会比对关键特征）。 */
export const THEME_BOOT_JS = `(function(){var d=document.documentElement,t=null,m=null;try{t=localStorage.getItem('x_theme');m=localStorage.getItem('x_mode')}catch(e){}var g=window.__THEME_DEFAULT__||{};t=t||g.theme||'paper';m=m||g.mode||'auto';var s=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;var dark=(m==='dark')||(m!=='light'&&s);d.setAttribute('data-theme',t);d.setAttribute('data-mode',dark?'dark':'light');d.setAttribute('data-mpref',m);(function(){var L=document.getElementById('tcss-default'),trivial=(t==='paper'||t==='anzhiyu');if(trivial){if(L)document.head.removeChild(L);return}if(L){L.id='tcss-'+t;L.href='/theme/'+t+'.css'}else{var S=document.createElement('link');S.id='tcss-'+t;S.rel='stylesheet';S.href='/theme/'+t+'.css';document.head.appendChild(S)}})()})();`;

/** 服务端页 head 注入：站点默认主题 + 防闪引导，顺序与 editor.html 一致。 */
export function themeBoot(site = {}) {
  const cfg = JSON.stringify({ theme: site.theme || 'paper', mode: site.mode || 'auto' }).replace(/</g, '\\u003c');
  return `<script>window.__THEME_DEFAULT__=${cfg};</script><script>${THEME_BOOT_JS}</script>`;
}

/* 图标全用线性 stroke，和参考站同一视觉语言；width/height 交给 CSS 统一控制。 */
const ICON = {
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  check: '<path d="m3 12 5 5L21 4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 21 10.1H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};

const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/* 菜单唯一事实来源。单一分组平铺——和参考站一样，一组标签 + 一列入口，
   不再按「内容管理/站点运维/其它」切成三段，避免侧栏被标签切碎。
   key 用于测试比对，href 是真实落点。 */
export const ADMIN_NAV = [
  { key: 'dash', text: '工作台', href: '/admin', icon: 'grid', id: 'nav-dash' },
  { key: 'review', text: '投稿审核', href: '/admin/review', icon: 'check', id: 'nav-review' },
  { key: 'cmts', text: '评论审核', href: '/admin/comments', icon: 'check', id: 'nav-cmts' },
  { key: 'write', text: '写作', href: '/editor', icon: 'write', id: 'nav-write' },
  { key: 'posts', text: '文章列表', href: '/editor?panel=posts', icon: 'list', id: 'nav-posts' },
  { key: 'checks', text: '发布自检', href: '/editor?panel=checks', icon: 'check', id: 'nav-checks' },
  { key: 'series', text: '系列', href: '/editor?panel=series', icon: 'layers', id: 'nav-series' },
  { key: 'site', text: '站点设置', href: '/editor?panel=site', icon: 'gear', id: 'nav-site' },
  { key: 'stats', text: '访问统计', href: '/admin/stats', icon: 'chart', id: 'nav-stats' },
  { key: 'health', text: '健康检查', href: '/admin/health', icon: 'shield', id: 'nav-health' },
  { key: 'audit', text: '操作日志', href: '/admin/audit', icon: 'list', id: 'nav-audit' },
  { key: 'friends', text: '友链管理', href: '/admin/friends', icon: 'grid', id: 'nav-friends' },
  { key: 'queue', text: '定时队列', href: '/admin/queue', icon: 'clock', id: 'nav-queue' },
  { key: 'home', text: '返回站点', href: '/', icon: 'home', id: 'nav-home' },
];

export function renderAdminNav(active = '') {
  return `<div class="admin-nav-label">后台管理</div>
    <nav class="admin-nav" aria-label="后台管理">${ADMIN_NAV.map((it) => {
      const on = it.key === active;
      return `<a${on ? ' class="on" aria-current="page"' : ''} href="${esc(it.href)}" id="${it.id}">${svg(
        it.icon
      )}<span>${esc(it.text)}</span></a>`;
    }).join('')}</nav>`;
}

/** 服务端页面统一外壳。body 是 <main> 里的内容，不在这里转义。
    头部只留 h1 + 一句说明，和写作页同一套（不再压一个「后台管理」小标签，
    那和侧栏的分组标题重复）。 */
export function renderAdminShell({ site = {}, active = '', title, desc = '', body = '', bodyClass = '' }) {
  const ava = site.avatar
    ? `<img class="admin-ava" src="${esc(avatarSrc(site.avatar, 96))}" alt="" width="48" height="48">`
    : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(site.name || 'Exia Blog')}</title>
<meta name="robots" content="noindex,nofollow">
${themeBoot(site)}
<link rel="stylesheet" href="/style.css">
</head><body class="${esc(bodyClass || 'stat-page')}">
<div class="admin-shell">
  <aside class="admin-rail">
    <div class="admin-rail-top">
      <a class="admin-brand" href="/" title="返回站点">
        ${ava}
        <span class="admin-brand-txt">
          <strong>${esc(site.name || 'Exia Blog')}</strong>
          <small>返回站点</small>
        </span>
      </a>
      <label class="nav-toggle" for="nav-toggle" title="展开菜单" aria-label="展开菜单">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </label>
    </div>
    <input type="checkbox" id="nav-toggle" class="nav-cb" hidden>
    <div class="admin-nav-wrap">
      ${renderAdminNav(active)}
    </div>
  </aside>
  <main class="admin-main">
    <header class="admin-head">
      <h1>${esc(title)}</h1>
      ${desc ? `<p>${desc}</p>` : ''}
    </header>
    ${body}
  </main>
</div>
</body></html>`;
}
