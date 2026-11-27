/* [P-093][P-094] 打印态逐页体检：把每个路由按 print 媒体渲染一遍，检查「纸上不该出现的东西」。
 *
 * 为什么要有这个脚本：print 段是唯一一段全站策略，它是**按选择器**写的，
 * 而漏掉的往往不是「某个页面没有段的」，是「某一类元素没被列进清单」——
 * 阅读进度条、归档的分段按钮、时间线的负边距、列表页封面、后台侧栏。
 * 这类东西读 CSS 读不出来，只能逐页渲染。
 *
 * 用法（先起本地服务）：
 *   npx wrangler dev --port 8787
 *   node scripts/check-print.mjs                    # 默认 http://127.0.0.1:8787
 *   AUDIT_ORIGIN=https://miu.sryze.cc node scripts/check-print.mjs
 *
 * 判据（任一不满足即 ✗）：
 *   · body 计算背景必须是白（洗 token 之后本该如此）
 *   · 横向溢出 ≤ 1px（纸上没有滚动条，溢出就是裁边）
 *   · 不得有可见的 fixed / sticky 元素（悬浮层在纸上会重复或压住正文）
 *   · 不得有非白且面积 > 20000px² 的背景块（耗墨，且灰块在纸上像脏了）
 *   · 不得有可见的按钮（纸上按不动；input/textarea 除外 —— 它们在 print 段
 *     里已去掉控件外观，编辑器里承载的是标题与正文）
 *
 * 后台 13 页（/admin 及 11 个子页 + /editor）需要管理员票：本地库管理员 uid
 * 固定写在 UID 里；线上跑会因 uid 对不上返回 401，那几个页面会被标 ? 并跳过 ——
 * 不算失败，但要知道没验。
 */
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';
import { adminCookie } from './lib/session.mjs';

const ORIGIN = process.env.AUDIT_ORIGIN || 'http://127.0.0.1:8787';
const UID = Number(process.env.AUDIT_UID || 1);
let fails = 0;


const b = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu'],
});

const probe = async (p) =>
  p.evaluate(() => {
    const vis = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const path = (el) => {
      const bits = [];
      let e = el;
      for (let i = 0; i < 3 && e && e.nodeType === 1; i++) {
        bits.unshift(
          e.tagName.toLowerCase() +
            (e.className && typeof e.className === 'string'
              ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.')
              : '')
        );
        e = e.parentElement;
      }
      return bits.join(' > ');
    };
    // 白色不是耗墨块：洗 token 之后 body / 卡片 / 代码块本来就是 #fff，
    // 只有非白且不透明的背景才值得在纸上担心。
    const opaque = (c) =>
      c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c) &&
      c !== 'rgb(255, 255, 255)' && !/^color\(srgb 1 1 1\)$/.test(c);
    const floats = [];
    const bigBg = [];
    const over = [];
    const cw = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el)) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.position === 'fixed' || cs.position === 'sticky') floats.push(`${cs.position} ${path(el)}`);
      if (opaque(cs.backgroundColor) && r.width * r.height > 20000) {
        bigBg.push(`${cs.backgroundColor} ${Math.round(r.width)}x${Math.round(r.height)} ${path(el)}`);
      }
      if (r.right > cw + 1 && r.width < cw * 3) over.push(`${path(el)} right=${Math.round(r.right)}`);
    }
    // 只数「按不动的按钮」：input/textarea/select 在 print 段里已去掉控件外观，
    // 编辑器里它们承载的是标题与正文（有信息），不能因为「是个控件」就算残留。
    const interactive = [...document.querySelectorAll('button, input[type=submit], input[type=button], input[type=search]')]
      .filter(vis)
      .map(path);
    return {
      // 样式没加载时（SRI 对不上、404、CSP 拦住）上面每一条都会「通过」：
      // 没有 fixed、没有背景色、没有按钮 —— 全绿是假绿。[P-095] 边缘缓存里留着的旧 HTML
      // 带旧 integrity，同样会走到这里。--bg 只在 style.css 里定义，
      // 它为空就说明这一页根本没套上样式，后面的判据全部无意义。
      hasTokens: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() !== '',
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
      overflowX: document.documentElement.scrollWidth - cw,
      over: [...new Set(over)].slice(0, 4),
      floats: [...new Set(floats)].slice(0, 6),
      bigBg: [...new Set(bigBg)].slice(0, 5),
      interactive: [...new Set(interactive)].slice(0, 5),
      thumbs: [...document.querySelectorAll('.post-card .thumb')].filter(vis).length,
      hero: (() => {
        const h = document.querySelector('.hero');
        return h && vis(h) ? Math.round(h.getBoundingClientRect().height) : 0;
      })(),
      height: Math.round(document.documentElement.scrollHeight),
    };
  });

