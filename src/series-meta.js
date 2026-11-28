/* 系列简介：6 个系列的一句话说明。
 *
 * 系列不是一张表 —— 它是 posts.series 这个自由文本字段 GROUP BY 出来的派生实体。
 * 为 6 个字符串建一张主键表 + CRUD + 孤儿行治理，成本远大于它承载的信息量；
 * 但简介又确实得有地方放，而且得能在后台改完立即生效（改代码 = 发版）。
 * 所以这里用 settings 表里的一条 JSON：key='series_meta'，值 {"系列名":"简介"}。
 *
 * 三条纪律：
 *   ① 读走 30s 进程内缓存，写**直读 DB** 再写回 —— 走缓存读会拿旧值覆盖刚改的简介；
 *   ② 写的时候顺手删掉库里已经不存在的系列键（改名、删空都会留下死条目）；
 *   ③ 解析失败一律返回空对象，不让一条坏 JSON 把系列页 500 掉。
 * 名字与 posts.series 的写入口径保持一致（trim + 40 字），否则永远对不上。
 */

const KEY = 'series_meta';
const TTL = 30_000;
export const MAX_SUMMARY = 120;

let cache = { at: 0, val: null };

export function invalidateSeriesMeta() {
  cache = { at: 0, val: null };
}

/** 与 api.js 的 seriesOf() 同口径：改名时只改一处会静默对不上。 */
export function normalizeSeriesName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 40);
}

/** 简介是单行展示位：控制字符抹掉，不留换行把列表行撑开。标签不在这里过滤，
 *  出口统一 esc() —— 在写入层做转义会让 JSON 里存的是 HTML 而不是原文。 */
export function normalizeSeriesSummary(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_SUMMARY);
}

/** 只认普通对象的字符串值。数组、数字、嵌套对象一律丢弃 —— 渲染侧只接字符串。 */
export function parseSeriesMeta(raw) {
  if (!raw) return {};
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const name = normalizeSeriesName(k);
    const summary = typeof v === 'string' ? normalizeSeriesSummary(v) : '';
    if (name && summary) out[name] = summary;
  }
  return out;
}

/** 进程内缓存与 settings.js 同款：库抖动就退回上一版/空表，不让页面 500。 */
export async function getSeriesMeta(env) {
  const now = Date.now();
  if (cache.val && now - cache.at < TTL) return cache.val;
  let val = {};
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first();
    val = parseSeriesMeta(row && row.value);
  } catch {
    val = {};
  }
  cache = { at: now, val };
  return val;
}

/**
 * 写一条简介。返回 { ok, summary } 或 { ok:false, reason }。
 * 名字必须已经出现在 posts.series 里 —— 否则往 JSON 里灌垃圾键，
 * 页面上永远读不到，还会在库里越攒越多。
 */
export async function setSeriesSummary(env, name0, summary0) {
  const name = normalizeSeriesName(name0);
  const summary = normalizeSeriesSummary(summary0);
  if (!name) return { ok: false, reason: 'empty-name' };
  if (summary0 != null && String(summary0).length > MAX_SUMMARY) {
    return { ok: false, reason: 'too-long' };
  }

  let row;
  let names;
  try {
    [row, names] = await Promise.all([
      env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first(),
      env.DB.prepare("SELECT DISTINCT series FROM posts WHERE TRIM(COALESCE(series, '')) != ''").all(),
    ]);
  } catch {
    return { ok: false, reason: 'db' };
  }

  const live = new Set((names.results || []).map((r) => normalizeSeriesName(r.series)));
  if (!live.has(name)) return { ok: false, reason: 'unknown-series' };

  const meta = parseSeriesMeta(row && row.value);
  // 已改名/删空的系列键在这里一次性收掉；不靠读侧永远带着它们
  for (const k of Object.keys(meta)) if (!live.has(k)) delete meta[k];
  if (summary) meta[name] = summary;
  else delete meta[name];

  const value = JSON.stringify(meta);
  if (value.length > 8000) return { ok: false, reason: 'too-many' };
  try {
    await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
      .bind(KEY, value)
      .run();
  } catch {
    return { ok: false, reason: 'db' };
  }
  invalidateSeriesMeta();
  return { ok: true, name, summary };
}
