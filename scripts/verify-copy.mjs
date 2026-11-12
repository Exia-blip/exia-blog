// 复制署名的行为回归：真起一个页面、真选中、真触发 copy 事件，看剪贴板里到底写了什么。
// 用法：node scripts/verify-copy.mjs
// 不连 D1、不走 Worker —— 这段逻辑只依赖 DOM 结构和 copy 事件，隔离起来测最干净。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const LONG = '正文第一段，长度足够触发署名声明。这里写了很多字，目的是让选区的字符数跨过门槛。'.repeat(3);

// 复刻线上头部：canonical 决定声明里的站点地址，__SITE__.name 决定作者名
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="canonical" href="https://exia.de5.net/p/demo">
<script>window.__SITE__={name:'Exia Blog'}</script>
</head><body>
<nav id="nav">导航文字，不该被贴署名，长度也故意写够六十个字符以免被长度门槛挡掉而误判通过。</nav>
<article class="post-article"><div class="post-body md">
  <p id="p1">${LONG}</p>
  <p id="p2">短句。</p>
  <pre id="code"><code>const a = 1;\nconsole.log(a);</code></pre>
</div></article>
<script type="module">
  import { bindCopyNotice } from '/copy-notice.js';
  bindCopyNotice();
  window.__ready = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/copy-notice.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(new URL('../public/copy-notice.js', import.meta.url)));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const origin = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(origin, ['clipboard-read', 'clipboard-write']);

const page = await browser.newPage();
await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === true');

/* 合成一次 copy：拿得到 defaultPrevented，也拿得到我们 setData 塞进去的原文，
   比读系统剪贴板更能定位"到底是谁写的"。 */
const fire = (sel) =>
  page.evaluate((sel) => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector(sel));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    const dt = new DataTransfer();
    const e = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return {
      prevented: e.defaultPrevented,
      plain: dt.getData('text/plain'),
      html: dt.getData('text/html'),
    };
  }, sel);

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('长正文：附加三行声明，并拦掉浏览器默认写入', async () => {
  const r = await fire('#p1');
  if (!r.prevented) throw new Error('没有 preventDefault，默认行为会把原文再写一遍');
  if (!r.plain.includes('作者: Exia Blog')) throw new Error('缺作者行：' + r.plain.slice(-120));
  if (!r.plain.includes('本文来自于: https://exia.de5.net/')) throw new Error('缺来源行');
  if (!r.plain.includes('CC BY-NC-SA 4.0')) throw new Error('缺协议行');
  if (!r.plain.startsWith('正文第一段')) throw new Error('正文被改动：' + r.plain.slice(0, 40));
});

t('声明单独成段，与正文之间恰好两个换行', async () => {
  const r = await fire('#p1');
  const tail = r.plain.slice(r.plain.indexOf('正文第一段'));
  if (!/\n\n作者: Exia Blog/.test(tail)) throw new Error('分隔不对：' + JSON.stringify(r.plain.slice(-200)));
});

t('富文本版一起写进 text/html，粘进 Word 有分隔线', async () => {
  const r = await fire('#p1');
  if (!r.html.includes('border-top')) throw new Error('html 里没有声明块：' + r.html.slice(-150));
  if (!r.html.includes('本文来自于')) throw new Error('html 声明缺来源行');
});

t('代码块选区：不附加，也不拦默认行为', async () => {
  const r = await fire('#code');
  if (r.prevented) throw new Error('代码块被接管了，粘代码会带中文尾巴');
  if (r.plain.includes('作者')) throw new Error('代码块里出现了署名');
});

t('短选区：不附加', async () => {
  const r = await fire('#p2');
  if (r.prevented) throw new Error('复制两个字也被接管了');
  if (r.plain.includes('作者')) throw new Error('短选区出现了署名');
});

t('正文之外（导航）：不附加', async () => {
  const r = await fire('#nav');
  if (r.prevented) throw new Error('导航选区被接管了');
  if (r.plain.includes('作者')) throw new Error('导航里出现了署名');
});

t('真实 Ctrl+C 走完端到端，系统剪贴板里有署名', async () => {
  // 只用拖选圈住第一段。别接 Ctrl+A —— 那是整页全选，起点是 body，
  // 落在 .post-body 之外，按规则本来就该不加署名（那是正确行为，不是漏测）
  const box = await page.$eval('#p1', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + 4, y: r.y + 4, w: r.width - 8, h: r.height - 8 };
  });
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 4, box.y + box.h - 4, { steps: 12 });
  await page.mouse.up();

  const picked = await page.evaluate(() => getSelection().toString().trim().length);
  if (picked < 60) throw new Error(`拖选没选中足够文字（${picked}），端到端没测到`);

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 200));
  const text = await page.evaluate(() => navigator.clipboard.readText());
  if (!text.includes('Exia Blog')) throw new Error('系统剪贴板里没有署名：' + text.slice(-160));
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nverify-copy: ${pass}/${cases.length} 通过`);

await browser.close();
server.close();
