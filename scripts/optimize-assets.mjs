#!/usr/bin/env node
/**
 * public/ 下静态图的体积压榨。
 *
 *   node scripts/optimize-assets.mjs          原地重压（只写变小的）
 *   node scripts/optimize-assets.mjs --check  只比对预算，超了 exit 1
 *   node scripts/optimize-assets.mjs --dry    只报结果不落盘
 *
 * 三类目标的处理方式不同，别混着来：
 *
 * - **图标 / 标题卡**：PNG24 里那些渐变是纯熵，无损重压（zlib level 9）压不动 ——
 *   实测下来一张都省不了 1%。真正有效的是降到 256 色索引图，但抖动量必须压小：
 *   dither 1.0 会在平缓渐变上堆出可见颗粒斑（512 图标右侧那块），dither 0.5 +
 *   quality 100 反而又小又干净（PSNR 55，肉眼看不出）。
 * - **OG 分享图**：1200×630 的 JPEG，原文件只有 29KB（0.039 B/px），已经贴着 JPEG
 *   的地板。能动的只有色度抽样 4:4:4 → 4:2:0，省 15%。
 * - **favicon.ico**：里面是 4 张 PNG 帧（16/32/48/64），重新压帧再拼回容器。
 *   ICO 允许帧直接存 PNG 数据，原来的文件就是这么干的。
 *
 * 每一档都要过 PSNR 闸门再落地：量化参数是猜的，像素差是真的。
 */
import { readFileSync, writeFileSync, renameSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PUB = join(ROOT, 'public');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const DRY = args.includes('--dry');

/* 预算：不是目标值，是上限。改完图跑 --check，超了说明这次的编码参数退化了。 */
const BUDGET = {
  'favicon.ico': 4 * 1024,
  'icon-192.png': 6.5 * 1024,
  'icon-512.png': 18 * 1024,
  'apple-touch-icon.png': 6 * 1024,
  'og-default.jpg': 26 * 1024,
  'cards/*': 470 * 1024,
};

const kb = (n) => (n / 1024).toFixed(1) + 'K';
const pct = (a, b) => ((1 - b / a) * 100).toFixed(0) + '%';

/* 低于这个比例就不写：二次量化是累计有损的，为了 1% 再啃一遍不值。
   这道闸门同时保证脚本可重复执行 —— 跑两遍不会把图越压越糊。 */
const MIN_GAIN = 0.05;

/* PNG 的 IHDR 里第 25 字节是 color type，3 = 索引色。
   sharp 的 metadata 不报这个，只能直接读文件头。 */
function pngColorType(buf) {
  return buf.length > 25 && buf[0] === 0x89 ? buf[25] : -1;
}

async function psnr(a, b) {
  const A = await sharp(a).raw().toBuffer();
  const B = await sharp(b).raw().toBuffer();
  if (A.length !== B.length) throw new Error('尺寸不一致，无法比较');
  let se = 0;
  for (let i = 0; i < A.length; i++) {
    const d = A[i] - B[i];
    se += d * d;
  }
  // MSE 为 0 时返回 99 而不是 Infinity，方便打印
  return se === 0 ? 99 : 10 * Math.log10((255 * 255 * A.length) / se);
}

/**
 * PNG：在「无损」和几档索引色之间挑体积最小的合格品。
 * minPsnr 是硬闸门 —— 索引色本质是有损，闸门兜住肉眼可辨的那部分。
 */
async function optimizePng(file, { minPsnr = 50 } = {}) {
  const cur = statSync(file).size;
  const buf = readFileSync(file);
  if (pngColorType(buf) === 3) return { cur, best: null, skip: '已是索引色' };
  const candidates = [];

  // 无损档：zlib level 9 + 自适应行滤波。注意绝不能带 effort —— sharp 的
  // effort 是给索引色量化用的，配上去会悄悄改变像素（实测最大偏差 16）。
  candidates.push({ name: '无损 l9', buf: await sharp(buf).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer() });

  for (const [q, d] of [[100, 0.5], [95, 1], [92, 1]]) {
    candidates.push({
      name: `索引 q${q}/d${d}`,
      buf: await sharp(buf).png({ palette: true, quality: q, effort: 10, compressionLevel: 9, dither: d }).toBuffer(),
    });
  }

  let best = null;
  for (const c of candidates) {
    if (c.buf.length >= cur) continue;
    const p = await psnr(buf, c.buf);
    c.psnr = p;
    if (p < minPsnr) continue;
    if (!best || c.buf.length < best.buf.length) best = c;
  }
  if (best && best.buf.length > cur * (1 - MIN_GAIN)) best = null;
  return { cur, best };
}

async function optimizeJpeg(file, { minPsnr = 44 } = {}) {
  const cur = statSync(file).size;
  const buf = readFileSync(file);
  const meta = await sharp(buf).metadata();
  // 已经是渐进式 + 4:2:0 就认为压过了，再压一轮等于二次有损
  if (meta.isProgressive && meta.chromaSubsampling === '4:2:0') return { cur, best: null, skip: '已是渐进 4:2:0' };
  const candidates = [];
  for (const [q, sub] of [[70, '4:2:0'], [65, '4:2:0'], [60, '4:2:0'], [70, '4:4:4']]) {
    candidates.push({
      name: `q${q} ${sub}`,
      buf: await sharp(buf).jpeg({ quality: q, mozjpeg: true, progressive: true, chromaSubsampling: sub }).toBuffer(),
    });
  }
  let best = null;
  for (const c of candidates) {
    if (c.buf.length >= cur) continue;
    const p = await psnr(buf, c.buf);
    c.psnr = p;
    if (p < minPsnr) continue;
    if (!best || c.buf.length < best.buf.length) best = c;
  }
  if (best && best.buf.length > cur * (1 - MIN_GAIN)) best = null;
  return { cur, best };
}

/* ---------- favicon.ico ---------- */

function parseIco(buf) {
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf[o] || 256;
    const h = buf[o + 1] || 256;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    frames.push({ w, h, data: buf.subarray(off, off + size) });
  }
  return frames;
}

