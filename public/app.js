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
  // 未来时间（时钟偏差、预排评论）一律说「刚刚」，别出现「-3 分钟前」
  const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  // 超过一个月还不给「多久前」的话，就只剩一个日期 —— 三年后跟三个月后看着一样
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
  return `${Math.floor(diff / (86400 * 365))} 年前`;
}

/* 评论时间自愈。
   SSR 画的是「渲染那一刻」的多久前，而这份 HTML 会在边缘缓存最多 5 分钟，
   浏览器还可能再用自己那份 —— 页面开着不动时，「刚刚」可以一直是「刚刚」。
   加载时按 data-t 重算一遍，顺便把绝对时间塞进 title，悬停能看到准点。
   不设置定时器：评论区不常驻屏，每分钟重排一次 DOM 换不来什么。 */
export function refreshRelTimes(root = document) {
  const nodes = root.querySelectorAll('time.when[data-t]');
  for (const el of nodes) {
    const raw = el.getAttribute('data-t');
    const text = fmtRelative(raw);
    if (text && el.textContent.trim() !== text) el.textContent = text;
    el.title = fmtDate(raw, true);
  }
  return nodes.length;
}

/* 长评论折叠。
   阈值按「渲染后的高度」判，不按字数：同样 400 字，中文十二行、英文混排能到三十行，
   再夹一个代码块就更没准。量 scrollHeight 才是用户实际看到的东西。 */
const CMT_CLIP = 220;
export function enhanceComments(root = document) {
  let n = 0;
  for (const el of root.querySelectorAll('.cmt .text')) {
    if (el.dataset.enh === '1') continue;
    el.dataset.enh = '1';
    if (el.scrollHeight <= CMT_CLIP + 24) continue;
    el.classList.add('clipped');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cmt-more';
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '展开全文';
    btn.addEventListener('click', () => {
      const clipped = el.classList.toggle('clipped');
      btn.textContent = clipped ? '展开全文' : '收起';
      btn.setAttribute('aria-expanded', String(!clipped));
    });
    el.after(btn);
    n++;
  }
  return n;
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
      ${siteDesc && active !== 'home' ? `<span class="brand-desc" title="${esc(siteDesc)}">${esc(siteDesc)}</span>` : ''}
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

/* 代码块增强：折叠 / 语言提示 / 点行号复制该行。
   全部前端补钩子，不碰 md.js 的 SSR 输出 —— html_content 是落库的，
   改一次渲染就得全量回填，为一个交互不值得。长块（data-lines>=20）才给折叠。 */
const LANG_HINT = {
  js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript',
  jsx: 'JSX', tsx: 'TSX', py: 'Python', python: 'Python', sh: 'Shell', bash: 'Bash',
  shell: 'Shell', html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  sql: 'SQL', go: 'Go', rust: 'Rust', java: 'Java', c: 'C', cpp: 'C++', php: 'PHP',
  md: 'Markdown', markdown: 'Markdown', xml: 'XML', diff: 'Diff', dockerfile: 'Dockerfile',
};
export function enhanceCodeBlocks(root = document) {
  root.querySelectorAll('.code-wrap').forEach((wrap) => {
    // 语言徽章 hover 说人话：js → JavaScript，未知语言原样显示
    const lang = wrap.dataset.lang || '';
    const badge = wrap.querySelector('.code-lang');
    if (badge && lang) badge.title = `代码语言：${LANG_HINT[lang.toLowerCase()] || lang}`;

    const pre = wrap.querySelector('pre.code-block');
    const code = wrap && pre && pre.querySelector('code:not(.gutter)');
    if (!pre || !code) return;

    // 长块加折叠按钮，默认展开。按钮进已有的 .code-head，和复制并排。
    if ((+wrap.dataset.lines || 0) >= 20 && !wrap.querySelector('.fold-btn')) {
      const head = wrap.querySelector('.code-head');
      if (head) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fold-btn';
        btn.textContent = '收起';
        btn.setAttribute('aria-expanded', 'true');
        btn.addEventListener('click', () => {
          const folded = wrap.classList.toggle('folded');
          btn.textContent = folded ? '展开' : '收起';
          btn.setAttribute('aria-expanded', String(!folded));
        });
        const copy = head.querySelector('.copy-btn');
        if (copy) head.insertBefore(btn, copy);
        else head.appendChild(btn);
      }
    }

    // 点行号复制那一行：gutter 是纯文本 "1\n2\n..."，用点击处相对顶部的
    // 行高比例定位是第几行，再从 code 的 innerText 取对应行。gutter 本身
    // user-select:none，选中复制本来就不带行号 —— 这里补的是「点一下」的便利。
    const gutter = pre.querySelector('.gutter');
    if (gutter && !gutter._lineBound) {
      gutter._lineBound = true;
      gutter.title = '点行号复制该行';
      gutter.addEventListener('click', (e) => {
        const lines = code.innerText.split('\n');
        if (!lines.length) return;
        // 用 Range 精确定位被点的字符，取其文本里第几个 \n
        let idx = 0;
        const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
        if (r && gutter.contains(r.startContainer)) {
          const before = gutter.textContent.slice(0, r.startOffset);
          idx = (before.match(/\n/g) || []).length;
        } else {
          // 兜底：按点击 Y 在 gutter 内的比例估算
          const box = gutter.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(gutter).lineHeight) || 20;
          idx = Math.max(0, Math.min(lines.length - 1, Math.floor((e.clientY - box.top) / lh)));
        }
        const text = lines[idx];
        if (text == null) return;
        navigator.clipboard.writeText(text).then(
          () => toast(`已复制第 ${idx + 1} 行`),
          () => toast('复制失败')
        );
      });
    }
  });
}

