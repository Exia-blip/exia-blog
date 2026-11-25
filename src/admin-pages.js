// 后台新增两页：健康检查 / 定时队列。
// 不摆空壳：每一格数据都来自真实查询或环境变量，查不到就明说，不编。
import { html } from './utils.js';
import { requireAdmin } from './auth.js';
import { getSite } from './settings.js';
import { renderAdminShell, esc, toCN, pill, fresh, emptyState } from './admin-ui.js';
import { postCacheStats } from './postcache.js';
import { webhookPlatform } from './webhook.js';

/* 这两页的样式已收进 public/style.css 的 .stat-page 命名空间，
   和 editor.html 的 .view-card 共用一套卡片/分组/细线列表口径。
   不再内联 <style>：一是避免 CSP 多一处内联，二是颜色能走 CSS 变量自动适配七套主题。 */

/* 键值行：和 editor 视图列表同一套口径——细线分隔、左标签右值。
   cls 传状态名（ok/warn/bad）时只给值上色，不改行结构。 */
const row = (label, value, cls = '') =>
  `<div class="kv-row"><span class="kv-k">${label}</span><span class="kv-v ${cls}">${value}</span></div>`;

/* 评论通知是 Worker Secret（wrangler secret put 写入），运行时只读、网页改不了——
   所以这里不给编辑框，而是把「现在生效的是哪家 + 怎么改」直接写出来。
   只显示平台名，绝不回显完整地址（里面带机器人 key）。 */
const HOOK_CN = { wecom: '企业微信', feishu: '飞书', discord: 'Discord', slack: 'Slack', generic: '通用' };
export function webhookCheck(hook = '') {
  const on = !!String(hook).trim();
  const platform = HOOK_CN[webhookPlatform(hook)] || '通用';
  return {
    label: '评论通知',
    value: on ? `已配置 · ${platform}` : '未配置',
    state: 'ok',
    note: on
      ? 'Worker Secret，网页不可改；换地址：npm run setup:webhook -- "新地址"（先发测试消息验通再写入，写入后再回打一次）'
      : '评论照收但不推送；要开通知：npm run setup:webhook -- "机器人地址"',
  };
}

/* ---------- 健康检查 ---------- */

/** 纯渲染，单测喂假数据就能验。checks 是 [{label,value,state,note}]。 */
export function renderHealth({ site = {}, checks = [], friend = {}, pc = {} }) {
  const list = checks
    .map(
      (c) =>
        `<div class="kv-row"><span class="kv-k">${esc(c.label)}${
          c.note ? `<span class="kv-note">${esc(c.note)}</span>` : ''
        }</span><span class="kv-v">${pill(c.state, c.value)}</span></div>`
    )
    .join('');
  /* 顶部一句结论：不用逐行读六项才知道整体好不好。只要有一项故障就按故障算，
     否则有半配就按半配，全通过才绿。计数只统计运行状态这一组（友链/缓存各自成组）。 */
  const tally = { ok: 0, warn: 0, bad: 0 };
  for (const c of checks) if (c.state in tally) tally[c.state]++;
  const level = tally.bad ? 'bad' : tally.warn ? 'warn' : 'ok';
  const verdict = level === 'bad' ? '有故障需要处理' : level === 'warn' ? '部分项需关注' : '全部正常';
  const summary = `<div class="sv-summary ${level}">
  <span class="sv-summary-dot"></span>
  <div class="sv-summary-main">
    <strong>${verdict}</strong>
    <span><b class="n-ok">${tally.ok}</b> 通过 · <b class="n-warn">${tally.warn}</b> 半配 · <b class="n-bad">${tally.bad}</b> 故障（运行状态）</span>
  </div>
</div>`;
  // 友链数值只在真的非 0 时才上告警色：原来「探测失败 0」也标红，会把干净状态看成故障。
  const down = friend.down || 0;
  const degraded = friend.degraded || 0;
  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>只读检查 · 不改动任何数据</span>
    <span class="view-tag">绿=通过 · 黄=半配 · 红=故障</span>
  </div>
  <div class="admin-view-body">
    ${summary}
    <div class="form-sec">运行状态</div>
    <div class="kv-list">${list}</div>

    <div class="form-sec">友链存活</div>
    <div class="kv-list">
${row('可访问', String(friend.up ?? 0), friend.up > 0 ? 'ok' : '')}
${row('有响应但状态异常', String(degraded), degraded > 0 ? 'warn' : '')}
${row('探测失败', String(down), down > 0 ? 'bad' : '')}
${row('最近一轮检测', esc(friend.checkedAt || '尚未检测'))}
    </div>

    <div class="form-sec">文章缓存 <span class="tiny muted">本实例</span></div>
    <div class="kv-list">
${row('命中', String(pc.hit || 0))}
${row('未命中', String(pc.miss || 0))}
${row('淘汰', String(pc.evicted || 0))}
${row('当前篇数', String(pc.size || 0))}
    </div>
    <p class="sv-note">缓存是 Worker 实例级的，不跨实例、冷启清零，只能用来判断 TTL 是否合适，别当全站指标。</p>
  </div>
</div>
</div>`;
  return renderAdminShell({
    site,
    active: 'health',
    title: '健康检查',
    desc: '只读探测 D1、配置与友链状态',
    body,
  });
}

export async function healthPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;

  const ev = (k) => !!String(env?.[k] ?? '').trim();
  let d1 = { state: 'bad', value: '不可用' };
  try {
    await env.DB.prepare('SELECT 1').first();
    d1 = { state: 'ok', value: '正常', note: 'D1 查询往返成功' };
  } catch (e) {
    d1 = { state: 'bad', value: '查询失败', note: String(e?.message || e).slice(0, 80) };
  }

  const siteKey = ev('TURNSTILE_SITE_KEY');
  const siteSecret = ev('TURNSTILE_SECRET');
  const turnstile =
    siteKey && siteSecret
      ? { state: 'ok', value: '已启用', note: '前端校验 + 服务端验签都在' }
      : siteKey || siteSecret
      ? { state: 'warn', value: '半配', note: '只配了一把钥匙；站点会自动退回备选验证路径' }
      : { state: 'ok', value: '未启用', note: '评论走蜜罐 + 关键词 + 频率限制' };

  const checks = [
    d1,
    {
      label: '对象存储',
      value: ev('SITE_ORIGIN') ? '已配置' : '默认值',
      state: ev('SITE_ORIGIN') ? 'ok' : 'warn',
      note: ev('SITE_ORIGIN') ? '对外绝对链接使用固定域名' : '未设 SITE_ORIGIN，按请求来源生成链接',
    },
    { label: '会话密钥', value: ev('SESSION_SECRET') ? '已配置' : '缺失', state: ev('SESSION_SECRET') ? 'ok' : 'bad' },
    turnstile,
    webhookCheck(env.WEBHOOK_URL),
    {
      label: '外部统计',
      value: ev('UMAMI_SCRIPT') && ev('UMAMI_SITE_ID') ? 'umami' : '自建 /api/pv',
      state: 'ok',
      note: ev('UMAMI_SCRIPT') !== ev('UMAMI_SITE_ID') ? '两把值只配了一把，已退回自建' : '',
    },
  ];

  let friend = {};
  try {
    const r = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) up,
         SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) degraded,
         SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) down,
         MAX(checked_at) checkedAt
       FROM friends`
    ).first();
    friend = { up: r?.up || 0, degraded: r?.degraded || 0, down: r?.down || 0, checkedAt: r?.checkedAt || '' };
  } catch {
    friend = { up: 0, degraded: 0, down: 0, checkedAt: '' };
  }

  const site = await getSite(env);
  return html(renderHealth({ site, checks, friend, pc: postCacheStats() }), 200, { 'cache-control': 'no-store' });
}

