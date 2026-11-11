// 路径规范化回归：一条规则吃掉尾斜杠和大小写两类 404。
// 用法：node scripts/test-routes.mjs
import assert from 'node:assert/strict';
import { normalizePagePath } from '../src/routes.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const eq = (input, want) => t(`${input} → ${want}`, () => assert.equal(normalizePagePath(input), want));

// 根路径不动，否则会把自己重定向成空
eq('/', '/');
eq('', '/');

// 尾斜杠
eq('/p/editor-autosave/', '/p/editor-autosave');
eq('/p/editor-autosave//', '/p/editor-autosave');
eq('/friends/', '/friends');
eq('/about/', '/about');
eq('/archive/2026/', '/archive/2026');
eq('//', '/');

// 大小写
eq('/tag/Cloudflare', '/tag/cloudflare');
eq('/tag/Cloudflare/', '/tag/cloudflare');
eq('/cat/Tools', '/cat/tools');
eq('/p/Editor-Autosave', '/p/editor-autosave');
eq('/About', '/about');
eq('/Archive', '/archive');

// 两种情况叠在一起：一次跳完，不要 /Tag/x/ → /tag/x/ → /tag/x 两跳
eq('/Tag/Cloudflare/', '/tag/cloudflare');

// 资源路径一律不碰：R2 键与静态文件名大小写敏感
eq('/img/u/ABC.svg', '/img/u/ABC.svg');
eq('/thumbs/01.webp', '/thumbs/01.webp');
eq('/assets/App.js', '/assets/App.js');
eq('/app.js', '/app.js');
eq('/style.css', '/style.css');

// API 不受影响（写请求本来也走不到这条规则，因为只放 GET/HEAD）
eq('/api/comments', '/api/comments');
eq('/api/friends/', '/api/friends');

// 百分号编码路径只去尾斜杠，不改编码大小写
eq('/cat/%E5%B0%8F%E5%B7%A5%E5%85%B7', '/cat/%E5%B0%8F%E5%B7%A5%E5%85%B7');
eq('/tag/%E4%B8%AD%E6%96%87/', '/tag/%E4%B8%AD%E6%96%87');

// 已经是规范形式的不产生重定向
t('规范路径返回自身', () => {
  for (const p of ['/', '/p/editor-autosave', '/tag/cloudflare', '/archive/2026', '/friends']) {
    assert.equal(normalizePagePath(p), p);
  }
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
