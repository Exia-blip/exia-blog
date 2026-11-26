// 后台原子层判据：pill / fresh / emptyState / todoBar / toCN。
// 这层是「状态可见」的地基——它错了，页面上的颜色和数字会一起骗人，
// 而且骗得很像正常（未来时间显示「刚刚」就是这种）。
// 每条断言都做过注入验证：改坏实现必须红，红不出来的断言等于没写。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pill, fresh, emptyState, todoBar, toCN, esc } from '../src/admin-ui.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    fail++;
  }
};

/* 相对时间要靠「现在」构造，不能写死日期——写死的话判据会在几小时后自己变红/变绿。 */
const ago = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
const text = (html) => html.replace(/<[^>]+>/g, '').trim();

console.log('\n后台原子层');

t('A-01 pill 四档各自落到对应 class', () => {
  assert.match(pill('ok', 'x'), /class="sv-pill ok"/);
  assert.match(pill('warn', 'x'), /class="sv-pill warn"/);
  assert.match(pill('bad', 'x'), /class="sv-pill bad"/);
  /* muted 不是第四个 class，而是「没有修饰类的 sv-pill」——写死 class="sv-pill muted"
     会得到一个 CSS 里不存在的选择器，颜色静默退回默认。 */
  assert.match(pill('muted', 'x'), /class="sv-pill"/);
  assert.doesNotMatch(pill('muted', 'x'), /muted/);
});

t('A-02 pill 的 kind 走白名单，未知值不落进 class 属性', () => {
  /* 这条是注入面：kind 若直接拼进 class，一个 '" onmouseover="…' 就能出属性。
     白名单之后它只会得到中性 pill。 */
  const evil = pill('" onmouseover="alert(1)', 'x');
  assert.doesNotMatch(evil, /onmouseover/);
  assert.match(evil, /class="sv-pill"/);
});

t('A-03 pill 的正文与 title 都转义', () => {
  const out = pill('ok', '<img src=x>', '"><script>');
  assert.doesNotMatch(out, /<img|<script/);
  assert.match(out, /&lt;img src=x&gt;/);
});

t('A-04 fresh：空值说「未运行」，不能谎称「刚刚」', () => {
  /* 从没跑过和刚跑完是两件相反的事。并成一句「刚刚」等于把「没配置」
     显示成「一切正常」，这是这个仓库最不能犯的错。 */
  for (const v of ['', null, undefined]) {
    const out = fresh(v);
    assert.match(text(out), /未运行/);
    assert.doesNotMatch(text(out), /刚刚/);
  }
});

t('A-05 fresh：超期换成 warn 徽章并明说已过期', () => {
  const out = fresh(ago(10 * 3600e3), { staleMs: 45 * 60e3 });
  assert.match(out, /sv-pill warn/);
  assert.match(text(out), /已过期/);
});

t('A-06 fresh：未超期是灰字相对时间，不上色', () => {
  const out = fresh(ago(5 * 60e3), { staleMs: 45 * 60e3 });
  assert.match(out, /class="sv-time"/);
  assert.doesNotMatch(out, /sv-pill/);
  assert.match(text(out), /分钟前/);
});

t('A-07 [P-077] fresh：未来时刻报「时间异常」，不许渲染成「刚刚」', () => {
  /* 负 age 曾经因为 `mins < 1` 而命中「刚刚」——一个时区写错的数据
     会显示成最健康的状态，线上根本看不出来。修掉之后这里必须红得出来。 */
  const out = fresh(ago(-4 * 3600e3), { staleMs: 45 * 60e3 });
  assert.match(out, /sv-pill warn/);
  assert.match(text(out), /时间异常/);
  assert.doesNotMatch(text(out), /刚刚/);
});

t('A-08 fresh：Infinity 永不过期（一次性历史事件不能标已过期）', () => {
  const out = fresh(ago(60 * 24 * 3600e3), { staleMs: Infinity });
  assert.doesNotMatch(text(out), /已过期/);
  assert.match(out, /class="sv-time"/);
});

t('A-09 fresh：脏数据原样显示且已转义，不抛不吞', () => {
  const out = fresh('<b>bad</b>');
  assert.doesNotMatch(out, /<b>/);
  assert.match(text(out), /bad/);
});

t('A-10 toCN 按 UTC 读、按 +08 显示', () => {
  /* D1 存 UTC。少了补 Z 这一步会整体差 8 小时，而页面上看不出任何异常。 */
  assert.match(toCN('2026-11-25 16:50:00'), /2026-11-26 00:50/);
  assert.match(toCN('2026-11-25T16:50:00Z'), /2026-11-26 00:50/);
  assert.equal(toCN(''), '—');
});

t('A-11 emptyState 转义且不产出裸空白', () => {
  const out = emptyState('<script>x</script>');
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /sv-empty/);
});

t('A-12 todoBar 数字相加，零也照样列出来', () => {
  const out = todoBar([
    { label: '待审评论', v: 3, href: '/admin/comments?status=pending' },
    { label: '通知失败', v: 0, href: '/admin/comments?status=all' },
  ]);
  assert.match(text(out), /今天要做的 3 件/);
  /* 0 必须显示：藏起来读者就分不清「这项是 0」和「这项没接上」。 */
  assert.match(text(out), /通知失败 0/);
});

