#!/usr/bin/env node
/**
 * Mermaid 渲染链的静态守卫。
 *
 * 这条链跨三处：md.js 出标记 → boot.js 拉起 2.7MB 的包 → style.css 给它骨架。
 * 任何一处断了，表现都一样：读者看见一坨源码或者一块空白，而且线上看不出来
 * （接口 200、HTML 正常、控制台可能只有一行 integrity 报错）。
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderBody } from '../public/md.js';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PUB = join(ROOT, 'public');
const boot = readFileSync(join(PUB, 'boot.js'), 'utf8');
const css = readFileSync(join(PUB, 'style.css'), 'utf8');
let pass = 0;
const fails = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL ${name} — ${e.message.split('\n')[0]}`);
  }
};

const md = '开头\n\n```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n```\n\n结尾';
const out = renderBody(md);

/* ---------- md.js 输出 ---------- */
t('mermaid 块渲染成 .mermaid-wrap 容器', () => {
  assert.match(out, /<div class="mermaid-wrap">/);
});

t('源码保留在 <pre class="mm-src"> 里（无 JS 也能读）', () => {
  const pre = out.match(/<pre class="mm-src">([\s\S]*?)<\/pre>/);
  assert.ok(pre, '没有 mm-src');
  const text = pre[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  assert.ok(text.includes('graph TD'), text);
  assert.ok(text.includes('-->'), '箭头不该被吃掉');
});

t('不被语法高亮污染（不能出现 span.token）', () => {
  const wrap = out.match(/<div class="mermaid-wrap">[\s\S]*?<\/div><\/div>/)[0];
  assert.ok(!/<span class="[^"]*(tok|kwd|op)/.test(wrap), wrap);
});

t('不套 .code-wrap（避免被折叠/行号增强接管）', () => {
  assert.ok(!out.includes('code-wrap'), out);
});

t('带复制按钮，钩子是 data-copy-mermaid', () => {
  assert.match(out, /data-copy-mermaid/);
});

t('源码里的 HTML 被转义（不能变成真标签）', () => {
  const evil = renderBody('```mermaid\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n```');
  assert.ok(!/<img src=x/.test(evil), evil);
  assert.ok(evil.includes('&lt;img'), evil);
});

t('普通代码块不受影响', () => {
  const js = renderBody('```js\nconst a = 1;\n```');
  assert.match(js, /class="code-wrap"/);
  assert.ok(!js.includes('mermaid-wrap'), js);
});

t('大小写混写也认（```Mermaid）', () => {
  assert.match(renderBody('```Mermaid\ngraph TD\nA-->B\n```'), /mermaid-wrap/);
});

/* ---------- vendor 包 ---------- */
t('vendor/mermaid.min.js 存在且像真的', () => {
  const p = join(PUB, 'vendor', 'mermaid.min.js');
  assert.ok(existsSync(p), '文件缺失');
  const size = statSync(p).size;
  assert.ok(size > 1_000_000, `只有 ${size}B，像被截断了`);
  const s = readFileSync(p, 'utf8');
  assert.ok(/globalThis\["mermaid"\]/.test(s.slice(-400)), '不是挂 globalThis 的经典脚本');
});

/* ---------- boot.js 接线 ---------- */
t('boot.js 只在页面上有 .mermaid-wrap 时才加载包', () => {
  // 入口做成可重入（编辑器预览是动态长的），但「没块就别注入」这条不变
  assert.match(boot, /if \(!document\.querySelector\('\.mermaid-wrap'\)\) return;/);
  assert.match(boot, /window\.__rerenderMermaid = function/);
});

t('动态注入的 <script> 带版本号与 integrity', () => {
  assert.match(boot, /s\.src = '\/vendor\/mermaid\.min\.js'/);
  assert.match(boot, /if \(a\.i\) s\.integrity = a\.i/);
  assert.ok(!/s\.crossOrigin\s*=/.test(boot), '同源加 crossorigin 会被拦');
});

t('securityLevel 必须是 strict', () => {
  assert.match(boot, /securityLevel: 'strict'/);
  assert.ok(!/securityLevel: 'loose'/.test(boot), 'loose 等于允许 HTML 注入');
});

t('渲染失败时保留源码（不全清空）', () => {
  assert.match(boot, /is-error/);
  assert.ok(!/body\.innerHTML = ''/.test(boot));
});

t('主题切换后重绘', () => {
  assert.match(boot, /MutationObserver/);
  assert.match(boot, /is-rendered/);
});

/* ---------- 样式 ---------- */
t('骨架样式存在', () => {
  for (const sel of ['.md .mermaid-wrap', '.md .mm-bar', '.md pre.mm-src', '.md .mermaid-wrap.is-rendered .mm-body svg']) {
    assert.ok(css.includes(sel), `缺 ${sel}`);
  }
});

t('渲染后 SVG 不溢出（max-width:100%）', () => {
  const seg = css.match(/\.md \.mermaid-wrap\.is-rendered \.mm-body svg \{[^}]*\}/);
  assert.ok(seg && /max-width: 100%/.test(seg[0]), '没有约束宽度');
});

console.log(`\nPASS  ${pass} passed, ${fails.length} failed  （mermaid）`);
if (fails.length) {
  console.log(fails.map((f) => '   · ' + f).join('\n'));
  process.exit(1);
}
