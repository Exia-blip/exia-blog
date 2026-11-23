// P-004 构建期守门：把「五次串行往返压成一次」写成源码结构断言。
// 不测运行时 TTFB —— 那会随链路抖动，进了 CI 就是噪音。这里只守住并行的形状：
// 查询先发车、再一起 await，谁把它改回一串 await 就红。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { report } from './pitfall-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const index = readFileSync(`${ROOT}/src/index.js`, 'utf8');
const api = readFileSync(`${ROOT}/src/api.js`, 'utf8');

let bad = 0;
const check = (id, name, cond, detail = '') => {
  if (!report(id, name, cond, detail)) bad++;
};

const waitAt = index.indexOf('Promise.all([siteP, catsP, tagsP])');
const listAt = index.indexOf('const listP = listQuery(env, url)');
check('P-004', '首页三路查询并行 await', waitAt > 0, `Promise.all 位置 ${waitAt}`);
check('P-004', '列表查询在等待前发车', listAt > 0 && listAt < waitAt, `listP=${listAt} await=${waitAt}`);
check('P-004', 'COUNT 与列表同批发车',
  api.includes('const [{ results }, totalRow] = await Promise.all(['),
  'api.js 同批解构 results + totalRow');

console.log(bad ? `\n✗ ${bad} 项并行结构断言失败` : '\n✓ 并行结构守门通过');
process.exit(bad ? 1 : 0);
