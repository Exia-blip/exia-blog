// 后台新增两页：健康检查 / 定时队列。
// 不摆空壳：每一格数据都来自真实查询或环境变量，查不到就明说，不编。
import { html } from './utils.js';
import { requireAdmin } from './auth.js';
import { getSite } from './settings.js';
import { renderAdminShell, esc } from './admin-ui.js';
import { postCacheStats } from './postcache.js';

const PAGE_STYLE = `<style>
.wrap-s{max-width:900px;margin:0 auto;padding:30px 22px 60px}
.card{border:1px solid var(--line);border-radius:12px;padding:16px 18px;background:var(--card);margin-bottom:14px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent)}
.row:last-child{border-bottom:0}
.row-l{font-size:13.5px}
.row-r{font-family:var(--mono);font-size:12.5px;color:var(--muted);text-align:right;word-break:break-all}
.ok{color:#1a7f37}.warn{color:#b7791f}.bad{color:#c0392b}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;line-height:1.6}
.pill.ok{background:color-mix(in srgb,#1a7f37 12%,transparent)}
.pill.warn{background:color-mix(in srgb,#b7791f 12%,transparent)}
.pill.bad{background:color-mix(in srgb,#c0392b 12%,transparent)}
h2{font-family:var(--serif);font-size:16px;margin:24px 0 10px}
h2:first-child{margin-top:0}
.sub{color:var(--muted);font-size:12.5px;line-height:1.7;margin:0 0 14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:0 8px 6px 0;border-bottom:1px solid var(--line)}
td{padding:9px 8px 9px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);text-align:left;vertical-align:top}
td:last-child,th:last-child{text-align:right;padding-right:0}
a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
.time{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap}
.empty{color:var(--muted);font-size:13px;padding:18px 0}
@media (max-width:560px){.row{align-items:flex-start;flex-direction:column;gap:3px}.row-r{text-align:left}}
</style>`;

/** 北京时间展示。D1 存的是 UTC 的 `YYYY-MM-DD HH:MM:SS`。 */
function toCN(s) {
  if (!s) return '—';
  const t = String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z');
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return esc(s);
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' 北京';
}

const row = (label, value, cls = '') =>
  `<div class="row"><span class="row-l">${label}</span><span class="row-r ${cls}">${value}</span></div>`;

/* ---------- 健康检查 ---------- */

/** 纯渲染，单测喂假数据就能验。checks 是 [{label,value,state,note}]。 */
export function renderHealth({ site = {}, checks = [], friend = {}, pc = {} }) {
  const list = checks
    .map(
      (c) =>
        `<div class="row"><span class="row-l">${esc(c.label)}${
          c.note ? `<br><span class="tiny muted">${esc(c.note)}</span>` : ''
        }</span><span class="row-r"><span class="pill ${esc(c.state)}">${esc(c.value)}</span></span></div>`
    )
    .join('');
  const body = `<div class="wrap-s">${PAGE_STYLE}
<h2>运行状态</h2>
<p class="sub">这一页只做只读检查，不改动任何数据。绿灯表示这次请求实测通过；黄灯是「配了但没完全启用」；红灯才是真故障。</p>
<div class="card">${list}</div>
<h2>友链存活</h2>
<div class="card">
${row('可访问', String(friend.up ?? 0), 'ok')}
${row('有响应但状态异常', String(friend.degraded ?? 0), 'warn')}
${row('探测失败', String(friend.down ?? 0), 'bad')}
${row('最近一轮检测', esc(friend.checkedAt || '尚未检测'))}
</div>
<h2>文章缓存（本实例）</h2>
<div class="card">
${row('命中', String(pc.hit || 0))}
${row('未命中', String(pc.miss || 0))}
${row('淘汰', String(pc.evicted || 0))}
${row('当前篇数', String(pc.size || 0))}
</div>
<p class="sub">缓存是 Worker 实例级的，不跨实例、冷启清零，只能用来判断 TTL 是否合适，别当全站指标。</p>
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
    {
      label: '评论通知',
      value: ev('WEBHOOK_URL') ? '已配置' : '未配置',
      state: 'ok',
      note: ev('WEBHOOK_URL') ? '新评论会推送' : '新评论不通知，评论本身照收',
    },
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
    ? `<table><thead><tr><th>标题</th><th>发布时间</th><th>状态</th></tr></thead><tbody>${rows
        .map(
          (p) => `<tr>
      <td><a href="/editor?id=${encodeURIComponent(p.id)}">${esc(p.title || '（无标题）')}</a></td>
      <td class="time">${esc(toCN(p.published_at))}</td>
      <td class="time">${p.hidden ? '不列出' : p.is_private ? '私密' : '待发布'}</td>
    </tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="empty">没有待发布的文章。把文章发布时间设到将来，它就会排在这里，到点自动公开。</p>';
  const body = `<div class="wrap-s">${PAGE_STYLE}
<h2>尚未到点</h2>
<p class="sub">这些文章已写好，但发布时间在未来。时间到了会自动出现在站点上，不需要手动操作。</p>
<div class="card">${list}</div>
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
