// 评论限额判定回归。judge() 是纯函数，这里不碰 D1、不发请求。
// 用法：node scripts/test-antispam.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

/* ---------- [P-022] 限流的判定不是原子的（已知边界，未修） ----------
   现状：guard() 先 SELECT 读两把钥匙 → judge() 判定 → 业务写入 → record() 才累加。
   累加本身是原子的（INSERT ... ON CONFLICT DO UPDATE），但「检查」与「累加」之间
   有一个窗口：N 个并发请求可以同时读到 hits=0，全部通过判定，然后各自累加。
   日上限 10 在理论上能被打成 10N。

   为什么不改：改成「先原子占位、再写评论」会让被 400 拒掉的请求也计额度
   （真人填错邮箱被拒就少一次机会），而现在的语义是「落库成功才计数」。
   两种语义都要原子，就得加事务或补偿删除，复杂度换来的是博客评论场景下
   一个需要 Turnstile 关闭 + 并发 10 以上才成立的窗口。

   这一段测的是「现状就是 check-then-act」—— 不是「这样是对的」。
   哪天有人把它改成单语句原子占位，这里会红，那时应当同步更新 PITFALLS 的措辞。 */
const antispamSrc = readFileSync(new URL('../src/antispam.js', import.meta.url), 'utf8');

t('[P-022] guard 只读不写、record 才累加（check-then-act 现状）', () => {
  const guardBody = antispamSrc.slice(antispamSrc.indexOf('export async function guard'), antispamSrc.indexOf('export async function record'));
  assert.ok(/SELECT k, day, hits, last_ts, banned FROM comment_guard/.test(guardBody), 'guard 不再读计数表，结构变了要同步 P-022');
  assert.ok(!/INSERT|UPDATE/.test(guardBody), 'guard 开始写库了 —— 可能已经改成原子占位，请更新 P-022 的措辞与文章');
  assert.ok(/ON CONFLICT\(k\) DO UPDATE SET[\s\S]{0,200}comment_guard\.hits \+ 1/.test(antispamSrc), 'record 不再是原子递增');
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
