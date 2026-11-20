// 后台新增两页：健康检查 / 定时队列。
// 不摆空壳：每一格数据都来自真实查询或环境变量，查不到就明说，不编。
import { html } from './utils.js';
import { requireAdmin } from './auth.js';
import { getSite } from './settings.js';
import { renderAdminShell, esc } from './admin-ui.js';
import { postCacheStats } from './postcache.js';
import { webhookPlatform } from './webhook.js';

/* 这两页的样式已收进 public/style.css 的 .stat-page 命名空间，
   和 editor.html 的 .view-card 共用一套卡片/分组/细线列表口径。
   不再内联 <style>：一是避免 CSP 多一处内联，二是颜色能走 CSS 变量自动适配七套主题。 */

/** 北京时间展示。D1 存的是 UTC 的 `YYYY-MM-DD HH:MM:SS`。 */
function toCN(s) {
  if (!s) return '—';
  const t = String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z');
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return esc(s);
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' 北京';
}

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
      ? 'Worker Secret，网页不可改；换地址：npm run setup:webhook -- "新地址"（会先发测试消息验通再写入）'
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
        }</span><span class="kv-v"><span class="sv-pill ${esc(c.state)}">${esc(c.value)}</span></span></div>`
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
    : '<p class="sv-empty">没有待发布的文章。把文章发布时间设到将来，它就会排在这里，到点自动公开。</p>';
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
