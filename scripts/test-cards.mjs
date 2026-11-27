// 标题卡与 og:image 断言（P-038 ~ P-041）
//
// 用法：node scripts/test-cards.mjs
//
// 与 check-live.mjs 的分工同行里其他几对：这里守「代码怎么算」和「仓库里的图什么尺寸」，
// 不需要网络、不需要部署；check-live 守「线上真发出去的 og:image 取得到、尺寸对得上」。
//
// 为什么不是「扫 content/*.md 的 frontmatter」：本站文章在 D1，content/*.md 只是
// 一次性 seed 的原文，封面是 posts.cover 一列，文件里根本没有这个字段。
// 断言必须打在 coverOf()/ogCoverOf() 这个唯一出口上，才和线上是同一条路。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverOf, ogCoverOf, isAutoCover, isCardCover, AUTO_COVER_COUNT } from '../src/cover.js';
import { report } from './pitfall-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CARDS = join(ROOT, 'public/cards');
const THUMBS = join(ROOT, 'public/thumbs');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let bad = 0;
const t = (id, name, fn) => {
  try {
    fn();
    if (!report(id, name, true)) bad++;
  } catch (e) {
    if (!report(id, name, false, e.message)) bad++;
  }
};

/* ---------- 图片尺寸：读真实字节 ----------

   注意 readFileSync 不带 encoding —— 带 'utf8' 会把 0x89 这类高位字节
   替换成 EF BF BD，签名立刻不认识，尺寸解析返回 null，于是「尺寸不对」
   永远不报，断言静默通过。消息里那句「先 utf8 再 Buffer.from(x,'binary')」
   是同一类错：几万字节读出来长度都不对，签名变成 fd504e47。 */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const m = buf[i + 1];
    // SOF0~SOF3 / SOF5~SOF7 / SOF9~SOF11 / SOF13~SOF15 带尺寸；C4/C8/CC 是霍夫曼/算术表
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/* ---------- 1. coverOf / ogCoverOf 的类型真值表 ---------- */

const preset = (id) => ({ id, slug: `p${id}`, title: 't', content: '' });
const carded = { id: 7, slug: 'x', title: 't', cover: '/cards/x.png', content: '' };
const custom = { id: 8, slug: 'y', title: 't', cover: '/img/abc.webp', content: '' };
const bodyImg = { id: 9, slug: 'z', title: 't', cover: '', content: '开头\n\n![图](/img/body.webp)\n\n正文' };

t('P-038', '空封面走预设图，且文件在 1..N 范围内', () => {
  const o = ogCoverOf(preset(3));
  assert.match(o.path, new RegExp(`^/thumbs/auto-[1-${AUTO_COVER_COUNT}]\\.jpg$`), o.path);
  assert.equal(o.type, 'image/jpeg');
  assert.equal(o.w, 1200);
  assert.equal(o.h, 784);
});

t('P-041', '标题卡标 1200×630 PNG', () => {
  const o = ogCoverOf(carded);
  assert.equal(o.path, '/cards/x.png');
  assert.equal(o.type, 'image/png');
  assert.deepEqual([o.w, o.h], [1200, 630]);
});

t('P-040', '作者自传封面不标尺寸（不知道就别猜）', () => {
  const o = ogCoverOf(custom);
  assert.equal(o.path, '/img/abc.webp');
  for (const k of ['type', 'w', 'h']) assert.equal(o[k], null, `${k} 应为 null，实际 ${o[k]}`);
});

t('P-039', '正文首图能当封面，且不被标成标题卡', () => {
  const o = ogCoverOf(bodyImg);
  assert.equal(o.path, '/img/body.webp');
  assert.equal(o.type, null);
  assert.equal(isCardCover(bodyImg), false);
});

t('P-039', 'SVG 不进封面位（手填也不行），回落预设', () => {
  for (const c of ['/img/a.svg', '/img/a.svg?v=1', '/cards/a.svg']) {
    const o = ogCoverOf({ id: 2, slug: 's', title: 't', cover: c, content: '' });
    assert.match(o.path, /^\/thumbs\/auto-\d\.jpg$/, `${c} → ${o.path}`);
  }
});

