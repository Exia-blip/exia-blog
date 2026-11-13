#!/usr/bin/env node
/**
 * sitemap 体检。
 *
 * 为什么单独有这一个脚本：sitemap 坏掉是「静默」的 —— 少一个 <lastmod>、
 * 多一个未来日期、重复一条 <loc>，浏览器和页面全都正常，只有爬虫那边慢慢失聪：
 * 没有 lastmod 的 URL 会按「从不更新」对待，未来日期会被判成无效 feed。
 *
 *   node scripts/check-sitemap.mjs https://exia.de5.net
 */
const base = (process.argv[2] || 'https://exia.de5.net').replace(/\/$/, '');
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

// 首页 / 归档 / 标签页是这次要补的那三类，单独点名，缺了能一眼看出来
const need = ['/', '/archive', '/categories'];
const miss = need.filter((p) => !locs.some((l) => l === base + p || l === base + p + '/'));
t(miss.length === 0, '首页 / 归档 / 栏目总览都在列表里', miss.join(','));
const tagCount = locs.filter((l) => l.includes('/tag/')).length;
const tagLast = urls.filter((u, i) => locs[i].includes('/tag/') && lasts[i]).length;
t(tagCount === 0 || tagLast === tagCount, `标签页全部带 lastmod（${tagLast}/${tagCount}）`);

console.log(`\n${pass} 通过，${fails.length} 失败`);
if (fails.length) process.exit(1);
