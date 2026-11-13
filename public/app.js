// 前端公共层：API 封装 / 时间格式化 / 顶部导航 / 提示
import { avatarSrc } from '/avatar.js';

/* 图片加载失败兜底：CSP 之下不能再用 onerror 内联属性，统一在这里收 */
document.addEventListener(
  'error',
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement)) return;
    if (el.classList.contains('brand-avatar')) el.remove();
    else if (el.classList.contains('fav')) el.style.visibility = 'hidden';
  },
  true // error 事件不冒泡，必须捕获阶段
);

export async function api(path, { method = 'GET', body, raw, signal } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (signal) opts.signal = signal;
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (raw) return res;
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `HTTP ${res.status}` };
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export function fmtDate(s, withTime = false) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  if (isNaN(d)) return s;
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

export function fmtRelative(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  if (isNaN(d)) return s;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return fmtDate(s);
}

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ME;
export async function me() {
  if (ME !== undefined) return ME;
  try {
    const r = await api('/api/me');
    ME = r.user;
  } catch {
    ME = null;
  }
  return ME;
}

export function toast(msg, ms = 2200) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(14px);z-index:9999;' +
      'padding:9px 18px;border-radius:999px;background:var(--fg);color:var(--bg);font-size:13.5px;' +
      'opacity:0;transition:.22s;pointer-events:none;box-shadow:0 8px 24px -12px rgba(0,0,0,.5);max-width:80vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(14px)';
  }, ms);
}

/* 站点信息 */
let SITE;
export async function site() {
  if (SITE) return SITE;
  const boot = window.__SITE__ || {};
  try {
    SITE = await api('/api/site');
  } catch {
    SITE = { name: boot.name || 'Exia Blog', desc: boot.desc || '', avatar: boot.avatar || '' };
  }
  // 首屏已经在 HTML 里注入了头像，接口没回来之前先用它，省一次闪烁
  if (!SITE.avatar && boot.avatar) SITE.avatar = boot.avatar;
  return SITE;
}

/* 顶部导航
   正常情况下 Worker 已经把 <header class="site"> 渲染进 HTML 了，这里只补用户态，
   首屏不会先空一块再长出来；万一没注入（旧缓存 / 直连静态资源）再整块兜底渲染。 */
function userNav(user, active) {
  const isEditor = active === 'editor' || active === 'mine';
  // 统计只有管理员看得到，普通用户连入口都不该出现
  const stats = user.is_admin
    ? `<a href="/admin/stats"${active === 'stats' ? ' class="active"' : ''}>统计</a>`
    : '';
  return `<a href="/editor"${isEditor ? ' class="active"' : ''}>${user.is_admin ? '后台' : '写作'}</a>${stats}
    <a href="/auth/logout" title="退出">${user.avatar ? `<img class="avatar-xs" src="${esc(avatarSrc(user.avatar, 40))}" alt="" loading="lazy" decoding="async">` : '退出'}</a>`;
}

