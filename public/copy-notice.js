/* 复制正文时自动带上版权声明。
   三条边界，缺一个都会变成噪音：
   1. 只认落在 .post-body 里的选区 —— 复制导航、评论、页脚不该被粘上署名
   2. 完全落在代码块里的选区跳过 —— 粘代码时尾部挂三行中文，落地就是语法错误
   3. 太短的选区跳过 —— 复制一个词也贴声明，读者只会烦

   纯函数全部 export，scripts/test-copy-notice.mjs 直接在 node 里跑，不需要 DOM。 */

/* 兜底值：只在拿不到站点配置时用（比如离线打开的单页、单测）。
   真实站点上作者名和地址都从 Worker 下发，改站名/换域名不需要动这个文件。 */
export const DEFAULTS = {
  author: 'Exia Blog',
  site: 'https://exia.de5.net/',
  license: '署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0)',
};

/* 站名读 window.__SITE__.name（= SITE_NAME 环境变量），
   地址读 canonical 的 origin（= SITE_ORIGIN 环境变量）。
   两边都在服务端配置里，这里只跟着走 —— 换个域名不会把旧地址留在别人的剪贴板里。 */
export function resolveConfig(cfg = {}) {
  const meta = (typeof window !== 'undefined' && window.__SITE__) || {};

  let site = '';
  if (typeof document !== 'undefined') {
    const link = document.querySelector('link[rel="canonical"]');
    const href = link && link.getAttribute('href');
    try {
      if (href && typeof location !== 'undefined') site = new URL(href, location.href).origin + '/';
    } catch {
      site = '';
    }
    // 没有 canonical 的页（草稿预览之类）就用当前来源，总比空着强
    if (!site && typeof location !== 'undefined') site = location.origin + '/';
  }

  return {
    author: cfg.author || meta.name || DEFAULTS.author,
    site: cfg.site || site || DEFAULTS.site,
    license: cfg.license || DEFAULTS.license,
  };
}

/* 低于这个长度不附加。60 个字符约等于中文两句话，
   比这更短的复制基本都是"取个词去搜"，贴声明纯属添堵。 */
export const MIN_CHARS = 60;

/* 声明本体：三行纯文本，行序就是读者看到的顺序 */
export function noticeText(cfg = {}) {
  const { author, site, license } = { ...DEFAULTS, ...cfg };
  return [`作者: ${author}`, `本文来自于: ${site}`, `博客内容遵循 ${license} 协议`].join('\n');
}

/* 判据集中在这里，绑定层只负责把 DOM 事实喂进来，
   这样"什么情况下加声明"能被单测直接钉死。 */
export function shouldAttach({ inBody = false, inCode = false, chars = 0, min = MIN_CHARS } = {}) {
  if (!inBody) return false;
  if (inCode) return false;
  return chars >= min;
}

/* 拼接：正文原样保留，只在尾部补空行 + 声明。
   原文末尾的空行先削掉，否则剪贴板里会出现三段空白。 */
export function joinCopy(body, notice = noticeText()) {
  return `${String(body).replace(/\s+$/, '')}\n\n${notice}`;
}

const escHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* 富文本版：粘进 Word / 公众号 / Notion 时保留正文结构，
   声明单独包一层虚线，跟正文分得开。样式全部内联 —— 对面不认识我们的 class。 */
export function noticeHtml(notice = noticeText()) {
  const [first, ...rest] = notice.split('\n');
  // 来源那行挂成真链接：粘到 Word / Notion 里读者能点回去，纯文本版只能手动抄
  const linkify = (line) => {
    const m = line.match(/https?:\/\/\S+/);
    if (!m) return escHtml(line);
    const url = m[0];
    const href = `<a href="${escHtml(url)}" style="color:#888;text-decoration:underline">${escHtml(url)}</a>`;
    return escHtml(line.slice(0, m.index)) + href + escHtml(line.slice(m.index + url.length));
  };
  return (
    '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #d8d8d8;' +
    'font-size:13px;line-height:1.75;color:#777">' +
    `<strong style="color:#555;font-weight:600">${escHtml(first)}</strong><br>` +
    rest.map(linkify).join('<br>') +
    '</div>'
  );
}

/* 选区是否整个泡在代码里。起点、终点各判一次：
   只判起点的话，"从代码拖到正文"会变成代码后面跟一段署名，粘回去直接报错。 */
function inCodeBlock(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || !el.closest) return false;
  return !!el.closest('pre, code, .code-wrap');
}

export function bindCopyNotice(cfg = {}) {
  const doc = cfg.doc || document;
  const notice = noticeText(resolveConfig(cfg));
  const min = cfg.min ?? MIN_CHARS;

  doc.addEventListener('copy', (e) => {
    // 没有 clipboardData 就别接管，让浏览器走默认行为，总比复制不出来强
    if (!e.clipboardData) return;

    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const range = sel.getRangeAt(0);
    const start = range.startContainer;
    const end = range.endContainer;
    const startEl = start.nodeType === 1 ? start : start.parentElement;

    const body = startEl && startEl.closest && startEl.closest('.post-body');
    if (!body) return;

    // 空白算零个字符：全选一坨空行不该被当成"长内容"
    const chars = sel.toString().replace(/\s+/g, ' ').trim().length;
    if (!shouldAttach({ inBody: true, inCode: inCodeBlock(start) || inCodeBlock(end), chars, min })) return;

    const plain = joinCopy(sel.toString(), notice);

    const holder = doc.createElement('div');
    holder.appendChild(range.cloneContents());
    const html = holder.innerHTML;

    // 以 text/plain 写成功为准：写进去了才拦默认行为，
    // 否则浏览器自己还会再写一遍，剪贴板里就多出一份没署名的原文
    let wrote = false;
    try {
      e.clipboardData.setData('text/plain', plain);
      wrote = true;
      if (html.trim()) e.clipboardData.setData('text/html', html + noticeHtml(notice));
    } catch {
      // 被拒（老 Safari、剪贴板扩展）：不 preventDefault，原文照样复制得出去
    }
    if (wrote) e.preventDefault();
  });
}
