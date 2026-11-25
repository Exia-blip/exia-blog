#!/usr/bin/env node
/* 评论端到端「人工那一跳」的观察脚本。
 *
 * 不自动化提交，也不自动化点验证码：managed 模式在无头/有头自动化浏览器都拿不到
 * token，真提交必须有人点一次。脚本只做两件机器能做的事：
 *   ① 生成唯一标记给真人填进评论内容；
 *   ② 提交后从两个**独立**数据源确认同一标记同时出现在
 *      - 站点公开评论接口（D1 查，证明落库）
 *      - sink inbox（KV 查，证明 notifyComment 真触发、真发到 sink）
 * 两边都命中才算过；只有一边命中要明确报出是哪半步断了，不拿另一边推断。
 *
 * 用法：
 *   export SINK_URL='https://.../inbox?token=...'   # token 只从环境读，脚本不打印
 *   npm run verify:comment-e2e -- <slug> [--origin=https://miu.sryze.cc] [--timeout=180]
 *   node scripts/verify-comment-e2e.mjs --check      # 判据自检（离线，已挂进 npm test）
 *
 * 判据自检进 npm test，人工那一跳不进：两件事别混。
 * 自检是纯函数喂固定输入，改坏判据会红；「真点一次验证码」不可能被它代替。
 */
import { randomBytes } from 'node:crypto';

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

/* ---------------- 判据（纯函数，自检注入用） ---------------- */

/* 公开评论接口返回 { ok, total, comments: [{ content, replies: [...] }] }。
   回复嵌在 replies 里，只看顶层会漏。 */
const findLanding = (body, nonce) => {
  let d;
  try {
    d = JSON.parse(body);
  } catch {
    return false;
  }
  const nodes = Array.isArray(d.comments) ? d.comments : [];
  const has = (c) => typeof c?.content === 'string' && c.content.includes(nonce);
  return nodes.some((c) => has(c) || (Array.isArray(c.replies) && c.replies.some(has)));
};

/* sink inbox 返回 { items: [{ key, body }] }。body 是 POST 原文。
   两个条件缺一不可：带 nonce 证明是这次评论，带「💬 新评论」证明是 notifyComment
   发的而不是冒烟的 🔔 或待审的 [待办] ——形状判据独立，不挂在 nonce 自己身上。 */
const findNotice = (body, nonce) => {
  let d;
  try {
    d = JSON.parse(body);
  } catch {
    return false;
  }
  const items = Array.isArray(d.items) ? d.items : [];
  return items.some((i) => {
    const s = typeof i?.body === 'string' ? i.body : '';
    return s.includes(nonce) && s.includes('💬 新评论');
  });
};

const verdict = (landed, notified) => (landed && notified ? 'pass' : landed ? 'landed-only' : notified ? 'notified-only' : 'none');

