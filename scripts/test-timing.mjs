#!/usr/bin/env node
/**
 * Server-Timing 分段计时（[P-049]）。
 *
 * 守四件事：
 *   1. timedDb 是单点包装 —— 不要求调用方改任何一处 D1 调用。
 *   2. batch() 收到的是**原始** statement，不是代理。D1 内部做类型检查，
 *      传代理进去会炸；这条不测就只会在第一次批量操作时才发现。
 *   3. bind() 之后仍然计时（代理会丢 bind 的返回类型，很容易漏）。
 *   4. withServerTiming 只碰 HTML / JSON，且不覆盖已有头（缓存副本）。
 *
 * 为什么值得有断言：这个头是用来"以后排查不用再 tail"的，它自己要是
 * 悄悄不打了，下次排查就会以为"这次没慢"，比没有更糟。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timedDb, withServerTiming } from '../src/timing.js';

let pass = 0;
let fail = 0;
/* 同步 runner 收到 async 函数的话，里面的 assert 会在一个没人 await 的
   Promise 里 reject —— 断言永远绿（P-029 记过这个坑，这里堵在 runner 层，
   下次谁写错立刻红，而不是等下一次注入验证才发现）。 */
const t = (name, fn) => {
  if (typeof fn === 'function' && fn.constructor.name === 'AsyncFunction') {
    fail++;
    console.log(`FAIL  ${name}\n      同步 runner 收到了 async 函数，断言根本没跑（改 ta）`);
    return;
  }
  try {
    fn();
    pass++;
    console.log(`pass  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
};
const ta = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`pass  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
};

/* 假 D1：记录自己收到了什么，用来验证解包 */
function fakeDb(log) {
  const mkStmt = (sql) => ({
    sql,
    bind(...a) {
      return mkStmt(sql + '|' + a.join(','));
    },
    async all() {
      await new Promise((r) => setTimeout(r, 2));
      return { results: [{ sql }] };
    },
    async first() {
      await new Promise((r) => setTimeout(r, 2));
      return { sql };
    },
    async run() {
      return { meta: { changes: 1 } };
    },
  });
  return {
    prepare: (sql) => mkStmt(sql),
    async batch(stmts) {
      log.push(stmts);
      /* 真实 D1 会对非 statement 对象抛错，这里复刻那个检查 */
      for (const s of stmts) {
        if (typeof s.sql !== 'string') throw new TypeError('D1_TYPE_ERROR: not a prepared statement');
      }
      return stmts.map(() => ({ success: true }));
    },
  };
}

await ta('T-01 prepare().all() 累计到 db 账本', async () => {
  const bag = { db: 0, queries: 0 };
  const db = timedDb(fakeDb([]), bag);
  await db.prepare('SELECT 1').all();
  /* 不断言具体毫秒：Windows 上 setTimeout(2) 实测过 1.51ms，精度不稳。>0 就够证明计上了 */
  assert.ok(bag.db > 0, `db 没计上，实际 ${bag.db}`);
  assert.equal(bag.queries, 1);
});

await ta('T-02 bind() 之后仍然计时（代理不丢 bind 返回值）', async () => {
  const bag = { db: 0, queries: 0 };
  const db = timedDb(fakeDb([]), bag);
  const r = await db.prepare('SELECT ?').bind('x').first();
  assert.equal(r.sql, 'SELECT ?|x');
  assert.ok(bag.db > 0);
  assert.equal(bag.queries, 1);
});

await ta('T-03 batch 收到原对象而不是代理（D1 类型检查会拒代理）', async () => {
  const seen = [];
  const bag = { db: 0, queries: 0 };
  const db = timedDb(fakeDb(seen), bag);
  const a = db.prepare('INSERT A');
  const b = db.prepare('INSERT B');
  await db.batch([a, b]);
  assert.equal(seen.length, 1, 'batch 没被调用');
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0].__raw, undefined, 'batch 里出现了代理对象，真实 D1 会抛 TypeError');
  assert.equal(seen[0][0].sql, 'INSERT A');
  assert.equal(bag.queries, 2, 'batch 应记两条查询');
});

