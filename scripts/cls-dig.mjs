#!/usr/bin/env node
/**
 * 定位 CLS 的具体来源：把每个 layout-shift 的 source 节点的
 * 前后矩形、文本、父链都打出来。CLS 只告诉你「哪个 class 动了」，
 * 那通常是容器；真正动的是里面某个高度变化的子元素。
 *
 * 用法：node scripts/cls-dig.mjs https://miu.sryze.cc/
 */
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const URL_ARG = process.argv[2] || 'https://miu.sryze.cc/';
const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

await page.evaluateOnNewDocument(() => {
  window.__d = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      const srcs = (e.sources || []).map((s) => {
        const n = s.node;
        const path = (el) => {
          const out = [];
          let x = el;
          for (let i = 0; x && i < 4; i++, x = x.parentElement) {
            out.push(x.tagName ? x.tagName.toLowerCase() + (x.className && typeof x.className === 'string' ? '.' + x.className.trim().split(/\s+/).join('.') : '') : '?');
          }
          return out.join(' < ');
        };
        return {
          path: n ? path(n) : '?',
          text: n && n.textContent ? n.textContent.trim().slice(0, 40) : '',
          prev: s.previousRect ? `${Math.round(s.previousRect.x)},${Math.round(s.previousRect.y)} ${Math.round(s.previousRect.width)}x${Math.round(s.previousRect.height)}` : '',
          cur: s.currentRect ? `${Math.round(s.currentRect.x)},${Math.round(s.currentRect.y)} ${Math.round(s.currentRect.width)}x${Math.round(s.currentRect.height)}` : '',
        };
      });
      window.__d.push({ v: +e.value.toFixed(4), t: Math.round(e.startTime), srcs });
    }
  }).observe({ type: 'layout-shift', buffered: true });
});

await page.goto(URL_ARG, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));
const d = await page.evaluate(() => window.__d);
await browser.close();

for (const e of d) {
  console.log(`\n${e.v}  @${e.t}ms`);
  for (const s of e.srcs) {
    console.log(`   ${s.path}`);
    if (s.text) console.log(`      "${s.text}"`);
    console.log(`      ${s.prev}  →  ${s.cur}`);
  }
}
if (!d.length) console.log('没有非用户触发的布局偏移');
