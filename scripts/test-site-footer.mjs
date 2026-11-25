// 全站页脚守门：静态接线 + 注入边界。
// 页脚是 Worker SSR 注入的，没有可单测的纯函数输出；这里用源码断言锁住
// 「只在读者页注入 / 三按钮复用主题系统 / 打印隐藏」这些改坏了不会报错的约束。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const boot = readFileSync(new URL('../public/boot.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const ver = readFileSync(new URL('../src/version.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('页脚渲染函数：站名 + GitHub + 版权 + 三按钮', () => {
  assert.ok(idx.includes('function siteFooter(site)'));
  assert.ok(idx.includes("const AUTHOR_GITHUB = 'https://github.com/Exia-blip'"));
  assert.ok(idx.includes('target="_blank" rel="noopener noreferrer"'), 'GitHub 外链要带 noopener');
  assert.ok(/<a href="\/">\$\{name\}<\/a>/.test(idx), '站名链回首页');
  assert.ok(idx.includes('© ${year} ${name}'), '版权行用动态年份与站名');
  assert.ok(idx.includes('new Date().getUTCFullYear()'), '年份不写死');
  assert.ok(idx.includes("['light', 'auto', 'dark']"), '三按钮顺序固定');
});

t('三按钮：三种 mode 各有图标与 aria-label', () => {
  for (const [m, label] of [['light', '浅色'], ['auto', '跟随系统'], ['dark', '深色']]) {
    assert.ok(idx.includes(`light: '${label}'`) || idx.includes(`'${label}'`), `缺 ${label} 文案`);
    if (m === 'light') assert.ok(idx.includes("['light', 'auto', 'dark']"), '三按钮数组');
  }
  assert.ok(idx.includes('const MODE_ICON'), '缺图标表');
  assert.ok(idx.includes('data-mode-pick="${m}"'), '按钮带 mode 属性');
});

t('注入边界：只给 isPagePath 的读者页注入，后台/登录排除', () => {
  assert.ok(/if \(isPagePath\(url\.pathname\)\) \{[\s\S]*?siteFooter\(s\)/.test(idx), '注入必须受 isPagePath 约束');
  // isPagePath 不含 editor / login / admin，从定义本身守住
  const m = idx.match(/const isPagePath = \(p\) =>([\s\S]*?);\n/);
  assert.ok(m, '找不到 isPagePath 定义');
  assert.ok(!/editor|login|admin/.test(m[1]), 'isPagePath 不该包含后台路径');
});

t('重复注入兜底：先移除旧 footer 再插入', () => {
  assert.ok(idx.includes('body.replace(/<footer class="site-foot">'), '应先清掉已有页脚');
});

t('系列页单独注入：shell 无 THEME 占位符，不走 injectTheme', () => {
  // 系列壳直接返回完整 HTML，injectTheme 的 `<!--THEME-->` 前置检查会跳过它，
  // 必须在 seriesShell 模板里显式插页脚，否则 /series 全站唯一没有页脚的读者页。
  const shell = idx.slice(idx.indexOf('function seriesShell('), idx.indexOf('function seriesShell(') + 4000);
  assert.ok(/\$\{siteFooter\(site\)\}/.test(shell), 'seriesShell 模板应直接插页脚');
});

t('boot.js：事件委托 + 动态 import theme.js，配 404/系列页', () => {
  assert.ok(boot.includes('function initFootModes()'));
  assert.ok(boot.includes('initFootModes()'), '必须实际调用');
  assert.ok(boot.includes("import('/theme.js')"), '复用主题系统而非重写');
  assert.ok(boot.includes("m.apply(p.theme, btn.getAttribute('data-mode-pick'))"), '走同一套 apply');
  assert.ok(boot.includes('function syncFootModes(mode)'), '选中态同步');
  assert.ok(boot.includes('aria-pressed'), '无障碍状态');
});

t('theme.js：syncUI 覆盖 data-mode-pick，两处选中态一致', () => {
  assert.ok(theme.includes("querySelectorAll('[data-mode-pick]')"), 'syncUI 应同步所有 mode 按钮');
  assert.ok(theme.includes("m.dataset.modePick"), '面板内按钮仍可切 mode');
});

t('样式：跟随主题变量、窄屏、reduced-motion、打印隐藏', () => {
  assert.ok(css.includes('.site-foot {'));
  assert.ok(css.includes('var(--bg-soft)') && css.includes('var(--line)'), '颜色走主题变量');
  assert.ok(css.includes('.foot-mode.on {'), '选中态样式');
  assert.ok(css.includes('prefers-reduced-motion: reduce'), '降级动画');
  assert.ok(/\.site-foot[^}]*display: none !important/.test(css.slice(css.indexOf('@media print'))), '打印时隐藏页脚');
});

t('页脚版本号：与 package.json 同值，且不冒充资源版本号', () => {
  // 行首锚定 + 唯一计数：注释里也写着这串名字，indexOf 会搜到自己。
  const defs = ver.match(/^export const SITE_RELEASE = '([0-9]+\.[0-9]+\.[0-9]+)';$/gm) || [];
  assert.equal(defs.length, 1, `SITE_RELEASE 定义应唯一且为 x.y.z，实际 ${defs.length} 处`);
  const shown = defs[0].match(/'([^']+)'/)[1];
  assert.equal(shown, pkg.version, `页脚版本 ${shown} 与 package.json ${pkg.version} 不一致`);
  assert.ok(idx.includes("import { SITE_RELEASE } from './version.js';"), '页脚必须引用同一常量');
  assert.ok(idx.includes('v${SITE_RELEASE}'), '页脚模板要真的渲染出版本号');
  /* 并进版权那一行而不是另起一行：CSS 预算只剩 27 B，新增一条 .sf-ver 规则
     就会把 style.css 顶出 39000（实测 +75 B）。宁可复用 sf-copy 的样式。 */
  assert.ok(idx.includes('© ${year} ${name} · v${SITE_RELEASE}'), '版本应与版权同一行（挂在 sf-copy 里）');
  assert.ok(!/\.sf-ver\b/.test(css), '别为版本号新增 CSS——预算只剩 27 B');
  /* semver 一旦进了 ?v=，「发了新内容」和「版本没变」就同时成立，缓存永远不换。
     资源版本只认内容哈希与部署号，这两条链不许接 semver。 */
  const assets = readFileSync(new URL('../src/assets.js', import.meta.url), 'utf8');
  assert.ok(!/SITE_RELEASE/.test(assets), '资源版本号不该取 SITE_RELEASE');
});

let bad = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { bad++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
console.log(`\nsite footer: ${cases.length - bad}/${cases.length} passed\n`);
process.exit(bad ? 1 : 0);
