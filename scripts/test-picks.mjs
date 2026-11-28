#!/usr/bin/env node
/**
 * P-124：首页「不知道从哪读起」三张卡的守卫。
 *
 * 这三张卡以前只有序号 + 标题，根因不是模板偷懒，而是查询只 SELECT 了 4 列：
 * 摘要、标签、阅读时长根本没取回来。这里同时守「列取全了」和「模板接住了」两边，
 * 少一边都会静默退回光秃秃的标题。
 *
 * 真值（三篇 summary_src=manual）由线上/本地 D1 另查，本脚本只读源码：
 * CI 的本地种子库未必含这三篇，拿 DB 当判据会在缺数据的机器上假绿。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { report } from './pitfall-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');
const idx = read('src/index.js');
const api = read('src/api.js');
const css = read('public/style.css');

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    if (!report('P-124', name, true)) bad++;
  } catch (e) {
    if (!report('P-124', name, false, e.message)) bad++;
  }
}

/* 行首锚定切函数体：注释散文里也提得到 pickPosts 这几个字，
   用裸 indexOf 会切到错的位置。 */
const sliceFn = (src, sig, next) => {
  const a = src.indexOf('\n' + sig);
  assert.ok(a > 0, `找不到函数 ${sig}`);
  const b = src.indexOf('\n' + next, a + 1);
  assert.ok(b > a, `找不到后继函数 ${next}`);
  return src.slice(a, b);
};
const pickQuery = sliceFn(idx, 'async function pickPosts(db)', 'function picksHtml(list)');
const pickTpl = sliceFn(idx, 'function picksHtml(list)', 'async function listQuery(env, url)');

await t('三篇 slug 固定且有序', () => {
  assert.match(
    idx,
    /const PICKS = \['d1-no-such-table', 'oauth-device-flow', 'editor-markdown-xss'\];/,
    '精选位被换成别的文章，三张卡的字段口径断言就打偏了'
  );
});

await t('查询取回 summary / 正文兜底 / 时长 / 标签四列', () => {
  assert.match(pickQuery, /\bp\.summary\b/, '没取 summary：手填导语出不来');
  assert.match(pickQuery, /AS excerpt_src\b/, '没取正文兜底列');
  assert.match(pickQuery, /AS content_len\b/, '没取时长列');
  assert.match(pickQuery, /\bTAG_AGG\b/, '没取标签列');
  assert.match(pickQuery, /p\.summary \|\| extractExcerpt\(/, '摘要不再以手填导语优先');
});

await t('阅读时长与列表共用 CONTENT_LEN 唯一源', async () => {
  const exported = (api.match(/^export const CONTENT_LEN = /gm) || []).length;
  const local = (api.match(/^\s+const CONTENT_LEN = /gm) || []).length;
  assert.equal(exported, 1, 'CONTENT_LEN 必须只有一份 export 定义');
  assert.equal(local, 0, '又出现局部 CONTENT_LEN 副本：同一篇文章会显示两个时长');
  assert.match(idx, /\bCONTENT_LEN\b/, 'pickPosts 没用那份共用常量');
  assert.match(pickQuery, /Math\.max\(1, Math\.round\(Number\(p\.content_len\) \/ 400\)\)/, '时长算法被改回另一套');
});

await t('模板把四列都渲染出来', () => {
  assert.match(pickTpl, /class="sp-x"/, '摘要节点丢了：sp-x 是独立规则，别换成 .excerpt');
  assert.doesNotMatch(pickTpl, /class="excerpt"/, '.excerpt 只挂在 .post-card 后代下，这里没有那个祖先');
  assert.match(pickTpl, /class="card-kicker"/, '标签/日期容器丢了');
  assert.match(pickTpl, /class="card-tag"/, '标签没渲染');
  assert.match(pickTpl, /class="tl-dim"/, '日期/时长没渲染');
  assert.match(pickTpl, /分钟<\/span>/, '阅读时长没渲染');
});

await t('死规则 .pick-m 已清除', () => {
  assert.doesNotMatch(css, /^\.pick-m\b/m, '.pick-m 元素已经不在模板里，规则留着是误导线索');
});

console.log(bad ? `\n✗ picks 断言 ${bad} 项失败` : '\n✓ picks 断言全部通过（P-124）');
process.exit(bad ? 1 : 0);
