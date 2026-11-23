// 安全响应头断言：13 条正断言 + 3 条负断言 + cookie 属性 + CORS 通配范围
//
// 为什么单独一个脚本、而不是塞进 check-live：
//   check-live 打的是线上，需要网络、需要部署过；这里打的是 securityHeaders()
//   这个纯函数，改完头立刻能验，不需要 Worker，也不需要等边缘生效。
//   两者互补：一个守「代码里写了什么」，一个守「线上真发出去的是什么」。
//
// 为什么大多是不需要浏览器就能验：响应头是字符串。CSP 是否真的拦住 XSS
// 需要浏览器，那是 test-md-snapshot / 探针的事；这里只守「策略字符串里
// 该有的有、不该有的没有」。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { securityHeaders } from '../src/security.js';
import { harden } from '../src/index.js';
import { setCookie, clearCookie } from '../src/utils.js';

let pass = 0;
const cases = [];

/* 必须是 async：harden() 是异步的，用例里 await 了它。
   同步的 try/catch 抓不到 rejected promise —— 那样写出来的断言
   永远是绿的，包括它该红的时候。这是一个比 P-019 更隐蔽的假绿。 */
async function t(name, fn) {
  cases.push(name);
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';

/** HTML 路径：带 nonce，所以有 CSP */
const htmlH = () => securityHeaders(new Headers(), NONCE, {});
/** JSON/XML 路径：不带 nonce，故意不挂 CSP */
const dataH = () => securityHeaders(new Headers(), null, {});
const cspOf = (h) => h.get('content-security-policy') || '';
/** 把 CSP 拆成 { 指令名: 值 } */
function parseCsp(s) {
  const out = {};
  for (const part of s.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const [k, ...rest] = seg.split(/\s+/);
    out[k.toLowerCase()] = rest;
  }
  return out;
}

/* ---------- 基础六条：OWASP Secure Headers 的最小集 ---------- */

await t('[P-023] HSTS 存在且有效期 ≥ 1 年、覆盖子域', () => {
  const v = htmlH().get('strict-transport-security') || '';
  const m = /max-age=(\d+)/.exec(v);
  assert.ok(m, `没有 max-age：${v || '(缺)'}`);
  assert.ok(
    Number(m[1]) >= 31536000,
    `max-age=${m[1]} 小于一年（31536000）；preload 列表要求至少一年`
  );
  assert.match(v, /includeSubDomains/i, 'HSTS 没覆盖子域');
});

await t('[P-023] X-Content-Type-Options 必须是 nosniff', () => {
  assert.equal(htmlH().get('x-content-type-options'), 'nosniff');
  assert.equal(dataH().get('x-content-type-options'), 'nosniff', 'JSON 路径丢了 nosniff');
});

await t('[P-023] X-Frame-Options 必须是 DENY', () => {
  assert.equal((htmlH().get('x-frame-options') || '').toUpperCase(), 'DENY');
});

await t('[P-023] Referrer-Policy 存在且不是 unsafe-url / 空', () => {
  const v = htmlH().get('referrer-policy') || '';
  assert.ok(v, '没有 Referrer-Policy');
  assert.ok(!/unsafe-url/i.test(v), 'unsafe-url 会把完整 URL（含查询串）发给第三方');
});

await t('[P-023] Permissions-Policy 至少禁掉摄像头 / 麦克风 / 定位', () => {
  const v = htmlH().get('permissions-policy') || '';
  for (const f of ['camera', 'microphone', 'geolocation']) {
    assert.match(v, new RegExp(`\\b${f}=\\(\\)`), `没有禁用 ${f}`);
  }
});

await t('[P-023] Cross-Origin-Opener-Policy 必须是 same-origin', () => {
  assert.equal(htmlH().get('cross-origin-opener-policy'), 'same-origin');
});

/* ---------- X-XSS-Protection：唯一该「有值」但值为 0 的头 ----------
   OWASP 的建议是显式设 0。理由不是「关掉保护」，而是那个 XSS Auditor
   本身有缺陷：它会在某些反射场景下被诱导去删页面里合法片段，反而制造
   可利用面。现代浏览器已移除该功能，这条只为旧引擎。
   断言写成「是 0，或者干脆没有」——两者都安全，唯独不允许 1; mode=block。 */

await t('[P-024] X-XSS-Protection 不许出现 1; mode=block', () => {
  const v = (htmlH().get('x-xss-protection') || '').trim();
  assert.ok(
    v === '' || v === '0',
    `值是 "${v}"；只接受 0 或缺省，1; mode=block 会让旧引擎的 XSS Auditor 反过来制造漏洞`
  );
});

/* ---------- CSP 正向：这些指令少一条就是少一层 ---------- */

await t('[P-025] CSP 的 script-src 必须带 nonce，且不含 unsafe-inline / unsafe-eval', () => {
  const c = parseCsp(cspOf(htmlH()));
  const s = (c['script-src'] || []).join(' ');
  assert.ok(s, '没有 script-src，退回 default-src 等于放弃对脚本的精细控制');
  assert.ok(s.includes(`'nonce-${NONCE}'`), `script-src 没带上本次 nonce：${s}`);
  assert.ok(!/unsafe-inline/.test(s), 'script-src 出现 unsafe-inline，nonce 等于白给');
  assert.ok(!/unsafe-eval/.test(s), 'script-src 出现 unsafe-eval');
});

await t('[P-025] CSP 的 object-src 必须为 none（挡 Flash / 插件类载体）', () => {
  const c = parseCsp(cspOf(htmlH()));
  assert.deepEqual(c['object-src'], ["'none'"]);
});

await t('[P-025] CSP 的 base-uri 必须是 none（全站不用 <base>）', () => {
  const c = parseCsp(cspOf(htmlH()));
  const v = (c['base-uri'] || []).join(' ');
  assert.ok(v, '没有 base-uri —— 注入一个 <base href> 就能把所有相对链接指向别处');
  assert.equal(
    v,
    "'none'",
    `base-uri 是 ${v}；本站在源码与全部文章里都不用 <base>，没有理由留 'self' —— 那只是给注入的 <base> 留了一个合法位置`
  );
});

await t('[P-025] CSP 的 frame-ancestors 必须为 none', () => {
  const c = parseCsp(cspOf(htmlH()));
  assert.deepEqual(c['frame-ancestors'], ["'none'"]);
});

await t('[P-025] CSP 的 form-action 必须为 self（防表单被改投他处）', () => {
  const c = parseCsp(cspOf(htmlH()));
  assert.deepEqual(c['form-action'], ["'self'"]);
});

await t('[P-025] CSP 里不许出现裸通配源', () => {
  const c = parseCsp(cspOf(htmlH()));
  for (const [k, vals] of Object.entries(c)) {
    if (k === 'upgrade-insecure-requests') continue;
    assert.ok(!vals.includes('*'), `${k} 里出现了 * ，整条指令形同虚设`);
  }
});

/* ---------- CSP 反向：默认态不许给第三方开口子 ----------
   Turnstile 未配置是常态。此时如果 CSP 里还留着 challenges.cloudflare.com，
   等于平白多一个可被第三方用来观测的源。P-020 守的是「配了就放行」，
   这里守的是「没配就一个字节都不放」的另一半。 */

await t('[P-025] 未配 Turnstile 时 CSP 不许出现 challenges.cloudflare.com', () => {
  const all = cspOf(htmlH());
  assert.ok(
    !all.includes('challenges.cloudflare.com'),
    'Turnstile 未开启却放行了它的源 —— 默认态应当零第三方'
  );
});

await t('[P-025] 配了 Turnstile 时三处都要放行（与 P-020 同一口径，这里从纯函数侧再守一遍）', () => {
  const c = parseCsp(cspOf(securityHeaders(new Headers(), NONCE, { turnstile: true })));
  for (const k of ['script-src', 'connect-src', 'frame-src']) {
    assert.ok(
      (c[k] || []).join(' ').includes('https://challenges.cloudflare.com'),
      `${k} 没放行 challenges.cloudflare.com，验证框会白`
    );
  }
});

/* ---------- 无 nonce 的路径：不挂 CSP，但其余头一条都不能少 ---------- */

await t('[P-025] 无 nonce 时不发 CSP，但其余安全头仍在', () => {
  const h = dataH();
  assert.equal(h.get('content-security-policy'), null, 'JSON/XML 路径不该带 CSP');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.ok(h.get('strict-transport-security'), '数据路径丢了 HSTS');
  assert.equal((h.get('x-frame-options') || '').toUpperCase(), 'DENY');
});

/* ---------- cookie 属性 ----------
   材料里那句「cookie 必须含 HttpOnly」在断言层是真缺口的：
   setCookie 早就默认带，但没有任何脚本守着它。
   一次「顺手简化」把 HttpOnly 删掉，线上看不出任何变化。 */

await t('[P-026] 会话 cookie 必须带 HttpOnly + Secure + SameSite', () => {
  const v = setCookie('sess', 'abc', { maxAge: 60 });
  assert.match(v, /HttpOnly/, 'HttpOnly 没了 —— JS 可读，XSS 直接偷 token');
  assert.match(v, /Secure/, 'Secure 没了 —— 明文请求也会带上');
  assert.match(v, /SameSite=Lax|SameSite=Strict/, 'SameSite 退化，CSRF 面打开');
  assert.match(v, /Path=\//, 'Path 不是 /');
});

await t('[P-026] 退出用的清 cookie 同样带三属性', () => {
  const v = clearCookie('sess');
  for (const k of ['HttpOnly', 'Secure', 'SameSite', 'Max-Age=0']) {
    assert.match(v, new RegExp(k), `clearCookie 缺 ${k}`);
  }
});

/* ---------- CORS 通配的允许范围 ----------
   index.js 里有一处 `access-control-allow-origin: '*'`，挂在 PWA manifest 上。
   那是公开静态数据、不带凭据，通配合理。危险的是它出现在两个地方：
   带 cookie 的接口，或者加了 allow-credentials 的组合。这里按源码守住边界。 */

await t('[P-027] ACAO 通配只允许出现在 manifest 一处，且不许配 allow-credentials', () => {
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const hits = idx.match(/access-control-allow-origin/gi) || [];
  assert.equal(
    hits.length,
    1,
    `源码里有 ${hits.length} 处 ACAO；只允许 manifest 那一处，其余接口靠同源`
  );
  const near = idx.slice(idx.indexOf('access-control-allow-origin') - 400, idx.indexOf('access-control-allow-origin') + 400);
  assert.ok(!/allow-credentials/i.test(idx), '出现 allow-credentials —— 与 * 组合会被浏览器直接拒绝且语义混乱');
  assert.match(near, /manifest/i, '唯一那处 ACAO 不在 manifest 附近，位置可疑');
});

/* ---------- 唯一该改的代码 ---------- */

const securitySrc = readFileSync(new URL('../src/security.js', import.meta.url), 'utf8');
await t('[P-024] securityHeaders 里显式写了 x-xss-protection: 0', () => {
  assert.match(
    securitySrc,
    /x-xss-protection['"]?\s*,\s*['"]0['"]/i,
    '没显式设 0；旧引擎会走 XSS Auditor 默认行为'
  );
});

/* ---------- nonce 与缓存的配对 ----------
   材料里那条「nonce 过的 HTML 绝不能进共享缓存」在本站是**违反**的：
   首页与文章页 s-maxage=300、404 页 s-maxage=60，都带 nonce，窗口内所有访客
   共用同一个值。这不是疏忽，是取舍 —— 全站 no-store 会让首屏回到每次回源。

   换来的安全性依赖一个前提：**可缓存页面零反射面**。凡是回显用户输入的地方
   （搜索词、路径参数）都必须走 no-store，那条由下面的 CACHE-01 守。
   前提本身用线上实测确认过：/tag/<script>alert(1)</script> 返回 404 且不回显。

   这组断言的职责不是「让缓存消失」，是「让非缓存的边界不被人顺手扩大」。 */

const mkHtml = () =>
  new Response('<html><head><title>t</title></head><body><script>var a=1<\/script></body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

await t('[P-028] 带 query 的读者页必须双层 no-store（Worker 内 + 边缘）', async () => {
  for (const search of ['?q=x', '?page=2', '?utm_source=a']) {
    const out = await harden(mkHtml(), {}, '/', search);
    assert.equal(out.headers.get('cache-control'), 'no-store', `${search} 的 cache-control 不是 no-store`);
    assert.equal(out.headers.get('cdn-cache-control'), 'no-store', `${search} 没设 cdn-cache-control，边缘仍会自己存一份`);
  }
});

await t('[P-028] 后台页必须 private + no-store，且带 CDN 头', async () => {
  for (const p of ['/admin', '/editor']) {
    const out = await harden(mkHtml(), {}, p, '');
    assert.match(out.headers.get('cache-control') || '', /no-store/, `${p} 的 cache-control 没有 no-store`);
    assert.match(out.headers.get('cache-control') || '', /private/, `${p} 没标 private —— 中间代理可能存`);
    assert.equal(out.headers.get('cdn-cache-control'), 'private, no-store', `${p} 缺 cdn-cache-control`);
  }
});

await t('[P-028] CSP 里的 nonce 与 HTML 属性里的 nonce 逐字节相同', async () => {
  const out = await harden(mkHtml(), {}, '/', '');
  const csp = out.headers.get('content-security-policy') || '';
  const fromCsp = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp);
  assert.ok(fromCsp, 'CSP 里没有 nonce');
  const body = await out.text();
  const inHtml = [...body.matchAll(/\bnonce="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(inHtml.length > 0, 'HTML 里一个 nonce 属性都没有，CSP 那条等于把脚本全挡了');
  for (const n of inHtml) {
    assert.equal(n, fromCsp[1], `HTML 里的 nonce=${n} 与 CSP 里的 ${fromCsp[1]} 不一致 —— 两处必须同一个值`);
  }
});

await t('[P-028] nonce 必须是 16 字节密码学随机（32 位十六进制）', async () => {
  const a = await harden(mkHtml(), {}, '/', '');
  const b = await harden(mkHtml(), {}, '/', '');
  const pick = (r) => (/nonce-([A-Za-z0-9+/=_-]+)/.exec(r.headers.get('content-security-policy') || '') || [])[1];
  const na = pick(a);
  const nb = pick(b);
  assert.match(na, /^[0-9a-f]{32}$/, `nonce 不是 32 位 hex：${na}`);
  assert.notEqual(na, nb, '两次响应的 nonce 相同 —— 没在每次请求时重新生成');
});

await t('[P-028] cacheable 的判断里必须有 !url.search（防回退）', () => {
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const at = idx.indexOf('const cacheable');
  assert.ok(at > 0, '找不到 cacheable 定义');
  const seg = idx.slice(at, at + 1400);
  assert.match(seg, /!url\.search/, 'cacheable 不再排除 query —— 带 query 的页面会重新进缓存，且 bust 删不掉');
});

/* 反方向也要守：缓存 + nonce 并存是既定设计，不是意外。
   如果哪天有人把可缓存页面的 nonce 摘掉（改成 'self'），这条会红，
   那时应当同步改文章里「缓存 300 秒共享 nonce」那段措辞。 */
await t('[P-028] 可缓存的 HTML 仍然带 nonce（既定设计，改动需同步文章）', async () => {
  const out = await harden(mkHtml(), {}, '/', '');
  assert.match(out.headers.get('cache-control') || '', /s-maxage=[1-9]/, '首页不再可缓存 —— 若是有意改动，请同步改 P-028 与文章');
  assert.match(out.headers.get('content-security-policy') || '', /'nonce-/, '可缓存页面丢了 nonce');
});

/* ---------- 断言本身的元断言 ----------
   这一条守的是上面那六条为什么现在真的会执行。
   t() 曾经是同步函数，async 用例抛的错进不了它的 catch，六条断言全程假绿。
   改法是把 t 改成 async、调用处 await。这里把这两件事钉住 —— 有人把它
   改回同步，本条会红；而它红了，说明别的一切绿都不算数。 */
await t('[P-029] t() 必须是 async，且调用处必须 await', () => {
  const self = readFileSync(new URL('./test-headers.mjs', import.meta.url), 'utf8');
  assert.match(self, /async function t\(/, 't() 不是 async —— async 用例会静默变成永远绿');
  const awaited = (self.match(/^await t\(/gm) || []).length;
  assert.ok(awaited >= 20, `只有 ${awaited} 处 await t(...)，其余用例的失败会被吞掉`);
});

console.log(`\n[P-023~P-029] 响应头与缓存 ${pass}/${cases.length} passed`);
if (pass !== cases.length) process.exitCode = 1;
