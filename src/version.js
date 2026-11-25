/* 展示用语义版本：页脚那一行 v1.2.6，与 git tag / GitHub Release 同名。
 *
 * 它不是资源版本号，别混用。资源那条链有两个来源，都不归它管：
 *   1. 内容哈希（assets.gen.js）—— css/js 改没改由字节决定，URL 才对得上缓存；
 *   2. 部署号（SITE_VERSION，deploy.mjs 注入 Date.now().toString(36)）—— 给
 *      thumbs/cards 这类没进 manifest 的文件兜底。
 * 把 semver 塞进 ?v= 会让「发了新内容」和「版本没变」同时成立，缓存就永远不换。
 *
 * 单一事实源仍是 package.json 的 version；test-site-footer 有一条断言锁住两者
 * 相等，只改一处会先红。手工维护这一行的代价，比在 Worker 里解析 JSON 小得多。
 */
export const SITE_RELEASE = '1.2.6';
