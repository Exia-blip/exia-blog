// 相关推荐排序单测：标签交集优先、同栏目兜底、排除自身与私密隐藏、空则不渲染。
// 用法：node scripts/test-related.mjs
import assert from 'node:assert/strict';
import { rankRelated } from '../src/related.js';

const t = (name, fn) => {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + ' — ' + e.message);
    process.exitCode = 1;
  }
};

const post = { slug: 'cur', tags: ['cloudflare', 'cache'], category: 'teardown' };
const row = (slug, over = {}) => ({
  slug,
  category: 'other',
  tag_str: '',
  published_at: '2026-11-01 00:00:00',
  ...over,
});

console.log('相关推荐排序');

t('共同标签 2 篇排在 1 篇前面', () => {
  const r = rankRelated(post, [
    row('one', { tag_str: 'cache' }),
    row('two', { tag_str: 'cloudflare\u001fcache\u001fextra' }),
  ]);
  assert.equal(r[0].slug, 'two');
});

t('标签数相同时同栏目优先', () => {
  const r = rankRelated(post, [
    row('cross', { tag_str: 'cache' }),
    row('same', { tag_str: 'cache', category: 'teardown' }),
  ]);
  assert.equal(r[0].slug, 'same');
});

t('标签与栏目都不沾的候选被排除', () => {
  const r = rankRelated(post, [row('irrelevant', { tag_str: 'oauth', category: 'other' })]);
  assert.equal(r.length, 0);
});

t('排除当前文章自己', () => {
  const r = rankRelated(post, [row('cur', { tag_str: 'cloudflare\u001fcache' })]);
  assert.equal(r.length, 0);
});

t('排除私密与隐藏文章', () => {
  const r = rankRelated(post, [
    row('priv', { tag_str: 'cache', is_private: 1 }),
    row('hid', { tag_str: 'cache', hidden: 1 }),
    row('ok', { tag_str: 'cache' }),
  ]);
  assert.deepEqual(r.map((x) => x.slug), ['ok']);
});

t('最多取 limit 篇（默认 3）', () => {
  const cands = Array.from({ length: 6 }, (_, i) => row('p' + i, { tag_str: 'cache' }));
  assert.equal(rankRelated(post, cands).length, 3);
  assert.equal(rankRelated(post, cands, 2).length, 2);
});

t('同栏目无标签也进候选（栏目兜底）', () => {
  const r = rankRelated(post, [row('samecat', { category: 'teardown' })]);
  assert.equal(r.length, 1);
  assert.equal(r[0].slug, 'samecat');
});

t('标签数/栏目都相同时按发布时间新→旧', () => {
  const r = rankRelated(post, [
    row('old', { tag_str: 'cache', published_at: '2026-01-01 00:00:00' }),
    row('new', { tag_str: 'cache', published_at: '2026-10-01 00:00:00' }),
  ]);
  assert.equal(r[0].slug, 'new');
});

t('空候选 / 无标签无栏目都不报错', () => {
  assert.deepEqual(rankRelated(post, []), []);
  assert.deepEqual(rankRelated({ slug: 'x' }, [row('a', { tag_str: 'cache' })]), []);
});

t('返回的候选行不被改写', () => {
  const c = row('a', { tag_str: 'cache' });
  rankRelated(post, [c]);
  assert.equal(Object.keys(c).length, 4);
});

if (!process.exitCode) console.log('\nPASS  相关推荐排序全部通过');
