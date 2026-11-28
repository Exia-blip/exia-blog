// P-126 篇数口径对账的离线断言：七个出口必须报同一个数，任一出口漂移都要红。
// 数据级注入在样本上做；源码级注入（把 uncategorized 丢回 /api/categories）由外部命令做。
import assert from 'node:assert/strict';
import { COUNT_SOURCES, extractPostCount, reconcileCounts } from '../src/count-consistency.js';

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

let bad = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { bad++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
console.log(`\ncount consistency: ${cases.length - bad}/${cases.length} passed\n`);
process.exit(bad ? 1 : 0);
