import { parseCookies, setCookie, clearCookie, signToken, verifyToken, json, nowISO } from './utils.js';

const COOKIE = 'sid';

/* ---------------- GitHub OAuth ---------------- */

/**
 * 站点主域（登录唯一入口）
 * 换域名时只要改 wrangler.jsonc 的 SITE_ORIGIN，这里会把各种脏写法洗干净：
 *   https://a.com//auth/callback/  →  https://a.com
 *   https://a.com/                 →  https://a.com
 * 没配置时回落到当前请求的 origin，照样能登录。
 */
function resolveOrigin(env, request) {
  const reqOrigin = new URL(request.url).origin;
  const raw = String(env.SITE_ORIGIN || env.OAUTH_REDIRECT || '').trim().replace(/\s+/g, '');
  if (!raw) return reqOrigin;
  const cleaned = raw
    .replace(/\/+$/, '')
    .replace(/\/auth\/callback\/?$/i, '')
    .replace(/\/+$/, '');
  try {
    const u = new URL(cleaned);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reqOrigin;
    return u.origin;
  } catch {
    return reqOrigin;
  }
}

/* 登录跳转目标只接受站内相对路径。
   只判 startsWith('/') 不够：'//evil.com' 与 '/\\evil.com' 会被浏览器当成
   协议相对 URL 解析到外域（开放重定向）。两道闸：
     1) 单个 / 开头，紧随其后的字符不能是 / 或 \；
     2) 用 origin 解析后必须仍在本站 —— 兜住 tab/换行等被 URL 解析器吞掉后拼出的 //evil。
   返回 '/' 作为拒绝时的安全落点。导出供单测穷举绕过写法。 */
export function safeNext(raw, origin) {
  const s = typeof raw === 'string' ? raw : '';
  if (!/^\/(?![\/\\])/.test(s)) return '/';
  try {
    if (new URL(s, origin).origin !== origin) return '/';
  } catch {
    return '/';
  }
  return s;
}

/* GitHub 回调地址：永远由主域拼出来，不接受手写的完整路径 */
export function callbackUrl(env, request) {
  return `${resolveOrigin(env, request)}/auth/callback`;
}

