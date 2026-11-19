// 出口邮箱混淆回归：编码必须与 Cloudflare 的 data-cfemail 互通，且不能碰客户端模板。
// 用法：node scripts/test-security.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { obfuscateEmail, applyNonce, securityHeaders } from '../src/security.js';
import { safeNext } from '../src/auth.js';
import { siteOrigin } from '../src/utils.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* ---------- 登录 next 开放重定向（CWE-601） ---------- */
const ORIGIN = 'https://exia.de5.net';

t('safeNext：正常站内路径原样放行', () => {
  for (const p of ['/', '/editor', '/p/csp-nonce-cache?x=1#top', '/admin/stats']) {
    assert.equal(safeNext(p, ORIGIN), p);
  }
});

t('safeNext：挡住协议相对 URL（// 与 /\\ 两种写法）', () => {
  for (const p of ['//evil.com', '/\\evil.com', '///evil.com', 'https://evil.com', 'http://evil.com/x']) {
    assert.equal(safeNext(p, ORIGIN), '/', p);
  }
});

t('safeNext：空值/非字符串/畸形值回落到 /', () => {
  for (const p of ['', null, undefined, 123, 'editor', '?x=1', '\\evil.com']) {
    assert.equal(safeNext(p, ORIGIN), '/', String(p));
  }
});

t('safeNext：URL 解析器吞掉控制字符后仍在本站才放行', () => {
  // new URL() 会剔除 tab/newline，'/\t/evil.com' 解析成 //evil.com → 必须拦
  assert.equal(safeNext('/\t/evil.com', ORIGIN), '/');
  assert.equal(safeNext('/\n/evil.com', ORIGIN), '/');
});

/* 对外绝对 URL 的可信源：Host 头可控，canonical/sitemap/RSS 不能用它 */
t('siteOrigin：配了 SITE_ORIGIN 就忽略伪造的 Host', () => {
  const req = (host) => new Request(`https://${host}/p/foo`);
  assert.equal(siteOrigin({ SITE_ORIGIN: 'https://exia.de5.net' }, req('evil.example.com')), 'https://exia.de5.net');
  assert.equal(siteOrigin({ SITE_ORIGIN: 'https://exia.de5.net/' }, req('foo.exia.de5.net')), 'https://exia.de5.net');
});

t('siteOrigin：未配置时回落请求 origin（本地 dev 仍能跑）', () => {
  const req = new Request('http://localhost:8787/p/foo');
  assert.equal(siteOrigin({}, req), 'http://localhost:8787');
});

t('siteOrigin：配错（非 http(s)）时回落，不让整站 500', () => {
  const req = new Request('https://exia.de5.net/p/foo');
  assert.equal(siteOrigin({ SITE_ORIGIN: 'javascript:alert(1)' }, req), 'https://exia.de5.net');
  assert.equal(siteOrigin({ SITE_ORIGIN: 'not a url' }, req), 'https://exia.de5.net');
});

t('login.html 前端与后端同口径，且 location.replace 用的是过滤后的值', () => {
  const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  // 前端正则 /^\/(?![\/\\])/ 必须原样在文件里（JS 源码字面量，不需再转义）
  assert.ok(html.includes("if (!/^\\/(?![\\/\\\\])/.test(s)) return '/';"), '前端首字符校验缺失或被改动');
  assert.ok(html.includes('new URL(s, location.origin).origin !== location.origin'), '前端 origin 校验缺失');
  assert.match(html, /location\.replace\(next\)/);
  const nextDecl = html.match(/const next = safeNext\(([^)]*)\)/);
  assert.ok(nextDecl, 'next 必须经过 safeNext 过滤');
});

const decodeCf = (hex) => {
  const key = parseInt(hex.slice(0, 2), 16);
  let s = '';
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return s;
};

