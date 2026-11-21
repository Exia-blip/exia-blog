/**
 * 静态资源版本号、SRI 与缓存头。
 *
 * 三层各管一段，混在一起会互相打脸：
 *   1. 内容哈希（assets.gen.js）决定 URL —— 内容不变 URL 就不变，缓存才跨部署有效。
 *   2. integrity 也来自同一份哈希 —— URL 与校验值永远配套，不可能错位。
 *   3. 缓存头只看「URL 上有没有 v」—— 有 v 就是不可变内容，锁一年。
 *
 * 三者只共享一个事实来源（内容哈希），所以不存在「版本号换了、SRI 还是旧的」
 * 这种能让页面白屏又难查的状态。
 */
import { ASSET_HASH } from './assets.gen.js';

/** 部署标识：内容哈希之外的兜底版本（thumbs/cards 这类没进 manifest 的资源） */
export function assetVersion(env) {
  return env.SITE_VERSION || (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || '';
}

/** 静态资源缓存头：带 v 的一年 immutable，其余退开，交给来源头或短缓存 */
export function assetCacheControl(url, upstream = '') {
  if (url?.searchParams.has('v')) return 'public, max-age=31536000, immutable';
  // 预设头图与标题卡：文件名按 slug 固定，内容跟着文章改，给一天而不是一年
  if (url && (url.pathname.startsWith('/thumbs/') || url.pathname.startsWith('/cards/'))) {
    return 'public, max-age=86400, stale-while-revalidate=604800';
  }
  if (!upstream || /max-age=0/.test(upstream)) return 'public, max-age=300, stale-while-revalidate=3600';
  return upstream;
}

const HASHED_FILES = Object.keys(ASSET_HASH).length > 0;

/* 会被 ?v= 覆盖的路径。
   白名单而不是通配：/img/ 走 R2 代理（内容寻址，不需要 v），
   /thumbs/ /cards/ 是构建产物（文件名固定，需要 v 才能长期缓存）。 */
const STAMP = /(["'])\/(style\.css|app\.js|theme\.js|md\.js|boot\.js|cover\.js|avatar\.js|copy-notice\.js|theme\/[^"'?]+|vendor\/[^"'?]+|thumbs\/[^"'?]+|cards\/[^"'?]+)\1/g;

/**
 * 给 HTML 里的静态资源挂版本号，并补 integrity。
 *
 * 挂版本号：没改过的文件跨部署 URL 不变（内容哈希），缓存是真的能用满一年；
 * manifest 里没有的（thumbs/cards）退回部署版本号 —— 图片不该跟着 js/css 的哈希走。
 * og:image 是绝对 URL，正则要求引号后紧跟斜杠，不会误伤。
 *
 * 补 integrity：只认 manifest 里有哈希的。拿不到哈希就不写属性 ——
 * 宁可少校验一次，也不能写一个错的让浏览器把整个脚本丢掉。
 * 已有 integrity 的不覆盖（自托管第三方写死的情况）。
 * 同源资源不加 crossorigin：加了会把请求切成 CORS 模式，同源 Worker
 * 不返回 access-control-allow-origin，脚本直接被拦。
 */
export function stampAssets(body, env) {
  const v = assetVersion(env);
  if (!v && !HASHED_FILES) return body;

  let out = body.replace(STAMP, (m, q, f) => {
    const h = ASSET_HASH[f];
    const ver = h ? h.v : v;
    return ver ? `${q}/${f}?v=${ver}${q}` : m;
  });

  if (!HASHED_FILES) return out;
  return out.replace(/<(script|link)\b([^>]*)>/gi, (tag, name, attrs) => {
    if (/\sintegrity=/i.test(attrs)) return tag;
    const m = attrs.match(/\b(?:src|href)="\/([^"?]+)\?v=[^"]*"/i);
    if (!m) return tag;
    const h = ASSET_HASH[m[1]];
    if (!h) return tag;
    // <script ...> 与自闭合 <link ... /> 都能插，统一插在收尾尖括号之前
    return tag.replace(/\s*(\/?)>$/, ` integrity="${h.i}"$1>`);
  });
}
