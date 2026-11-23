#!/usr/bin/env node
/**
 * 准入策略与资源级判定的断言（[P-021]）。
 *
 * 守的不是"输出等于昨天"，而是三条会让权限静默失控的性质：
 *   1. 不配环境变量时行为与旧版一致（开放注册 + 首个注册者即管理员）——
 *      否则一次部署就会把现有实例锁死。
 *   2. 一旦配了白名单，名单外账号在**任何**分支都拿不到 admin。
 *   3. is_admin 的唯一来源是 decideAccess()，不是散落的三元表达式。
 * 第 3 条是元断言：直接读 auth.js 源码，防止有人"顺手"把 isFirst 写回 INSERT。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitPolicy, decideAccess, ownerOrAdmin, reviewStatusFor } from '../src/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const authSrc = fs.readFileSync(path.join(here, '..', 'src', 'auth.js'), 'utf8');

let pass = 0;
const cases = [];
function t(name, fn) {
  cases.push([name, fn]);
}

/* ---------- AP-01~04 策略解析 ---------- */

t('AP-01 两者都不配 → 开放注册，不指定管理员', () => {
  const p = admitPolicy({});
  assert.equal(p.open, true);
  assert.deepEqual(p.allow, []);
  assert.deepEqual(p.admins, []);
});

t('AP-02 白名单大小写与空格都要容错', () => {
  const p = admitPolicy({ ALLOWED_LOGINS: ' Exia-Blip , someoneelse ,  ,' });
  assert.deepEqual(p.allow, ['exia-blip', 'someoneelse']);
  assert.equal(p.open, false);
});

