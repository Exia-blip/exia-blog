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

/* ---------- T-01 正文宽度：704 - 2×22 = 660，老板 11-27 亲定（38.8 汉字 / 72ch） ---------- */

const wrap = blocks.find((b) => b.sel === '.wrap');
assert.ok(wrap, '找不到 .wrap 规则 —— 选择器改名了，先指回来再谈宽度');
const maxW = Number((wrap.body.match(/max-width\s*:\s*(\d+)px/) || [])[1]);
assert.ok(maxW, '.wrap 没写死 max-width（改成 ch/%/rem 就没人算得出来了）');
const padX = (wrap.body.match(/padding\s*:\s*0\s+(\d+)px/) || [])[1];
assert.ok(padX, '.wrap 的水平 padding 不是 `0 Npx` 形式，这条判据失效了');
const textW = maxW - Number(padX) * 2;
assert.equal(
  textW, 660,
  `正文内容宽 ${textW}px（${maxW} - 2×${padX}）≠ 亲定的 660px —— 660 是中英混排/代码长行与中文折行之间的有余量取值`
);
ok(`T-01 正文内容宽 ${textW}px（.wrap ${maxW} - 2×${padX}）= 660px / 38.8 汉字 / 72ch`);

/* ---------- T-11 [P-096] 宽屏正文列别把 T-01 量到的宽度静默覆盖掉 ---------- */

/* T-01 只量 .wrap，但 1080px 以上 .post-article 自己开了 grid，正文是哪一列
   由 `minmax(0, Npx)` 说了算。实测 N=780 时 T-01 照样绿，浏览器里正文却是
   45.9 个中文字 / 88ch —— 断言落在被覆盖的那一层上，等于没测。
   判据挂在两处独立来源：.wrap 的可用宽（T-01 已算）与宽屏列宽，必须相等。 */
const wideCols = blocks.filter((b) => b.sel === '.post-article' && /grid-template-columns/.test(b.body));
assert.ok(wideCols.length >= 3, `正文列规则只找到 ${wideCols.length} 条（基础 + 1080/1400），判据失效`);
/* 会改写行宽的断点各有自己的列声明；一个写错就能让该档行宽跑掉，而 T-01 全绿。
   独立计数锁住「确实有两档写了 px」（基础那条是 minmax(0,1fr)，不含 px，被下面滤掉）；
   1600 档只放宽容器、列宽沿用 1400 的，不需要自己再写一遍 —— 这条数到 3 才是漏写。 */
const pxCols = wideCols
  .map((b) => [...b.body.matchAll(/minmax\(\s*0\s*,\s*(\d+)px\s*\)/g)].map((m) => Number(m[1])))
  .filter((s) => s.length);
assert.equal(pxCols.length, 2, `只解析到 ${pxCols.length} 个固定列断点，应有 2 个（1080/1400）`);
for (const cols of pxCols) {
  assert.deepEqual(
    cols,
    [textW],
    `宽屏正文列 ${cols.join(',')}px ≠ .wrap 可用宽 ${textW}px —— 正文行宽被媒体查询改掉了，T-01 看不见`
  );
}
ok(`T-11 [P-096] 两档宽屏正文列都为 ${textW}px，与 .wrap 可用宽同源`);

/* ---------- T-12 全站数字等宽：声明必须落在 body，不能只落在后台 ---------- */

const bodyRule = blocks.find((b) => b.sel === 'body' && /font-family:\s*var\(--sans\)/.test(b.body));
assert.ok(bodyRule, '找不到 body 的排版规则，判据失效');
assert.match(
  bodyRule.body,
  /font-variant-numeric:\s*tabular-nums lining-nums/,
  'body 没声明 tabular-nums lining-nums：统计页/对比表的数字宽度交给字体心情'
);
ok('T-12 [P-096] body 声明 tabular-nums lining-nums，前台数字与后台同口径');

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

/* ---------- T-05 正文链接：静态暖深棕可辨，hover 才进铁锈橙 ---------- */

/* 取独立声明，不能拿 /color:/ 直接搜：`border-bottom-color` 里那段同名子串
   会让「hover 进橙」的判据在只有下划线变色时也恒绿 —— 注入验证时栽过一次。 */
const decl = (body, prop) =>
  body.split(';').map((s) => s.trim()).find((s) => new RegExp(`^${prop}\\s*:`).test(s));

