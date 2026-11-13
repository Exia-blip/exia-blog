// 系列结构化数据回归：position 与 isPartOf 的地址都必须真的存在。
// 以前的 isPartOf.url 填的是当前文章地址（自指），系列页建起来之前没人发现。
// 用法：node scripts/test-seo-series.mjs
import assert from 'node:assert/strict';
import { postLd } from '../src/seo.js';

const site = { name: 'Exia Blog', desc: 'x' };
const origin = 'https://exia.de5.net';
const base = {
  site,
  origin,
  url: `${origin}/p/oauth-pkce`,
  image: '',
  words: 5200,
};

const withSeries = (over = {}) =>
  postLd({
    ...base,
    post: {
      slug: 'oauth-pkce',
      title: 'PKCE 补的是哪个洞',
      category: 'teardown',
      series: 'OAuth 授权流程拆解',
      series_order: 2,
      published_at: '2026-11-06 08:00:00',
      created_at: '2026-11-06 08:00:00',
      ...over,
    },
  });

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('系列文带 position，值就是 series_order', () => {
  const a = withSeries()['@graph'][0];
  assert.equal(a.position, 2);
});

t('isPartOf 指向 /series/<名称>，不是文章自己', () => {
  const a = withSeries()['@graph'][0];
  assert.equal(a.isPartOf['@type'], 'CreativeWorkSeries');
  assert.equal(a.isPartOf.url, `${origin}/series/${encodeURIComponent('OAuth 授权流程拆解')}`);
  assert.notEqual(a.isPartOf.url, base.url);
});

t('系列名里的特殊字符被转义进 URL', () => {
  const a = withSeries({ series: 'A/B 系列' })['@graph'][0];
  assert.ok(a.isPartOf.url.endsWith('/series/A%2FB%20%E7%B3%BB%E5%88%97'));
});

t('没有系列时不带 position，isPartOf 退回站点', () => {
  const a = withSeries({ series: '', series_order: 0 })['@graph'][0];
  assert.equal(a.position, undefined);
  assert.equal(a.isPartOf, `${origin}/#website`);
});

t('series_order 缺失/为 0 时不写 position（0 不是合法序号）', () => {
  const a = withSeries({ series_order: 0 })['@graph'][0];
  assert.equal(a.position, undefined);
  assert.equal(a.isPartOf['@type'], 'CreativeWorkSeries');
});

let bad = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    bad++;
    console.log('  FAIL  ' + name + ' — ' + e.message);
  }
}
console.log(`\n${cases.length - bad}/${cases.length} 通过`);
process.exit(bad ? 1 : 0);
