#!/usr/bin/env node
/**
 * 登录限流断言（P-033）。
 *
 * 为什么单独一个文件：登录是全站**唯一**「外部请求能触发对外请求」的入口。
 * `/auth/github` 把浏览器送去 GitHub 授权页，`/auth/callback` 往下是 1~3 次
 * 到 github.com 的 fetch。这两处此前一条限流都没有 —— 刷它们不花本站一分钱，
 * 花的是 GitHub 的额度，最后把真实用户挡在 GitHub 自己的滥用限流外面。
 *
 * 判据刻意不做「源码里出现 503 / X-Cache 这类字面匹配」：
 * 那是 P-030 抓过的同一种假绿。这里能测行为就测行为（假 D1 + 假 Request），
 * 只有跨函数顺序这种静态性质才退回源码切片。
 *
 * 用例一律走 cases 数组 + await（P-029）：`t()` 若是同步函数，async 用例的
 * rejection 会被吞掉，四条假 D1 断言会永远绿。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardLogin, recordLogin, judge, dayKey, LOGIN_DAY_MAX } from '../src/antispam.js';
import { srcEntries } from './lib/src-walk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const authSrc = fs.readFileSync(path.join(ROOT, 'src', 'auth.js'), 'utf8');

const cases = [];
const t = (id, name, fn) => cases.push({ id, name, fn });

/* 取出某个函数体：按 `function NAME(` 定位，截到下一条列 0 的 `}`。
   比全文 grep 强的地方是能区分「哪个函数里有」——两个入口挂了一个漏了另一个。 */
function bodyOf(name) {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(authSrc);
  assert.ok(m, `auth.js 里找不到函数 ${name}`);
  const end = authSrc.indexOf('\n}', m.index);
  assert.ok(end > m.index, `${name} 的函数体没找到结尾`);
  return authSrc.slice(m.index, end);
}

const nowSec = Math.floor(Date.now() / 1000);
const TODAY = dayKey(nowSec);

/** 假 D1：记下 bind 的参数，first() 返回给定行 */
function fakeDb(row) {
  const seen = [];
  return {
    seen,
    prepare(sql) {
      return {
        bind(...args) {
          seen.push({ sql, args });
          return this;
        },
        async first() {
          return row;
        },
        async run() {
          return { success: true };
        },
      };
    },
  };
}

const req = (headers = {}) => new Request('https://exia.de5.net/auth/callback', { headers });

