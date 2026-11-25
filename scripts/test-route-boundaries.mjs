#!/usr/bin/env node
/**
 * 路由边界断言。
 *
 * 起因是看 Rin 的 server/src/core/route-boundaries.ts + route-boundaries.test.ts：
 * 它的边界测试（2689 B）比边界实现（2442 B）还大。也就是说，那边把「哪个路由
 * 归谁处理」当成一条必须被断言的契约，而不是靠目录摆放去暗示。
 *
 * 我站的分发器是 src/index.js 里的 route()：111 行、28 个分支的线性扫描。
 * 问题从来不是「文件大」，是这 111 行里一条约束都没有：
 *
 *   1. 谁都能插一条 if，没人要求登记它归哪个模块 —— 半年后归谁说不清
 *   2. 同一个 path 写两遍，前一条静默失效（早退型 if 的特性，不报错）
 *   3. 兜底分支（segs.length === 1）往上一挪，所有前缀路由全哑
 *   4. 分发器里能直接写 SQL —— 路由层和业务层就混了
 *
 * 四条都属于「改对了没感觉、改错了也不报错」，只能靠断言。
 *
 * 口径与 PITFALLS 对账一致：
 *   - 代码里有、表里没有 → 失败（新增路由必须登记）
 *   - 表里有、代码里没有 → 只警告（可能刚删代码，不算事故）
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { srcFiles } from './lib/src-walk.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'src', 'index.js');

let bad = 0;
let warn = 0;
const warnList = [];

function check(id, name, cond, detail = '') {
  if (!cond) bad++;
  console.log(`${cond ? 'pass' : 'FAIL'}  [${id}] ${name.padEnd(30)} ${detail}`);
}
function note(id, name, detail) {
  warn++;
  warnList.push(`[${id}] ${name} ${detail}`);
  console.log(`warn  [${id}] ${name.padEnd(30)} ${detail}`);
}

/* ---------- 路由归属表 ----------
 * 每条路由必须在这里登记它归哪个模块。新增路由不登记 → RB-01 红。
 * 「归谁」指实现文件，不是分发器所在文件。分发器里内联实现的，
 * 登记成 index.js 并在 note 里写清原因 —— 那本身就是要还的债。
 */
const OWNERS = {
  // 前缀路由
  '/api/': { file: 'api.js', kind: 'prefix' },
  '/img/': { file: 'index.js', kind: 'prefix', note: 'R2 代理，与 serveImage 同处' },
  '/tag/': { file: 'taxonomy.js', kind: 'prefix', note: '数据在 taxonomy，渲染内联在 route()' },
  '/cat/': { file: 'taxonomy.js', kind: 'prefix' },
  '/series/': { file: 'index.js', kind: 'prefix' },
  '/p/': { file: 'index.js', kind: 'prefix' },

  // 鉴权
  '/auth/github': { file: 'auth.js' },
  '/auth/callback': { file: 'auth.js' },
  '/auth/logout': { file: 'auth.js' },
  '/auth/status': { file: 'auth.js' },

  // 机器读的
  '/avatar': { file: 'index.js' },
  '/rss.xml': { file: 'index.js' },
  '/sitemap.xml': { file: 'index.js' },
  '/robots.txt': { file: 'index.js' },
  '/llms.txt': { file: 'index.js' },
  '/manifest.webmanifest': { file: 'index.js' },

  // 后台
  '/admin': { file: 'dashboard.js' },
  '/admin/review': { file: 'review.js' },
  '/admin/stats': { file: 'stats.js' },
  '/admin/health': { file: 'admin-pages.js' },
  '/admin/queue': { file: 'admin-pages.js' },
  '/admin/audit': { file: 'admin-pages.js' },
  '/admin/history': { file: 'admin-pages.js' },
  '/admin/friends': { file: 'admin-pages.js' },
  '/admin/comments': { file: 'admin-pages.js' },
  '/admin/notify': { file: 'admin-pages.js' },
  '/admin/tools': { file: 'admin-pages.js' },

  // 页面
  '/archive': { file: 'index.js' },
  '/numbers': { file: 'numbers.js', note: '数据在 numbers.js，渲染在 index.js' },
  '/categories': { file: 'taxonomy.js', note: '渲染内联在 route()，取静态骨架' },
  '/friends': { file: 'index.js' },
  '/friends/': { file: 'index.js' },
  '/series': { file: 'index.js' },
  '/series/': { file: 'index.js' },
};

