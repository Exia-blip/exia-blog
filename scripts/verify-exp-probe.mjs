// 逐条构造畸形 token，直接调本站的 verifyToken，看放行还是拒绝。
// 只在本机跑，不碰线上。
import crypto from 'node:crypto';

const SECRET = 'lab-secret';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

async function sign(payloadJson) {
  const p = b64u(Buffer.from(payloadJson, 'utf8'));
  const sig = crypto.createHmac('sha256', SECRET).update(p).digest();
  return `${p}.${b64u(sig)}`;
}

// 内联本站的校验逻辑（src/utils.js 的 verifyToken，逐字复制判断那一行）
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [p, s] = token.split('.');
  const expect = b64u(crypto.createHmac('sha256', SECRET).update(p).digest());
  if (expect !== s) return null;
  const data = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  // ↓ 就是这一行
  if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

const now = Math.floor(Date.now() / 1000);

const cases = {
  '缺 exp': JSON.stringify({ uid: 1 }),
  'exp 字符串': JSON.stringify({ uid: 1, exp: String(now + 3600) }),
  'exp 为 null': JSON.stringify({ uid: 1, exp: null }),
  'exp 用毫秒': JSON.stringify({ uid: 1, exp: (now + 3600) * 1000 }),
  'exp 是昨天': JSON.stringify({ uid: 1, exp: now - 86400 }),
};

for (const [name, json] of Object.entries(cases)) {
  const t = await sign(json);
  const r = verify(t);
  console.log(`${name.padEnd(12)} -> ${r ? '放行 200' : '拒绝 401'}   (${t.length} 字符)`);
}
