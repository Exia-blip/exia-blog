/* 栏目与标签的唯一事实来源。
   栏目固定四选一（不扩），标签走白名单 + 别名归并。
   数据库里 category 存 slug（log/teardown/tools/site），显示名从这里取，
   这样改中文名不用动数据、也不会让 /cat/xxx 的旧链接失效。 */

export const CATS = [
  {
    slug: 'log',
    name: '工程实录',
    desc: '一个决定为什么这么定、当时卡在哪、事后看错在哪。有过程、有失败轮次、有真实输出。',
    hint: '做过的一件具体的事',
  },
  {
    slug: 'teardown',
    name: '协议拆解',
    desc: '协议怎么设计、校验落在哪一层、哪些防护看着唬人其实什么都没拦住。只分析机制。',
    hint: '拆别人的东西',
  },
  {
    slug: 'tools',
    name: '小工具',
    desc: '自己用得上才写的，通常一个文件跑完。交付物是可以直接拿去跑的代码。',
    hint: '能跑的代码',
  },
  {
    slug: 'site',
    name: '站务',
    desc: '本站自身的实现记录：服务端渲染改造、自建编辑器、Cloudflare 这套栈怎么搭起来。',
    hint: '关于这个站',
  },
];

export const CAT_SLUGS = CATS.map((c) => c.slug);

/* 历史值 / 口头叫法 → slug。只做单向收敛，不做新栏目。 */
const CAT_ALIAS = {
  log: 'log',
  工程实录: 'log',
  实录: 'log',
  实践: 'log',
  teardown: 'teardown',
  协议拆解: 'teardown',
  拆解: 'teardown',
  拆东西: 'teardown',
  tools: 'tools',
  小工具: 'tools',
  工具: 'tools',
  site: 'site',
  站务: 'site',
  本站: 'site',
  关于: 'site',
};

export function normalizeCat(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  return CAT_ALIAS[raw] || '';
}

export function catBySlug(slug) {
  const s = normalizeCat(slug);
  return CATS.find((c) => c.slug === s) || null;
}

export function catName(slug) {
  const c = catBySlug(slug);
  return c ? c.name : String(slug || '');
}

export function catDesc(slug) {
  const c = catBySlug(slug);
  return c ? c.desc : '';
}

/* ---------- 标签 ---------- */

/* 种子白名单：新词先进这张表再用，避免 cf / CF / cloudflare 三胞胎。 */
export const TAG_SEED = [
  'cloudflare', 'workers', 'pages', 'd1', 'r2', 'kv', 'turnstile',
  'oauth', 'jwt', 'tls', 'websocket', 'http', 'dns', 'cors',
  'markdown', 'editor', 'css', 'javascript', 'pwa',
  'bash', 'python', 'sqlite', 'curl', 'regex',
  'testing', 'debugging',
  'ssr', 'seo', 'cache',
];

/* 别名归并表：左边一律收敛到右边。 */
export const TAG_ALIAS = {
  cf: 'cloudflare',
  'cloudflare-workers': 'workers',
  cfworkers: 'workers',
  db: 'd1',
  database: 'd1',
  'img-bed': 'r2',
  'image-host': 'r2',
  md: 'markdown',
  js: 'javascript',
  py: 'python',
  sqlite3: 'sqlite',
  'nodejs': 'javascript',
  node: 'javascript',
};

export function normalizeTag(input) {
  let t = String(input || '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 24);
  return TAG_ALIAS[t] || t;
}

/* 去重 + 归并 + 限长；超过 limit 的部分不静默丢弃，交给调用方提示 */
export function normalizeTags(list, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const t = normalizeTag(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

export const isSeedTag = (t) => TAG_SEED.includes(normalizeTag(t));

/* 编辑器侧自检：返回给人看的问题清单，不阻断保存 */
export function tagIssues(tags = []) {
  const issues = [];
  if (tags.length === 0) issues.push('没有标签：正文里写 #cloudflare 这类技术名词');
  if (tags.length > 4) issues.push(`标签 ${tags.length} 个，超过 4 个通常是在堆关键词`);
  const unknown = tags.filter((t) => !isSeedTag(t));
  if (unknown.length) issues.push(`不在白名单：${unknown.join('、')}`);
  return issues;
}
