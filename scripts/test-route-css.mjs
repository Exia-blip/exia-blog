// CSS 按路由拆分的回归：既要映射对，也要保证「搬走的类确实搬走了、共享的类确实留住了」。
// 漏搬=首屏没省到；错搬=别的页面掉样式。两边都要测。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routeCssPath } from '../src/settings.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* ---- 路由映射 ---- */
t('四个专属页各命中自己的表', () => {
  assert.equal(routeCssPath('/editor'), '/css/editor.css');
  assert.equal(routeCssPath('/login'), '/css/login.css');
  assert.equal(routeCssPath('/friends'), '/css/friends.css');
  assert.equal(routeCssPath('/archive'), '/css/archive.css');
});

t('归档年份页也命中', () => {
  assert.equal(routeCssPath('/archive/2026'), '/css/archive.css');
  assert.equal(routeCssPath('/archive/2025/'), '/css/archive.css');
});

t('尾斜杠不影响命中', () => {
  assert.equal(routeCssPath('/friends/'), '/css/friends.css');
  assert.equal(routeCssPath('/editor/'), '/css/editor.css');
});

t('首页/文章/标签/栏目/系列都不带分片', () => {
  for (const p of ['/', '/p/some-slug', '/tag/Cloudflare', '/cat/dev', '/categories', '/series', '/404']) {
    assert.equal(routeCssPath(p), '', `不该命中: ${p}`);
  }
});

t('查询串不会混进路径', () => {
  assert.equal(routeCssPath('/archive?y=2026'), ''); // URL.pathname 本身不含查询串，这里确认函数不做多余解析
  assert.equal(routeCssPath('/editor'), '/css/editor.css');
});

t('空值/异常值安全', () => {
  assert.equal(routeCssPath(''), '');
  assert.equal(routeCssPath(undefined), '');
  assert.equal(routeCssPath('"><script>'), '');
});

/* ---- 拆分完整性 ---- */
const main = fs.readFileSync('public/style.css', 'utf8');
const read = (f) => fs.readFileSync(`public/css/${f}`, 'utf8');
const allCss = () => main + ['editor.css', 'friends.css', 'login.css', 'archive.css'].map(read).join('\n');

t('四个分片都存在', () => {
  for (const f of ['editor.css', 'friends.css', 'login.css', 'archive.css']) {
    assert.ok(fs.existsSync(`public/css/${f}`), `缺 ${f}`);
  }
});

t('主表不再含纯专属选择器（首屏省字节的证明）', () => {
  // 注意：.editor-top / .editor-side / .md-input 在全局 @media 响应式块里
  // 还有窄屏规则，那是故意留主表的（见 split-css.mjs 注释）。这里查的是
  // 桌面主体定义有没有搬走 —— 用「选择器开头的完整规则行」判断。
  for (const sel of ['.editor-page {', '.friend-grid {', '.friend-apply {', '.friend-card {',
    '.login-box {', '.gh-btn {', '.arch-bar {', '.timeline {', '.tl-item {', '.arch-row {']) {
    assert.ok(!main.includes(sel), `主表仍含主体规则 ${sel}，没搬干净`);
  }
});

t('专属选择器确实进了对应分片', () => {
  assert.ok(read('editor.css').includes('.editor-page'));
  assert.ok(read('editor.css').includes('#site-avatar'));
  assert.ok(read('friends.css').includes('.friend-grid'));
  assert.ok(read('login.css').includes('.login-box'));
  assert.ok(read('archive.css').includes('.timeline'));
});

t('共享选择器仍在主表（否则别的页面掉样式）', () => {
  for (const sel of ['.field', '.dot', '.chi', '.lnk', 'arch-skel', 'tag.on', 'hero-sub']) {
    assert.ok(main.includes(sel), `主表丢了共享选择器 ${sel}`);
  }
});

t('响应式里的编辑器抽屉规则仍在主表', () => {
  // 这些规则在全局 @media 块里，随主表加载，editor.css 不重复带
  assert.ok(main.includes('.editor-side'));
  assert.ok(main.includes('.side-mask'));
});

t('分片体积都小于主表一个数量级（拆得有意义）', () => {
  assert.ok(Buffer.byteLength(main) > 60000, '主表应该在 60KB 左右');
  for (const f of ['editor.css', 'friends.css', 'login.css', 'archive.css']) {
    const n = Buffer.byteLength(read(f));
    assert.ok(n > 300 && n < 12000, `${f} 体积异常: ${n}`);
  }
});

t('CSS 花括号全平衡（拆分没切断规则）', () => {
  for (const [name, css] of [['style.css', main], ['editor.css', read('editor.css')],
    ['friends.css', read('friends.css')], ['login.css', read('login.css')],
    ['archive.css', read('archive.css')]]) {
    const o = (css.match(/{/g) || []).length;
    const c = (css.match(/}/g) || []).length;
    assert.equal(o, c, `${name} 花括号不平衡 ${o}/${c}`);
  }
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
}
console.log(`\n路由 CSS ${pass}/${cases.length} 通过`);
