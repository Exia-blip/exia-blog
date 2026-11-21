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

const body = `${header}export const ASSET_HASH = {\n${rows.join('\n')}\n};\n`;

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
