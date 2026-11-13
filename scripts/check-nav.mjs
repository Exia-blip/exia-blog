// 顶栏 6 项之后会不会挤成两行：量每个链接的 offsetTop，
// 只要有一项换行就会掉到下一行，offsetTop 和第一项不同。
// 用法：node scripts/check-nav.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://127.0.0.1:8799/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const widths = [660, 700, 760, 820, 900, 1024, 1280, 1440];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
let bad = 0;

for (const w of widths) {
  await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const r = await page.evaluate(() => {
    const nav = document.querySelector('nav.top');
    const header = document.querySelector('header.site');
    const links = [...nav.querySelectorAll('a')].filter((a) => !a.closest('#nav-user'));
    const tops = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)));
    const drawer = getComputedStyle(nav).position === 'fixed';
    return {
      headerH: Math.round(header.getBoundingClientRect().height),
      rows: tops.size,
      count: links.length,
      drawer,
      overX: document.documentElement.scrollWidth > window.innerWidth,
      navRight: Math.round(nav.getBoundingClientRect().right),
      vw: window.innerWidth,
    };
  });
  // 抽屉模式下链接是纵向排列，"多行"是正常的，只看有没有横向溢出
  const wrap = !r.drawer && r.rows > 1;
  if (wrap || r.overX) bad++;
  console.log(
    `  ${String(w).padStart(4)}px  头高 ${String(r.headerH).padStart(3)}  链接 ${r.count}  行数 ${r.rows}` +
      `  抽屉 ${r.drawer ? '是' : '否'}  横向溢出 ${r.overX ? '有' : '无'}` +
      `${wrap ? '  ← 换行' : ''}`
  );
}

await browser.close();
if (bad) {
  console.log(`\n${bad} 个宽度有问题`);
  process.exitCode = 1;
} else {
  console.log('\n所有宽度单行排列，无横向溢出');
}
