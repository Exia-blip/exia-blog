import { parseCookies, setCookie, clearCookie, signToken, verifyToken, json, nowISO } from './utils.js';

const COOKIE = 'sid';

/* ---------------- GitHub OAuth ---------------- */

export function loginRedirect(env, request) {
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const next = url.searchParams.get('next') || '/';
  const redirect = env.OAUTH_REDIRECT || `${url.origin}/auth/callback`;
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

  const db = env.DB;
  let user = await db.prepare('SELECT * FROM users WHERE github_id = ?').bind(String(ghUser.id)).first();

  if (!user) {
    const count = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
    const isFirst = !count || count.c === 0;
    await db
      .prepare('INSERT INTO users (github_id, login, name, avatar, is_admin, created_at) VALUES (?,?,?,?,?,?)')
      .bind(String(ghUser.id), ghUser.login, ghUser.name || ghUser.login, ghUser.avatar_url || '', isFirst ? 1 : 0, nowISO())
      .run();
    user = await db.prepare('SELECT * FROM users WHERE github_id = ?').bind(String(ghUser.id)).first();
  } else {
    await db
      .prepare('UPDATE users SET login = ?, name = ?, avatar = ? WHERE id = ?')
      .bind(ghUser.login, ghUser.name || ghUser.login, ghUser.avatar_url || '', user.id)
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
  const user = await env.DB.prepare('SELECT id, login, name, avatar, is_admin FROM users WHERE id = ?')
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
