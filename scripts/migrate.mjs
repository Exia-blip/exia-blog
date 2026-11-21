#!/usr/bin/env node
/* 站点搬迁：把「换个地方重开一份」从口头步骤变成可重复执行的命令。

   先分清两件事，别混：
   · 换域名（同一个 CF 账号）：数据根本不用搬。D1/R2 绑在账号上，跟域名无关。
     只改 wrangler.jsonc 的 SITE_ORIGIN + CF 域名绑定 + GitHub OAuth 回调地址。
   · 换账号 / 灾备重建：才需要搬 D1 + R2 + 重填 secrets，这个脚本管的就是这件事。

   用法：
     node scripts/migrate.mjs export [--dir=backups/YYYYMMDD]
     node scripts/migrate.mjs import [--dir=backups/YYYYMMDD] [--apply]
     node scripts/migrate.mjs plan

   export 产出：
     <dir>/d1.sql          D1 全库（含 35 篇正文，敏感，已在 .gitignore）
     <dir>/manifest.json   配置快照：vars 全量、secrets 只记名字不记值、R2 key 清单
     <dir>/r2-get.sh       按 key 清单从旧账号拉图（wrangler OAuth 即可，不需要 S3 密钥）
     <dir>/r2-put.sh       灌进新账号（同上）

   import 默认 dry-run，只打印将执行的命令；--apply 才真跑。
   secrets 永远不导出：值只存在于 CF，换账号必须重新 put（这是安全设计，不是偷懒）。
*/
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname || process.cwd(), '..');
const CFG = join(ROOT, 'wrangler.jsonc');
const argv = process.argv.slice(2);
const cmd = argv[0] || 'plan';
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const dir = resolve(ROOT, arg('dir', `backups/${stamp}`));
const apply = argv.includes('--apply');

/* Windows 上 .cmd 不能被 spawn（Node 22 EINVAL），npx 又多套一层 shell。
   直接跑 node_modules 里的 wrangler 入口，和 setup.mjs / check-env.mjs 同口径。 */
const wrangler = (args, opts = {}) =>
  spawnSync(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', ...opts,
  });

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

/* wrangler.jsonc 带注释，JSON.parse 会炸。这里只取需要的几个键，
   不追求完整解析 —— 解析器留漏洞比少读几个字段更危险（同 check-env.mjs 口径）。 */
const readCfg = () => {
  const s = readFileSync(CFG, 'utf8');
  const str = (name) => {
    const m = s.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
    return m ? m[1] : '';
  };
  const db = s.match(/"database_name"\s*:\s*"([^"]+)"/);
  const dbId = s.match(/"database_id"\s*:\s*"([^"]+)"/);
  const bucket = s.match(/"bucket_name"\s*:\s*"([^"]+)"/);
  return {
    name: str('name'),
    origin: str('SITE_ORIGIN'),
    siteName: str('SITE_NAME'),
    siteDesc: str('SITE_DESC'),
    siteAuthor: str('SITE_AUTHOR'),
    siteTheme: str('SITE_THEME'),
    siteMode: str('SITE_MODE'),
    githubClientId: str('GITHUB_CLIENT_ID'),
    r2PublicBase: str('R2_PUBLIC_BASE'),
    databaseName: db ? db[1] : '',
    databaseId: dbId ? dbId[1] : '',
    bucketName: bucket ? bucket[1] : '',
  };
};

const secretNames = () => {
  const r = wrangler(['secret', 'list']);
  if (r.status !== 0) return [];
  try {
    const out = r.stdout || '';
    return JSON.parse(out.slice(out.indexOf('['))).map((s) => s.name).sort();
  } catch { return []; }
};

/* R2 没有 list 命令（4.x 只有 get/put/delete），但 D1 正文里带着全部图片 URL。
   从 dump 里提 key 不完美（没被引用的孤儿图会漏），但覆盖正文用到的每一张 ——
   对「重建一份能用的站」来说够了。真要逐字节对账，去 CF Dashboard 看桶。 */
