// 补发通知端点（POST /api/comments/notify）的边界与语义。
// 用法：node scripts/test-notify-resend.mjs
//
// 这条路径危险在「它是一条随手可执行的写」：重投一次就在群里多一条消息，
// 而且没有幂等键可以回滚。所以断言的重点不是「能发出去」，是
//   ① 谁能发（管理员，匿名与非管理员都不行）
//   ② 什么不该发（拒绝的评论、3 秒内重复、文章已删）
//   ③ 发出去的文案与首次推送同源（pending 走待办提醒，不是「新评论」）
import assert from 'node:assert/strict';
import { handleApi } from '../src/api.js';
import { signToken } from '../src/utils.js';
import { commentNotice, notifyComment, notifyForComment } from '../src/webhook.js';

const SECRET = 'test-key';
const HOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x';

/* ---------- 假 D1：只认本端点会发出的那几条 SQL ---------- */
const fakeDb = (rows = {}) => {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      const st = {
        sql,
        args: [],
        bind(...a) {
          st.args = a;
          return st;
        },
        async first() {
          calls.push({ kind: 'first', sql: st.sql, args: st.args });
          if (/FROM users WHERE id/.test(sql)) return rows.user ?? { id: 1, login: 'boss', name: 'boss', is_admin: 1 };
          if (/FROM comments WHERE id/.test(sql)) return (rows.byId || {})[st.args[0]] ?? null;
          if (/FROM comments ORDER BY id DESC/.test(sql)) return rows.latest ?? null;
          if (/FROM posts WHERE id/.test(sql)) return rows.post ?? null;
          return null;
        },
        async all() {
          calls.push({ kind: 'all', sql: st.sql, args: st.args });
          return { results: [] };
        },
        async run() {
          calls.push({ kind: 'run', sql: st.sql, args: st.args });
          return { meta: { changes: 1 } };
        },
      };
      return st;
    },
    async batch(list) {
      return list.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return db;
};

/* ---------- 假 fetch：记下真正发出去的报文，别让测试真的打群 ---------- */
const captured = [];
let reply = { ok: true, body: '{"errcode":0}' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  captured.push({ url: String(url), body: String(init.body || '') });
  if (url === undefined) return { ok: false, status: 0, text: async () => '' };
  return { ok: reply.ok, status: reply.ok ? 200 : 500, text: async () => reply.body };
};

const TS = '2026-11-26 14:00:00'; // 一分钟前，避开 3 秒窗口
const comment = (o = {}) => ({
  id: 57,
  post_id: 5,
  name: '路人',
  content: '写得很清楚',
  status: 'approved',
  notify_status: 'fail',
  notified_at: TS,
  ...o,
});

const call = async (method, body, envOverride = {}, { cookie } = {}) => {
  const env = { SESSION_SECRET: SECRET, WEBHOOK_URL: HOOK, ...envOverride };
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request('https://exia.de5.net/api/comments/notify', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res: await handleApi(env, req, new URL(req.url), {}), env };
};

const adminCookie = async () => `sid=${encodeURIComponent(await signToken(SECRET, { uid: 1, admin: 1 }, 120))}`;
const reset = () => {
  captured.length = 0;
  reply = { ok: true, body: '{"errcode":0}' };
};

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('NR-01 匿名 → 401，且一条消息都没发', async () => {
  reset();
  const { res } = await call('POST', {}, { DB: fakeDb() });
  assert.equal(res.status, 401);
  assert.equal(captured.length, 0);
});

t('NR-02 非管理员 → 403，同样不发', async () => {
  reset();
  const db = fakeDb({ user: { id: 2, login: 'guest', is_admin: 0 } });
  const { res } = await call('POST', {}, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 403);
  assert.equal(captured.length, 0);
});

t('NR-03 GET 同路径不会走到写分支', async () => {
  reset();
  const { res } = await call('GET', undefined, { DB: fakeDb() }, { cookie: await adminCookie() });
  assert.notEqual(res.status, 200);
  assert.equal(captured.length, 0);
});

t('NR-04 id 不存在 → 404，不发', async () => {
  reset();
  const db = fakeDb({ byId: {} });
  const { res } = await call('POST', { id: 999 }, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 404);
  assert.equal(captured.length, 0);
});

t('NR-05 拒绝状态的评论 → 409（补发不是翻案）', async () => {
  reset();
  const db = fakeDb({ byId: { 57: comment({ status: 'rejected' }) }, post: { slug: 's', title: 'T' } });
  const { res } = await call('POST', { id: 57 }, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 409);
  assert.equal(captured.length, 0);
});

t('NR-06 文章已删 → 404，不发（内容重建不出来就别发半条）', async () => {
  reset();
  const db = fakeDb({ byId: { 57: comment() }, post: null });
  const { res } = await call('POST', { id: 57 }, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 404);
  assert.equal(captured.length, 0);
});

