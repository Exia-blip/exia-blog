#!/usr/bin/env node
// 构建后运行：node scripts/check-contrast.mjs [CSS目录 ...]
// 无依赖。默认扫 public + public/theme（本站 CSS 的实际分布）；传参则只扫指定目录。
//
// 与 scripts/test-contrast.mjs 共用本文件的实现，避免两套 PAIRS 漂移。
// 本站有 6 套主题 × 明暗 = 14 组变量，不能把 CSS 里所有 --xxx 塞进一个全局表
// （后者覆盖前者 → 只测到最后一套主题，是假断言）。所以按选择器块分主题解析。
//
// 阈值：正文 4.5:1，大字 3:1。本站 --muted 用在 11.5~14.5px 的日期/标签/面包屑，
// 属正文级，一律按 4.5 守。不列 --fg on --accent：全站无 background:var(--accent)，
// 该组合不存在；做全排列只会产出无人维护的告警。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIN = 4.5;
const MIN_LARGE = 3;

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

// 解析 #hex / rgb() / hsl() —— 覆盖本站实际写法，外加 rgb/hsl 便于复用
function parse(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const h = m[1];
    const n = h.length <= 4 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  }
  if ((m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i))) {
    return [1, 2, 3].map((i) => +m[i]);
  }
  if ((m = s.match(/^hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i))) {
    const h = +m[1], sv = +m[2] / 100, l = +m[3] / 100;
    const a = sv * Math.min(l, 1 - l);
    const k = (n) => (n + h / 30) % 12;
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }
  return null;
}

// 解析变量值：light-dark(亮,暗) 按模式取分支；var(--x, fallback) 递归；color-mix 等无法解析的跳过
function resolve(value, mode, vars, seen = new Set()) {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (seen.has(v)) return null;
  seen.add(v);
  const ld = v.match(/^light-dark\(\s*([^,)]+)\s*,\s*([^)]+)\)$/i);
  if (ld) v = (mode === 'dark' ? ld[2] : ld[1]).trim();
  const ref = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (ref) return resolve(vars[ref[1]] ?? ref[2]?.trim(), mode, vars, seen);
  if (/color-mix|currentColor|transparent/i.test(v)) return null;
  return parse(v);
}

// 只取 :root 与 :root[data-theme=...] 的变量块；@media 里的系统兜底不重复计
// （本站同时有 :root[data-mode="dark"]，无 JS 兜底与之同值）
function blocks(text) {
  const out = [];
  for (const m of text.matchAll(/([^{}]*\{[^{}]*\})/g)) {
    const sel = m[1].slice(0, m[1].indexOf('{'))
      .replace(/\/\*[\s\S]*?\*\//g, '').trim().split('\n').pop().trim();
    if (!sel.startsWith(':root')) continue;
    if (/\.tag|body|pre\b|#|\[class/.test(sel)) continue;
    const vars = {};
    for (const v of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    if (Object.keys(vars).length) out.push({ sel, vars });
  }
  return out;
}

function readCss(dirs) {
  const out = [];
  for (const dir of dirs) {
    const abs = dir.startsWith('/') ? dir : join(ROOT, dir);
    for (const f of readdirSync(abs).filter((n) => n.endsWith('.css')).sort()) {
      out.push({ file: join(dir, f), text: readFileSync(join(abs, f), 'utf8') });
    }
  }
  if (!out.length) throw new Error(`没有找到 CSS 文件：${dirs.join(', ')}`);
  return out;
}

// [前景, 背景, 用途, 最小比值] —— 只列真实存在的角色对，不做全排列
const PAIRS = [
  ['--fg', '--bg', '正文', MIN],
  ['--fg-soft', '--bg', '次要正文', MIN],
  ['--muted', '--bg', '日期/标签/面包屑', MIN],
  ['--fg', '--bg-soft', '卡片正文', MIN],
  ['--muted', '--bg-soft', '卡片内次要文字', MIN],
  ['--fg', '--card', '卡片标题', MIN],
  ['--muted', '--card', '卡片内元信息', MIN],
  ['--accent', '--bg', '强调色/当前导航', MIN],
  ['--accent', '--bg-soft', '标签 hover', MIN],
];

export function checkContrast({ dirs = ['public', 'public/theme'], verbose = false, log = console.log } = {}) {
  const all = readCss(dirs).flatMap((f) => blocks(f.text).map((b) => ({ ...b, file: f.file })));
  const base = all.find((b) => b.sel === ':root')?.vars;
  const baseDark = all.find((b) => b.sel === ':root[data-mode="dark"]')?.vars;
  if (!base || !baseDark) throw new Error('CSS 缺 :root 或 :root[data-mode="dark"] 基块');

  const themes = [...new Set(all.map((b) => (b.sel.match(/data-theme="([^"]+)"/) || [])[1]).filter(Boolean))].sort();
  const combos = [
    ['page(默认)', 'light'], ['page(默认)', 'dark'],
    ...themes.flatMap((t) => [[t, 'light'], [t, 'dark']]),
  ];

  log('[对比度] WCAG AA：正文 ≥4.5:1，大字 ≥3:1（只测真实存在的 fg/bg 角色对）');
  let pass = 0, fail = 0;
  for (const [theme, mode] of combos) {
    const vars = { ...base, ...(mode === 'dark' ? baseDark : {}) };
    if (theme !== 'page(默认)') {
      const light = all.find((b) => b.sel === `:root[data-theme="${theme}"]`);
      const dark = all.find((b) => b.sel === `:root[data-theme="${theme}"][data-mode="dark"]`);
      if (light) Object.assign(vars, light.vars);
      if (mode === 'dark' && dark) Object.assign(vars, dark.vars);
    }
    const bad = [];
    for (const [fg, bg, label, min] of PAIRS) {
      const f = resolve(vars[fg], mode, vars), b = resolve(vars[bg], mode, vars);
      if (!f || !b) { bad.push(`${label}: ${fg}/${bg} 无法解析`); continue; }
      const r = ratio(f, b);
      if (r < min) bad.push(`${label}: ${fg} on ${bg} = ${r.toFixed(2)} (需 ${min})`);
      else if (verbose) log(`  pass ${`${theme}·${mode}`.padEnd(22)} ${label.padEnd(18)} ${r.toFixed(2)}`);
    }
    const name = `${theme}·${mode}`;
    if (bad.length) { fail++; log(`  FAIL ${name.padEnd(22)} ${bad.join('  ')}`); }
    else { pass++; if (!verbose) log(`  ok   ${name}`); }
  }
  log(`\n[P-015] ${pass} 组通过 / ${fail} 组踩线`);
  log(fail ? '✗ 对比度不达标' : '✓ 对比度全部达标');
  return { pass, fail, total: combos.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dirs = process.argv.slice(2).filter((a) => a !== '--verbose');
  const verbose = process.argv.includes('--verbose');
  try {
    process.exit(checkContrast({ dirs: dirs.length ? dirs : undefined, verbose }).fail ? 1 : 0);
  } catch (err) {
    console.error(`✗ 对比度检查无法运行：${err.message}`);
    process.exit(1);
  }
}
