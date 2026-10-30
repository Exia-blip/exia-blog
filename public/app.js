// 前端公共层：API 封装 / 时间格式化 / 顶部导航 / 提示
export async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
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
  try {
    SITE = await api('/api/site');
  } catch {
    SITE = { name: 'Exia Blog', desc: '' };
  }
  return SITE;
}

/* 顶部导航 */
export async function mountHeader(active = '') {
  const { buttonHTML, initSwitcher } = await import('/theme.js');
  const host = document.getElementById('site-header');
  if (!host) return null;
  const [user, s] = await Promise.all([me(), site()]);
  const siteName = s.name || host.dataset.site || 'Exia Blog';
  document.title = document.title.replace(/^首页$/, siteName);

  const links = [
    { href: '/', label: '首页', key: 'home' },
    { href: '/categories', label: '栏目', key: 'categories' },
    { href: '/archive', label: '归档', key: 'archive' },
    { href: '/friends', label: '友链', key: 'friends' },
    { href: '/about', label: '关于', key: 'about' },
  ];

  host.outerHTML = `
  <header class="site">
    <div class="inner">
      <a class="brand" href="/">${esc(siteName)}<span class="dot">.</span></a>
      <nav class="top">
        ${links
          .map((l) => `<a href="${l.href}" class="${active === l.key ? 'active' : ''}">${l.label}</a>`)
          .join('')}
        ${active === 'tag' ? `<a href="javascript:;" class="active">#${esc(new URLSearchParams(location.search).get('t') || '')}</a>` : ''}
        ${
          user
            ? `<a href="/editor" class="${active === 'editor' || active === 'mine' ? 'active' : ''}">${user.is_admin ? '后台' : '写作'}</a>
               <a href="/auth/logout" title="退出">${user.avatar ? `<img class="avatar-xs" src="${esc(user.avatar)}" alt="">` : '退出'}</a>`
            : `<a href="/login">登录</a>`
        }
        ${buttonHTML}
      </nav>
    </div>
  </header>`;
  initSwitcher();
  return user;
}

/* 复制代码按钮 */
export function bindCopyButtons(root = document) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const wrap = btn.closest('.code-wrap');
    const code = wrap?.querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.innerText).then(
      () => {
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1400);
      },
      () => toast('复制失败')
    );
  });
}
