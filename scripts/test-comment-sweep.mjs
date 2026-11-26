// 评论巡检：垃圾打分 + 补推 + 三条免检线。
// 用法：node scripts/test-comment-sweep.mjs
//
// 这块的风险不是「删不掉」，是「删多了且没人知道」。所以断言的重心：
//   ① 打分对正常评论不越线（误杀是这类功能唯一真正致命的失败）
//   ② 管理员自己发的、有回复的、已拒绝的一律不动 —— 这是行为断言，不是读源码
//   ③ dry 真的一点都不动（不发消息、不删行）
import assert from 'node:assert/strict';
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

/* 假 fetch：记下发出去的报文，别打真群。 */
const sent = [];
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
