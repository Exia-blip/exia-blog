#!/usr/bin/env node
/**
 * 准入策略与资源级判定的断言（[P-021]）。
 *
 * 守的不是"输出等于昨天"，而是三条会让权限静默失控的性质：
 *   1. 管理员席位不按登录顺序发放：不配 ADMIN_LOGINS 且没有引导令牌时，
 *      连空库的第一个注册者也只能是普通账号。
 *   2. 一旦配了白名单，名单外账号在**任何**分支都拿不到 admin。
 *   3. is_admin 的唯一来源是 decideAccess()，不是散落的三元表达式。
 * 第 3 条是元断言：直接读 auth.js 源码，防止有人"顺手"把 isFirst 写回 INSERT。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitPolicy, decideAccess, ownerOrAdmin, reviewStatusFor } from '../src/auth.js';
import { srcEntries, srcFiles, nativeSrcFiles, nonProductLeaks, NON_PRODUCT_DIRS } from './lib/src-walk.mjs';

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

t('AP-05 不配 ADMIN_LOGINS、也没有引导令牌 → 首个注册者只是普通账号', () => {
  // 2026-11-24 起不再"先到先得"：isFirst 单独出现不再换来管理员
  assert.equal(decideAccess({ ALLOWED_LOGINS: 'a' }, 'a', true).admin, 0);
  assert.equal(decideAccess({ ALLOWED_LOGINS: 'a' }, 'a', true, false).admin, 0);
  assert.equal(decideAccess({ ALLOWED_LOGINS: 'a,b' }, 'b', false).admin, 0);
});

t('AP-05b 空库 + 引导令牌通过 → 首个注册者成为管理员（唯一入口）', () => {
  assert.equal(decideAccess({ ALLOWED_LOGINS: 'a' }, 'a', true, true).admin, 1);
  // 库里有行（isFirst=false）时令牌不再生效，这就是"用完即失效"
  assert.equal(decideAccess({ ALLOWED_LOGINS: 'a' }, 'a', false, true).admin, 0);
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
  /* 必须递归：src 一旦按 features/ 切片，只读一层就等于放行所有子目录（P-032）。
     2026-11-23 实测：`src/_probe/evil.js` 里的裸判定让旧写法 17/17 全绿。 */
  const root = path.join(here, '..');
  const offenders = [];
  for (const { rel, text } of srcEntries(root)) {
    if (rel === 'auth.js') continue; // ownerOrAdmin 的实现点，唯一允许处
    text.split('\n').forEach((line, i) => {
      if (!/(===|!==)/.test(line)) return;
      if (!/\.author_id\b/.test(line)) return;
      if (!/(\.id\b|is_admin)/.test(line)) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `裸判定必须改成 ownerOrAdmin()：\n${offenders.join('\n')}`);

  const byRel = new Map(srcEntries(root).map((e) => [e.rel, e.text]));
  const apiSrc = byRel.get('api.js') || '';
  const idxSrc = byRel.get('index.js') || '';
  assert.ok(apiSrc && idxSrc, 'api.js / index.js 没被扫到，扫描根目录不对');
  assert.ok((apiSrc.match(/ownerOrAdmin\(/g) || []).length >= 5, 'api.js 的 ownerOrAdmin 调用点少于 5 处');
  assert.ok((idxSrc.match(/ownerOrAdmin\(/g) || []).length >= 2, 'index.js 的 SSR 闸门没接 ownerOrAdmin');
});

t('AP-16 审核态只能由 reviewStatusFor() 生成', () => {
  const hits = [];
  for (const { rel, text } of srcEntries(path.join(here, '..'))) {
    if (rel === 'auth.js') continue;
    if (/is_admin\s*\?\s*'approved'/.test(text)) hits.push(rel);
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

/* 元断言：扫描范围本身也要被断言管住。
   AP-15 证明「扫到的文件里没有违规」，但证明不了「该扫的都扫到了」——
   这一条才是 P-032 的根：结构一变，前一条自动变成真空成立。 */
t('AP-18 源文件扫描必须覆盖 src 全部层级（结构重排不许让断言失明）', () => {
  const root = path.join(here, '..');
  const srcDir = path.join(root, 'src');
  const walk = srcFiles(root);
  const native = nativeSrcFiles(root);
  assert.deepEqual(walk, native, 'srcFiles 与原生 recursive 结果不一致，walk 漏了目录');
  assert.ok(native.length >= 20, `只扫到 ${native.length} 个源文件，根目录或过滤条件可疑`);

  /* 每个**产品**子目录里都必须至少有一个 .js 进了扫描结果。
     当前 src 是扁平的，这条空转；等哪天拆成 features/，它会在拆分当天红，
     而不是等到某个子目录里的裸判定上线之后。
     非产品目录（测试/夹具）本来就该被排除，不参与这条 —— 否则 P-034 的误报会倒灌回来。 */
  const subs = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !NON_PRODUCT_DIRS.has(e.name))
    .map((e) => e.name);
  for (const d of subs) {
    assert.ok(
      native.some((x) => x.startsWith(d + '/')),
      `src/${d}/ 下的 .js 一个都没进扫描结果，子目录会被断言整体忽略`
    );
  }
});

/* 元断言（P-034 的另一半）：排除测试目录让断言不再误报，
   但也让 `src/__tests__/` 成了扫描盲区。只要产品文件 import 了盲区里的东西，
   那段代码就在线上跑，而四条扫描断言一条都看不到它。
   光「排除」是不够的，必须同时守「没人把产品代码塞进去 / 从里面引出来」。 */
t('AP-19 产品代码不许 import 非产品目录（排除测试目录不能变成盲区）', () => {
  const leaks = nonProductLeaks(path.join(here, '..'));
  assert.deepEqual(leaks, [], `产品代码引到了测试/夹具目录：\n${leaks.join('\n')}`);
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
