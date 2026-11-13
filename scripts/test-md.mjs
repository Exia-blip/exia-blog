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

t('封面提取跳过围栏代码块里的示例图', () => {
  const md = ['讲一下图片语法：', '', '```md', '![示例](/a.png)', '```', '', '![真封面](/img/real.png)'].join('\n');
  assert.equal(extractCover(md), '/img/real.png');
});

t('只有代码块里的图时不算封面', () => {
  const md = '```md\n![示例](/a.png)\n```\n\n正文没有别的图';
  assert.equal(extractCover(md), null);
});

t('原始 HTML 不执行：标签一律转义成文本', () => {
  const out = renderBody('正文 <img src=x onerror=alert(1)> 结束');
  assert.ok(!out.includes('<img src=x'), out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), out);
});

t('data: 只能进 img，不能进 a', () => {
  const link = renderBody('[s](data:image/svg+xml;base64,PHN2Zz4=)');
  assert.ok(link.includes('href="#"'), link);
  const img = renderBody('![s](data:image/png;base64,iVBORw0KGgo=)');
  assert.ok(img.includes('src="data:image/png;base64,iVBORw0KGgo="'), img);
});

t('裸链接不吃句末标点', () => {
  const out = renderBody('看 https://example.com/a. 结束');
  assert.ok(out.includes('href="https://example.com/a"'), out);
  assert.ok(!out.includes('href="https://example.com/a."'), out);
});

/* 站内图片额外给 avif / webp 候选：变体是独立 URL，
   所以浏览器的选择不会污染边缘缓存（按 Accept 协商才会）。 */
t('站内上传的 png 会包一层 picture，avif 优先、webp 次之', () => {
  const out = renderBody('![图](/img/u/202611/a.png)');
  assert.ok(out.includes('<picture>'), out);
  const avif = out.indexOf('type="image/avif"');
  const webp = out.indexOf('type="image/webp"');
  assert.ok(avif > 0 && webp > avif, out);
  assert.ok(out.includes('src="/img/u/202611/a.png"'), out);
});

t('外链图片不加变体（我们没法给别人的服务器生成 webp）', () => {
  const out = renderBody('![图](https://cdn.example.com/a.png)');
  assert.ok(!out.includes('<picture>'), out);
});

t('svg 不加变体：位图转码对矢量图没意义', () => {
  const out = renderBody('![图](/img/u/a.svg)');
  assert.ok(!out.includes('<picture>'), out);
});

/* 编辑器上传前就把 jpg/png 转成 webp，那类图只需要补一档 avif。
   给它再挂一个 .webp 候选，等于让浏览器在「原图」和「原图转出来的 webp」
   之间做选择 —— 选哪个都是同一份画质，白白多一次判断。 */
t('上传时已转 webp 的图只挂 avif 候选', () => {
  const out = renderBody('![图](/img/u/202611/a.webp)');
  assert.ok(out.includes('<picture>'), out);
  assert.ok(out.includes('type="image/avif"'), out);
  assert.ok(!out.includes('type="image/webp"'), out);
  assert.ok(!out.includes('.webp.webp'), out);
  assert.ok(out.includes('src="/img/u/202611/a.webp"'), out);
});

/* 强调规则跑在图片/链接之后，面对的是拼好的 HTML。它原来用 [^*\n]+ 这种
   任意的中间段，会跨过属性值去凑对：两个 srcset 里的 __probe 被当成一对，
   名字被啃成 <strong>，整个 srcset 报废 —— 页面还能显示，只是永远拿不到 avif。 */
t('图片路径里的双下划线不被当成粗体', () => {
  const out = renderBody('![图](/img/u/__probe/photo.jpg)');
  assert.ok(!out.includes('<strong>'), out);
  assert.ok(out.includes('srcset="/img/u/__probe/photo.jpg.webp"'), out);
});

t('链接 URL 里的双下划线也不被啃', () => {
  const out = renderBody('[看](/p/__a__b)');
  assert.ok(!out.includes('<strong>'), out);
  assert.ok(out.includes('href="/p/__a__b"'), out);
});

t('正文里正常的 __粗体__ 照旧生效', () => {
  const out = renderBody('这里是 __重点__ 内容');
  assert.ok(out.includes('<strong>重点</strong>'), out);
});

t('链接文字里的粗体仍生效（没被整段占位吞掉）', () => {
  const out = renderBody('[**粗**链接](/p/x)');
  assert.ok(out.includes('<strong>粗</strong>'), out);
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
