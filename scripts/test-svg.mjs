// SVG / 图片出口的安全边界。这些都是能直接变成存储型 XSS 的判据，改坏了不该靠人眼看。
import assert from 'node:assert/strict';
import { imageResponse } from '../src/index.js';
import { coverOf, isAutoCover, thumbOf } from '../src/cover.js';
import { makeKey } from '../src/s3.js';

let pass = 0;
const fails = [];
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(`${name}: ${e.message.split('\n')[0]}`);
  }
}

/* 假的 R2 对象：只实现 imageResponse 用到的那几样 */
function obj(ct, key) {
  const h = new Headers();
  if (ct) h.set('content-type', ct);
  return {
    key,
    httpEtag: '"deadbeef"',
    body: 'x',
    writeHttpMetadata(target) {
      for (const [k, v] of h) target.set(k, v);
    },
  };
}
const res = (ct, key, fallback = '') => imageResponse(obj(ct, key), fallback);

/* ---------------- 白名单：不是图片就绝不当文档发 ---------------- */
t('text/html 被降级成二进制下载', () => {
  const r = res('text/html', 'u/a.png');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('content-disposition'), 'attachment');
  assert.equal(r.headers.get('x-img-rejected'), 'text/html');
});
t('application/xhtml+xml 同样降级', () => {
  const r = res('application/xhtml+xml', 'u/b.png');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
});
t('application/json 降级', () => {
  assert.equal(res('application/json', 'u/c.png').headers.get('content-type'), 'application/octet-stream');
});
t('没有 content-type 且扩展名认不出 -> 降级下载，不交给浏览器嗅探', () => {
  const r = res('', 'u/weird.bin');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('content-disposition'), 'attachment');
  assert.equal(r.headers.get('x-img-rejected'), 'unknown');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});
t('白名单里的位图原样放行', () => {
  for (const ct of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif']) {
    const r = res(ct, 'u/x.png');
    assert.equal(r.headers.get('content-type'), ct);
    assert.equal(r.headers.get('content-disposition'), null, ct + ' 不该强制下载');
  }
});
t('image/jpg 别名归一成 image/jpeg', () => {
  assert.equal(res('image/jpg', 'u/x.jpg').headers.get('content-type'), 'image/jpeg');
});
t('content-type 带参数也能认（; charset=utf-8）', () => {
  assert.equal(res('image/png; charset=utf-8', 'u/x.png').headers.get('content-type'), 'image/png');
});

/* ---------------- SVG：两个判据取并集 ---------------- */
const SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

t('image/svg+xml 带沙箱 CSP', () => {
  const r = res('image/svg+xml', 'u/a.svg');
  assert.equal(r.headers.get('content-security-policy'), SANDBOX);
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
});
t('扩展名 svg + 元数据谎报 png -> 以扩展名为准，按 svg 发并上沙箱', () => {
  const r = res('image/png', 'u/a.svg');
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.equal(r.headers.get('content-security-policy'), SANDBOX);
});
t('元数据 svg + 扩展名 png -> 仍然上沙箱', () => {
  const r = res('image/svg+xml', 'u/a.png');
  assert.equal(r.headers.get('content-security-policy'), SANDBOX);
});
t('svg 的 charset 参数不影响判定', () => {
  const r = res('image/svg+xml; charset=utf-8', 'u/a.svg');
  assert.equal(r.headers.get('content-security-policy'), SANDBOX);
});
t('沙箱里没有 allow-scripts（有就等于白写）', () => {
  const csp = res('image/svg+xml', 'u/a.svg').headers.get('content-security-policy');
  assert.ok(!/allow-scripts|allow-same-origin/.test(csp), csp);
});
t('位图不带沙箱 CSP（带了也无害，但别让下游误判）', () => {
  assert.equal(res('image/png', 'u/a.png').headers.get('content-security-policy'), null);
});
t('降级后的响应不残留 SVG 的 CSP', () => {
  const r = res('text/html', 'u/a.png');
  assert.equal(r.headers.get('content-security-policy'), null);
});
t('每条图片响应都带 x-img-type 供出口层识别', () => {
  assert.equal(res('text/html', 'u/a.png').headers.get('x-img-type'), 'rejected');
  assert.equal(res('image/svg+xml', 'u/a.svg').headers.get('x-img-type'), 'image/svg+xml');
  assert.equal(res('image/png', 'u/a.png').headers.get('x-img-type'), 'image/png');
});
t('降级时仍然保留 etag（只是不能再进 HTML 分支）', () => {
  assert.equal(res('text/html', 'u/a.png').headers.get('etag'), '"deadbeef"');
});

/* ---------------- 封面：SVG 不占封面位 ---------------- */
t('手动 cover 是 svg -> 丢弃，走预设图', () => {
  const p = { title: 't', cover: '/img/u/a.svg', created_at: '2026-11-01 00:00:00' };
  assert.ok(!/\.svg/.test(coverOf(p)), coverOf(p));
  assert.equal(isAutoCover(p), true);
});
t('手动 cover 带查询串的 svg 也丢弃', () => {
  assert.ok(!/\.svg/.test(coverOf({ cover: '/img/u/a.svg?w=10&h=10' })));
});
t('正文首图是 svg -> 不作为封面', () => {
  const p = { content: '![x](/img/u/a.svg)', created_at: '2026-11-01 00:00:00' };
  assert.ok(!/\.svg/.test(coverOf(p)), coverOf(p));
});
t('正文首图是位图 -> 正常当封面', () => {
  const p = { content: '![x](/img/u/a.webp)', created_at: '2026-11-01 00:00:00' };
  assert.equal(coverOf(p), '/img/u/a.webp');
});
t('手动位图 cover 优先于正文首图', () => {
  const p = { cover: '/img/u/own.png', content: '![x](/img/u/body.webp)' };
  assert.equal(coverOf(p), '/img/u/own.png');
  assert.equal(isAutoCover(p), false);
});
t('缩略图也不吐 svg', () => {
  const p = { cover: '/img/u/a.svg', created_at: '2026-11-01 00:00:00' };
  assert.ok(!/\.svg/.test(thumbOf(p)), thumbOf(p));
});

/* ---------------- key 的扩展名跟类型走 ---------------- */
t('makeKey 用声明的类型定扩展名，不听文件名', () => {
  const k = makeKey('a.png', 'image/svg+xml');
  assert.ok(k.endsWith('.svg'), k);
});
t('makeKey 位图类型不会被文件名带偏成 .svg', () => {
  const k = makeKey('a.svg', 'image/png');
  assert.ok(k.endsWith('.png'), k);
});
t('makeKey 没有类型时回退文件名后缀（avatar 那条路）', () => {
  assert.ok(makeKey('avatar.webp').endsWith('.webp'));
});
t('makeKey 生成的是 u/年月/ 前缀', () => {
  assert.match(makeKey('a.png', 'image/png'), /^u\/\d{6}\/[a-z0-9]+\.png$/);
});

if (fails.length) {
  console.error(`\n${fails.length} 条失败：`);
  for (const f of fails) console.error('  ✗ ' + f);
}
console.log(`svg 安全检查 ${pass}/${pass + fails.length} 通过`);
process.exit(fails.length ? 1 : 0);
