// 定时 D1 备份到 R2：导出 → 上传 → 保留 7 份滚动。
//
// 用法：
//   node scripts/backup-upload.mjs            # 真跑（wrangler 需已登录）
//   node scripts/backup-upload.mjs --dry-run  # 只导出并打印计划，不上传/不删
//
// 为什么用 manifest 而不是 r2 object list：本机 wrangler CLI 只有 object get/put/delete，
// 没有 list 子命令；用一份 backups/_manifest.json 记最近 7 个 key，每轮读→加→删→写回，
// 不依赖 S3 凭据。manifest 本身就是滚动状态的唯一事实源。
//
// 安全：备份 SQL 含正文与用户邮箱，走 backups/ 前缀；
// src/index.js 的 isPrivateImageKey() 已挡住 /img/backups/*，不会被图片代理公开读走。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const KEEP = 7;
const PREFIX = 'backups/';
const MANIFEST = `${PREFIX}_manifest.json`;
const BUCKET = 'blog-images'; // 与 wrangler.jsonc 的 bucket_name 一致

const cfgText = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
const bucket = (cfgText.match(/"bucket_name"\s*:\s*"([^"]+)"/) || [])[1] || BUCKET;
const key = (k) => `${bucket}/${k}`;

const wrangler = (args, opts = {}) =>
  execFileSync(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: dry && opts.quiet ? 'ignore' : 'inherit', ...opts,
  });

const dir = mkdtempSync(join(tmpdir(), 'd1-backup-'));
const file = join(dir, 'd1.sql');
console.log('[1/4] 导出线上 D1…');
wrangler(['d1', 'export', 'blog-db', '--remote', `--output=${file}`], { quiet: true });
if (!existsSync(file)) throw new Error('导出文件不存在');
const bytes = readFileSync(file).length;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = `${PREFIX}d1-${stamp}.sql`;
console.log(`  ${(bytes / 1024 / 1024).toFixed(2)} MB → ${target}`);

console.log('[2/4] 读取滚动清单…');
let list = [];
try {
  const tmp = join(dir, 'manifest.json');
  wrangler(['r2', 'object', 'get', key(MANIFEST), '--file=' + tmp, '--remote'], { quiet: true });
  list = JSON.parse(readFileSync(tmp, 'utf8')).keys || [];
} catch {
  console.log('  清单不存在，按空列表起步');
}
if (!Array.isArray(list)) list = [];

console.log('[3/4] 计算滚动计划…');
list = [target, ...list.filter((k) => k !== target)].slice(0, KEEP);
const drop = list.slice(KEEP);
console.log(`  保留 ${list.length} 份：${list.join(', ')}`);
if (drop.length) console.log(`  删除 ${drop.length} 份：${drop.join(', ')}`);

if (dry) {
  console.log('\n[dry-run] 不上传、不删除。退出。');
  process.exit(0);
}

console.log('[4/4] 上传备份与清单，删除超期副本…');
wrangler(['r2', 'object', 'put', key(target), '--file=' + file, '--remote'], { quiet: true });
const mf = join(dir, 'out-manifest.json');
writeFileSync(mf, JSON.stringify({ keys: list, updated_at: new Date().toISOString(), KEEP }, null, 2) + '\n');
wrangler(['r2', 'object', 'put', key(MANIFEST), '--file=' + mf, '--remote'], { quiet: true });
for (const k of drop) {
  try { wrangler(['r2', 'object', 'delete', key(k), '--remote'], { quiet: true }); }
  catch (e) { console.error(`  删除 ${k} 失败（下次滚动会重试）：${e.message}`); }
}
console.log(`\n备份完成：${target}（共 ${list.length}/${KEEP} 份）`);
