/* 实例内的文章热缓存（进程内 LRU）。
 *
 * 它在 edge cache 之上再垫一层，解决两件 edge cache 解决不了的事：
 *   ① 登录态请求带 private，绕过 edge，每次都回源打 D1
 *   ② 改文 / 部署之后 edge 那一份刚被打掉，第一批访客全是冷 miss
 *
 * 局限先说清楚，免得指望错：
 *   这层不跨 isolate。Worker 一冷启就没了，几十个机房各存各的，
 *   实际命中率取决于流量集中度，别把它当缓存层 —— 数据库那层才是真的。
 *
 * 只存数据库行，不存 HTML。HTML 里有 CSP nonce、有当前用户名、有编辑入口，
 * 存下来必然串号；行是公共事实，谁来看都一样。
 *
 * 评论不进缓存：那是页面上唯一会秒级变化的东西，缓存 45 秒等于让站长
 * 在后台点了「通过」之后，盯着评论区不动。
 */

const TTL = 45_000;
const MAX = 40;

const store = new Map();
let hit = 0;
let miss = 0;
let evicted = 0;

export function postCacheGet(slug) {
  const v = store.get(slug);
  if (!v) {
    miss++;
    return null;
  }
  if (Date.now() > v.at) {
    store.delete(slug);
    miss++;
    return null;
  }
  /* 重新插入把自己挪到队尾。Map 的迭代顺序就是插入顺序，
     所以 keys().next() 拿到的永远是「最久没被取过」的那条 —— 不用自己维护链表。 */
  store.delete(slug);
  store.set(slug, v);
  hit++;
  return v.bundle;
}

export function postCacheSet(slug, bundle) {
  store.set(slug, { at: Date.now() + TTL, bundle });
  while (store.size > MAX) {
    store.delete(store.keys().next().value);
    evicted++;
  }
}

/** 不传 slug 就整体清空 —— 批量改（清理脚本、回填、迁移）之后用这个 */
export function postCacheDrop(slug) {
  if (slug) store.delete(String(slug));
  else store.clear();
}

/** 命中计数。不埋这个就没法判断 45 秒到底该调长还是调短。 */
export function postCacheStats() {
  const total = hit + miss;
  return { hit, miss, evicted, size: store.size, rate: total ? +(hit / total).toFixed(3) : 0 };
}