/* ---------------- 判据自检（手工跑；注入先红后恢复） ---------------- */
function selfCheck() {
  const nonce = 'E2E-SELFCHECK-0001';
  const commentBody = (content) => JSON.stringify({ ok: true, total: 1, comments: [{ content, replies: [] }] });
  const inboxBody = (...bodies) => JSON.stringify({ items: bodies.map((b, i) => ({ key: `k${i}`, body: b })) });
  const notice = `💬 新评论 · 测试\n石井：${nonce}\n🔗 https://miu.sryze.cc/p/test`;
  const cases = [
    { name: '两边都在 → 绿', landed: findLanding(commentBody(nonce), nonce), notified: findNotice(inboxBody(notice), nonce), want: 'pass' },
    { name: '只落库没通知 → 红', landed: findLanding(commentBody(nonce), nonce), notified: findNotice(inboxBody(''), nonce), want: 'landed-only' },
    { name: '只通知没落库 → 红', landed: findLanding(commentBody('别的内容'), nonce), notified: findNotice(inboxBody(notice), nonce), want: 'notified-only' },
    { name: '冒烟 🔔 带 nonce 冒充通知 → 红', landed: findLanding(commentBody(nonce), nonce), notified: findNotice(inboxBody(`🔔 写入后回打：${nonce}`), nonce), want: 'landed-only' },
    { name: '回复里带 nonce 也要算落库', landed: findLanding(JSON.stringify({ comments: [{ content: '父评论', replies: [{ content: nonce }] }] }), nonce), notified: findNotice(inboxBody(notice), nonce), want: 'pass' },
    { name: '空集恒真防护：两边都空 → 红', landed: findLanding('{}', nonce), notified: findNotice('{}', nonce), want: 'none' },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = verdict(c.landed, c.notified);
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name} → ${got}${ok ? '' : `（要 ${c.want}）`}`);
  }
  console.log(`\n判据自检 ${cases.length - bad}/${cases.length} passed`);
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--check')) selfCheck();

/* ---------------- 真跑 ---------------- */
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const slug = args[0];
if (!slug) die('用法：npm run verify:comment-e2e -- <slug> [--origin=...] [--timeout=180]');

const origin = opt('origin', 'https://miu.sryze.cc').replace(/\/$/, '');
const timeout = Math.max(30, Number(opt('timeout', '180')) || 180);
const sinkUrl = process.env.SINK_URL || '';
if (!sinkUrl) die('缺少 SINK_URL 环境变量。本机 export SINK_URL=\'<inbox 地址带 token>\' 后再跑；token 不写进文件、不贴给任何人。');

let sink;
try {
  sink = new URL(sinkUrl);
} catch {
  die('SINK_URL 不是合法 URL');
}
if (!sink.pathname.endsWith('/inbox') || !sink.searchParams.get('token')) {
  die('SINK_URL 必须指向 /inbox 且带 token 参数');
}
/* 脱敏：只露 scheme+host+path，query（含 token）永不进 stdout/stderr */
const sinkShown = `${sink.origin}${sink.pathname}`;
const nonce = `E2E-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)}-${randomBytes(3).toString('hex')}`;
const pageUrl = `${origin}/p/${slug}`;

console.log('\n评论端到端：人工点一次验证码 + 机器观察两处独立证据\n');
console.log(`  1. 在浏览器打开 ${pageUrl}`);
console.log('  2. 真点一次 Turnstile 验证码（managed 模式自动化拿不到 token，这一步只能是人）');
console.log(`  3. 发表评论，内容里**原样带上这段标记**：${nonce}`);
console.log('     看到「评论已发布」即算提交成功；若开了「评论先审后发」，先关掉再提交，');
console.log('     否则评论进 pending：公开接口看不到，走的是 notifyTodo 而不是 notifyComment。');
console.log(`\n  脚本开始轮询，最多 ${timeout}s：`);
console.log(`    A 站点公开评论接口 ${origin}/api/comments?slug=${slug}  ← D1 查，证明落库`);
console.log(`    B sink inbox ${sinkShown}  ← KV 查，证明 notifyComment 真触发`);
console.log('  （B 的 token 从环境读，不在命令回显、不写日志、不打印）\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'cache-control': 'no-cache' } });
  return { ok: r.ok, status: r.status, body: await r.text() };
};

const deadline = Date.now() + timeout * 1000;
let landed = false;
let notified = false;
let lastErr = '';
let rounds = 0;
while (Date.now() < deadline && !(landed && notified)) {
  rounds++;
  try {
    const [a, b] = await Promise.all([
      get(`${origin}/api/comments?slug=${encodeURIComponent(slug)}&cb=${Date.now()}`),
      get(sinkUrl),
    ]);
    if (a.ok && !landed) landed = findLanding(a.body, nonce);
    if (b.ok && !notified) notified = findNotice(b.body, nonce);
    if (!a.ok) lastErr = `评论接口 HTTP ${a.status}`;
    if (!b.ok) lastErr = `inbox HTTP ${b.status}`;
  } catch (e) {
    lastErr = e.message;
  }
  if (landed && notified) break;
  await sleep(2000);
}

const v = verdict(landed, notified);
console.log(`\n轮次 ${rounds}：落库=${landed ? '命中' : '未命中'} / 通知=${notified ? '命中' : '未命中'}`);
if (v === 'pass') {
  console.log('✓ 端到端已验：真人点验证码 → 评论落库 → notifyComment → sink 收到 💬 新评论。');
  console.log('  DEPLOY.md 里「评论落库 → 触发 notifyComment」和「浏览器真过 Turnstile」两行可以改成已验；');
  console.log('  记得带上这次的时间与标记，别写成「脚本跑过就算」。');
  process.exit(0);
}

if (v === 'landed-only') {
  console.log('✗ 评论落库了，但 sink 没收到这条通知。');
  console.log('  读码结论「落库 → 触发 notifyComment」被推翻：查 wrangler tail 的 [webhook] 日志、');
  console.log('  WEBHOOK_URL 是否正确、sink 是否可达。不要拿冒烟通过代替这一步。');
} else if (v === 'notified-only') {
  console.log('✗ sink 收到通知，但公开评论接口看不到这条评论。');
  console.log('  可能是开了先审后发（评论进 pending），或 D1 写入与公开读之间有问题；');
  console.log('  先确认审核开关，再看后台评论列表。');
} else {
  console.log('✗ 两处都没命中。');
  console.log('  常见原因：没真点验证码就提交了、评论内容没带上标记、开了先审后发、');
  console.log(`  提交请求失败（看页面提示），或观测接口不可达${lastErr ? `（最近一次：${lastErr}）` : ''}。`);
}
console.log('\n这是自动化先红后的停手点：回到浏览器人工点一次，不是缺代码。');
process.exit(1);
