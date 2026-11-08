#!/usr/bin/env node
/**
 * 安全响应头体检：直接问线上，比翻面板可靠。
 * 用法：node scripts/check-headers.mjs [origin]
 *
 * Worker 侧由 src/security.js 统一出口，CF 面板的 Transform Rule 只是
 * 边缘错误页（1101 / 52x / /cdn-cgi/*）的兜底，值必须与这里一致。
 */

const ORIGIN = (process.argv[2] || 'https://exia.de5.net').replace(/\/$/, '');

const WANT = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

// 每条路径都该带头：HTML、文章、静态资源、API、404、301
const PATHS = [
  ['首页', '/'],
  ['文章', '/p/about'],
  ['栏目', '/cat/log'],
  ['静态资源', '/style.css'],
  ['API', '/api/posts?limit=1'],
  ['404', '/no-such-page-xyz'],
  ['301', '/cat/工程实录'],
];

let bad = 0;

for (const [name, path] of PATHS) {
  const url = ORIGIN + path;
  let res;
  try {
    res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'header-check/1.0' } });
  } catch (e) {
    console.log(`✗ ${name.padEnd(8)} ${String(res?.status ?? '').padEnd(4)} ${path}  请求失败：${e.message}`);
    bad++;
    continue;
  }

  const miss = [];
  for (const [k, v] of Object.entries(WANT)) {
    const got = res.headers.get(k);
    if (!got) miss.push(`缺 ${k}`);
    else if (got.toLowerCase() !== v.toLowerCase()) miss.push(`${k}=${got}（应为 ${v}）`);
  }

  const csp = res.headers.get('content-security-policy');
  const tag = miss.length ? '✗' : '✓';
  if (miss.length) bad++;
  console.log(
    `${tag} ${name.padEnd(8)} ${String(res.status).padEnd(4)} ${path}` +
      (miss.length ? `\n    ${miss.join('；')}` : `  csp=${csp ? 'yes' : 'no'}`)
  );
}

console.log(bad ? `\n${bad} 条路径不合格` : '\n全部路径安全头齐全');

/* ---------- 边缘层：这一段走 Cloudflare，不经过 Worker ----------
 * /cdn-cgi/trace 由边缘直接返回，是判断「面板 Transform Rule 加没加」的唯一可靠信号。
 * 它缺头不影响正常页面（Worker 已经给了），所以默认不计入失败，
 * 只有 --strict 时才当错误。 */
const EDGE = '/cdn-cgi/trace';
console.log('\n--- 边缘层（不经 Worker）---');
try {
  const res = await fetch(ORIGIN + EDGE, {
    headers: { 'user-agent': 'header-check/1.0' },
  });
  const miss = [];
  for (const [k, v] of Object.entries(WANT)) {
    const got = res.headers.get(k);
    if (!got) miss.push(`缺 ${k}`);
    else if (got.toLowerCase() !== v.toLowerCase()) miss.push(`${k}=${got}（应为 ${v}）`);
  }
  if (!miss.length) {
    console.log(`✓ ${EDGE}  三个头齐全 —— 面板规则已生效`);
  } else {
    console.log(`! ${EDGE}  ${miss.join('；')}`);
    console.log('   ↳ 面板 Transform Rule 还没落地。正常页面不受影响（Worker 已覆盖），');
    console.log('     但 CF 自己的 1101 / 52x 错误页和 /cdn-cgi/* 上没有这些头。');
    console.log('   ↳ 修复：node scripts/apply-edge-headers.mjs --apply');
    if (process.argv.includes('--strict')) bad++;
  }
} catch (e) {
  console.log(`? ${EDGE}  请求失败：${e.message}`);
}

process.exit(bad ? 1 : 0);
