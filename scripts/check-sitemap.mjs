#!/usr/bin/env node
/**
 * sitemap 体检。
 *
 * 为什么单独有这一个脚本：sitemap 坏掉是「静默」的 —— 少一个 <lastmod>、
 * 多一个未来日期、重复一条 <loc>，浏览器和页面全都正常，只有爬虫那边慢慢失聪：
 * 没有 lastmod 的 URL 会按「从不更新」对待，未来日期会被判成无效 feed。
 *
 *   node scripts/check-sitemap.mjs https://miu.sryze.cc
 */
const base = (process.argv[2] || 'https://miu.sryze.cc').replace(/\/$/, '');
let pass = 0;
const fails = [];
const t = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const res = await fetch(`${base}/sitemap.xml?t=${Date.now()}`);
const xml = await res.text();
t(res.ok, `GET /sitemap.xml → ${res.status}`);
t(/^<\?xml/.test(xml.trim()), '开头是 XML 声明');
t(/<urlset[^>]+sitemaps\.org\/schemas\/sitemap\/0\.9/.test(xml), '根节点是 urlset 0.9 命名空间');
t((xml.match(/<url>/g) || []).length === (xml.match(/<\/url>/g) || []).length, '<url> 与 </url> 数量一致');

const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
t(urls.length > 0, `解析出 ${urls.length} 条 URL`);

const locs = urls.map((u) => (u.match(/<loc>([\s\S]*?)<\/loc>/) || [])[1] || '').map((s) => s.replace(/<[^>]*>/g, '').trim());
const lasts = urls.map((u) => ((u.match(/<lastmod>([\s\S]*?)<\/lastmod>/) || [])[1] || '').trim());

const noLast = urls.filter((u, i) => !lasts[i]).length;
t(noLast === 0, '每条 URL 都带 <lastmod>，没有「从不更新」的条目', noLast ? `${noLast} 条缺失：${locs[lasts.indexOf('')]}` : '');

const bad = lasts.filter((d) => d && !/^\d{4}-\d{2}-\d{2}$/.test(d));
t(bad.length === 0, 'lastmod 都是 YYYY-MM-DD', bad.slice(0, 3).join(','));

const today = new Date();
const tomorrow = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
const future = lasts.filter((d) => d && d > tomorrow);
t(future.length === 0, '没有未来日期的 lastmod（预排文章的 updated_at 会顶到未来）', future.slice(0, 3).join(','));

const dup = locs.filter((l, i) => locs.indexOf(l) !== i);
t(dup.length === 0, '没有重复的 <loc>', dup.slice(0, 3).join(','));

/* [P-043] lastmod 与页面里的 datePublished 必须自洽。
   排期稿的通病：11 月写完、1 月才发，lastmod 取 updated_at 就早于发布日 ——
   sitemap 和结构化数据互相打脸，Google 会认为这套时间信号不可信。
   抽最新三篇（排在最前面的最可能刚被排期改动过）。 */
{
  const picks = locs.filter((l) => l.includes('/p/')).slice(0, 3);
  const bad = [];
  for (const l of picks) {
    const i = locs.indexOf(l);
    let html = '';
    try {
      html = await (await fetch(`${l}?cb=${Date.now()}`)).text();
    } catch (e) {
      bad.push(`${l} 抓不到：${e.message}`);
      continue;
    }
    const dp = (html.match(/"datePublished":"([^"]+)"/) || [])[1] || '';
    if (!dp) {
      bad.push(`${l} 页面里没有 datePublished`);
      continue;
    }
    const day = dp.slice(0, 10);
    if (lasts[i] && lasts[i] < day) bad.push(`${l} lastmod ${lasts[i]} < datePublished ${day}`);
  }
  t(bad.length === 0, `[P-043] 每篇的 lastmod 不早于 datePublished（抽 ${picks.length} 篇）`, bad.slice(0, 3).join('; '));
}

/* [P-048] 日期链：datePublished ≤ sitemap lastmod ≤ RSS pubDate。
   三处各按一种口径时，搜索引擎会把同一篇当成「更新过的旧内容」或「未来内容」，
   这是站内日期矛盾里唯一会被外部系统读到的一种。三者同源（都取
   published_at || created_at），所以任何一处不等都说明有人换了取值口径。
   比较统一换到北京时间再截日期：published_at 是 +08 存的，直接用 UTC
   会让凌晨发的稿子差一天。 */
const rssXml = await (await fetch(`${base}/rss.xml?t=${Date.now()}`)).text();
const rssItems = [...rssXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).slice(0, 3);
const bjDay = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
};
const chainBad = [];
for (const it of rssItems) {
  const link = ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim();
  const pd = ((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim();
  if (!link || !pd) {
    chainBad.push('RSS 条目缺 link 或 pubDate');
    continue;
  }
  const html = await (await fetch(`${link}${link.includes('?') ? '&' : '?'}cb=${Date.now()}`)).text();
  const dp = (html.match(/"datePublished":"([^"]+)"/) || [])[1] || '';
  if (!dp) {
    chainBad.push(`${link} 页面没有 datePublished`);
    continue;
  }
  if (bjDay(dp) !== bjDay(pd)) chainBad.push(`${link} datePublished ${bjDay(dp)} ≠ RSS pubDate ${bjDay(pd)}`);
  const idx = locs.indexOf(link) >= 0 ? locs.indexOf(link) : locs.indexOf(link.replace(/\/$/, ''));
  const lm = idx >= 0 ? lasts[idx] : '';
  if (lm && lm < bjDay(dp)) chainBad.push(`${link} lastmod ${lm} < datePublished ${bjDay(dp)}`);
}
t(chainBad.length === 0, `[P-048] datePublished / lastmod / RSS pubDate 三者不矛盾（抽 ${rssItems.length} 条）`, chainBad.slice(0, 3).join('; '));

// 首页 / 归档 / 标签页是这次要补的那三类，单独点名，缺了能一眼看出来
const need = ['/', '/archive', '/categories'];
const miss = need.filter((p) => !locs.some((l) => l === base + p || l === base + p + '/'));
t(miss.length === 0, '首页 / 归档 / 栏目总览都在列表里', miss.join(','));
const tagCount = locs.filter((l) => l.includes('/tag/')).length;
const tagLast = urls.filter((u, i) => locs[i].includes('/tag/') && lasts[i]).length;
t(tagCount === 0 || tagLast === tagCount, `标签页全部带 lastmod（${tagLast}/${tagCount}）`);

console.log(`\n${pass} 通过，${fails.length} 失败`);
if (fails.length) process.exit(1);
