// 站点信息：优先读 D1 的 settings 表，没配就回退 wrangler.jsonc 的 vars
// 这样站长在后台改完立刻生效，不用重新 deploy
import { ASSET_HASH } from './assets.gen.js';
import { deriveThemeIds } from './theme-contract.js';

const TTL = 30_000;
let cache = { at: 0, val: null };

/* 清单不手写：内联的两套 + 资源清单里每个 theme/<id>.css（见 deriveThemeIds）。
   以前这里是八个 id 的字面量数组，加第九套要记得改；忘了的症状是后台提示
   「未知的风格」，而主题文件明明存在。 */
export const THEME_IDS = deriveThemeIds(ASSET_HASH);
export const MODE_IDS = ['auto', 'light', 'dark'];

/* 主题样式表在 head 里直出时用的标签。
   纸韵和安知鱼都编在主 style.css 里，不需要额外请求；其余五套各自一个文件。
   以前这段是内联脚本里的 document.write —— 解析器得等它执行完才往下走，
   插入的 link 又把渲染卡到 CSS 到手。直出之后浏览器解析到就并行下载。

   路径单独抽出来，是为了让 103 Early Hints 和 head 里的 <link> 用同一个来源：
   两处各写一份判断，加主题时必然漏改一处，漏的那处表现为「preload 了一个
   404 地址」，而且只在某个主题下出现，测不到。 */
export function themeCssPath(theme) {
  const id = normTheme(theme);
  const href = `/theme/${id}.css`;
  /* 有没有独立文件，问资源清单，不问主题名：以前这里写死 paper/anzhiyu，
     加第八套时才想起来还有这么一处（P-051 修了客户端的两处，漏了这处）。 */
  return ASSET_HASH[href.slice(1)] ? href : '';
}

export function themeCssTag(theme, version = '') {
  const href = themeCssPath(theme);
  if (!href) return '';
  const a = ASSET_HASH[href.slice(1)]; // 'theme/ink.css'
  /* 版本号与 integrity 都来自同一份内容哈希：两者必须同源，
     否则「版本号换了但 integrity 还是旧的」会让浏览器直接丢掉这份 CSS。 */
  const v = a ? a.v : version;
  const q = v ? `?v=${encodeURIComponent(v)}` : '';
  const i = a ? ` integrity="${a.i}"` : '';
  return `<link id="tcss-default" rel="stylesheet" href="${href}${q}"${i}>`;
}

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

/**
 * 作者署名：写进 RSS 的 <author>。RSS 2.0 规范里这个值应该是
 * 「邮箱 (名字)」的形式，但绝大多数阅读器只当纯文本渲染，所以这里不强制。
 * 控制字符（尤其是换行）在 XML 1.0 里非法且 esc() 不处理，直接抹掉。
 */
const normAuthor = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);

export function invalidateSite() {
  cache = { at: 0, val: null };
}

export async function getSite(env) {
  const now = Date.now();
  if (cache.val && now - cache.at < TTL) return cache.val;

  const site = {
    name: env.SITE_NAME || 'Exia Blog',
    desc: env.SITE_DESC || '',
    // 优先级：后台 > SITE_AUTHOR > SITE_NAME。保证 RSS 永远有 <author> 可输出
    author: normAuthor(env.SITE_AUTHOR) || env.SITE_NAME || 'Exia Blog',
    theme: normTheme(env.SITE_THEME),
    mode: normMode(env.SITE_MODE),
    avatar: normAvatar(env.SITE_AVATAR),
  };

  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('site_name','site_desc','site_author','site_theme','site_mode','site_avatar')"
    ).all();
    for (const r of results) {
      if (!r.value) continue;
      if (r.key === 'site_name') site.name = r.value;
      if (r.key === 'site_desc') site.desc = r.value;
      if (r.key === 'site_author') site.author = normAuthor(r.value);
      if (r.key === 'site_theme') site.theme = normTheme(r.value);
      if (r.key === 'site_mode') site.mode = normMode(r.value);
      if (r.key === 'site_avatar') site.avatar = normAvatar(r.value);
    }
  } catch {
    // 表还没建 / 库抖动，用 vars 兜底，不要让整站 500
  }

  // 兜底：env 和库里都没给出可用值（比如全是控制字符被抹空）时退到站名
  if (!site.author) site.author = site.name;

  cache = { at: now, val: site };
  return site;
}

export async function setSite(env, { name, desc, author, theme, mode, avatar }) {
  const stmts = [];
  const put = (key, val) =>
    stmts.push(
      env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(key, val)
    );

  if (name !== undefined) put('site_name', String(name).trim().slice(0, 60));
  if (desc !== undefined) put('site_desc', String(desc).trim().slice(0, 200));
  if (author !== undefined) put('site_author', normAuthor(author));
  if (theme !== undefined) put('site_theme', normTheme(theme));
  if (mode !== undefined) put('site_mode', normMode(mode));
  if (avatar !== undefined) put('site_avatar', normAvatar(avatar));

  if (stmts.length) await env.DB.batch(stmts);
  invalidateSite();
  return getSite(env);
}