t('NR-07 3 秒内重复 → 429 + retry-after，第二次点击不多发一条', async () => {
  reset();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const db = fakeDb({ byId: { 57: comment({ notified_at: now }) }, post: { slug: 's', title: 'T' } });
  const { res } = await call('POST', { id: 57 }, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '3');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.equal(captured.length, 0);
});

t('NR-08 正常补发：发的是 💬 新评论，写回 ok，note 带「补发」', async () => {
  reset();
  const db = fakeDb({ byId: { 57: comment() }, post: { slug: 'hello-world', title: '你好世界' } });
  const { res } = await call('POST', { id: 57 }, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.id, 57);
  assert.equal(body.notify.status, 'ok');

  assert.equal(captured.length, 1);
  const plain = JSON.parse(captured[0].body).text.content;
  assert.match(plain, /💬 新评论 · 你好世界/);
  assert.match(plain, /https:\/\/exia\.de5\.net\/p\/hello-world/);
  assert.match(plain, /路人：写得很清楚/);

  const upd = db.calls.filter((c) => c.kind === 'run' && /UPDATE comments SET notify_status/.test(c.sql));
  assert.equal(upd.length, 1, '必须写回 notify_status');
  assert.equal(upd[0].args[0], 'ok');
  assert.match(String(upd[0].args[1]), /补发/);
  assert.equal(upd[0].args[3], 57);
});

t('NR-09 pending 的评论补发走待办提醒，不是「新评论」', async () => {
  reset();
  const db = fakeDb({
    byId: { 57: comment({ status: 'pending', notified_at: TS }) },
    post: { slug: 's', title: '待审的文章' },
  });
  const { res } = await call('POST', { id: 57 }, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 200);
  const plain = JSON.parse(captured[0].body).text.content;
  assert.match(plain, /\[待办\] 新评论待审/);
  assert.match(plain, /\/admin\/comments/);
  assert.ok(!plain.includes('💬 新评论'), '待审的评论不能被当成已发布的新评论推进群');
});

t('NR-10 平台码非 0（93000）→ fail，但仍返回 200 并写回 fail', async () => {
  reset();
  reply = { ok: true, body: '{"errcode":93000,"errmsg":"invalid webhook url"}' };
  const db = fakeDb({ byId: { 57: comment() }, post: { slug: 's', title: 'T' } });
  const { res } = await call('POST', { id: 57 }, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.notify.status, 'fail');
  assert.match(body.notify.note, /93000/);
  const upd = db.calls.filter((c) => c.kind === 'run' && /UPDATE comments SET notify_status/.test(c.sql));
  assert.equal(upd[0].args[0], 'fail');
});

t('NR-11 没配 WEBHOOK_URL → skip，且 note 说清是「未配置」而不是「发送失败」', async () => {
  reset();
  const db = fakeDb({ byId: { 57: comment() }, post: { slug: 's', title: 'T' } });
  const { res } = await call('POST', { id: 57 }, { DB: db, WEBHOOK_URL: '' }, { cookie: await adminCookie() });
  const body = await res.json();
  assert.equal(body.notify.status, 'skip');
  assert.match(body.notify.note, /未配置/);
  assert.equal(captured.length, 0);
});

t('NR-12 不给 id 就取最新一条（刚发完评论的那条）', async () => {
  reset();
  const db = fakeDb({ latest: comment({ id: 99 }), post: { slug: 's', title: 'T' } });
  const { res } = await call('POST', {}, { DB: db }, { cookie: await adminCookie() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, 99);
  assert.ok(db.calls.some((c) => c.kind === 'first' && /ORDER BY id DESC LIMIT 1/.test(c.sql)));
});

/* 文案同源：补发与首次推送必须是同一份模板，否则「补发出去的消息少一截」，
   两条路径都不会报错。这条用真发报文比对，不读源码。 */
t('NR-13 commentNotice 与 notifyComment 实发报文逐字一致', async () => {
  reset();
  await notifyComment({ WEBHOOK_URL: HOOK }, { postTitle: 'A', postUrl: 'https://x/p/a', name: 'n', content: 'c' });
  const sent = JSON.parse(captured[0].body).text.content;
  assert.equal(sent, commentNotice({ postTitle: 'A', postUrl: 'https://x/p/a', name: 'n', content: 'c' }));

  reset();
  await notifyForComment({ WEBHOOK_URL: HOOK }, { status: 'approved', postTitle: 'A', postUrl: 'https://x/p/a', name: 'n', content: 'c' });
  assert.equal(JSON.parse(captured[0].body).text.content, sent);
});

let pass = 0;
let fail = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    fail++;
    process.exitCode = 1;
  }
}
globalThis.fetch = realFetch;
console.log(`\nnotify resend: ${pass} passed, ${fail} failed`);
