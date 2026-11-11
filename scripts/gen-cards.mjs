// 为没有封面的文章生成标题卡（分享图）。
// 用法：node scripts/gen-cards.mjs            # 只出图，打印待执行的 SQL
//       node scripts/gen-cards.mjs --apply    # 出图并直接把 cover 写回 D1
//
// 图片由 scripts/gen-title-cards.py 渲染（Pillow，中文字体可靠），
// 这里只负责：从 D1 取文章 → 交给 Python → 生成 UPDATE 语句。
import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const apply = process.argv.includes('--apply');

const sql =
  "SELECT slug, title, category, COALESCE(NULLIF(published_at,''), created_at) AS date, cover FROM posts " +
  'WHERE hidden = 0 AND is_private = 0 ORDER BY id';

function d1(command) {
  // Windows 上 npx 是 .cmd，execFileSync 直接拉不起；走 shell 并把 SQL 的引号转成双引号
  const escaped = command.replace(/"/g, '\\"');
  const out = execSync(`npx wrangler d1 execute blog-db --remote --json --command="${escaped}" -y`, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0) throw new Error(`wrangler 输出里没有 JSON：${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start, end + 1));
}

const res = d1(sql);
const rows = res.flatMap((r) => r.results || []);
if (!rows.length) {
  console.log('没有文章');
  process.exit(0);
}

const posts = rows.map((r) => ({
  slug: r.slug,
  title: r.title,
  category: r.category || '',
  date: String(r.date || '').slice(0, 10),
}));

const input = join(here, '.cards-input.json');
writeFileSync(input, JSON.stringify(posts, null, 2), 'utf8');
console.log(`渲染 ${posts.length} 张标题卡…`);
execFileSync('python', [join(here, 'gen-title-cards.py'), input], { cwd: root, stdio: 'inherit' });

// 只给「还没有手填封面」的文章挂卡：作者自己指定的封面永远优先
const need = rows.filter((r) => !String(r.cover || '').trim());
const lines = [
  '-- 标题卡：没有手填封面的文章，用生成的分享图当封面',
  '-- 由 scripts/gen-cards.mjs 生成',
  ...need.map(
    (r) => `UPDATE posts SET cover = '/cards/${r.slug}.png' WHERE slug = '${r.slug}' AND (cover IS NULL OR cover = '');`
  ),
];
const sqlFile = join(here, 'seed-cards.sql');
writeFileSync(sqlFile, lines.join('\n') + '\n', 'utf8');

const missing = need.filter((r) => !existsSync(join(root, 'public', 'cards', `${r.slug}.png`)));
if (missing.length) {
  console.error(`⚠ 这些文章没有对应的 PNG：${missing.map((m) => m.slug).join(', ')}`);
}
const kb = need.reduce((n, r) => n + (existsSync(join(root, 'public', 'cards', `${r.slug}.png`))
  ? statSync(join(root, 'public', 'cards', `${r.slug}.png`)).size
  : 0), 0) / 1024;
console.log(`\n待挂卡 ${need.length} 篇，PNG 合计 ${kb.toFixed(1)} KB`);
console.log(`SQL 已写入 scripts/seed-cards.sql`);

if (apply) {
  console.log('\n写回 D1…');
  execSync('npx wrangler d1 execute blog-db --remote --file=./scripts/seed-cards.sql -y', {
    cwd: root,
    stdio: 'inherit',
  });
}
