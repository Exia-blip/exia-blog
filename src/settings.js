// 站点信息：优先读 D1 的 settings 表，没配就回退 wrangler.jsonc 的 vars
// 这样站长在后台改完立刻生效，不用重新 deploy

const TTL = 30_000;
let cache = { at: 0, val: null };

export const THEME_IDS = ['anzhiyu', 'paper', 'ink', 'forest', 'ocean', 'plum', 'mono'];
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
  return id === 'paper' || id === 'anzhiyu' ? '' : `/theme/${id}.css`;
}

export function themeCssTag(theme, version = '') {
  const href = themeCssPath(theme);
  if (!href) return '';
  const v = version ? `?v=${encodeURIComponent(version)}` : '';
  return `<link id="tcss-default" rel="stylesheet" href="${href}${v}">`;
}

/* 路由专属样式表。这些样式原先都在 style.css 里全站加载，现在按路由拆出：
   首页/文章页/分类页只带主表；编辑器、登录、友链、归档各自多带一个小文件。
   路径跟 103 Early Hints 的预加载共用这一份来源，两处不会漂移。

   只在确切的页面路径上命中。列表/标签/栏目页用的是首页模板，走主表即可；
   /series 和 404 是 Worker 内联生成的 HTML（没有 <!--THEME--> 标记），
   它们的样式本来就 redundantly 在主表里，不依赖这里。 */
export function routeCssPath(pathname) {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  if (p === '/editor') return '/css/editor.css';
  if (p === '/login') return '/css/login.css';
  if (p === '/friends') return '/css/friends.css';
  if (p === '/archive' || /^\/archive\/\d{4}$/.test(p)) return '/css/archive.css';
  return '';
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
