export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...headers },
  });
}

export function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

export function parseCookies(request) {
  const raw = request.headers.get('cookie') || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure !== false) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64u = (s) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signToken(secret, payload, ttlSec = 60 * 60 * 24 * 30) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64u(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(p));
  return `${p}.${b64u(sig)}`;
}

export async function verifyToken(secret, token) {
  if (!token || !token.includes('.')) return null;
  const parts = token.split('.');
  // 多出来的段不是「无害的尾巴」：签名只覆盖 p，s 之后的内容会被静默忽略，
  // 让人误以为 token 里带了东西而实际没有。形状不对就当无效。
  if (parts.length !== 2) return null;
  const [p, s] = parts;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromB64u(s),
      new TextEncoder().encode(p)
    );
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64u(p)));
    /* 过期判断必须「没有 exp 就算无效」，而不是「有 exp 才算过期」。
       原来写的是 `if (data.exp && ...)`：token 里不带 exp 时等式直接短路，
       签名正确就永久有效 —— 一个本该 30 天过期的会话票，改成永久票只要去掉一个字段。
       exp 是字符串或 NaN 时 `'abc' < 123` 也是 false，同样绕过。

       这里不靠 Number() 转换：`exp: [9999999999]` 也能转成一个未来的时间戳。
       签发方（signToken）只会写数字，所以这里就只认数字，边界写死比宽松转换好审。 */
    if (typeof data.exp !== 'number' || !Number.isFinite(data.exp)) return null;
    if (data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function slugify(input) {
  const s = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || '';
}

export function uniqueSlug(base) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${base || 'post'}-${rand}`;
}

export function nowISO() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/* 外部统计（umami）是否已配齐。
   这个判断用在三处，所以只留一份实现：
     · index.js 决定要不要注入那段 <script> 和 __PV_OFF__；
     · security.js 的 CSP 决定放行哪个源；
     · stats.js 决定 /api/pv 还要不要往 D1 里写。
   三处各写一遍的后果不是「不好看」，是会漂：客户端已经关了、服务端还在收，
   或者反过来 —— 两个数字都对不上，而且没人知道哪个漏了。 */
export function umamiOn(env) {
  const src = String((env && env.UMAMI_SCRIPT) || '').trim();
  const id = String((env && env.UMAMI_SITE_ID) || '').trim();
  if (!id || !/^https:\/\//.test(src)) return false;
  try {
    new URL(src);
    return true;
  } catch {
    return false;
  }
}

/* 采集端不一定和脚本同域：Umami Cloud 的脚本在 cloud.umami.is，
   上报实际打到 gateway.umami.is（从 script.js 里 grep 出来的，不是猜的）。
   这份映射既要给 CSP 用，也要给部署后的验收脚本用，所以抽出来一份。 */
export function collectOrigins(src) {
  try {
    const u = new URL(String(src || ''));
    return /(^|\.)umami\.is$/.test(u.hostname) ? ['https://gateway.umami.is'] : [];
  } catch {
    return [];
  }
}

export function pageParams(url, defSize = 10) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') || String(defSize), 10) || defSize));
  return { page, size, offset: (page - 1) * size };
}
