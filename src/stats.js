// 访问统计：自己记一笔，不引第三方。
//
// 为什么不是 umami：umami 要一台常驻 Node 主机 + Postgres，为了一个「今天几个人来过」
// 多出两台机器的运维和一条跨域脚本请求，和「轻量、不拖性能」正好相反。
// 这里用已有的 D1 记最小集（哪天、哪个路径、哪来的、什么端），
// 上报走 sendBeacon 在 load 之后发，正文渲染一个字节都不等它。
//
// 想换成 umami / 其他服务也行：把 UMAMI_SCRIPT、UMAMI_SITE_ID 两个变量写上，
// 页面会注入那段 script，同时不再往这里记 —— 两套同时开着只会让数字互相矛盾。

import { html } from './utils.js';
import { requireAdmin } from './auth.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);

export const BOT_RE =
  /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|lighthouse|preview|curl\/|wget|python-requests|go-http-client|node-fetch|axios\/|facebookexternalhit|telegrambot|whatsapp/i;

/** 北京时间的「今天」。D1 的 date('now') 是 UTC，跑一天会错开 8 小时。 */
export function dayCN(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 - offsetDays * 86400e3).toISOString().slice(0, 10);
}

export function deviceOf(ua) {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobile|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
  return 'pc';
}

/** IP 不落库：存盐化后的 8 字节摘要，够做 UV 去重，反查不出人 */
async function ipTag(env, request) {
  const ip =
    request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const salt = String(env.SESSION_SECRET || 'pv').slice(0, 16);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${salt}`));
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 只留域名。完整 URL 会把搜索词、参数、甚至别人的会话 id 一起记下来。 */
export function refHost(raw, origin) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(u.protocol)) return '';
  if (u.host === origin) return ''; // 站内跳转不算来源
  return u.host.slice(0, 80);
}

export async function recordPv(env, request, ctx) {
  const ua = request.headers.get('user-agent') || '';
  const noContent = new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  if (!ua || BOT_RE.test(ua)) return noContent;

  let body;
  try {
    body = await request.json();
  } catch {
    return noContent;
  }

  let path = String(body?.p || '');
  if (!path.startsWith('/')) return noContent;
  /* 只留路径里有意义的字符：这一段会原样进报表页，
     而 body.p 是客户端随便填的 —— `/<img src=x onerror=...>` 也以 / 开头。
     存的时候就洗掉，比指望渲染层每次都记得转义可靠。 */
  path = path
    .split('?')[0]
    .replace(/[^\w\-./~%\u4e00-\u9fa5]/g, '')
    .slice(0, 180);
  // 后台自己的页面不进统计，否则「今日浏览」里一半是我自己在看后台
  if (/^\/(editor|admin|login|auth)(\/|$)/.test(path)) return noContent;

  const origin = new URL(request.url).host;
  const ref = refHost(body?.r, origin);
  const day = dayCN();
  const kind = deviceOf(ua);

  const job = (async () => {
    try {
      const ip = await ipTag(env, request);
      // 同一人同一天把同一页刷新十次，只算一次 —— 这个站的量本来就小，
      // 一次刷新记一条，曲线会变成「我按了多少次 F5」。
      const seen = await env.DB.prepare('SELECT 1 AS x FROM pv WHERE day = ? AND ip = ? AND path = ? LIMIT 1')
        .bind(day, ip, path)
        .first();
      if (seen) return;
      await env.DB.prepare('INSERT INTO pv (day, path, ref, ip, kind, ts) VALUES (?,?,?,?,?,?)')
        .bind(day, path, ref, ip, kind, new Date().toISOString())
        .run();
    } catch (e) {
      // 统计失败绝不影响访客：表没建、配额打满都只是少一条记录
      console.error('pv', e?.message || e);
    }
  })();

  // 有 waitUntil 就交给它，响应立刻返回；没有就等它跑完再返回
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  else await job;

  return noContent;
}

/* ---------- 报表 ---------- */

const kvRow = (label, value, sub = '') =>
  `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v">${value}</div>${
    sub ? `<div class="kpi-s">${sub}</div>` : ''
  }</div>`;

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.pv));
  return rows
    .slice()
    .reverse()
    .map((r) => {
      const h = Math.max(2, Math.round((r.pv / max) * 100));
      return `<div class="bar" title="${r.day} · ${r.pv} 次 · ${r.uv} 人">
        <div class="bar-f" style="height:${h}%"></div>
        <div class="bar-d">${r.day.slice(5)}</div>
      </div>`;
    })
    .join('');
}

function table(head, rows) {
  if (!rows.length) return '<p class="empty">还没有数据</p>';
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

export async function statsPage(env, request) {
  const { user, res } = await requireAdmin(env, request);
  if (res) return res;

  const db = env.DB;
  const d1 = dayCN();
  const d7 = dayCN(6);
  const d30 = dayCN(29);
  const d14 = dayCN(13);

  const q = (sql, ...args) => db.prepare(sql).bind(...args).all();
  const one = (sql, ...args) => db.prepare(sql).bind(...args).first();

  const [t1, t7, t30, daily, top, refs, kinds, total] = await Promise.all([
    one('SELECT COUNT(*) pv, COUNT(DISTINCT ip) uv FROM pv WHERE day = ?', d1),
    one('SELECT COUNT(*) pv, COUNT(DISTINCT ip) uv FROM pv WHERE day >= ?', d7),
    one('SELECT COUNT(*) pv, COUNT(DISTINCT ip) uv FROM pv WHERE day >= ?', d30),
    q(
      `SELECT day, COUNT(*) pv, COUNT(DISTINCT ip) uv FROM pv WHERE day >= ? GROUP BY day ORDER BY day DESC`,
      d14
    ),
    q('SELECT path, COUNT(*) c FROM pv WHERE day >= ? GROUP BY path ORDER BY c DESC LIMIT 12', d7),
    q(
      `SELECT ref, COUNT(*) c FROM pv WHERE day >= ? AND ref != '' GROUP BY ref ORDER BY c DESC LIMIT 8`,
      d7
    ),
    q('SELECT kind, COUNT(*) c FROM pv WHERE day >= ? GROUP BY kind ORDER BY c DESC', d7),
    one('SELECT COUNT(*) c, MIN(day) first FROM pv'),
  ]);

  return html(renderStats({ user, t1, t7, t30, dailyRows: daily.results || [], top, refs, kinds, total }), 200, {
    'cache-control': 'no-store',
  });
}

/** 纯渲染：只吃数据、不碰数据库。单测喂假数据就能验这一页没写错。 */
export function renderStats({ user, t1, t7, t30, dailyRows = [], top, refs, kinds, total }) {
  const sum = (r) => r?.pv ?? 0;
  const uv = (r) => r?.uv ?? 0;

  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问统计 · ${user.login}</title>
<meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/style.css">
<style>
.wrap-s{max-width:900px;margin:0 auto;padding:34px 22px 70px}
h1{font-family:var(--serif);font-size:24px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 26px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:26px}
.kpi{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--card)}
.kpi-l{font-size:12px;color:var(--muted);letter-spacing:.04em}
.kpi-v{font-family:var(--mono);font-size:26px;font-weight:600;margin:6px 0 2px;letter-spacing:-.02em}
.kpi-s{font-size:12px;color:var(--muted)}
.chart{display:flex;align-items:flex-end;gap:6px;height:130px;border-bottom:1px solid var(--line);padding-bottom:0;margin-bottom:6px}
.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
.bar-f{width:100%;border-radius:4px 4px 0 0;background:color-mix(in srgb,var(--accent) 55%,transparent);min-height:2px;transition:background .16s}
.bar:hover .bar-f{background:var(--accent)}
.bar-d{font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:5px;white-space:nowrap}
section{margin:30px 0}
h2{font-family:var(--serif);font-size:16px;margin:0 0 10px;color:var(--fg)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:0 8px 6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 8px 7px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);text-align:left}
td:last-child,th:last-child{text-align:right;padding-right:0}
td.p{font-family:var(--mono);font-size:12.5px;word-break:break-all}
.empty{color:var(--muted);font-size:13px}
.note{color:var(--muted);font-size:12px;line-height:1.7;margin-top:34px;border-top:1px solid var(--line);padding-top:14px}
@media (max-width:560px){.kpis{grid-template-columns:1fr}.kpi-v{font-size:22px}}
</style></head>
<body class="stat-page"><main class="wrap-s">
<h1>访问统计</h1>
<p class="sub">按北京时间切日 · 同一人同一天同一页只记一次 · 累计 ${total?.c || 0} 条，起于 ${total?.first || '—'}</p>

<div class="kpis">
  ${kvRow('今天', sum(t1), `独立访客 ${uv(t1)}`)}
  ${kvRow('近 7 天', sum(t7), `独立访客 ${uv(t7)}`)}
  ${kvRow('近 30 天', sum(t30), `独立访客 ${uv(t30)}`)}
</div>

<section>
  <h2>近 14 天</h2>
  ${dailyRows.length ? `<div class="chart">${bars(dailyRows)}</div>` : '<p class="empty">还没有数据</p>'}
</section>

<section>
  <h2>看的人最多的页面（近 7 天）</h2>
  ${table(
    ['路径', '浏览'],
    (top.results || []).map((r) => [
      `<td class="p"><a href="${esc(r.path)}" style="color:inherit;text-decoration:none;border-bottom:1px solid var(--line)">${esc(r.path)}</a></td>`,
      `<td>${r.c}</td>`,
    ])
  )}
</section>

<section>
  <h2>从哪里来（近 7 天）</h2>
  ${table(
    ['来源', '次数'],
    (refs.results || []).map((r) => [`<td class="p">${esc(r.ref)}</td>`, `<td>${r.c}</td>`])
  )}
</section>

<section>
  <h2>设备</h2>
  ${table(
    ['类型', '次数'],
    (kinds.results || []).map((r) => [`<td>${r.kind}</td>`, `<td>${r.c}</td>`])
  )}
</section>

<p class="note">IP 不落库，只存一份加盐摘要用于去重；不写 cookie，不跨站追踪，DNT/GPC 打开的访客完全不记。
数据保留 90 天，由定时任务清理。</p>
</main></body></html>`;

  return body;
}

/** 定时清理：90 天前的明细没有查询价值，留着只会让 D1 一天天长胖 */
export async function prunePv(env) {
  const cut = dayCN(90);
  try {
    await env.DB.prepare('DELETE FROM pv WHERE day < ?').bind(cut).run();
  } catch (e) {
    console.error('prune pv', e?.message || e);
  }
}
