/**
 * 图片尺寸的两段逻辑各测一遍：
 *   1. imageSize() —— 从字节头读宽高，认不出来的格式必须返回 null（不能瞎猜）
 *   2. renderBody() —— 把 URL 里的 w/h 变成 width/height 属性，并把这俩参数剥掉
 *
 * 第 2 条是重点：属性只是排版用，URL 必须回到干净状态，否则同一张图
 * 在边缘缓存里会分成 /x.jpg 和 /x.jpg?w=800 两份。
 */
import sharp from 'sharp';
import { imageSize, withSize } from '../src/img-size.js';
import { renderBody } from '../public/md.js';

let pass = 0;
let fail = 0;
const t = (ok, name, extra = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

const canvas = (w, h) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 80, g: 140, b: 200 } } });

console.log('imageSize：真实文件头解析');

for (const [fmt, w, h] of [
  ['png', 640, 480],
  ['jpeg', 900, 600],
  ['webp', 512, 384],
  ['avif', 300, 200],
  ['gif', 120, 90],
]) {
  let buf;
  try {
    buf = await canvas(w, h).toFormat(fmt).toBuffer();
  } catch (e) {
    t(false, `${fmt} 生成失败`, e.message);
    continue;
  }
  const got = imageSize(buf);
  t(got && got.w === w && got.h === h, `${fmt} ${w}×${h}`, got ? `→ ${got.w}×${got.h}` : '→ null');
}

// 竖图 / 极端比例：宽高不能弄反（JPEG 的 SOF 段里高在前宽在后，最容易弄反）
{
  const buf = await canvas(200, 1000).toFormat('jpeg').toBuffer();
  const got = imageSize(buf);
  t(got && got.w === 200 && got.h === 1000, 'JPEG 竖图宽高没有弄反', got ? `${got.w}×${got.h}` : 'null');
}

// 认不出来的东西必须是 null，不能返回 0×0 或瞎猜
{
  const junk = new Uint8Array(200).fill(0x42);
  t(imageSize(junk) === null, '未知字节流返回 null');
  t(imageSize(new Uint8Array(4)) === null, '太短的数据返回 null');
  t(imageSize('不是图片') === null, '非字节入参返回 null');
}

console.log('\nwithSize：拼参不重复');

{
  t(withSize('/img/a.png', { w: 10, h: 20 }) === '/img/a.png?w=10&h=20', '无查询串时用 ?');
  t(withSize('/img/a.png?v=2', { w: 10, h: 20 }) === '/img/a.png?v=2&w=10&h=20', '已有查询串时用 &');
  t(withSize('/img/a.png?w=10&h=20', { w: 99, h: 99 }) === '/img/a.png?w=10&h=20', '已有尺寸不重复追加');
  t(withSize('/img/a.png', null) === '/img/a.png', '没有尺寸就原样返回');
}

console.log('\nrenderBody：属性与 URL 剥离');

{
  const out = renderBody('![示意图](/img/u/x.png?w=800&h=400)');
  t(/width="800"/.test(out) && /height="400"/.test(out), '写出 width/height 属性', out.match(/<img[^>]*>/)?.[0] || '');
  t(!/w=800/.test(out) && !/h=400/.test(out), 'src 里不再带尺寸参数');
  t(/src="\/img\/u\/x\.png"/.test(out), 'src 回到干净路径');
}

{
  // 尺寸参数跟其它参数混在一起时，只删尺寸那两个
  const out = renderBody('![a](/img/u/x.png?v=3&w=800&h=400)');
  t(/width="800"/.test(out) && /height="400"/.test(out), '混合参数时仍能取到尺寸');
  t(/src="\/img\/u\/x\.png\?v=3"/.test(out), '其它参数保留', out.match(/src="[^"]*"/)?.[0] || '');
}

{
  // 没有尺寸的图：不能凭空编一个 width/height
  const out = renderBody('![a](/img/u/old.png)');
  t(!/width=/.test(out) && !/height=/.test(out), '没有尺寸的图不写属性（不瞎猜）');
  t(/<picture>/.test(out), '仍然生成 picture 多格式候选');
}

{
  // picture 的 srcset 也要用剥干净的 URL，否则变体地址会带上无意义的查询串
  const out = renderBody('![a](/img/u/x.jpg?w=1200&h=800)');
  const srcset = [...out.matchAll(/srcset="([^"]+)"/g)].map((m) => m[1]);
  t(srcset.length >= 1 && srcset.every((s) => !/[?&]w=/.test(s)), 'srcset 不带尺寸参数', srcset.join(' | '));
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
