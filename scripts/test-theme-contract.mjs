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

t('TC-07 settings.THEME_IDS 与面板 THEMES 的 id 序列一致', () => {
  const arr = themeJs.slice(themeJs.indexOf('export const THEMES'));
  const block = arr.slice(0, arr.indexOf('];'));
  const ids = [...block.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, THEME_IDS, `theme.js: ${ids.join(',')} ≠ settings.js: ${THEME_IDS.join(',')}`);
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
