// 后台导航一致性：editor.html 的静态菜单和 admin-ui.js 的服务端菜单必须同一套。
// 不一致时表现为「写作页能看到新入口，统计页看不到」，人工很难发现。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ADMIN_NAV, renderAdminNav, renderAdminShell, THEME_BOOT_JS } from '../src/admin-ui.js';
import { renderHealth, renderQueue, webhookCheck } from '../src/admin-pages.js';
import { renderDashboard } from '../src/dashboard.js';
import { renderReview } from '../src/review.js';
import { liveSql, timeGateSql } from '../src/api.js';

const editor = readFileSync('public/editor.html', 'utf8');
const stats = readFileSync('src/stats.js', 'utf8');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// 1. 每一项的 id / href / 文案在 editor.html 里都存在
for (const it of ADMIN_NAV) {
  assert.ok(editor.includes(`id="${it.id}"`), `editor.html 缺少 ${it.id}`);
  assert.ok(editor.includes(`href="${it.href}"`), `editor.html 缺少 ${it.href}`);
  assert.ok(new RegExp(`<span>${it.text}</span>`).test(editor), `editor.html 缺少文案 ${it.text}`);
}
ok('editor.html 静态菜单与共享导航逐项一致');

// 2. 服务端菜单渲染包含同一批 href，且当前项带 aria-current
const nav = renderAdminNav('health');
for (const it of ADMIN_NAV) assert.ok(nav.includes(`href="${it.href}"`), `服务端菜单缺少 ${it.href}`);
assert.match(nav, /href="\/admin\/health"[^>]*aria-current|class="on" aria-current="page" href="\/admin\/health"/);
ok('服务端菜单渲染同一批入口，当前项正确高亮');

// 2b. 单一分组平铺：只允许一个 admin-nav-label，不再切成多段
assert.equal((editor.match(/class="admin-nav-label"/g) || []).length, 1, 'editor.html 应只有一个分组标签');
assert.equal((nav.match(/class="admin-nav-label"/g) || []).length, 1, '服务端菜单应只有一个分组标签');
assert.equal((editor.match(/class="admin-nav"/g) || []).length, 1, 'editor.html 应只有一个 nav 容器');
ok('侧栏单一分组平铺，无多段切分');

// 3. stats.js 不再内联自己的菜单，避免两边漂移
assert.ok(stats.includes('renderAdminNav(\'stats\')'), 'stats.js 应复用共享菜单');
assert.ok(!stats.includes('<span>返回首页</span>'), 'stats.js 仍有旧的内联菜单');
ok('统计页复用共享菜单');

// 4. 保留 ?panel= URL，服务端页（统计/健康/队列）点菜单可直接跳到对应视图
for (const p of ['posts', 'checks', 'series', 'site']) {
  assert.ok(editor.includes(`href="/editor?panel=${p}"`), `缺少 ?panel=${p} 入口`);
}
ok('四个 ?panel= 入口 URL 保留，跨页跳转可直达视图');

// 4b. 五个主视图：点菜单整块切换，每个都像写作页一样独占主内容区
const VIEWS = { write: 'view-write', posts: 'view-posts', checks: 'view-checks', series: 'view-series', site: 'site-box' };
for (const [v, id] of Object.entries(VIEWS)) {
  assert.ok(editor.includes(`data-view="${v}" id="${id}"`), `缺少 ${v} 视图容器`);
  assert.ok(editor.includes(`data-view="${v}" id="nav-${v}"`), `缺少 ${v} 导航入口`);
}
assert.ok(editor.includes('function initViews()'), '缺少视图切换逻辑');
assert.ok(!editor.includes('initSidePanel'), '不应保留旧的滚动定位逻辑');
const at = (needle) => editor.indexOf(needle);
assert.ok(at('id="view-posts"') < at('id="cat-list"') && at('id="cat-list"') < at('id="view-checks"'), '文章列表应在独立视图内');
assert.ok(at('id="view-checks"') < at('id="checks"') && at('id="checks"') < at('id="view-series"'), '自检应在独立视图内');
assert.ok(at('id="view-series"') < at('id="series-list"') && at('id="series-list"') < at('id="site-box"'), '系列应在独立视图内');
assert.ok(at('id="site-box"') < at('id="site-name"'), '站点设置应在独立视图内');
ok('五个主视图与导航一一对应，点菜单整块切换');

