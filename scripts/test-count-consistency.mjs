// P-126 篇数口径对账的离线断言：七个出口必须报同一个数，任一出口漂移都要红。
// 数据级注入在样本上做；源码级注入（把 uncategorized 丢回 /api/categories）由外部命令做。
import assert from 'node:assert/strict';
import { COUNT_SOURCES, extractPostCount, reconcileCounts, catTotalText } from '../src/count-consistency.js';
import { readFileSync } from 'node:fs';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const sitemapDoc = (n) =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: n }, (_, i) =>
    `<loc>https://miu.sryze.cc/p/post-${i + 1}</loc>`).join('')}</urlset>`;
const rssDoc = (n) => `<rss version="2.0">${'<item>'.repeat(n)}</rss>`;

/** 七出口全报 21 的样本；改其中一处即模拟口径漂移。 */
const sample = () => ({
  api: JSON.stringify({ total: 21 }),
  categories: JSON.stringify({
    categories: [{ count: 10 }, { count: 5 }, { count: 5 }, { count: 1 }],
    uncategorized: 0,
  }),
  sitemap: sitemapDoc(21),
  rss: rssDoc(21),
  home: '共 21 篇',
  archive: '共 <b>21</b> 篇',
  categoriesPage: '4 个栏目 · 21 篇',
});

t('七个出口全抽到数且一致', () => {
  const r = reconcileCounts(sample());
  assert.equal(r.bad.length, 0);
  assert.equal(r.distinct.length, 1);
  assert.equal(r.consistent, true);
  assert.deepEqual(Object.keys(r.values).sort(), [...COUNT_SOURCES].sort());
});

for (const source of COUNT_SOURCES) {
  t(`${source} 漂移成别的数 → 红`, () => {
    const raw = sample();
    const before = extractPostCount(source, raw[source]);
    switch (source) {
      case 'api': raw.api = '{"total":20}'; break;
      case 'categories':
        raw.categories = JSON.stringify({
          categories: [{ count: 10 }, { count: 4 }, { count: 5 }, { count: 1 }],
          uncategorized: 0,
        });
        break;
      case 'sitemap': raw.sitemap = sitemapDoc(20); break;
      case 'rss': raw.rss = rssDoc(20); break;
      case 'home': raw.home = '共 40 篇'; break;
      case 'archive': raw.archive = '共 <b>40</b> 篇'; break;
      case 'categoriesPage': raw.categoriesPage = '4 个栏目 · 40 篇'; break;
    }
    assert.notEqual(extractPostCount(source, raw[source]), before);
    assert.equal(reconcileCounts(raw).consistent, false);
  });
}

t('抽不到数的出口算坏，不能当空集恒真', () => {
  const raw = sample();
  raw.home = '页面没渲染出篇数';
  const r = reconcileCounts(raw);
  assert.equal(Number.isNaN(r.values.home), true);
  assert.deepEqual(r.bad, ['home']);
  assert.equal(r.consistent, false);

  /* 单独一个出口抽不到时，distinct 里会多出 NaN，光靠「去重后是否只有一个值」
     也会给出 false —— 那条弱判据看不到 bad 是否参与了判定。把七处全改成抽不到，
     distinct 恰好只剩一个 NaN，此时若 consistent 没挂 bad 守卫就会假绿。 */
  const allBad = {};
  for (const s of COUNT_SOURCES) allBad[s] = '页面没渲染出篇数';
  const empty = reconcileCounts(allBad);
  assert.equal(empty.bad.length, COUNT_SOURCES.length);
  assert.equal(empty.distinct.length, 1, '七处 NaN 去重后是一个值');
  assert.equal(empty.consistent, false);
});

t('未归类文章计入栏目合计，否则和 API total 差一截', () => {
  const raw = sample();
  const j = JSON.parse(raw.categories);
  j.categories[1].count = 4;              // 四格加起来 20
  j.uncategorized = 1;                    // 另有一篇公开文章没归类
  raw.categories = JSON.stringify(j);
  assert.equal(extractPostCount('categories', raw.categories), 21);
  assert.equal(reconcileCounts(raw).consistent, true);
  // 把 uncategorized 丢掉就立刻不一致——这是旧 catCounts 的行文方式。
  delete j.uncategorized;
  raw.categories = JSON.stringify(j);
  assert.equal(reconcileCounts(raw).consistent, false);
});

t('合计文案：无未归类时不加括注，有未归类时显式说明差', () => {
  assert.equal(catTotalText(4, 21, 0), '4 个栏目 · 21 篇');
  assert.equal(catTotalText(4, 20, 1), '4 个栏目 · 21 篇（含 1 篇未归类）');
  assert.equal(catTotalText(4, 18, 3), '4 个栏目 · 21 篇（含 3 篇未归类）');
  // 合计必须含未归类，否则四格加起来 20、合计也写 20，跟 API 的 21 对不上。
  assert.notEqual(catTotalText(4, 20, 1), '4 个栏目 · 20 篇');
});

t('SSR 不丢未归类：catCounts 累计并带回 uncategorized', () => {
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const fn = idx.slice(idx.indexOf('async function catCounts(env) {'), idx.indexOf('\n}\n', idx.indexOf('async function catCounts(env) {')));
  assert.ok(/if \(!slug\) \{[\s\S]*?uncategorized \+=[\s\S]*?continue/.test(fn), '未归类要累计而不是 continue');
  assert.ok(!/if \(!slug\) continue/.test(fn), '旧的直接丢弃写法不能回来');
  assert.ok(fn.includes('return { counts, uncategorized }'), '合计要随结果一起带回');
  assert.ok(idx.includes('catTotalText(CATS.length, sum, catData.uncategorized)'), 'renderCats 要用同一份文案');
});

t('客户端不再自己求和，直接消费 API 的 totalText', () => {
  const html = readFileSync(new URL('../public/categories.html', import.meta.url), 'utf8');
  const m = html.match(/async function syncCatCounts\(\) \{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 syncCatCounts');
  assert.ok(/const \{ categories, totalText \}/.test(m[1]), '客户端要取 totalText');
  assert.ok(m[1].includes('catTotal.textContent = totalText'), '合计要用 API 的文案');
  assert.ok(!/reduce\(\(a, b\) => a \+ b\.count/.test(m[1]), '客户端不再自己求和');
});

let bad = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { bad++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
console.log(`\ncount consistency: ${cases.length - bad}/${cases.length} passed\n`);
process.exit(bad ? 1 : 0);
