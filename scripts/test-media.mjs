// 媒体库守门：过滤、排序、渲染、转义、空态。
// 只测纯函数与纯渲染；真实 R2 列表在本地 dev（wrangler dev + r2 put --local）和线上体检里验。
import assert from 'node:assert/strict';
import { mediaRows, renderMediaAdmin } from '../src/admin-pages.js';

let pass = 0;
const ok = (name) => {
  pass++;
  console.log(`  ok  ${name}`);
};

/* ---------- M-01 过滤：变体与头像不进列表，直接上传的 webp 是媒体 ---------- */

const AT = (s) => `2026-11-26T${s}.000Z`;
const objs = [
  { key: '2026/11/a.png', size: 100, uploaded: AT('10:00:00') },
  { key: '2026/11/a.png.webp', size: 60, uploaded: AT('10:00:01') },
  { key: '2026/11/a.png.w800.webp', size: 30, uploaded: AT('10:00:02') },
  { key: '2026/11/a.jpg.avif', size: 20, uploaded: AT('10:00:03') },
  { key: '2026/11/a.jpg.w1200.avif', size: 10, uploaded: AT('10:00:04') },
  { key: 'photo.webp', size: 70, uploaded: AT('10:00:05') },
  { key: 'avatar/u123-96', size: 5, uploaded: AT('10:00:06') },
];

const kept = mediaRows(objs).map((o) => o.key);
assert.deepEqual(
  kept,
  ['photo.webp', '2026/11/a.png'],
  '只留原图与直接上传的 webp；变体四种形状与头像都要滤掉'
);
ok('M-01 变体（.webp / .w800.webp / .avif / .w1200.avif）与 avatar/ 被滤，直接上传的 webp 保留');

/* ---------- M-02 排序：按上传时间倒序，Date 与字符串两种输入 ---------- */

const mixed = mediaRows([
  { key: 'old.png', size: 1, uploaded: new Date('2026-11-01T00:00:00Z') },
  { key: 'new.png', size: 1, uploaded: '2026-11-26T00:00:00Z' },
  { key: 'mid.png', size: 1, uploaded: '2026-11-10T00:00:00Z' },
]);
assert.deepEqual(mixed.map((o) => o.key), ['new.png', 'mid.png', 'old.png'], '未按时间倒序');
assert.equal(mixed[2].uploaded, '2026-11-01T00:00:00.000Z', 'Date 输入未归一成 ISO 字符串');
ok('M-02 上传时间倒序，Date 入参归一为 ISO（toCN 只认 ISO / D1 格式）');

/* ---------- M-03 渲染：缩略图、文件名、大小、时间、打开链接 ---------- */

const html = renderMediaAdmin({
  site: { name: 'T' },
  rows: mediaRows(objs),
  sum: 170,
  truncated: false,
});
assert.match(html, /<img class="admin-ava" src="\/img\/photo\.webp"/, '缩略图未指向 /img/');
assert.match(html, /<strong class="adm-fr-name">photo\.webp<\/strong>/, '文件名缺失');
assert.match(html, /<span class="adm-fr-code">70 B<\/span>/, '大小未格式化');
assert.match(html, /href="\/img\/2026\/11\/a\.png" target="_blank" rel="noopener noreferrer"/, '打开链接缺 rel 或地址错');
assert.match(html, /170 B/, '合计大小未渲染');
assert.match(html, /2 条/, '对象数未渲染');
ok('M-03 缩略图 / 文件名 / 大小 / 时间 / 打开链接 / 统计齐全');

/* ---------- M-04 转义：R2 key 是不可信输入（历史上传脚本可写任意 key） ----------

   注意断言的落点：img 的 src 先过 encodeURIComponent，引号早变成 %22 了，
   拿它验 esc 会是假绿（去掉 esc 也照样绿）。esc 真正独当一面的是**文本节点**
   —— 文件名进 <strong> 时没有任何编码兜底。 */
const evil = renderMediaAdmin({
  rows: [{ key: 'x<img src=x onerror=alert(1)>.png', size: 1, uploaded: AT('10:00:00') }],
  sum: 1,
});
assert.ok(!/<img src=x onerror/.test(evil), 'key 未转义，标签进了页面');
assert.ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;'), '转义结果不符合预期');
ok('M-04 key 里的尖括号在文本节点被转义，不能注入标签');

/* ---------- M-05 URL 编码：空格 / 中文 / # 逐段编码 ---------- */

assert.match(
  html,
  /src="\/img\/2026\/11\/a\.png"/,
  '路径分隔符不该被编码'
);
const cn = renderMediaAdmin({
  rows: mediaRows([{ key: '2026/11/我的 图#1.png', size: 1, uploaded: AT('10:00:00') }]),
  sum: 1,
});
assert.match(cn, /src="\/img\/2026\/11\/%E6%88%91%E7%9A%84%20%E5%9B%BE%231\.png"/, '中文/空格/# 未逐段编码');
assert.ok(!cn.includes('我的 图#1.png"'), '原始 key 直接进了属性');
ok('M-05 key 逐段编码，中文/空格/# 不会截断 URL');

/* ---------- M-06 空态与错误态必须长得不一样 ---------- */

const empty = renderMediaAdmin({ rows: [], sum: 0 });
assert.match(empty, /还没有图片/, '空态文案缺失');
assert.ok(!/读取 R2 失败/.test(empty), '空库不该显示读取失败');
const failed = renderMediaAdmin({ rows: [], sum: 0, error: 'D1 down' });
assert.match(failed, /读取 R2 失败：D1 down/, '读取失败没有在页面上出现');
assert.ok(!/还没有图片/.test(failed), '失败态被空态覆盖 —— 故障会伪装成「还没上传」');
ok('M-06 空库与读取失败是两个状态，不互相冒充');

/* ---------- M-07 截断：数字带 +，页面上写明达到上限 ---------- */

const cut = renderMediaAdmin({ rows: mediaRows(objs), sum: 1, truncated: true });
assert.match(cut, /2\+ 个/, '截断时对象数未带 +');
assert.match(cut, /已达单次上限 200/, '截断未在界面上说明');
ok('M-07 truncated 时数字带 + 且写明上限，不假装是全量');

/* ---------- M-08 大小格式边界 ---------- */

const size = (n) =>
  renderMediaAdmin({ rows: [{ key: 'a.png', size: n, uploaded: AT('10:00:00') }], sum: n });
assert.match(size(0), /adm-fr-code">0 B</, '0 B');
assert.match(size(1023), /adm-fr-code">1023 B</, '1023 B');
assert.match(size(1024), /adm-fr-code">1\.0 KB</, '1024 → 1.0 KB');
assert.match(size(1048575), /adm-fr-code">1024\.0 KB</, '1048575 → 1024.0 KB');
assert.match(size(1048576), /adm-fr-code">1\.00 MB</, '1 MiB → 1.00 MB');
assert.match(size(-5), /adm-fr-code">0 B</, '负数钳到 0');
assert.match(size('abc'), /adm-fr-code">0 B</, '非数字钳到 0');
ok('M-08 大小格式边界：0 / 1023 / 1024 / 1MiB-1 / 1MiB / 负数 / 非数字');

/* ---------- M-09 只读：页面里不能出现删除动作 ---------- */

assert.ok(!/data-act="delete"/.test(html), '媒体页出现了删除按钮');
assert.ok(!/<button/.test(html), '媒体页不该有按钮（只读清单）');
assert.match(html, /只列不删/, '页面未说明只读边界');
ok('M-09 页面只读：无删除动作、无按钮，并写明「只列不删」');

console.log(`\n[P-084] media admin: ${pass} passed`);