t('A-13 todoBar 全零说「今天没有待办」，不写「要做的 0 件」', () => {
  const out = todoBar([{ label: '待审评论', v: 0, href: '/admin/comments' }]);
  assert.match(text(out), /今天没有待办/);
  assert.doesNotMatch(text(out), /要做的 0 件/);
});

t('A-14 [P-078] todoBar 负值不参与求和（查询异常时不许把总数拉低）', () => {
  const out = todoBar([
    { label: 'A', v: 5, href: '/a' },
    { label: 'B', v: -99, href: '/b' },
  ]);
  assert.match(text(out), /今天要做的 5 件/);
});

/* 结构不变量：原子层要真的是唯一实现，页面不许再手抄一份。
   行首锚定 + 唯一计数，避开注释散文与文档示例里的同名字面量。 */
const pages = readFileSync(new URL('../src/admin-pages.js', import.meta.url), 'utf8');
const dash = readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/admin-ui.js', import.meta.url), 'utf8');
const count = (src, re) => (src.match(re) || []).length;

t('A-15 toCN 只有 admin-ui.js 一处定义', () => {
  assert.equal(count(ui, /^export function toCN\(/gm), 1, 'admin-ui.js 里应恰好一个 toCN 定义');
  assert.equal(count(pages, /^\s*function toCN\(/gm), 0, 'admin-pages.js 不许再本地定义 toCN');
  assert.equal(count(dash, /^\s*function toCN\(/gm), 0, 'dashboard.js 不许再本地定义 toCN');
});

t('A-16 页面不再手写 sv-pill 的 class 插值', () => {
  /* 手写一次就是把语义色再散出去一份，下次改徽章样式必然漏掉它。
     允许保留的是带额外业务类的那处（adm-audit-action），它不吃语义色。 */
  assert.equal(
    count(pages, /class="sv-pill \$\{/g),
    0,
    'admin-pages.js 还有 class="sv-pill ${…}" 手写插值，改用 pill()'
  );
  assert.equal(count(dash, /class="sv-pill \$\{/g), 0, 'dashboard.js 还有手写 sv-pill 插值');
});

t('A-17 页面不再手写 sv-empty 外壳（内联 JS 动态插入除外）', () => {
  /* 服务端渲染的空态一律走 emptyState()。页面内脚本那句走 insertAdjacentHTML，
     没有服务端 esc 上下文，换成函数要跨层传值——按落点精确排除，
     而不是放宽整条判据：新增任何服务端手写空态照样红。 */
  const handWritten = (src) =>
    (src.match(/^.*'<p class="sv-empty">.*$/gm) || []).filter((l) => !l.includes('insertAdjacentHTML')).length;
  assert.equal(handWritten(pages), 0, 'admin-pages.js 还有手写空态外壳');
  assert.equal(handWritten(dash), 0, 'dashboard.js 还有手写空态外壳');
});

t('A-18 [P-077] fresh 自带外壳，调用方不许再包一层 sv-time', () => {
  /* 手写这行时真犯过：外层 <span class="sv-time"> 把 fresh 的 sv-time 又套了一遍，
     字号与颜色叠两遍，界面上只表现为「时间那行有点怪」——不会报错，也不会红。 */
  assert.equal(
    count(pages, /<span class="sv-time">\$\{fresh\(/g) + count(dash, /<span class="sv-time">\$\{fresh\(/g),
    0,
    'fresh() 已经返回 <span class="sv-time">，直接拼，别再包一层'
  );
  assert.match(fresh(Date.now() - 6e4, { staleMs: Infinity }), /^<span class="sv-time"/, 'fresh 的返回值必须自带外壳');
});

t('A-19 [P-078] 待办条的数字要带可判定口径（通知失败不许全表统计）', () => {
  /* 全表统计的「通知失败」会永久挂在「今天要做的 N 件」里——评论通知没有重发机制，
     一周前的失败已经无法补救，界面上也没办法把它清掉。一条永远做不完的待办，
     会让整条待办条失去可信度（每天都是同一个数字，人就不看了）。 */
  assert.doesNotMatch(
    dash,
    /FROM comments WHERE notify_status = 'fail'`/,
    '通知失败还在全表统计，历史失败会永久占着待办'
  );
  /* 窗口的落点从 dashboard.js 搬到了 navCounts()（侧栏徽章与待办条共用同一条 SQL），
     所以肯定断言跟着搬家 —— 但「dashboard 必须走 navCounts」这一条同时守住：
     谁在 dashboard 里另起一条查询，数字就会和侧栏漂。 */
  assert.match(
    ui,
    /notify_status = 'fail' AND notified_at >= datetime\('now','-7 days'\)/,
    '通知失败要带时间窗口'
  );
  assert.match(dash, /navCounts\(db\)/, '待办条必须走 navCounts，不能自己另查一条');
  assert.equal(
    (ui.match(/notified_at >= datetime\('now','-7 days'\)/g) || []).length,
    1,
    '7 天窗口只能有一处定义，多出来的那份迟早会漂'
  );
  assert.doesNotMatch(dash, /notifyFail: notifyFail\?\.c/, 'notifyFail 还来自独立查询，两个数字会漂');
});

console.log(`\n后台原子层 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
