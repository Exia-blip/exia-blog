// L3 守门：阅读进度位置/开关、代码块增强、标签云配色、TOC 交互。
// 前三项是纯前端补钩子（不动 SSR/落库 HTML），靠静态钩子锁定；标签配色函数直接跑。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const post = readFileSync('public/post.html', 'utf8');
const index = readFileSync('public/index.html', 'utf8');
const editor = readFileSync('public/editor.html', 'utf8');
const server = readFileSync('src/index.js', 'utf8');
const clean = readFileSync('src/clean.js', 'utf8');
const app = readFileSync('public/app.js', 'utf8');
const css = readFileSync('public/style.css', 'utf8');

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

// ---------- L3-2 TOC（已存在，锁住别被回退） ----------
assert.ok(post.includes('function bindTocSpy()'), '缺滚动高亮 bindTocSpy');
assert.ok(post.includes('function mountMobileToc()'), '缺移动端目录');
const mtoc = post.match(/function mountMobileToc\(\)[\s\S]*?\n\}/)?.[0] || '';
assert.match(mtoc, /a\[data-toc\]/, '移动端目录应认目录项点击');
assert.match(mtoc, /if \(a\) \{ close\(\); return; \}/, '点目录项必须自动收起抽屉');
ok('TOC 滚动高亮 + 移动端点击目录项自动收起');

// ---------- L3-1 阅读进度：位置可选 + 开关 ----------
assert.ok(app.includes('export function readBarPref()'), '缺偏好读取');
assert.ok(app.includes('export function setReadBarPref('), '缺偏好写入');
assert.ok(app.includes('export function applyReadBarPos()'), '缺偏好落地');
assert.match(app, /v === 'bottom' \|\| v === 'off'/, '偏好必须白名单，拒绝脏值');
assert.match(css, /\.read-bar\.bottom\s*\{[^}]*bottom:\s*0/, '缺底部定位样式');
assert.match(css, /\.read-bar\.off[^}]*display:\s*none/, '关闭态必须 display:none');
assert.ok(post.includes('bindReadbarToggle();'), '文章页未接进度开关');
assert.ok(post.includes('setReadBarPref'), '文章页未引入偏好写入');
assert.match(post, /\['top', 'bottom', 'off'\]/, '开关应三态循环');
assert.match(css, /header\.site, \.read-bar/, '打印仍应隐藏进度条');
ok('阅读进度三态循环 + 白名单偏好 + 顶部/底部定位');

// ---------- L3-3 代码块增强 ----------
assert.ok(app.includes('export function enhanceCodeBlocks('), '缺代码块增强函数');
const ecb = app.match(/export function enhanceCodeBlocks\([\s\S]*?代码块横向滚动标记/)?.[0] || '';
assert.match(ecb, /fold-btn/, '缺折叠按钮');
assert.match(ecb, /aria-expanded/, '折叠按钮应带可访问状态');
assert.match(ecb, /code-lang[\s\S]*?\.title =/, '语言徽章 hover 提示未接线');
assert.match(ecb, /caretRangeFromPoint/, '点行号定位应优先精确方法');
assert.match(ecb, /code\.innerText\.split\('\\n'\)/, '复制单行应只取 code 内容，不含 gutter');
assert.ok(post.includes('enhanceCodeBlocks(document)'), '文章页未接代码块增强');
assert.ok(editor.includes('enhanceCodeBlocks(previewEl)'), '编辑器预览未接代码块增强');
assert.match(css, /\.code-wrap\.folded pre\.code-block\s*\{[^}]*max-height/, '缺折叠限高样式');
assert.match(css, /@media print[\s\S]*?code-wrap\.folded pre\.code-block\s*\{[^}]*max-height:\s*none/, '打印必须展开折叠代码');
assert.match(css, /\.gutter[^}]*user-select:\s*none/, '行号列不可选中（复制不带行号）');
ok('代码块折叠/语言提示/点行号复制，文章页与编辑器预览双接线');

// ---------- L3-4 标签筛选栏整块下线（2026-11-28） ----------
/* 这条栏长期是「SSR 在拼、客户端在填、CSS 在藏」的三重空转：template 有 div、
   renderListBars 有分支、loadTags() 有 innerHTML、样式表有 display:none。
   四条链都有产物、页面上一片空白。整块删掉后，下面三条守它别被谁的复制粘贴带回来。
   （原来这里守的是「SSR 与前端共用 tagClass，避免两套配色」—— 出口只剩一处，
     那个漂移风险随之消失，tagClass 函数也一起删了。） */
assert.ok(!server.includes('<!--TAGBAR-->'), 'SSR 仍在渲染已下线的标签筛选栏');
assert.ok(!index.includes('id="tagbar"'), '首页模板仍有 #tagbar 容器');
assert.ok(!/loadTags\s*\(/.test(index), '标签栏的下线没清干净（首页仍在调用 loadTags）');
// [P-088] 标签云已单色：不再按名字上色（十档色板与 5 色轮换都删了）。
// 反向断言 —— 只要有人往 CSS 里塞回一处 --tw 定义就会红。
assert.ok(!/--tw\s*:/.test(css), '标签云已单色，不应再有 --tw 色相定义');
assert.ok(!/\.tag\[class\*="tw-t"\]/.test(css), '不应再有按 tw-t 上色的选择器');
ok('标签筛选栏三处一致下线，CSS 侧也不再有按名上色');

// ---------- iframe 懒加载兜底：前端补钩子，不碰 SSR ----------
// 消毒白名单不放行 iframe（clean.js 剥掉），站内正文尚无真实嵌入；
// 这条守的是"将来放行视频嵌入时 hydrate 自动补 loading=lazy"的接线不被误删。
const lazyFn = app.match(/export function lazyIframes\([\s\S]*?\n\}/)?.[0] || '';
assert.match(lazyFn, /querySelectorAll\?\.\('iframe:not\(\[loading\]\)'\)/, '懒加载只补缺省值，不覆盖已有 loading');
assert.match(lazyFn, /setAttribute\('loading',\s*'lazy'\)/, '懒加载应设置 loading=lazy');
assert.ok(post.includes('lazyIframes(document)'), '文章页未接 iframe 懒加载');
// SSR 侧必须保持零 iframe 输出：clean.js 黑名单仍在
assert.match(clean, /BAD_(BLOCK|SELF)[^;\n]*iframe/, 'clean.js 必须继续剥 iframe');
ok('iframe 懒加载兜底接线，SSR 保持零 iframe 输出');

console.log(`\n[P-013] ux L3: ${pass} passed`);
