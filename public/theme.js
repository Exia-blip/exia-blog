// 风格（主题）系统：8 套预设 × 浅/深/跟随系统
// 偏好在 localStorage，站点默认值由服务端注入 window.__THEME_DEFAULT__

export const THEMES = [
  { id: 'paper', name: '蓝白', desc: '蓝白 · 卡片蓝紫', sw: ['#f7f9fe', '#eef2fb', '#3b5bdb'] },
  { id: 'ink', name: '水墨', desc: '纸白 · 墨线衬线', sw: ['#fdfcfa', '#e3ded4', '#1c1917'] },
  { id: 'forest', name: '苔原', desc: '米绿 · 林深处', sw: ['#f6f8f2', '#dee6d3', '#2f7a4a'] },
  { id: 'ocean', name: '静海', desc: '冷白 · 靛蓝', sw: ['#f4f7fb', '#dce5f0', '#2a5aa8'] },
  { id: 'plum', name: '暮紫', desc: '淡紫 · 梅色', sw: ['#faf7fc', '#e9e0ef', '#7d3f91'] },
  { id: 'mono', name: '终端', desc: '灰阶 · 等宽字', sw: ['#f4f4f5', '#d9d9de', '#0a7d4b'] },
  { id: 'edge', name: '基建', desc: '纯白 · 锚橙发丝线', sw: ['#ffffff', '#e2e6ec', '#f6821f'] },
  { id: 'editorial', name: '编辑部', desc: '深蓝灰 · 暖金衬线', sw: ['#111820', '#202B35', '#C6A77A'] },
];

export const MODES = [
  { id: 'auto', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
];

const K_THEME = 'x_theme';
const K_MODE = 'x_mode';

const ROOT = document.documentElement;

/* 切换瞬间的颜色过渡：给 html 临时挂 theme-transition，CSS 只过渡 color/bg ——
   不碰 width/height/margin 这类布局属性，杜绝 CLS。常态无 transition，
   首屏、滚动、hover 都不会带动画。reduced-motion 是第一道硬开关，直接跳过。 */
let animTimer = 0;
let animOff = null;
function flashTransition() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // 连续切换：先把上一次的监听和定时器撤掉，避免旧回调提前摘掉这次的 class
  if (animOff) { ROOT.removeEventListener('transitionend', animOff); animOff = null; }
  clearTimeout(animTimer);
  ROOT.classList.add('theme-transition');
  const done = () => {
    ROOT.classList.remove('theme-transition');
    if (animOff) { ROOT.removeEventListener('transitionend', animOff); animOff = null; }
    clearTimeout(animTimer);
  };
  // 子元素的过渡会冒泡到 ROOT，只认 ROOT 自身触发的那一次；
  // 只认颜色属性，border/transform 之类不算「这次颜色切换结束」。
  animOff = (e) => {
    if (e.target === ROOT && (e.propertyName === 'color' || e.propertyName === 'background-color')) done();
  };
  ROOT.addEventListener('transitionend', animOff);
  /* transitionend 不保证触发：主题 CSS 还在异步加载、或前后颜色值相同（比如只换
     风格不换明暗）时就没有过渡事件。留一个定时兜底，比 .28s 略长，确保 class 一定被摘掉。 */
  animTimer = setTimeout(done, 400);
}
const DEFAULT = () => (window.__THEME_DEFAULT__ && window.__THEME_DEFAULT__.theme) || 'paper';
const DEFAULT_MODE = () => (window.__THEME_DEFAULT__ && window.__THEME_DEFAULT__.mode) || 'auto';

export function isValidTheme(id) {
  return THEMES.some((t) => t.id === id);
}

export function isValidMode(id) {
  return MODES.some((m) => m.id === id);
}

/* ?theme=<id> 临时预览：优先级最高，且完全不落盘 —— 刷新还在，是因为参数还在
   URL 上，不是因为我们记住了它。白名单必须与 src/themeboot.js 里那段一致
   （纯字母数字 2–16 位）：这个值会被拼进 /theme/<id>.css 的 href。 */
function previewId() {
  try {
    const t = new URLSearchParams(location.search).get('theme') || '';
    return /^[a-z0-9]{2,16}$/.test(t) ? t : '';
  } catch {
    return '';
  }
}

