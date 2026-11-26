#!/usr/bin/env node
/**
 * 补发一条评论的群通知。
 *
 * 为什么是脚本而不是后台按钮：/admin/notify 是只读明细页，通知没有幂等性，
 * 在那里加「重发」等于给每个误点开一条写路径。所以补发单独成端点
 * （POST /api/comments/notify，仅管理员）+ 这个 CLI，后台页面不动。
 *
 * 用法：
 *   npm run notify:resend                      # 补发最新一条（刚发完评论就用这个）
 *   npm run notify:resend -- --id=57           # 补发指定 id
 *   npm run notify:resend -- --origin=http://127.0.0.1:8788   # 打本地 wrangler dev
 *
 * 判据：退出码 0 只在平台回执为 ok 时给。fail / skip 各有各的退出码和下一步，
 * 不存在「命令跑完了所以应该成功了」这种模糊态。
 */
import { adminCookie } from './lib/session.mjs';

const die = (msg, code = 1) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(code);
};
const arg = (k, d = '') => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const ORIGIN = arg('origin', 'https://miu.sryze.cc').replace(/\/$/, '');
const uid = Number(arg('uid', '1')) || 1;
const ttl = Math.max(30, Math.min(Number(arg('ttl', '120')) || 120, 3600));
const idRaw = arg('id', '').trim();
const id = idRaw ? parseInt(idRaw, 10) : 0;
if (idRaw && !(Number.isInteger(id) && id > 0)) die(`--id 要是正整数，收到「${idRaw}」`);

const cred = await adminCookie({ origin: ORIGIN, uid, ttl });
if (!cred.cookie) {
  die(
    cred.local
      ? `缺 ${cred.need}：本地 .dev.vars 配好（wrangler dev 用的就是它），或 export ${cred.need}=... 后重跑。`
      : `缺 ${cred.need}：在本机 .dev.vars 补一行 ${cred.need}=<线上现役 SESSION_SECRET>（已 gitignore）。\n   别拿 dev 的 SESSION_SECRET 去试线上 —— 两者不同源，签出来必然 401。`
  );
}

console.log(
  `补发：${ORIGIN} · ${cred.local ? 'dev 版' : '线上版'} · 凭据 ${cred.from} · ${
    id ? `id=${id}` : '不指定 id（取最新一条）'
  }`
);

const post = () =>
  fetch(`${ORIGIN}/api/comments/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cred.cookie },
    body: JSON.stringify(id ? { id } : {}),
    signal: AbortSignal.timeout(15000),
  });

let r = await post();
let body = null;
try {
  body = await r.json();
} catch {}

/* 3 秒窗口挡的是「连按两次命令」，不是排障。撞上了等一下就重试一次，
   让操作者永远不必自己去猜这个 429。 */
if (r.status === 429 && Number(body?.retry) > 0) {
  const wait = Math.min(Number(body.retry) * 1000 + 200, 5000);
  console.log(`  3 秒内刚投递过，等 ${wait}ms 自动重试一次`);
  await new Promise((res) => setTimeout(res, wait));
  r = await post();
  try {
    body = await r.json();
  } catch {}
}

if (r.status === 401) die('401：票没被认。多半是 LIVE_SESSION_SECRET 与线上 SESSION_SECRET 不是同一个值（换过密钥没同步）。', 3);
if (r.status === 403) die('403：这个 uid 不是管理员。用 --uid=<管理员 id>。', 3);
if (r.status === 404) die(`404：${body?.error || '没有可补发的评论'}`, 3);
if (r.status === 409) die(`409：${body?.error || '这条评论不该补发'}`, 3);
if (!r.ok) die(`HTTP ${r.status}：${body?.error || '未知错误'}`, 3);

const st = body?.notify?.status || '';
const note = body?.notify?.note || '';
console.log(`  评论 #${body.id}（${body.status}）→ 投递 ${st}${note ? ` · ${note}` : ''}`);

if (st === 'ok') {
  console.log('\n✓ 平台已接受。群里应该已经跳出这条消息；后台 /admin/comments 那一列会写「已送达」。');
  process.exit(0);
}
if (st === 'skip') {
  console.error(
    '\n✗ skip：线上没拿到 WEBHOOK_URL（没配，或 secret put 写成了空串 —— workers-sdk#16193）。\n' +
      '   修：npm run setup:webhook（脚本写入前后各探一次，平台码非 0 会自己报错退出）。'
  );
  process.exit(2);
}
console.error(
  `\n✗ fail${note ? `：${note}` : ''}\n` +
    (/93000/.test(note)
      ? '   93000 = 企微地址失效（群机器人被删 / token 轮换）。重配：npm run setup:webhook。\n'
      : '') +
    '   排查顺序：先确认对端活着（curl 那条地址），再读 wrangler tail 里的 [webhook] 日志。'
);
process.exit(1);
