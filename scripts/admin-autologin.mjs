#!/usr/bin/env node
/* /editor 自动登录 + 后台「状态可见」自动验收。
 *
 * 为什么不动登录层：
 *   currentUser() 认的是 signToken(SESSION_SECRET, {uid, admin}) 签出的 sid cookie，
 *   editorGate / requireAdmin 只是它的包装。自动化只要能出示一个合法 sid，
 *   /editor 与 /admin/* 就照常放行 —— 匿名访问仍然 302，线上零新入口、零新旁路、
 *   零鉴权降级，也不需要为此部署一次。
 *   反过来「给登录层加个自动放行分支」才是真降档：那就是一把新的万能钥匙。
 *
 * 密钥只从本机读，绝不打印、绝不写进仓库、绝不进对话：
 *   1) 环境变量 LIVE_SESSION_SECRET      （推荐：线上现役 SESSION_SECRET）
 *   2) .dev.vars 的 LIVE_SESSION_SECRET  （推荐，文件已 gitignore）
 *   3) .dev.vars 的 SESSION_SECRET      （仅本地 wrangler dev 同源时适用）
 *   也可以直接给现成的管理员会话：环境变量 ADMIN_SID（不推荐，泄露窗口 30 天，
 *   且本仓库退出登录没有服务端吊销；自签短效票才是这个仓库该用的形状）。
 *
 * 实测前提（2026-11-26）：本机 .dev.vars 的三个值与线上 SESSION_SECRET 都不同源，
 *   自签票打线上会 302。脚本会明确报「密钥不同源」，不把「签出来了」当「登录成功」。
 *   线上要自动登录，只需老板在本机 .dev.vars 补一行 LIVE_SESSION_SECRET=<线上值>。
 *
 * 用法：
 *   node scripts/admin-autologin.mjs --check                     # 判据自检（离线，已挂进 npm test）
 *   node scripts/admin-autologin.mjs --origin=https://miu.sryze.cc [--uid=1] [--ttl=300]
 *   node scripts/admin-autologin.mjs --origin=http://127.0.0.1:8788   # 本地 dev，.dev.vars 同源即可
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const arg = (k, d = '') => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

/* ---------------- 判据（纯函数，自检注入用） ---------------- */

/* 页面验收：状态码与内容标记必须同时成立。
   只查 body 不查 302 会把登录页的 HTML 读成「后台已进」；只查 200 不查标记
   会把「进去了但状态条没渲染」读成通过。空 body 一律红（空集恒真防护）。 */
const PAGES = [
  { path: '/editor', name: '写作页自动放行 + 新列表代码', marks: ['published_at_raw', 'flag-approved'] },
  { path: '/admin/comments', name: '评论通知送达状态条', marks: ['评论通知送达', '未验（读码结论）'] },
  { path: '/admin/friends', name: '友链巡检时间戳', marks: ['检测 '] },
  { path: '/admin/review', name: '审核队列可达', marks: [] },
];

const checkPage = (status, body, marks) => {
  if (status !== 200) return { ok: false, missing: [`HTTP ${status}`] };
  if (typeof body !== 'string' || body.length < 100) return { ok: false, missing: ['响应体为空或过短'] };
  const missing = marks.filter((m) => !body.includes(m));
  return { ok: missing.length === 0, missing };
};

/* ---------------- 离线判据自检（--check） ---------------- */

