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
  // 这条用例真正要守的是「--dry 一个字都不改」，它跟网络无关，先断言。
  assert.equal(readFileSync('wrangler.jsonc', 'utf8'), before, '--dry 之后 wrangler.jsonc 被改了');
  if (r.status === 0) {
    assert.match(r.stdout, /已插入 vars|替换为新值/);
    assert.match(r.stdout, /不落盘/);
    return;
  }
  // 拉脚本那一步要访问 cloud.umami.is。有些网络（公司出口 / 特定地区）整段域名不可达，
  // 这时脚本会停在联网校验上。那是环境问题，不是 --dry 把配置写坏了——
  // 所以只放行这一种失败，且上面「文件没变」的断言已经过了；其它失败照旧算 bug。
  assert.match(r.stderr, /脚本拉不下来/, `--dry 意外失败：${r.stdout}${r.stderr}`);
  console.log('        （本机连不上 cloud.umami.is，本次只验了 --dry 不落盘）');
});

/* 2026-11-25 实测：CF 新建 widget 的真 sitekey/secret 含连字符，
   旧正则 [0-9A-Za-z] 把真值判成非法。这里用一个形状正确但必然验不过的 secret，
   判据是「没停在形状校验」——会继续走到 siteverify 并报 SECRET 无效。 */
t('带连字符的密钥形状被接受（CF 真值形态）', () => {
  const r = run(['turnstile', '0x4AAAAAAA-test-shape-key', '0x4AAAAAAA-test-shape-secret', '--dry']);
  assert.doesNotMatch(r.stderr, /形状不对/, r.stderr);
  assert.match(r.stderr, /SECRET 无效|连不上 siteverify|没见过的结果/);
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
