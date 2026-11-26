// 评论巡检：垃圾打分 + 补推 + 三条免检线。
// 用法：node scripts/test-comment-sweep.mjs
//
// 这块的风险不是「删不掉」，是「删多了且没人知道」。所以断言的重心：
//   ① 打分对正常评论不越线（误杀是这类功能唯一真正致命的失败）
//   ② 管理员自己发的、有回复的、已拒绝的一律不动 —— 这是行为断言，不是读源码
//   ③ dry 真的一点都不动（不发消息、不删行）
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spamScore, SPAM_MIN_SCORE } from '../src/spam.js';
import { sweepComments } from '../src/cron.js';

const SECRET = 'test-key';
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* 假 D1：按 SQL 形状分派。返回的 rows 由每个用例自己塞。 */
function fakeDb({ retry = [], spam = [] } = {}) {
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
          return null;
        },
        async all() {
          calls.push({ kind: 'all', sql, args: st.args });
          if (/LEFT JOIN posts/.test(sql)) return { results: retry };
          if (/COUNT\(\*\) FROM comments k/.test(sql)) return { results: spam };
          return { results: [] };
        },
        async run() {
          calls.push({ kind: 'run', sql, args: st.args });
          return { meta: { changes: 1 } };
        },
      };
      return st;
    },
    async batch(l) {
      return l.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return db;
}

/* 真 SQL 的 D1 适配：用 node:sqlite 内存库跑 sweepComments 下发的原句。
   fakeDb 是按 SQL 形状塞结果的替身 —— 它能验流程，验不了「这条 SQL 会不会选中
   一条 7 小时前的评论」。窗口、冷却、每轮上限这三条判据只能交给真引擎：字符串里
   有 created_at >= 不代表下界是对的，有 LIMIT 不代表捞的是 10 条。 */
function sqliteDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE posts (id INTEGER PRIMARY KEY, slug TEXT, title TEXT);
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY, post_id INTEGER, parent_id INTEGER, name TEXT, content TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'approved',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      notify_status TEXT NOT NULL DEFAULT '', notify_note TEXT NOT NULL DEFAULT '',
      notified_at TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_login TEXT,
      action TEXT, target_type TEXT, target_id TEXT, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("INSERT INTO posts (id, slug, title) VALUES (1, 's', '标题')");
  const calls = [];
  return {
    calls,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = {
        sql,
        args: [],
        bind(...a) {
          st.args = a;
          return st;
        },
        async all() {
          calls.push({ kind: 'all', sql, args: st.args });
          return { results: db.prepare(sql).all(...st.args) };
        },
        async first() {
          const r = db.prepare(sql).get(...st.args);
          return r ?? null;
        },
        async run() {
          calls.push({ kind: 'run', sql, args: st.args });
          const r = db.prepare(sql).run(...st.args);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return st;
    },
    async batch(l) {
      return l.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

/* 时间一律用 SQL 表达式算，不在 JS 里减 —— 两边各算一次就会引入时区/精度差，
   失败时还看不出是窗口错了还是夹具错了。 */
function seedComment(db, { id, isAdmin = 0, ago = '10 minutes', notify = 'fail', notified = null, content = '写得挺清楚' }) {
  db.exec(
    `INSERT INTO comments (id, post_id, name, content, is_admin, status, created_at, notify_status, notified_at)
     VALUES (${id}, 1, '路人', '${content}', ${isAdmin}, 'approved',
             datetime('now','-${ago}'), '${notify}', ${notified ? `datetime('now','-${notified}')` : 'NULL'})`
  );
}

/* 假 fetch：记下发出去的报文，别打真群。 */const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), body: String(init.body || '') });
  return { ok: true, status: 200, text: async () => '{"errcode":0}' };
};

const row = (o) => ({
  id: 1,
  name: '路人',
  content: '写得挺清楚',
  is_admin: 0,
  status: 'approved',
  kids: 0,
  notify_status: '',
  notified_at: '',
  slug: 's',
  title: '标题',
  ...o,
});

/* ---------- 打分 ---------- */

t('SW-01 正常中文短评不越线', () => {
  for (const c of ['好文', '写得很清楚', '这条我不同意，但说理完整', 'Thanks for this', 'nice post']) {
    const { score } = spamScore({ content: c });
    assert.ok(score < SPAM_MIN_SCORE, `「${c}」不该被判垃圾（score=${score}）`);
  }
});

t('SW-02 正常评论带一个链接不越线', () => {
  const { score } = spamScore({ content: '这个现象我也遇到过，细节在这篇 https://example.com/a 里' });
  assert.ok(score < SPAM_MIN_SCORE, `score=${score}`);
});

