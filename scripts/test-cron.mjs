// 友链探测的 SSRF 闸门：内网/回环/元数据地址绝不能被 Worker 主动请求。
// probe 的逐跳跟随无法在纯 node 里跑（依赖 fetch 3xx 与 Workers 运行时），
// 但闸门本体 isBlockedHost 是纯函数，穷举常见绕过写法即可。
// 用法：node scripts/test-cron.mjs
import assert from 'node:assert/strict';
import { isBlockedHost } from '../src/cron.js';

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};

t('公网域名放行', () => {
  for (const h of ['example.com', 'github.com', 'cloudflare.com', 'npmjs.org']) {
    assert.equal(isBlockedHost(h), false, h);
  }
});

t('回环地址全段拦截', () => {
  for (const h of ['localhost', 'foo.localhost', '127.0.0.1', '127.255.255.255', '::1', '[::1]', '::']) {
    assert.equal(isBlockedHost(h), true, h);
  }
});

t('私有网段拦截', () => {
  for (const h of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '0.0.0.0']) {
    assert.equal(isBlockedHost(h), true, h);
  }
});

t('172.16/12 边界：段外不误杀', () => {
  assert.equal(isBlockedHost('172.15.255.255'), false);
  assert.equal(isBlockedHost('172.32.0.1'), false);
});

t('169.254 元数据地址与 IPv4-mapped IPv6 拦截', () => {
  for (const h of ['169.254.169.254', '169.254.1.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isBlockedHost(h), true, h);
  }
});

t('IPv6 本地段拦截（fc00::/7、fe80::/10）', () => {
  for (const h of ['fc00::1', 'fd00::1', 'fe80::1', 'febf::1', '[fd12::abcd]']) {
    assert.equal(isBlockedHost(h), true, h);
  }
});

t('本地后缀域名拦截', () => {
  for (const h of ['printer.local', 'host.internal', 'svc.local.']) {
    assert.equal(isBlockedHost(h), true, h);
  }
});

t('大小写与空白归一化后仍拦截', () => {
  assert.equal(isBlockedHost('  LOCALHOST  '), true);
  assert.equal(isBlockedHost('[FD00::1]'), true);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
