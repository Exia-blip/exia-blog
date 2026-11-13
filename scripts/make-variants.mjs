// 给 R2 里的存量图片补 WebP / AVIF 变体。
//
// 为什么不在请求路径上转：Workers 里没有 sharp，WASM 编码器启动就要几百毫秒，
// 给一张图多付一次冷启动不划算。转码放在这台机器上跑一次，线上只负责按 URL 发。
//
// 用法：node scripts/make-variants.mjs            # 只处理还没有变体的图
//       node scripts/make-variants.mjs --force    # 全部重转
//
// 变体的 key 是原 key 加上 .webp / .avif（/img/u/x.png.webp），
// Worker 的 serveImage 认这个后缀，缺失时回退原图，所以转与不转都不会裂。
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

// Windows 上直接 spawn .cmd 会报 EINVAL，得让 cmd.exe 去拉起它
const WR =
  process.platform === 'win32'
    ? { cmd: 'cmd.exe', pre: ['/c', 'node_modules\\.bin\\wrangler.cmd'] }
    : { cmd: 'node_modules/.bin/wrangler', pre: [] };

const BUCKET = 'blog-images';
const SITE = 'https://exia.de5.net';
const force = process.argv.includes('--force');
const tmp = mkdtempSync(join(tmpdir(), 'variants-'));

function d1(sql) {
  const out = execSync(`npx wrangler d1 execute blog-db --remote --json --command="${sql.replace(/"/g, '\\"')}" -y`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = out.indexOf('[');
  const e = out.lastIndexOf(']');
  if (s < 0) throw new Error(out.slice(0, 200));
  return JSON.parse(out.slice(s, e + 1)).flatMap((r) => r.results || []);
}

// 只在正文里被引用过的图才值得转：R2 里可能躺着删稿留下的孤儿
const rows = d1("SELECT content FROM posts WHERE content LIKE '%/img/%'");
const keys = new Set();
for (const r of rows) {
  for (const m of String(r.content || '').matchAll(/\/img\/([^\s)"'<>]+\.(?:png|jpe?g))/gi)) {
    keys.add(decodeURIComponent(m[1]));
  }
}
if (!keys.size) {
  console.log('没有引用到任何 /img/ 图片');
  process.exit(0);
}
console.log(`待处理 ${keys.size} 张\n`);

const f = (n) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);
let saved = 0;

for (const key of keys) {
  const local = join(tmp, key.replace(/[\\/]/g, '_'));
  try {
    // 走公网地址下载，不用 r2 object get：那条命令在 Windows 下 spawn 起来很别扭
    const res = await fetch(SITE + '/img/' + key);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.log(`跳过 ${key}（R2 里没有：${String(e.stderr || e.message).split('\n')[0].slice(0, 80)}）`);
    continue;
  }

  const before = statSync(local).size;
  const img = sharp(local, { failOn: 'none' });
  const meta = await img.metadata();
  const base = img.resize({ width: Math.min(meta.width || 1600, 1600), withoutEnlargement: true });

  for (const [ext, opts] of [
    ['webp', { quality: 78, effort: 5 }],
    ['avif', { quality: 55, effort: 4 }],
  ]) {
    const out = join(tmp, `o.${ext}`);
    const buf = await base.clone().toFormat(ext, opts).toBuffer();
    // 变体反而更大就跳过 —— 有些小图/线条图转完会涨，那种情况留着原图更好
    if (buf.length >= before * 0.95) {
      console.log(`  ${ext} 没省（${f(before)} → ${f(buf.length)}），跳过`);
      continue;
    }
    writeFileSync(out, buf); // 落盘再上传：put 读的是文件，不是内存里的 buffer
    execFileSync(
      WR.cmd,
      [
        ...WR.pre,
        'r2',
        'object',
        'put',
        `${BUCKET}/${key}.${ext}`,
        '--file',
        out,
        '--content-type',
        ext === 'webp' ? 'image/webp' : 'image/avif',
        '--remote',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    if (ext === 'webp') saved += Math.max(0, before - buf.length);
    console.log(`  ${key}.${ext}  ${f(before)} → ${f(buf.length)}`);
    rmSync(out, { force: true });
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n完成。WebP 一项合计省 ${f(saved)}（AVIF 通常再小 20-30%）。`);