/* ---------- 定时队列 ---------- */

export function renderQueue({ site = {}, rows = [] }) {
  const list = rows.length
    ? `<div class="sv-table-wrap"><table class="sv-table"><thead><tr><th>标题</th><th>发布时间</th><th>状态</th></tr></thead><tbody>${rows
        .map(
          (p) => `<tr>
      <td><a href="/editor?id=${encodeURIComponent(p.id)}">${esc(p.title || '（无标题）')}</a></td>
      <td class="sv-time">${esc(toCN(p.published_at))}</td>
      <td class="sv-time">${p.hidden ? '不列出' : p.is_private ? '私密' : '待发布'}</td>
    </tr>`
        )
        .join('')}</tbody></table></div>`
    : emptyState('没有待发布的文章。把文章发布时间设到将来，它就会排在这里，到点自动公开。');
  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>已写好、等待发布时间到达</span>
    <span class="view-tag">${rows.length} 篇待发布</span>
  </div>
  <div class="admin-view-body">
    <div class="form-sec">尚未到点</div>
    <p class="sv-note">这些文章已写好，但发布时间在未来。时间到了会自动出现在站点上，不需要手动操作。</p>
    ${list}
  </div>
</div>
</div>`;
  return renderAdminShell({
    site,
    active: 'queue',
    title: '定时队列',
    desc: '已写好、等待发布时间到达的文章',
    body,
  });
}

export async function queuePage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;

  let rows = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id, title, published_at, hidden, is_private
       FROM posts
       WHERE published_at != '' AND published_at > datetime('now')
       ORDER BY published_at ASC LIMIT 100`
    ).all();
    rows = r.results || [];
  } catch (e) {
    console.error('queue', e?.message || e);
  }
  const site = await getSite(env);
  return html(renderQueue({ site, rows }), 200, { 'cache-control': 'no-store' });
}

/* ---------- 操作日志 ---------- */

