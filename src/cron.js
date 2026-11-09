import { nowISO } from './utils.js';

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
const UA = 'Mozilla/5.0 (compatible; BlogFriendCheck/1.0; +https://exia.de5.net/friends)';
const TIMEOUT_MS = 8000;
const PER_RUN = 40;
const CONCURRENCY = 10;
const SELF_HOSTS = new Set(['exia.de5.net', 'www.exia.de5.net', 'exia-blog.meitu.workers.dev']);

/* 0 挂 / 1 正常 / 2 有响应但状态异常 */
async function probe(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  try {
    if (SELF_HOSTS.has(new URL(target).hostname)) return { status: 1, code: 0, ms: 0, note: 'self' };
  } catch {
    return { status: 0, code: 0, ms: 0, note: 'bad-url' };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    const code = res.status;
    // 只要响应头，正文不要：cloudflare.com 首页 1.3MB，拉完纯属浪费出口流量。
    // cancel 不能让这条 subrequest 少算一次，但能省传输。
    if (res.body) await res.body.cancel().catch(() => {});
    return { status: code >= 200 && code < 400 ? 1 : 2, code, ms };
  } catch (e) {
    // TimeoutError / TypeError: fetch failed —— 网络层没通，才算挂
    return { status: 0, code: 0, ms: Date.now() - t0, note: e.name };
  }
}

export async function checkFriends(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, url FROM friends
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
    const rows = await Promise.all(batch.map(async (f) => ({ id: f.id, ...(await probe(f.url)) })));

    // batch() 是单次往返写多条，比逐条 run() 省 N-1 次 D1 调用
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare(
          'UPDATE friends SET status = ?, http_status = ?, latency_ms = ?, checked_at = ? WHERE id = ?'
        ).bind(r.status, r.code, r.ms, stamp, r.id)
      )
    );
    done += rows.length;
  }

  return { checked: done };
}
