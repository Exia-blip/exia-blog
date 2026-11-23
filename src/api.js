import { json, err, pageParams, slugify, uniqueSlug, nowISO, setCookie, localParts, siteOrigin, wordCount } from './utils.js';
import { currentUser, requireUser, requireAdmin } from './auth.js';
import { guard, record, banIp, verifyTurnstile, DID_MAX_AGE } from './antispam.js';
import { renderBody, extractTags, extractCover, extractExcerpt, readingTime, searchSnippet } from '../public/md.js';
import { sanitizeHtml, cleanMarkdown } from './clean.js';
import { coverOf, thumbOf, bodyCoverFor } from './cover.js';
import { bustPaths } from './cache.js';
import { presignPut, makeKey, IMAGE_TYPES } from './s3.js';
import { imageSize, withSize } from './img-size.js';
import { notifyComment, notifyTodo } from './webhook.js';
import { logAudit } from './audit.js';
import { checkFriends } from './cron.js';
import { getSite, setSite, THEME_IDS, MODE_IDS } from './settings.js';
import { refreshSummary, generateSummary, contentHash, hasAI } from './ai.js';
import { recordPv, recordEvent } from './stats.js';
import { postCacheDrop } from './postcache.js';

/* 声明的 MIME 不可信：multipart 里的 file.type 就是客户端随手写的一个字符串，
   直传那条路的 Content-Type 更是完全由浏览器决定。用文件头再认一遍，两者打架时
   以内容为准 —— 不是为了「校验格式」，是为了让 /img/ 出口那句「这是不是 svg、
   要不要上沙箱」有真凭据。认不出来（损坏文件、HTML 冒充图片）就保留声明值，
   出口那边还有一层白名单兜着。 */
const SNIFF_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

function settleType(declared, buf) {
  const sized = imageSize(buf);
  const byContent = sized ? SNIFF_MIME[sized.type] : '';
  if (byContent && byContent !== declared) return { type: byContent, size: sized, corrected: true };
  return { type: declared, size: sized, corrected: false };
}
import {
  CATS,
  TAG_SEED,
  TAG_ALIAS,
  normalizeCat,
  catName,
  normalizeTag,
  normalizeTags,
  isSeedTag,
} from './taxonomy.js';

/* ---------- 小工具 ---------- */

/** 同系列的其它文章：正文里嵌着系列目录，一篇变了全组的 HTML 都变 */
async function seriesSiblingSlugs(db, series) {
  if (!series) return [];
  const { results } = await db.prepare('SELECT slug FROM posts WHERE series = ?').bind(series).all();
  return results.map((r) => r.slug);
}

/* 发布 / 修改 / 删除后主动删掉边缘缓存：不用等 TTL 过期 */
/* 清单里必须有「全部会因文章集合变化而变旧的页面形态」，少一类就等于留一个
   5 分钟窗口：读者看到已删的文章、新文章在标签页里不存在、系列目录漏一篇。
   所以这里不按「这次动了哪几个标签」精确算，而是把 tag / series 全清 ——
   跟下面 postCacheDrop() 同一个理由：几十次 delete 是本地操作，比漏清便宜。 */
async function bust(url, slugs = [], cats = [], db = null) {
  /* 进程内那份一起清。按 slug 精准清是不够的 —— 缓存里除了文章本体，
     还带着「同栏目列表」和「系列目录」，删掉一篇会影响别的文章那一块。
     chunk 只有几十条，全清之后下次 miss 一次就回来了，比漏清安全得多。 */
  postCacheDrop();
  const paths = ['/', '/archive', '/categories', '/series'];
  for (const c of cats.filter(Boolean)) paths.push(`/cat/${encodeURIComponent(c)}`);
  for (const s of slugs.filter(Boolean)) {
    paths.push(`/p/${encodeURIComponent(s)}`, `/${encodeURIComponent(s)}`);
  }
  /* tag / series 的清单只能查库拿：缓存 API 没有 list / deletePrefix，
     caches.default 只认具体 URL。查失败就跳过——宁可留 5 分钟旧页面，
     也不能让一次 delete 失败把整个发布响应的 waitUntil 拖成 unhandled rejection。 */
  if (db) {
    try {
      const [ts, ss] = await Promise.all([
        db.prepare('SELECT name FROM tags').all(),
        db.prepare("SELECT DISTINCT series FROM posts WHERE series != ''").all(),
      ]);
      for (const r of ts.results || []) paths.push(`/tag/${encodeURIComponent(r.name)}`);
      for (const r of ss.results || []) paths.push(`/series/${encodeURIComponent(r.series)}`);
    } catch {
      /* 库抖动：留 TTL 兜底 */
    }
  }
  return bustPaths(url.origin, paths);
}

/* 友链页也是 SSR 直出 + 边缘缓存 5 分钟。增删/重检后不清的话，
   对方站长来核对时看到的是上一次的列表——交换场景里等于没加上。 */
function bustFriends(url, ctx) {
  if (!ctx) return;
  ctx.waitUntil(bustPaths(url.origin, ['/friends']).catch(() => {}));
}

export async function attachTags(db, posts) {
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id IN (${ph})`)
    .bind(...ids)
    .all();

  const map = new Map();
  for (const r of results) {
    if (!map.has(r.post_id)) map.set(r.post_id, []);
    map.get(r.post_id).push(r.name);
  }
  for (const p of posts) p.tags = map.get(p.id) || [];
  return posts;
}

/**
 * 客户端指定的定时发布时间。输入是 UTC 的 'YYYY-MM-DD HH:mm:ss'，
 * 前端把北京时间换算好再传过来，服务端只认这一种格式。
 *
 * 返回值区分三种语义，不能合并：
 *   ''          → 明确清空定时（取消排期，改成立即发布/仍为草稿）
 *   'YYYY-...'  → 合法的未来时刻
 *   undefined   → 没传或填错，调用方保持原值（不让一次手滑把排期抹掉）
 */
export function requestedAt(raw, now) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return undefined;
  const t = Date.parse(s.replace(' ', 'T') + 'Z');
  const n = Date.parse(now.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(t) || !Number.isFinite(n)) return undefined;
  /* 下限 1 分钟：定时在保存请求往返的几十秒里没意义，还可能「设了就发布」。
     上限 366 天：挡住 2099 这类手滑，又不挡正常的跨年排期。 */
  if (t <= n + 60_000 || t > n + 366 * 86400_000) return undefined;
  return s;
}

/**
 * 发布时间：第一次进入「非私密」状态时定下，之后来回改成草稿/发布都不再改写。
 * 不这么定的话，草稿写于 10 月、发布在 12 月，页面日期、RSS pubDate、
 * article:published_time 会一起错成 10 月。空串表示还没发布过。
 *
 * requested 是 requestedAt() 的结果：
 *   undefined → 没传定时参数，保持旧行为（老调用方与填错的情况都走这里）
 *   未来时刻  → 排期 / 改期（尚未到点的定时可以改）
 *   ''        → 取消排期
 * 已经到点的文章一律锁定 —— 发布日期跳变会让 RSS/JSON-LD/页面日期一起错。
 */
export function publishedOf(prev, isPrivate, now, requested = undefined) {
  if (prev && prev <= now) return prev;
  if (requested === undefined) return prev || (isPrivate ? '' : now);
  if (requested) return requested;
  return isPrivate ? '' : now;
}

/** 系列名：40 字以内，去掉首尾空白；空串表示单篇 */
const seriesOf = (b) => String(b.series ?? '').trim().slice(0, 40);
const seriesOrderOf = (b) => {
  const n = parseInt(b.series_order, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0;
};

/* 保存前留快照。自动保存每 3 秒一次，只有内容/关键字段真变了才写，
   否则版本表会被无变化的保存刷爆。每篇保留最近 30 版。 */
async function snapshotPost(db, p, uid, note) {
  await db
    .prepare(
      `INSERT INTO post_revisions (post_id, title, content, html_content, cover, cover_body, category,
        series, series_order, is_private, hidden, review_status, published_at, saved_by, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      p.id, p.title || '', p.content || '', p.html_content || '', p.cover || '', p.cover_body || '',
      p.category || '', p.series || '', p.series_order || 0, p.is_private || 0, p.hidden || 0,
      p.review_status || 'approved', p.published_at || '', uid || 0, note || ''
    )
    .run();
  await db
    .prepare(
      `DELETE FROM post_revisions WHERE post_id = ? AND id NOT IN
       (SELECT id FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT 30)`
    )
    .bind(p.id, p.id)
    .run();
}

