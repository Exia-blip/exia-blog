// 线上结构化数据体检：逐篇抓 JSON-LD，校验四件事
//   1. 能被 JSON.parse（一个多余的逗号就让整块失效，而且页面看不出异常）
//   2. BlogPosting 的 headline 与页面 <h1> 一致（改标题忘了改模板时这里会炸）
//   3. isPartOf.url 必须真的能打开（404 比不写更糟）
//   4. position 与该文在系列页里的实际次序一致
// 用法：node scripts/check-ld.mjs [--origin https://exia.de5.net]
const origin = process.argv.includes('--origin')
  ? process.argv[process.argv.indexOf('--origin') + 1]
  : 'https://exia.de5.net';

const t0 = Date.now();
const sm = await (await fetch(`${origin}/sitemap.xml?cb=${Math.random()}`)).text();
const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => u.includes('/p/'));
if (!urls.length) throw new Error('sitemap 里没有文章');

const rows = [];
for (const url of urls) {
  const slug = decodeURIComponent(url.split('/p/')[1]);
  const html = await (await fetch(`${url}?cb=${Math.random()}`)).text();
  const row = { slug, ld: 'ok', headline: '-', partOf: '-', pos: '-' };

  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) {
    rows.push({ ...row, ld: '缺失' });
    continue;
  }

  let graph = null;
  try {
    graph = blocks
      .flatMap((m) => {
        const j = JSON.parse(m[1]);
        return j['@graph'] || [j];
      })
      .filter(Boolean);
  } catch (e) {
    rows.push({ ...row, ld: '解析失败：' + e.message.slice(0, 40) });
    continue;
  }

  const art = graph.find((n) => ['BlogPosting', 'Article'].includes(n['@type']));
  if (!art) {
    rows.push({ ...row, ld: '无 BlogPosting' });
    continue;
  }

  // headline 与 h1 对不上，通常是改了标题只改了一处
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ''])[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
  row.headline = h1 && art.name === h1 ? 'ok' : h1 ? `不一致（${String(art.name).slice(0, 16)}…）` : '无 h1';

  const part = art.isPartOf;
  if (part && typeof part === 'object' && part.url) {
    // 显式抓自指：url 等于本篇地址时，后面所有检查都会以 200 放行
    if (part.url === art.url) {
      row.partOf = '自指';
      rows.push(row);
      continue;
    }
    const r = await fetch(`${part.url}?cb=${Math.random()}`);
    row.partOf = r.status === 200 ? '200' : String(r.status);
    if (r.status === 200) {
      const sh = await r.text();
      row.partOf += sh.includes('CreativeWorkSeries') ? ' +Series' : ' 无Series';
      // 系列页里按次序找自己，位置必须对得上
      const order = [...sh.matchAll(/<a href="\/p\/([^"]+)">/g)].map((m) => decodeURIComponent(m[1]));
      const idx = order.indexOf(slug);
      row.pos = idx >= 0 ? `${idx + 1}/${order.length} 声明${art.position ?? '无'}` : '不在系列页';
      if (idx >= 0 && art.position !== idx + 1) row.pos += ' ←不一致';
    }
  } else if (part) {
    row.partOf = '站点级';
  }

  rows.push(row);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('slug', 30), pad('JSON-LD', 12), pad('headline', 10), pad('isPartOf', 16), 'position');
for (const r of rows) console.log(pad(r.slug, 30), pad(r.ld, 12), pad(r.headline, 10), pad(r.partOf, 16), r.pos);

const bad = rows.filter(
  (r) => r.ld !== 'ok' || r.headline !== 'ok' || !String(r.partOf).startsWith('200') && r.partOf !== '站点级' || String(r.pos).includes('不一致') || r.pos === '不在系列页'
);
console.log(`\n${rows.length} 篇，坏 ${bad.length} 篇，耗时 ${Date.now() - t0}ms`);
if (bad.length) {
  console.log('问题：', bad.map((b) => b.slug).join(', '));
  process.exitCode = 1;
}
