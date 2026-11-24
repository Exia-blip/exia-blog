#!/usr/bin/env node
/**
 * 主题契约（[P-051]）。
 *
 * 契约只有一句话：**一套主题 = 一个 public/theme/<id>.css + settings.js 的
 * THEME_IDS 一行**。文件在就说明有独立样式表，文件不在就说明变量编在主样式表里；
 * 代码里不许再出现「主题名判断」来决定要不要发请求。
 *
 * 这条契约以前没写下来，代价是：
 *   - 同一段防闪脚本 10 份副本，9 份不带资源清单 → 切主题丢 SRI 与 ?v=；
 *   - paper / anzhiyu 的判定散在 boot、theme.js 两处；
 *   - 主题清单散在 settings.js / theme.js / index.js 的循环里三处。
 *
 * 断言分两类：主题文件本身的边界（TC-02~TC-04），
 * 以及「清单只有一份、引导只有一份」的元断言（TC-07~TC-14）。
 * 后者才是真正会重犯的部分 —— 加第 8 套主题时，人总是只改一处。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { THEME_IDS } from '../src/settings.js';
import { ASSET_HASH, THEME_BG } from '../src/assets.gen.js';
import { CONTRACT_CORE, CONTRACT_VARS, CONTRACT_DECLS, INLINE_THEMES, INTERNAL_PREFIX, deriveThemeIds } from '../src/theme-contract.js';
import { THEME_BOOT, THEME_ASSETS, themeBootTag } from '../src/themeboot.js';
/* 真渲染一次，验的是产物不是模板字符串（TC-35）。md.js 零依赖、纯字符串处理，
   node 里 import 没有 DOM 问题 —— 这条 import 本身就是「它可以被单测」的证明。 */
import { renderMarkdown } from '../public/md.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  if (typeof fn === 'function' && fn.constructor.name === 'AsyncFunction') {
    fail++;
    console.log(`FAIL  ${name}\n      同步 runner 收到了 async 函数，断言根本没跑（改 ta）`);
    return;
  }
  try {
    fn();
    pass++;
    console.log(`pass  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
};

const css = read('public/style.css');
const themeJs = read('public/theme.js');
const themeFiles = readdirSync(new URL('public/theme', ROOT)).filter((f) => f.endsWith('.css'));
const themeIds = themeFiles.map((f) => f.replace(/\.css$/, ''));
/* 默认主题：wrangler.jsonc 的 SITE_THEME。它是唯一允许把骨架规则写进主表的主题 ——
   默认主题的样式必须和第一个请求一起到，否则首屏多一个 RTT。 */
const DEFAULT_THEME = (read('wrangler.jsonc').match(/"SITE_THEME"\s*:\s*"([a-z]+)"/) || [])[1] || '';

/** 极简规则切分：跳过注释，按 { } 收集每层的选择器 */
function rules(cssText) {
  const s = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let buf = '';
  for (const ch of s) {
    if (ch === '{') {
      out.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      buf = '';
    } else buf += ch;
  }
  return out.filter((sel) => sel && !sel.startsWith('@'));
}

const ruleCount = (cssText, id) =>
  cssText.split(`[data-theme="${id}"]`).length - 1;

/* ---------- 主题文件边界 ---------- */

t('TC-01 每套主题要么有独立 CSS 文件，要么变量编在主样式表里', () => {
  /* 三种归宿：独立文件 / 主表里的 :root[data-theme="id"] 块 / 裸 :root（基准主题）。
     基准主题最多一个 —— 它没有自己的选择器，靠的就是主表最上面那份。 */
  const bareRoot = /:root\s*\{[^}]*--bg:/.test(css);
  const noFile = THEME_IDS.filter((id) => !existsSync(new URL(`public/theme/${id}.css`, ROOT)));
  const withBlock = noFile.filter((id) =>
    new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{`).test(css)
  );
  const orphans = noFile.filter((id) => !withBlock.includes(id));
  assert.ok(
    orphans.length <= 1,
    `这些主题既没有 theme/<id>.css，主表里也没有变量块：${orphans.join(', ')}`
  );
  if (orphans.length === 1) {
    assert.ok(bareRoot, `主题 ${orphans[0]} 应该是主表裸 :root 的基准，但主表里没有 --bg`);
  }
});

