// 后台导航与外壳：服务端页面（统计 / 健康检查 / 定时队列）共用同一套侧栏。
// editor.html 是静态资源，菜单内联在同一份里；test-admin-nav.mjs 会比对两边，
// 防止改了一处忘了另一处。
import { avatarSrc } from '../public/avatar.js';
import { THEME_BOOT, themeBootTag } from './themeboot.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);

/* ---------- 后台原子：时间 / 徽章 / 新鲜度 / 空态 ----------
   这四样此前在页面里各写一份：语义色是散落的 if、时间是绝对时刻、
   空态是同一句 sv-empty 抄五遍。抽到这里，页面只传数据。
   不新增一行 CSS —— 全部复用 style.css 已有的 .sv-pill(.ok/.warn/.bad)
   / .sv-time / .sv-empty（gzip -9 余量 199 B，只够给侧栏徽章加一条定位规则）。 */

/** 绝对时刻（北京）。D1 存的是 UTC 的 `YYYY-MM-DD HH:MM:SS`，不补 Z 会差 8 小时。 */
export function toCN(s) {
  if (!s) return '—';
  const t = String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z');
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return esc(s);
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' 北京';
}

/** 语义徽章。kind 只有四档，正好对上 sv-pill 的三个变体 + 默认中性。 */
export function pill(kind, text, title = '') {
  const k = kind === 'ok' || kind === 'warn' || kind === 'bad' ? kind : 'muted';
  const cls = k === 'muted' ? 'sv-pill' : `sv-pill ${k}`;
  return `<span class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

/** 新鲜度：定时任务的结果必须显「多久以前」。
    只把绝对时刻换成相对时刻是不够的——巡检停跑时页面上那行字照样静态好看。
    超过 staleMs 换成琥珀徽章并明说「已过期」，让「停跑」在界面上有颜色。
    at 为空 = 这次任务从没跑过，也单独成一档，别和「刚刚」混在一起。 */
export function fresh(at, { staleMs = 6 * 3600e3, noun = '' } = {}) {
  const raw = String(at ?? '').trim();
  if (!raw) return `<span class="sv-time">${esc(noun)}未运行</span>`;
  const t = Date.parse(raw.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? '' : 'Z'));
  if (!Number.isNaN(t) && Number.isFinite(t)) {
    const age = Date.now() - t;
    const full = toCN(raw);
    /* 负 age = 库里记的时刻在未来。真实巡检不会超前，所以这必是口径错了
       （写入端拿本地时间当 UTC 存、或时钟漂移）。此时不能说「刚刚」——
       那会把一个错数据渲染成最健康的状态，比报错更难查。 */
    if (age < -60e3) return pill('warn', '时间异常', `${noun}${full} 晚于当前时刻，检查写入端的时区口径`);
    const mins = Math.round(age / 60e3);
    const text = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
    if (age > staleMs) return pill('warn', `${text} · 已过期`, `${noun}${full}`);
    return `<span class="sv-time" title="${esc(noun + full)}">${esc(text)}</span>`;
  }
  return `<span class="sv-time">${esc(toCN(raw))}</span>`;
}

/** 空态：不把「没有数据」渲染成一片空白。 */
export const emptyState = (text) => `<p class="sv-empty">${esc(text)}</p>`;

/** 待办条：概览页最顶那一行，全是可判定数字，相加就是「今天要做的 N 件」。
    数字全部来自已有查询，组件本身不取数、不写入——它只是把欠账摆到看得见的地方。
    items: [{ label, v, href }]，v 为 0 的行照样显示（0 也是事实，藏起来就成了「没这项」）。 */
export function todoBar(items = []) {
  /* 负值钳到 0：查询出错时 COUNT 可能回 -1，不钳的话 5 条待办 + 一个 -99
     会把总数拉成「今天没有待办」——待办被一个错误数字整体吞掉，
     而界面上看起来比平时还干净。 */
  const val = (v) => Math.max(0, Number(v) || 0);
  const total = items.reduce((s, t) => s + val(t.v), 0);
  return `<div class="sv-summary ${total > 0 ? 'warn' : 'ok'}">
      <span class="sv-summary-dot"></span>
      <div class="sv-summary-main">
        <strong>${total > 0 ? `今天要做的 ${total} 件` : '今天没有待办'}</strong>
        <span>${items
          .map((t) => `${esc(t.label)} <a href="${esc(t.href)}">${val(t.v)}</a>`)
          .join(' · ')}</span>
      </div>
    </div>`;
}

/* 主题防闪引导统一在 src/themeboot.js，这里只做转出。
   以前这段是本文件手抄的一份副本：不带 __ASSET_H__，于是后台切主题发出的
   主题 CSS 既没有 integrity 也没有 ?v=。副本现在只剩一处，改那儿全站生效。 */
export const THEME_BOOT_JS = THEME_BOOT;

/** 服务端页 head 注入：站点默认主题 + 防闪引导，顺序与 editor.html 一致。 */
export function themeBoot(site = {}) {
  return themeBootTag({ theme: site.theme || 'paper', mode: site.mode || 'auto' });
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
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
};

const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/* 四栏：按「打开后台时要做什么」分，不按「系统有哪些功能」分。
   概览=3 秒判断今天动不动手；内容=日常 90% 的操作；系统=配好就不常动；
   工具=低频且误触代价高。以前一列平铺 13 项，找「评论审核」要和「操作日志」
   一起扫一遍——分组不是装饰，是把判断前置。
   「返回站点」不占一栏：rail 顶部的品牌块本来就指向首页。 */
export const ADMIN_GROUPS = [
  { key: 'dash', text: '概览' },
  { key: 'content', text: '内容' },
  { key: 'system', text: '系统' },
  { key: 'tools', text: '工具' },
];

/* 菜单唯一事实来源。group 必须是 ADMIN_GROUPS 里的 key，
   key 用于测试比对，href 是真实落点。加一栏要同时过四组上限的断言。 */
export const ADMIN_NAV = [
  { key: 'dash', group: 'dash', text: '工作台', href: '/admin', icon: 'grid', id: 'nav-dash' },
  { key: 'write', group: 'content', text: '写作', href: '/editor', icon: 'write', id: 'nav-write' },
  { key: 'posts', group: 'content', text: '文章列表', href: '/editor?panel=posts', icon: 'list', id: 'nav-posts' },
  { key: 'checks', group: 'content', text: '发布自检', href: '/editor?panel=checks', icon: 'check', id: 'nav-checks' },
  { key: 'review', group: 'content', text: '投稿审核', href: '/admin/review', icon: 'check', id: 'nav-review' },
  { key: 'cmts', group: 'content', text: '评论审核', href: '/admin/comments', icon: 'check', id: 'nav-cmts', badge: 'pendingComments' },
  { key: 'series', group: 'content', text: '系列', href: '/editor?panel=series', icon: 'layers', id: 'nav-series' },
  { key: 'media', group: 'content', text: '媒体', href: '/admin/media', icon: 'image', id: 'nav-media' },
  { key: 'friends', group: 'content', text: '友链管理', href: '/admin/friends', icon: 'grid', id: 'nav-friends' },
  { key: 'notify', group: 'system', text: '通知投递', href: '/admin/notify', icon: 'bell', id: 'nav-notify', badge: 'notifyFail7d' },
  { key: 'stats', group: 'system', text: '访问统计', href: '/admin/stats', icon: 'chart', id: 'nav-stats' },
  { key: 'health', group: 'system', text: '健康检查', href: '/admin/health', icon: 'shield', id: 'nav-health' },
  { key: 'queue', group: 'system', text: '定时队列', href: '/admin/queue', icon: 'clock', id: 'nav-queue' },
  { key: 'audit', group: 'system', text: '操作日志', href: '/admin/audit', icon: 'list', id: 'nav-audit' },
  { key: 'site', group: 'system', text: '站点设置', href: '/editor?panel=site', icon: 'gear', id: 'nav-site' },
  { key: 'tools', group: 'tools', text: '工具与备份', href: '/admin/tools', icon: 'shield', id: 'nav-tools', hint: '低频、误触代价高；页面只读，动作在命令行' },
];

/* 徽章口径写在配置里，不散到各页面。侧栏与概览待办条读同一个 navCounts()，
   数字物理同源 —— 「侧栏说 3、概览说 5」这种事在结构上就不可能发生。
   window 非 null 的名字必须自带窗口后缀（notifyFail7d 而非 notifyFail）：
   不设窗口的计数会变成永久欠账，几天后整条待办失去可信度。A-21 守着这条。 */
/* 侧栏徽章的计数口径。与 dashboard.js 的 TODOS 受同一条规则约束（N-11）：
   `window` 非 null 时名字必须带该窗口后缀；`window` 为 null 时必须用 `total`
   说明这是哪种全量 —— 不写就等于「没人知道这个数字为什么永远不降」。
   两个字段都不是注释，是断言要读的输入：删掉一个，N-11 直接红。 */
export const BADGE_SOURCE = {
  pendingComments: { tone: 'warn', window: null, total: '待审队列全量：不处理就一直挂着', label: '待审评论' },
  notifyFail7d: { tone: 'bad', window: '7d', label: '近 7 天通知失败' },
};

/* tone 只认白名单，未知值退化成中性徽章。把配置里的值直接拼进 class 字符串，
   等于让一份配置变成 HTML 注入面 —— 和 pill() 同一条纪律。 */
const TONE_CLASS = { warn: 'sv-pill warn', bad: 'sv-pill bad', ok: 'sv-pill ok' };

/** 侧栏徽章。0 / 负数 / 非数字一律不渲染：一排 0 会把「有没有事」重新变成阅读任务。 */
function badge(counts, name) {
  const src = BADGE_SOURCE[name];
  if (!src) return '';
  const n = Number(counts?.[name] ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const cls = TONE_CLASS[src.tone] || 'sv-pill';
  return `<span class="${cls}" title="${esc(src.label)} ${n} 条">${Math.floor(n)}</span>`;
}

/* 待办条与侧栏徽章的唯一计数入口。两条 COUNT 各走各的索引，不扫全表。
   调用方先拿 promise、最后再 await，省掉一个额外 RTT。
   查询炸了返回 0（不是抛）：侧栏少一个数字比整页 500 好，但留一条日志。 */
export async function navCounts(db) {
  if (!db) return { pendingComments: 0, notifyFail7d: 0 };
  const q = (sql) =>
    db
      .prepare(sql)
      .first()
      .then((r) => Number(r?.c) || 0)
      .catch((e) => {
        console.error('navCounts', e?.message || e);
        return 0;
      });
  const [pendingComments, notifyFail7d] = await Promise.all([
    q(`SELECT COUNT(*) c FROM comments WHERE status = 'pending'`),
    q(
      `SELECT COUNT(*) c FROM comments
       WHERE notify_status = 'fail' AND notified_at >= datetime('now','-7 days')`
    ),
  ]);
  return { pendingComments, notifyFail7d };
}

/* 分组标题复用 .admin-nav-label：CSS 预算只剩 199B，不为分组新增规则。
   一个 <nav> 里放四段 label + 链接，语义上仍是一张菜单（一组 aria-label），
   不拆成四个 nav —— 屏幕阅读器会把四个 nav 念成四块导航区。 */
export function renderAdminNav(active = '', counts = null) {
  const one = (it) => {
    const on = it.key === active;
    return `<a${on ? ' class="on" aria-current="page"' : ''} href="${esc(it.href)}" id="${it.id}"${
      it.hint ? ` title="${esc(it.hint)}"` : ''
    }>${svg(it.icon)}<span>${esc(it.text)}</span>${it.badge ? badge(counts, it.badge) : ''}</a>`;
  };
  return `<nav class="admin-nav" aria-label="后台管理">${ADMIN_GROUPS.map(
    (g) =>
      `<div class="admin-nav-label">${esc(g.text)}</div>` +
      ADMIN_NAV.filter((it) => it.group === g.key).map(one).join('')
  ).join('')}</nav>`;
}

/** 服务端页面统一外壳。body 是 <main> 里的内容，不在这里转义。
    头部只留 h1 + 一句说明，和写作页同一套（不再压一个「后台管理」小标签，
    那和侧栏的分组标题重复）。 */
/* nav 是 navCounts() 的结果，只在有数字时渲染徽章；缺省不渲染，
   不报错 —— 测试和局部渲染都不带 counts。 */
export function renderAdminShell({ site = {}, active = '', title, desc = '', body = '', bodyClass = '', nav = null }) {
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
      ${renderAdminNav(active, nav)}
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
