// 预设头图的分配规则。服务端（src/cover.js）与浏览器（index.html 的卡片渲染）
// 共用这一份，避免两边算出不同的图 —— 那会造成 hydrate 时缩略图闪一下换脸。

export const AUTO_COVER_COUNT = 6;

/** FNV-1a，只用于没有 id 的场景（草稿预览、测试数据） */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 优先用 id：id 单调递增，新文章天然轮到下一张，列表里不会连着撞同一个。
 * 没有 id 就退回 slug 哈希，保证同一篇永远是同一张。
 */
export function autoCover(post) {
  const id = Number(post && post.id) || 0;
  const seed = id > 0 ? id : hashStr(String((post && (post.slug || post.title)) || ''));
  return `/thumbs/auto-${(seed % AUTO_COVER_COUNT) + 1}.jpg`;
}
