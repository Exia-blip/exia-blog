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

/* 评论昵称外链只接受 http(s) 绝对地址。
   esc() 能防属性逃逸，但挡不住 href="javascript:..." 这类伪协议——
   现代 CSP 会拦执行，但协议本身不该进 DOM。宽松点：无协议的裸域名（example.com）
   和协议相对（//example.com）按 https 补齐，其余 scheme 一律判无效。
   存储层可能已有历史脏值，所以过滤放在渲染出口（SSR 与客户端共用）。 */
export function safeWebsite(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s.replace(/^\/\//, '')}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch {
    return '';
  }
  return '';
}

/* 没头像的访客用昵称首字当占位。按昵称哈希取色，同一个人换设备/刷新都同色。
   返回 class 而不是内联 style：颜色口径集中在 style.css，深浅主题各改一处即可。 */
const TONES = 10;
export function avatarTone(name = '') {
  const s = String(name || '');
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `ava-t${(h >>> 0) % TONES}`;
}