const src = readFileSync(INDEX, 'utf8');
const lines = src.split('\n');

/* ---------- 切出 route() 函数体 ---------- */
const start = lines.findIndex((l) => l.startsWith('async function route('));
if (start < 0) {
  console.error('FAIL  找不到 async function route(  —— 分发器被改名了，先更新本脚本');
  process.exit(1);
}
let end = -1;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i] === '}') { end = i; break; }
}
const body = lines.slice(start, end + 1);

/* ---------- 提取路由 ---------- */
const found = []; // { pattern, kind, line }
body.forEach((ln, i) => {
  const lineNo = start + i + 1;
  // path === '/x'  或  path === '/x' || path === '/y'
  for (const m of ln.matchAll(/path\s*===\s*'([^']+)'/g)) {
    found.push({ pattern: m[1], kind: 'exact', line: lineNo });
  }
  // path.startsWith('/x')
  for (const m of ln.matchAll(/path\.startsWith\('([^']+)'\)/g)) {
    found.push({ pattern: m[1], kind: 'prefix', line: lineNo });
  }
});

const uniq = [...new Map(found.map((f) => [`${f.kind}:${f.pattern}`, f])).values()];

/* ---------- RB-01 每条路由都已登记 ---------- */
const unregistered = uniq.filter((f) => !OWNERS[f.pattern]);
check('RB-01', '路由已登记归属', unregistered.length === 0,
  unregistered.length
    ? `未登记 ${unregistered.length} 条：${unregistered.map((f) => `${f.pattern}(L${f.line})`).join(' ')}`
    : `${uniq.length} 条全部有归属`);

/* ---------- RB-02 登记的每条在代码里存在（orphan 只警告） ---------- */
const present = new Set(uniq.map((f) => f.pattern));
const orphans = Object.keys(OWNERS).filter((p) => !present.has(p));
if (orphans.length) {
  note('RB-02', '登记项在代码里存在', `orphan ${orphans.length} 条：${orphans.join(' ')}`);
} else {
  check('RB-02', '登记项在代码里存在', true, `${Object.keys(OWNERS).length} 条全命中`);
}

/* ---------- RB-03 owner 文件真实存在 ---------- */
/* 用递归枚举（P-032）：OWNERS 里登记的是裸文件名，src 平铺时等价，
   一旦拆成 features/ 就必须按 basename 认，否则整条断言会对所有归属报"文件不存在"，
   而更糟的写法是有人图省事把这条删掉。同名文件（两个 index.js）单独警告：
   那时 basename 已经不足以定位，登记项应改成相对路径。 */
const SRC_FILES = srcFiles(ROOT);
const byBase = new Map();
for (const rel of SRC_FILES) {
  const b = rel.split('/').pop();
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(rel);
}
const wanted = [...new Set(Object.values(OWNERS).map((v) => v.file))];
const missingFile = wanted.filter((f) => !byBase.has(f)).map((f) => `owner->${f}`);
const ambiguous = wanted
  .filter((f) => (byBase.get(f) || []).length > 1)
  .map((f) => `${f} 命中 ${byBase.get(f).join('|')}`);
check('RB-03', 'owner 模块文件存在', missingFile.length === 0,
  missingFile.length ? missingFile.join(' ') : `${wanted.length} 个模块`);
if (ambiguous.length) note('RB-03', 'owner 文件名唯一', ambiguous.join(' '));

/* ---------- RB-04 exact 路由不重复 ---------- */
const seen = new Map();
const dupes = [];
for (const f of found.filter((x) => x.kind === 'exact')) {
  if (seen.has(f.pattern)) dupes.push(`${f.pattern} L${seen.get(f.pattern)}/L${f.line}`);
  else seen.set(f.pattern, f.line);
}
check('RB-04', 'exact 路由无重复', dupes.length === 0,
  dupes.length ? dupes.join(' ') : `${seen.size} 条唯一`);

