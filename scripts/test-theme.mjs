// 主题样式表直出的边界：错一个字符就会让整站要么没样式、要么多一次阻塞请求。
import assert from 'node:assert/strict';
import { themeCssTag } from '../src/settings.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('纸韵不额外发 link（已编在 style.css 里）', () => {
  assert.equal(themeCssTag('paper', 'abc'), '');
});

t('安知鱼同理', () => {
  assert.equal(themeCssTag('anzhiyu', 'abc'), '');
});

t('其它主题直出 link，并带版本号', () => {
  const tag = themeCssTag('ink', 'mwi16y2e');
  assert.match(tag, /^<link id="tcss-default" rel="stylesheet" href="\/theme\/ink\.css\?v=mwi16y2e">$/);
});

t('没有版本号时不拼空的 ?v=', () => {
  assert.match(themeCssTag('forest'), /href="\/theme\/forest\.css">$/);
});

t('未知主题退回纸韵 —— 不把用户填的字符串拼进 href', () => {
  assert.equal(themeCssTag('../../etc/passwd'), '');
  assert.equal(themeCssTag('"><script>alert(1)</script>'), '');
});

t('空值当作纸韵', () => {
  assert.equal(themeCssTag(''), '');
  assert.equal(themeCssTag(undefined), '');
});

t('七套主题里只有两套不发 link', () => {
  const all = ['anzhiyu', 'paper', 'ink', 'forest', 'ocean', 'plum', 'mono'];
  const withLink = all.filter((id) => themeCssTag(id) !== '');
  assert.deepEqual(withLink, ['ink', 'forest', 'ocean', 'plum', 'mono']);
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