/* ---------- LG-01 两个入口都挂了限流 ---------- */
t('LG-01', '登录两个入口（/auth/github 与回调）都接了 guardLogin + recordLogin', () => {
  for (const fn of ['loginRedirect', 'handleCallback']) {
    const body = bodyOf(fn);
    assert.match(body, /await guardLogin\(/, `${fn} 没接 guardLogin —— 这个入口没限流`);
    assert.match(body, /await recordLogin\(/, `${fn} 没接 recordLogin —— 额度永远不涨`);
    assert.match(body, /loginThrottled\(/, `${fn} 超额后没有统一的 429 出口`);
  }
});

/* ---------- LG-02 计数必须早于第一次出站请求 ---------- */
t('LG-02', '回调里 recordLogin 早于第一次 fetch（顺序哨兵）', () => {
  const body = bodyOf('handleCallback');
  const iRecord = body.indexOf('await recordLogin(');
  const iFetch = body.indexOf('await fetch(');
  assert.ok(iRecord > 0, 'handleCallback 里没有 recordLogin');
  assert.ok(iFetch > 0, 'handleCallback 里没有 fetch，判据失效');
  assert.ok(
    iRecord < iFetch,
    `recordLogin 在第一次 fetch 之后（${iRecord} > ${iFetch}）—— 无效 code 可以无限刷出站请求`
  );
});

/* ---------- LG-03 登录额度与评论额度分桶 ---------- */
t('LG-03', '登录 key 前缀是 auth:ip:，与评论的 ip: 分开', async () => {
  const db = fakeDb({ k: 'x', day: TODAY, hits: 0, last_ts: 0, banned: 0 });
  await guardLogin(db, req({ 'cf-connecting-ip': '203.0.113.9' }), nowSec);
  assert.equal(db.seen.length, 1, '没有查库');
  const key = db.seen[0].args[0];
  assert.match(key, /^auth:ip:/, `登录 key 是 ${key}，与评论共用桶会互相吃掉额度`);
  assert.notEqual(key, 'ip:203.0.113.9', '登录 key 与评论 key 相同');
});

/* ---------- LG-04 x-forwarded-for 全站清零 ---------- */
t('LG-04', '全站不许真正去读 x-forwarded-for（注释里说明它为什么不安全不算）', () => {
  /* 判据只认「读这个头」的三种写法：`.get('x-forwarded-for')`、
     `['x-forwarded-for']`、`headers.get("X-Forwarded-For")`。
     不认裸词 —— 上一版写了裸词匹配，结果把两处解释「为什么不回退它」的注释
     判成违规。那是 P-030 的另一种形态：认字面不认语义。 */
  const READ = [
    /headers\s*\.\s*get\(\s*['"`]x-forwarded-for['"`]\s*\)/i,
    /headers\s*\[\s*['"`]x-forwarded-for['"`]\s*\]/i,
  ];
  const hits = [];
  for (const { rel, text } of srcEntries(ROOT)) {
    text.split('\n').forEach((line, i) => {
      if (READ.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, [], `这些地方还在读 x-forwarded-for：\n${hits.join('\n')}`);
});

/* ---------- LG-05 伪造 XFF 改不了桶 ---------- */
t('LG-05', '带上伪造的 x-forwarded-for，桶仍然由 cf-connecting-ip 决定', async () => {
  const db = fakeDb({ k: 'x', day: TODAY, hits: 0, last_ts: 0, banned: 0 });
  await guardLogin(db, req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), nowSec);
  assert.equal(db.seen[0].args[0], 'auth:ip:198.51.100.7', 'XFF 混进了 key');

  const db2 = fakeDb({ k: 'x', day: TODAY, hits: 0, last_ts: 0, banned: 0 });
  await guardLogin(db2, req({ 'x-forwarded-for': '1.1.1.1' }), nowSec);
  assert.equal(db2.seen[0].args[0], 'auth:ip:unknown', '没有 cf-connecting-ip 时应落 unknown 桶，不回退请求头');
});

/* ---------- LG-06 日上限行为 ---------- */
t('LG-06', `日上限 ${LOGIN_DAY_MAX} 次：到顶拒、差一次放`, () => {
  const at = judge({ day: TODAY, hits: LOGIN_DAY_MAX, last_ts: 0, banned: 0 }, nowSec, {
    dayMax: LOGIN_DAY_MAX,
    checkGap: false,
  });
  assert.equal(at.ok, false, '到顶了还放行');
  assert.equal(at.status, 429);

  const under = judge({ day: TODAY, hits: LOGIN_DAY_MAX - 1, last_ts: 0, banned: 0 }, nowSec, {
    dayMax: LOGIN_DAY_MAX,
    checkGap: false,
  });
  assert.equal(under.ok, true, '差一次就拒了，阈值算错');
});

/* ---------- LG-07 跨天重置 ---------- */
t('LG-07', '换天（UTC+8）后额度归零', () => {
  const yesterday = dayKey(nowSec - 86400);
  const v = judge({ day: yesterday, hits: 999, last_ts: 0, banned: 0 }, nowSec, {
    dayMax: LOGIN_DAY_MAX,
    checkGap: false,
  });
  assert.equal(v.ok, true, '昨天的额度被算到今天了');
});

/* ---------- LG-08 recordLogin 是 upsert，不是 check-then-act ---------- */
t('LG-08', 'recordLogin 用 ON CONFLICT 原子累加', async () => {
  const db = fakeDb(null);
  await recordLogin(db, '203.0.113.9', nowSec);
  const sql = db.seen[0].sql;
  assert.match(sql, /ON CONFLICT\s*\(\s*k\s*\)\s*DO UPDATE/i, 'recordLogin 不是原子 upsert');
  assert.match(sql, /hits\s*=\s*CASE WHEN/i, '跨天时没有重置 hits');
});

/* ---------- LG-09 封禁生效 ---------- */
t('LG-09', '被封的 IP 走登录限流同样被拒（banned=1）', async () => {
  const db = fakeDb({ k: 'auth:ip:203.0.113.9', day: TODAY, hits: 0, last_ts: 0, banned: 1 });
  const v = await guardLogin(db, req({ 'cf-connecting-ip': '203.0.113.9' }), nowSec);
  assert.equal(v.ok, false, 'banned=1 仍然放行');
  assert.equal(v.status, 403);
});

/* ---------- LG-10 限流出口带 retry-after ---------- */
t('LG-10', '429 出口同时给出 retry-after 头', () => {
  const body = bodyOf('loginThrottled');
  assert.match(body, /429/, 'loginThrottled 没返回 429');
  assert.match(body, /retry-after/i, 'loginThrottled 没带 retry-after');
});

/* ---------- 跑 ---------- */
let pass = 0;
const bad = [];
for (const c of cases) {
  try {
    await c.fn();
    pass++;
    console.log(`  ok  [${c.id}] ${c.name}`);
  } catch (e) {
    bad.push(c.id);
    console.error(`  FAIL [${c.id}] ${c.name}\n        ${e.message}`);
  }
}
console.log('');
if (bad.length) {
  console.error(`[P-033] 登录限流 ${pass}/${cases.length} passed，失败：${bad.join(' ')}`);
  process.exit(1);
}
console.log(`[P-033] 登录限流 ${pass}/${cases.length} passed`);
process.exit(0);
