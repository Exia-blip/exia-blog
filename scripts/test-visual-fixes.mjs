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

console.log(fails.length ? `\n✗ ${fails.length} 项视觉修复断言失败` : '');
process.exit(fails.length ? 1 : 0);
