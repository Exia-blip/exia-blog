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
 * 两套密钥，按目标环境分流，互不回退（dev 的票打线上、线上的票打本地，
 * 都只会得到 302 —— 回退只会把「配错了」伪装成「登录失败」，白白多查一轮）：
 *   本地（localhost / 127.0.0.1 / ::1）→ SESSION_SECRET
 *       env SESSION_SECRET → .dev.vars 的 SESSION_SECRET（wrangler dev 用的就是它）
 *   线上（其余 host）              → LIVE_SESSION_SECRET
 *       env LIVE_SESSION_SECRET → .dev.vars 的 LIVE_SESSION_SECRET
 *   两串都只从本机读，绝不打印、绝不写进仓库、绝不进对话。文件已 gitignore。
 *   需要强制换一版用 --key=dev|live（调试用，默认按 host 自动选）。
 *   也可以直接给现成的管理员会话：环境变量 ADMIN_SID（不推荐，泄露窗口 30 天，
 *   且本仓库退出登录没有服务端吊销；自签短效票才是这个仓库该用的形状）。
 *
 * 实测前提（2026-11-26）：本机 .dev.vars 的 SESSION_SECRET 与线上现役
 *   SESSION_SECRET 不同源，拿它打线上会 302。线上那版要能跑，只差
 *   .dev.vars 里一行 LIVE_SESSION_SECRET；没填时脚本明确报「缺哪一版」，
 *   不拿 dev 密钥去冒充线上，也不把「签出来了」当「登录成功」。
 *
 * 用法：
 *   node scripts/admin-autologin.mjs --check                     # 判据自检（离线，已挂进 npm test）
 *   npm run check:admin:dev                                      # dev 版：本地 wrangler dev + SESSION_SECRET
 *   npm run check:admin:live                                     # 线上版：miu.sryze.cc + LIVE_SESSION_SECRET
 *   node scripts/admin-autologin.mjs --origin=https://miu.sryze.cc [--uid=1] [--ttl=300]
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
  { path: '/admin/comments', name: '评论通知送达状态条', marks: ['评论通知送达', '未尝试'] },
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
  /* 通知这块已经改成「库里的投递结果」：四个计数必须在，未配置态要明说跳过。
     仍然不许把「已送达」写成「已验」——平台回执是事实，端到端结论不是它。 */
  t(
    'AL-16 通知条四个计数都在，且未配置态写明跳过',
    ['已送达', '失败', '跳过', '未尝试'].every((k) => off.includes(k)) && off.includes('未配置')
  );
  t('AL-17 已配置态不回显 webhook 地址', on.includes('已配置') && !on.includes('SECRET_XYZ'));
  t('AL-18 已配置态不把平台回执写成端到端已验', on.includes('已送达') && !on.includes('端到端已验'));

  /* 两版密钥分流：本地只认 SESSION_SECRET，线上只认 LIVE_SESSION_SECRET，互不回退。
     输入是一份同时放了两版的 kv（与实现独立），所以「选错版本」不会被同一份输入掩盖。 */
  const both = { SESSION_SECRET: 'dev-key', LIVE_SESSION_SECRET: 'live-key' };
  const pDev = pickSecret(true, {}, both);
  const pLive = pickSecret(false, {}, both);
  const pLiveMissing = pickSecret(false, {}, { SESSION_SECRET: 'dev-key' });
  t('AL-19 dev 版取 SESSION_SECRET', pDev.secret === 'dev-key' && pDev.want === 'SESSION_SECRET');
  t('AL-20 线上版取 LIVE_SESSION_SECRET', pLive.secret === 'live-key' && pLive.want === 'LIVE_SESSION_SECRET');
  t('AL-21 线上缺 LIVE 时不回退 dev 密钥', pLiveMissing.secret === '' && pLiveMissing.want === 'LIVE_SESSION_SECRET');
  t('AL-22 env 优先于文件', pickSecret(true, { SESSION_SECRET: 'env-key' }, both).secret === 'env-key');

  console.log(`\n判据自检 ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

/* ---------------- 线上/本地自动登录 + 验收 ---------------- */

/* 目标环境决定用哪一版密钥：本地只认 SESSION_SECRET，线上只认 LIVE_SESSION_SECRET。
   不做「缺一版就回退另一版」—— 那会让「配错环境」与「登录失败」长成同一个症状，
   而这两件事的修法完全相反。 */
const isLocalHost = (origin) => {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
};

const loadKv = () => {
  const p = join(ROOT, '.dev.vars');
  if (!existsSync(p)) return {};
  return Object.fromEntries(
    readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
};

/* env 优先于文件：临时换一版不用改文件。want 一并返回，报错时能说清缺的是哪一版。 */
const pickSecret = (local, env, kv) => {
  const want = local ? 'SESSION_SECRET' : 'LIVE_SESSION_SECRET';
  const fromEnv = String((env && env[want]) || '').trim();
  if (fromEnv) return { secret: fromEnv, from: `env ${want}`, want };
  const fromFile = String((kv && kv[want]) || '').trim();
  if (fromFile) return { secret: fromFile, from: `.dev.vars ${want}`, want };
  return { secret: '', from: '', want };
};

async function run() {
  const ORIGIN = (arg('origin', 'https://miu.sryze.cc')).replace(/\/$/, '');
  const uid = Number(arg('uid', '1')) || 1;
  const ttl = Math.max(30, Math.min(Number(arg('ttl', '300')) || 300, 3600));
  const { signToken } = await import('../src/utils.js');

  const forceKey = arg('key'); // dev | live | ''（默认按 host 自动选）
  const local = forceKey ? forceKey === 'dev' : isLocalHost(ORIGIN);
  const picked = pickSecret(local, process.env, loadKv());

  let token;
  let credential;
  const sid = String(process.env.ADMIN_SID || '').trim();
  if (sid) {
    token = sid;
    credential = 'env ADMIN_SID（现成会话）';
  } else {
    if (!picked.secret) {
      die(
        local
          ? 'dev 版缺 SESSION_SECRET：在 .dev.vars 配好（wrangler dev 用的就是它），或 export SESSION_SECRET=... 后重跑。'
          : '线上版缺 LIVE_SESSION_SECRET：在本机 .dev.vars 补一行 LIVE_SESSION_SECRET=<线上现役 SESSION_SECRET>（文件已 gitignore，值不要进对话/仓库）。\n' +
              '   不要拿 dev 的 SESSION_SECRET 去试线上 —— 两者不同源，签出来必然 302。'
      );
    }
    token = await signToken(picked.secret, { uid, admin: 1 }, ttl);
    credential = picked.from;
  }
  /* token / secret 一律不打印；cookie 只存在于本次进程内存。 */
  const cookie = `sid=${encodeURIComponent(token)}`;
  console.log(
    `自动登录：${ORIGIN} · ${local ? 'dev 版' : '线上版'} · 凭据 ${credential} · uid ${uid} · ${
      sid ? '现成会话' : `自签 ${ttl}s 短效票`
    }`
  );

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
    console.log(
      `\n✗ 会话没被接受（302/401）：${local ? 'dev 版' : '线上版'}用的 ${picked.want} 与 ${ORIGIN} 的 SESSION_SECRET 不同源。`
    );
    console.log('  这不是脚本坏了，是「签出来了 ≠ 登录成功」。');
    console.log(
      local
        ? '  本地：.dev.vars 的 SESSION_SECRET 必须与 wrangler dev 启动时读到的一致；改过文件要重启 dev server。'
        : '  线上：把线上现役 SESSION_SECRET 填进 .dev.vars 的 LIVE_SESSION_SECRET（值不进对话/仓库）；它不是 dev 那一版。'
    );
    process.exit(1);
  }
  console.log(`\n后台状态自动验收 ${pass} 通过，${fail} 失败`);
  if (fail) process.exit(1);
}

if (process.argv.includes('--check')) await selfCheck();
else await run();
