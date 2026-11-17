#!/usr/bin/env node
/* 一次性数据修复：给正文里的 9 张图写真实 alt。
 *
 * 为什么不能靠 md.js 的兜底规则：那批图的 markdown 源里 alt 是编辑器上传时
 * 填的原文件名（微信图片_20241221225808.jpg），URL 又是随机 R2 key ——
 * 两边都没有「图里到底是什么」的信息。清洗规则只能把噪音变干净，
 * 变不出描述。所以这一步是人工看图写的，脚本只负责把它写回 D1。
 *
 * 刻意不改 hidden / is_private：那两篇是写真测试稿，公不公开是内容决策，
 * 只有老板能定。本脚本只碰 alt 与由正文派生的 html_content / cover_body。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { renderBody } from '../public/md.js';
import { sanitizeHtml } from '../src/clean.js';
import { bodyCoverFor } from '../src/cover.js';

const require = createRequire(import.meta.url);
const WRANGLER = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const DB = 'blog-db';

const wrangler = (args) =>
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function d1Json(args) {
  const out = wrangler(args);
  const i = out.search(/\[\s*\{\s*"results"/);
  if (i < 0) throw new Error('取不到 JSON：' + out.slice(0, 300));
  return JSON.parse(out.slice(i));
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* key 是 URL 最后一段路径，不含查询串和扩展名档位后缀。 */
const ALT = {
  mvv7xrrwzzr5x3: '手持团扇、身穿浅色印花旗袍的女子半身像，背景是中式庭院白墙',
  mvv7xsq81m8frk: '站在红色山水挂画前的浅色印花旗袍女子侧身照',
  mvv7xtaj4woit6: '坐在深色石台上、身后是红色挂画的旗袍女子全身照',
  mvv7xtuyiaoqok: '坐在石台边手持团扇的旗袍女子全身照',
  mvv7xufzwsj2qa: '坐在中式庭院石台上、单手撑着石面的旗袍女子',
  mvv7xuyhn65sxv: '站在红墙山水挂画前的浅色旗袍女子全身照',
  mvv7xvhs8sv8ta: '站在庭院盆栽石景旁的浅色印花旗袍女子',
  mwgkajz6eksoim: '咖啡馆里穿白色露肩上衣、手持饮品的女子',
  mwgkangsudeuvp: '身穿黑色西装外套靠墙站立的女子',
};

const slugs = ['post-brfy5', 'post-tf3wn'];
const rows = d1Json([
  '--remote', '--json', '--command',
  `SELECT id, slug, content, hidden FROM posts WHERE slug IN (${slugs.map(q).join(',')})`,
])[0].results;

if (rows.length !== slugs.length) {
  throw new Error(`只找到 ${rows.length}/${slugs.length} 篇，中止`);
}

const updates = [];
const seen = new Set();
for (const r of rows) {
  let md = String(r.content || '');
  let changed = 0;
  /* 只替换 /img/ 图：按 URL 里的 key 精确匹配，避免误伤正文里同名文本 */
  md = md.replace(/(!\[)[^\]]*(\]\(\/img\/[^)]*?)([a-z0-9]+)(\.(?:png|jpe?g|webp)(?:\?[^)]*)?\))/gi,
    (full, a, b, key, tail) => {
      const alt = ALT[key.toLowerCase()];
      if (!alt) {
        console.log(`  ! ${r.slug} 有一张图没写 alt：${key}（保留原样）`);
        return full;
      }
      changed++;
      seen.add(key.toLowerCase());
      return a + alt + b + key + tail;
    });

  if (!changed) throw new Error(`${r.slug} 一张图都没匹配到，中止（正则或 key 变了）`);

  const html = sanitizeHtml(renderBody(md));
  const cover = bodyCoverFor(md);
  updates.push(
    `UPDATE posts SET content = ${q(md)}, html_content = ${q(html)}, ` +
    `cover_body = ${q(cover)} WHERE id = ${Number(r.id)};`
  );
  console.log(`${r.slug}: 改了 ${changed} 张图 alt`);
}

/* 9 张全都要有描述。少一张说明我看漏了图，宁可中止也别留一个空 alt 混过去。 */
const missing = Object.keys(ALT).filter((k) => !seen.has(k));
if (missing.length) throw new Error(`还有 ${missing.length} 张图没写 alt：${missing.join(', ')}`);
console.log(`9 张图全部覆盖\n`);

/* 写进临时 SQL 再交给 wrangler：命令行直接塞整篇 HTML 会被 Windows 拆参数 */
import { writeFileSync, unlinkSync } from 'node:fs';
const file = '.tmp-fix-alt.sql';
writeFileSync(file, updates.join('\n') + '\n');
try {
  wrangler(['--remote', '--file=' + file]);
} finally {
  unlinkSync(file);
}
console.log('已写入 D1');
