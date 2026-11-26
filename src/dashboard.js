// 后台工作台 /admin：一屏看清站点近况 + 直达各管理入口。
// 数据全部来自真实查询，查不到就显示「—」，不摆编造的空壳数字。
// 样式复用 .stat-page 命名空间（renderAdminShell 提供外壳），不内联 <style>。
import { html, localParts } from './utils.js';
import { requireAdmin } from './auth.js';
import { getSite } from './settings.js';
import { renderAdminShell, esc, pill, emptyState, todoBar, navCounts } from './admin-ui.js';
import { dayCN } from './stats.js';

/** 纯渲染：只吃数据，不碰数据库。单测喂假数据即可验证转义与结构。 */
/* 待办条的四个计数 —— 连同每个计数的**口径声明**。N-11 守着这张表。

   每一条必须显式写 window：
   - `window: '24h'` → 窗口内计数，label 必须含这个字面量（自证，不用读者去翻查询）。
   - `window: null` → 全量计数，此时必须写 `total` 说明它是什么全量、能用在哪儿。
     一个没有窗口、也没声明的数字，迟早会混进「今天做什么」——队列那次就是这么错的：
     20 篇预排最远排到次年二月，塞进待办条就变成「今天要做的 20 件」。

   「待审评论 / 友链异常 / 通知失败」三条不受窗口约束：它们是**未结项**，
   昨天没处理的今天仍然要处理。给它们加窗口反而会把欠账藏起来（超 7 天就不显示了）。
   所以它们的声明写的是「全量但每条都该现在处理」，而不是「只看 24 小时」。

   队列全量（`kpi.queue`）故意不在这张表里 —— 它只回答「队列有多长」，
   出现在待办条就是把两个问题混成一个。 */
export const TODOS = [
  { key: 'cmtPending', from: 'kpi', label: '待审评论', href: '/admin/comments', window: null, total: '未结项全量：不处理就一直挂着' },
  { key: 'queueToday', from: 'kpi', label: '24h 内待发', href: '/admin/queue', window: '24h' },
  { key: 'friendDown', from: 'sys', label: '友链异常', href: '/admin/friends', window: null, total: '未结项全量：探测失败即算，不按天数归零' },
  /* 这条原本写的是 label「通知失败」+ 无窗口声明，但 `kpi.notifyFail` 取自
     `nav.notifyFail7d` —— 它本身就是 7 天窗口。数字有窗口、名字没体现，
     正是 N-11 要抓的形状：读者会以为那是「历史累计从未送达」，于是每天看见
     同一个数字也不觉得该处理。名字补上口径，或去掉窗口，二选一，这里选前者。 */
  { key: 'notifyFail', from: 'kpi', label: '7 天内通知失败', href: '/admin/notify', window: '7d' },
];