t('AP-03 名单外账号被拒，且理由可区分', () => {
  const env = { ALLOWED_LOGINS: 'exia-blip' };
  assert.deepEqual(decideAccess(env, 'intruder', true), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(decideAccess(env, 'exia-blip', false), { ok: true, admin: 0 });
});

t('AP-04 空 login 一律拒（GitHub 返回畸形体时不至于建出空行）', () => {
  assert.equal(decideAccess({}, '', true).ok, false);
  assert.equal(decideAccess({}, null, true).ok, false);
});

/* ---------- AP-05~08 管理员归属 ---------- */

t('AP-05 不配 ADMIN_LOGINS → 回落到首个注册者（旧行为保持）', () => {
  assert.equal(decideAccess({ ALLOWED_LOGINS: 'a' }, 'a', true).admin, 1);
  assert.equal(decideAccess({ ALLOWED_LOGINS: 'a,b' }, 'b', false).admin, 0);
});

t('AP-06 配了 ADMIN_LOGINS → 完全不看 isFirst', () => {
  const env = { ADMIN_LOGINS: 'boss' };
  assert.equal(decideAccess(env, 'boss', false).admin, 1);
  // 第一个注册的人也不再自动是管理员——这是本条的全部意义
  assert.equal(decideAccess(env, 'firstcomer', true).admin, 0);
});

t('AP-07 ADMIN_LOGINS 里的人若不在 ALLOWED_LOGINS 内，仍然被拒', () => {
  const env = { ALLOWED_LOGINS: 'a,b', ADMIN_LOGINS: 'boss' };
  assert.equal(decideAccess(env, 'boss', false).ok, false);
});

t('AP-08 只配 ADMIN_LOGINS 不配 ALLOWED_LOGINS → 仍开放注册，但管理员只是名单里的', () => {
  const env = { ADMIN_LOGINS: 'boss' };
  assert.equal(decideAccess(env, 'anyone', true).ok, true);
  assert.equal(decideAccess(env, 'anyone', true).admin, 0);
  assert.equal(decideAccess(env, 'boss', false).admin, 1);
});

/* ---------- AP-09~12 资源级判定 ---------- */

const author = { id: 7, is_admin: 0 };
const admin = { id: 1, is_admin: 1 };
const other = { id: 9, is_admin: 0 };
const post = { author_id: 7 };

t('AP-09 作者本人放行', () => assert.equal(ownerOrAdmin(author, post), true));
t('AP-10 管理员放行（不是作者也放）', () => assert.equal(ownerOrAdmin(admin, post), true));
t('AP-11 路人拒绝', () => assert.equal(ownerOrAdmin(other, post), false));
t('AP-12 未登录 / 文章不存在都返回 false，不抛异常', () => {
  assert.equal(ownerOrAdmin(null, post), false);
  assert.equal(ownerOrAdmin(author, null), false);
});

/* ---------- AP-13~15 元断言：读源码 ---------- */

t('AP-13 is_admin 的写入必须经过 decideAccess，不许再出现 isFirst 三元', () => {
  // 抓 INSERT INTO users 那一段，里面不许有 isFirst
  const insertBlock = authSrc.slice(authSrc.indexOf('INSERT INTO users'), authSrc.indexOf('INSERT INTO users') + 400);
  assert.ok(!/isFirst\s*\?/.test(insertBlock), 'INSERT 里又出现 isFirst 三元，权限又回到"先到先得"');
  assert.ok(/access\.admin/.test(insertBlock), 'INSERT 没接 decideAccess 的结果');
});

t('AP-14 拒绝必须发生在建行之前', () => {
  const iReject = authSrc.indexOf('if (!access.ok)');
  const iInsert = authSrc.indexOf('INSERT INTO users');
  assert.ok(iReject > 0 && iInsert > 0, '找不到拒绝点或建行点');
  assert.ok(iReject < iInsert, '先建行后判拒绝，名单外账号会在库里留痕');
});

t('AP-15 全站只许 auth.js 出现「作者 or 管理员」的判定', () => {
  /* 上一版只认 `author_id !== x.id && !x.is_admin` 一种句式 —— 等号、反序、或运算
     三种改写全部漏网，index.js 的 SSR 路径就靠这个漏洞逃了整整一轮（P-030）。
     现在按语义等价类扫：行内同时出现 author_id 与 (.id / is_admin)，且带 === / !==。
     SQL 里的 `u.id = p.author_id` 是单等号，天然不会命中。 */
  const srcDir = path.join(here, '..', 'src');
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    if (f === 'auth.js') continue; // ownerOrAdmin 的实现点，唯一允许处
    fs.readFileSync(path.join(srcDir, f), 'utf8').split('\n').forEach((line, i) => {
      if (!/(===|!==)/.test(line)) return;
      if (!/\.author_id\b/.test(line)) return;
      if (!/(\.id\b|is_admin)/.test(line)) return;
      offenders.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `裸判定必须改成 ownerOrAdmin()：\n${offenders.join('\n')}`);

  const apiSrc = fs.readFileSync(path.join(srcDir, 'api.js'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(srcDir, 'index.js'), 'utf8');
  assert.ok((apiSrc.match(/ownerOrAdmin\(/g) || []).length >= 5, 'api.js 的 ownerOrAdmin 调用点少于 5 处');
  assert.ok((idxSrc.match(/ownerOrAdmin\(/g) || []).length >= 2, 'index.js 的 SSR 闸门没接 ownerOrAdmin');
});

t('AP-16 审核态只能由 reviewStatusFor() 生成', () => {
  const srcDir = path.join(here, '..', 'src');
  const hits = [];
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js') && x !== 'auth.js')) {
    const s = fs.readFileSync(path.join(srcDir, f), 'utf8');
    if (/is_admin\s*\?\s*'approved'/.test(s)) hits.push(f);
  }
  assert.deepEqual(hits, [], `审核态三元又散出去了：${hits.join(', ')}，应调 reviewStatusFor()`);
  assert.equal(reviewStatusFor({ is_admin: 1 }), 'approved');
  assert.equal(reviewStatusFor({ is_admin: 0 }), 'pending');
  assert.equal(reviewStatusFor(null), 'pending', '未登录不许落 approved');
});

t('AP-17 ownerOrAdmin 必须 null-safe（SSR 闸门不再自带 user && 保护）', () => {
  assert.equal(ownerOrAdmin(null, { author_id: 7 }), false);
  assert.equal(ownerOrAdmin({ id: 7 }, null), false);
  assert.equal(ownerOrAdmin({ id: 7, is_admin: 0 }, { author_id: 7 }), true);
  assert.equal(ownerOrAdmin({ id: 8, is_admin: 0 }, { author_id: 7 }), false);
  assert.equal(ownerOrAdmin({ id: 8, is_admin: 1 }, { author_id: 7 }), true);
});

/* ---------- 跑 ---------- */
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
}
console.log(`[P-021] 准入策略与资源级判定 ${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
