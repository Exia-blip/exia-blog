import { parseCookies, setCookie, clearCookie, signToken, verifyToken, json, nowISO } from './utils.js';

const COOKIE = 'sid';

/* ---------------- GitHub OAuth ---------------- */

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
  const state = crypto.randomUUID();
  const next = url.searchParams.get('next') || '/';
  const redirect = env.OAUTH_REDIRECT || `${url.origin}/auth/callback`;

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

  if (!code) return new Response('缺少 code', { status: 400 });
  if (!state || state !== expect) return new Response('state 校验失败', { status: 400 });

  const redirect = env.OAUTH_REDIRECT || `${url.origin}/auth/callback`;

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
    return new Response(`GitHub 授权失败: ${tokenData.error_description || tokenData.error || 'unknown'}`, {
      status: 400,
    });
  }

  const ghUser = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'exia-blog', accept: 'application/vnd.github+json' },
  }).then((r) => r.json());

  if (!ghUser || !ghUser.id) return new Response('获取 GitHub 用户失败', { status: 400 });

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

  if (!user) {
    const count = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
    const isFirst = !count || count.c === 0;
    await db
      .prepare('INSERT INTO users (github_id, login, name, avatar, email, is_admin, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(
        String(ghUser.id),
        ghUser.login,
        ghUser.name || ghUser.login,
        ghUser.avatar_url || '',
        ghEmail,
        isFirst ? 1 : 0,
        nowISO()
      )
      .run();
    user = await db.prepare('SELECT * FROM users WHERE github_id = ?').bind(String(ghUser.id)).first();
  } else {
    await db
      .prepare('UPDATE users SET login = ?, name = ?, avatar = ?, email = ? WHERE id = ?')
      .bind(ghUser.login, ghUser.name || ghUser.login, ghUser.avatar_url || '', ghEmail || user.email || '', user.id)
      .run();
  }

  const token = await signToken(env.SESSION_SECRET, { uid: user.id, admin: user.is_admin }, 60 * 60 * 24 * 30);

  const next = parseCookies(request).oauth_next || '/';
  const headers = new Headers({ location: next.startsWith('/') ? next : '/' });
  headers.append('set-cookie', setCookie(COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }));
  headers.append('set-cookie', 'oauth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  headers.append('set-cookie', 'oauth_next=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  return new Response(null, { status: 302, headers });
}

export function logout() {
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': clearCookie(COOKIE) } });
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
