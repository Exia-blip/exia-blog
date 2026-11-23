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
import { setCookie, clearCookie } from '../src/utils.js';

let pass = 0;
const cases = [];

function t(name, fn) {
  cases.push(name);
  try {
    fn();
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

t('[P-023] HSTS 存在且有效期 ≥ 1 年、覆盖子域', () => {
  const v = htmlH().get('strict-transport-security') || '';
  const m = /max-age=(\d+)/.exec(v);
  assert.ok(m, `没有 max-age：${v || '(缺)'}`);
  assert.ok(
    Number(m[1]) >= 31536000,
    `max-age=${m[1]} 小于一年（31536000）；preload 列表要求至少一年`
  );
  assert.match(v, /includeSubDomains/i, 'HSTS 没覆盖子域');
});

t('[P-023] X-Content-Type-Options 必须是 nosniff', () => {
  assert.equal(htmlH().get('x-content-type-options'), 'nosniff');
  assert.equal(dataH().get('x-content-type-options'), 'nosniff', 'JSON 路径丢了 nosniff');
});

t('[P-023] X-Frame-Options 必须是 DENY', () => {
  assert.equal((htmlH().get('x-frame-options') || '').toUpperCase(), 'DENY');
});

t('[P-023] Referrer-Policy 存在且不是 unsafe-url / 空', () => {
  const v = htmlH().get('referrer-policy') || '';
  assert.ok(v, '没有 Referrer-Policy');
  assert.ok(!/unsafe-url/i.test(v), 'unsafe-url 会把完整 URL（含查询串）发给第三方');
});

t('[P-023] Permissions-Policy 至少禁掉摄像头 / 麦克风 / 定位', () => {
  const v = htmlH().get('permissions-policy') || '';
  for (const f of ['camera', 'microphone', 'geolocation']) {
    assert.match(v, new RegExp(`\\b${f}=\\(\\)`), `没有禁用 ${f}`);
  }
});

t('[P-023] Cross-Origin-Opener-Policy 必须是 same-origin', () => {
  assert.equal(htmlH().get('cross-origin-opener-policy'), 'same-origin');
});

/* ---------- X-XSS-Protection：唯一该「有值」但值为 0 的头 ----------
   OWASP 的建议是显式设 0。理由不是「关掉保护」，而是那个 XSS Auditor
   本身有缺陷：它会在某些反射场景下被诱导去删页面里合法片段，反而制造
   可利用面。现代浏览器已移除该功能，这条只为旧引擎。
   断言写成「是 0，或者干脆没有」——两者都安全，唯独不允许 1; mode=block。 */

t('[P-024] X-XSS-Protection 不许出现 1; mode=block', () => {
  const v = (htmlH().get('x-xss-protection') || '').trim();
  assert.ok(
    v === '' || v === '0',
    `值是 "${v}"；只接受 0 或缺省，1; mode=block 会让旧引擎的 XSS Auditor 反过来制造漏洞`
  );
});

/* ---------- CSP 正向：这些指令少一条就是少一层 ---------- */

t('[P-025] CSP 的 script-src 必须带 nonce，且不含 unsafe-inline / unsafe-eval', () => {
  const c = parseCsp(cspOf(htmlH()));
  const s = (c['script-src'] || []).join(' ');
  assert.ok(s, '没有 script-src，退回 default-src 等于放弃对脚本的精细控制');
  assert.ok(s.includes(`'nonce-${NONCE}'`), `script-src 没带上本次 nonce：${s}`);
  assert.ok(!/unsafe-inline/.test(s), 'script-src 出现 unsafe-inline，nonce 等于白给');
  assert.ok(!/unsafe-eval/.test(s), 'script-src 出现 unsafe-eval');
});

t('[P-025] CSP 的 object-src 必须为 none（挡 Flash / 插件类载体）', () => {
  const c = parseCsp(cspOf(htmlH()));
  assert.deepEqual(c['object-src'], ["'none'"]);
});

t('[P-025] CSP 必须有 base-uri 且不是通配（防 <base> 劫持相对链接）', () => {
  const c = parseCsp(cspOf(htmlH()));
  const v = (c['base-uri'] || []).join(' ');
  assert.ok(v, '没有 base-uri —— 注入一个 <base href> 就能把所有相对链接指向别处');
  assert.ok(v !== '*', 'base-uri 是通配，等于没设');
});

t('[P-025] CSP 的 frame-ancestors 必须为 none', () => {
  const c = parseCsp(cspOf(htmlH()));
  assert.deepEqual(c['frame-ancestors'], ["'none'"]);
});

t('[P-025] CSP 的 form-action 必须为 self（防表单被改投他处）', () => {
  const c = parseCsp(cspOf(htmlH()));
  assert.deepEqual(c['form-action'], ["'self'"]);
});

t('[P-025] CSP 里不许出现裸通配源', () => {
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

t('[P-025] 未配 Turnstile 时 CSP 不许出现 challenges.cloudflare.com', () => {
  const all = cspOf(htmlH());
  assert.ok(
    !all.includes('challenges.cloudflare.com'),
    'Turnstile 未开启却放行了它的源 —— 默认态应当零第三方'
  );
});

t('[P-025] 配了 Turnstile 时三处都要放行（与 P-020 同一口径，这里从纯函数侧再守一遍）', () => {
  const c = parseCsp(cspOf(securityHeaders(new Headers(), NONCE, { turnstile: true })));
  for (const k of ['script-src', 'connect-src', 'frame-src']) {
    assert.ok(
      (c[k] || []).join(' ').includes('https://challenges.cloudflare.com'),
      `${k} 没放行 challenges.cloudflare.com，验证框会白`
    );
  }
});

/* ---------- 无 nonce 的路径：不挂 CSP，但其余头一条都不能少 ---------- */

t('[P-025] 无 nonce 时不发 CSP，但其余安全头仍在', () => {
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

t('[P-026] 会话 cookie 必须带 HttpOnly + Secure + SameSite', () => {
  const v = setCookie('sess', 'abc', { maxAge: 60 });
  assert.match(v, /HttpOnly/, 'HttpOnly 没了 —— JS 可读，XSS 直接偷 token');
  assert.match(v, /Secure/, 'Secure 没了 —— 明文请求也会带上');
  assert.match(v, /SameSite=Lax|SameSite=Strict/, 'SameSite 退化，CSRF 面打开');
  assert.match(v, /Path=\//, 'Path 不是 /');
});

t('[P-026] 退出用的清 cookie 同样带三属性', () => {
  const v = clearCookie('sess');
  for (const k of ['HttpOnly', 'Secure', 'SameSite', 'Max-Age=0']) {
    assert.match(v, new RegExp(k), `clearCookie 缺 ${k}`);
  }
});

/* ---------- CORS 通配的允许范围 ----------
   index.js 里有一处 `access-control-allow-origin: '*'`，挂在 PWA manifest 上。
   那是公开静态数据、不带凭据，通配合理。危险的是它出现在两个地方：
   带 cookie 的接口，或者加了 allow-credentials 的组合。这里按源码守住边界。 */

t('[P-027] ACAO 通配只允许出现在 manifest 一处，且不许配 allow-credentials', () => {
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
t('[P-024] securityHeaders 里显式写了 x-xss-protection: 0', () => {
  assert.match(
    securitySrc,
    /x-xss-protection['"]?\s*,\s*['"]0['"]/i,
    '没显式设 0；旧引擎会走 XSS Auditor 默认行为'
  );
});

console.log(`\n[P-023~P-027] 响应头 ${pass}/${cases.length} passed`);
if (pass !== cases.length) process.exitCode = 1;