t('P-038', 'coverOf 对空对象 / undefined 也非空', () => {
  for (const p of [undefined, null, {}, { id: 0, slug: '', title: '' }]) {
    const p2 = coverOf(p);
    assert.ok(p2 && p2.trim(), `输入 ${JSON.stringify(p)} 得到 ${JSON.stringify(p2)}`);
  }
});

t('P-038', '同一篇每次都是同一张（列表不能刷一次变一次）', () => {
  const a = coverOf(preset(11));
  const b = coverOf(preset(11));
  assert.equal(a, b);
});

t('P-038', '预设图有分散度：id 1..N 命中 N 张不同图', () => {
  const set = new Set();
  for (let i = 1; i <= AUTO_COVER_COUNT; i++) set.add(coverOf(preset(i)));
  assert.equal(set.size, AUTO_COVER_COUNT, `只分到 ${set.size} 张`);
});

/* ---------- 2. 仓库里的图，尺寸必须是声明的那样 ----------

   逐文件断言，不做「目录空就跳过」：空目录才是最大的故障（分享图全裂），
   跳过等于把最坏情况当通过。

   判定抽成 sizeMatches 是为了能被自检 —— 一条只会返回 true 的尺寸断言，
   和没有这条断言是同一件事，而它自己不会告诉你。 */
function sizeMatches(buf, parse, want) {
  const s = parse(buf);
  return !!s && s.w === want.w && s.h === want.h;
}

function sweep(dir, ext, parse, want, id, label) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)) : [];
  t(id, `${label}目录里至少有图（${files.length} 张）`, () => assert.ok(files.length > 0, '一张都没有'));
  for (const f of files) {
    t(id, `${label} ${f} 是 ${want.w}×${want.h}`, () => {
      const buf = readFileSync(join(dir, f)); // 不带 encoding：给了 utf8 就不是字节了
      const s = parse(buf);
      assert.ok(s, '读不出尺寸（文件损坏或格式不对）');
      assert.deepEqual(s, want, `实际 ${s.w}×${s.h}`);
      assert.equal(sizeMatches(buf, parse, want), true);
    });
  }
}

sweep(CARDS, '.png', pngSize, { w: 1200, h: 630 }, 'P-041', '标题卡');
sweep(THUMBS, '.jpg', jpegSize, { w: 1200, h: 784 }, 'P-041', '预设图');

/* 断言自己的自检：把一张真图改成 800×420、再喂一段乱码，判定必须为假。
   如果哪天 sizeMatches 被改成「不抛错就算过」，这两条立刻红 ——
   上一版脚本里 `if (size) check(...)` 就是这个形态，结果永远绿。 */
t('P-041', '自检：尺寸判定对错图必须为假', () => {
  const files = readdirSync(CARDS).filter((f) => f.endsWith('.png'));
  assert.ok(files.length > 0, '没有可比对的真图');
  const good = readFileSync(join(CARDS, files[0]));
  const want = { w: 1200, h: 630 };
  assert.equal(sizeMatches(good, pngSize, want), true, '真图被判成不合格');

  const wrong = Buffer.from(good);
  wrong.writeUInt32BE(800, 16);
  wrong.writeUInt32BE(420, 20);
  assert.equal(sizeMatches(wrong, pngSize, want), false, '800×420 被判成 1200×630');

  assert.equal(sizeMatches(Buffer.from('这不是图片'), pngSize, want), false, '乱码被判成合格');
  assert.equal(sizeMatches(Buffer.alloc(0), pngSize, want), false, '空 buffer 被判成合格');
});

/* ---------- P-100：构建产物全量扫旧域字节 ----------
   抽样 3 张只能证明脚本对了，不能证明 40 张产物都对 —— 「脚本逻辑」与「产物全不全」
   是两层。判据挂在真实字节上（不带 utf8），不挂在生成脚本的源码上。 */