/** 纯渲染：单测喂假数据即可验证转义与结构。rows 是 audit_log 行。 */
export function renderAudit({ site = {}, rows = [] }) {
  const list = rows.length
    ? `<div class="sv-table-wrap"><table class="sv-table adm-audit-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr>
      <td class="sv-time">${esc(toCN(r.created_at))}</td>
      <td class="adm-audit-actor">${esc(r.actor_login || (r.actor_id ? `#${r.actor_id}` : 'system'))}</td>
      <td><span class="sv-pill adm-audit-action">${esc(r.action || '—')}</span></td>
      <td class="adm-audit-target">${esc(r.target_type || '—')}${
        r.target_id ? ` <span class="adm-audit-id">#${esc(r.target_id)}</span>` : ''
      }</td>
      <td class="adm-audit-detail">${esc(r.detail || '—')}</td>
    </tr>`
        )
        .join('')}</tbody></table></div>`
    : emptyState('还没有操作记录。文章增删改、审核、评论处置、友链变更与版本回滚都会记在这里。');
  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>只增不改的后台操作流水</span>
    <span class="view-tag">最近 ${rows.length} 条</span>
  </div>
  <div class="admin-view-body">
    <p class="sv-note">记录谁在什么时候改了什么；最多显示最近 100 条。审计写入失败不会阻断操作，极个别操作可能没有留痕。</p>
    ${list}
  </div>
</div>
</div>`;
  return renderAdminShell({
    site,
    active: 'audit',
    title: '操作日志',
    desc: '谁在什么时候改了什么',
    body,
  });
}

export async function auditPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;

  let rows = [];
  try {
    const r = await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all();
    rows = r.results || [];
  } catch (e) {
    console.error('audit page', e?.message || e);
  }
  const site = await getSite(env);
  return html(renderAudit({ site, rows }), 200, { 'cache-control': 'no-store' });
}

/* ---------- 版本历史 ---------- */

/** 纯渲染：单测喂假数据即可验证转义与结构。script 里不插用户数据，id 全走 data-*。 */
export function renderHistory({ site = {}, post = {}, rows = [] }) {
  const list = rows.length
    ? rows
        .map(
          (rev) => `<div class="adm-hist-row" data-rev="${esc(rev.id)}">
    <div class="adm-hist-main">
      <div class="adm-hist-line">
        <strong class="adm-hist-title">${esc(rev.title || '（无标题）')}</strong>
        <span class="adm-hist-meta">${esc(toCN(rev.saved_at))} · ${esc(rev.saved_by ? `用户 #${rev.saved_by}` : '系统')}</span>
      </div>
      ${rev.note ? `<p class="adm-hist-note">${esc(rev.note)}</p>` : ''}
    </div>
    <div class="adm-hist-ops">
      <button type="button" class="rv-btn" data-act="preview">预览</button>
      <button type="button" class="rv-btn no" data-act="restore">回滚到此版</button>
    </div>
    <div class="adm-hist-preview" hidden><textarea class="adm-hist-content" readonly>${esc(rev.content || '')}</textarea></div>
    <span class="rv-msg" aria-live="polite"></span>
  </div>`
        )
        .join('')
    : emptyState('还没有历史版本。每次保存文章都会留一份快照，最多保留最近 30 版。');
  const body = `<div class="wrap-s">
<div class="admin-view-card" data-post="${esc(post.id || '')}">
  <div class="admin-view-head">
    <span class="adm-hist-heading">《${esc(post.title || '（无标题）')}》的历史版本</span>
    <span class="view-tag">${rows.length} / 30 版</span>
  </div>
  <div class="admin-view-body">
    <p class="adm-hist-back"><a href="/editor?id=${encodeURIComponent(post.id || '')}">← 返回编辑器</a></p>
    <p class="sv-note">回滚只改写文章的正文与状态，标签保持当前值；回滚前会先把当前内容另存成一个新版本。</p>
    ${list}
  </div>
</div>
</div>
<script>
(function(){
  var card = document.querySelector('.admin-view-card[data-post]');
  if (!card) return;
  var postId = card.getAttribute('data-post');
  var box = card.querySelector('.admin-view-body');
  if (!box) return;
  box.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    var row = btn.closest('.adm-hist-row');
    if (!row) return;
    var act = btn.getAttribute('data-act');
    var revId = row.getAttribute('data-rev');
    if (act === 'preview') {
      var pv = row.querySelector('.adm-hist-preview');
      if (!pv) return;
      pv.hidden = !pv.hidden;
      btn.textContent = pv.hidden ? '预览' : '收起';
      return;
    }
    if (!window.confirm('确定回滚到这个版本？当前内容会先另存成一个新版本。')) return;
    var msg = row.querySelector('.rv-msg');
    btn.disabled = true;
    fetch('/api/posts/' + encodeURIComponent(postId) + '/revisions/' + encodeURIComponent(revId) + '/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d.ok) throw new Error((x.d && x.d.error) || '回滚失败');
        location.reload();
      })
      .catch(function (err) {
        if (msg) msg.textContent = err.message || '回滚失败';
        btn.disabled = false;
      });
  });
})();
</script>`;
  return renderAdminShell({
    site,
    active: 'history',
    title: '版本历史',
    desc: '误覆盖、误删之后从这里找回来',
    body,
  });
}

export async function historyPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('post') || '', 10);
  const site = await getSite(env);
  const noStore = { 'cache-control': 'no-store' };
  /* 参数缺失 / 文章已删：给一页带提示的页面，不抛 500。 */
  if (!Number.isFinite(id) || id <= 0) return html(renderHistory({ site }), 200, noStore);

  let post = null;
  try {
    post = await env.DB.prepare('SELECT id, title FROM posts WHERE id = ?').bind(id).first();
  } catch (e) {
    console.error('history post', e?.message || e);
  }
  if (!post) {
    const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head"><span>找不到这篇文章</span></div>
  <div class="admin-view-body">
    <p class="adm-hist-empty">文章不存在或已被删除，无法查看历史版本。</p>
    <p class="adm-hist-back"><a href="/editor?panel=posts">← 返回文章列表</a></p>
  </div>
</div>
</div>`;
    return html(
      renderAdminShell({ site, active: 'history', title: '版本历史', desc: '误覆盖、误删之后从这里找回来', body }),
      200,
      noStore
    );
  }

  let rows = [];
  try {
    const r = await env.DB.prepare(
      'SELECT * FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT 30'
    )
      .bind(post.id)
      .all();
    rows = r.results || [];
  } catch (e) {
    console.error('history revisions', e?.message || e);
  }
  return html(renderHistory({ site, post, rows }), 200, noStore);
}

