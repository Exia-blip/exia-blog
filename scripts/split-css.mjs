#!/usr/bin/env node
/* 一次性迁移：把 style.css 里的路由专属样式拆到独立文件。
 *
 * 为什么不用「大区整块搬」：共享选择器混在专属大区里 ——
 *   .field    在编辑器和文章评论表单都用
 *   .dot/.chi/.lnk/.tag.on/#hero-sub 归档区定义、首页/文章页也用
 *   @keyframes arch-skel 归档骨架和友链骨架共用
 * 整块搬走会让别的页面掉样式。所以这里按精确行区间抽，共享的行留在主表。
 *
 * 行区间基于 style.css 拆分前的版本（2026-11-17，1926 行）。
 * 源被改过就别直接跑 —— 先核对下面的边界注释还对得上，否则会切错。
 *
 * 用法：
 *   node scripts/split-css.mjs --dry   只打印计划，不写文件
 *   node scripts/split-css.mjs         真正拆分（写 public/style.css + public/css/*.css）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CSS = 'public/style.css';
const OUT_DIR = 'public/css';

// [起, 止] 均为 1-indexed、含端点，基于拆分前的 style.css
const SPLITS = {
  'editor.css': [
    [532, 588],   // 编辑器主体（.field 589-590 是共享的，留主表）
    [592, 650],   // site-box / side-foot / cat-list
    [1017, 1045], // 站点头像设置（只在编辑器）
    [1484, 1494], // 编辑器发布自检（.tag.off 1495 共享，留主表）
  ],
  'friends.css': [
    [654, 699],   // 友链申请说明 + 卡片网格（arch-skel 在 861 留主表，被 698 引用）
    [703, 718],   // 友链卡片本体（.dot 719-723 留主表）
    [1850, 1865], // 友链管理按钮（fc-act / fc-btn）
  ],
  'login.css': [[725, 734]], // 登录页，纯专属
  'archive.css': [
    [809, 826],   // 归档条 + 分段器 + 年份筛选（.tag.on 827 共享）
    [828, 828],   // tag-n
    [842, 843],   // tl-dim
    [845, 860],   // 时间线骨架（arch-skel 861-864 留主表）
    [869, 939],   // 时间线 / 紧凑归档（@media 560 的 940-944 单独处理）
    [940, 944],   // 归档响应式；其中 .arch-side .chi 依赖主表的 .chi
  ],
};

const raw = fs.readFileSync(CSS, 'utf8');
const lines = raw.split('\n');

// 自检：区间边界必须和预期注释对得上，防止源文件改动后切错位置
const anchors = {
  532: '编辑器', 589: '.field', 592: '站点设置', 654: '.friend-apply',
  703: '.friend-card', 725: '登录页', 809: '.arch-bar', 828: '.tag-n',
  845: '时间线', 869: '.timeline', 940: '@media (max-width: 560px)',
  1017: '站点头像设置', 1484: '编辑器发布自检', 1850: '友链卡片',
};
const DRY = process.argv.includes('--dry');
for (const [ln, needle] of Object.entries(anchors)) {
  const text = lines[Number(ln) - 1] || '';
  if (!text.includes(needle)) {
    console.error(`边界漂移：第 ${ln} 行应含 "${needle}"，实际是 "${text.slice(0, 60)}"`);
    console.error('源文件 style.css 已被改动，请重新核对 scripts/split-css.mjs 的行区间后再跑。');
    process.exit(1);
  }
}

const taken = new Set();
const parts = {};
for (const [file, ranges] of Object.entries(SPLITS)) {
  const chunks = [];
  for (const [a, b] of ranges) {
    for (let i = a; i <= b; i++) {
      if (taken.has(i)) throw new Error(`第 ${i} 行被两个分片重复占用`);
      taken.add(i);
      chunks.push(lines[i - 1]);
    }
    chunks.push('');
  }
  parts[file] = `/* 从 style.css 拆出：${file}\n   路由专属样式，只有对应页面加载。共享规则（.field/.dot/.chi/.lnk 等）仍在主表。 */\n\n${chunks.join('\n').trim()}\n`;
}

const main = lines.filter((_, i) => !taken.has(i + 1)).join('\n');
const br = (s) => zlib.brotliCompressSync(Buffer.from(s)).length;

console.log('原 style.css:', Buffer.byteLength(raw), 'B / brotli', br(raw), 'B');
for (const [file, text] of Object.entries(parts)) {
  console.log(`  ${file.padEnd(14)} ${String(Buffer.byteLength(text)).padStart(6)} B / brotli ${String(br(text)).padStart(5)} B`);
}
console.log('主表          ', Buffer.byteLength(main), 'B / brotli', br(main), 'B');
console.log('搬走', taken.size, '行');

if (DRY) { console.log('\n--dry：未写文件'); process.exit(0); }

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [file, text] of Object.entries(parts)) fs.writeFileSync(path.join(OUT_DIR, file), text);
fs.writeFileSync(CSS, main);
console.log('\n已写入 public/style.css 和 public/css/*.css');
