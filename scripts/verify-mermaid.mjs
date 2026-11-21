#!/usr/bin/env node
/**
 * Mermaid 渲染真机验证：起一个静态服务指向 public/，用真实 Chrome 看 SVG 有没有出来。
 *
 * 为什么单测不够：md.js 的输出、boot.js 的注入、integrity 是否配对、mermaid 是否
 * 真能把这段源码画出来 —— 全是运行时行为。静态断言只能证明「代码写了」，
 * 证明不了「图画出来了」。
 *
 *   node scripts/verify-mermaid.mjs
 *   退出码 0 = 图出来了；1 = 没出来（会打印控制台错误）
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';
import { renderBody } from '../public/md.js';
import { ASSET_HASH } from '../src/assets.gen.js';

const PUB = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const DOC = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>mermaid</title><link rel="stylesheet" href="/style.css?v=${ASSET_HASH['style.css'].v}">
<script>window.__ASSET_H__={'/vendor/mermaid.min.js':${JSON.stringify(ASSET_HASH['vendor/mermaid.min.js'])}};</script>
<script src="/boot.js?v=${ASSET_HASH['boot.js'].v}" defer></script>
</head><body><main class="md">${renderBody(
  '```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| A\n```'
)}</main></body></html>`;

const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '/test.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(DOC);
  }
  const file = join(PUB, p.replace(/^\/+/, ''));
  if (!existsSync(file)) {
    res.writeHead(404).end('nope');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/test.html`;

const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

let ok = false;
let detail = '';
try {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForFunction(
    () => {
      const w = document.querySelector('.mermaid-wrap');
      return w && (w.classList.contains('is-rendered') || w.classList.contains('is-error'));
    },
    { timeout: 45000 }
  );
  const r = await page.evaluate(() => {
    const w = document.querySelector('.mermaid-wrap');
    const svg = w.querySelector('.mm-body svg');
    return {
      rendered: w.classList.contains('is-rendered'),
      errored: w.classList.contains('is-error'),
      hasSvg: !!svg,
      // 图里得有节点文字，空 SVG 也是「画出来了」但没内容
      text: svg ? svg.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
      size: svg ? Math.round(svg.getBoundingClientRect().width) + 'x' + Math.round(svg.getBoundingClientRect().height) : '',
      preHidden: !w.querySelector('.mm-src') || getComputedStyle(w.querySelector('.mm-src')).display === 'none',
    };
  });
  ok = r.rendered && r.hasSvg && r.text.length > 0;
  detail = JSON.stringify(r);
} catch (e) {
  detail = '等待超时：' + e.message;
}

await browser.close();
server.close();

console.log(`\n${ok ? 'PASS' : 'FAIL'}  mermaid 真机渲染`);
console.log('  ' + detail);
if (errors.length) {
  console.log('  控制台错误：');
  for (const e of errors.slice(0, 6)) console.log('   · ' + e.slice(0, 300));
}
process.exit(ok ? 0 : 1);