const r2Keys = (sql) => {
  const set = new Set();
  /* R2 的 key = URL 去掉 /img/ 前缀，可能带变体后缀（.jpg.w480.avif）,
     后面还可能跟 ?w= / 引号 / 逗号 / 右括号。字符集里放 '.', 所以整段一起吃掉，
     再用尾部的分隔符收口 —— 只按扩展名截断会把变体砍掉，重建后图集裂一半。 */
  const re = /\/img\/([A-Za-z0-9_][A-Za-z0-9_.\-/]*\.(?:jpe?g|png|webp|avif|gif)(?:\.[a-z0-9]+)*)/gi;
  let m;
  while ((m = re.exec(sql))) set.add(m[1]);
  return [...set].sort();
};

const dump = (out) => {
  const r = wrangler(['d1', 'export', cfg.databaseName, '--remote', `--output=${out}`]);
  if (r.status !== 0) die(`D1 导出失败：${(r.stderr || '').split('\n').filter(Boolean).pop() || r.status}`);
};

let cfg = readCfg();

if (cmd === 'plan') {
  console.log('\n=== 换域名（同一个 CF 账号，不搬数据）===\n');
  console.log(`  1. wrangler.jsonc 的 SITE_ORIGIN 改成新域名（当前 ${cfg.origin || '未配'}）`);
  console.log('  2. CF Dashboard → Workers & Pages → 自定义域名，绑定新域名');
  console.log(`  3. GitHub OAuth App 的 Callback URL 改成 新域名/auth/callback`);
  console.log('  4. 重新部署：npm run deploy（会自动跑全量测试 + 线上体检）');
  console.log('\n  运行时已不再硬编码域名：友链自检 UA / 自环判定 / 友链申请示例 / 复制声明');
  console.log('  都从 SITE_ORIGIN 或 canonical 派生。以上四步做完即生效，不用改代码。\n');
  console.log('=== 换账号 / 灾备重建（要搬数据）===\n');
  console.log('  旧账号：node scripts/migrate.mjs export');
  console.log('  新账号：建 D1 + R2（名字同旧账号可省改配置），改 wrangler.jsonc 的 database_id');
  console.log('          node scripts/migrate.mjs import --apply');
  console.log('          按 manifest.secrets 重新 wrangler secret put（值不导出，必须重填）');
  console.log('          跑 r2-put.sh 灌图，npm run make:variants 补变体，npm run deploy\n');
  process.exit(0);
}

