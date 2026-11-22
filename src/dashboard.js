// 后台工作台 /admin：一屏看清站点近况 + 直达各管理入口。
// 数据全部来自真实查询，查不到就显示「—」，不摆编造的空壳数字。
// 样式复用 .stat-page 命名空间（renderAdminShell 提供外壳），不内联 <style>。
import { html } from './utils.js';
import { requireAdmin } from './auth.js';
import { getSite } from './settings.js';
import { renderAdminShell, esc, ADMIN_NAV } from './admin-ui.js';
import { dayCN } from './stats.js';

// 快捷入口说明：从 ADMIN_NAV 派生链接，这里只补一句用途，避免两处各写一份 href。
const DESC = {
  write: '新建一篇草稿',
  posts: '编辑、整理已有文章',
  checks: '扫描图片、链接与替代文本',
  series: '管理文章系列',
  site: '站名、头像与主题',
  stats: '访问、来源与设备',
  health: 'D1、密钥与友链状态',
  queue: '等待发布时间到达的稿件',
};

/** 纯渲染：只吃数据，不碰数据库。单测喂假数据即可验证转义与结构。 */
export function renderDashboard({ site = {}, user = {}, kpi = {}, recent = [], sys = {} }) {
  const n = (v) => (v === undefined || v === null ? '—' : String(v));
  const cards = [
    { label: '已发布文章', value: kpi.posts, sub: '公开且已到点' },
    { label: '待发布', value: kpi.queue, sub: '定时队列里' },
    { label: '今日浏览', value: kpi.pv, sub: `独立访客 ${n(kpi.uv)}` },
    { label: '友链在线', value: kpi.friendsUp, sub: kpi.friendsTotal != null ? `共 ${kpi.friendsTotal} 条` : '' },
  ];

  const links = ADMIN_NAV.filter((it) => it.key !== 'dash' && it.key !== 'home')
    .map(
      (it) => `<a class="dash-tile" href="${esc(it.href)}" id="dash-${it.key}">
        <span class="dash-tile-t">${esc(it.text)}</span>
        <span class="dash-tile-d">${esc(DESC[it.key] || '')}</span>
        <span class="dash-tile-arrow" aria-hidden="true">→</span>
      </a>`
    )
    .join('');

  const posts = recent.length
    ? `<div class="kv-list">${recent
        .map(
          (p) => `<div class="kv-row">
            <div class="kv-k">
              <a class="dash-post-t" href="/editor?id=${encodeURIComponent(p.id)}">${esc(p.title || '（无标题）')}</a>
              <span class="kv-note">${esc(p.when || '')}</span>
            </div>
            <span class="kv-v">${p.is_private ? '私密' : p.hidden ? '不列出' : '公开'}</span>
          </div>`
        )
        .join('')}</div>`
    : '<p class="sv-empty">还没有文章。点上面的「写作」新建第一篇。</p>';

  const issues = [];
  if (sys.d1 === 'bad') issues.push('D1 不可用');
  if (sys.friendDown > 0) issues.push(`${sys.friendDown} 条友链探测失败`);
  const state = sys.d1 === 'bad' ? 'bad' : issues.length ? 'warn' : 'ok';
  const summaryText = state === 'bad' ? '有故障需要处理' : state === 'warn' ? '有项目需关注' : '全部正常';
  const summarySub = state === 'ok' ? 'D1、会话与友链探测均正常' : issues.join(' · ');

  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>站点概览</span>
    <span class="view-tag">${esc(sys.today || dayCN())}</span>
  </div>
  <div class="admin-view-body">
    <div class="dash-kpis">${cards
      .map(
        (c) => `<div class="dash-kpi">
          <span class="dash-kpi-l">${esc(c.label)}</span>
          <strong class="dash-kpi-v">${n(c.value)}</strong>
          <span class="dash-kpi-s">${esc(c.sub)}</span>
        </div>`
      )
      .join('')}</div>
  </div>
</div>

<div class="admin-view-card">
  <div class="admin-view-head"><span>快捷入口</span><span class="view-tag">管理员 ${esc(user.login || '')}</span></div>
  <div class="admin-view-body"><div class="dash-links">${links}</div></div>
</div>

<div class="admin-view-card">
  <div class="admin-view-head"><span>最近编辑</span><a class="dash-more" href="/editor?panel=posts">全部文章 →</a></div>
  <div class="admin-view-body">${posts}</div>
</div>

<div class="admin-view-card">
  <div class="admin-view-head"><span>运行状态</span></div>
  <div class="admin-view-body">
    <div class="sv-summary ${state}">
      <span class="sv-summary-dot"></span>
      <div class="sv-summary-main"><strong>${summaryText}</strong><span>${esc(summarySub)}</span></div>
    </div>
    <p class="sv-note">健康页有逐项明细；这里只给一句话结论。圆点颜色随主题变量，亮暗自适应。</p>
  </div>
</div>
</div>`;

  return renderAdminShell({
    site,
    active: 'dash',
    title: '工作台',
    desc: '站点近况与常用入口，一眼看完',
    body,
  });
}

export async function dashboardPage(env, request) {
  const { user, res } = await requireAdmin(env, request);
  if (res) return res;

  const db = env.DB;
  const one = (sql, ...args) => db.prepare(sql).bind(...args).first();
  // 单块查询失败不该拖垮整页：给个安全默认值，让其余卡片照常显示。
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      console.error('dashboard', e?.message || e);
      return fallback;
    }
  };

  const today = dayCN();
  const [postStat, queueStat, pv, friendStat, recentRows, d1Ok] = await Promise.all([
    safe(
      () =>
        one(
          `SELECT SUM(CASE WHEN is_private=0 AND hidden=0 AND published_at!='' AND published_at<=datetime('now') THEN 1 ELSE 0 END) published,
                  COUNT(*) total
           FROM posts`
        ),
      {}
    ),
    safe(
      () => one(`SELECT COUNT(*) c FROM posts WHERE published_at!='' AND published_at>datetime('now')`),
      {}
    ),
    safe(() => one('SELECT COUNT(*) pv, COUNT(DISTINCT ip) uv FROM pv WHERE day = ?', today), {}),
    safe(
      () =>
        one(
          `SELECT SUM(CASE WHEN status=1 THEN 1 ELSE 0 END) up,
                  SUM(CASE WHEN status!=1 THEN 1 ELSE 0 END) down,
                  COUNT(*) total
           FROM friends`
        ),
      {}
    ),
    safe(
      () =>
        db
          .prepare(
            `SELECT id, title, published_at, updated_at, is_private, hidden
             FROM posts ORDER BY updated_at DESC LIMIT 6`
          )
          .all()
          .then((r) => r.results || []),
      []
    ),
    safe(() => db.prepare('SELECT 1').first().then(() => true), false),
  ]);

  const recent = recentRows.map((p) => ({
    ...p,
    when: p.updated_at || p.published_at || '',
  }));

  const site = await getSite(env);
  return html(
    renderDashboard({
      site,
      user,
      kpi: {
        posts: postStat?.published,
        queue: queueStat?.c,
        pv: pv?.pv,
        uv: pv?.uv,
        friendsUp: friendStat?.up,
        friendsTotal: friendStat?.total,
      },
      recent,
      sys: { d1: d1Ok ? 'ok' : 'bad', friendDown: friendStat?.down || 0, today },
    }),
    200,
    { 'cache-control': 'no-store' }
  );
}
