#!/usr/bin/env node
/**
 * 系列简介（P-121）：settings 里的一条 JSON，贯穿存储 / API / 渲染 / 后台四处。
 *
 * 为什么认真测：这一族的两端都是「看起来有值」——
 *   · 写进去但读缓存没失效 → 后台提示保存成功，页面还是旧简介，5 分钟后才变；
 *   · 简介漏了 esc() → 页面照常显示，XSS 藏在 page-sub 里；
 *   · 后台把系列名写进 JSON 但库里没有 → 永远读不到，库里越攒越多。
 * 所以存储层用 node:sqlite 真跑，渲染/路由用行首锚定 + 唯一计数锁接线。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeSeriesName,
  normalizeSeriesSummary,
  parseSeriesMeta,
  getSeriesMeta,
  setSeriesSummary,
  invalidateSeriesMeta,
  MAX_SUMMARY,
} from '../src/series-meta.js';
import { report } from './pitfall-check.mjs';

const apiSrc = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
const idxSrc = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../public/editor.html', import.meta.url), 'utf8');
const lines = (s) => s.split('\n');
const hits = (s, re) => lines(s).filter((l) => re.test(l)).length;

const cases = [];
const t = (name, fn, id = '') => cases.push([name, fn, id]);

/* ---------- 纯函数：写入口径与 posts.series 必须同源 ---------- */

t('系列名 trim + 控字符 + 40 字，与 posts.series 同口径', async () => {
  assert.equal(normalizeSeriesName('  OAuth 授权流程拆解  '), 'OAuth 授权流程拆解');
  assert.equal(normalizeSeriesName('A\u0000B\nC'), 'A B C');
  assert.equal(normalizeSeriesName('x'.repeat(50)).length, 40);
});

t('简介去控制字符、截到 120 字，不在这里做 HTML 转义', async () => {
  assert.equal(normalizeSeriesSummary(' 一句话 \r\n 说明 '), '一句话    说明');
  assert.equal(normalizeSeriesSummary('x'.repeat(200)).length, MAX_SUMMARY);
  assert.equal(normalizeSeriesSummary('<b>原文</b>'), '<b>原文</b>', '写入层转义会让库里存 HTML 而不是原文');
});

t('坏 JSON / 数组 / 非字符串值都不会进渲染', async () => {
  assert.deepEqual(parseSeriesMeta('{oops'), {});
  assert.deepEqual(parseSeriesMeta('[]'), {});
  assert.deepEqual(parseSeriesMeta('null'), {});
  assert.deepEqual(parseSeriesMeta('{"A":2,"B":{"x":1},"C":"  ok  "}'), { C: 'ok' });
});

/* ---------- 内存库真跑：D1 的最小适配器 ---------- */

function d1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      const args = [];
      return {
        bind(...xs) { args.push(...xs); return this; },
        async first() { return st.get(...args) || null; },
        async all() { return { results: st.all(...args) }; },
        async run() { st.run(...args); return { meta: { changes: 1 } }; },
      };
    },
  };
}

function fresh(seriesNames) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
  db.exec('CREATE TABLE posts (series TEXT NOT NULL DEFAULT "")');
  for (const n of seriesNames) db.exec(`INSERT INTO posts (series) VALUES ('${n.replace(/'/g, "''")}')`);
  invalidateSeriesMeta();
  return { db, env: { DB: d1(db) } };
}

const rawMeta = (db) => db.prepare("SELECT value FROM settings WHERE key = 'series_meta'").get()?.value || '';

t('写一条 → 库里落 JSON → 读回同一句（不是空表）', async () => {
  const { db, env } = fresh(['认证边界']);
  const out = await setSeriesSummary(env, '认证边界', ' 把 token、会话与撤销的边界一次讲清 ');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(JSON.parse(rawMeta(db)), { 认证边界: '把 token、会话与撤销的边界一次讲清' });
  assert.deepEqual(await getSeriesMeta(env), { 认证边界: '把 token、会话与撤销的边界一次讲清' });
});

