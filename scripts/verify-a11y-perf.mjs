// P3/P4 验收：评论是否还重复请求、可访问性标记是否到位、阻塞 CSS 到底用了多少。
// 全部走真实浏览器 + 真实线上页面，不 mock。
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const ORIGIN = 'https://exia.de5.net';
const POST = '/p/comment-anti-spam';
let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ok  ' + m); };
const bad = (m) => { fail++; console.log('  FAIL ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
});

/* ---------- 一、评论是否重复请求 ---------- */
console.log('\n[1] 文章页网络请求');
{
  const page = await browser.newPage();
  const hits = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/')) hits.push(u.replace(ORIGIN, ''));
  });
  await page.goto(ORIGIN + POST + '?cb=' + Math.random(), { waitUntil: 'networkidle0' });
  const cmtApi = hits.filter((u) => u.startsWith('/api/comments'));
  check(cmtApi.length === 0, `首屏没有 /api/comments 请求（实际 ${cmtApi.length} 次）`);

  const ssrRoots = await page.$$eval('#cmt-list > .cmt', (els) => els.length);
  const ssrReply = await page.$$eval('#cmt-list [data-reply]', (els) => els.length);
  const placeholder = await page.$eval('#cmt-list', (el) => el.textContent.includes('还没有评论'));

  if (ssrRoots > 0) {
    check(ssrReply === ssrRoots, `SSR 直出 ${ssrRoots} 条根评论，每条都带回复按钮（${ssrReply}/${ssrRoots}）`);
    // 回复按钮得真的能点出「取消」，且取消是 button 不是伪链接
    await page.click('#cmt-list [data-reply]');
    const hint = await page.$eval('#reply-hint', (el) => ({
      visible: el.style.display !== 'none',
      cancelTag: (el.querySelector('#cancel-reply') || {}).tagName || '',
      cancelHref: (el.querySelector('#cancel-reply') || {}).getAttribute?.('href') || '',
    }));
    check(hint.visible, '点回复后出现回复提示');
    check(hint.cancelTag === 'BUTTON' && !hint.cancelHref, `「取消」是 <button> 且无 href（${hint.cancelTag}）`);
  } else {
    // 线上此刻没有评论，按钮链路交给 npm run test 里的 test-comment-ssr 覆盖
    check(placeholder, '线上无评论时 SSR 输出「还没有评论」占位，而不是空白区块');
    console.log('  --  无评论，跳过回复按钮的点击验证（由 test-comment-ssr 单测覆盖）');
  }

  const jsHrefs = await page.$$eval('a[href^="javascript:"]', (els) => els.length);
  check(jsHrefs === 0, `页面无 javascript: 伪链接（${jsHrefs} 处）`);
  await page.close();
}

/* ---------- 二、可访问性 ---------- */
console.log('\n[2] 可访问性');
{
  const page = await browser.newPage();
  await page.goto(ORIGIN + POST + '?cb=' + Math.random(), { waitUntil: 'networkidle0' });

  // 键盘第一个落点必须是跳转链接
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const el = document.activeElement;
    return { cls: el.className, text: el.textContent.trim(), href: el.getAttribute('href') };
  });
  check(first.cls.includes('skip-link'), `Tab 首站是跳转链接（${first.text} → ${first.href}）`);

  const skipTarget = await page.evaluate(() => {
    const id = document.querySelector('.skip-link').getAttribute('href').slice(1);
    const el = document.getElementById(id);
    return { id, exists: !!el, tabindex: el && el.getAttribute('tabindex') };
  });
  check(skipTarget.exists && skipTarget.tabindex === '-1', `跳转目标 #${skipTarget.id} 存在且可聚焦`);

  // 焦点环：链接聚焦后 outline 实际生效
  const ring = await page.evaluate(() => {
    const a = document.querySelector('.skip-link');
    a.focus();
    const st = getComputedStyle(a);
    return { width: st.outlineWidth, style: st.outlineStyle, color: st.outlineColor };
  });
  check(ring.style !== 'none' && parseFloat(ring.width) >= 2, `焦点环可见（${ring.width} ${ring.style}）`);

  // 评论表单每个字段都有可读名称
  const fields = await page.evaluate(() => {
    const list = [...document.querySelectorAll('#cmt-form input, #cmt-form textarea')]
      .filter((el) => el.name !== 'hp')
      .map((el) => {
        const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const aria = el.getAttribute('aria-label');
        return { name: el.name, label: lab ? lab.textContent.trim() : aria || '' };
      });
    return list;
  });
  const unnamed = fields.filter((f) => !f.label);
  check(unnamed.length === 0, `${fields.length} 个字段都有 <label>（缺 ${unnamed.length}）`);
  await page.close();
}

/* ---------- 三、首页搜索框 ---------- */
console.log('\n[3] 首页搜索框');
{
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/?cb=' + Math.random(), { waitUntil: 'networkidle0' });
  const name = await page.evaluate(() => {
    const el = document.getElementById('q');
    if (!el) return null;
    const lab = document.querySelector(`label[for="q"]`);
    return { label: lab && lab.textContent.trim(), aria: el.getAttribute('aria-label'), placeholder: el.placeholder };
  });
  check(!!name && !!name.label, `搜索框有 label：「${name && name.label}」`);
  const jsHrefs = await page.$$eval('a[href^="javascript:"]', (els) => els.length);
  check(jsHrefs === 0, `首页无 javascript: 伪链接（${jsHrefs} 处）`);
  await page.close();
}

/* ---------- 四、阻塞 CSS 用掉多少 ---------- */
console.log('\n[4] CSS 覆盖率（禁缓存后重新加载，按样式表统计）');
{
  for (const path of ['/', POST, '/archive']) {
    const page = await browser.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('Network.enable');
    // 不关缓存的话，样式表从内存里直接命中，覆盖率会把整张表算成"用过"
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('CSS.startRuleUsageTracking');
    await page.goto(ORIGIN + path + '?cb=' + Math.random(), { waitUntil: 'networkidle0' });
    const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');

    // 逐表取原文长度当分母，避免"规则区间之和"漏掉注释与空白
    const ids = [...new Set(ruleUsage.map((r) => r.styleSheetId))];
    let total = 0;
    for (const id of ids) {
      let text = '';
      try {
        ({ text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: id }));
      } catch {
        text = '';
      }
      if (text.length > 20000) total += text.length; // 只看主样式表，内联的几行小样式不算
    }
    const usedBy = new Map();
    for (const r of ruleUsage) {
      if (!r.used) continue;
      usedBy.set(r.styleSheetId, (usedBy.get(r.styleSheetId) || 0) + (r.endOffset - r.startOffset));
    }
    const used = [...usedBy.values()].reduce((a, b) => a + b, 0);

    const perf = await page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const css = performance.getEntriesByType('resource').filter((r) => r.name.includes('.css'));
      return {
        fcp: fcp ? Math.round(fcp.startTime) : null,
        cssBytes: css.reduce((a, r) => a + (r.encodedBodySize || 0), 0),
        cssCount: css.length,
      };
    });
    const pct = total ? ((used / total) * 100).toFixed(1) : '?';
    console.log(
      `  ${path.padEnd(22)} 主样式表 ${total}b，用到 ${used}b（${pct}%）` +
        `  CSS 传输 ${perf.cssBytes}b/${perf.cssCount} 个  FCP ${perf.fcp}ms`
    );
    await page.close();
  }
}

await browser.close();
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
