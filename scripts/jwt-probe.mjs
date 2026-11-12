// 起一个本地 /api/me，用真实的 verifyToken 校验，五枚畸形 token 各打一次。
// 输出直接贴进 article 15。
import http from 'node:http';
import crypto from 'node:crypto';
import { verifyToken } from '../src/utils.js';

const SECRET = 'lab-secret';
const PORT = 8787;

const mint = (claims) => {
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return `${p}.${sig}`;
};

const server = http.createServer(async (req, res) => {
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1] || '';
  const claims = await verifyToken(SECRET, decodeURIComponent(cookie));
  res.writeHead(claims ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(claims ? { ok: true, uid: claims.uid } : { ok: false, error: '未登录' }));
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const now = Math.floor(Date.now() / 1000);
const cases = [
  ['正常，10 分钟后过期', { uid: 7, exp: now + 600 }],
  ['过期 30 秒', { uid: 7, exp: now - 30 }],
  ['没有 exp', { uid: 7 }],
  ['exp 写成毫秒', { uid: 7, exp: Date.now() + 600_000 }],
  ['exp 正好是现在', { uid: 7, exp: now }],
];

for (const [label, claims] of cases) {
  const tk = mint(claims);
  const r = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { cookie: `sid=${tk}` } });
  const body = (await r.text()).slice(0, 60);
  console.log(`${label.padEnd(22)} ${r.status} ${body}`);
}

server.close();