t('TC-02 主题文件里的每条规则都以 :root[data-theme="<id>"] 开头', () => {
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`);
    for (const sel of rules(text)) {
      assert.ok(
        sel.startsWith(`:root[data-theme="${id}"]`),
        `theme/${id}.css 里有越权选择器：${sel.slice(0, 90)}`
      );
    }
  }
});

t('TC-03 主题文件不许把自己接出去：@import / 远程 url / expression', () => {
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`);
    assert.doesNotMatch(text, /@import/i, `theme/${id}.css 用了 @import`);
    assert.doesNotMatch(text, /url\(\s*["']?(https?:)?\/\//i, `theme/${id}.css 引了远程资源`);
    assert.doesNotMatch(text, /expression\s*\(/i, `theme/${id}.css 有 expression()`);
    assert.doesNotMatch(text, /javascript:/i, `theme/${id}.css 有 javascript: 伪协议`);
  }
});

t('TC-04 主题文件必须给出三件套：底色、前景色、强调色', () => {
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`);
    for (const v of ['--bg:', '--fg:', '--accent:']) {
      assert.ok(text.includes(v), `theme/${id}.css 缺 ${v}`);
    }
  }
});

/* ---------- 主样式表：只许默认主题的骨架 ---------- */

t('TC-05 主样式表里只许出现默认主题的 [data-theme] 规则', () => {
  assert.ok(DEFAULT_THEME, '读不到 wrangler.jsonc 的 SITE_THEME');
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME) continue;
    assert.equal(
      ruleCount(css, id),
      0,
      `style.css 里出现了非默认主题 ${id} 的规则 —— 其余主题的骨架该放 theme/${id}.css，`
      + '否则所有读者都在下载自己用不到的那套'
    );
  }
});

t('TC-06 默认主题的骨架规则数有上限（防第二套主题往主表里长）', () => {
  const n = ruleCount(css, DEFAULT_THEME);
  assert.ok(n > 0, `主表里找不到默认主题 ${DEFAULT_THEME} 的规则`);
  assert.ok(n <= 100, `主表里默认主题规则已有 ${n} 处，超过 100 说明它已经不是"骨架微调"了`);
});

/* ---------- 清单只有一份 ---------- */

t('TC-07 面板 THEMES 与派生清单是同一个集合（顺序可以不同）', () => {
  const arr = themeJs.slice(themeJs.indexOf('export const THEMES'));
  const block = arr.slice(0, arr.indexOf('];'));
  const ids = [...block.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  /* 顺序不再是契约的一部分：THEME_IDS 由资源清单派生（文件名字母序），
     面板顺序是产品决策（安知鱼打头）。两处都手抄一份顺序才会天天红。 */
  assert.deepEqual(
    [...ids].sort(),
    [...THEME_IDS].sort(),
    `面板缺：${THEME_IDS.filter((i) => !ids.includes(i)).join(', ') || '（无）'}；`
    + `多出：${ids.filter((i) => !THEME_IDS.includes(i)).join(', ') || '（无）'}`
  );
  assert.equal(new Set(ids).size, ids.length, '面板里同一个主题出现了两次');
});

t('TC-08 客户端不再按主题名判断"要不要额外请求"', () => {
  /* 只看代码，不看注释 —— 注释里引用的旧写法不该被当成违规（这条第一版就被自己的
     注释判过红，说明正则扫的是文本不是语义）。 */
  const code = themeJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const offenders = [...code.matchAll(/[=!]==?\s*'(anzhiyu|paper)'/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `theme.js 里还有主题名判断：${offenders.join(' / ')}`);
});

/* ---------- 引导脚本只有一份 ---------- */

t('TC-09 静态模板用 <!--THEMEBOOT--> 占位，且同页必须有 <!--THEME-->', () => {
  const pages = readdirSync(new URL('public', ROOT)).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 6, `只找到 ${pages.length} 个模板`);
  for (const f of pages) {
    const html = read(`public/${f}`);
    assert.ok(html.includes('<!--THEMEBOOT-->'), `public/${f} 缺 <!--THEMEBOOT--> 占位`);
    assert.ok(
      html.includes('<!--THEME-->'),
      `public/${f} 有 THEMEBOOT 却没有 THEME —— injectTheme 不会进来，占位符会原样吐给浏览器`
    );
    assert.ok(
      !html.includes("localStorage.getItem('x_theme')"),
      `public/${f} 里还躺着一段手抄的防闪脚本（P-051：副本一多就会丢 SRI）`
    );
  }
});

t('TC-10 data-mpref 只在 themeboot.js 里出现一次（引导的唯一出处）', () => {
  const files = [
    'src/index.js',
    'src/admin-ui.js',
    'src/settings.js',
    'src/themeboot.js',
    'src/stats.js',
  ];
  const hits = files.filter((f) => read(f).includes('data-mpref'));
  assert.deepEqual(hits, ['src/themeboot.js'], `引导脚本还有别处副本：${hits.join(', ')}`);
});

t('TC-11 引导脚本带资源清单、integrity 与内容哈希版本号', () => {
  assert.ok(THEME_BOOT.includes('__ASSET_H__'), '引导脚本没读资源清单');
  assert.ok(THEME_BOOT.includes("S.integrity=a.i"), '运行时切主题没设 integrity');
  assert.ok(THEME_BOOT.includes("a.v?'?v='+a.v"), '运行时切主题没拼内容哈希版本号');
  assert.doesNotMatch(THEME_BOOT, /document\.write/, 'document.write 会卡住解析器，别再回去');
});

t('TC-12 清单里每条主题样式都带 v 与 i（缺一条就等于那套主题没有校验）', () => {
  const map = JSON.parse(THEME_ASSETS);
  const entries = Object.entries(map).filter(([k]) => k.startsWith('/theme/'));
  assert.ok(entries.length >= 5, `清单里只有 ${entries.length} 条主题样式`);
  for (const [k, h] of entries) {
    assert.ok(h.v && h.i, `${k} 缺 v 或 i`);
    assert.ok(h.i.startsWith('sha384-'), `${k} 的 integrity 形态不对`);
  }
});

t('TC-13 预览参数的白名单挡住路径穿越', () => {
  assert.ok(THEME_BOOT.includes('/^[a-z0-9]{2,16}$/'), '引导脚本里的预览白名单变了');
  assert.ok(read('public/theme.js').includes('/^[a-z0-9]{2,16}$/'), 'theme.js 里的预览白名单变了');
  // 白名单本身验一遍：会拼进 href 的值不许含 / . 与引号
  const ok = /^[a-z0-9]{2,16}$/;
  for (const bad of ['../x', 'a/b', 'ink.css', '"><script>', 'INK']) {
    assert.equal(ok.test(bad), false, `${bad} 不该过白名单`);
  }
});

t('TC-14 站点默认主题里的 <script 不会提前闭合', () => {
  const tag = themeBootTag({ theme: '</script><script>alert(1)</script>', mode: 'auto' });
  const opens = tag.split('<script').length - 1;
  assert.equal(opens, 1, `内联脚本被拆成了 ${opens} 段`);
  assert.ok(!tag.includes('</script><script>alert(1)'), '主题名没转义就进了 script');
});

/* 真的把那串脚本跑起来 —— 前面十几条都在检查"文本里有没有"，只有这条检查"跑起来对不对"。
   P-051 的真正杀伤力就在这里：清单的键被 stampAssets 改写成 `/theme/ink.css?v=xxx`，
   文本检查全绿，运行时却查不到、于是不请求任何样式表。 */
const boot = (stored, search, defaults) => {
  const created = [];
  const mm = () => ({ matches: false });
  const sandbox = {
    URLSearchParams,
    JSON,
    RegExp,
    Math,
    matchMedia: mm,
    window: { __THEME_DEFAULT__: defaults, __ASSET_H__: JSON.parse(THEME_ASSETS), matchMedia: mm },
    document: {
      documentElement: {
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
      },
      getElementById: () => null,
      createElement: () => {
        const el = {};
        created.push(el);
        return el;
      },
      head: { appendChild() {} },
    },
    localStorage: { getItem: (k) => stored[k] || null },
    location: { search },
  };
  runInNewContext(THEME_BOOT, sandbox);
  return { attrs: sandbox.document.documentElement.attrs, created };
};

t('TC-16 选中的主题真能查清单、真能拿到 href + integrity', () => {
  const { attrs, created } = boot({ x_theme: 'ink' }, '', { theme: 'anzhiyu', mode: 'auto' });
  assert.equal(attrs['data-theme'], 'ink');
  assert.equal(created.length, 1, `应该只插一条 link，实际 ${created.length}`);
  const [l] = created;
  assert.equal(l.id, 'tcss-ink');
  assert.match(l.href, /^\/theme\/ink\.css\?v=[0-9a-f]{10}$/, `href 形态不对：${l.href}`);
  assert.ok(String(l.integrity || '').startsWith('sha384-'), '没拿到 integrity');
});

t('TC-17 主表内联的主题（纸韵 / 安知鱼）一个请求都不发', () => {
  for (const id of ['paper', 'anzhiyu']) {
    const { attrs, created } = boot({ x_theme: id }, '', { theme: 'anzhiyu', mode: 'auto' });
    assert.equal(attrs['data-theme'], id);
    assert.equal(created.length, 0, `${id} 不该发请求，实际发了 ${created.length} 条`);
  }
});

t('TC-18 ?theme= 预览生效，且脏值不会变成一次 404 请求', () => {
  const { attrs, created } = boot({ x_theme: 'paper' }, '?theme=mono', { theme: 'anzhiyu', mode: 'auto' });
  assert.equal(attrs['data-theme'], 'mono', '预览没盖过本地偏好');
  assert.equal(created.length, 1);
  assert.match(created[0].href, /^\/theme\/mono\.css\?v=/);

  const dirty = boot({ x_theme: 'paper' }, '?theme=../etc', { theme: 'anzhiyu', mode: 'auto' });
  assert.equal(dirty.created.length, 0, '脏值不该拼出一个 href');
  assert.equal(dirty.attrs['data-theme'], 'paper');
});

/* ---------- 皮肤纪律：禁装饰、限体积、算对比度 ----------
   这三条不是审美意见，是「加第 8、9 套主题时不会把站弄花」的闸门：
   [P-052] 皮肤里禁渐变与玻璃拟态；[P-053] 单个皮肤 ≤ 2000 B（与 check-size 同口径）；
   [P-054] 对比度实算 —— 之前只有主表的体积预算，主题文件谁都能往里堆渐变，
   而没有任何一条断言算过对比度，全靠人眼。 */

t('TC-19 主题文件不引渐变与玻璃拟态（纯色分区）', () => {
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      /* 显式关闭不算引：`backdrop-filter: none` 是把主表继承来的模糊摘掉，
         恰恰是这条规矩想要的。只有给了非 none 的模糊才算违规。 */
      .replace(/backdrop-filter\s*:\s*none\s*;?/gi, '');
    assert.doesNotMatch(
      text,
      /(?:linear|radial|conic)-gradient\s*\(/i,
      `theme/${id}.css 用了渐变 —— 发丝线主题靠 --line 分区，渐变会把层级糊掉`
    );
    assert.doesNotMatch(
      text,
      /backdrop-filter|backdrop-blur/i,
      `theme/${id}.css 用了玻璃拟态 —— 半透明模糊在低端机上掉帧，且和纯色底冲突`
    );
  }
});

t('TC-20 单个主题文件 ≤ 2000 B（与 check-size 同一口径）', () => {
  for (const id of themeIds) {
    const bytes = Buffer.byteLength(read(`public/theme/${id}.css`));
    /* 和 scripts/check-size.mjs 的 2000 B 保持同一个数：两个阈值必然漂成两套口径。 */
    assert.ok(bytes <= 2000, `theme/${id}.css 已有 ${bytes} 字节，超过 2000 —— 它开始长骨架了`);
  }
});

/* 真要算。八套主题 × 浅深两态 × 四个色，任何一处掉到 4.5 以下都算不合格：
   正文、次要、辅助、强调。--brand 这类只做填充的颜色不在其中（它上面从不放字）。 */
const lum = (hex) => {
  const h = hex.length === 4 ? '#' + [...hex.slice(1)].map((x) => x + x).join('') : hex;
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const blockOf = (id, mode) => {
  const file = `public/theme/${id}.css`;
  const src = existsSync(new URL(file, ROOT)) ? read(file) : css;
  /* 两种归宿：自己的 :root[data-theme="id"] 块（安知鱼在主表、其余六套在各自文件），
     或者主表的裸 :root（纸韵 —— 它是基准，没有自己的选择器）。
     注意站点默认主题是安知鱼，基准主题是纸韵，两者不是同一个，别拿 SITE_THEME 推。 */
  const own = new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{`);
  const sel = own.test(src)
    ? new RegExp(
        `:root\\[data-theme="${id}"\\]${mode === 'dark' ? '\\[data-mode="dark"\\]' : ''}\\s*\\{([\\s\\S]*?)\\n\\}`
      )
    : mode === 'light'
      ? /(?:^|\n):root\s*\{([\s\S]*?)\n\}/
      : /(?:^|\n):root\[data-mode="dark"\]\s*\{([\s\S]*?)\n\}/;
  const m = src.match(sel);
  return m ? m[1] : null;
};
const varOf = (block, k) => {
  const m = block && block.match(new RegExp(`--${k}:\\s*(#[0-9a-fA-F]{3,8})`));
  return m ? m[1] : null;
};

t('TC-21 每套主题的浅色与深色都有自己的变量块', () => {
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      assert.ok(blockOf(id, mode), `主题 ${id} 缺 ${mode} 变量块 —— 缺了就会继承上一套的颜色`);
    }
  }
});

