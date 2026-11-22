// 后台扩展功能守门：审计 / 版本历史 / 友链管理 / 评论审核 / llms.txt / 字数。
// 纯渲染与纯函数在这里验；需要真库的行为在本地 dev + 线上体检里验。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderAudit, renderHistory, renderFriendsAdmin, renderCommentsAdmin } from '../src/admin-pages.js';
import { logAudit } from '../src/audit.js';
import { ADMIN_NAV } from '../src/admin-ui.js';
import { wordCount } from '../src/utils.js';

let pass = 0;
const ok = (name) => {
  pass++;
  console.log(`  ok  ${name}`);
};

/* 审计写失败不能拖垮主流程：假 DB 直接抛，logAudit 必须吞掉。 */
const errCalls = [];
const oldErr = console.error;
console.error = (...a) => errCalls.push(a.join(' '));
await logAudit({ DB: { prepare() { throw new Error('D1 down'); } } }, { id: 1, login: 'x' }, 'post.update', 'post', '7', 'title');
console.error = oldErr;
assert.ok(errCalls.length >= 1, '审计失败应记日志');
ok('审计写入失败只记日志，不抛给主流程');

const writes = [];
await logAudit(
  { DB: { prepare(sql) { return { bind(...args) { writes.push({ sql, args }); return { run: async () => ({}) }; } }; } } },
  null, 'review.approve', 'post', 7, { a: 1 }
);
assert.equal(writes.length, 1);
assert.equal(writes[0].args[0], 0, '无用户时 actor_id 记 0');
assert.equal(writes[0].args[1], 'system');
assert.equal(writes[0].args[5], '{"a":1}');
ok('审计字段：匿名记 system，对象 detail 压成 JSON');

const audit = renderAudit({
  site: { name: '<img>' },
  rows: [{
    id: 1, actor_login: '<script>', action: 'post.update', target_type: 'post',
    target_id: '7', detail: '<b>x</b>', created_at: '2026-11-22 01:00:00',
  }],
});
assert.ok(!audit.includes('<img>') && audit.includes('&lt;img&gt;'));
assert.ok(audit.includes('&lt;script&gt;'), '操作人必须转义（外壳本身有主题引导 script，不能直接判整页无 script）');
assert.ok(!audit.includes('<b>x</b>'));
assert.ok(audit.includes('post.update'));
assert.ok(!/undefined|NaN|\[object Object\]/.test(renderAudit({})));
ok('审计页渲染：转义、动作名、空态无脏值');

const hist = renderHistory({
  site: {}, post: { id: 7, title: '版本测试' },
  rows: [{ id: 3, saved_at: '2026-11-22 01:00:00', saved_by: 1, note: '保存前', title: '版本测试', content: '正文' }],
});
assert.ok(hist.includes('revisions') && hist.includes('restore'), '版本页要有回滚调用');
assert.ok(hist.includes('版本测试') && hist.includes('保存前'));
assert.ok(!/undefined|NaN/.test(hist));
assert.ok(!/undefined|NaN/.test(renderHistory({})));
ok('版本历史页：版本行、回滚入口、缺值稳');

const fr = renderFriendsAdmin({
  site: {}, rows: [{ id: 2, name: '<b>友链</b>', url: 'https://x.example', status: 0, http_status: 404, latency_ms: 12 }],
});
assert.ok(!fr.includes('<b>友链</b>') && fr.includes('&lt;b&gt;'));
assert.ok(fr.includes('/api/friends') && fr.includes('check'));
assert.ok(!/undefined|NaN/.test(renderFriendsAdmin({})));
ok('友链管理页：转义、增删探 API、空态');

const cm = renderCommentsAdmin({
  site: {}, moderation: '1',
  rows: [{ id: 5, name: '<i>昵称</i>', content: '内容', post_title: '文章', created_at: '2026-11-22 01:00:00' }],
});
assert.ok(!cm.includes('<i>昵称</i>') && cm.includes('&lt;i&gt;'));
assert.ok(cm.includes('/api/comments/moderation') && cm.includes('moderate'));
assert.ok(!/undefined|NaN/.test(renderCommentsAdmin({})));
ok('评论审核页：转义、开关与处置接口、空态');

for (const key of ['cmts', 'audit', 'friends']) {
  assert.ok(ADMIN_NAV.some((it) => it.key === key), `导航缺 ${key}`);
}
ok('导航含评论审核 / 操作日志 / 友链管理');

assert.equal(wordCount('你好世界 hello world'), 6);
assert.equal(wordCount('```js\nconst a = 1;\n```\n中文'), 2);
assert.equal(wordCount(''), 0);
ok('字数：中文按字、西文按词，代码块不算');

const api = readFileSync('src/api.js', 'utf8');
assert.ok(api.includes("AND status = 'approved'"), '评论读取必须只给已通过');
assert.ok(api.includes('content, is_admin, status, ip, created_at'), '评论 INSERT 缺 status');
assert.ok(api.includes('/restore'), '缺回滚接口');
const idx = readFileSync('src/index.js', 'utf8');
assert.ok(idx.includes("path === '/llms.txt'"), '缺 llms.txt 路由');
assert.ok(idx.includes("c.status = 'approved'"), 'SSR 评论缺审核闸门');
ok('源码口径：评论闸门 / 回滚接口 / llms.txt 路由齐全');

console.log(`\nadmin extras: ${pass} passed`);
