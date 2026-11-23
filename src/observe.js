// 请求级结构化日志与已知边界告警。
//
// 先说拿不到的字段，别编：Workers 运行时没有 per-request cpuMs / subrequest 计数的 API
// （CPU 只在 Dashboard 按区间给，subrequest 50 是累计计数、函数内读不到实时值）。
// 所以这里只写真实可得的：墙钟耗时、状态、路径、缓存状态、CF Ray、国家。
// cpuMs / subrequests 留 null 并注明来源，让日志消费者知道是「不可得」而不是「等于 0」。
//
// 落点选 console 结构化行，不写 D1：站点 10 万次/天量级，每请求一条 D1 写会直接吃掉
// 免费写入配额，而 wrangler.jsonc 已开 observability，Tail/Logs 自带检索与 7 天留存。
// 告警也走 console.warn（同源不同级），tail 里一个 grep 就能过滤。

export const BUDGETS = Object.freeze({
  warnDurationMs: 300, // 单请求墙钟；超过就是用户能感觉到的慢
  criticalDurationMs: 1000,
});

/** 从响应头里取缓存状态：CF 边缘的 cf-cache-status 优先，其次是 Worker 自己打的 edge hit 标记 */
export function cacheStatusOf(headers) {
  if (!headers) return '-';
  return headers.get('cf-cache-status') || headers.get('x-edge-cache') || '-';
}

/**
 * 组装一条请求日志。纯函数，方便单测；调用方负责 JSON.stringify + console。
 * @param {object} p
 * @param {Request} p.request
 * @param {Response} p.response
 * @param {number} p.durationMs
 * @param {string} [p.cacheStatus]
 */
export function requestLog({ request, response, durationMs, cacheStatus }) {
  const url = new URL(request.url);
  const cf = request.cf || {};
  return {
    t: new Date().toISOString(),
    m: request.method,
    p: url.pathname,
    s: response?.status ?? 0,
    dms: Math.round(durationMs),
    cache: cacheStatus || cacheStatusOf(response?.headers),
    ray: cf.ray || '-',
    country: cf.country || '-',
    // 不可得，显式标 null；有朝一日运行时给了 API，再填真实值并删掉这条注释
    cpuMs: null,
    subrequests: null,
  };
}

/** 只报已知边界，不报「看着有点慢」的主观判断 */
export function alertsOf(log) {
  const out = [];
  if (log.dms > BUDGETS.criticalDurationMs) out.push(`duration_p95_bound ${log.dms}ms > ${BUDGETS.criticalDurationMs}ms`);
  else if (log.dms > BUDGETS.warnDurationMs) out.push(`duration_warn ${log.dms}ms > ${BUDGETS.warnDurationMs}ms`);
  return out;
}

/** 打日志；慢请求额外一行 warn，便于 tail -f | grep ALERT */
export function emit(log) {
  console.log(JSON.stringify(log));
  for (const a of alertsOf(log)) console.warn(JSON.stringify({ ALERT: a, ...log }));
}