if (cmd === 'export') {
  if (!cfg.databaseName) die('wrangler.jsonc 里读不到 database_name');
  mkdirSync(dir, { recursive: true });
  const sqlPath = join(dir, 'd1.sql');
  dump(sqlPath);
  const sql = readFileSync(sqlPath, 'utf8');
  const keys = r2Keys(sql);
  const secrets = secretNames();
  const manifest = {
    exported_at: new Date().toISOString(),
    note: 'secrets 只记名字，值不导出 —— 换账号必须重新 put。d1.sql 含正文与用户邮箱，别外传。',
    config: cfg,
    secrets,
    r2_keys: keys,
    counts: {
      tables: (sql.match(/^CREATE TABLE /gm) || []).length,
      inserts: (sql.match(/^INSERT INTO /gm) || []).length,
    },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const getSh = ['#!/bin/sh', '# 从旧账号拉图（用 wrangler OAuth，不需要 S3 密钥）', 'set -e'],
    putSh = ['#!/bin/sh', '# 灌进新账号（先切到新账号的 wrangler 登录态）', 'set -e'];
  for (const k of keys) {
    const tmp = `${k}.dl`;
    /* wrangler 拉一个不存在的 key 会留下 0 字节文件。直接 --file=$k 的话，
       下一步 put 会把空壳灌进新桶 —— 图还是裂的，只是从「缺图」变成「空文件」。
       先写临时名、确认非空再改名，404 就跳过。 */
    getSh.push(`mkdir -p "$(dirname '${k}')" "$(dirname '${tmp}')"`);
    getSh.push(`if npx wrangler r2 object get '${cfg.bucketName}/${k}' --file='${tmp}' --remote >/dev/null 2>&1 && [ -s '${tmp}' ]; then mv '${tmp}' '${k}'; else echo "skip ${k}"; rm -f '${tmp}'; fi`);
    putSh.push(`[ -s '${k}' ] && npx wrangler r2 object put '${cfg.bucketName}/${k}' --file='${k}' --remote || echo "skip ${k}"`);
  }
  writeFileSync(join(dir, 'r2-get.sh'), getSh.join('\n') + '\n');
  writeFileSync(join(dir, 'r2-put.sh'), putSh.join('\n') + '\n');
  console.log(`\n导出完成 → ${dir}`);
  console.log(`  d1.sql        ${(sql.length / 1024 / 1024).toFixed(2)} MB / ${manifest.counts.tables} 表 / ${manifest.counts.inserts} 条 INSERT`);
  console.log(`  manifest.json 配置快照（secrets ${secrets.length} 项，只记名字）`);
  console.log(`  r2-get.sh     ${keys.length} 个图片 key 的拉取命令`);
  console.log(`  r2-put.sh     对应的灌入命令\n`);
  process.exit(0);
}

if (cmd === 'import') {
  const sqlPath = join(dir, 'd1.sql');
  if (!existsSync(sqlPath)) die(`${sqlPath} 不存在，先跑 export`);
  const mfPath = join(dir, 'manifest.json');
  const mf = existsSync(mfPath) ? JSON.parse(readFileSync(mfPath, 'utf8')) : null;
  const target = cfg.databaseName;
  const databaseId = cfg.databaseId;
  if (!target) die('wrangler.jsonc 读不到 database_name');
  console.log('\n=== 导入计划 ===');
  console.log(`  目标 D1: ${target} (${databaseId || '无 id'})`);
  console.log(`  来源:    ${sqlPath}`);
  console.log(`  校验:    ${mf ? `${mf.counts.tables} 表 / ${mf.counts.inserts} 条 INSERT` : '无 manifest，按 SQL 原样灌入'}`);
  console.log(`  secrets: ${mf ? mf.secrets.join(', ') : '未知'} —— 值不导入，需手动 put`);
  console.log(`  模式:    ${apply ? '--apply 真执行' : 'dry-run（加 --apply 才执行）'}\n`);
  if (!apply) {
    console.log('  将执行：');
    console.log(`    wrangler d1 execute ${target} --remote --file=${sqlPath}`);
    console.log(`    wrangler d1 execute ${target} --remote --command "SELECT count(*) FROM posts"`);
    console.log(`    校验 posts 数应 ≈ ${mf ? '导出时' : '?'}，再跑 npm run deploy\n`);
    process.exit(0);
  }
  const r = wrangler(['d1', 'execute', target, '--remote', `--file=${sqlPath}`]);
  if (r.status !== 0) die(`导入失败：${(r.stderr || '').split('\n').filter(Boolean).pop() || r.status}`);
  const v = wrangler(['d1', 'execute', target, '--remote', '--command',
    'SELECT (SELECT count(*) FROM posts) AS posts, (SELECT count(*) FROM settings) AS settings']);
  console.log('\n导入完成，回读校验：');
  console.log((v.stdout || '').split('\n').filter((l) => /posts|settings/.test(l)).slice(0, 6).join('\n'));
  if (mf && mf.secrets.length) {
    console.log('\n还需手动（值不导出）：');
    for (const s of mf.secrets) console.log(`  npx wrangler secret put ${s}`);
  }
  console.log('\n然后：跑 r2-put.sh 灌图 → npm run make:variants → npm run deploy\n');
  process.exit(0);
}

die(`未知命令「${cmd}」。可用：export | import | plan`);