/** 当前偏好（预览 > 存过 > 站点默认） */
export function pref() {
  let theme = null;
  let mode = null;
  try {
    theme = localStorage.getItem(K_THEME);
    mode = localStorage.getItem(K_MODE);
  } catch {}
  const pv = previewId();
  return {
    theme: isValidTheme(pv) ? pv : isValidTheme(theme) ? theme : ROOT.dataset.theme || DEFAULT(),
    mode: isValidMode(mode) ? mode : ROOT.dataset.mpref || DEFAULT_MODE(),
  };
}

function systemDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/* 主题要不要额外请求，看资源清单，不看主题名：清单里没有 /theme/<id>.css，
   就说明这套变量编在主样式表里（纸韵、安知鱼）。以前这里与 apply() 各写了一份
   主题名判断，加主题必漏一处。 */
function themeAsset(theme) {
  return (window.__ASSET_H__ || {})[`/theme/${theme}.css`] || null;
}

/* 主题样式表现在是按需加载的：style.css 里只有纸韵的 :root，
   其余每套一个 /theme/<id>.css。切到没加载过的主题时先把文件拿到手再改 data-theme，
   反过来的话会有一两帧「变量还是上一套」的错配，比闪一下白更难看。 */
function ensureThemeCss(theme) {
  if (!themeAsset(theme)) return Promise.resolve();
  const id = `tcss-${theme}`;
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.id = id;
    l.rel = 'stylesheet';
    /* integrity 必须在 href 之前设：href 一旦赋值浏览器就开始取资源，
       之后再写 integrity 不会重来一次校验。哈希表由 head 里的内联脚本下发
       （window.__ASSET_H__），没拿到就退化成不带校验的普通请求。 */
    const a = themeAsset(theme) || {};
    if (a.i) l.integrity = a.i;
    l.href = `/theme/${theme}.css${a.v ? `?v=${a.v}` : ''}`;
    // 加载失败也放行：样式缺一份总比点不动强
    l.onload = resolve;
    l.onerror = resolve;
    document.head.appendChild(l);
  });
}

/* SSR 首屏给了两条 theme-color（浅 + 系统暗色兜底）。JS 一旦跑起来，实际模式
   以用户选择为准，不再让浏览器的 prefers-color-scheme 抢着决定顶栏色：
   删掉 media 那条，只留一条并写成当前 --bg。否则用户手动选浅色、系统却是暗色时，
   media 那条会赢，页面亮着而地址栏是黑的 —— 比首屏闪一下更持久的「一眼假」。 */
function syncThemeColor() {
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const meta of metas) {
    if (meta.hasAttribute('media')) {
      meta.remove();
      continue;
    }
    const bg = getComputedStyle(ROOT).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
}

/** 应用主题；persist=false 时只改不存（用于"跟随系统"下响应系统变化） */
export function apply(theme, mode, persist = true) {
  if (!isValidTheme(theme)) theme = 'paper';
  if (!isValidMode(mode)) mode = 'auto';

  const run = () => {
    const dark = mode === 'dark' || (mode === 'auto' && systemDark());
    flashTransition();
    ROOT.setAttribute('data-theme', theme);
    ROOT.setAttribute('data-mode', dark ? 'dark' : 'light');
    ROOT.setAttribute('data-mpref', mode);

    if (persist) {
      try {
        localStorage.setItem(K_THEME, theme);
        localStorage.setItem(K_MODE, mode);
      } catch {}
      dropPreview();
    }
    syncThemeColor();
    syncUI();
    return { theme, mode, dark };
  };

  if (document.getElementById(`tcss-${theme}`) || !themeAsset(theme)) return run();
  ensureThemeCss(theme).then(run);
  // 样式到位前先不动 DOM，返回值只是给调用方一个乐观值
  return { theme, mode, dark: mode === 'dark' || (mode === 'auto' && systemDark()) };
}

/* 手动选过就不再是「预览」了：把 ?theme= 摘掉。
   预览本身不落盘，参数留着的话下次刷新又会跳回预览那套，
   读者会以为自己的选择没生效。 */
function dropPreview() {
  if (!previewId()) return;
  try {
    const u = new URL(location.href);
    u.searchParams.delete('theme');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  } catch {}
}

function syncUI() {
  const { theme, mode } = pref();
  document.querySelectorAll('[data-theme-pick]').forEach((el) => {
    el.classList.toggle('on', el.dataset.themePick === theme);
    el.setAttribute('aria-pressed', String(el.dataset.themePick === theme));
  });
  document.querySelectorAll('[data-mode-pick]').forEach((el) => {
    el.classList.toggle('on', el.dataset.modePick === mode);
    el.setAttribute('aria-pressed', String(el.dataset.modePick === mode));
  });
}

