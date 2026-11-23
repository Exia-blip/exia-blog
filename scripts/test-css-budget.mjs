// CSS 体积预算守门：防止把参考模板整份拷进来之后「越抄越多」。
//
// 基线（2026-11-23 实测，工作区 LF，Node zlib.gzipSync level 9 口径）：
//   public/style.css  142039 B → gzip -9 后 37626 B（shell gzip -9 得 37104 B，口径略有差异）
//   public/theme/*.css 共 6313 B / 5 个文件
// 预算留约 3.7% 余量——要超预算先删死代码；确实要加，显式改这里的数字
// 并在 commit message 写明原因，别让阈值悄悄漂移。
//
// 为什么不用「首屏 CSS ≤ 8KB / gzip ≤ 3KB」：本站 style.css 覆盖 455 个类，
// 含 7 套主题、后台全套、代码块/灯箱/评论/编辑器，和单页模板不是一个量级。
// 硬套 3KB 等于删掉 90% 样式，属于重写视觉系统而不是优化。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUDGET = { mainGzip: 39000, themesRaw: 7000 };

const read = (f) => fs.readFileSync(path.join(ROOT, f));
const mainCss = read('public/style.css');
const mainGzip = zlib.gzipSync(mainCss, { level: 9 }).length;
const themeDir = path.join(ROOT, 'public/theme');
const themes = fs.readdirSync(themeDir).filter((f) => f.endsWith('.css'));
const themesRaw = themes.reduce((sum, f) => sum + fs.readFileSync(path.join(themeDir, f)).length, 0);

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

console.log('[CSS 体积预算]');
check(mainGzip <= BUDGET.mainGzip, `主样式 gzip -9 ${mainGzip} B ≤ 预算 ${BUDGET.mainGzip} B`);
check(themesRaw <= BUDGET.themesRaw, `${themes.length} 套主题共 ${themesRaw} B ≤ 预算 ${BUDGET.themesRaw} B`);
// 内容哈希对字节敏感，CRLF 会让本地与 CI 算出不同的 manifest（test-sri 已从 SRI 角度守过，这里守体积口径）
check(!/\r\n/.test(mainCss.toString('utf8')), '主样式为 LF 行尾（体积口径与 CI checkout 一致）');

if (fail) {
  console.error(`CSS 体积预算超支 ${fail} 项`);
  process.exit(1);
}
