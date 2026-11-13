// 拆分到底值不值：用「同一张表砍掉本页用不到的区块」在浏览器里兑现，
// 请求数不变、只有字节数变，比对比分才干净。
//
// 结论（2026-11-14）：不拆。
//   完整表 76.3KB，砍掉 24~26% 字节后，FCP 中位数变化在噪声内
//   （首页 308→292、文章页 360→364，min 值互有胜负）。
//   第一版测出 64ms 差距是测法错了：拦截返回的是未压缩正文，76KB 与 57KB
//   差 18KB，相当于多传 18KB 明文；按 gzip 同口径立刻打平。
//   线上是 23.4KB brotli + 一次 RTT + ?v= 一年强缓存，拆文件只会多一次条件请求。
import fs from 'node:fs';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const css = fs.readFileSync('public/style.css', 'utf8');

// 按大区切段：这些区块只有特定页面用得上
const DROP_FOR = {
  '/': ['编辑器', '归档 / 时间线', '打印 / 存 PDF', '阅读体验：侧边目录'],
  '/p/comment-anti-spam': ['编辑器', '归档 / 时间线', '列表骨架屏', '打印 / 存 PDF'],
};

function trim(dropNames) {
  const lines = css.split('\n');
  const marks = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\/\*\s*[=]+\s*(.+?)\s*[=]+/);
    if (m) marks.push({ line: i, name: m[1].trim() });
  });
  const keep = [];
  let cursor = 0;
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const drop = dropNames.some((d) => m.name.includes(d));
    if (!drop) keep.push(lines.slice(cursor, end).join('\n'));
    cursor = end;
  });
  if (cursor < lines.length) keep.push(lines.slice(cursor).join('\n'));
  return keep.join('\n');
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu'],
});

async function measure(path, body, samples = 5) {
  const out = [];
  for (let i = 0; i < samples; i++) {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    if (body) {
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        if (r.url().includes('/style.css')) {
          // 线上是 brotli，这里用 gzip 近似：比较必须在同一压缩口径下才有意义
          r.respond({
            status: 200,
            contentType: 'text/css; charset=utf-8',
            headers: { 'content-encoding': 'gzip', 'cache-control': 'no-store' },
            body: zlib.gzipSync(Buffer.from(body), { level: 9 }),
          });
        } else r.continue();
      });
    }
    await page.goto('https://exia.de5.net' + path + '?cb=' + Math.random(), { waitUntil: 'networkidle0' });
    const fcp = await page.evaluate(() => {
      const e = performance.getEntriesByName('first-contentful-paint')[0];
      return e ? Math.round(e.startTime) : null;
    });
    out.push(fcp);
    await page.close();
  }
  out.sort((a, b) => a - b);
  return { med: out[Math.floor(samples / 2)], all: out };
}

for (const [path, drop] of Object.entries(DROP_FOR)) {
  const trimmed = trim(drop);
  const a = await measure(path, css);
  const b = await measure(path, trimmed);
  const cut = (((css.length - trimmed.length) / css.length) * 100).toFixed(0);
  const gz = (t) => zlib.gzipSync(Buffer.from(t), { level: 9 }).length;
  console.log(
    `${path}\n  完整表 FCP 中位 ${a.med}ms [${a.all.join(',')}]\n` +
      `  砍掉 ${drop.join('/')}（-${cut}% 字节）FCP 中位 ${b.med}ms [${b.all.join(',')}]`
  );
}

await browser.close();