/* ---------- 友链管理 ---------- */

const frStatus = (s) => (Number(s) === 1 ? '可访问' : Number(s) === 2 ? '状态异常' : '未检测/不可访问');
const frBadge = (s) => (Number(s) === 1 ? 'ok' : Number(s) === 2 ? 'warn' : 'bad');

/** 纯渲染：单测喂假数据即可验证转义与结构。script 里不插用户数据，id 全走 data-*。 */
export function renderFriendsAdmin({ site = {}, rows = [] }) {
  const list = rows.length
    ? rows
        .map(
          (f) => `<div class="adm-fr-row" data-id="${esc(f.id)}">
    <div class="adm-fr-main">
      <div class="adm-fr-line">
        <strong class="adm-fr-name">${esc(f.name)}</strong>
        ${pill(frBadge(f.status), frStatus(f.status))}
      </div>
      <div class="adm-fr-url"><a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.url)}</a></div>
      <div class="adm-fr-meta">HTTP ${esc(f.http_status ?? 0)} · 延迟 ${esc(f.latency_ms ?? '—')} ms · 检测 ${fresh(
        f.checked_at,
        { staleMs: 45 * 60e3 }
      )}</div>
      ${f.desc ? `<p class="adm-fr-desc">${esc(f.desc)}</p>` : ''}
    </div>
    <div class="adm-fr-ops">
      <button type="button" class="rv-btn" data-act="edit">编辑</button>
      <button type="button" class="rv-btn" data-act="check">立即探测</button>
      <button type="button" class="rv-btn no" data-act="delete">删除</button>
    </div>
    <form class="adm-fr-edit" hidden>
      <label class="adm-fr-field">名称<input name="name" value="${esc(f.name)}" required></label>
      <label class="adm-fr-field">网址<input name="url" type="url" value="${esc(f.url)}" required></label>
      <label class="adm-fr-field">头像<input name="avatar" value="${esc(f.avatar || '')}"></label>
      <label class="adm-fr-field">描述<input name="desc" value="${esc(f.desc || '')}"></label>
      <span class="adm-fr-editops">
        <button type="submit" class="rv-btn ok">保存</button>
        <button type="button" class="rv-btn" data-act="cancel">取消</button>
      </span>
    </form>
  </div>`
        )
        .join('')
    : emptyState('还没有友链。用上面的表单添加第一条。');
  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>新增友链</span>
    <span class="view-tag">名称与网址必填</span>
  </div>
  <div class="admin-view-body">
    <form class="adm-fr-add">
      <label class="adm-fr-field">名称<input name="name" required placeholder="站点名称"></label>
      <label class="adm-fr-field">网址<input name="url" type="url" required placeholder="https://example.com"></label>
      <label class="adm-fr-field">头像<input name="avatar" placeholder="可选，头像地址"></label>
      <label class="adm-fr-field">描述<input name="desc" placeholder="可选，一句话介绍"></label>
      <button type="submit" class="rv-btn ok">添加友链</button>
    </form>
    <p class="sv-note adm-fr-msg" aria-live="polite"></p>
  </div>
</div>
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>现有友链</span>
    <span class="view-tag">${rows.length} 条 · 状态来自最近一次探测</span>
  </div>
  <div class="admin-view-body adm-fr-list">
    ${list}
  </div>
</div>
</div>
<script>
(function(){
  var msg = document.querySelector('.adm-fr-msg');
  function fail(err) { if (msg) msg.textContent = (err && err.message) || '操作失败'; }
  function send(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (x) {
      if (!x.ok || !x.d.ok) throw new Error((x.d && x.d.error) || '操作失败');
      return x.d;
    });
  }
  function payload(form) {
    var o = {};
    new FormData(form).forEach(function (v, k) { o[k] = v; });
    return JSON.stringify(o);
  }
  var add = document.querySelector('.adm-fr-add');
  if (add) add.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = add.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    send('/api/friends', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload(add) })
      .then(function () { location.reload(); })
      .catch(function (err) { fail(err); if (btn) btn.disabled = false; });
  });
  var box = document.querySelector('.adm-fr-list');
  if (!box) return;
  box.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    var row = btn.closest('.adm-fr-row');
    if (!row) return;
    var act = btn.getAttribute('data-act');
    var id = row.getAttribute('data-id');
    if (act === 'edit' || act === 'cancel') {
      var form = row.querySelector('.adm-fr-edit');
      if (form) form.hidden = act === 'cancel';
      return;
    }
    if (act === 'check') {
      btn.disabled = true;
      send('/api/friends/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function () { location.reload(); })
        .catch(function (err) { fail(err); btn.disabled = false; });
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('删除这条友链？')) return;
      btn.disabled = true;
      send('/api/friends/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () { location.reload(); })
        .catch(function (err) { fail(err); btn.disabled = false; });
    }
  });
  box.addEventListener('submit', function (e) {
    var form = e.target.closest('.adm-fr-edit');
    if (!form) return;
    e.preventDefault();
    var row = form.closest('.adm-fr-row');
    var id = row && row.getAttribute('data-id');
    var btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    send('/api/friends/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: payload(form)
    }).then(function () { location.reload(); })
      .catch(function (err) { fail(err); if (btn) btn.disabled = false; });
  });
})();
</script>`;
  return renderAdminShell({
    site,
    active: 'friends',
    title: '友链管理',
    desc: '增删友链，并查看最近一次探测结果',
    body,
  });
}

export async function friendsAdminPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;

  let rows = [];
  try {
    const r = await env.DB.prepare('SELECT * FROM friends ORDER BY id').all();
    rows = r.results || [];
  } catch (e) {
    console.error('friends admin', e?.message || e);
  }
  const site = await getSite(env);
  return html(renderFriendsAdmin({ site, rows }), 200, { 'cache-control': 'no-store' });
}

/* ---------- 评论管理（四态 + 通知送达） ---------- */

/* 四态按「待办优先」排：待审永远第一，全部放最后。
   数量来自 counts，欠账一眼看见，不用逐页翻。 */
const CM_TABS = [
  { key: 'pending', label: '待审' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' },
  { key: 'all', label: '全部' },
];
const CM_STATE = { pending: ['warn', '待审'], approved: ['ok', '已通过'], rejected: ['bad', '驳回'] };

/* 通知结果只显示落库过的事实：没记录就写「未尝试」，不猜、不补默认值。
   失败原因塞进 title，排查时不用再翻 wrangler tail。
   时刻用相对时间：投递是一次性历史事件，不会重跑，所以 staleMs 给 Infinity
   ——不能用「已过期」去标一条三周前送达成功的记录，那是拿错了判据。 */
function notifyCell(c) {
  const st = String(c.notify_status || '');
  const note = String(c.notify_note || '');
  const [kind, label] =
    st === 'ok' ? ['ok', '已送达'] : st === 'fail' ? ['bad', '失败'] : st === 'skip' ? ['muted', '跳过'] : ['muted', '未尝试'];
  const at = String(c.notified_at || '');
  const hint = [note, at && `尝试于 ${toCN(at)}`].filter(Boolean).join(' · ') || '没有投递记录';
  // fresh() 自带 <span class="sv-time">，别再包一层——套两层会把字号与颜色叠两遍。
  const when = at ? ` ${fresh(at, { staleMs: Infinity })}` : '';
  return `${pill(kind, label, hint)}${when}`;
}

/** 纯渲染：单测喂假数据即可验证转义与结构。moderation='1' 表示当前已开启先审后发。
    hook 只用来判「配没配 / 哪家」，绝不回显地址本身（里面带机器人 key）。 */
export function renderCommentsAdmin({
  site = {},
  rows = [],
  moderation = '0',
  hook = '',
  tab = 'pending',
  counts = {},
  notifyStats = {},
}) {
  const on = moderation === true || String(moderation) === '1';
  const hookOn = !!String(hook).trim();
  const platform = HOOK_CN[webhookPlatform(String(hook))] || '通用';
  const n = (v) => (v === undefined || v === null ? '—' : String(v));
  const tabLabel = (CM_TABS.find((t) => t.key === tab) || CM_TABS[0]).label;
  const tabs = CM_TABS.map((t) => {
    const active = t.key === tab;
    return `<a class="tag${active ? ' on' : ''}" href="/admin/comments?status=${t.key}"${
      active ? ' aria-current="page"' : ''
    }>${t.label} ${n(counts[t.key] ?? 0)}</a>`;
  }).join('');

  const list = rows.length
    ? rows
        .map((c) => {
          const [cls, label] = CM_STATE[c.status] || ['', esc(c.status || '—')];
          const lvl = c.parent_id ? `回复 ${esc(c.parent_name || '#' + c.parent_id)}` : '顶层';
          return `<div class="adm-cmt-row" data-id="${esc(c.id)}">
    <div class="adm-cmt-main">
      <div class="adm-cmt-line">
        <strong class="adm-cmt-author">${esc(c.name || '匿名')}</strong>
        ${pill(cls, label)}
        <span class="adm-cmt-post">于《${esc(c.post_title || '（文章已删除）')}》</span>
        <span class="adm-cmt-time">${esc(toCN(c.created_at))}</span>
      </div>
      <p class="adm-cmt-content">${esc(c.content || '')}</p>
      <div class="adm-cmt-meta">${lvl} · 通知 ${notifyCell(c)}</div>
    </div>
    <div class="adm-cmt-ops">
      <button type="button" class="rv-btn ok" data-act="approve">通过</button>
      <button type="button" class="rv-btn no" data-act="reject">驳回</button>
    </div>
  </div>`;
        })
        .join('')
    : emptyState(
        tab === 'pending'
          ? '没有待审评论。开启先审后发后，普通用户的新评论会排在这里。'
          : '这个状态下还没有评论。'
      );

  /* 通知这块从「读码结论」升级成事实汇总：数字取自 comments.notify_status，
     已送达 = 平台回执码为 0（企微 200 里藏 errcode 算失败），刷新即变。 */
  const ns = notifyStats;
  const anyFail = Number(ns.fail || 0) > 0;
  const notifyState = anyFail ? 'bad' : hookOn ? 'ok' : 'warn';
  const notifyRow = `<div class="admin-view-card">
  <div class="admin-view-head">
    <span>评论通知送达</span>
    <span class="view-tag">${hookOn ? `已配置 · ${platform}` : '未配置'}</span>
  </div>
  <div class="admin-view-body">
    <div class="sv-summary ${notifyState}">
      <span class="sv-summary-dot"></span>
      <div class="sv-summary-main">
        <strong>已送达 ${n(ns.ok)} · 失败 ${n(ns.fail)} · 跳过 ${n(ns.skip)} · 未尝试 ${n(ns.none)}</strong>
        <span>${
          hookOn
            ? '每条评论都有自己的投递结果，失败的在列表里标红，悬停看 HTTP 码或平台码。'
            : '当前没有通知地址，投递一律记为跳过；配好 WEBHOOK_URL 后新评论才会真发。'
        }</span>
      </div>
    </div>
    <p class="sv-note">此前这条链路只有日志，成没成没人知道；现在每次投递写回 comments.notify_status。这仍是「本机观测到的平台回执」，群里是否真的跳出消息，用 <code>npm run verify:comment-e2e</code> 真发一次最稳。</p>
  </div>
