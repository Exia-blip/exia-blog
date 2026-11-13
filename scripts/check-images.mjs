// 图片格式协商的端到端检查：浏览器到底下了哪一档。
// 只看 HTML 里的 <picture> 不算数 —— 变体没转出来时 source 还在，浏览器请求过去
// 被回退成原图，页面照样正常，这就是「代码就绪但没验证过」的状态。
// 这个脚本读 img.currentSrc（浏览器挑中的那个 URL）和实际传输字节数，才有结论。
//
// 用法：node scripts/check-images.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://127.0.0.1:8788/p/blog-markdown-xss';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });

const sizes = new Map(); // url -> { status, type, bytes }
page.on('response', async (res) => {
  const u = res.url();
  if (!/\/img\//.test(u)) return;
  const h = res.headers();
  sizes.set(u, {
    status: res.status(),
    type: h['content-type'] || '',
    bytes: Number(h['content-length'] || 0),
  });
});

await page.goto(url + (url.includes('?') ? '&' : '?') + '__t=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });

// 懒加载：先把每张图滚到视口里，否则下面读到的是空集合
await page.evaluate(async () => {
  const imgs = [...document.querySelectorAll('.md picture, .md img')];
  for (const el of imgs) {
    el.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 260));
  }
});
await new Promise((r) => setTimeout(r, 800));

const pics = await page.$$eval('.md picture', (ps) =>
  ps.map((p) => ({
    sources: [...p.querySelectorAll('source')].map((s) => ({ type: s.type, srcset: s.getAttribute('srcset') })),
    img: p.querySelector('img')?.getAttribute('src') || '',
    current: p.querySelector('img')?.currentSrc || '',
    natural: (() => {
      const i = p.querySelector('img');
      return i && i.naturalWidth ? `${i.naturalWidth}×${i.naturalHeight}` : '未加载';
    })(),
  }))
);

const bare = await page.$$eval('.md img', (is) => is.filter((i) => !i.closest('picture')).length);

await browser.close();

console.log(`URL   ${url}`);
console.log(`图片  <picture> ${pics.length} 个，未包裹的 <img> ${bare} 个\n`);

if (!pics.length) {
  console.log('页面里没有站内图（或都没有走到 <picture> 分支），没什么可验的。');
  process.exit(0);
}

let avif = 0;
let webp = 0;
let fallback = 0;

for (const [i, p] of pics.entries()) {
  const types = p.sources.map((s) => s.type.replace('image/', '')).join(' / ');
  const asked = /\.avif$/i.test(p.current) ? 'avif' : /\.webp$/i.test(p.current) ? 'webp' : '原图';
  const info = sizes.get(p.current) || {};
  const ct = String(info.type || '').toLowerCase();
  /* 关键：不能拿 URL 后缀当结论。变体没转出来时 serveImage 会回退原图，
     地址还是 .avif，但 Content-Type 和字节都是 JPEG —— 只认后缀就会
     把「回退」误报成「avif 生效」，这个页面从此没人再查。 */
  const served = ct === 'image/avif' ? 'avif' : ct === 'image/webp' ? 'webp' : ct.startsWith('image/') ? '原图' : '未知';
  if (served === 'avif') avif++;
  else if (served === 'webp') webp++;
  else fallback++;

  const kb = info.bytes ? (info.bytes / 1024).toFixed(0) + ' KB' : '未记录';
  console.log(`  [${i + 1}] 候选 ${types}  →  请求 ${asked}，实收 ${served}`);
  console.log(`      currentSrc ${p.current}`);
  console.log(`      传输 ${kb}  Content-Type ${info.type || '?'}  显示尺寸 ${p.natural}`);
  if (asked !== served && served !== '未知') {
    const why =
      served === '原图'
        ? '变体一个都没有，serveImage 只能给原图'
        : `${asked} 变体没转出来，serveImage 降级给了 ${served}`;
    console.log(`      注：地址是 .${asked}，服务端给的是 ${ct} —— ${why}（页面不会裂）`);
  }
}

console.log(`\n汇总  实收 avif ${avif} / webp ${webp} / 原图 ${fallback}`);
