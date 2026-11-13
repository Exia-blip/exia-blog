// RSS 2.0 输出回归。重点盯三件容易悄悄坏掉的事：
//   1. <author> / <dc:creator> 有没有真的写出来（写了但落在 CDATA 里等于没写）
//   2. <ttl> 与 HTTP 缓存是否还对齐（不对齐 reader 每小时来一次也拿不到新的）
//   3. 作者名里带 & < " 时，feed 会不会直接变成非法 XML —— 这种坏法
//      浏览器打开还看得见内容，只有 reader 会静默丢整份订阅。
// 用法：node scripts/test-rss.mjs
import assert from 'node:assert/strict';
import { rssDoc, rssItem } from '../src/index.js';

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + name);
};

const origin = 'https://exia.de5.net';
const site = { name: 'Exia Blog', desc: '写字的地方', author: 'Exia' };
const lastBuild = 'Sat, 14 Nov 2026 04:00:00 GMT';

const doc = (over = {}) => rssDoc({ origin, site, items: '', lastBuild, ...over });

/* ---------- channel 级 ---------- */
t('channel 用 <managingEditor> + <dc:creator>，不写 channel 层的 <author>', () => {
  const x = doc();
  assert.match(x, /<managingEditor>Exia<\/managingEditor>/);
  assert.match(x, /<dc:creator>Exia<\/dc:creator>/);
  // RSS 2.0 的 channel 没有 <author>，写了会被校验器判为未定义元素
  const head = x.split('</channel>')[0];
  assert.doesNotMatch(head, /<author>/);
});

t('声明了 dc 命名空间，否则 dc:creator 不是合法前缀', () => {
  assert.match(doc(), /xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\/"/);
});

t('<ttl> 是 60 分钟', () => {
  assert.match(doc(), /<ttl>60<\/ttl>/);
});

t('author 为空串时退回站名，不会输出空标签', () => {
  const x = doc({ site: { ...site, author: '' } });
  assert.match(x, /<managingEditor>Exia Blog<\/managingEditor>/);
  assert.doesNotMatch(x, /<managingEditor><\/managingEditor>/);
});

t('desc 为空时退回站名', () => {
  assert.match(doc({ site: { ...site, desc: '' } }), /<description>Exia Blog<\/description>/);
});

t('作者名里的 & < " 被转义，不会破坏 XML', () => {
  const x = doc({ site: { ...site, author: 'A & B <c>' } });
  assert.match(x, /<managingEditor>A &amp; B &lt;c&gt;<\/managingEditor>/);
  assert.doesNotMatch(x, /<managingEditor>A & B/);
});

/* ---------- item 级 ---------- */
const post = {
  slug: '三层缓存',
  title: '三层缓存 & 失效',
  content: '正文',
  summary: '摘要',
  category: 'notes',
  published_at: '2026-11-14 04:00:00',
  created_at: '2026-11-14 04:00:00',
};

const item = (over = {}) => rssItem({ origin, post, author: 'Exia', html: '<p>正文</p>', ...over });

t('item 带 author 与 dc:creator', () => {
  const x = item();
  assert.match(x, /<author>Exia<\/author>/);
  assert.match(x, /<dc:creator>Exia<\/dc:creator>/);
});

t('item 的 slug 做了 URL 编码，& 不会漏进 link', () => {
  assert.match(item(), /<link>https:\/\/exia\.de5\.net\/p\/%E4%B8%89%E5%B1%82%E7%BC%93%E5%AD%98<\/link>/);
});

t('item 标题转义，CDATA 里放渲染后的 html', () => {
  const x = item();
  assert.match(x, /<title>三层缓存 &amp; 失效<\/title>/);
  assert.match(x, /<content:encoded><!\[CDATA\[<p>正文<\/p>\]\]><\/content:encoded>/);
});

t('正文里的 ]]> 被拆开，不会提前闭合 CDATA', () => {
  const x = item({ html: 'a]]>b' });
  assert.match(x, /a\]\]\]\]><!\[CDATA\[>b/);
});

t('item 的 author 为空时保留标签但不吞掉下面的字段', () => {
  const x = item({ author: '' });
  assert.match(x, /<dc:creator><\/dc:creator>/);
  assert.match(x, /<description>摘要<\/description>/);
});

/* ---------- 整体 ---------- */
t('整份 feed 的 & 全部是实体，没有裸的 &', () => {
  const x = doc({
    site: { name: 'A&B', desc: 'x', author: 'A&B' },
    items: item({ author: 'A&B' }),
  });
  // 允许 &amp; &lt; &gt; &quot; &apos;，其余一律算错
  const bad = [...x.matchAll(/&(?!amp;|lt;|gt;|quot;|apos;)/g)];
  assert.equal(bad.length, 0, `出现 ${bad.length} 处裸 &：${bad.map((m) => x.slice(m.index, m.index + 12))}`);
});

t('channel 的三个必需元素都在：title / link / description', () => {
  const x = doc();
  for (const tag of ['title', 'link', 'description']) assert.match(x, new RegExp(`<${tag}>`));
  assert.match(x, /<link>https:\/\/exia\.de5\.net\/<\/link>/);
});

console.log(`\n${pass} 条全过`);
