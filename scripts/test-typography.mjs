// 排版两条红线：正文宽度落在可读区间、衬线只给标题。
// 只读源码（结构层）。计算样式要浏览器，那层在 shot.mjs 的人工截图里看，
// 不在这里冒充——源码层能守的是「没人能把正文字体改成 serif」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let pass = 0;
const ok = (name) => {
  pass++;
  console.log(`  ok  ${name}`);
};

const CSS = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/* 按 `}` 切块再回取选择器。只依赖这一个文件的结构，不猜缩进。
   选择器取「最后一个 { 之前、最后一个 ; 或换行之后」那一段 —— 兼容
   `@media (...) {` 嵌套时选择器紧跟大括号的写法。 */
const blocks = CSS.split('}').flatMap((raw) => {
  const i = raw.lastIndexOf('{');
  if (i < 0) return [];
  const body = raw.slice(i + 1);
  const head = raw.slice(0, i).split(/[\n;]/).pop().trim().replace(/\s+/g, ' ');
  return [{ sel: head, body }];
});
const withSerif = blocks.filter((b) => /font-family\s*:\s*var\(--serif\)/.test(b.body));

/* ---------- T-01 正文宽度：716 是 760 - 2×22，落在 38~42 字/行的区间 ---------- */

const wrap = blocks.find((b) => b.sel === '.wrap');
assert.ok(wrap, '找不到 .wrap 规则 —— 选择器改名了，先指回来再谈宽度');
const maxW = Number((wrap.body.match(/max-width\s*:\s*(\d+)px/) || [])[1]);
assert.ok(maxW, '.wrap 没写死 max-width（改成 ch/%/rem 就没人算得出来了）');
const padX = (wrap.body.match(/padding\s*:\s*0\s+(\d+)px/) || [])[1];
assert.ok(padX, '.wrap 的水平 padding 不是 `0 Npx` 形式，这条判据失效了');
const textW = maxW - Number(padX) * 2;
assert.ok(
  textW >= 680 && textW <= 740,
  `正文内容宽 ${textW}px（${maxW} - 2×${padX}）超出 680~740 —— 超过 740 每行过 45 字会丢行，少于 680 会频繁回行`
);
ok(`T-01 正文内容宽 ${textW}px（.wrap ${maxW} - 2×${padX}），在 680~740 内`);

/* ---------- T-02 衬线只给标题：正文标签选择器不得出现 var(--serif) ---------- */

/* 这些选择器一旦吃 serif，就是「中文宋体小字号上屏」那条老坑：
   Georgia 与宋体的 x-height / 重心差得远，中英混排一行里会跳。 */
const BODY_SEL = /(^|[\s,>+~])(p|li|blockquote|td|dd|dt|figcaption)\b|\.post-body\b|(^|[\s,>+~])\.md($|[\s,.:])/;
/* `.md h2` 这类是「正文容器里的标题」，标题本来就该吃衬线 —— 命中 h1..h6 的
   选择器跳过这一条，留给 T-03 的白名单判。 */
const HEAD_SEL = /(^|[\s,>+~(])h[1-6]\b/;
const badBody = withSerif.filter((b) => BODY_SEL.test(b.sel) && !HEAD_SEL.test(b.sel));
assert.deepEqual(
  badBody.map((b) => b.sel),
  [],
  `正文选择器吃了衬线：${badBody.map((b) => b.sel).join(' | ')}`
);
ok('T-02 正文（p/li/blockquote/td/.md/.post-body）零处 var(--serif)');

/* ---------- T-03 落点白名单：标题与界面文字，且白名单条目必须真实存在 ---------- */

/* 白名单不是「允许这些」，是「只有这些」：新加一处 serif 必须来这里登记，
   登记时被迫想一遍它是不是标题。条目里每条都要求真实命中，防止白名单
   长成一张空头支票。 */
const ALLOW = [
  /(^|[\s,>+~(])h[1-6]\b/,
  /\.brand\b/,
  /\.title-input\b/,
  /\.post-head\b/,
  /\.page-head\b/,
  /\.tl-yhead\b/,
  /\.arch-yhead\b/,
  /\.g404\b/,
];
const outside = withSerif.filter((b) => !ALLOW.some((re) => re.test(b.sel)));
assert.deepEqual(
  outside.map((b) => b.sel),
  [],
  `衬线跑到了非标题选择器上：${outside.map((b) => b.sel).join(' | ')}`
);
assert.ok(withSerif.length >= 5, `只找到 ${withSerif.length} 处 serif —— 标题早就该吃衬线，这个数说明判据读空了`);
for (const sel of ['.md h1, .md h2, .md h3, .md h4', '.post-head h1']) {
  assert.ok(withSerif.some((b) => b.sel === sel), `白名单里的 ${sel} 不再吃衬线 —— 登记与实际脱钩`);
}
ok(`T-03 衬线落点 ${withSerif.length} 处，全在标题/界面白名单内`);

/* ---------- T-04 基准 --serif 必须真的是衬线栈 ----------
   其余皮肤把 --serif 指成 sans 是主题层的设计选择，豁免；
   基准 :root 不行 —— 那是 paper，标题的衬线质感全靠这一行。 */

const base = blocks.find((b) => b.sel === ':root');
assert.ok(base, '找不到基准 :root 块');
const serifDecl = (base.body.match(/--serif\s*:\s*([^;]+);/) || [])[1] || '';
/* 别写 /serif/i —— 它会命中 `sans-serif`，注入 sans 栈也照样绿（本文件第一版就是这么绿的）。
   两个判据缺一不可：必须点名一个具体衬线族，且不得出现 sans-serif。 */
assert.match(
  serifDecl,
  /Iowan|Palatino|Georgia|Songti|"Noto Serif"/i,
  `基准 --serif 没点名任何衬线族：${serifDecl.trim()}`
);
assert.doesNotMatch(
  serifDecl,
  /sans-serif/i,
  `基准 --serif 里混进了 sans-serif：${serifDecl.trim()}`
);
ok('T-04 基准 :root 的 --serif 是衬线栈（主题层改 sans 不在此列）');

console.log(`\n[P-086] typography: ${pass} passed`);
