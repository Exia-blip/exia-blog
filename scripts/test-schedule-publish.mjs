// 定时发布守门：服务端时间决策 + 编辑器接线 + 前端时区换算。
// 服务端用真实函数跑表，前端部分是静态钩子（纯 DOM 逻辑没有 SSR 输出可断言），
// 合起来守住「未来 published_at 走时间闸门」这条已经在用的上线链路。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishedOf, requestedAt } from '../src/api.js';

const NOW = '2026-11-21 15:00:00';
const src = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
const ed = readFileSync(new URL('../public/editor.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('requestedAt：三种返回值语义分明（空串/时刻/undefined）', () => {
  assert.equal(requestedAt(undefined, NOW), undefined);
  assert.equal(requestedAt(null, NOW), undefined);
  assert.equal(requestedAt('', NOW), '');
  assert.equal(requestedAt('bad', NOW), undefined);
  assert.equal(requestedAt('2026-12-25 01:00:00', NOW), '2026-12-25 01:00:00');
});

t('requestedAt：拒绝已过去 / 太近 / 超 366 天 / 非法日期', () => {
  for (const bad of ['2026-01-01 00:00:00', '2026-11-21 14:59:30', '2028-01-01 00:00:00', '2026-13-45 99:99:99', '2026-12-25T01:00:00']) {
    assert.equal(requestedAt(bad, NOW), undefined, `${bad} 应被拒`);
  }
  // 61 秒后放行（下限 60 秒），365 天后放行（上限 366 天）
  assert.equal(requestedAt('2026-11-21 15:01:01', NOW), '2026-11-21 15:01:01');
  assert.equal(requestedAt('2027-11-21 15:00:00', NOW), '2027-11-21 15:00:00');
});

t('publishedOf：已到点的文章锁定，改期和取消都不生效', () => {
  const pub = '2026-11-01 00:00:00';
  const req = requestedAt('2026-12-25 01:00:00', NOW);
  assert.equal(publishedOf(pub, false, NOW, req), pub);
  assert.equal(publishedOf(pub, false, NOW, ''), pub);
  assert.equal(publishedOf(pub, false, NOW, undefined), pub);
});

t('publishedOf：未到点的定时可改期、可取消', () => {
  const future = '2026-12-01 01:00:00';
  const req = requestedAt('2026-12-25 01:00:00', NOW);
  assert.equal(publishedOf(future, false, NOW, req), '2026-12-25 01:00:00');
  assert.equal(publishedOf(future, false, NOW, ''), NOW);           // 取消 → 立即发布
  assert.equal(publishedOf(future, false, NOW, undefined), future); // 没传 → 保持
});

t('publishedOf：新建草稿/立即发布/定时三条路', () => {
  assert.equal(publishedOf('', true, NOW, undefined), '');
  assert.equal(publishedOf('', false, NOW, undefined), NOW);
  assert.equal(publishedOf('', true, NOW, requestedAt('2026-12-25 01:00:00', NOW)), '2026-12-25 01:00:00');
});

t('publishedOf：非法定时不抹掉原有排期', () => {
  const future = '2026-12-01 01:00:00';
  assert.equal(publishedOf(future, false, NOW, requestedAt('2099-01-01 00:00:00', NOW)), future);
  assert.equal(publishedOf(future, false, NOW, requestedAt('garbage', NOW)), future);
});

t('写入路径：新建与更新都接了 requestedAt', () => {
  assert.equal((src.match(/publishedOf\([^\n]*requestedAt\(/g) || []).length, 2, 'INSERT 与 UPDATE 两处都要带定时参数');
  assert.ok(src.includes('export function requestedAt'));
  assert.ok(src.includes('export function publishedOf'));
});

t('编辑器：有 datetime-local 输入、就近报错槽与北京时间换算', () => {
  assert.ok(/<input[^>]*type="datetime-local"[^>]*id="publish-at"/.test(ed));
  assert.ok(ed.includes('id="publish-at-error"'));
  assert.ok(ed.includes('const BJ_MS = 8 * 3600 * 1000'));
  assert.ok(ed.includes('function utcToLocalInput'));
  assert.ok(ed.includes('function localInputToUtc'));
  assert.ok(ed.includes('function pubAtLocked'));
});

t('编辑器：定时值进快照、错误值拦保存、到点锁定不回传', () => {
  assert.ok(/publish_at: pubAt/.test(ed), '本地草稿要记住定时值');
  assert.ok(ed.includes('payload.publish_at = utc'), '有值时提交 UTC');
  assert.ok(ed.includes("payload.publish_at = ''"), '清空时显式取消排期');
  assert.ok(ed.includes('if (!pubAtLocked())'), '已上线不回传定时');
  assert.ok(ed.includes("showFieldError('publish-at', pubError)"), '非法值就近报错');
  assert.ok(ed.includes('setPubState(res.published_at)'), '保存后回显落库值');
});

t('样式：定时输入有样式且不污染读者侧', () => {
  assert.ok(css.includes('.pub-at {'));
  assert.ok(css.includes('.pub-at:disabled'));
});

let bad = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    bad++;
    console.log('  FAIL ' + name + ' — ' + e.message);
  }
}
console.log(`\nschedule publish: ${cases.length - bad}/${cases.length} passed\n`);
process.exit(bad ? 1 : 0);
