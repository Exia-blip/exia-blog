// P1 写作页服务端门禁守门：匿名不得拿到 55KB 后台骨架，登录态零影响。
// 直接测 editorGate()，mock env.DB + 用真 signToken 造 cookie，不依赖 dev server。
// 用法：node scripts/test-editor-gate.mjs
import assert from 'node:assert/strict';
import { signToken } from '../src/utils.js';
import { editorGate, isAdminPath } from '../src/index.js';

const SECRET = 'gate-test-secret';
const USER = { id: 7, login: 'exia', name: 'Exia', avatar: '', email: '', is_admin: 1 };

// mock：DB.first() 按 uid 决定是否返回用户
const envFor = (found) => ({
  SESSION_SECRET: SECRET,
  DB: {
    prepare() {
      return { bind() { return { async first() { return found ? USER : null; } }; } };
    },
  },
});

const req = (url, cookie) =>
  new Request(url, { headers: cookie ? { cookie: `sid=${cookie}` } : {} });

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('匿名访问 /editor → 302 到 /login，next 为原始路径', async () => {
  const res = await editorGate(envFor(false), req('https://exia.de5.net/editor'), '/editor');
  assert.ok(res, '匿名应被门禁拦截');
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get('location'));
  assert.equal(to.pathname, '/login');
  assert.equal(to.searchParams.get('next'), '/editor');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-length'), null, '302 不应带骨架');
  const body = await res.text();
  assert.equal(body, '', '门禁响应无 body');
});

t('next 含查询串时原样带回（编辑视图 panel 不丢）', async () => {
  const res = await editorGate(envFor(false), req('https://exia.de5.net/editor?panel=posts&x=1'), '/editor');
  const to = new URL(res.headers.get('location'));
  assert.equal(to.searchParams.get('next'), '/editor?panel=posts&x=1');
});

t('/editor/* 子路径同样拦截', async () => {
  const res = await editorGate(envFor(false), req('https://exia.de5.net/editor/anything'), '/editor/anything');
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).searchParams.get('next'), '/editor/anything');
});

t('带合法 sid → 放行（返回 null，走原交付流程）', async () => {
  const token = await signToken(SECRET, { uid: 7, admin: 1 }, 60);
  const res = await editorGate(envFor(true), req('https://exia.de5.net/editor', token), '/editor');
  assert.equal(res, null, '登录态不应被拦截');
});

t('伪造/过期 sid → 仍拦截', async () => {
  const bad = await signToken('wrong-secret', { uid: 7 }, 60);
  const res1 = await editorGate(envFor(true), req('https://exia.de5.net/editor', bad), '/editor');
  assert.equal(res1.status, 302, '错密钥 token 应拦截');
  const expired = await signToken(SECRET, { uid: 7 }, -1);
  const res2 = await editorGate(envFor(true), req('https://exia.de5.net/editor', expired), '/editor');
  assert.equal(res2.status, 302, '过期 token 应拦截');
});

t('DB 查不到用户（uid 被删）→ 拦截', async () => {
  const token = await signToken(SECRET, { uid: 999 }, 60);
  const res = await editorGate(envFor(false), req('https://exia.de5.net/editor', token), '/editor');
  assert.equal(res.status, 302);
});

t('非 editor 路径不受门禁影响', async () => {
  for (const p of ['/', '/p/post-brfy5', '/api/posts', '/auth/github', '/admin/stats', '/login', '/editor.html']) {
    const res = await editorGate(envFor(false), req(`https://exia.de5.net${p}`), p);
    assert.equal(res, null, `${p} 不应被 editorGate 拦截`);
  }
});

t('isAdminPath 覆盖 editor 全族，语义与门禁一致', () => {
  assert.ok(isAdminPath('/editor'));
  assert.ok(isAdminPath('/editor/anything'));
  assert.ok(!isAdminPath('/editor.html'));
  assert.ok(!isAdminPath('/'));
});

let pass = 0;
for (const [name, fn] of cases) {
  await fn();
  pass++;
}
console.log(`\neditor gate: ${pass} passed`);
