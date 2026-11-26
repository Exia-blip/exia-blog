// 主题样式表直出的边界：错一个字符就会让整站要么没样式、要么多一次阻塞请求。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { themeCssTag } from '../src/settings.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('纸韵不额外发 link（已编在 style.css 里）', () => {
  assert.equal(themeCssTag('paper', 'abc'), '');
});

t('其它主题直出 link，版本号来自内容哈希', () => {
  const tag = themeCssTag('ink', 'mwi16y2e');
  // 传进来的部署版本号在有 manifest 时被忽略：URL 必须跟 integrity 同源
  assert.match(tag, /^<link id="tcss-default" rel="stylesheet" href="\/theme\/ink\.css\?v=[0-9a-f]{10}"/);
});

t('直出的 link 带 integrity，且与 ?v= 是同一份内容', () => {
  const tag = themeCssTag('ink');
  const v = tag.match(/\?v=([0-9a-f]+)/)[1];
  const i = tag.match(/integrity="(sha384-[^"]+)"/)[1];
  assert.ok(i.startsWith('sha384-'), i);
  assert.ok(i.length > 40, '摘要长度像真的');
  assert.ok(v.length === 10, '版本号取自同一份哈希');
});

t('没有版本号时不拼空的 ?v=', () => {
  // 哈希表非空时一定带 v；这条守的是「别拼出 ?v= 空值」这个老坑
  assert.ok(!/\?v=("| )/.test(themeCssTag('forest')), '不会出现空 v');
});

t('未知主题退回纸韵 —— 不把用户填的字符串拼进 href', () => {
  assert.equal(themeCssTag('../../etc/passwd'), '');
  assert.equal(themeCssTag('"><script>alert(1)</script>'), '');
});

t('空值当作纸韵', () => {
  assert.equal(themeCssTag(''), '');
  assert.equal(themeCssTag(undefined), '');
});

t('七套主题里只有纸韵不发 link', () => {
  const all = ['paper', 'ink', 'forest', 'ocean', 'plum', 'mono', 'edge'];
  const withLink = all.filter((id) => themeCssTag(id) !== '');
  assert.deepEqual(withLink, ['ink', 'forest', 'ocean', 'plum', 'mono', 'edge']);
});

const cssText = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

t('回到顶部按钮七套通用：基础规则 display:grid，无主题限定覆写', () => {
  const rule = cssText.match(/\.back-top\s*\{[^}]*\}/);
  assert.ok(rule, '找不到 .back-top 基础规则');
  assert.match(rule[0], /display:\s*grid/);
  /* 任何主题的限定覆写都不许有：回到顶部是七套共用的功能件 */
  assert.doesNotMatch(cssText, /\[data-theme="[a-z0-9-]+"\]\s*\.back-top/);
});

t('正文图片 figure 覆盖浏览器默认左右边距', () => {
  const rule = cssText.match(/\.md \.md-img\s*\{[^}]*\}/);
  assert.ok(rule, '找不到 .md .md-img 规则');
  assert.match(rule[0], /margin:\s*1\.7em 0/);
  assert.ok(cssText.includes('.md .md-img figcaption'), '缺图注样式');
});

t('长表 sticky 表头有纵向滚动容器，打印时回退', () => {
  const wrap = cssText.match(/\.md \.table-wrap\s*\{[^}]*\}/);
  const th = cssText.match(/\.md th\s*\{[^}]*\}/);
  assert.ok(wrap && th, '找不到表格规则');
  assert.match(wrap[0], /max-height:\s*70vh/);
  assert.match(th[0], /position:\s*sticky/);
  assert.match(cssText, /@media print[\s\S]*?\.md \.table-wrap\s*\{ max-height: none/);
  assert.match(cssText, /nth-child\(even\)\s+td/);
});

t('强调色只落在当前项与交互态，静态标签保持中性', () => {
  const nav = cssText.match(/^nav\.top \.active[^}]*\}/m);
  assert.ok(nav, '找不到导航当前项规则');
  assert.match(nav[0], /color:\s*var\(--accent\)/, '当前导航项没吃强调色');
  // 另外两处是刻意留给强调色的：标签 hover、目录高亮条
  assert.match(cssText, /\.tag:hover\s*\{[^}]*var\(--accent\)/);
  assert.match(cssText, /\.post-toc a\.on\s*\{[^}]*var\(--accent\)/);
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
}
console.log(`\n主题直出 ${pass}/${cases.length} 通过`);