t('SW-03 实测那条韩文垃圾越线（过短 + 非中文极短）', () => {
  const r = spamScore({ content: '현정 상' });
  assert.ok(r.score >= SPAM_MIN_SCORE, `score=${r.score}`);
  assert.ok(r.reasons.some((x) => x.startsWith('过短')));
  assert.ok(r.reasons.some((x) => x.startsWith('非中文极短')));
});

t('SW-04 纯链接 / 多链接 / 短链都要越线', () => {
  for (const c of [
    'https://spam.example/x',
    '看这里 https://a.example/1 https://b.example/2 https://c.example/3',
    '加我 https://t.me/xxx',
  ]) {
    assert.ok(spamScore({ content: c }).score >= SPAM_MIN_SCORE, c);
  }
});

t('SW-05 推广词 +3，单靠它不够（需要叠加）', () => {
  const one = spamScore({ content: '有没有人聊贷款的事，我在银行工作' });
  assert.ok(one.reasons.some((x) => x.startsWith('推广词')));
  assert.equal(one.score, 3, '单条推广词不该到 4 分，避免误杀正常讨论');
});

t('SW-06 纯符号评论越线', () => {
  assert.ok(spamScore({ content: '!!!!????' }).score >= SPAM_MIN_SCORE);
});

/* ---------- 巡检 ---------- */

t('SW-07 管理员自己发的：分数再高也不删', async () => {
  const db = fakeDb({ spam: [row({ id: 5, is_admin: 1, content: 'https://t.me/x https://t.me/y' })] });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  assert.equal(out.deleted.length, 0);
  assert.equal(out.exempt, 1, '免检的要被计数，否则「0 命中」会掩盖「其实扫到了但跳过了」');
  assert.equal(db.calls.filter((c) => c.kind === 'run' && /DELETE FROM comments/.test(c.sql)).length, 0);
});

t('SW-08 有回复的父评论不删（删父会连坐子回复）', async () => {
  const db = fakeDb({ spam: [row({ id: 6, kids: 2, content: 'https://t.me/x https://t.me/y' })] });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  assert.equal(out.deleted.length, 0);
});

t('SW-09 已拒绝的评论不再处理', async () => {
  const db = fakeDb({ spam: [row({ id: 7, status: 'rejected', content: 'https://t.me/x https://t.me/y' })] });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  assert.equal(out.deleted.length, 0);
});

t('SW-10 命中就删，并把理由写进 audit_log', async () => {
  const db = fakeDb({ spam: [row({ id: 12, name: 'aizheni13', content: '현정 상' })] });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  assert.equal(out.deleted.length, 1);
  assert.equal(out.deleted[0].id, 12);
  const del = db.calls.find((c) => c.kind === 'run' && /DELETE FROM comments/.test(c.sql));
  assert.deepEqual(del.args, [12]);
  const audit = db.calls.find((c) => c.kind === 'run' && /INSERT INTO audit_log/.test(c.sql));
  assert.ok(audit, '自动删除必须留痕');
  assert.match(String(audit.args[2]), /comment\.spam\.purge/);
  assert.match(String(audit.args[5]), /score=/, 'detail 里要有分数与理由');
});

t('SW-11 dry：一条不删、一条不发', async () => {
  sent.length = 0;
  const db = fakeDb({
    spam: [row({ id: 12, content: '현정 상' })],
    retry: [row({ id: 13, notify_status: '' })],
  });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: true });
  assert.equal(out.dry, true);
  assert.equal(out.deleted.length, 1, 'dry 仍要报告会删谁');
  assert.equal(sent.length, 0);
  assert.equal(db.calls.filter((c) => c.kind === 'run').length, 0, 'dry 不许有任何写');
});

t('SW-12 补推：没送到的重投一次并写回', async () => {
  sent.length = 0;
  const db = fakeDb({ retry: [row({ id: 13, notify_status: 'fail' })], spam: [] });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  assert.equal(out.retried.length, 1);
  assert.equal(out.retried[0].status, 'ok');
  assert.equal(sent.length, 1);
  assert.match(JSON.parse(sent[0].body).text.content, /💬 新评论/);
  const upd = db.calls.find((c) => c.kind === 'run' && /UPDATE comments SET notify_status/.test(c.sql));
  assert.match(String(upd.args[1]), /补推/);
});

t('SW-13 补推：待审的走待办提醒，不发「新评论」', async () => {
  sent.length = 0;
  const db = fakeDb({ retry: [row({ id: 14, status: 'pending' })], spam: [] });
  await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  const text = JSON.parse(sent[0].body).text.content;
  assert.match(text, /\[待办\] 新评论待审/);
  assert.ok(!text.includes('💬 新评论'));
});