await ta('T-04 二次包装不叠加（__timed 标记）', async () => {
  const bag = { db: 0, queries: 0 };
  const once = timedDb(fakeDb([]), bag);
  const twice = timedDb(once, bag);
  assert.equal(once, twice);
});

t('T-05 HTML 响应带上三段耗时（db 带查询条数）', () => {
  const res = new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const out = withServerTiming(res, 50, { db: 12.34, queries: 4 });
  const v = out.headers.get('server-timing');
  assert.match(v, /db;dur=12\.3;desc="4q"/);
  assert.match(v, /app;dur=37\.7/);
  assert.match(v, /total;dur=50/);
});

t('T-06 JSON 响应也带', () => {
  const res = new Response('{}', { headers: { 'content-type': 'application/json' } });
  assert.ok(withServerTiming(res, 10, { db: 1 }).headers.get('server-timing'));
});

t('T-07 CSS / 图片不带（白多几个字节）', () => {
  const css = new Response('a{}', { headers: { 'content-type': 'text/css' } });
  const png = new Response('x', { headers: { 'content-type': 'image/png' } });
  assert.equal(withServerTiming(css, 10, { db: 0 }).headers.get('server-timing'), null);
  assert.equal(withServerTiming(png, 10, { db: 0 }).headers.get('server-timing'), null);
});

t('T-08 已带头的响应不覆盖（缓存副本不能显示别人的耗时）', () => {
  const res = new Response('<html></html>', {
    headers: { 'content-type': 'text/html', 'server-timing': 'db;dur=99, app;dur=1, total;dur=100' },
  });
  assert.match(withServerTiming(res, 5, { db: 0 }).headers.get('server-timing'), /db;dur=99/);
});

t('T-09 304 无 body 不炸，且状态码保留', () => {
  const res = new Response(null, { status: 304, headers: { 'content-type': 'text/html' } });
  const out = withServerTiming(res, 8, { db: 0 });
  assert.equal(out.status, 304);
  assert.ok(out.headers.get('server-timing'));
});

t('T-10 app 不为负（db 大于总数时钳到 0）', () => {
  const res = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  const v = withServerTiming(res, 10, { db: 30 }).headers.get('server-timing');
  assert.match(v, /app;dur=0/);
});

t('T-11 元断言：fetch 里只包一次 timedEnv，且必须在 handleFetch 之前', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.equal((src.match(/timedDb\(env\.DB/g) || []).length, 1, 'timedDb 出现了不止一处');
  assert.equal((src.match(/withServerTiming\(res/g) || []).length, 1, 'withServerTiming 出现了不止一处');
  const iTimed = src.indexOf('const timedEnv');
  const iCall = src.indexOf('this.handleFetch(request, timedEnv');
  assert.ok(iTimed > 0 && iCall > iTimed, 'timedEnv 没传给 handleFetch');
});

/* 自检：同步 runner 必须拒收 async 函数。
   这一条存在的理由是本文件第一次写出来时 T-11 就是 async 却挂在 t() 上——
   注入「摘掉 timedDb」后它照样全绿，正是 P-029 那个坑。runner 自己不检，
   下一个写错的人还会以为断言在跑。 */
{
  const p0 = pass;
  const f0 = fail;
  const log = console.log;
  console.log = () => {};
  t('__probe_async', async () => {});
  console.log = log;
  const caught = fail === f0 + 1 && pass === p0;
  pass = p0;
  fail = f0;
  if (!caught) {
    fail++;
    console.log('FAIL  T-12 自检：同步 runner 没拦住 async 函数（断言会假绿）');
  } else {
    pass++;
    console.log('pass  T-12 自检：同步 runner 拒收 async 函数');
  }
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
