// a11y 对比度守门：解析 style.css 与 5 套主题的变量块，组出 7 套主题 × 明暗 14 种组合，
// 对每组的 fg / fg-soft / muted / accent 与 bg / bg-soft / card 做 WCAG 对比度断言。
//
// 阈值：正文 4.5:1，大字 3:1。本站 muted 大量用在 11.5~14.5px 的日期、标签、面包屑，
// 属正文级，一律按 4.5 守；accent 用在导航当前项（16.5px）也按 4.5。
// 这条断言存在的理由：黑白灰主题最容易在「次要文字」上悄悄掉到 4.2 左右，肉眼几乎看不出。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const themeDir = `${ROOT}/public/theme`;
const files = ['public/style.css', ...fs.readdirSync(themeDir).filter((f) => f.endsWith('.css')).map((f) => `public/theme/${f}`)];

function blocks(text) {
  const out = [];
  const re = /([^{}]*\{[^{}]*\})/g;
  for (const m of text.matchAll(re)) {
    const sel = m[1].slice(0, m[1].indexOf('{')).replace(/\/\*[\s\S]*?\*\//g, '').trim().split('\n').pop().trim();
    if (!sel.startsWith(':root') && !sel.includes('prefers-color-scheme')) continue;
    const vars = {};
    for (const v of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    if (Object.keys(vars).length) out.push({ sel, vars });
  }
  return out;
}
const all = files.flatMap((f) => blocks(fs.readFileSync(`${ROOT}/${f}`, 'utf8')).map((b) => ({ ...b, file: f })));

function lum(hex) {
  const h = hex.replace('#', '');
  if (!/^[\da-f]{3}$|^[\da-f]{6}$/i.test(h)) return null;
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const la = lum(a), lb = lum(b);
  if (la === null || lb === null) return null;
  const [x, y] = [la, lb].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const base = all.find((b) => b.sel === ':root')?.vars;
const baseDark = all.find((b) => b.sel === ':root[data-mode="dark"]')?.vars;
if (!base || !baseDark) throw new Error('style.css 缺 :root 或 :root[data-mode="dark"] 基块');
const themes = [...new Set(all.map((b) => (b.sel.match(/data-theme="([^"]+)"/) || [])[1]).filter(Boolean))].sort();

// [前景变量, 背景变量, 是否大字]
const PAIRS = [
  ['--fg', '--bg', 0], ['--fg-soft', '--bg', 0], ['--muted', '--bg', 0],
  ['--fg', '--bg-soft', 0], ['--muted', '--bg-soft', 0],
  ['--fg', '--card', 0], ['--muted', '--card', 0],
  ['--accent', '--bg', 0], ['--accent', '--bg-soft', 0],
];

let fail = 0, pass = 0;
console.log('[对比度] WCAG AA：正文 ≥4.5:1，大字 ≥3:1');
for (const [theme, mode] of [
  ['page(默认)', 'light'], ['page(默认)', 'dark'],
  ...themes.flatMap((t) => [[t, 'light'], [t, 'dark']]),
]) {
  const vars = { ...base, ...(mode === 'dark' ? baseDark : {}) };
  if (theme !== 'page(默认)') {
    const light = all.find((b) => b.sel === `:root[data-theme="${theme}"]`);
    const dark = all.find((b) => b.sel === `:root[data-theme="${theme}"][data-mode="dark"]`);
    if (light) Object.assign(vars, light.vars);
    if (mode === 'dark' && dark) Object.assign(vars, dark.vars);
  }
  const bad = [];
  for (const [fg, bg, large] of PAIRS) {
    const r = ratio(vars[fg], vars[bg]);
    const min = large ? 3 : 4.5;
    if (r === null) { bad.push(`${fg}/${bg} 颜色无法解析`); continue; }
    if (r < min) bad.push(`${fg.replace('--', '')}/${bg.replace('--', '')} ${r.toFixed(2)} < ${min}`);
  }
  const label = `${theme}·${mode}`;
  if (bad.length) { fail++; console.log(`  FAIL ${label.padEnd(20)} ${bad.join('  ')}`); }
  else { pass++; console.log(`  ok   ${label}`); }
}
console.log(`\n${pass} 组通过 / ${fail} 组踩线`);
if (fail) process.exit(1);