</div>`;
  const body = `<div class="wrap-s">
${notifyRow}
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>评论先审后发</span>
    <span class="view-tag adm-cmt-state">当前：${on ? '已开启' : '已关闭'}</span>
  </div>
  <div class="admin-view-body">
    <label class="adm-cmt-toggle">
      <input type="checkbox" class="adm-cmt-switch"${on ? ' checked' : ''}>
      <span>开启评论审核</span>
    </label>
    <p class="sv-note">关闭时新评论直接公开，并会一并放行下面所有待审评论（已驳回的不动）；开启后普通用户的新评论需在这里放行。管理员自己发的评论不受影响。</p>
    <p class="sv-note adm-cmt-msg" aria-live="polite"></p>
  </div>
</div>
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>评论 · ${tabLabel}</span>
    <span class="view-tag">${rows.length} 条（最多 100）</span>
  </div>
  <div class="admin-view-body">
    <div class="year-filter">${tabs}</div>
    <div class="adm-cmt-list">
      ${list}
    </div>
  </div>
</div>
</div>
<script>
(function(){
  var TAB = ${JSON.stringify(tab)};
  var msg = document.querySelector('.adm-cmt-msg');
  var state = document.querySelector('.adm-cmt-state');
  function fail(err) { if (msg) msg.textContent = (err && err.message) || '操作失败'; }
  function send(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (x) {
      if (!x.ok || !x.d.ok) throw new Error((x.d && x.d.error) || '操作失败');
      return x.d;
    });
  }
  var pendingCount = ${Number(counts.pending || 0)};
  var sw = document.querySelector('.adm-cmt-switch');
  if (sw) sw.addEventListener('change', function () {
    var enabled = sw.checked;
    // 关闭是有副作用的：待审评论会被批量放行。先让人确认，别一次误点把审核结论撤了。
    if (!enabled && pendingCount > 0 && !window.confirm('关闭审核会同时放行当前 ' + pendingCount + ' 条待审评论（已驳回的不动），确定吗？')) {
      sw.checked = true;
      return;
    }
    sw.disabled = true;
    send('/api/comments/moderation', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    }).then(function (d) {
      sw.disabled = false;
      if (state) state.textContent = '当前：' + (enabled ? '已开启' : '已关闭');
      var n = d && d.released ? d.released : 0;
      if (msg) msg.textContent = enabled ? '已开启评论审核' : '已关闭评论审核' + (n ? '，放行 ' + n + ' 条待审评论' : '');
      pendingCount = 0;
    }).catch(function (err) {
      sw.disabled = false;
      sw.checked = !enabled;
      fail(err);
    });
  });
  var box = document.querySelector('.adm-cmt-list');
  if (!box) return;
  box.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    var row = btn.closest('.adm-cmt-row');
    if (!row) return;
    var act = btn.getAttribute('data-act');
    btn.disabled = true;
    send('/api/comments/' + encodeURIComponent(row.getAttribute('data-id')) + '/moderate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: act })
    }).then(function () {
      /* 待审页点掉一条就少一条，直接摘行；其余三态点完该换列了 ——
         原地摘行会让「已通过」列表看起来像删掉了评论，改成整页重取。 */
      if (TAB === 'pending') {
        row.remove();
        if (!box.querySelector('.adm-cmt-row')) {
          box.insertAdjacentHTML('beforeend', '<p class="sv-empty">待审队列已清空。</p>');
        }
      } else {
        location.reload();
      }
    }).catch(function (err) {
      fail(err);
      btn.disabled = false;
    });
  });
})();
</script>`;
  return renderAdminShell({
    site,
    active: 'comments',
    title: '评论管理',
    desc: '四态一览，每行带通知投递结果，并可开关先审后发',
    body,
  });
}

export async function commentsAdminPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;

  const want = new URL(request.url).searchParams.get('status') || '';
  const tab = CM_TABS.some((t) => t.key === want) ? want : 'pending';

  let moderation = '0';
  try {
    const s = await env.DB.prepare("SELECT value FROM settings WHERE key = 'comment_moderation'").first();
    if (s && s.value != null) moderation = String(s.value);
  } catch (e) {
    console.error('comments moderation', e?.message || e);
  }

  /* 三块查询各自兜底：计数挂了不该让整页白屏，列表挂了也该看得见计数。 */
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      console.error('comments admin', e?.message || e);
      return fallback;
    }
  };
  const [byStatus, ns, rows] = await Promise.all([
    safe(
      () =>
        env.DB.prepare('SELECT status, COUNT(*) c FROM comments GROUP BY status')
          .all()
          .then((r) => r.results || []),
      []
    ),
    safe(
      () =>
        env.DB.prepare(
          `SELECT SUM(CASE WHEN notify_status='ok' THEN 1 ELSE 0 END) ok,
                  SUM(CASE WHEN notify_status='fail' THEN 1 ELSE 0 END) fail,
                  SUM(CASE WHEN notify_status='skip' THEN 1 ELSE 0 END) skip,
                  SUM(CASE WHEN notify_status='' THEN 1 ELSE 0 END) none
           FROM comments`
        ).first(),
      null
    ),
    safe(
      () =>
        env.DB.prepare(
          `SELECT c.id, c.post_id, c.parent_id, c.name, c.content, c.status, c.created_at,
                  c.notify_status, c.notify_note, c.notified_at,
                  p.title AS post_title, pc.name AS parent_name
           FROM comments c
           JOIN posts p ON p.id = c.post_id
           LEFT JOIN comments pc ON pc.id = c.parent_id
           ${tab === 'all' ? '' : 'WHERE c.status = ?'}
           ORDER BY c.id DESC LIMIT 100`
        )
          .bind(...(tab === 'all' ? [] : [tab]))
          .all()
          .then((r) => r.results || []),
      []
    ),
  ]);

  const counts = { pending: 0, approved: 0, rejected: 0, all: 0 };
  for (const row of byStatus) {
    const k = String(row.status || '');
    const c = Number(row.c || 0);
    counts.all += c;
    if (k in counts && k !== 'all') counts[k] = c;
  }
  const notifyStats = {
    ok: ns?.ok || 0,
    fail: ns?.fail || 0,
    skip: ns?.skip || 0,
    none: ns?.none || 0,
  };

  const site = await getSite(env);
  return html(
    renderCommentsAdmin({ site, rows, moderation, hook: env.WEBHOOK_URL || '', tab, counts, notifyStats }),
    200,
    { 'cache-control': 'no-store' }
  );
}

/* ---------- 通知投递（独立页） ----------
   以前「通知到底发出去没有」只存在于评论页顶部一行汇总和 wrangler tail 里。
   汇总回答「一共几条」，回答不了「哪一条、发给谁、平台回了什么」——
   而排障要的正是后者。这一页只做只读明细，不提供任何重发按钮：
   通知没有重放语义，加一个「重发」就是新增一条没有断言守的写路径（P-075）。 */

/** 纯渲染：rows 是 comments 里带投递记录的行。 */
export function renderNotify({ site = {}, rows = [], stats = {}, hook = '' }) {
  const n = (v) => (v === undefined || v === null ? '—' : String(v));
  const hookOn = !!String(hook || '').trim();
  const platform = HOOK_CN[webhookPlatform(String(hook))] || '通用';

  /* 汇总与评论页同一口径（同一张表、同一组 CASE），两处数字必须能对上。
     对不上就是有一处口径漂了——比单个数字错更难查，所以这里把 SQL 也写在一起。 */
  const summary = `<div class="sv-summary ${Number(stats.fail || 0) > 0 ? 'bad' : hookOn ? 'ok' : 'warn'}">
  <span class="sv-summary-dot"></span>
  <div class="sv-summary-main">
    <strong>已送达 ${n(stats.ok)} · 失败 ${n(stats.fail)} · 跳过 ${n(stats.skip)} · 未尝试 ${n(stats.none)}</strong>
    <span>${hookOn ? `当前地址：已配置 · ${platform}（不回显具体地址）` : '当前没有通知地址，新评论一律记为「跳过」——这是可选项，不是欠账'}</span>
  </div>
