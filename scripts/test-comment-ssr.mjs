// 评论区的服务端渲染：按钮该给谁、字段该不该出现在 HTML 里。
// 这几条以前没法测（函数没导出，线上又一条评论都没有），
// 结果就是"删评论按钮到底会不会漏给访客"从来没被验证过。
import assert from 'node:assert/strict';
import { renderComments, renderComment, commentActs } from '../src/index.js';

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + name);
};

const row = {
  id: 10,
  parent_id: null,
  name: '访客',
  email: 'probe@example.com',
  website: 'https://example.com',
  content: '一条评论',
  is_admin: 0,
  created_at: '2026-11-14 01:00:00',
};
const reply = { ...row, id: 11, parent_id: 10, content: '一条回复' };

/* ---------- 匿名 ---------- */
t('匿名看到的每条根评论都有回复按钮', () => {
  const h = renderComments([row], 1, null);
  assert.match(h, /data-reply="10"/);
});

t('匿名看不到删除 / 封 IP 按钮', () => {
  const h = renderComments([row], 1, null);
  assert.ok(!h.includes('data-del='), '不该有删除按钮');
  assert.ok(!h.includes('data-ban='), '不该有封 IP 按钮');
});

t('匿名的 HTML 里没有访客邮箱', () => {
  const h = renderComments([row], 1, null);
  assert.ok(!h.includes('probe@example.com'), '邮箱不能出现在匿名页面');
  assert.ok(!h.includes('cmt-mail'), '不该有联系邮箱链接');
});

/* ---------- 管理员 ---------- */
t('管理员每条评论都有删除与封 IP', () => {
  const h = renderComments([row], 1, { id: 1, is_admin: 1 });
  assert.match(h, /data-del="10"/);
  assert.match(h, /data-ban="10"/);
});

t('管理员能看到联系邮箱，且是 mailto', () => {
  const h = renderComments([row], 1, { id: 1, is_admin: 1 });
  assert.match(h, /class="cmt-mail" href="mailto:probe@example\.com"/);
});

t('非管理员登录用户（is_admin=0）不给管理按钮', () => {
  const h = renderComments([row], 1, { id: 2, is_admin: 0 });
  assert.ok(!h.includes('data-del='));
  assert.match(h, /data-reply="10"/);
});

/* ---------- 嵌套 ---------- */
t('回复不带回复按钮，避免无限嵌套', () => {
  const h = renderComments([row, reply], 2, null);
  assert.match(h, /data-reply="10"/);
  assert.ok(!h.includes('data-reply="11"'), '子评论不该有回复按钮');
  assert.equal((h.match(/class="replies"/g) || []).length, 1, '只应有一层 replies 容器');
});

t('子评论挂在根评论的 replies 里', () => {
  const h = renderComments([row, reply], 2, null);
  const i = h.indexOf('class="replies"');
  assert.ok(h.indexOf('data-cid="11"') > i, '子评论应在 replies 容器之后');
});

/* ---------- 转义 ---------- */
t('昵称与正文的尖括号被转义', () => {
  const evil = { ...row, name: '<img src=x onerror=alert(1)>', content: '<script>alert(1)</script>' };
  const h = renderComments([evil], 1, null);
  assert.ok(!h.includes('<img src=x'), '昵称不能原样落进 HTML');
  assert.ok(!h.includes('<script>alert'), '正文不能原样落进 HTML');
  assert.match(h, /&lt;/);
});

t('回复按钮的 data-name 里双引号不会截断属性', () => {
  const evil = { ...row, name: 'a" onmouseover="alert(1)' };
  const h = renderComment(evil, false, null);
  assert.ok(!/data-name="a" onmouseover=/.test(h), '属性不能被提前闭合');
  assert.match(h, /data-name="a&quot; onmouseover=&quot;alert\(1\)"/);
});

/* ---------- 表单 ---------- */
t('每个输入都有对应的 label', () => {
  const h = renderComments([], 0, null);
  for (const id of ['cmt-name', 'cmt-email', 'cmt-website', 'cmt-content']) {
    assert.match(h, new RegExp(`<label class="sr-only" for="${id}">`), `${id} 缺 label`);
    assert.match(h, new RegExp(`id="${id}"`), `${id} 字段本身不存在`);
  }
});

t('空列表给一句提示，不是空白区块', () => {
  const h = renderComments([], 0, null);
  assert.match(h, /还没有评论/);
});

t('评论区带 data-ssr，前端靠它判断"不用再拉一次"', () => {
  assert.match(renderComments([], 0, null), /id="comments" data-ssr="1"/);
});

/* ---------- 独占一条：评论数 ---------- */
t('有评论时显示数量，没有就留空', () => {
  assert.match(renderComments([row], 3, null), /id="cmt-count">\(3\)/);
  assert.match(renderComments([], 0, null), /id="cmt-count"><\/span>/);
});

t('commentActs 对子评论只给管理按钮，不给回复', () => {
  const h = commentActs({ ...reply, parent_id: 10 }, { is_admin: 1 });
  assert.ok(!h.includes('data-reply='));
  assert.match(h, /data-del="11"/);
});

console.log(`\n${pass} 条通过`);
