// P-008 的元断言：证明「这几条安全断言真的会失败」。
//
// 快照只证明「今天的输出等于昨天的输出」。它证明不了「如果转义被拆掉，
// 这里会红」——而这个才是 27 条探针存在的意义。没验证过会失败的断言等于没写。
//
// 做法：把 public/md.js 复制到临时文件，做单点变异，再跑同一批探针。
//   M1: esc 退化成恒等函数        → 裸标签应该原样进 HTML
//   M2: safeUrl 退化成直接返回    → javascript: 应该进 href
// 两个变异体都必须被检测器抓到，否则说明检测器本身失效了。
// 原版必须零违反，作为对照组。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderBody } from '../public/md.js';
import { probes } from './md-probes.mjs';
import { report } from './pitfall-check.mjs';

const SRC = new URL('../public/md.js', import.meta.url);
const source = readFileSync(SRC, 'utf8');

/* 与 test-md-snapshot.mjs 同一套检测器。故意复写而不是 import：
   那边是断言集合，这边要能独立运行；两份实现漂移时，本文件会先红。 */
function hasBareEventAttr(html) {
  let inTag = false;
  let quote = '';
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (!inTag) {
      if (c === '<' && /[a-z]/i.test(html[i + 1] || '')) inTag = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') { inTag = false; continue; }
    if (/[oO]/.test(c) && /\s/.test(html[i - 1] || '') && /^on[a-z]+\s*=/i.test(html.slice(i))) return true;
  }
  return false;
}

const unsafeOf = (out) =>
  hasBareEventAttr(out) ||
  /href="(?:javascript:|data:text\/html)/i.test(out) ||
  /<script\b/i.test(out);

function countUnsafe(render) {
  const hit = [];
  for (const [name, md] of probes) {
    let out;
    try {
      out = render(md);
    } catch {
      hit.push(`${name}(抛错)`);
      continue;
    }
    if (unsafeOf(out)) hit.push(name);
  }
  return hit;
}

/** 做单点变异 → 动态 import → 返回该变异体的 renderBody */
async function mutant(tag, from, to) {
  assert.ok(source.includes(from), `[P-008] 变异锚点失效（${tag}），md.js 结构变了要同步这里`);
  const code = source.replace(from, to);
  assert.notEqual(code, source, `[P-008] 变异没有改变源码（${tag}）`);
  const file = join(tmpdir(), `md-mutant-${tag}-${process.pid}.mjs`);
  writeFileSync(file, code);
  try {
    const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    return mod.renderBody;
  } finally {
    // Windows 上已加载的模块不影响删除；保险起见失败也不阻断测试
    try { unlinkSync(file); } catch {}
  }
}

/* ---------- 对照组：原版必须零违反 ---------- */
const baseHit = countUnsafe(renderBody);
assert.deepEqual(baseHit, [], `[P-008] 原版渲染器就违反了安全不变量：${baseHit.join(' / ')}`);

/* ---------- M1：转义退化成恒等 ---------- */
const m1 = await mutant(
  'esc',
  "export const esc = (s = '') => String(s).replace(/[&<>\"']/g, (c) => ESC[c]);",
  "export const esc = (s = '') => String(s);"
);
const m1Hit = countUnsafe(m1);
assert.ok(
  m1Hit.length >= 5,
  `[P-008] 把 esc 换成恒等函数后只有 ${m1Hit.length} 条探针变红，检测器覆盖不足`
);

/* ---------- M2：协议白名单退化成放行 ---------- */
const m2 = await mutant(
  'url',
  "return (kind === 'img' ? SAFE_IMG : SAFE_LINK).test(s) ? s : '#';",
  "return s;"
);
const m2Hit = countUnsafe(m2);
assert.ok(
  m2Hit.length >= 3,
  `[P-008] 拆掉协议白名单后只有 ${m2Hit.length} 条探针变红，检测器覆盖不足`
);

/* ---------- 顺序哨兵：先转义，后拼装 ----------
   上面两个变异证明「函数坏了会红」，这一段守的是顺序本身：
   md.js 的做法是先把整段 `s = esc(s)`，再把 ![..](..) / [..](..) 替换成标签。
   顺序反了（先拼装再转义）不会让函数失效，只会让「已经生成的属性边界」来不及
   被转义 —— 那正是历史上 <a> 插进 alt="..." 的形状。
   这一条是全文唯一的「顺序」断言，比任何一条输出比对都直接。 */
const escAt = source.indexOf('s = esc(s);');
const imgAt = source.indexOf("s.replace(IMG_RE");
const linkAt = source.indexOf("s.replace(LINK_RE");
assert.ok(escAt > 0, '[P-008] 没找到整段转义 `s = esc(s);`，md.js 结构变了要同步这里');
assert.ok(imgAt > 0 && linkAt > 0, '[P-008] 没找到图片/链接替换点');
assert.ok(
  escAt < imgAt && escAt < linkAt,
  '[P-008] 先转义后拼装的顺序被破坏：esc() 必须早于 IMG_RE / LINK_RE 替换'
);

const escCalls = (source.match(/\besc\(/g) || []).length;
assert.ok(escCalls >= 10, `[P-008] md.js 里 esc() 调用只剩 ${escCalls} 处，怀疑转义被摘掉`);
assert.ok(
  /<a href="\$\{safeUrl\(/.test(source),
  '[P-008] MD 链接不再经过 safeUrl 拼装，协议白名单等于被摘掉'
);
assert.ok(
  /let url = safeUrl\(src, 'img'\)/.test(source),
  '[P-008] 图片 src 不再经过 safeUrl 拼装'
);

report(
  'P-019',
  '变异测试：拆掉转义/白名单必须被探针抓到',
  true,
  `原版 0 违反；esc 失效红 ${m1Hit.length} 条；url 白名单失效红 ${m2Hit.length} 条；esc 调用 ${escCalls} 处`
);