</div>`;

  const list = rows.length
    ? rows
        .map((c) => {
          const st = String(c.notify_status || '');
          const [kind, label] =
            st === 'ok' ? ['ok', '已送达'] : st === 'fail' ? ['bad', '失败'] : st === 'skip' ? ['muted', '跳过'] : ['muted', '未尝试'];
          const note = String(c.notify_note || '');
          /* 目标是文章标题 + 评论人；note 里是平台回执或失败原因。
             时刻用相对时间、staleMs 给 Infinity：投递是一次性历史事件，不会重跑。 */
          const when = c.notified_at ? fresh(c.notified_at, { staleMs: Infinity }) : '<span class="sv-time">没有投递记录</span>';
          return `<div class="kv-row">
      <span class="kv-k">${esc(c.post_title || '（文章已删除）')}<span class="kv-note">${esc(c.name || '匿名')}${note ? ` · ${esc(note)}` : ''}</span></span>
      <span class="kv-v">${pill(kind, label)} ${when}</span>
    </div>`;
        })
        .join('')
    : emptyState(hookOn ? '还没有投递记录。发一条评论后这里会出现它的结果。' : '没有通知地址，投递全部记为跳过；配好 WEBHOOK_URL 后新评论才会真发。');

  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head">
    <span>投递明细 · 最近 50 条</span>
    <span class="view-tag">只读</span>
  </div>
  <div class="admin-view-body">
    ${summary}
    <div class="kv-list">${list}</div>
    <p class="sv-note">这些是「本机观测到的平台回执」：HTTP 200 里塞 errcode 也算失败。评论落库 → 触发通知这段已在本地 dev 真发验证，线上仍待人工点一次验证码（<code>npm run verify:comment-e2e</code>）。</p>
  </div>
</div>
</div>`;
  return renderAdminShell({
    site,
    active: 'notify',
    title: '通知投递',
    desc: '每条通知发给谁、平台回了什么',
    body,
  });
}

