// 侧栏目录「真的吸住」的回归：滚 1200px 之后，它应该还在原地。
//
// 这条单独拎出来，是因为它坏掉的方式特别安静：页面不报错、目录也还在，
// 只是跟着正文一起滚走了。CI 里只有「进度条宽度对不对」是查不出来的 ——
// 色条比例全对，只不过整块跟着跑出视口。
//
// 失效的根因（写这篇文章时才想明白）：sticky 的滚动余量来自「父容器比视口高」。
// grid item 默认 stretch，父容器被拉到整行高，余量才有；一旦有人在
// .post-article 上写 align-items: start，父容器缩成自身内容高度，
// sticky 就退化成 relative —— 而且只有长文章才看得出来。
//
// 用法：node scripts/check-toc-sticky.mjs [url]
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';
import { report } from './pitfall-check.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8788/p/ci-fixture';
const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url + (url.includes('?') ? '&' : '?') + '__t=' + Date.now(), {
  waitUntil: 'networkidle2',
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 700));

const hasToc = await page.evaluate(() => {
  const toc = document.querySelector('.post-toc');
  return !!toc && getComputedStyle(toc).display !== 'none' && !!document.querySelector('.post-toc .toc-inner');
});
if (!hasToc) {
  console.log('页面没有侧栏目录（窄屏或非文章页），跳过');
  await browser.close();
  process.exit(0);
}

const measure = () =>
  page.evaluate(() => {
    const toc = document.querySelector('.post-toc');
    const inner = document.querySelector('.post-toc .toc-inner');
    const art = document.querySelector('.post-article');
    const cs = getComputedStyle(inner);
    return {
      y: Math.round(scrollY),
      vh: innerHeight,
      docH: document.documentElement.scrollHeight,
      tocH: Math.round(toc.getBoundingClientRect().height),
      innerTop: Math.round(inner.getBoundingClientRect().top),
      pos: cs.position,
      top: parseInt(cs.top, 10),
      align: art ? getComputedStyle(art).alignItems : '',
      // sticky 吸住时，inner 的 top 应恒等于声明的 top
    };
  });

let bad = 0;
const check = (id, name, cond, extra = '') => {
  if (!report(id, name, cond, extra)) bad++;
};

const before = await measure();
check('P-001', '侧栏目录 position 是 sticky', before.pos === 'sticky', before.pos);
/* sticky 要生效，父容器必须比视口高出一截 —— 这正是 align-items:start 破坏的地方 */
check(
  'P-001',
  '目录父容器高过视口（有滚动余量）',
  before.tocH > before.vh * 1.2,
  `tocH=${before.tocH} vh=${before.vh}`
);
check('P-001', '文章容器不是 align-items:start', before.align !== 'start', before.align);

/* 先滚一小段让 sticky 真正吸住，再取基准。
   页面在 scrollY=0 时目录还没贴到 top:86（它跟着文档流在 100 的位置），
   拿这个值当基准会把「正常吸顶」误判成 14px 漂移。 */
await page.evaluate(() => window.scrollTo(0, 500));
await new Promise((r) => setTimeout(r, 450));
const base = await measure();
check('P-001', '吸顶位置等于 CSS 的 top', Math.abs(base.innerTop - base.top) <= 2, `top=${base.innerTop} 期望=${base.top}`);

await page.evaluate(() => window.scrollTo(0, 1700));
await new Promise((r) => setTimeout(r, 450));
const after = await measure();

const drift = Math.abs(after.innerTop - base.innerTop);
/* 能滚的前提下，再滚 1200 后目录顶边应该几乎没动；跟走的话 drift 会接近 1200 */
check('P-001', '再滚 1200px 目录仍在原位', drift <= 5, `drift=${drift}px top=${after.innerTop}`);

/* 再往下滚一屏，确认不是「刚好这一屏对」，而是持续吸住 */
await page.evaluate(() => window.scrollTo(0, 2900));
await new Promise((r) => setTimeout(r, 450));
const far = await measure();
check('P-001', '再滚 1200px 仍然吸住', Math.abs(far.innerTop - base.top) <= 2, `top=${far.innerTop}`);

console.log(`${bad ? 'FAIL' : 'PASS'}  目录吸顶 ${bad ? bad + ' 条失败' : '全部通过'}`);
await browser.close();
process.exit(bad ? 1 : 0);
