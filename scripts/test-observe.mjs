// 结构化日志守门：字段真实可得、阈值可判、告警不误报。
// 特别守住「cpuMs / subrequests 不可得就写 null」这条 —— 运行时没有 per-request API，
// 写 0 会让人以为真的没消耗，写编造值更糟。
import assert from 'node:assert/strict';
import { BUDGETS, requestLog, alertsOf, cacheStatusOf } from '../src/observe.js';

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}: ${e.message}`); }
};
console.log('[结构化日志]');

const req = (path = '/p/foo', headers = {}) => new Request(`https://exia.de5.net${path}`, { headers });
const res = (status = 200, headers = {}) => new Response('', { status, headers });

t('日志字段含路径/状态/墙钟/缓存状态', () => {
  const log = requestLog({ request: req('/p/a'), response: res(200, { 'cf-cache-status': 'HIT' }), durationMs: 123.6 });
  assert.equal(log.p, '/p/a');
  assert.equal(log.s, 200);
  assert.equal(log.dms, 124);
  assert.equal(log.cache, 'HIT');
});

t('query 不进日志（避免把搜索词/token 写进日志）', () => {
  const log = requestLog({ request: req('/?q=secret&token=abc'), response: res(), durationMs: 10 });
  assert.equal(log.p, '/');
  assert.ok(!JSON.stringify(log).includes('secret'));
  assert.ok(!JSON.stringify(log).includes('abc'));
});

t('不可得字段显式 null，不是 0', () => {
  const log = requestLog({ request: req(), response: res(), durationMs: 10 });
  assert.strictEqual(log.cpuMs, null);
  assert.strictEqual(log.subrequests, null);
});

t('缓存状态优先 cf-cache-status，其次自身标记，最后 -', () => {
  assert.equal(cacheStatusOf(new Headers({ 'cf-cache-status': 'HIT', 'x-edge-cache': 'MISS' })), 'HIT');
  assert.equal(cacheStatusOf(new Headers({ 'x-edge-cache': 'MISS' })), 'MISS');
  assert.equal(cacheStatusOf(new Headers()), '-');
});

t('300ms 以上告警，以下不报', () => {
  assert.equal(alertsOf({ dms: BUDGETS.warnDurationMs }).length, 0);
  assert.equal(alertsOf({ dms: BUDGETS.warnDurationMs + 1 }).length, 1);
});

t('1000ms 以上升级为 critical 且只报一条', () => {
  const a = alertsOf({ dms: BUDGETS.criticalDurationMs + 1 });
  assert.equal(a.length, 1);
  assert.ok(a[0].startsWith('duration_p95_bound'));
});

t('无 request.cf 时 ray/country 用 - 兜底', () => {
  const log = requestLog({ request: req(), response: res(), durationMs: 5 });
  assert.equal(log.ray, '-');
  assert.equal(log.country, '-');
});

console.log(`\n${pass} passed, ${fails.length} failed  （observability）`);
if (fails.length) process.exit(1);
