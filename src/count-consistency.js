/* 篇数口径对账：把每个出口的单个数抽出来，判断是否同一个数。
 *
 * 七个出口共用一个「已发布」闸门（is_private=0 + hidden=0 + 时间到 + approved）：
 *   /api/posts 的 total、/api/categories 的四栏合计 + 未归类、sitemap 的 /p/ 条数、
 *   RSS 的 <item> 数、首页与归档的「共 N 篇」、栏目页的「N 个栏目 · N 篇」。
 * 任何一处自己改了口径，读者会看到同一篇数两个值——这类漂移不会报错、不会被
 * 浏览器发现，只能靠跨出口对账抓。
 *
 * 纯函数：不 fetch、不读文件。联网那层在 scripts/check-counts-live.mjs，
 * 离线注入验证在 scripts/test-count-consistency.mjs。
 */

export const COUNT_SOURCES = [
  'api', 'categories', 'sitemap', 'rss', 'home', 'archive', 'categoriesPage',
];

/** 从单个出口的原始响应里抽出篇数；抽不到返回 NaN，不猜、不兜底。 */
export function extractPostCount(source, raw) {
  const text = String(raw ?? '');
  switch (source) {
    case 'api': {
      try { return Number(JSON.parse(text).total); }
      catch { return NaN; }   // 响应坏了算「抽不到」，不能让整个体检抛栈退出
    }
    case 'categories': {
      let j;
      try { j = JSON.parse(text); }
      catch { return NaN; }
      const summed = (j.categories || []).reduce((a, c) => a + (Number(c.count) || 0), 0);
      // 未归类文章不在四个栏目格子里，但仍是公开文章——漏掉它就会和 API total 差一截。
      return summed + (Number(j.uncategorized) || 0);
    }
    case 'sitemap':
      // 错误页里也数不到 /p/，但那是「抽不到」不是「0 篇」——根元素先验一次。
      if (!/<urlset\b/.test(text)) return NaN;
      return [...text.matchAll(/<loc>[^<]*\/p\/[^<]+<\/loc>/g)].length;
    case 'rss':
      if (!/<rss\b/.test(text)) return NaN;
      return (text.match(/<item>/g) || []).length;
    case 'home':
    case 'archive': {
      const m = text.match(/共\s*(?:<b>)?\s*(\d+)\s*(?:<\/b>)?\s*篇/);
      return m ? Number(m[1]) : NaN;
    }
    case 'categoriesPage': {
      const m = text.match(/(\d+)\s*个栏目\s*·\s*(\d+)\s*篇/);
      return m ? Number(m[2]) : NaN;
    }
    default:
      throw new Error(`未知出口：${source}`);
  }
}

/**
 * 栏目页合计文案。四个格子只装已归类的文章，未归类的公开文章不在任何格子里 ——
 * 合计必须把它们算进去，并显式说明差从哪来，否则「格子加起来 ≠ 合计」又是一处
 * 页面自己解释不了的差。SSR 与客户端共用这一份，客户端直接消费 API 返回的 totalText。
 */
export function catTotalText(catCount, summed, uncategorized) {
  const total = summed + uncategorized;
  const base = `${catCount} 个栏目 · ${total} 篇`;
  return uncategorized > 0 ? `${base}（含 ${uncategorized} 篇未归类）` : base;
}

/**
 * 对账结果：values 每个出口的数，bad 抽不到数的出口，consistent 是否全等。
 * 空集恒真是假绿形态之一——这里先要求七处都抽到整数，再判相等。
 */
export function reconcileCounts(rawBySource) {
  const values = {};
  const bad = [];
  for (const s of COUNT_SOURCES) {
    const n = extractPostCount(s, rawBySource?.[s]);
    values[s] = n;
    if (!Number.isInteger(n) || n < 0) bad.push(s);
  }
  const distinct = [...new Set(COUNT_SOURCES.map((s) => values[s]))];
  return {
    values,
    bad,
    distinct,
    consistent: bad.length === 0 && distinct.length === 1,
  };
}