/* 系统配色变化时，只在"跟随系统"下响应 */
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    const p = pref();
    if (p.mode === 'auto') apply(p.theme, 'auto', false);
  };
  mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
}

/** 面板 HTML（挂到 body） */
function panelHTML() {
  const { theme, mode } = pref();
  return `
  <div class="theme-pop" id="theme-pop" role="dialog" aria-label="选择风格">
    <div class="tp-head"><b>风格</b><span>挑一个顺眼的</span><button class="tp-close" data-tp-close aria-label="关闭">✕</button></div>
    <div class="tp-grid">
      ${THEMES.map(
        (t) => `
        <button class="tp-item ${t.id === theme ? 'on' : ''}" data-theme-pick="${t.id}" aria-pressed="${t.id === theme}">
          <span class="tp-sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
          <span class="tp-name">${t.name}</span>
          <span class="tp-desc">${t.desc}</span>
        </button>`
      ).join('')}
    </div>
    <div class="tp-modes">
      ${MODES.map(
        (m) => `<button data-mode-pick="${m.id}" class="${m.id === mode ? 'on' : ''}" aria-pressed="${m.id === mode}">${m.name}</button>`
      ).join('')}
    </div>
    <div class="tp-tip">选择保存在本机，随时可换</div>
  </div>`;
}

let pop = null;
let currentBtn = null;

function place(btn) {
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 274;
  const right = Math.max(12, Math.min(window.innerWidth - r.right, window.innerWidth - w - 12));
  pop.style.top = Math.round(r.bottom + 8) + 'px';
  pop.style.right = Math.round(right) + 'px';
  // 视口下方空间不足时上翻
  if (r.bottom + pop.offsetHeight + 16 > window.innerHeight) {
    pop.style.top = Math.max(12, Math.round(r.top - pop.offsetHeight - 8)) + 'px';
  }
}

function open(btn) {
  currentBtn = btn;
  if (!pop) {
    document.body.insertAdjacentHTML('beforeend', panelHTML());
    pop = document.getElementById('theme-pop');
    pop.addEventListener('click', (e) => {
      const t = e.target.closest('[data-theme-pick]');
      if (t) {
        const p = pref();
        apply(t.dataset.themePick, p.mode);
        return;
      }
      const m = e.target.closest('[data-mode-pick]');
      if (m) {
        const p = pref();
        apply(p.theme, m.dataset.modePick);
        return;
      }
      if (e.target.closest('[data-tp-close]')) close();
    });
  }
  syncUI();
  pop.classList.add('on');
  btn.setAttribute('aria-expanded', 'true');
  place(btn);
}

function close() {
  if (!pop) return;
  pop.classList.remove('on');
  document.querySelectorAll('[data-theme-btn]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  currentBtn = null;
}

function toggle(btn) {
  if (pop && pop.classList.contains('on') && currentBtn === btn) close();
  else open(btn);
}

let bound = false;
/** 绑定页面上所有 [data-theme-btn]（可多次调用，只绑一次全局监听） */
export function initSwitcher() {
  document.querySelectorAll('[data-theme-btn]').forEach((btn) => {
    if (btn._themeBound) return;
    btn._themeBound = true;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      toggle(btn);
    });
  });
  if (bound) return;
  bound = true;

  document.addEventListener('click', (e) => {
    if (!pop || !pop.classList.contains('on')) return;
    if (pop.contains(e.target) || e.target.closest('[data-theme-btn]')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('resize', () => currentBtn && place(currentBtn));
  window.addEventListener('scroll', () => currentBtn && place(currentBtn), { passive: true });
}

/** 按钮本身（放在 header / 编辑器工具栏里） */
export const buttonHTML = `<button class="theme-btn" data-theme-btn type="button" aria-label="切换风格" aria-expanded="false" title="切换风格">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3a9 9 0 1 0 0 18 2.2 2.2 0 0 0 1.7-3.6 2.2 2.2 0 0 1 1.7-3.6H18A3 3 0 0 0 21 10.8 9 9 0 0 0 12 3Z"/>
    <circle cx="8" cy="9.2" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="12.4" cy="7" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="16.4" cy="9.4" r="1.1" fill="currentColor" stroke="none"/>
  </svg>
</button>`;

/** 名字映射（后台下拉、提示文案用） */
export const themeName = (id) => (THEMES.find((t) => t.id === id) || THEMES[0]).name;
