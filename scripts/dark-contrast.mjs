// 暗色模式的卡片几乎和背景同色（#141518 vs #1b1d21，对比 1.09:1），
// 全靠一条 1.31:1 的边框分隔。把 card 提亮一档、line 跟着提，恢复层次。
// 六个主题各有一份暗色变量，改一份不改另一份就会有一半主题看着还是平的。
import fs from 'node:fs';

const p = 'public/style.css';
let css = fs.readFileSync(p, 'utf8');

// 每对：[定位用的 --bg 值, 旧 card, 新 card, 旧 line, 新 line]
const pairs = [
  ['#141518', '#1b1d21', '#212429', '#2a2c31', '#343841'], // 纸韵（含 prefers-color-scheme 兜底）
  ['#0e0e10', '#17171a', '#1d1d21', '#26262a', '#303036'], // 水墨
  ['#0e1411', '#151d17', '#1b261e', '#222c26', '#2c3a31'], // 苔原
  ['#0a1017', '#111a24', '#16222e', '#1c2735', '#263444'], // 静海
  ['#130f16', '#1b1520', '#221a29', '#29212f', '#342a3b'], // 暮紫
  ['#0b0b0c', '#131316', '#1a1a1e', '#232327', '#2e2e33'], // 终端
];

let n = 0;
for (const [bg, oldCard, newCard, oldLine, newLine] of pairs) {
  const re = new RegExp(`(--bg:\\s*${bg};\\s*\\n\\s*--bg-soft:[^\\n]*\\n\\s*--card:\\s*)${oldCard};`, 'g');
  const before = css;
  css = css.replace(re, `$1${newCard};`);
  if (css !== before) n++;
  // line 只在同色系里换，避免误伤别的主题（各主题 line 值互不相同）
  const reLine = new RegExp(`(--line:\\s*)${oldLine};`, 'g');
  css = css.replace(reLine, `$1${newLine};`);
}

fs.writeFileSync(p, css);
console.log('blocks patched:', n);
