#!/usr/bin/env node
/**
 * 给静态资源算内容哈希 + SRI 摘要，产出 src/assets.gen.js。
 *
 *   node scripts/build-sri.mjs          重算并写文件
 *   node scripts/build-sri.mjs --check  只校验，不同步就退出码 1（发版闸门用）
 *
 * 为什么要内容哈希而不是部署序号：
 *   以前 ?v=<Date.now()> 每次部署都变，哪怕只改了一行文档，全站 CSS/JS 的 URL
 *   也跟着变，一年强缓存形同虚设 —— 用户每次发版都要重下 121KB 的 style.css。
 *   换成内容哈希后，没改动过的文件 URL 不变，缓存跨部署继续命中；
 *   改过的文件 URL 变了，缓存自然失效。immutable 这时才是真的安全。
 *
 * 为什么同时算 SRI：
 *   integrity 只能写死哈希，写死的值必须和**实际字节**对上。线上实测
 *   （curl 回来算 sha384 与本地文件逐字节相同）确认 Workers Static Assets
 *   不会对 js/css 做压缩改写，所以本地算的值就是浏览器会校验的值。
 *   一旦某天 CF 改了行为，这个脚本算出来的哈希会让页面白屏 —— 所以
 *   test-sri.mjs 里有一条「线上字节 == 本地字节」的实打实校验，发版时兜底。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { INLINE_THEMES } from '../src/theme-contract.js';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PUB = join(ROOT, 'public');
const OUT = join(ROOT, 'src', 'assets.gen.js');
const CHECK = process.argv.includes('--check');

/* 收哪些文件：
   - public 根下的 .js / .css（页面直接引的）
   - public/theme/*.css（首屏脚本按主题名拼出来加载的）
   - public/vendor/**（自托管第三方，体积大、更该锁完整性）
   刻意不收 /thumbs /cards 的图片：数量上百，SRI 对 <img> 没意义
   （img 不支持 integrity），它们的缓存靠 ?v= 就够。 */
function collect() {
  const files = [];
  for (const name of readdirSync(PUB)) {
    if (/\.(js|css)$/i.test(name)) files.push(name);
  }
  const themeDir = join(PUB, 'theme');
  if (existsSync(themeDir)) {
    for (const name of readdirSync(themeDir)) {
      if (/\.css$/i.test(name)) files.push(`theme/${name}`);
    }
  }
  const vendorDir = join(PUB, 'vendor');
  if (existsSync(vendorDir)) {
    for (const name of readdirSync(vendorDir)) {
      if (/\.(js|css)$/i.test(name)) files.push(`vendor/${name}`);
    }
  }
  return files.sort();
}

/* 主题色从 CSS 自己读，不手抄。
   theme-color 的语义就是「地址栏该用哪个色」，而那个色的唯一事实来源是 --bg。
   以前 index.js 手写一份 THEME_COLOR 常量：加第 8 套主题时它不在任何断言里，
   漏了就是「后台换主题生效了，手机地址栏还是上一套的颜色」。
   现在这份表是构建产物，主题文件改了底色，重算哈希时一起更新。
   内联在主表里的两套（纸韵裸 :root、安知鱼 data-theme 块）也一并读，
   保证 THEME_BG 覆盖全部主题，而不是只覆盖有独立文件的那些。 */