export async function notifyPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      console.error('notify admin', e?.message || e);
      return fallback;
    }
  };
  const [stats, rows] = await Promise.all([
    safe(
      () =>
        env.DB.prepare(
          `SELECT SUM(CASE WHEN notify_status='ok' THEN 1 ELSE 0 END) ok,
                  SUM(CASE WHEN notify_status='fail' THEN 1 ELSE 0 END) fail,
                  SUM(CASE WHEN notify_status='skip' THEN 1 ELSE 0 END) skip,
                  SUM(CASE WHEN notify_status='' THEN 1 ELSE 0 END) none
           FROM comments`
        ).first(),
      null
    ),
    safe(
      () =>
        env.DB.prepare(
          `SELECT c.id, c.name, c.notify_status, c.notify_note, c.notified_at, p.title AS post_title
           FROM comments c LEFT JOIN posts p ON p.id = c.post_id
           WHERE c.notified_at IS NOT NULL AND c.notified_at != ''
           ORDER BY c.notified_at DESC, c.id DESC LIMIT 50`
        )
          .all()
          .then((r) => r.results || []),
      []
    ),
  ]);
  const site = await getSite(env);
  return html(
    renderNotify({
      site,
      rows,
      stats: { ok: stats?.ok || 0, fail: stats?.fail || 0, skip: stats?.skip || 0, none: stats?.none || 0 },
      hook: env.WEBHOOK_URL || '',
    }),
    200,
    { 'cache-control': 'no-store' }
  );
}