t('保存即生效：写完不清缓存就等于白改（这条守 30s TTL 漏清）', async () => {
  const { env } = fresh(['认证边界']);
  assert.deepEqual(await getSeriesMeta(env), {});
  await setSeriesSummary(env, '认证边界', '第一版');
  assert.equal((await getSeriesMeta(env))['认证边界'], '第一版');
  await setSeriesSummary(env, '认证边界', '第二版');
  assert.equal((await getSeriesMeta(env))['认证边界'], '第二版', '缓存没失效，后台会提示成功但页面继续显示第一版');
});

t('库里不存在的系列名拒写，且不往 JSON 里留垃圾键', async () => {
  const { db, env } = fresh(['认证边界']);
  const out = await setSeriesSummary(env, '临摹边界', '冒充');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unknown-series');
  assert.equal(rawMeta(db), '');
});

t('空简介删键而不是留空串；改名/删空后的死键自动收掉', async () => {
  const { db, env } = fresh(['认证边界', 'OAuth 授权流程拆解']);
  await setSeriesSummary(env, '认证边界', 'A');
  await setSeriesSummary(env, 'OAuth 授权流程拆解', 'B');
  // 模拟文章改名：库里已没有「认证边界」，下一次保存要顺手清掉它的简介
  db.exec("DELETE FROM posts WHERE series = '认证边界'");
  await setSeriesSummary(env, 'OAuth 授权流程拆解', '');
  assert.deepEqual(JSON.parse(rawMeta(db)), {}, '空串与死系列都要从 JSON 里消失');
});

t('超过 120 字拒写，写入前不落库', async () => {
  const { db, env } = fresh(['认证边界']);
  const out = await setSeriesSummary(env, '认证边界', 'x'.repeat(121));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'too-long');
  assert.equal(rawMeta(db), '');
});

t('坏 JSON 不会把系列页带成 500', async () => {
  const { db, env } = fresh(['认证边界']);
  db.exec("INSERT INTO settings (key, value) VALUES ('series_meta', '{not json')");
  invalidateSeriesMeta();
  assert.deepEqual(await getSeriesMeta(env), {});
});

/* ---------- API 接线：鉴权 / 缓存 / 公开回填 ---------- */

const putAt = apiSrc.indexOf("  if (path === '/series/meta' && method === 'PUT') {");
const put = putAt < 0 ? '' : apiSrc.slice(putAt, apiSrc.indexOf('\n  }', putAt) + 4);
const getSeriesAt = apiSrc.indexOf("  if (path === '/series' && method === 'GET') {");
const getSeries = getSeriesAt < 0 ? '' : apiSrc.slice(getSeriesAt, apiSrc.indexOf('\n  }', getSeriesAt) + 4);

