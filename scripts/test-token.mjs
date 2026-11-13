// 会话票（HMAC token）回归：签名、过期、形状。
// 用法：node scripts/test-token.mjs
//
// 重点不是「正常 token 能用」——那条一年也不会坏一次。重点在几条绕过路径：
// 去掉 exp 的 token、exp 写成字符串的 token、多出一段的 token。
// 这三种过去都能通过校验。
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/utils.js';

const SECRET = 'test-secret-do-not-use';
const now = () => Math.floor(Date.now() / 1000);

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* 自己拼一个 token：utils 的 signToken 总会补 exp，造不出「没有 exp」的样本。
   签名算法必须和实现一致（HMAC-SHA256 over base64url(payload)），否则测的是拼装而不是校验。 */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
async function forge(payload) {
  const p = b64u(Buffer.from(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p));
  return `${p}.${b64u(new Uint8Array(sig))}`;
}

t('正常签发的 token 能验回原 payload', async () => {
  const token = await signToken(SECRET, { uid: 7, admin: 1 }, 60);
  const data = await verifyToken(SECRET, token);
  assert.ok(data, '应当校验通过');
  assert.equal(data.uid, 7);
  assert.equal(data.admin, 1);
});

t('换一个 secret 就验不过', async () => {
  const token = await signToken(SECRET, { uid: 7 }, 60);
  assert.equal(await verifyToken('another-secret', token), null);
});

t('改 payload 不重签，签名对不上', async () => {
  const token = await signToken(SECRET, { uid: 7 }, 60);
  const [p, s] = token.split('.');
  const tampered = JSON.parse(Buffer.from(p, 'base64url').toString());
  tampered.uid = 1; // 把自己改成管理员
  const forged = `${b64u(Buffer.from(JSON.stringify(tampered)))}.${s}`;
  assert.equal(await verifyToken(SECRET, forged), null);
});

t('已经过期的 token 无效', async () => {
  const token = await forge({ uid: 7, exp: now() - 1 });
  assert.equal(await verifyToken(SECRET, token), null);
});

/* 边界：exp 恰好等于当前秒。
   原来写 `data.exp < now`，这一秒内仍然有效；改成 `<=` 后这一秒就已经失效。
   差值只有一秒，但「到期」的定义应当是「到点即止」，不是「到点再多给一秒」。 */
t('exp 恰好是当前秒，算已过期', async () => {
  const token = await forge({ uid: 7, exp: now() });
  assert.equal(await verifyToken(SECRET, token), null);
});

t('差一秒到期，仍然有效', async () => {
  const token = await forge({ uid: 7, exp: now() + 2 });
  assert.ok(await verifyToken(SECRET, token), '临期 token 不该被提前判死');
});

/* 这一条是这次修的主 bug：没 exp 时 `data.exp && ...` 直接短路，
   签名正确就永久有效。会话票改成永久票只需要删一个字段。 */
t('没有 exp 字段的 token 一律无效', async () => {
  const token = await forge({ uid: 7 });
  assert.equal(await verifyToken(SECRET, token), null);
});

t('exp 是字符串也无效，不给类型转换留口子', async () => {
  assert.equal(await verifyToken(SECRET, await forge({ uid: 7, exp: String(now() + 60) })), null);
  assert.equal(await verifyToken(SECRET, await forge({ uid: 7, exp: 'never' })), null);
});

t('exp 为 0 / null / NaN 都不算有效', async () => {
  assert.equal(await verifyToken(SECRET, await forge({ uid: 7, exp: 0 })), null);
  assert.equal(await verifyToken(SECRET, await forge({ uid: 7, exp: null })), null);
  // JSON 里 NaN 序列化成 null，改用一个不可能通过 Number.isFinite 的对象形状
  assert.equal(await verifyToken(SECRET, await forge({ uid: 7, exp: {} })), null);
});

t('多出一段的 token 直接判无效', async () => {
  const token = await signToken(SECRET, { uid: 7 }, 60);
  assert.equal(await verifyToken(SECRET, `${token}.extra`), null);
});

t('空值、无点、纯垃圾都返回 null 而不是抛异常', async () => {
  for (const bad of ['', null, undefined, 'nodot', '.', 'a.b', '..', 'x'.repeat(500)]) {
    assert.equal(await verifyToken(SECRET, bad), null, `输入 ${JSON.stringify(bad)} 应当返回 null`);
  }
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
console.log(`\n${pass}/${cases.length} passed`);
