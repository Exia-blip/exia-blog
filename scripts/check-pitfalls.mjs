#!/usr/bin/env node
// 文档 ↔ 断言双向对账：脚本里出现的编号必须在 PITFALLS.md 有条目（否则 fail）；
// 文档里有、脚本没引用的编号只警告 —— 那是「已知但未自动化」，不该卡住 CI。
// 顺带校验每条的五个字段齐全且顺序正确。无依赖。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from './pitfall-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(join(ROOT, 'PITFALLS.md'), 'utf8');
const documented = new Set([...doc.matchAll(/^## (P-\d{3})\b/gm)].map((m) => m[1]));
const scripted = new Set(
  readdirSync(join(ROOT, 'scripts'))
    .filter((f) => /\.(?:mjs|js)$/.test(f))
    .flatMap((f) => {
      const s = readFileSync(join(ROOT, 'scripts', f), 'utf8');
      return [...s.matchAll(/\b(P-\d{3})\b/g)].map((m) => m[1]);
    })
);

const missing = [...scripted].filter((x) => !documented.has(x));
const orphan = [...documented].filter((x) => !scripted.has(x));

// 五字段按序：现象 / 根因 / 复现 / 断言 / 出处
const FIELDS = ['现象', '根因', '复现', '断言', '出处'];
const parts = doc.split(/^## (P-\d{3})\b/m);
const malformed = [];
for (let i = 1; i < parts.length; i += 2) {
  const id = parts[i];
  const body = parts[i + 1] || '';
  const at = FIELDS.map((f) => body.indexOf(`- **${f}**：`));
  if (at.some((p) => p < 0) || at.some((p, j) => j > 0 && p <= at[j - 1])) malformed.push(id);
}

console.log('[PITFALLS 双向对账]');
let bad = 0;
if (!report('', '每条五字段齐全且顺序正确', malformed.length === 0,
  malformed.length ? `字段异常：${malformed.join(', ')}` : `${documented.size} 条`)) bad++;
if (!report('', '脚本里的编号都有文档条目', missing.length === 0,
  missing.length ? `缺文档：${missing.join(', ')}` : `${scripted.size} 个编号已登记`)) bad++;
if (orphan.length) {
  console.log(`WARN  文档有条目但脚本未引用（已知未自动化）：${orphan.join(', ')}`);
} else {
  console.log('pass  文档条目全部被脚本引用');
}

console.log(bad ? `\n✗ ${bad} 项对账失败` : '\n✓ 对账通过');
process.exit(bad ? 1 : 0);