t('mailto 链接被换成 data-cfemail，源码里不留明文', () => {
  const out = obfuscateEmail('<a href="mailto:huaxia2012@gmail.com">huaxia2012@gmail.com</a>');
  assert.ok(!out.includes('huaxia2012@gmail.com'), out);
  assert.ok(out.includes('data-cfemail='), out);
  assert.ok(out.includes('/cdn-cgi/l/email-protection#'), out);
});

t('编码能被 CF 的解码算法还原（首字节当 key）', () => {
  for (const addr of ['a@b.co', 'huaxia2012@gmail.com', 'x+y@sub.domain.org']) {
    const out = obfuscateEmail(`<a href="mailto:${addr}">${addr}</a>`);
    const hex = out.match(/data-cfemail="([0-9a-f]+)"/)[1];
    assert.equal(decodeCf(hex), addr);
  }
});

t('解码脚本带 nonce 才会被 CSP 放行', () => {
  const body = applyNonce(obfuscateEmail('<a href="mailto:a@b.co">a@b.co</a></body>'), 'abc123');
  assert.ok(/<script nonce="abc123">\(function\(\)\{function d\(h\)/.test(body), body);
});

t('客户端模板里的 mailto 占位符不能被改', () => {
  const tpl = '<script>const x = `<a class="cmt-mail" href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;</script>';
  assert.equal(obfuscateEmail(tpl), tpl);
});

t('没有 mailto 的页面原样返回（不白插脚本）', () => {
  const page = '<p>没有邮箱</p><a href="https://example.com">x</a>';
  assert.equal(obfuscateEmail(page), page);
});

t('一个页面多个邮箱都处理，原有 class 不被顶掉也不重复加', () => {
  const out = obfuscateEmail(
    '<a class="k" href="mailto:a@b.co">a@b.co</a><a href="mailto:c@d.co">c@d.co</a>'
  );
  assert.equal(out.match(/data-cfemail=/g).length, 2);
  // 第一个保留原 class、第二个补 __cf_email__，同一个标签里不能出现两个 class
  assert.equal(out.match(/class=/g).length, 2);
  assert.ok(!/class="k"[^>]*class=/.test(out), out);
});

/* CSP 里统计的放行范围。Umami Cloud 的脚本和采集端不同域
   （cloud.umami.is / gateway.umami.is），只放行脚本源的话脚本能加载、
   script-src 也不报错，但每条上报都在 connect-src 被静默挡掉 ——
   后台一条数据没有，控制台只有一句容易被当成噪声的 CSP 拒绝。 */
const cspOf = (opts) => securityHeaders(new Headers(), 'n0nce', opts).get('content-security-policy') || '';
const dir = (csp, name) => (csp.match(new RegExp(`${name} [^;]+`)) || [''])[0];

t('没配统计时 CSP 里没有任何第三方源', () => {
  const c = cspOf({});
  assert.ok(!c.includes('umami'), c);
  assert.equal(dir(c, 'connect-src').trim(), "connect-src 'self'");
});

t('统计的脚本源只进 script-src，不进 connect-src 之外的放宽', () => {
  const c = cspOf({ analytics: { script: 'https://cloud.umami.is', collect: [] } });
  assert.ok(dir(c, 'script-src').includes('https://cloud.umami.is'), c);
  assert.ok(dir(c, 'connect-src').includes('https://cloud.umami.is'), c);
});

t('采集端不同域时 connect-src 必须单独放行它', () => {
  const c = cspOf({ analytics: { script: 'https://cloud.umami.is', collect: ['https://gateway.umami.is'] } });
  assert.ok(dir(c, 'connect-src').includes('https://gateway.umami.is'), c);
  // 采集端不需要能执行脚本，放宽到 script-src 是白放开
  assert.ok(!dir(c, 'script-src').includes('gateway.umami.is'), c);
});

t('analytics 传 null 不炸（未配置时的正常路径）', () => {
  const c = cspOf({ analytics: null });
  assert.ok(c.startsWith("default-src 'self'"), c);
});

let pass = 0;
for (const [name, fn] of cases) {  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
