// 同构 Markdown 渲染器：Worker 与浏览器共用同一份，保证预览与线上 100% 一致。
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/* 白名单按用途分两份：图片允许 data:image/（<img> 里的 SVG 不执行脚本），
   链接不允许 —— 同一个白名单两边共用过一阵，结果是
   [x](data:image/svg+xml;base64,...) 能拿到一个可导航的 href。 */
const SAFE_LINK = /^(https?:\/\/|\/|mailto:|\.{0,2}\/)/i;
const SAFE_IMG = /^(https?:\/\/|\/|data:image\/|\.{0,2}\/)/i;
function safeUrl(u, kind = 'link') {
  const s = String(u || '').trim();
  return (kind === 'img' ? SAFE_IMG : SAFE_LINK).test(s) ? s : '#';
}

/* ---------------- 内置语法高亮（零依赖） ---------------- */
const KW = {
  js: 'const let var function return if else for while do switch case break continue class new await async import export from default try catch finally throw typeof instanceof in of this null undefined true false delete void yield static get set super extends',
  ts: 'const let var function return if else for while do switch case break continue class new await async import export from default try catch finally throw typeof instanceof in of this null undefined true false delete void yield interface type enum implements public private protected readonly namespace declare as satisfies',
  py: 'def class return if elif else for while in not and or import from as pass raise try except finally with lambda None True False yield global nonlocal del assert async await print self',
  go: 'package import func return if else for range switch case break continue defer go chan map struct interface type var const nil true false select fallthrough',
  rs: 'fn let mut const struct enum impl trait pub use mod match if else for while loop return self Self Some None Ok Err where async await move ref dyn crate super',
  java: 'public private protected class interface extends implements static final void int long double float boolean char String new return if else for while switch case break continue try catch finally throw throws import package this super null true false abstract synchronized volatile',
  sql: 'select from where insert into values update set delete join left right inner outer on group by order having limit offset as and or not null is like in create table drop alter add primary key foreign references index default union all distinct count sum avg min max',
  sh: 'echo cd ls cat rm cp mv mkdir rmdir grep sed awk chmod chown export source if then else fi for do done while case esac function return exit npm node git curl wget docker sudo',
  yml: 'true false null yes no on off',
};
KW.jsx = KW.js;
KW.tsx = KW.ts;
KW.mjs = KW.js;
KW.cjs = KW.js;
KW.javascript = KW.js;
KW.typescript = KW.ts;
KW.python = KW.py;
KW.golang = KW.go;
KW.rust = KW.rs;
KW.bash = KW.sh;
KW.shell = KW.sh;
KW.zsh = KW.sh;
KW.yaml = KW.yml;
KW.toml = KW.yml;
KW.json = KW.yml;

const HASH_LANGS = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'ini', 'conf']);

