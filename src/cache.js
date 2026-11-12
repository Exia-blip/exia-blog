// 边缘缓存的小封装：取、存、失效都在这里，页面侧只关心 URL。

/* HTML 的统一缓存口径：
   - 浏览器 max-age=0：每次回源校验，不会把旧页面按 zone 的 Browser Cache TTL 压 4 小时
   - 边缘 s-maxage=300：CF 与 Worker 内 caches.default 都认这个数。
     内容更新不靠等 TTL —— 发布/改文/删文都会 bustPaths 主动清，所以放宽到 5 分钟没有延迟感，
     换来的是回源次数（以及 Worker CPU 时间）成比例下降
   - stale-while-revalidate=86400：过期后先给旧的、后台刷新，回源延迟永远不落在用户身上 */
export const EDGE_TTL = 300;
export const EDGE_SWR = 86400;
/* 注意：别加 no-transform。
   实测它会连带关掉 Cloudflare 的 Brotli —— 首页 HTML 从 8KB 涨回 25KB，
   为了挡一个 20KB 的 RUM 脚本反而多传 17KB，这笔账是亏的。 */
export const pageCacheControl = () =>
  `public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_SWR}`;

export function cacheUrl(url) {
  return new URL(url).toString();
}

export async function edgeGet(url) {
  try {
    return await caches.default.match(cacheUrl(url));
  } catch {
    return null;
  }
}

/** 存一份供匿名访客复用的副本：s-maxage 控制边缘，浏览器那边由调用方改头 */
/* 写回 caches.default 的副本。
   注意这里必须把 swr 一起写进去：以前只写 `public, s-maxage=${ttl}`，
   于是同一个页面有两条口径 —— CF 边缘层（看回给浏览器的响应头）带 86400 的 SWR，
   Worker 内这层只有硬 TTL。过期后命中 Worker 内缓存的那条路会先卡一次回源，
   表现出来就是"有时秒开、有时 300ms"，查起来很难。
   ttl / swr 都跟 pageCacheControl() 用同一组常量，改一处两边同步。 */
export async function edgePut(url, res, ttl = EDGE_TTL, swr = EDGE_SWR) {
  const headers = new Headers(res.headers);
  headers.set('cache-control', `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
  headers.delete('set-cookie');
  const copy = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  try {
    await caches.default.put(cacheUrl(url), copy.clone());
  } catch {
    /* 配额或非法请求，忽略即可 */
  }
  return copy;
}

/**
 * 发布 / 改文章后主动删掉边缘缓存。
 * 比单纯等 TTL 过期靠谱：用户发完文刷新就能看到，不用赌那 45 秒。
 */
export async function bustPaths(origin, paths) {
  const c = caches.default;
  await Promise.all(
    paths.filter(Boolean).map(async (p) => {
      try {
        await c.delete(new URL(p, origin).toString());
      } catch {
        /* ignore */
      }
    })
  );
}
