#!/usr/bin/env node
/**
 * 2026-11-28 视觉审计里 P0 四条的静态守卫。
 *
 * 这一批修的是「产物长什么样」，真几何在 scripts/check-desktop.mjs 里测量（需要 Chrome，
 * CI 不跑）。这里守的是「修复本身没被悄悄撤掉」：选择器与声明在不在、阈值有没有被改回去。
 * 两边互补 —— 只有源码断言会漏掉「写了但被更高优先级压住」，
 * 只有浏览器断言则进不了 CI。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { report } from './pitfall-check.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const css = readFileSync(join(ROOT, 'public/style.css'), 'utf8');
const app = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
const post = readFileSync(join(ROOT, 'public/post.html'), 'utf8');
const indexHtml = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const indexSrc = readFileSync(join(ROOT, 'src/index.js'), 'utf8');

let pass = 0;
const fails = [];
const t = (name, fn, id = '') => {
  try {
    fn();
    pass++;
    report(id, name, true);
  } catch (e) {
    fails.push(name);
    report(id, name, false, e.message);
  }
};
const assert = {
  ok: (v, m = 'false') => { if (!v) throw new Error(m); },
  equal: (a, b, m = '') => { if (a !== b) throw new Error(m || `${a} !== ${b}`); },
};

/* 取某条规则的花括号内容。选择器里的点号要转义，否则 . 会匹配任意字符 ——
   那样 .md .table-wrap 能匹配到 .mdXtable-wrap，判据就不精确了。 */
function rule(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
}
/* 行首锚定的源码计数：注释里抄过的写法不能被算进去。 */
const srcHits = (text, re) =>
  text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && re.test(l)).length;

