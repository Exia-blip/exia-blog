// 站点信息：优先读 D1 的 settings 表，没配就回退 wrangler.jsonc 的 vars
// 这样站长在后台改完立刻生效，不用重新 deploy

const TTL = 30_000;
let cache = { at: 0, val: null };

export const THEME_IDS = ['paper', 'ink', 'forest', 'ocean', 'plum', 'mono'];
export const MODE_IDS = ['auto', 'light', 'dark'];

const normTheme = (v) => (THEME_IDS.includes(v) ? v : 'paper');
const normMode = (v) => (MODE_IDS.includes(v) ? v : 'auto');

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
  };

  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('site_name','site_desc','site_theme','site_mode')"
    ).all();
    for (const r of results) {
      if (!r.value) continue;
      if (r.key === 'site_name') site.name = r.value;
      if (r.key === 'site_desc') site.desc = r.value;
      if (r.key === 'site_theme') site.theme = normTheme(r.value);
      if (r.key === 'site_mode') site.mode = normMode(r.value);
    }
  } catch {
    // 表还没建 / 库抖动，用 vars 兜底，不要让整站 500
  }

  cache = { at: now, val: site };
  return site;
}

export async function setSite(env, { name, desc, theme, mode }) {
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

  if (stmts.length) await env.DB.batch(stmts);
  invalidateSite();
  return getSite(env);
}
