// 服务端 HTML 白名单的回归。这是正文的第二道闸，内容来自历史数据、粘贴、
// 手改的库记录，渲染器管不着 —— 但它原来一条测试都没有。
//
// 这里断言的都是「放行该放行的、挡住该挡住的」，两个方向都会坏：
// 挡多了 picture/source 被剥成空壳（图片变形一样看不出来），放多了就是 XSS。
//
// 用法：node scripts/test-clean.mjs
import assert from 'node:assert/strict';
import { sanitizeHtml } from '../src/clean.js';

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + name);
};

/* ---------- 该放行的 ---------- */
t('<picture> 与 <source> 保留，不被剥成空壳', () => {
  const out = sanitizeHtml(
    '<picture><source type="image/avif" srcset="/img/a.jpg.avif"><source type="image/webp" srcset="/img/a.jpg.webp"><img src="/img/a.jpg" alt="图" loading="lazy"></picture>'
  );
  assert.match(out, /<picture>/);
  assert.match(out, /<\/picture>/);
  assert.doesNotMatch(out, /<source type="image\/avif">/); // 空壳就是这里挂掉的样子
});

t('source 的 srcset 保留 —— 少了它 source 等于没写', () => {
  const out = sanitizeHtml('<source type="image/avif" srcset="/img/a.jpg.avif">');
  assert.match(out, /srcset="\/img\/a\.jpg\.avif"/);
});

t('img 的 srcset / sizes 也放行', () => {
  const out = sanitizeHtml('<img src="/a.jpg" srcset="/a.jpg 1x, /a@2x.jpg 2x" sizes="100vw">');
  assert.match(out, /srcset="\/a\.jpg 1x, \/a@2x\.jpg 2x"/);
  assert.match(out, /sizes="100vw"/);
});

t('外链自动补 target 与 rel', () => {
  const out = sanitizeHtml('<a href="https://example.com/x">x</a>');
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener nofollow"/);
});

t('站内相对链接不补 target', () => {
  const out = sanitizeHtml('<a href="/p/x">x</a>');
  assert.doesNotMatch(out, /target=/);
});

/* ---------- 该挡住的 ---------- */
t('srcset 里混进 javascript: 的候选，整个 srcset 丢掉', () => {
  // 只校验第一个 URL 就会漏这条：坏的那个在第二位
  const out = sanitizeHtml('<img src="/a.jpg" srcset="/a.jpg 1x, javascript:alert(1) 2x">');
  assert.doesNotMatch(out, /javascript/i);
  assert.doesNotMatch(out, /srcset=/);
});

t('srcset 里的 data:image 放行（是合法图片内联）', () => {
  const out = sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
  assert.match(out, /src="data:image\/png;base64,/);
});

t('srcset 里的 data:text/html 挡住', () => {
  const out = sanitizeHtml('<img src="/a.jpg" srcset="data:text/html,<script>alert(1)</script> 1x">');
  assert.doesNotMatch(out, /data:text\/html/i);
});

t('onerror / onload 之类的内联事件全剥', () => {
  const out = sanitizeHtml('<img src="/a.jpg" onerror="alert(1)" onload="x()">');
  assert.doesNotMatch(out, /on\w+=/i);
  assert.match(out, /src="\/a\.jpg"/);
});

t('没有 src 的 img 整个丢掉（只剩 onerror 的那种）', () => {
  assert.equal(sanitizeHtml('<img alt="x" onerror="alert(1)">').includes('<img'), false);
});

t('script / iframe / style 块连内容一起删', () => {
  const out = sanitizeHtml('<p>a</p><script>alert(1)</script><iframe src="//evil"></iframe><style>*{}</style>');
  assert.doesNotMatch(out, /script|iframe|style/i);
  assert.match(out, /<p>a<\/p>/);
});

t('svg 整段删掉（它是 XSS 的常用载体）', () => {
  assert.equal(sanitizeHtml('<svg><use href="#x"/></svg>').includes('svg'), false);
});

t('javascript: 协议的链接丢掉 href', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  assert.doesNotMatch(out, /javascript/i);
});

t('style 只留表格对齐，其它丢掉', () => {
  assert.match(sanitizeHtml('<td style="text-align: center">x</td>'), /style="text-align: center"/);
  assert.doesNotMatch(sanitizeHtml('<td style="position:fixed;top:0">x</td>'), /position/);
});

t('未知标签被丢掉，但里面的文字留下', () => {
  const out = sanitizeHtml('<marquee>还在</marquee>');
  assert.equal(out.includes('marquee'), false);
  assert.match(out, /还在/);
});

t('data-* 只放行 data-copy', () => {
  assert.match(sanitizeHtml('<button data-copy="x">c</button>'), /data-copy="x"/);
  assert.doesNotMatch(sanitizeHtml('<div data-track="x">c</div>'), /data-track/);
});

t('空段落与只剩 <br> 的 div 被清掉', () => {
  assert.equal(sanitizeHtml('<p> </p><div><br></div>').trim(), '');
});

console.log(`\n${pass} 条全过`);
