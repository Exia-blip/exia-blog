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
import { CONTRACT_CORE, CONTRACT_VARS, CONTRACT_DECLS, INLINE_THEMES, deriveThemeIds } from '../src/theme-contract.js';
import { THEME_BOOT, THEME_ASSETS, themeBootTag } from '../src/themeboot.js';

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

t('TC-24 主题文件只许覆盖契约内的变量（P-043 的真身）', () => {
  /* 主题偷偷加一个 --my-shadow 并在组件里用，就等于在结构层开了后门：
     下次换主题时那个组件拿不到值，退化成浏览器默认。单看一套主题永远发现不了，
     要等切到别套才现形。 */
  for (const id of themeIds) {
    const text = read(`public/theme/${id}.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    const defined = [...text.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]);
    const extra = [...new Set(defined.filter((v) => !CONTRACT_VARS.has(v)))];
    assert.deepEqual(
      extra,
      [],
      `theme/${id}.css 定义了契约外的变量：${extra.join(', ')} —— `
      + '想在组件里用它，得先把它加进 src/theme-contract.js 并保证每套主题都有值'
    );
  }
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
          if (!CONTRACT_DECLS.has(name)) bad.push(`${id} 变量块里出现 ${d.slice(0, 60)}`);
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
