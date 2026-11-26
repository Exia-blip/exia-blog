import { nowISO } from './utils.js';
import { notifyForComment, notifyTodo } from './webhook.js';
import { liveSql } from './api.js';
import { logAudit } from './audit.js';
import { spamScore, SPAM_MIN_SCORE } from './spam.js';

/* 自站存活断言：不 fetch 自己域名 —— 文件头第 4 条实测过会绕回本 Worker 拿 522。
   改成直接查 D1：能查出「公开文章存在 + 关键字可命中」就等于首页/文章页的数据源活着。
   这是数据层存活，不等于 HTTP 层 200；HTTP 层的 522/530 由 CF 边缘自己报，
   这里不重复造一个会自环的探测器。
   关键字取一个必定存在的：站点名 SITE_NAME 或固定词，查不到就报，不猜。 */
export async function checkSelfHealth(env) {
  const where = `is_private = 0 AND hidden = 0 AND ${liveSql('posts')}`;
  const [total, sample] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${where}`).first(),
    env.DB.prepare(`SELECT slug FROM posts WHERE ${where} ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1`).first(),
  ]);
  return { live: Number(total?.n || 0), latest: sample?.slug || '', ok: Number(total?.n || 0) > 0 && !!sample?.slug };
}

/* 友链存活检测：每 20 分钟一轮（wrangler.jsonc 的 triggers.crons）。

   几条硬约束决定了这个文件的形状，都是实测出来的，别随手改：
   1. 单次 invocation 的 fetch 上限 50（免费计划）。计数是累计的，包括本函数之前发过的请求。
      所以一次最多跑 40 条，留余量。
   2. 超 40 条怎么办：不存游标，按 checked_at 升序取最旧的 40 条 —— 每轮自动轮转，
      跑完的排到队尾，下一次自然接上。加游标就多一次读写，还会在并发触发时错位。
   3. 只要拿到响应头就算活着，4xx/5xx 单独记成 2（有响应但状态异常，多半是 WAF 或维护）。
      实测 npmjs / kernel.org / go.dev 对爬虫 UA 直接回 403 —— 把 403 当"挂"会误杀半个友链圈。
   4. 自己 zone 的域名不能在这里 fetch：请求会绕回本 Worker，实测 522（37ms）。
      友链里出现本站地址的，直接跳过。
*/
const TIMEOUT_MS = 8000;
const PER_RUN = 40;
const CONCURRENCY = 10;
const MAX_REDIRECTS = 5;

/* UA 与自环宿主都从 env.SITE_ORIGIN 派生 —— 换域名只改 wrangler.jsonc 一处。
   旧域名留作兜底不是为了兼容，是因为它们是历史部署地址：屏蔽它们没有副作用，
   但少屏蔽一个就可能让友链里的自己把自己探测一遍（实测 522）。
   SITE_ORIGIN 缺失或配错时退回默认，不让整个友链巡检挂掉。 */
const DEFAULT_ORIGIN = 'https://miu.sryze.cc';
/* 旧主域和历史部署地址留作自环屏蔽：换域后它们仍绑着同一个 Worker，
   漏屏蔽一个就可能让友链巡检把「自己的旧地址」当成外部站探测一遍（实测 522）。 */
const LEGACY_SELF_HOSTS = ['exia.de5.net', 'www.exia.de5.net', 'miu.sryze.cc', 'www.miu.sryze.cc', 'exia-blog.meitu.workers.dev'];

function originOf(env) {
  try {
    const raw = String(env?.SITE_ORIGIN || '').trim();
    return raw ? new URL(raw).origin : DEFAULT_ORIGIN;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

function uaOf(env) {
  return `Mozilla/5.0 (compatible; BlogFriendCheck/1.0; +${originOf(env)}/friends)`;
}

function selfHostsOf(env) {
  const set = new Set(LEGACY_SELF_HOSTS);
  try {
    const raw = String(env?.SITE_ORIGIN || '').trim();
    if (raw) {
      const host = new URL(raw).hostname;
      set.add(host);
      set.add(`www.${host}`);
    }
  } catch { /* 配错就只用历史集合，不影响巡检本身 */ }
  return set;
}

/* 友链 URL 由管理员写入，但不该让 Worker 去打内网 / 回环 / 云元数据地址。
   redirect:'follow' 会跟着 302 跳进内网（外部友链 → 内网），所以不能只校验
   原始 URL —— 改成手动跟随，每一跳都过这个闸门。
   只按 hostname 的字面量判断：Workers 没有 DNS 预解析 API，域名 A 记录指向
   内网（DNS rebinding）挡不住；但触发前提是管理员，且响应体不回显（盲 SSRF），
   所以字面量闸门 + 逐跳校验已把可利用面压到最低。导出供单测穷举。 */
const PRIVATE_V4 = [
  /^127\./,          // 回环 127.0.0.0/8
  /^10\./,           // 私有 10/8
  /^192\.168\./,     // 私有 192.168/16
  /^172\.(1[6-9]|2\d|3[01])\./, // 私有 172.16/12
  /^169\.254\./,     // 链路本地 + 云元数据 169.254.169.254
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^0\./,            // 「本网络」0.0.0.0/8
  /^192\.0\.0\./, /^198\.(18|19)\./, /^203\.0\.113\./, // 文档保留段
];

export function isBlockedHost(rawHost) {
  let h = String(rawHost || '').trim().toLowerCase();
  // URL.hostname 对 IPv6 带方括号，如 [::1]；FQDN 可能带尾点
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv4-mapped IPv6（::ffff:127.0.0.1）剥掉前缀再按 IPv4 判
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) h = mapped[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.some((re) => re.test(h));
  // IPv6 回环 / 未指定 / 唯一本地 fc00::/7 / 链路本地 fe80::/10
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]/.test(h) || /^fe[89ab][0-9a-f]/.test(h)) return true;
  return false;
}

/* 把 URL 规范化并做首跳校验；返回 target 或拒绝原因。
   selfHosts 由调用方从 env 派生传入，纯函数不读全局，单测可直接穷举。 */
function resolveTarget(raw, selfHosts) {
  const s = String(raw || '').trim();
  if (!s) return { note: 'bad-url' };
  const target = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u;
  try {
    u = new URL(target);
  } catch {
    return { note: 'bad-url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { note: 'bad-url' };
  const host = u.hostname;
  if ((selfHosts || new Set(LEGACY_SELF_HOSTS)).has(host)) return { note: 'self' };
  if (isBlockedHost(host)) return { note: 'blocked-host' };
  return { target };
}

/* 0 挂 / 1 正常 / 2 有响应但状态异常 */
async function probe(url, selfHosts, ua) {
  const first = resolveTarget(url, selfHosts);
  if (first.note === 'self') return { status: 1, code: 0, ms: 0, note: 'self' };
  if (first.note) return { status: 0, code: 0, ms: 0, note: first.note };

  let target = first.target;
  const t0 = Date.now();
  // 全程一个 deadline：逐跳共享，不让 5 次跳转把 8s Timeout 放大成 40s。
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(target, {
        method: 'GET',
        redirect: 'manual', // 自行跟随，每跳都能校验目标
        headers: { 'user-agent': ua, accept: 'text/html,*/*' },
        signal,
      });
      const ms = Date.now() - t0;
      // 只要响应头，正文不要：cloudflare.com 首页 1.3MB，拉完纯属浪费出口流量。
      // cancel 不能让这条 subrequest 少算一次，但能省传输。
      if (res.body) await res.body.cancel().catch(() => {});

      const code = res.status;
      const isRedirect = code >= 300 && code < 400;
      if (!isRedirect) return { status: code >= 200 && code < 400 ? 1 : 2, code, ms };

      if (hop === MAX_REDIRECTS) return { status: 2, code, ms, note: 'too-many-redirects' };
      const loc = res.headers.get('location');
      if (!loc) return { status: 2, code, ms, note: 'redirect-no-location' };
      const next = resolveTarget(new URL(loc, target).toString(), selfHosts);
      if (next.note) return { status: 2, code, ms, note: `redirect-${next.note}` };
      target = next.target;
    }
  } catch (e) {
    // TimeoutError / TypeError: fetch failed —— 网络层没通，才算挂
    return { status: 0, code: 0, ms: Date.now() - t0, note: e.name };
  }
  return { status: 2, code: 0, ms: Date.now() - t0, note: 'unreachable' };
}

export async function checkFriends(env) {
  /* 每轮现算一次：既不碰模块级可变状态（多 isolate  interleaving 会串），
     也不把域名写死在函数里。换域名配了 SITE_ORIGIN 就自动生效。 */
  const selfHosts = selfHostsOf(env);
  const ua = uaOf(env);
  const { results } = await env.DB.prepare(
    `SELECT id, url, status FROM friends
     ORDER BY COALESCE(NULLIF(checked_at, ''), '') ASC, id ASC
     LIMIT ?`
  )
    .bind(PER_RUN)
    .all();
  if (!results || !results.length) return { checked: 0 };

  const stamp = nowISO();
  let done = 0;

  // 每批 10 个并发：同样 10 个站点，串行 2026ms，并发 332ms（实测）
  for (let i = 0; i < results.length; i += CONCURRENCY) {
    const batch = results.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(
      batch.map(async (f) => ({ id: f.id, url: f.url, was: f.status, ...(await probe(f.url, selfHosts, ua)) }))
    );

    // batch() 是单次往返写多条，比逐条 run() 省 N-1 次 D1 调用
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare(
          'UPDATE friends SET status = ?, http_status = ?, latency_ms = ?, checked_at = ? WHERE id = ?'
        ).bind(r.status, r.code, r.ms, stamp, r.id)
      )
    );
    // 只在「原本在线 → 这轮挂了」时提醒；一直挂的不重复推送，免得每 20 分钟刷屏
    const down = rows.filter((r) => r.was === 1 && r.status !== 1);
    if (down.length) {
      const lines = down.map((r) => `#${r.id} ${r.url} (HTTP ${r.code || r.note || '-'})`).join('\n');
      await notifyTodo(env, `友链探测失败 ${down.length} 条：\n${lines}\n后台 /admin/friends`);
    }
    done += rows.length;
  }

  return { checked: done };
}

