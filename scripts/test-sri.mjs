#!/usr/bin/env node
/**
 * SRI + 内容哈希 + immutable 的三方一致性守卫。
 *
 * 这层最怕的不是「没配」，而是「配错一半」：
 *   - 哈希与文件不同步 → 浏览器把脚本整个丢掉，页面白屏，控制台只有一行
 *     "Failed to find a valid digest in the 'integrity' attribute"
 *   - 版本号与 integrity 来自不同批次 → URL 变了校验值没变，一模一样
 *   - 同源加了 crossorigin → 请求切成 CORS 模式，Worker 不回 AC-AO，同样白屏
 *
 * 所以这里钉的是「四处必须互相自洽」，而不是某一行代码长什么样。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ASSET_HASH } from '../src/assets.gen.js';
import { stampAssets, assetCacheControl } from '../src/assets.js';
import { themeCssTag } from '../src/settings.js';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PUB = join(ROOT, 'public');
let pass = 0;
const fails = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL ${name} — ${e.message.split('\n')[0]}`);
  }
};

/* ---------- 1. manifest 与磁盘同步 ---------- */
t('manifest 非空', () => {
  assert.ok(Object.keys(ASSET_HASH).length >= 8, `实际 ${Object.keys(ASSET_HASH).length} 条`);
});

t('每个条目的 integrity 与磁盘文件真实哈希一致', () => {
  const bad = [];
  for (const [f, h] of Object.entries(ASSET_HASH)) {
    const buf = readFileSync(join(PUB, f));
    const sha = `sha384-${createHash('sha384').update(buf).digest('base64')}`;
    if (sha !== h.i) bad.push(f);
  }
  assert.deepEqual(bad, [], `不同步：${bad.join('、')}（跑 npm run build:sri）`);
});

t('每个条目的 ?v= 与 integrity 同源（同一份字节）', () => {
  for (const [f, h] of Object.entries(ASSET_HASH)) {
    const buf = readFileSync(join(PUB, f));
    const v = createHash('sha256').update(buf).digest('hex').slice(0, 10);
    assert.equal(h.v, v, `${f} 版本号不是当前内容算出来的`);
  }
});

t('manifest 收录了所有被页面直接引用的 js/css', () => {
  for (const f of ['style.css', 'app.js', 'boot.js', 'theme.js', 'md.js', 'avatar.js']) {
    assert.ok(ASSET_HASH[f], `${f} 没进 manifest`);
  }
});

t('public 根下没有未收录的 .js/.css', () => {
  const known = new Set(Object.keys(ASSET_HASH));
  for (const name of readdirSync(PUB)) {
    if (/\.(js|css)$/i.test(name)) assert.ok(known.has(name), `${name} 没进 manifest`);
  }
});

/* ---------- 2. stampAssets：URL 与属性 ---------- */
t('给 <link> 挂内容哈希 + integrity', () => {
  const out = stampAssets('<link rel="stylesheet" href="/style.css">', { SITE_VERSION: 'deploy1' });
  const h = ASSET_HASH['style.css'];
  assert.ok(out.includes(`/style.css?v=${h.v}`), out);
  assert.ok(out.includes(`integrity="${h.i}"`), out);
});

t('给 <script> 挂内容哈希 + integrity', () => {
  const out = stampAssets('<script src="/boot.js" defer></script>', {});
  const h = ASSET_HASH['boot.js'];
  assert.ok(out.includes(`/boot.js?v=${h.v}"`), out);
  assert.ok(out.includes(`defer integrity="${h.i}"`), out);
});

t('内容哈希优先于部署版本号（跨部署缓存才有效）', () => {
  const out = stampAssets('<link rel="stylesheet" href="/style.css">', { SITE_VERSION: 'zzz-new-deploy' });
  assert.ok(!out.includes('zzz-new-deploy'), '部署号不该出现');
});