/* iframe 懒加载兜底：消毒白名单目前不放行 iframe（clean.js 直接剥），
   站内正文还没有真实嵌入。这里只给将来兜底——哪天放行 B 站/YouTube 视频，
   hydrate 时补 loading=lazy，滚动到附近才拉起播放器，首屏不白拉一份流量。
   只补缺省值，不动已有的 loading 属性；CSS 已限宽的嵌入也不会被这行影响布局。 */
export function lazyIframes(root = document) {
  root.querySelectorAll?.('iframe:not([loading])').forEach((f) => {
    f.setAttribute('loading', 'lazy');
  });
}

/* 代码块横向滚动标记。
   渐隐阴影不能常驻：短代码块根本没有可滚动的量，常驻阴影会让它看起来"右边还有内容"。
   所以按 scrollWidth 判一次，滚到右端再把阴影撤掉。scroll 事件不冒泡，只能捕获。 */
export function bindCodeScroll(root = document) {
  const marks = () => {
    for (const wrap of root.querySelectorAll('.code-wrap')) {
      const pre = wrap.querySelector('pre.code-block');
      if (!pre) continue;
      wrap.classList.toggle('overflowing', pre.scrollWidth - pre.clientWidth > 4);
    }
  };
  root.addEventListener(
    'scroll',
    (e) => {
      const pre = e.target;
      if (!pre || pre.tagName !== 'PRE') return;
      const wrap = pre.closest('.code-wrap');
      if (wrap) wrap.classList.toggle('at-end', pre.scrollLeft + pre.clientWidth >= pre.scrollWidth - 4);
    },
    true
  );
  let t = 0;
  addEventListener(
    'resize',
    () => {
      clearTimeout(t);
      t = setTimeout(marks, 180);
    },
    { passive: true }
  );
  marks();
  return marks;
}

/* 阅读进度偏好：位置 top/bottom + 开关。存本机，服务端配置不掺和。
   读取时做白名单，localStorage 被塞了脏值也不会给 body 挂上是非 class。 */
const READ_KEY = 'x_readbar';
export function readBarPref() {
  let v = '';
  try { v = localStorage.getItem(READ_KEY); } catch {}
  return v === 'bottom' || v === 'off' ? v : 'top';
}
export function setReadBarPref(v) {
  const next = v === 'bottom' || v === 'off' ? v : 'top';
  try { localStorage.setItem(READ_KEY, next); } catch {}
  document.documentElement.dataset.readbar = next;
  applyReadBarPos();
  return next;
}
/* 把偏好落成 DOM 状态：bar 挪到底部用 class（CSS 只改 top/bottom），
   关掉时直接隐藏整条，百分比角标也一起收 —— 不该关了条线还留个数字。 */
export function applyReadBarPos() {
  const pref = readBarPref();
  document.documentElement.dataset.readbar = pref;
  const bar = document.querySelector('.read-bar');
  const pct = document.querySelector('.read-pct');
  if (bar) bar.classList.toggle('bottom', pref === 'bottom');
  if (bar) bar.classList.toggle('off', pref === 'off');
  if (pct) pct.classList.toggle('off', pref === 'off');
  return pref;
}

/* 阅读进度：顶部一条细线 + 右侧一颗百分比。两者共用同一份几何计算，
   同一次 rAF 里更新 —— 分别挂 scroll 监听会让一条 3000px 的长文每帧算两遍 rect。 */
export function bindReadingProgress(root = document.querySelector('.post-body')) {
  if (!root) return;
  let bar = document.querySelector('.read-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'read-bar';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
  }
  /* 百分比数字给的是「精确一点的进度感」，纯装饰：不参与 Tab 序、不念给屏幕阅读器，
     窄屏直接不显示（正文本来就一屏宽，浮个角标只会挡字）。 */
  let pct = document.querySelector('.read-pct');
  if (!pct) {
    pct = document.createElement('div');
    pct.className = 'read-pct';
    pct.setAttribute('aria-hidden', 'true');
    pct.innerHTML = '<b>0</b><i>%</i>';
    document.body.appendChild(pct);
  }
  const num = pct.querySelector('b');
  applyReadBarPos();
  let raf = 0;
  const sync = () => {
    raf = 0;
    // 关掉时几何计算省掉 —— 元素已经 display:none，算了也看不见
    if (readBarPref() === 'off') return;
    const r = root.getBoundingClientRect();
    // 正文高度减去一屏，才是真正需要滚动的距离；不足一屏就不显示这条线
    const span = r.height - window.innerHeight;
    if (span <= 20) {
      bar.style.opacity = '0';
      bar.style.transform = 'scaleX(0)';
      pct.classList.remove('on');
      return;
    }
    const done = Math.min(1, Math.max(0, -r.top / span));
    bar.style.opacity = '1';
    bar.style.transform = `scaleX(${done.toFixed(4)})`;
    const n = Math.round(done * 100);
    if (num.textContent !== String(n)) num.textContent = String(n);
    // 两头都不显示：开头蹦个「1%」比没有更吵；读完了还挂个「100%」也是噪音，
    // 那条顶部进度条留在满格就够了
    pct.classList.toggle('on', done > 0.02 && done < 0.995);
  };
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(sync);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  sync();
}

/* 回到顶部：悬浮圆按钮，七套主题共用 */(function mountBackTop() {
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