function shapePost(p, full = false) {
  const base = {
    id: p.id,
    slug: p.slug,
    title: p.title,
    // 手填封面 → 正文首图 → 预设自动图，永远有值，前端不用再判空
    // 列表用缩略图：预设图走 416px WebP（1.5KB），自传封面照原样
    cover: thumbOf(p),
    // 有 AI 摘要就用摘要当导语，没有才截正文（归档查询只带 content_len，没有正文）
    excerpt: p.summary || (p.content ? extractExcerpt(p.content, 140) : ''),
    summary: p.summary || '',
    summary_src: p.summary_src || '',
    // tag_str 来自列表查询的内联子查询；文章详情走 attachTags 塞 p.tags，两路都认
    tags: 'tag_str' in p ? splitTagStr(p.tag_str) : p.tags || [],
    category: p.category || '',
    category_name: p.category ? catName(p.category) : '',
    is_private: !!p.is_private,
    hidden: !!p.hidden,
    review_status: p.review_status || 'approved',
    author: p.author_name || p.login || '',
    author_id: p.author_id,
    avatar: p.avatar || '',
    // 归档查询没带正文，改用 SQL 算好的 content_len（口径与 readingTime 一致）
    reading: p.content_len != null ? Math.max(1, Math.round(Number(p.content_len) / 400)) : readingTime(p.content),
    // 字数只从真实正文算；列表查询没带 content 就不给这个字段，不拿字节数冒充字数
    words: p.content !== undefined ? wordCount(p.content) : undefined,
    series: p.series || '',
    series_order: p.series_order || 0,
    // 发布时间：草稿转发布那一刻定下。老数据没有这个字段时退回 created_at，
    // 保证 API 里永远是字符串而不是 null，前端不用再写一遍兜底
    published_at: p.published_at || p.created_at || '',
    // 落库原值（未发布就是空串）。编辑器靠它区分「真发布过」和「拿 created_at 兜底」，
    // 否则私密草稿会显示成已发布时间，误导人以为字段已经写进去了
    published_at_raw: p.published_at || '',
    created_at: p.created_at,
    updated_at: p.updated_at,
    comments: p.comment_count ?? undefined,
  };
  if (full) base.content = p.content;
  return base;
}

async function syncTags(db, postId, content) {
  // 正文里手写的 #标签 先过一遍别名表，避免 cf / cfworkers / cloudflare 各存一份
  const names = normalizeTags(extractTags(content));
  await db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(postId).run();
  for (const name of names) {
    await db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(name).run();
    const t = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first();
    if (t) await db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?,?)').bind(postId, t.id).run();
  }
  return names;
}

const AUTHOR_JOIN = 'LEFT JOIN users u ON u.id = p.author_id';
const AUTHOR_COLS = 'u.name AS author_name, u.login, u.avatar';

/* 「已到点」闸门：所有对外可见的查询都要过这一关。
   hidden 是手动下架开关，时间闸门是自动上架开关 —— 预排文章靠它，
   不用再指望每次都记得把 hidden 置 1（11-12 就漏过一次，两篇提前上线）。
   published_at 为空的老文章退回 created_at，语义与排序用的表达式保持一致。
   SQLite 同一语句内的 datetime('now') 是常量，不会逐行求值。 */
/* 纯时间闸门：只管「发布时间到了没」，不掺审核态。
   管理视图（待审队列、定时队列）用它——那些地方本来就是要看未公开/未到点的稿子。 */
export function timeGateSql(a = 'p') {
  return `COALESCE(NULLIF(${a}.published_at, ''), ${a}.created_at) <= datetime('now')`;
}

export function liveSql(a = 'p') {
  /* 公开闸门 = 时间到了 + 审核通过。所有公开列表（首页/归档/标签/分类/系列/RSS/sitemap/
     404 推荐）都调这个函数，一处加条件就全挡住。作者新发的文章默认 review_status='pending'，
     读者侧任何列表都看不到，只有管理员审核通过改成 'approved' 才放行。
     hidden/is_private 是作者自控的开关，不能拿来当审核态——作者能自己改回去。 */
  return `${timeGateSql(a)} AND ${a}.review_status = 'approved'`;
}

/* 「这个标签下有没有公开文章」——原本内联在 src/index.js 的 route() 里，
   是那条 111 行分发器里唯一一处 SQL。抽出来不是为了好看：
   路由层一旦自己写 SQL，加新路由的人就得先读懂那段查询才敢动，
   「加功能 = 加一行注册」这条契约当场失效。判据一个字没改。 */
export async function tagHasLivePosts(env, name) {
  const hit = await env.DB.prepare(
    `SELECT 1 FROM tags t
     JOIN post_tags pt ON pt.tag_id = t.id
     JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}
     WHERE t.name = ? LIMIT 1`
  )
    .bind(name)
    .first();
  return Boolean(hit);
}

/* 标签用相关子查询一次带出，替代「先查 posts 再 attachTags」的第二次往返。
   char(31) 是 US（unit separator），标签名里不可能出现，拿来当分隔符比逗号安全 —— 标签本身允许逗号。
   列表页每多一次 D1 往返就是几十毫秒，这一条和下面 COUNT 的并行加起来能砍掉一半 SSR 时间。 */
const TAG_AGG = `(SELECT GROUP_CONCAT(t.name, char(31)) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tag_str`;
const splitTagStr = (s) => (s ? String(s).split('\u001f').filter(Boolean) : []);

