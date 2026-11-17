/* 相关推荐挑选：纯函数，不碰 D1，方便单测。
 *
 * 候选由 servePostPage 的同栏目查询顺带带出（同栏目 OR 有共同标签的并集），
 * 这里按「共同标签数 → 同栏目 → 时间新」排序取前 N。
 * 之所以不单开一条 D1 查询：那条路已经用了 5 条连接、上限 6，注释明确警告别再加。
 */

const splitTags = (s) => (s ? String(s).split('\u001f').filter(Boolean) : []);
const stamp = (r) => String(r.published_at || r.created_at || '');

/**
 * @param post      当前文章 { slug, tags:[], category }
 * @param candidates D1 返回的候选行 [{ slug, category, tag_str, published_at, ... }]
 * @param limit     最多几篇
 * @returns 排好序的候选行（原样返回，不改结构）
 */
export function rankRelated(post, candidates, limit = 3) {
  if (!post || !candidates || !candidates.length) return [];
  const mine = new Set(post.tags || []);
  const cat = post.category || '';
  const scored = [];

  for (const r of candidates) {
    if (!r || r.slug === post.slug) continue; // 排除自己
    if (r.is_private || r.hidden) continue; // SQL 已挡，这里双保险
    const shared = splitTags(r.tag_str).reduce((n, t) => n + (mine.has(t) ? 1 : 0), 0);
    const sameCat = !!cat && r.category === cat;
    if (!shared && !sameCat) continue; // 既不沾标签也不同栏目，不进候选
    scored.push({ r, shared, sameCat, time: stamp(r) });
  }

  // 共同标签越多越靠前；标签数相同时同栏目优先；再按发布时间新→旧。
  // 字符串比较即可（D1 存的是 ISO-like 'YYYY-MM-DD HH:MM:SS'），避开时区解析差异。
  scored.sort(
    (a, b) =>
      b.shared - a.shared ||
      Number(b.sameCat) - Number(a.sameCat) ||
      b.time.localeCompare(a.time)
  );
  return scored.slice(0, limit).map((x) => x.r);
}
