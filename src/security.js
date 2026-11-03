// 安全响应头 + 内联脚本 nonce
// 页面里所有内联脚本（主题防闪、SSR 引导数据）都带 nonce，CSP 才敢收掉 'unsafe-inline'。

export function makeNonce() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 给没有 nonce 的 <script> 补上（JSON-LD 那种数据块补了也无害） */
export function applyNonce(html, n) {
  if (!n) return html;
  return String(html).replace(/<script(?![^>]*\snonce=)/gi, `<script nonce="${n}"`);
}

function csp(n) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${n}'`,
    // 主题与 Markdown 大量用 style 属性，样式源只能放开内联
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' https:",
    "frame-src 'self' https://www.youtube.com https://player.bilibili.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * 统一出口安全头。HTML 额外挂 CSP，静态资源不挂（省头大小）。
 * 传 nonce 时说明这次响应里可能含内联脚本。
 */
export function securityHeaders(headers, nonce) {
  const h = headers instanceof Headers ? headers : new Headers(headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('x-frame-options', 'SAMEORIGIN');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  h.set('cross-origin-opener-policy', 'same-origin');
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  if (nonce) h.set('content-security-policy', csp(nonce));
  return h;
}