const line = (name, url, r, opts = {}) => {
  const hard = [];
  const info = [];
  /* 自带 <style> 的页面（OAuth 提示页 / 500 页）不引 style.css，没有 --bg：
     NO-CSS 防线对它们不适用，改用「body 必须已是白底」这同一条硬判据兜住。 */
  if (!r.hasTokens && !opts.selfStyled) hard.push('NO-CSS=样式未加载，本页其余判据无意义');
  if (r.bodyBg !== 'rgb(255, 255, 255)') hard.push(`BODYBG=${r.bodyBg}`);
  if (r.overflowX > 1) hard.push(`OVERFLOW=${r.overflowX}px[${r.over.join(' | ')}]`);
  if (r.floats.length) hard.push(`FLOAT=${r.floats.join(' | ')}`);
  if (r.bigBg.length) hard.push(`BG=${r.bigBg.join(' | ')}`);
  if (r.interactive.length && !opts.allowUi) hard.push(`UI=${r.interactive.join(' | ')}`);
  if (r.thumbs) info.push(`图×${r.thumbs}`);
  if (r.hero) info.push(`hero=${r.hero}px`);
  if (hard.length) fails++;
  console.log(
    `${hard.length ? '✗' : '✓'} ${name.padEnd(14)} ${url.padEnd(24)} h=${String(r.height).padEnd(5)} ${hard.join('  ')}${info.length ? '   · ' + info.join(' ') : ''}`
  );
};

const p = await b.newPage();
await p.setViewport({ width: 1280, height: 900 });
await p.goto(`${ORIGIN}/`, { waitUntil: 'networkidle2' });
const link = (sel) =>
  p.evaluate((s) => document.querySelector(s)?.getAttribute('href') || '', sel).catch(() => '');
const links = {
  tag: await link('a[href^="/tag/"]'),
  cat: await link('a[href^="/cat/"]'),
};
await p.goto(`${ORIGIN}/series`, { waitUntil: 'networkidle2' });
links.series = await link('a[href^="/series/"]');
await p.goto(`${ORIGIN}/archive`, { waitUntil: 'networkidle2' });
// 年归档链接不一定出现在归档页首屏（年份靠 JS 分段），取不到就按当前年兜底
links.year = (await link('a[href^="/archive/2"]')) || `/archive/${new Date().getFullYear()}`;

/* 路由清单在这里手写，所以「新加一个页面」不会自动进来 —— test-typography 的
   T-10 会把 src/index.js 里每个返回 HTML 的 path 字面量对到这里，漏一个就红。
   新加页面时两边一起改，并按 P-093 的教训把新页面**渲染一遍**再收工。 */
const routes = [
  ['/', '首页'],
  ['/?q=缓存', '搜索结果'],
  ['/archive', '归档'],
  [links.year, '年份归档'],
  ['/categories', '分类'],
  ['/numbers', '数据'],
  ['/friends', '友链'],
  ['/series', '系列'],
  [links.series, '系列详情'],
  [links.tag, '标签页'],
  [links.cat, '分类页'],
  ['/p/ci-fixture', '文章'],
  ['/p/blog-markdown-xss', '文章(表/码)'],
  ['/no-such-page-xyz', '404'],
  ['/login', '登录'],
  /* 这份页面自带 <style>、不引 /style.css（OAuth 出错时全站样式未必可用），
     所以全站打印段管不到它 —— 它有自己的 @media print。触发条件是 state 对不上。 */
  ['/auth/callback?code=x&state=bad', '登录提示页', 400, { selfStyled: true }],
].filter(([u]) => u);

for (const [u, name, expect = 0, opts = {}] of routes) {
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const res = await page.goto(`${ORIGIN}${u}`, { waitUntil: 'networkidle2' });
  const st = res ? res.status() : 0;
  const allowed = st < 300 || (name === '404' && st === 404) || st === expect;
  if (st >= 400 && !allowed) {
    console.log(`? ${name.padEnd(14)} ${u.padEnd(24)} status=${st}`);
    await page.close();
    continue;
  }
  await page.emulateMediaType('print');
  await new Promise((r) => setTimeout(r, 150));
  line(name, u, await probe(page), opts);
  await page.close();
}

const cred = await adminCookie({ origin: ORIGIN, uid: UID, ttl: 120 });
if (!cred.cookie) {
  console.log(`\n后台页未审计：缺 ${cred.need}`);
} else {
  const [ck, ...attrs] = cred.cookie.split(';');
  const i = ck.indexOf('=');
  const cookie = { name: ck.slice(0, i), value: ck.slice(i + 1), url: ORIGIN };
  console.log(`\n(cookie: ${cookie.name}=… len=${cookie.value.length} attrs=${attrs.join(';').trim()})`);
  for (const [u, label] of [
    ['/admin', '后台概览'],
    ['/admin/review', '审核队列'],
    ['/admin/health', '体检'],
    ['/admin/queue', '队列'],
    ['/admin/audit', '审计'],
    ['/admin/history', '版本历史'],
    ['/admin/friends', '友链管理'],
    ['/admin/media', '媒体库'],
    ['/admin/comments', '评论管理'],
    ['/admin/notify', '通知'],
    ['/admin/tools', '工具'],
    ['/admin/stats', '统计'],
    ['/editor', '编辑器'],
  ]) {
    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie(cookie);
    const res = await page.goto(`${ORIGIN}${u}`, { waitUntil: 'networkidle2' });
    const st = res ? res.status() : 0;
    if (st !== 200) {
      console.log(`? ${label.padEnd(14)} ${u.padEnd(24)} status=${st}`);
      await page.close();
      continue;
    }
    await page.emulateMediaType('print');
    await new Promise((r) => setTimeout(r, 150));
    line(label, u, await probe(page));
    await page.close();
  }
}

await b.close();
console.log(fails ? `\n✗ ${fails} 个路由的打印态不合格` : '\n✓ 打印态体检通过');
process.exit(fails ? 1 : 0);
