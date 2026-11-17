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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/* 这张图需要哪些变体。两个维度：格式 × 宽度。
   宽度档位跟 public/md.js 的 WIDTH_STEPS 必须一致 —— 那边按这些数字拼 srcset，
   这边不产，浏览器就会去要一个不存在的地址，全靠 serveImage 回退到全尺寸，
   等于白写一遍 srcset。改了这里记得同步那边。
   原图比档位还窄的不产：放大没有任何信息增益，只会让文件更大。 */
const WIDTH_STEPS = [480, 800, 1200];

/* 原图已是 webp 的只需要 avif —— 拿同一份编码再产一个 .webp 变体没有意义，
   只多占一次上传。 */
function targetsFor(key, origW) {
  const srcExt = (key.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const exts = srcExt === 'webp' ? ['avif'] : ['webp', 'avif'];
  const out = [];
  for (const ext of exts) out.push({ ext, w: 0 });
  for (const w of WIDTH_STEPS) {
    if (w >= origW) continue;
    for (const ext of exts) out.push({ ext, w });
  }
  return out;
}

/* 变体 key 的形状：a.png.avif（全尺寸）/ a.png.w800.avif（缩过宽度）。
   serveImage 用同一个正则在线上解析，两处要一起改。 */
const vKey = (key, ext, w) => (w ? `${key}.w${w}.${ext}` : `${key}.${ext}`);
const vLabel = (t) => (t.w ? `${t.ext}@${t.w}` : t.ext);

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

/* 取原图并读出真实宽度。
   为什么必须把原图拉下来：目标档位取决于原图宽度（比原图宽的档不产）。
   早先的版本只用 HEAD 看状态码，那是「不知道宽度就假设全都要」——
   在小图上会一直报「缺 1200 档」，而那个档本来就不该存在。
   一张图几百 KB，被引用的图一共十来张，这点流量换掉一类误报，值。 */
async function fetchOrig(key) {
  let r;
  try {
    r = await fetch(SITE + '/img/' + key);
  } catch (e) {
    return { err: String(e.message || e).slice(0, 80) };
  }
  if (!r.ok) return { err: `HTTP ${r.status}` };
  // 原图缺失时 Worker 回的是 200 + 占位 SVG，光看状态码会把「丢了」读成「在」
  if (r.headers.has('x-img-missing')) return { err: 'R2 里没有这张原图（回的是占位图）' };
  const buf = Buffer.from(await r.arrayBuffer());
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    if (!meta.width) return { err: '读不出宽度（格式不认识）' };
    return { buf, meta, size: buf.length };
  } catch (e) {
    return { err: `sharp 解不开：${String(e.message || e).slice(0, 60)}` };
  }
}