/* 提示页：state 校验失败、回调落在别的域名等，给出可读说明而不是纯文本 */
function noticePage(title, detail, hint = '') {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f7;color:#1c1b19;
font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
.card{max-width:560px;background:#fff;border:1px solid #e7e3db;border-radius:14px;padding:30px 32px}
h1{font-size:19px;margin:0 0 10px}p{color:#4a4741;margin:0 0 12px;font-size:14.5px}
code{background:#f3f1ec;border-radius:5px;padding:2px 6px;font-size:13px;word-break:break-all;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
a{display:inline-block;margin-top:6px;padding:9px 18px;border-radius:999px;background:#1c1b19;color:#fff;
text-decoration:none;font-size:14px}
.hint{font-size:13px;color:#868079;margin-top:14px}</style></head>
<body><div class="card"><h1>${title}</h1><p>${detail}</p>
${hint ? `<div class="hint">${hint}</div>` : ''}
<a href="/login">重新登录</a></div></body></html>`;
  return new Response(html, {
    status: 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* client_id 没配时不要把用户甩到 GitHub（那边会返回 404），直接给出配置页 */
function missingOAuthApp(cid, redirect) {
  const bad = !cid || cid === 'REPLACE_ME' || cid.length < 10;
  if (!bad) return null;
  const cb = redirect;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>还没配置 GitHub OAuth · 一步即可</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1a1a1a;
font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
.card{max-width:640px;background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:32px 34px;
box-shadow:0 1px 3px rgba(0,0,0,.04)}
h1{font-size:20px;margin:0 0 6px}p.sub{color:#6b7280;margin:0 0 22px;font-size:14px}
ol{padding-left:20px;margin:0 0 20px}ol li{margin:10px 0}
code{background:#f2f3f5;border:1px solid #e6e8eb;border-radius:5px;padding:2px 6px;font-size:13px;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
.box{background:#f8f9fb;border:1px solid #e6e8eb;border-radius:10px;padding:14px 16px;margin:16px 0;font-size:13.5px}
.box b{display:block;margin-bottom:6px;font-size:13px;color:#374151}
.tag{display:inline-block;background:#fef3c7;color:#92400e;border-radius:5px;padding:1px 7px;font-size:12px}
</style></head><body><div class="card">
<h1>站已上线，只差 GitHub OAuth 一处</h1>
<p class="sub">当前 Worker 里没有有效的 <code>GITHUB_CLIENT_ID</code>，所以不能直接跳转登录。
GitHub 对无效 client_id 返回 404 —— 你刚才看到的就是这个。</p>
<ol>
<li>打开 <a href="https://github.com/settings/applications/new" target="_blank" rel="noopener">github.com/settings/applications/new</a></li>
<li><b>Application name</b>：随便填，例如 <code>Exia Blog</code><br>
<b>Homepage URL</b>：<code>${new URL(cb).origin}</code></li>
<li><b>Authorization callback URL</b> 必须一字不差：<div class="box"><b>回调地址</b><code>${cb}</code></div></li>
<li>点 <b>Register application</b>，复制上方 <b>Client ID</b></li>
<li>点 <b>Generate a new client secret</b>，复制（<span class="tag">只显示一次</span>）</li>
</ol>
<div class="box"><b>然后在本机项目目录执行</b>
<code>npx wrangler secret put GITHUB_CLIENT_SECRET</code><br>
把 Client ID 填进 <code>wrangler.jsonc</code> 的 <code>GITHUB_CLIENT_ID</code>，再 <code>npx wrangler deploy</code>。
</div>
<p class="sub" style="margin:0">配好后刷新本页，就会自动跳转 GitHub 授权；<b>第一个登录的账号自动成为管理员</b>。</p>
</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function loginRedirect(env, request) {
  const url = new URL(request.url);
  const origin = resolveOrigin(env, request);
  const next = safeNext(url.searchParams.get('next'), origin);

  // 从非主域进来（旧 workers.dev、备用域名）：先回主域再走 OAuth
  // 否则会话 cookie 会落在另一个 host 上，授权回来后台仍然是"未登录"
  if (url.origin !== origin) {
    const to = new URL('/auth/github', origin);
    if (next && next !== '/') to.searchParams.set('next', next);
    return new Response(null, {
      status: 302,
      headers: { location: to.toString(), 'cache-control': 'no-store' },
    });
  }

  const state = crypto.randomUUID();
  const redirect = callbackUrl(env, request);

  const setup = missingOAuthApp(env.GITHUB_CLIENT_ID, redirect);
  if (setup) return setup;

  const gh = new URL('https://github.com/login/oauth/authorize');
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  gh.searchParams.set('redirect_uri', redirect);
  gh.searchParams.set('scope', 'read:user user:email');
  gh.searchParams.set('state', state);

  const headers = new Headers({ location: gh.toString() });
  headers.append('set-cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
  headers.append('set-cookie', `oauth_next=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
  return new Response(null, { status: 302, headers });
}

export async function handleCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expect = parseCookies(request).oauth_state;

  if (!code) {
    return noticePage(
      '授权被中断',
      'GitHub 没有带回授权码，可能是你在授权页点了取消。',
      '直接重新登录即可。'
    );
  }
  if (!state || state !== expect) {
    return noticePage(
      '登录状态已失效',
      '浏览器里没有找到这次登录的临时凭据（<code>oauth_state</code>）。常见原因：换了域名、清过 Cookie、或授权页停留超过 10 分钟。',
      '重新点一次登录就能恢复。'
    );
  }

  const redirect = callbackUrl(env, request);

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirect,
    }),
  });
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  if (!accessToken) {
    const reason = tokenData.error_description || tokenData.error || 'unknown';
    const mismatch = /redirect_uri|redirect uri/i.test(reason);
    return noticePage(
      mismatch ? '回调地址对不上' : 'GitHub 授权失败',
      `GitHub 返回：<code>${String(reason).replace(/[<>&]/g, '')}</code>`,
      mismatch
        ? `去 GitHub OAuth App 里把 Authorization callback URL 改成 <code>${redirect}</code>，必须一字不差。`
        : `当前使用的回调地址是 <code>${redirect}</code>。`
    );
  }

  const ghUser = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'exia-blog', accept: 'application/vnd.github+json' },
  }).then((r) => r.json());

  if (!ghUser || !ghUser.id) {
    return noticePage('拿不到 GitHub 账号', '授权码已经拿到，但读取用户资料失败，通常是 GitHub API 限流或网络抖动。', '等几十秒重试一次。');
  }

  // 拿联系邮箱：/user 的 email 常为 null（用户设了隐私），再查 /user/emails 取主邮箱
  let ghEmail = ghUser.email || '';
  if (!ghEmail) {
    try {
      const r = await fetch('https://api.github.com/user/emails', {
        headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'exia-blog', accept: 'application/vnd.github+json' },
      });
      if (r.ok) {
        const arr = await r.json();
        const pick = arr.find((e) => e.primary && e.verified) || arr.find((e) => e.verified) || arr[0];
        ghEmail = pick?.email || '';
      }
    } catch {}
  }

  const db = env.DB;
  let user = await db.prepare('SELECT * FROM users WHERE github_id = ?').bind(String(ghUser.id)).first();

  /* 准入判定放在建行之前：白名单外的账号不该在 users 表里留下任何痕迹，
     更不该拿到一枚 30 天有效的会话 cookie。 */
  const policy = admitPolicy(env);
  const isFirst = !user ? await db.prepare('SELECT COUNT(*) AS c FROM users').first().then((r) => !r || r.c === 0) : false;
  const access = decideAccess(env, ghUser.login, isFirst);
  if (!access.ok) {
    console.warn('[auth] 拒绝登录：login=%s reason=%s', ghUser.login, access.reason);
    return noticePage(
      '这个 GitHub 账号没有写权限',
      `站点开启了准入白名单，<code>${ghUser.login}</code> 不在 <code>ALLOWED_LOGINS</code> 里。`,
      '如果你是站主，把该 login 加进环境变量后重新部署即可。只登录不写文章，用不着账号。'
    );
  }

  if (!user) {
    await db
      .prepare('INSERT INTO users (github_id, login, name, avatar, email, is_admin, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(String(ghUser.id), ghUser.login, ghUser.name || ghUser.login, ghUser.avatar_url || '', ghEmail, access.admin, nowISO())
      .run();
    user = await db.prepare('SELECT * FROM users WHERE github_id = ?').bind(String(ghUser.id)).first();
  } else {
    /* 配了 ADMIN_LOGINS 就每次登录把库里的 is_admin 同步成配置值：
       撤权/授权都不用等 30 天 token 到期，也不用去改库。
       没配则保持库里原值，避免"顺手改个环境变量把管理员降级了"。 */
    const wantAdmin = policy.admins.length ? access.admin : user.is_admin;
    await db
      .prepare('UPDATE users SET login = ?, name = ?, avatar = ?, email = ?, is_admin = ? WHERE id = ?')
      .bind(ghUser.login, ghUser.name || ghUser.login, ghUser.avatar_url || '', ghEmail || user.email || '', wantAdmin, user.id)
      .run();
    if (wantAdmin !== user.is_admin) {
      console.log('[auth] %s 的 is_admin 由 %d 同步为 %d（ADMIN_LOGINS）', ghUser.login, user.is_admin, wantAdmin);
    }
  }

  const token = await signToken(env.SESSION_SECRET, { uid: user.id, admin: user.is_admin }, 60 * 60 * 24 * 30);

  const next = safeNext(parseCookies(request).oauth_next, resolveOrigin(env, request));
  const headers = new Headers({ location: next });
  headers.append('set-cookie', setCookie(COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }));
  headers.append('set-cookie', 'oauth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  headers.append('set-cookie', 'oauth_next=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  return new Response(null, { status: 302, headers });
}