async function selfCheck() {
  const { signToken } = await import('../src/utils.js');
  const { currentUser } = await import('../src/auth.js');
  const { readFileSync: read } = await import('node:fs');
  let pass = 0;
  let fail = 0;
  const t = (name, cond, extra = '') => {
    if (cond) {
      pass++;
      console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`);
    } else {
      fail++;
      console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`);
    }
  };
  const SECRET = 'selfcheck-secret-not-a-real-key';

  /* 真链路：内存 users 表 + 假 D1，走 verifyToken → 回库查 is_admin。
     不是「自己验自己」的替身：签票、解析 cookie、回库都跑的是线上同一份实现。 */
  const mem = new DatabaseSync(':memory:');
  mem.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT, name TEXT, avatar TEXT, email TEXT, is_admin INTEGER)');
  mem.prepare('INSERT INTO users (id, login, name, avatar, email, is_admin) VALUES (?,?,?,?,?,?)').run(1, 'boss', 'boss', '', '', 1);
  const env = {
    SESSION_SECRET: SECRET,
    DB: {
      prepare: (sql) => ({ bind: (...args) => ({ first: async () => mem.prepare(sql).get(...args) || null }) }),
    },
  };
  const reqWith = (token) => new Request('https://example.test/editor', { headers: { cookie: `sid=${encodeURIComponent(token)}` } });

  const good = await signToken(SECRET, { uid: 1, admin: 1 }, 300);
  const user = await currentUser(env, reqWith(good));
  t('AL-01 自签会话被 currentUser 认出且回库查到管理员', user?.id === 1 && user?.is_admin === 1);

  t('AL-02 匿名访问仍无人（登录层零降级）', (await currentUser(env, new Request('https://example.test/editor'))) === null);
  t('AL-03 篡改签名的票被拒', (await currentUser(env, reqWith(good.slice(0, -2) + 'xy'))) === null);
  t('AL-04 过期票被拒', (await currentUser(env, reqWith(await signToken(SECRET, { uid: 1, admin: 1 }, -1)))) === null);
  t('AL-05 用错密钥签的票被拒', (await currentUser(env, reqWith(await signToken('another-secret', { uid: 1, admin: 1 }, 300)))) === null);
  t('AL-06 库里不存在的 uid 不被放行', (await currentUser(env, reqWith(await signToken(SECRET, { uid: 999, admin: 1 }, 300)))) === null);

  /* 登录层源码：放行判据唯一、没有旁路、未登录仍 302。
     test-editor-gate.mjs 已经直接测过 302 / 合法 sid 放行 / 伪造过期拦截，
     这里补的是它测不到的结构不变量：别为了「自动登录」给门禁开第二条放行路径
     （加了旁路，匿名行为测试照样全绿）。行首锚定切函数体，唯一计数排掉散文与
     字符串自我命中。 */
  const idxSrc = read(join(ROOT, 'src/index.js'), 'utf8');
  const start = idxSrc.search(/^export async function editorGate\(/m);
  const rest = start < 0 ? '' : idxSrc.slice(start);
  const end = rest.search(/^}/m);
  const gate = end < 0 ? '' : rest.slice(0, end);
  t('AL-07 editorGate 存在且可定位', gate.length > 100);
  t('AL-08 放行判据仍是唯一的 currentUser 调用', (gate.match(/await currentUser\(env, request\)/g) || []).length === 1);
  t('AL-09 登录层没有自动登录旁路', !/(autologin|bypass|dev_login|auto_login)/i.test(gate));
  t('AL-10 未登录仍是 302 去 /login', /status:\s*302/.test(gate) && /'\/login'/.test(gate));

  /* 页面判据：四种输入形状 × 期望，含空集与「只查 body」两种假绿形态。 */
  t('AL-11 200 + 标记齐全 → 绿', checkPage(200, 'x'.repeat(200) + 'published_at_raw flag-approved', ['published_at_raw', 'flag-approved']).ok);
  t('AL-12 302 但 body 带标记 → 红（别把登录页读成后台）', !checkPage(302, 'x'.repeat(200) + 'flag-approved', ['flag-approved']).ok);
  t('AL-13 200 但缺标记 → 红', !checkPage(200, 'x'.repeat(200), ['评论通知送达']).ok);
  t('AL-14 空 body → 红（空集恒真防护）', !checkPage(200, '', []).ok);
  t('AL-15 无标记页面只看状态码也要能绿', checkPage(200, 'x'.repeat(200), []).ok);

  /* 状态条渲染：两态 + 不回显地址 + 转义，纯函数喂假数据。 */
  const { renderCommentsAdmin } = await import('../src/admin-pages.js');
  const off = renderCommentsAdmin({});
  const on = renderCommentsAdmin({ hook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET_XYZ' });
  t('AL-16 未配置态仍写明「未验（读码结论）」', off.includes('评论通知送达') && off.includes('未验（读码结论）'));
  t('AL-17 已配置态不回显 webhook 地址', on.includes('已配置') && !on.includes('SECRET_XYZ'));
  t('AL-18 已配置态不把边界写成已验', !on.includes('已验') && on.includes('未验（读码结论）'));

  console.log(`\n判据自检 ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

/* ---------------- 线上/本地自动登录 + 验收 ---------------- */

function readSecret() {
  const fromEnv = String(process.env.LIVE_SESSION_SECRET || '').trim();
  if (fromEnv) return { secret: fromEnv, from: 'env LIVE_SESSION_SECRET' };
  const p = join(ROOT, '.dev.vars');
  if (existsSync(p)) {
    const kv = Object.fromEntries(
      readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
    if (kv.LIVE_SESSION_SECRET) return { secret: kv.LIVE_SESSION_SECRET, from: '.dev.vars LIVE_SESSION_SECRET' };
    if (kv.SESSION_SECRET) return { secret: kv.SESSION_SECRET, from: '.dev.vars SESSION_SECRET' };
  }
  return null;
}

async function run() {
  const ORIGIN = (arg('origin', 'https://miu.sryze.cc')).replace(/\/$/, '');
  const uid = Number(arg('uid', '1')) || 1;
  const ttl = Math.max(30, Math.min(Number(arg('ttl', '300')) || 300, 3600));
  const { signToken } = await import('../src/utils.js');

  let token;
  let credential;
  const sid = String(process.env.ADMIN_SID || '').trim();
  if (sid) {
    token = sid;
    credential = 'env ADMIN_SID（现成会话）';
  } else {
    const found = readSecret();
    if (!found) {
      die(
        '本机没有可签会话的密钥。在本机 .dev.vars 补一行 LIVE_SESSION_SECRET=<线上 SESSION_SECRET>（文件已 gitignore，值不要贴进对话），\n' +
          '   或 export LIVE_SESSION_SECRET=... 后重跑。本地 wrangler dev 可直接用 .dev.vars 的 SESSION_SECRET。'
      );
    }
    token = await signToken(found.secret, { uid, admin: 1 }, ttl);
    credential = found.from;
  }
  /* token / secret 一律不打印；cookie 只存在于本次进程内存。 */
  const cookie = `sid=${encodeURIComponent(token)}`;
  console.log(`自动登录：${ORIGIN} · 凭据 ${credential} · uid ${uid} · ${sid ? '现成会话' : `自签 ${ttl}s 短效票`}`);

  let pass = 0;
  let fail = 0;
  let saw302 = false;
  for (const p of PAGES) {
    let status = 0;
    let body = '';
    try {
      const r = await fetch(ORIGIN + p.path, { headers: { cookie }, redirect: 'manual' });
      status = r.status;
      body = await r.text();
    } catch (e) {
      console.log(`  FAIL ${p.name}  请求失败：${e.message}`);
      fail++;
      continue;
    }
    if (status === 302 || status === 401) saw302 = true;
    const v = checkPage(status, body, p.marks);
    if (v.ok) {
      pass++;
      console.log(`  ok   ${p.name}  HTTP 200`);
    } else {
      fail++;
      console.log(`  FAIL ${p.name}  ${v.missing.join(' / ')}`);
    }
  }

  if (saw302) {
    console.log('\n✗ 会话没被接受（302/401）：本机密钥与 ' + ORIGIN + ' 的 SESSION_SECRET 不同源。');
    console.log('  这不是脚本坏了，是「签出来了 ≠ 登录成功」。要线上自动登录，把线上现役 SESSION_SECRET');
    console.log('  放进本机 .dev.vars 的 LIVE_SESSION_SECRET（一行，值不要进对话/仓库），或改用 --origin 指向本地 wrangler dev。');
    process.exit(1);
  }
  console.log(`\n后台状态自动验收 ${pass} 通过，${fail} 失败`);
  if (fail) process.exit(1);
}

if (process.argv.includes('--check')) await selfCheck();
else await run();