const mdA = blocks.find((b) => b.sel === '.md a');
assert.ok(mdA, '找不到 .md a 规则 —— 正文链接的判据失效了');
/* 静止态必须可辨：不能再是 inherit（连下划线都细到看不清时读者不知道能点）。
   判据挂在两个独立来源上：① 包含 color-mix 派生 ② 同时混了 --fg 和 --accent。
   只查 color-mix 不足以证明「暖棕」—— 混两个 --fg 也是 mix，但等于没染。 */
const staticVal = decl(mdA.body, 'color');
assert.ok(staticVal, '.md a 没有 color 声明，静止态又回到无信号');
assert.match(staticVal, /color-mix\(/, `正文链接静态色不是派生色：${staticVal.trim()}`);
assert.match(staticVal, /var\(--fg\)/, '暖棕没混 --fg —— 换皮肤会失配，且可能只剩橙');
assert.match(staticVal, /var\(--accent\)/, '暖棕没混 --accent —— 那就是正文色，静止态仍不可辨');
assert.ok(!/^color:\s*inherit/.test(staticVal), '正文链接又退回 inherit，静止态零色信号');
assert.match(
  mdA.body,
  /border-bottom:\s*1px solid var\(--line-strong\)/,
  '下划线没用 --line-strong：--line 是给分隔线算的，在纸底上等于没画'
);
/* 全局 `a:hover { color: var(--accent) }`  specificity 与本条相同，但 .md a 写在它后面 —— 
   hover 不显式写 color 就永远停在静态棕。 */
/* 键盘 focus 与 hover 共用同一条规则：触屏没有 hover，键盘用户也不能只靠指针 */
const mdAHover = blocks.find((b) => b.sel.startsWith('.md a:hover'));
assert.ok(mdAHover, '找不到 .md a:hover');
assert.ok(mdAHover.sel.includes('.md a:focus-visible'), 'focus-visible 没和 hover 共用规则（键盘用户没有反馈）');
const hoverColor = decl(mdAHover.body, 'color');
assert.ok(hoverColor, '.md a:hover 没有独立 color 声明，hover 反馈失效');
assert.match(
  hoverColor,
  /^color:\s*var\(--accent\)/,
  `hover 没进铁锈橙（拿到的是 ${hoverColor.trim()}）：静态棕 + hover 无变化 = 没有反馈`
);
const rootTok = blocks.find((b) => b.sel === ':root');
assert.ok(rootTok, '找不到基准 :root');
assert.match(
  rootTok.body,
  /--line-strong\s*:\s*color-mix\(/,
  '--line-strong 没从 fg/line 派生 —— 换皮肤（七套 fg/line 各不相同）会失配'
);
ok('T-05 正文链接静态暖深棕（--fg/--accent 派生）+ hover 进铁锈橙');

/* ---------- T-13 全站正文字号单一基准：首页 16.5 / 文章 17 的两档必须收成一档 ---------- */

const bodyBlock = blocks.find((b) => b.sel === 'body');
assert.ok(bodyBlock, '找不到 body 规则 —— 字号判据失效了');
const bodyFs = Number((bodyBlock.body.match(/font-size:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
const postBody = blocks.find((b) => b.sel === '.post-body');
assert.ok(postBody, '找不到 .post-body 规则 —— 字号判据失效了');
const postFs = Number((postBody.body.match(/font-size:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
assert.equal(bodyFs, 17, `全站正文基准 ${bodyFs}px ≠ 17px —— 首页与文章页会跳档`);
assert.equal(postFs, bodyFs, `文章正文 ${postFs}px ≠ 全站基准 ${bodyFs}px —— 点进文章字号跳一下`);
assert.ok(!/16\.5px/.test(CSS), 'CSS 里还留着 16.5px —— 第二档字号没清干净');
ok(`T-13 全站正文单一基准 ${bodyFs}px：首页 body 与 .post-body 同源，无 16.5 残留`);

/* ---------- T-06 [P-089] 打印段唯一且四件事齐全 ---------- */

const printCount = (CSS.match(/@media print\s*\{/g) || []).length;
assert.equal(
  printCount,
  1,
  `@media print 有 ${printCount} 段 —— 后一段会整体覆盖前一段，改一处等于没改`
);
const printCss = CSS.slice(CSS.indexOf('@media print'));
assert.match(printCss, /@page\s*\{[^}]*margin:/, '打印没设页边距，正文会贴到纸边');
assert.match(printCss, /attr\(href\)/, '打印没把链接地址印出来 —— 纸上点不了');
assert.match(printCss, /\*\s*\{\s*box-shadow:\s*none\s*!important/, '打印没清阴影，纸面会多一圈脏灰');
assert.match(printCss, /--fg:\s*#000/, '打印没洗 token：深色模式的 --fg 是浅灰，印在白纸上会看不见');
ok('T-06 [P-089] 打印段唯一：页边距 / 黑字 / 去阴影 / 链接地址');

/* ---------- T-07 [P-090] 侧栏目录只有缩进，没有左侧色条 ---------- */

const tocOl = blocks.find((b) => b.sel === '.post-toc ol');
assert.ok(tocOl, '找不到 .post-toc ol');
assert.doesNotMatch(tocOl.body, /border-left|::before/, '目录容器还挂着左侧色条/进度条');
const tocA = blocks.find((b) => b.sel === '.post-toc a');
assert.ok(tocA, '找不到 .post-toc a');
assert.doesNotMatch(tocA.body, /border-left/, '目录项还挂着左侧色条，应只靠缩进与颜色');
ok('T-07 [P-090] 目录纯缩进：无 border-left、无进度条');

/* ---------- T-08 [P-091] 行号行高必须按 px 对齐代码行 ---------- */

const codeRule = blocks.find((b) => b.sel === '.md pre.code-block' && /font-size/.test(b.body));
const gutRule = blocks.find((b) => b.sel === '.md pre.code-block > .gutter');
assert.ok(codeRule && gutRule, '代码块或行号规则不见了');
const cFs = Number((codeRule.body.match(/font-size:\s*([\d.]+)px/) || [])[1]);
const cLh = Number((codeRule.body.match(/line-height:\s*([\d.]+)/) || [])[1]);
const gLh = Number((gutRule.body.match(/line-height:\s*([\d.]+)px/) || [])[1]);
assert.ok(cFs && cLh && gLh, `读不到字号/行高：code ${cFs}/${cLh}，gutter ${gLh}`);
assert.ok(
  Math.abs(gLh - cFs * cLh) < 0.01,
  `行号行高 ${gLh}px ≠ 代码行高 ${cFs}×${cLh}=${(cFs * cLh).toFixed(1)}px —— 十几行后编号就跑到代码下面`
);
ok(`T-08 [P-091] 行号行高 ${gLh}px 与代码行 ${cFs}×${cLh} 对齐`);

/* ---------- T-09 [P-092] 打印态 token 必须压过皮肤文件 ---------- */

/* 六套皮肤是独立 CSS，最强的一条是 :root[data-theme="x"][data-mode="dark"]，
   权重 (0,3,0)；print 段只有 :root (0,1,0) / :root[data-mode="dark"] (0,2,0)。
   不写 !important 就压不住：ink + 深色打印出来是 #0e0e10 深底浅字（浏览器实测）。
   判据锚在「print 段内每个必需 token 恰好声明一次且带 !important」——
   唯一计数是为了防「别处补一条同名声明把断言凑绿」。 */
const printStart = CSS.indexOf('@media print');
const printEnd = CSS.indexOf('\n.md .code-meta', printStart);
assert.ok(printStart > 0 && printEnd > printStart, 'print 段的起止锚点失效了');
const printBlock = CSS.slice(printStart, printEnd);
const FLATTEN = [
  '--bg', '--bg-soft', '--fg', '--fg-soft', '--muted',
  '--line', '--line-strong', '--accent', '--accent-soft',
  '--tok-k', '--tok-s', '--tok-n', '--tok-f',
];
for (const tok of FLATTEN) {
  const decls = printBlock.match(new RegExp(`${tok}:[^;]*;`, 'g')) || [];
  assert.equal(decls.length, 1, `print 段里 ${tok} 声明了 ${decls.length} 次，应当恰好 1 次`);
  assert.match(
    decls[0],
    /!important/,
    `print 段的 ${tok} 没写 !important —— 皮肤 :root[data-theme][data-mode] 权重 (0,3,0) 会整条压过它`
  );
}
ok(`T-09 [P-092] 打印态 ${FLATTEN.length} 个 token 全部 !important，压过皮肤文件`);

/* ---------- T-10 [P-093] 打印体检的路由清单必须覆盖全部页面出口 ---------- */

/* 待查清单是手写在 check-print.mjs 里的，所以「新加一个页面」不会自己进来。
   这里把 src/index.js 里每个 `path === '/xxx'` 字面量捞出来，和体检清单对账。
   两个坑各防一道：
     · 只做「清单 ⊇ 源码」的判定 → 源码被重构成查表、正则一个都抓不到时恒绿。
       故加独立下限：字面量少于 25 条就当判据失效（当前 30 条）。
     · 非页面出口（RSS / sitemap / auth / 头像…）必须逐条列进 NON_PAGE 并给理由，
       新加一个接口时必然要在这里表态，不会因为「不在清单里」被静默排除。 */
const INDEX = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const PRINT = readFileSync(new URL('./check-print.mjs', import.meta.url), 'utf8');
const lits = [...new Set([...INDEX.matchAll(/path === '(\/[^']*)'/g)].map((m) => m[1]))];
assert.ok(lits.length >= 25, `只找到 ${lits.length} 条 path 字面量，正则已失效，本断言无意义`);
const NON_PAGE = new Set([
  '/auth/github', '/auth/callback', '/auth/logout', '/auth/status', // 302 / JSON
  '/avatar', // 头像代理，二进制
  '/rss.xml', '/sitemap.xml', '/robots.txt', '/llms.txt', '/manifest.webmanifest', // 非 HTML
]);
/* 体检清单里除字面量外还有四个「运行时取到才发现」的地址：标签 / 分类 / 系列
   详情 / 年归档。它们各自对应源码里的一条前缀或正则路由，缺一条就等于那类页面
   没被渲染过 —— 所以按占位符名字计数，而不是按字面量。 */
const placeholders = [...PRINT.matchAll(/\[links\.(tag|cat|series|year),/g)].map((m) => m[1]);
assert.deepEqual(
  placeholders.sort(),
  ['cat', 'series', 'tag', 'year'],
  `体检清单里的动态路由占位符变成 ${placeholders.join(',')}，标签/分类/系列详情/年归档有一类没验`
);
const norm = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const listed = new Set([...PRINT.matchAll(/'(\/[^'?]*)'/g)].map((m) => norm(m[1])));
const missing = lits.filter((p) => !NON_PAGE.has(norm(p)) && !listed.has(norm(p)));
assert.deepEqual(
  missing,
  [],
  `这些页面出口没进打印体检清单：${missing.join(' ')} —— 补进 check-print.mjs 的 routes 数组再跑一遍`
);
const pages = new Set(lits.filter((p) => !NON_PAGE.has(norm(p))).map(norm));
ok(`T-10 [P-094] 打印体检覆盖 ${lits.length} 个出口里的 ${pages.size} 个 HTML 页面`);

/* ---------- T-14 行内代码退中性：铁锈橙不再同时说「技术 token」 ----------
   `--accent` 在正文里同时扛行内代码 / 当前项 / 引用边框 / 摘要边框四件事（P-107），
   信号被摊薄。行内代码改用 --fg-soft：八套主题明暗两档都有它，暗色自动跟随，
   不需要新增规则；pre 里的 .tok-* 是独立类、pre code 是 inherit，四色高亮不动。 */
const mdCode = blocks.find((b) => b.sel === '.md code' && /font-family/.test(b.body));
assert.ok(mdCode, '找不到 .md code 的排版规则，判据失效');
const codeColor = decl(mdCode.body, 'color');
assert.ok(codeColor, '.md code 没有 color 声明');
assert.match(
  codeColor,
  /^color:\s*var\(--fg-soft\)/,
  `行内代码又染回强调色或裸值（拿到 ${codeColor.trim()}）：中性退后失效`
);
/* 光改 .md code 不够：有人在 pre 里塞一条 color 覆盖，四色高亮就被连带洗掉。 */
const preCode = blocks.find((b) => b.sel === '.md pre.code-block code');
assert.ok(preCode, '找不到 pre.code-block code 规则，四色高亮的隔离层没了');
assert.match(decl(preCode.body, 'color') || '', /^color:\s*inherit/, 'pre code 不再 inherit，行内代码色会漏进代码块');
const tokClasses = ['tok-k', 'tok-s', 'tok-n', 'tok-f'];
for (const k of tokClasses) {
  const b = blocks.find((x) => x.sel === `.${k}`);
  assert.ok(b, `找不到 .${k}，四色高亮缺一角`);
  assert.match(decl(b.body, 'color') || '', /^color:\s*var\(--tok-[ksnf]\)/, `.${k} 不再走 --tok-*，四色被写死`);
}
ok('T-14 [P-107] 行内代码退 --fg-soft，四色 token 与 pre 隔离层仍在');

console.log(`\n[P-086] typography: ${pass} passed`);
