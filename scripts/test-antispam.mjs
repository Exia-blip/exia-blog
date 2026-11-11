// 评论限额判定回归。judge() 是纯函数，这里不碰 D1、不发请求。
// 用法：node scripts/test-antispam.mjs
import assert from 'node:assert/strict';
import { judge, dayKey, secsToNextDay, turnstileMode, MIN_GAP_SEC, DAY_MAX } from '../src/antispam.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const rec = (o = {}) => ({ banned: 0, day: '', hits: 0, last_ts: 0, ...o });
const at = (iso) => Math.floor(Date.parse(iso) / 1000);

t('没有记录就放行', () => {
  assert.equal(judge(null, 1000).ok, true);
});

t('拉黑的来源直接 403，不看额度', () => {
  const v = judge(rec({ banned: 1 }), 1000);
  assert.equal(v.ok, false);
  assert.equal(v.status, 403);
});

t('同一天打满额度就拦，retry 指向次日零点', () => {
  const now = at('2026-11-09T10:00:00Z'); // 北京 18:00
  const v = judge(rec({ day: dayKey(now), hits: DAY_MAX, last_ts: now - 999 }), now);
  assert.equal(v.ok, false);
  assert.equal(v.status, 429);
  assert.ok(v.retry > 0 && v.retry <= 86400);
});

t('跨天后额度归零：昨天打满不影响今天', () => {
  const now = at('2026-11-10T02:00:00Z'); // 北京 10:00
  const v = judge(rec({ day: dayKey(now - 86400), hits: DAY_MAX, last_ts: now - 999 }), now);
  assert.equal(v.ok, true);
});

t('间隔不足 60 秒拦住，retry 是差额', () => {
  const now = at('2026-11-09T10:00:00Z');
  const v = judge(rec({ day: dayKey(now), hits: 1, last_ts: now - 20 }), now);
  assert.equal(v.ok, false);
  assert.equal(v.retry, MIN_GAP_SEC - 20);
});

t('刚好满 60 秒放行', () => {
  const now = at('2026-11-09T10:00:00Z');
  assert.equal(judge(rec({ day: dayKey(now), hits: 1, last_ts: now - MIN_GAP_SEC }), now).ok, true);
});

t('设备那把钥匙只查日额度，不查间隔', () => {
  const now = at('2026-11-09T10:00:00Z');
  const r = rec({ day: dayKey(now), hits: 1, last_ts: now - 1 });
  assert.equal(judge(r, now).ok, false);
  assert.equal(judge(r, now, { checkGap: false }).ok, true);
});

t('日期按 UTC+8 切：UTC 16:00 就是北京的次日零点', () => {
  assert.equal(dayKey(at('2026-11-09T15:59:59Z')), '2026-11-09');
  assert.equal(dayKey(at('2026-11-09T16:00:00Z')), '2026-11-10');
});

t('secsToNextDay 在北京零点等于一整天', () => {
  assert.equal(secsToNextDay(at('2026-11-09T16:00:00Z')), 86400);
  assert.equal(secsToNextDay(at('2026-11-09T16:00:01Z')), 86399);
});

t('Turnstile 两把 key 都没配 → off，一个第三方请求都不发', () => {
  assert.equal(turnstileMode({}), 'off');
  assert.equal(turnstileMode(undefined), 'off');
});

t('两把 key 齐了才算 on', () => {
  assert.equal(turnstileMode({ TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET: 's' }), 'on');
});

t('只配 sitekey → site-only（服务端验不了，按失败处理）', () => {
  assert.equal(turnstileMode({ TURNSTILE_SITE_KEY: 'k' }), 'site-only');
});

t('只配 secret → secret-only（前端没组件，按未启用处理）', () => {
  assert.equal(turnstileMode({ TURNSTILE_SECRET: 's' }), 'secret-only');
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
