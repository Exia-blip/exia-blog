#!/usr/bin/env node
/**
 * 图片 alt 体检。
 *
 * 为什么值得单独查：alt 是图片唯一能被机器读懂的文字。
 *   - 空 alt   → 读屏软件只会念「图形」，搜图引擎也拿不到任何信息
 *   - 文件名当 alt → 「微信图片_20241221225808.jpg」对人和机器都是噪声，
 *     这是大多数编辑器/上传器自动填的默认值，往往就这么留下来了
 *
 *   node scripts/check-alt.mjs             # 线上库
 *   node scripts/check-alt.mjs --local     # 本地库
 *   node scripts/check-alt.mjs --fix-name  # 把「文件名型 alt」改成去掉扩展名的形式
 *
 * 只报告，不改文章（--fix-name 除外，且只做最保守的替换）。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const local = process.argv.includes('--local');
const fixName = process.argv.includes('--fix-name');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* 代码块里写的 ![说明](/img/x.png) 是举例，不是真引用 —— 那篇讲图片管线的文章
   里就有好几处，不清掉会被当成「一堆空 alt 的图片」报出来。 */
function stripCode(md) {
  return String(md)
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/* 文件名型 alt：带扩展名、带下划线连字符的数字串、纯数字、纯时间戳。
   只认高置信度的，宁漏不误 —— 把「2024 年终总结」误判成文件名比漏报更烦人。 */
function looksLikeFilename(alt) {
  const a = alt.trim();
  if (!a) return false;
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(a)) return true;
  if (/^(img|image|dsc|screenshot|微信图片|截屏|屏幕截图)[\s_-]*[\w-]*$/i.test(a)) return true;
  if (/^\d{6,}$/.test(a)) return true;
  if (/^[\w-]{16,}$/.test(a) && !/\s/.test(a)) return true;
  return false;
}

const out = execFileSync(
  process.execPath,
  [
    WRANGLER,
    'd1',
    'execute',
    'blog-db',
    ...(local ? ['--local'] : ['--remote']),
    '--json',
    '--command',
    "SELECT slug, title, content FROM posts WHERE content LIKE '%![](%' OR content LIKE '%](/img/%'",
  ],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
);
const rows = JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results || []);

const IMG = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

let total = 0;
const empty = [];
const badName = [];
const long = [];
const fixes = [];

for (const r of rows) {
  const body = stripCode(r.content);
  for (const m of body.matchAll(IMG)) {
    const alt = m[1];
    const url = m[2];
    total++;
    if (!alt.trim()) empty.push({ slug: r.slug, url });
    else if (looksLikeFilename(alt)) {
      badName.push({ slug: r.slug, url, alt });
      if (fixName) fixes.push({ slug: r.slug, from: m[0], to: `![${alt.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()}](${url})` });
    } else if (alt.length > 80) long.push({ slug: r.slug, url, alt });
  }
}

console.log(`扫描 ${rows.length} 篇有图的文章，共 ${total} 张图片\n`);

const dump = (list, label, fmt) => {
  if (!list.length) return;
  console.log(`${label}（${list.length}）`);
  for (const it of list.slice(0, 30)) console.log(`  · ${it.slug}  ${fmt(it)}`);
  if (list.length > 30) console.log(`  … 还有 ${list.length - 30} 张`);
  console.log('');
};

dump(empty, 'alt 为空', (x) => x.url);
dump(badName, 'alt 是文件名（对读屏和搜索都没有信息量）', (x) => `${x.alt}  ← ${x.url}`);
dump(long, 'alt 过长（建议 60 字以内，它替代的是图而不是正文）', (x) => `${x.alt.slice(0, 40)}…  ${x.url}`);

const good = total - empty.length - badName.length - long.length;
console.log(`alt 合格 ${good} / ${total}`);

if (fixName && fixes.length) {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'alt-'));
  const sqlFile = join(dir, 'fix.sql');
  const lines = [];
  for (const r of rows) {
    const body = stripCode(r.content);
    let content = String(r.content);
    for (const f of fixes) {
      if (!body.includes(f.from)) continue;
      content = content.replace(f.from, f.to);
    }
    if (content !== r.content) lines.push(`UPDATE posts SET content = ${q(content)} WHERE slug = ${q(r.slug)};`);
  }
  writeFileSync(sqlFile, lines.join('\n') + '\n', 'utf8');
  execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'blog-db', ...(local ? ['--local'] : ['--remote']), `--file=${sqlFile}`],
    { cwd: ROOT, stdio: 'inherit' }
  );
  console.log(`\n已把 ${fixes.length} 处文件名型 alt 改成去扩展名的可读形式。`);
} else if (fixName) {
  console.log('\n没有需要自动改的。');
} else if (empty.length || badName.length) {
  console.log('\n提示：alt 是给人听的图注。--fix-name 只能把文件名变干净，真正的描述还得你自己写。');
}

/* 空 alt / 文件名 alt 是硬失败：这个脚本以前只打印数字，
   于是 9 张图全空的时候照样退出 0，没有任何自动化会报警 —— 退化无人知晓。
   过长只是建议，不拦。 */
if (empty.length || badName.length) process.exitCode = 1;
