// 给 R2 里的存量图片补 WebP / AVIF 变体。
//
// 为什么不在请求路径上转：Workers 里没有 sharp，WASM 编码器启动就要几百毫秒，
// 给一张图多付一次冷启动不划算。转码放在这台机器上跑一次，线上只负责按 URL 发。
//
// 用法：node scripts/make-variants.mjs            # 只处理还没有变体的图
//       node scripts/make-variants.mjs --force    # 全部重转
//       node scripts/make-variants.mjs --check    # 只体检，不转不传；有缺口时 exit 1
//
// 变体的 key 是原 key 加上 .webp / .avif（/img/u/x.png.webp），
// Worker 的 serveImage 认这个后缀，缺失时回退原图，所以转与不转都不会裂。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

/* 直调 wrangler 的入口，不走 npx / .cmd：
   Windows 上 spawn('.cmd') 报 EINVAL，spawn('npx') 报 ENOENT，
   两种绕法（cmd.exe /c、shell:true）都多一层引号转义，出错时只给一句
   「命令失败」看不出是哪一半。process.execPath 到处都能用。 */
const WR = [process.execPath, ['node_modules/wrangler/bin/wrangler.js']];

const BUCKET = 'blog-images';
/* 可覆盖：换了域名不用改代码；--check 也能指向一个本地探针来验证判断逻辑 */
const SITE = (process.env.VARIANTS_SITE || 'https://exia.de5.net').replace(/\/$/, '');
const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');
const tmp = checkOnly ? null : mkdtempSync(join(tmpdir(), 'variants-'));