t('SW-14 没配 WEBHOOK_URL：补推整段跳过（不空转、不发 skip）', async () => {
  sent.length = 0;
  const db = fakeDb({ retry: [row({ id: 15 })], spam: [] });
  const out = await sweepComments({ DB: db }, { dry: false });
  assert.equal(out.skipped, 'no-webhook');
  assert.equal(out.retried.length, 0);
  assert.equal(sent.length, 0);
});

t('SW-15 原文已删：标 fail 并注明，不发半条', async () => {
  sent.length = 0;
  const db = fakeDb({ retry: [row({ id: 16, title: null })], spam: [] });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  assert.equal(out.retried[0].status, 'fail');
  assert.match(out.retried[0].note, /原文已删/);
  assert.equal(sent.length, 0);
});

/* ---------- 补推的三条边界：下界 / 冷却 / 每轮上限 ----------
   这三条都写在 SQL 里，所以判据也要落到 SQL 上 —— 但只有前两条能做结构断言，
   真正「会不会选中」只能交给真引擎跑一遍（SW-18..SW-20 那段）。 */

const retrySqlOf = (db) => {
  const q = db.calls.find((c) => c.kind === 'all' && /LEFT JOIN posts/.test(c.sql));
  assert.ok(q, '没有下发补推查询 —— 判据无从谈起');
  return q.sql;
};

t('SW-16 补推 SQL 必须同时有下界与每轮上限', async () => {
  const db = fakeDb({ retry: [], spam: [] });
  await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: true });
  const sql = retrySqlOf(db);
  assert.match(sql, /created_at\s*>=/, '补推缺 created_at 下界 —— 两年前的评论会被捞出来推进群');
  assert.match(
    sql,
    /created_at\s*>=\s*datetime\('now','-\d+ (minutes|hours|days)'\)/,
    '下界必须是相对当前时间的窗口（datetime(\'now\',\'-Nh\')），固定日期会在某天悄悄变成「什么都补」'
  );
  assert.match(sql, /LIMIT\s+\d+/, '补推缺 LIMIT —— 平台抖动时一次把整个队列打穿');
  const limit = Number(sql.match(/LIMIT\s+(\d+)/)[1]);
  assert.ok(limit > 0 && limit <= 50, `每轮上限 ${limit} 不合理（0 等于不补，过大会打穿队列）`);
});

t('SW-17 补推不得按 is_admin 过滤（与首次投递同一判据，P-082）', async () => {
  const db = fakeDb({ retry: [], spam: [] });
  await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: true });
  const sql = retrySqlOf(db);
  assert.ok(
    !/\bis_admin\b/.test(sql),
    '补推又按 is_admin 过滤了 —— 首次投递不区分身份，两边判据不一致就等于「管理员评论第一次失败没人管」'
  );
});

t('SW-18 真 SQL：管理员自己发的评论也进补推队列', async () => {
  sent.length = 0;
  const db = sqliteDb();
  seedComment(db, { id: 1, isAdmin: 1 });
  seedComment(db, { id: 2, isAdmin: 0 });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: false });
  assert.deepEqual(
    out.retried.map((r) => r.id),
    [1, 2],
    '管理员那条没被补推 —— 与首次投递不对称'
  );
  assert.equal(sent.length, 2, '两条都要真发一次');
  const upd = db.calls.filter((c) => c.kind === 'run' && /UPDATE comments SET notify_status/.test(c.sql));
  assert.equal(upd.length, 2, '两条都要写回状态，否则下一轮会重复补');
});

t('SW-19 真 SQL：窗口外 / 冷却中 / 首次投递还没跑完的，都不补', async () => {
  const db = sqliteDb();
  seedComment(db, { id: 11, ago: '7 hours' }); // 下界外
  seedComment(db, { id: 12, ago: '30 minutes', notified: '5 minutes' }); // 冷却中
  seedComment(db, { id: 13, ago: '30 seconds' }); // 留给首次投递，不抢
  seedComment(db, { id: 14, ago: '3 hours', notify: 'ok' }); // 已送达
  seedComment(db, { id: 15, ago: '3 hours', notified: '3 hours' }); // 该补
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: true });
  assert.deepEqual(out.retried.map((r) => r.id), [15], '只该补 #15');
});

t('SW-20 真 SQL：候选超过 10 条也只捞 10 条，剩下的下一轮接着补', async () => {
  const db = sqliteDb();
  for (let i = 1; i <= 12; i++) seedComment(db, { id: i, ago: '10 minutes' });
  const out = await sweepComments({ DB: db, WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }, { dry: true });
  assert.equal(out.retried.length, 10, '每轮上限失效，队列会被一次打穿');
  assert.deepEqual(out.retried.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'ORDER BY id 取最早的十条，保证轮转');
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
console.log(`\ncomment sweep: ${pass} passed, ${fail} failed`);
