// 复制署名回归：文案拼装 / 触发边界 / 富文本转义
// 用法：node scripts/test-copy-notice.mjs
import assert from 'node:assert/strict';
import { noticeText, shouldAttach, joinCopy, noticeHtml, MIN_CHARS, DEFAULTS } from '../public/copy-notice.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('声明是三行，顺序为 作者 / 来源 / 协议', () => {
  const lines = noticeText().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^作者: Gund Blog$/);
  assert.match(lines[1], /^本文来自于: https:\/\//);
  assert.match(lines[2], /^博客内容遵循 .+ 协议$/);
});

t('来源指向站点根，且带结尾斜杠', () => {
  const src = noticeText().split('\n')[1].replace('本文来自于: ', '');
  assert.ok(src.endsWith('/'), src);
  assert.ok(new URL(src), src);
});

t('协议名完整到版本号，别只剩 CC BY-NC-SA', () => {
  assert.ok(noticeText().includes('署名-非商业性使用-相同方式共享 4.0 国际'));
  assert.ok(noticeText().includes('CC BY-NC-SA 4.0'));
});

t('配置可覆盖，未覆盖的字段仍取默认值', () => {
  const out = noticeText({ author: '某某' });
  assert.ok(out.startsWith('作者: 某某'), out);
  assert.ok(out.includes(DEFAULTS.site), out);
  assert.ok(out.includes(DEFAULTS.license), out);
});

t('正文之外的选区不加', () => {
  assert.equal(shouldAttach({ inBody: false, chars: 9999 }), false);
});

t('代码块里的选区不加（粘代码不能带中文尾巴）', () => {
  assert.equal(shouldAttach({ inBody: true, inCode: true, chars: 9999 }), false);
});

t('短于门槛不加，等于门槛加', () => {
  assert.equal(shouldAttach({ inBody: true, chars: MIN_CHARS - 1 }), false);
  assert.equal(shouldAttach({ inBody: true, chars: MIN_CHARS }), true);
});

t('默认不传参时按"不满足"处理，避免空选中也触发', () => {
  assert.equal(shouldAttach(), false);
  assert.equal(shouldAttach({}), false);
});

t('拼接保留正文，只在尾部补两个换行', () => {
  const out = joinCopy('正文一段', 'NOTICE');
  assert.equal(out, '正文一段\n\nNOTICE');
});

t('正文末尾一堆空白先削掉，剪贴板不留三段空行', () => {
  assert.equal(joinCopy('正文\n\n\n  ', 'N'), '正文\n\nN');
});

t('长正文一字不改（只动尾部空白）', () => {
  const body = '第一段\n\n第二段   中间空格保留\n';
  assert.ok(joinCopy(body, 'N').startsWith('第一段\n\n第二段   中间空格保留\n\nN'));
});

t('富文本版第一行加粗，其余三行换行', () => {
  const html = noticeHtml('A\nB\nC');
  assert.ok(html.includes('<strong'), html);
  assert.equal((html.match(/<br>/g) || []).length, 2);
  assert.ok(html.includes('border-top'), '要和正文有可见分隔');
});

t('富文本版转义尖括号，配置写进 HTML 也炸不了', () => {
  const html = noticeHtml('作者: <script>x</script>\nB\nC');
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\ncopy-notice: ${pass}/${cases.length} 通过`);
