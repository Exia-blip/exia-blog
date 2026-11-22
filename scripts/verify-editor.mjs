#!/usr/bin/env node
/**
 * 编辑器真机验证：Monaco 有没有真的挂上去、输入能不能同步回影子 textarea、
 * 工具栏插入有没有落到 Monaco 上。
 *
 * 为什么必须真机：Monaco 是 AMD 从 CDN 拉的，SRI 是否配对、worker 会不会 404、
 * 布局是不是 0 高度 —— 全靠运行时才知道。静态断言只能证明代码写了。
 *
 *   node scripts/verify-editor.mjs
 *   退出码 0 = 全部通过
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const PUB = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// 后台依赖的接口一律返回最小可用的假数据，让模块跑到底（没登录会被踢到 /login）
let postWrites = [];
let failNextWrite = false;
const stub = (p, method) => {
  if (p === '/api/me') return { user: { id: 1, name: 'tester', is_admin: true, avatar: '' } };
  if (p === '/api/mine') return { posts: [] };
  if (p.startsWith('/api/taxonomy')) return { categories: [], seed: [] };
  if (p.startsWith('/api/settings')) return { name: '测试站', desc: '', avatar: '', theme: 'paper', mode: 'auto' };
  // 提交防重复锁：统计真实写请求数，并能模拟一次服务端失败
  if (p === '/api/posts' && method === 'POST') {
    postWrites.push(Date.now());
    if (failNextWrite) { failNextWrite = false; return { __err: '模拟保存失败' }; }
    return { id: 42, slug: 'probe', published_at: '' };
  }
  if (/^\/api\/posts\/\d+$/.test(p) && method === 'PUT') {
    postWrites.push(Date.now());
    if (failNextWrite) { failNextWrite = false; return { __err: '模拟保存失败' }; }
    return { id: 42, slug: 'probe', published_at: '' };
  }
  return {};
};

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p.startsWith('/api/')) {
    const d = stub(p, req.method);
    res.writeHead(d.__err ? 500 : 200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(d.__err ? { error: d.__err } : d));
  }
  const file = join(PUB, p.replace(/^\/+/, '') || 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('404');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

let pass = 0;
const fails = [];
const t = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};

try {
  await page.goto(base + '/editor.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Monaco 是 CDN + AMD，给足时间；失败会落到 .mon-fail
  await page
    .waitForFunction(
      () => document.querySelector('.pane.left.mon-ready') || document.querySelector('.pane.left.mon-fail'),
      { timeout: 60000 }
    )
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const st = await page.evaluate(() => {
    const pane = document.querySelector('.pane.left');
    const host = document.getElementById('monaco-host');
    const ta = document.getElementById('md-input');
    return {
      ready: pane.classList.contains('mon-ready'),
      failed: pane.classList.contains('mon-fail'),
      hostH: host ? Math.round(host.getBoundingClientRect().height) : 0,
      hostW: host ? Math.round(host.getBoundingClientRect().width) : 0,
      hasEditorDom: !!host.querySelector('.monaco-editor'),
      taVisible: ta ? getComputedStyle(ta).display !== 'none' : false,
      hasMermaidHook: typeof window.__rerenderMermaid === 'function',
    };
  });

  t('Monaco 挂载成功（不是降级态）', st.ready && !st.failed);
  t('编辑器 DOM 真的渲染出来', st.hasEditorDom);
  t('宿主容器有尺寸（不是 0 高度）', st.hostH > 200 && st.hostW > 200, `${st.hostW}x${st.hostH}`);
  t('Monaco 就绪后 textarea 让位', !st.taVisible);
  t('mermaid 重绘钩子已暴露', st.hasMermaidHook);

  /* 输入 → 影子 textarea */
  await page.evaluate(() => {
    const m = window.monaco;
    if (!m) return;
    m.editor.getModels()[0].setValue('第一行\n# 标签 test\n');
  });
  await new Promise((r) => setTimeout(r, 150));
  const sync = await page.evaluate(() => ({
    ta: document.getElementById('md-input').value,
    visible: document.getElementById('md-input') !== null,
  }));
  t('Monaco 编辑同步写回 textarea（保存链路读它）', sync.ta === '第一行\n# 标签 test\n', JSON.stringify(sync.ta));

  /* 工具栏 → Monaco */
  await page.evaluate(() => {
    const m = window.monaco;
    const model = m.editor.getModels()[0];
    model.setValue('abc');
    const ed = m.editor.getEditors()[0];
    ed.setPosition({ lineNumber: 1, column: 2 }); // 光标在 a|bc
    ed.focus();
  });
  await page.click('.ed-tools button[data-cmd="b"]');
  await new Promise((r) => setTimeout(r, 200));
  const afterTool = await page.evaluate(() => ({
    model: window.monaco.editor.getModels()[0].getValue(),
    ta: document.getElementById('md-input').value,
  }));
  t('工具栏加粗在 Monaco 里生效', afterTool.model === 'a**加粗文字**bc', afterTool.model);
  t('工具栏改完仍同步回 textarea', afterTool.ta === afterTool.model, afterTool.ta);

  /* Tab 缩进交给 Monaco */
  const tabSt = await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    return { tabSize: window.monaco.editor.getModels()[0].getOptions().tabSize };
  });
  t('Monaco 缩进是 2 空格（与原 textarea 一致）', tabSt.tabSize === 2, String(tabSt.tabSize));

  /* 工具栏的 mermaid 按钮：围栏 + 模板一次给全 */
  await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.getModel().setValue('');
    ed.setPosition({ lineNumber: 1, column: 1 });
    ed.focus();
  });
  await page.click('.ed-tools button[data-cmd="mermaid"]');
  await new Promise((r) => setTimeout(r, 200));
  const mmIns = await page.evaluate(() => window.monaco.editor.getModels()[0].getValue());
  t('工具栏插入 mermaid 围栏', /```mermaid\n/.test(mmIns) && /graph TD/.test(mmIns), JSON.stringify(mmIns.slice(0, 40)));
  t('正文换行统一是 LF（不引入看不见的 \\r）', !mmIns.includes('\r'), 'CRLF found');

  /* 预览里的 mermaid 应该被渲染出来 */
  await page.evaluate(() => {
    window.monaco.editor.getModels()[0].setValue('```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```\n');
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    document.querySelector('.ed-tab[data-tab="preview"]')?.click();
  });
  await page
    .waitForFunction(() => document.querySelector('#preview .mermaid-wrap.is-rendered'), { timeout: 40000 })
    .catch(() => {});
  const mm = await page.evaluate(() => {
    const w = document.querySelector('#preview .mermaid-wrap');
    return { rendered: !!w && w.classList.contains('is-rendered'), hasSvg: !!(w && w.querySelector('svg')) };
  });
  t('预览里的 mermaid 渲染成 SVG', mm.rendered && mm.hasSvg);

  /* 隐藏 input 不该被误判为「正文丢失」：值仍在 */
  const keep = await page.evaluate(() => document.getElementById('md-input').value.includes('mermaid'));
  t('切到预览后正文仍留在 textarea 里', keep);

  /* 提交防重复锁：连点只发一次、报错解锁可重试、两种文案都可达 */
  await page.evaluate(() => document.querySelector('.ed-tab[data-tab="write"]')?.click());
  postWrites = [];
  const triple = await page.evaluate(() => {
    const b = document.getElementById('btn-save');
    b.click(); b.click(); b.click();
    return { text: b.textContent.trim(), disabled: b.disabled };
  });
  t('连点 3 次立即进入在途态', triple.disabled && triple.text === '发布中…', JSON.stringify(triple));
  await new Promise((r) => setTimeout(r, 600));
  t('连点 3 次只发出 1 次写请求', postWrites.length === 1, `got ${postWrites.length}`);
  const restored = await page.evaluate(() => {
    const b = document.getElementById('btn-save');
    return { text: b.textContent.trim(), disabled: b.disabled };
  });
  t('请求结束后按钮恢复原状', !restored.disabled && restored.text === '发布', JSON.stringify(restored));

  postWrites = [];
  failNextWrite = true;
  await page.click('#btn-save');
  await new Promise((r) => setTimeout(r, 350));
  const afterFail = await page.evaluate(() => {
    const b = document.getElementById('btn-save');
    return { text: b.textContent.trim(), disabled: b.disabled };
  });
  t('服务端报错后按钮解锁可重试', !afterFail.disabled && afterFail.text === '发布', JSON.stringify(afterFail));
  await page.click('#btn-save');
  await new Promise((r) => setTimeout(r, 350));
  t('重试确实再发一次写请求', postWrites.length === 2, `got ${postWrites.length}`);

  // 自动保存文案：用 MutationObserver 抓瞬时状态，别靠轮询碰运气
  await page.evaluate(() => {
    const b = document.getElementById('btn-save');
    window.__btnTexts = [];
    if (!window.__btnObserver) {
      window.__btnObserver = new MutationObserver(() => window.__btnTexts.push(b.textContent.trim()));
      window.__btnObserver.observe(b, { childList: true, characterData: true, subtree: true });
    }
    window.__btnTexts.length = 0;
    const ta = document.getElementById('md-input');
    ta.value = ta.value + '\nautosave probe';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 4200));
  const autoTexts = await page.evaluate(() => window.__btnTexts);
  t('自动保存显示「保存中…」而非「发布中…」',
    autoTexts.includes('保存中…') && !autoTexts.includes('发布中…'), JSON.stringify(autoTexts));
  t('自动保存最终也解锁', await page.evaluate(() => !document.getElementById('btn-save').disabled));
} catch (e) {
  console.log('  异常：' + e.message);
  fails.push('运行时异常');
}

await browser.close();
server.close();

console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${pass} passed, ${fails.length} failed  （编辑器）`);
if (errors.length) {
  console.log('  控制台错误（前 8 条）：');
  for (const e of errors.slice(0, 8)) console.log('   · ' + e.slice(0, 240));
}
process.exit(fails.length ? 1 : 0);
