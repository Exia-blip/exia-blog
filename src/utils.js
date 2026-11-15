export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/* 页面 ETag。
 *
 * 为什么必须有：HTML 的 cache-control 是 max-age=0（浏览器每次都得回源校验），
 * 没有 ETag 的话这个「校验」就是一次完整的 200 —— 每次翻页都重传 50 多 KB，
 * 而内容其实一个字没变。有了它，第二次起就是 304，几十字节。
 *
 * 为什么用弱校验（W/）：body 是渲染出来的 HTML，字节完全一致才叫强校验；
 * 这里只要「语义没变」就够了，中间层（比如 CF 的 br 重压缩）也可能改动字节，
 * 强校验反而会假阴性。
 *
 * 为什么要先把相对时间归一化：评论区的「3 分钟前」每秒都在变，
 * 不归一化的话 ETag 每分钟翻新一次，304 一次都命中不了 —— 等于白做。 */
/* 注意别在这里用 \b：JS 的 \b 只认 ASCII 单词字符，中文旁边根本不存在「边界」，
   写了等于没写（这个坑第一次就是被测试抓出来的 —— 三条相对时间断言全红）。
   代价是正文里「3 天前」这种叙述也会被归一化，但那只会让两个页面的 ETag 更容易
   撞在一起，不影响正确性：弱校验只要「变化时能变、不变时不变」。 */
const VOLATILE = /刚刚|\d+\s*(?:秒|分钟|小时|天|个月|年)前/g;

/* CSP nonce 每次请求都重新随机（security.js 的 makeNonce），会注入到页面里每个
   <script nonce="...">。不归一化的话整页 body 每次都不同，ETag 跟着每次都变 ——
   表面上功能齐全，实际 304 命中率恒为 0。这正是「算了个 ETag」和「304 能工作」
   之间的距离。 */
const NONCE = /\snonce="[0-9a-f]{8,}"/g;

/* 为什么是强 ETag（不带 W/）而不是弱校验：
   Cloudflare 边缘只对强 ETag 做条件响应 —— 缓存 HIT 时自己就能答 304。
   用 W/ 的话请求会一路打到 Worker，等于白搭一层（实测：弱 tag 下 CF 回的是
   完整 200 + 29KB，强 tag 下才是 304 + 0B）。

   语义上它是「归一化后的内容指纹」：nonce 与相对时间这两处每次都会变的地方
   已经抹平，剩下的字节确实稳定。304 响应刻意不发 CSP（见 index.js maybe304），
   所以浏览器继续用自己那份 body 与它的 nonce，两边始终配套。 */
export function tagOf(body) {
  const s = String(body).replace(VOLATILE, '~t~').replace(NONCE, ' nonce="~"');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `"${s.length.toString(36)}-${(h >>> 0).toString(16)}"`;
}

export function html(body, status = 200, headers = {}) {
  /* 这里刻意不算 ETag：html() 之后还要经过 injectTheme / harden 两次改写，
     在这里算出来的 tag 对应的是「注入前」的 body，浏览器拿它做校验永远对不上。
     ETag 统一在入口按最终 body 补（见 index.js 的 withEtag）。 */
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

/* ---------- 时区：显示层统一在这里换算 ----------
   D1 里所有时间都是 UTC 裸字符串（nowISO() 写进去的就是 UTC），
   而 `String(x).slice(0, 10)` 取的是 **UTC 的日期**。

   后果不是理论上的：北京时间 11-12 00:30 发的文章，UTC 是 11-11 16:30，
   页面上写 11-11 —— 凌晨写完顺手发布的人，看到的日期是「昨天」。
   跨年那 8 小时更糟：北京 2027-01-01 00:30 的文章会被归档进 2026。

   所以凡是「给人看」的日期都走这里。JSON-LD / sitemap / RSS 一律不动：
   那几个是喂机器的，ISO 8601 带 Z 和 RFC 822 带 GMT 才是对的。 */
export const TZ_HOURS = 8;

export function localParts(v) {
  const s = String(v || '').trim();
  if (!s) return { y: '', m: '', d: '', md: '', day: '', time: '' };
  const d = new Date(sqlIso(s));
  if (isNaN(d.getTime())) {
    // 不是 D1 那种格式（已带偏移、或干脆是脏数据）：退回字符串切片，至少不崩
    return { y: s.slice(0, 4), m: s.slice(5, 7), d: s.slice(8, 10), md: s.slice(5, 10), day: s.slice(0, 10), time: s.slice(11, 16) };
  }
  const t = new Date(d.getTime() + TZ_HOURS * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  const y = String(t.getUTCFullYear());
  const m = p(t.getUTCMonth() + 1);
  const dd = p(t.getUTCDate());
  return { y, m, d: dd, md: `${m}-${dd}`, day: `${y}-${m}-${dd}`, time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` };
}

/** 北京时间的 'YYYY-MM-DD' */
export const localDay = (v) => localParts(v).day;

/* D1 存的是 'YYYY-MM-DD HH:MM:SS'（UTC，无时区）。直接塞进 datetime="" 是非法值，
   浏览器解析成 Invalid Date，微数据与屏幕阅读器都读不出时间。补成 ISO。 */
export function sqlIso(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return s.replace(' ', 'T');
  return s.replace(' ', 'T') + 'Z';
}

/* meta description 的唯一出处。
   之前是 `post.summary || extractExcerpt(content, 150)` 直接拼进去，三个问题：
   · 后台手填的摘要里换行原样带出，HTML 里折叠成空格，长度却按换行后的算；
   · 超长摘要不截断，Google 摘要栏里被拦腰切在半个词上；
   · 正文只有图片/代码时 extractExcerpt 返回空串，description="" 等于没写。
   现在统一在这里归一化 + 截断 + 兜底，调用方只负责给「首选文本」和「兜底文本」。 */
export function metaDesc(primary, fallback = '', len = 155) {
  const clean = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  let t = clean(primary);
  if (!t) t = clean(fallback);
  if (t.length <= len) return t;
  let cut = t.slice(0, len);
  // 只在后半段找空格：前半段就退的话会剩一句残句，不如硬截
  const sp = cut.lastIndexOf(' ');
  if (sp > len * 0.7) cut = cut.slice(0, sp);
  return cut.replace(/[，、,;；:：\s]+$/, '') + '…';
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
