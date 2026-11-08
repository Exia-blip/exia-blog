// 头像地址归一化（服务端渲染与浏览器 hydrate 共用）。
//
// 为什么要代理：GitHub 头像原始 URL 不带尺寸参数时是 30KB 级别的方图，
// 站点里显示只有 20–28px；而且它每页都出现，等于每页多一次跨域 DNS + TLS + 一个外链请求。
// 走 /avatar 之后是同源、可长缓存、断网/被墙也能命中边缘缓存的资源。
const GH_AVATAR = /^https:\/\/avatars\.githubusercontent\.com\//i;

/**
 * @param {string} url  原始头像地址（可能是 GitHub、也可能是 R2 的 /img/xxx）
 * @param {number} size 显示尺寸的 2 倍图基数，默认 96
 */
export function avatarSrc(url, size = 96) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (!GH_AVATAR.test(u)) return u; // 已经是本站资源或别的图床，原样用
  const s = Math.min(256, Math.max(32, Number(size) || 96));
  return `/avatar?u=${encodeURIComponent(u)}&s=${s}`;
}
