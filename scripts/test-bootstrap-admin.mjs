#!/usr/bin/env node
/**
 * 管理员引导的断言（[P-046]）。
 *
 * 守的是 2026-11-24 改掉的那条规则：**管理员席位不按登录顺序发放**。
 * 旧逻辑 isFirst ? 1 : 0 等于把后台交给最先到达的人 —— 公开可部署的项目里，
 * 抢一次登录就是管理员，之后所有 pending 投稿归他放行。现在多一个条件：
 * 空库 + 一次性的 BOOTSTRAP_TOKEN，两样齐了才给 admin，且用完即失效。
 *
 * B-01~08 是行为，B-09~12 是元断言（读源码/读文档），后者防的是"有人把
 * isFirst 顺手写回去"和"代码改了文案没改"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideAccess, secretEq } from '../src/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const authSrc = fs.readFileSync(path.join(root, 'src', 'auth.js'), 'utf8');

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* ---------- B-01~03 常量时间比较 ---------- */

t('B-01 相同的串返回 true', () => {
  assert.equal(secretEq('aB3xY9qW', 'aB3xY9qW'), true);
});

t('B-02 长度不同一律 false，不因前缀相同而不同', () => {
  assert.equal(secretEq('abcdef', 'abcdefg'), false);
  assert.equal(secretEq('abcdefg', 'abcdef'), false);
  // 前缀相同的两个等长串：必须 false，且不能是"第一个字符不同就 return"
  assert.equal(secretEq('abcdef', 'abcdeg'), false);
});

t('B-03 空串 / null / undefined 都不算相等（否则不配令牌等于配了空令牌）', () => {
  assert.equal(secretEq('', ''), false);
  assert.equal(secretEq(null, null), false);
  assert.equal(secretEq(undefined, undefined), false);
  assert.equal(secretEq('', undefined), false);
});

/* ---------- B-04~08 管理员归属 ---------- */

t('B-04 空库 + 没有引导令牌 → 普通账号（旧的"先到先得"必须死）', () => {
  assert.equal(decideAccess({}, 'firstcomer', true).admin, 0);
  assert.equal(decideAccess({}, 'firstcomer', true, false).admin, 0);
  assert.equal(decideAccess({}, 'firstcomer', true, undefined).admin, 0);
});

t('B-05 空库 + 引导令牌通过 → 成为管理员', () => {
  assert.equal(decideAccess({}, 'firstcomer', true, true).admin, 1);
});

t('B-06 库里有行（isFirst=false）时令牌不再生效 —— 这就是"用完即失效"', () => {
  assert.equal(decideAccess({}, 'latecomer', false, true).admin, 0);
});

t('B-07 第四参只认布尔 true：cookie 里来的字符串不算数', () => {
  for (const v of ['1', 'true', 1, {}, [], 'yes']) {
    assert.equal(decideAccess({}, 'x', true, v).admin, 0, `bootstrapped=${JSON.stringify(v)} 不该放行`);
  }
});

t('B-08 ADMIN_LOGINS 优先：名单外的人带令牌也进不去', () => {
  const env = { ADMIN_LOGINS: 'boss' };
  assert.equal(decideAccess(env, 'firstcomer', true, true).admin, 0);
  assert.equal(decideAccess(env, 'boss', true, false).admin, 1);
});

/* ---------- B-09~12 元断言 ---------- */

t('B-09 登录入口必须用 secretEq 比较令牌，且 cookie 带 HttpOnly + Secure + 10 分钟上限', () => {
  assert.ok(/secretEq\(boot,\s*bootToken\)|secretEq\(/.test(authSrc), 'loginRedirect 没做常量时间比较');
  assert.ok(/BOOTSTRAP_TOKEN/.test(authSrc), '没有读 BOOTSTRAP_TOKEN');
  const bootCookieLines = authSrc
    .split('\n')
    .filter((l) => l.includes('BOOT_COOKIE') && l.includes('Path=/'));
  assert.ok(bootCookieLines.length >= 2, '找不到引导标记 cookie 的写入/清除');
  for (const l of bootCookieLines) {
    assert.ok(/HttpOnly/.test(l), `cookie 缺 HttpOnly：${l.trim()}`);
    assert.ok(/Secure/.test(l), `cookie 缺 Secure：${l.trim()}`);
  }
  assert.ok(/Max-Age=600/.test(authSrc), '引导标记 cookie 的有效期不是 600 秒');
});

t('B-10 回调必须把 cookie 里的引导标记传给 decideAccess，并在成功后清掉', () => {
  assert.ok(
    /const bootstrapped = parseCookies\(request\)\[BOOT_COOKIE\] === '1'/.test(authSrc),
    '回调没有从 cookie 读引导标记（不接受真值判断，必须是 === "1"）'
  );
  assert.ok(/decideAccess\(env,\s*ghUser\.login,\s*isFirst,\s*bootstrapped\)/.test(authSrc), 'decideAccess 没收到第四个参数');
});

t('B-11 auth.js 里不许出现裸 isFirst 换 admin（必须同时要求 bootstrapped）', () => {
  /* 只看代码：注释里要保留"旧逻辑是 isFirst ? 1 : 0"的历史说明，
     那是给人读的，不该被断言当成实现。上一版按行首字符判断，块注释的
     中间行（不以 * 开头）漏网，断言咬到了自己的说明文字。改成先剥块注释。 */
  const codeOnly = authSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const codeLines = codeOnly.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  const offenders = codeLines.filter((l) => /isFirst\s*\?\s*1\s*:\s*0/.test(l));
  assert.deepEqual(offenders, [], `代码里又出现 isFirst 三元：\n${offenders.join('\n')}`);
  const line = codeLines.find((l) => /const admin =/.test(l));
  assert.ok(line, '找不到 decideAccess 里的 admin 赋值');
  assert.ok(/bootstrapped === true/.test(line), `admin 赋值没要求引导令牌：${line.trim()}`);
});

t('B-12 文档与登录页不许再写"自动成为管理员"（代码改了文案没改等于没改）', () => {
  const files = ['README.md', 'public/login.html', 'src/auth.js'];
  const bad = [];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8');
    txt.split('\n').forEach((l, i) => {
      if (/自动成为管理员|自动成为管理员|第一个登录.*管理员|首个登录.*管理员/.test(l)) bad.push(`${f}:${i + 1}  ${l.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], `文案还在承诺"登录即管理员"：\n${bad.join('\n')}`);
});

t('B-13 secretEq 必须是逐字节累加，不许退化成 ===（行为断言看不出时序差）', () => {
  const i = authSrc.indexOf('export function secretEq');
  assert.ok(i > 0, '找不到 secretEq');
  const body = authSrc.slice(i, authSrc.indexOf('\n}', i) + 2);
  assert.ok(/for\s*\(/.test(body), 'secretEq 里没有循环，比较会提前返回');
  assert.ok(/diff\s*\|=/.test(body), 'secretEq 没有把差异累加进同一个变量');
  assert.ok(!/return\s+[A-Za-z_$][\w$]*\s*===\s*[A-Za-z_$][\w$]*\s*;/.test(body), 'secretEq 退化成了 ===');
});

/* ---------- 跑 ---------- */

let pass = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`[P-046] 管理员引导 ${pass}/${cases.length} passed`);