function d1(sql) {
  const out = execFileSync(WR[0], [...WR[1], 'd1', 'execute', 'blog-db', '--remote', '--json', '--command', sql, '-y'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = out.indexOf('[');
  const e = out.lastIndexOf(']');
  if (s < 0) throw new Error(out.slice(0, 200));
  return JSON.parse(out.slice(s, e + 1)).flatMap((r) => r.results || []);
}

/* 代码块和行内代码里的 /img/ 是「地址长这样」的举例，不是真引用。
   不去掉的话，那篇讲图片链路的文章会让脚本每年去下载一个 abc123.png，
   每次都 404，每次都打印一行「跳过」—— 噪声久了就没人看这个脚本的输出。 */
function stripCode(md) {
  return String(md)
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

// 只在正文里被引用过的图才值得转：R2 里可能躺着删稿留下的孤儿
const rows = d1("SELECT id, content FROM posts WHERE content LIKE '%/img/%'");
const keys = new Map(); // key -> 引用它的文章 id
/* 原图可以是 jpg/png（历史上传的原样落盘），也可以是 webp（编辑器上传前转过的）。
   后者当时就省了一大截，只差一档 avif —— 正则漏了 .webp 的话，
   新图就永远补不上 avif，而它是唯一比 webp 再小 20-30% 的格式。 */
const REF_RE = /\/img\/([^\s)"'<>]+\.(?:png|jpe?g|webp))/gi;
const VARIANT_RE = /\.(?:png|jpe?g|webp)\.(?:webp|avif)$/i;
for (const r of rows) {
  for (const m of stripCode(r.content).matchAll(REF_RE)) {
    const k = decodeURIComponent(m[1]);
    // 正文万一直接写了变体地址，别把它当原图再转一遍
    if (VARIANT_RE.test(k)) continue;
    if (!keys.has(k)) keys.set(k, new Set());
    keys.get(k).add(r.id);
  }
}
if (!keys.size) {
  console.log('没有引用到任何 /img/ 图片');
  process.exit(0);
}

const f = (n) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

/* 这张图需要哪些变体。原图已是 webp 的只需要 avif ——
   拿同一份编码再产一个 .webp 变体没有意义，只多占一次上传。 */
function targetsFor(key) {
  const srcExt = (key.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  return srcExt === 'webp' ? ['avif'] : ['webp', 'avif'];
}

/* head() 用 HEAD 拿状态码和图大小：check 模式只想知道「在不在」，
   把整张图 GET 下来只为了看一个状态码，在 200KB 的图上很浪费。 */
async function head(url) {
  const r = await fetch(url, { method: 'HEAD' });
  return { ok: r.ok, status: r.status, len: Number(r.headers.get('content-length') || 0) };
}

if (checkOnly) {
  console.log(`体检 ${keys.size} 张被引用的图（不下载、不转码）\n`);
  let missing = 0;
  let broken = 0;
  for (const [key, posts] of keys) {
    const orig = await head(`${SITE}/img/${key}`);
    if (!orig.ok) {
      broken++;
      console.log(`  ✗ ${key}  原图 ${orig.status} —— 正文引用了但 R2 里没有（引用它的文章：${[...posts].join(',')}）`);
      continue;
    }
    const gaps = [];
    for (const ext of targetsFor(key)) {
      const v = await head(`${SITE}/img/${key}.${ext}`);
      if (!v.ok) gaps.push(ext);
    }
    if (gaps.length) {
      missing++;
      console.log(`  · ${key}  原图 ${f(orig.len)}，缺 ${gaps.join(' / ')}`);
    }
  }
  console.log('');
  if (!missing && !broken) {
    console.log('全部有变体，没有缺口。');
  } else {
    /* 两件事的修法完全不同，不能合成一句「跑 make:variants」——
       原图丢了是转码补不回来的，得回去重传或者改文章。 */
    const parts = [];
    if (missing) parts.push(`缺变体 ${missing} 张（跑 npm run make:variants 补）`);
    if (broken) parts.push(`原图丢失 ${broken} 张（转码救不了，要重传或改正文引用）`);
    console.log(parts.join('；') + '。');
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

console.log(`待处理 ${keys.size} 张\n`);
let saved = 0;
let savedAvif = 0;
let skipped = 0;
let missing = 0;
let uptodate = 0;

for (const key of keys.keys()) {
  /* 默认只补缺的。原先每次跑都把 7 张全部下载重转重传 ——
     单张 200KB 的图重转一遍要几百毫秒，跑一次全是无事发生的上传，
     时间久了就会「反正也没输出，不用跑了」。--force 才是全量重转。 */
  if (!force) {
    const want = targetsFor(key);
    const have = await Promise.all(want.map((ext) => head(`${SITE}/img/${key}.${ext}`)));
    if (have.every((v) => v.ok)) {
      uptodate++;
      continue;
    }
  }

  const local = join(tmp, key.replace(/[\\/]/g, '_'));
  try {
    // 走公网地址下载，不用 r2 object get：那条命令在 Windows 下 spawn 起来很别扭
    const res = await fetch(SITE + '/img/' + key);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    missing++;
    console.log(`跳过 ${key}（R2 里没有：${String(e.stderr || e.message).split('\n')[0].slice(0, 80)}）`);
    continue;
  }

  const before = statSync(local).size;
  const img = sharp(local, { failOn: 'none' });
  const meta = await img.metadata();
  const base = img.resize({ width: Math.min(meta.width || 1600, 1600), withoutEnlargement: true });

  /* 原图已经是 webp 的，不再产 webp 变体：内容是同一份编码，
     转出来只会更小一点点，白占一次上传和一份存储。只补 avif。 */
  const srcExt = (key.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();

  for (const [ext, opts] of [
    ['webp', { quality: 78, effort: 5 }],
    ['avif', { quality: 55, effort: 4 }],
  ]) {
    if (ext === 'webp' && srcExt === 'webp') continue;
    const out = join(tmp, `o.${ext}`);
    const buf = await base.clone().toFormat(ext, opts).toBuffer();
    // 变体反而更大就跳过 —— 有些小图/线条图转完会涨，那种情况留着原图更好
    if (buf.length >= before * 0.95) {
      console.log(`  ${ext} 没省（${f(before)} → ${f(buf.length)}），跳过`);
      skipped++;
      continue;
    }
    writeFileSync(out, buf); // 落盘再上传：put 读的是文件，不是内存里的 buffer
    execFileSync(WR[0], [...WR[1], 'r2', 'object', 'put', `${BUCKET}/${key}.${ext}`, '--file', out,
      '--content-type', ext === 'webp' ? 'image/webp' : 'image/avif', '--remote'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (ext === 'webp') saved += Math.max(0, before - buf.length);
    if (ext === 'avif') savedAvif += Math.max(0, before - buf.length);
    console.log(`  ${key}.${ext}  ${f(before)} → ${f(buf.length)}`);
    rmSync(out, { force: true });
  }
}

rmSync(tmp, { recursive: true, force: true });
if (uptodate) console.log(`\n${uptodate} 张已有变体，跳过（要重转加 --force）。`);
console.log(`\n完成。WebP 一项合计省 ${f(saved)}（AVIF 通常再小 20-30%）。`);
if (missing) console.log(`有 ${missing} 张原图在 R2 里找不到，已跳过 —— 跑 npm run make:variants -- --check 看是哪几张。`);
if (skipped) console.log(`有 ${skipped} 个变体转完没省空间，保留原图。`);
