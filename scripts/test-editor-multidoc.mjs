#!/usr/bin/env node
/**
 * 编辑器多文档的静态守门。
 *
 * 真机验证（verify:editor）能证明「这一次没串味」，但证明不了「以后不会退回去」。
 * 多文档的串味全是时序 bug，删掉一行 clearTimeout、把 payload 改回读 DOM，
 * 手测十次也未必撞上。所以把几条结构性约束钉成断言：
 *
 *   - 切文档不许整页跳转（否则页签白做）
 *   - 保存只从 doc 读，不从 DOM 读（切走后 DOM 属于别人）
 *   - 定时器挂在文档上（全局定时器到点必串）
 *   - 异步入口先捕获快照（响应回来认人）
 *   - 草稿 key 按文档分（两个空白页签不能共用一个键）
 *   - capture 覆盖全部表单字段（漏一个就静默串味）
 *
 *   node scripts/test-editor-multidoc.mjs
 *   退出码 0 = 全部通过
 *
 * 来由见 PITFALLS.md P-036：一页开两篇之后，异步回调读全局就会写进别人那篇。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/editor.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

// 只取页面里那个 module script（head 里还有一段主题引导）
const start = html.indexOf('<script type="module">');
const end = html.lastIndexOf('</script>');
assert.ok(start > 0 && end > start, '找不到 module script');
const code = html.slice(start + '<script type="module">'.length, end);

/** 取顶层函数体（大括号配平，模板串里的 ${} 成对，不影响计数） */
function fnBody(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(code);
  assert.ok(m, `找不到函数 ${name}`);
  const open = code.indexOf('{', m.index);
  assert.ok(open > 0, `${name} 没有函数体`);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  assert.fail(`${name} 大括号不配平`);
}

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* ---------------- 1. 切文档不整页跳转 ---------------- */
t('MM-01 切文档走页签，不整页跳转', () => {
  assert.ok(!/location\.href\s*=\s*['"]\/editor\?id=/.test(code), '仍有一处 location.href 到 /editor?id=');
  assert.ok(/docs\.set\(/.test(code) && /function openDoc\(/.test(code), '缺少 docs 表或 openDoc');
});

/* ---------------- 2. 保存只从 doc 读 ---------------- */
t('MM-02 buildPayload 只读 doc，不读 DOM', () => {
  const b = fnBody('buildPayload');
  assert.ok(/d\.content/.test(b) && /d\.title/.test(b), 'payload 没从 doc 取内容/标题');
  const domReads = b.match(/\b(?:titleEl|inputEl|slugEl|catEl|seriesEl2?|privateEl|hiddenEl|sumEl|previewEl)\./g) || [];
  assert.deepEqual(domReads, [], `payload 里读了 DOM：${domReads.join(', ')}`);
  assert.ok(!/document\.getElementById/.test(b), 'payload 里直接读 DOM');
});

/* ---------------- 3. 定时器按文档存 ---------------- */
t('MM-03 自动保存定时器挂在文档上', () => {
  const b = fnBody('scheduleSave');
  assert.ok(/d\.timer\s*=\s*setTimeout/.test(b), 'scheduleSave 没把定时器存到 doc 上');
  assert.ok(/clearTimeout\(d\.timer\)/.test(b), 'scheduleSave 没清本文档的旧定时器');
  assert.ok(!/\bsaveTimer\s*=\s*setTimeout/.test(code), '还有全局 saveTimer 在跑（会跨文档）');
  const flush = fnBody('flushDoc');
  assert.ok(/clearTimeout\(d\.timer\)/.test(flush), 'flushDoc 没清定时器');
});

/* ---------------- 4. 异步入口认人 ---------------- */
t('MM-04 异步入口先捕获 doc 快照', () => {
  for (const [name, pat] of [
    ['flushDoc', /const\s+myRev\s*=\s*d\.rev|if\s*\(S\s*===\s*d\)/],
    ['fetchSummary', /const\s+d\s*=\s*S/],
    ['uploadFile', /const\s+target\s*=\s*S/],
  ]) {
    const b = fnBody(name);
    assert.ok(pat.test(b), `${name} 没捕获当前文档，切走后响应会写错人`);
  }
  // 回写 UI 前必须比一次身份
  const f = fnBody('flushDoc');
  assert.ok(/S\s*===\s*d/.test(f), 'flushDoc 回写 UI 前没比对 S === d');
  const s = fnBody('fetchSummary');
  assert.ok(/S\s*===\s*d/.test(s), 'fetchSummary 回写 UI 前没比对 S === d');
});

/* ---------------- 5. 草稿 key 按文档分 ---------------- */
t('MM-05 每篇一个本地草稿 key', () => {
  assert.ok(/DOC_TMP\s*=\s*'draft:tmp:'/.test(code), '空白页签没有独立草稿前缀');
  assert.ok(/localStorage\.setItem\(d\.draftKey/.test(code), '草稿没按 doc 的 key 写');
  assert.ok(!/localStorage\.setItem\(draftKey/.test(code), '仍有按全局 draftKey 写草稿的地方');
  assert.ok(/localStorage\.removeItem\('draft:new'\)/.test(code), '旧 draft:new 没有迁移清理');
});

/* ---------------- 6. capture 覆盖全部字段 ---------------- */
t('MM-06 capture 覆盖全部表单字段（漏一个就串味）', () => {
  const b = fnBody('capture');
  const fields = [
    'title', 'content', 'summary', 'slug', 'category', 'series',
    'seriesOrder', 'isPrivate', 'hidden', 'publishAt', 'pubInput',
    'sumTouched', 'dirty', 'rev', 'saving', 'postId',
  ];
  const missing = fields.filter((f) => !new RegExp(`\\bd\\.${f}\\s*=`).test(b));
  assert.deepEqual(missing, [], `capture 漏了：${missing.join(', ')}`);
});

/* ---------------- 7. 切文档用 setModel，不清撤销栈 ---------------- */
t('MM-07 切文档用 setModel（撤销栈按篇各留一份）', () => {
  const b = fnBody('paint');
  assert.ok(/monaco\.setModel\(/.test(b), 'paint 没有切 model');
  assert.ok(/saveViewState|restoreViewState/.test(b), '光标/滚动没有按篇保存');
  assert.ok(!/function edSetText\(/.test(code), 'edSetText 又回来了（整篇 setValue 会清撤销栈）');
  const dm = fnBody('docModel');
  assert.ok(/createModel\(/.test(dm), 'docModel 没建独立 model');
  assert.ok(/setEOL\(/.test(dm), '新建 model 没统一 LF');
});

/* ---------------- 8. 页签渲染要转义 ---------------- */
t('MM-08 页签标题转义后再进 innerHTML', () => {
  const b = fnBody('renderTabs');
  assert.ok(/esc\(d\.key\)/.test(b) && /esc\(name\)/.test(b), 'key/标题没转义');
  assert.ok(/classList\.toggle\('multi'/.test(b), '没有单篇隐藏判断');
});

/* ---------------- 9. 单篇不占行 ---------------- */
t('MM-09 单篇时页签条不占高度', () => {
  assert.ok(/\.doc-tabs:not\(\.multi\)\s*\{\s*display:\s*none/.test(css), 'CSS 里没有单篇隐藏规则');
  assert.ok(/id="doc-tabs"/.test(html), '页面没有页签容器');
});

let pass = 0;
const fails = [];
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}
console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${pass} passed, ${fails.length} failed  （编辑器多文档）`);
process.exit(fails.length ? 1 : 0);