/* ---------- 归档数据（接口与 /archive SSR 共用一份，避免两处 SQL 走偏） ---------- */
export async function archiveData(db, year = '') {
  const y = /^\d{4}$/.test(String(year)) ? String(year) : '';
  const where = ['p.is_private = 0', 'p.hidden = 0', liveSql('p')];
  const args = [];
  if (y) {
    /* 年份过滤也得按北京时间算，否则 /2027 那一页会漏掉跨年凌晨发的文章，
       而这篇文章在页面上明明写着 2027 —— 读者点年份进去找不到它。 */
    where.push("strftime('%Y', datetime(COALESCE(NULLIF(p.published_at, ''), p.created_at), '+8 hours')) = ?");
    args.push(y);
  }

  /* 归档只渲染日期、标题、slug、阅读时长，却一直 SELECT p.*，
     把当年全部正文（14 篇合计约 79KB）从 D1 读出来、穿过网络传进 Worker，
     再全部丢掉。这里改成只取需要的列，阅读时长用 SQL 直接算：
     与 public/md.js 的 readingTime() 同口径（去掉空白后 / 400 取整），
     否则归档页显示 26 分钟、文章页显示 24 分钟，读者会以为哪里算错了。 */
  const CONTENT_LEN = `length(replace(replace(replace(replace(COALESCE(p.content, ''), char(32), ''), char(10), ''), char(13), ''), char(9), ''))`;

  const { results } = await db
    .prepare(
      `SELECT p.id, p.slug, p.title, p.summary, p.summary_src, p.cover, p.cover_body, p.category,
              p.series, p.series_order, p.is_private, p.hidden,
              p.published_at, p.created_at, p.updated_at,
              ${CONTENT_LEN} AS content_len,
              ${AUTHOR_COLS}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'approved') AS comment_count
       FROM posts p ${AUTHOR_JOIN}
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(NULLIF(p.published_at, ''), p.created_at) DESC, p.id DESC
       LIMIT 2000`
    )
    .bind(...args)
    .all();

  await attachTags(db, results);

  const yearMap = new Map();
  for (const p of results) {
    /* 按北京时间的年月分组。原来切片取的是 UTC 的年月，于是北京时间
       2027-01-01 00:30 发的文章会进 2026 那一栏 —— 一年只有 8 小时会出错，
       所以从来没人在测试里撞见过。 */
    const lp = localParts(p.published_at || p.created_at);
    const yy = lp.y || '未知';
    const mm = lp.m || '00';
    if (!yearMap.has(yy)) yearMap.set(yy, { year: yy, count: 0, months: new Map() });
    const yb = yearMap.get(yy);
    yb.count += 1;
    if (!yb.months.has(mm)) yb.months.set(mm, { month: mm, label: `${Number(mm) || '?'} 月`, count: 0, posts: [] });
    const mb = yb.months.get(mm);
    mb.count += 1;
    mb.posts.push(shapePost(p));
  }

  const years = [...yearMap.values()].map((v) => ({
    year: v.year,
    count: v.count,
    months: [...v.months.values()],
  }));

  // 全站跨度（不受 year 过滤影响）
  const spanRow = await db
    .prepare(
      `SELECT MIN(COALESCE(NULLIF(published_at, ''), created_at)) AS first_at,
              MAX(COALESCE(NULLIF(published_at, ''), created_at)) AS last_at,
              COUNT(*) AS total
       FROM posts WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')}`
    )
    .first();

  return {
    total: spanRow?.total || 0,
    filtered: results.length,
    year: y,
    first_at: spanRow?.first_at || '',
    last_at: spanRow?.last_at || '',
    years,
  };
}

/* ---------- 标签云（接口与 /categories 的 SSR 共用） ---------- */
export async function tagsData(db) {
  const { results } = await db
    .prepare(
      `SELECT t.name, COUNT(pt.post_id) AS count
       FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
       JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}
       GROUP BY t.name ORDER BY count DESC, t.name ASC`
    )
    .all();
  return results;
}

/* ---------- 友链（接口与 /friends 的 SSR 共用） ---------- */
export async function friendsData(db) {
  const { results } = await db
    .prepare(
      'SELECT id, name, url, avatar, desc, status, http_status, latency_ms, checked_at FROM friends ORDER BY status DESC, id ASC'
    )
    .all();
  return results;
}

/* 搜索匹配条件：标题 / 正文 / 标签名三路。
   抽成纯函数，一是让单测不碰 D1 就能验证「三个 ? 各绑一个 %关键词%」，
   二是 COUNT 与列表查询共用同一个 whereSql/args —— 占位符和参数数量一旦走偏，
   线上表现是「搜得到但总数不对」或干脆报绑定数量不匹配。
   标签那一路用 IN 子查询，口径与上面的 tag 过滤完全一致（post_tags.post_id）。 */
export function searchMatch(q) {
  // LIKE 里 % 与 _ 是通配符，\ 是转义符本身：三者都要转义，否则搜字面量
  // 「100%」「a_b」会退化成全表匹配。ESCAPE '\' 只作用于这一条 LIKE 表达式，
  // 三个分支都带上，避免 COUNT 与列表口径走偏。
  const kw = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
  const ESC = " ESCAPE '\\'";
  return {
    sql: `(p.title LIKE ?${ESC} OR p.content LIKE ?${ESC} OR p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name LIKE ?${ESC}))`,
    args: [kw, kw, kw],
  };
}

/* ---------- 文章列表查询（接口与首页 SSR 共用，避免两份 SQL 走偏） ---------- */
export async function listPosts(db, { page = 1, size = 10, tag = '', cat = '', q = '' } = {}) {
  const offset = (page - 1) * size;
  const where = ['p.is_private = 0', 'p.hidden = 0', liveSql('p')];
  const args = [];

  if (tag) {
    where.push('p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)');
    args.push(tag);
  }
  if (cat) {
    where.push('p.category = ?');
    args.push(cat);
  }
  if (q) {
    const m = searchMatch(q);
    where.push(m.sql);
    args.push(...m.args);
  }

  const whereSql = where.join(' AND ');

  /* COUNT 和主查询互不依赖，一起发出去。
     以前是先 await COUNT 再 await 列表，冷启动时两个往返叠加，
     等于把 D1 的延迟翻了一倍。 */
  /* 列裁剪：列表只需要卡片上那几个字段。
     原来 SELECT p.* 会把每篇的 Markdown 正文一起读出来 —— 一页 10 篇、每篇几千字，
     穿过 D1 的返回和 Worker 的内存，最后只用来算一个阅读时长和一张缩略图。
     阅读时长改由 SQL 算（口径与 archiveData / public/md.js 的 readingTime 一致），
     封面改读 cover_body（保存时落库的正文首图快照）。
     只有真的在搜索时才带 content：searchSnippet 要按关键词截那一段，
     LIKE 条件本身在 WHERE 里，不需要 SELECT 出来。 */
  const CONTENT_LEN = `length(replace(replace(replace(replace(COALESCE(p.content, ''), char(32), ''), char(10), ''), char(13), ''), char(9), ''))`;
  const listCols = [
    'p.id', 'p.slug', 'p.title', 'p.cover', 'p.cover_body', 'p.summary', 'p.summary_src',
    'p.category', 'p.series', 'p.series_order', 'p.is_private', 'p.hidden', 'p.author_id',
    'p.published_at', 'p.created_at', 'p.updated_at',
    `${CONTENT_LEN} AS content_len`,
    q ? 'p.content' : '',
  ].filter(Boolean).join(', ');

  const [{ results }, totalRow] = await Promise.all([
    db
      .prepare(
        `SELECT ${listCols}, ${AUTHOR_COLS}, ${TAG_AGG}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'approved') AS comment_count
         FROM posts p ${AUTHOR_JOIN} WHERE ${whereSql}
         ORDER BY COALESCE(NULLIF(p.published_at, ''), p.created_at) DESC, p.id DESC LIMIT ? OFFSET ?`
      )
      .bind(...args, size, offset)
      .all(),
    db.prepare(`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSql}`).bind(...args).first(),
  ]);

  const total = totalRow?.c || 0;
  return {
    page,
    size,
    total,
    pages: Math.max(1, Math.ceil(total / size)),
    // 搜索时把摘要换成「关键词所在的那一段」：命中在正文深处时，
    // 开头 140 字里根本没有这个词，前端高亮就成了摆设
    posts: results.map((p) => {
      const s = shapePost(p);
      if (q) {
        const snip = searchSnippet(p.content, q);
        if (snip) s.excerpt = snip;
      }
      return s;
    }),
  };
}

/* ---------- 主路由 ---------- */