// 4c. 不再有抽屉/遮罩，视图切换样式就位
const css = readFileSync('public/style.css', 'utf8');
assert.ok(css.includes('.side-toggle, .side-mask { display: none !important; }'), '抽屉按钮/遮罩必须隐藏');
assert.ok(css.includes('.admin-main > .view.active { display: flex; }'), '视图切换 CSS 缺失');
// 文章页的系列目录样式必须限定在 .series 里，否则后台的系列胶囊会被拉成整行
assert.ok(css.includes('.series .series-list'), '系列目录样式应限定在文章页 .series 内');
// 移动端菜单展开只保留一条规则（~ 容错更强）；两条 +/~ 并存是冗余
assert.equal((css.match(/\.nav-cb:checked\s*[+~]\s*\.admin-nav-wrap/g) || []).length, 1, '移动端菜单展开规则重复');
assert.ok(css.includes('.nav-cb:checked ~ .admin-nav-wrap'), '应保留 ~ 兄弟选择器');
// 未保存的新文章点预览：占位 # 要被拦截，不能新标签打开编辑器副本
assert.ok(editor.includes("$('btn-view').addEventListener('click'"), '预览按钮缺点击拦截');
assert.ok(editor.includes("$('btn-view').getAttribute('href') || '') === '#'"), '拦截条件应检查 href=#');
assert.ok(editor.includes('先保存文章，再点预览'), '缺预览拦截提示');
ok('无抽屉/遮罩，视图切换样式就位；预览占位拦截 + 菜单规则去重');

