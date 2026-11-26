// 后台审核页 /admin/review：列出普通用户投稿的待审文章，管理员一键通过/驳回。
// 交互走 /api/review/:id（唯一的审核逻辑在这里），页面只负责渲染和调 API。
// 内联 <script> 的 nonce 由出口 harden() 统一签，和 themeBoot 同一机制，不新增 CSP 面。
import { html } from './utils.js';
import { requireAdmin } from './auth.js';
import { getSite } from './settings.js';
import { renderAdminShell, esc, navCounts } from './admin-ui.js';

const cn = (s) => {
  const v = String(s || '');
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : v.slice(0, 16);
};

/** 纯渲染：单测喂假数据即可验证转义与结构。 */
export function renderReview({ site = {}, rows = [], nav = null }) {
  const list = rows.length
    ? rows
        .map(
          (p) => `<div class="rv-row" data-id="${p.id}">
    <div class="rv-main">
      <a class="rv-title" href="/p/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener">${esc(p.title || '（无标题）')}</a>
      <div class="rv-meta">${esc(p.author || '匿名')} · ${esc(cn(p.updated_at))} · <span class="rv-slug">${esc(p.slug)}</span></div>
      ${p.excerpt ? `<p class="rv-excerpt">${esc(p.excerpt)}</p>` : ''}
    </div>
    <div class="rv-ops">
      <button type="button" class="rv-btn ok" data-act="approve">通过</button>
      <button type="button" class="rv-btn no" data-act="reject">驳回</button>
      <span class="rv-msg" aria-live="polite"></span>
    </div>
  </div>`
        )
        .join('')
    : '<p class="sv-empty">没有待审文章。普通用户新发的稿子会排在这里，通过后才会出现在首页。</p>';

  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>已到发布时间、等待放行的投稿</span>
    <span class="view-tag">${rows.length} 篇待审</span>
  </div>
  <div class="admin-view-body">
    <p class="sv-note">通过 = 立即公开（若发布时间在未来，仍按定时闸门到点上线）。驳回后作者可修改重新提交，状态会回到待审。</p>
    ${list}
  </div>
</div>
</div>
<script>
(function(){
  var box = document.querySelector('.admin-view-body');
  if (!box) return;
  box.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    var row = btn.closest('.rv-row');
    if (!row) return;
    var act = btn.getAttribute('data-act');
    if (act === 'reject' && !window.confirm('驳回这篇投稿？作者修改后会重新进入待审。')) return;
    var msg = row.querySelector('.rv-msg');
    btn.disabled = true;
    fetch('/api/review/' + encodeURIComponent(row.getAttribute('data-id')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: act })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d.ok) throw new Error((x.d && x.d.error) || '操作失败');
        row.remove();
        if (!box.querySelector('.rv-row')) {
          box.insertAdjacentHTML('beforeend', '<p class="sv-empty">队列已清空，没有待审文章了。</p>');
        }
      })
      .catch(function (err) {
        if (msg) msg.textContent = err.message || '操作失败';
        btn.disabled = false;
      });
  });
})();
</script>`;

  return renderAdminShell({
    site,
    nav,
    active: 'review',
    title: '投稿审核',
    desc: '普通用户的新稿默认待审，通过后才会公开',
    body,
  });
}

export async function reviewPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;
  const navP = navCounts(env.DB); // 侧栏徽章，与页面主查询并行

  let rows = [];
  try {
    const r = await env.DB.prepare(
      `SELECT p.id, p.slug, p.title, p.content, p.summary, p.updated_at,
              COALESCE(u.name, u.login, '') author
       FROM posts p LEFT JOIN users u ON u.id = p.author_id
       WHERE p.review_status = 'pending'
         AND COALESCE(NULLIF(p.published_at, ''), p.created_at) <= datetime('now')
       ORDER BY p.updated_at ASC LIMIT 200`
    ).all();
    rows = (r.results || []).map((p) => ({ ...p, excerpt: p.summary || String(p.content || '').slice(0, 160) }));
  } catch (e) {
    console.error('review page', e?.message || e);
  }
  const site = await getSite(env);
  return html(renderReview({ site, rows, nav: await navP }), 200, { 'cache-control': 'no-store' });
}