/* ---------- RB-05 兜底分支在所有前缀路由之后 ---------- */
// route() 的兜底是 segs.length === 1（单段路径当成 slug），一旦上移，
// 排在它后面的 /p/、/tag/ 之类永不可达。这是早退型分发器最容易踩的一脚。
const fallbackLine = body.findIndex((l) => l.includes('segs.length === 1'));
const lastPrefixLine = body.reduce((acc, l, i) => (l.includes("path.startsWith('") ? i : acc), -1);
check('RB-05', '兜底分支在前缀路由之后',
  fallbackLine > lastPrefixLine && fallbackLine !== -1,
  `兜底 L${fallbackLine >= 0 ? start + fallbackLine + 1 : '?'} / 最后前缀 L${lastPrefixLine >= 0 ? start + lastPrefixLine + 1 : '?'}`);

/* ---------- RB-06 分发器不碰数据层 ---------- */
// 路由层只该判断「谁处理」，不该自己写 SQL。route() 里一旦出现 DB.prepare，
// 「加功能 = 加一行注册」这条就不成立了 —— 你得同时读那段 SQL 才敢动。
const sqlHits = body
  .map((l, i) => ({ l, line: start + i + 1 }))
  .filter((x) => /env\.DB\.prepare\(/.test(x.l));
check('RB-06', '分发器不含 SQL', sqlHits.length === 0,
  sqlHits.length ? `命中 ${sqlHits.length} 处：L${sqlHits.map((x) => x.line).join(',L')}` : '路由层只分发');

/* ---------- RB-07 500 页与错误文本（[P-044] / [P-045]） ----------
   实测过一整圈：404 与 500 都是自定义页，不是 Workers 的英文白屏。
   真正的问题在最后一行兜底 —— 不带 Accept: text/html 的请求（curl、探针）
   拿到的是 `{"error":"D1_ERROR: no such table: posts"}`，SQL 和表名一起送出去。
   这条守两件事：500 页是静态字符串（不插值异常）；非 API 的 500 不回原文。 */
const idxAll = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const errPage = (idxAll.match(/export function serverErrorPage\([\s\S]*?\n\}/) || [])[0] || '';
check('RB-07', '500 页是静态字符串，不插值异常',
  !!errPage && !/\$\{/.test(errPage) && !/\be\.(message|stack)\b/.test(errPage),
  errPage ? (/\$\{/.test(errPage) ? '500 页里出现动态插值' : '纯静态') : '没有 serverErrorPage');
check('RB-07', '非 API 的 500 不回异常原文',
  /here\.startsWith\('\/api\/'\)/.test(idxAll) && /error: '服务器错误'/.test(idxAll),
  /here\.startsWith\('\/api\/'\)/.test(idxAll) ? '按路径分流' : '又变成一律回 e.message 了');

/* 上一版只守了「有一条分流」，没守「几处 catch 都走它」。
   实测：把异常扔在 handleFetch 开头（HEAD 预处理、URL 解析那一层），
   内层 catch 够不着，落到最外层那个裸 catch —— 它当时还是 `error: e.message`，
   于是同一个站两种 500，一种有防护一种把表名送出去。
   同一条规则写在两处只改一处，是 P-030 记过的老毛病，这条防它第三次。 */
const callSites = (idxAll.match(/(?:res = |return )fatalResponse\(request, e\)/g) || []).length;
check('RB-07', '两个 catch 共用同一个 500 出口（≥2 处调用）', callSites >= 2,
  callSites >= 2 ? `${callSites} 处调用` : `只有 ${callSites} 处调用，最外层 catch 可能又自己写了一份`);

// 兜底形状：catch 块里不许再出现裸的 e.message 回包。
// fatalResponse 本体当然要用它，所以只扫两个 catch 的内部。
const catches = idxAll.match(/catch \(e\) \{[\s\S]{0,600}?\n    \}/g) || [];
const leakers = catches.filter((c) => /error: e\.message/.test(c) && !/return fatalResponse/.test(c));
check('RB-07', 'catch 块里没有第二份 500 分支实现', leakers.length === 0,
  leakers.length ? `${leakers.length} 个 catch 又自己拼了 e.message` : `${catches.length} 个 catch 都走统一出口`);

/* ---------- 汇总 ---------- */
console.log('');
if (warnList.length) console.log(`${warn} 条警告（不失败）：\n  ${warnList.join('\n  ')}`);
console.log(bad === 0 ? `路由边界 ${uniq.length} 条，断言全通过。` : `${bad} 条断言失败。`);
process.exit(bad ? 1 : 0);
