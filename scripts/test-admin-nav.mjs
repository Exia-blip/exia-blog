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

// 4. 每个 panel 参数都能在 editor.html 里找到对应锚点，否则侧栏点了没反应
for (const p of ['posts', 'checks', 'series', 'site']) {
  assert.ok(new RegExp(`${p}: \\$\\('`).test(editor), `缺少 ?panel=${p} 的落点`);
}
ok('文章列表/自检/系列/站点设置四个入口都有真实落点');

// 4b. 发布自检默认收起（details 无 open），且我的文章排在它前面直接显现
assert.match(editor, /<details class="checks-fold" id="checks-fold">/, '自检应为可折叠块');
assert.ok(!/<details class="checks-fold"[^>]*\bopen\b/.test(editor), '自检默认必须收起');
assert.ok(editor.indexOf('id="cat-list"') < editor.indexOf('id="checks-fold"'), '我的文章应排在自检之前');
assert.ok(editor.includes("checks: $('checks-fold')"), 'panel=checks 应指向折叠容器，点击才能展开');
ok('发布自检默认收起，我的文章直接显现');

// 4c. 侧栏常驻右侧：点菜单内容直接在右边显现，不再弹抽屉/遮罩
const css = readFileSync('public/style.css', 'utf8');
assert.ok(css.includes('.side-toggle, .side-mask { display: none !important; }'), '抽屉按钮/遮罩必须隐藏');
assert.ok(!/initSideDrawer|setOpen\(/.test(editor), 'editor.html 不应再保留抽屉开合逻辑');
assert.ok(/\.editor-body \{ flex-direction: column;/.test(css), '窄屏应把侧栏堆到编辑区下方，而非抽屉');
ok('侧栏常驻右侧，点菜单直接显现，不弹抽屉/遮罩');

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