export async function mountHeader(active = '') {
  const host = document.getElementById('site-header');
  const ssr = document.querySelector('header.site');
  const [user, s] = await Promise.all([me(), site()]);
  const siteName = s.name || host?.dataset.site || 'Exia Blog';

  // 标签页标题统一「页面 · 站点名」，SSR 没注入到（静态资源缓存/直连）时前端再兜一层
  const curTitle = document.title.trim();
  if (curTitle !== siteName && !curTitle.includes(siteName)) {
    document.title = !curTitle || curTitle === '首页' ? siteName : `${curTitle} · ${siteName}`;
  }

  if (ssr) {
    const { initSwitcher } = await import('/theme.js');
    const slot = document.getElementById('nav-user');
    if (slot) slot.innerHTML = user ? userNav(user, active) : '<a href="/login">登录</a>';
    initSwitcher();
    initNavToggle();
    return user;
  }

  const { buttonHTML, initSwitcher } = await import('/theme.js');
  if (!host) return null;

  const siteDesc = (s.desc || '').trim();
  const links = [
    { href: '/', label: '首页', key: 'home' },
    { href: '/categories', label: '栏目', key: 'categories' },
    { href: '/series', label: '系列', key: 'series' },
    { href: '/archive', label: '归档', key: 'archive' },
    { href: '/friends', label: '友链', key: 'friends' },
    { href: '/about', label: '关于', key: 'about' },
  ];

  const avatar = s.avatar || '';
  // 有头像就显示，没有就退回首字母方块，导航不至于忽宽忽窄
  const brandMark = avatar
    ? `<img class="brand-avatar" src="${esc(avatarSrc(avatar, 64))}" alt="" width="32" height="32" loading="eager" decoding="async">`
    : `<span class="brand-avatar ph" aria-hidden="true">${esc((siteName || 'E').trim().charAt(0).toUpperCase())}</span>`;

  host.outerHTML = `
  <header class="site">
    <div class="inner">
      <a class="brand" href="/">${brandMark}<span class="brand-name">${esc(siteName)}<span class="dot">.</span></span></a>
      ${siteDesc ? `<span class="brand-desc" title="${esc(siteDesc)}">${esc(siteDesc)}</span>` : ''}
      <nav class="top" id="site-nav">
        ${links
          .map((l) =>
            `<a href="${l.href}"${active === l.key ? ' class="active" aria-current="page"' : ''}>${l.label}</a>`
          )
          .join('')}
        ${active === 'tag' ? `<span class="active" aria-current="page">#${esc(new URLSearchParams(location.search).get('t') || '')}</span>` : ''}
        <span id="nav-user">${user ? userNav(user, active) : '<a href="/login">登录</a>'}</span>
        ${buttonHTML}
      </nav>
      <button class="nav-toggle" id="nav-toggle" type="button" aria-label="打开导航" aria-expanded="false" aria-controls="site-nav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path class="nt-a" d="M4 7h16"/><path class="nt-b" d="M4 12h16"/><path class="nt-c" d="M4 17h16"/></svg></button>
    </div>
  </header>`;
  initSwitcher();
  initNavToggle();
  return user;
}

/* 窄屏汉堡。CSS 在 640 以下把 nav 变成抽屉，这里只管开合。
   桌面端按钮是 display:none，绑了也不会被点到，所以不用判断视口。 */
export function initNavToggle() {
  const btn = document.getElementById('nav-toggle');
  const nav = document.getElementById('site-nav');
  if (!btn || !nav || btn.dataset.bound) return;
  btn.dataset.bound = '1';

  const set = (on) => {
    nav.classList.toggle('open', on);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-expanded', String(on));
    btn.setAttribute('aria-label', on ? '关闭导航' : '打开导航');
  };
  const close = () => set(false);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    set(!nav.classList.contains('open'));
  });
  // 点了链接就收起来：同页锚点不会触发跳转重建，不主动收会一直挂着。
  // 色板也收 —— 主题面板是从底部弹的，抽屉开着会叠成两层背景，看着乱
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a') || e.target.closest('.theme-btn')) close();
  });
  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target) && !btn.contains(e.target)) close();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  // 转屏/拉宽回到桌面布局时，别把 open 状态留在 DOM 上
  addEventListener('resize', () => {
    if (innerWidth > 640) close();
  }, { passive: true });
}

/* 复制代码按钮 */
export function bindCopyButtons(root = document) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const wrap = btn.closest('.code-wrap');
    const code = wrap?.querySelector('pre.code-block > code:not(.gutter)');
    if (!code) return;
    navigator.clipboard.writeText(code.innerText).then(
      () => {
        btn.textContent = '已复制';
        btn.classList.add('done');
        clearTimeout(btn._t);
        btn._t = setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('done');
        }, 1400);
      },
      () => toast('复制失败')
    );
  });
}

/* 阅读进度条：文章页顶部一条细线，滚到文末刚好走满 */
export function bindReadingProgress(root = document.querySelector('.post-body')) {
  if (!root) return;
  let bar = document.querySelector('.read-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'read-bar';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
  }
  let raf = 0;
  const sync = () => {
    raf = 0;
    const r = root.getBoundingClientRect();
    // 正文高度减去一屏，才是真正需要滚动的距离；不足一屏就不显示这条线
    const span = r.height - window.innerHeight;
    if (span <= 20) {
      bar.style.opacity = '0';
      bar.style.transform = 'scaleX(0)';
      return;
    }
    const done = Math.min(1, Math.max(0, -r.top / span));
    bar.style.opacity = '1';
    bar.style.transform = `scaleX(${done.toFixed(4)})`;
  };
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(sync);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  sync();
}

/* 回到顶部：安知鱼主题下的悬浮圆按钮，其它主题不显示 */(function mountBackTop() {
  if (document.querySelector('.back-top')) return;
  const btn = document.createElement('button');
  btn.className = 'back-top';
  btn.type = 'button';
  btn.setAttribute('aria-label', '回到顶部');
  btn.title = '回到顶部';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
  document.body.appendChild(btn);

  // 滞回：往下过 400 才露出，回到 320 才收起。
  // 单阈值（>360）在边界上微滚会让按钮一直淡入淡出，看着像动画没完没了地重播
  let shown = false;
  const sync = () => {
    const y = window.scrollY || window.pageYOffset || 0;
    if (!shown && y > 400) shown = true;
    else if (shown && y < 320) shown = false;
    btn.classList.toggle('on', shown);
  };
  window.addEventListener('scroll', sync, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  sync();
})();