t('manifest 里没有的资源退回部署版本号，且不加 integrity', () => {
  const out = stampAssets('<img src="/thumbs/auto-1.webp">', { SITE_VERSION: 'dep42' });
  assert.ok(out.includes('/thumbs/auto-1.webp?v=dep42'), out);
  assert.ok(!out.includes('integrity='), '没有哈希就不能写校验值');
});

t('同源资源不加 crossorigin（加了会被 CORS 拦死）', () => {
  const out = stampAssets('<script src="/app.js"></script>', {});
  assert.ok(!/crossorigin/i.test(out), out);
});

t('已有 integrity 的标签不重复加', () => {
  const out = stampAssets('<script src="/app.js" integrity="sha384-manual"></script>', {});
  assert.equal((out.match(/integrity=/g) || []).length, 1, out);
  assert.ok(out.includes('sha384-manual'), '手工写的不该被覆盖');
});

t('绝对 URL 的 og:image 不被戳版本号', () => {
  const out = stampAssets('<meta property="og:image" content="https://exia.de5.net/cards/a.png">', {});
  assert.equal(out, '<meta property="og:image" content="https://exia.de5.net/cards/a.png">');
});

t('自闭合 <link /> 也能插', () => {
  const out = stampAssets('<link rel="stylesheet" href="/style.css"/>', {});
  assert.ok(/integrity="sha384-[^"]+"\s*\/>$/.test(out), out);
});

t('主题 CSS 也走哈希 + integrity', () => {
  const out = stampAssets('<link rel="stylesheet" href="/theme/ink.css">', {});
  const h = ASSET_HASH['theme/ink.css'];
  assert.ok(out.includes(`/theme/ink.css?v=${h.v}`), out);
  assert.ok(out.includes(`integrity="${h.i}"`), out);
});

t('themeCssTag 的输出与 manifest 一致', () => {
  const tag = themeCssTag('ocean');
  const h = ASSET_HASH['theme/ocean.css'];
  assert.ok(tag.includes(`?v=${h.v}`), tag);
  assert.ok(tag.includes(h.i), tag);
});

/* ---------- 3. 缓存头 ---------- */
t('带 v 的资源锁一年 immutable', () => {
  assert.match(
    assetCacheControl(new URL('https://x/style.css?v=abc')),
    /max-age=31536000.*immutable/
  );
});

t('不带 v 的资源只给短缓存', () => {
  const cc = assetCacheControl(new URL('https://x/style.css'));
  assert.ok(!/immutable/.test(cc), cc);
  assert.match(cc, /max-age=300/);
});

t('thumbs / cards 无 v 时给一天 + swr', () => {
  assert.match(assetCacheControl(new URL('https://x/thumbs/a.webp')), /max-age=86400/);
  assert.match(assetCacheControl(new URL('https://x/cards/a.png')), /max-age=86400/);
});

t('上游自带缓存头且合理时尊重上游', () => {
  assert.equal(assetCacheControl(new URL('https://x/font.woff2'), 'public, max-age=86400'), 'public, max-age=86400');
});

t('上游 max-age=0 时被抬到短缓存', () => {
  assert.match(assetCacheControl(new URL('https://x/a.js'), 'public, max-age=0'), /max-age=300/);
});

/* 内容哈希对字节敏感，行尾一变哈希就变。仓库里按 .gitattributes 存 LF，
   Windows 工作区若被写回 CRLF，本地 manifest 按 CRLF 算、CI checkout 出 LF，
   结果是「本地绿、CI 红」—— 2026-11-22 在 app.js 上真发生过。
   这条不依赖 build:sri 有没有跑过，直接看磁盘字节。 */
t('参与 SRI 的文件都是 LF 行尾（与仓库索引一致）', () => {
  const offenders = Object.keys(ASSET_HASH).filter((f) =>
    readFileSync(join(PUB, f), 'utf8').includes('\r\n')
  );
  assert.deepEqual(offenders, [], `CRLF：${offenders.join('、')}`);
});

console.log(`\n[P-009] PASS  ${pass} passed, ${fails.length} failed  （SRI / immutable）`);
if (fails.length) {
  console.log(fails.map((f) => '   · ' + f).join('\n'));
  process.exit(1);
}
