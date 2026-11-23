// 访问统计：自己记一笔，不引第三方。
//
// 为什么不是 umami：umami 要一台常驻 Node 主机 + Postgres，为了一个「今天几个人来过」
// 多出两台机器的运维和一条跨域脚本请求，和「轻量、不拖性能」正好相反。
// 这里用已有的 D1 记最小集（哪天、哪个路径、哪来的、什么端），
// 上报走 sendBeacon 在 load 之后发，正文渲染一个字节都不等它。
//
// 想换成 umami / 其他服务也行：把 UMAMI_SCRIPT、UMAMI_SITE_ID 两个变量写上，
// 页面会注入那段 script，同时不再往这里记 —— 两套同时开着只会让数字互相矛盾。

import { html, umamiOn, readJsonLimited, clientIp } from './utils.js';
import { requireAdmin } from './auth.js';
import { postCacheStats } from './postcache.js';
import { getSite } from './settings.js';
import { renderAdminNav, themeBoot } from './admin-ui.js';
import { avatarSrc } from '../public/avatar.js';

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
  /* 只认 cf-connecting-ip（P-033）。原来还有一条 x-forwarded-for 回退 ——
     那是客户端可控头，伪造它就能把同一个访客拆成无数个，UV 立刻虚高。
     线上拿不到 cf-connecting-ip 的情形不存在（CF 边缘必注入），回退是纯死代码。 */
  const ip = clientIp(request);
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

  /* 切到 umami 之后，服务端这一侧也要停。
     只在页面里写 __PV_OFF__ 是不够的：boot.js 是长缓存资源，已经加载过它的浏览器
     在缓存过期前还会继续往这里打；改回自建、或有人手工 POST，同样会写进去。
     结果就是「你以为已经切走了，D1 里却每天都在涨」——两份数据都不可信。
     所以在这里挡一道：配齐了外部统计，这条路直接 204，连库都不碰。 */
  if (umamiOn(env)) return noContent;

  if (!ua || BOT_RE.test(ua)) return noContent;

  /* 上报口是匿名的，同样吃 readJsonLimited：一个谎报 content-length 的
     大包不能在这里被 whole-body 解析。超限当没收，静默 204。 */
  const rd = await readJsonLimited(request);
  if (!rd.body) return noContent;
  const body = rd.body;

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

/* ---------- 行为事件 ----------
   三个事件：read（文章读到末尾）、img-error（正文图加载失败）、search（站内搜索）。

   为什么不复用 pv 表：去重键不一样。pv 是「一人一天一页一条」，
   而一个人可能一天内在同一页遇到三张图失败、搜五个词 —— 挤进 pv 会让
   「今日浏览」被这些噪声撑大，两边数字都不能用了。

   和 pv 一样，切到 umami 之后这条路整体关闭。 */
export const EVENT_NAMES = new Set(['read', 'img-error', 'search']);

/* 事件参数是客户端随便填的，跟 pv 的 path 一样必须先洗再存。
   img-error 的 extra 是图片地址：只收站内路径。别家的 URL 一律丢 ——
   否则这里就是个「任何人都能往我的库表里塞任意 URL」的免费存储。 */
