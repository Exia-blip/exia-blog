// 侧边目录 sticky 的静态不变量（SC-01~04）。
// 用法：node scripts/test-sticky-css.mjs
//
// 为什么要有这一份：scripts/check-toc-sticky.mjs 是真机检查，需要浏览器 + 线上地址，
// 从来不在 npm test 里跑。也就是说，这条曾经真出过事的规则 —— grid 里写了
// align-items:start，父格缩成 336px，sticky 立刻退化成 relative —— 在 CI 里是无人看守的。
// 那篇文章写了"只有长文章才看得出来"，而 CI 里没有长文章。
//
// 这一份守的是**成因**（CSS 里那三行），真机那份守的是**现象**（滚 1200px 还在原位）。
// 成因错了现象一定错，现象错了成因不一定错（比如父容器被 JS 改了高度），所以两份都要。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/** 取出第一条选择器完全匹配的规则体（够用即可：这几个选择器都只出现一次声明块） */
function rule(sel) {
  const re = new RegExp(
    sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'
  );
  const m = css.match(re);
  return m ? m[1] : '';
}

t('SC-01 .post-article 用 align-items: stretch（不许 start / flex-start）', () => {
  const body = rule('.post-article');
  assert.ok(body, '.post-article 规则不见了，样式结构变了要同步这里');
  assert.match(body, /align-items:\s*stretch/, 'grid item 不拉满整行高度，sticky 就没有可滚的余量');
  assert.ok(!/align-items:\s*(flex-)?start/.test(body), 'align-items:start 就是 P-001 那个回归');
});

t('SC-02 .post-toc 自身 align-self: stretch（父格拉满，子项才跟着拉满）', () => {
  const body = rule('.post-toc');
  assert.match(body, /align-self:\s*stretch/, '目录列没有拉满父格高度');
});

t('SC-03 目录内层是 sticky，停在 86px，且自带内部滚动', () => {
  const body = css.match(/\.post-toc \.toc-inner\s*\{([^}]*)\}/);
  assert.ok(body, '.post-toc .toc-inner 规则不见了');
  const b = body[1];
  assert.match(b, /position:\s*sticky/, '目录不再 sticky');
  assert.match(b, /top:\s*86px/, '吸顶位置不是 86px —— 改这个数要同步 content/12 与实测记录');
  assert.match(b, /max-height:\s*calc\(100vh\s*-\s*\d+px\)/, '没有 max-height：长目录会顶出视口');
  assert.match(b, /overflow:\s*auto/, '没有内部滚动，长目录滚不动');
});

t('SC-04 真机检查仍然存在（成因断言不能替代现象断言）', () => {
  const live = readFileSync(new URL('./check-toc-sticky.mjs', import.meta.url), 'utf8');
  assert.match(live, /align-items:start/, '真机脚本不再提 align-items:start，说明它被改写过');
  assert.match(live, /在 \d+px 目录仍在原位|仍在原位/, '真机脚本的核心断言不见了');
});

/* 变异自检：把 CSS 改坏一次，SC-01 必须红 —— 断言没在真东西上失败过，就不知道它有没有用。
   这里不落盘，只对着字符串跑同一条正则。 */
t('SC-05 变异自检：把 stretch 换成 start 时 SC-01 的匹配会失效', () => {
  const mutated = rule('.post-article').replace(/align-items:\s*stretch/, 'align-items: start');
  assert.ok(!/align-items:\s*stretch/.test(mutated), '检测器对 start 不敏感，SC-01 等于没写');
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