/* ---------- 工具与备份（只读索引） ----------
   这一栏存在的意义不是「把功能搬到网页」，正好相反：这些动作低频、误触代价高，
   后台一个按钮都不给。页面只负责回答「有这些能力、在哪跑、跑之前看哪里」——
   省掉「后台能不能点」这种翻代码确认。 */

export function renderTools({ site = {} }) {
  const item = (name, cmd, why) => `<div class="kv-row">
      <span class="kv-k">${esc(name)}<span class="kv-note">${esc(why)}</span></span>
      <span class="kv-v"><code>${esc(cmd)}</code></span>
    </div>`;
  const body = `<div class="wrap-s">
<div class="admin-view-card">
  <div class="admin-view-head"><span>为什么这里没有按钮</span><span class="view-tag">只读</span></div>
  <div class="admin-view-body">
    <p class="sv-note">备份、恢复、导入导出这几件事都是「一按就改全库」的量级，且需要先看清目标环境（本地 / 线上）。放在网页上，误触的代价远大于省下的几步；所以只在这里列命令与前置条件，动作仍在命令行执行。所有命令都要求先跑 <code>npm test</code>。</p>
  </div>
</div>
<div class="admin-view-card">
  <div class="admin-view-head"><span>备份与恢复</span><span class="view-tag">D1</span></div>
  <div class="admin-view-body"><div class="kv-list">
${item('滚动备份到 R2', 'node scripts/backup-upload.mjs', '导出 → 上传 → 保留 7 份；先看 --dry-run 的计划')}
${item('备份可恢复演练', 'node scripts/backup-drill.mjs', '把导出灌进内存库重建；没演练过的备份等于没有')}
${item('整站搬迁', 'node scripts/migrate.mjs export|import', '换账号/灾备用；换域名不需要搬数据')}
  </div></div>
</div>
<div class="admin-view-card">
  <div class="admin-view-head"><span>内容与结构</span><span class="view-tag">可回滚</span></div>
  <div class="admin-view-body"><div class="kv-list">
${item('回填正文 HTML', 'npm run backfill:html -- --all', '改了渲染函数才需要；只补空行，不覆盖已有')}
${item('结构迁移', 'npm run schema:apply', '只走 migrations/；先跑 schema:apply:local 验幂等')}
${item('发布前闸门', 'npm run deploy', '内置 npm test + 结构校验，失败即停')}
  </div></div>
</div>
<div class="admin-view-card">
  <div class="admin-view-head"><span>MCP 接入</span><span class="view-tag">本机</span></div>
  <div class="admin-view-body"><div class="kv-list">
${item('配置文件', '~/.workbuddy/mcp.json', '不进仓库：里面是该机器的凭据')}
${item('生效方式', '连接器管理 → 信任', '写入后不会自动加载，需要在客户端确认一次')}
  </div></div>
</div>
</div>`;
  return renderAdminShell({ site, active: 'tools', title: '工具与备份', desc: '低频动作的入口索引，后台不提供按钮', body });
}

export async function toolsPage(env, request) {
  const { res } = await requireAdmin(env, request);
  if (res) return res;
  const site = await getSite(env);
  return html(renderTools({ site }), 200, { 'cache-control': 'no-store' });
}