function cleanExtra(name, raw) {
  const s = String(raw || '');
  if (name === 'img-error') {
    if (!s.startsWith('/')) return '';
    return s.split('?')[0].replace(/[^\w\-./~%\u4e00-\u9fa5]/g, '').slice(0, 160);
  }
  if (name === 'search') {
    /* 搜索词本身有分析价值（访客想找什么），但会带引号、换行甚至 HTML，
       这些进报表页就是一次注入。只留可读字符。 */
    return s.replace(/[\u0000-\u001f\u007f"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  return ''; // read 不带参数
}

export async function recordEvent(env, request, ctx) {
  const ua = request.headers.get('user-agent') || '';
  const noContent = new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

  if (umamiOn(env)) return noContent;
  if (!ua || BOT_RE.test(ua)) return noContent;

  /* 上报口是匿名的，同样吃 readJsonLimited：一个谎报 content-length 的
     大包不能在这里被 whole-body 解析。超限当没收，静默 204。 */
  const rd = await readJsonLimited(request);
  if (!rd.body) return noContent;
  const body = rd.body;

  const name = String(body?.n || '');
  if (!EVENT_NAMES.has(name)) return noContent;

  const path = String(body?.p || '')
    .split('?')[0]
    .replace(/[^\w\-./~%\u4e00-\u9fa5]/g, '')
    .slice(0, 180);
  if (!path.startsWith('/')) return noContent;
  if (/^\/(editor|admin|login|auth)(\/|$)/.test(path)) return noContent;

  const extra = cleanExtra(name, body?.x);
  // img-error 没带图地址就没意义，别记一堆空行
  if (name === 'img-error' && !extra) return noContent;

  const day = dayCN();
  const job = (async () => {
    try {
      const ip = await ipTag(env, request);
      /* 同一个人同一天、同一页、同一件事只记一次。刷新十次不该变成十次
         「读完」，那只会让完成率虚高到 100%。 */
      const seen = await env.DB.prepare(
        'SELECT 1 AS x FROM events WHERE day = ? AND ip = ? AND name = ? AND path = ? AND extra = ? LIMIT 1'
      )
        .bind(day, ip, name, path, extra)
        .first();
      if (seen) return;
      await env.DB.prepare('INSERT INTO events (day, name, path, extra, ip, ts) VALUES (?,?,?,?,?,?)')
        .bind(day, name, path, extra, ip, new Date().toISOString())
        .run();
    } catch (e) {
      // 表没建、配额打满都只是少一条记录，绝不能让访客看到错误
      console.error('event', e?.message || e);
    }
  })();

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
  if (!rows.length) return '<p class="empty">还没有记录，有访客访问后会显示在这里</p>';
  // rows 里每一格已经是完整的 <td>…</td>，这里只负责拼行 ——
  // 再包一层 <td> 会被浏览器拆成两列，表格看着错位却很难一眼看出原因
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.join('')}</tr>`)
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

  // 进程内文章缓存的自检数字：这个实例自己的，不跨实例
  const pc = postCacheStats();

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

  /* 事件表可能还没建（迁移没跑过）。查不到就当空 —— 一个报表页不该
     因为「少一张新表」整个 500，那样连旧数据都看不成了。 */
  const evq = async (sql, ...args) => {
    try {
      return (await db.prepare(sql).bind(...args).all()).results || [];
    } catch (e) {
      console.error('events', e?.message || e);
      return [];
    }
  };
  const [evCounts, evImgs, evWords, evViews] = await Promise.all([
    evq('SELECT name, COUNT(*) c FROM events WHERE day >= ? GROUP BY name', d7),
    evq(
      "SELECT extra, COUNT(*) c FROM events WHERE name = 'img-error' AND day >= ? GROUP BY extra ORDER BY c DESC LIMIT 8",
      d7
    ),
    evq(
      "SELECT extra, COUNT(*) c FROM events WHERE name = 'search' AND extra != '' AND day >= ? GROUP BY extra ORDER BY c DESC LIMIT 10",
      d7
    ),
    // 完成率的分母：近 7 天文章页的浏览数。用 pv 不用 read —— 分子是事件、分母是浏览，才是「看完的比例」
    one("SELECT COUNT(*) c FROM pv WHERE day >= ? AND path LIKE '/p/%'", d7)
      .then((r) => r?.c || 0)
      .catch(() => 0),
  ]);

  const site = await getSite(env);
  return html(
    renderStats({
      user,
      site,
      t1,
      t7,
      t30,
      dailyRows: daily.results || [],
      top,
      refs,
      kinds,
      total,
      ev: { counts: evCounts, imgs: evImgs, words: evWords, views: evViews },
      pc,
    }),
    200,
    { 'cache-control': 'no-store' }
  );
}

/** 纯渲染：只吃数据、不碰数据库。单测喂假数据就能验这一页没写错。 */
export function renderStats({ user, site = {}, t1, t7, t30, dailyRows = [], top, refs, kinds, total, ev = {}, pc = {} }) {
  const sum = (r) => r?.pv ?? 0;
  const uv = (r) => r?.uv ?? 0;

  const evOf = (n) => (ev.counts || []).find((r) => r.name === n)?.c || 0;
  // 缓存计数默认给 0：单测不喂这一块时不该出现 undefined
  const cacheHit = pc.hit || 0;
  const cacheMiss = pc.miss || 0;
  const cacheSize = pc.size || 0;
  const views = ev.views || 0;
  const readN = evOf('read');
  // 分母为 0 时不要算出 0%：那是「没数据」，不是「没人读完」
  const readRate = views ? Math.round((readN / views) * 100) : 0;

  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问统计 · ${user.login}</title>
<meta name="robots" content="noindex,nofollow">
${themeBoot(site)}
<link rel="stylesheet" href="/style.css">
<style>
.wrap-s{max-width:900px;margin:0 auto;padding:34px 22px 70px}
h1{font-family:var(--sans);font-size:24px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 26px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:26px}
.kpi{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--card)}
.kpi-l{font-size:12px;color:var(--muted);letter-spacing:.04em}
.kpi-v{font-family:var(--mono);font-size:26px;font-weight:600;margin:6px 0 2px;letter-spacing:-.02em}
.kpi-s{font-size:12px;color:var(--muted)}
.chart{display:flex;align-items:flex-end;gap:6px;height:130px;border-bottom:1px solid var(--line);padding-bottom:0;margin-bottom:6px}
/* 只有一两天数据时，flex:1 会把那根柱拉成一整块色块。
   给每根一个上限，柱子少的时候就是几根细柱，靠左排。 */
.bar{flex:0 1 62px;min-width:8px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
.bar-f{width:100%;border-radius:4px 4px 0 0;background:color-mix(in srgb,var(--accent) 55%,transparent);min-height:2px;transition:background .16s}
.bar:hover .bar-f{background:var(--accent)}
.bar-d{font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:5px;white-space:nowrap}
section{margin:30px 0}
h2{font-family:var(--sans);font-size:16px;margin:0 0 10px;color:var(--fg)}
h3{font-size:13px;font-weight:500;color:var(--muted);margin:18px 0 8px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:0 8px 6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 8px 7px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);text-align:left}
td:last-child,th:last-child{text-align:right;padding-right:0}
/* 统计表格斑马纹 + hover：只对数据行 tr 生效，表头 th 不参与；空态是 <p> 无 tr 自然无样式。
   用 --bg-soft 派生低透明度底色，亮/暗主题自动适配，不加新色板。 */
tbody tr:nth-child(even){background:color-mix(in srgb,var(--bg-soft) 55%,transparent)}
tbody tr:hover{background:var(--bg-soft)}
td.p,td.mono{font-family:var(--mono);font-size:12.5px;word-break:break-all}
/* 必须显式覆盖前台 style.css 的 .empty{text-align:center;padding:60px 20px} ——
   后台页也 link 了那份样式表，空状态不压住的话会被居中、上下空出 60px，
   悬在左对齐的 <h2> 下面像错位。 */
.empty{color:var(--muted);font-size:13px;text-align:left;padding:6px 2px}
.note{color:var(--muted);font-size:12px;line-height:1.7;margin-top:34px;border-top:1px solid var(--line);padding-top:14px}
@media (max-width:560px){.kpis{grid-template-columns:1fr}.kpi-v{font-size:22px}}
</style></head>
<body class="stat-page">
<div class="admin-shell">
  <aside class="admin-rail">
    <div class="admin-rail-top">
      <a class="admin-brand" href="/" title="返回站点">
        ${site.avatar ? `<img class="admin-ava" src="${esc(avatarSrc(site.avatar, 96))}" alt="" width="48" height="48">` : ''}
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
      ${renderAdminNav('stats')}
    </div>
  </aside>
  <main class="admin-main">
    <header class="admin-head">
      <h1>访问统计</h1>
      <p>按北京时间切日 · 同一人同一天同一页只记一次 · 累计 ${total?.c || 0} 条，起于 ${total?.first || '—'}</p>
    </header>
    <div class="wrap-s">

<div class="kpis">
  ${kvRow('今天', sum(t1), `独立访客 ${uv(t1)}`)}
  ${kvRow('近 7 天', sum(t7), `独立访客 ${uv(t7)}`)}
  ${kvRow('近 30 天', sum(t30), `独立访客 ${uv(t30)}`)}
</div>

<section>
  <h2>近 14 天</h2>
  ${dailyRows.length ? `<div class="chart">${bars(dailyRows)}</div>` : '<p class="empty">近 14 天还没有访问记录</p>'}
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

<section>
  <h2>文章热缓存（本实例）</h2>
  <p class="sub">命中 ${cacheHit} · 未命中 ${cacheMiss} · 淘汰 ${pc.evicted || 0} · 命中率 ${(
    (pc.rate || 0) * 100
  ).toFixed(0)}% · 当前存 ${cacheSize} 篇<br>
  这是处理本次请求的那个 Worker 实例的数字，不跨实例、冷启即清零，所以别当全站指标看 ——
  它的用途是判断 45 秒的 TTL 该调长还是调短。</p>
</section>

<section>
  <h2>行为事件（近 7 天）</h2>
  <p class="sub">阅读完成 ${readN} 次 · 文章浏览 ${views} 次 · 完成率 ${
    views ? readRate + '%' : '—'
  }（读完的定义：正文尾部进入视口且停留超过 15 秒）</p>
  ${
    evOf('img-error') || evOf('search')
      ? ''
      : '<p class="empty">还没有事件。这两个埋点要访客真的滚到底 / 搜一次才会出现。</p>'
  }
  ${
    (ev.imgs || []).length
      ? `<h3>加载失败的图（${evOf('img-error')} 次）</h3>` +
        table(
          ['图片', '次数'],
          ev.imgs.map((r) => [`<td class="mono">${esc(r.extra)}</td>`, `<td>${r.c}</td>`])
        )
      : ''
  }
  ${
    (ev.words || []).length
      ? `<h3>站内搜索词（${evOf('search')} 次）</h3>` +
        table(
          ['关键词', '次数'],
          ev.words.map((r) => [`<td>${esc(r.extra)}</td>`, `<td>${r.c}</td>`])
        )
      : ''
  }
</section>

<p class="note">IP 不落库，只存一份加盐摘要用于去重；不写 cookie，不跨站追踪，DNT/GPC 打开的访客完全不记。
数据保留 90 天，由定时任务清理。</p>
    </div>
  </main>
</div>
</body></html>`;

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
  /* 事件表同样的保留期。分开 try —— 表还没建时不该连带把 pv 的清理算失败 */
  try {
    await env.DB.prepare('DELETE FROM events WHERE day < ?').bind(cut).run();
  } catch (e) {
    console.error('prune events', e?.message || e);
  }
}
