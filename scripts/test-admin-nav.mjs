// 后台导航一致性：editor.html 的静态菜单和 admin-ui.js 的服务端菜单必须同一套。
// 不一致时表现为「写作页能看到新入口，统计页看不到」，人工很难发现。
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ADMIN_NAV, ADMIN_GROUPS, BADGE_SOURCE, navCounts, renderAdminNav, renderAdminShell, THEME_BOOT_JS } from '../src/admin-ui.js';
import { renderHealth, renderQueue, webhookCheck, renderNotify, renderTools } from '../src/admin-pages.js';
import { renderDashboard, TODOS } from '../src/dashboard.js';
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

// 2b. 四栏：分组标题、顺序、归属都要对得上；栏数是硬上限，不许开第五栏
assert.deepEqual(
  ADMIN_GROUPS.map((g) => g.text),
  ['概览', '内容', '系统', '工具'],
  '四栏文案与顺序：概览 / 内容 / 系统 / 工具'
);
assert.equal((editor.match(/class="admin-nav-label"/g) || []).length, 4, 'editor.html 应有四个分组标签');
assert.equal((nav.match(/class="admin-nav-label"/g) || []).length, 4, '服务端菜单应有四个分组标签');
assert.equal((editor.match(/class="admin-nav"/g) || []).length, 1, 'editor.html 应只有一个 nav 容器（四段 label 不拆成四个 nav）');
assert.equal((nav.match(/class="admin-nav"/g) || []).length, 1, '服务端菜单应只有一个 nav 容器');
for (const it of ADMIN_NAV) {
  assert.ok(ADMIN_GROUPS.some((g) => g.key === it.group), `${it.key} 的 group「${it.group}」不在四栏里`);
}
/* 归属用「切段」验证，而不是只看 group 字段：渲染时若把某一项放错段，
   字段仍然是旧的，只有切出来的 href 顺序会不对。 */