// 4d. 视图头：标题只由 admin-head 承担，说明 + 元信息各就各位
assert.ok(editor.includes('id="view-desc"'), '缺少视图说明位');
assert.ok(editor.includes("$('view-desc')"), '视图说明没有随视图切换更新');
assert.ok(editor.includes('id="post-count"'), '文章列表缺少篇数');
assert.ok(editor.includes('ci-sub'), '文章行缺少日期/栏目副标题');
assert.ok(editor.includes('id="check-bar"'), '自检缺少进度条');
assert.ok(/check-bar'\)[\s\S]{0,80}style\.width/.test(editor), '进度条没有接线');
assert.equal((editor.match(/id="view-title"/g) || []).length, 1, '标题只允许有一个');
assert.ok(!editor.includes('class="admin-eyebrow"'), '后台头不应再压一层小标签');
ok('视图头只有一层标题 + 说明，进度/计数等元信息就位');

// 5. 新页渲染：任何输入都不抛，且转义 HTML
const hp = renderHealth({
  site: { name: '<img>', theme: 'ink', mode: 'dark' },
  checks: [{ label: '<script>', value: 'ok', state: 'ok', note: 'x' }],
  friend: { up: 1, down: 0, checkedAt: '2026-01-01' },
  pc: { hit: 2 },
});
assert.ok(hp.includes('健康检查'));
assert.ok(hp.includes('&lt;script&gt;'), '用户输入的标签必须转义为实体');
assert.ok(hp.includes('&lt;img&gt;'), '站名必须转义');

// 5b. 健康总览：一眼看整体，且分级/计数跟运行状态一致
const badHealth = renderHealth({
  checks: [
    { label: 'D1', value: '正常', state: 'ok' },
    { label: '会话密钥', value: '缺失', state: 'bad' },
  ],
});
assert.ok(badHealth.includes('sv-summary bad'), '有故障时必须按 bad 呈现总览');
assert.ok(
  badHealth.includes('有故障需要处理') &&
    badHealth.includes('<b class="n-ok">1</b> 通过') &&
    badHealth.includes('<b class="n-bad">1</b> 故障'),
  '总览文案/计数不对'
);
const allOk = renderHealth({ checks: [{ label: 'D1', value: '正常', state: 'ok' }] });
assert.ok(allOk.includes('sv-summary ok') && allOk.includes('全部正常'), '全通过应是绿');
const half = renderHealth({
  checks: [
    { label: 'a', value: 'ok', state: 'ok' },
    { label: 'b', value: '半配', state: 'warn' },
  ],
});
assert.ok(half.includes('sv-summary warn') && half.includes('部分项需关注'), '有半配无故障应是黄');
// 友链 0 值不该带告警色（旧代码把「探测失败 0」也标红）
const zeroFriend = renderHealth({ checks: [], friend: { up: 0, degraded: 0, down: 0, checkedAt: '' } });
assert.ok(!zeroFriend.includes('探测失败</span><span class="kv-v bad"'), '探测失败为 0 不应标红');
assert.ok(!zeroFriend.includes('有响应但状态异常</span><span class="kv-v warn"'), '状态异常为 0 不应标黄');
assert.ok(zeroFriend.includes('探测失败</span><span class="kv-v ">'), '零值应保持无色');
ok('健康总览分级/计数正确，友链零值不再误标色');

// 5c. 评论通知是 Secret：网页不可改，但必须给出平台 + 修改命令，且不回显地址
const hookOn = webhookCheck('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET123');
assert.ok(hookOn.value.includes('企业微信'), '应识别平台');
assert.ok(hookOn.note.includes('npm run setup:webhook'), '应给出修改命令');
assert.ok(!hookOn.note.includes('SECRET123') && !hookOn.value.includes('SECRET123'), '绝不回显 webhook 地址');
assert.ok(hookOn.note.includes('网页不可改'), '应说明 Secret 不能在网页改');
const hookOff = webhookCheck('');
assert.ok(hookOff.value === '未配置' && hookOff.note.includes('setup:webhook'), '未配置也要给开启命令');
ok('评论通知显示平台/修改命令，不回显 Secret');

const qp = renderQueue({ site: { name: 'X' }, rows: [{ id: 1, title: '<b>hi</b>', published_at: '2027-03-03 01:00:00' }] });
assert.ok(qp.includes('定时队列'));
assert.ok(!qp.includes('<b>hi</b>'), '文章标题必须转义');
ok('健康检查 / 定时队列渲染正确且转义');

// 6. 服务端页与 editor 视图同构：统一样式口径，别再各写一套
const pages = readFileSync('src/admin-pages.js', 'utf8');
const statShell = renderAdminShell({ title: 'X', body: '' });
assert.ok(statShell.includes('class="stat-page"'), '服务端页应复用 stat-page 外壳');
for (const [name, html] of [['健康检查', hp], ['定时队列', qp]]) {
  assert.ok(html.includes('class="wrap-s"'), `${name} 缺滚动容器`);
  assert.ok(html.includes('admin-view-card'), `${name} 未用统一视图卡`);
  assert.ok(html.includes('admin-view-head'), `${name} 未用统一视图头`);
  assert.ok(html.includes('admin-view-body'), `${name} 未用统一视图体`);
  assert.ok(html.includes('form-sec'), `${name} 未用统一分组标题`);
  assert.ok(!html.includes('<style'), `${name} 仍有内联样式`);
  assert.ok(!/<h2[\s>]/.test(html), `${name} 仍用旧 h2 章节标题`);
}
assert.ok(!pages.includes('const PAGE_STYLE'), '内联 PAGE_STYLE 应已删除');
assert.ok(!/#1a7f37|#b7791f|#c0392b/.test(pages), '状态色不应硬编码，须走 CSS 变量');
for (const cls of ['admin-view-card', 'kv-row', 'sv-pill', 'sv-table', 'form-sec']) {
  assert.ok(css.includes(`.stat-page .${cls}`) || css.includes(`.${cls}`), `style.css 缺 .${cls} 口径`);
}
assert.match(css, /\.stat-page \.sv-pill\.ok[^}]*var\(--green\)/, '绿灯色未走主题变量');
assert.match(css, /\.stat-page \.sv-pill\.bad[^}]*var\(--red\)/, '红灯色未走主题变量');
ok('健康检查/定时队列与 editor 视图同构，样式进 style.css 且状态色走变量');