export function highlight(code, lang = '') {
  const L = String(lang || '').toLowerCase();
  const s = String(code);
  if (!L || L === 'text' || L === 'plain' || L === 'plaintext') return esc(s);

  const raw = KW[L];
  const kw = new Set((raw || 'true false null this new function return if else').split(/\s+/));
  const commentRe = HASH_LANGS.has(L)
    ? /(#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|&lt;!--[\s\S]*?--&gt;)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;

  let out = '';
  let last = 0;
  let m;
  while ((m = commentRe.exec(s))) {
    out += esc(s.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else if (m[4]) {
      const w = m[4];
      if (kw.has(w)) out += `<span class="tok-k">${w}</span>`;
      else if (s[commentRe.lastIndex] === '(') out += `<span class="tok-f">${w}</span>`;
      else out += esc(w);
    }
    last = commentRe.lastIndex;
  }
  out += esc(s.slice(last));
  return out;
}

/* URL 里允许成对括号（维基的 OAuth_(disambiguation)、图床的 p_(1).png 这类），
   只吃一层：原来的 [^)\s]+ 会在第一个 ) 处截断，还会把结尾那个 ) 漏进正文。 */
const URL_PART = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
const IMG_RE = new RegExp(String.raw`!\[([^\]]*)\]\((${URL_PART})(?:\s+&quot;([^&]*)&quot;)?\)`, 'g');
const LINK_RE = new RegExp(String.raw`\[([^\]]+)\]\((${URL_PART})(?:\s+&quot;([^&]*)&quot;)?\)`, 'g');

/* 图片宽高：上传时把 w/h 拼进 URL 查询串（见 /api/upload），渲染时取出来变成
   width/height 属性，再把这俩参数从 src 里剥掉。
   为什么要剥离：尺寸是排版元数据，不是资源标识。留在 URL 里会让同一张图在边缘
   多出一份缓存分区（/x.jpg?w=800 与 /x.jpg 各存一份），而图片内容完全一样。
   此刻入参已经过 esc()，参数分隔符是 &amp; 而不是 &，剥的时候要连 amp; 一起认。 */
function imgSize(raw) {
  const pick = (k) => {
    const m = new RegExp(`[?&](?:amp;)?${k}=(\\d{1,6})`).exec(raw);
    return m ? Number(m[1]) : 0;
  };
  const w = pick('w');
  const h = pick('h');
  if (!w || !h) return null;
  const q = raw.indexOf('?');
  const base = q < 0 ? raw : raw.slice(0, q);
  const keep =
    q < 0
      ? []
      : raw
          .slice(q + 1)
          .split('&')
          .map((p) => p.replace(/^amp;/, ''))
          .filter((p) => !/^[wh]=\d{1,6}$/.test(p));
  return { w, h, url: keep.length ? `${base}?${keep.join('&amp;')}` : base };
}

/* 图片宽度档位与正文容器宽度的约定。
   .wrap 是 max-width:760px 减两侧 22px padding，内容宽 716px；窄屏是 100vw 减 44px。
   sizes 把这个宽度提前告诉浏览器，它才能在下载前就决定拿哪一档 ——
   少了 sizes，浏览器默认按 100vw 算，手机上会挑过大的档。改 CSS 要一起改这里。
   档位由 scripts/make-variants.mjs 产出（WIDTH_STEPS 两边必须一致）。 */
const IMG_SIZES = '(max-width: 780px) calc(100vw - 44px), 716px';
const WIDTH_STEPS = [480, 800, 1200];

/* 变体地址是「在扩展名后面插后缀」，不是简单拼接：
   原地址可能带 ?v=3 这类查询串，直接拼 .w480 会拼到查询串尾巴上去。 */
function variantUrl(url, suffix) {
  const q = url.indexOf('?');
  return q < 0 ? url + suffix : url.slice(0, q) + suffix + url.slice(q);
}

/* 多档 srcset。最后一档用原图真实宽度当描述符 —— 不写它的话，DPR=2 的屏幕
   只能在前三档里挑最大的，1200 档在小图上等于白给一个模糊的候选。 */
function widthSrcset(url, ext, origW) {
  const parts = WIDTH_STEPS.filter((d) => d < origW).map((d) => `${variantUrl(url, `.w${d}.${ext}`)} ${d}w`);
  parts.push(`${variantUrl(url, `.${ext}`)} ${origW}w`);
  return parts.join(', ');
}

/* 没写 alt 时从文件名兜一手 —— 但只兜「文件名本身有信息量」的情况。
   R2 的 key 是随机串（mvv7xrrwzzr5x3），把它念出来比不念更糟：空 alt 的意思是
   「这是装饰图，读屏请跳过」，而一段乱码会被逐字符念完，比没有更吵。

   所以判据是「清洗之后还剩不剩人能读的词」，不是「能不能凑出一个字符串」。 */
const ALT_NOISE = /(^|[\s_-])(img|image|photo|pic|picture|screenshot|screen|shot|upload|untitled|wechat|mmexport|微信图片)(?=[\s_-]|$)/gi;

function autoAlt(rawUrl) {
  const u = String(rawUrl).replace(/&amp;/g, '&').split('?')[0].split('#')[0];
  const file = u.slice(u.lastIndexOf('/') + 1);
  let s = file.replace(/\.[a-z0-9]+$/i, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 编坏了就按原样看，下面清洗规则对 %E4 这种串也会判成无意义 */
  }
  // 剥掉变体后缀（a.png.w800的 w800 段）和尺寸尾巴（xxx-1600x900）
  s = s.replace(/\.w\d{3,4}$/i, '').replace(/[-_]\d{2,4}x\d{2,4}$/i, '');
  s = s.replace(ALT_NOISE, ' ');
  // 时间戳、随机 id：8 位以上的十六进制段（纯数字也算），大概率是上传时生成的
  s = s.replace(/[\s_-]*\b[0-9a-f]{8,}\b[\s_-]*/gi, ' ');
  s = s.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 120) return '';
  // 清洗完只剩数字和符号 → 说明原文件名没有语义
  if (!/[A-Za-z\u4e00-\u9fff]/.test(s)) return '';
  // 单段、纯小写字母数字且够长 → 还是随机串（pipeline 这种会带空格或大小写，能留下）
  if (!/\s/.test(s) && /^[a-z0-9]{10,}$/.test(s)) return '';
  return s;
}

function inline(line) {
  const codes = [];
  let s = String(line).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000IC${codes.length - 1}\u0000`;
  });

  s = esc(s);

  // 图片
  s = s.replace(IMG_RE, (_, alt, src, title) => {
    let url = safeUrl(src, 'img');
    /* width/height 是给浏览器占位用的：图片还没下载完，它已经能从这两个数推出
       宽高比，把位置先留出来。少了它，每张图加载完成都会把下面的内容往下顶一次。 */
    const sz = imgSize(url);
    const dim = sz ? ` width="${sz.w}" height="${sz.h}"` : '';
    if (sz) url = sz.url;
    /* 作者没写 alt 时用文件名兜。兜不出有用的东西就保持空 —— 空 alt 在无障碍里
       有明确含义（装饰图），比一段噪音好。 */
    const altText = alt || esc(autoAlt(url));
    const img = `<img src="${url}" alt="${altText}"${
      title ? ` title="${title}"` : ''
    }${dim} loading="lazy" decoding="async">`;
    /* 站内上传的 png/jpg 额外给一份 avif / webp 候选。
       为什么用 <picture> 而不是在服务端按 Accept 协商：HTML 是边缘缓存的，
       同一份缓存要发给所有浏览器，按 Accept 分支会让缓存串味；
       URL 不同就没这个问题，由浏览器自己挑。
       变体没转的图也不会裂 —— /img/ 那边有回退（见 serveImage）。

       尺寸维度只有「已知原图宽度」时才展开。不知道宽度的老图只给格式变体：
       瞎写一个 1200w 描述符，浏览器会按 1200 去排，实际发来一张 600px 的图，
       结果是糊的 —— 猜错比不猜更糟。 */
    const local = /^\/img\/[^?#]+\.(png|jpe?g|webp)(?:\?|$)/i.exec(url);
    if (local && sz && sz.w > WIDTH_STEPS[0]) {
      const src = (ext) => ` srcset="${widthSrcset(url, ext, sz.w)}" sizes="${IMG_SIZES}"`;
      return local[1].toLowerCase() === 'webp'
        ? `<picture><source type="image/avif"${src('avif')}>${img}</picture>`
        : `<picture><source type="image/avif"${src('avif')}><source type="image/webp"${src('webp')}>${img}</picture>`;
    }
    if (local) {
      /* 编辑器上传前已经把 jpg/png 转成 webp 了，那类图的原图就是 webp，
         只差一档 avif。再给一个 .webp 候选等于让浏览器在原图和自己之间二选一 ——
         省不了字节，还多一次请求判断。 */
      const avif = variantUrl(url, '.avif');
      return local[1].toLowerCase() === 'webp'
        ? `<picture><source type="image/avif" srcset="${avif}">${img}</picture>`
        : `<picture><source type="image/avif" srcset="${avif}"><source type="image/webp" srcset="${variantUrl(
            url,
            '.webp'
          )}">${img}</picture>`;
    }
    return img;
  });
  // 链接
  s = s.replace(LINK_RE, (_, text, href, title) => {
    return `<a href="${safeUrl(href, 'link')}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener nofollow">${text}</a>`;
  });
  // 裸链接：句末标点别吃进 href（"看 https://x.com/a. 结束" 原来会把句号带进链接）
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (_, p, u) => {
    const trail = (u.match(/[.,;:!?]+$/) || [''])[0];
    const href = trail ? u.slice(0, -trail.length) : u;
    return `${p}<a href="${href}" target="_blank" rel="noopener nofollow">${href}</a>${trail}`;
  });

  /* 强调必须在图片/链接之后跑（链接文字里的 **粗体** 得保留），但那时 s 里
     已经混进了我们自己拼的标签。`[^*\n]+` 会跨过属性值去凑对：两个 srcset 里的
     __probe 被当成一对，路径被啃成 <strong>，整段 srcset 报废；/p/__a__b 这种
     URL 也一样。之所以只用排除 < > " 还不够 —— 属性值里可以干净地出现 __a__。
     所以把标签整体换成占位符，规则只面对纯文本，跑完再放回去。 */
  const tags = [];
  s = s.replace(/<[^>]+>/g, (m) => {
    tags.push(m);
    return `\u0001T${tags.length - 1}\u0001`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0001T(\d+)\u0001/g, (_, i) => tags[+i]);

  s = s.replace(/\u0000IC(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

// 收集连续列表行 -> ul/ol
function parseList(lines, i, ordered) {
  const marker = ordered ? /^(\s*)(\d+)[.)]\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
  const items = [];
  let baseIndent = -1;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      const next = lines[i + 1] || '';
      if (marker.test(next) || (!ordered && /^\s*[-*+]/.test(next))) { i++; continue; }
      break;
    }
    const m = ordered ? line.match(/^(\s*)(\d+)[.)]\s+(.*)$/) : line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!m) break;
    const indent = m[1].length;
    if (baseIndent < 0) baseIndent = indent;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // 嵌套：递归
      const [nested, ni] = parseList(lines, i, /^\s*\d+[.)]/.test(line));
      if (items.length) items[items.length - 1].children = nested;
      i = ni;
      continue;
    }
    items.push({ text: ordered ? m[3] : m[2], children: '' });
    i++;
  }

  const tag = ordered ? 'ol' : 'ul';
  const body = items
    .map((it) => {
      const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
      const t = task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}` : inline(it.text);
      return `<li>${t}${it.children || ''}</li>`;
    })
    .join('');
  return [`<${tag}>${body}</${tag}>`, i];
}

function parseTable(lines, i) {
  const split = (row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const head = split(lines[i]);
  const align = split(lines[i + 1]).map((c) => {
    if (/^:-+:$/.test(c)) return 'center';
    if (/^-+:$/.test(c)) return 'right';
    return '';
  });

  const rows = [];
  let j = i + 2;
  while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
    rows.push(split(lines[j]));
    j++;
  }

  const th = head.map((c, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</th>`).join('');
  const tb = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</td>`)
          .join('')}</tr>`
    )
    .join('');

  return [`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`, j];
}

