// 主域归一回归：旧域整站 301 到 SITE_ORIGIN。
// 用法：node scripts/test-host-redirect.mjs
//
// 这条规则守的是「换主域只做了一半」：canonical / sitemap / RSS 都指向新域了，
// 旧域照样 200 并吐全站内容 —— 两个域名各被抓一遍、两个 zone 各算一份统计。
// 断言只看纯函数的输出，不看响应对象：判据是「跳不跳、跳到哪、用什么码」。
import assert from 'node:assert/strict';
import { hostRedirect, isLocalHost, configuredOrigin } from '../src/utils.js';

const NEW = 'https://miu.sryze.cc';
const env = { SITE_ORIGIN: NEW };

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* U-01 旧域整站 301：这是整条规则的唯一目的，先测它 */
t('U-01 旧域首页 → 301 主域', () => {
  const r = hostRedirect(env, new URL('https://exia.de5.net/'));
  assert.equal(r.status, 301);
  assert.equal(r.location, 'https://miu.sryze.cc/');
});

/* U-02 query 必须原样带过去。压成首页等于把分页吞掉，而 `/?page=2`
   在旧域上是历史外链的常见形态 */
t('U-02 旧域分页保留 query', () => {
  const r = hostRedirect(env, new URL('https://exia.de5.net/?page=2'));
  assert.equal(r.location, 'https://miu.sryze.cc/?page=2');
});

/* U-03 深路径 + 多参数，顺序不能乱 */
t('U-03 旧域深路径与多参数逐字保留', () => {
  const r = hostRedirect(env, new URL('https://exia.de5.net/p/cache-key-host-normalization?utm=1&page=3'));
  assert.equal(r.location, 'https://miu.sryze.cc/p/cache-key-host-normalization?utm=1&page=3');
});

/* U-04 主域自身不能跳 —— 否则整站无限重定向 */
t('U-04 主域不跳', () => {
  assert.equal(hostRedirect(env, new URL('https://miu.sryze.cc/p/x')), null);
});

/* U-05 www / 别的别名同样归到主域 */
t('U-05 www 变体 → 301 主域', () => {
  assert.equal(hostRedirect(env, new URL('https://www.miu.sryze.cc/')).location, 'https://miu.sryze.cc/');
  assert.equal(hostRedirect(env, new URL('https://exia-blog.meitu.workers.dev/')).status, 301);
});

/* U-06 本地放行。不放行的话 wrangler dev 第一跳就飞出本机，
   本地就再也没法验任何页面 —— 这是最容易把开发环境弄坏的一条 */
t('U-06 本地 host 不跳', () => {
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(hostRedirect(env, new URL(`http://${h}:8787/`)), null, h);
    assert.ok(isLocalHost(h), h);
  }
});

/* U-07 没配 SITE_ORIGIN 时必须完全不动作。
   这是最容易写错的一条：拿「主域」当 `configuredOrigin() || 请求自己`，
   于是每个请求都等于「请求自己」，看起来无害；但只要回落后再比较，
   换个写法（比如回落到 'https://localhost'）就会把整站跳走。
   判据落在「配了没有」而不是「等于谁」上。 */
t('U-07 SITE_ORIGIN 未配 → 不跳', () => {
  assert.equal(configuredOrigin({}), null);
  assert.equal(hostRedirect({}, new URL('https://exia.de5.net/')), null);
  assert.equal(hostRedirect({ SITE_ORIGIN: '   ' }, new URL('https://a.com/')), null);
});

/* U-08 配错的 SITE_ORIGIN 当没配：不能让一个笔误把整站 301 到不存在的域 */
t('U-08 SITE_ORIGIN 非法 → 不跳', () => {
  for (const bad of ['exia.de5.net', 'ftp://a.com', 'https://', '::::']) {
    assert.equal(configuredOrigin({ SITE_ORIGIN: bad }), null, bad);
    assert.equal(hostRedirect({ SITE_ORIGIN: bad }, new URL('https://b.com/')), null, bad);
  }
});

/* U-09 写请求用 308：301 会让浏览器把 POST 降级成 GET 并丢掉 body，
   评论提交、OAuth 回调都会静默变成读请求 */
t('U-09 POST/PUT 用 308 保方法', () => {
  assert.equal(hostRedirect(env, new URL('https://exia.de5.net/api/comments'), 'POST').status, 308);
  assert.equal(hostRedirect(env, new URL('https://exia.de5.net/api/posts/1'), 'PUT').status, 308);
  assert.equal(hostRedirect(env, new URL('https://exia.de5.net/auth/callback'), 'GET').status, 301);
  assert.equal(hostRedirect(env, new URL('https://exia.de5.net/'), 'HEAD').status, 301);
});

/* U-10 SITE_ORIGIN 里多写的东西一律不参与：只取 origin。
   写 `/x/` 或带端口时，拼出来的地址不能把路径带进每一页 */
t('U-10 SITE_ORIGIN 带尾斜杠与路径时只取 origin', () => {
  assert.equal(
    hostRedirect({ SITE_ORIGIN: ' https://miu.sryze.cc/x/ ' }, new URL('https://old.com/p/a')).location,
    'https://miu.sryze.cc/p/a'
  );
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
console.log(`\n[P-085] host redirect: ${pass}/${cases.length} passed`);