t('PUT 端点在且只在管理员分支，鉴权早于读请求体', async () => {
  assert.equal(hits(apiSrc, /^  if \(path === '\/series\/meta' && method === 'PUT'\) \{$/), 1);
  assert.ok(put.length > 200, '没找到 PUT 分支');
  assert.match(put, /requireAdmin\(env, request\)/);
  assert.ok(put.indexOf('requireAdmin') < put.indexOf('readBody'), '鉴权必须在读请求体之前');
  assert.ok(!/requireUser\(/.test(put), '普通登录用户不能写站点级简介');
});

t('写成功走 waitUntil(bust)，进程内缓存由存储层自己清', async () => {
  assert.match(put, /ctx\.waitUntil\(bust\(url, \[\], \[\], db\)/);
  assert.match(apiSrc, /^import \{ getSeriesMeta, setSeriesSummary, MAX_SUMMARY \} from '\.\/series-meta\.js';$/m);
  const metaSrc = readFileSync(new URL('../src/series-meta.js', import.meta.url), 'utf8');
  assert.equal(hits(metaSrc, /^const KEY = 'series_meta';$/), 1, '键名只能定义一次');
});

t('公开 /api/series 带回 intro，后台不必再开鉴权 GET', async () => {
  assert.ok(getSeries.length > 200, '没找到 GET /series 分支');
  assert.match(getSeries, /const meta = await getSeriesMeta\(env\)/);
  assert.match(getSeries, /intro: meta\[r\.name\] \|\| ''/);
});

/* ---------- 渲染四处：meta / og 由 seriesShell 共用 desc，sub 与 LD 各自一处 ---------- */

const seriesPageAt = idxSrc.indexOf('async function serveSeriesPage(');
const seriesPage = seriesPageAt < 0 ? '' : idxSrc.slice(seriesPageAt, idxSrc.indexOf('\nasync function serveSeriesIndex(', seriesPageAt));
const seriesIndexAt = idxSrc.indexOf('async function serveSeriesIndex(');
const seriesIndex = seriesIndexAt < 0 ? '' : idxSrc.slice(seriesIndexAt, idxSrc.indexOf('\nasync function ', seriesIndexAt + 10));

t('系列页读出简介，LD 补 description，空值不带该字段', async () => {
  assert.match(seriesPage, /const meta = await getSeriesMeta\(env\)/);
  assert.match(seriesPage, /const intro = String\(meta\[name\] \|\| ''\)\.trim\(\)/);
  assert.match(seriesPage, /\.\.\.\(intro \? \{ description: intro \} : \{\}\)/);
});

t('meta description 与页面抬头都吃简介，抬头必须 esc 且保留空值回退', async () => {
  assert.match(seriesPage, /desc: intro\s*\n\s*\? `\$\{intro\}\｜\$\{name\} 共 \$\{results\.length\} 篇`/);
  assert.match(seriesPage, /sub: intro \? esc\(intro\) : `共 \$\{results\.length\} 篇/);
  assert.ok(!/sub: intro \? intro :/.test(seriesPage), 'page-sub 漏了 esc，简介里的 <img onerror> 会执行');
});

t('/series 索引带简介行，空简介不渲染空节点', async () => {
  assert.match(seriesIndex, /const meta = await getSeriesMeta\(env\)/);
  assert.match(seriesIndex, /const sub = intro \? `<span class="sp-x">\$\{esc\(intro\)\}<\/span>` : ''/);
  assert.match(seriesIndex, /<span class="sp-main"><span class="sp-t">/);
});

/* ---------- 后台：只给管理员编辑，防「普通作者点了 403」 ---------- */

t('系列面板拆成两块，原误导文案消失', async () => {
  assert.ok(!editor.includes('<span>只对当前这篇文章生效</span>'), '面板说明还写着只对本篇生效');
  assert.ok(editor.includes('id="series-intros"'), '缺简介编辑容器');
  assert.match(editor, /上半：这篇文章属于哪个系列 · 下半：系列简介（管理员）/);
});

t('简介框只给管理员渲染，保存走 PUT /api/series/meta', async () => {
  assert.match(editor, /const canEdit = !!\(user && user\.is_admin\)/);
  assert.match(editor, /box\.hidden = !canEdit \|\| !\(series \|\| \[\]\)\.length/);
  assert.match(editor, /data-series-intro=/);
  assert.match(editor, /api\('\/api\/series\/meta', \{ method: 'PUT', body: \{ name, summary: input\.value \} \}\)/);
  assert.match(editor, /input\.value = r\.summary \|\| ''/, '保存后用规范化结果回填输入框');
});

t('写接口鉴权之外的路径不出现第二处 series_meta 字面量', async () => {
  const allApi = hits(apiSrc, /series_meta/);
  assert.equal(allApi, 0, 'api.js 里不该出现 JSON 键字面量，统一走 series-meta.js');
});

let pass = 0;
const fails = [];
for (const [name, fn, id] of cases) {
  try {
    await fn();
    pass++;
    report(id, name, true);
  } catch (e) {
    fails.push(name);
    report(id, name, false, e.message);
  }
}
console.log(`\n${pass}/${cases.length} passed`);
if (fails.length) process.exitCode = 1;
