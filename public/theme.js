// 风格（主题）系统：6 套预设 × 浅/深/跟随系统
// 偏好在 localStorage，站点默认值由服务端注入 window.__THEME_DEFAULT__

export const THEMES = [
  { id: 'paper', name: '纸韵', desc: '暖白 · 陶土橙', sw: ['#faf9f7', '#f3f1ec', '#a8501f'] },
  { id: 'ink', name: '水墨', desc: '纸白 · 墨线衬线', sw: ['#fdfcfa', '#e3ded4', '#1c1917'] },
  { id: 'forest', name: '苔原', desc: '米绿 · 林深处', sw: ['#f6f8f2', '#dee6d3', '#2f7a4a'] },
  { id: 'ocean', name: '静海', desc: '冷白 · 靛蓝', sw: ['#f4f7fb', '#dce5f0', '#2a5aa8'] },
  { id: 'plum', name: '暮紫', desc: '淡紫 · 梅色', sw: ['#faf7fc', '#e9e0ef', '#7d3f91'] },
  { id: 'mono', name: '终端', desc: '灰阶 · 等宽字', sw: ['#f4f4f5', '#d9d9de', '#0a7d4b'] },
];

export const MODES = [
  { id: 'auto', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
];

const K_THEME = 'x_theme';
const K_MODE = 'x_mode';

const ROOT = document.documentElement;
const DEFAULT = () => (window.__THEME_DEFAULT__ && window.__THEME_DEFAULT__.theme) || 'paper';
const DEFAULT_MODE = () => (window.__THEME_DEFAULT__ && window.__THEME_DEFAULT__.mode) || 'auto';

export function isValidTheme(id) {
  return THEMES.some((t) => t.id === id);
}

export function isValidMode(id) {
  return MODES.some((m) => m.id === id);
}

/** 当前偏好（存过用存的，否则用站点默认） */
export function pref() {
  let theme = null;
  let mode = null;
  try {
    theme = localStorage.getItem(K_THEME);
    mode = localStorage.getItem(K_MODE);
  } catch {}
  return {
    theme: isValidTheme(theme) ? theme : ROOT.dataset.theme || DEFAULT(),
    mode: isValidMode(mode) ? mode : ROOT.dataset.mpref || DEFAULT_MODE(),
  };
}

function systemDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** 应用主题；persist=false 时只改不存（用于"跟随系统"下响应系统变化） */
export function apply(theme, mode, persist = true) {
  if (!isValidTheme(theme)) theme = 'paper';
  if (!isValidMode(mode)) mode = 'auto';

  const dark = mode === 'dark' || (mode === 'auto' && systemDark());
  ROOT.setAttribute('data-theme', theme);
  ROOT.setAttribute('data-mode', dark ? 'dark' : 'light');
  ROOT.setAttribute('data-mpref', mode);

  if (persist) {
    try {
      localStorage.setItem(K_THEME, theme);
      localStorage.setItem(K_MODE, mode);
    } catch {}
  }
  syncUI();
  return { theme, mode, dark };
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