export async function handleApi(env, request, url, ctx) {
  const db = env.DB;
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method;
  const user = await currentUser(env, request);

  /* ---- 访问统计上报（匿名，不走鉴权） ---- */
  if (path === '/pv' && method === 'POST') return await recordPv(env, request, ctx);
  /* 行为事件：阅读完成 / 图片加载失败 / 站内搜索。和 pv 一样匿名、不走鉴权 */
  if (path === '/ev' && method === 'POST') return await recordEvent(env, request, ctx);

  /* ---- 站点信息 ---- */
  if (path === '/site' && method === 'GET') {
    const s = await getSite(env);
    return json({ ok: true, name: s.name, desc: s.desc, theme: s.theme, mode: s.mode, avatar: s.avatar });
  }

  /* ---- 站点设置（管理员读写） ---- */
  if (path === '/settings' && method === 'GET') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;
    const s = await getSite(env);
    return json({ ok: true, name: s.name, desc: s.desc, author: s.author, theme: s.theme, mode: s.mode, avatar: s.avatar });
  }

  if (path === '/settings' && method === 'PUT') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    const body = await request.json();
    const name = String(body.name ?? '').trim();
    if (!name) return err('站点名称不能为空');
    if (name.length > 60) return err('站点名称太长（限 60 字）');
    const desc = String(body.desc ?? '').trim();
    if (desc.length > 200) return err('站点介绍太长（限 200 字）');
    // 作者署名：RSS 的 <author> 用它。允许留空（留空就退回站名），不允许塞标签
    let author;
    if (body.author !== undefined) {
      author = String(body.author ?? '').replace(/[<>]/g, '').trim();
      if (author.length > 80) return err('作者名太长（限 80 字）');
    }
    if (body.theme !== undefined && !THEME_IDS.includes(String(body.theme))) return err('未知的风格');
    if (body.mode !== undefined && !MODE_IDS.includes(String(body.mode))) return err('未知的外观模式');

    let avatar;
    if (body.avatar !== undefined) {
      avatar = String(body.avatar ?? '').trim();
      if (avatar.length > 500) return err('头像地址太长（限 500 字符）');
      const ok = avatar === '' || avatar.startsWith('/') || /^https?:\/\//i.test(avatar);
      if (!ok) return err('头像地址只能是 http(s) 链接或站内路径');
      if (avatar.startsWith('//')) return err('头像地址不要以 // 开头');
    }

    const s = await setSite(env, {
      name,
      desc,
      author,
      theme: body.theme === undefined ? undefined : String(body.theme),
      mode: body.mode === undefined ? undefined : String(body.mode),
      avatar,
    });
    return json({ ok: true, name: s.name, desc: s.desc, author: s.author, theme: s.theme, mode: s.mode, avatar: s.avatar });
  }

  /* ---- 站点头像上传（管理员，直接落 R2 并写入设置） ---- */
  if (path === '/settings/avatar' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return err('没有文件');

    const type0 = String(file.type || '').toLowerCase();
    if (!IMAGE_TYPES[type0]) return err('只支持 jpg / png / gif / webp / svg / avif');
    if (file.size > 4 * 1024 * 1024) return err('图片别超过 4MB');

    const buf = await file.arrayBuffer();
    const { type } = settleType(type0, buf);
    const key = makeKey(`avatar.${IMAGE_TYPES[type]}`, type);
    await env.BUCKET.put(key, buf, {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
    });

    const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '') : '';
    const publicUrl = base ? `${base}/${key}` : `/img/${key}`;
    const s = await setSite(env, { avatar: publicUrl });
    return json({ ok: true, avatar: s.avatar, key });
  }

  /* ---- 当前用户 ---- */
  if (path === '/me' && method === 'GET') {
    return json({ ok: true, user: user ? { ...user, is_admin: !!user.is_admin } : null });
  }

  /* ---- 文章列表（首页 / 搜索 / 标签） ---- */
  if (path === '/posts' && method === 'GET') {
    const { page, size } = pageParams(url, 10);
    const data = await listPosts(db, {
      page,
      size,
      tag: url.searchParams.get('tag') || '',
      cat: (url.searchParams.get('cat') || '').trim(),
      /* q 直接进 LIKE '%…%'，不限长的话一个几 KB 的关键词就等于让 D1
         把整表扫一遍，还什么都匹配不到。60 字够覆盖正常搜索意图。 */
      q: (url.searchParams.get('q') || '').trim().slice(0, 60),
    });
    return json({ ok: true, ...data });
  }

  /* ---- 我的文章（含私密与隐藏） ---- */
  if (path === '/mine' && method === 'GET') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const { results } = await db
      .prepare(
        `SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN}
         WHERE p.author_id = ? ORDER BY p.updated_at DESC LIMIT 200`
      )
      .bind(u.id)
      .all();
    await attachTags(db, results);
    return json({
      ok: true,
      posts: results.map((p) => ({ ...shapePost(p, true), is_private: !!p.is_private, hidden: !!p.hidden })),
    });
  }

  /* ---- 待审队列（仅管理员）----
     只列 pending 且「已经到发布时间」的稿子：没到点的定时稿是作者自己还没准备发，
     不该堵在审核队列里；作者真要送审，把发布时间设到现在或过去即可。
     rejected 不进队列——它已经处理过，作者改稿后会自动变回 pending。 */
  if (path === '/review/pending' && method === 'GET') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;
    const { results } = await db
      .prepare(
        `SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN}
         WHERE p.review_status = 'pending' AND ${timeGateSql('p')}
         ORDER BY p.updated_at ASC LIMIT 200`
      )
      .all();
    return json({
      ok: true,
      posts: results.map((p) => ({
        id: p.id, slug: p.slug, title: p.title, author: p.author_name || p.login || '',
        author_id: p.author_id, excerpt: (p.summary || p.content || '').slice(0, 160),
        published_at: p.published_at || p.created_at || '', updated_at: p.updated_at || '',
      })),
    });
  }

  /* ---- 审核：通过 / 驳回（仅管理员）---- */
  if (/^\/review\/\d+$/.test(path) && method === 'POST') {
    const { user, res } = await requireAdmin(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');
    if (action !== 'approve' && action !== 'reject') return err('action 只能是 approve 或 reject');
    const p = await db.prepare('SELECT id, slug, review_status FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    const next = action === 'approve' ? 'approved' : 'rejected';
    await db.prepare('UPDATE posts SET review_status = ?, updated_at = ? WHERE id = ?').bind(next, nowISO(), id).run();
    await logAudit(env, user, action === 'approve' ? 'review.approve' : 'review.reject', 'post', String(id), p.slug || '');
    if (ctx) ctx.waitUntil(bust(url, [p.slug], [], db).catch(() => {}));
    return json({ ok: true, id, review_status: next });
  }

  /* ---- 标签云 ---- */
  if (path === '/tags' && method === 'GET') {
    return json({ ok: true, tags: await tagsData(db) });
  }

  /* ---- 归档（按年月分组的全部公开文章） ---- */
  if (path === '/archive' && method === 'GET') {
    const year = (url.searchParams.get('year') || '').trim();
    return json({ ok: true, ...(await archiveData(db, year)) });
  }

  /* ---- 栏目（固定四栏，含空栏目；栏目语义见 src/taxonomy.js） ---- */
  if (path === '/categories' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT category, COUNT(*) AS count FROM posts
         WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')} GROUP BY category`
      )
      .all();

    const counts = new Map();
    let uncategorized = 0;
    for (const r of results) {
      const slug = normalizeCat(r.category);
      if (!slug) {
        uncategorized += Number(r.count) || 0;
        continue;
      }
      counts.set(slug, (counts.get(slug) || 0) + (Number(r.count) || 0));
    }

    return json({
      ok: true,
      categories: CATS.map((c) => ({
        slug: c.slug,
        name: c.name,
        desc: c.desc,
        hint: c.hint,
        count: counts.get(c.slug) || 0,
      })),
      uncategorized,
    });
  }

  /* ---- 栏目 / 标签规范（编辑器用：四选一 + 白名单 + 别名表） ---- */
  if (path === '/taxonomy' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT t.name, COUNT(pt.post_id) AS count FROM tags t
         LEFT JOIN post_tags pt ON pt.tag_id = t.id
         LEFT JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0 AND ${liveSql('p')}
         GROUP BY t.name ORDER BY count DESC, t.name ASC`
      )
      .all();
    return json({
      ok: true,
      categories: CATS,
      seed: TAG_SEED,
      aliases: TAG_ALIAS,
      tags: results,
      offlist: results.filter((r) => !isSeedTag(r.name)).map((r) => r.name),
    });
  }

    /* ---- 系列列表（编辑器下拉 + 文章页系列目录都靠它） ---- */
  if (path === '/series' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT series AS name, COUNT(*) AS count, MAX(updated_at) AS updated_at
         FROM posts
         WHERE is_private = 0 AND hidden = 0 AND ${liveSql('posts')} AND TRIM(series) != ''
         GROUP BY series ORDER BY updated_at DESC`
      )
      .all();
    return json({ ok: true, series: results });
  }

