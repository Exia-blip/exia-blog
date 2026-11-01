// 站点信息：优先读 D1 的 settings 表，没配就回退 wrangler.jsonc 的 vars
// 这样站长在后台改完立刻生效，不用重新 deploy

const TTL = 30_000;
let cache = { at: 0, val: null };

export const THEME_IDS = ['paper', 'ink', 'forest', 'ocean', 'plum', 'mono'];
export const MODE_IDS = ['auto', 'light', 'dark'];

const normTheme = (v) => (THEME_IDS.includes(v) ? v : 'paper');
const normMode = (v) => (MODE_IDS.includes(v) ? v : 'auto');

/**
 * 站点头像：空 / http(s) 外链 / 站内相对路径（/img/xxx）三种合法形态。
 * 其余（javascript:、data: 之类）一律清空，避免塞进 <img src> 变成注入面。
 */
const normAvatar = (v) => {
  const s = String(v ?? '').trim().slice(0, 500);
  if (!s) return '';
  if (s.startsWith('/')) return s.startsWith('//') ? '' : s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
};

export function invalidateSite() {
  cache = { at: 0, val: null };
}

export async function getSite(env) {
  const now = Date.now();
  if (cache.val && now - cache.at < TTL) return cache.val;

  const site = {
    name: env.SITE_NAME || 'Exia Blog',
    desc: env.SITE_DESC || '',
    theme: normTheme(env.SITE_THEME),
    mode: normMode(env.SITE_MODE),
    avatar: normAvatar(env.SITE_AVATAR),
  };

  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('site_name','site_desc','site_theme','site_mode','site_avatar')"
    ).all();
    for (const r of results) {
      if (!r.value) continue;
      if (r.key === 'site_name') site.name = r.value;
      if (r.key === 'site_desc') site.desc = r.value;
      if (r.key === 'site_theme') site.theme = normTheme(r.value);
      if (r.key === 'site_mode') site.mode = normMode(r.value);
      if (r.key === 'site_avatar') site.avatar = normAvatar(r.value);
    }
  } catch {
    // 表还没建 / 库抖动，用 vars 兜底，不要让整站 500
  }

  cache = { at: now, val: site };
  return site;
}

export async function setSite(env, { name, desc, theme, mode, avatar }) {
  const stmts = [];
  const put = (key, val) =>
    stmts.push(
      env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(key, val)
    );

  if (name !== undefined) put('site_name', String(name).trim().slice(0, 60));
  if (desc !== undefined) put('site_desc', String(desc).trim().slice(0, 200));
  if (theme !== undefined) put('site_theme', normTheme(theme));
  if (mode !== undefined) put('site_mode', normMode(mode));
  if (avatar !== undefined) put('site_avatar', normAvatar(avatar));

  if (stmts.length) await env.DB.batch(stmts);
  invalidateSite();
  return getSite(env);
}
