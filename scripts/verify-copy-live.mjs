// 线上端到端：真文章页、真拖选、真 Ctrl+C、真读系统剪贴板。
// 用法：node scripts/verify-copy-live.mjs [url]
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const url = process.argv[2] || 'https://exia.de5.net/p/comment-anti-spam';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions('https://exia.de5.net', ['clipboard-read', 'clipboard-write']);

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('.post-body p');

const copyBy = async (selector, index = 0) => {
  const box = await page.evaluate(
    (sel, i) => {
      const el = document.querySelectorAll(sel)[i];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    selector,
    index
  );
  if (!box) throw new Error('找不到元素 ' + selector);
  await new Promise((r) => setTimeout(r, 250));

  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 6, box.y + Math.min(box.h - 6, 40), { steps: 12 });
  await page.mouse.up();

  const picked = await page.evaluate(() => getSelection().toString().trim().length);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 250));
  const text = await page.evaluate(() => navigator.clipboard.readText());
  return { picked, text };
};

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok && detail) console.log(`       ${detail}`);
};

// 1. 正文段落
const body = await copyBy('.post-body p', 0);
check(
  '正文段落复制后带署名',
  body.text.includes('作者: Exia Blog') &&
    body.text.includes('本文来自于: https://exia.de5.net/') &&
    body.text.includes('CC BY-NC-SA 4.0'),
  `选中 ${body.picked} 字，尾部：${JSON.stringify(body.text.slice(-140))}`
);
check('声明与正文之间有空行分隔', /\n\n作者: Exia Blog/.test(body.text), JSON.stringify(body.text.slice(-200)));
check('正文内容没有被改动', body.picked >= 60 && body.text.length > body.picked, `picked=${body.picked} len=${body.text.length}`);

// 2. 代码块
const code = await copyBy('.post-body pre code', 0);
check('代码块复制不带署名', !code.text.includes('作者:'), `尾部：${JSON.stringify(code.text.slice(-80))}`);
check('代码块内容完整（没被截断）', code.picked > 0 && code.text.trim().length >= code.picked - 2, `picked=${code.picked} len=${code.text.length}`);

console.log(`\n线上验证：${results.filter((r) => r[1]).length}/${results.length} 通过`);
if (results.some((r) => !r[1])) process.exitCode = 1;

// 把人看到的那段原样打出来，改文案时肉眼能立刻对
console.log('\n--- 复制出来的末尾 ---');
console.log(body.text.slice(-220));
console.log('--- 结束 ---');

await browser.close();
