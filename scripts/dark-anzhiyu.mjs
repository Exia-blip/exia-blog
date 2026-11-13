// 主站用的是 anzhiyu 主题，它的暗色卡片比纸韵还平（#18171d / #1f1e26，1.07:1）。
// 只改主题基座等于没改到线上那一套。
import fs from 'node:fs';

const p = 'public/style.css';
let css = fs.readFileSync(p, 'utf8');

const before = css;
css = css.replace(/(\[data-theme="anzhiyu"\]\[data-mode="dark"\]\s*\{[\s\S]*?--card:\s*)#1f1e26;/, '$1#262530;');
css = css.replace(/(\[data-theme="anzhiyu"\]\[data-mode="dark"\]\s*\{[\s\S]{0,900}?--line:\s*)#2c2b35;/, '$1#34333f;');

if (css === before) {
  console.log('没有命中，检查选择器');
  process.exit(1);
}
fs.writeFileSync(p, css);
const blk = css.match(/\[data-theme="anzhiyu"\]\[data-mode="dark"\]\s*\{[\s\S]*?\}/)[0];
console.log(blk.split('\n').filter((l) => /--(bg|card|line):/.test(l)).join('\n'));
