#!/usr/bin/env node
/**
 * 交互细节的端到端体检。这些都是「不报错、但用户能看出来坏了」的东西：
 * 搜索命中没高亮、空结果只有一句话、长评论把页面拉成三屏、百分比永远 0%。
 *
 *   node scripts/check-ux.mjs http://127.0.0.1:8788
 *   node scripts/check-ux.mjs https://exia.de5.net --q 缓存
 *
 * 需要本地装 Chrome。跑本地时用 --q 指定一个确实能命中的关键词。
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const qIdx = process.argv.indexOf('--q');
const KEY = qIdx > 0 ? process.argv[qIdx + 1] : '缓存';
const SLUG = process.env.UX_SLUG || 'blog-markdown-xss';

let pass = 0;
const fails = [];
const t = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};
const bust = (u) => u + (u.includes('?') ? '&' : '?') + '__t=' + Date.now();

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

/* ---------- 搜索：高亮 + 空结果 ---------- */
{
  const p = await browser.newPage();
  await p.setCacheEnabled(false);
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(bust(`${base}/?q=${encodeURIComponent(KEY)}`), { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => !document.querySelector('.sk-card'), { timeout: 15000 }).catch(() => {});
  const r = await p.evaluate(() => ({
    marks: [...document.querySelectorAll('#list mark')].map((m) => m.textContent),
    cards: document.querySelectorAll('#list .post-card').length,
  }));
  t(r.cards > 0, `搜索「${KEY}」有结果（${r.cards} 篇）`);
  t(r.marks.length > 0, `结果里出现 <mark> 高亮（${r.marks.length} 处）`);
  t(
    r.marks.length > 0 && r.marks.every((m) => m.toLowerCase().includes(KEY.toLowerCase())),
    '每个 <mark> 都正好是关键词，没有把整句圈进去',
    r.marks.slice(0, 3).join(' | ')
  );

  await p.goto(bust(`${base}/?q=${encodeURIComponent('zzz不存在的词zzz')}`), { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => !document.querySelector('.sk-card'), { timeout: 15000 }).catch(() => {});
  const e = await p.evaluate(() => {
    const box = document.querySelector('.empty-search');
    return {
      has: !!box,
      text: box?.textContent.replace(/\s+/g, ' ').trim() || '',
      links: [...(box?.querySelectorAll('a') || [])].map((a) => a.getAttribute('href')),
    };
  });
  t(e.has, '空结果给出结构化提示，而不是一句「没有找到」');
  t(e.text.includes('zzz不存在的词zzz'), '提示里回显了关键词');
  t(e.links.length >= 2, `给了出口链接（${e.links.join(' ')}）`);
  await p.close();
}

/* ---------- 文章页：评论时间 / 长评论折叠 / 阅读百分比 / 代码横滚 ---------- */
{
  const p = await browser.newPage();
  await p.setCacheEnabled(false);
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(bust(`${base}/p/${SLUG}`), { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 700));

  const meta = await p.evaluate(() => {
    const m = document.querySelector('meta[name="description"]');
    return m ? m.getAttribute('content') : null;
  });
  t(!!meta && meta.length > 10, `meta description 有内容（${meta ? meta.length : 0} 字）`);
  t(!!meta && !/[\r\n]/.test(meta), 'meta description 里没有换行');
  t(!!meta && meta.length <= 160, 'meta description 不超 160 字', meta ? String(meta.length) : '');

  const times = await p.evaluate(() =>
    [...document.querySelectorAll('#cmt-list time.when')].map((el) => ({
      text: el.textContent.trim(),
      dt: el.getAttribute('datetime'),
      title: el.getAttribute('title'),
    }))
  );
  if (times.length) {
    t(times.every((x) => /^(\d+ (秒|分钟|小时|天|个月|年)前|刚刚)$/.test(x.text)), '评论时间是「多久前」而不是原始时间戳', times.map((x) => x.text).join(' / '));
    t(times.every((x) => /T.*Z$/.test(x.dt || '')), 'datetime 是合法 ISO（带 Z）', times[0]?.dt || '');
    t(times.some((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.title || '')), '悬停能看到准确时间', times[0]?.title || '');

    const clip = await p.evaluate(() => {
      const txt = [...document.querySelectorAll('#cmt-list .text')].find((el) => el.classList.contains('clipped'));
      if (!txt) return null;
      return { h: Math.round(txt.getBoundingClientRect().height), more: !!txt.nextElementSibling?.classList.contains('cmt-more') };
    });
    t(!!clip, '长评论被折叠', clip ? `折叠高度 ${clip.h}px` : '没有超过阈值的长评论');
    t(clip ? clip.more : true, '折叠下方有展开按钮');

    if (clip) {
      const after = await p.evaluate(() => {
        const btn = document.querySelector('#cmt-list .cmt-more');
        btn.click();
        const txt = btn.previousElementSibling;
        return {
          clipped: txt.classList.contains('clipped'),
          label: btn.textContent.trim(),
          aria: btn.getAttribute('aria-expanded'),
          h: Math.round(txt.getBoundingClientRect().height),
        };
      });
      t(!after.clipped && after.h > 220, `点一下能展开（高度 ${after.h}px）`);
      t(after.label === '收起' && after.aria === 'true', '按钮文案与 aria-expanded 同步成「收起」');
    }
  } else {
    console.log('  跳过：这条 slug 没有评论，折叠与时间未验（UX_SLUG 换一篇有评论的）');
  }

  const total = await p.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  await p.evaluate((y) => scrollTo(0, y), Math.round(total * 0.5));
  await new Promise((r) => setTimeout(r, 400));
  const pct = await p.evaluate(() => {
    const el = document.querySelector('.read-pct');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { text: el.textContent.trim(), on: el.classList.contains('on'), shown: cs.display !== 'none' && Number(cs.opacity) > 0.5 };
  });
  t(!!pct, '侧边百分比节点存在');
  t(pct ? pct.on && pct.shown : false, '滚到中途时百分比可见', pct ? JSON.stringify(pct) : '');
  t(pct ? /^\d{1,3}%$/.test(pct.text) && +pct.text.replace('%', '') > 5 && +pct.text.replace('%', '') < 95 : false, '百分比数值落在 5–95 之间', pct?.text || '');

  const code = await p.evaluate(async () => {
    const wraps = [...document.querySelectorAll('.code-wrap')];
    const target = wraps.find((w) => w.classList.contains('overflowing'));
    if (!target) return { wraps: wraps.length, overflowing: 0 };
    const pre = target.querySelector('pre.code-block');
    pre.scrollLeft = pre.scrollWidth;
    pre.dispatchEvent(new Event('scroll', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 60));
    return { wraps: wraps.length, overflowing: wraps.filter((w) => w.classList.contains('overflowing')).length, atEnd: target.classList.contains('at-end') };
  });
  t(code.overflowing > 0, `长代码块被标成可横滚（${code.overflowing}/${code.wraps}）`);
  t(code.atEnd === true, '滚到右端后右侧渐隐撤掉');

  await p.close();
}

/* ---------- 没有小标题的文章：正文不能被挤进目录列 ---------- */
/* .post-article 是两列 grid，第一个子元素落 232px 那列。文章没有 3 个小标题时
   目录不出，正文就成了第一个子元素 —— 整篇压成 180px 宽，右边一片空白。
   这一页不报错、不 404，只是「看着很窄」，所以必须靠断言盯着。 */
{
  const p = await browser.newPage();
  await p.setCacheEnabled(false);
  await p.setViewport({ width: 1400, height: 900 });
  const plain = process.env.UX_PLAIN_SLUG || 'cs';
  const res = await p.goto(bust(`${base}/p/${plain}`), { waitUntil: 'networkidle2', timeout: 60000 });
  if (res && res.status() === 200) {
    const info = await p.evaluate(() => ({
      w: Math.round(document.querySelector('.post-main')?.getBoundingClientRect().width || 0),
      tocLinks: document.querySelectorAll('.post-toc a').length,
    }));
    if (info.tocLinks === 0) {
      t(info.w > 600, `没有小标题的文章正文仍是整宽（${info.w}px）`);
    } else {
      console.log(`  跳过：/p/${plain} 有目录，换个没有小标题的 slug（UX_PLAIN_SLUG）`);
    }
  }
  await p.close();
}

await browser.close();
console.log(`\n${pass} 通过，${fails.length} 失败`);
if (fails.length) process.exit(1);
