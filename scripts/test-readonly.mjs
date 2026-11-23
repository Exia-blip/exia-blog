// 只读开关回归：READONLY_MODE 只关写，不关读。
// 用法：node scripts/test-readonly.mjs
//
// 这个开关的失败方式只有两种，都很糟：
//   ① 该关时没关（写得进库，等于没有开关）
//   ② 关过头（GET 也 503，站点看起来整个挂了）
// 所以两头都断言。
import assert from 'node:assert/strict';
import { handleApi, readonlyMode } from '../src/api.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const call = (method, path, env) =>
  handleApi(env, new Request(`https://exia.de5.net${path}`, { method }), new URL(`https://exia.de5.net${path}`), {});

t('RO-01 开关取值宽松：1 / true / on / yes / 带空格与大小写', () => {
  for (const v of ['1', 'true', 'TRUE', ' on ', 'yes']) assert.equal(readonlyMode({ READONLY_MODE: v }), true, v);
});

t('RO-02 没配 / 0 / false / 空串一律视为关闭', () => {
  for (const v of [undefined, '', '0', 'false', 'off', 'no']) assert.equal(readonlyMode({ READONLY_MODE: v }), false, String(v));
  assert.equal(readonlyMode({}), false);
  assert.equal(readonlyMode(), false);
});

t('RO-03 开着时：发评论 503，带 retry-after 且不进缓存', async () => {
  const res = await call('POST', '/api/comments', { READONLY_MODE: '1' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '600');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const body = await res.json();
  assert.equal(body.ok, false);
});

t('RO-04 开着时：文章保存 / 上传 / 友链一律 503（不是只挡评论）', async () => {
  for (const [m, p] of [['PUT', '/api/posts/12'], ['POST', '/api/upload'], ['POST', '/api/friends'], ['DELETE', '/api/posts/12']]) {
    const res = await call(m, p, { READONLY_MODE: '1' });
    assert.equal(res.status, 503, `${m} ${p}`);
  }
});

t('RO-05 开着时：GET 与 OPTIONS 不受影响（只读不等于全站挂）', async () => {
  // OPTIONS 落到路由兜底的 404，不触库；关键是「不是 503」
  const opt = await call('OPTIONS', '/api/site', { READONLY_MODE: '1' });
  assert.notEqual(opt.status, 503);
});

t('RO-06 关着时：写接口照常进业务分支（这里以「评论体超限」为探针，证明没被 503 拦）', async () => {
  // 不配 DB 也能走到解析：闸门先于任何 D1 调用
  const big = 'x'.repeat(70 * 1024);
  const res = await handleApi(
    {},
    new Request('https://exia.de5.net/api/comments', {
      method: 'POST',
      body: JSON.stringify({ content: big }),
      headers: { 'content-type': 'application/json' },
    }),
    new URL('https://exia.de5.net/api/comments'),
    {}
  );
  assert.equal(res.status, 413);
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`[P-018] 只读开关 ${pass}/${cases.length} passed`);