if (checkOnly) {
  console.log(`体检 ${keys.size} 张被引用的图（不转码、不上传）\n`);
  let missing = 0;
  let broken = 0;
  for (const [key, posts] of keys) {
    const src = await fetchOrig(key);
    if (src.err) {
      broken++;
      console.log(`  ✗ ${key}  ${src.err} —— 正文引用了但 R2 里没有（引用它的文章：${[...posts].join(',')}）`);
      continue;
    }
    const want = targetsFor(key, src.meta.width);
    const have = await Promise.all(want.map((t) => head(`${SITE}/img/${vKey(key, t.ext, t.w)}`)));
    /* 不能只看 200：serveImage 在变体缺失时会回退成另一格式甚至原图，
       回退响应的 Content-Type 就不是我们想要的 —— 那正是判据。 */
    const gaps = [];
    want.forEach((t, i) => {
      if (!variantOk(have[i], t.ext)) gaps.push(`${vLabel(t)}（${whyNotVariant(have[i], t.ext)}）`);
    });
    if (gaps.length) {
      missing++;
      console.log(`  · ${key}  原图 ${src.meta.width}px / ${f(src.size)}，缺 ${gaps.join(' / ')}`);
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
let produced = 0;

/* 编码参数。effort 越高越慢但压得越小 —— 这是离线跑一次的事，
   多花几秒换每个访客少下几十 KB，划算。 */
const ENC = { webp: { quality: 78, effort: 5 }, avif: { quality: 55, effort: 4 } };
const MIME = { webp: 'image/webp', avif: 'image/avif' };
/* 全尺寸档的上限：再大的图放正文里也是缩到 716px 显示，
   1600 已经够 2× DPR 用的了。 */
const FULL_CAP = 1600;

for (const key of keys.keys()) {
  const src = await fetchOrig(key);
  if (src.err) {
    missing++;
    console.log(`跳过 ${key}（${src.err}）`);
    continue;
  }
  const origW = src.meta.width;
  const want = targetsFor(key, origW);

  /* 默认只补缺的。先问一遍哪些已经有了，缺的是空集就整张跳过 ——
     重转一遍要几百毫秒且结果一字节不差，跑一次全是无事发生的上传，
     时间久了就会「反正也没输出，不用跑了」。--force 才是全量重转。 */
  let todo = want;
  if (!force) {
    const have = await Promise.all(want.map((t) => head(`${SITE}/img/${vKey(key, t.ext, t.w)}`)));
    todo = want.filter((t, i) => !variantOk(have[i], t.ext));
    if (!todo.length) {
      uptodate++;
      continue;
    }
  }

  const img = sharp(src.buf, { failOn: 'none' });
  for (const t of todo) {
    /* 全尺寸档限制在 FULL_CAP 以内；宽度档就是它自己那个数。
       两者都带 withoutEnlargement，小图不会被拉大。 */
    const resized = img.clone().resize({ width: t.w || Math.min(origW, FULL_CAP), withoutEnlargement: true });
    const buf = await resized.toFormat(t.ext, ENC[t.ext]).toBuffer();
    /* 变体反而更大就跳过 —— 小图/线条图转完会涨，那种情况留着原图更好。
       宽度档不比原图大是常态，这条只是兜底。 */
    if (buf.length >= src.size * 0.95 && !t.w) {
      console.log(`  ${vLabel(t)} 没省（${f(src.size)} → ${f(buf.length)}），跳过`);
      skipped++;
      continue;
    }
    const out = join(tmp, `o-${t.ext}-${t.w || 0}`);
    writeFileSync(out, buf); // 落盘再上传：put 读的是文件，不是内存里的 buffer
    execFileSync(
      WR[0],
      [...WR[1], 'r2', 'object', 'put', `${BUCKET}/${vKey(key, t.ext, t.w)}`, '--file', out,
        '--content-type', MIME[t.ext], '--remote'],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    if (t.ext === 'webp') saved += Math.max(0, src.size - buf.length);
    if (t.ext === 'avif') savedAvif += Math.max(0, src.size - buf.length);
    uploaded.push(`${SITE}/img/${vKey(key, t.ext, t.w)}`);
    produced++;
    console.log(`  ${vKey(key, t.ext, t.w)}  ${t.w ? `${t.w}px ` : ''}${f(src.size)} → ${f(buf.length)}`);
    rmSync(out, { force: true });
  }
  console.log(`  ${key}  原图 ${origW}px，本轮产出 ${todo.length} 个变体`);
}

/* Windows 上 sharp 有时还握着下载文件的句柄，rmSync 会 EBUSY ——
   那是临时目录，清不掉也不影响结果，不能让它把「已经传完了」变成一次失败退出。 */
try {
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
}
await purge(uploaded);
if (uptodate) console.log(`\n${uptodate} 张已有全部变体，跳过（要重转加 --force）。`);
console.log(`\n完成。本轮上传 ${produced} 个变体，WebP 一项合计省 ${f(saved)}（AVIF 通常再小 20-30%）。`);
if (missing) console.log(`有 ${missing} 张原图在 R2 里找不到，已跳过 —— 跑 npm run make:variants -- --check 看是哪几张。`);
if (skipped) console.log(`有 ${skipped} 个变体转完没省空间，保留原图。`);