function themeBg() {
  const out = {};
  const bgOf = (block) => (block.match(/--bg:\s*(#[0-9a-fA-F]{3,8})/) || [])[1] || '';
  const themeDir = join(PUB, 'theme');
  if (existsSync(themeDir)) {
    for (const name of readdirSync(themeDir).sort()) {
      if (!/\.css$/i.test(name)) continue;
      const id = name.replace(/\.css$/i, '');
      const text = readFileSync(join(themeDir, name), 'utf8');
      const m = text.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
      const bg = m && bgOf(m[1]);
      if (bg) out[id] = bg;
    }
  }
  const main = readFileSync(join(PUB, 'style.css'), 'utf8');
  const bare = main.match(/(?:^|\n):root\s*\{([\s\S]*?)\n\}/);
  let bareUsed = false;
  for (const id of INLINE_THEMES) {
    const own = main.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
    /* 内联主题两种写法：有自己选择器的（安知鱼），或者就是裸 :root 的基准（纸韵）。
       基准只可能有一个 —— 裸 :root 只许分配给第一个没有自己选择器的主题。 */
    let block = own ? own[1] : '';
    if (!block && !bareUsed && bare) {
      block = bare[1];
      bareUsed = true;
    }
    const bg = block && bgOf(block);
    if (bg) out[id] = bg;
  }
  return out;
}

const files = collect();
const map = {};
const rows = [];
const crlf = [];
for (const f of files) {
  const buf = readFileSync(join(PUB, f));
  /* 行尾必须与 git 索引一致（.gitattributes 定的是 LF）。
     Windows 上某些工具/编辑器会把文件写回 CRLF：本地算出的哈希是按 CRLF 字节来的，
     部署到线上去也是 CRLF，线上自洽、本地测试也绿 —— 但 CI checkout 出来是 LF，
     哈希立刻对不上，单元测试红。这个坑 2026-11-22 真踩过一次（app.js）。
     宁可在这里硬失败，也不要让不一致的 manifest 溜进发版流程。 */
  if (buf.includes('\r\n')) crlf.push(f);
  const sha = createHash('sha384').update(buf).digest('base64');
  // 版本号取摘要前 10 位字母数字（去掉 +/），够短也够区分
  const v = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  map[f] = { v, i: `sha384-${sha}` };
  rows.push(`  '${f}': { v: '${v}', i: 'sha384-${sha}' },`);
}

if (crlf.length) {
  console.error(`[sri] 这些文件是 CRLF 行尾，哈希会与仓库里的 LF 版本对不上：`);
  for (const f of crlf) console.error(`  public/${f}`);
  console.error(`[sri] 转成 LF 再跑：` +
    `node -e "const fs=require('fs');for(const f of ${JSON.stringify(crlf.map((f) => 'public/' + f))}){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\\r\\n/g,'\\n'))}"`);
  process.exit(1);
}

const header = `/* 自动生成，不要手改。改完 public 里的 js/css 跑一次：
 *   npm run build:sri
 * 测试里有一条会校验这份表与磁盘文件是否同步，忘了跑会被发版闸门拦下。 */
`;

const bgMap = themeBg();
const bgRows = Object.entries(bgMap).map(([k, v]) => `  '${k}': '${v}',`);

const body = `${header}export const ASSET_HASH = {\n${rows.join('\n')}\n};\n\n` +
  `/* 各主题的 --bg，给 theme-color 与 PWA manifest 用（[P-055]）。
   构建期从 CSS 读出来，所以「改了主题底色但忘了改常量」这种漏法不存在了。 */\n` +
  `export const THEME_BG = {\n${bgRows.join('\n')}\n};\n`;

if (CHECK) {
  const old = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  // 只比较内容主体，注释改字不算不同步
  const norm = (s) => s.replace(/^\/\*[\s\S]*?\*\/\n?/, '').trim();
  if (norm(old) === norm(body)) {
    console.log(`[sri] ${files.length} 个文件，manifest 已同步`);
    process.exit(0);
  }
  console.log(`[sri] manifest 与磁盘不一致，跑 npm run build:sri`);
  process.exit(1);
}

const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
writeFileSync(OUT, body, 'utf8');
console.log(`[sri] 写入 ${relative(ROOT, OUT)} · ${files.length} 个文件`);
if (prev && prev !== body) {
  const before = {};
  for (const m of prev.matchAll(/'([^']+)': \{ v: '([^']+)'/g)) before[m[1]] = m[2];
  const changed = Object.keys(map).filter((k) => before[k] !== map[k].v);
  const added = Object.keys(map).filter((k) => !before[k]);
  if (changed.length) console.log(`[sri] 内容变了：${changed.join('、')}`);
  if (added.length) console.log(`[sri] 新增：${added.join('、')}`);
}