/* ---- 单篇文章 ---- */
  if (path.startsWith('/posts/') && !path.includes('/revisions') && method === 'GET') {
    const slug = decodeURIComponent(path.slice('/posts/'.length));
    const p = await db
      .prepare(`SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN} WHERE p.slug = ?`)
      .bind(slug)
      .first();

    if (!p) return err('文章不存在', 404);
    const owner = user && (user.id === p.author_id || user.is_admin);
    if (p.is_private && !owner) return err('文章不存在', 404);
    /* 审核态闸门：待审/驳回的稿子猜到 slug 也不能读正文。
       liveSql 只守住了列表，单篇是独立查询，必须单独挡——否则审核形同虚设。 */
    if (p.review_status && p.review_status !== 'approved' && !owner) return err('文章不存在', 404);

    await attachTags(db, [p]);

    // 发布时已经渲染好并消毒过，这里只读成品；空串表示这篇还没回填，退回现算
    const rendered = p.html_content || sanitizeHtml(renderBody(p.content));

    return json({ ok: true, post: { ...shapePost(p, true), html: rendered } });
  }

  /* ---- 新建 ---- */
  if (path === '/posts' && method === 'POST') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;

    const body = await request.json();
    const title = String(body.title || '无标题').slice(0, 200);
    const content = cleanMarkdown(String(body.content || ''), title);
    const wanted = slugify(body.slug || '');
    const asciiBase = /^[a-z0-9-]+$/i.test(slugify(title)) ? slugify(title) : '';
    let slug = wanted || asciiBase || uniqueSlug('post');

    const clash = await db.prepare('SELECT id FROM posts WHERE slug = ?').bind(slug).first();
    if (clash) {
      if (wanted) return err('别名已被占用，换一个');
      slug = uniqueSlug(slug);
    }

    const cover = body.cover ? String(body.cover) : extractCover(content) || '';
    const rawCat = String(body.category || '').trim();
    const category = normalizeCat(rawCat);
    if (rawCat && !category) return err('未知栏目：只能是 log / teardown / tools / site');
    const stamp = nowISO();
    const published = publishedOf('', !!body.is_private, stamp, requestedAt(body.publish_at, stamp));

    /* 入库前把正文渲染成成品：这条路径写一次，之后每次回源读的都是成品 HTML。
       消毒必须在这一步做完 —— 读的时候不会再 sanitize 一遍（那样就白省了 CPU）。 */
    const html = sanitizeHtml(renderBody(content));
    const coverBody = bodyCoverFor(content);

    /* 审核态：管理员写的是已通过；普通用户的稿子进来先待审。
       不能拿 hidden 顶替——那是作者自己能在编辑器里改回 0 的开关，挡不住人。 */
    const review = u.is_admin ? 'approved' : 'pending';
    const info = await db
      .prepare(
        `INSERT INTO posts (slug, title, content, html_content, cover, cover_body, category, series, series_order, is_private, hidden, review_status, published_at, author_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        slug, title, content, html, cover, coverBody, category,
        seriesOf(body), seriesOrderOf(body),
        body.is_private ? 1 : 0, body.hidden ? 1 : 0,
        review,
        published,
        u.id, stamp, stamp
      )
      .run();

    const id = info.meta.last_row_id;

    // 手动写了摘要就存手动版，否则发布即后台生成
    const manual = body.summary !== undefined ? String(body.summary).trim().slice(0, 400) : '';
    if (manual) {
      await db.prepare("UPDATE posts SET summary = ?, summary_src = 'manual' WHERE id = ?").bind(manual, id).run();
    } else if (ctx) {
      ctx.waitUntil(refreshSummary(env, db, id, { title, content }));
    }

    await syncTags(db, id, content);
    await logAudit(env, u, 'post.create', 'post', String(id), title);
    if (ctx) ctx.waitUntil(bust(url, [slug, ...(await seriesSiblingSlugs(db, seriesOf(body)))], [category], db).catch(() => {}));
    return json({ ok: true, id, slug, summary: manual, ai: hasAI(env), published_at: published });
  }

  /* ---- 更新 ---- */
  if (/^\/posts\/\d+$/.test(path) && method === 'PUT') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);

    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    if (p.author_id !== u.id && !u.is_admin) return err('无权编辑', 403);

    const body = await request.json();
    const title = body.title !== undefined ? String(body.title).slice(0, 200) : p.title;
    const content = body.content !== undefined ? cleanMarkdown(String(body.content), title) : p.content;

    let slug = p.slug;
    if (body.slug !== undefined) {
      const wanted = slugify(body.slug);
      if (wanted && wanted !== p.slug) {
        const clash = await db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').bind(wanted, id).first();
        if (clash) return err('别名已被占用，换一个');
        slug = wanted;
      }
    }

    const cover = body.cover !== undefined ? String(body.cover || '') : p.cover || extractCover(content) || '';
    let category = p.category || '';
    if (body.category !== undefined) {
      const rawCat = String(body.category || '').trim();
      category = normalizeCat(rawCat);
      if (rawCat && !category) return err('未知栏目：只能是 log / teardown / tools / site');
    }

    // 摘要：显式传入就按手动存；传空串表示"清空，下次重新生成"
    let sumSql = '';
    const sumArgs = [];
    let needGen = false;
    if (body.summary !== undefined) {
      const manual = String(body.summary).trim().slice(0, 400);
      sumSql = ', summary = ?, summary_src = ?';
      sumArgs.push(manual, manual ? 'manual' : '');
      needGen = !manual;
    } else if (contentHash(content) !== (p.summary_hash || '')) {
      needGen = true;      // 正文变了，摘要跟着旧了
    }

    const isPrivate = body.is_private !== undefined ? (body.is_private ? 1 : 0) : p.is_private;
    const isHidden = body.hidden !== undefined ? (body.hidden ? 1 : 0) : p.hidden;
    const stampNow = nowISO();
    const published = publishedOf(p.published_at, isPrivate, stampNow, requestedAt(body.publish_at, stampNow));
    // 正文没动就沿用上次的成品，省一次解析（编辑器每次保存都会把 content 带回来）
    const html = content === p.content && p.html_content ? p.html_content : sanitizeHtml(renderBody(content));
    const coverBody = bodyCoverFor(content);

    /* 审核态跟着这次保存走：
       - 普通用户改稿（哪怕只改一个字）一律退回 pending —— 否则「先发篇无害的过审，
         再偷偷把正文换成广告/违规内容」就绕过了审核。审核结论必须绑定内容版本。
       - 管理员编辑视为认可，直接 approved。
       管理员审核通过/驳回走专门的 /admin/review API，不走这里。 */
    const review = u.is_admin ? 'approved' : 'pending';
    // 自动保存每 3 秒一次，没变化的保存不写快照、不刷审计
    const nextSeries = body.series !== undefined ? seriesOf(body) : p.series || '';
    const changed =
      content !== p.content || title !== p.title || slug !== p.slug ||
      category !== (p.category || '') || nextSeries !== (p.series || '') ||
      isPrivate !== p.is_private || isHidden !== p.hidden ||
      published !== (p.published_at || '') || review !== (p.review_status || 'approved');
    if (changed) await snapshotPost(db, p, u.id, '保存前');

    await db
      .prepare(
        `UPDATE posts SET slug=?, title=?, content=?, html_content=?, cover=?, cover_body=?, category=?, series=?, series_order=?, is_private=?, hidden=?, review_status=?, published_at=?, updated_at=?${sumSql} WHERE id=?`
      )
      .bind(
        slug,
        title,
        content,
        html,
        cover,
        coverBody,
        category,
        nextSeries,
        body.series_order !== undefined ? seriesOrderOf(body) : p.series_order || 0,
        isPrivate,
        isHidden,
        review,
        published,
        stampNow,
        ...sumArgs,
        id
      )
      .run();

    if (needGen && ctx) ctx.waitUntil(refreshSummary(env, db, id, { title, content }));

    await syncTags(db, id, content);
    if (changed) await logAudit(env, u, 'post.update', 'post', String(id), title);
    if (ctx) {
      const touched = [
        ...new Set([
          ...(await seriesSiblingSlugs(db, seriesOf({ series: body.series !== undefined ? body.series : p.series }))),
          ...(await seriesSiblingSlugs(db, p.series)),
        ]),
      ];
      ctx.waitUntil(bust(url, [slug, p.slug, ...touched], [category, p.category], db).catch(() => {}));
    }
    return json({ ok: true, id, slug, updated_at: nowISO(), published_at: published, ai: hasAI(env) });
  }

  /* ---- 版本历史：作者/管理员可读；回滚只有管理员能做（回滚会改已过审内容）---- */
  if (/^\/posts\/\d+\/revisions$/.test(path) && method === 'GET') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    const p = await db.prepare('SELECT id, author_id FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    if (p.author_id !== u.id && !u.is_admin) return err('无权查看', 403);
    const { results } = await db
      .prepare(
        'SELECT id, saved_at, saved_by, note, title, length(content) AS size FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT 30'
      )
      .bind(id)
      .all();
    return json({ ok: true, revisions: results });
  }

  if (/^\/posts\/(\d+)\/revisions\/(\d+)\/restore$/.test(path) && method === 'POST') {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    const rid = parseInt(path.split('/')[4], 10);
    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    const rev = await db.prepare('SELECT * FROM post_revisions WHERE id = ? AND post_id = ?').bind(rid, id).first();
    if (!p || !rev) return err('版本不存在', 404);
    // 回滚本身也是一次改动，先给当前内容留快照，避免回滚完又找不回来
    await snapshotPost(db, p, u.id, `回滚 #${rid} 前`);
    await db
      .prepare(
        `UPDATE posts SET title=?, content=?, html_content=?, cover=?, cover_body=?, category=?, series=?,
         series_order=?, is_private=?, hidden=?, review_status=?, published_at=?, updated_at=? WHERE id=?`
      )
      .bind(
        rev.title, rev.content, rev.html_content || '', rev.cover || '', rev.cover_body || '',
        rev.category || '', rev.series || '', rev.series_order || 0, rev.is_private || 0, rev.hidden || 0,
        rev.review_status || 'approved', rev.published_at || '', nowISO(), id
      )
      .run();
    await syncTags(db, id, rev.content || '');
    await logAudit(env, u, 'post.restore', 'post', String(id), `回滚到版本 #${rid}`);
    if (ctx) ctx.waitUntil(bust(url, [p.slug], [], db).catch(() => {}));
    return json({ ok: true, id, restored_from: rid });
  }

  /* ---- 生成 / 重新生成 AI 摘要 ---- */
  if (/^\/posts\/\d+\/summary$/.test(path) && method === 'POST') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);

    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    if (p.author_id !== u.id && !u.is_admin) return err('无权编辑', 403);

    let body = {};
    try {
      body = await request.json();
    } catch {}

    const title = body.title !== undefined ? String(body.title).slice(0, 200) : p.title;
    const content = body.content !== undefined ? String(body.content) : p.content;
    if (!String(content).trim()) return err('正文是空的，没东西可总结');

    const hash = contentHash(content);
    const force = !!body.force;

    // 已经算过同一版正文，直接返回，不重复烧 token
    if (!force && p.summary && p.summary_hash === hash && p.summary_src !== 'manual') {
      return json({ ok: true, summary: p.summary, src: p.summary_src, cached: true });
    }

    const out = await generateSummary(env, { title, content });
    if (!out.summary) return err('摘要生成失败，检查 AI 绑定或密钥');

    await db
      .prepare('UPDATE posts SET summary = ?, summary_src = ?, summary_hash = ? WHERE id = ?')
      .bind(out.summary, out.src, hash, id)
      .run();

    return json({ ok: true, summary: out.summary, src: out.src });
  }

  /* ---- 删除 ---- */
  if (/^\/posts\/\d+$/.test(path) && method === 'DELETE') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);

    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    if (p.author_id !== u.id && !u.is_admin) return err('无权删除', 403);
    await logAudit(env, u, 'post.delete', 'post', String(id), p.title || '');

    await db.batch([
      db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM comments WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM posts WHERE id = ?').bind(id),
    ]);
    if (ctx) ctx.waitUntil(bust(url, [p.slug, ...(await seriesSiblingSlugs(db, p.series))], [p.category], db).catch(() => {}));
    return json({ ok: true });
  }

  /* ---- 评论列表 ---- */
  if (path === '/comments' && method === 'GET') {
    const slug = url.searchParams.get('slug');
    if (!slug) return err('缺少 slug');
    const p = await db.prepare('SELECT id, is_private, author_id FROM posts WHERE slug = ?').bind(slug).first();
    if (!p) return err('文章不存在', 404);
    if (p.is_private && (!user || (user.id !== p.author_id && !user.is_admin))) return err('文章不存在', 404);

    const { results } = await db
      .prepare(
        "SELECT id, parent_id, name, email, website, content, is_admin, ip, created_at FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC"
      )
      .bind(p.id)
      .all();

    // 邮箱与 IP 只给管理员看，游客/普通用户拿不到
    const isAdm = !!(user && user.is_admin);
    const rows = isAdm ? results : results.map(({ email, ip, ...rest }) => rest);

    const roots = rows.filter((c) => !c.parent_id);
    const children = rows.filter((c) => c.parent_id);
    const tree = roots.map((r) => ({ ...r, replies: children.filter((c) => c.parent_id === r.id) }));

    return json({ ok: true, total: rows.length, comments: tree });
  }

  /* ---- 发评论 ---- */
  if (path === '/comments' && method === 'POST') {
    const body = await request.json();
    const slug = String(body.slug || '');
    const content = String(body.content || '').trim();

    if (!content) return err('评论不能为空');
    if (content.length > 2000) return err('评论太长');

    const p = await db
      .prepare(`SELECT p.id, p.title, p.slug, p.is_private, p.author_id FROM posts p WHERE p.slug = ?`)
      .bind(slug)
      .first();
    if (!p) return err('文章不存在', 404);
    if (p.is_private && (!user || (user.id !== p.author_id && !user.is_admin))) return err('文章不存在', 404);

    const name = user ? user.name || user.login : String(body.name || '').trim();
    if (!name) return err('请填写昵称');

    // 联系邮箱必填；登录用户没填就用账号邮箱兜底
    const email = String(body.email || '').trim() || (user && user.email) || '';
    if (!email) return err('请填写联系邮箱');
    if (email.length > 120) return err('邮箱太长');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('邮箱格式不正确');

    const isAdmin = user && user.is_admin ? 1 : 0;
    // 先审后发是站点级开关（settings.comment_moderation），管理员发言不受限
    const modRow = await db.prepare("SELECT value FROM settings WHERE key='comment_moderation'").first();
    const status = !isAdmin && modRow?.value === '1' ? 'pending' : 'approved';

    /* ---- 防滥用：蜜罐 → Turnstile → 频率（管理员全部跳过）---- */
    let rate = null;
    if (!isAdmin) {
      // 真人看不见这个框，它是给自动填表的脚本填的
      if (String(body.hp || '').trim()) return err('验证没通过，刷新页面再试一次', 400);

      const tv = await verifyTurnstile(env, body.turnstile_token, request.headers.get('cf-connecting-ip') || '');
      if (!tv.ok) return err(tv.error, 400);

      rate = await guard(db, request, Math.floor(Date.now() / 1000));
      if (!rate.ok) {
        return json({ ok: false, error: rate.error }, rate.status, { 'retry-after': String(rate.retry || 60) });
      }
    }

    let parentId = null;
    if (body.parent_id) {
      // 只能回复已放行的评论：不然新回复挂在 pending 父节点下，父节点永远不公开，
      // 子评论即使自己通过审核也进不了前台的树（roots 只取 parent_id 为空的行），
      // 结果就是作者以为发了、管理员放行后仍然看不见。
      const parent = await db
        .prepare("SELECT id, parent_id FROM comments WHERE id = ? AND post_id = ? AND status = 'approved'")
        .bind(parseInt(body.parent_id, 10), p.id)
        .first();
      if (!parent) return err('父评论不存在');
      // 强制两级：回复子评论时归到顶级
      parentId = parent.parent_id || parent.id;
    }

    const info = await db
      .prepare(
        `INSERT INTO comments (post_id, parent_id, name, email, website, content, is_admin, status, ip, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        p.id,
        parentId,
        name.slice(0, 40),
        email.slice(0, 120),
        String(body.website || '').slice(0, 200),
        content,
        isAdmin,
        status,
        request.headers.get('cf-connecting-ip') || '',
        nowISO()
      )
      .run();

    // 落库成功才计额度：被 400 拒掉的请求不占次数
    const headers = {};
    if (rate && rate.ok) {
      await record(db, rate.ip, rate.did, Math.floor(Date.now() / 1000));
      if (rate.fresh) headers['set-cookie'] = setCookie('cmt_did', rate.did, { maxAge: DID_MAX_AGE });
    }

    const origin = siteOrigin(env, request);
    if (status === 'pending') {
      await notifyTodo(env, `新评论待审：${name} 在《${p.title}》\n${origin}/admin/comments`);
    } else {
      await notifyComment(env, {
        postTitle: p.title,
        postUrl: `${origin}/p/${p.slug}`,
        name,
        content,
      });
    }

    return json({ ok: true, id: info.meta.last_row_id, status }, 200, headers);
  }

  /* ---- 评论先审后发：开关与单条处置（仅管理员）---- */
  if (path === '/comments/moderation' && method === 'POST') {
    const { user, res } = await requireAdmin(env, request);
    if (res) return res;
    const body = await request.json().catch(() => ({}));
    const enabled = body.enabled ? '1' : '0';
    const prev = await db.prepare("SELECT value FROM settings WHERE key='comment_moderation'").first();
    const was = String(prev?.value ?? '0') === '1';

    await db
      .prepare(`INSERT INTO settings (key, value) VALUES ('comment_moderation', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(enabled)
      .run();

    /* 关掉即全放行：开关只决定新评论的初始状态，不为存量负责。
       若不同步放行，之前攒的 pending 会永远卡在待审页——开关关了，后台也不再显示它们
       是「待审」的理由。只动 pending，驳回的是管理员的明确结论，不能被顺手撤销。
       只在 1→0 翻转时做：重复点关闭不该产生额外写入，也不该在关闭状态下
       放行后来手工留下的 pending。 */
    let released = 0;
    if (was && enabled === '0') {
      const out = await db.prepare("UPDATE comments SET status = 'approved' WHERE status = 'pending'").run();
      released = out.meta?.changes || 0;
      // 放行后前台评论数与该显出来的正文都变了，边缘缓存跟着清
      if (released && ctx) ctx.waitUntil(bust(url, [], [], db).catch(() => {}));
    }

    await logAudit(env, user, 'comment.moderation', 'settings', 'comment_moderation',
      enabled === '1'
        ? '开启评论先审后发'
        : `关闭评论先审后发${was ? `，放行 ${released} 条待审评论` : ''}`);
    return json({ ok: true, enabled: enabled === '1', released });
  }

  if (/^\/comments\/\d+\/moderate$/.test(path) && method === 'POST') {
    const { user, res } = await requireAdmin(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');
    if (action !== 'approve' && action !== 'reject') return err('action 只能是 approve 或 reject');
    const c = await db.prepare('SELECT id, post_id, status FROM comments WHERE id = ?').bind(id).first();
    if (!c) return err('评论不存在', 404);
    const next = action === 'approve' ? 'approved' : 'rejected';
    await db.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(next, id).run();
    await logAudit(env, user, action === 'approve' ? 'comment.approve' : 'comment.reject',
      'comment', String(id), `post=#${c.post_id}`);
    if (ctx) ctx.waitUntil(bust(url, [], [], db).catch(() => {}));
    return json({ ok: true, id, status: next });
  }

  /* ---- 批量删评论（管理员）：垃圾评论一般是一串，一条条点太慢 ---- */
  if (path === '/comments/bulk' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;
    const body = await request.json().catch(() => ({}));
    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 200);
    if (!ids.length) return err('没选中要删的评论');

    const ph = ids.map(() => '?').join(',');
    const stmts = [
      db.prepare(`DELETE FROM comments WHERE parent_id IN (${ph})`).bind(...ids),
      db.prepare(`DELETE FROM comments WHERE id IN (${ph})`).bind(...ids),
    ];
    const out = await db.batch(stmts);
    return json({ ok: true, deleted: out[0].meta.changes + out[1].meta.changes });
  }

  /* ---- 封 IP：把这条评论的来源清空并拉黑，之后它发不出来 ---- */
  if (path === '/comments/ban' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;
    const body = await request.json().catch(() => ({}));
    const cid = parseInt(body.id, 10);
    if (!Number.isInteger(cid)) return err('缺少评论 id');

    const c = await db.prepare('SELECT id, ip FROM comments WHERE id = ?').bind(cid).first();
    if (!c) return err('评论不存在', 404);
    if (!c.ip) return err('这条评论没有记录来源 IP，只能单独删除');

    // 只清访客评论，管理员自己的一条都不动
    const { results } = await db
      .prepare('SELECT id FROM comments WHERE ip = ? AND is_admin = 0')
      .bind(c.ip)
      .all();
    const ids = results.map((r) => r.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      await db.batch([
        db.prepare(`DELETE FROM comments WHERE parent_id IN (${ph})`).bind(...ids),
        db.prepare(`DELETE FROM comments WHERE id IN (${ph})`).bind(...ids),
      ]);
    }
    await banIp(db, c.ip);
    return json({ ok: true, removed: ids.length });
  }

  /* ---- 删评论 ---- */
  if (/^\/comments\/\d+$/.test(path) && method === 'DELETE') {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    await db.batch([
      db.prepare('DELETE FROM comments WHERE parent_id = ?').bind(id),
      db.prepare('DELETE FROM comments WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  /* ---- 友链 ---- */
  if (path === '/friends' && method === 'GET') {
    return json({ ok: true, friends: await friendsData(db) });
  }

  if (path === '/friends' && method === 'POST') {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;
    const body = await request.json();
    const name = String(body.name || '').trim();
    const furl = String(body.url || '').trim();
    if (!name || !furl) return err('名称和链接必填');

    const info = await db
      .prepare('INSERT INTO friends (name, url, avatar, desc, status, checked_at) VALUES (?,?,?,?,0,?)')
      .bind(name.slice(0, 60), furl.slice(0, 300), String(body.avatar || ''), String(body.desc || ''), nowISO())
      .run();

    checkFriends(env).catch(() => {});
    await logAudit(env, u, 'friend.create', 'friend', String(info.meta.last_row_id), name);
    bustFriends(url, ctx);
    return json({ ok: true, id: info.meta.last_row_id });
  }

  /* 就地改。换 URL 时状态必须归零重测 —— 否则绿点会挂在一个从没探测过的新地址上，
     点进去是 404，而面板说「可访问」。只改名字/描述/头像则保留原检测结果。 */
  if (/^\/friends\/\d+$/.test(path) && (method === 'PATCH' || method === 'PUT')) {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;

    const id = parseInt(path.split('/')[2], 10);
    const body = await request.json();
    const name = String(body.name || '').trim();
    const furl = String(body.url || '').trim();
    if (!name || !furl) return err('名称和链接必填');

    const row = await db.prepare('SELECT url FROM friends WHERE id = ?').bind(id).first();
    if (!row) return err('友链不存在', 404);

    const moved = String(row.url) !== furl;
    const fields = [name.slice(0, 60), furl.slice(0, 300), String(body.avatar || ''), String(body.desc || '')];
    if (moved) {
      await db
        .prepare(
          'UPDATE friends SET name=?, url=?, avatar=?, desc=?, status=0, http_status=0, latency_ms=NULL, checked_at=? WHERE id=?'
        )
        .bind(...fields, nowISO(), id)
        .run();
      checkFriends(env).catch(() => {});
    } else {
      await db.prepare('UPDATE friends SET name=?, url=?, avatar=?, desc=? WHERE id=?').bind(...fields, id).run();
    }

    await logAudit(env, u, 'friend.update', 'friend', String(id), moved ? `${name}（换了链接）` : name);
    bustFriends(url, ctx);
    return json({ ok: true, recheck: moved });
  }

  if (/^\/friends\/\d+$/.test(path) && method === 'DELETE') {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    await db.prepare('DELETE FROM friends WHERE id = ?').bind(id).run();
    await logAudit(env, u, 'friend.delete', 'friend', String(id), '');
    bustFriends(url, ctx);
    return json({ ok: true });
  }

  if (path === '/friends/check' && method === 'POST') {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;
    const r = await checkFriends(env);
    await logAudit(env, u, 'friend.check', 'friend', '', '手动探测');
    bustFriends(url, ctx);
    return json({ ok: true, ...r });
  }

  /* ---- 存量内容清理：零宽字符、行尾空格、重复空行、与标题重复的一级标题 ---- */
  if (path === '/maintenance/clean' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    const { results } = await db.prepare('SELECT id, slug, title, content FROM posts ORDER BY id ASC').all();
    const changed = [];
    for (const p of results) {
      const cleaned = cleanMarkdown(p.content || '', p.title);
      if (cleaned !== p.content) {
        await db.prepare('UPDATE posts SET content = ? WHERE id = ?').bind(cleaned, p.id).run();
        changed.push({ slug: p.slug, before: String(p.content || '').length, after: cleaned.length });
      }
    }
    if (changed.length && ctx) ctx.waitUntil(bust(url, results.map((p) => p.slug), [], db).catch(() => {}));
    return json({ ok: true, scanned: results.length, changed: changed.length, detail: changed.slice(0, 50) });
  }

  /* ---- 栏目 / 标签归一：老数据里的中文栏目、别名标签、空标签一次收拾干净 ---- */
  if (path === '/maintenance/taxonomy' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    // 1) 栏目收敛到四个 slug
    const { results: posts } = await db
      .prepare("SELECT id, slug, category FROM posts WHERE TRIM(COALESCE(category,'')) != ''")
      .all();
    const catChanges = [];
    for (const p of posts) {
      const slug = normalizeCat(p.category);
      if (slug !== p.category) {
        await db.prepare('UPDATE posts SET category = ? WHERE id = ?').bind(slug, p.id).run();
        catChanges.push({ post: p.slug, from: p.category, to: slug });
      }
    }

    // 2) 标签按别名表合并（cf → cloudflare 之类）
    const { results: tags } = await db.prepare('SELECT id, name FROM tags ORDER BY id ASC').all();
    const idByName = new Map(tags.map((t) => [t.name, t.id]));
    const merged = [];
    for (const t of tags) {
      const to = normalizeTag(t.name);
      if (!to || to === t.name) continue;

      let targetId = idByName.get(to);
      if (!targetId) {
        await db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(to).run();
        targetId = (await db.prepare('SELECT id FROM tags WHERE name = ?').bind(to).first())?.id;
        if (targetId) idByName.set(to, targetId);
      }
      if (!targetId) continue;

      await db.batch([
        db
          .prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) SELECT post_id, ? FROM post_tags WHERE tag_id = ?')
          .bind(targetId, t.id),
        db.prepare('DELETE FROM post_tags WHERE tag_id = ?').bind(t.id),
        db.prepare('DELETE FROM tags WHERE id = ?').bind(t.id),
      ]);
      idByName.delete(t.name);
      merged.push({ from: t.name, to });
    }

    // 3) 没有文章的标签直接删：空标签页对爬虫是薄内容
    const emptied = await db
      .prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM post_tags)')
      .run();

    const { results: left } = await db.prepare('SELECT name FROM tags ORDER BY name').all();
    if (ctx) ctx.waitUntil(bust(url, posts.map((p) => p.slug), posts.map((p) => p.category), db).catch(() => {}));
    return json({
      ok: true,
      categories: catChanges,
      merged,
      removed_empty: emptied.meta.changes || 0,
      offlist: left.map((r) => r.name).filter((n) => !isSeedTag(n)),
    });
  }


  /* ---- 图片上传 ---- */
  if (path === '/upload-url' && method === 'POST') {
    const { res } = await requireUser(env, request);
    if (res) return res;

    const body = await request.json();
    const type = String(body.type || 'image/png').toLowerCase();
    if (!IMAGE_TYPES[type]) return err('只支持 jpg/png/gif/webp/svg/avif');

    const key = makeKey(body.name, type);
    const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '') : '';
    const publicUrl = base ? `${base}/${key}` : `/img/${key}`;

    try {
      /* type 要签进 URL：直传时 Content-Type 由浏览器设，不签的话客户端可以
         把 svg 存成 text/html，/img/ 就会把它当页面发出去。 */
      const uploadUrl = await presignPut(env, key, type);
      return json({ ok: true, mode: 'direct', key, uploadUrl, publicUrl, type });
    } catch {
      // 没配 S3 凭据 -> 走 Worker 中转
      return json({ ok: true, mode: 'proxy', key, publicUrl, type });
    }
  }

  if (path === '/upload' && method === 'POST') {
    const { res } = await requireUser(env, request);
    if (res) return res;

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return err('没有文件');

    const declared = String(file.type || 'image/png').toLowerCase();
    if (!IMAGE_TYPES[declared]) return err('只支持图片');

    const buf = await file.arrayBuffer();
    /* 上传时就量好宽高，写进返回的 URL —— 正文渲染时直接读，不用再回源查一次。
       量不出来（格式不认识）就不加，页面那边退化成不写属性，不影响上传成功。 */
    const { type, size } = settleType(declared, buf);
    const key = makeKey(file.name, type);
    await env.BUCKET.put(key, buf, {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
    });

    const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '') : '';
    const url = base ? `${base}/${key}` : `/img/${key}`;
    return json({ ok: true, key, publicUrl: withSize(url, size), w: size?.w || 0, h: size?.h || 0 });
  }

  return err('未知接口', 404);
}