t('TC-22 正文 / 次要 / 辅助 / 强调 对底色 ≥ 4.5:1（实算，不靠眼）', () => {
  const bad = [];
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const block = blockOf(id, mode);
      const bg = varOf(block, 'bg');
      assert.ok(bg, `${id}/${mode} 读不到 --bg`);
      for (const k of ['fg', 'fg-soft', 'muted', 'accent']) {
        const c = varOf(block, k);
        assert.ok(c, `${id}/${mode} 读不到 --${k}`);
        const r = contrast(c, bg);
        if (r < 4.5) bad.push(`${id}/${mode} --${k} ${c} on ${bg} = ${r.toFixed(2)}`);
      }
      /* 卡片是列表、代码块、评论的载体 —— 正文在 --card 上，不是 --bg 上。
         底色换了而卡片没换时，只有这里会红。 */
      const card = varOf(block, 'card');
      const fg = varOf(block, 'fg');
      if (card && fg) {
        const r = contrast(fg, card);
        if (r < 4.5) bad.push(`${id}/${mode} --fg ${fg} on --card ${card} = ${r.toFixed(2)}`);
      }
      /* 按钮字：--on-brand 铺在 --brand 底上。只有给了 --brand 的主题才查，
         但一查就是硬要求 —— 白字搁在锚橙上只有 2.58:1 正是这条要挡的。 */
      const brand = varOf(block, 'brand');
      const onBrand = varOf(block, 'on-brand');
      if (brand && onBrand) {
        const r = contrast(onBrand, brand);
        if (r < 4.5) bad.push(`${id}/${mode} --on-brand ${onBrand} on --brand ${brand} = ${r.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(bad, [], `这些配色过不了 AA：\n      ${bad.join('\n      ')}`);
});

t('TC-23 theme-color 是构建期从 CSS 里读出来的，不是手抄的', () => {
  /* 手抄那份真实漂了 5 套（ink 写 #f6f6f4 实为 #fdfcfa、mono 写 #ffffff 实为 #f4f4f5…），
     症状是手机地址栏与页面底色差一点点 —— 谁都不会专门去查这个。
     现在 THEME_BG 由 build-sri 从各主题的 --bg 抽出来，这条断言逐值比对。 */
  const missing = THEME_IDS.filter((id) => !THEME_BG[id]);
  assert.deepEqual(missing, [], `THEME_BG 缺主题：${missing.join(', ')}`);
  const drift = [];
  for (const id of THEME_IDS) {
    const bg = varOf(blockOf(id, 'light'), 'bg');
    assert.ok(bg, `${id} 浅色块读不到 --bg`);
    if (bg.toLowerCase() !== THEME_BG[id].toLowerCase()) {
      drift.push(`${id}: THEME_BG=${THEME_BG[id]} ≠ CSS=${bg}`);
    }
  }
  assert.deepEqual(drift, [], `theme-color 与主题底色不一致，跑 npm run build:sri：\n      ${drift.join('\n      ')}`);

  /* 元断言：清单不许被改回字面量。THEME_COLOR 只许作为 import 别名存在；
     THEME_IDS 的定义体必须调用 deriveThemeIds（即真的在派生）。 */
  const idx = read('src/index.js');
  assert.doesNotMatch(idx, /const THEME_COLOR = \{/, 'index.js 又把 theme-color 抄成本地常量了');
  assert.match(idx, /import \{ THEME_BG as THEME_COLOR \}/, 'index.js 没从 assets.gen.js 取 THEME_COLOR');

  const settings = read('src/settings.js');
  assert.match(settings, /THEME_IDS = deriveThemeIds\(ASSET_HASH\)/, 'THEME_IDS 改回字面量数组了');
  assert.doesNotMatch(
    settings.replace(/\/\*[\s\S]*?\*\//g, ''),
    /===\s*'(?:paper|anzhiyu)'/,
    'settings.js 还在按主题名判断「有没有独立文件」—— 该问 ASSET_HASH'
  );
});

/* ---------- 越界变量探测（TC-24 用它，变异测试也用它必须调得动） ----------
   抽成纯函数不是为了好看：断言自己会不会红，只有把探测逻辑当函数单独喂一段
   注入过的字符串才验得了（TC-33）。内联在 t() 里的写法，验不了自己。 */

/* 字符类里必须有 `_`：第一版写的是 `[a-z0-9-]`，于是 `--_cd-bg` 一个都认不出来，
   「逃生口」等于没开。而这个漏洞在 TC-34 里**不红** —— 它期望的结果是 []，
   没认出来也是 []。所以 TC-34 有一条配套的「必须看见」断言。 */
const definedVars = (t) =>
  [...new Set([...t.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9_-]+)\s*:/gi)].map((m) => m[1]))];
const outsideVars = (t) =>
  definedVars(t).filter((v) => !v.startsWith(INTERNAL_PREFIX) && !CONTRACT_VARS.has(v));

t('TC-24 主题文件只许覆盖契约内的变量，`--_` 前缀为内部 token（P-043 的真身）', () => {
  /* 主题偷偷加一个 --my-shadow 并在组件里用，就等于在结构层开了后门：
     下次换主题时那个组件拿不到值，退化成浏览器默认。单看一套主题永远发现不了，
     要等切到别套才现形。
     `--_` 前缀是唯一逃生口（材料提的「内部 token」）：代码块要 GitHub 的 8 类语法色，
     契约只有 4 个 --tok-* 槽位，剩下的放哪儿都不对 —— 塞进契约等于逼八套主题各有 8 个值。
     放行它的前提是两条护栏，缺一条就会变成真的后门：
       ① 定义与引用必须在同一个文件里。跨文件（尤其在主表里 var(--_x)）就是全站
          依赖某套主题的私有变量，换主题整块塌 —— 这才是 --my-shadow 的真危害。
       ② 主表不许定义 --_*。结构层持有私有 token，等于主题在结构层留了把手。 */
  const bad = [], dangling = [], leaked = [];
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`);
    const outside = outsideVars(text);
    if (outside.length) {
      bad.push(`theme/${id}.css：${outside.join(', ')} —— 想用它就先加进 src/theme-contract.js`
        + '并保证每套主题都有值；只在本主题内用则加 `_` 前缀');
    }
    const internalDef = new Set(definedVars(text).filter((v) => v.startsWith(INTERNAL_PREFIX)));
    for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\(\s*(--_[a-z0-9-]+)\s*\)/gi)) {
      if (!internalDef.has(m[1])) dangling.push(`theme/${id}.css 引用了未定义的 ${m[1]}`);
    }
  }
  /* ② 主表零处：`var(--_` 与 `--_:` 都不许出现 */
  if (/var\(\s*--_/.test(css)) leaked.push('style.css 用了 var(--_*) —— 内部 token 不许跨出主题文件');
  if (/(?:^|[;{\s])--_[a-z0-9-]+\s*:/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    leaked.push('style.css 定义了 --_* —— 结构层不许持有私有 token');
  }
  assert.deepEqual(bad, [], `越界变量：\n      ${bad.join('\n      ')}`);
  assert.deepEqual(dangling, [], `悬空引用（定义了才许用，且只许在本文件用）：\n      ${dangling.join('\n      ')}`);
  assert.deepEqual(leaked, [], `内部 token 泄漏到结构层：\n      ${leaked.join('\n      ')}`);
});

