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

/* ---------- 邮箱混淆 ----------
 * 页面里只要出现 mailto:，源码就等于把地址直接交给爬虫。
 * 出口处把链接换成 Cloudflare Scrape Shield 同款格式（/cdn-cgi/l/email-protection#<hex>
 * + data-cfemail），解码脚本自己带：不依赖面板开关，开关真打开时 CF 也找不到明文可处理，
 * 两边不会打架。编码规则照抄 CF —— hex 首字节是 key，其余字节是原文 ^ key。
 */
const hex2 = (n) => n.toString(16).padStart(2, '0');

function cfEmailHex(addr) {
  const bytes = Array.from(new TextEncoder().encode(addr));
  const key = bytes[0];
  let out = hex2(key);
  // 全部字节都 ^ key（包括首字节），解码端从第 3 个 hex 字节开始逐字节异或还原
  for (const b of bytes) out += hex2(b ^ key);
  return out;
}

const EMAIL_DECODER =
  '<script>(function(){function d(h){var k=parseInt(h.substr(0,2),16),s="";' +
  'for(var i=2;i<h.length;i+=2)s+=String.fromCharCode(parseInt(h.substr(i,2),16)^k);return s}' +
  'var e=document.querySelectorAll("[data-cfemail]");' +
  'for(var i=0;i<e.length;i++){var m=d(e[i].getAttribute("data-cfemail"));' +
  'e[i].setAttribute("href","mailto:"+m);' +
  'if(e[i].textContent.indexOf("protected")>-1)e[i].textContent=m}})();<\/script>';

const MAILTO_A = /<a([^>]*?)href=(["'])mailto:([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;

export function obfuscateEmail(html) {
  const src = String(html);
  if (!/mailto:/i.test(src)) return src;

  let hit = false;
  const swap = (chunk) =>
    chunk.replace(MAILTO_A, (m, pre, q, addr, post, text) => {
      hit = true;
      const hex = cfEmailHex(addr.trim());
      const open = '<a' + (pre ? (/^\s/.test(pre) ? pre : ' ' + pre) : ' ');
      const cls = /class=/i.test(pre + post) ? '' : ' class="__cf_email__"';
      const label = text.includes('@') ? '[email&#160;protected]' : text;
      return `${open}href="/cdn-cgi/l/email-protection#${hex}"${cls} data-cfemail="${hex}"${post}>${label}</a>`;
    });

  // 只处理 <script> 之外的部分：客户端模板里写着 `href="mailto:${esc(c.email)}"`，
  // 混淆它等于把模板改成静态死链，评论区直接坏掉。
  let out = '';
  for (const seg of src.split(/(<script[\s\S]*?<\/script>)/i)) {
    out += /^<script/i.test(seg) ? seg : swap(seg);
  }

  if (!hit) return out;
  return out.includes('</body>') ? out.replace('</body>', EMAIL_DECODER + '</body>') : out + EMAIL_DECODER;
}

function csp(n, { turnstile = false } = {}) {
  // Turnstile 没配的时候一个字节都不放：默认状态仍然是"零第三方脚本 + 严格 CSP"
  const ts = turnstile ? ' https://challenges.cloudflare.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${n}'${ts}`,
    // 主题与 Markdown 大量用 style 属性，样式源只能放开内联
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${ts}`,
    "media-src 'self' https:",
    `frame-src 'self' https://www.youtube.com https://player.bilibili.com${ts}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // 本站没有任何需要被嵌 iframe 的场景，直接禁止被嵌；与 X-Frame-Options: DENY 保持同一语义
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * 统一出口安全头。HTML 额外挂 CSP，静态资源不挂（省头大小）。
 * 传 nonce 时说明这次响应里可能含内联脚本。
 * opts.turnstile 为真时才把 challenges.cloudflare.com 加进白名单。
 */
export function securityHeaders(headers, nonce, opts = {}) {
  const h = headers instanceof Headers ? headers : new Headers(headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('x-frame-options', 'DENY');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  h.set('cross-origin-opener-policy', 'same-origin');
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  if (nonce) h.set('content-security-policy', csp(nonce, opts));
  return h;
}
