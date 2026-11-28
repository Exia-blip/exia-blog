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

console.log(fails.length ? `\n✗ ${fails.length} 项视觉修复断言失败` : '');
process.exit(fails.length ? 1 : 0);