const segments = (html) => {
  const at = (t) => html.indexOf(`<div class="admin-nav-label">${t}</div>`);
  return ADMIN_GROUPS.map((g, i) => {
    const s = at(g.text);
    assert.ok(s >= 0, `${g.text} 分组标签缺失`);
    const next = ADMIN_GROUPS.slice(i + 1).map((x) => at(x.text)).filter((x) => x > s);
    return { key: g.key, html: html.slice(s, next.length ? next[0] : html.length) };
  });
};
for (const html of [nav, editor]) {
  for (const seg of segments(html)) {
    const want = ADMIN_NAV.filter((it) => it.group === seg.key).map((it) => `id="${it.id}"`);
    const got = [...seg.html.matchAll(/id="nav-[^"]+"/g)].map((m) => m[0]);
    assert.deepEqual(got, want, `「${seg.key}」段里的入口与该组的 group 不符`);
  }
}
ok('四栏：顺序固定、每项归属正确、栏数锁在 4');

// 3. stats.js 不再内联自己的菜单，避免两边漂移
// 只判「用了共享菜单、active 落在 stats」，不锁死参数个数 ——
// 参数完整性是 N-10 的职责。这里写全字面量的话，N-10 想修的那类改动
// （给调用点补 counts）会先被这条挡下来，报的错还指向错误的方向。
assert.match(stats, /renderAdminNav\('stats'[,)]/, 'stats.js 应复用共享菜单');
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
//    editor.html 里只留占位符，脚本由 injectTheme 从同一份 THEME_BOOT 注入 ——
//    比对字符串的事交给 test-theme-contract（TC-09/TC-10），这里只守"占位还在"。
assert.ok(editor.includes('<!--THEMEBOOT-->'), 'editor.html 缺 <!--THEMEBOOT--> 占位（引导脚本会整个消失）');
const bootFeat = ["localStorage.getItem('x_theme')", "setAttribute('data-mode'", 'prefers-color-scheme'];
for (const f of bootFeat) {
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

// 8. 等宽数字现在全站生效（P-096：统计页/对比表的数字不能跳字宽），
//    text-rendering 仍只在后台两页。读者侧 body 必须自己声明，不许靠后台那条漏过来。
//    统计页标题从 serif 收到 sans，和 editor/健康/队列的后台字体语言统一。
assert.match(css, /body\.editor-page,\s*body\.stat-page\s*\{[^}]*font-variant-numeric:\s*tabular-nums lining-nums/, '后台等宽数字规则缺失');
assert.match(css, /body\.editor-page,\s*body\.stat-page\s*\{[^}]*text-rendering:\s*optimizeLegibility/, '后台文字渲染优化缺失');
// 读者侧 body 自带同一份声明（不再是「靠后台那条漏过来」）：
// 数字等宽是全站契约，text-rendering 才是有作用域的后台精修。
const globalBody = css.match(/(?:^|\})\s*body\s*\{[^}]*\}/m)?.[0] || '';
assert.match(globalBody, /font-variant-numeric:\s*tabular-nums lining-nums/, '读者侧 body 缺少全站等宽数字声明');
assert.ok(!/text-rendering/.test(globalBody), 'text-rendering 是后台精修，不该漏到读者侧');
assert.ok(!/<body[^>]*class="[^"]*(editor-page|stat-page)/.test(readFileSync('public/post.html', 'utf8')), '读者侧文章页不得带后台 body class');
assert.match(stats, /h1\{font-family:var\(--sans\)/, '统计页 h1 应统一到 sans');
assert.match(stats, /h2\{font-family:var\(--sans\)/, '统计页章节标题应统一到 sans');
ok('等宽数字全站生效、渲染优化限定后台，统计页标题归一 sans');

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
/* 快捷键墙已经拆了：概览只回答「今天做什么」，入口交给四栏侧栏。
   返回站点仍在 rail 顶部的品牌块上，不占一栏、也不占一格待办。 */
assert.ok(dash.includes('admin-brand') && dash.includes('返回站点'), '工作台应有返回站点入口（品牌块）');
assert.ok(!dash.includes('dash-tile'), '概览不该再摆入口墙，入口只在侧栏');
assert.ok(dash.includes('id="nav-notify"') && dash.includes('id="nav-tools"'), '侧栏缺通知投递 / 工具入口');
assert.ok((dash.match(/href="\/admin\/health"/g) || []).length >= 2, '运行状态卡要给健康页明细链接');
assert.ok(dash.includes('dash-flag-link') && dash.includes('待审'), '待审稿要能直达审核页');
assert.ok(dash.includes('sv-pill bad') && dash.includes('驳回'), '驳回稿要有独立徽标，不能显示成公开');
assert.ok(dash.includes('11-22 09:00'), '最近编辑时间要按北京时间显示（库里 01:00 → 09:00）');
assert.ok(!dash.includes('会话'), '运行状态不能写没查过的会话结论');
// 数据口径：KPI SQL 与公开闸门同口径，否则待审稿会混进「已发布」
// 判据按空白规范化后比对，不锁死换行/缩进 —— 否则给 SQL 加一个换行就会
// 「红，但错的是断言」：上一轮那条 renderAdminNav('stats') 全字面量就是这么坏掉的。
// 注入验证：删掉 queueStat 里的 review_status='approved' → 本条先红。
const dashSrc = readFileSync('src/dashboard.js', 'utf8');
const dashFlat = dashSrc.replace(/\s+/g, ' ');
assert.ok(dashFlat.includes("review_status='approved' AND published_at!='' AND published_at<=datetime('now')"),
  '已发布 KPI 缺审核闸门');
assert.ok(dashFlat.includes("review_status='approved' AND published_at!='' AND published_at>datetime('now')"),
  '待发布 KPI 缺审核闸门');
assert.ok(dashSrc.includes('is_private, hidden, review_status'), '最近编辑查询没带审核态');
/* 待办条「24h 内待发」必须真有窗口。线上实测：20 篇预排最远排到次年二月，
   用全量 → 概览写「今天要做的 20 件」，而那 20 件今天一件都不用动。
   队列全量该留在 KPI 卡片「待发布」里，两个问题不同。 */
assert.ok(dashSrc.includes('queueToday'), '待办条应使用 24h 窗口计数，不是队列全量');
assert.ok(dashFlat.includes("datetime('now','+1 day')"), '24h 窗口缺失：预排会按全量计入「今天要做」');
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

/* 10. 通知投递页：明细 + 只读。这一页的价值是「哪一条、发给谁、平台回了什么」，
      所以判据落在行级信息上，不落在「有没有这张卡片」上。 */
const nt = renderNotify({
  site: { name: 'X' },
  hook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET',
  stats: { ok: 3, fail: 1, skip: 2, none: 4 },
  rows: [
    { id: 1, name: '<b>路人</b>', notify_status: 'ok', notify_note: '', notified_at: '2026-11-26 01:00:00', post_title: '<script>x</script>' },
    { id: 2, name: 'CI', notify_status: 'fail', notify_note: '平台码 93000', notified_at: '2026-11-26 00:30:00', post_title: '普通标题' },
  ],
});
assert.ok(nt.includes('已送达 3 · 失败 1 · 跳过 2 · 未尝试 4'), '通知页四个计数必须与评论页同口径');
assert.ok(nt.includes('sv-pill ok') && nt.includes('sv-pill bad'), '每条投递都要有状态徽章');
assert.ok(nt.includes('平台码 93000'), '失败原因要显示出来（这条是排障的全部意义）');
assert.ok(!nt.includes('SECRET'), '绝不回显 webhook 地址里的 key');
assert.ok(!nt.includes('qyapi.weixin.qq.com'), '只显示平台名，不显示地址');
assert.ok(!nt.includes('<b>路人</b>') && nt.includes('&lt;b&gt;路人'), '评论人必须转义');
assert.ok(!nt.includes('<script>x</script>'), '文章标题必须转义');
/* 只读页的硬边界：不新增可写入口。标签页一旦长出 form/button，就成了没被断言守的写路径。 */
assert.ok(!/<form|<button|type="submit"/.test(nt), '通知页只读：不许出现表单或按钮');
assert.ok(renderNotify({ stats: {}, hook: 'https://hooks.slack.com/x' }).includes('还没有投递记录'), '配了地址但没记录时要明说，不摆空壳');
assert.ok(renderNotify({ stats: {} }).includes('一律记为「跳过」'), '没配地址时要说「跳过是可选」，不能说成欠账');
ok('通知投递页：行级状态、转义、不回显地址、只读');

/* 11. 工具页：只做索引，不提供按钮；命令名必须是真的（改脚本名会在这里红）。 */
const tl = renderTools({ site: { name: 'X' } });
for (const cmd of ['scripts/backup-upload.mjs', 'scripts/backup-drill.mjs', 'scripts/migrate.mjs', 'npm run deploy']) {
  assert.ok(tl.includes(cmd), `工具页缺命令 ${cmd}`);
}
assert.ok(tl.includes('为什么这里没有按钮'), '工具页要解释「为什么不给按钮」，不是空目录');
assert.ok(!/<form|<button|type="submit"/.test(tl), '工具页只读：不许出现表单或按钮');
assert.ok(tl.includes('id="nav-tools"'), '工具页侧栏应高亮');
ok('工具页：命令索引、只读、无按钮');

/* 12. 侧栏徽章：口径、白名单、不排零、名字必须带窗口。
      这一组里 N-07 是本轮唯一把口头纪律变成机械判据的一条 ——
      「不设窗口的计数会变成永久欠账」以前靠人记得，现在谁加谁红。 */

// N-01 每一项的 group 都必须存在于 ADMIN_GROUPS；栏数仍是 4，不许多开
const groupKeys = new Set(ADMIN_GROUPS.map((g) => g.key));
for (const it of ADMIN_NAV) assert.ok(groupKeys.has(it.group), `${it.key} 的 group 不在 ADMIN_GROUPS 里`);
assert.equal(ADMIN_GROUPS.length, 4, '四栏是硬上限，不许开第五栏');
assert.ok(ADMIN_NAV.length >= 9, '导航项被删过头了');
ok('N-01 栏目归属合法、栏数锁 4');

// N-02 每组至少一项：空分组会渲染出一个孤零零的标题
for (const g of ADMIN_GROUPS) {
  assert.ok(ADMIN_NAV.some((it) => it.group === g.key), `分组「${g.text}」下面是空的`);
}
ok('N-02 没有空分组');

// N-03 href 全局唯一：同一项不许挂两栏
const hrefs = ADMIN_NAV.map((it) => it.href);
assert.equal(new Set(hrefs).size, hrefs.length, '有重复 href');
ok('N-03 href 全局唯一');

// N-04 tone 白名单：把配置里的值直接拼进 class 就是注入面，必须走 TONE_CLASS
const ALLOWED_PILL = /^sv-pill( ok| warn| bad)?$/;
const scanPills = (html) => (html.match(/class="sv-pill[^"]*"/g) || []).map((m) => m.slice(7, -1));
const withCounts = renderAdminNav('dash', { pendingComments: 2, notifyFail7d: 1 });
for (const c of scanPills(withCounts)) assert.match(c, ALLOWED_PILL, `徽章 class 逃出白名单：${c}`);
/* 把 tone 临时改成未知值，必须退化成中性徽章而不是拼出 sv-pill weird。
   这不是拿被测输出当期望值 —— 期望值是白名单本身，改的是输入。 */
const keepTone = BADGE_SOURCE.pendingComments.tone;
BADGE_SOURCE.pendingComments.tone = 'weird';
const weird = renderAdminNav('dash', { pendingComments: 2 });
BADGE_SOURCE.pendingComments.tone = keepTone;
for (const c of scanPills(weird)) assert.match(c, ALLOWED_PILL, `未知 tone 没被白名单挡住：${c}`);
assert.ok(weird.includes('class="sv-pill"'), '未知 tone 应退化成中性徽章 sv-pill');
ok('N-04 未知 tone 退化为中性徽章，class 不出白名单');

// N-05 0 / null / 负数 都不渲染：一排 0 会把「有没有事」重新变成阅读任务
const zero = renderAdminNav('dash', { pendingComments: 0, notifyFail7d: 0 });
assert.ok(!scanPills(zero).length, '0 不该渲染徽章');
assert.ok(!scanPills(renderAdminNav('dash', null)).length, 'counts 缺省时不该渲染徽章');
assert.ok(!scanPills(renderAdminNav('dash', { pendingComments: -3, notifyFail7d: NaN })).length, '负数 / NaN 不该渲染徽章');
const two = renderAdminNav('dash', { pendingComments: 2, notifyFail7d: 0 });
assert.ok(scanPills(two).length === 1 && two.includes('>2</span>'), '有值时只渲染有值那一个');
ok('N-05 零值/缺省/负数不渲染，只渲染真实待办');

// N-06 每一项的 badge 名都必须在 BADGE_SOURCE 有定义：不出现无口径的计数
for (const it of ADMIN_NAV) {
  if (!it.badge) continue;
  assert.ok(BADGE_SOURCE[it.badge], `${it.key} 的 badge「${it.badge}」没在 BADGE_SOURCE 登记`);
}
ok('N-06 徽章名全部有口径定义');

// N-07 带窗口的计数，名字里必须带窗口后缀。
// 不加窗口 = 数字永远不归零 = 几天后没人再看待办条（P-078 的第二次）。
for (const [name, src] of Object.entries(BADGE_SOURCE)) {
  if (src.window == null) continue;
  assert.match(name, /\d+[dhw]$/, `「${name}」设了 window 却没在名字里带窗口后缀`);
  assert.ok(name.endsWith(src.window), `「${name}」的后缀和 window=${src.window} 对不上`);
}
assert.ok(Object.keys(BADGE_SOURCE).includes('notifyFail7d'), '通知失败必须带 7d 窗口');
ok('N-07 带窗口的计数，名字里必须带窗口后缀');

/* N-11 [P-081] —— N-07 的通用版。N-07 只守「带窗口的计数，名字要带后缀」，
   管不到另一种更常见的形状：**数字有窗口或没有，但名字和声明一个都没说**。
   待办条那次就是这么错的：`notifyFail` 取自 `nav.notifyFail7d`（7 天窗口），
   标签写的是「通知失败」——读者会当成历史累计，于是每天看见同一个数字也不动手。

   规则双出口，每一条计数必须落在其中一个，`window` 键不许缺：
   - `window` 非 null → 名字必须含该字面量（自证，不用回去翻查询）
   - `window` 为 null → 必须有 `total` 说明这是什么全量（≥6 字，只防「忘了写」，
     挡不住敷衍），且名字不得含窗口字样（自相矛盾）

   「名字」取哪个字段按渲染位置定：徽章显示的是链接上的数字，它的名字是 key
   （`notifyFail7d` 里的人能看见日期感）；待办条显示的是 label，名字就是 label。
   混用一个字段会让 badge 那条恒真（它的 label 是中文自然语言：「近 7 天通知失败」）。 */
const countSources = [
  ...TODOS.map((t) => ({ where: '待办条', name: t.key, checkText: t.label, label: t.label, ...t })),
  ...Object.entries(BADGE_SOURCE).map(([k, v]) => ({ where: '侧栏徽章', name: k, checkText: k, ...v })),
];
assert.ok(TODOS.length >= 4, '待办条项被删过头了');
assert.ok(Object.keys(BADGE_SOURCE).length >= 2, '徽章源被删过头了');
/* 窗口的「可接受写法」是张显式的表，不是一个模糊的「含数字就算」。
   中文界面写「7 天」比写「7d」自然，但两者都必须是这个窗口本身 ——
   表外的新窗口按字面量兜底，谁加窗口谁负责同时加一行。 */
const WINDOW_WORDS = { '24h': ['24h', '24 小时'], '7d': ['7d', '7 天'], '30d': ['30d', '30 天'] };
const windowedBy = new Map();
for (const c of countSources) {
  assert.ok('window' in c, `${c.where}「${c.name}」没有口径声明（window 键缺失）`);
  if (c.window != null) {
    windowedBy.set(c.where, (windowedBy.get(c.where) || 0) + 1);
    const words = WINDOW_WORDS[c.window] || [c.window];
    assert.ok(
      words.some((w) => String(c.checkText).includes(w)),
      `${c.where}「${c.name}」声明 window=${c.window}，名字「${c.checkText}」里没有这个窗口（可写 ${words.join(' / ')}）`
    );
  } else {
    assert.ok(
      typeof c.total === 'string' && c.total.length >= 6,
      `${c.where}「${c.name}」是全量计数，必须用 total 写明它是什么全量（否则它会悄悄混进「今天做什么」）`
    );
    assert.ok(
      !/\d+\s*[dhw]/.test(c.label),
      `${c.where}「${c.name}」声明全量，名字「${c.label}」里却带窗口字样`
    );
  }
}
/* 空转防护按来源分别查，不合并成一个总数：
   待办条全变成全量、而徽章仍有一条带窗口时，合并计数照样 ≥1，
   待办条那半的窗口检查就成了空转 —— 这正是「空集恒真」的变体，
   只是空集被另一半掩盖了。 */
const wheres = [...new Set(countSources.map((c) => c.where))];
assert.ok(wheres.length >= 2, '计数来源只剩一处，分来源的空转防护失去意义');
for (const w of wheres) {
  assert.ok((windowedBy.get(w) || 0) >= 1, `${w}里一条带窗口的计数都没有 —— 这一侧的窗口检查成了空集`);
}
ok('N-11 每个计数都声明口径（窗口 / 全量说明），名字与声明一致');

// N-08 源码结构不变量：侧栏容器只能由 renderAdminNav 产出。
// 用「除 admin-ui.js 外命中 0 次」+「admin-ui.js 命中恰好 1 次」两个独立计数，
// 单看前者会在 renderAdminNav 被删掉时变成空集恒真（假绿形态①）。
const navLit = /<nav class="admin-nav"/g;
let outside = 0;
for (const f of readdirSync('src')) {
  if (!f.endsWith('.js') || f === 'admin-ui.js') continue;
  outside += (readFileSync(`src/${f}`, 'utf8').match(navLit) || []).length;
}
const inside = (readFileSync('src/admin-ui.js', 'utf8').match(navLit) || []).length;
assert.equal(inside, 1, 'renderAdminNav 里应恰好产出一处 <nav class="admin-nav"');
assert.equal(outside, 0, '有页面手写了侧栏容器，应改用 renderAdminNav()');
const editorNav = (editor.match(navLit) || []).length;
assert.equal(editorNav, 1, 'editor.html 的静态侧栏应恰好一处');
ok('N-08 侧栏容器只由 renderAdminNav 产出');

// N-09 每个页面传的 active 都必须是 ADMIN_NAV 里真实存在的 key。
// 这条抓的是一个真发生过的 bug：评论页写 active:'comments'，而 key 是 'cmts'
// —— 侧栏在评论页永远不高亮，肉眼几乎看不出来（那页本来就在评论管理里）。
const navKeys = new Set(ADMIN_NAV.map((it) => it.key));
const UNLIT = new Set(['history']); // 版本历史是子页，菜单里没有对应项
const actives = new Set();
for (const f of readdirSync('src')) {
  if (!f.endsWith('.js')) continue;
  for (const m of readFileSync(`src/${f}`, 'utf8').matchAll(/\bactive: '([a-z]+)'/g)) actives.add(m[1]);
}
assert.ok(actives.size >= 8, `只扫到 ${actives.size} 个 active 值，判据的输入可疑（空集恒真防护）`);
for (const a of actives) {
  assert.ok(navKeys.has(a) || UNLIT.has(a), `active:'${a}' 在 ADMIN_NAV 里没有对应 key，那一页侧栏永远不会高亮`);
}
assert.ok(renderAdminNav('cmts').includes('class="on" aria-current="page"'), '评论页高亮必须落在 cmts 上');
ok('N-09 active 值全部对得上导航 key');

// N-10 每个 renderAdminNav 调用点都必须传 counts。
// 抓的是刚修的一处静默降级：访问统计页只写了 renderAdminNav('stats')，
// 于是那一页侧栏永远没有徽章，不报错、不 500、肉眼要跨页对比才看得出来。
// 判据是参数串里必须出现 nav 或 counts；定义行（counts = null）同样通过。
const CALL = /renderAdminNav\(([^)]*)\)/g;
const callSites = [];
for (const f of readdirSync('src')) {
  if (!f.endsWith('.js')) continue;
  for (const m of readFileSync(`src/${f}`, 'utf8').matchAll(CALL)) {
    callSites.push({ file: f, args: m[1].trim() });
  }
}
// 空集恒真防护：定义 1 处 + 调用点至少 2 处（页面外壳与 stats 各自一条路径）
assert.ok(callSites.length >= 3, `只扫到 ${callSites.length} 处 renderAdminNav，判据的输入可疑`);
for (const c of callSites) {
  assert.match(
    c.args,
    /\b(nav|counts)\b/,
    `${c.file}: renderAdminNav(${c.args}) 没传 counts，那一页侧栏会静默失去全部徽章`
  );
}
ok('N-10 renderAdminNav 调用点全部传入 counts');

console.log(`\nadmin nav: ${pass} passed`);
