/**
 * 「变体到底存不存在」的判据。
 *
 * 为什么不能只看状态码：Worker 对缺失的变体会逐级回退（avif → webp → 原图），
 * 所以 /img/a.png.avif 哪怕 avif 从没转过，也照样回 200 —— 那是原图。
 * 只看 r.ok 的体检会把「全是回退」报成「变体齐全」，而且这个错误不会自己暴露：
 * 页面照常显示，只是白白多传了几百 KB。
 *
 * 判据只有一条：Content-Type 必须是这个格式自己的 MIME。
 */

const EXT_TYPE = { webp: 'image/webp', avif: 'image/avif' };

/** 该扩展名对应的 MIME；未知扩展名返回空串 */
export const expectedType = (ext) => EXT_TYPE[String(ext || '').toLowerCase()] || '';

/**
 * @param {{status?: number, type?: string}} res HEAD 探测结果
 * @param {string} ext 期望的变体扩展名（webp / avif）
 * @returns {boolean} 真的是这个格式的变体（不是 404，也不是回退的原图）
 */
export function variantOk(res, ext) {
  const want = expectedType(ext);
  if (!want || !res) return false;
  if (res.status !== 200) return false;
  // Content-Type 可能带参数（image/webp; charset=...），前缀匹配即可
  return String(res.type || '').toLowerCase().startsWith(want);
}

/** 体检输出用：说明为什么不算数 */
export function whyNotVariant(res, ext) {
  const want = expectedType(ext);
  if (!res) return '没有响应';
  if (res.status !== 200) return `HTTP ${res.status}`;
  const got = String(res.type || '').toLowerCase() || '（无 Content-Type）';
  return `回的是 ${got}，不是 ${want}（说明是回退的原图）`;
}
