// D1 备份恢复演练：把线上导出的 SQL 灌进内存库，验证它真能重建出可用结构。
//
// 用法：
//   node scripts/backup-drill.mjs [--sql=<path>]
//   默认先跑 wrangler d1 export --remote 导到临时目录，再重放。
//
// 这一步是「没演练过的备份等于没有」的对策：只验导出文件存在没意义，
// 要真在空库里执行一遍，确认表、关键行数、slug 都读得出来。
// 不碰线上任何数据，只读导出。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
let sqlPath = arg('sql', '');
if (!sqlPath) {
  const dir = mkdtempSync(join(tmpdir(), 'd1-backup-drill-'));
  sqlPath = join(dir, 'd1.sql');
  console.log('[1/3] 从线上导出 D1（只读）…');
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'export', 'blog-db', '--remote', `--output=${sqlPath}`],
    { cwd: ROOT, stdio: 'inherit' }
  );
} else {
  console.log(`[1/3] 使用已有导出 ${sqlPath}`);
}
if (!existsSync(sqlPath)) throw new Error(`导出文件不存在：${sqlPath}`);

console.log('[2/3] 在内存库里重放导出 SQL…');
const sql = readFileSync(sqlPath, 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(sql);

console.log('[3/3] 校验结构 / 关键行数 / slug…');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const posts = Number(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n);
const live = Number(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE is_private=0 AND hidden=0").get().n);
const slug = db.prepare('SELECT slug FROM posts WHERE is_private=0 AND hidden=0 ORDER BY id LIMIT 1').get()?.slug;
const comments = Number(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n);

let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
check(tables.length >= 12, `表数 ${tables.length} ≥ 12（${tables.slice(0, 6).join(', ')}…）`);
check(['posts', 'comments', 'users', 'tags', 'post_tags', 'audit_log', 'post_revisions'].every((t) => tables.includes(t)), '核心表齐全');
check(posts > 0, `posts ${posts} 条`);
check(live > 0 && !!slug, `公开文章 ${live} 条，样例 slug=${slug}`);
check(comments >= 0, `comments ${comments} 条`);
// 空 content 的私密草稿（如 post-gf8iw）不算欠账 —— backfill:check 同口径
check(Number(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE content != '' AND (html_content IS NULL OR html_content='')").get().n) === 0, '所有非空正文都有 html_content（与 backfill:check 同口径）');
db.close();

console.log(`\n恢复演练：${fail ? `失败 ${fail} 项` : '通过 —— 这份导出能在空库里完整重建'}`);
if (fail) process.exit(1);
