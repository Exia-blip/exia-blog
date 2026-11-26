// 系列结构化数据回归：position 与 isPartOf 的地址都必须真的存在。
// 以前的 isPartOf.url 填的是当前文章地址（自指），系列页建起来之前没人发现。
// 用法：node scripts/test-seo-series.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { postLd } from '../src/seo.js';
import { report } from './pitfall-check.mjs';

const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

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
const t = (name, fn, id = '') => cases.push([name, fn, id]);

t('系列文带 position，值就是 series_order', () => {
  const a = withSeries()['@graph'][0];
  assert.equal(a.position, 2);
});

t('isPartOf 指向 /series/<名称>，不是文章自己', () => {
  const a = withSeries()['@graph'][0];
  assert.equal(a.isPartOf['@type'], 'CreativeWorkSeries');
  assert.equal(a.isPartOf.url, `${origin}/series/${encodeURIComponent('OAuth 授权流程拆解')}`);
  assert.notEqual(a.isPartOf.url, base.url);
}, 'P-006');

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

/* 头像必须全链路走代理。JSON-LD 上的 githubusercontent 外链看不见摸不着，
   但搜索引擎会真的去取 —— 页面上那两处 <img> 早就代理了，这里漏过一次。
   这两条原本写在 process.exit 之后，从未执行过 —— 一并挪到循环前面。 */
t('作者头像走 /avatar 代理，不让 githubusercontent 直链进 JSON-LD', () => {
  const a = withSeries({ avatar: 'https://avatars.githubusercontent.com/u/191740539?v=4' })['@graph'][0];
  assert.equal(a.author.image, `${origin}/avatar?u=${encodeURIComponent('https://avatars.githubusercontent.com/u/191740539?v=4')}&s=128`);
  // 地址被编码进 u= 参数后仍含 githubusercontent 字面串，这是正常的 ——
  // 要验的是它挂在本站 /avatar 代理后面，而不是裸外链
  assert.match(a.author.image, /^https:\/\/exia\.de5\.net\/avatar\?u=/);
  assert.ok(!a.author.image.startsWith('https://avatars.githubusercontent.com/'));
});

t('作者没头像不出 image 字段，不塞 undefined 进 JSON', () => {
  const a = withSeries({ avatar: '' })['@graph'][0];
  // postLd 写的是 image: undefined（键在、值不在），序列化后会被 JSON 丢掉 ——
  // 所以要验的是值为 undefined，不是键不存在
  assert.equal(a.author.image, undefined, `实际 author=${JSON.stringify(a.author)}`);
});

/* 系列壳的分享卡片与资源戳：纯前端壳子没有可 import 的输出，按惯例用静态钩子锁定。 */
const shell = src.match(/function seriesShell\([\s\S]*?\n\}/)?.[0] || '';

t('系列壳输出完整 OG 块，不再只给 title/desc/canonical', () => {
  assert.match(shell, /og:type.*website/);
  assert.match(shell, /og:site_name/);
  assert.match(shell, /og:title/);
  assert.match(shell, /og:description/);
  assert.match(shell, /og:url/);
  assert.match(shell, /og:locale.*zh_CN/);
  assert.match(shell, /og:image/);
});

t('系列壳输出 twitter 三件套，分享图走 og-default', () => {
  assert.match(shell, /twitter:card.*summary_large_image/);
  assert.match(shell, /twitter:title/);
  assert.match(shell, /twitter:description/);
  assert.match(shell, /twitter:image/);
  assert.match(shell, /og-default\.jpg/);
});

t('系列壳无内联 style（两处壳样式已迁 style.css）', () => {
  assert.ok(!/<style>/.test(shell), 'seriesShell 仍有内联 style');
  const notFound = src.match(/async function notFoundPage\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(!/<style>/.test(notFound), '404 仍有内联 style');
  assert.match(css, /\.series-page\s*\{/, 'style.css 缺系列页样式');
  assert.match(css, /\.g404\s*\{/, 'style.css 缺 404 样式');
  // 500 故障页的内联是故意兜底，必须还在
  const serverErr = src.match(/export function serverErrorPage\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(serverErr, /<style>/, '500 页的内联兜底不该被迁走');
});

t('系列页页脚用专属类名，不与评论表单 .foot 冲突', () => {
  assert.match(shell, /class="series-foot"/);
  assert.ok(!/class="foot"/.test(shell), '系列页仍在用 .foot');
  assert.match(css, /\.series-foot\s*\{/);
  assert.match(src, /class="foot"/, '评论表单的 .foot 应保留');
});

t('所有系列壳入口都过 stampAssets，资源带部署版本戳', () => {
  // 函数定义 `function seriesShell({...})` 也算一次，排除掉才是调用点。
  // 三处：系列页 / 系列总览 / 数字索引页（/numbers 复用同一套 shell）。
  const allCalls = (src.match(/seriesShell\(\{/g) || []).length;
  const shellCalls = allCalls - (/\bfunction\s+seriesShell\(\{/.test(src) ? 1 : 0);
  const stampCalls = (src.match(/stampAssets\(seriesShell\(\{/g) || []).length;
  assert.equal(shellCalls, 3, '应有三处系列壳调用（含 /numbers）');
  assert.equal(stampCalls, shellCalls, '每一处 seriesShell 都必须包在 stampAssets 里');
});

t('404 有 skip-link 且指向可用的 #main', () => {
  const notFound = src.match(/async function notFoundPage\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(notFound, /class="skip-link" href="#main"/);
  assert.match(notFound, /id="main"/);
  assert.match(notFound, /<main class="g404" id="main"/, 'skip-link 目标应是主内容区');
});

/* ---------- RSS 自动发现：一份实现、三个出口 ----------

   漏一个出口的症状是「某类页面没有 feed 声明」，线上只有真去抓那一页才看得见
   —— 静态页、系列页、文章页是三个不同的 head 生成路径，谁都不会因为别人有就自动有。
   反过来，把这一行再硬写进静态壳，首页就会出现两条同名 link（渲染一条、壳里一条），
   浏览器和阅读器不报错，只是重复。两个方向都盯住。 */
t('RSS 声明只有一份实现', () => {
  const defs = src.match(/^function rssAlternate\(/gm) || [];
  assert.equal(defs.length, 1, `定义 ${defs.length} 处`);
});

t('RSS 声明被三个 head 出口引用', () => {
  const uses = src.match(/^\s*(?:\$\{)?rssAlternate\(origin\)/gm) || [];
  assert.equal(uses.length, 3, `引用 ${uses.length} 处（静态页 / 系列页 / 文章页）`);
});

t('静态壳里不再硬写 RSS 声明', () => {
  for (const f of ['index', 'archive', 'categories']) {
    const html = readFileSync(new URL(`../public/${f}.html`, import.meta.url), 'utf8');
    assert.equal((html.match(/rel="alternate"/g) || []).length, 0, `${f}.html 里还有硬写的那行`);
  }
});

let bad = 0;
for (const [name, fn, id] of cases) {
  try {
    fn();
    report(id, name, true);
  } catch (e) {
    bad++;
    report(id, name, false, e.message);
  }
}
console.log(`\n${cases.length - bad}/${cases.length} 通过`);
process.exit(bad ? 1 : 0);