t('TC-25 变量块只许变量声明；部件块只许引用变量，不许写死色值', () => {
  /* 两级规则，对应 style.css 的两层：
     · 光杆 `:root[data-theme="x"]` = 变量层。块体里只许 --var 与 color-scheme。
       选择器对了、块体里却写 `background: red !important`，那就是改站不是换皮。
     · 带后代的 `:root[data-theme="x"] .btn` = 部件覆盖（edge 有四条）。允许改属性，
       但色值必须经 var() / color-mix() 表达 —— 写死 #d9721a 这种「橙的加深版」，
       下次换 --brand 它不会跟着变，等于在主题里又埋了一份配色。 */
  const bad = [];
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      const bare = sel === `:root[data-theme="${id}"]` || sel === `:root[data-theme="${id}"][data-mode="dark"]`;
      for (const decl of m[2].split(';')) {
        const d = decl.trim();
        if (!d) continue;
        const name = d.split(':')[0].trim();
        if (bare) {
          /* `--_` 前缀是内部 token（TC-24 的逃生口），变量块里放行；
             它的值是死的（只服务本主题），所以不需要过 TC-25 的「色值必须经 var()」那条。 */
          if (!CONTRACT_DECLS.has(name) && !name.startsWith(INTERNAL_PREFIX)) {
            bad.push(`${id} 变量块里出现 ${d.slice(0, 60)}`);
          }
          continue;
        }
        /* 部件块：把 var() 与混黑混白（调深浅的算子，不是主题色）摘掉，还剩色值就是写死的 */
        const rest = d
          .replace(/var\([^)]*\)/g, '')
          .replace(/#(?:000|fff|000000|ffffff)\b/gi, '');
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(rest)) {
          bad.push(`${id} 部件块写死了色值：${d.slice(0, 70)}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `主题越界：\n      ${bad.join('\n      ')}`);
});

t('TC-26 契约变量的定义只许出现在 :root 块（结构层不许定义变量）', () => {
  /* style.css 是「变量层 + 结构层」一个文件（拆开就多一个 RTT，见 P-051 的取舍）。
     层次靠这条断言表达：契约变量只在 :root / :root[...] 里定义，组件块里只许用。
     组件自己的局部变量（--ava 这种评论头像哈希色）不受管 —— 它不在契约清单里。 */
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = [];
  let sel = '';
  for (const m of s.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    sel = m[1].trim();
    const scope = /^:root\b/.test(sel) || /^\s*:root\b/.test(sel);
    if (scope) continue;
    for (const d of m[2].split(';')) {
      const name = d.split(':')[0].trim();
      if (name.startsWith('--') && CONTRACT_VARS.has(name)) {
        bad.push(`${sel.slice(0, 50)} → ${name}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    `契约变量在结构层被重新定义了：\n      ${bad.join('\n      ')}`
  );
});

t('TC-27 每套主题的浅色块覆盖全部必填槽位（缺一个就静默继承上一套）', () => {
  for (const id of THEME_IDS) {
    const block = blockOf(id, 'light');
    assert.ok(block, `${id} 浅色块不存在`);
    /* 用边界匹配而不是 includes('--muted:')：后者会被 --xx-muted: 骗过，
       第一版就是这么写的，注入验证时它没红。 */
    const miss = CONTRACT_CORE.filter(
      (v) => !new RegExp(`(?:^|[;{\\s])${v}\\s*:`).test(block)
    );
    assert.deepEqual(miss, [], `${id} 缺必填槽位：${miss.join(', ')}`);
  }
});

t('TC-28 加一套主题只需要建一个文件（清单会自己长出来）', () => {
  /* 这是契约成立的唯一硬证据：给派生函数一个多出一个文件、别处都没改的清单，
     新主题必须出现在结果里。真加主题时若还要改第三处代码，这条不会红 ——
     所以它只是必要条件，配合 TC-07（面板集合）才算充分。 */
  const fake = { ...ASSET_HASH, 'theme/probe9.css': { v: '0000000000', i: 'sha384-x' } };
  const ids = deriveThemeIds(fake);
  assert.ok(ids.includes('probe9'), `派生清单没带上新文件：${ids.join(',')}`);

  /* 反向：不合规的文件名不该混进清单（它会被拼进 href） */
  const dirty = deriveThemeIds({ 'theme/../etc.css': {}, 'theme/ABC.css': {}, 'theme/a.css': {} });
  assert.deepEqual(dirty, [...INLINE_THEMES], `脏文件名漏进清单：${dirty.join(',')}`);
});

t('TC-29 [P-056] 主色不做文字色：浅色块里不许出现 color: var(--brand)', () => {
  /* 材料说的是「橙色必须稀缺，只做唯一主操作色」，可执行版不是数 var(--brand)
     出现几次 —— 那个数会被一次 hover 微调弄红，而且对 edge 的
     color-mix(in srgb, var(--brand) …) 派生全部失效（它数不到）。
     真正的分界是「能不能当文字色」：锚橙在纯白上 2.58:1，当 color 用就是拿
     链接色去撞 AA。深色态例外 —— #f6821f 在 #0d1117 上 7.33:1，那里它就是
     合规文字色（edge 的深色 --accent 正是它本身）。 */
  const bad = [];
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      if (/\[data-mode="dark"\]/.test(sel)) continue;
      for (const d of m[2].split(';')) {
        const [k, ...rest] = d.split(':');
        if (k.trim() !== 'color') continue;
        if (/var\(\s*--brand\s*\)/.test(rest.join(':'))) {
          bad.push(`theme/${id}.css → ${sel.slice(0, 44)} { ${d.trim()} }`);
        }
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    `主色被当文字色用了（白底 2.58:1，过不了 AA）：\n      ${bad.join('\n      ')}`
  );
});

t('TC-30 [P-057] 代码块注释色在真实代码底上 ≥ 4.5:1', () => {
  /* .tok-c 走 var(--muted)，而代码块的底色是 .code-wrap 的 var(--bg-soft) —— 不是 --bg。
     TC-22 只验了 --muted on --bg，差这一层。选 One Dark Pro 时栽的正是这里：
     它的注释 #7F848E 在 #282C34 上 3.72:1，满屏长文里注释一糊主题就废了。
     实测 8 套 × 2 态全过，最低 anzhiyu/light 4.61 —— 余量只有 0.11，
     任何一次 muted 调浅或 bg-soft 调深都会碰到这条。 */
  const bad = [];
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const block = blockOf(id, mode);
      const soft = varOf(block, 'bg-soft');
      const muted = varOf(block, 'muted');
      assert.ok(soft && muted, `${id}/${mode} 读不到 --bg-soft 或 --muted`);
      const r = contrast(muted, soft);
      if (r < 4.5) bad.push(`${id}/${mode} --muted ${muted} on --bg-soft ${soft} = ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `代码块注释读不清（.tok-c 用 --muted，底色是 --bg-soft）：\n      ${bad.join('\n      ')}`
  );
});

t('TC-31 [P-058] 代码块关连字（正文的 liga 会顺着 .md/.post-body 同一个 div 漏进来）', () => {
  /* .md 和 .post-body 是同一个元素的 class（index.js 的 <div class="md post-body">），
     所以 .post-body 上的 font-feature-settings: "liga" 1 会被 pre 直接继承 ——
     => != -> 在等宽字体里合成单字形。中文技术文里这三个符号出现极密，合成后更难扫读。
     没有任何人「写」过这条规则，它是继承来的，所以只能显式用 none 摘掉。 */
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    s,
    /\.md code[^{]*\{[^}]*font-variant-ligatures:\s*none/,
    'style.css 没有给 .md code/pre 关连字 —— 正文的 "liga" 1 会漏进代码块'
  );
  /* 前提核查：正文确实开了连字。哪天正文关了，这条覆盖就多余，断言该一起删。 */
  assert.match(
    s,
    /\.post-body\s*\{[^}]*font-feature-settings:[^;]*"liga"\s*1/,
    '.post-body 不再开 liga 1 —— TC-31 的前提消失，连带覆盖规则一起删'
  );
});

t('TC-32 对比度函数自校：拿 Primer 官方表的四个数反查算法', () => {
  /* 断言自己算错却没红，比没有断言更坏 —— TC-22 / TC-30 全建立在 contrast() 上。
     Primer 的 github-dark-default 逐项标注了这四个值，先拿它们反查实现（容差 0.02，
     官方表给到两位小数）。哪天 srgbToLinear 的分段阈值写反、或漏了幂次，第一步就红，
     不会出现「算法错了但所有对比度断言全绿」。 */
  const known = [
    ['#e6edf3', '#0d1117', 16.02],
    ['#ff7b72', '#0d1117', 7.51],
    ['#a5d6ff', '#0d1117', 12.31],
    ['#8b949e', '#0d1117', 6.15],
  ];
  const drift = known
    .map(([fg, bg, want]) => ({ fg, bg, want, got: contrast(fg, bg) }))
    .filter((r) => Math.abs(r.got - r.want) > 0.02)
    .map((r) => `${r.fg} on ${r.bg}: 实算 ${r.got.toFixed(2)} ≠ 官方 ${r.want}`);
  assert.deepEqual(drift, [], `对比度算法与官方表对不上，先修算法再看主题：\n      ${drift.join('\n      ')}`);
});

t('TC-33 [P-059] 变异：注入契约外变量，越界探测必须抓到（验断言本身）', () => {
  /* 这条不测主题，测 outsideVars()。「只跑绿不跑红等于没写」的可执行版：
     把该抓的东西喂进去，抓不到就说明 TC-24 是假绿 —— 而不是说明主题干净。 */
  assert.deepEqual(
    outsideVars(`:root[data-theme='x'] { --evil-token: 1px; }`),
    ['--evil-token'],
    '注入 --evil-token 后探测没抓到 → TC-24 永远绿'
  );
  assert.deepEqual(
    outsideVars(`:root[data-theme='x'] { --bg: #fff; --line: #eee; }`),
    [],
    '契约内变量被误报成越界'
  );
  /* 期望空集的断言必须有配套的「看得见」锚点：探测逻辑彻底坏掉（正则写错、读空文件）时
     上面那条同样返回 []，一样是绿的。这条把「什么都没抓到」和「抓到了且合规」分开。 */
  assert.deepEqual(
    definedVars(`:root[data-theme='x'] { --bg: #fff; --line: #eee; }`).sort(),
    ['--bg', '--line'],
    '变量解析器什么都没抓到 —— 上一条「不误报」是空的'
  );
  assert.deepEqual(
    outsideVars(`/* --evil: 1px */ :root { --bg: #fff; }`),
    [],
    '注释里的变量被当成了定义'
  );
});

t('TC-34 [P-059] 变异：`--_` 前缀放行且必须看得见，var() 是「用」不是「定义」', () => {
  /* 两条都是材料明确点出的假绿路径，也是我第一版会写错的两种：
     ① 内部 token 被当成越界 → 逃生口堵死，主题没法持有私有配色；
     ② 全文扫 `--x:` 会命中 var() 吗？不会（var( 后面没有冒号）—— 但
        「把用当成定义」的写法是 `parseVars(整份 CSS)` 后不区分块，那样
        .t-x 里任何 var(--brand) 都会被记成品牌变量定义，每套主题都判越界。 */
  const inner = `:root[data-theme='x'] { --_cd-bg: #f6f8fa; --_cd-d-string: #a5d6ff; }`;
  /* 先要求「看得见」，再要求「放行」。只写 deepEqual(outsideVars(inner), []) 是不够的：
     正则漏了 `_` 时它同样返回 []、断言照样绿 —— 这是真踩过的，`[a-z0-9-]` 少了 `_`，
     `--_cd-bg` 一个都认不出来，而 TC-34 报的是「通过」。材料的 P-045b 用
     `[...d.public].every(...)` 也是同一个病：空集恒 true。 */
  assert.deepEqual(
    definedVars(inner).sort(),
    ['--_cd-bg', '--_cd-d-string'],
    '内部 token 一个都没解析出来 —— 「放行」是假的，先修正则'
  );
  assert.deepEqual(
    outsideVars(inner),
    [],
    '`_` 前缀内部 token 被误判成越界 —— 逃生口被堵死'
  );
  assert.deepEqual(
    definedVars(`:root[data-theme='x'] .t-x pre { border-color: var(--brand); }`),
    [],
    '.t-x 里的 var(--brand) 被当成了定义'
  );
  /* 但真定义混在部件块里必须抓到 —— 这条防的是「放行 `_` 时顺手把整块放行了」 */
  assert.deepEqual(
    outsideVars(`:root[data-theme='x'] .t-x pre { --evil: 1px; }`),
    ['--evil'],
    '部件块里的越界定义漏过去了'
  );
});

t('TC-35 [P-060] 结构层 DOM 事实：真渲染一次，不查模板字符串', () => {
  /* 2026-11-24 一天之内三份主题材料按「常见博客长什么样」猜类名：
     .prose / .ai-summary / [data-ai-summary] / .comment / .friend-item /
     .dot-ok / .token.keyword —— 全部零命中，而 CSS 选择器不匹配**不报错**，
     打开页面 HTTP 200，只有盯着那个组件看才可能发现。

     为什么不 grep 源码：模板字符串里写 `<pre`，产物可能被另一层包住；
     变量拼接（`<div class="${cls}">`）也 grep 不出来。渲染一次看产物才是硬的。
     md.js 是零依赖纯字符串处理，node 里直接 import 就能跑。 */
  const out = renderMarkdown('```js\nconst a = 1;\n```');
  const must = [
    ['代码块外层是 .code-wrap', /^<div class="code-wrap"/],
    ['<pre> 自己带 .code-block', /<pre class="code-block(?:\s[^"]*)?"/],
    ['<code> 带 language-*', /<code class="language-js"/],
    ['语法钩子是 .tok-*', /<span class="tok-[a-z]"/],
  ];
  const miss = must.filter(([, re]) => !re.test(out)).map(([n]) => n);
  /* 摘要由 index.js 的 SSR 模板产出，不在 renderMarkdown 里 —— 单独从源码验。 */
  const postLead = read('src/index.js').includes('class="post-lead"');
  if (!postLead) miss.push('src/index.js 里找不到 .post-lead');

  assert.deepEqual(
    miss,
    [],
    `渲染产物的结构与 THEME-CONTRACT.md 第四节不符（改完渲染器要回来改那张表）：\n      ${miss.join('\n      ')}`
  );

  /* 否定断言挪到 TC-36：写在这里会被上面的 miss 抢先抛掉，永远走不到，
     等于「验了但验不到」—— 这正是 P-059 那类假绿。 */

  /* 文档侧：第四节那张表必须点名这些容器，否则「守事实」变成了守断言自己。 */
  const doc = read('THEME-CONTRACT.md');
  const undocumented = ['code-wrap', 'code-block', 'post-lead', 'tok-k'].filter((n) => !doc.includes(n));
  assert.deepEqual(undocumented, [], `THEME-CONTRACT.md 第四节没写这些容器：${undocumented.join(', ')}`);
});

t('TC-36 [P-060] 语法钩子只有一个名字：`.tok-*`，不存在 `.token.*`', () => {
  /* 三份主题材料里两份按 Prism 的 `.token.comment` / `.token.keyword` 写了几十行，
     零命中。这条只验反面，所以不会被 TC-35 的「结构缺失」抢先抛掉。
     它和 TC-35 是一对：那边验「该有的在」，这边验「不该有的不在」。

     为什么不把「一个 t() 只许一条 assert」做成断言（P-063）：材料给的判据
     `firstThrow > lastAssert || countAsserts <= 1` 实测只等价于「每块最多一条」，
     会红掉两条**正面**断言（本仓库 35 块里 25 块如此），却与它声称的
     「否定断言不被遮蔽」不等价。真规矩只有一条：反面断言不许和它否定的
     那条正面断言同处一个 t()，判据是「这条红了能不能看到那条的结果」，不是正则。 */
  const out = renderMarkdown('```js\nconst a = 1;\n```');
  assert.doesNotMatch(
    out,
    /class="token\b/,
    '渲染产物里出现 class="token" —— 语法高亮钩子换名了，主题里的 .token.* 要重新对'
  );
  /* 正面锚点：必须先有 tok-*，否则「没有 token」是空的（代码块根本没高亮，
     doesNotMatch 对空高亮同样成立）。这是 TC-34 那条教训的同一个形态。 */
  assert.match(
    out,
    /<span class="tok-[a-z]"/,
    '代码块没产出任何 tok-* 钩子 —— 上一条的「没有 token」是空的，先修高亮'
  );
});

t('TC-37 [P-061] 代码块 token 类别：渲染产物与结构层样式的集合必须相等（双向）', () => {
  /* 2026-11-24 第四份主题材料点出的真缺口：TC-36 只验「钩子叫 tok-*」，
     不验「有几类」。highlight() 哪天多产出一类（比如给正则加 tok-r），
     style.css 没有对应规则、主题也没有对应变量 → 那个 token 落回继承色，
     页面正常、HTTP 200、工具不报警 —— 又是「看起来能用」。
     反过来，样式里留着产物永远不产出的 .tok-x，是死规则：半年后有人去改它，
     以为自己改的是颜色。

     一条代码必须能产出全部类别，否则「产物 ⊆ 样式」对空集恒成立（P-059 那个形态）。 */
  const out = renderMarkdown(
    '```js\n// 注释\nconst a = 1;\nfunction f(s) { return "x" + s; }\n```'
  );
  const produced = new Set([...out.matchAll(/class="(tok-[a-z]+)"/g)].map((m) => m[1]));
  const styled = new Set([...read('public/style.css').matchAll(/\.(tok-[a-z]+)\s*\{/g)].map((m) => m[1]));

  /* 先要「看得见」：这段代码的类别数少于 4 说明高亮没跑起来，下面的空集判断是假的 */
  assert.ok(
    produced.size >= 4,
    `渲染产物只有 ${produced.size} 类 token（${[...produced].join(',')}）—— 高亮没跑起来，`
    + '下面的子集判断对空集恒成立，先修高亮再谈覆盖'
  );

  const unstyled = [...produced].filter((c) => !styled.has(c));
  assert.deepEqual(
    unstyled,
    [],
    `渲染器产出了没有样式的 token 类别：${unstyled.join(', ')} —— `
    + '在 style.css 加 `.tok-x { color: var(--tok-x) }` 并把槽位加进契约，否则它落回继承色'
  );

  const dead = [...styled].filter((c) => !produced.has(c));
  assert.deepEqual(
    dead,
    [],
    `style.css 里的 .${dead.join(', .')} 产物里不出现 —— 死规则，删掉或补上渲染器`
  );
});

t('TC-38 [P-062] 主题文件里的类名选择器必须在全站类名表里出现', () => {
  /* 第四份材料的第三个缺口，且是我这边真没有的：主题 CSS 那一侧没有任何反向校验。
     在 edge.css 写一条 `.tok-z { color: #f00 }`，TC-35/36/37 全绿（产物侧没变）、
     P-043 绿（它查变量不查选择器）、P-046 绿（它数 --brand）—— 一条死规则静静躺着。

     判据是「这个类名全站有没有人产出」，不是「style.css 里有没有」：
     后者是循环论证（两边可以一起烂）。所以类名表取的是产出侧 ——
     src/*.js 的 SSR 模板、public/md.js 的渲染器、public/*.html、public/*.js。 */
  const sources = [
    'public/md.js',
    'public/app.js',
    ...readdirSync(new URL('src', ROOT)).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    ...readdirSync(new URL('public', ROOT)).filter((f) => /\.(html|js)$/.test(f)).map((f) => `public/${f}`),
  ];
  const known = new Set();
  for (const f of sources) {
    const text = read(f);
    for (const m of text.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) known.add(c);
    }
    /* JS 里模板字符串内的 class="…" 会被上面的正则命中；ES 转义的 \" 再兜一遍 */
    for (const m of text.matchAll(/class=\\"([^"\\]*)\\"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) known.add(c);
    }
    /* 动态添加的类不算死规则：app.js 有 `btn.className = 'back-top'`，
       它一辈子不出现在 class="…" 字面量里。除 className / classList 赋值外，
       材料建议的硬编码白名单会把「新增动态类要手动加」变成维护负担 ——
       采集侧多两条正则就够，且不会漏。 */
    for (const m of text.matchAll(/\.(?:className|classList\.(?:add|remove|toggle))\s*[=(]\s*['"]([^'"]+)['"]/g)) {
      for (const c of m[1].split(/\s+/)) if (c) known.add(c);
    }
  }

  /* 先要「看得见」：类名表空了，下面的子集判断对空集恒成立 */
  assert.ok(known.size > 200, `类名表只收集到 ${known.size} 个 —— 采集坏了，先修这里`);

  const used = new Map();
  for (const id of themeIds) {
    const css = read(`public/theme/${id}.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    const cls = new Set([...css.matchAll(/\.([a-z][a-z0-9-]{1,30})\b/g)].map((m) => m[1]));
    const dead = [...cls].filter((c) => !known.has(c));
    if (dead.length) used.set(id, dead);
  }
  assert.deepEqual(
    [...used.entries()].map(([id, d]) => `theme/${id}.css: ${d.map((c) => '.' + c).join(' ')}`),
    [],
    '主题文件里引用了全站没有任何元素产出的类名 —— 死选择器，改它的人会以为自己改到了颜色'
  );
});

t('TC-39 [P-064] 契约 ↔ 消费侧双向对账：引用的变量要有来源，槽位要被真的消费', () => {
  /* 第五份材料提 TC-41「产物 tok-* ⊆ 主题覆盖集合」。那个方向已经被 TC-37 + 契约覆盖
     （.tok-* 的颜色变量全是契约槽位，槽位缺了主题就继承主表）。真缺的是它没说的两头：

     ① 结构层写了 `var(--tok-r)` 但全站没有这个变量的定义 → 整条声明被丢弃，卡片少一圈边框，
        不报错、HTTP 200。它比「选择器打不中」更难查，因为选择器看着是对的。
     ② 契约里挂着一个谁都不读的槽位 → 文档占一行、八套主题各留一个位（`--hero-weight` 就是这样，
        实测 0 处引用），半年后有人以为它在生效。

     两个方向都要求「看得见」：不带 fallback 的引用必须够多、契约槽位必须够多，
     否则 `差集为空` 对空集恒成立 —— P-059 那个形态。 */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const css = strip(read('public/style.css'));

  /* 定义：CSS 里任何位置的 `--x:`（组件块里的局部默认值也算来源，比如 .tag.tw-t0 的 --tw） */
  const defined = new Set([...css.matchAll(/(?:^|[\s;{])(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  /* 引用：只取**不带 fallback** 的 var(--x)。带 fallback 的是有意给默认值
     （`var(--border, #e3e5e8)` 是运行时可选项，`var(--toc-p, 0)` 由 JS 写），不算悬空。 */
  const bare = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]));

  assert.ok(defined.size >= 15 && bare.size >= 15,
    `来源侧看不清：定义 ${defined.size} 个 / 无 fallback 引用 ${bare.size} 个 —— 采集坏了，先修这里`);

  const dangling = [...bare].filter((v) => !defined.has(v) && !CONTRACT_VARS.has(v)).sort();
  assert.deepEqual(
    dangling,
    [],
    `结构层引用了无处可寻的变量（整条声明会被丢弃，不报错）：${dangling.join(', ')}`
  );

  /* 反向：契约槽位必须至少被一处样式引用。消费侧 = 主表 + 全部主题文件，
     因为 --brand / --on-brand 这类只被主题用、主表一次都不碰。 */
  const consumers = [
    'public/style.css',
    ...themeIds.map((id) => `public/theme/${id}.css`),
  ];
  const consumed = new Set();
  for (const f of consumers) {
    for (const m of strip(read(f)).matchAll(/var\(\s*(--[a-z0-9-]+)/g)) consumed.add(m[1]);
  }
  /* 锚点：--brand 与 --on-brand 只有 edge 用。它们出现，说明主题文件真的被读进来了； */
  assert.ok(
    consumed.has('--brand') && consumed.has('--on-brand'),
    '消费侧看不清 --brand / --on-brand —— 主题文件没被读进来，下面的「槽位都被消费」是空判'
  );

  const orphans = [...CONTRACT_VARS].filter((v) => !consumed.has(v)).sort();
  assert.deepEqual(
    orphans,
    [],
    `契约里的槽位没有任何样式引用：${orphans.join(', ')} —— `
    + '要么接上（写进规则），要么从 src/theme-contract.js 删掉；留着就是替一个不存在的设计意图占位'
  );
});

/* 自检：同步 runner 必须拒收 async 函数（P-029 那个坑，第二次踩过） */
{
  const p0 = pass;
  const f0 = fail;
  const log = console.log;
  console.log = () => {};
  t('__probe_async', async () => {});
  console.log = log;
  const caught = fail === f0 + 1 && pass === p0;
  pass = p0;
  fail = f0;
  if (!caught) {
    fail++;
    console.log('FAIL  TC-15 自检：同步 runner 没拦住 async 函数（断言会假绿）');
  } else {
    pass++;
    console.log('pass  TC-15 自检：同步 runner 拒收 async 函数');
  }
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