export function renderMarkdown(src = '') {
  const blocks = [];
  const seenIds = new Map(); // 同名标题要各自有 id，否则第二个锚点永远指向第一个
  let text = String(src).replace(/\r\n?/g, '\n');

  // 1. 抽出 fenced code，占位保护
  text = text.replace(/```([\w+#.\-]*)[ \t]*\n([\s\S]*?)```/g, (_, lang, code) => {
    const l = lang || 'text';
    const src = code.replace(/\n$/, '');
    const body = highlight(src, l);
    const lines = src.split('\n').length;
    const long = lines >= 20; // 短块给行号只是噪音，超长块才需要"第 30 行"这种坐标
    // 行号单独一列，不往高亮后的 HTML 里插换行标记 —— 多行字符串/块注释的 span 会跨行，
    // 在那种位置切分等于把标签劈成两半。
    const gutter = long
      ? `<span class="gutter" aria-hidden="true">${Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</span>`
      : '';
    blocks.push(
      `<div class="code-wrap" data-lang="${esc(l)}" data-lines="${lines}">` +
        `<div class="code-head"><span class="code-meta"><span class="code-lang">${esc(l)}</span>` +
        `${long ? `<span class="code-ln">${lines} 行</span>` : ''}</span>` +
        `<button class="copy-btn" data-copy>复制</button></div>` +
        `<pre class="code-block${long ? ' has-ln' : ''}">${gutter}<code class="language-${esc(l)}">${body}</code></pre></div>`
    );
    return `\n\u0000CB${blocks.length - 1}\u0000\n`;
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flush = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块占位
    const cb = line.match(/^\u0000CB(\d+)\u0000$/);
    if (cb) {
      flush();
      out.push(blocks[+cb[1]]);
      i++;
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lv = h[1].length;
      const base =
        h[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || `h${out.length}`;
      // 同名标题追加 -2、-3：不然两节共用一个 id，锚点和目录都指错地方
      const n = (seenIds.get(base) || 0) + 1;
      seenIds.set(base, n);
      const id = n === 1 ? base : `${base}-${n}`;
      out.push(
        `<h${lv} id="${esc(id)}"><a class="h-anchor" href="#${esc(id)}" aria-label="本节链接">#</a>${inline(h[2])}</h${lv}>`
      );
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 表格
    if (/\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      const [tbl, ni] = parseTable(lines, i);
      out.push(tbl);
      i = ni;
      continue;
    }

    // 列表
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const [ul, ni] = parseList(lines, i, ordered);
      out.push(ul);
      i = ni;
      continue;
    }

    // 独立图片成段落（用于封面/居中）
    if (new RegExp(String.raw`^!\[[^\]]*\]\((${URL_PART})\)$`).test(line.trim())) {
      flush();
      out.push(`<p class="md-img">${inline(line.trim())}</p>`);
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flush();

  return out.join('\n');
}

// ---- 标签 / 封面 / 摘要 ----
const stripCode = (s) => String(s).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');

/** 正文 → HTML：Markdown 渲染 + 正文里的 #标签 转成可点链接（接口与 SSR 共用） */
export function renderBody(content = '') {
  return linkTags(renderMarkdown(content));
}

const unesc = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * 从渲染好的正文 HTML 里抽 h2，给侧边目录用。
 * 故意不重新解析 Markdown：id 的生成规则只该有一份，两套迟早漂移成"目录点了跳偏"。
 */
export function tocOf(html = '') {
  const items = [];
  const re = /<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const text = unesc(m[2].replace(/<a class="h-anchor"[\s\S]*?<\/a>/g, '').replace(/<[^>]+>/g, '')).trim();
    if (text) items.push({ id: m[1], text });
  }
  return items;
}

/* 只在元素之间的文本里做 #标签 → 链接。
   原来直接对整个 HTML 跑正则，`![ #tag ](a.png)` 会把 <a> 插进 alt="..." 里，
   产出畸形 DOM；顺带把代码块里的 #xxx 也链掉了。 */
const TAG_SPLIT = /<[^>]*>/g;
function linkTags(html) {
  const one = (text) =>
    text.replace(
      /(^|\s)#([\p{L}\p{N}_-]{1,24})/gu,
      (m, pre, name) => `${pre}<a class="tag-inline" href="/tag/${encodeURIComponent(name)}">#${name}</a>`
    );

  let out = '';
  let last = 0;
  let skip = 0; // 处在 <pre> / <code> / <a> 内部时不处理

  for (const m of html.matchAll(TAG_SPLIT)) {
    const text = html.slice(last, m.index);
    out += skip > 0 ? text : one(text);

    const tag = m[0];
    if (/^<(pre|code|a)[\s>]/i.test(tag)) skip++;
    else if (/^<\/(pre|code|a)\s*>/i.test(tag)) skip = Math.max(0, skip - 1);

    out += tag;
    last = m.index + tag.length;
  }

  const tail = html.slice(last);
  out += skip > 0 ? tail : one(tail);
  return out;
}

export function extractTags(content = '') {
  const clean = stripCode(content);
  const re = /(^|[\s（(>、，。])#([\p{L}\p{N}_-]{1,24})/gu;
  const set = new Set();
  for (const m of clean.matchAll(re)) set.add(m[2]);
  return [...set].slice(0, 10);
}

export function extractCover(content = '') {
  // 必须先剥掉代码块：讲 Markdown / 讲渲染的文章里，示例图语法就写在围栏里，
  // 直接扫会把 `![x](/a.png)` 这样的示例当成真封面，列表里出现一张破图。
  const m = stripCode(String(content)).match(new RegExp(String.raw`!\[[^\]]*\]\(\s*(${URL_PART})`));
  return m ? m[1] : null;
}

/* 把 Markdown 抹平成可读纯文本。搜索摘要和 og:description 都靠它，
   两处口径必须一致，所以只留一份。 */
function plainText(content = '') {
  return stripCode(content)
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, ' ')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractExcerpt(content = '', len = 120) {
  return plainText(content).slice(0, len);
}

/* 搜索结果里的摘要：给关键词前后那几十个字，而不是正文开头那 140 字。
   搜到的词如果落在第 800 字，开头那段里根本没有它 —— 高亮再准也标不出东西，
   用户看到的就是「搜了但结果里找不到这个词」。 */
export function searchSnippet(content = '', q = '', len = 130) {
  const needle = String(q || '').trim();
  if (!needle) return '';
  const text = plainText(content);
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return '';
  const start = Math.max(0, i - Math.round(len * 0.28));
  const seg = text.slice(start, start + len).trim();
  if (!seg) return '';
  return `${start > 0 ? '…' : ''}${seg}${start + len < text.length ? '…' : ''}`;
}

export function readingTime(content = '') {
  const n = String(content).replace(/\s/g, '').length;
  return Math.max(1, Math.round(n / 400));
}