// 7. 主题引导：服务端三页必须和 editor 一样在首帧前读 localStorage 偏好，
//    否则用户选的深色到这三页就回落系统浅色（表现为「别的页黑、这三页白」）。
const bootFeat = ["localStorage.getItem('x_theme')", "setAttribute('data-mode'", 'prefers-color-scheme'];
for (const f of bootFeat) {
  assert.ok(editor.includes(f), `editor.html 引导脚本缺 ${f}`);
  assert.ok(THEME_BOOT_JS.includes(f), `服务端引导脚本缺 ${f}`);
}
assert.ok(stats.includes('themeBoot(site)'), 'stats.js 未接入主题引导');
for (const [name, html] of [['健康检查', hp], ['定时队列', qp]]) {
  assert.ok(html.includes('window.__THEME_DEFAULT__'), `${name} 缺主题默认值注入`);
  assert.ok(html.includes("localStorage.getItem('x_theme')"), `${name} 缺主题引导脚本`);
}
assert.ok(hp.includes('"theme":"ink"') && hp.includes('"mode":"dark"'), '主题默认值应取自站点设置');
// 默认值必须安全序列化，站点主题名不能闭合 script 造成注入
const evilShell = renderAdminShell({ title: 'X', body: '', site: { theme: '</script><script>alert(1)' } });
assert.ok(!evilShell.includes('</script><script>alert'), '主题默认值必须转义，不能闭合 script');
ok('服务端三页接入主题防闪引导，与 editor 同源同构且安全序列化');

