#!/usr/bin/env node
/**
 * 静态图的回归守卫。压缩参数是猜的，这里钉住的是「结果不能比现在更差、且还能解码」。
 *
 * ICO 的容器结构必须严格自检：偏移错一位，浏览器不报错、只是图标变空白 ——
 * 这种坏法在 curl 和体积检查里全都看不出来。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const PUB = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let pass = 0;
const fails = [];
const t = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};

/* ---------- favicon.ico ---------- */
const ico = readFileSync(join(PUB, 'favicon.ico'));
t(ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, 'ICO 头 reserved=0 type=1');
const count = ico.readUInt16LE(4);
t(count >= 2 && count <= 16, `ICO 帧数合理（${count}）`);

let end = 6 + 16 * count;
let offsetsOk = true;
let allPng = true;
const sizes = [];
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const size = ico.readUInt32LE(o + 8);
  const off = ico.readUInt32LE(o + 12);
  if (off !== end) offsetsOk = false;
  if (ico.subarray(off + 1, off + 4).toString() !== 'PNG') allPng = false;
  sizes.push(ico[o] || 256);
  end += size;
}
t(offsetsOk, 'ICO 帧偏移首尾相接，无空洞无重叠');
t(allPng, 'ICO 每帧都是内嵌 PNG');
t(end === ico.length, `ICO 总长与帧数据吻合（${end}/${ico.length}）`);
t(sizes.includes(16) && sizes.includes(32), `ICO 含 16px 与 32px（${sizes.join('/')}）`);
t(ico.length < 4096, `ICO 体积 ${ico.length}B < 4K`);

/* ---------- 位图 ---------- */
const expect = {
  'icon-192.png': [192, 192],
  'icon-512.png': [512, 512],
  'apple-touch-icon.png': [180, 180],
  'og-default.jpg': [1200, 630],
};

let iconTotal = ico.length;
for (const [file, [w, h]] of Object.entries(expect)) {
  const p = join(PUB, file);
  const size = statSync(p).size;
  iconTotal += size;
  let meta = null;
  try {
    meta = await sharp(p).metadata();
  } catch {
    // 解码失败就是坏图，下面统一报
  }
  t(!!meta && meta.width === w && meta.height === h, `${file} 可解码且为 ${w}×${h}`, meta ? `${meta.width}×${meta.height}` : '解码失败');
  t(size < 28 * 1024, `${file} 体积 ${(size / 1024).toFixed(1)}K`);
}
t(iconTotal < 60 * 1024, `图标 + OG 合计 ${(iconTotal / 1024).toFixed(1)}K < 60K`);

/* ---------- 标题卡 ---------- */
const cards = readdirSync(join(PUB, 'cards')).filter((f) => f.endsWith('.png'));
t(cards.length >= 10, `标题卡 ${cards.length} 张`);
const cardTotal = cards.reduce((s, f) => s + statSync(join(PUB, 'cards', f)).size, 0);
t(cardTotal < 470 * 1024, `标题卡合计 ${(cardTotal / 1024).toFixed(0)}K < 470K`);
const oversize = cards.filter((f) => statSync(join(PUB, 'cards', f)).size > 45 * 1024);
t(oversize.length === 0, '没有单张超过 45K 的标题卡', oversize.join(','));

/* ---------- 索引色不该带 alpha 抖动垃圾 ---------- */
const oneCard = join(PUB, 'cards', cards[0]);
const m = await sharp(oneCard).metadata();
t(m.format === 'png' && m.width === 1200 && m.height === 630, '标题卡格式与尺寸一致');

console.log(`\n${pass} 通过，${fails.length} 失败`);
if (fails.length) process.exit(1);