/* 登录自检：换域名后打开 /auth/status 就能看到该往 GitHub 填哪个回调地址 */
export function authStatus(env, request) {
  const origin = resolveOrigin(env, request);
  return json({
    ok: true,
    request_origin: new URL(request.url).origin,
    site_origin: origin,
    redirect_uri: callbackUrl(env, request),
    configured: env.SITE_ORIGIN || env.OAUTH_REDIRECT || null,
    client_id: env.GITHUB_CLIENT_ID ? 'set' : 'missing',
    client_secret: env.GITHUB_CLIENT_SECRET ? 'set' : 'missing',
  });
}

export function logout() {
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': clearCookie(COOKIE) } });
}

/* ---------------- 准入策略 ----------------
   两个环境变量，都可选：

   ALLOWED_LOGINS 逗号分隔的 GitHub login。不配 = 开放注册（沿用旧行为）；
                  配了就是白名单，名单外的账号连 users 行都不建、直接拒绝登录。
   ADMIN_LOGINS   逗号分隔的 GitHub login。配了就以它为准（每次登录同步回库，
                  改了变量即生效，不用手改库）；不配才回落到"首个注册者即管理员"。

   为什么要有这两个：旧逻辑是 isFirst ? 1 : 0 —— 谁能先注册谁就是管理员，
   而注册入口对任何 GitHub 账号开放。公开可部署的项目里这等于把管理员席位
   交给最先到达的人（Rin 有同一处硬伤）。上线至今只有两行用户、窗口已关，
   但机制还在，清库或开新实例就重开。 */