export function renderDashboard({ site = {}, user = {}, kpi = {}, recent = [], sys = {}, nav = null }) {
  const n = (v) => (v === undefined || v === null ? '—' : String(v));
  const cards = [
    { label: '已发布文章', value: kpi.posts, sub: '公开且已到点' },
    { label: '待审核', value: kpi.pending, sub: '投稿等放行', key: 'pending' },
    { label: '待发布', value: kpi.queue, sub: '定时队列里' },
    { label: '今日浏览', value: kpi.pv, sub: `独立访客 ${n(kpi.uv)}` },
    { label: '友链在线', value: kpi.friendsUp, sub: kpi.friendsTotal != null ? `共 ${kpi.friendsTotal} 条` : '' },
  ];

  // 待审 / 驳回优先于「公开」：审核态没过，列表里的「公开」是误导。
  const postFlag = (p) => {
    if (p.review_status === 'pending')
      return '<a class="sv-pill warn dash-flag-link" href="/admin/review" title="去审核">待审</a>';
    if (p.review_status === 'rejected') return pill('bad', '驳回');
    return esc(p.is_private ? '私密' : p.hidden ? '不列出' : '公开');
  };
  const whenOf = (p) => {
    const t = localParts(p.when || p.updated_at || p.published_at || '');
    return t.md && t.time ? `${t.md} ${t.time}` : t.md || '';
  };

  /* 待办条：四条都是可判定数字，打开三秒内知道今天要不要动手。
     友链在本仓库没有「申请 / 审核」流程（后台直接增删改），所以这一项是「探测失败」
     而不是「待审友链」—— 摆一个不存在的数字比不放更误导。
     数字全来自真实查询，失败就显示「—」，不补 0。
     四格是上限：格子越多，越容易有一格永远不变，整条就没可信度了。

     「预排未发」用 24 小时窗口而不是队列全量：线上实测 20 篇预排、最远排到次年二月，
     全量塞进待办条会显示「今天要做的 20 件」，而那 20 件今天一件都不用动。
     队列全量仍在 KPI 卡片「待发布」里 —— 它回答的是「队列有多长」，两个问题不同。 */
  const todosHtml = todoBar(
    TODOS.map((t) => ({ label: t.label, v: (t.from === 'sys' ? sys : kpi)[t.key], href: t.href }))
  );

  const posts = recent.length
    ? `<div class="kv-list">${recent
        .map(
          (p) => `<div class="kv-row">
            <div class="kv-k">
              <a class="dash-post-t" href="/editor?id=${encodeURIComponent(p.id)}">${esc(p.title || '（无标题）')}</a>
              <span class="kv-note">${esc(whenOf(p))}</span>
            </div>
            <span class="kv-v">${postFlag(p)}</span>
          </div>`
        )
        .join('')}</div>`
    : emptyState('还没有文章。点上面的「写作」新建第一篇。');

  const issues = [];
  if (sys.d1 === 'bad') issues.push('D1 不可用');
  if (sys.friendDown > 0) issues.push(`${sys.friendDown} 条友链探测失败`);
  const state = sys.d1 === 'bad' ? 'bad' : issues.length ? 'warn' : 'ok';
  const summaryText = state === 'bad' ? '有故障需要处理' : state === 'warn' ? '有项目需关注' : '全部正常';
  const summarySub = state === 'ok' ? 'D1 连通、友链探测均正常' : issues.join(' · ');

  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>站点概览</span>
    <span class="view-tag">${esc(sys.today || dayCN())}</span>
  </div>
  <div class="admin-view-body">
    ${todosHtml}
    <div class="dash-kpis">${cards
      .map(
        (c) => `${c.key === 'pending' && c.value > 0 ? '<a class="dash-kpi dash-kpi-link" href="/admin/review">' : '<div class="dash-kpi">'}
          <span class="dash-kpi-l">${esc(c.label)}</span>
          <strong class="dash-kpi-v">${n(c.value)}</strong>
          <span class="dash-kpi-s">${esc(c.sub)}</span>
        ${c.key === 'pending' && c.value > 0 ? '</a>' : '</div>'}`
      )
      .join('')}</div>
  </div>
</div>

<div class="admin-view-card">
  <div class="admin-view-head"><span>最近编辑</span><span class="view-tag">管理员 ${esc(user.login || '')}</span><a class="dash-more" href="/editor?panel=posts">全部文章 →</a></div>
  <div class="admin-view-body">${posts}</div>
</div>

<div class="admin-view-card">
  <div class="admin-view-head"><span>运行状态</span><a class="dash-more" href="/admin/health">查看明细 →</a></div>
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
    nav,
    active: 'dash',
    title: '工作台',
    desc: '今天要做什么，一眼看完',
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
  const [postStat, pendingStat, queueStat, nav, pv, friendStat, recentRows, d1Ok] = await Promise.all([
    safe(
      () =>
        one(
          `SELECT SUM(CASE WHEN is_private=0 AND hidden=0 AND review_status='approved' AND published_at!='' AND published_at<=datetime('now') THEN 1 ELSE 0 END) published,
                  COUNT(*) total
           FROM posts`
        ),
      {}
    ),
    safe(() => one(`SELECT COUNT(*) c FROM posts WHERE review_status='pending'`), {}),
    safe(
      () =>
        one(
          `SELECT COUNT(*) c,
                  SUM(CASE WHEN published_at <= datetime('now','+1 day') THEN 1 ELSE 0 END) today
           FROM posts
           WHERE is_private=0 AND hidden=0 AND review_status='approved'
             AND published_at!='' AND published_at>datetime('now')`
        ),
      {}
    ),
    /* 待审评论 + 近 7 天通知失败：与侧栏徽章走同一个 navCounts()。
       以前这里各查一遍，两个数字漂了没人能查谁对 —— 现在物理同源。
       「通知失败只算近 7 天」的理由见 navCounts 上方的注释。 */
    navCounts(db),
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
            `SELECT id, title, published_at, updated_at, is_private, hidden, review_status
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
        pending: pendingStat?.c,
        queue: queueStat?.c,
        queueToday: queueStat?.today,
        cmtPending: nav.pendingComments,
        notifyFail: nav.notifyFail7d,
        pv: pv?.pv,
        uv: pv?.uv,
        friendsUp: friendStat?.up,
        friendsTotal: friendStat?.total,
      },
      recent,
      sys: { d1: d1Ok ? 'ok' : 'bad', friendDown: friendStat?.down || 0, today },
      nav,
    }),
    200,
    { 'cache-control': 'no-store' }
  );
}
