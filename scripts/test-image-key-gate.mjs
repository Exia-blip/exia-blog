// /img/ 代理的私有前缀闸门：备份 SQL 与公开图片同桶，必须挡住 backups/*。
// 绕过写法逐个穷举——大小写、编码、反斜杠、双斜杠、路径中插段。
import assert from 'node:assert/strict';
import { isPrivateImageKey } from '../src/index.js';

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}: ${e.message}`); }
};
console.log('[图片 key 私有前缀闸门]');

t('backups 及子路径一律拒绝', () => {
  for (const k of ['backups', 'backups/', 'backups/d1.sql', 'backups/2026/d1.sql']) {
    assert.equal(isPrivateImageKey(k), true, k);
  }
});

t('大小写/编码/反斜杠/双斜杠绕过无效', () => {
  for (const k of ['BACKUPS/d1.sql', '%62ackups/d1.sql', 'backups%2fd1.sql', 'backups\\d1.sql', '//backups//d1.sql', 'backups/../backups/d1.sql']) {
    assert.equal(isPrivateImageKey(k), true, k);
  }
});

t('路径中插段也拒绝', () => {
  assert.equal(isPrivateImageKey('cards/x/backups/d1.sql'), true);
});

t('正常图片 key 不受影响', () => {
  for (const k of ['a.png', 'cards/x.png', 'avatar/u123-128', 'img/backups2.png', 'backups-x.png']) {
    assert.equal(isPrivateImageKey(k), false, k);
  }
});

console.log(`\n${pass} passed, ${fails.length} failed  （image key gate）`);
if (fails.length) process.exit(1);
