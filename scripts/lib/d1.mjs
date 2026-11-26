/* D1 查询的公共入口 —— **直接跑 node_modules 里的 wrangler.js，不走 npx**。

   两层坑，都在这台机器上实际栽过：
   ① `execFileSync('npx', …)` → Windows 上是 `npx.cmd`，node 直接拉不起来，
      报 `spawnSync npx ENOENT`，而错误信息只指向 spawnSync，看起来像路径问题；
   ② 退化成 `shell: true` 再拼字符串 → 带空格的 SQL 会被 shell 拆成十几个参数
      （`--command` 后面的 SQL 被当成列名列表），报错却是 SQL 语法错。
   所以统一用 `process.execPath` + wrangler.js 的绝对路径，shell 全程不参与。

   重试：这个环境里代理偶发 `fetch failed`（约 1/4 概率），重跑即通。
   重试只对**读**无条件安全；写库的语句由调用方保证幂等，或在 finally 里恰好执行一次。 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export const WRANGLER = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
export const DEFAULT_DB = 'blog-db';

const once = (args) =>
  execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const run = (args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return once(args);
    } catch (e) {
      const transient = /fetch failed|ETIMEDOUT|ECONNRESET/i.test(String(e.stderr || e.message));
      if (!transient || attempt >= 3) throw e;
      process.stderr.write(`  [重试 ${attempt}/3] D1 连接抖动，稍候再试…\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    }
  }
};

/** 执行一条 SQL 并返回 rows。wrangler 会把日志和 JSON 混着打到 stdout，
    从第一个 `[{ "results"` 开始截；解析失败时把原始输出前 300 字带进错误里。 */
export function d1Query(sql, { local = false, db = DEFAULT_DB } = {}) {
  const out = run(['d1', 'execute', db, local ? '--local' : '--remote', '--json', '--command', sql]);
  const i = out.search(/\[\s*\{\s*"results"/);
  if (i < 0) throw new Error(`取不到 JSON：${out.slice(0, 300)}`);
  return JSON.parse(out.slice(i))[0].results || [];
}

/** SQL 字符串字面量转义。手拼 SQL 时一律走它，别自己拼引号。 */
export const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
