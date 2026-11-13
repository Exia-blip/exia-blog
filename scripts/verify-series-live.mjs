// 线上验收：系列导航、上下篇、结构化数据、暗色卡片、aria-current
// 全部走真实 HTTP，带随机参数绕过边缘缓存（HTML 有 60s s-maxage）
const ORIGIN = 'https://exia.de5.net';
const cb = () => '?cb=' + Math.random().toString(36).slice(2);

const get = async (p) => (await fetch(ORIGIN + p + cb(), { headers: { 'cache-control': 'no-cache' } })).text();

function ldOf(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {}
  }
  return out;
}

function articleNode(html) {
  for (const blk of ldOf(html)) {
    const g = blk['@graph'] || [blk];
    for (const n of g) if (n['@type'] === 'BlogPosting') return n;
  }
  return null;
}

const checks = [];
const t = (name, fn) => checks.push([name, fn]);

const seriesPosts = ['oauth-pkce', 'oauth-auth-code', 'editor-autosave', 'editor-markdown-xss'];
const plainPosts = ['comment-anti-spam', 'r2-image-pipeline', 'worker-cron-friend-check', 'sticky-toc-grid-align-items'];

t('系列文渲染系列目录 + 上下篇', async () => {
  for (const s of seriesPosts) {
    const h = await get('/p/' + s);
    if (!h.includes('class="series"')) throw new Error(s + ' 没有系列块');
    if (!h.includes('series-jump')) throw new Error(s + ' 没有系列上下篇');
    if (!h.includes('/series/')) throw new Error(s + ' 系列块没有链到系列页');
  }
});

t('系列文带 position 与 isPartOf.url → /series/', async () => {
  for (const s of seriesPosts) {
    const a = articleNode(await get('/p/' + s));
    if (!a) throw new Error(s + ' 没有 BlogPosting');
    if (!(a.position > 0)) throw new Error(s + ' position=' + a.position);
    if (a.isPartOf['@type'] !== 'CreativeWorkSeries') throw new Error(s + ' isPartOf 类型错');
    if (!a.isPartOf.url.includes('/series/')) throw new Error(s + ' isPartOf.url=' + a.isPartOf.url);
  }
});

t('系列名可点进系列页，且系列页真的能打开', async () => {
  const h = await get('/p/oauth-pkce');
  const m = h.match(/class="series-name" href="([^"]+)"/);
  if (!m) throw new Error('系列名不是链接');
  const r = await fetch(ORIGIN + m[1].replace(/&amp;/g, '&'));
  if (r.status !== 200) throw new Error(m[1] + ' → ' + r.status);
});

t('非系列文有同栏目上下篇，且链接有效', async () => {
  for (const s of plainPosts) {
    const h = await get('/p/' + s);
    if (!h.includes('class="post-adjacent')) throw new Error(s + ' 没有上下篇');
    const links = [...h.matchAll(/class="adj (prev|next)" href="([^"]+)"/g)].map((m) => m[2]);
    if (!links.length) throw new Error(s + ' 上下篇链接为空');
    for (const l of links) {
      const r = await fetch(ORIGIN + l.replace(/&amp;/g, '&'));
      if (r.status !== 200) throw new Error(s + ' → ' + l + ' ' + r.status);
    }
  }
});

t('系列文不会重复出现两套导航', async () => {
  const h = await get('/p/editor-autosave');
  if (h.includes('class="post-adjacent')) throw new Error('系列文不该有同栏目块');
});

t('系列总览页列出全部公开系列', async () => {
  const h = await get('/series');
  for (const n of ['OAuth 授权流程拆解', '编辑器实战', 'Cloudflare 踩坑对照', '自建博客排障记']) {
    if (!h.includes(n)) throw new Error('缺 ' + n);
  }
  if (!h.includes('CollectionPage')) throw new Error('总览页缺 CollectionPage');
});

t('系列页的条目都指向真实文章', async () => {
  const h = await get('/series/' + encodeURIComponent('编辑器实战'));
  const links = [...h.matchAll(/<a href="(\/p\/[^"]+)">\s*<span class="sp-n"/g)].map((m) => m[1]);
  if (links.length < 2) throw new Error('条目数 ' + links.length);
  for (const l of links) {
    const r = await fetch(ORIGIN + l);
    if (r.status !== 200) throw new Error(l + ' ' + r.status);
  }
});

t('导航当前页带 aria-current="page"', async () => {
  for (const p of ['/', '/archive', '/cat/log']) {
    const h = await get(p);
    if (!h.includes('aria-current="page"')) throw new Error(p + ' 缺 aria-current');
  }
});

t('暗色卡片与背景已分层（card 不再是 #1b1d21）', async () => {
  const css = await (await fetch(ORIGIN + '/style.css' + cb())).text();
  const dark = css.match(/:root\[data-mode="dark"\]\s*\{([\s\S]*?)\}/)[1];
  if (/--card:\s*#1b1d21/.test(dark)) throw new Error('暗色 card 还是原值');
  if (!/--card:\s*#212429/.test(dark)) throw new Error('暗色 card 未按预期提亮');
  if (!css.includes('.post-adjacent')) throw new Error('样式表里没有 .post-adjacent');
});

t('标签与精选块有 hover 位移', async () => {
  const css = await (await fetch(ORIGIN + '/style.css' + cb())).text();
  if (!/\.tag:hover[^}]*transform/.test(css)) throw new Error('.tag:hover 没有 transform');
  if (!/\.pick:hover[^}]*transform/.test(css)) throw new Error('.pick:hover 没有 transform');
});

t('sitemap 收录系列页', async () => {
  const x = await (await fetch(ORIGIN + '/sitemap.xml')).text();
  if (!x.includes('/series</loc>')) throw new Error('没有 /series');
  if (!/\/series\/[^<]+<\/loc>/.test(x)) throw new Error('没有单系列地址');
});

let bad = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (e) {
    bad++;
    console.log('  FAIL  ' + name + ' — ' + e.message);
  }
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
