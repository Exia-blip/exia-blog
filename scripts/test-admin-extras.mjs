// 后台扩展功能守门：审计 / 版本历史 / 友链管理 / 评论审核 / llms.txt / 字数。
// 纯渲染与纯函数在这里验；需要真库的行为在本地 dev + 线上体检里验。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderAudit, renderHistory, renderFriendsAdmin, renderCommentsAdmin } from '../src/admin-pages.js';
import { renderDashboard } from '../src/dashboard.js';
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

/* 四态 + 通知列：这是「落库 → 群里收到」唯一的可观察面，映射错了比不加更糟。 */
const cm2 = renderCommentsAdmin({
  site: {},
  moderation: '1',
  tab: 'approved',
  counts: { pending: 3, approved: 12, rejected: 1, all: 16 },
  notifyStats: { ok: 9, fail: 2, skip: 4, none: 1 },
  rows: [
    { id: 11, name: '张三', content: '第一条', post_title: '文章甲', created_at: '2026-11-22 01:00:00', status: 'approved', notify_status: 'ok', notified_at: '2026-11-22 01:00:05' },
    { id: 12, name: '李四', content: '回复', post_title: '文章甲', created_at: '2026-11-22 02:00:00', status: 'approved', parent_id: 11, parent_name: '张三', notify_status: 'fail', notify_note: '平台码 93000' },
    { id: 13, name: '王五', content: '老的', post_title: '文章甲', created_at: '2026-11-22 03:00:00', status: 'approved', notify_status: '' },
  ],
});
assert.ok(cm2.includes('href="/admin/comments?status=pending"'), '四态要有可点的过滤入口');
assert.ok(cm2.includes('aria-current="page"'), '当前态要标出来');
assert.ok(cm2.includes('待审 3') && cm2.includes('全部 16'), '每个态要带数量');
/* 只认 pill 结构：汇总条里也有「已送达 9」这几个字，用宽匹配等于什么都没验。 */
assert.ok(cm2.includes('>已送达</span>') && cm2.includes('>失败</span>') && cm2.includes('>未尝试</span>'), '每行要按 notify_status 出对应的 pill');
assert.ok(cm2.includes('平台码 93000'), '失败原因要进 title（否则还得翻日志）');
assert.ok(cm2.includes('回复 张三') && cm2.includes('顶层'), '层级要能看出来');
assert.ok(cm2.includes('已送达 9 · 失败 2 · 跳过 4 · 未尝试 1'), '汇总条数字要来自库，不是写死的');
assert.ok(!/undefined|NaN/.test(cm2), '缺字段不许漏 NaN/undefined');
ok('评论管理：四态过滤、层级、通知三态与汇总数字');

/* 概览待办条：四条可判定数字 + 直达链接；全零时不能写成「要做的 0 件」。 */
const dashTodo = renderDashboard({ site: {}, kpi: { cmtPending: 3, queue: 2, notifyFail: 1 }, sys: { friendDown: 1 } });
assert.ok(dashTodo.includes('今天要做的 7 件'), '四个数字要相加');
assert.ok(dashTodo.includes('/admin/comments') && dashTodo.includes('/admin/queue') && dashTodo.includes('/admin/friends'));
const dashClean = renderDashboard({ site: {}, kpi: { cmtPending: 0, queue: 0, notifyFail: 0 }, sys: { friendDown: 0 } });
assert.ok(dashClean.includes('今天没有待办'), '全零要明确说没有待办');
assert.ok(!dashClean.includes('要做的 0 件'));
assert.ok(!/undefined|NaN/.test(renderDashboard({})), '缺数据不许漏脏值');
ok('概览待办条：数字相加、链接、全零文案');

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

/* 关掉审核开关要放行存量 pending：这条是老板点名的口径，
   漏掉的话开关关了、待审评论却永远卡在待审页。 */
assert.ok(api.includes("UPDATE comments SET status = 'approved' WHERE status = 'pending'"), '关闭开关未批量放行 pending');
assert.ok(api.includes('if (was && enabled === \'0\')'), '放行未限定 1→0 翻转，重复关闭会误放行');
assert.ok(api.includes('放行 ${released} 条待审评论'), '审计未记放行条数');
assert.ok(api.includes('released,\n    }\n  }') || api.includes('released });'), '响应未回释放条数');
const cmSrc = readFileSync('src/admin-pages.js', 'utf8');
assert.ok(cmSrc.includes('一并放行下面所有待审评论'), '后台未说明关闭会放行');
assert.ok(cmSrc.includes('window.confirm'), '关闭前没有二次确认');
ok('关闭审核开关：放行 pending / 翻转限定 / 审计留痕 / 二次确认');

console.log(`\n[P-011] admin extras: ${pass} passed`);
