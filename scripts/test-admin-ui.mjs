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
// Monaco 就绪后编辑器不再是 textarea：滚动量走 metrics() 统一取，再按比例写预览
assert.match(editor, /previewEl\.scrollTop = \(src\.top \/ src\.max\) \* dstMax/, '未按滚动比例映射');
assert.match(editor, /monaco\.onDidScrollChange/, 'Monaco 的滚动没接上同步');
assert.match(editor, /inputEl\.addEventListener\('scroll'/, '只应监听编辑区');
assert.ok(!/previewEl\.addEventListener\('scroll'/.test(editor), '禁止回拉预览造成死循环');
assert.match(editor, /setTimeout\(sync, 80\)/, '缺 80ms 防抖');
assert.match(editor, /if \(src\.max <= 0 \|\| dstMax <= 0\) return/, '短内容不触发');
assert.match(editor, /addEventListener\('resize'/, 'resize 未重算');
assert.match(css, /\.ed-panes\.sync-on \.pane \{ display: flex/, '双栏并排样式缺失');
ok('④ 单向滚动同步：比例映射/防抖/禁回拉/本地偏好/双栏齐全');

// 读者侧零污染：新类名只在后台文件出现，前台三件套不得含同名钩子
const readerSources = post + index + app + md;
for (const cls of ['ed-sync', 'sync-on', 'field-error', 'site-name-error', 'setSaveBusy', 'ed:sync-scroll']) {
  assert.ok(!readerSources.includes(cls), `读者侧出现后台钩子 ${cls}`);
}
ok('读者侧零污染：post/index/app/md 无后台同名钩子');

// ===== 第二批：标签去重计数 / 占位文案 / 窄屏导航过渡 / 空状态文案 =====
// ⑤ 标签去重计数：分母=落库上限 8（taxonomy normalizeTags limit=8），超建议 4 给弱提示、不阻断
assert.match(editor, /const dedupeTags = \(md\) => \[\.\.\.new Set\(extractTags\(md\)\.map\(\(t\) => t\.toLowerCase\(\)\)\)\]/,
  '缺 dedupeTags 去重（小写后去重，防 #Worker/#worker 撞车）');
assert.ok((editor.match(/dedupeTags\(md\)/g) || []).length >= 2, '标签预览与发布自检都应用同一去重口径');
assert.ok(!/const tags = extractTags\(md\)\.map/.test(editor), '不应残留未去重的旧直接赋值');
assert.match(editor, /id="tag-count"/, '标签计数槽位缺失');
assert.match(editor, /const TAG_STORE_MAX = 8/, '分母应为服务端落库上限 8');
assert.match(editor, /const TAG_SUGGEST = 4/, '写作建议阈值应为 4');
assert.match(editor, /\$\{tags\.length\}\/\$\{TAG_STORE_MAX\}/, '计数应为 N/8 格式');
assert.match(editor, /classList\.toggle\('warn', tags\.length > TAG_SUGGEST\)/, '超过建议应标 warn 弱提示');
assert.match(css, /\.ed-tag-count\.warn \{[^}]*var\(--red\)/, '弱提示色未走 --red');
assert.ok(!/\.ed-tag-count\.over/.test(css), '不应残留旧的 .over 强告警样式');
ok('⑤ 标签计数：分母 8/建议 4/warn 弱提示，不阻断');

// ⑥ 占位文案：标题/站点名标必填，摘要/别名/系列/站点描述标可选，不改校验
assert.ok(editor.includes('placeholder="标题（必填）"'), '标题应标必填');
assert.ok(editor.includes('placeholder="必填 · 例如 Exia Blog"'), '站点名应标必填');
for (const p of ['可选，用于RSS和预览', '可选 · 自动生成，建议英文，不可中文', '可选 · 如 自建博客实录', '可选 · 一句话介绍这个站点']) {
  assert.ok(editor.includes(`placeholder="${p}"`), `缺可选标注占位：${p}`);
}
ok('⑥ 占位文案：标题/站点名必填，摘要/别名/系列/站点描述可选');

// ⑦ 窄屏后台导航淡入：absolute + visibility/opacity/translateY，不碰读者侧 nav.top
assert.match(css, /\.admin-nav-wrap \{[\s\S]{0,400}?opacity: 0; visibility: hidden; transform: translateY\(-6px\)/,
  '窄屏后台导航隐藏态缺 opacity/visibility/translateY');
assert.match(css, /\.nav-cb:checked ~ \.admin-nav-wrap \{[\s\S]{0,120}?opacity: 1; visibility: visible/,
  '展开态未恢复可见');
assert.match(css, /\.admin-nav-wrap \{[^}]*transition: opacity \.15s/, '缺 0.15s 过渡');
assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,120}?\.admin-nav-wrap \{ transition: none/.test(css),
  '缺 reduced-motion 降级');
assert.ok(!/nav\.top[\s\S]{0,200}?translateY\(-6px\)/.test(css), '不应改动读者侧 nav.top 抽屉');
ok('⑦ 窄屏后台导航淡入：visibility/opacity/位移过渡 + reduced-motion，读者侧未碰');

// ⑧ 空状态文案：报告指定三处文案，无图片
assert.ok(editor.includes('empty-hint') && editor.includes('还没有文章——从上方标题开始写第一篇'), '文章列表空态文案未改');
assert.match(css, /\.cat-list > \.empty-hint \{[^}]*var\(--muted\)/, '空态样式未限定 .cat-list 或未走主题变量');
assert.ok(!/<img|background-image|url\(/.test(editor.match(/<span class="empty-hint">[\s\S]*?<\/span>/)?.[0] || ''), '空态不应引入图片');
assert.ok(stats.includes('还没有记录，有访客访问后会显示在这里'), '统计表空态文案未改');
assert.ok(stats.includes('近 14 天还没有访问记录'), '趋势图空态文案未改');
ok('⑧ 空状态文案：三处友好引导，无图片');

// 读者侧零污染（第二批新类名）
for (const cls of ['ed-tag-count', 'empty-hint', 'dedupeTags', 'TAG_STORE_MAX', 'TAG_SUGGEST']) {
  assert.ok(!readerSources.includes(cls), `读者侧出现后台钩子 ${cls}`);
}
ok('第二批读者侧零污染：新类名不进 post/index/app/md');

console.log(`\nadmin ui: ${pass} passed`);
