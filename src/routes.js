/* 路径规范化：把「差一个字符就 404」的 URL 收敛到规范形式。
 *
 * 两种情况，一条规则解决：
 *   1) 尾部斜杠 —— /p/editor-autosave/ → /p/editor-autosave
 *      来源：手滑、工具自动补、爬虫拼接、从别的站复制过来
 *   2) 大小写 —— /tag/Cloudflare → /tag/cloudflare
 *      来源：外链手写、编辑器自动首字母大写、引用时改了大小写
 *
 * 一律 301，不在内部静默改写。理由：同一篇文章只该有一个地址。
 * 内部改写能让两条 URL 都返回 200，但 sitemap、canonical、外链统计会分裂成两份；
 * 301 把权重和统计都并到规范地址上，而且浏览器和爬虫都认。
 *
 * 只处理站内自己的页面路由。`/img/`、`/thumbs/`、静态资源文件名（app.js、style.css、
 * R2 对象键）大小写敏感 —— 动它们不是修 404，是制造 404。
 */

const PAGE_PREFIX = /^\/(p|tag|cat)\//i;
const ARCHIVE = /^\/archive(\/|$)/i;

export function normalizePagePath(path) {
  if (!path || path === '/') return '/';

  let p = path;
  if (p.endsWith('/')) p = p.replace(/\/+$/, '');
  if (!p) return '/';

  /* 带百分号编码的路径（中文标签、中文旧栏目链接）到此为止：只去尾斜杠。
     对这些路径做 toLowerCase 会把 %E5%B0%8F 变成 %e5%b0%8f —— 解码结果一样，
     但地址变丑，而且要多跳一次才能到真正的规范地址。中文本来也没有大小写。 */
  if (p.includes('%')) return p;

  // 页面前缀：把整段小写化（slug 与标签名在库里全部小写，见 seed 白名单）
  if (PAGE_PREFIX.test(p) || ARCHIVE.test(p)) return p.toLowerCase();

  // 根级单段（/about、/editor、/editor-autosave 这类，文件与 slug 全小写）
  if (/^\/[^/]+$/.test(p)) return p.toLowerCase();

  return p;
}
