#!/usr/bin/env node
/**
 * 查询参数的值域边界（QP-01~05，[P-035]）。
 *
 * 为什么单独一组：分页参数看着是最无害的输入 —— 一个数字，读出来乘一下，
 * 绑进 SQL 的 LIMIT/OFFSET。但它有两条边界，漏掉任何一条都不是「显示不对」，
 * 而是「整个列表页静默变成骨架屏」：
 *
 *   1. 上界：parseInt('999999999999999999999') 得到 1e21，offset 变成 1e22，
 *      溢出 int64。SQLite 报 `datatype mismatch`，D1 同样报错。SSR 的 catch
 *      把它兜成 data: null，页面渲染 SKELETON —— 200 状态、永远「加载中」，
 *      读者以为慢、爬虫抓到一张空页，日志里只有一行 console.error。
 *   2. 单点：这段解析原先在 utils.pageParams 与 index.listParams 各写一遍，
 *      只夹下界。两处实现 = 修一处漏一处。
 *
 * 判据分两层：能测行为就测行为（直接调 pageParams 看返回值），
 * 只有「有没有第二处自己解析」这种结构性质才退回源码扫描。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageParams, MAX_PAGE } from '../src/utils.js';
import { srcEntries } from './lib/src-walk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let bad = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`pass  ${name}`);
  } catch (e) {
    bad++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

/** 造一个只带 search 的假对象，pageParams 只用到 searchParams。 */
const q = (search) => ({ searchParams: new URLSearchParams(search) });

t('QP-01 超大 page 的 offset 必须是安全整数（int64 溢出会让列表静默变骨架屏）', () => {
  const huge = ['999999999999999999999', '1e21', '9007199254740993', String(Number.MAX_SAFE_INTEGER)];
  for (const v of huge) {
    const { page, size, offset } = pageParams(q(`page=${v}`), 10);
    assert.ok(page <= MAX_PAGE, `page=${v} 没被夹住，得到 ${page}`);
    assert.ok(Number.isSafeInteger(offset), `page=${v} 的 offset=${offset} 不是安全整数`);
    assert.ok(offset < 2 ** 53, `page=${v} 的 offset=${offset} 超过 2^53`);
    assert.ok(size >= 1 && size <= 50, `size=${size} 越界`);
  }
});

t('QP-02 负数 / 非数字 / 空值一律回落第 1 页', () => {
  for (const v of ['-1', '-999999999', 'abc', '', '0', 'null', 'Infinity']) {
    const { page, offset } = pageParams(q(`page=${v}`));
    assert.equal(page, 1, `page=${v} 应回落 1，实际 ${page}`);
    assert.equal(offset, 0, `page=${v} 的 offset 应为 0`);
  }
});

t('QP-03 size 上下界（上界 50：不夹就等于一次把整表读进 isolate）', () => {
  assert.equal(pageParams(q('size=100000')).size, 50, 'size 上界没夹住');
  assert.equal(pageParams(q('size=0')).size, 1, 'size 下界没夹住');
  assert.equal(pageParams(q('size=-5')).size, 1, '负数 size 没回落');
  assert.equal(pageParams(q('')).size, 10, '缺省 size 应为 10');
});

t('QP-04 MAX_PAGE × 最大 size 本身不能越界（防有人把常量调到 1e15）', () => {
  const worst = (MAX_PAGE - 1) * 50;
  assert.ok(Number.isSafeInteger(worst), `MAX_PAGE=${MAX_PAGE} 时最坏 offset=${worst} 已越界`);
});

t('QP-05 page 只许在 utils.js 解析一次（两处实现 = 修一处漏一处）', () => {
  const offenders = [];
  for (const { rel, text } of srcEntries(path.join(here, '..'))) {
    if (rel === 'utils.js') continue; // pageParams 的实现点，唯一允许处
    text.split('\n').forEach((line, i) => {
      /* 只认「从 searchParams 里取 page 再转数字」这个形状。
         注释里提到 `?page=` 不算 —— 裸词匹配会把解释它的话判成违规（P-030 同族）。 */
      if (!/searchParams\.get\(\s*['"]page['"]\s*\)/.test(line)) return;
      if (!/parseInt|Number\(|Math\./.test(line)) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `page 又被自己解析了，应改用 pageParams()：\n${offenders.join('\n')}`);
});

/* QP-06 / QP-07 / QP-08 是 [P-042] 与 [P-050] 的离线一半：线上由 check-live
   打真地址，这里守「那条规则还在代码里」。删掉分支、把 canonical 改回
   「照抄 page」，都会在这里先红 —— 不用等部署。

   QP-07 从源码扫描改成了行为测试：规则抽成 canonicalOf() 之后，
   直接喂 URL 看返回值比匹配正则可靠得多（正则版本曾经因为一次重构就假红）。 */
const idx = () => srcEntries(path.join(here, '..')).find((f) => f.rel === 'index.js').text;

t('QP-06 越界页码落到 404，而不是 200 的空列表', () => {
  const s = idx();
  assert.match(s, /list\.total > 0 && list\.page > list\.pages/, '越界判定没了，页码会被当空列表现出去');
  assert.match(s, /notFoundPage\(env, null, '这一页没有文章'\)/, '判定在，但没有真的返回 404');
});

const { canonicalOf } = await import('../src/index.js');
const at = (p) => canonicalOf(new URL(p, 'https://exia.de5.net'));

t('QP-07 canonical 只给真分页的路径保留页码，其余 query 一律丢', () => {
  assert.equal(at('/'), 'https://exia.de5.net/');
  assert.equal(at('/?cb=zz1'), 'https://exia.de5.net/', '缓存穿透参数不该造出新的规范地址');
  assert.equal(at('/?utm_source=x'), 'https://exia.de5.net/', 'utm 不该进 canonical');
  assert.equal(at('/?page=1'), 'https://exia.de5.net/', 'page=1 与首页内容逐字相同');
  assert.equal(at('/?page=2'), 'https://exia.de5.net/?page=2', '真分页必须保留页码');
  assert.equal(at('/?page=2&foo=bar'), 'https://exia.de5.net/?page=2', '混进来的其它参数要丢掉');
  assert.equal(at('/?page=abc'), 'https://exia.de5.net/', '非数字页码按第 1 页处理');
  assert.equal(at('/archive?page=9'), 'https://exia.de5.net/archive', '归档页不分页，page 不参与');
  assert.equal(at('/tag/cloudflare?page=2&foo=1'), 'https://exia.de5.net/tag/cloudflare?page=2');
});

t('QP-08 JSON-LD 的 @id 用同一个 canonicalOf，不能照抄原始 URL', () => {
  const s = idx();
  /* 这条守的是「同一份内容只有一个身份」：canonical 归一了、@id 没归一的话，
     /?cb=x 与 / 在结构化数据里仍是两个实体，Search Console 会当重复页。 */
  assert.ok(!/url:\s*url\.toString\(\)/.test(s), 'listLd 又开始把原始 URL 塞进 @id');
  assert.match(s, /url:\s*canonicalOf\(url\)/, 'listLd 的 @id 没走 canonicalOf');
});

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
