// 同构 Markdown 渲染器：Worker 与浏览器共用同一份，保证预览与线上 100% 一致。
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_URL = /^(https?:\/\/|\/|mailto:|data:image\/|\.{0,2}\/)/i;
function safeUrl(u) {
  const s = String(u || '').trim();
  return SAFE_URL.test(s) ? s : '#';
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

function inline(line) {
  const codes = [];
  let s = String(line).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000IC${codes.length - 1}\u0000`;
  });

  s = esc(s);

  // 图片
  s = s.replace(IMG_RE, (_, alt, src, title) => {
    return `<img src="${safeUrl(src)}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy" decoding="async">`;
  });
  // 链接
  s = s.replace(LINK_RE, (_, text, href, title) => {
    return `<a href="${safeUrl(href)}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener nofollow">${text}</a>`;
  });
  // 裸链接
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (_, p, u) => {
    return `${p}<a href="${u}" target="_blank" rel="noopener nofollow">${u}</a>`;
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
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
  let text = String(src).replace(/\r\n?/g, '\n');

  // 1. 抽出 fenced code，占位保护
  text = text.replace(/```([\w+#.\-]*)[ \t]*\n([\s\S]*?)```/g, (_, lang, code) => {
    const l = lang || 'text';
    const body = highlight(code.replace(/\n$/, ''), l);
    blocks.push(
      `<div class="code-wrap"><div class="code-head"><span>${esc(l)}</span><button class="copy-btn" data-copy>复制</button></div>` +
        `<pre class="code-block"><code class="language-${esc(l)}">${body}</code></pre></div>`
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
      const id = h[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || `h${out.length}`;
      out.push(`<h${lv} id="${esc(id)}">${inline(h[2])}</h${lv}>`);
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
  const m = String(content).match(new RegExp(String.raw`!\[[^\]]*\]\(\s*(${URL_PART})`));
  return m ? m[1] : null;
}

export function extractExcerpt(content = '', len = 120) {
  const s = stripCode(content)
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, ' ')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, len);
}

export function readingTime(content = '') {
  const n = String(content).replace(/\s/g, '').length;
  return Math.max(1, Math.round(n / 400));
}
