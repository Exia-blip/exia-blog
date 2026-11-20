// 第二档交互守门：复制本文链接 / 搜索快捷键+清除 / 图片灯箱 / 主题过渡。
// 这些纯前端交互没有 SSR 输出可断言，靠静态钩子锁定，防止改样式时误删接线。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const post = readFileSync('public/post.html', 'utf8');
const index = readFileSync('public/index.html', 'utf8');
const css = readFileSync('public/style.css', 'utf8');
const theme = readFileSync('public/theme.js', 'utf8');

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

// ---------- ⑥ 复制本文链接 ----------
assert.ok(post.includes("function bindCopyLink()"), '缺 bindCopyLink');
assert.ok(post.includes("bindCopyLink();"), 'hydrate 未接线');
assert.ok(/link\[rel="canonical"\]/.test(post), '没读 canonical —— 会复制错地址');
assert.ok(!/share|weibo|twitter|telegram/i.test(post.match(/bindCopyLink[\s\S]*?\n\}/)?.[0] || ''), '不应夹带社交分享');
ok('复制本文链接只读 canonical，无社交分享');

// ---------- ⑦ 图片灯箱 ----------
const lbFn = post.match(/function bindLightbox\(\)[\s\S]*?\n\}/)?.[0] || '';
assert.ok(lbFn, '缺 bindLightbox');
assert.ok(post.includes("bindLightbox();"), 'hydrate 未接线灯箱');
assert.match(lbFn, /\.md-img img/, '灯箱应只认独立成图的 .md-img');
assert.match(lbFn, /currentSrc \|\| img\.src/, '放大应复用已选中的 R2 图片 URL');
assert.ok(!/innerHTML\s*=/.test(post.match(/function ensureLb\(\)[\s\S]*?\n\}/)?.[0] || ''), '灯箱不该用 innerHTML 拼结构');
assert.ok(/createElement/.test(post.match(/function ensureLb\(\)[\s\S]*?\n\}/)?.[0] || ''), '灯箱应纯 DOM 创建');
assert.match(css, /\.lb\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*10000/, '缺灯箱遮罩样式');
assert.match(css, /touch-action:\s*pinch-zoom/, '灯箱未放行双指缩放');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.lb/, '灯箱未尊重 reduced-motion');
ok('灯箱 DOM 创建、只认 .md-img、双指缩放 + reduced-motion 就位');

// ---------- ⑧ 主题过渡 ----------
assert.ok(theme.includes('flashTransition()'), 'apply 未触发过渡');
assert.ok(/prefers-reduced-motion/.test(theme.match(/function flashTransition\(\)[\s\S]*?\n\}/)?.[0] || ''), 'flashTransition 应尊重 reduced-motion');
assert.match(css, /body\.theme-anim\s*,?[\s\S]{0,80}transition:\s*color[^;]*background-color/, '过渡只应碰 color/background-color');
assert.ok(!/\bbody\s*\{\s*transition:/.test(css), '不应再留常驻 body transition（首屏会闪）');
ok('主题过渡走临时 class，只过渡颜色，无常驻 transition');

// ---------- ⑨ 搜索快捷键 + 清除 ----------
assert.ok(index.includes('id="q-clear"'), '缺清除按钮');
assert.ok(index.includes('syncClear()'), '清除显隐未接线');
assert.match(index, /e\.key !== '\/'/, '缺 / 快捷键判据');
assert.match(index, /t\.isContentEditable/, '快捷键未排除可编辑区');
assert.match(index, /function applyQuery\(\)/, '清除后应复用查询逻辑');
assert.match(css, /\.search-clear\[hidden\]\s*\{\s*display:\s*none/, '清除按钮缺 hidden 样式');
ok('搜索 / 快捷键排除输入控件，清除按钮复用查询逻辑');

console.log(`\nux extras: ${pass} passed`);
