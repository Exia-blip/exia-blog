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
import { variantOk, whyNotVariant, originOk } from './img-type.mjs';

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

/* 刚上传的变体 URL。清缓存只针对这些：
   变体缺失时 Worker 会拿原图顶上，那份回退响应虽然现在只缓存 5 分钟（见
   src/index.js 的 imgCacheControl），但**修复之前**缓存下来的回退是 immutable
   一年 —— 那些路径不会自己好，必须主动清一次。 */
const uploaded = [];

/* 按 URL 清 Cloudflare 边缘缓存。需要 CF_API_TOKEN（Cache Purge 权限）+ CF_ZONE_ID。
   没配就不清，但要吼一声：静默跳过的后果是「本地看得见变体、线上还是原图」。 */
async function purge(urls) {
  if (!urls.length) return;
  const token = process.env.CF_API_TOKEN;
  const zone = process.env.CF_ZONE_ID;
  if (!token || !zone) {
    console.log(`\n⚠ 刚上传 ${urls.length} 个变体，但没有配 CF_API_TOKEN / CF_ZONE_ID，无法自动清缓存。`);
    console.log('  如果这些 URL 之前被访问过，边缘可能还缓存着「回退的原图」（旧版本发的是 immutable 一年）。');
    console.log('  手动清：控制台 Caching → Purge by URL，或：');
    console.log(`    curl -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \\`);
    console.log('      -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" \\');
    console.log(`      -d '{"files":["${urls[0]}"]}'   # 一次最多 30 条`);
    return;
  }
  let ok = 0;
  for (let i = 0; i < urls.length; i += 30) {
    const batch = urls.slice(i, i + 30);
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: batch }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) ok += batch.length;
    else console.log(`  清缓存失败（${r.status}）：${JSON.stringify(j.errors || j).slice(0, 160)}`);
  }
  console.log(`\n已清缓存 ${ok}/${urls.length} 条。`);
}

/* 这张图需要哪些变体。原图已是 webp 的只需要 avif ——
   拿同一份编码再产一个 .webp 变体没有意义，只多占一次上传。 */
function targetsFor(key) {
  const srcExt = (key.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  return srcExt === 'webp' ? ['avif'] : ['webp', 'avif'];
}

/* head() 用 HEAD 拿状态码、类型和图大小：check 模式只想知道「在不在」，
   把整张图 GET 下来只为了看一个状态码，在 200KB 的图上很浪费。

   必须带上 Content-Type：Worker 对缺失变体会回退原图并返回 200，
   只看状态码会把「回退」当成「变体齐全」。 */
async function head(url) {
  const r = await fetch(url, { method: 'HEAD' });
  /* 图片不存在时 Worker 回的是 200 + 占位 SVG（为了不让页面裂图），
     光看状态码会把「原图丢了」读成「原图在」。占位响应带 x-img-missing，
     拿它当真正的判据；同时 content-type 也不是图片本身，双保险。 */
  const phantom = r.headers.has('x-img-missing');
  return {
    ok: originOk({ status: r.status, phantom }),
    status: r.status,
    phantom,
    len: Number(r.headers.get('content-length') || 0),
    type: r.headers.get('content-type') || '',
  };
}

if (checkOnly) {
  console.log(`体检 ${keys.size} 张被引用的图（不下载、不转码）\n`);
  let missing = 0;
  let broken = 0;
  for (const [key, posts] of keys) {
    const orig = await head(`${SITE}/img/${key}`);
    if (!orig.ok) {
      broken++;
      const why = orig.phantom ? '回的是占位图（x-img-missing），R2 里没有这张原图' : `原图 HTTP ${orig.status}`;
      console.log(`  ✗ ${key}  ${why} —— 正文引用了但 R2 里没有（引用它的文章：${[...posts].join(',')}）`);
      continue;
    }
    const gaps = [];
    for (const ext of targetsFor(key)) {
      const v = await head(`${SITE}/img/${key}.${ext}`);
      if (!variantOk(v, ext)) gaps.push(`${ext}（${whyNotVariant(v, ext)}）`);
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
    // 同样不能只看 200：回退的原图也是 200，会把「缺 avif」误判成已齐，
    // 于是一张永远拿不到 avif 的图被永久跳过。
    if (want.every((ext, i) => variantOk(have[i], ext))) {
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
    uploaded.push(`${SITE}/img/${key}.${ext}`);
    console.log(`  ${key}.${ext}  ${f(before)} → ${f(buf.length)}`);
    rmSync(out, { force: true });
  }
}

/* Windows 上 sharp 有时还握着下载文件的句柄，rmSync 会 EBUSY ——
   那是临时目录，清不掉也不影响结果，不能让它把「已经传完了」变成一次失败退出。 */
try {
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
}
await purge(uploaded);
if (uptodate) console.log(`\n${uptodate} 张已有变体，跳过（要重转加 --force）。`);
console.log(`\n完成。WebP 一项合计省 ${f(saved)}（AVIF 通常再小 20-30%）。`);
if (missing) console.log(`有 ${missing} 张原图在 R2 里找不到，已跳过 —— 跑 npm run make:variants -- --check 看是哪几张。`);
if (skipped) console.log(`有 ${skipped} 个变体转完没省空间，保留原图。`);
