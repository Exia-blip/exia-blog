#!/usr/bin/env node
/**
 * 变体判据与缓存策略的回归。
 *
 * 两条都是「不报错但结果错」的类型：
 *   1. 只看状态码 → 把回退的原图当成变体，体检显示「齐全」，实际每次多传几百 KB
 *   2. 回退响应也发 immutable 一年 → 补传变体后同一个 URL 继续吐原图，且没有任何提示
 */
import { readFileSync } from 'node:fs';
import { variantOk, expectedType, whyNotVariant, originOk } from './img-type.mjs';
import { imgCacheControl } from '../src/index.js';

let pass = 0;
const fails = [];
const t = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const res = (status, type) => ({ status, type, ok: status === 200 });

/* ---- 判据：Content-Type 必须是自己的 MIME ---- */
t(expectedType('webp') === 'image/webp', 'webp 的期望类型是 image/webp');
t(expectedType('AVIF') === 'image/avif', '扩展名大小写不影响判断');
t(expectedType('png') === '', '未知扩展名没有期望类型');

t(variantOk(res(200, 'image/webp'), 'webp') === true, '真正的 webp 变体算命中');
t(variantOk(res(200, 'image/avif'), 'avif') === true, '真正的 avif 变体算命中');
t(variantOk(res(200, 'image/webp; charset=binary'), 'webp') === true, 'Content-Type 带参数也算命中');

/* 这条是本次修复的核心：回退的原图同样是 200 */
t(variantOk(res(200, 'image/jpeg'), 'webp') === false, '200 但回的是原图 JPEG → 不算变体（旧版会误判为齐全）');
t(variantOk(res(200, 'image/png'), 'avif') === false, '200 但回的是原图 PNG → 不算 avif');
t(variantOk(res(200, 'image/webp'), 'avif') === false, 'avif 位回退成 webp 也不算 avif 命中');
t(variantOk(res(404, ''), 'webp') === false, '404 不算命中');
t(variantOk(res(200, ''), 'webp') === false, '没有 Content-Type 不算命中（宁可多转一次）');
t(variantOk(null, 'webp') === false, '没有响应不算命中');

t(/回的是 image\/jpeg/.test(whyNotVariant(res(200, 'image/jpeg'), 'webp')), '失败原因说清楚「回的是原图」');
t(/HTTP 404/.test(whyNotVariant(res(404, ''), 'webp')), '404 的原因说清状态码');

/* ---- 原图存在性：占位响应也是 200 ---- */
t(originOk({ status: 200, phantom: false }) === true, '真图算存在');
t(originOk({ status: 200, phantom: true }) === false, '占位图不算存在（x-img-missing）');
t(originOk({ status: 404, phantom: false }) === false, '404 不算存在');
t(originOk(null) === false, '没有响应不算存在');

/* ---- 缓存：回退不能发 immutable ---- */
const okCache = imgCacheControl();
const fbCache = imgCacheControl('webp-missing-served-original');
t(/immutable/.test(okCache), '正常命中锁一年');
t(!/immutable/.test(fbCache), '回退响应不带 immutable（否则补传后边缘仍吐原图）');
const maxAge = Number((fbCache.match(/max-age=(\d+)/) || [])[1] || 0);
t(maxAge > 0 && maxAge <= 600, `回退缓存时长足够短（${maxAge}s）`);

/* ---- 本地模式：D1 与 R2 必须同源切到 local ----
   只改其中一处会「读本地文章、写线上桶」（或反过来），而且不会报错：
   线上体检照绿，本地变体永远补不上。这里读源码而不是跑一次网络，
   是因为那两种错的行为在成功路径上长得一模一样。 */
const mv = readFileSync(new URL('./make-variants.mjs', import.meta.url), 'utf8');
const hasLocal = /const local = process\.argv\.includes\('--local'\);/.test(mv);
const scopeDecl = /const SCOPE = local \? '--local' : '--remote';/.test(mv);
const scopeUses = [...mv.matchAll(/\bSCOPE\b/g)].length;
t(hasLocal && scopeDecl && scopeUses === 3, `本地模式 D1/R2 共用一个 SCOPE（实际 ${scopeUses} 处）`);
t((mv.match(/if \(local\) return;/g) || []).length === 1, '本地模式跳过 CDN 清缓存');
t(/local \? 'http:\/\/127\.0\.0\.1:8787'/.test(mv), '本地模式默认探测本地 dev server');

/* 夹具有写权限，写错地方比没写更糟：remoteRows() 读线上是允许的，
   但 r2 put / d1 execute 的落地路径必须是本地。只看「跑通了」抓不到这类错。 */
const seed = readFileSync(new URL('./seed-live-fixtures.mjs', import.meta.url), 'utf8');
const putLine = (seed.match(/run\(\['r2', 'object', 'put'[^\n]*/) || [''])[0];
const localD1 = (seed.match(/run\(\['d1', 'execute', 'blog-db', '--local'[^\n]*/) || [''])[0];
t(putLine.includes("'--local'") && !putLine.includes("'--remote'"), '夹具原图只写本地 R2');
t(!!localD1 && !/--remote/.test(localD1), '夹具文章只写本地 D1');

console.log(`\n变体判据: ${pass} 通过${fails.length ? `，${fails.length} 失败` : ''}`);
if (fails.length) process.exit(1);