t('表格溢出：真溢出才挂 overflowing，且右缘渐隐挂在这个类上', () => {
  assert.ok(/mask-image:\s*linear-gradient\(to right/.test(rule('.md .table-wrap.overflowing')),
    '.md .table-wrap.overflowing 没有右缘渐隐');
  assert.ok(/mask-image:\s*none/.test(rule('.md .table-wrap.overflowing.at-end')),
    '滑到末尾没有撤掉渐隐（最后一列会永远糊着）');
  assert.ok(/scrollWidth\s*-\s*wrap\.clientWidth\s*>\s*4/.test(app),
    'app.js 没有按 scrollWidth 判是否真溢出');
  assert.ok(srcHits(app, /querySelectorAll\('\.md \.table-wrap'\)/) === 1, 'bindTableScroll 的扫描目标不见了');
  assert.ok(/bindTableScroll\(document\)/.test(post), 'post.html 没有调用 bindTableScroll');
});

t('横幅：标签页/栏目页取本页首篇，不再只看首页', () => {
  assert.ok(srcHits(indexSrc, /const feat = data\.page === 1 \? data\.posts\[0\] : null;/) === 1,
    'feat 不再无条件取本页首篇（是否又被 res.base === "/" 限回首页）');
  assert.equal(srcHits(indexSrc, /res\.base === '\/' && data\.page === 1/), 0, '旧条件还在');
  assert.ok(/hero-feature is-empty/.test(indexSrc), '空栏目没有 is-empty 分支');
  /* 空态必须把 img 节点删掉：留着 src 就是白下 100KB 的 1200×630 */
  assert.ok(/<img class="hf-img"\[\^>\]\*>/.test(indexSrc), '空栏目仍会保留 hf-img（白下 OG 图）');
  assert.ok(/\.hero-feature\.is-empty/.test(css), 'CSS 没有 is-empty 形态');
  assert.ok(/display:\s*grid/.test(rule('.hero-feature.is-empty')), '空态没有居中');
  /* 客户端降级路径与 SSR 同口径：标签/栏目页也填首篇 */
  assert.equal(srcHits(indexHtml, /!currentTag && !currentCat && page === 1/), 0,
    'index.html 仍只在首页填横幅');
});

t('深色封面：压暗落在封面上，不碰正文图与头像', () => {
  const b = rule(':root[data-mode="dark"] .post-card .thumb');
  assert.ok(/brightness\(0?\.7\d\)/.test(b), `卡片封面没有压暗到 0.7x：${b.slice(0, 40)}`);
  assert.ok(/saturate\(0?\.\d+\)/.test(b), '封面没有降饱和');
  const heroB = rule(':root[data-mode="dark"] .hero-feature .hf-img');
  assert.ok(/brightness\(/.test(heroB), '横幅图没有压暗（深色下是一整块亮片）');
  /* 一刀切会糊掉头像与正文插图 —— 它们各有各的明度关系 */
  assert.ok(!/:root\[data-mode="dark"\]\s+\.md\s+img/.test(css), '正文插图被一起压暗了');
  assert.ok(!/:root\[data-mode="dark"\]\s+\.ava/.test(css), '头像被一起压暗了');
});

/* ---------- P1（同一份审计，2026-11-28 第二批） ---------- */

t('P1-5 代码块溢出：渐隐挂在 pre 的 mask 上，覆盖层已撤', () => {
  const over = rule('.md .code-wrap.overflowing pre.code-block');
  assert.ok(/mask-image:\s*var\(--fade-r\)/.test(over), `溢出态没有右缘渐隐：${over.slice(0, 40)}`);
  const end = rule('.md .code-wrap.overflowing.at-end pre.code-block');
  assert.ok(/mask-image:\s*none/.test(end), '滑到末尾没有撤掉渐隐（最后一段永远糊着）');
  /* 覆盖层要按 .code-head 的高度定位，无头的块会错位 —— 换 mask 的理由 */
  assert.ok(!/\.md \.code-wrap\.overflowing[^{]*::after/.test(css), '::after 覆盖层还在（无头代码块会错位）');
  /* 折叠态是纵向 mask，两态同时成立时必须显式合成，否则后一条规则整条盖掉前一条 */
  const both = rule('.md .code-wrap.folded.overflowing pre.code-block');
  assert.ok(/var\(--fade-r\)[\s\S]*var\(--fade-b\)/.test(both),
    `折叠 + 溢出没有叠两层：${both.slice(0, 60)}`);
  /* 变量定义在另一条 .md pre.code-block 里（rule() 只取第一条，这里按全文找） */
  assert.ok(/--fade-r:\s*linear-gradient\(to right/.test(css), '右缘渐隐的变量定义没了');
  assert.ok(srcHits(app, /wrap\.classList\.toggle\('at-end'/) >= 1, 'bindCodeScroll 不再维护 at-end');
  /* at-end 必须和 overflowing 在同一次判定里落：只在 scroll 回调里写，首屏就在末尾的块会一直挂渐隐 */
  const marks = app.match(/export function bindCodeScroll[\s\S]*?return marks;/)?.[0] || '';
  assert.ok(/classList\.toggle\('overflowing', over\)[\s\S]{0,200}classList\.toggle\('at-end'/.test(marks),
    'marks() 里 at-end 没有跟 overflowing 一起判');
}, 'P-119');

t('P1-7 评论邮箱 placeholder 不再被截', () => {
  const m = indexSrc.match(/id="cmt-email"[^>]*placeholder="([^"]*)"/);
  assert.ok(m, '找不到 cmt-email 的 placeholder');
  assert.ok(m[1].length <= 10, `placeholder 还是 ${m[1].length} 个字（203px 的框装不下）：${m[1]}`);
  /* 截短的是提示，不是信息：完整说明留在这两处 */
  assert.ok(/id="cmt-email"[^>]*title="[^"]*不公开[^"]*"/.test(indexSrc), 'input 上没有 title 兜住完整说明');
  assert.ok(/for="cmt-email">[^<]*不公开[^<]*</.test(indexSrc), 'sr-only label 丢了完整说明（读屏听不到）');
  /* 光改短只是把问题推给下一个更长的文案：窄屏那三个框本来就挤到 108px，
     改单列之后每个框吃满一行，文案长短都不再是判据。 */
  assert.ok(
    /@media \(max-width: 640px\) \{\s*\.cmt-form \.row \{ flex-direction: column; \}/.test(css),
    '窄屏评论表单还是三个框挤一行'
  );
}, 'P-119');

t('P1-8 行内代码：窄屏只在放不下时才折，且断点各自完整', () => {
  assert.ok(/\.md code\.code-keep\s*\{[^}]*white-space:\s*nowrap/.test(css), '没有「放得下就不折」的那一档');
  const long = rule('.md code.code-long');
  assert.ok(/overflow-wrap:\s*anywhere/.test(long), '放不下的长串没有放开折行（会把整页撑宽）');
  assert.ok(/box-decoration-break:\s*clone/.test(long), '断点没做 clone，胶囊还是会被撕成两截');
  /* anywhere 不能回到通配口径：那正是「Server-Timing 断在词中间」的来源 */
  const mobile = css.match(/@media \(max-width: 640px\) \{\s*\.md code \{[^}]*\}/);
  assert.ok(mobile, '找不到窄屏 .md code 的基础规则');
  assert.ok(!/\.md code \{[^}]*overflow-wrap:\s*anywhere/.test(mobile[0]), '基础规则又变成 anywhere 了');
  assert.ok(/export function bindInlineCode/.test(app), 'app.js 没有 bindInlineCode');
  assert.ok(srcHits(post, /bindInlineCode\(document\)/) === 1, 'post.html 没有调用 bindInlineCode');
}, 'P-119');

t('P1-9 卡片：摘要节点恒出，标题与摘要各留两行高度', () => {
  /* 条件渲染就是三种高度的来源：缺摘要的卡短两行，grid 把该行拉齐、封面被拉高 */
  assert.ok(!/p\.excerpt \? `<p class="excerpt">/.test(indexSrc), 'SSR 仍在条件渲染摘要节点');
  assert.ok(!/p\.excerpt \? `<p class="excerpt">/.test(indexHtml), '客户端仍在条件渲染摘要节点');
  assert.ok(/<p class="excerpt">/.test(indexSrc) && /<p class="excerpt">/.test(indexHtml), '摘要节点不在模板里了');
  /* 两条留高必须同在 1080 档：手机上是 130 高的横排卡，撑高就破版 */
  assert.ok(
    /@media \(min-width: 1080px\) \{\s*main\.home \.post-card h2 \{ min-height: calc\(2 \* 1\.5em\); \}\s*main\.home \.post-card \.excerpt \{ min-height: calc\(2 \* 1\.68em\); \}\s*\}/.test(css),
    '桌面双列档没有同时给标题与摘要留两行'
  );
}, 'P-119');

t('P1-10 手机浮层：目录与回顶合成一条，独立回顶不再叠在下面', () => {
  const btn = rule('.mtoc-btn');
  assert.ok(/bottom:\s*18px/.test(btn), `胶囊不在底部（会跟回顶叠成两层）：${btn.slice(0, 60)}`);
  assert.ok(/height:\s*40px/.test(btn), '胶囊不是一行高');
  assert.ok(/body:has\(\.mtoc-btn\) \.back-top/.test(css), '有目录胶囊时没有收起独立回顶按钮');
  /* 两段都是真按钮：一个按钮包两段就得靠坐标猜意图 */
  assert.ok(/class="mtoc-open"/.test(post) && /class="mtoc-top"/.test(post), '胶囊没有拆成「开目录 / 回顶」两段');
  assert.ok(/querySelector\('\.mtoc-top'\)\.addEventListener/.test(post), '回顶那一段没有绑定点击');
  assert.ok(!/btn\.addEventListener\('click', open\)/.test(post), '整条胶囊还是单一按钮');
}, 'P-119');

t('P2-11 表头不折行，且只管 .md 正文表', () => {
  assert.ok(/white-space: *nowrap/.test(rule('.md th')), '.md th 没有 nowrap，长表头会被摊成三行');
  /* 必须挂在 .md th 上：写全局 th 会把 /numbers 的四列索引表一起拉宽 */
  assert.ok(!/(^|\})\s*th\s*\{[^}]*nowrap/m.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), '有全局 th 被加了 nowrap');
  assert.ok(!/\.num-table th[^{]*\{[^}]*nowrap/.test(rule('.num-table th') || ''), '/numbers 的表头被一起锁成一行');
}, 'P-120');

t('P2-12 404 最近更新左对齐', () => {
  const wrap = rule('.g404-recent');
  assert.ok(/text-align: *left/.test(wrap), `.g404-recent 还是居中：${wrap.slice(0, 40)}`);
  /* 行线是「与归档同一套行」的落点：只有 li 有边框才看得出是清单 */
  assert.ok(/border-top/.test(rule('.g404-recent li')), '404 列表没有行分隔线');
  assert.ok(/border-bottom/.test(rule('.g404-recent li:last-child')), '最后一行没有收口线');
  /* 居中来源是整页的 text-align:center —— 别再给它改回去 */
  assert.ok(/text-align: *center/.test(rule('.g404')), '404 整页对齐方式变了（三段都要重看一遍）');
}, 'P-120');

t('P2-13 系列页：加宽 + 抬头 + 每行摘要', () => {
  assert.ok(/max-width: *880px/.test(rule('.series-wrap')), '系列页没收到 880（还是 .wrap 的 704）');
  assert.ok(/<main class="wrap series-wrap"/.test(indexSrc), 'seriesShell 的主容器没挂 series-wrap');
  const mast = rule('.series-mast');
  assert.ok(mast && /display: *flex/.test(mast), '.series-mast 不存在或没排版');
  assert.ok(/SELECT slug, title, series_order, published_at, created_at, summary/.test(indexSrc), '系列页查询没带 summary，摘要行永远是空的');
  assert.ok(/class="sp-x"/.test(indexSrc), 'seriesRows 没有渲染摘要行');
  assert.ok(/class="sm-cta"/.test(indexSrc) && /class="sm-stat"/.test(indexSrc), '抬头缺入口或统计格');
  /* 顶上加倍横线：列表自身那条 border-top 与第一行的 a 叠在一起 */
  assert.ok(!/\.series-page\s*\{[^}]*border-top/.test(css), '.series-page 自己又画了一条顶线（会与首行叠成 2px）');
}, 'P-120');

t('P2-14 归档抬头进 arch-shell，与主列共用右边界', () => {
  const arch = readFileSync(join(ROOT, 'public/archive.html'), 'utf8');
  const shellAt = arch.indexOf('<div class="arch-shell">');
  const heroAt = arch.indexOf('<section class="hero">');
  assert.ok(shellAt >= 0 && heroAt > shellAt, 'hero 还在 arch-shell 外面（右边界会压到右栏上方）');
  assert.ok(/\.arch-shell > \.hero\s*\{[^}]*grid-column: *1/.test(css), 'hero 没有进第 1 列');
  const wide = css.match(/@media \(min-width: 1440px\) \{[\s\S]*?\.arch-shell > \.arch-rail \{[^}]*\}/)?.[0] || '';
  assert.ok(/grid-row: *1 \/ span 3/.test(wide), '右栏没有跨 3 行（抬头那一行右侧会空）');
  assert.ok(/\.arch-shell > \.hero\s*\{\s*padding-bottom: *0/.test(css), 'hero 的 padding-bottom 没撤，和 grid gap 叠成 50px');
}, 'P-120');

t('P2-15 作者卡：字母砖 + token 底色，渐变全部撤掉', () => {
  assert.ok(!/linear-gradient/.test(rule('.aw-cover')), '.aw-cover 还有渐变');
  assert.ok(/color-mix\(in srgb, var\(--accent\) 12%/.test(rule('.aw-cover')), '头图不是由 --accent 派生的浅色带（换主题会变外来色）');
  /* 不用正则：这条路径上的反斜杠转义被上游吃过一次，字符串包含更稳 */
  assert.ok(rule('.aw-avatar').includes('background: var(--accent-soft)'), '头像没有一个 token 底色');
  /* 头像不再铺站点头像图：那张是模糊渐变，64px 里认不出东西 */
  assert.ok(!/awAva\.style\.backgroundImage/.test(indexHtml), 'index.html 还在给作者卡头像铺图');
  assert.ok(!/has-img/.test(indexHtml), '还在加一个 CSS 里从来没有的 .has-img');
  assert.ok(/awAva\.textContent\s*=/.test(indexHtml), '作者卡头像没有回填字母');
}, 'P-120');

/* ---------- 简约化补丁（外部给的锚点是另一套仓库，这里守等价落点） ---------- */

t('P3-16 正文链接：静态下划线 + 键盘 focus 与 hover 同款', () => {
  assert.ok(/border-bottom:\s*1px solid var\(--line-strong\)/.test(rule('.md a')),
    '正文链接没有静态下划线（触屏认不出哪几个词能点）');
  const hv = css.match(/\.md a:hover[^{]*\{[^}]*\}/)?.[0] || '';
  assert.ok(/\.md a:focus-visible/.test(hv), 'focus-visible 没有和 hover 共用同一条规则（键盘用户没有反馈）');
  assert.ok(/border-bottom-color:\s*var\(--accent\)/.test(hv), 'hover/focus 没有把底线换成 accent');
  /* 补丁要求「不改全局 a」——一改导航、卡片、标签会全部多出下划线 */
  assert.ok(!/^\s*a\s*\{[^}]*text-decoration:\s*underline/m.test(css), '全局 a 被加了下划线');
}, 'P-122');

t('P3-17 首页卡圆角走 --radius，没有写死的 12px', () => {
  /* 打印块里另有一条同名选择器（只写 break-inside），rule() 只取第一条会抓错 */
  const home = [...css.matchAll(/main\.home \.post-card\s*\{([^}]*)\}/g)]
    .map((m) => m[1]).find((r) => /border-radius/.test(r)) || '';
  assert.ok(/border-radius:\s*var\(--radius\)/.test(home), `首页卡没有走 token：${home.slice(0, 80)}`);
  assert.ok(!/border-radius:\s*12px/.test(home), '首页卡还写死 12px（plum 18px / ink 5px 会被吃掉）');
  assert.ok(/--radius:\s*12px/.test(rule(':root')), '基准半径定义没了');
}, 'P-122');

t('P3-18 首页卡 hover 不位移、封面不缩放，只留边框与底色', () => {
  const hv = rule('main.home .post-card:hover');
  assert.ok(hv && !/transform/.test(hv), `首页卡 hover 还有位移：${hv}`);
  assert.ok(!/main\.home \.post-card:hover \.thumb/.test(css), '封面还在 hover 缩放（划过时抖两下）');
  assert.ok(/background:\s*var\(--bg-soft\)/.test(hv), 'hover 没有底色反馈');
  assert.ok(/border-color:\s*color-mix\(in srgb, var\(--accent\) 32%/.test(hv), 'hover 没有边框加深');
  /* 位移撤掉后，触屏段那条 transform:none 就是死规则，不能留着装样子 */
  const touch = css.match(/@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(!/main\.home \.post-card:hover/.test(touch), '触屏段还在覆盖已不存在的位移');
}, 'P-122');

t('P3-19 打印：代码块浅灰底，token 洗白后仍划得出边界', () => {
  const pr = css.match(/@media print \{[\s\S]*?\n\}/)?.[0] || '';
  const block = pr.match(/\.md pre\.code-block\s*\{([^}]*)\}/)?.[1] || '';
  assert.ok(/background:\s*#f5f5f5\s*!important/.test(block), '打印代码块没有浅灰底（和纸面融成一片）');
  assert.ok(/--bg-soft:\s*#fff\s*!important/.test(pr), 'token 洗白段没了（浅灰底的前提）');
}, 'P-122');

console.log(fails.length ? `\n✗ ${fails.length} 项视觉修复断言失败` : '');
process.exit(fails.length ? 1 : 0);
