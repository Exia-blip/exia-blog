#!/usr/bin/env node
// P-002 ~ P-005 四条断言：扫 public 下的静态 HTML + src 下的源码。
// 无依赖；编号对应 PITFALLS.md，文档↔断言双向对账由 check-pitfalls.mjs 负责。
// 用法：
//   node scripts/check-pitfalls-002-005.mjs [HTML目录] [源码目录]
//   默认 HTML 目录 = <repo>/public，源码目录 = <repo>/src
// 边界（按约定，勿静默破坏）：
//   - P-004 / P-005 走 walk(srcDir, …)，只收 .js/.ts/.mjs；源码目录名不对时
//     walk 会空跑并让断言「静默判通过」。detail 会打印扫到的文件数，便于发现。
//   - P-003 口径是 m ? filled : true：找到目标容器才检查是否填充，找不到按通过计。
//   - P-002 的 aspect-ratio 兜底只认内联 style；class 方案不在本脚本范围，
//     需另在 CSS 侧补断言（与本站无关，站内无 class 方案）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from './pitfall-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const htmlDir = process.argv[2] ?? join(ROOT, 'public');
const srcDir = process.argv[3] ?? join(ROOT, 'src');

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

let bad = 0;
const check = (id, name, cond, detail = '') => {
  if (!report(id, name, cond, detail)) bad++;
};

// ---------- P-002 图片尺寸 ----------
const htmlFiles = walk(htmlDir, ['.html']);
const noDim = [];
for (const f of htmlFiles) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\bhidden\b/i.test(tag)) continue; // display:none 不参与布局，不产生 CLS
    const hasWH = /\bwidth\s*=/.test(tag) && /\bheight\s*=/.test(tag);
    const hasAr = /\bstyle\s*=\s*["'][^"']*\baspect-ratio\s*:/i.test(tag);
    if (!hasWH && !hasAr) noDim.push(`${f}: ${tag.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}
check('P-002', '图片均含尺寸或内联 aspect-ratio', noDim.length === 0,
  `扫 ${htmlFiles.length} 个 HTML；缺尺寸 ${noDim.length}${noDim.length ? ' → ' + noDim[0] : ''}`);

// ---------- P-003 首屏异步占位 ----------
const emptySlots = [];
let slots = 0;
for (const f of htmlFiles) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/<(nav|div|section)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if (!/\b(?:class|id)\s*=\s*["'][^"']*(?:skeleton|placeholder|loading|js-fill)/i.test(m[2])) continue;
    slots++;
    const inner = m[3].replace(/<!--[\s\S]*?-->/g, '');
    const filled = /\S/.test(inner) || /<(?:img|svg|span|a|ul|ol)\b/i.test(inner);
    if (!filled) emptySlots.push(f);
  }
}
check('P-003', '首屏异步占位容器均已填充', slots ? emptySlots.length === 0 : true,
  `命中占位容器 ${slots} 处，空 ${emptySlots.length} 处（0 处按宽松通过）`);

// ---------- P-004 / P-005 源码守门 ----------
const srcFiles = walk(srcDir, ['.js', '.ts', '.mjs']);
const blob = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const waitAt = blob.indexOf('Promise.all([siteP, catsP, tagsP])');
const listAt = blob.indexOf('const listP = listQuery(env, url)');
check('P-004', '首页三路查询并行 await', waitAt >= 0, `src 扫 ${srcFiles.length} 个文件；Promise.all=${waitAt}`);
check('P-004', '列表查询在等待前发车', listAt >= 0 && listAt < waitAt, `listP=${listAt} await=${waitAt}`);
check('P-004', 'COUNT 与列表同批发车',
  /const\s*\[\s*\{\s*results\s*\},\s*totalRow\s*\]\s*=\s*await\s*Promise\.all\(\[/.test(blob),
  'src/api.js 同批解构 results + totalRow');
check('P-005', '不可得字段显式 null 非 0',
  /subrequests\s*:\s*null/.test(blob) && /cpuMs\s*:\s*null/.test(blob),
  'src/observe.js subrequests/cpuMs 均为 null');
check('P-005', 'cron 单轮余量与逐跳上限',
  /PER_RUN\s*=\s*40/.test(blob) && /MAX_REDIRECTS\s*=\s*5/.test(blob),
  'src/cron.js PER_RUN=40 / MAX_REDIRECTS=5');

console.log(bad ? `\n✗ ${bad} 项 PITFALLS 断言失败` : '\n✓ P-002~P-005 断言全部通过');
process.exit(bad ? 1 : 0);
