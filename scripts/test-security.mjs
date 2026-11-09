// 出口邮箱混淆回归：编码必须与 Cloudflare 的 data-cfemail 互通，且不能碰客户端模板。
// 用法：node scripts/test-security.mjs
import assert from 'node:assert/strict';
import { obfuscateEmail, applyNonce } from '../src/security.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

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

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