// 8. 后台字体精修：等宽数字 + 渲染优化只在后台两页生效，读者侧 body 不得被污染。
//    统计页标题从 serif 收到 sans，和 editor/健康/队列的后台字体语言统一。
assert.match(css, /body\.editor-page,\s*body\.stat-page\s*\{[^}]*font-variant-numeric:\s*tabular-nums lining-nums/, '后台等宽数字规则缺失');
assert.match(css, /body\.editor-page,\s*body\.stat-page\s*\{[^}]*text-rendering:\s*optimizeLegibility/, '后台文字渲染优化缺失');
// 作用域边界：全局 body 规则（读者侧）不得直接挂等宽数字
const globalBody = css.match(/(?:^|\})\s*body\s*\{[^}]*\}/m)?.[0] || '';
assert.ok(!/font-variant-numeric/.test(globalBody), '读者侧全局 body 不得被后台字体规则污染');
assert.ok(!/<body[^>]*class="[^"]*(editor-page|stat-page)/.test(readFileSync('public/post.html', 'utf8')), '读者侧文章页不得带后台 body class');
assert.match(stats, /h1\{font-family:var\(--sans\)/, '统计页 h1 应统一到 sans');
assert.match(stats, /h2\{font-family:var\(--sans\)/, '统计页章节标题应统一到 sans');
ok('后台字体精修：等宽数字/渲染优化限定后台，统计页标题归一 sans，读者侧零影响');

// 9. 工作台：外壳/快捷入口/KPI/运行状态，转义与缺值都要稳
const dash = renderDashboard({
  site: { name: '<img>' },
  user: { login: '<script>' },
  kpi: { posts: 12, queue: 2, pv: 88, uv: 31, friendsUp: 3, friendsTotal: 4 },
  recent: [
    { id: 1, title: '<b>标题</b>', updated_at: '2026-11-22', is_private: 0 },
    { id: 2, title: '待审稿', updated_at: '2026-11-22 01:00:00', review_status: 'pending' },
    { id: 3, title: '驳回稿', updated_at: '2026-11-21 01:00:00', review_status: 'rejected' },
  ],
  sys: { d1: 'bad', friendDown: 1, today: '2026-11-22' },
});
assert.ok(dash.includes('class="stat-page"'), '工作台应复用 stat-page 外壳');
assert.ok(dash.includes('id="nav-dash"') && /id="nav-dash"[^>]*aria-current|class="on"[^>]*id="nav-dash"/.test(dash), '工作台侧栏项应高亮');
assert.ok(dash.includes('href="/admin/review"'), '工作台缺投稿审核入口');
assert.ok(dash.includes('href="/admin/stats"'), '工作台缺统计入口');
assert.ok(dash.includes('href="/admin/health"'), '工作台缺健康检查入口');
assert.ok(dash.includes('href="/admin/queue"'), '工作台缺定时队列入口');
assert.ok(dash.includes('href="/editor?panel=posts"'), '工作台缺文章列表入口');
assert.ok(!dash.includes('<img>') && dash.includes('&lt;img&gt;'), '站名必须转义');
assert.ok(dash.includes('&lt;script&gt;') && !dash.includes('管理员 <script>'), '用户名必须转义');
assert.ok(!dash.includes('<b>标题</b>'), '文章标题必须转义');
assert.ok(dash.includes('sv-summary bad') && dash.includes('有故障需要处理'), 'D1 故障必须按 bad 呈现');
assert.ok(!dash.includes('<style'), '工作台不应内联样式');
assert.ok(dash.includes('dash-home') && dash.includes('回到前台首页'), '工作台应有返回站点入口');
assert.ok((dash.match(/href="\/admin\/health"/g) || []).length >= 2, '运行状态卡要给健康页明细链接');
assert.ok(dash.includes('dash-flag-link') && dash.includes('待审'), '待审稿要能直达审核页');
assert.ok(dash.includes('sv-pill bad') && dash.includes('驳回'), '驳回稿要有独立徽标，不能显示成公开');
assert.ok(dash.includes('11-22 09:00'), '最近编辑时间要按北京时间显示（库里 01:00 → 09:00）');
assert.ok(!dash.includes('会话'), '运行状态不能写没查过的会话结论');
// 数据口径：KPI SQL 与公开闸门同口径，否则待审稿会混进「已发布」
const dashSrc = readFileSync('src/dashboard.js', 'utf8');
assert.ok(dashSrc.includes("review_status='approved' AND published_at!='' AND published_at<=datetime('now')"),
  '已发布 KPI 缺审核闸门');
assert.ok(dashSrc.includes("review_status='approved' AND published_at!='' AND published_at>datetime('now')"),
  '待发布 KPI 缺审核闸门');
assert.ok(dashSrc.includes('is_private, hidden, review_status'), '最近编辑查询没带审核态');
// 缺值：所有 KPI 给「—」，不出现 undefined / NaN
const dashEmpty = renderDashboard({});
assert.ok(!/undefined|NaN/.test(dashEmpty), '缺值不应渲染成 undefined/NaN');
assert.ok((dashEmpty.match(/dash-kpi-v">—/g) || []).length >= 4, 'KPI 缺值应显示 —');
assert.ok(dashEmpty.includes('还没有文章'), '空文章应有引导文案');
ok('工作台渲染：外壳/入口/转义/缺值/状态分级正确');

// 10. 审核闸门：公开 SQL 必须挡未过审，管理用时间闸门不挡
assert.ok(liveSql('p').includes("review_status = 'approved'"), '公开查询缺审核闸门');
assert.ok(!timeGateSql('p').includes('review_status'), '时间闸门不该含审核态（待审队列要用）');
assert.ok(timeGateSql('posts').includes("datetime('now')"), '时间闸门应保留发布时间判断');
ok('审核闸门：liveSql 挡未过审，timeGateSql 专供管理视图');

// 11. 审核页渲染：转义 / 空态 / 结构
const rv = renderReview({
  site: { name: 'X' },
  rows: [{ id: 7, slug: '<b>x</b>', title: '<script>t</script>', author: '<img>', updated_at: '2026-11-22 10:30:00', excerpt: '&raw' }],
});
assert.ok(rv.includes('class="stat-page"'), '审核页复用后台外壳');
assert.ok(rv.includes('data-act="approve"') && rv.includes('data-act="reject"'), '缺通过/驳回按钮');
assert.ok(!rv.includes('<script>t</script>') && rv.includes('&lt;script&gt;'), '标题必须转义');
assert.ok(!rv.includes('<img>') && rv.includes('&lt;img&gt;'), '作者名必须转义');
assert.ok(rv.includes('&amp;raw'), '摘要必须转义');
assert.ok(rv.includes('id="nav-review"'), '审核页侧栏应高亮');
assert.ok(renderReview({}).includes('没有待审文章'), '空队列应有引导');
ok('审核页渲染：转义/按钮/空态/高亮正确');

console.log(`\nadmin nav: ${pass} passed`);
