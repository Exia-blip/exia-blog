// L3 守门：阅读进度位置/开关、代码块增强、标签云配色、TOC 交互。
// 前三项是纯前端补钩子（不动 SSR/落库 HTML），靠静态钩子锁定；标签配色函数直接跑。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tagClass, avatarTone } from '../public/avatar.js';

const post = readFileSync('public/post.html', 'utf8');
const index = readFileSync('public/index.html', 'utf8');
const editor = readFileSync('public/editor.html', 'utf8');
const server = readFileSync('src/index.js', 'utf8');
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

// ---------- L3-4 标签云配色：前后端同一函数 ----------
const bars = server.match(/function renderListBars\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(bars.includes('tagClass(t.name, t.count)'), 'SSR 标签栏未用 tagClass');
assert.ok(!/`class="tag" href="\/tag\//.test(bars), 'SSR 标签栏仍在用裸 tag class');
assert.ok(index.includes('tagClass(t.name, t.count)'), '前端未用 tagClass');
assert.ok(index.includes("from '/avatar.js'"), '前端未引入 avatar.js');
// 纯函数行为：色相复用头像哈希、权重按数量分档、输入转义由调用方 esc 负责
// 同名标签的色相后缀应与头像哈希一致（tw-tN vs ava-tN）
assert.equal(tagClass('访客', 1).split(' ')[1], avatarTone('访客').replace('ava-', 'tw-'));
assert.match(tagClass('访客', 1), /^tag tw-t\d tw-w1$/);
assert.match(tagClass('x', 6), /tw-w3$/, '6 篇以上应最重档');
assert.match(tagClass('x', 3), /tw-w2$/, '3 篇应中档');
assert.match(tagClass('x', 0), /tw-w1$/, '0 篇应轻档');
assert.equal(tagClass('同一标签', 5).split(' ')[1], tagClass('同一标签', 99).split(' ')[1], '同名标签色相恒定');
// 十档色值齐全，且只在带 tw-t 的标签上生效，不污染文章卡片标签
for (let i = 0; i < 10; i++) assert.ok(css.includes(`.tag.tw-t${i} {`), `缺 tw-t${i} 配色`);
assert.match(css, /\.tag\[class\*="tw-t"\]/, '配色选择器应限定 tw-t 标签');
ok('标签云配色复用头像哈希 + 三档权重，SSR 与前端同源');

console.log(`\nux L3: ${pass} passed`);
