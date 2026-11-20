// 后台导航一致性：editor.html 的静态菜单和 admin-ui.js 的服务端菜单必须同一套。
// 不一致时表现为「写作页能看到新入口，统计页看不到」，人工很难发现。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ADMIN_NAV, renderAdminNav } from '../src/admin-ui.js';
import { renderHealth, renderQueue } from '../src/admin-pages.js';

const editor = readFileSync('public/editor.html', 'utf8');
const stats = readFileSync('src/stats.js', 'utf8');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// 1. 每一项的 id / href / 文案在 editor.html 里都存在
for (const it of ADMIN_NAV) {
  assert.ok(editor.includes(`id="${it.id}"`), `editor.html 缺少 ${it.id}`);
  assert.ok(editor.includes(`href="${it.href}"`), `editor.html 缺少 ${it.href}`);
  assert.ok(new RegExp(`<span>${it.text}</span>`).test(editor), `editor.html 缺少文案 ${it.text}`);
}
ok('editor.html 静态菜单与共享导航逐项一致');

// 2. 服务端菜单渲染包含同一批 href，且当前项带 aria-current
const nav = renderAdminNav('health');
for (const it of ADMIN_NAV) assert.ok(nav.includes(`href="${it.href}"`), `服务端菜单缺少 ${it.href}`);
assert.match(nav, /href="\/admin\/health"[^>]*aria-current|class="on" aria-current="page" href="\/admin\/health"/);
ok('服务端菜单渲染同一批入口，当前项正确高亮');

// 2b. 单一分组平铺：只允许一个 admin-nav-label，不再切成多段
assert.equal((editor.match(/class="admin-nav-label"/g) || []).length, 1, 'editor.html 应只有一个分组标签');
assert.equal((nav.match(/class="admin-nav-label"/g) || []).length, 1, '服务端菜单应只有一个分组标签');
assert.equal((editor.match(/class="admin-nav"/g) || []).length, 1, 'editor.html 应只有一个 nav 容器');
ok('侧栏单一分组平铺，无多段切分');

// 3. stats.js 不再内联自己的菜单，避免两边漂移
assert.ok(stats.includes('renderAdminNav(\'stats\')'), 'stats.js 应复用共享菜单');
assert.ok(!stats.includes('<span>返回首页</span>'), 'stats.js 仍有旧的内联菜单');
ok('统计页复用共享菜单');

// 4. 保留 ?panel= URL，服务端页（统计/健康/队列）点菜单可直接跳到对应视图
for (const p of ['posts', 'checks', 'series', 'site']) {
  assert.ok(editor.includes(`href="/editor?panel=${p}"`), `缺少 ?panel=${p} 入口`);
}
ok('四个 ?panel= 入口 URL 保留，跨页跳转可直达视图');

// 4b. 五个主视图：点菜单整块切换，每个都像写作页一样独占主内容区
const VIEWS = { write: 'view-write', posts: 'view-posts', checks: 'view-checks', series: 'view-series', site: 'site-box' };
for (const [v, id] of Object.entries(VIEWS)) {
  assert.ok(editor.includes(`data-view="${v}" id="${id}"`), `缺少 ${v} 视图容器`);
  assert.ok(editor.includes(`data-view="${v}" id="nav-${v}"`), `缺少 ${v} 导航入口`);
}
assert.ok(editor.includes('function initViews()'), '缺少视图切换逻辑');
assert.ok(!editor.includes('initSidePanel'), '不应保留旧的滚动定位逻辑');
const at = (needle) => editor.indexOf(needle);
assert.ok(at('id="view-posts"') < at('id="cat-list"') && at('id="cat-list"') < at('id="view-checks"'), '文章列表应在独立视图内');
assert.ok(at('id="view-checks"') < at('id="checks"') && at('id="checks"') < at('id="view-series"'), '自检应在独立视图内');
assert.ok(at('id="view-series"') < at('id="series-list"') && at('id="series-list"') < at('id="site-box"'), '系列应在独立视图内');
assert.ok(at('id="site-box"') < at('id="site-name"'), '站点设置应在独立视图内');
ok('五个主视图与导航一一对应，点菜单整块切换');

// 4c. 不再有抽屉/遮罩，视图切换样式就位
const css = readFileSync('public/style.css', 'utf8');
assert.ok(css.includes('.side-toggle, .side-mask { display: none !important; }'), '抽屉按钮/遮罩必须隐藏');
assert.ok(css.includes('.admin-main > .view.active { display: flex; }'), '视图切换 CSS 缺失');
// 文章页的系列目录样式必须限定在 .series 里，否则后台的系列胶囊会被拉成整行
assert.ok(css.includes('.series .series-list'), '系列目录样式应限定在文章页 .series 内');
ok('无抽屉/遮罩，视图切换样式就位');

// 4d. 视图头：标题只由 admin-head 承担，说明 + 元信息各就各位
assert.ok(editor.includes('id="view-desc"'), '缺少视图说明位');
assert.ok(editor.includes("$('view-desc')"), '视图说明没有随视图切换更新');
assert.ok(editor.includes('id="post-count"'), '文章列表缺少篇数');
assert.ok(editor.includes('ci-sub'), '文章行缺少日期/栏目副标题');
assert.ok(editor.includes('id="check-bar"'), '自检缺少进度条');
assert.ok(/check-bar'\)[\s\S]{0,80}style\.width/.test(editor), '进度条没有接线');
assert.equal((editor.match(/id="view-title"/g) || []).length, 1, '标题只允许有一个');
assert.ok(!editor.includes('class="admin-eyebrow"'), '后台头不应再压一层小标签');
ok('视图头只有一层标题 + 说明，进度/计数等元信息就位');

// 5. 新页渲染：任何输入都不抛，且转义 HTML
const hp = renderHealth({
  site: { name: '<img>' },
  checks: [{ label: '<script>', value: 'ok', state: 'ok', note: 'x' }],
  friend: { up: 1, down: 0, checkedAt: '2026-01-01' },
  pc: { hit: 2 },
});
assert.ok(hp.includes('健康检查'));
assert.ok(!hp.includes('<script>'), '标签必须转义');
assert.ok(hp.includes('&lt;img&gt;'), '站名必须转义');
const qp = renderQueue({ site: { name: 'X' }, rows: [{ id: 1, title: '<b>hi</b>', published_at: '2027-03-03 01:00:00' }] });
assert.ok(qp.includes('定时队列'));
assert.ok(!qp.includes('<b>hi</b>'), '文章标题必须转义');
ok('健康检查 / 定时队列渲染正确且转义');

console.log(`\nadmin nav: ${pass} passed`);
