// 封面（列表缩略图 / og:image）的唯一来源。
//
// 三层兜底，顺序不能改：
//   1. posts.cover       —— 编辑器里手动指定，最高优先级
//   2. 正文第一张图片     —— 作者在文章里放了图，就拿它当缩略图，不用再管封面
//   3. 预设自动图         —— 一篇纯文字的文章也要有图，不能让列表出现空洞
//
// 第 3 层必须**稳定**：同一篇文章每次渲染都得是同一张。换来换去的话，
// 列表每次刷新都变脸，用户记不住哪篇是哪篇，边缘缓存也会被无谓地打散。
// 分配规则放在 public/cover.js，浏览器端渲染卡片时用的是同一份。

import { extractCover } from '../public/md.js';
import { autoCover, autoThumb } from '../public/cover.js';

export { autoCover, autoThumb };
export { AUTO_COVER_COUNT } from '../public/cover.js';

/**
 * 正文首图。小图标和矢量图当 208×136 的缩略图只会糊成一块，
 * 这种就直接放弃，退回预设图 —— 宁可统一，不要一列里混着清晰和糊的。
 */
function bodyCoverOf(post) {
  const url = extractCover(post?.content || '');
  if (!url) return '';
  if (/\.svg(\?|#|$)/i.test(url)) return '';
  if (/(^|\/)(favicon|icon[-_.]|emoji)/i.test(url)) return '';
  return url;
}

/** 最终生效的封面地址，永远非空 */
export function coverOf(post) {
  const own = String(post?.cover || '').trim();
  if (own) return own;
  return bodyCoverOf(post) || autoCover(post);
}

/** 是否走到了预设图（决定 og:image 的尺寸元信息，以及编辑器要不要提示） */
export function isAutoCover(post) {
  if (String(post?.cover || '').trim()) return false;
  return !bodyCoverOf(post);
}

/**
 * 列表缩略图（208×136 的框）。
 * 预设图有专门的 416px WebP，一张 1.5KB；文章自带图没有多尺寸可挑，只能照原样。
 * og:image / RSS 别用这个 —— 那边要 1200×784 的 JPG。
 */
export function thumbOf(post) {
  if (isAutoCover(post)) return autoThumb(post);
  const c = coverOf(post);
  /* 标题卡是给分享卡片用的 1200×630，塞进 108×78 的方框只会露出半截字。
     列表这时退回抽象预设图：识别靠标题文字，不靠一张被裁过的分享图。 */
  if (isCardCover(post)) return autoThumb(post);
  return c;
}

/** 是不是自动生成的标题卡（决定 og:image 的尺寸与 MIME） */
export function isCardCover(post) {
  return /^\/cards\/.+\.png$/.test(coverOf(post));
}
