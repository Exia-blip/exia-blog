// 边缘缓存的小封装：取、存、失效都在这里，页面侧只关心 URL。

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
export async function edgePut(url, res, ttl) {
  const headers = new Headers(res.headers);
  headers.set('cache-control', `public, s-maxage=${ttl}`);
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