function buildIco(frames) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let off = 6 + 16 * frames.length;
  frames.forEach((f, i) => {
    const o = i * 16;
    dir[o] = f.w >= 256 ? 0 : f.w;
    dir[o + 1] = f.h >= 256 ? 0 : f.h;
    dir[o + 2] = 0; // 调色板色数，0 表示 256 以上
    dir[o + 3] = 0; // 保留
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(f.data.length, o + 8);
    dir.writeUInt32LE(off, o + 12);
    off += f.data.length;
  });
  return Buffer.concat([head, dir, ...frames.map((f) => f.data)]);
}

async function optimizeIco(file) {
  const cur = statSync(file).size;
  const frames = parseIco(readFileSync(file));
  const out = [];
  const notes = [];
  let worst = 99;
  for (const f of frames) {
    // 只有 PNG 帧能被 sharp 处理；BMP 帧原样保留（老格式，这里不该出现）
    if (f.data.subarray(1, 4).toString() !== 'PNG') {
      out.push(f);
      continue;
    }
    const r = await optimizePngBuffer(f.data, { minPsnr: 45 });
    if (r.buf !== f.data) worst = Math.min(worst, r.psnr);
    notes.push(`${f.w}px ${f.data.length}→${r.buf.length}`);
    out.push({ ...f, data: r.buf.length < f.data.length ? r.buf : f.data });
  }
  const built = buildIco(out);
  return { cur, best: built.length < cur ? { name: 'ICO 重压', buf: built, psnr: worst } : null, notes };
}

async function optimizePngBuffer(buf, { minPsnr }) {
  let best = { buf, psnr: 99 };
  if (pngColorType(buf) === 3) return best;
  for (const [q, d] of [[100, 0.5], [95, 1], [92, 1]]) {
    const cand = await sharp(buf).png({ palette: true, quality: q, effort: 10, compressionLevel: 9, dither: d }).toBuffer();
    if (cand.length >= best.buf.length * (1 - MIN_GAIN)) continue;
    const p = await psnr(buf, cand);
    if (p < minPsnr) continue;
    best = { buf: cand, psnr: p };
  }
  return best;
}

/* ---------- 主流程 ---------- */

function commit(file, buf) {
  if (DRY) return;
  const tmp = file + '.tmp';
  writeFileSync(tmp, buf);
  renameSync(tmp, file);
}

const rows = [];
async function run(file, fn, label) {
  const r = await fn(file);
  const name = basename(file);
  if (!r.best) {
    rows.push({ name, cur: r.cur, after: r.cur, note: r.skip || '已是最优，未动' });
    return;
  }
  commit(file, r.best.buf);
  rows.push({ name, cur: r.cur, after: r.best.buf.length, psnr: r.best.psnr, note: (r.notes || []).join(' ') || r.best.name });
}

if (CHECK) {
  const over = [];
  const show = (name, size, budget) => {
    const ok = size <= budget;
    console.log(`${ok ? 'ok  ' : 'OVER'}  ${name.padEnd(22)} ${kb(size).padStart(8)} / 预算 ${kb(budget)}`);
    if (!ok) over.push(name);
  };
  for (const [k, b] of Object.entries(BUDGET)) {
    if (k.endsWith('/*')) {
      const dir = join(PUB, k.slice(0, -2));
      const total = readdirSync(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0);
      show(k, total, b);
    } else {
      show(k, statSync(join(PUB, k)).size, b);
    }
  }
  if (over.length) {
    console.log(`\n超出预算 ${over.length} 项：${over.join(', ')}`);
    process.exit(1);
  }
  console.log('\n全部在预算内');
} else {
  await run(join(PUB, 'icon-192.png'), (f) => optimizePng(f, { minPsnr: 50 }), 'icon');
  await run(join(PUB, 'icon-512.png'), (f) => optimizePng(f, { minPsnr: 50 }), 'icon');
  await run(join(PUB, 'apple-touch-icon.png'), (f) => optimizePng(f, { minPsnr: 50 }), 'icon');
  await run(join(PUB, 'favicon.ico'), optimizeIco, 'ico');
  await run(join(PUB, 'og-default.jpg'), (f) => optimizeJpeg(f, { minPsnr: 44 }), 'og');

  const cards = join(PUB, 'cards');
  for (const f of readdirSync(cards).sort()) {
    if (!f.endsWith('.png')) continue;
    await run(join(cards, f), (x) => optimizePng(x, { minPsnr: 45 }), 'card');
  }

  let before = 0;
  let after = 0;
  console.log('\n文件                          前        后      省     PSNR  说明');
  for (const r of rows) {
    before += r.cur;
    after += r.after;
    const p = r.psnr === undefined ? '  -  ' : r.psnr === 99 ? ' 无损' : r.psnr.toFixed(1);
    console.log(
      `${r.name.padEnd(28)} ${kb(r.cur).padStart(8)} ${kb(r.after).padStart(9)} ${pct(r.cur, r.after).padStart(5)} ${p}  ${r.note}`
    );
  }
  console.log(`\n合计 ${kb(before)} → ${kb(after)}，省 ${pct(before, after)}${DRY ? '（--dry 未落盘）' : ''}`);
}