const LEGACY_HOST = 'exia.de5.net';
const hasLegacy = (buf) => buf.includes(Buffer.from(LEGACY_HOST, 'ascii'));

t('P-100', '自检：旧域判定对错字节必须为真', () => {
  const files = readdirSync(CARDS).filter((f) => f.endsWith('.png'));
  assert.ok(files.length > 0, '没有真卡可比对');
  const good = readFileSync(join(CARDS, files[0]));
  assert.equal(hasLegacy(good), false, '真卡被判成含旧域');
  assert.equal(hasLegacy(Buffer.concat([good, Buffer.from(LEGACY_HOST, 'ascii')])), true,
    '判定恒假 —— 全量扫会变成假绿');
});

t('P-100', '构建目录全量无旧域：cards / thumbs / og-default', () => {
  const files = [
    ...readdirSync(CARDS).filter((f) => f.endsWith('.png')).map((f) => join(CARDS, f)),
    ...readdirSync(THUMBS).filter((f) => f.endsWith('.jpg')).map((f) => join(THUMBS, f)),
    join(ROOT, 'public/og-default.jpg'),
  ];
  assert.ok(files.length >= 40, `只扫到 ${files.length} 张，样本不足（构建期全量是 40 卡 + 6 预设）`);
  let scanned = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    assert.equal(hasLegacy(buf), false, `${f} 含旧域 ${LEGACY_HOST}`);
    scanned++;
  }
  assert.equal(scanned, files.length, `只扫了 ${scanned}/${files.length} 张`);
});

/* ---------- 3. 元断言：防止「断言还在，测的东西没了」 ---------- */

t('P-040', 'index.js 用 ogCoverOf 生成 og:image 与尺寸', () => {
  const s = read('src/index.js');
  assert.match(s, /const og = ogCoverOf\(post\)/, 'og 元信息没有走 ogCoverOf');
  assert.match(s, /new URL\(og\.path, origin\)/, 'og:image 不是从 og.path 派生');
  assert.match(s, /const ogKind = og\.type \?/, '尺寸判定被改写，可能又内联了');
  assert.ok(!/isCardCover\(post\)\s*\?\s*\{/.test(s), '又出现内联的三元尺寸判定');
});

t('P-040', 'check-live 里确实有 og:image 的线上断言', () => {
  const s = read('scripts/check-live.mjs');
  assert.match(s, /P-040/, '线上不打 og:image，这套断言就只有一半');
  assert.match(s, /og:image/, '没找到 og:image 字样');
});

/* ---------- P-105：生成脚本的产物必须自带压缩 ----------
   只验仓库里当前的 PNG 是压缩过的没有用 —— 那是上次跑 optimize 的结果，
   下次 --apply 重渲染会把它们覆盖回 PNG24。判据要落在「脚本做了什么」上。 */
t('P-105', 'gen-cards 渲染后必接 optimize-assets，产物天生过预算闸门', () => {
  const gen = read('scripts/gen-cards.mjs');
  const pyAt = gen.indexOf("'gen-title-cards.py'");
  const optAt = gen.indexOf("'optimize-assets.mjs'");
  assert.ok(pyAt > 0, '找不到渲染调用，判据失效');
  assert.ok(optAt > 0, 'gen-cards 没调 optimize-assets —— --apply 会产出未压缩 PNG');
  assert.ok(optAt > pyAt, '压缩写在渲染之前，等于没压');
  /* 独立计数：调用必须在 apply 分支之外，否则只出图模式仍留未压缩产物。
     用 apply 分支的 `if (apply) {` 位置作界，不靠自造的标志串。 */
  const applyAt = gen.indexOf('if (apply) {');
  assert.ok(applyAt > 0, '找不到 apply 分支，判据失效');
  assert.ok(optAt < applyAt, '压缩放在 apply 分支里，只出图模式会漏');
});

console.log(
  bad ? `\n✗ 标题卡断言 ${bad} 项失败` : `\n✓ 标题卡断言全部通过（ogCoverOf 真值表 + 仓库图片尺寸 + 元断言）`
);
process.exit(bad ? 1 : 0);
