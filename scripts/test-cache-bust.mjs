/* 边缘缓存的「清得掉」断言（CB-01~CB-07）。
 *
 * 为什么需要这一组：缓存写错会立刻现形（页面变慢），缓存「清」写错不会——
 * 页面照样 200，只是内容停在发布前那一版，5 分钟后自己好。这类错误
 * 人工验收抓不到，只能靠「清的清单」和「存的清单」逐项对账。
 *
 * 纯源码静态分析：不连 D1、不起 Worker、不碰网络。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = readFileSync(join(ROOT, 'src/api.js'), 'utf8');
const idx = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
const cache = readFileSync(join(ROOT, 'src/cache.js'), 'utf8');

let bad = 0;
const check = (id, name, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'pass' : 'FAIL'}  [${id}] ${name.padEnd(30)} ${detail}`);
};

/* bust() 函数体：从定义到下一个顶层 function 之前 */
const bustStart = api.indexOf('async function bust(url');
const bustEnd = api.indexOf('\nfunction bustFriends(', bustStart);
const bustBody = bustStart >= 0 && bustEnd > bustStart ? api.slice(bustStart, bustEnd) : '';
const bustCalls = api
  .split('\n')
  .filter((l) => l.includes('bust(url') && !/^(async )?function bust\(url/.test(l.trim()));

check('CB-01', 'bust 存在且可查', bustBody.length > 200, `函数体 ${bustBody.length} 字节`);

/* 存的形态由 isPagePath 决定，清的形态必须覆盖它认的每一类。
   两类最容易漏：/tag/ 与 /series/ —— 它们不含 slug，按 slug 清清不到。 */
check(
  'CB-02',
  'tag 页全部加入清理清单',
  /SELECT name FROM tags/.test(bustBody) && /`\/tag\/\$\{encodeURIComponent/.test(bustBody),
  /SELECT name FROM tags/.test(bustBody) ? '查库枚举 + 编码拼接' : '缺 tags 枚举'
);

check(
  'CB-03',
  'series 页全部加入清理清单',
  /SELECT DISTINCT series FROM posts/.test(bustBody) && /`\/series\/\$\{encodeURIComponent/.test(bustBody),
  /SELECT DISTINCT series/.test(bustBody) ? '查库枚举 + 编码拼接' : '缺 series 枚举'
);

/* 带 query 的分页 / 搜索页：键不可枚举 → 清不掉；且 ?q= 能被刷出无限条。
   正确做法是根本不进缓存，而不是"进缓存再想办法清"。 */
/* 从 const cacheable 到该语句结束的分号，中间允许有注释（注释里也有反引号）。 */
const cacheableLine = (() => {
  const at = idx.indexOf('const cacheable');
  if (at < 0) return '';
  const seg = idx.slice(at, at + 1600);
  const end = seg.indexOf(';');
  return end > 0 ? seg.slice(0, end) : seg;
})();
check(
  'CB-04',
  '带 query 的页面不进缓存',
  /!url\.search/.test(cacheableLine),
  /!url\.search/.test(cacheableLine) ? '已排除全部分页与搜索变体' : '分页/搜索键无法枚举，属漏清'
);

/* 清和存必须用同一种 URL 形态，否则 key 对不上，delete 静默无效。 */
const putSrc = cache.slice(cache.indexOf('export async function edgePut'));
const putKey = /caches\.default\.put\(cacheUrl\(url\)/.test(putSrc);
const bustKey = /bustPaths\(url\.origin, paths\)/.test(bustBody);
const cacheUrlNorm = /export function cacheUrl\(url\)\s*\{\s*return new URL\(url\)\.toString\(\);/.test(cache);
check(
  'CB-05',
  '存与清用同一个键规范化',
  putKey && bustKey && cacheUrlNorm,
  `put=${putKey ? 'cacheUrl' : '?'} bust=${bustKey ? 'new URL(p,origin)' : '?'}`
);

/* 每个写入路径（落库之后）都要挂一次 bust。漏一个就是那条路径永远 5 分钟陈旧。 */
const writeMarks = ['post.create', 'post.update', 'post.delete', 'post.restore'];
const missingWrite = [];
for (const mark of writeMarks) {
  const at = api.indexOf(`'${mark}'`);
  if (at < 0) {
    missingWrite.push(`${mark}:未找到`);
    continue;
  }
  const window = api.slice(at, at + 900);
  if (!window.includes('bust(url')) missingWrite.push(`${mark}:后 900 字节内无 bust`);
}
check(
  'CB-06',
  '四条文章写路径都清缓存',
  missingWrite.length === 0,
  missingWrite.length ? missingWrite.join(' / ') : `${writeMarks.length}/${writeMarks.length} 已挂`
);

/* bust 本身不能阻塞响应：delete 是边缘存储往返，串在发布请求里会让
   "发布按钮"变成一次网络抖动的受害者。全部走 ctx.waitUntil。 */
const blocking = bustCalls.filter((l) => !l.includes('waitUntil'));
check(
  'CB-07',
  'bust 全部走 waitUntil',
  blocking.length === 0,
  blocking.length ? `${blocking.length} 处同步调用` : `${bustCalls.length} 处调用全部异步`
);

/* 进程内缓存与边缘缓存是两层，清一层漏一层等于没清。 */
check(
  'CB-08',
  'bust 同时清进程内缓存',
  bustBody.includes('postCacheDrop()'),
  bustBody.includes('postCacheDrop()') ? 'postCacheDrop 在 bust 首行' : '漏清 LRU'
);

/* 只让 Worker 内不写还不够：CF 边缘看响应头自己也会存一份。
   两处口径必须同时"带 query 就不缓存"，否则改了一半、看起来像没改。 */
const hardenCall = /harden\(res, env, url\.pathname, url\.search\)/.test(idx);
const hardenBranch = (() => {
  const at = idx.indexOf('else if (search)');
  if (at < 0) return '';
  return idx.slice(at, at + 900);
})();
check(
  'CB-09',
  '边缘头与 Worker 内口径一致',
  hardenCall && /cdn-cache-control', 'no-store'/.test(hardenBranch),
  hardenCall && /cdn-cache-control', 'no-store'/.test(hardenBranch)
    ? 'search 分支同时关掉两层的缓存'
    : 'harden 未收到 search 或未改 cdn-cache-control'
);

/* 单篇写入清的是文章页，但「它属于哪个栏目」是另一次缓存键（/cat/<栏目>）。
   栏目页 300 秒，pending 的稿子放行前根本不在列表里 —— 那一刻是它第一次进栏目，
   漏传栏目就等于给自己造了个 300 秒的「写后读到旧值」窗口（KV 才有的问题，我们本来不用付）。
   判据：凡第二参数带 slug 的 bust 调用，第三参数不许为空数组。 */
const emptyCatsWithSlug = api
  .split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /bust\(url,\s*\[[^\]]+\],\s*\[\]/.test(l));
check(
  'CB-10',
  '单篇写入必须带栏目清缓存',
  emptyCatsWithSlug.length === 0,
  emptyCatsWithSlug.length === 0
    ? '所有带 slug 的写路径都传了栏目'
    : emptyCatsWithSlug.map(([n, l]) => `api.js:${n} ${l.trim().slice(0, 60)}`).join(' | ')
);

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