/* ---------------- 评论巡检：补推 + 清垃圾 ----------------
   每 20 分钟一轮（与友链巡检同一个 cron）。两件事：

   ① 补推：发评论时那一次投递没成功（notify_status 为空 = 没尝试过 / 'fail' = 平台拒了），
      这里按冷却补一次。冷却写在 SQL 里而不是内存里 —— Worker 每次冷启都是新进程，
      内存计数等于没有。created_at 只回看 6 小时：一天的失败堆积不该在三天后突然炸进群。
      不带 notified_at 的行（0006 之前的老数据）也会被补，但同样受 6 小时窗限制，
      老评论不会被突然翻出来推送 —— 那才叫「半夜群里跳出一条两年前的评论」。

   ② 清垃圾：只删「机械可判定」的形状（见 spam.js 的每条规则与权重）。
      四条免检线写在代码里，不靠 SQL：管理员自己发的、已拒绝的、有回复的、分数不够的。
      前三条任意一条成立就不删 —— 删父评论会连坐子回复（见 /api 的 DELETE 分支）。

   动作都进 audit_log：自动删除必须留下「为什么删」的字符串，否则第二次误删时
   没人敢再开这个定时任务。 */
export async function sweepComments(env, { dry = false, limit = 20 } = {}) {
  const out = { retried: [], deleted: [], kept: 0, skipped: '', dry: !!dry, exempt: 0 };

  /* ---- ① 补推 ---- */
  if (!env.WEBHOOK_URL) {
    out.skipped = 'no-webhook';
  } else {
    const { results = [] } = await env.DB.prepare(
      `SELECT c.id, c.name, c.content, c.status, c.notify_status, c.notified_at, p.slug, p.title
         FROM comments c LEFT JOIN posts p ON p.id = c.post_id
        WHERE c.is_admin = 0
          AND c.notify_status IN ('', 'fail')
          AND c.created_at <= datetime('now','-2 minutes')
          AND c.created_at >= datetime('now','-6 hours')
          AND (c.notified_at IS NULL OR c.notified_at = '' OR c.notified_at <= datetime('now','-1 hour'))
        ORDER BY c.id
        LIMIT 10`
    ).all();

    const origin = originOf(env);
    for (const row of results) {
      if (!row.title) {
        if (!dry) {
          await env.DB.prepare("UPDATE comments SET notify_status='fail', notify_note='原文已删，无法补推' WHERE id=?")
            .bind(row.id)
            .run();
        }
        out.retried.push({ id: row.id, status: 'fail', note: '原文已删' });
        continue;
      }
      if (dry) {
        out.retried.push({ id: row.id, status: `dry:${row.notify_status || 'none'}` });
        continue;
      }
      const r = await notifyForComment(env, {
        status: row.status,
        postTitle: row.title,
        postUrl: `${origin}/p/${row.slug}`,
        adminUrl: `${origin}/admin/comments`,
        name: row.name,
        content: row.content,
      });
      await env.DB.prepare('UPDATE comments SET notify_status=?, notify_note=?, notified_at=? WHERE id=?')
        .bind(r.status, `${r.note ? `补推 · ${r.note}` : '补推'}`.slice(0, 120), nowISO(), row.id)
        .run();
      out.retried.push({ id: row.id, status: r.status, note: r.note || '' });
    }
  }

  /* ---- ② 清垃圾 ---- */
  const { results = [] } = await env.DB.prepare(
    `SELECT c.id, c.name, c.content, c.is_admin, c.status,
            (SELECT COUNT(*) FROM comments k WHERE k.parent_id = c.id) AS kids
       FROM comments c
      WHERE c.status IN ('approved','pending')
      ORDER BY c.id DESC
      LIMIT 200`
  ).all();

  for (const row of results) {
    /* 三条免检线在 JS 里再过一次，不只依赖 SQL 的 WHERE：
       SQL 条件被谁改松了、或者将来换查询，这里仍然拦得住 —— 而且这样
       「管理员的不删」是能被单元测试直接观测的行为，不是一句注释。 */
    if (!['approved', 'pending'].includes(String(row.status))) { out.exempt++; continue; }
    if (Number(row.is_admin) === 1) { out.exempt++; continue; } // 自己发的永不动
    if (Number(row.kids) > 0) { out.exempt++; continue; } // 删父会连坐子回复
    const { score, reasons } = spamScore(row);
    if (score < SPAM_MIN_SCORE) {
      out.kept++;
      continue;
    }
    if (out.deleted.length >= limit) break;
    if (!dry) {
      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(row.id).run();
      await logAudit(env, null, 'comment.spam.purge', 'comment', String(row.id),
        `score=${score} ${reasons.join(',')} name=${String(row.name).slice(0, 30)} text=${String(row.content).slice(0, 120)}`);
    }
    out.deleted.push({ id: row.id, score, reasons, name: row.name, dry });
  }

  return out;
}
