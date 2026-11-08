// md.js 渲染回归：两个已修的真实 bug + 几条不该被改坏的行为。
// 用法：node scripts/test-md.mjs
import assert from 'node:assert/strict';
import { renderBody, extractCover, extractExcerpt } from '../public/md.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('alt 里不再插 <a>（#tag 只在元素之间的文本里生效）', () => {
  const out = renderBody('前文 ![ #tag ](/a.png) 后文');
  assert.ok(!out.includes('alt=" <a'), out);
  assert.ok(out.includes('alt=" #tag "'), out);
  assert.ok(!out.includes('tag-inline'), out);
});

t('普通标签照旧变成链接', () => {
  const out = renderBody('结尾 #cloudflare 一个标签');
  assert.ok(out.includes('<a class="tag-inline" href="/tag/cloudflare">#cloudflare</a>'), out);
});

t('行内代码与代码块里的 #xxx 不变成链接', () => {
  assert.ok(!renderBody('写 `#tag` 不该变').includes('tag-inline'));
  assert.ok(!renderBody('```bash\ncurl -d "#oauth" x\n```').includes('tag-inline'));
});

t('链接文字本身是 #tag 时不会嵌套 <a>', () => {
  const out = renderBody('[#oauth](/tag/oauth) 说明');
  assert.equal((out.match(/<a /g) || []).length, 1, out);
});

t('URL 自带括号时不被截断，也不漏一个 )', () => {
  const out = renderBody('见 [维基](https://en.wikipedia.org/wiki/OAuth_(disambiguation)) 段落');
  assert.ok(out.includes('href="https://en.wikipedia.org/wiki/OAuth_(disambiguation)"'), out);
  assert.ok(!out.includes('</a>)'), out);
});

t('带括号的图片地址与封面提取', () => {
  const md = '![x](https://cdn.example.com/p_(1).png)';
  assert.ok(renderBody(md).includes('src="https://cdn.example.com/p_(1).png"'));
  assert.equal(extractCover(md), 'https://cdn.example.com/p_(1).png');
});

t('摘要提取不吃掉括号 URL 的尾巴', () => {
  const s = extractExcerpt('见 [维基](https://en.wikipedia.org/wiki/OAuth_(disambiguation)) 说明');
  assert.ok(s.includes('维基'), s);
  assert.ok(!s.includes('disambiguation'), s);
});

t('危险协议仍被 safeUrl 拦掉', () => {
  const out = renderBody('[点我](javascript:alert(1))');
  assert.ok(!out.includes('href="javascript:'), out);
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
