// 内容清理：写入前规范化 Markdown，渲染后消毒 HTML。
// 渲染器本身会把 Markdown 转义，但历史数据、粘贴内容、手改的库记录都可能带脏东西，
// 所以在服务端再走一遍白名单，属于第二道闸。

const SAFE_URL = /^(https?:\/\/|\/|\.{0,2}\/|#|mailto:|data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,])/i;

const VOID = new Set(['br', 'hr', 'img', 'input', 'source', 'wbr', 'col']);

const TAG_OK = new Set([
  'a', 'abbr', 'aside', 'b', 'blockquote', 'br', 'button', 'cite', 'code', 'del', 'details', 'div',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'source', 'span', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul', 'video',
]);

const ATTR_COMMON = ['class', 'id', 'title', 'lang', 'dir'];
const ATTR_BY_TAG = {
  a: ['href', 'target', 'rel', 'name', 'download'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  input: ['type', 'checked', 'disabled', 'name'],
  video: ['src', 'poster', 'controls', 'loop', 'muted', 'playsinline', 'width', 'height', 'preload'],
  source: ['src', 'type'],
  td: ['colspan', 'rowspan', 'style'],
  th: ['colspan', 'rowspan', 'style', 'scope'],
  button: ['type', 'disabled', 'data-copy', 'aria-label'],
  code: ['class'],
  ol: ['start'],
};

const BAD_BLOCK = /<(script|style|iframe|object|embed|form|link|meta|base|svg|math|template|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const BAD_SELF = /<(script|style|iframe|object|embed|form|link|meta|base|svg|math|template|noscript)\b[^>]*\/?>/gi;

function attrFilter(tag, name, value) {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return null;                 // onerror / onclick …
  if (lower === 'style') {
    // 只留表格对齐这种纯排版样式，其它一律丢
    return /^\s*text-align\s*:\s*(left|center|right|justify)\s*;?\s*$/i.test(value || '') ? value : null;
  }
  if (lower.startsWith('data-')) return lower === 'data-copy' ? value : null;
  const ok = ATTR_COMMON.includes(lower) || (ATTR_BY_TAG[tag] || []).includes(lower);
  if (!ok) return null;
  if ((lower === 'href' || lower === 'src' || lower === 'poster') && !SAFE_URL.test(String(value || '').trim())) {
    return null;
  }
  return value;
}

/** 白名单消毒：去掉脚本类标签、事件属性、javascript: 协议，并给外链补 rel */
export function sanitizeHtml(input = '') {
  let s = String(input);
  s = s.replace(BAD_BLOCK, '').replace(BAD_SELF, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  s = s.replace(/<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (all, close, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!TAG_OK.has(tag)) return '';
    if (close) return VOID.has(tag) ? '' : `</${tag}>`;
    if (!rawAttrs || !rawAttrs.trim()) return `<${tag}>`;

    const kept = [];
    const attrRe = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
    let m;
    while ((m = attrRe.exec(rawAttrs))) {
      const name = m[1];
      const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      const v = attrFilter(tag, name, value);
      if (v === null || v === undefined) continue;
      kept.push(value === undefined ? name : `${name.toLowerCase()}="${String(v).replace(/"/g, '&quot;')}"`);
    }

    if (tag === 'a') {
      const hasHref = kept.some((k) => k.startsWith('href='));
      const hrefAttr = kept.find((k) => k.startsWith('href=')) || '';
      const external = /^href="https?:/i.test(hrefAttr);
      const filtered = kept.filter((k) => !k.startsWith('target=') && !k.startsWith('rel='));
      if (hasHref && external) filtered.push('target="_blank"', 'rel="noopener nofollow"');
      return `<a${filtered.length ? ' ' + filtered.join(' ') : ''}>`;
    }
    if (tag === 'img' && !kept.some((k) => k.startsWith('src='))) return '';
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}>`;
  });

  // 空段落 / 只有换行的段落，纯属占位垃圾
  s = s.replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');
  s = s.replace(/<div[^>]*>(?:\s|<br\s*\/?>)*<\/div>/gi, '');
  return s.trim();
}

/* ---------------- Markdown 规范化 ---------------- */

// 代码块里的空白有语义，不能碰；把围栏内容先摘出来
const FENCE = /```[\s\S]*?```/g;

function tidyProse(s) {
  return s
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')       // 零宽字符
    .replace(/\u00A0/g, ' ')                            // 不换行空格
    .replace(/[ \t]+$/gm, '')                           // 行尾空白
    .replace(/\n{3,}/g, '\n\n')                         // 连续空行压成一行
    .replace(/[ \t]{2,}/g, ' ')                         // 句中多余空格
    .replace(/!\[[^\]]*\]\(\s*\)/g, '')                 // 空图片
    .replace(/\[\s*\]\(\s*\)/g, '');                    // 空链接
}

/**
 * 写入前清理正文。幂等：同一份内容跑两次结果一致。
 * @param {string} src Markdown 原文
 * @param {string} [title] 文章标题，用于去掉正文开头重复的一级标题
 */
export function cleanMarkdown(src = '', title = '') {
  const text = String(src).replace(/\r\n?/g, '\n');
  const fences = [];
  let guarded = text.replace(FENCE, (m) => {
    fences.push(m);
    return `\u0000F${fences.length - 1}\u0000`;
  });

  guarded = tidyProse(guarded);

  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t) {
    // 正文第一行如果是和标题一样的 H1，删掉——页面上已经有 h1 了
    guarded = guarded.replace(/^\s*#\s+([^\n]+)\n?/, (m, h) =>
      h.replace(/\s+/g, ' ').trim() === t ? '' : m
    );
  }

  let out = guarded.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[+i]);
  out = out.replace(/^\s*\n+/, '').replace(/\s+$/, '');
  return out;
}