function csvList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function admitPolicy(env) {
  const allow = csvList(env.ALLOWED_LOGINS);
  const admins = csvList(env.ADMIN_LOGINS);
  return { allow, admins, open: allow.length === 0 };
}

/**
 * 判定一个 GitHub 登录是否放行、放行后是什么角色。
 * 返回 { ok:false } 表示拒绝；{ ok:true, admin:0|1 } 表示放行。
 */
export function decideAccess(env, login, isFirst) {
  const p = admitPolicy(env);
  const l = String(login || '').toLowerCase();
  if (!l) return { ok: false, reason: 'missing-login' };
  if (!p.open && !p.allow.includes(l)) return { ok: false, reason: 'not-allowed' };
  // 配了 ADMIN_LOGINS 就完全以它为准，不再看 isFirst
  const admin = p.admins.length ? p.admins.includes(l) : !!isFirst;
  return { ok: true, admin: admin ? 1 : 0 };
}

/**
 * 资源级判定：作者本人或管理员。
 * 过去五处 handler 各写一遍 `p.author_id !== u.id && !u.is_admin`，
 * 新增路由时只能靠记忆复制——抽成一处，越权判断就只有一个实现。
 */
export function ownerOrAdmin(user, post) {
  if (!user || !post) return false;
  return user.id === post.author_id || !!user.is_admin;
}

/**
 * 角色能力判定：这次写入的稿子该落在哪个审核态。
 *
 * 和 ownerOrAdmin 分家的原因：那个答"你能不能碰这一行"，这个答"你写的东西要不要排队"。
 * 过去新建与更新两处各写一遍三元 `u.is_admin ? 'approved' : 'pending'`，
 * 改规则时得同时想起两处 —— 收成一处，规则只在这里。
 * 管理员直接通过；其余一律待审（不能拿 hidden 顶替，那是作者自己能改回的开关）。
 */
export function reviewStatusFor(user) {
  return user && user.is_admin ? 'approved' : 'pending';
}

/* ---------------- 当前用户 ---------------- */

export async function currentUser(env, request) {
  const token = parseCookies(request)[COOKIE];
  if (!token) return null;
  const payload = await verifyToken(env.SESSION_SECRET, token);
  if (!payload || !payload.uid) return null;
  const user = await env.DB.prepare('SELECT id, login, name, avatar, email, is_admin FROM users WHERE id = ?')
    .bind(payload.uid)
    .first();
  return user || null;
}

export async function requireUser(env, request) {
  const user = await currentUser(env, request);
  if (!user) return { user: null, res: json({ ok: false, error: '未登录' }, 401) };
  return { user, res: null };
}

export async function requireAdmin(env, request) {
  const { user, res } = await requireUser(env, request);
  if (res) return { user: null, res };
  if (!user.is_admin) return { user: null, res: json({ ok: false, error: '需要管理员权限' }, 403) };
  return { user, res: null };
}
