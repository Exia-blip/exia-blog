// setup.mjs 的失败分支测试。
//
// 重点不是「正常值能写进去」（那条跑一次就够），而是三条会静默走错的路：
//   1. 占位符被当成真实值写进配置 —— 写进去之后 CSP 放行一个不存在的源，
//      而自建上报已被 __PV_OFF__ 关掉，两边都没数据；
//   2. 占位符带尖括号时根本不是参数，是重定向，命令在脚本启动前就断了；
//   3. --dry 说不落盘就必须一个字都不改。
// 每一条都用真实子进程跑，不 import 内部函数 —— 这脚本的价值在于「跑起来会怎样」。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (args) =>
  spawnSync(process.execPath, ['scripts/setup.mjs', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const UUID = '1f2e3d4c-5b6a-4978-8c9d-0e1f2a3b4c5d';
const SCRIPT = 'https://cloud.umami.is/script.js';

t('尖括号占位符被拒，且不碰配置文件', () => {
  const before = readFileSync('wrangler.jsonc', 'utf8');
  const r = run(['umami', SCRIPT, '<你的-website-id>']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /占位符/);
  assert.equal(readFileSync('wrangler.jsonc', 'utf8'), before);
});

t('只写了「你的key」的 webhook 也被拒', () => {
  const r = run(['webhook', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /占位符/);
});

t('省略号形式的 turnstile 密钥被拒', () => {
  const r = run(['turnstile', '0x4AAAAAAA...', `0x4AAAAAAA${'b'.repeat(24)}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /占位符/);
});

t('xxxx 形式的 id 被拒（形状对但不是真值）', () => {
  const r = run(['umami', SCRIPT, 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /占位符/);
});

t('--dry 跑完成功路径但不落盘', () => {
  const before = readFileSync('wrangler.jsonc', 'utf8');
  const r = run(['umami', SCRIPT, UUID, '--dry', '--no-probe']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /已插入 vars|替换为新值/);
  assert.match(r.stdout, /不落盘/);
  assert.equal(readFileSync('wrangler.jsonc', 'utf8'), before);
});

t('非终端 + 没给参数 → 用法提示而不是挂住', () => {
  // stdio 里 stdin 是 ignore（等同 EOF），没有 TTY，应该直接退而不是等输入
  const r = run(['umami']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /用法/);
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(e.message).split('\n').slice(0, 4).join('\n        ')}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} 通过`);
