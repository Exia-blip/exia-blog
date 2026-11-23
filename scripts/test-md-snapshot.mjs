// 27 条 XSS 探针的快照回归：probe-md.mjs 只打印，这里把输出钉死成断言。
// 用法：
//   node scripts/test-md-snapshot.mjs            校验
//   node scripts/test-md-snapshot.mjs --write    重生成基线（只在确认输出确实该变时跑）
//
// 两层保险：① 每条输出与快照逐字符一致（改渲染器忘了测就红）；
//           ② 通用安全不变量（就算有人顺手改了快照，裸事件属性/危险协议仍会红）。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBody } from '../public/md.js';
import { probes } from './md-probes.mjs';
import { report } from './pitfall-check.mjs';

const SNAP = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'md-snapshots.json');
const WRITE = process.argv.includes('--write');
const actual = Object.fromEntries(probes.map(([name, md]) => [name, renderBody(md)]));

if (WRITE) {
  mkdirSync(dirname(SNAP), { recursive: true });
  writeFileSync(SNAP, JSON.stringify(actual, null, 2) + '\n');
  console.log(`已写入 ${probes.length} 条快照：${SNAP}`);
  process.exit(0);
}

assert.ok(existsSync(SNAP), `缺快照，先跑 node scripts/test-md-snapshot.mjs --write`);
const expected = JSON.parse(readFileSync(SNAP, 'utf8'));
assert.equal(probes.length, 27, '探针集合应为 27 条');
assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), '探针名字变了，快照需重签');

/* 只认「真属性」：必须位于标签内部、且不在裸引号包裹的属性值里。
   alt="&quot; onmouseover=&quot;alert(1)" 里的 onmouseover 是文字不是属性 ——
   手搓正则扫 on\w+= 会把这种安全输出误报成漏洞（md.js 已有专门的转义测试）。 */
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

let pass = 0;
for (const [name, out] of Object.entries(actual)) {
  assert.equal(out, expected[name], `[P-008] ${name}：渲染输出相对快照漂移`);
  assert.ok(!hasBareEventAttr(out), `[P-008] ${name}：输出里出现真·事件属性`);
  assert.ok(!/href="(?:javascript:|data:text\/html)/i.test(out), `[P-008] ${name}：输出里出现危险 href`);
  assert.ok(!/<script\b/i.test(out), `[P-008] ${name}：输出里出现裸 <script>`);
  pass++;
}
report('P-008', 'XSS 探针快照与安全不变量', pass === probes.length, `${pass}/${probes.length} 条一致`);
