#!/usr/bin/env node
/**
 * 浏览器断言一把跑：本地 Worker + D1 夹具 + 一组页面级检查。
 *
 *   node scripts/ci-browser.mjs                 # 起服务、灌夹具、跑全部
 *   node scripts/ci-browser.mjs --no-server     # 复用已在跑的 BASE，不启动/不关停
 *
 * 为什么需要这一层：这些检查原来只能人肉「先 npm run dev、再挨个 node scripts/check-*.mjs」，
 * 于是没人跑。CI 里缺的不是 Chrome，是一个能自己把服务拉起来、灌好数据、
 * 跑完再收干净的东西 —— 顺序错一步就会得到「页面 404 但测试全绿」。
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const PORT = process.env.CI_PORT || '8788';
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const noServer = process.argv.includes('--no-server');

/* 每条检查都是独立进程：一条挂了不影响后面的，最后统一收口退出码 */
const CHECKS = [
  { name: '顶栏不换行', script: 'check-nav.mjs', args: [`${BASE}/`] },
  {
    name: '搜索高亮 / 空结果 / 评论 / 阅读百分比 / 代码横滚',
    script: 'check-ux.mjs',
    args: [BASE, '--q', '缓存'],
    env: { UX_SLUG: 'ci-fixture', UX_PLAIN_SLUG: 'ci-plain' },
  },
  { name: '滚动件滞回', script: 'check-scroll-ui.mjs', args: [`${BASE}/p/ci-fixture`] },
  { name: '目录吸顶', script: 'check-toc-sticky.mjs', args: [`${BASE}/p/ci-fixture`] },
  { name: '目录进度条像素', script: 'check-toc-bar.mjs', args: [`${BASE}/p/ci-fixture`] },
];

const run = (script, args, env = {}) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

const waitReady = async (ms = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const stop = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // wrangler 会再起一个 workerd 子进程，只 kill 父进程会留下占着端口的孤儿
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
};

console.log(`[1/3] 灌夹具 → 本地 D1`);
const seeded = run('seed-ci.mjs', []);
if (seeded.status !== 0) {
  console.error('夹具写入失败，后面的页面断言没有意义，直接退出');
  process.exit(1);
}

let serverLog = '';
let server = null;
if (!noServer) {
  console.log(`[2/3] 起 wrangler dev :${PORT}`);
  server = spawn(process.execPath, [WRANGLER, 'dev', '--port', PORT, '--local'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    detached: process.platform !== 'win32',
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  if (!(await waitReady())) {
    console.error(`服务在 90 秒内没起来。wrangler 输出：\n${serverLog.slice(-2000)}`);
    stop(server);
    process.exit(1);
  }
} else {
  console.log(`[2/3] 复用已有服务 ${BASE}`);
}

console.log(`[3/3] 跑 ${CHECKS.length} 组断言`);
const fails = [];
for (const c of CHECKS) {
  console.log(`\n— ${c.name}（${c.script}）`);
  const r = run(c.script, c.args, c.env);
  if (r.status !== 0) fails.push(c.name);
}

stop(server);

console.log(`\n${fails.length ? `失败 ${fails.length} 组：${fails.join(' / ')}` : '全部通过'}`);
if (fails.length) process.exit(1);
