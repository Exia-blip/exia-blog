// 后台 UI/交互第一批守门：提交防重复锁、统计表格斑马纹、就近表单报错、预览单向滚动同步。
// 全是后台钩子，靠静态接线锁定；同时守住读者侧零污染（post/index/app/md 不出现同名类）。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const editor = readFileSync('public/editor.html', 'utf8');
const stats = readFileSync('src/stats.js', 'utf8');
const css = readFileSync('public/style.css', 'utf8');
const post = readFileSync('public/post.html', 'utf8');
const index = readFileSync('public/index.html', 'utf8');
const app = readFileSync('public/app.js', 'utf8');
const md = readFileSync('public/md.js', 'utf8');

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

// ① 提交防重复锁：saving 在途置灰 + 文案切换，finally 必解锁，复用 .btn:disabled
assert.match(editor, /function setSaveBusy\(busy\)/, '缺 setSaveBusy');
assert.match(editor, /saveBtn\.disabled = busy/, '置灰未接 disabled');
assert.match(editor, /'发布中…'/, '发布中文案缺失');
assert.match(editor, /setSaveBusy\(true\)/, '在途未上锁');
assert.match(editor, /setSaveBusy\(false\)[\s\S]{0,40}\/\/ 成功 \/ 报错都解锁/, 'finally 未解锁');
assert.ok(css.includes('.btn:disabled'), '应复用现有 .btn:disabled 样式');
ok('① 提交防重复锁：上锁/解锁/文案切换齐全');

// ② 统计表格斑马纹 + hover：只作用 tbody tr，表头不参与，色值走 --bg-soft
assert.match(stats, /tbody tr:nth-child\(even\)\{background:color-mix\(in srgb,var\(--bg-soft\)/, '斑马纹缺失或未走主题变量');
assert.match(stats, /tbody tr:hover\{background:var\(--bg-soft\)\}/, 'hover 高亮缺失');
assert.ok(!/thead tr:nth-child/.test(stats), '表头不应参与斑马纹');
assert.match(stats, /if \(!rows\.length\) return '<p class="empty">/, '空数据应是 <p> 无 tr');
ok('② 统计表格斑马纹 + hover：作用域正确，空态自然无样式');

// ③ 就近表单报错：槽位 + show/clear 接线 + 空值改内联 + 输入清错 + 无槽位回落 toast
assert.ok(editor.includes('id="site-name-error"'), '站点名缺 .field-error 槽位');
assert.match(editor, /function showFieldError\(inputId, msg\)/, '缺 showFieldError');
assert.match(editor, /if \(!slot\) \{ toast\(msg\)/, '无槽位应回落 toast');
assert.match(editor, /function clearFieldError\(inputId\)/, '缺 clearFieldError');
assert.match(editor, /if \(!name\) \{ showFieldError\('site-name'/, '站点名空值未改内联');
assert.match(editor, /addEventListener\('input', \(\) => clearFieldError\('site-name'\)\)/, '输入未清旧错');
assert.match(css, /\.field-error \{[^}]*color: var\(--red\)/, '报错色未走 --red');
assert.match(css, /input\.invalid, textarea\.invalid \{[^}]*border-color: var\(--red\)/, '红边未走 --red');
ok('③ 就近表单报错：槽位/接线/清错/回落齐全');

// ④ 单向滚动同步：开关默认关、比例映射、只监听编辑区、80ms 防抖、localStorage、resize
assert.ok(editor.includes('id="sync-scroll"'), '缺同步滚动开关');
assert.match(editor, /const KEY = 'ed:sync-scroll'/, '未定义本地偏好键');
assert.match(editor, /localStorage\.getItem\(KEY\)/, '未读取本地偏好');
assert.match(editor, /localStorage\.setItem\(KEY, enabled\(\) \? '1' : '0'\)/, '偏好未持久化');
assert.match(editor, /const ratio = inputEl\.scrollTop \/ srcMax/, '未按滚动比例映射');
assert.match(editor, /previewEl\.scrollTop = ratio \* dstMax/, '未写入预览区');
assert.match(editor, /inputEl\.addEventListener\('scroll'/, '只应监听编辑区');
assert.ok(!/previewEl\.addEventListener\('scroll'/.test(editor), '禁止回拉预览造成死循环');
assert.match(editor, /setTimeout\(sync, 80\)/, '缺 80ms 防抖');
assert.match(editor, /if \(srcMax <= 0 \|\| dstMax <= 0\) return/, '短内容不触发');
assert.match(editor, /addEventListener\('resize'/, 'resize 未重算');
assert.match(css, /\.ed-panes\.sync-on \.pane \{ display: flex/, '双栏并排样式缺失');
ok('④ 单向滚动同步：比例映射/防抖/禁回拉/本地偏好/双栏齐全');

// 读者侧零污染：新类名只在后台文件出现，前台三件套不得含同名钩子
const readerSources = post + index + app + md;
for (const cls of ['ed-sync', 'sync-on', 'field-error', 'site-name-error', 'setSaveBusy', 'ed:sync-scroll']) {
  assert.ok(!readerSources.includes(cls), `读者侧出现后台钩子 ${cls}`);
}
ok('读者侧零污染：post/index/app/md 无后台同名钩子');

console.log(`\nadmin ui: ${pass} passed`);
