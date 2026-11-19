/**
 * 304 这条链的三段，各测一遍：
 *   1. tagOf()      —— 内容变才变，相对时间抖动不变（否则 304 永远命中不了）
 *   2. etagHit()    —— If-None-Match 的四种写法都得认
 *   3. maybe304()   —— 真正返回 304 且不带 body / content-encoding
 *
 * 为什么要这么较真：漏掉「相对时间去抖」这一条，ETag 每分钟翻新一次，
 * 表面上功能全在、注释齐全，实际一次 304 都命中不了 —— 这种 bug
 * 不看命中率永远发现不了。
 */
import { tagOf } from '../src/utils.js';
import { etagHit, maybe304, serverErrorPage, harden, isAdminPath } from '../src/index.js';

let pass = 0;
const fails = [];
const t = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};

/* ---- tagOf：稳定性 ---- */
const page = (n) => `<html><body><h1>文章</h1><p>正文 ${n}</p><time>3 分钟前</time></body></html>`;

t(tagOf('abc') === tagOf('abc'), '同样内容 → 同样 ETag（浏览器才可能命中）');
t(tagOf('abc') !== tagOf('abd'), '内容变一个字 → ETag 变');
/* 强 ETag 是 CF 边缘直接答 304 的前提，退化成 W/ 会让请求一路打到 Worker */
t(/^"/.test(tagOf('abc')), '是强 ETag（不带 W/）');
t(/"$/.test(tagOf('abc')), 'ETag 带引号（规范要求）');

/* 这条是核心：评论区的「3 分钟前」不该让整页 ETag 翻新 */
const t1 = tagOf('<p>3 分钟前</p>');
const t2 = tagOf('<p>17 分钟前</p>');
const t3 = tagOf('<p>刚刚</p>');
const t4 = tagOf('<p>2 天前</p>');
t(t1 === t2, '「3 分钟前」→「17 分钟前」不影响 ETag');
t(t1 === t3, '「3 分钟前」→「刚刚」不影响 ETag');
t(t1 === t4, '「3 分钟前」→「2 天前」不影响 ETag');

/* nonce 每次请求都随机，不归一化 ETag 就每次都变 —— 304 命中率恒为 0 */
const n1 = tagOf('<script nonce="a1b2c3d4e5f60718">x()</script>');
const n2 = tagOf('<script nonce="9988776655443322">x()</script>');
t(n1 === n2, 'CSP nonce 变化不影响 ETag');
t(tagOf('<script nonce="a1b2c3d4e5f60718">x()</script>') !== tagOf('<script nonce="a1b2c3d4e5f60718">y()</script>'), '脚本内容本身变化仍让 ETag 变');

/* 但正文本身变化必须让 ETag 变，别把归一化做过火了 */
t(tagOf(page(1)) !== tagOf(page(2)), '正文内容变化仍然让 ETag 变');

/* ---- etagHit：四种写法 ---- */
const e = 'W/"1f-9a3b"';
t(etagHit(e, e) === true, '完全一致 → 命中');
t(etagHit('"1f-9a3b"', e) === true, '客户端去掉 W/ 也命中');
t(etagHit(`"other", ${e}`, e) === true, '逗号列表里含目标 → 命中');
t(etagHit('*', e) === true, '通配 * → 命中');
t(etagHit('W/"nope"', e) === false, '不匹配 → 不命中');
t(etagHit('', e) === false, '没有 If-None-Match → 不命中');
t(etagHit(null, e) === false, 'null → 不命中');

/* ---- maybe304 ---- */
const makeRes = (etag) =>
  new Response('<html>big body</html>', {
    status: 200,
    headers: { 'content-type': 'text/html', etag, 'content-encoding': 'br', 'content-length': '18' },
  });
const req = (inm) => new Request('https://x.test/p/a', { headers: inm ? { 'if-none-match': inm } : {} });

const hit = maybe304(makeRes(e), req(e));
t(hit.status === 304, '匹配时返回 304', `status=${hit.status}`);
t(hit.body === null, '304 没有 body');
t(!hit.headers.get('content-encoding'), '304 去掉 content-encoding（否则客户端等一个不会来的实体）');
t(!hit.headers.get('content-length'), '304 去掉 content-length');
t(!!hit.headers.get('cache-control'), '304 仍带 cache-control（客户端要知道多久后再来问）');
t(!hit.headers.get('content-security-policy'), '304 不发新 CSP（新 nonce 会打死浏览器里那份旧 body 的内联脚本）');

const miss = maybe304(makeRes(e), req('W/"other"'));
t(miss.status === 200, '不匹配时原样返回 200');

t(maybe304(makeRes(''), req('*')).status === 200, '没有 ETag 的响应不会被改成 304');
t(maybe304(makeRes(e), new Request('https://x.test/p/a', { method: 'POST' })).status === 200, '非 GET/HEAD 不做 304');
{
  const err = new Response('boom', { status: 500, headers: { etag: e } });
  t(maybe304(err, req(e)).status === 500, '5xx 不参与 304（错误不该被当成缓存命中）');
}

/* ---- 500 页 ---- */
const e500 = serverErrorPage();
t(/回到首页/.test(e500) && /href="\/"/.test(e500), '500 页有回首页入口');
t(!/\/style\.css|\/boot\.js/.test(e500), '500 页不依赖站内资源（静态资源可能正是故障源）');
t(/prefers-color-scheme:\s*dark/.test(e500), '500 页跟随系统深色');
t(/noindex/.test(e500), '500 页不让搜索引擎收录');

/* ---- 后台页不进缓存：部署后必须立刻可见 ----
   元凶是 harden() 给所有正常页套 cdn-cache-control（边缘 300s + swr 1 天），
   后台页跟着被缓存，表现为「部署了刷新还是旧界面」。这些断言守住后台 no-store，
   同时确认公开页缓存口径一字未动。 */
t(isAdminPath('/editor') && isAdminPath('/admin/stats') && isAdminPath('/editor?x=1'.split('?')[0]),
  '后台路径判定：editor / admin 都算');
t(!isAdminPath('/') && !isAdminPath('/p/a') && !isAdminPath('/archive'), '公开路径不算后台');
{
  const html = new Response('<!doctype html><p>x</p>', { headers: { 'content-type': 'text/html' } });
  const admin = await harden(html.clone(), {}, '/editor');
  t(admin.headers.get('cache-control') === 'private, no-store', '后台页浏览器不缓存');
  t(admin.headers.get('cdn-cache-control') === 'private, no-store', '后台页 CF 边缘不缓存（根治旧副本）');

  const pub = await harden(html.clone(), {}, '/');
  t(/s-maxage=/.test(pub.headers.get('cdn-cache-control') || ''), '公开页仍走边缘缓存（不受影响）');
  t(/max-age=0/.test(pub.headers.get('cache-control') || ''), '公开页浏览器仍每次校验（不受影响）');
}

console.log(`\nETag / 304: ${pass} 通过${fails.length ? `，${fails.length} 失败` : ''}`);
if (fails.length) process.exit(1);
